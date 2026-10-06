"""
Connecteam Hourly Staff Sync
============================
Pulls time-clock activity from the Connecteam API and writes
data/connecteam_hours.json for the Staff Hours dashboard (staff_hours.html).

Usage:
    python scripts/connecteam_sync.py

Output:
    data/connecteam_hours.json
    data/connecteam_roster.json  (active employees — the Labor Log's people list)
    data/connecteam_shifts.json  (each clock-in/out, last SHIFT_DAYS days — the Labor Log's timeline)

Requirements:
    pip install requests
"""

import json
import os
import time
import requests
from datetime import datetime, timedelta, timezone
from pathlib import Path

# ── CONFIG ───────────────────────────────────────────────────────────────────

# API key is read from environment variable — never hardcoded
# Locally: set CONNECTEAM_API_KEY in your shell before running
# GitHub Actions: stored as a repository secret
API_KEY = os.environ.get("CONNECTEAM_API_KEY", "")
if not API_KEY:
    raise RuntimeError(
        "CONNECTEAM_API_KEY environment variable not set.\n"
        "Locally: set CONNECTEAM_API_KEY=your-key-here in your shell.\n"
        "GitHub Actions: add CONNECTEAM_API_KEY as a repository secret."
    )

BASE_URL = os.environ.get("CONNECTEAM_BASE_URL", "https://api.connecteam.com")
OUTPUT_DIR = Path("data")

# California overtime rules — statutory, not a scored/guessed business curve.
DAILY_OT_HOURS = 8
DAILY_DOUBLETIME_HOURS = 12
WEEKLY_OT_HOURS = 40

# How far back connecteam_shifts.json goes (the Labor Log timeline's range).
SHIFT_DAYS = 14

REQUEST_PACE_SECONDS = 0.3
SERVER_ERROR_RETRY_BACKOFF_SECONDS = [10, 30, 60]

SESSION = requests.Session()
SESSION.headers.update({"X-API-KEY": API_KEY, "Accept": "application/json"})


# ── HTTP HELPERS ─────────────────────────────────────────────────────────────

def api_get(path, params=None):
    """GET with retry on 429/5xx — same backoff shape as kss_sync.fetch_page."""
    url = f"{BASE_URL}{path}"
    server_error_attempts = 0
    rate_limit_attempts = 0

    while True:
        try:
            resp = SESSION.get(url, params=params or {}, timeout=30)
        except requests.exceptions.RequestException as e:
            if server_error_attempts < len(SERVER_ERROR_RETRY_BACKOFF_SECONDS):
                wait = SERVER_ERROR_RETRY_BACKOFF_SECONDS[server_error_attempts]
                server_error_attempts += 1
                print(f"    Connection error ({e}) — retrying in {wait}s...")
                time.sleep(wait)
                continue
            raise RuntimeError(f"Connection error on {path}: {e}")

        if resp.status_code == 429:
            rate_limit_attempts += 1
            if rate_limit_attempts > 5:
                raise RuntimeError(f"Rate limited on {path} after 5 retries, giving up")
            print(f"    Rate limited — waiting 30s... (attempt {rate_limit_attempts})")
            time.sleep(30)
            continue

        if resp.status_code >= 500:
            if server_error_attempts < len(SERVER_ERROR_RETRY_BACKOFF_SECONDS):
                wait = SERVER_ERROR_RETRY_BACKOFF_SECONDS[server_error_attempts]
                server_error_attempts += 1
                print(f"    Server error {resp.status_code} on {path} — retrying in {wait}s...")
                time.sleep(wait)
                continue
            raise RuntimeError(f"API error {resp.status_code} on {path}: {resp.text[:200]}")

        if resp.status_code != 200:
            raise RuntimeError(f"API error {resp.status_code} on {path}: {resp.text[:200]}")

        return resp.json()


