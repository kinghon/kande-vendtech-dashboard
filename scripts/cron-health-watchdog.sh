#!/bin/bash
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
# Cron health watchdog — pure bash, no LLM
# Checks Kimi, resets stuck dispatchers, logs to /tmp/watchdog.log

LOG="/tmp/watchdog.log"
log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $1" >> "$LOG"; }

# Check 1: Kimi inference (just check if exo has a model loaded — heartbeat handles the real test)
if curl -s --max-time 5 http://192.168.1.52:52415/v1/models 2>/dev/null | grep -q '"data"'; then
  log "Kimi: exo responding"
else
  log "Kimi: exo DOWN"
fi

# Check 2: Dispatcher consecutive errors — reset if stuck
DISPATCHER_ERRORS=$(openclaw cron list --json 2>/dev/null | python3 -c "
import json,sys
d=json.load(sys.stdin)
for j in d.get('jobs',[]):
    if j['name']=='kimi-workload-dispatcher':
        print(j.get('state',{}).get('consecutiveErrors',0))
" 2>/dev/null || echo 0)

if [ "$DISPATCHER_ERRORS" -ge 5 ] 2>/dev/null; then
  log "Dispatcher has $DISPATCHER_ERRORS errors — resetting"
  # Disable then re-enable to reset backoff
  openclaw cron update --job-id cc43e1e0-c3aa-49f0-b83c-444ebf83d952 --enabled false 2>/dev/null
  sleep 3
  openclaw cron update --job-id cc43e1e0-c3aa-49f0-b83c-444ebf83d952 --enabled true 2>/dev/null
  log "Dispatcher reset"
fi

# Check 3: Tasks running
RUNNING=$(grep -c '\[running\]' /Users/kurtishon/.openclaw/workspace/kimi-task-queue.md 2>/dev/null || echo 0)
log "Tasks running: $RUNNING"
