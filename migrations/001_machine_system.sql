-- =====================================================
-- Kande VendTech Machine Management System
-- Phase 1: Foundation Schema
-- =====================================================
-- Created: February 2026
-- Based on: machine-system/DESIGN.md
-- =====================================================

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- =====================================================
-- LOCATIONS TABLE
-- =====================================================
CREATE TABLE IF NOT EXISTS locations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    address TEXT NOT NULL,
    city VARCHAR(100) NOT NULL DEFAULT 'Las Vegas',
    state VARCHAR(2) NOT NULL DEFAULT 'NV',
    zip VARCHAR(10),
    coordinates POINT,
    zone VARCHAR(50),  -- Geographic zone for routing
    location_type VARCHAR(50) NOT NULL DEFAULT 'other',
    -- Valid types: rec_center, hospital_er, k12_school, manufacturing, 
    -- luxury_apartment, warehouse, office, senior_living, hotel, other
    
    employee_count INT,
    operating_hours JSONB,  -- {"mon": {"open": "06:00", "close": "22:00"}, ...}
    
    -- Contact info
    contact_name VARCHAR(255),
    contact_phone VARCHAR(20),
    contact_email VARCHAR(255),
    
    -- Prospect link (if converted from CRM)
    prospect_id INT,
    
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- MACHINES TABLE
-- =====================================================
CREATE TABLE IF NOT EXISTS machines (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    serial_number VARCHAR(100) UNIQUE NOT NULL,
    model VARCHAR(100) NOT NULL DEFAULT 'SandStar AI Smart Cooler',
    
    -- Location reference
    location_id UUID REFERENCES locations(id) ON DELETE SET NULL,
    
    -- Configuration
    config JSONB NOT NULL DEFAULT '{
        "rows": 6,
        "columnsPerRow": 8,
        "totalSlots": 48,
        "hasPaymentTerminal": true,
        "paymentTypes": ["credit_card", "nfc"],
        "temperatureZones": ["refrigerated"]
    }',
    
    -- Status: active, maintenance, offline, pulled, pending_install
    status VARCHAR(50) NOT NULL DEFAULT 'pending_install',
    
    -- Timestamps
    last_online TIMESTAMPTZ,
    last_restock TIMESTAMPTZ,
    last_maintenance TIMESTAMPTZ,
    
    -- Agreement details
    agreement JSONB DEFAULT '{
        "revSharePercent": 0,
        "revShareStartDate": null,
        "isExclusive": false
    }',
    
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- PRODUCTS EXTENDED TABLE
-- Extends existing product catalog with vending-specific data
-- =====================================================
CREATE TABLE IF NOT EXISTS products_extended (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- Core product info (can sync from existing catalog)
    name VARCHAR(255) NOT NULL,
    brand VARCHAR(100),
    category VARCHAR(50) NOT NULL,
    -- Valid categories: beverages, snacks, candy, healthy, incidentals, fresh
    subcategory VARCHAR(100),
    image_url TEXT,
    upc VARCHAR(50) UNIQUE,
    
    -- Pricing
    wholesale_cost DECIMAL(10,2) NOT NULL,
    suggested_retail DECIMAL(10,2),
    competitive_price DECIMAL(10,2),  -- 7-Eleven benchmark
    default_vending_price DECIMAL(10,2) NOT NULL,
    
    -- Calculated margin (stored for performance)
    margin_percent DECIMAL(5,2) GENERATED ALWAYS AS (
        CASE WHEN default_vending_price > 0 
        THEN ((default_vending_price - wholesale_cost) / default_vending_price * 100)
        ELSE 0 END
    ) STORED,
    
    -- Product attributes
    attributes JSONB DEFAULT '{
        "isHealthy": false,
        "isOrganic": false,
        "isGlutenFree": false,
        "isVegan": false,
        "calories": null,
        "size": "",
        "weight": null,
        "shelfLifeDays": 365,
        "requiresRefrigeration": false
    }',
    
    -- Placement strategy
    placement JSONB DEFAULT '{
        "targetZone": "eye_level",
        "isPremium": false,
        "isImpulseBuy": false,
        "canBeDecoy": false,
        "canBeAnchor": false,
        "bundleCompatible": []
    }',
    
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- SLOTS TABLE
-- Per-machine slot configuration and inventory
-- =====================================================
CREATE TABLE IF NOT EXISTS slots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    machine_id UUID NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
    
    -- Position
    position_code VARCHAR(10) NOT NULL,  -- "A1", "B3", etc.
    row_num INT NOT NULL,
    column_num INT NOT NULL,
    zone VARCHAR(50) NOT NULL DEFAULT 'center',
    -- Valid zones: eye_level, reach_level, bend_level, payment_adj, corner, center
    
    -- Product assignment (nullable = empty slot)
    product_id UUID REFERENCES products_extended(id),
    
    -- Inventory tracking
    current_quantity INT NOT NULL DEFAULT 0,
    capacity INT NOT NULL DEFAULT 10,
    restock_trigger INT NOT NULL DEFAULT 3,  -- Alert when qty <= this
    
    -- Expiration tracking
    earliest_expiry DATE,
    expiry_batches JSONB DEFAULT '[]',  -- [{quantity: 5, expiryDate: "2026-04-15"}]
    
    -- Per-slot pricing override
    custom_price DECIMAL(10,2),
    use_default_price BOOLEAN DEFAULT TRUE,
    
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    
    UNIQUE(machine_id, position_code)
);

