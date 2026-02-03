-- =====================================================
-- Kande VendTech — Machine Management System Migration
-- Version: 2.0 (Complete schema from DESIGN.md)
-- Run: psql $DATABASE_URL -f migrations/machine-system.sql
-- =====================================================

BEGIN;

-- Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- LOCATIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS locations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            VARCHAR(200) NOT NULL,
  type            VARCHAR(30) NOT NULL,
  address         TEXT,
  city            VARCHAR(100),
  state           VARCHAR(2) DEFAULT 'NV',
  zip             VARCHAR(10),
  lat             DECIMAL(10,7),
  lng             DECIMAL(10,7),
  population      INTEGER,
  shift_count     INTEGER DEFAULT 1,
  operating_hours VARCHAR(20) DEFAULT '8-18',
  is_24_7         BOOLEAN DEFAULT FALSE,
  contact_name    VARCHAR(200),
  contact_phone   VARCHAR(20),
  contact_email   VARCHAR(200),
  property_mgmt   VARCHAR(200),
  requires_netvendor  BOOLEAN DEFAULT FALSE,
  vendor_approved     BOOLEAN DEFAULT FALSE,
  tier            INTEGER DEFAULT 2,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_locations_type ON locations(type);
CREATE INDEX IF NOT EXISTS idx_locations_tier ON locations(tier);

