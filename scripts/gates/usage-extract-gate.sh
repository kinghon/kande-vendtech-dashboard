#!/bin/bash
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
# Gate + Execute: usage-data-extract
# Runs the script directly — no LLM needed unless it fails

RESULT=$(python3 /Users/kurtishon/clawd/scripts/extract-usage-turns.py 2>&1)
EXIT_CODE=$?

if [ $EXIT_CODE -eq 0 ]; then
  exit 1  # No LLM needed
else
  echo "USAGE_EXTRACT_FAIL: $RESULT"
  exit 0  # Escalate to LLM
fi
