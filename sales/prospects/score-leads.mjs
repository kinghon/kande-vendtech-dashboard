#!/usr/bin/env node
/**
 * PEOPLE Priority Scoring
 * Applies Skool-derived PEOPLE criteria to all lead files.
 *
 * HIGH: 100+ employees/units, 24/7 ops, new builds, portfolio managers
 * MEDIUM: 50-100 employees/units, standard hours, single location
 * LOW: <50 employees, remote/hybrid, entrenched vendor noted
 */

import fs from 'fs';
import path from 'path';

const DIR = '/Users/kurtishon/clawd/kande-vendtech/dashboard/sales/prospects';

// ---- signal detectors ----

const H24_PATTERNS = /24\/7|multi.?shift|overnight|all shifts|rotating shift|night shift|captive|trauma|emergency|ER |hospital|dialysis|dispatch/i;
const NEW_BUILD = /new.?build|new facility|newest|opened 202[3-6]|no.?vendor|no entrenched|recently|new construction|lease.?up/i;
const PORTFOLIO = /corporate|portfolio|regional|multiple (properties|communities|locations|buildings|centers)|system.?wide|100\+? communit|manages? .*(all|multiple|35\+|36\+|10\+|6\+|15\+|3 campus|all .* hospitals)/i;
const ENTRENCHED = /existing (national |corporate )?vendor|already has .* vending|locked.?in|monopol|national contract|entrenched/i;
const REMOTE_HYBRID = /remote|hybrid|work from home/i;

function extractSize(lead) {
  // Try various fields for a numeric size — take the LARGEST value found
  const candidates = [
    lead.units, lead.employee_count, lead.bed_count,
    lead.enrollment, lead.onCampusResidents,
    lead.contact?.employee_count,
  ];
  let best = 0;
  for (const c of candidates) {
    if (!c) continue;
    // handle "20-40", "500+", "3000-4000", "800-1200"
    const str = String(c).replace(/[,]/g, '');
    const parts = str.match(/\d+/g);
    if (parts) {
      // Use the largest number (e.g., "800-1200" → 1200)
      const max = Math.max(...parts.map(Number));
      if (max > best) best = max;
    }
  }
  if (best > 0) return best;
  // Fallback: scan all text for employee/unit mentions
  const blob = JSON.stringify(lead);
  const matches = blob.matchAll(/(\d{2,6})\+?\s*(?:employees|units|beds|students|workers|staff|rooms|members|centers|locations|facilities|properties|communit)/gi);
  for (const m of matches) {
    const n = parseInt(m[1]);
    if (n > best) best = n;
  }
  return best;
}

// Chain/portfolio leverage detection: if the notes mention the parent chain
// has many locations, the contact is a gateway to scale.
const CHAIN_LEVERAGE = /(\d{2,4})\+?\s*(?:centers|locations|facilities|properties)/i;
function detectChainScale(blob) {
  const m = blob.match(CHAIN_LEVERAGE);
  return m ? parseInt(m[1]) : 0;
}

function buildBlob(lead) {
  // Flatten all text fields into one string for pattern matching
  return JSON.stringify(lead);
}

function score(lead) {
  const size = extractSize(lead);
  const blob = buildBlob(lead);

  let highSignals = 0;
  let lowSignals = 0;
  const reasons = [];

  // Chain scale (e.g., "15+ centers", "200+ locations")
  const chainScale = detectChainScale(blob);

  // --- HIGH signals ---
  if (size >= 100) { highSignals++; reasons.push(`${size}+ people/units`); }
  if (H24_PATTERNS.test(blob)) { highSignals++; reasons.push('24/7 or captive audience'); }
  if (NEW_BUILD.test(blob)) { highSignals++; reasons.push('new build / no vendor'); }
  if (PORTFOLIO.test(blob)) { highSignals++; reasons.push('portfolio / multi-property leverage'); }
  if (chainScale >= 10) { highSignals++; reasons.push(`chain gateway (${chainScale}+ locations)`); }

  // --- LOW signals ---
  if (size > 0 && size < 50 && chainScale < 5) { lowSignals++; reasons.push(`small (<50): ${size}`); }
  if (REMOTE_HYBRID.test(blob)) { lowSignals++; reasons.push('remote/hybrid workforce'); }
  if (ENTRENCHED.test(blob)) { lowSignals++; reasons.push('entrenched vendor noted'); }

  // --- Decision ---
  let priority;
  if (lowSignals >= 2) {
    priority = 'low';
  } else if (highSignals >= 2) {
    priority = 'high';
  } else if (highSignals === 1 && lowSignals === 0) {
    priority = 'high';
  } else if (size >= 50 || highSignals === 1) {
    priority = 'medium';
  } else if (size > 0 && size < 50 && chainScale < 5) {
    priority = 'low';
  } else {
    // No size info — default medium unless other signals
    priority = lowSignals > 0 ? 'low' : 'medium';
  }

  // Sub-score within HIGH for enrichment ordering (higher = enrich first)
  let enrichScore = 0;
  if (priority === 'high') {
    enrichScore += Math.min(size / 100, 50);          // up to 50 pts for size
    enrichScore += highSignals * 10;                   // 10 pts per HIGH signal
    enrichScore += chainScale >= 10 ? 20 : 0;         // 20 pts for chain gateway
    if (NEW_BUILD.test(blob)) enrichScore += 15;       // 15 bonus for new builds
    if (lead.email && !lead.email.startsWith('info@')) enrichScore += 5; // 5 pts if has email
  }

  return { priority, reasons, size, highSignals, lowSignals, enrichScore };
}

