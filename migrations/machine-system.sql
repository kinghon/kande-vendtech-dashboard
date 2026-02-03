-- ============================================================
-- Kande VendTech — Machine Management System Migration
-- Version: 1.0
-- Date: July 2025
-- Run: psql $DATABASE_URL -f migrations/machine-system.sql
-- ============================================================

BEGIN;

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- MACHINES (enhanced fleet table)
-- ============================================================
CREATE TABLE IF NOT EXISTS machines (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            VARCHAR(100) NOT NULL,
  serial_number   VARCHAR(100) UNIQUE,
  model           VARCHAR(50) DEFAULT 'SandStar AI Smart Cooler',
  asset_cost      DECIMAL(10,2) DEFAULT 3600.00,

  -- Location
  location_name   VARCHAR(200),
  location_type   VARCHAR(30),
  address         TEXT,
  lat             DECIMAL(10,7),
  lng             DECIMAL(10,7),
  zone_name       VARCHAR(100),

  -- Physical Config
  total_slots     INTEGER NOT NULL DEFAULT 60,
  slot_rows       INTEGER DEFAULT 6,
  slot_cols       INTEGER DEFAULT 10,
  has_cashless    BOOLEAN DEFAULT TRUE,
  connectivity    VARCHAR(20) DEFAULT 'cellular',

  -- Status: staged → active → maintenance → pulled
  status          VARCHAR(20) DEFAULT 'staged',
  installed_at    TIMESTAMPTZ,
  pulled_at       TIMESTAMPTZ,
  pull_reason     TEXT,
  last_online_at  TIMESTAMPTZ,

  -- Financial
  monthly_rev_target  DECIMAL(10,2) DEFAULT 2000.00,
  rev_share_pct       DECIMAL(5,2) DEFAULT 0,
  rev_share_start     DATE,

  -- Pricing
  pricing_profile_id  UUID,

  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_machines_status ON machines(status);
CREATE INDEX IF NOT EXISTS idx_machines_location_type ON machines(location_type);

-- ============================================================
-- PRODUCTS (enhanced catalog)
-- ============================================================
CREATE TABLE IF NOT EXISTS products (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            VARCHAR(200) NOT NULL,
  brand           VARCHAR(100),
  size            VARCHAR(50),
  upc             VARCHAR(20) UNIQUE,
  category        VARCHAR(30) NOT NULL,

  case_price      DECIMAL(8,2),
  units_per_case  INTEGER,
  unit_cost       DECIMAL(6,2),
  default_price   DECIMAL(6,2) NOT NULL,
  min_price       DECIMAL(6,2),
  max_price       DECIMAL(6,2),

  popularity      INTEGER DEFAULT 50,
  image_url       TEXT,
  is_premium      BOOLEAN DEFAULT FALSE,
  bundle_eligible BOOLEAN DEFAULT TRUE,
  shelf_life_days INTEGER,
  is_active       BOOLEAN DEFAULT TRUE,

  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);
CREATE INDEX IF NOT EXISTS idx_products_upc ON products(upc);
CREATE INDEX IF NOT EXISTS idx_products_active ON products(is_active) WHERE is_active = TRUE;

-- ============================================================
-- MACHINE SLOTS (60 per machine, 6×10 grid)
-- ============================================================
CREATE TABLE IF NOT EXISTS machine_slots (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  machine_id      UUID NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  slot_number     INTEGER NOT NULL,
  row_position    INTEGER NOT NULL,
  col_position    INTEGER NOT NULL,

  product_id      UUID REFERENCES products(id) ON DELETE SET NULL,

  max_capacity    INTEGER NOT NULL DEFAULT 8,
  current_qty     INTEGER NOT NULL DEFAULT 0,
  par_level       INTEGER NOT NULL DEFAULT 3,
  low_threshold   INTEGER NOT NULL DEFAULT 2,

  earliest_expiry DATE,
  price_override  DECIMAL(6,2),

  total_sold      INTEGER DEFAULT 0,
  total_revenue   DECIMAL(10,2) DEFAULT 0,
  last_sold_at    TIMESTAMPTZ,
  avg_daily_velocity DECIMAL(6,2) DEFAULT 0,

  is_eye_level    BOOLEAN GENERATED ALWAYS AS (
    row_position = 3 OR row_position = 4
  ) STORED,
  is_impulse_zone BOOLEAN GENERATED ALWAYS AS (
    col_position >= 9
  ) STORED,
  position_tier   VARCHAR(10) GENERATED ALWAYS AS (
    CASE
      WHEN row_position IN (3, 4) THEN 'premium'
      WHEN row_position IN (2, 5) THEN 'standard'
      ELSE 'value'
    END
  ) STORED,

  experiment_id   UUID,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(machine_id, slot_number),
  UNIQUE(machine_id, row_position, col_position)
);

CREATE INDEX IF NOT EXISTS idx_slots_machine ON machine_slots(machine_id);
CREATE INDEX IF NOT EXISTS idx_slots_product ON machine_slots(product_id);
CREATE INDEX IF NOT EXISTS idx_slots_low_stock ON machine_slots(machine_id, current_qty) WHERE current_qty <= 2;
CREATE INDEX IF NOT EXISTS idx_slots_position ON machine_slots(machine_id, row_position, col_position);

-- ============================================================
-- INVENTORY LOGS (every quantity change)
-- ============================================================
CREATE TABLE IF NOT EXISTS inventory_logs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slot_id         UUID NOT NULL REFERENCES machine_slots(id) ON DELETE CASCADE,
  machine_id      UUID NOT NULL REFERENCES machines(id),
  product_id      UUID REFERENCES products(id),

  change_type     VARCHAR(20) NOT NULL,
  -- sale, restock, expired_pull, shrinkage, adjustment, swap_out, swap_in
  qty_before      INTEGER NOT NULL,
  qty_change      INTEGER NOT NULL,
  qty_after       INTEGER NOT NULL,

  restock_event_id UUID,
  transaction_id   UUID,
  reason          TEXT,
  performed_by    VARCHAR(100),
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_inv_logs_slot ON inventory_logs(slot_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inv_logs_machine ON inventory_logs(machine_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inv_logs_type ON inventory_logs(change_type);

-- ============================================================
-- RESTOCK EVENTS
-- ============================================================
CREATE TABLE IF NOT EXISTS restock_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  machine_id      UUID NOT NULL REFERENCES machines(id),
  driver_name     VARCHAR(100),

  started_at      TIMESTAMPTZ NOT NULL,
  completed_at    TIMESTAMPTZ,
  duration_min    INTEGER,

  slots_serviced  INTEGER DEFAULT 0,
  items_loaded    INTEGER DEFAULT 0,
  items_pulled    INTEGER DEFAULT 0,
  product_cost    DECIMAL(8,2) DEFAULT 0,
  mileage         DECIMAL(6,1),
  fuel_cost       DECIMAL(6,2),
  labor_cost      DECIMAL(6,2) DEFAULT 20.00,

  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_restocks_machine ON restock_events(machine_id, started_at DESC);

-- ============================================================
-- PRICING PROFILES (per location type)
-- ============================================================
CREATE TABLE IF NOT EXISTS pricing_profiles (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            VARCHAR(100) NOT NULL,
  location_type   VARCHAR(30) NOT NULL,

  beverage_mult   DECIMAL(4,2) DEFAULT 1.00,
  snack_mult      DECIMAL(4,2) DEFAULT 1.00,
  candy_mult      DECIMAL(4,2) DEFAULT 1.00,
  incidental_mult DECIMAL(4,2) DEFAULT 1.00,

  price_overrides JSONB DEFAULT '{}',
  min_margin_pct  DECIMAL(5,2) DEFAULT 66.0,
  round_to        DECIMAL(3,2) DEFAULT 0.25,

  is_default      BOOLEAN DEFAULT FALSE,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pricing_profiles_type ON pricing_profiles(location_type);

-- Add FK from machines to pricing_profiles
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_machines_pricing_profile') THEN
    ALTER TABLE machines ADD CONSTRAINT fk_machines_pricing_profile
      FOREIGN KEY (pricing_profile_id) REFERENCES pricing_profiles(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ============================================================
-- PRICING RULES (per-machine advanced rules)
-- ============================================================
CREATE TABLE IF NOT EXISTS pricing_rules (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  machine_id      UUID REFERENCES machines(id) ON DELETE CASCADE,
  product_id      UUID REFERENCES products(id) ON DELETE CASCADE,

  rule_type       VARCHAR(30) NOT NULL,
  -- time_of_day, day_of_week, demand_surge, clearance, experiment
  conditions      JSONB NOT NULL,
  price_adjustment DECIMAL(6,2),
  price_multiplier DECIMAL(4,2),

  priority        INTEGER DEFAULT 0,
  is_active       BOOLEAN DEFAULT TRUE,
  starts_at       TIMESTAMPTZ,
  ends_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pricing_rules_machine ON pricing_rules(machine_id) WHERE is_active = TRUE;

-- ============================================================
-- SALES TRANSACTIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS sales_transactions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  machine_id      UUID NOT NULL REFERENCES machines(id),
  slot_id         UUID REFERENCES machine_slots(id),
  product_id      UUID REFERENCES products(id),

  quantity        INTEGER DEFAULT 1,
  unit_price      DECIMAL(6,2) NOT NULL,
  total_price     DECIMAL(8,2) NOT NULL,
  unit_cost       DECIMAL(6,2),

  payment_method  VARCHAR(20) DEFAULT 'card',
  bundle_tx_id    UUID,
  location_type   VARCHAR(30),

  sold_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tx_machine_time ON sales_transactions(machine_id, sold_at DESC);
CREATE INDEX IF NOT EXISTS idx_tx_product ON sales_transactions(product_id, sold_at DESC);
CREATE INDEX IF NOT EXISTS idx_tx_slot ON sales_transactions(slot_id, sold_at DESC);

-- ============================================================
-- BUNDLES
-- ============================================================
CREATE TABLE IF NOT EXISTS bundles (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            VARCHAR(200) NOT NULL,
  description     TEXT,
  display_emoji   VARCHAR(10),

  items           JSONB NOT NULL,
  individual_total DECIMAL(8,2) NOT NULL,
  bundle_price     DECIMAL(8,2) NOT NULL,
  total_cogs       DECIMAL(8,2),

  time_start      TIME,
  time_end        TIME,
  location_types  TEXT[] DEFAULT '{}',
  machine_ids     UUID[],

  status          VARCHAR(20) DEFAULT 'draft',
  -- draft → active → paused → retired

  times_shown     INTEGER DEFAULT 0,
  times_purchased INTEGER DEFAULT 0,
  total_revenue   DECIMAL(10,2) DEFAULT 0,

  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bundles_status ON bundles(status) WHERE status = 'active';

-- ============================================================
-- BUNDLE ITEMS (denormalized for easy queries)
-- ============================================================
CREATE TABLE IF NOT EXISTS bundle_items (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bundle_id       UUID NOT NULL REFERENCES bundles(id) ON DELETE CASCADE,
  product_id      UUID NOT NULL REFERENCES products(id),
  quantity        INTEGER DEFAULT 1,
  role            VARCHAR(20) DEFAULT 'primary',
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bundle_items_bundle ON bundle_items(bundle_id);

-- ============================================================
-- SLOT PERFORMANCE (materialized daily)
-- ============================================================
CREATE TABLE IF NOT EXISTS slot_performance (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  machine_id      UUID NOT NULL REFERENCES machines(id),
  slot_id         UUID NOT NULL REFERENCES machine_slots(id),
  stat_date       DATE NOT NULL,

  units_sold      INTEGER DEFAULT 0,
  revenue         DECIMAL(10,2) DEFAULT 0,
  margin          DECIMAL(10,2) DEFAULT 0,
  velocity_per_day DECIMAL(6,2) DEFAULT 0,
  heat_score      INTEGER DEFAULT 0,

  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(slot_id, stat_date)
);

CREATE INDEX IF NOT EXISTS idx_slot_perf_machine ON slot_performance(machine_id, stat_date DESC);

-- ============================================================
-- A/B TESTS (experiments)
-- ============================================================
CREATE TABLE IF NOT EXISTS ab_tests (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            VARCHAR(200) NOT NULL,
  hypothesis      TEXT,
  machine_id      UUID NOT NULL REFERENCES machines(id),
  experiment_type VARCHAR(30) NOT NULL,
  -- slot_swap, price_test, product_test, decoy_test, bundle_test

  status          VARCHAR(20) DEFAULT 'draft',
  -- draft → running_a → running_b → analyzing → concluded

  variant_a       JSONB NOT NULL,
  variant_b       JSONB NOT NULL,

  started_at      TIMESTAMPTZ,
  swapped_at      TIMESTAMPTZ,
  concluded_at    TIMESTAMPTZ,
  min_duration_days INTEGER DEFAULT 14,

  variant_a_sales   INTEGER DEFAULT 0,
  variant_a_revenue DECIMAL(10,2) DEFAULT 0,
  variant_b_sales   INTEGER DEFAULT 0,
  variant_b_revenue DECIMAL(10,2) DEFAULT 0,

  winner            VARCHAR(1),
  confidence_pct    DECIMAL(5,2),
  revenue_lift      DECIMAL(8,2),
  revenue_lift_pct  DECIMAL(5,2),

  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ab_tests_machine ON ab_tests(machine_id);
CREATE INDEX IF NOT EXISTS idx_ab_tests_status ON ab_tests(status);

-- ============================================================
-- SHRINKAGE EVENTS
-- ============================================================
CREATE TABLE IF NOT EXISTS shrinkage_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  machine_id      UUID NOT NULL REFERENCES machines(id),
  slot_id         UUID REFERENCES machine_slots(id),
  product_id      UUID REFERENCES products(id),

  shrinkage_type  VARCHAR(30) NOT NULL,
  -- theft, vandalism, spoilage, system_error, damaged, miscount, unknown

  quantity        INTEGER NOT NULL,
  unit_cost       DECIMAL(6,2),
  total_loss      DECIMAL(8,2),

  detected_by     VARCHAR(30),
  evidence_url    TEXT,
  notes           TEXT,

  resolved        BOOLEAN DEFAULT FALSE,
  resolution      TEXT,
  occurred_at     TIMESTAMPTZ DEFAULT NOW(),
  resolved_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_shrinkage_machine ON shrinkage_events(machine_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_shrinkage_type ON shrinkage_events(shrinkage_type);
CREATE INDEX IF NOT EXISTS idx_shrinkage_unresolved ON shrinkage_events(machine_id) WHERE resolved = FALSE;

-- ============================================================
-- SEED: Default Pricing Profiles (from Skool community insights)
-- ============================================================
INSERT INTO pricing_profiles (name, location_type, beverage_mult, snack_mult, candy_mult, incidental_mult, is_default) VALUES
('Gym / Recreation Center', 'rec_center', 1.10, 0.95, 0.90, 1.20, TRUE),
('Hospital ER / Waiting', 'hospital_er', 1.05, 1.10, 1.10, 1.30, TRUE),
('Manufacturing / Warehouse', 'manufacturing', 1.00, 1.00, 1.00, 1.00, TRUE),
('Luxury Apartment (200+)', 'luxury_apt', 1.15, 1.10, 1.05, 1.40, TRUE),
('K-12 School', 'k12_school', 0.95, 1.00, 1.05, 0.80, TRUE),
('Large Office (100+)', 'office_large', 1.05, 1.05, 1.00, 1.15, TRUE),
('College / University', 'university', 0.95, 1.00, 1.05, 1.10, TRUE),
('Senior Living', 'senior_living', 1.00, 1.05, 1.10, 1.20, TRUE),
('Distribution Center', 'distribution_center', 1.00, 1.00, 1.00, 1.05, TRUE),
('Call Center', 'call_center', 1.05, 1.05, 1.05, 1.10, TRUE),
('Government Building', 'government', 1.00, 1.00, 1.00, 1.00, TRUE),
('Hotel (Back of House)', 'hotel', 1.10, 1.05, 1.00, 1.25, TRUE),
('Data Center', 'data_center', 1.05, 1.00, 1.00, 1.35, TRUE),
('Construction Staging', 'construction_yard', 0.95, 1.00, 1.00, 0.95, TRUE)
ON CONFLICT DO NOTHING;

COMMIT;
