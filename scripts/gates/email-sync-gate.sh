#!/bin/bash
# Gate for vendtech-sent-email-sync
# Tracks processed Gmail thread IDs to prevent duplicate CRM activity logging
# Exit 0 = new threads to process (with thread IDs in output)
# Exit 1 = nothing new

PROCESSED_FILE="/Users/kurtishon/clawd/logs/processed-email-threads.json"
mkdir -p "$(dirname "$PROCESSED_FILE")"

# Initialize if missing
if [ ! -f "$PROCESSED_FILE" ]; then
  echo "[]" > "$PROCESSED_FILE"
fi

# Get sent emails from last 3 days
SENT=$(GOG_KEYRING_PASSWORD=kandepb2026 gog gmail search \
  'from:kurtis@kandevendtech.com subject:"Visit Follow-Up" in:sent newer_than:3d' \
  --account=kurtis@kandevendtech.com --plain --no-input 2>/dev/null | grep -v "^ID" | awk '{print $1}')

if [ -z "$SENT" ]; then
  exit 1
fi

# Check which thread IDs are new
PROCESSED=$(cat "$PROCESSED_FILE")
NEW_THREADS=""
for thread_id in $SENT; do
  if ! echo "$PROCESSED" | grep -q "$thread_id"; then
    NEW_THREADS="$NEW_THREADS $thread_id"
  fi
done

if [ -z "$NEW_THREADS" ]; then
  exit 1
fi

echo "NEW_THREADS:$NEW_THREADS"
exit 0
