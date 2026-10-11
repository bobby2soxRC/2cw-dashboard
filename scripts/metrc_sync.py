"""
Metrc Package Sync
==================
Copies the active Metrc packages for 2CW's licenses into Supabase's
metrc_packages table, which metrc_recon.html (App vs Metrc) and
metrc_actions.html compare against the App's station forms.

Two sources, picked automatically:

  metrc  — the Metrc API, when METRC_VENDOR_KEY and METRC_USER_KEY are set.
           GET /packages/v2/active for each license in METRC_LICENSES, paged.
           Auth is HTTP Basic: vendor (integrator) key as the username, the
           user's API key as the password. The user key belongs to a Metrc
           user, and only sees the licenses that user has permissions on.
  canix  — otherwise, Canix's copy of Metrc: data/canix_inventory.json, which
           scripts/canix_sync.py refreshes every 3 hours. Same package tags
           and weights, a few hours behind. This keeps the dashboards useful
           while the Metrc API keys are being set up.

Force one with METRC_SOURCE=metrc or METRC_SOURCE=canix.

Every package seen this run is upserted with is_active = true. Packages for
the same licenses that weren't seen are set is_active = false (kept, not
deleted). Each run is logged in metrc_sync_runs.

Environment:
    METRC_LICENSES             comma-separated license numbers to sync, e.g.
                               "C11-0001652-LIC,CCL22-0001284". Required for
                               the Metrc API; for Canix it's an optional filter
                               (unset = every license in Canix).
    METRC_VENDOR_KEY           Metrc integrator (software vendor) API key
    METRC_USER_KEY             Metrc user API key
    METRC_BASE_URL             default https://api-ca.metrc.com
    METRC_PAGE_SIZE            default 20
    SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   (service role — writes past RLS)

Usage:
    python scripts/metrc_sync.py
"""

import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import requests

METRC_BASE_URL = (os.environ.get("METRC_BASE_URL") or "https://api-ca.metrc.com").rstrip("/")
METRC_VENDOR_KEY = os.environ.get("METRC_VENDOR_KEY", "")
METRC_USER_KEY = os.environ.get("METRC_USER_KEY", "")
METRC_PAGE_SIZE = int(os.environ.get("METRC_PAGE_SIZE") or "20")
LICENSES = [x.strip() for x in os.environ.get("METRC_LICENSES", "").split(",") if x.strip()]

SUPABASE_URL = (os.environ.get("SUPABASE_URL") or "https://ugtxmyciyuelxxzqmrdx.supabase.co").rstrip("/")
SUPABASE_SERVICE_ROLE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")

CANIX_INVENTORY = Path("data/canix_inventory.json")
REQUEST_PACE_SECONDS = 0.3
RETRY_BACKOFF_SECONDS = [10, 30, 60]
UPSERT_BATCH = 500


def pick_source():
    forced = os.environ.get("METRC_SOURCE", "").strip().lower()
    if forced in ("metrc", "canix"):
        return forced
    return "metrc" if METRC_VENDOR_KEY and METRC_USER_KEY else "canix"


# ── Metrc API ───────────────────────────────────────────────────────────────

def metrc_get(session, path, params):
    url = f"{METRC_BASE_URL}{path}"
    attempt = 0
    while True:
        try:
            resp = session.get(url, params=params, timeout=60)
        except requests.exceptions.RequestException as e:
            if attempt < len(RETRY_BACKOFF_SECONDS):
                wait = RETRY_BACKOFF_SECONDS[attempt]; attempt += 1
                print(f"    connection error ({e}) — retrying in {wait}s")
                time.sleep(wait); continue
            raise
        if resp.status_code == 429:
            wait = int(resp.headers.get("Retry-After") or 30)
            print(f"    rate limited — waiting {wait}s")
            time.sleep(wait); continue
        if resp.status_code >= 500 and attempt < len(RETRY_BACKOFF_SECONDS):
            wait = RETRY_BACKOFF_SECONDS[attempt]; attempt += 1
            print(f"    server error {resp.status_code} — retrying in {wait}s")
            time.sleep(wait); continue
        if resp.status_code == 401:
            raise RuntimeError("Metrc said 401 Unauthorized — check METRC_VENDOR_KEY / METRC_USER_KEY.")
        if resp.status_code == 403:
            raise RuntimeError(f"Metrc said 403 Forbidden for {params.get('licenseNumber')} — "
                               "the user key's Metrc user needs package permissions on that license.")
        if resp.status_code != 200:
            raise RuntimeError(f"Metrc {resp.status_code} on {path}: {resp.text[:300]}")
        return resp.json()


def fetch_metrc_active(session, license_number):
    """Every active package on one license. Handles the v2 paged envelope
    ({Data, TotalPages, ...}) and a bare list, in case a state still answers
    the old way."""
    out = []
    page = 1
    while True:
        body = metrc_get(session, "/packages/v2/active",
                         {"licenseNumber": license_number, "pageNumber": page, "pageSize": METRC_PAGE_SIZE})
        if isinstance(body, list):
            out.extend(body)
            break
        rows = body.get("Data") or []
        out.extend(rows)
        total_pages = body.get("TotalPages") or 1
        print(f"    page {page}/{total_pages}: {len(rows)} packages")
        if page >= total_pages or not rows:
            break
        page += 1
        time.sleep(REQUEST_PACE_SECONDS)
    return out


