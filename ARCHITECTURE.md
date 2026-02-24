# ARCHITECTURE.md — Kande VendTech Dashboard

> **Critical reading for any agent touching VendTech code.** Read this before making ANY change.

---

## ⚠️ RULE #0 — VERIFY FILE PATH BEFORE EDITING

**Before editing any file, run `find` to confirm it exists at that exact path.**

```bash
find ~/clawd/kande-vendtech -name "activities.html"
# → /Users/kurtishon/clawd/kande-vendtech/activities.html  ✅ repo root
# NOT dashboard/activities.html — that path does not exist
```

After editing, run `git status`. If it shows an **untracked** file instead of a **modified** file, you created a new file at the wrong path. Undo it immediately.

**ALL HTML files are flat in the repo root** (`~/clawd/kande-vendtech/*.html`). There is no `dashboard/` subdirectory with HTML files. `dashboard/` is the deploy working directory, not a file location.

This rule exists because agents repeatedly edited `dashboard/activities.html` (nonexistent) instead of `activities.html` (repo root), then deployed and wondered why nothing changed.

---

## ⚠️ THE BIG GOTCHA

**mc.kandedash.com and vend.kandedash.com are DIFFERENT Railway projects.**

| Domain | Railway Project | GitHub Repo | Purpose |
|--------|----------------|-------------|---------|
| vend.kandedash.com | Vend.Kandedash | `kinghon/kande-vendtech-dashboard` | VendTech CRM, pipeline, analytics, API |
| mc.kandedash.com | kande-mission-control | `kinghon/kande-mission-control` | Mission Control UI (team, office, tasks, usage) |
| sales.kandedash.com | Vend.Kandedash (same) | `kinghon/kande-vendtech-dashboard` | Sales dashboard (subdomain routing) |

**Pushing to `kande-vendtech-dashboard` does NOT update mc.kandedash.com.**
**Pushing to `kande-mission-control` does NOT update vend.kandedash.com.**

If you change a page that lives on MC, you must push to the MC repo.
If you change API endpoints, those live on VendTech — push to the VT repo.

---

## Repo 1: VendTech Dashboard (`kinghon/kande-vendtech-dashboard`)

**Local path:** `/Users/kurtishon/clawd/kande-vendtech/`
**Git remote:** `https://github.com/kinghon/kande-vendtech-dashboard.git`
**Railway project:** Vend.Kandedash → production
**Domains:** vend.kandedash.com, sales.kandedash.com

### Structure (FLAT — no subdirectories for app code)

```
kande-vendtech/
├── server.js          ← THE server (~25K lines, Express)
├── *.html             ← All dashboard pages (flat in root)
├── public/            ← Static assets (images, favicon, CSS)
├── data/              ← SQLite DB + JSON data files
├── ARCHITECTURE.md    ← This file
└── package.json       ← start: "node server.js"
```

`__dirname` = repo root. `express.static(__dirname)` serves ALL root files as static.

### Subdomain Routing

```javascript
// server.js line 345
if (req.hostname.startsWith('sales')) {
  // Sales-specific routes
}
```

Only `sales.*` has explicit subdomain routing. All other subdomains hitting this Railway app get the default routes.

### File → URL Map (VendTech)

| File | Served At | Route |
|------|-----------|-------|
| `usage.html` | vend.kandedash.com/usage | `app.get('/usage', sendFile(__dirname, 'usage.html'))` |
| `analytics.html` | vend.kandedash.com/analytics | Explicit route |
| `pipeline.html` | vend.kandedash.com/pipeline | Explicit route |
| `crm.html` | vend.kandedash.com/crm | Explicit route |
| `call-sheet.html` | vend.kandedash.com/call-sheet | Explicit route |
| Any `.html` in root | vend.kandedash.com/[filename] | `express.static(__dirname)` fallback |

### Key API Endpoints (VendTech)

| Method | Path | Auth | Notes |
|--------|------|------|-------|
| GET | /api/prospects | x-api-key: kande2026 | CRM prospects list |
| PUT | /api/prospects/:id | x-api-key: kande2026 | Update prospect (NOT PATCH) |
| GET | /api/usage/turns | x-api-key: kande2026 | Usage data (2h slots) |
| POST | /api/usage/turns | x-api-key: kande2026 | Push usage data |
| GET | /api/pipeline/engagement-alerts | x-api-key: kande2026 | Pipeline alerts |
| POST | /api/apollo/search | x-api-key: kande2026 | Apollo lead search |

### Database

- **Type:** SQLite (via better-sqlite3)
- **Location:** `data/vendtech.db` (on Railway volume)
- **Key tables:** prospects, activities, machines, pipeline_engagement, teams

---

## Repo 2: Mission Control (`kinghon/kande-mission-control`)

