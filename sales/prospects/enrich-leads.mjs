#!/usr/bin/env node
/**
 * Lead Enrichment Script
 * Processes all lead files through the Apollo enrichment API
 * and imports high-quality leads to CRM.
 */

import fs from 'fs';
import path from 'path';

const API_BASE = 'https://sales.kandedash.com/api/apollo';
const API_KEY = 'kande2026';
const PROSPECTS_DIR = '/Users/kurtishon/clawd/kande-vendtech/dashboard/sales/prospects';

// Stats tracking
const stats = {
  totalLeads: 0,
  leadsProcessed: 0,
  leadsSkipped: 0,
  emailsFound: 0,
  phonesFound: 0,
  titlesFound: 0,
  apiErrors: 0,
  importedToCRM: 0,
  enrichmentDetails: [],
  crmImports: [],
  fileStats: {}
};

// Domain mapping for known companies
const DOMAIN_MAP = {
  'westcorp management group': 'westcorpmg.com',
  'ovation development corporation': 'ovationco.com',
  'stout management company': 'smc-lv.com',
  'chamberlin & associates': 'ca-mgmt.com',
  'university medical center': 'umcsn.com',
  'henderson hospital': 'hendersonhospital.com',
  'valley health system': 'uhsinc.com',
  'centennial hills hospital': 'centennialhillshospital.com',
  'summerlin hospital': 'summerlinmedcenter.com',
  'spring valley hospital': 'springvalleyhospital.com',
  'west henderson hospital': 'westhendersonhospital.com',
  'sunrise hospital': 'sunrisehospital.com',
  'mountainview hospital': 'mountainview-hospital.com',
  'southern hills hospital': 'southernhillshospital.com',
  'dignity health': 'dignityhealth.org',
  'seven hills behavioral': 'acadiahealthcare.com',
  'davita': 'davita.com',
  'cbre': 'cbre.com',
  'gatski commercial': 'gatskicommercial.com',
  'american nevada': 'americannevada.com',
  'prologis': 'prologis.com',
  'colliers': 'colliers.com',
  'cushman & wakefield': 'cushwake.com',
  'telus': 'telusinternational.com',
  'lincoln harris': 'lincolnharris.com',
  'amazon': 'amazon.com',
  'fedex': 'fedex.com',
  'ups': 'ups.com',
  't-mobile': 't-mobile.com',
  'zappos': 'zappos.com',
  'igt': 'igt.com',
  'scientific games': 'scientificgames.com',
  'rimini street': 'riministreet.com',
  'draftkings': 'draftkings.com',
  'nv energy': 'nvenergy.com',
  'southwest gas': 'swgas.com',
  'allegiant air': 'allegiantair.com',
  'freedom forever': 'freedomforever.com',
  'walmart': 'walmart.com',
  'boring company': 'boringcompany.com',
  'ahern rentals': 'ahern.com',
  'ges global': 'ges.com',
  'knoah solutions': 'knoah.com',
  'mark iv capital': 'markivcapital.com',
  'anchor health': 'anchorhp.com',
  'life care centers': 'lcca.com',
  'cascade living': 'cascadeliving.com',
  'marquis companies': 'marquiscompanies.com',
  'neurorestorative': 'neurorestorative.com',
  'helix electric': 'helixelectric.com',
  'las vegas paving': 'lvpaving.com',
  'sunrise senior living': 'sunriseseniorliving.com',
};

function getDomain(company) {
  if (!company) return '';
  const lower = company.toLowerCase();
  for (const [key, domain] of Object.entries(DOMAIN_MAP)) {
    if (lower.includes(key)) return domain;
  }
  // Try to extract from website field or generate from company name
  return '';
}

function extractNames(fullName) {
  if (!fullName) return { first: '', last: '' };
  // Skip generic titles
  if (fullName === 'Property Manager' || fullName === 'Administrator' || 
      fullName.startsWith('Director of') || fullName.startsWith('Nevada Central') ||
      fullName.includes('General Contact') || fullName.includes('(via ') ||
      fullName.includes('(open position)') || fullName.includes('(hiring)')) {
    return { first: '', last: '' };
  }
  
  const parts = fullName.replace(/,.*$/, '').trim().split(/\s+/);
  if (parts.length === 1) return { first: parts[0], last: '' };
  
  // Handle single-letter last names (e.g., "Paula B.", "Greg H.")
  const last = parts[parts.length - 1].replace(/\.$/, '');
  if (last.length <= 2 && parts.length === 2) {
    return { first: parts[0], last: last };
  }
  
  return {
    first: parts[0],
    last: parts.slice(1).join(' ')
  };
}

