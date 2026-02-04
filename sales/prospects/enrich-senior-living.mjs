#!/usr/bin/env node
// Senior Living Lead Enrichment via Apollo API
// Finds decision-makers at senior living facilities in Las Vegas

const API_URL = 'https://sales.kandedash.com/api/apollo/enrich';
const API_KEY = 'kande2026';

const facilities = [
  { name: "Oakmont of The Lakes", domain: "oakmontseniorliving.com", address: "3250 S Fort Apache Rd, Las Vegas, NV 89117", type: "Assisted Living, Memory Care" },
  { name: "Atria Seville", domain: "atriaseniorliving.com", address: "2000 N Rampart Blvd, Las Vegas, NV 89128", type: "Assisted Living, Independent Living" },
  { name: "Merrill Gardens at Green Valley Ranch", domain: "merrillgardens.com", address: "1935 Paseo Verde Pkwy, Henderson, NV 89012", type: "Assisted Living, Independent Living" },
  { name: "MorningStar Senior Living", domain: "morningstarseniorliving.com", address: "490 S Hualapai Way, Las Vegas, NV 89145", type: "Assisted Living, Memory Care" },
  { name: "Silverado Red Rock Memory Care", domain: "silverado.com", address: "Las Vegas, NV", type: "Memory Care" },
  { name: "Legacy House of Southern Hills", domain: "legacyretire.com", address: "9750 W Sunset Rd, Las Vegas, NV 89148", type: "Assisted Living, Memory Care" },
  { name: "Legacy House of Centennial Hills", domain: "legacyretire.com", address: "6310 N Durango Dr, Las Vegas, NV 89149", type: "Assisted Living, Memory Care" },
  { name: "Life Care Center of Las Vegas", domain: "lcca.com", address: "6151 Vegas Dr, Las Vegas, NV", type: "Skilled Nursing, Rehab" },
  { name: "The Heights of Summerlin", domain: "theheightsofsummerlin.com", address: "Las Vegas, NV", type: "Skilled Nursing, Rehab" },
  { name: "Desert View Senior Living", domain: "desertviewseniorliving.com", address: "3890 N Buffalo Dr, Las Vegas, NV 89129", type: "Assisted Living" },
  { name: "Avamere at Cheyenne", domain: "avamere.com", address: "6031 Cheyenne Ave, Las Vegas, NV 89108", type: "Assisted Living" },
  { name: "Las Ventanas at Summerlin", domain: "lasventanas.com", address: "10401 W Charleston Blvd, Las Vegas, NV 89135", type: "Assisted Living, Independent Living, Memory Care, Nursing" },
  { name: "Escalante at the Lakes", domain: "esclantelakes.com", address: "2620 Lake Sahara Dr, Las Vegas, NV 89117", type: "Assisted Living, Memory Care" },
  { name: "Heritage Springs", domain: "heritagesprings.com", address: "8720 W Flamingo Rd, Las Vegas, NV 89147", type: "Assisted Living, Memory Care" },
  { name: "Desert Springs Senior Living", domain: "desertspringsseniorliving.com", address: "6650 W Flamingo Rd, Las Vegas, NV 89103", type: "55+, Assisted Living, Independent Living" },
  { name: "Acacia Springs", domain: "acaciasprings.com", address: "8630 W Nevso Dr, Las Vegas, NV 89147", type: "Assisted Living, Independent Living" },
  { name: "The Bridge at Paradise Valley", domain: "thebridgeatparadisevalley.com", address: "2205 E Harmon Ave, Las Vegas, NV 89119", type: "Assisted Living, Independent Living" },
  { name: "Pacifica Senior Living San Martin", domain: "pacificaseniorliving.com", address: "8374 W Capovilla Ave, Las Vegas, NV 89113", type: "Assisted Living, Independent Living, Memory Care" },
  { name: "Oakmont of Las Vegas", domain: "oakmontseniorliving.com", address: "3185 E Flamingo Rd, Las Vegas, NV 89121", type: "Assisted Living, Memory Care" },
  { name: "Brookdale Las Vegas", domain: "brookdale.com", address: "3025 E Russell Rd, Las Vegas, NV 89120", type: "Assisted Living, Nursing" },
  { name: "The Quail House Memory Care", domain: "thequailhouse.com", address: "3695 E Quail Ave, Las Vegas, NV 89120", type: "Memory Care" },
  { name: "Pacifica Senior Living Green Valley", domain: "pacificaseniorliving.com", address: "2620 Robindale Rd, Henderson, NV 89074", type: "Assisted Living, Memory Care" },
  { name: "Prestige Senior Living at Mira Loma", domain: "prestigecare.com", address: "2520 Wigwam Pkwy, Henderson, NV 89074", type: "Assisted Living, Memory Care" },
  { name: "Truewood by Merrill Henderson", domain: "merrillgardens.com", address: "2910 W Horizon Ridge Pkwy, Henderson, NV 89052", type: "Assisted Living, Independent Living, Memory Care" },
  { name: "Sunrise of Henderson", domain: "sunriseseniorliving.com", address: "1555 W Horizon Ridge Pkwy, Henderson, NV 89012", type: "Assisted Living, Memory Care" },
  { name: "Sterling Ridge Senior Living", domain: "sterlingridgeseniorliving.com", address: "Las Vegas, NV", type: "Independent Living, Assisted Living, Memory Care" },
  { name: "Marquis Care at Centennial Hills", domain: "marquiscompanies.com", address: "Las Vegas, NV", type: "Skilled Nursing, Rehab" },
  { name: "Mountain View Care Center", domain: "mountainviewcarecenter.com", address: "Las Vegas, NV", type: "Skilled Nursing" },
  { name: "Silver Ridge Healthcare Center", domain: "silverridgehealthcare.com", address: "Las Vegas, NV", type: "Skilled Nursing" },
  { name: "Coronado Ridge Skilled Nursing", domain: "coronadoridge.com", address: "Las Vegas, NV", type: "Skilled Nursing, Rehab" },
  { name: "Advanced Health Care of Paradise", domain: "advancedhealthcare.com", address: "Las Vegas, NV", type: "Skilled Nursing" },
  { name: "Villa Court Assisted Living", domain: "villacourtlv.com", address: "3985 S Pearl St, Las Vegas, NV 89121", type: "Assisted Living" },
  { name: "Oakey Assisted Living", domain: "oakeyassistedliving.com", address: "3900 W Oakey Blvd, Las Vegas, NV 89102", type: "Assisted Living" },
  { name: "Lakeview Terrace of Boulder City", domain: "lakeviewterrace.com", address: "Boulder City, NV", type: "CCRC, Independent Living, Assisted Living" },
  { name: "Serenity Living for Seniors", domain: "serenitylivingforseniors.com", address: "Las Vegas, NV", type: "Assisted Living" },
];

