#!/bin/bash
# Gate + Execute: vendtech-qa-sweep
# Curls all pages, only escalates to LLM if something is broken

FAILURES=""
ALL_OK=true

# Dashboard pages
for path in "/" "/crm" "/todos" "/lead-review" "/funnel" "/tax-strategy" "/analytics" "/contracts" "/outreach" "/pricing"; do
  code=$(/usr/bin/curl -s -o /dev/null -w "%{http_code}" "https://vend.kandedash.com${path}" -H "x-api-key: kande2026" --max-time 10 2>/dev/null)
  if [ "$code" != "200" ]; then
    FAILURES="${FAILURES}vend.kandedash.com${path} → HTTP ${code}\n"
    ALL_OK=false
  fi
done

# Public pages
for path in "/sales-sheet.html" "/proposal.html"; do
  code=$(/usr/bin/curl -s -o /dev/null -w "%{http_code}" "https://info.kandedash.com${path}" --max-time 10 2>/dev/null)
  if [ "$code" != "200" ]; then
    FAILURES="${FAILURES}info.kandedash.com${path} → HTTP ${code}\n"
    ALL_OK=false
  fi
done

if [ "$ALL_OK" = true ]; then
  echo "QA_PASS: All 12 pages returned HTTP 200"
  exit 1  # No LLM needed
else
  echo "QA_FAIL: Broken pages detected:"
  echo -e "$FAILURES"
  exit 0  # Escalate to LLM to alert Kurtis
fi
