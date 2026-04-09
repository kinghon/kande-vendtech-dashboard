const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const OUTPUT_DIR = '/Users/kurtishon/kande-vendtech/research/mighty-networks';
const COOKIES_PATH = '/tmp/mighty-cookies.json';
const PROGRESS_PATH = path.join(OUTPUT_DIR, 'full-scrape-progress.json');
const POSTS_DIR = path.join(OUTPUT_DIR, 'posts');

// Spaces to scrape
const SPACES = [
  { name: 'connect-discuss', url: 'https://community.vendingpreneurs.com/spaces/21685660/feed' },
  { name: 'what-would-you-do', url: 'https://community.vendingpreneurs.com/spaces/22976996/feed' },
];

function loadProgress() {
  try { return JSON.parse(fs.readFileSync(PROGRESS_PATH, 'utf8')); }
  catch { return { completedPosts: {}, spacesDiscovered: {} }; }
}

function saveProgress(progress) {
  fs.writeFileSync(PROGRESS_PATH, JSON.stringify(progress, null, 2));
}

function savePost(slug, data) {
  if (!fs.existsSync(POSTS_DIR)) fs.mkdirSync(POSTS_DIR, { recursive: true });
  fs.writeFileSync(path.join(POSTS_DIR, `${slug}.json`), JSON.stringify(data, null, 2));
}