-- =====================================================
-- PRICING STRATEGIES TABLE
-- =====================================================
CREATE TABLE IF NOT EXISTS pricing_strategies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    machine_id UUID REFERENCES machines(id) ON DELETE CASCADE,
    
    name VARCHAR(255) NOT NULL,
    strategy_type VARCHAR(50) NOT NULL,
    -- Valid types: decoy, anchoring, time_based, bundle, margin_optimization
    
    -- Strategy configuration (varies by type)
    config JSONB NOT NULL,
    
    -- Target slots/products
    target_slots UUID[] DEFAULT '{}',
    target_products UUID[] DEFAULT '{}',
    
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- RESTOCK HISTORY TABLE
-- =====================================================
CREATE TABLE IF NOT EXISTS restock_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slot_id UUID NOT NULL REFERENCES slots(id) ON DELETE CASCADE,
    machine_id UUID NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
    
    quantity_added INT NOT NULL,
    previous_quantity INT NOT NULL,
    new_quantity INT NOT NULL,
    
    expiry_date DATE,
    restocked_by VARCHAR(255),  -- User ID or name
    notes TEXT,
    
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- ALERTS TABLE
-- =====================================================
CREATE TABLE IF NOT EXISTS alerts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    machine_id UUID NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
    slot_id UUID REFERENCES slots(id) ON DELETE CASCADE,  -- null = machine-level alert
    
    alert_type VARCHAR(50) NOT NULL,
    -- Valid types: low_stock, out_of_stock, expiring_soon, expired, 
    -- low_performance, machine_offline, payment_error, temperature_alert, 
    -- pull_recommendation, restock_needed
    
    severity VARCHAR(20) NOT NULL DEFAULT 'warning',
    -- Valid: info, warning, critical
    
    title VARCHAR(255) NOT NULL,
    message TEXT,
    
    context JSONB DEFAULT '{}',  -- Additional context data
    
    status VARCHAR(50) DEFAULT 'active',
    -- Valid: active, acknowledged, resolved, snoozed
    
    acknowledged_at TIMESTAMPTZ,
    acknowledged_by VARCHAR(255),
    resolved_at TIMESTAMPTZ,
    resolved_by VARCHAR(255),
    
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- PERFORMANCE AGGREGATION TABLES (for Phase 3)
-- =====================================================
CREATE TABLE IF NOT EXISTS slot_performance_daily (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slot_id UUID NOT NULL REFERENCES slots(id) ON DELETE CASCADE,
    machine_id UUID NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
    date DATE NOT NULL,
    
    units_sold INT DEFAULT 0,
    revenue DECIMAL(10,2) DEFAULT 0,
    margin DECIMAL(10,2) DEFAULT 0,
    
    UNIQUE(slot_id, date)
);

