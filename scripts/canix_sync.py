"""
Canix Data Sync Script
=======================
Pulls inventory (packages), plant batches, harvests, sales orders, and
transfers from the Canix API across all licenses/facilities we have API
access to, and writes normalized JSON to data/ for use by the 2CW dashboards.

Canix's data model is Company -> Facilities, where each Facility carries its
own state license_number. An API key is generated per Canix company account
(https://app.canix.com/company/api) and can see every Facility under that
company. Depending on how 2CW's licenses are set up in Canix, that might mean
one key covers everything, or each license is its own company with its own
key — this script supports both without needing to know which in advance:
set as many of the CANIX_API_KEY_* env vars below as you actually have, and
every record gets tagged with its real facility (name + license_number) via
the facility_id already present on each record, looked up against /facilities
for whichever key fetched it.

History / incremental sync
---------------------------
packages, plant_batches, harvests, and transfers all keep growing forever (a
package's status changes over its life instead of disappearing), so this
script keeps a running local history for each, keyed by record id:

  - First run (no data/canix_meta.json yet, or CANIX_FULL_BACKFILL=1 set):
    pulls the *entire* history of each resource, no filtering.
  - Every run after that: pulls only records with updated_at at or after the
    last run's high-water mark (via the API's `where` filter), and upserts
    them into the existing history file by id — so a run only pays for what
    actually changed, but nothing already-synced is ever lost.

data/canix_inventory.json (current on-hand stock) is derived each run from
the packages history by filtering is_active=true — no separate API call
needed for it.

Facility roster sync
---------------------
Every facility this run's API key(s) can see gets upserted into Supabase's
canix_facilities table (canix_name/license_number/status only — this script
never touches display_name/stage/farm_group/exclude, which are edited by
hand in admin.html and owned by netlify/functions/canix-facilities.js). Any
facility_id that used to show up but doesn't in this run gets status set to
'archived' rather than deleted, so a license Canix drops still labels
whatever historical packages/batches/transfers it produced instead of
showing up as "Unknown facility." Requires SUPABASE_URL and
SUPABASE_SERVICE_ROLE_KEY (service role, not the anon key — this needs
write access past canix_facilities' RLS); skipped with a warning if unset,
everything else in this script still runs.

Usage:
    python scripts/canix_sync.py

Output:
    data/canix_facilities.json
    data/canix_inventory.json           (current on-hand packages — derived)
    data/canix_packages_history.json    (every package, all statuses, ever)
    data/canix_plant_batches.json       (cumulative history)
    data/canix_harvests.json            (cumulative history)
    data/canix_transfers.json           (cumulative history)
    data/canix_sales_orders.json        (small — full refetch every run)
    data/canix_meta.json

Requirements:
    pip install requests
"""

import json
import os
import time
import requests
from datetime import datetime, timedelta
from pathlib import Path

# ── CONFIG ───────────────────────────────────────────────────────────────────

BASE_URL = os.environ.get("CANIX_BASE_URL", "https://api.canix.com/api/v1")

# One entry per Canix company/API key you have. Only entries whose env var is
# actually set get used — leave keys you don't have unset, no code changes
# needed. If your whole org sits under one Canix company, just set
# CANIX_API_KEY and leave the rest unset.
LICENSE_API_KEYS = [
    ("All Facilities",    os.environ.get("CANIX_API_KEY", "")),
    ("Howie Roll",        os.environ.get("CANIX_API_KEY_HOWIE_ROLL", "")),
    ("Soma Rosa Farms",   os.environ.get("CANIX_API_KEY_SRF", "")),
    ("Mendo",             os.environ.get("CANIX_API_KEY_MENDO", "")),
]
LICENSE_API_KEYS = [(label, key) for label, key in LICENSE_API_KEYS if key]

if not LICENSE_API_KEYS:
    raise RuntimeError(
        "No Canix API keys set.\n"
        "Locally: set CANIX_API_KEY (org-wide) or CANIX_API_KEY_HOWIE_ROLL / "
        "CANIX_API_KEY_SRF / CANIX_API_KEY_MENDO (per-license) in your shell.\n"
        "GitHub Actions: add the same names as repository secrets."
    )

PAGE_SIZE = 1000  # API max is 2000 per request
REQUEST_PACE_SECONDS = 0.5

OUTPUT_DIR = Path("data")
META_PATH = OUTPUT_DIR / "canix_meta.json"

