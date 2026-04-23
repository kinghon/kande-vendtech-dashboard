#!/usr/bin/env python3
"""
Lead Qualification Reanalysis — Version 2 (GLM-inspired, Jarvis corrected)
Same goal as v1: verify lead quality. Different signals.

V1 checks: Maps existence, Maps reviews, Apollo/contacts, LinkedIn, Website, Physical
V2 checks: Decision-maker quality, Business tenure/stability, Industry fit,
           Contact completeness, CRM engagement history, Organizational depth

Usage:
  python3 lead-qual-v2.py --dry-run              # report only
  python3 lead-qual-v2.py --dry-run --batch 20   # test on 20 leads
  python3 lead-qual-v2.py --commit               # write scores to CRM
"""

import json, sys, time, re, argparse, datetime, os, urllib.request, urllib.parse, gzip
from pathlib import Path

# ── Config ──────────────────────────────────────────────────────────────────
CRM_BASE  = "https://vend.kandedash.com"
CRM_KEY   = "kande2026"
BRAVE_KEY = "BSA8enLl2f0NW0JBRjem3n4eNpiNzbz"
TODAY     = datetime.date.today().isoformat()
SLEEP_S   = 0.4
OUTPUT_DIR = Path("/Users/kurtishon/clawd/agent-output/scout")

# ── HTTP helpers ─────────────────────────────────────────────────────────────
def crm_get(path):
    req = urllib.request.Request(f"{CRM_BASE}{path}", headers={"x-api-key": CRM_KEY})
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read())

