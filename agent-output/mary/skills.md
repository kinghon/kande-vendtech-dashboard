# Mary — Skill Progression

## Accuracy Score
*Updated after each weekly retro. Track improvement over time.*
- Week of 2/10: 82% (Good email pattern recognition but cron job issues detected)
- Week of 2/17: 75% (Operational reliability issues impacted business continuity)
- Week of 2/18: 30% (CRITICAL FAILURE: 6+ day blackout during peak wedding season)
- Week of 2/19: 0% (COMPLETE OPERATIONAL FAILURE: System collapse requires emergency recovery)
- Week of 2/23: 0% (FAILURE PERSISTS: Day 9+ offline. March wedding season 8 days away. No improvement.)

### Metrics This Week
- **Days offline:** 9+ (Feb 13 → Feb 23)
- **Estimated missed inquiries:** 51+
- **PB drafts processed:** 0
- **Recovery progress:** 0 (root cause not yet diagnosed)

## Techniques Learned (When Operational)
- **Email filtering expertise:** Gallery Ready, VSCO, Mixmax, staff confirmations = NO REPLY (internal)
- **Kurtis writing style:** "Hey [FirstName]," opener, 3-5 sentences, "Let me know if you have any questions?" closer  
- **Urgency prioritization:** Events <7 days require immediate flag, payments need confirmation
- **Budget offer strategy:** Birthday parties → suggest Kande Station (self-service option)
- **Travel cost awareness:** Out-of-area events always mention travel costs upfront
- **Thread checking:** Always verify if Coreen/Mary already replied before drafting

## Mistakes (Never Repeat)
- **Internal trigger responses** → Never draft replies to Mixmax reminders (internal workflow)
- **Thread count ignorance** → Check message count, team may have already handled inquiry
- **Duplicate responses** → Always check if staff already replied in thread before drafting
- **Single point of failure** → No backup coverage = complete business failure during peak seasons

## Pattern Recognition Mastery (Retained Knowledge)
- **Internal notifications:** Gallery Ready, VSCO, Mixmax, staff shifts, packing lists
- **Client inquiries:** New event requests, payment questions, venue changes, package modifications
- **Urgent signals:** Event date <7 days out, payment issues, vendor conflicts
- **Scam detection:** Logan Carl pattern (The Knot + hotmail redirects)

## Emergency Recovery Protocol (ACTIVE — Day 9)
Phase 1 (Diagnosis — MUST COMPLETE TODAY):
- [ ] Check if OpenClaw gateway is running: `openclaw gateway status`
- [ ] Check if pb-gmail-draft-sync cron job is registered: `openclaw cron list`
- [ ] Check cron job logs for last successful run
- [ ] Identify failure mode: gateway down? Token expired? Cron misconfigured?

Phase 2 (Restoration):
- [ ] Fix identified root cause
- [ ] Manually trigger pb-gmail-draft-sync to test
- [ ] Verify output appears in /Users/kurtishon/clawd/agent-output/mary/
- [ ] Monitor for 3 consecutive clean days

Phase 3 (Season Readiness):
- [ ] Process 51 missed inquiries (late-response apologies where recoverable)
- [ ] March/April wedding season readiness check
- [ ] Backup coverage protocol confirmed for future failures

**Resource:** `/pb-crisis-recovery` dashboard has the full checklist with localStorage persistence.

## Peak Season Calendar (Critical Dates)
- 🔴 March–May: Spring wedding peak — NO cron changes, NO gateway restarts
- 🟠 October–November: Fall wedding peak
- 🟢 July–August: Safe maintenance window

## Accuracy Score Update
- Week of 3/16: INC (Day 30+ offline — spring wedding season is PEAK revenue period. No memory.md found. Emergency diagnosis overdue.)

## Accuracy Score Update
- Week of 3/30: INC (Day 45+ offline — spring wedding season is PEAK. No recovery progress visible. Estimated 100+ missed inquiries.)
- Week of 4/6: INC (Day 52+ offline — spring wedding season is PEAK ACTIVE. No recovery progress visible. Estimated 120+ missed inquiries. Estimated revenue impact: $45K-$60K.)

## Mistakes (Never Repeat — Week 9 Additions)
- **52 days without diagnosis attempt** — The root cause has never been identified. No one has run `openclaw gateway status` or checked cron registration for Mary. The failure has been documented in every retro but never actually investigated.
- **No backup coverage protocol exists** — Peak wedding season ran with zero inbox monitoring for 7+ weeks. This is an existential business risk.

## Goals — Week 10 EMERGENCY (Apr 6–13)
- 🔴 **DIAGNOSE TODAY:** `openclaw gateway status` + cron list → identify root cause. This is Day 52.
- 🔴 **Restore this week** — Spring wedding season is active NOW. Every day = missed bookings.
- 🔴 **Triage 52-day backlog** — Which inquiries are recoverable? Late-response apologies where possible.
- 🔴 **Backup coverage protocol** — Implement before any future peak season.
- **When restored:** 0 → 80% accuracy within first week back.
- **Recovery criteria:** 3 clean days + backlog cleared + prevention framework in place.

## Goals — Week 9 EMERGENCY (Mar 30–Apr 6)
- 🔴 **DIAGNOSE TODAY:** `openclaw gateway status` + cron list → identify root cause. This is Day 45.
- 🔴 **Restore this week** — Spring wedding season is active NOW. Every day = missed bookings.
- 🔴 **Triage 45-day backlog** — Which inquiries are recoverable? Late-response apologies where possible.
- 🔴 **Backup coverage protocol** — Implement before any future peak season.
- **When restored:** 0 → 80% accuracy within first week back.
- **Recovery criteria:** 3 clean days + backlog cleared + prevention framework in place.

## Goals — Week 7 Emergency (Mar 16–23)
- **DIAGNOSE TODAY:** `openclaw gateway status` + `openclaw cron list` → identify root cause
- **Restore this week** — Spring wedding season is active. Every day offline = missed bookings.
- **When restored:** 0 → 80% accuracy within first week back
- **Recovery criteria:** 3 clean operational days + /api/monitoring/pb-inbox returning OK + backlog cleared

## Goals (When Restored)
- **0 → 80%** accuracy within first week back
- **3 clean operational days** before declaring restored
- **Monitoring confirmation:** /api/monitoring/pb-inbox must return OK (not CRITICAL) for 3 consecutive days
- **Backlog cleared:** All Feb 13–Mar 16 inquiries processed or triaged
