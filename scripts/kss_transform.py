"""
kss_transform.py
================
Transform layer: raw KSS API JSON → dashboard_data.json

INPUT  (from data/*.json written by kss_sync.py)
-------
  data/products.json
  data/inventory.json
  data/inventory_batches.json
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
from collections import defaultdict, Counter

# Published DATAV Google Sheet — single source of truth for BSKU taxonomy,
# list pricing, and BSKU status (Active/Discontinued/Inactive).
# Update this URL if the sheet is republished.
# NOTE: this used to point at a 2PACX key whose default-published tab had
# drifted off the BSKU table entirely (it was serving a Menu Health scoring
# tab instead) — fetch_datav() was silently failing over to the hardcoded
# fallback table below on every nightly run. Repointed 2026-08 at the
# MASTER-2CW Dashboard sheet's "DATAV" tab (gid=177248387), which carries the
# same BSKU/Brand/Category/Subcategory/Weight-Unit columns plus List Price
# Each / CASE COUNT / STATUS.
DATAV_URL = (
    "https://docs.google.com/spreadsheets/d/e/"
    "2PACX-1vTvUb2y2US1Qcyf12mngWEcvdCU3Yh9vgIzN_5-6x1psQRCIkG9Y4velrdcBB9zEw"
    "/pub?gid=177248387&single=true&output=csv"
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

def dedupe_by(records, key_field):
    """Drop repeat records sharing a key_field value, keeping the first seen.
    Defensive backstop here (kss_sync.py also dedupes at fetch time) in case
    data/*.json on disk predates that fix or a future source reintroduces dupes —
    undetected duplicates double-count revenue in commission_data.json."""
    seen = set()
    out = []
    dupes = 0
    for r in records:
        key = r.get(key_field)
        if key in seen:
            dupes += 1
            continue
        seen.add(key)
        out.append(r)
    if dupes:
        print(f"  [dedupe] Dropped {dupes} duplicate record(s) in {key_field}")
    return out

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
    "MDO050101": "MDO Indoor Flower 1g",
    "MDO050102": "MDO Indoor Flower 8th",
    "MDO050104": "MDO Indoor Flower 14g",
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
    ("MDO Flower 1g",          "MDO010101", "Mendo", "Flower",         "Bigs",           "1g"  ),
    ("MDO Flower 8th",         "MDO010102", "Mendo", "Flower",         "Bigs",           "3.5g"),
    ("MDO Flower 14g",         "MDO010104", "Mendo", "Flower",         "Bigs",           "14g" ),
    ("MDO Indoor Flower 1g",   "MDO050101", "Mendo", "Indoor Flower",  "Bigs",           "1g"  ),
    ("MDO Indoor Flower 8th",  "MDO050102", "Mendo", "Indoor Flower",  "Bigs",           "3.5g"),
    ("MDO Indoor Flower 14g",  "MDO050104", "Mendo", "Indoor Flower",  "Bigs",           "14g" ),
    ("MDO Live Resin AIO",     "MDO040601", "Mendo", "Vape",           "Live Resin AIO", "1g"  ),
    ("MDO Preroll 10pk",       "MDO021107", "Mendo", "Preroll",        "10pk",           "5g"  ),
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

# List pricing / status, keyed by BSKU — populated by fetch_datav() from the
# same DATAV sheet's "List Price Each" and "STATUS" columns. No fallback: if
# the sheet fetch fails, the menu just renders without prices rather than
# risk showing stale numbers.
PRICE_BY_BSKU  = {}   # bsku → float (list price per unit)
STATUS_BY_BSKU = {}   # bsku → "Active" / "Discontinued" / "Inactive" / ""

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
    Updates PG_TABLE, BSKU_LOOKUP, BSKU_CONCAT, UPP_BY_WU, PRICE_BY_BSKU, and
    STATUS_BY_BSKU in place.
    Returns True on success, False if fetch fails (fallback stays active).
    """
    global PG_TABLE, UPP_BY_WU, PRICE_BY_BSKU, STATUS_BY_BSKU
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
        new_pg_table  = []
        new_price     = {}
        new_status    = {}
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

            price_raw = (r.get("List Price Each") or "").strip()
            if price_raw:
                try:
                    new_price[bsku] = float(price_raw.replace("$", "").replace(",", ""))
                except ValueError:
                    pass
            new_status[bsku] = (r.get("STATUS") or "").strip()

        if not new_pg_table:
            raise ValueError("DATAV returned 0 BSKU rows")

        PG_TABLE       = new_pg_table
        UPP_BY_WU      = upp if upp else _FALLBACK_UPP
        PRICE_BY_BSKU  = new_price
        STATUS_BY_BSKU = new_status
        _rebuild_lookups()
        print(f"{len(PG_TABLE)} BSKUs loaded ({len(new_price)} with list price).")
        return True

    except Exception as exc:
        print(f"\n  [WARN] DATAV fetch failed: {exc} — using hardcoded fallback.")
        PG_TABLE       = list(_FALLBACK_PG_TABLE)
        UPP_BY_WU      = dict(_FALLBACK_UPP)
        PRICE_BY_BSKU  = {}
        STATUS_BY_BSKU = {}
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
    # Mendo Vape AIO
    # e.g. "Mendo Live Resin AIO 1g Indica Chem Z"
    (r"\bmendo\b.*(?:all-in-one|aio|live resin.*(?:cart|vape))",
        "Mendo", "Vape", "Live Resin AIO", None),

    # Mendo Preroll 10pk — covers both 10pk and 10ct multipack formats
    # e.g. "Mendo Preroll 5g Indica Rose Petal 10pk"
    #      "Mendo Preroll Indica Blueberry Runtz 10ct"
    (r"\bmendo\b.*(?:preroll|pre-roll)",
        "Mendo", "Preroll", "10pk", "5g"),

    # Mendo Flower (1g, 3.5g, 14g). All current Mendo flower is grown indoors —
    # KSS product names inconsistently include "Indoor", so every current
    # Mendo flower product is treated as Indoor Flower here regardless of
    # whether the name says "Indoor". Update this once a genuine non-indoor
    # (outdoor/greenhouse) Mendo flower line launches with its own naming.
    # e.g. "Mendo Flower 14g Hybrid Georgia Pie"
    #      "Mendo Indoor Flower 3.5g Indica Hard Candy"  ← same group
    (r"\bmendo\b.*flower",
        "Mendo", "Indoor Flower", "Bigs", None),
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

    # Strip trailing case-count / pack-count / restated-weight / dedup-id
    # tokens for flavor parsing — KSS names sometimes stack more than one,
    # e.g. "... Tropicana Cherry 16ct_2" or "... Hash Burger 10pk 5.0g", so
    # strip one trailing token at a time until none match.
    clean = name
    for _ in range(3):
        stripped = re.sub(
            r"\s+\d+(?:\.\d+)?\s*(?:ct|pk|g)(?:_\d+)?\s*$", "", clean, flags=re.IGNORECASE
        )
        if stripped == clean:
            break
        clean = stripped
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
# LIVE MENU  (data/menu.json)
#
# Built entirely from current KSS inventory — no manual entry. A strain shows
# up on the menu at a warehouse the moment inventory.json shows units there
# and drops off the moment it doesn't; THC% comes from the batch actually
# sitting in that warehouse right now; list pricing comes from the DATAV
# sheet's "List Price Each" column. menu.html just renders this file as-is.
#
# LocationID → warehouse, confirmed against inventory.html's existing
# Van Nuys / Alameda split (see comment in kss_transform's sibling usage).
# ─────────────────────────────────────────────────────────────────────────────

LOCATION_LABELS = {
    1: {"key": "socal",  "label": "SoCal",  "sublabel": "Van Nuys"},
    3: {"key": "norcal", "label": "NorCal", "sublabel": "Alameda"},
}

# (category, subcategory) → menu section title. Anything not listed here
# falls back to "{subcategory} {category}" so a brand-new BSKU still shows up
# under a reasonable label instead of silently vanishing from the menu.
_SECTION_TITLES = {
    ("Flower", "Smalls"):              "Premium Smalls",
    ("Flower", "Bigs"):                "Flower",
    ("Indoor Flower", "Bigs"):         "Indoor Flower",
    ("Preroll", "Single"):             "Pre-Rolls — Single 1g",
    ("Preroll", "28pk"):               "Pre-Roll Party Packs — 28ct",
    ("Preroll", "6pk"):                "Pre-Rolls — 6-Pack",
    ("Preroll", "10pk"):               "Pre-Roll 10-Pack",
    ("Preroll", "Multipack"):          "Pre-Roll Multipack",
    ("Concentrate", "Live Resin Jar"): "Live Resin Sauce",
    ("Concentrate", "Live Rosin Jar"): "Live Rosin",
    ("Vape", "Live Resin AIO"):        "All-In-One Vape",
}

_WEIGHT_LABELS = {"1g": "1G", "3.5g": "1/8", "14g": "14G", "28g": "28G", "5g": "5G"}
_WEIGHT_ORDER  = {"1g": 0, "3.5g": 1, "5g": 2, "14g": 3, "28g": 4}
_TYPE_ORDER    = {"Sativa": 0, "Hybrid": 1, "Indica": 2}
_INACTIVE_STATUSES = {"discontinued", "inactive"}


def _thc_from_batch(batch: dict | None) -> float | None:
    if not batch:
        return None
    try:
        return round(float(batch.get("THCPotency") or 0), 2)
    except (TypeError, ValueError):
        return None


def _thc_from_product(product: dict) -> float | None:
    m = re.search(r"([\d.]+)\s*%", (product or {}).get("PotencyTHC") or "")
    return round(float(m.group(1)), 2) if m else None


def _age_from_batch(batch: dict | None, today_dt) -> int | None:
    """Days since the batch was finished/packaged — same PackDate ▸
    ManufactureDate ▸ HarvestDate fallback used for the Freshness score."""
    if not batch:
        return None
    batch_date = (
        _parse_date(batch.get("PackDate"))
        or _parse_date(batch.get("ManufactureDate"))
        or _parse_date(batch.get("HarvestDate"))
    )
    if not batch_date:
        return None
    return (today_dt - batch_date).days


def build_menu(product_catalog: dict, products_raw: list, inventory_raw: list,
                batches_raw: list, today: str) -> dict:
    """
    Wholesale-menu shape, one "card" per (brand, category, subcategory,
    weight_unit) — i.e. per package format, since that's the level pricing
    and case-count are actually uniform at (a strain doesn't change what an
    eighth of it costs). Each card carries a flat, type-grouped strain list;
    each strain carries its own THC% and a cases-on-hand number per
    warehouse, so the front end can filter by min-cases-in-stock without
    another round trip.
    """
    products_by_id = {str(p["ProductID"]): p for p in products_raw if p.get("ProductID")}
    today_dt = date.today()

    # Best batch per (ProductID, LocationID): most units on hand right now,
    # tie-broken by most recently packed — the lot a budtender pulling from
    # that warehouse today would actually hand over.
    best_batch = {}
    for b in batches_raw:
        pid = str(b.get("ProductID") or "")
        loc_id = b.get("LocationID")
        if not pid or loc_id not in LOCATION_LABELS:
            continue
        key = (pid, loc_id)
        units = float(b.get("InventoryUnits") or 0)
        pack_date = b.get("PackDate") or ""
        cur = best_batch.get(key)
        if cur is None or units > cur[0] or (units == cur[0] and pack_date > cur[1]):
            best_batch[key] = (units, pack_date, b)

    # Case pack size per BSKU — case format is a packaging attribute, not a
    # strain-level one, so it should be uniform per BSKU. Mode guards against
    # the rare data-entry outlier in an individual product record.
    case_units_votes = defaultdict(Counter)
    for p in products_raw:
        pid = str(p.get("ProductID") or "")
        cat = product_catalog.get(pid)
        if not cat or not cat.get("bsku"):
            continue
        cases = p.get("WholesaleUnitsPerCase")
        if cases:
            try:
                case_units_votes[cat["bsku"]][int(cases)] += 1
            except (TypeError, ValueError):
                pass
    case_units_by_bsku = {
        bsku: counts.most_common(1)[0][0] for bsku, counts in case_units_votes.items()
    }

    # cards[(brand,cat,sub,wu)][(strain,type)][loc_key] = {thc, avail, bsku}
    cards = defaultdict(lambda: defaultdict(dict))

    skipped = 0
    for row in inventory_raw:
        avail = float(row.get("AvailableUnits") or 0)
        if avail <= 0:
            continue
        loc = LOCATION_LABELS.get(row.get("LocationID"))
        if not loc:
            continue
        pid = str(row.get("ProductID") or "")
        cat = product_catalog.get(pid)
        if not cat or not cat.get("bsku"):
            skipped += 1
            continue
        bsku = cat["bsku"]
        if STATUS_BY_BSKU.get(bsku, "").strip().lower() in _INACTIVE_STATUSES:
            continue

        p = products_by_id.get(pid, {})
        strain = (p.get("StrainName") or cat.get("flavor") or "").strip()
        if not strain:
            continue
        type_ = p.get("Blend") or cat.get("type") or "Hybrid"

        batch_entry = best_batch.get((pid, row.get("LocationID")))
        thc = _thc_from_batch(batch_entry[2]) if batch_entry else None
        if thc is None:
            thc = _thc_from_product(p)
        age_days = _age_from_batch(batch_entry[2], today_dt) if batch_entry else None

        card_key = (cat["brand"], cat["category"], cat["subcategory"], cat["weight_unit"])
        slot = cards[card_key][(strain, type_)]
        prior = slot.get(loc["key"])
        if prior is None or avail > prior["avail"]:
            slot[loc["key"]] = {"thc": thc, "avail": avail, "bsku": bsku, "age": age_days}

    if skipped:
        print(f"  [menu] Skipped {skipped} in-stock row(s) with unrecognized product names")

    # ── flatten into brands/cards/groups/strains for menu.html ──────────────
    by_brand = defaultdict(list)
    for (brand, category, subcategory, wu), rows_by_key in cards.items():
        bsku_for_pricing = None
        by_type = defaultdict(list)
        for (strain, type_), by_loc in rows_by_key.items():
            if not by_loc:
                continue
            bsku_for_pricing = bsku_for_pricing or next(iter(by_loc.values()))["bsku"]
            # representative THC = whichever location is holding the most stock
            dom_loc, dom = max(by_loc.items(), key=lambda kv: kv[1]["avail"])
            cases = {}
            for lk in LOCATION_LABELS.values():
                entry = by_loc.get(lk["key"])
                case_units = case_units_by_bsku.get(entry["bsku"]) if entry else None
                cases[lk["key"]] = round(entry["avail"] / case_units, 2) if entry and case_units else 0.0
            by_type[type_].append({
                "strain": strain,
                "thc": f"{dom['thc']:.2f}%" if dom["thc"] is not None else "—",
                "daysOld": dom.get("age"),
                "cases": cases,
            })

        if not by_type:
            continue

        groups = [
            {"type": t, "strains": sorted(by_type[t], key=lambda r: r["strain"])}
            for t in sorted(by_type.keys(), key=lambda t: _TYPE_ORDER.get(t, 99))
        ]

        unit_price  = PRICE_BY_BSKU.get(bsku_for_pricing)
        case_units  = case_units_by_bsku.get(bsku_for_pricing)
        base_title  = _SECTION_TITLES.get((category, subcategory), f"{subcategory} {category}".strip())
        size_label  = _WEIGHT_LABELS.get(wu, wu)

        by_brand[brand].append({
            "title": base_title,
            "size": size_label,
            "unitPrice": round(unit_price, 2) if unit_price is not None else None,
            "caseUnits": case_units,
            "casePrice": round(unit_price * case_units, 2) if unit_price is not None and case_units else None,
            "groups": groups,
        })

    brand_color = lambda b: "howie" if b == "Howie Roll" else ("soma" if b == "Soma Rosa Farms" else "mendo")
    out_brands = []
    for brand, brand_cards in by_brand.items():
        # de-dupe title when a category spans >1 weight tier, e.g. two
        # "Premium Smalls" cards (1/8 and 14G) get disambiguated by size.
        title_counts = Counter(c["title"] for c in brand_cards)
        for c in brand_cards:
            if title_counts[c["title"]] > 1:
                c["title"] = f"{c['title']} ({c['size']})"
        brand_cards.sort(key=lambda c: (c["title"], _WEIGHT_ORDER.get(c["size"], 99)))
        out_brands.append({"brand": brand, "brandColor": brand_color(brand), "cards": brand_cards})

    out_brands.sort(key=lambda b: b["brand"])

    return {
        "updated": today,
        "locations": {loc["key"]: {"label": loc["label"], "sublabel": loc["sublabel"]}
                       for loc in LOCATION_LABELS.values()},
        "brands": out_brands,
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
    Return (mo_periods, bw_periods) for the last 6 complete calendar months
    PLUS the current partial month (MTD).
    Each mo_period: {id, label, volKey, newKey, hint, mo, partial}
    Each bw_period: {id, label, bwKey, newKey, hint, mo, half, partial}
    """
    import calendar as cal_mod
    months = []
    y, m = today_dt.year, today_dt.month

    # Current partial month (MTD)
    current_mo = date(y, m, 1)

    # Last 6 complete months
    for _ in range(6):
        m -= 1
        if m == 0:
            m = 12
            y -= 1
        months.insert(0, date(y, m, 1))

    # Append current month at the end as partial
    months.append(current_mo)

    mo_periods = []
    bw_periods = []
    for mo in months:
        is_partial = (mo == current_mo)
        mo_id  = mo.strftime("%b").lower()
        mm     = mo.strftime("%m")
        yr     = mo.year
        last_d = cal_mod.monthrange(mo.year, mo.month)[1]
        # For partial month, biweekly B only goes to today
        b_end  = today_dt.day if (is_partial and today_dt.day < 16) else (today_dt.day if is_partial else last_d)
        mtd_label = f" (MTD thru {today_dt.day})" if is_partial else ""

        mo_periods.append({
            "id":      mo_id,
            "label":   mo.strftime("%b %Y") + (" MTD" if is_partial else ""),
            "volKey":  f"vol_{mo_id}",
            "newKey":  f"new_in_{mo_id}",
            "hint":    mo.strftime("%B %Y") + (f" — MTD thru {today_dt.day}" if is_partial else ""),
            "mo":      mo_id,
            "partial": is_partial,
            "_date":   mo,
        })
        # Biweekly A: 1–15
        bw_periods.append({
            "id":      f"{mm}A",
            "label":   f"{mo.strftime('%b')} 1–15",
            "bwKey":   f"{yr}-{mm}A",
            "newKey":  f"new_in_{mo_id}",
            "hint":    f"{mo.strftime('%b')} 1–15, {yr}",
            "mo":      mo_id,
            "half":    "A",
            "partial": is_partial and today_dt.day <= 15,
            "_date":   mo,
        })
        # Biweekly B: 16–end (skip entirely if current month and today < 16)
        if not (is_partial and today_dt.day < 16):
            b_day_end = today_dt.day if (is_partial and today_dt.day >= 16) else last_d
            bw_periods.append({
                "id":      f"{mm}B",
                "label":   f"{mo.strftime('%b')} 16–{b_day_end}" + (" (MTD)" if is_partial else ""),
                "bwKey":   f"{yr}-{mm}B",
                "newKey":  f"new_in_{mo_id}",
                "hint":    f"{mo.strftime('%b')} 16–{b_day_end}, {yr}",
                "mo":      mo_id,
                "half":    "B",
                "partial": is_partial,
                "_date":   mo,
            })
    return mo_periods, bw_periods


def compute_commission_data(sales_rows: list, customer_name_map: dict,
                             kss_rep_map: dict, rep_assignments: dict,
                             today_dt: date,
                             product_name_map: dict = None) -> dict:
    """
    Compute MONTHLY_DATA, BW_DATA, INV_LISTS, and OD (order detail)
    for the last 6 complete months + current partial month (MTD).
    Returns dict ready to write as commission_data.json.
    product_name_map: {sku_id: product_name_string} for OD line items.
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

    # ── Build OD (order detail): per-account per-month invoice+line data ──────
    # Structure: {acct_name: {mo_id: [{i: inv_num, d: "MM/DD/YYYY", t: [[prod_idx, rev], ...]}]}}
    # Also build a product index list so line items are compact
    od_m: dict = {}
    product_index: list = []   # ordered list of product name strings
    product_pos: dict  = {}    # name → index in product_index

    for cid in active_cids:
        name = customer_name_map.get(cid, "")
        if not name:
            continue
        # Gather all rows for this customer within commission window
        acct_inv_mo: dict = defaultdict(dict)  # mo_id → inv_num → {d, items: {prod_idx: rev}}
        for r in sales_rows:
            if r["customer_id"] != cid:
                continue
            d   = r["date_obj"]
            mo_id = ym_to_mo_id.get((d.year, d.month))
            if not mo_id:
                continue
            inv_num = r.get("invoice_num", "")
            if not inv_num:
                continue
            date_str = f"{d.month:02d}/{d.day:02d}/{d.year}"
            if inv_num not in acct_inv_mo[mo_id]:
                acct_inv_mo[mo_id][inv_num] = {"d": date_str, "items": defaultdict(float)}
            # Product name
            prod_name = ""
            if product_name_map:
                sku_id = r.get("sku_id", "")
                prod_name = product_name_map.get(sku_id, "")
            if not prod_name:
                # Fallback: use bsku
                prod_name = r.get("bsku", "") or "Unknown"
            if prod_name not in product_pos:
                product_pos[prod_name] = len(product_index)
                product_index.append(prod_name)
            acct_inv_mo[mo_id][inv_num]["items"][product_pos[prod_name]] += r["subtotal"]

        # Convert to list format
        acct_od: dict = {}
        for mo_id, inv_dict in acct_inv_mo.items():
            inv_list = []
            for inv_num, inv_data in sorted(inv_dict.items(),
                                            key=lambda kv: kv[1]["d"]):
                items_list = [[idx, round(rev, 4)]
                              for idx, rev in sorted(inv_data["items"].items())]
                inv_list.append({"i": inv_num, "d": inv_data["d"], "t": items_list})
            if inv_list:
                acct_od[mo_id] = inv_list
        if acct_od:
            od_m[name] = acct_od

    od_out = {"products": product_index, "m": od_m}

    return {
        "mo_periods":   [clean(p) for p in mo_periods],
        "bw_periods":   [clean(p) for p in bw_periods],
        "monthly_data": monthly_data,
        "bw_data":      bw_data,
        "inv_lists":    inv_lists,
        "od":           od_out,
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
    batches_raw     = load_json("inventory_batches.json")
    customers_raw   = load_json("customers.json")
    sales_reps_raw  = load_json("sales_reps.json")
    invoices_raw    = dedupe_by(load_json("invoices.json"), "InvoiceID")
    txn_raw         = dedupe_by(load_json("invoice_transactions.json"), "InvoiceTransID")
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

    # ── Build live customer-facing menu (data/menu.json) ─────────────────────
    print("Building menu...")
    menu_data = build_menu(product_catalog, products_raw, inventory_raw, batches_raw, today)
    save_json("menu.json", menu_data)
    menu_card_count = sum(len(b["cards"]) for b in menu_data["brands"])
    print(f"  Menu: {len(menu_data['brands'])} brands, {menu_card_count} cards")

    # ── Build inventory map: bsku → total units on hand ─────────────────────
    # KSS API: inventory[n].ProductID, .AvailableUnits
    print("Building inventory snapshot...")
    inv_by_bsku = defaultdict(int)
    for row in inventory_raw:
        sku_id = str(row.get("ProductID") or "")
        qty    = int(float(row.get("AvailableUnits") or 0))
        bsku   = product_catalog.get(sku_id, {}).get("bsku")
        if bsku:
            inv_by_bsku[bsku] += qty

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
            "sku_id":      sku_id,
            "units":       units,
            "subtotal":    subtotal,
            "pg":          tax.get("pg", ""),
            "bsku":        tax.get("bsku", ""),
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
        elif d >= d60:
            acct_rev_pri[cid]   += r["subtotal"]

        if d >= d90 and r["pg"]:
            acct_pg_units[cid][r["pg"]] += r["units"]

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

    # ── Batch-level freshness (Aging Inventory by B-SKU) ──────────────────────
    # KSS /inventory/batches (added 2026-07): ProductID, InventoryUnits,
    # BatchCode, HarvestDate, ManufactureDate, PackDate, ExpirationDate, ...
    # "Days Old" per the NedCo scoring sheet = days since the batch was
    # finished/packaged; falls back across whichever date field is populated
    # for that product's category (flower has Harvest/Pack, concentrate/vape
    # tend to only have Manufacture/Pack).
    print("Computing batch aging (Freshness)...")

    age_weighted_sum = defaultdict(float)
    age_weight_total = defaultdict(float)
    for row in batches_raw:
        sku_id = str(row.get("ProductID") or "")
        bsku   = product_catalog.get(sku_id, {}).get("bsku", "")
        if not bsku:
            continue
        units = float(row.get("InventoryUnits") or 0)
        if units <= 0:
            continue
        batch_date = (
            _parse_date(row.get("PackDate"))
            or _parse_date(row.get("ManufactureDate"))
            or _parse_date(row.get("HarvestDate"))
        )
        if not batch_date:
            continue
        age_days = (today_dt - batch_date).days
        age_weighted_sum[bsku] += age_days * units
        age_weight_total[bsku] += units

    avg_age_by_bsku = {
        bsku: round(age_weighted_sum[bsku] / age_weight_total[bsku], 1)
        for bsku in age_weight_total
        if age_weight_total[bsku] > 0
    }
    print(f"  Batch rows: {len(batches_raw)}, B-SKUs with age data: {len(avg_age_by_bsku)}")

    # ── KSS batch-presence set (Pipeline dashboard: hide once received) ──────
    # A batch of flower is COA'd once but packed into multiple pack sizes
    # (BSKUs) under the same Batch #, and each pack size can be sent in to
    # KSS on a different day. So "has this batch landed in KSS" is tracked
    # per (bsku, BatchCode) pair, not just by BatchCode alone — a Soma Rosa
    # Oz can still be pending in the pipeline after the matching 8ths batch
    # has already shown up in KSS inventory.
    #
    # Two sources, unioned:
    #  - inventory_batches.json (KSS /inventory/batches, added 2026-07) — has
    #    no history before that date, so a batch that fully sold through
    #    earlier would never appear here.
    #  - invoice_transactions.json line items also carry BatchCode and go
    #    back further, so a batch that's already been invoiced counts as
    #    "landed in KSS" even if the batches endpoint never captured it.
    kss_batches_by_bsku = defaultdict(set)
    for row in batches_raw:
        sku_id     = str(row.get("ProductID") or "")
        bsku       = product_catalog.get(sku_id, {}).get("bsku", "")
        batch_code = (row.get("BatchCode") or "").strip().upper()
        if bsku and batch_code:
            kss_batches_by_bsku[bsku].add(batch_code)
    for txn in txn_raw:
        sku_id     = str(txn.get("ProductID") or "")
        bsku       = product_catalog.get(sku_id, {}).get("bsku", "")
        batch_code = (txn.get("BatchCode") or "").strip().upper()
        if bsku and batch_code:
            kss_batches_by_bsku[bsku].add(batch_code)
    kss_batches = {bsku: sorted(codes) for bsku, codes in kss_batches_by_bsku.items()}
    print(f"  B-SKUs with KSS batch history (inventory + sales): {len(kss_batches)}")

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
            "avg_age_days":    avg_age_by_bsku.get(bsku),
        })

    # ── Per-ASKU (flavor × type × warehouse) inventory rows ──────────────────
    # LocationID 1 = Van Nuys, 3 = Alameda
    print("Building ASKU-level inventory...")

    asku_inv_vn = defaultdict(int)
    asku_inv_al = defaultdict(int)

    for row in inventory_raw:
        sku_id = str(row.get("ProductID") or "")
        qty    = int(float(row.get("OnFloorInventory") or 0))
        loc    = str(row.get("LocationID") or "")
        if not sku_id or qty == 0:
            continue
        if loc == "1":
            asku_inv_vn[sku_id] += qty
        elif loc == "3":
            asku_inv_al[sku_id] += qty

    asku_past30 = defaultdict(int)
    for r in sales_rows:
        if r["date_obj"] >= d30:
            asku_past30[r["sku_id"]] += r["units"]

    asku_data = []
    for sku_id, cat_data in product_catalog.items():
        bsku   = cat_data.get("bsku", "")
        tsku   = cat_data.get("tsku", "")
        flavor = cat_data.get("flavor", "")
        if not bsku or not flavor:
            continue
        inv_vn    = asku_inv_vn.get(sku_id, 0)
        inv_al    = asku_inv_al.get(sku_id, 0)
        inv_total = inv_vn + inv_al
        past30    = asku_past30.get(sku_id, 0)
        if inv_total == 0 and past30 == 0:
            continue
        daily_rate = past30 / 30 if past30 > 0 else None
        dos        = round(inv_total / daily_rate, 1) if daily_rate else None
        asku_data.append({
            "sku_id":      sku_id,
            "bsku":        bsku,
            "tsku":        tsku,
            "brand":       cat_data.get("brand", ""),
            "category":    cat_data.get("category", ""),
            "subcategory": cat_data.get("subcategory", ""),
            "wu":          cat_data.get("weight_unit", ""),
            "type":        cat_data.get("type", ""),
            "flavor":      cat_data.get("flavor", ""),
            "inv_vn":      inv_vn,
            "inv_al":      inv_al,
            "inv_total":   inv_total,
            "past30":      past30,
            "dos":         dos,
        })

    tsku_daily_rates = {}
    tsku_past30 = defaultdict(int)
    for r in sales_rows:
        if r["date_obj"] >= d30:
            tsku_r = product_catalog.get(r["sku_id"], {}).get("tsku", "")
            if tsku_r:
                tsku_past30[tsku_r] += r["units"]
    for tsku_key, units in tsku_past30.items():
        tsku_daily_rates[tsku_key] = round(units / 30, 4)

    print(f"  ASKU rows: {len(asku_data)}, TSKU rates: {len(tsku_daily_rates)}")

    # ── Wholesale value of on-hand inventory, by brand ───────────────────────
    # available units (current on-hand, sellable) x most-recent FullPrice
    # seen for that SKU in the transaction history. Credits/returns excluded,
    # same rule as sales_rows above.
    print("Computing wholesale inventory value...")
    latest_full_price = {}   # sku_id -> (TimeCreated, FullPrice)
    for txn in txn_raw:
        sku_id = str(txn.get("ProductID") or "")
        if not sku_id:
            continue
        price = txn.get("FullPrice")
        if price is None:
            continue
        inv_id    = str(txn.get("InvoiceID") or "")
        subtotal  = float(txn.get("ExtPrice") or 0)
        inv_meta  = invoice_index.get(inv_id, {})
        is_credit = inv_meta.get("status") == 4 or subtotal < 0
        if is_credit:
            continue
        t   = txn.get("TimeCreated") or ""
        cur = latest_full_price.get(sku_id)
        if not cur or t > cur[0]:
            latest_full_price[sku_id] = (t, float(price))

    avail_by_sku = defaultdict(int)
    for row in inventory_raw:
        sku_id = str(row.get("ProductID") or "")
        qty    = int(float(row.get("AvailableUnits") or 0))
        if sku_id:
            avail_by_sku[sku_id] += qty

    wholesale_value_by_brand = {"Soma Rosa Farms": 0.0, "Howie Roll": 0.0, "Mendo": 0.0}
    for sku_id, qty in avail_by_sku.items():
        if qty <= 0:
            continue
        brand = product_catalog.get(sku_id, {}).get("brand", "")
        if brand not in wholesale_value_by_brand:
            continue
        price_info = latest_full_price.get(sku_id)
        if not price_info:
            continue
        wholesale_value_by_brand[brand] += qty * price_info[1]

    wholesale_value = {
        "soma_rosa":  round(wholesale_value_by_brand["Soma Rosa Farms"], 2),
        "howie_roll": round(wholesale_value_by_brand["Howie Roll"], 2),
        "mendo":      round(wholesale_value_by_brand["Mendo"], 2),
    }
    wholesale_value["total"] = round(sum(wholesale_value.values()), 2)
    print(f"  Wholesale value: {wholesale_value}")

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
        sales_rows        = sales_rows,
        customer_name_map = customer_name_map,
        kss_rep_map       = customer_kss_rep,
        rep_assignments   = rep_assignments,
        today_dt          = today_dt,
        product_name_map  = {str(p.get("ProductID","")): p.get("ProductName","")
                             for p in products_raw if p.get("ProductID")},
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
        brand   = BSKU_CONCAT.get(r["bsku"], "")[:3]
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
        if d >= bom:
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
        "ref_date":         today,
        "product_groups":   inv_pg_data,
        "asku_data":        asku_data,
        "tsku_daily_rates": tsku_daily_rates,
        "wholesale_value":  wholesale_value,
        "kss_batches":      kss_batches,
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
    print(f"  KSS reps:         {len(kss_cards)}")
    print(f"  2CW reps:         {len(twocw_cards)}")
    print(f"  Commission accts: {len(commission_data.get('monthly_data', []))}")
    print(f"  Menu cards:       {menu_card_count} across {len(menu_data['brands'])} brands")
    print(f"  Output files:     kss_dashboard.json, twocw_dashboard.json,")
    print(f"                    inventory_data.json, commission_data.json, sales_data.json,")
    print(f"                    menu.json")


if __name__ == "__main__":
    transform()
