#!/bin/bash
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
# Gate script for daily Mighty Networks community scrape
# Returns exit code 0 if scrape is needed (new posts found or no recent scrape)
# Returns exit code 1 if no scrape needed

LATEST="/Users/kurtishon/kande-vendtech/research/mighty-networks/community-posts-latest.json"
COOKIES="/tmp/mighty-cookies.json"

# Check if cookies exist
if [ ! -f "$COOKIES" ]; then
  echo "NO_COOKIES: Mighty Networks cookies not found. Need manual login."
  exit 1
fi

# Check if we scraped today already
TODAY=$(date +%Y-%m-%d)
TODAY_FILE="/Users/kurtishon/kande-vendtech/research/mighty-networks/community-posts-${TODAY}.json"

if [ -f "$TODAY_FILE" ]; then
  echo "ALREADY_SCRAPED: Today's scrape already exists at $TODAY_FILE"
  exit 1
fi

# Run the scraper
echo "SCRAPE_NEEDED"
node /Users/kurtishon/clawd/scripts/mighty-scrape-posts.js 2>&1
RESULT=$?

if [ $RESULT -eq 0 ]; then
  echo "SCRAPE_OK"
  exit 0
else
  echo "SCRAPE_FAILED: exit code $RESULT"
  exit 0  # Still return 0 so the agent knows to report the failure
fi
