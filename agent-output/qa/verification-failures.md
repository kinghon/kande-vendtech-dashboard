# Verification Failures — 2026-04-08 9:25 PM

## Summary
**7 of 9 queue items FAILED verification.** 2 passed (git hooks, PB draft sync).

The root cause is systemic: the infrastructure moved from Kimi proxy (:8081) to exo (:52415), but many cron jobs still reference `exo/mlx-community/DeepSeek-V3.2-8bit` and are timing out consistently.

## Critical Failures

### 1. Kimi Proxy v4 — DEAD
- Port 8081: connection refused
- Exo on :52415 is live and serving models (including Kimi K2.5 and DeepSeek V3.2)
- The old proxy is obsolete but many jobs still reference it

### 2. Ralph (Engineering Agent) — 26 consecutive errors
- Job: 813da536, schedule: every 30 min
- All timeouts on DeepSeek model via exo
- Last successful run: unknown (errors since at least Apr 6)
- **No engineering work being done**

### 3. QA Verifier — 12 consecutive errors
- Job: e1baa5be, same timeout pattern
- No commits being verified

### 4. Kimi Dispatcher — DISABLED
- Job: cc43e1e0, disabled after 14 consecutive errors
- Task queue is not being processed at all

### 5. Self-Heal Watchdog — DISABLED
- Job: a1c5f5dc, disabled
- /tmp/selfheal-status.json doesn't exist
- No infrastructure monitoring happening

### 6. MC Office Page — Stale Data
- Page loads (200) but agent status data is stale
- Agents aren't posting status because they're all timing out

## Pattern
All failures share the same cause: cron jobs using `exo/mlx-community/DeepSeek-V3.2-8bit` model are timing out within ~62 seconds. The exo API is reachable (:52415 returns model list) but inference requests from cron agents are failing.

Jobs using `exo/kimi-k2.5` (like nightly-extraction, relay, scout, piper) are succeeding fine.

## What Passes
- **Git hooks**: Installed, executable, correct content ✅
- **PB Gmail draft sync**: Working on kimi-k2.5 model, 0 errors ✅
- Jobs on `exo/kimi-k2.5` model generally work
- Jobs on `anthropic/claude-sonnet-4-6` work fine

## Recommendation
1. Switch all DeepSeek-model cron jobs to `exo/kimi-k2.5` or investigate why DeepSeek inference is timing out
2. Re-enable dispatcher (cc43e1e0) after fixing the model
3. Re-enable watchdog (a1c5f5dc) or create a replacement
4. Ralph needs to be fixed ASAP — no engineering work for days
