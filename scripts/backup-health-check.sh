#!/bin/bash
# =============================================================================
# Kande Backup Health Check — runs monthly, reports to Telegram
# Checks: Google Drive folders, local files, production API data integrity
# =============================================================================
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

LOG_FILE="/Users/kurtishon/clawd/logs/backup.log"
COOKIE="/tmp/kande-healthcheck-cookies.txt"
TODAY=$(date +%Y-%m-%d)
MONTH_AGO=$(date -v-32d +%Y-%m-%d 2>/dev/null || date -d '32 days ago' +%Y-%m-%d)

PASS=0
FAIL=0
WARN=0
REPORT=""

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [HEALTH] $1" >> "$LOG_FILE"; }
ok()   { REPORT="${REPORT}✅ $1\n"; PASS=$((PASS+1)); log "OK: $1"; }
fail() { REPORT="${REPORT}❌ $1\n"; FAIL=$((FAIL+1)); log "FAIL: $1"; }
warn() { REPORT="${REPORT}⚠️ $1\n"; WARN=$((WARN+1)); log "WARN: $1"; }

log "========== Monthly backup health check =========="

# ── 1. Google Drive: KandeVendTech-Backups ──────────────────────────────────
log "Checking KandeVendTech-Backups..."

# Daily backup (must have one from last 2 days)
LATEST_DAILY=$(rclone ls "gdrive:KandeVendTech-Backups/daily/" 2>/dev/null | sort | tail -1)
if [ -n "$LATEST_DAILY" ]; then
  DAILY_DATE=$(echo "$LATEST_DAILY" | grep -o '[0-9]\{4\}-[0-9]\{2\}-[0-9]\{2\}' | tail -1)
  DAYS_OLD=$(( ($(date +%s) - $(date -j -f "%Y-%m-%d" "$DAILY_DATE" +%s 2>/dev/null || date -d "$DAILY_DATE" +%s)) / 86400 ))
  if [ "$DAYS_OLD" -le 2 ]; then
    ok "Daily workspace backup current ($DAILY_DATE, ${DAYS_OLD}d old)"
  else
    fail "Daily workspace backup stale — last: $DAILY_DATE (${DAYS_OLD}d ago)"
  fi
else
  fail "No daily backups found in KandeVendTech-Backups/daily/"
fi

# Database snapshot
LATEST_DB=$(rclone ls "gdrive:KandeVendTech-Backups/database/" 2>/dev/null | sort | tail -1)
if [ -n "$LATEST_DB" ]; then
  DB_DATE=$(echo "$LATEST_DB" | grep -o '[0-9]\{4\}-[0-9]\{2\}-[0-9]\{2\}' | tail -1)
  DB_SIZE=$(echo "$LATEST_DB" | awk '{print $1}')
  DAYS_OLD=$(( ($(date +%s) - $(date -j -f "%Y-%m-%d" "$DB_DATE" +%s 2>/dev/null || date -d "$DB_DATE" +%s)) / 86400 ))
  if [ "$DAYS_OLD" -le 2 ] && [ "$DB_SIZE" -gt 10000 ]; then
    ok "Database snapshot current ($DB_DATE, ${DB_SIZE} bytes)"
  elif [ "$DAYS_OLD" -gt 2 ]; then
    fail "Database snapshot stale — last: $DB_DATE (${DAYS_OLD}d ago)"
  else
    warn "Database snapshot small (${DB_SIZE} bytes) — may be placeholder"
  fi
else
  fail "No database snapshots found"
fi

# Full production backup
FULL_COUNT=$(rclone ls "gdrive:KandeVendTech-Backups/vend-full-backups/" 2>/dev/null | grep -v "latest" | wc -l | tr -d ' ')
LATEST_FULL=$(rclone ls "gdrive:KandeVendTech-Backups/vend-full-backups/" 2>/dev/null | grep -v "latest" | sort | tail -1)
if [ "$FULL_COUNT" -ge 1 ] && [ -n "$LATEST_FULL" ]; then
  FULL_DATE=$(echo "$LATEST_FULL" | grep -o '[0-9]\{4\}-[0-9]\{2\}-[0-9]\{2\}' | tail -1)
  FULL_SIZE=$(echo "$LATEST_FULL" | awk '{print $1}')
  DAYS_OLD=$(( ($(date +%s) - $(date -j -f "%Y-%m-%d" "$FULL_DATE" +%s 2>/dev/null || date -d "$FULL_DATE" +%s)) / 86400 ))
  if [ "$DAYS_OLD" -le 2 ] && [ "$FULL_SIZE" -gt 100000 ]; then
    ok "Full production backup current ($FULL_DATE, $FULL_COUNT total snapshots)"
  else
    fail "Full backup stale or small — last: $FULL_DATE (${DAYS_OLD}d ago, ${FULL_SIZE} bytes)"
  fi
else
  fail "No full production backups found"
fi

# Order receipts
ORDER_COUNT=$(rclone ls "gdrive:KandeVendTech-Backups/order-receipts/" 2>/dev/null | grep -c "orders-" || echo 0)
if [ "$ORDER_COUNT" -ge 1 ]; then
  ok "Order receipt archives: $ORDER_COUNT dated files"
else
  warn "No order receipt archives in KandeVendTech-Backups/order-receipts/"
fi

# ── 2. Google Drive: Kande-Business-Data ────────────────────────────────────
log "Checking Kande-Business-Data..."

for FILE in inventory.json orders.json sales.json; do
  INFO=$(rclone ls "gdrive:Kande-Business-Data/$FILE" 2>/dev/null)
  if [ -n "$INFO" ]; then
    SIZE=$(echo "$INFO" | awk '{print $1}')
    if [ "$SIZE" -gt 100 ]; then
      ok "Kande-Business-Data/$FILE present (${SIZE} bytes)"
    else
      warn "Kande-Business-Data/$FILE exists but tiny (${SIZE} bytes)"
    fi
  else
    fail "Kande-Business-Data/$FILE missing"
  fi
