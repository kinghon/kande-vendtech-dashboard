/**
 * qual-gate.js — Lightweight pre-CRM qualification gate
 * Used by server.js POST /api/prospects to gate lead entry.
 *
 * Scoring (0–6):
 *   +2  Maps exists AND maps_business_status = OPERATIONAL
 *   +2  google_rating >= 3.5 AND google_review_count >= 5
 *   +2  Has at least 1 contact with name, phone, or email
 *
 * Tiers:
 *   score >= 4  → A/B  → approved, save normally
 *   score == 2-3 → C   → rejected (same as D)
 *   score <= 1  → D    → rejected (log to file, return 422)
 *
 * Bypass (always approved):
 *   source = "manual" | "referral"
 *   kurtis_notes non-empty
 */

const fs   = require('fs');
const path = require('path');

const REJECTION_LOG = '/Users/kurtishon/clawd/logs/qual-rejections.jsonl';
const BLOCKLIST_PATH = '/Users/kurtishon/clawd/data/lead-blocklist.json';

function loadBlocklist() {
  try {
    const raw = fs.readFileSync(BLOCKLIST_PATH, 'utf8');
    return JSON.parse(raw);
  } catch { return []; }
}

function isBlocked(data) {
  const list = loadBlocklist();
  const placeId = data.google_place_id || data.maps_place_id;
  const name = (data.name || '').toLowerCase().trim();
  if (placeId && list.some(e => e.google_place_id === placeId)) {
    return { blocked: true, reason: `place_id ${placeId} is on blocklist` };
  }
  if (name && list.some(e => (e.name || '').toLowerCase().trim() === name)) {
    return { blocked: true, reason: `"${data.name}" is on blocklist` };
  }
  return { blocked: false };
}

