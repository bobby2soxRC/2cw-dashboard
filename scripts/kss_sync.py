"""
KSS Data Sync Script
====================
Pulls customer, product, inventory, and sales data from the KSS API
and writes to local JSON files for use by the 2CW dashboards.

Usage:
    python scripts/kss_sync.py

Output:
    data/customers.json
    data/products.json
    data/inventory.json
    data/sales_reps.json
    data/invoices.json
    data/invoice_transactions.json
    data/_meta.json

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

# API key is read from environment variable — never hardcoded
# Locally: set KSS_API_KEY in your shell before running
# GitHub Actions: stored as a repository secret
API_KEY = os.environ.get("KSS_API_KEY", "")
if not API_KEY:
    raise RuntimeError(
        "KSS_API_KEY environment variable not set.\n"
        "Locally: set KSS_API_KEY=your-key-here in your shell.\n"
        "GitHub Actions: add KSS_API_KEY as a repository secret."
    )

# Switch BASE_URL to production when ready
BASE_URL = os.environ.get("KSS_BASE_URL", "https://api.kssdata.com/api/v1")

SUPPLIER_IDS = [62, 63, 74]          # Howie Roll, Soma Rosa, Mendo
SUPPLIER_STR = ",".join(str(s) for s in SUPPLIER_IDS)

INVOICE_HISTORY_DAYS = 365
OUTPUT_DIR = Path("data")

STATUS_VERIFIED = 7
STATUS_RETURNED = 4

# ── HTTP HELPERS ─────────────────────────────────────────────────────────────

SESSION = requests.Session()
SESSION.headers.update({"x-api-key": API_KEY})


def fetch_page(endpoint, params):
    url = f"{BASE_URL}/{endpoint}"
    resp = SESSION.get(url, params=params, timeout=30)

    if resp.status_code == 429:
        print("    Rate limited — waiting 60 seconds...")
        time.sleep(60)
        return fetch_page(endpoint, params)

    if resp.status_code != 200:
        raise RuntimeError(
            f"API error {resp.status_code} on {endpoint}: {resp.text[:200]}"
        )

    return resp.json()


def fetch_all(endpoint, params=None, label=""):
    params = dict(params or {})
    params["PageSize"] = 500
    params["Page"]     = 1
    all_records = []

    while True:
        print(f"    Page {params['Page']}...", end=" ", flush=True)
        data      = fetch_page(endpoint, params)
        page_data = data.get("Data", [])
        all_records.extend(page_data)
        print(f"{len(page_data)} records")

        if len(page_data) < params["PageSize"]:
            break

        params["Page"] += 1
        time.sleep(0.25)

    return all_records


def save(filename, data):
    OUTPUT_DIR.mkdir(exist_ok=True)
    path = OUTPUT_DIR / filename
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, default=str)
    count = len(data) if isinstance(data, list) else "dict"
    print(f"  → Saved {count} records to {path}")
    return len(data) if isinstance(data, list) else 1


# ── SYNC FUNCTIONS ────────────────────────────────────────────────────────────

def sync_customers():
    print("\n[1/6] Customers")
    raw = fetch_all("customers", {"States": "CA"})
    customers = [c for c in raw if c["CustomerID"] != 1]
    save("customers.json", customers)
    return customers


def sync_products():
    print("\n[2/6] Products")
    products = fetch_all("products", {
        "SupplierIDs": SUPPLIER_STR,
        "States":      "CA",
        "Statuses":    "0,1,2,3,4,5",
    })
    save("products.json", products)
    return products


def sync_inventory():
    print("\n[3/6] Inventory")
    inventory = fetch_all("inventory", {
        "SupplierIDs": SUPPLIER_STR,
        "States":      "CA",
    })
    save("inventory.json", inventory)
    return inventory


def sync_sales_reps():
    print("\n[4/6] Sales Reps")
    reps = fetch_all("salesReps", {
        "SupplierIDs": SUPPLIER_STR,
    })
    save("sales_reps.json", reps)
    return reps


def sync_invoices():
    print("\n[5/6] Invoices")
    start_date = (datetime.now() - timedelta(days=INVOICE_HISTORY_DAYS)).strftime("%Y-%m-%d")
    invoices = fetch_all("invoices", {
        "States":    "CA",
        "Statuses":  "1,2,3,4,5,7",
        "StartDate": start_date,
    })
    save("invoices.json", invoices)
    return invoices


def sync_invoice_transactions(invoices):
    print("\n[6/6] Invoice Transactions")
    invoice_ids = [inv["InvoiceID"] for inv in invoices]

    if not invoice_ids:
        print("  No invoices found — skipping transactions.")
        save("invoice_transactions.json", [])
        return []

    batch_size    = 100
    all_trans     = []
    total_batches = (len(invoice_ids) + batch_size - 1) // batch_size

    for i in range(0, len(invoice_ids), batch_size):
        batch     = invoice_ids[i : i + batch_size]
        batch_num = i // batch_size + 1
        print(f"  Batch {batch_num}/{total_batches} ({len(batch)} invoices)")
        trans = fetch_all("invoiceTransactions", {
            "InvoiceIDs": ",".join(str(x) for x in batch),
        })
        all_trans.extend(trans)
        time.sleep(0.25)

    our_trans = [t for t in all_trans if t.get("SupplierID") in SUPPLIER_IDS]
    save("invoice_transactions.json", our_trans)
    return our_trans


# ── MAIN ──────────────────────────────────────────────────────────────────────

def main():
    started = datetime.now()
    env     = "PRODUCTION" if "test" not in BASE_URL else "TEST"

    print("=" * 55)
    print("  KSS Data Sync — 2CW Enterprises")
    print(f"  Environment : {env} ({BASE_URL})")
    print(f"  Brands      : Howie Roll (62), Soma Rosa (63), Mendo (74)")
    print(f"  Started     : {started.strftime('%Y-%m-%d %H:%M:%S')}")
    print("=" * 55)

    try:
        customers    = sync_customers()
        products     = sync_products()
        inventory    = sync_inventory()
        reps         = sync_sales_reps()
        invoices     = sync_invoices()
        transactions = sync_invoice_transactions(invoices)
    except RuntimeError as e:
        print(f"\n\nFATAL ERROR: {e}")
        return 1

    verified_invoices = [inv for inv in invoices if inv.get("Status") == STATUS_VERIFIED]
    credit_invoices   = [inv for inv in invoices if inv.get("Status") == STATUS_RETURNED]

    meta = {
        "last_sync":   started.isoformat(),
        "environment": env,
        "record_counts": {
            "customers":            len(customers),
            "products":             len(products),
            "inventory_records":    len(inventory),
            "sales_reps":           len(reps),
            "invoices_total":       len(invoices),
            "invoices_verified":    len(verified_invoices),
            "invoices_credits":     len(credit_invoices),
            "invoice_transactions": len(transactions),
        }
    }
    with open(OUTPUT_DIR / "_meta.json", "w") as f:
        json.dump(meta, f, indent=2)

    elapsed = (datetime.now() - started).total_seconds()

    print("\n" + "=" * 55)
    print("  Sync Complete")
    print(f"  Elapsed     : {elapsed:.1f}s")
    print(f"  Customers   : {len(customers)}")
    print(f"  Products    : {len(products)}")
    print(f"  Inventory   : {len(inventory)}")
    print(f"  Sales Reps  : {len(reps)}")
    print(f"  Invoices    : {len(invoices)} total  "
          f"({len(verified_invoices)} verified, {len(credit_invoices)} credits)")
    print(f"  Transactions: {len(transactions)}")
    print(f"  Output      : {OUTPUT_DIR.resolve()}")
    print("=" * 55)
    return 0


if __name__ == "__main__":
    exit(main())
