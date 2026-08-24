#!/usr/bin/env node
const { chromium } = require('/opt/homebrew/lib/node_modules/playwright');
const EMAIL = 'etang106@gmail.com', PASS = 'kurtis123####';
const API = 'https://webapi-us.sandstar.com', SCOPE = '12';

async function waitForToken(page, maxMs=20000) {
  for (let e=0; e<maxMs; e+=500) { const t=await page.evaluate(()=>localStorage.getItem('token')).catch(()=>null); if(t) return t; await page.waitForTimeout(500); } return null;
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('https://prod-ops-us.sandstar.com/#/pages/replenishment/page/current-stock-new?id=127763', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForLoadState('domcontentloaded').catch(()=>{});
  let token = await waitForToken(page, 2000);
  if (!token) {
    await page.waitForSelector('input[type="password"]', { timeout: 30000 });
    const id = await page.$('input:not([type="password"])'), pw = await page.$('input[type="password"]');
    await id.fill(EMAIL); await pw.fill(PASS);
    await page.evaluate(()=>[...document.querySelectorAll('*')].find(e=>e.textContent.trim()==='Login'&&getComputedStyle(e).cursor==='pointer')?.click());
    await page.waitForURL(url=>!url.includes('login'),{timeout:15000}).catch(()=>{});
    const card=await page.$('text=Kande VendTech').catch(()=>null);
    if(card){await card.click();await page.waitForURL(url=>!url.includes('login'),{timeout:15000}).catch(()=>{});}
  }
  token = await waitForToken(page, 20000);
  const org = await page.evaluate(()=>localStorage.getItem('organSn'))||'001020';
  console.error('Token:', token?.substring(0,12), 'org:', org);
  await page.waitForTimeout(2000);

  const MACHINES = [127763, 127761, 128010];
  const results = await page.evaluate(async ({ api, org, scope, machines }) => {
    const h = { 'Content-Type': 'application/json', 'x-token': localStorage.getItem('token'), 'app-scope': scope, 'organSn': org };
    const out = {};
    for (const mid of machines) {
      // Try findReplenishment with different status values
      const statuses = [null, 0, 1, 2, 3];
      for (const status of statuses) {
        const body = status !== null ? { freezerId: String(mid), status } : { freezerId: String(mid) };
        const r = await fetch(`${api}/goods/v2/findReplenishment`, { method: 'POST', headers: h, body: JSON.stringify(body) });
        const d = await r.json();
        const items = d.data?.resultList || d.data?.list || (Array.isArray(d.data) ? d.data : []);
        if (items.length > 0) {
          if (!out[mid]) out[mid] = {};
          out[mid][`status_${status}`] = items.map(i => ({
            name: i.goodsName || i.name,
            replenishNum: i.replenishNum,
            replenishTime: i.replenishTime || i.createtime,
            currentNum: i.currentNum || i.stockRealtime,
            keys: Object.keys(i).filter(k => i[k] !== null && i[k] !== undefined).join(',')
          }));
        }
      }
      // Also try getReplenishmentRecordForPage
      const r2 = await fetch(`${api}/replenishment/getReplenishmentRecordForPage`, { method: 'POST', headers: h, body: JSON.stringify({ freezerId: String(mid), pageNum: 1, pageSize: 50 }) });
      const d2 = await r2.json();
      const items2 = d2.data?.list || d2.data?.resultList || (Array.isArray(d2.data) ? d2.data : []);
      if (items2.length > 0) { if (!out[mid]) out[mid] = {}; out[mid]['getReplenishmentRecordForPage'] = items2.slice(0,3); }
    }
    return out;
  }, { api: API, org, scope: SCOPE, machines: MACHINES });

  console.log(JSON.stringify(results, null, 2));
  await browser.close();
}
main().catch(e => { console.error(e.message); process.exit(1); });
