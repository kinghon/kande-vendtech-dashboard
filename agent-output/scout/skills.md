# Scout — Skill Progression

## Accuracy Score
*Updated after each weekly retro. Track improvement over time.*
- Week of 2/10: 85% (First week — excellent lead quality but API issues)
- Week of 2/17: 92% (Portfolio timing excellence, call-ready lead quality improved)  
- Week of 2/18: 96% (Call-ready excellence + enterprise-scale discovery achieved)
- Week of 2/19: 97% (Premium demographics mastery, enterprise portfolio evolution)
- Week of 2/23: 97% (Maintained — saturation pivot to Kande Digital mission was strategically correct; held pending first HVAC leads added)

### Metrics This Week
- **CRM:** 518 → 522 entries (4 new leads added on final run)
- **TAM complete:** All LV/Henderson verticals declared saturated at 463 comprehensive prospects
- **Kande Digital tracker:** Live and empty — HVAC sprint pending
- **Address corrections filed:** 2 (Beals-Henderson Pointe, Gholson Landing)
- **Quality standard maintained:** 100% direct phone/contact on all new leads

## Techniques Learned
- **Portfolio-first strategy:** Target management companies for 10-20x leverage vs individual properties
- **Timing windows:** Properties opening within 30-60 days = highest conversion opportunity  
- **GOED/LVGEA board meetings** are gold mines for new business relocations
- **Geographic focus:** Henderson corridor consistently outperforms other areas
- **API backup planning:** Browser tool for Google searches when Brave Search fails
- **Competitive intelligence methodology:** Yelp reviews, regulatory filings, industry publications
- **Contact verification:** Always include ready-to-call info with leads (no research → outreach delay)
- **Property type filtering:** For-sale townhomes ≠ vending opportunities (no common areas)
- **TAM completion methodology:** Systematic vertical-by-vertical saturation mapping → declare saturation when <2 new leads/run
- **Saturation-as-forcing-function:** When broad scans return 0 new leads, it's a signal to pivot, not a failure
- **Kande Digital research criteria:** Established 2+ years, 2-20 employees, <4.0 stars OR <20 reviews OR last GMB post >6 months
- **Franchise filter:** Corporate HVAC franchises (Carrier/Lennox/Trane) ≠ Kande Digital targets — independent operators only
- **One research pass, two lead lists:** GMB score is neutral; business type determines which product applies (service biz → Kande Digital, vending-eligible → VendTech)
- **CRM status diff discipline:** Run GET /api/crm/status-diff at end of every run; POST snapshot after

## Mistakes (Never Repeat)
- **Suggested gyms/car dealerships** → Kurtis vetoed hard (wrong verticals)
- **Strip focus initially** → monopolized territory, wasted research time
- **Small offices (<50 employees)** → not worth the effort for ROI
- **Address verification gaps** → always verify on Google Maps before CRM entry
- **Research volume without conversion focus** → 400+ leads vs 12 proposals = bottleneck
- **Adding leads to unclaimed verticals without Relay sequences** → tech, aerospace, education, govt all sitting unworked

## Techniques Learned (Week 4 Additions)
- **Two-axis lead scoring:** Heat (revenue ceiling) ≠ Urgency (timing window). Add `timing_window: express|warm|nurture` to every CRM push. Route by window, not heat.
- **Construction site = project-duration contract:** Revenue math rivals Portfolio Brand Program at peak workforce. Decision-maker = site superintendent. Entry window = mobilization phase (first 60-90 days).
- **Data center economics:** Zero-egress shift workers + tech/engineering demographics = employer break room pitch with premium product framing. Decision-maker = facilities director.
- **Nonprofit dual-placement model:** Staff break room (employer track) + client-accessible machine (healthcare track). Pitch during construction, not at opening. Tag: `channel: nurture, follow_up_date` at research time.
- **`portfolio_parent` tagging:** Tag any two CRM entries under same management org with `portfolio_parent`. Relay aggregates into one account conversation.
- **Address-level dedup (when endpoint live):** Hit `/api/prospects/dedup-check?address=` before filing — name-match misses branded health systems that use different trade names.
- **Healthcare monthly monitoring required:** 10+ leads in 4 consecutive weeks confirms Nevada build cycle. Quarterly is no longer sufficient for this vertical.

