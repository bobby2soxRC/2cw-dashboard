"""
kss_transform.py
================
Transform layer: raw KSS API JSON → dashboard_data.json

INPUT  (from data/*.json written by kss_sync.py)
-------
  data/products.json
  data/inventory.json
  data/customers.json
  data/sales_reps.json
  data/invoices.json
  data/invoice_transactions.json

OUTPUT
------
  data/dashboard_data.json
    {
      "ref_date":    "2026-05-27",
      "all_pgs":     [...],          # 11 product-group aggregates
      "acct_records":[...],          # one record per account
      "kss":         [...],          # one card per KSS TM
      "twocw":       [...]           # one card per 2CW rep
    }

DATA MODEL REFERENCE (derived from NedCo LineItemSales CSV)
-----------------------------------------------------------
BSKU  = 8-digit code: [brand_prefix][cat_code][subcat_code][size_code]
TSKU  = BSKU + type suffix  (I = Indica, S = Sativa, H = Hybrid)

Brand prefixes:
  SRF = Soma Rosa Farms
  HWR = Howie Roll
  MDO = Mendo  (no BSKU in sales history yet - placeholder)

Category codes (digits 4-5):
  01 = Flower
  02 = Preroll
  03 = Concentrate
  04 = Vape

Subcategory codes (digits 6-7):
  SRF:  01=Bigs, 07=Single, 10=28pk, 03=Live Rosin Jar
  HWR:  02=Smalls, 04=Live Resin Jar, 06=Live Resin AIO

Size codes (digits 8-9):
  01 = 1g
  02 = 3.5g
  04 = 14g
  05 = 28g

11 PRODUCT GROUPS → BSKU MAP:
  SRF Flower 1g      → SRF010101   Soma Rosa Farms / Flower / Bigs / 1g
  SRF Flower 8th     → SRF010102   Soma Rosa Farms / Flower / Bigs / 3.5g
  SRF Flower 14g     → SRF010104   Soma Rosa Farms / Flower / Bigs / 14g
  SRF Flower Oz      → SRF010105   Soma Rosa Farms / Flower / Bigs / 28g
  SRF Preroll 1g     → SRF020701   Soma Rosa Farms / Preroll / Single / 1g
  SRF Preroll 28pk   → SRF021004   Soma Rosa Farms / Preroll / 28pk / 14g
  SRF Live Rosin Jar → SRF030301   Soma Rosa Farms / Concentrate / Live Rosin Jar / 1g
  HWR Smalls 8th     → HWR010202   Howie Roll / Flower / Smalls / 3.5g
  HWR Smalls 14g     → HWR010204   Howie Roll / Flower / Smalls / 14g
  HWR Live Resin Jar → HWR030401   Howie Roll / Concentrate / Live Resin Jar / 1g
  HWR Live Resin AIO → HWR040601   Howie Roll / Vape / Live Resin AIO / 1g

BSKU Concat = "Brand-Category-Subcategory-Weight-Unit"
  e.g. "Soma Rosa Farms-Flower-Bigs-3.5g"
"""

import json
import re
import os
import csv
import io
import urllib.request
from datetime import datetime, date, timedelta
from collections import defaultdict

# Published DATAV Google Sheet — single source of truth for BSKU taxonomy.
# Update this URL if the sheet is republished.
DATAV_URL = (
    "https://docs.google.com/spreadsheets/d/e/"
    "2PACX-1vR0XoiLhCKQE_koaz4nFxjHREx22PZbwpZFlDG97vYl6ifdTFSdXTRK0ttsPMQNQCMKsTRIN0Mw0x3Z"
    "/pub?output=csv"
)

# ─────────────────────────────────────────────────────────────────────────────
# PATHS
# ─────────────────────────────────────────────────────────────────────────────
DATA_DIR    = os.path.join(os.path.dirname(__file__), "data")
CONFIG_DIR  = os.path.join(os.path.dirname(__file__), "config")

def load_json(filename):
    path = os.path.join(DATA_DIR, filename)
    if not os.path.exists(path):
        print(f"  [WARN] {filename} not found, returning []")
        return []
    with open(path) as f:
        return json.load(f)