def api_get_all(path, params=None, list_path=("data",), page_size=200):
    """Paginate via offset/limit, per Connecteam's documented paging envelope.
    `list_path` is the key path into the response body where the record list
    lives (varies per endpoint) — adjust if a real response nests it
    differently than expected."""
    params = dict(params or {})
    params["limit"] = page_size
    offset = 0
    out = []
    first_page = True
    while True:
        params["offset"] = offset
        body = api_get(path, params)
        if first_page:
            print(f"    [shape] {path} → {_shape(body)}")
            first_page = False
        records = body
        for key in list_path:
            records = records.get(key, []) if isinstance(records, dict) else []
        if not isinstance(records, list):
            records = []
        out.extend(records)
        got = len(records)
        print(f"    {path} offset={offset}: {got} record(s) (running total: {len(out)})")
        if got < page_size:
            break
        offset += page_size
        time.sleep(REQUEST_PACE_SECONDS)
    return out


def _shape(obj, depth=3):
    """Structure-only preview (keys and types, never values) of an unfamiliar
    API response — lets us see the real envelope shape in CI logs without
    printing employee names/PII. E.g. {'data': {'users': 'list[12] of dict
    keys=[userId,firstName,...]'}}."""
    if depth <= 0:
        return type(obj).__name__
    if isinstance(obj, dict):
        return {k: _shape(v, depth - 1) for k, v in obj.items()}
    if isinstance(obj, list):
        if not obj:
            return "list[0]"
        if isinstance(obj[0], dict):
            return f"list[{len(obj)}] of dict keys={sorted(obj[0].keys())}"
        return f"list[{len(obj)}] of {type(obj[0]).__name__}"
    return type(obj).__name__


def _first(d, *keys, default=None):
    for k in keys:
        if isinstance(d, dict) and d.get(k) is not None:
            return d[k]
    return default


def _to_dt(value):
    """Best-effort parse of a Connecteam timestamp — unix seconds/ms, an ISO
    string, or a {"timestamp": ...} wrapper object (confirmed pattern for
    some Connecteam fields), depending on which shape the real API sends."""
    if value is None:
        return None
    if isinstance(value, dict):
        return _to_dt(_first(value, "timestamp", "value"))
    if isinstance(value, (int, float)):
        ts = value / 1000 if value > 10_000_000_000 else value
        return datetime.fromtimestamp(ts, tz=timezone.utc)
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
    return None


def save(filename, data):
    OUTPUT_DIR.mkdir(exist_ok=True)
    path = OUTPUT_DIR / filename
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, default=str)
    print(f"  → Saved to {path}")


# ── SYNC FUNCTIONS ────────────────────────────────────────────────────────────

def sync_users():
    print("\n[1/3] Users")
    users = api_get_all("/users/v1/users", list_path=("data", "users"))
    by_id = {}
    for u in users:
        uid = _first(u, "userId", "id")
        if uid is None:
            continue
        name = _first(u, "fullName") or f"{_first(u, 'firstName', default='')} {_first(u, 'lastName', default='')}".strip()
        # Archived users can still show up in time activities from earlier in
        # the week, so they stay in by_id for name lookups — the roster file
        # just leaves them out.
        archived = bool(_first(u, "isArchived", "archived", default=False))
        by_id[str(uid)] = {"name": name or f"User {uid}", "archived": archived}
    print(f"  → {len(by_id)} user(s), {sum(1 for v in by_id.values() if not v['archived'])} active")
    return by_id


def build_roster_json(users):
    """Active employees, for the Labor Log's people picker (labor_log.html).
    Name + Connecteam user id only — nothing the hours file doesn't already
    publish."""
    people = [{"userId": uid, "name": v["name"]} for uid, v in users.items() if not v["archived"]]
    people.sort(key=lambda p: p["name"].lower())
    return {"last_sync": datetime.now(timezone.utc).isoformat(), "people": people}


def discover_clocks():
    print("\n[2/3] Time Clocks")
    body = api_get("/time-clock/v1/time-clocks")
    print(f"    [shape] /time-clock/v1/time-clocks → {_shape(body)}")
    clocks = _first(body.get("data", {}) if isinstance(body, dict) else {}, "timeClocks")
    if clocks is None:
        clocks = body.get("data") if isinstance(body, dict) else None
    if not isinstance(clocks, list):
        clocks = []
    clock_ids = [_first(c, "id", "clockId") for c in clocks]
    clock_ids = [c for c in clock_ids if c is not None]
    for c in clocks:
        cid = _first(c, "id", "clockId")
        if cid is not None:
            CLOCK_NAMES[str(cid)] = _first(c, "name", default="") or ""
    print(f"  → {len(clock_ids)} clock(s): {[(c, CLOCK_NAMES.get(str(c), '')) for c in clock_ids]}")
    return clock_ids


