#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────
#  E2E Tests — Product Catalog (vend.kandedash.com/api/products)
#  Suite ID: products
# ─────────────────────────────────────────────────────────

set -uo pipefail

LOG_DIR="/Users/kurtishon/clawd/logs/e2e"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
SUITE_ID="products"
BASE="https://vend.kandedash.com"
API_KEY="kande2026"
AUTH="-H x-api-key:${API_KEY}"

mkdir -p "$LOG_DIR"

PASS=0
FAIL=0
FAILURES=()

pass() { echo "  [PASS]  $1"; PASS=$((PASS+1)); }
fail() { echo "  [FAIL]  $1"; FAIL=$((FAIL+1)); FAILURES+=("$1"); }

echo ""
echo "  Product Catalog — $(date '+%Y-%m-%d %H:%M:%S')"
echo "  ─────────────────────────────────────────"

# ── GET /api/products — status check ──
STATUS=$(curl -s -o /dev/null -w "%{http_code}" $AUTH "${BASE}/api/products")
[ "$STATUS" = "200" ] && pass "GET /api/products returns 200" || { fail "GET /api/products — expected 200 got $STATUS"; }

# ── Response is a non-empty JSON array ──
BODY=$(curl -s $AUTH "${BASE}/api/products")
COUNT=$(echo "$BODY" | python3 -c "
import json,sys
d=json.load(sys.stdin)
if isinstance(d, list):
    print(len(d))
elif isinstance(d, dict):
    # Might be wrapped: {products: [...]}
    for k in ['products','items','data']:
        if k in d and isinstance(d[k], list):
            print(len(d[k]))
            sys.exit()
    print(0)
else:
    print(0)
" 2>/dev/null)

if [ -n "$COUNT" ] && [ "$COUNT" -gt 0 ] 2>/dev/null; then
  pass "Products array non-empty ($COUNT products)"
else
  fail "Products array empty or invalid (count: '${COUNT:-?}')"
fi

# ── Validate product objects have required fields ──
VALIDATION=$(echo "$BODY" | python3 -c "
import json,sys
d=json.load(sys.stdin)
if isinstance(d, list):
    products = d
elif isinstance(d, dict):
    products = d.get('products', d.get('items', d.get('data', [])))
else:
    products = []

if not products:
    print('EMPTY')
    sys.exit()

p = products[0]
required = ['id', 'name', 'category']
missing = [k for k in required if k not in p]
if missing:
    print('MISSING: ' + ', '.join(missing))
else:
    # Check numeric price field (sell_price or price)
    has_price = 'sell_price' in p or 'price' in p
    print('OK:' + str(len(products)) + ':' + str(has_price))
" 2>/dev/null)

if echo "$VALIDATION" | grep -q "^OK:"; then
  total=$(echo "$VALIDATION" | cut -d: -f2)
  has_price=$(echo "$VALIDATION" | cut -d: -f3)
  pass "Product objects have required fields (id, name, category) — $total products"
  [ "$has_price" = "True" ] && pass "Products have price field (sell_price or price)" || fail "Products missing price field"
elif echo "$VALIDATION" | grep -q "^MISSING:"; then
  fail "Product objects missing required fields: $(echo "$VALIDATION" | cut -d: -f2)"
else
  fail "Could not validate product object structure"
fi

# ── Categories sanity check: at least 2 distinct categories ──
CAT_COUNT=$(echo "$BODY" | python3 -c "
import json,sys
d=json.load(sys.stdin)
if isinstance(d, list):
    products = d
elif isinstance(d, dict):
    products = d.get('products', d.get('items', d.get('data', [])))
else:
    products = []
cats = set(p.get('category','') for p in products if p.get('category'))
print(len(cats))
" 2>/dev/null)

if [ -n "$CAT_COUNT" ] && [ "$CAT_COUNT" -ge 2 ] 2>/dev/null; then
  pass "Product catalog has $CAT_COUNT distinct categories"
else
  fail "Too few product categories ($CAT_COUNT) — catalog may be broken"
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
  "suite": "products",
  "name": "Product Catalog",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "passed": ${PASS},
  "failed": ${FAIL},
  "failures": ${FAILURES_JSON}
}
EOF

[ "$FAIL" -eq 0 ] && exit 0 || exit 1
