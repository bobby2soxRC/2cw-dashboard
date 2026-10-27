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

Package and transfer history in Supabase
----------------------------------------
The full packages / transfers history only lives in the Actions cache (too
big for git) and the committed files only hold on-hand packages and 30 days
of transfers, so every run also upserts the packages and transfer lines
changed since the last run into Supabase's canix_packages and
canix_transfer_items (all of them on a full backfill, or until canix_meta's
supabase_history_synced says a full upload went through). That's the
permanent copy the app reads for anything older (sync_history_to_supabase).

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
    data/canix_transfers_recent.json    (last 30 days, slimmed — committed)
    data/canix_sales_orders.json        (small — full refetch every run)
    data/canix_meta.json

Requirements:
    pip install requests
"""

import json
import os
import re
import time
import requests
from datetime import datetime, timedelta, timezone
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

# canix_transfers.json (the full history) only lives in the Actions cache, so
# the dashboard can't read it. canix_transfers_recent.json is the committed
# copy: transfers created or updated in the last RECENT_TRANSFER_DAYS, slimmed
# by slim_record() so it stays small. It's how we see when a manifest was made
# and when its truck left/arrived.
RECENT_TRANSFER_DAYS = 30

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


def slim_record(value, depth=0, max_depth=3):
    """Keep a record's plain values (numbers, text, dates) and its nested
    objects/lists down to max_depth levels, dropping anything deeper — e.g. a
    transfer keeps its manifest number and times, each of its packages' tag
    and weight, but not every package's full item/lab-test detail."""
    if isinstance(value, dict):
        if depth >= max_depth:
            return {k: v for k, v in value.items() if not isinstance(v, (dict, list))}
        return {k: slim_record(v, depth + 1, max_depth) for k, v in value.items()}
    if isinstance(value, list):
        return [slim_record(v, depth, max_depth) for v in value]
    return value


def recent_transfers(transfers, now, packages=(), sales_orders=()):
    since = (now - timedelta(days=RECENT_TRANSFER_DAYS)).strftime("%Y-%m-%dT%H:%M:%S")
    recent = [
        t for t in transfers
        if max(str(t.get("created_at") or ""), str(t.get("updated_at") or "")) >= since
    ]
    recent.sort(key=lambda t: str(t.get("created_at") or t.get("updated_at") or ""), reverse=True)
    pkg_by_tag = {norm_tag(p.get("tag")): p for p in packages if p.get("tag")}
    so_by_id = {str(o.get("id")): o for o in sales_orders if o.get("id") is not None}
    return [slim_record(label_transfer(t, pkg_by_tag, so_by_id)) for t in recent]


def package_sources(tag, pkg_by_tag, depth=4):
    """The tags a package was made from — its source packages, theirs, and so
    on, nearest first, up to `depth` steps back. A package shipped out is
    often a new one cut from a lot the floor knows by its own UID."""
    out, level = [], [tag]
    for _ in range(depth):
        nxt = []
        for t in level:
            for s in (pkg_by_tag.get(t) or {}).get("source_packages") or []:
                st = norm_tag(s.get("tag"))
                if st and st != tag and st not in out:
                    out.append(st)
                    nxt.append(st)
        level = nxt
        if not level:
            break
    return out


def label_transfer(t, pkg_by_tag, so_by_id):
    """A copy of the transfer with each package's item name and strain
    (_item, _strain) and the tags it was made from (_sources), from the
    packages history — slim_record drops the
    package's nested item, and the package leaves our inventory once it's
    accepted) and its sales order # and customer (_sales_order_no,
    _customer_name). The Metrc Queue's "Needs form" rows fill the Product
    Transfer — Outgoing form from these."""
    t = dict(t)
    so = t.get("sales_order")
    if so is not None and not isinstance(so, dict):
        so = so_by_id.get(str(so))
    if isinstance(so, dict):
        so = so_by_id.get(str(so.get("id")), so)
        t["_sales_order_no"] = so.get("name")
        t["_customer_name"] = (so.get("customer") or {}).get("company_name")
    dests = []
    for d in t.get("destinations") or []:
        d = dict(d)
        contents = []
        for c in d.get("contents") or []:
            c = dict(c or {})
            item = (pkg_by_tag.get(norm_tag((c.get("package") or {}).get("tag"))) or {}).get("item") or {}
            if item.get("name"):
                c["_item"] = item.get("name")
            if (item.get("strain") or {}).get("name"):
                c["_strain"] = item["strain"]["name"]
            sources = package_sources(norm_tag((c.get("package") or {}).get("tag")), pkg_by_tag)
            if sources:
                c["_sources"] = sources
            direct = {norm_tag(s.get("tag")) for s in (pkg_by_tag.get(norm_tag((c.get("package") or {}).get("tag"))) or {}).get("source_packages") or [] if s.get("tag")}
            c["_source"] = direct.pop() if len(direct) == 1 else ""
            contents.append(c)
        d["contents"] = contents
        dests.append(d)
    t["destinations"] = dests
    return t


