#!/usr/bin/env node
const { chromium } = require('/opt/homebrew/lib/node_modules/playwright');

const EMAIL = 'etang106@gmail.com';
const PASS  = 'kurtis123####';
const API   = 'https://webapi-us.sandstar.com';
const ORG   = '001020';
const SCOPE = '12';

const MACHINES = [
  { id: 127763, name: 'All In Aviation Academy' },
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
  // Navigate to replenishment page first so session is fully initialized
  await page.goto('https://prod-ops-us.sandstar.com/#/pages/replenishment/page/current-stock-new?id=127763', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  let token = await waitForToken(page, 2000);
  if (!token) { await login(page); token = await waitForToken(page, 5000); }
  const org = await page.evaluate(() => localStorage.getItem('organSn')) || ORG;
  console.error('Token:', token?.substring(0,12), 'org:', org);
  await page.waitForTimeout(3000);

  const output = {};

  for (const machine of MACHINES) {
    const data = await page.evaluate(async ({ api, org, scope, machineId }) => {
      const h = { 'Content-Type': 'application/json', 'x-token': localStorage.getItem('token'), 'app-scope': scope, 'organSn': org };
      
      // Get current shelf stock
      const shelvesRes = await fetch(`${api}/goods/v2/getGoodsAtShelvesByFreezerIdV2`, {
        method: 'POST', headers: h, body: JSON.stringify({ freezerId: String(machineId), page: 1, pageSize: 10000 })
      });
      const shelves = await shelvesRes.json();

      // Get replenishment records (last restocks)
      const replRes = await fetch(`${api}/goods/v2/findReplenishment`, {
        method: 'POST', headers: h, body: JSON.stringify({ freezerId: String(machineId), status: 1 })
      });
      const repl = await replRes.json();

      // Parse in-browser — extract only fresh food items with key fields
      const FRESH = ['sub','sandwich','wrap','salad','biscuit','sausage','get fresh','turkey','italian','roast beef','chicken','grilled','juicery','pressed','core power','fairlife'];
      const allItems = shelves.data?.resultList || shelves.data?.list || shelves.data || [];
      const freshItems = allItems.filter(i => {
        const n = (i.goodsName||'').toLowerCase();
        return FRESH.some(k => n.includes(k));
      }).map(i => ({ name: i.goodsName, capacity: i.capacity, now: i.stockRealtime, stockTime: i.stockTime, stockInit: i.stockInit, stockInitTime: i.stockInitTime }));
      
      // Parse replenishment records — find restock dates
      const replData = repl.data || {};
      const replItems = replData.resultList || replData.list || (Array.isArray(replData) ? replData : []);
      const freshRepl = replItems.filter(i => {
        const n = (i.goodsName||'').toLowerCase();
        return FRESH.some(k => n.includes(k));
      }).map(i => ({ name: i.goodsName, replenishTime: i.replenishTime || i.createtime || i.modifytime, qty: i.replenishNum || i.num, capacity: i.capacity }));
      
      return { freshItems, freshRepl, totalItems: allItems.length, totalRepl: replItems.length };
    }, { api: API, org, scope: SCOPE, machineId: machine.id });

    output[machine.name] = data;
    console.error(`Got data for ${machine.name}`);
  }

  console.log(JSON.stringify(output, null, 2));
  await browser.close();
}
main().catch(e => { console.error(e.message); process.exit(1); });
