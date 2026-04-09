#!/bin/bash
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
# Gate: check if Kimi proxy is healthy
# Exit 1 = healthy (skip LLM), Exit 0 = broken (invoke LLM to fix)

if curl -s --max-time 8 http://192.168.1.52:8081/v1/models 2>/dev/null | grep -q data; then
  echo "PROXY_OK"
  exit 1
fi

# Proxy down — try restart before invoking LLM
echo "PROXY_DOWN — attempting SSH restart"
ssh -o BatchMode=yes -o ConnectTimeout=5 192.168.1.52 'pkill -f kimi_proxy 2>/dev/null; sleep 2; nohup python3 ~/kimi_proxy_v5.py > ~/kimi_proxy.log 2>&1 &' 2>&1
sleep 4

if curl -s --max-time 8 http://192.168.1.52:8081/v1/models 2>/dev/null | grep -q data; then
  echo "PROXY_RESTORED — auto-fixed, no LLM needed"
  exit 1
fi

# Auto-restart failed — need LLM to alert Kurtis
echo "PROXY_STILL_DOWN — escalating to LLM"
exit 0
