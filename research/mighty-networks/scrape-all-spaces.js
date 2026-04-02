/**
 * Vendingpreneurs Mighty Networks - Full Content Scraper
 * Scrapes all 21 spaces, saves JSON + Markdown, compiles master doc
 */

const { chromium } = require('/Users/kurtishon/clawd/scripts/node_modules/playwright-core');
const fs = require('fs');
const path = require('path');

const OUTPUT_DIR = '/Users/kurtishon/kande-vendtech/research/mighty-networks/spaces';
const COOKIES_FILE = '/tmp/mighty-cookies.json';
const PROGRESS_FILE = '/Users/kurtishon/kande-vendtech/research/mighty-networks/scrape-progress.json';
const COMPILED_FILE = '/Users/kurtishon/kande-vendtech/research/mighty-networks/mighty-course-content-compiled.md';

const SPACES = [
  // Course Modules
  { id: '22525910', name: 'module-1-mindset-foundations', label: 'Module 1: Mindset and Foundations', category: 'Course Modules' },
  { id: '22526041', name: 'module-2-business-basics-compliance', label: 'Module 2: Business Basics & Compliance', category: 'Course Modules' },
  { id: '22526222', name: 'module-3-location-selection', label: 'Module 3: Location Selection', category: 'Course Modules' },
  { id: '22526291', name: 'module-4-branding-essentials', label: 'Module 4: Branding Essentials', category: 'Course Modules' },
  { id: '22526255', name: 'module-5-pop-ins-sales-foundations', label: 'Module 5: Pop-Ins & Sales Foundations', category: 'Course Modules' },
  { id: '22526453', name: 'module-6-product-pricing-essentials', label: 'Module 6: Product & Pricing Essentials', category: 'Course Modules' },
  { id: '22526547', name: 'module-7-getting-set-up-yes-install', label: 'Module 7: Getting Set Up – Yes → Install', category: 'Course Modules' },
  // Operations
  { id: '22727689', name: 'scaling-transitions', label: 'Scaling Transitions', category: 'Operations' },
  { id: '22728050', name: 'product-mix-merchandising', label: 'Product Mix & Merchandising', category: 'Operations' },
  { id: '22728390', name: 'refill-cadence-visit-purpose', label: 'Refill Cadence & Visit Purpose', category: 'Operations' },
  { id: '22728431', name: 'using-vendhub-in-operations', label: 'Using VendHub in Operations', category: 'Operations' },
  { id: '22728475', name: 'inventory-ordering-discipline', label: 'Inventory & Ordering Discipline', category: 'Operations' },
  { id: '22728510', name: 'maintenance-breakage-reliability', label: 'Maintenance, Breakage & Reliability', category: 'Operations' },
  { id: '22848266', name: 'operator-walkthroughs', label: 'Operator Walkthroughs', category: 'Operations' },
  // Resources
  { id: '22797663', name: 'vendingpreneur-glossary', label: 'Vendingpreneur Glossary', category: 'Resources' },
  { id: '22843699', name: 'decision-guides', label: 'Decision Guides', category: 'Resources' },
  { id: '22862784', name: 'templates', label: 'Templates', category: 'Resources' },
  // Community
  { id: '21685660', name: 'connect-discuss', label: 'Connect & Discuss', category: 'Community' },
  { id: '22976996', name: 'what-would-you-do', label: 'What Would You Do?', category: 'Community' },
  { id: '23023404', name: 'modern-amenities-announcements', label: 'Modern Amenities Announcements', category: 'Community' },
  { id: '23011186', name: 'meet-your-ambassadors', label: 'Meet Your Ambassadors', category: 'Community' },
];

function loadProgress() {
  try {
    if (fs.existsSync(PROGRESS_FILE)) {
      return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
    }
  } catch(e) {}
  return { completed: [], failed: [], startedAt: new Date().toISOString() };
}

function saveProgress(progress) {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

async function waitForCloudflare(page) {
  // Check if Cloudflare challenge is present
  const title = await page.title().catch(() => '');
  if (title.includes('Just a moment') || title.includes('Cloudflare')) {
    console.log('  Cloudflare detected, waiting 15s...');
    await page.waitForTimeout(15000);
    // Wait for actual content
    try {
      await page.waitForFunction(() => !document.title.includes('Just a moment'), { timeout: 30000 });
    } catch(e) {
      console.log('  Cloudflare may still be active...');
    }
  }
}

async function scrollToLoadAll(page, maxScrolls = 20) {
  let lastHeight = 0;
  let scrollCount = 0;
  while (scrollCount < maxScrolls) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(2000);
    const newHeight = await page.evaluate(() => document.body.scrollHeight);
    if (newHeight === lastHeight) break;
    lastHeight = newHeight;
    scrollCount++;
  }
}

