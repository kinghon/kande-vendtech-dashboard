#!/bin/bash
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
# MC Live Push — runs every 2 min via LaunchAgent
# Pushes agent status, heartbeat health, and Kimi state to Mission Control

MC_URL="https://kande-mission-control-production.up.railway.app"
SYNC_KEY="kmc-sync-2026"
QUEUE="/Users/kurtishon/.openclaw/workspace/kimi-task-queue.md"
WORKSPACE="/Users/kurtishon/.openclaw/workspace"

# --- Kimi status (check exo directly — proxy no longer used) ---
KIMI_STATUS="offline"
if curl -s --max-time 5 http://192.168.1.52:52415/v1/models 2>/dev/null | grep -q data; then
  KIMI_STATUS="online"
fi

# --- Proxy status (legacy — proxy removed, check exo instead) ---
PROXY_STATUS="$KIMI_STATUS"

# --- Exo status ---
EXO_STATUS="$KIMI_STATUS"

# --- Ollama status ---
OLLAMA_STATUS="offline"
if curl -s --max-time 3 http://localhost:11434/v1/models 2>/dev/null | grep -q data; then
  OLLAMA_STATUS="online"
fi

# --- Queue stats ---
PENDING=$(grep -c '^\- \[ \]' "$QUEUE" 2>/dev/null || echo 0)
RUNNING=$(grep -c '\[running\]' "$QUEUE" 2>/dev/null || echo 0)
DONE=$(grep -c '^\- \[x\]' "$QUEUE" 2>/dev/null || echo 0)

# --- Heartbeat: check if main session responded recently ---
HEARTBEAT_FILE="$WORKSPACE/HEARTBEAT.md"
GATEWAY_PID=$(pgrep -f "openclaw.*gateway" 2>/dev/null | head -1)
if [ -n "$GATEWAY_PID" ]; then
  GATEWAY_STATUS="running"
else
  GATEWAY_STATUS="stopped"
fi

# --- Active cron sessions (modified in last 3 min, still growing) ---
ACTIVE_SESSIONS=0
for f in $(find /Users/kurtishon/.openclaw/agents/main/sessions -name '*.jsonl' -mmin -3 -size +5k 2>/dev/null | head -10); do
  ACTIVE_SESSIONS=$((ACTIVE_SESSIONS + 1))
done

# --- Build JSON payload ---
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)

JSON=$(cat <<EOF
{
  "timestamp": "$NOW",
  "infrastructure": {
    "kimi": "$KIMI_STATUS",
    "proxy": "$PROXY_STATUS",
    "exo": "$EXO_STATUS",
    "ollama": "$OLLAMA_STATUS",
    "gateway": "$GATEWAY_STATUS"
  },
  "queue": {
    "pending": $PENDING,
    "running": $RUNNING,
    "completed": $DONE
  },
  "activeSessions": $ACTIVE_SESSIONS,
  "heartbeat": {
    "gateway": "$GATEWAY_STATUS",
    "lastPush": "$NOW"
  }
}
EOF
)

# --- Kimi heartbeat is handled by LaunchAgent com.kande.mc-heartbeat (every 30s) ---
# Do NOT push heartbeat from this script — single source of truth.

# --- Push general status ---
curl -s -X POST \
  -H "Content-Type: application/json" \
  -H "x-sync-key: $SYNC_KEY" \
  "$MC_URL/api/sync/live-status" \
  -d "$JSON" > /dev/null 2>&1

# --- Sync cron job state so Office page shows agent activity ---
# Use OpenClaw CLI to dump cron state, push to MC
CRON_JSON=$(openclaw cron list --json 2>/dev/null || echo '{"jobs":[]}')
if [ -n "$CRON_JSON" ] && echo "$CRON_JSON" | python3 -c "import json,sys; json.load(sys.stdin)" 2>/dev/null; then
  curl -s -X POST \
    -H "Content-Type: application/json" \
    -H "x-sync-key: $SYNC_KEY" \
    "$MC_URL/api/sync/cron" \
    -d "$CRON_JSON" > /dev/null 2>&1
fi

# --- Push recent agent activity events ---
# Build activity from cron jobs that ran in the last 5 min
python3 << 'PYEOF' 2>/dev/null
import json, subprocess, time
try:
    result = subprocess.run(['openclaw', 'cron', 'list', '--json'], capture_output=True, text=True, timeout=10)
    data = json.loads(result.stdout) if result.stdout else {'jobs': []}
except:
    data = {'jobs': []}

jobs = data.get('jobs', [])
now_ms = int(time.time() * 1000)
five_min = 5 * 60 * 1000
events = []

