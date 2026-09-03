"""
Connecteam Hourly Staff Sync
============================
Pulls time-clock activity (and, best-effort, scheduled shifts) from the
Connecteam API and writes data/connecteam_hours.json for the Staff Hours
dashboard (staff_hours.html).

Usage:
    python scripts/connecteam_sync.py

Output:
    data/connecteam_hours.json

Requirements:
    pip install requests

NOTE ON FIELD MAPPING: the endpoint paths and field names below follow
Connecteam's published Developer API docs but have NOT been verified against
a live account yet — this is the same situation kss_sync.py was in for its
inventory/batches endpoint (see sync_time_activities / sync_schedule_today
below for the fail-soft handling). The _first() helper tries a few
plausible field-name spellings so a close-but-not-exact real response still
mostly works; expect to tighten these once we see actual output from a
workflow_dispatch run against a real CONNECTEAM_API_KEY.
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
    while True:
        params["offset"] = offset
        body = api_get(path, params)
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


def _first(d, *keys, default=None):
    for k in keys:
        if isinstance(d, dict) and d.get(k) is not None:
            return d[k]
    return default


def _to_dt(value):
    """Best-effort parse of a Connecteam timestamp — unix seconds/ms or an
    ISO string, depending on which shape the real API turns out to send."""
    if value is None:
        return None
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
    print("\n[1/4] Users")
    users = api_get_all("/users/v1/users", list_path=("data", "users"))
    by_id = {}
    for u in users:
        uid = _first(u, "userId", "id")
        if uid is None:
            continue
        name = _first(u, "fullName") or f"{_first(u, 'firstName', default='')} {_first(u, 'lastName', default='')}".strip()
        by_id[str(uid)] = {"name": name or f"User {uid}"}
    print(f"  → {len(by_id)} user(s)")
    return by_id


def discover_clocks():
    print("\n[2/4] Time Clocks")
    body = api_get("/time-clock/v1/time-clocks")
    clocks = _first(body.get("data", {}) if isinstance(body, dict) else {}, "timeClocks")
    if clocks is None:
        clocks = body.get("data") if isinstance(body, dict) else None
    if not isinstance(clocks, list):
        clocks = []
    clock_ids = [_first(c, "id", "clockId") for c in clocks]
    clock_ids = [c for c in clock_ids if c is not None]
    print(f"  → {len(clock_ids)} clock(s): {clock_ids}")
    return clock_ids


def sync_time_activities(clock_ids, start_date, end_date):
    print("\n[3/4] Time Activities")
    all_shifts = []
    for clock_id in clock_ids:
        shifts = api_get_all(
            f"/time-clock/v1/time-clocks/{clock_id}/time-activities",
            params={"startDate": start_date, "endDate": end_date},
            list_path=("data", "timeActivities"),
        )
        all_shifts.extend(shifts)
    print(f"  → {len(all_shifts)} shift record(s) total")
    return all_shifts


def sync_schedule_today(clock_ids, today_str):
    # Best-effort — the Scheduler module/API may not be enabled on this
    # account. Fail soft into None (dashboard hides the section) rather than
    # failing the whole sync, same pattern as kss_sync's inventory batches.
    print("\n[4/4] Schedule (best-effort)")
    try:
        shifts = []
        for clock_id in clock_ids:
            shifts.extend(api_get_all(
                "/scheduler/v1/shifts",
                params={"startDate": today_str, "endDate": today_str},
                list_path=("data", "shifts"),
            ))
        print(f"  → {len(shifts)} scheduled shift(s)")
        return shifts
    except RuntimeError as e:
        print(f"  [WARN] Scheduler fetch failed, continuing without it: {e}")
        return None


# ── TRANSFORM ──────────────────────────────────────────────────────────────

def build_hours_json(users, shifts, schedule_shifts):
    now = datetime.now(timezone.utc)
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    week_start = today_start - timedelta(days=today_start.weekday())

    clocked_in = []
    today_totals = {}
    week_totals = {}

    for s in shifts:
        uid = str(_first(s, "userId", "employeeId"))
        name = users.get(uid, {}).get("name", f"User {uid}")
        job = _first(s, "jobName", "activityName", "shiftName", default="")
        start = _to_dt(_first(s, "shiftStartTime", "startTime", "clockIn"))
        end = _to_dt(_first(s, "shiftEndTime", "endTime", "clockOut"))
        if start is None:
            continue

        hours = max(0.0, ((end or now) - start).total_seconds() / 3600)

        if end is None:
            clocked_in.append({
                "userId": uid, "name": name, "job": job,
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

    schedule_today = None
    if schedule_shifts is not None:
        actual_start_by_user = {}
        for s in shifts:
            uid = str(_first(s, "userId", "employeeId"))
            start = _to_dt(_first(s, "shiftStartTime", "startTime", "clockIn"))
            if start and start >= today_start:
                actual_start_by_user.setdefault(uid, start)

        schedule_today = []
        for sched in schedule_shifts:
            uid = str(_first(sched, "userId", "employeeId"))
            name = users.get(uid, {}).get("name", f"User {uid}")
            sched_start = _to_dt(_first(sched, "startTime", "shiftStartTime"))
            sched_end = _to_dt(_first(sched, "endTime", "shiftEndTime"))
            actual_start = actual_start_by_user.get(uid)

            if actual_start is None:
                status = "no_show" if sched_end and sched_end < now else "upcoming"
            elif sched_start and actual_start > sched_start + timedelta(minutes=10):
                status = "late"
            else:
                status = "on_time"

            schedule_today.append({
                "userId": uid, "name": name,
                "scheduledStart": sched_start.isoformat() if sched_start else None,
                "scheduledEnd": sched_end.isoformat() if sched_end else None,
                "actualStart": actual_start.isoformat() if actual_start else None,
                "status": status,
            })

    return {
        "last_sync": now.isoformat(),
        "clocked_in": sorted(clocked_in, key=lambda c: c["clockIn"]),
        "today": today_list,
        "week": week_list,
        "schedule_today": schedule_today,
    }


# ── MAIN ──────────────────────────────────────────────────────────────────────

def main():
    started = datetime.now(timezone.utc)
    today_str = started.strftime("%Y-%m-%d")
    week_start_str = (started - timedelta(days=started.weekday())).strftime("%Y-%m-%d")

    print("=" * 55)
    print("  Connecteam Staff Hours Sync — 2CW Enterprises")
    print(f"  Started : {started.strftime('%Y-%m-%d %H:%M:%S')} UTC")
    print("=" * 55)

    try:
        users = sync_users()
        clock_ids = discover_clocks()
        if not clock_ids:
            raise RuntimeError("No time clocks found on this Connecteam account")
        shifts = sync_time_activities(clock_ids, week_start_str, today_str)
        schedule_shifts = sync_schedule_today(clock_ids, today_str)
    except RuntimeError as e:
        print(f"\n\nFATAL ERROR: {e}")
        return 1

    result = build_hours_json(users, shifts, schedule_shifts)
    save("connecteam_hours.json", result)

    elapsed = (datetime.now(timezone.utc) - started).total_seconds()
    print("\n" + "=" * 55)
    print("  Sync Complete")
    print(f"  Elapsed      : {elapsed:.1f}s")
    print(f"  Clocked in   : {len(result['clocked_in'])}")
    print(f"  Today rows   : {len(result['today'])}")
    print(f"  Week rows    : {len(result['week'])}")
    print(f"  Schedule     : {'n/a' if result['schedule_today'] is None else len(result['schedule_today'])}")
    print("=" * 55)
    return 0


if __name__ == "__main__":
    exit(main())