# Clock id → name, filled by discover_clocks; job id → name, by sync_jobs.
CLOCK_NAMES = {}


def sync_jobs():
    """Connecteam jobs (what a shift's jobId points at — often a site or
    task). Names only; a failure here never stops the sync, shifts just go
    out without job names."""
    print("\n[2b] Jobs")
    try:
        jobs = api_get_all("/jobs/v1/jobs", list_path=("data", "jobs"))
    except RuntimeError as e:
        print(f"    [WARN] couldn't read jobs: {e}")
        return {}
    names = {}
    for j in jobs:
        jid = _first(j, "jobId", "id")
        if jid is None:
            continue
        names[str(jid)] = _first(j, "title", "name", default="") or ""
    print(f"  → {len(names)} job(s): {sorted(set(n for n in names.values() if n))[:60]}")
    return names


def sync_time_activities(clock_ids, start_date, end_date):
    # The real endpoint (confirmed via [shape] logging against a live
    # account) returns data.timeActivitiesByUsers — a list of PER-USER
    # objects, each holding that user's shifts/manualBreaks/timeOffs for the
    # period, rather than a flat list of shift records. So we pull each
    # user's `shifts` array and inject their userId onto every shift, which
    # keeps everything downstream (build_hours_json) working unchanged.
    print("\n[3/3] Time Activities")
    all_shifts = []
    shift_shape_logged = False
    for clock_id in clock_ids:
        per_user = api_get_all(
            f"/time-clock/v1/time-clocks/{clock_id}/time-activities",
            params={"startDate": start_date, "endDate": end_date},
            list_path=("data", "timeActivitiesByUsers"),
        )
        for u in per_user:
            uid = _first(u, "userId")
            shifts = u.get("shifts") or []
            if shifts and not shift_shape_logged:
                print(f"    [shape] shift record → {_shape(shifts[0], depth=3)}")
                shift_shape_logged = True
            for s in shifts:
                s = dict(s)
                s["userId"] = uid
                s["clockId"] = clock_id
                all_shifts.append(s)
    print(f"  → {len(all_shifts)} shift record(s) total")
    return all_shifts


# ── TRANSFORM ──────────────────────────────────────────────────────────────

def build_hours_json(users, shifts):
    now = datetime.now(timezone.utc)
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    week_start = today_start - timedelta(days=today_start.weekday())

    clocked_in = []
    today_totals = {}
    week_totals = {}
    unparseable = 0

    for s in shifts:
        uid = str(_first(s, "userId", "employeeId"))
        name = users.get(uid, {}).get("name", f"User {uid}")
        start = _to_dt(_first(s, "start", "shiftStartTime", "startTime", "clockIn"))
        end = _to_dt(_first(s, "end", "shiftEndTime", "endTime", "clockOut"))
        if start is None:
            unparseable += 1
            continue

        hours = max(0.0, ((end or now) - start).total_seconds() / 3600)

        if end is None:
            clocked_in.append({
                "userId": uid, "name": name,
                "clockIn": start.isoformat(),
                "elapsedHours": round(hours, 2),
            })

        if start >= today_start:
            bucket = today_totals.setdefault(uid, {"name": name, "hours": 0.0, "shifts": 0})
            bucket["hours"] += hours
            bucket["shifts"] += 1

        if start >= week_start:
            bucket = week_totals.setdefault(uid, {"name": name, "hours": 0.0})
            bucket["hours"] += hours

    if unparseable:
        print(f"  [WARN] {unparseable} shift record(s) had no parseable start time — "
              f"field-name guess in build_hours_json is likely still wrong")

    today_list = [
        {"userId": uid, "name": v["name"], "hoursToday": round(v["hours"], 2), "shiftsToday": v["shifts"]}
        for uid, v in sorted(today_totals.items(), key=lambda kv: -kv[1]["hours"])
    ]
    week_list = [
        {
            "userId": uid, "name": v["name"], "hoursWeek": round(v["hours"], 2),
            "overtime": v["hours"] > WEEKLY_OT_HOURS,
        }
        for uid, v in sorted(week_totals.items(), key=lambda kv: -kv[1]["hours"])
    ]

    return {
        "last_sync": now.isoformat(),
        "clocked_in": sorted(clocked_in, key=lambda c: c["clockIn"]),
        "today": today_list,
        "week": week_list,
    }


