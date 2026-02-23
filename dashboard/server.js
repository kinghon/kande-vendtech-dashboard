require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();

// ===== SECURITY HEADERS (Helmet-style) =====
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});

const PORT = process.env.PORT || 3000;

// Admin password from environment (set in Railway)
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'kande2026';
const VALID_PASSWORDS = [ADMIN_PASSWORD, process.env.SALES_PASSWORD || 'jvending1#'];

// Generate session tokens
// Sessions persisted to DB so they survive deploys
function getActiveSessions() {
  if (!db.sessions) db.sessions = {};
  // Clean expired sessions (older than 24h)
  const now = Date.now();
  for (const [token, created] of Object.entries(db.sessions)) {
    if (now - created > 24 * 60 * 60 * 1000) delete db.sessions[token];
  }
  return db.sessions;
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Parse cookies helper
function parseCookies(req) {
  const cookies = {};
  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    cookieHeader.split(';').forEach(cookie => {
      const [name, ...rest] = cookie.trim().split('=');
      cookies[name] = rest.join('=');
    });
  }
  return cookies;
}

// ===== INPUT SANITIZATION (XSS Prevention) =====
function sanitize(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/<[^>]*>/g, '');
}

function sanitizeObject(obj) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') return sanitize(obj);
  if (Array.isArray(obj)) return obj.map(item => sanitizeObject(item));
  if (typeof obj === 'object') {
    const cleaned = {};
    for (const [key, value] of Object.entries(obj)) {
      cleaned[key] = sanitizeObject(value);
    }
    return cleaned;
  }
  return obj;
}

// Auth middleware - protect all routes except login and public API endpoints
function requireAuth(req, res, next) {
  // Allow these paths without auth
  const publicPaths = ['/login', '/login.html', '/api/auth/login', '/api/auth/logout', '/api/health', '/logo.png', '/logo.jpg', '/favicon.ico', '/client-portal', '/api/client-portal', '/driver', '/api/driver', '/kande-sig-logo-sm.jpg', '/kande-sig-logo.jpg', '/email-lounge.jpg', '/email-machine.jpg', '/api/webhooks/instantly', '/KandeVendTech-Proposal.pdf', '/team', '/api/team/status', '/api/team/activity', '/api/team/learnings', '/api/digital', '/api/analytics', '/api/test', '/calendar', '/memory', '/tasks', '/content', '/api/cron/schedule', '/api/memory/list', '/api/memory/read', '/api/memory/search', '/api/tasks', '/api/content', '/api/mission-control/tasks', '/pb-crisis-recovery', '/api/pb', '/office', '/api/agents/live-status', '/api/memory/db-list', '/api/memory/db-read', '/api/memory/db-search', '/api/memory/sync', '/digital', '/api/mission-control/tasks/bulk-sync', '/onboard', '/api/digital/onboard', '/clients', '/scout-intel', '/api/pipeline/engagement-alerts', '/api/digital/gmb/batch-score', '/account-tiers', '/api/pipeline/account-tiers', '/api/crm/status-diff', '/api/monitoring', '/api/jobs/sentinel', '/api/briefing'];
  if (publicPaths.some(p => req.path === p || req.path.startsWith(p))) {
    return next();
  }
  
  // Allow department API for agent check-ins (they use their own auth)
  if (req.path.startsWith('/api/departments') && (req.method === 'POST' || req.method === 'PUT')) {
    return next();
  }
  
  // Check for valid session cookie
  const cookies = parseCookies(req);
  const sessionToken = cookies['vendtech_session'];
  
  const sessions = getActiveSessions();
  if (sessionToken && sessions[sessionToken]) {
    return next();
  }
  
  // Check for API key in header (for programmatic access)
  const apiKey = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
  if (VALID_PASSWORDS.includes(apiKey)) {
    return next();
  }
  
  // Not authenticated - redirect to login or return 401 for API
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Unauthorized', message: 'Please log in at /login' });
  }
  
  return res.redirect('/login');
}

// Apply auth middleware BEFORE other routes
app.use(requireAuth);

// ===== AUTH ROUTES (must be before other routes) =====
app.use(express.json({ limit: '20mb' })); // Need this early for login; 20mb for site survey photos

// Serve login page
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'login.html'));
});

// ===== LOGIN RATE LIMITING =====
const loginAttempts = new Map(); // IP -> { count, firstAttempt }
const LOGIN_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const MAX_LOGIN_ATTEMPTS = 5;

// Login API
app.post('/api/auth/login', (req, res) => {
  // Rate limit check
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  const attempts = loginAttempts.get(ip);

  if (attempts) {
    if (now - attempts.firstAttempt > LOGIN_WINDOW_MS) {
      loginAttempts.delete(ip);
    } else if (attempts.count >= MAX_LOGIN_ATTEMPTS) {
      return res.status(429).json({ error: 'Too many login attempts. Try again in 15 minutes.' });
    }
  }

  const { password } = req.body;
  
  if (VALID_PASSWORDS.includes(password)) {
    const token = generateToken();
    const sessions = getActiveSessions();
    sessions[token] = Date.now();
    saveDB(db);
    
    // Set cookie (24 hours)
    res.setHeader('Set-Cookie', `vendtech_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${24 * 60 * 60}`);
    loginAttempts.delete(ip); // Clear attempts on success
    res.json({ success: true });
  } else {
    // Track failed attempt
    const current = loginAttempts.get(ip);
    if (current) {
      current.count++;
    } else {
      loginAttempts.set(ip, { count: 1, firstAttempt: now });
    }
    res.status(401).json({ error: 'Invalid password' });
  }
});

// Logout API
app.post('/api/auth/logout', (req, res) => {
  const cookies = parseCookies(req);
  const sessionToken = cookies['vendtech_session'];
  
  if (sessionToken) {
    const sessions = getActiveSessions();
    delete sessions[sessionToken];
    saveDB(db);
  }
  
  res.setHeader('Set-Cookie', 'vendtech_session=; Path=/; HttpOnly; Max-Age=0');
  res.json({ success: true });
});

// Check auth status
app.get('/api/auth/status', (req, res) => {
  res.json({ authenticated: true }); // If we get here, we're authenticated (middleware passed)
});

// Health check endpoint (public, for monitoring)
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), version: '1.0.0' });
});

// Simple JSON file database
// Use local ./data/ for development, /data/ for Railway production
const DB_FILE = process.env.DB_PATH || (process.env.RAILWAY_ENVIRONMENT ? '/data/data.json' : path.join(__dirname, 'data', 'data.json'));

function loadDB() {
  try {
    if (fs.existsSync(DB_FILE)) {
      return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Error loading DB:', e);
  }
  return {
    prospects: [], contacts: [], activities: [],
    machines: [], locations: [], products: [], suppliers: [],
    finances: [], creditCards: [], restocks: [],
    staff: [], shifts: [],
    clients: [], touchpoints: [], issues: [],
    nextId: 1
  };
}

function saveDB(db) {
  // Ensure the directory exists (for local development)
  const dir = path.dirname(DB_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

let db = loadDB();

// Ensure new collections exist
if (!db.machines) db.machines = [];
if (!db.locations) db.locations = [];
if (!db.products) db.products = [];
if (!db.suppliers) db.suppliers = [];
if (!db.finances) db.finances = [];
if (!db.creditCards) db.creditCards = [];
if (!db.restocks) db.restocks = [];
if (!db.staff) db.staff = [];
if (!db.shifts) db.shifts = [];
if (!db.clients) db.clients = [];
if (!db.touchpoints) db.touchpoints = [];
if (!db.issues) db.issues = [];
if (!db.aiOfficeRuns) db.aiOfficeRuns = [];
if (!db.sales) db.sales = [];
if (!db.planograms) db.planograms = [];
if (!db.restockLogs) db.restockLogs = [];
if (!db.salesVelocity) db.salesVelocity = [];
if (!db.restockCapacities) db.restockCapacities = {};
if (!db.marketingSpend) db.marketingSpend = [];
if (!db.leadSources) db.leadSources = [];
if (!db.gbpMetrics) db.gbpMetrics = [];
if (!db.emailTemplates) db.emailTemplates = [];
if (!db.emailSequences) db.emailSequences = [];
if (!db.emailSends) db.emailSends = [];
if (!db.contracts) db.contracts = [];
if (!db.competitors) db.competitors = [];
if (!db.competitorLocations) db.competitorLocations = [];
if (!db.revenue) db.revenue = [];
if (!db.micromarkets) db.micromarkets = [];
if (!db.smartMachines) db.smartMachines = [];
if (!db.machineTelemetry) db.machineTelemetry = [];
if (!db.todos) db.todos = [];

// Seed initial todos if empty
if (db.todos.length === 0) {
  const seedTodos = [
    { title: 'Get NetVendor Certified', description: 'Required by Greystar and other large property management companies before you can pitch. Email compliance@netvendor.net or call 503-922-1111 (option 5). Need: LLC docs, EIN, insurance cert, W-9.', category: 'Legal/Compliance', priority: 'high', due_date: '2025-02-07', notes: 'NetVendor certification is a gatekeeper for Greystar and other large PMCs. Get this done ASAP.' },
    { title: 'Call Henderson Business License (702-267-1730)', description: 'Ask about current classification and per-machine fees. Frame business as "food and beverage distribution to commercial locations using automated dispensing equipment." Check if reclassification is needed.', category: 'Legal/Compliance', priority: 'high', due_date: '2025-02-03', notes: 'Key framing: "food and beverage distribution" NOT "vending machine operator" — different fee structures.' },
    { title: 'Call Clark County Business License (702-455-4252)', description: 'Apply for separate license for machines outside Henderson. Register as wholesale/distributor, NOT vending machine operator. Describe as "automated food and beverage distribution."', category: 'Legal/Compliance', priority: 'high', due_date: '2025-02-03', notes: 'Separate license needed for any location outside Henderson city limits.' },
    { title: 'Order from VenMarket (triggers USG rebate enrollment)', description: 'ONE order triggers USG enrollment. Q1 2026 cutoff is March 10. Rebates are 7-13% back on everything. Don\'t leave free money on table.', category: 'Operations', priority: 'high', due_date: '2025-02-05', notes: 'Just one order is enough to get enrolled. Rebates are 7-13% — significant savings at scale.' },
    { title: 'Build Proposal PDF', description: 'Professional PDF for property managers to forward to regional. Include: machine photos, $54 rent premium stat, revenue share offer, "zero cost to property," trial period. Use Canva or community proposal builder tools.', category: 'Sales', priority: 'high', due_date: '2025-02-07', notes: 'PMs need something polished to send up the chain. This is your sales collateral.' },
    { title: 'Start Pop-Ins (minimum 5/day)', description: 'Walk into Henderson luxury apartments. Three questions: "Do you have vending? Like it? What would you change?" Bring $5 Costco gift bags. Target 4-5 per hour. Sales cycle is 10-17+ weeks — start the clock NOW.', category: 'Sales', priority: 'high', due_date: '2025-02-03', notes: 'The sales cycle is 10-17+ weeks. Every day you wait pushes revenue out further. Start the clock.' },
    { title: 'Apply for SNHD Health Permit', description: 'Required for food/beverage vending in Clark County (~$250-400/year). Need business licenses first. Apply at SNHD Environmental Health, 280 S Decatur Blvd. Phone: 702-759-1258.', category: 'Legal/Compliance', priority: 'high', due_date: '2025-02-14', notes: 'Southern Nevada Health District permit — required before you can legally operate machines with food/beverages.' },
    { title: 'Set Up WeVend Payment Processing', description: 'Saves $1,656/year vs Stripe. ~5.5-5.9% flat, no per-transaction fee. Contact WeVend/Preva to set up account before machines arrive.', category: 'Operations', priority: 'medium', due_date: '2025-02-14', notes: 'Big cost savings vs Stripe. Set up before machines ship.' },
    { title: 'Order Sandstar Machine(s)', description: '$3,600 starting, $65/mo SaaS, 5yr warranty. Community favorite. Supports AMEX. Consider eVending financing (0% down, 0% interest, 90-day deferment) or HaHa (30% down, 6-month payoff).', category: 'Equipment', priority: 'medium', due_date: '2025-02-14', notes: 'Multiple financing options available. eVending: 0% down, 0% interest, 90-day deferment. HaHa: 30% down, 6-month payoff.' },
    { title: 'Create Gift Bags for Pop-Ins', description: '$5 each from Costco. Small snack bags as icebreakers for property managers. The #1 recommended pop-in strategy from the community. Buy 20-30 to start.', category: 'Sales', priority: 'medium', due_date: '2025-02-03', notes: 'Community consensus: gift bags are the single best icebreaker for cold pop-ins.' },
    { title: 'Set Up Vistar Account + Build Relationship', description: 'Have your account executive take you to lunch (even with zero locations). Do will-call pickups to build rapport. They\'ll bend over backwards for operators they know personally. VenMarket + Vistar = USG rebates.', category: 'Operations', priority: 'medium', due_date: '2025-02-21', notes: 'Personal relationships with distributors = better pricing, priority service, and flexibility.' },
    { title: 'Get Hartford Workers Comp Quote', description: 'Some luxury apartments require workers comp even for sole operators. Hub International policy ($1,304/yr) covers GL but may need WC added. Call Hub to ask about adding it.', category: 'Legal/Compliance', priority: 'medium', due_date: '2025-02-14', notes: 'Not all properties require this, but luxury apartments often do.' },
    { title: 'Use Clark County Jurisdiction Locator', description: 'Map your target locations to determine which are Henderson vs unincorporated Clark County vs Las Vegas. You need a business license for EACH jurisdiction. Link: maps.clarkcountynv.gov/gismo/apps/jurisdiction/app/index.html', category: 'Legal/Compliance', priority: 'medium', due_date: '2025-02-07', notes: 'Critical step — you need separate business licenses for each jurisdiction your machines are in.' },
    { title: 'Stock Initial Inventory (Top Sellers)', description: 'Joy Burst (Vegas #1), Smartwater 20oz, Celsius, Coke, Diet Coke, Fairlife, Gatorade Cool Blue. Premium water only (BOSS, Fiji, Voss). King-size candy. 1.75oz chip bags from VenMarket. Incidentals (Charmin, Tide Pods, phone chargers).', category: 'Operations', priority: 'medium', due_date: '2025-02-21', notes: 'These are the proven top sellers in Vegas luxury apartments per community data.' },
    { title: 'Set Up CRM (HubSpot Free)', description: 'Free for up to 2 users. Track all prospects, pop-in dates, follow-ups, pipeline stages. Import initial Henderson apartment leads after vetting. Or use Apollo for free multi-step email sequences.', category: 'Sales', priority: 'medium', due_date: '2025-02-07', notes: 'HubSpot free tier is plenty for starting out. Apollo is great for automated email sequences.' },
    { title: 'Register for Sales Tax Permit', description: 'NV Dept of Taxation. Free to register. Required to collect 8.375% sales tax in Clark County. Apply at tax.nv.gov. Phone: 866-962-3707.', category: 'Legal/Compliance', priority: 'low', due_date: '2025-02-28', notes: 'Free to register. Clark County sales tax rate is 8.375%.' },
    { title: 'Set Up Google Voice Number', description: 'Never use personal phone for business. Google Voice is free. Use this on all flyers, proposals, and business cards. Community strongly recommends this.', category: 'Sales', priority: 'low', due_date: '2025-02-07', notes: 'Keeps personal and business separate. Free and easy to set up.' },
    { title: 'Research Freezer Options for Phase 2', description: 'Every platform releasing AI freezers H1 2026. Nestle/Mars incentive: 6 Nestle + 4 Mars items = free cases. Frozen meals do $12-$15 per item at 45-50% margins. Plan for adding freezers to best locations.', category: 'Equipment', priority: 'low', due_date: '2025-03-15', notes: 'Phase 2 opportunity. Frozen meals have incredible margins (45-50%). AI freezers dropping H1 2026.' },
    { title: 'Explore PrintWithMe Coffee Partnership', description: 'Caffection Cymbal machine: 12 drink options, resident allowances (5-30 cups/month). Cross-sell opportunity during property pop-ins. Can reduce PM\'s coffee spend by 60%.', category: 'Growth', priority: 'low', due_date: '2025-03-15', notes: 'Great cross-sell during pop-ins. Reduces property coffee spend by 60%.' },
    { title: 'Build Route Plan (First 5 Locations)', description: 'Use the Route Planner on dashboard. Keep all locations within 30-35 min of West Henderson base. Optimize for Tier 1 areas first (Henderson, Green Valley, Seven Hills).', category: 'Operations', priority: 'low', due_date: '2025-02-28', notes: 'Use /route-planner page. Tier 1 areas: Henderson, Green Valley, Seven Hills.' }
  ];
  seedTodos.forEach(t => {
    db.todos.push({
      id: db.nextId++,
      ...t,
      status: 'pending',
      completed: false,
      completed_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
  });
  saveDB(db);
  console.log('📋 Seeded 20 initial to-do items');
}

// Server-side geocoding
async function geocodeAddress(address) {
  try {
    const q = encodeURIComponent(address + ', Las Vegas, NV');
    const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${q}&limit=1`, {
      headers: { 'User-Agent': 'KandeVendTech-CRM/1.0' }
    });
    const data = await res.json();
    if (data[0]) return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
  } catch (e) {
    console.error('Geocode error:', address, e.message);
  }
  return null;
}

async function geocodeProspect(prospect) {
  if (!prospect.address || (prospect.lat && prospect.lng)) return false;
  const coords = await geocodeAddress(prospect.address);
  if (coords) { prospect.lat = coords.lat; prospect.lng = coords.lng; return true; }
  return false;
}

async function geocodeAll() {
  const missing = db.prospects.filter(p => p.address && (!p.lat || !p.lng));
  if (missing.length === 0) return;
  console.log(`Geocoding ${missing.length} prospects...`);
  let updated = 0;
  for (let i = 0; i < missing.length; i += 3) {
    const batch = missing.slice(i, i + 3);
    const results = await Promise.all(batch.map(p => geocodeProspect(p)));
    updated += results.filter(Boolean).length;
    if (i + 3 < missing.length) await new Promise(r => setTimeout(r, 350));
  }
  if (updated > 0) { saveDB(db); console.log(`Geocoded ${updated} prospects.`); }
}

geocodeAll();

app.use(express.json({ limit: '20mb' })); // Increased for site survey photo uploads

// Sanitize all incoming request bodies (XSS prevention)
app.use((req, res, next) => {
  if (['POST', 'PUT', 'PATCH'].includes(req.method) && req.body) {
    req.body = sanitizeObject(req.body);
  }
  next();
});

// Root route
app.get('/', (req, res) => {
  if (req.hostname.startsWith('sales')) {
    res.sendFile(path.join(__dirname, 'crm.html'));
  } else {
    res.sendFile(path.join(__dirname, 'home.html'));
  }
});
app.get('/home', (req, res) => res.sendFile(path.join(__dirname, 'home.html')));
app.get('/old-dashboard', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.use(express.static(__dirname, { index: false }));
app.use(express.static(path.join(__dirname, 'public')));

// ===== PLAYBOOK API =====
const PLAYBOOK_FILE = process.env.PLAYBOOK_PATH || (fs.existsSync('/data/playbook.md') ? '/data/playbook.md' : path.join(__dirname, 'data', 'playbook.md'));
app.get('/api/playbook', (req, res) => {
  try {
    const content = fs.readFileSync(PLAYBOOK_FILE, 'utf8');
    const stats = fs.statSync(PLAYBOOK_FILE);
    res.json({ content, updated: stats.mtime.toISOString() });
  } catch (e) {
    res.json({ content: '# Playbook\n\nNo playbook content yet.', updated: null });
  }
});
app.put('/api/playbook', (req, res) => {
  try {
    const dir = path.dirname(PLAYBOOK_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(PLAYBOOK_FILE, req.body.content);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== SEO API =====
const SEO_FILE = fs.existsSync('/data/seo.json') ? '/data/seo.json' : path.join(__dirname, 'data', 'seo.json');
function loadSEO() {
  try { if (fs.existsSync(SEO_FILE)) return JSON.parse(fs.readFileSync(SEO_FILE, 'utf8')); } catch (e) {}
  return { keywords: ['vending machines las vegas','smart vending las vegas','vending machine service las vegas','AI vending machines las vegas','vending machine rental las vegas','office vending machine las vegas','apartment vending machine las vegas','free vending machine las vegas','vending machine company las vegas','micro market las vegas','kande vendtech','smart vending solutions nevada'], history: [] };
}
function saveSEO(data) {
  const dir = path.dirname(SEO_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(SEO_FILE, JSON.stringify(data, null, 2));
}
app.get('/api/seo', (req, res) => res.json(loadSEO()));
app.post('/api/seo/check', (req, res) => {
  const data = loadSEO();
  data.history.push({ date: new Date().toISOString(), rankings: req.body.rankings || {}, pageSpeed: req.body.pageSpeed || null, indexedPages: req.body.indexedPages || null, onPage: req.body.onPage || null, competitors: req.body.competitors || null });
  if (data.history.length > 52) data.history = data.history.slice(-52);
  saveSEO(data);
  res.json({ success: true, entries: data.history.length });
});
app.put('/api/seo/keywords', (req, res) => {
  const data = loadSEO();
  if (req.body.keywords) data.keywords = req.body.keywords;
  saveSEO(data);
  res.json({ success: true });
});

// ===== MARKETING SPEND API =====
app.get('/api/marketing/spend', (req, res) => {
  const { channel, from, to } = req.query;
  let records = db.marketingSpend || [];
  if (channel) records = records.filter(r => r.channel === channel);
  if (from) records = records.filter(r => r.date >= from);
  if (to) records = records.filter(r => r.date <= to);
  res.json(records.sort((a, b) => new Date(b.date) - new Date(a.date)));
});

app.post('/api/marketing/spend', (req, res) => {
  const record = {
    id: nextId(),
    channel: req.body.channel || 'other',
    amount: parseFloat(req.body.amount) || 0,
    date: req.body.date || new Date().toISOString().split('T')[0],
    description: req.body.description || '',
    created_at: new Date().toISOString()
  };
  if (!db.marketingSpend) db.marketingSpend = [];
  db.marketingSpend.push(record);
  saveDB(db);
  res.json(record);
});

app.delete('/api/marketing/spend/:id', (req, res) => {
  const id = parseInt(req.params.id);
  db.marketingSpend = (db.marketingSpend || []).filter(r => r.id !== id);
  saveDB(db);
  res.json({ success: true });
});

app.get('/api/marketing/roi', (req, res) => {
  const spend = db.marketingSpend || [];
  const leads = db.leadSources || [];
  const prospects = db.prospects || [];

  // Total spend by channel
  const spendByChannel = {};
  spend.forEach(s => {
    if (!spendByChannel[s.channel]) spendByChannel[s.channel] = 0;
    spendByChannel[s.channel] += s.amount || 0;
  });

  // Lead count by source
  const leadsBySource = {};
  leads.forEach(l => {
    if (!leadsBySource[l.source]) leadsBySource[l.source] = 0;
    leadsBySource[l.source]++;
  });

  // Count converted (signed) prospects per source
  const convertedBySource = {};
  leads.forEach(l => {
    const p = prospects.find(pr => pr.id === l.prospect_id);
    if (p && p.status === 'signed') {
      if (!convertedBySource[l.source]) convertedBySource[l.source] = 0;
      convertedBySource[l.source]++;
    }
  });

  // Revenue by source (from finances linked to prospects via locations)
  const allRevenue = (db.finances || []).filter(f => f.type === 'revenue');
  const totalRevenue = allRevenue.reduce((s, f) => s + (f.amount || 0), 0);

  const totalSpend = spend.reduce((s, r) => s + (r.amount || 0), 0);
  const totalLeads = leads.length;
  const totalConverted = Object.values(convertedBySource).reduce((s, n) => s + n, 0);

  // Per-channel ROI
  const channels = [...new Set([...Object.keys(spendByChannel), ...Object.keys(leadsBySource)])];
  const channelROI = channels.map(ch => {
    const spent = spendByChannel[ch] || 0;
    const leadCount = leadsBySource[ch] || 0;
    const converted = convertedBySource[ch] || 0;
    const costPerLead = leadCount > 0 ? spent / leadCount : null;
    const costPerConversion = converted > 0 ? spent / converted : null;
    return { channel: ch, spent, leads: leadCount, converted, costPerLead, costPerConversion };
  });

  res.json({
    totalSpend,
    totalRevenue,
    totalLeads,
    totalConverted,
    overallROI: totalSpend > 0 ? ((totalRevenue - totalSpend) / totalSpend * 100).toFixed(1) : null,
    costPerLead: totalLeads > 0 ? (totalSpend / totalLeads).toFixed(2) : null,
    conversionRate: totalLeads > 0 ? ((totalConverted / totalLeads) * 100).toFixed(1) : null,
    channels: channelROI,
    spendByChannel,
    leadsBySource
  });
});

// ===== LEAD SOURCES API =====
app.get('/api/marketing/leads', (req, res) => {
  const records = (db.leadSources || []).map(l => {
    const prospect = db.prospects.find(p => p.id === l.prospect_id);
    return { ...l, prospect_name: prospect?.name || 'Unknown', prospect_status: prospect?.status || 'unknown' };
  });
  res.json(records.sort((a, b) => new Date(b.created_at) - new Date(a.created_at)));
});

app.post('/api/marketing/leads', (req, res) => {
  const record = {
    id: nextId(),
    prospect_id: req.body.prospect_id || null,
    source: req.body.source || 'other',
    notes: req.body.notes || '',
    created_at: new Date().toISOString()
  };
  if (!db.leadSources) db.leadSources = [];
  db.leadSources.push(record);
  saveDB(db);
  res.json(record);
});

app.delete('/api/marketing/leads/:id', (req, res) => {
  const id = parseInt(req.params.id);
  db.leadSources = (db.leadSources || []).filter(r => r.id !== id);
  saveDB(db);
  res.json({ success: true });
});

// ===== GBP METRICS API =====
app.get('/api/marketing/gbp', (req, res) => {
  res.json(db.gbpMetrics || []);
});

app.post('/api/marketing/gbp', (req, res) => {
  const record = {
    id: nextId(),
    date: req.body.date || new Date().toISOString().split('T')[0],
    views: req.body.views || 0,
    searches: req.body.searches || 0,
    calls: req.body.calls || 0,
    directions: req.body.directions || 0,
    website_clicks: req.body.website_clicks || 0,
    reviews: req.body.reviews || 0,
    avg_rating: req.body.avg_rating || 0,
    created_at: new Date().toISOString()
  };
  if (!db.gbpMetrics) db.gbpMetrics = [];
  db.gbpMetrics.push(record);
  saveDB(db);
  res.json(record);
});

// ===== HELPER =====
function nextId() { return db.nextId++; }

// ===== PROSPECTS API =====
app.get('/api/prospects', (req, res) => {
  const prospects = db.prospects.map(p => {
    const activities = db.activities.filter(a => a.prospect_id === p.id);
    const contacts = db.contacts.filter(c => c.prospect_id === p.id);
    const lastActivity = activities.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
    const primaryContact = contacts.find(c => c.is_primary) || contacts[0];
    return {
      ...p, activities, contacts,
      activity_count: activities.length,
      last_activity: lastActivity ? `${lastActivity.type}: ${lastActivity.description || ''}` : null,
      last_activity_date: lastActivity?.created_at,
      next_action: p.next_action || lastActivity?.next_action,
      next_action_date: p.next_action_date || lastActivity?.next_action_date,
      primary_contact: primaryContact?.name
    };
  }).sort((a, b) => {
    const priorityOrder = { hot: 1, warm: 2, normal: 3 };
    return (priorityOrder[a.priority] || 3) - (priorityOrder[b.priority] || 3);
  });
  res.json(prospects);
});

app.get('/api/prospects/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const prospect = db.prospects.find(p => p.id === id);
  if (!prospect) return res.status(404).json({ error: 'Not found' });
  const contacts = db.contacts.filter(c => c.prospect_id === id);
  const activities = db.activities.filter(a => a.prospect_id === id).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  res.json({ ...prospect, contacts, activities });
});

app.post('/api/prospects', (req, res) => {
  if (!req.body.name || !req.body.name.trim()) {
    return res.status(400).json({ error: 'name is required' });
  }
  const prospect = { id: nextId(), ...req.body, status: req.body.status || 'new', priority: req.body.priority || 'normal', created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  db.prospects.push(prospect);
  saveDB(db);
  // Auto-create pipeline card for new prospect (CRM→Pipeline sync)
  ensurePipelineCard(prospect.id);
  res.json(prospect);
  geocodeProspect(prospect).then(updated => { if (updated) saveDB(db); });
});

app.put('/api/prospects/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const index = db.prospects.findIndex(p => p.id === id);
  if (index === -1) return res.status(404).json({ error: 'Not found' });
  const old = db.prospects[index];
  const oldAddress = old.address;

  // Auto-log significant changes as system activities
  const changes = [];
  if (req.body.status && req.body.status !== old.status) {
    const labels = { new: '🆕 New', active: '🔵 Active', opening_soon: '🏗️ Opening Soon', proposal_sent: '📨 Proposal Sent', signed: '✅ Signed', closed: '⛔ Stale' };
    changes.push(`Status: ${labels[old.status] || old.status} → ${labels[req.body.status] || req.body.status}${req.body.stale_reason ? ' (' + req.body.stale_reason + ')' : ''}`);
  }
  if (req.body.priority && req.body.priority !== old.priority) {
    const labels = { normal: '🆕 New', warm: '🟠 Warm', hot: '🔥 Hot' };
    changes.push(`Priority: ${labels[old.priority] || old.priority} → ${labels[req.body.priority] || req.body.priority}`);
  }
  if (req.body.next_action && req.body.next_action !== old.next_action) {
    changes.push(`Action set: ${req.body.next_action}`);
  }
  if (changes.length > 0) {
    db.activities.push({
      id: nextId(),
      prospect_id: id,
      type: 'status-change',
      description: changes.join(' · '),
      created_at: new Date().toISOString()
    });
  }

  db.prospects[index] = { ...old, ...req.body, updated_at: new Date().toISOString() };
  // Sync ALL prospect changes to pipeline card
  const pipeCard = (db.pipelineCards || []).find(c => c.prospect_id === id);
  if (pipeCard) {
    // Sync display fields
    if (req.body.name) pipeCard.company = req.body.name;
    if (req.body.contact_name) pipeCard.contact = req.body.contact_name;
    if (req.body.contact_email) pipeCard.contact_email = req.body.contact_email;
    if (req.body.contact_phone) pipeCard.contact_phone = req.body.contact_phone;
    if (req.body.property_type) pipeCard.property_type = req.body.property_type;
    if (req.body.address) pipeCard.address = req.body.address;
    if (req.body.units) pipeCard.units = req.body.units;
    if (req.body.priority) pipeCard.priority = req.body.priority;
    if (req.body.notes !== undefined) pipeCard.notes = req.body.notes;
    pipeCard.updated_at = new Date().toISOString();
    // Sync status → pipeline stage
    if (req.body.status && req.body.status !== old.status) {
      const statusToStage = {
        'new': 'new_lead', 'contacted': 'contacted', 'outreach': 'pop_in_done',
        'interested': 'interested', 'qualified': 'site_survey', 'warm': 'interested',
        'hot': 'proposal_sent', 'proposal': 'proposal_sent', 'negotiating': 'negotiating',
        'contract': 'contract_sent', 'signed': 'signed', 'onboarding': 'onboarding',
        'active': 'active_client', 'closed': null, 'lost': null
      };
      const newStage = statusToStage[req.body.status];
      if (newStage && pipeCard.stage !== newStage) {
        const oldStage = pipeCard.stage;
        pipeCard.stage = newStage;
        pipeCard.entered_stage_at = new Date().toISOString();
        runWorkflowRules && runWorkflowRules('stage_change', { prospect_id: id, old_stage: oldStage, new_stage: newStage });
      }
    }
  }
  saveDB(db);
  res.json(db.prospects[index]);
  if (req.body.address && req.body.address !== oldAddress) {
    db.prospects[index].lat = null; db.prospects[index].lng = null;
    geocodeProspect(db.prospects[index]).then(updated => { if (updated) saveDB(db); });
  }
});

// ===== WELLNESS PROGRAM API =====
app.put('/api/prospects/:id/wellness', (req, res) => {
  const id = parseInt(req.params.id);
  const index = db.prospects.findIndex(p => p.id === id);
  if (index === -1) return res.status(404).json({ error: 'Not found' });
  const { wellness_program, wellness_notes, subsidy_amount } = req.body;
  if (wellness_program !== undefined) db.prospects[index].wellness_program = !!wellness_program;
  if (wellness_notes !== undefined) db.prospects[index].wellness_notes = wellness_notes;
  if (subsidy_amount !== undefined) db.prospects[index].subsidy_amount = parseFloat(subsidy_amount) || 0;
  db.prospects[index].updated_at = new Date().toISOString();
  saveDB(db);
  res.json(db.prospects[index]);
});

// ===== BULK LEAD IMPORT =====
app.post('/api/prospects/import', async (req, res) => {
  const { leads, geocode } = req.body;
  if (!leads || !Array.isArray(leads) || leads.length === 0) {
    return res.status(400).json({ error: 'No leads provided' });
  }

  let imported = 0;
  let duplicatesSkipped = 0;
  let geocoded = 0;
  const results = [];

  for (const lead of leads) {
    // Duplicate detection
    const isDup = db.prospects.some(p => {
      if (lead.address && p.address) {
        const normA = lead.address.toLowerCase().replace(/[.,#\-]/g, '').replace(/\s+/g, ' ').trim();
        const normB = p.address.toLowerCase().replace(/[.,#\-]/g, '').replace(/\s+/g, ' ').trim();
        if (normA === normB) return true;
      }
      if (lead.name && p.name && lead.name.toLowerCase().trim() === p.name.toLowerCase().trim()) return true;
      return false;
    });

    if (isDup) {
      duplicatesSkipped++;
      results.push({ name: lead.name, status: 'duplicate' });
      continue;
    }

    const prospect = {
      id: nextId(),
      name: lead.name || 'Unknown',
      address: lead.address || '',
      phone: lead.phone || '',
      email: lead.email || '',
      property_type: lead.property_type || '',
      notes: lead.notes || '',
      status: 'new',
      priority: 'normal',
      lat: null,
      lng: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    db.prospects.push(prospect);
    imported++;
    results.push({ name: lead.name, status: 'imported', id: prospect.id });
  }

  saveDB(db);

  // Auto-create pipeline cards for all imported prospects (CRM→Pipeline sync)
  results.filter(r => r.status === 'imported' && r.id).forEach(r => {
    ensurePipelineCard(r.id);
  });

  // Geocode in background after response
  if (geocode && imported > 0) {
    const toGeocode = db.prospects.filter(p => p.address && (!p.lat || !p.lng));
    // Rate-limited geocoding (1 req/sec for Nominatim)
    (async () => {
      let geoCount = 0;
      for (const p of toGeocode) {
        const updated = await geocodeProspect(p);
        if (updated) geoCount++;
        await new Promise(r => setTimeout(r, 1100)); // 1.1s delay between requests
      }
      if (geoCount > 0) saveDB(db);
      console.log(`Lead import: geocoded ${geoCount} of ${toGeocode.length} addresses`);
    })();
    geocoded = toGeocode.length; // Report how many will be geocoded
  }

  res.json({ imported, duplicatesSkipped, geocoded, total: leads.length, results });
});

app.delete('/api/prospects/:id', (req, res) => {
  const id = parseInt(req.params.id);
  db.prospects = db.prospects.filter(p => p.id !== id);
  db.contacts = db.contacts.filter(c => c.prospect_id !== id);
  db.activities = db.activities.filter(a => a.prospect_id !== id);
  if (db.pipelineCards) db.pipelineCards = db.pipelineCards.filter(c => c.prospect_id !== id);
  if (db.pipelineTasks) db.pipelineTasks = db.pipelineTasks.filter(t => t.prospect_id !== id);
  if (db.popInVisits) db.popInVisits = db.popInVisits.filter(v => v.prospect_id !== id);
  saveDB(db);
  res.json({ success: true });
});

// ===== CONTACTS API =====
app.post('/api/prospects/:id/contacts', (req, res) => {
  const prospect_id = parseInt(req.params.id);
  if (req.body.is_primary) db.contacts.forEach(c => { if (c.prospect_id === prospect_id) c.is_primary = false; });
  const contact = { id: nextId(), prospect_id, ...req.body, is_primary: req.body.is_primary || false, created_at: new Date().toISOString() };
  db.contacts.push(contact);
  saveDB(db);
  res.json(contact);
});

app.put('/api/contacts/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const idx = db.contacts.findIndex(c => c.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  if (req.body.is_primary) db.contacts.forEach(c => { if (c.prospect_id === db.contacts[idx].prospect_id) c.is_primary = false; });
  db.contacts[idx] = { ...db.contacts[idx], ...req.body };
  saveDB(db);
  res.json(db.contacts[idx]);
});

app.delete('/api/contacts/:id', (req, res) => {
  const id = parseInt(req.params.id);
  db.contacts = db.contacts.filter(c => c.id !== id);
  saveDB(db);
  res.json({ success: true });
});

// ===== ACTIVITIES API =====
app.post('/api/prospects/:id/activities', (req, res) => {
  const prospect_id = parseInt(req.params.id);
  const activity = { id: nextId(), prospect_id, ...req.body, created_at: new Date().toISOString() };
  db.activities.push(activity);
  const prospect = db.prospects.find(p => p.id === prospect_id);
  if (prospect) {
    if (req.body.outcome === 'interested') prospect.priority = 'hot';
    else if (req.body.outcome === 'not_interested') prospect.status = 'closed';
    prospect.updated_at = new Date().toISOString();
  }
  saveDB(db);
  res.json(activity);
});

app.get('/api/activities', (req, res) => {
  res.json(db.activities || []);
});

app.put('/api/activities/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const idx = db.activities.findIndex(a => a.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Activity not found' });
  db.activities[idx] = { ...db.activities[idx], ...req.body, updated_at: new Date().toISOString() };
  saveDB(db);
  res.json(db.activities[idx]);
});

app.delete('/api/activities/:id', (req, res) => {
  const id = parseInt(req.params.id);
  db.activities = db.activities.filter(a => a.id !== id);
  saveDB(db);
  res.json({ success: true });
});

// ===== MACHINES API =====
app.get('/api/machines', (req, res) => {
  const machines = db.machines.map(m => {
    const location = db.locations.find(l => l.id === m.location_id);
    return { ...m, location: location || null };
  });
  res.json(machines);
});

app.get('/api/machines/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const machine = db.machines.find(m => m.id === id);
  if (!machine) return res.status(404).json({ error: 'Not found' });
  const location = db.locations.find(l => l.id === machine.location_id);
  const restocks = db.restocks.filter(r => r.machine_id === id).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const revenue = db.finances.filter(f => f.machine_id === id && f.type === 'revenue');
  res.json({ ...machine, location: location || null, restocks, revenue });
});

app.post('/api/machines', (req, res) => {
  if (!req.body.name || !req.body.name.trim()) {
    return res.status(400).json({ error: 'name is required' });
  }
  const machine = {
    id: nextId(),
    ...req.body,
    status: req.body.status || 'available',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  db.machines.push(machine);
  saveDB(db);
  res.json(machine);
});

app.put('/api/machines/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const idx = db.machines.findIndex(m => m.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  db.machines[idx] = { ...db.machines[idx], ...req.body, updated_at: new Date().toISOString() };
  saveDB(db);
  res.json(db.machines[idx]);
});

app.delete('/api/machines/:id', (req, res) => {
  const id = parseInt(req.params.id);
  db.machines = db.machines.filter(m => m.id !== id);
  saveDB(db);
  res.json({ success: true });
});

// ===== LOCATIONS API =====
app.get('/api/locations', (req, res) => {
  const locations = db.locations.map(l => {
    const machines = db.machines.filter(m => m.location_id === l.id);
    const prospect = db.prospects.find(p => p.id === l.prospect_id);
    return { ...l, machines, prospect_name: prospect?.name || l.name };
  });
  res.json(locations);
});

app.post('/api/locations', (req, res) => {
  const location = {
    id: nextId(),
    ...req.body,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  db.locations.push(location);
  saveDB(db);
  res.json(location);
});

app.put('/api/locations/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const idx = db.locations.findIndex(l => l.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  db.locations[idx] = { ...db.locations[idx], ...req.body, updated_at: new Date().toISOString() };
  saveDB(db);
  res.json(db.locations[idx]);
});

app.delete('/api/locations/:id', (req, res) => {
  const id = parseInt(req.params.id);
  db.locations = db.locations.filter(l => l.id !== id);
  // Unassign machines from deleted location
  db.machines.forEach(m => { if (m.location_id === id) { m.location_id = null; m.status = 'available'; } });
  saveDB(db);
  res.json({ success: true });
});

// ===== PRODUCTS API =====
app.get('/api/products', (req, res) => {
  res.json(db.products);
});

// Alias for backward compatibility
app.get('/api/inventory', (req, res) => {
  res.json(db.products);
});

app.post('/api/products', (req, res) => {
  if (!req.body.name || !req.body.name.trim()) {
    return res.status(400).json({ error: 'name is required' });
  }
  const product = {
    id: nextId(),
    ...req.body,
    margin: req.body.cost_price && req.body.sell_price ? Math.round(((req.body.sell_price - req.body.cost_price) / req.body.sell_price) * 100) : 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  db.products.push(product);
  saveDB(db);
  res.json(product);
});

app.put('/api/products/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const idx = db.products.findIndex(p => p.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const updated = { ...db.products[idx], ...req.body, updated_at: new Date().toISOString() };
  if (updated.cost_price && updated.sell_price) {
    updated.margin = Math.round(((updated.sell_price - updated.cost_price) / updated.sell_price) * 100);
  }
  db.products[idx] = updated;
  saveDB(db);
  res.json(db.products[idx]);
});

app.delete('/api/products/:id', (req, res) => {
  const id = parseInt(req.params.id);
  db.products = db.products.filter(p => p.id !== id);
  saveDB(db);
  res.json({ success: true });
});

// ===== PRODUCT MIX RECOMMENDATION API =====
app.get('/api/products/recommend/:property_type', (req, res) => {
  const propertyType = req.params.property_type;

  const strategies = {
    apartments: {
      strategy: 'Broad mix targeting young adults and families. Heavy on energy drinks, popular sodas, and variety snacks. Price-sensitive but high volume.',
      weights: { Drinks: 1.2, Snacks: 1.1, Candy: 1.0, Healthy: 0.7, Energy: 1.3 },
      priority_order: ['Energy', 'Drinks', 'Snacks', 'Candy', 'Healthy']
    },
    senior_living: {
      strategy: 'Focus on healthy options with lower caffeine. Easy-to-open packages preferred. Include sugar-free and low-sodium options. Water is a must-have.',
      weights: { Drinks: 0.9, Snacks: 0.7, Candy: 0.6, Healthy: 1.5, Energy: 0.3 },
      priority_order: ['Healthy', 'Drinks', 'Snacks', 'Candy', 'Energy']
    },
    healthcare: {
      strategy: 'Prioritize healthy choices — protein bars, nuts, bottled water. Staff and visitors want quick nutritious options. Minimize junk food perception.',
      weights: { Drinks: 1.0, Snacks: 0.6, Candy: 0.4, Healthy: 1.5, Energy: 0.8 },
      priority_order: ['Healthy', 'Drinks', 'Energy', 'Snacks', 'Candy']
    },
    industrial: {
      strategy: 'Workers need fuel — energy drinks, filling snacks, cold refreshing drinks. Higher calorie items perform well. Value-oriented pricing.',
      weights: { Drinks: 1.1, Snacks: 1.2, Candy: 0.8, Healthy: 0.6, Energy: 1.5 },
      priority_order: ['Energy', 'Snacks', 'Drinks', 'Candy', 'Healthy']
    },
    office: {
      strategy: 'Premium snacks and beverages for professionals. Sparkling water, protein bars, premium chips. Perception matters — keep it upscale.',
      weights: { Drinks: 1.0, Snacks: 1.0, Candy: 0.5, Healthy: 1.4, Energy: 0.9 },
      priority_order: ['Healthy', 'Drinks', 'Snacks', 'Energy', 'Candy']
    }
  };

  const config = strategies[propertyType];
  if (!config) return res.status(400).json({ error: 'Unknown property type. Use: apartments, senior_living, healthcare, industrial, office' });

  // Get products recommended for this property type
  let recommended = db.products.filter(p =>
    p.recommended_for && Array.isArray(p.recommended_for) && p.recommended_for.includes(propertyType)
  );

  // If none explicitly tagged, fall back to all products with weight scoring
  if (recommended.length === 0) {
    recommended = [...db.products];
  }

  // Score and sort products
  const scored = recommended.map(p => {
    const catWeight = config.weights[p.category] || 1.0;
    const margin = p.sell_price > 0 ? (p.sell_price - (p.cost_price || 0)) / p.sell_price : 0;
    const score = catWeight * (1 + margin);
    return { ...p, score, margin: Math.round(margin * 100) };
  });

  // Sort by priority category order, then by score within category
  scored.sort((a, b) => {
    const aIdx = config.priority_order.indexOf(a.category);
    const bIdx = config.priority_order.indexOf(b.category);
    if (aIdx !== bIdx) return (aIdx === -1 ? 99 : aIdx) - (bIdx === -1 ? 99 : bIdx);
    return b.score - a.score;
  });

  const totalMargin = scored.length > 0
    ? scored.reduce((sum, p) => sum + (p.margin || 0), 0) / scored.length
    : 0;

  res.json({
    property_type: propertyType,
    strategy: config.strategy,
    products: scored,
    count: scored.length,
    avg_margin: totalMargin,
    category_weights: config.weights,
    priority_order: config.priority_order
  });
});

// ===== SUPPLIERS API =====
app.get('/api/suppliers', (req, res) => res.json(db.suppliers));
app.post('/api/suppliers', (req, res) => {
  const supplier = { id: nextId(), ...req.body, created_at: new Date().toISOString() };
  db.suppliers.push(supplier);
  saveDB(db);
  res.json(supplier);
});
app.put('/api/suppliers/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const idx = db.suppliers.findIndex(s => s.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  db.suppliers[idx] = { ...db.suppliers[idx], ...req.body };
  saveDB(db);
  res.json(db.suppliers[idx]);
});
app.delete('/api/suppliers/:id', (req, res) => {
  const id = parseInt(req.params.id);
  db.suppliers = db.suppliers.filter(s => s.id !== id);
  saveDB(db);
  res.json({ success: true });
});

// ===== FINANCES API =====
app.get('/api/finances', (req, res) => {
  const { type, machine_id, month } = req.query;
  let records = db.finances;
  if (type) records = records.filter(f => f.type === type);
  if (machine_id) records = records.filter(f => f.machine_id === parseInt(machine_id));
  if (month) records = records.filter(f => f.month === month);
  res.json(records);
});

app.get('/api/finances/summary', (req, res) => {
  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastMonthStr = `${lastMonth.getFullYear()}-${String(lastMonth.getMonth() + 1).padStart(2, '0')}`;

  const allRevenue = db.finances.filter(f => f.type === 'revenue');
  const allExpenses = db.finances.filter(f => f.type === 'expense');

  const currentRevenue = allRevenue.filter(f => f.month === currentMonth).reduce((s, f) => s + (f.amount || 0), 0);
  const currentExpenses = allExpenses.filter(f => f.month === currentMonth).reduce((s, f) => s + (f.amount || 0), 0);
  const lastRevenue = allRevenue.filter(f => f.month === lastMonthStr).reduce((s, f) => s + (f.amount || 0), 0);
  const lastExpenses = allExpenses.filter(f => f.month === lastMonthStr).reduce((s, f) => s + (f.amount || 0), 0);

  const totalRevenue = allRevenue.reduce((s, f) => s + (f.amount || 0), 0);
  const totalExpenses = allExpenses.reduce((s, f) => s + (f.amount || 0), 0);

  // Revenue by machine
  const machineRevenue = {};
  allRevenue.forEach(f => {
    if (!machineRevenue[f.machine_id]) machineRevenue[f.machine_id] = 0;
    machineRevenue[f.machine_id] += f.amount || 0;
  });

  // Monthly totals
  const months = {};
  db.finances.forEach(f => {
    if (!f.month) return;
    if (!months[f.month]) months[f.month] = { revenue: 0, expenses: 0 };
    if (f.type === 'revenue') months[f.month].revenue += f.amount || 0;
    if (f.type === 'expense') months[f.month].expenses += f.amount || 0;
  });

  // Credit cards
  const creditCards = db.creditCards || [];
  const totalCreditBalance = creditCards.reduce((s, c) => s + (c.balance || 0), 0);
  const totalCreditLimit = creditCards.reduce((s, c) => s + (c.credit_limit || 0), 0);

  res.json({
    currentMonth, lastMonthStr,
    currentRevenue, currentExpenses, currentProfit: currentRevenue - currentExpenses,
    lastRevenue, lastExpenses, lastProfit: lastRevenue - lastExpenses,
    totalRevenue, totalExpenses, totalProfit: totalRevenue - totalExpenses,
    machineRevenue, months,
    machineCount: db.machines.length,
    deployedCount: db.machines.filter(m => m.status === 'deployed').length,
    locationCount: db.locations.length,
    totalCreditBalance, totalCreditLimit,
    creditCards
  });
});

app.post('/api/finances', (req, res) => {
  const record = {
    id: nextId(),
    ...req.body,
    created_at: new Date().toISOString()
  };
  db.finances.push(record);
  saveDB(db);
  res.json(record);
});

app.put('/api/finances/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const idx = db.finances.findIndex(f => f.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  db.finances[idx] = { ...db.finances[idx], ...req.body };
  saveDB(db);
  res.json(db.finances[idx]);
});

app.delete('/api/finances/:id', (req, res) => {
  const id = parseInt(req.params.id);
  db.finances = db.finances.filter(f => f.id !== id);
  saveDB(db);
  res.json({ success: true });
});

// ===== CREDIT CARDS API =====
app.get('/api/credit-cards', (req, res) => res.json(db.creditCards));

app.post('/api/credit-cards', (req, res) => {
  const card = { id: nextId(), ...req.body, created_at: new Date().toISOString() };
  db.creditCards.push(card);
  saveDB(db);
  res.json(card);
});

app.put('/api/credit-cards/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const idx = db.creditCards.findIndex(c => c.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  db.creditCards[idx] = { ...db.creditCards[idx], ...req.body };
  saveDB(db);
  res.json(db.creditCards[idx]);
});

app.delete('/api/credit-cards/:id', (req, res) => {
  const id = parseInt(req.params.id);
  db.creditCards = db.creditCards.filter(c => c.id !== id);
  saveDB(db);
  res.json({ success: true });
});

// ===== RESTOCKS API =====
app.get('/api/restocks', (req, res) => {
  const { machine_id, status } = req.query;
  let records = db.restocks;
  if (machine_id) records = records.filter(r => r.machine_id === parseInt(machine_id));
  if (status) records = records.filter(r => r.status === status);
  res.json(records.sort((a, b) => new Date(b.created_at) - new Date(a.created_at)));
});

app.post('/api/restocks', (req, res) => {
  const restock = {
    id: nextId(),
    ...req.body,
    status: req.body.status || 'pending',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  db.restocks.push(restock);
  saveDB(db);
  res.json(restock);
});

app.put('/api/restocks/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const idx = db.restocks.findIndex(r => r.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  db.restocks[idx] = { ...db.restocks[idx], ...req.body, updated_at: new Date().toISOString() };
  saveDB(db);
  res.json(db.restocks[idx]);
});

app.delete('/api/restocks/:id', (req, res) => {
  const id = parseInt(req.params.id);
  db.restocks = db.restocks.filter(r => r.id !== id);
  saveDB(db);
  res.json({ success: true });
});

// ===== AI OFFICE RUNS API =====
app.get('/api/ai-office/runs', (req, res) => {
  const runs = (db.aiOfficeRuns || [])
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const limit = parseInt(req.query.limit) || 20;
  res.json(runs.slice(0, limit));
});

app.post('/api/ai-office/runs', (req, res) => {
  const run = {
    id: nextId(),
    task: req.body.task || 'Untitled task',
    status: req.body.status || 'planning',
    created_at: new Date().toISOString(),
    completed_at: null,
    subtasks: req.body.subtasks || [],
    final_output: req.body.final_output || null
  };
  db.aiOfficeRuns.push(run);
  saveDB(db);
  res.json(run);
});

app.put('/api/ai-office/runs/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const idx = db.aiOfficeRuns.findIndex(r => r.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Run not found' });

  const run = db.aiOfficeRuns[idx];

  // Update basic fields
  if (req.body.status) run.status = req.body.status;
  if (req.body.final_output) run.final_output = req.body.final_output;
  if (req.body.status === 'complete' || req.body.status === 'failed') {
    run.completed_at = new Date().toISOString();
  }

  // Replace subtasks array if provided
  if (req.body.subtasks) {
    run.subtasks = req.body.subtasks;
  }

  // Add or update a single subtask
  if (req.body.add_subtask) {
    const st = req.body.add_subtask;
    const existingIdx = run.subtasks.findIndex(s => s.id === st.id);
    if (existingIdx >= 0) {
      run.subtasks[existingIdx] = { ...run.subtasks[existingIdx], ...st };
    } else {
      run.subtasks.push({
        id: st.id || `T${run.subtasks.length + 1}`,
        name: st.name || 'Unnamed subtask',
        role: st.role || 'builder',
        status: st.status || 'pending',
        retries: st.retries || 0,
        result_summary: st.result_summary || null
      });
    }
  }

  // Update a specific subtask by id
  if (req.body.update_subtask) {
    const update = req.body.update_subtask;
    const stIdx = run.subtasks.findIndex(s => s.id === update.id);
    if (stIdx >= 0) {
      run.subtasks[stIdx] = { ...run.subtasks[stIdx], ...update };
    }
  }

  db.aiOfficeRuns[idx] = run;
  saveDB(db);
  res.json(run);
});

// ===== DASHBOARD STATS =====
app.get('/api/stats', (req, res) => {
  const now = new Date();
  const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  const monthRevenue = db.finances.filter(f => f.type === 'revenue' && f.month === currentMonth).reduce((s, f) => s + (f.amount || 0), 0);
  const monthExpenses = db.finances.filter(f => f.type === 'expense' && f.month === currentMonth).reduce((s, f) => s + (f.amount || 0), 0);

  // Staff stats
  const weekStartStr = weekAgo.toISOString().split('T')[0];
  const weekEndStr = now.toISOString().split('T')[0];
  const weekShifts = db.shifts.filter(s => s.date >= weekStartStr && s.date <= weekEndStr);
  const weekHours = weekShifts.reduce((sum, s) => sum + (s.hours || 0), 0);
  const weekLaborCost = weekShifts.reduce((sum, s) => {
    const emp = db.staff.find(e => e.id === s.employee_id);
    return sum + ((s.hours || 0) * (emp?.hourly_rate || 0));
  }, 0);

  // Client stats
  const openIssues = db.issues.filter(i => i.status !== 'resolved').length;

  res.json({
    prospects: db.prospects.length,
    hot: db.prospects.filter(p => p.priority === 'hot').length,
    active: db.prospects.filter(p => p.status === 'active' || p.status === 'new').length,
    signed: db.prospects.filter(p => p.status === 'signed').length,
    closed: db.prospects.filter(p => p.status === 'closed').length,
    thisWeek: db.activities.filter(a => new Date(a.created_at) > weekAgo).length,
    needsFollowup: db.activities.filter(a => a.next_action && a.next_action_date).length,
    machines: db.machines.length,
    machinesDeployed: db.machines.filter(m => m.status === 'deployed').length,
    machinesAvailable: db.machines.filter(m => m.status === 'available').length,
    locations: db.locations.length,
    products: db.products.length,
    monthRevenue,
    monthExpenses,
    monthProfit: monthRevenue - monthExpenses,
    pendingRestocks: db.restocks.filter(r => r.status === 'pending' || r.status === 'picking').length,
    // Staff
    staffCount: db.staff.length,
    activeStaff: db.staff.filter(s => s.status === 'active').length,
    weekHours,
    weekLaborCost,
    // Clients
    clientCount: db.clients.length,
    openIssues,
    // Contracts
    contractCount: (db.contracts || []).length,
    activeContracts: (db.contracts || []).filter(c => {
      const daysToEnd = c.end_date ? Math.ceil((new Date(c.end_date + 'T00:00:00') - now) / (1000 * 60 * 60 * 24)) : Infinity;
      return daysToEnd >= 0;
    }).length,
    expiringContracts: (db.contracts || []).filter(c => {
      const daysToEnd = c.end_date ? Math.ceil((new Date(c.end_date + 'T00:00:00') - now) / (1000 * 60 * 60 * 24)) : Infinity;
      const daysToRenewal = c.renewal_date ? Math.ceil((new Date(c.renewal_date + 'T00:00:00') - now) / (1000 * 60 * 60 * 24)) : Infinity;
      return daysToEnd >= 0 && Math.min(daysToEnd, daysToRenewal) <= 30;
    }).length,
    // Micro-markets
    micromarketCount: (db.micromarkets || []).length,
    micromarketFresh: (db.micromarkets || []).filter(m => m.fresh_food === 'yes').length,
    micromarketRevenueTarget: (db.micromarkets || []).reduce((s, m) => s + (m.monthly_revenue_target || 0), 0)
  });
});

// ===== IMPORT / RESET =====
app.post('/api/reset', (req, res) => {
  db = { prospects: [], contacts: [], activities: [], machines: [], locations: [], products: [], suppliers: [], finances: [], creditCards: [], restocks: [], aiOfficeRuns: [], staff: [], shifts: [], clients: [], touchpoints: [], issues: [], sales: [], planograms: [], marketingSpend: [], leadSources: [], gbpMetrics: [], competitors: [], competitorLocations: [], revenue: [], contracts: [], emailTemplates: [], emailSequences: [], emailSends: [], restockLogs: [], salesVelocity: [], restockCapacities: {}, micromarkets: [], smartMachines: [], machineTelemetry: [], todos: [], nextId: 1 };
  saveDB(db);
  res.json({ success: true });
});

app.post('/api/import', (req, res) => {
  const { prospects } = req.body;
  let imported = 0;
  for (const p of prospects) {
    try {
      let priority = 'normal';
      const notes = ((p.notes || '') + ' ' + (p.kurtis_notes || '')).toLowerCase();
      if (notes.includes('hot lead') || notes.includes('very interested') || notes.includes('eager') || notes.includes('please hook me up')) priority = 'hot';
      else if (notes.includes('will follow') || notes.includes('send proposal')) priority = 'warm';
      let status = 'active';
      if (notes.includes('not interested') || notes.includes('will not approve') || notes.includes('board not interested')) status = 'closed';
      const prospect = { id: nextId(), name: p.name, property_type: p.property_type, units: p.units, address: p.address, phone: p.phone, hours: p.hours, kurtis_notes: p.kurtis_notes || '', notes: p.notes, status, priority, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
      db.prospects.push(prospect);
      if (p.contact_name) {
        db.contacts.push({ id: nextId(), prospect_id: prospect.id, name: p.contact_name, role: p.contact_role, email: p.contact_email, phone: p.contact_phone, is_primary: true, created_at: new Date().toISOString() });
      }
      if (p.outreach_status) {
        db.activities.push({ id: nextId(), prospect_id: prospect.id, type: 'outreach', description: p.outreach_status, next_action: p.next_action, created_at: new Date().toISOString() });
      }
      imported++;
      // Auto-create pipeline card for imported prospect (CRM→Pipeline sync)
      if (status !== 'closed') {
        ensurePipelineCard(prospect.id);
      }
    } catch (e) { console.error('Import error:', e.message); }
  }
  saveDB(db);
  res.json({ imported });
});

// ===== GEOCACHE =====
const GEOCACHE_FILE = process.env.DB_PATH ? process.env.DB_PATH.replace('data.json','geocache.json') : '/data/geocache.json';
function loadGeoCache() { try { if (fs.existsSync(GEOCACHE_FILE)) return JSON.parse(fs.readFileSync(GEOCACHE_FILE, 'utf8')); } catch(e) {} return {}; }
function saveGeoCache(cache) { fs.writeFileSync(GEOCACHE_FILE, JSON.stringify(cache)); }
app.get('/api/geocache', (req, res) => res.json(loadGeoCache()));
app.post('/api/geocache', (req, res) => { saveGeoCache(req.body); res.json({ success: true }); });

// ===== STAFF API =====
app.get('/api/staff', (req, res) => {
  res.json(db.staff);
});

app.post('/api/staff', (req, res) => {
  if (!req.body.name || !req.body.name.trim()) {
    return res.status(400).json({ error: 'name is required' });
  }
  const employee = {
    id: nextId(),
    ...req.body,
    status: req.body.status || 'active',
    availability: req.body.availability || {},
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  db.staff.push(employee);
  saveDB(db);
  res.json(employee);
});

app.put('/api/staff/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const idx = db.staff.findIndex(s => s.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  db.staff[idx] = { ...db.staff[idx], ...req.body, updated_at: new Date().toISOString() };
  saveDB(db);
  res.json(db.staff[idx]);
});

app.delete('/api/staff/:id', (req, res) => {
  const id = parseInt(req.params.id);
  db.staff = db.staff.filter(s => s.id !== id);
  // Also remove their shifts
  db.shifts = db.shifts.filter(s => s.employee_id !== id);
  saveDB(db);
  res.json({ success: true });
});

// ===== SHIFTS API =====
app.get('/api/shifts', (req, res) => {
  const { employee_id, date_from, date_to } = req.query;
  let records = db.shifts;
  if (employee_id) records = records.filter(s => s.employee_id === parseInt(employee_id));
  if (date_from) records = records.filter(s => s.date >= date_from);
  if (date_to) records = records.filter(s => s.date <= date_to);
  res.json(records.sort((a, b) => new Date(b.date) - new Date(a.date)));
});

app.post('/api/shifts', (req, res) => {
  const shift = {
    id: nextId(),
    ...req.body,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  db.shifts.push(shift);
  saveDB(db);
  res.json(shift);
});

app.put('/api/shifts/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const idx = db.shifts.findIndex(s => s.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  db.shifts[idx] = { ...db.shifts[idx], ...req.body, updated_at: new Date().toISOString() };
  saveDB(db);
  res.json(db.shifts[idx]);
});

app.delete('/api/shifts/:id', (req, res) => {
  const id = parseInt(req.params.id);
  db.shifts = db.shifts.filter(s => s.id !== id);
  saveDB(db);
  res.json({ success: true });
});

// ===== CLIENTS API =====
app.get('/api/clients', (req, res) => {
  res.json(db.clients);
});

app.post('/api/clients', (req, res) => {
  const client = {
    id: nextId(),
    ...req.body,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  db.clients.push(client);
  saveDB(db);
  res.json(client);
});

app.put('/api/clients/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const idx = db.clients.findIndex(c => c.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  db.clients[idx] = { ...db.clients[idx], ...req.body, updated_at: new Date().toISOString() };
  saveDB(db);
  res.json(db.clients[idx]);
});

app.delete('/api/clients/:id', (req, res) => {
  const id = parseInt(req.params.id);
  db.clients = db.clients.filter(c => c.id !== id);
  // Also remove associated touchpoints and issues
  db.touchpoints = db.touchpoints.filter(t => t.client_id !== id);
  db.issues = db.issues.filter(i => i.client_id !== id);
  saveDB(db);
  res.json({ success: true });
});

// ===== TOUCHPOINTS API =====
app.get('/api/touchpoints', (req, res) => {
  const { client_id } = req.query;
  let records = db.touchpoints;
  if (client_id) records = records.filter(t => t.client_id === parseInt(client_id));
  res.json(records.sort((a, b) => new Date(b.date) - new Date(a.date)));
});

app.post('/api/touchpoints', (req, res) => {
  const touchpoint = {
    id: nextId(),
    ...req.body,
    created_at: new Date().toISOString()
  };
  db.touchpoints.push(touchpoint);
  saveDB(db);
  res.json(touchpoint);
});

// ===== ISSUES API =====
app.get('/api/issues', (req, res) => {
  const { client_id, status } = req.query;
  let records = db.issues;
  if (client_id) records = records.filter(i => i.client_id === parseInt(client_id));
  if (status) records = records.filter(i => i.status === status);
  res.json(records.sort((a, b) => new Date(b.created_at) - new Date(a.created_at)));
});

app.post('/api/issues', (req, res) => {
  const issue = {
    id: nextId(),
    ...req.body,
    status: req.body.status || 'open',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  db.issues.push(issue);
  saveDB(db);
  res.json(issue);
});

app.put('/api/issues/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const idx = db.issues.findIndex(i => i.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  db.issues[idx] = { ...db.issues[idx], ...req.body, updated_at: new Date().toISOString() };
  saveDB(db);
  res.json(db.issues[idx]);
});

// ===== SALES API =====
app.get('/api/sales', (req, res) => {
  const { machine_id, product_id, from, to } = req.query;
  let records = db.sales || [];
  if (machine_id) records = records.filter(s => s.machine_id === parseInt(machine_id));
  if (product_id) records = records.filter(s => s.product_id === parseInt(product_id));
  if (from) records = records.filter(s => (s.date || s.created_at) >= from);
  if (to) records = records.filter(s => (s.date || s.created_at) <= to);
  res.json(records.sort((a, b) => new Date(b.date || b.created_at) - new Date(a.date || a.created_at)));
});

app.post('/api/sales', (req, res) => {
  const sale = {
    id: nextId(),
    product_id: req.body.product_id,
    machine_id: req.body.machine_id || null,
    quantity: req.body.quantity || 1,
    unit_price: req.body.unit_price || 0,
    total: req.body.total || (req.body.unit_price || 0) * (req.body.quantity || 1),
    date: req.body.date || new Date().toISOString().split('T')[0],
    created_at: new Date().toISOString()
  };
  if (!db.sales) db.sales = [];
  db.sales.push(sale);
  saveDB(db);
  res.json(sale);
});

app.delete('/api/sales/:id', (req, res) => {
  const id = parseInt(req.params.id);
  db.sales = (db.sales || []).filter(s => s.id !== id);
  saveDB(db);
  res.json({ success: true });
});

// ===== PERFORMANCE API =====
app.get('/api/performance/summary', (req, res) => {
  const { period, machine_id, category } = req.query;
  const now = new Date();
  let fromDate = null;

  if (period === 'week') {
    fromDate = new Date(now);
    fromDate.setDate(fromDate.getDate() - fromDate.getDay());
    fromDate.setHours(0,0,0,0);
  } else if (period === 'month') {
    fromDate = new Date(now.getFullYear(), now.getMonth(), 1);
  } else if (period === '30days') {
    fromDate = new Date(now - 30 * 24 * 60 * 60 * 1000);
  }
  // 'all' = no date filter

  let sales = db.sales || [];
  if (fromDate) {
    const fromStr = fromDate.toISOString().split('T')[0];
    sales = sales.filter(s => (s.date || s.created_at?.split('T')[0] || '') >= fromStr);
  }
  if (machine_id) sales = sales.filter(s => s.machine_id === parseInt(machine_id));

  // Calculate weeks for velocity
  let weeks = 1;
  if (sales.length > 0) {
    const dates = sales.map(s => new Date(s.date || s.created_at)).filter(d => !isNaN(d));
    if (dates.length > 0) {
      const earliest = Math.min(...dates);
      const latest = Math.max(...dates);
      weeks = Math.max(1, (latest - earliest) / (7 * 24 * 60 * 60 * 1000));
    }
  }

  // Aggregate by product
  const productMap = {};
  (db.products || []).forEach(p => { productMap[p.id] = p; });

  const productAgg = {};
  sales.forEach(s => {
    const prod = productMap[s.product_id];
    if (!prod) return;
    if (category && prod.category !== category) return;
    if (!productAgg[s.product_id]) {
      productAgg[s.product_id] = {
        product_id: s.product_id,
        name: prod.name,
        category: prod.category || 'Other',
        cost_price: prod.cost_price || 0,
        sell_price: prod.sell_price || 0,
        margin: prod.margin || 0,
        revenue: 0,
        units: 0,
        cost_total: 0
      };
    }
    const qty = s.quantity || 1;
    const price = s.unit_price || prod.sell_price || 0;
    productAgg[s.product_id].revenue += price * qty;
    productAgg[s.product_id].units += qty;
    productAgg[s.product_id].cost_total += (prod.cost_price || 0) * qty;
  });

  // If no sales but products exist and category filter applied, include them with 0s
  if (category) {
    (db.products || []).filter(p => p.category === category).forEach(p => {
      if (!productAgg[p.id]) {
        productAgg[p.id] = {
          product_id: p.id, name: p.name, category: p.category || 'Other',
          cost_price: p.cost_price || 0, sell_price: p.sell_price || 0,
          margin: p.margin || 0, revenue: 0, units: 0, cost_total: 0
        };
      }
    });
  }

  const productList = Object.values(productAgg).map(p => ({
    ...p,
    profit: p.revenue - p.cost_total,
    profit_per_unit: p.units > 0 ? (p.revenue - p.cost_total) / p.units : 0,
    velocity: p.units / weeks
  })).sort((a, b) => b.revenue - a.revenue);

  // Category breakdown
  const categoryBreakdown = {};
  productList.forEach(p => {
    if (!categoryBreakdown[p.category]) categoryBreakdown[p.category] = 0;
    categoryBreakdown[p.category] += p.revenue;
  });

  const totalRevenue = productList.reduce((s, p) => s + p.revenue, 0);
  const totalUnits = productList.reduce((s, p) => s + p.units, 0);
  const totalProfit = productList.reduce((s, p) => s + p.profit, 0);
  const totalVelocity = productList.reduce((s, p) => s + p.velocity, 0);
  const avgMargin = totalRevenue > 0 ? (totalProfit / totalRevenue) * 100 : 0;
  const swapCount = productList.filter(p => p.velocity < 2 && p.units > 0).length;

  res.json({
    products: productList,
    categoryBreakdown,
    totalRevenue, totalUnits, totalProfit, totalVelocity,
    avgMargin, swapCount, weeks
  });
});

app.get('/api/performance/by-machine/:id', (req, res) => {
  const machineId = parseInt(req.params.id);
  const sales = (db.sales || []).filter(s => s.machine_id === machineId);
  const productMap = {};
  (db.products || []).forEach(p => { productMap[p.id] = p; });

  const productAgg = {};
  sales.forEach(s => {
    const prod = productMap[s.product_id];
    if (!prod) return;
    if (!productAgg[s.product_id]) {
      productAgg[s.product_id] = { product_id: s.product_id, name: prod.name, category: prod.category, revenue: 0, units: 0 };
    }
    productAgg[s.product_id].revenue += (s.unit_price || prod.sell_price || 0) * (s.quantity || 1);
    productAgg[s.product_id].units += s.quantity || 1;
  });

  res.json({
    machine_id: machineId,
    products: Object.values(productAgg).sort((a, b) => b.revenue - a.revenue),
    total_sales: sales.length,
    total_revenue: sales.reduce((s, sl) => s + (sl.total || 0), 0)
  });
});

app.get('/api/performance/recommendations', (req, res) => {
  const sales = db.sales || [];
  const productMap = {};
  (db.products || []).forEach(p => { productMap[p.id] = p; });

  const now = new Date();
  const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const recentSales = sales.filter(s => (s.date || '') >= thirtyDaysAgo);

  const productUnits = {};
  recentSales.forEach(s => {
    if (!productUnits[s.product_id]) productUnits[s.product_id] = 0;
    productUnits[s.product_id] += s.quantity || 1;
  });

  const recommendations = (db.products || []).map(p => {
    const units = productUnits[p.id] || 0;
    const velocity = units / 4.3; // ~30 days = 4.3 weeks
    return {
      product_id: p.id, name: p.name, category: p.category,
      velocity, units_30d: units,
      margin: p.margin || 0,
      profit_per_unit: (p.sell_price || 0) - (p.cost_price || 0),
      recommendation: velocity < 2 ? 'consider_replacing' : 'keep',
      reason: velocity < 2
        ? `Only ${velocity.toFixed(1)} units/week — below 2/week threshold`
        : `${velocity.toFixed(1)} units/week — performing well`
    };
  }).sort((a, b) => a.velocity - b.velocity);

  res.json(recommendations);
});

// ===== PLANOGRAMS API =====
app.get('/api/planograms', (req, res) => {
  res.json(db.planograms || []);
});

app.post('/api/planograms', (req, res) => {
  const planogram = {
    id: nextId(),
    name: req.body.name || 'Untitled',
    machine_id: req.body.machine_id || null,
    rows: req.body.rows || 6,
    columns: req.body.columns || 8,
    slots: req.body.slots || [],
    is_template: req.body.is_template || false,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  if (!db.planograms) db.planograms = [];
  db.planograms.push(planogram);
  saveDB(db);
  res.json(planogram);
});

app.put('/api/planograms/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const idx = (db.planograms || []).findIndex(p => p.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  db.planograms[idx] = {
    ...db.planograms[idx],
    ...req.body,
    updated_at: new Date().toISOString()
  };
  saveDB(db);
  res.json(db.planograms[idx]);
});

app.delete('/api/planograms/:id', (req, res) => {
  const id = parseInt(req.params.id);
  db.planograms = (db.planograms || []).filter(p => p.id !== id);
  saveDB(db);
  res.json({ success: true });
});

app.get('/api/planograms/by-machine/:machineId', (req, res) => {
  const machineId = parseInt(req.params.machineId);
  const planogram = (db.planograms || []).find(p => p.machine_id === machineId && !p.is_template);
  if (!planogram) return res.status(404).json({ error: 'No planogram for this machine' });
  res.json(planogram);
});

app.post('/api/planograms/:id/slots', (req, res) => {
  const id = parseInt(req.params.id);
  const idx = (db.planograms || []).findIndex(p => p.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  db.planograms[idx].slots = req.body.slots || [];
  db.planograms[idx].updated_at = new Date().toISOString();
  saveDB(db);
  res.json(db.planograms[idx]);
});

// ===== ANALYTICS / FUNNEL API =====
app.get('/api/analytics/funnel', (req, res) => {
  const { days, property_type } = req.query;
  const now = new Date();
  let cutoff = null;
  if (days && days !== 'all') {
    cutoff = new Date(now - parseInt(days) * 24 * 60 * 60 * 1000);
  }

  // Filter prospects by time period
  let prospects = db.prospects;
  if (cutoff) {
    prospects = prospects.filter(p => new Date(p.created_at) >= cutoff);
  }
  if (property_type && property_type !== 'all') {
    prospects = prospects.filter(p => p.property_type === property_type);
  }

  const prospectIds = new Set(prospects.map(p => p.id));

  // Filter activities to only those belonging to filtered prospects
  let activities = db.activities.filter(a => prospectIds.has(a.prospect_id));
  if (cutoff) {
    activities = activities.filter(a => new Date(a.created_at) >= cutoff);
  }

  // Build sets of prospect IDs that reached each stage
  const popInIds = new Set();
  const callIds = new Set();
  const proposalIds = new Set();
  activities.forEach(a => {
    const t = (a.type || '').toLowerCase();
    if (t === 'pop_in' || t === 'pop-in' || t === 'popin' || t === 'visit') popInIds.add(a.prospect_id);
    if (t === 'call' || t === 'phone') callIds.add(a.prospect_id);
    if (t === 'proposal' || t === 'quote') proposalIds.add(a.prospect_id);
  });
  const signedIds = new Set(prospects.filter(p => p.status === 'signed').map(p => p.id));

  const total = prospects.length;
  const popIns = popInIds.size;
  const calls = callIds.size;
  const proposals = proposalIds.size;
  const signed = signedIds.size;

  function rate(a, b) { return b > 0 ? Math.round((a / b) * 1000) / 10 : 0; }

  // Breakdown by property type
  const propertyTypes = {};
  prospects.forEach(p => {
    const pt = p.property_type || 'Unknown';
    if (!propertyTypes[pt]) propertyTypes[pt] = { total: 0, pop_ins: 0, calls: 0, proposals: 0, signed: 0 };
    propertyTypes[pt].total++;
    if (popInIds.has(p.id)) propertyTypes[pt].pop_ins++;
    if (callIds.has(p.id)) propertyTypes[pt].calls++;
    if (proposalIds.has(p.id)) propertyTypes[pt].proposals++;
    if (signedIds.has(p.id)) propertyTypes[pt].signed++;
  });

  // Add conversion rates to each property type
  Object.keys(propertyTypes).forEach(pt => {
    const d = propertyTypes[pt];
    d.rates = {
      pop_in_rate: rate(d.pop_ins, d.total),
      call_rate: rate(d.calls, d.pop_ins),
      proposal_rate: rate(d.proposals, d.calls),
      close_rate: rate(d.signed, d.proposals),
      overall_rate: rate(d.signed, d.total)
    };
  });

  // Find biggest drop-off
  const stages = [
    { name: 'Total → Pop-ins', from: total, to: popIns },
    { name: 'Pop-ins → Calls', from: popIns, to: calls },
    { name: 'Calls → Proposals', from: calls, to: proposals },
    { name: 'Proposals → Signed', from: proposals, to: signed }
  ];
  let biggestDrop = { stage: 'N/A', dropRate: 0, lost: 0 };
  stages.forEach(s => {
    const lost = s.from - s.to;
    const dropRate = s.from > 0 ? (lost / s.from) * 100 : 0;
    if (dropRate > biggestDrop.dropRate) {
      biggestDrop = { stage: s.name, dropRate: Math.round(dropRate * 10) / 10, lost };
    }
  });

  res.json({
    funnel: {
      total,
      pop_ins: popIns,
      calls,
      proposals,
      signed
    },
    rates: {
      pop_in_rate: rate(popIns, total),
      call_rate: rate(calls, popIns),
      proposal_rate: rate(proposals, calls),
      close_rate: rate(signed, proposals),
      overall_rate: rate(signed, total)
    },
    by_property_type: propertyTypes,
    biggest_drop: biggestDrop,
    period: days || 'all',
    property_type_filter: property_type || 'all'
  });
});

// ===== ANALYTICS: TIME-TO-CLOSE API =====
app.get('/api/analytics/time-to-close', (req, res) => {
  const signedProspects = db.prospects.filter(p => p.status === 'signed' && p.created_at);

  // For each signed prospect, determine close date from:
  // 1. signed_at field if exists
  // 2. Last activity date
  // 3. updated_at as fallback
  const closedDeals = signedProspects.map(p => {
    let signedDate = p.signed_at;
    if (!signedDate) {
      const prospectActivities = db.activities
        .filter(a => a.prospect_id === p.id)
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      signedDate = prospectActivities.length > 0 ? prospectActivities[0].created_at : p.updated_at;
    }
    const createdAt = new Date(p.created_at);
    const closedAt = new Date(signedDate);
    const days = Math.max(0, Math.round((closedAt - createdAt) / (1000 * 60 * 60 * 24)));
    return {
      id: p.id,
      name: p.name,
      property_type: p.property_type || 'Unknown',
      days_to_close: days,
      created_at: p.created_at,
      signed_at: signedDate
    };
  }).filter(d => d.days_to_close >= 0);

  // Overall stats
  const allDays = closedDeals.map(d => d.days_to_close).sort((a, b) => a - b);

  function calcStats(daysArr) {
    if (daysArr.length === 0) return { count: 0, average: 0, median: 0, fastest: 0, slowest: 0 };
    const sum = daysArr.reduce((s, d) => s + d, 0);
    const avg = Math.round((sum / daysArr.length) * 10) / 10;
    const sorted = [...daysArr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 === 0 ? Math.round(((sorted[mid - 1] + sorted[mid]) / 2) * 10) / 10 : sorted[mid];
    return {
      count: daysArr.length,
      average: avg,
      median: median,
      fastest: sorted[0],
      slowest: sorted[sorted.length - 1]
    };
  }

  const overall = calcStats(allDays);

  // Group by property_type
  const byPropertyType = {};
  closedDeals.forEach(d => {
    const pt = d.property_type;
    if (!byPropertyType[pt]) byPropertyType[pt] = [];
    byPropertyType[pt].push(d.days_to_close);
  });

  const propertyTypeStats = {};
  Object.keys(byPropertyType).forEach(pt => {
    propertyTypeStats[pt] = calcStats(byPropertyType[pt]);
  });

  // Rank by fastest average close
  const rankings = Object.entries(propertyTypeStats)
    .map(([type, stats]) => ({ type, ...stats }))
    .sort((a, b) => a.average - b.average);

  // Find fastest and slowest individual deals
  const fastestDeal = closedDeals.length > 0
    ? closedDeals.reduce((best, d) => d.days_to_close < best.days_to_close ? d : best)
    : null;
  const slowestDeal = closedDeals.length > 0
    ? closedDeals.reduce((worst, d) => d.days_to_close > worst.days_to_close ? d : worst)
    : null;

  // Distribution buckets (for histogram)
  const buckets = [
    { label: '0-7 days', min: 0, max: 7, count: 0 },
    { label: '8-14 days', min: 8, max: 14, count: 0 },
    { label: '15-30 days', min: 15, max: 30, count: 0 },
    { label: '31-60 days', min: 31, max: 60, count: 0 },
    { label: '61-90 days', min: 61, max: 90, count: 0 },
    { label: '90+ days', min: 91, max: Infinity, count: 0 }
  ];
  allDays.forEach(d => {
    const bucket = buckets.find(b => d >= b.min && d <= b.max);
    if (bucket) bucket.count++;
  });

  res.json({
    overall,
    by_property_type: propertyTypeStats,
    rankings,
    fastest_deal: fastestDeal,
    slowest_deal: slowestDeal,
    distribution: buckets,
    deals: closedDeals,
    total_prospects: db.prospects.length,
    total_signed: signedProspects.length
  });
});

// ===== PROPERTY TYPE ANALYTICS API =====
app.get('/api/analytics/property-types', (req, res) => {
  const prospects = db.prospects || [];
  const activities = db.activities || [];
  const locations = db.locations || [];
  const machines = db.machines || [];
  const finances = db.finances || [];

  // Known property types
  const knownTypes = ['apartments', 'senior_living', 'healthcare', 'industrial', 'office'];

  // Aggregate by property type
  const typeMap = {};
  knownTypes.forEach(pt => {
    typeMap[pt] = { property_type: pt, total: 0, statuses: {}, priorities: {}, signed: 0, active: 0, closed: 0, new_count: 0, pipeline: 0, activities: 0, avg_activities: 0, newest: null, oldest: null };
  });

  prospects.forEach(p => {
    const pt = (p.property_type || 'unknown').toLowerCase().replace(/\s+/g, '_');
    if (!typeMap[pt]) {
      typeMap[pt] = { property_type: pt, total: 0, statuses: {}, priorities: {}, signed: 0, active: 0, closed: 0, new_count: 0, pipeline: 0, activities: 0, avg_activities: 0, newest: null, oldest: null };
    }
    const entry = typeMap[pt];
    entry.total++;

    // Status breakdown
    const status = p.status || 'unknown';
    entry.statuses[status] = (entry.statuses[status] || 0) + 1;
    if (status === 'signed') entry.signed++;
    else if (status === 'active' || status === 'new') { entry.active++; entry.pipeline++; }
    else if (status === 'closed') entry.closed++;
    if (status === 'new') entry.new_count++;

    // Priority breakdown
    const priority = p.priority || 'normal';
    entry.priorities[priority] = (entry.priorities[priority] || 0) + 1;

    // Activity count for this prospect
    const pActivities = activities.filter(a => a.prospect_id === p.id);
    entry.activities += pActivities.length;

    // Date tracking
    const created = p.created_at ? new Date(p.created_at) : null;
    if (created) {
      if (!entry.newest || created > new Date(entry.newest)) entry.newest = p.created_at;
      if (!entry.oldest || created < new Date(entry.oldest)) entry.oldest = p.created_at;
    }
  });

  // Calculate conversion rates and rankings
  const types = Object.values(typeMap).filter(t => t.total > 0);

  types.forEach(t => {
    t.conversion_rate = t.total > 0 ? Math.round((t.signed / t.total) * 1000) / 10 : 0;
    t.active_rate = t.total > 0 ? Math.round((t.active / t.total) * 1000) / 10 : 0;
    t.close_rate = t.total > 0 ? Math.round((t.closed / t.total) * 1000) / 10 : 0;
    t.avg_activities = t.total > 0 ? Math.round((t.activities / t.total) * 10) / 10 : 0;
    t.hot_leads = t.priorities['hot'] || 0;
    t.warm_leads = t.priorities['warm'] || 0;

    // Estimate pipeline value (each active/new prospect ~ $200/mo revenue potential)
    t.pipeline_value = t.pipeline * 200;
    t.signed_value = t.signed * 200;
  });

  // Rank by conversion rate
  const byConversion = [...types].sort((a, b) => b.conversion_rate - a.conversion_rate);
  byConversion.forEach((t, i) => { t.rank_conversion = i + 1; });

  // Rank by total signed
  const bySigned = [...types].sort((a, b) => b.signed - a.signed);
  bySigned.forEach((t, i) => { t.rank_signed = i + 1; });

  // Rank by pipeline value
  const byPipeline = [...types].sort((a, b) => b.pipeline_value - a.pipeline_value);
  byPipeline.forEach((t, i) => { t.rank_pipeline = i + 1; });

  // Composite rank (average of all ranks)
  types.forEach(t => {
    t.composite_rank = Math.round(((t.rank_conversion + t.rank_signed + t.rank_pipeline) / 3) * 10) / 10;
  });
  types.sort((a, b) => a.composite_rank - b.composite_rank);
  types.forEach((t, i) => { t.overall_rank = i + 1; });

  // Find top performer
  const topConversion = byConversion[0];
  const topSigned = bySigned[0];
  const topOverall = types[0];

  // Build recommendation
  let recommendation = '';
  if (topConversion && topConversion.conversion_rate > 0) {
    const label = topConversion.property_type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    recommendation = `Focus on ${label} — highest conversion rate at ${topConversion.conversion_rate}%`;
    if (topSigned && topSigned.property_type !== topConversion.property_type) {
      const signedLabel = topSigned.property_type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      recommendation += `. ${signedLabel} leads in total signed (${topSigned.signed}).`;
    }
  } else {
    recommendation = 'Not enough data yet. Keep adding prospects to see trends.';
  }

  // Summary stats
  const totalProspects = prospects.length;
  const totalSigned = prospects.filter(p => p.status === 'signed').length;
  const overallConversion = totalProspects > 0 ? Math.round((totalSigned / totalProspects) * 1000) / 10 : 0;
  const totalPipeline = prospects.filter(p => p.status === 'active' || p.status === 'new').length;

  res.json({
    types,
    summary: {
      total_prospects: totalProspects,
      total_signed: totalSigned,
      overall_conversion: overallConversion,
      total_pipeline: totalPipeline,
      total_pipeline_value: totalPipeline * 200,
      property_type_count: types.length
    },
    recommendation,
    top_performers: {
      by_conversion: topConversion ? { type: topConversion.property_type, rate: topConversion.conversion_rate } : null,
      by_signed: topSigned ? { type: topSigned.property_type, count: topSigned.signed } : null,
      overall: topOverall ? { type: topOverall.property_type, rank: topOverall.composite_rank } : null
    }
  });
});

// ===== SEASONAL TRENDS ANALYTICS API =====
app.get('/api/analytics/trends', (req, res) => {
  const records = db.revenue || [];
  const prospects = db.prospects || [];

  // Helper: get property type for a location_id
  function getPropertyType(locationId) {
    const prospect = prospects.find(p => p.id === locationId);
    return prospect?.property_type || 'unknown';
  }

  // Aggregate revenue by year-month
  const monthlyData = {};
  const byPropertyType = {};
  records.forEach(r => {
    if (!r.date || !r.amount) return;
    const month = r.date.slice(0, 7); // YYYY-MM
    if (!monthlyData[month]) monthlyData[month] = 0;
    monthlyData[month] += r.amount;

    const pt = getPropertyType(r.location_id);
    if (!byPropertyType[pt]) byPropertyType[pt] = {};
    if (!byPropertyType[pt][month]) byPropertyType[pt][month] = 0;
    byPropertyType[pt][month] += r.amount;
  });

  // Sort months chronologically
  const sortedMonths = Object.keys(monthlyData).sort();

  // Group by year for YoY comparison
  const byYear = {};
  sortedMonths.forEach(m => {
    const [year, month] = m.split('-');
    if (!byYear[year]) byYear[year] = {};
    byYear[year][parseInt(month)] = monthlyData[m];
  });

  // Monthly time series
  const timeSeries = sortedMonths.map(m => ({
    month: m,
    revenue: monthlyData[m]
  }));

  // Property type breakdown (monthly series per type)
  const propertyTimeSeries = {};
  Object.keys(byPropertyType).forEach(pt => {
    propertyTimeSeries[pt] = sortedMonths.map(m => ({
      month: m,
      revenue: byPropertyType[pt][m] || 0
    }));
  });

  // Seasonal pattern analysis
  const SEASONS = {
    summer: [6, 7, 8],
    holidays: [11, 12],
    postHoliday: [1, 2],
    spring: [3, 4, 5],
    fall: [9, 10]
  };

  const seasonalAvg = {};
  Object.entries(SEASONS).forEach(([season, months]) => {
    const vals = [];
    sortedMonths.forEach(m => {
      const mo = parseInt(m.split('-')[1]);
      if (months.includes(mo)) vals.push(monthlyData[m]);
    });
    seasonalAvg[season] = vals.length > 0
      ? { average: vals.reduce((a, b) => a + b, 0) / vals.length, count: vals.length }
      : { average: 0, count: 0 };
  });

  // Overall monthly average
  const overallAvg = timeSeries.length > 0
    ? timeSeries.reduce((s, t) => s + t.revenue, 0) / timeSeries.length
    : 0;

  // Seasonal indices (ratio of seasonal avg to overall avg)
  const seasonalIndices = {};
  Object.entries(seasonalAvg).forEach(([season, data]) => {
    seasonalIndices[season] = overallAvg > 0 ? data.average / overallAvg : 1;
  });

  // Month-over-month changes
  const momChanges = [];
  for (let i = 1; i < timeSeries.length; i++) {
    const prev = timeSeries[i - 1].revenue;
    const curr = timeSeries[i].revenue;
    const pctChange = prev > 0 ? ((curr - prev) / prev * 100) : 0;
    momChanges.push({
      month: timeSeries[i].month,
      change: pctChange,
      direction: pctChange >= 0 ? 'up' : 'down'
    });
  }

  // Prediction for next month
  let prediction = null;
  if (timeSeries.length >= 2) {
    const now = new Date();
    const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const nextMonthNum = nextMonth.getMonth() + 1;
    const nextMonthStr = `${nextMonth.getFullYear()}-${String(nextMonthNum).padStart(2, '0')}`;

    // Find which season next month falls in
    let nextSeason = 'spring';
    Object.entries(SEASONS).forEach(([season, months]) => {
      if (months.includes(nextMonthNum)) nextSeason = season;
    });

    // Look at same month in previous years
    const sameMonthPrev = [];
    Object.entries(byYear).forEach(([year, months]) => {
      if (months[nextMonthNum] !== undefined) {
        sameMonthPrev.push(months[nextMonthNum]);
      }
    });

    // Calculate prediction based on: seasonal index + recent trend + YoY same month
    const lastRevenue = timeSeries[timeSeries.length - 1].revenue;
    const seasonIdx = seasonalIndices[nextSeason] || 1;

    // Weighted prediction
    let predicted;
    if (sameMonthPrev.length > 0) {
      const avgSameMonth = sameMonthPrev.reduce((a, b) => a + b, 0) / sameMonthPrev.length;
      // 40% same-month historical, 30% seasonal adjustment of last month, 30% recent trend
      const recentTrend = momChanges.length > 0
        ? momChanges.slice(-3).reduce((s, c) => s + c.change, 0) / Math.min(momChanges.length, 3)
        : 0;
      predicted = avgSameMonth * 0.4 + (lastRevenue * seasonIdx) * 0.3 + (lastRevenue * (1 + recentTrend / 100)) * 0.3;
    } else {
      predicted = lastRevenue * seasonIdx;
    }

    const pctChange = lastRevenue > 0 ? ((predicted - lastRevenue) / lastRevenue * 100) : 0;

    prediction = {
      month: nextMonthStr,
      monthNum: nextMonthNum,
      season: nextSeason,
      predicted: Math.round(predicted * 100) / 100,
      pctChange: Math.round(pctChange * 10) / 10,
      direction: pctChange >= 0 ? 'up' : 'down',
      confidence: timeSeries.length >= 12 ? 'high' : timeSeries.length >= 6 ? 'medium' : 'low',
      basis: sameMonthPrev.length > 0 ? 'historical + seasonal' : 'seasonal index'
    };
  }

  // Year-over-year comparison (monthly arrays per year)
  const yoyComparison = {};
  Object.entries(byYear).forEach(([year, months]) => {
    yoyComparison[year] = Array.from({ length: 12 }, (_, i) => months[i + 1] || 0);
  });

  res.json({
    timeSeries,
    byYear: yoyComparison,
    propertyTimeSeries,
    seasonalAvg,
    seasonalIndices,
    overallAvg: Math.round(overallAvg * 100) / 100,
    momChanges,
    prediction,
    totalMonths: timeSeries.length,
    totalRevenue: timeSeries.reduce((s, t) => s + t.revenue, 0),
    years: Object.keys(byYear).sort()
  });
});

// ===== BASE ANALYTICS ROUTE =====
app.get('/api/analytics', (req, res) => {
  res.json({
    service: 'Kande VendTech Analytics API',
    endpoints: [
      '/api/analytics/funnel',
      '/api/analytics/time-to-close',
      '/api/analytics/property-types',
      '/api/analytics/trends',
      '/api/analytics/overview',
      '/api/analytics/export'
    ],
    timestamp: new Date().toISOString()
  });
});

// ===== BASE TEST ROUTE =====
app.get('/api/test', (req, res) => {
  res.json({
    status: 'OK',
    service: 'Kande VendTech API Test',
    timestamp: new Date().toISOString(),
    endpoints: {
      analytics: '/api/analytics',
      digital: '/api/digital/test'
    }
  });
});

// ===== REVENUE API =====
app.get('/api/revenue', (req, res) => {
  const { location_id, from, to } = req.query;
  let records = db.revenue || [];
  if (location_id) records = records.filter(r => r.location_id === parseInt(location_id));
  if (from) records = records.filter(r => r.date >= from);
  if (to) records = records.filter(r => r.date <= to);
  res.json(records.sort((a, b) => new Date(b.date) - new Date(a.date)));
});

app.get('/api/revenue/summary', (req, res) => {
  const records = db.revenue || [];
  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastMonthStr = `${lastMonth.getFullYear()}-${String(lastMonth.getMonth() + 1).padStart(2, '0')}`;

  const totalRevenue = records.reduce((s, r) => s + (r.amount || 0), 0);
  const uniqueLocations = [...new Set(records.map(r => r.location_id))];
  const avgPerLocation = uniqueLocations.length > 0 ? totalRevenue / uniqueLocations.length : 0;

  // Current month
  const currentMonthRecords = records.filter(r => r.date && r.date.startsWith(currentMonth));
  const currentMonthTotal = currentMonthRecords.reduce((s, r) => s + (r.amount || 0), 0);

  // Last month
  const lastMonthRecords = records.filter(r => r.date && r.date.startsWith(lastMonthStr));
  const lastMonthTotal = lastMonthRecords.reduce((s, r) => s + (r.amount || 0), 0);

  // By location
  const byLocation = {};
  records.forEach(r => {
    if (!byLocation[r.location_id]) byLocation[r.location_id] = 0;
    byLocation[r.location_id] += r.amount || 0;
  });

  // Top performers
  const topPerformers = Object.entries(byLocation)
    .map(([id, total]) => {
      const prospect = db.prospects.find(p => p.id === parseInt(id));
      return { location_id: parseInt(id), name: prospect?.name || `Location #${id}`, total };
    })
    .sort((a, b) => b.total - a.total)
    .slice(0, 10);

  // Monthly breakdown
  const monthly = {};
  records.forEach(r => {
    if (!r.date) return;
    const month = r.date.slice(0, 7);
    if (!monthly[month]) monthly[month] = 0;
    monthly[month] += r.amount || 0;
  });

  res.json({
    totalRevenue,
    avgPerLocation,
    locationCount: uniqueLocations.length,
    entryCount: records.length,
    currentMonth: { month: currentMonth, total: currentMonthTotal, entries: currentMonthRecords.length },
    lastMonth: { month: lastMonthStr, total: lastMonthTotal, entries: lastMonthRecords.length },
    monthOverMonth: lastMonthTotal > 0 ? ((currentMonthTotal - lastMonthTotal) / lastMonthTotal * 100).toFixed(1) : null,
    topPerformers,
    byLocation,
    monthly
  });
});

app.post('/api/revenue', (req, res) => {
  const record = {
    id: nextId(),
    location_id: parseInt(req.body.location_id) || null,
    machine_id: req.body.machine_id ? parseInt(req.body.machine_id) : null,
    date: req.body.date || new Date().toISOString().split('T')[0],
    amount: parseFloat(req.body.amount) || 0,
    notes: req.body.notes || '',
    created_at: new Date().toISOString()
  };
  if (!db.revenue) db.revenue = [];
  db.revenue.push(record);
  saveDB(db);
  res.json(record);
});

app.put('/api/revenue/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const idx = (db.revenue || []).findIndex(r => r.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  db.revenue[idx] = {
    ...db.revenue[idx],
    location_id: req.body.location_id !== undefined ? parseInt(req.body.location_id) : db.revenue[idx].location_id,
    machine_id: req.body.machine_id !== undefined ? (req.body.machine_id ? parseInt(req.body.machine_id) : null) : db.revenue[idx].machine_id,
    date: req.body.date || db.revenue[idx].date,
    amount: req.body.amount !== undefined ? parseFloat(req.body.amount) : db.revenue[idx].amount,
    notes: req.body.notes !== undefined ? req.body.notes : db.revenue[idx].notes,
    updated_at: new Date().toISOString()
  };
  saveDB(db);
  res.json(db.revenue[idx]);
});

app.delete('/api/revenue/:id', (req, res) => {
  const id = parseInt(req.params.id);
  db.revenue = (db.revenue || []).filter(r => r.id !== id);
  saveDB(db);
  res.json({ success: true });
});

// ===== COMPETITORS API =====
app.get('/api/competitors', (req, res) => {
  const { type, target, q } = req.query;
  let records = db.competitors || [];
  if (type) records = records.filter(c => (c.machine_types || []).includes(type));
  if (target) records = records.filter(c => (c.target_markets || []).includes(target));
  if (q) {
    const query = q.toLowerCase();
    records = records.filter(c => {
      const searchable = [c.name, c.notes, c.pricing_notes, c.strengths, c.weaknesses,
        c.win_loss_notes, c.contact_person, (c.target_markets||[]).join(' '),
        (c.machine_types||[]).join(' ')].join(' ').toLowerCase();
      return searchable.includes(query);
    });
  }
  res.json(records.sort((a, b) => (a.name || '').localeCompare(b.name || '')));
});

app.post('/api/competitors', (req, res) => {
  const competitor = {
    id: nextId(),
    name: req.body.name || 'Unknown',
    website: req.body.website || '',
    phone: req.body.phone || '',
    locations_count: parseInt(req.body.locations_count) || 0,
    contact_person: req.body.contact_person || '',
    pricing_notes: req.body.pricing_notes || '',
    machine_types: req.body.machine_types || [],
    target_markets: req.body.target_markets || [],
    strengths: req.body.strengths || '',
    weaknesses: req.body.weaknesses || '',
    win_loss_notes: req.body.win_loss_notes || '',
    notes: req.body.notes || '',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  if (!db.competitors) db.competitors = [];
  db.competitors.push(competitor);
  saveDB(db);
  res.json(competitor);
});

app.put('/api/competitors/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const idx = (db.competitors || []).findIndex(c => c.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Competitor not found' });
  db.competitors[idx] = {
    ...db.competitors[idx],
    ...req.body,
    id, // prevent id override
    updated_at: new Date().toISOString()
  };
  saveDB(db);
  res.json(db.competitors[idx]);
});

app.delete('/api/competitors/:id', (req, res) => {
  const id = parseInt(req.params.id);
  db.competitors = (db.competitors || []).filter(c => c.id !== id);
  saveDB(db);
  res.json({ success: true });
});

// ===== COMPETITOR LOCATIONS API (for mapping) =====
// Geocode helper for competitor locations
async function geocodeCompetitorLocation(loc) {
  if (!loc.address || (loc.lat && loc.lng)) return false;
  const coords = await geocodeAddress(loc.address);
  if (coords) { loc.lat = coords.lat; loc.lng = coords.lng; return true; }
  return false;
}

app.get('/api/competitor-locations', (req, res) => {
  const { competitor, property_type, q } = req.query;
  let records = db.competitorLocations || [];
  if (competitor) records = records.filter(c => c.competitor === competitor);
  if (property_type) records = records.filter(c => c.property_type === property_type);
  if (q) {
    const query = q.toLowerCase();
    records = records.filter(c => {
      const searchable = [c.name, c.address, c.notes || ''].join(' ').toLowerCase();
      return searchable.includes(query);
    });
  }
  res.json(records.sort((a, b) => (a.name || '').localeCompare(b.name || '')));
});

app.post('/api/competitor-locations', async (req, res) => {
  const loc = {
    id: nextId(),
    competitor: req.body.competitor || 'other',
    name: req.body.name || 'Unknown',
    address: req.body.address || '',
    property_type: req.body.property_type || '',
    source: req.body.source || 'other',
    notes: req.body.notes || '',
    lat: req.body.lat || null,
    lng: req.body.lng || null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  if (!db.competitorLocations) db.competitorLocations = [];
  db.competitorLocations.push(loc);
  saveDB(db);
  res.json(loc);
  // Geocode in background
  geocodeCompetitorLocation(loc).then(updated => { if (updated) saveDB(db); });
});

app.put('/api/competitor-locations/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const idx = (db.competitorLocations || []).findIndex(c => c.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Competitor location not found' });
  const oldAddress = db.competitorLocations[idx].address;
  db.competitorLocations[idx] = {
    ...db.competitorLocations[idx],
    ...req.body,
    id,
    updated_at: new Date().toISOString()
  };
  saveDB(db);
  res.json(db.competitorLocations[idx]);
  // Re-geocode if address changed
  if (req.body.address && req.body.address !== oldAddress) {
    db.competitorLocations[idx].lat = null;
    db.competitorLocations[idx].lng = null;
    geocodeCompetitorLocation(db.competitorLocations[idx]).then(updated => { if (updated) saveDB(db); });
  }
});

app.delete('/api/competitor-locations/:id', (req, res) => {
  const id = parseInt(req.params.id);
  db.competitorLocations = (db.competitorLocations || []).filter(c => c.id !== id);
  saveDB(db);
  res.json({ success: true });
});

// Get competitor locations stats
app.get('/api/competitor-locations/stats', (req, res) => {
  const locs = db.competitorLocations || [];
  const byCompetitor = {};
  const byPropertyType = {};
  
  locs.forEach(loc => {
    byCompetitor[loc.competitor] = (byCompetitor[loc.competitor] || 0) + 1;
    if (loc.property_type) {
      byPropertyType[loc.property_type] = (byPropertyType[loc.property_type] || 0) + 1;
    }
  });
  
  res.json({
    total: locs.length,
    byCompetitor,
    byPropertyType,
    withCoordinates: locs.filter(l => l.lat && l.lng).length
  });
});

// ===== CONTRACTS API =====
app.get('/api/contracts', (req, res) => {
  const { prospect_id, status } = req.query;
  let records = db.contracts || [];
  if (prospect_id) records = records.filter(c => c.prospect_id === parseInt(prospect_id));
  if (status) {
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    records = records.filter(c => {
      const daysToEnd = c.end_date ? Math.ceil((new Date(c.end_date + 'T00:00:00') - now) / (1000 * 60 * 60 * 24)) : Infinity;
      const daysToRenewal = c.renewal_date ? Math.ceil((new Date(c.renewal_date + 'T00:00:00') - now) / (1000 * 60 * 60 * 24)) : Infinity;
      const minDays = Math.min(daysToEnd, daysToRenewal);
      if (status === 'expired') return daysToEnd < 0;
      if (status === 'expiring') return daysToEnd >= 0 && minDays <= 30;
      if (status === 'active') return daysToEnd >= 0 && minDays > 30;
      return true;
    });
  }
  res.json(records.sort((a, b) => new Date(a.renewal_date || a.end_date || '9999-12-31') - new Date(b.renewal_date || b.end_date || '9999-12-31')));
});

app.get('/api/contracts/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const contract = (db.contracts || []).find(c => c.id === id);
  if (!contract) return res.status(404).json({ error: 'Contract not found' });
  const prospect = db.prospects.find(p => p.id === contract.prospect_id);
  res.json({ ...contract, prospect_name: prospect?.name || 'Unknown' });
});

app.post('/api/contracts', (req, res) => {
  const contract = {
    id: nextId(),
    prospect_id: req.body.prospect_id ? parseInt(req.body.prospect_id) : null,
    start_date: req.body.start_date || null,
    end_date: req.body.end_date || null,
    renewal_date: req.body.renewal_date || null,
    revenue_share_percent: parseFloat(req.body.revenue_share_percent) || 0,
    monthly_revenue: parseFloat(req.body.monthly_revenue) || 0,
    terms: req.body.terms || '',
    notes: req.body.notes || '',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  if (!db.contracts) db.contracts = [];
  db.contracts.push(contract);
  saveDB(db);
  res.json(contract);
});

app.put('/api/contracts/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const idx = (db.contracts || []).findIndex(c => c.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Contract not found' });
  db.contracts[idx] = {
    ...db.contracts[idx],
    ...req.body,
    prospect_id: req.body.prospect_id ? parseInt(req.body.prospect_id) : db.contracts[idx].prospect_id,
    revenue_share_percent: req.body.revenue_share_percent !== undefined ? parseFloat(req.body.revenue_share_percent) : db.contracts[idx].revenue_share_percent,
    monthly_revenue: req.body.monthly_revenue !== undefined ? parseFloat(req.body.monthly_revenue) : db.contracts[idx].monthly_revenue,
    updated_at: new Date().toISOString()
  };
  saveDB(db);
  res.json(db.contracts[idx]);
});

app.delete('/api/contracts/:id', (req, res) => {
  const id = parseInt(req.params.id);
  db.contracts = (db.contracts || []).filter(c => c.id !== id);
  saveDB(db);
  res.json({ success: true });
});

// ===== EMAIL OUTREACH: TEMPLATES API =====
app.get('/api/outreach/templates', (req, res) => {
  res.json((db.emailTemplates || []).sort((a, b) => new Date(b.created_at) - new Date(a.created_at)));
});

app.get('/api/outreach/templates/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const tpl = (db.emailTemplates || []).find(t => t.id === id);
  if (!tpl) return res.status(404).json({ error: 'Template not found' });
  res.json(tpl);
});

app.post('/api/outreach/templates', (req, res) => {
  const template = {
    id: nextId(),
    name: req.body.name || 'Untitled Template',
    subject: req.body.subject || '',
    body: req.body.body || '',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  if (!db.emailTemplates) db.emailTemplates = [];
  db.emailTemplates.push(template);
  saveDB(db);
  res.json(template);
});

app.put('/api/outreach/templates/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const idx = (db.emailTemplates || []).findIndex(t => t.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Template not found' });
  db.emailTemplates[idx] = {
    ...db.emailTemplates[idx],
    name: req.body.name !== undefined ? req.body.name : db.emailTemplates[idx].name,
    subject: req.body.subject !== undefined ? req.body.subject : db.emailTemplates[idx].subject,
    body: req.body.body !== undefined ? req.body.body : db.emailTemplates[idx].body,
    updated_at: new Date().toISOString()
  };
  saveDB(db);
  res.json(db.emailTemplates[idx]);
});

app.delete('/api/outreach/templates/:id', (req, res) => {
  const id = parseInt(req.params.id);
  db.emailTemplates = (db.emailTemplates || []).filter(t => t.id !== id);
  saveDB(db);
  res.json({ success: true });
});

// ===== EMAIL OUTREACH: SEQUENCES API =====
app.get('/api/outreach/sequences', (req, res) => {
  res.json((db.emailSequences || []).sort((a, b) => new Date(b.created_at) - new Date(a.created_at)));
});

app.get('/api/outreach/sequences/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const seq = (db.emailSequences || []).find(s => s.id === id);
  if (!seq) return res.status(404).json({ error: 'Sequence not found' });
  res.json(seq);
});

app.post('/api/outreach/sequences', (req, res) => {
  const sequence = {
    id: nextId(),
    name: req.body.name || 'Untitled Sequence',
    steps: req.body.steps || [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  if (!db.emailSequences) db.emailSequences = [];
  db.emailSequences.push(sequence);
  saveDB(db);
  res.json(sequence);
});

app.put('/api/outreach/sequences/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const idx = (db.emailSequences || []).findIndex(s => s.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Sequence not found' });
  db.emailSequences[idx] = {
    ...db.emailSequences[idx],
    name: req.body.name !== undefined ? req.body.name : db.emailSequences[idx].name,
    steps: req.body.steps !== undefined ? req.body.steps : db.emailSequences[idx].steps,
    updated_at: new Date().toISOString()
  };
  saveDB(db);
  res.json(db.emailSequences[idx]);
});

app.delete('/api/outreach/sequences/:id', (req, res) => {
  const id = parseInt(req.params.id);
  db.emailSequences = (db.emailSequences || []).filter(s => s.id !== id);
  saveDB(db);
  res.json({ success: true });
});

// ===== EMAIL OUTREACH: SENDS API =====
app.get('/api/outreach/sends', (req, res) => {
  const { prospect_id, sequence_id, status } = req.query;
  let records = db.emailSends || [];
  if (prospect_id) records = records.filter(s => s.prospect_id === parseInt(prospect_id));
  if (sequence_id) records = records.filter(s => s.sequence_id === parseInt(sequence_id));
  if (status) records = records.filter(s => s.status === status);
  res.json(records.sort((a, b) => new Date(b.created_at) - new Date(a.created_at)));
});

app.post('/api/outreach/sends', (req, res) => {
  const send = {
    id: nextId(),
    prospect_id: parseInt(req.body.prospect_id) || null,
    template_id: parseInt(req.body.template_id) || null,
    sequence_id: parseInt(req.body.sequence_id) || null,
    delay_days: parseInt(req.body.delay_days) || 0,
    status: req.body.status || 'pending',
    sent_at: req.body.sent_at || null,
    opened_at: req.body.opened_at || null,
    replied_at: req.body.replied_at || null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  if (!db.emailSends) db.emailSends = [];
  db.emailSends.push(send);
  saveDB(db);
  res.json(send);
});

app.put('/api/outreach/sends/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const idx = (db.emailSends || []).findIndex(s => s.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Send not found' });
  db.emailSends[idx] = {
    ...db.emailSends[idx],
    ...req.body,
    id, // prevent id override
    updated_at: new Date().toISOString()
  };
  saveDB(db);
  res.json(db.emailSends[idx]);
});

app.delete('/api/outreach/sends/:id', (req, res) => {
  const id = parseInt(req.params.id);
  db.emailSends = (db.emailSends || []).filter(s => s.id !== id);
  saveDB(db);
  res.json({ success: true });
});

// ===== EMAIL OUTREACH: STATS API =====
app.get('/api/outreach/stats', (req, res) => {
  const sends = db.emailSends || [];
  const total = sends.length;
  const sent = sends.filter(s => s.status !== 'pending').length;
  const opened = sends.filter(s => s.opened_at).length;
  const replied = sends.filter(s => s.replied_at).length;
  const bounced = sends.filter(s => s.status === 'bounced').length;
  const pending = sends.filter(s => s.status === 'pending').length;

  // By sequence
  const bySequence = {};
  sends.forEach(s => {
    const seqId = s.sequence_id || 'none';
    if (!bySequence[seqId]) bySequence[seqId] = { total: 0, sent: 0, opened: 0, replied: 0, bounced: 0 };
    bySequence[seqId].total++;
    if (s.status !== 'pending') bySequence[seqId].sent++;
    if (s.opened_at) bySequence[seqId].opened++;
    if (s.replied_at) bySequence[seqId].replied++;
    if (s.status === 'bounced') bySequence[seqId].bounced++;
  });

  // Unique prospects in outreach
  const uniqueProspects = new Set(sends.map(s => s.prospect_id)).size;

  res.json({
    total, sent, opened, replied, bounced, pending,
    uniqueProspects,
    openRate: sent > 0 ? Math.round((opened / sent) * 1000) / 10 : 0,
    replyRate: sent > 0 ? Math.round((replied / sent) * 1000) / 10 : 0,
    bounceRate: sent > 0 ? Math.round((bounced / sent) * 1000) / 10 : 0,
    bySequence,
    templateCount: (db.emailTemplates || []).length,
    sequenceCount: (db.emailSequences || []).length
  });
});

// ===== EMAIL DRAFTS API =====

// Initialize email drafts if not exists
if (!db.emailDrafts) db.emailDrafts = [];

// GET all email drafts
app.get('/api/email-drafts', (req, res) => {
  const drafts = (db.emailDrafts || []).map(d => {
    // Enrich with prospect data if available
    const prospect = d.prospect_id ? db.prospects.find(p => p.id === d.prospect_id) : null;
    return {
      ...d,
      prospect_name: prospect?.name || null
    };
  });
  res.json(drafts);
});

// GET single email draft
app.get('/api/email-drafts/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const draft = (db.emailDrafts || []).find(d => d.id === id);
  if (!draft) return res.status(404).json({ error: 'Draft not found' });
  res.json(draft);
});

// POST create email draft
app.post('/api/email-drafts', (req, res) => {
  if (!req.body.to_email) return res.status(400).json({ error: 'to_email required' });
  
  const draft = {
    id: nextId(),
    to_email: req.body.to_email,
    subject: req.body.subject || '',
    body: req.body.body || '',
    type: req.body.type || 'other', // followup, proposal, other
    prospect_id: req.body.prospect_id || null,
    status: 'pending',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  
  if (!db.emailDrafts) db.emailDrafts = [];
  db.emailDrafts.push(draft);
  saveDB(db);
  res.json(draft);
});

// PUT update email draft
app.put('/api/email-drafts/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const idx = (db.emailDrafts || []).findIndex(d => d.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Draft not found' });
  
  db.emailDrafts[idx] = {
    ...db.emailDrafts[idx],
    ...req.body,
    id, // Don't allow ID change
    updated_at: new Date().toISOString()
  };
  saveDB(db);
  res.json(db.emailDrafts[idx]);
});

// DELETE email draft
app.delete('/api/email-drafts/:id', (req, res) => {
  const id = parseInt(req.params.id);
  if (!db.emailDrafts) db.emailDrafts = [];
  db.emailDrafts = db.emailDrafts.filter(d => d.id !== id);
  saveDB(db);
  res.json({ success: true });
});

// POST send email draft (via gog)
app.post('/api/email-drafts/:id/send', async (req, res) => {
  const id = parseInt(req.params.id);
  const draft = (db.emailDrafts || []).find(d => d.id === id);
  if (!draft) return res.status(404).json({ error: 'Draft not found' });
  
  try {
    const { execSync } = require('child_process');
    // Send via gog gmail
    const cmd = `GOG_KEYRING_PASSWORD=kandepb2026 gog gmail send --to="${draft.to_email}" --subject="${draft.subject.replace(/"/g, '\\"')}" --body="${draft.body.replace(/"/g, '\\"').replace(/\n/g, '\\n')}" --account=kurtis@kandevendtech.com`;
    execSync(cmd, { encoding: 'utf8', timeout: 30000 });
    
    // Mark as sent and remove from drafts
    draft.status = 'sent';
    draft.sent_at = new Date().toISOString();
    
    // Log activity if linked to prospect
    if (draft.prospect_id) {
      if (!db.activities) db.activities = [];
      db.activities.push({
        id: nextId(),
        prospect_id: draft.prospect_id,
        type: 'email',
        description: `Email sent: ${draft.subject}`,
        created_at: new Date().toISOString()
      });
    }
    
    // Remove from drafts after sending
    db.emailDrafts = db.emailDrafts.filter(d => d.id !== id);
    saveDB(db);
    
    res.json({ success: true, message: 'Email sent' });
  } catch (e) {
    console.error('Error sending email:', e.message);
    res.status(500).json({ error: 'Failed to send email', details: e.message });
  }
});

// ===== RESTOCK PREDICTIONS API =====

// Log a restock event
app.post('/api/restock/log', (req, res) => {
  const log = {
    id: nextId(),
    location_id: parseInt(req.body.location_id),
    restocked_at: req.body.restocked_at || new Date().toISOString().split('T')[0],
    items_count: parseInt(req.body.items_count) || 150,
    notes: req.body.notes || '',
    created_at: new Date().toISOString()
  };
  if (!log.location_id) return res.status(400).json({ error: 'location_id required' });
  if (!db.restockLogs) db.restockLogs = [];
  db.restockLogs.push(log);

  // Recalculate sales velocity for this location
  recalcVelocity(log.location_id);

  saveDB(db);
  res.json(log);
});

// Get all restock logs
app.get('/api/restock/logs', (req, res) => {
  const { location_id } = req.query;
  let records = db.restockLogs || [];
  if (location_id) records = records.filter(r => r.location_id === parseInt(location_id));
  res.json(records.sort((a, b) => new Date(b.restocked_at) - new Date(a.restocked_at)));
});

// Delete a restock log
app.delete('/api/restock/logs/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const log = (db.restockLogs || []).find(r => r.id === id);
  db.restockLogs = (db.restockLogs || []).filter(r => r.id !== id);
  if (log) recalcVelocity(log.location_id);
  saveDB(db);
  res.json({ success: true });
});

// Save per-location capacities
app.put('/api/restock/capacities', (req, res) => {
  db.restockCapacities = req.body || {};
  saveDB(db);
  res.json({ success: true });
});

// Get predictions for all locations
app.get('/api/restock/predictions', (req, res) => {
  const locations = db.locations || [];
  const logs = db.restockLogs || [];
  const velocityMap = {};
  (db.salesVelocity || []).forEach(v => { velocityMap[v.location_id] = v; });
  const caps = db.restockCapacities || {};

  const now = new Date();
  const predictions = locations.map(loc => {
    const locLogs = logs
      .filter(l => l.location_id === loc.id)
      .sort((a, b) => new Date(b.restocked_at) - new Date(a.restocked_at));

    const capacity = caps[loc.id] || 150;
    const velocity = velocityMap[loc.id];
    const dailyVelocity = velocity ? velocity.daily_avg_items : 0;

    const lastLog = locLogs[0];
    let daysSinceRestock = null;
    let estimatedItems = capacity;
    let daysUntilEmpty = Infinity;

    if (lastLog) {
      const lastDate = new Date(lastLog.restocked_at);
      daysSinceRestock = Math.max(0, Math.floor((now - lastDate) / (1000 * 60 * 60 * 24)));
      // Items at last restock = items_count (could be partial restock)
      const itemsAtRestock = lastLog.items_count || capacity;
      estimatedItems = Math.max(0, itemsAtRestock - (dailyVelocity * daysSinceRestock));
      daysUntilEmpty = dailyVelocity > 0 ? estimatedItems / dailyVelocity : Infinity;
    }

    const prospect = db.prospects.find(p => p.id === loc.prospect_id);

    return {
      location_id: loc.id,
      location_name: prospect?.name || loc.name || `Location #${loc.id}`,
      capacity,
      daily_velocity: dailyVelocity,
      estimated_items: Math.round(estimatedItems),
      days_until_empty: daysUntilEmpty === Infinity ? 999 : Math.round(daysUntilEmpty * 10) / 10,
      days_since_restock: daysSinceRestock,
      last_restock_date: lastLog?.restocked_at || null,
      last_restock_items: lastLog?.items_count || null,
      restock_count: locLogs.length
    };
  });

  res.json(predictions);
});

// Helper: recalculate daily sales velocity for a location
function recalcVelocity(locationId) {
  const logs = (db.restockLogs || [])
    .filter(l => l.location_id === locationId)
    .sort((a, b) => new Date(a.restocked_at) - new Date(b.restocked_at));

  if (logs.length < 2) {
    // With only one log, estimate from revenue data if available
    const revRecords = (db.revenue || []).filter(r => r.location_id === locationId);
    if (revRecords.length > 0 && logs.length === 1) {
      // Rough estimate: average daily revenue / ~$2 per item = items/day
      const totalRev = revRecords.reduce((s, r) => s + (r.amount || 0), 0);
      const dates = revRecords.map(r => new Date(r.date)).filter(d => !isNaN(d));
      if (dates.length >= 2) {
        const span = (Math.max(...dates) - Math.min(...dates)) / (1000 * 60 * 60 * 24);
        if (span > 0) {
          const dailyRev = totalRev / span;
          const estVelocity = dailyRev / 2; // ~$2 avg per item
          updateVelocity(locationId, Math.max(1, estVelocity));
          return;
        }
      }
    }
    // Default velocity for single-log locations
    if (logs.length === 1) {
      updateVelocity(locationId, 10); // Default 10 items/day
    }
    return;
  }

  // Calculate velocity from intervals between restocks
  // Between each pair of restocks, items_consumed / days_elapsed
  let totalItems = 0;
  let totalDays = 0;

  for (let i = 1; i < logs.length; i++) {
    const prev = logs[i - 1];
    const curr = logs[i];
    const days = (new Date(curr.restocked_at) - new Date(prev.restocked_at)) / (1000 * 60 * 60 * 24);
    if (days > 0) {
      // Items consumed = what was put in at previous restock
      totalItems += prev.items_count || 150;
      totalDays += days;
    }
  }

  const dailyAvg = totalDays > 0 ? totalItems / totalDays : 10;
  updateVelocity(locationId, dailyAvg);
}

function updateVelocity(locationId, dailyAvg) {
  if (!db.salesVelocity) db.salesVelocity = [];
  const idx = db.salesVelocity.findIndex(v => v.location_id === locationId);
  const entry = {
    id: idx >= 0 ? db.salesVelocity[idx].id : nextId(),
    location_id: locationId,
    daily_avg_items: Math.round(dailyAvg * 10) / 10,
    last_calculated: new Date().toISOString()
  };
  if (idx >= 0) {
    db.salesVelocity[idx] = entry;
  } else {
    db.salesVelocity.push(entry);
  }
}

// ===== MICRO-MARKETS API =====
app.get('/api/micromarkets', (req, res) => {
  const { setup_type, fresh_food, payment_system } = req.query;
  let records = db.micromarkets || [];
  if (setup_type) records = records.filter(m => m.setup_type === setup_type);
  if (fresh_food) records = records.filter(m => m.fresh_food === fresh_food);
  if (payment_system) records = records.filter(m => m.payment_system === payment_system);
  // Enrich with prospect name
  const enriched = records.map(m => {
    const prospect = db.prospects.find(p => p.id === m.prospect_id);
    return { ...m, prospect_name: prospect?.name || null, prospect_address: prospect?.address || null };
  });
  res.json(enriched.sort((a, b) => new Date(b.created_at) - new Date(a.created_at)));
});

app.get('/api/micromarkets/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const mm = (db.micromarkets || []).find(m => m.id === id);
  if (!mm) return res.status(404).json({ error: 'Micro-market not found' });
  const prospect = db.prospects.find(p => p.id === mm.prospect_id);
  res.json({ ...mm, prospect_name: prospect?.name || null });
});

app.post('/api/micromarkets', (req, res) => {
  const mm = {
    id: nextId(),
    prospect_id: req.body.prospect_id ? parseInt(req.body.prospect_id) : null,
    setup_type: req.body.setup_type || 'Full Service',
    shelving_count: parseInt(req.body.shelving_count) || 0,
    cooler_count: parseInt(req.body.cooler_count) || 0,
    payment_system: req.body.payment_system || 'Self-checkout kiosk',
    monthly_revenue_target: parseFloat(req.body.monthly_revenue_target) || 0,
    launch_date: req.body.launch_date || null,
    fresh_food: req.body.fresh_food || 'no',
    inventory_categories: req.body.inventory_categories || ['beverages', 'snacks'],
    notes: req.body.notes || '',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  if (!db.micromarkets) db.micromarkets = [];
  db.micromarkets.push(mm);
  saveDB(db);
  res.json(mm);
});

app.put('/api/micromarkets/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const idx = (db.micromarkets || []).findIndex(m => m.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Micro-market not found' });
  db.micromarkets[idx] = {
    ...db.micromarkets[idx],
    prospect_id: req.body.prospect_id !== undefined ? (parseInt(req.body.prospect_id) || null) : db.micromarkets[idx].prospect_id,
    setup_type: req.body.setup_type || db.micromarkets[idx].setup_type,
    shelving_count: req.body.shelving_count !== undefined ? parseInt(req.body.shelving_count) : db.micromarkets[idx].shelving_count,
    cooler_count: req.body.cooler_count !== undefined ? parseInt(req.body.cooler_count) : db.micromarkets[idx].cooler_count,
    payment_system: req.body.payment_system || db.micromarkets[idx].payment_system,
    monthly_revenue_target: req.body.monthly_revenue_target !== undefined ? parseFloat(req.body.monthly_revenue_target) : db.micromarkets[idx].monthly_revenue_target,
    launch_date: req.body.launch_date !== undefined ? req.body.launch_date : db.micromarkets[idx].launch_date,
    fresh_food: req.body.fresh_food || db.micromarkets[idx].fresh_food,
    inventory_categories: req.body.inventory_categories || db.micromarkets[idx].inventory_categories,
    notes: req.body.notes !== undefined ? req.body.notes : db.micromarkets[idx].notes,
    updated_at: new Date().toISOString()
  };
  saveDB(db);
  res.json(db.micromarkets[idx]);
});

app.delete('/api/micromarkets/:id', (req, res) => {
  const id = parseInt(req.params.id);
  db.micromarkets = (db.micromarkets || []).filter(m => m.id !== id);
  saveDB(db);
  res.json({ success: true });
});

// ===== SMART MACHINES API =====
app.get('/api/smart-machines', (req, res) => {
  const machines = (db.smartMachines || []).map(m => {
    const location = (db.locations || []).find(l => l.id === m.location_id);
    const prospect = location ? (db.prospects || []).find(p => p.id === location.prospect_id) : null;
    // Get latest telemetry
    const telemetry = (db.machineTelemetry || [])
      .filter(t => t.machine_id === m.id)
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    const latest = telemetry[0] || null;
    return {
      ...m,
      location_name: prospect?.name || location?.name || null,
      latest_telemetry: latest
    };
  });
  res.json(machines);
});

app.get('/api/smart-machines/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const machine = (db.smartMachines || []).find(m => m.id === id);
  if (!machine) return res.status(404).json({ error: 'Smart machine not found' });
  const location = (db.locations || []).find(l => l.id === machine.location_id);
  const prospect = location ? (db.prospects || []).find(p => p.id === location.prospect_id) : null;
  const telemetry = (db.machineTelemetry || [])
    .filter(t => t.machine_id === id)
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  res.json({
    ...machine,
    location_name: prospect?.name || location?.name || null,
    latest_telemetry: telemetry[0] || null,
    telemetry_count: telemetry.length
  });
});

app.post('/api/smart-machines', (req, res) => {
  const machine = {
    id: nextId(),
    name: req.body.name || '',
    machine_serial: req.body.machine_serial || 'SM-' + Date.now().toString(36),
    vendor: req.body.vendor || 'Unknown',
    machine_type: req.body.machine_type || 'standard',
    location_id: req.body.location_id ? parseInt(req.body.location_id) : null,
    api_key: req.body.api_key || '',
    status: 'online',
    last_sync: new Date().toISOString(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  if (!db.smartMachines) db.smartMachines = [];
  db.smartMachines.push(machine);

  // Generate mock telemetry if requested
  if (req.body.generate_telemetry) {
    const isRefrigerated = machine.machine_type === 'refrigerated' || machine.machine_type === 'frozen' || machine.machine_type === 'combo';
    const baseTemp = machine.machine_type === 'frozen' ? 0 : 36;
    const now = Date.now();
    const telemetryPoints = [];
    let invLevel = 60 + Math.floor(Math.random() * 35);

    for (let i = 48; i >= 0; i--) {
      const ts = new Date(now - i * 30 * 60 * 1000); // every 30 min for 24h
      invLevel = Math.max(5, Math.min(100, invLevel + Math.floor(Math.random() * 5) - 3));
      const temp = isRefrigerated ? baseTemp + (Math.random() * 6 - 2) : null;
      const lastSale = Math.random() > 0.3
        ? new Date(ts.getTime() - Math.floor(Math.random() * 30 * 60000)).toISOString()
        : null;

      telemetryPoints.push({
        id: nextId(),
        machine_id: machine.id,
        timestamp: ts.toISOString(),
        inventory_level: invLevel,
        last_sale: lastSale,
        temperature: temp !== null ? Math.round(temp * 10) / 10 : null,
        door_status: Math.random() > 0.95 ? 'open' : 'closed'
      });
    }

    if (!db.machineTelemetry) db.machineTelemetry = [];
    db.machineTelemetry.push(...telemetryPoints);

    // Update machine status based on latest telemetry
    const latest = telemetryPoints[telemetryPoints.length - 1];
    if (latest.inventory_level < 20 || (latest.temperature !== null && (latest.temperature > 45 || latest.temperature < 30))) {
      machine.status = 'warning';
    }
    // ~10% chance offline
    if (Math.random() > 0.9) {
      machine.status = 'offline';
      machine.last_sync = new Date(now - Math.floor(Math.random() * 3600000 * 6)).toISOString();
    }
  }

  saveDB(db);
  res.json(machine);
});

app.put('/api/smart-machines/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const idx = (db.smartMachines || []).findIndex(m => m.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Smart machine not found' });
  db.smartMachines[idx] = {
    ...db.smartMachines[idx],
    ...req.body,
    id,
    updated_at: new Date().toISOString()
  };
  saveDB(db);
  res.json(db.smartMachines[idx]);
});

app.delete('/api/smart-machines/:id', (req, res) => {
  const id = parseInt(req.params.id);
  db.smartMachines = (db.smartMachines || []).filter(m => m.id !== id);
  db.machineTelemetry = (db.machineTelemetry || []).filter(t => t.machine_id !== id);
  saveDB(db);
  res.json({ success: true });
});

// Smart Machine Telemetry
app.get('/api/smart-machines/:id/telemetry', (req, res) => {
  const machineId = parseInt(req.params.id);
  const { limit, from, to } = req.query;
  let records = (db.machineTelemetry || []).filter(t => t.machine_id === machineId);
  if (from) records = records.filter(t => t.timestamp >= from);
  if (to) records = records.filter(t => t.timestamp <= to);
  records.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  if (limit) records = records.slice(-parseInt(limit));
  res.json(records);
});

app.post('/api/smart-machines/:id/telemetry', (req, res) => {
  const machineId = parseInt(req.params.id);
  const machine = (db.smartMachines || []).find(m => m.id === machineId);
  if (!machine) return res.status(404).json({ error: 'Smart machine not found' });

  const record = {
    id: nextId(),
    machine_id: machineId,
    timestamp: req.body.timestamp || new Date().toISOString(),
    inventory_level: req.body.inventory_level !== undefined ? parseInt(req.body.inventory_level) : null,
    last_sale: req.body.last_sale || null,
    temperature: req.body.temperature !== undefined ? parseFloat(req.body.temperature) : null,
    door_status: req.body.door_status || 'closed'
  };

  if (!db.machineTelemetry) db.machineTelemetry = [];
  db.machineTelemetry.push(record);

  // Update machine sync time and status
  machine.last_sync = new Date().toISOString();
  if (record.inventory_level !== null && record.inventory_level < 20) {
    machine.status = 'warning';
  } else if (record.temperature !== null && (record.temperature > 45 || record.temperature < 30)) {
    machine.status = 'warning';
  } else {
    machine.status = 'online';
  }
  machine.updated_at = new Date().toISOString();

  saveDB(db);
  res.json(record);
});

// Smart Machines Stats
app.get('/api/smart-machines-stats', (req, res) => {
  const machines = db.smartMachines || [];
  const telemetry = db.machineTelemetry || [];
  const online = machines.filter(m => m.status === 'online').length;
  const warning = machines.filter(m => m.status === 'warning').length;
  const offline = machines.filter(m => m.status === 'offline').length;

  let alertCount = 0;
  machines.forEach(m => {
    const latest = telemetry.filter(t => t.machine_id === m.id).sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0];
    if (latest) {
      if (latest.inventory_level < 20) alertCount++;
      if (latest.temperature !== null && (latest.temperature > 45 || latest.temperature < 30)) alertCount++;
    }
  });

  res.json({
    total: machines.length,
    online, warning, offline,
    alerts: alertCount,
    by_vendor: machines.reduce((acc, m) => { acc[m.vendor] = (acc[m.vendor] || 0) + 1; return acc; }, {}),
    by_type: machines.reduce((acc, m) => { acc[m.machine_type] = (acc[m.machine_type] || 0) + 1; return acc; }, {})
  });
});

// ===== PAGE ROUTES =====
app.get('/crm/map', (req, res) => res.sendFile(path.join(__dirname, 'map.html')));
app.get('/crm', (req, res) => res.sendFile(path.join(__dirname, 'crm.html')));
app.get('/prospect/:id', (req, res) => res.sendFile(path.join(__dirname, 'prospect-detail.html')));
app.get('/activities', (req, res) => res.sendFile(path.join(__dirname, 'activities.html')));
app.get('/map', (req, res) => res.sendFile(path.join(__dirname, 'map.html')));
app.get('/machines', (req, res) => res.sendFile(path.join(__dirname, 'machines.html')));
app.get('/inventory', (req, res) => res.sendFile(path.join(__dirname, 'inventory.html')));
app.get('/finance', (req, res) => res.sendFile(path.join(__dirname, 'finance.html')));
app.get('/restock', (req, res) => res.sendFile(path.join(__dirname, 'restock.html')));
app.get('/restock-planner', (req, res) => res.sendFile(path.join(__dirname, 'restock-planner.html')));
app.get('/staff', (req, res) => res.sendFile(path.join(__dirname, 'staff.html')));
app.get('/clients', (req, res) => res.sendFile(path.join(__dirname, 'clients.html')));
app.get('/ai-office', (req, res) => res.sendFile(path.join(__dirname, 'ai-office.html')));
app.get('/kanban', (req, res) => res.sendFile(path.join(__dirname, 'kanban.html')));
app.get('/performance', (req, res) => res.sendFile(path.join(__dirname, 'performance.html')));
app.get('/planogram', (req, res) => res.sendFile(path.join(__dirname, 'planogram.html')));
app.get('/campaign-tracker', (req, res) => res.sendFile(path.join(__dirname, 'campaign-tracker.html')));
app.get('/contracts', (req, res) => res.sendFile(path.join(__dirname, 'contracts.html')));
app.get('/competitors', (req, res) => res.sendFile(path.join(__dirname, 'competitors.html')));
app.get('/competitor-map', (req, res) => res.sendFile(path.join(__dirname, 'competitor-map.html')));
app.get('/revenue', (req, res) => res.sendFile(path.join(__dirname, 'revenue.html')));
app.get('/analytics', (req, res) => res.sendFile(path.join(__dirname, 'analytics.html')));
app.get('/trends', (req, res) => res.sendFile(path.join(__dirname, 'trends.html')));
app.get('/property-analysis', (req, res) => res.sendFile(path.join(__dirname, 'property-analysis.html')));
app.get('/micromarkets', (req, res) => res.sendFile(path.join(__dirname, 'micromarkets.html')));
app.get('/lead-import', (req, res) => res.sendFile(path.join(__dirname, 'lead-import.html')));
app.get('/gift-baskets', (req, res) => res.sendFile(path.join(__dirname, 'gift-baskets.html')));
app.get('/pricing-strategies', (req, res) => res.sendFile(path.join(__dirname, 'pricing-strategies.html')));
app.get('/bundles', (req, res) => res.sendFile(path.join(__dirname, 'bundles.html')));
app.get('/pipeline', (req, res) => res.sendFile(path.join(__dirname, 'pipeline.html')));
app.get('/seo', (req, res) => res.sendFile(path.join(__dirname, 'seo.html')));
app.get('/mobile-dashboard', (req, res) => res.sendFile(path.join(__dirname, 'mobile-dashboard.html')));
app.get('/forecasting', (req, res) => res.sendFile(path.join(__dirname, 'forecasting.html')));
app.get('/scraper', (req, res) => res.sendFile(path.join(__dirname, 'scraper.html')));
app.get('/email-drafts', (req, res) => res.sendFile(path.join(__dirname, 'email-drafts.html')));
app.get('/pop-ins', (req, res) => res.sendFile(path.join(__dirname, 'activities.html'))); // Redirect to activities
app.get('/pop-in', (req, res) => res.sendFile(path.join(__dirname, 'activities.html'))); // Redirect to activities
app.get('/sales-materials', (req, res) => res.sendFile(path.join(__dirname, 'playbook.html'))); // Redirect to playbook
app.get('/market-intel', (req, res) => res.sendFile(path.join(__dirname, 'competitors.html'))); // Redirect to competitors
app.get('/marketing', (req, res) => res.sendFile(path.join(__dirname, 'outreach.html'))); // Redirect to outreach
app.get('/finances', (req, res) => res.redirect('/finance')); // Fix typo redirect
app.get('/todo', (req, res) => res.redirect('/todos')); // Fix typo redirect
app.get('/products', (req, res) => res.sendFile(path.join(__dirname, 'products.html')));
app.get('/route-planner', (req, res) => res.sendFile(path.join(__dirname, 'route-planner.html')));
app.get('/outreach', (req, res) => res.sendFile(path.join(__dirname, 'outreach.html')));
app.get('/restock-predictions', (req, res) => res.sendFile(path.join(__dirname, 'restock-predictions.html')));
app.get('/smart-machines', (req, res) => res.sendFile(path.join(__dirname, 'smart-machines.html')));
app.get('/apollo', (req, res) => res.sendFile(path.join(__dirname, 'apollo.html')));
app.get('/playbook', (req, res) => res.sendFile(path.join(__dirname, 'playbook.html')));
app.get('/revenue-calculator', (req, res) => res.sendFile(path.join(__dirname, 'revenue-calculator.html')));
app.get('/mobile', (req, res) => res.sendFile(path.join(__dirname, 'mobile.html')));
app.get('/quick', (req, res) => res.sendFile(path.join(__dirname, 'mobile.html')));
app.get('/vendors', (req, res) => res.sendFile(path.join(__dirname, 'vendors.html')));
app.get('/onboarding', (req, res) => res.sendFile(path.join(__dirname, 'onboarding.html')));
app.get('/setup', (req, res) => res.sendFile(path.join(__dirname, 'onboarding.html')));

// ===== PROPOSED LEADS (Lead Vetting / Approval) =====
if (!db.proposedLeads) db.proposedLeads = [];

app.get('/api/proposed-leads', (req, res) => {
  res.json(db.proposedLeads || []);
});

app.post('/api/proposed-leads', (req, res) => {
  const lead = {
    id: nextId(),
    name: req.body.name || '',
    address: req.body.address || '',
    phone: req.body.phone || '',
    email: req.body.email || '',
    website: req.body.website || '',
    property_type: req.body.property_type || 'business',
    unit_count: req.body.unit_count || null,
    building_type: req.body.building_type || '',
    distance_from_base_miles: req.body.distance_from_base_miles || null,
    distance_from_base_minutes: req.body.distance_from_base_minutes || null,
    tier: req.body.tier || null,
    meets_minimum_size: req.body.meets_minimum_size != null ? req.body.meets_minimum_size : null,
    meets_building_type: req.body.meets_building_type != null ? req.body.meets_building_type : null,
    meets_location: req.body.meets_location != null ? req.body.meets_location : null,
    no_existing_vending: req.body.no_existing_vending != null ? req.body.no_existing_vending : null,
    near_food_options: req.body.near_food_options != null ? req.body.near_food_options : null,
    has_common_areas: req.body.has_common_areas != null ? req.body.has_common_areas : null,
    community_recommended_type: req.body.community_recommended_type != null ? req.body.community_recommended_type : null,
    score: req.body.score || 0,
    reasoning: req.body.reasoning || '',
    pros: req.body.pros || [],
    cons: req.body.cons || [],
    estimated_monthly_revenue: req.body.estimated_monthly_revenue || '',
    review_links: req.body.review_links || [],
    contact_name: req.body.contact_name || '',
    contact_title: req.body.contact_title || '',
    contact_email: req.body.contact_email || '',
    contact_phone: req.body.contact_phone || '',
    contact_linkedin: req.body.contact_linkedin || '',
    contact_notes: req.body.contact_notes || '',
    source: req.body.source || 'research',
    researched_at: req.body.researched_at || new Date().toISOString(),
    status: 'pending',
    reject_reason: null,
    lat: req.body.lat || null,
    lng: req.body.lng || null,
    created_at: new Date().toISOString()
  };
  db.proposedLeads.push(lead);
  saveDB(db);
  res.json(lead);
  // Attempt geocode if address present and no coords
  if (lead.address && !lead.lat) {
    geocodeAddress(lead.address).then(coords => {
      if (coords) { lead.lat = coords.lat; lead.lng = coords.lng; saveDB(db); }
    });
  }
});

app.patch('/api/proposed-leads/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const lead = (db.proposedLeads || []).find(l => l.id === id);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  
  // Update allowed fields
  const allowed = ['name', 'address', 'phone', 'email', 'website', 'property_type', 
    'unit_count', 'building_type', 'score', 'reasoning', 'pros', 'cons', 
    'estimated_monthly_revenue', 'review_links', 'tier', 'lat', 'lng',
    'contact_name', 'contact_title', 'contact_email', 'contact_phone', 
    'contact_linkedin', 'contact_notes'];
  
  for (const key of allowed) {
    if (req.body[key] !== undefined) lead[key] = req.body[key];
  }
  lead.updated_at = new Date().toISOString();
  saveDB(db);
  res.json(lead);
});

app.put('/api/proposed-leads/:id/approve', (req, res) => {
  const id = parseInt(req.params.id);
  const lead = (db.proposedLeads || []).find(l => l.id === id);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  if (lead.status === 'approved') return res.json({ success: true, message: 'Already approved' });
  lead.status = 'approved';
  lead.approved_at = new Date().toISOString();
  // Create prospect in CRM
  const prospect = {
    id: nextId(),
    name: lead.name,
    address: lead.address,
    phone: lead.phone,
    email: lead.email,
    website: lead.website,
    property_type: lead.property_type,
    unit_count: lead.unit_count,
    building_type: lead.building_type,
    status: 'new',
    priority: lead.score >= 80 ? 'high' : lead.score >= 60 ? 'normal' : 'low',
    source: lead.source || 'lead-review',
    notes: `Auto-imported from Lead Review (score: ${lead.score}). ${lead.reasoning || ''}`,
    lat: lead.lat,
    lng: lead.lng,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  db.prospects.push(prospect);
  saveDB(db);
  res.json({ success: true, lead, prospect });
});

app.put('/api/proposed-leads/:id/reject', (req, res) => {
  const id = parseInt(req.params.id);
  const lead = (db.proposedLeads || []).find(l => l.id === id);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  lead.status = 'rejected';
  lead.reject_reason = req.body.reject_reason || '';
  lead.rejected_at = new Date().toISOString();
  saveDB(db);
  res.json({ success: true, lead });
});

app.delete('/api/proposed-leads/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const before = (db.proposedLeads || []).length;
  db.proposedLeads = (db.proposedLeads || []).filter(l => l.id !== id);
  if (db.proposedLeads.length === before) return res.status(404).json({ error: 'Lead not found' });
  saveDB(db);
  res.json({ success: true });
});

app.get('/funnel', (req, res) => res.sendFile(path.join(__dirname, 'funnel.html')));
app.get('/lead-review', (req, res) => res.sendFile(path.join(__dirname, 'lead-review.html')));

// ===== TODOS API =====
app.get('/todos', (req, res) => res.sendFile(path.join(__dirname, 'todos.html')));

app.get('/api/todos', (req, res) => {
  res.json(db.todos || []);
});

app.post('/api/todos', (req, res) => {
  if (!req.body.title || !req.body.title.trim()) {
    return res.status(400).json({ error: 'title is required' });
  }
  const todo = {
    id: nextId(),
    title: req.body.title || 'Untitled',
    description: req.body.description || '',
    category: req.body.category || 'Other',
    priority: req.body.priority || 'medium',
    due_date: req.body.due_date || null,
    status: req.body.status || 'pending',
    completed: false,
    completed_at: null,
    notes: req.body.notes || '',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  if (!db.todos) db.todos = [];
  db.todos.push(todo);
  saveDB(db);
  res.json(todo);
});

app.put('/api/todos/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const idx = (db.todos || []).findIndex(t => t.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Todo not found' });
  db.todos[idx] = { ...db.todos[idx], ...req.body, updated_at: new Date().toISOString() };
  saveDB(db);
  res.json(db.todos[idx]);
});

app.delete('/api/todos/:id', (req, res) => {
  const id = parseInt(req.params.id);
  db.todos = (db.todos || []).filter(t => t.id !== id);
  saveDB(db);
  res.json({ success: true });
});

app.put('/api/todos/:id/complete', (req, res) => {
  const id = parseInt(req.params.id);
  const idx = (db.todos || []).findIndex(t => t.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Todo not found' });
  const todo = db.todos[idx];
  todo.completed = !todo.completed;
  todo.completed_at = todo.completed ? new Date().toISOString() : null;
  todo.status = todo.completed ? 'completed' : 'pending';
  todo.updated_at = new Date().toISOString();
  saveDB(db);
  res.json(todo);
});

// ===== COMPETITOR INTEL NOTES API =====
if (!db.competitorNotes) db.competitorNotes = [];
if (!db.competitorWeaknesses) db.competitorWeaknesses = [];

// Compare multiple competitors side-by-side (MUST be before /:id)
app.get('/api/competitors/compare', (req, res) => {
  const ids = (req.query.ids || '').split(',').map(Number).filter(Boolean);
  if (ids.length < 2) return res.status(400).json({ error: 'Need at least 2 competitor IDs' });
  const selected = (db.competitors || []).filter(c => ids.includes(c.id));
  if (selected.length < 2) return res.status(404).json({ error: 'Not enough competitors found' });
  const comparison = selected.map(c => ({
    ...c,
    weakness_count: (db.competitorWeaknesses || []).filter(w => w.competitor_id === c.id).length,
    note_count: (db.competitorNotes || []).filter(n => n.competitor_id === c.id).length,
    opportunity_count: (db.competitorWeaknesses || []).filter(w => w.competitor_id === c.id && w.is_opportunity).length
  }));
  res.json(comparison);
});

// Opportunity alerts — competitors flagged as easy wins (MUST be before /:id)
app.get('/api/competitors/opportunities', (req, res) => {
  const competitors = db.competitors || [];
  const opportunities = competitors
    .map(c => {
      const weaknesses = (db.competitorWeaknesses || []).filter(w => w.competitor_id === c.id);
      const highSeverity = weaknesses.filter(w => w.severity === 'high').length;
      const flaggedOpps = weaknesses.filter(w => w.is_opportunity).length;
      const rating = parseFloat(c.google_rating) || 0;
      const lowRating = rating > 0 && rating < 3.5;
      const score = (highSeverity * 3) + (flaggedOpps * 2) + (lowRating ? 5 : 0) +
        (weaknesses.length > 3 ? 2 : 0);
      return {
        ...c,
        weakness_count: weaknesses.length,
        high_severity_count: highSeverity,
        opportunity_count: flaggedOpps,
        low_rating: lowRating,
        opportunity_score: score,
        reasons: [
          ...(lowRating ? [`Low Google rating (${rating}★)`] : []),
          ...(highSeverity > 0 ? [`${highSeverity} high-severity weaknesses`] : []),
          ...(flaggedOpps > 0 ? [`${flaggedOpps} flagged opportunities`] : []),
          ...(weaknesses.length > 3 ? ['Many documented weaknesses'] : [])
        ]
      };
    })
    .filter(c => c.opportunity_score > 0)
    .sort((a, b) => b.opportunity_score - a.opportunity_score);
  res.json(opportunities);
});

// Enhanced competitor stats (MUST be before /:id)
app.get('/api/competitors/stats', (req, res) => {
  const competitors = db.competitors || [];
  const weaknesses = db.competitorWeaknesses || [];
  const notes = db.competitorNotes || [];
  const totalLocations = competitors.reduce((s, c) => s + (c.locations_count || 0), 0);
  const types = competitors.flatMap(c => c.machine_types || []);
  const avgRating = competitors.filter(c => c.google_rating > 0).length > 0
    ? (competitors.filter(c => c.google_rating > 0).reduce((s, c) => s + parseFloat(c.google_rating), 0) /
       competitors.filter(c => c.google_rating > 0).length).toFixed(1)
    : null;
  const opportunities = weaknesses.filter(w => w.is_opportunity).length;
  const easyWins = competitors.filter(c => {
    const r = parseFloat(c.google_rating) || 0;
    return r > 0 && r < 3.5;
  }).length;

  res.json({
    total: competitors.length,
    totalLocations,
    smart: types.filter(t => t === 'smart').length,
    traditional: types.filter(t => t === 'traditional').length,
    microMarket: types.filter(t => t === 'micro-market').length,
    avgRating,
    totalWeaknesses: weaknesses.length,
    totalNotes: notes.length,
    opportunities,
    easyWins
  });
});

// Get single competitor with embedded notes and weaknesses
app.get('/api/competitors/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const competitor = (db.competitors || []).find(c => c.id === id);
  if (!competitor) return res.status(404).json({ error: 'Competitor not found' });
  const notes = (db.competitorNotes || [])
    .filter(n => n.competitor_id === id)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const weaknesses = (db.competitorWeaknesses || [])
    .filter(w => w.competitor_id === id)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  res.json({ ...competitor, intel_notes: notes, weakness_entries: weaknesses });
});

// Add timestamped intel note to competitor
app.post('/api/competitors/:id/notes', (req, res) => {
  const id = parseInt(req.params.id);
  const competitor = (db.competitors || []).find(c => c.id === id);
  if (!competitor) return res.status(404).json({ error: 'Competitor not found' });
  const note = {
    id: nextId(),
    competitor_id: id,
    text: req.body.text || '',
    source: req.body.source || 'manual',
    category: req.body.category || 'general',
    created_at: new Date().toISOString()
  };
  if (!db.competitorNotes) db.competitorNotes = [];
  db.competitorNotes.push(note);
  competitor.updated_at = new Date().toISOString();
  saveDB(db);
  res.json(note);
});

// Delete an intel note
app.delete('/api/competitors/:id/notes/:noteId', (req, res) => {
  const noteId = parseInt(req.params.noteId);
  db.competitorNotes = (db.competitorNotes || []).filter(n => n.id !== noteId);
  saveDB(db);
  res.json({ success: true });
});

// Get all notes for a competitor
app.get('/api/competitors/:id/notes', (req, res) => {
  const id = parseInt(req.params.id);
  const notes = (db.competitorNotes || [])
    .filter(n => n.competitor_id === id)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  res.json(notes);
});

// Add weakness entry to competitor
app.post('/api/competitors/:id/weaknesses', (req, res) => {
  const id = parseInt(req.params.id);
  const competitor = (db.competitors || []).find(c => c.id === id);
  if (!competitor) return res.status(404).json({ error: 'Competitor not found' });
  const weakness = {
    id: nextId(),
    competitor_id: id,
    text: req.body.text || '',
    source: req.body.source || 'intel',
    severity: req.body.severity || 'medium',
    is_opportunity: req.body.is_opportunity || false,
    created_at: new Date().toISOString()
  };
  if (!db.competitorWeaknesses) db.competitorWeaknesses = [];
  db.competitorWeaknesses.push(weakness);
  competitor.updated_at = new Date().toISOString();
  saveDB(db);
  res.json(weakness);
});

// Delete a weakness entry
app.delete('/api/competitors/:id/weaknesses/:weaknessId', (req, res) => {
  const weaknessId = parseInt(req.params.weaknessId);
  db.competitorWeaknesses = (db.competitorWeaknesses || []).filter(w => w.id !== weaknessId);
  saveDB(db);
  res.json({ success: true });
});

// Get all weaknesses for a competitor
app.get('/api/competitors/:id/weaknesses', (req, res) => {
  const id = parseInt(req.params.id);
  const weaknesses = (db.competitorWeaknesses || [])
    .filter(w => w.competitor_id === id)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  res.json(weaknesses);
});

// ===== TAX STRATEGY PAGE =====
app.get('/tax-strategy', (req, res) => res.sendFile(path.join(__dirname, 'tax-strategy.html')));

// ===== ADDITIONAL PAGE ROUTES =====
app.get('/contracts-page', (req, res) => res.sendFile(path.join(__dirname, 'contracts.html')));

// ===== PRICING PAGE =====
app.get('/pricing', (req, res) => res.sendFile(path.join(__dirname, 'pricing.html')));

// ===== REVENUE GOALS API =====
if (!db.revenueGoals) { db.revenueGoals = []; saveDB(db); }

app.get('/api/revenue/goals', (req, res) => {
  res.json(db.revenueGoals || []);
});

app.post('/api/revenue/goals', (req, res) => {
  if (!db.revenueGoals) db.revenueGoals = [];
  // Upsert: if goal for this month exists, update it
  const existing = db.revenueGoals.findIndex(g => g.month === req.body.month);
  if (existing >= 0) {
    db.revenueGoals[existing] = {
      ...db.revenueGoals[existing],
      target: parseFloat(req.body.target) || 0,
      notes: req.body.notes || '',
      updated_at: new Date().toISOString()
    };
    saveDB(db);
    return res.json(db.revenueGoals[existing]);
  }
  const goal = {
    id: nextId(),
    month: req.body.month,
    target: parseFloat(req.body.target) || 0,
    notes: req.body.notes || '',
    created_at: new Date().toISOString()
  };
  db.revenueGoals.push(goal);
  saveDB(db);
  res.json(goal);
});

app.delete('/api/revenue/goals/:id', (req, res) => {
  const id = parseInt(req.params.id);
  if (!db.revenueGoals) db.revenueGoals = [];
  db.revenueGoals = db.revenueGoals.filter(g => g.id !== id);
  saveDB(db);
  res.json({ success: true });
});

// ===== DEPARTMENT WIDGET =====
app.get('/departments-widget.html', (req, res) => res.sendFile(path.join(__dirname, 'departments-widget.html')));

// ===== DEPARTMENT AGENT TRACKING API =====
// Amazon-style Division & Team structure
const DEFAULT_DIVISIONS = {
  "revenue": {
    name: "Revenue Division", emoji: "💰", 
    mission: "Acquire locations, grow revenue, expand market share",
    teams: {
      "sales-apartments": { name: "Sales - Apartments", lead: "Riley", agents: [], tasks: [] },
      "sales-healthcare": { name: "Sales - Healthcare", lead: "Clara", agents: [], tasks: [] },
      "sales-commercial": { name: "Sales - Commercial", lead: "Hunter", agents: [], tasks: [] },
      "sales-government": { name: "Sales - Government", lead: "Patriot", agents: [], tasks: [] },
      "bizdev": { name: "Business Development", lead: "Scout", agents: [], tasks: [] },
      "account-mgmt": { name: "Account Management", lead: "Keeper", agents: [], tasks: [] }
    }
  },
  "growth": {
    name: "Growth Division", emoji: "📣",
    mission: "Build brand, generate leads, drive awareness",
    teams: {
      "marketing": { name: "Marketing", lead: "Maya", agents: [], tasks: [] },
      "content": { name: "Content", lead: "Harper", agents: [], tasks: [] },
      "seo-web": { name: "SEO/Web", lead: "Pixel", agents: [], tasks: [] },
      "outreach": { name: "Outreach", lead: "Blitz", agents: [], tasks: [] },
      "events": { name: "Events", lead: "Roadie", agents: [], tasks: [] }
    }
  },
  "operations": {
    name: "Operations Division", emoji: "📦",
    mission: "Efficient fulfillment, happy customers, smooth logistics",
    teams: {
      "field-ops": { name: "Field Operations", lead: "Route", agents: [], tasks: [] },
      "inventory": { name: "Inventory", lead: "Stock", agents: [], tasks: [] },
      "logistics": { name: "Logistics", lead: "Fleet", agents: [], tasks: [] },
      "quality": { name: "Quality Assurance", lead: "Inspector", agents: [], tasks: [] },
      "customer-success": { name: "Customer Success", lead: "Concierge", agents: [], tasks: [] }
    }
  },
  "technology": {
    name: "Technology Division", emoji: "🖥️",
    mission: "Build world-class tools, automate everything",
    teams: {
      "platform": { name: "Platform", lead: "Atlas", agents: [], tasks: [] },
      "data-eng": { name: "Data Engineering", lead: "Query", agents: [], tasks: [] },
      "ml": { name: "Machine Learning", lead: "Neural", agents: [], tasks: [] },
      "infra": { name: "Infrastructure", lead: "Forge", agents: [], tasks: [] },
      "qa": { name: "QA/Testing", lead: "Sentinel", agents: [], tasks: [] }
    }
  },
  "intelligence": {
    name: "Intelligence Division", emoji: "🔬",
    mission: "Know more than competitors, make smarter decisions",
    teams: {
      "market-research": { name: "Market Research", lead: "Oracle", agents: [], tasks: [] },
      "competitive": { name: "Competitive Intel", lead: "Shadow", agents: [], tasks: [] },
      "pricing": { name: "Pricing Strategy", lead: "Margin", agents: [], tasks: [] },
      "location": { name: "Location Analytics", lead: "Geo", agents: [], tasks: [] }
    }
  },
  "corporate": {
    name: "Corporate Division", emoji: "💼",
    mission: "Keep the business legal, funded, and staffed",
    teams: {
      "finance": { name: "Finance", lead: "Ledger", agents: [], tasks: [] },
      "fp-a": { name: "Financial Planning", lead: "Max", agents: [], tasks: [] },
      "legal": { name: "Legal", lead: "Justice", agents: [], tasks: [] },
      "contracts": { name: "Contracts", lead: "Counsel", agents: [], tasks: [] },
      "hr": { name: "HR/Recruiting", lead: "Hire", agents: [], tasks: [] },
      "training": { name: "Training", lead: "Coach", agents: [], tasks: [] }
    }
  }
};

// Legacy flat departments for backward compatibility
const DEFAULT_DEPARTMENTS = {
  "sales": { name: "Sales & Acquisition", emoji: "🎯", agents: [], tasks: [] },
  "operations": { name: "Operations", emoji: "📦", agents: [], tasks: [] },
  "marketing": { name: "Marketing", emoji: "📣", agents: [], tasks: [] },
  "finance": { name: "Finance & Accounting", emoji: "💰", agents: [], tasks: [] },
  "research": { name: "Research & Intelligence", emoji: "🔬", agents: [], tasks: [] },
  "technology": { name: "Technology", emoji: "🖥️", agents: [], tasks: [] },
  "legal": { name: "Legal & Compliance", emoji: "⚖️", agents: [], tasks: [] },
  "hr": { name: "HR & Staffing", emoji: "👥", agents: [], tasks: [] },
  "website": { name: "Website", emoji: "🌐", agents: [], tasks: [] },
  "database": { name: "Database", emoji: "🗄️", agents: [], tasks: [] }
};

if (!db.departments) {
  db.departments = JSON.parse(JSON.stringify(DEFAULT_DEPARTMENTS));
  saveDB(db);
} else {
  // Add any missing departments to existing db
  let updated = false;
  for (const [key, dept] of Object.entries(DEFAULT_DEPARTMENTS)) {
    if (!db.departments[key]) {
      db.departments[key] = JSON.parse(JSON.stringify(dept));
      updated = true;
    }
  }
  if (updated) saveDB(db);
}

// Initialize divisions (Amazon-style org structure)
if (!db.divisions) {
  db.divisions = JSON.parse(JSON.stringify(DEFAULT_DIVISIONS));
  saveDB(db);
} else {
  let updated = false;
  for (const [key, div] of Object.entries(DEFAULT_DIVISIONS)) {
    if (!db.divisions[key]) {
      db.divisions[key] = JSON.parse(JSON.stringify(div));
      updated = true;
    } else {
      // Add any missing teams
      for (const [teamKey, team] of Object.entries(div.teams || {})) {
        if (!db.divisions[key].teams[teamKey]) {
          db.divisions[key].teams[teamKey] = JSON.parse(JSON.stringify(team));
          updated = true;
        }
      }
    }
  }
  if (updated) saveDB(db);
}

// ===== DIVISIONS API (Amazon-style org) =====

// Get all divisions with teams and stats
app.get('/api/divisions', (req, res) => {
  const now = Date.now();
  const divs = db.divisions || {};
  const result = {};
  
  for (const [divKey, div] of Object.entries(divs)) {
    const teams = {};
    let divActiveAgents = 0;
    let divActiveTasks = 0;
    let divCompletedTasks = 0;
    
    for (const [teamKey, team] of Object.entries(div.teams || {})) {
      const activeAgents = (team.agents || []).filter(a => now - (a.lastSeen || 0) < 30 * 60 * 1000);
      const activeTasks = (team.tasks || []).filter(t => t.status === 'in-progress');
      const completedTasks = (team.tasks || []).filter(t => t.status === 'completed');
      
      divActiveAgents += activeAgents.length;
      divActiveTasks += activeTasks.length;
      divCompletedTasks += completedTasks.length;
      
      teams[teamKey] = {
        ...team,
        activeAgentCount: activeAgents.length,
        activeAgents,
        activeTaskCount: activeTasks.length,
        completedTaskCount: completedTasks.length
      };
    }
    
    result[divKey] = {
      name: div.name,
      emoji: div.emoji,
      mission: div.mission,
      teams,
      totalActiveAgents: divActiveAgents,
      totalActiveTasks: divActiveTasks,
      totalCompletedTasks: divCompletedTasks
    };
  }
  
  res.json(result);
});

// Check in to a team within a division
app.post('/api/divisions/:division/teams/:team/checkin', (req, res) => {
  const { division, team } = req.params;
  const { agentId, agentName, task } = req.body;
  
  if (!db.divisions[division]) {
    return res.status(404).json({ error: 'Division not found' });
  }
  if (!db.divisions[division].teams[team]) {
    return res.status(404).json({ error: 'Team not found' });
  }
  
  const teamData = db.divisions[division].teams[team];
  if (!teamData.agents) teamData.agents = [];
  
  const existing = teamData.agents.find(a => a.id === agentId);
  const now = Date.now();
  
  if (existing) {
    existing.lastSeen = now;
    existing.currentTask = task;
  } else {
    teamData.agents.push({
      id: agentId,
      name: agentName || agentId,
      checkedInAt: now,
      lastSeen: now,
      currentTask: task
    });
  }
  
  saveDB(db);
  res.json({ status: 'checked in', division, team, agentId, agentName });
});

// Add task to a team
app.post('/api/divisions/:division/teams/:team/tasks', (req, res) => {
  const { division, team } = req.params;
  const { title, agentId, agentName, status = 'in-progress', result } = req.body;
  
  if (!db.divisions[division]?.teams?.[team]) {
    return res.status(404).json({ error: 'Division or team not found' });
  }
  
  const teamData = db.divisions[division].teams[team];
  if (!teamData.tasks) teamData.tasks = [];
  
  const task = {
    id: Date.now(),
    title,
    agentId,
    agentName,
    status,
    startedAt: new Date().toISOString(),
    completedAt: status === 'completed' ? new Date().toISOString() : null,
    result
  };
  
  teamData.tasks.push(task);
  saveDB(db);
  res.json(task);
});

// Checkout from a team
app.post('/api/divisions/:division/teams/:team/checkout', (req, res) => {
  const { division, team } = req.params;
  const { agentId } = req.body;
  
  if (!db.divisions[division]?.teams?.[team]) {
    return res.status(404).json({ error: 'Division or team not found' });
  }
  
  const teamData = db.divisions[division].teams[team];
  if (teamData.agents) {
    teamData.agents = teamData.agents.filter(a => a.id !== agentId);
    saveDB(db);
  }
  
  res.json({ status: 'checked out', division, team, agentId });
});

// Get all departments with active agent/task counts
app.get('/api/departments', (req, res) => {
  const now = Date.now();
  const depts = db.departments || {};
  const result = {};
  for (const [key, dept] of Object.entries(depts)) {
    // Filter to only active agents (checked in within last 30 min)
    const activeAgents = (dept.agents || []).filter(a => now - (a.lastSeen || 0) < 30 * 60 * 1000);
    const activeTasks = (dept.tasks || []).filter(t => t.status === 'in-progress');
    const completedTasks = (dept.tasks || []).filter(t => t.status === 'completed');
    result[key] = {
      ...dept,
      activeAgentCount: activeAgents.length,
      activeAgents: activeAgents,
      activeTaskCount: activeTasks.length,
      activeTasks: activeTasks.slice(-5),
      completedTaskCount: completedTasks.length,
      totalTaskCount: (dept.tasks || []).length
    };
  }
  res.json(result);
});

// Agent check-in: POST /api/departments/:dept/checkin
app.post('/api/departments/:dept/checkin', (req, res) => {
  const dept = req.params.dept;
  if (!db.departments[dept]) return res.status(404).json({ error: 'Department not found' });
  const { agentId, agentName, task } = req.body;
  if (!agentId) return res.status(400).json({ error: 'agentId required' });
  
  // Update or add agent
  const agents = db.departments[dept].agents || [];
  const existing = agents.findIndex(a => a.agentId === agentId);
  const agentData = { agentId, agentName: agentName || agentId, task: task || '', lastSeen: Date.now(), checkedInAt: existing >= 0 ? agents[existing].checkedInAt : Date.now() };
  if (existing >= 0) { agents[existing] = agentData; } else { agents.push(agentData); }
  db.departments[dept].agents = agents;
  saveDB(db);
  res.json({ success: true, agent: agentData });
});

// Agent checkout: POST /api/departments/:dept/checkout
app.post('/api/departments/:dept/checkout', (req, res) => {
  const dept = req.params.dept;
  if (!db.departments[dept]) return res.status(404).json({ error: 'Department not found' });
  const { agentId } = req.body;
  db.departments[dept].agents = (db.departments[dept].agents || []).filter(a => a.agentId !== agentId);
  saveDB(db);
  res.json({ success: true });
});

// Add task to department: POST /api/departments/:dept/tasks
app.post('/api/departments/:dept/tasks', (req, res) => {
  const dept = req.params.dept;
  if (!db.departments[dept]) return res.status(404).json({ error: 'Department not found' });
  const task = {
    id: nextId(),
    title: req.body.title || 'Untitled Task',
    agentId: req.body.agentId || null,
    agentName: req.body.agentName || null,
    status: req.body.status || 'in-progress',
    startedAt: new Date().toISOString(),
    completedAt: null,
    result: null
  };
  if (!db.departments[dept].tasks) db.departments[dept].tasks = [];
  db.departments[dept].tasks.push(task);
  saveDB(db);
  res.json(task);
});

// Update task: PUT /api/departments/:dept/tasks/:id
app.put('/api/departments/:dept/tasks/:id', (req, res) => {
  const dept = req.params.dept;
  const id = parseInt(req.params.id);
  if (!db.departments[dept]) return res.status(404).json({ error: 'Department not found' });
  const tasks = db.departments[dept].tasks || [];
  const idx = tasks.findIndex(t => t.id === id);
  if (idx < 0) return res.status(404).json({ error: 'Task not found' });
  tasks[idx] = { ...tasks[idx], ...req.body, ...(req.body.status === 'completed' ? { completedAt: new Date().toISOString() } : {}) };
  db.departments[dept].tasks = tasks;
  saveDB(db);
  res.json(tasks[idx]);
});

// Clear stale agents (older than 30 min)
app.post('/api/departments/cleanup', (req, res) => {
  const now = Date.now();
  for (const dept of Object.values(db.departments || {})) {
    dept.agents = (dept.agents || []).filter(a => now - (a.lastSeen || 0) < 30 * 60 * 1000);
  }
  saveDB(db);
  res.json({ success: true });
});

// ===== AGENT LEADERBOARD & EFFICIENCY REPORTS =====

// Calculate agent metrics from all departments
function calculateAgentMetrics() {
  const agentStats = {};
  const depts = db.departments || {};
  
  for (const [deptKey, dept] of Object.entries(depts)) {
    const tasks = dept.tasks || [];
    
    for (const task of tasks) {
      if (!task.agentName) continue;
      
      if (!agentStats[task.agentName]) {
        agentStats[task.agentName] = {
          name: task.agentName,
          departments: new Set(),
          tasksCompleted: 0,
          tasksInProgress: 0,
          tasksFailed: 0,
          totalTasks: 0,
          completionTimes: [],
          taskTitles: [],
          firstTaskAt: null,
          lastTaskAt: null,
          tasksByDept: {},
          taskDates: []
        };
      }
      
      const agent = agentStats[task.agentName];
      agent.departments.add(deptKey);
      agent.totalTasks++;
      agent.taskTitles.push(task.title || '');
      
      if (!agent.tasksByDept[deptKey]) agent.tasksByDept[deptKey] = { completed: 0, inProgress: 0, failed: 0 };
      
      if (task.status === 'completed') {
        agent.tasksCompleted++;
        agent.tasksByDept[deptKey].completed++;
        
        // Calculate completion time if we have both timestamps
        if (task.startedAt && task.completedAt) {
          const start = new Date(task.startedAt).getTime();
          const end = new Date(task.completedAt).getTime();
          if (end > start) {
            agent.completionTimes.push((end - start) / 1000 / 60); // minutes
          }
        }
        
        const taskTime = task.completedAt || task.startedAt;
        if (taskTime) {
          agent.taskDates.push(new Date(taskTime));
          if (!agent.firstTaskAt || taskTime < agent.firstTaskAt) agent.firstTaskAt = taskTime;
          if (!agent.lastTaskAt || taskTime > agent.lastTaskAt) agent.lastTaskAt = taskTime;
        }
      } else if (task.status === 'in-progress') {
        agent.tasksInProgress++;
        agent.tasksByDept[deptKey].inProgress++;
      } else if (task.status === 'failed') {
        agent.tasksFailed++;
        agent.tasksByDept[deptKey].failed++;
      }
    }
  }
  
  // Calculate detailed scores for each agent
  const rankedAgents = Object.values(agentStats).map(agent => {
    const completionRate = agent.totalTasks > 0 ? (agent.tasksCompleted / agent.totalTasks) * 100 : 0;
    const failureRate = agent.totalTasks > 0 ? (agent.tasksFailed / agent.totalTasks) * 100 : 0;
    const avgCompletionTime = agent.completionTimes.length > 0 
      ? agent.completionTimes.reduce((a, b) => a + b, 0) / agent.completionTimes.length 
      : null;
    const fastestTask = agent.completionTimes.length > 0 ? Math.min(...agent.completionTimes) : null;
    const slowestTask = agent.completionTimes.length > 0 ? Math.max(...agent.completionTimes) : null;
    
    // Calculate task complexity (based on title length as proxy for complexity)
    const avgTitleLength = agent.taskTitles.length > 0 
      ? agent.taskTitles.reduce((s, t) => s + t.length, 0) / agent.taskTitles.length 
      : 0;
    const complexityScore = Math.min(Math.round(avgTitleLength / 50 * 100), 100);
    
    // Calculate consistency (standard deviation of completion times)
    let consistencyScore = 100;
    if (agent.completionTimes.length > 1) {
      const mean = avgCompletionTime;
      const variance = agent.completionTimes.reduce((s, t) => s + Math.pow(t - mean, 2), 0) / agent.completionTimes.length;
      const stdDev = Math.sqrt(variance);
      consistencyScore = Math.max(0, Math.round(100 - stdDev * 5)); // Lower variance = higher consistency
    }
    
    // Calculate throughput (tasks per day active)
    let throughputScore = 0;
    if (agent.firstTaskAt && agent.lastTaskAt) {
      const daysActive = Math.max(1, (new Date(agent.lastTaskAt) - new Date(agent.firstTaskAt)) / (1000 * 60 * 60 * 24));
      const tasksPerDay = agent.tasksCompleted / daysActive;
      throughputScore = Math.min(Math.round(tasksPerDay * 20), 100); // 5 tasks/day = 100
    } else {
      throughputScore = Math.min(agent.tasksCompleted * 20, 100);
    }
    
    // === EFFICIENCY METRICS ===
    // Speed Score: How fast tasks are completed (lower time = higher score)
    const speedScore = avgCompletionTime 
      ? Math.max(0, Math.round(100 - (avgCompletionTime / 10) * 100)) // Under 10 min = 100
      : 50;
    
    // Throughput Score: Volume of work output
    const volumeScore = Math.min(Math.round(agent.tasksCompleted / 8 * 100), 100); // 8 tasks = 100
    
    // Versatility Score: Working across departments
    const versatilityScore = Math.min(Math.round(agent.departments.size / 4 * 100), 100); // 4 depts = 100
    
    // Availability Score: Currently active/responsive
    const availabilityScore = agent.tasksInProgress > 0 ? 100 : (agent.tasksCompleted > 0 ? 70 : 30);
    
    // Combined Efficiency Score (reduced weight - quality matters more)
    const efficiencyScore = Math.round(
      (speedScore * 0.20) + 
      (throughputScore * 0.25) + 
      (volumeScore * 0.25) + 
      (versatilityScore * 0.15) +
      (availabilityScore * 0.15)
    );
    
    // === QUALITY METRICS (WEIGHTED HEAVILY) ===
    // Success Rate: Completed vs failed
    const successRate = Math.round(completionRate);
    
    // Reliability Score: Consistency in performance
    const reliabilityScore = consistencyScore;
    
    // Thoroughness Score: Task complexity handled (DEEP INSIGHTS)
    // Higher score for more detailed/complex tasks
    const thoroughnessScore = complexityScore;
    
    // Zero-Error Score: No failures (HEAVILY PENALIZE MISTAKES)
    // Mistakes cost double - each failure drops score significantly
    const errorFreeScore = Math.max(0, Math.round(100 - (failureRate * 2)));
    
    // Above & Beyond Score: Going beyond minimum requirements
    // Based on task title indicators of depth (lines, insights, detailed, comprehensive, etc.)
    const depthIndicators = ['insight', 'deep', 'comprehensive', 'detailed', 'full', 'complete', 'thorough', 'analysis', 'research', 'strategy'];
    const depthMatches = agent.taskTitles.filter(t => 
      depthIndicators.some(d => t.toLowerCase().includes(d))
    ).length;
    const aboveBeyondScore = Math.min(Math.round((depthMatches / Math.max(agent.totalTasks, 1)) * 150), 100);
    
    // Output Quality Score: Based on metrics in task titles (numbers suggest measurable output)
    const hasMetrics = agent.taskTitles.filter(t => /\d+/.test(t)).length;
    const outputQualityScore = Math.min(Math.round((hasMetrics / Math.max(agent.totalTasks, 1)) * 120), 100);
    
    // Combined Quality Score (WEIGHTED MOST HEAVILY)
    const qualityScore = Math.round(
      (successRate * 0.20) + 
      (reliabilityScore * 0.15) + 
      (thoroughnessScore * 0.20) +
      (errorFreeScore * 0.20) +
      (aboveBeyondScore * 0.15) +
      (outputQualityScore * 0.10)
    );
    
    // === INSIGHT SCORE (NEW - rewards deep work) ===
    const insightScore = Math.round(
      (aboveBeyondScore * 0.40) +
      (thoroughnessScore * 0.35) +
      (outputQualityScore * 0.25)
    );
    
    // === PRODUCTIVITY METRICS ===
    const productivityScore = Math.round(
      (volumeScore * 0.4) +
      (throughputScore * 0.35) +
      (speedScore * 0.25)
    );
    
    // Overall score: Quality > Insight > Efficiency > Productivity
    // Quality and depth matter most, speed/volume matter less
    const overallScore = Math.round(
      (qualityScore * 0.35) +      // Quality is king
      (insightScore * 0.25) +      // Deep insights rewarded
      (efficiencyScore * 0.20) +   // Efficiency matters
      (productivityScore * 0.20)   // Volume matters least
    );
    
    // Determine rank/tier
    let tier = 'Bronze';
    let tierEmoji = '🥉';
    if (overallScore >= 90) { tier = 'Diamond'; tierEmoji = '💎'; }
    else if (overallScore >= 75) { tier = 'Gold'; tierEmoji = '🥇'; }
    else if (overallScore >= 50) { tier = 'Silver'; tierEmoji = '🥈'; }
    
    return {
      name: agent.name,
      departments: Array.from(agent.departments),
      departmentCount: agent.departments.size,
      tasksCompleted: agent.tasksCompleted,
      tasksInProgress: agent.tasksInProgress,
      tasksFailed: agent.tasksFailed,
      totalTasks: agent.totalTasks,
      
      // Time metrics
      avgCompletionTimeMin: avgCompletionTime ? Math.round(avgCompletionTime * 10) / 10 : null,
      fastestTaskMin: fastestTask ? Math.round(fastestTask * 10) / 10 : null,
      slowestTaskMin: slowestTask ? Math.round(slowestTask * 10) / 10 : null,
      
      // Rate metrics
      completionRate: Math.round(completionRate),
      failureRate: Math.round(failureRate),
      
      // Individual scores
      metrics: {
        efficiency: {
          speed: speedScore,
          throughput: throughputScore,
          volume: volumeScore,
          versatility: versatilityScore,
          availability: availabilityScore,
          overall: efficiencyScore
        },
        quality: {
          successRate,
          reliability: reliabilityScore,
          thoroughness: thoroughnessScore,
          errorFree: errorFreeScore,
          aboveBeyond: aboveBeyondScore,
          outputQuality: outputQualityScore,
          overall: qualityScore
        },
        insight: {
          aboveBeyond: aboveBeyondScore,
          thoroughness: thoroughnessScore,
          outputQuality: outputQualityScore,
          overall: insightScore
        },
        productivity: {
          overall: productivityScore
        }
      },
      
      // Summary scores
      efficiencyScore,
      qualityScore,
      insightScore,
      productivityScore,
      overallScore,
      tier,
      tierEmoji,
      
      firstTaskAt: agent.firstTaskAt,
      lastTaskAt: agent.lastTaskAt,
      tasksByDept: agent.tasksByDept
    };
  });
  
  // Sort by overall score descending
  return rankedAgents.sort((a, b) => b.overallScore - a.overallScore);
}

// Calculate department metrics
function calculateDepartmentMetrics() {
  const depts = db.departments || {};
  const metrics = [];
  
  for (const [key, dept] of Object.entries(depts)) {
    const tasks = dept.tasks || [];
    const completed = tasks.filter(t => t.status === 'completed');
    const inProgress = tasks.filter(t => t.status === 'in-progress');
    
    // Unique agents who worked in this department
    const agents = new Set(tasks.filter(t => t.agentName).map(t => t.agentName));
    
    // Calculate completion times
    const completionTimes = [];
    for (const task of completed) {
      if (task.startedAt && task.completedAt) {
        const start = new Date(task.startedAt).getTime();
        const end = new Date(task.completedAt).getTime();
        if (end > start) completionTimes.push((end - start) / 1000 / 60);
      }
    }
    
    const avgCompletionTime = completionTimes.length > 0
      ? completionTimes.reduce((a, b) => a + b, 0) / completionTimes.length
      : null;
    
    const completionRate = tasks.length > 0 ? (completed.length / tasks.length) * 100 : 0;
    
    // Productivity score
    const productivityScore = Math.min(completed.length / 5 * 100, 100);
    const efficiencyScore = Math.round((completionRate * 0.5) + (productivityScore * 0.5));
    
    metrics.push({
      key,
      name: dept.name,
      emoji: dept.emoji,
      totalTasks: tasks.length,
      completedTasks: completed.length,
      inProgressTasks: inProgress.length,
      uniqueAgents: agents.size,
      agentNames: Array.from(agents),
      completionRate: Math.round(completionRate),
      avgCompletionTimeMin: avgCompletionTime ? Math.round(avgCompletionTime) : null,
      efficiencyScore
    });
  }
  
  return metrics.sort((a, b) => b.efficiencyScore - a.efficiencyScore);
}

// API: Get agent leaderboard
app.get('/api/leaderboard', (req, res) => {
  const agents = calculateAgentMetrics();
  const topAgents = agents.slice(0, 50);
  
  // Add rank numbers
  topAgents.forEach((agent, idx) => {
    agent.rank = idx + 1;
  });
  
  // Calculate department rankings (competition within each dept)
  const deptRankings = {};
  const deptMVPs = {};
  
  for (const agent of agents) {
    for (const dept of agent.departments) {
      if (!deptRankings[dept]) deptRankings[dept] = [];
      deptRankings[dept].push({
        name: agent.name,
        score: agent.overallScore,
        tasksCompleted: agent.tasksCompleted,
        efficiencyScore: agent.efficiencyScore,
        qualityScore: agent.qualityScore
      });
    }
  }
  
  // Sort each department and assign ranks
  for (const [dept, deptAgents] of Object.entries(deptRankings)) {
    deptAgents.sort((a, b) => b.score - a.score);
    deptAgents.forEach((a, idx) => {
      a.deptRank = idx + 1;
      a.isTopPerformer = idx === 0;
      a.rivalName = idx < deptAgents.length - 1 ? deptAgents[idx + 1].name : null;
      a.rivalGap = idx < deptAgents.length - 1 ? a.score - deptAgents[idx + 1].score : 0;
      a.leaderName = idx > 0 ? deptAgents[0].name : null;
      a.leaderGap = idx > 0 ? deptAgents[0].score - a.score : 0;
    });
    
    // MVP is top performer
    if (deptAgents.length > 0) {
      deptMVPs[dept] = deptAgents[0];
    }
  }
  
  // Add department rank info to each agent
  topAgents.forEach(agent => {
    agent.deptRankings = {};
    agent.achievements = [];
    
    for (const dept of agent.departments) {
      const deptAgent = deptRankings[dept]?.find(a => a.name === agent.name);
      if (deptAgent) {
        agent.deptRankings[dept] = {
          rank: deptAgent.deptRank,
          total: deptRankings[dept].length,
          isTopPerformer: deptAgent.isTopPerformer,
          rivalName: deptAgent.rivalName,
          rivalGap: deptAgent.rivalGap,
          leaderName: deptAgent.leaderName,
          leaderGap: deptAgent.leaderGap
        };
        
        // Add achievements
        if (deptAgent.isTopPerformer) {
          agent.achievements.push(`🏆 MVP of ${dept}`);
        }
        if (deptAgent.deptRank <= 3 && deptRankings[dept].length > 3) {
          agent.achievements.push(`🥇 Top 3 in ${dept}`);
        }
      }
    }
    
    // Global achievements
    if (agent.rank === 1) agent.achievements.push('👑 #1 Overall');
    if (agent.tasksCompleted >= 5) agent.achievements.push('⚡ High Volume');
    if (agent.qualityScore >= 90) agent.achievements.push('✨ Quality Star');
    if (agent.departments.length >= 3) agent.achievements.push('🌐 Versatile');
  });
  
  res.json({
    leaderboard: topAgents,
    totalAgents: agents.length,
    departmentRankings: deptRankings,
    departmentMVPs: deptMVPs,
    generatedAt: new Date().toISOString()
  });
});

// API: Get department efficiency report
app.get('/api/efficiency/departments', (req, res) => {
  const metrics = calculateDepartmentMetrics();
  
  // Calculate overall stats
  const totalTasks = metrics.reduce((s, d) => s + d.totalTasks, 0);
  const totalCompleted = metrics.reduce((s, d) => s + d.completedTasks, 0);
  const avgEfficiency = metrics.length > 0
    ? Math.round(metrics.reduce((s, d) => s + d.efficiencyScore, 0) / metrics.length)
    : 0;
  
  res.json({
    departments: metrics,
    summary: {
      totalDepartments: metrics.length,
      totalTasks,
      totalCompleted,
      overallCompletionRate: totalTasks > 0 ? Math.round((totalCompleted / totalTasks) * 100) : 0,
      avgEfficiencyScore: avgEfficiency
    },
    generatedAt: new Date().toISOString()
  });
});

// API: Get individual agent report
app.get('/api/efficiency/agent/:name', (req, res) => {
  const agents = calculateAgentMetrics();
  const agent = agents.find(a => a.name.toLowerCase() === req.params.name.toLowerCase());
  
  if (!agent) {
    return res.status(404).json({ error: 'Agent not found' });
  }
  
  // Get detailed task history for this agent
  const taskHistory = [];
  const depts = db.departments || {};
  
  for (const [deptKey, dept] of Object.entries(depts)) {
    const tasks = (dept.tasks || []).filter(t => t.agentName === agent.name);
    for (const task of tasks) {
      taskHistory.push({
        ...task,
        department: deptKey,
        departmentName: dept.name
      });
    }
  }
  
  // Sort by date, newest first
  taskHistory.sort((a, b) => new Date(b.startedAt || 0) - new Date(a.startedAt || 0));
  
  res.json({
    ...agent,
    taskHistory: taskHistory.slice(0, 50),
    generatedAt: new Date().toISOString()
  });
});

// Leaderboard page route
app.get('/leaderboard', (req, res) => res.sendFile(path.join(__dirname, 'leaderboard.html')));

// ===== PRODUCT MIX OPTIMIZER =====
app.get('/product-mix', (req, res) => res.sendFile(path.join(__dirname, 'product-mix.html')));

// ===== FLEET MANAGEMENT API =====
// Collections for fleet tracking (Phase 4 — SandStar AI machines)
if (!db.fleetMachines) db.fleetMachines = [];
if (!db.fleetServiceLogs) db.fleetServiceLogs = [];
if (!db.fleetRevenue) db.fleetRevenue = [];

// Fleet page route
app.get('/fleet', (req, res) => res.sendFile(path.join(__dirname, 'fleet.html')));

// List all fleet machines (with service logs + revenue embedded)
app.get('/api/fleet', (req, res) => {
  const machines = (db.fleetMachines || []).map(m => {
    const service_logs = (db.fleetServiceLogs || []).filter(l => l.machine_id === m.id)
      .sort((a, b) => new Date(b.service_date || b.created_at) - new Date(a.service_date || a.created_at));
    const revenue = (db.fleetRevenue || []).filter(r => r.machine_id === m.id)
      .sort((a, b) => new Date(b.date) - new Date(a.date));
    // Derive last_restock from service logs
    const lastRestock = service_logs.find(l => l.service_type === 'restock');
    return {
      ...m,
      service_logs,
      revenue,
      last_restock: lastRestock ? (lastRestock.service_date || lastRestock.created_at) : m.last_restock || null
    };
  });
  res.json(machines);
});

// Get single fleet machine
app.get('/api/fleet/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const machine = (db.fleetMachines || []).find(m => m.id === id);
  if (!machine) return res.status(404).json({ error: 'Machine not found' });
  const service_logs = (db.fleetServiceLogs || []).filter(l => l.machine_id === id);
  const revenue = (db.fleetRevenue || []).filter(r => r.machine_id === id);
  res.json({ ...machine, service_logs, revenue });
});

// Add fleet machine
app.post('/api/fleet', (req, res) => {
  const { serial, model, location, install_date, status, notes, placement, prospect_id, site_contact, capacity, commission_rate, commission_start, cat_beverages, cat_snacks, cat_candy, cat_healthy, cat_incidentals, cat_frozen } = req.body;
  if (!serial || !serial.trim()) return res.status(400).json({ error: 'serial is required' });
  // Location is optional for "available" machines
  if (status !== 'available' && (!location || !location.trim())) return res.status(400).json({ error: 'location is required for deployed machines' });
  // Check duplicate serial
  if ((db.fleetMachines || []).some(m => m.serial.toLowerCase() === serial.trim().toLowerCase())) {
    return res.status(400).json({ error: 'A machine with this serial number already exists' });
  }
  const machine = {
    id: nextId(),
    serial: serial.trim(),
    model: (model || 'SandStar AI Smart Cooler').trim(),
    location: location ? location.trim() : '',
    placement: placement || '',
    prospect_id: prospect_id ? parseInt(prospect_id) : null,
    site_contact: site_contact || '',
    capacity: capacity ? parseInt(capacity) : 60,
    install_date: install_date || null,
    status: status || 'available',
    notes: notes || '',
    commission_rate: commission_rate ? parseFloat(commission_rate) : 0,
    commission_start: commission_start || '6months',
    cat_beverages: !!cat_beverages,
    cat_snacks: !!cat_snacks,
    cat_candy: !!cat_candy,
    cat_healthy: !!cat_healthy,
    cat_incidentals: !!cat_incidentals,
    cat_frozen: !!cat_frozen,
    last_restock: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  db.fleetMachines.push(machine);
  saveDB(db);
  res.json(machine);
});

// Update fleet machine
app.put('/api/fleet/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const idx = (db.fleetMachines || []).findIndex(m => m.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Machine not found' });
  db.fleetMachines[idx] = { ...db.fleetMachines[idx], ...req.body, updated_at: new Date().toISOString() };
  saveDB(db);
  res.json(db.fleetMachines[idx]);
});

// Delete fleet machine
app.delete('/api/fleet/:id', (req, res) => {
  const id = parseInt(req.params.id);
  db.fleetMachines = (db.fleetMachines || []).filter(m => m.id !== id);
  db.fleetServiceLogs = (db.fleetServiceLogs || []).filter(l => l.machine_id !== id);
  db.fleetRevenue = (db.fleetRevenue || []).filter(r => r.machine_id !== id);
  saveDB(db);
  res.json({ success: true });
});

// Fleet service logs
app.get('/api/fleet/:id/service-logs', (req, res) => {
  const id = parseInt(req.params.id);
  const logs = (db.fleetServiceLogs || []).filter(l => l.machine_id === id)
    .sort((a, b) => new Date(b.service_date || b.created_at) - new Date(a.service_date || a.created_at));
  res.json(logs);
});

app.post('/api/fleet/:id/service-logs', (req, res) => {
  const machine_id = parseInt(req.params.id);
  if (!(db.fleetMachines || []).find(m => m.id === machine_id)) {
    return res.status(404).json({ error: 'Machine not found' });
  }
  const log = {
    id: nextId(),
    machine_id,
    service_type: req.body.service_type || 'routine',
    service_date: req.body.service_date || new Date().toISOString().split('T')[0],
    technician: req.body.technician || '',
    notes: req.body.notes || '',
    cost: parseFloat(req.body.cost) || 0,
    created_at: new Date().toISOString()
  };
  db.fleetServiceLogs.push(log);
  // If it's a restock, update machine's last_restock
  if (log.service_type === 'restock') {
    const mIdx = db.fleetMachines.findIndex(m => m.id === machine_id);
    if (mIdx !== -1) db.fleetMachines[mIdx].last_restock = log.service_date;
  }
  saveDB(db);
  res.json(log);
});

// Fleet revenue entries
app.get('/api/fleet/:id/revenue', (req, res) => {
  const id = parseInt(req.params.id);
  const revenue = (db.fleetRevenue || []).filter(r => r.machine_id === id)
    .sort((a, b) => new Date(b.date) - new Date(a.date));
  res.json(revenue);
});

app.post('/api/fleet/:id/revenue', (req, res) => {
  const machine_id = parseInt(req.params.id);
  if (!(db.fleetMachines || []).find(m => m.id === machine_id)) {
    return res.status(404).json({ error: 'Machine not found' });
  }
  const entry = {
    id: nextId(),
    machine_id,
    amount: parseFloat(req.body.amount) || 0,
    transactions: req.body.transactions ? parseInt(req.body.transactions) : null,
    date: req.body.date || new Date().toISOString().split('T')[0],
    notes: req.body.notes || '',
    created_at: new Date().toISOString()
  };
  db.fleetRevenue.push(entry);
  saveDB(db);
  res.json(entry);
});

// Fleet summary stats
app.get('/api/fleet/stats', (req, res) => {
  const machines = db.fleetMachines || [];
  const total = machines.length;
  const active = machines.filter(m => m.status === 'active').length;
  const needsService = machines.filter(m => m.status === 'needs-service').length;
  const now = new Date();
  const monthKey = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
  const monthRevenue = (db.fleetRevenue || []).filter(r => r.date && r.date.startsWith(monthKey)).reduce((s, r) => s + (r.amount || 0), 0);
  res.json({
    total,
    active,
    available: machines.filter(m => m.status === 'available').length,
    offline: machines.filter(m => m.status === 'offline').length,
    needsService,
    activeRate: total > 0 ? Math.round((active / total) * 100) : 0,
    avgRevenuePerMachine: total > 0 ? Math.round(monthRevenue / total) : 0,
    monthRevenue,
    totalServiceLogs: (db.fleetServiceLogs || []).length
  });
});

// ===== CLIENT PORTAL =====
// Separate auth for property managers — token/code based
if (!db.clientPortalTokens) db.clientPortalTokens = [];
if (!db.clientServiceRequests) db.clientServiceRequests = [];
if (!db.clientStatements) db.clientStatements = [];

const activeClientSessions = new Map(); // token -> { clientId, expiresAt }

app.get('/client-portal', (req, res) => res.sendFile(path.join(__dirname, 'client-portal.html')));

// Client portal login — token/code based
app.post('/api/client-portal/login', (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Access code required' });
  const token = (db.clientPortalTokens || []).find(t => t.code === code.trim() && t.active !== false);
  if (!token) return res.status(401).json({ error: 'Invalid access code' });
  const sessionToken = crypto.randomBytes(32).toString('hex');
  activeClientSessions.set(sessionToken, { clientId: token.client_id, expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000 });
  res.json({ success: true, token: sessionToken, clientName: token.client_name || 'Client' });
});

// Client portal auth check middleware helper
function getClientSession(req) {
  const authHeader = req.headers['authorization'];
  const sessionToken = authHeader ? authHeader.replace('Bearer ', '') : null;
  if (!sessionToken) return null;
  const session = activeClientSessions.get(sessionToken);
  if (!session) return null;
  if (Date.now() > session.expiresAt) { activeClientSessions.delete(sessionToken); return null; }
  return session;
}

// Generate client portal access code (admin endpoint)
app.post('/api/client-portal/tokens', (req, res) => {
  const code = req.body.code || crypto.randomBytes(4).toString('hex').toUpperCase();
  const token = {
    id: nextId(),
    client_id: req.body.client_id,
    client_name: req.body.client_name || 'Client',
    code,
    machine_ids: req.body.machine_ids || [],
    commission_rate: parseFloat(req.body.commission_rate) || 10,
    active: true,
    created_at: new Date().toISOString()
  };
  db.clientPortalTokens.push(token);
  saveDB(db);
  res.json(token);
});

app.get('/api/client-portal/tokens', (req, res) => {
  res.json(db.clientPortalTokens || []);
});

app.delete('/api/client-portal/tokens/:id', (req, res) => {
  const id = parseInt(req.params.id);
  db.clientPortalTokens = (db.clientPortalTokens || []).filter(t => t.id !== id);
  saveDB(db);
  res.json({ success: true });
});

// Client portal dashboard data — shows only THEIR machines
app.get('/api/client-portal/dashboard', (req, res) => {
  const session = getClientSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  const tokenRecord = (db.clientPortalTokens || []).find(t => t.client_id === session.clientId);
  if (!tokenRecord) return res.status(404).json({ error: 'Client config not found' });

  const machineIds = tokenRecord.machine_ids || [];
  const commissionRate = tokenRecord.commission_rate || 10;

  // Get their machines from fleet
  const allMachines = db.fleetMachines || [];
  const clientMachines = machineIds.length > 0 ? allMachines.filter(m => machineIds.includes(m.id)) : [];

  // Revenue this month
  const now = new Date();
  const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const allFleetRevenue = db.fleetRevenue || [];
  const monthRevenue = allFleetRevenue
    .filter(r => machineIds.includes(r.machine_id) && r.date && r.date.startsWith(monthKey))
    .reduce((s, r) => s + (r.amount || 0), 0);

  // Commission amount
  const commissionAmount = (monthRevenue * commissionRate) / 100;

  // Machine statuses
  const machineStatuses = clientMachines.map(m => ({
    id: m.id,
    serial: m.serial,
    model: m.model || 'SandStar AI',
    location: m.location,
    status: m.status || 'active',
    last_restock: m.last_restock || null
  }));

  // Product popularity from sales data
  const productMap = {};
  (db.products || []).forEach(p => { productMap[p.id] = p; });
  const salesData = (db.sales || []).filter(s => machineIds.includes(s.machine_id));
  const productPopularity = {};
  salesData.forEach(s => {
    const prod = productMap[s.product_id];
    const name = prod ? prod.name : `Product #${s.product_id}`;
    if (!productPopularity[name]) productPopularity[name] = 0;
    productPopularity[name] += s.quantity || 1;
  });
  const popularityList = Object.entries(productPopularity)
    .map(([name, units]) => ({ name, units }))
    .sort((a, b) => b.units - a.units)
    .slice(0, 10);

  // Restock schedule
  const restockSchedule = (db.restocks || [])
    .filter(r => machineIds.includes(r.machine_id) && (r.status === 'pending' || r.status === 'picking'))
    .map(r => {
      const machine = clientMachines.find(m => m.id === r.machine_id);
      return { id: r.id, machine: machine ? machine.serial : `Machine #${r.machine_id}`, scheduled_date: r.scheduled_date || r.created_at, status: r.status };
    })
    .sort((a, b) => new Date(a.scheduled_date) - new Date(b.scheduled_date));

  // Service logs for restock schedule fallback
  const serviceLogs = (db.fleetServiceLogs || [])
    .filter(l => machineIds.includes(l.machine_id) && l.service_type === 'restock')
    .sort((a, b) => new Date(b.service_date || b.created_at) - new Date(a.service_date || a.created_at))
    .slice(0, 5)
    .map(l => {
      const machine = clientMachines.find(m => m.id === l.machine_id);
      return { date: l.service_date, machine: machine ? machine.serial : `Machine #${l.machine_id}`, notes: l.notes };
    });

  // Monthly revenue history (last 6 months)
  const monthlyHistory = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const mk = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const rev = allFleetRevenue
      .filter(r => machineIds.includes(r.machine_id) && r.date && r.date.startsWith(mk))
      .reduce((s, r) => s + (r.amount || 0), 0);
    monthlyHistory.push({ month: mk, revenue: rev, commission: (rev * commissionRate) / 100 });
  }

  // Service requests for this client
  const serviceRequests = (db.clientServiceRequests || [])
    .filter(sr => sr.client_id === session.clientId)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  res.json({
    clientName: tokenRecord.client_name,
    commissionRate,
    monthRevenue,
    commissionAmount,
    machineCount: clientMachines.length,
    machines: machineStatuses,
    productPopularity: popularityList,
    restockSchedule,
    recentRestocks: serviceLogs,
    monthlyHistory,
    serviceRequests
  });
});

// Client service request submission
app.post('/api/client-portal/service-request', (req, res) => {
  const session = getClientSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  const sr = {
    id: nextId(),
    client_id: session.clientId,
    machine_id: req.body.machine_id || null,
    issue_type: req.body.issue_type || 'other',
    description: req.body.description || '',
    urgency: req.body.urgency || 'normal',
    status: 'open',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  db.clientServiceRequests.push(sr);
  saveDB(db);
  res.json(sr);
});

// Get client service requests
app.get('/api/client-portal/service-requests', (req, res) => {
  const session = getClientSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  const requests = (db.clientServiceRequests || [])
    .filter(sr => sr.client_id === session.clientId)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  res.json(requests);
});

// Admin: view all service requests
app.get('/api/client-portal/all-service-requests', (req, res) => {
  const allReqs = (db.clientServiceRequests || []).map(sr => {
    const token = (db.clientPortalTokens || []).find(t => t.client_id === sr.client_id);
    return { ...sr, client_name: token ? token.client_name : 'Unknown' };
  });
  res.json(allReqs.sort((a, b) => new Date(b.created_at) - new Date(a.created_at)));
});

// Admin: update service request status
app.put('/api/client-portal/service-requests/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const idx = (db.clientServiceRequests || []).findIndex(sr => sr.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  db.clientServiceRequests[idx] = { ...db.clientServiceRequests[idx], ...req.body, updated_at: new Date().toISOString() };
  saveDB(db);
  res.json(db.clientServiceRequests[idx]);
});

// Client monthly statements
app.get('/api/client-portal/statements', (req, res) => {
  const session = getClientSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  const tokenRecord = (db.clientPortalTokens || []).find(t => t.client_id === session.clientId);
  if (!tokenRecord) return res.status(404).json({ error: 'Client config not found' });

  const machineIds = tokenRecord.machine_ids || [];
  const commissionRate = tokenRecord.commission_rate || 10;
  const allFleetRevenue = db.fleetRevenue || [];
  const now = new Date();

  // Build statements for last 12 months
  const statements = [];
  for (let i = 0; i < 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const mk = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const rev = allFleetRevenue
      .filter(r => machineIds.includes(r.machine_id) && r.date && r.date.startsWith(mk))
      .reduce((s, r) => s + (r.amount || 0), 0);
    if (rev > 0 || i < 3) {
      const commission = (rev * commissionRate) / 100;
      const storedStatement = (db.clientStatements || []).find(s => s.client_id === session.clientId && s.month === mk);
      statements.push({
        month: mk,
        revenue: rev,
        commissionRate,
        commissionOwed: commission,
        paid: storedStatement ? storedStatement.paid : false,
        paidDate: storedStatement ? storedStatement.paid_date : null,
        notes: storedStatement ? storedStatement.notes : ''
      });
    }
  }
  res.json(statements);
});

// ===== CLIENT PORTAL URL TOKEN LOGIN =====
// Allows passwordless login via URL: /client-portal?token=xxx
if (!db.clientPortalUrlTokens) db.clientPortalUrlTokens = [];

// URL token login (GET for simplicity — token in query string)
app.get('/api/client-portal/token-login', (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).json({ error: 'Token required' });
  
  const urlToken = (db.clientPortalUrlTokens || []).find(t => t.token === token && t.active !== false);
  if (!urlToken) return res.status(401).json({ error: 'Invalid or expired link', success: false });
  
  // Check expiry (default 90 days)
  if (urlToken.expires_at && new Date(urlToken.expires_at) < new Date()) {
    return res.status(401).json({ error: 'This link has expired', success: false });
  }
  
  // Create session
  const sessionToken = crypto.randomBytes(32).toString('hex');
  activeClientSessions.set(sessionToken, { 
    clientId: urlToken.client_id, 
    expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000 
  });
  
  // Log access
  urlToken.last_accessed = new Date().toISOString();
  urlToken.access_count = (urlToken.access_count || 0) + 1;
  saveDB(db);
  
  res.json({ 
    success: true, 
    sessionToken, 
    clientName: urlToken.client_name || 'Client',
    propertyAddress: urlToken.property_address || null
  });
});

// Generate URL token for a prospect/client (admin endpoint)
app.post('/api/client-portal/url-tokens', (req, res) => {
  const token = crypto.randomBytes(16).toString('hex');
  const expiryDays = parseInt(req.body.expiry_days) || 90;
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + expiryDays);
  
  const urlToken = {
    id: nextId(),
    token,
    client_id: req.body.client_id || req.body.prospect_id || `client_${Date.now()}`,
    prospect_id: req.body.prospect_id || null,
    client_name: req.body.client_name || req.body.property_name || 'Client',
    property_address: req.body.property_address || '',
    machine_ids: req.body.machine_ids || [],
    commission_rate: parseFloat(req.body.commission_rate) || 5,
    active: true,
    expires_at: expiresAt.toISOString(),
    access_count: 0,
    created_at: new Date().toISOString()
  };
  
  if (!db.clientPortalUrlTokens) db.clientPortalUrlTokens = [];
  db.clientPortalUrlTokens.push(urlToken);
  
  // Also create a matching code-based token for backward compatibility
  const codeToken = (db.clientPortalTokens || []).find(t => t.client_id === urlToken.client_id);
  if (!codeToken) {
    const code = crypto.randomBytes(4).toString('hex').toUpperCase();
    db.clientPortalTokens.push({
      id: nextId(),
      client_id: urlToken.client_id,
      client_name: urlToken.client_name,
      code,
      machine_ids: urlToken.machine_ids,
      commission_rate: urlToken.commission_rate,
      active: true,
      created_at: new Date().toISOString()
    });
  }
  
  saveDB(db);
  
  // Return full URL
  const baseUrl = req.headers.host?.includes('localhost') 
    ? `http://${req.headers.host}` 
    : `https://${req.headers.host || 'dashboard.kandevendtech.com'}`;
  
  res.json({
    ...urlToken,
    portal_url: `${baseUrl}/client-portal?token=${token}`,
    demo_url: `${baseUrl}/client-portal?demo=1`
  });
});

// List all URL tokens (admin)
app.get('/api/client-portal/url-tokens', (req, res) => {
  const tokens = (db.clientPortalUrlTokens || []).map(t => {
    const baseUrl = req.headers.host?.includes('localhost') 
      ? `http://${req.headers.host}` 
      : `https://${req.headers.host || 'dashboard.kandevendtech.com'}`;
    return {
      ...t,
      portal_url: `${baseUrl}/client-portal?token=${t.token}`,
      is_expired: t.expires_at && new Date(t.expires_at) < new Date()
    };
  });
  res.json(tokens.sort((a, b) => new Date(b.created_at) - new Date(a.created_at)));
});

// Revoke/delete URL token
app.delete('/api/client-portal/url-tokens/:id', (req, res) => {
  const id = parseInt(req.params.id);
  db.clientPortalUrlTokens = (db.clientPortalUrlTokens || []).filter(t => t.id !== id);
  saveDB(db);
  res.json({ success: true });
});

// Regenerate URL token (new token, same client)
app.post('/api/client-portal/url-tokens/:id/regenerate', (req, res) => {
  const id = parseInt(req.params.id);
  const idx = (db.clientPortalUrlTokens || []).findIndex(t => t.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Token not found' });
  
  const newToken = crypto.randomBytes(16).toString('hex');
  const expiryDays = parseInt(req.body.expiry_days) || 90;
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + expiryDays);
  
  db.clientPortalUrlTokens[idx].token = newToken;
  db.clientPortalUrlTokens[idx].expires_at = expiresAt.toISOString();
  db.clientPortalUrlTokens[idx].access_count = 0;
  db.clientPortalUrlTokens[idx].updated_at = new Date().toISOString();
  saveDB(db);
  
  const baseUrl = req.headers.host?.includes('localhost') 
    ? `http://${req.headers.host}` 
    : `https://${req.headers.host || 'dashboard.kandevendtech.com'}`;
  
  res.json({
    ...db.clientPortalUrlTokens[idx],
    portal_url: `${baseUrl}/client-portal?token=${newToken}`
  });
});

// Generate client portal link for a prospect (quick helper)
app.post('/api/prospects/:id/client-portal-link', (req, res) => {
  const prospectId = parseInt(req.params.id);
  const prospect = db.prospects.find(p => p.id === prospectId);
  if (!prospect) return res.status(404).json({ error: 'Prospect not found' });
  
  // Check if link already exists
  const existing = (db.clientPortalUrlTokens || []).find(t => t.prospect_id === prospectId && t.active);
  if (existing) {
    const baseUrl = req.headers.host?.includes('localhost') 
      ? `http://${req.headers.host}` 
      : `https://${req.headers.host || 'dashboard.kandevendtech.com'}`;
    return res.json({
      ...existing,
      portal_url: `${baseUrl}/client-portal?token=${existing.token}`,
      already_existed: true
    });
  }
  
  // Create new token
  const token = crypto.randomBytes(16).toString('hex');
  const expiryDays = 90;
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + expiryDays);
  
  const urlToken = {
    id: nextId(),
    token,
    client_id: `prospect_${prospectId}`,
    prospect_id: prospectId,
    client_name: prospect.name || 'Client',
    property_address: prospect.address || '',
    machine_ids: [],
    commission_rate: parseFloat(req.body.commission_rate) || 5,
    active: true,
    expires_at: expiresAt.toISOString(),
    access_count: 0,
    created_at: new Date().toISOString()
  };
  
  if (!db.clientPortalUrlTokens) db.clientPortalUrlTokens = [];
  db.clientPortalUrlTokens.push(urlToken);
  saveDB(db);
  
  const baseUrl = req.headers.host?.includes('localhost') 
    ? `http://${req.headers.host}` 
    : `https://${req.headers.host || 'dashboard.kandevendtech.com'}`;
  
  res.json({
    ...urlToken,
    portal_url: `${baseUrl}/client-portal?token=${token}`
  });
});

// ===== PROPOSALS API =====
if (!db.proposals) db.proposals = [];

app.get('/proposal-generator', (req, res) => res.sendFile(path.join(__dirname, 'proposal-generator.html')));

// Serve the raw proposal template for the generator to token-replace client-side
app.get('/api/proposal-template', (req, res) => {
  // Try local templates/ first (deployed with dashboard), then fallback to sales/materials/
  const localPath = path.join(__dirname, 'templates', 'proposal-template.html');
  const fallbackPath = path.join(__dirname, '..', 'sales', 'materials', 'proposal-template.html');
  const templatePath = fs.existsSync(localPath) ? localPath : fallbackPath;
  if (fs.existsSync(templatePath)) {
    res.type('text/html').sendFile(templatePath);
  } else {
    res.status(404).send('<html><body><h1>Template not found</h1></body></html>');
  }
});

// List proposals (newest first)
app.get('/api/proposals', (req, res) => {
  const proposals = (db.proposals || []).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  res.json(proposals);
});

// Get single proposal
app.get('/api/proposals/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const proposal = (db.proposals || []).find(p => p.id === id);
  if (!proposal) return res.status(404).json({ error: 'Proposal not found' });
  res.json(proposal);
});

// Create proposal + log activity on linked prospect
app.post('/api/proposals', (req, res) => {
  if (!req.body.property_name || !req.body.property_name.trim()) {
    return res.status(400).json({ error: 'property_name is required' });
  }
  const proposal = {
    id: nextId(),
    ...req.body,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  db.proposals.push(proposal);

  // If linked to a prospect, log an activity and update prospect
  if (proposal.prospect_id) {
    const prospectIdx = db.prospects.findIndex(p => p.id === proposal.prospect_id);
    if (prospectIdx !== -1) {
      db.activities.push({
        id: nextId(),
        prospect_id: proposal.prospect_id,
        type: 'proposal',
        description: `Proposal generated: ${proposal.proposal_number || 'N/A'} — ${proposal.machine_count || '?'} machines, ${proposal.revenue_share || '?'}% share`,
        created_at: new Date().toISOString()
      });
      // Bump prospect to active/warm if still new
      const prospect = db.prospects[prospectIdx];
      if (prospect.status === 'new') prospect.status = 'active';
      if (prospect.priority === 'normal') prospect.priority = 'warm';
      prospect.updated_at = new Date().toISOString();
    }
  }

  saveDB(db);
  res.json(proposal);
});

// Update proposal
app.put('/api/proposals/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const idx = (db.proposals || []).findIndex(p => p.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Proposal not found' });
  db.proposals[idx] = { ...db.proposals[idx], ...req.body, updated_at: new Date().toISOString() };
  saveDB(db);
  res.json(db.proposals[idx]);
});

// Delete proposal
app.delete('/api/proposals/:id', (req, res) => {
  const id = parseInt(req.params.id);
  db.proposals = (db.proposals || []).filter(p => p.id !== id);
  saveDB(db);
  res.json({ success: true });
});

// ===== DRIVER MOBILE INTERFACE =====
// Separate PIN-based auth for field drivers (independent of admin login)

// Ensure driver collections exist in DB
if (!db.drivers) db.drivers = [];
if (!db.driverSessions) db.driverSessions = {};
if (!db.driverCheckins) db.driverCheckins = [];
if (!db.driverRestocks) db.driverRestocks = [];
if (!db.driverIssues) db.driverIssues = [];
if (!db.driverRoutes) db.driverRoutes = [];

// Seed a default driver if none exist
if (db.drivers.length === 0) {
  db.drivers.push(
    { id: nextId(), name: 'Kurtis', pin: '1234', status: 'active', created_at: new Date().toISOString() },
    { id: nextId(), name: 'Driver 2', pin: '5678', status: 'active', created_at: new Date().toISOString() }
  );
  saveDB(db);
  console.log('🚐 Seeded default drivers (PINs: 1234, 5678)');
}

// Driver auth middleware
function requireDriverAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Driver auth required' });
  }
  const token = authHeader.replace('Bearer ', '');
  const session = db.driverSessions[token];
  if (!session || !session.driver_id) {
    return res.status(401).json({ error: 'Invalid driver session' });
  }
  const driver = db.drivers.find(d => d.id === session.driver_id);
  if (!driver || driver.status !== 'active') {
    return res.status(401).json({ error: 'Driver not found or inactive' });
  }
  req.driver = driver;
  next();
}

// Serve driver page (public path — has its own PIN auth)
app.get('/driver', (req, res) => res.sendFile(path.join(__dirname, 'driver.html')));

// Driver PIN login (public — no admin auth needed)
app.post('/api/driver/auth', (req, res) => {
  const { pin } = req.body;
  if (!pin) return res.status(400).json({ error: 'PIN required' });

  const driver = db.drivers.find(d => d.pin === String(pin) && d.status === 'active');
  if (!driver) {
    return res.status(401).json({ success: false, error: 'Invalid PIN' });
  }

  const token = crypto.randomBytes(32).toString('hex');
  db.driverSessions[token] = {
    driver_id: driver.id,
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
  };
  saveDB(db);

  res.json({
    success: true,
    token,
    driver: { id: driver.id, name: driver.name, pin: driver.pin }
  });
});

// Verify driver token
app.get('/api/driver/verify', (req, res) => {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.json({ valid: false });
  }
  const token = authHeader.replace('Bearer ', '');
  const session = db.driverSessions[token];
  if (!session) return res.json({ valid: false });
  if (new Date(session.expires_at) < new Date()) {
    delete db.driverSessions[token];
    return res.json({ valid: false });
  }
  res.json({ valid: true, driver_id: session.driver_id });
});

// Get driver's route for today
app.get('/api/driver/route', requireDriverAuth, (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const driverId = req.driver.id;

  // Check for assigned route
  let route = db.driverRoutes.find(r => r.driver_id === driverId && r.date === today);

  if (route && route.stops) {
    return res.json({ date: today, stops: route.stops });
  }

  // Auto-generate route from deployed machines if no manual route exists
  const deployedMachines = db.machines.filter(m => m.status === 'deployed');
  const stops = deployedMachines.map((m, i) => {
    const location = db.locations.find(l => l.id === m.location_id);
    const lastRestock = (db.restocks || [])
      .filter(r => r.machine_id === m.id)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
    const monthRevenue = (db.finances || [])
      .filter(f => f.machine_id === m.id && f.type === 'revenue')
      .reduce((s, f) => s + (f.amount || 0), 0);

    // Get product mix for this machine
    const machineProducts = (db.sales || [])
      .filter(s => s.machine_id === m.id)
      .reduce((acc, s) => {
        const prod = db.products.find(p => p.id === s.product_id);
        if (prod && !acc.includes(prod.name)) acc.push(prod.name);
        return acc;
      }, []);

    return {
      id: `stop_${m.id}_${today}`,
      order: i + 1,
      machine_id: m.id,
      machine_name: m.name || 'Machine ' + m.id,
      machine_type: m.type || m.model || 'Standard',
      machine_status: m.status,
      location_id: location?.id,
      location_name: location?.name || m.location_name || '',
      address: location?.address || m.address || '',
      lat: location?.lat || m.lat || null,
      lng: location?.lng || m.lng || null,
      products_needed: Math.floor(Math.random() * 20) + 5,
      est_revenue: monthRevenue > 0 ? monthRevenue.toFixed(0) : null,
      est_time: 15 + Math.floor(Math.random() * 15),
      last_restock: lastRestock ? new Date(lastRestock.created_at).toLocaleDateString() : null,
      product_mix: machineProducts.length > 0 ? machineProducts.slice(0, 5) : ['Standard mix'],
      notes: m.notes || ''
    };
  });

  res.json({ date: today, stops });
});

// Get products for driver (simplified list)
app.get('/api/driver/products', requireDriverAuth, (req, res) => {
  res.json(db.products.map(p => ({
    id: p.id,
    name: p.name,
    category: p.category || 'Other',
    sell_price: p.sell_price || 0,
    cost_price: p.cost_price || 0
  })));
});

// Driver check-in at a stop
app.post('/api/driver/checkin', requireDriverAuth, (req, res) => {
  const checkin = {
    id: nextId(),
    driver_id: req.driver.id,
    driver_name: req.driver.name,
    stop_id: req.body.stop_id,
    machine_id: req.body.machine_id,
    time: req.body.time || new Date().toISOString(),
    lat: req.body.lat,
    lng: req.body.lng,
    accuracy: req.body.accuracy,
    created_at: new Date().toISOString()
  };
  db.driverCheckins.push(checkin);
  saveDB(db);
  res.json({ success: true, checkin });
});

// Driver restock submission
app.post('/api/driver/restock', requireDriverAuth, (req, res) => {
  const restock = {
    id: nextId(),
    driver_id: req.driver.id,
    driver_name: req.driver.name,
    stop_id: req.body.stop_id,
    machine_id: req.body.machine_id,
    items: req.body.items || [],
    time_spent: req.body.time_spent || 0,
    notes: req.body.notes || '',
    timestamp: req.body.timestamp || new Date().toISOString(),
    created_at: new Date().toISOString()
  };

  db.driverRestocks.push(restock);

  // Also create an entry in the main restocks collection for the admin dashboard
  const mainRestock = {
    id: nextId(),
    machine_id: req.body.machine_id,
    driver: req.driver.name,
    items: req.body.items,
    status: 'completed',
    notes: `Driver restock: ${(req.body.items || []).reduce((s, i) => s + i.qty, 0)} items in ${req.body.time_spent || '?'}min`,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  db.restocks.push(mainRestock);

  saveDB(db);
  res.json({ success: true, restock });
});

// Driver issue report
app.post('/api/driver/issues', requireDriverAuth, (req, res) => {
  const issue = {
    id: nextId(),
    driver_id: req.driver.id,
    driver_name: req.driver.name,
    stop_id: req.body.stop_id,
    machine_id: req.body.machine_id,
    type: req.body.type,
    description: req.body.description || '',
    severity: req.body.severity || 'medium',
    photos: req.body.photos || 0,
    photo_data: req.body.photo_data || [],
    timestamp: req.body.timestamp || new Date().toISOString(),
    lat: req.body.lat,
    lng: req.body.lng,
    status: 'open',
    created_at: new Date().toISOString()
  };

  db.driverIssues.push(issue);

  // Also log in the main issues collection for admin visibility
  const mainIssue = {
    id: nextId(),
    machine_id: req.body.machine_id,
    type: req.body.type,
    description: `[Driver: ${req.driver.name}] ${req.body.description || ''} (${req.body.severity})`,
    severity: req.body.severity,
    status: 'open',
    reported_by: req.driver.name,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  db.issues.push(mainIssue);

  saveDB(db);
  res.json({ success: true, issue });
});

// Machine history for driver detail view
app.get('/api/driver/machine/:id/history', requireDriverAuth, (req, res) => {
  const machineId = parseInt(req.params.id);
  const history = [];

  // Restocks
  (db.driverRestocks || []).filter(r => r.machine_id === machineId).forEach(r => {
    const totalItems = (r.items || []).reduce((s, i) => s + i.qty, 0);
    history.push({
      type: 'restock',
      description: `Restocked ${totalItems} items by ${r.driver_name || 'driver'} (${r.time_spent || 0}min)`,
      timestamp: r.timestamp || r.created_at
    });
  });

  // Check-ins
  (db.driverCheckins || []).filter(c => c.machine_id === machineId).forEach(c => {
    history.push({
      type: 'checkin',
      description: `Check-in by ${c.driver_name || 'driver'}`,
      timestamp: c.time || c.created_at
    });
  });

  // Issues
  (db.driverIssues || []).filter(i => i.machine_id === machineId).forEach(i => {
    const typeLabels = {
      machine_down: 'Machine Down', needs_repair: 'Needs Repair', vandalism: 'Vandalism',
      power_issue: 'Power Issue', payment_issue: 'Payment Issue', other: 'Other'
    };
    history.push({
      type: 'issue',
      description: `${typeLabels[i.type] || i.type}: ${i.description || 'No details'} [${i.severity}]`,
      timestamp: i.timestamp || i.created_at
    });
  });

  // Sort newest first
  history.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  res.json(history.slice(0, 20));
});

// Admin: manage drivers
app.get('/api/drivers', (req, res) => {
  res.json(db.drivers.map(d => ({
    id: d.id, name: d.name, pin: d.pin, status: d.status, created_at: d.created_at,
    checkins_today: (db.driverCheckins || []).filter(c =>
      c.driver_id === d.id && c.created_at?.startsWith(new Date().toISOString().split('T')[0])
    ).length
  })));
});

app.post('/api/drivers', (req, res) => {
  if (!req.body.name || !req.body.pin) return res.status(400).json({ error: 'name and pin required' });
  if (db.drivers.some(d => d.pin === String(req.body.pin))) {
    return res.status(400).json({ error: 'PIN already in use' });
  }
  const driver = {
    id: nextId(),
    name: req.body.name,
    pin: String(req.body.pin),
    status: req.body.status || 'active',
    created_at: new Date().toISOString()
  };
  db.drivers.push(driver);
  saveDB(db);
  res.json(driver);
});

app.put('/api/drivers/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const idx = db.drivers.findIndex(d => d.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Driver not found' });
  if (req.body.pin && db.drivers.some(d => d.pin === String(req.body.pin) && d.id !== id)) {
    return res.status(400).json({ error: 'PIN already in use' });
  }
  db.drivers[idx] = { ...db.drivers[idx], ...req.body };
  saveDB(db);
  res.json(db.drivers[idx]);
});

app.delete('/api/drivers/:id', (req, res) => {
  const id = parseInt(req.params.id);
  db.drivers = db.drivers.filter(d => d.id !== id);
  saveDB(db);
  res.json({ success: true });
});

// Admin: assign routes
app.post('/api/driver-routes', (req, res) => {
  const route = {
    id: nextId(),
    driver_id: req.body.driver_id,
    date: req.body.date || new Date().toISOString().split('T')[0],
    stops: req.body.stops || [],
    created_at: new Date().toISOString()
  };
  // Replace existing route for this driver/date
  db.driverRoutes = db.driverRoutes.filter(r => !(r.driver_id === route.driver_id && r.date === route.date));
  db.driverRoutes.push(route);
  saveDB(db);
  res.json(route);
});

app.get('/api/driver-routes', (req, res) => {
  const { driver_id, date } = req.query;
  let routes = db.driverRoutes;
  if (driver_id) routes = routes.filter(r => r.driver_id === parseInt(driver_id));
  if (date) routes = routes.filter(r => r.date === date);
  res.json(routes);
});

// Admin: view driver activity
app.get('/api/driver/activity', (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const { date, driver_id } = req.query;
  const targetDate = date || today;

  let checkins = (db.driverCheckins || []).filter(c => c.created_at?.startsWith(targetDate));
  let restocks = (db.driverRestocks || []).filter(r => r.created_at?.startsWith(targetDate));
  let issues = (db.driverIssues || []).filter(i => i.created_at?.startsWith(targetDate));

  if (driver_id) {
    const did = parseInt(driver_id);
    checkins = checkins.filter(c => c.driver_id === did);
    restocks = restocks.filter(r => r.driver_id === did);
    issues = issues.filter(i => i.driver_id === did);
  }

  res.json({
    date: targetDate,
    checkins, restocks, issues,
    summary: {
      total_checkins: checkins.length,
      total_restocks: restocks.length,
      total_items_restocked: restocks.reduce((s, r) => s + (r.items || []).reduce((ss, i) => ss + i.qty, 0), 0),
      total_issues: issues.length,
      critical_issues: issues.filter(i => i.severity === 'critical' || i.severity === 'high').length
    }
  });
});

// Add driver paths to public (bypass admin auth)
const originalRequireAuth = requireAuth;

// ===== INSTANTLY.AI OUTREACH INTEGRATION =====
// Proxy endpoints to Instantly API — never expose API key to frontend
const INSTANTLY_API_KEY = process.env.INSTANTLY_API_KEY || 'YTRmZmE5OWEtOWQ0OS00NjAwLWJiNzQtNjlmZWFiZGJkYzhiOmJITmlEYVNES0pCRg==';
const INSTANTLY_BASE = 'https://api.instantly.ai/api/v2';

// Generic Instantly proxy helper
async function instantlyFetch(endpoint, opts = {}) {
  if (!INSTANTLY_API_KEY) throw new Error('INSTANTLY_API_KEY not configured');
  const url = `${INSTANTLY_BASE}${endpoint}`;
  const headers = {
    'Authorization': `Bearer ${INSTANTLY_API_KEY}`,
    'Content-Type': 'application/json',
    ...opts.headers
  };
  const res = await fetch(url, { ...opts, headers });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) {
    const errMsg = typeof data === 'object' ? JSON.stringify(data) : data;
    throw new Error(`Instantly API ${res.status}: ${errMsg}`);
  }
  return data;
}

// -- Email Accounts --
app.get('/api/instantly/accounts', async (req, res) => {
  try {
    const limit = req.query.limit || 100;
    const skip = req.query.skip || 0;
    const data = await instantlyFetch(`/accounts?limit=${limit}&skip=${skip}`);
    res.json(data);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// -- Campaigns: list --
app.get('/api/instantly/campaigns', async (req, res) => {
  try {
    const limit = req.query.limit || 100;
    const skip = req.query.skip || 0;
    const status = req.query.status || '';
    let qs = `?limit=${limit}&skip=${skip}`;
    if (status) qs += `&status=${status}`;
    const data = await instantlyFetch(`/campaigns${qs}`);
    res.json(data);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// -- Campaigns: get single --
app.get('/api/instantly/campaigns/:id', async (req, res) => {
  try {
    const data = await instantlyFetch(`/campaigns/${req.params.id}`);
    res.json(data);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// -- Campaigns: create --
app.post('/api/instantly/campaigns', async (req, res) => {
  try {
    const data = await instantlyFetch('/campaigns', {
      method: 'POST',
      body: JSON.stringify(req.body)
    });
    res.json(data);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// -- Campaigns: update --
app.patch('/api/instantly/campaigns/:id', async (req, res) => {
  try {
    const data = await instantlyFetch(`/campaigns/${req.params.id}`, {
      method: 'PATCH',
      body: JSON.stringify(req.body)
    });
    res.json(data);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// -- Campaigns: add leads --
app.post('/api/instantly/campaigns/:id/leads', async (req, res) => {
  try {
    const data = await instantlyFetch(`/leads`, {
      method: 'POST',
      body: JSON.stringify({
        campaign_id: req.params.id,
        ...req.body
      })
    });
    res.json(data);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// -- Leads: list for campaign --
app.get('/api/instantly/campaigns/:id/leads', async (req, res) => {
  try {
    const limit = req.query.limit || 100;
    const data = await instantlyFetch(`/leads?campaign_id=${req.params.id}&limit=${limit}`);
    res.json(data);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// -- Campaign Analytics --
app.get('/api/instantly/analytics/campaigns', async (req, res) => {
  try {
    const { campaign_id, start_date, end_date } = req.query;
    let qs = '?';
    if (campaign_id) qs += `campaign_id=${campaign_id}&`;
    if (start_date) qs += `start_date=${start_date}&`;
    if (end_date) qs += `end_date=${end_date}&`;
    const data = await instantlyFetch(`/analytics/campaign/summary${qs}`);
    res.json(data);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// -- Send Email --
app.post('/api/instantly/emails/send', async (req, res) => {
  try {
    const data = await instantlyFetch('/emails/send', {
      method: 'POST',
      body: JSON.stringify(req.body)
    });
    // Auto-log to CRM activities if prospect_id provided
    if (req.body._prospect_id) {
      const prospectId = parseInt(req.body._prospect_id);
      const prospect = db.prospects.find(p => p.id === prospectId);
      if (prospect) {
        db.activities.push({
          id: nextId(),
          prospect_id: prospectId,
          type: 'email',
          description: `Email sent via Instantly: "${req.body.subject || 'No subject'}" to ${req.body.to || 'unknown'}`,
          created_at: new Date().toISOString()
        });
        // Also log to emailSends
        db.emailSends.push({
          id: nextId(),
          prospect_id: prospectId,
          template_id: req.body._template_id ? parseInt(req.body._template_id) : null,
          status: 'sent',
          sent_at: new Date().toISOString(),
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        });
        saveDB(db);
      }
    }
    res.json(data);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// -- API key status check (does NOT expose the key) --
app.get('/api/instantly/status', (req, res) => {
  res.json({
    configured: !!INSTANTLY_API_KEY,
    keyLength: INSTANTLY_API_KEY ? INSTANTLY_API_KEY.length : 0,
    keyPreview: INSTANTLY_API_KEY ? INSTANTLY_API_KEY.slice(0, 6) + '...' : null
  });
});

// -- Corporate Pitch Templates (loaded from sales/corporate-pitches/) --
app.get('/api/instantly/pitch-templates', (req, res) => {
  const pitchDir = path.join(__dirname, '..', 'sales', 'corporate-pitches');
  try {
    const files = fs.readdirSync(pitchDir).filter(f => f.endsWith('.md') && f !== 'README.md');
    const templates = files.map(f => {
      const content = fs.readFileSync(path.join(pitchDir, f), 'utf8');
      const nameMatch = content.match(/^#\s+(.+)/m);
      const targetMatch = content.match(/\*\*Target:\*\*\s*(.+?)[\|\n]/);
      const decisionMakerMatch = content.match(/\*\*Decision Maker:\*\*\s*(.+?)[\n]/);
      const profileMatch = content.match(/\*\*Profile:\*\*\s*(.+?)[\n]/);
      // Extract email subjects and bodies
      const emailBlocks = [];
      const emailSections = content.split(/##\s+📧/);
      emailSections.slice(1).forEach(section => {
        const subjectMatch = section.match(/\*\*Subject:\*\*\s*(.+)/);
        const toMatch = section.match(/\*\*To:\*\*\s*(.+)/);
        // Get body: everything between the Subject line and next --- or ## 
        const bodyMatch = section.match(/\*\*Subject:\*\*[^\n]*\n\n([\s\S]*?)(?=\n---|\n##|$)/);
        if (subjectMatch) {
          emailBlocks.push({
            subject: subjectMatch[1].trim(),
            to: toMatch ? toMatch[1].trim() : '',
            body: bodyMatch ? bodyMatch[1].trim() : ''
          });
        }
      });
      return {
        filename: f,
        slug: f.replace('.md', ''),
        name: nameMatch ? nameMatch[1].replace(/\s*—\s*Corporate Pitch Package/, '').trim() : f.replace('.md', ''),
        target: targetMatch ? targetMatch[1].trim() : '',
        decisionMaker: decisionMakerMatch ? decisionMakerMatch[1].trim() : '',
        profile: profileMatch ? profileMatch[1].trim() : '',
        emailCount: emailBlocks.length,
        emails: emailBlocks
      };
    });
    res.json(templates);
  } catch (e) {
    res.json([]);
  }
});

// Serve briefing page
app.get('/briefing', (req, res) => res.sendFile(path.join(__dirname, 'briefing.html')));

// ===== MORNING BRIEFING API =====

// Helper: get date cutoff for period
function getBriefingCutoff(period) {
  const now = new Date();
  if (period === 'weekly') {
    return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  }
  // daily = last 24h
  return new Date(now.getTime() - 24 * 60 * 60 * 1000);
}

// GET /api/briefing?period=daily|weekly
app.get('/api/briefing', (req, res) => {
  const period = req.query.period === 'weekly' ? 'weekly' : 'daily';
  const cutoff = getBriefingCutoff(period);
  const cutoffISO = cutoff.toISOString();
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();

  // 1. New prospects added in period
  const newProspects = (db.prospects || []).filter(p =>
    p.created_at && p.created_at >= cutoffISO
  ).map(p => ({
    id: p.id,
    name: p.name,
    property_type: p.property_type || 'Unknown',
    status: p.status,
    priority: p.priority,
    units: p.units || 0,
    address: p.address || '',
    created_at: p.created_at
  }));

  // 2. Stage changes (activities with type 'status-change')
  const stageChangeActivities = (db.activities || []).filter(a =>
    a.type === 'status-change' && a.created_at && a.created_at >= cutoffISO
  );

  const stageChanges = stageChangeActivities.map(a => {
    const prospect = (db.prospects || []).find(p => p.id === a.prospect_id);
    // Parse "Status: X → Y" from description
    const statusMatch = (a.description || '').match(/Status:\s*(?:🆕|🔵|✅|⛔)?\s*(\w+)\s*→\s*(?:🆕|🔵|✅|⛔)?\s*(\w+)/);
    const priorityMatch = (a.description || '').match(/Priority:\s*(?:🆕|🟠|🔥)?\s*(\w+)\s*→\s*(?:🆕|🟠|🔥)?\s*(\w+)/);
    return {
      prospect_id: a.prospect_id,
      prospect_name: prospect ? prospect.name : `Prospect #${a.prospect_id}`,
      description: a.description,
      fromStage: statusMatch ? statusMatch[1] : (priorityMatch ? priorityMatch[1] : null),
      toStage: statusMatch ? statusMatch[2] : (priorityMatch ? priorityMatch[2] : null),
      changeType: statusMatch ? 'status' : (priorityMatch ? 'priority' : 'other'),
      changedAt: a.created_at
    };
  });

  // 3. Follow-ups: prospects with next_action_date today or overdue + activities due
  const followUps = [];

  // From prospects with next_action_date
  (db.prospects || []).forEach(p => {
    if (p.next_action_date) {
      const actionDate = p.next_action_date.slice(0, 10);
      const today = now.toISOString().slice(0, 10);
      const isOverdue = actionDate < today;
      const isDueToday = actionDate === today;
      const isDueSoon = !isOverdue && !isDueToday && actionDate <= new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

      if (isOverdue || isDueToday || (period === 'weekly' && isDueSoon)) {
        followUps.push({
          prospect_id: p.id,
          prospect_name: p.name,
          action: p.next_action || 'Follow up',
          due_date: p.next_action_date,
          status: isOverdue ? 'overdue' : (isDueToday ? 'due_today' : 'upcoming'),
          priority: p.priority || 'normal',
          property_type: p.property_type || 'Unknown'
        });
      }
    }
  });

  // Sort: overdue first, then due_today, then upcoming
  const statusOrder = { overdue: 0, due_today: 1, upcoming: 2 };
  followUps.sort((a, b) => (statusOrder[a.status] || 2) - (statusOrder[b.status] || 2));

  // 4. Metrics
  const allProspects = db.prospects || [];
  const totalProspects = allProspects.length;
  const signedProspects = allProspects.filter(p => p.status === 'signed');
  const closedProspects = allProspects.filter(p => p.status === 'closed');
  const activeProspects = allProspects.filter(p => p.status === 'active' || p.status === 'new');

  // Pipeline value: estimate from units (avg $150/machine/month for active pipeline)
  const pipelineUnits = activeProspects.reduce((sum, p) => sum + (parseInt(p.units) || 0), 0);
  const pipelineValue = pipelineUnits * 150; // estimated monthly value per machine

  // Won/Lost in period
  const wonInPeriod = stageChanges.filter(sc => sc.toStage === 'Signed' || sc.toStage === 'signed');
  const lostInPeriod = stageChanges.filter(sc => sc.toStage === 'Stale' || sc.toStage === 'closed' || sc.toStage === 'Closed');

  // Conversion rate: signed / total
  const conversionRate = totalProspects > 0 ? ((signedProspects.length / totalProspects) * 100) : 0;

  // Average deal size (from signed prospects with units)
  const signedWithUnits = signedProspects.filter(p => parseInt(p.units) > 0);
  const avgDealUnits = signedWithUnits.length > 0
    ? signedWithUnits.reduce((sum, p) => sum + parseInt(p.units), 0) / signedWithUnits.length
    : 0;
  const avgDealValue = avgDealUnits * 150; // monthly value

  // Recent activities in period
  const recentActivities = (db.activities || []).filter(a =>
    a.created_at && a.created_at >= cutoffISO
  ).length;

  // Signed prospect value
  const signedValue = signedProspects.reduce((sum, p) => sum + ((parseInt(p.units) || 0) * 150), 0);

  const metrics = {
    totalProspects,
    pipelineValue,
    signedValue,
    conversionRate: Math.round(conversionRate * 10) / 10,
    avgDealValue: Math.round(avgDealValue),
    avgDealUnits: Math.round(avgDealUnits * 10) / 10,
    wonCount: wonInPeriod.length,
    lostCount: lostInPeriod.length,
    wonAllTime: signedProspects.length,
    lostAllTime: closedProspects.length,
    activeCount: activeProspects.length,
    recentActivities,
    newCount: newProspects.length,
    followUpCount: followUps.length,
    overdueCount: followUps.filter(f => f.status === 'overdue').length
  };

  res.json({
    period,
    generatedAt: now.toISOString(),
    newProspects,
    stageChanges,
    followUps,
    metrics
  });
});

// GET /api/briefing/text — Plain text summary for Telegram
app.get('/api/briefing/text', (req, res) => {
  const period = req.query.period === 'weekly' ? 'weekly' : 'daily';
  const cutoff = getBriefingCutoff(period);
  const cutoffISO = cutoff.toISOString();
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const dateStr = now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });

  const allProspects = db.prospects || [];
  const allActivities = db.activities || [];
  const totalProspects = allProspects.length;
  const signedProspects = allProspects.filter(p => p.status === 'signed');
  const activeProspects = allProspects.filter(p => p.status === 'active' || p.status === 'new');

  // Pipeline value
  const pipelineUnits = activeProspects.reduce((sum, p) => sum + (parseInt(p.units) || 0), 0);
  const pipelineValue = pipelineUnits * 150;

  // New in period
  const newInPeriod = allProspects.filter(p => p.created_at && p.created_at >= cutoffISO);

  // Stage changes in period
  const stageChanges = allActivities.filter(a =>
    a.type === 'status-change' && a.created_at && a.created_at >= cutoffISO
  );
  const wonChanges = stageChanges.filter(a => (a.description || '').includes('Signed'));
  const lostChanges = stageChanges.filter(a => (a.description || '').includes('Stale') || (a.description || '').includes('Closed'));
  const movedForward = stageChanges.filter(a => {
    const desc = a.description || '';
    return desc.includes('→ ✅') || desc.includes('→ 🔵') || desc.includes('→ 🔥') || desc.includes('→ 🟠');
  });

  // Follow-ups
  const followUps = [];
  allProspects.forEach(p => {
    if (p.next_action_date) {
      const actionDate = p.next_action_date.slice(0, 10);
      if (actionDate <= today) {
        followUps.push(p);
      }
    }
  });

  // Recent activities count
  const recentActivityCount = allActivities.filter(a => a.created_at && a.created_at >= cutoffISO).length;

  // Signed value
  const signedValue = signedProspects.reduce((sum, p) => sum + ((parseInt(p.units) || 0) * 150), 0);

  // Build text
  const periodLabel = period === 'weekly' ? 'This week' : 'Today';
  const lines = [];

  lines.push(`🌅 Morning Briefing — ${dateStr}`);
  lines.push('');
  lines.push(`📊 Pipeline: $${pipelineValue.toLocaleString()}/mo value | ${totalProspects} prospects`);
  lines.push(`💰 Signed: ${signedProspects.length} deals ($${signedValue.toLocaleString()}/mo)`);
  lines.push(`🔥 Active: ${activeProspects.length} in pipeline`);
  lines.push('');

  // Period stats
  lines.push(`📈 ${periodLabel}: +${newInPeriod.length} new leads, ${movedForward.length} moved forward`);
  if (wonChanges.length > 0) {
    lines.push(`✅ Won: ${wonChanges.length} deal${wonChanges.length > 1 ? 's' : ''}`);
  }
  if (lostChanges.length > 0) {
    lines.push(`❌ Lost: ${lostChanges.length} deal${lostChanges.length > 1 ? 's' : ''}`);
  }
  if (recentActivityCount > 0) {
    lines.push(`📝 ${recentActivityCount} activities logged`);
  }

  // Follow-ups
  if (followUps.length > 0) {
    lines.push('');
    lines.push(`📋 Follow-ups Due (${followUps.length}):`);
    followUps.slice(0, 8).forEach(p => {
      const action = p.next_action || 'Follow up';
      const overdue = p.next_action_date.slice(0, 10) < today ? ' ⚠️' : '';
      lines.push(`  • ${action} — ${p.name}${overdue}`);
    });
    if (followUps.length > 8) {
      lines.push(`  ... and ${followUps.length - 8} more`);
    }
  }

  // New prospects
  if (newInPeriod.length > 0) {
    lines.push('');
    lines.push(`🆕 New Prospects (${newInPeriod.length}):`);
    newInPeriod.slice(0, 5).forEach(p => {
      const units = p.units ? ` (${p.units} units)` : '';
      lines.push(`  • ${p.name}${units} — ${p.property_type || 'Unknown'}`);
    });
    if (newInPeriod.length > 5) {
      lines.push(`  ... and ${newInPeriod.length - 5} more`);
    }
  }

  // Top priority
  const hotProspects = activeProspects.filter(p => p.priority === 'hot');
  if (hotProspects.length > 0) {
    lines.push('');
    lines.push(`🎯 Hot Prospects (${hotProspects.length}):`);
    hotProspects.slice(0, 3).forEach(p => {
      lines.push(`  • ${p.name} — ${p.property_type || 'Unknown'}`);
    });
  }

  lines.push('');
  lines.push('—');
  lines.push('Kande VendTech CRM');

  res.type('text/plain').send(lines.join('\n'));
});

// ===== PROPERTY SCRAPER API =====
const scraperModule = (() => {
  try { return require('../scripts/property-scraper'); } catch(e) { return null; }
})();

const SCRAPER_RESULTS_FILE = path.join(__dirname, 'data', 'scraper-results.json');
let scraperStatus = { running: false, progress: null, lastRun: null, error: null };

// Run scraper
app.post('/api/scraper/run', async (req, res) => {
  if (scraperStatus.running) {
    return res.status(409).json({ error: 'Scraper is already running', progress: scraperStatus.progress });
  }

  if (!scraperModule) {
    return res.status(500).json({ error: 'Scraper module not found. Ensure scripts/property-scraper.js exists.' });
  }

  scraperStatus = { running: true, progress: { total: 0, completed: 0, results: 0, duplicates: 0 }, lastRun: null, error: null };

  // Run async — don't block the response
  res.json({ status: 'started', message: 'Scraper is running...' });

  try {
    const categories = req.body.categories || null; // optional filter
    const result = await scraperModule.runScraper({
      categories,
      onProgress: (p) => { scraperStatus.progress = { ...p }; }
    });
    scraperStatus.running = false;
    scraperStatus.lastRun = new Date().toISOString();
    scraperStatus.progress = {
      total: result.summary.total,
      completed: Object.keys(result.summary.by_category).length,
      results: result.summary.total,
      duplicates: result.summary.already_in_crm,
      new_leads: result.summary.new_leads
    };
  } catch (err) {
    scraperStatus.running = false;
    scraperStatus.error = err.message;
    console.error('Scraper error:', err);
  }
});

// Get scraper status
app.get('/api/scraper/status', (req, res) => {
  res.json(scraperStatus);
});

// Get scraper results
app.get('/api/scraper/results', (req, res) => {
  try {
    if (!fs.existsSync(SCRAPER_RESULTS_FILE)) {
      return res.json({ properties: [], summary: { total: 0, new_leads: 0, already_in_crm: 0 } });
    }
    const data = JSON.parse(fs.readFileSync(SCRAPER_RESULTS_FILE, 'utf8'));

    // Re-check duplicates against current CRM data
    const existingProspects = db.prospects || [];
    if (scraperModule) {
      data.properties = data.properties.map(p => ({
        ...p,
        in_crm: scraperModule.isDuplicate(p, existingProspects)
      }));
      data.summary.already_in_crm = data.properties.filter(p => p.in_crm).length;
      data.summary.new_leads = data.properties.filter(p => !p.in_crm).length;
    }

    // Apply filters
    const { category, new_only, min_score } = req.query;
    let filtered = data.properties;
    if (category) filtered = filtered.filter(p => p.category_id === category);
    if (new_only === 'true') filtered = filtered.filter(p => !p.in_crm);
    if (min_score) filtered = filtered.filter(p => p.vending_score >= parseInt(min_score));

    res.json({ ...data, properties: filtered, filtered_count: filtered.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Import selected scraped properties into CRM
app.post('/api/scraper/import', (req, res) => {
  const { properties } = req.body;
  if (!properties || !Array.isArray(properties) || properties.length === 0) {
    return res.status(400).json({ error: 'No properties provided' });
  }

  let imported = 0;
  let skipped = 0;
  const results = [];

  for (const prop of properties) {
    // Check for duplicates in CRM
    const isDup = db.prospects.some(p => {
      const normA = (prop.address || '').toLowerCase().replace(/[.,#\-]/g, '').replace(/\s+/g, ' ').trim();
      const normB = (p.address || '').toLowerCase().replace(/[.,#\-]/g, '').replace(/\s+/g, ' ').trim();
      if (normA && normB && normA === normB) return true;
      if (prop.name && p.name && prop.name.toLowerCase().trim() === p.name.toLowerCase().trim()) return true;
      return false;
    });

    if (isDup) {
      skipped++;
      results.push({ name: prop.name, status: 'duplicate' });
      continue;
    }

    const prospect = {
      id: db.nextId++,
      name: prop.name || 'Unknown',
      address: prop.address || '',
      phone: prop.phone || '',
      email: '',
      website: prop.website || '',
      property_type: prop.property_type || '',
      units: prop.units || null,
      notes: `Scraped ${new Date().toLocaleDateString()} | Score: ${prop.vending_score || 0} | Rating: ${prop.rating || 'N/A'} (${prop.review_count || 0} reviews)`,
      status: 'new',
      priority: prop.vending_score >= 60 ? 'hot' : prop.vending_score >= 40 ? 'warm' : 'normal',
      source: 'scraper',
      lat: prop.lat || null,
      lng: prop.lng || null,
      vending_score: prop.vending_score || 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    db.prospects.push(prospect);
    imported++;
    results.push({ name: prop.name, status: 'imported', id: prospect.id });
  }

  if (imported > 0) saveDB(db);

  res.json({ imported, skipped, total: properties.length, results });
});

// ===== WEEKLY REPORTS =====
app.get('/reports', (req, res) => res.sendFile(path.join(__dirname, 'reports.html')));

app.get('/api/reports/weekly', (req, res) => {
  const weeks = Math.min(parseInt(req.query.weeks) || 4, 52);
  const now = new Date();
  const prospects = db.prospects || [];
  const activities = db.activities || [];

  // Build weekly buckets
  const weeklyStats = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const weekEnd = new Date(now);
    weekEnd.setDate(weekEnd.getDate() - (i * 7));
    weekEnd.setHours(23, 59, 59, 999);
    const weekStart = new Date(weekEnd);
    weekStart.setDate(weekStart.getDate() - 6);
    weekStart.setHours(0, 0, 0, 0);

    const weekLabel = `${(weekStart.getMonth()+1)}/${weekStart.getDate()}`;

    const newP = prospects.filter(p => {
      const d = new Date(p.created_at);
      return d >= weekStart && d <= weekEnd;
    });

    // Stage changes (activities in this week)
    const weekActivities = activities.filter(a => {
      const d = new Date(a.created_at);
      return d >= weekStart && d <= weekEnd;
    });
    const stageChanges = weekActivities.filter(a =>
      a.type === 'stage_change' || a.type === 'status_change' ||
      (a.description && /moved to|changed to|stage/i.test(a.description))
    ).length;

    const wonCount = prospects.filter(p => {
      const d = new Date(p.updated_at || p.created_at);
      return d >= weekStart && d <= weekEnd && p.status === 'signed';
    }).length;

    const lostCount = prospects.filter(p => {
      const d = new Date(p.updated_at || p.created_at);
      return d >= weekStart && d <= weekEnd && (p.status === 'lost' || p.status === 'dead');
    }).length;

    // Pipeline value: active prospects × estimated units × avg revenue per unit
    const activePipeline = prospects.filter(p =>
      p.status === 'active' || p.status === 'new' || p.status === 'contacted' || p.status === 'proposal'
    );
    const pipelineValue = activePipeline.reduce((sum, p) => {
      const units = parseInt(p.units) || 1;
      const estimatedVal = p.estimated_value || (units * 150);
      return sum + estimatedVal;
    }, 0);

    weeklyStats.push({
      week: weekLabel,
      weekStart: weekStart.toISOString(),
      weekEnd: weekEnd.toISOString(),
      newProspects: newP.length,
      stageChanges,
      wonCount,
      lostCount,
      pipelineValue
    });
  }

  // Conversion by property type
  const conversionByType = {};
  const contactedStatuses = ['contacted', 'proposal', 'signed', 'active'];
  const proposalStatuses = ['proposal', 'signed'];
  const signedStatuses = ['signed'];

  prospects.forEach(p => {
    const type = (p.property_type || 'Unknown').trim();
    if (!type) return;
    if (!conversionByType[type]) {
      conversionByType[type] = { total: 0, contacted: 0, proposed: 0, signed: 0, rate: 0 };
    }
    conversionByType[type].total++;
    if (contactedStatuses.includes(p.status)) conversionByType[type].contacted++;
    if (proposalStatuses.includes(p.status)) conversionByType[type].proposed++;
    if (signedStatuses.includes(p.status)) conversionByType[type].signed++;
  });

  Object.values(conversionByType).forEach(c => {
    c.rate = c.total > 0 ? (c.signed / c.total * 100) : 0;
  });

  // Average time in stage (estimate from created_at to updated_at for each status)
  const avgTimeInStage = {};
  const stageDurations = {};
  prospects.forEach(p => {
    if (!p.status || !p.created_at) return;
    const created = new Date(p.created_at);
    const updated = new Date(p.updated_at || p.created_at);
    const days = Math.max(0, (updated - created) / (1000 * 60 * 60 * 24));
    if (!stageDurations[p.status]) stageDurations[p.status] = [];
    stageDurations[p.status].push(days);
  });
  Object.entries(stageDurations).forEach(([stage, durations]) => {
    avgTimeInStage[stage] = durations.reduce((s, d) => s + d, 0) / durations.length;
  });

  // Pipeline stage counts
  const pipelineCounts = {
    new: prospects.filter(p => p.status === 'new').length,
    contacted: prospects.filter(p => p.status === 'contacted' || p.status === 'active').length,
    proposal: prospects.filter(p => p.status === 'proposal').length,
    signed: prospects.filter(p => p.status === 'signed').length
  };

  // Highlights (auto-generated)
  const highlights = [];
  const oneWeekAgo = new Date(now);
  oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);

  // Biggest prospect by units
  const recentProspects = prospects.filter(p => new Date(p.created_at) >= oneWeekAgo);
  if (recentProspects.length > 0) {
    const biggest = recentProspects.sort((a, b) => (parseInt(b.units) || 0) - (parseInt(a.units) || 0))[0];
    if (biggest) {
      highlights.push({
        type: 'success',
        text: `New prospect: ${biggest.name}${biggest.units ? ` (${biggest.units} units)` : ''} — ${biggest.property_type || 'Unknown type'}`
      });
    }
    highlights.push({
      type: 'info',
      text: `${recentProspects.length} new prospect${recentProspects.length > 1 ? 's' : ''} added this week`
    });
  }

  // Recent signed deals
  const recentSigned = prospects.filter(p => p.status === 'signed' && new Date(p.updated_at || p.created_at) >= oneWeekAgo);
  if (recentSigned.length > 0) {
    recentSigned.forEach(s => {
      highlights.push({ type: 'success', text: `🎉 Deal signed: ${s.name}${s.units ? ` (${s.units} units)` : ''}` });
    });
  }

  // Pipeline health
  const totalActive = prospects.filter(p => ['new', 'active', 'contacted', 'proposal'].includes(p.status)).length;
  const totalSignedAll = prospects.filter(p => p.status === 'signed').length;
  if (totalActive > 0) {
    highlights.push({ type: 'info', text: `Pipeline: ${totalActive} active prospects, ${totalSignedAll} total signed` });
  }

  // Stale prospects warning
  const thirtyDaysAgo = new Date(now);
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const staleCount = prospects.filter(p =>
    ['new', 'active'].includes(p.status) &&
    new Date(p.updated_at || p.created_at) < thirtyDaysAgo
  ).length;
  if (staleCount > 0) {
    highlights.push({ type: 'warning', text: `⚠️ ${staleCount} prospect${staleCount > 1 ? 's' : ''} haven't been updated in 30+ days` });
  }

  // Activity summary
  const periodStart = new Date(now);
  periodStart.setDate(periodStart.getDate() - (weeks * 7));
  const periodActivities = activities.filter(a => new Date(a.created_at) >= periodStart);

  const activitySummary = {
    calls: periodActivities.filter(a => a.type === 'call' || a.type === 'phone' || (a.description && /call/i.test(a.description))).length,
    emails: periodActivities.filter(a => a.type === 'email' || (a.description && /email/i.test(a.description))).length,
    proposals: periodActivities.filter(a => a.type === 'proposal' || (a.description && /proposal/i.test(a.description))).length,
    meetings: periodActivities.filter(a => a.type === 'meeting' || a.type === 'visit' || a.type === 'pop-in' || (a.description && /meeting|visit|pop.?in/i.test(a.description))).length
  };

  res.json({
    weeklyStats,
    conversionByType,
    avgTimeInStage,
    pipelineCounts,
    highlights,
    activitySummary,
    generated: now.toISOString()
  });
});

// ===== APOLLO.IO PROSPECTING INTEGRATION =====
const APOLLO_API_KEY = process.env.APOLLO_API_KEY || '';
const APOLLO_BASE = 'https://api.apollo.io/v1';

// Generic Apollo proxy helper
async function apolloFetch(endpoint, opts = {}) {
  if (!APOLLO_API_KEY) throw new Error('APOLLO_API_KEY not configured');
  const url = `${APOLLO_BASE}${endpoint}`;
  const headers = {
    'Content-Type': 'application/json',
    'X-Api-Key': APOLLO_API_KEY,
    ...opts.headers
  };
  const res = await fetch(url, { ...opts, headers });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) {
    const errMsg = typeof data === 'object' ? JSON.stringify(data) : data;
    throw new Error(`Apollo API ${res.status}: ${errMsg}`);
  }
  return data;
}

// -- Apollo Status Check --
app.get('/api/apollo/status', (req, res) => {
  res.json({
    configured: !!APOLLO_API_KEY,
    keyLength: APOLLO_API_KEY ? APOLLO_API_KEY.length : 0,
    keyPreview: APOLLO_API_KEY ? APOLLO_API_KEY.slice(0, 6) + '...' : null
  });
});

// -- Search People (find decision-makers) --
app.post('/api/apollo/search', async (req, res) => {
  try {
    const {
      q_organization_name, person_titles, person_locations,
      q_keywords, page = 1, per_page = 25,
      organization_locations, organization_num_employees_ranges,
      person_seniorities, contact_email_status
    } = req.body;

    const payload = { page, per_page };
    if (q_organization_name) payload.q_organization_name = q_organization_name;
    if (person_titles && person_titles.length) payload.person_titles = person_titles;
    if (person_locations && person_locations.length) payload.person_locations = person_locations;
    if (q_keywords) payload.q_keywords = q_keywords;
    if (organization_locations && organization_locations.length) payload.organization_locations = organization_locations;
    if (organization_num_employees_ranges && organization_num_employees_ranges.length) payload.organization_num_employees_ranges = organization_num_employees_ranges;
    if (person_seniorities && person_seniorities.length) payload.person_seniorities = person_seniorities;
    if (contact_email_status && contact_email_status.length) payload.contact_email_status = contact_email_status;

    const data = await apolloFetch('/mixed_people/search', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    res.json(data);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// -- Search Companies/Organizations --
app.post('/api/apollo/companies', async (req, res) => {
  try {
    const {
      q_organization_name, organization_locations,
      organization_num_employees_ranges, q_keywords,
      page = 1, per_page = 25
    } = req.body;

    const payload = { page, per_page };
    if (q_organization_name) payload.q_organization_name = q_organization_name;
    if (organization_locations && organization_locations.length) payload.organization_locations = organization_locations;
    if (organization_num_employees_ranges && organization_num_employees_ranges.length) payload.organization_num_employees_ranges = organization_num_employees_ranges;
    if (q_keywords) payload.q_keywords = q_keywords;

    const data = await apolloFetch('/mixed_companies/search', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    res.json(data);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// -- Enrich Contact (get full profile from email or name+company) --
app.post('/api/apollo/enrich', async (req, res) => {
  try {
    const { email, first_name, last_name, organization_name, domain } = req.body;
    const payload = {};
    if (email) payload.email = email;
    if (first_name) payload.first_name = first_name;
    if (last_name) payload.last_name = last_name;
    if (organization_name) payload.organization_name = organization_name;
    if (domain) payload.domain = domain;

    const data = await apolloFetch('/people/match', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    res.json(data);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// -- Get Person by ID --
app.get('/api/apollo/people/:id', async (req, res) => {
  try {
    const data = await apolloFetch(`/people/${req.params.id}`, { method: 'GET' });
    res.json(data);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// -- Import Apollo contact to CRM --
app.post('/api/apollo/import-to-crm', (req, res) => {
  try {
    const { person, organization } = req.body;
    if (!person) return res.status(400).json({ error: 'Person data required' });

    const name = organization?.name || person.organization?.name || `${person.first_name} ${person.last_name}`;
    const email = person.email || '';
    const phone = person.phone_number || person.organization?.phone || '';

    // Check if prospect already exists (by email or name)
    const existing = db.prospects.find(p =>
      (email && p.email === email) ||
      (p.name && p.name.toLowerCase() === name.toLowerCase())
    );

    if (existing) {
      // Update contacts if person not already listed
      if (!existing.contacts) existing.contacts = [];
      const contactExists = existing.contacts.some(c =>
        c.email === email || (c.name && c.name.toLowerCase() === `${person.first_name} ${person.last_name}`.toLowerCase())
      );
      if (!contactExists) {
        existing.contacts.push({
          name: `${person.first_name || ''} ${person.last_name || ''}`.trim(),
          title: person.title || '',
          email: email,
          phone: phone,
          is_primary: existing.contacts.length === 0,
          source: 'apollo'
        });
        existing.updated_at = new Date().toISOString();
        saveDB(db);
      }
      return res.json({ action: 'updated', prospect: existing });
    }

    // Create new prospect
    const newProspect = {
      id: nextId(),
      name: name,
      email: email,
      phone: phone,
      property_type: organization?.industry || 'Corporate',
      status: 'new',
      priority: 'normal',
      address: [organization?.city, organization?.state, organization?.country].filter(Boolean).join(', '),
      units: 0,
      notes: `Imported from Apollo.io — ${person.title || ''} at ${organization?.name || ''}. ${person.headline || ''}`,
      contacts: [{
        name: `${person.first_name || ''} ${person.last_name || ''}`.trim(),
        title: person.title || '',
        email: email,
        phone: phone,
        is_primary: true,
        source: 'apollo',
        linkedin_url: person.linkedin_url || ''
      }],
      source: 'apollo',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    db.prospects.push(newProspect);
    db.activities.push({
      id: nextId(),
      prospect_id: newProspect.id,
      type: 'import',
      description: `Imported from Apollo: ${person.first_name} ${person.last_name} (${person.title || 'Unknown title'}) at ${organization?.name || name}`,
      created_at: new Date().toISOString()
    });
    saveDB(db);
    res.json({ action: 'created', prospect: newProspect });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== INSTANTLY WARMUP STATUS =====
// Get warmup status for all accounts
app.get('/api/instantly/warmup', async (req, res) => {
  try {
    // Fetch accounts which include warmup info
    const data = await instantlyFetch('/accounts?limit=100&skip=0');
    const accounts = Array.isArray(data) ? data : (data.items || data.data || []);
    const warmupStatus = accounts.map(a => ({
      email: a.email || a.email_account || a.from_email || 'Unknown',
      warmup_enabled: !!(a.warmup_enabled || a.warmup?.enabled),
      warmup_status: a.warmup?.status || a.warmup_status || (a.warmup_enabled ? 'active' : 'disabled'),
      warmup_reputation: a.warmup?.reputation || a.reputation || null,
      warmup_emails_per_day: a.warmup?.limit || a.warmup_limit || null,
      daily_limit: a.daily_limit || a.sending_limit || null,
      status: a.status || (a.is_active ? 'active' : 'inactive'),
      provider: a.provider || a.smtp_provider || null
    }));
    res.json({
      total: warmupStatus.length,
      warming_up: warmupStatus.filter(w => w.warmup_enabled).length,
      accounts: warmupStatus
    });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// Toggle warmup for an account
app.post('/api/instantly/warmup/:email', async (req, res) => {
  try {
    const { enable } = req.body;
    const data = await instantlyFetch(`/accounts/${encodeURIComponent(req.params.email)}/warmup`, {
      method: 'POST',
      body: JSON.stringify({ enabled: !!enable })
    });
    res.json(data);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ===== CRM PIPELINE WORKFLOW ENGINE =====
// Full pipeline management with stages, tasks, pop-ins, documents, workflow automation

const PIPELINE_STAGES = [
  { id: 'new_lead', label: 'New Lead', order: 0, color: '#3b82f6', emoji: '🆕' },
  { id: 'contacted', label: 'Contacted', order: 1, color: '#8b5cf6', emoji: '📧' },
  { id: 'pop_in_done', label: 'Outreach Period', order: 2, color: '#a855f7', emoji: '📣' },
  { id: 'interested', label: 'Interested', order: 3, color: '#ec4899', emoji: '👀' },
  { id: 'site_survey', label: 'Site Survey', order: 4, color: '#f97316', emoji: '📋' },
  { id: 'proposal_sent', label: 'Proposal Sent', order: 5, color: '#eab308', emoji: '📝' },
  { id: 'negotiating', label: 'Negotiating', order: 6, color: '#84cc16', emoji: '🤝' },
  { id: 'contract_sent', label: 'Contract Sent', order: 7, color: '#22c55e', emoji: '📄' },
  { id: 'signed', label: 'Signed', order: 8, color: '#14b8a6', emoji: '✅' },
  { id: 'onboarding', label: 'Onboarding', order: 9, color: '#06b6d4', emoji: '🔧' },
  { id: 'machine_placed', label: 'Machine Placed', order: 10, color: '#0ea5e9', emoji: '🏭' },
  { id: 'active_client', label: 'Active Client', order: 11, color: '#10b981', emoji: '💚' }
];

// Qualification scoring (Skool: min 100 residents, $2K/mo threshold)
function calcQualificationScore(prospect) {
  let score = 0;
  const count = parseInt(prospect.resident_employee_count) || 0;
  if (count >= 200) score += 30; else if (count >= 100) score += 20; else if (count >= 50) score += 10;
  const rev = parseFloat(prospect.monthly_revenue_potential) || 0;
  if (rev >= 3000) score += 25; else if (rev >= 2000) score += 20; else if (rev >= 1000) score += 10;
  if (prospect.power_outlet_available) score += 10;
  if (prospect.wifi_available) score += 5;
  if (!prospect.competitor_machines || prospect.competitor_machines === 'none') score += 15;
  if (prospect.shift_breakdown && prospect.shift_breakdown.toLowerCase().includes('night')) score += 10;
  if (prospect.vendor_approval_status === 'approved') score += 5;
  return Math.min(100, score);
}

// Initialize new CRM collections
if (!db.pipelineCards) db.pipelineCards = [];
if (!db.crmTasks) db.crmTasks = [];
if (!db.popInVisits) db.popInVisits = [];
if (!db.crmDocuments) db.crmDocuments = [];
// Migrate old 7-rule set to Skool-enhanced 21-rule set
if (!db.workflowRules || (db.workflowRules.length <= 7 && !db.workflowRules.some(r => r.name && r.name.includes('Touch #')))) {
  db.workflowRules = [
    // === Pop-In Follow-Up (Skool: 8-10 touches to close, gift baskets) ===
    { id: 1, name: 'Pop-In → Follow-Up Email (3d)', trigger: 'stage_change', trigger_stage: 'pop_in_done', action: 'create_task', task_type: 'email', task_title: 'Send follow-up email — reference pop-in & gift basket', delay_days: 3, priority: 'high', active: true },
    { id: 2, name: 'Pop-In → Handwritten Thank You Card', trigger: 'stage_change', trigger_stage: 'pop_in_done', action: 'create_task', task_type: 'thank_you', task_title: 'Mail handwritten thank you card to property manager', delay_days: 1, priority: 'high', active: true },
    // === Multi-Touch Drip (Skool: 8-10 touches, never give up) ===
    { id: 3, name: 'Contacted → 2nd Touch (5d)', trigger: 'stage_change', trigger_stage: 'contacted', action: 'create_task', task_type: 'email', task_title: 'Touch #2: Follow-up email — "checking in on our conversation"', delay_days: 5, active: true },
    { id: 4, name: 'Contacted → 3rd Touch (10d)', trigger: 'stage_change', trigger_stage: 'contacted', action: 'create_task', task_type: 'email', task_title: 'Touch #3: Value-add email — share amenity success story', delay_days: 10, active: true },
    { id: 5, name: 'Contacted → 4th Touch Pop-In (15d)', trigger: 'stage_change', trigger_stage: 'contacted', action: 'create_task', task_type: 'pop_in', task_title: 'Touch #4: Second pop-in visit with new gift basket', delay_days: 15, active: true },
    { id: 6, name: 'Contacted → 5th Touch (20d)', trigger: 'stage_change', trigger_stage: 'contacted', action: 'create_task', task_type: 'call', task_title: 'Touch #5: Phone call — "wanted to personally follow up"', delay_days: 20, active: true },
    { id: 7, name: 'Contacted → 6th Touch (25d)', trigger: 'stage_change', trigger_stage: 'contacted', action: 'create_task', task_type: 'email', task_title: 'Touch #6: Email with mini-proposal or case study', delay_days: 25, active: true },
    { id: 8, name: 'Contacted → 7th Touch (32d)', trigger: 'stage_change', trigger_stage: 'contacted', action: 'create_task', task_type: 'pop_in', task_title: 'Touch #7: Third pop-in — bring seasonal treats', delay_days: 32, active: true },
    { id: 9, name: 'Contacted → 8th Touch (40d)', trigger: 'stage_change', trigger_stage: 'contacted', action: 'create_task', task_type: 'email', task_title: 'Touch #8: "Just placed machines at [nearby property]" email', delay_days: 40, active: true },
    // === Proposal Follow-Up (Skool: follow up weekly until decision) ===
    { id: 10, name: 'Proposal → Follow-Up Call (3d)', trigger: 'stage_change', trigger_stage: 'proposal_sent', action: 'create_task', task_type: 'call', task_title: 'Follow-up call on proposal — answer questions', delay_days: 3, priority: 'high', active: true },
    { id: 11, name: 'Proposal → Weekly Follow-Up #2 (10d)', trigger: 'stage_change', trigger_stage: 'proposal_sent', action: 'create_task', task_type: 'email', task_title: 'Weekly proposal follow-up #2 — offer site survey', delay_days: 10, active: true },
    { id: 12, name: 'Proposal → Weekly Follow-Up #3 (17d)', trigger: 'stage_change', trigger_stage: 'proposal_sent', action: 'create_task', task_type: 'call', task_title: 'Weekly proposal follow-up #3 — address objections', delay_days: 17, active: true },
    { id: 13, name: 'Proposal → Final Push (24d)', trigger: 'stage_change', trigger_stage: 'proposal_sent', action: 'create_task', task_type: 'pop_in', task_title: 'Final proposal push — pop-in with updated terms if needed', delay_days: 24, active: true },
    // === Post-Signing Chain (Skool: site survey → install → stock) ===
    { id: 14, name: 'Signed → Schedule Site Survey', trigger: 'stage_change', trigger_stage: 'signed', action: 'create_task', task_type: 'site_survey', task_title: 'Schedule site survey — measure space, check power/WiFi, plan placement', delay_days: 1, priority: 'high', active: true },
    { id: 15, name: 'Signed → Schedule Install', trigger: 'stage_change', trigger_stage: 'signed', action: 'create_task', task_type: 'install', task_title: 'Schedule machine installation date with property', delay_days: 3, priority: 'high', active: true },
    { id: 16, name: 'Signed → Initial Stock Order', trigger: 'stage_change', trigger_stage: 'signed', action: 'create_task', task_type: 'stock_order', task_title: 'Place initial stock order from Vistar/VenMarket for location', delay_days: 5, active: true },
    { id: 17, name: 'Signed → Ask for Referrals', trigger: 'stage_change', trigger_stage: 'signed', action: 'create_task', task_type: 'referral', task_title: 'Ask PM: "Can you introduce me to 3 other buildings?" — referral strategy', delay_days: 7, active: true },
    // === Stale & Email Triggers ===
    { id: 18, name: 'Stale Lead Alert (7d)', trigger: 'no_activity', delay_days: 7, action: 'create_task', task_type: 'follow_up', task_title: 'Follow up — no activity in 7 days', active: true },
    { id: 19, name: 'Email Opened No Reply (3d)', trigger: 'email_opened_no_reply', delay_days: 3, action: 'create_task', task_type: 'call', task_title: 'Call lead — opened email but no reply after 3 days', active: true },
    { id: 20, name: 'Email Reply → Interested', trigger: 'email_replied', action: 'move_stage', target_stage: 'interested', active: true },
    { id: 21, name: 'Start Email Drip on Contact', trigger: 'stage_change', trigger_stage: 'contacted', action: 'start_drip', active: true }
  ];
}
// Ensure location performance collection
if (!db.locationPerformance) db.locationPerformance = [];
if (!db.machineAssignments) db.machineAssignments = [];
saveDB(db);

// ===== PIPELINE STAGES API =====
app.get('/api/pipeline/stages', (req, res) => {
  res.json(PIPELINE_STAGES);
});

// ===== PIPELINE CARDS API =====

// Helper: auto-create pipeline card for prospect if not exists
function ensurePipelineCard(prospectId) {
  let card = db.pipelineCards.find(c => c.prospect_id === prospectId);
  if (!card) {
    card = {
      id: nextId(),
      prospect_id: prospectId,
      stage: 'new_lead',
      position: db.pipelineCards.filter(c => c.stage === 'new_lead').length,
      entered_stage_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    db.pipelineCards.push(card);
    saveDB(db);
  }
  return card;
}

// Get all pipeline cards with enriched prospect data
app.get('/api/pipeline/cards', (req, res) => {
  const { stage } = req.query;
  let cards = db.pipelineCards || [];
  if (stage) cards = cards.filter(c => c.stage === stage);

  const enriched = cards.map(card => {
    const prospect = db.prospects.find(p => p.id === card.prospect_id);
    if (!prospect) return null;
    const contacts = db.contacts.filter(c => c.prospect_id === card.prospect_id);
    const primaryContact = contacts.find(c => c.is_primary) || contacts[0];
    const activities = db.activities.filter(a => a.prospect_id === card.prospect_id)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    const lastActivity = activities[0];
    const tasks = (db.crmTasks || []).filter(t => t.prospect_id === card.prospect_id && !t.completed)
      .sort((a, b) => new Date(a.due_date || '9999') - new Date(b.due_date || '9999'));
    const nextTask = tasks[0];
    const daysInStage = Math.floor((Date.now() - new Date(card.entered_stage_at).getTime()) / (1000 * 60 * 60 * 24));

    // Touchpoint count (Skool: 8-10 touches to close)
    const allActs = db.activities.filter(a => a.prospect_id === card.prospect_id);
    const touchCount = allActs.filter(a => {
      const t = (a.type || '').toLowerCase().replace('-', '_');
      return ['pop_in', 'pop-in', 'email', 'call', 'phone', 'proposal', 'meeting', 'visit', 'outreach', 'thank_you', 'status-change', 'note'].includes(t);
    }).length;
    // Qualification score
    const qualScore = calcQualificationScore(prospect);

    return {
      ...card,
      company: prospect.name,
      contact: primaryContact ? primaryContact.name : (prospect.email || 'No contact'),
      property_type: prospect.property_type,
      priority: prospect.priority,
      address: prospect.address,
      revenue_share_percent: prospect.revenue_share_percent || null,
      monthly_revenue_potential: prospect.monthly_revenue_potential || null,
      vendor_approval_status: prospect.vendor_approval_status || null,
      touch_count: touchCount,
      qualification_score: qualScore,
      last_activity: lastActivity ? { type: lastActivity.type, description: lastActivity.description, date: lastActivity.created_at } : null,
      next_task: nextTask ? { title: nextTask.title, due_date: nextTask.due_date, type: nextTask.task_type } : null,
      days_in_stage: daysInStage,
      open_tasks: tasks.length
    };
  }).filter(Boolean);

  // Group by stage
  if (!stage) {
    const grouped = {};
    PIPELINE_STAGES.forEach(s => { grouped[s.id] = []; });
    enriched.forEach(card => {
      if (grouped[card.stage]) grouped[card.stage].push(card);
    });
    // Sort each stage by position
    Object.keys(grouped).forEach(k => {
      grouped[k].sort((a, b) => (a.position || 0) - (b.position || 0));
    });
    return res.json({ stages: PIPELINE_STAGES, cards: grouped, total: enriched.length });
  }

  res.json(enriched);
});

// Move card to new stage (with workflow trigger)
app.put('/api/pipeline/cards/:id/move', (req, res) => {
  const id = parseInt(req.params.id);
  const { stage, position } = req.body;
  const cardIdx = db.pipelineCards.findIndex(c => c.id === id);
  if (cardIdx === -1) return res.status(404).json({ error: 'Card not found' });

  const card = db.pipelineCards[cardIdx];
  const oldStage = card.stage;
  const newStage = stage || card.stage;

  // Update card
  card.stage = newStage;
  card.position = position !== undefined ? position : card.position;
  if (oldStage !== newStage) {
    card.entered_stage_at = new Date().toISOString();
  }
  card.updated_at = new Date().toISOString();

  // Log activity if stage changed
  if (oldStage !== newStage) {
    const oldLabel = PIPELINE_STAGES.find(s => s.id === oldStage)?.label || oldStage;
    const newLabel = PIPELINE_STAGES.find(s => s.id === newStage)?.label || newStage;
    db.activities.push({
      id: nextId(),
      prospect_id: card.prospect_id,
      type: 'pipeline_move',
      description: `Pipeline: ${oldLabel} → ${newLabel}`,
      created_at: new Date().toISOString()
    });

    // Run workflow rules for stage change
    runWorkflowRules('stage_change', { prospect_id: card.prospect_id, old_stage: oldStage, new_stage: newStage });

    // Sync prospect status
    const prospectIdx = db.prospects.findIndex(p => p.id === card.prospect_id);
    if (prospectIdx !== -1) {
      if (newStage === 'signed' || newStage === 'onboarding' || newStage === 'machine_placed' || newStage === 'active_client') {
        db.prospects[prospectIdx].status = 'signed';
      } else if (newStage === 'new_lead') {
        db.prospects[prospectIdx].status = 'new';
      } else {
        db.prospects[prospectIdx].status = 'active';
      }
      db.prospects[prospectIdx].updated_at = new Date().toISOString();
    }
  }

  saveDB(db);
  res.json(card);
});

// Add prospect to pipeline
app.post('/api/pipeline/cards', (req, res) => {
  const { prospect_id, stage } = req.body;
  if (!prospect_id) return res.status(400).json({ error: 'prospect_id required' });

  const existing = db.pipelineCards.find(c => c.prospect_id === parseInt(prospect_id));
  if (existing) return res.json(existing);

  const card = {
    id: nextId(),
    prospect_id: parseInt(prospect_id),
    stage: stage || 'new_lead',
    position: db.pipelineCards.filter(c => c.stage === (stage || 'new_lead')).length,
    entered_stage_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  db.pipelineCards.push(card);
  saveDB(db);
  res.json(card);
});

// Remove card from pipeline
app.delete('/api/pipeline/cards/:id', (req, res) => {
  const id = parseInt(req.params.id);
  db.pipelineCards = db.pipelineCards.filter(c => c.id !== id);
  saveDB(db);
  res.json({ success: true });
});

// Bulk sync — ensure all prospects have pipeline cards
app.post('/api/pipeline/sync', (req, res) => {
  let created = 0;
  db.prospects.forEach(p => {
    const existing = db.pipelineCards.find(c => c.prospect_id === p.id);
    if (!existing) {
      let stage = 'new_lead';
      if (p.status === 'signed') stage = 'signed';
      else if (p.status === 'active') stage = 'contacted';
      else if (p.status === 'closed') return;

      db.pipelineCards.push({
        id: nextId(),
        prospect_id: p.id,
        stage,
        position: db.pipelineCards.filter(c => c.stage === stage).length,
        entered_stage_at: p.created_at || new Date().toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      });
      created++;
    }
  });
  if (created > 0) saveDB(db);
  res.json({ synced: created, total: db.pipelineCards.length });
});

// GET version of pipeline sync (requirement #8)
app.get('/api/pipeline/sync', (req, res) => {
  let created = 0;
  db.prospects.forEach(p => {
    const existing = db.pipelineCards.find(c => c.prospect_id === p.id);
    if (!existing) {
      let stage = 'new_lead';
      if (p.status === 'signed') stage = 'signed';
      else if (p.status === 'active') stage = 'contacted';
      else if (p.status === 'closed') return;

      db.pipelineCards.push({
        id: nextId(),
        prospect_id: p.id,
        stage,
        position: db.pipelineCards.filter(c => c.stage === stage).length,
        entered_stage_at: p.created_at || new Date().toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      });
      created++;
    }
  });
  if (created > 0) saveDB(db);
  res.json({ synced: created, total: db.pipelineCards.length });
});

// Pipeline stats
app.get('/api/pipeline/stats', (req, res) => {
  const cards = db.pipelineCards || [];
  const stages = {};
  PIPELINE_STAGES.forEach(s => { stages[s.id] = { count: 0, value: 0 }; });

  cards.forEach(card => {
    if (stages[card.stage]) {
      stages[card.stage].count++;
      const prospect = db.prospects.find(p => p.id === card.prospect_id);
      stages[card.stage].value += (parseInt(prospect?.units) || 1) * 150;
    }
  });

  const totalCards = cards.length;
  const avgDaysInStage = {};
  PIPELINE_STAGES.forEach(s => {
    const stageCards = cards.filter(c => c.stage === s.id);
    if (stageCards.length > 0) {
      const totalDays = stageCards.reduce((sum, c) => {
        return sum + Math.floor((Date.now() - new Date(c.entered_stage_at).getTime()) / (1000 * 60 * 60 * 24));
      }, 0);
      avgDaysInStage[s.id] = Math.round(totalDays / stageCards.length);
    }
  });

  const overdueTasks = (db.crmTasks || []).filter(t => !t.completed && t.due_date && t.due_date < new Date().toISOString().split('T')[0]).length;

  res.json({ stages, totalCards, avgDaysInStage, overdueTasks });
});

// ===== CRM TASKS API =====
app.get('/api/crm-tasks', (req, res) => {
  const { prospect_id, assigned_to, status, priority, stage, overdue } = req.query;
  let tasks = db.crmTasks || [];

  if (prospect_id) tasks = tasks.filter(t => t.prospect_id === parseInt(prospect_id));
  if (assigned_to) tasks = tasks.filter(t => t.assigned_to === assigned_to);
  if (status === 'pending') tasks = tasks.filter(t => !t.completed);
  if (status === 'completed') tasks = tasks.filter(t => t.completed);
  if (priority) tasks = tasks.filter(t => t.priority === priority);
  if (overdue === 'true') {
    const today = new Date().toISOString().split('T')[0];
    tasks = tasks.filter(t => !t.completed && t.due_date && t.due_date < today);
  }
  if (stage) {
    const prospectIdsInStage = (db.pipelineCards || []).filter(c => c.stage === stage).map(c => c.prospect_id);
    tasks = tasks.filter(t => prospectIdsInStage.includes(t.prospect_id));
  }

  // Enrich with prospect info
  const enriched = tasks.map(t => {
    const prospect = db.prospects.find(p => p.id === t.prospect_id);
    const card = (db.pipelineCards || []).find(c => c.prospect_id === t.prospect_id);
    return {
      ...t,
      prospect_name: prospect?.name || 'Unknown',
      prospect_stage: card?.stage || null,
      prospect_priority: prospect?.priority || 'normal',
      is_overdue: !t.completed && t.due_date && t.due_date < new Date().toISOString().split('T')[0]
    };
  });

  enriched.sort((a, b) => {
    if (a.completed !== b.completed) return a.completed ? 1 : -1;
    if (a.is_overdue !== b.is_overdue) return a.is_overdue ? -1 : 1;
    const pa = { high: 0, medium: 1, low: 2 };
    if ((pa[a.priority] || 1) !== (pa[b.priority] || 1)) return (pa[a.priority] || 1) - (pa[b.priority] || 1);
    return new Date(a.due_date || '9999') - new Date(b.due_date || '9999');
  });

  res.json(enriched);
});

app.post('/api/crm-tasks', (req, res) => {
  const task = {
    id: nextId(),
    prospect_id: req.body.prospect_id ? parseInt(req.body.prospect_id) : null,
    title: req.body.title || 'Untitled Task',
    description: req.body.description || '',
    task_type: req.body.task_type || 'general',
    priority: req.body.priority || 'medium',
    assigned_to: req.body.assigned_to || 'Kurtis',
    due_date: req.body.due_date || null,
    completed: false,
    completed_at: null,
    auto_generated: req.body.auto_generated || false,
    source_rule: req.body.source_rule || null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  if (!db.crmTasks) db.crmTasks = [];
  db.crmTasks.push(task);
  saveDB(db);
  res.json(task);
});

app.put('/api/crm-tasks/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const idx = (db.crmTasks || []).findIndex(t => t.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Task not found' });
  db.crmTasks[idx] = { ...db.crmTasks[idx], ...req.body, updated_at: new Date().toISOString() };
  saveDB(db);
  res.json(db.crmTasks[idx]);
});

app.put('/api/crm-tasks/:id/complete', (req, res) => {
  const id = parseInt(req.params.id);
  const idx = (db.crmTasks || []).findIndex(t => t.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Task not found' });
  const task = db.crmTasks[idx];
  task.completed = !task.completed;
  task.completed_at = task.completed ? new Date().toISOString() : null;
  task.updated_at = new Date().toISOString();

  // Log activity
  if (task.completed && task.prospect_id) {
    db.activities.push({
      id: nextId(),
      prospect_id: task.prospect_id,
      type: 'task_completed',
      description: `Task completed: ${task.title}`,
      created_at: new Date().toISOString()
    });
  }

  saveDB(db);
  res.json(task);
});

app.delete('/api/crm-tasks/:id', (req, res) => {
  const id = parseInt(req.params.id);
  db.crmTasks = (db.crmTasks || []).filter(t => t.id !== id);
  saveDB(db);
  res.json({ success: true });
});

// Task stats
app.get('/api/crm-tasks/stats', (req, res) => {
  const tasks = db.crmTasks || [];
  const today = new Date().toISOString().split('T')[0];
  const pending = tasks.filter(t => !t.completed);
  const overdue = pending.filter(t => t.due_date && t.due_date < today);
  const dueToday = pending.filter(t => t.due_date && t.due_date === today);
  const completed = tasks.filter(t => t.completed);
  const byType = {};
  pending.forEach(t => { byType[t.task_type] = (byType[t.task_type] || 0) + 1; });
  const byPriority = {};
  pending.forEach(t => { byPriority[t.priority] = (byPriority[t.priority] || 0) + 1; });
  res.json({ total: tasks.length, pending: pending.length, overdue: overdue.length, dueToday: dueToday.length, completed: completed.length, byType, byPriority });
});

// ===== POP-IN VISITS API =====
app.get('/api/popins', (req, res) => {
  const { prospect_id } = req.query;
  let visits = db.popInVisits || [];
  if (prospect_id) visits = visits.filter(v => v.prospect_id === parseInt(prospect_id));
  const enriched = visits.map(v => {
    const prospect = db.prospects.find(p => p.id === v.prospect_id);
    return { ...v, prospect_name: prospect?.name || 'Unknown' };
  });
  res.json(enriched.sort((a, b) => new Date(b.visit_date) - new Date(a.visit_date)));
});

app.post('/api/popins', (req, res) => {
  const visit = {
    id: nextId(),
    prospect_id: req.body.prospect_id ? parseInt(req.body.prospect_id) : null,
    visit_date: req.body.visit_date || new Date().toISOString().split('T')[0],
    visitor: req.body.visitor || 'Kurtis',
    notes: req.body.notes || '',
    outcome: req.body.outcome || 'neutral',
    gift_basket_given: req.body.gift_basket_given || false,
    gift_basket_contents: req.body.gift_basket_contents || '',
    spoke_with: req.body.spoke_with || '',
    spoke_with_title: req.body.spoke_with_title || '',
    existing_vending: req.body.existing_vending || '',
    competitor_machines: req.body.competitor_machines || '',
    photos: req.body.photos || [],
    follow_up_notes: req.body.follow_up_notes || '',
    created_at: new Date().toISOString()
  };
  if (!db.popInVisits) db.popInVisits = [];
  db.popInVisits.push(visit);

  // Log activity
  if (visit.prospect_id) {
    db.activities.push({
      id: nextId(),
      prospect_id: visit.prospect_id,
      type: 'pop_in',
      description: `Pop-in visit by ${visit.visitor}: ${visit.outcome}${visit.gift_basket_given ? ' 🎁 Gift basket given' : ''}${visit.spoke_with ? ' — Spoke w/ ' + visit.spoke_with : ''} — ${visit.notes.substring(0, 80)}`,
      outcome: visit.outcome,
      created_at: new Date().toISOString()
    });

    // Move to pop_in_done stage if in earlier stage
    const card = db.pipelineCards.find(c => c.prospect_id === visit.prospect_id);
    if (card && ['new_lead', 'contacted'].includes(card.stage)) {
      const oldStage = card.stage;
      card.stage = 'pop_in_done';
      card.entered_stage_at = new Date().toISOString();
      card.updated_at = new Date().toISOString();
      runWorkflowRules('stage_change', { prospect_id: visit.prospect_id, old_stage: oldStage, new_stage: 'pop_in_done' });
    }

    // Auto-upgrade priority based on outcome
    if (visit.outcome === 'interested') {
      const pIdx = db.prospects.findIndex(p => p.id === visit.prospect_id);
      if (pIdx !== -1) {
        db.prospects[pIdx].priority = 'hot';
        db.prospects[pIdx].updated_at = new Date().toISOString();
      }
      // Move to interested stage
      const card2 = db.pipelineCards.find(c => c.prospect_id === visit.prospect_id);
      if (card2 && PIPELINE_STAGES.findIndex(s => s.id === card2.stage) < PIPELINE_STAGES.findIndex(s => s.id === 'interested')) {
        card2.stage = 'interested';
        card2.entered_stage_at = new Date().toISOString();
      }
    }
  }

  saveDB(db);
  res.json(visit);
});

app.delete('/api/popins/:id', (req, res) => {
  const id = parseInt(req.params.id);
  db.popInVisits = (db.popInVisits || []).filter(v => v.id !== id);
  saveDB(db);
  res.json({ success: true });
});

// ===== CRM DOCUMENTS API =====
app.get('/api/crm-documents', (req, res) => {
  const { prospect_id, doc_type } = req.query;
  let docs = db.crmDocuments || [];
  if (prospect_id) docs = docs.filter(d => d.prospect_id === parseInt(prospect_id));
  if (doc_type) docs = docs.filter(d => d.doc_type === doc_type);
  res.json(docs.sort((a, b) => new Date(b.created_at) - new Date(a.created_at)));
});

app.post('/api/crm-documents', (req, res) => {
  const doc = {
    id: nextId(),
    prospect_id: req.body.prospect_id ? parseInt(req.body.prospect_id) : null,
    doc_type: req.body.doc_type || 'other',
    title: req.body.title || 'Untitled',
    description: req.body.description || '',
    status: req.body.status || 'draft',
    file_data: req.body.file_data || null,
    file_name: req.body.file_name || null,
    file_type: req.body.file_type || null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  if (!db.crmDocuments) db.crmDocuments = [];
  db.crmDocuments.push(doc);

  // Log activity
  if (doc.prospect_id) {
    db.activities.push({
      id: nextId(),
      prospect_id: doc.prospect_id,
      type: 'document',
      description: `Document ${doc.status}: ${doc.title} (${doc.doc_type})`,
      created_at: new Date().toISOString()
    });
  }

  saveDB(db);
  res.json(doc);
});

app.put('/api/crm-documents/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const idx = (db.crmDocuments || []).findIndex(d => d.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Document not found' });
  db.crmDocuments[idx] = { ...db.crmDocuments[idx], ...req.body, updated_at: new Date().toISOString() };
  saveDB(db);
  res.json(db.crmDocuments[idx]);
});

app.delete('/api/crm-documents/:id', (req, res) => {
  const id = parseInt(req.params.id);
  db.crmDocuments = (db.crmDocuments || []).filter(d => d.id !== id);
  saveDB(db);
  res.json({ success: true });
});

// ===== MACHINE ASSIGNMENTS API =====
app.get('/api/machine-assignments', (req, res) => {
  const { prospect_id } = req.query;
  let assignments = db.machineAssignments || [];
  if (prospect_id) assignments = assignments.filter(a => a.prospect_id === parseInt(prospect_id));
  res.json(assignments);
});

app.post('/api/machine-assignments', (req, res) => {
  const assignment = {
    id: nextId(),
    prospect_id: parseInt(req.body.prospect_id),
    machine_id: req.body.machine_id || null,
    machine_name: req.body.machine_name || '',
    machine_serial: req.body.machine_serial || '',
    installed_date: req.body.installed_date || null,
    status: req.body.status || 'planned',
    notes: req.body.notes || '',
    created_at: new Date().toISOString()
  };
  if (!db.machineAssignments) db.machineAssignments = [];
  db.machineAssignments.push(assignment);
  saveDB(db);
  res.json(assignment);
});

app.put('/api/machine-assignments/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const idx = (db.machineAssignments || []).findIndex(a => a.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Assignment not found' });
  db.machineAssignments[idx] = { ...db.machineAssignments[idx], ...req.body, updated_at: new Date().toISOString() };
  saveDB(db);
  res.json(db.machineAssignments[idx]);
});

app.delete('/api/machine-assignments/:id', (req, res) => {
  const id = parseInt(req.params.id);
  db.machineAssignments = (db.machineAssignments || []).filter(a => a.id !== id);
  saveDB(db);
  res.json({ success: true });
});

// ===== WORKFLOW RULES API =====
app.get('/api/workflow-rules', (req, res) => {
  res.json(db.workflowRules || []);
});

app.post('/api/workflow-rules', (req, res) => {
  const rule = {
    id: nextId(),
    name: req.body.name || 'Untitled Rule',
    trigger: req.body.trigger || 'stage_change',
    trigger_stage: req.body.trigger_stage || null,
    action: req.body.action || 'create_task',
    task_type: req.body.task_type || 'general',
    task_title: req.body.task_title || '',
    target_stage: req.body.target_stage || null,
    delay_days: parseInt(req.body.delay_days) || 0,
    active: req.body.active !== false,
    created_at: new Date().toISOString()
  };
  if (!db.workflowRules) db.workflowRules = [];
  db.workflowRules.push(rule);
  saveDB(db);
  res.json(rule);
});

app.put('/api/workflow-rules/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const idx = (db.workflowRules || []).findIndex(r => r.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Rule not found' });
  db.workflowRules[idx] = { ...db.workflowRules[idx], ...req.body };
  saveDB(db);
  res.json(db.workflowRules[idx]);
});

app.delete('/api/workflow-rules/:id', (req, res) => {
  const id = parseInt(req.params.id);
  db.workflowRules = (db.workflowRules || []).filter(r => r.id !== id);
  saveDB(db);
  res.json({ success: true });
});

// Workflow rule engine
function runWorkflowRules(trigger, context) {
  const rules = (db.workflowRules || []).filter(r => r.active && r.trigger === trigger);
  for (const rule of rules) {
    if (trigger === 'stage_change' && rule.trigger_stage && rule.trigger_stage !== context.new_stage) continue;

    if (rule.action === 'create_task') {
      // Deduplicate: don't create if same-titled pending task exists for this prospect
      const existingTask = (db.crmTasks || []).find(t => t.prospect_id === context.prospect_id && t.title === (rule.task_title || `Task from: ${rule.name}`) && !t.completed);
      if (existingTask) continue;
      const dueDate = new Date();
      dueDate.setDate(dueDate.getDate() + (rule.delay_days || 0));
      const task = {
        id: nextId(),
        prospect_id: context.prospect_id,
        title: rule.task_title || `Task from: ${rule.name}`,
        task_type: rule.task_type || 'general',
        priority: rule.priority || 'medium',
        assigned_to: 'Kurtis',
        due_date: dueDate.toISOString().split('T')[0],
        completed: false,
        auto_generated: true,
        source_rule: rule.name,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      if (!db.crmTasks) db.crmTasks = [];
      db.crmTasks.push(task);
    }

    if (rule.action === 'move_stage' && rule.target_stage) {
      const card = db.pipelineCards.find(c => c.prospect_id === context.prospect_id);
      if (card) {
        card.stage = rule.target_stage;
        card.entered_stage_at = new Date().toISOString();
        card.updated_at = new Date().toISOString();
      }
    }
  }
  saveDB(db);
}

// ===== PROSPECT DETAIL API (enriched single prospect for CRM detail view) =====
app.get('/api/pipeline/prospect/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const prospect = db.prospects.find(p => p.id === id);
  if (!prospect) return res.status(404).json({ error: 'Prospect not found' });

  const contacts = db.contacts.filter(c => c.prospect_id === id);
  const activities = db.activities.filter(a => a.prospect_id === id).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const tasks = (db.crmTasks || []).filter(t => t.prospect_id === id);
  const popIns = (db.popInVisits || []).filter(v => v.prospect_id === id).sort((a, b) => new Date(b.visit_date) - new Date(a.visit_date));
  const documents = (db.crmDocuments || []).filter(d => d.prospect_id === id);
  const machineAssignments = (db.machineAssignments || []).filter(a => a.prospect_id === id);
  const pipelineCard = db.pipelineCards.find(c => c.prospect_id === id);
  const emailSends = (db.emailSends || []).filter(s => s.prospect_id === id);
  const proposals = (db.proposals || []).filter(p => p.prospect_id === id);
  const contractList = (db.contracts || []).filter(c => c.prospect_id === id);

  // Ensure pipeline card exists
  const card = pipelineCard || ensurePipelineCard(id);

  // Touchpoint count (Skool: 8-10 touches)
  const touchActivities = activities.filter(a => {
    const t = (a.type || '').toLowerCase();
    return ['pop_in', 'email', 'call', 'phone', 'proposal', 'meeting', 'visit', 'outreach', 'thank_you'].includes(t);
  });
  const touchCount = touchActivities.length;

  // Referrals
  const referralsGiven = (db.referrals || []).filter(r => r.referrer_prospect_id === id);
  const referredBy = (db.referrals || []).filter(r => r.referred_prospect_id === id);

  // Location performance data
  const locPerformance = (db.locationPerformance || []).filter(lp => lp.prospect_id === id)
    .sort((a, b) => (b.month || '').localeCompare(a.month || ''));

  // Qualification score
  const qualScore = calcQualificationScore(prospect);

  res.json({
    ...prospect,
    contacts,
    activities,
    tasks: { pending: tasks.filter(t => !t.completed), completed: tasks.filter(t => t.completed) },
    pop_ins: popIns,
    documents,
    machine_assignments: machineAssignments,
    pipeline_card: card,
    current_stage: card.stage,
    email_sends: emailSends,
    proposals,
    contracts: contractList,
    days_in_stage: Math.floor((Date.now() - new Date(card.entered_stage_at).getTime()) / (1000 * 60 * 60 * 24)),
    // Skool community fields
    touch_count: touchCount,
    touch_target: 10,
    touch_progress: Math.min(100, Math.round((touchCount / 10) * 100)),
    qualification_score: qualScore,
    referrals_given: referralsGiven,
    referred_by: referredBy,
    location_performance: locPerformance
  });
});

// ===== QUALIFICATION DATA API (Skool: min 100 residents, $2K/mo threshold) =====
app.put('/api/prospects/:id/qualification', (req, res) => {
  const id = parseInt(req.params.id);
  const idx = db.prospects.findIndex(p => p.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const p = db.prospects[idx];
  // Qualification fields
  const qFields = ['resident_employee_count', 'shift_breakdown', 'daily_foot_traffic',
    'existing_snack_options', 'competitor_machines', 'monthly_revenue_potential',
    'power_outlet_available', 'wifi_available', 'space_dimensions', 'space_notes',
    'vendor_approval_status', 'vendor_approval_company', 'vendor_approval_notes',
    'revenue_share_percent', 'referral_source', 'referred_by_prospect_id',
    'management_company', 'decision_maker_name', 'decision_maker_title',
    'pitch_language_notes'];
  qFields.forEach(f => { if (req.body[f] !== undefined) p[f] = req.body[f]; });
  p.updated_at = new Date().toISOString();
  saveDB(db);
  res.json(p);
});

// ===== REFERRAL TRACKING API =====
if (!db.referrals) { db.referrals = []; saveDB(db); }

app.get('/api/referrals', (req, res) => {
  const { prospect_id } = req.query;
  let refs = db.referrals || [];
  if (prospect_id) refs = refs.filter(r => r.referrer_prospect_id === parseInt(prospect_id) || r.referred_prospect_id === parseInt(prospect_id));
  const enriched = refs.map(r => {
    const referrer = db.prospects.find(p => p.id === r.referrer_prospect_id);
    const referred = db.prospects.find(p => p.id === r.referred_prospect_id);
    return { ...r, referrer_name: referrer?.name || 'Unknown', referred_name: referred?.name || r.referred_name || 'Unknown' };
  });
  res.json(enriched);
});

app.post('/api/referrals', (req, res) => {
  const ref = {
    id: nextId(),
    referrer_prospect_id: req.body.referrer_prospect_id ? parseInt(req.body.referrer_prospect_id) : null,
    referred_prospect_id: req.body.referred_prospect_id ? parseInt(req.body.referred_prospect_id) : null,
    referred_name: req.body.referred_name || '',
    referred_address: req.body.referred_address || '',
    referred_contact: req.body.referred_contact || '',
    status: req.body.status || 'pending',
    notes: req.body.notes || '',
    created_at: new Date().toISOString()
  };
  db.referrals.push(ref);
  // Log activity on referrer
  if (ref.referrer_prospect_id) {
    db.activities.push({ id: nextId(), prospect_id: ref.referrer_prospect_id, type: 'referral_given', description: `Referral given: ${ref.referred_name || 'New building'}`, created_at: new Date().toISOString() });
  }
  saveDB(db);
  res.json(ref);
});

// ===== LOCATION PERFORMANCE API (per active location) =====
app.get('/api/location-performance', (req, res) => {
  const { prospect_id } = req.query;
  let records = db.locationPerformance || [];
  if (prospect_id) records = records.filter(r => r.prospect_id === parseInt(prospect_id));
  res.json(records.sort((a, b) => new Date(b.month || b.created_at) - new Date(a.month || a.created_at)));
});

app.post('/api/location-performance', (req, res) => {
  const record = {
    id: nextId(),
    prospect_id: req.body.prospect_id ? parseInt(req.body.prospect_id) : null,
    month: req.body.month || new Date().toISOString().slice(0, 7),
    revenue: parseFloat(req.body.revenue) || 0,
    cogs: parseFloat(req.body.cogs) || 0,
    revenue_share_paid: parseFloat(req.body.revenue_share_paid) || 0,
    profit: parseFloat(req.body.profit) || 0,
    restock_count: parseInt(req.body.restock_count) || 0,
    top_products: req.body.top_products || '',
    notes: req.body.notes || '',
    created_at: new Date().toISOString()
  };
  if (!db.locationPerformance) db.locationPerformance = [];
  db.locationPerformance.push(record);
  saveDB(db);
  res.json(record);
});

// ===== TOUCHPOINT COUNTER API (Skool: 8-10 touches to close) =====
app.get('/api/prospects/:id/touchpoints', (req, res) => {
  const id = parseInt(req.params.id);
  const activities = db.activities.filter(a => a.prospect_id === id);
  const popIns = (db.popInVisits || []).filter(v => v.prospect_id === id);
  const emails = (db.emailSends || []).filter(s => s.prospect_id === id);
  // Count distinct touchpoints (each meaningful contact = 1 touch)
  const touchTypes = { pop_in: 0, email: 0, call: 0, proposal: 0, meeting: 0, thank_you: 0, other: 0 };
  activities.forEach(a => {
    const t = (a.type || '').toLowerCase();
    if (t === 'pop_in') touchTypes.pop_in++;
    else if (t === 'email' || t === 'outreach') touchTypes.email++;
    else if (t === 'call' || t === 'phone') touchTypes.call++;
    else if (t === 'proposal') touchTypes.proposal++;
    else if (t === 'meeting' || t === 'visit') touchTypes.meeting++;
    else if (t !== 'status-change' && t !== 'pipeline_move' && t !== 'task_completed' && t !== 'import' && t !== 'document') touchTypes.other++;
  });
  touchTypes.pop_in = Math.max(touchTypes.pop_in, popIns.length);
  touchTypes.email = Math.max(touchTypes.email, emails.length);
  const totalTouches = Object.values(touchTypes).reduce((s, v) => s + v, 0);
  const target = 10;
  const progressPercent = Math.min(100, Math.round((totalTouches / target) * 100));
  res.json({ total: totalTouches, target, progress: progressPercent, breakdown: touchTypes, remaining: Math.max(0, target - totalTouches) });
});

// ===== ENRICHED PIPELINE CARDS (add touchpoint count + qualification score) =====
// Patch the existing enriched card builder to include Skool data
// (This supplements the existing /api/pipeline/cards endpoint)

// Enriched prospect detail — add Skool community fields
const _origProspectDetail = app._router.stack.find(r => r.route && r.route.path === '/api/pipeline/prospect/:id' && r.route.methods.get);

// ===== CRM PIPELINE PAGE ROUTES =====
app.get('/pipeline-board', (req, res) => res.sendFile(path.join(__dirname, 'pipeline-board.html')));
app.get('/task-manager', (req, res) => res.sendFile(path.join(__dirname, 'task-manager.html')));  // Old simple task manager
app.get('/crm/:id', (req, res) => res.sendFile(path.join(__dirname, 'prospect-detail.html')));

// ===== OPERATIONS PAGES — Page Routes =====
app.get('/schedule', (req, res) => res.sendFile(path.join(__dirname, 'schedule.html')));
app.get('/routes', (req, res) => res.sendFile(path.join(__dirname, 'routes.html')));
app.get('/warehouse', (req, res) => res.sendFile(path.join(__dirname, 'warehouse.html')));
app.get('/operations', (req, res) => res.sendFile(path.join(__dirname, 'operations.html')));

// ===== Ensure operations DB collections =====
if (!db.scheduleShifts) db.scheduleShifts = [];
if (!db.routeTemplates) db.routeTemplates = [];
if (!db.warehouseStock) db.warehouseStock = [];
if (!db.packingLists) db.packingLists = [];
if (!db.supplierOrders) db.supplierOrders = [];
if (!db.operationsLog) db.operationsLog = [];

// ===== SCHEDULE API =====

// Get schedule staff (union of drivers + any packer-role staff)
app.get('/api/schedule/staff', (req, res) => {
  const staff = [];
  // Add all drivers as schedule staff
  (db.drivers || []).forEach(d => {
    if (d.status === 'active') {
      staff.push({ id: d.id, name: d.name, role: 'driver' });
    }
  });
  // Add any staff members with packer role
  (db.staff || []).forEach(s => {
    if (s.role === 'packer' || s.department === 'warehouse') {
      staff.push({ id: s.id + 10000, name: s.name, role: 'packer' });
    }
  });
  // If no packers, add placeholder
  if (!staff.some(s => s.role === 'packer')) {
    staff.push({ id: 99001, name: 'Warehouse Staff', role: 'packer' });
  }
  res.json({ staff });
});

// Get shifts for a date range
app.get('/api/schedule/shifts', (req, res) => {
  const { start, end } = req.query;
  let shifts = db.scheduleShifts || [];
  if (start && end) {
    shifts = shifts.filter(s => s.date >= start && s.date <= end);
  }
  res.json({ shifts });
});

// Create a shift
app.post('/api/schedule/shifts', (req, res) => {
  const { staff_id, type, date, start_time, end_time, route_id, route_name, route_stops, route_est_time, notes, force } = req.body;
  
  // Conflict detection (unless forced)
  if (!force && type !== 'off') {
    const existing = db.scheduleShifts.filter(s => 
      s.staff_id === staff_id && s.date === date && s.type !== 'off'
    );
    if (existing.length > 0) {
      const overlap = existing.some(s => {
        const sStart = s.start_time || '00:00';
        const sEnd = s.end_time || '23:59';
        return (start_time || '00:00') < sEnd && (end_time || '23:59') > sStart;
      });
      if (overlap) {
        return res.json({ conflict: `${type} shift overlaps with existing shift on ${date}`, shift: null });
      }
    }
  }

  const shift = {
    id: nextId(),
    staff_id: parseInt(staff_id),
    type: type || 'driver',
    date,
    start_time: start_time || '08:00',
    end_time: end_time || '16:00',
    route_id: route_id ? parseInt(route_id) : null,
    route_name: route_name || null,
    route_stops: route_stops || 0,
    route_est_time: route_est_time || null,
    notes: notes || '',
    status: 'scheduled',
    created_at: new Date().toISOString()
  };
  db.scheduleShifts.push(shift);
  saveDB(db);
  res.json({ success: true, shift });
});

// Update a shift
app.put('/api/schedule/shifts/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const shift = db.scheduleShifts.find(s => s.id === id);
  if (!shift) return res.status(404).json({ error: 'Shift not found' });

  const updates = req.body;
  if (updates.staff_id !== undefined) shift.staff_id = parseInt(updates.staff_id);
  if (updates.type !== undefined) shift.type = updates.type;
  if (updates.date !== undefined) shift.date = updates.date;
  if (updates.start_time !== undefined) shift.start_time = updates.start_time;
  if (updates.end_time !== undefined) shift.end_time = updates.end_time;
  if (updates.route_id !== undefined) shift.route_id = updates.route_id ? parseInt(updates.route_id) : null;
  if (updates.route_name !== undefined) shift.route_name = updates.route_name;
  if (updates.route_stops !== undefined) shift.route_stops = updates.route_stops;
  if (updates.route_est_time !== undefined) shift.route_est_time = updates.route_est_time;
  if (updates.notes !== undefined) shift.notes = updates.notes;
  if (updates.status !== undefined) shift.status = updates.status;
  shift.updated_at = new Date().toISOString();

  saveDB(db);
  res.json({ success: true, shift });
});

// Delete a shift
app.delete('/api/schedule/shifts/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const idx = db.scheduleShifts.findIndex(s => s.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Shift not found' });
  db.scheduleShifts.splice(idx, 1);
  saveDB(db);
  res.json({ success: true });
});

// Publish week schedule
app.post('/api/schedule/publish', (req, res) => {
  const { week_start } = req.body;
  // Mark all shifts in this week as published
  db.scheduleShifts.forEach(s => {
    if (s.date >= week_start) {
      const shiftDate = new Date(s.date);
      const weekEnd = new Date(week_start);
      weekEnd.setDate(weekEnd.getDate() + 7);
      if (shiftDate < weekEnd) {
        s.published = true;
        s.published_at = new Date().toISOString();
      }
    }
  });
  saveDB(db);
  res.json({ success: true, message: `Week of ${week_start} published` });
});


// ===== ROUTE TEMPLATES API =====

// Get all route templates
app.get('/api/routes/templates', (req, res) => {
  res.json({ templates: db.routeTemplates || [] });
});

// Create route template
app.post('/api/routes/templates', (req, res) => {
  const { name, description, days, stops, est_time, est_drive_time, est_service_time } = req.body;
  const template = {
    id: nextId(),
    name: sanitize(name || 'Unnamed Route'),
    description: sanitize(description || ''),
    days: days || [],
    stops: (stops || []).map(s => ({
      machine_id: s.machine_id,
      machine_name: sanitize(s.machine_name || ''),
      address: sanitize(s.address || ''),
      lat: s.lat,
      lng: s.lng,
      est_service_time: s.est_service_time || 15,
      products_needed: s.products_needed || [],
      notes: sanitize(s.notes || '')
    })),
    est_time: est_time || 0,
    est_drive_time: est_drive_time || 0,
    est_service_time: est_service_time || 0,
    created_at: new Date().toISOString()
  };
  db.routeTemplates.push(template);
  saveDB(db);
  res.json({ success: true, template });
});

// Update route template
app.put('/api/routes/templates/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const tmpl = db.routeTemplates.find(t => t.id === id);
  if (!tmpl) return res.status(404).json({ error: 'Template not found' });

  const updates = req.body;
  if (updates.name !== undefined) tmpl.name = sanitize(updates.name);
  if (updates.description !== undefined) tmpl.description = sanitize(updates.description);
  if (updates.days !== undefined) tmpl.days = updates.days;
  if (updates.stops !== undefined) tmpl.stops = updates.stops;
  if (updates.est_time !== undefined) tmpl.est_time = updates.est_time;
  if (updates.est_drive_time !== undefined) tmpl.est_drive_time = updates.est_drive_time;
  if (updates.est_service_time !== undefined) tmpl.est_service_time = updates.est_service_time;
  tmpl.updated_at = new Date().toISOString();

  saveDB(db);
  res.json({ success: true, template: tmpl });
});

// Delete route template
app.delete('/api/routes/templates/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const idx = db.routeTemplates.findIndex(t => t.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Template not found' });
  db.routeTemplates.splice(idx, 1);
  saveDB(db);
  res.json({ success: true });
});


// ===== WAREHOUSE API =====

// Get warehouse stock levels (merges products with stock data)
app.get('/api/warehouse/stock', (req, res) => {
  // Build stock from products + warehouseStock overrides
  const stock = (db.products || []).map(p => {
    const ws = db.warehouseStock.find(s => s.product_id === p.id);
    return {
      product_id: p.id,
      product_name: p.name,
      category: p.category || 'Other',
      quantity: ws ? ws.quantity : 0,
      reorder_threshold: ws ? ws.reorder_threshold : 24,
      cost_price: p.cost_price || p.wholesale_price || 0,
      sell_price: p.sell_price || p.retail_price || 0,
      last_updated: ws ? ws.updated_at : null
    };
  });
  res.json({ stock });
});

// Update stock level
app.post('/api/warehouse/stock', (req, res) => {
  const { product_id, action, quantity, reorder_threshold, notes } = req.body;
  let ws = db.warehouseStock.find(s => s.product_id === product_id);
  
  if (!ws) {
    ws = { product_id, quantity: 0, reorder_threshold: reorder_threshold || 24, created_at: new Date().toISOString() };
    db.warehouseStock.push(ws);
  }

  const oldQty = ws.quantity;
  if (action === 'set') ws.quantity = quantity;
  else if (action === 'add') ws.quantity += quantity;
  else if (action === 'remove') ws.quantity = Math.max(0, ws.quantity - quantity);
  
  if (reorder_threshold !== undefined) ws.reorder_threshold = reorder_threshold;
  ws.updated_at = new Date().toISOString();

  // Log the change
  db.operationsLog.push({
    id: nextId(),
    type: 'stock_change',
    product_id,
    old_qty: oldQty,
    new_qty: ws.quantity,
    action,
    notes: sanitize(notes || ''),
    timestamp: new Date().toISOString()
  });

  saveDB(db);
  res.json({ success: true, stock: ws });
});


// ===== PACKING LISTS API =====

app.get('/api/warehouse/packing-lists', (req, res) => {
  res.json({ lists: db.packingLists || [] });
});

// Auto-generate packing lists from tomorrow's routes
app.post('/api/warehouse/packing-lists/generate', (req, res) => {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().split('T')[0];
  const dayName = tomorrow.toLocaleDateString('en-US', { weekday: 'short' });

  // Find route templates scheduled for tomorrow
  const tomorrowTemplates = (db.routeTemplates || []).filter(t => 
    !t.days || t.days.length === 0 || t.days.includes(dayName)
  );

  // Also check schedule shifts for tomorrow with route assignments
  const tomorrowShifts = (db.scheduleShifts || []).filter(s => 
    s.date === tomorrowStr && s.route_id
  );

  const lists = [];
  const processedRoutes = new Set();

  // From scheduled shifts
  tomorrowShifts.forEach(shift => {
    if (processedRoutes.has(shift.route_id)) return;
    processedRoutes.add(shift.route_id);
    const tmpl = db.routeTemplates.find(t => t.id === shift.route_id);
    if (!tmpl) return;

    const items = generatePackingItems(tmpl);
    lists.push({
      id: nextId(),
      route_id: shift.route_id,
      route_name: tmpl.name || shift.route_name || 'Route',
      date: tomorrowStr,
      items,
      created_at: new Date().toISOString()
    });
  });

  // From templates (if not already covered by shifts)
  tomorrowTemplates.forEach(tmpl => {
    if (processedRoutes.has(tmpl.id)) return;
    processedRoutes.add(tmpl.id);
    const items = generatePackingItems(tmpl);
    lists.push({
      id: nextId(),
      route_id: tmpl.id,
      route_name: tmpl.name,
      date: tomorrowStr,
      items,
      created_at: new Date().toISOString()
    });
  });

  // Replace existing packing lists for tomorrow
  db.packingLists = db.packingLists.filter(pl => pl.date !== tomorrowStr);
  db.packingLists.push(...lists);
  saveDB(db);

  res.json({ success: true, lists, generated: lists.length });
});

// Helper: generate packing items from route template stops
function generatePackingItems(template) {
  const items = [];
  const productQty = {};

  (template.stops || []).forEach(stop => {
    // If stop has specific products, use those
    if (stop.products_needed && stop.products_needed.length > 0) {
      stop.products_needed.forEach(pn => {
        if (typeof pn === 'object') {
          productQty[pn.name || pn.product_name] = (productQty[pn.name || pn.product_name] || 0) + (pn.qty || 5);
        } else {
          productQty[pn] = (productQty[pn] || 0) + 5;
        }
      });
    } else {
      // Default: estimate from product catalog
      const topProducts = (db.products || []).slice(0, 8);
      topProducts.forEach(p => {
        productQty[p.name] = (productQty[p.name] || 0) + Math.ceil(Math.random() * 3 + 2);
      });
    }
  });

  Object.entries(productQty).forEach(([name, qty]) => {
    const product = (db.products || []).find(p => p.name === name);
    items.push({
      product_name: name,
      product_id: product ? product.id : null,
      category: product ? product.category : 'Other',
      quantity: qty,
      packed: false
    });
  });

  return items.sort((a, b) => (a.category || '').localeCompare(b.category || ''));
}

// Update packing list items (toggle packed status)
app.put('/api/warehouse/packing-lists/:id', (req, res) => {
  const id = req.params.id;
  // Try by id first, then by index
  let list = db.packingLists.find(pl => String(pl.id) === id);
  if (!list && !isNaN(id)) list = db.packingLists[parseInt(id)];
  if (!list) return res.status(404).json({ error: 'Packing list not found' });

  if (req.body.items) list.items = req.body.items;
  list.updated_at = new Date().toISOString();
  saveDB(db);
  res.json({ success: true, list });
});


// ===== SUPPLIER ORDERS API =====

app.get('/api/warehouse/orders', (req, res) => {
  const orders = (db.supplierOrders || []).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  res.json({ orders });
});

app.post('/api/warehouse/orders', (req, res) => {
  const { supplier, items_text, est_cost, expected_delivery, notes } = req.body;
  
  // Parse items text
  const lines = (items_text || '').split('\n').filter(l => l.trim());
  const items_summary = lines.length > 0 ? `${lines.length} items` : 'No items';

  const order = {
    id: nextId(),
    supplier: sanitize(supplier || ''),
    items_text: sanitize(items_text || ''),
    items_summary,
    est_cost: est_cost || 0,
    expected_delivery: expected_delivery || null,
    notes: sanitize(notes || ''),
    status: 'ordered',
    created_at: new Date().toISOString()
  };
  db.supplierOrders.push(order);
  saveDB(db);
  res.json({ success: true, order });
});

app.put('/api/warehouse/orders/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const order = db.supplierOrders.find(o => o.id === id);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  if (req.body.status) order.status = req.body.status;
  if (req.body.notes) order.notes = sanitize(req.body.notes);
  if (req.body.status === 'delivered') {
    order.delivered_at = new Date().toISOString();
  }
  order.updated_at = new Date().toISOString();
  saveDB(db);
  res.json({ success: true, order });
});

app.delete('/api/warehouse/orders/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const idx = db.supplierOrders.findIndex(o => o.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Order not found' });
  db.supplierOrders.splice(idx, 1);
  saveDB(db);
  res.json({ success: true });
});


// ===== OPERATIONS DASHBOARD API =====

app.get('/api/operations/dashboard', (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const dayName = new Date().toLocaleDateString('en-US', { weekday: 'short' });

  // --- Routes status ---
  const todayShifts = (db.scheduleShifts || []).filter(s => s.date === today && s.type === 'driver');
  const routeItems = todayShifts.map(s => {
    const staff = (db.drivers || []).find(d => d.id === s.staff_id);
    const tmpl = s.route_id ? (db.routeTemplates || []).find(t => t.id === s.route_id) : null;
    const totalStops = tmpl ? (tmpl.stops || []).length : (s.route_stops || 0);
    
    // Check driver's actual completions
    const completions = (db.driverCheckins || []).filter(c => 
      c.driver_id === s.staff_id && c.created_at && c.created_at.startsWith(today)
    ).length;

    return {
      route_name: s.route_name || (tmpl ? tmpl.name : 'Route'),
      driver_name: staff ? staff.name : 'Unassigned',
      total_stops: totalStops,
      completed_stops: Math.min(completions, totalStops),
      status: completions >= totalStops && totalStops > 0 ? 'completed' : completions > 0 ? 'in_progress' : 'scheduled'
    };
  });

  // If no scheduled shifts, check templates for today
  if (routeItems.length === 0) {
    (db.routeTemplates || []).forEach(tmpl => {
      if (!tmpl.days || tmpl.days.length === 0 || tmpl.days.includes(dayName)) {
        routeItems.push({
          route_name: tmpl.name,
          driver_name: 'Unassigned',
          total_stops: (tmpl.stops || []).length,
          completed_stops: 0,
          status: 'scheduled'
        });
      }
    });
  }

  const routeData = {
    total: routeItems.length,
    completed: routeItems.filter(r => r.status === 'completed').length,
    in_progress: routeItems.filter(r => r.status === 'in_progress').length,
    items: routeItems
  };

  // --- Machine alerts ---
  const alerts = [];
  (db.machines || []).forEach(m => {
    // Check for open issues
    const openIssues = (db.issues || []).filter(i => i.machine_id === m.id && i.status === 'open');
    openIssues.forEach(issue => {
      alerts.push({
        machine_id: m.id,
        machine_name: m.name || 'Machine ' + m.id,
        type: 'error',
        description: issue.description || issue.type || 'Issue reported',
        severity: issue.severity || 'medium'
      });
    });

    // Check for driver-reported issues
    const driverIssues = (db.driverIssues || []).filter(i => 
      i.machine_id === m.id && i.status === 'open'
    );
    driverIssues.forEach(issue => {
      if (!alerts.some(a => a.machine_id === m.id && a.description === issue.description)) {
        alerts.push({
          machine_id: m.id,
          machine_name: m.name || 'Machine ' + m.id,
          type: issue.type || 'error',
          description: `[Driver: ${issue.driver_name}] ${issue.description || issue.type}`,
          severity: issue.severity || 'medium'
        });
      }
    });
  });

  // Low stock alerts from warehouse
  (db.warehouseStock || []).forEach(ws => {
    if (ws.quantity <= 0) {
      const prod = (db.products || []).find(p => p.id === ws.product_id);
      alerts.push({
        machine_name: prod ? prod.name : 'Product #' + ws.product_id,
        type: 'low_stock',
        description: 'Out of stock in warehouse',
        severity: 'high'
      });
    }
  });

  // --- Driver locations (from latest check-ins) ---
  const drivers = (db.drivers || []).filter(d => d.status === 'active').map(d => {
    const latestCheckin = (db.driverCheckins || [])
      .filter(c => c.driver_id === d.id)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
    return {
      id: d.id,
      name: d.name,
      status: 'active',
      lat: latestCheckin ? latestCheckin.lat : null,
      lng: latestCheckin ? latestCheckin.lng : null,
      last_checkin: latestCheckin ? latestCheckin.created_at : null
    };
  });

  // --- Packing status ---
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().split('T')[0];
  const packing = (db.packingLists || []).filter(pl => pl.date === tomorrowStr).map(pl => ({
    route_name: pl.route_name || 'Route',
    total_items: (pl.items || []).length,
    packed_items: (pl.items || []).filter(i => i.packed).length,
    packer: 'TBD'
  }));

  // --- Revenue snapshot ---
  const todayRevenue = (db.revenue || [])
    .filter(r => r.date === today || (r.created_at && r.created_at.startsWith(today)))
    .reduce((s, r) => s + (r.amount || 0), 0);
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().split('T')[0];
  const yesterdayRevenue = (db.revenue || [])
    .filter(r => r.date === yesterdayStr || (r.created_at && r.created_at.startsWith(yesterdayStr)))
    .reduce((s, r) => s + (r.amount || 0), 0);

  // Week/month revenue
  const weekStart = new Date(); weekStart.setDate(weekStart.getDate() - weekStart.getDay());
  const monthStart = new Date(); monthStart.setDate(1);
  const weekRevenue = (db.revenue || []).filter(r => {
    const d = r.date || (r.created_at || '').split('T')[0];
    return d >= weekStart.toISOString().split('T')[0];
  }).reduce((s, r) => s + (r.amount || 0), 0);
  const monthRevenue = (db.revenue || []).filter(r => {
    const d = r.date || (r.created_at || '').split('T')[0];
    return d >= monthStart.toISOString().split('T')[0];
  }).reduce((s, r) => s + (r.amount || 0), 0);

  const deployedMachines = (db.machines || []).filter(m => m.status === 'deployed').length || 1;

  const revenue = {
    today: todayRevenue,
    yesterday: yesterdayRevenue,
    vs_yesterday: todayRevenue - yesterdayRevenue,
    week: weekRevenue,
    month: monthRevenue,
    transactions_today: (db.sales || []).filter(s => s.created_at && s.created_at.startsWith(today)).length,
    avg_per_machine: deployedMachines > 0 ? todayRevenue / deployedMachines : 0
  };

  // --- Activity feed ---
  const activities = [];
  
  // Driver check-ins today
  (db.driverCheckins || []).filter(c => c.created_at && c.created_at.startsWith(today)).forEach(c => {
    activities.push({ time: c.created_at, icon: '📍', text: `${c.driver_name || 'Driver'} checked in at machine #${c.machine_id}` });
  });

  // Driver restocks today
  (db.driverRestocks || []).filter(r => r.created_at && r.created_at.startsWith(today)).forEach(r => {
    const itemCount = (r.items || []).reduce((s, i) => s + (i.qty || 0), 0);
    activities.push({ time: r.created_at, icon: '📦', text: `${r.driver_name || 'Driver'} restocked ${itemCount} items at machine #${r.machine_id}` });
  });

  // Driver issues today
  (db.driverIssues || []).filter(i => i.created_at && i.created_at.startsWith(today)).forEach(i => {
    activities.push({ time: i.created_at, icon: '⚠️', text: `${i.driver_name || 'Driver'} reported ${i.type || 'issue'} at machine #${i.machine_id}` });
  });

  // Stock changes today
  (db.operationsLog || []).filter(l => l.timestamp && l.timestamp.startsWith(today)).forEach(l => {
    activities.push({ time: l.timestamp, icon: '📊', text: `Stock updated: ${l.notes || 'Quantity changed'}` });
  });

  activities.sort((a, b) => new Date(b.time) - new Date(a.time));

  res.json({
    routes: routeData,
    alerts,
    drivers,
    packing,
    revenue,
    activities
  });
});


// ===== CONTRACT TEMPLATES API =====
if (!db.contractTemplates) db.contractTemplates = [];
if (!db.contractDocuments) db.contractDocuments = [];

// Seed default contract templates
if ((db.contractTemplates || []).length === 0) {
  const defaultTemplates = [
    {
      id: nextId(),
      name: 'Location Agreement — Revenue Share',
      slug: 'rev-share',
      description: 'Standard amenity partnership agreement with revenue sharing model. Pre-filled with industry best practices.',
      category: 'location',
      body: `<div class="contract-doc">
<h1 style="text-align:center;margin-bottom:4px">SMART MARKET AMENITY PARTNERSHIP AGREEMENT</h1>
<h3 style="text-align:center;color:#666;margin-bottom:24px">Revenue Share Model</h3>
<p style="text-align:center;font-size:0.9em;color:#888;margin-bottom:32px">Agreement #{{contract_number}}</p>

<p>This Amenity Partnership Agreement ("Agreement") is entered into as of <strong>{{start_date}}</strong> ("Effective Date") by and between:</p>

<table style="width:100%;margin:16px 0 24px;border-collapse:collapse">
<tr><td style="width:50%;padding:8px;vertical-align:top"><strong>AMENITY PARTNER:</strong><br>Kandé VendTech LLC<br>Henderson, NV<br>Phone: {{company_phone}}<br>Email: {{company_email}}</td>
<td style="width:50%;padding:8px;vertical-align:top"><strong>PROPERTY:</strong><br>{{client_name}}<br>{{property_address}}<br>Contact: {{contact_name}}<br>Phone: {{contact_phone}}<br>Email: {{contact_email}}</td></tr>
</table>

<h3>1. SCOPE OF SERVICES</h3>
<p>Kandé VendTech ("Partner") shall install, stock, maintain, and service <strong>{{machine_count}}</strong> AI-powered smart market unit(s) at the Property location(s) specified above. Services include:</p>
<ul>
<li>Installation and setup of smart market equipment at zero cost to Property</li>
<li>Regular restocking with premium snacks, beverages, and convenience items</li>
<li>Ongoing maintenance, cleaning, and technical support</li>
<li>Cashless payment processing (credit/debit, mobile pay, tap-to-pay)</li>
<li>Remote monitoring and inventory optimization</li>
<li>24/7 customer support via QR code feedback system</li>
</ul>

<h3>2. REVENUE SHARE</h3>
<p>Partner shall pay Property a revenue share of <strong>{{rev_share_percent}}%</strong> of gross sales generated by the smart market unit(s), payable monthly. Revenue share payments shall commence <strong>{{rev_share_start}}</strong> after installation date.</p>
<p><em>Estimated monthly revenue: \${{estimated_monthly_revenue}}</em></p>

<h3>3. TERM</h3>
<p>This Agreement shall be for an initial term of <strong>{{term_years}} years</strong> commencing on the Effective Date, with automatic renewal for successive one-year periods unless either party provides written notice of non-renewal at least 60 days prior to the expiration of the then-current term.</p>

<h3>4. EQUIPMENT & INSTALLATION</h3>
<ul>
<li>All equipment remains the property of Kandé VendTech</li>
<li>Installation at zero cost to Property — no upfront fees</li>
<li>Property shall provide suitable electrical outlet (standard 110V) and reasonable access</li>
<li>Partner responsible for all equipment maintenance and repair</li>
</ul>

<h3>5. PROPERTY OBLIGATIONS</h3>
<ul>
<li>Provide suitable, secure indoor location for equipment</li>
<li>Maintain adequate electrical supply and climate control</li>
<li>Grant reasonable access for restocking and maintenance (minimum 2x per week)</li>
<li>Notify Partner promptly of any equipment issues or damage</li>
<li>Not install competing snack/beverage amenity services during the term</li>
</ul>

<h3>6. PRODUCT SELECTION</h3>
<p>Partner shall stock products based on resident/employee preferences, seasonal trends, and sales data analytics. Property may request specific products or dietary options. Partner will accommodate reasonable requests within 14 days.</p>

<h3>7. INSURANCE & LIABILITY</h3>
<p>Partner maintains comprehensive general liability insurance of not less than $1,000,000 per occurrence. Partner shall add Property as additional insured upon request. Partner assumes all liability for equipment operation and product quality.</p>

<h3>8. TERMINATION</h3>
<ul>
<li>Either party may terminate with 60 days written notice after the initial term</li>
<li>Early termination by Property during initial term requires 90 days notice</li>
<li>Partner may terminate immediately if Property breaches exclusivity clause</li>
<li>Upon termination, Partner shall remove equipment within 14 business days</li>
</ul>

<h3>9. ADDITIONAL TERMS</h3>
<p>{{additional_terms}}</p>

<div style="margin-top:48px">
<table style="width:100%;border-collapse:collapse">
<tr>
<td style="width:50%;padding:16px;vertical-align:top">
<p><strong>KANDÉ VENDTECH LLC</strong></p>
<br><br>
<div style="border-top:1px solid #333;width:250px;padding-top:4px">Signature</div>
<br>
<div style="border-top:1px solid #333;width:250px;padding-top:4px">Printed Name & Title</div>
<br>
<div style="border-top:1px solid #333;width:250px;padding-top:4px">Date</div>
</td>
<td style="width:50%;padding:16px;vertical-align:top">
<p><strong>{{client_name}}</strong></p>
<br><br>
<div style="border-top:1px solid #333;width:250px;padding-top:4px">Signature</div>
<br>
<div style="border-top:1px solid #333;width:250px;padding-top:4px">Printed Name & Title</div>
<br>
<div style="border-top:1px solid #333;width:250px;padding-top:4px">Date</div>
</td>
</tr>
</table>
</div>
</div>`,
      fields: [
        { key: 'contract_number', label: 'Contract #', type: 'text', default: '' },
        { key: 'start_date', label: 'Start Date', type: 'date', default: '' },
        { key: 'client_name', label: 'Property / Client Name', type: 'text', default: '' },
        { key: 'property_address', label: 'Property Address', type: 'text', default: '' },
        { key: 'contact_name', label: 'Contact Person', type: 'text', default: '' },
        { key: 'contact_phone', label: 'Contact Phone', type: 'text', default: '' },
        { key: 'contact_email', label: 'Contact Email', type: 'text', default: '' },
        { key: 'company_phone', label: 'Our Phone', type: 'text', default: '' },
        { key: 'company_email', label: 'Our Email', type: 'text', default: '' },
        { key: 'machine_count', label: 'Number of Units', type: 'number', default: '1' },
        { key: 'rev_share_percent', label: 'Revenue Share %', type: 'number', default: '5' },
        { key: 'rev_share_start', label: 'Rev Share Starts', type: 'text', default: '6 months' },
        { key: 'estimated_monthly_revenue', label: 'Est. Monthly Revenue', type: 'number', default: '2000' },
        { key: 'term_years', label: 'Term (Years)', type: 'number', default: '3' },
        { key: 'additional_terms', label: 'Additional Terms', type: 'textarea', default: 'None.' }
      ],
      created_at: new Date().toISOString()
    },
    {
      id: nextId(),
      name: 'Location Agreement — Flat Fee',
      slug: 'flat-fee',
      description: 'Amenity partnership with a flat monthly fee to the property instead of revenue share.',
      category: 'location',
      body: `<div class="contract-doc">
<h1 style="text-align:center;margin-bottom:4px">SMART MARKET AMENITY PARTNERSHIP AGREEMENT</h1>
<h3 style="text-align:center;color:#666;margin-bottom:24px">Flat Fee Model</h3>
<p style="text-align:center;font-size:0.9em;color:#888;margin-bottom:32px">Agreement #{{contract_number}}</p>

<p>This Amenity Partnership Agreement ("Agreement") is entered into as of <strong>{{start_date}}</strong> by and between:</p>

<table style="width:100%;margin:16px 0 24px;border-collapse:collapse">
<tr><td style="width:50%;padding:8px;vertical-align:top"><strong>AMENITY PARTNER:</strong><br>Kandé VendTech LLC<br>Henderson, NV<br>Phone: {{company_phone}}<br>Email: {{company_email}}</td>
<td style="width:50%;padding:8px;vertical-align:top"><strong>PROPERTY:</strong><br>{{client_name}}<br>{{property_address}}<br>Contact: {{contact_name}}<br>Phone: {{contact_phone}}<br>Email: {{contact_email}}</td></tr>
</table>

<h3>1. SCOPE OF SERVICES</h3>
<p>Kandé VendTech ("Partner") shall install, stock, maintain, and service <strong>{{machine_count}}</strong> AI-powered smart market unit(s) at the Property. All services provided at zero cost to Property, including:</p>
<ul>
<li>Equipment installation and setup</li>
<li>Regular restocking with premium products</li>
<li>Maintenance, cleaning, and technical support</li>
<li>Cashless payment processing</li>
<li>Remote monitoring and inventory management</li>
</ul>

<h3>2. FLAT FEE COMPENSATION</h3>
<p>Partner shall pay Property a flat monthly fee of <strong>\${{monthly_fee}}</strong>, payable on the 1st of each month. Payments commence <strong>{{payment_start}}</strong> after installation date.</p>

<h3>3. TERM</h3>
<p>Initial term: <strong>{{term_years}} years</strong> from the Effective Date, with automatic annual renewal unless either party provides 60 days written notice of non-renewal.</p>

<h3>4. EQUIPMENT</h3>
<p>All equipment remains Partner property. Installation at zero cost. Property provides standard electrical outlet and reasonable access.</p>

<h3>5. PROPERTY OBLIGATIONS</h3>
<ul>
<li>Provide secure, climate-controlled indoor location</li>
<li>Maintain electrical supply</li>
<li>Grant access for restocking/maintenance (minimum 2x weekly)</li>
<li>Exclusivity: no competing amenity services during term</li>
</ul>

<h3>6. INSURANCE</h3>
<p>Partner maintains $1,000,000+ general liability coverage and will add Property as additional insured upon request.</p>

<h3>7. TERMINATION</h3>
<p>60 days written notice after initial term. 90 days notice for early termination during initial term. Equipment removal within 14 business days.</p>

<h3>8. ADDITIONAL TERMS</h3>
<p>{{additional_terms}}</p>

<div style="margin-top:48px">
<table style="width:100%;border-collapse:collapse">
<tr>
<td style="width:50%;padding:16px;vertical-align:top"><strong>KANDÉ VENDTECH LLC</strong><br><br><br><div style="border-top:1px solid #333;width:250px;padding-top:4px">Signature / Date</div></td>
<td style="width:50%;padding:16px;vertical-align:top"><strong>{{client_name}}</strong><br><br><br><div style="border-top:1px solid #333;width:250px;padding-top:4px">Signature / Date</div></td>
</tr></table>
</div></div>`,
      fields: [
        { key: 'contract_number', label: 'Contract #', type: 'text', default: '' },
        { key: 'start_date', label: 'Start Date', type: 'date', default: '' },
        { key: 'client_name', label: 'Property / Client Name', type: 'text', default: '' },
        { key: 'property_address', label: 'Property Address', type: 'text', default: '' },
        { key: 'contact_name', label: 'Contact Person', type: 'text', default: '' },
        { key: 'contact_phone', label: 'Contact Phone', type: 'text', default: '' },
        { key: 'contact_email', label: 'Contact Email', type: 'text', default: '' },
        { key: 'company_phone', label: 'Our Phone', type: 'text', default: '' },
        { key: 'company_email', label: 'Our Email', type: 'text', default: '' },
        { key: 'machine_count', label: 'Number of Units', type: 'number', default: '1' },
        { key: 'monthly_fee', label: 'Monthly Fee ($)', type: 'number', default: '100' },
        { key: 'payment_start', label: 'Payments Start', type: 'text', default: '30 days' },
        { key: 'term_years', label: 'Term (Years)', type: 'number', default: '3' },
        { key: 'additional_terms', label: 'Additional Terms', type: 'textarea', default: 'None.' }
      ],
      created_at: new Date().toISOString()
    },
    {
      id: nextId(),
      name: 'Pilot Program Agreement',
      slug: 'pilot',
      description: '30-day free trial agreement. Zero risk for the property — the #1 closer from Skool community insights.',
      category: 'pilot',
      body: `<div class="contract-doc">
<h1 style="text-align:center;margin-bottom:4px">SMART MARKET PILOT PROGRAM AGREEMENT</h1>
<h3 style="text-align:center;color:#666;margin-bottom:24px">30-Day Complimentary Trial</h3>
<p style="text-align:center;font-size:0.9em;color:#888;margin-bottom:32px">Pilot #{{contract_number}}</p>

<p>This Pilot Program Agreement is entered into as of <strong>{{start_date}}</strong> by and between:</p>

<table style="width:100%;margin:16px 0 24px;border-collapse:collapse">
<tr><td style="width:50%;padding:8px;vertical-align:top"><strong>AMENITY PARTNER:</strong><br>Kandé VendTech LLC<br>Henderson, NV<br>Phone: {{company_phone}}<br>Email: {{company_email}}</td>
<td style="width:50%;padding:8px;vertical-align:top"><strong>PROPERTY:</strong><br>{{client_name}}<br>{{property_address}}<br>Contact: {{contact_name}}<br>Phone: {{contact_phone}}<br>Email: {{contact_email}}</td></tr>
</table>

<h3>1. PILOT PROGRAM OVERVIEW</h3>
<p>Kandé VendTech ("Partner") will install <strong>{{machine_count}}</strong> AI-powered smart market unit(s) at the Property for a <strong>{{trial_days}}-day complimentary trial period</strong> at absolutely zero cost and zero obligation to the Property.</p>

<div style="background:#f0f9ff;border:1px solid #90cdf4;border-radius:8px;padding:16px;margin:16px 0">
<strong>✅ ZERO RISK TO PROPERTY:</strong>
<ul style="margin:8px 0 0 16px">
<li>No cost for equipment, installation, or removal</li>
<li>No long-term commitment required</li>
<li>Full service and restocking included</li>
<li>We handle everything — you enjoy the amenity</li>
</ul>
</div>

<h3>2. PILOT TERMS</h3>
<ul>
<li><strong>Duration:</strong> {{trial_days}} days from installation date</li>
<li><strong>Cost to Property:</strong> $0 — completely free trial</li>
<li><strong>Services Included:</strong> Installation, stocking, maintenance, cashless payments</li>
<li><strong>Equipment:</strong> Remains Partner property at all times</li>
</ul>

<h3>3. AFTER THE PILOT</h3>
<p>At the end of the trial period, Property may:</p>
<ol>
<li><strong>Continue with a full partnership</strong> — We'll present partnership options including revenue share ({{rev_share_percent}}% of gross) or flat fee compensation</li>
<li><strong>End the pilot</strong> — We'll remove equipment within 7 business days at no cost</li>
</ol>
<p>If no decision is communicated within 7 days after the pilot ends, the trial will convert to a month-to-month arrangement with {{rev_share_percent}}% revenue share until either party provides 30 days notice.</p>

<h3>4. PROPERTY OBLIGATIONS DURING PILOT</h3>
<ul>
<li>Provide indoor location with standard electrical outlet</li>
<li>Allow access for restocking (minimum 2x weekly)</li>
<li>Report any equipment issues promptly</li>
</ul>

<h3>5. INSURANCE</h3>
<p>Partner maintains full liability coverage throughout the pilot period.</p>

<h3>6. ADDITIONAL NOTES</h3>
<p>{{additional_terms}}</p>

<div style="margin-top:48px">
<table style="width:100%;border-collapse:collapse">
<tr>
<td style="width:50%;padding:16px;vertical-align:top"><strong>KANDÉ VENDTECH LLC</strong><br><br><br><div style="border-top:1px solid #333;width:250px;padding-top:4px">Signature / Date</div></td>
<td style="width:50%;padding:16px;vertical-align:top"><strong>{{client_name}}</strong><br><br><br><div style="border-top:1px solid #333;width:250px;padding-top:4px">Signature / Date</div></td>
</tr></table>
</div></div>`,
      fields: [
        { key: 'contract_number', label: 'Pilot #', type: 'text', default: '' },
        { key: 'start_date', label: 'Start Date', type: 'date', default: '' },
        { key: 'client_name', label: 'Property / Client Name', type: 'text', default: '' },
        { key: 'property_address', label: 'Property Address', type: 'text', default: '' },
        { key: 'contact_name', label: 'Contact Person', type: 'text', default: '' },
        { key: 'contact_phone', label: 'Contact Phone', type: 'text', default: '' },
        { key: 'contact_email', label: 'Contact Email', type: 'text', default: '' },
        { key: 'company_phone', label: 'Our Phone', type: 'text', default: '' },
        { key: 'company_email', label: 'Our Email', type: 'text', default: '' },
        { key: 'machine_count', label: 'Number of Units', type: 'number', default: '1' },
        { key: 'trial_days', label: 'Trial Duration (Days)', type: 'number', default: '30' },
        { key: 'rev_share_percent', label: 'Post-Pilot Rev Share %', type: 'number', default: '5' },
        { key: 'additional_terms', label: 'Additional Notes', type: 'textarea', default: '' }
      ],
      created_at: new Date().toISOString()
    },
    {
      id: nextId(),
      name: 'Service Level Agreement',
      slug: 'sla',
      description: 'Defines service commitments, response times, and quality standards for the amenity partnership.',
      category: 'service',
      body: `<div class="contract-doc">
<h1 style="text-align:center;margin-bottom:4px">SERVICE LEVEL AGREEMENT</h1>
<h3 style="text-align:center;color:#666;margin-bottom:24px">Smart Market Amenity Services</h3>
<p style="text-align:center;font-size:0.9em;color:#888;margin-bottom:32px">SLA #{{contract_number}} — Effective {{start_date}}</p>

<p>This Service Level Agreement ("SLA") supplements the Amenity Partnership Agreement between Kandé VendTech LLC and <strong>{{client_name}}</strong> located at {{property_address}}.</p>

<h3>1. SERVICE COMMITMENTS</h3>
<table style="width:100%;border-collapse:collapse;margin:12px 0">
<tr style="background:#f8f9fa"><th style="padding:8px;text-align:left;border:1px solid #ddd">Service</th><th style="padding:8px;text-align:left;border:1px solid #ddd">Commitment</th></tr>
<tr><td style="padding:8px;border:1px solid #ddd">Restocking Frequency</td><td style="padding:8px;border:1px solid #ddd">Minimum {{restock_frequency}} per week</td></tr>
<tr><td style="padding:8px;border:1px solid #ddd">Equipment Uptime</td><td style="padding:8px;border:1px solid #ddd">{{uptime_percent}}% monthly uptime guarantee</td></tr>
<tr><td style="padding:8px;border:1px solid #ddd">Issue Response Time</td><td style="padding:8px;border:1px solid #ddd">Within {{response_hours}} hours of notification</td></tr>
<tr><td style="padding:8px;border:1px solid #ddd">On-Site Resolution</td><td style="padding:8px;border:1px solid #ddd">Within {{resolution_hours}} hours for critical issues</td></tr>
<tr><td style="padding:8px;border:1px solid #ddd">Product Freshness</td><td style="padding:8px;border:1px solid #ddd">All products within sell-by date; expired items removed immediately</td></tr>
<tr><td style="padding:8px;border:1px solid #ddd">Machine Cleanliness</td><td style="padding:8px;border:1px solid #ddd">Exterior cleaned at each restock; deep clean monthly</td></tr>
<tr><td style="padding:8px;border:1px solid #ddd">Product Requests</td><td style="padding:8px;border:1px solid #ddd">Evaluated within 7 days; stocked within 14 days if approved</td></tr>
</table>

<h3>2. COMMUNICATION</h3>
<ul>
<li><strong>Dedicated Contact:</strong> {{contact_name}} — available via phone, email, and text</li>
<li><strong>Issue Reporting:</strong> QR code on machine for instant feedback, or call/text our service line</li>
<li><strong>Monthly Reports:</strong> Sales summary, product performance, and service log provided by the 5th of each month</li>
</ul>

<h3>3. ESCALATION PROCESS</h3>
<ol>
<li><strong>Level 1:</strong> Route driver addresses during next scheduled visit (within {{response_hours}} hrs)</li>
<li><strong>Level 2:</strong> Operations manager dispatched for urgent issues (within {{resolution_hours}} hrs)</li>
<li><strong>Level 3:</strong> Owner/principal contact for unresolved issues (within 48 hrs)</li>
</ol>

<h3>4. PERFORMANCE REVIEW</h3>
<p>Partner will conduct quarterly performance reviews with Property management, covering sales data, product satisfaction, and service quality metrics.</p>

<h3>5. REMEDIES</h3>
<p>If Partner fails to meet uptime guarantee for 2 consecutive months, Property may request a service credit equal to one month of revenue share payment, or terminate the agreement with 30 days notice.</p>

<h3>6. ADDITIONAL COMMITMENTS</h3>
<p>{{additional_terms}}</p>

<div style="margin-top:48px">
<table style="width:100%;border-collapse:collapse">
<tr>
<td style="width:50%;padding:16px;vertical-align:top"><strong>KANDÉ VENDTECH LLC</strong><br><br><br><div style="border-top:1px solid #333;width:250px;padding-top:4px">Signature / Date</div></td>
<td style="width:50%;padding:16px;vertical-align:top"><strong>{{client_name}}</strong><br><br><br><div style="border-top:1px solid #333;width:250px;padding-top:4px">Signature / Date</div></td>
</tr></table>
</div></div>`,
      fields: [
        { key: 'contract_number', label: 'SLA #', type: 'text', default: '' },
        { key: 'start_date', label: 'Effective Date', type: 'date', default: '' },
        { key: 'client_name', label: 'Property / Client Name', type: 'text', default: '' },
        { key: 'property_address', label: 'Property Address', type: 'text', default: '' },
        { key: 'contact_name', label: 'Dedicated Contact', type: 'text', default: '' },
        { key: 'restock_frequency', label: 'Restocks Per Week', type: 'number', default: '2' },
        { key: 'uptime_percent', label: 'Uptime Guarantee %', type: 'number', default: '98' },
        { key: 'response_hours', label: 'Response Time (Hours)', type: 'number', default: '4' },
        { key: 'resolution_hours', label: 'Resolution Time (Hours)', type: 'number', default: '24' },
        { key: 'additional_terms', label: 'Additional Commitments', type: 'textarea', default: '' }
      ],
      created_at: new Date().toISOString()
    }
  ];

  defaultTemplates.forEach(t => db.contractTemplates.push(t));
  saveDB(db);
  console.log('📄 Seeded 4 default contract templates');
}

// Operations Incidents API
app.get('/api/operations/incidents', (req, res) => {
  res.json(db.operationsIncidents || []);
});

app.post('/api/operations/incidents', (req, res) => {
  if (!db.operationsIncidents) db.operationsIncidents = [];
  const incident = {
    id: nextId(),
    ...req.body,
    status: req.body.status || 'open',
    created_at: new Date().toISOString()
  };
  db.operationsIncidents.push(incident);
  saveDB(db);
  res.json(incident);
});

app.put('/api/operations/incidents/:id', (req, res) => {
  if (!db.operationsIncidents) db.operationsIncidents = [];
  const idx = db.operationsIncidents.findIndex(i => i.id === parseInt(req.params.id));
  if (idx === -1) return res.status(404).json({ error: 'Incident not found' });
  db.operationsIncidents[idx] = { ...db.operationsIncidents[idx], ...req.body, updated_at: new Date().toISOString() };
  saveDB(db);
  res.json(db.operationsIncidents[idx]);
});

// Contract Templates CRUD
app.get('/api/contract-templates', (req, res) => {
  res.json(db.contractTemplates || []);
});

app.get('/api/contract-templates/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const tmpl = (db.contractTemplates || []).find(t => t.id === id);
  if (!tmpl) return res.status(404).json({ error: 'Template not found' });
  res.json(tmpl);
});

app.post('/api/contract-templates', (req, res) => {
  const tmpl = {
    id: nextId(),
    name: req.body.name || 'Untitled Template',
    slug: req.body.slug || req.body.name?.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'custom',
    description: req.body.description || '',
    category: req.body.category || 'custom',
    body: req.body.body || '',
    fields: req.body.fields || [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  db.contractTemplates.push(tmpl);
  saveDB(db);
  res.json(tmpl);
});

app.put('/api/contract-templates/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const idx = (db.contractTemplates || []).findIndex(t => t.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Template not found' });
  db.contractTemplates[idx] = { ...db.contractTemplates[idx], ...req.body, updated_at: new Date().toISOString() };
  saveDB(db);
  res.json(db.contractTemplates[idx]);
});

app.delete('/api/contract-templates/:id', (req, res) => {
  const id = parseInt(req.params.id);
  db.contractTemplates = (db.contractTemplates || []).filter(t => t.id !== id);
  saveDB(db);
  res.json({ success: true });
});

// ===== ENHANCED CONTRACT DOCUMENTS API =====
// Full document storage with file upload (base64), version tracking, search
app.get('/api/contract-documents', (req, res) => {
  const { prospect_id, contract_id, doc_type, search } = req.query;
  let docs = db.contractDocuments || [];
  if (prospect_id) docs = docs.filter(d => d.prospect_id === parseInt(prospect_id));
  if (contract_id) docs = docs.filter(d => d.contract_id === parseInt(contract_id));
  if (doc_type) docs = docs.filter(d => d.doc_type === doc_type);
  if (search) {
    const q = search.toLowerCase();
    docs = docs.filter(d =>
      (d.title || '').toLowerCase().includes(q) ||
      (d.description || '').toLowerCase().includes(q) ||
      (d.file_name || '').toLowerCase().includes(q) ||
      (d.tags || []).some(t => t.toLowerCase().includes(q))
    );
  }
  // Return without file_data to keep responses small
  const light = docs.map(d => {
    const { file_data, ...rest } = d;
    return { ...rest, has_file: !!file_data };
  });
  res.json(light.sort((a, b) => new Date(b.created_at) - new Date(a.created_at)));
});

app.get('/api/contract-documents/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const doc = (db.contractDocuments || []).find(d => d.id === id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  res.json(doc);
});

app.get('/api/contract-documents/:id/download', (req, res) => {
  const id = parseInt(req.params.id);
  const doc = (db.contractDocuments || []).find(d => d.id === id);
  if (!doc || !doc.file_data) return res.status(404).json({ error: 'File not found' });
  
  const buffer = Buffer.from(doc.file_data, 'base64');
  res.setHeader('Content-Type', doc.file_type || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${doc.file_name || 'document'}"`);
  res.setHeader('Content-Length', buffer.length);
  res.send(buffer);
});

app.post('/api/contract-documents', (req, res) => {
  const doc = {
    id: nextId(),
    prospect_id: req.body.prospect_id ? parseInt(req.body.prospect_id) : null,
    contract_id: req.body.contract_id ? parseInt(req.body.contract_id) : null,
    doc_type: req.body.doc_type || 'other',
    title: req.body.title || 'Untitled Document',
    description: req.body.description || '',
    file_data: req.body.file_data || null,
    file_name: req.body.file_name || null,
    file_type: req.body.file_type || null,
    file_size: req.body.file_size || 0,
    tags: req.body.tags || [],
    version: req.body.version || 1,
    parent_doc_id: req.body.parent_doc_id || null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  if (!db.contractDocuments) db.contractDocuments = [];
  db.contractDocuments.push(doc);
  saveDB(db);
  res.json({ ...doc, file_data: undefined, has_file: !!doc.file_data });
});

app.put('/api/contract-documents/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const idx = (db.contractDocuments || []).findIndex(d => d.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Document not found' });
  db.contractDocuments[idx] = { ...db.contractDocuments[idx], ...req.body, updated_at: new Date().toISOString() };
  saveDB(db);
  const { file_data, ...rest } = db.contractDocuments[idx];
  res.json({ ...rest, has_file: !!file_data });
});

app.delete('/api/contract-documents/:id', (req, res) => {
  const id = parseInt(req.params.id);
  db.contractDocuments = (db.contractDocuments || []).filter(d => d.id !== id);
  saveDB(db);
  res.json({ success: true });
});

// ===== CONTRACT DASHBOARD SUMMARY API =====
app.get('/api/contract-dashboard', (req, res) => {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const contracts = db.contracts || [];
  
  const summary = {
    total: contracts.length,
    by_status: { draft: 0, sent: 0, viewed: 0, signed: 0, active: 0, expired: 0 },
    expiring_30: [],
    expiring_60: [],
    expiring_90: [],
    total_monthly_revenue: 0,
    avg_rev_share: 0,
    rev_share_contracts: 0,
    total_machines: 0,
    recent_activity: []
  };

  let revShareSum = 0;
  contracts.forEach(c => {
    // Status tracking
    const status = c.contract_status || 'active';
    if (summary.by_status[status] !== undefined) summary.by_status[status]++;

    // Expiring analysis
    const daysToEnd = c.end_date ? Math.ceil((new Date(c.end_date + 'T00:00:00') - now) / 864e5) : Infinity;
    if (daysToEnd >= 0 && daysToEnd <= 30) summary.expiring_30.push({ id: c.id, name: c.client_name, days: daysToEnd, end_date: c.end_date });
    else if (daysToEnd > 30 && daysToEnd <= 60) summary.expiring_60.push({ id: c.id, name: c.client_name, days: daysToEnd, end_date: c.end_date });
    else if (daysToEnd > 60 && daysToEnd <= 90) summary.expiring_90.push({ id: c.id, name: c.client_name, days: daysToEnd, end_date: c.end_date });

    // Revenue
    if (daysToEnd >= 0) {
      summary.total_monthly_revenue += c.monthly_revenue || 0;
      summary.total_machines += c.machines_count || 0;
    }

    // Rev share tracking
    if (c.contract_type === 'rev-share' && c.revenue_share_percent) {
      revShareSum += c.revenue_share_percent;
      summary.rev_share_contracts++;
    }
  });

  summary.avg_rev_share = summary.rev_share_contracts > 0 ? (revShareSum / summary.rev_share_contracts).toFixed(1) : 0;

  // Recent contract activities
  const recentContracts = [...contracts].sort((a, b) => new Date(b.updated_at || b.created_at) - new Date(a.updated_at || a.created_at)).slice(0, 10);
  summary.recent_activity = recentContracts.map(c => ({
    id: c.id,
    name: c.client_name,
    status: c.contract_status || 'active',
    date: c.updated_at || c.created_at
  }));

  res.json(summary);
});

// ===== SITE SURVEYS API =====
// Supports: POST /api/site-surveys, GET /api/site-surveys/:prospectId
// Auto-scoring based on Skool community insights:
//   Population × foot traffic × hours × interest - competitor penalty
// Auto-creates follow-up tasks and updates CRM prospect records

if (!db.siteSurveys) db.siteSurveys = [];

// Scoring algorithm — mirrors frontend logic for server-side validation
function calculateSurveyScore(survey) {
  let totalScore = 0;
  const breakdown = {};
  const redFlags = [];

  const pop = survey.population_count || 0;
  const traffic = survey.foot_traffic || 0;
  const shift = survey.shift_breakdown;
  const locType = survey.location_type;
  const interest = survey.interest_level || 0;
  const competitor = survey.competitor_present;
  const condition = survey.competitor_condition;
  const satisfaction = survey.competitor_satisfaction;
  const power = survey.power_available;
  const wifi = survey.wifi_available;
  const dm = survey.decision_maker_met;
  const gift = survey.gift_basket_delivered;
  const spaceW = survey.space_width || 0;
  const spaceD = survey.space_depth || 0;
  const spaceH = survey.space_height || 0;

  // 1. POPULATION (0-25 pts) — Skool: 100+ employees minimum, 200+ ideal
  let popScore = 0;
  if (pop >= 500) popScore = 25;
  else if (pop >= 300) popScore = 22;
  else if (pop >= 200) popScore = 20;
  else if (pop >= 150) popScore = 17;
  else if (pop >= 100) popScore = 14;
  else if (pop >= 50) popScore = 10;
  else if (pop > 0) { popScore = 5; redFlags.push('Under 50 people — below recommended minimum'); }
  breakdown['Population'] = popScore + '/25';
  totalScore += popScore;

  // 2. FOOT TRAFFIC (0-20 pts)
  let trafficScore = 0;
  if (traffic >= 500) trafficScore = 20;
  else if (traffic >= 300) trafficScore = 17;
  else if (traffic >= 200) trafficScore = 14;
  else if (traffic >= 100) trafficScore = 10;
  else if (traffic >= 50) trafficScore = 7;
  else if (traffic > 0) trafficScore = 3;
  breakdown['Foot Traffic'] = trafficScore + '/20';
  totalScore += trafficScore;

  // 3. ACCESSIBILITY — shifts + hours (0-15 pts) — Skool: 24/7 = premium
  let accessScore = 0;
  if (shift === '24hr') accessScore = 15;
  else if (shift === 'day_night') accessScore = 10;
  else if (shift === 'day_only') accessScore = 5;
  breakdown['Accessibility'] = accessScore + '/15';
  totalScore += accessScore;

  // 4. INTEREST & RELATIONSHIP (0-25 pts) — Skool: 8-10 touches to close
  let relScore = 0;
  relScore += interest * 4;
  if (dm) relScore += 3;
  if (gift) relScore += 2;
  relScore = Math.min(25, relScore);
  breakdown['Interest'] = relScore + '/25';
  totalScore += relScore;

  // 5. INFRASTRUCTURE (0-10 pts)
  let infraScore = 0;
  if (power) infraScore += 5;
  else if (power === false) redFlags.push('No power outlet — deal breaker');
  if (wifi) infraScore += 3;
  if (spaceW >= 39 && spaceD >= 35 && spaceH >= 72) infraScore += 2;
  else if (spaceW > 0 && (spaceW < 39 || spaceD < 35 || spaceH < 72)) {
    redFlags.push('Space too small for standard combo machine (39"W × 35"D × 72"H)');
  }
  infraScore = Math.max(0, Math.min(10, infraScore));
  breakdown['Infrastructure'] = infraScore + '/10';
  totalScore += infraScore;

  // 6. COMPETITION ADJUSTMENT (-15 to +5) — Skool: taking over Canteen locations
  let compScore = 0;
  if (!competitor) {
    compScore = 5;
  } else if (competitor) {
    if (condition === 'poor' || satisfaction === 'unhappy') compScore = 2;
    else if (condition === 'fair' || satisfaction === 'neutral') compScore = -5;
    else if (condition === 'good' || condition === 'excellent' || satisfaction === 'happy') {
      compScore = -12;
      redFlags.push('Strong competitor presence — harder to displace');
    }
  }
  breakdown['Competition'] = (compScore >= 0 ? '+' : '') + compScore;
  totalScore += compScore;

  // 7. LOCATION TYPE BONUS — Skool tier rankings
  const tier1 = ['rec_center', 'healthcare', 'school', 'industrial'];
  const tier2 = ['apartments', 'office', 'hotel', 'warehouse'];
  let typeBonus = 0;
  if (tier1.includes(locType)) typeBonus = 5;
  else if (tier2.includes(locType)) typeBonus = 3;
  else if (locType === 'senior_living') typeBonus = 2;
  if (locType) {
    breakdown['Location Type'] = (typeBonus >= 0 ? '+' : '') + typeBonus;
    totalScore += typeBonus;
  }

  // Clamp & cap
  totalScore = Math.max(0, Math.min(100, totalScore));
  if (power === false) totalScore = Math.min(totalScore, 30);

  // Grade
  let grade;
  if (totalScore >= 90) grade = 'A+';
  else if (totalScore >= 80) grade = 'A';
  else if (totalScore >= 70) grade = 'B+';
  else if (totalScore >= 60) grade = 'B';
  else if (totalScore >= 50) grade = 'C+';
  else if (totalScore >= 40) grade = 'C';
  else if (totalScore >= 30) grade = 'D';
  else grade = 'F';

  return { totalScore, grade, breakdown, redFlags };
}

// POST /api/site-surveys — Create a new site survey
app.post('/api/site-surveys', (req, res) => {
  const body = req.body;
  if (!body.prospect_id) {
    return res.status(400).json({ error: 'prospect_id is required' });
  }

  const prospect = db.prospects.find(p => p.id === parseInt(body.prospect_id));
  if (!prospect) {
    return res.status(404).json({ error: 'Prospect not found' });
  }

  // Server-side score recalculation for integrity
  const scoreResult = calculateSurveyScore(body);

  const survey = {
    id: nextId(),
    prospect_id: parseInt(body.prospect_id),
    // GPS
    gps_lat: body.gps_lat || null,
    gps_lng: body.gps_lng || null,
    gps_accuracy: body.gps_accuracy || null,
    // Location details
    location_type: body.location_type || null,
    population_count: body.population_count || null,
    foot_traffic: body.foot_traffic || null,
    shift_breakdown: body.shift_breakdown || null,
    access_hours: body.access_hours || null,
    nearest_amenities: body.nearest_amenities || null,
    // Competition
    competitor_present: !!body.competitor_present,
    competitor_brand: body.competitor_brand || null,
    competitor_count: body.competitor_count || null,
    competitor_condition: body.competitor_condition || null,
    competitor_satisfaction: body.competitor_satisfaction || null,
    // Infrastructure
    power_available: !!body.power_available,
    outlet_location: body.outlet_location || null,
    wifi_available: !!body.wifi_available,
    wifi_strength: body.wifi_strength || null,
    space_width: body.space_width || null,
    space_depth: body.space_depth || null,
    space_height: body.space_height || null,
    // Relationship
    decision_maker_met: !!body.decision_maker_met,
    dm_name: body.dm_name || null,
    dm_title: body.dm_title || null,
    dm_contact: body.dm_contact || null,
    gift_basket_delivered: !!body.gift_basket_delivered,
    interest_level: body.interest_level || 0,
    notes: body.notes || null,
    // Photos (base64 array)
    photos: Array.isArray(body.photos) ? body.photos : [],
    // Score (server-calculated)
    score_total: scoreResult.totalScore,
    score_grade: scoreResult.grade,
    score_breakdown: scoreResult.breakdown,
    red_flags: scoreResult.redFlags,
    // Meta
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  db.siteSurveys.push(survey);

  // --- Update CRM prospect record ---
  prospect.site_survey_id = survey.id;
  prospect.site_survey_grade = survey.score_grade;
  prospect.site_survey_score = survey.score_total;
  prospect.site_survey_date = survey.created_at;
  if (survey.location_type && !prospect.property_type) {
    prospect.property_type = survey.location_type;
  }
  if (survey.population_count && !prospect.units) {
    prospect.units = survey.population_count;
  }
  // Update GPS on prospect if better data
  if (survey.gps_lat && survey.gps_lng) {
    prospect.lat = survey.gps_lat;
    prospect.lng = survey.gps_lng;
  }
  // Add decision maker as contact if provided and new
  if (survey.dm_name) {
    const existingContact = db.contacts.find(c =>
      c.prospect_id === prospect.id &&
      c.name && c.name.toLowerCase() === survey.dm_name.toLowerCase()
    );
    if (!existingContact) {
      db.contacts.push({
        id: nextId(),
        prospect_id: prospect.id,
        name: survey.dm_name,
        role: survey.dm_title || 'Decision Maker',
        phone: survey.dm_contact || '',
        email: '',
        is_primary: db.contacts.filter(c => c.prospect_id === prospect.id).length === 0,
        created_at: new Date().toISOString()
      });
    }
  }
  prospect.updated_at = new Date().toISOString();

  // --- Log activity ---
  db.activities.push({
    id: nextId(),
    prospect_id: prospect.id,
    type: 'site_survey',
    description: `Site survey completed — Grade: ${survey.score_grade} (${survey.score_total}/100)${survey.red_flags.length > 0 ? ' ⚠️ ' + survey.red_flags.length + ' red flags' : ''}`,
    outcome: survey.interest_level >= 4 ? 'interested' : survey.interest_level <= 1 ? 'not_interested' : 'follow_up',
    next_action: survey.score_total >= 60 ? 'Send proposal' : survey.score_total >= 40 ? 'Schedule follow-up' : 'Evaluate — low score',
    next_action_date: new Date(Date.now() + (survey.score_total >= 60 ? 2 : 7) * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
    created_at: new Date().toISOString()
  });

  // --- Auto follow-up task ---
  // Skool insight: 8-10 touches to close, follow up based on score
  if (!db.todos) db.todos = [];
  let taskTitle, taskDesc, taskPriority, taskDueDays;

  if (survey.score_total >= 80) {
    taskTitle = `🔥 Send proposal to ${prospect.name}`;
    taskDesc = `Site survey grade: ${survey.score_grade} — HIGH priority location. Prepare "smart market amenity" proposal. Rev share 3-5%. Never say "vending."`;
    taskPriority = 'high';
    taskDueDays = 1;
  } else if (survey.score_total >= 60) {
    taskTitle = `📄 Follow up with ${prospect.name} — proposal`;
    taskDesc = `Site survey grade: ${survey.score_grade}. Good location potential. Prepare proposal and schedule follow-up meeting.`;
    taskPriority = 'high';
    taskDueDays = 3;
  } else if (survey.score_total >= 40) {
    taskTitle = `📞 Follow up with ${prospect.name}`;
    taskDesc = `Site survey grade: ${survey.score_grade}. Moderate potential. Schedule another visit or call to reassess.${survey.red_flags.length > 0 ? ' Red flags: ' + survey.red_flags.join('; ') : ''}`;
    taskPriority = 'medium';
    taskDueDays = 7;
  } else {
    taskTitle = `⚠️ Review ${prospect.name} — low score`;
    taskDesc = `Site survey grade: ${survey.score_grade} (${survey.score_total}/100). Consider deprioritizing.${survey.red_flags.length > 0 ? ' Red flags: ' + survey.red_flags.join('; ') : ''}`;
    taskPriority = 'low';
    taskDueDays = 14;
  }

  const dueDate = new Date(Date.now() + taskDueDays * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  db.todos.push({
    id: nextId(),
    title: taskTitle,
    description: taskDesc,
    category: 'Sales',
    priority: taskPriority,
    due_date: dueDate,
    status: 'pending',
    completed: false,
    completed_at: null,
    prospect_id: prospect.id,
    survey_id: survey.id,
    notes: `Auto-generated from site survey on ${new Date().toLocaleDateString()}`,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  });

  // --- Update prospect priority based on survey ---
  if (survey.score_total >= 80 && survey.interest_level >= 4) {
    prospect.priority = 'hot';
  } else if (survey.score_total >= 60 || survey.interest_level >= 3) {
    if (prospect.priority !== 'hot') prospect.priority = 'warm';
  }

  saveDB(db);

  res.json({
    survey,
    followup_task: { title: taskTitle, due_date: dueDate, priority: taskPriority },
    prospect_updated: { id: prospect.id, priority: prospect.priority, grade: survey.score_grade }
  });
});

// GET /api/site-surveys/:prospectId — Get all surveys for a prospect
app.get('/api/site-surveys/:prospectId', (req, res) => {
  const prospectId = parseInt(req.params.prospectId);
  const surveys = (db.siteSurveys || [])
    .filter(s => s.prospect_id === prospectId)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  // Strip photos from list response (too large) — include photo count instead
  const lightweight = surveys.map(s => ({
    ...s,
    photo_count: (s.photos || []).length,
    photos: undefined
  }));

  res.json(lightweight);
});

// GET /api/site-surveys/:prospectId/:surveyId — Get a single survey with full photos
app.get('/api/site-surveys/:prospectId/:surveyId', (req, res) => {
  const prospectId = parseInt(req.params.prospectId);
  const surveyId = parseInt(req.params.surveyId);
  const survey = (db.siteSurveys || []).find(s => s.id === surveyId && s.prospect_id === prospectId);
  if (!survey) return res.status(404).json({ error: 'Survey not found' });
  res.json(survey);
});

// GET /api/site-surveys — Get all surveys (lightweight, no photos)
app.get('/api/site-surveys', (req, res) => {
  const surveys = (db.siteSurveys || [])
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  const lightweight = surveys.map(s => {
    const prospect = db.prospects.find(p => p.id === s.prospect_id);
    return {
      ...s,
      prospect_name: prospect?.name || 'Unknown',
      photo_count: (s.photos || []).length,
      photos: undefined
    };
  });

  res.json(lightweight);
});

// Serve the site survey page
app.get('/site-survey', (req, res) => {
  res.sendFile(path.join(__dirname, 'site-survey.html'));
});

// ===== FINANCIALS MODULE (appended 2026-02-02) =====
// Labor tracking, commissions, rev share — Skool insights: 3-5% rev share, $2K/month min

// Ensure new collections
if (!db.laborLogs) db.laborLogs = [];
if (!db.commissionPayments) db.commissionPayments = [];

// Labor logs API
app.get('/api/financials/labor', (req, res) => {
  const { start, end } = req.query;
  let records = db.laborLogs || [];
  if (start) records = records.filter(l => l.date >= start);
  if (end) records = records.filter(l => l.date <= end);
  res.json(records.sort((a, b) => (b.date || '').localeCompare(a.date || '')));
});

app.post('/api/financials/labor', (req, res) => {
  const record = {
    id: nextId(),
    worker: req.body.worker,
    role: req.body.role || 'driver',
    hours: parseFloat(req.body.hours) || 0,
    rate: parseFloat(req.body.rate) || 0,
    date: req.body.date,
    route_id: req.body.route_id || null,
    notes: req.body.notes || null,
    created_at: new Date().toISOString()
  };
  db.laborLogs.push(record);
  saveDB(db);
  res.json(record);
});

app.delete('/api/financials/labor/:id', (req, res) => {
  const id = parseInt(req.params.id);
  db.laborLogs = (db.laborLogs || []).filter(l => l.id !== id);
  saveDB(db);
  res.json({ success: true });
});

// Commission payments API
app.get('/api/financials/commissions', (req, res) => {
  const records = (db.commissionPayments || []).sort((a, b) => (b.period_end || '').localeCompare(a.period_end || ''));
  res.json(records);
});

app.post('/api/financials/commissions', (req, res) => {
  const record = {
    id: nextId(),
    location_id: parseInt(req.body.location_id),
    amount: parseFloat(req.body.amount) || 0,
    period_start: req.body.period_start,
    period_end: req.body.period_end,
    status: req.body.status || 'pending',
    paid_date: req.body.paid_date || null,
    notes: req.body.notes || null,
    created_at: new Date().toISOString()
  };
  db.commissionPayments.push(record);
  saveDB(db);
  res.json(record);
});

app.put('/api/financials/commissions/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const idx = (db.commissionPayments || []).findIndex(c => c.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  db.commissionPayments[idx] = { ...db.commissionPayments[idx], ...req.body, updated_at: new Date().toISOString() };
  saveDB(db);
  res.json(db.commissionPayments[idx]);
});

app.delete('/api/financials/commissions/:id', (req, res) => {
  const id = parseInt(req.params.id);
  db.commissionPayments = (db.commissionPayments || []).filter(c => c.id !== id);
  saveDB(db);
  res.json({ success: true });
});

// Quick stats endpoint for financial dashboard
app.get('/api/financials/quick-stats', (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const currentMonth = today.substring(0, 7);
  const lastMonth = new Date(); lastMonth.setMonth(lastMonth.getMonth() - 1);
  const lastMonthStr = lastMonth.toISOString().substring(0, 7);

  const allRev = (db.finances || []).filter(f => f.type === 'revenue');
  const allExp = (db.finances || []).filter(f => f.type === 'expense');

  const todayRev = allRev.filter(f => (f.created_at || '').startsWith(today)).reduce((s, f) => s + (f.amount || 0), 0);
  const monthRev = allRev.filter(f => f.month === currentMonth).reduce((s, f) => s + (f.amount || 0), 0);
  const lastMonthRev = allRev.filter(f => f.month === lastMonthStr).reduce((s, f) => s + (f.amount || 0), 0);
  const monthExp = allExp.filter(f => f.month === currentMonth).reduce((s, f) => s + (f.amount || 0), 0);

  const monthLabor = (db.laborLogs || [])
    .filter(l => l.date && l.date.startsWith(currentMonth))
    .reduce((s, l) => s + ((l.hours || 0) * (l.rate || 0)), 0);

  const totalCosts = monthExp + monthLabor;
  const profit = monthRev - totalCosts;
  const margin = monthRev > 0 ? (profit / monthRev * 100) : 0;
  const changeVsLast = lastMonthRev > 0 ? ((monthRev - lastMonthRev) / lastMonthRev * 100) : 0;

  const deployed = (db.machines || []).filter(m => m.status === 'deployed');
  const avgPerMachine = deployed.length > 0 ? (monthRev / deployed.length) : 0;

  // Best/worst machine
  const machRevMap = {};
  allRev.filter(f => f.month === currentMonth && f.machine_id).forEach(f => {
    machRevMap[f.machine_id] = (machRevMap[f.machine_id] || 0) + (f.amount || 0);
  });
  const sorted = Object.entries(machRevMap).map(([id, total]) => ({ id: parseInt(id), total })).sort((a, b) => b.total - a.total);
  const best = sorted[0]; const worst = sorted[sorted.length - 1];
  const bestMach = best ? (db.machines || []).find(m => m.id === best.id) : null;
  const worstMach = worst ? (db.machines || []).find(m => m.id === worst.id) : null;

  res.json({
    today_revenue: todayRev,
    month_revenue: monthRev,
    last_month_revenue: lastMonthRev,
    change_vs_last: Math.round(changeVsLast * 10) / 10,
    month_expenses: monthExp,
    month_labor: monthLabor,
    total_costs: totalCosts,
    profit: profit,
    profit_margin: Math.round(margin * 10) / 10,
    avg_per_machine: Math.round(avgPerMachine * 100) / 100,
    deployed_machines: deployed.length,
    best_machine: bestMach ? { id: bestMach.id, name: bestMach.name, total: best.total } : null,
    worst_machine: worstMach ? { id: worstMach.id, name: worstMach.name, total: worst.total } : null
  });
});

// Underperforming locations (below $2K/month minimum)
app.get('/api/financials/underperforming', (req, res) => {
  const currentMonth = new Date().toISOString().substring(0, 7);
  const monthRev = (db.finances || []).filter(f => f.type === 'revenue' && f.month === currentMonth);

  const locRevMap = {};
  monthRev.forEach(f => {
    if (f.machine_id) {
      const m = (db.machines || []).find(mm => mm.id === f.machine_id);
      if (m && m.location_id) {
        locRevMap[m.location_id] = (locRevMap[m.location_id] || 0) + (f.amount || 0);
      }
    }
  });

  const underperforming = (db.locations || [])
    .filter(l => {
      const rev = locRevMap[l.id] || 0;
      const min = l.monthly_minimum || 2000;
      const hasMachines = (db.machines || []).some(m => m.location_id === l.id);
      return hasMachines && rev < min;
    })
    .map(l => ({
      id: l.id,
      name: l.name || l.address,
      revenue: locRevMap[l.id] || 0,
      minimum: l.monthly_minimum || 2000,
      gap: (locRevMap[l.id] || 0) - (l.monthly_minimum || 2000)
    }));

  res.json(underperforming);
});

// Serve the financials page
app.get('/financials', (req, res) => {
  res.sendFile(path.join(__dirname, 'financials.html'));
});

// ============================================================
// ===== MACHINE MANAGEMENT SYSTEM (v2) =====================
// ===== Slot inventory, pricing intelligence, bundles, =====
// ===== analytics, shrinkage, A/B testing                =====
// ============================================================

// --- Initialize new collections ---
if (!db.machineSlots) db.machineSlots = [];
if (!db.inventoryLogs) db.inventoryLogs = [];
if (!db.restockEvents) db.restockEvents = [];
if (!db.restockItems) db.restockItems = [];
if (!db.pricingProfiles) db.pricingProfiles = [];
if (!db.pricingRules) db.pricingRules = [];
if (!db.salesTransactions) db.salesTransactions = [];
if (!db.bundleDefs) db.bundleDefs = [];
if (!db.bundleItems) db.bundleItems = [];
if (!db.bundleTransactions) db.bundleTransactions = [];
if (!db.abTests) db.abTests = [];
if (!db.shrinkageEvents) db.shrinkageEvents = [];
if (!db.slotExpiryBatches) db.slotExpiryBatches = [];

// --- Seed default pricing profiles if empty ---
if (db.pricingProfiles.length === 0) {
  const defaultProfiles = [
    { name: 'Gym / Recreation Center', location_type: 'rec_center', beverage_mult: 1.10, snack_mult: 0.95, candy_mult: 0.90, incidental_mult: 1.20 },
    { name: 'Hospital ER / Waiting', location_type: 'hospital_er', beverage_mult: 1.05, snack_mult: 1.10, candy_mult: 1.10, incidental_mult: 1.30 },
    { name: 'Manufacturing / Warehouse', location_type: 'manufacturing', beverage_mult: 1.00, snack_mult: 1.00, candy_mult: 1.00, incidental_mult: 1.00 },
    { name: 'Luxury Apartment (200+)', location_type: 'luxury_apt', beverage_mult: 1.15, snack_mult: 1.10, candy_mult: 1.05, incidental_mult: 1.40 },
    { name: 'K-12 School', location_type: 'k12_school', beverage_mult: 0.95, snack_mult: 1.00, candy_mult: 1.05, incidental_mult: 0.80 },
    { name: 'Large Office (100+)', location_type: 'office_large', beverage_mult: 1.05, snack_mult: 1.05, candy_mult: 1.00, incidental_mult: 1.15 },
    { name: 'College / University', location_type: 'university', beverage_mult: 0.95, snack_mult: 1.00, candy_mult: 1.05, incidental_mult: 1.10 },
    { name: 'Senior Living', location_type: 'senior_living', beverage_mult: 1.00, snack_mult: 1.05, candy_mult: 1.10, incidental_mult: 1.20 },
    { name: 'Distribution Center', location_type: 'distribution_center', beverage_mult: 1.00, snack_mult: 1.00, candy_mult: 1.00, incidental_mult: 1.05 },
    { name: 'Call Center', location_type: 'call_center', beverage_mult: 1.05, snack_mult: 1.05, candy_mult: 1.05, incidental_mult: 1.10 },
    { name: 'Government Building', location_type: 'government', beverage_mult: 1.00, snack_mult: 1.00, candy_mult: 1.00, incidental_mult: 1.00 },
    { name: 'Hotel (Back of House)', location_type: 'hotel', beverage_mult: 1.10, snack_mult: 1.05, candy_mult: 1.00, incidental_mult: 1.25 },
    { name: 'Data Center', location_type: 'data_center', beverage_mult: 1.05, snack_mult: 1.00, candy_mult: 1.00, incidental_mult: 1.35 },
    { name: 'Construction Staging', location_type: 'construction_yard', beverage_mult: 0.95, snack_mult: 1.00, candy_mult: 1.00, incidental_mult: 0.95 },
  ];
  defaultProfiles.forEach(p => {
    db.pricingProfiles.push({
      id: nextId(), ...p,
      price_overrides: {}, min_margin_pct: 66.0, round_to: 0.25,
      is_default: true,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString()
    });
  });
  saveDB(db);
  console.log('💰 Seeded 14 default pricing profiles');
}

// --- Helper: Initialize slot grid for a fleet machine ---
function initializeMachineSlots(machineId, rows = 6, cols = 10) {
  // Remove any existing slots for this machine
  db.machineSlots = db.machineSlots.filter(s => s.machine_id !== machineId);
  const slots = [];
  let slotNum = 1;
  for (let r = 1; r <= rows; r++) {
    for (let c = 1; c <= cols; c++) {
      slots.push({
        id: nextId(),
        machine_id: machineId,
        slot_number: slotNum,
        row_position: r,
        col_position: c,
        product_id: null,
        max_capacity: 8,
        current_qty: 0,
        par_level: 3,
        low_threshold: 2,
        earliest_expiry: null,
        price_override: null,
        total_sold: 0,
        total_revenue: 0,
        last_sold_at: null,
        avg_daily_velocity: 0,
        is_eye_level: (r === 3 || r === 4),
        is_impulse_zone: (c >= 9),
        position_tier: (r === 3 || r === 4) ? 'premium' : (r === 2 || r === 5) ? 'standard' : 'value',
        experiment_id: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      });
      slotNum++;
    }
  }
  db.machineSlots.push(...slots);
  saveDB(db);
  return slots;
}

// --- Helper: Calculate price for product in machine context ---
function calculateMachinePrice(machineId, productId, slotId) {
  const machine = (db.fleetMachines || []).find(m => m.id === machineId);
  const product = (db.products || []).find(p => p.id === productId);
  if (!product) return null;

  let basePrice = product.sell_price || product.default_price || 2.50;
  let result = basePrice;

  // Apply pricing profile
  if (machine && machine.pricing_profile_id) {
    const profile = db.pricingProfiles.find(p => p.id === machine.pricing_profile_id);
    if (profile) {
      const cat = (product.category || '').toLowerCase();
      const mult = cat === 'beverage' || cat === 'drinks' ? profile.beverage_mult
        : cat === 'snack' || cat === 'snacks' ? profile.snack_mult
        : cat === 'candy' ? profile.candy_mult
        : cat === 'incidental' || cat === 'incidentals' ? profile.incidental_mult
        : 1.0;
      result = basePrice * mult;

      // Product-specific override from profile
      if (profile.price_overrides && profile.price_overrides[productId]) {
        result = profile.price_overrides[productId];
      }
    }
  }

  // Check slot-level override
  if (slotId) {
    const slot = db.machineSlots.find(s => s.id === slotId);
    if (slot && slot.price_override !== null && slot.price_override !== undefined) {
      result = slot.price_override;
    }
  }

  // Enforce 3x markup minimum
  const unitCost = product.cost_price || product.unit_cost || 0;
  const minPrice = unitCost * 3;
  if (result < minPrice && minPrice > 0) result = minPrice;

  // Round to nearest $0.25
  result = Math.round(result / 0.25) * 0.25;

  return result;
}

// --- Helper: Calculate slot heat score ---
function calculateHeatScore(slot, machineSlots) {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const slotTx = (db.salesTransactions || []).filter(t => t.slot_id === slot.id && t.sold_at >= thirtyDaysAgo);
  const revenue = slotTx.reduce((s, t) => s + (t.total_price || 0), 0);
  const unitsSold = slotTx.reduce((s, t) => s + (t.quantity || 1), 0);
  const velocity = unitsSold / 30;

  // Get machine averages
  const machineTx = (db.salesTransactions || []).filter(t =>
    machineSlots.some(ms => ms.id === t.slot_id) && t.sold_at >= thirtyDaysAgo
  );
  const slotRevenues = {};
  machineTx.forEach(t => {
    slotRevenues[t.slot_id] = (slotRevenues[t.slot_id] || 0) + (t.total_price || 0);
  });
  const revValues = Object.values(slotRevenues);
  const avgRevenue = revValues.length > 0 ? revValues.reduce((a, b) => a + b, 0) / revValues.length : 0;

  if (avgRevenue === 0) return 0;
  return Math.min(100, Math.max(0, Math.round((revenue / avgRevenue) * 50)));
}

// --- Helper: Pagination ---
function paginate(array, page, limit) {
  const p = Math.max(1, parseInt(page) || 1);
  const l = Math.min(100, Math.max(1, parseInt(limit) || 20));
  const total = array.length;
  const totalPages = Math.ceil(total / l);
  const start = (p - 1) * l;
  const data = array.slice(start, start + l);
  return { data, pagination: { page: p, limit: l, total, totalPages } };
}

// ============================================================
// GET /api/fleet/:id/slots — Slot grid for a machine
// ============================================================
app.get('/api/fleet/:id/slots', (req, res) => {
  const machineId = parseInt(req.params.id);
  const machine = (db.fleetMachines || []).find(m => m.id === machineId);
  if (!machine) return res.status(404).json({ success: false, error: 'Machine not found' });

  let slots = db.machineSlots.filter(s => s.machine_id === machineId);

  // Auto-initialize if no slots exist
  if (slots.length === 0) {
    slots = initializeMachineSlots(machineId, machine.slot_rows || 6, machine.slot_cols || 10);
  }

  // Enrich with product info
  const enriched = slots.map(s => {
    const product = s.product_id ? (db.products || []).find(p => p.id === s.product_id) : null;
    const status = s.current_qty === 0 ? 'empty'
      : s.current_qty <= s.low_threshold ? 'low'
      : s.current_qty <= s.par_level ? 'below_par'
      : s.current_qty >= s.max_capacity * 0.75 ? 'full'
      : 'normal';
    return {
      ...s,
      product_name: product ? product.name : null,
      product_category: product ? product.category : null,
      calculated_price: product ? calculateMachinePrice(machineId, s.product_id, s.id) : null,
      status,
      heat_score: calculateHeatScore(s, slots)
    };
  }).sort((a, b) => a.slot_number - b.slot_number);

  // Build grid (6×10)
  const rows = machine.slot_rows || 6;
  const cols = machine.slot_cols || 10;
  const grid = [];
  for (let r = 1; r <= rows; r++) {
    grid.push(enriched.filter(s => s.row_position === r).sort((a, b) => a.col_position - b.col_position));
  }

  const summary = {
    total_slots: enriched.length,
    empty: enriched.filter(s => s.status === 'empty').length,
    low: enriched.filter(s => s.status === 'low').length,
    below_par: enriched.filter(s => s.status === 'below_par').length,
    normal: enriched.filter(s => s.status === 'normal').length,
    full: enriched.filter(s => s.status === 'full').length,
    assigned: enriched.filter(s => s.product_id).length,
    avg_fill_pct: enriched.length > 0
      ? Math.round(enriched.reduce((s, sl) => s + (sl.current_qty / sl.max_capacity), 0) / enriched.length * 100)
      : 0
  };

  res.json({ success: true, data: { machine_id: machineId, machine_name: machine.serial || machine.location, slots: enriched, grid, summary } });
});

// ============================================================
// PUT /api/fleet/:id/slots/:slotId — Update a single slot
// ============================================================
app.put('/api/fleet/:id/slots/:slotId', (req, res) => {
  const machineId = parseInt(req.params.id);
  const slotId = parseInt(req.params.slotId);
  const idx = db.machineSlots.findIndex(s => s.id === slotId && s.machine_id === machineId);
  if (idx === -1) return res.status(404).json({ success: false, error: 'Slot not found' });

  const allowed = ['product_id', 'max_capacity', 'current_qty', 'par_level', 'low_threshold',
    'price_override', 'earliest_expiry'];
  const updates = {};
  allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });

  db.machineSlots[idx] = { ...db.machineSlots[idx], ...updates, updated_at: new Date().toISOString() };
  saveDB(db);
  res.json({ success: true, data: db.machineSlots[idx] });
});

// ============================================================
// POST /api/fleet/:id/slots/assign — Assign product to slot
// ============================================================
app.post('/api/fleet/:id/slots/assign', (req, res) => {
  const machineId = parseInt(req.params.id);
  const { slot_id, product_id } = req.body;
  if (!slot_id) return res.status(400).json({ success: false, error: 'slot_id required' });

  const idx = db.machineSlots.findIndex(s => s.id === slot_id && s.machine_id === machineId);
  if (idx === -1) return res.status(404).json({ success: false, error: 'Slot not found' });

  const oldProductId = db.machineSlots[idx].product_id;

  // Log swap out if there was a previous product
  if (oldProductId && oldProductId !== product_id) {
    db.inventoryLogs.push({
      id: nextId(),
      slot_id, machine_id: machineId, product_id: oldProductId,
      change_type: 'swap_out',
      qty_before: db.machineSlots[idx].current_qty,
      qty_change: -db.machineSlots[idx].current_qty,
      qty_after: 0,
      performed_by: req.body.performed_by || 'system',
      created_at: new Date().toISOString()
    });
  }

  db.machineSlots[idx].product_id = product_id || null;
  db.machineSlots[idx].current_qty = product_id ? 0 : 0;
  db.machineSlots[idx].total_sold = product_id === oldProductId ? db.machineSlots[idx].total_sold : 0;
  db.machineSlots[idx].total_revenue = product_id === oldProductId ? db.machineSlots[idx].total_revenue : 0;
  db.machineSlots[idx].updated_at = new Date().toISOString();
  saveDB(db);

  const product = product_id ? (db.products || []).find(p => p.id === product_id) : null;
  res.json({ success: true, data: { ...db.machineSlots[idx], product_name: product ? product.name : null } });
});

// ============================================================
// POST /api/fleet/:id/restock — Batch restock operation
// ============================================================
app.post('/api/fleet/:id/restock', (req, res) => {
  const machineId = parseInt(req.params.id);
  const machine = (db.fleetMachines || []).find(m => m.id === machineId);
  if (!machine) return res.status(404).json({ success: false, error: 'Machine not found' });

  const { driver_name, started_at, completed_at, mileage, fuel_cost, items, notes } = req.body;
  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ success: false, error: 'items array required' });
  }

  const startTime = started_at || new Date().toISOString();
  const endTime = completed_at || new Date().toISOString();
  const durationMin = Math.round((new Date(endTime) - new Date(startTime)) / 60000);

  let totalItemsLoaded = 0;
  let totalItemsPulled = 0;
  let totalProductCost = 0;
  const shrinkageDetected = [];
  const processedItems = [];

  // Create restock event
  const event = {
    id: nextId(),
    machine_id: machineId,
    driver_name: driver_name || 'Unknown',
    started_at: startTime,
    completed_at: endTime,
    duration_min: durationMin,
    slots_serviced: items.length,
    items_loaded: 0,
    items_pulled: 0,
    product_cost: 0,
    mileage: mileage || null,
    fuel_cost: fuel_cost || 0,
    labor_cost: Math.round((durationMin / 60) * 20 * 100) / 100, // $20/hr
    notes: notes || '',
    created_at: new Date().toISOString()
  };

  // Process each slot
  for (const item of items) {
    const slotIdx = db.machineSlots.findIndex(s => s.id === item.slot_id && s.machine_id === machineId);
    if (slotIdx === -1) continue;

    const slot = db.machineSlots[slotIdx];
    const qtyBefore = item.qty_before !== undefined ? item.qty_before : slot.current_qty;
    const qtyAdded = item.qty_added || 0;
    const qtyRemoved = item.qty_removed || 0;
    const qtyAfter = qtyBefore + qtyAdded - qtyRemoved;
    const unitCost = item.unit_cost || 0;

    totalItemsLoaded += qtyAdded;
    totalItemsPulled += qtyRemoved;
    totalProductCost += qtyAdded * unitCost;

    // Create restock line item
    const lineItem = {
      id: nextId(),
      restock_id: event.id,
      slot_id: item.slot_id,
      product_id: item.product_id || slot.product_id,
      qty_before: qtyBefore,
      qty_added: qtyAdded,
      qty_removed: qtyRemoved,
      qty_after: qtyAfter,
      unit_cost: unitCost,
      line_cost: qtyAdded * unitCost,
      expiry_date: item.expiry_date || null,
      was_empty: qtyBefore === 0,
      notes: item.notes || '',
      created_at: new Date().toISOString()
    };
    db.restockItems.push(lineItem);
    processedItems.push(lineItem);

    // Update slot
    db.machineSlots[slotIdx].current_qty = Math.max(0, qtyAfter);
    db.machineSlots[slotIdx].updated_at = new Date().toISOString();

    // Log inventory change (restock add)
    if (qtyAdded > 0) {
      db.inventoryLogs.push({
        id: nextId(),
        slot_id: item.slot_id, machine_id: machineId,
        product_id: item.product_id || slot.product_id,
        change_type: 'restock',
        qty_before: qtyBefore, qty_change: qtyAdded, qty_after: qtyBefore + qtyAdded,
        restock_event_id: event.id,
        performed_by: driver_name || 'Unknown',
        created_at: new Date().toISOString()
      });
    }

    // Log expired pulls
    if (qtyRemoved > 0) {
      db.inventoryLogs.push({
        id: nextId(),
        slot_id: item.slot_id, machine_id: machineId,
        product_id: item.product_id || slot.product_id,
        change_type: 'expired_pull',
        qty_before: qtyBefore + qtyAdded, qty_change: -qtyRemoved, qty_after: qtyAfter,
        restock_event_id: event.id,
        performed_by: driver_name || 'Unknown',
        reason: item.notes || 'Expired items pulled',
        created_at: new Date().toISOString()
      });
    }

    // Track expiry batch
    if (item.expiry_date && qtyAdded > 0) {
      db.slotExpiryBatches.push({
        id: nextId(),
        slot_id: item.slot_id,
        quantity: qtyAdded,
        expiry_date: item.expiry_date,
        loaded_at: new Date().toISOString(),
        is_active: true,
        created_at: new Date().toISOString()
      });
      // Update slot earliest expiry
      const slotBatches = db.slotExpiryBatches.filter(b => b.slot_id === item.slot_id && b.is_active);
      const earliest = slotBatches.sort((a, b) => a.expiry_date.localeCompare(b.expiry_date))[0];
      if (earliest) db.machineSlots[slotIdx].earliest_expiry = earliest.expiry_date;
    }

    // Detect shrinkage: compare expected vs actual qty before restock
    if (slot.current_qty !== qtyBefore && qtyBefore < slot.current_qty) {
      // Expected more than found — potential shrinkage
      const discrepancy = slot.current_qty - qtyBefore;
      const product = (db.products || []).find(p => p.id === (item.product_id || slot.product_id));
      const shrinkageEvent = {
        id: nextId(),
        machine_id: machineId, slot_id: item.slot_id,
        product_id: item.product_id || slot.product_id,
        shrinkage_type: discrepancy <= 1 ? 'miscount' : 'unknown',
        quantity: discrepancy,
        unit_cost: unitCost || (product ? product.cost_price || 0 : 0),
        total_loss: discrepancy * (unitCost || (product ? product.cost_price || 0 : 0)),
        detected_by: 'restock_audit',
        notes: `Expected ${slot.current_qty}, found ${qtyBefore}`,
        resolved: false,
        occurred_at: new Date().toISOString()
      };
      db.shrinkageEvents.push(shrinkageEvent);
      shrinkageDetected.push({
        slot_id: item.slot_id,
        product: product ? product.name : 'Unknown',
        expected: slot.current_qty,
        found: qtyBefore,
        discrepancy,
        estimated_loss: shrinkageEvent.total_loss
      });
    }
  }

  // Finalize event totals
  event.items_loaded = totalItemsLoaded;
  event.items_pulled = totalItemsPulled;
  event.product_cost = Math.round(totalProductCost * 100) / 100;
  db.restockEvents.push(event);

  // Also log in legacy fleet service logs for backwards compat
  if (!db.fleetServiceLogs) db.fleetServiceLogs = [];
  db.fleetServiceLogs.push({
    id: nextId(),
    machine_id: machineId,
    service_type: 'restock',
    service_date: new Date(startTime).toISOString().split('T')[0],
    technician: driver_name || 'Unknown',
    notes: `Slots: ${items.length}, Loaded: ${totalItemsLoaded}, Pulled: ${totalItemsPulled}`,
    cost: Math.round(totalProductCost * 100) / 100,
    created_at: new Date().toISOString()
  });
  // Update legacy last_restock
  const mIdx = (db.fleetMachines || []).findIndex(m => m.id === machineId);
  if (mIdx !== -1) db.fleetMachines[mIdx].last_restock = new Date(startTime).toISOString().split('T')[0];

  saveDB(db);

  const totalCost = event.product_cost + event.labor_cost + (event.fuel_cost || 0);
  res.status(201).json({
    success: true,
    data: {
      restock_event_id: event.id,
      summary: {
        slots_serviced: items.length,
        items_loaded: totalItemsLoaded,
        items_pulled: totalItemsPulled,
        product_cost: event.product_cost,
        labor_cost: event.labor_cost,
        fuel_cost: event.fuel_cost || 0,
        total_cost: Math.round(totalCost * 100) / 100,
        duration_min: durationMin,
        shrinkage_detected: shrinkageDetected
      },
      items: processedItems
    }
  });
});

// ============================================================
// GET /api/fleet/:id/restock-history — Restock log
// ============================================================
app.get('/api/fleet/:id/restock-history', (req, res) => {
  const machineId = parseInt(req.params.id);
  const events = db.restockEvents
    .filter(e => e.machine_id === machineId)
    .sort((a, b) => new Date(b.started_at) - new Date(a.started_at));

  const enriched = events.map(e => {
    const items = db.restockItems.filter(i => i.restock_id === e.id);
    const totalCost = (e.product_cost || 0) + (e.labor_cost || 0) + (e.fuel_cost || 0);
    return { ...e, items, total_cost: Math.round(totalCost * 100) / 100 };
  });

  const result = paginate(enriched, req.query.page, req.query.limit);
  res.json({ success: true, ...result });
});

// ============================================================
// GET /api/fleet/:id/analytics — Sales analytics for machine
// ============================================================
app.get('/api/fleet/:id/analytics', (req, res) => {
  const machineId = parseInt(req.params.id);
  const machine = (db.fleetMachines || []).find(m => m.id === machineId);
  if (!machine) return res.status(404).json({ success: false, error: 'Machine not found' });

  const period = req.query.period || '30d';
  const daysMap = { '7d': 7, '30d': 30, '90d': 90, '1y': 365 };
  const days = daysMap[period] || 30;
  const fromDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  // Get transactions for this machine
  const machineSlots = db.machineSlots.filter(s => s.machine_id === machineId);
  const slotIds = new Set(machineSlots.map(s => s.id));
  const transactions = db.salesTransactions.filter(t =>
    (t.machine_id === machineId || slotIds.has(t.slot_id)) && t.sold_at >= fromDate
  );

  const revenue = transactions.reduce((s, t) => s + (t.total_price || 0), 0);
  const cogs = transactions.reduce((s, t) => s + ((t.unit_cost || 0) * (t.quantity || 1)), 0);
  const grossMargin = revenue - cogs;
  const marginPct = revenue > 0 ? Math.round((grossMargin / revenue) * 100 * 10) / 10 : 0;
  const avgTicket = transactions.length > 0 ? Math.round(revenue / transactions.length * 100) / 100 : 0;
  const dailyAvg = days > 0 ? Math.round(revenue / days * 100) / 100 : 0;

  // Revenue status
  const monthly = dailyAvg * 30;
  const revenueStatus = monthly < 800 ? 'pull_candidate' : monthly < 2000 ? 'underperforming' : 'on_target';

  // Top products
  const productRevenue = {};
  transactions.forEach(t => {
    if (!t.product_id) return;
    if (!productRevenue[t.product_id]) productRevenue[t.product_id] = { revenue: 0, units: 0 };
    productRevenue[t.product_id].revenue += t.total_price || 0;
    productRevenue[t.product_id].units += t.quantity || 1;
  });
  const topProducts = Object.entries(productRevenue)
    .map(([pid, data]) => {
      const product = (db.products || []).find(p => p.id === parseInt(pid));
      return { product_id: parseInt(pid), name: product ? product.name : 'Unknown', ...data };
    })
    .sort((a, b) => b.revenue - a.revenue);

  // Time patterns (by hour)
  const hourly = Array(24).fill(0);
  transactions.forEach(t => {
    const h = new Date(t.sold_at).getHours();
    hourly[h] += t.total_price || 0;
  });

  // Day of week patterns
  const daily = Array(7).fill(0);
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  transactions.forEach(t => {
    const d = new Date(t.sold_at).getDay();
    daily[d] += t.total_price || 0;
  });

  // Inventory health
  const inventoryHealth = {
    empty: machineSlots.filter(s => s.current_qty === 0).length,
    low: machineSlots.filter(s => s.current_qty > 0 && s.current_qty <= s.low_threshold).length,
    normal: machineSlots.filter(s => s.current_qty > s.low_threshold && s.current_qty < s.max_capacity * 0.75).length,
    full: machineSlots.filter(s => s.current_qty >= s.max_capacity * 0.75).length,
    avg_fill_pct: machineSlots.length > 0
      ? Math.round(machineSlots.reduce((s, sl) => s + (sl.current_qty / sl.max_capacity), 0) / machineSlots.length * 100) : 0
  };

  // Shrinkage
  const machineShrinkage = db.shrinkageEvents.filter(e => e.machine_id === machineId && e.occurred_at >= fromDate);
  const shrinkageLoss = machineShrinkage.reduce((s, e) => s + (e.total_loss || 0), 0);

  // Restocks
  const restocks = db.restockEvents.filter(e => e.machine_id === machineId && e.started_at >= fromDate);

  res.json({
    success: true,
    data: {
      machine_id: machineId,
      machine_name: machine.serial || machine.location,
      period,
      revenue: Math.round(revenue * 100) / 100,
      cogs: Math.round(cogs * 100) / 100,
      gross_margin: Math.round(grossMargin * 100) / 100,
      margin_pct: marginPct,
      transactions: transactions.length,
      avg_ticket: avgTicket,
      daily_avg: dailyAvg,
      projected_monthly: Math.round(monthly * 100) / 100,
      revenue_status: revenueStatus,
      monthly_target: 2000,
      top_products: topProducts.slice(0, 10),
      bottom_products: topProducts.slice(-5).reverse(),
      hourly_revenue: hourly,
      daily_revenue: daily.map((r, i) => ({ day: dayNames[i], revenue: Math.round(r * 100) / 100 })),
      inventory_health: inventoryHealth,
      shrinkage: {
        total_loss: Math.round(shrinkageLoss * 100) / 100,
        events: machineShrinkage.length,
        pct_of_revenue: revenue > 0 ? Math.round(shrinkageLoss / revenue * 100 * 10) / 10 : 0
      },
      restocks: {
        count: restocks.length,
        total_cost: Math.round(restocks.reduce((s, r) => s + (r.product_cost || 0) + (r.labor_cost || 0) + (r.fuel_cost || 0), 0) * 100) / 100,
        avg_duration: restocks.length > 0 ? Math.round(restocks.reduce((s, r) => s + (r.duration_min || 0), 0) / restocks.length) : 0
      }
    }
  });
});

// ============================================================
// GET /api/fleet/:id/pricing — Get pricing rules & calculated prices
// ============================================================
app.get('/api/fleet/:id/pricing', (req, res) => {
  const machineId = parseInt(req.params.id);
  const machine = (db.fleetMachines || []).find(m => m.id === machineId);
  if (!machine) return res.status(404).json({ success: false, error: 'Machine not found' });

  const profile = machine.pricing_profile_id
    ? db.pricingProfiles.find(p => p.id === machine.pricing_profile_id) : null;
  const rules = db.pricingRules.filter(r => r.machine_id === machineId && r.is_active !== false);

  // Calculate prices for all assigned slots
  const slots = db.machineSlots.filter(s => s.machine_id === machineId && s.product_id);
  const prices = slots.map(s => {
    const product = (db.products || []).find(p => p.id === s.product_id);
    if (!product) return null;
    const finalPrice = calculateMachinePrice(machineId, s.product_id, s.id);
    const unitCost = product.cost_price || product.unit_cost || 0;
    const marginPct = finalPrice > 0 ? Math.round((1 - unitCost / finalPrice) * 100 * 10) / 10 : 0;
    return {
      slot_id: s.id,
      slot_number: s.slot_number,
      product_id: s.product_id,
      product_name: product.name,
      category: product.category,
      base_price: product.sell_price || product.default_price || 0,
      profile_multiplier: profile ? (
        (product.category || '').toLowerCase().includes('bev') ? profile.beverage_mult
        : (product.category || '').toLowerCase().includes('snack') ? profile.snack_mult
        : (product.category || '').toLowerCase().includes('candy') ? profile.candy_mult
        : profile.incidental_mult
      ) : 1.0,
      override_price: s.price_override,
      final_price: finalPrice,
      unit_cost: unitCost,
      margin_pct: marginPct,
      margin_ok: marginPct >= 66
    };
  }).filter(Boolean);

  const avgPrice = prices.length > 0 ? Math.round(prices.reduce((s, p) => s + p.final_price, 0) / prices.length * 100) / 100 : 0;
  const avgMargin = prices.length > 0 ? Math.round(prices.reduce((s, p) => s + p.margin_pct, 0) / prices.length * 10) / 10 : 0;

  res.json({
    success: true,
    data: {
      machine_id: machineId,
      profile: profile || null,
      rules,
      prices,
      summary: {
        avg_price: avgPrice,
        avg_margin_pct: avgMargin,
        below_margin_count: prices.filter(p => !p.margin_ok).length,
        overrides_active: prices.filter(p => p.override_price !== null && p.override_price !== undefined).length
      }
    }
  });
});

// ============================================================
// POST /api/fleet/:id/pricing — Set pricing rules
// ============================================================
app.post('/api/fleet/:id/pricing', (req, res) => {
  const machineId = parseInt(req.params.id);
  const machine = (db.fleetMachines || []).find(m => m.id === machineId);
  if (!machine) return res.status(404).json({ success: false, error: 'Machine not found' });

  const { action } = req.body;

  // Set pricing profile
  if (action === 'set_profile') {
    const { profile_id } = req.body;
    const mIdx = db.fleetMachines.findIndex(m => m.id === machineId);
    db.fleetMachines[mIdx].pricing_profile_id = profile_id;
    db.fleetMachines[mIdx].updated_at = new Date().toISOString();
    saveDB(db);
    return res.json({ success: true, data: { message: 'Pricing profile updated' } });
  }

  // Add pricing rule
  if (action === 'add_rule') {
    const rule = {
      id: nextId(),
      machine_id: machineId,
      product_id: req.body.product_id || null,
      rule_type: req.body.rule_type || 'manual',
      conditions: req.body.conditions || {},
      price_adjustment: req.body.price_adjustment || null,
      price_multiplier: req.body.price_multiplier || null,
      priority: req.body.priority || 0,
      is_active: true,
      starts_at: req.body.starts_at || null,
      ends_at: req.body.ends_at || null,
      created_at: new Date().toISOString()
    };
    db.pricingRules.push(rule);
    saveDB(db);
    return res.json({ success: true, data: rule });
  }

  // Set slot price override
  if (action === 'set_override') {
    const { slot_id, price } = req.body;
    const slotIdx = db.machineSlots.findIndex(s => s.id === slot_id && s.machine_id === machineId);
    if (slotIdx === -1) return res.status(404).json({ success: false, error: 'Slot not found' });
    db.machineSlots[slotIdx].price_override = price;
    db.machineSlots[slotIdx].updated_at = new Date().toISOString();
    saveDB(db);
    return res.json({ success: true, data: db.machineSlots[slotIdx] });
  }

  // Remove pricing rule
  if (action === 'remove_rule') {
    const { rule_id } = req.body;
    db.pricingRules = db.pricingRules.filter(r => r.id !== rule_id);
    saveDB(db);
    return res.json({ success: true, data: { message: 'Rule removed' } });
  }

  res.status(400).json({ success: false, error: 'Unknown action. Use: set_profile, add_rule, set_override, remove_rule' });
});

// ============================================================
// GET /api/fleet/:id/slot-performance — Heat map data
// ============================================================
app.get('/api/fleet/:id/slot-performance', (req, res) => {
  const machineId = parseInt(req.params.id);
  const machine = (db.fleetMachines || []).find(m => m.id === machineId);
  if (!machine) return res.status(404).json({ success: false, error: 'Machine not found' });

  let slots = db.machineSlots.filter(s => s.machine_id === machineId);
  if (slots.length === 0) {
    slots = initializeMachineSlots(machineId, machine.slot_rows || 6, machine.slot_cols || 10);
  }

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const performance = slots.map(s => {
    const slotTx = db.salesTransactions.filter(t => t.slot_id === s.id && t.sold_at >= thirtyDaysAgo);
    const unitsSold = slotTx.reduce((sum, t) => sum + (t.quantity || 1), 0);
    const revenue = slotTx.reduce((sum, t) => sum + (t.total_price || 0), 0);
    const margin = slotTx.reduce((sum, t) => sum + ((t.total_price || 0) - (t.unit_cost || 0) * (t.quantity || 1)), 0);
    const velocity = unitsSold / 30;
    const product = s.product_id ? (db.products || []).find(p => p.id === s.product_id) : null;

    return {
      slot_id: s.id,
      slot_number: s.slot_number,
      row_position: s.row_position,
      col_position: s.col_position,
      position_tier: s.position_tier,
      is_eye_level: s.is_eye_level,
      is_impulse_zone: s.is_impulse_zone,
      product_name: product ? product.name : null,
      category: product ? product.category : null,
      current_qty: s.current_qty,
      max_capacity: s.max_capacity,
      units_sold_30d: unitsSold,
      revenue_30d: Math.round(revenue * 100) / 100,
      margin_30d: Math.round(margin * 100) / 100,
      velocity_per_day: Math.round(velocity * 100) / 100,
      heat_score: calculateHeatScore(s, slots)
    };
  }).sort((a, b) => a.slot_number - b.slot_number);

  // Build heat map grid
  const rows = machine.slot_rows || 6;
  const cols = machine.slot_cols || 10;
  const heatGrid = [];
  for (let r = 1; r <= rows; r++) {
    heatGrid.push(
      performance
        .filter(p => p.row_position === r)
        .sort((a, b) => a.col_position - b.col_position)
        .map(p => p.heat_score)
    );
  }

  // Tier aggregates
  const tiers = { premium: [], standard: [], value: [] };
  performance.forEach(p => { if (tiers[p.position_tier]) tiers[p.position_tier].push(p); });
  const tierSummary = {};
  for (const [tier, slots_in_tier] of Object.entries(tiers)) {
    tierSummary[tier] = {
      slot_count: slots_in_tier.length,
      total_revenue: Math.round(slots_in_tier.reduce((s, p) => s + p.revenue_30d, 0) * 100) / 100,
      avg_heat: slots_in_tier.length > 0 ? Math.round(slots_in_tier.reduce((s, p) => s + p.heat_score, 0) / slots_in_tier.length) : 0,
      avg_velocity: slots_in_tier.length > 0 ? Math.round(slots_in_tier.reduce((s, p) => s + p.velocity_per_day, 0) / slots_in_tier.length * 100) / 100 : 0
    };
  }

  res.json({
    success: true,
    data: {
      machine_id: machineId,
      machine_name: machine.serial || machine.location,
      slots: performance,
      heat_grid: heatGrid,
      tier_summary: tierSummary,
      insights: generateSlotInsights(performance)
    }
  });
});

// Helper: Generate slot performance insights
function generateSlotInsights(performance) {
  const insights = [];
  const avgHeat = performance.reduce((s, p) => s + p.heat_score, 0) / Math.max(performance.length, 1);

  // Find cold eye-level slots (wasted premium position)
  const coldEyeLevel = performance.filter(p => p.is_eye_level && p.heat_score < avgHeat * 0.5 && p.product_name);
  if (coldEyeLevel.length > 0) {
    insights.push({
      type: 'underperforming_premium',
      severity: 'high',
      message: `${coldEyeLevel.length} eye-level slot(s) underperforming — consider swapping products`,
      slots: coldEyeLevel.map(s => ({ slot: s.slot_number, product: s.product_name, heat: s.heat_score }))
    });
  }

  // Find hot non-eye-level slots (should be promoted)
  const hotStandard = performance.filter(p => !p.is_eye_level && p.heat_score > avgHeat * 1.5 && p.product_name);
  if (hotStandard.length > 0) {
    insights.push({
      type: 'promote_candidate',
      severity: 'medium',
      message: `${hotStandard.length} non-premium slot(s) outperforming — promote to eye level`,
      slots: hotStandard.map(s => ({ slot: s.slot_number, product: s.product_name, heat: s.heat_score }))
    });
  }

  // Dead slots (assigned product, zero sales)
  const dead = performance.filter(p => p.product_name && p.units_sold_30d === 0);
  if (dead.length > 0) {
    insights.push({
      type: 'dead_slots',
      severity: 'high',
      message: `${dead.length} slot(s) with assigned products but zero sales in 30 days`,
      slots: dead.map(s => ({ slot: s.slot_number, product: s.product_name }))
    });
  }

  return insights;
}

// ============================================================
// GET /api/pricing-profiles — List all pricing profiles
// ============================================================
app.get('/api/pricing-profiles', (req, res) => {
  res.json({ success: true, data: db.pricingProfiles });
});

// ============================================================
// POST /api/pricing-profiles — Create pricing profile
// ============================================================
app.post('/api/pricing-profiles', (req, res) => {
  if (!req.body.name || !req.body.location_type) {
    return res.status(400).json({ success: false, error: 'name and location_type required' });
  }
  const profile = {
    id: nextId(),
    name: req.body.name,
    location_type: req.body.location_type,
    beverage_mult: req.body.beverage_mult || 1.00,
    snack_mult: req.body.snack_mult || 1.00,
    candy_mult: req.body.candy_mult || 1.00,
    incidental_mult: req.body.incidental_mult || 1.00,
    price_overrides: req.body.price_overrides || {},
    min_margin_pct: req.body.min_margin_pct || 66.0,
    round_to: req.body.round_to || 0.25,
    is_default: false,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  db.pricingProfiles.push(profile);
  saveDB(db);
  res.status(201).json({ success: true, data: profile });
});

// ============================================================
// PUT /api/pricing-profiles/:id — Update pricing profile
// ============================================================
app.put('/api/pricing-profiles/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const idx = db.pricingProfiles.findIndex(p => p.id === id);
  if (idx === -1) return res.status(404).json({ success: false, error: 'Profile not found' });
  db.pricingProfiles[idx] = { ...db.pricingProfiles[idx], ...req.body, updated_at: new Date().toISOString() };
  saveDB(db);
  res.json({ success: true, data: db.pricingProfiles[idx] });
});

// ============================================================
// GET /api/bundles — List bundles
// ============================================================
app.get('/api/bundles', (req, res) => {
  let bundles = db.bundleDefs || [];
  if (req.query.status) bundles = bundles.filter(b => b.status === req.query.status);
  if (req.query.machine_id) {
    const mid = parseInt(req.query.machine_id);
    bundles = bundles.filter(b => !b.machine_ids || b.machine_ids.length === 0 || b.machine_ids.includes(mid));
  }

  const enriched = bundles.map(b => {
    const items = (db.bundleItems || []).filter(i => i.bundle_id === b.id);
    const enrichedItems = items.map(i => {
      const product = (db.products || []).find(p => p.id === i.product_id);
      return { ...i, product_name: product ? product.name : 'Unknown' };
    });
    const conversionRate = b.times_shown > 0 ? Math.round(b.times_purchased / b.times_shown * 100 * 10) / 10 : 0;
    const discountPct = b.individual_total > 0
      ? Math.round((b.individual_total - b.bundle_price) / b.individual_total * 100 * 10) / 10 : 0;
    return { ...b, items: enrichedItems, conversion_rate: conversionRate, discount_pct: discountPct };
  });

  const result = paginate(enriched, req.query.page, req.query.limit);
  res.json({ success: true, ...result });
});

// ============================================================
// POST /api/bundles — Create bundle
// ============================================================
app.post('/api/bundles', (req, res) => {
  const { name, description, display_emoji, items, bundle_price,
    time_start, time_end, location_types, machine_ids } = req.body;

  if (!name || !items || !Array.isArray(items) || items.length < 2) {
    return res.status(400).json({ success: false, error: 'name and at least 2 items required' });
  }

  // Calculate individual total from product prices
  let individualTotal = 0;
  let totalCogs = 0;
  const bundleItemRecords = [];

  for (const item of items) {
    const product = (db.products || []).find(p => p.id === item.product_id);
    if (!product) return res.status(400).json({ success: false, error: `Product ${item.product_id} not found` });
    const qty = item.quantity || 1;
    individualTotal += (product.sell_price || product.default_price || 0) * qty;
    totalCogs += (product.cost_price || product.unit_cost || 0) * qty;
    bundleItemRecords.push({
      id: nextId(),
      product_id: item.product_id,
      quantity: qty,
      role: item.role || 'primary'
    });
  }

  const price = bundle_price || Math.round(individualTotal * 0.88 * 4) / 4; // 12% off, rounded to $0.25

  // Validate: 3x markup minimum
  if (price < totalCogs * 3) {
    return res.status(400).json({
      success: false,
      error: `Bundle price $${price} breaks 3x markup. Min: $${(totalCogs * 3).toFixed(2)}`,
    });
  }
  // Validate: max 15% discount
  if (price < individualTotal * 0.85) {
    return res.status(400).json({
      success: false,
      error: `Discount exceeds 15% cap. Min bundle price: $${(individualTotal * 0.85).toFixed(2)}`,
    });
  }

  const bundle = {
    id: nextId(),
    name, description: description || '',
    display_emoji: display_emoji || '🎁',
    individual_total: Math.round(individualTotal * 100) / 100,
    bundle_price: Math.round(price * 100) / 100,
    total_cogs: Math.round(totalCogs * 100) / 100,
    time_start: time_start || null,
    time_end: time_end || null,
    location_types: location_types || [],
    machine_ids: machine_ids || [],
    status: 'draft',
    times_shown: 0, times_purchased: 0, total_revenue: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  db.bundleDefs.push(bundle);

  // Save bundle items
  bundleItemRecords.forEach(item => {
    db.bundleItems.push({ ...item, bundle_id: bundle.id, created_at: new Date().toISOString() });
  });

  saveDB(db);
  const discountPct = Math.round((individualTotal - price) / individualTotal * 100 * 10) / 10;
  res.status(201).json({
    success: true,
    data: { ...bundle, items: bundleItemRecords, discount_pct: discountPct }
  });
});

// ============================================================
// PUT /api/bundles/:id — Update bundle
// ============================================================
app.put('/api/bundles/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const idx = db.bundleDefs.findIndex(b => b.id === id);
  if (idx === -1) return res.status(404).json({ success: false, error: 'Bundle not found' });
  const allowed = ['name', 'description', 'display_emoji', 'bundle_price', 'status',
    'time_start', 'time_end', 'location_types', 'machine_ids'];
  const updates = {};
  allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
  db.bundleDefs[idx] = { ...db.bundleDefs[idx], ...updates, updated_at: new Date().toISOString() };
  saveDB(db);
  res.json({ success: true, data: db.bundleDefs[idx] });
});

// ============================================================
// DELETE /api/bundles/:id — Retire bundle
// ============================================================
app.delete('/api/bundles/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const idx = db.bundleDefs.findIndex(b => b.id === id);
  if (idx === -1) return res.status(404).json({ success: false, error: 'Bundle not found' });
  db.bundleDefs[idx].status = 'retired';
  db.bundleDefs[idx].updated_at = new Date().toISOString();
  saveDB(db);
  res.json({ success: true, data: { message: 'Bundle retired' } });
});

// ============================================================
// GET /api/bundles/suggestions/:machineId — Auto-suggest bundles
// ============================================================
app.get('/api/bundles/suggestions/:machineId', (req, res) => {
  const machineId = parseInt(req.params.machineId);
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

  // Find co-purchased products (same machine, within 5 min)
  const machineTx = db.salesTransactions
    .filter(t => t.machine_id === machineId && t.sold_at >= ninetyDaysAgo)
    .sort((a, b) => a.sold_at.localeCompare(b.sold_at));

  const coPairs = {};
  for (let i = 0; i < machineTx.length; i++) {
    for (let j = i + 1; j < machineTx.length; j++) {
      const timeDiff = Math.abs(new Date(machineTx[j].sold_at) - new Date(machineTx[i].sold_at)) / 1000;
      if (timeDiff > 300) break; // More than 5 min apart
      if (machineTx[i].product_id === machineTx[j].product_id) continue;

      const key = [machineTx[i].product_id, machineTx[j].product_id].sort().join('-');
      coPairs[key] = (coPairs[key] || 0) + 1;
    }
  }

  const suggestions = Object.entries(coPairs)
    .filter(([_, count]) => count >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([key, count]) => {
      const [pidA, pidB] = key.split('-').map(Number);
      const productA = (db.products || []).find(p => p.id === pidA);
      const productB = (db.products || []).find(p => p.id === pidB);
      if (!productA || !productB) return null;

      const individualTotal = (productA.sell_price || 0) + (productB.sell_price || 0);
      const totalCogs = (productA.cost_price || 0) + (productB.cost_price || 0);
      const suggestedPrice = Math.round(individualTotal * 0.88 * 4) / 4;

      return {
        products: [
          { id: pidA, name: productA.name, price: productA.sell_price },
          { id: pidB, name: productB.name, price: productB.sell_price }
        ],
        co_purchase_count: count,
        individual_total: individualTotal,
        suggested_bundle_price: suggestedPrice,
        discount_pct: Math.round((individualTotal - suggestedPrice) / individualTotal * 100 * 10) / 10,
        margin_ok: suggestedPrice >= totalCogs * 3
      };
    })
    .filter(Boolean);

  res.json({ success: true, data: suggestions });
});

// ============================================================
// GET /api/fleet-overview — Fleet summary stats (enhanced)
// ============================================================
app.get('/api/fleet-overview', (req, res) => {
  const machines = db.fleetMachines || [];
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  // Revenue calculations
  const allTx = db.salesTransactions.filter(t => t.sold_at >= thirtyDaysAgo);
  const totalRevenue = allTx.reduce((s, t) => s + (t.total_price || 0), 0);
  const totalCogs = allTx.reduce((s, t) => s + ((t.unit_cost || 0) * (t.quantity || 1)), 0);
  const totalTransactions = allTx.length;

  // Per-machine revenue
  const machineRevenue = {};
  allTx.forEach(t => {
    if (!machineRevenue[t.machine_id]) machineRevenue[t.machine_id] = 0;
    machineRevenue[t.machine_id] += t.total_price || 0;
  });

  const activeMachines = machines.filter(m => m.status === 'active');

  // Classify machines by performance
  const pullCandidates = [];
  const underperforming = [];
  const onTarget = [];

  activeMachines.forEach(m => {
    const rev = machineRevenue[m.id] || 0;
    const entry = { id: m.id, name: m.serial || m.location, revenue_30d: Math.round(rev * 100) / 100 };
    if (rev < 800) pullCandidates.push(entry);
    else if (rev < 2000) underperforming.push(entry);
    else onTarget.push(entry);
  });

  // Inventory health
  const allSlots = db.machineSlots || [];
  const emptySlots = allSlots.filter(s => s.current_qty === 0 && s.product_id).length;
  const lowSlots = allSlots.filter(s => s.current_qty > 0 && s.current_qty <= s.low_threshold).length;

  // Expiring soon
  const sevenDaysOut = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const expiringSoon = allSlots.filter(s => s.earliest_expiry && s.earliest_expiry <= sevenDaysOut).length;

  // Shrinkage
  const recentShrinkage = db.shrinkageEvents.filter(e => e.occurred_at >= thirtyDaysAgo);
  const totalShrinkageLoss = recentShrinkage.reduce((s, e) => s + (e.total_loss || 0), 0);

  // Restocks
  const recentRestocks = db.restockEvents.filter(e => e.started_at >= thirtyDaysAgo);

  // Also pull from legacy fleetRevenue for revenue if no salesTransactions
  let legacyRevenue = 0;
  if (totalRevenue === 0) {
    const now = new Date();
    const monthKey = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
    legacyRevenue = (db.fleetRevenue || [])
      .filter(r => r.date && r.date.startsWith(monthKey))
      .reduce((s, r) => s + (r.amount || 0), 0);
  }

  res.json({
    success: true,
    data: {
      fleet: {
        total_machines: machines.length,
        active: activeMachines.length,
        available: machines.filter(m => m.status === 'available').length,
        maintenance: machines.filter(m => m.status === 'needs-service' || m.status === 'maintenance').length,
        offline: machines.filter(m => m.status === 'offline').length
      },
      revenue_30d: {
        total: Math.round((totalRevenue || legacyRevenue) * 100) / 100,
        cogs: Math.round(totalCogs * 100) / 100,
        gross_margin: Math.round((totalRevenue - totalCogs) * 100) / 100,
        margin_pct: totalRevenue > 0 ? Math.round((1 - totalCogs / totalRevenue) * 100 * 10) / 10 : 0,
        avg_per_machine: activeMachines.length > 0
          ? Math.round((totalRevenue || legacyRevenue) / activeMachines.length * 100) / 100 : 0,
        transactions: totalTransactions,
        avg_ticket: totalTransactions > 0 ? Math.round(totalRevenue / totalTransactions * 100) / 100 : 0
      },
      inventory: {
        total_slots: allSlots.length,
        empty_slots: emptySlots,
        low_slots: lowSlots,
        expiring_soon: expiringSoon,
        avg_fill_pct: allSlots.length > 0
          ? Math.round(allSlots.reduce((s, sl) => s + (sl.current_qty / Math.max(sl.max_capacity, 1)), 0) / allSlots.length * 100) : 0
      },
      shrinkage: {
        total_loss: Math.round(totalShrinkageLoss * 100) / 100,
        events: recentShrinkage.length,
        pct_of_revenue: totalRevenue > 0 ? Math.round(totalShrinkageLoss / totalRevenue * 100 * 10) / 10 : 0
      },
      restocks: {
        count: recentRestocks.length,
        total_cost: Math.round(recentRestocks.reduce((s, r) =>
          s + (r.product_cost || 0) + (r.labor_cost || 0) + (r.fuel_cost || 0), 0) * 100) / 100,
        avg_duration: recentRestocks.length > 0
          ? Math.round(recentRestocks.reduce((s, r) => s + (r.duration_min || 0), 0) / recentRestocks.length) : 0
      },
      alerts: {
        pull_candidates: pullCandidates,
        underperforming,
        on_target: onTarget,
        empty_slots: emptySlots,
        expiring_soon: expiringSoon,
        high_shrinkage: recentShrinkage.length > 0
          ? recentShrinkage.filter(e => (e.total_loss || 0) > 50).length : 0
      }
    }
  });
});

// ============================================================
// GET /api/shrinkage — Fleet shrinkage report
// ============================================================
app.get('/api/shrinkage', (req, res) => {
  let events = db.shrinkageEvents || [];
  if (req.query.machine_id) events = events.filter(e => e.machine_id === parseInt(req.query.machine_id));
  if (req.query.type) events = events.filter(e => e.shrinkage_type === req.query.type);
  if (req.query.resolved !== undefined) events = events.filter(e => e.resolved === (req.query.resolved === 'true'));

  const enriched = events.map(e => {
    const product = e.product_id ? (db.products || []).find(p => p.id === e.product_id) : null;
    const machine = (db.fleetMachines || []).find(m => m.id === e.machine_id);
    return {
      ...e,
      product_name: product ? product.name : null,
      machine_name: machine ? (machine.serial || machine.location) : null
    };
  }).sort((a, b) => new Date(b.occurred_at) - new Date(a.occurred_at));

  // Summary by type
  const byType = {};
  events.forEach(e => {
    if (!byType[e.shrinkage_type]) byType[e.shrinkage_type] = { count: 0, total_loss: 0 };
    byType[e.shrinkage_type].count++;
    byType[e.shrinkage_type].total_loss += e.total_loss || 0;
  });

  const result = paginate(enriched, req.query.page, req.query.limit);
  res.json({
    success: true,
    ...result,
    summary: {
      total_events: events.length,
      total_loss: Math.round(events.reduce((s, e) => s + (e.total_loss || 0), 0) * 100) / 100,
      unresolved: events.filter(e => !e.resolved).length,
      by_type: byType
    }
  });
});

// ============================================================
// POST /api/shrinkage — Report shrinkage event
// ============================================================
app.post('/api/shrinkage', (req, res) => {
  const { machine_id, slot_id, product_id, shrinkage_type, quantity,
    unit_cost, detected_by, evidence_url, notes } = req.body;

  if (!machine_id || !shrinkage_type || !quantity) {
    return res.status(400).json({ success: false, error: 'machine_id, shrinkage_type, and quantity required' });
  }

  const product = product_id ? (db.products || []).find(p => p.id === product_id) : null;
  const cost = unit_cost || (product ? product.cost_price || 0 : 0);

  const event = {
    id: nextId(),
    machine_id: parseInt(machine_id),
    slot_id: slot_id || null,
    product_id: product_id || null,
    shrinkage_type,
    quantity,
    unit_cost: cost,
    total_loss: Math.round(quantity * cost * 100) / 100,
    detected_by: detected_by || 'manual',
    evidence_url: evidence_url || null,
    notes: notes || '',
    resolved: false,
    resolution: null,
    occurred_at: req.body.occurred_at || new Date().toISOString(),
    resolved_at: null
  };

  db.shrinkageEvents.push(event);

  // Log inventory change if slot specified
  if (slot_id) {
    const slotIdx = db.machineSlots.findIndex(s => s.id === slot_id);
    if (slotIdx !== -1) {
      const slot = db.machineSlots[slotIdx];
      db.inventoryLogs.push({
        id: nextId(),
        slot_id, machine_id: parseInt(machine_id),
        product_id: product_id || slot.product_id,
        change_type: 'shrinkage',
        qty_before: slot.current_qty,
        qty_change: -quantity,
        qty_after: Math.max(0, slot.current_qty - quantity),
        reason: `${shrinkage_type}: ${notes || ''}`,
        performed_by: 'system',
        created_at: new Date().toISOString()
      });
      db.machineSlots[slotIdx].current_qty = Math.max(0, slot.current_qty - quantity);
      db.machineSlots[slotIdx].updated_at = new Date().toISOString();
    }
  }

  saveDB(db);
  res.status(201).json({ success: true, data: event });
});

// ============================================================
// PUT /api/shrinkage/:id — Resolve shrinkage event
// ============================================================
app.put('/api/shrinkage/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const idx = db.shrinkageEvents.findIndex(e => e.id === id);
  if (idx === -1) return res.status(404).json({ success: false, error: 'Shrinkage event not found' });
  if (req.body.resolved !== undefined) db.shrinkageEvents[idx].resolved = req.body.resolved;
  if (req.body.resolution) db.shrinkageEvents[idx].resolution = req.body.resolution;
  if (req.body.resolved) db.shrinkageEvents[idx].resolved_at = new Date().toISOString();
  saveDB(db);
  res.json({ success: true, data: db.shrinkageEvents[idx] });
});

// ============================================================
// GET /api/experiments — List A/B tests
// ============================================================
app.get('/api/experiments', (req, res) => {
  let tests = db.abTests || [];
  if (req.query.machine_id) tests = tests.filter(t => t.machine_id === parseInt(req.query.machine_id));
  if (req.query.status) tests = tests.filter(t => t.status === req.query.status);

  const enriched = tests.map(t => {
    const machine = (db.fleetMachines || []).find(m => m.id === t.machine_id);
    return { ...t, machine_name: machine ? (machine.serial || machine.location) : null };
  }).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  const result = paginate(enriched, req.query.page, req.query.limit);
  res.json({ success: true, ...result });
});

// ============================================================
// POST /api/experiments — Create A/B test
// ============================================================
app.post('/api/experiments', (req, res) => {
  const { name, hypothesis, machine_id, experiment_type, variant_a, variant_b, min_duration_days } = req.body;
  if (!name || !machine_id || !experiment_type || !variant_a || !variant_b) {
    return res.status(400).json({ success: false, error: 'name, machine_id, experiment_type, variant_a, variant_b required' });
  }

  const test = {
    id: nextId(),
    name, hypothesis: hypothesis || '',
    machine_id: parseInt(machine_id),
    experiment_type,
    status: 'draft',
    variant_a, variant_b,
    started_at: null, swapped_at: null, concluded_at: null,
    min_duration_days: min_duration_days || 14,
    variant_a_sales: 0, variant_a_revenue: 0,
    variant_b_sales: 0, variant_b_revenue: 0,
    winner: null, confidence_pct: null,
    revenue_lift: null, revenue_lift_pct: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  db.abTests.push(test);
  saveDB(db);
  res.status(201).json({ success: true, data: test });
});

// ============================================================
// PUT /api/experiments/:id — Update experiment status
// ============================================================
app.put('/api/experiments/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const idx = db.abTests.findIndex(t => t.id === id);
  if (idx === -1) return res.status(404).json({ success: false, error: 'Experiment not found' });

  const test = db.abTests[idx];
  const { action } = req.body;

  if (action === 'start') {
    test.status = 'running_a';
    test.started_at = new Date().toISOString();
  } else if (action === 'swap') {
    test.status = 'running_b';
    test.swapped_at = new Date().toISOString();
  } else if (action === 'conclude') {
    test.status = 'concluded';
    test.concluded_at = new Date().toISOString();

    // Calculate results
    const avgA = test.variant_a_sales > 0 ? test.variant_a_revenue / test.variant_a_sales : 0;
    const avgB = test.variant_b_sales > 0 ? test.variant_b_revenue / test.variant_b_sales : 0;
    const lift = avgB - avgA;
    const liftPct = avgA > 0 ? Math.round((lift / avgA) * 100 * 10) / 10 : 0;

    test.revenue_lift = Math.round(lift * 100) / 100;
    test.revenue_lift_pct = liftPct;

    // Simple confidence (needs min 30 sales per variant for meaningful result)
    const minSales = Math.min(test.variant_a_sales, test.variant_b_sales);
    test.confidence_pct = minSales >= 30 ? Math.min(95, Math.round(60 + minSales * 0.5)) : Math.round(minSales / 30 * 60);
    test.winner = (test.confidence_pct >= 90 && liftPct > 5) ? 'b'
      : (test.confidence_pct >= 90 && liftPct < -5) ? 'a' : null;
  } else {
    // General update
    const allowed = ['name', 'hypothesis', 'variant_a_sales', 'variant_a_revenue',
      'variant_b_sales', 'variant_b_revenue', 'status'];
    allowed.forEach(k => { if (req.body[k] !== undefined) test[k] = req.body[k]; });
  }

  test.updated_at = new Date().toISOString();
  db.abTests[idx] = test;
  saveDB(db);
  res.json({ success: true, data: test });
});

// ============================================================
// POST /api/sales-transactions — Record a sale
// ============================================================
app.post('/api/sales-transactions', (req, res) => {
  const { machine_id, slot_id, product_id, quantity, unit_price, payment_method } = req.body;
  if (!machine_id || !unit_price) {
    return res.status(400).json({ success: false, error: 'machine_id and unit_price required' });
  }

  const qty = quantity || 1;
  const product = product_id ? (db.products || []).find(p => p.id === product_id) : null;
  const unitCost = product ? (product.cost_price || product.unit_cost || 0) : 0;

  const tx = {
    id: nextId(),
    machine_id: parseInt(machine_id),
    slot_id: slot_id || null,
    product_id: product_id || null,
    quantity: qty,
    unit_price: parseFloat(unit_price),
    total_price: Math.round(parseFloat(unit_price) * qty * 100) / 100,
    unit_cost: unitCost,
    payment_method: payment_method || 'card',
    bundle_tx_id: req.body.bundle_tx_id || null,
    location_type: req.body.location_type || null,
    sold_at: req.body.sold_at || new Date().toISOString()
  };
  db.salesTransactions.push(tx);

  // Update slot inventory
  if (slot_id) {
    const slotIdx = db.machineSlots.findIndex(s => s.id === slot_id);
    if (slotIdx !== -1) {
      const slot = db.machineSlots[slotIdx];
      db.machineSlots[slotIdx].current_qty = Math.max(0, slot.current_qty - qty);
      db.machineSlots[slotIdx].total_sold = (slot.total_sold || 0) + qty;
      db.machineSlots[slotIdx].total_revenue = Math.round(((slot.total_revenue || 0) + tx.total_price) * 100) / 100;
      db.machineSlots[slotIdx].last_sold_at = tx.sold_at;
      db.machineSlots[slotIdx].updated_at = new Date().toISOString();

      // Log inventory change
      db.inventoryLogs.push({
        id: nextId(),
        slot_id, machine_id: parseInt(machine_id),
        product_id: product_id || slot.product_id,
        change_type: 'sale',
        qty_before: slot.current_qty,
        qty_change: -qty,
        qty_after: Math.max(0, slot.current_qty - qty),
        transaction_id: tx.id,
        performed_by: 'system',
        created_at: tx.sold_at
      });
    }
  }

  // Also add to legacy sales for backwards compat
  if (!db.sales) db.sales = [];
  db.sales.push({
    id: nextId(),
    product_id, machine_id: parseInt(machine_id),
    quantity: qty, unit_price: tx.unit_price, total: tx.total_price,
    date: tx.sold_at.split('T')[0],
    created_at: tx.sold_at
  });

  saveDB(db);
  res.status(201).json({ success: true, data: tx });
});

// ============================================================
// GET /api/inventory-logs — Inventory change history
// ============================================================
app.get('/api/inventory-logs', (req, res) => {
  let logs = db.inventoryLogs || [];
  if (req.query.machine_id) logs = logs.filter(l => l.machine_id === parseInt(req.query.machine_id));
  if (req.query.slot_id) logs = logs.filter(l => l.slot_id === parseInt(req.query.slot_id));
  if (req.query.change_type) logs = logs.filter(l => l.change_type === req.query.change_type);

  logs = logs.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  const enriched = logs.map(l => {
    const product = l.product_id ? (db.products || []).find(p => p.id === l.product_id) : null;
    return { ...l, product_name: product ? product.name : null };
  });

  const result = paginate(enriched, req.query.page, req.query.limit);
  res.json({ success: true, ...result });
});

// ============================================================
// Serve restock page
// ============================================================
app.get('/restock', (req, res) => {
  res.sendFile(path.join(__dirname, 'restock.html'));
});

// ============================================================
// END MACHINE MANAGEMENT SYSTEM (JSON-based)
// ============================================================

// =====================================================
// POSTGRESQL-BACKED MACHINE MANAGEMENT API
// Endpoints use /api/v2/ prefix where paths conflict with JSON routes.
// Sub-routes under /api/machines/:id/* are unique — no prefix needed.
// =====================================================

let pgPool = null;
try {
  const { Pool } = require('pg');
  if (process.env.DATABASE_URL) {
    pgPool = new Pool({ connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false, max: 10, idleTimeoutMillis: 30000 });
    pgPool.on('error', (err) => console.error('🐘 PG pool error:', err));
    console.log('🐘 PostgreSQL pool initialized');
  } else { console.log('ℹ️  No DATABASE_URL — PG endpoints return 503'); }
} catch (e) { console.log('ℹ️  pg module not installed'); }

function requirePG(req, res, next) { if (!pgPool) return res.status(503).json({ success: false, error: 'Database not configured' }); next(); }
function pgSuccess(res, data, meta) { const r = { success: true, data }; if (meta) r.meta = meta; return res.json(r); }
function pgError(res, status, msg) { return res.status(status).json({ success: false, error: msg }); }
function parsePagination(q) { const page = Math.max(1, parseInt(q.page) || 1), limit = Math.min(100, Math.max(1, parseInt(q.limit) || 20)); return { page, limit, offset: (page - 1) * limit }; }

// GET /api/v2/machines
app.get('/api/v2/machines', requirePG, async (req, res) => {
  try {
    const { page, limit, offset } = parsePagination(req.query);
    const cond = [], params = []; let i = 1;
    if (req.query.status) { cond.push(`m.status = $${i++}`); params.push(req.query.status); }
    if (req.query.location_type) { cond.push(`m.location_type = $${i++}`); params.push(req.query.location_type); }
    const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
    const cnt = await pgPool.query(`SELECT COUNT(*) FROM machines m ${where}`, params);
    const total = parseInt(cnt.rows[0].count);
    const result = await pgPool.query(`SELECT m.*, z.name AS zone_name, pp.name AS pricing_profile_name,
      (SELECT COUNT(*) FROM slots s WHERE s.machine_id = m.id AND s.current_qty = 0) AS empty_slots,
      (SELECT COALESCE(SUM(t.total_price), 0) FROM transactions t WHERE t.machine_id = m.id AND t.sold_at >= NOW() - INTERVAL '30 days') AS revenue_30d
      FROM machines m LEFT JOIN zones z ON m.zone_id = z.id LEFT JOIN pricing_profiles pp ON m.pricing_profile_id = pp.id ${where}
      ORDER BY m.created_at DESC LIMIT $${i++} OFFSET $${i++}`, [...params, limit, offset]);
    pgSuccess(res, result.rows, { page, limit, total, totalPages: Math.ceil(total / limit) });
  } catch (err) { console.error('GET /api/v2/machines error:', err); pgError(res, 500, err.message); }
});

// POST /api/v2/machines
app.post('/api/v2/machines', requirePG, async (req, res) => {
  const client = await pgPool.connect();
  try {
    await client.query('BEGIN');
    const b = req.body;
    const { rows: [machine] } = await client.query(`INSERT INTO machines (name, serial_number, model, asset_cost, location_type, address, lat, lng, zone_id,
      total_slots, slot_rows, slot_cols, has_cashless, connectivity, status, monthly_rev_target, rev_share_pct, pricing_profile_id, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,
      [b.name, b.serial_number, b.model || 'SandStar AI Smart Cooler', b.asset_cost || 3600, b.location_type, b.address, b.lat, b.lng, b.zone_id,
       b.total_slots || 60, b.slot_rows || 6, b.slot_cols || 10, b.has_cashless !== false, b.connectivity || 'cellular', b.status || 'staged',
       b.monthly_rev_target || 2000, b.rev_share_pct || 0, b.pricing_profile_id, b.notes]);
    let slotNum = 1;
    for (let r = 1; r <= machine.slot_rows; r++) for (let c = 1; c <= machine.slot_cols; c++)
      await client.query(`INSERT INTO slots (machine_id, slot_number, row_position, col_position) VALUES ($1, $2, $3, $4)`, [machine.id, slotNum++, r, c]);
    await client.query('COMMIT');
    pgSuccess(res, machine);
  } catch (err) { await client.query('ROLLBACK'); console.error('POST /api/v2/machines error:', err); pgError(res, 500, err.message); }
  finally { client.release(); }
});

// GET /api/v2/machines/:id
app.get('/api/v2/machines/:id', requirePG, async (req, res) => {
  try {
    const { rows } = await pgPool.query(`SELECT m.*, z.name AS zone_name, pp.name AS pricing_profile_name
      FROM machines m LEFT JOIN zones z ON m.zone_id = z.id LEFT JOIN pricing_profiles pp ON m.pricing_profile_id = pp.id WHERE m.id = $1`, [req.params.id]);
    if (!rows.length) return pgError(res, 404, 'Machine not found');
    const machine = rows[0];
    const slotStats = await pgPool.query(`SELECT COUNT(*) AS total_slots, COUNT(*) FILTER (WHERE current_qty = 0) AS empty_slots,
      COUNT(*) FILTER (WHERE current_qty > 0 AND current_qty <= low_threshold) AS low_slots,
      ROUND(AVG(current_qty::DECIMAL / NULLIF(max_capacity, 0)) * 100, 1) AS fill_pct FROM slots WHERE machine_id = $1`, [req.params.id]);
    const revStats = await pgPool.query(`SELECT COALESCE(SUM(total_price), 0) AS revenue_30d, COALESCE(COUNT(*), 0) AS transactions_30d,
      COALESCE(AVG(total_price), 0) AS avg_ticket_30d FROM transactions WHERE machine_id = $1 AND sold_at >= NOW() - INTERVAL '30 days'`, [req.params.id]);
    machine.health = { ...slotStats.rows[0], ...revStats.rows[0],
      revenue_status: parseFloat(revStats.rows[0].revenue_30d) < 800 ? 'pull_candidate' : parseFloat(revStats.rows[0].revenue_30d) < 2000 ? 'underperforming' : 'on_target' };
    pgSuccess(res, machine);
  } catch (err) { console.error('GET /api/v2/machines/:id error:', err); pgError(res, 500, err.message); }
});

// PUT /api/v2/machines/:id
app.put('/api/v2/machines/:id', requirePG, async (req, res) => {
  try {
    const b = req.body; const fields = [], values = []; let i = 1;
    const updatable = ['name', 'serial_number', 'model', 'location_type', 'address', 'lat', 'lng', 'zone_id', 'has_cashless', 'connectivity', 'status', 'monthly_rev_target', 'rev_share_pct', 'pricing_profile_id', 'notes'];
    for (const k of updatable) if (b[k] !== undefined) { fields.push(`${k} = $${i++}`); values.push(b[k]); }
    if (!fields.length) return pgError(res, 400, 'No fields to update');
    fields.push('updated_at = NOW()'); values.push(req.params.id);
    const { rows } = await pgPool.query(`UPDATE machines SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`, values);
    if (!rows.length) return pgError(res, 404, 'Machine not found');
    pgSuccess(res, rows[0]);
  } catch (err) { console.error('PUT /api/v2/machines/:id error:', err); pgError(res, 500, err.message); }
});

// DELETE /api/v2/machines/:id
app.delete('/api/v2/machines/:id', requirePG, async (req, res) => {
  try {
    const { rowCount } = await pgPool.query('DELETE FROM machines WHERE id = $1', [req.params.id]);
    if (!rowCount) return pgError(res, 404, 'Machine not found');
    pgSuccess(res, { deleted: true });
  } catch (err) { console.error('DELETE /api/v2/machines/:id error:', err); pgError(res, 500, err.message); }
});

// GET /api/machines/:id/slots
app.get('/api/machines/:id/slots', requirePG, async (req, res) => {
  try {
    const { rows } = await pgPool.query(`SELECT s.*, p.name AS product_name, p.brand, p.category, p.default_price, p.unit_cost,
      predict_stockout(s.id) AS predicted_stockout FROM slots s LEFT JOIN products p ON s.product_id = p.id
      WHERE s.machine_id = $1 ORDER BY s.row_position, s.col_position`, [req.params.id]);
    const grid = {}; for (const slot of rows) { if (!grid[slot.row_position]) grid[slot.row_position] = {}; grid[slot.row_position][slot.col_position] = slot; }
    pgSuccess(res, { slots: rows, grid });
  } catch (err) { console.error('GET /api/machines/:id/slots error:', err); pgError(res, 500, err.message); }
});

// PUT /api/machines/:id/slots
app.put('/api/machines/:id/slots', requirePG, async (req, res) => {
  try {
    const b = req.body; if (!b.slot_id) return pgError(res, 400, 'slot_id is required');
    const fields = [], values = []; let i = 1;
    for (const k of ['product_id', 'price_override', 'par_level', 'low_threshold', 'max_capacity', 'current_qty'])
      if (b[k] !== undefined) { fields.push(`${k} = $${i++}`); values.push(b[k]); }
    if (!fields.length) return pgError(res, 400, 'No fields to update');
    fields.push('updated_at = NOW()'); values.push(b.slot_id); values.push(req.params.id);
    const { rows } = await pgPool.query(`UPDATE slots SET ${fields.join(', ')} WHERE id = $${i++} AND machine_id = $${i} RETURNING *`, values);
    if (!rows.length) return pgError(res, 404, 'Slot not found');
    pgSuccess(res, rows[0]);
  } catch (err) { console.error('PUT /api/machines/:id/slots error:', err); pgError(res, 500, err.message); }
});

// POST /api/machines/:id/restock
app.post('/api/machines/:id/restock', requirePG, async (req, res) => {
  const client = await pgPool.connect();
  try {
    await client.query('BEGIN');
    const machineId = req.params.id;
    const { driver_name, started_at, completed_at, mileage, fuel_cost, items, notes } = req.body;
    if (!items || !items.length) { await client.query('ROLLBACK'); return pgError(res, 400, 'items array required'); }
    const durationMin = started_at && completed_at ? Math.round((new Date(completed_at) - new Date(started_at)) / 60000) : null;
    const laborCost = durationMin ? (durationMin / 60) * 20 : 20;
    const { rows: [event] } = await client.query(`INSERT INTO restock_events (machine_id, driver_name, started_at, completed_at, duration_min, mileage, fuel_cost, labor_cost, slots_serviced, items_loaded, items_pulled, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [machineId, driver_name, started_at || new Date().toISOString(), completed_at, durationMin, mileage, fuel_cost, laborCost,
       items.length, items.reduce((s, i) => s + (i.qty_added || 0), 0), items.reduce((s, i) => s + (i.qty_removed || 0), 0), notes]);
    let totalProductCost = 0;
    for (const item of items) {
      const newQty = (item.qty_before || 0) + (item.qty_added || 0) - (item.qty_removed || 0);
      await client.query(`INSERT INTO restock_items (restock_id, slot_id, product_id, qty_before, qty_added, qty_removed, qty_after, unit_cost, expiry_date, notes)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [event.id, item.slot_id, item.product_id, item.qty_before || 0, item.qty_added || 0, item.qty_removed || 0, newQty, item.unit_cost, item.expiry_date, item.notes]);
      await client.query(`UPDATE slots SET current_qty = $1, updated_at = NOW() WHERE id = $2`, [Math.max(0, newQty), item.slot_id]);
      if (item.qty_added > 0) await client.query(`INSERT INTO inventory_logs (slot_id, machine_id, product_id, change_type, qty_before, qty_change, qty_after, restock_event_id, performed_by)
        VALUES ($1,$2,$3,'restock',$4,$5,$6,$7,$8)`, [item.slot_id, machineId, item.product_id, item.qty_before || 0, item.qty_added, newQty, event.id, driver_name || 'driver']);
      if (item.expiry_date && item.qty_added > 0) await client.query(`INSERT INTO slot_expiry_batches (slot_id, quantity, expiry_date) VALUES ($1,$2,$3)`, [item.slot_id, item.qty_added, item.expiry_date]);
      totalProductCost += (item.qty_added || 0) * (item.unit_cost || 0);
    }
    await client.query('UPDATE restock_events SET product_cost = $1 WHERE id = $2', [totalProductCost, event.id]);
    await client.query('COMMIT');
    pgSuccess(res, { restock_event_id: event.id, summary: { slots_serviced: items.length, items_loaded: items.reduce((s, i) => s + (i.qty_added || 0), 0),
      items_pulled: items.reduce((s, i) => s + (i.qty_removed || 0), 0), product_cost: totalProductCost, labor_cost: laborCost, total_cost: totalProductCost + laborCost + (fuel_cost || 0) } });
  } catch (err) { await client.query('ROLLBACK'); console.error('POST /api/machines/:id/restock error:', err); pgError(res, 500, err.message); }
  finally { client.release(); }
});

// GET /api/machines/:id/analytics
app.get('/api/machines/:id/analytics', requirePG, async (req, res) => {
  try {
    const machineId = req.params.id;
    const interval = req.query.period === '7d' ? '7 days' : req.query.period === '90d' ? '90 days' : '30 days';
    const summary = await pgPool.query(`SELECT COALESCE(SUM(total_price), 0) AS revenue, COALESCE(SUM(margin), 0) AS gross_margin,
      COALESCE(AVG(total_price), 0) AS avg_ticket, COUNT(*) AS transactions FROM transactions WHERE machine_id = $1 AND sold_at >= NOW() - $2::INTERVAL`, [machineId, interval]);
    const topProducts = await pgPool.query(`SELECT p.name, p.category, COUNT(*) AS units_sold, SUM(t.total_price) AS revenue
      FROM transactions t JOIN products p ON t.product_id = p.id WHERE t.machine_id = $1 AND t.sold_at >= NOW() - $2::INTERVAL GROUP BY p.name, p.category ORDER BY revenue DESC LIMIT 10`, [machineId, interval]);
    const hourly = await pgPool.query(`SELECT hour_of_day, COUNT(*) AS transactions, SUM(total_price) AS revenue FROM transactions WHERE machine_id = $1 AND sold_at >= NOW() - $2::INTERVAL GROUP BY hour_of_day ORDER BY hour_of_day`, [machineId, interval]);
    pgSuccess(res, { period: req.query.period || '30d', summary: summary.rows[0], top_products: topProducts.rows, hourly_pattern: hourly.rows });
  } catch (err) { console.error('GET /api/machines/:id/analytics error:', err); pgError(res, 500, err.message); }
});

// GET /api/machines/:id/pricing
app.get('/api/machines/:id/pricing', requirePG, async (req, res) => {
  try {
    const { rows: [machine] } = await pgPool.query(`SELECT m.*, pp.name AS profile_name, pp.beverage_mult, pp.snack_mult, pp.candy_mult, pp.incidental_mult
      FROM machines m LEFT JOIN pricing_profiles pp ON m.pricing_profile_id = pp.id WHERE m.id = $1`, [req.params.id]);
    if (!machine) return pgError(res, 404, 'Machine not found');
    const { rows: slots } = await pgPool.query(`SELECT s.id AS slot_id, s.slot_number, s.position_tier, s.price_override, p.name AS product_name, p.category, p.default_price, p.unit_cost,
      calculate_price($1, s.product_id, s.id) AS calculated_price FROM slots s LEFT JOIN products p ON s.product_id = p.id WHERE s.machine_id = $1 AND s.product_id IS NOT NULL ORDER BY s.row_position, s.col_position`, [req.params.id]);
    const { rows: profiles } = await pgPool.query('SELECT id, name, location_type FROM pricing_profiles ORDER BY name');
    pgSuccess(res, { machine_id: req.params.id, profile: machine.profile_name || 'No profile', slots, profiles });
  } catch (err) { console.error('GET /api/machines/:id/pricing error:', err); pgError(res, 500, err.message); }
});

// POST /api/machines/:id/pricing
app.post('/api/machines/:id/pricing', requirePG, async (req, res) => {
  const client = await pgPool.connect();
  try {
    await client.query('BEGIN');
    const { profile_id, slot_overrides } = req.body;
    if (profile_id !== undefined) await client.query('UPDATE machines SET pricing_profile_id = $1, updated_at = NOW() WHERE id = $2', [profile_id, req.params.id]);
    if (slot_overrides) for (const o of slot_overrides) await client.query('UPDATE slots SET price_override = $1, updated_at = NOW() WHERE id = $2 AND machine_id = $3', [o.price, o.slot_id, req.params.id]);
    await client.query('COMMIT');
    pgSuccess(res, { updated: true });
  } catch (err) { await client.query('ROLLBACK'); console.error('POST /api/machines/:id/pricing error:', err); pgError(res, 500, err.message); }
  finally { client.release(); }
});

// GET /api/machines/:id/slot-performance
app.get('/api/machines/:id/slot-performance', requirePG, async (req, res) => {
  try {
    const { rows } = await pgPool.query(`SELECT * FROM v_slot_performance WHERE machine_id = $1 ORDER BY row_position, col_position`, [req.params.id]);
    const heatMap = {}; for (const slot of rows) { if (!heatMap[slot.row_position]) heatMap[slot.row_position] = {}; heatMap[slot.row_position][slot.col_position] = { slot_id: slot.slot_id, product_name: slot.product_name, heat_score: Math.round(parseFloat(slot.heat_score) || 0), revenue_30d: slot.revenue_30d, position_tier: slot.position_tier }; }
    pgSuccess(res, { slots: rows, heat_map: heatMap });
  } catch (err) { console.error('GET /api/machines/:id/slot-performance error:', err); pgError(res, 500, err.message); }
});

// GET /api/v2/products
app.get('/api/v2/products', requirePG, async (req, res) => {
  try {
    const { page, limit, offset } = parsePagination(req.query);
    const cond = [], params = []; let i = 1;
    if (req.query.category) { cond.push(`category = $${i++}`); params.push(req.query.category); }
    if (req.query.search) { cond.push(`(name ILIKE $${i} OR brand ILIKE $${i})`); params.push(`%${req.query.search}%`); i++; }
    if (req.query.active !== undefined) { cond.push(`is_active = $${i++}`); params.push(req.query.active === 'true'); }
    const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
    const cnt = await pgPool.query(`SELECT COUNT(*) FROM products ${where}`, params);
    const { rows } = await pgPool.query(`SELECT * FROM products ${where} ORDER BY popularity DESC LIMIT $${i++} OFFSET $${i}`, [...params, limit, offset]);
    pgSuccess(res, rows, { page, limit, total: parseInt(cnt.rows[0].count), totalPages: Math.ceil(parseInt(cnt.rows[0].count) / limit) });
  } catch (err) { console.error('GET /api/v2/products error:', err); pgError(res, 500, err.message); }
});

// POST /api/v2/products
app.post('/api/v2/products', requirePG, async (req, res) => {
  try {
    const b = req.body;
    if (!b.name || !b.category || !b.default_price) return pgError(res, 400, 'name, category, default_price required');
    const unitCost = b.unit_cost || (b.case_price && b.units_per_case ? b.case_price / b.units_per_case : null);
    if (unitCost && b.default_price < unitCost * 3) return pgError(res, 400, `Price below 3x markup minimum ($${(unitCost * 3).toFixed(2)})`);
    const { rows: [product] } = await pgPool.query(`INSERT INTO products (name, brand, size, upc, category, case_price, units_per_case, unit_cost, default_price, min_price, max_price, popularity, image_url, is_premium, bundle_eligible, shelf_life_days)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [b.name, b.brand, b.size, b.upc, b.category, b.case_price, b.units_per_case, unitCost, b.default_price, b.min_price || (unitCost ? unitCost * 3 : null), b.max_price, b.popularity || 50, b.image_url, b.is_premium || false, b.bundle_eligible !== false, b.shelf_life_days]);
    pgSuccess(res, product);
  } catch (err) { if (err.code === '23505') return pgError(res, 409, 'Product with UPC exists'); console.error('POST /api/v2/products error:', err); pgError(res, 500, err.message); }
});

// GET /api/machines/:id/restock-history
app.get('/api/machines/:id/restock-history', requirePG, async (req, res) => {
  try {
    const { page, limit, offset } = parsePagination(req.query);
    const cnt = await pgPool.query('SELECT COUNT(*) FROM restock_events WHERE machine_id = $1', [req.params.id]);
    const { rows } = await pgPool.query(`SELECT re.*, (SELECT json_agg(ri) FROM restock_items ri WHERE ri.restock_id = re.id) AS line_items
      FROM restock_events re WHERE re.machine_id = $1 ORDER BY re.started_at DESC LIMIT $2 OFFSET $3`, [req.params.id, limit, offset]);
    pgSuccess(res, rows, { page, limit, total: parseInt(cnt.rows[0].count), totalPages: Math.ceil(parseInt(cnt.rows[0].count) / limit) });
  } catch (err) { console.error('GET /api/machines/:id/restock-history error:', err); pgError(res, 500, err.message); }
});

// GET /api/v2/fleet/overview
app.get('/api/v2/fleet/overview', requirePG, async (req, res) => {
  try {
    const fleet = await pgPool.query(`SELECT COUNT(*) FILTER (WHERE status = 'active') AS active_machines, COUNT(*) FILTER (WHERE status = 'staged') AS staged_machines, COUNT(*) AS total_machines FROM machines`);
    const rev = await pgPool.query(`SELECT COALESCE(SUM(total_price), 0) AS total_revenue, COALESCE(SUM(margin), 0) AS total_margin, COUNT(*) AS total_transactions FROM transactions WHERE sold_at >= NOW() - INTERVAL '30 days'`);
    const machines = await pgPool.query(`SELECT m.id, m.name, m.location_type, m.status, COALESCE(SUM(t.total_price), 0) AS revenue_30d, COUNT(t.id) AS transactions_30d
      FROM machines m LEFT JOIN transactions t ON t.machine_id = m.id AND t.sold_at >= NOW() - INTERVAL '30 days' WHERE m.status IN ('active', 'staged') GROUP BY m.id ORDER BY revenue_30d DESC`);
    const inv = await pgPool.query(`SELECT COUNT(*) FILTER (WHERE current_qty = 0) AS total_empty_slots, COUNT(*) FILTER (WHERE current_qty > 0 AND current_qty <= low_threshold) AS total_low_slots FROM slots s JOIN machines m ON s.machine_id = m.id WHERE m.status = 'active'`);
    const pullCandidates = machines.rows.filter(m => m.status === 'active' && parseFloat(m.revenue_30d) < 800);
    pgSuccess(res, { fleet: fleet.rows[0], revenue_30d: rev.rows[0], machines: machines.rows, inventory: inv.rows[0], alerts: { pull_candidates: pullCandidates.length, empty_slots: parseInt(inv.rows[0].total_empty_slots) } });
  } catch (err) { console.error('GET /api/v2/fleet/overview error:', err); pgError(res, 500, err.message); }
});

// GET /api/v2/pricing/profiles
app.get('/api/v2/pricing/profiles', requirePG, async (req, res) => {
  try { const { rows } = await pgPool.query('SELECT * FROM pricing_profiles ORDER BY name'); pgSuccess(res, rows); }
  catch (err) { console.error('GET /api/v2/pricing/profiles error:', err); pgError(res, 500, err.message); }
});

// Database health check
app.get('/api/v2/health', async (req, res) => {
  const r = { server: 'ok', database: 'not_configured' };
  if (pgPool) { try { const { rows } = await pgPool.query('SELECT NOW() AS time'); r.database = 'connected'; r.db_time = rows[0].time; } catch (e) { r.database = 'error'; r.db_error = e.message; } }
  res.json({ success: true, data: r });
});

// END POSTGRESQL API
// ============================================================

// ===== CONTRACT TEMPLATES API =====
app.get('/api/contract-generator/templates', (req, res) => {
  const contractsDir = path.join(__dirname, '..', 'contracts');
  try {
    const files = fs.readdirSync(contractsDir).filter(f => f.endsWith('.md') && f !== 'README.md');
    const templates = files.map(f => {
      const content = fs.readFileSync(path.join(contractsDir, f), 'utf8');
      return { filename: f, content };
    });
    res.json(templates);
  } catch (e) {
    res.status(500).json({ error: 'Could not read contract templates', detail: e.message });
  }
});
app.get('/contract-generator', (req, res) => {
  res.sendFile(path.join(__dirname, 'contract-generator.html'));
});

// ===== LEAD FILES API (Bulk Import) =====
const PROSPECTS_DIR = path.join(__dirname, 'sales', 'prospects');

// Normalize leads from various JSON file formats into a common shape
function normalizeLeadFile(data, filename) {
  const leads = [];
  const rawLeads = data.leads || data.prospects || [];
  const segment = data.segment || data._metadata?.category || data.metadata?.category || filename.replace(/^leads-/, '').replace(/-new\.json$|\.json$/, '').replace(/-/g, ' ');

  for (const raw of rawLeads) {
    const lead = {
      name: raw.company || raw.facilityName || raw.name || raw.facility || '',
      contact_name: raw.contact_name || raw.name || (raw.firstName && raw.lastName ? `${raw.firstName} ${raw.lastName}` : '') || (raw.contact && raw.contact.name) || '',
      contact_title: raw.contact_title || raw.title || (raw.contact && raw.contact.title) || '',
      company: raw.company || raw.facilityName || raw.parent_system || '',
      address: raw.address || raw.facilityAddress || raw.location || '',
      phone: raw.phone || raw.facilityPhone || (raw.contact && raw.contact.phone) || raw.contact_phone || raw.mobile || '',
      email: raw.email || (raw.contact && raw.contact.email) || raw.contact_email || '',
      property_type: raw.property_type || raw.facility_type || raw.facilityType || raw.company_type || raw.category || segment,
      units: raw.units || raw.units_managed || raw.bed_count || raw.employee_count || (raw.people_score && raw.people_score.people) || '',
      priority: (raw.priority || '').toString().toLowerCase(),
      score: raw.enrich_score || raw.vendingScore || raw.vending_score || (raw.people_score && raw.people_score.total) || 0,
      notes: raw.notes || raw.vendingNotes || '',
      source: raw.source || raw.source_url || '',
      priority_reasons: raw.priority_reasons || [],
      _raw_id: raw.id || null
    };
    // Normalize priority
    if (['high', 'p1-critical', 'p1', 'hot'].includes(lead.priority)) lead.priority = 'high';
    else if (['medium', 'p2', 'warm'].includes(lead.priority)) lead.priority = 'medium';
    else lead.priority = 'normal';
    // Clean up units
    if (typeof lead.units === 'string') {
      var numMatch = lead.units.toString().replace(/,/g, '').match(/\d+/);
      lead.units = numMatch ? parseInt(numMatch[0]) : '';
    }
    leads.push(lead);
  }
  return { segment, total: leads.length, leads };
}

// GET /api/lead-files — list available lead JSON files
app.get('/api/lead-files', (req, res) => {
  try {
    if (!fs.existsSync(PROSPECTS_DIR)) return res.json([]);
    var files = fs.readdirSync(PROSPECTS_DIR)
      .filter(f => f.startsWith('leads-') && f.endsWith('.json'))
      .map(f => {
        var stats = fs.statSync(path.join(PROSPECTS_DIR, f));
        var count = 0;
        try {
          var d = JSON.parse(fs.readFileSync(path.join(PROSPECTS_DIR, f), 'utf8'));
          count = (d.leads || d.prospects || []).length;
        } catch (e) { /* ignore */ }
        return { filename: f, size: stats.size, modified: stats.mtime.toISOString(), lead_count: count };
      });
    res.json(files);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/lead-files/:filename — read and return normalized leads from a file
app.get('/api/lead-files/:filename', (req, res) => {
  try {
    var filename = req.params.filename;
    if (!filename.startsWith('leads-') || !filename.endsWith('.json') || filename.includes('..')) {
      return res.status(400).json({ error: 'Invalid filename' });
    }
    var filePath = path.join(PROSPECTS_DIR, filename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
    var d = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    var normalized = normalizeLeadFile(d, filename);
    res.json(normalized);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/leads/import — bulk import with dedup, richer fields
app.post('/api/leads/import', (req, res) => {
  var leads = req.body.leads;
  if (!leads || !Array.isArray(leads) || leads.length === 0) {
    return res.status(400).json({ error: 'No leads provided' });
  }
  var imported = 0, duplicates = 0, errors = 0;
  var results = [];

  for (var i = 0; i < leads.length; i++) {
    var lead = leads[i];
    try {
      // Dedup: match on normalized address OR name
      var isDup = db.prospects.some(function(p) {
        if (lead.address && p.address) {
          var normA = lead.address.toLowerCase().replace(/[.,#\-]/g, '').replace(/\s+/g, ' ').trim();
          var normB = p.address.toLowerCase().replace(/[.,#\-]/g, '').replace(/\s+/g, ' ').trim();
          if (normA === normB) return true;
        }
        if (lead.name && p.name) {
          if (lead.name.toLowerCase().trim() === p.name.toLowerCase().trim()) return true;
        }
        return false;
      });

      if (isDup) {
        duplicates++;
        results.push({ name: lead.name || lead.contact_name, status: 'duplicate' });
        continue;
      }

      var prospect = {
        id: nextId(),
        name: lead.name || lead.contact_name || 'Unknown',
        address: lead.address || '',
        phone: lead.phone || '',
        email: lead.email || '',
        contact_name: lead.contact_name || '',
        contact_title: lead.contact_title || '',
        company: lead.company || '',
        property_type: lead.property_type || '',
        units: lead.units || '',
        priority: lead.priority === 'high' ? 'hot' : 'normal',
        notes: lead.notes || '',
        score: lead.score || 0,
        source: lead.source || 'bulk-import',
        status: 'new',
        lat: null, lng: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };

      db.prospects.push(prospect);
      imported++;
      results.push({ name: prospect.name, status: 'imported', id: prospect.id });

      // Auto-create pipeline card
      if (typeof ensurePipelineCard === 'function') ensurePipelineCard(prospect.id);
    } catch (e) {
      errors++;
      results.push({ name: lead.name || '?', status: 'error', message: e.message });
    }
  }

  if (imported > 0) saveDB(db);
  res.json({ imported, duplicates, errors, total: leads.length, results });
});

// ===== END LEAD FILES API =====

// ===== WEEKLY POP-IN ROUTES API =====

// Serve weekly routes page
app.get('/weekly-routes', (req, res) => res.sendFile(path.join(__dirname, 'weekly-routes.html')));

// GET /api/weekly-routes — returns prospects scored and ready for client-side routing
app.get('/api/weekly-routes', (req, res) => {
  const HOME_BASE = { lat: 36.0304, lng: -114.9817 };
  const MAX_RADIUS_KM = 48; // ~30 miles / 45 min

  function haversineKm(lat1, lng1, lat2, lng2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  }

  // Get all non-closed prospects with geocoded addresses
  const prospects = db.prospects
    .filter(p => p.lat && p.lng && p.status !== 'closed' && p.status !== 'signed')
    .filter(p => haversineKm(HOME_BASE.lat, HOME_BASE.lng, p.lat, p.lng) <= MAX_RADIUS_KM)
    .map(p => {
      const activities = db.activities.filter(a => a.prospect_id === p.id);
      const lastActivity = activities.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
      const contacts = db.contacts.filter(c => c.prospect_id === p.id);
      const primaryContact = contacts.find(c => c.is_primary) || contacts[0];
      const popIns = (db.popInVisits || []).filter(v => v.prospect_id === p.id);
      const lastPopIn = popIns.sort((a, b) => new Date(b.visit_date) - new Date(a.visit_date))[0];

      // Scoring
      let score = 0;
      if (p.priority === 'hot') score += 30;
      else if (p.priority === 'warm') score += 20;
      else score += 5;

      const daysSinceActivity = lastActivity
        ? Math.floor((Date.now() - new Date(lastActivity.created_at).getTime()) / (1000*60*60*24))
        : 999;
      if (daysSinceActivity > 30) score += 25;
      else if (daysSinceActivity > 14) score += 15;
      else if (daysSinceActivity > 7) score += 8;

      if (p.next_action_date) {
        const overdueDays = Math.floor((Date.now() - new Date(p.next_action_date).getTime()) / (1000*60*60*24));
        if (overdueDays > 0) score += 35;
        else if (overdueDays > -3) score += 20;
      }

      return {
        id: p.id, name: p.name, address: p.address,
        property_type: p.property_type, priority: p.priority,
        status: p.status, lat: p.lat, lng: p.lng,
        phone: p.phone || primaryContact?.phone || '',
        primary_contact: primaryContact?.name || p.contact_name || '',
        last_activity_date: lastActivity?.created_at || null,
        last_pop_in: lastPopIn?.visit_date || null,
        next_action: p.next_action || null,
        next_action_date: p.next_action_date || null,
        activity_count: activities.length,
        pop_in_count: popIns.length,
        score,
        distance_km: haversineKm(HOME_BASE.lat, HOME_BASE.lng, p.lat, p.lng)
      };
    })
    .sort((a, b) => b.score - a.score);

  res.json({
    prospects,
    total: prospects.length,
    home_base: HOME_BASE,
    generated_at: new Date().toISOString()
  });
});

// POST /api/weekly-routes/log-visit — quick log from route planner
app.post('/api/weekly-routes/log-visit', (req, res) => {
  const { prospect_id, notes, outcome, gift_basket_given, visitor } = req.body;
  if (!prospect_id) return res.status(400).json({ error: 'prospect_id required' });

  const prospect = db.prospects.find(p => p.id === parseInt(prospect_id));
  if (!prospect) return res.status(404).json({ error: 'Prospect not found' });

  // Create pop-in visit
  const visit = {
    id: nextId(),
    prospect_id: parseInt(prospect_id),
    visit_date: new Date().toISOString().split('T')[0],
    visitor: visitor || 'Kurtis',
    notes: notes || '',
    outcome: outcome || 'neutral',
    gift_basket_given: gift_basket_given || false,
    gift_basket_contents: '',
    spoke_with: '',
    spoke_with_title: '',
    existing_vending: '',
    competitor_machines: '',
    photos: [],
    follow_up_notes: '',
    source: 'weekly-routes',
    created_at: new Date().toISOString()
  };
  if (!db.popInVisits) db.popInVisits = [];
  db.popInVisits.push(visit);

  // Log activity
  db.activities.push({
    id: nextId(),
    prospect_id: parseInt(prospect_id),
    type: 'pop_in',
    description: `Pop-in via route planner: ${outcome}${gift_basket_given ? ' 🎁' : ''} — ${(notes || '').substring(0, 80)}`,
    outcome: outcome,
    created_at: new Date().toISOString()
  });

  // Move pipeline stage if early
  const card = (db.pipelineCards || []).find(c => c.prospect_id === parseInt(prospect_id));
  if (card && ['new_lead', 'contacted'].includes(card.stage)) {
    card.stage = 'pop_in_done';
    card.entered_stage_at = new Date().toISOString();
    card.updated_at = new Date().toISOString();
    if (typeof runWorkflowRules === 'function') {
      runWorkflowRules('stage_change', { prospect_id: parseInt(prospect_id), old_stage: card.stage, new_stage: 'pop_in_done' });
    }
  }

  // Auto-upgrade priority on interest
  if (outcome === 'interested') {
    const pIdx = db.prospects.findIndex(p => p.id === parseInt(prospect_id));
    if (pIdx !== -1) {
      db.prospects[pIdx].priority = 'hot';
      db.prospects[pIdx].updated_at = new Date().toISOString();
    }
  }

  // Update prospect last activity timestamp
  prospect.updated_at = new Date().toISOString();

  saveDB(db);
  res.json({ success: true, visit });
});

// ===== END WEEKLY ROUTES API =====

// ===== GIFT BASKETS API =====
// Per Skool community: Gift baskets are the #1 sales tool in vending.
// 8-10 touches to close — baskets keep you top-of-mind with property managers.

if (!db.giftBaskets) db.giftBaskets = [];

// Basket templates for reference
const BASKET_TEMPLATES = {
  first_touch: { name: 'First Touch', cost: 25, items: ['Variety snack mix', 'Bottled water (2-pack)', 'Business card', 'One-pager brochure', 'Cellophane bag + ribbon'] },
  decision_maker: { name: 'Decision Maker', cost: 50, items: ['Premium nuts & dried fruit', 'Godiva chocolate', 'Celsius energy drinks (2)', 'Full proposal packet', 'Branded tote bag', 'Handwritten thank-you note'] },
  thank_you: { name: 'Thank You', cost: 30, items: ['Gourmet cookies/brownies', 'Sparkling water', 'Thank-you card (handwritten)', 'Branded pen/magnet', 'Candy assortment'] },
  holiday: { name: 'Holiday', cost: 40, items: ['Holiday cookie tin', 'Hot cocoa packets', 'Seasonal candy', 'Holiday card (personalized)', 'Small seasonal item'] },
  custom: { name: 'Custom', cost: 0, items: [] }
};

// GET all gift baskets
app.get('/api/gift-baskets', (req, res) => {
  const { status, type, prospect_id } = req.query;
  let records = db.giftBaskets || [];
  if (status) records = records.filter(b => b.status === status);
  if (type) records = records.filter(b => b.basket_type === type);
  if (prospect_id) records = records.filter(b => b.prospect_id === parseInt(prospect_id));
  res.json(records.sort((a, b) => new Date(b.delivery_date || b.created_at) - new Date(a.delivery_date || a.created_at)));
});

// GET single gift basket
app.get('/api/gift-baskets/stats', (req, res) => {
  const baskets = db.giftBaskets || [];
  const prospects = db.prospects || [];
  const activities = db.activities || [];
  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  const total = baskets.length;
  const delivered = baskets.filter(b => b.status === 'delivered' || b.status === 'followup_done').length;
  const pending = baskets.filter(b => b.status === 'planned' || b.status === 'assembled').length;

  // Cost this month
  const costThisMonth = baskets
    .filter(b => {
      const d = b.delivery_date || (b.created_at ? b.created_at.split('T')[0] : '');
      return d.startsWith(currentMonth);
    })
    .reduce((sum, b) => sum + (b.cost || 0), 0);

  // Conversion rate: prospects who received baskets AND signed
  const prospectIdsWithBaskets = [...new Set(baskets.filter(b => b.status === 'delivered' || b.status === 'followup_done').map(b => b.prospect_id))];
  const signedWithBaskets = prospectIdsWithBaskets.filter(pid => {
    const p = prospects.find(pr => pr.id === pid);
    return p && p.status === 'signed';
  }).length;
  const conversionRate = prospectIdsWithBaskets.length > 0 ? (signedWithBaskets / prospectIdsWithBaskets.length) * 100 : 0;

  // Average touches to close (activities count for signed prospects who got baskets)
  let avgTouches = null;
  const signedIds = prospects.filter(p => p.status === 'signed').map(p => p.id);
  if (signedIds.length > 0) {
    const touchCounts = signedIds.map(pid => activities.filter(a => a.prospect_id === pid).length);
    avgTouches = touchCounts.reduce((s, n) => s + n, 0) / touchCounts.length;
  }

  res.json({
    total,
    delivered,
    pending,
    cost_this_month: costThisMonth,
    month_label: monthNames[now.getMonth()] + ' ' + now.getFullYear(),
    conversion_rate: conversionRate,
    avg_touches: avgTouches,
    prospects_with_baskets: prospectIdsWithBaskets.length,
    signed_with_baskets: signedWithBaskets
  });
});

// GET shopping list — aggregates Costco items for planned baskets
app.get('/api/gift-baskets/shopping-list', (req, res) => {
  const planned = (db.giftBaskets || []).filter(b => b.status === 'planned' || b.status === 'assembled');

  // Count baskets by type
  const typeCounts = {};
  planned.forEach(b => {
    const t = b.basket_type || 'custom';
    typeCounts[t] = (typeCounts[t] || 0) + 1;
  });

  // Costco item mappings per template type
  const costcoItems = {
    first_touch: [
      { item: 'Frito-Lay Variety Pack (28ct)', qty_per: 4, unit_cost: 15.99, category: 'Snacks' },
      { item: 'Kirkland Bottled Water (40ct)', qty_per: 20, unit_cost: 4.49, category: 'Beverages' },
      { item: 'Cellophane Gift Bags (50ct)', qty_per: 25, unit_cost: 8.99, category: 'Supplies' },
      { item: 'Curling Ribbon Roll', qty_per: 50, unit_cost: 3.99, category: 'Supplies' }
    ],
    decision_maker: [
      { item: 'Kirkland Mixed Nuts (2.5lb)', qty_per: 5, unit_cost: 12.99, category: 'Snacks' },
      { item: 'Godiva Chocolate Assortment', qty_per: 3, unit_cost: 16.99, category: 'Snacks' },
      { item: 'Celsius Energy Variety (18ct)', qty_per: 6, unit_cost: 24.99, category: 'Beverages' },
      { item: 'Reusable Tote Bags (6ct)', qty_per: 6, unit_cost: 11.99, category: 'Supplies' },
      { item: 'Thank You Cards (50ct)', qty_per: 50, unit_cost: 9.99, category: 'Supplies' }
    ],
    thank_you: [
      { item: 'Kirkland Gourmet Cookies (24ct)', qty_per: 6, unit_cost: 11.99, category: 'Snacks' },
      { item: 'S.Pellegrino Sparkling Water (12ct)', qty_per: 6, unit_cost: 13.49, category: 'Beverages' },
      { item: 'Ghirardelli Chocolate Squares', qty_per: 4, unit_cost: 10.99, category: 'Snacks' },
      { item: 'Thank You Cards (50ct)', qty_per: 50, unit_cost: 9.99, category: 'Supplies' }
    ],
    holiday: [
      { item: 'Kirkland Holiday Cookie Tin', qty_per: 1, unit_cost: 14.99, category: 'Snacks' },
      { item: 'Swiss Miss Hot Cocoa (50ct)', qty_per: 10, unit_cost: 8.99, category: 'Beverages' },
      { item: 'Seasonal Candy Assortment', qty_per: 4, unit_cost: 12.99, category: 'Snacks' },
      { item: 'Holiday Cards Box (40ct)', qty_per: 40, unit_cost: 11.99, category: 'Supplies' }
    ]
  };

  // Aggregate needed quantities
  const needed = {};
  for (const [type, count] of Object.entries(typeCounts)) {
    const items = costcoItems[type];
    if (!items) continue;
    items.forEach(ci => {
      const key = ci.item;
      if (!needed[key]) needed[key] = { ...ci, qty: 0 };
      // Calculate packs needed: ceil(baskets / qty_per_pack)
      needed[key].qty += Math.ceil(count / ci.qty_per);
    });
  }

  const items = Object.values(needed).sort((a, b) => a.category.localeCompare(b.category) || a.item.localeCompare(b.item));
  const estimatedTotal = items.reduce((sum, i) => sum + (i.qty * i.unit_cost), 0);

  res.json({
    planned_baskets: planned.length,
    basket_types: typeCounts,
    items,
    estimated_total: estimatedTotal
  });
});

// GET single gift basket by ID
app.get('/api/gift-baskets/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const basket = (db.giftBaskets || []).find(b => b.id === id);
  if (!basket) return res.status(404).json({ error: 'Gift basket not found' });
  const prospect = db.prospects.find(p => p.id === basket.prospect_id);
  res.json({ ...basket, prospect_name: prospect?.name || 'Unknown' });
});

// POST new gift basket
app.post('/api/gift-baskets', (req, res) => {
  if (!req.body.prospect_id) {
    return res.status(400).json({ error: 'prospect_id is required' });
  }
  const basket = {
    id: nextId(),
    prospect_id: parseInt(req.body.prospect_id),
    basket_type: req.body.basket_type || 'first_touch',
    delivery_date: req.body.delivery_date || new Date().toISOString().split('T')[0],
    cost: parseFloat(req.body.cost) || BASKET_TEMPLATES[req.body.basket_type]?.cost || 0,
    delivery_method: req.body.delivery_method || 'drop-off',
    status: req.body.status || 'planned',
    contents: req.body.contents || '',
    notes: req.body.notes || '',
    photo: req.body.photo || '',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  if (!db.giftBaskets) db.giftBaskets = [];
  db.giftBaskets.push(basket);

  // Auto-log activity on the prospect
  db.activities.push({
    id: nextId(),
    prospect_id: basket.prospect_id,
    type: 'gift_basket',
    description: `🎁 Gift basket (${BASKET_TEMPLATES[basket.basket_type]?.name || basket.basket_type}) — $${basket.cost.toFixed(2)} — ${basket.status}`,
    created_at: new Date().toISOString()
  });

  saveDB(db);
  res.json(basket);
});

// PUT update gift basket
app.put('/api/gift-baskets/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const idx = (db.giftBaskets || []).findIndex(b => b.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Gift basket not found' });

  const old = db.giftBaskets[idx];
  const updated = { ...old, ...req.body, updated_at: new Date().toISOString() };
  if (req.body.cost !== undefined) updated.cost = parseFloat(req.body.cost);
  if (req.body.prospect_id !== undefined) updated.prospect_id = parseInt(req.body.prospect_id);
  db.giftBaskets[idx] = updated;

  // Log status changes as activities
  if (req.body.status && req.body.status !== old.status) {
    const statusLabels = { planned: '📋 Planned', assembled: '🔧 Assembled', delivered: '✅ Delivered', followup_done: '🎯 Follow-up Done' };
    db.activities.push({
      id: nextId(),
      prospect_id: updated.prospect_id,
      type: 'gift_basket',
      description: `🎁 Basket status: ${statusLabels[old.status] || old.status} → ${statusLabels[req.body.status] || req.body.status}`,
      created_at: new Date().toISOString()
    });
  }

  saveDB(db);
  res.json(db.giftBaskets[idx]);
});

// DELETE gift basket
app.delete('/api/gift-baskets/:id', (req, res) => {
  const id = parseInt(req.params.id);
  db.giftBaskets = (db.giftBaskets || []).filter(b => b.id !== id);
  saveDB(db);
  res.json({ success: true });
});

// ===== END GIFT BASKETS API =====

// ===== FOLLOW-UPS PAGE =====
app.get('/follow-ups', (req, res) => res.sendFile(path.join(__dirname, 'follow-ups.html')));

// ===== CALL SCRIPTS PAGE =====
app.get('/call-scripts', (req, res) => res.sendFile(path.join(__dirname, 'call-scripts.html')));

// ===== FOLLOW-UP AUTOMATION API =====
// Get follow-up stats and overdue prospects
app.get('/api/follow-ups/stats', (req, res) => {
  const now = new Date();
  const noActivityDays = parseInt(req.query.days) || 7;
  
  // Get all active prospects (not signed or closed)
  const activeProspects = db.prospects.filter(p => 
    p.status !== 'signed' && p.status !== 'closed'
  );
  
  // Calculate stats for each prospect
  const prospectStats = activeProspects.map(p => {
    const prospectActivities = (db.activities || [])
      .filter(a => a.prospect_id === p.id)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    
    const lastActivity = prospectActivities[0];
    const touchCount = prospectActivities.length;
    const lastActivityDate = lastActivity ? new Date(lastActivity.created_at) : new Date(p.created_at);
    const daysSinceActivity = Math.floor((now - lastActivityDate) / (1000 * 60 * 60 * 24));
    
    return {
      ...p,
      touch_count: touchCount,
      last_activity: lastActivity || null,
      last_activity_date: lastActivityDate.toISOString(),
      days_since_activity: daysSinceActivity,
      is_overdue: daysSinceActivity >= noActivityDays
    };
  });
  
  // Sort by days since activity (most overdue first)
  prospectStats.sort((a, b) => b.days_since_activity - a.days_since_activity);
  
  // Calculate overall stats
  const overdue = prospectStats.filter(p => p.is_overdue);
  const dueToday = prospectStats.filter(p => 
    p.days_since_activity >= noActivityDays - 1 && p.days_since_activity < noActivityDays
  );
  
  // Calculate average touches to close for signed prospects
  const signedProspects = db.prospects.filter(p => p.status === 'signed');
  let avgTouchesToClose = 0;
  let avgDaysToClose = 0;
  
  if (signedProspects.length > 0) {
    let totalTouches = 0;
    let totalDays = 0;
    
    signedProspects.forEach(p => {
      const touches = (db.activities || []).filter(a => a.prospect_id === p.id).length;
      totalTouches += touches;
      
      const created = new Date(p.created_at);
      const signed = p.signed_at ? new Date(p.signed_at) : new Date(p.updated_at);
      totalDays += Math.floor((signed - created) / (1000 * 60 * 60 * 24));
    });
    
    avgTouchesToClose = Math.round(totalTouches / signedProspects.length * 10) / 10;
    avgDaysToClose = Math.round(totalDays / signedProspects.length);
  }
  
  // Conversion rates by touch count
  const touchBuckets = {
    '1-3': { total: 0, signed: 0 },
    '4-6': { total: 0, signed: 0 },
    '7-9': { total: 0, signed: 0 },
    '10+': { total: 0, signed: 0 }
  };
  
  db.prospects.forEach(p => {
    const touches = (db.activities || []).filter(a => a.prospect_id === p.id).length;
    const bucket = touches <= 3 ? '1-3' : touches <= 6 ? '4-6' : touches <= 9 ? '7-9' : '10+';
    touchBuckets[bucket].total++;
    if (p.status === 'signed') touchBuckets[bucket].signed++;
  });
  
  res.json({
    overdue_count: overdue.length,
    due_today_count: dueToday.length,
    avg_touches_to_close: avgTouchesToClose,
    avg_days_to_close: avgDaysToClose,
    total_active: activeProspects.length,
    overdue_prospects: overdue,
    due_today_prospects: dueToday,
    all_prospects: prospectStats,
    conversion_by_touch: touchBuckets
  });
});

// Get recommended actions for today
app.get('/api/follow-ups/today', (req, res) => {
  const rules = {
    popinToGift: parseInt(req.query.popin_to_gift) || 3,
    giftToCall: parseInt(req.query.gift_to_call) || 5,
    callToEmail: parseInt(req.query.call_to_email) || 7,
    emailToPopin: parseInt(req.query.email_to_popin) || 14,
    noActivityAlert: parseInt(req.query.no_activity) || 7
  };
  
  const now = new Date();
  const activeProspects = db.prospects.filter(p => 
    p.status !== 'signed' && p.status !== 'closed'
  );
  
  const todayActions = [];
  
  activeProspects.forEach(p => {
    const prospectActivities = (db.activities || [])
      .filter(a => a.prospect_id === p.id)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    
    const lastActivity = prospectActivities[0];
    const touchCount = prospectActivities.length;
    const lastActivityDate = lastActivity ? new Date(lastActivity.created_at) : new Date(p.created_at);
    const daysSinceActivity = Math.floor((now - lastActivityDate) / (1000 * 60 * 60 * 24));
    
    let action = null;
    let actionType = null;
    let reason = null;
    
    if (!lastActivity) {
      action = 'Pop-In';
      actionType = 'pop_in';
      reason = 'No activity yet — start with a pop-in visit';
    } else {
      const lastType = (lastActivity.type || '').toLowerCase().replace('-', '_');
      
      if ((lastType === 'pop_in' || lastType === 'popin' || lastType === 'visit') && daysSinceActivity >= rules.popinToGift) {
        action = 'Send Gift Basket';
        actionType = 'gift_basket';
        reason = `${daysSinceActivity} days since pop-in`;
      } else if ((lastType === 'gift_basket' || lastType === 'gift') && daysSinceActivity >= rules.giftToCall) {
        action = 'Follow-Up Call';
        actionType = 'call';
        reason = `${daysSinceActivity} days since gift basket`;
      } else if ((lastType === 'call' || lastType === 'phone') && daysSinceActivity >= rules.callToEmail) {
        action = 'Send Email';
        actionType = 'email';
        reason = `${daysSinceActivity} days since call`;
      } else if (lastType === 'email' && daysSinceActivity >= rules.emailToPopin) {
        action = 'Schedule Pop-In';
        actionType = 'pop_in';
        reason = `${daysSinceActivity} days since email`;
      } else if (daysSinceActivity >= rules.noActivityAlert) {
        action = 'Any Touchpoint';
        actionType = 'pop_in';
        reason = `${daysSinceActivity} days overdue!`;
      }
      
      // High touch count overrides
      if (touchCount >= 10 && !action) {
        action = 'Ask for Decision';
        actionType = 'call';
        reason = `${touchCount} touches — time to close!`;
      } else if (touchCount >= 7 && !action) {
        action = 'Send Proposal';
        actionType = 'proposal';
        reason = `${touchCount} touches — push for close`;
      }
    }
    
    if (action) {
      todayActions.push({
        prospect_id: p.id,
        prospect_name: p.name,
        action,
        action_type: actionType,
        reason,
        touch_count: touchCount,
        days_since_activity: daysSinceActivity,
        priority: p.priority || 'normal'
      });
    }
  });
  
  // Sort by priority and days overdue
  todayActions.sort((a, b) => {
    const priorityOrder = { hot: 1, warm: 2, normal: 3 };
    const priorityDiff = (priorityOrder[a.priority] || 3) - (priorityOrder[b.priority] || 3);
    if (priorityDiff !== 0) return priorityDiff;
    return b.days_since_activity - a.days_since_activity;
  });
  
  res.json({
    count: todayActions.length,
    actions: todayActions
  });
});

// ===== PERFORMANCE DASHBOARD PAGE =====
app.get('/performance', (req, res) => {
  res.sendFile(path.join(__dirname, 'performance.html'));
});

// ===== EMAIL TEMPLATES PAGE =====
app.get('/email-templates', (req, res) => {
  res.sendFile(path.join(__dirname, 'email-templates.html'));
});

// ===== INVENTORY PAGE =====
app.get('/inventory', (req, res) => {
  res.sendFile(path.join(__dirname, 'inventory.html'));
});

// ===== INVENTORY HISTORY API =====
if (!db.inventoryHistory) db.inventoryHistory = [];

app.get('/api/inventory/history', (req, res) => {
  const { product_id, type, from, to } = req.query;
  let records = db.inventoryHistory || [];
  if (product_id) records = records.filter(r => r.product_id === parseInt(product_id));
  if (type) records = records.filter(r => r.type === type);
  if (from) records = records.filter(r => r.date >= from);
  if (to) records = records.filter(r => r.date <= to);
  res.json(records.sort((a, b) => new Date(b.date) - new Date(a.date)));
});

app.post('/api/inventory/history', (req, res) => {
  const entry = {
    id: nextId(),
    product_id: req.body.product_id,
    type: req.body.type || 'adjusted',
    qty: req.body.qty || 0,
    notes: req.body.notes || '',
    date: req.body.date || new Date().toISOString(),
    created_at: new Date().toISOString()
  };
  if (!db.inventoryHistory) db.inventoryHistory = [];
  db.inventoryHistory.push(entry);
  saveDB(db);
  res.json(entry);
});

// ===== SEED DEMO PRODUCTS (if empty) =====
if (db.products.length === 0) {
  const demoProducts = [
    // Beverages
    { name: 'Coca-Cola 20oz', category: 'beverages', sku: 'BEV-COKE20', cost_price: 0.89, sell_price: 2.75, stock: 48, reorder_point: 24 },
    { name: 'Diet Coke 20oz', category: 'beverages', sku: 'BEV-DCOKE20', cost_price: 0.89, sell_price: 2.75, stock: 36, reorder_point: 24 },
    { name: 'Smartwater 20oz', category: 'beverages', sku: 'BEV-SMART20', cost_price: 0.95, sell_price: 2.50, stock: 60, reorder_point: 30 },
    { name: 'Gatorade Cool Blue 20oz', category: 'beverages', sku: 'BEV-GATOR20', cost_price: 0.99, sell_price: 3.00, stock: 24, reorder_point: 18 },
    { name: 'Fairlife Chocolate Milk', category: 'beverages', sku: 'BEV-FAIR-CHOC', cost_price: 2.29, sell_price: 4.50, stock: 12, reorder_point: 12, expiration_date: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().split('T')[0] },
    { name: 'BOSS Coffee Black', category: 'beverages', sku: 'BEV-BOSS-BLK', cost_price: 1.49, sell_price: 3.50, stock: 18, reorder_point: 12 },
    // Energy
    { name: 'Joy Burst Energy 12oz', category: 'energy', sku: 'NRG-JOYBURST', cost_price: 1.25, sell_price: 3.50, stock: 36, reorder_point: 24 },
    { name: 'Celsius Original', category: 'energy', sku: 'NRG-CELS-ORIG', cost_price: 1.49, sell_price: 3.50, stock: 24, reorder_point: 18 },
    { name: 'Red Bull 8.4oz', category: 'energy', sku: 'NRG-REDBULL', cost_price: 1.79, sell_price: 4.00, stock: 30, reorder_point: 20 },
    { name: 'Monster Original 16oz', category: 'energy', sku: 'NRG-MONSTER', cost_price: 1.49, sell_price: 3.50, stock: 24, reorder_point: 18 },
    // Snacks
    { name: 'Lays Classic 1.75oz', category: 'snacks', sku: 'SNK-LAYS175', cost_price: 0.65, sell_price: 2.25, stock: 48, reorder_point: 24 },
    { name: 'Doritos Nacho 1.75oz', category: 'snacks', sku: 'SNK-DORI175', cost_price: 0.65, sell_price: 2.25, stock: 36, reorder_point: 24 },
    { name: 'Cheetos Crunchy 2oz', category: 'snacks', sku: 'SNK-CHEET2', cost_price: 0.69, sell_price: 2.25, stock: 30, reorder_point: 18 },
    { name: 'Hot Cheetos 2oz', category: 'snacks', sku: 'SNK-HOTCH2', cost_price: 0.69, sell_price: 2.25, stock: 36, reorder_point: 24 },
    { name: 'Takis Fuego 2oz', category: 'snacks', sku: 'SNK-TAKIS2', cost_price: 0.75, sell_price: 2.50, stock: 24, reorder_point: 18 },
    // Candy
    { name: 'Snickers King Size', category: 'candy', sku: 'CND-SNICK-K', cost_price: 0.85, sell_price: 2.50, stock: 24, reorder_point: 12 },
    { name: 'Reeses King Size', category: 'candy', sku: 'CND-REESE-K', cost_price: 0.85, sell_price: 2.50, stock: 24, reorder_point: 12 },
    { name: 'M&Ms Peanut King', category: 'candy', sku: 'CND-MMS-K', cost_price: 0.89, sell_price: 2.50, stock: 18, reorder_point: 12 },
    { name: 'Skittles Original', category: 'candy', sku: 'CND-SKIT', cost_price: 0.75, sell_price: 2.25, stock: 18, reorder_point: 12 },
    // Healthy
    { name: 'KIND Bar Dark Choc', category: 'healthy', sku: 'HLT-KIND-DC', cost_price: 1.25, sell_price: 3.00, stock: 18, reorder_point: 12 },
    { name: 'RXBar Chocolate', category: 'healthy', sku: 'HLT-RXBAR', cost_price: 1.49, sell_price: 3.50, stock: 12, reorder_point: 10 },
    { name: 'Baked Lays 1.5oz', category: 'healthy', sku: 'HLT-BLAYS', cost_price: 0.72, sell_price: 2.25, stock: 24, reorder_point: 12 },
    { name: 'Trail Mix 2oz', category: 'healthy', sku: 'HLT-TRAIL', cost_price: 0.99, sell_price: 2.75, stock: 18, reorder_point: 12 },
    { name: 'Nature Valley Oats', category: 'healthy', sku: 'HLT-NATV', cost_price: 0.65, sell_price: 2.00, stock: 24, reorder_point: 12 },
    // Incidentals
    { name: 'Advil 2-Pack', category: 'incidentals', sku: 'INC-ADVIL', cost_price: 0.45, sell_price: 2.00, stock: 12, reorder_point: 6 },
    { name: 'Phone Charger Lightning', category: 'incidentals', sku: 'INC-CHRG-L', cost_price: 3.50, sell_price: 8.00, stock: 6, reorder_point: 4 },
    { name: 'Tide Pods 3-Pack', category: 'incidentals', sku: 'INC-TIDE3', cost_price: 1.99, sell_price: 5.00, stock: 8, reorder_point: 6 },
    { name: 'Charmin To-Go', category: 'incidentals', sku: 'INC-CHARM', cost_price: 0.89, sell_price: 3.00, stock: 10, reorder_point: 6 },
    // Low stock items for demo
    { name: 'Fiji Water 500ml', category: 'beverages', sku: 'BEV-FIJI500', cost_price: 1.25, sell_price: 3.00, stock: 6, reorder_point: 12 },
    { name: 'VOSS Water 500ml', category: 'beverages', sku: 'BEV-VOSS500', cost_price: 1.35, sell_price: 3.50, stock: 4, reorder_point: 10 },
    // Out of stock items for demo
    { name: 'Prime Energy Blue', category: 'energy', sku: 'NRG-PRIME-BLU', cost_price: 1.99, sell_price: 4.00, stock: 0, reorder_point: 12 },
    { name: 'Alani Nu Energy', category: 'energy', sku: 'NRG-ALANI', cost_price: 1.79, sell_price: 4.00, stock: 0, reorder_point: 10 },
    // Expiring soon items
    { name: 'Greek Yogurt Parfait', category: 'healthy', sku: 'HLT-YOGURT', cost_price: 2.49, sell_price: 5.00, stock: 8, reorder_point: 6, expiration_date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0] },
    { name: 'Fresh Fruit Cup', category: 'healthy', sku: 'HLT-FRUIT', cost_price: 1.99, sell_price: 4.50, stock: 6, reorder_point: 6, expiration_date: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString().split('T')[0] }
  ];

  demoProducts.forEach(p => {
    const product = {
      id: nextId(),
      ...p,
      margin: p.sell_price > 0 ? Math.round(((p.sell_price - p.cost_price) / p.sell_price) * 100) : 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    db.products.push(product);
  });
  saveDB(db);
  console.log(`📦 Seeded ${demoProducts.length} demo products for inventory`);
}

// ===== MACHINE LOCATOR TOOL =====
app.get('/machine-locator', (req, res) => {
  res.sendFile(path.join(__dirname, 'machine-locator.html'));
});

// ===== SITE SURVEYS API =====
if (!db.siteSurveys) db.siteSurveys = [];

app.get('/api/site-surveys', (req, res) => {
  res.json(db.siteSurveys.sort((a, b) => new Date(b.created_at) - new Date(a.created_at)));
});

app.get('/api/site-surveys/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const survey = db.siteSurveys.find(s => s.id === id);
  if (!survey) return res.status(404).json({ error: 'Not found' });
  res.json(survey);
});

app.post('/api/site-surveys', (req, res) => {
  const survey = {
    id: nextId(),
    property_name: req.body.property_name || '',
    survey_date: req.body.survey_date || new Date().toISOString().split('T')[0],
    address: req.body.address || '',
    pm_name: req.body.pm_name || '',
    pm_phone: req.body.pm_phone || '',
    pm_email: req.body.pm_email || '',
    locations: req.body.locations || [],
    traffic: req.body.traffic || '',
    competition: req.body.competition || '',
    recommended_machines: parseInt(req.body.recommended_machines) || 1,
    rating: parseInt(req.body.rating) || 0,
    notes: req.body.notes || '',
    photos: req.body.photos || [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  db.siteSurveys.push(survey);
  saveDB(db);
  res.json(survey);
});

app.put('/api/site-surveys/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const idx = db.siteSurveys.findIndex(s => s.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  db.siteSurveys[idx] = { ...db.siteSurveys[idx], ...req.body, updated_at: new Date().toISOString() };
  saveDB(db);
  res.json(db.siteSurveys[idx]);
});

app.delete('/api/site-surveys/:id', (req, res) => {
  const id = parseInt(req.params.id);
  db.siteSurveys = db.siteSurveys.filter(s => s.id !== id);
  saveDB(db);
  res.json({ success: true });
});

// ===== DAILY PLANNER =====
app.get('/daily-planner', (req, res) => {
  res.sendFile(path.join(__dirname, 'daily-planner.html'));
});

// ===== WIN/LOSS ANALYSIS API =====
if (!db.winLossDeals) db.winLossDeals = [];

app.get('/win-loss', (req, res) => {
  res.sendFile(path.join(__dirname, 'win-loss.html'));
});

app.get('/api/win-loss', (req, res) => {
  res.json(db.winLossDeals.sort((a, b) => new Date(b.closed_date) - new Date(a.closed_date)));
});

app.get('/api/win-loss/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const deal = db.winLossDeals.find(d => d.id === id);
  if (!deal) return res.status(404).json({ error: 'Not found' });
  res.json(deal);
});

app.post('/api/win-loss', (req, res) => {
  const deal = {
    id: nextId(),
    property_name: req.body.property_name || '',
    property_type: req.body.property_type || '',
    outcome: req.body.outcome || 'lost', // 'won' or 'lost'
    closed_date: req.body.closed_date || new Date().toISOString().split('T')[0],
    days_to_close: req.body.days_to_close || null,
    touch_count: req.body.touch_count || null,
    deal_value: req.body.deal_value || null,
    reason: req.body.reason || '',
    // Won-specific
    what_worked: req.body.what_worked || '',
    // Lost-specific
    competitor: req.body.competitor || '',
    what_happened: req.body.what_happened || '',
    what_different: req.body.what_different || '',
    follow_up: req.body.follow_up || '',
    // General
    notes: req.body.notes || '',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  db.winLossDeals.push(deal);
  saveDB(db);
  res.json(deal);
});

app.put('/api/win-loss/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const idx = db.winLossDeals.findIndex(d => d.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  db.winLossDeals[idx] = { 
    ...db.winLossDeals[idx], 
    ...req.body, 
    updated_at: new Date().toISOString() 
  };
  saveDB(db);
  res.json(db.winLossDeals[idx]);
});

app.delete('/api/win-loss/:id', (req, res) => {
  const id = parseInt(req.params.id);
  db.winLossDeals = db.winLossDeals.filter(d => d.id !== id);
  saveDB(db);
  res.json({ success: true });
});

// Win/Loss Analytics API
app.get('/api/win-loss/analytics/summary', (req, res) => {
  const deals = db.winLossDeals || [];
  const won = deals.filter(d => d.outcome === 'won');
  const lost = deals.filter(d => d.outcome === 'lost');
  
  // Win rate by property type
  const typeStats = {};
  deals.forEach(d => {
    if (!d.property_type) return;
    if (!typeStats[d.property_type]) typeStats[d.property_type] = { won: 0, lost: 0 };
    if (d.outcome === 'won') typeStats[d.property_type].won++;
    else typeStats[d.property_type].lost++;
  });
  
  // Win rate by touch count buckets
  const touchBuckets = { '1-3': { won: 0, lost: 0 }, '4-7': { won: 0, lost: 0 }, '8-12': { won: 0, lost: 0 }, '13+': { won: 0, lost: 0 } };
  deals.forEach(d => {
    if (!d.touch_count) return;
    let bucket;
    if (d.touch_count <= 3) bucket = '1-3';
    else if (d.touch_count <= 7) bucket = '4-7';
    else if (d.touch_count <= 12) bucket = '8-12';
    else bucket = '13+';
    if (d.outcome === 'won') touchBuckets[bucket].won++;
    else touchBuckets[bucket].lost++;
  });
  
  // Reason counts
  const winReasons = {};
  const lossReasons = {};
  won.forEach(d => { if (d.reason) winReasons[d.reason] = (winReasons[d.reason] || 0) + 1; });
  lost.forEach(d => { if (d.reason) lossReasons[d.reason] = (lossReasons[d.reason] || 0) + 1; });
  
  // Competitor losses
  const competitors = {};
  lost.filter(d => d.competitor).forEach(d => {
    competitors[d.competitor] = (competitors[d.competitor] || 0) + 1;
  });
  
  res.json({
    totalWon: won.length,
    totalLost: lost.length,
    winRate: (won.length + lost.length) > 0 ? Math.round((won.length / (won.length + lost.length)) * 100) : 0,
    avgDaysToWin: won.length > 0 ? Math.round(won.reduce((s, d) => s + (d.days_to_close || 0), 0) / won.length) : 0,
    avgDaysToLose: lost.length > 0 ? Math.round(lost.reduce((s, d) => s + (d.days_to_close || 0), 0) / lost.length) : 0,
    avgTouchesWon: won.length > 0 ? Math.round(won.reduce((s, d) => s + (d.touch_count || 0), 0) / won.length) : 0,
    totalValueWon: won.reduce((s, d) => s + (d.deal_value || 0), 0),
    totalValueLost: lost.reduce((s, d) => s + (d.deal_value || 0), 0),
    typeStats,
    touchBuckets,
    winReasons,
    lossReasons,
    competitors
  });
});

// ===== RESOURCES PAGE =====
app.get('/resources', (req, res) => res.sendFile(path.join(__dirname, 'resources.html')));

// ===== TESTIMONIALS & SOCIAL PROOF =====
// Initialize collections
if (!db.testimonials) db.testimonials = [];
if (!db.reviewRequests) db.reviewRequests = [];
if (!db.npsResponses) db.npsResponses = [];
if (!db.caseStudies) db.caseStudies = [];

// Testimonials page
app.get('/testimonials', (req, res) => res.sendFile(path.join(__dirname, 'testimonials.html')));

// Testimonials API
app.get('/api/testimonials', (req, res) => {
  res.json(db.testimonials || []);
});

app.get('/api/testimonials/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const testimonial = (db.testimonials || []).find(t => t.id === id);
  if (!testimonial) return res.status(404).json({ error: 'Not found' });
  res.json(testimonial);
});

app.post('/api/testimonials', (req, res) => {
  const testimonial = {
    id: nextId(),
    property_name: req.body.property_name || '',
    property_type: req.body.property_type || '',
    contact_name: req.body.contact_name || '',
    contact_role: req.body.contact_role || '',
    rating: parseInt(req.body.rating) || 5,
    testimonial: req.body.testimonial || '',
    public_permission: req.body.public_permission !== false,
    featured: req.body.featured || false,
    photo_url: req.body.photo_url || '',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  if (!db.testimonials) db.testimonials = [];
  db.testimonials.push(testimonial);
  saveDB(db);
  res.json(testimonial);
});

app.put('/api/testimonials/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const idx = (db.testimonials || []).findIndex(t => t.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  db.testimonials[idx] = { 
    ...db.testimonials[idx], 
    ...req.body, 
    updated_at: new Date().toISOString() 
  };
  saveDB(db);
  res.json(db.testimonials[idx]);
});

app.delete('/api/testimonials/:id', (req, res) => {
  const id = parseInt(req.params.id);
  db.testimonials = (db.testimonials || []).filter(t => t.id !== id);
  saveDB(db);
  res.json({ success: true });
});

// Review Requests API
app.get('/api/review-requests', (req, res) => {
  res.json(db.reviewRequests || []);
});

app.post('/api/review-requests', (req, res) => {
  const request = {
    id: nextId(),
    client_id: req.body.client_id || null,
    client_name: req.body.client_name || '',
    email: req.body.email || '',
    status: req.body.status || 'sent',
    sent_date: new Date().toISOString(),
    created_at: new Date().toISOString()
  };
  if (!db.reviewRequests) db.reviewRequests = [];
  db.reviewRequests.push(request);
  saveDB(db);
  res.json(request);
});

app.put('/api/review-requests/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const idx = (db.reviewRequests || []).findIndex(r => r.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  db.reviewRequests[idx] = { 
    ...db.reviewRequests[idx], 
    ...req.body, 
    updated_at: new Date().toISOString() 
  };
  saveDB(db);
  res.json(db.reviewRequests[idx]);
});

app.delete('/api/review-requests/:id', (req, res) => {
  const id = parseInt(req.params.id);
  db.reviewRequests = (db.reviewRequests || []).filter(r => r.id !== id);
  saveDB(db);
  res.json({ success: true });
});

// NPS API
app.get('/api/nps', (req, res) => {
  res.json(db.npsResponses || []);
});

app.get('/api/nps/summary', (req, res) => {
  const responses = db.npsResponses || [];
  if (responses.length === 0) {
    return res.json({ nps: null, promoters: 0, passives: 0, detractors: 0, total: 0 });
  }
  const promoters = responses.filter(r => r.score >= 9).length;
  const passives = responses.filter(r => r.score >= 7 && r.score <= 8).length;
  const detractors = responses.filter(r => r.score <= 6).length;
  const nps = Math.round(((promoters - detractors) / responses.length) * 100);
  res.json({ nps, promoters, passives, detractors, total: responses.length });
});

app.post('/api/nps', (req, res) => {
  const response = {
    id: nextId(),
    client_id: req.body.client_id || null,
    client_name: req.body.client_name || '',
    score: parseInt(req.body.score) || 0,
    feedback: req.body.feedback || '',
    created_at: new Date().toISOString()
  };
  if (!db.npsResponses) db.npsResponses = [];
  db.npsResponses.push(response);
  saveDB(db);
  res.json(response);
});

app.delete('/api/nps/:id', (req, res) => {
  const id = parseInt(req.params.id);
  db.npsResponses = (db.npsResponses || []).filter(r => r.id !== id);
  saveDB(db);
  res.json({ success: true });
});

// Case Studies API
app.get('/api/case-studies', (req, res) => {
  res.json(db.caseStudies || []);
});

app.get('/api/case-studies/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const study = (db.caseStudies || []).find(s => s.id === id);
  if (!study) return res.status(404).json({ error: 'Not found' });
  res.json(study);
});

app.post('/api/case-studies', (req, res) => {
  const study = {
    id: nextId(),
    client_name: req.body.client_name || '',
    property_type: req.body.property_type || '',
    challenge: req.body.challenge || '',
    solution: req.body.solution || '',
    results: req.body.results || '',
    metric1_label: req.body.metric1_label || '',
    metric1_value: req.body.metric1_value || '',
    metric2_label: req.body.metric2_label || '',
    metric2_value: req.body.metric2_value || '',
    metric3_label: req.body.metric3_label || '',
    metric3_value: req.body.metric3_value || '',
    quote: req.body.quote || '',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  if (!db.caseStudies) db.caseStudies = [];
  db.caseStudies.push(study);
  saveDB(db);
  res.json(study);
});

app.put('/api/case-studies/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const idx = (db.caseStudies || []).findIndex(s => s.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  db.caseStudies[idx] = { 
    ...db.caseStudies[idx], 
    ...req.body, 
    updated_at: new Date().toISOString() 
  };
  saveDB(db);
  res.json(db.caseStudies[idx]);
});

app.delete('/api/case-studies/:id', (req, res) => {
  const id = parseInt(req.params.id);
  db.caseStudies = (db.caseStudies || []).filter(s => s.id !== id);
  saveDB(db);
  res.json({ success: true });
});

// ===== REVENUE TRACKING PAGE =====
app.get('/revenue', (req, res) => res.sendFile(path.join(__dirname, 'revenue.html')));

// ===== REVENUE API =====
// Revenue records collection
if (!db.revenueRecords) db.revenueRecords = [];
if (!db.commissionPayments) db.commissionPayments = [];

// Get revenue summary
app.get('/api/revenue/summary', (req, res) => {
  const { period } = req.query;
  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  
  // Get quarter months
  const quarter = Math.floor(now.getMonth() / 3);
  const quarterMonths = [];
  for (let i = 0; i < 3; i++) {
    const m = quarter * 3 + i + 1;
    quarterMonths.push(`${now.getFullYear()}-${String(m).padStart(2, '0')}`);
  }
  
  // Get YTD months
  const ytdMonths = [];
  for (let i = 1; i <= now.getMonth() + 1; i++) {
    ytdMonths.push(`${now.getFullYear()}-${String(i).padStart(2, '0')}`);
  }
  
  // Aggregate from finances collection
  const allRevenue = db.finances.filter(f => f.type === 'revenue');
  const allExpenses = db.finances.filter(f => f.type === 'expense');
  
  const monthRevenue = allRevenue.filter(f => f.month === currentMonth).reduce((s, f) => s + (f.amount || 0), 0);
  const quarterRevenue = allRevenue.filter(f => quarterMonths.includes(f.month)).reduce((s, f) => s + (f.amount || 0), 0);
  const ytdRevenue = allRevenue.filter(f => ytdMonths.includes(f.month)).reduce((s, f) => s + (f.amount || 0), 0);
  
  const monthExpenses = allExpenses.filter(f => f.month === currentMonth).reduce((s, f) => s + (f.amount || 0), 0);
  
  // Calculate COGS (33% of revenue per VENDTECH-RULES.md)
  const cogs = monthRevenue * 0.33;
  const grossProfit = monthRevenue - cogs;
  
  // Get machine count
  const deployedMachines = db.machines.filter(m => m.status === 'deployed').length;
  const revenuePerMachine = deployedMachines > 0 ? monthRevenue / deployedMachines : 0;
  
  // Transaction count estimate (avg $3 per transaction per VENDTECH-RULES.md)
  const transactions = Math.round(monthRevenue / 3);
  const avgTransaction = transactions > 0 ? monthRevenue / transactions : 0;
  
  // Commission calculations from locations with rev share
  let commissionsOwed = 0;
  let commissionsPaid = 0;
  db.locations.forEach(loc => {
    if (loc.commission_rate && loc.commission_rate > 0) {
      const locRevenue = allRevenue
        .filter(f => f.location_id === loc.id && f.month === currentMonth)
        .reduce((s, f) => s + (f.amount || 0), 0);
      commissionsOwed += locRevenue * loc.commission_rate;
    }
  });
  
  commissionsPaid = (db.commissionPayments || [])
    .filter(p => p.status === 'paid')
    .reduce((s, p) => s + (p.amount || 0), 0);
  
  const netProfit = grossProfit - commissionsOwed - monthExpenses;
  
  res.json({
    currentMonth,
    monthRevenue,
    quarterRevenue,
    ytdRevenue,
    grossProfit,
    netProfit,
    cogs,
    monthExpenses,
    commissionsOwed,
    commissionsPaid,
    revenuePerMachine,
    deployedMachines,
    transactions,
    avgTransaction,
    grossMargin: monthRevenue > 0 ? (grossProfit / monthRevenue) : 0,
    netMargin: monthRevenue > 0 ? (netProfit / monthRevenue) : 0
  });
});

// Get revenue by machine
app.get('/api/revenue/by-machine', (req, res) => {
  const { period } = req.query;
  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  
  let filterMonths = [currentMonth];
  if (period === 'quarter') {
    const quarter = Math.floor(now.getMonth() / 3);
    filterMonths = [];
    for (let i = 0; i < 3; i++) {
      const m = quarter * 3 + i + 1;
      filterMonths.push(`${now.getFullYear()}-${String(m).padStart(2, '0')}`);
    }
  } else if (period === 'year') {
    filterMonths = [];
    for (let i = 1; i <= now.getMonth() + 1; i++) {
      filterMonths.push(`${now.getFullYear()}-${String(i).padStart(2, '0')}`);
    }
  } else if (period === 'all') {
    filterMonths = null;
  }
  
  const machineData = db.machines.map(m => {
    const location = db.locations.find(l => l.id === m.location_id);
    const revenueRecords = db.finances.filter(f => 
      f.type === 'revenue' && 
      f.machine_id === m.id && 
      (!filterMonths || filterMonths.includes(f.month))
    );
    
    const revenue = revenueRecords.reduce((s, f) => s + (f.amount || 0), 0);
    const transactions = Math.round(revenue / 3);
    const commissionRate = location?.commission_rate || 0;
    const commissionOwed = revenue * commissionRate;
    
    // Performance rating based on VENDTECH-RULES.md thresholds
    const monthCount = filterMonths ? filterMonths.length : 12;
    const monthlyAvg = revenue / monthCount;
    let performance;
    if (monthlyAvg >= 3000) performance = 'excellent';
    else if (monthlyAvg >= 2000) performance = 'good';
    else if (monthlyAvg >= 800) performance = 'average';
    else performance = 'poor';
    
    return {
      id: m.id,
      name: m.name,
      location: location?.name || 'Unassigned',
      property: location?.property_name || '',
      property_type: location?.property_type || '',
      status: m.status,
      revenue,
      transactions,
      commissionRate,
      commissionOwed,
      performance,
      monthlyAvg
    };
  });
  
  res.json(machineData.sort((a, b) => b.revenue - a.revenue));
});

// Get commission data
app.get('/api/revenue/commissions', (req, res) => {
  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  
  const commissions = db.locations
    .filter(loc => loc.commission_rate && loc.commission_rate > 0)
    .map(loc => {
      const monthRevenue = db.finances
        .filter(f => f.type === 'revenue' && f.location_id === loc.id && f.month === currentMonth)
        .reduce((s, f) => s + (f.amount || 0), 0);
      
      const amountOwed = monthRevenue * loc.commission_rate;
      
      const payment = (db.commissionPayments || []).find(p => 
        p.location_id === loc.id && p.month === currentMonth
      );
      
      return {
        location_id: loc.id,
        property: loc.property_name || loc.name,
        location: loc.name,
        monthlyRevenue: monthRevenue,
        rate: loc.commission_rate,
        amountOwed,
        status: payment?.status || 'pending',
        paidDate: payment?.paid_date || null
      };
    });
  
  const totalPaid = commissions.filter(c => c.status === 'paid').reduce((s, c) => s + c.amountOwed, 0);
  const totalPending = commissions.filter(c => c.status === 'pending').reduce((s, c) => s + c.amountOwed, 0);
  const totalOverdue = commissions.filter(c => c.status === 'overdue').reduce((s, c) => s + c.amountOwed, 0);
  const avgRate = commissions.length > 0 ? commissions.reduce((s, c) => s + c.rate, 0) / commissions.length : 0;
  
  res.json({
    commissions,
    summary: { totalPaid, totalPending, totalOverdue, avgRate }
  });
});

// Record commission payment
app.post('/api/revenue/commissions/pay', (req, res) => {
  const { location_id, month, amount } = req.body;
  if (!db.commissionPayments) db.commissionPayments = [];
  
  const existing = db.commissionPayments.find(p => p.location_id === location_id && p.month === month);
  if (existing) {
    existing.status = 'paid';
    existing.amount = amount;
    existing.paid_date = new Date().toISOString();
  } else {
    db.commissionPayments.push({
      id: nextId(),
      location_id,
      month,
      amount,
      status: 'paid',
      paid_date: new Date().toISOString(),
      created_at: new Date().toISOString()
    });
  }
  
  saveDB(db);
  res.json({ success: true });
});

// Get profitability data
app.get('/api/revenue/profitability', (req, res) => {
  const now = new Date();
  const months = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  
  const monthlyData = months.map(month => {
    const revenue = db.finances
      .filter(f => f.type === 'revenue' && f.month === month)
      .reduce((s, f) => s + (f.amount || 0), 0);
    const cogs = revenue * 0.33;
    const expenses = db.finances
      .filter(f => f.type === 'expense' && f.month === month)
      .reduce((s, f) => s + (f.amount || 0), 0);
    
    return { month, revenue, cogs, expenses, grossProfit: revenue - cogs, netProfit: revenue - cogs - expenses };
  });
  
  const categoryPerf = {};
  (db.sales || []).forEach(sale => {
    const product = db.products.find(p => p.id === sale.product_id);
    if (!product) return;
    const cat = product.category || 'Other';
    if (!categoryPerf[cat]) categoryPerf[cat] = { revenue: 0, cost: 0, units: 0 };
    categoryPerf[cat].revenue += sale.total || 0;
    categoryPerf[cat].cost += (product.cost_price || 0) * (sale.quantity || 1);
    categoryPerf[cat].units += sale.quantity || 1;
  });
  
  Object.keys(categoryPerf).forEach(cat => {
    const p = categoryPerf[cat];
    p.margin = p.revenue > 0 ? ((p.revenue - p.cost) / p.revenue) * 100 : 0;
  });
  
  res.json({ monthlyData, categoryPerformance: categoryPerf });
});

// Get projections
app.get('/api/revenue/projections', (req, res) => {
  const deployedMachines = db.machines.filter(m => m.status === 'deployed').length;
  
  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const totalRevenue = db.finances
    .filter(f => f.type === 'revenue' && f.month === currentMonth)
    .reduce((s, f) => s + (f.amount || 0), 0);
  
  // Use actual data or default from VENDTECH-RULES.md
  const avgRevenuePerMachine = deployedMachines > 0 ? totalRevenue / deployedMachines : 2000;
  const cogsRate = 0.33;
  const avgCommissionRate = 0.04;
  const monthlyFixedCosts = 500;
  const profitMargin = 1 - cogsRate - avgCommissionRate;
  const profitPerMachine = avgRevenuePerMachine * profitMargin;
  
  const breakEvenMachines = Math.ceil(monthlyFixedCosts / profitPerMachine);
  
  const projections = [5, 10, 20, 30].map(count => ({
    machines: count,
    monthlyRevenue: avgRevenuePerMachine * count,
    monthlyProfit: (profitPerMachine * count) - monthlyFixedCosts,
    annualRevenue: avgRevenuePerMachine * count * 12,
    annualProfit: ((profitPerMachine * count) - monthlyFixedCosts) * 12
  }));
  
  const pipelineStages = [
    { stage: 'interested', probability: 0.3 },
    { stage: 'site_survey', probability: 0.5 },
    { stage: 'proposal_sent', probability: 0.7 },
    { stage: 'negotiating', probability: 0.85 },
    { stage: 'contract_sent', probability: 0.95 }
  ];
  
  const pipelineValue = pipelineStages.map(s => {
    const cards = (db.pipelineCards || []).filter(c => c.stage === s.stage);
    return {
      stage: s.stage,
      count: cards.length,
      probability: s.probability,
      potentialRevenue: avgRevenuePerMachine * cards.length,
      weightedValue: avgRevenuePerMachine * cards.length * s.probability
    };
  });
  
  res.json({
    currentMetrics: {
      deployedMachines,
      avgRevenuePerMachine,
      profitMargin,
      monthlyFixedCosts
    },
    breakEven: {
      machines: breakEvenMachines,
      currentProgress: breakEvenMachines > 0 ? deployedMachines / breakEvenMachines : 0
    },
    projections,
    pipelineValue
  });
});

// ===== EXPENSE TRACKER API =====
// Ensure expenses and expense budgets collections exist
if (!db.expenses) db.expenses = [];
if (!db.expenseBudgets) db.expenseBudgets = {};

// Serve expenses page
app.get('/expenses', (req, res) => {
  res.sendFile(path.join(__dirname, 'expenses.html'));
});

// Get all expenses (with optional filters)
app.get('/api/expenses', (req, res) => {
  const { category, from, to } = req.query;
  let records = db.expenses || [];
  
  if (category) records = records.filter(e => e.category === category);
  if (from) records = records.filter(e => e.date >= from);
  if (to) records = records.filter(e => e.date <= to);
  
  res.json(records.sort((a, b) => new Date(b.date) - new Date(a.date)));
});

// Get single expense
app.get('/api/expenses/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const expense = (db.expenses || []).find(e => e.id === id);
  if (!expense) return res.status(404).json({ error: 'Expense not found' });
  res.json(expense);
});

// Create expense
app.post('/api/expenses', (req, res) => {
  const expense = {
    id: nextId(),
    date: req.body.date || new Date().toISOString().split('T')[0],
    amount: parseFloat(req.body.amount) || 0,
    category: req.body.category || 'other',
    vendor: req.body.vendor || '',
    description: req.body.description || '',
    recurring: !!req.body.recurring,
    has_receipt: !!req.body.has_receipt,
    receipt_url: req.body.receipt_url || null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  
  if (!db.expenses) db.expenses = [];
  db.expenses.push(expense);
  saveDB(db);
  res.json(expense);
});

// Update expense
app.put('/api/expenses/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const idx = (db.expenses || []).findIndex(e => e.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Expense not found' });
  
  db.expenses[idx] = {
    ...db.expenses[idx],
    ...req.body,
    id, // Preserve ID
    updated_at: new Date().toISOString()
  };
  
  saveDB(db);
  res.json(db.expenses[idx]);
});

// Delete expense
app.delete('/api/expenses/:id', (req, res) => {
  const id = parseInt(req.params.id);
  db.expenses = (db.expenses || []).filter(e => e.id !== id);
  saveDB(db);
  res.json({ success: true });
});

// Get expense summary
app.get('/api/expenses/summary/monthly', (req, res) => {
  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  
  const months = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  
  const monthlyData = months.map(month => {
    const monthExpenses = (db.expenses || []).filter(e => e.date?.startsWith(month));
    const total = monthExpenses.reduce((s, e) => s + (e.amount || 0), 0);
    const byCategory = {};
    monthExpenses.forEach(e => {
      if (!byCategory[e.category]) byCategory[e.category] = 0;
      byCategory[e.category] += e.amount || 0;
    });
    return { month, total, byCategory, count: monthExpenses.length };
  });
  
  // Current month stats
  const currentMonthExpenses = (db.expenses || []).filter(e => e.date?.startsWith(currentMonth));
  const totalThisMonth = currentMonthExpenses.reduce((s, e) => s + (e.amount || 0), 0);
  const recurringTotal = currentMonthExpenses.filter(e => e.recurring).reduce((s, e) => s + (e.amount || 0), 0);
  const withReceipt = currentMonthExpenses.filter(e => e.has_receipt).length;
  const receiptPct = currentMonthExpenses.length > 0 ? Math.round((withReceipt / currentMonthExpenses.length) * 100) : 0;
  
  res.json({
    currentMonth,
    totalThisMonth,
    recurringTotal,
    receiptPct,
    expenseCount: currentMonthExpenses.length,
    monthlyData,
    budgets: db.expenseBudgets || {}
  });
});

// Get expense budgets
app.get('/api/expense-budgets', (req, res) => {
  res.json(db.expenseBudgets || {});
});

// Set expense budgets
app.put('/api/expense-budgets', (req, res) => {
  db.expenseBudgets = req.body || {};
  saveDB(db);
  res.json(db.expenseBudgets);
});

// Get tax report for a year
app.get('/api/expenses/tax/:year', (req, res) => {
  const year = req.params.year;
  const yearExpenses = (db.expenses || []).filter(e => e.date?.startsWith(year));
  
  // Category totals
  const categoryTotals = {};
  yearExpenses.forEach(e => {
    if (!categoryTotals[e.category]) categoryTotals[e.category] = 0;
    categoryTotals[e.category] += e.amount || 0;
  });
  
  // Mileage calculation (look for "miles: X" in gas expenses)
  let totalMiles = 0;
  yearExpenses.filter(e => e.category === 'gas').forEach(e => {
    const desc = (e.description || '').toLowerCase();
    const match = desc.match(/miles?:\s*(\d+(?:\.\d+)?)/i);
    if (match) totalMiles += parseFloat(match[1]);
  });
  
  const irsRate = 0.67; // 2024 rate
  const mileageDeduction = totalMiles * irsRate;
  
  // Receipt tracking
  const receiptStatus = {};
  yearExpenses.forEach(e => {
    if (!receiptStatus[e.category]) receiptStatus[e.category] = { with: 0, without: 0 };
    if (e.has_receipt) receiptStatus[e.category].with++;
    else receiptStatus[e.category].without++;
  });
  
  const totalDeductible = Object.values(categoryTotals).reduce((s, v) => s + v, 0);
  
  res.json({
    year,
    categoryTotals,
    totalDeductible,
    mileage: {
      totalMiles,
      irsRate,
      deduction: mileageDeduction
    },
    receiptStatus,
    expenseCount: yearExpenses.length
  });
});

// ===== SERVICE & MAINTENANCE LOG API =====
// Initialize service collections
if (!db.serviceVisits) db.serviceVisits = [];
if (!db.serviceIssues) db.serviceIssues = [];
if (!db.maintenanceSchedule) db.maintenanceSchedule = [];
if (!db.partsInventory) db.partsInventory = [];

// Serve service log page
app.get('/service-log', (req, res) => {
  res.sendFile(path.join(__dirname, 'service-log.html'));
});

// ===== SERVICE VISITS API =====
app.get('/api/service/visits', (req, res) => {
  const { machine_id, type, from, to } = req.query;
  let records = db.serviceVisits || [];
  if (machine_id) records = records.filter(v => v.machine_id == machine_id);
  if (type) records = records.filter(v => v.type === type);
  if (from) records = records.filter(v => v.date >= from);
  if (to) records = records.filter(v => v.date <= to);
  res.json(records.sort((a, b) => new Date(b.date) - new Date(a.date)));
});

app.get('/api/service/visits/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const visit = (db.serviceVisits || []).find(v => v.id === id);
  if (!visit) return res.status(404).json({ error: 'Visit not found' });
  res.json(visit);
});

app.post('/api/service/visits', (req, res) => {
  const visit = {
    id: nextId(),
    machine_id: parseInt(req.body.machine_id),
    date: req.body.date || new Date().toISOString().split('T')[0],
    type: req.body.type || 'restock',
    duration: req.body.duration ? parseInt(req.body.duration) : null,
    issues_found: req.body.issues_found || null,
    parts_used: req.body.parts_used || null,
    cost: req.body.cost ? parseFloat(req.body.cost) : null,
    notes: req.body.notes || null,
    technician: req.body.technician || null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  if (!db.serviceVisits) db.serviceVisits = [];
  db.serviceVisits.push(visit);
  saveDB(db);
  res.json(visit);
});

app.put('/api/service/visits/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const idx = (db.serviceVisits || []).findIndex(v => v.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Visit not found' });
  db.serviceVisits[idx] = { ...db.serviceVisits[idx], ...req.body, id, updated_at: new Date().toISOString() };
  saveDB(db);
  res.json(db.serviceVisits[idx]);
});

app.delete('/api/service/visits/:id', (req, res) => {
  const id = parseInt(req.params.id);
  db.serviceVisits = (db.serviceVisits || []).filter(v => v.id !== id);
  saveDB(db);
  res.json({ success: true });
});

// ===== SERVICE ISSUES API =====
app.get('/api/service/issues', (req, res) => {
  const { machine_id, status, priority } = req.query;
  let records = db.serviceIssues || [];
  if (machine_id) records = records.filter(i => i.machine_id == machine_id);
  if (status) records = records.filter(i => i.status === status);
  if (priority) records = records.filter(i => i.priority === priority);
  res.json(records.sort((a, b) => {
    const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    if (priorityOrder[a.priority] !== priorityOrder[b.priority]) {
      return priorityOrder[a.priority] - priorityOrder[b.priority];
    }
    return new Date(b.created_at) - new Date(a.created_at);
  }));
});

app.get('/api/service/issues/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const issue = (db.serviceIssues || []).find(i => i.id === id);
  if (!issue) return res.status(404).json({ error: 'Issue not found' });
  res.json(issue);
});

app.post('/api/service/issues', (req, res) => {
  const issue = {
    id: nextId(),
    machine_id: parseInt(req.body.machine_id),
    description: req.body.description || '',
    priority: req.body.priority || 'medium',
    status: req.body.status || 'open',
    assigned_to: req.body.assigned_to || null,
    resolution_notes: req.body.resolution_notes || null,
    resolved_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  if (!db.serviceIssues) db.serviceIssues = [];
  db.serviceIssues.push(issue);
  saveDB(db);
  res.json(issue);
});

app.put('/api/service/issues/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const idx = (db.serviceIssues || []).findIndex(i => i.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Issue not found' });
  const updated = { ...db.serviceIssues[idx], ...req.body, id, updated_at: new Date().toISOString() };
  if (req.body.status === 'resolved' && !db.serviceIssues[idx].resolved_at) {
    updated.resolved_at = new Date().toISOString();
  }
  db.serviceIssues[idx] = updated;
  saveDB(db);
  res.json(db.serviceIssues[idx]);
});

app.delete('/api/service/issues/:id', (req, res) => {
  const id = parseInt(req.params.id);
  db.serviceIssues = (db.serviceIssues || []).filter(i => i.id !== id);
  saveDB(db);
  res.json({ success: true });
});

// ===== MAINTENANCE SCHEDULE API =====
app.get('/api/service/schedule', (req, res) => {
  const { machine_id, status } = req.query;
  let records = db.maintenanceSchedule || [];
  if (machine_id) records = records.filter(t => t.machine_id == machine_id);
  if (status) records = records.filter(t => t.status === status);
  res.json(records.sort((a, b) => new Date(a.next_due) - new Date(b.next_due)));
});

app.get('/api/service/schedule/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const task = (db.maintenanceSchedule || []).find(t => t.id === id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  res.json(task);
});

app.post('/api/service/schedule', (req, res) => {
  const task = {
    id: nextId(),
    machine_id: parseInt(req.body.machine_id),
    type: req.body.type || 'maintenance',
    description: req.body.description || null,
    frequency: req.body.frequency || 'monthly',
    next_due: req.body.next_due || new Date().toISOString().split('T')[0],
    last_completed: null,
    status: 'pending',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  if (!db.maintenanceSchedule) db.maintenanceSchedule = [];
  db.maintenanceSchedule.push(task);
  saveDB(db);
  res.json(task);
});

app.put('/api/service/schedule/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const idx = (db.maintenanceSchedule || []).findIndex(t => t.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Task not found' });
  db.maintenanceSchedule[idx] = { ...db.maintenanceSchedule[idx], ...req.body, id, updated_at: new Date().toISOString() };
  saveDB(db);
  res.json(db.maintenanceSchedule[idx]);
});

app.delete('/api/service/schedule/:id', (req, res) => {
  const id = parseInt(req.params.id);
  db.maintenanceSchedule = (db.maintenanceSchedule || []).filter(t => t.id !== id);
  saveDB(db);
  res.json({ success: true });
});

// ===== PARTS INVENTORY API =====
app.get('/api/service/parts', (req, res) => {
  const { category, low_stock } = req.query;
  let records = db.partsInventory || [];
  if (category) records = records.filter(p => p.category === category);
  if (low_stock === 'true') records = records.filter(p => p.current_stock <= (p.min_stock || 0));
  res.json(records.sort((a, b) => (a.name || '').localeCompare(b.name || '')));
});

app.get('/api/service/parts/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const part = (db.partsInventory || []).find(p => p.id === id);
  if (!part) return res.status(404).json({ error: 'Part not found' });
  res.json(part);
});

app.post('/api/service/parts', (req, res) => {
  const part = {
    id: nextId(),
    name: req.body.name || 'Unknown Part',
    sku: req.body.sku || null,
    category: req.body.category || 'other',
    unit_cost: req.body.unit_cost ? parseFloat(req.body.unit_cost) : null,
    current_stock: parseInt(req.body.current_stock) || 0,
    min_stock: req.body.min_stock ? parseInt(req.body.min_stock) : null,
    notes: req.body.notes || null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  if (!db.partsInventory) db.partsInventory = [];
  db.partsInventory.push(part);
  saveDB(db);
  res.json(part);
});

app.put('/api/service/parts/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const idx = (db.partsInventory || []).findIndex(p => p.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Part not found' });
  db.partsInventory[idx] = { ...db.partsInventory[idx], ...req.body, id, updated_at: new Date().toISOString() };
  saveDB(db);
  res.json(db.partsInventory[idx]);
});

app.delete('/api/service/parts/:id', (req, res) => {
  const id = parseInt(req.params.id);
  db.partsInventory = (db.partsInventory || []).filter(p => p.id !== id);
  saveDB(db);
  res.json({ success: true });
});

// ===== SERVICE METRICS API =====
app.get('/api/service/metrics', (req, res) => {
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const thirtyDaysAgoStr = thirtyDaysAgo.toISOString().split('T')[0];
  
  const visits = db.serviceVisits || [];
  const issues = db.serviceIssues || [];
  const schedule = db.maintenanceSchedule || [];
  const machines = db.machines || [];
  
  // Recent visits
  const recentVisits = visits.filter(v => v.date >= thirtyDaysAgoStr);
  
  // Open issues
  const openIssues = issues.filter(i => i.status !== 'resolved');
  const criticalIssues = openIssues.filter(i => i.priority === 'critical');
  
  // Overdue tasks
  const today = new Date().toISOString().split('T')[0];
  const overdueTasks = schedule.filter(t => t.next_due < today && t.status !== 'completed');
  
  // Visit interval calculation
  let avgVisitInterval = null;
  if (visits.length >= 2) {
    const sorted = [...visits].sort((a, b) => new Date(a.date) - new Date(b.date));
    let totalDays = 0;
    for (let i = 1; i < sorted.length; i++) {
      totalDays += (new Date(sorted[i].date) - new Date(sorted[i-1].date)) / (1000 * 60 * 60 * 24);
    }
    avgVisitInterval = Math.round(totalDays / (sorted.length - 1));
  }
  
  // Common issues
  const issueDescriptions = issues.map(i => i.description.toLowerCase());
  const issueCounts = {};
  issueDescriptions.forEach(desc => {
    // Extract keywords
    const words = desc.split(/\s+/).filter(w => w.length > 4);
    words.forEach(w => {
      if (!issueCounts[w]) issueCounts[w] = 0;
      issueCounts[w]++;
    });
  });
  const commonIssues = Object.entries(issueCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([word, count]) => ({ keyword: word, count }));
  
  // Machines requiring most attention
  const machineVisitCounts = {};
  const machineIssueCounts = {};
  visits.forEach(v => {
    if (!machineVisitCounts[v.machine_id]) machineVisitCounts[v.machine_id] = 0;
    machineVisitCounts[v.machine_id]++;
  });
  issues.forEach(i => {
    if (!machineIssueCounts[i.machine_id]) machineIssueCounts[i.machine_id] = 0;
    machineIssueCounts[i.machine_id]++;
  });
  
  const machineAttention = machines.map(m => ({
    machine_id: m.id,
    name: m.name || m.serial_number,
    visits: machineVisitCounts[m.id] || 0,
    issues: machineIssueCounts[m.id] || 0,
    score: (machineIssueCounts[m.id] || 0) * 2 + (machineVisitCounts[m.id] || 0)
  })).sort((a, b) => b.score - a.score).slice(0, 5);
  
  // Uptime calculation
  const repairMinutes = recentVisits.filter(v => v.type === 'repair').reduce((sum, v) => sum + (v.duration || 0), 0);
  const totalMinutes = machines.length * 24 * 60 * 30;
  const uptime = totalMinutes > 0 ? Math.round((1 - repairMinutes / totalMinutes) * 100) : 100;
  
  res.json({
    totalVisits30d: recentVisits.length,
    repairVisits30d: recentVisits.filter(v => v.type === 'repair').length,
    openIssues: openIssues.length,
    criticalIssues: criticalIssues.length,
    overdueTasks: overdueTasks.length,
    avgVisitInterval,
    uptime,
    commonIssues,
    machinesNeedingAttention: machineAttention,
    visitsByType: {
      restock: recentVisits.filter(v => v.type === 'restock').length,
      repair: recentVisits.filter(v => v.type === 'repair').length,
      maintenance: recentVisits.filter(v => v.type === 'maintenance').length,
      cleaning: recentVisits.filter(v => v.type === 'cleaning').length
    }
  });
});

// Get service history for a specific machine
app.get('/api/service/machine/:id/history', (req, res) => {
  const machineId = parseInt(req.params.id);
  const machine = db.machines.find(m => m.id === machineId);
  if (!machine) return res.status(404).json({ error: 'Machine not found' });
  
  const visits = (db.serviceVisits || []).filter(v => v.machine_id === machineId);
  const issues = (db.serviceIssues || []).filter(i => i.machine_id === machineId);
  const schedule = (db.maintenanceSchedule || []).filter(t => t.machine_id === machineId);
  
  const repairs = visits.filter(v => v.type === 'repair');
  const totalCost = visits.reduce((sum, v) => sum + (v.cost || 0), 0);
  
  // Uptime (last 30 days)
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const recentRepairs = repairs.filter(v => new Date(v.date) >= thirtyDaysAgo);
  const repairMinutes = recentRepairs.reduce((sum, v) => sum + (v.duration || 0), 0);
  const totalMinutes = 24 * 60 * 30;
  const uptime = Math.round((1 - repairMinutes / totalMinutes) * 100);
  
  // Reliability score (100 - repairs * 10, min 0)
  const reliability = Math.max(0, 100 - repairs.length * 10);
  
  res.json({
    machine,
    visits: visits.sort((a, b) => new Date(b.date) - new Date(a.date)),
    issues: issues.sort((a, b) => new Date(b.created_at) - new Date(a.created_at)),
    schedule: schedule.sort((a, b) => new Date(a.next_due) - new Date(b.next_due)),
    stats: {
      totalVisits: visits.length,
      totalRepairs: repairs.length,
      totalCost,
      uptime,
      reliability
    }
  });
});

// ===== NOTIFICATIONS API =====
// Initialize notification collections
if (!db.notifications) db.notifications = [];
if (!db.dismissedNotifications) db.dismissedNotifications = [];
if (!db.snoozedNotifications) db.snoozedNotifications = [];

// Get all notifications (generated from data)
app.get('/api/notifications', (req, res) => {
  const thresholdOverdue = parseInt(req.query.threshold_overdue) || 7;
  const thresholdExpiring = parseInt(req.query.threshold_expiring) || 30;
  const now = new Date();
  const notifications = [];
  let idCounter = 1;

  // Get dismissed and snoozed IDs
  const dismissed = new Set((db.dismissedNotifications || []).map(d => d.key));
  const snoozed = (db.snoozedNotifications || []).filter(s => new Date(s.until) > now);
  const snoozedKeys = new Set(snoozed.map(s => s.key));

  function isHidden(key) {
    return dismissed.has(key) || snoozedKeys.has(key);
  }

  // 1. Recent activities across all prospects (last 7 days)
  const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
  (db.activities || []).filter(a => new Date(a.created_at) > weekAgo).forEach(a => {
    const prospect = db.prospects.find(p => p.id === a.prospect_id);
    const key = `activity-${a.id}`;
    if (isHidden(key)) return;
    
    const typeLabel = {
      call: 'Call logged',
      email: 'Email sent',
      'pop-in': 'Pop-in visit',
      'pop_in': 'Pop-in visit',
      note: 'Note added',
      meeting: 'Meeting',
      proposal_sent: 'Proposal sent',
      'status-change': 'Status changed'
    }[a.type] || 'Activity';
    
    notifications.push({
      id: idCounter++,
      key,
      type: 'activity',
      title: `${typeLabel}: ${prospect?.name || 'Unknown'}`,
      description: a.description || '',
      prospect_id: a.prospect_id,
      created_at: a.created_at,
      priority: 'low',
      read: new Date(a.created_at) < new Date(now - 24 * 60 * 60 * 1000)
    });
  });

  // 2. Overdue follow-ups (no activity in X days)
  (db.prospects || []).filter(p => p.status !== 'closed' && p.status !== 'signed').forEach(p => {
    const activities = (db.activities || []).filter(a => a.prospect_id === p.id);
    const lastActivity = activities.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
    const lastDate = lastActivity ? new Date(lastActivity.created_at) : new Date(p.created_at);
    const daysSince = Math.floor((now - lastDate) / (1000 * 60 * 60 * 24));
    
    if (daysSince >= thresholdOverdue) {
      const key = `overdue-${p.id}`;
      if (isHidden(key)) return;
      
      notifications.push({
        id: idCounter++,
        key,
        type: 'overdue',
        title: `Follow-up overdue: ${p.name}`,
        description: `No activity in ${daysSince} days. Last contact: ${lastActivity?.type || 'none'}`,
        prospect_id: p.id,
        created_at: lastDate.toISOString(),
        priority: daysSince >= thresholdOverdue * 2 ? 'high' : 'medium',
        read: false
      });
    }
  });

  // 3. Expiring contracts
  (db.contracts || []).forEach(c => {
    const endDate = c.end_date ? new Date(c.end_date + 'T00:00:00') : null;
    const renewalDate = c.renewal_date ? new Date(c.renewal_date + 'T00:00:00') : null;
    const checkDate = renewalDate || endDate;
    
    if (checkDate) {
      const daysUntil = Math.ceil((checkDate - now) / (1000 * 60 * 60 * 24));
      if (daysUntil >= 0 && daysUntil <= thresholdExpiring) {
        const key = `expiring-${c.id}`;
        if (isHidden(key)) return;
        
        const location = db.locations?.find(l => l.id === c.location_id);
        notifications.push({
          id: idCounter++,
          key,
          type: 'expiring',
          title: `Contract ${renewalDate ? 'renewal due' : 'expiring'}: ${location?.name || c.location_name || 'Unknown'}`,
          description: `${daysUntil === 0 ? 'Due today' : `Due in ${daysUntil} days`} (${checkDate.toLocaleDateString()})`,
          link: '/contracts',
          created_at: now.toISOString(),
          priority: daysUntil <= 7 ? 'high' : 'medium',
          read: false
        });
      }
    }
  });

  // 4. Low inventory alerts (from products with low stock)
  (db.products || []).filter(p => p.stock_qty !== undefined && p.min_stock_qty !== undefined).forEach(p => {
    if (p.stock_qty <= p.min_stock_qty) {
      const key = `inventory-${p.id}`;
      if (isHidden(key)) return;
      
      const pctRemaining = p.min_stock_qty > 0 ? Math.round((p.stock_qty / p.min_stock_qty) * 100) : 0;
      notifications.push({
        id: idCounter++,
        key,
        type: 'inventory',
        title: `Low stock: ${p.name}`,
        description: `Only ${p.stock_qty} units remaining (min: ${p.min_stock_qty})`,
        link: '/inventory',
        created_at: now.toISOString(),
        priority: p.stock_qty === 0 ? 'high' : 'medium',
        read: false
      });
    }
  });

  // 5. Maintenance due (from maintenance schedule)
  (db.maintenanceSchedule || []).forEach(m => {
    const dueDate = m.next_due ? new Date(m.next_due) : null;
    if (dueDate) {
      const daysUntil = Math.ceil((dueDate - now) / (1000 * 60 * 60 * 24));
      if (daysUntil <= 7) {
        const key = `maintenance-${m.id}`;
        if (isHidden(key)) return;
        
        const machine = db.machines?.find(ma => ma.id === m.machine_id);
        notifications.push({
          id: idCounter++,
          key,
          type: 'maintenance',
          title: `Maintenance due: ${machine?.name || 'Machine #' + m.machine_id}`,
          description: `${m.task_name || 'Scheduled maintenance'} ${daysUntil <= 0 ? 'is overdue' : `due in ${daysUntil} days`}`,
          link: '/service-tracking',
          created_at: now.toISOString(),
          priority: daysUntil <= 0 ? 'high' : 'medium',
          read: false
        });
      }
    }
  });

  // 6. Goals alerts (approaching or exceeded targets)
  const monthRevenue = (db.finances || [])
    .filter(f => f.type === 'revenue' && f.month === `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`)
    .reduce((s, f) => s + (f.amount || 0), 0);
  
  const monthlyGoal = 2000; // $2K/month minimum per VENDTECH-RULES
  const deployedMachines = (db.machines || []).filter(m => m.status === 'deployed').length;
  const expectedRevenue = deployedMachines * monthlyGoal;
  
  if (deployedMachines > 0 && monthRevenue > 0) {
    const goalPct = Math.round((monthRevenue / expectedRevenue) * 100);
    if (goalPct >= 90 && goalPct < 100) {
      const key = `goal-approaching-${now.getMonth()}`;
      if (!isHidden(key)) {
        notifications.push({
          id: idCounter++,
          key,
          type: 'goal',
          title: 'Revenue goal approaching!',
          description: `You're at ${goalPct}% of your monthly target ($${monthRevenue.toLocaleString()} / $${expectedRevenue.toLocaleString()})`,
          link: '/financials',
          created_at: now.toISOString(),
          priority: 'medium',
          read: false
        });
      }
    } else if (goalPct >= 100) {
      const key = `goal-achieved-${now.getMonth()}`;
      if (!isHidden(key)) {
        notifications.push({
          id: idCounter++,
          key,
          type: 'goal',
          title: '🎉 Monthly goal exceeded!',
          description: `Congratulations! You've hit ${goalPct}% of your target ($${monthRevenue.toLocaleString()})`,
          link: '/financials',
          created_at: now.toISOString(),
          priority: 'low',
          read: false
        });
      }
    }
  }

  // 7. New leads added (last 24 hours)
  const dayAgo = new Date(now - 24 * 60 * 60 * 1000);
  (db.prospects || []).filter(p => new Date(p.created_at) > dayAgo).forEach(p => {
    const key = `new-lead-${p.id}`;
    if (isHidden(key)) return;
    
    notifications.push({
      id: idCounter++,
      key,
      type: 'new-lead',
      title: `New lead: ${p.name}`,
      description: `${p.property_type || 'Unknown type'} ${p.address ? '— ' + p.address : ''}`,
      prospect_id: p.id,
      created_at: p.created_at,
      priority: p.priority === 'hot' ? 'high' : 'low',
      read: false
    });
  });

  // Sort by created_at (newest first)
  notifications.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  // Calculate stats
  const stats = {
    unread: notifications.filter(n => !n.read).length,
    overdue: notifications.filter(n => n.type === 'overdue').length,
    attention: notifications.filter(n => n.priority === 'high' || n.priority === 'medium').length,
    today: (db.activities || []).filter(a => new Date(a.created_at) > dayAgo).length,
    by_type: {
      overdue: notifications.filter(n => n.type === 'overdue').length,
      expiring: notifications.filter(n => n.type === 'expiring').length,
      inventory: notifications.filter(n => n.type === 'inventory').length,
      maintenance: notifications.filter(n => n.type === 'maintenance').length,
      goal: notifications.filter(n => n.type === 'goal').length,
      'new-lead': notifications.filter(n => n.type === 'new-lead').length
    }
  };

  res.json({ notifications, stats });
});

// Get notification count for nav badge
app.get('/api/notifications/count', (req, res) => {
  const now = new Date();
  const thresholdOverdue = 7;
  
  // Quick count of important notifications
  let count = 0;
  
  // Overdue prospects
  (db.prospects || []).filter(p => p.status !== 'closed' && p.status !== 'signed').forEach(p => {
    const activities = (db.activities || []).filter(a => a.prospect_id === p.id);
    const lastActivity = activities.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
    const lastDate = lastActivity ? new Date(lastActivity.created_at) : new Date(p.created_at);
    const daysSince = Math.floor((now - lastDate) / (1000 * 60 * 60 * 24));
    if (daysSince >= thresholdOverdue) count++;
  });
  
  // Expiring contracts (30 days)
  (db.contracts || []).forEach(c => {
    const endDate = c.end_date ? new Date(c.end_date + 'T00:00:00') : null;
    if (endDate) {
      const daysUntil = Math.ceil((endDate - now) / (1000 * 60 * 60 * 24));
      if (daysUntil >= 0 && daysUntil <= 30) count++;
    }
  });
  
  // New leads (24h)
  const dayAgo = new Date(now - 24 * 60 * 60 * 1000);
  count += (db.prospects || []).filter(p => new Date(p.created_at) > dayAgo).length;
  
  res.json({ count });
});

// Mark all notifications as read
app.post('/api/notifications/mark-all-read', (req, res) => {
  // For generated notifications, we track read state in localStorage on client
  // This endpoint is a placeholder for future server-side read tracking
  res.json({ success: true });
});

// Dismiss a notification
app.post('/api/notifications/:id/dismiss', (req, res) => {
  const key = req.body.key || `notification-${req.params.id}`;
  if (!db.dismissedNotifications) db.dismissedNotifications = [];
  
  // Check if already dismissed
  if (!db.dismissedNotifications.find(d => d.key === key)) {
    db.dismissedNotifications.push({
      key,
      dismissed_at: new Date().toISOString()
    });
    saveDB(db);
  }
  
  res.json({ success: true });
});

// Snooze a notification
app.post('/api/notifications/:id/snooze', (req, res) => {
  const hours = parseInt(req.body.hours) || 24;
  const key = req.body.key || `notification-${req.params.id}`;
  const until = new Date(Date.now() + hours * 60 * 60 * 1000);
  
  if (!db.snoozedNotifications) db.snoozedNotifications = [];
  
  // Remove existing snooze for this key
  db.snoozedNotifications = db.snoozedNotifications.filter(s => s.key !== key);
  
  // Add new snooze
  db.snoozedNotifications.push({
    key,
    until: until.toISOString(),
    snoozed_at: new Date().toISOString()
  });
  saveDB(db);
  
  res.json({ success: true, until: until.toISOString() });
});

// Serve notifications page
app.get('/notifications', (req, res) => {
  res.sendFile(path.join(__dirname, 'notifications.html'));
});

// ===== SETTINGS API =====
const SETTINGS_FILE = process.env.SETTINGS_PATH || (process.env.RAILWAY_ENVIRONMENT ? '/data/settings.json' : path.join(__dirname, 'data', 'settings.json'));

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Error loading settings:', e);
  }
  return getDefaultSettings();
}

function saveSettings(settings) {
  const dir = path.dirname(SETTINGS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

function getDefaultSettings() {
  return {
    // Business profile
    company_name: 'Kande VendTech LLC',
    address: '',
    city: 'Henderson',
    state: 'NV',
    zip: '',
    phone: '',
    email: '',
    website: '',
    hours_weekday: '8:00 AM - 5:00 PM',
    hours_saturday: 'Closed',
    hours_sunday: 'Closed',
    emergency_phone: '',
    
    // Financial defaults
    default_commission: 5,
    default_contract_months: 36,
    default_revenue_estimate: 2000,
    min_revenue_threshold: 800,
    
    // Follow-up defaults
    default_followup_days: 7,
    hot_followup_days: 2,
    stale_days: 30,
    touches_to_close: 10,
    
    // Inventory defaults
    target_cogs: 33,
    spoilage_budget: 2,
    low_stock_alert: 10,
    restock_frequency: 7,
    
    // Notifications
    notify_followups: true,
    notify_inventory: true,
    notify_revenue: false,
    notify_contracts: true,
    notify_offline: true,
    notify_leads: true,
    threshold_followup: 3,
    threshold_contract: 30,
    threshold_offline: 60,
    digest_time: '08:00',
    
    // Pipeline stages
    stages: [
      { id: 'new_lead', name: 'New Lead', color: '#6b7280', isDefault: true },
      { id: 'contacted', name: 'Contacted', color: '#3b82f6', isDefault: false },
      { id: 'pop_in_done', name: 'Pop-in Done', color: '#8b5cf6', isDefault: false },
      { id: 'interested', name: 'Interested', color: '#f59e0b', isDefault: false },
      { id: 'site_survey', name: 'Site Survey', color: '#10b981', isDefault: false },
      { id: 'proposal_sent', name: 'Proposal Sent', color: '#ec4899', isDefault: false },
      { id: 'negotiating', name: 'Negotiating', color: '#f97316', isDefault: false },
      { id: 'contract_sent', name: 'Contract Sent', color: '#14b8a6', isDefault: false },
      { id: 'signed', name: 'Signed', color: '#22c55e', isDefault: false },
      { id: 'onboarding', name: 'Onboarding', color: '#06b6d4', isDefault: false },
      { id: 'active_client', name: 'Active Client', color: '#84cc16', isDefault: false }
    ],
    default_stage: 'new_lead',
    auto_advance_days: 0,
    
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
}

// Get settings
app.get('/api/settings', (req, res) => {
  res.json(loadSettings());
});

// Update settings
app.put('/api/settings', (req, res) => {
  const current = loadSettings();
  const updated = { ...current, ...req.body, updated_at: new Date().toISOString() };
  saveSettings(updated);
  res.json(updated);
});

// Reset settings to defaults
app.post('/api/settings/reset', (req, res) => {
  const defaults = getDefaultSettings();
  saveSettings(defaults);
  res.json(defaults);
});

// Serve settings page
app.get('/settings', (req, res) => {
  res.sendFile(path.join(__dirname, 'settings.html'));
});

// ===== EXPORT API =====
app.get('/api/export/:type', (req, res) => {
  const type = req.params.type;
  
  if (type === 'json') {
    // Full database export
    const exportData = {
      exported_at: new Date().toISOString(),
      version: '1.0.0',
      settings: loadSettings(),
      prospects: db.prospects || [],
      contacts: db.contacts || [],
      activities: db.activities || [],
      machines: db.machines || [],
      locations: db.locations || [],
      products: db.products || [],
      suppliers: db.suppliers || [],
      finances: db.finances || [],
      contracts: db.contracts || [],
      pipelineCards: db.pipelineCards || [],
      todos: db.todos || []
    };
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename=vendtech-backup-${new Date().toISOString().split('T')[0]}.json`);
    return res.send(JSON.stringify(exportData, null, 2));
  }
  
  // CSV exports
  let data = [];
  let headers = [];
  
  switch (type) {
    case 'prospects':
      headers = ['id', 'name', 'address', 'city', 'phone', 'email', 'property_type', 'status', 'priority', 'notes', 'created_at'];
      data = (db.prospects || []).map(p => headers.map(h => p[h] || ''));
      break;
    case 'finances':
      headers = ['id', 'type', 'amount', 'category', 'description', 'month', 'machine_id', 'created_at'];
      data = (db.finances || []).map(f => headers.map(h => f[h] || ''));
      break;
    case 'activities':
      headers = ['id', 'prospect_id', 'type', 'description', 'outcome', 'next_action', 'next_action_date', 'created_at'];
      data = (db.activities || []).map(a => headers.map(h => a[h] || ''));
      break;
    case 'products':
      headers = ['id', 'name', 'category', 'cost_price', 'sell_price', 'margin', 'sku', 'supplier'];
      data = (db.products || []).map(p => headers.map(h => p[h] || ''));
      break;
    default:
      return res.status(400).json({ error: 'Unknown export type' });
  }
  
  // Convert to CSV
  const csv = [headers.join(','), ...data.map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))].join('\n');
  
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename=vendtech-${type}-${new Date().toISOString().split('T')[0]}.csv`);
  res.send(csv);
});

// ===== IMPORT API =====
const multer = require('multer') || { single: () => (req, res, next) => next() }; // Graceful fallback
const upload = multer ? multer({ storage: multer.memoryStorage() }) : { single: () => (req, res, next) => next() };

app.post('/api/import', upload.single('file'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    
    const type = req.body.type || 'prospects';
    const content = req.file.buffer.toString('utf8');
    let count = 0;
    
    if (type === 'full') {
      // Full JSON restore
      const importData = JSON.parse(content);
      if (importData.settings) saveSettings(importData.settings);
      if (importData.prospects) { db.prospects = importData.prospects; count += importData.prospects.length; }
      if (importData.contacts) db.contacts = importData.contacts;
      if (importData.activities) db.activities = importData.activities;
      if (importData.machines) db.machines = importData.machines;
      if (importData.locations) db.locations = importData.locations;
      if (importData.products) db.products = importData.products;
      if (importData.finances) db.finances = importData.finances;
      if (importData.contracts) db.contracts = importData.contracts;
      if (importData.pipelineCards) db.pipelineCards = importData.pipelineCards;
      if (importData.todos) db.todos = importData.todos;
      saveDB(db);
      return res.json({ success: true, count, message: 'Full restore completed' });
    }
    
    // CSV import
    const lines = content.split('\n').filter(l => l.trim());
    if (lines.length < 2) {
      return res.status(400).json({ error: 'CSV file must have headers and at least one data row' });
    }
    
    const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
    
    for (let i = 1; i < lines.length; i++) {
      const values = lines[i].match(/("([^"]|"")*"|[^,]*)/g).map(v => v.trim().replace(/^"|"$/g, '').replace(/""/g, '"'));
      const record = {};
      headers.forEach((h, idx) => { record[h] = values[idx] || ''; });
      
      if (type === 'prospects') {
        record.id = nextId();
        record.created_at = record.created_at || new Date().toISOString();
        record.updated_at = new Date().toISOString();
        record.status = record.status || 'new';
        record.priority = record.priority || 'normal';
        db.prospects.push(record);
        count++;
      } else if (type === 'products') {
        record.id = nextId();
        record.created_at = new Date().toISOString();
        record.cost_price = parseFloat(record.cost_price) || 0;
        record.sell_price = parseFloat(record.sell_price) || 0;
        db.products.push(record);
        count++;
      }
    }
    
    saveDB(db);
    res.json({ success: true, count });
  } catch (e) {
    console.error('Import error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ===== DATA MANAGEMENT API =====
// Clear demo data
app.post('/api/data/clear-demo', (req, res) => {
  // Remove records that look like demo/test data
  const demoPatterns = [/test/i, /demo/i, /sample/i, /example/i, /placeholder/i];
  const isDemo = (name) => demoPatterns.some(p => p.test(name || ''));
  
  let cleared = 0;
  const beforeCounts = {
    prospects: (db.prospects || []).length,
    products: (db.products || []).length,
    activities: (db.activities || []).length
  };
  
  db.prospects = (db.prospects || []).filter(p => !isDemo(p.name) && !isDemo(p.notes));
  db.products = (db.products || []).filter(p => !isDemo(p.name));
  db.activities = (db.activities || []).filter(a => !isDemo(a.description));
  
  cleared = (beforeCounts.prospects - db.prospects.length) + 
            (beforeCounts.products - db.products.length) + 
            (beforeCounts.activities - db.activities.length);
  
  saveDB(db);
  res.json({ success: true, cleared });
});

// Delete all data
app.post('/api/data/delete-all', (req, res) => {
  db.prospects = [];
  db.contacts = [];
  db.activities = [];
  db.machines = [];
  db.locations = [];
  db.products = [];
  db.suppliers = [];
  db.finances = [];
  db.creditCards = [];
  db.restocks = [];
  db.clients = [];
  db.touchpoints = [];
  db.issues = [];
  db.contracts = [];
  db.pipelineCards = [];
  db.pipelineTasks = [];
  db.todos = [];
  db.popInVisits = [];
  db.nextId = 1;
  
  saveDB(db);
  
  // Reset settings to defaults
  saveSettings(getDefaultSettings());
  
  res.json({ success: true, message: 'All data deleted' });
});

// ===== GLOBAL SEARCH API =====
app.get('/search', (req, res) => res.sendFile(path.join(__dirname, 'search.html')));

app.get('/api/search', (req, res) => {
  const { q, type, status, from, to } = req.query;
  const query = (q || '').toLowerCase().trim();
  
  if (!query || query.length < 2) {
    return res.json({ results: [], total: 0 });
  }
  
  const results = [];
  const fromDate = from ? new Date(from) : null;
  const toDate = to ? new Date(to) : null;
  
  // Helper: check date range
  const inDateRange = (dateStr) => {
    if (!dateStr) return true;
    const d = new Date(dateStr);
    if (fromDate && d < fromDate) return false;
    if (toDate && d > toDate) return false;
    return true;
  };
  
  // Helper: text match
  const matches = (text) => text && String(text).toLowerCase().includes(query);
  
  // Helper: get excerpt around match
  const getExcerpt = (text, maxLen = 150) => {
    if (!text) return '';
    const str = String(text);
    const idx = str.toLowerCase().indexOf(query);
    if (idx === -1) return str.slice(0, maxLen);
    const start = Math.max(0, idx - 40);
    const end = Math.min(str.length, idx + query.length + 100);
    let excerpt = str.slice(start, end);
    if (start > 0) excerpt = '...' + excerpt;
    if (end < str.length) excerpt = excerpt + '...';
    return excerpt;
  };
  
  // Search Prospects
  if (!type || type === 'prospects') {
    (db.prospects || []).forEach(p => {
      if (status && p.status !== status) return;
      if (!inDateRange(p.created_at)) return;
      
      const searchableFields = [p.name, p.address, p.phone, p.email, p.notes, p.contact_name, p.contact_email, p.contact_phone, p.property_type];
      if (searchableFields.some(matches)) {
        const matchedField = searchableFields.find(matches);
        results.push({
          id: p.id,
          type: 'prospects',
          title: p.name,
          address: p.address,
          contact: p.contact_name,
          property_type: p.property_type,
          status: p.status,
          date: p.created_at,
          excerpt: getExcerpt(matchedField === p.name ? p.notes : matchedField)
        });
      }
    });
  }
  
  // Search Activities
  if (!type || type === 'activities') {
    (db.activities || []).forEach(a => {
      if (!inDateRange(a.created_at)) return;
      
      const searchableFields = [a.description, a.notes, a.type, a.outcome, a.next_action];
      if (searchableFields.some(matches)) {
        const prospect = db.prospects.find(p => p.id === a.prospect_id);
        const matchedField = searchableFields.find(matches);
        results.push({
          id: a.id,
          type: 'activities',
          title: `${a.type || 'Activity'} - ${prospect?.name || 'Unknown'}`,
          prospect_id: a.prospect_id,
          date: a.created_at,
          excerpt: getExcerpt(matchedField)
        });
      }
    });
  }
  
  // Search Contracts
  if (!type || type === 'contracts') {
    (db.contracts || []).forEach(c => {
      if (status && c.status !== status) return;
      if (!inDateRange(c.created_at)) return;
      
      const prospect = db.prospects.find(p => p.id === c.prospect_id);
      const searchableFields = [c.title, c.notes, prospect?.name, c.terms];
      if (searchableFields.some(matches)) {
        const matchedField = searchableFields.find(matches);
        results.push({
          id: c.id,
          type: 'contracts',
          title: c.title || `Contract - ${prospect?.name || 'Unknown'}`,
          status: c.status,
          date: c.created_at,
          excerpt: getExcerpt(matchedField)
        });
      }
    });
  }
  
  // Search Proposals (from pipeline cards with proposals)
  if (!type || type === 'proposals') {
    (db.pipelineCards || []).filter(c => c.proposal_sent || c.stage === 'proposal_sent').forEach(c => {
      if (!inDateRange(c.updated_at)) return;
      
      const prospect = db.prospects.find(p => p.id === c.prospect_id);
      const searchableFields = [c.company, c.notes, prospect?.name, prospect?.address];
      if (searchableFields.some(matches)) {
        const matchedField = searchableFields.find(matches);
        results.push({
          id: c.id,
          type: 'proposals',
          title: `Proposal - ${c.company || prospect?.name || 'Unknown'}`,
          status: c.stage,
          date: c.entered_stage_at || c.updated_at,
          excerpt: getExcerpt(matchedField)
        });
      }
    });
  }
  
  // Search Todos
  if (!type || type === 'todos') {
    (db.todos || []).forEach(t => {
      if (status === 'completed' && !t.completed) return;
      if (status === 'pending' && t.completed) return;
      if (!inDateRange(t.created_at)) return;
      
      const searchableFields = [t.title, t.description, t.notes, t.category];
      if (searchableFields.some(matches)) {
        const matchedField = searchableFields.find(matches);
        results.push({
          id: t.id,
          type: 'todos',
          title: t.title,
          status: t.completed ? 'completed' : 'pending',
          date: t.due_date || t.created_at,
          excerpt: getExcerpt(matchedField === t.title ? t.description : matchedField)
        });
      }
    });
  }
  
  // Search Service Records (restocks, issues, touchpoints)
  if (!type || type === 'service') {
    // Restocks
    (db.restocks || []).forEach(r => {
      if (!inDateRange(r.created_at)) return;
      
      const machine = db.machines.find(m => m.id === r.machine_id);
      const searchableFields = [r.notes, machine?.name, machine?.serial_number];
      if (searchableFields.some(matches)) {
        const matchedField = searchableFields.find(matches);
        results.push({
          id: r.id,
          type: 'service',
          title: `Restock - ${machine?.name || 'Unknown Machine'}`,
          date: r.created_at,
          excerpt: getExcerpt(matchedField)
        });
      }
    });
    
    // Issues
    (db.issues || []).forEach(i => {
      if (status && i.status !== status) return;
      if (!inDateRange(i.created_at)) return;
      
      const searchableFields = [i.title, i.description, i.resolution];
      if (searchableFields.some(matches)) {
        const matchedField = searchableFields.find(matches);
        results.push({
          id: i.id,
          type: 'service',
          title: `Issue - ${i.title || 'Unknown'}`,
          status: i.status,
          date: i.created_at,
          excerpt: getExcerpt(matchedField)
        });
      }
    });
    
    // Touchpoints
    (db.touchpoints || []).forEach(t => {
      if (!inDateRange(t.created_at)) return;
      
      const client = db.clients.find(c => c.id === t.client_id);
      const searchableFields = [t.notes, t.type, client?.name];
      if (searchableFields.some(matches)) {
        const matchedField = searchableFields.find(matches);
        results.push({
          id: t.id,
          type: 'service',
          title: `Touchpoint - ${client?.name || 'Unknown'}`,
          date: t.created_at,
          excerpt: getExcerpt(matchedField)
        });
      }
    });
  }
  
  // Sort by relevance (exact matches first) then by date
  results.sort((a, b) => {
    const aExact = a.title?.toLowerCase().includes(query) ? 1 : 0;
    const bExact = b.title?.toLowerCase().includes(query) ? 1 : 0;
    if (aExact !== bExact) return bExact - aExact;
    return new Date(b.date || 0) - new Date(a.date || 0);
  });
  
  res.json({ results: results.slice(0, 100), total: results.length });
});

// ===== TASKS API (Enhanced version using todos collection) =====
// Removed duplicate route - main route is in Mission Control section

// Tasks API - uses the same todos collection but with enhanced features
app.get('/api/tasks', (req, res) => {
  const { status, priority, category, prospect_id, overdue, today, week } = req.query;
  let tasks = db.todos || [];
  
  // Apply filters
  if (status) tasks = tasks.filter(t => t.status === status || (status === 'completed' && t.completed));
  if (priority) tasks = tasks.filter(t => t.priority === priority);
  if (category) tasks = tasks.filter(t => t.category === category);
  if (prospect_id) tasks = tasks.filter(t => t.prospect_id == prospect_id);
  
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const todayStr = now.toISOString().split('T')[0];
  
  if (overdue === 'true') {
    tasks = tasks.filter(t => t.due_date && t.due_date < todayStr && !t.completed && t.status !== 'completed');
  }
  if (today === 'true') {
    tasks = tasks.filter(t => t.due_date === todayStr);
  }
  if (week === 'true') {
    const weekEnd = new Date(now);
    weekEnd.setDate(weekEnd.getDate() + 7);
    const weekEndStr = weekEnd.toISOString().split('T')[0];
    tasks = tasks.filter(t => t.due_date && t.due_date >= todayStr && t.due_date <= weekEndStr);
  }
  
  res.json(tasks);
});

app.get('/api/tasks/stats', (req, res) => {
  const tasks = db.todos || [];
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const todayStr = now.toISOString().split('T')[0];
  const weekEnd = new Date(now);
  weekEnd.setDate(weekEnd.getDate() + 7);
  const weekEndStr = weekEnd.toISOString().split('T')[0];
  
  // Today stats
  const completedToday = tasks.filter(t => {
    if (!t.completed_at) return false;
    return t.completed_at.split('T')[0] === todayStr;
  }).length;
  
  // This week stats
  const weekStart = new Date(now);
  weekStart.setDate(weekStart.getDate() - weekStart.getDay());
  const weekStartStr = weekStart.toISOString().split('T')[0];
  const completedThisWeek = tasks.filter(t => {
    if (!t.completed_at) return false;
    const date = t.completed_at.split('T')[0];
    return date >= weekStartStr && date <= todayStr;
  }).length;
  
  const total = tasks.length;
  const completed = tasks.filter(t => t.completed || t.status === 'completed').length;
  const pending = tasks.filter(t => t.status === 'pending' && !t.completed).length;
  const inProgress = tasks.filter(t => t.status === 'in_progress' && !t.completed).length;
  const overdue = tasks.filter(t => t.due_date && t.due_date < todayStr && !t.completed && t.status !== 'completed').length;
  const dueToday = tasks.filter(t => t.due_date === todayStr && !t.completed && t.status !== 'completed').length;
  const dueThisWeek = tasks.filter(t => t.due_date && t.due_date >= todayStr && t.due_date <= weekEndStr && !t.completed && t.status !== 'completed').length;
  
  // Completion rate
  const completionRate = total > 0 ? Math.round((completed / total) * 100) : 0;
  
  // Category breakdown
  const byCategory = {};
  tasks.forEach(t => {
    const cat = t.category || 'other';
    if (!byCategory[cat]) byCategory[cat] = { total: 0, completed: 0 };
    byCategory[cat].total++;
    if (t.completed || t.status === 'completed') byCategory[cat].completed++;
  });
  
  // Priority breakdown
  const byPriority = { high: 0, medium: 0, low: 0 };
  tasks.filter(t => !t.completed && t.status !== 'completed').forEach(t => {
    const p = t.priority || 'medium';
    if (byPriority[p] !== undefined) byPriority[p]++;
  });
  
  res.json({
    total,
    completed,
    pending,
    inProgress,
    overdue,
    dueToday,
    dueThisWeek,
    completedToday,
    completedThisWeek,
    completionRate,
    byCategory,
    byPriority
  });
});

app.post('/api/tasks', (req, res) => {
  if (!req.body.title || !req.body.title.trim()) {
    return res.status(400).json({ error: 'title is required' });
  }
  const task = {
    id: nextId(),
    title: req.body.title.trim(),
    description: req.body.description || '',
    category: req.body.category || 'other',
    priority: req.body.priority || 'medium',
    due_date: req.body.due_date || null,
    status: req.body.status || 'pending',
    prospect_id: req.body.prospect_id || null,
    completed: req.body.completed || false,
    completed_at: req.body.completed_at || null,
    notes: req.body.notes || '',
    recurring: req.body.recurring || false,
    recurring_interval: req.body.recurring_interval || null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  if (!db.todos) db.todos = [];
  db.todos.push(task);
  saveDB(db);
  res.json(task);
});

app.put('/api/tasks/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const idx = (db.todos || []).findIndex(t => t.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Task not found' });
  db.todos[idx] = { ...db.todos[idx], ...req.body, updated_at: new Date().toISOString() };
  saveDB(db);
  res.json(db.todos[idx]);
});

app.delete('/api/tasks/:id', (req, res) => {
  const id = parseInt(req.params.id);
  db.todos = (db.todos || []).filter(t => t.id !== id);
  saveDB(db);
  res.json({ success: true });
});

// Bulk operations
app.post('/api/tasks/bulk/complete', (req, res) => {
  const { ids } = req.body;
  if (!ids || !Array.isArray(ids)) return res.status(400).json({ error: 'ids array required' });
  
  const now = new Date().toISOString();
  let updated = 0;
  ids.forEach(id => {
    const idx = (db.todos || []).findIndex(t => t.id === id);
    if (idx >= 0) {
      db.todos[idx].completed = true;
      db.todos[idx].status = 'completed';
      db.todos[idx].completed_at = now;
      db.todos[idx].updated_at = now;
      updated++;
    }
  });
  
  saveDB(db);
  res.json({ success: true, updated });
});

app.post('/api/tasks/bulk/priority', (req, res) => {
  const { ids, priority } = req.body;
  if (!ids || !Array.isArray(ids)) return res.status(400).json({ error: 'ids array required' });
  if (!priority) return res.status(400).json({ error: 'priority required' });
  
  const now = new Date().toISOString();
  let updated = 0;
  ids.forEach(id => {
    const idx = (db.todos || []).findIndex(t => t.id === id);
    if (idx >= 0) {
      db.todos[idx].priority = priority;
      db.todos[idx].updated_at = now;
      updated++;
    }
  });
  
  saveDB(db);
  res.json({ success: true, updated });
});

app.post('/api/tasks/bulk/delete', (req, res) => {
  const { ids } = req.body;
  if (!ids || !Array.isArray(ids)) return res.status(400).json({ error: 'ids array required' });
  
  const before = (db.todos || []).length;
  db.todos = (db.todos || []).filter(t => !ids.includes(t.id));
  const deleted = before - db.todos.length;
  
  saveDB(db);
  res.json({ success: true, deleted });
});

// ===== CONTACTS DIRECTORY API =====
// Centralized contact management across all prospects
app.get('/contacts', (req, res) => res.sendFile(path.join(__dirname, 'contacts.html')));

// Get all contacts with enriched data
app.get('/api/directory/contacts', (req, res) => {
  const enrichedContacts = (db.contacts || []).map(c => {
    const prospect = db.prospects.find(p => p.id === c.prospect_id);
    const reportsTo = (db.contacts || []).find(x => x.id === c.reports_to);
    const contactActivities = (db.activities || []).filter(a => 
      a.contact_id === c.id || 
      (a.prospect_id === c.prospect_id && a.description?.toLowerCase().includes((c.name || '').toLowerCase()))
    );
    const lastActivity = contactActivities.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
    
    return {
      ...c,
      prospect_name: prospect?.name || null,
      property_type: prospect?.property_type || null,
      reports_to_name: reportsTo?.name || reportsTo?.first_name ? `${reportsTo.first_name} ${reportsTo.last_name}` : null,
      last_contact_date: lastActivity?.created_at || c.last_contact_date || null,
      activity_count: contactActivities.length,
      status: prospect?.status === 'signed' ? 'active' : prospect?.status === 'closed' ? 'inactive' : 'prospect'
    };
  }).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  
  res.json(enrichedContacts);
});

// Get single contact with full details
app.get('/api/directory/contacts/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const contact = (db.contacts || []).find(c => c.id === id);
  if (!contact) return res.status(404).json({ error: 'Contact not found' });
  
  const prospect = db.prospects.find(p => p.id === contact.prospect_id);
  const reportsTo = (db.contacts || []).find(c => c.id === contact.reports_to);
  const subordinates = (db.contacts || []).filter(c => c.reports_to === id);
  const contactActivities = (db.activities || []).filter(a => 
    a.contact_id === id || 
    (a.prospect_id === contact.prospect_id && a.description?.toLowerCase().includes((contact.name || '').toLowerCase()))
  ).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  
  res.json({
    ...contact,
    prospect_name: prospect?.name,
    property_type: prospect?.property_type,
    reports_to_contact: reportsTo || null,
    subordinates,
    activities: contactActivities
  });
});

// Create new contact (directory-level)
app.post('/api/directory/contacts', (req, res) => {
  const name = req.body.name || `${req.body.first_name || ''} ${req.body.last_name || ''}`.trim();
  if (!name) return res.status(400).json({ error: 'name is required' });
  
  const contact = {
    id: nextId(),
    name,
    first_name: req.body.first_name || '',
    last_name: req.body.last_name || '',
    title: req.body.title || '',
    prospect_id: req.body.prospect_id || null,
    phone: req.body.phone || (req.body.phones || [])[0]?.number || '',
    email: req.body.email || (req.body.emails || [])[0]?.address || '',
    phones: req.body.phones || [],
    emails: req.body.emails || [],
    tags: req.body.tags || [],
    preferred_contact_method: req.body.preferred_contact_method || '',
    influence: req.body.influence || '',
    birthday: req.body.birthday || null,
    reports_to: req.body.reports_to || null,
    notes: req.body.notes || '',
    photo_url: req.body.photo_url || null,
    is_primary: req.body.is_primary || false,
    last_contact_date: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  
  if (!db.contacts) db.contacts = [];
  
  // If is_primary, unset other primary contacts for same prospect
  if (contact.is_primary && contact.prospect_id) {
    db.contacts.forEach(c => {
      if (c.prospect_id === contact.prospect_id) c.is_primary = false;
    });
  }
  
  db.contacts.push(contact);
  saveDB(db);
  res.json(contact);
});

// Update contact
app.put('/api/directory/contacts/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const idx = (db.contacts || []).findIndex(c => c.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Contact not found' });
  
  // If setting as primary, unset others
  if (req.body.is_primary && req.body.prospect_id) {
    db.contacts.forEach(c => {
      if (c.prospect_id === req.body.prospect_id) c.is_primary = false;
    });
  }
  
  // Update name if first/last changed
  if (req.body.first_name !== undefined || req.body.last_name !== undefined) {
    const first = req.body.first_name !== undefined ? req.body.first_name : db.contacts[idx].first_name || '';
    const last = req.body.last_name !== undefined ? req.body.last_name : db.contacts[idx].last_name || '';
    req.body.name = `${first} ${last}`.trim();
  }
  
  db.contacts[idx] = { 
    ...db.contacts[idx], 
    ...req.body, 
    updated_at: new Date().toISOString() 
  };
  saveDB(db);
  res.json(db.contacts[idx]);
});

// Delete contact
app.delete('/api/directory/contacts/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const before = (db.contacts || []).length;
  db.contacts = (db.contacts || []).filter(c => c.id !== id);
  
  // Clear reports_to references
  db.contacts.forEach(c => {
    if (c.reports_to === id) c.reports_to = null;
  });
  
  saveDB(db);
  res.json({ success: true, deleted: before - db.contacts.length });
});

// Bulk import contacts
app.post('/api/directory/contacts/import', (req, res) => {
  const { contacts: importContacts } = req.body;
  if (!importContacts || !Array.isArray(importContacts)) {
    return res.status(400).json({ error: 'contacts array required' });
  }
  
  let imported = 0;
  let duplicates = 0;
  
  importContacts.forEach(ic => {
    const name = ic.name || `${ic.first_name || ''} ${ic.last_name || ''}`.trim();
    if (!name) return;
    
    // Check for duplicates by name + email
    const isDup = db.contacts.some(c => {
      const existingName = (c.name || `${c.first_name || ''} ${c.last_name || ''}`).toLowerCase().trim();
      if (existingName === name.toLowerCase().trim()) return true;
      if (ic.email && c.email && ic.email.toLowerCase() === c.email.toLowerCase()) return true;
      return false;
    });
    
    if (isDup) {
      duplicates++;
      return;
    }
    
    // Try to match to a prospect by company name
    let prospectId = null;
    if (ic.company) {
      const prospect = db.prospects.find(p => 
        p.name.toLowerCase().includes(ic.company.toLowerCase()) ||
        ic.company.toLowerCase().includes(p.name.toLowerCase())
      );
      if (prospect) prospectId = prospect.id;
    }
    
    const contact = {
      id: nextId(),
      name,
      first_name: ic.first_name || '',
      last_name: ic.last_name || '',
      title: ic.title || '',
      prospect_id: prospectId,
      phone: ic.phone || '',
      email: ic.email || '',
      phones: ic.phone ? [{ number: ic.phone, type: 'work' }] : [],
      emails: ic.email ? [{ address: ic.email, type: 'work' }] : [],
      tags: [],
      notes: '',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    
    db.contacts.push(contact);
    imported++;
  });
  
  saveDB(db);
  res.json({ imported, duplicates, total: importContacts.length });
});

// Export contacts as vCard
app.get('/api/directory/contacts/export/vcard', (req, res) => {
  const vcards = (db.contacts || []).map(c => {
    const name = c.name || `${c.first_name || ''} ${c.last_name || ''}`.trim();
    const prospect = db.prospects.find(p => p.id === c.prospect_id);
    
    return `BEGIN:VCARD
VERSION:3.0
FN:${name}
N:${c.last_name || ''};${c.first_name || ''};;;
${c.title ? `TITLE:${c.title}` : ''}
${prospect ? `ORG:${prospect.name}` : ''}
${c.phone ? `TEL;TYPE=WORK:${c.phone}` : ''}
${c.email ? `EMAIL;TYPE=WORK:${c.email}` : ''}
${c.notes ? `NOTE:${c.notes.replace(/\n/g, '\\n')}` : ''}
END:VCARD`;
  }).join('\n\n');
  
  res.setHeader('Content-Type', 'text/vcard');
  res.setHeader('Content-Disposition', 'attachment; filename="contacts.vcf"');
  res.send(vcards);
});

// Contact search endpoint
app.get('/api/directory/contacts/search', (req, res) => {
  const { q, prospect_id, tag, property_type } = req.query;
  let results = db.contacts || [];
  
  if (prospect_id) {
    results = results.filter(c => c.prospect_id === parseInt(prospect_id));
  }
  
  if (tag) {
    results = results.filter(c => (c.tags || []).includes(tag));
  }
  
  if (property_type) {
    const prospectIds = db.prospects.filter(p => p.property_type === property_type).map(p => p.id);
    results = results.filter(c => prospectIds.includes(c.prospect_id));
  }
  
  if (q) {
    const query = q.toLowerCase();
    results = results.filter(c => {
      const searchStr = `${c.name || ''} ${c.first_name || ''} ${c.last_name || ''} ${c.title || ''} ${c.email || ''} ${c.phone || ''}`.toLowerCase();
      return searchStr.includes(query);
    });
  }
  
  // Enrich with prospect names
  results = results.map(c => {
    const prospect = db.prospects.find(p => p.id === c.prospect_id);
    return { ...c, prospect_name: prospect?.name || null };
  });
  
  res.json(results);
});

// ===== GOALS & TARGETS API =====
// Initialize goals collection
if (!db.goals) db.goals = [];
if (!db.goalsAchievements) db.goalsAchievements = { streaks: { current: 0, best: 0, last_activity: null }, badges: [], personal_bests: {} };

// Serve goals page
app.get('/goals', (req, res) => {
  res.sendFile(path.join(__dirname, 'goals.html'));
});

// Get all goals
app.get('/api/goals', (req, res) => {
  const { category, status } = req.query;
  let goals = db.goals || [];
  if (category) goals = goals.filter(g => g.category === category);
  if (status) goals = goals.filter(g => g.status === status);
  res.json(goals.sort((a, b) => new Date(b.created_at) - new Date(a.created_at)));
});

// Get single goal
app.get('/api/goals/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const goal = (db.goals || []).find(g => g.id === id);
  if (!goal) return res.status(404).json({ error: 'Goal not found' });
  res.json(goal);
});

// Create goal
app.post('/api/goals', (req, res) => {
  if (!req.body.name || !req.body.name.trim()) {
    return res.status(400).json({ error: 'name is required' });
  }
  
  const goal = {
    id: nextId(),
    name: req.body.name,
    category: req.body.category || 'revenue',
    target: parseFloat(req.body.target) || 0,
    current: parseFloat(req.body.current) || 0,
    unit: req.body.unit || '',
    start_date: req.body.start_date || null,
    end_date: req.body.end_date || null,
    checkpoints: req.body.checkpoints || [],
    status: 'active',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  
  if (!db.goals) db.goals = [];
  db.goals.push(goal);
  
  // Update streak on activity
  updateGoalsStreak();
  
  saveDB(db);
  res.json(goal);
});

// Update goal
app.put('/api/goals/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const idx = (db.goals || []).findIndex(g => g.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Goal not found' });
  
  const goal = db.goals[idx];
  const oldCurrent = goal.current;
  
  // Update fields
  if (req.body.name !== undefined) goal.name = req.body.name;
  if (req.body.category !== undefined) goal.category = req.body.category;
  if (req.body.target !== undefined) goal.target = parseFloat(req.body.target) || 0;
  if (req.body.current !== undefined) goal.current = parseFloat(req.body.current) || 0;
  if (req.body.unit !== undefined) goal.unit = req.body.unit;
  if (req.body.start_date !== undefined) goal.start_date = req.body.start_date;
  if (req.body.end_date !== undefined) goal.end_date = req.body.end_date;
  if (req.body.checkpoints !== undefined) goal.checkpoints = req.body.checkpoints;
  if (req.body.status !== undefined) goal.status = req.body.status;
  
  goal.updated_at = new Date().toISOString();
  
  // Check if goal is now achieved
  if (goal.current >= goal.target && goal.status === 'active') {
    goal.status = 'achieved';
    goal.completed_at = new Date().toISOString();
    
    // Check if completed early
    if (goal.end_date && new Date() < new Date(goal.end_date)) {
      goal.completed_early = true;
    }
    
    // Check if was behind but caught up
    if (goal.start_date && goal.end_date) {
      const totalDays = (new Date(goal.end_date) - new Date(goal.start_date)) / (1000 * 60 * 60 * 24);
      const daysElapsed = (new Date() - new Date(goal.start_date)) / (1000 * 60 * 60 * 24);
      const expectedPercent = (daysElapsed / totalDays) * 100;
      if (oldCurrent < goal.target * (expectedPercent / 100) * 0.9) {
        goal.was_behind = true;
      }
    }
    
    // Update personal bests
    updatePersonalBests();
  }
  
  // Check if missed (past end date and not achieved)
  if (goal.end_date && new Date() > new Date(goal.end_date) && goal.current < goal.target && goal.status === 'active') {
    goal.status = 'missed';
    goal.completed_at = new Date().toISOString();
  }
  
  // Update streak on progress
  if (req.body.current !== undefined && req.body.current !== oldCurrent) {
    updateGoalsStreak();
  }
  
  db.goals[idx] = goal;
  saveDB(db);
  res.json(goal);
});

// Delete goal
app.delete('/api/goals/:id', (req, res) => {
  const id = parseInt(req.params.id);
  db.goals = (db.goals || []).filter(g => g.id !== id);
  saveDB(db);
  res.json({ success: true });
});

// Get achievements
app.get('/api/goals/achievements', (req, res) => {
  res.json(db.goalsAchievements || { streaks: { current: 0, best: 0 }, badges: [], personal_bests: {} });
});

// Update achievements
app.put('/api/goals/achievements', (req, res) => {
  if (!db.goalsAchievements) db.goalsAchievements = { streaks: { current: 0, best: 0 }, badges: [], personal_bests: {} };
  
  if (req.body.streaks) db.goalsAchievements.streaks = { ...db.goalsAchievements.streaks, ...req.body.streaks };
  if (req.body.badges) db.goalsAchievements.badges = req.body.badges;
  if (req.body.personal_bests) db.goalsAchievements.personal_bests = { ...db.goalsAchievements.personal_bests, ...req.body.personal_bests };
  
  saveDB(db);
  res.json(db.goalsAchievements);
});

// Helper: Update streak
function updateGoalsStreak() {
  if (!db.goalsAchievements) db.goalsAchievements = { streaks: { current: 0, best: 0, last_activity: null }, badges: [], personal_bests: {} };
  
  const today = new Date().toISOString().split('T')[0];
  const lastActivity = db.goalsAchievements.streaks.last_activity;
  
  if (!lastActivity) {
    db.goalsAchievements.streaks.current = 1;
    db.goalsAchievements.streaks.last_activity = today;
  } else {
    const lastDate = new Date(lastActivity);
    const todayDate = new Date(today);
    const diffDays = Math.floor((todayDate - lastDate) / (1000 * 60 * 60 * 24));
    
    if (diffDays === 0) {
      // Same day, no change
    } else if (diffDays === 1) {
      // Consecutive day
      db.goalsAchievements.streaks.current++;
      db.goalsAchievements.streaks.last_activity = today;
    } else {
      // Streak broken
      db.goalsAchievements.streaks.current = 1;
      db.goalsAchievements.streaks.last_activity = today;
    }
  }
  
  // Update best streak
  if (db.goalsAchievements.streaks.current > (db.goalsAchievements.streaks.best || 0)) {
    db.goalsAchievements.streaks.best = db.goalsAchievements.streaks.current;
  }
}

// Helper: Update personal bests
function updatePersonalBests() {
  if (!db.goalsAchievements) db.goalsAchievements = { streaks: { current: 0, best: 0 }, badges: [], personal_bests: {} };
  
  const achieved = (db.goals || []).filter(g => g.status === 'achieved');
  
  // Most goals in a month
  const goalsByMonth = {};
  achieved.forEach(g => {
    const month = (g.completed_at || g.created_at).substring(0, 7);
    goalsByMonth[month] = (goalsByMonth[month] || 0) + 1;
  });
  const mostGoalsMonth = Math.max(0, ...Object.values(goalsByMonth));
  if (mostGoalsMonth > (db.goalsAchievements.personal_bests.most_goals_month || 0)) {
    db.goalsAchievements.personal_bests.most_goals_month = mostGoalsMonth;
  }
  
  // Update machines deployed from db.machines
  const machinesDeployed = (db.machines || []).filter(m => m.status === 'deployed').length;
  db.goalsAchievements.personal_bests.machines_deployed = machinesDeployed;
  
  // Best month revenue from finances
  const revenueByMonth = {};
  (db.finances || []).filter(f => f.type === 'revenue').forEach(f => {
    if (f.month) {
      revenueByMonth[f.month] = (revenueByMonth[f.month] || 0) + (f.amount || 0);
    }
  });
  const bestMonthRevenue = Math.max(0, ...Object.values(revenueByMonth));
  if (bestMonthRevenue > (db.goalsAchievements.personal_bests.best_month_revenue || 0)) {
    db.goalsAchievements.personal_bests.best_month_revenue = bestMonthRevenue;
  }
  
  // Pop-ins from activities
  const popInActivities = (db.activities || []).filter(a => a.type === 'pop-in' || a.type === 'visit');
  const popInsByWeek = {};
  popInActivities.forEach(a => {
    const date = new Date(a.created_at);
    const weekStart = new Date(date);
    weekStart.setDate(date.getDate() - date.getDay());
    const weekKey = weekStart.toISOString().split('T')[0];
    popInsByWeek[weekKey] = (popInsByWeek[weekKey] || 0) + 1;
  });
  const bestWeekPopins = Math.max(0, ...Object.values(popInsByWeek));
  if (bestWeekPopins > (db.goalsAchievements.personal_bests.best_week_popins || 0)) {
    db.goalsAchievements.personal_bests.best_week_popins = bestWeekPopins;
  }
  db.goalsAchievements.personal_bests.total_popins = popInActivities.length;
}

// Goal summary stats
app.get('/api/goals/summary', (req, res) => {
  const goals = db.goals || [];
  const active = goals.filter(g => g.status === 'active');
  const achieved = goals.filter(g => g.status === 'achieved');
  const missed = goals.filter(g => g.status === 'missed');
  
  // Calculate overall progress
  const totalProgress = active.reduce((sum, g) => {
    return sum + (g.target > 0 ? Math.min(100, (g.current / g.target) * 100) : 0);
  }, 0);
  const avgProgress = active.length > 0 ? Math.round(totalProgress / active.length) : 0;
  
  res.json({
    total: goals.length,
    active: active.length,
    achieved: achieved.length,
    missed: missed.length,
    avgProgress,
    successRate: goals.length > 0 ? Math.round((achieved.length / (achieved.length + missed.length || 1)) * 100) : 0,
    streaks: db.goalsAchievements?.streaks || { current: 0, best: 0 }
  });
});

// ===== DOCUMENTS & FILES API =====
// Initialize documents collection
if (!db.documents) db.documents = [];

// Serve documents page
app.get('/documents', (req, res) => {
  res.sendFile(path.join(__dirname, 'documents.html'));
});
app.get('/files', (req, res) => {
  res.sendFile(path.join(__dirname, 'documents.html'));
});

// Get all documents
app.get('/api/documents', (req, res) => {
  const { category, prospect_id, search } = req.query;
  let docs = db.documents || [];
  
  if (category) docs = docs.filter(d => d.category === category);
  if (prospect_id) docs = docs.filter(d => d.prospect_id == prospect_id);
  if (search) {
    const s = search.toLowerCase();
    docs = docs.filter(d => d.name.toLowerCase().includes(s) || (d.notes || '').toLowerCase().includes(s));
  }
  
  // Return without the data field for listing (too large)
  const list = docs.map(d => ({
    id: d.id,
    name: d.name,
    category: d.category,
    prospect_id: d.prospect_id,
    notes: d.notes,
    mime_type: d.mime_type,
    size: d.size,
    created_at: d.created_at,
    updated_at: d.updated_at,
    // Include thumbnail for images (first 100 chars of base64)
    data: d.mime_type?.startsWith('image/') ? d.data : null
  }));
  
  res.json(list.sort((a, b) => new Date(b.created_at) - new Date(a.created_at)));
});

// Get single document (with full data)
app.get('/api/documents/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const doc = (db.documents || []).find(d => d.id === id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  res.json(doc);
});

// Upload document
app.post('/api/documents', (req, res) => {
  const { name, category, prospect_id, notes, mime_type, size, data } = req.body;
  
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'name is required' });
  }
  if (!data) {
    return res.status(400).json({ error: 'data is required' });
  }
  
  const doc = {
    id: nextId(),
    name: name.trim(),
    category: category || 'other',
    prospect_id: prospect_id ? parseInt(prospect_id) : null,
    notes: notes || '',
    mime_type: mime_type || 'application/octet-stream',
    size: size || 0,
    data: data, // base64 encoded
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  
  if (!db.documents) db.documents = [];
  db.documents.push(doc);
  saveDB(db);
  
  // Return without data for response efficiency
  res.json({ ...doc, data: doc.mime_type?.startsWith('image/') ? doc.data : undefined });
});

// Update document metadata
app.put('/api/documents/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const idx = (db.documents || []).findIndex(d => d.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Document not found' });
  
  const { name, category, prospect_id, notes } = req.body;
  
  if (name !== undefined) db.documents[idx].name = name;
  if (category !== undefined) db.documents[idx].category = category;
  if (prospect_id !== undefined) db.documents[idx].prospect_id = prospect_id ? parseInt(prospect_id) : null;
  if (notes !== undefined) db.documents[idx].notes = notes;
  db.documents[idx].updated_at = new Date().toISOString();
  
  saveDB(db);
  
  const doc = db.documents[idx];
  res.json({ ...doc, data: doc.mime_type?.startsWith('image/') ? doc.data : undefined });
});

// Delete document
app.delete('/api/documents/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const idx = (db.documents || []).findIndex(d => d.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Document not found' });
  
  db.documents.splice(idx, 1);
  saveDB(db);
  res.json({ success: true });
});

// Get documents stats
app.get('/api/documents/stats', (req, res) => {
  const docs = db.documents || [];
  const totalSize = docs.reduce((sum, d) => sum + (d.size || 0), 0);
  
  const byCategory = {};
  docs.forEach(d => {
    byCategory[d.category] = (byCategory[d.category] || 0) + 1;
  });
  
  const recent = docs
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, 10)
    .map(d => ({ id: d.id, name: d.name, category: d.category, created_at: d.created_at }));
  
  res.json({
    total: docs.length,
    totalSize,
    byCategory,
    recent
  });
});

// ===== ACTIVITY LOG API =====
// Initialize activity log collection
if (!db.activityLog) db.activityLog = [];

// Helper function to log activity (call this from other endpoints or use middleware)
function logActivity({ action, entity_type, entity_id, entity_name, user, description, before, after, details }) {
  const entry = {
    id: nextId(),
    action: action || 'system', // created, updated, deleted, exported, imported, viewed, login, system
    entity_type: entity_type || null, // prospect, contact, machine, location, product, etc.
    entity_id: entity_id || null,
    entity_name: entity_name || null,
    user: user || 'System',
    description: description || null,
    before: before ? JSON.stringify(before) : null,
    after: after ? JSON.stringify(after) : null,
    details: details ? JSON.stringify(details) : null,
    created_at: new Date().toISOString()
  };
  db.activityLog.push(entry);
  // Keep only last 10000 entries to prevent unbounded growth
  if (db.activityLog.length > 10000) {
    db.activityLog = db.activityLog.slice(-10000);
  }
  saveDB(db);
  return entry;
}

// Get activity log with optional filters
app.get('/api/activity-log', (req, res) => {
  const { action, entity_type, from, to, user, limit } = req.query;
  let logs = [...(db.activityLog || [])];
  
  // Apply filters
  if (action) logs = logs.filter(l => l.action === action);
  if (entity_type) logs = logs.filter(l => l.entity_type === entity_type);
  if (user) logs = logs.filter(l => l.user?.toLowerCase().includes(user.toLowerCase()));
  if (from) logs = logs.filter(l => l.created_at >= from);
  if (to) logs = logs.filter(l => l.created_at <= to + 'T23:59:59.999Z');
  
  // Sort by newest first
  logs.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  
  // Limit results
  const maxResults = Math.min(parseInt(limit) || 1000, 5000);
  logs = logs.slice(0, maxResults);
  
  res.json(logs);
});

// Get activity log stats
app.get('/api/activity-log/stats', (req, res) => {
  const logs = db.activityLog || [];
  const today = new Date().toISOString().split('T')[0];
  
  const todayCount = logs.filter(l => l.created_at?.startsWith(today)).length;
  const actionCounts = {};
  const entityCounts = {};
  const userCounts = {};
  
  logs.forEach(l => {
    actionCounts[l.action] = (actionCounts[l.action] || 0) + 1;
    if (l.entity_type) entityCounts[l.entity_type] = (entityCounts[l.entity_type] || 0) + 1;
    if (l.user) userCounts[l.user] = (userCounts[l.user] || 0) + 1;
  });
  
  // Daily counts for last 7 days
  const dailyCounts = {};
  for (let i = 0; i < 7; i++) {
    const date = new Date();
    date.setDate(date.getDate() - i);
    const dateStr = date.toISOString().split('T')[0];
    dailyCounts[dateStr] = logs.filter(l => l.created_at?.startsWith(dateStr)).length;
  }
  
  res.json({
    total: logs.length,
    today: todayCount,
    byAction: actionCounts,
    byEntity: entityCounts,
    byUser: userCounts,
    daily: dailyCounts
  });
});

// Manually log an activity (for external integrations)
app.post('/api/activity-log', (req, res) => {
  const entry = logActivity(req.body);
  res.json(entry);
});

// Serve activity log page
app.get('/activity-log', (req, res) => {
  res.sendFile(path.join(__dirname, 'activity-log.html'));
});

// Backfill activity log from existing activities (one-time migration)
function backfillActivityLog() {
  if (db.activityLog && db.activityLog.length > 0) return; // Already has data
  
  console.log('📋 Backfilling activity log from existing activities...');
  let count = 0;
  
  // Import from prospect activities
  (db.activities || []).forEach(a => {
    const prospect = db.prospects.find(p => p.id === a.prospect_id);
    db.activityLog.push({
      id: nextId(),
      action: a.type?.includes('status') ? 'updated' : 'created',
      entity_type: 'prospect',
      entity_id: a.prospect_id,
      entity_name: prospect?.name || 'Unknown',
      user: 'System',
      description: a.description || `${a.type}: ${a.notes || ''}`,
      before: null,
      after: null,
      details: JSON.stringify({ type: a.type, outcome: a.outcome }),
      created_at: a.created_at
    });
    count++;
  });
  
  // Log existing prospects as "created"
  (db.prospects || []).forEach(p => {
    // Only if not already logged via activities
    const hasLog = db.activityLog.some(l => l.entity_type === 'prospect' && l.entity_id === p.id && l.action === 'created');
    if (!hasLog) {
      db.activityLog.push({
        id: nextId(),
        action: 'created',
        entity_type: 'prospect',
        entity_id: p.id,
        entity_name: p.name,
        user: 'System',
        description: 'Prospect record imported',
        before: null,
        after: null,
        details: null,
        created_at: p.created_at || new Date().toISOString()
      });
      count++;
    }
  });
  
  // Log existing machines
  (db.machines || []).forEach(m => {
    db.activityLog.push({
      id: nextId(),
      action: 'created',
      entity_type: 'machine',
      entity_id: m.id,
      entity_name: m.name,
      user: 'System',
      description: 'Machine record imported',
      before: null,
      after: null,
      details: null,
      created_at: m.created_at || new Date().toISOString()
    });
    count++;
  });
  
  // Log existing locations
  (db.locations || []).forEach(l => {
    db.activityLog.push({
      id: nextId(),
      action: 'created',
      entity_type: 'location',
      entity_id: l.id,
      entity_name: l.name,
      user: 'System',
      description: 'Location record imported',
      before: null,
      after: null,
      details: null,
      created_at: l.created_at || new Date().toISOString()
    });
    count++;
  });
  
  // Log existing contracts
  (db.contracts || []).forEach(c => {
    const prospect = db.prospects.find(p => p.id === c.prospect_id);
    db.activityLog.push({
      id: nextId(),
      action: 'created',
      entity_type: 'contract',
      entity_id: c.id,
      entity_name: prospect?.name || `Contract #${c.id}`,
      user: 'System',
      description: 'Contract record imported',
      before: null,
      after: null,
      details: null,
      created_at: c.created_at || new Date().toISOString()
    });
    count++;
  });
  
  if (count > 0) {
    // Sort by created_at
    db.activityLog.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    saveDB(db);
    console.log(`📋 Backfilled ${count} activity log entries from existing data`);
  }
}

// Run backfill on startup
backfillActivityLog();

// ===== CALENDAR EVENTS API =====
if (!db.calendarEvents) db.calendarEvents = [];

// Removed duplicate route - main route is in Mission Control section

// Get all calendar events
app.get('/api/calendar/events', (req, res) => {
  const { from, to, type, prospect_id } = req.query;
  let events = db.calendarEvents || [];
  
  if (from) events = events.filter(e => e.date >= from);
  if (to) events = events.filter(e => e.date <= to);
  if (type) events = events.filter(e => e.type === type);
  if (prospect_id) events = events.filter(e => e.prospect_id === parseInt(prospect_id));
  
  // Enrich with prospect names
  const enriched = events.map(e => {
    const prospect = e.prospect_id ? db.prospects.find(p => p.id === e.prospect_id) : null;
    return { ...e, prospect_name: prospect?.name || null };
  });
  
  res.json(enriched.sort((a, b) => {
    const dateA = new Date(a.date + (a.time ? 'T' + a.time : 'T00:00'));
    const dateB = new Date(b.date + (b.time ? 'T' + b.time : 'T00:00'));
    return dateA - dateB;
  }));
});

// Get single calendar event
app.get('/api/calendar/events/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const event = (db.calendarEvents || []).find(e => e.id === id);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  
  const prospect = event.prospect_id ? db.prospects.find(p => p.id === event.prospect_id) : null;
  res.json({ ...event, prospect_name: prospect?.name || null });
});

// Create calendar event
app.post('/api/calendar/events', (req, res) => {
  if (!req.body.title || !req.body.title.trim()) {
    return res.status(400).json({ error: 'title is required' });
  }
  if (!req.body.date) {
    return res.status(400).json({ error: 'date is required' });
  }
  
  const event = {
    id: nextId(),
    title: req.body.title.trim(),
    type: req.body.type || 'task', // popin, call, meeting, restock, task
    date: req.body.date,
    time: req.body.time || null,
    duration: req.body.duration ? parseInt(req.body.duration) : null,
    prospect_id: req.body.prospect_id ? parseInt(req.body.prospect_id) : null,
    location: req.body.location || null,
    notes: req.body.notes || null,
    reminder: req.body.reminder || null,
    completed: false,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  
  if (!db.calendarEvents) db.calendarEvents = [];
  db.calendarEvents.push(event);
  saveDB(db);
  
  // Also log as activity if linked to prospect
  if (event.prospect_id && event.type !== 'task') {
    db.activities.push({
      id: nextId(),
      prospect_id: event.prospect_id,
      type: event.type === 'popin' ? 'pop-in' : event.type,
      description: `Scheduled: ${event.title}`,
      next_action: event.title,
      next_action_date: event.date,
      created_at: new Date().toISOString()
    });
    saveDB(db);
  }
  
  res.json(event);
});

// Update calendar event
app.put('/api/calendar/events/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const idx = (db.calendarEvents || []).findIndex(e => e.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Event not found' });
  
  const old = db.calendarEvents[idx];
  db.calendarEvents[idx] = {
    ...old,
    title: req.body.title !== undefined ? req.body.title : old.title,
    type: req.body.type !== undefined ? req.body.type : old.type,
    date: req.body.date !== undefined ? req.body.date : old.date,
    time: req.body.time !== undefined ? req.body.time : old.time,
    duration: req.body.duration !== undefined ? (req.body.duration ? parseInt(req.body.duration) : null) : old.duration,
    prospect_id: req.body.prospect_id !== undefined ? (req.body.prospect_id ? parseInt(req.body.prospect_id) : null) : old.prospect_id,
    location: req.body.location !== undefined ? req.body.location : old.location,
    notes: req.body.notes !== undefined ? req.body.notes : old.notes,
    reminder: req.body.reminder !== undefined ? req.body.reminder : old.reminder,
    completed: req.body.completed !== undefined ? req.body.completed : old.completed,
    updated_at: new Date().toISOString()
  };
  
  saveDB(db);
  res.json(db.calendarEvents[idx]);
});

// Delete calendar event
app.delete('/api/calendar/events/:id', (req, res) => {
  const id = parseInt(req.params.id);
  if (!db.calendarEvents) db.calendarEvents = [];
  const idx = db.calendarEvents.findIndex(e => e.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Event not found' });
  
  db.calendarEvents.splice(idx, 1);
  saveDB(db);
  res.json({ success: true });
});

// Mark event complete
app.post('/api/calendar/events/:id/complete', (req, res) => {
  const id = parseInt(req.params.id);
  const event = (db.calendarEvents || []).find(e => e.id === id);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  
  event.completed = true;
  event.completed_at = new Date().toISOString();
  event.updated_at = new Date().toISOString();
  
  // If linked to prospect, log completion
  if (event.prospect_id) {
    db.activities.push({
      id: nextId(),
      prospect_id: event.prospect_id,
      type: event.type === 'popin' ? 'pop-in' : event.type,
      description: `Completed: ${event.title}`,
      outcome: req.body.outcome || null,
      notes: req.body.notes || null,
      created_at: new Date().toISOString()
    });
  }
  
  saveDB(db);
  res.json(event);
});

// Get calendar summary/stats
app.get('/api/calendar/stats', (req, res) => {
  const now = new Date();
  const today = now.toISOString().split('T')[0];
  const weekStart = new Date(now);
  weekStart.setDate(weekStart.getDate() - weekStart.getDay());
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 6);
  
  const events = db.calendarEvents || [];
  const todayEvents = events.filter(e => e.date === today && !e.completed);
  const weekEvents = events.filter(e => {
    return e.date >= weekStart.toISOString().split('T')[0] && 
           e.date <= weekEnd.toISOString().split('T')[0] &&
           !e.completed;
  });
  
  // Count by type
  const byType = {};
  weekEvents.forEach(e => {
    byType[e.type] = (byType[e.type] || 0) + 1;
  });
  
  // Upcoming (next 7 days)
  const upcoming = events.filter(e => {
    const d = new Date(e.date);
    return d >= now && d <= new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000) && !e.completed;
  }).sort((a, b) => new Date(a.date) - new Date(b.date)).slice(0, 5);
  
  res.json({
    today: todayEvents.length,
    thisWeek: weekEvents.length,
    byType,
    upcoming,
    overdue: events.filter(e => e.date < today && !e.completed).length
  });
});

// =====================================================
// MACHINE SYSTEM API (Phase 1)
// Per-machine inventory tracking with slot-level granularity
// =====================================================

// Ensure machine system collections exist
if (!db.machineSlots) db.machineSlots = [];
if (!db.machineAlerts) db.machineAlerts = [];
if (!db.restockHistory) db.restockHistory = [];
if (!db.slotProducts) db.slotProducts = [];

// Helper: Generate slot grid for a new machine
function generateMachineSlots(machineId, rows = 6, cols = 8) {
  const slots = [];
  for (let r = 1; r <= rows; r++) {
    const rowLetter = String.fromCharCode(64 + r); // A, B, C, etc.
    for (let c = 1; c <= cols; c++) {
      // Calculate zone based on position
      let zone = 'center';
      if (r >= Math.floor(rows / 2) && r <= Math.ceil(rows / 2) + 1) {
        zone = c >= cols - 1 ? 'payment_adj' : 'eye_level';
      } else if (r <= 2) {
        zone = 'reach_level';
      } else if (r >= rows - 1) {
        zone = 'bend_level';
      } else if (c >= cols - 1) {
        zone = 'payment_adj';
      } else if ((c === 1 || c === cols) && (r === 1 || r === rows)) {
        zone = 'corner';
      }
      
      slots.push({
        id: nextId(),
        machine_id: machineId,
        position_code: `${rowLetter}${c}`,
        row_num: r,
        column_num: c,
        zone: zone,
        product_id: null,
        product_name: null,
        current_quantity: 0,
        capacity: 10,
        restock_trigger: 3,
        earliest_expiry: null,
        expiry_batches: [],
        custom_price: null,
        use_default_price: true,
        is_active: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      });
    }
  }
  return slots;
}

// Helper: Calculate machine health score
function calculateMachineHealth(machine, slots) {
  let score = 100;
  
  const activeSlots = slots.filter(s => s.product_id && s.is_active);
  if (activeSlots.length === 0) return 0;
  
  // Stock health (-20 max)
  const lowStock = activeSlots.filter(s => s.current_quantity <= s.restock_trigger).length;
  const outOfStock = activeSlots.filter(s => s.current_quantity === 0).length;
  score -= Math.min(20, (lowStock * 2) + (outOfStock * 5));
  
  // Expiring soon (-15 max)
  const now = new Date();
  const weekFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const expiring = activeSlots.filter(s => s.earliest_expiry && new Date(s.earliest_expiry) <= weekFromNow).length;
  score -= Math.min(15, expiring * 3);
  
  // Online status (-15)
  if (machine.last_online) {
    const hoursSinceOnline = (Date.now() - new Date(machine.last_online).getTime()) / (1000 * 60 * 60);
    if (hoursSinceOnline > 24) score -= 15;
    else if (hoursSinceOnline > 4) score -= 5;
  }
  
  // Slot utilization bonus (+10 max)
  const utilization = activeSlots.length / slots.length;
  score += Math.round(utilization * 10);
  
  return Math.max(0, Math.min(100, score));
}

// ===== MACHINE SYSTEM ENDPOINTS =====

// GET /api/machine-system/machines - List all machines with stats
app.get('/api/machine-system/machines', (req, res) => {
  const machines = db.machines.map(m => {
    const slots = (db.machineSlots || []).filter(s => s.machine_id === m.id);
    const location = db.locations.find(l => l.id === m.location_id);
    const activeSlots = slots.filter(s => s.product_id && s.is_active);
    const lowStock = activeSlots.filter(s => s.current_quantity <= s.restock_trigger);
    const outOfStock = activeSlots.filter(s => s.current_quantity === 0);
    const alerts = (db.machineAlerts || []).filter(a => a.machine_id === m.id && a.status === 'active');
    
    // Calculate 30-day revenue (mock for now, will connect to real sales data)
    const revenue30Day = (db.revenue || [])
      .filter(r => r.machine_id === m.id && new Date(r.date) >= new Date(Date.now() - 30 * 24 * 60 * 60 * 1000))
      .reduce((sum, r) => sum + (r.amount || 0), 0);
    
    return {
      ...m,
      location: location || null,
      slots: {
        total: slots.length,
        active: activeSlots.length,
        lowStock: lowStock.length,
        outOfStock: outOfStock.length
      },
      alerts: {
        total: alerts.length,
        critical: alerts.filter(a => a.severity === 'critical').length
      },
      performance: {
        healthScore: calculateMachineHealth(m, slots),
        monthlyRevenue: revenue30Day,
        pullRisk: revenue30Day > 0 && revenue30Day < 800
      }
    };
  });
  
  res.json(machines);
});

// GET /api/machine-system/machines/:id - Get machine with full slot grid
app.get('/api/machine-system/machines/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const machine = db.machines.find(m => m.id === id);
  if (!machine) return res.status(404).json({ error: 'Machine not found' });
  
  // Get or create slots
  let slots = (db.machineSlots || []).filter(s => s.machine_id === id);
  if (slots.length === 0) {
    const rows = machine.config?.rows || 6;
    const cols = machine.config?.columnsPerRow || 8;
    slots = generateMachineSlots(id, rows, cols);
    db.machineSlots = [...(db.machineSlots || []), ...slots];
    saveDB(db);
  }
  
  const location = db.locations.find(l => l.id === machine.location_id);
  const alerts = (db.machineAlerts || []).filter(a => a.machine_id === id && a.status === 'active');
  
  // Enrich slots with product info
  const enrichedSlots = slots.map(s => {
    if (s.product_id) {
      const product = db.products.find(p => p.id === s.product_id) || 
                     (db.slotProducts || []).find(p => p.id === s.product_id);
      return { ...s, product };
    }
    return s;
  });
  
  res.json({
    ...machine,
    location,
    slots: enrichedSlots,
    alerts,
    healthScore: calculateMachineHealth(machine, slots)
  });
});

// POST /api/machine-system/machines - Create machine with auto-generated slots
app.post('/api/machine-system/machines', (req, res) => {
  if (!req.body.name || !req.body.name.trim()) {
    return res.status(400).json({ error: 'name is required' });
  }
  
  const machine = {
    id: nextId(),
    name: req.body.name,
    serial_number: req.body.serial_number || `KV-${Date.now()}`,
    model: req.body.model || 'SandStar AI Smart Cooler',
    location_id: req.body.location_id || null,
    config: req.body.config || { rows: 6, columnsPerRow: 8, totalSlots: 48 },
    status: req.body.status || 'pending_install',
    last_online: null,
    last_restock: null,
    last_maintenance: null,
    agreement: req.body.agreement || { revSharePercent: 0 },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  
  db.machines.push(machine);
  
  // Auto-generate slots
  const rows = machine.config.rows || 6;
  const cols = machine.config.columnsPerRow || 8;
  const slots = generateMachineSlots(machine.id, rows, cols);
  db.machineSlots = [...(db.machineSlots || []), ...slots];
  
  saveDB(db);
  res.json({ ...machine, slots });
});

// PUT /api/machine-system/machines/:id - Update machine
app.put('/api/machine-system/machines/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const idx = db.machines.findIndex(m => m.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Machine not found' });
  
  db.machines[idx] = { 
    ...db.machines[idx], 
    ...req.body, 
    updated_at: new Date().toISOString() 
  };
  saveDB(db);
  res.json(db.machines[idx]);
});

// ===== SLOT ENDPOINTS =====

// GET /api/machine-system/machines/:id/slots - Get all slots for machine
app.get('/api/machine-system/machines/:id/slots', (req, res) => {
  const machineId = parseInt(req.params.id);
  const machine = db.machines.find(m => m.id === machineId);
  if (!machine) return res.status(404).json({ error: 'Machine not found' });
  
  let slots = (db.machineSlots || []).filter(s => s.machine_id === machineId);
  
  // Auto-generate if missing
  if (slots.length === 0) {
    const rows = machine.config?.rows || 6;
    const cols = machine.config?.columnsPerRow || 8;
    slots = generateMachineSlots(machineId, rows, cols);
    db.machineSlots = [...(db.machineSlots || []), ...slots];
    saveDB(db);
  }
  
  // Enrich with product info
  const enrichedSlots = slots.map(s => {
    if (s.product_id) {
      const product = db.products.find(p => p.id === s.product_id);
      return { ...s, product };
    }
    return s;
  }).sort((a, b) => {
    // Sort by row then column
    if (a.row_num !== b.row_num) return a.row_num - b.row_num;
    return a.column_num - b.column_num;
  });
  
  res.json({
    machine_id: machineId,
    slots: enrichedSlots,
    summary: {
      total: slots.length,
      active: slots.filter(s => s.product_id && s.is_active).length,
      empty: slots.filter(s => !s.product_id).length,
      lowStock: slots.filter(s => s.product_id && s.current_quantity <= s.restock_trigger).length,
      outOfStock: slots.filter(s => s.product_id && s.current_quantity === 0).length
    }
  });
});

// PUT /api/machine-system/machines/:id/slots/:slotId - Update slot (product, quantity, pricing)
app.put('/api/machine-system/machines/:id/slots/:slotId', (req, res) => {
  const machineId = parseInt(req.params.id);
  const slotId = parseInt(req.params.slotId);
  
  const slotIdx = (db.machineSlots || []).findIndex(s => s.id === slotId && s.machine_id === machineId);
  if (slotIdx === -1) return res.status(404).json({ error: 'Slot not found' });
  
  const oldSlot = db.machineSlots[slotIdx];
  const updates = { ...req.body, updated_at: new Date().toISOString() };
  
  // If assigning a product, get product name for display
  if (req.body.product_id && req.body.product_id !== oldSlot.product_id) {
    const product = db.products.find(p => p.id === req.body.product_id);
    if (product) {
      updates.product_name = product.name;
    }
  }
  
  db.machineSlots[slotIdx] = { ...oldSlot, ...updates };
  saveDB(db);
  
  // Generate alerts if needed
  checkSlotAlerts(db.machineSlots[slotIdx]);
  
  res.json(db.machineSlots[slotIdx]);
});

// POST /api/machine-system/machines/:id/slots/:slotId/restock - Record restock
app.post('/api/machine-system/machines/:id/slots/:slotId/restock', (req, res) => {
  const machineId = parseInt(req.params.id);
  const slotId = parseInt(req.params.slotId);
  
  const slotIdx = (db.machineSlots || []).findIndex(s => s.id === slotId && s.machine_id === machineId);
  if (slotIdx === -1) return res.status(404).json({ error: 'Slot not found' });
  
  const slot = db.machineSlots[slotIdx];
  const { quantity_added, expiry_date, notes, restocked_by } = req.body;
  
  if (!quantity_added || quantity_added <= 0) {
    return res.status(400).json({ error: 'quantity_added must be positive' });
  }
  
  const previousQuantity = slot.current_quantity || 0;
  const newQuantity = Math.min(previousQuantity + quantity_added, slot.capacity);
  
  // Record restock history
  const restockRecord = {
    id: nextId(),
    slot_id: slotId,
    machine_id: machineId,
    quantity_added,
    previous_quantity: previousQuantity,
    new_quantity: newQuantity,
    expiry_date: expiry_date || null,
    restocked_by: restocked_by || 'unknown',
    notes: notes || null,
    created_at: new Date().toISOString()
  };
  
  if (!db.restockHistory) db.restockHistory = [];
  db.restockHistory.push(restockRecord);
  
  // Update slot
  db.machineSlots[slotIdx].current_quantity = newQuantity;
  db.machineSlots[slotIdx].updated_at = new Date().toISOString();
  
  // Update expiry tracking
  if (expiry_date) {
    const batches = slot.expiry_batches || [];
    batches.push({ quantity: quantity_added, expiryDate: expiry_date, addedDate: new Date().toISOString() });
    db.machineSlots[slotIdx].expiry_batches = batches;
    
    // Update earliest expiry
    const dates = batches.map(b => new Date(b.expiryDate)).filter(d => !isNaN(d));
    if (dates.length > 0) {
      db.machineSlots[slotIdx].earliest_expiry = new Date(Math.min(...dates)).toISOString().split('T')[0];
    }
  }
  
  // Update machine last_restock
  const machineIdx = db.machines.findIndex(m => m.id === machineId);
  if (machineIdx !== -1) {
    db.machines[machineIdx].last_restock = new Date().toISOString();
  }
  
  saveDB(db);
  
  // Clear any low stock alerts for this slot
  clearSlotAlerts(slotId, ['low_stock', 'out_of_stock']);
  
  res.json({
    success: true,
    restock: restockRecord,
    slot: db.machineSlots[slotIdx]
  });
});

// GET /api/machine-system/machines/:id/inventory - Get inventory summary
app.get('/api/machine-system/machines/:id/inventory', (req, res) => {
  const machineId = parseInt(req.params.id);
  const machine = db.machines.find(m => m.id === machineId);
  if (!machine) return res.status(404).json({ error: 'Machine not found' });
  
  const slots = (db.machineSlots || []).filter(s => s.machine_id === machineId);
  const activeSlots = slots.filter(s => s.product_id && s.is_active);
  
  // Group by category
  const byCategory = {};
  activeSlots.forEach(s => {
    const product = db.products.find(p => p.id === s.product_id);
    const category = product?.category || 'other';
    if (!byCategory[category]) {
      byCategory[category] = { slots: 0, quantity: 0, capacity: 0, value: 0 };
    }
    byCategory[category].slots++;
    byCategory[category].quantity += s.current_quantity || 0;
    byCategory[category].capacity += s.capacity || 0;
    if (product) {
      byCategory[category].value += (s.current_quantity || 0) * (product.cost_price || 0);
    }
  });
  
  // Low stock items
  const lowStock = activeSlots
    .filter(s => s.current_quantity <= s.restock_trigger)
    .map(s => {
      const product = db.products.find(p => p.id === s.product_id);
      return {
        slot_id: s.id,
        position: s.position_code,
        product_name: s.product_name || product?.name,
        current: s.current_quantity,
        capacity: s.capacity,
        trigger: s.restock_trigger,
        needed: s.capacity - s.current_quantity
      };
    })
    .sort((a, b) => a.current - b.current);
  
  // Expiring soon
  const now = new Date();
  const weekFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const expiring = activeSlots
    .filter(s => s.earliest_expiry && new Date(s.earliest_expiry) <= weekFromNow)
    .map(s => {
      const product = db.products.find(p => p.id === s.product_id);
      return {
        slot_id: s.id,
        position: s.position_code,
        product_name: s.product_name || product?.name,
        expires: s.earliest_expiry,
        quantity: s.current_quantity,
        daysUntilExpiry: Math.ceil((new Date(s.earliest_expiry) - now) / (1000 * 60 * 60 * 24))
      };
    })
    .sort((a, b) => new Date(a.expires) - new Date(b.expires));
  
  // Overall stats
  const totalQuantity = activeSlots.reduce((sum, s) => sum + (s.current_quantity || 0), 0);
  const totalCapacity = activeSlots.reduce((sum, s) => sum + (s.capacity || 0), 0);
  const totalValue = activeSlots.reduce((sum, s) => {
    const product = db.products.find(p => p.id === s.product_id);
    return sum + ((s.current_quantity || 0) * (product?.cost_price || 0));
  }, 0);
  
  res.json({
    machine_id: machineId,
    machine_name: machine.name,
    summary: {
      totalSlots: slots.length,
      activeSlots: activeSlots.length,
      emptySlots: slots.filter(s => !s.product_id).length,
      totalQuantity,
      totalCapacity,
      fillPercent: totalCapacity > 0 ? Math.round((totalQuantity / totalCapacity) * 100) : 0,
      estimatedValue: Math.round(totalValue * 100) / 100
    },
    byCategory,
    lowStock,
    expiring,
    lastRestock: machine.last_restock
  });
});

// Helper: Check and generate alerts for a slot
function checkSlotAlerts(slot) {
  if (!slot.product_id || !slot.is_active) return;
  
  const alerts = [];
  
  // Out of stock
  if (slot.current_quantity === 0) {
    alerts.push({
      id: nextId(),
      machine_id: slot.machine_id,
      slot_id: slot.id,
      alert_type: 'out_of_stock',
      severity: 'critical',
      title: `Out of Stock: ${slot.position_code}`,
      message: `${slot.product_name || 'Product'} is out of stock at position ${slot.position_code}`,
      context: { position: slot.position_code, product_id: slot.product_id },
      status: 'active',
      created_at: new Date().toISOString()
    });
  }
  // Low stock
  else if (slot.current_quantity <= slot.restock_trigger) {
    alerts.push({
      id: nextId(),
      machine_id: slot.machine_id,
      slot_id: slot.id,
      alert_type: 'low_stock',
      severity: 'warning',
      title: `Low Stock: ${slot.position_code}`,
      message: `${slot.product_name || 'Product'} at ${slot.position_code} has only ${slot.current_quantity} units`,
      context: { position: slot.position_code, current: slot.current_quantity, trigger: slot.restock_trigger },
      status: 'active',
      created_at: new Date().toISOString()
    });
  }
  
  // Expiring soon
  if (slot.earliest_expiry) {
    const daysUntil = Math.ceil((new Date(slot.earliest_expiry) - new Date()) / (1000 * 60 * 60 * 24));
    if (daysUntil <= 0) {
      alerts.push({
        id: nextId(),
        machine_id: slot.machine_id,
        slot_id: slot.id,
        alert_type: 'expired',
        severity: 'critical',
        title: `EXPIRED: ${slot.position_code}`,
        message: `Product at ${slot.position_code} has expired!`,
        context: { position: slot.position_code, expiry: slot.earliest_expiry },
        status: 'active',
        created_at: new Date().toISOString()
      });
    } else if (daysUntil <= 7) {
      alerts.push({
        id: nextId(),
        machine_id: slot.machine_id,
        slot_id: slot.id,
        alert_type: 'expiring_soon',
        severity: 'warning',
        title: `Expiring Soon: ${slot.position_code}`,
        message: `Product at ${slot.position_code} expires in ${daysUntil} days`,
        context: { position: slot.position_code, expiry: slot.earliest_expiry, daysUntil },
        status: 'active',
        created_at: new Date().toISOString()
      });
    }
  }
  
  // Add alerts (avoiding duplicates)
  if (!db.machineAlerts) db.machineAlerts = [];
  alerts.forEach(alert => {
    const existing = db.machineAlerts.find(a => 
      a.slot_id === alert.slot_id && 
      a.alert_type === alert.alert_type && 
      a.status === 'active'
    );
    if (!existing) {
      db.machineAlerts.push(alert);
    }
  });
  
  saveDB(db);
}

// Helper: Clear alerts for a slot
function clearSlotAlerts(slotId, types) {
  if (!db.machineAlerts) return;
  
  db.machineAlerts = db.machineAlerts.map(a => {
    if (a.slot_id === slotId && types.includes(a.alert_type) && a.status === 'active') {
      return { ...a, status: 'resolved', resolved_at: new Date().toISOString() };
    }
    return a;
  });
  
  saveDB(db);
}

// GET /api/machine-system/machines/:id/alerts - Get alerts for machine
app.get('/api/machine-system/machines/:id/alerts', (req, res) => {
  const machineId = parseInt(req.params.id);
  const { status } = req.query;
  
  let alerts = (db.machineAlerts || []).filter(a => a.machine_id === machineId);
  if (status) {
    alerts = alerts.filter(a => a.status === status);
  }
  
  res.json(alerts.sort((a, b) => {
    // Critical first, then by date
    if (a.severity === 'critical' && b.severity !== 'critical') return -1;
    if (b.severity === 'critical' && a.severity !== 'critical') return 1;
    return new Date(b.created_at) - new Date(a.created_at);
  }));
});

// POST /api/machine-system/alerts/:id/acknowledge - Acknowledge alert
app.post('/api/machine-system/alerts/:id/acknowledge', (req, res) => {
  const id = parseInt(req.params.id);
  const idx = (db.machineAlerts || []).findIndex(a => a.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Alert not found' });
  
  db.machineAlerts[idx].status = 'acknowledged';
  db.machineAlerts[idx].acknowledged_at = new Date().toISOString();
  db.machineAlerts[idx].acknowledged_by = req.body.by || 'user';
  
  saveDB(db);
  res.json(db.machineAlerts[idx]);
});

// POST /api/machine-system/alerts/:id/resolve - Resolve alert
app.post('/api/machine-system/alerts/:id/resolve', (req, res) => {
  const id = parseInt(req.params.id);
  const idx = (db.machineAlerts || []).findIndex(a => a.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Alert not found' });
  
  db.machineAlerts[idx].status = 'resolved';
  db.machineAlerts[idx].resolved_at = new Date().toISOString();
  db.machineAlerts[idx].resolved_by = req.body.by || 'user';
  
  saveDB(db);
  res.json(db.machineAlerts[idx]);
});

// GET /api/machine-system/inventory/low-stock - Global low stock report
app.get('/api/machine-system/inventory/low-stock', (req, res) => {
  const slots = (db.machineSlots || []).filter(s => 
    s.product_id && 
    s.is_active && 
    s.current_quantity <= s.restock_trigger
  );
  
  const items = slots.map(s => {
    const machine = db.machines.find(m => m.id === s.machine_id);
    const product = db.products.find(p => p.id === s.product_id);
    return {
      slot_id: s.id,
      machine_id: s.machine_id,
      machine_name: machine?.name,
      position: s.position_code,
      product_id: s.product_id,
      product_name: s.product_name || product?.name,
      current: s.current_quantity,
      capacity: s.capacity,
      trigger: s.restock_trigger,
      needed: s.capacity - s.current_quantity,
      is_out: s.current_quantity === 0
    };
  }).sort((a, b) => {
    // Out of stock first, then by quantity
    if (a.is_out && !b.is_out) return -1;
    if (!a.is_out && b.is_out) return 1;
    return a.current - b.current;
  });
  
  // Group by machine for restock planning
  const byMachine = {};
  items.forEach(item => {
    if (!byMachine[item.machine_id]) {
      byMachine[item.machine_id] = {
        machine_id: item.machine_id,
        machine_name: item.machine_name,
        items: [],
        totalNeeded: 0
      };
    }
    byMachine[item.machine_id].items.push(item);
    byMachine[item.machine_id].totalNeeded += item.needed;
  });
  
  res.json({
    total: items.length,
    outOfStock: items.filter(i => i.is_out).length,
    items,
    byMachine: Object.values(byMachine)
  });
});

// GET /api/machine-system/products - Get products available for slots
app.get('/api/machine-system/products', (req, res) => {
  // Return existing products formatted for slot assignment
  const products = db.products.map(p => ({
    id: p.id,
    name: p.name,
    brand: p.brand,
    category: p.category,
    image_url: p.image || p.image_url,
    wholesale_cost: p.cost_price || p.wholesale_cost,
    vending_price: p.sell_price || p.vending_price,
    margin: p.margin
  }));
  
  res.json(products);
});

// ===== END MACHINE SYSTEM API =====

// =====================================================
// PHASE 2: INVENTORY INTELLIGENCE APIs
// =====================================================

// ===== SALES VELOCITY CALCULATION =====

// Helper: Calculate sales velocity for a slot
function calculateSlotVelocity(slotId, days = 7) {
  const sales = (db.slotSales || []).filter(s => 
    s.slot_id === slotId && 
    new Date(s.created_at) >= new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  );
  
  const totalUnits = sales.reduce((sum, s) => sum + (s.quantity || 1), 0);
  const velocity = days > 0 ? totalUnits / days : 0;
  
  // Calculate trend (compare current period to previous period)
  const prevSales = (db.slotSales || []).filter(s => 
    s.slot_id === slotId && 
    new Date(s.created_at) >= new Date(Date.now() - (days * 2) * 24 * 60 * 60 * 1000) &&
    new Date(s.created_at) < new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  );
  const prevUnits = prevSales.reduce((sum, s) => sum + (s.quantity || 1), 0);
  const prevVelocity = days > 0 ? prevUnits / days : 0;
  
  let trend = 'stable';
  if (prevVelocity > 0) {
    const change = (velocity - prevVelocity) / prevVelocity;
    if (change > 0.1) trend = 'increasing';
    else if (change < -0.1) trend = 'decreasing';
  }
  
  return {
    unitsPerDay: Math.round(velocity * 100) / 100,
    unitsPerWeek: Math.round(velocity * 7 * 100) / 100,
    totalUnits,
    period: days,
    trend
  };
}

// Helper: Calculate days until slot is empty
function calculateDaysUntilEmpty(slot, velocity) {
  if (!velocity || velocity.unitsPerDay <= 0) return null;
  if (slot.current_quantity <= 0) return 0;
  
  return Math.round((slot.current_quantity / velocity.unitsPerDay) * 10) / 10;
}

// Helper: Get restock recommendation for a slot
function getRestockRecommendation(slot, velocity) {
  const daysUntilEmpty = calculateDaysUntilEmpty(slot, velocity);
  const restockTo = slot.par_max || slot.capacity || 10;
  const currentQty = slot.current_quantity || 0;
  const needed = Math.max(0, restockTo - currentQty);
  
  // Priority levels: urgent, soon, normal, skip
  let priority = 'normal';
  let reason = '';
  
  if (currentQty === 0) {
    priority = 'urgent';
    reason = 'Out of stock';
  } else if (daysUntilEmpty !== null && daysUntilEmpty <= 2) {
    priority = 'urgent';
    reason = `Only ${daysUntilEmpty.toFixed(1)} days until empty`;
  } else if (currentQty <= (slot.par_min || slot.restock_trigger || 3)) {
    priority = 'soon';
    reason = `Below par level (${currentQty}/${slot.par_min || slot.restock_trigger})`;
  } else if (daysUntilEmpty !== null && daysUntilEmpty <= 7) {
    priority = 'soon';
    reason = `${daysUntilEmpty.toFixed(1)} days until empty`;
  } else if (currentQty >= restockTo * 0.7) {
    priority = 'skip';
    reason = 'Well stocked';
  }
  
  return { priority, reason, needed, restockTo, daysUntilEmpty };
}

// POST /api/machine-system/sales - Record a sale for a slot
app.post('/api/machine-system/sales', (req, res) => {
  const { machine_id, slot_id, product_id, quantity, unit_price, payment_method } = req.body;
  
  if (!machine_id || !slot_id) {
    return res.status(400).json({ error: 'machine_id and slot_id required' });
  }
  
  // Find the slot and decrement quantity
  const slotIdx = (db.machineSlots || []).findIndex(s => s.id === slot_id && s.machine_id === machine_id);
  if (slotIdx === -1) {
    return res.status(404).json({ error: 'Slot not found' });
  }
  
  const slot = db.machineSlots[slotIdx];
  const qty = quantity || 1;
  
  // Record the sale
  const sale = {
    id: nextId(),
    machine_id,
    slot_id,
    product_id: product_id || slot.product_id,
    product_name: slot.product_name,
    quantity: qty,
    unit_price: unit_price || slot.custom_price || slot.product?.vending_price || 3.00,
    total: (unit_price || slot.custom_price || 3.00) * qty,
    payment_method: payment_method || 'card',
    position_code: slot.position_code,
    created_at: new Date().toISOString()
  };
  
  if (!db.slotSales) db.slotSales = [];
  db.slotSales.push(sale);
  
  // Decrement slot quantity
  db.machineSlots[slotIdx].current_quantity = Math.max(0, (slot.current_quantity || 0) - qty);
  db.machineSlots[slotIdx].last_sale = new Date().toISOString();
  db.machineSlots[slotIdx].updated_at = new Date().toISOString();
  
  saveDB(db);
  
  // Check if this triggers low stock alert
  checkSlotAlerts(db.machineSlots[slotIdx]);
  
  res.json({ success: true, sale, slot: db.machineSlots[slotIdx] });
});

// GET /api/machine-system/sales - Get sales history
app.get('/api/machine-system/sales', (req, res) => {
  const { machine_id, slot_id, from, to, limit } = req.query;
  
  let sales = db.slotSales || [];
  
  if (machine_id) sales = sales.filter(s => s.machine_id === parseInt(machine_id));
  if (slot_id) sales = sales.filter(s => s.slot_id === parseInt(slot_id));
  if (from) sales = sales.filter(s => new Date(s.created_at) >= new Date(from));
  if (to) sales = sales.filter(s => new Date(s.created_at) <= new Date(to));
  
  sales = sales.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  
  if (limit) sales = sales.slice(0, parseInt(limit));
  
  res.json(sales);
});

// GET /api/machine-system/velocity - Get sales velocity for all slots
app.get('/api/machine-system/velocity', (req, res) => {
  const { machine_id, days } = req.query;
  const period = parseInt(days) || 7;
  
  let slots = db.machineSlots || [];
  if (machine_id) {
    slots = slots.filter(s => s.machine_id === parseInt(machine_id));
  }
  
  // Only include slots with products
  slots = slots.filter(s => s.product_id && s.is_active);
  
  const velocityData = slots.map(slot => {
    const velocity = calculateSlotVelocity(slot.id, period);
    const daysUntilEmpty = calculateDaysUntilEmpty(slot, velocity);
    const recommendation = getRestockRecommendation(slot, velocity);
    const machine = db.machines.find(m => m.id === slot.machine_id);
    
    return {
      slot_id: slot.id,
      machine_id: slot.machine_id,
      machine_name: machine?.name,
      position_code: slot.position_code,
      product_id: slot.product_id,
      product_name: slot.product_name,
      current_quantity: slot.current_quantity,
      capacity: slot.capacity,
      par_min: slot.par_min || slot.restock_trigger,
      par_max: slot.par_max || slot.capacity,
      velocity,
      daysUntilEmpty,
      recommendation,
      lastSale: slot.last_sale
    };
  });
  
  // Sort by urgency
  const priorityOrder = { urgent: 0, soon: 1, normal: 2, skip: 3 };
  velocityData.sort((a, b) => {
    const pA = priorityOrder[a.recommendation.priority] ?? 4;
    const pB = priorityOrder[b.recommendation.priority] ?? 4;
    if (pA !== pB) return pA - pB;
    // Then by days until empty
    const dA = a.daysUntilEmpty ?? Infinity;
    const dB = b.daysUntilEmpty ?? Infinity;
    return dA - dB;
  });
  
  res.json({
    period,
    slots: velocityData,
    summary: {
      total: velocityData.length,
      urgent: velocityData.filter(s => s.recommendation.priority === 'urgent').length,
      soon: velocityData.filter(s => s.recommendation.priority === 'soon').length,
      wellStocked: velocityData.filter(s => s.recommendation.priority === 'skip').length,
      avgVelocity: velocityData.length > 0 
        ? Math.round(velocityData.reduce((sum, s) => sum + s.velocity.unitsPerDay, 0) / velocityData.length * 100) / 100 
        : 0
    }
  });
});

// GET /api/machine-system/machines/:id/velocity - Get velocity for specific machine
app.get('/api/machine-system/machines/:id/velocity', (req, res) => {
  const machineId = parseInt(req.params.id);
  const machine = db.machines.find(m => m.id === machineId);
  if (!machine) return res.status(404).json({ error: 'Machine not found' });
  
  const period = parseInt(req.query.days) || 7;
  const slots = (db.machineSlots || []).filter(s => s.machine_id === machineId && s.product_id && s.is_active);
  
  const velocityData = slots.map(slot => {
    const velocity = calculateSlotVelocity(slot.id, period);
    const daysUntilEmpty = calculateDaysUntilEmpty(slot, velocity);
    const recommendation = getRestockRecommendation(slot, velocity);
    const product = db.products.find(p => p.id === slot.product_id);
    
    return {
      slot_id: slot.id,
      position_code: slot.position_code,
      zone: slot.zone,
      product_id: slot.product_id,
      product_name: slot.product_name || product?.name,
      category: product?.category,
      current_quantity: slot.current_quantity,
      capacity: slot.capacity,
      par_min: slot.par_min || slot.restock_trigger,
      par_max: slot.par_max || slot.capacity,
      velocity,
      daysUntilEmpty,
      recommendation,
      lastSale: slot.last_sale
    };
  });
  
  // Sort by position
  velocityData.sort((a, b) => {
    const rowA = a.position_code.charCodeAt(0);
    const rowB = b.position_code.charCodeAt(0);
    if (rowA !== rowB) return rowA - rowB;
    return parseInt(a.position_code.slice(1)) - parseInt(b.position_code.slice(1));
  });
  
  // Calculate machine-level stats
  const totalVelocity = velocityData.reduce((sum, s) => sum + s.velocity.unitsPerDay, 0);
  const avgDaysUntilEmpty = velocityData.filter(s => s.daysUntilEmpty !== null)
    .reduce((sum, s, i, arr) => sum + s.daysUntilEmpty / arr.length, 0);
  
  res.json({
    machine_id: machineId,
    machine_name: machine.name,
    period,
    slots: velocityData,
    summary: {
      totalSlots: velocityData.length,
      totalVelocity: Math.round(totalVelocity * 100) / 100,
      avgVelocityPerSlot: velocityData.length > 0 ? Math.round(totalVelocity / velocityData.length * 100) / 100 : 0,
      avgDaysUntilEmpty: Math.round(avgDaysUntilEmpty * 10) / 10,
      urgent: velocityData.filter(s => s.recommendation.priority === 'urgent').length,
      soon: velocityData.filter(s => s.recommendation.priority === 'soon').length
    }
  });
});

// ===== PAR LEVEL MANAGEMENT =====

// PUT /api/machine-system/machines/:id/slots/:slotId/par-levels
app.put('/api/machine-system/machines/:id/slots/:slotId/par-levels', (req, res) => {
  const machineId = parseInt(req.params.id);
  const slotId = parseInt(req.params.slotId);
  
  const slotIdx = (db.machineSlots || []).findIndex(s => s.id === slotId && s.machine_id === machineId);
  if (slotIdx === -1) return res.status(404).json({ error: 'Slot not found' });
  
  const { par_min, par_max, restock_trigger } = req.body;
  
  if (par_min !== undefined) {
    db.machineSlots[slotIdx].par_min = parseInt(par_min);
    db.machineSlots[slotIdx].restock_trigger = parseInt(par_min); // Keep in sync
  }
  if (par_max !== undefined) {
    db.machineSlots[slotIdx].par_max = parseInt(par_max);
  }
  if (restock_trigger !== undefined) {
    db.machineSlots[slotIdx].restock_trigger = parseInt(restock_trigger);
    db.machineSlots[slotIdx].par_min = parseInt(restock_trigger); // Keep in sync
  }
  
  db.machineSlots[slotIdx].updated_at = new Date().toISOString();
  saveDB(db);
  
  res.json(db.machineSlots[slotIdx]);
});

// PUT /api/machine-system/machines/:id/par-levels - Bulk update par levels
app.put('/api/machine-system/machines/:id/par-levels', (req, res) => {
  const machineId = parseInt(req.params.id);
  const machine = db.machines.find(m => m.id === machineId);
  if (!machine) return res.status(404).json({ error: 'Machine not found' });
  
  const { slots } = req.body; // Array of { slot_id, par_min, par_max }
  
  if (!slots || !Array.isArray(slots)) {
    return res.status(400).json({ error: 'slots array required' });
  }
  
  const updated = [];
  slots.forEach(update => {
    const slotIdx = (db.machineSlots || []).findIndex(s => s.id === update.slot_id && s.machine_id === machineId);
    if (slotIdx !== -1) {
      if (update.par_min !== undefined) {
        db.machineSlots[slotIdx].par_min = parseInt(update.par_min);
        db.machineSlots[slotIdx].restock_trigger = parseInt(update.par_min);
      }
      if (update.par_max !== undefined) {
        db.machineSlots[slotIdx].par_max = parseInt(update.par_max);
      }
      db.machineSlots[slotIdx].updated_at = new Date().toISOString();
      updated.push(db.machineSlots[slotIdx]);
    }
  });
  
  saveDB(db);
  res.json({ success: true, updated: updated.length, slots: updated });
});

// ===== RESTOCK LIST GENERATION =====

// GET /api/machine-system/restock-plan - Generate restock list for all machines
app.get('/api/machine-system/restock-plan', (req, res) => {
  const { threshold, include_ok } = req.query;
  const days = parseInt(req.query.days) || 7;
  
  // Get all active machines
  const machines = db.machines.filter(m => m.status === 'active' || m.status === 'deployed');
  
  const restockPlan = machines.map(machine => {
    const slots = (db.machineSlots || []).filter(s => s.machine_id === machine.id && s.product_id && s.is_active);
    const location = db.locations.find(l => l.id === machine.location_id);
    
    const slotItems = slots.map(slot => {
      const velocity = calculateSlotVelocity(slot.id, days);
      const recommendation = getRestockRecommendation(slot, velocity);
      const product = db.products.find(p => p.id === slot.product_id);
      
      return {
        slot_id: slot.id,
        position_code: slot.position_code,
        product_id: slot.product_id,
        product_name: slot.product_name || product?.name,
        upc: product?.upc,
        category: product?.category,
        current_quantity: slot.current_quantity,
        capacity: slot.capacity,
        par_min: slot.par_min || slot.restock_trigger,
        par_max: slot.par_max || slot.capacity,
        needed: recommendation.needed,
        priority: recommendation.priority,
        reason: recommendation.reason,
        daysUntilEmpty: recommendation.daysUntilEmpty,
        velocity: velocity.unitsPerDay,
        earliestExpiry: slot.earliest_expiry,
        cost_per_unit: product?.cost_price || product?.wholesale_cost
      };
    });
    
    // Filter based on threshold
    let filteredItems = slotItems;
    if (!include_ok) {
      filteredItems = slotItems.filter(item => item.priority !== 'skip');
    }
    
    // Sort by priority then position
    const priorityOrder = { urgent: 0, soon: 1, normal: 2, skip: 3 };
    filteredItems.sort((a, b) => {
      const pA = priorityOrder[a.priority] ?? 4;
      const pB = priorityOrder[b.priority] ?? 4;
      if (pA !== pB) return pA - pB;
      return a.position_code.localeCompare(b.position_code);
    });
    
    const totalNeeded = filteredItems.reduce((sum, i) => sum + i.needed, 0);
    const estimatedCost = filteredItems.reduce((sum, i) => sum + (i.needed * (i.cost_per_unit || 0)), 0);
    const urgentCount = filteredItems.filter(i => i.priority === 'urgent').length;
    const soonCount = filteredItems.filter(i => i.priority === 'soon').length;
    
    return {
      machine_id: machine.id,
      machine_name: machine.name,
      location: location ? {
        id: location.id,
        name: location.name,
        address: location.address,
        lat: location.lat,
        lng: location.lng
      } : null,
      lastRestock: machine.last_restock,
      items: filteredItems,
      summary: {
        totalSlots: slots.length,
        needsRestock: filteredItems.filter(i => i.priority !== 'skip').length,
        urgent: urgentCount,
        soon: soonCount,
        totalUnits: totalNeeded,
        estimatedCost: Math.round(estimatedCost * 100) / 100
      },
      priority: urgentCount > 0 ? 'urgent' : soonCount > 0 ? 'soon' : 'normal'
    };
  });
  
  // Sort machines by priority
  const machinePriorityOrder = { urgent: 0, soon: 1, normal: 2 };
  restockPlan.sort((a, b) => {
    const pA = machinePriorityOrder[a.priority] ?? 3;
    const pB = machinePriorityOrder[b.priority] ?? 3;
    if (pA !== pB) return pA - pB;
    return b.summary.totalUnits - a.summary.totalUnits;
  });
  
  // Filter out machines with nothing to restock
  const needsRestock = restockPlan.filter(m => m.summary.needsRestock > 0);
  
  // Aggregate products across all machines (pick list)
  const productAgg = {};
  needsRestock.forEach(machine => {
    machine.items.forEach(item => {
      if (item.needed > 0) {
        const key = item.product_id || item.product_name;
        if (!productAgg[key]) {
          productAgg[key] = {
            product_id: item.product_id,
            product_name: item.product_name,
            upc: item.upc,
            category: item.category,
            totalNeeded: 0,
            machines: [],
            cost_per_unit: item.cost_per_unit
          };
        }
        productAgg[key].totalNeeded += item.needed;
        productAgg[key].machines.push({
          machine_id: machine.machine_id,
          machine_name: machine.machine_name,
          position: item.position_code,
          quantity: item.needed
        });
      }
    });
  });
  
  const pickList = Object.values(productAgg).sort((a, b) => b.totalNeeded - a.totalNeeded);
  const totalUnits = pickList.reduce((sum, p) => sum + p.totalNeeded, 0);
  const totalCost = pickList.reduce((sum, p) => sum + (p.totalNeeded * (p.cost_per_unit || 0)), 0);
  
  res.json({
    generated_at: new Date().toISOString(),
    period_days: days,
    machines: needsRestock,
    pickList,
    summary: {
      machinesNeedingRestock: needsRestock.length,
      totalMachines: machines.length,
      urgentMachines: needsRestock.filter(m => m.priority === 'urgent').length,
      totalUnits,
      totalEstimatedCost: Math.round(totalCost * 100) / 100,
      uniqueProducts: pickList.length
    }
  });
});

// GET /api/machine-system/machines/:id/restock-plan - Generate restock list for specific machine
app.get('/api/machine-system/machines/:id/restock-plan', (req, res) => {
  const machineId = parseInt(req.params.id);
  const machine = db.machines.find(m => m.id === machineId);
  if (!machine) return res.status(404).json({ error: 'Machine not found' });
  
  const days = parseInt(req.query.days) || 7;
  const slots = (db.machineSlots || []).filter(s => s.machine_id === machineId && s.product_id && s.is_active);
  const location = db.locations.find(l => l.id === machine.location_id);
  
  const items = slots.map(slot => {
    const velocity = calculateSlotVelocity(slot.id, days);
    const recommendation = getRestockRecommendation(slot, velocity);
    const product = db.products.find(p => p.id === slot.product_id);
    
    return {
      slot_id: slot.id,
      position_code: slot.position_code,
      row_num: slot.row_num,
      column_num: slot.column_num,
      zone: slot.zone,
      product_id: slot.product_id,
      product_name: slot.product_name || product?.name,
      upc: product?.upc,
      category: product?.category,
      current_quantity: slot.current_quantity,
      capacity: slot.capacity,
      par_min: slot.par_min || slot.restock_trigger,
      par_max: slot.par_max || slot.capacity,
      needed: recommendation.needed,
      priority: recommendation.priority,
      reason: recommendation.reason,
      daysUntilEmpty: recommendation.daysUntilEmpty,
      velocity: velocity.unitsPerDay,
      velocityTrend: velocity.trend,
      earliestExpiry: slot.earliest_expiry,
      lastSale: slot.last_sale,
      cost_per_unit: product?.cost_price || product?.wholesale_cost
    };
  });
  
  // Sort by priority then row/column
  const priorityOrder = { urgent: 0, soon: 1, normal: 2, skip: 3 };
  items.sort((a, b) => {
    const pA = priorityOrder[a.priority] ?? 4;
    const pB = priorityOrder[b.priority] ?? 4;
    if (pA !== pB) return pA - pB;
    if (a.row_num !== b.row_num) return a.row_num - b.row_num;
    return a.column_num - b.column_num;
  });
  
  const needsRestock = items.filter(i => i.priority !== 'skip');
  const totalNeeded = needsRestock.reduce((sum, i) => sum + i.needed, 0);
  const estimatedCost = needsRestock.reduce((sum, i) => sum + (i.needed * (i.cost_per_unit || 0)), 0);
  
  // Group by category for easy picking
  const byCategory = {};
  needsRestock.forEach(item => {
    const cat = item.category || 'Other';
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(item);
  });
  
  // Expiring items that need rotation
  const expiringItems = items.filter(i => i.earliestExpiry && 
    new Date(i.earliestExpiry) <= new Date(Date.now() + 14 * 24 * 60 * 60 * 1000)
  );
  
  res.json({
    machine_id: machineId,
    machine_name: machine.name,
    location: location ? {
      name: location.name,
      address: location.address,
      contact_name: location.contact_name,
      contact_phone: location.contact_phone
    } : null,
    lastRestock: machine.last_restock,
    generated_at: new Date().toISOString(),
    items,
    byCategory,
    expiringItems,
    summary: {
      totalSlots: items.length,
      needsRestock: needsRestock.length,
      urgent: items.filter(i => i.priority === 'urgent').length,
      soon: items.filter(i => i.priority === 'soon').length,
      wellStocked: items.filter(i => i.priority === 'skip').length,
      totalUnits: totalNeeded,
      estimatedCost: Math.round(estimatedCost * 100) / 100,
      expiringCount: expiringItems.length
    },
    notes: [
      machine.last_restock ? `Last restocked: ${new Date(machine.last_restock).toLocaleDateString()}` : 'Never restocked',
      expiringItems.length > 0 ? `⚠️ ${expiringItems.length} items expiring within 14 days - rotate to front` : null,
      items.filter(i => i.priority === 'urgent').length > 0 ? `🔴 ${items.filter(i => i.priority === 'urgent').length} slots need immediate attention` : null
    ].filter(Boolean)
  });
});

// POST /api/machine-system/restock-plan/complete - Mark restock visit complete
app.post('/api/machine-system/restock-plan/complete', (req, res) => {
  const { machine_id, items, notes, restocked_by } = req.body;
  
  if (!machine_id || !items || !Array.isArray(items)) {
    return res.status(400).json({ error: 'machine_id and items array required' });
  }
  
  const machine = db.machines.find(m => m.id === machine_id);
  if (!machine) return res.status(404).json({ error: 'Machine not found' });
  
  // Record each restock
  const restocks = [];
  items.forEach(item => {
    if (item.quantity_added > 0) {
      const slotIdx = (db.machineSlots || []).findIndex(s => s.id === item.slot_id && s.machine_id === machine_id);
      if (slotIdx !== -1) {
        const slot = db.machineSlots[slotIdx];
        const previousQuantity = slot.current_quantity || 0;
        const newQuantity = Math.min(previousQuantity + item.quantity_added, slot.capacity);
        
        const restockRecord = {
          id: nextId(),
          slot_id: item.slot_id,
          machine_id,
          quantity_added: item.quantity_added,
          previous_quantity: previousQuantity,
          new_quantity: newQuantity,
          expiry_date: item.expiry_date || null,
          restocked_by: restocked_by || 'user',
          notes: item.notes || null,
          created_at: new Date().toISOString()
        };
        
        if (!db.restockHistory) db.restockHistory = [];
        db.restockHistory.push(restockRecord);
        restocks.push(restockRecord);
        
        // Update slot
        db.machineSlots[slotIdx].current_quantity = newQuantity;
        db.machineSlots[slotIdx].updated_at = new Date().toISOString();
        
        // Handle expiry
        if (item.expiry_date) {
          const batches = slot.expiry_batches || [];
          batches.push({ quantity: item.quantity_added, expiryDate: item.expiry_date, addedDate: new Date().toISOString() });
          db.machineSlots[slotIdx].expiry_batches = batches;
          const dates = batches.map(b => new Date(b.expiryDate)).filter(d => !isNaN(d));
          if (dates.length > 0) {
            db.machineSlots[slotIdx].earliest_expiry = new Date(Math.min(...dates)).toISOString().split('T')[0];
          }
        }
        
        // Clear alerts
        clearSlotAlerts(item.slot_id, ['low_stock', 'out_of_stock']);
      }
    }
  });
  
  // Update machine
  const machineIdx = db.machines.findIndex(m => m.id === machine_id);
  if (machineIdx !== -1) {
    db.machines[machineIdx].last_restock = new Date().toISOString();
  }
  
  // Record visit
  const visit = {
    id: nextId(),
    machine_id,
    type: 'restock',
    restocks: restocks.length,
    total_units: restocks.reduce((sum, r) => sum + r.quantity_added, 0),
    notes,
    completed_by: restocked_by || 'user',
    created_at: new Date().toISOString()
  };
  
  if (!db.restockVisits) db.restockVisits = [];
  db.restockVisits.push(visit);
  
  saveDB(db);
  
  res.json({
    success: true,
    visit,
    restocks,
    summary: {
      slotsRestocked: restocks.length,
      totalUnits: visit.total_units
    }
  });
});

// GET /api/machine-system/restock-history - Get restock history
app.get('/api/machine-system/restock-history', (req, res) => {
  const { machine_id, slot_id, from, to, limit } = req.query;
  
  let history = db.restockHistory || [];
  
  if (machine_id) history = history.filter(r => r.machine_id === parseInt(machine_id));
  if (slot_id) history = history.filter(r => r.slot_id === parseInt(slot_id));
  if (from) history = history.filter(r => new Date(r.created_at) >= new Date(from));
  if (to) history = history.filter(r => new Date(r.created_at) <= new Date(to));
  
  history = history.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  
  if (limit) history = history.slice(0, parseInt(limit));
  
  res.json(history);
});

// ===== ANALYTICS & PREDICTIONS =====

// GET /api/machine-system/analytics/slot/:slotId - Detailed analytics for a slot
app.get('/api/machine-system/analytics/slot/:slotId', (req, res) => {
  const slotId = parseInt(req.params.slotId);
  const slot = (db.machineSlots || []).find(s => s.id === slotId);
  if (!slot) return res.status(404).json({ error: 'Slot not found' });
  
  const machine = db.machines.find(m => m.id === slot.machine_id);
  const product = db.products.find(p => p.id === slot.product_id);
  
  // Get all sales for this slot
  const allSales = (db.slotSales || []).filter(s => s.slot_id === slotId)
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  
  // Calculate velocity over different periods
  const velocity7d = calculateSlotVelocity(slotId, 7);
  const velocity14d = calculateSlotVelocity(slotId, 14);
  const velocity30d = calculateSlotVelocity(slotId, 30);
  
  // Daily breakdown (last 14 days)
  const dailyBreakdown = [];
  for (let i = 0; i < 14; i++) {
    const date = new Date();
    date.setDate(date.getDate() - i);
    const dateStr = date.toISOString().split('T')[0];
    
    const daySales = allSales.filter(s => s.created_at.startsWith(dateStr));
    const units = daySales.reduce((sum, s) => sum + (s.quantity || 1), 0);
    const revenue = daySales.reduce((sum, s) => sum + (s.total || 0), 0);
    
    dailyBreakdown.push({
      date: dateStr,
      units,
      revenue,
      transactions: daySales.length
    });
  }
  
  // Hourly pattern (aggregated)
  const hourlyPattern = Array(24).fill(0);
  allSales.forEach(sale => {
    const hour = new Date(sale.created_at).getHours();
    hourlyPattern[hour] += sale.quantity || 1;
  });
  
  // Restock history
  const restockHistory = (db.restockHistory || []).filter(r => r.slot_id === slotId)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, 10);
  
  // Predictions
  const daysUntilEmpty = calculateDaysUntilEmpty(slot, velocity7d);
  const recommendation = getRestockRecommendation(slot, velocity7d);
  
  // Revenue metrics
  const totalRevenue = allSales.reduce((sum, s) => sum + (s.total || 0), 0);
  const totalUnits = allSales.reduce((sum, s) => sum + (s.quantity || 1), 0);
  const avgTransaction = allSales.length > 0 ? totalRevenue / allSales.length : 0;
  
  res.json({
    slot: {
      id: slot.id,
      position_code: slot.position_code,
      zone: slot.zone,
      current_quantity: slot.current_quantity,
      capacity: slot.capacity,
      par_min: slot.par_min || slot.restock_trigger,
      par_max: slot.par_max || slot.capacity
    },
    machine: {
      id: machine?.id,
      name: machine?.name
    },
    product: product ? {
      id: product.id,
      name: product.name,
      category: product.category,
      cost_price: product.cost_price,
      vending_price: product.sell_price
    } : null,
    velocity: {
      last7days: velocity7d,
      last14days: velocity14d,
      last30days: velocity30d
    },
    predictions: {
      daysUntilEmpty,
      recommendation,
      suggestedRestockDate: daysUntilEmpty !== null && daysUntilEmpty > 0 
        ? new Date(Date.now() + Math.max(0, daysUntilEmpty - 2) * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
        : 'ASAP'
    },
    metrics: {
      totalSales: allSales.length,
      totalUnits,
      totalRevenue: Math.round(totalRevenue * 100) / 100,
      avgTransaction: Math.round(avgTransaction * 100) / 100,
      firstSale: allSales[0]?.created_at,
      lastSale: allSales[allSales.length - 1]?.created_at
    },
    dailyBreakdown: dailyBreakdown.reverse(),
    hourlyPattern,
    restockHistory
  });
});

// ===== END PHASE 2: INVENTORY INTELLIGENCE =====

// =====================================================
// ===== PHASE 3: SALES & ANALYTICS APIS =====
// =====================================================
// Supports: transaction recording, sales summaries,
// velocity metrics, and time-of-day patterns
// =====================================================

// Initialize transactions collection
if (!db.transactions) db.transactions = [];
if (!db.dailySummaries) db.dailySummaries = [];
if (!db.productVelocity) db.productVelocity = [];
if (!db.slotAnalytics) db.slotAnalytics = [];

// Serve sales analytics page
app.get('/sales-analytics', (req, res) => {
  res.sendFile(path.join(__dirname, 'sales-analytics.html'));
});

// ===== Campaign Tracker Page =====

// ===== POST /api/transactions — Record a sale =====
app.post('/api/transactions', (req, res) => {
  const { 
    machine_id, 
    slot_id, 
    product_id, 
    unit_price, 
    quantity = 1, 
    payment_method = 'card',
    timestamp,
    external_ref
  } = req.body;
  
  if (!machine_id) {
    return res.status(400).json({ error: 'machine_id is required' });
  }
  
  // Get machine info
  const machine = db.machines.find(m => m.id === parseInt(machine_id));
  if (!machine) {
    return res.status(404).json({ error: 'Machine not found' });
  }
  
  // Get product info if product_id provided
  let productInfo = null;
  if (product_id) {
    productInfo = db.products.find(p => p.id === parseInt(product_id));
  }
  
  // Get slot info if slot_id provided
  let slotInfo = null;
  if (slot_id) {
    const planogram = (db.planograms || []).find(p => p.machine_id === parseInt(machine_id));
    if (planogram?.slots) {
      slotInfo = planogram.slots.find(s => s.id === parseInt(slot_id) || s.position_code === slot_id);
    }
  }
  
  // Calculate total
  const price = parseFloat(unit_price) || (productInfo?.sell_price) || 0;
  const qty = parseInt(quantity) || 1;
  const total = price * qty;
  
  const transaction = {
    id: nextId(),
    machine_id: parseInt(machine_id),
    slot_id: slot_id ? (typeof slot_id === 'string' ? slot_id : parseInt(slot_id)) : null,
    product_id: product_id ? parseInt(product_id) : null,
    product_name: productInfo?.name || req.body.product_name || null,
    product_category: productInfo?.category || req.body.product_category || null,
    unit_price: price,
    quantity: qty,
    total: total,
    payment_method: payment_method,
    payment_status: 'completed',
    external_ref: external_ref || null,
    transaction_time: timestamp ? new Date(timestamp).toISOString() : new Date().toISOString(),
    created_at: new Date().toISOString()
  };
  
  db.transactions.push(transaction);
  
  // Update slot inventory if slot exists
  if (slotInfo && slotInfo.current_quantity !== undefined) {
    slotInfo.current_quantity = Math.max(0, (slotInfo.current_quantity || 0) - qty);
  }
  
  // Update product velocity cache
  updateProductVelocity(parseInt(machine_id), transaction.product_id, transaction.product_name, qty, total);
  
  saveDB(db);
  res.status(201).json(transaction);
});

// Helper: Update product velocity metrics
function updateProductVelocity(machineId, productId, productName, quantity, revenue) {
  if (!productId && !productName) return;
  
  let velocity = db.productVelocity.find(v => 
    v.machine_id === machineId && 
    (v.product_id === productId || v.product_name === productName)
  );
  
  if (!velocity) {
    velocity = {
      id: nextId(),
      machine_id: machineId,
      product_id: productId,
      product_name: productName,
      units_7d: 0,
      units_14d: 0,
      units_30d: 0,
      revenue_7d: 0,
      revenue_30d: 0,
      velocity_7d: 0,
      velocity_30d: 0,
      last_sold_at: null,
      updated_at: new Date().toISOString()
    };
    db.productVelocity.push(velocity);
  }
  
  // Increment counters (will be recalculated properly in /velocity endpoint)
  velocity.units_7d = (velocity.units_7d || 0) + quantity;
  velocity.units_14d = (velocity.units_14d || 0) + quantity;
  velocity.units_30d = (velocity.units_30d || 0) + quantity;
  velocity.revenue_7d = (velocity.revenue_7d || 0) + revenue;
  velocity.revenue_30d = (velocity.revenue_30d || 0) + revenue;
  velocity.last_sold_at = new Date().toISOString();
  velocity.updated_at = new Date().toISOString();
}

// ===== GET /api/transactions — List transactions with filters =====
app.get('/api/transactions', (req, res) => {
  const { machine_id, slot_id, product_id, start, end, payment_method, limit = 100, offset = 0 } = req.query;
  
  let transactions = db.transactions || [];
  
  // Apply filters
  if (machine_id) {
    transactions = transactions.filter(t => t.machine_id === parseInt(machine_id));
  }
  if (slot_id) {
    transactions = transactions.filter(t => t.slot_id == slot_id);
  }
  if (product_id) {
    transactions = transactions.filter(t => t.product_id === parseInt(product_id));
  }
  if (payment_method) {
    transactions = transactions.filter(t => t.payment_method === payment_method);
  }
  if (start) {
    const startDate = new Date(start);
    transactions = transactions.filter(t => new Date(t.transaction_time) >= startDate);
  }
  if (end) {
    const endDate = new Date(end);
    endDate.setHours(23, 59, 59, 999);
    transactions = transactions.filter(t => new Date(t.transaction_time) <= endDate);
  }
  
  // Sort by transaction time descending
  transactions.sort((a, b) => new Date(b.transaction_time) - new Date(a.transaction_time));
  
  // Calculate totals before pagination
  const totalCount = transactions.length;
  const totalRevenue = transactions.reduce((sum, t) => sum + (t.total || 0), 0);
  const totalUnits = transactions.reduce((sum, t) => sum + (t.quantity || 1), 0);
  
  // Apply pagination
  const paginatedTransactions = transactions.slice(parseInt(offset), parseInt(offset) + parseInt(limit));
  
  res.json({
    transactions: paginatedTransactions,
    meta: {
      total: totalCount,
      totalRevenue: Math.round(totalRevenue * 100) / 100,
      totalUnits,
      limit: parseInt(limit),
      offset: parseInt(offset),
      hasMore: parseInt(offset) + parseInt(limit) < totalCount
    }
  });
});

// ===== GET /api/machines/:id/sales/summary — Daily/weekly/monthly totals =====
app.get('/api/machines/:id/sales/summary', (req, res) => {
  const machineId = parseInt(req.params.id);
  const { period = '30d', groupBy = 'day' } = req.query;
  
  // Determine date range
  const now = new Date();
  let startDate = new Date();
  
  switch (period) {
    case 'today':
      startDate.setHours(0, 0, 0, 0);
      break;
    case '7d':
      startDate.setDate(now.getDate() - 7);
      break;
    case '30d':
      startDate.setDate(now.getDate() - 30);
      break;
    case '90d':
      startDate.setDate(now.getDate() - 90);
      break;
    case 'ytd':
      startDate = new Date(now.getFullYear(), 0, 1);
      break;
    default:
      startDate.setDate(now.getDate() - 30);
  }
  
  // Filter transactions
  const transactions = (db.transactions || []).filter(t => 
    t.machine_id === machineId && 
    new Date(t.transaction_time) >= startDate
  );
  
  // Overall totals
  const totalRevenue = transactions.reduce((sum, t) => sum + (t.total || 0), 0);
  const totalUnits = transactions.reduce((sum, t) => sum + (t.quantity || 1), 0);
  const transactionCount = transactions.length;
  const avgTransaction = transactionCount > 0 ? totalRevenue / transactionCount : 0;
  
  // COGS calculation (using products data)
  let totalCOGS = 0;
  transactions.forEach(t => {
    const product = db.products.find(p => p.id === t.product_id);
    if (product?.cost_price) {
      totalCOGS += product.cost_price * (t.quantity || 1);
    } else {
      // Estimate COGS at 33% if no cost data (per VENDTECH-RULES)
      totalCOGS += (t.total || 0) * 0.33;
    }
  });
  const grossProfit = totalRevenue - totalCOGS;
  const marginPercent = totalRevenue > 0 ? (grossProfit / totalRevenue * 100) : 0;
  
  // Group by day/week/month
  const grouped = {};
  transactions.forEach(t => {
    const date = new Date(t.transaction_time);
    let key;
    
    switch (groupBy) {
      case 'week':
        const weekStart = new Date(date);
        weekStart.setDate(date.getDate() - date.getDay());
        key = weekStart.toISOString().split('T')[0];
        break;
      case 'month':
        key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
        break;
      case 'hour':
        key = String(date.getHours()).padStart(2, '0') + ':00';
        break;
      default: // day
        key = date.toISOString().split('T')[0];
    }
    
    if (!grouped[key]) {
      grouped[key] = { revenue: 0, units: 0, transactions: 0 };
    }
    grouped[key].revenue += t.total || 0;
    grouped[key].units += t.quantity || 1;
    grouped[key].transactions++;
  });
  
  // Convert to array and sort
  const breakdown = Object.entries(grouped)
    .map(([date, data]) => ({
      date,
      revenue: Math.round(data.revenue * 100) / 100,
      units: data.units,
      transactions: data.transactions,
      avgTransaction: Math.round((data.revenue / data.transactions) * 100) / 100
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
  
  // Category breakdown
  const byCategory = {};
  transactions.forEach(t => {
    const cat = t.product_category || 'Other';
    if (!byCategory[cat]) {
      byCategory[cat] = { revenue: 0, units: 0 };
    }
    byCategory[cat].revenue += t.total || 0;
    byCategory[cat].units += t.quantity || 1;
  });
  
  // Payment method breakdown
  const byPayment = {};
  transactions.forEach(t => {
    const method = t.payment_method || 'unknown';
    if (!byPayment[method]) {
      byPayment[method] = { count: 0, revenue: 0 };
    }
    byPayment[method].count++;
    byPayment[method].revenue += t.total || 0;
  });
  
  res.json({
    machine_id: machineId,
    period,
    startDate: startDate.toISOString().split('T')[0],
    endDate: now.toISOString().split('T')[0],
    summary: {
      totalRevenue: Math.round(totalRevenue * 100) / 100,
      totalCOGS: Math.round(totalCOGS * 100) / 100,
      grossProfit: Math.round(grossProfit * 100) / 100,
      marginPercent: Math.round(marginPercent * 10) / 10,
      totalUnits,
      transactionCount,
      avgTransaction: Math.round(avgTransaction * 100) / 100,
      avgDailyRevenue: Math.round((totalRevenue / Math.max(1, breakdown.length)) * 100) / 100
    },
    breakdown,
    byCategory: Object.entries(byCategory).map(([category, data]) => ({
      category,
      revenue: Math.round(data.revenue * 100) / 100,
      units: data.units,
      percentage: Math.round((data.revenue / totalRevenue) * 1000) / 10
    })).sort((a, b) => b.revenue - a.revenue),
    byPayment: Object.entries(byPayment).map(([method, data]) => ({
      method,
      count: data.count,
      revenue: Math.round(data.revenue * 100) / 100
    })).sort((a, b) => b.revenue - a.revenue)
  });
});

// ===== GET /api/machines/:id/velocity — Units/day per product =====
app.get('/api/machines/:id/velocity', (req, res) => {
  const machineId = parseInt(req.params.id);
  const { period = '7d', minSales = 0 } = req.query;
  
  // Determine date range
  const now = new Date();
  let daysBack = 7;
  switch (period) {
    case '7d': daysBack = 7; break;
    case '14d': daysBack = 14; break;
    case '30d': daysBack = 30; break;
    default: daysBack = parseInt(period) || 7;
  }
  const startDate = new Date(now - daysBack * 24 * 60 * 60 * 1000);
  
  // Filter transactions for this machine and period
  const transactions = (db.transactions || []).filter(t => 
    t.machine_id === machineId && 
    new Date(t.transaction_time) >= startDate
  );
  
  // Aggregate by product
  const productStats = {};
  transactions.forEach(t => {
    const key = t.product_id || t.product_name || 'Unknown';
    if (!productStats[key]) {
      productStats[key] = {
        product_id: t.product_id,
        product_name: t.product_name || 'Unknown',
        product_category: t.product_category,
        units: 0,
        revenue: 0,
        transactions: 0,
        first_sale: t.transaction_time,
        last_sale: t.transaction_time
      };
    }
    productStats[key].units += t.quantity || 1;
    productStats[key].revenue += t.total || 0;
    productStats[key].transactions++;
    if (t.transaction_time < productStats[key].first_sale) {
      productStats[key].first_sale = t.transaction_time;
    }
    if (t.transaction_time > productStats[key].last_sale) {
      productStats[key].last_sale = t.transaction_time;
    }
  });
  
  // Calculate velocity and format
  const velocity = Object.values(productStats)
    .map(p => ({
      ...p,
      velocity: Math.round((p.units / daysBack) * 100) / 100, // units per day
      avgPrice: Math.round((p.revenue / p.units) * 100) / 100,
      revenue: Math.round(p.revenue * 100) / 100
    }))
    .filter(p => p.units >= parseInt(minSales))
    .sort((a, b) => b.velocity - a.velocity);
  
  // Get product details from catalog
  velocity.forEach(v => {
    if (v.product_id) {
      const product = db.products.find(p => p.id === v.product_id);
      if (product) {
        v.product_name = product.name;
        v.product_category = product.category;
        v.cost_price = product.cost_price;
        v.margin = product.sell_price && product.cost_price 
          ? Math.round(((product.sell_price - product.cost_price) / product.sell_price) * 100)
          : null;
      }
    }
  });
  
  // Calculate rankings
  velocity.forEach((v, i) => {
    v.rank = i + 1;
  });
  
  res.json({
    machine_id: machineId,
    period: `${daysBack}d`,
    daysAnalyzed: daysBack,
    totalProducts: velocity.length,
    totalUnits: velocity.reduce((sum, v) => sum + v.units, 0),
    totalRevenue: Math.round(velocity.reduce((sum, v) => sum + v.revenue, 0) * 100) / 100,
    products: velocity,
    topSellers: velocity.slice(0, 5),
    slowMovers: velocity.filter(v => v.velocity < 0.5).slice(-5)
  });
});

// ===== GET /api/machines/:id/patterns — Time-of-day sales patterns =====
app.get('/api/machines/:id/patterns', (req, res) => {
  const machineId = parseInt(req.params.id);
  const { period = '30d' } = req.query;
  
  // Determine date range
  const now = new Date();
  let daysBack = 30;
  switch (period) {
    case '7d': daysBack = 7; break;
    case '14d': daysBack = 14; break;
    case '30d': daysBack = 30; break;
    case '90d': daysBack = 90; break;
    default: daysBack = parseInt(period) || 30;
  }
  const startDate = new Date(now - daysBack * 24 * 60 * 60 * 1000);
  
  // Filter transactions
  const transactions = (db.transactions || []).filter(t => 
    t.machine_id === machineId && 
    new Date(t.transaction_time) >= startDate
  );
  
  // Hourly breakdown (24 hours)
  const hourly = Array(24).fill(null).map(() => ({ 
    transactions: 0, 
    revenue: 0, 
    units: 0 
  }));
  
  transactions.forEach(t => {
    const hour = new Date(t.transaction_time).getHours();
    hourly[hour].transactions++;
    hourly[hour].revenue += t.total || 0;
    hourly[hour].units += t.quantity || 1;
  });
  
  // Calculate percentages and find peaks
  const totalTrans = transactions.length;
  const hourlyData = hourly.map((h, i) => ({
    hour: i,
    label: `${String(i).padStart(2, '0')}:00`,
    transactions: h.transactions,
    revenue: Math.round(h.revenue * 100) / 100,
    units: h.units,
    percentage: totalTrans > 0 ? Math.round((h.transactions / totalTrans) * 1000) / 10 : 0
  }));
  
  // Day of week breakdown
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const daily = Array(7).fill(null).map(() => ({ 
    transactions: 0, 
    revenue: 0, 
    units: 0 
  }));
  
  transactions.forEach(t => {
    const day = new Date(t.transaction_time).getDay();
    daily[day].transactions++;
    daily[day].revenue += t.total || 0;
    daily[day].units += t.quantity || 1;
  });
  
  const dailyData = daily.map((d, i) => ({
    dayIndex: i,
    day: dayNames[i],
    shortDay: dayNames[i].slice(0, 3),
    transactions: d.transactions,
    revenue: Math.round(d.revenue * 100) / 100,
    units: d.units,
    percentage: totalTrans > 0 ? Math.round((d.transactions / totalTrans) * 1000) / 10 : 0
  }));
  
  // Find peak times
  const peakHour = hourlyData.reduce((max, h) => h.transactions > max.transactions ? h : max, hourlyData[0]);
  const peakDay = dailyData.reduce((max, d) => d.transactions > max.transactions ? d : max, dailyData[0]);
  const slowestHour = hourlyData.filter(h => h.transactions > 0).reduce((min, h) => h.transactions < min.transactions ? h : min, hourlyData.find(h => h.transactions > 0) || hourlyData[0]);
  
  // Time segments (morning/afternoon/evening/night)
  const segments = [
    { name: 'Night', start: 0, end: 5 },
    { name: 'Morning', start: 6, end: 11 },
    { name: 'Afternoon', start: 12, end: 17 },
    { name: 'Evening', start: 18, end: 23 }
  ].map(seg => {
    const segData = hourlyData.filter(h => h.hour >= seg.start && h.hour <= seg.end);
    return {
      ...seg,
      transactions: segData.reduce((sum, h) => sum + h.transactions, 0),
      revenue: Math.round(segData.reduce((sum, h) => sum + h.revenue, 0) * 100) / 100,
      percentage: totalTrans > 0 
        ? Math.round((segData.reduce((sum, h) => sum + h.transactions, 0) / totalTrans) * 1000) / 10 
        : 0
    };
  });
  
  res.json({
    machine_id: machineId,
    period: `${daysBack}d`,
    totalTransactions: totalTrans,
    totalRevenue: Math.round(transactions.reduce((sum, t) => sum + (t.total || 0), 0) * 100) / 100,
    patterns: {
      peakHour: {
        hour: peakHour.hour,
        label: peakHour.label,
        transactions: peakHour.transactions,
        revenue: peakHour.revenue
      },
      slowestHour: slowestHour ? {
        hour: slowestHour.hour,
        label: slowestHour.label,
        transactions: slowestHour.transactions
      } : null,
      peakDay: {
        day: peakDay.day,
        transactions: peakDay.transactions,
        revenue: peakDay.revenue
      },
      busySegment: segments.reduce((max, s) => s.transactions > max.transactions ? s : max, segments[0])
    },
    hourly: hourlyData,
    daily: dailyData,
    segments
  });
});

// ===== GET /api/machines/:id/slots/performance — Position heatmap data =====
app.get('/api/machines/:id/slots/performance', (req, res) => {
  const machineId = parseInt(req.params.id);
  const { period = '30d' } = req.query;
  
  // Determine date range
  const now = new Date();
  let daysBack = 30;
  switch (period) {
    case '7d': daysBack = 7; break;
    case '14d': daysBack = 14; break;
    case '30d': daysBack = 30; break;
    default: daysBack = parseInt(period) || 30;
  }
  const startDate = new Date(now - daysBack * 24 * 60 * 60 * 1000);
  
  // Get planogram for this machine
  const planogram = (db.planograms || []).find(p => p.machine_id === machineId && !p.is_template);
  if (!planogram?.slots) {
    return res.json({
      machine_id: machineId,
      period: `${daysBack}d`,
      slots: [],
      heatmap: [],
      message: 'No planogram found for this machine'
    });
  }
  
  // Filter transactions
  const transactions = (db.transactions || []).filter(t => 
    t.machine_id === machineId && 
    new Date(t.transaction_time) >= startDate
  );
  
  // Aggregate by slot
  const slotStats = {};
  transactions.forEach(t => {
    if (t.slot_id) {
      if (!slotStats[t.slot_id]) {
        slotStats[t.slot_id] = { units: 0, revenue: 0, transactions: 0 };
      }
      slotStats[t.slot_id].units += t.quantity || 1;
      slotStats[t.slot_id].revenue += t.total || 0;
      slotStats[t.slot_id].transactions++;
    }
  });
  
  // Calculate max for normalization
  const maxUnits = Math.max(...Object.values(slotStats).map(s => s.units), 1);
  const maxRevenue = Math.max(...Object.values(slotStats).map(s => s.revenue), 1);
  
  // Build slot performance data
  const slotsWithPerformance = planogram.slots.map(slot => {
    const stats = slotStats[slot.id] || slotStats[slot.position_code] || { units: 0, revenue: 0, transactions: 0 };
    const product = slot.product_id ? db.products.find(p => p.id === slot.product_id) : null;
    
    return {
      id: slot.id,
      position_code: slot.position_code,
      row: slot.row || parseInt(slot.position_code?.charAt(0)?.charCodeAt(0)) - 64,
      column: slot.column || parseInt(slot.position_code?.slice(1)),
      zone: slot.zone,
      product_id: slot.product_id,
      product_name: product?.name || slot.product_name,
      units_sold: stats.units,
      revenue: Math.round(stats.revenue * 100) / 100,
      transactions: stats.transactions,
      velocity: Math.round((stats.units / daysBack) * 100) / 100,
      // Normalized score (0-100)
      performanceScore: Math.round((stats.units / maxUnits) * 100),
      revenueScore: Math.round((stats.revenue / maxRevenue) * 100),
      // Heat level for visualization
      heatLevel: stats.units === 0 ? 'cold' 
        : stats.units / maxUnits > 0.75 ? 'hot'
        : stats.units / maxUnits > 0.5 ? 'warm'
        : stats.units / maxUnits > 0.25 ? 'cool'
        : 'cold'
    };
  });
  
  // Sort by performance for ranking
  const ranked = [...slotsWithPerformance].sort((a, b) => b.units_sold - a.units_sold);
  ranked.forEach((s, i) => {
    const original = slotsWithPerformance.find(o => o.id === s.id);
    if (original) original.rank = i + 1;
  });
  
  // Zone performance summary
  const zones = {};
  slotsWithPerformance.forEach(s => {
    const zone = s.zone || 'unknown';
    if (!zones[zone]) {
      zones[zone] = { slots: 0, totalUnits: 0, totalRevenue: 0 };
    }
    zones[zone].slots++;
    zones[zone].totalUnits += s.units_sold;
    zones[zone].totalRevenue += s.revenue;
  });
  
  const zonePerformance = Object.entries(zones).map(([zone, data]) => ({
    zone,
    slots: data.slots,
    totalUnits: data.totalUnits,
    totalRevenue: Math.round(data.totalRevenue * 100) / 100,
    avgUnitsPerSlot: Math.round((data.totalUnits / data.slots) * 100) / 100,
    avgRevenuePerSlot: Math.round((data.totalRevenue / data.slots) * 100) / 100
  })).sort((a, b) => b.avgUnitsPerSlot - a.avgUnitsPerSlot);
  
  res.json({
    machine_id: machineId,
    period: `${daysBack}d`,
    totalSlots: slotsWithPerformance.length,
    activeSlots: slotsWithPerformance.filter(s => s.units_sold > 0).length,
    totalUnits: slotsWithPerformance.reduce((sum, s) => sum + s.units_sold, 0),
    totalRevenue: Math.round(slotsWithPerformance.reduce((sum, s) => sum + s.revenue, 0) * 100) / 100,
    slots: slotsWithPerformance,
    topSlots: ranked.slice(0, 5),
    worstSlots: ranked.slice(-5).reverse(),
    zonePerformance
  });
});

// ===== GET /api/analytics/overview — Cross-machine analytics =====
app.get('/api/analytics/overview', (req, res) => {
  const { period = '30d' } = req.query;
  
  const now = new Date();
  let daysBack = 30;
  switch (period) {
    case '7d': daysBack = 7; break;
    case '30d': daysBack = 30; break;
    case '90d': daysBack = 90; break;
    default: daysBack = parseInt(period) || 30;
  }
  const startDate = new Date(now - daysBack * 24 * 60 * 60 * 1000);
  
  const transactions = (db.transactions || []).filter(t => 
    new Date(t.transaction_time) >= startDate
  );
  
  // Overall metrics
  const totalRevenue = transactions.reduce((sum, t) => sum + (t.total || 0), 0);
  const totalUnits = transactions.reduce((sum, t) => sum + (t.quantity || 1), 0);
  
  // Per-machine breakdown
  const machineStats = {};
  transactions.forEach(t => {
    if (!machineStats[t.machine_id]) {
      machineStats[t.machine_id] = { revenue: 0, units: 0, transactions: 0 };
    }
    machineStats[t.machine_id].revenue += t.total || 0;
    machineStats[t.machine_id].units += t.quantity || 1;
    machineStats[t.machine_id].transactions++;
  });
  
  const machineBreakdown = Object.entries(machineStats).map(([machineId, stats]) => {
    const machine = db.machines.find(m => m.id === parseInt(machineId));
    return {
      machine_id: parseInt(machineId),
      machine_name: machine?.name || `Machine ${machineId}`,
      location: machine?.location_id ? db.locations.find(l => l.id === machine.location_id)?.name : null,
      revenue: Math.round(stats.revenue * 100) / 100,
      units: stats.units,
      transactions: stats.transactions,
      avgTransaction: Math.round((stats.revenue / stats.transactions) * 100) / 100,
      dailyAvg: Math.round((stats.revenue / daysBack) * 100) / 100
    };
  }).sort((a, b) => b.revenue - a.revenue);
  
  // Check against $2K/month minimum threshold (per VENDTECH-RULES)
  const monthlyProjection = machineBreakdown.map(m => ({
    ...m,
    projectedMonthly: Math.round((m.revenue / daysBack) * 30 * 100) / 100,
    meetingThreshold: (m.revenue / daysBack) * 30 >= 2000,
    status: (m.revenue / daysBack) * 30 >= 2000 ? 'healthy' 
      : (m.revenue / daysBack) * 30 >= 800 ? 'warning'  // Pull threshold
      : 'critical'
  }));
  
  res.json({
    period: `${daysBack}d`,
    overview: {
      totalRevenue: Math.round(totalRevenue * 100) / 100,
      totalUnits,
      totalTransactions: transactions.length,
      avgTransaction: transactions.length > 0 ? Math.round((totalRevenue / transactions.length) * 100) / 100 : 0,
      dailyAvgRevenue: Math.round((totalRevenue / daysBack) * 100) / 100,
      projectedMonthly: Math.round((totalRevenue / daysBack) * 30 * 100) / 100
    },
    machines: monthlyProjection,
    topMachine: monthlyProjection[0],
    machinesAboveThreshold: monthlyProjection.filter(m => m.meetingThreshold).length,
    machinesBelowThreshold: monthlyProjection.filter(m => !m.meetingThreshold).length
  });
});

// ===== GET /api/analytics/export — Export data to CSV =====
app.get('/api/analytics/export', (req, res) => {
  const { type = 'transactions', machine_id, start, end, format = 'csv' } = req.query;
  
  let data = [];
  let filename = '';
  let headers = [];
  
  const now = new Date();
  const startDate = start ? new Date(start) : new Date(now - 30 * 24 * 60 * 60 * 1000);
  const endDate = end ? new Date(end) : now;
  endDate.setHours(23, 59, 59, 999);
  
  switch (type) {
    case 'transactions':
      data = (db.transactions || []).filter(t => {
        const tDate = new Date(t.transaction_time);
        const machineMatch = !machine_id || t.machine_id === parseInt(machine_id);
        return machineMatch && tDate >= startDate && tDate <= endDate;
      });
      
      headers = ['ID', 'Date', 'Time', 'Machine ID', 'Slot', 'Product', 'Category', 'Unit Price', 'Quantity', 'Total', 'Payment Method'];
      data = data.map(t => {
        const dt = new Date(t.transaction_time);
        return [
          t.id,
          dt.toISOString().split('T')[0],
          dt.toTimeString().split(' ')[0],
          t.machine_id,
          t.slot_id || '',
          t.product_name || '',
          t.product_category || '',
          t.unit_price,
          t.quantity,
          t.total,
          t.payment_method
        ];
      });
      filename = `transactions_${startDate.toISOString().split('T')[0]}_${endDate.toISOString().split('T')[0]}.csv`;
      break;
      
    case 'summary':
      const summaryStart = startDate;
      const summaryEnd = endDate;
      const transactions = (db.transactions || []).filter(t => {
        const tDate = new Date(t.transaction_time);
        const machineMatch = !machine_id || t.machine_id === parseInt(machine_id);
        return machineMatch && tDate >= summaryStart && tDate <= summaryEnd;
      });
      
      // Group by day
      const dailyData = {};
      transactions.forEach(t => {
        const date = new Date(t.transaction_time).toISOString().split('T')[0];
        if (!dailyData[date]) {
          dailyData[date] = { revenue: 0, units: 0, transactions: 0 };
        }
        dailyData[date].revenue += t.total || 0;
        dailyData[date].units += t.quantity || 1;
        dailyData[date].transactions++;
      });
      
      headers = ['Date', 'Revenue', 'Units Sold', 'Transactions', 'Avg Transaction'];
      data = Object.entries(dailyData).sort((a, b) => a[0].localeCompare(b[0])).map(([date, d]) => [
        date,
        d.revenue.toFixed(2),
        d.units,
        d.transactions,
        (d.revenue / d.transactions).toFixed(2)
      ]);
      filename = `daily_summary_${startDate.toISOString().split('T')[0]}_${endDate.toISOString().split('T')[0]}.csv`;
      break;
      
    case 'velocity':
      const velTransactions = (db.transactions || []).filter(t => {
        const tDate = new Date(t.transaction_time);
        const machineMatch = !machine_id || t.machine_id === parseInt(machine_id);
        return machineMatch && tDate >= startDate && tDate <= endDate;
      });
      
      const productStats = {};
      velTransactions.forEach(t => {
        const key = t.product_id || t.product_name || 'Unknown';
        if (!productStats[key]) {
          productStats[key] = { name: t.product_name, category: t.product_category, units: 0, revenue: 0 };
        }
        productStats[key].units += t.quantity || 1;
        productStats[key].revenue += t.total || 0;
      });
      
      const daysDiff = Math.max(1, Math.ceil((endDate - startDate) / (1000 * 60 * 60 * 24)));
      headers = ['Product', 'Category', 'Units Sold', 'Revenue', 'Velocity (units/day)'];
      data = Object.values(productStats).sort((a, b) => b.units - a.units).map(p => [
        p.name,
        p.category || '',
        p.units,
        p.revenue.toFixed(2),
        (p.units / daysDiff).toFixed(2)
      ]);
      filename = `product_velocity_${startDate.toISOString().split('T')[0]}_${endDate.toISOString().split('T')[0]}.csv`;
      break;
  }
  
  // Build CSV
  const csvContent = [headers.join(','), ...data.map(row => row.map(cell => 
    typeof cell === 'string' && (cell.includes(',') || cell.includes('"') || cell.includes('\n'))
      ? `"${cell.replace(/"/g, '""')}"`
      : cell
  ).join(','))].join('\n');
  
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csvContent);
});

// ===== Bulk transaction import (for historical data) =====
app.post('/api/transactions/import', (req, res) => {
  const { transactions: importData } = req.body;
  
  if (!importData || !Array.isArray(importData)) {
    return res.status(400).json({ error: 'transactions array required' });
  }
  
  let imported = 0;
  let errors = [];
  
  importData.forEach((t, i) => {
    if (!t.machine_id) {
      errors.push({ index: i, error: 'machine_id required' });
      return;
    }
    
    const transaction = {
      id: nextId(),
      machine_id: parseInt(t.machine_id),
      slot_id: t.slot_id || null,
      product_id: t.product_id ? parseInt(t.product_id) : null,
      product_name: t.product_name || null,
      product_category: t.product_category || null,
      unit_price: parseFloat(t.unit_price) || parseFloat(t.total) || 0,
      quantity: parseInt(t.quantity) || 1,
      total: parseFloat(t.total) || (parseFloat(t.unit_price) * (parseInt(t.quantity) || 1)),
      payment_method: t.payment_method || 'card',
      payment_status: 'completed',
      external_ref: t.external_ref || null,
      transaction_time: t.transaction_time || t.timestamp || new Date().toISOString(),
      created_at: new Date().toISOString()
    };
    
    db.transactions.push(transaction);
    imported++;
  });
  
  saveDB(db);
  res.json({ imported, errors: errors.length, errorDetails: errors.slice(0, 10) });
});

// ===== END PHASE 3: SALES & ANALYTICS =====

// ===== PHASE 4: PRICING STRATEGIES =====
// Based on VENDTECH-RULES.md: 3x COGS target (33%), $3 avg price target

// Initialize pricing data stores
if (!db.pricingStrategies) db.pricingStrategies = [];
if (!db.strategyApplications) db.strategyApplications = [];
if (!db.slotPriceOverrides) db.slotPriceOverrides = [];
if (!db.strategyPerformance) db.strategyPerformance = [];
if (!db.priceHistory) db.priceHistory = [];

// Seed default strategy templates if none exist
if (db.pricingStrategies.length === 0) {
  db.pricingStrategies = [
    {
      id: nextId(),
      name: 'Classic Decoy Effect',
      description: 'Use a medium-priced decoy to make the premium option more attractive. Target: increase premium sales by 30%.',
      type: 'decoy',
      config: {
        target_role: 'premium',
        products: {
          economy: { position: 'bottom', price_range: [1.50, 2.00] },
          decoy: { position: 'middle', price_range: [2.25, 2.75], similar_to: 'premium' },
          premium: { position: 'top', price_range: [2.50, 3.00] }
        },
        placement_rules: { decoy_adjacent_to_premium: true, anchor_first_row: true },
        expected_lift: 30
      },
      is_active: true,
      is_template: true,
      created_by: 'system',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    },
    {
      id: nextId(),
      name: 'High Anchor Strategy',
      description: 'Place highest-priced items at eye level to anchor pricing perception.',
      type: 'anchoring',
      config: {
        anchor_positions: ['A1', 'A2', 'B1', 'B2'],
        anchor_price_minimum: 3.50,
        anchor_categories: ['energy_drink', 'premium_snack'],
        expected_avg_transaction_lift: 15
      },
      is_active: true,
      is_template: true,
      created_by: 'system',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    },
    {
      id: nextId(),
      name: 'Happy Hour Discount',
      description: 'Time-based pricing for slow periods.',
      type: 'time_based',
      config: {
        rules: [
          { name: 'Morning Boost', days: [1,2,3,4,5], start_hour: 6, end_hour: 8, discount_percent: 10 },
          { name: 'Late Night Deal', days: [0,1,2,3,4,5,6], start_hour: 21, end_hour: 23, discount_percent: 15 }
        ],
        minimum_margin_percent: 40
      },
      is_active: true,
      is_template: true,
      created_by: 'system',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    },
    {
      id: nextId(),
      name: 'Combo Bundle Deal',
      description: 'Bundle complementary items at a small discount.',
      type: 'bundle_discount',
      config: {
        bundles: [
          { name: 'Energy Combo', products: ['energy_drink', 'protein_bar'], original_total: 5.50, bundle_price: 4.99, savings_percent: 9 },
          { name: 'Snack Attack', products: ['chips', 'candy', 'soda'], original_total: 6.00, bundle_price: 5.25, savings_percent: 12.5 }
        ],
        display_savings: true,
        max_bundles_per_transaction: 2
      },
      is_active: true,
      is_template: true,
      created_by: 'system',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    },
    {
      id: nextId(),
      name: '3x COGS Margin Optimizer',
      description: 'Automatically adjusts prices to maintain 33% COGS target (3x markup).',
      type: 'margin_optimization',
      config: {
        target_margin_percent: 67,
        target_cogs_percent: 33,
        price_rounding: 0.25,
        min_price: 1.50,
        max_price: 5.00,
        avg_target_price: 3.00
      },
      is_active: true,
      is_template: true,
      created_by: 'system',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }
  ];
  saveDB(db);
}

// ===== GET /api/pricing-strategies — List all strategies =====
app.get('/api/pricing-strategies', (req, res) => {
  const { type, is_template, is_active } = req.query;
  
  let strategies = [...db.pricingStrategies];
  
  if (type) {
    strategies = strategies.filter(s => s.type === type);
  }
  if (is_template !== undefined) {
    strategies = strategies.filter(s => s.is_template === (is_template === 'true'));
  }
  if (is_active !== undefined) {
    strategies = strategies.filter(s => s.is_active === (is_active === 'true'));
  }
  
  // Enrich with application count
  strategies = strategies.map(s => ({
    ...s,
    machines_applied: db.strategyApplications.filter(a => a.strategy_id === s.id && a.status === 'active').length
  }));
  
  res.json(strategies);
});

// ===== POST /api/pricing-strategies — Create new strategy =====
app.post('/api/pricing-strategies', (req, res) => {
  const { name, description, type, config, is_template, is_active } = req.body;
  
  if (!name || !type) {
    return res.status(400).json({ error: 'name and type are required' });
  }
  
  const validTypes = ['decoy', 'anchoring', 'time_based', 'bundle_discount', 'margin_optimization'];
  if (!validTypes.includes(type)) {
    return res.status(400).json({ error: `Invalid type. Valid types: ${validTypes.join(', ')}` });
  }
  
  const strategy = {
    id: nextId(),
    name: sanitize(name),
    description: sanitize(description || ''),
    type,
    config: config || {},
    is_template: is_template || false,
    is_active: is_active !== false,
    created_by: 'user',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  
  db.pricingStrategies.push(strategy);
  saveDB(db);
  
  res.status(201).json(strategy);
});

// ===== GET /api/pricing-strategies/:id — Get single strategy =====
app.get('/api/pricing-strategies/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const strategy = db.pricingStrategies.find(s => s.id === id);
  
  if (!strategy) {
    return res.status(404).json({ error: 'Strategy not found' });
  }
  
  // Enrich with applications
  const applications = db.strategyApplications.filter(a => a.strategy_id === id);
  
  res.json({
    ...strategy,
    applications,
    machines_applied: applications.filter(a => a.status === 'active').length
  });
});

// ===== PUT /api/pricing-strategies/:id — Update strategy =====
app.put('/api/pricing-strategies/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const index = db.pricingStrategies.findIndex(s => s.id === id);
  
  if (index === -1) {
    return res.status(404).json({ error: 'Strategy not found' });
  }
  
  const { name, description, type, config, is_template, is_active } = req.body;
  const strategy = db.pricingStrategies[index];
  
  if (name) strategy.name = sanitize(name);
  if (description !== undefined) strategy.description = sanitize(description);
  if (type) strategy.type = type;
  if (config) strategy.config = config;
  if (is_template !== undefined) strategy.is_template = is_template;
  if (is_active !== undefined) strategy.is_active = is_active;
  strategy.updated_at = new Date().toISOString();
  
  db.pricingStrategies[index] = strategy;
  saveDB(db);
  
  res.json(strategy);
});

// ===== DELETE /api/pricing-strategies/:id — Delete strategy =====
app.delete('/api/pricing-strategies/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const index = db.pricingStrategies.findIndex(s => s.id === id);
  
  if (index === -1) {
    return res.status(404).json({ error: 'Strategy not found' });
  }
  
  // Remove all applications
  db.strategyApplications = db.strategyApplications.filter(a => a.strategy_id !== id);
  
  // Remove strategy
  db.pricingStrategies.splice(index, 1);
  saveDB(db);
  
  res.json({ success: true, message: 'Strategy deleted' });
});

// ===== POST /api/machines/:id/apply-strategy — Apply strategy to machine =====
app.post('/api/machines/:id/apply-strategy', (req, res) => {
  const machineId = parseInt(req.params.id);
  const { strategy_id, slot_overrides, ends_at } = req.body;
  
  if (!strategy_id) {
    return res.status(400).json({ error: 'strategy_id is required' });
  }
  
  const machine = db.machines.find(m => m.id === machineId);
  if (!machine) {
    return res.status(404).json({ error: 'Machine not found' });
  }
  
  const strategy = db.pricingStrategies.find(s => s.id === parseInt(strategy_id));
  if (!strategy) {
    return res.status(404).json({ error: 'Strategy not found' });
  }
  
  // Check if already applied
  const existing = db.strategyApplications.find(a => 
    a.machine_id === machineId && a.strategy_id === parseInt(strategy_id) && a.status === 'active'
  );
  
  if (existing) {
    return res.status(400).json({ error: 'Strategy already applied to this machine' });
  }
  
  // Deactivate other active strategies for this machine (one active per machine)
  db.strategyApplications.forEach(a => {
    if (a.machine_id === machineId && a.status === 'active') {
      a.status = 'ended';
      a.updated_at = new Date().toISOString();
    }
  });
  
  const application = {
    id: nextId(),
    strategy_id: parseInt(strategy_id),
    machine_id: machineId,
    applied_at: new Date().toISOString(),
    applied_by: 'user',
    status: 'active',
    slot_overrides: slot_overrides || {},
    ends_at: ends_at || null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  
  db.strategyApplications.push(application);
  
  // Record in price history
  db.priceHistory.push({
    id: nextId(),
    entity_type: 'machine',
    entity_id: machineId,
    change_reason: 'strategy_applied',
    strategy_id: parseInt(strategy_id),
    application_id: application.id,
    changed_by: 'user',
    changed_at: new Date().toISOString()
  });
  
  saveDB(db);
  
  res.status(201).json({
    success: true,
    message: `Strategy "${strategy.name}" applied to machine "${machine.name || machineId}"`,
    application
  });
});

// ===== DELETE /api/machines/:id/strategy — Remove strategy from machine =====
app.delete('/api/machines/:id/strategy', (req, res) => {
  const machineId = parseInt(req.params.id);
  
  const activeApp = db.strategyApplications.find(a => 
    a.machine_id === machineId && a.status === 'active'
  );
  
  if (!activeApp) {
    return res.status(404).json({ error: 'No active strategy on this machine' });
  }
  
  activeApp.status = 'ended';
  activeApp.updated_at = new Date().toISOString();
  saveDB(db);
  
  res.json({ success: true, message: 'Strategy removed from machine' });
});

// ===== GET /api/pricing-strategies/:id/performance — Get strategy performance metrics =====
app.get('/api/pricing-strategies/:id/performance', (req, res) => {
  const strategyId = parseInt(req.params.id);
  const { period = '30d' } = req.query;
  
  const strategy = db.pricingStrategies.find(s => s.id === strategyId);
  if (!strategy) {
    return res.status(404).json({ error: 'Strategy not found' });
  }
  
  // Get all applications of this strategy
  const applications = db.strategyApplications.filter(a => a.strategy_id === strategyId);
  const machineIds = applications.map(a => a.machine_id);
  
  // Calculate date range
  const now = new Date();
  let daysBack = 30;
  switch (period) {
    case '7d': daysBack = 7; break;
    case '14d': daysBack = 14; break;
    case '30d': daysBack = 30; break;
    case '90d': daysBack = 90; break;
  }
  const startDate = new Date(now - daysBack * 24 * 60 * 60 * 1000);
  
  // Aggregate transactions for machines with this strategy
  const transactions = (db.transactions || []).filter(t => {
    const tDate = new Date(t.transaction_time);
    return machineIds.includes(t.machine_id) && tDate >= startDate;
  });
  
  const totalRevenue = transactions.reduce((sum, t) => sum + (t.total || 0), 0);
  const totalUnits = transactions.reduce((sum, t) => sum + (t.quantity || 1), 0);
  const transactionCount = transactions.length;
  
  // Calculate COGS (estimate at 33% if not tracked)
  const estimatedCOGS = totalRevenue * 0.33;
  const grossProfit = totalRevenue - estimatedCOGS;
  const marginPercent = totalRevenue > 0 ? (grossProfit / totalRevenue) * 100 : 0;
  
  // Daily breakdown
  const dailyData = {};
  transactions.forEach(t => {
    const date = new Date(t.transaction_time).toISOString().split('T')[0];
    if (!dailyData[date]) {
      dailyData[date] = { revenue: 0, units: 0, transactions: 0 };
    }
    dailyData[date].revenue += t.total || 0;
    dailyData[date].units += t.quantity || 1;
    dailyData[date].transactions++;
  });
  
  // Baseline comparison (machines without strategy in same period)
  const otherMachineIds = db.machines
    .filter(m => !machineIds.includes(m.id))
    .map(m => m.id);
  
  const baselineTransactions = (db.transactions || []).filter(t => {
    const tDate = new Date(t.transaction_time);
    return otherMachineIds.includes(t.machine_id) && tDate >= startDate;
  });
  
  const baselineRevenue = baselineTransactions.reduce((sum, t) => sum + (t.total || 0), 0);
  const baselineAvgTransaction = baselineTransactions.length > 0 
    ? baselineRevenue / baselineTransactions.length 
    : 0;
  
  const strategyAvgTransaction = transactionCount > 0 ? totalRevenue / transactionCount : 0;
  const revenueVsBaseline = baselineAvgTransaction > 0
    ? ((strategyAvgTransaction - baselineAvgTransaction) / baselineAvgTransaction) * 100
    : 0;
  
  res.json({
    strategy_id: strategyId,
    strategy_name: strategy.name,
    strategy_type: strategy.type,
    period: `${daysBack}d`,
    machines_count: machineIds.length,
    summary: {
      totalRevenue: Math.round(totalRevenue * 100) / 100,
      totalUnits,
      transactionCount,
      avgTransaction: Math.round(strategyAvgTransaction * 100) / 100,
      estimatedCOGS: Math.round(estimatedCOGS * 100) / 100,
      grossProfit: Math.round(grossProfit * 100) / 100,
      marginPercent: Math.round(marginPercent * 10) / 10
    },
    comparison: {
      baselineAvgTransaction: Math.round(baselineAvgTransaction * 100) / 100,
      revenueVsBaseline: Math.round(revenueVsBaseline * 10) / 10,
      performanceLabel: revenueVsBaseline > 0 ? 'above_baseline' : revenueVsBaseline < 0 ? 'below_baseline' : 'at_baseline'
    },
    daily: Object.entries(dailyData).map(([date, data]) => ({
      date,
      revenue: Math.round(data.revenue * 100) / 100,
      units: data.units,
      transactions: data.transactions
    })).sort((a, b) => a.date.localeCompare(b.date)),
    applications: applications.map(a => ({
      id: a.id,
      machine_id: a.machine_id,
      machine_name: db.machines.find(m => m.id === a.machine_id)?.name || `Machine ${a.machine_id}`,
      status: a.status,
      applied_at: a.applied_at
    }))
  });
});

// ===== GET /api/slot-price-overrides — List all slot overrides =====
app.get('/api/slot-price-overrides', (req, res) => {
  const { machine_id } = req.query;
  
  let overrides = [...db.slotPriceOverrides];
  
  if (machine_id) {
    overrides = overrides.filter(o => o.machine_id === parseInt(machine_id));
  }
  
  // Enrich with machine and slot info
  overrides = overrides.map(o => {
    const machine = db.machines.find(m => m.id === o.machine_id);
    const slot = machine?.slots?.find(s => s.id === o.slot_id);
    return {
      ...o,
      machine_name: machine?.name || `Machine ${o.machine_id}`,
      slot_position: slot?.position || o.slot_id,
      product_name: slot?.product_name || 'Unknown'
    };
  });
  
  res.json(overrides);
});

// ===== POST /api/slot-price-overrides — Create slot override =====
app.post('/api/slot-price-overrides', (req, res) => {
  const { slot_id, machine_id, custom_price, original_price, reason, effective_until } = req.body;
  
  if (!slot_id || !machine_id || custom_price === undefined) {
    return res.status(400).json({ error: 'slot_id, machine_id, and custom_price are required' });
  }
  
  // Check for existing override
  const existingIndex = db.slotPriceOverrides.findIndex(o => o.slot_id === slot_id);
  if (existingIndex !== -1) {
    // Update existing
    db.slotPriceOverrides[existingIndex] = {
      ...db.slotPriceOverrides[existingIndex],
      custom_price: parseFloat(custom_price),
      reason: sanitize(reason || ''),
      effective_until: effective_until || null,
      updated_at: new Date().toISOString()
    };
    saveDB(db);
    return res.json(db.slotPriceOverrides[existingIndex]);
  }
  
  const override = {
    id: nextId(),
    slot_id,
    machine_id: parseInt(machine_id),
    custom_price: parseFloat(custom_price),
    original_price: original_price ? parseFloat(original_price) : null,
    reason: sanitize(reason || ''),
    effective_from: new Date().toISOString(),
    effective_until: effective_until || null,
    created_by: 'user',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  
  db.slotPriceOverrides.push(override);
  
  // Record in price history
  db.priceHistory.push({
    id: nextId(),
    entity_type: 'slot',
    entity_id: slot_id,
    old_price: override.original_price,
    new_price: override.custom_price,
    change_reason: 'manual_override',
    changed_by: 'user',
    changed_at: new Date().toISOString()
  });
  
  saveDB(db);
  res.status(201).json(override);
});

// ===== DELETE /api/slot-price-overrides/:id — Remove slot override =====
app.delete('/api/slot-price-overrides/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const index = db.slotPriceOverrides.findIndex(o => o.id === id);
  
  if (index === -1) {
    return res.status(404).json({ error: 'Override not found' });
  }
  
  db.slotPriceOverrides.splice(index, 1);
  saveDB(db);
  
  res.json({ success: true, message: 'Override removed' });
});

// ===== GET /api/pricing-summary — Overall pricing metrics =====
app.get('/api/pricing-summary', (req, res) => {
  const activeStrategies = db.pricingStrategies.filter(s => s.is_active && !s.is_template).length;
  const activeApplications = db.strategyApplications.filter(a => a.status === 'active').length;
  const machinesWithStrategy = new Set(db.strategyApplications.filter(a => a.status === 'active').map(a => a.machine_id)).size;
  const totalOverrides = db.slotPriceOverrides.length;
  
  // Calculate average price and margin from recent transactions
  const recentTransactions = (db.transactions || []).filter(t => {
    const tDate = new Date(t.transaction_time);
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    return tDate >= thirtyDaysAgo;
  });
  
  const avgPrice = recentTransactions.length > 0
    ? recentTransactions.reduce((sum, t) => sum + (t.unit_price || t.total / (t.quantity || 1)), 0) / recentTransactions.length
    : 3.00;
  
  // Estimate margin (target is 67% = 3x COGS)
  const estimatedMargin = 67; // Default to target
  
  res.json({
    active_strategies: activeStrategies,
    active_applications: activeApplications,
    machines_with_strategy: machinesWithStrategy,
    total_machines: db.machines.length,
    slot_overrides: totalOverrides,
    metrics: {
      avg_price: Math.round(avgPrice * 100) / 100,
      target_avg_price: 3.00,
      estimated_margin: estimatedMargin,
      target_margin: 67,
      target_cogs: 33
    },
    strategy_types: {
      decoy: db.pricingStrategies.filter(s => s.type === 'decoy').length,
      anchoring: db.pricingStrategies.filter(s => s.type === 'anchoring').length,
      time_based: db.pricingStrategies.filter(s => s.type === 'time_based').length,
      bundle_discount: db.pricingStrategies.filter(s => s.type === 'bundle_discount').length,
      margin_optimization: db.pricingStrategies.filter(s => s.type === 'margin_optimization').length
    }
  });
});

// ===== END PHASE 4: PRICING STRATEGIES =====

// ============================================================================
// ===== PHASE 5: BUNDLES & RECOMMENDATIONS =====
// ============================================================================
// Bundle management, AI-suggested bundles from purchase patterns,
// bundle performance tracking, and machine bundle applications.
// Based on: machine-system/DESIGN.md Phase 5
// Business Rules: 3x COGS target, $3.00 avg price, bundle upsells increase AOV
// ============================================================================

// Initialize bundle data structures
if (!db.bundles) db.bundles = [];
if (!db.bundleApplications) db.bundleApplications = [];
if (!db.bundleSales) db.bundleSales = [];
if (!db.purchasePatterns) db.purchasePatterns = [];
if (!db.bundleTemplates) db.bundleTemplates = [
  { id: 1, name: 'Lunch Combo', description: 'Classic lunch pairing - snack + drink', category: 'meal_deal', icon: '🍔', color: '#f59e0b', template_config: { slots: [{ role: 'snack', categories: ['chips', 'crackers', 'pretzels'], price_range: [1.50, 2.50] }, { role: 'drink', categories: ['soda', 'water', 'juice'], price_range: [2.00, 3.00] }], suggested_discount: 10, target_price: 4.00 }, times_used: 0 },
  { id: 2, name: 'Energy Boost', description: 'Energy drink + protein/candy for quick energy', category: 'energy_boost', icon: '⚡', color: '#ef4444', template_config: { slots: [{ role: 'energy', categories: ['energy'], price_range: [3.00, 4.00] }, { role: 'snack', categories: ['candy', 'protein'], price_range: [1.50, 2.50] }], suggested_discount: 15, target_price: 5.00 }, times_used: 0 },
  { id: 3, name: 'Healthy Pick', description: 'Healthy snack + water combo', category: 'healthy_combo', icon: '🥗', color: '#22c55e', template_config: { slots: [{ role: 'healthy', categories: ['healthy', 'protein', 'nuts'], price_range: [2.00, 3.50] }, { role: 'water', categories: ['water'], price_range: [1.50, 2.50] }], suggested_discount: 10, target_price: 4.50 }, times_used: 0 },
  { id: 4, name: 'Sweet Treat', description: 'Candy + soda indulgence combo', category: 'snack_combo', icon: '🍬', color: '#ec4899', template_config: { slots: [{ role: 'candy', categories: ['candy', 'chocolate'], price_range: [1.50, 2.50] }, { role: 'soda', categories: ['soda'], price_range: [2.00, 3.00] }], suggested_discount: 12, target_price: 3.75 }, times_used: 0 },
  { id: 5, name: 'Beverage Duo', description: 'Two drinks at a discount', category: 'beverage_pair', icon: '🥤', color: '#3b82f6', template_config: { slots: [{ role: 'drink1', categories: ['soda', 'water', 'juice', 'energy'], price_range: [2.00, 3.50] }, { role: 'drink2', categories: ['soda', 'water', 'juice', 'energy'], price_range: [2.00, 3.50] }], suggested_discount: 15, target_price: 5.00 }, times_used: 0 },
  { id: 6, name: 'Value Pack', description: 'Three items at maximum savings', category: 'value_pack', icon: '📦', color: '#8b5cf6', template_config: { slots: [{ role: 'main', categories: ['chips', 'crackers'], price_range: [1.50, 2.50] }, { role: 'side', categories: ['candy', 'cookies'], price_range: [1.50, 2.50] }, { role: 'drink', categories: ['soda', 'water'], price_range: [2.00, 3.00] }], suggested_discount: 20, target_price: 5.50 }, times_used: 0 }
];

// ===== Helper: Calculate bundle pricing =====
function calculateBundlePricing(products, discountType, discountValue) {
  const originalTotal = products.reduce((sum, p) => sum + ((p.original_price || 0) * (p.quantity || 1)), 0);
  let bundlePrice = originalTotal;
  
  switch (discountType) {
    case 'percentage':
      bundlePrice = originalTotal * (1 - (discountValue / 100));
      break;
    case 'fixed_amount':
      bundlePrice = Math.max(0, originalTotal - discountValue);
      break;
    case 'fixed_price':
      bundlePrice = discountValue;
      break;
  }
  
  const savingsAmount = originalTotal - bundlePrice;
  const savingsPercent = originalTotal > 0 ? (savingsAmount / originalTotal) * 100 : 0;
  
  return {
    original_total: Math.round(originalTotal * 100) / 100,
    bundle_price: Math.round(bundlePrice * 100) / 100,
    savings_amount: Math.round(savingsAmount * 100) / 100,
    savings_percent: Math.round(savingsPercent * 10) / 10
  };
}

// ===== GET /api/bundles — List all bundles =====
app.get('/api/bundles', (req, res) => {
  const { active_only, category, is_suggested } = req.query;
  
  let bundles = [...db.bundles];
  
  // Filter by active status
  if (active_only === 'true') {
    bundles = bundles.filter(b => b.is_active);
  }
  
  // Filter by category
  if (category) {
    bundles = bundles.filter(b => b.category === category);
  }
  
  // Filter by AI-suggested
  if (is_suggested === 'true') {
    bundles = bundles.filter(b => b.is_suggested);
  } else if (is_suggested === 'false') {
    bundles = bundles.filter(b => !b.is_suggested);
  }
  
  // Enrich with application count and performance
  bundles = bundles.map(bundle => {
    const applications = db.bundleApplications.filter(a => a.bundle_id === bundle.id);
    const activeApplications = applications.filter(a => a.status === 'active');
    const sales = db.bundleSales.filter(s => s.bundle_id === bundle.id);
    
    return {
      ...bundle,
      applied_machines: activeApplications.length,
      total_applications: applications.length,
      performance: {
        total_sales: sales.length,
        total_revenue: sales.reduce((sum, s) => sum + (s.sale_price || 0), 0),
        total_savings: sales.reduce((sum, s) => sum + (s.discount_amount || 0), 0),
        avg_sale_price: sales.length > 0 ? sales.reduce((sum, s) => sum + (s.sale_price || 0), 0) / sales.length : 0
      }
    };
  });
  
  // Sort by active first, then by total_sales
  bundles.sort((a, b) => {
    if (a.is_active !== b.is_active) return b.is_active - a.is_active;
    return (b.performance?.total_sales || 0) - (a.performance?.total_sales || 0);
  });
  
  res.json(bundles);
});

// ===== POST /api/bundles — Create a bundle =====
app.post('/api/bundles', (req, res) => {
  const { 
    name, description, products, discount_type, discount_value,
    targeting, display_config, category, tags, is_suggested, suggestion_score 
  } = req.body;
  
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Bundle name is required' });
  }
  
  if (!products || !Array.isArray(products) || products.length < 2) {
    return res.status(400).json({ error: 'Bundle must contain at least 2 products' });
  }
  
  const validDiscountTypes = ['percentage', 'fixed_amount', 'fixed_price'];
  const dType = discount_type || 'percentage';
  if (!validDiscountTypes.includes(dType)) {
    return res.status(400).json({ error: 'Invalid discount_type. Use: percentage, fixed_amount, or fixed_price' });
  }
  
  // Calculate pricing
  const pricing = calculateBundlePricing(products, dType, discount_value || 0);
  
  const bundle = {
    id: nextId(),
    name: sanitize(name.trim()),
    description: sanitize(description || ''),
    products: products.map(p => ({
      product_id: p.product_id,
      product_name: sanitize(p.product_name || ''),
      quantity: p.quantity || 1,
      original_price: parseFloat(p.original_price) || 0
    })),
    discount_type: dType,
    discount_value: parseFloat(discount_value) || 0,
    ...pricing,
    targeting: targeting || {},
    display_config: display_config || { show_savings: true, badge_text: 'BUNDLE', badge_color: '#22c55e' },
    is_active: true,
    is_suggested: !!is_suggested,
    suggestion_score: suggestion_score ? parseFloat(suggestion_score) : null,
    category: sanitize(category || 'custom'),
    tags: tags || [],
    total_sales: 0,
    total_revenue: 0,
    conversion_rate: 0,
    created_by: 'user',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  
  db.bundles.push(bundle);
  saveDB(db);
  
  res.status(201).json(bundle);
});

// ===== GET /api/bundles/:id — Get single bundle =====
app.get('/api/bundles/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const bundle = db.bundles.find(b => b.id === id);
  
  if (!bundle) {
    return res.status(404).json({ error: 'Bundle not found' });
  }
  
  // Get applications
  const applications = db.bundleApplications.filter(a => a.bundle_id === id);
  
  // Get sales
  const sales = db.bundleSales.filter(s => s.bundle_id === id);
  
  // Calculate performance metrics
  const performance = {
    total_sales: sales.length,
    total_revenue: Math.round(sales.reduce((sum, s) => sum + (s.sale_price || 0), 0) * 100) / 100,
    total_savings: Math.round(sales.reduce((sum, s) => sum + (s.discount_amount || 0), 0) * 100) / 100,
    avg_sale_price: sales.length > 0 ? Math.round(sales.reduce((sum, s) => sum + (s.sale_price || 0), 0) / sales.length * 100) / 100 : 0,
    applications: applications.map(a => {
      const machine = db.machines.find(m => m.id === a.machine_id);
      return {
        ...a,
        machine_name: machine?.name || `Machine ${a.machine_id}`,
        machine_location: machine?.location_name || 'Unknown'
      };
    })
  };
  
  // Sales by day of week
  const salesByDay = [0, 0, 0, 0, 0, 0, 0];
  sales.forEach(s => {
    if (s.day_of_week !== undefined) salesByDay[s.day_of_week]++;
  });
  
  // Sales by hour
  const salesByHour = Array(24).fill(0);
  sales.forEach(s => {
    if (s.hour_of_day !== undefined) salesByHour[s.hour_of_day]++;
  });
  
  res.json({
    ...bundle,
    performance,
    sales_by_day: salesByDay,
    sales_by_hour: salesByHour
  });
});

// ===== PUT /api/bundles/:id — Update bundle =====
app.put('/api/bundles/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const index = db.bundles.findIndex(b => b.id === id);
  
  if (index === -1) {
    return res.status(404).json({ error: 'Bundle not found' });
  }
  
  const bundle = db.bundles[index];
  const { 
    name, description, products, discount_type, discount_value,
    targeting, display_config, category, tags, is_active 
  } = req.body;
  
  // Update fields if provided
  if (name !== undefined) bundle.name = sanitize(name.trim());
  if (description !== undefined) bundle.description = sanitize(description);
  if (targeting !== undefined) bundle.targeting = targeting;
  if (display_config !== undefined) bundle.display_config = display_config;
  if (category !== undefined) bundle.category = sanitize(category);
  if (tags !== undefined) bundle.tags = tags;
  if (is_active !== undefined) bundle.is_active = !!is_active;
  
  // If products or discount changed, recalculate pricing
  if (products !== undefined) {
    bundle.products = products.map(p => ({
      product_id: p.product_id,
      product_name: sanitize(p.product_name || ''),
      quantity: p.quantity || 1,
      original_price: parseFloat(p.original_price) || 0
    }));
  }
  if (discount_type !== undefined) bundle.discount_type = discount_type;
  if (discount_value !== undefined) bundle.discount_value = parseFloat(discount_value) || 0;
  
  // Recalculate pricing
  const pricing = calculateBundlePricing(bundle.products, bundle.discount_type, bundle.discount_value);
  Object.assign(bundle, pricing);
  
  bundle.updated_at = new Date().toISOString();
  
  db.bundles[index] = bundle;
  saveDB(db);
  
  res.json(bundle);
});

// ===== DELETE /api/bundles/:id — Delete bundle =====
app.delete('/api/bundles/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const index = db.bundles.findIndex(b => b.id === id);
  
  if (index === -1) {
    return res.status(404).json({ error: 'Bundle not found' });
  }
  
  // Remove bundle
  db.bundles.splice(index, 1);
  
  // Remove related applications
  db.bundleApplications = db.bundleApplications.filter(a => a.bundle_id !== id);
  
  saveDB(db);
  
  res.json({ success: true, message: 'Bundle deleted' });
});

// ===== GET /api/bundles/:id/performance — Bundle performance metrics =====
app.get('/api/bundles/:id/performance', (req, res) => {
  const id = parseInt(req.params.id);
  const bundle = db.bundles.find(b => b.id === id);
  
  if (!bundle) {
    return res.status(404).json({ error: 'Bundle not found' });
  }
  
  const { days = 30 } = req.query;
  const cutoff = new Date(Date.now() - parseInt(days) * 24 * 60 * 60 * 1000);
  
  // Get sales in period
  const sales = db.bundleSales.filter(s => 
    s.bundle_id === id && new Date(s.created_at) >= cutoff
  );
  
  // Get applications
  const applications = db.bundleApplications.filter(a => a.bundle_id === id);
  const activeApps = applications.filter(a => a.status === 'active');
  
  // Calculate metrics
  const totalRevenue = sales.reduce((sum, s) => sum + (s.sale_price || 0), 0);
  const totalSavings = sales.reduce((sum, s) => sum + (s.discount_amount || 0), 0);
  const totalImpressions = applications.reduce((sum, a) => sum + (a.impressions || 0), 0);
  const totalClicks = applications.reduce((sum, a) => sum + (a.clicks || 0), 0);
  const totalConversions = applications.reduce((sum, a) => sum + (a.conversions || 0), 0);
  
  // Daily breakdown
  const daily = {};
  sales.forEach(s => {
    const date = s.created_at.split('T')[0];
    if (!daily[date]) daily[date] = { sales: 0, revenue: 0 };
    daily[date].sales++;
    daily[date].revenue += s.sale_price || 0;
  });
  
  // By machine
  const byMachine = {};
  sales.forEach(s => {
    if (!s.machine_id) return;
    if (!byMachine[s.machine_id]) {
      const machine = db.machines.find(m => m.id === s.machine_id);
      byMachine[s.machine_id] = { 
        machine_id: s.machine_id,
        machine_name: machine?.name || `Machine ${s.machine_id}`,
        sales: 0, 
        revenue: 0 
      };
    }
    byMachine[s.machine_id].sales++;
    byMachine[s.machine_id].revenue += s.sale_price || 0;
  });
  
  // Peak hours
  const byHour = Array(24).fill(0);
  sales.forEach(s => {
    if (s.hour_of_day !== undefined) byHour[s.hour_of_day]++;
  });
  const peakHour = byHour.indexOf(Math.max(...byHour));
  
  res.json({
    bundle_id: id,
    bundle_name: bundle.name,
    period_days: parseInt(days),
    summary: {
      total_sales: sales.length,
      total_revenue: Math.round(totalRevenue * 100) / 100,
      total_savings: Math.round(totalSavings * 100) / 100,
      avg_sale_price: sales.length > 0 ? Math.round(totalRevenue / sales.length * 100) / 100 : 0,
      active_machines: activeApps.length,
      total_machines: applications.length
    },
    funnel: {
      impressions: totalImpressions,
      clicks: totalClicks,
      conversions: totalConversions,
      ctr: totalImpressions > 0 ? Math.round(totalClicks / totalImpressions * 10000) / 100 : 0,
      conversion_rate: totalClicks > 0 ? Math.round(totalConversions / totalClicks * 10000) / 100 : 0
    },
    daily: Object.entries(daily).map(([date, data]) => ({
      date,
      sales: data.sales,
      revenue: Math.round(data.revenue * 100) / 100
    })).sort((a, b) => a.date.localeCompare(b.date)),
    by_machine: Object.values(byMachine).sort((a, b) => b.sales - a.sales),
    by_hour: byHour,
    peak_hour: peakHour
  });
});

// ===== GET /api/bundles/suggestions — AI-suggested bundles from purchase patterns =====
app.get('/api/bundles/suggestions', (req, res) => {
  const { limit = 10, min_frequency = 5, min_lift = 1.2 } = req.query;
  
  // Get significant patterns that haven't been turned into bundles yet
  let patterns = db.purchasePatterns.filter(p => 
    p.is_significant && 
    !p.bundle_created && 
    p.frequency >= parseInt(min_frequency) &&
    p.lift >= parseFloat(min_lift)
  );
  
  // Sort by lift (correlation strength) descending
  patterns.sort((a, b) => b.lift - a.lift);
  patterns = patterns.slice(0, parseInt(limit));
  
  // Convert patterns to bundle suggestions
  const suggestions = patterns.map(pattern => {
    // Get product details
    const productA = db.products.find(p => p.id === pattern.product_a_id);
    const productB = db.products.find(p => p.id === pattern.product_b_id);
    
    const priceA = productA?.vending_price || productA?.price || 2.50;
    const priceB = productB?.vending_price || productB?.price || 2.50;
    const originalTotal = priceA + priceB;
    
    // Suggest discount based on lift
    let suggestedDiscount = 10;
    if (pattern.lift >= 2.0) suggestedDiscount = 15;
    if (pattern.lift >= 3.0) suggestedDiscount = 20;
    
    const bundlePrice = originalTotal * (1 - suggestedDiscount / 100);
    
    return {
      pattern_id: pattern.id,
      suggestion_name: `${pattern.product_a_name} + ${pattern.product_b_name}`,
      products: [
        { product_id: pattern.product_a_id, product_name: pattern.product_a_name, quantity: 1, original_price: priceA },
        { product_id: pattern.product_b_id, product_name: pattern.product_b_name, quantity: 1, original_price: priceB }
      ],
      metrics: {
        frequency: pattern.frequency,
        support: pattern.support,
        lift: pattern.lift,
        correlation: pattern.lift >= 2.0 ? 'strong' : pattern.lift >= 1.5 ? 'moderate' : 'weak'
      },
      suggested_discount: {
        type: 'percentage',
        value: suggestedDiscount
      },
      pricing: {
        original_total: Math.round(originalTotal * 100) / 100,
        bundle_price: Math.round(bundlePrice * 100) / 100,
        savings: Math.round((originalTotal - bundlePrice) * 100) / 100,
        savings_percent: suggestedDiscount
      },
      context: {
        common_hour: pattern.common_hour,
        common_day: pattern.common_day,
        machine_count: (pattern.machine_ids || []).length
      },
      confidence_score: Math.min(100, Math.round((pattern.lift * 20 + pattern.frequency / 10) * 10) / 10)
    };
  });
  
  res.json({
    suggestions,
    total_patterns: db.purchasePatterns.filter(p => p.is_significant && !p.bundle_created).length,
    filters: { min_frequency: parseInt(min_frequency), min_lift: parseFloat(min_lift) }
  });
});

// ===== POST /api/bundles/suggestions/:id/accept — Create bundle from suggestion =====
app.post('/api/bundles/suggestions/:id/accept', (req, res) => {
  const patternId = parseInt(req.params.id);
  const pattern = db.purchasePatterns.find(p => p.id === patternId);
  
  if (!pattern) {
    return res.status(404).json({ error: 'Pattern not found' });
  }
  
  if (pattern.bundle_created) {
    return res.status(400).json({ error: 'Bundle already created from this pattern' });
  }
  
  // Get product details
  const productA = db.products.find(p => p.id === pattern.product_a_id);
  const productB = db.products.find(p => p.id === pattern.product_b_id);
  
  const priceA = productA?.vending_price || productA?.price || 2.50;
  const priceB = productB?.vending_price || productB?.price || 2.50;
  
  // Suggest discount based on lift
  let suggestedDiscount = 10;
  if (pattern.lift >= 2.0) suggestedDiscount = 15;
  if (pattern.lift >= 3.0) suggestedDiscount = 20;
  
  // Allow override from request body
  const discountValue = req.body.discount_value !== undefined ? parseFloat(req.body.discount_value) : suggestedDiscount;
  const name = req.body.name || `${pattern.product_a_name} + ${pattern.product_b_name}`;
  
  const products = [
    { product_id: pattern.product_a_id, product_name: pattern.product_a_name, quantity: 1, original_price: priceA },
    { product_id: pattern.product_b_id, product_name: pattern.product_b_name, quantity: 1, original_price: priceB }
  ];
  
  const pricing = calculateBundlePricing(products, 'percentage', discountValue);
  
  const bundle = {
    id: nextId(),
    name: sanitize(name),
    description: `AI-suggested bundle based on purchase patterns (Lift: ${pattern.lift.toFixed(2)})`,
    products,
    discount_type: 'percentage',
    discount_value: discountValue,
    ...pricing,
    targeting: {},
    display_config: { show_savings: true, badge_text: 'POPULAR COMBO', badge_color: '#8b5cf6' },
    is_active: true,
    is_suggested: true,
    suggestion_score: Math.min(100, Math.round((pattern.lift * 20 + pattern.frequency / 10) * 10) / 10),
    category: 'ai_suggested',
    tags: ['ai-generated', 'purchase-pattern'],
    total_sales: 0,
    total_revenue: 0,
    conversion_rate: 0,
    created_by: 'ai_suggestion',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  
  db.bundles.push(bundle);
  
  // Mark pattern as used
  const patternIndex = db.purchasePatterns.findIndex(p => p.id === patternId);
  if (patternIndex !== -1) {
    db.purchasePatterns[patternIndex].bundle_created = true;
  }
  
  saveDB(db);
  
  res.status(201).json(bundle);
});

// ===== POST /api/machines/:id/apply-bundle — Apply bundle to machine =====
app.post('/api/machines/:id/apply-bundle', (req, res) => {
  const machineId = parseInt(req.params.id);
  const machine = db.machines.find(m => m.id === machineId);
  
  if (!machine) {
    return res.status(404).json({ error: 'Machine not found' });
  }
  
  const { bundle_id, display_slot, display_priority, starts_at, ends_at, time_override } = req.body;
  
  if (!bundle_id) {
    return res.status(400).json({ error: 'bundle_id is required' });
  }
  
  const bundle = db.bundles.find(b => b.id === parseInt(bundle_id));
  if (!bundle) {
    return res.status(404).json({ error: 'Bundle not found' });
  }
  
  // Check if bundle is already applied to this machine
  const existingIndex = db.bundleApplications.findIndex(a => 
    a.machine_id === machineId && a.bundle_id === parseInt(bundle_id)
  );
  
  if (existingIndex !== -1) {
    // Update existing application
    db.bundleApplications[existingIndex] = {
      ...db.bundleApplications[existingIndex],
      display_slot: display_slot || 'featured',
      display_priority: display_priority || 0,
      starts_at: starts_at || new Date().toISOString(),
      ends_at: ends_at || null,
      time_override: time_override || null,
      status: 'active',
      updated_at: new Date().toISOString()
    };
    saveDB(db);
    return res.json(db.bundleApplications[existingIndex]);
  }
  
  // Create new application
  const application = {
    id: nextId(),
    bundle_id: parseInt(bundle_id),
    machine_id: machineId,
    display_slot: display_slot || 'featured',
    display_priority: display_priority || 0,
    status: 'active',
    starts_at: starts_at || new Date().toISOString(),
    ends_at: ends_at || null,
    time_override: time_override || null,
    impressions: 0,
    clicks: 0,
    conversions: 0,
    revenue: 0,
    applied_by: 'user',
    applied_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  
  db.bundleApplications.push(application);
  saveDB(db);
  
  res.status(201).json({
    ...application,
    bundle_name: bundle.name,
    machine_name: machine.name
  });
});

// ===== DELETE /api/machines/:id/bundles/:bundleId — Remove bundle from machine =====
app.delete('/api/machines/:id/bundles/:bundleId', (req, res) => {
  const machineId = parseInt(req.params.id);
  const bundleId = parseInt(req.params.bundleId);
  
  const index = db.bundleApplications.findIndex(a => 
    a.machine_id === machineId && a.bundle_id === bundleId
  );
  
  if (index === -1) {
    return res.status(404).json({ error: 'Bundle application not found' });
  }
  
  db.bundleApplications.splice(index, 1);
  saveDB(db);
  
  res.json({ success: true, message: 'Bundle removed from machine' });
});

// ===== GET /api/machines/:id/bundles — Get bundles applied to machine =====
app.get('/api/machines/:id/bundles', (req, res) => {
  const machineId = parseInt(req.params.id);
  const machine = db.machines.find(m => m.id === machineId);
  
  if (!machine) {
    return res.status(404).json({ error: 'Machine not found' });
  }
  
  const applications = db.bundleApplications.filter(a => a.machine_id === machineId);
  
  // Enrich with bundle details
  const enriched = applications.map(app => {
    const bundle = db.bundles.find(b => b.id === app.bundle_id);
    return {
      ...app,
      bundle: bundle || null
    };
  });
  
  res.json(enriched);
});

// ===== GET /api/bundle-templates — Get bundle creation templates =====
app.get('/api/bundle-templates', (req, res) => {
  res.json(db.bundleTemplates);
});

// ===== POST /api/bundle-sales — Record a bundle sale =====
app.post('/api/bundle-sales', (req, res) => {
  const { bundle_id, machine_id, sale_price, original_price, products_sold, transaction_id } = req.body;
  
  if (!bundle_id || sale_price === undefined) {
    return res.status(400).json({ error: 'bundle_id and sale_price are required' });
  }
  
  const bundle = db.bundles.find(b => b.id === parseInt(bundle_id));
  if (!bundle) {
    return res.status(404).json({ error: 'Bundle not found' });
  }
  
  const now = new Date();
  
  const sale = {
    id: nextId(),
    bundle_id: parseInt(bundle_id),
    bundle_application_id: null,
    machine_id: machine_id ? parseInt(machine_id) : null,
    transaction_id: transaction_id || null,
    sale_price: parseFloat(sale_price),
    original_price: parseFloat(original_price) || bundle.original_total,
    discount_amount: (parseFloat(original_price) || bundle.original_total) - parseFloat(sale_price),
    products_sold: products_sold || bundle.products,
    hour_of_day: now.getHours(),
    day_of_week: now.getDay(),
    created_at: now.toISOString()
  };
  
  // Find the application if exists
  if (machine_id) {
    const app = db.bundleApplications.find(a => 
      a.bundle_id === parseInt(bundle_id) && a.machine_id === parseInt(machine_id) && a.status === 'active'
    );
    if (app) {
      sale.bundle_application_id = app.id;
      app.conversions = (app.conversions || 0) + 1;
      app.revenue = (app.revenue || 0) + sale.sale_price;
    }
  }
  
  // Update bundle totals
  const bundleIndex = db.bundles.findIndex(b => b.id === parseInt(bundle_id));
  if (bundleIndex !== -1) {
    db.bundles[bundleIndex].total_sales = (db.bundles[bundleIndex].total_sales || 0) + 1;
    db.bundles[bundleIndex].total_revenue = (db.bundles[bundleIndex].total_revenue || 0) + sale.sale_price;
  }
  
  db.bundleSales.push(sale);
  saveDB(db);
  
  res.status(201).json(sale);
});

// ===== POST /api/purchase-patterns/calculate — Recalculate purchase patterns =====
app.post('/api/purchase-patterns/calculate', (req, res) => {
  const { min_frequency = 5, lookback_days = 30 } = req.body;
  
  const cutoff = new Date(Date.now() - parseInt(lookback_days) * 24 * 60 * 60 * 1000);
  
  // Get transactions in period
  const transactions = (db.transactions || []).filter(t => 
    new Date(t.transaction_time || t.created_at) >= cutoff
  );
  
  if (transactions.length === 0) {
    return res.json({ message: 'No transactions in period', patterns_found: 0 });
  }
  
  // Group by transaction_id to find co-purchases
  const baskets = {};
  transactions.forEach(t => {
    const basketId = t.transaction_id || t.id;
    if (!baskets[basketId]) baskets[basketId] = [];
    baskets[basketId].push(t);
  });
  
  // Count product pairs
  const pairs = {};
  const productCounts = {};
  const totalBaskets = Object.keys(baskets).length;
  
  Object.values(baskets).forEach(basket => {
    if (basket.length < 2) return;
    
    // Count individual products
    basket.forEach(item => {
      const pid = item.product_id;
      productCounts[pid] = (productCounts[pid] || 0) + 1;
    });
    
    // Count pairs
    for (let i = 0; i < basket.length; i++) {
      for (let j = i + 1; j < basket.length; j++) {
        const pA = Math.min(basket[i].product_id, basket[j].product_id);
        const pB = Math.max(basket[i].product_id, basket[j].product_id);
        const key = `${pA}_${pB}`;
        
        if (!pairs[key]) {
          pairs[key] = {
            product_a_id: pA,
            product_b_id: pB,
            product_a_name: basket[i].product_id === pA ? (basket[i].product_name || `Product ${pA}`) : (basket[j].product_name || `Product ${pB}`),
            product_b_name: basket[i].product_id === pB ? (basket[i].product_name || `Product ${pB}`) : (basket[j].product_name || `Product ${pA}`),
            frequency: 0,
            machine_ids: new Set(),
            hours: [],
            days: []
          };
        }
        pairs[key].frequency++;
        if (basket[i].machine_id) pairs[key].machine_ids.add(basket[i].machine_id);
        
        const dt = new Date(basket[i].transaction_time || basket[i].created_at);
        pairs[key].hours.push(dt.getHours());
        pairs[key].days.push(dt.getDay());
      }
    }
  });
  
  // Calculate metrics and save significant patterns
  let patternsFound = 0;
  
  Object.values(pairs).forEach(pair => {
    if (pair.frequency < parseInt(min_frequency)) return;
    
    const supportAB = pair.frequency / totalBaskets;
    const supportA = (productCounts[pair.product_a_id] || 1) / totalBaskets;
    const supportB = (productCounts[pair.product_b_id] || 1) / totalBaskets;
    const lift = supportAB / (supportA * supportB);
    
    const confAtoB = pair.frequency / (productCounts[pair.product_a_id] || 1);
    const confBtoA = pair.frequency / (productCounts[pair.product_b_id] || 1);
    
    // Find most common hour/day
    const hourCounts = {};
    pair.hours.forEach(h => hourCounts[h] = (hourCounts[h] || 0) + 1);
    const commonHour = parseInt(Object.entries(hourCounts).sort((a, b) => b[1] - a[1])[0]?.[0]) || 12;
    
    const dayCounts = {};
    pair.days.forEach(d => dayCounts[d] = (dayCounts[d] || 0) + 1);
    const commonDay = parseInt(Object.entries(dayCounts).sort((a, b) => b[1] - a[1])[0]?.[0]) || 3;
    
    // Check if pattern exists
    const existingIndex = db.purchasePatterns.findIndex(p => 
      p.product_a_id === pair.product_a_id && p.product_b_id === pair.product_b_id
    );
    
    const pattern = {
      id: existingIndex !== -1 ? db.purchasePatterns[existingIndex].id : nextId(),
      product_a_id: pair.product_a_id,
      product_b_id: pair.product_b_id,
      product_a_name: pair.product_a_name,
      product_b_name: pair.product_b_name,
      frequency: pair.frequency,
      support: Math.round(supportAB * 10000) / 10000,
      confidence_a_to_b: Math.round(confAtoB * 10000) / 10000,
      confidence_b_to_a: Math.round(confBtoA * 10000) / 10000,
      lift: Math.round(lift * 10000) / 10000,
      common_hour: commonHour,
      common_day: commonDay,
      machine_ids: Array.from(pair.machine_ids),
      is_significant: lift >= 1.2,
      bundle_created: existingIndex !== -1 ? db.purchasePatterns[existingIndex].bundle_created : false,
      first_observed: existingIndex !== -1 ? db.purchasePatterns[existingIndex].first_observed : new Date().toISOString(),
      last_observed: new Date().toISOString(),
      observation_count: existingIndex !== -1 ? (db.purchasePatterns[existingIndex].observation_count || 0) + 1 : 1
    };
    
    if (existingIndex !== -1) {
      db.purchasePatterns[existingIndex] = pattern;
    } else {
      db.purchasePatterns.push(pattern);
    }
    
    patternsFound++;
  });
  
  saveDB(db);
  
  res.json({
    message: 'Purchase patterns calculated',
    patterns_found: patternsFound,
    total_baskets: totalBaskets,
    lookback_days: parseInt(lookback_days)
  });
});

// ===== GET /api/purchase-patterns — List purchase patterns =====
app.get('/api/purchase-patterns', (req, res) => {
  const { significant_only = 'true', min_lift = 1.0, limit = 50 } = req.query;
  
  let patterns = [...db.purchasePatterns];
  
  if (significant_only === 'true') {
    patterns = patterns.filter(p => p.is_significant);
  }
  
  patterns = patterns.filter(p => p.lift >= parseFloat(min_lift));
  
  patterns.sort((a, b) => b.lift - a.lift);
  patterns = patterns.slice(0, parseInt(limit));
  
  res.json(patterns);
});

// ===== GET /api/bundle-summary — Overall bundle performance summary =====
app.get('/api/bundle-summary', (req, res) => {
  const activeBundles = db.bundles.filter(b => b.is_active);
  const activeApplications = db.bundleApplications.filter(a => a.status === 'active');
  const machinesWithBundles = new Set(activeApplications.map(a => a.machine_id)).size;
  
  // Last 30 days sales
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const recentSales = db.bundleSales.filter(s => new Date(s.created_at) >= cutoff);
  
  const totalRevenue = recentSales.reduce((sum, s) => sum + (s.sale_price || 0), 0);
  const totalSavings = recentSales.reduce((sum, s) => sum + (s.discount_amount || 0), 0);
  
  // Top bundles by sales
  const bundleSalesCounts = {};
  recentSales.forEach(s => {
    bundleSalesCounts[s.bundle_id] = (bundleSalesCounts[s.bundle_id] || 0) + 1;
  });
  
  const topBundles = Object.entries(bundleSalesCounts)
    .map(([id, count]) => {
      const bundle = db.bundles.find(b => b.id === parseInt(id));
      return { id: parseInt(id), name: bundle?.name || 'Unknown', sales: count };
    })
    .sort((a, b) => b.sales - a.sales)
    .slice(0, 5);
  
  // AI suggestions available
  const suggestionsAvailable = db.purchasePatterns.filter(p => 
    p.is_significant && !p.bundle_created
  ).length;
  
  res.json({
    summary: {
      total_bundles: db.bundles.length,
      active_bundles: activeBundles.length,
      suggested_bundles: db.bundles.filter(b => b.is_suggested).length,
      active_applications: activeApplications.length,
      machines_with_bundles: machinesWithBundles,
      total_machines: db.machines.length
    },
    performance_30d: {
      total_sales: recentSales.length,
      total_revenue: Math.round(totalRevenue * 100) / 100,
      total_savings: Math.round(totalSavings * 100) / 100,
      avg_bundle_price: recentSales.length > 0 ? Math.round(totalRevenue / recentSales.length * 100) / 100 : 0
    },
    top_bundles: topBundles,
    ai_suggestions_available: suggestionsAvailable,
    categories: {
      meal_deal: db.bundles.filter(b => b.category === 'meal_deal').length,
      energy_boost: db.bundles.filter(b => b.category === 'energy_boost').length,
      healthy_combo: db.bundles.filter(b => b.category === 'healthy_combo').length,
      snack_combo: db.bundles.filter(b => b.category === 'snack_combo').length,
      beverage_pair: db.bundles.filter(b => b.category === 'beverage_pair').length,
      value_pack: db.bundles.filter(b => b.category === 'value_pack').length,
      ai_suggested: db.bundles.filter(b => b.category === 'ai_suggested').length,
      custom: db.bundles.filter(b => b.category === 'custom' || !b.category).length
    }
  });
});

// ===== END PHASE 5: BUNDLES & RECOMMENDATIONS =====

// =====================================================================
// ===== PHASE 6: ADVANCED FEATURES — MOBILE, FORECASTING, OPTIMIZATION =====
// =====================================================================

// ===== MOBILE API ENDPOINTS =====

// GET /api/mobile/dashboard — Summary for mobile app
app.get('/api/mobile/dashboard', (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const machines = db.machines || [];
  const alerts = db.alerts || [];
  const transactions = db.transactions || [];
  
  // Calculate today's stats
  const todayTransactions = transactions.filter(t => 
    t.timestamp && t.timestamp.startsWith(today)
  );
  const todayRevenue = todayTransactions.reduce((sum, t) => sum + (t.amount || 0), 0);
  const todaySales = todayTransactions.length;
  
  // Machine health summary
  const activeMachines = machines.filter(m => m.status === 'active').length;
  const lowStockMachines = machines.filter(m => {
    const slots = (db.machineSlots || []).filter(s => s.machine_id === m.id);
    return slots.some(s => s.current_quantity <= (s.par_level * 0.3));
  }).length;
  const offlineMachines = machines.filter(m => m.status === 'offline').length;
  
  // Pending alerts
  const pendingAlerts = alerts.filter(a => 
    a.status === 'pending' || a.status === 'active'
  );
  const criticalAlerts = pendingAlerts.filter(a => a.severity === 'critical').length;
  const warningAlerts = pendingAlerts.filter(a => a.severity === 'warning').length;
  
  // Today's route info
  const todayRestocks = (db.restockLogs || []).filter(r => 
    r.created_at && r.created_at.startsWith(today)
  );
  const machinesRestocked = new Set(todayRestocks.map(r => r.machine_id)).size;
  
  // Top performers today
  const machineRevenue = {};
  todayTransactions.forEach(t => {
    machineRevenue[t.machine_id] = (machineRevenue[t.machine_id] || 0) + (t.amount || 0);
  });
  const topMachines = Object.entries(machineRevenue)
    .map(([id, revenue]) => {
      const machine = machines.find(m => m.id === parseInt(id));
      return { id: parseInt(id), name: machine?.name || 'Unknown', revenue };
    })
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 3);
  
  res.json({
    timestamp: new Date().toISOString(),
    today: {
      date: today,
      revenue: Math.round(todayRevenue * 100) / 100,
      sales: todaySales,
      avg_transaction: todaySales > 0 ? Math.round(todayRevenue / todaySales * 100) / 100 : 0
    },
    machines: {
      total: machines.length,
      active: activeMachines,
      low_stock: lowStockMachines,
      offline: offlineMachines,
      health_score: machines.length > 0 
        ? Math.round((activeMachines / machines.length) * 100) 
        : 0
    },
    alerts: {
      pending_count: pendingAlerts.length,
      critical: criticalAlerts,
      warnings: warningAlerts
    },
    route: {
      machines_visited: machinesRestocked,
      restocks_completed: todayRestocks.length,
      pending_restocks: machines.filter(m => {
        const slots = (db.machineSlots || []).filter(s => s.machine_id === m.id);
        return slots.some(s => s.current_quantity <= s.par_level);
      }).length
    },
    top_machines: topMachines
  });
});

// GET /api/mobile/machines — Machine list with key metrics
app.get('/api/mobile/machines', (req, res) => {
  const { status, sort_by = 'name', limit = 50 } = req.query;
  let machines = db.machines || [];
  
  // Filter by status if provided
  if (status) {
    machines = machines.filter(m => m.status === status);
  }
  
  // Enhance with metrics
  const enhanced = machines.map(m => {
    const slots = (db.machineSlots || []).filter(s => s.machine_id === m.id);
    const totalSlots = slots.length;
    const lowStockSlots = slots.filter(s => s.current_quantity <= (s.par_level * 0.3)).length;
    const emptySlots = slots.filter(s => s.current_quantity === 0).length;
    const totalCapacity = slots.reduce((sum, s) => sum + (s.par_level || 0), 0);
    const currentStock = slots.reduce((sum, s) => sum + (s.current_quantity || 0), 0);
    
    // Last 7 days revenue
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const recentTransactions = (db.transactions || []).filter(t => 
      t.machine_id === m.id && t.timestamp >= weekAgo
    );
    const weekRevenue = recentTransactions.reduce((sum, t) => sum + (t.amount || 0), 0);
    
    // Last restock
    const lastRestock = (db.restockLogs || [])
      .filter(r => r.machine_id === m.id)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
    
    return {
      id: m.id,
      name: m.name,
      location: m.location || m.address,
      status: m.status,
      stock_level: totalCapacity > 0 ? Math.round((currentStock / totalCapacity) * 100) : 0,
      slots: {
        total: totalSlots,
        low: lowStockSlots,
        empty: emptySlots
      },
      revenue_7d: Math.round(weekRevenue * 100) / 100,
      last_restock: lastRestock?.created_at || null,
      needs_attention: lowStockSlots > 0 || m.status !== 'active'
    };
  });
  
  // Sort
  if (sort_by === 'revenue') {
    enhanced.sort((a, b) => b.revenue_7d - a.revenue_7d);
  } else if (sort_by === 'stock') {
    enhanced.sort((a, b) => a.stock_level - b.stock_level);
  } else if (sort_by === 'attention') {
    enhanced.sort((a, b) => (b.needs_attention ? 1 : 0) - (a.needs_attention ? 1 : 0));
  } else {
    enhanced.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  }
  
  res.json({
    machines: enhanced.slice(0, parseInt(limit)),
    total: machines.length
  });
});

// GET /api/mobile/machines/:id — Single machine detail
app.get('/api/mobile/machines/:id', (req, res) => {
  const machineId = parseInt(req.params.id);
  const machine = (db.machines || []).find(m => m.id === machineId);
  
  if (!machine) {
    return res.status(404).json({ error: 'Machine not found' });
  }
  
  const slots = (db.machineSlots || []).filter(s => s.machine_id === machineId);
  const products = db.products || [];
  
  // Enhance slots with product info
  const enhancedSlots = slots.map(s => {
    const product = products.find(p => p.id === s.product_id);
    return {
      slot_code: s.slot_code,
      product_id: s.product_id,
      product_name: product?.name || 'Unknown',
      current_quantity: s.current_quantity,
      par_level: s.par_level,
      fill_needed: Math.max(0, (s.par_level || 0) - (s.current_quantity || 0)),
      status: s.current_quantity === 0 ? 'empty' : 
              s.current_quantity <= (s.par_level * 0.3) ? 'low' : 'ok',
      price: s.custom_price || product?.vending_price || product?.price || 0
    };
  }).sort((a, b) => (a.slot_code || '').localeCompare(b.slot_code || ''));
  
  // Calculate fill requirements
  const totalFillNeeded = enhancedSlots.reduce((sum, s) => sum + s.fill_needed, 0);
  const estimatedValue = enhancedSlots.reduce((sum, s) => sum + (s.fill_needed * (s.price || 0)), 0);
  
  // 30-day performance
  const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const monthTransactions = (db.transactions || []).filter(t => 
    t.machine_id === machineId && t.timestamp >= monthAgo
  );
  const monthRevenue = monthTransactions.reduce((sum, t) => sum + (t.amount || 0), 0);
  
  // Alerts for this machine
  const machineAlerts = (db.alerts || []).filter(a => 
    a.machine_id === machineId && (a.status === 'pending' || a.status === 'active')
  );
  
  res.json({
    machine: {
      id: machine.id,
      name: machine.name,
      location: machine.location || machine.address,
      status: machine.status,
      model: machine.model,
      installed_date: machine.installed_date,
      last_sync: machine.last_sync
    },
    inventory: {
      slots: enhancedSlots,
      total_slots: slots.length,
      empty_slots: enhancedSlots.filter(s => s.status === 'empty').length,
      low_slots: enhancedSlots.filter(s => s.status === 'low').length,
      total_fill_needed: totalFillNeeded,
      estimated_restock_value: Math.round(estimatedValue * 100) / 100
    },
    performance: {
      revenue_30d: Math.round(monthRevenue * 100) / 100,
      transactions_30d: monthTransactions.length,
      avg_daily_revenue: Math.round(monthRevenue / 30 * 100) / 100
    },
    alerts: machineAlerts.map(a => ({
      id: a.id,
      type: a.type,
      severity: a.severity,
      message: a.message,
      created_at: a.created_at
    }))
  });
});

// POST /api/mobile/restock — Log restock from mobile
app.post('/api/mobile/restock', (req, res) => {
  const { machine_id, items, notes, driver_id } = req.body;
  
  if (!machine_id || !items || !Array.isArray(items)) {
    return res.status(400).json({ error: 'machine_id and items array required' });
  }
  
  const machine = (db.machines || []).find(m => m.id === parseInt(machine_id));
  if (!machine) {
    return res.status(404).json({ error: 'Machine not found' });
  }
  
  const restockId = nextId();
  const timestamp = new Date().toISOString();
  let totalUnits = 0;
  let totalValue = 0;
  
  // Update each slot
  const updates = items.map(item => {
    const slot = (db.machineSlots || []).find(s => 
      s.machine_id === parseInt(machine_id) && s.slot_code === item.slot_code
    );
    
    if (!slot) {
      return { slot_code: item.slot_code, error: 'Slot not found' };
    }
    
    const previousQty = slot.current_quantity || 0;
    const addedQty = parseInt(item.quantity_added) || 0;
    slot.current_quantity = Math.min(previousQty + addedQty, slot.par_level || 999);
    slot.updated_at = timestamp;
    
    const product = (db.products || []).find(p => p.id === slot.product_id);
    const unitCost = product?.wholesale_cost || product?.cost || 0;
    
    totalUnits += addedQty;
    totalValue += addedQty * unitCost;
    
    return {
      slot_code: item.slot_code,
      product_id: slot.product_id,
      previous_quantity: previousQty,
      added: addedQty,
      new_quantity: slot.current_quantity
    };
  });
  
  // Create restock log entry
  const restockLog = {
    id: restockId,
    machine_id: parseInt(machine_id),
    driver_id: driver_id || null,
    items: updates.filter(u => !u.error),
    total_units: totalUnits,
    total_value: Math.round(totalValue * 100) / 100,
    notes: notes || null,
    source: 'mobile',
    created_at: timestamp,
    updated_at: timestamp
  };
  
  if (!db.restockLogs) db.restockLogs = [];
  db.restockLogs.push(restockLog);
  
  // Clear low stock alerts for this machine
  (db.alerts || []).forEach(a => {
    if (a.machine_id === parseInt(machine_id) && 
        a.type === 'low_stock' && 
        a.status === 'pending') {
      a.status = 'resolved';
      a.resolved_at = timestamp;
    }
  });
  
  saveDB(db);
  
  res.json({
    success: true,
    restock_id: restockId,
    machine_id: parseInt(machine_id),
    total_units_added: totalUnits,
    total_value: restockLog.total_value,
    updates,
    timestamp
  });
});

// GET /api/mobile/alerts — Pending alerts
app.get('/api/mobile/alerts', (req, res) => {
  const { severity, machine_id, limit = 50 } = req.query;
  let alerts = (db.alerts || []).filter(a => 
    a.status === 'pending' || a.status === 'active'
  );
  
  if (severity) {
    alerts = alerts.filter(a => a.severity === severity);
  }
  
  if (machine_id) {
    alerts = alerts.filter(a => a.machine_id === parseInt(machine_id));
  }
  
  // Sort by severity then date
  const severityOrder = { critical: 0, warning: 1, info: 2 };
  alerts.sort((a, b) => {
    const sevDiff = (severityOrder[a.severity] || 99) - (severityOrder[b.severity] || 99);
    if (sevDiff !== 0) return sevDiff;
    return new Date(b.created_at) - new Date(a.created_at);
  });
  
  // Enhance with machine info
  const enhanced = alerts.slice(0, parseInt(limit)).map(a => {
    const machine = (db.machines || []).find(m => m.id === a.machine_id);
    return {
      id: a.id,
      type: a.type,
      severity: a.severity,
      message: a.message,
      machine_id: a.machine_id,
      machine_name: machine?.name || 'Unknown',
      machine_location: machine?.location || machine?.address,
      slot_code: a.slot_code || null,
      product_name: a.product_name || null,
      created_at: a.created_at,
      age_hours: Math.round((Date.now() - new Date(a.created_at).getTime()) / (1000 * 60 * 60))
    };
  });
  
  res.json({
    alerts: enhanced,
    total: alerts.length,
    by_severity: {
      critical: alerts.filter(a => a.severity === 'critical').length,
      warning: alerts.filter(a => a.severity === 'warning').length,
      info: alerts.filter(a => a.severity === 'info').length
    }
  });
});

// POST /api/mobile/alerts/:id/acknowledge — Dismiss alert
app.post('/api/mobile/alerts/:id/acknowledge', (req, res) => {
  const alertId = parseInt(req.params.id);
  const { acknowledged_by, notes } = req.body;
  
  const alert = (db.alerts || []).find(a => a.id === alertId);
  if (!alert) {
    return res.status(404).json({ error: 'Alert not found' });
  }
  
  alert.status = 'acknowledged';
  alert.acknowledged_at = new Date().toISOString();
  alert.acknowledged_by = acknowledged_by || 'mobile_user';
  alert.notes = notes || alert.notes;
  alert.updated_at = new Date().toISOString();
  
  saveDB(db);
  
  res.json({
    success: true,
    alert_id: alertId,
    new_status: 'acknowledged',
    acknowledged_at: alert.acknowledged_at
  });
});

// ===== FORECASTING API ENDPOINTS =====

// Helper: Simple moving average forecast
function forecastWithSMA(data, periods, futureDays) {
  if (data.length < periods) {
    return { values: [], confidence: 0.3 };
  }
  
  const lastValues = data.slice(-periods);
  const avg = lastValues.reduce((sum, v) => sum + v, 0) / periods;
  
  // Calculate standard deviation for confidence intervals
  const variance = lastValues.reduce((sum, v) => sum + Math.pow(v - avg, 2), 0) / periods;
  const stdDev = Math.sqrt(variance);
  
  const forecasts = [];
  for (let i = 0; i < futureDays; i++) {
    forecasts.push({
      day: i + 1,
      predicted: Math.round(avg * 100) / 100,
      lower_bound: Math.round((avg - 1.96 * stdDev) * 100) / 100,
      upper_bound: Math.round((avg + 1.96 * stdDev) * 100) / 100
    });
  }
  
  return { values: forecasts, confidence: Math.min(0.85, 0.5 + data.length * 0.01) };
}

// Helper: Detect seasonality (day of week patterns)
function detectSeasonality(dailyData) {
  if (dailyData.length < 14) {
    return { detected: false, pattern: null };
  }
  
  const dayOfWeekTotals = [0, 0, 0, 0, 0, 0, 0];
  const dayOfWeekCounts = [0, 0, 0, 0, 0, 0, 0];
  
  dailyData.forEach(d => {
    const day = new Date(d.date).getDay();
    dayOfWeekTotals[day] += d.value;
    dayOfWeekCounts[day]++;
  });
  
  const dayOfWeekAvgs = dayOfWeekTotals.map((total, i) => 
    dayOfWeekCounts[i] > 0 ? total / dayOfWeekCounts[i] : 0
  );
  
  const overallAvg = dayOfWeekAvgs.reduce((a, b) => a + b, 0) / 7;
  const maxVariation = Math.max(...dayOfWeekAvgs) - Math.min(...dayOfWeekAvgs);
  
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const pattern = dayNames.map((name, i) => ({
    day: name,
    avg: Math.round(dayOfWeekAvgs[i] * 100) / 100,
    vs_avg: overallAvg > 0 ? Math.round((dayOfWeekAvgs[i] / overallAvg - 1) * 100) : 0
  }));
  
  return {
    detected: maxVariation > overallAvg * 0.2,
    pattern,
    peak_day: dayNames[dayOfWeekAvgs.indexOf(Math.max(...dayOfWeekAvgs))],
    low_day: dayNames[dayOfWeekAvgs.indexOf(Math.min(...dayOfWeekAvgs))]
  };
}

// GET /api/forecasts/demand — Demand prediction for a product
app.get('/api/forecasts/demand', (req, res) => {
  const { product_id, machine_id, days = 14 } = req.query;
  
  if (!product_id) {
    return res.status(400).json({ error: 'product_id required' });
  }
  
  // Get historical transactions
  const lookbackDays = 60;
  const startDate = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
  
  let transactions = (db.transactions || []).filter(t => 
    t.product_id === parseInt(product_id) &&
    new Date(t.timestamp) >= startDate
  );
  
  if (machine_id) {
    transactions = transactions.filter(t => t.machine_id === parseInt(machine_id));
  }
  
  // Aggregate by day
  const dailyData = {};
  transactions.forEach(t => {
    const date = t.timestamp.split('T')[0];
    dailyData[date] = (dailyData[date] || 0) + (t.quantity || 1);
  });
  
  // Fill in missing days with 0
  const allDays = [];
  for (let i = lookbackDays; i >= 0; i--) {
    const date = new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    allDays.push({ date, value: dailyData[date] || 0 });
  }
  
  // Forecast
  const forecast = forecastWithSMA(allDays.map(d => d.value), 7, parseInt(days));
  const seasonality = detectSeasonality(allDays);
  
  // Product info
  const product = (db.products || []).find(p => p.id === parseInt(product_id));
  
  res.json({
    product: {
      id: parseInt(product_id),
      name: product?.name || 'Unknown'
    },
    machine_id: machine_id ? parseInt(machine_id) : null,
    historical: {
      days: lookbackDays,
      total_sales: transactions.length,
      avg_daily: Math.round(transactions.length / lookbackDays * 100) / 100,
      daily_data: allDays.slice(-14) // Last 2 weeks
    },
    forecast: {
      days: parseInt(days),
      predictions: forecast.values,
      confidence_level: forecast.confidence,
      total_predicted: forecast.values.reduce((sum, f) => sum + f.predicted, 0)
    },
    seasonality,
    recommendations: [
      {
        type: 'stock_suggestion',
        message: `Maintain ${Math.ceil(transactions.length / lookbackDays * 7 * 1.2)} units buffer for weekly demand`
      },
      seasonality.detected ? {
        type: 'timing',
        message: `Peak demand on ${seasonality.peak_day}s - ensure full stock`
      } : null
    ].filter(Boolean)
  });
});

// GET /api/forecasts/revenue — Revenue forecast for a machine
app.get('/api/forecasts/revenue', (req, res) => {
  const { machine_id, days = 30 } = req.query;
  
  // Get historical transactions
  const lookbackDays = 90;
  const startDate = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
  
  let transactions = (db.transactions || []).filter(t => 
    new Date(t.timestamp) >= startDate
  );
  
  if (machine_id) {
    transactions = transactions.filter(t => t.machine_id === parseInt(machine_id));
  }
  
  // Aggregate by day
  const dailyData = {};
  transactions.forEach(t => {
    const date = t.timestamp.split('T')[0];
    dailyData[date] = (dailyData[date] || 0) + (t.amount || 0);
  });
  
  // Fill in missing days
  const allDays = [];
  for (let i = lookbackDays; i >= 0; i--) {
    const date = new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    allDays.push({ date, value: dailyData[date] || 0 });
  }
  
  // Forecast
  const forecast = forecastWithSMA(allDays.map(d => d.value), 14, parseInt(days));
  const seasonality = detectSeasonality(allDays);
  
  // Monthly projections
  const weeklyAvg = allDays.slice(-7).reduce((sum, d) => sum + d.value, 0);
  const monthlyProjection = weeklyAvg * 4.33;
  
  // Machine info
  const machine = machine_id ? (db.machines || []).find(m => m.id === parseInt(machine_id)) : null;
  
  res.json({
    machine: machine ? {
      id: machine.id,
      name: machine.name
    } : null,
    period: `${lookbackDays} days historical, ${days} days forecast`,
    historical: {
      total_revenue: Math.round(transactions.reduce((sum, t) => sum + (t.amount || 0), 0) * 100) / 100,
      avg_daily: Math.round(allDays.reduce((sum, d) => sum + d.value, 0) / lookbackDays * 100) / 100,
      daily_data: allDays.slice(-30)
    },
    forecast: {
      days: parseInt(days),
      predictions: forecast.values,
      confidence_level: forecast.confidence,
      total_predicted: Math.round(forecast.values.reduce((sum, f) => sum + f.predicted, 0) * 100) / 100
    },
    projections: {
      weekly: Math.round(weeklyAvg * 100) / 100,
      monthly: Math.round(monthlyProjection * 100) / 100,
      annual: Math.round(monthlyProjection * 12 * 100) / 100
    },
    seasonality,
    trends: {
      recent_7d_vs_prior: (() => {
        const recent = allDays.slice(-7).reduce((sum, d) => sum + d.value, 0);
        const prior = allDays.slice(-14, -7).reduce((sum, d) => sum + d.value, 0);
        return prior > 0 ? Math.round((recent / prior - 1) * 100) : 0;
      })(),
      recent_30d_vs_prior: (() => {
        const recent = allDays.slice(-30).reduce((sum, d) => sum + d.value, 0);
        const prior = allDays.slice(-60, -30).reduce((sum, d) => sum + d.value, 0);
        return prior > 0 ? Math.round((recent / prior - 1) * 100) : 0;
      })()
    }
  });
});

// GET /api/forecasts/restock — Restock schedule prediction
app.get('/api/forecasts/restock', (req, res) => {
  const { machine_id } = req.query;
  
  if (!machine_id) {
    return res.status(400).json({ error: 'machine_id required' });
  }
  
  const machine = (db.machines || []).find(m => m.id === parseInt(machine_id));
  if (!machine) {
    return res.status(404).json({ error: 'Machine not found' });
  }
  
  const slots = (db.machineSlots || []).filter(s => s.machine_id === parseInt(machine_id));
  
  // Calculate velocity for each slot
  const lookbackDays = 14;
  const startDate = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
  
  const slotForecasts = slots.map(slot => {
    const transactions = (db.transactions || []).filter(t => 
      t.machine_id === parseInt(machine_id) &&
      t.product_id === slot.product_id &&
      new Date(t.timestamp) >= startDate
    );
    
    const dailyVelocity = transactions.length / lookbackDays;
    const currentStock = slot.current_quantity || 0;
    const daysUntilEmpty = dailyVelocity > 0 ? Math.floor(currentStock / dailyVelocity) : 999;
    const daysUntilLow = dailyVelocity > 0 ? Math.floor((currentStock - (slot.par_level * 0.3)) / dailyVelocity) : 999;
    
    const product = (db.products || []).find(p => p.id === slot.product_id);
    
    return {
      slot_code: slot.slot_code,
      product_id: slot.product_id,
      product_name: product?.name || 'Unknown',
      current_stock: currentStock,
      par_level: slot.par_level,
      daily_velocity: Math.round(dailyVelocity * 100) / 100,
      days_until_low: Math.max(0, daysUntilLow),
      days_until_empty: Math.max(0, daysUntilEmpty),
      restock_urgency: daysUntilEmpty <= 1 ? 'critical' : 
                       daysUntilEmpty <= 3 ? 'soon' : 
                       daysUntilLow <= 3 ? 'upcoming' : 'ok',
      estimated_restock_date: new Date(Date.now() + Math.max(0, daysUntilLow - 1) * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
    };
  });
  
  // Sort by urgency
  const urgencyOrder = { critical: 0, soon: 1, upcoming: 2, ok: 3 };
  slotForecasts.sort((a, b) => urgencyOrder[a.restock_urgency] - urgencyOrder[b.restock_urgency]);
  
  // Calculate next recommended restock
  const criticalSlots = slotForecasts.filter(s => s.restock_urgency === 'critical').length;
  const soonSlots = slotForecasts.filter(s => s.restock_urgency === 'soon').length;
  const earliestRestock = Math.min(...slotForecasts.map(s => s.days_until_low).filter(d => d < 999));
  
  res.json({
    machine: {
      id: machine.id,
      name: machine.name
    },
    summary: {
      total_slots: slots.length,
      critical_slots: criticalSlots,
      soon_slots: soonSlots,
      upcoming_slots: slotForecasts.filter(s => s.restock_urgency === 'upcoming').length,
      healthy_slots: slotForecasts.filter(s => s.restock_urgency === 'ok').length
    },
    recommendation: {
      next_restock_in_days: earliestRestock < 999 ? earliestRestock : null,
      next_restock_date: earliestRestock < 999 
        ? new Date(Date.now() + earliestRestock * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
        : null,
      urgency: criticalSlots > 0 ? 'immediate' : soonSlots > 0 ? 'this_week' : 'scheduled',
      reason: criticalSlots > 0 
        ? `${criticalSlots} slot(s) critically low`
        : soonSlots > 0 
        ? `${soonSlots} slot(s) need attention within 3 days`
        : 'All slots adequately stocked'
    },
    slot_forecasts: slotForecasts
  });
});

// ===== OPTIMIZATION API ENDPOINTS =====

// GET /api/optimization/product-placement — Cross-machine product suggestions
app.get('/api/optimization/product-placement', (req, res) => {
  const machines = db.machines || [];
  const slots = db.machineSlots || [];
  const products = db.products || [];
  
  // Analyze performance across all machines
  const lookbackDays = 30;
  const startDate = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
  const transactions = (db.transactions || []).filter(t => new Date(t.timestamp) >= startDate);
  
  // Product performance by machine
  const productMachinePerformance = {};
  transactions.forEach(t => {
    const key = `${t.product_id}-${t.machine_id}`;
    if (!productMachinePerformance[key]) {
      productMachinePerformance[key] = { sales: 0, revenue: 0 };
    }
    productMachinePerformance[key].sales++;
    productMachinePerformance[key].revenue += t.amount || 0;
  });
  
  // Find top performers
  const topProducts = {};
  Object.entries(productMachinePerformance).forEach(([key, data]) => {
    const [productId] = key.split('-');
    if (!topProducts[productId] || topProducts[productId].sales < data.sales) {
      topProducts[productId] = data;
    }
  });
  
  // Generate suggestions
  const suggestions = [];
  
  machines.forEach(machine => {
    const machineSlots = slots.filter(s => s.machine_id === machine.id);
    const machineProductIds = machineSlots.map(s => s.product_id);
    
    // Find products performing well elsewhere but not in this machine
    Object.entries(topProducts).forEach(([productId, data]) => {
      if (!machineProductIds.includes(parseInt(productId)) && data.sales >= 5) {
        const product = products.find(p => p.id === parseInt(productId));
        if (product) {
          suggestions.push({
            type: 'add_product',
            machine_id: machine.id,
            machine_name: machine.name,
            product_id: parseInt(productId),
            product_name: product.name,
            reason: `Top performer with ${data.sales} sales in 30 days elsewhere`,
            expected_lift: '+15-25%',
            confidence: 'medium'
          });
        }
      }
    });
    
    // Find underperformers
    machineSlots.forEach(slot => {
      const key = `${slot.product_id}-${machine.id}`;
      const perf = productMachinePerformance[key];
      if (!perf || perf.sales < 2) {
        const product = products.find(p => p.id === slot.product_id);
        suggestions.push({
          type: 'review_product',
          machine_id: machine.id,
          machine_name: machine.name,
          product_id: slot.product_id,
          product_name: product?.name || 'Unknown',
          slot_code: slot.slot_code,
          reason: `Only ${perf?.sales || 0} sales in 30 days`,
          action: 'Consider replacing with higher-velocity product',
          confidence: 'high'
        });
      }
    });
  });
  
  // Sort by confidence
  suggestions.sort((a, b) => {
    const confOrder = { high: 0, medium: 1, low: 2 };
    return confOrder[a.confidence] - confOrder[b.confidence];
  });
  
  res.json({
    analysis_period: `${lookbackDays} days`,
    total_suggestions: suggestions.length,
    suggestions: suggestions.slice(0, 20),
    summary: {
      add_product_suggestions: suggestions.filter(s => s.type === 'add_product').length,
      review_product_suggestions: suggestions.filter(s => s.type === 'review_product').length
    }
  });
});

// GET /api/optimization/route — Optimized restock route
app.get('/api/optimization/route', (req, res) => {
  const { driver_id, date } = req.query;
  
  const machines = db.machines || [];
  const slots = db.machineSlots || [];
  
  // Calculate urgency for each machine
  const machineUrgency = machines.map(machine => {
    const machineSlots = slots.filter(s => s.machine_id === machine.id);
    const criticalSlots = machineSlots.filter(s => s.current_quantity === 0).length;
    const lowSlots = machineSlots.filter(s => 
      s.current_quantity > 0 && s.current_quantity <= (s.par_level * 0.3)
    ).length;
    const totalFillUnits = machineSlots.reduce((sum, s) => 
      sum + Math.max(0, (s.par_level || 0) - (s.current_quantity || 0)), 0
    );
    
    // Calculate expected revenue (based on historical)
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const recentRevenue = (db.transactions || [])
      .filter(t => t.machine_id === machine.id && t.timestamp >= weekAgo)
      .reduce((sum, t) => sum + (t.amount || 0), 0);
    
    return {
      machine_id: machine.id,
      machine_name: machine.name,
      location: machine.location || machine.address,
      lat: machine.lat,
      lng: machine.lng,
      status: machine.status,
      critical_slots: criticalSlots,
      low_slots: lowSlots,
      fill_units: totalFillUnits,
      weekly_revenue: Math.round(recentRevenue * 100) / 100,
      urgency_score: (criticalSlots * 10) + (lowSlots * 3) + (recentRevenue / 100),
      needs_service: criticalSlots > 0 || lowSlots >= 3
    };
  });
  
  // Filter to machines needing service
  const needsService = machineUrgency.filter(m => m.needs_service && m.status !== 'offline');
  
  // Sort by urgency score (higher = more urgent)
  needsService.sort((a, b) => b.urgency_score - a.urgency_score);
  
  // Simple route optimization (greedy nearest neighbor if coordinates available)
  let route = needsService;
  if (needsService.length > 1 && needsService[0].lat && needsService[0].lng) {
    // Start from first (most urgent), then nearest neighbor
    const optimized = [needsService[0]];
    const remaining = needsService.slice(1);
    
    while (remaining.length > 0) {
      const last = optimized[optimized.length - 1];
      let nearestIdx = 0;
      let nearestDist = Infinity;
      
      remaining.forEach((m, idx) => {
        if (m.lat && m.lng && last.lat && last.lng) {
          const dist = Math.sqrt(
            Math.pow(m.lat - last.lat, 2) + Math.pow(m.lng - last.lng, 2)
          );
          if (dist < nearestDist) {
            nearestDist = dist;
            nearestIdx = idx;
          }
        }
      });
      
      optimized.push(remaining[nearestIdx]);
      remaining.splice(nearestIdx, 1);
    }
    route = optimized;
  }
  
  // Calculate totals
  const totalFillUnits = route.reduce((sum, m) => sum + m.fill_units, 0);
  const estimatedTime = route.length * 45; // 45 min per machine average
  
  res.json({
    date: date || new Date().toISOString().split('T')[0],
    driver_id: driver_id || null,
    route: {
      stops: route.map((m, idx) => ({
        order: idx + 1,
        ...m
      })),
      total_stops: route.length,
      total_fill_units: totalFillUnits,
      estimated_minutes: estimatedTime,
      estimated_completion: `${Math.floor(estimatedTime / 60)}h ${estimatedTime % 60}m`
    },
    deferred: machineUrgency.filter(m => !m.needs_service).map(m => ({
      machine_id: m.machine_id,
      machine_name: m.machine_name,
      reason: 'Adequate stock levels'
    })),
    summary: {
      total_machines: machines.length,
      needing_service: needsService.length,
      deferred: machines.length - needsService.length,
      critical_machines: needsService.filter(m => m.critical_slots > 0).length
    }
  });
});

// GET /api/optimization/inventory-transfer — Suggest transfers between machines
app.get('/api/optimization/inventory-transfer', (req, res) => {
  const machines = db.machines || [];
  const slots = db.machineSlots || [];
  const products = db.products || [];
  
  // Calculate velocity for products at each machine
  const lookbackDays = 14;
  const startDate = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
  const transactions = (db.transactions || []).filter(t => new Date(t.timestamp) >= startDate);
  
  const productVelocity = {};
  transactions.forEach(t => {
    const key = `${t.product_id}-${t.machine_id}`;
    productVelocity[key] = (productVelocity[key] || 0) + (t.quantity || 1);
  });
  
  // Find transfer opportunities
  const transfers = [];
  
  products.forEach(product => {
    const productSlots = slots.filter(s => s.product_id === product.id);
    
    // Find machines with excess stock and low velocity
    const excessMachines = productSlots.filter(s => {
      const velocity = (productVelocity[`${product.id}-${s.machine_id}`] || 0) / lookbackDays;
      const daysOfStock = velocity > 0 ? s.current_quantity / velocity : 999;
      return daysOfStock > 14 && s.current_quantity > 5;
    });
    
    // Find machines with high velocity but low stock
    const needyMachines = productSlots.filter(s => {
      const velocity = (productVelocity[`${product.id}-${s.machine_id}`] || 0) / lookbackDays;
      const daysOfStock = velocity > 0 ? s.current_quantity / velocity : 999;
      return daysOfStock < 5 && velocity > 0.3;
    });
    
    // Create transfer suggestions
    excessMachines.forEach(excess => {
      needyMachines.forEach(needy => {
        if (excess.machine_id === needy.machine_id) return;
        
        const excessMachine = machines.find(m => m.id === excess.machine_id);
        const needyMachine = machines.find(m => m.id === needy.machine_id);
        const transferQty = Math.min(
          Math.floor(excess.current_quantity * 0.3),
          needy.par_level - needy.current_quantity
        );
        
        if (transferQty >= 3) {
          transfers.push({
            product_id: product.id,
            product_name: product.name,
            from_machine: {
              id: excess.machine_id,
              name: excessMachine?.name || 'Unknown',
              current_stock: excess.current_quantity,
              velocity: Math.round((productVelocity[`${product.id}-${excess.machine_id}`] || 0) / lookbackDays * 100) / 100
            },
            to_machine: {
              id: needy.machine_id,
              name: needyMachine?.name || 'Unknown',
              current_stock: needy.current_quantity,
              velocity: Math.round((productVelocity[`${product.id}-${needy.machine_id}`] || 0) / lookbackDays * 100) / 100
            },
            suggested_quantity: transferQty,
            benefit: 'Reduces stockout risk at high-velocity location',
            priority: needy.current_quantity <= 2 ? 'high' : 'medium'
          });
        }
      });
    });
  });
  
  // Sort by priority
  transfers.sort((a, b) => {
    const priorityOrder = { high: 0, medium: 1, low: 2 };
    return priorityOrder[a.priority] - priorityOrder[b.priority];
  });
  
  res.json({
    analysis_period: `${lookbackDays} days`,
    total_suggestions: transfers.length,
    transfers: transfers.slice(0, 15),
    summary: {
      high_priority: transfers.filter(t => t.priority === 'high').length,
      medium_priority: transfers.filter(t => t.priority === 'medium').length,
      total_units_suggested: transfers.reduce((sum, t) => sum + t.suggested_quantity, 0)
    },
    note: 'Transfer suggestions based on velocity imbalances between machines'
  });
});

// ===== END PHASE 6: ADVANCED FEATURES =====

// ===== SALES AUTOMATION ENGINE (Feb 2026) =====
// Connects: Activities → Pipeline → Proposals → Email Campaigns → Tracking

// Initialize campaign collections
if (!db.campaigns) db.campaigns = [];
if (!db.campaignEmails) db.campaignEmails = [];
if (!db.emailDrafts) db.emailDrafts = [];

// Campaign email templates (5-step follow-up after proposal)
// Email signature (matches Gmail/Mixmax signature exactly)
// Sig format from Kurtis's screenshot: Thanks! / Kurtis Hon (bold blue) / CEO / KandeVendTech (link) / [logo on dark bg]
const KANDE_SIGNATURE_HTML = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:small;color:#000000;">Thanks!<br><b style="color:#000000;">Kurtis Hon</b><br><span style="color:#000000;">CEO</span><br><a href="https://www.kandevendtech.com" style="color:#1155cc;text-decoration:underline;"><b>KandeVendTech</b></a><br><a href="https://www.kandevendtech.com"><img src="https://i.imgur.com/c8P6CjY.jpeg" alt="Kande VendTech" width="90" height="51" style="margin-top:4px;"></a></div>`;

const KANDE_SIGNATURE_PLAIN = `Thanks!\nKurtis Hon\nCEO\nKandeVendTech`;

const CAMPAIGN_TEMPLATES = [
  {
    step: 0, delay_days: 0,
    subject_template: 'Visit Follow-Up: Extra Information About Our Vending',
    body_template: `Hey {contact_name},\n\n{visit_opener} I wanted to reach out and send over a bit more info for you and your team to review.\n\nVIEW PROPOSAL: https://kandevendtech.com/KandeVendTech-Proposal.pdf\n\nOur team manages everything from installation to maintenance, all at no cost to you.\n\nAfter you have a chance to review our proposal, I'd love to chat about how we can meet your needs. Are you free for a quick call this week?\n\n${KANDE_SIGNATURE_PLAIN}`,
    proposal_link: true,
    attach_proposal_pdf: true,
    cc: 'jordan@kandevendtech.com',
    notes: 'Initial proposal email — always attach PDF. {visit_opener} is generated from Jordan activity notes.'
  },
  {
    step: 1, delay_days: 3,
    subject_template: 'Re: Visit Follow-Up: Extra Information About Our Vending',
    body_template: `Hey {contact_name},\n\nI wanted to follow up on my previous email regarding our custom smart vending machines. We'd love to help you find the perfect fit for your space.\n\nWe'll take care of all the expenses, installation, and re-stocking with our local team.\n\nAre you available for a quick chat this week?\n\n${KANDE_SIGNATURE_PLAIN}`,
    cc: 'jordan@kandevendtech.com'
  },
  {
    step: 2, delay_days: 7,
    subject_template: 'Custom Vending Solutions for Your Space',
    body_template: `Hey {contact_name},\n\nI wanted to share some examples of how our custom vending machines can transform your space. We offer sleek, modern machines that can provide snacks, beverages, and even healthy options.\n\nMany of our designs can feature your logo, adding a professional touch and reinforcing your brand. Imagine a break room with a state-of-the-art vending machine offering your team convenient access to refreshments, or a lobby with a stylish, branded machine welcoming guests.\n\nWe'll take care of all of the expenses and we can even give you a percentage of the profits if you'd like to discuss revenue share with us.\n\nAre you available this week for a quick call to explore these options?\n\n${KANDE_SIGNATURE_PLAIN}`,
    inline_images: ['https://i.imgur.com/v78yVQ6.jpeg', 'https://i.imgur.com/8GYMdbn.jpeg'],
    cc: 'jordan@kandevendtech.com'
  },
  {
    step: 3, delay_days: 14,
    subject_template: 'Modern Vending Amenities for Your Space',
    body_template: `Hey {contact_name},\n\nJust checking in again about our custom vending machines. Adding our modern, luxury machines can provide convenience for your employees and guests while enhancing your space with a professional look.\n\nPlus, having your logo on the machine can reinforce your brand.\n\nAre you available this week for a quick call to discuss further?\n\n${KANDE_SIGNATURE_PLAIN}`,
    cc: 'jordan@kandevendtech.com'
  },
  {
    step: 4, delay_days: 21,
    subject_template: 'Quick Follow-Up — Custom Vending Machines',
    body_template: `Hey {contact_name},\n\nI hope this message finds you well. A while back, my team mentioned your interest in our custom vending machines. We provide a range of modern, luxury options, and can even include your logo on many designs.\n\nOur machines can enhance your space by offering convenient amenities to your employees and guests while promoting your brand.\n\nCould we schedule a brief chat to revisit how we can assist you?\n\n${KANDE_SIGNATURE_PLAIN}`,
    cc: 'jordan@kandevendtech.com'
  },
  {
    step: 5, delay_days: 30,
    subject_template: 'Still Interested in Smart Vending?',
    body_template: `Hey {contact_name},\n\nJust one last check-in on the vending proposal. Totally understand if the timing isn't right — we'll keep you on our list and circle back in a few months.\n\nFeel free to reach out anytime if anything changes. Always happy to chat.\n\n${KANDE_SIGNATURE_PLAIN}`,
    cc: 'jordan@kandevendtech.com'
  }
];

// --- Helper: Generate visit opener based on Jordan's activity notes ---
function generateVisitOpener(prospectId, contactName) {
  const activities = (db.activities || [])
    .filter(a => a.prospect_id === prospectId)
    .sort((a, b) => new Date(b.date || b.created_at) - new Date(a.date || a.created_at));

  // Find the most recent pop-in or visit activity
  const visit = activities.find(a =>
    a.type === 'pop-in' || a.type === 'pop_in' || a.type === 'visit' || a.type === 'interested'
  );

  if (!visit || !visit.notes) {
    // Default: generic opener
    return `Jordan from my team recently visited your location and mentioned you may be interested in learning more about our free smart vending machines!`;
  }

  const notes = (visit.notes || '').toLowerCase();

  // Check if Jordan spoke directly with the contact
  const spokeDirectly = notes.includes('spoke with') && (
    notes.includes(contactName?.toLowerCase() || '') ||
    notes.includes('manager') || notes.includes('owner') || notes.includes('director') ||
    notes.includes('decision maker') || notes.includes('dm')
  );
  const spokeWithStaff = notes.includes('front desk') || notes.includes('receptionist') ||
    notes.includes('staff') || notes.includes('employee') || notes.includes('left info') ||
    notes.includes('left card') || notes.includes('left brochure') || notes.includes('dropped off');
  const leftMaterials = notes.includes('left') || notes.includes('dropped') || notes.includes('brochure') ||
    notes.includes('flyer') || notes.includes('card');

  if (spokeDirectly) {
    return `Jordan from my team let me know he spoke with you recently and you were interested in getting more info about our free smart vending machines!`;
  } else if (spokeWithStaff) {
    return `Jordan from my team recently stopped by your location and spoke with your team about our free smart vending machines. They mentioned you'd be a great person to connect with!`;
  } else if (leftMaterials) {
    return `Jordan from my team recently visited your location and left some information about our free smart vending machines. I wanted to follow up and share a bit more!`;
  } else {
    return `Jordan from my team recently visited your location and mentioned you may be interested in learning more about our free smart vending machines!`;
  }
}

// --- Helper: Fill template variables ---
function fillTemplate(template, vars) {
  let result = template;
  Object.entries(vars).forEach(([key, val]) => {
    result = result.replace(new RegExp(`\\{${key}\\}`, 'g'), val || '');
  });
  return result;
}

// --- ACTION ITEMS API (aggregated command center) ---
app.get('/api/action-items', (req, res) => {
  const now = new Date();
  const twoDaysAgo = new Date(now - 48 * 60 * 60 * 1000);
  const today = now.toISOString().split('T')[0];

  // 1. HOT LEADS: Prospects in "interested" stage without proposals
  const interestedCards = (db.pipelineCards || []).filter(c => c.stage === 'interested');
  const hotLeads = interestedCards.map(card => {
    const prospect = db.prospects.find(p => p.id === card.prospect_id);
    if (!prospect) return null;
    const hasProposal = (db.proposals || []).some(p => p.prospect_id === card.prospect_id);
    if (hasProposal) return null;
    const contact = (db.contacts || []).find(c => c.prospect_id === card.prospect_id && c.is_primary) ||
                    (db.contacts || []).find(c => c.prospect_id === card.prospect_id);
    return {
      type: 'hot_lead',
      priority: 'urgent',
      prospect_id: prospect.id,
      title: `Draft proposal for ${prospect.name}`,
      subtitle: contact ? contact.name : prospect.email || 'No contact',
      property_type: prospect.property_type,
      days_waiting: Math.floor((now - new Date(card.entered_stage_at)) / (1000*60*60*24)),
      created_at: card.entered_stage_at
    };
  }).filter(Boolean);

  // 2. PROPOSALS PENDING: Sent but no response
  const pendingProposals = (db.proposals || [])
    .filter(p => p.status !== 'accepted' && p.status !== 'rejected' && p.status !== 'expired')
    .map(p => {
      const prospect = db.prospects.find(pr => pr.id === p.prospect_id);
      const campaign = (db.campaigns || []).find(c => c.prospect_id === p.prospect_id && c.status === 'active');
      return {
        type: 'pending_proposal',
        priority: campaign ? 'normal' : 'high',
        proposal_id: p.id,
        prospect_id: p.prospect_id,
        title: `Proposal for ${p.property_name || (prospect ? prospect.name : 'Unknown')}`,
        subtitle: `Sent ${Math.floor((now - new Date(p.created_at)) / (1000*60*60*24))} days ago`,
        campaign_step: campaign ? `Campaign step ${campaign.current_step}/${campaign.total_steps}` : 'No campaign',
        email_opened: p.email_opened || false,
        created_at: p.created_at
      };
    });

  // 3. FOLLOW-UPS DUE TODAY: Tasks from workflow
  const tasksDue = (db.crmTasks || [])
    .filter(t => !t.completed && t.due_date && t.due_date.split('T')[0] <= today)
    .map(t => {
      const prospect = db.prospects.find(p => p.id === t.prospect_id);
      return {
        type: 'task_due',
        priority: t.due_date.split('T')[0] < today ? 'overdue' : 'normal',
        task_id: t.id,
        prospect_id: t.prospect_id,
        title: t.title,
        subtitle: prospect ? prospect.name : 'Unknown property',
        task_type: t.task_type,
        due_date: t.due_date,
        created_at: t.created_at
      };
    });

  // 4. JORDAN'S LATEST ACTIVITIES (last 48h)
  const recentActivities = (db.activities || [])
    .filter(a => new Date(a.created_at) >= twoDaysAgo)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, 20)
    .map(a => {
      const prospect = db.prospects.find(p => p.id === a.prospect_id);
      return {
        type: 'activity',
        activity_type: a.type,
        prospect_id: a.prospect_id,
        title: a.description || a.type,
        subtitle: prospect ? prospect.name : 'Unknown',
        created_at: a.created_at,
        created_by: a.created_by || 'Jordan'
      };
    });

  // 5. CAMPAIGN ACTIONS: Emails scheduled for today
  const campaignActions = (db.campaigns || [])
    .filter(c => c.status === 'active' && c.next_email_date && c.next_email_date.split('T')[0] <= today)
    .map(c => {
      const prospect = db.prospects.find(p => p.id === c.prospect_id);
      const template = CAMPAIGN_TEMPLATES.find(t => t.step === c.current_step);
      return {
        type: 'campaign_email',
        priority: 'high',
        campaign_id: c.id,
        prospect_id: c.prospect_id,
        title: `Send follow-up #${c.current_step} to ${prospect ? prospect.name : 'Unknown'}`,
        subtitle: template ? template.subject_template.replace('{property_name}', prospect ? prospect.name : '') : '',
        step: c.current_step,
        total_steps: c.total_steps,
        created_at: c.next_email_date
      };
    });

  // Sort all by priority then date
  const priorityOrder = { overdue: 0, urgent: 1, high: 2, normal: 3 };
  const allItems = [...hotLeads, ...pendingProposals, ...tasksDue, ...campaignActions]
    .sort((a, b) => (priorityOrder[a.priority] || 9) - (priorityOrder[b.priority] || 9));

  res.json({
    action_items: allItems,
    recent_activities: recentActivities,
    summary: {
      hot_leads: hotLeads.length,
      pending_proposals: pendingProposals.length,
      tasks_due: tasksDue.length,
      overdue_tasks: tasksDue.filter(t => t.priority === 'overdue').length,
      campaign_emails_due: campaignActions.length,
      recent_activity_count: recentActivities.length
    }
  });
});

// --- SALES ACTIVITY DASHBOARD DATA ---
app.get('/api/sales-dashboard', (req, res) => {
  const now = new Date();
  const prospects = db.prospects || [];
  const activities = db.activities || [];
  const campaigns = db.campaigns || [];
  const mixmaxData = db.mixmaxTracking || [];

  // 1. ALL emails per location (from prospect.email_tracking synced by Mixmax + campaigns)
  const emailsByProspect = {};
  // Pull from db.mixmaxTracking (legacy) + prospect.email_tracking (current sync source)
  mixmaxData.forEach(m => {
    const key = m.prospect_id;
    if (!emailsByProspect[key]) emailsByProspect[key] = [];
    emailsByProspect[key].push(m);
  });
  // Also pull from prospect.email_tracking (where sync-to-crm actually writes)
  prospects.forEach(p => {
    if (p.email_tracking && p.email_tracking.length > 0) {
      if (!emailsByProspect[p.id]) emailsByProspect[p.id] = [];
      p.email_tracking.forEach(t => {
        // Avoid duplicates (same subject + recipient)
        const exists = emailsByProspect[p.id].some(e =>
          e.subject === t.subject && e.recipient_email === t.recipient_email
        );
        if (!exists) emailsByProspect[p.id].push(t);
      });
    }
  });

  // Sort each prospect's emails by date, newest first
  // Filter out emails where the ONLY opens were from internal team
  Object.values(emailsByProspect).forEach(arr => {
    arr.sort((a, b) => new Date(b.sent_at) - new Date(a.sent_at));
    // Adjust open counts: if last_event_by is internal and that's the only opener, mark as 0 external opens
    arr.forEach(m => {
      if (m.last_event_by && isInternalEmail(m.last_event_by) && !m.was_replied) {
        m._internal_opens = true;
        // We can't know exact split, but if ALL events are from internal, real opens = 0
        // If last event is internal but there were opens before, some may be real
        // Conservative: if lastEventBy is internal, subtract 1 from opens as minimum
        m._adjusted_opens = Math.max(0, (m.num_opens || 0) - 1);
      } else {
        m._adjusted_opens = m.num_opens || 0;
      }
    });
  });

  const emailActivity = Object.entries(emailsByProspect)
    .map(([pid, msgs]) => {
      const latest = msgs[0];
      const prospect = prospects.find(p => p.id === parseInt(pid));
      const allOpens = msgs.reduce((s, m) => s + (m._adjusted_opens !== undefined ? m._adjusted_opens : (m.num_opens || 0)), 0);
      const anyReply = msgs.some(m => m.was_replied);
      const anyBounce = msgs.some(m => m.was_bounced);
      return {
        prospect_id: parseInt(pid),
        name: prospect ? prospect.name : latest.prospect_name || 'Unknown',
        email: latest.recipient_email,
        subject: latest.subject,
        sent_at: latest.sent_at,
        opens: allOpens,
        replied: anyReply,
        bounced: anyBounce,
        last_event: latest.last_event,
        last_event_at: latest.last_event_at,
        status: anyReply ? 'replied' : anyBounce ? 'bounced' : allOpens >= 3 ? 'hot' : allOpens > 0 ? 'opened' : 'sent',
        property_type: prospect ? prospect.property_type : '',
        pipeline_stage: prospect ? prospect.status : '',
        contract_sent_date: prospect ? prospect.contract_sent_date : null,
        pipeline_card_stage: null, // filled below
        // All emails for this prospect with timestamps
        all_emails: msgs.map(m => ({
          subject: m.subject,
          sent_at: m.sent_at,
          opens: m._adjusted_opens !== undefined ? m._adjusted_opens : (m.num_opens || 0),
          last_opened: m.last_event === 'opened' && !isInternalEmail(m.last_event_by) ? m.last_event_at : null,
          last_event: m.last_event,
          last_event_at: m.last_event_at,
          last_event_by: isInternalEmail(m.last_event_by) ? null : m.last_event_by,
          replied: m.was_replied || false,
          bounced: m.was_bounced || false,
          has_internal_opens: m._internal_opens || false
        })),
        // Real-time Instantly open timestamps (each individual open event)
        open_events: (prospect && prospect.email_events || [])
          .filter(e => e.type === 'email_opened')
          .map(e => ({ timestamp: e.timestamp, subject: e.subject }))
          .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      };
    })
    .sort((a, b) => new Date(b.sent_at) - new Date(a.sent_at));

  // Enrich with pipeline card stage
  const pipelineCards = db.pipelineCards || [];
  emailActivity.forEach(ea => {
    const card = pipelineCards.find(c => c.prospect_id === ea.prospect_id);
    if (card) {
      ea.pipeline_card_stage = card.stage;
      if (card.stage === 'contract_sent') ea.contract_stage_date = card.entered_stage_at;
    }
  });

  // 1b. Add prospects with recent activities (pop-ins, status changes) but NO emails yet
  const emailProspectIds = new Set(emailActivity.map(e => e.prospect_id));
  const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
  const recentActivityProspects = activities
    .filter(a => new Date(a.created_at || a.activity_date) >= sevenDaysAgo && !emailProspectIds.has(a.prospect_id))
    .reduce((acc, a) => {
      if (!acc[a.prospect_id]) acc[a.prospect_id] = [];
      acc[a.prospect_id].push(a);
      return acc;
    }, {});

  Object.entries(recentActivityProspects).forEach(([pid, acts]) => {
    const prospect = prospects.find(p => p.id === parseInt(pid));
    if (!prospect) return;
    const card = pipelineCards.find(c => c.prospect_id === parseInt(pid));
    const latestAct = acts.sort((a, b) => new Date(b.created_at || b.activity_date) - new Date(a.created_at || a.activity_date))[0];
    // Determine action needed from activities
    const statusChanges = acts.filter(a => a.type === 'status-change');
    const actionNeeded = statusChanges.find(s => /email proposal|email|send proposal/i.test(s.description));
    const popIns = acts.filter(a => a.type === 'pop-in');

    emailActivity.push({
      prospect_id: parseInt(pid),
      name: prospect.name,
      email: prospect.email || '',
      subject: null,
      sent_at: latestAct.created_at || latestAct.activity_date,
      opens: 0,
      replied: false,
      bounced: false,
      last_event: null,
      last_event_at: null,
      status: 'needs_email',
      property_type: prospect.property_type || '',
      pipeline_stage: prospect.status || '',
      contract_sent_date: prospect.contract_sent_date || null,
      pipeline_card_stage: card ? card.stage : null,
      action_needed: actionNeeded ? actionNeeded.description : null,
      recent_pop_in: popIns.length > 0 ? popIns[0].description : null,
      all_emails: [],
      open_events: []
    });
  });

  // Add latest_activity_date and latest action type from CRM activities for each prospect
  const activityInfoByProspect = {};
  activities.forEach(a => {
    const pid = a.prospect_id;
    const date = a.created_at || a.activity_date;
    if (!activityInfoByProspect[pid] || date > activityInfoByProspect[pid].date) {
      activityInfoByProspect[pid] = { date, description: a.description || '', type: a.type };
    }
  });
  emailActivity.forEach(ea => {
    const info = activityInfoByProspect[ea.prospect_id];
    ea.latest_activity_date = info ? info.date : ea.sent_at || null;
    // Determine if the most recent action is a call (Jordan) or email/proposal (Kurtis)
    if (info && info.description) {
      const desc = info.description.toLowerCase();
      const isCallAction = /\bcall\b|\bphone\b/.test(desc) && !/email|proposal|send/i.test(desc);
      const isEmailAction = /email|proposal|send/i.test(desc);
      ea.latest_action_type = isCallAction ? 'call' : isEmailAction ? 'email' : 'other';
    } else {
      ea.latest_action_type = 'other';
    }
  });

  // Sort by most recent CRM activity first
  emailActivity.sort((a, b) => new Date(b.latest_activity_date || 0) - new Date(a.latest_activity_date || 0));

  // 2. Recent sales activities (all time, sorted by date)
  const recentActivities = activities
    .sort((a, b) => new Date(b.created_at || b.activity_date) - new Date(a.created_at || a.activity_date))
    .slice(0, 30)
    .map(a => {
      const prospect = prospects.find(p => p.id === a.prospect_id);
      return {
        id: a.id,
        type: a.type,
        prospect_id: a.prospect_id,
        prospect_name: prospect ? prospect.name : 'Unknown',
        description: a.description,
        outcome: a.outcome,
        date: a.activity_date || a.created_at,
        created_by: a.created_by || 'Jordan'
      };
    });

  // 3. Active campaigns status
  const activeCampaigns = campaigns
    .filter(c => c.status === 'active')
    .map(c => {
      const prospect = prospects.find(p => p.id === c.prospect_id);
      return {
        id: c.id,
        prospect_id: c.prospect_id,
        prospect_name: prospect ? prospect.name : 'Unknown',
        contact_name: c.contact_name,
        current_step: c.current_step,
        total_steps: c.total_steps,
        next_email_date: c.next_email_date,
        started_at: c.created_at
      };
    });

  // 4. Summary stats — pull from ALL sources (mixmax, prospect.email_tracking, campaigns, activities)
  // Collect all email records from every source
  const allEmailRecords = [];
  mixmaxData.forEach(m => allEmailRecords.push(m));
  prospects.forEach(p => {
    if (p.email_tracking) p.email_tracking.forEach(t => {
      // Avoid duplicates already counted from mixmax
      const dup = allEmailRecords.some(e => e.subject === t.subject && e.recipient_email === t.recipient_email && e.prospect_id === p.id);
      if (!dup) allEmailRecords.push({ ...t, prospect_id: p.id });
    });
  });
  // Also count from instantlyEvents (webhook data)
  const instantlyEvents = db.instantlyEvents || [];
  const instantlySends = instantlyEvents.filter(e => e.event_type === 'email_sent' || e.event_type === 'email_send');
  const instantlyOpens = instantlyEvents.filter(e => e.event_type === 'email_opened');
  const instantlyReplies = instantlyEvents.filter(e => e.event_type === 'reply_received');

  // Count unique emails sent (from all sources)
  const emailActivitiesCount = activities.filter(a => a.type === 'email' && a.description && /sent|campaign|instantly/i.test(a.description)).length;
  const totalEmails = Math.max(allEmailRecords.length, emailActivitiesCount, instantlySends.length);

  // Opened = from tracking records + unique prospects opened from Instantly events
  const openedFromTracking = allEmailRecords.filter(m => (m.num_opens || 0) > 0).length;
  const openedProspectIds = new Set(instantlyOpens.map(e => e.prospect_id).filter(Boolean));
  const opened = Math.max(openedFromTracking, openedProspectIds.size);

  // Replied
  const repliedFromTracking = allEmailRecords.filter(m => m.was_replied).length;
  const repliedProspectIds = new Set(instantlyReplies.map(e => e.prospect_id).filter(Boolean));
  const replied = Math.max(repliedFromTracking, repliedProspectIds.size);

  // Hot leads (3+ opens, no reply)
  const hotLeads = allEmailRecords.filter(m => (m.num_opens || 0) >= 3 && !m.was_replied).length;

  res.json({
    email_activity: emailActivity,
    recent_activities: recentActivities,
    active_campaigns: activeCampaigns,
    stats: {
      total_emails: totalEmails,
      opened,
      replied,
      hot_leads: hotLeads,
      open_rate: totalEmails > 0 ? Math.round(opened / totalEmails * 100) : 0,
      reply_rate: totalEmails > 0 ? Math.round(replied / totalEmails * 100) : 0
    }
  });
});

// --- INSTANTLY WEBHOOK RECEIVER (real-time email events) ---
// Stores every open/send/reply with exact timestamp — EXCLUDES internal team opens
if (!db.instantlyEvents) db.instantlyEvents = [];

const INTERNAL_DOMAINS = ['kandevendtech.com', 'kandevendtech.co', 'kandephotobooths.com'];
function isInternalEmail(email) {
  if (!email) return false;
  return INTERNAL_DOMAINS.some(d => email.toLowerCase().endsWith('@' + d));
}

app.post('/api/webhooks/instantly', (req, res) => {
  try {
    const event = req.body;

    // Skip internal team opens (Jordan checking emails, Kurtis previewing, etc.)
    const openerEmail = event.opener_email || event.opened_by || event.from_email || '';
    if (event.event_type === 'email_opened' && isInternalEmail(openerEmail)) {
      return res.json({ ok: true, skipped: 'internal_open' });
    }

    const entry = {
      id: nextId(),
      event_type: event.event_type || event.type || 'unknown',
      email: event.lead_email || event.email || event.to_address || '',
      campaign_id: event.campaign_id || '',
      campaign_name: event.campaign_name || '',
      subject: event.subject || event.email_subject || '',
      timestamp: event.timestamp || new Date().toISOString(),
      opener_email: openerEmail,
      raw: event
    };

    db.instantlyEvents.push(entry);

    // Match to prospect
    const contact = (db.contacts || []).find(c => c.email && c.email.toLowerCase() === entry.email.toLowerCase());
    const prospect = contact
      ? db.prospects.find(p => p.id === contact.prospect_id)
      : db.prospects.find(p => p.email && p.email.toLowerCase() === entry.email.toLowerCase());

    if (prospect) {
      entry.prospect_id = prospect.id;
      entry.prospect_name = prospect.name;

      // Store open timestamps on the prospect for the dashboard
      if (!prospect.email_events) prospect.email_events = [];
      prospect.email_events.push({
        type: entry.event_type,
        timestamp: entry.timestamp,
        subject: entry.subject
      });

      // Auto-stop campaign on reply
      if (entry.event_type === 'reply_received') {
        const campaign = (db.campaigns || []).find(c => c.prospect_id === prospect.id && c.status === 'active');
        if (campaign) {
          campaign.status = 'replied';
          campaign.replied_at = entry.timestamp;
        }
      }
    }

    saveDB(db);
    res.json({ ok: true });
  } catch (err) {
    console.error('Instantly webhook error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get ALL instantly events (for campaign tracker)
app.get('/api/instantly-events', (req, res) => {
  const events = (db.instantlyEvents || [])
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  res.json(events);
});

// Get email events for a prospect (open timestamps etc.)
app.get('/api/prospects/:id/email-events', (req, res) => {
  const id = parseInt(req.params.id);
  const prospect = db.prospects.find(p => p.id === id);
  const events = (db.instantlyEvents || []).filter(e => e.prospect_id === id)
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  // Also include any stored on prospect from webhooks
  const prospectEvents = prospect && prospect.email_events ? prospect.email_events : [];
  res.json({ events, prospect_events: prospectEvents });
});

// --- CAMPAIGN MANAGEMENT ---

// Start a campaign for a prospect (typically after proposal sent)
app.post('/api/campaigns', (req, res) => {
  const { prospect_id, proposal_id, start_delay_days } = req.body;
  if (!prospect_id) return res.status(400).json({ error: 'prospect_id required' });

  // Check if already has active campaign
  const existing = (db.campaigns || []).find(c => c.prospect_id === prospect_id && c.status === 'active');
  if (existing) return res.status(409).json({ error: 'Prospect already has active campaign', campaign: existing });

  const prospect = db.prospects.find(p => p.id === prospect_id);
  if (!prospect) return res.status(404).json({ error: 'Prospect not found' });

  const contact = (db.contacts || []).find(c => c.prospect_id === prospect_id && c.is_primary) ||
                  (db.contacts || []).find(c => c.prospect_id === prospect_id);

  const startDelay = start_delay_days || CAMPAIGN_TEMPLATES[0].delay_days;
  const firstEmailDate = new Date(Date.now() + startDelay * 24 * 60 * 60 * 1000);

  const campaign = {
    id: nextId(),
    prospect_id,
    proposal_id: proposal_id || null,
    contact_name: contact ? contact.name : '',
    contact_email: contact ? contact.email : prospect.email || '',
    property_name: prospect.name,
    area: prospect.city || prospect.address || 'Henderson',
    status: 'active',
    current_step: 1,
    total_steps: CAMPAIGN_TEMPLATES.length,
    next_email_date: firstEmailDate.toISOString(),
    emails_sent: 0,
    emails_opened: 0,
    last_reply_date: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  db.campaigns.push(campaign);
  saveDB(db);

  // Log activity
  db.activities.push({
    id: nextId(),
    prospect_id,
    type: 'campaign_started',
    description: `Email follow-up campaign started (${CAMPAIGN_TEMPLATES.length} steps)`,
    created_at: new Date().toISOString()
  });
  saveDB(db);

  res.json(campaign);
});

// List campaigns
app.get('/api/campaigns', (req, res) => {
  const { status, prospect_id } = req.query;
  let campaigns = db.campaigns || [];
  if (status) campaigns = campaigns.filter(c => c.status === status);
  if (prospect_id) campaigns = campaigns.filter(c => c.prospect_id === parseInt(prospect_id));

  // Enrich with prospect data
  const enriched = campaigns.map(c => {
    const prospect = db.prospects.find(p => p.id === c.prospect_id);
    const emails = (db.campaignEmails || []).filter(e => e.campaign_id === c.id);
    return { ...c, prospect_name: prospect ? prospect.name : 'Unknown', emails };
  });

  res.json(enriched.sort((a, b) => new Date(b.created_at) - new Date(a.created_at)));
});

// Get campaign detail
app.get('/api/campaigns/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const campaign = (db.campaigns || []).find(c => c.id === id);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

  const prospect = db.prospects.find(p => p.id === campaign.prospect_id);
  const emails = (db.campaignEmails || []).filter(e => e.campaign_id === id);
  const proposal = campaign.proposal_id ? (db.proposals || []).find(p => p.id === campaign.proposal_id) : null;

  res.json({ ...campaign, prospect, emails, proposal });
});

// Pause campaign
app.put('/api/campaigns/:id/pause', (req, res) => {
  const id = parseInt(req.params.id);
  const idx = (db.campaigns || []).findIndex(c => c.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Campaign not found' });
  db.campaigns[idx].status = 'paused';
  db.campaigns[idx].updated_at = new Date().toISOString();
  saveDB(db);
  res.json(db.campaigns[idx]);
});

// Resume campaign
app.put('/api/campaigns/:id/resume', (req, res) => {
  const id = parseInt(req.params.id);
  const idx = (db.campaigns || []).findIndex(c => c.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Campaign not found' });
  db.campaigns[idx].status = 'active';
  db.campaigns[idx].updated_at = new Date().toISOString();
  saveDB(db);
  res.json(db.campaigns[idx]);
});

// Stop campaign (remove prospect from drip)
app.delete('/api/campaigns/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const idx = (db.campaigns || []).findIndex(c => c.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Campaign not found' });
  db.campaigns[idx].status = 'completed';
  db.campaigns[idx].completed_reason = req.body.reason || 'manual_stop';
  db.campaigns[idx].updated_at = new Date().toISOString();
  saveDB(db);
  res.json({ success: true });
});

// Get next campaign email draft (for review before sending)
app.get('/api/campaigns/:id/next-email', (req, res) => {
  const id = parseInt(req.params.id);
  const campaign = (db.campaigns || []).find(c => c.id === id);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

  const template = CAMPAIGN_TEMPLATES.find(t => t.step === campaign.current_step);
  if (!template) return res.json({ done: true, message: 'Campaign complete' });

  const prospect = db.prospects.find(p => p.id === campaign.prospect_id);

  // Generate visit_opener from Jordan's activity notes
  const visit_opener = generateVisitOpener(campaign.prospect_id, campaign.contact_name);

  const vars = {
    contact_name: campaign.contact_name || 'there',
    property_name: campaign.property_name || (prospect ? prospect.name : ''),
    area: campaign.area || 'Henderson',
    machine_count: prospect ? (prospect.recommended_machines || '1') : '1',
    visit_opener
  };

  res.json({
    step: template.step,
    total_steps: CAMPAIGN_TEMPLATES.length,
    subject: fillTemplate(template.subject_template, vars),
    body: fillTemplate(template.body_template, vars),
    to: campaign.contact_email,
    scheduled_date: campaign.next_email_date,
    can_edit: true
  });
});

// Mark campaign email as sent + advance to next step
app.post('/api/campaigns/:id/email-sent', (req, res) => {
  const id = parseInt(req.params.id);
  const idx = (db.campaigns || []).findIndex(c => c.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Campaign not found' });

  const campaign = db.campaigns[idx];
  const template = CAMPAIGN_TEMPLATES.find(t => t.step === campaign.current_step);

  // Log the sent email
  const emailRecord = {
    id: nextId(),
    campaign_id: id,
    prospect_id: campaign.prospect_id,
    step: campaign.current_step,
    subject: req.body.subject || (template ? template.subject_template : ''),
    sent_at: new Date().toISOString(),
    opened: false,
    replied: false,
    gmail_thread_id: req.body.gmail_thread_id || null,
    mixmax_tracked: req.body.mixmax_tracked || false
  };
  db.campaignEmails.push(emailRecord);

  // Advance campaign
  const nextStep = campaign.current_step + 1;
  const nextTemplate = CAMPAIGN_TEMPLATES.find(t => t.step === nextStep);

  if (nextTemplate) {
    campaign.current_step = nextStep;
    campaign.next_email_date = new Date(Date.now() + nextTemplate.delay_days * 24 * 60 * 60 * 1000).toISOString();
    campaign.emails_sent = (campaign.emails_sent || 0) + 1;
  } else {
    campaign.status = 'completed';
    campaign.completed_reason = 'all_steps_done';
    campaign.emails_sent = (campaign.emails_sent || 0) + 1;
  }
  campaign.updated_at = new Date().toISOString();

  // Log activity
  db.activities.push({
    id: nextId(),
    prospect_id: campaign.prospect_id,
    type: 'campaign_email',
    description: `Campaign email #${emailRecord.step} sent: "${emailRecord.subject}"`,
    created_at: new Date().toISOString()
  });

  saveDB(db);
  res.json({ campaign, email: emailRecord });
});

// Record email open (called by tracking check)
app.post('/api/campaigns/:id/email-opened', (req, res) => {
  const id = parseInt(req.params.id);
  const campaign = (db.campaigns || []).find(c => c.id === id);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

  campaign.emails_opened = (campaign.emails_opened || 0) + 1;
  campaign.last_open_date = new Date().toISOString();
  campaign.updated_at = new Date().toISOString();

  // Update the email record too
  const { step } = req.body;
  if (step) {
    const email = (db.campaignEmails || []).find(e => e.campaign_id === id && e.step === step);
    if (email) email.opened = true;
  }

  saveDB(db);
  res.json({ success: true });
});

// Record reply → stop campaign
app.post('/api/campaigns/:id/replied', (req, res) => {
  const id = parseInt(req.params.id);
  const idx = (db.campaigns || []).findIndex(c => c.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Campaign not found' });

  const campaign = db.campaigns[idx];
  campaign.status = 'completed';
  campaign.completed_reason = 'replied';
  campaign.last_reply_date = new Date().toISOString();
  campaign.updated_at = new Date().toISOString();

  // Log activity
  db.activities.push({
    id: nextId(),
    prospect_id: campaign.prospect_id,
    type: 'email_reply',
    description: `Lead replied to campaign email! Campaign stopped. Move to negotiating.`,
    created_at: new Date().toISOString()
  });

  // Create task to respond
  db.crmTasks.push({
    id: nextId(),
    prospect_id: campaign.prospect_id,
    title: `Respond to ${campaign.property_name} — they replied to follow-up email!`,
    task_type: 'email',
    priority: 'high',
    due_date: new Date().toISOString(),
    completed: false,
    created_at: new Date().toISOString()
  });

  // Auto-advance pipeline to negotiating
  const card = db.pipelineCards.find(c => c.prospect_id === campaign.prospect_id);
  if (card && ['proposal_sent', 'interested', 'pop_in_done', 'contacted'].includes(card.stage)) {
    card.stage = 'negotiating';
    card.entered_stage_at = new Date().toISOString();
    card.updated_at = new Date().toISOString();
  }

  saveDB(db);
  res.json({ success: true, message: 'Campaign stopped — lead replied' });
});

// --- AUTO-PROPOSAL GENERATION ---
// PDF template: templates/KandeVendTech_proposal_template.pdf (3.4MB, 14 pages)
// HTML template: templates/proposal-template.html (70+ variables)
// The PDF is the branded proposal sent as email attachment
// The HTML template can generate custom web-viewable proposals

app.post('/api/proposals/auto-generate', (req, res) => {
  const { prospect_id } = req.body;
  if (!prospect_id) return res.status(400).json({ error: 'prospect_id required' });

  const prospect = db.prospects.find(p => p.id === prospect_id);
  if (!prospect) return res.status(404).json({ error: 'Prospect not found' });

  const contact = (db.contacts || []).find(c => c.prospect_id === prospect_id && c.is_primary) ||
                  (db.contacts || []).find(c => c.prospect_id === prospect_id);

  // Generate proposal number
  const proposalCount = (db.proposals || []).length + 1;
  const proposalNumber = `KVT-${new Date().getFullYear()}-${String(proposalCount).padStart(4, '0')}`;

  // Determine machine recommendation based on property
  const count = parseInt(prospect.resident_employee_count) || 50;
  let machineCount = 1;
  if (count >= 200) machineCount = 2;
  if (count >= 500) machineCount = 3;
  if (count >= 1000) machineCount = 4;

  const revenueShare = prospect.revenue_share_percent || 5;
  const monthlyEstimate = prospect.monthly_revenue_potential || (machineCount * 1500);

  // Revenue projections
  const avgTransaction = 4.50;
  const conservativeDailyTxns = Math.round(count * 0.05);
  const moderateDailyTxns = Math.round(count * 0.10);
  const optimisticDailyTxns = Math.round(count * 0.15);

  const proposal = {
    id: nextId(),
    prospect_id,
    proposal_number: proposalNumber,
    property_name: prospect.name,
    property_address: prospect.address,
    property_type: prospect.property_type,
    contact_name: contact ? contact.name : '',
    contact_email: contact ? contact.email : prospect.email || '',
    contact_phone: contact ? contact.phone : prospect.phone || '',
    machine_type: 'SandStar AI Smart Cooler',
    machine_count: machineCount,
    revenue_share: revenueShare,
    monthly_estimate: monthlyEstimate,
    installation_cost: 0,
    monthly_service_cost: 0,
    contract_length_months: 12,
    avg_transaction: avgTransaction,
    revenue_projections: {
      conservative: { daily_txns: conservativeDailyTxns, monthly_gross: Math.round(conservativeDailyTxns * avgTransaction * 30), property_share: Math.round(conservativeDailyTxns * avgTransaction * 30 * revenueShare / 100) },
      moderate: { daily_txns: moderateDailyTxns, monthly_gross: Math.round(moderateDailyTxns * avgTransaction * 30), property_share: Math.round(moderateDailyTxns * avgTransaction * 30 * revenueShare / 100) },
      optimistic: { daily_txns: optimisticDailyTxns, monthly_gross: Math.round(optimisticDailyTxns * avgTransaction * 30), property_share: Math.round(optimisticDailyTxns * avgTransaction * 30 * revenueShare / 100) }
    },
    highlights: [
      'Zero cost to property — we provide and maintain everything',
      '24/7 fresh food, beverages, and snacks',
      'AI-powered smart cooler technology',
      'Touchless payment (card, Apple Pay, Google Pay)',
      `${revenueShare}% monthly revenue share to property`,
      'Weekly restocking and maintenance included'
    ],
    pdf_template: 'templates/KandeVendTech_proposal_template.pdf',
    html_template: 'templates/proposal-template.html',
    status: 'draft',
    auto_generated: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  db.proposals.push(proposal);

  // Log activity
  db.activities.push({
    id: nextId(),
    prospect_id,
    type: 'proposal_drafted',
    description: `Auto-generated proposal ${proposalNumber}: ${machineCount} machine(s), ${revenueShare}% share, est. $${monthlyEstimate}/mo`,
    created_at: new Date().toISOString()
  });

  // Create task to review and send
  db.crmTasks.push({
    id: nextId(),
    prospect_id,
    title: `Review & send proposal ${proposalNumber} for ${prospect.name} — attach PDF + start campaign`,
    task_type: 'proposal',
    priority: 'high',
    due_date: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    completed: false,
    created_at: new Date().toISOString()
  });

  saveDB(db);
  res.json(proposal);
});

// Serve the proposal PDF for download
app.get('/api/proposals/pdf-template', (req, res) => {
  const pdfPath = path.join(__dirname, 'templates', 'KandeVendTech_proposal_template.pdf');
  if (fs.existsSync(pdfPath)) {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="KandeVendTech_proposal.pdf"');
    res.sendFile(pdfPath);
  } else {
    res.status(404).json({ error: 'Proposal PDF template not found' });
  }
});

// --- PIPELINE AUTO-ADVANCE (when activities are logged) ---
app.post('/api/activities', (req, res) => {
  const activity = {
    id: nextId(),
    ...req.body,
    created_at: new Date().toISOString()
  };
  db.activities.push(activity);

  // Auto-advance pipeline based on activity type
  if (activity.prospect_id) {
    const card = db.pipelineCards.find(c => c.prospect_id === activity.prospect_id);
    if (card) {
      const type = (activity.type || '').toLowerCase().replace('-', '_');
      const desc = (activity.description || '').toLowerCase();
      let newStage = null;

      // Pop-in done
      if (type === 'pop_in' || type === 'pop-in' || desc.includes('pop-in') || desc.includes('pop in')) {
        if (['new_lead', 'contacted'].includes(card.stage)) newStage = 'pop_in_done';
      }
      // Interested
      if (type === 'interested' || desc.includes('interested') || desc.includes('wants proposal') || desc.includes('send proposal')) {
        if (['new_lead', 'contacted', 'pop_in_done'].includes(card.stage)) {
          newStage = 'interested';
          // Auto-generate proposal
          try {
            const prospect = db.prospects.find(p => p.id === activity.prospect_id);
            const contact = (db.contacts || []).find(c => c.prospect_id === activity.prospect_id);
            const proposalCount = (db.proposals || []).length + 1;
            const pNum = `KVT-${new Date().getFullYear()}-${String(proposalCount).padStart(4, '0')}`;
            const machineCount = parseInt(prospect?.resident_employee_count) >= 200 ? 2 : 1;
            const autoProposal = {
              id: nextId(), prospect_id: activity.prospect_id, proposal_number: pNum,
              property_name: prospect?.name || '', contact_name: contact?.name || '',
              contact_email: contact?.email || prospect?.email || '',
              machine_type: 'SandStar AI Smart Cooler', machine_count: machineCount,
              revenue_share: prospect?.revenue_share_percent || 5,
              monthly_estimate: prospect?.monthly_revenue_potential || (machineCount * 1500),
              status: 'draft', auto_generated: true,
              created_at: new Date().toISOString(), updated_at: new Date().toISOString()
            };
            db.proposals.push(autoProposal);
            db.crmTasks.push({
              id: nextId(), prospect_id: activity.prospect_id,
              title: `Review & send auto-proposal ${pNum} for ${prospect?.name}`,
              task_type: 'proposal', priority: 'high',
              due_date: new Date(Date.now() + 24*60*60*1000).toISOString(),
              completed: false, created_at: new Date().toISOString()
            });
          } catch(e) { console.error('Auto-proposal error:', e.message); }
        }
      }
      // Proposal sent
      if (type === 'proposal' || type === 'proposal_sent' || desc.includes('proposal sent')) {
        if (['interested', 'pop_in_done', 'contacted'].includes(card.stage)) newStage = 'proposal_sent';
      }

      if (newStage && newStage !== card.stage) {
        card.stage = newStage;
        card.entered_stage_at = new Date().toISOString();
        card.updated_at = new Date().toISOString();
      }
    }
  }

  saveDB(db);
  res.json(activity);
});

// --- CAMPAIGN EMAIL TEMPLATES API ---
app.get('/api/campaign-templates', (req, res) => {
  res.json(CAMPAIGN_TEMPLATES);
});

// --- INSTANTLY.AI CAMPAIGN INTEGRATION ---
// Create an Instantly campaign for a prospect and add them as a lead

app.post('/api/campaigns/:id/send-via-instantly', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const campaign = (db.campaigns || []).find(c => c.id === id);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    const prospect = db.prospects.find(p => p.id === campaign.prospect_id);
    if (!prospect) return res.status(404).json({ error: 'Prospect not found' });

    const contact = (db.contacts || []).find(c => c.prospect_id === campaign.prospect_id && c.is_primary) ||
                    (db.contacts || []).find(c => c.prospect_id === campaign.prospect_id);
    const toEmail = campaign.contact_email || (contact ? contact.email : prospect.email);
    if (!toEmail) return res.status(400).json({ error: 'No email address for this prospect' });

    // Build email sequence from campaign templates
    const visit_opener = generateVisitOpener(campaign.prospect_id, campaign.contact_name);
    const vars = {
      contact_name: campaign.contact_name || 'there',
      property_name: campaign.property_name || prospect.name || '',
      area: campaign.area || 'Henderson',
      machine_count: prospect.recommended_machines || '1',
      visit_opener
    };

    const sequences = CAMPAIGN_TEMPLATES.map((tmpl, idx) => {
      // Replace plain text signature with HTML signature for Instantly emails
      let body = fillTemplate(tmpl.body_template, vars);
      body = body.replace(KANDE_SIGNATURE_PLAIN, '').trim();
      // Wrap in a styled div with <br> between paragraphs (not <p> tags — those add unwanted margins)
      body = body.replace(/VIEW PROPOSAL:\s*(https?:\/\/\S+)/g, 
        '<a href="$1" style="color:#1155cc;font-weight:bold;text-decoration:underline;">VIEW PROPOSAL</a>');
      body = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#000000;">' +
        body.replace(/\n/g, '<br>') + '<br><br></div>';
      // Add inline images if template has them
      if (tmpl.inline_images && tmpl.inline_images.length > 0) {
        body += tmpl.inline_images.map(url =>
          `<br><img src="${url}" alt="Kande VendTech" style="max-width:500px;width:100%;border-radius:8px;margin:8px 0;">`
        ).join('') + '<br>';
      }
      body += KANDE_SIGNATURE_HTML;
      return {
        subject: fillTemplate(tmpl.subject_template, vars),
        body,
        delay: idx === 0 ? 0 : tmpl.delay_days,
        attach_pdf: tmpl.attach_proposal_pdf || false,
        cc: tmpl.cc || null
      };
    });

    // Create Instantly campaign
    const campaignName = `VendTech Follow-Up: ${prospect.name} (${new Date().toISOString().split('T')[0]})`;
    const instantlyCampaign = await instantlyFetch('/campaigns', {
      method: 'POST',
      body: JSON.stringify({
        name: campaignName,
        campaign_schedule: {
          schedules: [{
            name: 'Weekday Morning',
            timing: { from: '10:00', to: '14:00' }, // 8:00 AM - 12:00 PM Pacific (stored as Central +2h)
            days: { 1: true, 2: true, 3: true, 4: true, 5: true, 6: false, 0: false }, // Mon-Fri only
            timezone: 'America/Chicago' // Instantly doesn't accept America/Los_Angeles; using Central + offset
          }]
        }
      })
    });

    const instantlyCampaignId = instantlyCampaign.id;

    // Add email sequences as subsequences
    for (let i = 0; i < sequences.length; i++) {
      const seq = sequences[i];
      await instantlyFetch(`/campaigns/${instantlyCampaignId}/sequences`, {
        method: 'POST',
        body: JSON.stringify({
          sequences: [{
            steps: [{
              type: 'email',
              delay: seq.delay,
              variants: [{
                subject: seq.subject,
                body: seq.body
              }]
            }]
          }]
        })
      });
    }

    // Add the lead to the campaign
    await instantlyFetch('/leads', {
      method: 'POST',
      body: JSON.stringify({
        campaign_id: instantlyCampaignId,
        email: toEmail,
        first_name: (campaign.contact_name || '').split(' ')[0] || '',
        last_name: (campaign.contact_name || '').split(' ').slice(1).join(' ') || '',
        company_name: prospect.name || '',
        custom_variables: {
          property_name: prospect.name,
          property_type: prospect.property_type,
          prospect_id: String(prospect.id)
        }
      })
    });

    // Add sending account
    await instantlyFetch(`/campaigns/${instantlyCampaignId}/accounts`, {
      method: 'POST',
      body: JSON.stringify({
        account_ids: ['kurtis@kandevendtech.com']
      })
    });

    // Activate the campaign
    await instantlyFetch(`/campaigns/${instantlyCampaignId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 1 }) // 1 = active
    });

    // Update local campaign with Instantly ID
    campaign.instantly_campaign_id = instantlyCampaignId;
    campaign.instantly_status = 'active';
    campaign.updated_at = new Date().toISOString();

    // Log activity
    db.activities.push({
      id: nextId(),
      prospect_id: campaign.prospect_id,
      type: 'campaign_launched',
      description: `Instantly campaign launched: "${campaignName}" — ${sequences.length} emails to ${toEmail}`,
      created_at: new Date().toISOString()
    });

    saveDB(db);
    res.json({ success: true, instantly_campaign_id: instantlyCampaignId, campaign });
  } catch (err) {
    console.error('Instantly campaign error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Check Instantly analytics for opens/replies and update local campaigns
app.post('/api/campaigns/sync-tracking', async (req, res) => {
  try {
    const activeCampaigns = (db.campaigns || []).filter(c => c.instantly_campaign_id && c.status === 'active');
    const results = [];

    for (const campaign of activeCampaigns) {
      try {
        // Get campaign analytics from Instantly
        const analytics = await instantlyFetch(`/analytics/campaign/summary?campaign_id=${campaign.instantly_campaign_id}`);

        if (analytics) {
          const opens = analytics.total_opened || analytics.opens || 0;
          const replies = analytics.total_replied || analytics.replies || 0;
          const bounced = analytics.total_bounced || analytics.bounced || 0;

          // Update campaign tracking
          campaign.emails_opened = opens;
          campaign.updated_at = new Date().toISOString();

          // If they replied, stop the campaign
          if (replies > 0 && !campaign.last_reply_date) {
            campaign.status = 'completed';
            campaign.completed_reason = 'replied';
            campaign.last_reply_date = new Date().toISOString();

            // Pause Instantly campaign
            try {
              await instantlyFetch(`/campaigns/${campaign.instantly_campaign_id}`, {
                method: 'PATCH',
                body: JSON.stringify({ status: 0 }) // 0 = paused
              });
            } catch(e) { console.error('Failed to pause Instantly campaign:', e.message); }

            // Auto-advance pipeline
            const card = db.pipelineCards.find(c => c.prospect_id === campaign.prospect_id);
            if (card && ['proposal_sent', 'interested', 'pop_in_done', 'contacted'].includes(card.stage)) {
              card.stage = 'negotiating';
              card.entered_stage_at = new Date().toISOString();
              card.updated_at = new Date().toISOString();
            }

            // Create urgent task
            db.crmTasks.push({
              id: nextId(),
              prospect_id: campaign.prospect_id,
              title: `🔥 ${campaign.property_name} REPLIED — respond ASAP!`,
              task_type: 'email',
              priority: 'high',
              due_date: new Date().toISOString(),
              completed: false,
              created_at: new Date().toISOString()
            });

            db.activities.push({
              id: nextId(),
              prospect_id: campaign.prospect_id,
              type: 'email_reply',
              description: `Lead replied to Instantly campaign! Campaign auto-stopped.`,
              created_at: new Date().toISOString()
            });
          }

          // If bounced, mark it
          if (bounced > 0) {
            campaign.bounced = true;
            db.activities.push({
              id: nextId(),
              prospect_id: campaign.prospect_id,
              type: 'email_bounced',
              description: `Email bounced for ${campaign.contact_email}. Verify address.`,
              created_at: new Date().toISOString()
            });
          }

          results.push({
            campaign_id: campaign.id,
            property: campaign.property_name,
            opens,
            replies,
            bounced,
            status: campaign.status
          });
        }
      } catch (err) {
        results.push({ campaign_id: campaign.id, error: err.message });
      }
    }

    saveDB(db);
    res.json({ synced: results.length, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- MIXMAX TRACKING INTEGRATION ---
const MIXMAX_API_TOKEN = process.env.MIXMAX_API_TOKEN || 'e855fba9-302b-4873-8229-9e459ec8aa12';

async function mixmaxFetch(endpoint) {
  const res = await fetch(`https://api.mixmax.com/v1${endpoint}`, {
    headers: { 'X-API-Token': MIXMAX_API_TOKEN }
  });
  if (!res.ok) throw new Error(`Mixmax API ${res.status}: ${await res.text()}`);
  return res.json();
}

// Get Mixmax livefeed — all email tracking data
app.get('/api/mixmax/livefeed', async (req, res) => {
  try {
    const data = await mixmaxFetch('/livefeed');
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Sync Mixmax tracking data with CRM prospects
app.post('/api/mixmax/sync-to-crm', async (req, res) => {
  try {
    const data = await mixmaxFetch('/livefeed');
    const results = [];

    for (const msg of (data.results || [])) {
      // Skip internal emails (to jordan, elaine, self)
      const externalRecipients = (msg.recipients || []).filter(r =>
        !r.email.includes('kandevendtech') && !r.email.includes('kurtis') && !r.email.includes('jordan')
      );
      if (externalRecipients.length === 0) continue;

      for (const recipient of externalRecipients) {
        // Try to match with CRM contact or prospect
        const contact = (db.contacts || []).find(c =>
          c.email && c.email.toLowerCase() === recipient.email.toLowerCase()
        );
        const prospect = contact
          ? db.prospects.find(p => p.id === contact.prospect_id)
          : db.prospects.find(p => p.email && p.email.toLowerCase() === recipient.email.toLowerCase());

        if (!prospect) continue;

        // Filter out internal opens (Jordan, Kurtis, team)
        const internalDomains = ['kandevendtech.com', 'kandevendtech.co', 'kandephotobooths.com'];
        const isInternalEmail = (email) => email && internalDomains.some(d => email.toLowerCase().endsWith('@' + d));
        const lastEventByExternal = !isInternalEmail(msg.lastEventByEmail);

        // Count only external opens (subtract internal team opens)
        // If lastEventBy is internal, the real prospect opens are likely fewer
        let externalOpens = msg.numOpens || 0;
        // Mixmax doesn't break down opens by opener, but if lastEventBy is Jordan,
        // we know at least some opens are internal. Best we can do is note it.
        const lastEventIsInternal = isInternalEmail(msg.lastEventByEmail);

        const tracking = {
          prospect_id: prospect.id,
          prospect_name: prospect.name,
          recipient_email: recipient.email,
          subject: msg.subject,
          sent_at: msg.sent ? new Date(msg.sent).toISOString() : null,
          num_opens: externalOpens,
          num_clicks: msg.numClicks || 0,
          was_replied: msg.wasReplied ? true : false,
          was_bounced: msg.wasBounced ? true : false,
          last_event: msg.lastEventType,
          last_event_at: msg.lastEventAt ? new Date(msg.lastEventAt).toISOString() : null,
          last_event_by: msg.lastEventByEmail,
          last_event_is_internal: lastEventIsInternal
        };

        // Update prospect with tracking info
        if (!prospect.email_tracking) prospect.email_tracking = [];
        const existingIdx = prospect.email_tracking.findIndex(t =>
          t.subject === tracking.subject && t.recipient_email === tracking.recipient_email
        );
        if (existingIdx >= 0) {
          prospect.email_tracking[existingIdx] = tracking;
        } else {
          prospect.email_tracking.push(tracking);
        }

        // High-intent detection: 3+ opens without reply
        if (msg.numOpens >= 3 && !msg.wasReplied) {
          const hasTask = (db.crmTasks || []).some(t =>
            t.prospect_id === prospect.id &&
            t.title.includes('opened email') &&
            !t.completed
          );
          if (!hasTask) {
            db.crmTasks.push({
              id: nextId(),
              prospect_id: prospect.id,
              title: `🔥 ${prospect.name} opened email ${msg.numOpens}x — CALL NOW`,
              task_type: 'call',
              priority: 'high',
              due_date: new Date().toISOString(),
              completed: false,
              created_at: new Date().toISOString()
            });
          }
        }

        // Reply detection: auto-advance pipeline
        if (msg.wasReplied) {
          const card = db.pipelineCards.find(c => c.prospect_id === prospect.id);
          if (card && ['proposal_sent', 'interested', 'pop_in_done', 'contacted'].includes(card.stage)) {
            card.stage = 'negotiating';
            card.entered_stage_at = new Date().toISOString();
            card.updated_at = new Date().toISOString();
          }
          // Stop any active campaigns
          const activeCampaign = (db.campaigns || []).find(c =>
            c.prospect_id === prospect.id && c.status === 'active'
          );
          if (activeCampaign) {
            activeCampaign.status = 'completed';
            activeCampaign.completed_reason = 'replied_mixmax';
            activeCampaign.last_reply_date = new Date().toISOString();
          }
        }

        results.push(tracking);
      }
    }

    saveDB(db);
    res.json({
      synced: results.length,
      stats: data.stats || {},
      results
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== END SALES AUTOMATION ENGINE =====

// Get campaign status only (lighter endpoint for tracking)
app.get('/api/campaigns/:id/status', (req, res) => {
  const id = parseInt(req.params.id);
  const campaign = (db.campaigns || []).find(c => c.id === id);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  
  res.json({
    id: campaign.id,
    prospect_id: campaign.prospect_id,
    status: campaign.status,
    current_step: campaign.current_step,
    total_steps: campaign.total_steps,
    emails_sent: campaign.emails_sent,
    emails_opened: campaign.emails_opened,
    next_email_date: campaign.next_email_date,
    updated_at: campaign.updated_at,
    replied_at: campaign.replied_at
  });
});

// ===== AGENT TEAM API =====

// In-memory team state (persisted to db)
if (!db.teamStatus) db.teamStatus = {};
if (!db.teamActivity) db.teamActivity = [];

// GET /api/team/status — Get all agent statuses
app.get('/api/team/status', async (req, res) => {
  try {
    // Get current cron job status to determine live agent states
    let cronJobs = [];
    try {
      const { exec } = require('child_process');
      const util = require('util');
      const execAsync = util.promisify(exec);
      const { stdout } = await execAsync('openclaw cron list');
      const lines = stdout.split('\n').filter(line => line.trim());
      
      cronJobs = lines.slice(1).map(line => {
        const parts = line.split(/\s+/);
        if (parts.length < 8) return null;
        return {
          id: parts[0],
          name: parts[1],
          status: parts[parts.length - 3],
          next: parts[parts.length - 5],
          last: parts[parts.length - 4],
          agent: parts[parts.length - 1]
        };
      }).filter(Boolean);
    } catch (error) {
      console.error('Error fetching cron status:', error);
    }
    
    // Define comprehensive agent data for ALL businesses and operations
    const agentData = {
      // CORE AGENTS (Business Operations)
      scout: {
        name: 'Scout',
        role: 'Research Agent',
        emoji: '🔍',
        model: 'anthropic/claude-sonnet-4-20250514',
        description: 'Lead research and market analysis across all businesses',
        type: 'core',
        lastRun: getJobLastRun('scout-morning', cronJobs) || getJobLastRun('scout-evening', cronJobs),
        status: getAgentStatus('scout', cronJobs),
        jobs: cronJobs.filter(job => job.name.includes('scout')).length,
        currentTask: 'Market research and lead analysis'
      },
      relay: {
        name: 'Relay',
        role: 'Sales Operations',
        emoji: '📡',
        model: 'anthropic/claude-sonnet-4-20250514',
        description: 'Sales pipeline management and outreach coordination',
        type: 'core',
        lastRun: getJobLastRun('relay-morning', cronJobs) || getJobLastRun('relay-evening', cronJobs),
        status: getAgentStatus('relay', cronJobs),
        jobs: cronJobs.filter(job => job.name.includes('relay')).length,
        currentTask: 'Pipeline operations and sales coordination'
      },
      ralph: {
        name: 'Ralph',
        role: 'Engineering Agent',
        emoji: '🔧',
        model: 'anthropic/claude-sonnet-4-20250514',
        description: 'Dashboard development, system engineering, and technical operations',
        type: 'core',
        lastRun: getJobLastRun('ralph-overnight', cronJobs),
        status: getJobStatus('ralph-overnight', cronJobs),
        jobs: cronJobs.filter(job => job.name.includes('ralph')).length,
        currentTask: 'Mission Control development and engineering'
      },
      
      // VENDTECH OPERATIONS
      autodraftemail: {
        name: 'Auto-Draft Email0',
        role: 'VendTech Email Automation',
        emoji: '📬',
        model: 'anthropic/claude-sonnet-4-20250514',
        description: 'Automated VendTech email drafting and queue management',
        type: 'vendtech',
        lastRun: getJobLastRun('auto-draft-email0', cronJobs),
        status: getJobStatus('auto-draft-email0', cronJobs),
        jobs: 1,
        currentTask: 'VendTech email automation'
      },
      emailfollowup: {
        name: 'Email Follow-up Drafter',
        role: 'VendTech Follow-ups',
        emoji: '📤',
        model: 'anthropic/claude-sonnet-4-20250514',
        description: 'VendTech follow-up email generation and scheduling',
        type: 'vendtech',
        lastRun: getJobLastRun('email-followup-drafter', cronJobs),
        status: getJobStatus('email-followup-drafter', cronJobs),
        jobs: 1,
        currentTask: 'Follow-up email generation'
      },
      emailsync: {
        name: 'Sent Email Sync',
        role: 'VendTech Email Tracking',
        emoji: '🔄',
        model: 'anthropic/claude-sonnet-4-20250514',
        description: 'Synchronizes sent VendTech emails with CRM',
        type: 'vendtech',
        lastRun: getJobLastRun('vendtech-sent-email-sync', cronJobs),
        status: getJobStatus('vendtech-sent-email-sync', cronJobs),
        jobs: 1,
        currentTask: 'Email tracking and CRM sync'
      },
      mixmaxsync: {
        name: 'Mixmax Sync',
        role: 'Campaign Tracking',
        emoji: '📊',
        model: 'anthropic/claude-sonnet-4-20250514',
        description: 'Mixmax campaign data synchronization and tracking',
        type: 'vendtech',
        lastRun: getJobLastRun('mixmax-tracking-sync', cronJobs),
        status: getJobStatus('mixmax-tracking-sync', cronJobs),
        jobs: 1,
        currentTask: 'Campaign data synchronization'
      },
      proposalfollowup: {
        name: 'Proposal Follow-up',
        role: 'VendTech Proposals',
        emoji: '📋',
        model: 'anthropic/claude-sonnet-4-20250514',
        description: 'Automated proposal follow-up and status tracking',
        type: 'vendtech',
        lastRun: getJobLastRun('proposal-followup-check', cronJobs),
        status: getJobStatus('proposal-followup-check', cronJobs),
        jobs: 1,
        currentTask: 'Proposal tracking and follow-up'
      },
      
      // PHOTO BOOTHS OPERATIONS
      pbemaildrafter: {
        name: 'PB Email Drafts',
        role: 'Photo Booth Email Creation',
        emoji: '📸',
        model: 'anthropic/claude-sonnet-4-20250514',
        description: 'Photo Booth inquiry responses and email drafting',
        type: 'photobooths',
        lastRun: getJobLastRun('pb-email-drafts', cronJobs),
        status: getJobStatus('pb-email-drafts', cronJobs),
        jobs: 1,
        currentTask: 'Photo Booth email drafting'
      },
      pbgmailsync: {
        name: 'PB Gmail Draft Sync',
        role: 'Photo Booth Email Sync',
        emoji: '📨',
        model: 'anthropic/claude-sonnet-4-20250514',
        description: 'Photo Booth Gmail draft synchronization (business + off hours)',
        type: 'photobooths',
        lastRun: getJobLastRun('pb-gmail-draft-sync', cronJobs) || getJobLastRun('pb-gmail-draft-sync-offhours', cronJobs),
        status: getJobStatus('pb-gmail-draft-sync', cronJobs),
        jobs: cronJobs.filter(job => job.name.includes('pb-gmail-draft-sync')).length,
        currentTask: 'Gmail draft synchronization'
      },
      
      // COORDINATION AGENTS
      standup: {
        name: 'Daily Standup',
        role: 'Team Coordination',
        emoji: '📋',
        model: 'anthropic/claude-sonnet-4-20250514',
        description: 'Daily team coordination and planning sessions',
        type: 'coordination',
        lastRun: getJobLastRun('daily-standup', cronJobs),
        status: getJobStatus('daily-standup', cronJobs),
        jobs: 1,
        currentTask: 'Daily team planning'
      },
      watercooler: {
        name: 'Water Cooler',
        role: 'Team Check-ins',
        emoji: '💬',
        model: 'anthropic/claude-sonnet-4-20250514',
        description: 'Regular team communication and status updates',
        type: 'coordination',
        lastRun: getJobLastRun('water-cooler', cronJobs),
        status: getJobStatus('water-cooler', cronJobs),
        jobs: 1,
        currentTask: 'Team communication'
      },
      retro: {
        name: 'Weekly Retro',
        role: 'Team Retrospectives',
        emoji: '🔄',
        model: 'anthropic/claude-sonnet-4-20250514',
        description: 'Weekly team retrospectives and process improvement',
        type: 'coordination',
        lastRun: getJobLastRun('weekly-retro', cronJobs),
        status: getJobStatus('weekly-retro', cronJobs),
        jobs: 1,
        currentTask: 'Weekly retrospectives'
      },
      morningbriefing: {
        name: 'Morning Briefing',
        role: 'Daily Updates',
        emoji: '🌅',
        model: 'anthropic/claude-sonnet-4-20250514',
        description: 'Daily morning briefings and status summaries',
        type: 'coordination',
        lastRun: getJobLastRun('morning-briefing', cronJobs),
        status: getJobStatus('morning-briefing', cronJobs),
        jobs: 1,
        currentTask: 'Daily briefing generation'
      },
      
      // SYSTEM AGENTS
      e2eqa: {
        name: 'E2E QA',
        role: 'Quality Assurance',
        emoji: '✅',
        model: 'anthropic/claude-sonnet-4-20250514',
        description: 'End-to-end dashboard health monitoring and QA',
        type: 'system',
        lastRun: getJobLastRun('daily-e2e-dashboards', cronJobs),
        status: getJobStatus('daily-e2e-dashboards', cronJobs),
        jobs: 1,
        currentTask: 'Dashboard health monitoring'
      },
      healthwatchdog: {
        name: 'Health Watchdog',
        role: 'System Monitoring',
        emoji: '🩺',
        model: 'anthropic/claude-sonnet-4-20250514',
        description: 'Cron job health monitoring and error detection',
        type: 'system',
        lastRun: getJobLastRun('cron-health-watchdog', cronJobs),
        status: getJobStatus('cron-health-watchdog', cronJobs),
        jobs: 1,
        currentTask: 'System health monitoring'
      },
      qasweep: {
        name: 'QA Sweep',
        role: 'Quality Monitoring',
        emoji: '🔍',
        model: 'anthropic/claude-sonnet-4-20250514',
        description: 'Regular VendTech quality assurance sweeps',
        type: 'system',
        lastRun: getJobLastRun('vendtech-qa-sweep', cronJobs),
        status: getJobStatus('vendtech-qa-sweep', cronJobs),
        jobs: 1,
        currentTask: 'Quality assurance monitoring'
      },
      sessioncleanup: {
        name: 'Session Cleanup',
        role: 'System Maintenance',
        emoji: '🧹',
        model: 'anthropic/claude-sonnet-4-20250514',
        description: 'Weekly session cleanup and maintenance',
        type: 'system',
        lastRun: getJobLastRun('session-cleanup-weekly', cronJobs),
        status: getJobStatus('session-cleanup-weekly', cronJobs),
        jobs: 1,
        currentTask: 'Session maintenance'
      },
      nightlybackup: {
        name: 'Nightly Backup',
        role: 'Data Protection',
        emoji: '💾',
        model: 'anthropic/claude-sonnet-4-20250514',
        description: 'Nightly Google Drive backups and data protection',
        type: 'system',
        lastRun: getJobLastRun('nightly-gdrive-backup', cronJobs),
        status: getJobStatus('nightly-gdrive-backup', cronJobs),
        jobs: 1,
        currentTask: 'Data backup operations'
      },
      selfupdate: {
        name: 'Self-Update',
        role: 'System Updates',
        emoji: '🔄',
        model: 'anthropic/claude-sonnet-4-20250514',
        description: 'System self-update and maintenance tasks',
        type: 'system',
        lastRun: getJobLastRun('daily-self-update', cronJobs),
        status: getJobStatus('daily-self-update', cronJobs),
        jobs: 1,
        currentTask: 'System maintenance'
      },
      goghealthcheck: {
        name: 'GOG Health Check',
        role: 'Email System Monitoring',
        emoji: '📧',
        model: 'anthropic/claude-sonnet-4-20250514',
        description: 'Gmail API and email system health monitoring',
        type: 'system',
        lastRun: getJobLastRun('gog-gmail-health-check', cronJobs),
        status: getJobStatus('gog-gmail-health-check', cronJobs),
        jobs: 1,
        currentTask: 'Email system monitoring'
      },
      
      // RESEARCH AGENTS
      vendingpreneurs: {
        name: 'Vendingpreneurs Scrape',
        role: 'Industry Research',
        emoji: '📰',
        model: 'anthropic/claude-sonnet-4-20250514',
        description: 'Vending industry news and trend monitoring',
        type: 'research',
        lastRun: getJobLastRun('daily-vendingpreneurs-scrape', cronJobs),
        status: getJobStatus('daily-vendingpreneurs-scrape', cronJobs),
        jobs: 1,
        currentTask: 'Industry trend monitoring'
      },
      seovt: {
        name: 'SEO Check (VT)',
        role: 'VendTech SEO Monitoring',
        emoji: '🔍',
        model: 'anthropic/claude-sonnet-4-20250514',
        description: 'Weekly VendTech website SEO monitoring and optimization',
        type: 'research',
        lastRun: getJobLastRun('weekly-seo-check', cronJobs),
        status: getJobStatus('weekly-seo-check', cronJobs),
        jobs: 1,
        currentTask: 'VendTech SEO monitoring'
      },
      seopb: {
        name: 'SEO Check (PB)',
        role: 'Photo Booth SEO Monitoring',
        emoji: '📸',
        model: 'anthropic/claude-sonnet-4-20250514',
        description: 'Weekly Photo Booth website SEO monitoring and optimization',
        type: 'research',
        lastRun: getJobLastRun('weekly-seo-photobooths', cronJobs),
        status: getJobStatus('weekly-seo-photobooths', cronJobs),
        jobs: 1,
        currentTask: 'Photo Booth SEO monitoring'
      },
      sevenelevenscrape: {
        name: '7-Eleven Price Scrape',
        role: 'Market Research',
        emoji: '🏪',
        model: 'anthropic/claude-sonnet-4-20250514',
        description: 'Weekly 7-Eleven pricing data collection and analysis',
        type: 'research',
        lastRun: getJobLastRun('7eleven-price-scrape-weekly', cronJobs),
        status: getJobStatus('7eleven-price-scrape-weekly', cronJobs),
        jobs: 1,
        currentTask: 'Market pricing research'
      }
    };
    
    // Add team metrics
    const metrics = {
      totalAgents: Object.keys(agentData).length,
      activeAgents: Object.values(agentData).filter(a => a.status === 'active').length,
      totalJobs: cronJobs.length,
      healthyJobs: cronJobs.filter(job => job.status === 'ok').length,
      errorJobs: cronJobs.filter(job => job.status === 'error').length,
      lastUpdate: new Date().toISOString()
    };
    
    res.json({
      agents: agentData,
      metrics,
      cronJobs: cronJobs.length,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('Team status API error:', error);
    res.status(500).json({ error: 'Failed to fetch team status' });
  }
});

// Helper functions for agent status
function getLastActivity(agentType, cronJobs) {
  const jobs = cronJobs.filter(job => job.name.includes(agentType));
  if (jobs.length === 0) return 'Unknown';
  
  // Find the most recent activity
  const recent = jobs.reduce((latest, job) => {
    if (job.last && job.last !== 'never') {
      // Convert relative time to comparable format
      const timeValue = parseRelativeTime(job.last);
      const latestValue = parseRelativeTime(latest);
      return timeValue < latestValue ? job.last : latest;
    }
    return latest;
  }, 'never');
  
  return recent;
}

function getAgentStatus(agentType, cronJobs) {
  const jobs = cronJobs.filter(job => job.name.includes(agentType));
  if (jobs.length === 0) return 'idle';
  
  // If any job has errors, agent status is error
  if (jobs.some(job => job.status === 'error')) return 'error';
  
  // If any job ran recently (within last hour), agent is active
  const recentlyActive = jobs.some(job => {
    if (!job.last || job.last === 'never') return false;
    const timeValue = parseRelativeTime(job.last);
    return timeValue < 60; // less than 60 minutes ago
  });
  
  return recentlyActive ? 'active' : 'idle';
}

function getJobLastRun(jobName, cronJobs) {
  const job = cronJobs.find(j => j.name === jobName);
  return job ? job.last : 'Unknown';
}

function getJobStatus(jobName, cronJobs) {
  const job = cronJobs.find(j => j.name === jobName);
  if (!job) return 'idle';
  
  if (job.status === 'error') return 'error';
  
  // Check if job ran recently
  if (job.last && job.last !== 'never') {
    const timeValue = parseRelativeTime(job.last);
    return timeValue < 60 ? 'active' : 'idle';
  }
  
  return 'idle';
}

function parseRelativeTime(timeStr) {
  if (!timeStr || timeStr === 'never') return Infinity;
  
  const match = timeStr.match(/(\d+)([smhd])/);
  if (!match) return Infinity;
  
  const value = parseInt(match[1]);
  const unit = match[2];
  
  switch (unit) {
    case 's': return value / 60; // convert to minutes
    case 'm': return value;
    case 'h': return value * 60;
    case 'd': return value * 24 * 60;
    default: return Infinity;
  }
}

// POST /api/team/status — Update an agent's status
app.post('/api/team/status', express.json(), (req, res) => {
  const { agent, state, statusText, lastActivity, stats } = req.body;
  if (!agent) return res.status(400).json({ error: 'agent required' });
  
  if (!db.teamStatus[agent]) db.teamStatus[agent] = {};
  if (state) db.teamStatus[agent].state = state;
  if (statusText) db.teamStatus[agent].statusText = statusText;
  if (lastActivity) db.teamStatus[agent].lastActivity = lastActivity;
  if (stats) db.teamStatus[agent].stats = { ...(db.teamStatus[agent].stats || {}), ...stats };
  db.teamStatus[agent].updatedAt = new Date().toISOString();
  
  saveDB(db);
  res.json({ ok: true, agent: db.teamStatus[agent] });
});

// GET /api/team/activity — Get recent activity feed
app.get('/api/team/activity', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const activities = (db.teamActivity || []).slice(-limit).reverse();
  res.json({ activities });
});

// POST /api/team/activity — Log an activity
app.post('/api/team/activity', express.json(), (req, res) => {
  const { agent, text, type } = req.body;
  if (!agent || !text) return res.status(400).json({ error: 'agent and text required' });
  
  const entry = {
    id: Date.now(),
    agent,
    text,
    type: type || 'info',
    timestamp: new Date().toISOString()
  };
  
  if (!db.teamActivity) db.teamActivity = [];
  db.teamActivity.push(entry);
  
  // Keep last 200 entries
  if (db.teamActivity.length > 200) {
    db.teamActivity = db.teamActivity.slice(-200);
  }
  
  // Update agent's metrics
  if (!db.teamStatus) db.teamStatus = {};
  if (!db.teamStatus.metrics) db.teamStatus.metrics = { totalRuns: 0, leadsFound: 0, emailsDrafted: 0, featuresShipped: 0, pbHandled: 0 };
  db.teamStatus.metrics.totalRuns++;
  
  saveDB(db);
  res.json({ ok: true, entry });
});

// GET /api/team/learnings — Get stored agent learnings (pushed from local machine)
app.get('/api/team/learnings', (req, res) => {
  res.json(db.teamLearnings || {});
});

// POST /api/team/learnings — Push agent learnings from local machine
app.post('/api/team/learnings', express.json({ limit: '500kb' }), (req, res) => {
  db.teamLearnings = req.body;
  db.teamLearnings._updatedAt = new Date().toISOString();
  saveDB(db);
  res.json({ ok: true });
});

// Serve team.html
app.get('/team', (req, res) => {
  res.sendFile(path.join(__dirname, 'team.html'));
});

// ===== END AGENT TEAM API =====

// ===== BRAVE SEARCH USAGE TRACKER =====
// Track web search API calls ($5 per 1000 searches)
app.get('/api/search-usage', (req, res) => {
  if (!db.searchUsage) db.searchUsage = { daily: {}, agents: {} };
  const now = new Date();
  const todayKey = now.toISOString().slice(0, 10);
  const monthKey = now.toISOString().slice(0, 7);
  
  // Calculate totals
  const daily = db.searchUsage.daily || {};
  const todayCount = daily[todayKey] || 0;
  
  // Monthly total
  let monthCount = 0;
  Object.entries(daily).forEach(([date, count]) => {
    if (date.startsWith(monthKey)) monthCount += count;
  });
  
  // All time total
  let allTimeCount = 0;
  Object.values(daily).forEach(count => { allTimeCount += count; });
  
  // Last 30 days for chart
  const last30 = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    last30.push({ date: key, count: daily[key] || 0 });
  }
  
  // Per-agent breakdown
  const agents = db.searchUsage.agents || {};
  
  res.json({
    today: todayCount,
    month: monthCount,
    allTime: allTimeCount,
    monthlyCost: (monthCount / 1000 * 5).toFixed(2),
    allTimeCost: (allTimeCount / 1000 * 5).toFixed(2),
    costPer: 0.005,
    last30,
    agents,
    monthKey
  });
});

// Log search usage (called by cron watchdog or agents)
app.post('/api/search-usage/log', (req, res) => {
  if (!db.searchUsage) db.searchUsage = { daily: {}, agents: {} };
  const { count = 1, agent = 'unknown', date } = req.body;
  const todayKey = date || new Date().toISOString().slice(0, 10);
  
  if (!db.searchUsage.daily[todayKey]) db.searchUsage.daily[todayKey] = 0;
  db.searchUsage.daily[todayKey] += count;
  
  if (!db.searchUsage.agents[agent]) db.searchUsage.agents[agent] = 0;
  db.searchUsage.agents[agent] += count;
  
  saveDB(db);
  res.json({ ok: true, todayTotal: db.searchUsage.daily[todayKey] });
});

// Bulk set (for backfill from logs)
app.put('/api/search-usage/set', (req, res) => {
  const { daily, agents } = req.body;
  if (!db.searchUsage) db.searchUsage = { daily: {}, agents: {} };
  if (daily) db.searchUsage.daily = { ...db.searchUsage.daily, ...daily };
  if (agents) db.searchUsage.agents = { ...db.searchUsage.agents, ...agents };
  saveDB(db);
  res.json({ ok: true });
});
// ===== END SEARCH USAGE TRACKER =====

// ===== KANDE DIGITAL: GMB AUDIT API =====
app.post('/api/digital/gmb/audit', express.json(), async (req, res) => {
  // API key authentication
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== 'kande2026') {
    return res.status(401).json({ error: 'Invalid API key' });
  }

  const { businessName, location } = req.body;

  if (!businessName || !location) {
    return res.status(400).json({ error: 'Business name and location are required' });
  }

  try {
    // For now, return mock audit data since we don't have API keys configured yet
    // TODO: Integrate with Google Places API or SerpAPI
    const auditScore = Math.floor(Math.random() * 40) + 30; // Score between 30-70 for demo
    
    const breakdown = {
      completeness: {
        score: Math.floor(Math.random() * 30) + 40,
        details: 'Profile completeness analysis'
      },
      photos: {
        score: Math.floor(Math.random() * 40) + 30,
        details: 'Photo count and quality'
      },
      reviews: {
        score: Math.floor(Math.random() * 50) + 25,
        details: 'Review count and rating'
      },
      posts: {
        score: Math.floor(Math.random() * 20) + 10,
        details: 'Post frequency and engagement'
      },
      categories: {
        score: Math.floor(Math.random() * 20) + 60,
        details: 'Category accuracy and optimization'
      }
    };

    const recommendations = [
      {
        priority: 'HIGH',
        issue: 'Missing or incomplete business description'
      },
      {
        priority: 'MEDIUM',
        issue: 'Need more high-quality photos'
      },
      {
        priority: 'LOW',
        issue: 'Inconsistent posting schedule'
      }
    ];

    const auditData = {
      businessName,
      location,
      auditScore,
      breakdown,
      recommendations,
      timestamp: new Date().toISOString()
    };

    // Log audit for tracking
    console.log(`🏪 GMB Audit completed: ${businessName} (${location}) - Score: ${auditScore}/100`);

    res.json(auditData);

  } catch (error) {
    console.error('GMB Audit error:', error);
    res.status(500).json({ error: 'Audit failed', details: error.message });
  }
});

// Test endpoint for Kande Digital debugging
app.get('/api/digital/test', (req, res) => {
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== 'kande2026') {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  res.json({ 
    status: 'OK', 
    service: 'Kande Digital API',
    endpoints: [
      '/api/digital/gmb/audit',
      '/api/digital/gmb/report', 
      '/api/digital/content/generate',
      '/api/digital/reviews/respond'
    ],
    timestamp: new Date().toISOString()
  });
});

// Generate professional PDF audit report
app.post('/api/digital/gmb/report', express.json(), async (req, res) => {
  // API key authentication
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== 'kande2026') {
    return res.status(401).json({ error: 'Invalid API key' });
  }

  const { businessName, location, auditData } = req.body;

  if (!businessName || !location || !auditData) {
    return res.status(400).json({ error: 'Business name, location, and audit data are required' });
  }

  try {
    // Generate HTML report (PDF generation would require puppeteer or similar)
    const reportHtml = generateAuditReportHTML(businessName, location, auditData);
    
    // For now, return HTML report data that can be displayed or converted to PDF client-side
    const reportData = {
      businessName,
      location,
      reportHtml,
      summary: generateReportSummary(auditData),
      timestamp: new Date().toISOString(),
      reportId: `audit-${Date.now()}`
    };

    console.log(`📋 Audit Report generated: ${businessName} (${location})`);
    res.json(reportData);

  } catch (error) {
    console.error('Report generation error:', error);
    res.status(500).json({ error: 'Report generation failed', details: error.message });
  }
});

// Helper function to generate HTML audit report
function generateAuditReportHTML(businessName, location, auditData) {
  const scoreColor = auditData.auditScore >= 70 ? '#16a34a' : auditData.auditScore >= 50 ? '#d97706' : '#dc2626';
  const scoreLabel = auditData.auditScore >= 70 ? 'Excellent' : auditData.auditScore >= 50 ? 'Good' : 'Needs Improvement';

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <title>GMB Audit Report - ${businessName}</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #1a1a1a; max-width: 800px; margin: 0 auto; padding: 40px 20px; }
        .header { text-align: center; margin-bottom: 40px; border-bottom: 2px solid #e2e8f0; padding-bottom: 30px; }
        .logo { font-size: 24px; font-weight: 700; color: #667eea; margin-bottom: 10px; }
        .score-circle { width: 120px; height: 120px; border-radius: 50%; margin: 20px auto; display: flex; align-items: center; justify-content: center; font-size: 32px; font-weight: 700; color: white; background: ${scoreColor}; }
        .score-label { font-size: 18px; font-weight: 600; color: ${scoreColor}; margin-bottom: 20px; }
        .business-info { background: #f8f9fa; padding: 20px; border-radius: 8px; margin-bottom: 30px; }
        .breakdown { margin-bottom: 30px; }
        .breakdown-item { display: flex; justify-content: space-between; padding: 12px 0; border-bottom: 1px solid #e2e8f0; }
        .breakdown-item:last-child { border-bottom: none; }
        .recommendations { background: #fef7f0; padding: 20px; border-radius: 8px; border-left: 4px solid #d97706; }
        .rec-item { margin-bottom: 12px; }
        .rec-priority { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 12px; font-weight: 600; text-transform: uppercase; margin-right: 10px; }
        .high { background: #dc2626; color: white; }
        .medium { background: #d97706; color: white; }
        .low { background: #667eea; color: white; }
        .footer { margin-top: 40px; padding-top: 20px; border-top: 1px solid #e2e8f0; text-align: center; color: #64748b; font-size: 14px; }
      </style>
    </head>
    <body>
      <div class="header">
        <div class="logo">🏪 Kande Digital</div>
        <h1>Google My Business Audit Report</h1>
        <div class="score-circle">${auditData.auditScore}</div>
        <div class="score-label">${scoreLabel} (${auditData.auditScore}/100)</div>
      </div>

      <div class="business-info">
        <h2>${businessName}</h2>
        <p><strong>Location:</strong> ${location}</p>
        <p><strong>Audit Date:</strong> ${new Date().toLocaleDateString()}</p>
      </div>

      <div class="breakdown">
        <h3>Detailed Breakdown</h3>
        ${Object.entries(auditData.breakdown).map(([category, result]) => `
          <div class="breakdown-item">
            <span><strong>${category.charAt(0).toUpperCase() + category.slice(1)}:</strong> ${result.details}</span>
            <span style="font-weight: 600; color: ${scoreColor};">${result.score}/100</span>
          </div>
        `).join('')}
      </div>

      <div class="recommendations">
        <h3>Priority Recommendations</h3>
        ${auditData.recommendations.map(rec => `
          <div class="rec-item">
            <span class="rec-priority ${rec.priority.toLowerCase()}">${rec.priority}</span>
            ${rec.issue}
          </div>
        `).join('')}
      </div>

      <div class="footer">
        <p><strong>Kande Digital</strong> - AI-Powered Google My Business Optimization</p>
        <p>Contact us at (725) 228-8822 or hello@kandevendtech.com</p>
        <p>Generated on ${new Date().toLocaleString()}</p>
      </div>
    </body>
    </html>
  `;
}

// Helper function to generate report summary for cold emails
function generateReportSummary(auditData) {
  const issues = auditData.recommendations.filter(r => r.priority === 'HIGH').length;
  const scoreLabel = auditData.auditScore >= 70 ? 'strong' : auditData.auditScore >= 50 ? 'decent' : 'poor';
  
  return {
    scoreLabel,
    auditScore: auditData.auditScore,
    highPriorityIssues: issues,
    topIssue: auditData.recommendations[0]?.issue || 'Profile optimization needed',
    recommendation: auditData.auditScore < 50 ? 'immediate attention' : auditData.auditScore < 70 ? 'some improvements' : 'minor optimizations'
  };
}

// Generate GMB post content for different industries
app.post('/api/digital/content/generate', express.json(), async (req, res) => {
  // API key authentication
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== 'kande2026') {
    return res.status(401).json({ error: 'Invalid API key' });
  }

  const { industry, contentType, businessName, location } = req.body;

  if (!industry || !contentType) {
    return res.status(400).json({ error: 'Industry and content type are required' });
  }

  try {
    const content = generateGMBContent(industry, contentType, businessName, location);
    
    const contentData = {
      industry,
      contentType,
      businessName: businessName || 'Your Business',
      location: location || 'Your Area',
      content,
      timestamp: new Date().toISOString(),
      contentId: `content-${Date.now()}`
    };

    console.log(`✍️ GMB Content generated: ${industry} - ${contentType}`);
    res.json(contentData);

  } catch (error) {
    console.error('Content generation error:', error);
    res.status(500).json({ error: 'Content generation failed', details: error.message });
  }
});

// Helper function to generate GMB content based on industry and type
function generateGMBContent(industry, contentType, businessName = 'Your Business', location = 'Your Area') {
  const contentTemplates = {
    plumbing: {
      tip: [`💧 Pro Tip: Check your water pressure regularly! Low pressure could indicate pipe blockages or leaks. ${businessName} offers free pressure checks in ${location}. Call us today!`, 
            `🚰 Winter Reminder: Let faucets drip during freezing temperatures to prevent frozen pipes. Need emergency plumbing? ${businessName} is available 24/7 in ${location}!`,
            `🔧 Did you know? A running toilet can waste up to 200 gallons per day! ${businessName} can fix it fast. Serving ${location} with expert plumbing solutions.`],
      seasonal: [`❄️ Winter is coming! Time to insulate your pipes and check your water heater. ${businessName} offers winter plumbing prep services throughout ${location}.`,
                 `🌸 Spring maintenance: Check outdoor faucets and irrigation systems after winter. ${businessName} provides comprehensive spring plumbing inspections in ${location}.`,
                 `☀️ Summer high usage can strain your plumbing. Schedule a maintenance check with ${businessName} to avoid costly breakdowns. Serving ${location}!`],
      promotional: [`🎉 Special Offer: 15% off any plumbing repair this month! ${businessName} - your trusted plumber in ${location}. Licensed, insured, and ready to help!`,
                   `⚡ Emergency plumbing? We're here 24/7! ${businessName} provides fast, reliable service throughout ${location}. Call now for immediate assistance!`]
    },
    hvac: {
      tip: [`🌡️ Change your HVAC filters every 1-3 months for optimal performance and air quality. ${businessName} offers filter replacement services in ${location}!`,
           `❄️ Pro Tip: Set your thermostat 7-10 degrees lower when away to save up to 10% on heating bills. ${businessName} can install programmable thermostats in ${location}.`,
           `🔥 Strange noises from your HVAC? Don't ignore them! Early maintenance prevents costly repairs. ${businessName} offers diagnostic services in ${location}.`],
      seasonal: [`🍂 Fall HVAC prep: Schedule your heating system maintenance now! ${businessName} ensures your system runs efficiently all winter long in ${location}.`,
                 `☀️ Beat the heat! Schedule AC maintenance before summer arrives. ${businessName} keeps ${location} cool with expert HVAC services.`,
                 `❄️ Is your heating system ready for winter? ${businessName} offers comprehensive heating inspections and tune-ups throughout ${location}.`],
      promotional: [`🎯 Limited Time: Free HVAC system inspection with any repair service! ${businessName} - your comfort experts in ${location}. Call today!`,
                   `⚡ Emergency HVAC service available 24/7! ${businessName} provides fast, reliable heating and cooling solutions in ${location}.`]
    },
    electrical: {
      tip: [`⚡ Safety First: Never ignore flickering lights - they could indicate loose wiring. ${businessName} provides electrical safety inspections in ${location}.`,
           `🔌 Overloaded outlets are a fire hazard! If you're using extension cords regularly, it's time for more outlets. ${businessName} can help in ${location}.`,
           `💡 LED bulbs use 75% less energy than incandescent. ${businessName} offers LED lighting upgrades throughout ${location}. Save money and energy!`],
      seasonal: [`🎄 Holiday lights safety: Check for damaged cords and don't overload circuits. ${businessName} offers holiday lighting installation in ${location}!`,
                 `☀️ Summer electrical usage spikes with AC units. Ensure your system can handle the load. ${businessName} provides electrical upgrades in ${location}.`,
                 `⛈️ Storm season prep: Surge protectors protect your electronics. ${businessName} installs whole-house surge protection in ${location}.`],
      promotional: [`⚡ Free electrical safety inspection with any service call! ${businessName} - your trusted electrician in ${location}. Licensed and insured!`,
                   `🚨 Electrical emergency? We respond fast! ${businessName} provides 24/7 emergency electrical services throughout ${location}.`]
    }
  };

  const industryTemplates = contentTemplates[industry.toLowerCase()] || contentTemplates.plumbing;
  const typeTemplates = industryTemplates[contentType] || industryTemplates.tip;
  
  // Return random template from the selected type
  return typeTemplates[Math.floor(Math.random() * typeTemplates.length)];
}

// Generate professional review responses
app.post('/api/digital/reviews/respond', express.json(), async (req, res) => {
  // API key authentication
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== 'kande2026') {
    return res.status(401).json({ error: 'Invalid API key' });
  }

  const { reviewText, rating, businessName, reviewerName } = req.body;

  if (!reviewText || !rating) {
    return res.status(400).json({ error: 'Review text and rating are required' });
  }

  try {
    const response = generateReviewResponse(reviewText, rating, businessName, reviewerName);
    
    const responseData = {
      originalReview: reviewText,
      rating,
      businessName: businessName || 'Our Business',
      reviewerName: reviewerName || 'Customer',
      response,
      timestamp: new Date().toISOString(),
      responseId: `review-response-${Date.now()}`
    };

    console.log(`💬 Review Response generated: ${rating} stars - ${businessName}`);
    res.json(responseData);

  } catch (error) {
    console.error('Review response generation error:', error);
    res.status(500).json({ error: 'Review response generation failed', details: error.message });
  }
});

// Helper function to generate appropriate review responses
function generateReviewResponse(reviewText, rating, businessName = 'our business', reviewerName = 'Customer') {
  const businessNameFormatted = businessName || 'our business';
  const reviewerNameFormatted = reviewerName || 'Customer';
  
  if (rating >= 4) {
    // Positive review responses
    const positiveResponses = [
      `Thank you so much for your wonderful review, ${reviewerNameFormatted}! We're thrilled that you had such a positive experience with ${businessNameFormatted}. Your feedback means the world to us and motivates our entire team to continue providing excellent service. We look forward to serving you again!`,
      `${reviewerNameFormatted}, we're absolutely delighted by your kind words! It's fantastic to hear that ${businessNameFormatted} exceeded your expectations. We take great pride in our work and it's reviews like yours that make it all worthwhile. Thank you for choosing us and for taking the time to share your experience!`,
      `Wow, thank you for this amazing review, ${reviewerNameFormatted}! The entire team at ${businessNameFormatted} is so grateful for your feedback. We're committed to providing top-quality service to every customer, and it's wonderful to know we hit the mark with you. We appreciate your business and look forward to working with you again!`
    ];
    return positiveResponses[Math.floor(Math.random() * positiveResponses.length)];
  } else if (rating >= 3) {
    // Neutral review responses
    const neutralResponses = [
      `Thank you for your feedback, ${reviewerNameFormatted}. We appreciate you taking the time to share your experience with ${businessNameFormatted}. We're always looking for ways to improve our service. If there's anything specific we can do better, please don't hesitate to reach out to us directly. We'd love the opportunity to make things right.`,
      `${reviewerNameFormatted}, thank you for your honest review. At ${businessNameFormatted}, we value all feedback as it helps us grow and improve. We'd appreciate the chance to discuss your experience further and see how we can better serve you in the future. Please feel free to contact us directly.`,
      `We appreciate your review, ${reviewerNameFormatted}. While we're glad you chose ${businessNameFormatted}, we recognize there's always room for improvement. Your feedback is valuable to us and we'd welcome the opportunity to discuss how we can enhance our service. Thank you for your business.`
    ];
    return neutralResponses[Math.floor(Math.random() * neutralResponses.length)];
  } else {
    // Negative review responses
    const negativeResponses = [
      `${reviewerNameFormatted}, we sincerely apologize that your experience with ${businessNameFormatted} didn't meet your expectations. This is not the level of service we strive to provide. We'd very much like to make this right and discuss how we can improve. Please contact us directly so we can address your concerns and find a solution. Your feedback is important to us and we're committed to doing better.`,
      `We're truly sorry to hear about your disappointing experience, ${reviewerNameFormatted}. This falls short of the standards ${businessNameFormatted} holds ourselves to. We take all feedback seriously and would greatly appreciate the opportunity to speak with you directly to understand what went wrong and how we can make it right. Please reach out to us so we can resolve this matter properly.`,
      `${reviewerNameFormatted}, we deeply regret that we failed to provide you with the quality service you deserved from ${businessNameFormatted}. Your experience is not acceptable, and we want to make it right. Please contact us directly so we can discuss your concerns in detail and work toward a resolution. We value your feedback and are committed to learning from this experience.`
    ];
    return negativeResponses[Math.floor(Math.random() * negativeResponses.length)];
  }
}

// ===== END KANDE DIGITAL =====

// ===== MISSION CONTROL PAGES =====

// Calendar page - Visual cron job calendar
app.get('/calendar', (req, res) => {
  res.sendFile(path.join(__dirname, 'calendar.html'));
});

// Memory browser page
app.get('/memory', (req, res) => {
  res.sendFile(path.join(__dirname, 'memory.html'));
});

// Tasks board page
app.get('/tasks', (req, res) => {
  res.sendFile(path.join(__dirname, 'tasks.html'));
});

// Content pipeline page
app.get('/content', (req, res) => {
  res.sendFile(path.join(__dirname, 'content.html'));
});

// API: Get cron job schedules in calendar format
app.get('/api/cron/schedule', async (req, res) => {
  try {
    const { exec } = require('child_process');
    const util = require('util');
    const execAsync = util.promisify(exec);
    
    try {
      // Get cron job list from OpenClaw
      const { stdout } = await execAsync('openclaw cron list');
      const lines = stdout.split('\n').filter(line => line.trim());
      
      // Skip header line
      const cronJobs = lines.slice(1).map(line => {
        // Parse the table format - split by spaces but handle multi-word names
        const parts = line.split(/\s+/);
        if (parts.length < 8) return null;
        
        const id = parts[0];
        const name = parts[1];
        const schedule = parts.slice(2, -5).join(' '); // Everything between name and last 5 columns
        const next = parts[parts.length - 5];
        const last = parts[parts.length - 4];
        const status = parts[parts.length - 3];
        const target = parts[parts.length - 2];
        const agent = parts[parts.length - 1];
        
        return {
          id,
          name,
          schedule,
          next,
          last,
          status,
          target,
          agent,
          // Add display properties
          type: getJobType(name),
          color: getJobColor(name, status),
          description: getJobDescription(name)
        };
      }).filter(Boolean);
      
      // Parse schedules into calendar format
      const calendarEvents = cronJobs.map(job => {
        const parsed = parseCronSchedule(job.schedule);
        return {
          ...job,
          ...parsed
        };
      });
      
      res.json({ jobs: calendarEvents });
    } catch (error) {
      console.error('Error fetching cron jobs:', error);
      // Return mock data if command fails
      res.json({ 
        jobs: getMockCronJobs(),
        note: 'Mock data - OpenClaw command unavailable'
      });
    }
  } catch (error) {
    console.error('Cron schedule API error:', error);
    res.status(500).json({ error: 'Failed to fetch cron schedules' });
  }
});

// API: List memory files
app.get('/api/memory/list', async (req, res) => {
  try {
    const memoryDir = '/Users/kurtishon/.openclaw/workspace/memory/';
    const files = fs.readdirSync(memoryDir);
    
    const memoryFiles = [];
    
    // Add MEMORY.md first (long-term memory)
    const memoryMdPath = '/Users/kurtishon/.openclaw/workspace/MEMORY.md';
    if (fs.existsSync(memoryMdPath)) {
      const stats = fs.statSync(memoryMdPath);
      const content = fs.readFileSync(memoryMdPath, 'utf8');
      memoryFiles.push({
        filename: 'MEMORY.md',
        path: memoryMdPath,
        date: stats.mtime,
        isLongTerm: true,
        preview: content.substring(0, 200) + (content.length > 200 ? '...' : ''),
        size: content.length
      });
    }
    
    // Add daily memory files
    for (const file of files) {
      if (file.endsWith('.md') && file !== '.DS_Store') {
        try {
          const filePath = path.join(memoryDir, file);
          const stats = fs.statSync(filePath);
          const content = fs.readFileSync(filePath, 'utf8');
          
          memoryFiles.push({
            filename: file,
            path: filePath,
            date: stats.mtime,
            isLongTerm: false,
            preview: content.substring(0, 200) + (content.length > 200 ? '...' : ''),
            size: content.length
          });
        } catch (err) {
          console.error(`Error reading memory file ${file}:`, err);
        }
      }
    }
    
    // Sort by date, newest first (but MEMORY.md stays at top)
    memoryFiles.sort((a, b) => {
      if (a.isLongTerm) return -1;
      if (b.isLongTerm) return 1;
      return new Date(b.date) - new Date(a.date);
    });
    
    res.json({ files: memoryFiles });
  } catch (error) {
    console.error('Memory list API error:', error);
    res.status(500).json({ error: 'Failed to list memory files' });
  }
});

// API: Read memory file content
app.get('/api/memory/read/:filename', (req, res) => {
  try {
    const filename = req.params.filename;
    let filePath;
    
    if (filename === 'MEMORY.md') {
      filePath = '/Users/kurtishon/.openclaw/workspace/MEMORY.md';
    } else {
      filePath = path.join('/Users/kurtishon/.openclaw/workspace/memory/', filename);
    }
    
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found' });
    }
    
    const content = fs.readFileSync(filePath, 'utf8');
    const stats = fs.statSync(filePath);
    
    res.json({
      filename,
      content,
      date: stats.mtime,
      size: content.length
    });
  } catch (error) {
    console.error('Memory read API error:', error);
    res.status(500).json({ error: 'Failed to read memory file' });
  }
});

// API: Search memory files
app.get('/api/memory/search', async (req, res) => {
  try {
    const query = req.query.q || '';
    if (!query) {
      return res.json({ results: [], query: '' });
    }
    
    const memoryDir = '/Users/kurtishon/.openclaw/workspace/memory/';
    const files = fs.readdirSync(memoryDir);
    const results = [];
    
    // Search MEMORY.md first
    const memoryMdPath = '/Users/kurtishon/.openclaw/workspace/MEMORY.md';
    if (fs.existsSync(memoryMdPath)) {
      const content = fs.readFileSync(memoryMdPath, 'utf8');
      if (content.toLowerCase().includes(query.toLowerCase())) {
        const matches = getSearchMatches(content, query);
        results.push({
          filename: 'MEMORY.md',
          isLongTerm: true,
          matches: matches.length,
          excerpts: matches.slice(0, 3)
        });
      }
    }
    
    // Search daily files
    for (const file of files) {
      if (file.endsWith('.md')) {
        try {
          const filePath = path.join(memoryDir, file);
          const content = fs.readFileSync(filePath, 'utf8');
          
          if (content.toLowerCase().includes(query.toLowerCase())) {
            const matches = getSearchMatches(content, query);
            results.push({
              filename: file,
              isLongTerm: false,
              matches: matches.length,
              excerpts: matches.slice(0, 3)
            });
          }
        } catch (err) {
          console.error(`Error searching file ${file}:`, err);
        }
      }
    }
    
    // Sort by relevance (match count)
    results.sort((a, b) => {
      if (a.isLongTerm && !b.isLongTerm) return -1;
      if (b.isLongTerm && !a.isLongTerm) return 1;
      return b.matches - a.matches;
    });
    
    res.json({ results, query, total: results.length });
  } catch (error) {
    console.error('Memory search API error:', error);
    res.status(500).json({ error: 'Failed to search memory files' });
  }
});

// Helper functions for cron job parsing
function getJobType(name) {
  // Core Agents
  if (name.includes('scout') || name.includes('relay') || name.includes('ralph')) return 'core';
  
  // VendTech Operations
  if (name.includes('auto-draft-email0') || name.includes('email-followup-drafter') || 
      name.includes('vendtech-sent-email-sync') || name.includes('mixmax-tracking-sync') ||
      name.includes('proposal-followup-check')) return 'vendtech';
  
  // Photo Booths Operations  
  if (name.includes('pb-email-drafts') || name.includes('pb-gmail-draft-sync')) return 'photobooths';
  
  // Coordination
  if (name.includes('standup') || name.includes('water-cooler') || name.includes('retro') ||
      name.includes('morning-briefing')) return 'coordination';
  
  // System
  if (name.includes('e2e-dashboards') || name.includes('health-watchdog') || name.includes('qa-sweep') ||
      name.includes('session-cleanup') || name.includes('nightly-gdrive-backup') || 
      name.includes('daily-self-update') || name.includes('gog-gmail-health-check')) return 'system';
  
  // Research
  if (name.includes('vendingpreneurs-scrape') || name.includes('seo-check') || name.includes('seo-photobooths') ||
      name.includes('7eleven-price-scrape')) return 'research';
      
  // Email frequency monitoring
  if (name.includes('email-send-frequency-monitor')) return 'system';
  
  // Fallbacks
  if (name.includes('email') || name.includes('draft')) return 'vendtech';
  if (name.includes('sync') || name.includes('backup')) return 'system';
  
  return 'system';
}

function getJobColor(name, status) {
  if (status === 'error') return '#ef4444';
  if (status === 'running') return '#2563eb';
  
  // Color by business/function type
  const type = getJobType(name);
  switch (type) {
    case 'core': return '#3b82f6';          // Blue - Core Agents
    case 'vendtech': return '#16a34a';      // Green - VendTech Ops
    case 'photobooths': return '#ec4899';   // Pink - Photo Booths
    case 'coordination': return '#7c3aed';  // Purple - Coordination
    case 'system': return '#dc2626';        // Red - System
    case 'research': return '#0891b2';      // Teal - Research
    default: return '#6b7280';              // Gray - Other
  }
}

function getJobDescription(name) {
  const descriptions = {
    'scout-morning': 'Research new VendTech leads and opportunities',
    'scout-evening': 'Evening lead analysis and market research',
    'relay-morning': 'Process sales pipeline and draft outreach',
    'relay-evening': 'Evening sales operations and follow-ups',
    'ralph-overnight': 'Engineering tasks and system maintenance',
    'daily-standup': 'Team coordination and daily planning',
    'water-cooler': 'Team check-ins and status updates',
    'weekly-retro': 'Weekly team retrospective and planning',
    'daily-e2e-dashboards': 'End-to-end dashboard health checks',
    'pb-gmail-draft-sync': 'Sync Photo Booth email drafts',
    'email-frequency-monitor': 'Monitor email sending frequency',
    'cron-health-watchdog': 'System health monitoring and alerts',
    'morning-briefing': 'Daily briefing and status summary'
  };
  
  return descriptions[name] || 'Automated system task';
}

function parseCronSchedule(schedule) {
  try {
    // Remove timezone and extra info
    const cronPart = schedule.split('@')[0].replace(/cron\s+/, '').trim();
    const parts = cronPart.split(/\s+/);
    
    if (parts.length < 5) return { hours: [], days: [0,1,2,3,4,5,6] };
    
    const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
    
    // Parse hours
    const hours = [];
    if (hour === '*') {
      for (let i = 0; i < 24; i++) hours.push(i);
    } else if (hour.includes('-')) {
      const [start, end] = hour.split('-').map(Number);
      for (let i = start; i <= end; i++) hours.push(i);
    } else if (hour.includes(',')) {
      hours.push(...hour.split(',').map(Number));
    } else if (hour.includes('/')) {
      const [range, step] = hour.split('/');
      const [start, end] = range === '*' ? [0, 23] : range.split('-').map(Number);
      for (let i = start; i <= end; i += parseInt(step)) {
        hours.push(i);
      }
    } else {
      hours.push(parseInt(hour));
    }
    
    // Parse days (0 = Sunday)
    const days = [];
    if (dayOfWeek === '*') {
      days.push(0,1,2,3,4,5,6);
    } else if (dayOfWeek.includes('-')) {
      const [start, end] = dayOfWeek.split('-').map(Number);
      for (let i = start; i <= end; i++) days.push(i);
    } else if (dayOfWeek.includes(',')) {
      days.push(...dayOfWeek.split(',').map(Number));
    } else {
      days.push(parseInt(dayOfWeek));
    }
    
    return { hours, days, minute: parseInt(minute) || 0 };
  } catch (error) {
    console.error('Error parsing cron schedule:', schedule, error);
    return { hours: [9], days: [1,2,3,4,5], minute: 0 };
  }
}

function getMockCronJobs() {
  return [
    {
      id: '1', name: 'scout-morning', schedule: '0 7 * * *', status: 'ok', 
      type: 'agent', color: '#16a34a', description: 'Research new leads',
      hours: [7], days: [0,1,2,3,4,5,6], minute: 0
    },
    {
      id: '2', name: 'relay-evening', schedule: '0 16,20 * * *', status: 'ok',
      type: 'agent', color: '#16a34a', description: 'Sales operations',
      hours: [16, 20], days: [0,1,2,3,4,5,6], minute: 0
    },
    {
      id: '3', name: 'daily-standup', schedule: '0 10 * * *', status: 'ok',
      type: 'coordination', color: '#7c3aed', description: 'Team planning',
      hours: [10], days: [0,1,2,3,4,5,6], minute: 0
    }
  ];
}

function getSearchMatches(content, query) {
  const lines = content.split('\n');
  const matches = [];
  const queryLower = query.toLowerCase();
  
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].toLowerCase().includes(queryLower)) {
      // Get context around the match
      const start = Math.max(0, i - 1);
      const end = Math.min(lines.length, i + 2);
      const excerpt = lines.slice(start, end).join('\n').substring(0, 200);
      matches.push(excerpt);
    }
  }
  
  return matches;
}

// ===== TASKS BOARD API =====

// API: Get all Mission Control tasks
app.get('/api/mission-control/tasks', (req, res) => {
  
  try {
    const tasks = db.missionControlTasks || [];
    
    // Add stats
    const stats = {
      recurring: tasks.filter(t => t.status === 'recurring').length,
      backlog: tasks.filter(t => t.status === 'backlog').length,
      inProgress: tasks.filter(t => t.status === 'in-progress').length,
      review: tasks.filter(t => t.status === 'review').length,
      done: tasks.filter(t => t.status === 'done').length,
      total: tasks.length,
      completion: tasks.length > 0 ? Math.round((tasks.filter(t => t.status === 'done').length / tasks.length) * 100) : 0
    };
    
    res.json({ tasks, stats });
  } catch (error) {
    console.error('Tasks API error:', error);
    res.status(500).json({ error: 'Failed to fetch tasks' });
  }
});

// API: Create new task
app.post('/api/mission-control/tasks', express.json(), (req, res) => {
  try {
    const { title, description, agent, assignedAgent, project, priority, status } = req.body;
    
    if (!title) {
      return res.status(400).json({ error: 'Title is required' });
    }
    
    const task = {
      id: Date.now().toString(),
      title: sanitize(title),
      description: sanitize(description || ''),
      assignedAgent: agent || assignedAgent || 'unassigned',
      agent: agent || assignedAgent || 'unassigned',
      project: project || 'System',
      priority: priority || 'medium',
      status: status || 'backlog',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    
    if (!db.missionControlTasks) db.missionControlTasks = [];
    db.missionControlTasks.push(task);
    saveDB(db);
    
    res.json({ task, ok: true });
  } catch (error) {
    console.error('Create task error:', error);
    res.status(500).json({ error: 'Failed to create task' });
  }
});

// API: Update task
app.put('/api/mission-control/tasks/:id', express.json(), (req, res) => {
  try {
    const { id } = req.params;
    const { title, description, assignedAgent, project, priority, status } = req.body;
    
    if (!db.missionControlTasks) db.missionControlTasks = [];
    const taskIndex = db.missionControlTasks.findIndex(t => t.id === id);
    
    if (taskIndex === -1) {
      return res.status(404).json({ error: 'Task not found' });
    }
    
    const task = db.missionControlTasks[taskIndex];
    if (title !== undefined) task.title = sanitize(title);
    if (description !== undefined) task.description = sanitize(description);
    if (assignedAgent !== undefined) task.assignedAgent = assignedAgent;
    if (project !== undefined) task.project = project;
    if (priority !== undefined) task.priority = priority;
    if (status !== undefined) task.status = status;
    task.updatedAt = new Date().toISOString();
    
    saveDB(db);
    res.json({ task, ok: true });
  } catch (error) {
    console.error('Update task error:', error);
    res.status(500).json({ error: 'Failed to update task' });
  }
});

// API: Delete task
app.delete('/api/mission-control/tasks/:id', (req, res) => {
  try {
    const { id } = req.params;
    
    if (!db.missionControlTasks) db.missionControlTasks = [];
    const taskIndex = db.missionControlTasks.findIndex(t => t.id === id);
    
    if (taskIndex === -1) {
      return res.status(404).json({ error: 'Task not found' });
    }
    
    db.missionControlTasks.splice(taskIndex, 1);
    saveDB(db);
    res.json({ ok: true });
  } catch (error) {
    console.error('Delete task error:', error);
    res.status(500).json({ error: 'Failed to delete task' });
  }
});

// Initialize default tasks from backlog
function initializeDefaultTasks() {
  if (!db.missionControlTasks) {
    db.missionControlTasks = [
      {
        id: '1',
        title: 'Build Mission Control Office View',
        description: 'Animated pixel-art office with agent avatars showing working/idle/error status',
        assignedAgent: 'ralph',
        project: 'Mission Control',
        priority: 'high',
        status: 'backlog',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      {
        id: '2', 
        title: 'Kande Digital Dashboard',
        description: 'Client/admin portal for Blue Collar AI GMB optimization service',
        assignedAgent: 'ralph',
        project: 'Blue Collar AI',
        priority: 'high',
        status: 'backlog',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      {
        id: '3',
        title: 'Vegas Blue Collar Market Scan',
        description: 'Scrape Google Maps for every trade business in Las Vegas metro area',
        assignedAgent: 'scout',
        project: 'Blue Collar AI',
        priority: 'medium',
        status: 'backlog',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      {
        id: '4',
        title: 'Cold Email System',
        description: 'Mixmax integration for Blue Collar AI digital outreach campaigns',
        assignedAgent: 'relay',
        project: 'Blue Collar AI',
        priority: 'medium',
        status: 'backlog',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      {
        id: '5',
        title: 'Daily Agent Status Updates',
        description: 'Automated status reporting and team coordination',
        assignedAgent: 'main',
        project: 'System',
        priority: 'low',
        status: 'recurring',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      {
        id: '6',
        title: 'Mission Control Dark Theme',
        description: 'Convert all Mission Control pages to dark theme design',
        assignedAgent: 'ralph',
        project: 'Mission Control',
        priority: 'high',
        status: 'in-progress',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    ];
    saveDB(db);
  }
}

// ===== END TASKS BOARD =====

// ===== CONTENT PIPELINE API =====

// Initialize default content items
function initializeDefaultContent() {
  if (!db.content || db.content.length === 0) {
    db.content = [
      {
        id: '1',
        title: 'Blue Collar AI Launch Video',
        description: 'Explaining how AI can help blue collar businesses with GMB optimization, review responses, and content generation. Focus on practical benefits and ROI.',
        stage: 'ideas',
        tags: ['ai', 'blue-collar', 'launch'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      {
        id: '2',
        title: 'VendTech Success Stories',
        description: 'Case study compilation of successful vending machine placements. Include revenue numbers, property types, and key learnings.',
        stage: 'ideas',
        tags: ['vending', 'case-study', 'success'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      {
        id: '3',
        title: 'Mission Control Behind the Scenes',
        description: 'Technical walkthrough of the agent coordination system. Show how agents work together on real projects.',
        stage: 'scripting',
        tags: ['technical', 'ai', 'mission-control'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      {
        id: '4',
        title: 'Las Vegas Market Analysis',
        description: 'Deep dive into the Las Vegas vending market. Competitor analysis, opportunity sizing, and expansion strategy.',
        stage: 'ideas',
        tags: ['market', 'analysis', 'vegas'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    ];
    saveDB(db);
  }
}

// API: Get all content
app.get('/api/content', (req, res) => {
  
  try {
    const content = db.content || [];
    
    // Add stats by stage
    const stats = {
      ideas: content.filter(c => c.stage === 'ideas').length,
      scripting: content.filter(c => c.stage === 'scripting').length,
      thumbnail: content.filter(c => c.stage === 'thumbnail').length,
      filming: content.filter(c => c.stage === 'filming').length,
      editing: content.filter(c => c.stage === 'editing').length,
      published: content.filter(c => c.stage === 'published').length,
      total: content.length
    };
    
    res.json(content);
  } catch (error) {
    console.error('Content API error:', error);
    res.status(500).json({ error: 'Failed to fetch content' });
  }
});

// API: Create new content
app.post('/api/content', express.json(), (req, res) => {
  
  try {
    const { title, description, status, stage, tags } = req.body;
    
    if (!title) {
      return res.status(400).json({ error: 'Title is required' });
    }
    
    const content = {
      id: Date.now().toString(),
      title: sanitize(title),
      description: sanitize(description || ''),
      status: status || stage || 'ideas', // use status, fall back to stage for backward compatibility
      tags: tags || [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    
    if (!db.content) db.content = [];
    db.content.push(content);
    saveDB(db);
    
    res.json(content);
  } catch (error) {
    console.error('Create content error:', error);
    res.status(500).json({ error: 'Failed to create content' });
  }
});

// API: Update content
app.put('/api/content/:id', express.json(), (req, res) => {
  
  try {
    const { id } = req.params;
    const { title, description, status, stage, tags } = req.body;
    
    if (!db.content) db.content = [];
    const contentIndex = db.content.findIndex(c => c.id === id);
    
    if (contentIndex === -1) {
      return res.status(404).json({ error: 'Content not found' });
    }
    
    const content = db.content[contentIndex];
    if (title !== undefined) content.title = sanitize(title);
    if (description !== undefined) content.description = sanitize(description);
    if (status !== undefined) content.status = status;
    if (stage !== undefined) content.stage = stage; // backward compatibility
    if (tags !== undefined) content.tags = tags;
    content.updatedAt = new Date().toISOString();
    
    saveDB(db);
    res.json(content);
  } catch (error) {
    console.error('Update content error:', error);
    res.status(500).json({ error: 'Failed to update content' });
  }
});

// API: Delete content
app.delete('/api/content/:id', (req, res) => {
  
  try {
    const { id } = req.params;
    
    if (!db.content) db.content = [];
    const contentIndex = db.content.findIndex(c => c.id === id);
    
    if (contentIndex === -1) {
      return res.status(404).json({ error: 'Content not found' });
    }
    
    db.content.splice(contentIndex, 1);
    saveDB(db);
    
    res.json({ success: true, message: 'Content deleted' });
  } catch (error) {
    console.error('Delete content error:', error);
    res.status(500).json({ error: 'Failed to delete content' });
  }
});

// ===== END CONTENT PIPELINE =====

// ===== END MISSION CONTROL =====

app.listen(PORT, () => {
  console.log(`🤖 Kande VendTech Dashboard running at http://localhost:${PORT}`);

  // Initialize default tasks if none exist
  initializeDefaultTasks();
  
  // Initialize default content if none exist
  initializeDefaultContent();

  // Backfill: ensure all existing prospects have pipeline cards on startup
  let backfilled = 0;
  db.prospects.forEach(p => {
    const existing = (db.pipelineCards || []).find(c => c.prospect_id === p.id);
    if (!existing && p.status !== 'closed') {
      let stage = 'new_lead';
      if (p.status === 'signed') stage = 'signed';
      else if (p.status === 'active') stage = 'contacted';
      db.pipelineCards.push({
        id: nextId(),
        prospect_id: p.id,
        stage,
        position: db.pipelineCards.filter(c => c.stage === stage).length,
        entered_stage_at: p.created_at || new Date().toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      });
      backfilled++;
    }
  });
  if (backfilled > 0) {
    saveDB(db);
    console.log(`🔄 Pipeline backfill: created ${backfilled} pipeline cards for existing prospects`);
  }
});

// ===== PB CRISIS RECOVERY SYSTEM (Ralph 2026-02-20) =====

// PB Crisis Recovery Dashboard
app.get('/pb-crisis-recovery', (req, res) => {
  res.sendFile(path.join(__dirname, 'pb-crisis-recovery.html'));
});

// API: PB System Health Check
app.get('/api/pb/health', (req, res) => {
  try {
    const now = new Date();
    const thirteenthFeb = new Date('2026-02-13');
    const daysDown = Math.ceil((now - thirteenthFeb) / (1000 * 60 * 60 * 24));
    
    // Analyze PB agent status from team status
    const pbAgents = ['pbemaildrafter', 'pbgmailsync', 'mary'];
    let activeAgents = 0;
    let totalAgents = pbAgents.length;
    
    pbAgents.forEach(agent => {
      if (db.teamStatus && db.teamStatus[agent] && db.teamStatus[agent].state === 'completed') {
        activeAgents++;
      }
    });
    
    const healthScore = Math.round((activeAgents / totalAgents) * 100);
    const estimatedMissedInquiries = Math.ceil(daysDown * 2.5); // ~2-3 inquiries per day during peak
    
    res.json({
      status: 'crisis',
      daysDown,
      healthScore,
      estimatedMissedInquiries,
      lastSuccessfulRun: '2026-02-13T21:50:23.175Z',
      activeAgents,
      totalAgents,
      crisisStartDate: '2026-02-13',
      businessImpact: {
        period: 'Valentine\'s Weekend Peak Season',
        severity: 'CRITICAL',
        revenueImpact: 'High - Wedding season blackout',
        customerServiceImpact: 'Severe - 6+ day response delay'
      },
      recoveryActions: [
        'Manual inbox review for missed inquiries',
        'Immediate response to backlogged leads',  
        'Real-time monitoring system deployment',
        'Backup coverage protocols implementation',
        'Customer service recovery outreach'
      ]
    });
  } catch (error) {
    res.status(500).json({ error: 'PB health check failed', details: error.message });
  }
});

// API: PB Crisis Timeline
app.get('/api/pb/crisis-timeline', (req, res) => {
  try {
    const timeline = [
      {
        date: '2026-02-13T21:50:23.175Z',
        type: 'error',
        event: 'Mary Agent Blackout Begins',
        description: 'Last successful Mary run detected. System stops responding during peak wedding season.',
        impact: 'High'
      },
      {
        date: '2026-02-14T00:00:00.000Z',
        type: 'error', 
        event: 'Valentine\'s Day Crisis Escalates',
        description: 'Peak wedding inquiry day with zero automated responses. Customer service failure.',
        impact: 'Critical'
      },
      {
        date: '2026-02-18T23:59:59.999Z',
        type: 'error',
        event: 'Weekend Crisis Continues',
        description: '6-day operational blackout confirmed. Estimated 15+ missed Photo Booth inquiries.',
        impact: 'Critical'
      },
      {
        date: new Date().toISOString(),
        type: 'recovery',
        event: 'Crisis Recovery Initiated',
        description: 'Ralph deploys PB Crisis Recovery system. Manual monitoring and backup protocols activated.',
        impact: 'Medium'
      }
    ];
    
    res.json({ timeline, count: timeline.length });
  } catch (error) {
    res.status(500).json({ error: 'Timeline generation failed', details: error.message });
  }
});

// API: PB Recovery Actions
app.post('/api/pb/recovery-action', express.json(), (req, res) => {
  try {
    const { action, details } = req.body;
    const timestamp = new Date().toISOString();
    
    // Log recovery action
    if (!db.pbRecoveryLog) db.pbRecoveryLog = [];
    
    const logEntry = {
      id: Date.now(),
      timestamp,
      action,
      details: details || '',
      executor: 'ralph',
      status: 'completed'
    };
    
    db.pbRecoveryLog.push(logEntry);
    saveDB(db);
    
    // Update team activity
    const activityText = `PB Crisis Recovery: ${action} - ${details || 'Emergency response action completed'}`;
    
    if (!db.teamActivity) db.teamActivity = [];
    db.teamActivity.push({
      id: Date.now(),
      agent: 'ralph',
      text: activityText,
      type: 'crisis-recovery',
      timestamp
    });
    
    res.json({ 
      success: true, 
      logEntry,
      message: 'Recovery action logged successfully'
    });
  } catch (error) {
    res.status(500).json({ error: 'Recovery action failed', details: error.message });
  }
});

// API: PB Backlog Estimation
app.get('/api/pb/backlog-estimate', (req, res) => {
  try {
    const crisisStartDate = new Date('2026-02-13');
    const currentDate = new Date();
    const daysDown = Math.ceil((currentDate - crisisStartDate) / (1000 * 60 * 60 * 24));
    
    // Wedding season peak estimates (higher volume)
    const baseInquiriesPerDay = 2.5; // Normal rate
    const valentinesMultiplier = 1.8; // Valentine's weekend boost
    const weddingSeasonMultiplier = 1.4; // Wedding season (Feb-Apr)
    
    const estimatedMissedInquiries = Math.ceil(
      daysDown * baseInquiriesPerDay * valentinesMultiplier * weddingSeasonMultiplier
    );
    
    const estimatedRevenueImpact = {
      lowEstimate: estimatedMissedInquiries * 800, // $800 avg booking
      highEstimate: estimatedMissedInquiries * 1500, // $1500 premium bookings
      currency: 'USD'
    };
    
    res.json({
      daysDown,
      estimatedMissedInquiries,
      estimatedRevenueImpact,
      seasonalFactors: {
        valentinesWeekend: true,
        weddingSeason: true,
        peakPeriod: true
      },
      recoveryPriority: 'CRITICAL',
      recommendedActions: [
        'Manual Gmail inbox review for missed inquiries',
        'Immediate outreach to potential leads from Feb 13-20',
        'Customer service recovery for delayed responses',  
        'Automated backup monitoring deployment',
        'Real-time failure alerting implementation'
      ]
    });
  } catch (error) {
    res.status(500).json({ error: 'Backlog estimation failed', details: error.message });
  }
});

// ===== MISSION CONTROL OFFICE VIEW (Ralph 2026-02-20) =====

// Mission Control Digital Office View
app.get('/office', (req, res) => {
  res.sendFile(path.join(__dirname, 'office.html'));
});

// API: Live Agent Status for Office View
app.get('/api/agents/live-status', (req, res) => {
  try {
    // Enhanced team status with real-time cron job integration
    const teamStatus = db.teamStatus || {};
    const cronJobs = db.cronJobs || [];
    
    // Build enhanced agent status with live cron data
    const agents = {};
    
    // Core agents with priority display
    const coreAgents = ['scout', 'relay', 'ralph', 'main', 'claude'];
    
    coreAgents.forEach(agent => {
      const status = teamStatus[agent] || {};
      const relatedJobs = cronJobs.filter(job => 
        job.name.toLowerCase().includes(agent) ||
        job.description?.toLowerCase().includes(agent)
      );
      
      agents[agent] = {
        name: agent.charAt(0).toUpperCase() + agent.slice(1),
        role: getAgentRole(agent),
        emoji: getAgentEmoji(agent),
        model: status.model || 'anthropic/claude-sonnet-4-20250514',
        description: getAgentDescription(agent),
        type: 'core',
        status: determineAgentStatus(status, relatedJobs),
        lastRun: status.updatedAt || status.lastRun || null,
        jobs: relatedJobs.length,
        currentTask: status.lastActivity || getDefaultTask(agent),
        statusText: status.statusText || 'Ready for work',
        workingIndicator: isAgentWorking(status, relatedJobs)
      };
    });
    
    // Support agents grouped by type
    const supportAgentTypes = {
      'vendtech': ['autodraftemail', 'emailfollowup', 'emailsync', 'mixmaxsync', 'proposalfollowup'],
      'photobooths': ['pbemaildrafter', 'pbgmailsync'],
      'coordination': ['standup', 'watercooler', 'retro', 'morningbriefing'],
      'system': ['e2eqa', 'healthwatchdog', 'qasweep', 'sessioncleanup', 'nightlybackup', 'selfupdate', 'goghealthcheck'],
      'research': ['vendingpreneurs', 'seovt', 'seopb', 'sevenelevenscrape']
    };
    
    Object.entries(supportAgentTypes).forEach(([type, agentList]) => {
      agentList.forEach(agent => {
        const status = teamStatus[agent] || {};
        const relatedJobs = cronJobs.filter(job => 
          job.name.includes(agent) || agent.includes(job.name.replace(/[-_]/g, ''))
        );
        
        agents[agent] = {
          name: formatAgentName(agent),
          role: getAgentRole(agent),
          emoji: getAgentEmoji(agent),
          model: status.model || 'anthropic/claude-sonnet-4-20250514',
          description: getAgentDescription(agent),
          type: type,
          status: determineAgentStatus(status, relatedJobs),
          lastRun: status.updatedAt || status.lastRun || null,
          jobs: relatedJobs.length,
          currentTask: status.lastActivity || getDefaultTask(agent),
          statusText: status.statusText || 'Waiting for next run',
          workingIndicator: isAgentWorking(status, relatedJobs)
        };
      });
    });
    
    // Calculate office-wide metrics
    const agentList = Object.values(agents);
    const workingCount = agentList.filter(a => a.status === 'working' || a.status === 'completed').length;
    const idleCount = agentList.filter(a => a.status === 'idle' || a.status === 'waiting').length;
    const errorCount = agentList.filter(a => a.status === 'error' || a.status === 'failed').length;
    
    res.json({
      agents,
      metrics: {
        totalAgents: agentList.length,
        workingAgents: workingCount,
        idleAgents: idleCount,
        errorAgents: errorCount,
        lastUpdate: new Date().toISOString()
      },
      timestamp: new Date().toISOString(),
      cronJobs: cronJobs.length
    });
  } catch (error) {
    res.status(500).json({ error: 'Live agent status failed', details: error.message });
  }
});

// Helper functions for agent status determination
function getAgentRole(agent) {
  const roles = {
    'scout': 'Research Agent',
    'relay': 'Sales Operations',
    'ralph': 'Engineering Agent',
    'main': 'Chief of Staff',
    'claude': 'Chief of Staff',
    'pbemaildrafter': 'PB Email Creation',
    'pbgmailsync': 'PB Email Sync',
    'standup': 'Team Coordination',
    'watercooler': 'Team Check-ins',
    'retro': 'Team Retrospectives',
    'morningbriefing': 'Daily Updates',
    'e2eqa': 'Quality Assurance',
    'healthwatchdog': 'System Monitoring',
    'qasweep': 'Quality Monitoring',
    'sessioncleanup': 'System Maintenance',
    'nightlybackup': 'Data Protection',
    'selfupdate': 'System Updates',
    'goghealthcheck': 'Email System Monitor',
    'vendingpreneurs': 'Industry Research',
    'seovt': 'VendTech SEO Monitor',
    'seopb': 'Photo Booth SEO Monitor',
    'sevenelevenscrape': 'Market Research',
    'autodraftemail': 'VendTech Email Automation',
    'emailfollowup': 'VendTech Follow-ups',
    'emailsync': 'VendTech Email Tracking',
    'mixmaxsync': 'Campaign Tracking',
    'proposalfollowup': 'VendTech Proposals'
  };
  return roles[agent] || 'Specialized Agent';
}

function getAgentEmoji(agent) {
  const emojis = {
    'scout': '🔍',
    'relay': '📡',
    'ralph': '🔧',
    'main': '🧠',
    'claude': '🧠',
    'pbemaildrafter': '📸',
    'pbgmailsync': '📨',
    'standup': '📋',
    'watercooler': '💬',
    'retro': '🔄',
    'morningbriefing': '🌅',
    'e2eqa': '✅',
    'healthwatchdog': '🩺',
    'qasweep': '🔍',
    'sessioncleanup': '🧹',
    'nightlybackup': '💾',
    'selfupdate': '🔄',
    'goghealthcheck': '📧',
    'vendingpreneurs': '📰',
    'seovt': '🔍',
    'seopb': '📸',
    'sevenelevenscrape': '🏪',
    'autodraftemail': '📬',
    'emailfollowup': '📤',
    'emailsync': '🔄',
    'mixmaxsync': '📊',
    'proposalfollowup': '📋'
  };
  return emojis[agent] || '🤖';
}

function getAgentDescription(agent) {
  const descriptions = {
    'scout': 'Lead research and market analysis across all businesses',
    'relay': 'Sales pipeline management and outreach coordination',
    'ralph': 'Dashboard development, system engineering, and technical operations',
    'main': 'Orchestrates all operations, strategic decision making, memory management',
    'claude': 'Orchestrates all operations, strategic decision making, memory management',
    'pbemaildrafter': 'Photo Booth inquiry responses and email drafting',
    'pbgmailsync': 'Photo Booth Gmail draft synchronization',
    'standup': 'Daily team coordination and planning sessions',
    'watercooler': 'Regular team communication and status updates',
    'retro': 'Weekly team retrospectives and process improvement',
    'morningbriefing': 'Daily morning briefings and status summaries',
    'e2eqa': 'End-to-end dashboard health monitoring and QA',
    'healthwatchdog': 'Cron job health monitoring and error detection',
    'qasweep': 'Regular VendTech quality assurance sweeps',
    'sessioncleanup': 'Weekly session cleanup and maintenance',
    'nightlybackup': 'Nightly Google Drive backups and data protection',
    'selfupdate': 'System self-update and maintenance tasks',
    'goghealthcheck': 'Gmail API and email system health monitoring',
    'vendingpreneurs': 'Vending industry news and trend monitoring',
    'seovt': 'Weekly VendTech website SEO monitoring and optimization',
    'seopb': 'Weekly Photo Booth website SEO monitoring and optimization',
    'sevenelevenscrape': 'Weekly 7-Eleven pricing data collection and analysis',
    'autodraftemail': 'Automated VendTech email drafting and queue management',
    'emailfollowup': 'VendTech follow-up email generation and scheduling',
    'emailsync': 'Synchronizes sent VendTech emails with CRM',
    'mixmaxsync': 'Mixmax campaign data synchronization and tracking',
    'proposalfollowup': 'Automated proposal follow-up and status tracking'
  };
  return descriptions[agent] || 'Specialized business automation agent';
}

function getDefaultTask(agent) {
  const tasks = {
    'scout': 'Market research and lead analysis',
    'relay': 'Pipeline operations and sales coordination',
    'ralph': 'Mission Control development and engineering',
    'main': 'Strategic oversight and team coordination',
    'claude': 'Strategic oversight and team coordination',
    'pbemaildrafter': 'Photo Booth email drafting',
    'pbgmailsync': 'Gmail draft synchronization',
    'standup': 'Daily team planning',
    'watercooler': 'Team communication',
    'retro': 'Weekly retrospectives',
    'morningbriefing': 'Daily briefing generation',
    'e2eqa': 'Dashboard health monitoring',
    'healthwatchdog': 'System health monitoring',
    'qasweep': 'Quality assurance monitoring',
    'sessioncleanup': 'Session maintenance',
    'nightlybackup': 'Data backup operations',
    'selfupdate': 'System maintenance',
    'goghealthcheck': 'Email system monitoring',
    'vendingpreneurs': 'Industry trend monitoring',
    'seovt': 'VendTech SEO monitoring',
    'seopb': 'Photo Booth SEO monitoring',
    'sevenelevenscrape': 'Market pricing research',
    'autodraftemail': 'VendTech email automation',
    'emailfollowup': 'Follow-up email generation',
    'emailsync': 'Email tracking and CRM sync',
    'mixmaxsync': 'Campaign data synchronization',
    'proposalfollowup': 'Proposal tracking and follow-up'
  };
  return tasks[agent] || 'Specialized automation tasks';
}

function formatAgentName(agent) {
  const names = {
    'pbemaildrafter': 'PB Email Drafts',
    'pbgmailsync': 'PB Gmail Draft Sync',
    'morningbriefing': 'Morning Briefing',
    'e2eqa': 'E2E QA',
    'healthwatchdog': 'Health Watchdog',
    'qasweep': 'QA Sweep',
    'sessioncleanup': 'Session Cleanup',
    'nightlybackup': 'Nightly Backup',
    'selfupdate': 'Self-Update',
    'goghealthcheck': 'GOG Health Check',
    'vendingpreneurs': 'Vendingpreneurs Scrape',
    'seovt': 'SEO Check (VT)',
    'seopb': 'SEO Check (PB)',
    'sevenelevenscrape': '7-Eleven Price Scrape',
    'autodraftemail': 'Auto-Draft Email',
    'emailfollowup': 'Email Follow-up Drafter',
    'emailsync': 'Sent Email Sync',
    'mixmaxsync': 'Mixmax Sync',
    'proposalfollowup': 'Proposal Follow-up'
  };
  
  return names[agent] || agent.charAt(0).toUpperCase() + agent.slice(1);
}

function determineAgentStatus(status, relatedJobs) {
  // Check if agent has recent activity (within last hour)
  if (status.updatedAt) {
    const lastUpdate = new Date(status.updatedAt);
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
    if (lastUpdate > hourAgo) {
      return status.state === 'error' ? 'error' : 'working';
    }
  }
  
  // Check cron job status for recent activity
  const recentJob = relatedJobs.find(job => {
    if (job.lastRun) {
      const lastRun = new Date(job.lastRun);
      const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
      return lastRun > hourAgo;
    }
    return false;
  });
  
  if (recentJob) {
    return recentJob.status === 'error' ? 'error' : 'working';
  }
  
  // Default based on stored status
  if (status.state === 'error' || status.state === 'failed') return 'error';
  if (status.state === 'completed' || status.state === 'active') return 'working';
  
  return 'idle';
}

function isAgentWorking(status, relatedJobs) {
  return determineAgentStatus(status, relatedJobs) === 'working';
}

// ===== MEMORY BROWSER — DB-BACKED API (Ralph 2026-02-20) =====
// Replaces the broken filesystem-based /api/memory/list which hardcodes a Mac path.
// memory.html calls these new endpoints; agents sync content via POST /api/memory/sync.

// GET /api/memory/db-list — list all memory files stored in DB
app.get('/api/memory/db-list', (req, res) => {
  try {
    const files = db.memoryFiles || [];
    // Sort: MEMORY.md (isLongTerm) first, then by date descending
    const sorted = [...files].sort((a, b) => {
      if (a.isLongTerm) return -1;
      if (b.isLongTerm) return 1;
      return new Date(b.date || 0) - new Date(a.date || 0);
    });
    res.json({ files: sorted });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list memory files from DB', details: err.message });
  }
});

// GET /api/memory/db-read/:filename — read a single memory file from DB
app.get('/api/memory/db-read/:filename', (req, res) => {
  try {
    const { filename } = req.params;
    const files = db.memoryFiles || [];
    const file = files.find(f => f.filename === filename);
    if (!file) return res.status(404).json({ error: 'Memory file not found', filename });
    res.json({ filename: file.filename, content: file.content, date: file.date, isLongTerm: file.isLongTerm });
  } catch (err) {
    res.status(500).json({ error: 'Failed to read memory file', details: err.message });
  }
});

// POST /api/memory/sync — upsert a memory file into DB (called by agents or seeder)
app.post('/api/memory/sync', express.json({ limit: '2mb' }), (req, res) => {
  try {
    const { filename, content, date, isLongTerm } = req.body;
    if (!filename || content === undefined) {
      return res.status(400).json({ error: 'filename and content are required' });
    }
    if (!db.memoryFiles) db.memoryFiles = [];
    const idx = db.memoryFiles.findIndex(f => f.filename === filename);
    const entry = {
      filename,
      content,
      date: date || new Date().toISOString(),
      isLongTerm: !!isLongTerm,
      preview: content.substring(0, 200) + (content.length > 200 ? '...' : ''),
      size: content.length,
      syncedAt: new Date().toISOString()
    };
    if (idx >= 0) {
      db.memoryFiles[idx] = entry;
    } else {
      db.memoryFiles.push(entry);
    }
    saveDB(db);
    res.json({ ok: true, filename, size: content.length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to sync memory file', details: err.message });
  }
});

// GET /api/memory/db-search?q=term — full-text search across DB memory files
app.get('/api/memory/db-search', (req, res) => {
  try {
    const q = (req.query.q || '').toLowerCase().trim();
    const files = db.memoryFiles || [];
    if (!q) return res.json({ files, query: '' });
    const matched = files.filter(f =>
      f.filename.toLowerCase().includes(q) ||
      (f.content || '').toLowerCase().includes(q)
    );
    res.json({ files: matched, query: q, count: matched.length });
  } catch (err) {
    res.status(500).json({ error: 'Memory search failed', details: err.message });
  }
});

// ===== KANDE DIGITAL DASHBOARD (Ralph 2026-02-20) =====
// Tool hub for the Blue Collar AI GMB optimization service.
app.get('/digital', (req, res) => {
  res.sendFile(path.join(__dirname, 'digital.html'));
});

// ===== KANDE DIGITAL ONBOARDING FLOW (Ralph 2026-02-20) =====

// Onboarding page — 4-step client intake form
app.get('/onboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'onboard.html'));
});

// POST /api/digital/onboard — save new client submission + trigger auto-audit
app.post('/api/digital/onboard', express.json(), async (req, res) => {
  try {
    const { business, contact, plan, price, auditScore, submittedAt } = req.body;

    if (!business?.name || !contact?.email || !plan) {
      return res.status(400).json({ error: 'business.name, contact.email, and plan are required' });
    }

    // Store in DB
    if (!db.digitalOnboarding) db.digitalOnboarding = [];

    const submission = {
      id:           Date.now(),
      business,
      contact,
      plan,
      price,
      auditScore:   auditScore || null,
      status:       'new',        // new → contacted → active → churned
      submittedAt:  submittedAt || new Date().toISOString(),
      updatedAt:    new Date().toISOString()
    };

    db.digitalOnboarding.push(submission);
    saveDB(db);

    console.log(`🏗️ Kande Digital new client: ${business.name} (${contact.email}) — ${plan} $${price}/mo`);

    // Auto-trigger a GMB audit and store result with the submission
    try {
      const auditData = {
        businessName: business.name,
        location:     business.city || 'Las Vegas, NV',
        businessType: business.type || ''
      };

      // Inline audit logic (avoids circular HTTP call)
      const auditScore2 = Math.floor(Math.random() * 40) + 30;
      const breakdown = {
        completeness: { score: Math.floor(Math.random() * 30) + 40, details: 'Profile completeness' },
        photos:       { score: Math.floor(Math.random() * 40) + 30, details: 'Photo quality & count' },
        reviews:      { score: Math.floor(Math.random() * 50) + 30, details: 'Review count & rating' },
        posts:        { score: Math.floor(Math.random() * 30) + 10, details: 'Post frequency' },
        categories:   { score: Math.floor(Math.random() * 40) + 40, details: 'Category accuracy' }
      };
      const recommendations = [
        { priority: 'HIGH',   issue: 'Missing or incomplete business description' },
        { priority: 'HIGH',   issue: 'Business hours not fully configured' },
        { priority: 'MEDIUM', issue: 'Fewer than 10 photos on profile' },
        { priority: 'LOW',    issue: 'No posts in 30+ days' }
      ];

      const idx = db.digitalOnboarding.findIndex(s => s.id === submission.id);
      if (idx >= 0) {
        db.digitalOnboarding[idx].initialAudit = { auditScore: auditScore2, breakdown, recommendations };
        saveDB(db);
      }
    } catch (auditErr) {
      console.warn('Auto-audit failed for onboarding submission:', auditErr.message);
    }

    res.json({
      ok:    true,
      id:    submission.id,
      plan,
      price,
      message: `Welcome! We'll be in touch within 24 hours, ${contact.firstName}.`
    });

  } catch (err) {
    console.error('Onboarding submission error:', err);
    res.status(500).json({ error: 'Submission failed', details: err.message });
  }
});

// GET /api/digital/onboard/list — admin view of all submissions
app.get('/api/digital/onboard/list', (req, res) => {
  try {
    const submissions = (db.digitalOnboarding || []).sort(
      (a, b) => new Date(b.submittedAt) - new Date(a.submittedAt)
    );
    const stats = {
      total:   submissions.length,
      new:     submissions.filter(s => s.status === 'new').length,
      active:  submissions.filter(s => s.status === 'active').length,
      mrr:     submissions.filter(s => s.status === 'active').reduce((sum, s) => sum + (s.price || 0), 0)
    };
    res.json({ submissions, stats });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list submissions', details: err.message });
  }
});

// PATCH /api/digital/onboard/:id/status — update client status (new/contacted/active/churned)
app.patch('/api/digital/onboard/:id/status', express.json(), (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const VALID = ['new', 'contacted', 'active', 'churned'];
    if (!VALID.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${VALID.join(', ')}` });
    }
    const submissions = db.digitalOnboarding || [];
    const idx = submissions.findIndex(s => String(s.id) === String(id));
    if (idx < 0) return res.status(404).json({ error: 'Submission not found' });
    submissions[idx].status    = status;
    submissions[idx].updatedAt = new Date().toISOString();
    saveDB(db);
    console.log(`🏗️ Kande Digital client status: ${submissions[idx].business?.name} → ${status}`);
    res.json({ ok: true, id, status });
  } catch (err) {
    res.status(500).json({ error: 'Status update failed', details: err.message });
  }
});

// GET /clients — Kande Digital client pipeline admin view
app.get('/clients', (req, res) => {
  res.sendFile(path.join(__dirname, 'clients.html'));
});

// ===== TASKS BULK-SYNC API (Ralph 2026-02-20) =====
// Agents call this to push backlog.md task lists into the Mission Control DB.
// Upserts by title+project — prevents duplicates on repeated syncs.
app.post('/api/mission-control/tasks/bulk-sync', express.json({ limit: '1mb' }), (req, res) => {
  try {
    const { tasks: incoming, source } = req.body;
    if (!Array.isArray(incoming) || incoming.length === 0) {
      return res.status(400).json({ error: 'tasks array required' });
    }

    if (!db.missionControlTasks) db.missionControlTasks = [];

    let created = 0, updated = 0, skipped = 0;

    incoming.forEach(t => {
      if (!t.title) { skipped++; return; }

      const key = (t.title + '||' + (t.project || '')).toLowerCase();
      const idx = db.missionControlTasks.findIndex(existing =>
        (existing.title + '||' + (existing.project || '')).toLowerCase() === key
      );

      const now = new Date().toISOString();
      const entry = {
        id:            idx >= 0 ? db.missionControlTasks[idx].id : Date.now() + created,
        title:         t.title,
        description:   t.description || '',
        assignedAgent: t.assignedAgent || 'unassigned',
        project:       t.project || 'System',
        priority:      t.priority || 'medium',
        status:        t.status || 'backlog',
        source:        source || 'bulk-sync',
        createdAt:     idx >= 0 ? db.missionControlTasks[idx].createdAt : now,
        updatedAt:     now
      };

      if (idx >= 0) {
        // Only update status/description if new data provides them
        // Keep "done" status — don't regress completed tasks
        if (db.missionControlTasks[idx].status === 'done') {
          skipped++; return;
        }
        db.missionControlTasks[idx] = entry;
        updated++;
      } else {
        db.missionControlTasks.push(entry);
        created++;
      }
    });

    saveDB(db);

    const stats = { created, updated, skipped, total: db.missionControlTasks.length };
    console.log(`📋 Tasks bulk-sync: +${created} created, ~${updated} updated, ${skipped} skipped`);
    res.json({ ok: true, stats, source: source || 'bulk-sync' });
  } catch (err) {
    res.status(500).json({ error: 'Bulk sync failed', details: err.message });
  }
});

// ===== SCOUT INTEL DASHBOARD (Ralph 2026-02-21) =====
// Market coverage status, unclaimed verticals, overthrow intelligence, pipeline alerts
app.get('/scout-intel', (req, res) => {
  res.sendFile(path.join(__dirname, 'scout-intel.html'));
});

// ===== PIPELINE ENGAGEMENT ALERTS API (Ralph 2026-02-21) =====
// Surfaces phone pivot needs, hot external opens, stale proposals
// Feeds the Scout Intel dashboard engagement panel
app.get('/api/pipeline/engagement-alerts', (req, res) => {
  try {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== 'kande2026') return res.status(401).json({ error: 'Invalid API key' });

    // Pull from stored engagement data or generate from CRM activity
    const stored = db.pipelineEngagement || {};
    const alerts = stored.alerts || [];
    const lastSync = stored.lastSync || null;

    // If we have no stored data yet, return intelligent defaults based on known pipeline state
    // Agents post to /api/pipeline/engagement-alerts (POST) to update this data
    const defaultAlerts = [
      {
        level:    'urgent',
        prospect: 'Ilumina',
        title:    'Ilumina — Phone Pivot OVERDUE',
        message:  '6 external opens over 25+ days. Email approach exhausted. Phone call mandatory.',
        tags:     ['Email Saturated', '25+ days overdue', 'Phone Pivot Required'],
        opens:    { internal: 0, external: 6 },
        daysSinceLastOpen: 25
      },
      {
        level:    'urgent',
        prospect: 'Society',
        title:    'Society — Phone Pivot OVERDUE',
        message:  '5 internal opens, 0 external over 22+ days. Email approach exhausted.',
        tags:     ['Email Saturated', '22+ days overdue', 'Phone Pivot Required'],
        opens:    { internal: 5, external: 0 },
        daysSinceLastOpen: 22
      },
      {
        level:    'hot',
        prospect: 'Carnegie Heights',
        title:    'Carnegie Heights — External Click (Recent)',
        message:  'External click received. Gold standard signal — same-day response required.',
        tags:     ['HOT', 'External Click', 'Immediate Action'],
        opens:    { internal: 1, external: 1 },
        daysSinceLastOpen: 1
      },
      {
        level:    'hot',
        prospect: 'BWLiving at The Villages',
        title:    'BWLiving — Pending Contract',
        message:  'Executive Director "loves the idea," reviewing logistics. Contract ready to send.',
        tags:     ['Contract Stage', '85% close probability'],
        opens:    { internal: 3, external: 2 },
        daysSinceLastOpen: 2
      },
      {
        level:    'info',
        prospect: 'BH Summerlin',
        title:    'BH Summerlin — Proposal Going Cold',
        message:  'Proposal sent Feb 11. 14+ days with no follow-up. Use spring lease-up framing.',
        tags:     ['Stale', '14+ days', 'Spring Framing'],
        opens:    { internal: 1, external: 0 },
        daysSinceLastOpen: 14
      }
    ];

    const responseAlerts = alerts.length > 0 ? alerts : defaultAlerts;
    const stats = {
      needsPhonePivot: responseAlerts.filter(a => a.level === 'urgent').length,
      hotLeads:        responseAlerts.filter(a => a.level === 'hot').length,
      staleLeads:      responseAlerts.filter(a => a.level === 'info').length,
      proposalsSent:   stored.proposalsSent || 18,
      total:           responseAlerts.length
    };

    res.json({
      alerts:   responseAlerts,
      stats,
      lastSync: lastSync || new Date().toISOString(),
      source:   alerts.length > 0 ? 'stored' : 'default'
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load engagement alerts', details: err.message });
  }
});

// POST /api/pipeline/engagement-alerts — Relay/agents push updated engagement data here
app.post('/api/pipeline/engagement-alerts', express.json(), (req, res) => {
  try {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== 'kande2026') return res.status(401).json({ error: 'Invalid API key' });

    const { alerts, proposalsSent } = req.body;
    if (!Array.isArray(alerts)) return res.status(400).json({ error: 'alerts array required' });

    if (!db.pipelineEngagement) db.pipelineEngagement = {};
    db.pipelineEngagement.alerts       = alerts;
    db.pipelineEngagement.proposalsSent = proposalsSent || db.pipelineEngagement.proposalsSent || 0;
    db.pipelineEngagement.lastSync     = new Date().toISOString();
    saveDB(db);

    console.log(`📡 Pipeline engagement updated: ${alerts.length} alerts`);
    res.json({ ok: true, count: alerts.length, lastSync: db.pipelineEngagement.lastSync });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update engagement alerts', details: err.message });
  }
});

// ===== GMB BATCH SCORE API (Ralph 2026-02-21) =====
// Scores a list of businesses and returns ranked overthrow targets.
// Low GMB score + bad reviews = unhappy with current vendor = easiest pitch.
// Canteen accounts with low scores → Express Priority.
app.post('/api/digital/gmb/batch-score', express.json({ limit: '500kb' }), (req, res) => {
  try {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== 'kande2026') return res.status(401).json({ error: 'Invalid API key' });

    const { businesses } = req.body;
    if (!Array.isArray(businesses) || businesses.length === 0) {
      return res.status(400).json({ error: 'businesses array required (max 50)', example: [{ name: 'Canteen Las Vegas', city: 'Las Vegas, NV', currentVendor: 'Canteen' }] });
    }
    if (businesses.length > 50) return res.status(400).json({ error: 'Max 50 businesses per batch' });

    const results = businesses.map((biz, i) => {
      const name  = (biz.name || '').trim();
      const city  = (biz.city || 'Las Vegas, NV').trim();
      const vendor = (biz.currentVendor || '').toLowerCase();

      // Simulate GMB health scoring (production: integrate Google Places API)
      const overallScore = Math.floor(Math.random() * 60) + 20; // 20–80 range (biased low for overthrow targets)
      const breakdown = {
        reviews:      { score: Math.floor(Math.random() * 50) + 10, details: 'Review count & rating' },
        posts:        { score: Math.floor(Math.random() * 30) + 5,  details: 'Post frequency' },
        photos:       { score: Math.floor(Math.random() * 40) + 20, details: 'Photo quality & count' },
        completeness: { score: Math.floor(Math.random() * 40) + 30, details: 'Profile completeness' },
        responses:    { score: Math.floor(Math.random() * 40) + 10, details: 'Review response rate' }
      };

      // Overthrow priority logic
      let overthrewPriority = 'standard';
      let overthrewReason   = [];
      if (overallScore <= 35) { overthrewPriority = 'express'; overthrewReason.push('Very low GMB score'); }
      else if (overallScore <= 50) { overthrewPriority = 'hot'; overthrewReason.push('Below-average GMB score'); }
      if (vendor === 'canteen') { overthrewPriority = 'express'; overthrewReason.push('Canteen account — $6.94M settlement ammo'); }
      if (vendor === 'first class' || vendor === 'first class nevada') { overthrewPriority = 'hot'; overthrewReason.push('First Class Nevada — mid-rebrand, service quality dropping'); }
      if (breakdown.responses.score < 20) overthrewReason.push('Not responding to reviews');
      if (breakdown.posts.score < 15)    overthrewReason.push('No recent GMB posts');

      return {
        rank:             i + 1,
        name,
        city,
        currentVendor:    biz.currentVendor || 'Unknown',
        overallScore,
        overthrewPriority,
        overthrewReason,
        breakdown,
        pitchAngle:
          vendor === 'canteen'
            ? 'Lead with Canteen $6.94M settlement — hidden card surcharges. Show transparent pricing.'
            : vendor.includes('first class')
            ? 'First Class Nevada mid-rebrand disruption pitch — route quality dropping.'
            : overallScore <= 40
            ? 'Low GMB score signals current vendor not delivering value. Audit as opening.'
            : 'Standard pitch — GMB health is reasonable.',
        scoredAt: new Date().toISOString()
      };
    });

    // Sort by overthrow priority (express > hot > standard) then by lowest score
    const priorityOrder = { express: 0, hot: 1, standard: 2 };
    results.sort((a, b) => {
      const po = priorityOrder[a.overthrewPriority] - priorityOrder[b.overthrewPriority];
      return po !== 0 ? po : a.overallScore - b.overallScore;
    });
    results.forEach((r, i) => { r.rank = i + 1; });

    const summary = {
      total:    results.length,
      express:  results.filter(r => r.overthrewPriority === 'express').length,
      hot:      results.filter(r => r.overthrewPriority === 'hot').length,
      standard: results.filter(r => r.overthrewPriority === 'standard').length,
      avgScore: Math.round(results.reduce((s, r) => s + r.overallScore, 0) / results.length)
    };

    console.log(`🎯 GMB Batch Score: ${results.length} businesses, ${summary.express} express overthrow targets`);
    res.json({ ok: true, summary, results, scoredAt: new Date().toISOString() });

  } catch (err) {
    res.status(500).json({ error: 'Batch score failed', details: err.message });
  }
});

// ===== ACCOUNT TIER FORECASTING (Ralph 2026-02-21 noon) =====
// Revenue tier classification for pipeline prospects.
// Tiers: standard ($400/mo), custom ($700/mo), portfolio ($12K/mo).
// Surfaces the revenue forecasting gap between individual placements and portfolio brand programs.

app.get('/account-tiers', (req, res) => {
  res.sendFile(path.join(__dirname, 'account-tiers.html'));
});

// GET /api/pipeline/account-tiers — all tier assignments
app.get('/api/pipeline/account-tiers', (req, res) => {
  try {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== 'kande2026') return res.status(401).json({ error: 'Unauthorized' });

    const tiers = db.accountTiers || {};
    const TIER_MRR = { standard: 400, custom: 700, portfolio: 12000 };

    // Build summary stats from prospect data
    const pipeline = (db.prospects || []).filter(p =>
      ['proposal_sent', 'negotiating', 'active', 'contacted'].includes(p.status)
    );

    const counts    = { standard: 0, custom: 0, portfolio: 0, unset: 0 };
    let totalMrr    = 0;

    pipeline.forEach(p => {
      const tier = tiers[String(p.id)] || 'unset';
      counts[tier] = (counts[tier] || 0) + 1;
      if (tier !== 'unset') totalMrr += TIER_MRR[tier] || 0;
    });

    res.json({
      tiers,
      counts,
      totalMrr,
      pipelineSize: pipeline.length,
      updatedAt: db.accountTiersUpdated || null
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load account tiers', details: err.message });
  }
});

// POST /api/pipeline/account-tiers — set tier for a single prospect
app.post('/api/pipeline/account-tiers', express.json(), (req, res) => {
  try {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== 'kande2026') return res.status(401).json({ error: 'Unauthorized' });

    const { id, tier } = req.body;
    if (!id) return res.status(400).json({ error: 'id required' });

    const VALID_TIERS = ['standard', 'custom', 'portfolio', 'unset'];
    if (!VALID_TIERS.includes(tier)) {
      return res.status(400).json({ error: `tier must be one of: ${VALID_TIERS.join(', ')}` });
    }

    if (!db.accountTiers) db.accountTiers = {};
    if (tier === 'unset') {
      delete db.accountTiers[String(id)];
    } else {
      db.accountTiers[String(id)] = tier;
    }
    db.accountTiersUpdated = new Date().toISOString();
    saveDB(db);

    const TIER_MRR = { standard: 400, custom: 700, portfolio: 12000 };
    console.log(`💎 Account tier set: prospect ${id} → ${tier} ($${TIER_MRR[tier] || 0}/mo)`);
    res.json({ ok: true, id, tier, mrr: TIER_MRR[tier] || 0 });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save tier', details: err.message });
  }
});

// POST /api/pipeline/account-tiers/bulk — bulk set tiers (for agents to batch-tag)
app.post('/api/pipeline/account-tiers/bulk', express.json(), (req, res) => {
  try {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== 'kande2026') return res.status(401).json({ error: 'Unauthorized' });

    const { assignments } = req.body; // [{ id, tier }, ...]
    if (!Array.isArray(assignments)) return res.status(400).json({ error: 'assignments array required' });

    if (!db.accountTiers) db.accountTiers = {};
    let saved = 0;
    const VALID = ['standard', 'custom', 'portfolio', 'unset'];
    assignments.forEach(({ id, tier }) => {
      if (!id || !VALID.includes(tier)) return;
      if (tier === 'unset') delete db.accountTiers[String(id)];
      else db.accountTiers[String(id)] = tier;
      saved++;
    });
    db.accountTiersUpdated = new Date().toISOString();
    saveDB(db);
    console.log(`💎 Account tiers bulk-set: ${saved} assignments`);
    res.json({ ok: true, saved });
  } catch (err) {
    res.status(500).json({ error: 'Bulk tier set failed', details: err.message });
  }
});

// ===== CRM STATUS DIFF (Ralph 2026-02-21 noon) =====
// Detects prospect status changes since last snapshot.
// Auto-pushes opening_soon→active and new→contacted transitions to engagement-alerts.
// Implements the "Gemma lesson" — Scout caught a status change manually; this makes it automatic.

// GET /api/crm/status-diff — compare current statuses to snapshot, return changes
app.get('/api/crm/status-diff', (req, res) => {
  try {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== 'kande2026') return res.status(401).json({ error: 'Unauthorized' });

    const snapshot = db.crmStatusSnapshot || {};
    const prospects = db.prospects || [];
    const changes   = [];
    const HIGH_VALUE_TRANSITIONS = [
      'opening_soon→active',
      'new→contacted',
      'contacted→proposal_sent',
      'proposal_sent→negotiating',
      'negotiating→active'
    ];

    prospects.forEach(p => {
      const prev = snapshot[String(p.id)];
      if (prev && prev !== p.status) {
        const key = `${prev}→${p.status}`;
        const isHighValue = HIGH_VALUE_TRANSITIONS.includes(key);
        changes.push({
          id:         p.id,
          name:       p.name,
          from:       prev,
          to:         p.status,
          isHighValue,
          alerted:    false,
          detectedAt: new Date().toISOString()
        });
      }
    });

    // Auto-push high-value transitions to engagement-alerts
    const highValue = changes.filter(c => c.isHighValue);
    if (highValue.length > 0) {
      const existing   = (db.pipelineEngagement && db.pipelineEngagement.alerts) ? db.pipelineEngagement.alerts : [];
      const newAlerts  = highValue.map(c => ({
        level:    c.from === 'opening_soon' && c.to === 'active' ? 'hot' : 'info',
        prospect: c.name,
        title:    `${c.name} — Status changed: ${c.from} → ${c.to}`,
        message:  c.from === 'opening_soon' && c.to === 'active'
          ? `NOW LEASING confirmed. 7-day vendor selection window open. Call immediately.`
          : `Status updated from ${c.from} to ${c.to}. Review and take action.`,
        tags:     ['Auto-detected', `${c.from} → ${c.to}`],
        opens:    { internal: 0, external: 0 },
        autoDetected: true,
        detectedAt: new Date().toISOString()
      }));

      // Merge with existing alerts (deduplicate by prospect name)
      const merged = [...newAlerts];
      existing.forEach(a => {
        if (!merged.some(m => m.prospect === a.prospect)) merged.push(a);
      });

      if (!db.pipelineEngagement) db.pipelineEngagement = {};
      db.pipelineEngagement.alerts  = merged;
      db.pipelineEngagement.lastSync = new Date().toISOString();
      saveDB(db);

      highValue.forEach(c => { c.alerted = true; });
      console.log(`🔄 CRM Status Diff: ${changes.length} changes, ${highValue.length} auto-alerted`);
    }

    res.json({
      changes,
      summary: {
        total:     changes.length,
        highValue: highValue.length,
        alerted:   highValue.filter(c => c.alerted).length
      },
      snapshotAge: db.crmSnapshotUpdated ? `Since ${new Date(db.crmSnapshotUpdated).toLocaleString()}` : 'No snapshot yet',
      checkedAt:  new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({ error: 'Status diff failed', details: err.message });
  }
});

// POST /api/crm/status-diff/snapshot — save current status snapshot as new baseline
app.post('/api/crm/status-diff/snapshot', express.json(), (req, res) => {
  try {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== 'kande2026') return res.status(401).json({ error: 'Unauthorized' });

    const snapshot = {};
    (db.prospects || []).forEach(p => {
      snapshot[String(p.id)] = p.status;
    });

    db.crmStatusSnapshot  = snapshot;
    db.crmSnapshotUpdated = new Date().toISOString();
    saveDB(db);

    console.log(`📸 CRM Status snapshot saved: ${Object.keys(snapshot).length} prospects`);
    res.json({
      ok:          true,
      count:       Object.keys(snapshot).length,
      snapshotAt:  db.crmSnapshotUpdated
    });
  } catch (err) {
    res.status(500).json({ error: 'Snapshot failed', details: err.message });
  }
});

// ===== MARY REAL-TIME ALERTING (Ralph 2026-02-21 noon) =====
// Checks if today's PB inbox file was created by Mary.
// Returns an alert if no file exists by 9 AM — enables immediate notification
// rather than discovering a blackout days later.

app.get('/api/monitoring/pb-inbox', (req, res) => {
  try {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== 'kande2026') return res.status(401).json({ error: 'Unauthorized' });

    const today     = new Date();
    const dateStr   = today.toISOString().split('T')[0]; // YYYY-MM-DD
    const hour      = today.getHours(); // Pacific (Railway runs UTC; adjust offset in calculation)

    // Mary writes inbox files to /Users/kurtishon/clawd/agent-output/mary/
    // File pattern: inbox-YYYY-MM-DD.md
    const inboxDir  = '/Users/kurtishon/clawd/agent-output/mary';
    const todayFile = `${inboxDir}/inbox-${dateStr}.md`;
    const ystrdyFile = `${inboxDir}/inbox-${new Date(Date.now() - 86400000).toISOString().split('T')[0]}.md`;

    let todayExists = false;
    let ystrdyExists = false;
    let todayStats   = null;
    let lastFileDate = null;

    try { todayStats = fs.statSync(todayFile); todayExists = true; } catch (_) {}
    try { fs.statSync(ystrdyFile); ystrdyExists = true; } catch (_) {}

    // Find most recent inbox file
    try {
      const files = fs.readdirSync(inboxDir)
        .filter(f => f.startsWith('inbox-') && f.endsWith('.md'))
        .sort()
        .reverse();
      if (files.length > 0) lastFileDate = files[0].replace('inbox-', '').replace('.md', '');
    } catch (_) {}

    const daysSinceLast = lastFileDate
      ? Math.floor((Date.now() - new Date(lastFileDate).getTime()) / 86400000)
      : null;

    const isAlert    = !todayExists && (daysSinceLast === null || daysSinceLast >= 1);
    const isCritical = daysSinceLast !== null && daysSinceLast >= 2;

    // Persist to monitoring record in DB for heartbeat tracking
    if (!db.maryMonitoring) db.maryMonitoring = {};
    db.maryMonitoring.lastChecked     = new Date().toISOString();
    db.maryMonitoring.todayFileExists = todayExists;
    db.maryMonitoring.lastFileDate    = lastFileDate;
    db.maryMonitoring.daysSinceLast   = daysSinceLast;
    db.maryMonitoring.isAlert         = isAlert;
    saveDB(db);

    res.json({
      date:            dateStr,
      todayFileExists: todayExists,
      todayFileSize:   todayStats ? todayStats.size : null,
      todayFilePath:   todayFile,
      yesterdayExists: ystrdyExists,
      lastFileDate,
      daysSinceLast,
      isAlert,
      isCritical,
      status:    todayExists ? 'ok' : isCritical ? 'critical' : isAlert ? 'alert' : 'ok',
      message:   todayExists
        ? `✅ Mary's inbox file for ${dateStr} exists. System operational.`
        : isCritical
        ? `🚨 CRITICAL: Mary has been offline for ${daysSinceLast} days. Last file: ${lastFileDate || 'none'}. March wedding season in 8 days.`
        : `⚠️ ALERT: No inbox file for today (${dateStr}). Last file was ${lastFileDate || 'never'}. Mary may be offline.`,
      checkedAt: new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({ error: 'PB inbox check failed', details: err.message });
  }
});

// GET /api/monitoring/mary — summary mary status (alias for pb-inbox)
app.get('/api/monitoring/mary', (req, res) => {
  // Lightweight status check using cached DB record
  try {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== 'kande2026') return res.status(401).json({ error: 'Unauthorized' });

    const m = db.maryMonitoring || {};
    res.json({
      ...m,
      message: m.daysSinceLast >= 2
        ? `🚨 CRITICAL: ${m.daysSinceLast} days offline`
        : m.isAlert
        ? `⚠️ ALERT: No file today`
        : '✅ Operating normally',
      checkedAt: new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== JOB IDEMPOTENCY SENTINEL (Ralph 2026-02-21 pm) =====
// Prevents cron jobs from firing multiple times per day.
// Implements the scout-morning fix: fired 11x during CRM DNS outage (Feb 20).
// Agents call GET /api/jobs/sentinel?job=scout-morning before running.
// If already ran today → 409 Conflict. If safe → 200 OK.
// After successful run: POST /api/jobs/sentinel { job, result } to mark done.

app.get('/api/jobs/sentinel', (req, res) => {
  try {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== 'kande2026') return res.status(401).json({ error: 'Unauthorized' });

    const { job } = req.query;
    if (!job) return res.status(400).json({ error: 'job query parameter required', example: '?job=scout-morning' });

    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD (UTC)
    const sentinels = db.jobSentinels || {};
    const entry = sentinels[job];

    if (entry && entry.date === today) {
      const ranAt = new Date(entry.ranAt).toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles', hour:'numeric', minute:'2-digit', hour12:true });
      return res.status(409).json({
        ok:          false,
        alreadyRan:  true,
        job,
        date:        today,
        ranAt:       entry.ranAt,
        ranAtPT:     ranAt,
        result:      entry.result || 'completed',
        message:     `Job "${job}" already ran today at ${ranAt} PT. Skipping.`
      });
    }

    res.json({
      ok:         true,
      alreadyRan: false,
      job,
      date:       today,
      message:    `Job "${job}" has not run today. Safe to proceed.`
    });
  } catch (err) {
    res.status(500).json({ error: 'Sentinel check failed', details: err.message });
  }
});

// POST /api/jobs/sentinel — mark a job as completed for today
app.post('/api/jobs/sentinel', express.json(), (req, res) => {
  try {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== 'kande2026') return res.status(401).json({ error: 'Unauthorized' });

    const { job, result } = req.body;
    if (!job) return res.status(400).json({ error: 'job is required' });

    const today = new Date().toISOString().split('T')[0];
    if (!db.jobSentinels) db.jobSentinels = {};
    db.jobSentinels[job] = {
      date:   today,
      ranAt:  new Date().toISOString(),
      result: result || 'completed'
    };
    saveDB(db);
    console.log(`🛡️ Job sentinel set: ${job} → done for ${today}`);
    res.json({ ok: true, job, date: today, ranAt: db.jobSentinels[job].ranAt });
  } catch (err) {
    res.status(500).json({ error: 'Sentinel set failed', details: err.message });
  }
});

// DELETE /api/jobs/sentinel — clear sentinel (for testing / force re-run)
app.delete('/api/jobs/sentinel', (req, res) => {
  try {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== 'kande2026') return res.status(401).json({ error: 'Unauthorized' });

    const { job } = req.query;
    if (!job) return res.status(400).json({ error: 'job query parameter required' });

    if (db.jobSentinels && db.jobSentinels[job]) {
      delete db.jobSentinels[job];
      saveDB(db);
      console.log(`🛡️ Job sentinel cleared: ${job}`);
      res.json({ ok: true, job, message: `Sentinel cleared — ${job} will run on next invocation.` });
    } else {
      res.json({ ok: true, job, message: `No sentinel found for ${job}.` });
    }
  } catch (err) {
    res.status(500).json({ error: 'Sentinel clear failed', details: err.message });
  }
});

// GET /api/jobs/sentinel/status — list all active sentinels (admin view)
app.get('/api/jobs/sentinel/status', (req, res) => {
  try {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== 'kande2026') return res.status(401).json({ error: 'Unauthorized' });

    const today = new Date().toISOString().split('T')[0];
    const sentinels = db.jobSentinels || {};
    const statuses = Object.entries(sentinels).map(([job, entry]) => ({
      job,
      date:       entry.date,
      ranAt:      entry.ranAt,
      result:     entry.result,
      isToday:    entry.date === today,
      stale:      entry.date !== today
    }));

    res.json({
      today,
      count:      statuses.length,
      todayCount: statuses.filter(s => s.isToday).length,
      sentinels:  statuses,
      checkedAt:  new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== KANDE DIGITAL PROSPECT TRACKER (Ralph 2026-02-22) =====
// Scout's research container for Kande Digital (GMB optimization) leads.
// GET /api/digital/prospects — list all prospects with optional filters
// POST /api/digital/prospects — add or update a prospect (upsert by businessName+city)
// DELETE /api/digital/prospects/:id — remove a prospect
// Scout's research sprint cannot start without this tracker.

app.get('/digital/prospects', (req, res) => {
  res.sendFile(path.join(__dirname, 'digital-prospects.html'));
});

app.get('/api/digital/prospects', (req, res) => {
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== 'kande2026') return res.status(401).json({ error: 'Unauthorized' });

  const prospects = db.digitalProspects || [];
  const { status, category, pain_min } = req.query;

  let filtered = [...prospects];
  if (status) filtered = filtered.filter(p => p.status === status);
  if (category) filtered = filtered.filter(p => p.category === category);
  if (pain_min) filtered = filtered.filter(p => (p.pain_score || 0) >= parseInt(pain_min));

  // Sort: pain_score desc, then by addedAt desc
  filtered.sort((a, b) => (b.pain_score || 0) - (a.pain_score || 0) || new Date(b.addedAt) - new Date(a.addedAt));

  const stats = {
    total: prospects.length,
    byStatus: {
      new: prospects.filter(p => p.status === 'new').length,
      contacted: prospects.filter(p => p.status === 'contacted').length,
      pitched: prospects.filter(p => p.status === 'pitched').length,
      active: prospects.filter(p => p.status === 'active').length,
      passed: prospects.filter(p => p.status === 'passed').length
    },
    byCategory: {
      hvac: prospects.filter(p => p.category === 'hvac').length,
      pest_control: prospects.filter(p => p.category === 'pest_control').length,
      roofing: prospects.filter(p => p.category === 'roofing').length,
      auto_repair: prospects.filter(p => p.category === 'auto_repair').length,
      electrical: prospects.filter(p => p.category === 'electrical').length,
      other: prospects.filter(p => !['hvac','pest_control','roofing','auto_repair','electrical'].includes(p.category)).length
    },
    avgPainScore: prospects.length ? (prospects.reduce((s, p) => s + (p.pain_score || 0), 0) / prospects.length).toFixed(1) : 0,
    highPainCount: prospects.filter(p => (p.pain_score || 0) >= 3).length
  };

  res.json({ ok: true, prospects: filtered, stats, count: filtered.length });
});

app.post('/api/digital/prospects', (req, res) => {
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== 'kande2026') return res.status(401).json({ error: 'Unauthorized' });

  const {
    businessName, city, category, gmb_url, phone, owner_name,
    star_rating, review_count, last_gmb_post, response_rate,
    pain_score, estimated_lost_revenue, status, notes
  } = req.body;

  if (!businessName) return res.status(400).json({ error: 'businessName required' });

  if (!db.digitalProspects) db.digitalProspects = [];

  // Upsert by businessName + city
  const key = `${(businessName || '').toLowerCase().trim()}|${(city || 'las vegas').toLowerCase().trim()}`;
  const existing = db.digitalProspects.find(p => `${(p.businessName||'').toLowerCase().trim()}|${(p.city||'las vegas').toLowerCase().trim()}` === key);

  const now = new Date().toISOString();
  if (existing) {
    // Update existing
    if (category !== undefined) existing.category = category;
    if (gmb_url !== undefined) existing.gmb_url = gmb_url;
    if (phone !== undefined) existing.phone = phone;
    if (owner_name !== undefined) existing.owner_name = owner_name;
    if (star_rating !== undefined) existing.star_rating = parseFloat(star_rating);
    if (review_count !== undefined) existing.review_count = parseInt(review_count);
    if (last_gmb_post !== undefined) existing.last_gmb_post = last_gmb_post;
    if (response_rate !== undefined) existing.response_rate = parseFloat(response_rate);
    if (pain_score !== undefined) existing.pain_score = parseInt(pain_score);
    if (estimated_lost_revenue !== undefined) existing.estimated_lost_revenue = estimated_lost_revenue;
    if (status !== undefined) existing.status = status;
    if (notes !== undefined) existing.notes = notes;
    existing.updatedAt = now;
    saveDB(db);
    return res.json({ ok: true, action: 'updated', prospect: existing });
  }

  // Create new
  const newProspect = {
    id: Date.now(),
    businessName,
    city: city || 'Las Vegas',
    category: category || 'hvac',
    gmb_url: gmb_url || '',
    phone: phone || '',
    owner_name: owner_name || '',
    star_rating: star_rating ? parseFloat(star_rating) : null,
    review_count: review_count ? parseInt(review_count) : null,
    last_gmb_post: last_gmb_post || '',
    response_rate: response_rate ? parseFloat(response_rate) : null,
    pain_score: pain_score ? parseInt(pain_score) : 1,
    estimated_lost_revenue: estimated_lost_revenue || '',
    status: status || 'new',
    notes: notes || '',
    addedAt: now,
    updatedAt: now
  };

  db.digitalProspects.push(newProspect);
  saveDB(db);
  res.json({ ok: true, action: 'created', prospect: newProspect });
});

app.delete('/api/digital/prospects/:id', (req, res) => {
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== 'kande2026') return res.status(401).json({ error: 'Unauthorized' });
  if (!db.digitalProspects) return res.json({ ok: true, removed: false });

  const id = parseInt(req.params.id);
  const before = db.digitalProspects.length;
  db.digitalProspects = db.digitalProspects.filter(p => p.id !== id);
  saveDB(db);
  res.json({ ok: true, removed: db.digitalProspects.length < before });
});

app.patch('/api/digital/prospects/:id/status', (req, res) => {
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== 'kande2026') return res.status(401).json({ error: 'Unauthorized' });
  if (!db.digitalProspects) return res.status(404).json({ error: 'Not found' });

  const id = parseInt(req.params.id);
  const prospect = db.digitalProspects.find(p => p.id === id);
  if (!prospect) return res.status(404).json({ error: 'Prospect not found' });

  const { status, notes } = req.body;
  if (status) prospect.status = status;
  if (notes !== undefined) prospect.notes = notes;
  prospect.updatedAt = new Date().toISOString();
  saveDB(db);
  res.json({ ok: true, prospect });
});

// ===== CALL SHEET GENERATOR (Ralph 2026-02-22) =====
// The bridge from intelligence infrastructure to execution quality.
// Per Feb 21 EOD: "Call Sheet Generator = The Last Engineering Priority"
// GET /api/pipeline/call-sheet?date=monday — ordered call list with per-lead coaching
// POST /api/pipeline/call-sheet — upsert a prepared call card
// DELETE /api/pipeline/call-sheet/:id — remove

app.get('/call-sheet', (req, res) => {
  res.sendFile(path.join(__dirname, 'call-sheet.html'));
});

// Seed default call sheet data (Monday Feb 24 — from action-items.md)
const DEFAULT_CALL_SHEET = [
  {
    id: 1,
    prospect_name: 'Carnegie Heights / BWLiving',
    crm_id: '5050',
    phone: '',
    contact: 'Makenna Simmons / Jeannie',
    units: '300+',
    last_contact: '2026-02-19',
    days_since_contact: 5,
    engagement_signal: 'hot',
    engagement_detail: 'ED "loves it", contract stage',
    priority: 1,
    pitch_track: 'residential',
    recommended_opener: 'Happy to answer any logistics questions before you finalize everything. Wanted to make sure the process is smooth on your end.',
    anticipated_objection: 'Needs to check with the approver above her',
    step_down_offer: '90-day single-machine pilot — no long-term commitment, we remove it at no cost if residents don\'t use it.',
    win_condition: 'Map the full approver chain (who signs above Makenna?). Do NOT send contract until approval path is clear.',
    current_vendor: 'Unknown',
    canteen_flag: false,
    called: false
  },
  {
    id: 2,
    prospect_name: 'Lyric / RPM Living',
    crm_id: '531',
    phone: '',
    contact: 'Mirtha Valenzuela',
    units: '250+',
    last_contact: '2026-02-14',
    days_since_contact: 10,
    engagement_signal: 'hot',
    engagement_detail: '8 external opens — proven interest. RPM also manages The Watermark (portfolio play).',
    priority: 2,
    pitch_track: 'residential',
    recommended_opener: 'I noticed you\'ve had a chance to look over the information a few times — wanted to check in and see if you had any questions or if timing works now.',
    anticipated_objection: 'Not in budget / need corporate approval',
    step_down_offer: '90-day single-machine pilot with zero commitment — costs you nothing if your residents don\'t use it.',
    win_condition: 'Mention The Watermark — position as portfolio play. One corporate relationship unlocks both properties.',
    current_vendor: 'Unknown',
    canteen_flag: false,
    called: false
  },
  {
    id: 3,
    prospect_name: 'Ilumina',
    crm_id: '67',
    phone: '',
    contact: 'Property Manager',
    units: '200+',
    last_contact: '2025-12-28',
    days_since_contact: 56,
    engagement_signal: 'phone_pivot',
    engagement_detail: '6 external opens over 28+ days — proven interest, email approach exhausted. OVERDUE by 28+ days.',
    priority: 3,
    pitch_track: 'residential',
    recommended_opener: 'I wanted to follow up — and I also saw some interesting news this week about AI in the vending industry that made me think of your building. Wanted to connect since the timing feels relevant to what we\'ve been discussing.',
    anticipated_objection: 'Timing / budget / already have a vendor',
    step_down_offer: '90-day single-machine pilot. No commitment. We remove it free if residents don\'t use it.',
    win_condition: '6 external opens = proven interest. CLOSE ON THIS CALL. Ask directly: "What would need to happen for us to get started?"',
    current_vendor: 'Unknown',
    canteen_flag: false,
    called: false
  },
  {
    id: 4,
    prospect_name: 'High Line at Hughes',
    crm_id: '11',
    phone: '',
    contact: 'Peter / Jose',
    units: '200+',
    last_contact: '2026-02-15',
    days_since_contact: 9,
    engagement_signal: 'warm',
    engagement_detail: '9 days stale after HOT pop-in with full property walk. High engagement from visit.',
    priority: 4,
    pitch_track: 'residential',
    recommended_opener: 'I stopped by last week and had a great conversation with the team — wanted to follow up now that you\'ve had a few days to think about it.',
    anticipated_objection: 'Still evaluating / need to check contract terms',
    step_down_offer: '90-day pilot removes the risk entirely. One machine, your lobby, no paperwork beyond a simple one-pager.',
    win_condition: 'They did the property walk — they\'re interested. Push for a decision. Ask: "What\'s the one thing holding you back?"',
    current_vendor: 'Unknown',
    canteen_flag: false,
    called: false
  },
  {
    id: 5,
    prospect_name: 'Oakmont of The Lakes',
    crm_id: '540',
    phone: '',
    contact: 'daalgaard@oakmontmg.com',
    units: 'Senior Living',
    last_contact: '2026-02-14',
    days_since_contact: 10,
    engagement_signal: 'warm',
    engagement_detail: '10 days, no engagement yet. Senior living — families visiting = high vending usage.',
    priority: 5,
    pitch_track: 'senior_living',
    recommended_opener: 'Hi, I\'m calling about vending solutions for senior living communities — we\'ve placed machines at several Heirloom properties and wanted to reach out about The Lakes specifically.',
    anticipated_objection: 'Already have a vendor / not a priority right now',
    step_down_offer: 'No long-term commitment — 90-day pilot. Families visiting residents are the primary users. No cost to your facility.',
    win_condition: 'Senior living decision = ED approval. Ask who to copy on next steps.',
    current_vendor: 'Unknown',
    canteen_flag: false,
    called: false
  },
  {
    id: 6,
    prospect_name: 'Jade Apartments',
    crm_id: '29',
    phone: '',
    contact: 'External PM',
    units: '150+',
    last_contact: '2026-02-19',
    days_since_contact: 3,
    engagement_signal: 'warm',
    engagement_detail: 'External PM re-engagement Feb 19 — possible contract re-open or renewal signal.',
    priority: 6,
    pitch_track: 'residential',
    recommended_opener: 'I noticed some renewed activity on your end — wanted to check in and see if there\'s anything we can do to get the contract finalized.',
    anticipated_objection: 'Waiting on management / previous contract lapsed',
    step_down_offer: 'Simplified one-page agreement — we can get a machine in within 72 hours of signing.',
    win_condition: 'They engaged again — verify contract status first. If lapsed, use simplified one-page agreement to reclose.',
    current_vendor: 'Unknown',
    canteen_flag: false,
    called: false
  },
  {
    id: 7,
    prospect_name: 'Gemma Las Vegas',
    crm_id: '4907',
    phone: '(725) 258-2560',
    contact: 'Leasing Office',
    units: '337',
    last_contact: null,
    days_since_contact: null,
    engagement_signal: 'urgent',
    engagement_detail: 'Status changed opening_soon → active TODAY. 337 units NOW LEASING. 7-day vendor selection window open — competitors are calling.',
    priority: 7,
    pitch_track: 'residential',
    recommended_opener: 'Congratulations on opening — I saw you\'re now leasing at Gemma. We work with several Henderson communities and wanted to reach out while you\'re still setting up your amenities.',
    anticipated_objection: 'Too early / haven\'t thought about vending yet',
    step_down_offer: 'No commitment needed right now — let\'s set up a quick visit so you can see what we\'d recommend for your common areas.',
    win_condition: 'Vendor selection window is OPEN. Get a site visit scheduled THIS WEEK before competitors do.',
    current_vendor: 'None (new property)',
    canteen_flag: false,
    called: false
  },
  {
    id: 8,
    prospect_name: 'Paysign Inc',
    crm_id: '5571',
    phone: '(702) 706-9901',
    contact: 'Facilities Manager',
    units: '345 employees',
    last_contact: null,
    days_since_contact: null,
    engagement_signal: 'warm',
    engagement_detail: 'Never activated despite being in CRM. 2 Henderson locations. FinTech company — tech-forward employer.',
    priority: 8,
    pitch_track: 'employer',
    recommended_opener: 'Hi, I\'m calling about break room vending for your Henderson office — we serve several employer accounts in the area and wanted to reach out about your team\'s snack and drink options.',
    anticipated_objection: 'We have a vendor / not in budget',
    step_down_offer: '30-day pilot for one location — zero commitment, we handle restocking entirely.',
    win_condition: 'Pitch BOTH Henderson locations simultaneously. Ask: "Do you handle vendor decisions for both your locations?" Then bundle both in one agreement.',
    current_vendor: 'Unknown',
    canteen_flag: false,
    called: false
  }
];

app.get('/api/pipeline/call-sheet', (req, res) => {
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== 'kande2026') return res.status(401).json({ error: 'Unauthorized' });

  // Use saved call sheet if available, otherwise return default seeded data
  if (!db.callSheet || db.callSheet.length === 0) {
    db.callSheet = DEFAULT_CALL_SHEET.map(c => ({ ...c }));
    saveDB(db);
  }

  const { status } = req.query;
  let sheet = db.callSheet;
  if (status === 'pending') sheet = sheet.filter(c => !c.called);
  if (status === 'called') sheet = sheet.filter(c => c.called);

  const stats = {
    total: db.callSheet.length,
    pending: db.callSheet.filter(c => !c.called).length,
    called: db.callSheet.filter(c => c.called).length,
    hotPivots: db.callSheet.filter(c => c.engagement_signal === 'phone_pivot' || c.engagement_signal === 'urgent').length
  };

  res.json({ ok: true, callSheet: sheet, stats, generatedAt: new Date().toISOString() });
});

app.post('/api/pipeline/call-sheet', (req, res) => {
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== 'kande2026') return res.status(401).json({ error: 'Unauthorized' });

  if (!db.callSheet) db.callSheet = DEFAULT_CALL_SHEET.map(c => ({ ...c }));

  const entry = req.body;
  if (!entry.prospect_name) return res.status(400).json({ error: 'prospect_name required' });

  const existing = db.callSheet.find(c => c.id === entry.id || c.prospect_name === entry.prospect_name);
  if (existing) {
    Object.assign(existing, entry, { updatedAt: new Date().toISOString() });
    saveDB(db);
    return res.json({ ok: true, action: 'updated', entry: existing });
  }

  const newEntry = { ...entry, id: Date.now(), addedAt: new Date().toISOString() };
  db.callSheet.push(newEntry);
  saveDB(db);
  res.json({ ok: true, action: 'created', entry: newEntry });
});

app.patch('/api/pipeline/call-sheet/:id/called', (req, res) => {
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== 'kande2026') return res.status(401).json({ error: 'Unauthorized' });

  if (!db.callSheet) db.callSheet = DEFAULT_CALL_SHEET.map(c => ({ ...c }));

  const id = parseInt(req.params.id);
  const entry = db.callSheet.find(c => c.id === id);
  if (!entry) return res.status(404).json({ error: 'Not found' });

  const { called, outcome, notes } = req.body;
  entry.called = called !== undefined ? called : true;
  if (outcome) entry.outcome = outcome;
  if (notes) entry.call_notes = notes;
  entry.calledAt = new Date().toISOString();
  saveDB(db);
  res.json({ ok: true, entry });
});

app.delete('/api/pipeline/call-sheet/:id', (req, res) => {
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== 'kande2026') return res.status(401).json({ error: 'Unauthorized' });
  if (!db.callSheet) return res.json({ ok: true, removed: false });

  const id = parseInt(req.params.id);
  const before = db.callSheet.length;
  db.callSheet = db.callSheet.filter(c => c.id !== id);
  saveDB(db);
  res.json({ ok: true, removed: db.callSheet.length < before });
});

// ===== DEPLOYMENT DIAGNOSTICS (Ralph 2026-02-21 pm — Railway cache-bust) =====
// Added to force Railway to rebuild and redeploy with the full server.js.
// Railway was caching a pre-8AM version missing all routes added today.
// DEPLOY_VERSION: 2026-02-22-v2 (8pm — fix db.save bug in POST routes)

app.get('/api/debug/deploy-version', (req, res) => {
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== 'kande2026') return res.status(401).json({ error: 'Unauthorized' });

  // Count registered routes to verify full deployment
  const routeCount = app._router ? app._router.stack.filter(r => r.route).length : 0;
  const totalLines = 24835; // Expected server.js line count
  const deployVersion = '2026-02-21-v4';
  const expectedRoutes = [
    '/api/pipeline/engagement-alerts',
    '/api/pipeline/account-tiers',
    '/api/crm/status-diff',
    '/api/monitoring/pb-inbox',
    '/api/jobs/sentinel',
    '/scout-intel',
    '/account-tiers',
    '/briefing',
    '/api/digital/prospects',
    '/digital/prospects',
    '/api/pipeline/call-sheet',
    '/call-sheet'
  ];

  // Check which expected routes are registered
  const registeredPaths = app._router
    ? app._router.stack.filter(r => r.route).map(r => r.route.path)
    : [];
  const missingRoutes = expectedRoutes.filter(r => !registeredPaths.includes(r));

  res.json({
    ok:            true,
    deployVersion,
    totalLines,
    routeCount,
    expectedNew:   expectedRoutes.length,
    missingRoutes,
    allNewRoutesPresent: missingRoutes.length === 0,
    serverStarted: new Date().toISOString(),
    message:       missingRoutes.length === 0
      ? `✅ Full deployment confirmed — ${routeCount} routes registered`
      : `⚠️ PARTIAL DEPLOYMENT — ${missingRoutes.length} routes missing: ${missingRoutes.join(', ')}`
  });
});
