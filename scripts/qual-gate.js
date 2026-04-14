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
 *   score == 2-3 → C   → staging (hidden from main CRM view)
 *   score <= 1  → D    → rejected (log to file, return 422)
 *
 * Bypass (always approved):
 *   source = "manual" | "referral"
 *   kurtis_notes non-empty
 */

const fs   = require('fs');
const path = require('path');

const REJECTION_LOG = '/Users/kurtishon/clawd/logs/qual-rejections.jsonl';

function qualifyLead(data) {
  // Bypass for manual/referral entries
  const source = (data.source || '').toLowerCase();
  const kurtisNotes = (data.kurtis_notes || '').trim();
  if (source === 'manual' || source === 'referral' || kurtisNotes) {
    return { tier: 'A', score: 6, reason: 'manual/referral bypass', bypass: true };
  }

  let score = 0;
  const reasons = [];

  // Check 1: Maps existence + operational status
  const mapsStatus = (data.maps_business_status || '').toUpperCase();
  const hasPlaceId = !!(data.google_place_id || data.maps_place_id);
  if (hasPlaceId && mapsStatus === 'OPERATIONAL') {
    score += 2;
    reasons.push('Maps: operational');
  } else if (hasPlaceId) {
    reasons.push(`Maps: exists but status=${mapsStatus || 'unknown'}`);
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
  else if (score >= 2) tier = 'C'; // staging
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
