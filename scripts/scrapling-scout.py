#!/usr/bin/env python3
"""
scrapling-scout.py — Scrapes high-value sites that block normal scrapers.
Targets: apartments.com, rent.com, loopnet, seniorly, LVRJ business news, etc.
Uses Scrapling (StealthyFetcher) to bypass Cloudflare/Akamai/bot detection.
Feeds discovered leads through GLM qual gate and into the discovery queue.

Replaces browseract-scout.py — Scrapling is free, no API key, no rate limits,
and cracks apartments.com (Akamai) which BrowserAct could not.

Runs as a dispatcher job alongside glm-scout.py (different sources, same queue).
"""

import json, os, sys, datetime, re, time
from pathlib import Path

sys.path.insert(0, "/Users/kurtishon/clawd/scripts")
from job_lock import acquire_job_lock
from glm_utils import glm_with_retry

acquire_job_lock("scrapling-scout")

TODAY      = datetime.date.today().isoformat()
LOG        = Path("/Users/kurtishon/clawd/logs/scrapling-scout.log")
STATE_FILE = Path("/Users/kurtishon/clawd/logs/scrapling-scout-state.json")
QUEUE      = Path("/Users/kurtishon/clawd/agent-output/scout/glm-discovery-queue.jsonl")
CRM_KEY    = "kande2026"
CRM_BASE   = "https://vend.kandedash.com"