done

# Check history subfolders have recent entries
for TYPE in inventory orders sales; do
  HIST_COUNT=$(rclone ls "gdrive:Kande-Business-Data/history/${TYPE}/" 2>/dev/null | wc -l | tr -d ' ')
  if [ "$HIST_COUNT" -ge 1 ]; then
    ok "Kande-Business-Data/history/${TYPE}/: $HIST_COUNT dated archives"
  else
    warn "Kande-Business-Data/history/${TYPE}/ is empty"
  fi
done

# ── 3. Local file checks ─────────────────────────────────────────────────────
log "Checking local files..."

for F in \
  "/Users/kurtishon/clawd/data/vend-backups/vend-full-latest.json" \
  "/Users/kurtishon/clawd/data/vend-backups/order-receipts-latest.json"; do
  if [ -f "$F" ] && [ -s "$F" ]; then
    SIZE=$(wc -c < "$F" | tr -d ' ')
    AGE=$(( ($(date +%s) - $(date -r "$F" +%s)) / 86400 ))
    if [ "$AGE" -le 2 ]; then
      ok "Local: $(basename $F) current (${SIZE} bytes, ${AGE}d old)"
    else
      warn "Local: $(basename $F) stale (${AGE}d old)"
    fi
  else
    fail "Local: $(basename $F) missing or empty"
  fi
done

# Product images
IMG_COUNT=$(ls /Users/kurtishon/clawd/product-images/ 2>/dev/null | wc -l | tr -d ' ')
if [ "$IMG_COUNT" -ge 38 ]; then
  ok "Product images: $IMG_COUNT files saved locally"
else
  warn "Product images: only $IMG_COUNT found (expected 38)"
fi

# Local archive count
ARCHIVE_COUNT=$(ls /Users/kurtishon/clawd/data/vend-backups/archive/ 2>/dev/null | wc -l | tr -d ' ')
ok "Local archive: $ARCHIVE_COUNT dated snapshots"

# ── 4. Production API integrity ──────────────────────────────────────────────
log "Checking production API..."

AUTH=$(curl -s -c "$COOKIE" \
  -X POST "https://vend.kandedash.com/api/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"password":"kande2026"}' 2>/dev/null)

if echo "$AUTH" | grep -q '"success":true'; then
  # Products
  PROD_COUNT=$(curl -s -b "$COOKIE" "https://vend.kandedash.com/api/products" 2>/dev/null \
    | python3 -c "import json,sys; p=json.load(sys.stdin); print(len(p))" 2>/dev/null || echo 0)
  if [ "$PROD_COUNT" -ge 1 ]; then
    ok "Production API: $PROD_COUNT products live"
  else
    fail "Production API: no products returned"
  fi

  # Orders
  ORDER_LIVE=$(curl -s -b "$COOKIE" "https://vend.kandedash.com/api/order-receipts" 2>/dev/null \
    | python3 -c "import json,sys; r=json.load(sys.stdin); print(len(r))" 2>/dev/null || echo 0)
  if [ "$ORDER_LIVE" -ge 1 ]; then
    ok "Production API: $ORDER_LIVE order receipt(s) live"
  else
    warn "Production API: no order receipts yet"
  fi

  # Export endpoint
  EXPORT_SIZE=$(curl -s -b "$COOKIE" "https://vend.kandedash.com/api/export/json" 2>/dev/null | wc -c | tr -d ' ')
  if [ "$EXPORT_SIZE" -gt 10000 ]; then
    ok "Export endpoint healthy (${EXPORT_SIZE} bytes)"
  else
    fail "Export endpoint returning small/empty response (${EXPORT_SIZE} bytes)"
  fi
else
  fail "Production API: authentication failed"
fi

rm -f "$COOKIE"

# ── Summary & Telegram report ────────────────────────────────────────────────
TOTAL=$((PASS + FAIL + WARN))
if [ "$FAIL" -eq 0 ] && [ "$WARN" -eq 0 ]; then
  HEADLINE="✅ All backup systems healthy"
  EMOJI="🟢"
elif [ "$FAIL" -eq 0 ]; then
  HEADLINE="🟡 Backups mostly OK — $WARN warning(s)"
  EMOJI="🟡"
else
  HEADLINE="🔴 Backup issues detected — $FAIL failure(s)"
  EMOJI="🔴"
fi

MSG="$EMOJI *Monthly Backup Health Check — $TODAY*

$HEADLINE
Passed: $PASS / $TOTAL checks

$(echo -e "$REPORT" | head -40)
_Next check: 1st of next month_"

log "Health check done — $PASS passed, $WARN warned, $FAIL failed"

# Send to Telegram (Kurtis DM)
python3 << PYEOF
import urllib.request, urllib.parse, json, os

token = None
# Try to get token from openclaw config
try:
    import subprocess
    r = subprocess.run(['grep', '-r', 'telegram.*token\|bot.*token', 
                       os.path.expanduser('~/.openclaw/'), '--include=*.json', '-l'],
                       capture_output=True, text=True)
except: pass

# Use openclaw messaging via CLI
msg = """$MSG"""
try:
    result = subprocess.run(
        ['openclaw', 'message', 'send', '--channel', 'telegram', 
         '--target', '882436227', '--message', msg],
        capture_output=True, text=True, timeout=15
    )
    if result.returncode == 0:
        print("  Telegram notification sent")
    else:
        print(f"  Telegram send failed: {result.stderr[:100]}")
except Exception as e:
    print(f"  Could not send Telegram: {e}")
PYEOF

log "========== Health check complete =========="
