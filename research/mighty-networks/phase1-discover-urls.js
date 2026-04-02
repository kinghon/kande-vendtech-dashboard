/**
 * Phase 1: Discover all post URLs from Vendingpreneurs Mighty Networks
 * Scrolls inner #page-layout container to load all posts
 */
const { chromium } = require('/Users/kurtishon/clawd/scripts/node_modules/playwright-core');
const fs = require('fs');
const path = require('path');

const COOKIES_PATH = '/tmp/mighty-cookies.json';
const OUTPUT_PATH = '/Users/kurtishon/kande-vendtech/research/mighty-networks/post-urls.json';
const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function savePartial(urls) {
  // Read existing, merge, save
  let existing = [];
  try { existing = JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf8')); } catch {}
  const merged = [...new Set([...existing, ...urls])];
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(merged, null, 2));
}

const SPACES = [
  { name: 'Connect & Discuss', url: 'https://community.vendingpreneurs.com/spaces/21685660/feed' },
  { name: 'What Would You Do', url: 'https://community.vendingpreneurs.com/spaces/22976996/feed' },
];

async function scrollAndCollect(page, spaceName) {
  console.log(`\n[${spaceName}] Starting scroll...`);
  
  const allUrls = new Set();
  let prevCount = 0;
  let stableRounds = 0;
  let scrollRound = 0;

  while (stableRounds < 5) {
    scrollRound++;
    
    // Scroll the inner container
    await page.evaluate(() => {
      const el = document.querySelector('#page-layout') || document.querySelector('.scrollable-area');
      if (el) {
        el.scrollTop = el.scrollHeight;
      } else {
        window.scrollTo(0, document.body.scrollHeight);
      }
    });
    
    // Wait for content to load
    await page.waitForTimeout(1200);
    
    // Collect post URLs
    const urls = await page.evaluate(() => {
      const links = document.querySelectorAll('a[href*="/posts/"]');
      const found = new Set();
      links.forEach(a => {
        const href = a.href;
        // Filter to actual post URLs (not anchors/fragments that are just sections)
        if (href && href.includes('/posts/') && !href.includes('#')) {
          // Normalize URL
          const url = href.split('?')[0];
          found.add(url);
        }
      });
      return Array.from(found);
    });
    
    urls.forEach(u => allUrls.add(u));
    
    const currentCount = allUrls.size;
    if (currentCount === prevCount) {
      stableRounds++;
    } else {
      stableRounds = 0;
    }
    prevCount = currentCount;
    
    if (scrollRound % 5 === 0) {
      console.log(`[${spaceName}] Round ${scrollRound}: ${currentCount} URLs found (stable: ${stableRounds}/5)`);
      // Save incrementally so crashes don't lose work
      savePartial(Array.from(allUrls));
    }
    
    // Safety limit
    if (scrollRound >= 300) {
      console.log(`[${spaceName}] Hit scroll limit of 300 rounds`);
      break;
    }
  }
  
  console.log(`[${spaceName}] Done! Found ${allUrls.size} post URLs after ${scrollRound} scroll rounds`);
  return Array.from(allUrls);
}

async function main() {
  console.log('Loading cookies...');
  const cookiesRaw = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf8'));
  
  console.log('Launching browser...');
  const browser = await chromium.launch({
    executablePath: CHROME_PATH,
    headless: false,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });
  
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });
  
  // Load cookies
  await context.addCookies(cookiesRaw);
  
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  
  let allPostUrls = [];
  
  for (const space of SPACES) {
    console.log(`\nNavigating to ${space.name}...`);
    try {
      await page.goto(space.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(3000);
      
      // Check for redirect to sign_in
      const currentUrl = page.url();
      if (currentUrl.includes('sign_in') || currentUrl.includes('login')) {
        console.error('COOKIE EXPIRED - redirected to login page!');
        break;
      }
      
      const urls = await scrollAndCollect(page, space.name);
      allPostUrls = allPostUrls.concat(urls);
    } catch (err) {
      console.error(`Error scraping ${space.name}:`, err.message);
    }
  }
  
  // Deduplicate
  const uniqueUrls = [...new Set(allPostUrls)];
  console.log(`\nTotal unique post URLs: ${uniqueUrls.length}`);
  
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(uniqueUrls, null, 2));
  console.log(`Saved to ${OUTPUT_PATH}`);
  
  await browser.close();
  console.log('Browser closed. Phase 1 complete!');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
