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

// Generate session tokens
const activeSessions = new Set();

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
  const publicPaths = ['/login', '/login.html', '/api/auth/login', '/api/auth/logout', '/api/health', '/logo.png', '/favicon.ico', '/client-portal', '/api/client-portal', '/driver', '/api/driver'];
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
  
  if (sessionToken && activeSessions.has(sessionToken)) {
    return next();
  }
  
  // Check for API key in header (for programmatic access)
  const apiKey = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
  if (apiKey === ADMIN_PASSWORD) {
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
  
  if (password === ADMIN_PASSWORD) {
    const token = generateToken();
    activeSessions.add(token);
    
    // Set cookie (7 days)
    res.setHeader('Set-Cookie', `vendtech_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${7 * 24 * 60 * 60}`);
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
    activeSessions.delete(sessionToken);
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
    const labels = { new: '🆕 New', active: '🔵 Active', signed: '✅ Signed', closed: '⛔ Stale' };
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
  db = { prospects: [], contacts: [], activities: [], machines: [], locations: [], products: [], suppliers: [], finances: [], creditCards: [], restocks: [], aiOfficeRuns: [], staff: [], shifts: [], clients: [], touchpoints: [], issues: [], sales: [], planograms: [], marketingSpend: [], leadSources: [], gbpMetrics: [], competitors: [], revenue: [], contracts: [], emailTemplates: [], emailSequences: [], emailSends: [], restockLogs: [], salesVelocity: [], restockCapacities: {}, micromarkets: [], smartMachines: [], machineTelemetry: [], todos: [], nextId: 1 };
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
app.get('/activities', (req, res) => res.sendFile(path.join(__dirname, 'activities.html')));
app.get('/map', (req, res) => res.sendFile(path.join(__dirname, 'map.html')));
app.get('/machines', (req, res) => res.sendFile(path.join(__dirname, 'machines.html')));
app.get('/inventory', (req, res) => res.sendFile(path.join(__dirname, 'inventory.html')));
app.get('/finance', (req, res) => res.sendFile(path.join(__dirname, 'finance.html')));
app.get('/restock', (req, res) => res.sendFile(path.join(__dirname, 'restock.html')));
app.get('/staff', (req, res) => res.sendFile(path.join(__dirname, 'staff.html')));
app.get('/clients', (req, res) => res.sendFile(path.join(__dirname, 'clients.html')));
app.get('/ai-office', (req, res) => res.sendFile(path.join(__dirname, 'ai-office.html')));
app.get('/kanban', (req, res) => res.sendFile(path.join(__dirname, 'kanban.html')));
app.get('/performance', (req, res) => res.sendFile(path.join(__dirname, 'performance.html')));
app.get('/planogram', (req, res) => res.sendFile(path.join(__dirname, 'planogram.html')));
app.get('/contracts', (req, res) => res.sendFile(path.join(__dirname, 'contracts.html')));
app.get('/competitors', (req, res) => res.sendFile(path.join(__dirname, 'competitors.html')));
app.get('/revenue', (req, res) => res.sendFile(path.join(__dirname, 'revenue.html')));
app.get('/analytics', (req, res) => res.sendFile(path.join(__dirname, 'analytics.html')));
app.get('/trends', (req, res) => res.sendFile(path.join(__dirname, 'trends.html')));
app.get('/property-analysis', (req, res) => res.sendFile(path.join(__dirname, 'property-analysis.html')));
app.get('/micromarkets', (req, res) => res.sendFile(path.join(__dirname, 'micromarkets.html')));
app.get('/lead-import', (req, res) => res.sendFile(path.join(__dirname, 'lead-import.html')));
app.get('/products', (req, res) => res.sendFile(path.join(__dirname, 'products.html')));
app.get('/route-planner', (req, res) => res.sendFile(path.join(__dirname, 'route-planner.html')));
app.get('/outreach', (req, res) => res.sendFile(path.join(__dirname, 'outreach.html')));
app.get('/restock-predictions', (req, res) => res.sendFile(path.join(__dirname, 'restock-predictions.html')));
app.get('/smart-machines', (req, res) => res.sendFile(path.join(__dirname, 'smart-machines.html')));

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
  const { serial, model, location, install_date, status, notes } = req.body;
  if (!serial || !serial.trim()) return res.status(400).json({ error: 'serial is required' });
  if (!location || !location.trim()) return res.status(400).json({ error: 'location is required' });
  // Check duplicate serial
  if ((db.fleetMachines || []).some(m => m.serial.toLowerCase() === serial.trim().toLowerCase())) {
    return res.status(400).json({ error: 'A machine with this serial number already exists' });
  }
  const machine = {
    id: nextId(),
    serial: serial.trim(),
    model: (model || 'SandStar AI').trim(),
    location: location.trim(),
    install_date: install_date || null,
    status: status || 'available',
    notes: notes || '',
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
const INSTANTLY_API_KEY = process.env.INSTANTLY_API_KEY || '';
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
  { id: 'pop_in_done', label: 'Pop-In Done', order: 2, color: '#a855f7', emoji: '🚶' },
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
      const t = (a.type || '').toLowerCase();
      return ['pop_in', 'email', 'call', 'phone', 'proposal', 'meeting', 'visit', 'outreach', 'thank_you'].includes(t);
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
app.get('/tasks', (req, res) => res.sendFile(path.join(__dirname, 'task-manager.html')));
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

app.listen(PORT, () => {
  console.log(`🤖 Kande VendTech Dashboard running at http://localhost:${PORT}`);
});