// Target titles for decision-makers
const targetTitles = [
  "Executive Director",
  "Administrator", 
  "Director of Dining Services",
  "Facilities Manager",
  "Director of Operations",
  "General Manager",
  "Regional Director",
  "Director of Food Services",
  "Director of Environmental Services",
  "Dining Services Manager",
  "Plant Operations Director",
  "Director of Plant Operations",
  "Food Service Director",
  "Building Manager",
  "Operations Manager"
];

async function enrichFacility(facility) {
  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY
      },
      body: JSON.stringify({
        domain: facility.domain,
        organization_name: facility.name,
        title_keywords: targetTitles,
        location: "Las Vegas, Nevada"
      })
    });
    
    if (!response.ok) {
      console.error(`  ❌ API error for ${facility.name}: ${response.status} ${response.statusText}`);
      const text = await response.text();
      console.error(`  Response: ${text.substring(0, 200)}`);
      return { facility, contacts: [], error: `HTTP ${response.status}` };
    }
    
    const data = await response.json();
    return { facility, data, contacts: data.contacts || data.people || [], error: null };
  } catch (err) {
    console.error(`  ❌ Error enriching ${facility.name}: ${err.message}`);
    return { facility, contacts: [], error: err.message };
  }
}

async function main() {
  console.log(`\n🏥 Senior Living Lead Enrichment`);
  console.log(`📋 Processing ${facilities.length} facilities...\n`);
  
  const allLeads = [];
  const errors = [];
  
  for (let i = 0; i < facilities.length; i++) {
    const facility = facilities[i];
    console.log(`[${i+1}/${facilities.length}] Enriching: ${facility.name} (${facility.domain})`);
    
    const result = await enrichFacility(facility);
    
    if (result.error) {
      errors.push({ facility: facility.name, error: result.error });
      console.log(`  ⚠️ Error: ${result.error}`);
    }
    
    // Extract contacts from various response formats
    let contacts = [];
    if (result.data) {
      // Handle different API response structures
      if (result.data.people) contacts = result.data.people;
      else if (result.data.contacts) contacts = result.data.contacts;
      else if (result.data.results) contacts = result.data.results;
      else if (Array.isArray(result.data)) contacts = result.data;
    }
    
    // Filter for verified emails and relevant titles
    const verified = contacts.filter(c => {
      const hasEmail = c.email && c.email !== '' && !c.email.includes('placeholder');
      const emailVerified = c.email_status === 'verified' || c.email_confidence === 'high' || 
                           c.email_verified === true || (hasEmail && !c.email_status);
      return hasEmail;
    });
    
    for (const contact of verified) {
      allLeads.push({
        facilityName: facility.name,
        facilityType: facility.type,
        facilityAddress: facility.address,
        facilityDomain: facility.domain,
        firstName: contact.first_name || contact.firstName || '',
        lastName: contact.last_name || contact.lastName || '',
        title: contact.title || contact.job_title || '',
        email: contact.email || '',
        emailConfidence: contact.email_status || contact.email_confidence || 'unknown',
        phone: contact.phone || contact.phone_number || contact.direct_phone || '',
        linkedinUrl: contact.linkedin_url || contact.linkedin || '',
        source: 'apollo',
        enrichedAt: new Date().toISOString(),
        vendingScore: calculateVendingScore(facility),
        vendingNotes: getVendingNotes(facility)
      });
    }
    
    console.log(`  ✅ Found ${verified.length} contacts with emails (${contacts.length} total)`);
    
    // Rate limit: wait 1.5s between requests
    if (i < facilities.length - 1) {
      await new Promise(r => setTimeout(r, 1500));
    }
  }
  
  // Deduplicate by email
  const seen = new Set();
  const uniqueLeads = allLeads.filter(lead => {
    if (seen.has(lead.email.toLowerCase())) return false;
    seen.add(lead.email.toLowerCase());
    return true;
  });
  
  // Sort by vending score
  uniqueLeads.sort((a, b) => b.vendingScore - a.vendingScore);
  
  const output = {
    metadata: {
      category: "Senior Living & Assisted Care",
      region: "Las Vegas, NV Metro",
      generatedAt: new Date().toISOString(),
      totalFacilities: facilities.length,
      totalLeads: uniqueLeads.length,
      enrichmentSource: "Apollo via KandeDash API",
      errors: errors.length
    },
    leads: uniqueLeads
  };
  
  const outputPath = '/Users/kurtishon/clawd/kande-vendtech/dashboard/sales/prospects/leads-senior-living.json';
  const fs = await import('fs');
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
  
  console.log(`\n📊 RESULTS SUMMARY`);
  console.log(`==================`);
  console.log(`Facilities processed: ${facilities.length}`);
  console.log(`Total unique leads: ${uniqueLeads.length}`);
  console.log(`Errors: ${errors.length}`);
  console.log(`Output: ${outputPath}`);
  
  if (errors.length > 0) {
    console.log(`\n⚠️ ERRORS:`);
    errors.forEach(e => console.log(`  - ${e.facility}: ${e.error}`));
  }
}