job_to_agent = {
    'scout-morning': 'scout', 'scout-evening': 'scout',
    'relay-morning': 'relay', 'relay-evening': 'relay',
    'ralph-overnight': 'ralph', 'kimi-qa-verifier': 'ralph',
    'daily-standup': 'standup', 'water-cooler': 'water-cooler',
    'piper-morning': 'piper', 'piper-evening': 'piper',
    'kimi-workload-dispatcher': 'kimi', 'cron-health-watchdog': 'watchdog',
    'morning-briefing': 'jarvis', 'mc-live-status': 'jarvis',
    'mission-control-sync': 'jarvis', 'daily-maps-discovery': 'scout',
    'daily-mighty-community-scrape': 'scout',
    'queue-refill': 'kimi', 'verification-agent': 'ralph',
    'mixmax-tracking-sync': 'relay', 'vendtech-sent-email-sync': 'relay',
    'nightly-extraction': 'jarvis', 'kimi-daily-recap': 'jarvis',
    'kimi-api-cost-tracker': 'jarvis', 'nightly-maps-verify': 'scout',
    'daily-maps-discovery': 'scout', 'sandstar-revenue-sync': 'relay',
    'pb-email-drafts': 'piper', 'daily-vendingpreneurs-scrape': 'scout',
    'daily-mighty-community-scrape': 'scout', 'daily-e2e-dashboards': 'ralph',
    'outreach-crm-sync': 'relay', 'crm-dedup-merge': 'relay',
    'anthropic-cost-sync': 'jarvis', 'mc-data-sync': 'jarvis',
    'usage-data-extract': 'jarvis', 'push-learnings': 'jarvis',
}

# Human-readable task descriptions instead of cron job names
job_to_task = {
    'scout-morning': 'Scanning Google Maps for new vending leads in Las Vegas',
    'scout-evening': 'Researching competitor reviews and industry news',
    'relay-morning': 'Reviewing email pipeline — tracking opens and hot leads',
    'relay-evening': 'EOD pipeline check — flagging reopened prospects',
    'ralph-overnight': 'Building features and fixing bugs from the backlog',
    'kimi-qa-verifier': 'Browser-testing dashboard pages after code changes',
    'verification-agent': 'Independently verifying recent agent changes work',
    'daily-standup': 'Running daily standup — synthesizing all agent output',
    'water-cooler': 'Cross-team brainstorm — connecting agent insights',
    'piper-morning': 'Writing SEO blog posts and generating social content',
    'piper-evening': 'Reviewing content quality and planning tomorrow\'s topics',
    'kimi-workload-dispatcher': 'Dispatching next task from the work queue to Kimi',
    'cron-health-watchdog': 'Checking all agent health — fixing errors silently',
    'morning-briefing': 'Composing morning pipeline briefing for Kurtis',
    'mc-live-status': 'Pushing live infrastructure status to Mission Control',
    'mission-control-sync': 'Syncing memory and agent data to MC dashboard',
    'daily-maps-discovery': 'Discovering new prospects via Google Maps API',
    'daily-mighty-community-scrape': 'Scraping Vendingpreneurs community for intel',
    'queue-refill': 'Refilling Kimi task queue with fresh revenue-building work',
    'mixmax-tracking-sync': 'Syncing email tracking data from Mixmax to CRM',
    'vendtech-sent-email-sync': 'Logging sent VendTech emails to CRM prospects',
    'nightly-extraction': 'Reviewing today\'s sessions — extracting patterns and decisions',
    'kimi-daily-recap': 'Generating daily Kimi productivity report',
    'kimi-api-cost-tracker': 'Calculating today\'s API costs by provider and model',
    'nightly-maps-verify': 'Bulk-verifying CRM prospects against Google Maps',
    'sandstar-revenue-sync': 'Pulling Sandstar VRK machine sales data',
    'pb-email-drafts': 'Checking PB inbox and drafting AI email replies',
    'daily-vendingpreneurs-scrape': 'Checking for new Vendingpreneurs videos to transcribe',
    'daily-e2e-dashboards': 'Running E2E tests on all Kande dashboards',
    'outreach-crm-sync': 'Syncing outreach sequences to CRM',
    'crm-dedup-merge': 'Deduplicating and merging CRM prospects',
    'anthropic-cost-sync': 'Scraping Anthropic console for real cost data',
    'mc-data-sync': 'Pushing fresh data to all Mission Control tabs',
    'usage-data-extract': 'Extracting usage data from session logs',
    'push-learnings': 'Pushing team learnings to the dashboard',
}

for j in jobs:
    if not j.get('enabled'): continue
    state = j.get('state', {})
    last_run = state.get('lastRunAtMs', 0)
    if now_ms - last_run < five_min:
        name = j.get('name', 'unknown')
        agent = job_to_agent.get(name, 'system')
        status = state.get('lastStatus', 'unknown')
        task_desc = job_to_task.get(name, name)
        # Use the summary from last run if available and successful
        summary = state.get('lastSummary', '') if status == 'ok' else ''
        display = f"{task_desc}" if status == 'ok' else f"{task_desc} (errored)"
        events.append({
            'agent': agent,
            'action': display,
            'message': f"{task_desc} — {status}",
            'timestamp': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(last_run/1000))
        })

if events:
    payload = json.dumps({'events': events})
    subprocess.run(['curl', '-s', '-X', 'POST',
        '-H', 'Content-Type: application/json',
        '-H', 'x-sync-key: kmc-sync-2026',
        'https://kande-mission-control-production.up.railway.app/api/sync/office-activity',
        '-d', payload], capture_output=True, timeout=10)
PYEOF