CREATE TABLE IF NOT EXISTS machine_performance_daily (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    machine_id UUID NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
    date DATE NOT NULL,
    
    total_revenue DECIMAL(10,2) DEFAULT 0,
    total_cogs DECIMAL(10,2) DEFAULT 0,
    transaction_count INT DEFAULT 0,
    unique_products_sold INT DEFAULT 0,
    
    beverage_revenue DECIMAL(10,2) DEFAULT 0,
    snack_revenue DECIMAL(10,2) DEFAULT 0,
    incidental_revenue DECIMAL(10,2) DEFAULT 0,
    
    stockout_incidents INT DEFAULT 0,
    spoilage_amount DECIMAL(10,2) DEFAULT 0,
    
    UNIQUE(machine_id, date)
);

-- =====================================================
-- INDEXES
-- =====================================================
CREATE INDEX IF NOT EXISTS idx_machines_location ON machines(location_id);
CREATE INDEX IF NOT EXISTS idx_machines_status ON machines(status);
CREATE INDEX IF NOT EXISTS idx_slots_machine ON slots(machine_id);
CREATE INDEX IF NOT EXISTS idx_slots_product ON slots(product_id);
CREATE INDEX IF NOT EXISTS idx_slots_zone ON slots(zone);
CREATE INDEX IF NOT EXISTS idx_restock_machine ON restock_history(machine_id);
CREATE INDEX IF NOT EXISTS idx_restock_slot ON restock_history(slot_id);
CREATE INDEX IF NOT EXISTS idx_restock_date ON restock_history(created_at);
CREATE INDEX IF NOT EXISTS idx_alerts_machine_status ON alerts(machine_id, status);
CREATE INDEX IF NOT EXISTS idx_alerts_created ON alerts(created_at);
CREATE INDEX IF NOT EXISTS idx_slot_perf_date ON slot_performance_daily(date);
CREATE INDEX IF NOT EXISTS idx_machine_perf_date ON machine_performance_daily(date);
CREATE INDEX IF NOT EXISTS idx_products_category ON products_extended(category);
CREATE INDEX IF NOT EXISTS idx_products_active ON products_extended(is_active);

-- =====================================================
-- HELPER FUNCTIONS
-- =====================================================

-- Calculate slot zone based on row/column position
CREATE OR REPLACE FUNCTION calculate_slot_zone(row_num INT, col_num INT, total_rows INT, total_cols INT)
RETURNS VARCHAR(50) AS $$
BEGIN
    -- Eye level (rows 3-4 for standard 6-row machine)
    IF row_num >= (total_rows / 2) - 1 AND row_num <= (total_rows / 2) THEN
        -- Check if payment adjacent (rightmost columns)
        IF col_num >= total_cols - 1 THEN
            RETURN 'payment_adj';
        END IF;
        RETURN 'eye_level';
    END IF;
    
    -- Reach level (top rows)
    IF row_num <= 2 THEN
        RETURN 'reach_level';
    END IF;
    
    -- Bend level (bottom rows)
    IF row_num >= total_rows - 1 THEN
        RETURN 'bend_level';
    END IF;
    
    -- Payment adjacent
    IF col_num >= total_cols - 1 THEN
        RETURN 'payment_adj';
    END IF;
    
    -- Corner positions
    IF (col_num = 1 OR col_num = total_cols) AND (row_num = 1 OR row_num = total_rows) THEN
        RETURN 'corner';
    END IF;
    
    RETURN 'center';
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Auto-create slots for a new machine
CREATE OR REPLACE FUNCTION create_machine_slots()
RETURNS TRIGGER AS $$
DECLARE
    rows INT;
    cols INT;
    row_letter CHAR(1);
    r INT;
    c INT;
    zone_name VARCHAR(50);
