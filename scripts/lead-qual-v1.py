#!/usr/bin/env python3
"""
Lead Qualification Reanalysis — Version 1 (Jarvis build)
Scores CRM leads + stuck scout leads against the 6-point qualification spec.
Uses existing CRM Maps data + Brave Search for Apollo/LinkedIn/website checks.

Usage:
  python3 lead-qual-v1.py --dry-run              # report only
  python3 lead-qual-v1.py --dry-run --batch 20   # test on 20 leads
  python3 lead-qual-v1.py --commit               # update CRM
  python3 lead-qual-v1.py --scout-only           # only score stuck scout leads
  python3 lead-qual-v1.py --crm-only             # only score CRM leads
"""

import json, sys, time, re, argparse, datetime, os, urllib.request, urllib.parse
from pathlib import Path

# ── Config ──────────────────────────────────────────────────────────────────
CRM_BASE    = "https://vend.kandedash.com"
CRM_KEY     = "kande2026"
BRAVE_KEY   = "BSA8enLl2f0NW0JBRjem3n4eNpiNzbz"
SCOUT_DIR   = Path("/Users/kurtishon/clawd/agent-output/scout")
OUTPUT_DIR  = Path("/Users/kurtishon/clawd/agent-output/scout")
TODAY       = datetime.date.today().isoformat()
SLEEP_S     = 0.4   # between Brave calls

# ── HTTP helpers ─────────────────────────────────────────────────────────────
def crm_get(path):
    url = f"{CRM_BASE}{path}"
    req = urllib.request.Request(url, headers={"x-api-key": CRM_KEY})
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read())

