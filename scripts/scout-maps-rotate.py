#!/usr/bin/env python3
"""
scout-maps-rotate.py
Runs a batch of Google Maps category searches against the VendTech maps/discover API.
Rotates through the full category list automatically using a state file.
Each run covers 3 category groups. At 6 runs/day, full cycle takes ~4 days.

Usage: python3 scout-maps-rotate.py [--dry-run]
"""

import json, sys, urllib.request, datetime, os

STATE_FILE  = "/Users/kurtishon/clawd/logs/scout-rotate-state.json"
OUTPUT_DIR  = "/Users/kurtishon/clawd/agent-output/scout"
CRM_BASE    = "https://sales.kandedash.com"
CRM_KEY     = "kande2026"
BATCH_SIZE  = 3  # category groups per run

# Full category rotation list — all viable vending machine placement targets
CATEGORY_GROUPS = [
    # Residential
    {"name": "apartment_complexes",     "categories": ["apartment complexes Las Vegas NV", "apartment complexes Henderson NV", "luxury apartments Las Vegas", "apartment communities North Las Vegas"]},
    {"name": "senior_living",           "categories": ["senior living Las Vegas NV", "assisted living Henderson NV", "independent living Las Vegas", "memory care Las Vegas", "retirement communities Las Vegas"]},
    {"name": "condos_highrise",         "categories": ["condominiums Las Vegas NV", "high rise condos Las Vegas", "condo communities Henderson NV"]},

    # Office & Corporate
    {"name": "office_buildings",        "categories": ["office buildings Las Vegas NV", "office parks Henderson NV", "corporate offices Las Vegas", "business parks Las Vegas"]},
    {"name": "coworking",               "categories": ["coworking spaces Las Vegas", "shared office space Henderson NV", "executive suites Las Vegas"]},
    {"name": "call_centers",            "categories": ["call centers Las Vegas NV", "customer service centers Henderson NV"]},
    {"name": "corporate_hq",            "categories": ["corporate headquarters Las Vegas NV", "company offices Henderson NV", "regional offices Las Vegas"]},

    # Industrial / Logistics
    {"name": "warehouses",              "categories": ["warehouses Las Vegas NV", "warehouse facilities Henderson NV", "storage facilities Las Vegas", "fulfillment centers Las Vegas"]},
    {"name": "distribution_centers",    "categories": ["distribution centers Las Vegas NV", "logistics centers Henderson NV", "shipping centers Las Vegas"]},
    {"name": "manufacturing",           "categories": ["manufacturing Las Vegas NV", "factories Henderson NV", "industrial facilities Las Vegas", "production facilities Las Vegas"]},
    {"name": "data_centers",            "categories": ["data centers Las Vegas NV", "server facilities Henderson NV", "colocation facilities Las Vegas"]},

    # Medical & Healthcare
    {"name": "hospitals",               "categories": ["hospitals Las Vegas NV", "hospitals Henderson NV", "medical centers Las Vegas", "medical centers Henderson NV"]},
    {"name": "dialysis_urgent_care",    "categories": ["dialysis centers Las Vegas NV", "urgent care Las Vegas", "urgent care Henderson NV", "outpatient clinics Las Vegas"]},
    {"name": "dental_specialty",        "categories": ["dental offices Las Vegas NV", "specialty clinics Henderson NV", "physical therapy Las Vegas", "rehabilitation centers Las Vegas"]},
    {"name": "veterinary",              "categories": ["veterinary clinics Las Vegas NV", "animal hospitals Henderson NV", "pet care centers Las Vegas"]},

    # Government & Education
    {"name": "government_buildings",    "categories": ["government buildings Las Vegas NV", "courthouses Henderson NV", "DMV Las Vegas", "city offices Las Vegas", "county offices Las Vegas"]},
    {"name": "universities_colleges",   "categories": ["universities Las Vegas NV", "colleges Henderson NV", "community colleges Las Vegas", "trade schools Las Vegas"]},
    {"name": "k12_schools",             "categories": ["high schools Las Vegas NV", "middle schools Henderson NV", "private schools Las Vegas", "charter schools Las Vegas"]},

    # Hospitality & Leisure
    {"name": "hotels",                  "categories": ["hotels Las Vegas NV", "hotels Henderson NV", "extended stay Las Vegas", "motels Las Vegas"]},
    {"name": "gyms_fitness",            "categories": ["gyms Las Vegas NV", "fitness centers Henderson NV", "health clubs Las Vegas", "CrossFit Las Vegas", "Planet Fitness Las Vegas"]},
    {"name": "sports_recreation",       "categories": ["sports facilities Las Vegas NV", "recreation centers Henderson NV", "athletic clubs Las Vegas", "stadiums Las Vegas"]},

    # Retail & Auto
    {"name": "car_dealerships",         "categories": ["car dealerships Las Vegas NV", "auto dealers Henderson NV", "used car lots Las Vegas", "automotive service Las Vegas"]},
    {"name": "large_retail",            "categories": ["shopping centers Las Vegas NV", "retail centers Henderson NV", "big box stores Las Vegas"]},

    # Transport & Construction
    {"name": "transportation",          "categories": ["transportation companies Las Vegas NV", "trucking companies Henderson NV", "bus companies Las Vegas", "taxi fleets Las Vegas"]},
    {"name": "construction",            "categories": ["construction companies Las Vegas NV", "contractors Henderson NV", "general contractors Las Vegas", "construction offices Las Vegas"]},

    # Financial & Professional Services
    {"name": "financial_insurance",     "categories": ["insurance offices Las Vegas NV", "financial services Henderson NV", "banks Las Vegas", "credit unions Las Vegas"]},
    {"name": "legal_accounting",        "categories": ["law firms Las Vegas NV", "accounting firms Henderson NV", "professional services Las Vegas"]},

    # Tech & Media
    {"name": "tech_companies",          "categories": ["technology companies Las Vegas NV", "software companies Henderson NV", "IT companies Las Vegas", "tech startups Las Vegas"]},
    {"name": "media_entertainment",     "categories": ["production companies Las Vegas NV", "studios Henderson NV", "entertainment companies Las Vegas"]},
    # Extended categories — second pass with new search terms
    {"name": "car_washes",              "categories": ["car wash Las Vegas NV", "auto detailing Henderson NV", "car wash North Las Vegas"]},
    {"name": "bowling_entertainment",   "categories": ["bowling alley Las Vegas NV", "entertainment center Henderson NV", "arcade Las Vegas", "Dave Buster Las Vegas"]},
    {"name": "movie_theaters",          "categories": ["movie theater Las Vegas NV", "cinema Henderson NV", "AMC Las Vegas", "Regal Las Vegas", "Cinemark Las Vegas"]},
    {"name": "casinos_employee",        "categories": ["casino back of house Las Vegas", "resort employee area Las Vegas", "hotel employee services Las Vegas"]},
    {"name": "convention_events",       "categories": ["convention center Las Vegas NV", "event venue Henderson NV", "conference center Las Vegas", "expo center Las Vegas"]},
    {"name": "dispensaries",            "categories": ["cannabis dispensary Las Vegas NV", "dispensary Henderson NV", "marijuana dispensary Las Vegas"]},
    {"name": "private_aviation",        "categories": ["FBO Las Vegas NV", "private aviation Henderson Executive Airport", "charter flight Las Vegas"]},
    {"name": "auto_repair",             "categories": ["auto repair Las Vegas NV", "mechanic shop Henderson NV", "tire shop Las Vegas", "oil change Las Vegas"]},
    {"name": "new_construction_2025",   "categories": ["new apartment Las Vegas 2025", "new office building Las Vegas 2025", "new development Henderson NV 2025 2026"]},
    {"name": "government_facilities",   "categories": ["DMV Las Vegas NV", "Clark County office Las Vegas", "City of Henderson municipal", "Social Security office Las Vegas"]},
    {"name": "universities_colleges",   "categories": ["UNLV Las Vegas campus", "College of Southern Nevada Henderson", "vocational school Las Vegas", "trade school Henderson NV"]},
    # === NEW CATEGORIES — added 2026-04-25 ===
    {"name": "auction_liquidation",      "categories": ["auction house Las Vegas NV", "retail returns liquidation Las Vegas", "estate auction Henderson NV", "wholesale liquidation Las Vegas"]},
    {"name": "gaming_tech_mfg",          "categories": ["gaming technology company Las Vegas NV", "slot machine manufacturer Las Vegas", "gaming equipment company Henderson NV"]},
    {"name": "event_av_production",      "categories": ["event production company Las Vegas NV", "audio visual company Las Vegas", "trade show services Las Vegas", "convention services Las Vegas"]},
    {"name": "food_bev_distribution",    "categories": ["food distribution warehouse Las Vegas NV", "beverage distributor Las Vegas", "foodservice distribution Henderson NV", "cold storage warehouse Las Vegas"]},
    {"name": "mma_combat_sports",        "categories": ["MMA gym Las Vegas NV", "martial arts training Las Vegas", "boxing gym Las Vegas", "combat sports facility Henderson NV", "UFC gym Las Vegas"]},
    {"name": "landscape_building_supply","categories": ["landscape supply warehouse Las Vegas NV", "artificial turf supplier Las Vegas", "building supply warehouse Henderson NV", "flooring supply warehouse Las Vegas"]},
    {"name": "nursing_medical_college",  "categories": ["nursing school Las Vegas NV", "medical college Henderson NV", "healthcare training school Las Vegas", "dental assisting school Las Vegas"]},
    {"name": "design_showrooms",         "categories": ["window treatment showroom Las Vegas NV", "design center Las Vegas", "flooring showroom Henderson NV", "furniture showroom Las Vegas"]},
    {"name": "truck_stops_travel",       "categories": ["truck stop Las Vegas NV", "travel plaza I-15 Las Vegas", "TA travel center Las Vegas", "Pilot Flying J Las Vegas"]},
    {"name": "staffing_agencies",        "categories": ["staffing agency Las Vegas NV", "temp agency Henderson NV", "employment agency Las Vegas", "labor staffing Las Vegas"]},
    {"name": "industrial_parks_89118",   "categories": ["industrial park 89118 Las Vegas", "business park S Decatur Las Vegas", "commercial warehouse Sunset Rd Las Vegas", "industrial complex S Valley View Las Vegas"]},
    {"name": "industrial_parks_89030",   "categories": ["industrial park North Las Vegas 89030", "warehouse complex Market Center Dr Las Vegas", "distribution center North Las Vegas NV"]},
]

