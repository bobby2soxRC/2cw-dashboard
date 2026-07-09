"""
menu_health_score.py
=====================
Computes the Menu Health score bottom-up from on-hand inventory:
  T-SKU -> B-SKU -> Brand -> Total

INPUT
-----
  data/inventory_data.json   (written by kss_transform.py — must run first)
  Mix Targets Google Sheet   (ASKU/TSKU flavor-count goals per B-SKU, STATUS)

OUTPUT
------
  data/menu_health.json          current full snapshot, every level
  data/menu_health_history.json  one row per day, for the trend chart

SCORING RULES (see "NedCo - 13-Scoring System" sheet)
------------------------------------------------------
Category weights out of 100: Freshness 33 (Aging Inventory by B-SKU), Mix 25
(Number of Flavors by B-SKU) + Mix 9 (Number of Flavors by T-SKU), Volume 33
(WOS by B-SKU Avg).

Freshness = Aging Inventory by B-SKU, from the KSS batch inventory sync
(data/inventory_batches.json → kss_transform.py's avg_age_days, a per-B-SKU
inventory-weighted average of days since PackDate/ManufactureDate/HarvestDate,
whichever is populated). FRESHNESS_TABLE below is transcribed verbatim from
the "NedCo - 13-Scoring System" sheet. If a B-SKU has no batch date data
(e.g. sync hasn't populated it yet), freshness is null for that node and
Mix/Volume renormalize to fill 100%, same as every other missing component.

Mix targets come from a published sheet with one row per B-SKU:
  ASKU Count Goal = target total distinct flavors for the whole B-SKU
  TSKU Count Goal = target distinct flavors per type-variant (I/S/H)
  Low Inventory Cut-Off = per-B-SKU unit threshold; a flavor with on-hand
    units below this is excluded from the Mix flavor count (it doesn't
    count as "carried" for Mix purposes) but still counts fully toward
    Volume and Freshness.
(ASKU Count Goal == 3 x TSKU Count Goal everywhere both are set.)

MIX_TABLE maps signed "% deviation from flavor-count target" -> score, where
deviation = (actual - goal) / goal. Being short of the target is punished
much harder than exceeding it: score falls off steeply for negative
deviation (0 at -100%, i.e. zero flavors in stock) but only tapers slowly
for positive deviation (100 at 0%, still 70 at +100% over target, floor of
60 by +200%). Too many flavors dilutes the mix, but not carrying enough is
worse for a retailer.

VOLUME_TABLE maps weeks-of-supply -> score, a bell curve peaking at 6-10 WOS.
"""

import csv
import io
import json
import os
import urllib.request
from collections import defaultdict
from datetime import date

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(_REPO_ROOT, "data")

MIX_TARGETS_URL = (
    "https://docs.google.com/spreadsheets/d/e/"
    "2PACX-1vTvUb2y2US1Qcyf12mngWEcvdCU3Yh9vgIzN_5-6x1psQRCIkG9Y4velrdcBB9zEw"
    "/pub?gid=177248387&single=true&output=csv"
)

MIX_WEIGHT_BSKU = 25
MIX_WEIGHT_TSKU = 9
MIX_WEIGHT_TOTAL = MIX_WEIGHT_BSKU + MIX_WEIGHT_TSKU
FRESHNESS_WEIGHT = 33
VOLUME_WEIGHT = 33

MIX_TABLE = [
    (-100, 0), (-90, 10), (-80, 20), (-70, 30), (-60, 40), (-50, 50),
    (-40, 60), (-30, 70), (-20, 80), (-10, 90), (0, 100), (10, 100),
    (20, 95), (30, 90), (45, 85), (65, 80), (80, 75), (100, 70),
    (150, 65), (200, 60),
]
VOLUME_TABLE = [
    (0, 0), (1, 25), (2, 50), (3, 60), (4, 80), (5, 90), (6, 100),
    (8, 100), (9, 100), (10, 100), (11, 90), (12, 80), (14, 60),
    (16, 50), (18, 30), (20, 15), (22, 5),
]
# Age in days -> score. Transcribed from "NedCo - 13-Scoring System".
FRESHNESS_TABLE = [
    (-21, 100), (0, 100), (30, 90), (60, 80), (90, 70), (120, 60),
    (150, 50), (210, 30), (300, 0),
]


def interp(table, x):
    """Piecewise-linear lookup; clamps flat past either end."""
    if x is None:
        return None
    if x <= table[0][0]:
        return table[0][1]
    if x >= table[-1][0]:
        return table[-1][1]
    for (x0, y0), (x1, y1) in zip(table, table[1:]):
        if x0 <= x <= x1:
            return y0 + (y1 - y0) * (x - x0) / (x1 - x0)
    return table[-1][1]


