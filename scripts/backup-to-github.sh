#!/bin/bash
# Backup vend.kandedash.com production data to GitHub
# - Full raw DB dump (155+ keys, including prospect_photos)
# - Settings + SEO sidecar files
# - Updates restore-backup.json in kande-vendtech repo (Railway auto-restore on crash)
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
set -euo pipefail

WORKSPACE="/Users/kurtishon/clawd"
VENDTECH_REPO="$WORKSPACE/kande-vendtech"
LOG_FILE="$WORKSPACE/logs/github-backup.log"
BACKUP_DATE=$(date +%Y-%m-%d)
BACKUP_TIME=$(date +%H%M)
API_KEY="kande2026"
CRM="https://sales.kandedash.com"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"; }
alert() {
  local msg="$1"
  curl -s -X POST "http://127.0.0.1:18789/tools/invoke" \
    -H "Authorization: Bearer 110e9bb6f3803d96f448ab21c8c8ec5cae10bb7b9a647dba" \
    -H "Content-Type: application/json" \
    -d "{\"tool\":\"message\",\"action\":\"json\",\"args\":{\"action\":\"send\",\"target\":\"-4992441037\",\"message\":\"⚠️ Vend backup FAILED: $msg\"}}" > /dev/null 2>&1 || true
}

log "===== GitHub backup started ($BACKUP_DATE $BACKUP_TIME) ====="

cd "$WORKSPACE"

# ── Step 1: Full raw DB dump (retry up to 5x with 30s backoff) ───────────────
FULL_JSON=""
for attempt in 1 2 3 4 5; do
  FULL_JSON=$(curl -s --max-time 90 -H "x-api-key: $API_KEY" "$CRM/api/backup/raw-db" 2>/dev/null)
  if [ -n "$FULL_JSON" ] && echo "$FULL_JSON" | python3 -c "import json,sys; json.load(sys.stdin)" 2>/dev/null; then
    break
  fi
  log "⚠️ Raw DB export attempt $attempt failed — retrying in 30s"
  FULL_JSON=""
  [ "$attempt" -lt 5 ] && sleep 30
done

if [ -z "$FULL_JSON" ]; then
  log "❌ Raw DB export failed after 5 attempts — aborting"
  alert "Raw DB export failed after 5 attempts ($BACKUP_DATE $BACKUP_TIME)"
  exit 1
fi

if ! echo "$FULL_JSON" | python3 -c "import json,sys; d=json.load(sys.stdin); sys.exit(0 if d.get('prospects') is not None else 1)" 2>/dev/null; then
  log "❌ Export missing prospects key — aborting"
  alert "Export missing prospects key — DB may be corrupt ($BACKUP_DATE $BACKUP_TIME)"
  exit 1
fi

SUMMARY=$(echo "$FULL_JSON" | python3 -c "
import json,sys
d=json.load(sys.stdin)
prospects  = len(d.get('prospects', []))
activities = len(d.get('activities', []))
products   = len(d.get('products', []))
photos     = len(d.get('prospect_photos', []))
orders     = len(d.get('order_receipts', []))
keys       = len(d.keys())
print(f'prospects:{prospects}, activities:{activities}, products:{products}, photos:{photos}, orders:{orders}, db_keys:{keys}')
" 2>/dev/null)
log "📦 Raw export OK — $SUMMARY"

# Save to clawd repo
mkdir -p data/vend-backups/archive
echo "$FULL_JSON" > data/vend-backups/vend-full-latest.json
echo "$FULL_JSON" > "data/vend-backups/archive/vend-full-${BACKUP_DATE}.json"

# Extract order receipts separately
echo "$FULL_JSON" | python3 -c "import json,sys; d=json.load(sys.stdin); print(json.dumps(d.get('order_receipts',[]), indent=2))" > data/vend-backups/order-receipts-latest.json

# ── Step 2: Settings + SEO sidecar files ─────────────────────────────────────
SETTINGS_JSON=$(curl -s --max-time 15 -H "x-api-key: $API_KEY" "$CRM/api/settings" 2>/dev/null)
SEO_JSON=$(curl -s --max-time 15 -H "x-api-key: $API_KEY" "$CRM/api/seo" 2>/dev/null)

if echo "$SETTINGS_JSON" | python3 -c "import json,sys; json.load(sys.stdin)" 2>/dev/null; then
  echo "$SETTINGS_JSON" > data/vend-backups/settings.json
  log "⚙️  Settings backed up"
fi
if echo "$SEO_JSON" | python3 -c "import json,sys; json.load(sys.stdin)" 2>/dev/null; then
  echo "$SEO_JSON" > data/vend-backups/seo.json
  log "🔍 SEO data backed up"
fi

# ── Step 3: Update restore-backup.json in kande-vendtech repo ─────────────────
# This is the critical file — Railway reads it on startup to auto-restore after a crash
if [ -d "$VENDTECH_REPO" ]; then
  echo "$FULL_JSON" > "$VENDTECH_REPO/restore-backup.json"
  cd "$VENDTECH_REPO"
  git add restore-backup.json 2>/dev/null || true
  if git diff --cached --quiet; then
    log "ℹ️  restore-backup.json unchanged"
  else
    git commit -m "restore-backup: auto-update $BACKUP_DATE $BACKUP_TIME — $SUMMARY" 2>&1 | tail -2 | tee -a "$LOG_FILE"
    git pull --rebase --autostash origin main 2>&1 | tail -2 | tee -a "$LOG_FILE" || true
    git push origin main 2>&1 | tail -2 | tee -a "$LOG_FILE"
    log "✅ restore-backup.json pushed → Railway will auto-restore from this on next crash"
  fi
  cd "$WORKSPACE"
else
  log "⚠️  kande-vendtech repo not found at $VENDTECH_REPO — skipping restore-backup update"
fi

# ── Step 4: Commit + push main clawd repo ─────────────────────────────────────
git add data/vend-backups/ 2>/dev/null || true
if git diff --cached --quiet; then
  log "ℹ️  No changes since last backup — skipping commit"
else
  git commit -m "backup: vend snapshot $BACKUP_DATE $BACKUP_TIME — $SUMMARY" 2>&1 | tail -3 | tee -a "$LOG_FILE"
  git pull --rebase --autostash origin main 2>&1 | tail -2 | tee -a "$LOG_FILE" || true
  git push origin main 2>&1 | tail -3 | tee -a "$LOG_FILE"
  log "✅ Pushed to GitHub (clawd repo)"
fi

log "===== GitHub backup complete ====="