## Mistakes (Never Repeat)
- **HVAC sprint blocked 2+ weeks** → Don't start Kande Digital research without verifying Ralph's tracker endpoint exists first. Check /api/digital/prospects before promising sprint output.
- **LV Recovery Hospital duplicate** → 5118 and 6511 both filed because dedup relied on name match. Dedup must include address (or be Ralph's API endpoint).
- **Pearl Apartments routing:** Classified HOT but 2028 opening — sent to active pipeline. Nurture leads must have `follow_up_date` or they pollute the call sheet.

## Accuracy Score Update
- Week of 3/9: 97% (maintained — monitoring mode discipline held, VenHub competitive intel delivered, no wasted broad scans)

## Mistakes (Never Repeat — Week 5 Additions)
- **HVAC sprint week 3 blocked** → Do not initiate Kande Digital research until `/api/digital/prospects` is confirmed live. Waiting on Ralph is correct behavior; promising sprint output before the tracker exists is not.

## Accuracy Score Update
- Week of 3/16: 97% (maintained — monitoring mode discipline held, +35 leads added, Kande Digital finally unblocked by /api/digital/prospects going live)
- Week of 3/23: 97% (maintained — seasonal employer timing discovery, AV tech vertical unlocked, NBVA hook intelligence delivered; HVAC sprint still at 0 — must execute Week 8)

## Techniques Learned (Week 7 Additions)
- **Seasonal employer timing:** Vendor window = hiring sprint announcement date, NOT facility age. Waterparks, stadiums, seasonal venues re-enter vendor selection each spring. Tag `seasonal_vendor_window: spring_ramp | fall_ramp` at research time.
- **AV tech ops vertical:** Autonomous vehicle ops hubs (Motional, Zoox) = employer break room economics + tech org chart. Single facilities/VP Ops decision-maker. Faster cycle than residential. Tag `decision_authority: tech_facility_director` before activation.
- **Two-venue seasonal operator = portfolio call logic:** Same operator running two venues = one corporate call, two placements. Same RPM Living pattern.
- **GMB incumbent check before seasonal call:** Staff reviews mentioning "break room," "vending," "food" = incumbent satisfaction signal before the call.
- **decision_authority is mandatory on all employer-category leads:** Wrong caller kills a warm lead. Tag before CRM filing, not after.

## Mistakes (Never Repeat — Week 7 Additions)
- **HVAC sprint at 0 entering Week 8** → /api/digital/prospects has been live since Week 6. Three weeks of waiting after the unblock. Do not wait for external permission to execute a defined sprint. Start immediately when the prerequisite ships.

## Accuracy Score Update
- Week of 3/30: 97% (maintained — no visible output Week 8; system may have been idle; HVAC sprint now Week 4 overdue)

## Accuracy Score Update
- Week of 4/6: 97% (maintained — no visible output Week 9; system may have been idle for 2+ weeks; HVAC sprint now Week 5 overdue)

## Goals Next Week (Week 10, Apr 6–13)
- 🔴 **HVAC sprint — 20 Kande Digital leads — WEEK 5 OVERDUE — FINAL LISTING** → Execute this week or the goal is permanently removed and documented as abandoned. No remaining blocker since Week 6.
- **Incumbent vendor research pass** — Top 10 HOT accounts. Output: `incumbent_vendor` field (carryover).
- **decision_authority on all new employer leads** — Tag before filing (carryover).
- **Aviation corridor batch** — Henderson Executive Airport + NLV Airport clusters (MRO, charter, cargo, flight training). Target 10-15 leads.
- **vendor_window_close date** — Add to any NOW LEASING leads.

## Goals Last Week (Week 9, Mar 30–Apr 6)
- **HVAC sprint — 20 Kande Digital leads — WEEK 4 OVERDUE** → /api/digital/prospects has been live since Week 6. No remaining blocker. Execute TODAY.
- **Incumbent vendor research pass** — Top 10 HOT accounts. Output: `incumbent_vendor` field.
- **decision_authority on all new employer leads** — Tag before filing.
- **vendor_window_close date** — Add to any NOW LEASING leads.
- **Cadence Crossing Casino competitive intel** — Boyd Gaming Henderson vending landscape.

## Goals Last Week (Week 8, Mar 23–30)
- **HVAC sprint — 20 Kande Digital leads — NO MORE DELAYS** → Independent operators, 2+ yrs, <4.0 stars OR <20 reviews OR stale GMB, franchise filter ON. This is week 3 of a defined sprint that should have started in week 5.
- **Incumbent vendor research pass** — Top 10 HOT accounts (Regus HH, EVO, Jade, Atwell, Work In Progress, OfficeNest, Boxabl, Boring Co, KB Home, Cadence Crossing). Output: `incumbent_vendor` field. Changes Jordan's opening script.
- **decision_authority on all new employer leads** — Tag before filing, not after.
- **vendor_window_close date** — Add to any NOW LEASING leads.
- **Cadence Crossing casino competitive intel** — What vending is currently in Boyd Gaming Henderson properties? Sets up the displacement vs. first-placement pitch.

## Goals Next Week (Week 7, Mar 16–23)
- **HVAC sprint — 20 Kande Digital leads** → /api/digital/prospects is live. Execute: 2+ yrs old, independent operators, <4.0 stars OR <20 reviews OR stale GMB. Franchise filter ON.
- **VenHub LV competitive monitoring** — Weekly check. 6 LV locations confirmed. Track any additional expansion signals.
- **NBVA Conference (Mar 17-19 LV)** — Monitor for competitive intel and industry news.
- **Healthcare monitoring** — Monthly cadence. Any new clinic within 90 days → express priority.
- **Incumbent vendor research pass** — For top 10 HOT accounts, research current vending situation. Output: incumbent_vendor field. Feeds coaching cards.

## Goals Next Week (Week 6, Mar 9–16)
- **VenHub LV 6 new locations** — ID which properties overlapping CRM. Flag as competitive alert in engagement-alerts.
- **Healthcare monitoring** — Any new clinic opening within 90 days → express priority, vendor_window_flag.
- **GOED sweep** — Check for Q1 2026 new business approvals (March/April board meetings).
- **Kande Digital HVAC sprint** — Execute 20-lead sprint as soon as Ralph confirms /api/digital/prospects live.
- **Shriners + Intermountain portfolio tag** — Confirm parent_org tags are current.

## Goals Next Week (Week 5, Mar 2–7)
- **NRP Silverado Ranch** — Monitor apartments.com weekly for leasing page launch
- **Moen DC** — Verify facility manager name if possible
- **SNRHA/Michaels Org** — Lewis Jordan contact + Beals/Gholson facilities contacts
- **Elysian Living portfolio map** — Any LV/Henderson properties not in CRM?
- **GOED Q1 2026 board meeting** — Check goed.nv.gov (March/April for new approvals)
- **Kande Digital HVAC sprint** — Wait for Ralph's /api/digital/prospects. Then: 20 leads, 2+ yrs, 2–20 employees, <4.0 stars OR <20 reviews OR stale GMB. Franchise filter ON.
- **Run CRM status diff** at end of every run → capture opening_soon → active transitions