# ── SUPABASE FACILITY ROSTER SYNC ───────────────────────────────────────────


def package_row(p):
    item = p.get("item") if isinstance(p.get("item"), dict) else {}
    return {
        "id": p["id"], "tag": p.get("tag") or "", "item_name": item.get("name"), "status": p.get("status"),
        "is_active": p.get("is_active"), "weight": p.get("weight"), "original_weight": p.get("original_weight"),
        "weight_unit": p.get("weight_unit"), "packaged_date": str(p.get("packaged_date") or "")[:10] or None,
        "facility_id": p.get("facility_id"), "facility_license": p.get("_facility_license_number"),
        "facility_name": p.get("_facility_name"),
        "source": [{"tag": s.get("tag"), "pulled_weight": s.get("pulled_weight"), "pulled_weight_unit": s.get("pulled_weight_unit")}
                   for s in (p.get("source_packages") or []) if isinstance(s, dict) and s.get("tag")],
        "updated_at": p.get("updated_at"),
    }


def transfer_item_rows(t):
    rows = []
    for d in t.get("destinations") or []:
        for c in d.get("contents") or []:
            pkg = c.get("package") or {}
            if pkg.get("id") is None:
                continue
            item = c.get("item") if isinstance(c.get("item"), dict) else (pkg.get("item") if isinstance(pkg.get("item"), dict) else {})
            rows.append({
                "key": f"{d.get('id')}:{pkg.get('id')}", "transfer_id": t.get("id"), "manifest_number": t.get("manifest_number"),
                "from_license": t.get("_facility_license_number"), "from_name": t.get("_facility_name"),
                "destination_license": d.get("destination_facility"), "transfer_type": d.get("transfer_type"),
                "departure_time": d.get("departure_time"), "package_id": pkg.get("id"), "package_tag": pkg.get("tag"),
                "item_name": item.get("name") or c.get("_item"), "status": c.get("status"),
                "shipped_weight": c.get("shipped_weight"), "shipped_weight_unit": c.get("shipped_weight_unit"),
                "received_weight": c.get("received_weight"), "received_weight_unit": c.get("received_weight_unit"),
                "created_at": t.get("created_at"), "updated_at": c.get("updated_at") or d.get("updated_at") or t.get("updated_at"),
            })
    return rows


def upsert_rows(table, key, rows, headers):
    # One row per key: Postgres refuses a batch that hits the same row twice.
    rows = list({r[key]: r for r in rows}.values())
    sent = 0
    for i in range(0, len(rows), 500):
        batch = rows[i:i + 500]
        resp = requests.post(f"{SUPABASE_URL}/rest/v1/{table}?on_conflict={key}",
                             headers={**headers, "Prefer": "resolution=merge-duplicates,return=minimal"}, json=batch, timeout=60)
        if resp.status_code >= 300:
            raise RuntimeError(f"{table} upsert failed: {resp.status_code} {resp.text[:300]}")
        sent += len(batch)
    return sent