BEGIN
    -- Get config from the new machine
    rows := COALESCE((NEW.config->>'rows')::INT, 6);
    cols := COALESCE((NEW.config->>'columnsPerRow')::INT, 8);
    
    -- Create slots for each position
    FOR r IN 1..rows LOOP
        row_letter := CHR(64 + r);  -- A, B, C, etc.
        FOR c IN 1..cols LOOP
            zone_name := calculate_slot_zone(r, c, rows, cols);
            
            INSERT INTO slots (
                machine_id, position_code, row_num, column_num, zone, capacity
            ) VALUES (
                NEW.id,
                row_letter || c::TEXT,
                r,
                c,
                zone_name,
                10  -- Default capacity
            );
        END LOOP;
    END LOOP;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to auto-create slots when machine is created
DROP TRIGGER IF EXISTS trigger_create_machine_slots ON machines;
CREATE TRIGGER trigger_create_machine_slots
    AFTER INSERT ON machines
    FOR EACH ROW
    EXECUTE FUNCTION create_machine_slots();

-- =====================================================
-- VIEWS FOR COMMON QUERIES
-- =====================================================

-- Machine overview with calculated stats
CREATE OR REPLACE VIEW v_machine_overview AS
SELECT 
    m.id,
    m.name,
    m.serial_number,
    m.model,
    m.status,
    m.last_online,
    m.last_restock,
    l.name as location_name,
    l.address as location_address,
    l.location_type,
    COUNT(s.id) as total_slots,
    COUNT(CASE WHEN s.product_id IS NOT NULL AND s.is_active THEN 1 END) as active_slots,
    COUNT(CASE WHEN s.current_quantity <= s.restock_trigger AND s.product_id IS NOT NULL THEN 1 END) as low_stock_slots,
    COUNT(CASE WHEN s.current_quantity = 0 AND s.product_id IS NOT NULL THEN 1 END) as out_of_stock_slots,
    COUNT(CASE WHEN s.earliest_expiry <= CURRENT_DATE + INTERVAL '7 days' THEN 1 END) as expiring_slots
FROM machines m
LEFT JOIN locations l ON m.location_id = l.id
LEFT JOIN slots s ON m.id = s.machine_id
GROUP BY m.id, l.id;

-- Slot inventory view with product details
CREATE OR REPLACE VIEW v_slot_inventory AS
SELECT 
    s.id as slot_id,
    s.machine_id,
    s.position_code,
    s.row_num,
    s.column_num,
    s.zone,
    s.current_quantity,
    s.capacity,
    s.restock_trigger,
    s.earliest_expiry,
    CASE 
        WHEN s.use_default_price THEN p.default_vending_price
        ELSE s.custom_price
    END as effective_price,
    p.id as product_id,
    p.name as product_name,
    p.brand as product_brand,
    p.category as product_category,
    p.wholesale_cost,
    p.margin_percent,
    p.image_url,
    CASE 
        WHEN s.current_quantity = 0 THEN 'out_of_stock'
        WHEN s.current_quantity <= s.restock_trigger THEN 'low_stock'
        WHEN s.earliest_expiry <= CURRENT_DATE + INTERVAL '7 days' THEN 'expiring_soon'
        ELSE 'ok'
    END as status
FROM slots s
LEFT JOIN products_extended p ON s.product_id = p.id
WHERE s.is_active = TRUE;

-- =====================================================
-- SEED DATA FOR TESTING (Optional)
-- =====================================================
-- Uncomment to seed test data

/*
-- Insert test location
INSERT INTO locations (name, address, city, state, zip, location_type, employee_count)
VALUES 
    ('Downtown Recreation Center', '1234 Main St', 'Las Vegas', 'NV', '89101', 'rec_center', 50),
    ('Sunrise Hospital ER', '3186 S Maryland Pkwy', 'Las Vegas', 'NV', '89109', 'hospital_er', 200);

-- Insert test machine
INSERT INTO machines (name, serial_number, model, location_id, status)
SELECT 
    'Downtown Rec Center #1',
    'SS2024-0142',
    'SandStar AI Smart Cooler',
    id,
    'active'
FROM locations WHERE name = 'Downtown Recreation Center';
*/

-- =====================================================
-- Migration version tracking
-- =====================================================
CREATE TABLE IF NOT EXISTS schema_migrations (
    version VARCHAR(255) PRIMARY KEY,
    applied_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO schema_migrations (version) VALUES ('001_machine_system')
ON CONFLICT (version) DO NOTHING;