def save_json(filename, data):
    path = os.path.join(DATA_DIR, filename)
    with open(path, "w") as f:
        json.dump(data, f, indent=2, default=str)
    print(f"  [OK] Wrote {filename} ({len(data) if isinstance(data, list) else 'dict'})")

# ─────────────────────────────────────────────────────────────────────────────
# PRODUCT GROUP TAXONOMY
# Loaded at runtime from DATAV Google Sheet; hardcoded fallback if fetch fails.
#
# BSKU = 9-char code: [B-ID 3][C-ID 2][S-ID 2][W-ID 2]
#   e.g. SRF010102 = SRF (Soma Rosa) + 01 (Flower) + 01 (Bigs) + 02 (3.5g)
# TSKU = BSKU + type suffix  I=Indica  S=Sativa  H=Hybrid
# ─────────────────────────────────────────────────────────────────────────────

# Human-readable PG labels keyed by BSKU.
# New BSKUs added to DATAV but not listed here get an auto-derived label.
PG_LABELS = {
    "SRF010101": "SRF Flower 1g",
    "SRF010102": "SRF Flower 8th",
    "SRF010104": "SRF Flower 14g",
    "SRF010105": "SRF Flower Oz",
    "SRF020701": "SRF Preroll 1g",
    "SRF021004": "SRF Preroll 28pk",
    "SRF030301": "SRF Live Rosin Jar",
    "HWR010202": "HWR Smalls 8th",
    "HWR010204": "HWR Smalls 14g",
    "HWR020802": "HWR Preroll 6pk",
    "HWR021004": "HWR Preroll 28pk",
    "HWR030401": "HWR Live Resin Jar",
    "HWR040601": "HWR Live Resin AIO",
}

# Hardcoded fallback used when DATAV fetch fails
_FALLBACK_PG_TABLE = [
    ("SRF Flower 1g",      "SRF010101", "Soma Rosa Farms", "Flower",      "Bigs",           "1g"  ),
    ("SRF Flower 8th",     "SRF010102", "Soma Rosa Farms", "Flower",      "Bigs",           "3.5g"),
    ("SRF Flower 14g",     "SRF010104", "Soma Rosa Farms", "Flower",      "Bigs",           "14g" ),
    ("SRF Flower Oz",      "SRF010105", "Soma Rosa Farms", "Flower",      "Bigs",           "28g" ),
    ("SRF Preroll 1g",     "SRF020701", "Soma Rosa Farms", "Preroll",     "Single",         "1g"  ),
    ("SRF Preroll 28pk",   "SRF021004", "Soma Rosa Farms", "Preroll",     "28pk",           "14g" ),
    ("SRF Live Rosin Jar", "SRF030301", "Soma Rosa Farms", "Concentrate", "Live Rosin Jar", "1g"  ),
    ("HWR Smalls 8th",     "HWR010202", "Howie Roll",      "Flower",      "Smalls",         "3.5g"),
    ("HWR Smalls 14g",     "HWR010204", "Howie Roll",      "Flower",      "Smalls",         "14g" ),
    ("HWR Preroll 6pk",    "HWR020802", "Howie Roll",      "Preroll",     "6pk",            "3.5g"),
    ("HWR Preroll 28pk",   "HWR021004", "Howie Roll",      "Preroll",     "28pk",           "14g" ),
    ("HWR Live Resin Jar", "HWR030401", "Howie Roll",      "Concentrate", "Live Resin Jar", "1g"  ),
    ("HWR Live Resin AIO", "HWR040601", "Howie Roll",      "Vape",        "Live Resin AIO", "1g"  ),
]

_FALLBACK_UPP = {
    "1g": 454, "3.5g": 128, "7g": 64, "14g": 32,
    "28g": 16, "5g": 90.8, "10ct": 90.8, "Bulk": 1,
}

# Module-level tables — initialized from fallback, refreshed by fetch_datav()
PG_TABLE   = list(_FALLBACK_PG_TABLE)
UPP_BY_WU  = dict(_FALLBACK_UPP)   # weight_unit → units per pound of flower
BSKU_LOOKUP = {}                    # (brand, cat, sub, wu) → (pg, bsku)
BSKU_CONCAT = {}                    # bsku → "Brand-Cat-Sub-WU" string