SCRAPE_TARGETS = [
    # Apartments — zip-code specific to get past nav/filter UI on city pages
    # 89113 / 89148 = SW Las Vegas (Durango, Sunset, Oquendo corridor — Picerne territory)
    ("apartments_com_89113",
     "https://www.apartments.com/las-vegas-nv-89113/",
     "apartment complex Las Vegas NV 89113"),

    ("apartments_com_89148",
     "https://www.apartments.com/las-vegas-nv-89148/",
     "apartment complex Las Vegas NV 89148"),

    ("apartments_com_henderson",
     "https://www.apartments.com/henderson-nv/",
     "apartment complex Henderson NV"),

    ("apartments_com_north_lv",
     "https://www.apartments.com/north-las-vegas-nv/",
     "apartment complex North Las Vegas NV"),

    ("rent_com_lv",
     "https://www.rent.com/nevada/las-vegas-apartments",
     "apartment complex Las Vegas"),

    ("rent_com_henderson",
     "https://www.rent.com/nevada/henderson-apartments",
     "apartment complex Henderson NV"),

    ("rent_com_north_lv",
     "https://www.rent.com/nevada/north-las-vegas-apartments",
     "apartment complex North Las Vegas NV"),

    ("apartmentlist_lv",
     "https://www.apartmentlist.com/nv/las-vegas",
     "apartment complex Las Vegas NV"),

    ("apartmentlist_henderson",
     "https://www.apartmentlist.com/nv/henderson",
     "apartment complex Henderson NV"),

    # Developer portfolio pages — catches all properties from major LV apartment builders
    ("picerne_nevada",
     "https://www.picerne.com/nv/apartments",
     "Picerne apartment community Las Vegas NV"),

    # Senior living
    ("seniorly_lv",
     "https://www.seniorly.com/assisted-living/nevada/las-vegas",
     "assisted living senior care Las Vegas"),

    ("caring_com_lv",
     "https://www.caring.com/assisted-living/nevada/las-vegas/",
     "assisted living memory care Las Vegas"),

    ("seniorly_henderson",
     "https://www.seniorly.com/assisted-living/nevada/henderson",
     "assisted living senior care Henderson NV"),

    # Commercial real estate
    ("loopnet_lv_office",
     "https://www.loopnet.com/search/office-space/las-vegas-nv/for-lease/",
     "office space for lease Las Vegas"),

    ("loopnet_lv_industrial",
     "https://www.loopnet.com/search/industrial-real-estate/las-vegas-nv/for-lease/",
     "industrial warehouse Las Vegas for lease"),

    ("loopnet_henderson",
     "https://www.loopnet.com/search/commercial-real-estate/henderson-nv/for-lease/",
     "commercial real estate Henderson NV for lease"),

    # Local news
    ("lvrj_business",
     "https://reviewjournal.com/business/real-estate/",
     "commercial real estate business news Las Vegas"),

    ("lvrj_development",
     "https://reviewjournal.com/business/development/",
     "new development construction Las Vegas Henderson"),

    ("vegasinc_business",
     "https://vegasinc.lasvegassun.com/business/",
     "new business opening Las Vegas 2025 2026"),

    ("newhomesource_lv",
     "https://www.newhomesource.com/homes-for-sale/nv/las-vegas-region",
     "new home community development Las Vegas NV"),
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
        return json.loads(STATE_FILE.read_text())
    except:
        return {"index": 0, "total_added": 0, "last_run": None}

def save_state(state):
    STATE_FILE.write_text(json.dumps(state, indent=2))

def scrapling_fetch(url, timeout=45):
    """Use Scrapling StealthyFetcher to pull page content as text."""
    import subprocess
    script = f"""
import sys
from scrapling.fetchers import StealthyFetcher
try:
    page = StealthyFetcher.fetch({repr(url)}, headless=True, network_idle=True, timeout={timeout * 1000})
    if page and page.status == 200:
        print(page.get_all_text()[:12000])
    else:
        print("SCRAPLING_BLOCKED:" + str(page.status if page else "no_response"), file=sys.stderr)
        sys.exit(1)
except Exception as e:
    print("SCRAPLING_ERROR:" + str(e), file=sys.stderr)
    sys.exit(1)
"""
    try:
        result = subprocess.run(
            ["/opt/homebrew/bin/uv", "run", "--python", "3.12", "--with", "scrapling[all]", "--with", "curl_cffi", "python3", "-c", script],
            capture_output=True, text=True, timeout=timeout + 30
        )
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout.strip()
        else:
            err = result.stderr.strip()[:200]
            log(f"  Scrapling error: {err}")
            return None
    except subprocess.TimeoutExpired:
        log(f"  Timeout scraping {url}")
        return None
    except Exception as e:
        log(f"  Extract error: {e}")
        return None

def get_existing_names():
    import urllib.request
    try:
        req = urllib.request.Request(
            f"{CRM_BASE}/api/prospects?limit=1000",
            headers={"x-api-key": CRM_KEY}
        )
        with urllib.request.urlopen(req, timeout=15) as r:
            leads = json.loads(r.read())
            if isinstance(leads, dict):
                leads = leads.get("data", [])
            return {normalize(l.get("name", "")) for l in leads}
    except Exception as e:
        log(f"CRM fetch error: {e}")
        return set()

def normalize(name):
    return re.sub(r'\s+', ' ', (name or "").lower().strip())

def glm_extract_leads(text_content, context_hint, url):
    content_preview = text_content[:8000] if text_content else ""
    prompt = f"""You are extracting vending machine lead candidates from a webpage.
Context: {context_hint}
Source URL: {url}

PAGE CONTENT:
{content_preview}

Extract up to 8 specific business/property names with addresses in Las Vegas, Henderson, or North Las Vegas, NV.
Only include real named locations (not generic listings). Skip ads, navigation links, and irrelevant content.

Return as JSON array only, no explanation:
[
  {{"name": "Property or Business Name", "address": "street address Las Vegas NV or empty string", "type": "apartment|office|industrial|medical|senior_living|other"}},
  ...
]

If nothing relevant found, return: []"""

    reply = glm_with_retry(prompt, max_tokens=800, timeout=90, retries=2, backoff=15, temperature=0.1)
    if not reply:
        return []
    try:
        match = re.search(r'\[.*\]', reply, re.DOTALL)
        if match:
            return json.loads(match.group(0))
    except Exception as e:
        log(f"  JSON parse error: {e} | reply: {reply[:100]}")
    return []

def glm_qualify(name, address, type_hint):
    prompt = f"""Is this a good vending machine location in Las Vegas, NV?

Name: {name}
Address: {address or 'Las Vegas area'}
Type: {type_hint}

HARD REQUIREMENT: 100+ people in/out daily.

Reply with ONE letter only:
A - Excellent (200+ people/day, high dwell time)
B - Good (100-200 people/day)
C - Borderline (50-100 people/day)
D - Disqualify (<50 people/day, wrong type, or not enough info)"""

    reply = glm_with_retry(prompt, max_tokens=5, timeout=60, retries=2, backoff=10, temperature=0.1)
    if reply:
        reply = reply.strip().upper()
        for tier in ["A", "B", "C", "D"]:
            if reply.startswith(tier):
                return tier
    return "D"

def queue_lead(name, address, tier, type_hint, source_url):
    try:
        QUEUE.parent.mkdir(parents=True, exist_ok=True)
        entry = {
            "name": name,
            "address": address or "Las Vegas, NV",
            "source": "scrapling-scout",
            "glm_tier": tier,
            "type": type_hint,
            "url": source_url,
            "added": TODAY,
        }
        with open(QUEUE, "a") as f:
            f.write(json.dumps(entry) + "\n")
        return True
    except Exception as e:
        log(f"Queue error: {e}")
        return False

def main():
    log("=== Scrapling Scout ===")

    state = load_state()
    existing = get_existing_names()
    log(f"CRM has {len(existing)} existing leads")

    idx = state.get("index", 0) % len(SCRAPE_TARGETS)
    targets = [SCRAPE_TARGETS[(idx + i) % len(SCRAPE_TARGETS)] for i in range(2)]

    added = 0

    for label, url, context_hint in targets:
        log(f"Scraping [{label}]: {url}")
        content = scrapling_fetch(url)

        if not content:
            log(f"  No content returned, skipping")
            continue

        # apartments.com pages have ~7k chars of nav/filter UI before actual listings
    if 'apartments.com' in url:
        content = content[6000:] if len(content) > 6000 else content
    log(f"  Got {len(content)} chars of content")

        candidates = glm_extract_leads(content, context_hint, url)
        log(f"  GLM extracted {len(candidates)} candidates")

        for c in candidates:
            name = (c.get("name") or "").strip()
            address = (c.get("address") or "").strip()
            type_hint = c.get("type", "other")

            if not name or len(name) < 5:
                continue

            name_norm = normalize(name)
            if any(name_norm in ex or ex in name_norm for ex in existing if len(ex) > 5):
                log(f"  Already in CRM: {name[:50]}")
                continue

            if type_hint in ("apartment", "senior_living"):
                tier = "B"
                log(f"  Auto-pass {type_hint}: {name[:50]}")
            else:
                tier = glm_qualify(name, address, type_hint)
                time.sleep(1)

            if tier in ("A", "B"):
                if queue_lead(name, address, tier, type_hint, url):
                    log(f"  Queued Tier {tier}: {name[:50]}")
                    existing.add(name_norm)
                    added += 1
            else:
                log(f"  Tier {tier} skip: {name[:50]}")

        time.sleep(3)

    state["index"] = (idx + 2) % len(SCRAPE_TARGETS)
    state["total_added"] = state.get("total_added", 0) + added
    state["last_run"] = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
    save_state(state)

    log(f"Done. Added {added} new leads this run (total: {state['total_added']})")
    sys.exit(0 if added > 0 else 1)

if __name__ == "__main__":
    main()