function qualifyLead(data) {
  // Bypass for trusted sources — no Maps data needed
  const source = (data.source || '').toLowerCase();
  const kurtisNotes = (data.kurtis_notes || '').trim();
  if (['manual', 'referral', 'field'].includes(source) || kurtisNotes) {
    return { tier: 'A', score: 6, reason: `${source || 'manual'} source bypass`, bypass: true };
  }

  // Business type filter — reject categories that will never be vending targets
  const category = (data.category || data.property_type || '').toLowerCase();
  const name = (data.name || '').toLowerCase();
  const address = (data.address || '').toLowerCase();
  const REJECT_TYPES = [
    'church', 'temple', 'mosque', 'synagogue', 'religious', 'worship',
    'elementary school', 'middle school', 'high school', 'k-12', 'christian academy',
    'park', 'trail', 'trailhead', 'pedestrian bridge', 'disc golf',
    'fast food', 'restaurant', 'pizza', 'burger', 'taco', 'sandwich', 'sushi', 'bakeshop',
    'bar ', 'nightclub', 'lounge',
    'gas station', 'convenience store', '7-eleven', 'circle k',
    'hair salon', 'nail salon', 'beauty salon', 'barbershop',
    'atm', 'parking lot', 'parking garage',
    'photography', 'photographer', 'tutoring', 'notary',
    'pool service', 'lawn care', 'landscaping', 'plumbing', 'handyman', 'cleaning service',
  ];
  const REJECT_NAME_PATTERNS = [
    'elementary school', 'middle school', 'christian academy', 'church', 'mosque', 'temple',
    '7-eleven', 'burger king', 'mcdonald', 'subway', 'sonic drive', 'panda express',
    'starbucks', 'taco bell', 'wendy', 'jack in the box',
    'disc golf', 'trailhead', 'pedestrian bridge', ' park',
  ];
  if (REJECT_TYPES.some(t => category.includes(t))) {
    return { tier: 'D', score: 0, reason: `Category rejected: ${category}`, bypass: false };
  }
  if (REJECT_NAME_PATTERNS.some(p => name.includes(p))) {
    return { tier: 'D', score: 0, reason: `Name rejected: ${name}`, bypass: false };
  }
  // Reject residential addresses (home-based businesses)
  const RESIDENTIAL_PATTERNS = [/\bdr\b/i, /\bct\b/i, /\bave\b/i, /\bln\b/i];
  const COMMERCIAL_KEYWORDS = ['ste', 'suite', 'floor', 'unit #', 'blvd', 'pkwy', 'rd', 'industrial', 'commerce', 'executive', 'raiders way', 'bermuda', 'jet stream', 'sunset rd', 'decatur', 'flamingo', 'sahara', 'spring mountain', 'charleston', 'maryland', 'eastern', 'pecos', 'losee', 'cheyenne', 'craig', 'ann rd', 'warm springs', 'russell', 'windmill', 'horizon ridge', 'st rose', 'green valley'];
  const hasCommercialAddress = COMMERCIAL_KEYWORDS.some(k => address.includes(k));
  const looksResidential = !hasCommercialAddress && address.match(/\d+ [A-Z][a-z]+ (Dr|Ct|Ln|Way|St|Ave|Pl|Cir),/);
  if (looksResidential) {
    return { tier: 'D', score: 0, reason: `Residential address rejected`, bypass: false };
  }
  // Blocklist check — permanently banned Tier C/D locations
  const blockCheck = isBlocked(data);
  if (blockCheck.blocked) {
    return { tier: 'D', score: 0, reason: `Blocklisted: ${blockCheck.reason}`, bypass: false };
  }

  let score = 0;
  const reasons = [];

  // Check 1: Maps existence + operational status
  const mapsStatus = (data.maps_business_status || '').toUpperCase();
  const hasPlaceId = !!(data.google_place_id || data.maps_place_id);
  const browserScouted = ['maps-browser-scout', 'maps-grid-scout'].includes(data.source);
  if (hasPlaceId && mapsStatus === 'OPERATIONAL') {
    score += 2;
    reasons.push('Maps: operational');
  } else if (hasPlaceId) {
    score += 1;
    reasons.push(`Maps: exists but status=${mapsStatus || 'unknown'}`);
  } else if (browserScouted) {
    score += 2;
    reasons.push('Maps: found via browser scout');
  } else {
    reasons.push('Maps: no place_id');
  }

  // Check 2: Rating + review count quality
  const rating = parseFloat(data.google_rating) || 0;
  const reviewCount = parseInt(data.google_review_count) || 0;
  if (rating >= 3.5 && reviewCount >= 5) {
    score += 2;
    reasons.push(`Rating: ${rating} (${reviewCount} reviews)`);
  } else {
    reasons.push(`Rating: ${rating} / reviews: ${reviewCount} (below threshold)`);
  }

  // Check 3: Contact completeness
  const contacts = Array.isArray(data.contacts) ? data.contacts : [];
  const hasContact = contacts.some(c => c.name || c.phone || c.email);
  // Also check top-level phone/email fields
  const hasTopLevel = !!(data.phone || data.email);
  if (hasContact || hasTopLevel) {
    score += 2;
    reasons.push('Contact: present');
  } else {
    reasons.push('Contact: none');
  }

  // Determine tier
  let tier;
  if (score >= 4) tier = 'B';      // pass
  else if (score >= 2) tier = 'C'; // rejected
  else tier = 'D';                  // reject

  return { tier, score, reason: reasons.join(' | '), bypass: false };
}

function logRejection(data, result) {
  try {
    fs.mkdirSync(path.dirname(REJECTION_LOG), { recursive: true });
    const entry = JSON.stringify({
      timestamp: new Date().toISOString(),
      name: data.name || 'unknown',
      tier: result.tier,
      score: result.score,
      reason: result.reason,
      source: data.source,
      data: { google_rating: data.google_rating, google_review_count: data.google_review_count,
              maps_business_status: data.maps_business_status, google_place_id: data.google_place_id }
    });
    fs.appendFileSync(REJECTION_LOG, entry + '\n');
  } catch (e) {
    console.error('[qual-gate] Failed to log rejection:', e.message);
  }
}

module.exports = { qualifyLead, logRejection };
