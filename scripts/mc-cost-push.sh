#!/bin/bash
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
# MC Cost Push — regenerates cost data from session logs and pushes to Mission Control
# No LLM needed. Runs every 5 min via LaunchAgent.

MC_URL="https://kande-mission-control-production.up.railway.app"
SYNC_KEY="kmc-sync-2026"
COST_DIR="/Users/kurtishon/clawd/agent-output/costs"
HISTORY="$COST_DIR/cost-history.json"
TODAY=$(date +%Y-%m-%d)
TODAY_FILE="$COST_DIR/api-costs-$TODAY.json"

# Always regenerate from session logs (costs accumulate throughout the day)
if true; then
  python3 << 'PYEOF'
import json, glob, os
from datetime import datetime, timezone, timedelta

now = datetime.now(timezone.utc)
today_str = now.strftime('%Y-%m-%d')
session_dir = '/Users/kurtishon/.openclaw/agents/main/sessions'
costs = {'anthropic': 0, 'openai': 0, 'exo': 0, 'other': 0}
turns = {'anthropic': 0, 'openai': 0, 'exo': 0, 'other': 0}
by_model = {}

for f in glob.glob(os.path.join(session_dir, '*.jsonl')):
    try:
        mtime = os.path.getmtime(f)
        if (now.timestamp() - mtime) > 86400: continue  # skip old files
        with open(f, 'r') as fh:
            for line in fh:
                line = line.strip()
                if not line: continue
                try: msg = json.loads(line)
                except: continue
                ts = msg.get('timestamp', '')
                if isinstance(ts, (int, float)):
                    ts_str = datetime.fromtimestamp(ts/1000 if ts > 1e12 else ts, timezone.utc).strftime('%Y-%m-%d')
                elif isinstance(ts, str): ts_str = ts[:10]
                else: continue
                if ts_str != today_str: continue
                inner = msg.get('message', {})
                provider = inner.get('provider', '')
                model = inner.get('model', '')
                usage = inner.get('usage', {})
                cost = usage.get('cost', {})
                total_cost = cost.get('total', 0) if isinstance(cost, dict) else 0
                if not total_cost: continue
                bucket = 'other'
                if 'anthropic' in provider: bucket = 'anthropic'
                elif 'openai' in provider: bucket = 'openai'
                elif 'exo' in provider: bucket = 'exo'
                costs[bucket] += total_cost
                turns[bucket] += 1
                if model not in by_model: by_model[model] = {'cost': 0, 'turns': 0}
                by_model[model]['cost'] += total_cost
                by_model[model]['turns'] += 1
    except: continue

total = sum(costs.values())
report = {
    'date': today_str,
    'total': round(total, 4),
    'providers': {k: round(v, 4) for k, v in costs.items() if v > 0},
    'turns': {k: v for k, v in turns.items() if v > 0},
    'models': {m: {'cost': round(d['cost'], 4), 'turns': d['turns']} for m, d in by_model.items()},
    'updatedAt': now.isoformat()
}

os.makedirs('/Users/kurtishon/clawd/agent-output/costs', exist_ok=True)
with open(f'/Users/kurtishon/clawd/agent-output/costs/api-costs-{today_str}.json', 'w') as f:
    json.dump(report, f, indent=2)
PYEOF
fi

# Push today's cost data to MC
if [ -f "$TODAY_FILE" ]; then
  curl -s -X POST \
    -H "Content-Type: application/json" \
    -H "x-sync-key: $SYNC_KEY" \
    "$MC_URL/api/sync/costs" \
    -d @"$TODAY_FILE" > /dev/null 2>&1
fi

# Also push week total from history
if [ -f "$HISTORY" ]; then
  WEEK_TOTAL=$(python3 -c "
import json
from datetime import datetime, timedelta, timezone
now = datetime.now(timezone.utc)
week_ago = (now - timedelta(days=7)).strftime('%Y-%m-%d')
h = json.load(open('$HISTORY'))
total = sum(d['total'] for d in h if d['date'] >= week_ago)
print(f'{total:.2f}')
" 2>/dev/null || echo "0")
  
  # Push week summary
  curl -s -X POST \
    -H "Content-Type: application/json" \
    -H "x-sync-key: $SYNC_KEY" \
    "$MC_URL/api/sync/costs-summary" \
    -d "{\"weekTotal\":$WEEK_TOTAL,\"updatedAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" > /dev/null 2>&1
fi
