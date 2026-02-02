#!/usr/bin/env node
/**
 * Import all VendHub products into Kande VendTech inventory database
 * Agent: Query (Data Engineering)
 */

const fs = require('fs');
const path = require('path');

const API_BASE = 'https://vend.kandedash.com/api';
const API_KEY = 'kande2026';
const BATCH_SIZE = 25; // concurrent requests per batch

// Load products from products.js
const src = fs.readFileSync(path.join(__dirname, 'products.js'), 'utf8');
const fn = new Function(src + '; return PRODUCTS;');
const PRODUCTS = fn();

console.log(`Loaded ${PRODUCTS.length} products from products.js`);

// Pricing rules - calculate sell price based on category and cost
function calculateSellPrice(category, cost) {
  if (cost <= 0) return 1.50; // minimum price
  
  const rules = {
    candy:                  { minPrice: 1.50, maxPrice: 3.50, minMargin: 0.35, targetMargin: 0.50 },
    snacks:                 { minPrice: 1.50, maxPrice: 3.50, minMargin: 0.35, targetMargin: 0.45 },
    cold_beverage:          { minPrice: 2.00, maxPrice: 4.00, minMargin: 0.40, targetMargin: 0.50 },
    hot_drink:              { minPrice: 1.50, maxPrice: 3.50, minMargin: 0.45, targetMargin: 0.60 },
    frozen_foods:           { minPrice: 2.00, maxPrice: 5.00, minMargin: 0.30, targetMargin: 0.40 },
    hot_foods:              { minPrice: 1.50, maxPrice: 4.00, minMargin: 0.35, targetMargin: 0.45 },
    refrigerated:           { minPrice: 2.00, maxPrice: 5.00, minMargin: 0.30, targetMargin: 0.40 },
    health_beauty:          { minPrice: 2.00, maxPrice: 6.00, minMargin: 0.35, targetMargin: 0.50 },
    specialty_better4you:   { minPrice: 2.00, maxPrice: 5.00, minMargin: 0.35, targetMargin: 0.45 },
  };

  const rule = rules[category] || { minPrice: 1.50, maxPrice: 4.00, minMargin: 0.35, targetMargin: 0.45 };
  
  // Calculate price at target margin
  let price = cost / (1 - rule.targetMargin);
  
  // Round to nearest $0.25
  price = Math.round(price * 4) / 4;
  
  // Clamp to min/max
  price = Math.max(rule.minPrice, Math.min(rule.maxPrice, price));
  
  // Ensure minimum margin
  if (price > 0 && cost > 0) {
    const actualMargin = (price - cost) / price;
    if (actualMargin < rule.minMargin) {
      price = cost / (1 - rule.minMargin);
      price = Math.round(price * 4) / 4;
      price = Math.max(rule.minPrice, price);
    }
  }
  
  return parseFloat(price.toFixed(2));
}

// Format category name for display
function formatCategory(cat) {
  const map = {
    candy: 'Candy',
    snacks: 'Snacks',
    cold_beverage: 'Beverages',
    hot_drink: 'Hot Drinks',
    frozen_foods: 'Frozen',
    hot_foods: 'Hot Foods',
    refrigerated: 'Refrigerated',
    health_beauty: 'Health & Beauty',
    specialty_better4you: 'Specialty/Health',
  };
  return map[cat] || cat;
}

// Transform VendHub product → inventory DB format
function transformProduct(p) {
  const cost = p.unitPrice || 0;
  const sellPrice = p.vendingPriceOverride || calculateSellPrice(p.category, cost);
  const margin = sellPrice > 0 ? Math.round(((sellPrice - cost) / sellPrice) * 100) : 0;

  return {
    name: p.name,
    brand: p.brand || '',
    size: p.size || '',
    category: formatCategory(p.category),
    cost: parseFloat(cost.toFixed(2)),
    cost_price: parseFloat(cost.toFixed(2)),
    sell_price: parseFloat(sellPrice.toFixed(2)),
    margin: margin,
    imageUrl: p.imageUrl || '',
    casePrice: p.casePrice || 0,
    unitCount: p.unitCount || 0,
    popularity: p.popularity || 0,
    vendhub_id: p.id,  // preserve original VendHub UUID
    source: 'vendhub',
  };
}

async function apiPost(endpoint, body) {
  const res = await fetch(`${API_BASE}${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`POST ${endpoint} failed (${res.status}): ${text}`);
  }
  return res.json();
}

async function apiGet(endpoint) {
  const res = await fetch(`${API_BASE}${endpoint}`, {
    headers: { 'x-api-key': API_KEY },
  });
  if (!res.ok) throw new Error(`GET ${endpoint} failed (${res.status})`);
  return res.json();
}

async function main() {
  // Check current products
  const existing = await apiGet('/products');
  console.log(`Current products in DB: ${existing.length}`);
  
  // Build set of existing product names to avoid duplicates
  const existingNames = new Set(existing.map(p => p.name?.toLowerCase()));
  const existingVendhubIds = new Set(existing.filter(p => p.vendhub_id).map(p => p.vendhub_id));
  
  // Transform all products
  const toImport = [];
  let skipped = 0;
  
  for (const p of PRODUCTS) {
    // Skip if already exists (by vendhub_id or name)
    if (existingVendhubIds.has(p.id) || existingNames.has(p.name?.toLowerCase())) {
      skipped++;
      continue;
    }
    toImport.push(transformProduct(p));
  }
  
  console.log(`Products to import: ${toImport.length} (skipping ${skipped} duplicates)`);
  
  if (toImport.length === 0) {
    console.log('Nothing to import!');
    return;
  }

  // Import in batches
  let imported = 0;
  let errors = 0;
  const startTime = Date.now();
  
  for (let i = 0; i < toImport.length; i += BATCH_SIZE) {
    const batch = toImport.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map(product => apiPost('/products', product))
    );
    
    for (const r of results) {
      if (r.status === 'fulfilled') imported++;
      else {
        errors++;
        if (errors <= 5) console.error('  Error:', r.reason.message);
      }
    }
    
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const pct = Math.round(((i + batch.length) / toImport.length) * 100);
    process.stdout.write(`\r  Progress: ${imported}/${toImport.length} imported (${pct}%) [${elapsed}s] errors: ${errors}`);
  }
  
  console.log('\n');
  
  // Verify final count
  const final = await apiGet('/products');
  console.log(`=== IMPORT COMPLETE ===`);
  console.log(`Imported: ${imported}`);
  console.log(`Errors: ${errors}`);
  console.log(`Skipped (duplicates): ${skipped}`);
  console.log(`Total products now in DB: ${final.length}`);
  console.log(`Expected: ${existing.length + imported}`);
  console.log(`Time: ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
