# Sales Automation System Spec

## Overview
Connect Jordan's CRM activities → Pipeline → Proposals → Email Campaigns → Tracking

## Components

### 1. Action Items Command Center (vend.kandedash.com homepage)
Top of page, replaces or sits above current welcome banner:
- **🔥 HOT LEADS** — Prospects Jordan marked interested (need proposals)
- **📧 PROPOSALS PENDING** — Sent but not opened/responded
- **📞 FOLLOW-UPS DUE** — Tasks due today from campaign workflow
- **📝 JORDAN'S LATEST** — Recent activity log entries (last 48h)

### 2. Pipeline Automation
When Jordan logs activity → auto-advance pipeline:
- Activity type "pop_in" → move to "pop_in_done" stage
- Activity type "interested" or notes contain "interested" → move to "interested"
- Proposal created for prospect → move to "proposal_sent"
- Email reply detected → move to "negotiating"
- Contract sent → move to "contract_sent"

### 3. Auto-Proposal Generation
When prospect moves to "interested" stage:
- Pull prospect data (name, address, property type, units, contact)
- Generate proposal from template
- Save as draft proposal in system
- Create task: "Review & send proposal for [Property Name]"

### 4. Email Campaign Engine
When proposal is sent:
- Add prospect to follow-up drip campaign
- Schedule: Day 3, Day 7, Day 14, Day 21, Day 30
- Use Instantly.ai API for sending + tracking
- OR use Mixmax via Gmail (kurtis@kandevendtech.com)

### 5. Email Tracking (via Gmail/Mixmax)
- Check Gmail for Mixmax tracking labels
- Track: opened, clicked, replied
- If replied → remove from campaign, create task "Respond to [Name]"
- If opened but no reply after 3 days → create task "Call [Name] — opened email"
- If no open after 7 days → escalate touch method (email → call → pop-in)

### 6. Campaign Status on Pipeline
Each pipeline card shows:
- Current campaign step (e.g., "Follow-up #2 of 5")
- Last email status (opened/not opened/replied)
- Days since last touch
- Next scheduled action

## API Endpoints Needed

### New
- POST /api/campaigns — Start a campaign for a prospect
- GET /api/campaigns — List active campaigns
- GET /api/campaigns/:id — Campaign detail with email history
- PUT /api/campaigns/:id/pause — Pause campaign
- DELETE /api/campaigns/:id — Stop campaign
- POST /api/campaigns/check-replies — Cron endpoint to check Gmail for replies
- GET /api/action-items — Aggregated action items for homepage

### Enhanced
- POST /api/proposals (existing) — Also trigger campaign start
- PUT /api/pipeline/cards/:id/move (existing) — Also trigger auto-actions
- GET /api/activities (existing) — Add filtering by date range, type

## Email Templates (5-step follow-up)

### Email 1 (Day 3) — "Following up on our proposal"
Subject: Following up — Kande VendTech proposal for {property_name}
Brief, reference the proposal, ask if they have questions.

### Email 2 (Day 7) — "Quick question"
Subject: Quick question about {property_name}
Shorter, ask if they've had a chance to review.

### Email 3 (Day 14) — "Success story"
Subject: How {similar_property} added $X/month with zero cost
Share a case study or testimonial.

### Email 4 (Day 21) — "New availability"
Subject: Limited availability update — {area}
Urgency play — we're filling up in the area.

### Email 5 (Day 30) — "Last check-in"
Subject: Last check-in — {property_name}
Final touch, leave door open.