# Same Supabase project as config/supabase_config.js, but the service role
# key — never the anon key — since writing past canix_facilities' RLS
# requires it. Set as a GitHub Actions secret / local env var, same pattern
# as CANIX_API_KEY above.
SUPABASE_URL = os.environ.get("SUPABASE_URL", "https://ugtxmyciyuelxxzqmrdx.supabase.co")
SUPABASE_SERVICE_ROLE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")

# Subtracted from the newest updated_at we actually saw this run before it
# becomes next run's cutoff — guards against clock skew / records that were
# mid-write when we queried. Upserting by id makes re-fetching the same
# record harmless, so this only costs a few extra rows per run, not
# correctness.
CUTOFF_SAFETY_BUFFER = timedelta(hours=1)

SERVER_ERROR_RETRY_BACKOFF_SECONDS = [10, 30, 60]

FORCE_FULL_BACKFILL = bool(os.environ.get("CANIX_FULL_BACKFILL"))

# ── HTTP HELPERS ─────────────────────────────────────────────────────────────


def make_session(api_key):
    s = requests.Session()
    s.headers.update({"X-API-KEY": api_key})
    return s


def fetch_page(session, endpoint, params):
    url = f"{BASE_URL}/{endpoint}"
    server_error_attempts = 0
    rate_limit_attempts = 0

    while True:
        try:
            resp = session.get(url, params=params, timeout=30)
        except requests.exceptions.RequestException as e:
            if server_error_attempts < len(SERVER_ERROR_RETRY_BACKOFF_SECONDS):
                wait = SERVER_ERROR_RETRY_BACKOFF_SECONDS[server_error_attempts]
                server_error_attempts += 1
                print(f"    Connection error ({e}) — retrying in {wait}s...")
                time.sleep(wait)
                continue
            raise RuntimeError(f"Connection error on {endpoint}: {e}")

        if resp.status_code == 429:
            rate_limit_attempts += 1
            print(f"    Rate limited — waiting 60 seconds... (attempt {rate_limit_attempts})")
            time.sleep(60)
            continue

        if resp.status_code >= 500:
            if server_error_attempts < len(SERVER_ERROR_RETRY_BACKOFF_SECONDS):
                wait = SERVER_ERROR_RETRY_BACKOFF_SECONDS[server_error_attempts]
                server_error_attempts += 1
                print(f"    Server error {resp.status_code} on {endpoint} — retrying in {wait}s...")
                time.sleep(wait)
                continue
            raise RuntimeError(f"API error {resp.status_code} on {endpoint}: {resp.text[:200]}")

        if resp.status_code != 200:
            raise RuntimeError(f"API error {resp.status_code} on {endpoint}: {resp.text[:200]}")

        return resp.json()


def fetch_all(session, endpoint, where=None):
    params = {"limit": PAGE_SIZE, "offset": 0}
    if where:
        params["where"] = where
    records = []

    while True:
        print(f"    offset {params['offset']}...", end=" ", flush=True)
        page = fetch_page(session, endpoint, params)
        records.extend(page)
        print(f"{len(page)} records (running total: {len(records)})")

        if len(page) < PAGE_SIZE:
            break

        params["offset"] += PAGE_SIZE
        time.sleep(REQUEST_PACE_SECONDS)

    return records


def save(filename, data):
    OUTPUT_DIR.mkdir(exist_ok=True)
    path = OUTPUT_DIR / filename
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, default=str)
    count = len(data) if isinstance(data, list) else "dict"
    print(f"  → Saved {count} records to {path}")


def load_history(filename):
    path = OUTPUT_DIR / filename
    if not path.exists():
        return {}
    with open(path, encoding="utf-8") as f:
        records = json.load(f)
    return {str(r["id"]): r for r in records}


# ── SUPABASE FACILITY ROSTER SYNC ───────────────────────────────────────────


