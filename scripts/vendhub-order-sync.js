#!/usr/bin/env node
// =============================================================================
// VendHub → Kande Dashboard Order Sync
// Runs daily — checks for new VendHub orders and auto-imports them
// =============================================================================
const { chromium } = require('/opt/homebrew/lib/node_modules/playwright');
const https = require('https');
const http = require('http');

const VENDHUB_EMAIL = 'kurtis.hon@gmail.com';
const VENDHUB_PASS  = 'Lanie123##';
const DASHBOARD_URL = 'https://vend.kandedash.com';
const DASHBOARD_PW  = 'kande2026';
const TELEGRAM_CHAT = '-4992441037';
const LOG_FILE      = '/Users/kurtishon/clawd/logs/vendhub-sync.log';

const fs   = require('fs');
const path = require('path');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

// Simple HTTP/S request helper
function request(method, url, data, cookieJar = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, method,
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Jarvis/1.0' }
    };
    const cookieStr = Object.entries(cookieJar).map(([k,v]) => `${k}=${v}`).join('; ');
    if (cookieStr) opts.headers['Cookie'] = cookieStr;
    if (data) opts.headers['Content-Length'] = Buffer.byteLength(JSON.stringify(data));

    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(opts, res => {
      // Capture set-cookie headers
      const cookies = res.headers['set-cookie'] || [];
      cookies.forEach(c => {
        const [kv] = c.split(';');
        const [k, v] = kv.split('=');
        if (k && v) cookieJar[k.trim()] = v.trim();
      });
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(body), cookies: cookieJar }); }
        catch { resolve({ status: res.statusCode, body, cookies: cookieJar }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(JSON.stringify(data));
    req.end();
  });
}

async function sendTelegram(msg) {
  try {
    // Use openclaw CLI to send
    const { execSync } = require('child_process');
    execSync(`openclaw message send --channel telegram --target ${TELEGRAM_CHAT} --message ${JSON.stringify(msg)}`, { timeout: 15000 });
  } catch (e) {
    log(`Telegram send failed: ${e.message}`);
  }
}

async function getDashboardOrders(cookies) {
  const r = await request('GET', `${DASHBOARD_URL}/api/order-receipts`, null, cookies);
  return Array.isArray(r.body) ? r.body : [];
}

async function authDashboard() {
  const cookies = {};
  await request('POST', `${DASHBOARD_URL}/api/auth/login`, { password: DASHBOARD_PW }, cookies);
  return cookies;
}

async function importOrderToDashboard(order, dashCookies) {
  const r = await request('POST', `${DASHBOARD_URL}/api/order-receipts`, order, dashCookies);
  if (r.status === 409) return { skipped: true, reason: 'already exists' };
  if (r.status === 200 || r.status === 201) return { imported: true, id: r.body.id };
  return { error: true, status: r.status, body: r.body };
}

