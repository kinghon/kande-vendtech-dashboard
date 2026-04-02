/**
 * Phase 2: Scrape every post and all comments from post-urls.json
 */
const { chromium } = require('/Users/kurtishon/clawd/scripts/node_modules/playwright-core');
const fs = require('fs');
const path = require('path');

const COOKIES_PATH = '/tmp/mighty-cookies.json';
const URLS_PATH = '/Users/kurtishon/kande-vendtech/research/mighty-networks/post-urls.json';
const PROGRESS_PATH = '/Users/kurtishon/kande-vendtech/research/mighty-networks/full-scrape-progress.json';
const POSTS_DIR = '/Users/kurtishon/kande-vendtech/research/mighty-networks/posts';
const OUTPUT_PATH = '/Users/kurtishon/kande-vendtech/research/mighty-networks/community-posts-latest.json';
const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function loadProgress() {
  try {
    const p = JSON.parse(fs.readFileSync(PROGRESS_PATH, 'utf8'));
    // Ensure arrays are initialized
    p.done = Array.isArray(p.done) ? p.done : [];
    p.failed = Array.isArray(p.failed) ? p.failed : [];
    p.total = p.total || 0;
    return p;
  } catch {
    return { done: [], failed: [], total: 0 };
  }
}

function saveProgress(progress) {
  fs.writeFileSync(PROGRESS_PATH, JSON.stringify(progress, null, 2));
}

function getSlug(url) {
  const match = url.match(/\/posts\/([^/?#]+)/);
  return match ? match[1] : null;
}

async function scrapePost(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
  await page.waitForTimeout(1500);
  
  // Check for login redirect
  const currentUrl = page.url();
  if (currentUrl.includes('sign_in') || currentUrl.includes('login')) {
    throw new Error('COOKIE_EXPIRED');
  }
  
  // Scroll inner container to load all comments (max 15 rounds)
  let prevHeight = 0;
  let stableCount = 0;
  for (let i = 0; i < 15; i++) {
    const newHeight = await page.evaluate(() => {
      const el = document.querySelector('#page-layout') || document.querySelector('.scrollable-area');
      if (el) {
        el.scrollTop = el.scrollHeight;
        return el.scrollHeight;
      }
      window.scrollTo(0, document.body.scrollHeight);
      return document.body.scrollHeight;
    });
    await page.waitForTimeout(600);
    if (newHeight === prevHeight) {
      stableCount++;
      if (stableCount >= 2) break;
    } else {
      stableCount = 0;
    }
    prevHeight = newHeight;
  }
  
  // Click "load more" buttons to expand hidden replies (max 10 rounds)
  for (let round = 0; round < 10; round++) {
    const clicked = await page.evaluate(() => {
      const btns = document.querySelectorAll('a.btn-load-more-previous, a.btn-load-more, button.btn-load-more-previous, button.btn-load-more');
      let count = 0;
      btns.forEach(btn => {
        if (btn.offsetParent !== null) { // visible
          btn.click();
          count++;
        }
      });
      return count;
    });
    if (clicked === 0) break;
    await page.waitForTimeout(700);
  }
  
  // Capture full text content
  const content = await page.evaluate(() => {
    const container = document.querySelector('.flex-space-layout') || document.querySelector('#page-layout');
    return container ? container.innerText : document.body.innerText;
  });
  
  // Also grab some metadata
  const title = await page.title();
  
  return {
    url,
    title,
    scrapedAt: new Date().toISOString(),
    content,
  };
}

async function compileAllPosts() {
  console.log('\nCompiling all posts into community-posts-latest.json...');
  const files = fs.readdirSync(POSTS_DIR).filter(f => f.endsWith('.json'));
  const allPosts = [];
  for (const f of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(POSTS_DIR, f), 'utf8'));
      allPosts.push(data);
    } catch {}
  }
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(allPosts, null, 2));
  console.log(`Compiled ${allPosts.length} posts into ${OUTPUT_PATH}`);
}

async function main() {
  // Ensure posts dir exists
  fs.mkdirSync(POSTS_DIR, { recursive: true });
  
  // Load URLs
  if (!fs.existsSync(URLS_PATH)) {
    console.error('post-urls.json not found! Run Phase 1 first.');
    process.exit(1);
  }
  const urls = JSON.parse(fs.readFileSync(URLS_PATH, 'utf8'));
  console.log(`Loaded ${urls.length} post URLs`);
  
  // Load progress
  const progress = loadProgress();
  const doneSet = new Set(progress.done);
  progress.total = urls.length;
  
  const remaining = urls.filter(u => !doneSet.has(u));
  console.log(`Already done: ${doneSet.size}, Remaining: ${remaining.length}`);
  
  if (remaining.length === 0) {
    console.log('All posts already scraped!');
    await compileAllPosts();
    return;
  }
  
  // Load cookies
  const cookiesRaw = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf8'));
  
  // Launch browser
  console.log('Launching browser...');
  const browser = await chromium.launch({
    executablePath: CHROME_PATH,
    headless: false,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });
  
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });
  await context.addCookies(cookiesRaw);
  
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  
  let scraped = 0;
  let failed = 0;
  const startTime = Date.now();
  
  for (let i = 0; i < remaining.length; i++) {
    const url = remaining[i];
    const slug = getSlug(url) || `post-${i}`;
    const outputFile = path.join(POSTS_DIR, `${slug}.json`);
    
    try {
      const postData = await scrapePost(page, url);
      fs.writeFileSync(outputFile, JSON.stringify(postData, null, 2));
      
      progress.done.push(url);
      doneSet.add(url);
      saveProgress(progress);
      scraped++;
      
      if ((i + 1) % 10 === 0) {
        const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
        const rate = (scraped / ((Date.now() - startTime) / 1000)).toFixed(2);
        console.log(`Progress: ${i + 1}/${remaining.length} | Done: ${progress.done.length}/${urls.length} | Failed: ${failed} | Elapsed: ${elapsed}min | Rate: ${rate}/s`);
      }
    } catch (err) {
      console.error(`FAILED [${slug}]: ${err.message}`);
      
      if (err.message === 'COOKIE_EXPIRED') {
        console.error('Cookies expired! Stopping.');
        saveProgress(progress);
        await browser.close();
        process.exit(1);
      }
      
      // Log failure and continue
      if (!progress.failed.includes(url)) {
        progress.failed.push(url);
      }
      saveProgress(progress);
      failed++;
      
      // Brief pause on error
      await page.waitForTimeout(2000);
    }
  }
  
  await browser.close();
  
  const totalDone = progress.done.length;
  console.log(`\n=== Phase 2 Complete ===`);
  console.log(`Scraped this run: ${scraped}`);
  console.log(`Total done: ${totalDone}/${urls.length}`);
  console.log(`Failed: ${failed}`);
  
  // Compile
  await compileAllPosts();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
