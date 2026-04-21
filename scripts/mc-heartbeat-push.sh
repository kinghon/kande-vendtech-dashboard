#!/bin/bash
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
# Dual-model heartbeat push — GLM 5.1 (S1) + DeepSeek V3.2 (S2)
# Runs via LaunchAgent every 30s
# Reports status of both local models to MC dashboard

MC_BASE="https://kande-mission-control-production.up.railway.app"
GLM_HOST="192.168.1.52:52415"
DEEPSEEK_HOST="192.168.1.57:52415"
GLM_STATE="/tmp/glm-uptime-state.json"
DEEPSEEK_STATE="/tmp/deepseek-uptime-state.json"

report_model() {
  local NAME="$1"        # glm or deepseek
  local HOST="$2"        # ip:port
  local STATE_FILE="$3"  # uptime state file
  local MODEL_NAME="$4"  # display name
  local ENDPOINT="$MC_BASE/api/$NAME/heartbeat"

  # Step 1: Check if model endpoint responds — only clear state if exo is totally unreachable
  if ! curl -s --max-time 5 "http://$HOST/v1/models" 2>/dev/null | grep -q '"data"'; then
    rm -f "$STATE_FILE"  # Only wipe uptime if exo itself is down
    curl -s -X POST -H 'Content-Type: application/json' "$ENDPOINT" \
      -d "{\"up\":false,\"model\":\"$MODEL_NAME\",\"tasksRunning\":0}" > /dev/null
    return
  fi
  # exo is up — load or initialize uptime state NOW so it's preserved even if inference fails
  if [ -f "$STATE_FILE" ]; then
    ONLINE_SINCE=$(python3 -c "import json; print(json.load(open('$STATE_FILE')).get('onlineSince',''))" 2>/dev/null)
  fi
  if [ -z "$ONLINE_SINCE" ]; then
    ONLINE_SINCE=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    echo "{\"onlineSince\":\"$ONLINE_SINCE\"}" > "$STATE_FILE"
  fi

  # Step 2: Measure tok/s with a minimal completion request
  local TOK_PER_SEC=0
  local START_MS=$(python3 -c "import time; print(int(time.time()*1000))" 2>/dev/null)
  # Short timeout (8s): if model isn't loaded in GPU it won't respond in time.
  # That's fine — we detect it as busy/idle and still show as online via /v1/models.
  local RESP=$(curl -s --max-time 8 "http://$HOST/v1/chat/completions" \
    -H 'Content-Type: application/json' \
    -d "{\"model\":\"$MODEL_NAME\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"max_tokens\":8}" 2>/dev/null)
  local END_MS=$(python3 -c "import time; print(int(time.time()*1000))" 2>/dev/null)

  if echo "$RESP" | grep -q '"choices"'; then
    # Extract token count from usage
    local TOKENS=$(echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('usage',{}).get('completion_tokens',0))" 2>/dev/null || echo 0)
    local ELAPSED_MS=$((END_MS - START_MS))
    if [ "$TOKENS" -gt 0 ] && [ "$ELAPSED_MS" -gt 0 ] 2>/dev/null; then
      TOK_PER_SEC=$(python3 -c "print(round($TOKENS / ($ELAPSED_MS / 1000.0), 1))" 2>/dev/null || echo 0)
    fi
    UP=true
  else
    # Inference failed — but if /v1/models still responds, model is busy (not offline)
    # Any model in the list = server is up, just busy
    if curl -s --max-time 5 "http://$HOST/v1/models" 2>/dev/null | grep -q '"id"'; then
      UP=busy
    else
      UP=false
    fi
  fi

  # Step 3: Uptime already tracked above — just clear if truly offline (handled in step 1 return)

  # Step 4: Count running tasks — use tps>0 as proxy for active inference
  # (lock file counting is unreliable; most cron jobs don't create /tmp/job-*.lock)
  local RUNNING=0
  if python3 -c "exit(0 if float('${TOK_PER_SEC:-0}') > 0 else 1)" 2>/dev/null; then
    RUNNING=1
  fi
  # Increment persistent 24h request counter (resets every 24h)
  local REQ_FILE="/tmp/${NAME}-req-count"
  local REQ_DATE_FILE="/tmp/${NAME}-req-date"
  local TODAY_DATE=$(date +%Y-%m-%d)
  local STORED_DATE=$(cat "$REQ_DATE_FILE" 2>/dev/null || echo "")
  if [ "$STORED_DATE" != "$TODAY_DATE" ]; then
    echo 0 > "$REQ_FILE"
    echo "$TODAY_DATE" > "$REQ_DATE_FILE"
  fi
  local REQ_COUNT=$(cat "$REQ_FILE" 2>/dev/null || echo 0)
  REQ_COUNT=$((REQ_COUNT + 1))
  echo $REQ_COUNT > "$REQ_FILE"

  # Step 4.5: Fetch context window size
  local CTX_SIZE=0
  if [ "$NAME" = "glm" ]; then
    CTX_SIZE=$(curl -s --max-time 5 "http://$HOST/props" 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('default_generation_settings',{}).get('n_ctx',0))" 2>/dev/null || echo 0)
  else
    CTX_SIZE=$(curl -s --max-time 5 "http://$HOST/v1/models" 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); models=d.get('data',[]); print(models[0].get('context_length',0) if models else 0)" 2>/dev/null || echo 0)
  fi

  # Step 5: Push heartbeat
  if [ "$UP" = true ]; then
    curl -s -X POST -H 'Content-Type: application/json' "$ENDPOINT" \
      -d "{\"up\":true,\"model\":\"$MODEL_NAME\",\"tokPerSec\":$TOK_PER_SEC,\"ctxSize\":$CTX_SIZE,\"tasksRunning\":$RUNNING,\"onlineSince\":\"$ONLINE_SINCE\",\"requestCount\":$REQ_COUNT}" > /dev/null
  elif [ "$UP" = busy ]; then
    curl -s -X POST -H 'Content-Type: application/json' "$ENDPOINT" \
      -d "{\"up\":true,\"model\":\"$MODEL_NAME (busy)\",\"tokPerSec\":0,\"ctxSize\":$CTX_SIZE,\"tasksRunning\":$RUNNING,\"onlineSince\":\"$ONLINE_SINCE\",\"requestCount\":$REQ_COUNT}" > /dev/null
  else
    rm -f "$STATE_FILE"
    curl -s -X POST -H 'Content-Type: application/json' "$ENDPOINT" \
      -d "{\"up\":false,\"model\":\"$MODEL_NAME\",\"tasksRunning\":$RUNNING}" > /dev/null
  fi
}

# Push OpenClaw session context window usage
push_openclaw_context() {
  local CTX_SCRIPT="$HOME/clawd/scripts/get-oc-context.py"
  local CTX_TOKENS
  CTX_TOKENS=$(python3 "$CTX_SCRIPT" 2>/dev/null || echo 0)
  if [ "$CTX_TOKENS" -gt 0 ] 2>/dev/null; then
    curl -s -X POST -H 'Content-Type: application/json' "$MC_BASE/api/openclaw/context" \
      -d "{\"contextTokens\":$CTX_TOKENS,\"contextMax\":200000}" > /dev/null
  fi
}

# Run all checks in parallel
report_model "glm" "$GLM_HOST" "$GLM_STATE" "GLM 5.1" &
report_model "deepseek" "$DEEPSEEK_HOST" "$DEEPSEEK_STATE" "mlx-community/DeepSeek-V3.2-4bit" &
push_openclaw_context &
wait
