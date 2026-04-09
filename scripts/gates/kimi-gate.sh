#!/bin/bash
# Universal Kimi gate — call before ANY Kimi work
# Usage: bash /Users/kurtishon/clawd/scripts/gates/kimi-gate.sh "job-name"
# Exit 0 = proceed (lock acquired)
# Exit 1 = skip (Kimi busy)

JOB_NAME="${1:-unknown}"
LOCK_FILE="/tmp/kimi-lock"
STALE_SECONDS=3600

# Check existing lock
if [ -f "$LOCK_FILE" ]; then
  lock_age=$(( $(date +%s) - $(stat -f %m "$LOCK_FILE" 2>/dev/null || echo 0) ))
  if [ "$lock_age" -lt "$STALE_SECONDS" ]; then
    lock_owner=$(cat "$LOCK_FILE" 2>/dev/null)
    echo "KIMI_BUSY|$lock_owner|${lock_age}s"
    exit 1
  fi
  # Stale — break it
  echo "STALE_LOCK_BROKEN|${lock_age}s"
  rm -f "$LOCK_FILE"
fi

# Acquire
echo "$JOB_NAME|$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$LOCK_FILE"
echo "LOCK_ACQUIRED|$JOB_NAME"
exit 0
