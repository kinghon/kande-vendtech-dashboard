#!/usr/bin/env node
// =============================================================================
// Sandstar → Kande Dashboard Sync
// Uses Playwright to handle Sandstar auth, then Node HTTP for dashboard writes
// =============================================================================
const { chromium } = require('/opt/homebrew/lib/node_modules/playwright');
const https  = require('https');
const fs     = require('fs');
const { execSync } = require('child_process');

const SANDSTAR_EMAIL = 'kurtis.hon@gmail.com';
const SANDSTAR_PASS  = 'kurtis123#';
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
          body: JSON.stringify({ pageNum: pn, pageSize: ps, zoneId: 'US/Pacific', startTime: ts, endTime: te })
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
    const getAmt = o => parseFloat(o.paymentAmount || o.tradeAmount || o.orderAmount || o.statPaymentAmount || o.statOrderAmount || o.totalMoney || 0);
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
          body: JSON.stringify({ pageNum, pageSize, zoneId: 'US/Pacific' })
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
      if (sample.goods || sample.goodsList || sample.orderGoodsList || sample.itemList || sample.goodsInfoList) {
        const goodsField = sample.goods ? 'goods' : sample.goodsList ? 'goodsList' : sample.orderGoodsList ? 'orderGoodsList' : sample.itemList ? 'itemList' : 'goodsInfoList';
        log(`  Goods field found in list response: ${goodsField} (${(sample[goodsField]||[]).length} items)`);
      } else {
        log('  No goods field in list response — will fetch order details per order');
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
    for (const ep of INVENTORY_ENDPOINTS) {
      try {
        // Paginate through all pages
        let pageNum = 1;
        let totalPages = 1;
        let pageRecords = [];
        do {
          const bodyWithPage = { ...(ep.body || {}), pageNum };
          const result = await page.evaluate(async ({ api, org, scope, ep, body }) => {
            const h = { 'Content-Type': 'application/json', 'x-token': localStorage.getItem('token'), 'app-scope': scope, 'organSn': org };
            const url = `${api}${ep.path}`;
            const res = ep.method === 'GET'
              ? await fetch(url, { method: 'GET', headers: h })
              : await fetch(url, { method: 'POST', headers: h, body: JSON.stringify(body) });
            return res.json();
          }, { api: SANDSTAR_API, org: SANDSTAR_ORG, scope: SANDSTAR_SCOPE, ep, body: bodyWithPage });
          const data = result?.data || {};
          const list = data.records || data.resultList || data.list || null;
          if (!list || !Array.isArray(list)) break;
          pageRecords.push(...list);
          // Calculate total pages from rowcount and pagesize
          const rowcount = data.rowcount || list.length;
          const pagesize = data.pagesize || 10;
          totalPages = Math.ceil(rowcount / pagesize);
          pageNum++;
        } while (pageNum <= totalPages);

        if (pageRecords.length > 0) {
          allInventoryRecords = pageRecords;
          inventoryEndpointUsed = ep.path;
          log(`  Inventory endpoint OK: ${ep.method} ${ep.path} — ${pageRecords.length} records`);
          break;
        }
        log(`  Tried ${ep.method} ${ep.path} — no inventory records`);
      } catch (e) {
        log(`  Tried ${ep.method} ${ep.path} — error: ${e.message}`);
      }
    }

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
    const getOrderAmount = o => o.paymentAmount || o.tradeAmount || o.orderAmount || o.statPaymentAmount || o.statOrderAmount || o.totalMoney || 0;
    const completedOrders = allOrders.filter(o =>
      o.phase >= 2 || getOrderAmount(o) > 0
    );
    log(`Orders: ${allOrders.length} total, ${completedOrders.length} completed/importable`);

    // 5b. Fetch order details for orders missing goods data — MUST happen before browser.close()
    const ordersNeedingDetail = completedOrders.filter(o => {
      const goods = o.goods || o.goodsList || o.orderGoodsList || o.itemList || o.goodsInfoList || [];
      return goods.length === 0;
    });
    if (ordersNeedingDetail.length > 0) {
      log(`Fetching order details for ${Math.min(ordersNeedingDetail.length, 200)} orders missing goods data...`);
      const DETAIL_ENDPOINTS = [
        '/order/v2/getOrderInfo',
        '/order/v2/getOrderDetail',
        '/order/findOrderDetail',
      ];
      // Probe which endpoint works using first order
      let detailEndpoint = null;
      const probeOrder = ordersNeedingDetail[0];
      for (const ep of DETAIL_ENDPOINTS) {
        const probeRes = await page.evaluate(async ({ api, org, scope, ep, orderNo }) => {
          const h = { 'Content-Type': 'application/json', 'x-token': localStorage.getItem('token'), 'app-scope': scope, 'organSn': org };
          try {
            const r = await fetch(`${api}${ep}`, { method: 'POST', headers: h, body: JSON.stringify({ orderNo }) });
            return r.json();
          } catch(e) { return { error: e.message }; }
        }, { api: SANDSTAR_API, org: SANDSTAR_ORG, scope: SANDSTAR_SCOPE, ep, orderNo: probeOrder.orderNo });
        const probeData = probeRes?.data || probeRes?.result || {};
        const probeGoods = probeData.goods || probeData.goodsList || probeData.orderGoodsList || probeData.itemList || probeData.goodsInfoList || [];
        log(`  Detail probe ${ep}: ${JSON.stringify(Object.keys(probeData)).substring(0,100)} | goods: ${probeGoods.length}`);
        if (probeGoods.length > 0 || Object.keys(probeData).length > 2) {
          detailEndpoint = ep;
          // Merge goods into probe order
          probeOrder.goods = probeGoods.length > 0 ? probeGoods : probeOrder.goods;
          if (probeGoods.length > 0) log(`  Using ${ep} — found ${probeGoods.length} goods items in probe order`);
          break;
        }
      }
      if (detailEndpoint && ordersNeedingDetail.length > 1) {
        // Fetch detail for remaining orders in batches
        const toFetch = ordersNeedingDetail.slice(1, 200);
        log(`  Fetching details for ${toFetch.length} more orders via ${detailEndpoint}...`);
        for (const order of toFetch) {
          const detRes = await page.evaluate(async ({ api, org, scope, ep, orderNo }) => {
            const h = { 'Content-Type': 'application/json', 'x-token': localStorage.getItem('token'), 'app-scope': scope, 'organSn': org };
            try {
              const r = await fetch(`${api}${ep}`, { method: 'POST', headers: h, body: JSON.stringify({ orderNo }) });
              return r.json();
            } catch(e) { return null; }
          }, { api: SANDSTAR_API, org: SANDSTAR_ORG, scope: SANDSTAR_SCOPE, ep: detailEndpoint, orderNo: order.orderNo });
          const detData = detRes?.data || detRes?.result || {};
          const detGoods = detData.goods || detData.goodsList || detData.orderGoodsList || detData.itemList || detData.goodsInfoList || [];
          if (detGoods.length > 0) order.goods = detGoods;
        }
        log(`  Order detail fetch complete`);
      } else if (!detailEndpoint) {
        log('  No working detail endpoint found — items will remain empty');
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
          current_quantity: parseInt(row.stockRealtime ?? row.currentNum ?? row.stockNum ?? row.quantity ?? 0),
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
        amount: order.paymentAmount || order.tradeAmount || order.orderAmount || order.statPaymentAmount || order.statOrderAmount || order.totalMoney || 0,
        items: [],
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
        amount: order.paymentAmount || order.tradeAmount || order.orderAmount || order.statPaymentAmount || order.statOrderAmount || order.totalMoney || 0,
        items: (order.goods || order.goodsList || order.orderGoodsList || order.itemList || order.goodsInfoList || []).map(g => ({ name: g.goodsName || g.productName || g.name || '', qty: g.goodsNum || g.quantity || g.qty || 1, price: g.goodsPrice || g.price || g.unitPrice || 0 })),
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