-- ============================================================
-- ZONES (Geographic Clusters)
-- ============================================================
CREATE TABLE IF NOT EXISTS zones (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            VARCHAR(100) NOT NULL,
  center_lat      DECIMAL(10,7),
  center_lng      DECIMAL(10,7),
  radius_miles    DECIMAL(5,2),
  max_machines    INTEGER DEFAULT 8,
  driver_id       UUID,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- PRICING PROFILES
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

-- ============================================================
-- MACHINES
-- ============================================================
CREATE TABLE IF NOT EXISTS machines (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            VARCHAR(100) NOT NULL,
  serial_number   VARCHAR(100) UNIQUE,
  model           VARCHAR(50) DEFAULT 'SandStar AI Smart Cooler',
  asset_cost      DECIMAL(10,2) DEFAULT 3600.00,
  location_id     UUID REFERENCES locations(id) ON DELETE SET NULL,
  location_type   VARCHAR(30),
  address         TEXT,
  lat             DECIMAL(10,7),
  lng             DECIMAL(10,7),
  zone_id         UUID REFERENCES zones(id) ON DELETE SET NULL,
  total_slots     INTEGER NOT NULL DEFAULT 60,
  slot_rows       INTEGER DEFAULT 6,
  slot_cols       INTEGER DEFAULT 10,
  has_cashless    BOOLEAN DEFAULT TRUE,
  connectivity    VARCHAR(20) DEFAULT 'cellular',
  status          VARCHAR(20) DEFAULT 'staged',
  installed_at    TIMESTAMPTZ,
  pulled_at       TIMESTAMPTZ,
  pull_reason     TEXT,
  last_online_at  TIMESTAMPTZ,
  monthly_rev_target  DECIMAL(10,2) DEFAULT 2000.00,
  rev_share_pct       DECIMAL(5,2) DEFAULT 0,
  rev_share_start     DATE,
  pricing_profile_id  UUID REFERENCES pricing_profiles(id) ON DELETE SET NULL,
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_machines_status ON machines(status);
CREATE INDEX IF NOT EXISTS idx_machines_zone ON machines(zone_id);
CREATE INDEX IF NOT EXISTS idx_machines_location_type ON machines(location_type);

-- ============================================================
-- PRODUCTS
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
-- SLOTS
-- ============================================================
CREATE TABLE IF NOT EXISTS slots (
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
  expiry_alert_days INTEGER DEFAULT 7,
  price_override  DECIMAL(6,2),
  total_sold      INTEGER DEFAULT 0,
  total_revenue   DECIMAL(10,2) DEFAULT 0,
  last_sold_at    TIMESTAMPTZ,
  avg_daily_velocity DECIMAL(6,2) DEFAULT 0,
  is_eye_level    BOOLEAN GENERATED ALWAYS AS (row_position = 3 OR row_position = 4) STORED,
  is_impulse_zone BOOLEAN GENERATED ALWAYS AS (col_position >= 9) STORED,
  position_tier   VARCHAR(10) GENERATED ALWAYS AS (
    CASE WHEN row_position IN (3, 4) THEN 'premium' WHEN row_position IN (2, 5) THEN 'standard' ELSE 'value' END
  ) STORED,
  experiment_id   UUID,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(machine_id, slot_number),
  UNIQUE(machine_id, row_position, col_position)
);
CREATE INDEX IF NOT EXISTS idx_slots_machine ON slots(machine_id);
CREATE INDEX IF NOT EXISTS idx_slots_product ON slots(product_id);
CREATE INDEX IF NOT EXISTS idx_slots_low_stock ON slots(machine_id, current_qty) WHERE current_qty <= 2;
CREATE INDEX IF NOT EXISTS idx_slots_empty ON slots(machine_id) WHERE current_qty = 0;

-- ============================================================
-- SLOT EXPIRY BATCHES
-- ============================================================
CREATE TABLE IF NOT EXISTS slot_expiry_batches (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slot_id         UUID NOT NULL REFERENCES slots(id) ON DELETE CASCADE,
  quantity        INTEGER NOT NULL,
  expiry_date     DATE NOT NULL,
  loaded_at       TIMESTAMPTZ DEFAULT NOW(),
  depleted_at     TIMESTAMPTZ,
  is_active       BOOLEAN DEFAULT TRUE,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_expiry_batches_slot ON slot_expiry_batches(slot_id) WHERE is_active = TRUE;

-- ============================================================
-- INVENTORY LOGS
-- ============================================================
CREATE TABLE IF NOT EXISTS inventory_logs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slot_id         UUID NOT NULL REFERENCES slots(id) ON DELETE CASCADE,
  machine_id      UUID NOT NULL REFERENCES machines(id),
  product_id      UUID REFERENCES products(id),
  change_type     VARCHAR(20) NOT NULL,
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

-- ============================================================
-- RESTOCK EVENTS
-- ============================================================
CREATE TABLE IF NOT EXISTS restock_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  machine_id      UUID NOT NULL REFERENCES machines(id),
  zone_id         UUID REFERENCES zones(id),
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
  total_cost      DECIMAL(8,2) GENERATED ALWAYS AS (
    COALESCE(product_cost, 0) + COALESCE(fuel_cost, 0) + COALESCE(labor_cost, 0)
  ) STORED,
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_restocks_machine ON restock_events(machine_id, started_at DESC);

-- ============================================================
-- RESTOCK ITEMS
-- ============================================================
CREATE TABLE IF NOT EXISTS restock_items (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restock_id      UUID NOT NULL REFERENCES restock_events(id) ON DELETE CASCADE,
  slot_id         UUID NOT NULL REFERENCES slots(id),
  product_id      UUID REFERENCES products(id),
  qty_before      INTEGER NOT NULL,
  qty_added       INTEGER NOT NULL DEFAULT 0,
  qty_removed     INTEGER NOT NULL DEFAULT 0,
  qty_after       INTEGER NOT NULL,
  unit_cost       DECIMAL(6,2),
  line_cost       DECIMAL(8,2) GENERATED ALWAYS AS (qty_added * COALESCE(unit_cost, 0)) STORED,
  expiry_date     DATE,
  was_empty       BOOLEAN GENERATED ALWAYS AS (qty_before = 0) STORED,
  had_expired     BOOLEAN GENERATED ALWAYS AS (qty_removed > 0) STORED,
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_restock_items_restock ON restock_items(restock_id);

-- ============================================================
-- TRANSACTIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS transactions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  machine_id      UUID NOT NULL REFERENCES machines(id),
  slot_id         UUID REFERENCES slots(id),
  product_id      UUID REFERENCES products(id),
  quantity        INTEGER DEFAULT 1,
  unit_price      DECIMAL(6,2) NOT NULL,
  total_price     DECIMAL(8,2) NOT NULL,
  unit_cost       DECIMAL(6,2),
  margin          DECIMAL(6,2) GENERATED ALWAYS AS (total_price - (COALESCE(unit_cost, 0) * quantity)) STORED,
  margin_pct      DECIMAL(5,2),
  payment_method  VARCHAR(20) DEFAULT 'card',
  bundle_tx_id    UUID,
  location_type   VARCHAR(30),
  zone_id         UUID,
  hour_of_day     SMALLINT GENERATED ALWAYS AS (EXTRACT(HOUR FROM sold_at)::SMALLINT) STORED,
  day_of_week     SMALLINT GENERATED ALWAYS AS (EXTRACT(DOW FROM sold_at)::SMALLINT) STORED,
  sold_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tx_machine_time ON transactions(machine_id, sold_at DESC);
CREATE INDEX IF NOT EXISTS idx_tx_product ON transactions(product_id, sold_at DESC);
CREATE INDEX IF NOT EXISTS idx_tx_slot ON transactions(slot_id, sold_at DESC);

-- ============================================================
-- DAILY MACHINE STATS
-- ============================================================
CREATE TABLE IF NOT EXISTS daily_machine_stats (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  machine_id      UUID NOT NULL REFERENCES machines(id),
  stat_date       DATE NOT NULL,
  transaction_count INTEGER DEFAULT 0,
  revenue         DECIMAL(10,2) DEFAULT 0,
  cogs            DECIMAL(10,2) DEFAULT 0,
  gross_margin    DECIMAL(10,2) DEFAULT 0,
  margin_pct      DECIMAL(5,2) DEFAULT 0,
  avg_ticket      DECIMAL(6,2) DEFAULT 0,
  unique_products_sold INTEGER DEFAULT 0,
  slots_empty     INTEGER DEFAULT 0,
  slots_low       INTEGER DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(machine_id, stat_date)
);
CREATE INDEX IF NOT EXISTS idx_daily_stats_machine ON daily_machine_stats(machine_id, stat_date DESC);

-- ============================================================
-- PRICING RULES
-- ============================================================
CREATE TABLE IF NOT EXISTS pricing_rules (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  machine_id      UUID REFERENCES machines(id) ON DELETE CASCADE,
  product_id      UUID REFERENCES products(id) ON DELETE CASCADE,
  rule_type       VARCHAR(30) NOT NULL,
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
-- EXPERIMENTS (A/B Tests)
-- ============================================================
CREATE TABLE IF NOT EXISTS experiments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            VARCHAR(200) NOT NULL,
  hypothesis      TEXT,
  machine_id      UUID NOT NULL REFERENCES machines(id),
  experiment_type VARCHAR(30) NOT NULL,
  status          VARCHAR(20) DEFAULT 'draft',
  variant_a       JSONB NOT NULL,
  variant_b       JSONB NOT NULL,
  started_at      TIMESTAMPTZ,
  concluded_at    TIMESTAMPTZ,
  variant_a_sales   INTEGER DEFAULT 0,
  variant_a_revenue DECIMAL(10,2) DEFAULT 0,
  variant_b_sales   INTEGER DEFAULT 0,
  variant_b_revenue DECIMAL(10,2) DEFAULT 0,
  winner            VARCHAR(1),
  confidence_pct    DECIMAL(5,2),
  revenue_lift_pct  DECIMAL(5,2),
  applied           BOOLEAN DEFAULT FALSE,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_experiments_machine ON experiments(machine_id);

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
  discount_pct     DECIMAL(5,2) GENERATED ALWAYS AS (
    CASE WHEN individual_total > 0 THEN ((individual_total - bundle_price) / individual_total) * 100 ELSE 0 END
  ) STORED,
  total_cogs       DECIMAL(8,2),
  time_start      TIME,
  time_end        TIME,
  days_of_week    SMALLINT[] DEFAULT '{0,1,2,3,4,5,6}',
  location_types  TEXT[] DEFAULT '{}',
  machine_ids     UUID[],
  screen_prompt   TEXT,
  status          VARCHAR(20) DEFAULT 'draft',
  times_shown     INTEGER DEFAULT 0,
  times_purchased INTEGER DEFAULT 0,
  total_revenue   DECIMAL(10,2) DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_bundles_status ON bundles(status) WHERE status = 'active';

-- ============================================================
-- SHRINKAGE EVENTS
-- ============================================================
CREATE TABLE IF NOT EXISTS shrinkage_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  machine_id      UUID NOT NULL REFERENCES machines(id),
  slot_id         UUID REFERENCES slots(id),
  product_id      UUID REFERENCES products(id),
  shrinkage_type  VARCHAR(30) NOT NULL,
  quantity        INTEGER NOT NULL,
  unit_cost       DECIMAL(6,2),
  total_loss      DECIMAL(8,2) GENERATED ALWAYS AS (quantity * COALESCE(unit_cost, 0)) STORED,
  detected_by     VARCHAR(30),
  notes           TEXT,
  resolved        BOOLEAN DEFAULT FALSE,
  resolution      TEXT,
  occurred_at     TIMESTAMPTZ DEFAULT NOW(),
  resolved_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_shrinkage_machine ON shrinkage_events(machine_id, occurred_at DESC);

-- ============================================================
-- VIEWS
-- ============================================================
CREATE OR REPLACE VIEW v_machine_health AS
SELECT m.id, m.name, m.status, m.location_type, m.zone_id, z.name AS zone_name, m.monthly_rev_target,
  COUNT(s.id) FILTER (WHERE s.current_qty = 0) AS empty_slots,
  COUNT(s.id) FILTER (WHERE s.current_qty > 0 AND s.current_qty <= s.low_threshold) AS low_slots,
  COUNT(s.id) FILTER (WHERE s.current_qty >= s.max_capacity * 0.75) AS full_slots,
  ROUND(AVG(s.current_qty::DECIMAL / NULLIF(s.max_capacity, 0)) * 100, 1) AS avg_fill_pct,
  COALESCE(rev.revenue_30d, 0) AS revenue_30d, COALESCE(rev.transactions_30d, 0) AS transactions_30d,
  CASE WHEN COALESCE(rev.revenue_30d, 0) < 800 THEN 'pull_candidate'
    WHEN COALESCE(rev.revenue_30d, 0) < 2000 THEN 'underperforming' ELSE 'on_target' END AS revenue_status
FROM machines m
LEFT JOIN zones z ON m.zone_id = z.id
LEFT JOIN slots s ON s.machine_id = m.id
LEFT JOIN LATERAL (SELECT SUM(t.total_price) AS revenue_30d, COUNT(*) AS transactions_30d
  FROM transactions t WHERE t.machine_id = m.id AND t.sold_at >= NOW() - INTERVAL '30 days') rev ON TRUE
WHERE m.status IN ('active', 'staged', 'maintenance')
GROUP BY m.id, m.name, m.status, m.location_type, m.zone_id, m.monthly_rev_target, z.name, rev.revenue_30d, rev.transactions_30d;

CREATE OR REPLACE VIEW v_slot_performance AS
SELECT s.id AS slot_id, s.machine_id, s.slot_number, s.row_position, s.col_position, s.position_tier,
  s.is_eye_level, s.is_impulse_zone, p.name AS product_name, p.category, s.current_qty, s.max_capacity,
  s.price_override, p.default_price, COALESCE(perf.units_sold_30d, 0) AS units_sold_30d,
  COALESCE(perf.revenue_30d, 0) AS revenue_30d, COALESCE(perf.margin_30d, 0) AS margin_30d,
  COALESCE(perf.velocity_per_day, 0) AS velocity_per_day,
  CASE WHEN machine_avg.avg_revenue > 0 THEN LEAST(100, GREATEST(0,
    (COALESCE(perf.revenue_30d, 0) / NULLIF(machine_avg.avg_revenue, 0)) * 40 +
    (COALESCE(perf.margin_30d, 0) / NULLIF(machine_avg.avg_margin, 0)) * 35 +
    (COALESCE(perf.velocity_per_day, 0) / NULLIF(machine_avg.avg_velocity, 0)) * 25
  )) ELSE 0 END AS heat_score
FROM slots s
LEFT JOIN products p ON s.product_id = p.id
LEFT JOIN LATERAL (SELECT COUNT(*) AS units_sold_30d, SUM(t.total_price) AS revenue_30d, SUM(t.margin) AS margin_30d, COUNT(*)::DECIMAL / 30 AS velocity_per_day
  FROM transactions t WHERE t.slot_id = s.id AND t.sold_at >= NOW() - INTERVAL '30 days') perf ON TRUE
LEFT JOIN LATERAL (SELECT AVG(sub.revenue) AS avg_revenue, AVG(sub.margin) AS avg_margin, AVG(sub.velocity) AS avg_velocity FROM (
  SELECT COALESCE(SUM(t2.total_price), 0) AS revenue, COALESCE(SUM(t2.margin), 0) AS margin, COUNT(*)::DECIMAL / 30 AS velocity
  FROM slots s2 LEFT JOIN transactions t2 ON t2.slot_id = s2.id AND t2.sold_at >= NOW() - INTERVAL '30 days'
  WHERE s2.machine_id = s.machine_id GROUP BY s2.id) sub) machine_avg ON TRUE;

-- ============================================================
-- FUNCTIONS
-- ============================================================
CREATE OR REPLACE FUNCTION calculate_price(p_machine_id UUID, p_product_id UUID, p_slot_id UUID DEFAULT NULL) RETURNS DECIMAL(6,2) AS $$
DECLARE v_base_price DECIMAL(6,2); v_profile pricing_profiles%ROWTYPE; v_product products%ROWTYPE; v_slot slots%ROWTYPE;
  v_mult DECIMAL(4,2); v_result DECIMAL(6,2); v_min_price DECIMAL(6,2); v_round_to DECIMAL(3,2);
BEGIN
  SELECT * INTO v_product FROM products WHERE id = p_product_id; IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT pp.* INTO v_profile FROM machines m JOIN pricing_profiles pp ON pp.id = m.pricing_profile_id WHERE m.id = p_machine_id;
  v_base_price := v_product.default_price;
  IF v_profile.id IS NOT NULL THEN
    v_mult := CASE v_product.category WHEN 'beverage' THEN v_profile.beverage_mult WHEN 'snack' THEN v_profile.snack_mult
      WHEN 'candy' THEN v_profile.candy_mult WHEN 'incidental' THEN v_profile.incidental_mult ELSE 1.0 END;
    v_result := v_base_price * v_mult;
    IF v_profile.price_overrides ? p_product_id::TEXT THEN v_result := (v_profile.price_overrides ->> p_product_id::TEXT)::DECIMAL; END IF;
  ELSE v_result := v_base_price; END IF;
  IF p_slot_id IS NOT NULL THEN SELECT * INTO v_slot FROM slots WHERE id = p_slot_id;
    IF v_slot.price_override IS NOT NULL THEN v_result := v_slot.price_override; END IF; END IF;
  v_min_price := COALESCE(v_product.unit_cost, 0) * 3;
  IF v_result < v_min_price THEN v_result := v_min_price; END IF;
  v_round_to := COALESCE(v_profile.round_to, 0.25);
  v_result := ROUND(v_result / v_round_to) * v_round_to;
  RETURN v_result;
END; $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION predict_stockout(p_slot_id UUID) RETURNS TIMESTAMPTZ AS $$
DECLARE v_slot slots%ROWTYPE; v_avg_daily DECIMAL(6,2); v_days_remaining DECIMAL(6,2);
BEGIN
  SELECT * INTO v_slot FROM slots WHERE id = p_slot_id;
  IF NOT FOUND OR v_slot.current_qty = 0 THEN RETURN NOW(); END IF;
  SELECT COUNT(*)::DECIMAL / 30 INTO v_avg_daily FROM transactions WHERE slot_id = p_slot_id AND sold_at >= NOW() - INTERVAL '30 days';
  IF v_avg_daily = 0 THEN RETURN NULL; END IF;
  v_days_remaining := v_slot.current_qty / v_avg_daily;
  RETURN NOW() + (v_days_remaining || ' days')::INTERVAL;
END; $$ LANGUAGE plpgsql;

-- ============================================================
-- TRIGGERS
-- ============================================================
CREATE OR REPLACE FUNCTION trg_after_transaction_insert() RETURNS TRIGGER AS $$
BEGIN
  UPDATE slots SET current_qty = GREATEST(0, current_qty - NEW.quantity), total_sold = total_sold + NEW.quantity,
    total_revenue = total_revenue + NEW.total_price, last_sold_at = NEW.sold_at, updated_at = NOW() WHERE id = NEW.slot_id;
  INSERT INTO inventory_logs (slot_id, machine_id, product_id, change_type, qty_before, qty_change, qty_after, transaction_id, performed_by)
    SELECT NEW.slot_id, NEW.machine_id, NEW.product_id, 'sale', s.current_qty + NEW.quantity, -NEW.quantity, s.current_qty, NEW.id, 'system'
    FROM slots s WHERE s.id = NEW.slot_id;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_transaction_insert ON transactions;
CREATE TRIGGER trg_transaction_insert AFTER INSERT ON transactions FOR EACH ROW EXECUTE FUNCTION trg_after_transaction_insert();

-- ============================================================
-- SEED: Pricing Profiles
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
