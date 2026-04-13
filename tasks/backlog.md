# Backlog

_(P0s complete. Remaining P1 items below.)_

## P1: Mission Control — Agent Model Monitor Panel — SHIPPED Apr 13, 2026 (ralph-overnight)
- API: GET /api/agents/model-status + POST /api/agents/model-sync
- Push script: scripts/push-model-status.py scans session jsonl for model_change + cost, pushes to VendTech
- Integrated into sync-mission-control.sh (runs every sync cycle)
- Office page: table with per-agent model, cost/24h, tier (🟢/🟡/🔴), last run
- Currently showing 34 agents: 30 🟢 free, 4 🟡 Sonnet, 0 🔴 Opus
- Commits: 287e4b6, b6e17e6, 49e2e5d

## Completed
- **P0: Office "Right Now" + Machine Setup UI** — Shipped Apr 8, 2026 (ralph-overnight). Fixed 5-min staleness, added 5 real machine models + full status flow (ordered→active), purchase tracking. commits: 7e4a48c, 8ea6a6c
- **P0: Locations Schema + Rev Share + Collections API + Health Check** — Built and shipped Apr 8, 2026 (ralph-overnight). Created locations.html with rev share color coding, /api/locations/:id/collections CRUD, /api/admin/health-check. commit: 8fa560f
- **P0: E2E test scripts** — Built and shipped Mar 2, 2026 (ralph-overnight). Created all 4 missing test scripts. 28 checks, all passing. commit: 587b1ea
- **P1: push-learnings.py** — Built and shipped Feb 25, 2026 (ralph-overnight). Reads shared/learnings.md + optional feedback files, pushes 622 patterns to /api/team/learnings. Cron: push-learnings 10:30 AM + 9:30 PM.

## P1: Mission Control Live Status Integration — SHIPPED Apr 9, 2026
Added QA Verifier, Self-Heal Watchdog, Kimi Dispatcher to office floor (row 2), status-v2 API, AGENT_ROSTER, and display name mapping. Commits: b15d924, 29a1a3a.

## P0: Office Page — Use Cron Job State as Source of Truth — SHIPPED Apr 8, 2026
Fixed: `/api/agents/live-status` now reads cron data pushed from Mac mini via POST `/api/agents/cron-sync`. Shows 8 working agents (was 0). Sync script pushes 51 jobs. Commits: 8695aa1, 11f8ea0.

## P1: Mission Control Office — Show Real Agent Status — SHIPPED Apr 9, 2026
Fixed: Added /api/office/status-v2 that merges office-activity.json + VendTech live-status. Connected GitHub repo to Railway for auto-deploy. Commit: a2b2931.

## P0: Office "Right Now" — SHIPPED Apr 8, 2026
Fixed 5-min staleness window. Completed:/Idle prefix detection. Verified on MC office page. commit: 7e4a48c

## P1: CRM Pipeline — Recent Opens Tracking — SHIPPED Apr 8, 2026
Added re-opened badges, CALL TODAY flags, filter button, stat counter to CRM page. 9 prospects detected, 4 flagged CALL TODAY. commit: 4983c62

### Relay's daily report integration — SHIPPED Apr 9, 2026
Added "Reopened This Week" section to briefing API (JSON + text) and briefing.html page. 23 prospects detected, 8+ flagged CALL TODAY. commit: 06376a2

**Data already exists:** `email_tracking[].last_event_at` and `_adjusted_opens` per prospect.

**Dashboard (vend.kandedash.com/pipeline or /crm):**
- Add a "Last Opened" column showing the most recent external open date
- Add a "🔥 Re-opened" badge/indicator if last_event_at is within last 7 days AND was_replied=false
- Sort hot prospects by last_event_at DESC (most recently opened first)
- Color code: opened <3 days = red urgent, <7 days = orange, >7 days = normal

**Relay's daily report should include:**
- New section: "Reopened This Week" — prospects who opened within last 7 days that haven't been followed up
- Flag: if a prospect has 3+ total opens AND last_event_at < 7 days ago AND was_replied=false → CALL TODAY

