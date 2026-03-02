#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────
#  E2E Tests — Photo Booths Ops (pb.kandedash.com)
#  Suite ID: photobooths-ops
# ─────────────────────────────────────────────────────────

set -uo pipefail

LOG_DIR="/Users/kurtishon/clawd/logs/e2e"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
SUITE_ID="photobooths-ops"
BASE="https://pb.kandedash.com"

mkdir -p "$LOG_DIR"

PASS=0
FAIL=0
FAILURES=()

pass() { echo "  [PASS]  $1"; PASS=$((PASS+1)); }
fail() { echo "  [FAIL]  $1"; FAIL=$((FAIL+1)); FAILURES+=("$1"); }

check_status() {
  local desc="$1" url="$2" expected="${3:-200}"
  local status
  status=$(curl -s -o /dev/null -w "%{http_code}" "$url")
  [ "$status" = "$expected" ] && pass "$desc (HTTP $status)" || fail "$desc — expected $expected got $status"
}

check_json_key() {
  local desc="$1" url="$2" key="$3"
  local body
  body=$(curl -s "$url")
  echo "$body" | python3 -c "import json,sys; d=json.load(sys.stdin); assert '$key' in d, 'missing'" 2>/dev/null \
    && pass "$desc" || fail "$desc — missing key '$key'"
}

check_json_array_nonempty() {
  local desc="$1" url="$2" key="$3"
  local body
  body=$(curl -s "$url")
  local count
  count=$(echo "$body" | python3 -c "
import json,sys
d=json.load(sys.stdin)
if isinstance(d, list):
    print(len(d))
else:
    print(len(d.get('$key', [])))
" 2>/dev/null)
  if [ -n "$count" ] && [ "$count" -gt 0 ] 2>/dev/null; then
    pass "$desc ($count records)"
  else
    fail "$desc — empty or invalid response"
  fi
}

echo ""
echo "  Photo Booths Ops — $(date '+%Y-%m-%d %H:%M:%S')"
echo "  ─────────────────────────────────────────"

# ── Main page ──
check_status "pb.kandedash.com homepage returns 200" "${BASE}/"

# ── API: Inbox (email drafts) ──
check_status "GET /api/inbox returns 200" "${BASE}/api/inbox"
check_json_key "Inbox has 'emails' key" "${BASE}/api/inbox" "emails"

# ── API: Leaderboard ──
check_status "GET /api/leaderboard returns 200" "${BASE}/api/leaderboard"
check_json_key "Leaderboard has 'bots' key" "${BASE}/api/leaderboard" "bots"
check_json_array_nonempty "Leaderboard bots non-empty" "${BASE}/api/leaderboard" "bots"

# ── API: Departments ──
check_status "GET /api/departments returns 200" "${BASE}/api/departments"
check_json_key "Departments has 'divisions' key" "${BASE}/api/departments" "divisions"

echo ""
echo "  ─────────────────────────────────────────"
echo "  Results: ${PASS} passed, ${FAIL} failed"

# ── Write per-suite JSON ──
FAILURES_JSON="["
for i in "${!FAILURES[@]}"; do
  [ $i -gt 0 ] && FAILURES_JSON+=","
  FAILURES_JSON+="\"${FAILURES[$i]}\""
done
FAILURES_JSON+="]"

cat > "${LOG_DIR}/${SUITE_ID}_${TIMESTAMP}.json" <<EOF
{
  "suite": "photobooths-ops",
  "name": "Photo Booths Ops",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "passed": ${PASS},
  "failed": ${FAIL},
  "failures": ${FAILURES_JSON}
}
EOF

[ "$FAIL" -eq 0 ] && exit 0 || exit 1
