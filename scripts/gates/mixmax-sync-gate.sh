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

STATE_FILE="/tmp/mixmax-last-replies.txt"

# Extract current reply set
CURRENT_REPLIES=$(echo "$RESULT" | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
    replies = sorted(set(r['prospect_name'] for r in data.get('results', []) if r.get('was_replied') and not r.get('last_event_is_internal', True)))
    print('\n'.join(replies))
except:
    pass
" 2>/dev/null)

# Compare to last known state
PREV_REPLIES=""
if [ -f "$STATE_FILE" ]; then
  PREV_REPLIES=$(cat "$STATE_FILE")
fi

# Save current state
echo "$CURRENT_REPLIES" > "$STATE_FILE"

# Find truly NEW replies (in current but not in previous)
NEW_REPLIES=$(comm -23 <(echo "$CURRENT_REPLIES" | sort) <(echo "$PREV_REPLIES" | sort) 2>/dev/null | grep -v '^$')

if [ -n "$NEW_REPLIES" ]; then
  echo "NEW_REPLIES_FOUND: $NEW_REPLIES"
  echo "$NOTABLE"
  exit 0  # Pass to LLM — genuinely new replies
else
  echo "$NOTABLE"
  exit 1  # Known replies, no LLM needed
fi
