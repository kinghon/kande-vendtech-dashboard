#!/bin/bash
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
# Gate: vendingpreneurs YouTube check
# Only wake LLM if there are new videos

YESTERDAY=$(date -v-1d +%Y-%m-%dT00:00:00Z 2>/dev/null || date -d "yesterday" +%Y-%m-%dT00:00:00Z 2>/dev/null)

NEW_VIDEOS=$(/usr/bin/curl -s "https://www.youtube.com/feeds/videos.xml?channel_id=UCCr13sXOZgWCqpPv8WPKhwQ" 2>/dev/null | python3 -c "
import sys, xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone

ns = {'atom': 'http://www.w3.org/2005/Atom', 'yt': 'http://www.youtube.com/xml/schemas/2015'}
try:
    tree = ET.parse(sys.stdin)
    root = tree.getroot()
    yesterday = datetime.now(timezone.utc) - timedelta(days=1)
    count = 0
    for entry in root.findall('atom:entry', ns):
        published = entry.find('atom:published', ns).text
        pub_dt = datetime.fromisoformat(published.replace('Z', '+00:00'))
        if pub_dt >= yesterday:
            title = entry.find('atom:title', ns).text
            vid_id = entry.find('yt:videoId', ns).text
            print(f'{vid_id}|{title}')
            count += 1
    if count == 0:
        sys.exit(1)
except:
    sys.exit(1)
" 2>/dev/null)

if [ $? -eq 0 ] && [ -n "$NEW_VIDEOS" ]; then
  echo "NEW_VIDEOS_FOUND:"
  echo "$NEW_VIDEOS"
  exit 0  # Wake LLM to transcribe
else
  # Also log to research log
  echo "## $(date +%Y-%m-%d) — Daily Vendingpreneurs Scrape" >> /Users/kurtishon/.openclaw/workspace/memory/research-log.md
  echo "- **YouTube:** No new videos" >> /Users/kurtishon/.openclaw/workspace/memory/research-log.md
  echo "- **Skool:** Skipped (bash gate — Chrome relay check not implemented)" >> /Users/kurtishon/.openclaw/workspace/memory/research-log.md
  echo "" >> /Users/kurtishon/.openclaw/workspace/memory/research-log.md
  exit 1  # No LLM needed
fi
