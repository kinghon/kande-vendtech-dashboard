-- =====================================================
-- Kande VendTech Machine Management System
-- Phase 5: Bundles & Recommendations Schema
-- =====================================================
-- Created: February 2026
-- Based on: machine-system/DESIGN.md Phase 5
-- Business Rules from: VENDTECH-RULES.md
--   - 3x COGS target (33% cost)
--   - $3.00 average price target
--   - Bundle strategies increase basket size
--   - AI suggestions from purchase patterns
-- =====================================================

-- =====================================================
-- BUNDLES TABLE
-- Stores bundle definitions with product combos & discounts
-- =====================================================
CREATE TABLE IF NOT EXISTS bundles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- Basic info
    name VARCHAR(255) NOT NULL,
    description TEXT,
    
    -- Products in bundle (JSON array of product references)
    products JSONB NOT NULL DEFAULT '[]',
    -- Format: [
    --   { "product_id": 123, "product_name": "Coca-Cola 20oz", "quantity": 1, "original_price": 2.50 },
    --   { "product_id": 456, "product_name": "Doritos Nacho", "quantity": 1, "original_price": 2.25 }
    -- ]
    
    -- Discount configuration
    discount_type VARCHAR(50) NOT NULL DEFAULT 'percentage',
    -- Valid types: percentage, fixed_amount, fixed_price
    discount_value DECIMAL(10,2) NOT NULL DEFAULT 0,
    -- percentage: 10 = 10% off
    -- fixed_amount: 0.50 = $0.50 off total
    -- fixed_price: 3.99 = bundle costs exactly $3.99
    
    -- Calculated prices (stored for performance)
    original_total DECIMAL(10,2) GENERATED ALWAYS AS (
        COALESCE((
            SELECT SUM((item->>'original_price')::DECIMAL * (item->>'quantity')::INT)
            FROM jsonb_array_elements(products) AS item
        ), 0)
    ) STORED,
    
    bundle_price DECIMAL(10,2) NOT NULL DEFAULT 0,
    savings_amount DECIMAL(10,2) NOT NULL DEFAULT 0,
    savings_percent DECIMAL(5,2) NOT NULL DEFAULT 0,
    
    -- Targeting rules
    targeting JSONB DEFAULT '{}',
    -- Format: {
    --   "time_based": { "enabled": false, "start_hour": 11, "end_hour": 14, "days": [1,2,3,4,5] },
    --   "machine_types": ["cooler", "snack"],
    --   "location_types": ["warehouse", "manufacturing"]
    -- }
    
    -- Display configuration
    display_config JSONB DEFAULT '{}',
    -- Format: {
    --   "show_savings": true,
    --   "badge_text": "COMBO DEAL",
    --   "badge_color": "#22c55e",
    --   "position": "featured"
    -- }
    
    -- Status
    is_active BOOLEAN NOT NULL DEFAULT true,
    is_suggested BOOLEAN NOT NULL DEFAULT false, -- AI-generated suggestion
    suggestion_score DECIMAL(5,2), -- Confidence score for AI suggestions
    
    -- Categories/Tags
    category VARCHAR(100), -- meal_deal, snack_combo, beverage_pair, etc.
    tags JSONB DEFAULT '[]',
    
    -- Performance tracking
    total_sales INT NOT NULL DEFAULT 0,
    total_revenue DECIMAL(12,2) NOT NULL DEFAULT 0,
    conversion_rate DECIMAL(5,2) NOT NULL DEFAULT 0, -- % of views that convert
    
    -- Metadata
    created_by VARCHAR(255),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for active bundles
CREATE INDEX IF NOT EXISTS idx_bundles_active ON bundles(is_active) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_bundles_suggested ON bundles(is_suggested, suggestion_score DESC);
CREATE INDEX IF NOT EXISTS idx_bundles_category ON bundles(category);

-- =====================================================
-- BUNDLE APPLICATIONS TABLE
-- Links bundles to machines with display configuration
-- =====================================================
CREATE TABLE IF NOT EXISTS bundle_applications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    bundle_id UUID NOT NULL REFERENCES bundles(id) ON DELETE CASCADE,
    machine_id UUID NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
    
    -- Display configuration
    display_slot VARCHAR(50), -- Position in machine UI: featured, slot_1, slot_2, etc.
    display_priority INT NOT NULL DEFAULT 0, -- Higher = more prominent
    
    -- Status
    status VARCHAR(50) NOT NULL DEFAULT 'active',
    -- Valid: active, paused, scheduled, ended
    
    -- Scheduling
    starts_at TIMESTAMPTZ DEFAULT NOW(),
    ends_at TIMESTAMPTZ,
    
    -- Time-based display (override bundle defaults)
    time_override JSONB DEFAULT NULL,
    -- Format: { "start_hour": 11, "end_hour": 14, "days": [1,2,3,4,5] }
    
    -- Performance tracking (per-machine)
    impressions INT NOT NULL DEFAULT 0,
    clicks INT NOT NULL DEFAULT 0,
    conversions INT NOT NULL DEFAULT 0,
    revenue DECIMAL(12,2) NOT NULL DEFAULT 0,
    
    -- Metadata
    applied_by VARCHAR(255),
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    
    -- One active application per bundle per machine
    UNIQUE(machine_id, bundle_id)
);

