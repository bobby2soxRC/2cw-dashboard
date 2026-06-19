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
  MDO = Mendo

Category codes (digits 4-5):
  01 = Flower
  02 = Preroll
  03 = Concentrate
  04 = Vape
  05 = Indoor Flower  (Mendo premium tier)

Subcategory codes (digits 6-7):
  SRF:  01=Bigs, 07=Single, 10=28pk, 03=Live Rosin Jar
  HWR:  02=Smalls, 04=Live Resin Jar, 06=Live Resin AIO
  MDO:  01=Bigs, 09=Multipack, 11=10pk, 06=Live Resin AIO

Size codes (digits 8-9):
  01 = 1g
  02 = 3.5g
  04 = 14g
  05 = 28g
  06 = 5g
  07 = 10ct

16 PRODUCT GROUPS → BSKU MAP:
  SRF Flower 1g          → SRF010101   Soma Rosa Farms / Flower / Bigs / 1g
  SRF Flower 8th         → SRF010102   Soma Rosa Farms / Flower / Bigs / 3.5g
  SRF Flower 14g         → SRF010104   Soma Rosa Farms / Flower / Bigs / 14g
  SRF Flower Oz          → SRF010105   Soma Rosa Farms / Flower / Bigs / 28g
  SRF Preroll 1g         → SRF020701   Soma Rosa Farms / Preroll / Single / 1g
  SRF Preroll 28pk       → SRF021004   Soma Rosa Farms / Preroll / 28pk / 14g
  SRF Live Rosin Jar     → SRF030301   Soma Rosa Farms / Concentrate / Live Rosin Jar / 1g
  HWR Smalls 8th         → HWR010202   Howie Roll / Flower / Smalls / 3.5g
  HWR Smalls 14g         → HWR010204   Howie Roll / Flower / Smalls / 14g
  HWR Live Resin Jar     → HWR030401   Howie Roll / Concentrate / Live Resin Jar / 1g
  HWR Live Resin AIO     → HWR040601   Howie Roll / Vape / Live Resin AIO / 1g
  MDO Flower 1g          → MDO010101   Mendo / Flower / Bigs / 1g
  MDO Flower 8th         → MDO010102   Mendo / Flower / Bigs / 3.5g
  MDO Flower 14g         → MDO010104   Mendo / Flower / Bigs / 14g
  MDO Indoor Flower 8th  → MDO050102   Mendo / Indoor Flower / Bigs / 3.5g
  MDO Live Resin AIO     → MDO040601   Mendo / Vape / Live Resin AIO / 1g
  MDO Preroll 10ct       → MDO020906   Mendo / Preroll / Multipack / 10ct
  MDO Preroll 10pk       → MDO021107   Mendo / Preroll / 10pk / 5g

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
    # Mendo
    "MDO010101": "MDO Flower 1g",
    "MDO010102": "MDO Flower 8th",
    "MDO010104": "MDO Flower 14g",
    "MDO050102": "MDO Indoor Flower 8th",
    "MDO040601": "MDO Live Resin AIO",
    "MDO021107": "MDO Preroll 10pk",
}

