#!/usr/bin/env python3
import json, glob, os, subprocess
from datetime import datetime, timezone

now = datetime.now(timezone.utc)
today = now.strftime('%Y-%m-%d')
costs = {'anthropic': 0, 'exo': 0, 'other': 0}
turns = {'anthropic': 0, 'exo': 0, 'other': 0}
models = {}

for f in glob.glob('/Users/kurtishon/.openclaw/agents/main/sessions/*.jsonl'):
    try:
        for line in open(f):
            try:
                m = json.loads(line.strip())
            except:
                continue
            ts = m.get('timestamp', 0)
            if isinstance(ts, (int, float)):
                ts_str = datetime.fromtimestamp(ts/1000 if ts > 1e12 else ts, timezone.utc).strftime('%Y-%m-%d')
            elif isinstance(ts, str):
                ts_str = ts[:10]
            else:
                continue
            if ts_str != today:
                continue
            inn = m.get('message', {})
            p = inn.get('provider', '')
            mod = inn.get('model', '')
            c = inn.get('usage', {}).get('cost', {})
            v = c.get('total', 0) if isinstance(c, dict) else 0
            if not v:
                continue
            b = 'anthropic' if 'anthropic' in p else ('exo' if 'exo' in p else 'other')
            costs[b] += v
            turns[b] += 1
            if mod not in models:
                models[mod] = {'cost': 0, 'turns': 0}
            models[mod]['cost'] += v
            models[mod]['turns'] += 1
    except:
        pass

total = sum(costs.values())
rpt = {
    'date': today,
    'total': round(total, 4),
    'providers': {k: round(v, 4) for k, v in costs.items() if v > 0},
    'turns': {k: v for k, v in turns.items() if v > 0},
    'models': {m: {'cost': round(d['cost'], 4), 'turns': d['turns']} for m, d in models.items()},
    'updatedAt': now.isoformat()
}

os.makedirs('/Users/kurtishon/clawd/agent-output/costs', exist_ok=True)
with open(f'/Users/kurtishon/clawd/agent-output/costs/api-costs-{today}.json', 'w') as f:
    json.dump(rpt, f)

history_file = '/Users/kurtishon/clawd/agent-output/costs/cost-history.json'
try:
    with open(history_file) as f:
        h = json.load(f)
except:
    h = []
h = [x for x in h if x.get('date') != today]
h.append(rpt)
h.sort(key=lambda x: x['date'])
with open(history_file, 'w') as f:
    json.dump(h, f)

subprocess.run([
    'curl', '-s', '-X', 'POST',
    'https://kande-mission-control-production.up.railway.app/api/sync/costs',
    '-H', 'x-sync-key: kmc-sync-2026',
    '-H', 'Content-Type: application/json',
    '-d', json.dumps(rpt)
], capture_output=True)

print(f'Pushed: today=${total:.2f}')