async function clickAllShowMore(page) {
  // Click all "show more", "load more", "see more" buttons
  let clicked = 0;
  for (let attempt = 0; attempt < 10; attempt++) {
    const buttons = await page.$$('button, [role="button"], a');
    let foundAny = false;
    for (const btn of buttons) {
      try {
        const text = (await btn.innerText().catch(() => '')).toLowerCase().trim();
        if (text.includes('show more') || text.includes('load more') || text.includes('see more') || 
            text.includes('view more') || text.includes('show all') || text.includes('expand') ||
            text.includes('read more')) {
          await btn.click().catch(() => {});
          await page.waitForTimeout(1000);
          clicked++;
          foundAny = true;
        }
      } catch(e) {}
    }
    if (!foundAny) break;
  }
  return clicked;
}

async function getPostLinks(page, spaceId) {
  // Get all post/lesson links from the space page
  const links = await page.evaluate((sid) => {
    const anchors = Array.from(document.querySelectorAll('a[href]'));
    const postLinks = new Set();
    for (const a of anchors) {
      const href = a.href;
      // Match post/content/lesson URLs for this space
      if (href.includes('community.vendingpreneurs.com') && 
          (href.includes('/posts/') || href.includes('/content/') || href.includes('/lessons/'))) {
        postLinks.add(href);
      }
    }
    return Array.from(postLinks);
  }, spaceId);
  return links;
}

async function scrapePostContent(page, url) {
  console.log(`    Scraping post: ${url}`);
  try {
    // Navigate and wait for domcontentloaded only — don't wait for all resources
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(e => null);
    
    // Wait for initial render
    await page.waitForTimeout(3000);
    await waitForCloudflare(page);
    
    // Try to wait for main content to appear (short timeout)
    try {
      await page.waitForSelector('article, main, [role="main"], .post-content, .space-resource', { timeout: 8000 });
    } catch(e) {
      // Continue even if selector not found
    }
    
    await page.waitForTimeout(1000);
    
    // Scroll down to trigger lazy loading
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => window.scrollBy(0, 800));
      await page.waitForTimeout(600);
    }
    
    const content = await page.evaluate(() => {
      // Try to get the main content area
      const mainSelectors = [
        'article',
        '[role="main"]',
        'main',
        '.space-resource',
        '.post-content',
        '.lesson-content', 
        '.space-post',
        '.content-area',
        '#content'
      ];
      
      for (const sel of mainSelectors) {
        const el = document.querySelector(sel);
        if (el && el.innerText.length > 200) return el.innerText;
      }
      // Fallback: full page text
      return document.body.innerText;
    });
    
    const title = await page.title();
    
    return {
      url,
      title,
      content: content.substring(0, 30000),
      scrapedAt: new Date().toISOString()
    };
  } catch(e) {
    console.log(`    ERROR scraping ${url}: ${e.message}`);
    return { url, title: '', content: '', error: e.message, scrapedAt: new Date().toISOString() };
  }
}

