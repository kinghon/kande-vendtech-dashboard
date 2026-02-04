#!/usr/bin/env node
/**
 * CRM Import - Import all leads with emails to CRM
 * Uses the correct format: { person: { ... } }
 */

const API = 'https://sales.kandedash.com/api/apollo/import-to-crm';
const API_KEY = 'kande2026';

const leadsToImport = [
  // Healthcare - Verified
  { first_name: 'Michael', last_name: 'Langley', email: 'michael.langley@umcsn.com', organization_name: 'University Medical Center (UMC)', title: 'Facilities Operations', phone: '(702) 383-2007' },
  { first_name: 'NVCBO', last_name: '(Valley Health System)', email: 'NVCBO@uhsinc.com', organization_name: 'Valley Health System / UHS', title: 'Nevada Central Business Office', phone: '(702) 894-5700' },
  
  // Healthcare - Pattern Confirmed (high confidence)
  { first_name: 'Tony', last_name: 'Marinello', email: 'tony.marinello@umcsn.com', organization_name: 'University Medical Center (UMC)', title: 'Chief Operating Officer', phone: '(702) 383-2000' },
  { first_name: 'Karla', last_name: 'Perez', email: 'karla.perez@uhsinc.com', organization_name: 'Valley Health System', title: 'Regional Vice President', phone: '(702) 388-4000' },
  { first_name: 'Wesley', last_name: 'Molden', email: 'wesley.molden@davita.com', organization_name: 'DaVita South Las Vegas Dialysis Center', title: 'Facility Administrator' },
  { first_name: 'Laurence', last_name: 'Fortes', email: 'laurence.fortes@davita.com', organization_name: 'DaVita Las Vegas Dialysis', title: 'Facility Administrator' },
  { first_name: 'Angela', last_name: 'Weinstock', email: 'angela.weinstock@davita.com', organization_name: 'DaVita Las Vegas Dialysis', title: 'Group Facility Administrator' },
  
  // Commercial - Direct Found (100% confirmed)
  { first_name: 'Frank', last_name: 'Gatski', email: 'frank.gatski@sperrycga.com', organization_name: 'Gatski Commercial / Sperry CGA', title: 'President / CEO', phone: '(702) 221-8226' },
  { first_name: 'Jodi', last_name: 'Martinez', email: 'jodi.martinez@americannevada.com', organization_name: 'American Nevada Company', title: 'Property Manager', phone: '(702) 458-8855' },
  
  // Commercial - Pattern Derived (high confidence - 91.7%+)
  { first_name: 'Robin', last_name: 'Howe', email: 'robin.howe@cbre.com', organization_name: 'CBRE Las Vegas', title: 'Director, Property Management', phone: '+1 702 369 4873' },
  { first_name: 'Alicia', last_name: 'Russo', email: 'alicia.russo@gatskicommercial.com', organization_name: 'Gatski Commercial Real Estate Services', title: 'Managing Director of Property Management', phone: '(702) 221-8226' },
  { first_name: 'Natalie', last_name: 'Allred Stagnitta', email: 'natalie.allred@americannevada.com', organization_name: 'American Nevada Company', title: 'Vice President, Property Management', phone: '(702) 458-8855' },
  { first_name: 'Amanda', last_name: 'Comatov', email: 'amanda.comatov@prologis.com', organization_name: 'Prologis', title: 'Senior Property Manager', phone: '(702) 891-9292' },
  { first_name: 'Christie', last_name: 'Cobbett', email: 'christie.cobbett@prologis.com', organization_name: 'Prologis', title: 'Senior Property Manager', phone: '(702) 891-9292' },
  { first_name: 'Jenna', last_name: 'Grant', email: 'jenna.grant@prologis.com', organization_name: 'Prologis', title: 'Commercial Property Manager', phone: '(702) 891-9292' },
  { first_name: 'Jessica', last_name: 'Heath', email: 'jessica.heath@colliers.com', organization_name: 'Colliers International - Las Vegas', title: 'Property Manager', phone: '+1 702 836 3795' },
  { first_name: 'Jessica', last_name: 'Allen', email: 'jessica.allen@cushwake.com', organization_name: 'Cushman & Wakefield', title: 'Senior Property Manager' },
  { first_name: 'Juan', last_name: 'Rose', email: 'juan.rose@colliers.com', organization_name: 'Colliers International', title: 'Managing Director, Las Vegas Brokerage', phone: '+1 702 836 3795' },
  { first_name: 'Mike', last_name: 'Penosa', email: 'mike.penosa@telusinternational.com', organization_name: 'TELUS International', title: 'Sr. Facilities Manager' },
  { first_name: 'Brent', last_name: 'Gonthier', email: 'brent.gonthier@freedomforever.com', organization_name: 'Freedom Forever', title: 'Regional Facilities Manager' },
  { first_name: 'Terrell', last_name: 'Campbell', email: 'terrell.campbell@walmart.com', organization_name: 'Walmart Distribution', title: 'Regional Manager, Facilities Services' },
  { first_name: 'Michael', last_name: 'Koontz', email: 'michael.koontz@lincolnharris.com', organization_name: 'Lincoln Harris CSG', title: 'Commercial Property Manager' },
  { first_name: 'Noeleen', last_name: 'Schmidt', email: 'noeleen.schmidt@gatskicommercial.com', organization_name: 'Gatski Commercial Real Estate Services', title: 'Property Manager', phone: '(702) 221-8226' },
  { first_name: 'Stephanie', last_name: 'Thompkins', email: 'stephanie.thompkins@anchorhp.com', organization_name: 'Anchor Health Properties', title: 'Commercial Property Manager' },
  { first_name: 'Sarah', last_name: 'Graham', email: 'sarah.graham@nacommercial.com', organization_name: 'North American Commercial', title: 'Senior Property Manager' },
  { first_name: 'Kristin', last_name: 'Freeman', email: 'kristin.freeman@markivcapital.com', organization_name: 'Mark IV Capital', title: 'Property Manager' },
  { first_name: 'Karen', last_name: 'Hammer', email: 'karen.hammer@svn.com', organization_name: 'SVN | The Equity Group', title: 'Commercial Property Manager' },
  { first_name: 'Esperanza', last_name: 'Everson', email: 'esperanza.everson@markivcapital.com', organization_name: 'Mark IV Capital', title: 'Director, Asset Management' },
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
  console.log('📤 Importing verified leads to CRM...');
  console.log('='.repeat(50));
  
  let imported = 0, failed = 0, skipped = 0;
  
  for (const lead of leadsToImport) {
    const result = await importLead(lead);
    if (result.success) {
      if (result.action === 'created') imported++;
      else skipped++; // already exists
    } else {
      failed++;
    }
    await new Promise(r => setTimeout(r, 150));
  }
  
  console.log('\\n' + '='.repeat(50));
  console.log(`📊 CRM Import Results:`);
  console.log(`  Created: ${imported}`);
  console.log(`  Already existed: ${skipped}`);
  console.log(`  Failed: ${failed}`);
  console.log(`  Total attempted: ${leadsToImport.length}`);
  
  // Output JSON for report
  console.log('\\n__STATS__' + JSON.stringify({ imported, skipped, failed, total: leadsToImport.length }));
}

main().catch(console.error);