def _rebuild_lookups():
    """Rebuild BSKU_LOOKUP and BSKU_CONCAT from current PG_TABLE."""
    BSKU_LOOKUP.clear()
    BSKU_CONCAT.clear()
    for pg, bsku, brand, cat, sub, wu in PG_TABLE:
        BSKU_LOOKUP[(brand, cat, sub, wu)] = (pg, bsku)
        BSKU_CONCAT[bsku] = f"{brand}-{cat}-{sub}-{wu}"

_rebuild_lookups()   # initialize from fallback at import time


def fetch_datav() -> bool:
    """
    Fetch product taxonomy from the published DATAV Google Sheet.
    Updates PG_TABLE, BSKU_LOOKUP, BSKU_CONCAT, and UPP_BY_WU in place.
    Returns True on success, False if fetch fails (fallback stays active).
    """
    global PG_TABLE, UPP_BY_WU
    try:
        print("  Fetching DATAV from Google Sheets...", end=" ")
        req = urllib.request.Request(
            DATAV_URL, headers={"User-Agent": "Mozilla/5.0 (kss_transform)"}
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            content = resp.read().decode("utf-8")

        rows = list(csv.DictReader(io.StringIO(content)))

        # Weight-unit dimension → units per pound
        upp = {}
        for r in rows:
            wu      = (r.get("WEIGHT-UNIT") or "").strip()
            upp_raw = (r.get("Units Per Pound") or "").strip()
            if wu and upp_raw:
                try:
                    upp[wu] = float(upp_raw)
                except ValueError:
                    pass

        # BSKU table — right-side columns of DATAV
        new_pg_table = []
        for r in rows:
            bsku  = (r.get("BSKU") or "").strip()
            brand = (r.get("Brand") or "").strip()
            cat   = (r.get("Category") or "").strip()
            sub   = (r.get("Subcategory") or "").strip()
            wu    = (r.get("Weight-Unit") or "").strip()
            if not (bsku and brand and cat and sub and wu):
                continue
            pg = PG_LABELS.get(bsku) or f"{bsku[:3]} {sub} {wu}"
            new_pg_table.append((pg, bsku, brand, cat, sub, wu))

        if not new_pg_table:
            raise ValueError("DATAV returned 0 BSKU rows")

        PG_TABLE  = new_pg_table
        UPP_BY_WU = upp if upp else _FALLBACK_UPP
        _rebuild_lookups()
        print(f"{len(PG_TABLE)} BSKUs loaded.")
        return True

    except Exception as exc:
        print(f"\n  [WARN] DATAV fetch failed: {exc} — using hardcoded fallback.")
        PG_TABLE  = list(_FALLBACK_PG_TABLE)
        UPP_BY_WU = dict(_FALLBACK_UPP)
        _rebuild_lookups()
        return False


# Type suffix map
TYPE_SUFFIX = {"Indica": "I", "Sativa": "S", "Hybrid": "H"}

def make_tsku(bsku: str, type_: str) -> str:
    suffix = TYPE_SUFFIX.get(type_, "")
    return bsku + suffix if suffix else bsku


# ─────────────────────────────────────────────────────────────────────────────
# PRODUCT NAME PARSER
# Parse KSS API product names → (brand, category, subcategory, weight_unit, type, flavor)
#
# KSS product name examples seen in the sales data:
#   "Soma Rosa Flower 3.5g Indica Lime Juice"
#   "Soma Rosa xT Flower 3.5g Indica Hoochi 16ct"
#   "Howie Roll Flower 14g Indica Donny Burger"
#   "Howie Roll xT All-In-One Live Resin Cartridge 1g Sativa Orange Elixir"
#   "Soma Rosa Preroll 1g Indica Pave X Tree Flip"
#   "Soma Rosa xT Preroll 0.5g Indica LA Kush Cake 28pk"
#   "Soma Rosa xT Live Rosin 1g Hybrid Lemon Kush Mintz"
#   "Howie Roll Live Resin 1g Indica Talllyman Bananas"
#   "Howie Roll xT All-In-One Cartridge 1g Indica Tallymon Bananas"
# ─────────────────────────────────────────────────────────────────────────────

# Keyword rules applied in order. First match wins.
# Each rule: (regex pattern, brand, category, subcategory, weight_unit_override_or_None)
# weight_unit_override=None means parse the size from the product name directly.

_NAME_RULES = [
    # Howie Roll AIO vapes  (must come before generic Live Resin)
    (r"howie roll.*(?:all-in-one|aio).*cartridge",
        "Howie Roll", "Vape", "Live Resin AIO", None),

    # Howie Roll Live Resin Jar / concentrate
    (r"howie roll.*live resin.*(?:jar|concentrate|(?!cartridge)(?!all-in-one)(?!aio)$)",
        "Howie Roll", "Concentrate", "Live Resin Jar", None),

    # Howie Roll Preroll 28pk  (must come before generic HWR preroll)
    (r"howie roll.*(?:preroll|pre-roll).*28pk",
        "Howie Roll", "Preroll", "28pk", "14g"),

    # Howie Roll Preroll 6pk
    (r"howie roll.*(?:preroll|pre-roll).*6pk",
        "Howie Roll", "Preroll", "6pk", "3.5g"),

    # Howie Roll Flower Smalls
    (r"howie roll.*flower",
        "Howie Roll", "Flower", "Smalls", None),

    # Soma Rosa Live Rosin Jar
    (r"soma rosa.*live rosin",
        "Soma Rosa Farms", "Concentrate", "Live Rosin Jar", None),

    # Soma Rosa Preroll 28pk (must come before generic Preroll)
    (r"soma rosa.*preroll.*28pk",
        "Soma Rosa Farms", "Preroll", "28pk", "14g"),

    # Soma Rosa Preroll Single 1g
    (r"soma rosa.*preroll",
        "Soma Rosa Farms", "Preroll", "Single", "1g"),

    # Soma Rosa Flower 1g
    (r"soma rosa.*flower.*\b1g\b",
        "Soma Rosa Farms", "Flower", "Bigs", "1g"),

    # Soma Rosa Flower Bigs (all sizes)
    (r"soma rosa.*flower",
        "Soma Rosa Farms", "Flower", "Bigs", None),
]

_SIZE_PAT = re.compile(r"\b(\d+(?:\.\d+)?)\s*g\b", re.IGNORECASE)
_TYPE_PAT = re.compile(r"\b(indica|sativa|hybrid)\b", re.IGNORECASE)

# Map "Soma Rosa" → "Soma Rosa Farms" (NedCo uses short names)
BRAND_NORMALIZE = {
    "Soma Rosa Farms": "Soma Rosa Farms",
    "Soma Rosa":       "Soma Rosa Farms",
    "Howie Roll":      "Howie Roll",
    "Mendo":           "Mendo",
}

# Weight string → weight_unit canonical form
def _canonicalize_size(raw_g: str) -> str:
    """Convert gram value to our weight-unit labels."""
    g = float(raw_g)
    if g <= 1:   return "1g"
    if g <= 3.6: return "3.5g"
    if g <= 14:  return "14g"
    return "28g"

def parse_product_name(name: str) -> dict:
    """
    Return dict with keys:
      brand, category, subcategory, weight_unit, type, flavor, bsku, tsku, pg, bsku_concat
    Returns None if name cannot be parsed.
    """
    low = name.lower()

    brand = cat = sub = wu = None

    # Strip case-count suffixes like "16ct", "28pk" at end for flavor parsing
    clean = re.sub(r"\s+\d+(?:ct|pk)\s*$", "", name, flags=re.IGNORECASE)
    # Strip "xT" qualifier
    clean = re.sub(r"\bxT\b", "", clean).strip()

    for pattern, b, c, s, wu_override in _NAME_RULES:
        if re.search(pattern, low):
            brand, cat, sub = b, c, s
            wu = wu_override
            break

    if brand is None:
        return None  # unrecognized product

    # Extract weight-unit from name if not overridden
    if wu is None:
        size_match = _SIZE_PAT.search(clean)
        wu = _canonicalize_size(size_match.group(1)) if size_match else None
    if wu is None:
        return None

    # Extract type
    type_match = _TYPE_PAT.search(clean)
    type_ = type_match.group(1).capitalize() if type_match else None

    # Extract flavor: everything after the type keyword (if found),
    # or after the size (fallback)
    flavor = None
    if type_match:
        flavor = clean[type_match.end():].strip()
    else:
        size_m = _SIZE_PAT.search(clean)
        if size_m:
            flavor = clean[size_m.end():].strip()
    flavor = flavor.strip("-–, ").strip() if flavor else ""

    # BSKU lookup
    key = (brand, cat, sub, wu)
    pg_bsku = BSKU_LOOKUP.get(key)
    if pg_bsku is None:
        # Still return parsed data, mark pg/bsku as unknown
        pg, bsku = "Unknown", ""
    else:
        pg, bsku = pg_bsku

    tsku = make_tsku(bsku, type_) if bsku else ""
    bsku_concat = BSKU_CONCAT.get(bsku, "")

    return {
        "brand":        brand,
        "category":     cat,
        "subcategory":  sub,
        "weight_unit":  wu,
        "type":         type_,
        "flavor":       flavor,
        "bsku":         bsku,
        "tsku":         tsku,
        "pg":           pg,
        "bsku_concat":  bsku_concat,
    }


# ─────────────────────────────────────────────────────────────────────────────
# ACCOUNT STATUS TIERS  (from established account-status rules)
# Active ≤30 days, Priority 31–60 days, At Risk 61–90 days, Lost 90+ days
# Accounts with all-time revenue < $50 → "Sampled"
# ─────────────────────────────────────────────────────────────────────────────

def account_status(days_since_order: int | None, lifetime_revenue: float) -> str:
    if lifetime_revenue < 50:
        return "Sampled"
    if days_since_order is None:
        return "Lost"
    if days_since_order <= 30:
        return "Active"
    if days_since_order <= 60:
        return "Priority"
    if days_since_order <= 90:
        return "At Risk"
    return "Lost"


# ─────────────────────────────────────────────────────────────────────────────
# 2CW REP CONFIG  (not in KSS API — hardcoded here, keep in sync manually)
# Maps account_name → twocw_rep (John, Billy, Mac, Jonathan)
# In production this should be read from config/rep_assignments.json
# ─────────────────────────────────────────────────────────────────────────────

def load_rep_assignments() -> dict:
    """Returns dict: account_name_lower → twocw_rep_name"""
    path = os.path.join(CONFIG_DIR, "rep_assignments.json")
    if os.path.exists(path):
        with open(path) as f:
            data = json.load(f)
        # Normalize keys to lowercase for matching
        return {k.lower(): v for k, v in data.items()}
    print("  [WARN] config/rep_assignments.json not found — 2CW rep field will be blank")
    return {}


# ─────────────────────────────────────────────────────────────────────────────
# MAIN TRANSFORM
# ─────────────────────────────────────────────────────────────────────────────

def transform():
    today = date.today().isoformat()
    print(f"\n=== kss_transform.py  ref_date={today} ===\n")

    # ── Refresh taxonomy from DATAV ──────────────────────────────────────────
    fetch_datav()

    # ── Load raw API data ────────────────────────────────────────────────────
    products_raw       = load_json("products.json")
    inventory_raw      = load_json("inventory.json")
    customers_raw      = load_json("customers.json")
    sales_reps_raw     = load_json("sales_reps.json")
    invoices_raw       = load_json("invoices.json")
    txn_raw            = load_json("invoice_transactions.json")

    rep_assignments    = load_rep_assignments()

    # ── Build product catalog: sku_id → parsed taxonomy ─────────────────────
    print("Building product catalog...")
    product_catalog = {}  # sku_id → {name, pg, bsku, tsku, ...}
    parse_failures = []
    for p in products_raw:
        sku_id = str(p.get("id") or p.get("sku_id") or "")
        name   = p.get("name") or p.get("product_name") or ""
        parsed = parse_product_name(name)
        if parsed:
            product_catalog[sku_id] = {**parsed, "raw_name": name, "sku_id": sku_id,
                                        "price": p.get("price") or p.get("ws_price") or 0}
        else:
            parse_failures.append(name)

    print(f"  Products parsed: {len(product_catalog)}/{len(products_raw)}")
    if parse_failures:
        print(f"  Parse failures ({len(parse_failures)}): {parse_failures[:5]}")

    # ── Build inventory snapshot: sku_id → units_on_hand ────────────────────
    print("Building inventory snapshot...")
    # Inventory may be keyed by sku_id or product_id
    inventory_map = {}  # sku_id → quantity
    for row in inventory_raw:
        sku_id = str(row.get("sku_id") or row.get("product_id") or "")
        qty    = int(row.get("quantity") or row.get("inventory") or 0)
        if sku_id:
            inventory_map[sku_id] = inventory_map.get(sku_id, 0) + qty

    # ── Build invoice line items with taxonomy attached ──────────────────────
    print("Building invoice line items...")

    # invoices: invoice_id → {location, date, customer_id, kss_rep_id, status}
    invoice_index = {}
    for inv in invoices_raw:
        inv_id = str(inv.get("id") or inv.get("invoice_id") or "")
        invoice_index[inv_id] = {
            "location":    inv.get("customer_name") or inv.get("location") or "",
            "date":        inv.get("invoice_date") or inv.get("date") or "",
            "customer_id": str(inv.get("customer_id") or ""),
            "kss_rep_id":  str(inv.get("sales_rep_id") or inv.get("rep_id") or ""),
            "status":      inv.get("status") or "Verified",
        }

    # Line items with taxonomy
    line_items = []  # list of enriched row dicts
    for txn in txn_raw:
        sku_id  = str(txn.get("sku_id") or txn.get("product_id") or "")
        inv_id  = str(txn.get("invoice_id") or "")
        units   = int(txn.get("quantity") or txn.get("units") or 0)
        subtotal = float(txn.get("line_total") or txn.get("subtotal") or txn.get("amount") or 0)
        # Credits: negative subtotal or category == "Credit"
        is_credit = subtotal < 0 or (txn.get("category") or "").lower() == "credit"

        inv_meta = invoice_index.get(inv_id, {})
        tax_data = product_catalog.get(sku_id, {})

        row = {
            "invoice_id":  inv_id,
            "sku_id":      sku_id,
            "date":        inv_meta.get("date", ""),
            "location":    inv_meta.get("location", ""),
            "customer_id": inv_meta.get("customer_id", ""),
            "kss_rep_id":  inv_meta.get("kss_rep_id", ""),
            "status":      inv_meta.get("status", ""),
            "units":       units,
            "subtotal":    subtotal,
            "is_credit":   is_credit,
            "pg":          tax_data.get("pg", ""),
            "bsku":        tax_data.get("bsku", ""),
            "tsku":        tax_data.get("tsku", ""),
            "bsku_concat": tax_data.get("bsku_concat", ""),
            "brand":       tax_data.get("brand", ""),
            "category":    tax_data.get("category", ""),
            "subcategory": tax_data.get("subcategory", ""),
            "weight_unit": tax_data.get("weight_unit", ""),
            "type":        tax_data.get("type", ""),
            "flavor":      tax_data.get("flavor", ""),
        }

        # Parse date
        try:
            row["date_obj"] = datetime.strptime(row["date"], "%Y-%m-%d").date()
        except Exception:
            try:
                row["date_obj"] = datetime.strptime(row["date"], "%m/%d/%Y").date()
            except Exception:
                row["date_obj"] = None

        line_items.append(row)

    # Sales only (exclude credits)
    sales_rows = [r for r in line_items if not r["is_credit"] and r["date_obj"] is not None]
    print(f"  Total line items: {len(line_items)}, sales rows: {len(sales_rows)}")

    # ── 30-day and 90-day windows ────────────────────────────────────────────
    today_dt = date.today()
    d30 = today_dt - timedelta(days=30)
    d90 = today_dt - timedelta(days=90)

    rows_30d = [r for r in sales_rows if r["date_obj"] >= d30]
    rows_90d = [r for r in sales_rows if r["date_obj"] >= d90]

    # ── PRODUCT GROUP AGGREGATES ─────────────────────────────────────────────
    print("Computing product group aggregates...")

    # Inventory by BSKU (aggregate across all flavor/TSKU variants)
    inv_by_bsku = defaultdict(int)
    for sku_id, qty in inventory_map.items():
        tax = product_catalog.get(sku_id, {})
        bsku = tax.get("bsku")
        if bsku:
            inv_by_bsku[bsku] += qty

    # Sales (units) by BSKU over 30 days
    sales30_by_bsku = defaultdict(int)
    for r in rows_30d:
        if r["bsku"]:
            sales30_by_bsku[r["bsku"]] += r["units"]

    all_pgs = []
    for pg, bsku, brand, cat, sub, wu in PG_TABLE:
        inv    = inv_by_bsku.get(bsku, 0)
        past30 = sales30_by_bsku.get(bsku, 0)
        dos    = round(inv / (past30 / 30), 1) if past30 > 0 else None
        all_pgs.append({
            "pg":             pg,
            "bsku":           bsku,
            "bsku_concat":    BSKU_CONCAT.get(bsku, ""),
            "brand":          brand,
            "category":       cat,
            "subcategory":    sub,
            "weight_unit":    wu,
            "units_per_pound": UPP_BY_WU.get(wu),
            "inventory":      inv,
            "past_30":        past30,
            "days_of_supply": dos,
        })

    # ── ACCOUNT RECORDS ──────────────────────────────────────────────────────
    print("Computing account records...")

    # Per-account aggregates
    acct_revenue_all   = defaultdict(float)   # all-time revenue
    acct_revenue_30d   = defaultdict(float)
    acct_revenue_90d   = defaultdict(float)
    acct_units_30d     = defaultdict(int)
    acct_pgs_30d       = defaultdict(set)     # product groups ordered in 30d
    acct_invoices      = defaultdict(set)     # unique invoice_ids (sales only, not credits)
    acct_invoice_dates = defaultdict(set)     # unique invoice dates (for reorder cadence)
    acct_last_order    = defaultdict(lambda: None)  # latest date_obj (sales only)
    acct_kss_rep       = {}
    acct_location_name = {}

    for r in sales_rows:
        cid = r["customer_id"]
        if not cid:
            continue
        acct_location_name[cid] = r["location"]
        acct_kss_rep[cid]       = r["kss_rep_id"]
        acct_revenue_all[cid]  += r["subtotal"]
        if r["date_obj"] >= d30:
            acct_revenue_30d[cid] += r["subtotal"]
            acct_units_30d[cid]   += r["units"]
            acct_pgs_30d[cid].add(r["pg"])
        if r["date_obj"] >= d90:
            acct_revenue_90d[cid] += r["subtotal"]
        acct_invoices[cid].add(r["invoice_id"])
        acct_invoice_dates[cid].add(r["date_obj"])
        # Track last order date using UNIQUE INVOICE DATES only
        # (credits update Days Since Order in NedCo — we use our own last-sale date)
        d = r["date_obj"]
        cur = acct_last_order[cid]
        if cur is None or d > cur:
            acct_last_order[cid] = d

    # Reorder cadence: avg days between unique invoice dates
    def avg_reorder_cadence(dates_set: set) -> float | None:
        sorted_dates = sorted(d for d in dates_set if d)
        if len(sorted_dates) < 2:
            return None
        gaps = [(sorted_dates[i+1] - sorted_dates[i]).days
                for i in range(len(sorted_dates)-1)]
        # Filter out zero-day gaps (same-day invoices)
        gaps = [g for g in gaps if g > 0]
        return round(sum(gaps) / len(gaps), 1) if gaps else None

    # Build all customer_ids (from both API customers and from sales)
    all_cids = set(str(c.get("id") or c.get("customer_id")) for c in customers_raw)
    all_cids |= set(acct_location_name.keys())

    acct_records = []
    for cid in all_cids:
        last = acct_last_order.get(cid)
        days_since = (today_dt - last).days if last else None
        rev_all    = acct_revenue_all.get(cid, 0)
        status     = account_status(days_since, rev_all)

        cadence    = avg_reorder_cadence(acct_invoice_dates.get(cid, set()))
        twocw_rep  = rep_assignments.get(
            (acct_location_name.get(cid) or "").lower(), "")

        acct_records.append({
            "customer_id":       cid,
            "location":          acct_location_name.get(cid, ""),
            "kss_rep_id":        acct_kss_rep.get(cid, ""),
            "twocw_rep":         twocw_rep,
            "status":            status,
            "days_since_order":  days_since,
            "last_order_date":   last.isoformat() if last else None,
            "revenue_all":       round(rev_all, 2),
            "revenue_30d":       round(acct_revenue_30d.get(cid, 0), 2),
            "revenue_90d":       round(acct_revenue_90d.get(cid, 0), 2),
            "units_30d":         acct_units_30d.get(cid, 0),
            "pgs_30d":           sorted(acct_pgs_30d.get(cid, set())),
            "pg_count_30d":      len(acct_pgs_30d.get(cid, set())),
            "order_count":       len(acct_invoices.get(cid, set())),
            "reorder_cadence":   cadence,
        })

    # ── KSS REP CARDS ────────────────────────────────────────────────────────
    print("Computing KSS rep cards...")

    # Build rep_id → name from sales_reps
    rep_name_map = {}
    for rep in sales_reps_raw:
        rid = str(rep.get("id") or rep.get("rep_id") or "")
        name = rep.get("name") or rep.get("rep_name") or ""
        rep_name_map[rid] = name

    def rep_card(rep_id: str, rep_name: str, my_accts: list) -> dict:
        """Compute metrics for one rep from their account records."""
        active    = [a for a in my_accts if a["status"] == "Active"]
        priority  = [a for a in my_accts if a["status"] == "Priority"]
        at_risk   = [a for a in my_accts if a["status"] == "At Risk"]
        lost      = [a for a in my_accts if a["status"] == "Lost"]
        sampled   = [a for a in my_accts if a["status"] == "Sampled"]

        rev30 = sum(a["revenue_30d"] for a in my_accts)
        rev90 = sum(a["revenue_90d"] for a in my_accts)
        avg_pg_count = (
            sum(a["pg_count_30d"] for a in active) / len(active)
            if active else 0
        )

        return {
            "rep_id":         rep_id,
            "rep_name":       rep_name,
            "acct_total":     len(my_accts),
            "active":         len(active),
            "priority":       len(priority),
            "at_risk":        len(at_risk),
            "lost":           len(lost),
            "sampled":        len(sampled),
            "revenue_30d":    round(rev30, 2),
            "revenue_90d":    round(rev90, 2),
            "avg_pg_per_acct_30d": round(avg_pg_count, 1),
            "acct_ids":       [a["customer_id"] for a in my_accts],
        }

    # Group accounts by kss_rep_id
    accts_by_kss_rep = defaultdict(list)
    for a in acct_records:
        if a["kss_rep_id"]:
            accts_by_kss_rep[a["kss_rep_id"]].append(a)

    kss_cards = []
    for rid, name in sorted(rep_name_map.items(), key=lambda x: x[1]):
        my_accts = accts_by_kss_rep.get(rid, [])
        kss_cards.append(rep_card(rid, name, my_accts))

    # ── 2CW REP CARDS ────────────────────────────────────────────────────────
    print("Computing 2CW rep cards...")

    twocw_reps = ["John", "Billy", "Mac", "Jonathan"]
    # Mac and Billy share accounts — each appears in both rep's card by design
    accts_by_twocw = defaultdict(list)
    for a in acct_records:
        if a["twocw_rep"]:
            accts_by_twocw[a["twocw_rep"]].append(a)

    twocw_cards = []
    for name in twocw_reps:
        my_accts = accts_by_twocw.get(name, [])
        twocw_cards.append(rep_card(f"2cw_{name.lower()}", name, my_accts))

    # ── ASSEMBLE OUTPUT ──────────────────────────────────────────────────────
    dashboard_data = {
        "ref_date":    today,
        "all_pgs":     all_pgs,
        "acct_records": acct_records,
        "kss":         kss_cards,
        "twocw":       twocw_cards,
    }

    save_json("dashboard_data.json", dashboard_data)

    # ── SUMMARY ──────────────────────────────────────────────────────────────
    print()
    print("=== TRANSFORM SUMMARY ===")
    print(f"  Product groups:  {len(all_pgs)}")
    print(f"  Accounts:        {len(acct_records)}")
    print(f"  KSS reps:        {len(kss_cards)}")
    print(f"  2CW reps:        {len(twocw_cards)}")
    print(f"  Sales rows:      {len(sales_rows)}")
    print(f"  30-day rows:     {len(rows_30d)}")
    print()
    print("Output → data/dashboard_data.json")


if __name__ == "__main__":
    transform()