The logic: recent re-opens = renewed interest. That's the signal to prioritize.

After shipping, screenshot the pipeline page showing the new column.

## P0: Operations Backend — 5 Machines Arriving in 3 Weeks — ALL SUB-ITEMS SHIPPED
_Machine Setup UI (8ea6a6c), Locations + Rev Share (8fa560f), Revenue Tracking (revenue.html + collections API), Restock Workflow (restock.html + APIs), Data Integrity (26 addresses fixed Apr 9)_
5 real vending machines arriving in ~3 weeks:
- 2x Sandstar VRK (smart vending)
- 1x CVM13 (combo vending)
- 1x Taste GDM26 (glass door merchandiser - drinks/snacks)
- 1x Taste Freezer (frozen)

Note: Sandstar VRK = AI-powered camera-based machine. May have API/telemetry we can connect to. Backend needs to be ready for actual operations.

### What needs to be built/fixed:

**1. Machine Setup UI** (vend.kandedash.com/machines)
- Form to add each machine: model, serial number, purchase date, capacity
- Status flow: ordered → in transit → received → installing → active
- Assign machine to a location (must link to a prospect/signed contract)

**2. Locations** (currently 0 in DB)  
- Create location records for wherever the 5 machines are going
- Each location needs: name, address, contact name, contract start date, rev share %, expected monthly revenue
- Link to the CRM prospect record

**3. Revenue Tracking**
- /api/locations/:id/collections endpoint — log each collection (date, cash amount, card amount, total)
- Monthly revenue rollup per location
- Dashboard showing revenue per machine, revenue per location

**4. Restock Workflow** (/restock page)
- Show current inventory levels per machine
- Flag machines that need restocking (below threshold)
- Log restock events

**5. Data Integrity Check** — SHIPPED Apr 9, 2026
- ~~Fix 25 prospects with missing name/address~~ Fixed 26 prospects via web-researched addresses. `prospects_missing_address`: 26→0.
- ~~Add a /api/admin/health-check endpoint~~ Already shipped (commit 8fa560f).

### Priority: P0 — machines arrive in 3 weeks, this needs to work before then.
Build in this order: Locations → Machines → Revenue → Restock


## P1: MC Office — Kimi banner + cost banner not deploying — PARTIALLY FIXED Apr 9, 2026
- ~~Commits pushed to kande-mission-control repo but Railway not auto-deploying~~ FIXED: Connected GitHub repo to Railway. Auto-deploy now works.
- Kimi heartbeat banner visible on office page (shows "Offline" currently)
- Cost banner visible ($1465.82/week, $188.14/day)
- Remaining: Fix "Starting task" placeholder text in activity feed

## P1: MC Office fixes (3 issues) — ALL RESOLVED Apr 9, 2026

### 1. Kimi heartbeat shows "Offline" — FIXED Apr 8, 2026
Created kimi-heartbeat.sh LaunchAgent. MC shows Online when Kimi is running.

### 2. Conflicting heartbeat scripts — FIXED Apr 9, 2026
Two scripts (kimi-heartbeat.sh and mc-heartbeat.sh) were fighting. mc-heartbeat.sh is authoritative (tests actual inference). Disabled kimi-heartbeat LaunchAgent. Kimi correctly shows Offline when no model loaded on exo.

### 3. "Starting task" placeholders — RESOLVED
Cleared naturally with new real activity data.

## P1: Briefing Hot Lead Priority — SHIPPED Apr 9, 2026
Replaced hardcoded "Updated Feb 21" Hot Lead section with dynamic API-driven ranking. Scores based on status, priority, unit count, activity recency, email engagement, and Google reviews. Top 10 leads auto-update daily. Commits: 683359c, 0ff9d4b.

## P1: Office page "Tasks Running" out of sync with "Right Now" — SHIPPED Apr 9, 2026
Banner now syncs from same updateScene() data as Right Now section (pollStatus → /api/office/status-v2 every 15s). No more heartbeat fallback. Commits: 86b4d72, 080a055. Verified live — banner and Right Now show matching count.
