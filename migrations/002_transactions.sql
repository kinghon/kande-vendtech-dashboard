-- =====================================================
-- Kande VendTech Machine Management System
-- Phase 3: Sales & Analytics Schema
-- =====================================================
-- Created: February 2026
-- Based on: machine-system/DESIGN.md Phase 3
-- =====================================================

-- =====================================================
-- TRANSACTIONS TABLE
-- Records individual sales transactions from machines
-- =====================================================
CREATE TABLE IF NOT EXISTS transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- Machine and slot references
    machine_id UUID NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
    slot_id UUID REFERENCES slots(id) ON DELETE SET NULL,
    
    -- Product info (captured at time of sale, not FK'd to allow product changes)
    product_id UUID,
    product_name VARCHAR(255),
    product_category VARCHAR(50),
    
    -- Transaction details
    unit_price DECIMAL(10,2) NOT NULL,
    quantity INT NOT NULL DEFAULT 1,
    total DECIMAL(10,2) NOT NULL,
    
    -- Payment info
    payment_method VARCHAR(50) NOT NULL DEFAULT 'card',
    -- Valid: card, nfc, cash, apple_pay, google_pay, other
    payment_status VARCHAR(50) NOT NULL DEFAULT 'completed',
    -- Valid: completed, refunded, failed, pending
    
    -- Optional external reference (from payment processor)
    external_ref VARCHAR(255),
    
    -- Timestamps
    transaction_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- DAILY SALES SUMMARY TABLE
-- Aggregated daily metrics per machine for fast queries
-- =====================================================
CREATE TABLE IF NOT EXISTS daily_sales_summary (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    machine_id UUID NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
    date DATE NOT NULL,
    
    -- Revenue metrics
    total_revenue DECIMAL(10,2) NOT NULL DEFAULT 0,
    total_cogs DECIMAL(10,2) NOT NULL DEFAULT 0,
    gross_profit DECIMAL(10,2) NOT NULL DEFAULT 0,
    margin_percent DECIMAL(5,2) NOT NULL DEFAULT 0,
    
    -- Transaction counts
    transaction_count INT NOT NULL DEFAULT 0,
    units_sold INT NOT NULL DEFAULT 0,
    
    -- Category breakdown
    beverage_revenue DECIMAL(10,2) DEFAULT 0,
    beverage_units INT DEFAULT 0,
    snack_revenue DECIMAL(10,2) DEFAULT 0,
    snack_units INT DEFAULT 0,
    other_revenue DECIMAL(10,2) DEFAULT 0,
    other_units INT DEFAULT 0,
    
    -- Payment method breakdown
    card_transactions INT DEFAULT 0,
    nfc_transactions INT DEFAULT 0,
    cash_transactions INT DEFAULT 0,
    
    -- Time patterns (array of 24 hourly counts)
    hourly_sales INT[] DEFAULT ARRAY[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    
    -- Peak metrics
    peak_hour INT,
    peak_hour_revenue DECIMAL(10,2),
    
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    
    UNIQUE(machine_id, date)
);

-- =====================================================
-- PRODUCT VELOCITY TABLE
-- Tracks sales velocity per product per machine
-- =====================================================
CREATE TABLE IF NOT EXISTS product_velocity (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    machine_id UUID NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
    product_id UUID NOT NULL,
    product_name VARCHAR(255),
    
    -- Rolling window metrics
    units_7d INT DEFAULT 0,
    units_14d INT DEFAULT 0,
    units_30d INT DEFAULT 0,
    
    revenue_7d DECIMAL(10,2) DEFAULT 0,
    revenue_30d DECIMAL(10,2) DEFAULT 0,
    
    -- Calculated velocity (units per day)
    velocity_7d DECIMAL(10,4) DEFAULT 0,
    velocity_30d DECIMAL(10,4) DEFAULT 0,
    
    -- Last sale info
    last_sold_at TIMESTAMPTZ,
    
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    
    UNIQUE(machine_id, product_id)
);

-- =====================================================
-- SLOT PERFORMANCE TABLE
-- Position-based analytics
-- =====================================================
CREATE TABLE IF NOT EXISTS slot_analytics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    machine_id UUID NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
    slot_id UUID NOT NULL REFERENCES slots(id) ON DELETE CASCADE,
    position_code VARCHAR(10) NOT NULL,
    zone VARCHAR(50),
    
    -- 30-day rolling metrics
    units_sold_30d INT DEFAULT 0,
    revenue_30d DECIMAL(10,2) DEFAULT 0,
    
    -- Performance score (0-100 normalized)
    performance_score INT DEFAULT 50,
    
    -- Comparison to zone average
    vs_zone_avg DECIMAL(5,2) DEFAULT 0,  -- percentage difference
    
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    
    UNIQUE(machine_id, slot_id)
);

-- =====================================================
-- INDEXES FOR PERFORMANCE
-- =====================================================
CREATE INDEX IF NOT EXISTS idx_transactions_machine ON transactions(machine_id);
CREATE INDEX IF NOT EXISTS idx_transactions_time ON transactions(transaction_time);
CREATE INDEX IF NOT EXISTS idx_transactions_machine_time ON transactions(machine_id, transaction_time);
CREATE INDEX IF NOT EXISTS idx_transactions_slot ON transactions(slot_id);
CREATE INDEX IF NOT EXISTS idx_transactions_product ON transactions(product_id);
CREATE INDEX IF NOT EXISTS idx_transactions_payment ON transactions(payment_method);

CREATE INDEX IF NOT EXISTS idx_daily_summary_machine ON daily_sales_summary(machine_id);
CREATE INDEX IF NOT EXISTS idx_daily_summary_date ON daily_sales_summary(date);
CREATE INDEX IF NOT EXISTS idx_daily_summary_machine_date ON daily_sales_summary(machine_id, date DESC);

CREATE INDEX IF NOT EXISTS idx_velocity_machine ON product_velocity(machine_id);
CREATE INDEX IF NOT EXISTS idx_velocity_product ON product_velocity(product_id);
CREATE INDEX IF NOT EXISTS idx_velocity_30d ON product_velocity(velocity_30d DESC);

CREATE INDEX IF NOT EXISTS idx_slot_analytics_machine ON slot_analytics(machine_id);
CREATE INDEX IF NOT EXISTS idx_slot_analytics_score ON slot_analytics(performance_score DESC);

-- =====================================================
-- VIEWS FOR COMMON QUERIES
-- =====================================================

-- Machine sales overview
CREATE OR REPLACE VIEW v_machine_sales_overview AS
SELECT 
    m.id as machine_id,
    m.name as machine_name,
    m.status,
    l.name as location_name,
    COALESCE(today.total_revenue, 0) as today_revenue,
    COALESCE(today.transaction_count, 0) as today_transactions,
    COALESCE(week.total_revenue, 0) as week_revenue,
    COALESCE(week.transaction_count, 0) as week_transactions,
    COALESCE(month.total_revenue, 0) as month_revenue,
    COALESCE(month.transaction_count, 0) as month_transactions
FROM machines m
LEFT JOIN locations l ON m.location_id = l.id
LEFT JOIN daily_sales_summary today ON m.id = today.machine_id AND today.date = CURRENT_DATE
LEFT JOIN (
    SELECT machine_id, SUM(total_revenue) as total_revenue, SUM(transaction_count) as transaction_count
    FROM daily_sales_summary 
    WHERE date >= CURRENT_DATE - INTERVAL '7 days'
    GROUP BY machine_id
) week ON m.id = week.machine_id
LEFT JOIN (
    SELECT machine_id, SUM(total_revenue) as total_revenue, SUM(transaction_count) as transaction_count
    FROM daily_sales_summary 
    WHERE date >= CURRENT_DATE - INTERVAL '30 days'
    GROUP BY machine_id
) month ON m.id = month.machine_id;

-- Top products by velocity
CREATE OR REPLACE VIEW v_top_products AS
SELECT 
    pv.product_id,
    pv.product_name,
    SUM(pv.units_7d) as total_units_7d,
    SUM(pv.revenue_7d) as total_revenue_7d,
    AVG(pv.velocity_7d) as avg_velocity,
    COUNT(DISTINCT pv.machine_id) as machine_count
FROM product_velocity pv
GROUP BY pv.product_id, pv.product_name
ORDER BY total_units_7d DESC;

-- =====================================================
-- AGGREGATION FUNCTION
-- Call this daily via cron to update summaries
-- =====================================================
CREATE OR REPLACE FUNCTION aggregate_daily_sales(target_date DATE DEFAULT CURRENT_DATE)
RETURNS INT AS $$
DECLARE
    machines_processed INT := 0;
    machine_record RECORD;
    hourly INT[];
    peak INT;
    peak_rev DECIMAL(10,2);
    h INT;
BEGIN
    FOR machine_record IN SELECT id FROM machines LOOP
        -- Calculate hourly breakdown
        hourly := ARRAY(
            SELECT COALESCE(COUNT(*), 0)
            FROM generate_series(0, 23) AS hour
            LEFT JOIN transactions t ON 
                t.machine_id = machine_record.id 
                AND DATE(t.transaction_time) = target_date
                AND EXTRACT(HOUR FROM t.transaction_time) = hour
            GROUP BY hour
            ORDER BY hour
        );
        
        -- Find peak hour
        peak := 0;
        peak_rev := 0;
        FOR h IN 0..23 LOOP
            IF hourly[h+1] > peak THEN
                peak := h;
                peak_rev := (SELECT COALESCE(SUM(total), 0) FROM transactions 
                    WHERE machine_id = machine_record.id 
                    AND DATE(transaction_time) = target_date
                    AND EXTRACT(HOUR FROM transaction_time) = h);
            END IF;
        END LOOP;
        
        INSERT INTO daily_sales_summary (
            machine_id, date,
            total_revenue, transaction_count, units_sold,
            beverage_revenue, beverage_units,
            snack_revenue, snack_units,
            other_revenue, other_units,
            card_transactions, nfc_transactions, cash_transactions,
            hourly_sales, peak_hour, peak_hour_revenue
        )
        SELECT 
            machine_record.id,
            target_date,
            COALESCE(SUM(total), 0),
            COUNT(*),
            COALESCE(SUM(quantity), 0),
            COALESCE(SUM(CASE WHEN product_category IN ('beverages', 'Drinks', 'Energy') THEN total ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN product_category IN ('beverages', 'Drinks', 'Energy') THEN quantity ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN product_category IN ('snacks', 'Snacks', 'Candy') THEN total ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN product_category IN ('snacks', 'Snacks', 'Candy') THEN quantity ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN product_category NOT IN ('beverages', 'Drinks', 'Energy', 'snacks', 'Snacks', 'Candy') THEN total ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN product_category NOT IN ('beverages', 'Drinks', 'Energy', 'snacks', 'Snacks', 'Candy') THEN quantity ELSE 0 END), 0),
            COUNT(CASE WHEN payment_method = 'card' THEN 1 END),
            COUNT(CASE WHEN payment_method = 'nfc' THEN 1 END),
            COUNT(CASE WHEN payment_method = 'cash' THEN 1 END),
            hourly,
            peak,
            peak_rev
        FROM transactions
        WHERE machine_id = machine_record.id AND DATE(transaction_time) = target_date
        ON CONFLICT (machine_id, date) DO UPDATE SET
            total_revenue = EXCLUDED.total_revenue,
            transaction_count = EXCLUDED.transaction_count,
            units_sold = EXCLUDED.units_sold,
            beverage_revenue = EXCLUDED.beverage_revenue,
            beverage_units = EXCLUDED.beverage_units,
            snack_revenue = EXCLUDED.snack_revenue,
            snack_units = EXCLUDED.snack_units,
            other_revenue = EXCLUDED.other_revenue,
            other_units = EXCLUDED.other_units,
            card_transactions = EXCLUDED.card_transactions,
            nfc_transactions = EXCLUDED.nfc_transactions,
            cash_transactions = EXCLUDED.cash_transactions,
            hourly_sales = EXCLUDED.hourly_sales,
            peak_hour = EXCLUDED.peak_hour,
            peak_hour_revenue = EXCLUDED.peak_hour_revenue,
            updated_at = NOW();
        
        machines_processed := machines_processed + 1;
    END LOOP;
    
    RETURN machines_processed;
END;
$$ LANGUAGE plpgsql;

-- =====================================================
-- Migration version tracking
-- =====================================================
INSERT INTO schema_migrations (version) VALUES ('002_transactions')
ON CONFLICT (version) DO NOTHING;
