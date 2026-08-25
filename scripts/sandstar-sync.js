#!/usr/bin/env node
// =============================================================================
// Sandstar → Kande Dashboard Sync
// Uses Playwright to handle Sandstar auth, then Node HTTP for dashboard writes
// =============================================================================
const { chromium } = require('/opt/homebrew/lib/node_modules/playwright');
const https  = require('https');
const fs     = require('fs');
const { execSync } = require('child_process');

const SANDSTAR_EMAIL = 'etang106@gmail.com';
const SANDSTAR_PASS  = 'kurtis123####';
const SANDSTAR_ORG   = '001020';
const SANDSTAR_SCOPE = '12';
const SANDSTAR_API   = 'https://webapi-us.sandstar.com';

const DASHBOARD_URL  = 'https://vend.kandedash.com';
const DASHBOARD_PW   = 'kande2026';
const TELEGRAM_CHAT  = '-4992441037';
const LOG_FILE       = '/Users/kurtishon/clawd/logs/sandstar-sync.log';
const STATE_FILE     = '/Users/kurtishon/clawd/data/sandstar-sync-state.json';

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { syncedOrderNos: [], consecutiveErrors: 0 }; }
}
function saveState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }
function sendTelegram(msg) {
  try { execSync(`openclaw message send --channel telegram --target ${TELEGRAM_CHAT} --message ${JSON.stringify(msg)}`, { timeout: 15000 }); }
  catch (e) { log(`Telegram: ${e.message}`); }
}

