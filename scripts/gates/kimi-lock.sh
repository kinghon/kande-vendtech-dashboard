#!/bin/bash
# Kimi serialization lock
# Usage: source this at the top of any Kimi job
#   source /Users/kurtishon/clawd/scripts/gates/kimi-lock.sh
#   If exit code 1 → Kimi is busy, skip this run
#   If exit code 0 → lock acquired, proceed
#   MUST call kimi_unlock when done (or trap handles it)

LOCK_FILE="/tmp/kimi-lock"
LOCK_STALE_SECONDS=3600  # force-expire after 1 hour (stuck job protection)

kimi_unlock() {
  rm -f "$LOCK_FILE" 2>/dev/null
}

# Check if lock exists and isn't stale
if [ -f "$LOCK_FILE" ]; then
  lock_age=$(( $(date +%s) - $(stat -f %m "$LOCK_FILE" 2>/dev/null || echo 0) ))
  if [ "$lock_age" -lt "$LOCK_STALE_SECONDS" ]; then
    lock_owner=$(cat "$LOCK_FILE" 2>/dev/null)
    echo "KIMI_BUSY: locked by $lock_owner (${lock_age}s ago)"
    exit 1
  else
    echo "KIMI_STALE_LOCK: lock expired after ${lock_age}s, breaking it"
    rm -f "$LOCK_FILE"
  fi
fi

# Acquire lock
echo "${CRON_JOB_NAME:-unknown} (pid $$) at $(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$LOCK_FILE"

# Auto-unlock on exit (normal or crash)
trap kimi_unlock EXIT
