#!/bin/bash
# =============================================================================
# Kande Backup Health Check — runs monthly, reports to Telegram
# Validates: file freshness per slot schedule, data integrity, API health
# =============================================================================
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

LOG_FILE="/Users/kurtishon/clawd/logs/backup.log"
COOKIE="/tmp/kande-healthcheck-cookies.txt"
TODAY=$(date +%Y-%m-%d)
TODAY_EPOCH=$(date +%s)
TMP="/tmp/kande-hc-$$"
mkdir -p "$TMP"
trap "rm -rf '$TMP' '$COOKIE'" EXIT

PASS=0; FAIL=0; WARN=0; REPORT=""
log()  { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [HEALTH] $1" >> "$LOG_FILE"; }
ok()   { REPORT="${REPORT}✅ $1\n"; PASS=$((PASS+1));  log "OK: $1"; }
fail() { REPORT="${REPORT}❌ $1\n"; FAIL=$((FAIL+1));  log "FAIL: $1"; }
warn() { REPORT="${REPORT}⚠️  $1\n"; WARN=$((WARN+1)); log "WARN: $1"; }

# Returns age in days of the newest file in a Drive folder
drive_age_days() {
  local FOLDER="$1"
  # rclone lsf --format=tp gives: "2026-05-09 16:27:04;filename"
  local NEWEST_DATE=$(rclone lsf "$FOLDER" --format="tp" 2>/dev/null \
    | awk -F';' '{print $1}' | sort | tail -1 | cut -d' ' -f1)
  if [ -z "$NEWEST_DATE" ]; then echo 9999; return; fi
  local FILE_EPOCH
  FILE_EPOCH=$(date -j -f "%Y-%m-%d" "$NEWEST_DATE" +%s 2>/dev/null \
    || date -d "$NEWEST_DATE" +%s 2>/dev/null || echo 0)
  [ "$FILE_EPOCH" -eq 0 ] && echo 9999 && return
  echo $(( (TODAY_EPOCH - FILE_EPOCH) / 86400 ))
}

# Download a slot file and validate its JSON data
validate_slot_data() {
  local REMOTE="$1"   # e.g. gdrive:Kande VendTech Business Data/1-day/inventory.json
  local TYPE="$2"     # inventory | orders | sales
  local SLOT="$3"     # 1-day | 1-week | etc.

  rclone copy "$REMOTE" "$TMP/" 2>/dev/null
  local FNAME=$(basename "$REMOTE")
  local FILE="$TMP/$FNAME"

  if [ ! -s "$FILE" ]; then
    fail "$SLOT/$TYPE: file download failed or empty"
    return
  fi

  python3 << PYEOF
import json, sys

slot = "$SLOT"
dtype = "$TYPE"
fname = "$FILE"

try:
    with open(fname) as f:
        d = json.load(f)
except Exception as e:
    print(f"FAIL:{slot}/{dtype}: JSON parse error — {e}")
    sys.exit(1)

issues = []
warnings = []

if dtype == "inventory":
    products = d.get("products", [])
    orders = d.get("order_receipts", [])
    summary = d.get("summary", {})

    # Structure checks
    if not isinstance(products, list):
        issues.append("products is not a list")
    elif len(products) == 0:
        issues.append("products array is empty")
    else:
        # Sample first 5 products for sanity
        for p in products[:5]:
            if not p.get("name"):
                issues.append(f"product missing name: {p.get('id')}")
            if p.get("price_per_unit", 0) <= 0 and p.get("cost_price", 0) <= 0:
                warnings.append(f"product '{p.get('name','?')}' has no price")
            if p.get("stock", -1) < 0:
                issues.append(f"product '{p.get('name','?')}' has negative stock")

    if not isinstance(orders, list):
        issues.append("order_receipts is not a list")

    if not d.get("exported_at"):
        warnings.append("missing exported_at timestamp")

    if issues:
        print(f"FAIL:{slot}/inventory: {'; '.join(issues)} ({len(products)} products)")
    elif warnings:
        print(f"WARN:{slot}/inventory: {'; '.join(warnings)} ({len(products)} products, {len(orders)} orders)")
    else:
        stock = sum(p.get("stock", 0) for p in products)
        print(f"OK:{slot}/inventory: {len(products)} products, {len(orders)} orders, {stock} units in stock — data looks good")

elif dtype == "orders":
    receipts = d.get("order_receipts", [])
    summary = d.get("summary", {})

    if not isinstance(receipts, list):
        issues.append("order_receipts is not a list")
    else:
        for r in receipts:
            total = r.get("total_charged") or r.get("total") or 0
            if total <= 0:
                warnings.append(f"order {r.get('vendhub_order_ref','?')} has \$0 total")
            if not r.get("order_date"):
                issues.append(f"order missing order_date")
            items = r.get("items", [])
            if len(items) == 0:
                issues.append(f"order {r.get('vendhub_order_ref','?')} has no items")
            for item in items[:3]:
                if not item.get("product_name"):
                    warnings.append("item missing product_name")
                if item.get("price_per_case", 0) <= 0:
                    warnings.append(f"item '{item.get('product_name','?')}' has \$0 price")

    if issues:
        print(f"FAIL:{slot}/orders: {'; '.join(issues)}")
    elif warnings:
        print(f"WARN:{slot}/orders: {'; '.join(warnings)} ({len(receipts)} receipts)")
    else:
        total_val = sum((r.get("total_charged") or r.get("total") or 0) for r in receipts)
        print(f"OK:{slot}/orders: {len(receipts)} receipts, \${total_val:.2f} total value — data looks good")

elif dtype == "sales":
    sales = d.get("sales", [])
    finances = d.get("finances", [])
    revenue = d.get("revenue", [])

    if not isinstance(sales, list):
        issues.append("sales is not a list")
    if not isinstance(finances, list):
        issues.append("finances is not a list")

    if not d.get("exported_at"):
        warnings.append("missing exported_at timestamp")

    if issues:
        print(f"FAIL:{slot}/sales: {'; '.join(issues)}")
    else:
        print(f"OK:{slot}/sales: {len(sales)} sales, {len(finances)} finance records, {len(revenue)} revenue entries")
PYEOF
}

log "========== Monthly backup health check — $TODAY =========="

# =============================================================================
# 1. KandeVendTech-Backups — daily/db/full
# =============================================================================
log "Checking KandeVendTech-Backups..."

# Daily workspace tar — must be ≤2 days old
DAILY_AGE=$(drive_age_days "gdrive:KandeVendTech-Backups/daily/")
COUNT_DAILY=$(rclone ls "gdrive:KandeVendTech-Backups/daily/" 2>/dev/null | wc -l | tr -d ' ')
if [ "$DAILY_AGE" -le 2 ]; then
  ok "Daily workspace backup: ${DAILY_AGE}d old, $COUNT_DAILY files"
elif [ "$COUNT_DAILY" -eq 0 ]; then
  fail "Daily workspace backup: NO FILES FOUND"
else
  fail "Daily workspace backup: STALE — ${DAILY_AGE}d old (expected ≤2d)"
fi

# Database snapshot — must be ≤2 days old + size check
DB_AGE=$(drive_age_days "gdrive:KandeVendTech-Backups/database/")
LATEST_DB=$(rclone ls "gdrive:KandeVendTech-Backups/database/" 2>/dev/null | sort | tail -1)
DB_SIZE=$(echo "$LATEST_DB" | awk '{print $1}')
if [ "$DB_AGE" -le 2 ] && [ "${DB_SIZE:-0}" -gt 50000 ]; then
  ok "Database snapshot: ${DB_AGE}d old, ${DB_SIZE} bytes"
elif [ "$DB_AGE" -le 2 ] && [ "${DB_SIZE:-0}" -le 50000 ]; then
  warn "Database snapshot: ${DB_AGE}d old but small (${DB_SIZE:-0} bytes — may be placeholder)"
else
  fail "Database snapshot: STALE — ${DB_AGE}d old (expected ≤2d)"
fi

# Full production backup — must be ≤2 days old + 100KB+
FULL_AGE=$(drive_age_days "gdrive:KandeVendTech-Backups/vend-full-backups/")
LATEST_FULL=$(rclone ls "gdrive:KandeVendTech-Backups/vend-full-backups/" 2>/dev/null | grep -v "latest" | sort | tail -1)
FULL_SIZE=$(echo "$LATEST_FULL" | awk '{print $1}')
FULL_COUNT=$(rclone ls "gdrive:KandeVendTech-Backups/vend-full-backups/" 2>/dev/null | grep -v "latest" | wc -l | tr -d ' ')
if [ "$FULL_AGE" -le 2 ] && [ "${FULL_SIZE:-0}" -gt 100000 ]; then
  ok "Full production backup: ${FULL_AGE}d old, ${FULL_SIZE} bytes, $FULL_COUNT total snapshots"
else
  fail "Full production backup: STALE or too small — ${FULL_AGE}d old, ${FULL_SIZE:-0} bytes"
fi

# =============================================================================
# 2. Kande VendTech Business Data — 4-slot rotation with staleness + data checks
# =============================================================================
log "Checking Kande VendTech Business Data slots..."
BIZ="gdrive:Kande VendTech Business Data"

# Slot definitions: slot name | max allowed age in days | description
declare -a SLOTS=("1-day:2:daily" "1-week:9:weekly" "1-month:35:monthly" "6-months:190:6-month")

for SLOT_DEF in "${SLOTS[@]}"; do
  SLOT=$(echo "$SLOT_DEF" | cut -d: -f1)
  MAX_AGE=$(echo "$SLOT_DEF" | cut -d: -f2)
  DESC=$(echo "$SLOT_DEF" | cut -d: -f3)

  SLOT_AGE=$(drive_age_days "$BIZ/$SLOT/")

  if [ "$SLOT_AGE" -ge 9999 ]; then
    fail "Slot $SLOT/ ($desc): NO FILES FOUND"
    continue
  fi

  if [ "$SLOT_AGE" -gt "$MAX_AGE" ]; then
    fail "Slot $SLOT/ ($DESC): STALE — ${SLOT_AGE}d old (max allowed: ${MAX_AGE}d)"
  else
    ok "Slot $SLOT/ ($DESC): ${SLOT_AGE}d old ✓ (max: ${MAX_AGE}d)"
  fi

  # Validate data in each file
  for TYPE in inventory orders sales; do
    RESULT=$(validate_slot_data "$BIZ/$SLOT/${TYPE}.json" "$TYPE" "$SLOT" 2>/dev/null)
    if [ -z "$RESULT" ]; then
      warn "Slot $SLOT/$TYPE: no validation output"
      continue
    fi
    # Each line from python is STATUS:message
    while IFS= read -r line; do
      [ -z "$line" ] && continue
      STATUS=$(echo "$line" | cut -d: -f1)
      MSG=$(echo "$line" | cut -d: -f2-)
      case "$STATUS" in
        OK)   ok "$MSG" ;;
        FAIL) fail "$MSG" ;;
        WARN) warn "$MSG" ;;
        *)    ok "$line" ;;
      esac
    done <<< "$RESULT"
  done