def load_state():
    try:
        return json.load(open(STATE_FILE))
    except:
        return {"index": 0, "total_runs": 0, "total_new": 0}

def save_state(state):
    os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
    json.dump(state, open(STATE_FILE, "w"), indent=2)

def crm_post(path, data):
    body = json.dumps(data).encode()
    req = urllib.request.Request(f"{CRM_BASE}{path}", data=body, method="POST",
          headers={"x-api-key": CRM_KEY, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read()), r.status

def main():
    dry_run = "--dry-run" in sys.argv
    state   = load_state()
    today   = datetime.date.today().isoformat()
    now     = datetime.datetime.now().strftime("%H:%M")

    # Pick next batch of category groups
    start_idx = state["index"]
    batch     = []
    for i in range(BATCH_SIZE):
        idx = (start_idx + i) % len(CATEGORY_GROUPS)
        batch.append((idx, CATEGORY_GROUPS[idx]))

    print(f"\n🗺️  Scout Maps Rotate — {today} {now}")
    print(f"   Batch: groups {[b[0] for b in batch]} of {len(CATEGORY_GROUPS)} total")
    print(f"   Categories: {', '.join(g['name'] for _, g in batch)}\n")

    total_new   = 0
    total_found = 0
    results     = []

    for idx, group in batch:
        cats = group["categories"]
        print(f"  🔍 {group['name']}: {len(cats)} categories...")

        if dry_run:
            print(f"     [DRY RUN] would call maps/discover")
            results.append({"group": group["name"], "new": 0, "found": 0})
            continue

        try:
            resp, status = crm_post("/api/maps/discover", {"categories": cats, "maxPerCategory": 25})
            found      = resp.get("total", 0)
            new_leads  = resp.get("newLeads", [])
            skipped    = resp.get("existingMatches", 0)
            added      = 0
            rejected   = 0

            # Persist each new lead to CRM
            for lead in new_leads:
                prospect = {
                    "name":                 lead.get("name", ""),
                    "address":              lead.get("address", ""),
                    "phone":                lead.get("phone", ""),
                    "website":              lead.get("website", ""),
                    "property_type":        lead.get("type", "other"),
                    "source":               "scout-maps",
                    "status":               "new",
                    "google_place_id":      lead.get("placeId", ""),
                    "google_rating":        lead.get("rating", 0),
                    "google_review_count":  lead.get("reviewCount", 0),
                    "maps_business_status": lead.get("businessStatus", "OPERATIONAL"),
                    "notes":                f"Maps Scout ({group['name']}): {lead.get('category','')}",
                }
                if not prospect["name"]:
                    continue
                try:
                    result, _ = crm_post("/api/prospects", prospect)
                    added += 1
                except Exception as pe:
                    err = str(pe)
                    if "422" in err or "qualification" in err.lower():
                        rejected += 1
                    # else skip silently

            print(f"     Found: {found} | New: {added} | Skipped: {skipped} | Rejected: {rejected}")
            total_new   += added
            total_found += found
            results.append({"group": group["name"], "new": added, "found": found})
        except Exception as e:
            print(f"     ⚠️ Error: {e}")
            results.append({"group": group["name"], "error": str(e)})

    # Update state
    next_idx = (start_idx + BATCH_SIZE) % len(CATEGORY_GROUPS)
    state["index"]      = next_idx
    state["total_runs"] += 1
    state["total_new"]  += total_new
    state["last_run"]   = f"{today} {now}"
    if not dry_run:
        save_state(state)

    # Write output log
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    log_path = f"{OUTPUT_DIR}/maps-rotate-{today}.md"
    with open(log_path, "a") as f:
        f.write(f"\n## Run {now} — Groups {[b[0] for b in batch]}\n")
        for r in results:
            f.write(f"- **{r['group']}**: {r.get('new', 0)} new / {r.get('found', 0)} found\n")
        f.write(f"- **Total new this run: {total_new}**\n")

    print(f"\n✅ Done. {total_new} new leads added this run.")
    print(f"   Next run starts at group index {next_idx} ({CATEGORY_GROUPS[next_idx]['name']})")
    print(f"   Total new leads all-time: {state['total_new']}")

    # Exit code: 0 if new leads found (cron agent should report), 1 if nothing new
    sys.exit(0 if total_new > 0 else 1)

if __name__ == "__main__":
    main()
