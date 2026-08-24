#!/usr/bin/env node
// sandstar-live-stock.js <freezerId>
// Logs into Sandstar, pulls live current stock for a machine, outputs JSON
const { chromium } = require('/opt/homebrew/lib/node_modules/playwright');

const EMAIL = 'etang106@gmail.com';
const PASS  = 'kurtis123####';
const API   = 'https://webapi-us.sandstar.com';
const ORG   = '001020';
const SCOPE = '12';

const freezerId = parseInt(process.argv[2]);
if (!freezerId) { console.error('Usage: node sandstar-live-stock.js <freezerId>'); process.exit(1); }

async function waitForToken(page, max = 20000) {
  for (let e = 0; e < max; e += 500) {
    const t = await page.evaluate(() => localStorage.getItem('token')).catch(() => null);
    if (t) return t;
    await page.waitForTimeout(500);
  }
  return null;
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  await page.goto('https://prod-ops-us.sandstar.com/#/pages/login/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
  const existing = await waitForToken(page, 2000);
  if (!existing) {
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
    if (card) {
      await card.click();
      await page.waitForURL(u => !u.includes('login'), { timeout: 15000 }).catch(() => {});
    }
  }

  const token = await waitForToken(page, 20000);
  if (!token) { console.error('Login failed'); process.exit(1); }

  const data = await page.evaluate(async ({ api, org, scope, freezerId }) => {
    const h = { 'Content-Type': 'application/json', 'x-token': localStorage.getItem('token'), 'app-scope': scope, 'organSn': org };
    // Try multiple stock endpoints
    const endpoints = [
      { path: '/stock/getFreezerStockForPage', body: { pageNum: 1, pageSize: 500, freezerId } },
      { path: '/stock/getStockForPage', body: { pageNum: 1, pageSize: 500, freezerId } },
      { path: '/stock/getFreezerStock', body: { freezerId } },
    ];
    for (const ep of endpoints) {
      try {
        const r = await fetch(`${api}${ep.path}`, { method: 'POST', headers: h, body: JSON.stringify(ep.body) });
        const d = await r.json();
        const list = d?.data?.records || d?.data?.list || d?.data?.resultList || d?.data || [];
        if (Array.isArray(list) && list.length > 0) return { endpoint: ep.path, items: list };
      } catch(e) {}
    }
    // Fallback: load the replenishment page and scrape DOM
    return { endpoint: 'dom', items: [] };
  }, { api: API, org: ORG, scope: SCOPE, freezerId });

  if (!data.items.length) {
    // Fallback: navigate to replenishment page and scrape
    await page.goto(`https://prod-ops-us.sandstar.com/#/pages/replenishment/page/current-stock-new?id=${freezerId}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(4000);
    const domItems = await page.evaluate(async ({ api, org, scope, freezerId }) => {
      const h = { 'Content-Type': 'application/json', 'x-token': localStorage.getItem('token'), 'app-scope': scope, 'organSn': org };
      const endpoints = [
        { path: '/stock/getFreezerStockForPage', body: { pageNum: 1, pageSize: 500, freezerId } },
        { path: '/stock/getMerchantStockForPage', body: { pageNum: 1, pageSize: 500, freezerId, organSn: org } },
        { path: '/replenishment/getReplenishmentList', body: { pageNum: 1, pageSize: 200, freezerId } },
      ];
      for (const ep of endpoints) {
        try {
          const r = await fetch(`${api}${ep.path}`, { method: 'POST', headers: h, body: JSON.stringify(ep.body) });
          const d = await r.json();
          const list = d?.data?.records || d?.data?.list || d?.data?.resultList || (Array.isArray(d?.data) ? d.data : []);
          if (Array.isArray(list) && list.length > 0) return { endpoint: ep.path, items: list };
        } catch(e) {}
      }
      return { endpoint: 'none', items: [] };
    }, { api: API, org: ORG, scope: SCOPE, freezerId });
    data.endpoint = domItems.endpoint;
    data.items = domItems.items;
  }

  // Normalize items to { name, current, capacity, needed }
  const normalized = data.items.map(item => {
    const name = item.skuName || item.productName || item.name || item.goodsName || item.itemName || '';
    const current = item.stockRealtime ?? item.currentNum ?? item.currentQuantity ?? item.stock ?? 0;
    const capacity = item.stockInitial ?? item.capacity ?? item.maxQuantity ?? item.totalNum ?? 0;
    const needed = Math.max(0, capacity - current);
    return { name, current, capacity, needed, lane: item.laneNo || item.lane || '' };
  }).filter(i => i.name);

  console.log(JSON.stringify({ freezerId, endpoint: data.endpoint, items: normalized }));
  await browser.close();
}

main().catch(e => { console.error(e.message); process.exit(1); });
