import os
import json
import requests
from datetime import datetime

# ── CONFIG ──────────────────────────────────────────────────────────────────
API_KEY      = os.environ["KSS_API_KEY"]
BASE_URL     = "https://api.kssdata.com/api/v1"
DATA_DIR     = os.path.join(os.path.dirname(__file__), "..", "data")

SUPPLIERS = {
    "howie_roll": 62,
    "soma_rosa":  63,
    "mendo":      74,
}

HEADERS = {
    "Authorization": f"Bearer {API_KEY}",
    "Accept":        "application/json",
}

# ── HELPERS ──────────────────────────────────────────────────────────────────
def get(endpoint, params=None):
    url = f"{BASE_URL}/{endpoint}"
    resp = requests.get(url, headers=HEADERS, params=params, timeout=30)
    resp.raise_for_status()
    return resp.json()

def save(filename, data):
    os.makedirs(DATA_DIR, exist_ok=True)
    path = os.path.join(DATA_DIR, filename)
    with open(path, "w") as f:
        json.dump(data, f, indent=2)
    print(f"  ✓ Saved {filename}")

# ── SYNC ─────────────────────────────────────────────────────────────────────
def main():
    print(f"\n{'='*50}")
    print(f"KSS Sync — {datetime.utcnow().strftime('%Y-%m-%d %H:%M UTC')}")
    print(f"{'='*50}\n")

    all_orders    = []
    all_inventory = []
    all_products  = []

    for brand, supplier_id in SUPPLIERS.items():
        print(f"Fetching: {brand} (supplier_id={supplier_id})")

        # Orders / sales
        try:
            orders = get("orders", params={"supplier_id": supplier_id})
            save(f"{brand}_orders.json", orders)
            if isinstance(orders, list):
                all_orders.extend(orders)
            elif isinstance(orders, dict) and "data" in orders:
                all_orders.extend(orders["data"])
        except Exception as e:
            print(f"  ✗ Orders failed: {e}")

        # Inventory
        try:
            inventory = get("inventory", params={"supplier_id": supplier_id})
            save(f"{brand}_inventory.json", inventory)
            if isinstance(inventory, list):
                all_inventory.extend(inventory)
            elif isinstance(inventory, dict) and "data" in inventory:
                all_inventory.extend(inventory["data"])
        except Exception as e:
            print(f"  ✗ Inventory failed: {e}")

        # Products
        try:
            products = get("products", params={"supplier_id": supplier_id})
            save(f"{brand}_products.json", products)
            if isinstance(products, list):
                all_products.extend(products)
            elif isinstance(products, dict) and "data" in products:
                all_products.extend(products["data"])
        except Exception as e:
            print(f"  ✗ Products failed: {e}")

    # Combined rollup files
    save("all_orders.json",    {"updated_at": datetime.utcnow().isoformat(), "data": all_orders})
    save("all_inventory.json", {"updated_at": datetime.utcnow().isoformat(), "data": all_inventory})
    save("all_products.json",  {"updated_at": datetime.utcnow().isoformat(), "data": all_products})

    # Sync metadata
    save("last_sync.json", {
        "synced_at":  datetime.utcnow().isoformat(),
        "suppliers":  list(SUPPLIERS.keys()),
        "status":     "success"
    })

    print(f"\nSync complete.\n")

if __name__ == "__main__":
    main()
