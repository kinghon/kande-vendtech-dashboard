# QA Test Manifest — Complete Page & API Inventory
# Updated: 2026-04-02
# Used by: kimi-qa-verifier agent

## VendTech Dashboard (vend.kandedash.com) — AUTH REQUIRED
All pages redirect to /login without auth. Use session cookie after login.

### Pages (browser test each)
- /login
- /home
- /crm
- /crm/map
- /pipeline
- /seo
- /map
- /machines
- /inventory
- /finance
- /restock
- /restock-planner
- /staff
- /clients
- /ai-office
- /kanban
- /performance
- /planogram
- /campaign-tracker
- /contracts
- /competitors
- /competitor-map
- /revenue
- /analytics
- /trends
- /property-analysis
- /micromarkets
- /lead-import
- /gift-baskets
- /pricing-strategies
- /bundles
- /pipeline
- /mobile-dashboard
- /forecasting
- /scraper
- /email-drafts
- /activities
- /usage
- /team (no auth)
- /content (no auth)
- /office (no auth)
- /digital (no auth)
- /onboard (no auth)
- /scout-intel (no auth)
- /account-tiers (no auth)
- /call-sheet
- /digital/prospects
- /calendar
- /memory
- /tasks
- /pb-crisis-recovery (no auth)
- /briefing.html
- /products
- /outreach
- /onboarding
- /contacts
- /email-templates
- /follow-ups
- /goals
- /leaderboard
- /notifications
- /operations
- /pipeline-board
- /playbook
- /pricing
- /product-mix
- /proposal-generator
- /reports
- /resources
- /restock-predictions
- /revenue-calculator
- /route-planner
- /routes
- /sales-analytics
- /schedule
- /search
- /service-log
- /settings
- /site-survey
- /smart-machines
- /strategy
- /task-manager
- /tax-strategy
- /testimonials
- /todos
- /vendors
- /warehouse
- /weekly-routes
- /win-loss
- /lead-review
- /daily-planner
- /fleet
- /funnel
- /api-monitoring
- /documents
- /contract-generator.html

### Key API Endpoints (curl test)
- GET /api/health
- GET /api/prospects
- GET /api/activities
- GET /api/machines
- GET /api/locations
- GET /api/products
- GET /api/inventory
- GET /api/seo
- GET /api/marketing/spend
- GET /api/marketing/roi
- GET /api/marketing/leads
- GET /api/marketing/gbp
- GET /api/clients
- GET /api/team/status
- GET /api/team/activity
- GET /api/content
- GET /api/usage/turns
- GET /api/agents/live-status
- GET /api/pipeline/engagement-alerts
- GET /api/pipeline/account-tiers
- GET /api/pipeline/call-sheet
- GET /api/pipeline/call-outcomes
- GET /api/crm/status-diff
- GET /api/maps/status
- GET /api/maps/leaderboard
- GET /api/mission-control/tasks
- GET /api/memory/db-list
- GET /api/playbook
- GET /api/briefing/text
- GET /api/monitoring/pb-inbox
- GET /api/monitoring/mary
- GET /api/digital/test
- GET /api/digital/onboard/list
- GET /api/digital/prospects
- GET /api/debug/deploy-version
- GET /api/activities/enriched
- GET /api/pipeline/healthcare-express
- GET /api/contract-generator/templates
- GET /api/jobs/sentinel/status

## PB Dashboard (pb.kandedash.com) — NO AUTH
### Pages
- / (homepage)
- /inbox (email inbox)
- /seo (SEO tracking)
- /trends (industry trends)
- /trends/share (shareable trends)

### Key API Endpoints
- GET /health
- GET /api/inbox
- GET /api/leaderboard
- GET /api/departments
- GET /api/seo
- GET /api/activity
- GET /api/stats
- GET /api/trends

## Mission Control (mc.kandedash.com → kande-mission-control-production.up.railway.app) — NO AUTH
### Pages
- / (homepage)
- /usage (API usage tracking)
- /office (agent office)

### Key API Endpoints
- GET /api/sync/status (if exists)

## Info Dashboard (info.kandedash.com) — AUTH REQUIRED (same as vendtech)
### Pages
- / (homepage, redirects to login)
- /home

### Key API Endpoints
- GET /api/health
- GET /api/prospects
- GET /api/seo