// ---- processors per file shape ----

function applyScore(lead, s) {
  lead.priority = s.priority;
  lead.priority_reasons = s.reasons;
  if (s.priority === 'high') lead.enrich_score = Math.round(s.enrichScore);
}

function processApartments(filePath) {
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const counts = { high: 0, medium: 0, low: 0 };
  for (const lead of data.leads) { const s = score(lead); applyScore(lead, s); counts[s.priority]++; }
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  return { file: 'apartments', total: data.leads.length, ...counts };
}

function processHealthcare(filePath) {
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const counts = { high: 0, medium: 0, low: 0 };
  for (const lead of data.prospects) { const s = score(lead); applyScore(lead, s); counts[s.priority]++; }
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  return { file: 'healthcare', total: data.prospects.length, ...counts };
}

function processCommercial(filePath) {
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const counts = { high: 0, medium: 0, low: 0 };
  for (const lead of data.prospects) { const s = score(lead); applyScore(lead, s); counts[s.priority]++; }
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  return { file: 'commercial', total: data.prospects.length, ...counts };
}

function processHighTraffic(filePath) {
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const counts = { high: 0, medium: 0, low: 0 };
  for (const lead of data.leads) { const s = score(lead); applyScore(lead, s); counts[s.priority]++; }
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  return { file: 'high-traffic', total: data.leads.length, ...counts };
}

function processCollegeDorms(filePath) {
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const counts = { high: 0, medium: 0, low: 0 };
  for (const lead of data) { const s = score(lead); applyScore(lead, s); counts[s.priority]++; }
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  return { file: 'college-dorms', total: data.length, ...counts };
}

// ---- main ----

const results = [];
results.push(processApartments(path.join(DIR, 'leads-apartments-new.json')));
results.push(processHealthcare(path.join(DIR, 'leads-healthcare-new.json')));
results.push(processCommercial(path.join(DIR, 'leads-commercial-new.json')));
results.push(processHighTraffic(path.join(DIR, 'leads-high-traffic-new.json')));
results.push(processCollegeDorms(path.join(DIR, 'college-dorms.json')));

let grandHigh = 0, grandMed = 0, grandLow = 0, grandTotal = 0;

console.log('📊 PEOPLE Priority Scoring Results\n');
console.log('File             | Total | HIGH | MED  | LOW');
console.log('-----------------|-------|------|------|-----');
for (const r of results) {
  grandHigh += r.high; grandMed += r.medium; grandLow += r.low; grandTotal += r.total;
  console.log(`${r.file.padEnd(17)}| ${String(r.total).padStart(5)} | ${String(r.high).padStart(4)} | ${String(r.medium).padStart(4)} | ${String(r.low).padStart(4)}`);
}
console.log('-----------------|-------|------|------|-----');
console.log(`${'TOTAL'.padEnd(17)}| ${String(grandTotal).padStart(5)} | ${String(grandHigh).padStart(4)} | ${String(grandMed).padStart(4)} | ${String(grandLow).padStart(4)}`);

// Spot-check: print scored leads sorted by enrichScore
console.log('\n--- Top 10 by Enrich Score (whales first) ---');
const allLeads = [];
for (const fp of ['leads-apartments-new.json','leads-healthcare-new.json','leads-commercial-new.json','leads-high-traffic-new.json','college-dorms.json']) {
  const d = JSON.parse(fs.readFileSync(path.join(DIR, fp), 'utf8'));
  const arr = d.leads || d.prospects || d;
  for (const l of arr) {
    allLeads.push({
      name: l.name || l.contact_name || l.contact?.name || l.company,
      company: l.company || l.organization_name || '',
      priority: l.priority,
      enrichScore: l.enrich_score || 0,
      reasons: l.priority_reasons || []
    });
  }
}
allLeads.sort((a, b) => b.enrichScore - a.enrichScore);
for (const l of allLeads.slice(0, 10)) {
  console.log(`  🟢 [${l.enrichScore}] ${l.name} (${l.company}) → ${l.reasons.join(', ')}`);
}

// Show MEDIUM and LOW
const meds = allLeads.filter(l => l.priority === 'medium');
const lows = allLeads.filter(l => l.priority === 'low');
if (meds.length) {
  console.log(`\n--- MEDIUM (${meds.length}) ---`);
  for (const m of meds) console.log(`  🟡 ${m.name} (${m.company}) → ${m.reasons.join(', ')}`);
}
if (lows.length) {
  console.log(`\n--- LOW (${lows.length}) ---`);
  for (const l of lows) console.log(`  🔴 ${l.name} (${l.company}) → ${l.reasons.join(', ')}`);
} else {
  console.log('\n  No LOW priority leads (all leads in these files were pre-qualified for size).');
}
