#!/bin/bash
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
# Gate + Execute: auto-draft-email0
# Runs the Python script directly — it already has its own "no work" detection
# Only escalate to LLM if drafts were actually created

RESULT=$(python3 /Users/kurtishon/clawd/pb-info-src/scripts/auto-draft-email0.py 2>&1)
EXIT_CODE=$?

if echo "$RESULT" | grep -q "DRAFTED:"; then
  echo "$RESULT"
  exit 0  # Drafts created — LLM should report to Kurtis
elif echo "$RESULT" | grep -q "NO_EMAIL:"; then
  echo "$RESULT"
  exit 0  # Missing emails — alert Kurtis to add them
elif echo "$RESULT" | grep -q "No new draft targets"; then
  exit 1  # Nothing to do
elif [ $EXIT_CODE -ne 0 ]; then
  # Log the error but do NOT escalate to LLM — Kimi writing drafts from scratch breaks format
  echo "[auto-draft-email0] ERROR: $RESULT" >> /Users/kurtishon/clawd/logs/auto-draft-email0-errors.log
  exit 1
else
  exit 1  # Default: nothing notable
fi
