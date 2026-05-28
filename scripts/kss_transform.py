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
# Repo root is one level up from scripts/
   _REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
   DATA_DIR   = os.path.join(_REPO_ROOT, "data")
   CONFIG_DIR = os.path.join(_REPO_ROOT, "config")

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

def _parse_date(s: str):
    """Parse a date string to a date object. Returns None on failure."""
    for fmt in ("%Y-%m-%d", "%m/%d/%Y", "%Y/%m/%d"):
        try:
            return datetime.strptime(s, fmt).date()
        except Exception:
            pass
    return None


def transform():
    today_dt = date.today()
    today    = today_dt.isoformat()
    print(f"\n=== kss_transform.py  ref_date={today} ===\n")

    # ── Date windows ─────────────────────────────────────────────────────────
    # current:  last 30 days   (rev_now, units_now)
    # prior:    days 31–60     (rev_pri — "previous 30")
    # coverage: last 90 days   (pg_units, carried/missing)
    d30 = today_dt - timedelta(days=30)
    d60 = today_dt - timedelta(days=60)
    d90 = today_dt - timedelta(days=90)

    # ── Refresh taxonomy from DATAV ──────────────────────────────────────────
    fetch_datav()
    PG_LABELS_LIST = [pg for pg, *_ in PG_TABLE]   # ordered list of PG names

    # ── Load raw API data ────────────────────────────────────────────────────
    products_raw   = load_json("products.json")
    inventory_raw  = load_json("inventory.json")
    customers_raw  = load_json("customers.json")
    sales_reps_raw = load_json("sales_reps.json")
    invoices_raw   = load_json("invoices.json")
    txn_raw        = load_json("invoice_transactions.json")
    rep_assignments = load_rep_assignments()

    # ── Build rep name map: rep_id → full name ───────────────────────────────
    rep_name_map = {}
    for rep in sales_reps_raw:
        rid  = str(rep.get("id") or rep.get("rep_id") or "")
        name = rep.get("name") or rep.get("rep_name") or ""
        if rid:
            rep_name_map[rid] = name

    # ── Build product catalog: sku_id → parsed taxonomy ─────────────────────
    print("Building product catalog...")
    product_catalog = {}
    parse_failures  = []
    for p in products_raw:
        sku_id = str(p.get("id") or p.get("sku_id") or "")
        name   = p.get("name") or p.get("product_name") or ""
        parsed = parse_product_name(name)
        if parsed:
            product_catalog[sku_id] = {**parsed, "raw_name": name, "sku_id": sku_id}
        else:
            parse_failures.append(name)
    print(f"  Parsed: {len(product_catalog)}/{len(products_raw)}  "
          f"failures: {len(parse_failures)}")
    if parse_failures:
        print(f"  First failures: {parse_failures[:3]}")

    # ── Build inventory map: bsku → total units on hand ─────────────────────
    print("Building inventory snapshot...")
    inv_by_bsku = defaultdict(int)
    for row in inventory_raw:
        sku_id = str(row.get("sku_id") or row.get("product_id") or "")
        qty    = int(row.get("quantity") or row.get("inventory") or 0)
        bsku   = product_catalog.get(sku_id, {}).get("bsku")
        if bsku:
            inv_by_bsku[bsku] += qty

    # ── Build invoice index: invoice_id → metadata ───────────────────────────
    invoice_index = {}
    for inv in invoices_raw:
        inv_id = str(inv.get("id") or inv.get("invoice_id") or "")
        invoice_index[inv_id] = {
            "location":    inv.get("customer_name") or inv.get("location") or "",
            "date":        inv.get("invoice_date")  or inv.get("date") or "",
            "customer_id": str(inv.get("customer_id") or ""),
            "kss_rep_id":  str(inv.get("sales_rep_id") or inv.get("rep_id") or ""),
        }

    # ── Build enriched line items ─────────────────────────────────────────────
    print("Building line items...")
    sales_rows = []
    for txn in txn_raw:
        sku_id   = str(txn.get("sku_id")    or txn.get("product_id") or "")
        inv_id   = str(txn.get("invoice_id") or "")
        units    = int(float(txn.get("quantity") or txn.get("units") or 0))
        subtotal = float(txn.get("line_total") or txn.get("subtotal")
                         or txn.get("amount") or 0)
        is_credit = subtotal < 0 or (txn.get("category") or "").lower() == "credit"
        if is_credit:
            continue

        inv_meta = invoice_index.get(inv_id, {})
        tax      = product_catalog.get(sku_id, {})
        date_obj = _parse_date(inv_meta.get("date", ""))
        if date_obj is None:
            continue

        sales_rows.append({
            "date_obj":    date_obj,
            "customer_id": inv_meta.get("customer_id", ""),
            "location":    inv_meta.get("location", ""),
            "kss_rep_id":  inv_meta.get("kss_rep_id", ""),
            "invoice_id":  inv_id,
            "units":       units,
            "subtotal":    subtotal,
            "pg":          tax.get("pg", ""),
            "bsku":        tax.get("bsku", ""),
        })

    print(f"  Sales rows: {len(sales_rows)}")

    # ── Per-account aggregation ───────────────────────────────────────────────
    print("Aggregating account data...")

    acct_name       = {}              # cid → display name
    acct_kss_reps   = defaultdict(set)  # cid → set of kss_rep_ids with sales
    acct_rev_now    = defaultdict(float)  # 0–30 days
    acct_rev_pri    = defaultdict(float)  # 31–60 days
    acct_rev_all    = defaultdict(float)  # all time
    acct_units_now  = defaultdict(int)
    acct_pg_units   = defaultdict(lambda: defaultdict(int))  # cid → pg → units (90d)
    acct_inv_dates  = defaultdict(set)   # unique invoice dates (for cadence)
    acct_last_order = {}                 # cid → latest sale date_obj

    sales30_by_bsku = defaultdict(int)   # for all_pgs inventory report

    for r in sales_rows:
        cid = r["customer_id"]
        if not cid:
            continue

        d = r["date_obj"]
        acct_name[cid]       = r["location"]
        acct_rev_all[cid]   += r["subtotal"]
        acct_inv_dates[cid].add(d)

        # Last order date (sales only — not credits)
        if cid not in acct_last_order or d > acct_last_order[cid]:
            acct_last_order[cid] = d

        if r["kss_rep_id"]:
            acct_kss_reps[cid].add(r["kss_rep_id"])

        # Revenue windows
        if d >= d30:
            acct_rev_now[cid]   += r["subtotal"]
            acct_units_now[cid] += r["units"]
            if r["bsku"]:
                sales30_by_bsku[r["bsku"]] += r["units"]

        elif d >= d60:                  # strictly days 31–60
            acct_rev_pri[cid]   += r["subtotal"]

        # pg_units: 90-day coverage window
        if d >= d90 and r["pg"]:
            acct_pg_units[cid][r["pg"]] += r["units"]

    # All customer IDs (API list + anyone who has sales)
    all_cids = {str(c.get("id") or c.get("customer_id"))
                for c in customers_raw}
    all_cids |= set(acct_name.keys())

    # ── Network-level PG revenue rates (for upsell scoring) ─────────────────
    # Average 30-day revenue per active account per PG — used to score
    # how much revenue a missing PG could add to an account.
    pg_rev_30d = defaultdict(float)   # pg → total network rev in 30d
    pg_acct_count = defaultdict(int)  # pg → # distinct accounts buying in 30d
    for r in sales_rows:
        if r["date_obj"] >= d30 and r["pg"]:
            pg_rev_30d[r["pg"]] += r["subtotal"]
            pg_acct_count[r["pg"]] += 1

    pg_avg_rev = {}  # pg → avg rev per account per 30d
    for pg in PG_LABELS_LIST:
        n = pg_acct_count.get(pg, 0)
        pg_avg_rev[pg] = pg_rev_30d[pg] / n if n else 0

    # ── Build account records ─────────────────────────────────────────────────
    print("Building account records...")

    def acct_trend(rev_now, rev_pri, status):
        if rev_now == 0:
            return "lost"
        if rev_pri == 0:
            return "new"
        if rev_now > rev_pri:
            return "growing"
        if rev_now < rev_pri:
            return "shrinking"
        return "flat"

    def growth_pct(rev_now, rev_pri):
        if rev_pri == 0:
            return 100 if rev_now > 0 else 0
        return round((rev_now - rev_pri) / rev_pri * 100, 1)

    def reorder_cadence(dates_set):
        dates = sorted(d for d in dates_set if d)
        if len(dates) < 2:
            return None
        gaps = [g for g in
                ((dates[i+1] - dates[i]).days for i in range(len(dates)-1))
                if g > 0]
        return round(sum(gaps) / len(gaps), 1) if gaps else None

    acct_records = []
    acct_by_cid  = {}   # for rep lookups

    for cid in all_cids:
        name      = acct_name.get(cid, "")
        last      = acct_last_order.get(cid)
        days_since = (today_dt - last).days if last else None
        rev_all   = round(acct_rev_all.get(cid, 0), 2)
        rev_now   = round(acct_rev_now.get(cid, 0), 2)
        rev_pri   = round(acct_rev_pri.get(cid, 0), 2)
        status    = account_status(days_since, rev_all)

        # pg_units: every PG gets an entry (0 if not bought in 90d)
        pu = acct_pg_units.get(cid, {})
        pg_units  = {pg: pu.get(pg, 0) for pg in PG_LABELS_LIST}

        carried   = [pg for pg in PG_LABELS_LIST if pg_units[pg] > 0]
        missing   = [pg for pg in PG_LABELS_LIST if pg_units[pg] == 0]
        coverage  = len(carried)

        # Upsell score: sum of network avg revenue for missing PGs
        upsell_score = round(sum(pg_avg_rev.get(pg, 0) for pg in missing), 1)
        top_upsell   = sorted(missing, key=lambda pg: pg_avg_rev.get(pg, 0),
                              reverse=True)[:3]

        # KSS rep names (list)
        kss_rep_ids  = acct_kss_reps.get(cid, set())
        kss_rep_names = sorted(rep_name_map.get(rid, rid)
                               for rid in kss_rep_ids if rid)

        # 2CW rep (from config; may be multiple via comma-separated value)
        twocw_raw    = rep_assignments.get(name.lower(), "")
        twocw_reps_l = [t.strip() for t in twocw_raw.split(",")
                        if t.strip()] if twocw_raw else []

        rec = {
            "account":        name,
            "key":            name.lower(),
            "kss_reps":       kss_rep_names,
            "twocw_reps":     twocw_reps_l,
            "has_sales":      rev_all > 0,
            "is_sample_only": status == "Sampled",
            "rev_now":        rev_now,
            "rev_pri":        rev_pri,
            "rev_all":        rev_all,
            "units_now":      acct_units_now.get(cid, 0),
            "growth_pct":     growth_pct(rev_now, rev_pri),
            "trend":          acct_trend(rev_now, rev_pri, status),
            "status":         status.lower().replace(" ", "_"),
            "days_since":     days_since,
            "last_order":     last.isoformat() if last else None,
            "pg_units":       pg_units,
            "carried":        carried,
            "missing":        missing,
            "coverage":       coverage,
            "upsell_score":   upsell_score,
            "top_upsell":     top_upsell,
            "promos":         [],   # populated from NedCo promotions in future
            "reorder_cadence": reorder_cadence(acct_inv_dates.get(cid, set())),
            # Internal — used for rep card grouping, stripped from final output
            "_cid":           cid,
            "_kss_rep_ids":   list(kss_rep_ids),
            "_twocw_reps":    twocw_reps_l,
        }
        acct_records.append(rec)
        acct_by_cid[cid] = rec

    # ── Product group aggregates (for inventory section) ─────────────────────
    print("Computing product group aggregates...")
    inv_pg_data = []
    for pg, bsku, brand, cat, sub, wu in PG_TABLE:
        inv    = inv_by_bsku.get(bsku, 0)
        past30 = sales30_by_bsku.get(bsku, 0)
        dos    = round(inv / (past30 / 30), 1) if past30 > 0 else None
        inv_pg_data.append({
            "pg":              pg,
            "bsku":            bsku,
            "bsku_concat":     BSKU_CONCAT.get(bsku, ""),
            "brand":           brand,
            "category":        cat,
            "subcategory":     sub,
            "weight_unit":     wu,
            "units_per_pound": UPP_BY_WU.get(wu),
            "inventory":       inv,
            "past_30":         past30,
            "days_of_supply":  dos,
        })

    # ── Rep card builder ──────────────────────────────────────────────────────

    def build_rep_card(rep_name: str, my_accts: list) -> dict:
        """
        Build a fully dashboard-ready rep card from a list of account records.
        """
        non_sampled = [a for a in my_accts if not a["is_sample_only"]]
        active   = [a for a in non_sampled if a["status"] == "active"]
        priority = [a for a in non_sampled if a["status"] == "priority"]
        at_risk  = [a for a in non_sampled if a["status"] == "at_risk"]
        lost     = [a for a in non_sampled if a["status"] == "lost"]
        sampled  = [a for a in my_accts   if a["is_sample_only"]]

        growing   = [a for a in non_sampled if a["trend"] == "growing"]
        shrinking = [a for a in non_sampled if a["trend"] == "shrinking"]

        total_rev     = round(sum(a["rev_now"] for a in my_accts), 2)
        total_rev_pri = round(sum(a["rev_pri"] for a in my_accts), 2)
        total_rev_all = round(sum(a["rev_all"] for a in my_accts), 2)
        rev_growth    = growth_pct(total_rev, total_rev_pri)

        avg_coverage  = (
            round(sum(a["coverage"] for a in active) / len(active), 2)
            if active else 0.0
        )

        # Action items: top 5 non-sampled accounts by upsell_score
        action_candidates = sorted(
            [a for a in non_sampled if a["missing"]],
            key=lambda a: a["upsell_score"],
            reverse=True
        )[:5]
        action_items = [{
            "account":     a["account"],
            "rev_now":     a["rev_now"],
            "missing":     a["missing"],
            "upsell_score": a["upsell_score"],
            "trend":       a["trend"],
            "status":      a["status"],
            "promos":      a["promos"],
        } for a in action_candidates]

        # Sampled followups: sampled accounts sorted by days_since (oldest first)
        sampled_followups = sorted(
            sampled, key=lambda a: a["days_since"] or 9999, reverse=True
        )[:10]
        sampled_followups = [{
            "account":    a["account"],
            "rev_all":    a["rev_all"],
            "days_since": a["days_since"],
            "last_order": a["last_order"],
            "kss_reps":   a["kss_reps"],
            "twocw_reps": a["twocw_reps"],
            "promos":     a["promos"],
        } for a in sampled_followups]

        account_keys = [a["key"] for a in my_accts]

        return {
            "rep":             rep_name,
            "total_rev":       total_rev,
            "total_rev_pri":   total_rev_pri,
            "total_rev_all":   total_rev_all,
            "rev_growth":      rev_growth,
            "n_accounts":      len(non_sampled),
            "active":          len(active),
            "priority":        len(priority),
            "at_risk":         len(at_risk),
            "lost":            len(lost),
            "n_sampled":       len(sampled),
            "growing":         len(growing),
            "shrinking":       len(shrinking),
            "avg_coverage":    avg_coverage,
            "action_items":    action_items,
            "sampled_followups": sampled_followups,
            "account_keys":    account_keys,
            # _n_* normalized fields added after all cards are built
        }

    def normalize_rep_cards(cards: list) -> list:
        """
        Add _n_* normalized fields (0–1 across all cards) and
        compute composite_score + rank.
        Weights: total_rev 25, rev_growth 20, avg_coverage 15,
                 active_pct 20, growing_pct 15, lost_pct(inv) 5
        """
        def safe_norm(values):
            lo, hi = min(values), max(values)
            if hi == lo:
                return [1.0] * len(values)
            return [(v - lo) / (hi - lo) for v in values]

        def pct(num, den):
            return num / den if den else 0

        metrics = {
            "total_rev":   [c["total_rev"]   for c in cards],
            "rev_growth":  [max(c["rev_growth"], -100) for c in cards],
            "avg_coverage": [c["avg_coverage"] for c in cards],
            "active_pct":  [pct(c["active"],  c["n_accounts"]) for c in cards],
            "growing_pct": [pct(c["growing"], max(c["n_accounts"], 1)) for c in cards],
            "lost_pct":    [pct(c["lost"],    max(c["n_accounts"], 1)) for c in cards],
        }
        weights = {
            "total_rev": 25, "rev_growth": 20, "avg_coverage": 15,
            "active_pct": 20, "growing_pct": 15, "lost_pct": 5,
        }
        total_w = sum(weights.values())

        normed = {k: safe_norm(v) for k, v in metrics.items()}

        for i, card in enumerate(cards):
            card["_n_total_rev"]    = round(normed["total_rev"][i],    4)
            card["_n_rev_growth"]   = round(normed["rev_growth"][i],   4)
            card["_n_avg_coverage"] = round(normed["avg_coverage"][i], 4)
            card["_n_active"]       = round(normed["active_pct"][i],   4)
            card["_n_growing"]      = round(normed["growing_pct"][i],  4)
            # lost is inverted: fewer lost = better score
            card["_n_lost"]         = round(1 - normed["lost_pct"][i], 4)

            score = (
                card["_n_total_rev"]    * weights["total_rev"]    +
                card["_n_rev_growth"]   * weights["rev_growth"]   +
                card["_n_avg_coverage"] * weights["avg_coverage"] +
                card["_n_active"]       * weights["active_pct"]   +
                card["_n_growing"]      * weights["growing_pct"]  +
                card["_n_lost"]         * weights["lost_pct"]
            ) / total_w * 100
            card["composite_score"] = round(score, 1)

        # Rank by composite_score descending
        ranked = sorted(enumerate(cards), key=lambda x: x[1]["composite_score"],
                        reverse=True)
        for rank, (i, _) in enumerate(ranked, 1):
            cards[i]["rank"] = rank

        return cards

    # ── KSS rep cards ─────────────────────────────────────────────────────────
    print("Computing KSS rep cards...")

    # Group accounts by each KSS rep ID they're associated with
    accts_by_kss = defaultdict(list)
    for a in acct_records:
        for rid in a["_kss_rep_ids"]:
            accts_by_kss[rid].append(a)

    kss_cards = []
    for rid, name in sorted(rep_name_map.items(), key=lambda x: x[1]):
        kss_cards.append(build_rep_card(name, accts_by_kss.get(rid, [])))

    if len(kss_cards) > 1:
        normalize_rep_cards(kss_cards)

    # ── 2CW rep cards ─────────────────────────────────────────────────────────
    print("Computing 2CW rep cards...")

    TWOCW_REPS = ["John", "Billy", "Mac", "Jonathan"]
    accts_by_twocw = defaultdict(list)
    for a in acct_records:
        for rep in a["_twocw_reps"]:
            accts_by_twocw[rep].append(a)

    twocw_cards = []
    for name in TWOCW_REPS:
        twocw_cards.append(build_rep_card(name, accts_by_twocw.get(name, [])))

    if len(twocw_cards) > 1:
        normalize_rep_cards(twocw_cards)

    # ── Strip internal fields from account records before output ─────────────
    output_fields_to_strip = {"_cid", "_kss_rep_ids", "_twocw_reps",
                               "carried", "missing", "reorder_cadence"}
    clean_acct_records = [
        {k: v for k, v in a.items() if k not in output_fields_to_strip}
        for a in acct_records
    ]

    # ── Assemble and write output files ───────────────────────────────────────
    print("Writing output files...")

    # Dashboard JSON files — RAW format exactly as the HTML dashboards expect
    kss_dashboard = {
        "ref_date":    today,
        "all_pgs":     PG_LABELS_LIST,      # list of label strings
        "kss":         kss_cards,
        "acct_records": clean_acct_records,
    }
    twocw_dashboard = {
        "ref_date":    today,
        "all_pgs":     PG_LABELS_LIST,
        "twocw":       twocw_cards,
        "acct_records": clean_acct_records,
    }

    # Inventory data — richer object for production planning tools
    inventory_data = {
        "ref_date": today,
        "product_groups": inv_pg_data,
    }

    save_json("kss_dashboard.json",   kss_dashboard)
    save_json("twocw_dashboard.json", twocw_dashboard)
    save_json("inventory_data.json",  inventory_data)

    # ── Summary ───────────────────────────────────────────────────────────────
    print()
    print("=== TRANSFORM SUMMARY ===")
    print(f"  Sales rows:      {len(sales_rows)}")
    print(f"  Accounts:        {len(acct_records)}")
    print(f"  Product groups:  {len(PG_LABELS_LIST)}")
    print(f"  KSS reps:        {len(kss_cards)}")
    print(f"  2CW reps:        {len(twocw_cards)}")
    print(f"  Output files:    kss_dashboard.json, twocw_dashboard.json, inventory_data.json")


if __name__ == "__main__":
    transform()