(async () => {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  if (!fs.existsSync(POSTS_DIR)) fs.mkdirSync(POSTS_DIR, { recursive: true });
  
  const progress = loadProgress();
  
  const browser = await chromium.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: false,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--window-size=1280,900']
  });
  
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36'
  });
  
  const cookies = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf8'));
  await context.addCookies(cookies);
  
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  
  for (const space of SPACES) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`SPACE: ${space.name}`);
    console.log(`${'='.repeat(60)}`);
    
    // Step 1: Load the feed and discover ALL post URLs
    console.log('Loading feed...');
    try {
      await page.goto(space.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(5000);
      
      const title = await page.title();
      if (title.includes('moment') || title.includes('Cloudflare')) {
        console.log('Cloudflare challenge, waiting 15s...');
        await page.waitForTimeout(15000);
      }
    } catch(e) {
      console.log(`FAILED to load ${space.name}: ${e.message.substring(0, 60)}`);
      continue;
    }
    
    // Step 2: Scroll inner container until ALL posts are loaded
    console.log('Scrolling to load all posts...');
    let lastHeight = 0;
    let stableRounds = 0;
    let lastPostCount = 0;
    
    for (let i = 0; i < 200; i++) {
      const h = await page.evaluate(() => {
        const c = document.querySelector('#page-layout') || document.querySelector('.scrollable-area');
        if (c) { c.scrollTop = c.scrollHeight; return c.scrollHeight; }
        window.scrollTo(0, document.body.scrollHeight);
        return document.body.scrollHeight;
      });
      await page.waitForTimeout(1000);
      
      if (h === lastHeight) {
        stableRounds++;
        if (stableRounds > 10) {
          console.log(`Feed fully loaded at scroll ${i+1}`);
          break;
        }
      } else {
        stableRounds = 0;
      }
      lastHeight = h;
      
      if (i % 20 === 0) {
        const count = await page.$$eval('a[href*="/posts/"]', els => {
          const s = new Set();
          return els.filter(e => {
            const t = e.textContent?.trim();
            if (!t || t.length < 10 || t === 'All Comments' || s.has(e.href)) return false;
            s.add(e.href);
            return true;
          }).length;
        });
        console.log(`  Scroll ${i+1}: height=${h}, posts=${count}`);
        if (count === lastPostCount && count > 0 && i > 40) {
          console.log('  Post count stabilized, feed fully loaded');
          break;
        }
        lastPostCount = count;
      }
    }
    
    // Step 3: Extract ALL unique post URLs
    const postLinks = await page.$$eval('a[href*="/posts/"]', els => {
      const seen = new Set();
      return els.map(e => ({ text: e.textContent?.trim()?.replace(/\s+/g, ' ').substring(0, 300), href: e.href }))
        .filter(l => {
          if (!l.text || l.text.length < 10 || l.text === 'All Comments' || seen.has(l.href)) return false;
          seen.add(l.href);
          return true;
        });
    });
    
    console.log(`\nDiscovered ${postLinks.length} posts in ${space.name}`);
    progress.spacesDiscovered[space.name] = postLinks.length;
    saveProgress(progress);
    
    // Step 4: Visit EVERY post and scrape ALL comments
    let scraped = 0;
    let skipped = 0;
    
    for (let i = 0; i < postLinks.length; i++) {
      const post = postLinks[i];
      const slug = (post.href.split('/posts/')[1] || `post-${i}`).substring(0, 100);
      
      // Skip if already scraped
      if (progress.completedPosts[slug]) {
        skipped++;
        if (skipped % 20 === 0) console.log(`  Skipped ${skipped} already-scraped posts...`);
        continue;
      }
      
      try {
        process.stdout.write(`  [${i+1}/${postLinks.length}] `);
        
        await page.goto(post.href, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(2000);
        
        // Scroll the post page's inner container to load all comments
        let postLastHeight = 0;
        let postStable = 0;
        for (let s = 0; s < 50; s++) {
          const h = await page.evaluate(() => {
            const c = document.querySelector('#page-layout') || document.querySelector('.scrollable-area');
            if (c) { c.scrollTop = c.scrollHeight; return c.scrollHeight; }
            window.scrollTo(0, document.body.scrollHeight);
            return document.body.scrollHeight;
          });
          await page.waitForTimeout(600);
          if (h === postLastHeight) { postStable++; if (postStable > 4) break; }
          else { postStable = 0; }
          postLastHeight = h;
        }
        
        // Click ALL "Previous Replies", "More Replies", "Show More", etc.
        let totalClicked = 0;
        for (let round = 0; round < 30; round++) {
          const clicked = await page.evaluate(() => {
            let count = 0;
            const targets = Array.from(document.querySelectorAll('a.btn-load-more-previous, a.btn-load-more, button'));
            for (const el of targets) {
              const t = el.textContent?.trim().toLowerCase();
              if (!t || t.length > 60) continue;
              if (
                t.includes('previous replies') || t.includes('more replies') ||
                t.includes('show more') || t.includes('load more') ||
                t.includes('view more') || t.includes('see more') ||
                t.includes('view all') || t.includes('show all') ||
                /^(view|show|see|load) \d+/.test(t) || /^\d+ (more|prev)/.test(t)
              ) {
                try { el.click(); count++; } catch(e) {}
              }
            }
            return count;
          });
          
          if (clicked === 0) break;
          totalClicked += clicked;
          await page.waitForTimeout(1500);
          
          // Scroll again after expanding
          await page.evaluate(() => {
            const c = document.querySelector('#page-layout') || document.querySelector('.scrollable-area');
            if (c) c.scrollTop = c.scrollHeight;
          });
          await page.waitForTimeout(500);
        }
        
        // Final scroll pass
        for (let s = 0; s < 10; s++) {
          await page.evaluate(() => {
            const c = document.querySelector('#page-layout') || document.querySelector('.scrollable-area');
            if (c) c.scrollTop = c.scrollHeight;
          });
          await page.waitForTimeout(400);
        }
        
        // Capture FULL page text
        const fullText = await page.evaluate(() => {
          // Try to get just the main content area (not sidebar)
          const main = document.querySelector('.flex-space-layout') || document.querySelector('#page-layout');
          return (main || document.body).innerText;
        });
        
        const charCount = fullText?.length || 0;
        const shortTitle = post.text.substring(0, 55);
        console.log(`${shortTitle} (${charCount} chars, ${totalClicked} expanded)`);
        
        const postData = {
          title: post.text.substring(0, 300),
          url: post.href,
          space: space.name,
          fullText,
          expandedElements: totalClicked,
          scrapedAt: new Date().toISOString()
        };
        
        // Save individual post file
        savePost(slug, postData);
        
        // Mark as completed
        progress.completedPosts[slug] = { chars: charCount, expanded: totalClicked, at: new Date().toISOString() };
        scraped++;
        
        // Save progress every 5 posts
        if (scraped % 5 === 0) {
          saveProgress(progress);
          console.log(`  [Progress saved: ${scraped} scraped, ${skipped} skipped]`);
        }
        
      } catch (err) {
        console.log(`ERROR: ${err.message.substring(0, 60)}`);
        // Don't mark as completed so it retries next run
      }
    }
    
    // Save final progress for this space
    saveProgress(progress);
    console.log(`\n${space.name} complete: ${scraped} scraped, ${skipped} already done`);
  }
  
  // Compile all posts into a single dated file
  console.log('\nCompiling all posts...');
  const allPosts = {};
  const postFiles = fs.readdirSync(POSTS_DIR).filter(f => f.endsWith('.json'));
  for (const f of postFiles) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(POSTS_DIR, f), 'utf8'));
      allPosts[f.replace('.json', '')] = data;
    } catch(e) {}
  }
  
  const datePath = path.join(OUTPUT_DIR, `community-posts-${new Date().toISOString().split('T')[0]}.json`);
  fs.writeFileSync(datePath, JSON.stringify(allPosts, null, 2));
  fs.writeFileSync(path.join(OUTPUT_DIR, 'community-posts-latest.json'), JSON.stringify(allPosts, null, 2));
  console.log(`Compiled ${Object.keys(allPosts).length} posts to ${datePath}`);
  
  // Refresh cookies
  const newCookies = await context.cookies();
  fs.writeFileSync(COOKIES_PATH, JSON.stringify(newCookies, null, 2));
  
  // Summary
  const totalChars = Object.values(allPosts).reduce((sum, p) => sum + (p.fullText?.length || 0), 0);
  console.log(`\n${'='.repeat(60)}`);
  console.log(`SCRAPE COMPLETE`);
  console.log(`Total posts: ${Object.keys(allPosts).length}`);
  console.log(`Total content: ${(totalChars / 1024 / 1024).toFixed(1)} MB`);
  console.log(`${'='.repeat(60)}`);
  
  await browser.close();
})();
