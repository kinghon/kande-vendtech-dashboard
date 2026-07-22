#!/bin/bash
# =============================================================================
# Kande VendTech Business Data Export → Google Drive
#
# Drive structure:
#   Kande VendTech Business Data/
#     1-day/        ← overwritten every day (most recent snapshot)
#     1-week/       ← overwritten every Sunday (7-day-old safety net)
#     1-month/      ← overwritten 1st of each month
#     6-months/     ← overwritten Jan 1 and Jul 1 each year
#     history/      ← full dated archive, kept forever
#       inventory/  orders/  sales/
#
# Logic: if data gets corrupted and the daily backup is bad,
# you still have week/month/6-month clean copies.
# =============================================================================
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

BACKUP_DATE=$(date +%Y-%m-%d)
DAY_OF_WEEK=$(date +%u)   # 1=Mon … 7=Sun
DAY_OF_MONTH=$(date +%-d)
MONTH=$(date +%-m)
LOG_FILE="/Users/kurtishon/clawd/logs/backup.log"
DATA_REMOTE="gdrive:Kande VendTech Business Data"
COOKIE="/tmp/kande-biz-data-cookies.txt"
TMP="/tmp/kande-biz-$$"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"; }
mkdir -p "$TMP"
trap "rm -rf '$TMP' '$COOKIE'" EXIT

log "📊 Business data export starting ($BACKUP_DATE)..."

# Pull full export via Python helper (reliable session auth)
log "  Fetching full export from sales.kandedash.com..."
if ! python3 /Users/kurtishon/clawd/kande-vendtech/scripts/crm-export.py "$TMP/full.json" 2>&1 | tee -a "$LOG_FILE" | grep -q "prospects:"; then
  log "  ✗ Export failed — aborting"; exit 1
fi

if [ ! -s "$TMP/full.json" ]; then
  log "  ✗ Empty response — aborting"; exit 1
fi

# Generate the 3 data files from the export
python3 - "$TMP" "$BACKUP_DATE" << 'PYEOF'
import json, sys

tmp, date = sys.argv[1], sys.argv[2]

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
print(f"  ✓ inventory — {len(products)} products, {len(orders)} orders, {sum(p.get('stock',0) for p in products)} units")

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
print(f"  ✓ orders — {len(orders)} orders, ${total_charged:.2f} total charged")

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
print(f"  ✓ sales — {len(sales)} sales, {len(finances)} finance records")
PYEOF

if [ $? -ne 0 ]; then
  log "  ✗ Python export failed"; exit 1
fi

# Helper: upload all 3 files to a given slot folder
upload_slot() {
  local SLOT="$1"
  local LABEL="$2"
  for FILE in inventory orders sales; do
    rclone copy "$TMP/${FILE}.json" "$DATA_REMOTE/$SLOT/" 2>/dev/null \
      && log "  ✅ $LABEL → ${FILE}.json" \
      || log "  ⚠ $LABEL upload failed for ${FILE}.json"
  done
}

# ── SLOT 1: 1-day — always overwrite ──────────────────────────────────────
upload_slot "1-day" "1-day"

# ── SLOT 2: 1-week — update every Sunday ──────────────────────────────────
if [ "$DAY_OF_WEEK" -eq 7 ]; then
  upload_slot "1-week" "1-week (Sunday)"
  log "  📅 1-week slot updated (Sunday rotation)"
else
  log "  ⏭  1-week slot skipped (updates Sundays, today is day $DAY_OF_WEEK)"
fi

# ── SLOT 3: 1-month — update on the 1st ──────────────────────────────────
if [ "$DAY_OF_MONTH" -eq 1 ]; then
  upload_slot "1-month" "1-month (1st)"
  log "  📅 1-month slot updated (1st of month)"
else
  log "  ⏭  1-month slot skipped (updates on the 1st, today is day $DAY_OF_MONTH)"
fi

# ── SLOT 4: 6-months — update Jan 1 and Jul 1 ────────────────────────────
if [ "$DAY_OF_MONTH" -eq 1 ] && { [ "$MONTH" -eq 1 ] || [ "$MONTH" -eq 7 ]; }; then
  upload_slot "6-months" "6-months (Jan/Jul)"
  log "  📅 6-month slot updated (Jan 1 or Jul 1)"
else
  log "  ⏭  6-month slot skipped (updates Jan 1 + Jul 1)"
fi

# ── HISTORY: dated archive — kept forever ─────────────────────────────────
for FILE in inventory orders sales; do
  cp "$TMP/${FILE}.json" "$TMP/${FILE}-${BACKUP_DATE}.json"
  rclone copy "$TMP/${FILE}-${BACKUP_DATE}.json" "$DATA_REMOTE/history/${FILE}/" 2>/dev/null \
    || log "  ⚠ history/${FILE} archive failed"
done
log "  ✅ history/ — dated archive added for $BACKUP_DATE"

# Summary
SLOTS=$(rclone lsd "$DATA_REMOTE/" 2>/dev/null | awk '{print $NF}' | tr '\n' ' ')
log "  Drive folders: $SLOTS"
log "📊 Business data export complete."
