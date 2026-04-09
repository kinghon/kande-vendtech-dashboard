# ARCHITECTURE.md — Kande Photo Booths

> **Critical reading for any agent touching PB code.** Read this before making ANY change.

---

## Repo Structure

The Photo Booths system spans multiple servers, ALL living in the same git repo:

| Directory | Git Repo | Deploys To | Railway App |
|-----------|----------|-----------|-------------|
| `/Users/kurtishon/clawd/` (root, `src/server.js`) | `kinghon/kande-photo-booths-dashboard` | pb.kandedash.com + info.kandedash.com | Two separate Railway services |
| `/Users/kurtishon/clawd/pb-dashboard-src/` | `kinghon/kande-photo-booths-dashboard` | trends.kandedash.com | 5g0na6ml.up.railway.app |

**The repo root IS the Photo Booths app** — the main server lives at `src/server.js`, public files at `public/`.

**Deploy trigger:** `cd /Users/kurtishon/clawd && git push`

> **⚠️ DUAL DEPLOYMENT GOTCHA:** pb.kandedash.com and info.kandedash.com run the SAME codebase (`src/server.js`) but are TWO separate Railway services. Pushing once updates both, but Railway deploys them independently. The server uses `req.hostname` to restrict which routes are accessible on each domain.

---

## File → URL Map

### Main App (src/server.js + public/)

| File | Served At | Notes |
|------|-----------|-------|
| `public/index.html` | info.kandedash.com/ | Event logistics dashboard (staff-facing) |
| `public/admin.html` | pb.kandedash.com/admin | Operations dashboard — admin, leaderboard, departments, inbox, SEO |
| `public/leaderboard.html` | pb.kandedash.com/leaderboard → redirects to /admin#leaderboard | |
| `public/departments.html` | pb.kandedash.com/departments → redirects to /admin#departments | |
| `public/inbox.html` | pb.kandedash.com/inbox → redirects to /admin#inbox | |
| `public/seo.html` | pb.kandedash.com only | Blocked on info.kandedash.com |
| `public/packer-config.html` | pb.kandedash.com only (admin auth required) | |
| `public/proposal.html` | both domains | Client proposal template |
| `public/sales-sheet.html` | both domains | Sales sheet |
| `public/event-template.html` | both domains | Event template |
| `public/apartment-vending/` | both domains | SEO landing page |
| `public/healthcare-vending/` | both domains | SEO landing page |
| `public/las-vegas-vending-services/` | both domains | SEO landing page |
| `public/smart-vending/` | both domains | SEO landing page |
| Dynamic: `/event/:eventId` | info.kandedash.com/event/:id | Per-event checklist page |

### Trends App (pb-dashboard-src/server.js + pb-dashboard-src/public/)

| File | Served At | Notes |
|------|-----------|-------|
| `pb-dashboard-src/public/index.html` | trends.kandedash.com/ | Trends admin dashboard |
| `pb-dashboard-src/public/trends.html` | trends.kandedash.com/trends | Trends analysis page |
| `pb-dashboard-src/public/trends-share.html` | trends.kandedash.com (any non-/api/trends path) | Public share page — **all non-API paths on trends. subdomain serve this file** |

---

## Deploy Topology

### pb.kandedash.com (Operations Admin)
- **Railway app:** → ryep73dr.up.railway.app
- **Git repo:** `https://github.com/kinghon/kande-photo-booths-dashboard`
- **Deploys from:** repo root, `node src/server.js`
- **Railway deploy trigger:** Configured in Railway dashboard → auto-deploys on push to main
- **Serves:** Admin dashboard, leaderboard, departments, inbox, SEO tools
- **Auth:** `ADMIN_PASSWORD` env var (must pass as Bearer token or `?key=` param for /admin)

### info.kandedash.com (Event Logistics)
- **Railway app:** → ofzbcoh0.up.railway.app
- **Same code as pb.kandedash.com** — same `src/server.js`, deployed as separate Railway service
- **Serves:** Event checklists, packer lists, staff views — no admin pages
- **Auth:** `ADMIN_PASSWORD` or `STAFF_TOKEN` (for staff write operations)

### trends.kandedash.com (PB Trends)
- **Railway app:** → 5g0na6ml.up.railway.app
- **Local path:** `/Users/kurtishon/clawd/pb-dashboard-src/`
- **Entry point:** `node server.js`
- **No railway.toml** — Railway config in dashboard
- **Key behavior:** ANY path on trends. subdomain that isn't `/api/trends` → serves `trends-share.html`

