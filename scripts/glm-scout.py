#!/usr/bin/env python3
"""
glm-scout.py — GLM lead discovery via Brave web search.
Different from Kimi K2.6's Google Maps approach: uses web search to find
businesses by category, cross-checks against CRM, qualifies A/B candidates.
Logs source=glm-scout for daily comparison.
"""

import json, os, sys, datetime, urllib.request, urllib.parse, time, re
from pathlib import Path

import sys, os
sys.path.insert(0, "/Users/kurtishon/clawd/scripts")
from job_lock import acquire_job_lock

acquire_job_lock("glm-scout")


CRM_BASE   = "https://vend.kandedash.com"
CRM_KEY    = "kande2026"
BRAVE_KEY  = "BSA8enLl2f0NW0JBRjem3n4eNpiNzbz"
GLM_URL    = "http://192.168.1.52:52415/v1/chat/completions"
GLM_MODEL  = "GLM-5.1-UD-IQ4_XS-00001-of-00009.gguf"
LOG        = Path("/Users/kurtishon/clawd/logs/glm-scout.log")
STATE_FILE = Path("/Users/kurtishon/clawd/logs/glm-scout-state.json")

TODAY = datetime.date.today().isoformat()
SLEEP_S = 1.5

# Search queries — different from Kimi K2.6's Google Maps categories
SEARCH_QUERIES = [
    # === ORIGINAL QUERIES ===
    "new apartment complex opening 2025 2026 Las Vegas NV site:apartments.com OR site:rent.com",
    "car wash locations Las Vegas Henderson NV",
    "bowling alley Las Vegas Henderson NV",
    "movie theater Las Vegas NV AMC Regal Cinemark",
    "casino resort hotel Las Vegas employee services workforce",
    "convention center event venue Las Vegas Henderson NV",
    "trade school vocational college Las Vegas NV",
    "Amazon warehouse distribution Las Vegas North Las Vegas NV",
    "cannabis dispensary Las Vegas Henderson NV",
    "airport FBO private aviation Las Vegas Henderson NV",
    "hospital medical center Las Vegas 2025 new opening",
    "mixed use development office Las Vegas 2025 2026",
    "logistics fulfillment center North Las Vegas NV 2025",
    "auto repair shop service center Las Vegas Henderson NV",
    "urgent care clinic Las Vegas Henderson NV new location",
    "corporate office park campus Las Vegas Henderson Summerlin",
    "tech company office Las Vegas NV headquarters",
    "government building Clark County Las Vegas NV",
    "university college student housing Las Vegas UNLV CSN",
    "hotel resort workforce employee cafeteria Las Vegas Strip",
    # === EXPANDED QUERIES — added 2026-04-19 ===
    # Niche commercial
    "laundromat coin laundry Las Vegas Henderson NV",
    "self storage facility Las Vegas Henderson NV large",
    "gun range shooting range Las Vegas Henderson NV",
    "country club golf course Las Vegas Henderson Summerlin NV",
    "luxury car dealership Las Vegas Henderson NV",
    "brewery winery distillery Las Vegas Henderson NV",
    "co-working space shared office Las Vegas Henderson NV",
    "charter school private school Las Vegas Henderson NV large",
    "rehab center addiction treatment Las Vegas Henderson NV",
    "dialysis center Las Vegas Henderson NV",
    "physical therapy outpatient clinic Las Vegas Henderson NV",
    "veterinary hospital animal clinic Las Vegas Henderson NV large",
    # Workforce/industrial
    "data center tech facility Las Vegas Henderson North Las Vegas NV",
    "manufacturing plant factory Las Vegas North Las Vegas NV",
    "food processing facility Las Vegas Henderson NV",
    "cold storage refrigerated warehouse Las Vegas North Las Vegas NV",
    "truck stop travel plaza Las Vegas I-15 NV",
    "construction company office yard Las Vegas Henderson NV large",
    "staffing agency temp agency Las Vegas Henderson NV",
    # Multi-unit residential
    "senior living assisted living memory care Henderson Las Vegas NV",
    "student housing apartments UNLV CSN Nevada State Las Vegas NV",
    "extended stay hotel Las Vegas Henderson NV",
    "furnished apartment corporate housing Las Vegas Henderson NV",
    # Recreation
    "fitness gym 24 hour Las Vegas Henderson NV",
    "trampoline park entertainment center Las Vegas Henderson NV",
    "sports complex athletic facility Las Vegas Henderson NV",
    "indoor rock climbing Las Vegas Henderson NV",
    # New development pipeline
    "new commercial development Las Vegas Henderson 2026 opening construction",
    "new office building Las Vegas Henderson 2025 2026 under construction",
    "Clark County business license new location Las Vegas 2025 2026",
    "new employer hiring Las Vegas Henderson 2026 100 employees",
    # === MISSED CATEGORY EXPANSION — added 2026-04-25 ===
    # Event/AV production companies
    "event production company AV audio visual Las Vegas NV warehouse office",
    "convention services trade show company Las Vegas NV large workforce",
    # Gaming technology & manufacturing
    "gaming technology company Las Vegas NV office headquarters employees",
    "slot machine gaming equipment manufacturer Las Vegas Henderson NV",
    # Auction houses & retail liquidation
    "auction house retail returns liquidation Las Vegas Henderson NV",
    "estate auction house Las Vegas North Las Vegas NV large facility",
    # Food & beverage distribution
    "food distribution warehouse Las Vegas NV Starbucks McDonald's foodservice",
    "beverage distribution cold storage warehouse Las Vegas North Las Vegas NV",
    # Athletic & martial arts training
    "MMA martial arts training facility gym Las Vegas NV professional",
    "sports performance institute training center Las Vegas NV athletes",
    "boxing gym combat sports Las Vegas NV large",
    # Landscape & building supply warehouses
    "landscape supply artificial turf warehouse Las Vegas NV",
    "building material supply warehouse Las Vegas Henderson NV large",
    # Nursing & medical colleges
    "nursing school BSN program college Las Vegas NV campus students",
    "medical assistant dental healthcare college Las Vegas Henderson NV",
    "private career college vocational Las Vegas NV 200+ students",
    # Property management portfolio targets
    "Ovation Property Management apartments Las Vegas Henderson NV",
    "Calida Group apartments Las Vegas Henderson NV",
    "Vestar luxury apartments Las Vegas NV new complex",
]

