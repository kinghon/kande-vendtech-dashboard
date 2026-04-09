# Ralph — Skill Progression

## Accuracy Score
*Updated after each weekly retro. Track improvement over time.*
- Week of 2/10: 88% (Strong infrastructure delivery but some deployment discoveries)
- Week of 2/17: 91% (System reliability improved, monitoring infrastructure delivered)
- Week of 2/18: 94% (Analytics API delivered, monitoring prevented business crisis)
- Week of 2/19: 96% (Crisis prevention excellence, infrastructure investment ROI proven)
- Week of 2/23: 97% (Historically productive week — ~20 features shipped, Railway cache bug prevention system built; -1% for initial cache bug costing half a day Feb 21)

### Metrics This Week
- **Pages shipped:** 9+ new pages (Mission Control suite, Scout Intel, Digital stack, PB Crisis Recovery, Briefing rewrite, Account Tiers, Call Sheet, /usage)
- **APIs added:** ~40+ endpoints
- **Total routes:** 826 → 828 (server.js now ~25,635 lines)
- **Bugs fixed:** Railway cache bug, db.save() critical fix (9 instances), memory browser 500, routing duplicates, dark theme violations
- **Deployments:** DEPLOY_VERSION v1 → v2 (cache bust + incremental)
- **Zero regressions:** All existing functionality intact after massive expansion

## Techniques Learned
- **Railway deployment architecture:** Only dashboard/ subdirectory files deploy, but server.js sendFile paths determine which HTML files actually serve
- **HTML file management:** ALWAYS update root copy first, then sync to dashboard/ as backup
- **API design patterns:** Lightweight endpoints for agent-to-agent communication
- **Auth system mapping:** /team, /login, /client-portal, /driver are public; others redirect (302)
- **Testing methodology:** Public endpoints expect 200s, protected expect 302s, APIs need x-api-key
- **Theme consistency:** Light theme ONLY across all pages (Kurtis requirement) — curl 200 does NOT detect dark themes, visual check required
- **Code safety:** server.js is APPEND-ONLY for new routes to avoid breaking existing functionality
- **db.save() is WRONG; saveDB(db) is CORRECT:** There is NO db.save() method. Calling it causes 500 errors silently. Pattern: ALWAYS saveDB(db) after any mutation.
- **Railway cache-bust:** DEPLOY_VERSION comment in server.js forces nixpacks rebuild. Check /api/debug/deploy-version at session START. routeCount < 800 or allNewRoutesPresent=false = stale Railway.
- **Stale coaching architecture:** coaching_written_at + last_engagement_at → coaching_stale boolean → orange warning banner
- **Dynamic vs static call card fields:** Facts (engagement counts, days since contact) pull live from API. Coaching (openers, objections) editable by hand. Never mix them — stale facts in coaching language = Jordan undersells.
- **Engagement-alert → call card sync:** POST /api/pipeline/call-sheet/sync-alerts collapses two parallel pipelines into one execution layer
- **Call outcome aggregation:** Aggregate by opener type + vertical → identify scripts that convert → coaching quality improves over time
- **Sentinel idempotency pattern:** DB key by job+date (YYYY-MM-DD UTC). GET = check. POST = mark done. DELETE = force re-run. 409 = already ran. Apply to ALL periodic agent cron jobs.
- **Append-only workaround for broken routes:** broken /api/foo → new /api/foo-v2 → update callers. Never modify broken existing route.
- **node --check server.js before commit:** Zero deploy surprises from syntax errors
- **python3 urllib for complex API calls:** Avoids curl string escaping hell on complex JSON payloads

