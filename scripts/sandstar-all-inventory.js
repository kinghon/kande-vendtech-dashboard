#!/usr/bin/env node
const { chromium } = require('/opt/homebrew/lib/node_modules/playwright');

const EMAIL = 'etang106@gmail.com';
const PASS  = 'kurtis123####';
const API   = 'https://webapi-us.sandstar.com';
const ORG   = '001020';
const SCOPE = '12';

async function waitForToken(page, maxMs = 20000) {
  for (let e = 0; e < maxMs; e += 500) {
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
  await page.waitForLoadState('domcontentloaded').catch(() => {});

  const existing = await waitForToken(page, 2000);
  if (!existing) {
    await page.waitForSelector('input[type="password"]', { timeout: 40000 });
    const idField = await page.$('input:not([type="password"])');
    const pwField = await page.$('input[type="password"]');
    await idField.fill(EMAIL);
    await pwField.fill(PASS);
    await page.evaluate(() => {
      const btns = [...document.querySelectorAll('*')].filter(e =>
        e.textContent.trim() === 'Login' && getComputedStyle(e).cursor === 'pointer'
      );
      if (btns[0]) btns[0].click();
    });
    await page.waitForURL(url => !url.includes('pages/login/login'), { timeout: 15000 }).catch(() => {});
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    const card = await page.$('text=Kande VendTech').catch(() => null);
    if (card) {
      await card.click();
      await page.waitForURL(url => !url.includes('login'), { timeout: 15000 }).catch(() => {});
      await page.waitForLoadState('domcontentloaded').catch(() => {});
    }
  }

  const token = await waitForToken(page, 20000);
  const organSn = await page.evaluate(() => localStorage.getItem('organSn')) || ORG;
  console.error('Token:', token ? token.substring(0,12)+'...' : 'NONE', '| organSn:', organSn);

  // Call all endpoints from within browser context
  const results = await page.evaluate(async ({ api, org, scope, token }) => {
    const h = { 'Content-Type': 'application/json', 'x-token': token, 'app-scope': scope, 'organSn': org };
    const endpoints = [
      '/stock/getFreezerStockForPage',
      '/stock/getFreezerStockDetail',
      '/stock/getEquipmentInventoryList',
      '/stock/getMerchantStockForPage',
    ];
    const out = {};
    for (const ep of endpoints) {
      try {
        const r = await fetch(`${api}${ep}`, { method: 'POST', headers: h, body: JSON.stringify({ pageNum: 1, pageSize: 500, organSn: org }) });
        const d = await r.json();
        const arr = d.data?.list || d.data?.records || (Array.isArray(d.data) ? d.data : []);
        out[ep] = { count: arr.length, code: d.code || d.status, items: arr };
      } catch(e) {
        out[ep] = { error: e.message };
      }
    }
    return out;
  }, { api: API, org: organSn, scope: SCOPE, token });

  for (const [ep, data] of Object.entries(results)) {
    console.log(`\n=== ${ep}: ${data.count ?? 'ERR'} records (code=${data.code || data.error}) ===`);
    if (data.items && data.items.length > 0) {
      // Show unique products
      const seen = new Set();
      for (const item of data.items) {
        const name = item.goodsName || item.name || item.skuName || JSON.stringify(item).slice(0,60);
        if (!seen.has(name)) {
          seen.add(name);
          console.log(` ${name} | machine: ${item.freezerName || item.machineName || '-'} | stocked: ${item.stockInitial ?? '-'} | now: ${item.stockRealtime ?? item.currentNum ?? '-'}`);
        }
      }
    }
  }

  await browser.close();
}
main().catch(e => { console.error(e.message); process.exit(1); });