def crm_put(path, data):
    body = json.dumps(data).encode()
    req  = urllib.request.Request(f"{CRM_BASE}{path}", data=body, method="PUT",
           headers={"x-api-key": CRM_KEY, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read())

def brave_search(query, count=3):
    q   = urllib.parse.quote(query)
    url = f"https://api.search.brave.com/res/v1/web/search?q={q}&count={count}"
    req = urllib.request.Request(url, headers={
        "Accept": "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": BRAVE_KEY
    })
    try:
        with urllib.request.urlopen(req, timeout=8) as r:
            raw = r.read()
            if r.info().get("Content-Encoding") == "gzip":
                raw = gzip.decompress(raw)
            return json.loads(raw)
    except Exception as e:
        return {"error": str(e)}

# ── Protection checks ─────────────────────────────────────────────────────────
POPIN_TERMS = ["pop in", "popped in", "visited", "in person", "stop by",
               "stopped by", "dropped by"]

def is_protected(p):
    status = (p.get("status") or "").lower()
    if status in ("signed", "negotiating"):
        return True, f"status={status}"
    lca = (p.get("last_completed_action") or "").lower()
    if "pop in" in lca or "pop-in" in lca:
        return True, "last_completed_action=Pop In"
    notes_blob = " ".join([(p.get("notes") or ""), (p.get("kurtis_notes") or "")]).lower()
    for t in POPIN_TERMS:
        if t in notes_blob:
            return True, f"notes contain '{t}'"
    return False, ""

def needs_review(p):
    status = (p.get("status") or "").lower()
    kurtis_notes = (p.get("kurtis_notes") or "").strip()
    source = (p.get("source") or "").lower()
    if kurtis_notes:
        return True, "manually added (kurtis_notes present)"
    if source == "manual":
        return True, "source=manual"
    opens = sum(e.get("num_opens", 0) for e in (p.get("email_tracking") or []))
    if status == "proposal_sent" and opens > 0:
        return True, f"proposal_sent with {opens} email opens"
    if status in ("active", "meeting_scheduled"):
        return True, f"status={status}"
    return False, ""

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

# ── Check 1: Decision-Maker Quality ─────────────────────────────────────────
DECISION_MAKER_TITLES = [
    "owner", "president", "ceo", "general manager", "gm", "property manager",
    "director", "vp ", "vice president", "manager", "administrator", "supervisor",
    "regional", "corporate", "facilities", "operations"
]
BAD_TITLES = ["front desk", "receptionist", "leasing agent", "leasing consultant",
              "maintenance", "housekeeper", "security"]

def score_decision_maker(p):
    """Check 1: Is there a real decision-maker contact?"""
    contacts = p.get("contacts") or []
    primary  = (p.get("primary_contact") or "").lower()

    # Check primary contact field first
    for title in DECISION_MAKER_TITLES:
        if title in primary:
            return 2, f"primary contact has decision-maker title: {primary[:40]}"

    if not contacts:
        # No contacts but check notes for name drops
        notes = (p.get("notes") or "").lower()
        if any(t in notes for t in ["manager", "owner", "director", "gm"]):
            return 1, "decision-maker mentioned in notes but no contact record"
        return 0, "no contacts and no decision-maker in notes"

    best_score = 0
    best_reason = "contacts found but no decision-maker titles"
    for c in contacts:
        role  = (c.get("role") or c.get("title") or "").lower()
        name  = (c.get("name") or "").strip()
        email = (c.get("email") or "").strip()
        phone = (c.get("phone") or "").strip()

        if any(t in role for t in BAD_TITLES):
            continue
        if any(t in role for t in DECISION_MAKER_TITLES):
            if email or phone:
                return 2, f"decision-maker with contact info: {name} ({role})"
            best_score = max(best_score, 1)
            best_reason = f"decision-maker found but no email/phone: {name} ({role})"

    return best_score, best_reason

# ── Check 2: Business Tenure & Stability ─────────────────────────────────────
def score_tenure(p):
    """Check 2: Is this an established, stable business?"""
    name   = (p.get("name") or "").strip()
    rating = p.get("google_rating") or 0
    count  = p.get("google_review_count") or 0
    status = (p.get("maps_business_status") or "").upper()

    if status == "CLOSED_PERMANENTLY":
        return 0, "permanently closed"

    # Review history = proxy for how long they've been open
    # A business with 200+ reviews has been around a while
    if count >= 200 and rating >= 4.0:
        return 2, f"established business: {count} reviews, {rating}★"
    elif count >= 50:
        return 1, f"some history: {count} reviews, {rating}★"

    # Search for establishment year as fallback
    results = brave_search(f'"{name}" Las Vegas established founded since', count=2)
    time.sleep(SLEEP_S)
    hits = results.get("web", {}).get("results", [])
    for hit in hits:
        desc = hit.get("description", "")
        year_match = re.search(r'\b(19[5-9]\d|200\d|201\d|202[0-3])\b', desc)
        if year_match:
            year = int(year_match.group(1))
            age  = 2026 - year
            if age >= 5:
                return 2, f"established since ~{year} ({age} years)"
            elif age >= 2:
                return 1, f"relatively new (~{year}, {age} years)"

    if count > 0:
        return 1, f"limited history: only {count} reviews"
    return 0, "no tenure signals found"

# ── Check 3: Industry Fit Score ───────────────────────────────────────────────
TIER1_TYPES = ["apartment", "gym", "fitness", "warehouse", "industrial", "medical",
               "hospital", "clinic", "office", "corporate", "hotel", "motel",
               "senior", "school", "university", "college", "government"]
TIER2_TYPES = ["storage", "auto", "salon", "spa", "retail", "shopping"]
BAD_TYPES   = ["restaurant", "bar", "nightclub", "casino", "food", "bakery",
               "grocery", "general contractor", "homebuilder", "law firm",
               "attorney", "insurance", "mortgage", "hair salon", "nail salon",
               "barbershop", "tattoo", "pet grooming"]

def score_industry_fit(p):
    """Check 3: Is this the right type of location for vending?"""
    prop  = (p.get("property_type") or "").lower()
    name  = (p.get("name") or "").lower()
    notes = (p.get("notes") or "").lower()

    # Hard fail on bad types
    for bt in BAD_TYPES:
        if bt in name or bt in prop:
            return 0, f"bad industry type: {bt}"

    # Check property_type field
    for t in TIER1_TYPES:
        if t in prop:
            return 2, f"ideal property type: {prop}"

    for t in TIER2_TYPES:
        if t in prop:
            return 1, f"acceptable property type: {prop}"

    # Check name for industry signals
    for t in TIER1_TYPES:
        if t in name:
            return 2, f"name suggests ideal type: {t}"

    # Check units as proxy for apartment/residential
    units = str(p.get("units") or "")
    nums  = re.findall(r'\d+', units)
    if nums and int(nums[0]) >= 50:
        return 2, f"large unit count ({nums[0]}) suggests apartment/commercial"
    elif nums and int(nums[0]) >= 10:
        return 1, f"medium unit count ({nums[0]})"

    if prop:
        return 1, f"property type present but unclear fit: {prop}"
    return 0, "no property type data"

# ── Check 4: Contact Completeness ─────────────────────────────────────────────
def score_contact_completeness(p):
    """Check 4: How complete is the contact information?"""
    phone    = (p.get("phone") or "").strip()
    contacts = p.get("contacts") or []
    primary  = (p.get("primary_contact") or "").strip()

    contact_emails = [c.get("email") for c in contacts if c.get("email")]
    contact_phones = [c.get("phone") for c in contacts if c.get("phone")]
    contact_names  = [c.get("name")  for c in contacts if c.get("name")]

    has_business_phone  = bool(phone)
    has_contact_email   = bool(contact_emails)
    has_contact_phone   = bool(contact_phones)
    has_named_contact   = bool(contact_names or primary)

    score  = 0
    parts  = []

    if has_named_contact:
        score += 1
        parts.append("named contact")
    if has_business_phone or has_contact_phone:
        score += 1
        parts.append("phone")
    if has_contact_email:
        score += 1
        parts.append("email")

    if score >= 3:
        return 2, "complete: " + ", ".join(parts)
    elif score >= 2:
        return 1, "partial: " + ", ".join(parts)
    elif score == 1:
        return 0, "minimal: " + ", ".join(parts)
    return 0, "no contact info"

# ── Check 5: CRM Engagement History ──────────────────────────────────────────
def score_engagement(p):
    """Check 5: Has there been meaningful engagement with this lead?"""
    activities     = p.get("activities") or []
    email_tracking = p.get("email_tracking") or []
    status         = (p.get("status") or "").lower()
    lca            = (p.get("last_completed_action") or "").lower()
    created        = p.get("created_at") or ""

    total_opens   = sum(e.get("num_opens", 0) for e in email_tracking)
    activity_count = len(activities)

    # High engagement signals
    if status in ("proposal_sent", "active", "meeting_scheduled"):
        return 2, f"actively engaged: status={status}, {total_opens} opens"

    if total_opens >= 3:
        return 2, f"{total_opens} email opens — strong interest signal"

    if activity_count >= 3 or total_opens >= 1:
        return 1, f"{activity_count} activities, {total_opens} opens"

    # Check if lead was recently added (new lead = unknown engagement)
    if created:
        try:
            created_date = datetime.date.fromisoformat(created[:10])
            age_days = (datetime.date.today() - created_date).days
            if age_days <= 30:
                return 1, f"recently added ({age_days} days ago) — no engagement yet"
        except:
            pass

    if lca and lca not in ("", "none"):
        return 1, f"has activity history: {lca[:30]}"

    return 0, "no engagement history"

# ── Check 6: Organizational Depth ─────────────────────────────────────────────
def score_org_depth(p):
    """Check 6: Is this a real organization with multiple people / locations?"""
    name    = (p.get("name") or "").strip()
    address = (p.get("address") or "").strip()

    # Chain / multi-location signals in the name
    chain_signals = ["group", "management", "properties", "enterprises", "holdings",
                     "partners", "associates", "corp", "inc", "llc", "systems",
                     "solutions", "services", "network", "international", "national"]
    name_lower = name.lower()
    for sig in chain_signals:
        if sig in name_lower:
            return 2, f"org name suggests established company: '{sig}' in name"

    # Brave search for employee count / company size
    results = brave_search(f'"{name}" Las Vegas employees staff team size', count=2)
    time.sleep(SLEEP_S)
    hits = results.get("web", {}).get("results", [])
    for hit in hits:
        desc = hit.get("description", "")
        emp_match = re.search(r'(\d[\d,]+)\s*(employees|staff|team members|workers)', desc, re.I)
        if emp_match:
            n = int(emp_match.group(1).replace(",", ""))
            if n >= 50:
                return 2, f"significant org: ~{n} employees"
            elif n >= 10:
                return 1, f"small org: ~{n} employees"

    # Geocoded address = some verification of physical org
    if p.get("lat") and p.get("lng"):
        return 1, "geocoded address — confirmed physical location"

    if address:
        return 1, "has address but not geocoded"

    return 0, "no org depth signals"

# ── Industrial-specific v2 scoring ──────────────────────────────────────────

INDUSTRIAL_DECISION_TITLES = [
    "owner", "president", "ceo", "general manager", "gm", "facility manager",
    "facilities manager", "operations manager", "warehouse manager",
    "plant manager", "production manager", "director", "vp ", "vice president",
    "supervisor", "administrator"
]

def score_industrial_decision_maker(p):
    """Check 1: Can we reach a facilities/operations decision-maker?"""
    contacts = p.get("contacts") or []
    primary = (p.get("primary_contact") or "").lower()
    for title in INDUSTRIAL_DECISION_TITLES:
        if title in primary:
            return 2, f"primary contact has decision-maker title: {primary[:40]}"
    if not contacts:
        notes = (p.get("notes") or "").lower()
        if any(t in notes for t in ["manager", "owner", "director", "supervisor"]):
            return 1, "decision-maker mentioned in notes but no contact record"
        # Industrial leads often lack named contacts initially
        phone = (p.get("phone") or "").strip()
        if phone:
            return 1, "business phone available, no named contact yet"
        return 0, "no contacts or phone"
    best_score = 0
    best_reason = "contacts found but no decision-maker titles"
    for c in contacts:
        role = (c.get("role") or c.get("title") or "").lower()
        name = (c.get("name") or "").strip()
        email = (c.get("email") or "").strip()
        phone = (c.get("phone") or "").strip()
        if any(t in role for t in BAD_TITLES):
            continue
        if any(t in role for t in INDUSTRIAL_DECISION_TITLES):
            if email or phone:
                return 2, f"decision-maker with contact info: {name} ({role})"
            best_score = max(best_score, 1)
            best_reason = f"decision-maker found but no email/phone: {name} ({role})"
    return best_score, best_reason

def score_industrial_tenure(p):
    """Check 2: Established business (lower bar for industrial)."""
    name = (p.get("name") or "").strip()
    rating = p.get("google_rating") or 0
    count = p.get("google_review_count") or 0
    status = (p.get("maps_business_status") or "").upper()
    if status == "CLOSED_PERMANENTLY":
        return 0, "permanently closed"
    # Industrial businesses often have few reviews
    if count >= 20 and rating >= 3.5:
        return 2, f"established: {count} reviews, {rating}"
    elif count >= 5:
        return 1, f"some presence: {count} reviews"
    # Search for establishment year
    results = brave_search(f'"{name}" Las Vegas established founded since', count=2)
    time.sleep(SLEEP_S)
    hits = results.get("web", {}).get("results", [])
    for hit in hits:
        desc = hit.get("description", "")
        m = re.search(r'\b(19[5-9]\d|200\d|201\d|202[0-3])\b', desc)
        if m:
            year = int(m.group(1))
            age = 2026 - year
            if age >= 5:
                return 2, f"established since ~{year} ({age} years)"
            elif age >= 2:
                return 1, f"relatively new (~{year}, {age} years)"
    if count > 0:
        return 1, f"limited history: {count} reviews"
    # Industrial businesses often have no Maps reviews but are real
    phone = (p.get("phone") or "").strip()
    if phone:
        return 1, "no reviews but has business phone"
    return 0, "no tenure signals"

def score_industrial_fit(p):
    """Check 3: Industrial vertical fit for vending."""
    prop = (p.get("property_type") or "").lower()
    name = (p.get("name") or "").lower()
    text = name + " " + prop
    tier1 = ["warehouse", "distribution center", "fulfillment center",
             "manufacturing", "food processing", "meat processing",
             "cold storage", "bottling", "beverage", "plant "]
    for t in tier1:
        if t in text:
            return 2, f"ideal industrial vertical: {t}"
    tier2 = ["auto repair", "call center", "contact center", "corporate hq",
             "logistics", "supply chain", "wholesale", "industrial"]
    for t in tier2:
        if t in text:
            return 1, f"acceptable industrial vertical: {t}"
    return 1, "industrial property"

def score_industrial_contact(p):
    """Check 4: Contact completeness for industrial (lower bar)."""
    phone = (p.get("phone") or "").strip()
    contacts = p.get("contacts") or []
    has_phone = bool(phone) or any(c.get("phone") for c in contacts)
    has_email = any(c.get("email") for c in contacts)
    has_name = bool((p.get("primary_contact") or "").strip()) or any(c.get("name") for c in contacts)
    score = 0
    parts = []
    if has_name:
        score += 1
        parts.append("named contact")
    if has_phone:
        score += 1
        parts.append("phone")
    if has_email:
        score += 1
        parts.append("email")
    if score >= 3:
        return 2, "complete: " + ", ".join(parts)
    elif score >= 2:
        return 1, "partial: " + ", ".join(parts)
    elif score >= 1:
        return 1, "minimal: " + ", ".join(parts)
    return 0, "no contact info"

def score_industrial_engagement(p):
    """Check 5: CRM engagement (same logic as standard)."""
    return score_engagement(p)

def score_industrial_org_depth(p):
    """Check 6: Organization depth for industrial."""
    name = (p.get("name") or "").strip()
    # Multi-location / chain signals
    chain_signals = ["group", "enterprises", "holdings", "corp", "inc", "llc",
                     "systems", "solutions", "network", "national", "regional"]
    for sig in chain_signals:
        if sig in name.lower():
            return 2, f"org name suggests established company: '{sig}'"
    # Employee search
    results = brave_search(f'"{name}" Las Vegas employees staff team size', count=2)
    time.sleep(SLEEP_S)
    hits = results.get("web", {}).get("results", [])
    for hit in hits:
        desc = hit.get("description", "")
        m = re.search(r'(\d[\d,]+)\s*(employees|staff|team members|workers)', desc, re.I)
        if m:
            n = int(m.group(1).replace(",", ""))
            if n >= 50:
                return 2, f"significant org: ~{n} employees"
            elif n >= 10:
                return 1, f"small org: ~{n} employees"
    # Geocoded = real physical location
    if p.get("lat") and p.get("lng"):
        return 1, "geocoded address — confirmed physical location"
    if p.get("address"):
        return 1, "has address"
    return 0, "no org depth signals"

def score_industrial_lead_v2(p):
    """Score an industrial lead using v2-style 6-check rubric."""
    details = {}
    details["decision_maker"] = score_industrial_decision_maker(p)
    details["tenure"] = score_industrial_tenure(p)
    details["industry_fit"] = score_industrial_fit(p)
    details["contact_complete"] = score_industrial_contact(p)
    details["engagement"] = score_industrial_engagement(p)
    details["org_depth"] = score_industrial_org_depth(p)
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

# ── Hard disqualifiers ─────────────────────────────────────────────────────────
def hard_disqualify(p):
    status = (p.get("maps_business_status") or "").upper()
    rating = p.get("google_rating") or 0
    name   = (p.get("name") or "").lower()

    if status == "CLOSED_PERMANENTLY":
        return True, "permanently closed"
    for bt in BAD_TYPES:
        if bt in name:
            return True, f"bad business type: {bt}"
    return False, ""

# ── Duplicate detection ───────────────────────────────────────────────────────
def normalize_name(name):
    n = (name or "").lower().strip()
    for strip in ["apartments", "apartment", "llc", "inc", "corp", "ltd", "the ",
                  " las vegas", " henderson", " nv", "(", ")"]:
        n = n.replace(strip, "")
    return re.sub(r'\s+', ' ', n).strip()

def has_popin(p):
    lca   = (p.get("last_completed_action") or "").lower()
    notes = " ".join([(p.get("notes") or ""), (p.get("kurtis_notes") or "")]).lower()
    return ("pop in" in lca or "pop-in" in lca or
            any(t in notes for t in POPIN_TERMS))

def find_duplicates(leads):
    groups = {}
    for p in leads:
        key = normalize_name(p.get("name", ""))
        groups.setdefault(key, []).append(p)
    return {k: v for k, v in groups.items() if len(v) > 1}

# ── Main scorer ───────────────────────────────────────────────────────────────
def score_lead(p):
    # Route industrial leads to industrial rubric
    if is_industrial(p):
        return score_industrial_lead_v2(p)

    details = {}
    details["decision_maker"]  = score_decision_maker(p)
    details["tenure"]          = score_tenure(p)
    details["industry_fit"]    = score_industry_fit(p)
    details["contact_complete"]= score_contact_completeness(p)
    details["engagement"]      = score_engagement(p)
    details["org_depth"]       = score_org_depth(p)

    hf, hf_reason = hard_disqualify(p)
    total = sum(v[0] for v in details.values())

    if hf:
        tier = "D"
    elif total >= 10:
        tier = "A"
    elif total >= 7:
        tier = "B"
    elif total >= 4:
        tier = "C"
    else:
        tier = "D"

    return total, tier, details, hf, hf_reason

# ── Report ────────────────────────────────────────────────────────────────────
def generate_report(results, mode_label):
    lines = [
        f"# Lead Qualification Report — Version 2 (GLM-inspired)",
        f"_Run: {TODAY} | Mode: {mode_label}_\n",
        "## Scoring Dimensions",
        "V2 checks: decision-maker quality, business tenure, industry fit, contact completeness, engagement history, org depth\n",
        "## Summary",
    ]

    tiers = {"A": [], "B": [], "C": [], "D": []}
    protected, review_list, auto_remove = [], [], []

    for r in results:
        if r["protected"]:
            protected.append(r)
        elif r["needs_review"]:
            review_list.append(r)
        else:
            tiers[r["tier"]].append(r)
            if r["tier"] == "D" and (r["lead"].get("status") or "new") == "new":
                auto_remove.append(r)

    total_scored = sum(len(v) for v in tiers.values())
    lines += [
        f"- **Protected (untouched):** {len(protected)}",
        f"- **Flagged for Kurtis review:** {len(review_list)}",
        f"- **Scored:** {total_scored}",
        f"  - Tier A (10-12): {len(tiers['A'])}",
        f"  - Tier B (7-9): {len(tiers['B'])}",
        f"  - Tier C (4-6): {len(tiers['C'])}",
        f"  - Tier D (0-3): {len(tiers['D'])}",
        f"- **Auto-remove candidates:** {len(auto_remove)}\n",
    ]

    lines.append("## ⚠️ Flagged for Review")
    for r in review_list[:30]:
        p = r["lead"]
        lines.append(f"- **{p['name']}** — {r['review_reason']} (score={r['score']}/12, tier={r['tier']})")

    lines.append("\n## 🏆 Top Tier A Leads")
    for r in sorted(tiers["A"], key=lambda x: -x["score"])[:20]:
        p = r["lead"]
        lines.append(f"- **{p['name']}** ({p.get('address','?')}) — score={r['score']}/12")
        for check, (pts, reason) in r["details"].items():
            lines.append(f"  - {check}: {pts}/2 — {reason}")

    lines.append("\n## 🗑️ Auto-Remove Candidates")
    for r in auto_remove[:50]:
        p = r["lead"]
        hf = f" | ⛔ {r['hard_fail_reason']}" if r["hard_fail"] else ""
        lines.append(f"- [{p.get('id','?')}] **{p['name']}** — score={r['score']}/12{hf}")

    lines.append("\n## Score Distribution")
    all_scores = [r["score"] for r in results if not r["protected"] and not r["needs_review"]]
    if all_scores:
        for s in range(13):
            count = all_scores.count(s)
            if count:
                lines.append(f"  {s:2d}: {'█' * min(count, 40)} ({count})")

    return "\n".join(lines)

# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run",  action="store_true", default=True)
    parser.add_argument("--commit",   action="store_true")
    parser.add_argument("--batch",    type=int, default=0)
    args = parser.parse_args()
    if args.commit:
        args.dry_run = False

    mode = "DRY RUN" if args.dry_run else "COMMIT"
    print(f"\n🔍 Lead Qualification v2 — {mode}\n   {TODAY}\n")

    print("📥 Loading CRM leads...")
    leads = crm_get("/api/prospects?limit=1000")
    if isinstance(leads, dict):
        leads = leads.get("data", [])
    print(f"   {len(leads)} leads loaded")

    if args.batch:
        leads = leads[:args.batch]
        print(f"   Limiting to {args.batch}")

    # Duplicate detection
    print("🔍 Scanning for duplicates...")
    dup_groups    = find_duplicates(leads)
    dup_remove_ids = set()
    for group in dup_groups.values():
        popin_leads = [p for p in group if has_popin(p)]
        no_popin    = [p for p in group if not has_popin(p)]
        if popin_leads and no_popin:
            for p in no_popin:
                if p.get("id"):
                    dup_remove_ids.add(p["id"])
    print(f"   {len(dup_groups)} dup groups, {len(dup_remove_ids)} safe to remove\n")

    print(f"🧮 Processing {len(leads)} leads...\n")
    results = []

    for i, p in enumerate(leads):
        name = p.get("name", "?")
        print(f"  {i+1}/{len(leads)} [{p.get('id','?')}] {name[:45]}...", end=" ", flush=True)

        if p.get("id") in dup_remove_ids:
            print("🗑️  DUPLICATE")
            results.append({"lead": p, "protected": False, "needs_review": False,
                            "score": 0, "tier": "D", "details": {},
                            "hard_fail": True, "hard_fail_reason": "duplicate",
                            "review_reason": "", "auto_remove": True})
            continue

        prot, prot_reason = is_protected(p)
        if prot:
            print(f"🛡️  PROTECTED ({prot_reason})")
            results.append({"lead": p, "protected": True, "needs_review": False,
                            "score": None, "tier": None, "details": {},
                            "hard_fail": False, "hard_fail_reason": "",
                            "review_reason": ""})
            continue

        rev, rev_reason = needs_review(p)
        score, tier, details, hf, hf_reason = score_lead(p)

        if rev:
            print(f"⚠️  REVIEW ({rev_reason}) score={score}/12 tier={tier}")
            results.append({"lead": p, "protected": False, "needs_review": True,
                            "score": score, "tier": tier, "details": details,
                            "hard_fail": hf, "hard_fail_reason": hf_reason,
                            "review_reason": rev_reason})
        else:
            emoji = {"A": "🏆", "B": "✅", "C": "⚠️", "D": "🗑️"}.get(tier, "?")
            hf_note = f" ⛔{hf_reason[:30]}" if hf else ""
            print(f"{emoji} {tier} {score}/12{hf_note}")
            results.append({"lead": p, "protected": False, "needs_review": False,
                            "score": score, "tier": tier, "details": details,
                            "hard_fail": hf, "hard_fail_reason": hf_reason,
                            "review_reason": ""})

        if not args.dry_run and not p.get("_is_scout") and p.get("id"):
            try:
                crm_put(f"/api/prospects/{p['id']}", {
                    "qual_v2_score": score,
                    "qual_v2_tier":  tier
                })
            except Exception as e:
                print(f"    ⚠️ CRM update failed: {e}")

        time.sleep(0.05)

    report = generate_report(results, mode)
    out    = OUTPUT_DIR / f"qual-v2-{TODAY}.md"
    out.write_text(report)
    print(f"\n📊 Report: {out}")
    print("\n" + report[:2000])

if __name__ == "__main__":
    main()
