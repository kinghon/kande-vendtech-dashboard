-- =====================================================
-- Kande VendTech Machine Management System
-- Phase 4: Pricing Strategies Schema
-- =====================================================
-- Created: February 2026
-- Based on: machine-system/DESIGN.md Phase 4
-- Business Rules from: VENDTECH-RULES.md
--   - 3x COGS target (33% cost)
--   - $3.00 average price target
--   - Decoy, anchoring, time-based, bundle strategies
-- =====================================================

-- =====================================================
-- PRICING STRATEGIES TABLE
-- Stores strategy configurations with JSON config
-- =====================================================
CREATE TABLE IF NOT EXISTS pricing_strategies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- Basic info
    name VARCHAR(255) NOT NULL,
    description TEXT,
    type VARCHAR(50) NOT NULL,
    -- Valid types: decoy, anchoring, time_based, bundle_discount, margin_optimization
    
    -- Strategy configuration (JSON structure varies by type)
    config JSONB NOT NULL DEFAULT '{}',
    -- Decoy config: { target_product, decoy_product, premium_product, target_price, decoy_price, premium_price }
    -- Anchoring config: { anchor_positions: [0,1], anchor_products: [], anchor_price_multiplier: 1.5 }
    -- Time-based config: { rules: [{ days: [0-6], start_hour, end_hour, discount_percent }] }
    -- Bundle config: { bundles: [{ products: [], bundle_price, savings_percent }] }
    
    -- Status
    is_active BOOLEAN NOT NULL DEFAULT true,
    is_template BOOLEAN NOT NULL DEFAULT false,
    
    -- Metadata
    created_by VARCHAR(255),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- STRATEGY APPLICATIONS TABLE
-- Links strategies to machines with application history
-- =====================================================
CREATE TABLE IF NOT EXISTS strategy_applications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    strategy_id UUID NOT NULL REFERENCES pricing_strategies(id) ON DELETE CASCADE,
    machine_id UUID NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
    
    -- Application details
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    applied_by VARCHAR(255),
    
    -- Status
    status VARCHAR(50) NOT NULL DEFAULT 'active',
    -- Valid: active, paused, ended
    
    -- Slot-specific config overrides (optional)
    slot_overrides JSONB DEFAULT '{}',
    -- Format: { "slot_id": { price_override: 2.50, excluded: false } }
    
    -- End date for temporary strategies
    ends_at TIMESTAMPTZ,
    
    -- Tracking
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    
    -- Only one active strategy per machine
    UNIQUE(machine_id, strategy_id)
);

-- =====================================================
-- SLOT PRICE OVERRIDES TABLE
-- Per-slot custom pricing (independent of strategies)
-- =====================================================
CREATE TABLE IF NOT EXISTS slot_price_overrides (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    slot_id UUID NOT NULL REFERENCES slots(id) ON DELETE CASCADE,
    machine_id UUID NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
    
    -- Override details
    custom_price DECIMAL(10,2) NOT NULL,
    original_price DECIMAL(10,2),
    reason VARCHAR(255),
    
    -- Time-bound overrides
    effective_from TIMESTAMPTZ DEFAULT NOW(),
    effective_until TIMESTAMPTZ,
    
    -- Metadata
    created_by VARCHAR(255),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    
    UNIQUE(slot_id)
);

