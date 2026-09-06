"""
production_sync.py
===================
Pulls the "Production Requests" and "Material Request Slots" tabs from the
04-2CW-Production Requests Google Sheet (Howie Roll / Soma Rosa Farms /
Mendo production planning) and writes them to data/operations/production_requests.json
for use by production.html.

The Sheet is the single source of truth and the only place data entry
happens — this script (and production.html) are read-only mirrors of it.

Usage:
    python scripts/production_sync.py

Output:
    data/operations/production_requests.json
"""

import csv
import io
import json
import time
from datetime import datetime, timezone
from pathlib import Path

import requests

# Published-to-web CSV links for each tab (Sheet -> File > Share > Publish
# to web -> select the tab -> CSV). Re-publish and update these if the Sheet
# is ever recreated.
PRODUCTION_REQUESTS_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vQkx0gxPTulAOv3WMXayY8HOqcoYByZ_kOXrLvd84-9ReSwGa-6Or-KTx4SdPfT0rC5_qOCE3LHz_mT/pub?gid=1857304423&single=true&output=csv"
MATERIAL_SLOTS_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vQkx0gxPTulAOv3WMXayY8HOqcoYByZ_kOXrLvd84-9ReSwGa-6Or-KTx4SdPfT0rC5_qOCE3LHz_mT/pub?gid=710383830&single=true&output=csv"

OUTPUT_PATH = Path("data/operations/production_requests.json")

REQUEST_FIELDS = {
    "PR#": "pr_num",
    "Product": "product",
    "ASKU": "asku",
    "BSKU": "bsku",
    "Crew": "crew",
    "Strain Type": "strain_type",
    "Slot ID": "slot_id",
    "Output Strain": "output_strain",
    "Batch Size": "batch_size",
    "Ready Date": "ready_date",
    "Ship Date": "ship_date",
    "Status": "status",
    "Notes": "notes",
}

SLOT_FIELDS = {
    "Slot ID": "slot_id",
    "Week Requested": "week_requested",
    "Strain Type": "strain_type",
    "Target Quantity": "target_quantity",
    "Unit": "unit",
    "Linked PRs": "linked_prs",
    "Linked PR Total": "linked_pr_total",
    "Picked Strain": "picked_strain",
    "Status": "status",
    "Confirmed Date": "confirmed_date",
}

NUMERIC_FIELDS = {"batch_size", "target_quantity", "linked_pr_total"}


def fetch_csv(url, retries=3, backoff=5):
    last_exc = None
    for attempt in range(retries):
        try:
            resp = requests.get(url, timeout=30)
            resp.raise_for_status()
            return list(csv.DictReader(io.StringIO(resp.text)))
        except (requests.exceptions.Timeout, requests.exceptions.ConnectionError) as exc:
            last_exc = exc
            if attempt < retries - 1:
                wait = backoff * (attempt + 1)
                print(f"  [WARN] Fetch failed ({exc}); retrying in {wait}s...")
                time.sleep(wait)
    raise last_exc


def to_number(value):
    if value is None:
        return None
    cleaned = str(value).replace(",", "").strip()
    if not cleaned:
        return None
    try:
        num = float(cleaned)
        return int(num) if num.is_integer() else num
    except ValueError:
        return None


def transform(rows, field_map, required_key):
    out = []
    for row in rows:
        record = {}
        for csv_col, json_key in field_map.items():
            raw = (row.get(csv_col) or "").strip()
            record[json_key] = to_number(raw) if json_key in NUMERIC_FIELDS else raw
        # Skip fully blank rows and the sheet's example/placeholder row.
        if not record.get(required_key):
            continue
        out.append(record)
    return out


def main():
    print("Fetching Production Requests...")
    requests_raw = fetch_csv(PRODUCTION_REQUESTS_URL)
    requests_data = transform(requests_raw, REQUEST_FIELDS, "pr_num")
    print(f"  {len(requests_data)} request(s)")

    print("Fetching Material Request Slots...")
    slots_raw = fetch_csv(MATERIAL_SLOTS_URL)
    slots_data = transform(slots_raw, SLOT_FIELDS, "slot_id")
    print(f"  {len(slots_data)} slot(s)")

    output = {
        "last_sync": datetime.now(timezone.utc).isoformat(),
        "requests": requests_data,
        "slots": slots_data,
    }

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2)
    print(f"Saved to {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