# Hardcoded fallback used when DATAV fetch fails
_FALLBACK_PG_TABLE = [
    ("SRF Flower 1g",         "SRF010101", "Soma Rosa Farms", "Flower",      "Bigs",           "1g"  ),
    ("SRF Flower 8th",        "SRF010102", "Soma Rosa Farms", "Flower",      "Bigs",           "3.5g"),
    ("SRF Flower 14g",        "SRF010104", "Soma Rosa Farms", "Flower",      "Bigs",           "14g" ),
    ("SRF Flower Oz",         "SRF010105", "Soma Rosa Farms", "Flower",      "Bigs",           "28g" ),
    ("SRF Preroll 1g",        "SRF020701", "Soma Rosa Farms", "Preroll",     "Single",         "1g"  ),
    ("SRF Preroll 28pk",      "SRF021004", "Soma Rosa Farms", "Preroll",     "28pk",           "14g" ),
    ("SRF Live Rosin Jar",    "SRF030301", "Soma Rosa Farms", "Concentrate", "Live Rosin Jar", "1g"  ),
    ("HWR Smalls 8th",        "HWR010202", "Howie Roll",      "Flower",      "Smalls",         "3.5g"),
    ("HWR Smalls 14g",        "HWR010204", "Howie Roll",      "Flower",      "Smalls",         "14g" ),
    ("HWR Preroll 6pk",       "HWR020802", "Howie Roll",      "Preroll",     "6pk",            "3.5g"),
    ("HWR Preroll 28pk",      "HWR021004", "Howie Roll",      "Preroll",     "28pk",           "14g" ),
    ("HWR Live Resin Jar",    "HWR030401", "Howie Roll",      "Concentrate", "Live Resin Jar", "1g"  ),
    ("HWR Live Resin AIO",    "HWR040601", "Howie Roll",      "Vape",        "Live Resin AIO", "1g"  ),
    # Mendo — 6 BSKUs confirmed from NedCo inventory
    ("MDO Flower 1g",         "MDO010101", "Mendo", "Flower",         "Bigs",           "1g"  ),
    ("MDO Flower 8th",        "MDO010102", "Mendo", "Flower",         "Bigs",           "3.5g"),
    ("MDO Flower 14g",        "MDO010104", "Mendo", "Flower",         "Bigs",           "14g" ),
    ("MDO Indoor Flower 8th", "MDO050102", "Mendo", "Indoor Flower",  "Bigs",           "3.5g"),
    ("MDO Live Resin AIO",    "MDO040601", "Mendo", "Vape",           "Live Resin AIO", "1g"  ),
    ("MDO Preroll 10pk",      "MDO021107", "Mendo", "Preroll",        "10pk",           "5g"  ),
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
    # ── Howie Roll ────────────────────────────────────────────────────────────
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

    # ── Soma Rosa ─────────────────────────────────────────────────────────────
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

    # ── Mendo ─────────────────────────────────────────────────────────────────
    # Mendo Indoor Flower 3.5g  (distinct premium tier — must come before plain Flower)
    # e.g. "Mendo Indoor Flower 3.5g Indica Animal Mints"
    (r"\bmendo\b.*indoor\s+flower",
        "Mendo", "Indoor Flower", "Bigs", None),

    # Mendo Vape AIO
    # e.g. "Mendo Live Resin AIO 1g Indica Chem Z"
    (r"\bmendo\b.*(?:all-in-one|aio|live resin.*(?:cart|vape))",
        "Mendo", "Vape", "Live Resin AIO", None),

    # Mendo Preroll 10pk — covers both 10pk and 10ct multipack formats
    # e.g. "Mendo Preroll 5g Indica Rose Petal 10pk"
    #      "Mendo Preroll Indica Blueberry Runtz 10ct"
    (r"\bmendo\b.*(?:preroll|pre-roll)",
        "Mendo", "Preroll", "10pk", "5g"),

    # Mendo Flower (plain — 1g, 3.5g, 14g)
    # e.g. "Mendo Indoor Flower 3.5g Indica Hard Candy"  ← already caught above
    #      "Mendo Flower 14g Hybrid Georgia Pie"
    (r"\bmendo\b.*flower",
        "Mendo", "Flower", "Bigs", None),
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
# 2CW REP ASSIGNMENTS
# Primary: live fetch from published Google Sheet (updates automatically when
#          the sheet is updated — no code deploy needed)
# Fallback: config/rep_assignments.json (static snapshot in repo)
# ─────────────────────────────────────────────────────────────────────────────

# Published Master Account List — Soma Rep assignments tab
REP_ASSIGNMENTS_URL = (
    "https://docs.google.com/spreadsheets/d/e/"
    "2PACX-1vTvUb2y2US1Qcyf12mngWEcvdCU3Yh9vgIzN_5-6x1psQRCIkG9Y4velrdcBB9zEw"
    "/pub?gid=898944212&single=true&output=csv"
)

# Full name → short name used in dashboard
_SOMA_REP_MAP = {
    "billy cornish":              "Billy",
    "billy cornish/mac jorgensen": None,   # shared — handled below
    "john donham":                "John",
    "jonathan castorena":         "Jonathan",
    "mac jorgensen":              "Mac",
}

def _fix_account_name(s: str) -> str:
    """Fix Google Sheets artifact where rep names bleed into account names."""
    import re
    s = re.sub(r"^\d+\s+", "", s).strip()   # strip leading customer number
    s = s.replace("Mac Jorgenseny", "macy")  # Farmacy / Pharmacy fix
    s = s.replace("Mac Jorgensen", "mac")
    return s

def load_rep_assignments() -> dict:
    """
    Returns dict: account_name_lower → comma-separated rep string
    e.g. {"stiiizy - los angeles": "John", "off the charts - bell gardens": "Billy,Mac"}
    Fetches live from Google Sheets; falls back to config/rep_assignments.json.
    """
    print("  Fetching rep assignments from Google Sheets...", end=" ")
    try:
        req = urllib.request.Request(
            REP_ASSIGNMENTS_URL,
            headers={"User-Agent": "Mozilla/5.0 (kss_transform)"}
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            content = resp.read().decode("utf-8")

        rows = list(csv.DictReader(io.StringIO(content)))
        assignments = {}

        for r in rows:
            soma_rep_raw = (r.get("Soma Rep") or "").strip().lower()
            if not soma_rep_raw:
                continue

            raw_name = (r.get("Customer Num & Company") or "").strip()
            name = _fix_account_name(raw_name).lower()
            if not name:
                continue

            # Shared Billy/Mac accounts
            if soma_rep_raw == "billy cornish/mac jorgensen":
                reps = ["Billy", "Mac"]
            else:
                rep = _SOMA_REP_MAP.get(soma_rep_raw)
                reps = [rep] if rep else []

            if not reps:
                continue

            if name in assignments:
                existing = assignments[name].split(",")
                for rep in reps:
                    if rep not in existing:
                        existing.append(rep)
                assignments[name] = ",".join(existing)
            else:
                assignments[name] = ",".join(reps)

        if not assignments:
            raise ValueError("No assignments parsed from sheet")

        print(f"{len(assignments)} accounts loaded.")
        return assignments

    except Exception as exc:
        print(f"\n  [WARN] Rep assignment fetch failed: {exc} — trying local file.")

    # Fallback: static JSON file
    path = os.path.join(CONFIG_DIR, "rep_assignments.json")
    if os.path.exists(path):
        with open(path) as f:
            data = json.load(f)
        print(f"  [FALLBACK] Loaded {len(data)} assignments from config/rep_assignments.json")
        return {k.lower(): v for k, v in data.items()}

    print("  [WARN] No rep assignments found — 2CW rep field will be blank")
    return {}


# ─────────────────────────────────────────────────────────────────────────────
# MAIN TRANSFORM
# ─────────────────────────────────────────────────────────────────────────────

def _parse_date(s: str):
    """Parse a date string to a date object. Returns None on failure.
    Handles KSS API ISO datetime format: '2026-06-22T00:00:00.000Z'
    """
    if not s:
        return None
    # Strip ISO datetime suffix: '2026-06-22T00:00:00.000Z' → '2026-06-22'
    if 'T' in s:
        s = s.split('T')[0]
    for fmt in ("%Y-%m-%d", "%m/%d/%Y", "%Y/%m/%d"):
        try:
            return datetime.strptime(s, fmt).date()
        except Exception:
            pass
    return None


def _commission_periods(today_dt: date) -> tuple:
    """
    Return (mo_periods, bw_periods) for the last 6 complete calendar months.
    Each mo_period: {id, label, volKey, newKey, hint, mo}
    Each bw_period: {id, label, bwKey, newKey, hint, mo, half}
    """
    import calendar as cal_mod
    months = []
    y, m = today_dt.year, today_dt.month
    for _ in range(6):
        m -= 1
        if m == 0:
            m = 12
            y -= 1
        months.insert(0, date(y, m, 1))

    mo_periods = []
    bw_periods = []
    for mo in months:
        mo_id  = mo.strftime("%b").lower()
        mm     = mo.strftime("%m")
        last_d = cal_mod.monthrange(mo.year, mo.month)[1]
        yr     = mo.year

        mo_periods.append({
            "id":     mo_id,
            "label":  mo.strftime("%b %Y"),
            "volKey": f"vol_{mo_id}",
            "newKey": f"new_in_{mo_id}",
            "hint":   mo.strftime("%B %Y"),
            "mo":     mo_id,
            "_date":  mo,
        })
        for half, day_range in [("A", f"1–15"), ("B", f"16–{last_d}")]:
            bw_periods.append({
                "id":     f"{mm}{half}",
                "label":  f"{mo.strftime('%b')} {day_range}",
                "bwKey":  f"{yr}-{mm}{half}",
                "newKey": f"new_in_{mo_id}",
                "hint":   f"{mo.strftime('%b')} {day_range}, {yr}",
                "mo":     mo_id,
                "half":   half,
                "_date":  mo,
            })
    return mo_periods, bw_periods


def compute_commission_data(sales_rows: list, customer_name_map: dict,
                             kss_rep_map: dict, rep_assignments: dict,
                             today_dt: date) -> dict:
    """
    Compute MONTHLY_DATA, BW_DATA, INV_LISTS for the last 6 complete months.
    Returns dict ready to write as commission_data.json.
    """
    mo_periods, bw_periods = _commission_periods(today_dt)
    if not mo_periods:
        return {}

    earliest_mo = mo_periods[0]["_date"]

    # Commission rates per rep key
    COMM_RATES = {
        "billy":    {"base": 0.015, "new": 0.03},
        "mac":      {"base": 0.015, "new": 0.015},
        "john":     {"base": 0.015, "new": 0.03},
        "jonathan": {"base": 0.01,  "new": 0.01},
    }

    # Build per-customer monthly revenue for all history (new door lookback)
    all_mo_rev: dict = defaultdict(lambda: defaultdict(float))
    # cid → (year,month) → revenue

    cust_monthly:     dict = defaultdict(lambda: defaultdict(float))  # cid→mo_id→rev
    cust_bw:          dict = defaultdict(lambda: defaultdict(float))  # cid→bw_id→rev
    cust_inv_monthly: dict = defaultdict(lambda: defaultdict(set))    # cid→mo_id→{nums}
    cust_inv_bw:      dict = defaultdict(lambda: defaultdict(set))    # cid→bw_id→{nums}

    # Build lookup: mo_id → date object
    mo_date_map = {p["id"]: p["_date"] for p in mo_periods}
    # Lookup: (year, month) → mo_id  (for commission window months only)
    ym_to_mo_id = {(p["_date"].year, p["_date"].month): p["id"] for p in mo_periods}
    # Lookup: (year, month, half) → bw_id
    ym_half_to_bw = {
        (p["_date"].year, p["_date"].month, p["half"]): p["id"]
        for p in bw_periods
    }

    for r in sales_rows:
        cid = r["customer_id"]
        d   = r["date_obj"]
        if not cid or d is None:
            continue

        rev     = r["subtotal"]
        inv_num = r.get("invoice_num", "")

        all_mo_rev[cid][(d.year, d.month)] += rev

        mo_id = ym_to_mo_id.get((d.year, d.month))
        if mo_id:
            cust_monthly[cid][mo_id] += rev
            if inv_num:
                cust_inv_monthly[cid][mo_id].add(inv_num)
            half  = "A" if d.day <= 15 else "B"
            bw_id = ym_half_to_bw.get((d.year, d.month, half))
            if bw_id:
                cust_bw[cid][bw_id] += rev
                if inv_num:
                    cust_inv_bw[cid][bw_id].add(inv_num)

    def had_prior_revenue(cid: str, mo_date: date, lookback: int = 6) -> bool:
        """True if account had ≥$50 revenue in any of the N months before mo_date."""
        y, m = mo_date.year, mo_date.month
        for _ in range(lookback):
            m -= 1
            if m == 0:
                m = 12
                y -= 1
            if all_mo_rev[cid].get((y, m), 0) >= 50:
                return True
        return False

    # Collect all active customer_ids
    active_cids = {cid for cid, mo_data in cust_monthly.items()
                   if any(v > 0 for v in mo_data.values())}

    monthly_data = []
    seen_pairs   = set()

    for cid in sorted(active_cids):
        account_name = customer_name_map.get(cid, "")
        if not account_name:
            continue

        kss_rep_name   = kss_rep_map.get(cid, "")
        twocw_reps_str = rep_assignments.get(account_name.lower(), "")
        twocw_reps     = ([t.strip() for t in twocw_reps_str.split(",") if t.strip()]
                          if twocw_reps_str else [])
        if not twocw_reps:
            continue

        for twocw_rep in twocw_reps:
            rep_key = twocw_rep.lower()
            pair    = (account_name, rep_key)
            if pair in seen_pairs:
                continue
            seen_pairs.add(pair)

            rates  = COMM_RATES.get(rep_key, {"base": 0.015, "new": 0.015})
            record = {"account": account_name, "kss_rep": kss_rep_name, "rep": rep_key}

            for mp in mo_periods:
                mo_id   = mp["id"]
                mo_date = mp["_date"]
                vol     = round(cust_monthly[cid].get(mo_id, 0), 2)
                is_new  = vol >= 50 and not had_prior_revenue(cid, mo_date)
                rate    = rates["new"] if is_new else rates["base"]
                comm    = round(vol * rate, 2) if vol >= 50 else 0.0
                record[f"vol_{mo_id}"]   = vol
                record[f"new_in_{mo_id}"] = is_new
                record[f"comm_{mo_id}"]  = comm

            monthly_data.append(record)

    # BW_DATA
    bw_data: dict = {}
    for cid in active_cids:
        name = customer_name_map.get(cid, "")
        if not name:
            continue
        bw_data[name] = {bp["id"]: round(cust_bw[cid].get(bp["id"], 0), 2)
                         for bp in bw_periods}

    # INV_LISTS
    inv_lists: dict = {"m": {}, "bw": {}}
    for cid in active_cids:
        name = customer_name_map.get(cid, "")
        if not name:
            continue
        inv_lists["m"][name]  = {mp["id"]: sorted(cust_inv_monthly[cid].get(mp["id"], set()))
                                  for mp in mo_periods}
        inv_lists["bw"][name] = {bp["id"]: sorted(cust_inv_bw[cid].get(bp["id"], set()))
                                  for bp in bw_periods}

    # Strip internal _date from periods before output
    def clean(p):
        return {k: v for k, v in p.items() if k != "_date"}

    return {
        "mo_periods":   [clean(p) for p in mo_periods],
        "bw_periods":   [clean(p) for p in bw_periods],
        "monthly_data": monthly_data,
        "bw_data":      bw_data,
        "inv_lists":    inv_lists,
    }


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
    PG_LABELS_LIST = [pg for pg, *_ in PG_TABLE]

    # ── Load raw API data ────────────────────────────────────────────────────
    products_raw    = load_json("products.json")
    inventory_raw   = load_json("inventory.json")
    customers_raw   = load_json("customers.json")
    sales_reps_raw  = load_json("sales_reps.json")
    invoices_raw    = load_json("invoices.json")
    txn_raw         = load_json("invoice_transactions.json")
    rep_assignments = load_rep_assignments()

    # ── Build rep name map AND customer→KSS rep from sales_reps.Customers ────
    # KSS API: sales_reps[n].UserID, .Name, .Customers[{CustomerID,CustomerName}]
    rep_name_map  = {}   # str(UserID) → Name
    customer_kss_rep = {}  # str(CustomerID) → rep Name
    for rep in sales_reps_raw:
        rid  = str(rep.get("UserID") or "")
        name = rep.get("Name") or ""
        if rid:
            rep_name_map[rid] = name
        for cust in rep.get("Customers") or []:
            cid = str(cust.get("CustomerID") or "")
            if cid:
                customer_kss_rep[cid] = name

    # ── Build product catalog: ProductID → parsed taxonomy ───────────────────
    # KSS API: products[n].ProductID, .ProductName
    print("Building product catalog...")
    product_catalog = {}
    parse_failures  = []
    for p in products_raw:
        sku_id = str(p.get("ProductID") or "")
        name   = p.get("ProductName") or ""
        if not sku_id:
            continue
        parsed = parse_product_name(name)
        if parsed:
            product_catalog[sku_id] = {**parsed, "raw_name": name, "sku_id": sku_id}
        else:
            parse_failures.append(name)
    print(f"  Parsed: {len(product_catalog)}/{len(products_raw)}  "
          f"failures: {len(parse_failures)}")
    if parse_failures:
        print(f"  First failures: {parse_failures[:3]}")

    # ── BSKU consolidation remap ─────────────────────────────────────────────
    # Maps legacy/duplicate BSKUs → canonical BSKU.
    # Applied to product_catalog so both inventory and sales rows roll up
    # correctly into the canonical product group.
    # Add entries here whenever NedCo has old SKUs that should merge into a
    # newer canonical product group.
    BSKU_REMAP = {
        "MDO020906": "MDO021107",   # Mendo Preroll 10ct Multipack → 10pk 5g
    }
    for sku_data in product_catalog.values():
        raw_bsku = sku_data.get("bsku", "")
        if raw_bsku in BSKU_REMAP:
            sku_data["bsku"] = BSKU_REMAP[raw_bsku]
            sku_data["pg"]   = PG_LABELS.get(BSKU_REMAP[raw_bsku], sku_data.get("pg", ""))

    # ── Build inventory map: bsku → total units on hand ─────────────────────
    # KSS API: inventory[n].ProductID, .OnFloorInventory, .LocationID
    #   Using OnFloorInventory (physical stock) rather than AvailableUnits,
    #   since AvailableUnits = OnFloorInventory - PreSales - Allocated, which
    #   undercounts physical stock for production-planning purposes.
    #   LocationID 1 = Van Nuys, LocationID 3 = Alameda  (confirmed manually)
    print("Building inventory snapshot...")
    inv_by_bsku = defaultdict(int)
    LOC_VN = 1
    LOC_AL = 3

    # ASKU-level inventory: (bsku, type, flavor) → {inv_vn, inv_al}
    inv_by_asku: dict = defaultdict(lambda: {"inv_vn": 0, "inv_al": 0})
    for row in inventory_raw:
        sku_id = str(row.get("ProductID") or "")
        qty    = int(float(row.get("OnFloorInventory") or 0))
        loc    = row.get("LocationID")
        cat    = product_catalog.get(sku_id, {})
        bsku   = cat.get("bsku")
        if bsku:
            inv_by_bsku[bsku] += qty
            type_    = cat.get("type") or "Hybrid"
            flavor   = cat.get("flavor") or ""
            asku_key = (bsku, type_, flavor)
            if loc == LOC_VN:
                inv_by_asku[asku_key]["inv_vn"] += qty
            elif loc == LOC_AL:
                inv_by_asku[asku_key]["inv_al"] += qty
            else:
                # Unknown location — still count toward total via inv_vn
                # so units aren't silently dropped.
                inv_by_asku[asku_key]["inv_vn"] += qty

    # ── Build invoice index: InvoiceID → metadata ────────────────────────────
    # KSS API: invoices[n].InvoiceID, .CustomerID, .CustomerName, .Date,
    #          .InvoiceNum, .Status (4=credit/return)
    invoice_index = {}
    for inv in invoices_raw:
        inv_id = str(inv.get("InvoiceID") or "")
        if not inv_id:
            continue
        invoice_index[inv_id] = {
            "location":    inv.get("CustomerName") or "",
            "date":        inv.get("Date") or "",
            "customer_id": str(inv.get("CustomerID") or ""),
            "invoice_num": inv.get("InvoiceNum") or "",
            "status":      int(inv.get("Status") or 0),
        }

    # ── Build enriched line items ─────────────────────────────────────────────
    # KSS API: txn[n].ProductID, .InvoiceID, .NumUnits, .ExtPrice, .SupplierID
    # Credits: invoice Status==4 (return) or negative ExtPrice
    print("Building line items...")
    sales_rows = []
    for txn in txn_raw:
        sku_id   = str(txn.get("ProductID") or "")
        inv_id   = str(txn.get("InvoiceID") or "")
        units    = int(float(txn.get("NumUnits") or 0))
        subtotal = float(txn.get("ExtPrice") or 0)

        inv_meta  = invoice_index.get(inv_id, {})
        is_credit = inv_meta.get("status") == 4 or subtotal < 0
        if is_credit:
            continue

        tax      = product_catalog.get(sku_id, {})
        date_obj = _parse_date(inv_meta.get("date", ""))
        if date_obj is None:
            continue

        cid = inv_meta.get("customer_id", "")
        sales_rows.append({
            "date_obj":    date_obj,
            "customer_id": cid,
            "location":    inv_meta.get("location", ""),
            "kss_rep":     customer_kss_rep.get(cid, ""),
            "invoice_id":  inv_id,
            "invoice_num": inv_meta.get("invoice_num", ""),
            "units":       units,
            "subtotal":    subtotal,
            "pg":          tax.get("pg", ""),
            "bsku":        tax.get("bsku", ""),
            "type":        tax.get("type", ""),
            "flavor":      tax.get("flavor", ""),
        })

    print(f"  Sales rows: {len(sales_rows)}")

    # ── Per-account aggregation ───────────────────────────────────────────────
    print("Aggregating account data...")

    acct_name       = {}
    acct_rev_now    = defaultdict(float)
    acct_rev_pri    = defaultdict(float)
    acct_rev_all    = defaultdict(float)
    acct_units_now  = defaultdict(int)
    acct_pg_units   = defaultdict(lambda: defaultdict(int))
    acct_inv_dates  = defaultdict(set)
    acct_last_order = {}
    sales30_by_bsku = defaultdict(int)
    sales30_by_asku = defaultdict(int)
    sales90_by_bsku = defaultdict(int)

    for r in sales_rows:
        cid = r["customer_id"]
        if not cid:
            continue

        d = r["date_obj"]
        acct_name[cid]     = r["location"]
        acct_rev_all[cid] += r["subtotal"]
        acct_inv_dates[cid].add(d)

        if cid not in acct_last_order or d > acct_last_order[cid]:
            acct_last_order[cid] = d

        if d >= d30:
            acct_rev_now[cid]   += r["subtotal"]
            acct_units_now[cid] += r["units"]
            if r["bsku"]:
                sales30_by_bsku[r["bsku"]] += r["units"]
                asku_key = (r["bsku"], r["type"] or "Hybrid", r["flavor"] or "")
                sales30_by_asku[asku_key] += r["units"]
        elif d >= d60:
            acct_rev_pri[cid]   += r["subtotal"]

        if d >= d90 and r["pg"]:
            acct_pg_units[cid][r["pg"]] += r["units"]

        if d >= d90 and r["bsku"]:
            sales90_by_bsku[r["bsku"]] += r["units"]

    # Also capture names from customers.json
    # KSS API: customers[n].CustomerID, .CustomerName
    customer_name_map = {}  # str(CustomerID) → CustomerName
    all_cids = set()
    for c in customers_raw:
        cid  = str(c.get("CustomerID") or c.get("id") or "")
        name = c.get("CustomerName") or c.get("name") or ""
        if cid:
            customer_name_map[cid] = name
            all_cids.add(cid)
    all_cids |= set(acct_name.keys())
    # Fill in names from sales data for any customer not in customers.json
    for cid, name in acct_name.items():
        if cid not in customer_name_map:
            customer_name_map[cid] = name

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
        name      = customer_name_map.get(cid) or acct_name.get(cid, "")
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

        # KSS rep name(s) — from sales_reps.Customers mapping
        kss_rep_name  = customer_kss_rep.get(cid, "")
        kss_rep_names = [kss_rep_name] if kss_rep_name else []

        # 2CW rep(s) — from rep_assignments sheet
        twocw_raw    = rep_assignments.get(name.lower(), "")
        twocw_reps_l = ([t.strip() for t in twocw_raw.split(",") if t.strip()]
                        if twocw_raw else [])

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
        past90 = sales90_by_bsku.get(bsku, 0)
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
            "past_90":         past90,
            "days_of_supply":  dos,
        })

    # ── TSKU daily demand rate (for suggested batch size) ────────────────────
    # For each ASKU, find the most recent continuous selling window in the last
    # 90 days (gap tolerance = 5 days), trim the first/last 30% of that window
    # by day count, and compute average units/day from the middle 40%.
    # ASKU rates are then summed to TSKU level.
    print("Computing TSKU daily demand rates...")

    # Build daily ASKU sales dict: (bsku, type_, flavor) → {date: units}
    daily_asku: dict = defaultdict(lambda: defaultdict(int))
    for r in sales_rows:
        d = r["date_obj"]
        if d < d90:
            continue
        if not r["bsku"] or not r["flavor"]:
            continue
        key = (r["bsku"], r["type"] or "Hybrid", r["flavor"] or "")
        daily_asku[key][d] += r["units"]

    def _most_recent_window(date_unit_map: dict, gap_days: int = 5):
        """Return the most recent continuous selling window as a sorted list of (date, units).
        Gaps of up to gap_days consecutive zero-sale days are tolerated within a window."""
        if not date_unit_map:
            return []
        all_dates = sorted(date_unit_map.keys())
        # Build windows: a new window starts when the gap exceeds gap_days
        windows = []
        current = [all_dates[0]]
        for i in range(1, len(all_dates)):
            if (all_dates[i] - all_dates[i - 1]).days <= gap_days + 1:
                current.append(all_dates[i])
            else:
                windows.append(current)
                current = [all_dates[i]]
        windows.append(current)
        # Return only the most recent window
        return [(d, date_unit_map[d]) for d in windows[-1]]

    def _trim_window(window: list, trim_pct: float = 0.30):
        """Trim the first and last trim_pct of the window by day span, not by count."""
        if len(window) < 2:
            return window
        start_date = window[0][0]
        end_date   = window[-1][0]
        total_span = (end_date - start_date).days
        if total_span < 3:
            return window  # too short to trim meaningfully
        trim_days = total_span * trim_pct
        cutoff_start = start_date + timedelta(days=trim_days)
        cutoff_end   = end_date   - timedelta(days=trim_days)
        trimmed = [(d, u) for d, u in window if cutoff_start <= d <= cutoff_end]
        return trimmed if trimmed else window  # safety: return original if trim wiped everything

    def _avg_daily_rate(window: list) -> float:
        """Average units/day across a window list of (date, units)."""
        if not window:
            return 0.0
        total_units = sum(u for _, u in window)
        # Span in days from first to last date in the trimmed window
        if len(window) == 1:
            return float(total_units)  # single day — treat as 1-day rate
        span = (window[-1][0] - window[0][0]).days
        if span == 0:
            return float(total_units)
        return total_units / span

    # Compute per-ASKU daily rate, accumulate to TSKU
    tsku_daily_rate: dict = defaultdict(float)   # tsku → units/day
    for (bsku, type_, flavor), date_map in daily_asku.items():
        window   = _most_recent_window(date_map, gap_days=5)
        trimmed  = _trim_window(window, trim_pct=0.30)
        rate     = _avg_daily_rate(trimmed)
        tsku_key = make_tsku(bsku, type_)
        tsku_daily_rate[tsku_key] += rate

    # Round to 4 decimal places for output
    tsku_daily_rate = {k: round(v, 4) for k, v in tsku_daily_rate.items()}

    # ── ASKU-level inventory aggregates (for Recommended Production tab) ─────
    # One row per (BSKU, Type, Flavor). Includes rows with inventory only,
    # rows with sales velocity only (out of stock but still selling), and
    # rows seen in either inventory or sales in the last 30 days.
    print("Computing ASKU-level aggregates...")
    asku_keys = set(inv_by_asku.keys()) | set(sales30_by_asku.keys())

    # bsku → (brand, category, subcategory, weight_unit) for label lookup
    bsku_meta = {bsku: (brand, cat, sub, wu) for pg, bsku, brand, cat, sub, wu in PG_TABLE}

    asku_data = []
    for (bsku, type_, flavor) in asku_keys:
        if not bsku or not flavor:
            continue
        meta = bsku_meta.get(bsku)
        if not meta:
            continue
        brand, cat, sub, wu = meta
        inv_row = inv_by_asku.get((bsku, type_, flavor), {"inv_vn": 0, "inv_al": 0})
        inv_vn  = inv_row["inv_vn"]
        inv_al  = inv_row["inv_al"]
        inv_total = inv_vn + inv_al
        past30  = sales30_by_asku.get((bsku, type_, flavor), 0)
        dos     = round(inv_total / (past30 / 30), 1) if past30 > 0 else None

        asku_data.append({
            "brand":       brand,
            "category":    cat,
            "subcategory": sub,
            "wu":          wu,
            "type":        type_,
            "flavor":      flavor,
            "bsku":        bsku,
            "tsku":        make_tsku(bsku, type_),
            "inv_total":   inv_total,
            "inv_vn":      inv_vn,
            "inv_al":      inv_al,
            "past30":      past30,
            "dos":         dos,
        })

    # Sort for readability: by BSKU display order, then type, then flavor
    bsku_order = {bsku: i for i, (pg, bsku, *_ ) in enumerate(PG_TABLE)}
    type_order = {"Indica": 0, "Sativa": 1, "Hybrid": 2}
    asku_data.sort(key=lambda r: (
        bsku_order.get(r["bsku"], 999),
        type_order.get(r["type"], 9),
        -r["inv_total"],
        r["flavor"],
    ))

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

    # Group accounts by KSS rep name (from customer_kss_rep mapping)
    accts_by_kss = defaultdict(list)
    for a in acct_records:
        kss_name = a["kss_reps"][0] if a["kss_reps"] else None
        if kss_name:
            accts_by_kss[kss_name].append(a)

    kss_cards = []
    for name in sorted(rep_name_map.values()):
        kss_cards.append(build_rep_card(name, accts_by_kss.get(name, [])))

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

    # ── Commission data ───────────────────────────────────────────────────────
    print("Computing commission data...")
    commission_data = compute_commission_data(
        sales_rows      = sales_rows,
        customer_name_map = customer_name_map,
        kss_rep_map     = customer_kss_rep,
        rep_assignments = rep_assignments,
        today_dt        = today_dt,
    )
    commission_data["ref_date"] = today


    # ── Sales data output ─────────────────────────────────────────────────────
    # Builds sales_data.json: monthly revenue + units by brand and BSKU,
    # plus MTD figures for the current calendar month.
    print("Building sales data output...")

    from collections import defaultdict as _dd
    monthly_brand   = _dd(lambda: _dd(lambda: {"rev": 0.0, "units": 0}))
    monthly_bsku    = _dd(lambda: _dd(lambda: {"rev": 0.0, "units": 0}))
    monthly_subcats = _dd(lambda: _dd(lambda: {"rev": 0.0, "units": 0}))
    mtd_brand  = _dd(lambda: {"rev": 0.0, "units": 0})
    mtd_bsku   = _dd(lambda: {"rev": 0.0, "units": 0})
    bom = today_dt.replace(day=1)

    for r in sales_rows:
        d       = r["date_obj"]
        mo_key  = f"{d.strftime('%b')} {d.year}"
        brand   = (r["bsku"] or "")[:3]
        bsku    = r["bsku"] or ""
        subcat  = r["pg"] or ""
        rev     = r["subtotal"]
        units   = r["units"]
        monthly_brand[mo_key][brand]["rev"]   += rev
        monthly_brand[mo_key][brand]["units"] += units
        if bsku:
            monthly_bsku[mo_key][bsku]["rev"]   += rev
            monthly_bsku[mo_key][bsku]["units"] += units
        if subcat:
            monthly_subcats[mo_key][subcat]["rev"]   += rev
            monthly_subcats[mo_key][subcat]["units"] += units
        if bom <= d <= today_dt:
            mtd_brand[brand]["rev"]   += rev
            mtd_brand[brand]["units"] += units
            if bsku:
                mtd_bsku[bsku]["rev"]   += rev
                mtd_bsku[bsku]["units"] += units

    all_mos = sorted(monthly_brand.keys(),
                     key=lambda s: datetime.strptime(s, "%b %Y"))
    monthly_rows = []
    for mo in all_mos:
        row = {"month": mo, "brands": {}, "bskus": {}, "subcats": {}}
        row["brands"]  = {b: {"rev": round(v["rev"],2), "units": v["units"]}
                          for b, v in monthly_brand[mo].items()}
        row["total"]   = round(sum(v["rev"] for v in monthly_brand[mo].values()), 2)
        row["bskus"]   = {b: {"rev": round(v["rev"],2), "units": v["units"]}
                          for b, v in monthly_bsku[mo].items()}
        row["subcats"] = {s: {"rev": round(v["rev"],2), "units": v["units"]}
                          for s, v in monthly_subcats[mo].items()}
        monthly_rows.append(row)

    import calendar as _cal
    days_in_month  = _cal.monthrange(today_dt.year, today_dt.month)[1]
    days_elapsed   = today_dt.day
    days_remaining = days_in_month - days_elapsed
    mtd_total      = round(sum(v["rev"] for v in mtd_brand.values()), 2)
    daily_run_rate = round(mtd_total / days_elapsed, 2) if days_elapsed > 0 else 0
    projected_eom  = round(daily_run_rate * days_in_month, 2)

    sales_data = {
        "ref_date":       today,
        "current_month":  today_dt.strftime("%b %Y"),
        "days_elapsed":   days_elapsed,
        "days_remaining": days_remaining,
        "days_in_month":  days_in_month,
        "mtd": {
            "total":  mtd_total,
            "brands": {b: {"rev": round(v["rev"],2), "units": v["units"]}
                       for b, v in mtd_brand.items()},
            "bskus":  {b: {"rev": round(v["rev"],2), "units": v["units"]}
                       for b, v in mtd_bsku.items()},
        },
        "daily_run_rate": daily_run_rate,
        "projected_eom":  projected_eom,
        "monthly":        monthly_rows,
    }

    # ── Assemble and write output files ───────────────────────────────────────
    print("Writing output files...")

    kss_dashboard = {
        "ref_date":     today,
        "all_pgs":      PG_LABELS_LIST,
        "kss":          kss_cards,
        "acct_records": clean_acct_records,
    }
    twocw_dashboard = {
        "ref_date":     today,
        "all_pgs":      PG_LABELS_LIST,
        "twocw":        twocw_cards,
        "acct_records": clean_acct_records,
    }
    inventory_data = {
        "ref_date":           today,
        "product_groups":     inv_pg_data,
        "asku_data":          asku_data,
        "tsku_daily_rates":   tsku_daily_rate,
    }

    save_json("kss_dashboard.json",    kss_dashboard)
    save_json("twocw_dashboard.json",  twocw_dashboard)
    save_json("inventory_data.json",   inventory_data)
    save_json("commission_data.json",  commission_data)
    save_json("sales_data.json",        sales_data)

    # ── Summary ───────────────────────────────────────────────────────────────
    print()
    print("=== TRANSFORM SUMMARY ===")
    print(f"  Sales rows:       {len(sales_rows)}")
    print(f"  Accounts:         {len(acct_records)}")
    print(f"  Product groups:   {len(PG_LABELS_LIST)}")
    print(f"  ASKU rows:        {len(asku_data)}")
    print(f"  TSKU rate keys:   {len(tsku_daily_rate)}")
    print(f"  KSS reps:         {len(kss_cards)}")
    print(f"  2CW reps:         {len(twocw_cards)}")
    print(f"  Commission accts: {len(commission_data.get('monthly_data', []))}")
    print(f"  Output files:     kss_dashboard.json, twocw_dashboard.json,")
    print(f"                    inventory_data.json, commission_data.json, sales_data.json")


if __name__ == "__main__":
    transform()