def build_shifts_json(users, shifts, since, jobs=None):
    """Every shift that started on or after `since`, as clock-in/clock-out
    times — what the Labor Log's timeline (labor_log.html) draws each
    person's day from. `end` is null while someone is still clocked in.
    Only names and times, the same kind of data connecteam_hours.json
    already publishes."""
    out = []
    jobs = jobs or {}
    with_gps = 0
    for s in shifts:
        start = _to_dt(_first(s, "start", "shiftStartTime", "startTime", "clockIn"))
        if start is None or start < since:
            continue
        # Where: the job they punched into and the time clock it was on.
        # The clock-in GPS address (start.locationData) is NOT written out —
        # this file is public, and an address can be someone's home.
        if isinstance(s.get("start"), dict) and s["start"].get("locationData"):
            with_gps += 1
        job_id = _first(s, "jobId")
        end = _to_dt(_first(s, "end", "shiftEndTime", "endTime", "clockOut"))
        uid = str(_first(s, "userId", "employeeId"))
        out.append({
            "userId": uid, "name": users.get(uid, {}).get("name", f"User {uid}"),
            "start": start.isoformat(), "end": end.isoformat() if end else None,
            "job": jobs.get(str(job_id), "") if job_id else "",
            "clock": CLOCK_NAMES.get(str(s.get("clockId")), ""),
        })
    print(f"  [shifts] {len(out)} in range · {sum(1 for x in out if x['job'])} with a job name · "
          f"{with_gps} with clock-in GPS (not published) · clocks: {sorted(set(x['clock'] for x in out))}")
    out.sort(key=lambda x: (x["start"], x["name"]))
    return {"last_sync": datetime.now(timezone.utc).isoformat(), "days": SHIFT_DAYS, "shifts": out}


# ── MAIN ──────────────────────────────────────────────────────────────────────

def main():
    started = datetime.now(timezone.utc)
    today_str = started.strftime("%Y-%m-%d")
    week_start_str = (started - timedelta(days=started.weekday())).strftime("%Y-%m-%d")
    # Fetch back far enough for both the week totals and the shifts file.
    shifts_since = (started - timedelta(days=SHIFT_DAYS - 1)).replace(hour=0, minute=0, second=0, microsecond=0)
    fetch_from_str = min(week_start_str, shifts_since.strftime("%Y-%m-%d"))

    print("=" * 55)
    print("  Connecteam Staff Hours Sync — 2CW Enterprises")
    print(f"  Started : {started.strftime('%Y-%m-%d %H:%M:%S')} UTC")
    print("=" * 55)

    try:
        users = sync_users()
        clock_ids = discover_clocks()
        if not clock_ids:
            raise RuntimeError("No time clocks found on this Connecteam account")
        jobs = sync_jobs()
        shifts = sync_time_activities(clock_ids, fetch_from_str, today_str)
    except RuntimeError as e:
        print(f"\n\nFATAL ERROR: {e}")
        return 1

    result = build_hours_json(users, shifts)
    save("connecteam_hours.json", result)
    roster = build_roster_json(users)
    save("connecteam_roster.json", roster)
    shift_file = build_shifts_json(users, shifts, shifts_since, jobs)
    save("connecteam_shifts.json", shift_file)

    elapsed = (datetime.now(timezone.utc) - started).total_seconds()
    print("\n" + "=" * 55)
    print("  Sync Complete")
    print(f"  Elapsed      : {elapsed:.1f}s")
    print(f"  Clocked in   : {len(result['clocked_in'])}")
    print(f"  Today rows   : {len(result['today'])}")
    print(f"  Week rows    : {len(result['week'])}")
    print(f"  Roster       : {len(roster['people'])}")
    print(f"  Shifts ({SHIFT_DAYS}d) : {len(shift_file['shifts'])}")
    print("=" * 55)
    return 0


if __name__ == "__main__":
    exit(main())
