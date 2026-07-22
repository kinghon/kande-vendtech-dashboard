#!/bin/bash
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
# ============================================================================
# Kande VendTech — Automated Daily Backup to Google Drive
# Author: Forge (Infrastructure Team)
# Updated: 2025-02-01
#
# Usage:  ./backup-to-gdrive.sh [--dry-run] [--verbose]
# Cron:   0 3 * * * /Users/kurtishon/clawd/scripts/backup-to-gdrive.sh
#
# What gets backed up:
#   - Entire workspace (code, configs, docs)
#   - Dashboard JSON database snapshot (separate copy for quick restore)
#   - Memory files and agent state
#
# Retention: 7 daily backups on Google Drive (older auto-deleted)
# ============================================================================

set -euo pipefail

# --- Configuration ---
WORKSPACE="/Users/kurtishon/clawd"
GDRIVE_REMOTE="gdrive:KandeVendTech-Backups"
BACKUP_DATE=$(date +%Y-%m-%d)
BACKUP_TIME=$(date +%H%M)
BACKUP_NAME="kande-backup-${BACKUP_DATE}-${BACKUP_TIME}.tar.gz"
DB_BACKUP_NAME="database-${BACKUP_DATE}.json"
TEMP_DIR="/tmp/kande-backup-$$"
LOG_FILE="$WORKSPACE/logs/backup.log"
RETENTION_DAYS=8
DRY_RUN=false
VERBOSE=false

# --- Parse args ---
for arg in "$@"; do
  case $arg in
    --dry-run)  DRY_RUN=true ;;
    --verbose)  VERBOSE=true ;;
  esac
done

# --- Functions ---
log() {
  local msg="[$(date '+%Y-%m-%d %H:%M:%S')] $1"
  echo "$msg" >> "$LOG_FILE"
  $VERBOSE && echo "$msg" || true
}

error_exit() {
  log "❌ ERROR: $1"
  rm -rf "$TEMP_DIR"
  exit 1
}

cleanup() {
  rm -rf "$TEMP_DIR"
  log "Temp files cleaned up"
}

trap cleanup EXIT

# --- Pre-flight checks ---
mkdir -p "$WORKSPACE/logs" "$TEMP_DIR"

# Check rclone is available
command -v rclone >/dev/null 2>&1 || error_exit "rclone not found in PATH"

# Check rclone remote is configured
rclone listremotes 2>/dev/null | grep -q "gdrive:" || error_exit "gdrive: remote not configured in rclone"

log "========================================="
log "🔧 Backup started (${BACKUP_DATE})"
log "========================================="

# --- Step 1: Snapshot the database ---
log "📦 Step 1: Snapshotting database..."

# Local dashboard data
DASHBOARD_DB="$WORKSPACE/data/data.json"
if [ -f "$DASHBOARD_DB" ]; then
  cp "$DASHBOARD_DB" "$TEMP_DIR/$DB_BACKUP_NAME"
  DB_SIZE=$(du -h "$TEMP_DIR/$DB_BACKUP_NAME" | cut -f1)
  log "  Database snapshot: $DB_SIZE"
else
  log "  ⚠ Local dashboard DB not found at $DASHBOARD_DB (may be production-only)"
  # Create a placeholder
  echo '{"note":"No local database found — data lives on Railway /data/data.json"}' > "$TEMP_DIR/$DB_BACKUP_NAME"
fi

# --- Step 2: Create workspace archive ---
log "📦 Step 2: Creating workspace archive..."

cd "$WORKSPACE"
tar -czf "$TEMP_DIR/$BACKUP_NAME" \
  --exclude='node_modules' \
  --exclude='.git/objects' \
  --exclude='.git/pack' \
  --exclude='*.mp4' \
  --exclude='*.mov' \
  --exclude='*.zip' \
  --exclude='*.tar.gz' \
  --exclude='/tmp' \
  --exclude='logs/*.log' \
  . 2>/dev/null || error_exit "Failed to create archive"