## Mistakes (Never Repeat)  
- **Dark theme usage** → Kurtis rejected immediately (always light theme; curl 200 doesn't catch this — visual QA only)
- **CRM page modifications** → protected pages need explicit approval first
- **Silent undefined handling** → `if (data.agents)` skips logic without error, use explicit fallbacks
- **Railway timing assumptions** → deployments can take 5+ minutes during busy periods
- **File location confusion** → Check sendFile paths in server.js to know which HTML copy serves
- **Modification without testing** → Always test URLs after 90s Railway deploy window
- **db.save() error** → 9 routes silently failing, found via evening QA — use saveDB(db) ALWAYS
- **Railway cache trust** → Always check /api/debug/deploy-version first thing every session; stale builds happen after >6h gap

## Business-Critical Infrastructure Lessons
- **Monitoring = crisis prevention:** Mary failure caught early vs weeks of potential blackout
- **System reliability = competitive advantage:** Infrastructure investment prevents revenue loss
- **Real-time alerting essential:** All critical agents need health monitoring
- **Business continuity protocols:** Backup coverage needed during peak revenue periods
- **Intelligence without execution = zero revenue:** Call sheet is the bridge from dashboard to actual calls made
- **Railway is a dependency:** Check deploy-version BEFORE and AFTER every session

## DB Keys Reference (memorize these — wrong key = silent empty data)
- `db.pipelineEngagement.alerts` — engagement alert data (NOT db.engagementAlerts)
- `db.callSheet` — call sheet cards
- `db.usageTurns` — Kurtis's usage tracking
- `db.digitalOnboarding` — Kande Digital client submissions
- `db.digitalProspects` — Kande Digital HVAC/pest/roofing research leads
- `db.memoryFiles` — seeded memory browser files
- `db.missionControlTasks` — kanban board tasks
- `db.teamStatus` — per-agent status data
- `db.teamActivity` — activity log feed

## Techniques Learned (Week 4 Additions)
- **E2E test infrastructure from scratch:** When test scripts are missing, generate all suites with explicit HTTP checks + schema validation. 28/28 tests, 4 suites, zero regressions.
- **Address-level dedup design:** `GET /api/prospects/dedup-check?address=` with 0.1mi radius match prevents split records on health systems with different trade names.
- **Healthcare vendor_window_flag architecture:** `property_type=healthcare AND opening_date ≤ 90 days → auto-flag EXPRESS in engagement-alerts`. Rule is in memory.md; it must be wired into API logic.
- **parent_org CRM tag:** Portfolio-linked leads tag `parent_org: "SNRHA/Michaels"` at Scout research time → `/api/pipeline/account-tiers` filters by parent → Relay sees grouped account, not two cold leads.
- **Piper blog infra needed first:** Content quality is not the bottleneck. Blog index pages are. `/blog` on kandevendtech.com and jumpgateindustries.com unlock SEO compounding for all future Piper output.

## Mistakes (Never Repeat — Week 4 Additions)
- **Kande Digital /api/digital/prospects deferred 2 weeks** → Scout's HVAC sprint is the Kande Digital revenue unblock. Deferring this endpoint is deferring an entire revenue stream. It ships before any cosmetic feature.
- **Blog index pages deferred** → Piper produced 3 posts week 1. All blocked on 30 minutes of Ralph work. Content velocity ≠ published content without the infra. Ship blog indexes same week Piper produces first batch.

## Accuracy Score (Updated)
- Week of 3/2: 97% (maintained — E2E infrastructure, bounce auto-flag, coaching staleness; -0% this week — clean week technically)

## Accuracy Score Update
- Week of 3/9: 93% (down from 97% — three Day-11 carryovers: blog indexes, bounce auto-flag, /api/digital/prospects all unshipped despite being named #1 for 2 retros. Offset by: 28/28 E2E held daily, pipeline board dark theme caught and fixed proactively.)

## Mistakes (Never Repeat — Week 5 Additions)
- **Carryover without escalation** → If an item is #1 priority for 2 consecutive retros and hasn't shipped, it needs a shipping window defined or explicit deprioritization. Re-listing without resolution burns retro credibility.
- **Blog indexes blocking Piper week 2** → Content without publish infra = wasted production. Any time an agent's entire output queue is blocked on a 30-minute Ralph task, that task is P0, not P2.

## Accuracy Score Update
- Week of 3/16: 95% (up from 93% — 27/27 endpoints passing, contract generator fixed (524e02a), no regressions. /api/digital/prospects now live — Scout HVAC sprint unblocked. Pending confirmation that blog index pages and bounce auto-flag shipped vs. stub-only.)
- Week of 3/23: 93% (down from 95% — funnel analytics fixed (proposals 0→29), 22/22 endpoints green, clean QA week; -2% for blog indexes, bounce auto-flag, and healthcare vendor_window_flag all unconfirmed shipped after 5+ weeks each)

## Techniques Learned (Week 6 Additions)
- **Contract template Railway path issue:** When an endpoint reads from a symlinked parent directory, the symlink doesn't survive Railway deployment. Fix: copy files into the repo directly (tracked by git), update the route path accordingly. Test: endpoint returns real template content, not 500.
- **route-patch for broken handlers:** When an existing route handler is broken, use `app._router.stack` to splice it out and register a corrected handler (APPEND-ONLY approach maintained). Commit cleanly with context.

## Accuracy Score Update
- Week of 3/30: 88% (down from 93% — no memory.md found, operational status unknown; blog indexes, bounce auto-flag, healthcare vendor_window_flag all 6+ retro carryovers without confirmed completion)
- Week of 4/6: 83% (down from 88% — still no memory.md. Blog indexes, bounce auto-flag, healthcare vendor_window_flag now 7+ retro carryovers — longest unresolved items in the operation. System silence for 2+ consecutive weeks.)

## Mistakes (Never Repeat — Week 9 Additions)
- **7+ retro carryovers** — Blog indexes, bounce auto-flag, and healthcare vendor_window_flag have appeared in every retro since Week 2. This is a credibility failure for the retro system. Ship, deprioritize with reasoning, or escalate.
- **No memory.md for 2+ weeks** — Without a memory file, operational status is invisible to the team.

## Goals Next Week (Week 10, Apr 6–13)
- 🔴 **Confirm operational status** — Is Ralph running? Check cron registration and last execution.
- 🔴 **FINAL CALL: Blog index pages** — Ship this week or permanently remove from all future retros. Day 39+.
- 🔴 **FINAL CALL: Bounce auto-flag** — Ship or permanently deprioritize. 7+ retros.
- 🔴 **FINAL CALL: Healthcare vendor_window_flag** — Wire or permanently deprioritize. 7+ retros.
- 🟠 **Self-closing proposal infrastructure** — DocuSign/PandaDoc or self-serve signing flow.
- 🟡 **72-hour reply escalation rule** — Auto-CRITICAL when replied lead has 0 call outcomes in 72h.
- 🟡 **Call outcome visibility badge** — Briefing page: "X calls / Y outcomes logged."

## Goals Last Week (Week 9, Mar 30–Apr 6)
- 🔴 **Confirm operational status** — Is Ralph running? Check cron registration and last execution.
- 🔴 **Blog index pages** — Ship or explicitly deprioritize with reasoning. Day 32+. 6+ retros.
- 🔴 **Healthcare vendor_window_flag** — Wire auto-trigger in engagement-alerts. 6+ retros unwired.
- 🔴 **Bounce auto-flag** — Confirm wired (not just endpoint-passing). 6+ retros.
- 🟠 **First Mover Window view** — Date-aware urgency layer from 3/10 water-cooler design.
- 🟡 **Call outcome visibility badge** — Briefing page: "X calls / Y outcomes logged."
- 🟡 **72-hour reply escalation rule** — Auto-CRITICAL when replied lead has 0 call outcomes in 72h.

## Goals Last Week (Week 7, Mar 16–23)
- 🔴 **Confirm blog index pages shipped** — If not live on kandedash.com/blog and jumpgateindustries.com/blog, this is Day 18+ block. Ship today.
- 🔴 **Confirm bounce auto-flag shipped** — If not wired (not just endpoint-passing), DraftKings pattern will repeat.
- 🟠 **Healthcare vendor_window_flag** — Wire auto-trigger in engagement-alerts (property_type=healthcare AND opening_date ≤ 90 days → EXPRESS)
- 🟡 **Call outcome visibility badge** — Briefing page: "X calls / Y outcomes logged"
- 🟡 **First Mover Window view** — Date-aware urgency layer (opened_date, completion_date, first_mover_window_close) built from 3/10 Scout × Ralph water-cooler

## Goals Next Week (Week 6, Mar 9–16)
- 🔴 **Blog index pages — ship today** (Day 11, 5 Piper posts blocked)
- 🔴 **Bounce auto-flag — ship today** (Day 11, DraftKings was victim #2)
- 🔴 **Kande Digital /api/digital/prospects** — Scout HVAC sprint week 3 blocked
- 🟡 **Healthcare vendor_window_flag** — Wire auto-trigger in engagement-alerts
- 🟡 **Call outcome visibility badge** — Briefing page: "X calls / Y outcomes logged"

## Goals Next Week (Week 5, Mar 2–7)
- 🔴 **Bounce auto-flag** — 4th standup. Ship today. No more silent lead losses.
- 🔴 **LV Recovery Hospital dedup** — Merge/archive 5118 vs 6511 before Relay calls.
- 🟠 **Blog index pages** — Jumpgate + VendTech. ~30 minutes. 3 Piper posts blocked.
- 🟠 **Kande Digital /api/digital/prospects** — Scout HVAC sprint unblocked after this ships.
- 🟡 **Healthcare vendor_window_flag** — Auto-trigger EXPRESS flag in engagement-alerts for property_type=healthcare + opening_date ≤ 90 days.
- 🟡 **Chart.js@4.4.0 pin** — Bundle with bounce auto-flag. 5 minutes.
- 🟡 **Call outcome visibility** — Badge on briefing page: "X calls / Y outcomes logged."