def from_metrc(pkg, license_number):
    item = pkg.get("Item") or {}
    return {
        "tag": (pkg.get("Label") or "").strip().upper(),
        "license_number": license_number,
        "metrc_id": pkg.get("Id"),
        "item_name": item.get("Name") or pkg.get("ItemName"),
        "item_category": item.get("ProductCategoryName") or pkg.get("ItemProductCategoryName"),
        "strain": item.get("StrainName") or pkg.get("ItemStrainName"),
        "quantity": pkg.get("Quantity"),
        "unit": pkg.get("UnitOfMeasureName") or pkg.get("UnitOfMeasureAbbreviation"),
        "packaged_date": (pkg.get("PackagedDate") or "")[:10] or None,
        "location": pkg.get("LocationName"),
        "on_hold": bool(pkg.get("IsOnHold")),
        "last_modified": pkg.get("LastModified"),
    }


def load_from_metrc():
    if not LICENSES:
        raise RuntimeError("METRC_LICENSES is empty — list the license numbers to sync, comma-separated.")
    s = requests.Session()
    s.auth = (METRC_VENDOR_KEY, METRC_USER_KEY)
    s.headers.update({"Accept": "application/json"})
    rows = []
    for lic in LICENSES:
        print(f"  {lic}")
        pkgs = fetch_metrc_active(s, lic)
        print(f"    → {len(pkgs)} active")
        rows.extend(from_metrc(p, lic) for p in pkgs)
    return rows, LICENSES


# ── Canix fallback ──────────────────────────────────────────────────────────

def from_canix(p):
    item = p.get("item") or {}
    typ = item.get("type") or {}
    strain = item.get("strain") or {}
    loc = p.get("location") or {}
    return {
        "tag": (p.get("tag") or "").strip().upper(),
        "license_number": p.get("_facility_license_number"),
        "metrc_id": None,
        "item_name": item.get("name"),
        "item_category": typ.get("product_category") or typ.get("name"),
        "strain": strain.get("name"),
        "quantity": p.get("weight"),
        "unit": p.get("weight_unit"),
        "packaged_date": (p.get("packaged_date") or "")[:10] or None,
        "location": loc.get("name") if isinstance(loc, dict) else None,
        "on_hold": False,
        "last_modified": p.get("updated_at"),
    }


def load_from_canix():
    if not CANIX_INVENTORY.exists():
        raise RuntimeError(f"{CANIX_INVENTORY} not found — run scripts/canix_sync.py first, or set the Metrc API keys.")
    inv = json.loads(CANIX_INVENTORY.read_text(encoding="utf-8"))
    rows = [from_canix(p) for p in inv if p.get("is_active", True) and p.get("tag")]
    if LICENSES:
        rows = [r for r in rows if r["license_number"] in LICENSES]
        return rows, LICENSES
    return rows, sorted({r["license_number"] for r in rows if r["license_number"]})


# ── Supabase ────────────────────────────────────────────────────────────────

def sb_headers(extra=None):
    h = {"apikey": SUPABASE_SERVICE_ROLE_KEY, "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
         "Content-Type": "application/json"}
    if extra:
        h.update(extra)
    return h


def sb_check(resp, what):
    if resp.status_code >= 300:
        raise RuntimeError(f"Supabase {what} failed ({resp.status_code}): {resp.text[:300]}")


def start_run(source):
    r = requests.post(f"{SUPABASE_URL}/rest/v1/metrc_sync_runs",
                      headers=sb_headers({"Prefer": "return=representation"}),
                      json={"source": source}, timeout=30)
    sb_check(r, "metrc_sync_runs insert")
    return r.json()[0]["id"]


def finish_run(run_id, licenses, count, error=None):
    r = requests.patch(f"{SUPABASE_URL}/rest/v1/metrc_sync_runs", params={"id": f"eq.{run_id}"},
                       headers=sb_headers({"Prefer": "return=minimal"}),
                       json={"licenses": licenses, "packages": count, "error": error,
                             "finished_at": datetime.now(timezone.utc).isoformat()}, timeout=30)
    sb_check(r, "metrc_sync_runs update")


def write_packages(rows, licenses, source, synced_at):
    # A tag listed twice (shouldn't happen) would fail the whole upsert batch.
    by_tag = {}
    for r in rows:
        if r["tag"]:
            by_tag[r["tag"]] = {**r, "source": source, "is_active": True, "synced_at": synced_at}
    rows = list(by_tag.values())
    for i in range(0, len(rows), UPSERT_BATCH):
        r = requests.post(f"{SUPABASE_URL}/rest/v1/metrc_packages",
                          headers=sb_headers({"Prefer": "resolution=merge-duplicates,return=minimal"}),
                          json=rows[i:i + UPSERT_BATCH], timeout=60)
        sb_check(r, "metrc_packages upsert")
    print(f"  → upserted {len(rows)} packages")

    # Anything on these licenses we didn't see this run isn't active anymore.
    if licenses:
        lic_list = ",".join(f'"{x}"' for x in licenses)
        r = requests.patch(f"{SUPABASE_URL}/rest/v1/metrc_packages",
                           params={"license_number": f"in.({lic_list})", "synced_at": f"lt.{synced_at}",
                                   "is_active": "eq.true"},
                           headers=sb_headers({"Prefer": "return=minimal"}),
                           json={"is_active": False}, timeout=60)
        sb_check(r, "metrc_packages deactivate")
    return len(rows)


def main():
    if not SUPABASE_SERVICE_ROLE_KEY:
        sys.exit("SUPABASE_SERVICE_ROLE_KEY is not set — it's needed to write metrc_packages.")
    source = pick_source()
    print(f"Metrc sync — source: {source}")
    synced_at = datetime.now(timezone.utc).isoformat()
    run_id = start_run(source)
    try:
        rows, licenses = load_from_metrc() if source == "metrc" else load_from_canix()
        count = write_packages(rows, licenses, source, synced_at)
        finish_run(run_id, licenses, count)
        print(f"Done: {count} active packages across {len(licenses)} license(s).")
    except Exception as e:
        finish_run(run_id, LICENSES, None, str(e)[:1000])
        raise


if __name__ == "__main__":
    main()