def sync_facility_roster_to_supabase(facilities):
    if not SUPABASE_SERVICE_ROLE_KEY:
        print("\n  [skip] SUPABASE_SERVICE_ROLE_KEY not set — not syncing facility roster to Supabase")
        return

    headers = {
        "apikey": SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
        "Content-Type": "application/json",
    }
    base = f"{SUPABASE_URL}/rest/v1/canix_facilities"

    seen_ids = {f["id"] for f in facilities}

    # Upsert only the fields this script owns (canix_name/license_number/
    # status) — "resolution=merge-duplicates" means an existing row's
    # display_name/stage/farm_group/exclude (owned by the admin panel) are
    # left exactly as they are, since those keys aren't in this payload.
    rows = [
        {"facility_id": f["id"], "canix_name": f.get("name"), "license_number": f.get("license_number"), "status": "active"}
        for f in facilities
    ]
    if rows:
        resp = requests.post(
            f"{base}?on_conflict=facility_id",
            headers={**headers, "Prefer": "resolution=merge-duplicates,return=minimal"},
            json=rows,
            timeout=30,
        )
        if resp.status_code >= 300:
            print(f"  [warn] Supabase facility upsert failed: {resp.status_code} {resp.text[:300]}")
        else:
            print(f"  Upserted {len(rows)} facilities to Supabase (canix_name/license_number/status only)")

    # Archive any facility_id Supabase already knows about that this run's
    # key(s) no longer see — a license Canix dropped, not deleted, so its
    # historical packages/batches/transfers keep a real facility label
    # instead of turning into "Unknown facility."
    resp = requests.get(f"{base}?select=facility_id,status", headers=headers, timeout=30)
    if not resp.ok:
        print(f"  [warn] Could not check for facilities to archive: {resp.status_code} {resp.text[:300]}")
        return
    existing = resp.json()
    to_archive = [row["facility_id"] for row in existing if row["facility_id"] not in seen_ids and row["status"] != "archived"]
    for fid in to_archive:
        patch_resp = requests.patch(
            f"{base}?facility_id=eq.{fid}",
            headers={**headers, "Prefer": "return=minimal"},
            json={"status": "archived"},
            timeout=30,
        )
        if patch_resp.status_code >= 300:
            print(f"  [warn] Could not archive facility {fid}: {patch_resp.status_code} {patch_resp.text[:200]}")
        else:
            print(f"  [archived] facility {fid} — no longer reported by Canix, historical data retained")


# ── SYNC ─────────────────────────────────────────────────────────────────────

# (output key, Canix endpoint, history filename, supports updated_at filter)
RESOURCES = [
    ("packages", "packages", "canix_packages_history.json", True),
    ("plant_batches", "plant_batches", "canix_plant_batches.json", True),
    ("harvests", "harvests", "canix_harvests.json", True),
    ("transfers", "transfers", "canix_transfers.json", True),
    ("sales_orders", "sales_orders", "canix_sales_orders.json", False),
]


def load_meta():
    if not META_PATH.exists():
        return {}
    with open(META_PATH, encoding="utf-8") as f:
        return json.load(f)


def newest_updated_at(records, current_best):
    best = current_best
    for r in records:
        ts = r.get("updated_at")
        if ts and (best is None or ts > best):
            best = ts
    return best


def compute_next_cutoff(newest_seen):
    if not newest_seen:
        return None
    try:
        dt = datetime.strptime(newest_seen, "%Y-%m-%dT%H:%M:%S.%fZ")
    except ValueError:
        return None
    return (dt - CUTOFF_SAFETY_BUFFER).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def sync_for_license(label, api_key, cutoff, histories):
    print(f"\n── {label} ──")
    session = make_session(api_key)

    facilities = fetch_all(session, "facilities")
    facility_by_id = {f["id"]: f for f in facilities}
    facility_summary = ", ".join(
        f"{f.get('name')} ({f.get('license_number')})" for f in facilities
    ) or "none"
    print(f"  Facilities visible to this key: {facility_summary}")

    newest_by_key = {}
    for key, endpoint, _, supports_cutoff in RESOURCES:
        where = f"updated_at >= '{cutoff}'" if (supports_cutoff and cutoff) else None
        print(f"  {endpoint}" + (f"  (where {where})" if where else "  (full pull)"))
        records = fetch_all(session, endpoint, where=where)
        for r in records:
            facility_id = r.get("facility_id")
            facility = facility_by_id.get(facility_id) if facility_id else None
            r["_license_key_label"] = label
            r["_facility_name"] = facility["name"] if facility else None
            r["_facility_license_number"] = facility["license_number"] if facility else None
            histories[key][str(r["id"])] = r
        newest_by_key[key] = newest_updated_at(records, None)

    return facilities, newest_by_key


