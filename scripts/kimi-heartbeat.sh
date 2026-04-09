#!/bin/bash
# Kimi heartbeat — checks exo health and pushes to Mission Control
# Run every 30-60s via cron

MC_URL="https://kande-mission-control-production.up.railway.app/api/kimi/heartbeat"
EXO_URL="http://192.168.1.52:52415/v1/models"

# Check if exo is responding
START=$(python3 -c 'import time; print(int(time.time()*1000))')
RESPONSE=$(curl -s --max-time 5 "$EXO_URL" 2>/dev/null)
END=$(python3 -c 'import time; print(int(time.time()*1000))')

if echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); sys.exit(0 if d.get('data') else 1)" 2>/dev/null; then
  LATENCY=$((END - START))
  # Count models with kimi in the name
  MODEL=$(echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); kimi=[m for m in d['data'] if 'kimi' in m['id'].lower() or 'Kimi' in m.get('name','')]; print(kimi[0]['name'] if kimi else 'Exo Cluster')" 2>/dev/null)
  # Check running tasks (count active cron sessions)
  TASKS=$(ps aux 2>/dev/null | grep -c 'kimi\|exo' || echo 0)
  
  curl -s -X POST -H 'Content-Type: application/json' "$MC_URL" \
    -d "{\"up\":true,\"model\":\"$MODEL\",\"latencyMs\":$LATENCY,\"tasksRunning\":0}" > /dev/null
  echo "OK: $MODEL (${LATENCY}ms)"
else
  curl -s -X POST -H 'Content-Type: application/json' "$MC_URL" \
    -d '{"up":false,"model":"Kimi K2.5","latencyMs":null,"tasksRunning":0}' > /dev/null
  echo "DOWN: exo not responding"
fi