# How many consecutive zero-result runs before entering stall mode
STALL_THRESHOLD = 5
# In stall mode, queries get a freshness suffix to find newer content
STALL_SUFFIXES = [
    "new location 2026",
    "opening soon Henderson Las Vegas",
    "hiring employees Las Vegas 2026",
    "just opened Las Vegas NV",
]

def log(msg):
    ts = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{ts}] {msg}"
    print(line)
    LOG.parent.mkdir(parents=True, exist_ok=True)
    with open(LOG, "a") as f:
        f.write(line + "\n")

def load_state():
    try:
        s = json.loads(STATE_FILE.read_text())
        # Migrate old state format
        if "consecutive_zero_runs" not in s:
            s["consecutive_zero_runs"] = 0
        return s
    except:
        return {"index": 0, "total_added": 0, "last_run": None, "consecutive_zero_runs": 0}

def save_state(state):
    STATE_FILE.write_text(json.dumps(state, indent=2))

def brave_search(query, count=8):
    url = f"https://api.search.brave.com/res/v1/web/search?q={urllib.parse.quote(query)}&count={count}"
    req = urllib.request.Request(url, headers={"Accept": "application/json", "X-Subscription-Token": BRAVE_KEY})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read()).get("web", {}).get("results", [])
    except Exception as e:
        log(f"Brave error: {e}")
        return []

def crm_get(path):
    req = urllib.request.Request(f"{CRM_BASE}{path}", headers={"x-api-key": CRM_KEY})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read())