// Extract order financials and items from a VendHub order page
// Fetch the actual case pack count from the VendHub product page.
// This is the ONLY authoritative source for units_per_case — never guess or back-calculate.
async function fetchCasePack(page, vendhubProductId) {
  if (!vendhubProductId) return null;
  try {
    await page.goto(`https://www.vendhubhq.com/market/products/${vendhubProductId}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(1500);
    const result = await page.evaluate(() => {
      const t = document.body.innerText;
      const i = t.indexOf('Case Pack');
      if (i < 0) return null;
      const chunk = t.substring(i, i + 60);
      // Match patterns like "Case Pack\n24 items" or "Case Pack\n6 (24ct) boxes"
      const m = chunk.match(/Case Pack\s*\n?\s*(\d+)\s*(?:\((\d+)ct\))?/);
      if (!m) return null;
      // If format is "6 (24ct) boxes", total items = 6 * 24
      if (m[2]) return parseInt(m[1]) * parseInt(m[2]);
      return parseInt(m[1]);
    });
    return result;
  } catch (e) {
    return null;
  }
}

async function scrapeOrderDetails(page, orderId) {
  await page.goto(`https://www.vendhubhq.com/market/orders/${orderId}`, {
    waitUntil: 'domcontentloaded', timeout: 20000
  });
  await page.waitForTimeout(2000);

  return await page.evaluate(() => {
    const text = document.body.innerText;

    // Financial summary
    const num = s => { const m = text.match(new RegExp(s + '\\n\\n\\$?([\\d,.-]+)')); return m ? parseFloat(m[1].replace(/,/g,'')) : null; };
    const subtotal       = num('Subtotal');
    const fuel_surcharge = num('Fuel Surcharge');
    const discount       = num('Discount');
    const service_charge = num('Service Charge');
    const credit         = num('Credit');
    const total_charged  = num('Total Charged');
    const tax_exempt     = text.includes('Tax Exempt');

    // Order ref
    const refMatch = text.match(/#([a-f0-9]{20,})/);
    const vendhub_order_ref = refMatch ? refMatch[1] : null;

    // Payment date
    const payMatch = text.match(/Payment Date\n+(\d+\/\d+\/\d+)/);
    const payment_date = payMatch ? payMatch[1] : null;

    // Order date (from breadcrumb / placed date)
    const dateMatch = text.match(/Placed on ([A-Za-z]+ \d+, \d+)/);
    let order_date = null;
    if (dateMatch) {
      try { order_date = new Date(dateMatch[1]).toISOString().split('T')[0]; } catch {}
    }

    // Items
    const items = [];
    const seen = new Set();
    document.querySelectorAll('main a[href*="/market/products/"]').forEach(link => {
      const name = link.innerText.trim();
      if (!name || seen.has(name)) return;
      seen.add(name);
      const container = link.closest('div[class]');
      if (!container) return;
      const t = container.innerText;
      const qtyM     = t.match(/QTY:\s*([\d.]+)/);
      const priceM   = t.match(/Price:\s*\$([\d.]+)/);
      const totalM   = t.match(/\$([\d.]+)\s*\n\s*Invoiced Total/);
      const unitsM   = t.match(/(\d+)ct/);
      const sizeM    = link.closest('div')?.closest('div')?.innerText.match(/\(([\d.]+ oz)\)/);
      const vendhubId = link.href.match(/products\/([a-f0-9-]+)/)?.[1];
      items.push({
        product_name:  name,
        vendhub_id:    vendhubId || null,
        unit_size:     sizeM ? sizeM[1] : null,
        units_per_case: unitsM ? parseInt(unitsM[1]) : null,
        cases:         qtyM   ? parseFloat(qtyM[1])   : 0,
        cases_shipped: qtyM   ? parseFloat(qtyM[1])   : 0,
        price_per_case: priceM ? parseFloat(priceM[1]) : 0,
        price_per_unit: (priceM && unitsM) ? Math.round(parseFloat(priceM[1]) / parseInt(unitsM[1]) * 100) / 100 : null,
        total:         totalM ? parseFloat(totalM[1]) : 0,
      });
    });

    return { vendhub_order_ref, order_date, payment_date, subtotal, fuel_surcharge, discount, service_charge, credit, total_charged, tax_exempt, items };
  });
}

(async () => {
  log('===== VendHub order sync starting =====');

  // 1. Auth to dashboard and get existing order IDs
  log('Authenticating to dashboard...');
  const dashCookies = await authDashboard();
  const existing = await getDashboardOrders(dashCookies);
  const existingIds = new Set(existing.map(r => r.vendhub_order_id).filter(Boolean));
  log(`Dashboard has ${existing.length} existing order receipts`);

  // 2. Launch browser and log into VendHub
  log('Launching browser, logging into VendHub...');
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  try {
    // Login flow — use Enter key to avoid clicking Google SSO button by mistake
    await page.goto('https://www.vendhubhq.com/sign-in', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('input[placeholder="Enter your email address"]', { timeout: 10000 });
    await page.fill('input[placeholder="Enter your email address"]', VENDHUB_EMAIL);
    await page.press('input[placeholder="Enter your email address"]', 'Enter');
    await page.waitForURL('**/factor-one**', { timeout: 10000 });
    await page.waitForSelector('input[placeholder="Enter your password"]', { timeout: 10000 });
    await page.waitForTimeout(500);
    await page.fill('input[placeholder="Enter your password"]', VENDHUB_PASS);
    await page.press('input[placeholder="Enter your password"]', 'Enter');
    await page.waitForURL(url => !url.includes('sign-in'), { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2000);
    log('Logged in to VendHub');

    // 3. Navigate to orders page and extract order IDs from page text
    await page.goto('https://www.vendhubhq.com/market/orders', { waitUntil: 'networkidle', timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(3000);

    const orderIds = await page.evaluate(() => {
      const text = document.body.innerText;
      const ids = new Set();
      // Match UUIDs following ORDER ID label
      const regex = /#([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/g;
      let m;
      while ((m = regex.exec(text)) !== null) ids.add(m[1]);
      // Also check any href patterns
      document.querySelectorAll('[href*="/market/orders/"]').forEach(el => {
        const hm = el.href.match(/orders\/([a-f0-9-]{36})/);
        if (hm) ids.add(hm[1]);
      });
      return [...ids];
    });

    log(`Found ${orderIds.length} order(s) on VendHub`);

    // 4. Find new orders not yet in dashboard
    const newOrderIds = orderIds.filter(id => !existingIds.has(id));
    log(`${newOrderIds.length} new order(s) to import`);

    if (newOrderIds.length === 0) {
      log('Nothing new to import.');
      await browser.close();
      await sendTelegram('📦 VendHub order sync: no new orders (checked ' + orderIds.length + ' total)');
      return;
    }

    // 5. Scrape and import each new order
    const imported = [];
    const failed   = [];

    for (const orderId of newOrderIds) {
      log(`Scraping order ${orderId}...`);
      try {
        const details = await scrapeOrderDetails(page, orderId);
        
        // Cross-reference product IDs from dashboard
        const products = await request('GET', `${DASHBOARD_URL}/api/products`, null, dashCookies);
        const prodList = Array.isArray(products.body) ? products.body : [];
        const nameMap = {};
        const vidMap  = {};
        prodList.forEach(p => {
          nameMap[p.name] = p;
          if (p.vendhub_id) vidMap[p.vendhub_id] = p;
        });

        // Fetch authoritative case pack from each product's VendHub page
        // This is mandatory — do NOT use order-page values which are unreliable
        log(`  Fetching case pack sizes from VendHub product pages...`);
        const enrichedItems = [];
        for (const item of details.items) {
          const prod = vidMap[item.vendhub_id] || nameMap[item.product_name];
          let casePack = null;
          if (item.vendhub_id) {
            casePack = await fetchCasePack(page, item.vendhub_id);
            if (casePack) {
              log(`    ${item.product_name}: ${casePack} per case (from VendHub product page)`);
            } else {
              log(`    ${item.product_name}: case pack not found on product page — check manually`);
            }
          }
          const units_per_case = casePack || prod?.units_per_case || null;
          const total_units = units_per_case ? item.cases * units_per_case : null;
          const price_per_unit = (total_units && item.total) ? Math.round((item.total / total_units) * 10000) / 10000 : (item.price_per_unit || prod?.price_per_unit || null);
          enrichedItems.push({
            ...item,
            product_id:    prod?.id    || null,
            item_number:   prod?.item_number || null,
            unit_size:     item.unit_size    || prod?.unit_size    || null,
            units_per_case,
            price_per_unit,
            thumbnail:     prod?.thumbnail || null,
          });
        }

        const receipt = {
          vendhub_order_id:  orderId,
          vendhub_order_ref: details.vendhub_order_ref,
          supplier:          'Vistar',
          order_date:        details.order_date,
          payment_date:      details.payment_date,
          subtotal:          details.subtotal,
          fuel_surcharge:    details.fuel_surcharge,
          discount:          details.discount,
          service_charge:    details.service_charge,
          tax:               0,
          tax_exempt:        details.tax_exempt,
          credit:            details.credit,
          total_charged:     details.total_charged,
          items:             enrichedItems,
        };

        const result = await importOrderToDashboard(receipt, dashCookies);
        if (result.imported) {
          log(`✓ Imported order ${orderId} → receipt #${result.id} (${enrichedItems.length} items)`);
          imported.push({ id: orderId, ref: details.vendhub_order_ref, items: enrichedItems.length, total: details.total_charged });
        } else if (result.skipped) {
          log(`⟳ Skipped order ${orderId}: ${result.reason}`);
        } else {
          log(`✗ Failed order ${orderId}: ${JSON.stringify(result)}`);
          failed.push(orderId);
        }
      } catch (e) {
        log(`✗ Error scraping ${orderId}: ${e.message}`);
        failed.push(orderId);
      }
    }

    await browser.close();

    // 6. Report
    let msg = `📦 *VendHub Order Sync — ${new Date().toLocaleDateString()}*\n`;
    if (imported.length > 0) {
      msg += `✅ ${imported.length} new order(s) imported:\n`;
      imported.forEach(o => msg += `  • Ref #${o.ref || o.id.substring(0,8)} — ${o.items} items, $${o.total?.toFixed(2) || '?'}\n`);
    }
    if (failed.length > 0) {
      msg += `❌ ${failed.length} failed: ${failed.map(id => id.substring(0,8)).join(', ')}\n`;
    }
    if (imported.length === 0 && failed.length === 0) {
      msg += 'No new orders.';
    }
    msg += `_(checked ${orderIds.length} total orders on VendHub)_`;

    log(msg);
    await sendTelegram(msg);

  } catch (e) {
    log(`Fatal error: ${e.message}\n${e.stack}`);
    await browser.close();
    await sendTelegram(`❌ VendHub order sync failed: ${e.message}`);
    process.exit(1);
  }

  log('===== Sync complete =====');
})();
