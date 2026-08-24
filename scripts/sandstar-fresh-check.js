#!/usr/bin/env node
const { chromium } = require('/opt/homebrew/lib/node_modules/playwright');

const EMAIL = 'etang106@gmail.com';
const PASS  = 'kurtis123####';
const API   = 'https://webapi-us.sandstar.com';

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
    const merchantCard = await page.$('text=Kande VendTech').catch(() => null);
    if (merchantCard) {
      await merchantCard.click();
      await page.waitForURL(url => !url.includes('login'), { timeout: 15000 }).catch(() => {});
      await page.waitForLoadState('domcontentloaded').catch(() => {});
    }
  }

  const token = await waitForToken(page, 20000);
  const organSn = await page.evaluate(() => localStorage.getItem('organSn'));
  console.log('Token:', token ? token.substring(0, 12) + '...' : 'NONE');
  console.log('organSn:', organSn);

  const headers = {
    'Content-Type': 'application/json',
    'x-token': token,
    'app-scope': '12',
    'organSn': organSn || '001020'
  };

  const freshKeywords = ['sandwich', 'wrap', 'salad', 'fresh', 'juicery', 'pressed', 'fairlife', 'protein', 'bowl', 'sub', 'turkey', 'chicken'];

  const endpoints = [
    '/stock/getFreezerStockForPage',
    '/stock/getFreezerStockDetail',
    '/stock/getEquipmentInventoryList',
    '/stock/getMerchantStockForPage',
  ];

  for (const ep of endpoints) {
    try {
      const r = await fetch(`${API}${ep}`, {
        method: 'POST', headers,
        body: JSON.stringify({ pageNum: 1, pageSize: 500, organSn: organSn || '001020' })
      });
      const data = await r.json();
      const arr = data.data?.list || data.data?.records || (Array.isArray(data.data) ? data.data : []);
      console.log(`\n${ep}: ${arr.length} records (code=${data.code||data.status})`);
      const fresh = arr.filter(item => {
        const name = (item.goodsName || item.name || item.skuName || '').toLowerCase();
        return freshKeywords.some(k => name.includes(k));
      });
      if (fresh.length > 0) {
        console.log('FRESH ITEMS:');
        fresh.forEach(i => console.log(' -', i.goodsName || i.name, '| stocked:', i.stockInitial ?? '-', '| now:', i.stockRealtime ?? i.currentNum ?? '-', '| date:', i.timeInitial || '-'));
      } else if (arr.length > 0) {
        console.log('Sample:', arr.slice(0, 2).map(i => i.goodsName || i.name || JSON.stringify(i).slice(0, 60)));
      }
    } catch (e) {
      console.log(`${ep}: ERROR ${e.message}`);
    }
  }

  await browser.close();
}

main().catch(e => { console.error(e.message); process.exit(1); });
