#!/usr/bin/env node
/**
 * Import Casino & College leads to CRM
 * Casino contacts found via Google/LinkedIn search (Apollo blocked on free plan)
 * College contacts from college-dorms.json
 */

const API = 'https://sales.kandedash.com/api/apollo/import-to-crm';
const API_KEY = 'kande2026';

// ============ CASINO LEADS ============
// Station Casinos: email domain stationcasinos.com, format first.last@stationcasinos.com
// Boyd Gaming: email domain boydgaming.com, format first.last@boydgaming.com

const casinoLeads = [
  // === GREEN VALLEY RANCH (Station Casinos) ===
  {
    first_name: 'Rod',
    last_name: 'Hicken',
    email: 'rod.hicken@stationcasinos.com',
    organization_name: 'Green Valley Ranch Resort - Station Casinos',
    title: 'Corporate Director of Facilities',
    linkedin_url: 'https://www.linkedin.com/in/rod-hicken-25a58b33',
    notes: 'KEY CONTACT - Corporate Director of Facilities specifically at Green Valley Ranch. 204 followers, 200 connections on LinkedIn. Corporate-level = can open doors to ALL Station Casinos properties. Target: employee break rooms (back of house). Station Casinos operates 10+ properties in Las Vegas.'
  },

  // === SUNSET STATION (Station Casinos) ===
  {
    first_name: 'Ian',
    last_name: 'Gold',
    email: 'ian.gold@stationcasinos.com',
    organization_name: 'Sunset Station - Station Casinos',
    title: 'Director of Facilities',
    linkedin_url: 'https://www.linkedin.com/in/ian-gold-431015243',
    notes: 'Henderson-based Director of Facilities at Station Casinos. Likely manages Sunset Station or Green Valley Ranch. Henderson location = Kande home territory. Target: employee break rooms, back of house areas.'
  },

  // === DURANGO CASINO & RESORT (Station Casinos) - newest property, opened Dec 2023 ===
  {
    first_name: 'Graham',
    last_name: 'Miller',
    email: 'graham.miller@stationcasinos.com',
    organization_name: 'Durango Casino & Resort - Station Casinos',
    title: 'Director of Facilities',
    linkedin_url: 'https://www.linkedin.com/in/graham-miller-7979781b7',
    notes: 'Director of Facilities at Station Casinos. 420+ LinkedIn followers. Motivated facilities manager/engineer. Durango is Station\'s NEWEST property (opened Dec 2023) at 5585 Durango Dr, Las Vegas 89113. New facility = may not have locked in vending vendor yet. PRIORITY TARGET.'
  },

  // === RED ROCK RESORT (Station Casinos) ===
  {
    first_name: 'Norman',
    last_name: 'Villafane',
    email: 'norman.villafane@stationcasinos.com',
    organization_name: 'Red Rock Resort - Station Casinos',
    title: 'Director of Facilities',
    linkedin_url: 'https://www.linkedin.com/in/norman-villafane-063436173',
    notes: 'Director of Facilities at Station Casinos Corporate Office. Likely oversees Red Rock Resort (Station Casinos\' flagship property at 11011 W Charleston Blvd). Premium property = premium vending placement.'
  },

  // === STATION CASINOS CORPORATE (covers all properties) ===
  {
    first_name: 'Michael',
    last_name: 'Wesolek',
    email: 'michael.wesolek@stationcasinos.com',
    organization_name: 'Station Casinos LLC (Corporate)',
    title: 'Director of Facilities',
    linkedin_url: 'https://www.linkedin.com/in/michael-wesolek-78b84272',
    notes: '17+ years at Station Casinos (since Jun 2008). Most tenured facilities director = knows every property inside out. 300+ LinkedIn followers. Long tenure = strong internal influence. CORPORATE LEVEL CONTACT.'
  },
  {
    first_name: 'Amarilys',
    last_name: 'Gordon',
    email: 'amarilys.gordon@stationcasinos.com',
    organization_name: 'Station Casinos LLC (Corporate)',
    title: 'HR Director',
    linkedin_url: 'https://www.linkedin.com/in/amarilys-gordon-0528bba8',
    notes: 'HR Director at Station Casinos since Jan 2007 (19 years). UNLV grad. HR controls employee amenities and break room decisions. 10+ connections. Long tenure = deep organizational knowledge. HR pitch: smart market as employee retention amenity.'
  },
  {
    first_name: 'Nito',
    last_name: 'Contreras',
    email: 'nito.contreras@stationcasinos.com',
    organization_name: 'Station Casinos LLC',
    title: 'Director of Facilities',
    linkedin_url: 'https://www.linkedin.com/in/nito-contreras-9b10311b',
    notes: 'Director of Facilities at Station Casinos. Additional facilities contact for coverage across Station properties.'
  },

  // === ORLEANS HOTEL & CASINO (Boyd Gaming) ===
  {
    first_name: 'Dave',
    last_name: 'Babbe',
    email: 'dave.babbe@boydgaming.com',
    organization_name: 'The Orleans Hotel & Casino - Boyd Gaming',
    title: 'Director of Facilities',
    linkedin_url: 'https://www.linkedin.com/in/dave-babbe-501a705b',
    notes: 'Director of Facilities at Boyd Gaming, Las Vegas. Orleans is actively hiring Asst Facility Manager (LinkedIn job posting) = facilities team is growing. Orleans at 4500 W Tropicana Ave, 1,886 rooms, 24/7 casino ops. Target: employee break rooms, back of house. Boyd Gaming operates 11 LV properties — one relationship could unlock many.'
  },
  {
    first_name: 'Margene',
    last_name: 'Otten',
    email: 'margene.otten@boydgaming.com',
    organization_name: 'Boyd Gaming Corporation (Corporate)',
    title: 'Executive Assistant - Design, Construction & Facilities',
    linkedin_url: 'https://www.linkedin.com/in/margene-otten-1b353a129',
    notes: 'EA supporting SVP of Design & Construction + Director of Facilities + Director of Construction Controls. 70+ LinkedIn followers. GATEKEEPER to Boyd\'s facilities decision makers. Good first contact to learn vendor approval process for 16+ Boyd properties.'
  },
];