def load_json(filename, default=None):
    path = os.path.join(DATA_DIR, filename)
    if not os.path.exists(path):
        print(f"  [WARN] {filename} not found")
        return default
    with open(path) as f:
        return json.load(f)


def save_json(filename, data):
    path = os.path.join(DATA_DIR, filename)
    with open(path, "w") as f:
        json.dump(data, f, indent=2, default=str)
    n = len(data) if isinstance(data, list) else "dict"
    print(f"  [OK] Wrote {filename} ({n})")


def fetch_mix_targets():
    """BSKU -> {asku_goal, tsku_goal, status}. Empty dict on fetch failure."""
    try:
        req = urllib.request.Request(
            MIX_TARGETS_URL, headers={"User-Agent": "Mozilla/5.0 (menu_health_score)"}
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            content = resp.read().decode("utf-8")
    except Exception as e:
        print(f"  [WARN] Mix Targets fetch failed: {e}")
        return {}

    def to_int(v):
        v = (v or "").strip()
        try:
            return int(float(v))
        except ValueError:
            return None

    targets = {}
    for r in csv.DictReader(io.StringIO(content)):
        bsku = (r.get("BSKU") or "").strip()
        if not bsku:
            continue
        targets[bsku] = {
            "asku_goal": to_int(r.get("ASKU Count Goal")),
            "tsku_goal": to_int(r.get("TSKU Count Goal")),
            "status": (r.get("STATUS") or "").strip(),
            "low_inv_cutoff": to_int(r.get("Low Inventory Cut-Off")),
        }
    return targets


def mix_score(actual, goal):
    if not goal:
        return None
    deviation_pct = (actual - goal) / goal * 100
    return round(interp(MIX_TABLE, deviation_pct), 1)


def freshness_score(age_days):
    if age_days is None:
        return None
    return round(interp(FRESHNESS_TABLE, age_days), 1)


def combine_weighted(components):
    """[(value, weight), ...] -> weighted avg over non-None values.

    Missing components simply drop out of the denominator, so e.g. Mix +
    Volume alone renormalize to fill 100% when Freshness is unavailable.
    """
    total_w, total_v = 0.0, 0.0
    for v, w in components:
        if v is None or not w:
            continue
        total_w += w
        total_v += v * w
    return round(total_v / total_w, 1) if total_w > 0 else None


def weighted_avg(items, value_key, weight_key):
    total_w, total_v = 0.0, 0.0
    for it in items:
        v, w = it.get(value_key), it.get(weight_key, 0)
        if v is None or not w or w <= 0:
            continue
        total_w += w
        total_v += v * w
    return round(total_v / total_w, 1) if total_w > 0 else None


def score():
    today = date.today().isoformat()
    print(f"\n=== menu_health_score.py  ref_date={today} ===\n")

    inv = load_json("inventory_data.json")
    if not inv:
        print("  [ERROR] inventory_data.json missing/empty, aborting.")
        return

    asku_data = inv.get("asku_data", [])
    product_groups = {pg["bsku"]: pg for pg in inv.get("product_groups", [])}
    targets = fetch_mix_targets()
    print(
        f"  Loaded {len(asku_data)} ASKU rows, {len(product_groups)} B-SKUs, "
        f"{len(targets)} Mix targets."
    )

    # ── Distinct in-stock flavor counts, by T-SKU and by B-SKU ────────────────
    # A flavor below its B-SKU's Low Inventory Cut-Off still keeps the T-SKU/
    # B-SKU node alive (it has real inventory, so Volume/Freshness are
    # unaffected) but is left out of flavors_by_* so it doesn't count toward
    # the Mix flavor count.
    flavors_by_tsku = defaultdict(set)
    flavors_by_bsku = defaultdict(set)
    tsku_type = {}
    tsku_bsku = {}
    for row in asku_data:
        inv_total = row.get("inv_total") or 0
        if inv_total <= 0:
            continue
        bsku, tsku, flavor = row.get("bsku"), row.get("tsku"), row.get("flavor")
        if not bsku or not tsku or not flavor:
            continue
        tsku_type[tsku] = row.get("type", "")
        tsku_bsku[tsku] = bsku
        cutoff = (targets.get(bsku) or {}).get("low_inv_cutoff")
        if cutoff and inv_total < cutoff:
            continue
        flavors_by_bsku[bsku].add(flavor)
        flavors_by_tsku[tsku].add(flavor)

    # ── T-SKU nodes: Mix only (no Volume/Freshness data at this grain) ────────
    tskus_by_bsku = defaultdict(list)
    for tsku, bsku in tsku_bsku.items():
        goal = (targets.get(bsku) or {}).get("tsku_goal")
        actual = len(flavors_by_tsku[tsku])
        mix = mix_score(actual, goal)
        tskus_by_bsku[bsku].append({
            "tsku": tsku,
            "type": tsku_type.get(tsku, ""),
            "flavor_count": actual,
            "flavor_goal": goal,
            "mix": mix,
            "overall": mix,
        })

    # ── B-SKU nodes ────────────────────────────────────────────────────────
    bsku_nodes = []
    for bsku, pg in product_groups.items():
        tgt = targets.get(bsku) or {}
        asku_goal = tgt.get("asku_goal")
        actual_flavors = len(flavors_by_bsku.get(bsku, set()))
        mix_bsku = mix_score(actual_flavors, asku_goal)

        children = sorted(tskus_by_bsku.get(bsku, []), key=lambda t: t["tsku"])
        child_mixes = [c["mix"] for c in children if c["mix"] is not None]
        mix_tsku_avg = round(sum(child_mixes) / len(child_mixes), 1) if child_mixes else None

        if mix_bsku is not None and mix_tsku_avg is not None:
            mix = round(
                (MIX_WEIGHT_BSKU * mix_bsku + MIX_WEIGHT_TSKU * mix_tsku_avg)
                / (MIX_WEIGHT_BSKU + MIX_WEIGHT_TSKU), 1
            )
        else:
            mix = mix_bsku if mix_bsku is not None else mix_tsku_avg

        dos = pg.get("days_of_supply")
        wos = dos / 7 if dos is not None else None
        volume = round(interp(VOLUME_TABLE, wos), 1) if wos is not None else None

        freshness = freshness_score(pg.get("avg_age_days"))

        overall = combine_weighted([
            (mix, MIX_WEIGHT_TOTAL),
            (freshness, FRESHNESS_WEIGHT),
            (volume, VOLUME_WEIGHT),
        ])

        status = tgt.get("status", "")
        default_active = status not in ("Discontinued", "Inactive")

        bsku_nodes.append({
            "bsku": bsku,
            "bsku_concat": pg.get("bsku_concat", ""),
            "brand": pg.get("brand", ""),
            "category": pg.get("category", ""),
            "subcategory": pg.get("subcategory", ""),
            "weight_unit": pg.get("weight_unit", ""),
            "inventory_units": pg.get("inventory", 0) or 0,
            "flavor_count": actual_flavors,
            "flavor_goal": asku_goal,
            "wos": round(wos, 1) if wos is not None else None,
            "mix": mix,
            "freshness": freshness,
            "volume": volume,
            "overall": overall,
            "status": status,
            "default_active": default_active,
            "tskus": children,
        })

    # ── Brand nodes ────────────────────────────────────────────────────────
    bskus_by_brand = defaultdict(list)
    for node in bsku_nodes:
        bskus_by_brand[node["brand"]].append(node)

    brand_nodes = []
    for brand, bskus in bskus_by_brand.items():
        active = [b for b in bskus if b["default_active"]]
        brand_nodes.append({
            "brand": brand,
            "inventory_units": sum(b["inventory_units"] for b in bskus),
            "mix": weighted_avg(active, "mix", "inventory_units"),
            "freshness": weighted_avg(active, "freshness", "inventory_units"),
            "volume": weighted_avg(active, "volume", "inventory_units"),
            "overall": weighted_avg(active, "overall", "inventory_units"),
            "bskus": sorted(bskus, key=lambda b: b["bsku"]),
        })
    brand_nodes.sort(key=lambda b: b["brand"])

    # ── Total ──────────────────────────────────────────────────────────────
    active_brands = [b for b in brand_nodes if b["overall"] is not None]
    total = {
        "mix": weighted_avg(active_brands, "mix", "inventory_units"),
        "freshness": weighted_avg(active_brands, "freshness", "inventory_units"),
        "volume": weighted_avg(active_brands, "volume", "inventory_units"),
        "overall": weighted_avg(active_brands, "overall", "inventory_units"),
    }

    snapshot = {"ref_date": today, "total": total, "brands": brand_nodes}
    save_json("menu_health.json", snapshot)

    # ── History: dedupe by ref_date, keep most recent 180 days ────────────────
    history = load_json("menu_health_history.json", default=[]) or []
    history = [h for h in history if h.get("date") != today]
    history.append({
        "date": today,
        "total_overall": total["overall"],
        "total_mix": total["mix"],
        "total_volume": total["volume"],
    })
    history.sort(key=lambda h: h["date"])
    history = history[-180:]
    save_json("menu_health_history.json", history)

    print()
    print("=== MENU HEALTH SUMMARY ===")
    print(f"  Brands scored:  {len(brand_nodes)}")
    print(f"  B-SKUs scored:  {len(bsku_nodes)}")
    print(f"  Total overall:  {total['overall']}")
    print(f"  Total mix:      {total['mix']}")
    print(f"  Total volume:   {total['volume']}")


if __name__ == "__main__":
    score()