async function enrichLead(firstName, lastName, orgName, domain) {
  const body = {
    first_name: firstName,
    last_name: lastName,
    organization_name: orgName,
  };
  if (domain) body.domain = domain;

  try {
    const resp = await fetch(`${API_BASE}/enrich`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY
      },
      body: JSON.stringify(body)
    });
    
    if (!resp.ok) {
      const text = await resp.text();
      console.error(`  API error ${resp.status}: ${text.substring(0, 200)}`);
      stats.apiErrors++;
      return null;
    }
    
    const data = await resp.json();
    return data;
  } catch (err) {
    console.error(`  Fetch error: ${err.message}`);
    stats.apiErrors++;
    return null;
  }
}

async function importToCRM(leads) {
  try {
    const resp = await fetch(`${API_BASE}/import-to-crm`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY
      },
      body: JSON.stringify({ leads })
    });
    
    if (!resp.ok) {
      const text = await resp.text();
      console.error(`CRM import error ${resp.status}: ${text.substring(0, 200)}`);
      return null;
    }
    
    return await resp.json();
  } catch (err) {
    console.error(`CRM import fetch error: ${err.message}`);
    return null;
  }
}

// ============ FILE PROCESSORS ============

async function processApartments(filePath) {
  console.log('\n📦 Processing: Apartments leads...');
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const leads = data.leads || [];
  let fileEmailsFound = 0, filePhonesFound = 0, fileProcessed = 0;
  
  for (const lead of leads) {
    stats.totalLeads++;
    const { first, last } = extractNames(lead.name);
    
    // Skip generic contacts or leads that already have personal email
    if (!first || !last || last.length <= 2) {
      console.log(`  ⏭ Skipping "${lead.name}" - insufficient name data`);
      stats.leadsSkipped++;
      continue;
    }
    
    // Skip if already has a non-generic email
    if (lead.email && !lead.email.startsWith('info@') && !lead.email.startsWith('contact@')) {
      console.log(`  ✅ "${lead.name}" already has email: ${lead.email}`);
      stats.leadsSkipped++;
      continue;
    }
    
    const domain = getDomain(lead.company);
    console.log(`  🔍 Enriching: ${first} ${last} @ ${lead.company} (${domain || 'no domain'})`);
    
    const result = await enrichLead(first, last, lead.company, domain);
    fileProcessed++;
    stats.leadsProcessed++;
    
    if (result && result.person) {
      const p = result.person;
      if (p.email) {
        lead.email = p.email;
        lead.email_status = 'verified_apollo';
        stats.emailsFound++;
        fileEmailsFound++;
        console.log(`    ✅ Email found: ${p.email}`);
      }
      if (p.phone_numbers && p.phone_numbers.length > 0 && !lead.phone) {
        lead.phone = p.phone_numbers[0].sanitized_number || p.phone_numbers[0].raw_number;
        stats.phonesFound++;
        filePhonesFound++;
        console.log(`    📞 Phone found: ${lead.phone}`);
      }
      if (p.title) {
        lead.title_verified = p.title;
        stats.titlesFound++;
      }
      if (p.linkedin_url) {
        lead.linkedin = p.linkedin_url;
      }
      lead.apollo_enriched = true;
      lead.enriched_at = new Date().toISOString();
      
      stats.enrichmentDetails.push({
        name: lead.name,
        company: lead.company,
        email: p.email || null,
        phone: p.phone_numbers?.[0]?.sanitized_number || null,
        file: 'apartments'
      });
    } else if (result && result.email) {
      // Some APIs return email directly
      lead.email = result.email;
      lead.email_status = 'verified_apollo';
      stats.emailsFound++;
      fileEmailsFound++;
      lead.apollo_enriched = true;
      lead.enriched_at = new Date().toISOString();
      console.log(`    ✅ Email found: ${result.email}`);
      
      stats.enrichmentDetails.push({
        name: lead.name,
        company: lead.company,
        email: result.email,
        phone: null,
        file: 'apartments'
      });
    } else {
      console.log(`    ❌ No enrichment data found`);
      lead.apollo_enriched = false;
      lead.enriched_at = new Date().toISOString();
    }
    
    // Rate limit: 200ms between requests
    await new Promise(r => setTimeout(r, 200));
  }
  
  // Save back
  data._metadata.enrichment_run = new Date().toISOString();
  data._metadata.apollo_enriched_count = leads.filter(l => l.apollo_enriched).length;
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  
  stats.fileStats.apartments = { total: leads.length, processed: fileProcessed, emailsFound: fileEmailsFound, phonesFound: filePhonesFound };
  console.log(`  📊 Apartments: ${fileProcessed} processed, ${fileEmailsFound} emails found, ${filePhonesFound} phones found`);
  
  return leads.filter(l => l.email && l.email_status === 'verified_apollo');
}