done

# History folder — check it has entries and is growing
for TYPE in inventory orders sales; do
  HIST_COUNT=$(rclone ls "$BIZ/history/${TYPE}/" 2>/dev/null | wc -l | tr -d ' ')
  HIST_AGE=$(drive_age_days "$BIZ/history/${TYPE}/")
  if [ "$HIST_COUNT" -ge 1 ] && [ "$HIST_AGE" -le 2 ]; then
    ok "history/$TYPE/: $HIST_COUNT dated archives, newest ${HIST_AGE}d old"
  elif [ "$HIST_COUNT" -ge 1 ]; then
    warn "history/$TYPE/: $HIST_COUNT files but newest is ${HIST_AGE}d old"
  else
    fail "history/$TYPE/: NO ARCHIVES FOUND"
  fi
done

# =============================================================================
# 3. Local files
# =============================================================================
log "Checking local files..."

for F in \
  "/Users/kurtishon/clawd/data/vend-backups/vend-full-latest.json" \
  "/Users/kurtishon/clawd/data/vend-backups/order-receipts-latest.json"; do
  if [ -f "$F" ] && [ -s "$F" ]; then
    SIZE=$(wc -c < "$F" | tr -d ' ')
    AGE=$(( (TODAY_EPOCH - $(date -r "$F" +%s)) / 86400 ))
    if [ "$AGE" -le 2 ] && [ "$SIZE" -gt 1000 ]; then
      ok "Local $(basename $F): ${AGE}d old, ${SIZE} bytes"
    elif [ "$AGE" -gt 2 ]; then
      fail "Local $(basename $F): STALE — ${AGE}d old"
    else
      warn "Local $(basename $F): suspiciously small (${SIZE} bytes)"
    fi
  else
    fail "Local $(basename $F): MISSING or empty"
  fi
