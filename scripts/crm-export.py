#!/usr/bin/env python3
"""
crm-export.py — Authenticated CRM export to stdout or file.
Usage: python3 crm-export.py [output_file]
Exits 0 on success, 1 on failure.
"""
import urllib.request, json, http.cookiejar, sys, os

CRM = "https://sales.kandedash.com"
PASSWORD = "jvending1#"

jar = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
opener.addheaders = [('User-Agent', 'Mozilla/5.0')]

try:
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

    # Validate
    parsed = json.loads(data)
    if 'error' in parsed:
        print(f"Export error: {parsed}", file=sys.stderr)
        sys.exit(1)

    prospects = len(parsed.get('prospects', []))
    activities = len(parsed.get('activities', []))
    photos = len(parsed.get('prospect_photos', []))
    print(f"prospects:{prospects} activities:{activities} photos:{photos}", file=sys.stderr)

    if len(sys.argv) > 1:
        with open(sys.argv[1], 'wb') as f:
            f.write(data)
    else:
        sys.stdout.buffer.write(data)

    sys.exit(0)

except Exception as e:
    print(f"Export failed: {e}", file=sys.stderr)
    sys.exit(1)
