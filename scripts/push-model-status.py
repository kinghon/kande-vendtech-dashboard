#!/usr/bin/env python3
"""push-model-status.py — Scan session files, extract model+cost per cron agent, push to VendTech API."""
import glob, json, os, sys
from datetime import datetime, timedelta, timezone

SESSIONS_DIR = os.path.expanduser('~/.openclaw/agents/main/sessions/')
API_URL = 'https://vend.kandedash.com/api/agents/model-sync'
HOURS = 24

def classify_model(model_id):
    """Return (tier, display_name) — tier: free/cheap/expensive"""
    if not model_id:
        return ('unknown', 'Unknown')
    m = model_id.lower()
    if 'deepseek' in m or 'mlx-community' in m or 'local' in m or 'exo' in m:
        return ('free', model_id.split('/')[-1] if '/' in model_id else model_id)
    if 'glm' in m or 'minimax' in m:
        return ('free', 'GLM-51')
    if 'sonnet' in m:
        return ('cheap', 'Claude Sonnet')
    if 'opus' in m:
        return ('expensive', 'Claude Opus')
    if 'haiku' in m:
        return ('cheap', 'Claude Haiku')
    if 'gpt-4' in m or 'gpt4' in m:
        return ('expensive', model_id.split('/')[-1] if '/' in model_id else model_id)
    if 'gpt-3' in m:
        return ('cheap', 'GPT-3.5')
    return ('cheap', model_id.split('/')[-1] if '/' in model_id else model_id)

def scan_sessions():
    cutoff = datetime.now(timezone.utc) - timedelta(hours=HOURS)
    jobs = {}  # job_name -> {model, cost, lastRun, tier}

    for fpath in sorted(glob.glob(SESSIONS_DIR + '*.jsonl'), key=os.path.getmtime, reverse=True)[:200]:
        try:
            mtime = datetime.fromtimestamp(os.path.getmtime(fpath), timezone.utc)
            if mtime < cutoff:
                continue
        except:
            continue

        model_id = None
        job_name = None
        total_cost = 0.0
        last_ts = None

        try:
            with open(fpath) as fh:
                for line in fh:
                    line = line.strip()
                    if not line: continue
                    try:
                        obj = json.loads(line)
                    except:
                        continue

                    ts = obj.get('timestamp')
                    if ts:
                        last_ts = ts

                    if obj.get('type') == 'model_change':
                        model_id = obj.get('modelId', model_id)

                    if obj.get('type') == 'message':
                        msg = obj.get('message', {})
                        # Extract job name from first user message
                        if msg.get('role') == 'user' and not job_name:
                            content = msg.get('content', '')
                            if isinstance(content, list):
                                content = content[0].get('text', '') if content else ''
                            if content.startswith('[cron:'):
                                parts = content.split(']')
                                if len(parts) >= 2:
                                    job_name = parts[0].split()[-1] if ' ' in parts[0] else parts[0].split(':')[-1]

                        # Extract cost
                        usage = msg.get('usage', {})
                        if usage and isinstance(usage, dict) and 'cost' in usage:
                            c = usage['cost']
                            if isinstance(c, dict):
                                total_cost += c.get('total', 0)
        except:
            continue

        if not job_name:
            continue

        tier, display = classify_model(model_id)

        # Merge: if same job ran multiple times, sum cost, keep latest model
        if job_name in jobs:
            jobs[job_name]['cost'] += total_cost
            # Keep latest model
            if last_ts and last_ts > jobs[job_name].get('_lastTs', ''):
                jobs[job_name]['model'] = display
                jobs[job_name]['modelId'] = model_id or 'unknown'
                jobs[job_name]['tier'] = tier
                jobs[job_name]['lastRun'] = last_ts
                jobs[job_name]['_lastTs'] = last_ts
        else:
            jobs[job_name] = {
                'job': job_name,
                'model': display,
                'modelId': model_id or 'unknown',
                'tier': tier,
                'cost': round(total_cost, 4),
                'lastRun': last_ts or mtime.isoformat(),
                '_lastTs': last_ts or ''
            }

    # Clean internal fields
    for v in jobs.values():
        v.pop('_lastTs', None)

    return sorted(jobs.values(), key=lambda x: x.get('cost', 0), reverse=True)


def push(agents):
    payload = json.dumps({'agents': agents})
    try:
        import subprocess
        r = subprocess.run(
            ['curl', '-s', '-X', 'POST', API_URL,
             '-H', 'Content-Type: application/json',
             '-d', payload],
            capture_output=True, text=True, timeout=15
        )
        resp = r.stdout
        if '"ok":true' in resp:
            print(f"✅ Pushed model status for {len(agents)} agents")
            return True
        else:
            print(f"❌ Push failed: {resp[:200]}")
            return False
    except Exception as e:
        print(f"❌ Push error: {e}")
        return False


if __name__ == '__main__':
    agents = scan_sessions()
    if not agents:
        print("⚠️  No cron sessions found in last 24h")
        sys.exit(0)

    print(f"📊 Found {len(agents)} cron agents with model data:")
    for a in agents:
        tier_emoji = {'free': '🟢', 'cheap': '🟡', 'expensive': '🔴', 'unknown': '⚪'}.get(a['tier'], '⚪')
        print(f"  {tier_emoji} {a['job']}: {a['model']} — ${a['cost']:.4f}")

    push(agents)