ARCHIVE_SIZE=$(du -h "$TEMP_DIR/$BACKUP_NAME" | cut -f1)
log "  Archive created: $BACKUP_NAME ($ARCHIVE_SIZE)"

# --- Step 3: Upload to Google Drive ---
log "📤 Step 3: Uploading to Google Drive..."

if $DRY_RUN; then
  log "  [DRY RUN] Would upload $BACKUP_NAME to $GDRIVE_REMOTE/daily/"
  log "  [DRY RUN] Would upload $DB_BACKUP_NAME to $GDRIVE_REMOTE/database/"
else
  # Upload full archive
  rclone copy "$TEMP_DIR/$BACKUP_NAME" "$GDRIVE_REMOTE/daily/" \
    --progress 2>> "$LOG_FILE" \
    || error_exit "Failed to upload archive to Google Drive"

  # Upload database snapshot separately (for quick restore)
  rclone copy "$TEMP_DIR/$DB_BACKUP_NAME" "$GDRIVE_REMOTE/database/" \
    --progress 2>> "$LOG_FILE" \
    || error_exit "Failed to upload database snapshot"

  log "  ✅ Upload complete"
fi

# --- Step 4: Enforce retention policy ---
log "🗑️ Step 4: Enforcing ${RETENTION_DAYS}-day retention..."

if ! $DRY_RUN; then
  # Delete daily backups older than retention period
  rclone delete "$GDRIVE_REMOTE/daily/" \
    --min-age "${RETENTION_DAYS}d" \
    --include "kande-backup-*.tar.gz" 2>> "$LOG_FILE" || true

  # Keep last 14 database snapshots (they're small)
  rclone delete "$GDRIVE_REMOTE/database/" \
    --min-age "15d" \
    --include "database-*.json" 2>> "$LOG_FILE" || true

  log "  Old backups pruned"
else
  log "  [DRY RUN] Would prune backups older than ${RETENTION_DAYS} days"
fi

# --- Step 5: Verification ---
log "✔️ Step 5: Verifying upload..."

if ! $DRY_RUN; then
  REMOTE_FILES=$(rclone ls "$GDRIVE_REMOTE/daily/" --include "*${BACKUP_DATE}*" 2>/dev/null | wc -l | tr -d ' ')
  if [ "$REMOTE_FILES" -ge 1 ]; then
    log "  ✅ Verified: backup exists on Google Drive"
  else
    log "  ⚠️ WARNING: Could not verify backup on Google Drive"
  fi

  # Count total backups
  TOTAL_BACKUPS=$(rclone ls "$GDRIVE_REMOTE/daily/" 2>/dev/null | wc -l | tr -d ' ')
  log "  Total daily backups on Drive: $TOTAL_BACKUPS"
fi

# --- Summary ---
log "========================================="
log "✅ Backup complete!"
log "  Archive: $BACKUP_NAME ($ARCHIVE_SIZE)"
log "  Database: $DB_BACKUP_NAME"
log "  Destination: $GDRIVE_REMOTE"
$DRY_RUN && log "  ⚠ DRY RUN — nothing was uploaded"
log "========================================="


# =============================================================================
# FULL PRODUCTION DATA BACKUP — pulls everything from vend.kandedash.com
# =============================================================================
log "🗄️  Step 6: Full production data backup..."

VEND_BACKUP_DIR="$WORKSPACE/data/vend-backups"
VEND_ARCHIVE_DIR="$VEND_BACKUP_DIR/archive"
mkdir -p "$VEND_ARCHIVE_DIR"

FULL_BACKUP_FILE="$VEND_ARCHIVE_DIR/vend-full-${BACKUP_DATE}.json"
LATEST_FILE="$VEND_BACKUP_DIR/vend-full-latest.json"
ORDERS_LATEST="$VEND_BACKUP_DIR/order-receipts-latest.json"
ORDERS_ARCHIVE="$VEND_BACKUP_DIR/archive/orders-${BACKUP_DATE}.json"

