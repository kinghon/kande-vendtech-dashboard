# CLAUDE.md - VendTech Dashboard

## Project
- **Stack:** Node.js + Express backend, vanilla HTML/JS/CSS frontend
- **Server:** server.js (10K+ lines) — single file, append-only for new routes/APIs
- **Frontend:** 60+ HTML pages, each self-contained
- **Data:** SQLite via better-sqlite3 at data/vendtech.db
- **Deploy:** Railway from kande-vendtech/dashboard/

## Rules
- **APPEND-ONLY for server.js** — add new routes/APIs at the end, never restructure existing code
- **Don't break existing pages** — test that existing routes still work after changes
- **Commit after each completed fix** — small, atomic commits with clear messages
- **No theme/UI overhauls** — fix bugs and broken links, don't redesign
- **Test your changes** — verify routes return 200, API endpoints return valid JSON
