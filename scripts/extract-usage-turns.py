#!/usr/bin/env python3
"""
extract-usage-turns.py — Count OpenClaw session turns per Telegram group and push to VendTech dashboard.

Session files: /Users/kurtishon/.openclaw/agents/main/sessions/*.jsonl
Each JSONL file is one session. Lines are JSON objects.
- First record: {"type": "session", "id": ..., "timestamp": "ISO8601", ...}
- Message records: {"type": "message", "message": {"role": "user|assistant|system", ...}, "timestamp": <epoch_ms>}

Group detection (from first user message):
  - Contains "conversation_label": "GroupName id:CHATID" → map by CHATID
  - Starts with "System:" or "[cron:" → Cron Jobs
  - Has sender_id "882436227" with no group → Main (DM)

Output format: 2-hour interval slots over last 7 days.
  slot: "YYYY-MM-DDTHH" where HH is the 2-hour block start (00,02,04,...,22) in LA time.

API endpoint: POST https://vend.kandedash.com/api/usage/turns
Auth: x-api-key: kande2026
"""

import json
import os
import re
import sys
import subprocess
from pathlib import Path
from datetime import datetime, timedelta, timezone
from collections import defaultdict

# ── Config ──────────────────────────────────────────────────────────────────
SESSIONS_DIR = Path('/Users/kurtishon/.openclaw/agents/main/sessions')
API_ENDPOINT = 'https://vend.kandedash.com/api/usage/turns'
API_KEY      = 'kande2026'
DAYS_BACK    = 7
CURL         = '/usr/bin/curl'

# LA timezone offset (PST = UTC-8, PDT = UTC-7 — use UTC-8 conservatively)
LA_OFFSET = timedelta(hours=-8)

CHAT_ID_TO_GROUP = {
    '-4992441037': 'VendTech Group',
    '-5137874547': 'Photo Booths Group',
    '-5208800550': 'Jumpgate Industries',
    '882436227':   'Main (DM)',
}

GROUP_ORDER = ['VendTech Group', 'Photo Booths Group', 'Main (DM)', 'Cron Jobs', 'Jumpgate Industries']


def utc_to_la_date(iso_str: str) -> str:
    """Convert ISO8601 UTC timestamp to YYYY-MM-DD in LA time."""
    try:
        dt = datetime.fromisoformat(iso_str.replace('Z', '+00:00'))
        la_dt = dt + LA_OFFSET
        return la_dt.strftime('%Y-%m-%d')
    except Exception:
        return iso_str[:10]


def epoch_ms_to_la_slot(ts_ms: int) -> str:
    """Convert epoch milliseconds to 2-hour slot string in LA time (YYYY-MM-DDTHH)."""
    dt_utc = datetime.fromtimestamp(ts_ms / 1000.0, tz=timezone.utc)
    dt_la = dt_utc + LA_OFFSET
    hour = (dt_la.hour // 2) * 2  # round down to nearest 2-hour block
    return dt_la.strftime(f'%Y-%m-%dT{hour:02d}')


def iso_to_epoch_ms(iso_str: str) -> int | None:
    """Convert ISO8601 string to epoch milliseconds."""
    try:
        dt = datetime.fromisoformat(iso_str.replace('Z', '+00:00'))
        return int(dt.timestamp() * 1000)
    except Exception:
        return None


def get_text_content(msg_obj: dict) -> str:
    """Extract text from message content (can be str or list of {type,text} dicts)."""
    content = msg_obj.get('message', {}).get('content', '')
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, dict) and item.get('type') == 'text':
                parts.append(item.get('text', ''))
        return '\n'.join(parts)
    return ''


