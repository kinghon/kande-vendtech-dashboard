# Kande VendTech — Lead-to-Client Lifecycle System
## Master Architecture Specification

> **Version:** 2.0 (Skool-Enhanced)  
> **Date:** 2025-07-14  
> **Author:** FORGE (Systems Architect)  
> **Stack:** Node.js/Express, SQLite→PostgreSQL, HTML/CSS/JS, Railway  
> **Business:** Smart vending (SandStar AI coolers) — Las Vegas / Henderson, NV  
> **Intelligence Source:** Vendingpreneurs Skool community (8,087 posts) — see `research/skool-insights.md`

### ⚠️ CRITICAL BUSINESS RULES (from Skool community — MEMORIZE THESE)
>
> 1. **NEVER say "vending"** — We sell "AI-powered smart markets" and "premium amenities"
> 2. **8-10 touches to close** — Build the full sequence into automation. No lead closes on touch 1.
> 3. **Pop-ins are 90% of placements** — In-person visits are THE channel. Email/calls are warmup only.
> 4. **Gift basket strategy** — Every pop-in includes product samples + business card. Budget this.
> 5. **$2K/month minimum** — If a location can't hit $2K/mo revenue, don't place a machine there.
> 6. **Rev share 3-5% of gross** — Offer this proactively to lock out competitors.
> 7. **"Introduce me to 3 buildings"** — Referral ask is part of every closed deal.
> 8. **Greystar = NetVendor** — Greystar properties require NetVendor certification. Track this.
> 9. **Route efficiency is the #1 scaling bottleneck** — Optimize or die.
> 10. **10-15 machines in great spots = $200K/year** — Quality over quantity. Always.

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Database Architecture](#2-database-architecture)
3. [User Roles & Permissions](#3-user-roles--permissions)
4. [Stage 1: Prospecting](#4-stage-1-prospecting--lead-discovery)
5. [Stage 2: Outreach](#5-stage-2-outreach--first-contact)
6. [Stage 3: Qualification](#6-stage-3-qualification--site-survey)
7. [Stage 4: Proposal](#7-stage-4-proposal--close-the-deal)
8. [Stage 5: Onboarding](#8-stage-5-onboarding--machine-install)
9. [Stage 6: Operations](#9-stage-6-operations--day-to-day)
10. [Stage 7: Client Management](#10-stage-7-client-management--retention)
11. [Stage 8: Financial](#11-stage-8-financial--money)
12. [Dashboard Navigation & Page Map](#12-dashboard-navigation--page-map)
13. [Notification System](#13-notification-system)
14. [Mobile Interfaces](#14-mobile-interfaces-driver--packer)
15. [Reporting & Analytics](#15-reporting--analytics)
16. [Automation Engine](#16-automation-engine)
17. [Integration Map](#17-integration-map)
18. [Migration & Implementation Plan](#18-migration--implementation-plan)

---

## 1. System Overview

### 1.1 The Pipeline

```
PROSPECT → OUTREACH → QUALIFY → PROPOSE → ONBOARD → OPERATE → MANAGE → PROFIT
   │          │          │          │          │          │          │         │
   │          │          │          │          │          │          │         │
 Apollo    Instantly   Site      Proposal   Install    Routes    Client    Revenue
 Manual    Cold Call   Survey    Contract   Config     Restock   Portal    Costs
 Referral  Pop-in     Score     E-Sign     Stock      Pack      Reports   Margins
```

### 1.2 Lead Status Flow

```
NEW_LEAD → CONTACTED → INTERESTED → MEETING_SCHEDULED → QUALIFIED → PROPOSAL_SENT
    │           │           │              │                  │             │
    │           │           │              │                  │             ├→ NEGOTIATING → WON → ONBOARDING → ACTIVE
    │           │           │              │                  │             │                        │
    └→ DEAD     └→ DEAD     └→ DEAD        └→ DEAD           └→ NOT_QUALIFIED  └→ LOST              └→ AT_RISK → CHURNED
```

### 1.3 Design Principles

- **Append-only server.js** — all routes added to existing Express server
- **Progressive enhancement** — each stage works independently; connections between stages are bonuses
- **Mobile-first for field work** — driver/packer/survey interfaces are phone-optimized
- **Desktop-first for management** — admin dashboards, analytics, proposals
- **Railway deployment** — single service, environment variables for secrets
- **SQLite for development, PostgreSQL for production** — Knex.js query builder for portability

---

## 2. Database Architecture

### 2.1 Core Tables

#### `leads`
The central record. Every prospect starts here.

```sql
CREATE TABLE leads (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Identity
  company_name    TEXT NOT NULL,
  dba_name        TEXT,                          -- "doing business as" if different
  contact_name    TEXT,
  contact_title   TEXT,
  contact_email   TEXT,
  contact_phone   TEXT,
  website         TEXT,
  
  -- Location
  address         TEXT,
  city            TEXT DEFAULT 'Las Vegas',
  state           TEXT DEFAULT 'NV',
  zip             TEXT,
  lat             REAL,
  lng             REAL,
  
  -- Classification
  property_type   TEXT,                          -- office, apartment, medical, gym, hotel, retail, warehouse, etc.
  building_class  TEXT,                          -- A, B, C
  total_sqft      INTEGER,
  employee_count  INTEGER,                       -- or resident count, patient count, etc.
  foot_traffic    TEXT,                          -- low, medium, high, very_high
  
  -- Qualification Data (Skool: "qualify ruthlessly")
  shift_breakdown TEXT,                          -- JSON: {day: 200, swing: 80, night: 40} — employee/resident shifts
  daily_attendance INTEGER,                      -- actual daily people present (not total employees)
  existing_snack_options TEXT,                   -- what do they have now? cafeteria, micro-market, nothing, old vending
  
  -- Property Management (Skool: Greystar/Holland require vendor approval)
  management_company    TEXT,                    -- Greystar, Holland, Camden, etc.
  vendor_approval_status TEXT,                   -- not_required, pending, approved, rejected
  vendor_approval_platform TEXT,                 -- netvendor, direct, other
  vendor_approval_notes TEXT,                    -- "Applied to NetVendor 2/15, waiting on review"
  
  -- Pipeline
  status          TEXT DEFAULT 'new_lead',       -- see Status Flow above
  stage           TEXT DEFAULT 'prospecting',    -- prospecting, outreach, qualification, proposal, onboarding, active, churned
  priority        TEXT DEFAULT 'medium',         -- low, medium, high, urgent
  score           INTEGER DEFAULT 0,             -- 0-100, computed from survey + data
  
  -- Source
  source          TEXT,                          -- apollo, manual, referral, walk_in, website, event, pop_in
  source_detail   TEXT,                          -- Apollo list name, referrer name, event name
  apollo_id       TEXT,                          -- Apollo.io org ID if imported
  
  -- Referral Tracking (Skool: "Introduce me to 3 other buildings")
  referred_by_lead_id  INTEGER REFERENCES leads(id),  -- which client referred this lead
  referral_count       INTEGER DEFAULT 0,              -- how many referrals THIS lead has given us
  referral_ask_made    BOOLEAN DEFAULT FALSE,          -- have we asked for referrals yet?
  referral_ask_date    DATETIME,
  
  -- Assignment
  assigned_to     INTEGER REFERENCES users(id),
  
  -- Revenue Potential (Skool: $2K/month minimum threshold)
  estimated_machines   INTEGER DEFAULT 1,
  estimated_monthly_rev REAL,
  meets_2k_threshold   BOOLEAN,                  -- computed: does this location clear $2K/mo?
  
  -- Timestamps
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_contact_at DATETIME,
  next_followup   DATETIME,
  
  -- Soft delete
  archived        BOOLEAN DEFAULT FALSE
);

CREATE INDEX idx_leads_status ON leads(status);
CREATE INDEX idx_leads_stage ON leads(stage);
CREATE INDEX idx_leads_city ON leads(city);
CREATE INDEX idx_leads_property_type ON leads(property_type);
CREATE INDEX idx_leads_assigned ON leads(assigned_to);
```

#### `lead_contacts`
Multiple contacts per lead (property manager, building manager, office manager, etc.)

```sql
CREATE TABLE lead_contacts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id     INTEGER NOT NULL REFERENCES leads(id),
  name        TEXT NOT NULL,
  title       TEXT,
  email       TEXT,
  phone       TEXT,
  is_primary  BOOLEAN DEFAULT FALSE,
  is_decision_maker BOOLEAN DEFAULT FALSE,
  notes       TEXT,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

#### `activities`
Every touchpoint logged. The audit trail for the entire relationship.

```sql
CREATE TABLE activities (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id       INTEGER NOT NULL REFERENCES leads(id),
  user_id       INTEGER REFERENCES users(id),
  
  activity_type TEXT NOT NULL,                   -- email_sent, email_received, call_outbound, call_inbound, 
                                                 -- meeting, pop_in, gift_basket_drop, note, status_change,
                                                 -- survey_completed, proposal_sent, contract_signed,
                                                 -- machine_installed, referral_ask, referral_received
  subject       TEXT,
  body          TEXT,
  
  -- Outreach Sequence Tracking (Skool: 8-10 touches to close)
  sequence_step INTEGER,                         -- which touch # is this? (1-10+)
  sequence_id   TEXT,                            -- which outreach sequence template
  
  -- For calls
  call_duration INTEGER,                         -- seconds
  call_outcome  TEXT,                            -- connected, voicemail, no_answer, wrong_number, gatekeeper
  
  -- For emails
  email_campaign_id TEXT,                        -- Instantly campaign ID
  email_status      TEXT,                        -- sent, opened, replied, bounced
  
  -- For pop-ins (Skool: "90% of placements come from in-person visits")
  pop_in_outcome    TEXT,                        -- spoke_to_dm, left_materials, spoke_to_gatekeeper, building_closed
  gift_basket_left  BOOLEAN DEFAULT FALSE,       -- Skool: gift basket strategy
  materials_left    TEXT,                        -- JSON: ["business_card", "brochure", "product_samples", "gift_basket"]
  met_decision_maker BOOLEAN DEFAULT FALSE,
  dm_name_learned   TEXT,                        -- got the decision maker's name for next visit
  
  -- For referral tracking
  referral_leads_received TEXT,                  -- JSON: [lead_ids] from this referral activity
  
  -- Metadata
  metadata      TEXT,                            -- JSON blob for flexible data
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_activities_lead ON activities(lead_id);
CREATE INDEX idx_activities_type ON activities(activity_type);
CREATE INDEX idx_activities_date ON activities(created_at);
```

#### `users`
Everyone who touches the system.

```sql
CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  email         TEXT UNIQUE NOT NULL,
  phone         TEXT,
  role          TEXT NOT NULL,                   -- admin, sales, driver, packer, client
  password_hash TEXT,
  is_active     BOOLEAN DEFAULT TRUE,
  permissions   TEXT,                            -- JSON array of specific permissions
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### 2.2 Survey & Qualification Tables

#### `site_surveys`
Completed site survey for a qualified lead.

```sql
CREATE TABLE site_surveys (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id         INTEGER NOT NULL REFERENCES leads(id),
  surveyor_id     INTEGER REFERENCES users(id),
  survey_date     DATETIME DEFAULT CURRENT_TIMESTAMP,
  
  -- Location Details
  placement_area  TEXT,                          -- lobby, break_room, hallway, gym, pool_area, common_area
  floor_number    INTEGER,
  area_dimensions TEXT,                          -- "8ft x 6ft"
  
  -- Infrastructure
  power_available     BOOLEAN,
  power_outlet_type   TEXT,                      -- standard_110v, dedicated_circuit, needs_install
  power_distance_ft   INTEGER,                   -- distance from outlet to proposed machine location
  wifi_available      BOOLEAN,
  wifi_signal_strength TEXT,                     -- strong, medium, weak, none
  wifi_network_name   TEXT,
  ethernet_available  BOOLEAN,
  
  -- Environment
  indoor_outdoor      TEXT DEFAULT 'indoor',     -- indoor, outdoor, covered_outdoor
  climate_controlled  BOOLEAN DEFAULT TRUE,
  ambient_temp_range  TEXT,                      -- "68-76F"
  direct_sunlight     BOOLEAN DEFAULT FALSE,
  
  -- Foot Traffic Assessment
  daily_foot_traffic  INTEGER,                   -- estimated people per day passing location
  peak_hours          TEXT,                      -- "7am-9am, 11am-1pm, 5pm-7pm"
  traffic_source      TEXT,                      -- employees, residents, patients, visitors, public
  
  -- Revenue Qualification (Skool: "$2K/month minimum" + "qualify ruthlessly")
  employee_count          INTEGER,               -- total employees/residents at location
  shift_breakdown         TEXT,                  -- JSON: {day: X, swing: X, night: X}
  daily_attendance        INTEGER,               -- actual daily people on-site
  existing_food_options   TEXT,                   -- cafeteria, micro_market, old_vending, food_trucks, nothing
  nearest_convenience_store TEXT,                 -- "7-Eleven 0.3 miles" — affects demand
  estimated_monthly_rev   REAL,                  -- calculated: attendance × avg_spend × 30
  meets_2k_threshold      BOOLEAN,               -- auto-calculated: estimated_monthly_rev >= 2000
  
  -- Competition
  existing_vending    BOOLEAN DEFAULT FALSE,
  existing_vendor     TEXT,                       -- Canteen, Aramark, local operator, etc.
  existing_machine_count INTEGER DEFAULT 0,
  competitor_issues   TEXT,                       -- why they're looking to switch (Skool: "taking over Canteen locations")
  competitor_contract_end DATE,                   -- when does their current contract expire?
  
  -- Access
  delivery_access     TEXT,                      -- front_door, loading_dock, freight_elevator, stairs_only
  parking_available   BOOLEAN,
  access_restrictions TEXT,                      -- "key card after 6pm", "loading dock M-F 8-5 only"
  
  -- Photos (stored as JSON array of URLs/paths)
  photos              TEXT,                      -- JSON: [{url, caption, type}]
  
  -- Vendor Approval (Skool: Greystar = NetVendor, Holland = direct)
  requires_vendor_approval BOOLEAN DEFAULT FALSE,
  vendor_platform          TEXT,                 -- netvendor, direct_application, none
  management_company       TEXT,                 -- Greystar, Holland, Camden, etc.
  approval_status          TEXT,                 -- not_started, applied, pending, approved, rejected
  approval_notes           TEXT,
  
  -- Security / Theft Risk (Skool: theft/vandalism tracking needed)
  security_cameras    BOOLEAN DEFAULT FALSE,
  security_guard      BOOLEAN DEFAULT FALSE,
  area_visibility     TEXT,                      -- high, medium, low (can staff see the machine?)
  theft_risk_assessment TEXT,                    -- low, medium, high
  vandalism_concerns  TEXT,
  
  -- Scoring (auto-calculated)
  location_score      INTEGER,                   -- 0-100, computed
  score_breakdown     TEXT,                      -- JSON: {traffic: 25, revenue_potential: 20, ...}
  
  -- Recommendation
  recommended_machines  INTEGER DEFAULT 1,
  recommended_types     TEXT,                    -- JSON: ["cooler_40", "cooler_60"]
  recommended_placement TEXT,
  surveyor_notes        TEXT,
  
  -- Status
  status              TEXT DEFAULT 'draft',      -- draft, completed, approved, rejected
  approved_by         INTEGER REFERENCES users(id),
  approved_at         DATETIME,
  
  created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### 2.3 Proposal & Contract Tables

#### `proposals`

```sql
CREATE TABLE proposals (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id           INTEGER NOT NULL REFERENCES leads(id),
  survey_id         INTEGER REFERENCES site_surveys(id),
  
  -- Proposal Content
  proposal_number   TEXT UNIQUE,                 -- KVT-2025-0001
  version           INTEGER DEFAULT 1,
  
  -- Terms (Skool: offer 3-5% rev share to lock out competition)
  revenue_share_pct     REAL,                    -- client's percentage (3-5% typical, max 10% for premium)
  minimum_monthly       REAL,                    -- minimum monthly payment to client, if any
  contract_length_months INTEGER DEFAULT 12,
  auto_renew            BOOLEAN DEFAULT TRUE,
  
  -- Machine Config
  machine_count         INTEGER DEFAULT 1,
  machine_types         TEXT,                    -- JSON: [{type, quantity}]
  estimated_monthly_rev REAL,                    -- projected per-machine revenue
  
  -- What Kande Provides
  includes_machine      BOOLEAN DEFAULT TRUE,
  includes_installation BOOLEAN DEFAULT TRUE,
  includes_stocking     BOOLEAN DEFAULT TRUE,
  includes_maintenance  BOOLEAN DEFAULT TRUE,
  includes_wifi_hardware BOOLEAN DEFAULT FALSE,
  
  -- Document
  pdf_url               TEXT,                    -- generated PDF path
  template_used         TEXT,                    -- which template version
  custom_terms          TEXT,                    -- any special negotiated terms
  
  -- Status
  status                TEXT DEFAULT 'draft',    -- draft, sent, viewed, negotiating, accepted, rejected, expired
  sent_at               DATETIME,
  viewed_at             DATETIME,
  responded_at          DATETIME,
  
  -- E-signature
  esign_provider        TEXT,                    -- docusign, hellosign, pandadoc
  esign_document_id     TEXT,
  esign_status          TEXT,                    -- pending, signed, declined
  signed_at             DATETIME,
  
  created_at            DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at            DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

#### `contracts`

```sql
CREATE TABLE contracts (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id           INTEGER NOT NULL REFERENCES leads(id),
  proposal_id       INTEGER REFERENCES proposals(id),
  
  contract_number   TEXT UNIQUE,                 -- KVT-C-2025-0001
  
  -- Terms (copied from accepted proposal, may differ after negotiation)
  revenue_share_pct     REAL,
  minimum_monthly       REAL,
  contract_length_months INTEGER,
  start_date            DATE,
  end_date              DATE,
  auto_renew            BOOLEAN DEFAULT TRUE,
  renewal_notice_days   INTEGER DEFAULT 30,
  
  -- Documents
  signed_pdf_url        TEXT,
  
  -- Status
  status                TEXT DEFAULT 'active',   -- active, expired, terminated, renewed
  terminated_at         DATETIME,
  termination_reason    TEXT,
  renewed_from_id       INTEGER REFERENCES contracts(id),
  
  created_at            DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at            DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### 2.4 Fleet & Machine Tables

#### `machines`
Every physical machine in inventory.

```sql
CREATE TABLE machines (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  
  -- Identity
  serial_number     TEXT UNIQUE NOT NULL,
  asset_tag         TEXT UNIQUE,                 -- KVT-M-001
  machine_type      TEXT NOT NULL,               -- sandstar_cooler_40, sandstar_cooler_60
  model             TEXT,
  manufacturer      TEXT DEFAULT 'SandStar',
  
  -- Status
  status            TEXT DEFAULT 'in_warehouse', -- in_warehouse, assigned, in_transit, installed, maintenance, decommissioned
  condition         TEXT DEFAULT 'new',          -- new, good, fair, needs_repair
  
  -- Assignment
  location_id       INTEGER REFERENCES locations(id),
  assigned_lead_id  INTEGER REFERENCES leads(id),
  
  -- Configuration
  planogram_id      INTEGER REFERENCES planograms(id),
  slot_count        INTEGER,                     -- number of product slots
  current_config    TEXT,                        -- JSON: current planogram mapping
  
  -- Connectivity
  sim_iccid         TEXT,                        -- SIM card ID if cellular
  wifi_configured   BOOLEAN DEFAULT FALSE,
  sandstar_device_id TEXT,                       -- SandStar cloud device identifier
  last_ping         DATETIME,
  online            BOOLEAN DEFAULT FALSE,
  
  -- Maintenance
  last_maintenance  DATETIME,
  next_maintenance  DATETIME,
  maintenance_notes TEXT,
  
  -- Purchase Info
  purchase_date     DATE,
  purchase_price    REAL,
  warranty_expires  DATE,
  
  created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_machines_status ON machines(status);
CREATE INDEX idx_machines_location ON machines(location_id);
```

#### `locations`
Physical locations where machines are installed. Created from lead + survey data upon contract signing.

```sql
CREATE TABLE locations (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id           INTEGER NOT NULL REFERENCES leads(id),
  contract_id       INTEGER REFERENCES contracts(id),
  
  -- Address
  name              TEXT NOT NULL,               -- "Hughes Center - Building A Lobby"
  address           TEXT NOT NULL,
  city              TEXT DEFAULT 'Las Vegas',
  state             TEXT DEFAULT 'NV',
  zip               TEXT,
  lat               REAL,
  lng               REAL,
  
  -- Routing
  route_id          INTEGER REFERENCES routes(id),
  route_position    INTEGER,                     -- stop order within route
  service_zone      TEXT,                        -- geographic zone: north_lv, south_lv, henderson, strip, downtown
  
  -- Access
  access_hours      TEXT,                        -- JSON: {mon: "8am-6pm", tue: "8am-6pm", ...}
  access_notes      TEXT,                        -- "Key card at front desk, ask for Jim"
  delivery_notes    TEXT,                        -- "Use loading dock on east side"
  
  -- Contact (on-site)
  onsite_contact    TEXT,
  onsite_phone      TEXT,
  onsite_email      TEXT,
  
  -- Machine count
  machine_count     INTEGER DEFAULT 0,
  
  -- Performance
  avg_daily_revenue REAL DEFAULT 0,
  avg_weekly_revenue REAL DEFAULT 0,
  last_service_date DATETIME,
  next_service_date DATETIME,
  
  -- Status
  status            TEXT DEFAULT 'pending',      -- pending, active, paused, terminated
  activated_at      DATETIME,
  
  created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_locations_route ON locations(route_id);
CREATE INDEX idx_locations_zone ON locations(service_zone);
CREATE INDEX idx_locations_status ON locations(status);
```

### 2.5 Product & Inventory Tables

#### `products`

```sql
CREATE TABLE products (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  
  -- Identity
  sku               TEXT UNIQUE NOT NULL,
  upc               TEXT,
  name              TEXT NOT NULL,
  brand             TEXT,
  category          TEXT NOT NULL,               -- beverage, snack, candy, energy, water, healthy, other
  subcategory       TEXT,                        -- cola, juice, chips, protein_bar, etc.
  
  -- Pricing
  cost_price        REAL NOT NULL,               -- what we pay (wholesale)
  retail_price      REAL NOT NULL,               -- what we charge in machine
  margin_pct        REAL GENERATED ALWAYS AS ((retail_price - cost_price) / retail_price * 100) STORED,
  
  -- Physical
  size              TEXT,                        -- "20oz", "1.5oz", "12oz can"
  slot_size         TEXT DEFAULT 'standard',     -- standard, wide, tall, double
  weight_oz         REAL,
  
  -- Vendor
  supplier          TEXT,                        -- Costco, Sam's Club, McLane, Vistar
  supplier_sku      TEXT,
  case_count        INTEGER,                     -- units per case
  case_cost         REAL,                        -- cost per case
  
  -- Media
  image_url         TEXT,
  
  -- Status
  is_active         BOOLEAN DEFAULT TRUE,
  is_seasonal       BOOLEAN DEFAULT FALSE,
  
  created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_products_category ON products(category);
CREATE INDEX idx_products_sku ON products(sku);
```

#### `inventory`
Warehouse stock levels.

```sql
CREATE TABLE inventory (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id        INTEGER NOT NULL REFERENCES products(id),
  
  -- Stock
  quantity_on_hand  INTEGER DEFAULT 0,
  quantity_reserved INTEGER DEFAULT 0,           -- reserved for tomorrow's routes
  quantity_available INTEGER GENERATED ALWAYS AS (quantity_on_hand - quantity_reserved) STORED,
  
  -- Reorder
  reorder_point     INTEGER DEFAULT 24,          -- alert when stock hits this
  reorder_quantity  INTEGER DEFAULT 48,          -- how many to order
  par_level         INTEGER DEFAULT 72,          -- ideal stock level
  
  -- Tracking
  last_counted      DATETIME,
  last_received     DATETIME,
  last_depleted     DATETIME,                   -- last time stock hit 0
  
  -- Location in warehouse
  warehouse_zone    TEXT,                        -- A, B, C (for pick optimization)
  shelf_location    TEXT,                        -- A1-3, B2-1
  
  updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_inventory_product ON inventory(product_id);
CREATE INDEX idx_inventory_low ON inventory(quantity_on_hand) WHERE quantity_on_hand <= reorder_point;
```

#### `inventory_transactions`
Every stock movement.

```sql
CREATE TABLE inventory_transactions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id      INTEGER NOT NULL REFERENCES products(id),
  
  transaction_type TEXT NOT NULL,                -- received, picked, returned, adjusted, spoiled, expired
  quantity         INTEGER NOT NULL,             -- positive = in, negative = out
  
  -- Context
  reference_type   TEXT,                         -- purchase_order, pick_list, adjustment, restock_job
  reference_id     INTEGER,
  
  user_id          INTEGER REFERENCES users(id),
  notes            TEXT,
  
  created_at       DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

#### `planograms`
Product layout templates for machines.

```sql
CREATE TABLE planograms (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  name              TEXT NOT NULL,               -- "Office Standard", "Gym Healthy", "Hotel Premium"
  machine_type      TEXT NOT NULL,               -- which machine model this fits
  location_type     TEXT,                        -- office, gym, hotel, apartment, etc.
  
  -- Layout
  layout            TEXT NOT NULL,               -- JSON: [{slot: 1, product_id: 5, par_level: 8, facing: 1}, ...]
  total_slots       INTEGER,
  total_capacity    INTEGER,                     -- total units when fully stocked
  
  -- Performance
  estimated_daily_rev REAL,
  
  -- Status
  is_active         BOOLEAN DEFAULT TRUE,
  is_default        BOOLEAN DEFAULT FALSE,       -- default for this location type
  
  created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### 2.6 Operations Tables

#### `routes`

```sql
CREATE TABLE routes (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  name              TEXT NOT NULL,               -- "Henderson Loop", "Strip North", "Southwest"
  
  -- Zone
  service_zone      TEXT,                        -- geographic zone
  
  -- Schedule
  frequency         TEXT DEFAULT 'weekly',       -- daily, mon_wed_fri, tue_thu, weekly, biweekly, custom
  scheduled_days    TEXT,                        -- JSON: [1,3,5] for M/W/F
  
  -- Assignment
  driver_id         INTEGER REFERENCES users(id),
  vehicle_id        INTEGER REFERENCES vehicles(id),
  
  -- Metrics
  location_count    INTEGER DEFAULT 0,
  estimated_duration_min INTEGER,                -- total route time estimate
  estimated_miles   REAL,
  
  -- Optimization
  optimized_order   TEXT,                        -- JSON: ordered list of location_ids
  last_optimized    DATETIME,
  
  is_active         BOOLEAN DEFAULT TRUE,
  created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

#### `route_runs`
Each actual execution of a route.

```sql
CREATE TABLE route_runs (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  route_id          INTEGER NOT NULL REFERENCES routes(id),
  driver_id         INTEGER NOT NULL REFERENCES users(id),
  
  scheduled_date    DATE NOT NULL,
  
  -- Timing
  started_at        DATETIME,
  completed_at      DATETIME,
  
  -- Results
  stops_completed   INTEGER DEFAULT 0,
  stops_total       INTEGER,
  total_units_stocked INTEGER DEFAULT 0,
  total_revenue_collected REAL DEFAULT 0,        -- if collecting cash
  
  -- Status
  status            TEXT DEFAULT 'scheduled',    -- scheduled, in_progress, completed, cancelled, partial
  notes             TEXT,
  
  -- Mileage
  start_mileage     REAL,
  end_mileage       REAL,
  
  created_at        DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

#### `route_stops`
Individual stops within a route run.

```sql
CREATE TABLE route_stops (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  route_run_id      INTEGER NOT NULL REFERENCES route_runs(id),
  location_id       INTEGER NOT NULL REFERENCES locations(id),
  machine_id        INTEGER REFERENCES machines(id),
  stop_order        INTEGER NOT NULL,
  
  -- Timing
  arrived_at        DATETIME,
  departed_at       DATETIME,
  
  -- Restocking
  products_stocked  TEXT,                        -- JSON: [{product_id, qty_added, slot}]
  products_removed  TEXT,                        -- JSON: expired/damaged items removed
  total_units_added INTEGER DEFAULT 0,
  
  -- Machine Status
  machine_status    TEXT,                        -- ok, needs_repair, error_cleared, offline
  issues_found      TEXT,                        -- JSON: [{type, description, photo_url}]
  
  -- Photos
  photos            TEXT,                        -- JSON: [{url, type}] — before/after
  
  -- Status
  status            TEXT DEFAULT 'pending',      -- pending, arrived, completed, skipped
  skip_reason       TEXT,                        -- closed, no_access, no_stock, etc.
  
  driver_notes      TEXT,
  
  created_at        DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

#### `pick_lists`
Packer's work orders — what to pack for tomorrow's routes.

```sql
CREATE TABLE pick_lists (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  route_run_id      INTEGER REFERENCES route_runs(id),
  
  packer_id         INTEGER REFERENCES users(id),
  pack_date         DATE NOT NULL,               -- date to pack (day before route)
  
  -- Items
  items             TEXT NOT NULL,               -- JSON: [{product_id, quantity, location_id, machine_id}]
  total_items       INTEGER,
  total_cases       INTEGER,                     -- estimated cases needed
  
  -- Status
  status            TEXT DEFAULT 'pending',      -- pending, in_progress, packed, loaded, verified
  started_at        DATETIME,
  completed_at      DATETIME,
  
  -- Verification
  verified_by       INTEGER REFERENCES users(id),
  discrepancies     TEXT,                        -- JSON: any mismatches
  
  notes             TEXT,
  created_at        DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

#### `vehicles`

```sql
CREATE TABLE vehicles (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  name              TEXT NOT NULL,               -- "Van 1", "Sprinter"
  type              TEXT,                        -- van, truck, car
  make              TEXT,
  model             TEXT,
  year              INTEGER,
  license_plate     TEXT,
  vin               TEXT,
  
  -- Capacity
  cargo_capacity_sqft REAL,
  max_weight_lbs    REAL,
  
  -- Status
  status            TEXT DEFAULT 'available',    -- available, in_use, maintenance, retired
  current_mileage   REAL,
  
  -- Maintenance
  last_oil_change   DATE,
  next_oil_change   DATE,
  last_inspection   DATE,
  insurance_expires DATE,
  registration_expires DATE,
  
  assigned_driver_id INTEGER REFERENCES users(id),
  
  created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### 2.7 Sales & Machine Data Tables

#### `machine_sales`
Aggregated sales data pulled from SandStar API.

```sql
CREATE TABLE machine_sales (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  machine_id        INTEGER NOT NULL REFERENCES machines(id),
  location_id       INTEGER REFERENCES locations(id),
  
  -- Time period
  sale_date         DATE NOT NULL,
  hour              INTEGER,                     -- 0-23, NULL for daily aggregate
  
  -- Sales
  total_transactions INTEGER DEFAULT 0,
  total_revenue      REAL DEFAULT 0,
  total_items_sold   INTEGER DEFAULT 0,
  
  -- By product (JSON for flexibility)
  product_breakdown  TEXT,                       -- JSON: [{product_id, qty, revenue}]
  
  -- Payment breakdown
  card_revenue       REAL DEFAULT 0,
  cash_revenue       REAL DEFAULT 0,
  mobile_revenue     REAL DEFAULT 0,             -- Apple Pay, Google Pay
  
  created_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
  
  UNIQUE(machine_id, sale_date, hour)
);

CREATE INDEX idx_sales_machine_date ON machine_sales(machine_id, sale_date);
CREATE INDEX idx_sales_location ON machine_sales(location_id);
CREATE INDEX idx_sales_date ON machine_sales(sale_date);
```

#### `machine_events`
Health/status events from SandStar.

```sql
CREATE TABLE machine_events (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  machine_id        INTEGER NOT NULL REFERENCES machines(id),
  
  event_type        TEXT NOT NULL,               -- error, warning, info, maintenance, theft, vandalism
  event_code        TEXT,                        -- SandStar error code
  event_message     TEXT,
  
  -- Details
  temperature       REAL,                        -- fridge temp at time of event
  door_status       TEXT,                        -- open, closed
  connectivity      TEXT,                        -- online, offline, intermittent
  
  -- Theft/Shrinkage Tracking (Skool: theft/vandalism is a real problem)
  shrinkage_amount  REAL,                        -- estimated $ value of stolen/damaged product
  shrinkage_units   INTEGER,                     -- number of items
  vandalism_type    TEXT,                        -- screen_damage, lock_tamper, product_theft, cash_box, graffiti
  photo_evidence    TEXT,                        -- JSON: [{url, caption}]
  police_report     TEXT,                        -- report number if filed
  
  -- Resolution
  resolved          BOOLEAN DEFAULT FALSE,
  resolved_at       DATETIME,
  resolved_by       INTEGER REFERENCES users(id),
  resolution_notes  TEXT,
  
  created_at        DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_events_machine ON machine_events(machine_id);
CREATE INDEX idx_events_unresolved ON machine_events(resolved) WHERE resolved = FALSE;
CREATE INDEX idx_events_theft ON machine_events(event_type) WHERE event_type IN ('theft', 'vandalism');
```

#### `shrinkage_summary`
Aggregated theft/vandalism tracking per location — critical for identifying problem locations.

```sql
CREATE TABLE shrinkage_summary (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  location_id       INTEGER NOT NULL REFERENCES locations(id),
  machine_id        INTEGER NOT NULL REFERENCES machines(id),
  
  period_month      TEXT NOT NULL,               -- "2025-07"
  
  -- Expected vs Actual (Skool: "track every unit")
  units_stocked     INTEGER DEFAULT 0,           -- total units loaded into machine
  units_sold        INTEGER DEFAULT 0,           -- total units sold (from SandStar)
  units_expired     INTEGER DEFAULT 0,           -- removed as expired
  units_damaged     INTEGER DEFAULT 0,           -- removed as damaged
  units_missing     INTEGER DEFAULT 0,           -- stocked - sold - expired - damaged = missing
  
  shrinkage_pct     REAL,                        -- missing / stocked × 100
  shrinkage_value   REAL,                        -- estimated $ lost
  
  theft_incidents   INTEGER DEFAULT 0,           -- logged theft events this month
  vandalism_incidents INTEGER DEFAULT 0,
  
  created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
  
  UNIQUE(location_id, machine_id, period_month)
);
```

### 2.8 Financial Tables

#### `commissions`
Revenue sharing with location partners.
> **Skool Rule:** Offer 3-5% of gross revenue to lock out competition. This is a strategic 
> tool, not charity — it makes locations sticky and deters competitors from even asking.
> Max 10% for premium high-traffic locations. Never go higher.

```sql
CREATE TABLE commissions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id       INTEGER NOT NULL REFERENCES contracts(id),
  lead_id           INTEGER NOT NULL REFERENCES leads(id),
  location_id       INTEGER NOT NULL REFERENCES locations(id),
  
  period_start      DATE NOT NULL,
  period_end        DATE NOT NULL,
  
  -- Revenue (Skool: 3-5% of GROSS is the standard offer)
  gross_revenue     REAL NOT NULL,
  net_revenue       REAL,                        -- gross minus shrinkage/refunds
  commission_rate   REAL NOT NULL,               -- percentage (target: 3-5%, max 10%)
  commission_amount REAL NOT NULL,               -- calculated from gross × rate
  
  -- Context
  machines_active   INTEGER DEFAULT 1,           -- how many machines were active this period
  
  -- Referral Bonus (Skool: "Introduce me to 3 buildings, start rev share immediately")
  includes_referral_bonus BOOLEAN DEFAULT FALSE,
  referral_bonus_amount   REAL DEFAULT 0,
  referral_bonus_reason   TEXT,                  -- "Referred Henderson Medical, Sunset Apts"
  
  -- Status
  status            TEXT DEFAULT 'calculated',   -- calculated, approved, paid, disputed
  approved_by       INTEGER REFERENCES users(id),
  paid_at           DATETIME,
  payment_method    TEXT,                        -- check, ach, zelle
  payment_reference TEXT,
  
  created_at        DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

#### `expenses`

```sql
CREATE TABLE expenses (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  
  category          TEXT NOT NULL,               -- cogs, fuel, labor, maintenance, supplies, rent, insurance, other
  subcategory       TEXT,                        -- for cogs: product purchases. for maintenance: parts, service call
  
  amount            REAL NOT NULL,
  description       TEXT,
  
  -- Attribution (optional — for per-location/route P&L)
  location_id       INTEGER REFERENCES locations(id),
  route_id          INTEGER REFERENCES routes(id),
  machine_id        INTEGER REFERENCES machines(id),
  vehicle_id        INTEGER REFERENCES vehicles(id),
  
  -- Documentation
  receipt_url       TEXT,
  vendor            TEXT,
  
  expense_date      DATE NOT NULL,
  user_id           INTEGER REFERENCES users(id),
  
  -- Approval
  status            TEXT DEFAULT 'pending',      -- pending, approved, rejected, reimbursed
  approved_by       INTEGER REFERENCES users(id),
  
  created_at        DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

#### `invoices`

```sql
CREATE TABLE invoices (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_number    TEXT UNIQUE NOT NULL,         -- KVT-INV-2025-001
  
  lead_id           INTEGER REFERENCES leads(id),
  contract_id       INTEGER REFERENCES contracts(id),
  
  type              TEXT NOT NULL,                -- commission_payout, equipment_charge, service_fee
  
  period_start      DATE,
  period_end        DATE,
  
  subtotal          REAL NOT NULL,
  tax               REAL DEFAULT 0,
  total             REAL NOT NULL,
  
  line_items        TEXT,                         -- JSON: [{description, quantity, unit_price, total}]
  
  -- Status
  status            TEXT DEFAULT 'draft',         -- draft, sent, paid, overdue, cancelled
  due_date          DATE,
  sent_at           DATETIME,
  paid_at           DATETIME,
  
  pdf_url           TEXT,
  
  created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### 2.9 Notification & System Tables

#### `notifications`

```sql
CREATE TABLE notifications (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id           INTEGER REFERENCES users(id),
  
  type              TEXT NOT NULL,                -- alert, reminder, info, warning, urgent
  category          TEXT NOT NULL,                -- lead, machine, inventory, route, contract, financial
  title             TEXT NOT NULL,
  body              TEXT,
  
  -- Action
  action_url        TEXT,                         -- link to relevant page
  action_data       TEXT,                         -- JSON: any context data
  
  -- Delivery
  channels          TEXT DEFAULT '["web"]',       -- JSON: ["web", "email", "sms", "push"]
  delivered_web     BOOLEAN DEFAULT FALSE,
  delivered_email   BOOLEAN DEFAULT FALSE,
  delivered_sms     BOOLEAN DEFAULT FALSE,
  
  -- Status
  read              BOOLEAN DEFAULT FALSE,
  read_at           DATETIME,
  dismissed         BOOLEAN DEFAULT FALSE,
  
  created_at        DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_notifications_user ON notifications(user_id);
CREATE INDEX idx_notifications_unread ON notifications(user_id, read) WHERE read = FALSE;
```

#### `tags`
Flexible tagging for any entity.

```sql
CREATE TABLE tags (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT UNIQUE NOT NULL,
  color       TEXT DEFAULT '#6B7280'              -- hex color for UI
);

CREATE TABLE entity_tags (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tag_id      INTEGER NOT NULL REFERENCES tags(id),
  entity_type TEXT NOT NULL,                     -- lead, location, machine, product
  entity_id   INTEGER NOT NULL,
  UNIQUE(tag_id, entity_type, entity_id)
);
```

---

## 3. User Roles & Permissions

### 3.1 Role Definitions

| Role | Access Level | Dashboard Views | Mobile Access |
|------|-------------|-----------------|---------------|
| **admin** | Full system access | All pages | Full |
| **sales** | Leads, outreach, proposals, surveys | CRM, Outreach, Proposals, Surveys | Survey form |
| **driver** | Routes, restocking, machine status | Driver portal only | Full driver app |
| **packer** | Pick lists, inventory | Packer portal only | Packer app |
| **client** | Own location data only | Client portal only | Client portal |

### 3.2 Permission Matrix

```
Resource              admin   sales   driver  packer  client
─────────────────────────────────────────────────────────────
Leads (CRUD)           ✅      ✅      ❌      ❌      ❌
Activities (read)      ✅      ✅      ❌      ❌      ❌
Activities (create)    ✅      ✅      ✅      ❌      ❌
Surveys (CRUD)         ✅      ✅      ❌      ❌      ❌
Proposals (CRUD)       ✅      ✅      ❌      ❌      ❌
Contracts (CRUD)       ✅      Read    ❌      ❌      Own
Machines (CRUD)        ✅      Read    Read    ❌      Own
Locations (CRUD)       ✅      ✅      Read    ❌      Own
Routes (CRUD)          ✅      ❌      Read    ❌      ❌
Route Runs (manage)    ✅      ❌      Own     ❌      ❌
Pick Lists (manage)    ✅      ❌      ❌      Own     ❌
Inventory (CRUD)       ✅      ❌      ❌      ✅      ❌
Products (CRUD)        ✅      ❌      ❌      Read    ❌
Financials (all)       ✅      ❌      ❌      ❌      ❌
Commissions (read)     ✅      Read    ❌      ❌      Own
Users (CRUD)           ✅      ❌      ❌      ❌      ❌
Notifications          ✅      Own     Own     Own     Own
Reports                ✅      Sales   ❌      ❌      Own
```

### 3.3 Authentication

**Phase 1 (Current):** Simple token-based auth with hardcoded admin access  
**Phase 2:** JWT authentication with bcrypt password hashing  
**Phase 3:** OAuth2 / SSO integration  

Client portal uses unique access links (token-based, no password required initially):
```
/client-portal?token=abc123def456
```

---

## 4. Stage 1: Prospecting — Lead Discovery

### 4.1 Database Tables
- `leads` (primary)
- `lead_contacts`
- `activities` (source tracking)
- `tags` / `entity_tags` (categorization)

### 4.2 API Endpoints

```
GET     /api/leads                    List leads (filterable, paginated)
GET     /api/leads/:id                Get single lead with contacts & activities
POST    /api/leads                    Create lead (manual add)
PUT     /api/leads/:id                Update lead
DELETE  /api/leads/:id                Soft-delete (archive) lead
PATCH   /api/leads/:id/status         Update lead status
POST    /api/leads/bulk               Bulk import (from Apollo JSON)
GET     /api/leads/search             Search leads by name/company/address
GET     /api/leads/stats              Pipeline statistics

POST    /api/leads/:id/contacts       Add contact to lead
PUT     /api/leads/:id/contacts/:cid  Update contact
DELETE  /api/leads/:id/contacts/:cid  Remove contact

POST    /api/leads/:id/activities     Log an activity
GET     /api/leads/:id/activities     Get activity timeline

POST    /api/leads/:id/tags           Add tag
DELETE  /api/leads/:id/tags/:tid      Remove tag

-- Apollo Integration
POST    /api/apollo/search            Search Apollo for prospects
POST    /api/apollo/enrich            Enrich lead with Apollo data
POST    /api/apollo/import            Import Apollo search results as leads
```

### 4.3 Dashboard Pages

#### `/crm` — CRM Pipeline View (Restructured)
**Layout:** Kanban board + list view toggle

**Kanban Columns:**
- New Lead | Contacted | Interested | Meeting Scheduled | Qualified | Proposal Sent | Negotiating | Won | Lost

**Each Card Shows:**
- Company name, contact name
- Property type icon
- Score badge (colored: green >70, yellow 40-70, red <40)
- Days in current stage
- Next follow-up date
- Tag chips

**Filters:**
- Status, stage, property type, city/zip, assigned to, source, score range, date range, tags

**Bulk Actions:**
- Assign to user
- Change status
- Add to email campaign
- Export CSV
- Tag/untag

#### `/crm/add` — Add Lead Form
**Fields:**
- Company name, DBA (optional)
- Management company (dropdown: Greystar, Holland, Camden, Other, None — Skool: these are gatekeepers)
- Contact name, title, email, phone
- Address, city, state, zip
- Property type (dropdown)
- Building class (A/B/C)
- Estimated sqft, employee/resident count
- **Daily attendance** (how many people actually show up daily — Skool: qualify on this)
- **Shift breakdown** (day/swing/night — Skool: affects machine usage patterns)
- **Existing snack options** (dropdown: cafeteria, micro-market, old vending, food trucks, nothing)
- Source (dropdown: manual, referral, walk-in, event, pop_in)
- Source detail (free text)
- **Referred by** (search existing clients — Skool: track all referral chains)
- Notes
- Tags (multi-select)

> **UI Note:** If management company = "Greystar", auto-show vendor approval section  
> with NetVendor status field. If "Holland", show direct approval tracking.

#### `/crm/:id` — Lead Detail View
**Sections:**
1. **Header:** Company name, status badge, score, quick-action buttons (email, call, schedule, **log pop-in**, edit)
2. **Contact Info:** All contacts, primary highlighted, click-to-call/email, decision maker flagged
3. **Activity Timeline:** Chronological list of all activities, with type icons
   - **Touch Counter** prominently displayed: "Touch 4 of 10" (Skool: 8-10 touches to close)
   - Pop-in activities highlighted in gold (Skool: these are the ones that matter)
   - Gift basket drops marked with 🎁
4. **Pipeline Progress:** Visual progress bar showing current stage
5. **Quick Stats:** 
   - Days since first contact, total activities, last contact date
   - **Total touches** / target (e.g., "5/10")
   - **Pop-in count** specifically
   - **Estimated monthly revenue** with $2K threshold indicator (🟢 above / 🔴 below)
6. **Vendor Approval Status** (if management company requires it): NetVendor / Holland status
7. **Referral Section:** 
   - "Referred by: [Client Name]" (if applicable)
   - "Referrals given: 3" with links to referred leads
   - **"Ask for Referral" button** (Skool: always ask, creates referral_ask activity)
8. **Related:** Survey (if exists), Proposal (if exists), Contract (if exists), Location (if active)
9. **Tags:** Editable tag chips

### 4.4 Automations

| Trigger | Action |
|---------|--------|
| New lead imported from Apollo | Auto-enrich, set source = "apollo", **auto-calculate estimated_monthly_rev from employee_count** |
| Lead created manually | Set source = "manual", notify admin |
| estimated_monthly_rev calculated < $2,000 | ⚠️ Flag: "$2K threshold not met — review before spending time" (Skool: $2K minimum) |
| Lead created with management_company = "Greystar" | Auto-set vendor_approval_platform = "netvendor", flag: "NetVendor certification required" |
| Lead created with management_company = "Holland" | Flag: "Holland vendor approval process required — check requirements" |
| Lead idle > 3 days in "new_lead" | Notification: "Schedule pop-in for [company]" (Skool: pop-ins > everything) |
| Lead idle > 7 days in "new_lead" | URGENT: "No contact yet — [company] is going stale" |
| Lead idle > 7 days in "contacted" | Notification: "Touch 2+ needed for [company] — try pop-in" |
| Referral source provided | Tag as "referral", link to referring client, **increase referrer's referral_count** |
| Duplicate detected (same address or email) | Alert: "Possible duplicate — [company]" |
| Lead from pop-in created | Auto-set priority = "high" (Skool: pop-in leads close at highest rate) |

---

## 5. Stage 2: Outreach — First Contact

### 5.1 Database Tables
- `activities` (all outreach logged here)
- `leads` (status updates)
- Instantly.ai campaign data synced via API

### 5.2 API Endpoints

```
-- Cold Email (Instantly Integration)
GET     /api/outreach/campaigns           List Instantly campaigns
POST    /api/outreach/campaigns           Create Instantly campaign
GET     /api/outreach/campaigns/:id       Campaign details + stats
POST    /api/outreach/campaigns/:id/leads Add leads to campaign
GET     /api/outreach/campaigns/:id/leads List leads in campaign with email status
POST    /api/outreach/campaigns/:id/activate  Start campaign
POST    /api/outreach/campaigns/:id/pause     Pause campaign

-- Warmup Monitoring
GET     /api/outreach/warmup              Warmup status for sending accounts

-- Call Tracking
POST    /api/outreach/calls               Log a call
GET     /api/outreach/calls               List calls (filterable)
GET     /api/outreach/calls/stats         Call statistics

-- Pop-in Visits
POST    /api/outreach/visits              Log a pop-in visit
GET     /api/outreach/visits              List visits

-- Unified Activity
GET     /api/outreach/timeline            All outreach activities, unified timeline
GET     /api/outreach/stats               Outreach metrics (emails sent, calls made, meetings booked)
```

### 5.3 Dashboard Pages

#### `/outreach` — Outreach Command Center (Enhanced)
**Sections:**

1. **Daily Dashboard:**
   - Today's follow-ups (sorted by priority)
   - Overdue follow-ups (red highlight)
   - Today's scheduled calls/meetings
   - Quick-dial list (click-to-call)

2. **Email Campaigns:**
   - Active campaigns with live stats (sent, opened, replied, bounced)
   - Warmup status indicator
   - "Add leads to campaign" button → select leads from CRM

3. **Call Log:**
   - Log call button (select lead, outcome, duration, notes)
   - Recent calls list
   - Stats: calls today, connect rate, average duration

4. **Pop-in Command Center** (Skool: "90% of placements come from in-person visits"):
   - **Today's Pop-in Route:** Map showing planned pop-in visits for today
   - **Nearby Leads Map:** All leads within driving distance, color-coded by priority
   - **Log Pop-in button** → quick form:
     - Lead (auto-selected if coming from CRM)
     - Outcome (spoke_to_dm, left_materials, spoke_to_gatekeeper, building_closed)
     - Met decision maker? (yes/no) → if yes, capture name
     - Gift basket left? (yes/no) (Skool: bring products + business card every time)
     - Materials left (checkboxes: business card, brochure, product samples, gift basket)
     - Follow-up needed? → auto-schedule next touch
     - Photos (optional)
     - Notes
   - **Gift Basket Inventory:** Track gift basket supplies (product samples, business cards, brochures)
   - **Pop-in Stats:** visits this week, DM connect rate, gift baskets deployed, conversion rate

5. **10-Touch Outreach Sequence** (Skool: "8-10 outreaches to close"):
   
   **Default Sequence Template ("The Skool Sequence"):**
   ```
   Touch 1  (Day 1):  Email — intro, "AI-powered smart market" pitch (NEVER say vending)
   Touch 2  (Day 3):  Pop-in — gift basket drop with product samples + business card
   Touch 3  (Day 5):  Email — follow-up referencing the pop-in / gift basket
   Touch 4  (Day 8):  Phone call — "I stopped by last week..."
   Touch 5  (Day 12): Pop-in #2 — try to meet decision maker specifically
   Touch 6  (Day 15): Email — case study / social proof from similar property
   Touch 7  (Day 20): Phone call — "Our smart market at [similar property] is doing $X/month"
   Touch 8  (Day 25): Pop-in #3 — bring updated proposal / site-specific materials
   Touch 9  (Day 30): Email — "Last chance" / scarcity angle
   Touch 10 (Day 35): Pop-in #4 — final attempt, leave materials if no meeting
   ```
   
   - Visual sequence builder (edit default or create custom)
   - Each lead shows: "Touch 4 of 10 — Next: Phone call in 2 days"
   - **Pop-ins are marked as highest-value touches** (gold highlighting)
   - Auto-generates daily task list: "Today's touches: 3 emails, 2 calls, 4 pop-ins"
   - Sequence pauses when lead responds (moves to manual follow-up)

### 5.4 Automations

| Trigger | Action |
|---------|--------|
| Instantly reports email opened | Update activity, mark touch complete, set status → "contacted" if new |
| Instantly reports email replied | Mark touch complete, set status → "interested", **pause sequence**, notify sales |
| Call logged with outcome "connected" + positive | Set status → "interested", **pause sequence** |
| Call logged with outcome "gatekeeper" | Log gatekeeper name, schedule pop-in (Skool: go in person) |
| Meeting scheduled | Set status → "meeting_scheduled", pause sequence, create calendar event |
| **Pop-in logged with gift basket** | High-value touch recorded, schedule follow-up email in 2 days |
| **Pop-in: met decision maker** | Set status → "interested" if not already, capture DM as lead_contact |
| **Pop-in: didn't meet DM but got name** | Update lead_contacts, schedule return pop-in in 3-5 days |
| **Touch 5 reached, no response** | Alert: "Halfway through sequence for [company] — consider pop-in blitz" |
| **Touch 10 reached, no response** | Set status → "dead" (for now), schedule 90-day re-approach |
| **Touch 10 reached, was "interested" but stalled** | Alert: "Hot lead going cold — personal visit recommended" |
| Email bounced | Flag lead, **immediately schedule pop-in** (Skool: if email fails, go in person) |
| 0 pop-ins after 5 touches | Warning: "No pop-ins for [company] — emails alone won't close this" |
| **Language check on all outgoing** | ⚠️ Auto-flag if email/proposal contains the word "vending" (Skool: NEVER say vending) |

---

## 6. Stage 3: Qualification — Site Survey

### 6.1 Database Tables
- `site_surveys`
- `leads` (status update to qualified/not_qualified)
- `activities` (survey_completed event)

### 6.2 API Endpoints

```
GET     /api/surveys                      List all surveys (filterable by status)
GET     /api/surveys/:id                  Get survey with photos and score breakdown
POST    /api/surveys                      Create survey (usually from lead detail)
PUT     /api/surveys/:id                  Update survey
PATCH   /api/surveys/:id/approve          Approve survey (admin)
PATCH   /api/surveys/:id/reject           Reject survey (admin)

-- Photos
POST    /api/surveys/:id/photos           Upload survey photos
DELETE  /api/surveys/:id/photos/:pid      Delete photo

-- Scoring
GET     /api/surveys/:id/score            Get computed location score
POST    /api/surveys/score-preview        Preview score without saving (for real-time form updates)
```

### 6.3 Dashboard Pages

#### `/survey/new?lead_id=123` — Mobile-First Site Survey Form
**Design:** Single long scrolling form, optimized for phone. Big tap targets, clear sections.

**Sections:**

1. **Location Basics** (auto-filled from lead)
   - Company name (readonly)
   - Address (readonly, tap to open Maps)
   - Surveyor name (auto from logged-in user)
   - Date/time (auto)

2. **Placement Area**
   - Where will the machine go? (radio: lobby, break room, hallway, gym, pool area, common area, other)
   - Floor number (number input)
   - Area dimensions (text)
   - Photo button: "📸 Take photo of proposed location"

3. **Power**
   - Power outlet available? (yes/no)
   - Outlet type (dropdown: standard 110v, dedicated circuit, needs installation)
   - Distance from outlet (slider: 0-20ft)
   - Photo button: "📸 Photo of nearest outlet"

4. **Connectivity**
   - WiFi available? (yes/no)
   - → If yes: network name, signal strength (dropdown + "Test speed" button that runs a speed test)
   - Ethernet available? (yes/no)
   - Photo button: "📸 Photo of router/access point"

5. **Revenue Qualification** (Skool: "qualify ruthlessly — $2K/month minimum")
   - Total employees/residents (number)
   - **Shift breakdown:** Day shift count, Swing shift count, Night shift count
   - **Estimated daily attendance** (actual people on-site daily, not total headcount)
   - **Existing food options** (checkboxes: cafeteria, micro-market, old vending, food trucks, vending machines, nothing)
   - **Nearest convenience store** (text + distance)
   - **Auto-calculated revenue estimate:**
     ```
     📊 Estimated Monthly Revenue: $X,XXX
     Based on: [attendance] × $[avg_spend] × 22 work days
     Threshold: [$2,000/month minimum] ✅ PASS / 🔴 FAIL
     ```
   - Peak hours (multi-select time blocks)
   - Traffic source (checkboxes: employees, residents, patients, visitors, public, students)
   - Photo button: "📸 Photo of area during business hours"

6. **Competition**
   - Existing vending machines? (yes/no)
   - → If yes: current vendor (dropdown: Canteen, Aramark, local operator, other), machine count, condition, products
   - Why switching? (textarea) — (Skool: "taking over Canteen locations" is a major opportunity)
   - **Current contract end date** (if known) — for timing the pitch
   - Photo button: "📸 Photo of existing machines"

7. **Vendor Approval** (Skool: Greystar = NetVendor, Holland = direct)
   - Is this a managed property? (yes/no)
   - → If yes: Management company (dropdown: Greystar, Holland, Camden, Pinnacle, other)
   - → If Greystar: "⚠️ NetVendor certification required"
   - → If Holland: "⚠️ Holland vendor approval required"
   - Approval status (not started, applied, pending, approved)

8. **Security & Theft Risk** (Skool: theft tracking essential)
   - Security cameras covering area? (yes/no)
   - Security guard present? (yes/no)
   - Area visibility from staff (high/medium/low)
   - Theft risk assessment (low/medium/high)
   - Notes on security concerns

9. **Access & Delivery**
   - Delivery access (radio: front door, loading dock, freight elevator, stairs only)
   - Parking available? (yes/no)
   - Access restrictions (textarea)
   - Photo button: "📸 Photo of delivery entrance"

10. **Environment**
    - Indoor/outdoor (radio)
    - Climate controlled? (yes/no)
    - Direct sunlight? (yes/no)

11. **Surveyor Notes**
    - Overall impression (textarea)
    - Recommended machine count (number)
    - Recommended machine type (dropdown)
    - Recommended placement description (textarea)
    - Any concerns? (textarea)

12. **Submit**
    - "Save Draft" button
    - "Submit Survey" button
    - **Revenue threshold indicator shown at bottom:**
      ```
      ┌───────────────────────────────────────┐
      │ 📊 QUALIFICATION SUMMARY               │
      │ Est. Monthly Revenue: $3,200    ✅ PASS │
      │ Location Score: 78/100                 │
      │ Vendor Approval: Not Required          │
      │ Theft Risk: Low                        │
      │ ⚡ RECOMMENDATION: PROCEED TO PROPOSAL │
      └───────────────────────────────────────┘
      ```

#### `/surveys` — Survey List (Admin)
- Table: lead name, survey date, surveyor, score, status
- Filter by status, score range, date
- Click → full survey view

#### `/surveys/:id` — Survey Detail View
- All form data displayed nicely
- Photo gallery
- Score breakdown chart (bar chart of scoring factors)
- "Approve" / "Reject" buttons (admin only)
- "Generate Proposal" button (leads to Stage 4)

### 6.4 Location Scoring Algorithm

> **Skool Philosophy:** Revenue potential is king. A location with perfect WiFi but 20 employees  
> is worse than a location that needs an electrician but has 500 employees. Score accordingly.  
> Hard gate: if estimated_monthly_rev < $2,000, the location FAILS regardless of total score.

```javascript
function calculateLocationScore(survey) {
  let score = 0;
  const breakdown = {};
  const flags = [];
  
  // ═══════════════════════════════════════════════
  // REVENUE POTENTIAL (0-35 points) — Skool: THIS IS WHAT MATTERS MOST
  // ═══════════════════════════════════════════════
  
  // Calculate estimated monthly revenue
  const avgSpendPerPerson = 2.50; // conservative average
  const captureRate = 0.15; // 15% of foot traffic buys something
  const workDays = 22;
  const dailyAttendance = survey.daily_attendance || survey.daily_foot_traffic || 0;
  const estimatedMonthlyRev = dailyAttendance * captureRate * avgSpendPerPerson * workDays;
  
  // HARD GATE: $2K/month minimum (Skool: "minimum threshold")
  const meets2kThreshold = estimatedMonthlyRev >= 2000;
  if (!meets2kThreshold) {
    flags.push('🔴 FAILS $2K/month minimum threshold');
  }
  
  if (dailyAttendance >= 500) breakdown.revenue_potential = 35;
  else if (dailyAttendance >= 300) breakdown.revenue_potential = 30;
  else if (dailyAttendance >= 200) breakdown.revenue_potential = 25;
  else if (dailyAttendance >= 100) breakdown.revenue_potential = 18;
  else if (dailyAttendance >= 50) breakdown.revenue_potential = 10;
  else breakdown.revenue_potential = 3;
  
  // Multi-shift bonus (Skool: "ask about shift breakdown")
  if (survey.shift_breakdown) {
    const shifts = JSON.parse(survey.shift_breakdown);
    const activeShifts = Object.values(shifts).filter(v => v > 0).length;
    if (activeShifts >= 3) breakdown.revenue_potential += 5; // 24/7 location, huge upside
    else if (activeShifts >= 2) breakdown.revenue_potential += 3;
  }
  
  // Cap at 40
  breakdown.revenue_potential = Math.min(breakdown.revenue_potential, 40);
  
  // ═══════════════════════════════════════════════
  // CAPTIVE AUDIENCE QUALITY (0-15 points)
  // Skool: "employees, residents, patients = captive audiences"
  // ═══════════════════════════════════════════════
  const source = survey.traffic_source || '';
  const captiveAudiences = ['employees', 'residents', 'patients'];
  const isCaptive = captiveAudiences.some(s => source.includes(s));
  
  if (isCaptive && survey.existing_food_options === 'nothing') {
    breakdown.audience_quality = 15; // captive audience with NO food options = gold mine
  } else if (isCaptive && ['old_vending', 'food_trucks'].includes(survey.existing_food_options)) {
    breakdown.audience_quality = 12; // captive with bad options = upgrade opportunity
  } else if (isCaptive) {
    breakdown.audience_quality = 10; // captive but has cafeteria/options
  } else {
    breakdown.audience_quality = 5; // transient traffic
  }
  
  // ═══════════════════════════════════════════════
  // COMPETITION (0-12 points)
  // Skool: "taking over Canteen locations" is a huge opportunity
  // ═══════════════════════════════════════════════
  if (survey.existing_vending && survey.competitor_issues) {
    breakdown.competition = 12; // unhappy with current vendor = easiest close
    if (survey.existing_vendor === 'Canteen' || survey.existing_vendor === 'Aramark') {
      flags.push('🎯 National vendor displacement opportunity — these clients are often neglected');
    }
  } else if (survey.existing_vending) {
    breakdown.competition = 5; // proven demand but they're not looking
  } else {
    breakdown.competition = 8; // no competition = we'd be the first (good but unproven)
  }
  
  // ═══════════════════════════════════════════════
  // INFRASTRUCTURE (0-15 points) — important but fixable
  // ═══════════════════════════════════════════════
  
  // Power (0-8)
  if (survey.power_available && survey.power_distance_ft <= 5) breakdown.power = 8;
  else if (survey.power_available) breakdown.power = 6;
  else { breakdown.power = 0; flags.push('⚡ No power — requires electrician'); }
  
  // Connectivity (0-7)
  if (survey.ethernet_available) breakdown.connectivity = 7;
  else if (survey.wifi_available && survey.wifi_signal_strength === 'strong') breakdown.connectivity = 6;
  else if (survey.wifi_available) breakdown.connectivity = 4;
  else { breakdown.connectivity = 0; flags.push('📡 No WiFi — need cellular or WiFi install'); }
  
  // ═══════════════════════════════════════════════
  // OPERATIONS FEASIBILITY (0-10 points)
  // Skool: "route efficiency is #1 scaling bottleneck"
  // ═══════════════════════════════════════════════
  
  // Access
  if (survey.delivery_access === 'loading_dock' && survey.parking_available) breakdown.access = 5;
  else if (survey.delivery_access === 'front_door' && survey.parking_available) breakdown.access = 4;
  else if (survey.delivery_access === 'freight_elevator') breakdown.access = 3;
  else if (survey.delivery_access === 'stairs_only') { 
    breakdown.access = 1; 
    flags.push('🚧 Stairs only — difficult restocking, factor into route time');
  }
  else breakdown.access = 3;
  
  // Environment
  if (survey.indoor_outdoor === 'indoor' && survey.climate_controlled) breakdown.environment = 5;
  else if (survey.indoor_outdoor === 'indoor') breakdown.environment = 3;
  else { breakdown.environment = 1; flags.push('🌡️ Outdoor/uncovered — temp control concern'); }
  
  // ═══════════════════════════════════════════════
  // SECURITY (0-8 points)
  // Skool: theft/vandalism tracking is critical
  // ═══════════════════════════════════════════════
  if (survey.theft_risk_assessment === 'low') breakdown.security = 8;
  else if (survey.theft_risk_assessment === 'medium') {
    breakdown.security = 4;
    if (survey.security_cameras) breakdown.security += 2;
  }
  else { 
    breakdown.security = 0; 
    flags.push('🔴 HIGH theft risk — reconsider or require security improvements');
  }
  
  // ═══════════════════════════════════════════════
  // TOTAL
  // ═══════════════════════════════════════════════
  score = Object.values(breakdown).reduce((a, b) => a + b, 0);
  
  // Vendor approval penalty (not a score reducer, but a blocker flag)
  if (survey.requires_vendor_approval && survey.approval_status !== 'approved') {
    flags.push('⏳ Vendor approval pending — cannot proceed until approved');
  }
  
  return { 
    score, 
    breakdown, 
    maxScore: 100,
    estimatedMonthlyRev: Math.round(estimatedMonthlyRev),
    meets2kThreshold,
    flags,
    recommendation: getRecommendation(score, meets2kThreshold, flags)
  };
}

function getRecommendation(score, meets2k, flags) {
  if (!meets2k) return '🔴 DO NOT PROCEED — Below $2K/month revenue threshold';
  if (flags.some(f => f.includes('HIGH theft risk'))) return '🟡 PROCEED WITH CAUTION — Address security first';
  if (flags.some(f => f.includes('Vendor approval pending'))) return '⏳ HOLD — Waiting on vendor approval';
  if (score >= 75) return '🟢 STRONG LOCATION — Generate proposal immediately';
  if (score >= 55) return '🟡 VIABLE LOCATION — Proceed with standard proposal';
  if (score >= 40) return '🟠 MARGINAL — Negotiate favorable terms or pass';
  return '🔴 WEAK LOCATION — Not recommended';
}
```

### 6.5 Automations

| Trigger | Action |
|---------|--------|
| Survey submitted | Calculate score, calculate estimated_monthly_rev, update lead, notify admin |
| **estimated_monthly_rev < $2,000** | 🔴 **HARD BLOCK:** Auto-set "not_qualified", flag: "Below $2K threshold" (Skool: non-negotiable) |
| **estimated_monthly_rev $2K-$3K** | 🟡 Set "needs_review" — marginal location, admin must approve manually |
| **estimated_monthly_rev > $3K + score ≥ 70** | 🟢 Auto-set "qualified", enable "Generate Proposal" |
| Score ≥ 70, meets $2K threshold | Auto-set lead status → "qualified", green flag |
| Score 40-69, meets $2K threshold | Set as "needs_review", admin decides |
| Score < 40 | Flag as "not_qualified" regardless of revenue estimate |
| **Vendor approval required but not approved** | ⏳ Block proposal generation, show "Waiting on [NetVendor/Holland] approval" |
| **Theft risk = "high"** | Warning: "High theft risk — require security cameras before placement" |
| Survey approved by admin | Update lead status → "qualified", enable "Generate Proposal" |
| Survey rejected | Update lead status → "not_qualified", log reason in activities |
| Survey has photos missing | Warning: "Survey incomplete — photos recommended" |
| **Survey completed for Greystar property** | Auto-check: "NetVendor certification status?" — block if not certified |

---

## 7. Stage 4: Proposal — Close the Deal

### 7.1 Database Tables
- `proposals`
- `contracts`
- `leads` (status updates)
- `activities` (proposal events)

### 7.2 API Endpoints

```
GET     /api/proposals                    List proposals (filterable)
GET     /api/proposals/:id                Get proposal with lead + survey data
POST    /api/proposals                    Create proposal (from lead + survey)
PUT     /api/proposals/:id                Update proposal
POST    /api/proposals/:id/generate-pdf   Generate/regenerate PDF
POST    /api/proposals/:id/send           Send proposal to client (email)
POST    /api/proposals/:id/duplicate      Duplicate proposal (new version)

-- Auto-generation
POST    /api/proposals/auto-generate      Auto-generate from lead_id + survey_id

-- Contracts
GET     /api/contracts                    List contracts
GET     /api/contracts/:id                Get contract details
POST    /api/contracts                    Create from accepted proposal
PUT     /api/contracts/:id                Update contract
PATCH   /api/contracts/:id/terminate      Terminate contract
POST    /api/contracts/:id/renew          Renew contract

-- E-signature
POST    /api/proposals/:id/esign          Send for e-signature
GET     /api/proposals/:id/esign/status   Check e-sign status
POST    /api/esign/webhook                Webhook for e-sign provider callbacks
```

### 7.3 Dashboard Pages

#### `/proposals` — Proposal List
- Table: proposal number, client, machine count, monthly estimate, status, sent date
- Status filter tabs: All | Draft | Sent | Negotiating | Accepted | Rejected
- Quick actions: view, edit, duplicate, send

#### `/proposal-generator` — Proposal Builder (Enhanced)
**Current page enhanced with:**

1. **Lead Selection:**
   - Search/select lead from CRM
   - Auto-loads lead info + survey data
   - If no survey: "Complete site survey first" prompt

2. **Package Builder:**
   - Machine count (number input)
   - Machine type selection (with images)
   - Recommended planogram based on location type (auto-selected)
   - Estimated monthly revenue calculator:
     ```
     machines × avg_transactions_per_day × avg_transaction_value × 30
     ```

3. **Terms** (Skool: "3-5% rev share locks out competition"):
   - Revenue share % (slider: 0-10%, **default 5%**, with Skool guidance displayed):
     ```
     ┌─────────────────────────────────────────────┐
     │ 💡 SKOOL PLAYBOOK: Rev Share Strategy        │
     │                                             │
     │ 3% — Minimum offer. Use for small locations │
     │ 5% — Standard. Locks out competitors.       │
     │ 7% — Premium locations, competitive bids    │
     │ 10% — Maximum. Only for anchor locations    │
     │                                             │
     │ ⚠️ Never go above 10%. Offer referral bonus  │
     │ instead: "Introduce 3 buildings = immediate  │
     │ rev share start"                            │
     └─────────────────────────────────────────────┘
     ```
   - Minimum monthly (optional)
   - Contract length (12/24/36 months)
   - Auto-renewal (toggle)
   - **Referral incentive clause** (toggle): "Rev share begins immediately upon referral of 3+ properties"
   - Custom terms (textarea)

4. **What's Included:**
   - Checkboxes: Machine(s), Installation, Stocking, Maintenance, WiFi hardware
   - Each toggles on/off in the proposal

5. **Preview:**
   - Real-time proposal preview (matching final PDF)
   - Kande VendTech branding, professional layout
   - Sections: About Us, Technology (SandStar AI), Your Package, Revenue Sharing, Terms

6. **Actions:**
   - "Save Draft"
   - "Generate PDF" → preview/download
   - "Send to Client" → email with PDF + tracking link
   - "Send for E-Signature" → DocuSign/PandaDoc integration

#### Proposal PDF Template Sections:
> ⚠️ **LANGUAGE RULE (Skool):** The word "vending" must NEVER appear in any client-facing  
> document. Use: "AI-powered smart market", "smart cooler", "premium amenity", "automated  
> retail solution", "smart refreshment center". The proposal builder must auto-flag and  
> reject any draft containing "vending" or "vending machine".

1. Cover page (Kande VendTech branding + client name + "Premium Smart Market Proposal")
2. About Kande VendTech ("We're a local Las Vegas smart market operator" — Skool: "I'm local, you can call me")
3. The SandStar Advantage (AI recognition, cashierless shopping, real-time analytics, modern amenity)
4. Your Custom Smart Market (machine count, type, placement from survey, product selection for your demographic)
5. Expected Performance (revenue projections based on location score + comps from similar properties)
6. Revenue Sharing Partnership (terms, percentage, payment schedule — Skool: frame as "partnership" not "deal")
7. What We Handle (installation, stocking, maintenance, tech support — "zero effort from your team")
8. Referral Program ("Introduce us to 3 other properties and your revenue share begins immediately")
9. Terms & Conditions
10. Signature page

### 7.4 Automations

| Trigger | Action |
|---------|--------|
| Proposal created from qualified lead | Auto-populate from lead + survey data, **auto-set rev share to 5%** (Skool default) |
| **Proposal generated** | ⚠️ **Language scan:** Reject if contains "vending" anywhere in text (Skool: NEVER say vending) |
| Proposal sent to client | Update lead status → "proposal_sent", log activity, start 3-day follow-up timer |
| Proposal viewed (tracking link) | Log activity, notify sales, **schedule pop-in follow-up** (Skool: in-person closes deals) |
| Proposal not viewed after 3 days | Reminder: "Follow up on proposal for [company] — **schedule pop-in**" |
| Proposal accepted / e-signed | Update lead status → "won", create contract, trigger onboarding, **schedule referral ask** |
| **Deal won** | 🎯 Create task: "Ask [client] for 3 building referrals" (Skool: every closed deal = referral opportunity) |
| Proposal rejected | Update lead status → "lost", log reason, schedule 90-day re-approach |
| **Proposal rejected on price/rev share** | Suggestion: "Consider increasing rev share to X% (max 10%)" |
| Proposal in "negotiating" > 14 days | Alert: "Stale negotiation — schedule in-person meeting" |
| Contract created from proposal | Copy terms, set start/end dates, **include referral clause** |
| Contract approaching expiry (60 days) | Notification: "Contract renewal needed for [company]" |
| **Rev share set above 10%** | ⚠️ Warning: "Rev share above 10% — Skool playbook max is 10%. Are you sure?" |

---

## 8. Stage 5: Onboarding — Machine Install

### 8.1 Database Tables
- `leads` (status: onboarding → machine_ordered → machine_installed → active)
- `machines` (assignment)
- `locations` (creation)
- `planograms` (assignment)
- New: `onboarding_checklists`

#### `onboarding_checklists`

```sql
CREATE TABLE onboarding_checklists (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id         INTEGER NOT NULL REFERENCES leads(id),
  location_id     INTEGER REFERENCES locations(id),
  contract_id     INTEGER REFERENCES contracts(id),
  
  -- Checklist Items (boolean flags)
  contract_signed         BOOLEAN DEFAULT FALSE,
  location_created        BOOLEAN DEFAULT FALSE,
  machine_assigned        BOOLEAN DEFAULT FALSE,
  machine_ordered         BOOLEAN DEFAULT FALSE,    -- if new machine needed
  machine_received        BOOLEAN DEFAULT FALSE,
  planogram_assigned      BOOLEAN DEFAULT FALSE,
  initial_stock_ordered   BOOLEAN DEFAULT FALSE,
  initial_stock_packed    BOOLEAN DEFAULT FALSE,
  install_date_scheduled  BOOLEAN DEFAULT FALSE,
  install_date            DATE,
  
  -- Installation Day
  power_verified          BOOLEAN DEFAULT FALSE,
  wifi_configured         BOOLEAN DEFAULT FALSE,
  machine_placed          BOOLEAN DEFAULT FALSE,
  machine_leveled         BOOLEAN DEFAULT FALSE,
  machine_powered_on      BOOLEAN DEFAULT FALSE,
  sandstar_connected      BOOLEAN DEFAULT FALSE,
  planogram_loaded        BOOLEAN DEFAULT FALSE,
  products_stocked        BOOLEAN DEFAULT FALSE,
  test_transaction        BOOLEAN DEFAULT FALSE,
  client_walkthrough      BOOLEAN DEFAULT FALSE,
  photos_taken            BOOLEAN DEFAULT FALSE,
  
  -- Post-Install
  client_portal_activated BOOLEAN DEFAULT FALSE,
  route_assigned          BOOLEAN DEFAULT FALSE,
  first_service_scheduled BOOLEAN DEFAULT FALSE,
  
  -- Status
  status              TEXT DEFAULT 'not_started',  -- not_started, in_progress, install_scheduled, installed, verified
  completion_pct      REAL DEFAULT 0,
  
  -- Notes
  notes               TEXT,
  install_photos      TEXT,                        -- JSON: [{url, caption}]
  
  completed_at        DATETIME,
  created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### 8.2 API Endpoints

```
GET     /api/onboarding                       List all onboarding in progress
GET     /api/onboarding/:id                   Get checklist
POST    /api/onboarding                       Create onboarding checklist (triggered by "Won")
PUT     /api/onboarding/:id                   Update checklist
PATCH   /api/onboarding/:id/item              Toggle single checklist item
POST    /api/onboarding/:id/complete          Mark onboarding complete

-- Machine Assignment
GET     /api/machines/available               List machines available for assignment
POST    /api/onboarding/:id/assign-machine    Assign machine to this onboarding
POST    /api/onboarding/:id/assign-planogram  Assign planogram

-- Location Creation
POST    /api/onboarding/:id/create-location   Create location from lead + survey data

-- Initial Stock
GET     /api/onboarding/:id/initial-stock     Get recommended initial stock list
POST    /api/onboarding/:id/initial-stock     Create pick list for initial stock

-- Client Portal
POST    /api/onboarding/:id/activate-portal   Generate client portal access
```

### 8.3 Dashboard Pages

#### `/onboarding` — Onboarding Queue
- Cards for each onboarding in progress
- Progress bars showing completion %
- Filter: status, assigned installer, install date
- Color coding: red (overdue), yellow (in progress), green (complete)

#### `/onboarding/:id` — Onboarding Checklist
**Visual checklist with sections:**

1. **Pre-Install** ✅ / ⬜
   - ☑ Contract signed
   - ☑ Location created in system
   - ☑ Machine assigned (shows serial #)
   - ☑ Planogram selected (shows template name)
   - ☑ Initial stock ordered
   - ☑ Install date scheduled: [date picker]

2. **Installation Day** ✅ / ⬜ (unlocks after Pre-Install complete)
   - ☑ Power verified at location
   - ☑ WiFi configured and tested
   - ☑ Machine physically placed
   - ☑ Machine leveled and stable
   - ☑ Machine powered on
   - ☑ SandStar cloud connected (shows status indicator)
   - ☑ Planogram loaded into machine
   - ☑ Products fully stocked
   - ☑ Test transaction completed
   - ☑ Client walkthrough done
   - ☑ Installation photos taken [upload button]

3. **Post-Install** ✅ / ⬜ (unlocks after Installation Day complete)
   - ☑ Client portal activated (shows portal link)
   - ☑ Route assigned (shows route name)
   - ☑ First service date scheduled

**Side Panel:**
- Lead/client info
- Location details
- Machine details
- Survey reference
- Contract reference

### 8.4 Initial Stock Logic

```javascript
function getInitialStock(planogram, locationData) {
  // Start with planogram's default products at max capacity
  const stockList = planogram.layout.map(slot => ({
    product_id: slot.product_id,
    slot_number: slot.slot,
    quantity: slot.par_level,  // full stock for launch
    product_name: slot.product_name
  }));
  
  // Adjust based on location type
  const locationAdjustments = {
    office: { increase: ['energy', 'snack', 'water'], decrease: ['candy'] },
    gym: { increase: ['water', 'protein_bar', 'energy'], decrease: ['candy', 'soda'] },
    hotel: { increase: ['water', 'snack', 'premium'], decrease: [] },
    apartment: { increase: ['beverage', 'snack'], decrease: [] },
    medical: { increase: ['water', 'healthy', 'snack'], decrease: ['energy'] }
  };
  
  return stockList;
}
```

### 8.5 Automations

| Trigger | Action |
|---------|--------|
| Lead status → "won" | Create onboarding checklist, create location from lead+survey, notify admin |
| Machine assigned to onboarding | Update machine status → "assigned" |
| Install date scheduled | Create calendar event, notify driver/installer |
| All Installation Day items checked | Auto-advance to Post-Install, update lead status → "machine_installed" |
| Test transaction successful | Log first sale, mark machine as "installed" and "online" |
| Client portal activated | Send welcome email to client with portal link (**language check: no "vending" in email**) |
| All checklist items complete | Move lead to "active" stage, start operations tracking |
| **Machine installed + 7 days** | 🎯 Task: "Make referral ask to [client]" (Skool: ask after they see the machine working) |
| **Machine installed + 30 days** | 📊 Auto-generate first month performance snapshot for client |
| Onboarding stalled > 7 days | Alert: "Onboarding stalled for [company]" |
| **Greystar property installed** | Verify NetVendor certification is current, flag if expiring within 90 days |

---

## 9. Stage 6: Operations — Day-to-Day

### 9.1 Database Tables
- `routes`, `route_runs`, `route_stops`
- `pick_lists`
- `inventory`, `inventory_transactions`
- `machines`, `machine_sales`, `machine_events`
- `vehicles`
- `products`, `planograms`

### 9.2 API Endpoints

#### Route Management
```
GET     /api/routes                       List all routes
GET     /api/routes/:id                   Get route with locations
POST    /api/routes                       Create route
PUT     /api/routes/:id                   Update route
POST    /api/routes/:id/optimize          Re-optimize stop order
POST    /api/routes/:id/add-location      Add location to route
DELETE  /api/routes/:id/locations/:lid     Remove location from route

-- Route Runs (daily execution)
GET     /api/route-runs                   List route runs (by date, driver)
GET     /api/route-runs/:id               Get run with all stops
POST    /api/route-runs                   Create run (schedule a route for a day)
PATCH   /api/route-runs/:id/start         Driver starts run
PATCH   /api/route-runs/:id/complete      Driver completes run

-- Route Stops
PATCH   /api/route-stops/:id/arrive       Driver arrives at stop
PATCH   /api/route-stops/:id/complete     Driver completes stop (with restock data)
PATCH   /api/route-stops/:id/skip         Driver skips stop (with reason)
POST    /api/route-stops/:id/photos       Upload stop photos
```

#### Scheduling
```
GET     /api/schedule                     Get full schedule (all routes, all drivers, date range)
GET     /api/schedule/today               Today's schedule
GET     /api/schedule/tomorrow            Tomorrow's schedule
POST    /api/schedule/generate            Auto-generate schedule for date range
GET     /api/schedule/drivers             Driver availability/assignments
POST    /api/schedule/assign              Assign driver to route run
```

#### Pick Lists (Packing)
```
GET     /api/pick-lists                   List pick lists (by date, packer, status)
GET     /api/pick-lists/:id               Get pick list with items
POST    /api/pick-lists/generate          Auto-generate from tomorrow's routes
PATCH   /api/pick-lists/:id/start         Packer starts picking
PATCH   /api/pick-lists/:id/complete      Packer completes picking
PATCH   /api/pick-lists/:id/verify        Verify picked items
POST    /api/pick-lists/:id/adjustments   Log discrepancies
```

#### Inventory
```
GET     /api/inventory                    Full inventory list with stock levels
GET     /api/inventory/:product_id        Single product stock info
PUT     /api/inventory/:product_id        Update stock levels
POST    /api/inventory/count              Submit inventory count
GET     /api/inventory/low-stock          Items below reorder point
GET     /api/inventory/reorder            Generate reorder list
POST    /api/inventory/receive            Receive new stock (from supplier)
GET     /api/inventory/transactions       Transaction history
```

#### Products
```
GET     /api/products                     List all products
GET     /api/products/:id                 Get product details + sales data
POST    /api/products                     Add product
PUT     /api/products/:id                 Update product
GET     /api/products/top-sellers         Top selling products (global or per-machine)
GET     /api/products/slow-movers         Slow moving products
```

#### Machine Monitoring
```
GET     /api/machines                     List all machines with status
GET     /api/machines/:id                 Machine detail (config, location, health)
GET     /api/machines/:id/sales           Sales data for machine (date range)
GET     /api/machines/:id/events          Events/errors for machine
GET     /api/machines/:id/health          Current health (temp, connectivity, last ping)
POST    /api/machines/:id/sync            Force sync with SandStar
GET     /api/machines/alerts              All machines with active alerts
GET     /api/machines/offline             All offline machines
```

#### Product Mix
```
GET     /api/product-mix/:machine_id          Current product mix + performance
POST    /api/product-mix/:machine_id/optimize  Generate optimized mix recommendation
PUT     /api/product-mix/:machine_id          Update machine's product mix
GET     /api/product-mix/recommendations      All machines with optimization recommendations
```

### 9.3 Dashboard Pages

#### `/operations` — Operations Hub (New Master Page)
> **Skool:** "Restocking + route efficiency is the #1 scaling bottleneck."  
> This page is designed around that truth. Revenue-per-route-hour is the north star metric.

**Sections:**

1. **Today's Operations Summary:**
   - Routes active / completed / remaining
   - Machines online / offline count
   - Today's revenue (running total from SandStar)
   - **Revenue per route-hour** (today vs 7-day avg) — Skool: THE scaling metric
   - Low stock alerts count
   - **Shrinkage alerts** (theft/vandalism incidents)
   - Active issues count

2. **Route Status Map:**
   - Map showing all active routes with driver locations
   - Color-coded stops: completed (green), current (blue), remaining (gray), skipped (red)
   - Click stop → details popup

3. **Quick Action Grid:**
   - "View Schedule" → `/schedule`
   - "Pack Lists" → `/packing`
   - "Inventory" → `/inventory`
   - "Machine Alerts" → `/fleet` (filtered)
   - "Route Builder" → `/routes`

#### `/schedule` — Schedule Manager (New)
**Calendar view (week by default):**

| Time | Monday | Tuesday | Wednesday | Thursday | Friday | Saturday |
|------|--------|---------|-----------|----------|--------|----------|
| AM | Henderson Loop (Driver A) | Strip North (Driver A) | Henderson Loop (Driver A) | ... | ... | ... |
| PM | Southwest (Driver B) | | Southwest (Driver B) | ... | ... | ... |

- Drag-drop route assignments
- Driver availability indicators (green/yellow/red)
- Unassigned routes highlighted
- "Generate Schedule" button → auto-assign based on route frequency + driver availability

#### `/routes` — Route Builder (New)
- Map view with all locations plotted
- Drag locations into route groups
- Auto-optimize button (sorts by geography)
- Route metrics: estimated time, distance, location count
- Frequency settings per route

#### `/routes/:id` — Route Detail
- Map with ordered stops
- Location list with last service date, stock level, revenue
- Assigned driver + vehicle
- History of past runs

#### `/packing` — Packer Dashboard (New)
**Designed for warehouse use — large text, clear layout:**

1. **Today's Pack Lists:**
   - Route name, delivery date, item count
   - Status: Not started / In progress / Packed / Loaded / Verified
   - Tap to open

2. **Pack List Detail:**
   - Product list sorted by warehouse zone (pick path optimization)
   - Each item: product image, name, quantity, location (shelf)
   - Checkbox to mark each item picked
   - Running total: X of Y items picked
   - "Complete" button when done

3. **Inventory Quick Check:**
   - Search product → see stock level
   - "Report Out of Stock" button

#### `/fleet` — Fleet Management (Enhanced)
**Existing page enhanced with:**

1. **Machine Grid:**
   - All machines with status icons (online/offline/error/maintenance)
   - Quick stats per machine: today's revenue, stock level, temperature
   - Filter: status, location, route
   - Sort: by revenue, by stock level, by last service

2. **Machine Detail Panel:**
   - Real-time data from SandStar
   - Sales chart (daily/weekly/monthly)
   - Temperature log
   - Connectivity history
   - Current planogram with stock levels per slot
   - Maintenance history
   - "Mark for Maintenance" button

3. **Fleet Alerts:**
   - Offline machines
   - Temperature out of range
   - Error codes
   - Low stock (< 25% capacity)
   - Machines not serviced in > X days

#### `/inventory` — Inventory Manager (New)
1. **Stock Overview:**
   - All products with current stock, reserved, available
   - Color coding: green (good), yellow (approaching reorder), red (below reorder)
   - Search and filter by category

2. **Low Stock Alerts:**
   - Products below reorder point
   - One-click "Create Purchase Order"

3. **Receiving:**
   - "Receive Shipment" form
   - Select supplier → scan/enter products and quantities
   - Auto-updates inventory

4. **Purchase Orders:**
   - Create PO from low stock list
   - Track PO status: ordered, shipped, received
   - Supplier management

#### `/product-mix` — Product Mix Optimizer (Enhanced)
**Existing page enhanced with:**

1. **Performance Matrix:**
   - Table: each machine × each product → sales velocity
   - Heatmap showing hot/cold products per machine

2. **Optimization Engine:**
   - Select machine → see current mix vs recommended
   - Recommendations based on: sales velocity, margin, category balance, seasonal trends
   - "Apply Recommendation" → updates planogram

3. **A/B Testing:**
   - Swap products in similar locations
   - Track performance difference
   - Auto-recommend winner after X days

### 9.4 Automations

> **Skool:** "Restocking + route efficiency is the #1 scaling bottleneck."  
> Every automation here exists to make routes tighter and restocks smarter.

| Trigger | Action |
|---------|--------|
| Schedule date approaching (T-1 day) | Generate pick lists for next day's routes |
| Pick list generated | Notify packer, reserve inventory |
| Pick list completed | Notify driver, update inventory |
| Route run started by driver | Update route status, notify admin |
| Route stop completed | Update inventory (deduct stocked items), log activity |
| **Route stop completed** | **Calculate time-at-stop** — flag if > 45 min (route efficiency tracking) |
| **Route completed** | **Calculate: revenue-per-route-hour** — the key scaling metric |
| Machine goes offline > 30 min | Alert: "Machine offline at [location]" |
| Machine temperature > 50°F | URGENT alert: "Temperature alarm at [location]" |
| Machine stock < 25% (from SandStar) | Flag for priority restock, **bump up in route priority** |
| Product sells out in < 2 days after restock | Flag: "Fast mover — increase par level for [product] at [location]" |
| Product doesn't sell in > 14 days | Flag: "Slow mover — swap [product] at [location]" (Skool: product mix optimization matters) |
| Inventory below reorder point | Auto-generate purchase order draft |
| Route not serviced in > frequency period + 2 days | Alert: "Overdue service at [locations]" |
| **Shrinkage detected** (units_stocked - units_sold > threshold) | 🔴 Alert: "Possible theft at [location] — [X] units missing" (Skool: track theft) |
| **Shrinkage > 5% at location for 2+ months** | ESCALATION: "Persistent shrinkage at [location] — consider camera requirement or removal" |
| **Revenue/route-hour drops below $50** | Alert: "Route [name] efficiency declining — review stop list" |
| **Location revenue < $1,500/month for 2 months** | ⚠️ "Location approaching $2K minimum threshold — review or negotiate exit" |
| Daily 6:00 AM | Generate today's route summary + pick lists if not already done |
| Daily 10:00 PM | Pull SandStar sales data, compute daily totals, **calculate shrinkage** |
| **Weekly Sunday 8 PM** | **Route optimization run** — re-sequence all routes by geography + sales velocity |

---

## 10. Stage 7: Client Management — Retention

### 10.1 Database Tables
- `leads` (now as "clients" — stage = "active")
- `contracts`
- `commissions`
- `locations`
- `machines` + `machine_sales`
- `notifications`

### 10.2 API Endpoints

```
-- Client Management
GET     /api/clients                      List active clients (leads with stage=active)
GET     /api/clients/:id                  Client detail (lead + locations + machines + financials)
GET     /api/clients/:id/performance      Performance metrics
GET     /api/clients/:id/report           Generate monthly performance report
POST    /api/clients/:id/report/send      Email report to client
GET     /api/clients/:id/revenue          Revenue breakdown

-- Client Portal
GET     /api/portal/dashboard             Client's dashboard data (authenticated by token)
GET     /api/portal/machines              Client's machines with live status
GET     /api/portal/sales                 Client's sales data
GET     /api/portal/commissions           Client's commission statements
GET     /api/portal/reports               Client's monthly reports

-- Commission Tracking
GET     /api/commissions                  All commissions (filterable by period, client, status)
POST    /api/commissions/calculate        Calculate commissions for a period
PATCH   /api/commissions/:id/approve      Approve commission
PATCH   /api/commissions/:id/pay          Mark commission as paid
GET     /api/commissions/pending          Pending payouts

-- Contract Renewals
GET     /api/contracts/expiring           Contracts expiring in next 90 days
POST    /api/contracts/:id/renew          Create renewal
```

### 10.3 Dashboard Pages

#### `/clients` — Client Management (New)
1. **Client List:**
   - Table: company name, locations, machines, monthly revenue, commission rate, contract end date, health status
   - Health status: 🟢 Active (good revenue), 🟡 At Risk (declining), 🔴 Churned
   - Sort by revenue, by contract end date, by health

2. **Client Health Scoring:**
   ```
   Health Score = weighted average of:
   - Revenue trend (30%): growing/stable/declining
   - Machine uptime (20%): % of time machines are online
   - Service issues (20%): complaint count, missed restocks
   - Communication (15%): response time, engagement
   - Contract timeline (15%): months remaining
   ```

3. **Referral Tracking** (Skool: "Introduce me to 3 other buildings"):
   - Referral leaderboard: which clients have given the most referrals
   - Referral pipeline: leads that came from referrals, their conversion status
   - "Referral ask pending" list: clients we haven't asked yet
   - Auto-reminder: ask for referrals 30 days post-install, then every 90 days

4. **Upsell Opportunities:**
   - Clients with high-performing single machines → suggest additional machines
   - Clients in expanding buildings → new locations
   - Cross-sell: WiFi hardware upgrades, premium product mix

5. **Shrinkage by Client** (Skool: track theft per location):
   - Monthly shrinkage report per location
   - Trend: is theft getting better or worse?
   - Action items: require cameras, adjust placement, escalate to client

#### `/client-portal` — Client Portal (Enhanced)
**What the client sees (redesigned):**

1. **Dashboard:**
   - Total revenue this month (their machines)
   - Commission earned this month
   - Machines online/offline status
   - Top selling products chart

2. **Machines:**
   - Each machine with location, status, today's revenue
   - Click → live sales data, stock levels, product performance

3. **Revenue & Commissions:**
   - Monthly revenue chart (line graph)
   - Commission statements list (downloadable PDF)
   - Year-to-date summary

4. **Reports:**
   - Monthly performance reports (auto-generated, downloadable)

5. **Support:**
   - Report an issue form
   - Contact Kande VendTech
   - FAQ

### 10.4 Monthly Report Template

Auto-generated PDF for each client:

```
KANDE VENDTECH — Monthly Performance Report
[Client Name] — [Month Year]

EXECUTIVE SUMMARY
• Total Revenue: $X,XXX (↑X% vs last month)
• Commission Earned: $XXX
• Top Product: [Product Name] (XX units sold)
• Machine Uptime: XX%

REVENUE BREAKDOWN
[Bar chart: daily revenue for the month]
[Table: revenue by machine if multiple]

TOP PRODUCTS
1. [Product] — XX units — $XXX revenue
2. [Product] — XX units — $XXX revenue
3. [Product] — XX units — $XXX revenue

MACHINE HEALTH
• Machine [serial]: Online XX% | Avg temp: XXF | X service visits
• Machine [serial]: ...

COMMISSION STATEMENT
Gross Revenue: $X,XXX
Commission Rate: XX%
Commission Due: $XXX
Payment Method: [method]
Payment Status: [status]

LOOKING AHEAD
[Any recommendations, upcoming changes, upsell suggestions]

REFERRAL PROGRAM
Know a property that could benefit from a premium smart market?
Introduce us to 3 properties and earn [X]% revenue share immediately.
Contact: [sales email] | [phone]
```

> **Language Note:** This report template must NEVER contain the word "vending."  
> Use "smart market", "smart cooler", "refreshment center" throughout.

### 10.5 Automations

| Trigger | Action |
|---------|--------|
| 1st of each month | Calculate previous month commissions for all clients |
| Commissions calculated | Notify admin for approval |
| Commissions approved | Generate commission statements, notify clients |
| Revenue drops > 20% month-over-month | Flag client as "at_risk", alert admin |
| **Revenue < $2K/month for any location** | 🔴 Alert: "Location below $2K threshold — review for removal or product mix change" |
| Machine offline > 24 hours at client location | Notify client via portal, urgent alert to admin |
| Contract 90 days from expiry | Start renewal process, notify admin |
| Contract 30 days from expiry | Urgent: "Contract expiring soon for [client]" |
| Client hasn't logged into portal in 60 days | Reminder: "Check in with [client]" |
| Monthly report generated | Auto-email to client + post to portal |
| **Client active 30 days, no referral ask** | 🎯 Task: "Ask [client] for 3 building referrals" (Skool: always ask) |
| **Client active 90 days, referral_count = 0** | Reminder: "Re-ask [client] for referrals — offer incentive?" |
| **Client provides referral** | Thank-you notification, update referral_count, **flag if 3+ referrals → start rev share immediately** |
| **Shrinkage > 5% at any client location** | Alert: "Theft concern at [client/location] — review with client" |
| **Client hitting $200K/year run rate** | 🏆 Milestone alert! (Skool: "10-15 machines in great spots = $200K/year") |

---

## 11. Stage 8: Financial — Money

### 11.1 Database Tables
- `machine_sales`
- `commissions`
- `expenses`
- `invoices`
- `inventory_transactions` (for COGS calculation)

### 11.2 API Endpoints

```
-- Revenue
GET     /api/financials/revenue                Revenue overview (filterable by period, location, route, machine)
GET     /api/financials/revenue/by-machine     Revenue grouped by machine
GET     /api/financials/revenue/by-location    Revenue grouped by location
GET     /api/financials/revenue/by-route       Revenue grouped by route
GET     /api/financials/revenue/by-product     Revenue grouped by product
GET     /api/financials/revenue/trends         Revenue trends (daily/weekly/monthly)

-- Costs
GET     /api/financials/expenses               Expense list (filterable)
POST    /api/financials/expenses               Log expense
GET     /api/financials/cogs                   COGS calculation for period
GET     /api/financials/expenses/by-category   Expenses by category

-- Profit & Loss
GET     /api/financials/pnl                    P&L statement (period)
GET     /api/financials/pnl/by-location        P&L per location
GET     /api/financials/pnl/by-route           P&L per route
GET     /api/financials/pnl/by-machine         P&L per machine

-- Invoicing
GET     /api/invoices                          List invoices
POST    /api/invoices                          Create invoice
GET     /api/invoices/:id                      Get invoice
POST    /api/invoices/:id/send                 Send invoice
PATCH   /api/invoices/:id/paid                 Mark as paid
GET     /api/invoices/:id/pdf                  Download PDF

-- Commission Payouts
GET     /api/financials/commission-summary      All commissions for period
GET     /api/financials/commission-forecast     Projected commissions (based on current month pace)
```

### 11.3 Dashboard Pages

#### `/financials` — Financial Dashboard (New)
**Admin only — the money page:**

1. **Revenue Overview (Top Banner):**
   ```
   Today: $XXX | This Week: $X,XXX | This Month: $XX,XXX | YTD: $XXX,XXX
   ```
   With comparison to previous period (▲/▼ indicators)

2. **Revenue Chart:**
   - Line chart: daily revenue (30 days default)
   - Toggle: daily / weekly / monthly
   - Overlay: expenses, commissions

3. **P&L Summary (This Month):**
   ```
   Revenue:       $XX,XXX
   - COGS:        -$X,XXX (XX%)
   - Shrinkage:   -$XXX (X.X%)     ← Skool: track every dollar lost to theft
   - Commissions: -$X,XXX (XX%)     ← Skool: 3-5% of gross
   - Labor:       -$X,XXX
   - Fuel:        -$XXX
   - Maintenance:  -$XXX
   - Other:       -$XXX
   ─────────────────────────
   Net Profit:    $X,XXX (XX%)
   
   KEY METRICS:
   Revenue/Machine/Month: $X,XXX    ← Target: $1,333+ (to hit $200K/yr on 15 machines)
   Revenue/Route-Hour:    $XXX      ← Skool: THE scaling efficiency metric
   Shrinkage Rate:        X.X%      ← Target: < 2%
   Locations Above $2K:   X/Y       ← Skool: 100% should be above $2K
   ```

4. **Location Profitability Table:**
   - Each location: revenue, COGS, commission, expenses, net profit, margin %
   - Sort by any column
   - Color code: green (profitable), red (losing money)

5. **Commission Payouts:**
   - Upcoming payouts with amounts
   - Approve / pay buttons

6. **Expense Tracker:**
   - Recent expenses list
   - "Add Expense" button
   - Category breakdown (pie chart)

7. **Cash Flow Forecast:**
   - Projected revenue (based on trailing averages)
   - Projected expenses (based on patterns)
   - Projected net (next 30/60/90 days)

#### `/financials/expenses` — Expense Log (New)
- Table of all expenses
- Filter by category, date range, location
- Add expense form with receipt upload
- Monthly totals by category

#### `/financials/invoices` — Invoice Manager (New)
- Invoice list with status
- Create invoice from template
- Send via email
- Track payment status

### 11.4 P&L Calculation Logic

```javascript
function calculatePnL(period, locationId = null) {
  const filters = { period };
  if (locationId) filters.location_id = locationId;
  
  // Revenue: sum of machine_sales
  const revenue = db.sum('total_revenue').from('machine_sales').where(filters);
  
  // COGS: cost of products sold (from restocking data)
  // For each product stocked, cost = quantity × product.cost_price
  const cogs = db.raw(`
    SELECT SUM(p.cost_price * rs.quantity) 
    FROM route_stop_products rs
    JOIN products p ON p.id = rs.product_id
    WHERE rs.created_at BETWEEN ? AND ?
  `, [period.start, period.end]);
  
  // Commissions: from commissions table
  const commissions = db.sum('commission_amount').from('commissions').where(filters);
  
  // Expenses: from expenses table, categorized
  const expenses = db.select('category').sum('amount as total')
    .from('expenses').where(filters).groupBy('category');
  
  // Shrinkage (Skool: track theft/vandalism losses)
  const shrinkage = db.sum('shrinkage_value').from('shrinkage_summary').where(filters);
  
  // Revenue per machine per month (Skool: "10-15 machines in great spots = $200K/year" → $1,111-$1,667/machine/month)
  const activeMachines = db.count('*').from('machines').where('status', 'installed');
  const revPerMachine = revenue / activeMachines;
  
  // Revenue per route hour (Skool: "#1 scaling bottleneck" metric)
  const totalRouteHours = db.raw(`
    SELECT SUM(TIMESTAMPDIFF(MINUTE, started_at, completed_at)) / 60.0
    FROM route_runs WHERE completed_at IS NOT NULL AND ${periodFilter}
  `);
  const revPerRouteHour = revenue / totalRouteHours;
  
  return {
    revenue,
    cogs,
    shrinkage,                                    // Skool: theft tracking
    gross_profit: revenue - cogs - shrinkage,
    gross_margin_pct: ((revenue - cogs - shrinkage) / revenue * 100),
    commissions,
    expenses,
    total_expenses: cogs + shrinkage + commissions + expenses.sum,
    net_profit: revenue - cogs - shrinkage - commissions - expenses.sum,
    net_margin_pct: ((revenue - cogs - shrinkage - commissions - expenses.sum) / revenue * 100),
    
    // Skool Key Metrics
    rev_per_machine_month: revPerMachine,          // Target: $1,333+ (for $200K/yr on 15 machines)
    rev_per_route_hour: revPerRouteHour,           // THE scaling metric
    shrinkage_pct: (shrinkage / revenue * 100),    // Target: < 2%
    active_machines: activeMachines,
    on_track_200k: (revPerMachine * activeMachines * 12 >= 200000)  // Are we on pace?
  };
}
```

### 11.5 Automations

| Trigger | Action |
|---------|--------|
| Daily midnight | Aggregate daily revenue from SandStar, update machine_sales, **calculate daily shrinkage** |
| Monthly 1st | Generate previous month P&L, create commission calculations, **aggregate shrinkage** |
| Expense > $500 logged | Notify admin for approval |
| Location net profit < $0 for 2 consecutive months | Alert: "Unprofitable location — review [location]" |
| **Location revenue < $2,000/month** | 🔴 ALERT: "Below $2K threshold at [location] — action required" (Skool: hard floor) |
| **Commission payout > 10% of gross** | ⚠️ Warning: "Commission rate above Skool max — verify contract" |
| Commission payout approved | Generate payment record, update status |
| Invoice overdue > 15 days | Alert + reminder email to client |
| Revenue anomaly (> 2 std dev from mean) | Alert: "Unusual revenue at [location] — verify" |
| **Monthly shrinkage > 3% at any location** | 🔴 Alert: "High shrinkage at [location] — investigate theft" |
| **Revenue/machine/month crosses $1,667** | 🏆 "Machine at [location] hitting premium performance!" |
| **Total fleet hits $200K annualized run rate** | 🎉 MILESTONE: "On track for $200K/year!" (Skool benchmark) |
| **Rev share payout calculated** | Log to commission table, **include referral bonus if applicable** |

---

## 12. Dashboard Navigation & Page Map

### 12.1 Navigation Restructure

**Current Sidebar → New Structure:**

```
┌─────────────────────────────────────┐
│ 🟠 KANDE VENDTECH                   │
│                                     │
│ 📊 Dashboard           /dashboard   │  ← NEW: unified home
│                                     │
│ ── SALES ──                         │
│ 👥 CRM                 /crm         │  ← ENHANCED (was /outreach crm)
│ 📧 Outreach             /outreach   │  ← ENHANCED
│ 📋 Surveys              /surveys    │  ← NEW
│ 📄 Proposals            /proposals  │  ← ENHANCED (was /proposal-generator)
│                                     │
│ ── OPERATIONS ──                    │
│ 🗓 Schedule              /schedule  │  ← NEW
│ 🚛 Routes                /routes    │  ← NEW
│ 📦 Packing              /packing    │  ← NEW
│ 🤖 Fleet                /fleet      │  ← ENHANCED
│ 📊 Product Mix          /product-mix│  ← ENHANCED
│ 🏭 Inventory            /inventory  │  ← NEW
│                                     │
│ ── CLIENTS ──                       │
│ 🏢 Clients              /clients    │  ← NEW
│ 🔑 Client Portal        /portal     │  ← ENHANCED
│ ✅ Onboarding           /onboarding │  ← NEW
│                                     │
│ ── FINANCIAL ──                     │
│ 💰 Financials           /financials │  ← NEW
│ 📑 Invoices             /invoices   │  ← NEW
│                                     │
│ ── MOBILE ──                        │
│ 🚗 Driver App           /driver     │  ← ENHANCED
│ 📦 Packer App           /packer     │  ← NEW
│                                     │
│ ── SYSTEM ──                        │
│ ⚙️ Settings             /settings   │  ← NEW
│ 👤 Users                /users      │  ← NEW
│ 📈 Reports              /reports    │  ← NEW
│ 🔔 Notifications        /notifications │ ← NEW
└─────────────────────────────────────┘
```

### 12.2 Unified Dashboard Home (`/dashboard`)

The "command center" that shows relevant info based on role:

**Admin Dashboard:**
```
┌─────────────────────────────────────────────────────────┐
│                  TODAY AT A GLANCE                       │
│                                                         │
│  💰 $XXX Revenue   🤖 X/Y Machines Online              │
│  📋 X Active Leads  🚛 X Routes Today                  │
│  ⚠️ X Alerts        📦 X Pick Lists Pending             │
│                                                         │
│  🎯 SKOOL BENCHMARKS:                                   │
│  Rev/Machine/Mo: $X,XXX (target: $1,333)               │
│  $200K Pace: $XXX,XXX annualized (X machines)           │
│  Shrinkage: X.X% (target: <2%)                          │
│  Outreach Touches Today: X (pop-ins: X)                 │
│                                                         │
├────────────────────┬────────────────────────────────────┤
│ PIPELINE           │ REVENUE (7 DAY)                    │
│ [mini kanban]      │ [line chart]                       │
│ 12 New             │                                    │
│ 8 Contacted        │                                    │
│ 3 Qualified        │                                    │
│ 2 Proposal Sent    │                                    │
│ 1 Negotiating      │                                    │
├────────────────────┼────────────────────────────────────┤
│ ALERTS             │ TOP MACHINES (Revenue)             │
│ 🔴 Machine offline │ 1. Hughes Center    $XX/day       │
│ 🟡 Low stock x3    │ 2. Green Valley     $XX/day       │
│ 🟡 Overdue service │ 3. Gramercy Lobby   $XX/day       │
│ 🔵 Contract expiry │ 4. ...                             │
├────────────────────┴────────────────────────────────────┤
│ UPCOMING                                                │
│ 📞 Follow up: Hughes Center (today 2pm)                 │
│ 🤝 Meeting: Dr. Smith office (tomorrow 10am)            │
│ 📦 Pick list due: Henderson Loop (today)                │
│ 🔧 Maintenance: Machine KVT-M-003 (Friday)             │
└─────────────────────────────────────────────────────────┘
```

### 12.3 Page Flow Connections

```
Lead Discovery → CRM
       ↓
Outreach → CRM (status updates)
       ↓
Survey → CRM (qualification) → Survey Detail
       ↓
Proposal → CRM (proposal_sent) → Proposal Detail
       ↓
Won → Onboarding Checklist
       ↓
Machine Install → Fleet (machine assigned) + Locations (created)
       ↓
Route Assignment → Routes + Schedule
       ↓
Daily Operations → Driver App + Packer App + Inventory
       ↓
Machine Data → Fleet + Product Mix + Client Portal
       ↓
Financial → Financials + Commissions + Invoices
       ↓
Client Retention → Clients + Client Portal + Reports
```

---

## 13. Notification System

### 13.1 Notification Types

| Type | Urgency | Channels | Example |
|------|---------|----------|---------|
| **URGENT** | Immediate | Web + SMS + Email | Machine offline, temperature alarm |
| **ALERT** | High | Web + Email | Low stock, overdue service |
| **REMINDER** | Medium | Web | Follow up due, pick list pending |
| **INFO** | Low | Web | Report generated, commission calculated |

### 13.2 Notification Rules

```javascript
const notificationRules = [
  // Machine Alerts
  { event: 'machine_offline', delay: '30m', type: 'urgent', 
    recipients: ['admin'], channels: ['web', 'sms'] },
  { event: 'machine_temp_high', delay: '0', type: 'urgent',
    recipients: ['admin'], channels: ['web', 'sms', 'email'] },
  { event: 'machine_error', delay: '5m', type: 'alert',
    recipients: ['admin'], channels: ['web', 'email'] },
  
  // Inventory
  { event: 'stock_below_reorder', delay: '0', type: 'alert',
    recipients: ['admin', 'packer'], channels: ['web'] },
  { event: 'stock_zero', delay: '0', type: 'urgent',
    recipients: ['admin'], channels: ['web', 'email'] },
  
  // Sales Pipeline
  { event: 'lead_idle', threshold: '7d', type: 'reminder',
    recipients: ['assigned_user', 'admin'], channels: ['web'] },
  { event: 'proposal_not_viewed', threshold: '3d', type: 'reminder',
    recipients: ['admin'], channels: ['web'] },
  { event: 'contract_expiring', threshold: '90d', type: 'info',
    recipients: ['admin'], channels: ['web'] },
  { event: 'contract_expiring', threshold: '30d', type: 'alert',
    recipients: ['admin'], channels: ['web', 'email'] },
  
  // Operations
  { event: 'pick_list_ready', delay: '0', type: 'reminder',
    recipients: ['packer'], channels: ['web'] },
  { event: 'route_overdue', threshold: '2d', type: 'alert',
    recipients: ['admin', 'driver'], channels: ['web'] },
  
  // Financial
  { event: 'commission_calculated', delay: '0', type: 'info',
    recipients: ['admin'], channels: ['web'] },
  { event: 'invoice_overdue', threshold: '15d', type: 'alert',
    recipients: ['admin'], channels: ['web', 'email'] },
];
```

### 13.3 Notification Bell UI

```
🔔 (3)  ← badge count of unread
├─ 🔴 Machine offline: Hughes Center Lobby (5 min ago)
├─ 🟡 Low stock alert: 3 products below reorder point (1 hour ago)  
├─ 🔵 Commission report ready for June (2 hours ago)
├─ ✅ Route completed: Henderson Loop by Driver A (3 hours ago)
└─ See all notifications →
```

---

## 14. Mobile Interfaces (Driver & Packer)

### 14.1 Driver App (`/driver`)

**Design:** Full-screen mobile-first, large buttons, minimal scrolling per screen.

#### Screen 1: Today's Route
```
┌─────────────────────────────┐
│ 🚛 Today's Route             │
│ Henderson Loop               │
│ 5 stops • ~2.5 hours         │
│ Vehicle: Van 1               │
│                              │
│ [📍 START ROUTE]              │
│                              │
│ ── STOPS ──                  │
│                              │
│ 1. ✅ Hughes Center          │
│    Completed 9:15 AM         │
│                              │
│ 2. 🔵 Green Valley Center    │  ← current
│    [📍 NAVIGATE] [✅ ARRIVE]  │
│                              │
│ 3. ⬜ Sunset Medical         │
│ 4. ⬜ Henderson Apts         │
│ 5. ⬜ Galleria Mall          │
│                              │
│ [📋 PACK LIST] [📊 SUMMARY]  │
└─────────────────────────────┘
```

#### Screen 2: Stop Detail (after arriving)
```
┌─────────────────────────────┐
│ ← Back                      │
│ Green Valley Center          │
│ 2300 Corporate Circle        │
│ [📞 Call] [📍 Map]            │
│                              │
│ ACCESS: Front lobby, ask     │
│ receptionist for key card    │
│                              │
│ ── RESTOCK ──                │
│                              │
│ Machine: KVT-M-005           │
│ [Scan barcode to start]      │
│                              │
│ Slot 1: Coca-Cola 20oz       │
│   Current: 2  |  Add: [6]   │
│                              │
│ Slot 2: Monster Energy       │
│   Current: 0  |  Add: [8]   │
│                              │
│ Slot 3: Lay's Classic        │
│   Current: 5  |  Add: [3]   │
│                              │
│ ... (scrollable)             │
│                              │
│ ── ISSUES ──                 │
│ [ ] Machine needs cleaning   │
│ [ ] Machine error/issue      │
│ [ ] Damaged products removed │
│ [ ] ⚠️ Theft/tampering signs │
│ [ ] Vandalism damage         │
│ [📸 Take photo]              │
│                              │
│ Notes: ________________      │
│                              │
│ [✅ COMPLETE STOP]            │
└─────────────────────────────┘
```

#### Screen 3: Route Summary (end of day)
```
┌─────────────────────────────┐
│ ── ROUTE SUMMARY ──         │
│ Henderson Loop - June 15     │
│                              │
│ Stops: 5/5 completed         │
│ Time: 2h 47m                 │
│ Units stocked: 127           │
│ Issues reported: 1           │
│                              │
│ Start mileage: _______       │
│ End mileage: _______         │
│                              │
│ [✅ SUBMIT ROUTE]             │
└─────────────────────────────┘
```

### 14.2 Packer App (`/packer`)

```
┌─────────────────────────────┐
│ 📦 PACKER DASHBOARD          │
│ [Your Name] | Shift: AM      │
│                              │
│ ── TODAY'S PACK LISTS ──     │
│                              │
│ 🔴 Henderson Loop (Tomorrow) │
│    48 items • Not started    │
│    [START PICKING]           │
│                              │
│ 🟡 Strip North (Tomorrow)    │
│    32 items • Not started    │
│    [START PICKING]           │
│                              │
│ ✅ Southwest (Today)          │
│    41 items • Packed         │
│                              │
└─────────────────────────────┘
```

Pick list detail optimized for warehouse flow:

```
┌─────────────────────────────┐
│ ← Back                      │
│ HENDERSON LOOP PACK LIST     │
│ 12/48 items picked           │
│ [====----] 25%               │
│                              │
│ ── ZONE A (Beverages) ──    │
│                              │
│ ☑ Coca-Cola 20oz      x24   │
│   Shelf: A1-3                │
│                              │
│ ☑ Monster Energy 16oz x16   │
│   Shelf: A2-1                │
│                              │
│ ⬜ Dasani Water 20oz   x12  │
│   Shelf: A3-2                │
│                              │
│ ── ZONE B (Snacks) ──       │
│                              │
│ ⬜ Lay's Classic 1.5oz x8   │
│   Shelf: B1-4                │
│                              │
│ ⬜ Kind Bar Almond    x6    │
│   Shelf: B2-2                │
│                              │
│ ... (scrollable)             │
│                              │
│ [📸 Photo when done]         │
│ [⚠️ Report Issue]            │
│ [✅ COMPLETE PACKING]         │
└─────────────────────────────┘
```

---

## 15. Reporting & Analytics

### 15.1 Report Types

#### Operational Reports
| Report | Frequency | Audience | Auto-Generate |
|--------|-----------|----------|---------------|
| Daily Route Summary | Daily | Admin | ✅ |
| Weekly Operations Overview | Weekly (Mon) | Admin | ✅ |
| Inventory Status | Daily | Admin, Packer | ✅ |
| Machine Health Report | Daily | Admin | ✅ |
| Driver Performance | Weekly | Admin | ✅ |

#### Sales Reports
| Report | Frequency | Audience | Auto-Generate |
|--------|-----------|----------|---------------|
| Pipeline Summary | Weekly | Admin, Sales | ✅ |
| Outreach Metrics | Weekly | Admin, Sales | ✅ |
| Win/Loss Analysis | Monthly | Admin | ✅ |
| Lead Source Analysis | Monthly | Admin | ✅ |

#### Financial Reports
| Report | Frequency | Audience | Auto-Generate |
|--------|-----------|----------|---------------|
| Monthly P&L | Monthly | Admin | ✅ |
| Revenue by Location | Monthly | Admin | ✅ |
| Commission Statements | Monthly | Admin, Client | ✅ |
| Expense Report | Monthly | Admin | ✅ |
| Tax Summary (quarterly) | Quarterly | Admin | ✅ |

#### Client Reports
| Report | Frequency | Audience | Auto-Generate |
|--------|-----------|----------|---------------|
| Monthly Performance | Monthly | Client | ✅ |
| Machine Health Summary | Monthly | Client | ✅ |

### 15.2 Analytics Dashboard (`/reports`)

```
┌─────────────────────────────────────────────────────────┐
│ 📈 ANALYTICS                                            │
│                                                         │
│ [Revenue] [Operations] [Sales] [Inventory] [Custom]     │
│                                                         │
│ Date Range: [Last 30 days ▼] [Start] [End] [Apply]     │
│                                                         │
├───────────────────────────┬─────────────────────────────┤
│ Revenue Trend             │ Revenue by Location          │
│ [Line chart]              │ [Horizontal bar chart]       │
│                           │                             │
├───────────────────────────┤                             │
│ Revenue by Product Cat    │                             │
│ [Pie chart]               │                             │
├───────────────────────────┼─────────────────────────────┤
│ Key Metrics               │ Comparisons                 │
│ • Avg rev/machine: $XX    │ • vs Last Month: +X%        │
│ • Avg rev/location: $XXX  │ • vs Last Year: +X%         │
│ • Avg margin: XX%         │ • Best day: [date] $XXX     │
│ • Revenue/route-hour: $XX │ • Worst day: [date] $XX     │
├───────────────────────────┴─────────────────────────────┤
│ [📥 Export CSV]  [📄 Export PDF]  [📧 Email Report]      │
└─────────────────────────────────────────────────────────┘
```

### 15.3 API Endpoints

```
GET     /api/reports/revenue            Revenue analytics (supports groupBy, period params)
GET     /api/reports/operations         Operations metrics
GET     /api/reports/sales-pipeline     Pipeline analytics
GET     /api/reports/inventory          Inventory analytics
GET     /api/reports/drivers            Driver performance metrics
GET     /api/reports/products           Product performance analytics
GET     /api/reports/locations          Location comparison analytics
GET     /api/reports/custom             Custom report builder (accepts dimension + metrics + filters)

POST    /api/reports/generate           Generate a specific report type
GET     /api/reports/scheduled          List scheduled reports
POST    /api/reports/schedule           Schedule a recurring report
```

---

## 16. Automation Engine

### 16.1 Architecture

The automation engine is a lightweight event-driven system built into the Express server.

```javascript
// automation-engine.js

class AutomationEngine {
  constructor() {
    this.rules = [];
    this.timers = [];
  }
  
  // Register event-based automation
  on(event, condition, action) {
    this.rules.push({ event, condition, action });
  }
  
  // Register time-based automation
  schedule(cron, action) {
    this.timers.push({ cron, action });
  }
  
  // Fire an event (called from route handlers)
  async emit(event, data) {
    const matchingRules = this.rules.filter(r => r.event === event);
    for (const rule of matchingRules) {
      if (!rule.condition || rule.condition(data)) {
        await rule.action(data);
      }
    }
  }
}

// Usage in server.js:
const engine = new AutomationEngine();

// When lead status changes to "won"
engine.on('lead.status_changed', 
  (data) => data.newStatus === 'won',
  async (data) => {
    await createOnboardingChecklist(data.leadId);
    await createLocationFromLead(data.leadId);
    await notify('admin', `🎉 Deal won: ${data.companyName}`);
  }
);

// Daily at 6 AM: generate pick lists
engine.schedule('0 6 * * *', async () => {
  const tomorrowRoutes = await getTomorrowRoutes();
  for (const route of tomorrowRoutes) {
    await generatePickList(route.id);
  }
});

// Daily at 10 PM: sync SandStar sales
engine.schedule('0 22 * * *', async () => {
  await syncSandStarSales();
  await calculateDailyRevenue();
  await checkLowStockAlerts();
});

// Monthly on 1st at 8 AM: financial reports
engine.schedule('0 8 1 * *', async () => {
  await calculateMonthlyCommissions();
  await generateMonthlyReports();
  await generateClientReports();
});
```

### 16.2 Event Catalog

```
-- Lead Events
lead.created
lead.updated
lead.status_changed       { leadId, oldStatus, newStatus, companyName }
lead.stage_changed        { leadId, oldStage, newStage }
lead.assigned             { leadId, userId }
lead.idle                 { leadId, daysIdle, currentStatus }

-- Survey Events
survey.submitted          { surveyId, leadId, score }
survey.approved           { surveyId, leadId }
survey.rejected           { surveyId, leadId, reason }

-- Proposal Events
proposal.created          { proposalId, leadId }
proposal.sent             { proposalId, leadId, email }
proposal.viewed           { proposalId, leadId }
proposal.accepted         { proposalId, leadId }
proposal.rejected         { proposalId, leadId }

-- Onboarding Events
onboarding.started        { checklistId, leadId }
onboarding.item_completed { checklistId, item }
onboarding.completed      { checklistId, leadId, locationId }

-- Machine Events
machine.status_changed    { machineId, oldStatus, newStatus }
machine.offline           { machineId, locationId, duration }
machine.online            { machineId, locationId }
machine.temp_alert        { machineId, temperature, threshold }
machine.error             { machineId, errorCode, message }
machine.low_stock         { machineId, percentFull }

-- Route Events
route_run.started         { runId, routeId, driverId }
route_run.completed       { runId, stats }
route_stop.completed      { stopId, locationId, unitsStocked }
route_stop.skipped        { stopId, locationId, reason }

-- Inventory Events
inventory.low_stock       { productId, currentQty, reorderPoint }
inventory.out_of_stock    { productId }
inventory.received        { productId, quantity }

-- Financial Events
commission.calculated     { commissionId, clientId, amount }
commission.approved       { commissionId }
revenue.anomaly           { locationId, amount, expected, deviation }

-- Contract Events
contract.expiring         { contractId, clientId, daysRemaining }
contract.expired          { contractId, clientId }
contract.renewed          { contractId, clientId }

-- Referral Events (Skool: "Introduce me to 3 other buildings")
referral.asked            { clientId, leadId }
referral.received         { clientId, referredLeadId, referrerName }
referral.converted        { referredLeadId, originalReferrerId }

-- Pop-in Events (Skool: "90% of placements come from pop-ins")
popin.logged              { leadId, outcome, giftBasketLeft, metDM }
popin.dm_met              { leadId, dmName, dmTitle }
popin.sequence_milestone  { leadId, touchNumber, totalTouches }

-- Theft/Shrinkage Events (Skool: theft tracking)
shrinkage.detected        { locationId, machineId, unitsShort, estimatedValue }
shrinkage.high_alert      { locationId, shrinkagePct, monthsAboveThreshold }
vandalism.reported        { machineId, locationId, type, photoUrls }

-- Language Compliance (Skool: NEVER say "vending")
language.violation        { documentType, documentId, flaggedWord, context }

-- Skool Benchmark Events
benchmark.200k_pace       { annualizedRevenue, machineCount }
benchmark.location_below_2k { locationId, monthlyRevenue }
benchmark.rev_share_exceeded { contractId, rate, maxRecommended }
```

---

## 17. Integration Map

### 17.1 External Service Integrations

```
┌─────────────────────────────────────────────────────────────┐
│                    KANDE VENDTECH SYSTEM                     │
│                                                             │
│  ┌──────────┐     ┌──────────┐     ┌──────────┐           │
│  │ Apollo.io │     │Instantly │     │ SandStar │           │
│  │ (Leads)   │     │(Email)   │     │ (Machines)│           │
│  └─────┬────┘     └────┬─────┘     └────┬─────┘           │
│        │               │                │                   │
│        ▼               ▼                ▼                   │
│  ┌─────────────────────────────────────────────┐           │
│  │              API Layer (Express)              │           │
│  │  /api/apollo/*  /api/outreach/*  /api/machines/* │       │
│  └─────────────────────┬───────────────────────┘           │
│                        │                                    │
│                        ▼                                    │
│  ┌─────────────────────────────────────────────┐           │
│  │              Database (SQLite/PG)             │           │
│  └─────────────────────────────────────────────┘           │
│                        │                                    │
│        ┌───────────────┼───────────────┐                   │
│        ▼               ▼               ▼                   │
│  ┌──────────┐   ┌──────────┐   ┌──────────┐              │
│  │ DocuSign │   │ Google   │   │ Twilio   │              │
│  │ (E-Sign) │   │ Maps API │   │ (SMS)    │              │
│  └──────────┘   └──────────┘   └──────────┘              │
│                                                             │
│  ┌──────────┐   ┌──────────┐   ┌──────────┐              │
│  │ SendGrid │   │ Stripe   │   │ QuickBooks│              │
│  │ (Email)  │   │ (Payments│   │ (Acctg)  │              │
│  └──────────┘   └──────────┘   └──────────┘              │
└─────────────────────────────────────────────────────────────┘
```

### 17.2 Integration Priority

| Integration | Priority | Phase | Purpose |
|------------|----------|-------|---------|
| **Apollo.io** | ✅ EXISTS | 1 | Lead discovery & enrichment |
| **Instantly.ai** | ✅ EXISTS | 1 | Cold email campaigns |
| **SandStar API** | HIGH | 1 | Machine data, sales, monitoring |
| **Google Maps** | HIGH | 1 | Route optimization, geocoding |
| **SendGrid/SMTP** | HIGH | 1 | Transactional email (reports, notifications) |
| **DocuSign/PandaDoc** | MEDIUM | 2 | E-signatures on proposals |
| **Twilio** | MEDIUM | 2 | SMS notifications |
| **Stripe** | LOW | 3 | Commission payments, client billing |
| **QuickBooks** | LOW | 3 | Accounting sync |

### 17.3 SandStar API Integration (Critical Path)

```javascript
// sandstar-sync.js — core integration with SandStar cloud

class SandStarSync {
  constructor(apiKey, baseUrl) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }
  
  // Pull sales data for all machines
  async syncDailySales(date) {
    const machines = await db.select('*').from('machines')
      .whereNotNull('sandstar_device_id');
    
    for (const machine of machines) {
      const sales = await this.api.get(`/devices/${machine.sandstar_device_id}/sales`, {
        date: date,
        granularity: 'hourly'
      });
      
      await db('machine_sales').insert({
        machine_id: machine.id,
        location_id: machine.location_id,
        sale_date: date,
        total_transactions: sales.totalTransactions,
        total_revenue: sales.totalRevenue,
        total_items_sold: sales.totalItems,
        product_breakdown: JSON.stringify(sales.products),
        card_revenue: sales.cardRevenue,
        cash_revenue: sales.cashRevenue,
        mobile_revenue: sales.mobileRevenue
      });
    }
  }
  
  // Pull machine health/status
  async syncMachineStatus() {
    const machines = await db.select('*').from('machines')
      .whereNotNull('sandstar_device_id');
    
    for (const machine of machines) {
      const status = await this.api.get(`/devices/${machine.sandstar_device_id}/status`);
      
      await db('machines').update({
        online: status.online,
        last_ping: status.lastPing,
        // Update temperature, errors, etc.
      }).where('id', machine.id);
      
      // Check for alerts
      if (!status.online && machine.online) {
        automationEngine.emit('machine.offline', {
          machineId: machine.id,
          locationId: machine.location_id
        });
      }
      
      if (status.temperature > 50) {
        automationEngine.emit('machine.temp_alert', {
          machineId: machine.id,
          temperature: status.temperature,
          threshold: 50
        });
      }
    }
  }
  
  // Pull inventory levels from machine
  async syncMachineInventory(machineId) {
    const machine = await db('machines').where('id', machineId).first();
    const inventory = await this.api.get(`/devices/${machine.sandstar_device_id}/inventory`);
    
    // inventory returns per-slot quantities
    return inventory.slots.map(slot => ({
      slot_number: slot.number,
      product_sku: slot.productSku,
      current_quantity: slot.quantity,
      max_quantity: slot.capacity,
      percent_full: (slot.quantity / slot.capacity * 100).toFixed(0)
    }));
  }
}
```

---

## 18. Migration & Implementation Plan

### 18.1 Phase 1: Foundation (Weeks 1-3)
**Goal:** Database + CRM enhancement + basic pipeline

**Tasks:**
1. Set up database schema (SQLite for dev)
2. Create migration scripts
3. Enhance CRM with full lead management
4. Build lead detail view with activity timeline
5. Import existing Apollo prospect data
6. Connect existing Instantly integration
7. Build site survey mobile form
8. Implement location scoring algorithm

**Deliverables:**
- Full CRM with kanban pipeline
- Apollo import working
- Instantly campaign management
- Mobile site survey form
- Lead scoring

### 18.2 Phase 2: Close & Onboard (Weeks 4-6)
**Goal:** Proposal to installation pipeline

**Tasks:**
1. Build proposal generator with PDF output
2. Create proposal templates
3. Build onboarding checklist system
4. Machine assignment workflow
5. Location creation from lead+survey
6. Client portal (basic version)
7. Contract management

**Deliverables:**
- Auto-generated proposals with PDF
- Onboarding checklist workflow
- Basic client portal
- Contract tracking

### 18.3 Phase 3: Operations (Weeks 7-10)
**Goal:** Daily operations management

**Tasks:**
1. Route management + optimization
2. Driver mobile app
3. Pick list generation + packer app
4. Inventory management system
5. SandStar API integration (critical)
6. Machine monitoring dashboard
7. Schedule management
8. Product mix optimization engine

**Deliverables:**
- Route builder + optimizer
- Driver mobile app
- Packer mobile app
- Inventory management
- Machine monitoring with alerts
- Auto-generated pick lists

### 18.4 Phase 4: Money & Intelligence (Weeks 11-14)
**Goal:** Financial tracking + analytics + automation

**Tasks:**
1. Revenue tracking (SandStar data)
2. Expense tracking
3. P&L calculations (per location, route, machine)
4. Commission calculation + payouts
5. Invoice generation
6. Client monthly reports (auto)
7. Analytics dashboard
8. Full automation engine
9. Notification system
10. Enhanced client portal

**Deliverables:**
- Financial dashboard
- P&L by location
- Auto-calculated commissions
- Client monthly reports
- Full notification system
- Analytics & reporting

### 18.5 Phase 5: Polish & Scale (Weeks 15+)
**Goal:** Optimization, scale, integrations

**Tasks:**
1. PostgreSQL migration (for production scale)
2. E-signature integration
3. Route optimization with Google Maps
4. SMS notifications (Twilio)
5. QuickBooks sync
6. Performance optimization
7. Security audit + proper auth
8. Mobile PWA for driver/packer apps

**Deliverables:**
- Production-ready system
- All integrations live
- Mobile apps as PWAs
- Full security implementation

---

## Appendix A: Environment Variables

```bash
# Existing
INSTANTLY_API_KEY=           # Instantly.ai API key
APOLLO_API_KEY=              # Apollo.io API key

# New — Phase 1
DATABASE_URL=                # PostgreSQL connection (Railway provides this)
SESSION_SECRET=              # Express session secret
ADMIN_PASSWORD=              # Initial admin password

# New — Phase 3
SANDSTAR_API_KEY=            # SandStar cloud API key
SANDSTAR_BASE_URL=           # SandStar API endpoint
GOOGLE_MAPS_API_KEY=         # Route optimization + geocoding

# New — Phase 4
SENDGRID_API_KEY=            # Transactional email
TWILIO_SID=                  # SMS notifications
TWILIO_AUTH_TOKEN=
TWILIO_PHONE=

# New — Phase 5
DOCUSIGN_INTEGRATION_KEY=    # E-signature
DOCUSIGN_SECRET=
QUICKBOOKS_CLIENT_ID=        # Accounting sync
QUICKBOOKS_CLIENT_SECRET=
STRIPE_SECRET_KEY=           # Payments
```

## Appendix B: File Structure

```
kande-vendtech/
├── dashboard/
│   ├── server.js                    # Main Express server (append-only)
│   ├── package.json
│   ├── .env
│   │
│   ├── db/
│   │   ├── migrations/              # Knex migrations
│   │   │   ├── 001_create_leads.js
│   │   │   ├── 002_create_activities.js
│   │   │   ├── 003_create_surveys.js
│   │   │   ├── 004_create_proposals.js
│   │   │   ├── 005_create_machines.js
│   │   │   ├── 006_create_locations.js
│   │   │   ├── 007_create_routes.js
│   │   │   ├── 008_create_inventory.js
│   │   │   ├── 009_create_financials.js
│   │   │   └── 010_create_notifications.js
│   │   ├── seeds/                   # Seed data
│   │   │   ├── 01_products.js       # Product catalog
│   │   │   └── 02_planograms.js     # Default planograms
│   │   └── knexfile.js
│   │
│   ├── lib/
│   │   ├── automation-engine.js     # Event-based automation
│   │   ├── scoring.js               # Location scoring algorithm
│   │   ├── sandstar-sync.js         # SandStar API integration
│   │   ├── route-optimizer.js       # Route optimization
│   │   ├── report-generator.js      # PDF report generation
│   │   ├── notification-service.js  # Multi-channel notifications
│   │   ├── commission-calculator.js # Commission calculations
│   │   └── pick-list-generator.js   # Auto pick list generation
│   │
│   ├── routes/                      # Express route handlers
│   │   ├── leads.js
│   │   ├── activities.js
│   │   ├── surveys.js
│   │   ├── proposals.js
│   │   ├── contracts.js
│   │   ├── onboarding.js
│   │   ├── machines.js
│   │   ├── locations.js
│   │   ├── routes.js
│   │   ├── schedule.js
│   │   ├── pick-lists.js
│   │   ├── inventory.js
│   │   ├── products.js
│   │   ├── financials.js
│   │   ├── reports.js
│   │   ├── notifications.js
│   │   ├── portal.js                # Client portal API
│   │   ├── apollo.js                # Apollo integration
│   │   ├── outreach.js              # Instantly integration
│   │   └── auth.js
│   │
│   ├── pages/                       # HTML pages
│   │   ├── dashboard.html           # Home dashboard
│   │   ├── crm.html                 # CRM pipeline
│   │   ├── crm-detail.html          # Lead detail
│   │   ├── outreach.html            # Outreach center
│   │   ├── surveys.html             # Survey list
│   │   ├── survey-form.html         # Mobile survey form
│   │   ├── proposals.html           # Proposal list
│   │   ├── proposal-generator.html  # Proposal builder
│   │   ├── onboarding.html          # Onboarding queue
│   │   ├── onboarding-detail.html   # Onboarding checklist
│   │   ├── schedule.html            # Schedule manager
│   │   ├── routes.html              # Route builder
│   │   ├── route-detail.html        # Route detail
│   │   ├── packing.html             # Packer dashboard
│   │   ├── fleet.html               # Fleet management
│   │   ├── inventory.html           # Inventory manager
│   │   ├── product-mix.html         # Product mix optimizer
│   │   ├── clients.html             # Client management
│   │   ├── client-portal.html       # Client portal
│   │   ├── financials.html          # Financial dashboard
│   │   ├── invoices.html            # Invoice manager
│   │   ├── reports.html             # Analytics & reports
│   │   ├── driver.html              # Driver mobile app
│   │   ├── packer.html              # Packer mobile app
│   │   ├── settings.html            # System settings
│   │   └── users.html               # User management
│   │
│   ├── templates/                   # PDF templates
│   │   ├── proposal.html            # Proposal PDF template
│   │   ├── monthly-report.html      # Client monthly report
│   │   ├── commission-statement.html
│   │   └── invoice.html
│   │
│   ├── public/                      # Static assets
│   │   ├── css/
│   │   │   ├── main.css
│   │   │   ├── mobile.css           # Mobile-specific styles
│   │   │   └── components.css
│   │   ├── js/
│   │   │   ├── app.js               # Shared app logic
│   │   │   ├── charts.js            # Chart.js helpers
│   │   │   ├── maps.js              # Google Maps helpers
│   │   │   └── notifications.js     # Notification UI
│   │   └── img/
│   │       ├── logo.png
│   │       └── machine-types/
│   │
│   └── uploads/                     # User uploads
│       ├── survey-photos/
│       ├── install-photos/
│       ├── receipts/
│       └── documents/
│
├── docs/
│   ├── lifecycle-system-spec.md     # THIS FILE
│   └── outreach-integration.md      # Existing
│
└── sales/
    └── prospects/                   # Existing Apollo data
        ├── apollo-commercial.json
        ├── apollo-apartments.json
        └── apollo-healthcare.json
```

## Appendix C: Quick Reference — All API Endpoints

```
LEADS           GET/POST   /api/leads
                GET/PUT/DEL /api/leads/:id
                PATCH      /api/leads/:id/status
                POST       /api/leads/bulk
                POST       /api/leads/:id/contacts
                POST       /api/leads/:id/activities
                POST       /api/leads/:id/tags

APOLLO          POST       /api/apollo/search
                POST       /api/apollo/enrich
                POST       /api/apollo/import

OUTREACH        GET/POST   /api/outreach/campaigns
                GET        /api/outreach/campaigns/:id
                POST       /api/outreach/campaigns/:id/leads
                POST       /api/outreach/campaigns/:id/activate
                POST       /api/outreach/calls
                POST       /api/outreach/visits
                GET        /api/outreach/warmup

SURVEYS         GET/POST   /api/surveys
                GET/PUT    /api/surveys/:id
                PATCH      /api/surveys/:id/approve
                PATCH      /api/surveys/:id/reject
                POST       /api/surveys/:id/photos

PROPOSALS       GET/POST   /api/proposals
                GET/PUT    /api/proposals/:id
                POST       /api/proposals/:id/generate-pdf
                POST       /api/proposals/:id/send
                POST       /api/proposals/:id/esign
                POST       /api/proposals/auto-generate

CONTRACTS       GET/POST   /api/contracts
                GET/PUT    /api/contracts/:id
                PATCH      /api/contracts/:id/terminate
                POST       /api/contracts/:id/renew

ONBOARDING      GET/POST   /api/onboarding
                GET/PUT    /api/onboarding/:id
                PATCH      /api/onboarding/:id/item
                POST       /api/onboarding/:id/complete
                POST       /api/onboarding/:id/assign-machine
                POST       /api/onboarding/:id/create-location
                POST       /api/onboarding/:id/activate-portal

MACHINES        GET        /api/machines
                GET        /api/machines/:id
                GET        /api/machines/:id/sales
                GET        /api/machines/:id/events
                GET        /api/machines/:id/health
                GET        /api/machines/available
                GET        /api/machines/alerts

LOCATIONS       GET/POST   /api/locations
                GET/PUT    /api/locations/:id

ROUTES          GET/POST   /api/routes
                GET/PUT    /api/routes/:id
                POST       /api/routes/:id/optimize
                POST       /api/routes/:id/add-location

ROUTE RUNS      GET/POST   /api/route-runs
                GET        /api/route-runs/:id
                PATCH      /api/route-runs/:id/start
                PATCH      /api/route-runs/:id/complete

ROUTE STOPS     PATCH      /api/route-stops/:id/arrive
                PATCH      /api/route-stops/:id/complete
                PATCH      /api/route-stops/:id/skip

SCHEDULE        GET        /api/schedule
                GET        /api/schedule/today
                POST       /api/schedule/generate
                POST       /api/schedule/assign

PICK LISTS      GET/POST   /api/pick-lists
                GET        /api/pick-lists/:id
                POST       /api/pick-lists/generate
                PATCH      /api/pick-lists/:id/start
                PATCH      /api/pick-lists/:id/complete

INVENTORY       GET        /api/inventory
                GET/PUT    /api/inventory/:product_id
                POST       /api/inventory/count
                GET        /api/inventory/low-stock
                POST       /api/inventory/receive

PRODUCTS        GET/POST   /api/products
                GET/PUT    /api/products/:id
                GET        /api/products/top-sellers

PRODUCT MIX     GET        /api/product-mix/:machine_id
                POST       /api/product-mix/:machine_id/optimize
                PUT        /api/product-mix/:machine_id

CLIENTS         GET        /api/clients
                GET        /api/clients/:id
                GET        /api/clients/:id/performance
                GET        /api/clients/:id/report
                POST       /api/clients/:id/report/send

CLIENT PORTAL   GET        /api/portal/dashboard
                GET        /api/portal/machines
                GET        /api/portal/sales
                GET        /api/portal/commissions

FINANCIALS      GET        /api/financials/revenue
                GET        /api/financials/revenue/by-machine
                GET        /api/financials/revenue/by-location
                GET        /api/financials/expenses
                POST       /api/financials/expenses
                GET        /api/financials/pnl
                GET        /api/financials/pnl/by-location
                GET        /api/financials/commission-summary

COMMISSIONS     GET/POST   /api/commissions
                POST       /api/commissions/calculate
                PATCH      /api/commissions/:id/approve
                PATCH      /api/commissions/:id/pay

INVOICES        GET/POST   /api/invoices
                GET        /api/invoices/:id
                POST       /api/invoices/:id/send
                PATCH      /api/invoices/:id/paid

REPORTS         GET        /api/reports/revenue
                GET        /api/reports/operations
                GET        /api/reports/sales-pipeline
                POST       /api/reports/generate

NOTIFICATIONS   GET        /api/notifications
                PATCH      /api/notifications/:id/read
                PATCH      /api/notifications/read-all

AUTH            POST       /api/auth/login
                POST       /api/auth/logout
                GET        /api/auth/me

USERS           GET/POST   /api/users
                GET/PUT    /api/users/:id
```

---

*This specification is the master blueprint for Kande VendTech's complete business management system. Implementation follows the phased approach in Section 18. Each phase is independently valuable — the system works at every stage of buildout.*
