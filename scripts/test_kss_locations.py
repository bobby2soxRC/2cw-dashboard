"""Warehouse labels for the KSS inventory feed.

Run: python3 scripts/test_kss_locations.py

LocationID 2 (the Encompass id people use for Alameda) is not what this
feed uses. LocationID 1 is the Alameda warehouse and LocationID 3 is Van
Nuys. These checks lock that split so the columns cannot be swapped again.
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import kss_transform as t

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")

fails = 0


def check(name, cond):
    global fails
    print(("ok  " if cond else "FAIL") + " " + name)
    if not cond:
        fails += 1


def test_labels():
    al = t.inventory_warehouse(1)
    vn = t.inventory_warehouse(3)
    check("location 1 is Alameda / NorCal", al and al["sublabel"] == "Alameda" and al["key"] == "norcal")
    check("location 3 is Van Nuys / SoCal", vn and vn["sublabel"] == "Van Nuys" and vn["key"] == "socal")
    check("string ids match the same warehouses", t.inventory_warehouse("1")["column"] == "al" and t.inventory_warehouse("3")["column"] == "vn")
    check("encompass location 2 is not filed under either warehouse", t.inventory_warehouse(2) is None)
    check("blank location is not a warehouse", t.inventory_warehouse(None) is None and t.inventory_warehouse("") is None)


def test_split_keeps_each_warehouse():
    rows = [
        {"ProductID": 10, "LocationID": 1, "OnFloorInventory": "5.00"},
        {"ProductID": 10, "LocationID": 3, "OnFloorInventory": "7"},
        {"ProductID": 11, "LocationID": "1", "OnFloorInventory": "2"},
        {"ProductID": 12, "LocationID": 2, "OnFloorInventory": "9"},
        {"ProductID": 13, "LocationID": 1, "OnFloorInventory": "0"},
    ]
    vn, al, unknown = t.split_on_floor_by_warehouse(rows)
    check("location 1 units land in Alameda", al[str(10)] == 5 and al[str(11)] == 2)
    check("location 3 units land in Van Nuys", vn[str(10)] == 7 and str(11) not in vn)
    check("location 2 is reported, not added to Van Nuys or Alameda", unknown[2] == 9 and sum(vn.values()) == 7 and sum(al.values()) == 7)
    check("zero on-floor rows are ignored", str(13) not in al and str(13) not in vn)


def _on_floor(path):
    rows = json.load(open(os.path.join(DATA, path)))
    by_loc = {}
    for row in rows:
        loc = row.get("LocationID")
        qty = int(float(row.get("OnFloorInventory") or 0))
        if qty == 0:
            continue
        by_loc[loc] = by_loc.get(loc, 0) + qty
    return rows, by_loc


def test_menu_puts_each_warehouse_on_its_own_side():
    catalog = {
        "10": {"bsku": "SRF010102", "brand": "Soma Rosa Farms", "category": "Flower",
               "subcategory": "Bigs", "weight_unit": "3.5g", "flavor": "Blue Dream", "type": "Sativa"},
        "11": {"bsku": "SRF010102", "brand": "Soma Rosa Farms", "category": "Flower",
               "subcategory": "Bigs", "weight_unit": "3.5g", "flavor": "Gelato", "type": "Indica"},
    }
    products = [
        {"ProductID": 10, "StrainName": "Blue Dream", "Blend": "Sativa", "WholesaleUnitsPerCase": 16},
        {"ProductID": 11, "StrainName": "Gelato", "Blend": "Indica", "WholesaleUnitsPerCase": 16},
    ]
    inventory = [
        {"ProductID": 10, "LocationID": 1, "AvailableUnits": 32},
        {"ProductID": 11, "LocationID": 3, "AvailableUnits": 16},
        {"ProductID": 10, "LocationID": 2, "AvailableUnits": 100},
    ]
    menu = t.build_menu(catalog, products, inventory, [], "2026-11-03")
    check("menu calls NorCal Alameda", menu["locations"]["norcal"]["sublabel"] == "Alameda")
    check("menu calls SoCal Van Nuys", menu["locations"]["socal"]["sublabel"] == "Van Nuys")
    strains = {}
    for brand in menu["brands"]:
        for card in brand["cards"]:
            for group in card["groups"]:
                for strain in group["strains"]:
                    strains[strain["strain"]] = strain["cases"]
    check("Alameda menu cases come from location 1 only", strains["Blue Dream"] == {"norcal": 2.0, "socal": 0.0})
    check("Van Nuys menu cases come from location 3 only", strains["Gelato"] == {"socal": 1.0, "norcal": 0.0})


def test_synced_feed():
    rows, by_loc = _on_floor("inventory.json")
    ids = sorted({r.get("LocationID") for r in rows})
    check("synced inventory locations are 1 and 3 only", ids == [1, 3])
    vn, al, unknown = t.split_on_floor_by_warehouse(rows)
    al_units = sum(al.values())
    vn_units = sum(vn.values())
    check("Alameda column equals location 1 on-floor units", al_units == by_loc.get(1, 0) and al_units > 0)
    check("Van Nuys column equals location 3 on-floor units", vn_units == by_loc.get(3, 0) and vn_units > 0)
    check("no synced units dropped or double counted", unknown == {} and al_units + vn_units == by_loc[1] + by_loc[3])

    batches = json.load(open(os.path.join(DATA, "inventory_batches.json")))
    batch_ids = sorted({b.get("LocationID") for b in batches})
    check("batch locations are 1 and 3 only", batch_ids == [1, 3])

    customers = json.load(open(os.path.join(DATA, "customers.json")))
    cust_ids = sorted({c.get("LocationID") for c in customers})
    check("customer serving-warehouse ids are 1 and 3 only", cust_ids == [1, 3])

    # inventory_data.json on main was built with the labels swapped
    # (location 1 filed as Van Nuys, location 3 filed as Alameda). After this
    # fix each catalogued product keeps the same combined units; the columns swap.
    published = json.load(open(os.path.join(DATA, "inventory_data.json")))
    swapped = []
    for r in published["asku_data"]:
        sku = r["sku_id"]
        new_al = al.get(sku, 0)
        new_vn = vn.get(sku, 0)
        if new_al != (r.get("inv_vn") or 0) or new_vn != (r.get("inv_al") or 0):
            swapped.append(sku)
        if new_al + new_vn != (r.get("inv_vn") or 0) + (r.get("inv_al") or 0):
            swapped.append(sku + ":total")
    check("each published product moves to the other column with the same units", swapped == [])
    pub_vn = sum(r.get("inv_vn") or 0 for r in published["asku_data"])
    pub_al = sum(r.get("inv_al") or 0 for r in published["asku_data"])
    check("published Van Nuys units become the Alameda column", al_units >= pub_vn and pub_vn == sum(al.get(r["sku_id"], 0) for r in published["asku_data"]))
    print(f"     location 1 (Alameda) on-floor {by_loc[1]}")
    print(f"     location 3 (Van Nuys) on-floor {by_loc[3]}")
    print(f"     published columns today: Van Nuys {pub_vn}, Alameda {pub_al} (names swapped)")


if __name__ == "__main__":
    test_labels()
    test_split_keeps_each_warehouse()
    test_menu_puts_each_warehouse_on_its_own_side()
    test_synced_feed()
    print()
    if fails:
        print(f"{fails} failed")
        sys.exit(1)
    print("all checks passed")