def crm_put(path, data):
    body = json.dumps(data).encode()
    req = urllib.request.Request(
        f"{CRM_BASE}{path}", data=body, method="PUT",
        headers={"x-api-key": CRM_KEY, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read())

def brave_search(query, count=3):
    q = urllib.parse.quote(query)
    url = f"https://api.search.brave.com/res/v1/web/search?q={q}&count={count}"
    req = urllib.request.Request(url, headers={
        "Accept": "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": BRAVE_KEY
    })
    try:
        with urllib.request.urlopen(req, timeout=8) as r:
            import gzip
            raw = r.read()
            if r.info().get('Content-Encoding') == 'gzip':
                raw = gzip.decompress(raw)
            return json.loads(raw)
    except Exception as e:
        return {"error": str(e)}

def head_request(url):
    try:
        req = urllib.request.Request(url, method="HEAD",
            headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status
    except:
        try:
            req = urllib.request.Request(url,
                headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=5) as r:
                return r.status
        except:
            return None

# ── Protection checks ─────────────────────────────────────────────────────────
POPIN_TERMS = ["pop in", "popped in", "visited", "in person", "stop by", "stopped by", "dropped by"]
REFERRAL_TERMS = ["hand-added", "referral", "referred by", "personal intro"]
MANUAL_SOURCES = ["", None, "manual", "hand", "direct"]

def is_protected(p):
    """Returns (bool, reason) — protected leads are never touched."""
    status = (p.get("status") or "").lower()
    # Active pipeline statuses — never remove
    if status in ("signed", "negotiating", "active", "proposal_sent",
                  "opening_soon", "pipeline", "closed", "lost"):
        return True, f"status={status}"
    # Manual or referral source — protect UNLESS it's a brand-new unworked lead
    # (status=new + no kurtis_notes + no pop-in = scoreable even if source=manual)
    source = (p.get("source") or "").lower()
    if source in ("manual", "referral"):
        is_new_unworked = (
            status == "new"
            and not (p.get("kurtis_notes") or "").strip()
            and not (p.get("last_completed_action") or "")
        )
        if not is_new_unworked:
            return True, f"source={source}"
    # Pop-in visit logged
    lca = (p.get("last_completed_action") or "").lower()
    if "pop in" in lca or "pop-in" in lca:
        return True, "last_completed_action=Pop In"
    # Any personal notes from Kurtis
    if (p.get("kurtis_notes") or "").strip():
        return True, "kurtis_notes non-empty"
    # Notes mention a physical visit
    notes_blob = " ".join([
        (p.get("notes") or ""), (p.get("kurtis_notes") or "")
    ]).lower()
    for t in POPIN_TERMS:
        if t in notes_blob:
            return True, f"notes contain '{t}'"
    return False, ""

def is_manually_added(p):
    """
    True if there's evidence Kurtis personally added this lead.
    Signals: non-empty kurtis_notes, OR referral terms in notes,
    OR no google_place_id AND no email_tracking (pure manual entry).
    NOT triggered just because source field is blank.
    """
    notes_blob = " ".join([
        (p.get("notes") or ""), (p.get("kurtis_notes") or "")
    ]).lower()
    for t in REFERRAL_TERMS:
        if t in notes_blob:
            return True
    # Kurtis personally wrote notes = personal knowledge
    kurtis_notes = (p.get("kurtis_notes") or "").strip()
    if kurtis_notes:
        return True
    # No Google verification AND no email contact = raw manual entry
    has_google = bool(p.get("google_place_id"))
    has_email  = bool(p.get("email_tracking"))
    if not has_google and not has_email:
        return True
    return False

def needs_review(p):
    """Returns (bool, reason) — flag for Kurtis, don't auto-remove."""
    status = (p.get("status") or "").lower()
    notes_blob = " ".join([
        (p.get("notes") or ""), (p.get("kurtis_notes") or "")
    ]).lower()
    for t in REFERRAL_TERMS:
        if t in notes_blob:
            return True, f"kurtis_notes contain '{t}'"
    # Manually added leads are never auto-removed — flag for review
    if is_manually_added(p) and not p.get("_is_scout"):
        return True, "manually added lead (no auto-remove)"
    if status == "proposal_sent":
        opens = sum(e.get("num_opens", 0) for e in (p.get("email_tracking") or []))
        if opens > 0:
            return True, f"proposal_sent with {opens} email opens"
    if status in ("active", "meeting_scheduled", "negotiating"):
        return True, f"status={status}"
    return False, ""

# ── Scoring ───────────────────────────────────────────────────────────────────
HARD_FAIL_TYPES = [
    "general contractor", "homebuilder", "home builder", "construction company",
    "real estate agency", "real estate agent", "mortgage", "law firm",
    "attorney", "insurance agent", "accounting firm", "hair salon",
    "nail salon", "barbershop", "tattoo", "pet grooming"
]

# ── Industrial type detection ───────────────────────────────────────────────
INDUSTRIAL_PROP_TYPES = [
    "industrial", "warehouse", "distribution", "manufacturing",
    "food_processing", "auto_repair", "call_center", "corporate_hq",
    "fulfillment", "cold storage", "meat processing", "beverage",
    "bottling", "ground distribution", "package sorting"
]

INDUSTRIAL_NAME_SIGNALS = [
    "warehouse", "distribution center", "distribution centre", "fulfillment center",
    "fulfillment centre", "cold storage", "manufacturing", "factory",
    "processing", "industrial", "logistics", "supply chain", "storage",
    "distribution", "wholesale", "brewery", "bottling", "meat pack",
    "food processing", "auto repair", "call center", "contact center",
    "corporate hq", "corporate headquarters", "plant ", "plants ",
    "production", "fabrication", "assembly"
]

def is_industrial(p):
    """Returns True if this lead is an industrial/warehouse/manufacturing prospect."""
    prop = (p.get("property_type") or "").lower()
    name = (p.get("name") or "").lower()
    for t in INDUSTRIAL_PROP_TYPES:
        if t in prop:
            return True
    for s in INDUSTRIAL_NAME_SIGNALS:
        if s in name:
            return True
    return False

def score_maps_existence(p):
    """Check 1: Place exists and is operational (uses existing CRM data)."""
    status = (p.get("maps_business_status") or "").upper()
    place_id = p.get("google_place_id")
    prop_type = (p.get("property_type") or "").lower()
    name_lower = (p.get("name") or "").lower()

    # Hard fail: permanently closed
    if status == "CLOSED_PERMANENTLY":
        return 0, "permanently_closed"

    # Hard fail: business type that can never be a vending location
    for ft in HARD_FAIL_TYPES:
        if ft in name_lower:
            return 0, f"bad_type:{ft}"

    if place_id and status == "OPERATIONAL":
        return 2, f"operational place_id={place_id[:8]}..."
    elif place_id and status:
        return 1, f"found but status={status}"
    elif place_id:
        return 1, "place_id exists, status unknown"
    else:
        return 0, "no_place_id"

def score_maps_reviews(p):
    """Check 2: Review volume and rating quality."""
    rating = p.get("google_rating") or 0
    count  = p.get("google_review_count") or 0

    if count >= 50 and rating >= 4.0:
        return 2, f"{count} reviews, {rating}★"
    elif count >= 20 and rating >= 3.5:
        return 1, f"{count} reviews, {rating}★"
    elif count > 0:
        return 0, f"only {count} reviews, {rating}★"
    else:
        return 0, "no_reviews_in_crm"

def score_apollo(p, dry_run=True):
    """Check 3: Apollo company data + decision-maker contact."""
    name = p.get("name", "")
    city = "Las Vegas"

    # Check existing contacts in CRM first
    contacts = p.get("contacts") or []
    primary  = p.get("primary_contact") or ""
    if contacts and len(contacts) > 0:
        c = contacts[0]
        has_email = bool(c.get("email"))
        has_phone = bool(c.get("phone"))
        if has_email or has_phone:
            return 2, f"CRM contact: {c.get('name','?')} ({c.get('role','?')})"

    # Try Apollo proxy
    try:
        query = urllib.parse.urlencode({"q": name, "per_page": "1"})
        url   = f"{CRM_BASE}/api/apollo/organizations/search?{query}"
        req   = urllib.request.Request(url, headers={"x-api-key": CRM_KEY})
        with urllib.request.urlopen(req, timeout=8) as r:
            data = json.loads(r.read())
        orgs = data.get("organizations") or []
        if orgs:
            org = orgs[0]
            employees = org.get("estimated_num_employees") or 0
            if employees >= 10:
                return 2, f"Apollo: {employees} employees"
            elif employees > 0:
                return 1, f"Apollo: only {employees} employees"
            else:
                return 1, "Apollo: found but no employee count"
        return 0, "not_in_apollo"
    except Exception as e:
        # Apollo proxy may not support this endpoint - fall back on units field
        units = p.get("units") or ""
        if units and any(c.isdigit() for c in str(units)):
            nums = re.findall(r'\d+', str(units))
            if nums and int(nums[0]) >= 10:
                return 1, f"units field: {units}"
        return 0, f"apollo_error: {str(e)[:40]}"

def score_linkedin(p):
    """Check 4: LinkedIn company presence."""
    name = (p.get("name") or "").strip()
    results = brave_search(f'"{name}" Las Vegas site:linkedin.com/company', count=2)
    time.sleep(SLEEP_S)

    hits = results.get("web", {}).get("results", [])
    if not hits:
        return 0, "not_on_linkedin"

    url = hits[0].get("url", "")
    title = hits[0].get("title", "")
    desc  = hits[0].get("description", "")

    if "linkedin.com/company" in url:
        # Check for employee signals in description
        emp_match = re.search(r'(\d[\d,]+)\s*(employees|staff|members)', desc, re.I)
        if emp_match:
            n = int(emp_match.group(1).replace(",", ""))
            if n >= 10:
                return 2, f"LinkedIn: {n} employees"
            return 1, f"LinkedIn: only {n} employees"
        return 1, f"LinkedIn page found: {url[:50]}"
    return 0, "linkedin_no_company_page"

def score_website(p):
    """Check 5: Real website presence."""
    name = (p.get("name") or "").strip()
    addr = (p.get("address") or "").strip()

    results = brave_search(f'"{name}" Las Vegas NV official website', count=3)
    time.sleep(SLEEP_S)

    hits = results.get("web", {}).get("results", [])
    if not hits:
        return 0, "no_website_found"

    for hit in hits:
        url  = hit.get("url", "")
        desc = hit.get("description", "")
        # Skip social, directories, google itself
        if any(x in url for x in ["linkedin", "facebook", "yelp", "google.com",
                                    "yellowpages", "bbb.org", "indeed", "ziprecruiter"]):
            continue
        # Check if it's live
        status_code = head_request(url)
        if status_code and status_code < 400:
            return 2, f"live website: {url[:50]}"
        return 1, f"website found but unreachable: {url[:40]}"

    return 0, "only_directories_found"

def score_physical(p):
    """Check 6: Physical commercial location verified."""
    address = (p.get("address") or "").lower()
    lat     = p.get("lat")
    lng     = p.get("lng")
    prop    = (p.get("property_type") or "").lower()

    # If geocoded = real address found
    if lat and lng:
        # Residential signals
        residential_terms = ["apt ", "unit ", "suite #", "# ", "lot ", " #"]
        name_lower = (p.get("name") or "").lower()
        res_types  = ["residence", "home", "house"]

        if prop in res_types or any(t in name_lower for t in res_types):
            return 0, "residential_type"

        # Commercial property types
        commercial_types = ["apartment", "gym", "warehouse", "medical", "office",
                            "hotel", "industrial", "school", "government",
                            "hospital", "clinic", "senior", "storage"]
        if prop in commercial_types:
            return 2, f"geocoded commercial: {prop}"

        return 1, f"geocoded, type={prop or 'unknown'}"
    else:
        # No lat/lng — couldn't geocode
        return 0, "not_geocoded"

# ── Hard disqualifier check ───────────────────────────────────────────────────
def hard_disqualify(p, scores):
    """Returns (bool, reason) if any hard disqualifier applies."""
    rating = p.get("google_rating") or 0
    count  = p.get("google_review_count") or 0
    status = (p.get("maps_business_status") or "").upper()
    addr   = (p.get("address") or "").lower()
    phone  = (p.get("phone") or "").strip()
    name   = (p.get("name") or "").lower()

    WAREHOUSE_TYPES = ["warehouse", "distribution center", "distribution centre", "fulfillment center", "fulfillment centre"]
    is_warehouse = any(t in name for t in WAREHOUSE_TYPES)

    if status == "CLOSED_PERMANENTLY":
        return True, "permanently closed on Google Maps"
    if count and count < 5 and not (p.get("contacts") or p.get("primary_contact")):
        return True, f"only {count} Maps reviews, no contacts"
    for ft in HARD_FAIL_TYPES:
        if ft in name:
            return True, f"bad business type: {ft}"
    # Apollo/contact required only for warehouses/distribution centers
    if is_warehouse and not phone and scores.get("apollo", (0,))[0] == 0 and scores.get("website", (0,))[0] == 0:
        return True, "warehouse with no phone, no Apollo, no website"
    return False, ""

# ── Duplicate detection ───────────────────────────────────────────────────────────────
def normalize_name(name):
    """Normalize a lead name for duplicate comparison."""
    n = (name or "").lower().strip()
    # Remove common suffixes/prefixes
    for strip in ["apartments", "apartment", "llc", "inc", "corp", "ltd",
                  "the ", " las vegas", " henderson", " nv", "(", ")"]:
        n = n.replace(strip, "")
    return re.sub(r'\s+', ' ', n).strip()

def find_duplicates(leads):
    """
    Returns a dict: normalized_name -> list of lead dicts.
    Only entries with 2+ leads are actual duplicates.
    """
    groups = {}
    for p in leads:
        key = normalize_name(p.get("name", ""))
        if key not in groups:
            groups[key] = []
        groups[key].append(p)
    return {k: v for k, v in groups.items() if len(v) > 1}

def has_popin(p):
    lca   = (p.get("last_completed_action") or "").lower()
    notes = " ".join([(p.get("notes") or ""), (p.get("kurtis_notes") or "")]).lower()
    return ("pop in" in lca or "pop-in" in lca or
            any(t in notes for t in POPIN_TERMS))

# ── Main scorer ───────────────────────────────────────────────────────────────
# Foot traffic categories — hard rules by property type
_TRAFFIC_HARD_PASS = [
    # Large residential
    "apartment", "apartments", "senior living", "assisted living", "memory care",
    "student housing", "extended stay", "residence inn", "homewood suites",
    # Medical
    "hospital", "medical center", "regional medical", "dialysis", "surgery center",
    "urgent care", "va ", "veterans", "rehab center", "rehabilitation center",
    # Education
    "university", "college", "community college", "unlv", "csn", "trade school",
    "vocational", "charter school", "academy",
    # Large employment
    "distribution center", "fulfillment center", "amazon", "fedex hub", "ups facility",
    "data center", "manufacturing", "call center", "contact center",
    # Government/civic
    "courthouse", "dmv", "department of motor", "post office", "clark county",
    "city of las vegas", "government center", "social security",
    # Large recreation
    "convention center", "sports complex", "stadium", "arena",
    "movie theater", "amc ", "regal ", "cinemark",
    # Large hospitality
    "hotel", "resort", "casino",
]
_TRAFFIC_HARD_FAIL = [
    "kiosk", "food truck", "pop-up", "pop up", "single bay",
    "solo practice", "solo practitioner", "home office",
]

def score_foot_traffic(p):
    """Check 7: Estimate foot traffic meets 100+ daily floor."""
    name  = (p.get("name") or "").lower()
    ptype = (p.get("property_type") or "").lower()
    notes = (p.get("notes") or "").lower()
    text  = name + " " + ptype + " " + notes

    # Hard fail
    if any(s in text for s in _TRAFFIC_HARD_FAIL):
        return -2, "low_traffic:hard_fail"

    # Hard pass
    if any(s in text for s in _TRAFFIC_HARD_PASS):
        # Apartments: check unit count if available
        units_raw = p.get("units") or ""
        nums = re.findall(r'\d+', str(units_raw))
        if nums:
            unit_count = max(int(n) for n in nums)
            if unit_count < 50:
                return 0, f"small_complex:{unit_count}_units"
            elif unit_count >= 150:
                return 2, f"large_complex:{unit_count}_units"
            else:
                return 1, f"medium_complex:{unit_count}_units"
        return 2, "high_traffic_category"

    # Google review count as proxy
    reviews = p.get("google_review_count") or 0
    if reviews >= 200:
        return 2, f"high_reviews:{reviews}"
    elif reviews >= 50:
        return 1, f"decent_reviews:{reviews}"
    elif reviews > 0 and reviews < 15:
        return -1, f"low_reviews:{reviews}_likely_low_traffic"

    return 0, "traffic_unknown"


# ── Industrial-specific scoring ─────────────────────────────────────────────

def score_industrial_maps_existence(p):
    """Check 1: Place exists and is operational."""
    status = (p.get("maps_business_status") or "").upper()
    place_id = p.get("google_place_id")
    if status == "CLOSED_PERMANENTLY":
        return 0, "permanently_closed"
    if place_id and status == "OPERATIONAL":
        return 2, f"operational place_id={place_id[:8]}..."
    elif place_id:
        return 1, f"found but status={status}"
    return 1, "no_place_id but industrial leads often lack Maps presence"

def score_industrial_business_size(p):
    """Check 2: Employee count or facility size signals."""
    name = (p.get("name") or "").strip()
    # Try Apollo first
    try:
        query = urllib.parse.urlencode({"q": name, "per_page": "1"})
        url = f"{CRM_BASE}/api/apollo/organizations/search?{query}"
        req = urllib.request.Request(url, headers={"x-api-key": CRM_KEY})
        with urllib.request.urlopen(req, timeout=8) as r:
            data = json.loads(r.read())
        orgs = data.get("organizations") or []
        if orgs:
            emp = orgs[0].get("estimated_num_employees") or 0
            if emp >= 100:
                return 2, f"Apollo: {emp} employees"
            elif emp >= 20:
                return 1, f"Apollo: {emp} employees"
    except Exception:
        pass
    # Try LinkedIn via search
    results = brave_search(f'"{name}" Las Vegas employees staff', count=2)
    time.sleep(SLEEP_S)
    hits = results.get("web", {}).get("results", [])
    for hit in hits:
        desc = hit.get("description", "")
        m = re.search(r'(\d[\d,]+)\s*(employees|staff|team members)', desc, re.I)
        if m:
            n = int(m.group(1).replace(",", ""))
            if n >= 100:
                return 2, f"search: ~{n} employees"
            elif n >= 20:
                return 1, f"search: ~{n} employees"
    # Fallback: large facility name signals
    name_lower = name.lower()
    if any(s in name_lower for s in ["distribution center", "fulfillment center", "manufacturing plant", "corporate headquarters"]):
        return 1, "large facility type inferred from name"
    return 0, "no employee count signals"

def score_industrial_contact_access(p):
    """Check 3: Phone, website, email accessibility."""
    phone = (p.get("phone") or "").strip()
    website = (p.get("website") or "").strip()
    contacts = p.get("contacts") or []
    has_email = any(c.get("email") for c in contacts)
    has_phone = bool(phone) or any(c.get("phone") for c in contacts)
    has_website = bool(website)
    score = 0
    parts = []
    if has_phone:
        score += 1
        parts.append("phone")
    if has_website:
        score += 1
        parts.append("website")
    if has_email:
        score += 1
        parts.append("email")
    if score >= 2:
        return 2, "accessible: " + ", ".join(parts)
    elif score >= 1:
        return 1, "limited: " + ", ".join(parts)
    return 0, "no contact info"

def score_industrial_industry_fit(p):
    """Check 4: How well does this industrial vertical fit vending?"""
    name = (p.get("name") or "").lower()
    prop = (p.get("property_type") or "").lower()
    text = name + " " + prop
    # Tier 1: High vending demand (24hr ops, large workforce, no nearby food)
    tier1 = ["warehouse", "distribution center", "fulfillment center",
             "manufacturing", "food processing", "meat processing",
             "cold storage", "bottling", "beverage", "plant "]
    for t in tier1:
        if t in text:
            return 2, f"ideal industrial vertical: {t}"
    # Tier 2: Good vending potential
    tier2 = ["auto repair", "call center", "contact center", "corporate hq",
             "logistics", "supply chain", "wholesale"]
    for t in tier2:
        if t in text:
            return 1, f"acceptable industrial vertical: {t}"
    return 1, "industrial property type"

def score_industrial_operational_intensity(p):
    """Check 5: Multi-shift, 24hr, high-volume operations = high vending demand."""
    name = (p.get("name") or "").lower()
    notes = (p.get("notes") or "").lower()
    text = name + " " + notes
    high_intensity = ["cold storage", "freezer", "24 hour", "24-hour", "24hr",
                      "around the clock", "shift", "three shift", "3 shift",
                      "manufacturing plant", "production facility", "food processing",
                      "meat processing", "distribution center"]
    for s in high_intensity:
        if s in text:
            return 2, f"high-intensity operation: {s}"
    # Check property type as proxy
    prop = (p.get("property_type") or "").lower()
    if any(t in prop for t in ["manufacturing", "warehouse", "distribution"]):
        return 1, f"standard industrial operation: {prop}"
    return 0, "operational intensity unknown"

def score_industrial_online_presence(p):
    """Check 6: Reviews or website (lower bar for industrial)."""
    count = p.get("google_review_count") or 0
    rating = p.get("google_rating") or 0
    website = (p.get("website") or "").strip()
    if count >= 10 and rating >= 3.5:
        return 1, f"decent presence: {count} reviews, {rating}"
    elif count >= 3:
        return 1, f"minimal reviews: {count}"
    elif website:
        return 1, "has website"
    return 0, "no online presence"

def score_industrial_location(p):
    """Check 7: Geocoded location in industrial area."""
    lat = p.get("lat")
    lng = p.get("lng")
    addr = (p.get("address") or "").lower()
    if lat and lng:
        # Industrial park / commerce center signals
        if any(s in addr for s in ["industrial", "commerce", "business park", "corporate", "parkway", "distribution"]):
            return 1, "geocoded in industrial/commercial area"
        return 1, "geocoded address"
    return 0, "not geocoded"

def score_industrial_lead(p):
    """Score an industrial/warehouse/manufacturing lead."""
    details = {}
    details["maps_existence"] = score_industrial_maps_existence(p)
    details["business_size"] = score_industrial_business_size(p)
    details["contact_access"] = score_industrial_contact_access(p)
    details["industry_fit"] = score_industrial_industry_fit(p)
    details["operational_intensity"] = score_industrial_operational_intensity(p)
    details["online_presence"] = score_industrial_online_presence(p)
    details["location"] = score_industrial_location(p)
    total = sum(v[0] for v in details.values())
    if total >= 10:
        tier = "A"
    elif total >= 7:
        tier = "B"
    elif total >= 4:
        tier = "C"
    else:
        tier = "D"
    return total, tier, details, False, ""

def score_lead(p, dry_run=True):
    """Run all 7 checks, return (total_score, tier, details_dict)."""
    # Route industrial leads to industrial rubric
    if is_industrial(p):
        return score_industrial_lead(p)

    details = {}
    details["maps_existence"] = score_maps_existence(p)
    details["maps_reviews"]   = score_maps_reviews(p)
    details["apollo"]         = score_apollo(p, dry_run)
    details["linkedin"]       = score_linkedin(p)
    details["website"]        = score_website(p)
    details["physical"]       = score_physical(p)
    details["foot_traffic"]   = score_foot_traffic(p)

    hard_fail, hf_reason = hard_disqualify(p, details)

    total = sum(v[0] for v in details.values())

    if hard_fail:
        tier = "D"
    elif total >= 10:
        tier = "A"
    elif total >= 7:
        tier = "B"
    elif total >= 4:
        tier = "C"
    else:
        tier = "D"

    return total, tier, details, hard_fail, hf_reason

# ── Scout file parser ─────────────────────────────────────────────────────────
def parse_scout_leads():
    """Parse all scout output files and extract leads not yet in CRM."""
    leads = []
    files = sorted(SCOUT_DIR.glob("leads-*.md")) + sorted(SCOUT_DIR.glob("maps-discovery-*.md"))

    for f in files:
        text = f.read_text(errors="ignore")
        # Extract leads with "not in CRM" status
        blocks = re.split(r'\n### ', text)
        for block in blocks:
            if "not in CRM" not in block and "NEW —" not in block:
                continue
            name_match   = re.match(r'Lead \d+:\s*(.+?)(?:\s*⭐|\s*$)', block.split('\n')[0])
            addr_match   = re.search(r'\*\*Address:\*\*\s*(.+)', block)
            phone_match  = re.search(r'\*\*Phone:\*\*\s*(.+)', block)
            rating_match = re.search(r'\*\*Rating:\*\*\s*([\d.]+)', block)
            review_match = re.search(r'\((\d+)\s*reviews?\)', block)

            if not name_match or not addr_match:
                continue

            leads.append({
                "name":               name_match.group(1).strip(),
                "address":            addr_match.group(1).strip(),
                "phone":              phone_match.group(1).strip() if phone_match else "",
                "google_rating":      float(rating_match.group(1)) if rating_match else 0,
                "google_review_count":int(review_match.group(1)) if review_match else 0,
                "maps_business_status": "OPERATIONAL",
                "status":             "new",
                "property_type":      "",
                "notes":              "",
                "kurtis_notes":       "",
                "last_completed_action": "",
                "contacts":           [],
                "primary_contact":    "",
                "units":              "",
                "lat":                None,
                "lng":                None,
                "_source_file":       f.name,
                "_is_scout":          True,
                "id":                 None,
            })
    # Deduplicate by name
    seen = set()
    deduped = []
    for l in leads:
        key = l["name"].lower().strip()
        if key not in seen:
            seen.add(key)
            deduped.append(l)
    return deduped

# ── Report generator ──────────────────────────────────────────────────────────
def generate_report(results, mode_label):
    lines = [
        f"# Lead Qualification Report — Version 1 (Jarvis)",
        f"_Run: {TODAY} | Mode: {mode_label}_\n",
        f"## Summary",
    ]

    tiers = {"A": [], "B": [], "C": [], "D": []}
    protected_count = 0
    review_list     = []
    auto_remove     = []

    for r in results:
        if r["protected"]:
            protected_count += 1
        elif r["needs_review"]:
            review_list.append(r)
        else:
            tiers[r["tier"]].append(r)
            if r["tier"] == "D" and r["lead"].get("status") == "new":
                auto_remove.append(r)

    total_scored = sum(len(v) for v in tiers.values())
    lines.append(f"- **Protected (untouched):** {protected_count}")
    lines.append(f"- **Flagged for Kurtis review:** {len(review_list)}")
    lines.append(f"- **Scored:** {total_scored}")
    lines.append(f"  - Tier A (Priority, 10-12): {len(tiers['A'])}")
    lines.append(f"  - Tier B (Qualified, 7-9): {len(tiers['B'])}")
    lines.append(f"  - Tier C (Weak, 4-6): {len(tiers['C'])}")
    lines.append(f"  - Tier D (Disqualify, 0-3): {len(tiers['D'])}")
    lines.append(f"- **Auto-remove candidates (Tier D, new, no contact):** {len(auto_remove)}")
    lines.append("")

    # Kurtis review list
    lines.append("## ⚠️ Flagged for Kurtis Review")
    for r in review_list[:30]:
        p = r["lead"]
        lines.append(f"- **{p['name']}** — {r['review_reason']} (score={r['score']}/12, tier={r['tier']})")

    # Top Tier A
    lines.append("\n## 🏆 Top Tier A Leads")
    for r in sorted(tiers["A"], key=lambda x: -x["score"])[:20]:
        p = r["lead"]
        lines.append(f"- **{p['name']}** ({p.get('address','?')}) — score={r['score']}/12")
        for check, (pts, reason) in r["details"].items():
            lines.append(f"  - {check}: {pts}/2 — {reason}")

    # Auto-remove list
    lines.append("\n## 🗑️ Auto-Remove Candidates (Tier D, never contacted)")
    for r in auto_remove[:50]:
        p = r["lead"]
        hf = f" | ⛔ {r['hard_fail_reason']}" if r["hard_fail"] else ""
        lines.append(f"- [{p.get('id','scout')}] **{p['name']}** — score={r['score']}/12{hf}")

    # Score distribution
    lines.append("\n## Score Distribution")
    all_scores = [r["score"] for r in results if not r["protected"] and not r["needs_review"]]
    if all_scores:
        for s in range(13):
            count = all_scores.count(s)
            bar   = "█" * count
            lines.append(f"  {s:2d}: {bar} ({count})")

    return "\n".join(lines)

# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run",     action="store_true", default=True)
    parser.add_argument("--commit",      action="store_true")
    parser.add_argument("--batch",       type=int, default=0)
    parser.add_argument("--crm-only",   action="store_true")
    parser.add_argument("--scout-only", action="store_true")
    args = parser.parse_args()

    if args.commit:
        args.dry_run = False

    mode = "DRY RUN" if args.dry_run else "COMMIT"
    print(f"\n🔍 Lead Qualification v1 — {mode}")
    print(f"   {TODAY}\n")

    leads = []

    # Load CRM leads
    if not args.scout_only:
        print("📥 Loading CRM leads...")
        crm_leads = crm_get("/api/prospects?limit=1000")
        if isinstance(crm_leads, dict):
            crm_leads = crm_leads.get("data", [])
        print(f"   {len(crm_leads)} CRM leads loaded")
        leads.extend(crm_leads)

    # Load stuck scout leads
    if not args.crm_only:
        print("📥 Loading stuck scout leads...")
        scout_leads = parse_scout_leads()
        print(f"   {len(scout_leads)} unique scout leads found")
        leads.extend(scout_leads)

    if args.batch:
        leads = leads[:args.batch]
        print(f"   Limiting to first {args.batch} leads")

    # Pre-compute duplicates across all loaded leads
    print("🔍 Scanning for duplicates...")
    dup_groups = find_duplicates(leads)
    dup_remove_ids = set()  # IDs safe to auto-remove (duplicate without pop-in, other has pop-in)
    dup_report = []
    for norm_name, group in dup_groups.items():
        popin_leads  = [p for p in group if has_popin(p)]
        no_popin     = [p for p in group if not has_popin(p)]
        if popin_leads and no_popin:
            # Safe to remove the no-pop-in duplicates
            for p in no_popin:
                if p.get("id"):
                    dup_remove_ids.add(p["id"])
            dup_report.append({
                "name": group[0]["name"], "keep": popin_leads, "remove": no_popin
            })
        else:
            # Both/neither have pop-in — flag for Kurtis
            dup_report.append({
                "name": group[0]["name"], "keep": [], "remove": [], "flag": group
            })
    print(f"   Found {len(dup_groups)} duplicate groups, {len(dup_remove_ids)} safe to remove\n")

    print(f"🧮 Processing {len(leads)} total leads...\n")

    results = []
    for i, p in enumerate(leads):
        name   = p.get("name", "?")
        prefix = "📌" if p.get("_is_scout") else f"[{p.get('id','?')}]"
        print(f"  {i+1}/{len(leads)} {prefix} {name[:45]}...", end=" ", flush=True)

        # Duplicate safe-remove check
        if p.get("id") in dup_remove_ids:
            print(f"  {i+1}/{len(leads)} [{p.get('id')}] {name[:45]}... 🗑️  DUPLICATE (no pop-in, keeping sibling with pop-in)")
            results.append({"lead": p, "protected": False, "needs_review": False,
                            "score": 0, "tier": "D", "details": {},
                            "hard_fail": True, "hard_fail_reason": "duplicate_no_popin",
                            "review_reason": "", "auto_remove": True})
            continue

        # Protection check
        prot, prot_reason = is_protected(p)
        if prot:
            print(f"🛡️  PROTECTED ({prot_reason})")
            results.append({"lead": p, "protected": True, "needs_review": False,
                            "score": None, "tier": None, "details": {},
                            "hard_fail": False, "hard_fail_reason": "",
                            "review_reason": ""})
            continue

        # Review flag check
        rev, rev_reason = needs_review(p)
        if rev:
            # Still score it, but flag
            score, tier, details, hf, hf_reason = score_lead(p, args.dry_run)
            print(f"⚠️  REVIEW ({rev_reason}) score={score}/12 tier={tier}")
            results.append({"lead": p, "protected": False, "needs_review": True,
                            "score": score, "tier": tier, "details": details,
                            "hard_fail": hf, "hard_fail_reason": hf_reason,
                            "review_reason": rev_reason})
            continue

        # Full score
        score, tier, details, hf, hf_reason = score_lead(p, args.dry_run)
        tier_emoji = {"A": "🏆", "B": "✅", "C": "⚠️", "D": "🗑️"}.get(tier, "?")
        hf_note    = f" ⛔{hf_reason[:30]}" if hf else ""
        print(f"{tier_emoji} {tier} {score}/12{hf_note}")

        results.append({"lead": p, "protected": False, "needs_review": False,
                        "score": score, "tier": tier, "details": details,
                        "hard_fail": hf, "hard_fail_reason": hf_reason,
                        "review_reason": ""})

        # Commit: update CRM if not scout lead
        if not args.dry_run and not p.get("_is_scout") and p.get("id"):
            qual_note = f"[QUAL-V1: score={score}/12 tier={tier} date={TODAY}]"
            if hf:
                qual_note += f" HARD_FAIL: {hf_reason}"
            existing_notes = p.get("notes") or ""
            # Remove old qual note if present
            existing_notes = re.sub(r'\[QUAL-V1:.*?\]', '', existing_notes).strip()
            new_notes = f"{existing_notes}\n{qual_note}".strip()
            try:
                crm_put(f"/api/prospects/{p['id']}", {"notes": new_notes})
            except Exception as e:
                print(f"    ⚠️ CRM update failed: {e}")

        time.sleep(0.1)

    # Generate report
    report = generate_report(results, mode)
    out_path = OUTPUT_DIR / f"qual-v1-{TODAY}.md"
    out_path.write_text(report)
    print(f"\n📊 Report saved: {out_path}")
    print("\n" + report[:2000])

if __name__ == "__main__":
    main()