-- =====================================================
-- STRATEGY PERFORMANCE TRACKING TABLE
-- Tracks performance metrics for applied strategies
-- =====================================================
CREATE TABLE IF NOT EXISTS strategy_performance (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    application_id UUID NOT NULL REFERENCES strategy_applications(id) ON DELETE CASCADE,
    strategy_id UUID NOT NULL REFERENCES pricing_strategies(id) ON DELETE CASCADE,
    machine_id UUID NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
    
    -- Period
    date DATE NOT NULL,
    
    -- Revenue metrics
    revenue DECIMAL(10,2) NOT NULL DEFAULT 0,
    transactions INT NOT NULL DEFAULT 0,
    units_sold INT NOT NULL DEFAULT 0,
    
    -- Margin metrics
    cogs DECIMAL(10,2) NOT NULL DEFAULT 0,
    gross_profit DECIMAL(10,2) NOT NULL DEFAULT 0,
    margin_percent DECIMAL(5,2) NOT NULL DEFAULT 0,
    
    -- Strategy-specific metrics
    target_product_sales INT DEFAULT 0,
    decoy_product_sales INT DEFAULT 0,
    premium_product_sales INT DEFAULT 0,
    bundle_sales INT DEFAULT 0,
    
    -- Comparison to baseline (before strategy)
    revenue_vs_baseline DECIMAL(10,2),
    margin_vs_baseline DECIMAL(5,2),
    
    created_at TIMESTAMPTZ DEFAULT NOW(),
    
    UNIQUE(application_id, date)
);

-- =====================================================
-- A/B TEST TABLE
-- For testing strategy variations
-- =====================================================
CREATE TABLE IF NOT EXISTS strategy_ab_tests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    name VARCHAR(255) NOT NULL,
    description TEXT,
    
    -- Test variants
    control_strategy_id UUID REFERENCES pricing_strategies(id),
    variant_strategy_id UUID NOT NULL REFERENCES pricing_strategies(id),
    
    -- Test parameters
    control_machines UUID[],
    variant_machines UUID[],
    
    -- Status
    status VARCHAR(50) NOT NULL DEFAULT 'draft',
    -- Valid: draft, running, paused, completed, cancelled
    
    -- Timeline
    start_date DATE,
    end_date DATE,
    
    -- Results
    winner VARCHAR(50),
    -- Valid: control, variant, inconclusive
    confidence_level DECIMAL(5,2),
    
    -- Metadata
    created_by VARCHAR(255),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- PRICE HISTORY TABLE
-- Audit trail for all price changes
-- =====================================================
CREATE TABLE IF NOT EXISTS price_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- What changed
    entity_type VARCHAR(50) NOT NULL,
    -- Valid: slot, product, machine_default
    entity_id UUID NOT NULL,
    
    -- Price change
    old_price DECIMAL(10,2),
    new_price DECIMAL(10,2) NOT NULL,
    
    -- Why it changed
    change_reason VARCHAR(50) NOT NULL,
    -- Valid: strategy_applied, manual_override, time_based_rule, bundle_discount, margin_optimization
    
    -- Context
    strategy_id UUID REFERENCES pricing_strategies(id),
    application_id UUID REFERENCES strategy_applications(id),
    
    -- Metadata
    changed_by VARCHAR(255),
    changed_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- INDEXES
-- =====================================================

-- Strategy lookups
CREATE INDEX IF NOT EXISTS idx_pricing_strategies_type ON pricing_strategies(type);
CREATE INDEX IF NOT EXISTS idx_pricing_strategies_active ON pricing_strategies(is_active);
CREATE INDEX IF NOT EXISTS idx_pricing_strategies_template ON pricing_strategies(is_template);

-- Application lookups
CREATE INDEX IF NOT EXISTS idx_strategy_applications_machine ON strategy_applications(machine_id);
CREATE INDEX IF NOT EXISTS idx_strategy_applications_strategy ON strategy_applications(strategy_id);
CREATE INDEX IF NOT EXISTS idx_strategy_applications_status ON strategy_applications(status);
CREATE INDEX IF NOT EXISTS idx_strategy_applications_active ON strategy_applications(machine_id, status) WHERE status = 'active';

-- Performance queries
CREATE INDEX IF NOT EXISTS idx_strategy_performance_machine ON strategy_performance(machine_id);
CREATE INDEX IF NOT EXISTS idx_strategy_performance_date ON strategy_performance(date);
CREATE INDEX IF NOT EXISTS idx_strategy_performance_lookup ON strategy_performance(application_id, date);

-- Price overrides
CREATE INDEX IF NOT EXISTS idx_slot_price_overrides_slot ON slot_price_overrides(slot_id);
CREATE INDEX IF NOT EXISTS idx_slot_price_overrides_machine ON slot_price_overrides(machine_id);

