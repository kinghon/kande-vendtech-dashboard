# ARCHITECTURE.md — Jumpgate Industries

> **Critical reading for any agent touching Jumpgate code.** Read this before making ANY change.

---

## What Jumpgate Is

Jumpgate is NOT a web server. It's a **content business engine** with two components:

1. **faceless-engine/** — Static HTML pages for faceless digital content ventures (build → monetize → flip)
2. **transcription-engine/** — Python pipeline for Rev.com transcription arbitrage

The Jumpgate Industries **company website** (jumpgateindustries.com) is hosted on **GitHub Pages** — separate from this repo.

---

## Repo Structure

```
jumpgate/
├── faceless-engine/
│   ├── pages/
│   │   ├── budgetbytemeals/     ← Static site: BudgetByteMeals.com (live, building)
│   │   │   ├── index.html       ← Landing page
│   │   │   ├── blog/            ← Blog posts
│   │   │   │   ├── index.html
│   │   │   │   ├── grocery-store-hacks.html
│   │   │   │   ├── meals-under-3-dollars.html
│   │   │   │   ├── freezer-meal-bible.html
│   │   │   │   ├── sunday-meal-prep.html
│   │   │   │   └── feed-family-50-week.html
│   │   │   ├── assets/          ← CSS, images
│   │   │   ├── lead-magnet/     ← Lead magnet download page
│   │   │   └── product/         ← Product sales page
│   │   └── remotepaycheck/      ← Static site: RemotePaycheck.com (planning)
│   │       └── research/        ← Research notes
│   ├── BUSINESS-PLAN.md         ← Full portfolio plan ($525K flip target)
│   ├── PIPELINE.md              ← 8 active portfolio ventures + priority order
│   ├── QUALITY-STANDARD.md      ← Content quality standards
│   └── ECONOMICS.md             ← Flip economics model
└── transcription-engine/
    ├── transcribe.py            ← Whisper wrapper + quality scoring
    ├── monitor.py               ← Gmail job detection + dashboard polling
    ├── pipeline.py              ← End-to-end Rev.com job orchestrator
    ├── README.md                ← Full setup + operation guide
    ├── RESEARCH.md              ← Rev.com rates, accuracy, ToS findings
    └── ECONOMICS.md             ← Profit projections ($200–800/month)
```

---

## File → URL Map

### BudgetByteMeals (Status: 🔨 Building, Target: $7K MRR / $84K flip)

| File | Served At | Notes |
|------|-----------|-------|
| `pages/budgetbytemeals/index.html` | budgetbytemeals.com/ | Landing page, $27 product ("$50/Week Family Meal Plan") |
| `pages/budgetbytemeals/blog/index.html` | budgetbytemeals.com/blog | Blog index |
| `pages/budgetbytemeals/blog/grocery-store-hacks.html` | budgetbytemeals.com/blog/grocery-store-hacks | |
| `pages/budgetbytemeals/blog/meals-under-3-dollars.html` | budgetbytemeals.com/blog/meals-under-3-dollars | |
| `pages/budgetbytemeals/blog/freezer-meal-bible.html` | budgetbytemeals.com/blog/freezer-meal-bible | |
| `pages/budgetbytemeals/blog/sunday-meal-prep.html` | budgetbytemeals.com/blog/sunday-meal-prep | |
| `pages/budgetbytemeals/blog/feed-family-50-week.html` | budgetbytemeals.com/blog/feed-family-50-week | |
| `pages/budgetbytemeals/lead-magnet/` | budgetbytemeals.com/lead-magnet/ | Lead capture |
| `pages/budgetbytemeals/product/` | budgetbytemeals.com/product/ | Product sales |

### RemotePaycheck (Status: 📋 Planning)

| File | Notes |
|------|-------|
| `pages/remotepaycheck/research/` | Research materials only, not yet live |

### Jumpgate Industries Company Website

| Domain | Hosting | Source |
|--------|---------|--------|
| jumpgateindustries.com | **GitHub Pages** → kinghon.github.io | Separate from this repo |
| www.jumpgateindustries.com | CNAME → kinghon.github.io | |
| cal.com/jumpgateindustries | Cal.com | Booking link |

**DNS (jumpgateindustries.com zone):**
- A records → GitHub Pages IPs: 185.199.108-111.153
- CNAME www → kinghon.github.io
- MX → Google Workspace
- DKIM + SPF configured

> **To change the company website:** Edit the GitHub Pages repo at github.com/kinghon/kinghon.github.io (or however it's configured), NOT this directory.

---

## Deploy Topology

### BudgetByteMeals — Static Site Hosting

**No server.** Pure static HTML. Hosting TBD (likely Vercel, Netlify, or GitHub Pages).

To deploy changes:
1. Edit HTML files in `pages/budgetbytemeals/`
2. Push to GitHub (if CI/CD configured) OR manually upload/deploy

**There is no railway.toml, no server.js, no build step.** Files are plain HTML + CSS.

### TranscriptionEngine — Local Python Scripts

**Runs on Kurtis's Mac Mini.** Not deployed to cloud.

```bash
cd /Users/kurtishon/clawd/jumpgate/transcription-engine/

# Check for new Rev.com jobs via Gmail
python3 monitor.py --check

# Process next queued job through Whisper pipeline
python3 pipeline.py

# View earnings log
python3 pipeline.py --log
```

**Cron (Mac Mini):** Runs `monitor.py --check` every 5 minutes, 6am–11pm

**Dependencies:**
- OpenAI Whisper (`/opt/homebrew/bin/whisper`, already installed)
- Python 3
- ffmpeg (for audio duration detection)
- gog (Gmail CLI tool, for job detection)

**Environment vars needed:**
- `TELEGRAM_BOT_TOKEN` — for job notifications
- `REV_SESSION_COOKIE` — optional, for dashboard polling (expires periodically)

---

## Portfolio Ventures

From `PIPELINE.md` (as of 2026-02-22):

| # | Venture | Type | Status | Target MRR | Target Flip |
|---|---------|------|--------|-----------|-------------|
| 1 | BudgetByteMeals | Faceless Page | 🔨 Building | $7,000 | $84,000 |
| 2 | RemotePaycheck | Faceless Page | 📋 Planning | $6,000 | $72,000 |
| 3 | NotionVault | Faceless Page | 📋 Planning | $6,000 | $60,000 |
| 4 | PrintableNest | Faceless Page | 📋 Planning | $4,000 | $48,000 |
| 5 | GearGuideHQ | Niche Affiliate | 📋 Planning | $3,000 | $105,000 |
| 6 | SheetStack | Faceless Page | 📋 Planning | $4,000 | $48,000 |
| 7 | NicheInbox | Newsletter | 📋 Planning | $3,000 | $72,000 |
| 8 | TipFeed | Social Page | 📋 Planning | $3,000 | $36,000 |

**Build priority:** BudgetByteMeals first → RemotePaycheck → GearGuideHQ

---

## No API Endpoints

Jumpgate faceless pages are static HTML — no server, no API, no auth.

BudgetByteMeals monetizes via:
- Direct digital product sales (likely Gumroad/Stripe embedded)
- Email list (ConvertKit or similar, embedded forms)
- Affiliate links in blog content

---

## Theme Rules

BudgetByteMeals uses its own CSS (`assets/style.css`). No shared theme system. Each venture gets its own branding.

---

## Verification Checklist

After editing BudgetByteMeals pages:

1. Open the HTML file locally in a browser and verify it renders
2. Push to GitHub / upload to hosting
3. `/usr/bin/curl -sL https://budgetbytemeals.com/<page>` and verify HTML is updated
4. Check that product links, lead magnet forms still work

After editing TranscriptionEngine scripts:

1. Run `python3 transcribe.py /path/to/test.mp3 --model turbo` to test Whisper
2. Run `python3 monitor.py --check` to test job detection
3. Review output before running live

---

## Common Gotchas

1. **No server = no dynamic routing** — all URLs must correspond to actual .html files or a directory with index.html
2. **Whisper session cookie expires** — `REV_SESSION_COOKIE` needs periodic refresh; Gmail monitoring is more reliable
3. **Rev.com quality threshold** — confidence score < 0.75 = auto-skip. DO NOT submit AI output without human review (deactivation risk)
4. **Company website is GitHub Pages** — editing files here does NOT affect jumpgateindustries.com
5. **No CI/CD set up yet** — file changes must be manually deployed to hosting
6. **BudgetByteMeals uses relative paths** (`assets/style.css`) — paths must stay consistent with hosting structure
