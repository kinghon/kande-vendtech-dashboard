#!/usr/bin/env python3
"""
sync-crm-to-outreach.py — Sync CRM prospects into the Outreach Engine.

For each NEW prospect not already enrolled in an outreach sequence:
- Create a pending send record for Step 1 (Day 0) of the Cold Outreach Sequence
- The auto-draft-email0 cron handles actual email drafting; this keeps tracking in sync

Only enrolls prospects with status='new' (never contacted).
Does NOT enroll: contacted, proposal_sent, negotiating, interested, closed, pop_in, etc.
"""

import json
import sys
import urllib.request
import urllib.error
from datetime import datetime, timezone

API = 'https://vend.kandedash.com'
KEY = 'kande2026'
COLD_SEQUENCE_ID = 267
COLD_SEQUENCE_STEP1_TEMPLATE = 262  # Day 0 initial outreach

ENROLLABLE_STATUSES = {'new'}  # Only cold prospects


def api_get(path):
    req = urllib.request.Request(
        f'{API}{path}',
        headers={'x-api-key': KEY, 'Accept': 'application/json'}
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())


def api_post(path, data):
    body = json.dumps(data).encode()
    req = urllib.request.Request(
        f'{API}{path}',
        data=body,
        headers={'x-api-key': KEY, 'Content-Type': 'application/json', 'Accept': 'application/json'}
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())


def main():
    print(f"🔄 CRM → Outreach Sync  [{datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')}]")

    # Fetch all prospects
    print("📋 Fetching CRM prospects...")
    prospects = api_get('/api/prospects')
    print(f"   Total prospects: {len(prospects)}")

    # Only new (cold) prospects
    new_prospects = [p for p in prospects if p.get('status', '').lower() in ENROLLABLE_STATUSES]
    print(f"   New (eligible): {len(new_prospects)}")

    # Fetch existing sends to avoid re-enrollment
    print("📨 Fetching existing outreach sends...")
    try:
        sends = api_get('/api/outreach/sends')
        enrolled_ids = set(s.get('prospect_id') for s in sends if s.get('prospect_id'))
        print(f"   Already enrolled: {len(enrolled_ids)} prospects")
    except urllib.error.URLError:
        sends = []
        enrolled_ids = set()
        print("   ⚠️ Could not fetch sends, assuming 0 enrolled")

    # Find un-enrolled new prospects
    to_enroll = [p for p in new_prospects if p.get('id') not in enrolled_ids]
    print(f"   Needs enrollment: {len(to_enroll)}")

    if not to_enroll:
        print("\n✅ All new prospects already enrolled. No changes needed.")
        return 0

    # Enroll each prospect — Step 1 only (Day 0)
    enrolled = []
    errors = []
    for p in to_enroll:
        pid = p.get('id')
        name = p.get('name', 'Unknown')
        try:
            send = api_post('/api/outreach/sends', {
                'prospect_id': pid,
                'sequence_id': COLD_SEQUENCE_ID,
                'template_id': COLD_SEQUENCE_STEP1_TEMPLATE,
                'delay_days': 0,
                'status': 'pending'
            })
            enrolled.append({'id': pid, 'name': name, 'send_id': send.get('id')})
            print(f"   ✅ Enrolled #{pid}: {name}")
        except urllib.error.URLError as e:
            errors.append({'id': pid, 'name': name, 'error': str(e)})
            print(f"   ❌ Failed #{pid} {name}: {e}")

    print(f"\n{'='*50}")
    print(f"✅ Enrolled {len(enrolled)} new prospects into Cold Outreach Sequence")
    if errors:
        print(f"⚠️  {len(errors)} enrollment failures")
    if enrolled:
        print("ENROLLED:")
        for e in enrolled:
            print(f"  #{e['id']}: {e['name']}")

    return 0 if not errors else 1


if __name__ == '__main__':
    sys.exit(main())