-- Price history
CREATE INDEX IF NOT EXISTS idx_price_history_entity ON price_history(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_price_history_date ON price_history(changed_at);

-- A/B tests
CREATE INDEX IF NOT EXISTS idx_ab_tests_status ON strategy_ab_tests(status);

-- =====================================================
-- DEFAULT STRATEGY TEMPLATES
-- Pre-built strategies based on best practices
-- =====================================================

INSERT INTO pricing_strategies (id, name, description, type, config, is_template, created_by)
VALUES 
    (
        gen_random_uuid(),
        'Classic Decoy Effect',
        'Use a medium-priced decoy to make the premium option more attractive. Target: increase premium sales by 30%.',
        'decoy',
        '{
            "target_role": "premium",
            "products": {
                "economy": { "position": "bottom", "price_range": [1.50, 2.00] },
                "decoy": { "position": "middle", "price_range": [2.25, 2.75], "similar_to": "premium" },
                "premium": { "position": "top", "price_range": [2.50, 3.00] }
            },
            "placement_rules": {
                "decoy_adjacent_to_premium": true,
                "anchor_first_row": true
            },
            "expected_lift": 30
        }',
        true,
        'system'
    ),
    (
        gen_random_uuid(),
        'High Anchor Strategy',
        'Place highest-priced items at eye level to anchor pricing perception. Makes other items feel like good value.',
        'anchoring',
        '{
            "anchor_positions": ["A1", "A2", "B1", "B2"],
            "anchor_price_minimum": 3.50,
            "anchor_categories": ["energy_drink", "premium_snack"],
            "psychological_notes": "Customers see premium prices first, making $2.50 items feel reasonable",
            "expected_avg_transaction_lift": 15
        }',
        true,
        'system'
    ),
    (
        gen_random_uuid(),
        'Happy Hour Discount',
        'Time-based pricing for slow periods. Boost sales during off-peak hours without affecting peak margins.',
        'time_based',
        '{
            "rules": [
                {
                    "name": "Morning Boost",
                    "days": [1, 2, 3, 4, 5],
                    "start_hour": 6,
                    "end_hour": 8,
                    "discount_percent": 10,
                    "categories": ["beverage", "energy_drink"]
                },
                {
                    "name": "Late Night Deal",
                    "days": [0, 1, 2, 3, 4, 5, 6],
                    "start_hour": 21,
                    "end_hour": 23,
                    "discount_percent": 15,
                    "categories": ["snack"]
                }
            ],
            "minimum_margin_percent": 40
        }',
        true,
        'system'
    ),
    (
        gen_random_uuid(),
        'Combo Bundle Deal',
        'Bundle complementary items at a small discount. Increases average transaction size.',
        'bundle_discount',
        '{
            "bundles": [
                {
                    "name": "Energy Combo",
                    "products": ["energy_drink", "protein_bar"],
                    "original_total": 5.50,
                    "bundle_price": 4.99,
                    "savings_percent": 9
                },
                {
                    "name": "Snack Attack",
                    "products": ["chips", "candy", "soda"],
                    "original_total": 6.00,
                    "bundle_price": 5.25,
                    "savings_percent": 12.5
                }
            ],
            "display_savings": true,
            "max_bundles_per_transaction": 2
        }',
        true,
        'system'
    ),
    (
        gen_random_uuid(),
        '3x COGS Margin Optimizer',
        'Automatically adjusts prices to maintain 33% COGS target (3x markup). Based on VendTech best practices.',
        'margin_optimization',
        '{
            "target_margin_percent": 67,
            "target_cogs_percent": 33,
            "price_rounding": 0.25,
            "min_price": 1.50,
            "max_price": 5.00,
            "avg_target_price": 3.00,
            "rules": {
                "auto_adjust": false,
                "alert_threshold_percent": 5,
                "never_exceed_competitive": true
            }
        }',
        true,
        'system'
    )
ON CONFLICT DO NOTHING;

-- =====================================================
-- FUNCTIONS
-- =====================================================

