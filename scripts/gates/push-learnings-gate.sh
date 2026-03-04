#!/bin/bash
# Gate + Execute: push-learnings
# Runs the script directly — no LLM needed unless it fails

RESULT=$(python3 /Users/kurtishon/clawd/scripts/push-learnings.py 2>&1)
EXIT_CODE=$?

if [ $EXIT_CODE -eq 0 ]; then
  exit 1  # No LLM needed
else
  echo "PUSH_LEARNINGS_FAIL: $RESULT"
  exit 0  # Escalate to LLM
fi
