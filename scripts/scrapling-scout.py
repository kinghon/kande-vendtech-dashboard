#!/usr/bin/env python3
"""
scrapling-scout.py — Multi-source location scout for vending machine leads.

apartments.com  → apartments-pp-cli (structured JSON, fast, no GLM extraction needed)
Everything else → Scrapling (StealthyFetcher) + GLM extraction

Fully self-contained — no external module dependencies.
Feeds qualified leads into the discovery queue for Jordan.
"""

import json, os, sys, datetime, re, time, subprocess, urllib.request, urllib.error
from pathlib import Path

# --- Config ---
TODAY      = datetime.date.today().isoformat()
LOG        = Path("/Users/kurtishon/clawd/logs/scrapling-scout.log")
STATE_FILE = Path("/Users/kurtishon/clawd/logs/scrapling-scout-state.json")
QUEUE      = Path("/Users/kurtishon/clawd/agent-output/scout/glm-discovery-queue.jsonl")
LOCK_FILE  = Path("/tmp/scrapling-scout.lock")
CRM_KEY    = "kande2026"
CRM_BASE   = "https://vend.kandedash.com"
PP_CLI     = Path("/Users/kurtishon/go/bin/apartments-pp-cli")
GLM_URL    = "http://192.168.1.52:52415/v1/chat/completions"
GLM_MODEL  = "local"

# --- apartments.com targets via pp-cli ---
PP_CLI_TARGETS = [
    ("pp_lv",        "Las Vegas",       "NV"),
    ("pp_henderson", "Henderson",       "NV"),
    ("pp_north_lv",  "North Las Vegas", "NV"),
]

# --- All other sources via Scrapling ---
SCRAPE_TARGETS = [
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

    ("picerne_nevada",
     "https://www.picerne.com/nv/apartments",
     "Picerne apartment community Las Vegas NV"),

    ("seniorly_lv",
     "https://www.seniorly.com/assisted-living/nevada/las-vegas",
     "assisted living senior care Las Vegas"),

    ("caring_com_lv",
     "https://www.caring.com/assisted-living/nevada/las-vegas/",
     "assisted living memory care Las Vegas"),

    ("seniorly_henderson",
     "https://www.seniorly.com/assisted-living/nevada/henderson",
     "assisted living senior care Henderson NV"),

    ("loopnet_lv_office",
     "https://www.loopnet.com/search/office-space/las-vegas-nv/for-lease/",
     "office space for lease Las Vegas"),

    ("loopnet_lv_industrial",
     "https://www.loopnet.com/search/industrial-real-estate/las-vegas-nv/for-lease/",
     "industrial warehouse Las Vegas for lease"),

    ("loopnet_henderson",
     "https://www.loopnet.com/search/commercial-real-estate/henderson-nv/for-lease/",
     "commercial real estate Henderson NV for lease"),

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

TOTAL_TARGETS = len(PP_CLI_TARGETS) + len(SCRAPE_TARGETS)


# --- Lock ---

def acquire_lock():
    if LOCK_FILE.exists():
        age = time.time() - LOCK_FILE.stat().st_mtime
        if age < 3600:
            print(f"Lock held ({age:.0f}s old) — exiting")
            sys.exit(0)
        LOCK_FILE.unlink()
    LOCK_FILE.write_text(str(os.getpid()))

def release_lock():
    try:
        LOCK_FILE.unlink()
    except:
        pass


# --- Logging ---

def log(msg):
    ts = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{ts}] {msg}"
    print(line)
    LOG.parent.mkdir(parents=True, exist_ok=True)
    with open(LOG, "a") as f:
        f.write(line + "\n")


# --- State ---

def load_state():
    try:
        return json.loads(STATE_FILE.read_text())
    except:
        return {"index": 0, "total_added": 0, "last_run": None}

def save_state(state):
    STATE_FILE.write_text(json.dumps(state, indent=2))


# --- CRM ---

def get_existing_names():
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


# --- GLM ---

def glm_call(prompt, max_tokens=800, temperature=0.1, timeout=90):
    payload = json.dumps({
        "model": GLM_MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": max_tokens,
        "temperature": temperature,
    }).encode()
    for attempt in range(3):
        try:
            req = urllib.request.Request(
                GLM_URL, data=payload,
                headers={"Content-Type": "application/json"},
                method="POST"
            )
            with urllib.request.urlopen(req, timeout=timeout) as r:
                data = json.loads(r.read())
                return data["choices"][0]["message"]["content"].strip()
        except Exception as e:
            log(f"  GLM attempt {attempt+1} error: {e}")
            if attempt < 2:
                time.sleep(15)
    return None


# --- pp-cli ---

def pp_cli_fetch(city, state):
    """Fetch apartments.com listings via apartments-pp-cli. Returns list of dicts."""
    result = subprocess.run(
        [str(PP_CLI), "rentals", "--city", city, "--state", state,
         "--beds-min", "1", "--json", "--no-input", "--no-color"],
        capture_output=True, text=True, timeout=60
    )
    if result.returncode != 0:
        log(f"  pp-cli error: {result.stderr[:200]}")
        return []
    try:
        m = re.search(r'\[.*\]', result.stdout, re.DOTALL)
        if m:
            return json.loads(m.group(0))
    except Exception as e:
        log(f"  pp-cli JSON parse error: {e}")
    return []