async function processHealthcare(filePath) {
  console.log('\n🏥 Processing: Healthcare leads...');
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const prospects = data.prospects || [];
  let fileEmailsFound = 0, filePhonesFound = 0, fileProcessed = 0;
  
  for (const lead of prospects) {
    stats.totalLeads++;
    const { first, last } = extractNames(lead.contact_name);
    
    if (!first || !last || last.length <= 2) {
      console.log(`  ⏭ Skipping "${lead.contact_name}" - insufficient name data`);
      stats.leadsSkipped++;
      continue;
    }
    
    // Skip already verified
    if (lead.email && lead.email_status === 'verified') {
      console.log(`  ✅ "${lead.contact_name}" already verified: ${lead.email}`);
      stats.leadsSkipped++;
      continue;
    }
    
    const domain = getDomain(lead.company);
    console.log(`  🔍 Enriching: ${first} ${last} @ ${lead.company} (${domain || 'no domain'})`);
    
    const result = await enrichLead(first, last, lead.company, domain);
    fileProcessed++;
    stats.leadsProcessed++;
    
    if (result && result.person) {
      const p = result.person;
      if (p.email) {
        lead.email = p.email;
        lead.email_status = 'verified_apollo';
        stats.emailsFound++;
        fileEmailsFound++;
        console.log(`    ✅ Email found: ${p.email}`);
      }
      if (p.phone_numbers && p.phone_numbers.length > 0 && !lead.phone) {
        lead.phone = p.phone_numbers[0].sanitized_number || p.phone_numbers[0].raw_number;
        stats.phonesFound++;
        filePhonesFound++;
        console.log(`    📞 Phone found: ${lead.phone}`);
      }
      if (p.title) lead.title_verified = p.title;
      if (p.linkedin_url) lead.linkedin = p.linkedin_url;
      lead.apollo_enriched = true;
      lead.enriched_at = new Date().toISOString();
      
      stats.enrichmentDetails.push({
        name: lead.contact_name,
        company: lead.company,
        email: p.email || null,
        phone: p.phone_numbers?.[0]?.sanitized_number || null,
        file: 'healthcare'
      });
    } else if (result && result.email) {
      lead.email = result.email;
      lead.email_status = 'verified_apollo';
      stats.emailsFound++;
      fileEmailsFound++;
      lead.apollo_enriched = true;
      lead.enriched_at = new Date().toISOString();
      console.log(`    ✅ Email found: ${result.email}`);
      
      stats.enrichmentDetails.push({
        name: lead.contact_name,
        company: lead.company,
        email: result.email,
        phone: null,
        file: 'healthcare'
      });
    } else {
      console.log(`    ❌ No enrichment data found`);
      lead.apollo_enriched = false;
      lead.enriched_at = new Date().toISOString();
    }
    
    await new Promise(r => setTimeout(r, 200));
  }
  
  data.enrichment_run = new Date().toISOString();
  data.apollo_enriched_count = prospects.filter(p => p.apollo_enriched).length;
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  
  stats.fileStats.healthcare = { total: prospects.length, processed: fileProcessed, emailsFound: fileEmailsFound, phonesFound: filePhonesFound };
  console.log(`  📊 Healthcare: ${fileProcessed} processed, ${fileEmailsFound} emails found, ${filePhonesFound} phones found`);
  
  return prospects.filter(p => p.email && (p.email_status === 'verified_apollo' || p.email_status === 'verified'));
}

