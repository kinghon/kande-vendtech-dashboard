const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const OUTPUT_DIR = '/Users/kurtishon/kande-vendtech/research/mighty-networks';
const COOKIES_PATH = '/tmp/mighty-cookies.json';

(async () => {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  
  const browser = await chromium.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: false,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--window-size=1280,800', '--window-position=0,0']
  });
  
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36'
  });
  
  const cookies = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf8'));
  await context.addCookies(cookies);
  
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  
  const communitySpaces = [
    { name: 'connect-discuss', url: 'https://community.vendingpreneurs.com/spaces/21685660/feed' },
    { name: 'what-would-you-do', url: 'https://community.vendingpreneurs.com/spaces/22976996/feed' },
  ];
  
  const allPosts = {};
  
  // Helper: aggressively load ALL comments on a post page
  async function loadAllComments(page) {
    let totalExpanded = 0;
    const startTime = Date.now();
    const MAX_TIME = 30000; // 30 seconds max per post
    
    // Step 1: Scroll to bottom to trigger lazy-loading
    let lastHeight = 0;
    for (let i = 0; i < 15; i++) {
      if (Date.now() - startTime > MAX_TIME) break;
      const newHeight = await page.evaluate(() => {
        window.scrollBy(0, window.innerHeight * 3);
        return document.body.scrollHeight;
      });
      await page.waitForTimeout(800);
      if (newHeight === lastHeight) break;
      lastHeight = newHeight;
    }
    
    // Step 2: Click expand buttons — only target small, specific buttons (not large page elements)
    for (let round = 0; round < 15; round++) {
      if (Date.now() - startTime > MAX_TIME) break;
      
      const clickedCount = await page.evaluate(() => {
        let clicked = 0;
        // Only look at small clickable elements — buttons and short-text links/spans
        const clickTargets = Array.from(document.querySelectorAll('button, a, span'));
        for (const el of clickTargets) {
          const t = el.textContent?.trim().toLowerCase();
          if (!t || t.length > 50) continue; // Skip elements with lots of text (not buttons)
          // Skip if element is in nav/sidebar
          const rect = el.getBoundingClientRect();
          if (rect.width < 10 || rect.height < 10) continue; // Not visible
          if (rect.x < 200) continue; // Likely sidebar
          
          if (
            t === 'show more' || t === 'load more' || t === 'view more' ||
            t === 'more replies' || t === 'view replies' || t === 'show replies' ||
            t === 'see more' || t === 'read more' ||
            t === 'view all comments' || t === 'show all comments' ||
            t === 'view all replies' || t === 'show all replies' ||
            /^(view|show|see|load) \d+ (more )?(repl|comment)/.test(t) ||
            /^\d+ (more )?(repl|comment)/.test(t)
          ) {
            try { el.click(); clicked++; } catch(e) {}
          }
        }
        return clicked;
      });
      
      if (clickedCount === 0) break;
      totalExpanded += clickedCount;
      await page.waitForTimeout(1500);
      
      // Quick scroll after expanding
      await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
      await page.waitForTimeout(500);
    }
    
    // Step 3: Final scroll to bottom
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1000);
    
    return totalExpanded;
  }
  
  for (const space of communitySpaces) {
    console.log(`\n=== ${space.name} ===`);
    try {
      await page.goto(space.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(5000);
      
      const title = await page.title();
      if (title.includes('moment') || title.includes('Cloudflare')) {
        console.log('Cloudflare challenge, waiting...');
        await page.waitForTimeout(10000);
      }
    } catch(e) {
      console.log(`Failed to load ${space.name}: ${e.message.substring(0,50)}`);
      continue;
    }
    
    console.log('Page loaded:', await page.title());
    
    // Scroll the INNER container (#page-layout) — Mighty Networks uses an inner scrollable div, not window scroll
    let lastFeedHeight = 0;
    let feedStable = 0;
    for (let i = 0; i < 100; i++) {
      const h = await page.evaluate(() => {
        const container = document.querySelector('#page-layout') || document.querySelector('.scrollable-area');
        if (container) {
          container.scrollTop = container.scrollHeight;
          return container.scrollHeight;
        }
        // Fallback to window scroll
        window.scrollTo(0, document.body.scrollHeight);
        return document.body.scrollHeight;
      });
      await page.waitForTimeout(1200);
      if (h === lastFeedHeight) { feedStable++; if (feedStable > 8) break; }
      else { feedStable = 0; }
      lastFeedHeight = h;
      if (i % 15 === 0) console.log(`Feed scroll ${i+1}, height: ${h}`);
    }
    
    // Get post links
    const postLinks = await page.$$eval('a[href*="/posts/"]', els => {
      const seen = new Set();
      return els.map(e => ({ text: e.textContent?.trim()?.replace(/\s+/g, ' ').substring(0, 300), href: e.href }))
        .filter(l => {
          if (!l.text || l.text.length < 10 || l.text === 'All Comments' || seen.has(l.href)) return false;
          seen.add(l.href);
          return true;
        });
    });
    
    console.log(`Found ${postLinks.length} posts`);
    
    for (let i = 0; i < postLinks.length; i++) {
      const post = postLinks[i];
      const slug = post.href.split('/posts/')[1] || `post-${i}`;
      
      try {
        process.stdout.write(`  [${i+1}/${postLinks.length}] `);
        await page.goto(post.href, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForTimeout(3000);
        
        // Aggressively load every comment
        const expanded = await loadAllComments(page);
        
        // Capture the FULL page text — no truncation limit on individual comments
        const fullText = await page.evaluate(() => document.body.innerText);
        const charCount = fullText?.length || 0;
        
        // Also try to extract structured comment data
        const commentCount = await page.evaluate(() => {
          // Count comment-like elements
          const comments = document.querySelectorAll('[class*="comment"], [class*="reply"], [class*="response"]');
          return comments.length;
        });
        
        console.log(`${post.text.substring(0, 50)} (${charCount} chars, ~${commentCount} comments, ${expanded} expansions)`);
        
        allPosts[slug] = {
          title: post.text.substring(0, 200),
          url: post.href,
          space: space.name,
          fullText,
          commentCount,
          expandedElements: expanded,
          scrapedAt: new Date().toISOString()
        };
        
      } catch (err) {
        console.log(`ERROR: ${err.message.substring(0, 50)}`);
        allPosts[slug] = { title: post.text, url: post.href, space: space.name, error: err.message };
      }
    }
    
    // Save after each space
    fs.writeFileSync(path.join(OUTPUT_DIR, 'community-posts-latest.json'), JSON.stringify(allPosts, null, 2));
    console.log(`Saved ${Object.keys(allPosts).length} posts`);
  }
  
  // Dated copy
  fs.writeFileSync(path.join(OUTPUT_DIR, `community-posts-${new Date().toISOString().split('T')[0]}.json`), JSON.stringify(allPosts, null, 2));
  console.log(`\nTotal: ${Object.keys(allPosts).length} posts saved`);
  
  // Refresh cookies
  const newCookies = await context.cookies();
  fs.writeFileSync(COOKIES_PATH, JSON.stringify(newCookies, null, 2));
  
  await browser.close();
  console.log('Done!');
})();
