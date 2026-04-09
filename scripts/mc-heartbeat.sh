#!/bin/bash
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
# Kimi heartbeat — REPORT ONLY, no auto-restart
# Runs via LaunchAgent every 30s
# Reports accurate status to MC dashboard including inference test
MC_URL="https://kande-mission-control-production.up.railway.app/api/kimi/heartbeat"
STATE_FILE="/tmp/kimi-uptime-state.json"
INFERENCE_STATE="/tmp/kimi-inference-state.json"

# Step 1: Check if exo lists models
if ! curl -s --max-time 5 http://192.168.1.52:52415/v1/models 2>/dev/null | grep -q '"data"'; then
  rm -f "$STATE_FILE" "$INFERENCE_STATE"
  curl -s -X POST -H 'Content-Type: application/json' "$MC_URL" \
    -d '{"up":false,"model":"mlx-community/Kimi-K2.5","tasksRunning":0}' > /dev/null
  exit 0
fi

# Step 2: Inference test — every 5 min, 3 min timeout
NEEDS_TEST=true
INFERENCE_OK="unknown"
if [ -f "$INFERENCE_STATE" ]; then
  LAST_TEST=$(python3 -c "import json,time; s=json.load(open('$INFERENCE_STATE')); print(int(time.time()-s.get('testedAt',0)))" 2>/dev/null || echo 999)
  LAST_RESULT=$(python3 -c "import json; print(json.load(open('$INFERENCE_STATE')).get('ok','unknown'))" 2>/dev/null || echo "unknown")
  if [ "$LAST_TEST" -lt 300 ] 2>/dev/null; then
    NEEDS_TEST=false
    INFERENCE_OK="$LAST_RESULT"
  fi
fi

if [ "$NEEDS_TEST" = true ]; then
  RESP=$(curl -s --max-time 180 http://192.168.1.52:52415/v1/chat/completions \
    -H 'Content-Type: application/json' \
    -d '{"model":"mlx-community/Kimi-K2.5","messages":[{"role":"user","content":"Reply: OK"}],"max_tokens":5}' 2>/dev/null)
  
  if echo "$RESP" | grep -q '"choices"'; then
    INFERENCE_OK="true"
  else
    INFERENCE_OK="false"
  fi
  
  python3 -c "import json,time; json.dump({'ok':'$INFERENCE_OK','testedAt':time.time()},open('$INFERENCE_STATE','w'))" 2>/dev/null
fi

# Step 3: Report status (no restart, just accurate reporting)
RUNNING=$(grep -c '\[running\]' /Users/kurtishon/.openclaw/workspace/kimi-task-queue.md 2>/dev/null || echo 0)

if [ "$INFERENCE_OK" = "true" ]; then
  if [ -f "$STATE_FILE" ]; then
    ONLINE_SINCE=$(python3 -c "import json; print(json.load(open('$STATE_FILE')).get('onlineSince',''))" 2>/dev/null)
  fi
  if [ -z "$ONLINE_SINCE" ]; then
    ONLINE_SINCE=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    echo "{\"onlineSince\":\"$ONLINE_SINCE\"}" > "$STATE_FILE"
  fi
  
  curl -s -X POST -H 'Content-Type: application/json' "$MC_URL" \
    -d "{\"up\":true,\"model\":\"mlx-community/Kimi-K2.5\",\"tasksRunning\":$RUNNING,\"onlineSince\":\"$ONLINE_SINCE\"}" > /dev/null
elif [ "$INFERENCE_OK" = "false" ]; then
  rm -f "$STATE_FILE"
  curl -s -X POST -H 'Content-Type: application/json' "$MC_URL" \
    -d "{\"up\":false,\"model\":\"mlx-community/Kimi-K2.5 (inference stuck)\",\"tasksRunning\":$RUNNING}" > /dev/null
else
  # Unknown — between tests, report based on model listing (up but unverified)
  if [ -f "$STATE_FILE" ]; then
    ONLINE_SINCE=$(python3 -c "import json; print(json.load(open('$STATE_FILE')).get('onlineSince',''))" 2>/dev/null)
  fi
  if [ -n "$ONLINE_SINCE" ]; then
    curl -s -X POST -H 'Content-Type: application/json' "$MC_URL" \
      -d "{\"up\":true,\"model\":\"mlx-community/Kimi-K2.5\",\"tasksRunning\":$RUNNING,\"onlineSince\":\"$ONLINE_SINCE\"}" > /dev/null
  fi
fi