-- Indexes for bundle applications
CREATE INDEX IF NOT EXISTS idx_bundle_apps_machine ON bundle_applications(machine_id);
CREATE INDEX IF NOT EXISTS idx_bundle_apps_bundle ON bundle_applications(bundle_id);
CREATE INDEX IF NOT EXISTS idx_bundle_apps_status ON bundle_applications(status) WHERE status = 'active';

-- =====================================================
-- BUNDLE SALES TABLE
-- Tracks individual bundle sale transactions
-- =====================================================
CREATE TABLE IF NOT EXISTS bundle_sales (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    bundle_id UUID NOT NULL REFERENCES bundles(id) ON DELETE CASCADE,
    bundle_application_id UUID REFERENCES bundle_applications(id) ON DELETE SET NULL,
    machine_id UUID REFERENCES machines(id) ON DELETE SET NULL,
    transaction_id UUID, -- Links to main transactions table
    
    -- Sale details
    sale_price DECIMAL(10,2) NOT NULL,
    original_price DECIMAL(10,2) NOT NULL,
    discount_amount DECIMAL(10,2) NOT NULL,
    
    -- Products sold in this bundle instance
    products_sold JSONB NOT NULL DEFAULT '[]',
    -- Same format as bundle.products
    
    -- Context
    hour_of_day INT, -- 0-23
    day_of_week INT, -- 0-6 (Sunday = 0)
    
    -- Metadata
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for bundle sales
CREATE INDEX IF NOT EXISTS idx_bundle_sales_bundle ON bundle_sales(bundle_id);
CREATE INDEX IF NOT EXISTS idx_bundle_sales_machine ON bundle_sales(machine_id);
CREATE INDEX IF NOT EXISTS idx_bundle_sales_date ON bundle_sales(created_at);
CREATE INDEX IF NOT EXISTS idx_bundle_sales_hour ON bundle_sales(hour_of_day);

-- =====================================================
-- PURCHASE PATTERNS TABLE
-- Stores co-purchase data for AI bundle suggestions
-- Uses market basket analysis / Apriori-style metrics
-- =====================================================
CREATE TABLE IF NOT EXISTS purchase_patterns (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- Product pair
    product_a_id INT NOT NULL,
    product_b_id INT NOT NULL,
    product_a_name VARCHAR(255),
    product_b_name VARCHAR(255),
    
    -- Association metrics
    frequency INT NOT NULL DEFAULT 0, -- Times bought together
    support DECIMAL(5,4) NOT NULL DEFAULT 0, -- % of transactions containing both
    confidence_a_to_b DECIMAL(5,4) NOT NULL DEFAULT 0, -- P(B|A)
    confidence_b_to_a DECIMAL(5,4) NOT NULL DEFAULT 0, -- P(A|B)
    lift DECIMAL(8,4) NOT NULL DEFAULT 0, -- Lift ratio (>1 = positive correlation)
    
    -- Context
    avg_basket_size DECIMAL(5,2) NOT NULL DEFAULT 0,
    common_hour INT, -- Most common hour they're bought together
    common_day INT, -- Most common day
    
    -- Machine context
    machine_ids JSONB DEFAULT '[]', -- Machines where this pattern occurs
    location_types JSONB DEFAULT '[]', -- Location types where pattern is strong
    
    -- Time tracking
    first_observed TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_observed TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    observation_count INT NOT NULL DEFAULT 0,
    
    -- Status
    is_significant BOOLEAN NOT NULL DEFAULT false, -- Meets threshold for suggestions
    bundle_created BOOLEAN NOT NULL DEFAULT false, -- Already turned into bundle
    
    UNIQUE(product_a_id, product_b_id)
);

-- Indexes for purchase patterns
CREATE INDEX IF NOT EXISTS idx_patterns_significant ON purchase_patterns(is_significant, lift DESC) WHERE is_significant = true;
CREATE INDEX IF NOT EXISTS idx_patterns_lift ON purchase_patterns(lift DESC);
CREATE INDEX IF NOT EXISTS idx_patterns_frequency ON purchase_patterns(frequency DESC);
CREATE INDEX IF NOT EXISTS idx_patterns_product_a ON purchase_patterns(product_a_id);
CREATE INDEX IF NOT EXISTS idx_patterns_product_b ON purchase_patterns(product_b_id);

-- =====================================================
-- BUNDLE TEMPLATES TABLE
-- Pre-built bundle templates for quick creation
-- =====================================================
CREATE TABLE IF NOT EXISTS bundle_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    name VARCHAR(255) NOT NULL,
    description TEXT,
    category VARCHAR(100) NOT NULL,
    -- Categories: meal_deal, snack_combo, beverage_pair, energy_boost, healthy_combo, value_pack
    
    -- Template configuration
    template_config JSONB NOT NULL DEFAULT '{}',
    -- Format: {
    --   "slots": [
    --     { "role": "main", "categories": ["chips", "pretzels"], "price_range": [1.50, 2.50] },
    --     { "role": "drink", "categories": ["soda", "water", "energy"], "price_range": [2.00, 3.50] }
    --   ],
    --   "suggested_discount": 10,
    --   "target_price": 4.00
    -- }
    
    -- Display
    icon VARCHAR(50), -- Emoji or icon class
    color VARCHAR(20), -- Hex color
    
    -- Usage tracking
    times_used INT NOT NULL DEFAULT 0,
    
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- SEED DATA: Bundle Templates
-- =====================================================
INSERT INTO bundle_templates (name, description, category, template_config, icon, color) VALUES
(
    'Lunch Combo',
    'Classic lunch pairing - snack + drink',
    'meal_deal',
    '{
        "slots": [
            { "role": "snack", "categories": ["chips", "crackers", "pretzels"], "price_range": [1.50, 2.50] },
            { "role": "drink", "categories": ["soda", "water", "juice"], "price_range": [2.00, 3.00] }
        ],
        "suggested_discount": 10,
        "target_price": 4.00
    }',
    '🍔',
    '#f59e0b'
),
(
    'Energy Boost',
    'Energy drink + protein/candy for quick energy',
    'energy_boost',
    '{
        "slots": [
            { "role": "energy", "categories": ["energy"], "price_range": [3.00, 4.00] },
            { "role": "snack", "categories": ["candy", "protein"], "price_range": [1.50, 2.50] }
        ],
        "suggested_discount": 15,
        "target_price": 5.00
    }',
    '⚡',
    '#ef4444'
),
(
    'Healthy Pick',
    'Healthy snack + water combo',
    'healthy_combo',
    '{
        "slots": [
            { "role": "healthy", "categories": ["healthy", "protein", "nuts"], "price_range": [2.00, 3.50] },
            { "role": "water", "categories": ["water"], "price_range": [1.50, 2.50] }
        ],
        "suggested_discount": 10,
        "target_price": 4.50
    }',
    '🥗',
    '#22c55e'
),
(
    'Sweet Treat',
    'Candy + soda indulgence combo',
    'snack_combo',
    '{
        "slots": [
            { "role": "candy", "categories": ["candy", "chocolate"], "price_range": [1.50, 2.50] },
            { "role": "soda", "categories": ["soda"], "price_range": [2.00, 3.00] }
        ],
        "suggested_discount": 12,
        "target_price": 3.75
    }',
    '🍬',
    '#ec4899'
),
(
    'Beverage Duo',
    'Two drinks at a discount',
    'beverage_pair',
    '{
        "slots": [
            { "role": "drink1", "categories": ["soda", "water", "juice", "energy"], "price_range": [2.00, 3.50] },
            { "role": "drink2", "categories": ["soda", "water", "juice", "energy"], "price_range": [2.00, 3.50] }
        ],
        "suggested_discount": 15,
        "target_price": 5.00
    }',
    '🥤',
    '#3b82f6'
),
(
    'Value Pack',
    'Three items at maximum savings',
    'value_pack',
    '{
        "slots": [
            { "role": "main", "categories": ["chips", "crackers"], "price_range": [1.50, 2.50] },
            { "role": "side", "categories": ["candy", "cookies"], "price_range": [1.50, 2.50] },
            { "role": "drink", "categories": ["soda", "water"], "price_range": [2.00, 3.00] }
        ],
        "suggested_discount": 20,
        "target_price": 5.50
    }',
    '📦',
    '#8b5cf6'
)
ON CONFLICT DO NOTHING;

