#!/bin/bash
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
# cleanup-sessions.sh — Remove orphaned .jsonl session files and dead keys from sessions.json
# Run weekly (e.g. Sunday midnight) to keep sessions dir lean.

SESSIONS_DIR="$HOME/.openclaw/agents/main/sessions"
SESSIONS_JSON="$SESSIONS_DIR/sessions.json"

if [ ! -f "$SESSIONS_JSON" ]; then
  echo "sessions.json not found at $SESSIONS_JSON"
  exit 1
fi

python3 << 'PYEOF'
import json, os, shutil

sessions_dir = os.path.expanduser("~/.openclaw/agents/main/sessions")
sessions_json = os.path.join(sessions_dir, "sessions.json")

with open(sessions_json) as f:
    data = json.load(f)

on_disk = {f.replace(".jsonl", "") for f in os.listdir(sessions_dir) if f.endswith(".jsonl")}
referenced = set()
for key, value in data.items():
    if isinstance(value, dict):
        sid = value.get("sessionId")
        if sid:
            referenced.add(sid)

# Delete orphaned .jsonl files
orphans = on_disk - referenced
deleted_bytes = 0
for sid in orphans:
    fpath = os.path.join(sessions_dir, sid + ".jsonl")
    size = os.path.getsize(fpath)
    os.remove(fpath)
    deleted_bytes += size

# Remove dead keys from sessions.json
cleaned = {}
dead_keys = []
for key, value in data.items():
    if isinstance(value, dict):
        sid = value.get("sessionId")
        if sid and sid not in on_disk and sid not in referenced:
            dead_keys.append(key)
            continue
    cleaned[key] = value

if dead_keys or orphans:
    shutil.copy2(sessions_json, sessions_json + ".bak")
    with open(sessions_json, "w") as f:
        json.dump(cleaned, f, indent=2)

remaining = len([f for f in os.listdir(sessions_dir) if f.endswith(".jsonl")])
print(f"Deleted {len(orphans)} orphan files ({deleted_bytes/1024:.0f}K freed)")
print(f"Removed {len(dead_keys)} dead keys from sessions.json")
print(f"Remaining: {remaining} .jsonl files, {len(cleaned)} session keys")
PYEOF