### share.kandedash.com
- **Railway app:** → d2xxkavl.up.railway.app
- **Purpose:** Unknown/separate service; not in main PB codebase

---

## Subdomain Routing (in src/server.js)

Subdomain behavior is enforced via middleware at the top of `src/server.js` (~line 275):

```javascript
if (host === 'pb.kandedash.com') {
  // root / → redirect to /admin
  // event/* and event APIs → 404 (they're at info.kandedash.com)
}
if (host === 'info.kandedash.com') {
  // /admin, /leaderboard, /departments, /inbox, /seo.html → 404
  // admin-only APIs → 404
}
```

**Result:**
- **pb.kandedash.com** — admin/ops only, event pages blocked
- **info.kandedash.com** — event logistics only, admin pages blocked

---

## Dual-File Patterns

No strict dual-file situation like VendTech, BUT:

| pb.kandedash.com | info.kandedash.com | Notes |
|------------------|--------------------|-------|
| `public/admin.html` | `public/index.html` | Different pages, same server; admin ≠ events |

If you change the server routing logic for one subdomain, double-check the other. They share ALL routes — blocked ones just return 404.

---

## API Authentication

**Admin operations:**
```
Authorization: Bearer <ADMIN_PASSWORD>
```
or for /admin page:
```
GET /admin?key=<ADMIN_PASSWORD>
```

**Staff operations (checklists, event updates):**
```
Authorization: Bearer <STAFF_TOKEN>
```
or cookie:
```
Cookie: staff_auth=<STAFF_TOKEN>
```

**Internal cron/bot (no auth for some routes):**
Some routes accept a secret header — check server.js ~line 1732 for the pattern.

---

## API Endpoints (grouped by domain)

### info.kandedash.com — Event Logistics

**Events**
- `GET /api/events` — list all events (admin sees all; staff sees filtered)
- `GET /api/past-events` — historical events
- `POST /api/refresh` — force VSCO data refresh (admin)
- `GET /event/:eventId` — serves HTML event checklist page

**Checklists**
- `GET /api/checklist/:eventId` — full checklist for event
- `POST /api/checklist/:eventId/:type/submit` — submit checklist (auth required)
- `POST /api/checklist/:eventId/:type/reset` — reset checklist (admin)
- `POST /api/checklist/:eventId/:type/:itemId` — update checklist item (auth)
- `POST /api/checklist/:eventId/notes/:type` — save notes (auth)
- `POST /api/checklist/:eventId/subcontractor` — set subcontractor (auth)
- `POST /api/checklist/:eventId/backdrop` — set backdrop info (auth)
- `POST /api/checklist/:eventId/backdrop-image` — upload backdrop photo (auth, 50mb)
- `DELETE /api/checklist/:eventId/backdrop-image` — remove photo (auth)
- `POST /api/checklist/:eventId/packer-notes-photos` — packer photos (auth, 50mb)
- `DELETE /api/checklist/:eventId/packer-notes-photos/:index` — remove photo (auth)
- `POST /api/checklist/:eventId/hidden-services` — update hidden services (auth)
- `POST /api/checklist/:eventId/kurtis-notes` — Kurtis private notes (auth)
- `POST /api/checklist/:eventId/custom-item` — add custom packer item (auth)
- `DELETE /api/checklist/:eventId/custom-item/:itemId` — remove custom item (auth)
- `DELETE /api/checklist/:eventId/packer-item/:itemId` — remove any packer item (auth)
- `PUT /api/checklist/:eventId/packer-item/:itemId` — edit packer item (auth)
- `POST /api/checklist/:eventId/regenerate-packer` — regenerate packer list (auth)

**Staff**
- `GET /api/staff` — list staff members
- `GET /api/staff-list/:type` — staff list by type

**Packer Config**
- `GET /api/packer-config` — packer configuration (admin)
- `POST /api/packer-config` — save packer config (admin)

**Health**
- `GET /api/health` — returns `{status:'ok'}`

### pb.kandedash.com — Operations Admin

All events/checklist endpoints above PLUS:

**Admin Dashboard**
- `GET /admin` — serves admin.html (requires `?key=ADMIN_PASSWORD` or auth header)
- `GET /leaderboard` → redirects to `/admin?key=...#leaderboard`
- `GET /departments` → redirects to `/admin?key=...#departments`
- `GET /inbox` → redirects to `/admin?key=...#inbox`

**Leaderboard / Scoring**
- `GET /api/leaderboard` — bot performance scores
- `POST /api/leaderboard/score` — submit score