// ============ COLLEGE LEADS ============
const collegeLeads = [
  // UNLV
  {
    first_name: 'UNLV',
    last_name: 'Housing & Residential Life',
    email: 'housing@unlv.edu',
    organization_name: 'University of Nevada, Las Vegas (UNLV)',
    title: 'Housing & Residential Life Department',
    phone: '702-895-3489',
    notes: 'THE WHALE. 32,911 students, 2,000+ on-campus residents across 4 dorms (Dayton, Tonopah, South, UCC). Target Dayton Complex first (first-year students = highest impulse buying). Must register as NSHE vendor at suppliers.nevada.edu. Dining halls close evenings = late-night vending demand. Estimated 4-8 machines, $20K-$50K/month revenue.'
  },
  {
    first_name: 'UNLV',
    last_name: 'Purchasing & Contracts',
    email: '', // no direct email, use department
    organization_name: 'University of Nevada, Las Vegas (UNLV)',
    title: 'Purchasing and Contracts Department',
    phone: '702-895-3521',
    notes: 'Vendor registration required through NSHE SReg at suppliers.nevada.edu. Small purchase threshold ~$50K (below may not require full RFP). Process: Register in SReg → Contact Purchasing → Propose pilot.'
  },
  // CSN
  {
    first_name: 'Rolando',
    last_name: 'Mosqueda',
    email: 'rolando.mosqueda@csn.edu',
    organization_name: 'College of Southern Nevada (CSN)',
    title: 'Associate VP, Procurement & Auxiliary Services',
    phone: '702-651-4245',
    notes: 'PRIMARY CONTACT for CSN. Oversees BOTH procurement AND auxiliary services = perfect for vending/smart market pitch. CSN has 32,000 students across 3 campuses (Charleston, N Las Vegas, Henderson). Estimated 3-6 machines, $12K-$25K/month. NSHE vendor registration required. J.D. credential = formal approach needed.'
  },
  {
    first_name: 'Paula',
    last_name: 'Gonzales',
    email: 'paula.gonzales@csn.edu',
    organization_name: 'College of Southern Nevada (CSN)',
    title: 'Director of Purchasing',
    phone: '702-651-4039',
    notes: 'CPM certified Director of Purchasing at CSN. Secondary contact after Rolando Mosqueda. Handles vendor procurement processes.'
  },
  {
    first_name: 'Annette',
    last_name: 'Lord',
    email: 'annette.lord@csn.edu',
    organization_name: 'College of Southern Nevada (CSN)',
    title: 'Purchasing & Contracts Administrator (Auxiliary Services)',
    phone: '702-651-2970',
    notes: 'Handles Auxiliary Services purchasing specifically. Vending falls under auxiliary services. Direct decision-making authority for this category.'
  },
  // Nevada State University
  {
    first_name: 'Nevada State',
    last_name: 'Finance & Business Ops',
    email: '',
    organization_name: 'Nevada State University',
    title: 'Finance & Business Operations',
    phone: '702-992-2000',
    notes: 'SLEEPER HIT. Recently became a university (was Nevada State College), rapidly growing, building new infrastructure. Henderson location = Kande territory. Has Food Pantry = food access is a concern = affordable smart vending resonates. Has "Doing Business with Nevada State" page. 7,500 enrollment. Estimated 1-3 machines, $4K-$12K/month.'
  },
  // U District (UNLV-affiliated private housing)
  {
    first_name: 'U District',
    last_name: 'Property Management',
    email: '',
    organization_name: 'U District (UNLV-Affiliated Student Housing)',
    title: 'Property Management',
    notes: 'Two properties: The Degree (luxury, 500-800 students) and Legacy LV (affordable, 500-800 students). 12-month leases = year-round revenue. Separately managed from UNLV = different (easier) procurement. Contact via liveudistrict.com. Estimated 2 machines, $6K-$12K/month.'
  },
];

