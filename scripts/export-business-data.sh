#!/bin/bash
# Kande Business Data Export → Google Drive/Kande-Business-Data
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

BACKUP_DATE=$(date +%Y-%m-%d)
LOG_FILE="/Users/kurtishon/clawd/logs/backup.log"
DATA_REMOTE="gdrive:Kande-Business-Data"
COOKIE="/tmp/kande-biz-data-cookies.txt"
TMP="/tmp/kande-biz-$$"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"; }
mkdir -p "$TMP"
trap "rm -rf '$TMP' '$COOKIE'" EXIT

log "📊 Business data export starting..."

# Authenticate
AUTH=$(curl -s -c "$COOKIE" \
  -X POST "https://vend.kandedash.com/api/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"password":"kande2026"}' 2>/dev/null)

if ! echo "$AUTH" | grep -q '"success":true'; then
  log "  ✗ Auth failed — aborting"; exit 1
fi

# Pull full export — write directly to file (avoids shell variable quoting issues)
log "  Fetching full export..."
curl -s -b "$COOKIE" "https://vend.kandedash.com/api/export/json" > "$TMP/full.json" 2>/dev/null

if [ ! -s "$TMP/full.json" ]; then
  log "  ✗ Empty response — aborting"; exit 1
fi

# Parse and write the 3 data files
python3 - "$TMP" "$BACKUP_DATE" << 'PYEOF'
import json, sys

tmp = sys.argv[1]
date = sys.argv[2]

with open(f"{tmp}/full.json") as f:
    d = json.load(f)

exported_at = d.get('exported_at', date)
products = d.get('products', [])
orders   = d.get('order_receipts', [])
sales    = d.get('sales', [])
finances = d.get('finances', [])
revenue  = d.get('revenue', [])

# inventory.json
inv = {
    "exported_at": exported_at,
    "summary": {
        "total_skus": len(products),
        "total_order_receipts": len(orders),
        "total_units_in_stock": sum(p.get('stock', 0) for p in products)
    },
    "products": products,
    "order_receipts": orders,
    "restocks": d.get('restocks', []),
    "restock_logs": d.get('restockLogs', [])
}
with open(f"{tmp}/inventory.json", "w") as f:
    json.dump(inv, f, indent=2)
print(f"  ✓ inventory.json — {len(products)} products, {len(orders)} orders, {sum(p.get('stock',0) for p in products)} units in stock")

# orders.json
total_charged = sum((r.get('total_charged') or r.get('total') or 0) for r in orders)
orders_out = {
    "exported_at": exported_at,
    "summary": {
        "total_orders": len(orders),
        "total_charged": round(total_charged, 2),
        "suppliers": list(set(r.get('supplier', r.get('vendor', 'Unknown')) for r in orders))
    },
    "order_receipts": orders
}
with open(f"{tmp}/orders.json", "w") as f:
    json.dump(orders_out, f, indent=2)
print(f"  ✓ orders.json — {len(orders)} orders, ${total_charged:.2f} total charged")

# sales.json
sales_out = {
    "exported_at": exported_at,
    "summary": {
        "total_sales_records": len(sales),
        "total_finance_records": len(finances),
        "total_revenue_records": len(revenue)
    },
    "sales": sales,
    "sales_velocity": d.get('salesVelocity', []),
    "finances": finances,
    "revenue": revenue,
    "marketing_spend": d.get('marketingSpend', [])
}
with open(f"{tmp}/sales.json", "w") as f:
    json.dump(sales_out, f, indent=2)
print(f"  ✓ sales.json — {len(sales)} sales, {len(finances)} finance records")
PYEOF

if [ $? -ne 0 ]; then
  log "  ✗ Python export failed"; exit 1
fi

# Upload current snapshots (always overwrite — latest)
for file in inventory orders sales; do
  rclone copy "$TMP/${file}.json" "$DATA_REMOTE/" 2>/dev/null \
    && log "  ✅ ${file}.json → Kande-Business-Data/" \
    || log "  ⚠ ${file}.json upload failed"
done

# Upload dated archives to history — kept forever, no retention limit
for file in inventory orders sales; do
  cp "$TMP/${file}.json" "$TMP/${file}-${BACKUP_DATE}.json"
  rclone copy "$TMP/${file}-${BACKUP_DATE}.json" "$DATA_REMOTE/history/${file}/" 2>/dev/null \
    || log "  ⚠ ${file} history upload failed"
done

log "  ✅ Dated archives → Kande-Business-Data/history/{inventory,orders,sales}/"
TOTAL=$(rclone ls "$DATA_REMOTE/" 2>/dev/null | wc -l | tr -d ' ')
log "  Files at root of Kande-Business-Data/: $TOTAL"
log "📊 Business data export complete."
