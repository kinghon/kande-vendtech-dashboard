#!/usr/bin/env node
const { chromium } = require('/opt/homebrew/lib/node_modules/playwright');

const EMAIL = 'etang106@gmail.com';
const PASS  = 'kurtis123####';
const API   = 'https://webapi-us.sandstar.com';
const ORG   = '001020';
const SCOPE = '12';

const MACHINES = [
  { id: 127763, name: 'VRK All In Aviation' },
  { id: 127761, name: 'VRK Regus Ste 500' },
  { id: 128010, name: 'CVM13 Regus Ste 200' },
];

const FRESH_KEYWORDS = ['sub','sandwich','wrap','salad','biscuit','sausage','get fresh','turkey','italian','roast beef','chicken','grilled','juicery','pressed','core power','fairlife'];

async function waitForToken(page, maxMs = 20000) {
  for (let e = 0; e < maxMs; e += 500) {
    const t = await page.evaluate(() => localStorage.getItem('token')).catch(() => null);
    if (t) return t;
    await page.waitForTimeout(500);
  }
  return null;
}

async function login(page) {
  await page.goto('https://prod-ops-us.sandstar.com/#/pages/login/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  const existing = await waitForToken(page, 2000);
  if (!existing) {
    await page.waitForSelector('input[type="password"]', { timeout: 30000 });
    const id = await page.$('input:not([type="password"])');
    const pw = await page.$('input[type="password"]');
    await id.fill(EMAIL);
    await pw.fill(PASS);
    await page.evaluate(() => {
      [...document.querySelectorAll('*')].find(e => e.textContent.trim()==='Login' && getComputedStyle(e).cursor==='pointer')?.click();
    });
    await page.waitForURL(url => !url.includes('pages/login/login'), { timeout: 15000 }).catch(() => {});
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    const card = await page.$('text=Kande VendTech').catch(() => null);
    if (card) { await card.click(); await page.waitForURL(url => !url.includes('login'), { timeout: 15000 }).catch(() => {}); }
  }
  return waitForToken(page, 20000);
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const token = await login(page);
  const org = await page.evaluate(() => localStorage.getItem('organSn')) || ORG;
  console.error('Token:', token?.substring(0,12), 'organSn:', org);

  // Capture all API calls from the replenishment page
  const apiCalls = [];
  await page.route('**/webapi-us.sandstar.com/**', async route => {
    const req = route.request();
    apiCalls.push({ url: req.url(), method: req.method(), body: req.postData() });
    await route.continue();
  });

  // Load replenishment page for Aviation
  await page.goto('https://prod-ops-us.sandstar.com/#/pages/replenishment/page/current-stock-new?id=127763', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(4000);

  console.error('\n=== API calls made by replenishment page ===');
  for (const c of apiCalls) {
    console.error(c.method, c.url, c.body?.slice(0,100));
  }

  // Now try to get restock history for fresh foods
  const results = await page.evaluate(async ({ api, org, scope }) => {
    const h = { 'Content-Type': 'application/json', 'x-token': localStorage.getItem('token'), 'app-scope': scope, 'organSn': org };
    const endpoints = [
      { ep: '/replenishment/getReplenishmentRecord', body: { pageNum:1, pageSize:50, freezerId:127763, organSn: org } },
      { ep: '/replenishment/getReplenishmentList', body: { pageNum:1, pageSize:50, freezerId:127763 } },
      { ep: '/stock/getStockRecord', body: { pageNum:1, pageSize:50, freezerId:127763 } },
      { ep: '/stock/getStockLog', body: { pageNum:1, pageSize:50, freezerId:127763 } },
      { ep: '/stock/getStockHistory', body: { pageNum:1, pageSize:50, freezerId:127763 } },
    ];
    const out = {};
    for (const { ep, body } of endpoints) {
      try {
        const r = await fetch(`${api}${ep}`, { method:'POST', headers:h, body: JSON.stringify(body) });
        const d = await r.json();
        out[ep] = { code: d.code||d.status, count: (d.data?.list||d.data?.records||d.data||[]).length, sample: JSON.stringify(d).slice(0,300) };
      } catch(e) { out[ep] = { error: e.message }; }
    }
    return out;
  }, { api: API, org, scope: SCOPE });

  for (const [ep, r] of Object.entries(results)) {
    console.log(`${ep}: code=${r.code} count=${r.count}`);
    if (r.count > 0) console.log('  sample:', r.sample?.slice(0,200));
  }

  await browser.close();
}
main().catch(e => { console.error(e.message); process.exit(1); });