async function processCommercial(filePath) {
  console.log('\n🏢 Processing: Commercial leads...');
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const prospects = data.prospects || [];
  let fileEmailsFound = 0, filePhonesFound = 0, fileProcessed = 0;
  
  for (const lead of prospects) {
    stats.totalLeads++;
    const { first, last } = extractNames(lead.contact_name);
    
    if (!first || !last || last.length <= 2) {
      console.log(`  ⏭ Skipping "${lead.contact_name}" - insufficient name data`);
      stats.leadsSkipped++;
      continue;
    }
    
    // Skip direct_found emails (already confirmed)
    if (lead.email && lead.email_verification === 'direct_found') {
      console.log(`  ✅ "${lead.contact_name}" already direct_found: ${lead.email}`);
      stats.leadsSkipped++;
      continue;
    }
    
    // Still try to verify pattern_derived emails
    const domain = getDomain(lead.company);
    console.log(`  🔍 Enriching: ${first} ${last} @ ${lead.company} (${domain || 'no domain'})`);
    
    const result = await enrichLead(first, last, lead.company, domain);
    fileProcessed++;
    stats.leadsProcessed++;
    
    if (result && result.person) {
      const p = result.person;
      if (p.email) {
        lead.email = p.email;
        lead.email_verification = 'verified_apollo';
        lead.email_pattern_confidence = '100%';
        stats.emailsFound++;
        fileEmailsFound++;
        console.log(`    ✅ Email found: ${p.email}`);
      }
      if (p.phone_numbers && p.phone_numbers.length > 0 && !lead.phone) {
        lead.phone = p.phone_numbers[0].sanitized_number || p.phone_numbers[0].raw_number;
        stats.phonesFound++;
        filePhonesFound++;
        console.log(`    📞 Phone found: ${lead.phone}`);
      }
      if (p.title) lead.title_verified = p.title;
      if (p.linkedin_url && !lead.linkedin) lead.linkedin = p.linkedin_url;
      lead.apollo_enriched = true;
      lead.enriched_at = new Date().toISOString();
      
      stats.enrichmentDetails.push({
        name: lead.contact_name,
        company: lead.company,
        email: p.email || null,
        phone: p.phone_numbers?.[0]?.sanitized_number || null,
        file: 'commercial'
      });
    } else if (result && result.email) {
      lead.email = result.email;
      lead.email_verification = 'verified_apollo';
      lead.email_pattern_confidence = '100%';
      stats.emailsFound++;
      fileEmailsFound++;
      lead.apollo_enriched = true;
      lead.enriched_at = new Date().toISOString();
      console.log(`    ✅ Email found: ${result.email}`);
      
      stats.enrichmentDetails.push({
        name: lead.contact_name,
        company: lead.company,
        email: result.email,
        phone: null,
        file: 'commercial'
      });
    } else {
      console.log(`    ❌ No enrichment data found`);
      lead.apollo_enriched = false;
      lead.enriched_at = new Date().toISOString();
    }
    
    await new Promise(r => setTimeout(r, 200));
  }
  
  data.enrichment_run = new Date().toISOString();
  data.apollo_enriched_count = prospects.filter(p => p.apollo_enriched).length;
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  
  stats.fileStats.commercial = { total: prospects.length, processed: fileProcessed, emailsFound: fileEmailsFound, phonesFound: filePhonesFound };
  console.log(`  📊 Commercial: ${fileProcessed} processed, ${fileEmailsFound} emails found, ${filePhonesFound} phones found`);
  
  return prospects.filter(p => p.email && (p.email_verification === 'verified_apollo' || p.email_verification === 'direct_found'));
}