# Authenticated export via Python helper (curl cookie auth is unreliable on Railway)
FULL_JSON=$(python3 /Users/kurtishon/clawd/kande-vendtech/scripts/crm-export.py 2>>"$LOG_FILE")
COUNT=$(echo "$FULL_JSON" | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d.get('prospects',[])))" 2>/dev/null || echo 0)
log "  Using sales.kandedash.com ($COUNT prospects)"











if [ -n "$FULL_JSON" ] && echo "$FULL_JSON" | python3 -c "import json,sys; json.load(sys.stdin)" 2>/dev/null; then
  SUMMARY=$(echo "$FULL_JSON" | python3 -c "import json,sys; d=json.load(sys.stdin); print(f\"products:{len(d.get('products',[]))}, orders:{len(d.get('order_receipts',[]))}, prospects:{len(d.get('prospects',[]))}, finances:{len(d.get('finances',[]))}\")" 2>/dev/null) || true
  echo "$FULL_JSON" > "$FULL_BACKUP_FILE"
  echo "$FULL_JSON" > "$LATEST_FILE"
  log "  📦 Full export: $SUMMARY"

  echo "$FULL_JSON" | python3 -c "import json,sys; d=json.load(sys.stdin); print(json.dumps(d.get('order_receipts',[]), indent=2))" > "$ORDERS_LATEST"
  cp "$ORDERS_LATEST" "$ORDERS_ARCHIVE"
  log "  📋 Order receipts extracted separately"

  if ! $DRY_RUN; then
    rclone copy "$FULL_BACKUP_FILE" "$GDRIVE_REMOTE/vend-full-backups/" 2>> "$LOG_FILE" \
      && log "  ✅ Full backup → Drive/vend-full-backups/" \
      || log "  ⚠ Failed to upload full backup"

    rclone copy "$ORDERS_ARCHIVE" "$GDRIVE_REMOTE/order-receipts/" 2>> "$LOG_FILE" || true
    rclone copy "$ORDERS_LATEST" "$GDRIVE_REMOTE/order-receipts/" 2>> "$LOG_FILE" || true
    log "  ✅ Orders → Drive/order-receipts/"

    rclone copy "$LATEST_FILE" "$GDRIVE_REMOTE/vend-full-backups/" 2>> "$LOG_FILE" || true

    # Also save a separate dated activities-only backup so field activity is never lost
    echo "$FULL_JSON" | python3 -c "import json,sys; d=json.load(sys.stdin); print(json.dumps({'exported_at':d.get('exported_at'),'activities':d.get('activities',[]),'prospects_count':len(d.get('prospects',[]))}, indent=2))" \
      > "/tmp/activities-${BACKUP_DATE}.json" 2>/dev/null
    rclone copy "/tmp/activities-${BACKUP_DATE}.json" "$GDRIVE_REMOTE/activities-backups/" 2>> "$LOG_FILE" \
      && log "  ✅ Activities backup → Drive/activities-backups/" \
      || log "  ⚠ Activities backup upload failed"
    rm -f "/tmp/activities-${BACKUP_DATE}.json"

    DRIVE_COUNT=$(rclone ls "$GDRIVE_REMOTE/vend-full-backups/" 2>/dev/null | wc -l | tr -d ' ')
    log "  Total full backups on Drive: $DRIVE_COUNT"
  fi
else
  log "  ⚠ Auth/export failed — API returned empty or invalid JSON"
fi


# =============================================================================
# STEP 7: Kande-Business-Data — dedicated files per data type
# =============================================================================
log "📊 Step 7: Exporting business data files to Kande-Business-Data..."
bash /Users/kurtishon/clawd/scripts/export-business-data.sh || log "  ⚠ Business data export had errors (non-fatal)"