-- Function to calculate effective price for a slot
CREATE OR REPLACE FUNCTION get_effective_slot_price(
    p_slot_id UUID,
    p_base_price DECIMAL(10,2),
    p_current_hour INT DEFAULT NULL
)
RETURNS DECIMAL(10,2) AS $$
DECLARE
    v_override_price DECIMAL(10,2);
    v_strategy_price DECIMAL(10,2);
    v_time_discount DECIMAL(5,2);
    v_final_price DECIMAL(10,2);
BEGIN
    -- Check for manual override first (highest priority)
    SELECT custom_price INTO v_override_price
    FROM slot_price_overrides
    WHERE slot_id = p_slot_id
    AND (effective_until IS NULL OR effective_until > NOW());
    
    IF v_override_price IS NOT NULL THEN
        RETURN v_override_price;
    END IF;
    
    -- If no override, return base price
    -- (In production, would also check active strategies)
    RETURN p_base_price;
END;
$$ LANGUAGE plpgsql;

-- Function to record price changes
CREATE OR REPLACE FUNCTION record_price_change()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND OLD.custom_price != NEW.custom_price THEN
        INSERT INTO price_history (entity_type, entity_id, old_price, new_price, change_reason, changed_by)
        VALUES ('slot', NEW.slot_id, OLD.custom_price, NEW.custom_price, 'manual_override', NEW.created_by);
    ELSIF TG_OP = 'INSERT' THEN
        INSERT INTO price_history (entity_type, entity_id, old_price, new_price, change_reason, changed_by)
        VALUES ('slot', NEW.slot_id, NEW.original_price, NEW.custom_price, 'manual_override', NEW.created_by);
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger for price history
DROP TRIGGER IF EXISTS trigger_price_change ON slot_price_overrides;
CREATE TRIGGER trigger_price_change
AFTER INSERT OR UPDATE ON slot_price_overrides
FOR EACH ROW EXECUTE FUNCTION record_price_change();

-- =====================================================
-- VIEWS
-- =====================================================

-- View for active strategies per machine
CREATE OR REPLACE VIEW active_machine_strategies AS
SELECT 
    m.id AS machine_id,
    m.name AS machine_name,
    m.location_name,
    ps.id AS strategy_id,
    ps.name AS strategy_name,
    ps.type AS strategy_type,
    ps.config AS strategy_config,
    sa.applied_at,
    sa.status,
    sa.slot_overrides
FROM machines m
LEFT JOIN strategy_applications sa ON m.id = sa.machine_id AND sa.status = 'active'
LEFT JOIN pricing_strategies ps ON sa.strategy_id = ps.id;

-- View for strategy performance summary
CREATE OR REPLACE VIEW strategy_performance_summary AS
SELECT 
    ps.id AS strategy_id,
    ps.name AS strategy_name,
    ps.type AS strategy_type,
    COUNT(DISTINCT sa.machine_id) AS machines_applied,
    COUNT(DISTINCT sp.date) AS days_tracked,
    SUM(sp.revenue) AS total_revenue,
    SUM(sp.transactions) AS total_transactions,
    SUM(sp.units_sold) AS total_units,
    AVG(sp.margin_percent) AS avg_margin,
    SUM(sp.gross_profit) AS total_profit
FROM pricing_strategies ps
LEFT JOIN strategy_applications sa ON ps.id = sa.strategy_id
LEFT JOIN strategy_performance sp ON sa.id = sp.application_id
GROUP BY ps.id, ps.name, ps.type;

-- =====================================================
-- COMMENTS
-- =====================================================
COMMENT ON TABLE pricing_strategies IS 'Stores pricing strategy configurations with JSON config for flexibility';
COMMENT ON TABLE strategy_applications IS 'Links strategies to machines - one active strategy per machine';
COMMENT ON TABLE slot_price_overrides IS 'Manual per-slot price overrides, highest priority';
COMMENT ON TABLE strategy_performance IS 'Daily performance metrics for applied strategies';
COMMENT ON TABLE strategy_ab_tests IS 'A/B testing framework for strategy comparison';
COMMENT ON TABLE price_history IS 'Audit trail for all price changes';