**Departments**
- `GET /api/departments` — all department states
- `POST /api/departments/:team/update` — update department
- `GET /api/pb-departments` — pb-specific department view
- `POST /api/pb-departments/:dept/checkin`
- `POST /api/pb-departments/:dept/checkout`
- `POST /api/pb-departments/:dept/tasks`
- `PUT /api/pb-departments/:dept/tasks/:id`
- `POST /api/pb-departments/cleanup` — cleanup stale data

**Inbox**
- `GET /api/inbox` — email inbox (admin, from PostgreSQL)
- `GET /api/inbox/:id` — single email
- `POST /api/inbox/:id/send` — send reply (auth)

**SEO**
- `GET /api/seo` — SEO data (admin)
- `POST /api/seo/check` — trigger SEO check

### trends.kandedash.com (separate server)

- `GET /api/trends` — get trends data
- `GET /trends` → serves trends.html
- `GET /trends/share` → serves trends-share.html
- All other paths → serves trends-share.html (public share page)

---

## Theme Rules

- **info.kandedash.com (index.html):** Dark/event theme — event logistics UI
- **pb.kandedash.com (admin.html):** Operations dashboard theme
- **trends.kandedash.com:** Trends-specific theme

No global theme variable — each page has its own CSS.

---

## Database

### PostgreSQL (primary for inbox, events)
- **Env var:** `DATABASE_URL` (Railway PostgreSQL plugin)
- **Tables:**
  - `inbox_emails` — email inbox (id TEXT PK, data JSONB, created_at, updated_at)
  - `inbox_meta` — metadata (key TEXT PK, value TEXT)
- **Fallback:** If no `DATABASE_URL`, uses `data/data.json` file

### VSCO (External data source)
- **Module:** `src/vsco.js`
- **Functions:** `getDashboardData()`, `getPastDashboardData()`
- Auto-refreshes every 5 minutes
- Events data comes from VSCO workspace, enhanced with saved notes from PostgreSQL

### File storage
- `data/data.json` — fallback when no PostgreSQL
- `data/inbox-backup.json` — inbox backup for DB migration

---

## Environment Variables

Set in Railway dashboard, NOT in code:

| Var | Railway Service | Purpose |
|-----|----------------|---------|
| `ADMIN_PASSWORD` | pb + info | Admin auth token |
| `STAFF_TOKEN` | pb + info | Staff write auth (falls back to ADMIN_PASSWORD) |
| `DATABASE_URL` | pb + info | PostgreSQL connection string |
| `EMAIL_USER` | pb + info | Outbound email account |
| `EMAIL_PASS` | pb + info | Outbound email password |
| `ALLOWED_ORIGINS` | pb + info | CORS allowed origins (comma-separated) |
| `GOG_ACCOUNT` | pb | Gmail account for gog tool |
| `GOG_KEYRING_PASSWORD` | pb | Keyring password for gog |
| `PORT` | auto-set | Listen port |
| `ADMIN_TOKEN` | trends | Trends admin token (default: kpb-ops-2026) |
| `DATA_PATH` | trends | Trends data file path |

---

## Verification Checklist

After ANY change:

1. `cd /Users/kurtishon/clawd && git push`
2. Wait 60-90s for Railway auto-deploy (BOTH pb and info deploy from same push)
3. `/usr/bin/curl -s https://pb.kandedash.com/api/health` → `{"status":"ok"}`
4. `/usr/bin/curl -s https://info.kandedash.com/api/health` → `{"status":"ok"}`
5. If changing a page served at both domains, verify on BOTH URLs
6. If changing admin-only routes, confirm they 404 on info.kandedash.com

---

## Common Gotchas

1. **Same server, TWO Railway services** — one push deploys both (but Railway deploys them sequentially). If one fails, the other may still deploy.
2. **Hostname routing is middleware** — it runs before `express.static`. A blocked route returns 404 even if the file exists on disk.
3. **VSCO is external** — if VSCO API is down, events page will show cached data or error. Refresh via `POST /api/refresh`.
4. **Admin password required for /admin** — pass as `?key=` query param in browser, or `Authorization: Bearer` for API.
5. **Inbox uses PostgreSQL** — if `DATABASE_URL` not set, inbox won't persist. Check Railway env vars.
6. **trends. subdomain catches ALL paths** — even 404s redirect to trends-share.html (intentional public share behavior).
7. **Leaderboard/departments/inbox pages redirect** — they go to `/admin#section`, not standalone pages.