-- =====================================================
-- TRIGGER: Update bundle performance metrics
-- =====================================================
CREATE OR REPLACE FUNCTION update_bundle_metrics()
RETURNS TRIGGER AS $$
BEGIN
    -- Update bundle totals
    UPDATE bundles SET
        total_sales = total_sales + 1,
        total_revenue = total_revenue + NEW.sale_price,
        updated_at = NOW()
    WHERE id = NEW.bundle_id;
    
    -- Update application metrics
    IF NEW.bundle_application_id IS NOT NULL THEN
        UPDATE bundle_applications SET
            conversions = conversions + 1,
            revenue = revenue + NEW.sale_price,
            updated_at = NOW()
        WHERE id = NEW.bundle_application_id;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_bundle_sale_metrics ON bundle_sales;
CREATE TRIGGER trigger_bundle_sale_metrics
    AFTER INSERT ON bundle_sales
    FOR EACH ROW
    EXECUTE FUNCTION update_bundle_metrics();

-- =====================================================
-- FUNCTION: Calculate purchase patterns from transactions
-- Call periodically to update pattern mining
-- =====================================================
CREATE OR REPLACE FUNCTION calculate_purchase_patterns()
RETURNS void AS $$
DECLARE
    total_transactions INT;
    min_support DECIMAL := 0.01; -- Minimum 1% of transactions
    min_frequency INT := 5; -- At least 5 co-occurrences