def classify_session(session_path: Path) -> tuple[str | None, str | None]:
    """
    Return (group_name, date_str) for the session.
    group_name is None if unclassifiable.
    date_str is the YYYY-MM-DD of the session start in LA time.
    """
    group = None
    date_str = None

    try:
        with session_path.open('r', encoding='utf-8', errors='replace') as fh:
            first_user_msg_text = None
            session_ts = None

            for raw in fh:
                raw = raw.strip()
                if not raw:
                    continue
                try:
                    obj = json.loads(raw)
                except json.JSONDecodeError:
                    continue

                # Grab session timestamp from first record
                if obj.get('type') == 'session' and session_ts is None:
                    session_ts = obj.get('timestamp', '')

                # Find first user message
                if (obj.get('type') == 'message'
                        and obj.get('message', {}).get('role') == 'user'
                        and first_user_msg_text is None):
                    first_user_msg_text = get_text_content(obj)
                    # Once we have it, we can classify
                    break

            if session_ts:
                date_str = utc_to_la_date(session_ts)
            elif session_path.stat().st_mtime:
                # Fall back to file mtime
                mtime = datetime.fromtimestamp(session_path.stat().st_mtime, tz=timezone.utc)
                date_str = (mtime + LA_OFFSET).strftime('%Y-%m-%d')

            if first_user_msg_text is None:
                return None, date_str

            # Cron job detection: starts with "System:" or "[cron:" or subagent context
            cron_prefixes = ('System:', '[cron:', '[Subagent Task]', '[Subagent Context]')
            if any(first_user_msg_text.lstrip().startswith(p) for p in cron_prefixes):
                group = 'Cron Jobs'
                return group, date_str

            # Cron job: cron completion notifications like "[PST] A cron job..."
            if re.search(r'\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{4}-\d{2}-\d{2}.*?\]\s+A cron job', first_user_msg_text):
                group = 'Cron Jobs'
                return group, date_str

            # Group detection via conversation_label (new format)
            m = re.search(r'"conversation_label"\s*:\s*"[^"]*id:(-?\d+)"', first_user_msg_text)
            if m:
                chat_id = m.group(1)
                group = CHAT_ID_TO_GROUP.get(chat_id, f'Group {chat_id}')
                return group, date_str

            # Old Telegram format: [Telegram GroupName id:CHATID timestamp] ...
            m_old = re.search(r'\[Telegram\s+.*?\s+id:(-?\d+)\s+', first_user_msg_text)
            if m_old:
                chat_id = m_old.group(1)
                group = CHAT_ID_TO_GROUP.get(chat_id, f'Group {chat_id}')
                return group, date_str

            # Heartbeat sessions (main session / Kurtis DM)
            if first_user_msg_text.strip().startswith('Read HEARTBEAT.md'):
                group = 'Main (DM)'
                return group, date_str

            # DM detection: sender_id without a group label
            m2 = re.search(r'"sender_id"\s*:\s*"(\d+)"', first_user_msg_text)
            if m2:
                sid = m2.group(1)
                group = CHAT_ID_TO_GROUP.get(sid, f'DM {sid}')
                return group, date_str

    except Exception as e:
        print(f'  [warn] Error reading {session_path.name}: {e}', file=sys.stderr)

    return group, date_str


def collect_session_slots(session_path: Path, cutoff_date: str, fallback_ts_ms: int | None = None) -> dict[str, int]:
    """
    Scan assistant messages in this session and return {slot: count}.
    slot is "YYYY-MM-DDTHH" (2-hour block start, LA time).
    Only includes slots on or after cutoff_date.
    """
    slot_counts: dict[str, int] = defaultdict(int)
    session_ts_ms = fallback_ts_ms

    try:
        with session_path.open('r', encoding='utf-8', errors='replace') as fh:
            for raw in fh:
                raw = raw.strip()
                if not raw:
                    continue
                try:
                    obj = json.loads(raw)
                except json.JSONDecodeError:
                    continue

                # Capture session-level timestamp for fallback
                if obj.get('type') == 'session' and session_ts_ms is None:
                    ts_str = obj.get('timestamp', '')
                    if ts_str:
                        session_ts_ms = iso_to_epoch_ms(ts_str)

                # Count assistant messages
                if (obj.get('type') == 'message'
                        and obj.get('message', {}).get('role') == 'assistant'):

                    # Prefer per-message timestamp; fall back to session timestamp
                    ts_ms = obj.get('timestamp')

                    # Handle ISO string timestamps on message records
                    if isinstance(ts_ms, str):
                        ts_ms = iso_to_epoch_ms(ts_ms)

                    if ts_ms is None:
                        ts_ms = session_ts_ms

                    if ts_ms is None:
                        continue  # no timestamp available, skip

                    slot = epoch_ms_to_la_slot(int(ts_ms))
                    slot_date = slot[:10]
                    if slot_date >= cutoff_date:
                        slot_counts[slot] += 1

    except Exception as e:
        print(f'  [warn] Error scanning slots in {session_path.name}: {e}', file=sys.stderr)

    return dict(slot_counts)