async function processHighTraffic(filePath) {
  console.log('\n🚀 Processing: High Traffic leads...');
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const leads = data.leads || [];
  let fileEmailsFound = 0, filePhonesFound = 0, fileProcessed = 0;
  
  for (const lead of leads) {
    stats.totalLeads++;
    const contact = lead.contact || {};
    const { first, last } = extractNames(contact.name);
    
    if (!first || !last || last.length <= 2) {
      console.log(`  ⏭ Skipping "${contact.name || lead.company}" - insufficient name data`);
      stats.leadsSkipped++;
      continue;
    }
    
    // Skip if already has email
    if (contact.email) {
      console.log(`  ✅ "${contact.name}" already has email: ${contact.email}`);
      stats.leadsSkipped++;
      continue;
    }
    
    const domain = getDomain(lead.company);
    console.log(`  🔍 Enriching: ${first} ${last} @ ${lead.company} (${domain || 'no domain'})`);
    
    const result = await enrichLead(first, last, lead.company, domain);
    fileProcessed++;
    stats.leadsProcessed++;
    
    if (result && result.person) {
      const p = result.person;
      if (p.email) {
        contact.email = p.email;
        contact.email_status = 'verified_apollo';
        stats.emailsFound++;
        fileEmailsFound++;
        console.log(`    ✅ Email found: ${p.email}`);
      }
      if (p.phone_numbers && p.phone_numbers.length > 0 && !contact.phone) {
        contact.phone = p.phone_numbers[0].sanitized_number || p.phone_numbers[0].raw_number;
        stats.phonesFound++;
        filePhonesFound++;
        console.log(`    📞 Phone found: ${contact.phone}`);
      }
      if (p.title) contact.title_verified = p.title;
      if (p.linkedin_url && !contact.linkedin) contact.linkedin = p.linkedin_url;
      contact.apollo_enriched = true;
      contact.enriched_at = new Date().toISOString();
      
      stats.enrichmentDetails.push({
        name: contact.name,
        company: lead.company,
        email: p.email || null,
        phone: p.phone_numbers?.[0]?.sanitized_number || null,
        file: 'high-traffic'
      });
    } else if (result && result.email) {
      contact.email = result.email;
      contact.email_status = 'verified_apollo';
      stats.emailsFound++;
      fileEmailsFound++;
      contact.apollo_enriched = true;
      contact.enriched_at = new Date().toISOString();
      console.log(`    ✅ Email found: ${result.email}`);
      
      stats.enrichmentDetails.push({
        name: contact.name,
        company: lead.company,
        email: result.email,
        phone: null,
        file: 'high-traffic'
      });
    } else {
      console.log(`    ❌ No enrichment data found`);
      contact.apollo_enriched = false;
      contact.enriched_at = new Date().toISOString();
    }
    
    await new Promise(r => setTimeout(r, 200));
  }
  
  data.metadata.enrichment_run = new Date().toISOString();
  data.metadata.apollo_enriched_count = leads.filter(l => l.contact?.apollo_enriched).length;
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  
  stats.fileStats.highTraffic = { total: leads.length, processed: fileProcessed, emailsFound: fileEmailsFound, phonesFound: filePhonesFound };
  console.log(`  📊 High Traffic: ${fileProcessed} processed, ${fileEmailsFound} emails found, ${filePhonesFound} phones found`);
  
  return leads.filter(l => l.contact?.email && l.contact?.email_status === 'verified_apollo').map(l => ({
    name: l.contact.name,
    company: l.company,
    email: l.contact.email,
    phone: l.contact.phone
  }));
}

// ============ MAIN ============