def sync_history_to_supabase(packages, transfers, since):
    """Upserts packages and transfer lines updated at or after `since` (all
    of them when None) into canix_packages / canix_transfer_items. Returns
    True when it went through."""
    if not SUPABASE_SERVICE_ROLE_KEY:
        print("\n  [skip] SUPABASE_SERVICE_ROLE_KEY not set — not saving Canix history to Supabase")
        return False
    headers = {"apikey": SUPABASE_SERVICE_ROLE_KEY, "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
               "Content-Type": "application/json"}
    changed = lambda r: since is None or str(r.get("updated_at") or "") >= since
    pkg_rows = [package_row(p) for p in packages if p.get("id") is not None and changed(p)]
    item_rows = [row for t in transfers if changed(t) for row in transfer_item_rows(t)]
    n_pkg = upsert_rows("canix_packages", "id", pkg_rows, headers)
    n_items = upsert_rows("canix_transfer_items", "key", item_rows, headers)
    print(f"  Saved to Supabase: {n_pkg} packages, {n_items} transfer lines" + (f" (changed since {since})" if since else " (full upload)"))
    return True


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


# ── WET INTAKE: METRC DETAILS FROM CANIX ────────────────────────────────────
#
# The Harvest Intake — Wet form (operations_stations.js, intake_wet) no longer
# asks for the farm license, CID or manifest # — the receiving crew scans the
# package UID and weighs. This fills them in afterwards: each submitted intake
# still waiting (no canixSyncedAt, no manifest # typed in) is matched to its
# package on a Metrc transfer, and the Supabase function
# fill_intake_from_canix (supabase/schema.sql) writes the blanks:
#
#   manifestNo     the transfer's manifest number
#   pid            the shipping farm's license, as the form's Farm License
#                  code (ref_codes kind 'pid': "027" for CCL26-0000027), or
#                  the full license when no code matches
#   cid            the CID last used for that license, else the Metrc
#                  harvest name's prefix ("AGP0027-…" → AGP) when it's a
#                  known CID (not first: AutoCanna's harvests say AGP too)
#   canixSync      what was matched — full tag, transfer, shipped weight…
#   canixSyncedAt  when; the page's "Waiting for Metrc sync" goes away
#
# A farm we have no Canix key for is found from the package once it's
# received at our facility — license and CID, but no manifest #: the page
# then asks for it to be typed in on Edit.
#
# The intake's UID is often just the tag's last 4–5, so a tail match only
# counts when one package fits: shipped within INTAKE_MATCH_DAYS_BEFORE days
# before the intake date (or the day after), then — if still more than one —
# the same strain. Anything ambiguous or not found waits for the next run;
# a farm Canix can't see never matches and gets typed in on Edit.

INTAKE_LOOKBACK_DAYS = 45
INTAKE_MATCH_DAYS_BEFORE = 10
TO_LB = {"pounds": 1.0, "lb": 1.0, "lbs": 1.0, "kilograms": 2.20462, "kg": 2.20462, "grams": 0.00220462, "g": 0.00220462, "ounces": 0.0625, "oz": 0.0625}


def norm_tag(value):
    return re.sub(r"[^A-Z0-9]", "", str(value or "").upper())


def to_lb(weight, unit):
    if weight is None:
        return None
    try:
        return round(float(weight) * TO_LB.get(str(unit or "pounds").lower(), 1.0), 2)
    except (TypeError, ValueError):
        return None


def transfer_package_index(transfers, packages):
    """Every package tag that went out on a transfer → [{manifest, license,
    departure, ...}], with the package's strain and harvest name from the
    packages history."""
    pkg_by_tag = {norm_tag(p.get("tag")): p for p in packages if p.get("tag")}
    index = {}
    for t in transfers:
        manifest = str(t.get("manifest_number") or "").strip()
        if not manifest:
            continue
        for d in t.get("destinations") or []:
            for c in d.get("contents") or []:
                pkg = (c or {}).get("package") or {}
                tag = norm_tag(pkg.get("tag"))
                if not tag:
                    continue
                full = pkg_by_tag.get(tag) or {}
                strain = ((full.get("item") or {}).get("strain") or {}).get("name")
                harvests = full.get("harvests") or []
                harvest_name = (harvests[0] or {}).get("name") if harvests else full.get("source_harvests")
                index.setdefault(tag, []).append({
                    "tag": tag,
                    "transferId": t.get("id"),
                    "manifestNo": manifest,
                    "shipperLicense": t.get("_facility_license_number"),
                    "destinationLicense": d.get("destination_facility"),
                    "departure": d.get("departure_time"),
                    "metrcLb": to_lb(c.get("shipped_weight"), c.get("shipped_weight_unit")),
                    "strain": strain,
                    "harvestName": harvest_name,
                })
    # A farm we have no Canix key for: its transfer isn't ours to list, but
    # the package shows up at our facility once it's received in Metrc, with
    # the farm's license as source_facility — no manifest number, though.
    for tag, p in pkg_by_tag.items():
        if tag in index or not p.get("received_date") or not p.get("source_facility"):
            continue
        harvests = p.get("harvests") or []
        index[tag] = [{
            "tag": tag,
            "transferId": None,
            "manifestNo": None,
            "shipperLicense": p.get("source_facility"),
            "destinationLicense": p.get("_facility_license_number"),
            "departure": p.get("received_date"),
            "metrcLb": to_lb(p.get("original_weight"), p.get("weight_unit")),
            "strain": ((p.get("item") or {}).get("strain") or {}).get("name"),
            "harvestName": (harvests[0] or {}).get("name") if harvests else p.get("source_harvests"),
        }]
    return index


