#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────
#  E2E Tests — VendTech CRM (vend.kandedash.com)
#  Suite ID: vendtech
# ─────────────────────────────────────────────────────────

set -uo pipefail

LOG_DIR="/Users/kurtishon/clawd/logs/e2e"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
SUITE_ID="vendtech"
BASE="https://vend.kandedash.com"
API_KEY="kande2026"
AUTH="-H x-api-key:${API_KEY}"

mkdir -p "$LOG_DIR"

PASS=0
FAIL=0
FAILURES=()

pass() { echo "  [PASS]  $1"; PASS=$((PASS+1)); }
fail() { echo "  [FAIL]  $1"; FAIL=$((FAIL+1)); FAILURES+=("$1"); }

check_status() {
  local desc="$1" url="$2" expected="${3:-200}"
  local status
  status=$(curl -s -o /dev/null -w "%{http_code}" $AUTH "$url")
  [ "$status" = "$expected" ] && pass "$desc (HTTP $status)" || fail "$desc — expected $expected got $status"
}

check_json_key() {
  local desc="$1" url="$2" key="$3"
  local body
  body=$(curl -s $AUTH "$url")
  echo "$body" | python3 -c "import json,sys; d=json.load(sys.stdin); assert '$key' in d or isinstance(d,list), 'missing key: $key'" 2>/dev/null \
    && pass "$desc" || fail "$desc — missing key '$key' in response"
}

check_json_array_nonempty() {
  local desc="$1" url="$2" key="$3"
  local body
  body=$(curl -s $AUTH "$url")
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
echo "  VendTech CRM — $(date '+%Y-%m-%d %H:%M:%S')"
echo "  ─────────────────────────────────────────"

# ── Login page accessible ──
check_status "Login page accessible" "${BASE}/login"

# ── API: Prospects list ──
check_status "GET /api/prospects returns 200" "${BASE}/api/prospects"
check_json_array_nonempty "Prospects array is non-empty" "${BASE}/api/prospects" ""

# ── API: Usage turns ──
check_status "GET /api/usage/turns returns 200" "${BASE}/api/usage/turns"
check_json_key "Usage turns has 'sessions' key" "${BASE}/api/usage/turns" "sessions"

# ── API: Pipeline engagement alerts ──
check_status "GET /api/pipeline/engagement-alerts returns 200" "${BASE}/api/pipeline/engagement-alerts"
check_json_key "Pipeline alerts has 'alerts' key" "${BASE}/api/pipeline/engagement-alerts" "alerts"

# ── API: Products catalog ──
check_status "GET /api/products returns 200" "${BASE}/api/products"
check_json_array_nonempty "Products array is non-empty" "${BASE}/api/products" ""

# ── API: Team learnings ──
check_status "GET /api/team/learnings returns 200" "${BASE}/api/team/learnings"

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
  "suite": "vendtech",
  "name": "VendTech CRM",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "passed": ${PASS},
  "failed": ${FAIL},
  "failures": ${FAILURES_JSON}
}
EOF

[ "$FAIL" -eq 0 ] && exit 0 || exit 1
