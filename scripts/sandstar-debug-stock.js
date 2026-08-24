#!/usr/bin/env node
const { chromium } = require('/opt/homebrew/lib/node_modules/playwright');
const EMAIL = 'etang106@gmail.com', PASS = 'kurtis123####';
const API = 'https://webapi-us.sandstar.com', ORG = '001020', SCOPE = '12';
const FREEZER_ID = 131520;

async function waitForToken(p, max = 20000) {
  for (let e = 0; e < max; e += 500) {
    const t = await p.evaluate(() => localStorage.getItem('token')).catch(() => null);
    if (t) return t;
    await p.waitForTimeout(500);
  }
  return null;
}

(async () => {
  const b = await chromium.launch({ headless: true });
  const p = await b.newPage();
  await p.goto(`https://prod-ops-us.sandstar.com/#/pages/replenishment/page/current-stock-new?id=${FREEZER_ID}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await p.waitForSelector('input[type="password"]', { timeout: 20000 }).catch(() => {});
  const pw = await p.$('input[type="password"]');
  if (pw) {
    await p.$('input:not([type="password"])').then(f => f.fill(EMAIL));
    await pw.fill(PASS);
    await p.evaluate(() => { [...document.querySelectorAll('*')].filter(e => e.textContent.trim() === 'Login' && getComputedStyle(e).cursor === 'pointer')[0]?.click(); });
    await p.waitForTimeout(5000);
    const card = await p.$('text=Kande VendTech').catch(() => null);
    if (card) { await card.click(); await p.waitForURL(u => !u.includes('login'), { timeout: 10000 }).catch(() => {}); }
  }
  const token = await waitForToken(p, 20000);
  if (!token) { console.log('NO TOKEN'); await b.close(); return; }

  const result = await p.evaluate(async ({ api, org, scope, freezerId }) => {
    const t = localStorage.getItem('token');
    const h = { 'Content-Type': 'application/json', 'x-token': t, 'app-scope': scope, 'organSn': org };
    // Get page 1 to find rowcount
    const r1 = await fetch(`${api}/goods/v2/getGoodsAtShelvesByFreezerIdV2`, { method: 'POST', headers: h, body: JSON.stringify({ freezerId, organSn: org, pageNum: 1, pageSize: 100 }) });
    const d1 = await r1.json();
    const data1 = d1?.data;
    const rowcount = data1?.rowcount || 0;
    const list1 = data1?.resultList || [];
    // Sample the first item
    const sample = list1[0];
    return { rowcount, page1count: list1.length, sampleKeys: sample ? Object.keys(sample) : [], sampleName: sample?.skuName||sample?.goodsName||sample?.productName||sample?.name, sampleStock: {stockRealtime: sample?.stockRealtime, stockInitial: sample?.stockInitial, currentNum: sample?.currentNum, capacity: sample?.capacity, maxNum: sample?.maxNum} };
  }, { api: API, org: ORG, scope: SCOPE, freezerId: FREEZER_ID });

  console.log(JSON.stringify(result, null, 2));
  await b.close();
})().catch(e => { console.error(e.message); process.exit(1); });
