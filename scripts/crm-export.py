#!/usr/bin/env python3
"""
crm-export.py — Full CRM backup: exports JSON + pulls raw DB dump.
Usage:
  python3 crm-export.py [output_file]          # full export JSON
  python3 crm-export.py --raw-db [output_file] # raw data.json dump (DR copy)
Exits 0 on success, 1 on failure.
"""
import urllib.request, json, http.cookiejar, sys, os

CRM      = "https://sales.kandedash.com"
PASSWORD = "kande2026"
API_KEY  = "kande2026"

jar = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
opener.addheaders = [('User-Agent', 'Mozilla/5.0')]

raw_mode = '--raw-db' in sys.argv
args = [a for a in sys.argv[1:] if not a.startswith('--')]
out_file = args[0] if args else None

try:
    if raw_mode:
        # Raw DB dump — uses API key, no session needed
        req = urllib.request.Request(f"{CRM}/api/backup/raw-db",
            headers={'x-api-key': API_KEY, 'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=60) as r:
            data = r.read()
        parsed = json.loads(data)
        prospects = len(parsed.get('prospects', []))
        activities = len(parsed.get('activities', []))
        photos = len(parsed.get('prospect_photos', []))
        total_keys = len(parsed.keys())
        print(f"raw-db: {total_keys} collections | prospects:{prospects} activities:{activities} photos:{photos}", file=sys.stderr)
    else:
        # Session-based full export
        req = urllib.request.Request(f"{CRM}/api/auth/login",
            data=json.dumps({'password': PASSWORD}).encode(),
            headers={'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0'})
        with opener.open(req, timeout=15) as r:
            result = json.loads(r.read())
        if not result.get('success'):
            print(f"Auth failed: {result}", file=sys.stderr)
            sys.exit(1)

        with opener.open(urllib.request.Request(f"{CRM}/api/export/json"), timeout=60) as r:
            data = r.read()

        parsed = json.loads(data)
        if 'error' in parsed:
            print(f"Export error: {parsed}", file=sys.stderr)
            sys.exit(1)

        prospects = len(parsed.get('prospects', []))
        activities = len(parsed.get('activities', []))
        photos = len(parsed.get('prospect_photos', []))
        print(f"prospects:{prospects} activities:{activities} photos:{photos}", file=sys.stderr)

    if out_file:
        with open(out_file, 'wb') as f:
            f.write(data)
    else:
        sys.stdout.buffer.write(data)

    sys.exit(0)

except Exception as e:
    print(f"Export failed: {e}", file=sys.stderr)
    sys.exit(1)