def main():
    print(f'📂 Scanning {SESSIONS_DIR} ...')

    cutoff = datetime.now(tz=timezone.utc) - timedelta(days=DAYS_BACK)
    cutoff_date = (cutoff + LA_OFFSET).strftime('%Y-%m-%d')
    print(f'📅 Cutoff date (LA): {cutoff_date}  (last {DAYS_BACK} days, 2-hour intervals)')

    all_files = list(SESSIONS_DIR.glob('*.jsonl'))
    print(f'📄 Total session files: {len(all_files)}')

    # Filter to last 7 days by mtime (fast pre-filter)
    recent_files = [
        f for f in all_files
        if datetime.fromtimestamp(f.stat().st_mtime, tz=timezone.utc) >= cutoff
    ]
    print(f'📄 Sessions in last {DAYS_BACK} days (by mtime): {len(recent_files)}')

    # group_name → slot → turns
    counts: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    unclassified = 0
    processed = 0

    for session_file in recent_files:
        group, date_str = classify_session(session_file)

        # For session start date check: use mtime-based date if session start is older.
        # Persistent Telegram group sessions have an old start date but recent mtime.
        # We want to include any session that has had activity in the last 7 days.
        mtime_date = (datetime.fromtimestamp(session_file.stat().st_mtime, tz=timezone.utc) + LA_OFFSET).strftime('%Y-%m-%d')
        effective_date = max(date_str, mtime_date) if date_str else mtime_date
        if effective_date < cutoff_date:
            continue  # No recent activity

        if group is None:
            unclassified += 1
            continue

        # Get fallback timestamp from mtime for sessions without message timestamps
        mtime_ms = int(session_file.stat().st_mtime * 1000)
        slot_data = collect_session_slots(session_file, cutoff_date, fallback_ts_ms=mtime_ms)

        if slot_data:
            for slot, n in slot_data.items():
                counts[group][slot] += n
            processed += 1

    print(f'✅ Processed: {processed} sessions, {unclassified} unclassified')
    print()

    # Print summary
    total_turns = 0
    for group in sorted(counts.keys()):
        group_total = sum(counts[group].values())
        total_turns += group_total
        print(f'  {group}: {group_total} turns across {len(counts[group])} 2-hour slots')
    print(f'  TOTAL: {total_turns} turns')
    print()

    # Build payload in the order the dashboard expects
    sessions_payload = []
    seen = set()
    # Add in preferred order first
    for gname in GROUP_ORDER:
        if gname in counts:
            data = [{'slot': s, 'turns': t} for s, t in sorted(counts[gname].items())]
            sessions_payload.append({'name': gname, 'data': data})
            seen.add(gname)
    # Add any remaining groups
    for gname in sorted(counts.keys()):
        if gname not in seen:
            data = [{'slot': s, 'turns': t} for s, t in sorted(counts[gname].items())]
            sessions_payload.append({'name': gname, 'data': data})

    payload = {
        'sessions': sessions_payload,
        'interval': '2h',
        'updatedAt': datetime.now(tz=timezone.utc).isoformat()
    }

    payload_json = json.dumps(payload)
    print(f'📤 Pushing to {API_ENDPOINT} ...')
    print(f'   Groups: {[s["name"] for s in sessions_payload]}')
    print(f'   Interval: 2h')
    print(f'   Payload size: {len(payload_json)} bytes')
    print()

    result = subprocess.run(
        [
            CURL, '-s', '-w', '\n%{http_code}',
            '-X', 'POST',
            '-H', 'Content-Type: application/json',
            '-H', f'x-api-key: {API_KEY}',
            '-d', payload_json,
            API_ENDPOINT
        ],
        capture_output=True,
        text=True
    )

    output = result.stdout.strip()
    lines = output.rsplit('\n', 1)
    http_code = lines[-1] if len(lines) > 1 else '???'
    body = lines[0] if len(lines) > 1 else output

    if http_code == '200':
        print(f'✅ Success! HTTP {http_code}')
        try:
            resp = json.loads(body)
            print(f'   Response: {json.dumps(resp)}')
        except Exception:
            print(f'   Response: {body[:200]}')
    else:
        print(f'❌ Failed! HTTP {http_code}')
        print(f'   Response: {body[:500]}')
        sys.exit(1)

    print()
    print('🔍 Verifying — GET /api/usage/turns ...')
    verify = subprocess.run(
        [
            CURL, '-s', '-w', '\n%{http_code}',
            '-H', f'x-api-key: {API_KEY}',
            API_ENDPOINT
        ],
        capture_output=True,
        text=True
    )
    vout = verify.stdout.strip()
    vlines = vout.rsplit('\n', 1)
    vcode = vlines[-1] if len(vlines) > 1 else '???'
    vbody = vlines[0] if len(vlines) > 1 else vout

    if vcode == '200':
        try:
            vresp = json.loads(vbody)
            vgroups = [s['name'] for s in vresp.get('sessions', [])]
            sample = vresp.get('sessions', [{}])[0].get('data', [])[:3]
            print(f'✅ Verified! Groups: {vgroups}')
            print(f'   Interval: {vresp.get("interval", "?")}')
            print(f'   Updated at: {vresp.get("updatedAt", "?")}')
            print(f'   Sample slots: {sample}')
        except Exception:
            print(f'✅ HTTP {vcode}: {vbody[:200]}')
    else:
        print(f'⚠ GET returned HTTP {vcode}: {vbody[:200]}')


if __name__ == '__main__':
    main()
