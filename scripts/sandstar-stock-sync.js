#!/usr/bin/env node
// sandstar-stock-sync.js
// Runs on Mac mini. Scrapes live stock for all 8 machines from Sandstar,
// then POSTs results to Railway so the generate endpoint can use them.

const { chromium } = require('/opt/homebrew/lib/node_modules/playwright');
const https = require('https');

const EMAIL = 'etang106@gmail.com';
const PASS  = 'kurtis123####';
const API   = 'https://webapi-us.sandstar.com';
const ORG   = '001020';
const SCOPE = '12';
const DASH_URL = 'https://vend.kandedash.com';
const DASH_KEY = 'kande2026';

const MACHINES = [
  { sandstar_id: 131520, name: 'ARK Prelude At The Park' },
  { sandstar_id: 128836, name: 'CVM13 Dig This' },
  { sandstar_id: 128837, name: 'CVM13 Regus Arroyo' },
  { sandstar_id: 128794, name: 'VRK Regus Green Valley' },
  { sandstar_id: 128790, name: 'VRK The Watermark' },
  { sandstar_id: 128010, name: 'CVM13 Regus Suite 200' },
  { sandstar_id: 127763, name: 'VRK All In Aviation' },
  { sandstar_id: 127761, name: 'VRK Regus Suite 500' },
];

async function waitForToken(page, max = 20000) {
  for (let e = 0; e < max; e += 500) {
    const t = await page.evaluate(() => localStorage.getItem('token')).catch(() => null);
    if (t) return t;
    await page.waitForTimeout(500);
  }
  return null;
}

async function login(page) {
  await page.goto('https://prod-ops-us.sandstar.com/#/pages/login/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
  const existing = await waitForToken(page, 2000);
  if (existing) return existing;
  await page.waitForSelector('input[type="password"]', { timeout: 20000 });
  await page.$('input:not([type="password"])').then(f => f.fill(EMAIL));
  await page.$('input[type="password"]').then(f => f.fill(PASS));
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('*')].filter(e =>
      e.textContent.trim() === 'Login' && getComputedStyle(e).cursor === 'pointer');
    if (btns[0]) btns[0].click();
  });
  await page.waitForURL(u => !u.includes('pages/login/login'), { timeout: 15000 }).catch(() => {});
  const card = await page.$('text=Kande VendTech').catch(() => null);
  if (card) { await card.click(); await page.waitForURL(u => !u.includes('login'), { timeout: 15000 }).catch(() => {}); }
  return waitForToken(page, 20000);
}

async function getStockForMachine(page, machine) {
  // Navigate to replenishment page for this machine
  await page.goto(
    `https://prod-ops-us.sandstar.com/#/pages/replenishment/page/current-stock-new?id=${machine.sandstar_id}`,
    { waitUntil: 'domcontentloaded', timeout: 30000 }
  );
  await page.waitForTimeout(3000);

  const result = await page.evaluate(async ({ api, org, scope, freezerId }) => {
    const token = localStorage.getItem('token');
    const h = { 'Content-Type': 'application/json', 'x-token': token, 'app-scope': scope, 'organSn': org };

    const endpoints = [
      { path: '/stock/getFreezerStockForPage', body: { pageNum: 1, pageSize: 500, freezerId } },
      { path: '/stock/getMerchantStockForPage', body: { pageNum: 1, pageSize: 500, freezerId, organSn: org } },
      { path: '/replenishment/getReplenishmentList', body: { pageNum: 1, pageSize: 500, freezerId } },
    ];

    for (const ep of endpoints) {
      try {
        const r = await fetch(`${api}${ep.path}`, { method: 'POST', headers: h, body: JSON.stringify(ep.body) });
        const d = await r.json();
        const list = d?.data?.records || d?.data?.list || d?.data?.resultList || (Array.isArray(d?.data) ? d.data : []);
        if (Array.isArray(list) && list.length > 0) {
          return { endpoint: ep.path, items: list };
        }
      } catch (e) {}
    }
    return { endpoint: 'none', items: [] };
  }, { api: API, org: ORG, scope: SCOPE, freezerId: machine.sandstar_id });

  return result.items.map(item => ({
    machine_name: machine.name,
    sandstar_machine_id: machine.sandstar_id,
    product_name: item.skuName || item.productName || item.name || item.goodsName || item.itemName || '',
    current_quantity: item.stockRealtime ?? item.currentNum ?? item.currentQuantity ?? item.stock ?? 0,
    capacity: item.stockInitial ?? item.capacity ?? item.maxQuantity ?? item.totalNum ?? 0,
    lane_no: item.laneNo || item.lane || '',
    synced_at: new Date().toISOString(),
  })).filter(i => i.product_name);
}

function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(`${DASH_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': DASH_KEY, 'Content-Length': Buffer.byteLength(data) }
    }, res => {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  const token = await login(page);
  if (!token) { console.error('Login failed'); process.exit(1); }
  console.log(`Logged in. Syncing ${MACHINES.length} machines...`);

  const allRecords = [];
  for (const machine of MACHINES) {
    try {
      const items = await getStockForMachine(page, machine);
      allRecords.push(...items);
      console.log(`  ${machine.name}: ${items.length} products`);
    } catch (e) {
      console.error(`  ${machine.name}: ERROR - ${e.message}`);
    }
  }

  await browser.close();

  if (allRecords.length === 0) {
    console.error('No stock data fetched — aborting push');
    process.exit(1);
  }

  console.log(`Pushing ${allRecords.length} records to Railway...`);
  const r = await post('/api/office-stock-sync', { records: allRecords });
  console.log(`Push result: ${r.status} ${r.body.slice(0, 100)}`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
