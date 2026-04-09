#!/bin/bash
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
# Run on Studio 1 after every boot — sets GPU memory limit BEFORE loading any model
# Install: add to Studio 1's crontab with @reboot

LOG=~/studio1-boot.log
echo "[$(date)] Boot sequence starting" >> $LOG

# Step 1: Set wired memory limit FIRST (must happen before any model loads)
sudo nvram boot-args="iogpu.wired_limit_mb=450000"
sudo sysctl iogpu.wired_limit_mb=450000
echo "[$(date)] GPU wired limit set to 450GB" >> $LOG

# Step 2: Wait 10s for system to settle
sleep 10

# Step 3: Start oMLX (handles its own crash recovery via brew services)
MODEL_DIR=~/.cache/huggingface/hub/models--mlx-community--Kimi-K2.5/snapshots/351021afd838c866ce1a7374fce51d615773d2a8
OMLX_PORT=8000 nohup /opt/homebrew/bin/omlx serve --model-dir $MODEL_DIR > ~/omlx_server.log 2>&1 &
echo "[$(date)] oMLX started (PID $!)" >> $LOG

# Step 4: Start proxy once model is serving (poll every 30s)
for i in $(seq 1 20); do
    if curl -s --max-time 5 http://localhost:8000/v1/models > /dev/null 2>&1; then
        echo "[$(date)] oMLX ready — starting proxy" >> $LOG
        pkill -f kimi_proxy 2>/dev/null
        sleep 1
        nohup python3 ~/kimi_proxy_v5.py > ~/kimi_proxy.log 2>&1 &
        echo "[$(date)] Proxy started" >> $LOG
        break
    fi
    echo "[$(date)] Waiting for oMLX... attempt $i" >> $LOG
    sleep 30
done

echo "[$(date)] Boot sequence complete" >> $LOG