def crm_post(path, data):
    body = json.dumps(data).encode()
    req = urllib.request.Request(f"{CRM_BASE}{path}", data=body, method="POST",
          headers={"x-api-key": CRM_KEY, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read())

def get_existing_names():
    """Get normalized set of existing CRM lead names."""
    try:
        leads = crm_get("/api/prospects?limit=1000")
        if isinstance(leads, dict): leads = leads.get("data", [])
        return {normalize(l.get("name", "")) for l in leads}
    except:
        return set()

def normalize(name):
    return re.sub(r'\s+', ' ', (name or "").lower().strip())

def extract_businesses(results, query):
    """Extract business name + address candidates from Brave results."""
    candidates = []
    for r in results:
        title = r.get("title", "")
        desc = r.get("description", "")
        url = r.get("url", "")

        # Skip directories, social media, generic sites
        skip_domains = ["yellowpages", "yelp.com", "google.com", "facebook.com",
                        "tripadvisor", "bbb.org", "indeed.com", "linkedin.com/jobs",
                        "apartments.com", "rent.com", "zillow", "apartmentlist"]
        if any(d in url for d in skip_domains):
            continue

        # Look for address patterns
        addr_match = re.search(r'\d+\s+\w+.*?(?:Las Vegas|Henderson|North Las Vegas|Summerlin)[,\s]+NV', desc + " " + title, re.IGNORECASE)
        addr = addr_match.group(0) if addr_match else ""

        if title and len(title) > 5:
            candidates.append({
                "name": title[:80],
                "address": addr[:150],
                "url": url,
                "snippet": desc[:200],
                "query": query,
            })
    return candidates[:5]

# Hard category rules — applied BEFORE GLM, no LLM cost
def hard_traffic_rule(candidate):
    """
    Returns 'pass', 'fail', or 'glm' (needs GLM judgment).
    Rules based on category type inferred from name/snippet.
    Minimum: 100 people in/out per day.
    """
    text = (candidate['name'] + ' ' + candidate['snippet']).lower()

    # HARD PASS — always 100+ daily by nature
    hard_pass_signals = [
        # Apartments/residential (large)
        ("apartment", ["200 unit", "300 unit", "400 unit", "500 unit", "600 unit",
                        "luxury apartment", "resort-style", "gated community"]),
        # Warehouses / fulfillment (national brands)
        ("warehouse", ["amazon", "fedex", "ups", "usps", "dhl", "walmart",
                        "distribution center", "fulfillment center"]),
        # Medical — large
        ("medical", ["hospital", "medical center", "regional medical", "urgent care",
                      "dialysis center", "surgery center", "va ", "veterans"]),
        # Education
        ("education", ["university", "college", "community college", "unlv", "csn",
                        "trade school", "vocational", "charter school"]),
        # Government / civic
        ("government", ["courthouse", "dmv", "post office", "clark county",
                         "city of las vegas", "government center", "social security"]),
        # Recreation — large venues
        ("recreation", ["convention center", "sports complex", "stadium", "arena",
                         "movie theater", "amc", "regal", "cinemark"]),
    ]
    for _cat, signals in hard_pass_signals:
        if any(s in text for s in signals):
            return 'pass'

    # HARD FAIL — reliably < 100 daily
    hard_fail_signals = [
        "single family", "residential home", "house for sale", "townhome",
        "single-bay", "1-bay", "solo practice", "solo practitioner",
        "small office", "suite 100",  # generic small suite
        "permanently closed", "closed permanently",
        "kiosk", "food truck", "pop-up",
    ]
    if any(s in text for s in hard_fail_signals):
        return 'fail'

    # Apartments: fail if clearly small (<100 units mentioned)
    unit_match = re.search(r'(\d+)[-\s]?unit', text)
    if unit_match:
        units = int(unit_match.group(1))
        if units >= 100: return 'pass'
        if units < 50:   return 'fail'
        # 50-99 units → send to GLM

    return 'glm'


def glm_qualify(candidate):
    """Ask GLM: is this a good vending machine location? Returns tier A/B/C/D or None."""
    prompt = f"""You are evaluating a potential vending machine location for Las Vegas, NV.

Business: {candidate['name']}
Address: {candidate['address'] or 'Las Vegas area'}
Context: {candidate['snippet']}

HARD REQUIREMENT: The location must have at least 100 people coming in and out per day.
This is a strict floor — locations below this threshold are not worth placing a machine.

CATEGORY RULES (apply these first):
- Apartments/residential: need 100+ units OR evidence of high occupancy
- Offices/warehouses: need evidence of 50+ employees on-site daily
- Medical: hospitals and multi-provider clinics pass; solo/2-person practices fail
- Retail/services: need clear evidence of high daily volume (busy gym, multi-location chain, etc.)
- Small businesses with <5 staff, kiosks, food trucks, pop-ups: always D

Reply with ONE of these only:
A - Excellent (200+ people/day, high dwell time)
B - Good (100-200 people/day, solid fit)
C - Borderline (50-100 people/day, might be worth it)
D - Disqualify (<50 people/day, residential, permanently closed, or wrong type)
SKIP - Not enough info to judge

Reply with just the letter (A, B, C, D, or SKIP):"""

    from glm_utils import glm_with_retry
    reply = glm_with_retry(prompt, max_tokens=5, timeout=60, retries=2, backoff=15, temperature=0.1)
    if reply:
        reply = reply.strip().upper()
        for tier in ["A", "B", "C", "D", "SKIP"]:
            if reply.startswith(tier):
                return tier
    return None

DISCOVERY_QUEUE = Path("/Users/kurtishon/clawd/agent-output/scout/glm-discovery-queue.jsonl")

def queue_for_enrichment(candidate, tier):
    """Save to discovery queue — Kimi K2.6 enriches and adds to CRM."""
    try:
        DISCOVERY_QUEUE.parent.mkdir(parents=True, exist_ok=True)
        entry = {
            "name": candidate["name"],
            "address": candidate["address"] or "Las Vegas, NV",
            "source": "glm-scout",
            "glm_tier": tier,
            "url": candidate.get("url", ""),
            "snippet": candidate.get("snippet", "")[:200],
            "query": candidate.get("query", ""),
            "added": TODAY,
        }
        with open(DISCOVERY_QUEUE, "a") as f:
            f.write(json.dumps(entry) + "\n")
        return True
    except Exception as e:
        log(f"Queue error: {e}")
        return False

def main():
    log("=== GLM Scout ===")

    state = load_state()
    existing = get_existing_names()
    log(f"CRM has {len(existing)} existing leads")

    # Pick next 2 queries from rotation
    idx = state.get("index", 0) % len(SEARCH_QUERIES)
    stall_suffix = state.get("stall_suffix", "")
    queries = []
    for i in range(2):
        q = SEARCH_QUERIES[(idx + i) % len(SEARCH_QUERIES)]
        if stall_suffix:
            q = q + " " + stall_suffix
        queries.append(q)
    if stall_suffix:
        log(f"STALL MODE active — appending '{stall_suffix}' to queries")

    added = 0
    for query in queries:
        log(f"Searching: {query[:60]}...")
        results = brave_search(query)
        time.sleep(SLEEP_S)

        candidates = extract_businesses(results, query)
        for c in candidates:
            name_norm = normalize(c["name"])
            # Skip if already in CRM
            if any(name_norm in ex or ex in name_norm for ex in existing if len(ex) > 5):
                continue

            # Hard traffic rule first (no LLM cost)
            rule = hard_traffic_rule(c)
            if rule == 'fail':
                log(f"  ✖️  Hard fail (low traffic): {c['name'][:50]}")
                continue
            elif rule == 'pass':
                tier = 'B'  # Hard pass → auto-qualify as B, let enrichment refine
                log(f"  ✅ Hard pass (100+ traffic): {c['name'][:50]}")
            else:
                # Needs GLM judgment
                tier = glm_qualify(c)
                time.sleep(1)

            if tier in ("A", "B"):
                if queue_for_enrichment(c, tier):
                    log(f"  ✅ Queued Tier {tier}: {c['name'][:50]}")
                    existing.add(name_norm)
                    added += 1
            elif tier in ("C", "D"):
                log(f"  ⬇️  Tier {tier} skip: {c['name'][:50]}")
            else:
                log(f"  ❓ SKIP/unknown: {c['name'][:50]}")

    state["index"] = (idx + 2) % len(SEARCH_QUERIES)
    state["total_added"] = state.get("total_added", 0) + added
    state["last_run"] = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")

    # Stall detection
    if added == 0:
        state["consecutive_zero_runs"] = state.get("consecutive_zero_runs", 0) + 1
    else:
        state["consecutive_zero_runs"] = 0

    zero_runs = state["consecutive_zero_runs"]
    if zero_runs >= STALL_THRESHOLD:
        suffix_idx = ((zero_runs - STALL_THRESHOLD) // STALL_THRESHOLD) % len(STALL_SUFFIXES)
        stall_suffix = STALL_SUFFIXES[suffix_idx]
        log(f"STALL DETECTED: {zero_runs} consecutive zero runs. Next run will append '{stall_suffix}' to queries.")
        state["stall_suffix"] = stall_suffix
    else:
        state["stall_suffix"] = ""
        if zero_runs > 0:
            log(f"Zero runs: {zero_runs}/{STALL_THRESHOLD} before stall mode")

    save_state(state)
    log(f"Done. Added {added} new A/B leads this run (total: {state['total_added']})")
    sys.exit(0 if added > 0 else 1)

if __name__ == "__main__":
    main()
