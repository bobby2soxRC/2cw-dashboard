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


# ─── PRODUCTION / SALES-PUSH ACTION LISTS ──────────────────────────────────
# Two more views on the same T-SKU tier, driven by production-batch economics
# rather than the Mix/Freshness/Volume scores above:
#
#   Production — for each of the 3 production teams (Flower, Prerolls,
#   Other = Concentrate + Vape), the 5 T-SKUs worth producing next, sized to
#   a 60-day-supply batch (target_units = 60 * daily sales rate). Ranked by
#   projected Volume + Freshness score lift multiplied by the batch quantity
#   — i.e. units added x how much better those units make the score, which
#   also roughly tracks how much weight that T-SKU will carry once produced
#   (weighted-avg rollup weights on inventory_units). A T-SKU currently at
#   zero units with active demand (stockout) gets a priority bump since it's
#   also failing its Mix flavor-count contribution.
#
#   Sales push — a single ranked list (not split by team; that's a sales,
#   not production, list) of T-SKUs sitting on the most excess inventory
#   beyond a 60-day supply, weighted up for aging stock.
TARGET_DOS_DAYS = 60
PRODUCTION_GROUP = {
    "Flower": "flower", "Indoor Flower": "flower",
    "Preroll": "prerolls",
    "Concentrate": "other", "Vape": "other",
}


def _parse_batch_date(s):
    if not s:
        return None
    try:
        return date.fromisoformat(str(s)[:10])
    except ValueError:
        return None