function calculateVendingScore(facility) {
  let score = 50; // Base score for senior living (good category)
  
  const type = facility.type.toLowerCase();
  
  // CCRC or multi-level care = more staff, more visitors
  if (type.includes('ccrc') || (type.includes('nursing') && type.includes('assisted'))) score += 20;
  if (type.includes('skilled nursing') || type.includes('rehab')) score += 15; // 24/7 heavy staffing
  if (type.includes('memory care')) score += 10; // Specialized staff, longer visits
  if (type.includes('independent living')) score += 5; // Residents more mobile, use vending
  
  // Known larger facilities get bonus
  const largeChains = ['brookdale', 'atria', 'sunrise', 'oakmont', 'merrill', 'pacifica', 'life care'];
  if (largeChains.some(c => facility.name.toLowerCase().includes(c) || facility.domain.includes(c))) score += 10;
  
  return Math.min(score, 100);
}

function getVendingNotes(facility) {
  const notes = [];
  const type = facility.type.toLowerCase();
  
  notes.push("24/7 staff (CNAs, nurses, caregivers)");
  notes.push("Visitors spending hours with residents");
  
  if (type.includes('skilled nursing') || type.includes('rehab')) {
    notes.push("Heavy staffing - multiple shifts of nurses, CNAs, therapists");
  }
  if (type.includes('memory care')) {
    notes.push("Specialized staff with long shifts - high break room usage");
  }
  if (type.includes('independent living')) {
    notes.push("Mobile residents who may use smart market amenities");
  }
  
  notes.push("Healthy snack options align with healthcare setting");
  notes.push("Staff break rooms essential - pitch as employee amenity");
  
  return notes.join("; ");
}

main().catch(console.error);