async function main() {
  console.log('🚀 Lead Enrichment Script Starting...');
  console.log(`📅 ${new Date().toISOString()}`);
  console.log(`🔗 API: ${API_BASE}/enrich`);
  console.log('='.repeat(60));

  const crmCandidates = [];
  
  // Process all four files
  const aptLeads = await processApartments(path.join(PROSPECTS_DIR, 'leads-apartments-new.json'));
  crmCandidates.push(...aptLeads.map(l => ({ name: l.name, company: l.company, email: l.email, phone: l.phone, title: l.title, segment: 'apartments' })));

  const hcLeads = await processHealthcare(path.join(PROSPECTS_DIR, 'leads-healthcare-new.json'));
  crmCandidates.push(...hcLeads.map(l => ({ name: l.contact_name, company: l.company, email: l.email, phone: l.phone, title: l.contact_title, segment: 'healthcare' })));

  const comLeads = await processCommercial(path.join(PROSPECTS_DIR, 'leads-commercial-new.json'));
  crmCandidates.push(...comLeads.map(l => ({ name: l.contact_name, company: l.company, email: l.email, phone: l.phone, title: l.title, segment: 'commercial' })));

  const htLeads = await processHighTraffic(path.join(PROSPECTS_DIR, 'leads-high-traffic-new.json'));
  crmCandidates.push(...htLeads.map(l => ({ ...l, segment: 'high-traffic' })));

  // Import to CRM
  console.log('\n='.repeat(60));
  console.log(`📤 Importing ${crmCandidates.length} leads with verified emails to CRM...`);
  
  if (crmCandidates.length > 0) {
    const importResult = await importToCRM(crmCandidates);
    if (importResult) {
      stats.importedToCRM = importResult.imported || importResult.count || crmCandidates.length;
      stats.crmImports = crmCandidates;
      console.log(`  ✅ CRM import complete: ${stats.importedToCRM} leads imported`);
      if (importResult.message) console.log(`  📝 ${importResult.message}`);
    } else {
      console.log('  ⚠️ CRM import returned no result (API may not be active)');
      stats.importedToCRM = 0;
    }
  }

  // Generate report
  console.log('\n='.repeat(60));
  console.log('📊 ENRICHMENT SUMMARY');
  console.log(`Total leads across all files: ${stats.totalLeads}`);
  console.log(`Leads processed (API calls): ${stats.leadsProcessed}`);
  console.log(`Leads skipped (already enriched/generic): ${stats.leadsSkipped}`);
  console.log(`Emails found: ${stats.emailsFound}`);
  console.log(`Phones found: ${stats.phonesFound}`);
  console.log(`API errors: ${stats.apiErrors}`);
  console.log(`Imported to CRM: ${stats.importedToCRM}`);

  // Write report
  const report = generateReport();
  fs.writeFileSync(path.join(PROSPECTS_DIR, 'enrichment-report.md'), report);
  console.log(`\n📄 Report saved to: ${PROSPECTS_DIR}/enrichment-report.md`);
  
  // Also write stats JSON for programmatic access
  fs.writeFileSync(path.join(PROSPECTS_DIR, 'enrichment-stats.json'), JSON.stringify(stats, null, 2));
}

function generateReport() {
  const now = new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' });
  
  let report = `# Lead Enrichment Report
**Date:** ${now}  
**API:** Apollo Enrichment via sales.kandedash.com

---

## Summary

| Metric | Count |
|--------|-------|
| Total Leads (all files) | ${stats.totalLeads} |
| Leads Processed (API calls) | ${stats.leadsProcessed} |
| Leads Skipped | ${stats.leadsSkipped} |
| **Emails Found** | **${stats.emailsFound}** |
| **Phones Found** | **${stats.phonesFound}** |
| Titles Verified | ${stats.titlesFound} |
| API Errors | ${stats.apiErrors} |
| **Imported to CRM** | **${stats.importedToCRM}** |

## Per-File Breakdown

`;

  for (const [file, s] of Object.entries(stats.fileStats)) {
    report += `### ${file.charAt(0).toUpperCase() + file.slice(1)}
- Total leads: ${s.total}
- Processed: ${s.processed}
- Emails found: ${s.emailsFound}
- Phones found: ${s.phonesFound}

`;
  }

  if (stats.enrichmentDetails.length > 0) {
    report += `## Enrichment Results

| Name | Company | Email | Phone | File |
|------|---------|-------|-------|------|
`;
    for (const d of stats.enrichmentDetails) {
      report += `| ${d.name} | ${d.company} | ${d.email || '—'} | ${d.phone || '—'} | ${d.file} |\n`;
    }
  }

  if (stats.crmImports.length > 0) {
    report += `\n## CRM Imports (${stats.crmImports.length} leads)

| Name | Company | Email | Segment |
|------|---------|-------|---------|
`;
    for (const c of stats.crmImports) {
      report += `| ${c.name} | ${c.company} | ${c.email} | ${c.segment} |\n`;
    }
  }

  report += `
---

## Notes
- Leads with generic emails (info@, contact@) were sent to Apollo for personal email lookup
- Pattern-derived emails from commercial file were also verified through Apollo
- Leads without sufficient name data (generic titles, initials-only last names) were skipped
- Rate limited at 200ms between API calls
- All enriched files have been saved back with \`apollo_enriched\` and \`enriched_at\` fields
`;

  return report;
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
