#!/usr/bin/env bash
# sync-mission-control.sh
# Syncs local agent data to the vend.kandedash.com API so Mission Control
# (kande-mission-control-production.up.railway.app) can read it.
#
# Usage: bash /Users/kurtishon/clawd/scripts/sync-mission-control.sh
# Env:   MC_URL (optional, used only for health check)

set -euo pipefail

API="https://vend.kandedash.com"
KEY="kande2026"
WORKSPACE="/Users/kurtishon/.openclaw/workspace"
AGENT_OUTPUT="/Users/kurtishon/clawd/agent-output"
NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
TODAY=$(date +"%Y-%m-%d")
ERRORS=0

echo "🔄 Mission Control Sync — $NOW"

# ── 1. Dump cron list to cache ──────────────────────────────────────────────
echo "📋 Dumping cron list to cache..."
openclaw cron list --json > /tmp/mc-cron-cache.json 2>/dev/null && \
  echo "   ✅ Cron list cached ($(wc -c < /tmp/mc-cron-cache.json) bytes)" || \
  echo "   ⚠️  Cron list dump failed (openclaw not available?)"

# ── 2. Push key memory files to DB ──────────────────────────────────────────
push_memory() {
  local filepath="$1"
  local filename="$2"
  local is_long_term="${3:-false}"

  if [ ! -f "$filepath" ]; then
    return 0  # Skip missing files silently
  fi

  local size
  size=$(wc -c < "$filepath")

  # Build JSON payload via temp file (avoids heredoc issues)
  local tmp_payload="/tmp/mc-sync-payload-$$.json"
  python3 - "$filepath" "$filename" "$NOW" "$is_long_term" > "$tmp_payload" 2>/dev/null << 'PYEOF'
import json, sys

filepath, filename, now, is_long_term_str = sys.argv[1:]
is_long_term = is_long_term_str.lower() == 'true'

with open(filepath, 'r', encoding='utf-8', errors='replace') as f:
    content = f.read()

payload = {
    'filename': filename,
    'content': content,
    'date': now,
    'isLongTerm': is_long_term
}
print(json.dumps(payload))
PYEOF

  if [ ! -s "$tmp_payload" ]; then
    echo "   ⚠️  Skipping $filename (payload build failed)"
    rm -f "$tmp_payload"
    return 0
  fi

  local resp
  resp=$(curl -s -X POST "$API/api/memory/sync" \
    -H "x-api-key: $KEY" \
    -H "Content-Type: application/json" \
    -d "@$tmp_payload" 2>/dev/null)
  rm -f "$tmp_payload"

  if echo "$resp" | grep -q '"ok":true'; then
    echo "   ✅ $filename (${size} bytes)"
  else
    echo "   ❌ $filename — $(echo "$resp" | head -c 100)"
    ERRORS=$((ERRORS+1))
  fi
}

echo "📁 Syncing memory files..."

# Daily log (today)
push_memory "$WORKSPACE/memory/$TODAY.md" "memory/$TODAY.md"

# Yesterday's log
YESTERDAY=$(date -v-1d +"%Y-%m-%d" 2>/dev/null || date -d "yesterday" +"%Y-%m-%d" 2>/dev/null || echo "")
[ -n "$YESTERDAY" ] && push_memory "$WORKSPACE/memory/$YESTERDAY.md" "memory/$YESTERDAY.md"

# Long-term files
push_memory "$WORKSPACE/KURTIS-CONTEXT.md" "KURTIS-CONTEXT.md" "true"
push_memory "$WORKSPACE/AGENTS.md" "AGENTS.md" "true"

# Agent output memory files
push_memory "$AGENT_OUTPUT/scout/memory.md" "agent-output/scout/memory.md"
push_memory "$AGENT_OUTPUT/relay/memory.md" "agent-output/relay/memory.md"
push_memory "$AGENT_OUTPUT/ralph/memory.md" "agent-output/ralph/memory.md"
push_memory "$AGENT_OUTPUT/shared/action-items.md" "agent-output/shared/action-items.md"
push_memory "$AGENT_OUTPUT/shared/learnings.md" "agent-output/shared/learnings.md"

# Latest standup
STANDUP="$AGENT_OUTPUT/shared/standup-$TODAY.md"
push_memory "$STANDUP" "agent-output/shared/standup-$TODAY.md"

# Latest shipped report
RALPH_SHIPPED="$AGENT_OUTPUT/ralph/shipped-$TODAY.md"
push_memory "$RALPH_SHIPPED" "agent-output/ralph/shipped-$TODAY.md"

# Scout intel
SCOUT_LEADS="$AGENT_OUTPUT/scout/leads-$TODAY.md"
push_memory "$SCOUT_LEADS" "agent-output/scout/leads-$TODAY.md"

# Relay pipeline
RELAY_PIPE="$AGENT_OUTPUT/relay/pipeline-$TODAY.md"
push_memory "$RELAY_PIPE" "agent-output/relay/pipeline-$TODAY.md"

# ── 3. Update Ralph's agent status ──────────────────────────────────────────
echo "🤖 Updating Ralph agent status..."
STATUS_PAYLOAD=$(python3 -c "
import json
payload = {
    'agent': 'ralph',
    'state': 'idle',
    'statusText': 'Overnight build & sync complete',
    'lastActivity': '$NOW'
}
print(json.dumps(payload))
")

STATUS_RESP=$(curl -s -X POST "$API/api/team/status" \
  -H "x-api-key: $KEY" \
  -H "Content-Type: application/json" \
  -d "$STATUS_PAYLOAD" 2>/dev/null)

if echo "$STATUS_RESP" | grep -q '"ok"\|"success"\|"name"'; then
  echo "   ✅ Ralph status updated"
else
  echo "   ⚠️  Status update response: $(echo "$STATUS_RESP" | head -c 100)"
fi

# ── 4. Log an activity ──────────────────────────────────────────────────────
echo "📝 Logging sync activity..."
ACTIVITY_PAYLOAD=$(python3 -c "
import json
payload = {
    'agent': 'ralph',
    'text': 'Mission Control sync complete — memory files and cron cache updated',
    'type': 'sync'
}
print(json.dumps(payload))
")

curl -s -X POST "$API/api/team/activity" \
  -H "x-api-key: $KEY" \
  -H "Content-Type: application/json" \
  -d "$ACTIVITY_PAYLOAD" > /dev/null 2>&1

# ── 5. Health check MC Railway app ──────────────────────────────────────────
MC_URL="${MC_URL:-https://kande-mission-control-production.up.railway.app}"
echo "🌐 Checking Mission Control at $MC_URL..."
MC_HEALTH=$(curl -sk "$MC_URL/api/health" --connect-timeout 10 2>/dev/null)
if echo "$MC_HEALTH" | grep -q '"ok"'; then
  echo "   ✅ Mission Control online"
else
  echo "   ⚠️  Mission Control health check: $(echo "$MC_HEALTH" | head -c 80)"
fi

# ── Done ────────────────────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [ "$ERRORS" -eq 0 ]; then
  echo "✅ Mission Control sync complete — no errors"
else
  echo "⚠️  Sync complete with $ERRORS error(s)"
fi
