#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────
#  E2E Tests — Photo Booths Events (info.kandedash.com)
#  Suite ID: photobooths-events
# ─────────────────────────────────────────────────────────

set -uo pipefail

LOG_DIR="/Users/kurtishon/clawd/logs/e2e"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
SUITE_ID="photobooths-events"
BASE="https://info.kandedash.com"

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
    fail "$desc — empty or invalid response (count: '${count:-?}')"
  fi
}

echo ""
echo "  Photo Booths Events — $(date '+%Y-%m-%d %H:%M:%S')"
echo "  ─────────────────────────────────────────"

# ── Main page (event logistics dashboard) ──
check_status "info.kandedash.com homepage returns 200" "${BASE}/"

# ── API: Events list ──
check_status "GET /api/events returns 200" "${BASE}/api/events"
check_json_key "Events response has 'events' key" "${BASE}/api/events" "events"
check_json_array_nonempty "Events list is non-empty" "${BASE}/api/events" "events"

# ── Validate first event has required fields ──
FIRST_EVENT=$(curl -s "${BASE}/api/events" | python3 -c "
import json,sys
d=json.load(sys.stdin)
events = d.get('events', [])
if events:
    e = events[0]
    missing = [k for k in ['id','title','eventType'] if k not in e]
    if missing:
        print('MISSING: ' + ', '.join(missing))
    else:
        print('OK:' + str(len(events)))
else:
    print('EMPTY')
" 2>/dev/null)

if echo "$FIRST_EVENT" | grep -q "^OK:"; then
  count=$(echo "$FIRST_EVENT" | cut -d: -f2)
  pass "Event objects have required fields (id, title, eventType) — $count events"
elif echo "$FIRST_EVENT" | grep -q "^MISSING:"; then
  fail "Event objects missing fields: $(echo "$FIRST_EVENT" | cut -d: -f2)"
else
  fail "Could not validate event structure"
fi

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
  "suite": "photobooths-events",
  "name": "Photo Booths Events",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "passed": ${PASS},
  "failed": ${FAIL},
  "failures": ${FAILURES_JSON}
}
EOF

[ "$FAIL" -eq 0 ] && exit 0 || exit 1