def build_action_lists(asku_data, tsku_meta, tsku_rates, today_dt):
    """tsku_meta: tsku -> {bsku, bsku_concat, brand, category, type,
    flavor_count, flavor_goal} (built from the already-scored bsku_nodes)."""
    batches_raw = load_json("inventory_batches.json", default=[]) or []

    sku_to_tsku = {}
    for r in asku_data:
        sid = str(r.get("sku_id") or "")
        if sid:
            sku_to_tsku[sid] = r.get("tsku")

    tsku_inv = defaultdict(int)
    tsku_past30 = defaultdict(int)
    for r in asku_data:
        tsku = r.get("tsku")
        if not tsku:
            continue
        tsku_inv[tsku] += r.get("inv_total") or 0
        tsku_past30[tsku] += r.get("past30") or 0

    age_wsum = defaultdict(float)
    age_wtot = defaultdict(float)
    for b in batches_raw:
        tsku = sku_to_tsku.get(str(b.get("ProductID") or ""))
        if not tsku:
            continue
        units = float(b.get("InventoryUnits") or 0)
        if units <= 0:
            continue
        bd = (
            _parse_batch_date(b.get("PackDate"))
            or _parse_batch_date(b.get("ManufactureDate"))
            or _parse_batch_date(b.get("HarvestDate"))
        )
        if not bd:
            continue
        age_days = (today_dt - bd).days
        age_wsum[tsku] += age_days * units
        age_wtot[tsku] += units
    tsku_age = {t: age_wsum[t] / age_wtot[t] for t in age_wtot if age_wtot[t] > 0}

    rows = []
    for tsku, meta in tsku_meta.items():
        current_units = tsku_inv.get(tsku, 0)
        past30 = tsku_past30.get(tsku, 0)
        daily_rate = tsku_rates.get(tsku)
        if daily_rate is None:
            daily_rate = past30 / 30 if past30 else 0.0
        if current_units <= 0 and daily_rate <= 0:
            continue  # no inventory, no sales — nothing actionable either way

        wos_now = round(current_units / (daily_rate * 7), 1) if daily_rate > 0 else None
        volume_now = interp(VOLUME_TABLE, wos_now) if wos_now is not None else (0.0 if current_units > 0 else None)

        target_units = round(TARGET_DOS_DAYS * daily_rate) if daily_rate > 0 else 0
        qty_to_produce = max(0, target_units - current_units)

        wos_after = round((current_units + qty_to_produce) / (daily_rate * 7), 1) if daily_rate > 0 else None
        volume_after = interp(VOLUME_TABLE, wos_after) if wos_after is not None else volume_now

        age_days = tsku_age.get(tsku)
        freshness_now = freshness_score(age_days)
        if qty_to_produce > 0 and age_days is not None:
            new_age = (age_days * current_units) / (current_units + qty_to_produce)
            freshness_after = freshness_score(new_age)
        elif qty_to_produce > 0 and current_units == 0:
            freshness_after = freshness_score(0)  # brand-new batch, no prior baseline
        else:
            freshness_after = freshness_now

        excess_units = max(0, current_units - target_units)

        rows.append({
            "tsku": tsku,
            "bsku": meta["bsku"],
            "bsku_concat": meta.get("bsku_concat", ""),
            "brand": meta.get("brand", ""),
            "category": meta.get("category", ""),
            "type": meta.get("type", ""),
            "flavor_count": meta.get("flavor_count"),
            "flavor_goal": meta.get("flavor_goal"),
            "current_units": current_units,
            "daily_rate": round(daily_rate, 2),
            "wos_now": wos_now,
            "wos_after": wos_after,
            "target_units": target_units,
            "qty_to_produce": qty_to_produce,
            "volume_now": volume_now,
            "volume_after": volume_after,
            "age_days": round(age_days) if age_days is not None else None,
            "freshness_now": freshness_now,
            "freshness_after": freshness_after,
            "excess_units": excess_units,
            "stockout": current_units <= 0 and daily_rate > 0,
        })

    # ── Production: 5 per team, ranked by qty x projected score lift ──────
    production = {"flower": [], "prerolls": [], "other": []}
    for r in rows:
        if r["qty_to_produce"] <= 0:
            continue
        group = PRODUCTION_GROUP.get(r["category"])
        if not group:
            continue
        lift = (r["volume_after"] or 0) - (r["volume_now"] or 0)
        if r["freshness_now"] is not None and r["freshness_after"] is not None:
            lift += r["freshness_after"] - r["freshness_now"]
        impact = r["qty_to_produce"] * max(lift, 0.1)
        if r["stockout"]:
            impact *= 1.5
        production[group].append(dict(r, impact_score=round(impact, 1)))
    for group in production:
        production[group].sort(key=lambda r: r["impact_score"], reverse=True)
        production[group] = production[group][:5]

    # ── Sales push: excess units beyond 60-day supply, weighted up by age ──
    push_candidates = []
    for r in rows:
        if r["current_units"] <= 0 or r["excess_units"] <= 0:
            continue
        age_factor = 1 + (100 - r["freshness_now"]) / 100 if r["freshness_now"] is not None else 1.0
        push_candidates.append(dict(r, push_score=round(r["excess_units"] * age_factor, 1)))
    push_candidates.sort(key=lambda r: r["push_score"], reverse=True)
    sales_push = push_candidates[:5]

    return production, sales_push


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

    # ── Production / Sales-push action lists (T-SKU tier) ─────────────────
    tsku_meta = {}
    for b in bsku_nodes:
        for t in b["tskus"]:
            tsku_meta[t["tsku"]] = {
                "bsku": b["bsku"],
                "bsku_concat": b["bsku_concat"],
                "brand": b["brand"],
                "category": b["category"],
                "type": t["type"],
                "flavor_count": t["flavor_count"],
                "flavor_goal": t["flavor_goal"],
            }
    production, sales_push = build_action_lists(
        asku_data, tsku_meta, inv.get("tsku_daily_rates", {}), date.fromisoformat(today)
    )
    print(
        f"  Production picks: flower={len(production['flower'])} "
        f"prerolls={len(production['prerolls'])} other={len(production['other'])}"
    )
    print(f"  Sales push picks: {len(sales_push)}")

    snapshot = {
        "ref_date": today,
        "total": total,
        "brands": brand_nodes,
        "production": production,
        "sales_push": sales_push,
    }
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