done

IMG_COUNT=$(ls /Users/kurtishon/clawd/product-images/ 2>/dev/null | wc -l | tr -d ' ')
if [ "$IMG_COUNT" -ge 38 ]; then
  ok "Product images: $IMG_COUNT files saved locally"
else
  warn "Product images: only $IMG_COUNT found (expected ≥38)"
fi

ARCHIVE_COUNT=$(ls /Users/kurtishon/clawd/data/vend-backups/archive/ 2>/dev/null | wc -l | tr -d ' ')
ok "Local archive: $ARCHIVE_COUNT dated snapshots"

# =============================================================================
# 4. Production API — live data integrity
# =============================================================================
log "Checking production API..."

AUTH=$(curl -s -c "$COOKIE" \
  -X POST "https://vend.kandedash.com/api/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"password":"kande2026"}' 2>/dev/null)

if ! echo "$AUTH" | grep -q '"success":true'; then
  fail "Production API: authentication failed — cannot validate live data"
else
  curl -s -b "$COOKIE" "https://vend.kandedash.com/api/export/json" > "$TMP/live.json" 2>/dev/null

  python3 << PYEOF
import json, sys

try:
    with open("$TMP/live.json") as f:
        d = json.load(f)
except Exception as e:
    print(f"FAIL:Live export: JSON parse error — {e}")
    sys.exit(0)

products = d.get("products", [])
orders   = d.get("order_receipts", [])
sales    = d.get("sales", [])

issues = []
warnings = []

# Products
if len(products) == 0:
    issues.append("no products in live DB")
else:
    no_price = [p["name"] for p in products if not (p.get("price_per_unit") or p.get("cost_price"))]
    no_name  = [p for p in products if not p.get("name")]
    neg_stock = [p["name"] for p in products if p.get("stock", 0) < 0]
    if no_name:  issues.append(f"{len(no_name)} products with no name")
    if no_price: warnings.append(f"{len(no_price)} products with \$0 price: {no_name[:3]}")
    if neg_stock: issues.append(f"negative stock: {neg_stock[:3]}")

# Orders
for r in orders:
    total = r.get("total_charged") or r.get("total") or 0
    if total <= 0:
        warnings.append(f"order {r.get('vendhub_order_ref','?')} has \$0 total")
    if not r.get("items"):
        issues.append(f"order {r.get('vendhub_order_ref','?')} has no items")

# Export size sanity
export_size = len(json.dumps(d))
if export_size < 5000:
    issues.append(f"export suspiciously small ({export_size} bytes)")

if issues:
    print(f"FAIL:Live API: {'; '.join(issues)}")
elif warnings:
    stock = sum(p.get("stock",0) for p in products)
    print(f"WARN:Live API: {'; '.join(warnings)} | {len(products)} products, {len(orders)} orders, {stock} stock units")
else:
    stock = sum(p.get("stock",0) for p in products)
    order_val = sum((r.get("total_charged") or r.get("total") or 0) for r in orders)
    print(f"OK:Live API: {len(products)} products, {len(orders)} orders (\${order_val:.2f}), {stock} units — data looks good")
PYEOF

  API_RESULT=$(python3 << 'PYEOF2'
import subprocess, json
r = subprocess.run(["python3", "-c", "print('ok')"], capture_output=True)
PYEOF2
  )

  # Simpler: just check counts from live.json
  PROD_COUNT=$(python3 -c "import json; d=json.load(open('$TMP/live.json')); print(len(d.get('products',[])))" 2>/dev/null || echo 0)
  ORDER_COUNT=$(python3 -c "import json; d=json.load(open('$TMP/live.json')); print(len(d.get('order_receipts',[])))" 2>/dev/null || echo 0)
  EXPORT_BYTES=$(wc -c < "$TMP/live.json" | tr -d ' ')

  if [ "$PROD_COUNT" -ge 1 ] && [ "$EXPORT_BYTES" -gt 5000 ]; then
    ok "Live export: $PROD_COUNT products, $ORDER_COUNT orders, ${EXPORT_BYTES} bytes"
  else
    fail "Live export: only $PROD_COUNT products, ${EXPORT_BYTES} bytes — looks wrong"
  fi
fi

rm -f "$COOKIE"

# =============================================================================
# Summary & Telegram
# =============================================================================
TOTAL=$((PASS + FAIL + WARN))

if   [ "$FAIL" -eq 0 ] && [ "$WARN" -eq 0 ]; then HEADLINE="All systems healthy"; EMOJI="🟢"
elif [ "$FAIL" -eq 0 ];                        then HEADLINE="Mostly OK — $WARN warning(s)"; EMOJI="🟡"
else                                                HEADLINE="Issues detected — $FAIL failure(s)"; EMOJI="🔴"
fi

log "Health check done — $PASS passed, $WARN warned, $FAIL failed"

MSG="${EMOJI} *Monthly Backup Health Check — ${TODAY}*
${HEADLINE}
Passed: ${PASS} | Warned: ${WARN} | Failed: ${FAIL} | Total checks: ${TOTAL}

$(echo -e "$REPORT")"

openclaw message send \
  --channel telegram \
  --target -4992441037 \
  --message "$MSG" 2>/dev/null || true

log "========== Health check complete =========="