async function importLead(person) {
  try {
    const resp = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
      body: JSON.stringify({ person })
    });
    const data = await resp.json();
    if (resp.ok) {
      console.log(`  ✅ ${person.first_name} ${person.last_name} → ${data.action} (ID: ${data.prospect?.id})`);
      return { success: true, action: data.action, id: data.prospect?.id };
    } else {
      console.log(`  ❌ ${person.first_name} ${person.last_name} → ${data.error || resp.status}`);
      return { success: false, error: data.error };
    }
  } catch (err) {
    console.log(`  ❌ ${person.first_name} ${person.last_name} → ${err.message}`);
    return { success: false, error: err.message };
  }
}

async function main() {
  let casinoCreated = 0, collegeCreated = 0, failed = 0;

  console.log('🎰 Importing Casino leads to CRM...');
  console.log('='.repeat(50));
  for (const lead of casinoLeads) {
    const r = await importLead(lead);
    if (r.success) casinoCreated++;
    else failed++;
    await new Promise(r => setTimeout(r, 150));
  }

  console.log('\n🎓 Importing College leads to CRM...');
  console.log('='.repeat(50));
  for (const lead of collegeLeads) {
    const r = await importLead(lead);
    if (r.success) collegeCreated++;
    else failed++;
    await new Promise(r => setTimeout(r, 150));
  }

  console.log('\n' + '='.repeat(50));
  console.log('📊 Results:');
  console.log(`  Casino leads imported: ${casinoCreated}/${casinoLeads.length}`);
  console.log(`  College leads imported: ${collegeCreated}/${collegeLeads.length}`);
  console.log(`  Failed: ${failed}`);
  console.log(`  Total: ${casinoCreated + collegeCreated} new CRM records`);
}

main().catch(console.error);