def match_intake(uid, work_date, strain, index):
    uid = norm_tag(uid)
    if len(uid) < 4:
        return None
    if uid in index:
        hits = list(index[uid])
    elif len(uid) < 24:
        hits = [h for tag, hs in index.items() if tag.endswith(uid) for h in hs]
    else:
        hits = []
    if not hits:
        return None
    try:
        day = datetime.strptime(str(work_date), "%Y-%m-%d").date()
        lo, hi = day - timedelta(days=INTAKE_MATCH_DAYS_BEFORE), day + timedelta(days=1)
        hits = [h for h in hits if not h["departure"] or lo <= datetime.strptime(h["departure"][:10], "%Y-%m-%d").date() <= hi]
    except ValueError:
        pass
    if len({h["tag"] for h in hits}) > 1 and strain:
        same = [h for h in hits if str(h["strain"] or "").strip().lower() == str(strain).strip().lower()]
        hits = same or hits
    if len({h["tag"] for h in hits}) != 1:
        return None
    # The same package on more than one transfer (sent back and re-sent):
    # the latest one.
    return max(hits, key=lambda h: str(h["departure"] or ""))


def license_to_pid(license_number, pid_codes):
    lic = str(license_number or "").strip()
    if not lic:
        return None
    if lic in pid_codes:
        return lic
    tail = lic.rsplit("-", 1)[-1]
    fits = [c for c in pid_codes if c.isdigit() and tail.isdigit() and int(c) == int(tail)]
    return max(fits, key=len) if fits else lic