BEGIN
    -- Get total transaction count
    SELECT COUNT(DISTINCT id) INTO total_transactions FROM transactions;
    
    IF total_transactions = 0 THEN
        RETURN;
    END IF;
    
    -- Calculate co-purchase frequencies
    -- This is a simplified version - production would use window functions
    INSERT INTO purchase_patterns (
        product_a_id, product_b_id,
        product_a_name, product_b_name,
        frequency, support, lift,
        is_significant, last_observed, observation_count
    )
    SELECT 
        p1.product_id AS product_a_id,
        p2.product_id AS product_b_id,
        p1.product_name AS product_a_name,
        p2.product_name AS product_b_name,
        COUNT(*) AS frequency,
        COUNT(*)::DECIMAL / total_transactions AS support,
        1.0 AS lift, -- Simplified - would calculate properly
        COUNT(*) >= min_frequency AS is_significant,
        NOW() AS last_observed,
        1 AS observation_count
    FROM transactions t1
    JOIN transactions t2 ON t1.transaction_id = t2.transaction_id
        AND t1.product_id < t2.product_id -- Avoid duplicates
    JOIN products p1 ON t1.product_id = p1.id
    JOIN products p2 ON t2.product_id = p2.id
    GROUP BY p1.product_id, p2.product_id, p1.product_name, p2.product_name
    HAVING COUNT(*) >= min_frequency
    ON CONFLICT (product_a_id, product_b_id) DO UPDATE SET
        frequency = purchase_patterns.frequency + EXCLUDED.frequency,
        support = EXCLUDED.support,
        is_significant = EXCLUDED.is_significant,
        last_observed = NOW(),
        observation_count = purchase_patterns.observation_count + 1;
END;
$$ LANGUAGE plpgsql;

-- =====================================================
-- VIEW: Active bundles with stats
-- =====================================================
CREATE OR REPLACE VIEW active_bundles_summary AS
SELECT 
    b.id,
    b.name,
    b.description,
    b.products,
    b.discount_type,
    b.discount_value,
    b.bundle_price,
    b.savings_percent,
    b.category,
    b.is_suggested,
    b.suggestion_score,
    b.total_sales,
    b.total_revenue,
    b.conversion_rate,
    COUNT(DISTINCT ba.machine_id) AS applied_machines,
    SUM(ba.impressions) AS total_impressions,
    SUM(ba.clicks) AS total_clicks,
    b.created_at,
    b.updated_at
FROM bundles b
LEFT JOIN bundle_applications ba ON b.id = ba.bundle_id AND ba.status = 'active'
WHERE b.is_active = true
GROUP BY b.id;

-- =====================================================
-- VIEW: Top purchase patterns for suggestions
-- =====================================================
CREATE OR REPLACE VIEW top_purchase_patterns AS
SELECT 
    pp.*,
    CASE 
        WHEN pp.lift >= 2.0 THEN 'strong'
        WHEN pp.lift >= 1.5 THEN 'moderate'
        ELSE 'weak'
    END AS correlation_strength
FROM purchase_patterns pp
WHERE pp.is_significant = true
    AND pp.bundle_created = false
ORDER BY pp.lift DESC, pp.frequency DESC
LIMIT 50;

-- =====================================================
-- COMMENTS
-- =====================================================
COMMENT ON TABLE bundles IS 'Product bundles with discounts and targeting rules';
COMMENT ON TABLE bundle_applications IS 'Bundle assignments to specific machines';
COMMENT ON TABLE bundle_sales IS 'Transaction records for bundle purchases';
COMMENT ON TABLE purchase_patterns IS 'Co-purchase patterns for AI suggestions (market basket analysis)';
COMMENT ON TABLE bundle_templates IS 'Pre-built templates for quick bundle creation';

COMMENT ON COLUMN bundles.discount_type IS 'percentage | fixed_amount | fixed_price';
COMMENT ON COLUMN bundles.targeting IS 'Time-based and location targeting rules JSON';
COMMENT ON COLUMN purchase_patterns.lift IS 'Lift > 1 indicates positive correlation';
COMMENT ON COLUMN purchase_patterns.support IS 'Fraction of transactions containing both items';