async function scrapeSpace(page, space) {
  console.log(`\n=== Scraping: ${space.label} ===`);
  const result = {
    spaceId: space.id,
    spaceName: space.name,
    spaceLabel: space.label,
    category: space.category,
    url: `https://community.vendingpreneurs.com/spaces/${space.id}`,
    scrapedAt: new Date().toISOString(),
    mainContent: '',
    posts: []
  };

  // Try /content first, then /feed, then base URL
  const urlsToTry = [
    `https://community.vendingpreneurs.com/spaces/${space.id}/content`,
    `https://community.vendingpreneurs.com/spaces/${space.id}/feed`,
    `https://community.vendingpreneurs.com/spaces/${space.id}`,
  ];

  let landed = false;
  for (const url of urlsToTry) {
    try {
      console.log(`  Trying: ${url}`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(3000);
      await waitForCloudflare(page);
      
      const title = await page.title();
      console.log(`  Page title: ${title}`);
      
      if (!title.includes('Just a moment') && !title.includes('Error') && !title.includes('404')) {
        landed = true;
        break;
      }
    } catch(e) {
      console.log(`  Failed: ${e.message}`);
    }
  }

  if (!landed) {
    console.log(`  FAILED to load space ${space.id}`);
    result.error = 'Could not load space';
    return result;
  }

  // Scroll to load all content (more scrolls for feed-type spaces)
  await scrollToLoadAll(page, 20);
  await clickAllShowMore(page);
  await page.waitForTimeout(1000);
  
  // Get main page content - capture more for feed-type spaces (no post links)
  result.mainContent = await page.evaluate(() => document.body.innerText).catch(() => '');
  result.mainContent = result.mainContent.substring(0, 80000);
  
  // Get post/lesson links
  const postLinks = await getPostLinks(page, space.id).catch(e => {
    console.log(`  Error getting post links: ${e.message}`);
    return [];
  });
  console.log(`  Found ${postLinks.length} post/lesson links`);
  
  // Also look for lesson links in a different way
  const additionalLinks = await page.evaluate(() => {
    try {
      const links = new Set();
      // Look for any internal navigation links
      document.querySelectorAll('a[href*="vendingpreneurs.com"]').forEach(a => {
        if (a.href.match(/\/posts\/|\/content\/|\/lessons\/|\/activities\//)) {
          links.add(a.href);
        }
      });
      return Array.from(links);
    } catch(e) {
      return [];
    }
  }).catch(() => []);
  
  // Filter out /comments URLs and anchor-only links
  const filteredLinks = [...new Set([...postLinks, ...additionalLinks])]
    .filter(url => !url.endsWith('/comments') && !url.endsWith('#') && !url.includes('/#'));
  const allLinks = filteredLinks;
  console.log(`  Total unique links: ${allLinks.length}`);
  
  // Scrape each post/lesson (limit to 15 for community spaces, 50 for others)
  const maxPosts = space.category === 'Community' ? 15 : 50;
  const linksToScrape = allLinks.slice(0, maxPosts);
  for (let i = 0; i < linksToScrape.length; i++) {
    const link = linksToScrape[i];
    try {
      const postData = await Promise.race([
        scrapePostContent(page, link),
        new Promise((_, reject) => setTimeout(() => reject(new Error('post timeout 60s')), 60000))
      ]);
      result.posts.push(postData);
    } catch(e) {
      console.log(`    TIMEOUT/ERROR on post ${link}: ${e.message}`);
      result.posts.push({ url: link, title: '', content: '', error: e.message });
    }
    await page.waitForTimeout(800); // Rate limiting
    
    // Save intermediate results every 5 posts to avoid losing everything on crash
    if ((i + 1) % 5 === 0) {
      const jsonPath = require('path').join(OUTPUT_DIR, `${space.name}.json`);
      require('fs').writeFileSync(jsonPath, JSON.stringify(result, null, 2));
      console.log(`    [Checkpoint] Saved ${i+1} posts`);
    }
  }

  return result;
}

function spaceToMarkdown(spaceData) {
  let md = `# ${spaceData.spaceLabel}\n`;
  md += `**Category:** ${spaceData.category}\n`;
  md += `**Space ID:** ${spaceData.spaceId}\n`;
  md += `**Scraped:** ${spaceData.scrapedAt}\n\n`;
  
  if (spaceData.error) {
    md += `> ⚠️ Error: ${spaceData.error}\n\n`;
  }
  
  if (spaceData.mainContent) {
    md += `## Space Overview\n\n${spaceData.mainContent.substring(0, 5000)}\n\n`;
  }
  
  if (spaceData.posts && spaceData.posts.length > 0) {
    md += `## Posts & Lessons (${spaceData.posts.length})\n\n`;
    for (const post of spaceData.posts) {
      md += `### ${post.title || 'Untitled'}\n`;
      md += `**URL:** ${post.url}\n\n`;
      if (post.error) {
        md += `> Error: ${post.error}\n\n`;
      } else if (post.content) {
        md += `${post.content.substring(0, 5000)}\n\n`;
      }
      md += `---\n\n`;
    }
  }
  
  return md;
}

async function main() {
  const progress = loadProgress();
  console.log(`Progress: ${progress.completed.length}/${SPACES.length} completed`);
  
  // Launch browser (visible to avoid Cloudflare)
  const browser = await chromium.launch({
    headless: false,
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage'
    ]
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 }
  });

  // Load cookies
  try {
    const cookies = JSON.parse(fs.readFileSync(COOKIES_FILE, 'utf8'));
    await context.addCookies(cookies);
    console.log(`Loaded ${cookies.length} cookies`);
  } catch(e) {
    console.log(`Warning: Could not load cookies: ${e.message}`);
  }

  const page = await context.newPage();
  
  // First, navigate to the community to establish session
  console.log('Establishing session...');
  await page.goto('https://community.vendingpreneurs.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(5000);
  await waitForCloudflare(page);
  
  const homeTitle = await page.title();
  console.log(`Home page title: ${homeTitle}`);
  
  const allSpaceData = [];
  
  for (const space of SPACES) {
    // Skip already completed
    if (progress.completed.includes(space.id)) {
      console.log(`Skipping ${space.name} (already done)`);
      // Load existing data
      const existingFile = path.join(OUTPUT_DIR, `${space.name}.json`);
      if (fs.existsSync(existingFile)) {
        allSpaceData.push(JSON.parse(fs.readFileSync(existingFile, 'utf8')));
      }
      continue;
    }
    
    try {
      console.log(`Starting scrape of ${space.name}...`);
      const spaceData = await Promise.race([
        scrapeSpace(page, space).catch(e => {
          console.log(`  scrapeSpace threw: ${e.message}`);
          return { spaceId: space.id, spaceName: space.name, spaceLabel: space.label, category: space.category, error: e.message, posts: [], mainContent: '' };
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('space timeout 5min')), 300000))
      ]).catch(e => {
        console.log(`  Space race rejected: ${e.message}`);
        return { spaceId: space.id, spaceName: space.name, spaceLabel: space.label, category: space.category, error: e.message, posts: [], mainContent: '' };
      });
      
      // Save JSON
      const jsonPath = path.join(OUTPUT_DIR, `${space.name}.json`);
      fs.writeFileSync(jsonPath, JSON.stringify(spaceData, null, 2));
      console.log(`  Saved JSON: ${jsonPath}`);
      
      // Save Markdown
      const mdPath = path.join(OUTPUT_DIR, `${space.name}.md`);
      fs.writeFileSync(mdPath, spaceToMarkdown(spaceData));
      console.log(`  Saved MD: ${mdPath}`);
      
      allSpaceData.push(spaceData);
      progress.completed.push(space.id);
      saveProgress(progress);
      
    } catch(e) {
      console.log(`ERROR on space ${space.name}: ${e.message}`);
      progress.failed.push({ id: space.id, error: e.message });
      saveProgress(progress);
    }
    
    // Brief pause between spaces
    await page.waitForTimeout(2000);
  }
  
  await browser.close();
  
  // Compile master document
  console.log('\n\nCompiling master document...');
  compileMasterDoc(allSpaceData);
  
  console.log('\n✅ SCRAPE COMPLETE!');
  console.log(`Completed: ${progress.completed.length}/${SPACES.length} spaces`);
  console.log(`Failed: ${progress.failed.length} spaces`);
}