// Dashboard API helper
function dashApi(method, path, body, cookies) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: 'vend.kandedash.com', port: 443, path, method,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': 'kande2026',
        'Cookie': Object.entries(cookies || {}).map(([k,v]) => `${k}=${v}`).join('; '),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
      }
    };
    const req = https.request(opts, res => {
      const sc = res.headers['set-cookie'] || [];
      sc.forEach(c => { const [kv] = c.split(';'); const [k,v] = kv.split('='); if (k&&v&&cookies) cookies[k.trim()] = v.trim(); });
      let b = '';
      res.on('data', d => b += d);
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve({ raw: b.substring(0,200) }); } });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  log('===== Sandstar sync starting =====');
  const state = loadState();

  // 1. Launch browser and log into Sandstar
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  // Poll localStorage for token — waits up to maxMs
  async function waitForToken(page, maxMs = 20000) {
    const interval = 500;
    for (let elapsed = 0; elapsed < maxMs; elapsed += interval) {
      const t = await page.evaluate(() => localStorage.getItem('token')).catch(() => null);
      if (t) return t;
      await page.waitForTimeout(interval);
    }
    return null;
  }

  // Login helper with retries
  async function doLogin(page, attempt) {
    log(`Login attempt ${attempt}...`);
    await page.goto('https://prod-ops-us.sandstar.com/#/pages/login/login', { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Wait for page to stabilise before touching DOM
    await page.waitForLoadState('domcontentloaded').catch(() => {});

    // Check if already past login (cached session)
    const existing = await waitForToken(page, 2000);
    if (existing) return existing;

    // Wait for the login form to render
    await page.waitForSelector('input[type="password"]', { timeout: 40000 });
    const idField = await page.$('input:not([type="password"])').catch(() => null);
    const pwField = await page.$('input[type="password"]').catch(() => null);
    if (!idField || !pwField) throw new Error('Login form fields not found');

    await idField.fill(SANDSTAR_EMAIL);
    await pwField.fill(SANDSTAR_PASS);
    await page.evaluate(() => {
      const btns = [...document.querySelectorAll('*')].filter(e =>
        e.textContent.trim() === 'Login' && getComputedStyle(e).cursor === 'pointer'
      );
      if (btns[0]) btns[0].click();
    });

    // Wait for URL to leave the login form page
    await page.waitForURL(url => !url.includes('pages/login/login'), { timeout: 15000 }).catch(() => {});
    await page.waitForLoadState('domcontentloaded').catch(() => {});

    // Select merchant if prompted
    const merchantCard = await page.$('text=Kande VendTech').catch(() => null);
    if (merchantCard) {
      await merchantCard.click();
      await page.waitForURL(url => !url.includes('login'), { timeout: 15000 }).catch(() => {});
      await page.waitForLoadState('domcontentloaded').catch(() => {});
    }

    // Poll for token — up to 10s
    return await waitForToken(page, 20000);
  }

  try {
    // Try login up to 3 times
    let token = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      token = await doLogin(page, attempt).catch(e => { log(`Login attempt ${attempt} error: ${e.message}`); return null; });
      if (token) break;
      if (attempt < 3) {
        const delay = attempt * 5000;
        log(`Retrying login in ${delay/1000}s...`);
        await page.waitForTimeout(delay);
      }
    }
    const organSn = await page.evaluate(() => localStorage.getItem('organSn'));
    if (!token) throw new Error('No token in localStorage after login');
    log(`Token obtained: ${token.substring(0,8)}...`);

    // 2. Pull today's orders directly via API date filter
    const _tnow = new Date();
    const _todayLocal = `${_tnow.getFullYear()}-${String(_tnow.getMonth()+1).padStart(2,'0')}-${String(_tnow.getDate()).padStart(2,'0')}`;
    const todayStart = `${_todayLocal} 00:00:00`;
    const todayEnd   = `${_todayLocal} 23:59:59`;
    log(`Fetching today-only orders (${_todayLocal})...`);
    const todayApiOrders = [];
    let todayPageNum = 1;
    while (true) {
      const todayData = await page.evaluate(async ({ api, org, scope, pn, ps, ts, te }) => {
        const h = { 'Content-Type': 'application/json', 'x-token': localStorage.getItem('token'), 'app-scope': scope, 'organSn': org };
        const res = await fetch(`${api}/order/v2/findOrderInfoList`, {
          method: 'POST', headers: h,
          body: JSON.stringify({ page: pn, pageNum: pn, pageSize: ps, commStatus: 10, phaseList: '3,4,5', zoneId: 'US/Pacific', startTime: ts, endTime: te })
        });
        return res.json();
      }, { api: SANDSTAR_API, org: SANDSTAR_ORG, scope: SANDSTAR_SCOPE, pn: todayPageNum, ps: 100, ts: todayStart, te: todayEnd });
      const rows = todayData?.data?.resultList || [];
      const rc = todayData?.data?.rowcount || 0;
      if (rows.length === 0) break;
      todayApiOrders.push(...rows);
      log(`  Today page ${todayPageNum}: ${rows.length} orders (${todayApiOrders.length}/${rc})`);
      if (todayApiOrders.length >= rc) break;
      todayPageNum++;
      if (todayPageNum > 20) break;
    }
    const getAmt = o => { const settled = parseFloat(o.statPaymentAmount || o.statOrderAmount || 0); if (settled > 0) return settled; const gross = parseFloat(o.paymentAmount || o.tradeAmount || o.orderAmount || o.totalMoney || 0); const refund = parseFloat(o.afterSalePaymentAmount || o.afterSaleTradeAmount || 0); return Math.max(0, gross - refund); };
    const completedTodayApi = todayApiOrders.filter(o => o.phase >= 2 || getAmt(o) > 0);
    const todayApiRevenue = completedTodayApi.reduce((s, o) => s + getAmt(o), 0);
    log(`Today API fetch: ${completedTodayApi.length} completed orders, $${todayApiRevenue.toFixed(2)}`);

    // 2b. Pull ALL orders with pagination
    log('Fetching all orders (paginated)...');
    const allOrders = [];
    let pageNum = 1;
    const pageSize = 100;
    let totalRows = 0;

    while (true) {
      const pageData = await page.evaluate(async ({ api, org, scope, pageNum, pageSize }) => {
        const h = { 'Content-Type': 'application/json', 'x-token': localStorage.getItem('token'), 'app-scope': scope, 'organSn': org };
        const res = await fetch(`${api}/order/v2/findOrderInfoList`, {
          method: 'POST',
          headers: h,
          body: JSON.stringify({ page: pageNum, pageNum, pageSize, commStatus: 10, phaseList: '3,4,5', zoneId: 'US/Pacific' })
        });
        return res.json();
      }, { api: SANDSTAR_API, org: SANDSTAR_ORG, scope: SANDSTAR_SCOPE, pageNum, pageSize });

      const rows = pageData?.data?.resultList || [];
      const rowcount = pageData?.data?.rowcount || 0;
      if (totalRows === 0) totalRows = rowcount;

      if (rows.length === 0) break;
      allOrders.push(...rows);
      log(`  Page ${pageNum}: ${rows.length} orders (total so far: ${allOrders.length}/${totalRows})`);

      if (allOrders.length >= totalRows) break;
      pageNum++;
      if (pageNum > 50) { log('  Stopping at 50 pages to avoid overload'); break; }
    }

    // 2b. Probe first order to log all fields (helps diagnose goods field name)
    if (allOrders.length > 0) {
      const sample = allOrders[0];
      const sampleKeys = Object.keys(sample);
      log(`  Sample order keys: ${sampleKeys.join(', ')}`);
      const GOODS_FIELDS = ['goods','goodsList','orderGoodsList','itemList','goodsInfoList','finalItemList','orderItemList','algorItemList','businessItemList','manualItemList'];
      const foundGoodsField = GOODS_FIELDS.find(f => sample[f] && sample[f].length > 0);
      if (foundGoodsField) {
        log(`  Goods field found in list response: ${foundGoodsField} (${(sample[foundGoodsField]||[]).length} items)`);
      } else {
        log('  No goods field in list response — will fetch order details per order');
        log(`  Available item-like fields: ${GOODS_FIELDS.filter(f => f in sample).join(', ')}`);
      }

    }

    // 3. Pull machines
    const machineData = await page.evaluate(async ({ api, org, scope }) => {
      const h = { 'Content-Type': 'application/json', 'x-token': localStorage.getItem('token'), 'app-scope': scope, 'organSn': org };
      const res = await fetch(`${api}/freezer/getFreezerInfoList`, {
        method: 'POST',
        headers: h,
        body: JSON.stringify({ pageNum: 1, pageSize: 20, organSn: org })
      });
      return res.json();
    }, { api: SANDSTAR_API, org: SANDSTAR_ORG, scope: SANDSTAR_SCOPE });

    const abnormalData = await page.evaluate(async ({ api, org, scope }) => {
      const h = { 'Content-Type': 'application/json', 'x-token': localStorage.getItem('token'), 'app-scope': scope, 'organSn': org };
      const res = await fetch(`${api}/order/v2/findAbHandlerOrderInfoCount`, {
        method: 'POST',
        headers: h,
        body: JSON.stringify({ zoneId: 'US/Pacific' })
      });
      return res.json();
    }, { api: SANDSTAR_API, org: SANDSTAR_ORG, scope: SANDSTAR_SCOPE });

    // 3b. Pull machine inventory (current stock per machine per product)
    log('Fetching machine inventory...');
    const INVENTORY_ENDPOINTS = [
      { path: '/stock/getFreezerStockForPage', method: 'POST', body: { pageNum: 1, pageSize: 500 } },
      { path: '/stock/getFreezerStockDetail', method: 'POST', body: { pageNum: 1, pageSize: 500 } },
      { path: '/stock/getEquipmentInventoryList', method: 'POST', body: { pageNum: 1, pageSize: 200 } },
      { path: '/stock/getMerchantStockForPage', method: 'POST', body: { pageNum: 1, pageSize: 200 } },
    ];

    let allInventoryRecords = [];
    let inventoryEndpointUsed = null;

    // Helper: fetch one page of inventory, returns { list, rowcount }
    async function fetchInvPage(ep, extraBody) {
      const body = { ...(ep.body || {}), ...extraBody };
      const result = await page.evaluate(async ({ api, org, scope, ep, body }) => {
        const h = { 'Content-Type': 'application/json', 'x-token': localStorage.getItem('token'), 'app-scope': scope, 'organSn': org };
        const res = ep.method === 'GET'
          ? await fetch(`${api}${ep.path}`, { method: 'GET', headers: h })
          : await fetch(`${api}${ep.path}`, { method: 'POST', headers: h, body: JSON.stringify(body) });
        return res.json();
      }, { api: SANDSTAR_API, org: SANDSTAR_ORG, scope: SANDSTAR_SCOPE, ep, body });
      const data = result?.data || {};
      const list = data.records || data.resultList || data.list || null;
      return { list, rowcount: data.rowcount || data.total || 0 };
    }

    // Use the correct per-machine endpoint: getGoodsAtShelvesByFreezerIdV2
    // This returns ALL slots with current+capacity per machine (not just top-10 summary)
    const allMachinesForInv = machineData?.data?.resultList || [];
    for (const m of allMachinesForInv) {
      try {
        // Navigate to replenishment page to set machine context
        await page.goto(
          `https://prod-ops-us.sandstar.com/#/pages/replenishment/page/current-stock-new?id=${m.freezerId}`,
          { waitUntil: 'domcontentloaded', timeout: 30000 }
        );
        await page.waitForTimeout(2000);
        const items = await page.evaluate(async ({ api, org, scope, freezerId }) => {
          const token = localStorage.getItem('token');
          const h = { 'Content-Type': 'application/json', 'x-token': token, 'app-scope': scope, 'organSn': org };
          const r = await fetch(`${api}/goods/v2/getGoodsAtShelvesByFreezerIdV2`, {
            method: 'POST', headers: h,
            body: JSON.stringify({ freezerId, organSn: org, pageNum: 1, pageSize: 200 })
          });
          const d = await r.json();
          return d?.data?.resultList || [];
        }, { api: SANDSTAR_API, org: SANDSTAR_ORG, scope: SANDSTAR_SCOPE, freezerId: m.freezerId });
        // Aggregate lanes by product name
        const byProduct = {};
        for (const item of items) {
          const name = item.goodsName || item.skuName || item.productName || item.name || '';
          if (!name) continue;
          if (!byProduct[name]) byProduct[name] = { cur: 0, cap: 0, picture: item.picture || '' };
          byProduct[name].cur += Math.max(0, parseInt(item.stockRealtime ?? item.currentNum ?? 0));
          byProduct[name].cap += parseInt(item.capacity ?? item.stockInit ?? item.stockInitial ?? 0);
          if (!byProduct[name].picture && item.picture) byProduct[name].picture = item.picture;
        }
        Object.entries(byProduct).forEach(([name, d]) => {
          allInventoryRecords.push({
            freezerId: m.freezerId,
            freezerName: m.freezerName,
            goodsName: name,
            stockRealtime: d.cur,
            capacityNum: d.cap,
            picture: d.picture,
          });
        });
        log(`  ${m.freezerName}: ${Object.keys(byProduct).length} products across ${items.length} slots`);
      } catch(e) {
        log(`  ${m.freezerName}: error — ${e.message}`);
      }
    }
    inventoryEndpointUsed = '/goods/v2/getGoodsAtShelvesByFreezerIdV2';
    log(`  Total inventory: ${allInventoryRecords.length} product records across ${allMachinesForInv.length} machines`);

    if (allInventoryRecords.length === 0) {
      log('  No inventory endpoint returned data — skipping inventory sync');
    } else {
      fs.writeFileSync('/Users/kurtishon/clawd/data/sandstar-inventory-latest.json', JSON.stringify({
        fetched_at: new Date().toISOString(),
        endpoint: inventoryEndpointUsed,
        records: allInventoryRecords
      }, null, 2));
    }

    // 4. Process machines
    const machines = machineData?.data?.resultList || [];
    log(`Machines: ${machines.length}`);
    const machineStatus = machines.map(m => ({
      sandstar_id:  m.freezerId,
      name:         m.freezerName,
      address:      m.address,
      online:       m.connectState === 1,
      alarms:       m.alarmState > 0,
      alarm_info:   m.alarmInfo,
      last_seen:    m.connectTime,
    }));

    // 5. Filter completed orders BEFORE browser.close() so we can fetch detail
    const getOrderAmount = o => { const settled = parseFloat(o.statPaymentAmount || o.statOrderAmount || 0); if (settled > 0) return settled; const gross = parseFloat(o.paymentAmount || o.tradeAmount || o.orderAmount || o.totalMoney || 0); const refund = parseFloat(o.afterSalePaymentAmount || o.afterSaleTradeAmount || 0); return Math.max(0, gross - refund); };
    const completedOrders = allOrders.filter(o =>
      o.phase >= 2 || getOrderAmount(o) > 0
    );
    log(`Orders: ${allOrders.length} total, ${completedOrders.length} completed/importable`);

    // 5b. Fetch order details for orders missing goods data using direct Node.js HTTP
    const ITEM_FIELDS = ['orderItemList','finalItemList','algorItemList','businessItemList','manualItemList','goods','goodsList','orderGoodsList','itemList','goodsInfoList'];
    const getGoods = (obj) => {
      // Check top-level and nested under 'order' sub-object
      for (const source of [obj, obj?.order || {}]) {
        const found = ITEM_FIELDS.reduce((acc, f) => acc.length > 0 ? acc : (Array.isArray(source[f]) ? source[f] : []), []);
        if (found.length > 0) return found;
      }
      return [];
    };
    const ordersNeedingDetail = completedOrders.filter(o => getGoods(o).length === 0);

    if (ordersNeedingDetail.length > 0) {
      log(`Fetching item details for ${Math.min(ordersNeedingDetail.length, 200)} orders via direct HTTP...`);

      // Use token already captured from localStorage
      const headers = {
        'Content-Type': 'application/json',
        'x-token': token,
        'app-scope': SANDSTAR_SCOPE,
        'organSn': SANDSTAR_ORG,
      };

      // Discover which endpoint works
      const DETAIL_ENDPOINTS = [
        '/order/getOrderDetail',
        '/order/v2/getOrderDetail',
        '/order/findOrderDetail',
        '/order/getOrderInfo',
        '/order/v2/getOrderInfo',
        '/order/queryOrderDetail',
        '/order/v2/queryOrderDetail',
        '/order/orderDetail',
        '/recognitionresult/getByOrderNo',
        '/order/getGoodsByOrderNo',
      ];

      let detailEndpoint = null;
      const probeOrder = ordersNeedingDetail[0];
      for (const ep of DETAIL_ENDPOINTS) {
        try {
          const r = await fetch(`${SANDSTAR_API}${ep}`, { method: 'POST', headers, body: JSON.stringify({ orderNo: probeOrder.orderNo, id: probeOrder.id, organSn: SANDSTAR_ORG }) });
          const text = await r.text();
          if (!text || r.status === 404) { log(`  ${ep}: 404`); continue; }
          const j = JSON.parse(text);
          if (j?.status === 404 || j?.error) { log(`  ${ep}: error ${j?.status || j?.error}`); continue; }
          const d = j?.data || j?.result || j || {};
          const goods = getGoods(d);
          log(`  ${ep}: status=${r.status} keys=${Object.keys(d).join(',').substring(0,120)} goods=${goods.length}`);
          if (goods.length > 0) {
            detailEndpoint = ep;
            probeOrder.goods = goods;
            log(`  ✓ Using ${ep} — found ${goods.length} items`);
            break;
          } else if (Object.keys(d).length >= 2 && !d.error && !d.status) {
            detailEndpoint = ep;
            log(`  Using ${ep} as fallback — order keys: ${JSON.stringify(Object.keys(d.order || {})).substring(0,200)}`);
            log(`  order.finalItemList: ${JSON.stringify((d.order||{}).finalItemList || []).substring(0,200)}`);
            log(`  order.orderItemList: ${JSON.stringify((d.order||{}).orderItemList || []).substring(0,200)}`);
            log(`  order.algorItemList: ${JSON.stringify((d.order||{}).algorItemList || []).substring(0,200)}`);

            break;
          }
        } catch(e) { log(`  ${ep}: ${e.message}`); }
      }

      if (detailEndpoint) {
        const toFetch = ordersNeedingDetail.slice(probeOrder.goods?.length > 0 ? 1 : 0, 200);
        log(`  Fetching ${toFetch.length} orders via ${detailEndpoint}...`);
        let gotItems = 0;
        for (const order of toFetch) {
          try {
            const r = await fetch(`${SANDSTAR_API}${detailEndpoint}`, { method: 'POST', headers, body: JSON.stringify({ orderNo: order.orderNo, id: order.id, organSn: SANDSTAR_ORG }) });
            const j = await r.json().catch(() => null);
            if (!j) continue;
            const d = j?.data || j?.result || j || {};
            const goods = getGoods(d);
            if (goods.length > 0) { order.goods = goods; gotItems++; }
          } catch(e) { /* skip */ }
        }
        log(`  Done — got items for ${gotItems} orders`);
      } else {
        log(`  No working detail endpoint found — items will remain empty`);
        log(`  NOTE: Check if token expired or if Sandstar changed their API`);
      }
    }

    // Close browser — all page.evaluate calls are done above this line
    await browser.close();

    // Revenue stats from all completed orders
    const totalRevenue = completedOrders.reduce((s, o) => s + getOrderAmount(o), 0);
    const _now = new Date(); const todayStr = `${_now.getFullYear()}-${String(_now.getMonth()+1).padStart(2,'0')}-${String(_now.getDate()).padStart(2,'0')}`;
    const todayOrders = completedOrders.filter(o => (o.closeTime || o.phaseChangeTime || '').startsWith(todayStr));
    const todayRevenue = todayOrders.reduce((s, o) => s + getOrderAmount(o), 0);

    // Find new orders (not yet synced)
    const newOrders = completedOrders.filter(o => !state.syncedOrderNos?.includes(o.orderNo));
    log(`New orders to import: ${newOrders.length}`);



    // 6. Push to dashboard
    const dashCookies = {};
    await dashApi('POST', '/api/auth/login', { password: DASHBOARD_PW }, dashCookies);

    // Update machines — write to both CRM machines and sandstar_machines store
    const dashMachines = await dashApi('GET', '/api/machines', null, dashCookies);
    const dashMachineList = Array.isArray(dashMachines) ? dashMachines : [];
    const sandstarMachineBatch = [];
    for (const m of machineStatus) {
      const existing = dashMachineList.find(dm =>
        dm.sandstar_id === m.sandstar_id ||
        (dm.name || '').toLowerCase() === m.name?.toLowerCase()
      );
      const payload = {
        sandstar_id: m.sandstar_id, name: m.name, address: m.address,
        status: m.online ? 'online' : 'offline', last_seen: m.last_seen,
        alarm_count: m.alarms ? 1 : 0, sandstar_synced_at: new Date().toISOString(),
      };
      if (existing?.id) await dashApi('PUT', `/api/machines/${existing.id}`, payload, dashCookies);
      sandstarMachineBatch.push(payload);
    }
    // Write to sandstar_machines store (used by summary active_machines count)
    if (sandstarMachineBatch.length > 0) {
      const machBatchRes = await dashApi('POST', '/api/sandstar/machines/batch', { machines: sandstarMachineBatch }, dashCookies);
      log(`Sandstar machines upserted: ${JSON.stringify(machBatchRes)}`);
    }

    // Batch import machine inventory
    if (allInventoryRecords.length > 0) {
      try {
        // Normalize using confirmed field names from getFreezerStockForPage
        const inventoryBatch = allInventoryRecords.map(row => ({
          sandstar_machine_id: row.freezerId || row.machineId || row.equipmentId || null,
          machine_name: row.freezerName || row.machineName || row.equipmentName || '',
          product_barcode: row.barcode || row.goodsBarcode || row.skuid || '',
          product_name: row.goodsName || row.productName || row.name || '',
          current_quantity: Math.max(0, parseInt(row.stockRealtime ?? row.currentNum ?? row.stockNum ?? row.quantity ?? 0)),
          capacity: parseInt(row.capacityNum || row.capacity || row.maxNum || 0),
          lane_no: row.laneNo || row.lane || row.position || row.sbbh || '',
          synced_at: new Date().toISOString()
        })).filter(r => r.sandstar_machine_id && (r.product_barcode || r.product_name));

        if (inventoryBatch.length > 0) {
          const invRes = await dashApi('POST', '/api/sandstar/inventory/batch', { inventory: inventoryBatch }, dashCookies);
          log(`Inventory batch import: ${JSON.stringify(invRes).substring(0,200)}`);
        } else {
          log('  No inventory records to import after normalization');
        }
      } catch (e) {
        log(`  Inventory batch import failed: ${e.message}`);
      }
    }

    // Always re-push today's orders with force:true so settled amounts stay current
    const todayOrderNos = new Set(completedTodayApi.map(o => o.orderNo));
    const todayOrdersFromAll = completedOrders.filter(o => todayOrderNos.has(o.orderNo));
    if (todayOrdersFromAll.length > 0) {
      const todayForceBatch = todayOrdersFromAll.map(order => ({
        sandstar_order_no: order.orderNo,
        machine_name: order.freezerName,
        machine_id: order.freezerId,
        amount: (() => { const s = parseFloat(order.statPaymentAmount || order.statOrderAmount || 0); if (s > 0) return s; const g = parseFloat(order.paymentAmount || order.tradeAmount || order.orderAmount || order.totalMoney || 0); const r = parseFloat(order.afterSalePaymentAmount || order.afterSaleTradeAmount || 0); return Math.max(0, g - r); })(),
        item_qty: parseInt(order.statQty || order.allQty || 0),
        items: (getGoods(order)).map(g => ({ name: g.goodsName || g.productName || g.name || g.goodsCn || g.skuName || '', qty: g.goodsNum || g.quantity || g.qty || g.num || g.count || 1, price: g.payPrice || g.goodsPrice || g.price || g.unitPrice || g.salePrice || g.amount || 0, spec: g.goodsSpec || '', barcode: g.barcode || '' })),
        sale_date: order.closeTime || order.phaseChangeTime || order.createTime || new Date().toISOString(),
        pay_method: order.payName || '',
        phase: order.phase || 2
      }));
      const todayForceRes = await dashApi('POST', '/api/sandstar/sales/batch', { sales: todayForceBatch, force: true }, dashCookies);
      log(`Today force-update: ${JSON.stringify(todayForceRes)}`);
    }

    // Batch import new sales to the sandstar endpoint
    let salesImported = 0;
    if (newOrders.length > 0) {
      const salesBatch = newOrders.map(order => ({
        sandstar_order_no: order.orderNo,
        machine_name: order.freezerName,
        machine_id: order.freezerId,
        amount: (() => { const s = parseFloat(order.statPaymentAmount || order.statOrderAmount || 0); if (s > 0) return s; const g = parseFloat(order.paymentAmount || order.tradeAmount || order.orderAmount || order.totalMoney || 0); const r = parseFloat(order.afterSalePaymentAmount || order.afterSaleTradeAmount || 0); return Math.max(0, g - r); })(),
        item_qty: parseInt(order.statQty || order.allQty || 0),
        items: (getGoods(order)).map(g => ({ name: g.goodsName || g.productName || g.name || g.goodsCn || g.skuName || '', qty: g.goodsNum || g.quantity || g.qty || g.num || g.count || 1, price: g.payPrice || g.goodsPrice || g.price || g.unitPrice || g.salePrice || g.amount || 0, spec: g.goodsSpec || '', barcode: g.barcode || '' })),
        sale_date: order.closeTime || order.phaseChangeTime || order.createTime || new Date().toISOString(),
        pay_method: order.payName || '',
        phase: order.phase || 2
      }));

      const batchRes = await dashApi('POST', '/api/sandstar/sales/batch', { sales: salesBatch, force: true }, dashCookies);
      salesImported = batchRes?.imported || 0;
      log(`Batch import result: ${JSON.stringify(batchRes)}`);

      // Track synced order numbers
      if (!state.syncedOrderNos) state.syncedOrderNos = [];
      newOrders.forEach(o => {
        if (!state.syncedOrderNos.includes(o.orderNo)) state.syncedOrderNos.push(o.orderNo);
      });
    }

    if (state.syncedOrderNos?.length > 5000) state.syncedOrderNos = state.syncedOrderNos.slice(-5000);

    // Save snapshot
    const snapshot = {
      synced_at: new Date().toISOString(),
      machines: machineStatus,
      total_orders: allOrders.length,
      completed_orders: completedOrders.length,
      today_orders: completedTodayApi.length,
      today_revenue: todayApiRevenue,
      total_revenue: totalRevenue,
      new_sales_imported: salesImported,
      abnormal_orders: abnormalData?.data || 0,
    };
    fs.writeFileSync('/Users/kurtishon/clawd/data/sandstar-latest.json', JSON.stringify(snapshot, null, 2));

    // Detect machine status changes
    const prevMachines = state.machineStatus || {};
    const statusChanges = [];
    machineStatus.forEach(m => {
      const prev = prevMachines[m.sandstar_id];
      if (prev !== undefined && prev.online !== m.online)
        statusChanges.push(`${m.online ? '🟢' : '🔴'} ${m.name} → ${m.online ? 'ONLINE' : 'OFFLINE'}`);
    });
    state.machineStatus = Object.fromEntries(machineStatus.map(m => [m.sandstar_id, { online: m.online }]));
    saveState(state);

    // Build Telegram message
    const onlineCount = machineStatus.filter(m => m.online).length;
    const alarmCount  = machineStatus.filter(m => m.alarms).length;
    let msg = null;

    // Telegram notifications disabled — sync runs silently
    // Only send alarms
    if (alarmCount > 0 && !prevMachines[machineStatus.find(m=>m.alarms)?.sandstar_id]?.alarms) {
      msg = `⚠️ *Sandstar Alarm*\n${machineStatus.filter(m=>m.alarms).map(m=>m.name).join(', ')}`;
    }

    if (msg) {
      log(`Sending alarm: ${msg.replace(/\n/g,' ').substring(0,100)}`);
      sendTelegram(msg);
    } else {
      log(`No changes — silent (${onlineCount}/${machineStatus.length} online, ${allOrders.length} total orders, ${completedOrders.length} completed)`);
    }

    // Push normalized stock to office-stock-sync (what pick-lists actually read)
    if (allInventoryRecords.length > 0) {
      try {
        const officeStockRecords = allInventoryRecords.map(row => ({
          machine_name: row.freezerName || row.machineName || '',
          product_name: row.goodsName || row.productName || row.name || '',
          current_quantity: Math.max(0, parseInt(row.stockRealtime ?? row.currentNum ?? row.stockNum ?? row.quantity ?? 0)),
          capacity: parseInt(row.capacityNum || row.stockInitial || row.capacity || row.maxNum || 0),
          picture: row.picture || '',
        })).filter(r => r.machine_name && r.product_name);
        const officeStockRes = await dashApi('POST', '/api/office-stock-sync', { records: officeStockRecords }, dashCookies);
        log(`Office stock sync: ${JSON.stringify(officeStockRes)}`);
      } catch(e) { log(`Office stock sync failed: ${e.message}`); }
    }

    // Refresh pick lists from updated stock data
    let pickListData = [];
    try {
      const plRefresh = await dashApi('POST', '/api/pick-lists/refresh-all', {}, dashCookies);
      pickListData = plRefresh.lists || [];
      const totalItems = pickListData.reduce((s, l) => s + (l.items || []).length, 0);
      log(`Pick lists refreshed: ${pickListData.length} machines, ${totalItems} total items`);
    } catch(e) { log(`Pick list refresh failed: ${e.message}`); }

    // === POST-SYNC VALIDATION ===
    // Check pick lists for known bad patterns and alert if found
    const FRESH_KW = ['sandwich', 'wrap', 'salad', 'sushi', 'burrito', 'bowl', 'biscuit', 'burger', 'sub', 'hoagie', 'panini', 'taco'];
    const isFresh = s => FRESH_KW.some(k => (s || '').toLowerCase().includes(k));
    const validationIssues = [];
    const machineRecordCounts = {};
    allInventoryRecords.forEach(r => {
      const mn = r.freezerName || r.machineName || 'unknown';
      machineRecordCounts[mn] = (machineRecordCounts[mn] || 0) + 1;
    });
    // Check 1: machines missing from sync
    const expectedMachines = (machineData?.data?.resultList || []).map(m => m.freezerName);
    const syncedMachines = Object.keys(machineRecordCounts);
    const missingFromSync = expectedMachines.filter(m => !syncedMachines.includes(m));
    if (missingFromSync.length > 0) validationIssues.push(`⚠️ Machines missing from inventory sync: ${missingFromSync.join(', ')}`);
    // Check 2: capacity=0 slots (broken slot data)
    const zeroCap = allInventoryRecords.filter(r => !parseInt(r.capacityNum || r.stockInitial || r.capacity || 0));
    if (zeroCap.length > 5) validationIssues.push(`⚠️ ${zeroCap.length} slots with capacity=0 (slot data may be stale)`);
    // Check 3: cross-category mismatches in pick lists
    const crossCatItems = [];
    pickListData.forEach(pl => {
      (pl.items || []).forEach(it => {
        const sandstarFresh = isFresh(it.sandstar_product_name);
        const nameFresh = isFresh(it.name);
        if (sandstarFresh !== nameFresh) {
          crossCatItems.push(`${pl.label}: "${it.sandstar_product_name}" → "${it.name}"`);
        }
      });
    });
    if (crossCatItems.length > 0) validationIssues.push(`⚠️ Cross-category match (sandwich↔snack):\n${crossCatItems.join('\n')}`);
    // Check 4: negative quantities
    const negQty = [];
    pickListData.forEach(pl => {
      (pl.items || []).forEach(it => {
        if ((it.current_qty || 0) < 0) negQty.push(`${pl.label}: ${it.name} (${it.current_qty}/${it.capacity})`);
      });
    });
    if (negQty.length > 0) validationIssues.push(`⚠️ Negative quantities:\n${negQty.join('\n')}`);

    // Check 5: cross-check pick list quantities against raw Sandstar data
    // Build lookup: machine+productName → raw sandstar record
    const rawLookup = {};
    allInventoryRecords.forEach(r => {
      const key = `${r.freezerName||''}|${(r.goodsName||r.productName||r.name||'').toLowerCase().trim()}`;
      if (!rawLookup[key]) rawLookup[key] = r;
    });
    const qtyMismatches = [];
    pickListData.forEach(pl => {
      const mName = pl.label || pl.machine_names?.[0] || '';
      (pl.items || []).forEach(it => {
        const sp = (it.sandstar_product_name || '').toLowerCase().trim();
        const key = `${mName}|${sp}`;
        const raw = rawLookup[key];
        if (!raw) return; // not in raw — skip (handled elsewhere)
        const rawQty = Math.max(0, parseInt(raw.stockRealtime ?? raw.currentNum ?? 0));
        const rawCap = parseInt(raw.capacityNum || raw.stockInitial || raw.capacity || 0);
        if (Math.abs((it.current_qty || 0) - rawQty) > 1) {
          qtyMismatches.push(`${mName}: ${it.name} — pick list=${it.current_qty} vs Sandstar=${rawQty}`);
        }
        if (rawCap > 0 && it.capacity !== rawCap) {
          qtyMismatches.push(`${mName}: ${it.name} — capacity pick list=${it.capacity} vs Sandstar=${rawCap}`);
        }
      });
    });
    if (qtyMismatches.length > 0) validationIssues.push(`⚠️ Qty/capacity mismatch vs Sandstar raw:\n${qtyMismatches.join('\n')}`);

    // Check 6: slots in Sandstar that are below capacity but missing from pick list
    const sandstarNeedsRestock = {};
    allInventoryRecords.forEach(r => {
      const mn = r.freezerName || r.machineName || '';
      const cur = Math.max(0, parseInt(r.stockRealtime ?? 0));
      const cap = parseInt(r.capacityNum || r.stockInitial || 0);
      if (cap > 0 && cur < cap) {
        if (!sandstarNeedsRestock[mn]) sandstarNeedsRestock[mn] = [];
        sandstarNeedsRestock[mn].push(r.goodsName || r.productName || r.name || '');
      }
    });
    const pickListItems = {};
    pickListData.forEach(pl => {
      const mn = pl.label || pl.machine_names?.[0] || '';
      pickListItems[mn] = new Set((pl.items || []).map(i => (i.sandstar_product_name || '').toLowerCase().trim()));
    });
    const missingFromPickList = [];
    Object.entries(sandstarNeedsRestock).forEach(([mn, products]) => {
      const plSet = pickListItems[mn] || new Set();
      products.forEach(p => {
        if (!plSet.has(p.toLowerCase().trim())) {
          missingFromPickList.push(`${mn}: "${p}" (in Sandstar, not in pick list)`);
        }
      });
    });
    if (missingFromPickList.length > 0) validationIssues.push(`⚠️ Items below capacity in Sandstar but missing from pick list:\n${missingFromPickList.slice(0,10).join('\n')}${missingFromPickList.length > 10 ? `\n…+${missingFromPickList.length-10} more` : ''}`);

    if (validationIssues.length > 0) {
      const alertMsg = `🔍 Pick list validation issues (${new Date().toLocaleString('en-US', {timeZone:'America/Los_Angeles'})}):\n${validationIssues.join('\n\n')}`;
      log(`VALIDATION ALERT: ${alertMsg}`);
      sendTelegram(alertMsg);
    } else {
      log(`Validation OK — ${pickListData.length} machines, no issues found`);
    }

    // Auto-generate pick list from machine inventory levels (below 50% capacity)
    try {
      const plRes = await dashApi('POST', '/api/restocks/auto-generate', {}, dashCookies);
      if (plRes.created > 0 || plRes.updated > 0) log(`Pick list: ${plRes.created} created, ${plRes.updated} updated across ${plRes.machines} machines`);
    } catch(e) { log(`Pick list auto-generate failed: ${e.message}`); }

    // Auto-generate pull list from expiration dates
    try {
      const plRes = await dashApi('POST', '/api/pull-list/auto-generate', {}, dashCookies);
      if (plRes.generated > 0) log(`Pull list: ${plRes.generated} items auto-added (expiring within threshold)`);
    } catch(e) { log(`Pull list auto-generate failed: ${e.message}`); }

    // Reset consecutive error count on success
    if (state.consecutiveErrors) { state.consecutiveErrors = 0; saveState(state); }
    log('===== Sandstar sync complete =====');

  } catch (e) {
    await browser.close().catch(() => {});
    log(`FATAL: ${e.message}`);
    // Only alert after 3 consecutive failures to suppress transient noise
    const errState = loadState();
    errState.consecutiveErrors = (errState.consecutiveErrors || 0) + 1;
    saveState(errState);
    if (errState.consecutiveErrors >= 3) {
      sendTelegram(`❌ Sandstar sync error (${errState.consecutiveErrors} in a row): ${e.message}`);
    } else {
      log(`Suppressing Telegram alert (consecutive errors: ${errState.consecutiveErrors}/3)`);
    }
    process.exit(1);
  }
})();