def main():
    started = datetime.now()
    meta = load_meta()
    previous_cutoff = meta.get("last_incremental_cutoff")

    histories = {key: load_history(hist_file) for key, _, hist_file, _ in RESOURCES}
    for key in histories:
        if histories[key]:
            print(f"  Loaded {len(histories[key])} existing {key} records from history")

    # canix_meta.json (the cutoff) is small and always committed to git, but
    # the history files themselves are not (see .gitignore) — in CI they
    # only survive via actions/cache, which can be evicted. Trusting a
    # cutoff against empty/missing history would silently produce an
    # incomplete "current inventory" (only recently-changed records, not
    # everything) instead of an obviously-slower full re-backfill, so treat
    # missing history on any cutoff-filtered resource as reason to backfill
    # regardless of what the cutoff says.
    history_missing = any(not histories[key] for key, _, _, supports_cutoff in RESOURCES if supports_cutoff)
    is_backfill = not previous_cutoff or FORCE_FULL_BACKFILL or history_missing
    cutoff = None if is_backfill else previous_cutoff

    print("=" * 55)
    print("  Canix Data Sync — 2CW Enterprises")
    print(f"  Base URL    : {BASE_URL}")
    print(f"  API keys    : {', '.join(label for label, _ in LICENSE_API_KEYS)}")
    mode = 'FULL BACKFILL' if is_backfill else f'INCREMENTAL (since {cutoff})'
    if is_backfill and previous_cutoff and not FORCE_FULL_BACKFILL:
        mode += ' — history file(s) missing locally, cutoff ignored'
    print(f"  Mode        : {mode}")
    print(f"  Started     : {started.strftime('%Y-%m-%d %H:%M:%S')}")
    print("=" * 55)

    all_facilities = []
    newest_overall = None

    try:
        for label, api_key in LICENSE_API_KEYS:
            facilities, newest_by_key = sync_for_license(label, api_key, cutoff, histories)
            all_facilities.extend(facilities)
            for ts in newest_by_key.values():
                if ts and (newest_overall is None or ts > newest_overall):
                    newest_overall = ts
    except RuntimeError as e:
        print(f"\n\nFATAL ERROR: {e}")
        return 1

    # Dedupe facilities by id — an org-wide key and a per-license key could
    # both see the same facility if the account structure changes later.
    seen_ids = set()
    unique_facilities = []
    for f in all_facilities:
        if f["id"] in seen_ids:
            continue
        seen_ids.add(f["id"])
        unique_facilities.append(f)
    save("canix_facilities.json", unique_facilities)
    sync_facility_roster_to_supabase(unique_facilities)

    for key, _, hist_file, _ in RESOURCES:
        records = sorted(histories[key].values(), key=lambda r: r.get("id", 0))
        save(hist_file, records)

    current_inventory = [r for r in histories["packages"].values() if r.get("is_active")]
    save("canix_inventory.json", current_inventory)

    next_cutoff = compute_next_cutoff(newest_overall) or previous_cutoff or started.isoformat()

    meta = {
        "last_sync": started.isoformat(),
        "last_incremental_cutoff": next_cutoff,
        "base_url": BASE_URL,
        "license_keys_used": [label for label, _ in LICENSE_API_KEYS],
        "record_counts": {
            "facilities": len(unique_facilities),
            "packages_history": len(histories["packages"]),
            "inventory_current": len(current_inventory),
            "plant_batches": len(histories["plant_batches"]),
            "harvests": len(histories["harvests"]),
            "transfers": len(histories["transfers"]),
            "sales_orders": len(histories["sales_orders"]),
        },
    }
    with open(META_PATH, "w") as f:
        json.dump(meta, f, indent=2)

    elapsed = (datetime.now() - started).total_seconds()

    print("\n" + "=" * 55)
    print("  Sync Complete")
    print(f"  Elapsed         : {elapsed:.1f}s")
    print(f"  Facilities      : {len(unique_facilities)}")
    print(f"  Packages (hist) : {len(histories['packages'])}")
    print(f"  Inventory (now) : {len(current_inventory)}")
    print(f"  Plant Batches   : {len(histories['plant_batches'])}")
    print(f"  Harvests        : {len(histories['harvests'])}")
    print(f"  Transfers       : {len(histories['transfers'])}")
    print(f"  Sales Orders    : {len(histories['sales_orders'])}")
    print(f"  Next cutoff     : {next_cutoff}")
    print(f"  Output          : {OUTPUT_DIR.resolve()}")
    print("=" * 55)
    return 0


if __name__ == "__main__":
    exit(main())
