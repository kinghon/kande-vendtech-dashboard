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
const SANDSTAR_PASS  = 'lanie123';
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
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { syncedOrderNos: [] }; }
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

  try {
    log('Logging into Sandstar...');
    await page.goto('https://prod-ops-us.sandstar.com/#/pages/login/login', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);

    // Check if already at a post-login page
    if (!page.url().includes('login')) {
      log('Already logged in via cached session');
    } else {
      // Fill login form
      const idField = await page.$('input[type="text"], input:not([type="password"])').catch(() => null);
      const pwField = await page.$('input[type="password"]').catch(() => null);
      if (idField && pwField) {
        await idField.fill(SANDSTAR_EMAIL);
        await pwField.fill(SANDSTAR_PASS);
        // Click login button
        await page.evaluate(() => {
          const btns = [...document.querySelectorAll('*')].filter(e =>
            e.textContent.trim() === 'Login' && getComputedStyle(e).cursor === 'pointer'
          );
          if (btns[0]) btns[0].click();
        });
        await page.waitForTimeout(3000);
        // Select merchant if prompted
        const merchantCard = await page.$('text=Kande VendTech').catch(() => null);
        if (merchantCard) {
          await merchantCard.click();
          await page.waitForTimeout(2000);
        }
      }
    }

    // Get token from localStorage
    const token = await page.evaluate(() => localStorage.getItem('token'));
    const organSn = await page.evaluate(() => localStorage.getItem('organSn'));
    if (!token) throw new Error('No token in localStorage after login');
    log(`Token obtained: ${token.substring(0,8)}...`);

    // 2. Pull data via browser fetch (same origin = no CORS issues)
    const data = await page.evaluate(async ({ api, org, scope }) => {
      const h = { 'Content-Type': 'application/json', 'x-token': localStorage.getItem('token'), 'app-scope': scope, 'organSn': org };
      const p = (path, body) => fetch(`${api}${path}`, { method: 'POST', headers: h, body: JSON.stringify(body) }).then(r => r.json());

      const [machines, orders, abnormal] = await Promise.all([
        p('/freezer/getFreezerInfoList', { pageNum: 1, pageSize: 20, organSn: org }),
        p('/order/v2/findOrderInfoList', { pageNum: 1, pageSize: 100, zoneId: 'US/Pacific' }),
        p('/order/v2/findAbHandlerOrderInfoCount', { zoneId: 'US/Pacific' }),
      ]);

      return { machines, orders, abnormal };
    }, { api: SANDSTAR_API, org: SANDSTAR_ORG, scope: SANDSTAR_SCOPE });

    await browser.close();

    // 3. Process machines
    const machines = data.machines?.data?.resultList || [];
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

    // 4. Process orders — filter completed with revenue
    const allOrders = data.orders?.data?.resultList || [];
    const totalOrderCount = data.orders?.data?.rowcount || 0;
    const completedOrders = allOrders.filter(o =>
      o.phase >= 2 &&
      (o.totalMoney || 0) > 0 &&
      !state.syncedOrderNos?.includes(o.orderNo)
    );
    log(`Orders: ${totalOrderCount} total, ${completedOrders.length} new completed`);

    // Revenue stats from all completed orders
    const allCompleted = allOrders.filter(o => o.phase >= 2 && (o.totalMoney || 0) > 0);
    const totalRevenue = allCompleted.reduce((s, o) => s + (o.totalMoney || 0), 0);
    const todayStr = new Date().toISOString().split('T')[0];
    const todayOrders = allCompleted.filter(o => (o.closeTime || o.phaseChangeTime || '').startsWith(todayStr));
    const todayRevenue = todayOrders.reduce((s, o) => s + (o.totalMoney || 0), 0);

    // 5. Push to dashboard
    const dashCookies = {};
    await dashApi('POST', '/api/auth/login', { password: DASHBOARD_PW }, dashCookies);

    // Update machines
    const dashMachines = await dashApi('GET', '/api/machines', null, dashCookies);
    const dashMachineList = Array.isArray(dashMachines) ? dashMachines : [];
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
    }

    // Import new sales
    let salesImported = 0;
    for (const order of completedOrders) {
      const r = await dashApi('POST', '/api/sales', {
        source: 'sandstar', sandstar_order_no: order.orderNo,
        machine_name: order.freezerName, machine_id: order.freezerId,
        amount: order.totalMoney,
        items: (order.goods || []).map(g => ({ name: g.goodsName, qty: g.goodsNum, price: g.goodsPrice })),
        sale_date: order.closeTime || order.phaseChangeTime,
        pay_method: order.payName,
      }, dashCookies);
      if (r?.id || r?.success) salesImported++;
      if (!state.syncedOrderNos) state.syncedOrderNos = [];
      state.syncedOrderNos.push(order.orderNo);
    }
    if (state.syncedOrderNos?.length > 1000) state.syncedOrderNos = state.syncedOrderNos.slice(-1000);

    // Save snapshot
    const snapshot = {
      synced_at: new Date().toISOString(),
      machines: machineStatus,
      total_orders: totalOrderCount,
      today_orders: todayOrders.length,
      today_revenue: todayRevenue,
      total_revenue: totalRevenue,
      new_sales_imported: salesImported,
      abnormal_orders: data.abnormal?.data || 0,
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

    if (salesImported > 0) {
      msg = `📊 *Sandstar Sync — ${todayStr}*\n💰 ${salesImported} new sale(s) — $${todayRevenue.toFixed(2)} today\n🖥 ${onlineCount}/${machineStatus.length} machines online`;
      if (alarmCount) msg += ` · ⚠️ ${alarmCount} alarm(s)`;
    } else if (statusChanges.length > 0) {
      msg = `🔄 *Machine Status Change*\n${statusChanges.join('\n')}`;
    } else if (alarmCount > 0 && !prevMachines[machineStatus.find(m=>m.alarms)?.sandstar_id]?.alarms) {
      msg = `⚠️ *Sandstar Alarm*\n${machineStatus.filter(m=>m.alarms).map(m=>m.name).join(', ')}`;
    }

    if (msg) {
      log(`Sending: ${msg.replace(/\n/g,' ').substring(0,100)}`);
      sendTelegram(msg);
    } else {
      log(`No changes — silent (${onlineCount}/${machineStatus.length} online, ${totalOrderCount} total orders)`);
    }

    log('===== Sandstar sync complete =====');

  } catch (e) {
    await browser.close().catch(() => {});
    log(`FATAL: ${e.message}`);
    sendTelegram(`❌ Sandstar sync error: ${e.message}`);
    process.exit(1);
  }
})();