**Local path:** `/tmp/kande-mission-control/` (clone as needed — no persistent local)
**Git remote:** `https://github.com/kinghon/kande-mission-control.git`
**Railway project:** kande-mission-control → production
**Domain:** mc.kandedash.com

### Structure

```
kande-mission-control/
├── server.js          ← Express server
├── public/            ← Static HTML pages
│   ├── index.html     ← MC home
│   ├── tasks.html     ← Kurtis To-Do
│   ├── team.html      ← Team dashboard
│   ├── office.html    ← AI Office
│   ├── calendar.html
│   ├── memory.html
│   ├── content.html
│   └── usage.html     ← API Usage (2h intervals, fetches from VendTech API)
├── ARCHITECTURE.md
└── package.json
```

### File → URL Map (MC)

| File | Served At | Route |
|------|-----------|-------|
| `public/index.html` | mc.kandedash.com/ | `app.get('/')` |
| `public/tasks.html` | mc.kandedash.com/tasks | `app.get('/tasks')` |
| `public/team.html` | mc.kandedash.com/team | `app.get('/team')` |
| `public/office.html` | mc.kandedash.com/office | `app.get('/office')` |
| `public/usage.html` | mc.kandedash.com/usage | `app.get('/usage')` |

### Cross-Origin API Calls

MC pages fetch data from VendTech API (different Railway app):
- `usage.html` → `fetch('https://vend.kandedash.com/api/usage/turns')`
- Other MC pages may call MC's own API endpoints

**If you change an API endpoint on VendTech, check if MC pages depend on it.**

---

## Dual-File Patterns (CRITICAL)

| Pattern | Files | Rule |
|---------|-------|------|
| Usage page | VT: `usage.html` + MC: `public/usage.html` | **Two separate repos.** VT version is authoritative. MC version fetches from VT API. If chart logic changes, update BOTH repos. |

**When updating usage page:**
1. Edit VT's `usage.html` → push to `kande-vendtech-dashboard`
2. Copy/adapt to MC's `public/usage.html` → push to `kande-mission-control`
3. If API format changes, update `extract-usage-turns.py` too

---

## Theme Rules

| App | Theme | Key Colors |
|-----|-------|------------|
| VendTech Dashboard | Light | `#f8f9fa` bg, `#111` text |
| Mission Control | Dark | `#0f0f1a` bg, `#1a1a2e` surface, `#e2e8f0` text |
| Sales Dashboard | Light | Same as VendTech |

**MC pages must use dark theme CSS variables.** If you copy a page from VT to MC, convert the theme.

---

## Deploy Topology

### VendTech
- **Git push → Railway auto-deploys** from `kinghon/kande-vendtech-dashboard` main branch
- Railway project: Vend.Kandedash
- Service: kande-vendtech-dashboard
- CLI: `cd /Users/kurtishon/clawd/kande-vendtech && railway link --project "Vend.Kandedash"`

### Mission Control
- **Git push → Railway auto-deploys** from `kinghon/kande-mission-control` main branch
- Railway project: kande-mission-control
- CLI: Clone `/tmp/kande-mission-control`, edit, push

### Extraction Script
- **Path:** `/Users/kurtishon/clawd/scripts/extract-usage-turns.py`
- **What it does:** Reads OpenClaw session JSONLs → extracts 2h turn counts → pushes to VT API
- **Run after:** Any changes to usage data format

---

## Verification Checklist

After ANY frontend change:
1. `git push` to the **correct repo** (check `git remote -v` first!)
2. Wait 90-120s for Railway deploy
3. `curl -sI https://[domain]/[path] | grep last-modified` — confirm timestamp updated
4. `curl -s https://[domain]/[path] | grep [expected_string]` — confirm content
5. If dual-file pattern: verify BOTH domains
6. Screenshot with browser to confirm real rendering (API ≠ UI)

---

## Common Gotchas

| Gotcha | What Happened | Prevention |
|--------|--------------|------------|
| Wrong git remote | Local repo pointed to `kande-photo-booths-dashboard` instead of `kande-vendtech-dashboard` | Always `git remote -v` before pushing |
| MC ≠ VT | Pushed to VT repo expecting MC to update | Check domain → repo mapping above |
| Railway cache | `last-modified` header stale after push | Wait 2 min, or use `railway up` to force |
| PATCH 404 | VendTech CRM returns 404 on PATCH | Use PUT instead |
| express.static serves everything | Any file in repo root is publicly accessible | Don't put secrets in root |
| `__dirname` confusion | Agents assumed dashboard/ subdirectory | VT repo is FLAT — server.js at root |

---

## Environment Variables (Railway — never in code)

| Var | Purpose | Which App |
|-----|---------|-----------|
| APOLLO_API_KEY | Apollo.io API | VendTech |
| Various DB paths | SQLite locations | VendTech |

---

_Last updated: 2026-02-23 by Jarvis. Discovery: mc.kandedash.com ≠ vend.kandedash.com (different Railway projects, different repos)._