# --- Scrapling ---

def scrapling_fetch(url, timeout=45):
    """Scrapling StealthyFetcher for non-apartments.com sources."""
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
            ["/opt/homebrew/bin/uv", "run", "--python", "3.12",
             "--with", "scrapling[all]", "--with", "curl_cffi", "python3", "-c", script],
            capture_output=True, text=True, timeout=timeout + 30
        )
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout.strip()
        log(f"  Scrapling error: {result.stderr.strip()[:200]}")
        return None
    except subprocess.TimeoutExpired:
        log(f"  Timeout scraping {url}")
        return None
    except Exception as e:
        log(f"  Scrapling exception: {e}")
        return None


# --- GLM extraction + qualification ---

def glm_extract_leads(text_content, context_hint, url):
    prompt = f"""Extract vending machine lead candidates from this webpage.
Context: {context_hint}
Source: {url}

PAGE CONTENT:
{text_content[:8000]}

Return up to 8 specific named locations in Las Vegas, Henderson, or North Las Vegas NV.
Skip navigation, ads, and filter labels. Only real named properties/businesses.

JSON array only:
[{{"name": "...", "address": "...", "type": "apartment|office|industrial|medical|senior_living|other"}}]

If nothing found: []"""

    reply = glm_call(prompt, max_tokens=800, temperature=0.1)
    if not reply:
        return []
    try:
        m = re.search(r'\[.*\]', reply, re.DOTALL)
        if m:
            return json.loads(m.group(0))
    except Exception as e:
        log(f"  JSON parse error: {e}")
    return []


def glm_qualify(name, address, type_hint):
    reply = glm_call(
        f"""Is this a good vending machine location in Las Vegas NV?
Name: {name}
Address: {address or 'Las Vegas area'}
Type: {type_hint}
HARD REQUIREMENT: 100+ people/day.
Reply ONE letter: A (200+/day) B (100-200/day) C (50-100/day) D (disqualify)""",
        max_tokens=5, temperature=0.1, timeout=60
    )
    if reply:
        for tier in ["A", "B", "C", "D"]:
            if reply.strip().upper().startswith(tier):
                return tier
    return "D"


# --- Queue ---

def queue_lead(name, address, tier, type_hint, source_url):
    try:
        QUEUE.parent.mkdir(parents=True, exist_ok=True)
        entry = {
            "name": name, "address": address or "Las Vegas, NV",
            "source": "scrapling-scout", "glm_tier": tier,
            "type": type_hint, "url": source_url, "added": TODAY,
        }
        with open(QUEUE, "a") as f:
            f.write(json.dumps(entry) + "\n")
        return True
    except Exception as e:
        log(f"Queue error: {e}")
        return False


# --- Processors ---

def process_pp_cli(label, city, state, existing):
    log(f"Fetching [{label}] via pp-cli: {city}, {state}")
    t0 = time.time()
    listings = pp_cli_fetch(city, state)
    log(f"  Got {len(listings)} listings in {time.time()-t0:.1f}s")

    added = 0
    for listing in listings:
        name = re.sub(r'\s*[-|].*$', '', (listing.get("title") or "")).strip()
        url = listing.get("url", "")
        if not name or len(name) < 4:
            continue
        name_norm = normalize(name)
        if any(name_norm in ex or ex in name_norm for ex in existing if len(ex) > 5):
            continue
        if queue_lead(name, f"{city}, {state}", "B", "apartment", url):
            log(f"  Queued Tier B: {name[:60]}")
            existing.add(name_norm)
            added += 1
    return added


def process_scrapling(label, url, context_hint, existing):
    log(f"Scraping [{label}]: {url}")
    content = scrapling_fetch(url)
    if not content:
        log(f"  No content, skipping")
        return 0

    log(f"  Got {len(content)} chars")
    candidates = glm_extract_leads(content, context_hint, url)
    log(f"  GLM extracted {len(candidates)} candidates")

    added = 0
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
    return added


# --- Main ---

def main():
    acquire_lock()
    try:
        log("=== Scrapling Scout (pp-cli + Scrapling) ===")
        state = load_state()
        existing = get_existing_names()
        log(f"CRM has {len(existing)} existing leads")

        idx = state.get("index", 0) % TOTAL_TARGETS
        added = 0

        for i in range(2):
            target_idx = (idx + i) % TOTAL_TARGETS
            if target_idx < len(PP_CLI_TARGETS):
                label, city, state_code = PP_CLI_TARGETS[target_idx]
                added += process_pp_cli(label, city, state_code, existing)
            else:
                scrape_idx = target_idx - len(PP_CLI_TARGETS)
                label, url, context_hint = SCRAPE_TARGETS[scrape_idx]
                added += process_scrapling(label, url, context_hint, existing)

        state["index"] = (idx + 2) % TOTAL_TARGETS
        state["total_added"] = state.get("total_added", 0) + added
        state["last_run"] = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
        save_state(state)

        log(f"Done. Added {added} leads this run (total: {state['total_added']})")
        sys.exit(0 if added > 0 else 1)
    finally:
        release_lock()


if __name__ == "__main__":
    main()
