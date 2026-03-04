#!/bin/bash
# Gate + Execute: mixmax-tracking-sync
# This does the FULL job in bash — no LLM needed
# Runs the curl, checks for hot leads/new replies, outputs only if notable

RESULT=$(/usr/bin/curl -s -X POST -H 'x-api-key: kande2026' https://vend.kandedash.com/api/mixmax/sync-to-crm 2>/dev/null)

if [ -z "$RESULT" ]; then
  echo "GATE_ERROR: Mixmax sync API unreachable"
  exit 0
fi

# Parse for notable items (3+ external opens or new replies)
NOTABLE=$(echo "$RESULT" | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
    results = data.get('results', [])
    hot = []
    replies = []
    for r in results:
        if r.get('was_replied') and not r.get('last_event_is_internal', True):
            replies.append(f\"{r['prospect_name']} replied\")
        elif r.get('num_opens', 0) >= 3 and not r.get('last_event_is_internal', True):
            hot.append(f\"{r['prospect_name']} ({r['num_opens']} opens)\")
    
    synced = data.get('synced', 0)
    if replies:
        print(f'NOTABLE: {synced} synced. New replies: {\", \".join(replies)}')
    elif hot:
        print(f'OK: {synced} synced. Hot leads: {\", \".join(hot[:5])}')
    else:
        print(f'OK: {synced} synced. No notable changes.')
except Exception as e:
    print(f'PARSE_ERROR: {e}')
" 2>/dev/null)

echo "$NOTABLE"

# Only escalate to LLM if there are new REPLIES (not just opens)
if echo "$NOTABLE" | grep -q "New replies"; then
  exit 0  # Pass to LLM for Kurtis notification
else
  exit 1  # Done, no LLM needed
fi
