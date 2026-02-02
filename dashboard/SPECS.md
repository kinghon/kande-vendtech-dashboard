# SPECS.md - User Decisions (Do Not Override)

Sub-agents: Read this file FIRST before making any changes. These are explicit user decisions that must not be changed without approval.

---

## Map Page (`map.html`)

### Legend Status Colors
- 🔥 Hot: `#e53e3e` (red)
- 🟠 Warm: `#dd6b20` (orange)
- 🆕 New: `#3182ce` (blue)
- ✅ Signed: `#38a169` (green)
- ⛔ Stale: `#a0aec0` (gray)
- 📋 Needs Action: `#805ad5` (purple)
- 🟢 In Route: `#22c55e` (bright green with glow)

### Map Features
- NO service radius overlay
- NO revenue tier coloring (removed)
- Markers turn green when added to route

### Map Popup Buttons
- NO "Open in CRM" button
- "Add to Route" button (green #22c55e)
- "Directions" button

---

## CRM Page (`crm.html`)

### Navigation
- NO global nav — sales-facing page, don't expose ops tools

### Mobile Layout
- Badges flush left under prospect name
- Single column for Property Info + Contacts
- Per-field labels on contacts (Name, Role, Phone, Email)

### Desktop Layout
- 3-column grid for Property Info (compact)
- Full-width grid for Contacts with column headers

### Behavior
- Inline expand for notes (no modal popups)
- Auto-save with debounce + "Saved" flash indicator
- "Saved" indicator uses `position: absolute` (no layout shift)

---

## Route Planner (`kanban.html`)

### Navigation
- NO global nav — sales-facing page

### UI
- Route Planner emoji: 🚗 (not 🗺️)

---

## General Rules

1. Don't add global nav to sales-facing pages (CRM, Route Planner, Map)
2. Don't change color schemes without approval
3. Don't add features that expose internal ops to sales team
4. Test the page loads after ANY change before marking done
