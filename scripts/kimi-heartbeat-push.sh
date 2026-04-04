#!/bin/bash
# Kimi health check — tests ACTUAL inference, not just model catalog
STATE_FILE="/tmp/kimi-uptime-state.json"
MC_URL="https://kande-mission-control-production.up.railway.app/api/kimi/heartbeat"

# Step 1: Real inference test (not just /v1/models which always returns 200)
result=$(curl -s --max-time 15 http://192.168.1.52:52415/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"mlx-community/Kimi-K2.5","messages":[{"role":"user","content":"ping"}],"max_tokens":3}' 2>/dev/null)

if echo "$result" | grep -q '"choices"'; then
  # Kimi is actually generating — mark as UP
  running=$(grep -c '\[running\]' /Users/kurtishon/.openclaw/workspace/kimi-task-queue.md 2>/dev/null || echo 0)
  
  # Track uptime: record when Kimi came online
  if [ -f "$STATE_FILE" ]; then
    onlineSince=$(python3 -c "import json; print(json.load(open('$STATE_FILE')).get('onlineSince',''))" 2>/dev/null)
  fi
  if [ -z "$onlineSince" ]; then
    onlineSince=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    echo "{\"onlineSince\":\"$onlineSince\"}" > "$STATE_FILE"
  fi
  
  curl -s -X POST -H 'Content-Type: application/json' "$MC_URL" \
    -d "{\"up\":true,\"model\":\"mlx-community/Kimi-K2.5\",\"tasksRunning\":$running,\"onlineSince\":\"$onlineSince\"}" > /dev/null
else
  # Kimi is DOWN — clear uptime state
  rm -f "$STATE_FILE"
  curl -s -X POST -H 'Content-Type: application/json' "$MC_URL" \
    -d '{"up":false}' > /dev/null
fi
