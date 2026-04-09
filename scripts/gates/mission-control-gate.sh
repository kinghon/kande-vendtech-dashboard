#!/bin/bash
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
# Gate + Execute: mission-control-sync
# Does the full job in bash — no LLM needed unless it fails

# Step 1: Dump cron list
openclaw cron list --json > /tmp/mc-cron-cache.json 2>/dev/null

# Step 2: Run sync
RESULT=$(MC_URL=https://kande-mission-control-production.up.railway.app bash /Users/kurtishon/clawd/scripts/sync-mission-control.sh 2>&1)
EXIT_CODE=$?

if [ $EXIT_CODE -eq 0 ] && echo "$RESULT" | grep -q "sync complete"; then
  echo "MC_SYNC_OK: $(echo "$RESULT" | tail -1)"
  exit 1  # No LLM needed
else
  echo "MC_SYNC_FAIL:"
  echo "$RESULT"
  exit 0  # Escalate to LLM
fi