def fill_intakes_from_canix(transfers, packages):
    if not SUPABASE_SERVICE_ROLE_KEY:
        print("\n  [skip] SUPABASE_SERVICE_ROLE_KEY not set — not filling Wet Intakes from Canix")
        return
    headers = {
        "apikey": SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
        "Content-Type": "application/json",
    }
    rest = f"{SUPABASE_URL}/rest/v1"
    since = (datetime.now(timezone.utc) - timedelta(days=INTAKE_LOOKBACK_DAYS)).strftime("%Y-%m-%d")

    resp = requests.get(
        f"{rest}/operations_forms",
        headers=headers,
        params={
            "select": "id,work_date,strain,fields",
            "station_key": "eq.intake_wet",
            "status": "eq.submitted",
            "work_date": f"gte.{since}",
            "fields->>canixSyncedAt": "is.null",
            "or": "(fields->>manifestNo.is.null,fields->>manifestNo.eq.)",
        },
        timeout=30,
    )
    if not resp.ok:
        print(f"  [warn] Could not load Wet Intakes to fill from Canix: {resp.status_code} {resp.text[:300]}")
        return
    waiting = resp.json()
    print(f"\n  Wet Intakes waiting for Metrc details: {len(waiting)}")
    if not waiting:
        return

    codes = requests.get(f"{rest}/ref_codes", headers=headers, params={"select": "kind,code"}, timeout=30)
    codes = codes.json() if codes.ok else []
    pid_codes = [r["code"] for r in codes if r.get("kind") == "pid" and r.get("code")]
    cid_codes = {r["code"].upper(): r["code"] for r in codes if r.get("kind") == "cid" and r.get("code")}

    # The CID each farm license was last received under, for harvest names
    # whose prefix isn't a CID code.
    recent = requests.get(
        f"{rest}/operations_forms",
        headers=headers,
        params={"select": "pid:fields->>pid,cid:fields->>cid", "station_key": "eq.intake_wet",
                "status": "eq.submitted", "fields->>cid": "not.is.null", "order": "work_date.desc", "limit": "2000"},
        timeout=30,
    )
    cid_by_pid = {}
    for r in (recent.json() if recent.ok else []):
        if r.get("pid") and r.get("cid"):
            cid_by_pid.setdefault(r["pid"], r["cid"])

    index = transfer_package_index(transfers, packages)
    now = datetime.now(timezone.utc).isoformat()
    filled = 0
    for rec in waiting:
        f = rec.get("fields") or {}
        uid = f.get("sourceUid") or next((ln.get("sourceUid") for ln in f.get("lines") or [] if ln and ln.get("sourceUid")), None)
        hit = match_intake(uid, rec.get("work_date"), rec.get("strain") or f.get("strain"), index)
        if not hit:
            continue
        pid = license_to_pid(hit["shipperLicense"], pid_codes)
        prefix = re.match(r"[A-Za-z]+", str(hit["harvestName"] or ""))
        cid = cid_by_pid.get(pid) or (cid_codes.get(prefix.group(0).upper()) if prefix else None)
        fill = {"canixSyncedAt": now, "canixSync": hit}
        if hit["manifestNo"]:
            fill["manifestNo"] = hit["manifestNo"]
        if pid:
            fill["pid"] = pid
        if cid:
            fill["cid"] = cid
        r = requests.post(f"{rest}/rpc/fill_intake_from_canix", headers=headers,
                          json={"p_id": rec["id"], "p_fill": fill}, timeout=30)
        if r.ok:
            filled += 1
            print(f"    {uid} → manifest {hit['manifestNo'] or '(none in Canix)'} ({hit['shipperLicense']}, tag {hit['tag']})")
        else:
            print(f"  [warn] Could not fill intake {rec['id']}: {r.status_code} {r.text[:200]}")
    print(f"  Filled {filled} of {len(waiting)} from Canix; the rest wait for the next sync")


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
    # UTC with an explicit offset — CI runners are on UTC, and a naive
    # timestamp gets read as local time by canix_inventory.html.
    started = datetime.now(timezone.utc)
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

    transfers_recent = recent_transfers(histories["transfers"].values(), started,
                                        list(histories["packages"].values()), list(histories["sales_orders"].values()))
    save("canix_transfers_recent.json", transfers_recent)

    # The permanent copy of the history. A full upload until one has gone
    # through; after that what changed since the last run's cutoff (less the
    # safety buffer already in it). Never fails the sync.
    history_synced = bool(meta.get("supabase_history_synced")) and not is_backfill
    try:
        history_synced = sync_history_to_supabase(histories["packages"].values(), histories["transfers"].values(),
                                                  previous_cutoff if history_synced else None) or history_synced
    except Exception as e:  # noqa: BLE001
        print(f"  [warn] Saving Canix history to Supabase failed: {e}")
        history_synced = False

    # Never fails the sync — the data files above still get committed.
    try:
        fill_intakes_from_canix(histories["transfers"].values(), histories["packages"].values())
    except Exception as e:  # noqa: BLE001
        print(f"  [warn] Filling Wet Intakes from Canix failed: {e}")

    next_cutoff = compute_next_cutoff(newest_overall) or previous_cutoff or started.strftime("%Y-%m-%dT%H:%M:%S.000Z")

    meta = {
        "last_sync": started.isoformat(),
        "last_incremental_cutoff": next_cutoff,
        "supabase_history_synced": history_synced,
        "base_url": BASE_URL,
        "license_keys_used": [label for label, _ in LICENSE_API_KEYS],
        "record_counts": {
            "facilities": len(unique_facilities),
            "packages_history": len(histories["packages"]),
            "inventory_current": len(current_inventory),
            "plant_batches": len(histories["plant_batches"]),
            "harvests": len(histories["harvests"]),
            "transfers": len(histories["transfers"]),
            "transfers_recent": len(transfers_recent),
            "sales_orders": len(histories["sales_orders"]),
        },
    }
    with open(META_PATH, "w") as f:
        json.dump(meta, f, indent=2)

    elapsed = (datetime.now(timezone.utc) - started).total_seconds()

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
