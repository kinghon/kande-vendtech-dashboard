#!/bin/bash
# Release Kimi lock — call when done
# Usage: bash /Users/kurtishon/clawd/scripts/gates/kimi-release.sh
rm -f /tmp/kimi-lock 2>/dev/null
echo "LOCK_RELEASED"
