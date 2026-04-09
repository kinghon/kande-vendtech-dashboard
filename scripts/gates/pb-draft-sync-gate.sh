#!/bin/bash
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
# Gate: pb-gmail-draft-sync
# Check if ANY inbox emails have approved=true before spinning up Sonnet
# Exit 0 (with output) = work to do, Exit 0 (no output) = skip

INBOX=$(/usr/bin/curl -s 'https://pb.kandedash.com/api/inbox' -H 'Authorization: Bearer kpb-ops-2026' 2>/dev/null)

if [ -z "$INBOX" ]; then
  echo "GATE_ERROR: Could not reach PB inbox API"
  exit 0  # Let LLM handle the error
fi

APPROVED_COUNT=$(echo "$INBOX" | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
    emails = data.get('emails', [])
    count = sum(1 for e in emails if e.get('approved') == True and not e.get('draftCreated'))
    print(count)
except:
    print(0)
" 2>/dev/null)

if [ "$APPROVED_COUNT" -gt 0 ] 2>/dev/null; then
  echo "GATE_PASS: $APPROVED_COUNT approved emails need Gmail drafts"
  exit 0
else
  # Nothing to do — skip LLM entirely
  exit 1
fi