function compileMasterDoc(allSpaceData) {
  let doc = `# Vendingpreneurs Course & Community — Complete Content\n`;
  doc += `*Compiled from Mighty Networks community*\n`;
  doc += `*Last updated: ${new Date().toISOString()}*\n\n`;
  doc += `---\n\n`;
  doc += `## Table of Contents\n\n`;
  
  const categories = [...new Set(allSpaceData.map(s => s.category))];
  for (const cat of categories) {
    doc += `### ${cat}\n`;
    allSpaceData.filter(s => s.category === cat).forEach(s => {
      doc += `- [${s.spaceLabel}](#${s.spaceName})\n`;
    });
    doc += '\n';
  }
  
  doc += `---\n\n`;
  
  // Group by category
  for (const cat of categories) {
    doc += `# ${cat}\n\n`;
    const catSpaces = allSpaceData.filter(s => s.category === cat);
    
    for (const space of catSpaces) {
      doc += `## ${space.spaceLabel} {#${space.spaceName}}\n\n`;
      
      if (space.error) {
        doc += `> ⚠️ Could not scrape: ${space.error}\n\n`;
        continue;
      }
      
      // Extract key content from mainContent
      if (space.mainContent) {
        // Clean up and truncate
        const cleaned = space.mainContent
          .replace(/\n{3,}/g, '\n\n')
          .trim()
          .substring(0, 8000);
        doc += `### Space Overview\n\n${cleaned}\n\n`;
      }
      
      // Add posts
      if (space.posts && space.posts.length > 0) {
        const validPosts = space.posts.filter(p => p.content && p.content.length > 100);
        if (validPosts.length > 0) {
          doc += `### Content (${validPosts.length} posts/lessons)\n\n`;
          for (const post of validPosts) {
            if (post.title) doc += `#### ${post.title}\n\n`;
            if (post.content) {
              doc += post.content.substring(0, 3000).replace(/\n{3,}/g, '\n\n') + '\n\n';
            }
            doc += `---\n\n`;
          }
        }
      }
      
      doc += `\n\n`;
    }
  }
  
  // Add actionable takeaways section
  doc += `---\n\n`;
  doc += `# Actionable Takeaways for Kande VendTech\n\n`;
  doc += `*Auto-extracted from course content — review and refine*\n\n`;
  doc += `## Course Module Key Points\n\n`;
  doc += `Review Module 1-7 content above for foundational training.\n\n`;
  doc += `## Operations Best Practices\n\n`;
  doc += `Review Operations spaces above for hands-on guidance.\n\n`;
  doc += `## Resources & Templates\n\n`;
  doc += `See Resources section above for glossary, decision guides, and templates.\n\n`;
  
  fs.writeFileSync(COMPILED_FILE, doc);
  console.log(`Compiled master doc: ${COMPILED_FILE}`);
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
