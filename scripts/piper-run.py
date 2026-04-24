#!/usr/bin/env python3
"""
piper-run.py — Content generation for VendTech + Jumpgate.
Gathers all context, calls GLM directly for pure text output (no tool calls).
Exits 0 on success, 1 on failure.
"""

import json, os, sys, datetime, urllib.request, urllib.error, random, re
from pathlib import Path

GLM_URL   = "http://192.168.1.52:52415/v1/chat/completions"
GLM_MODEL = "GLM-5.1-UD-IQ4_XS-00001-of-00009.gguf"  # actual model ID on llama-server
BLOG_DIR  = Path("/Users/kurtishon/clawd/agent-output/piper/blogs/vendtech")
SOCIAL_DIR = Path("/Users/kurtishon/clawd/agent-output/piper/social/vendtech")
STYLE_GUIDE = Path("/Users/kurtishon/clawd/agent-output/piper/SEO-STYLE-GUIDE.md")
LEARNINGS   = Path("/Users/kurtishon/clawd/agent-output/shared/learnings.md")
LOG         = Path("/Users/kurtishon/clawd/logs/piper.log")

TODAY = datetime.date.today().isoformat()

def log(msg):
    ts = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{ts}] {msg}"
    print(line, flush=True)  # flush=True prevents silent buffering when stdout is redirected
    LOG.parent.mkdir(parents=True, exist_ok=True)
    with open(LOG, "a") as f:
        f.write(line + "\n")

def read_file(path, max_chars=8000):
    try:
        return Path(path).read_text()[:max_chars]
    except:
        return ""

def glm_generate(prompt, max_tokens=8192):
    """Call GLM directly — pure text generation, no tool calls."""
    payload = json.dumps({
        "model": GLM_MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": max_tokens,
        "temperature": 0.7,
        "stream": False,
    }).encode()
    req = urllib.request.Request(
        GLM_URL,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=600) as r:  # 10 min max — if GLM hasn't responded, it's hung
            data = json.loads(r.read())
            return data["choices"][0]["message"]["content"]
    except Exception as e:
        log(f"GLM error: {e}")
        return None

def get_existing_blog_slugs():
    """List existing blog filenames to avoid topic duplication."""
    try:
        return [f.stem for f in sorted(BLOG_DIR.glob("*.html"))]
    except:
        return []

def slug_from_title(title):
    title = title.lower().strip()
    title = re.sub(r'[^a-z0-9\s-]', '', title)
    title = re.sub(r'\s+', '-', title)
    return title[:80]

def write_vendtech_blog():
    """Generate one VendTech SEO blog post."""
    log("Generating VendTech blog...")

    existing    = get_existing_blog_slugs()
    # Pick a topic not already covered
    covered = set(existing[-20:]) if existing else set()
    topics = [
        "car dealerships las vegas vending machines",
        "auto repair shops vending machines las vegas",
        "trade schools vocational colleges vending las vegas",
        "bowling alleys vending machines las vegas",
        "urgent care clinics vending machines las vegas",
        "clark county government buildings vending las vegas",
        "corporate campuses vending machines las vegas",
        "movie production studios vending las vegas",
        "nevada dmv offices vending machines",
        "coworking spaces vending machines las vegas",
    ]
    import random
    topic = random.choice([t for t in topics if t not in covered] or topics)

    prompt = f"""Write a complete SEO blog post as a full HTML file for KandeVendTech.com, a Las Vegas vending machine company.

TOPIC: {topic}

RULES:
- Output ONLY valid HTML starting with <!DOCTYPE html> and ending with </html>
- 1500-2500 words. Include 10+ specific stats with named sources (IBISWorld, Cantaloupe, NACS, etc)
- Voice: first person plural ("we install", "at Kande VendTech we..."), professional but human
- Las Vegas / Henderson specific throughout. Reference real neighborhoods, temperatures, local employers
- Include Report Highlights section near top with 6-8 bullet stats
- H2/H3 headings. No tables. No em dashes. No buzzwords.
- Internal links: /services/ /contact/ /apartment-building-vending-machines/ /office-vending-machines/
- CTA at end with phone (725) 228-8822
- JSON-LD BlogPosting schema
- Title tag with keyword + Las Vegas + 2026
- Meta description 150-160 chars

Output the full HTML now:"""

    html = glm_generate(prompt, max_tokens=12000)
    if not html:
        log("ERROR: GLM returned nothing for blog")
        return False

    # Strip any accidental markdown fences
    html = re.sub(r'^```html\s*', '', html, flags=re.MULTILINE)
    html = re.sub(r'^```\s*$', '', html, flags=re.MULTILINE)
    html = html.strip()

    if not html.startswith("<!DOCTYPE") and not html.startswith("<html"):
        log(f"ERROR: Output doesn't look like HTML. First 200 chars: {html[:200]}")
        return False

    # Extract title for slug
    title_match = re.search(r'<title>(.*?)</title>', html, re.IGNORECASE)
    title = title_match.group(1) if title_match else f"vendtech-blog-{TODAY}"
    slug = slug_from_title(title)
    if not slug:
        slug = f"vendtech-blog-{TODAY}"

    out_path = BLOG_DIR / f"{slug}.html"
    BLOG_DIR.mkdir(parents=True, exist_ok=True)
    out_path.write_text(html)
    log(f"Blog saved: {out_path.name} ({len(html)} bytes)")
    return True

def write_social_posts():
    """Generate LinkedIn + Twitter posts for VendTech."""
    log("Generating social posts...")

    learnings = read_file(LEARNINGS, 1500)

    prompt = """Write social media posts for KandeVendTech.com, a Las Vegas vending machine company.

Output exactly this format:

## LINKEDIN POST
(150-200 words, first person from owner Kurtis, specific insight about Las Vegas vending, real stat, no buzzwords, no em dashes)

## TWITTER POSTS
Tweet 1: (under 250 chars, specific and punchy)
Tweet 2: (under 250 chars, Las Vegas specific)
Tweet 3: (under 250 chars, real insight)

Output only the posts:"""

    output = glm_generate(prompt, max_tokens=2000)
    if not output:
        log("ERROR: GLM returned nothing for social")
        return False

    # Check it's not DSML garbage
    if "<｜DSML｜" in output or "<tool_call>" in output:
        log("ERROR: GLM output is DSML markup")
        return False

    SOCIAL_DIR.mkdir(parents=True, exist_ok=True)
    out_path = SOCIAL_DIR / f"{TODAY}.md"
    out_path.write_text(output)
    log(f"Social saved: {out_path.name} ({len(output)} bytes)")
    return True

def push_activity(message, duration_ms, exit_code):
    try:
        import time as _time
        evt = {"agent": "piper", "action": "completed", "message": message,
               "timestamp": datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
               "durationMs": duration_ms, "exitCode": exit_code}
        data = json.dumps({"events": [evt]}).encode()
        req = urllib.request.Request(
            "https://kande-mission-control-production.up.railway.app/api/sync/office-activity",
            data=data, headers={"Content-Type": "application/json", "x-api-key": "kande2026"}, method="POST")
        urllib.request.urlopen(req, timeout=5)
    except Exception:
        pass

def main():
    import time as _time
    log("=== Piper Run ===")
    _t0 = _time.time()
    blog_ok   = write_vendtech_blog()
    social_ok = write_social_posts()
    _dur = int((_time.time() - _t0) * 1000)

    if blog_ok and social_ok:
        log("All done.")
        push_activity("Writing: blog content — done [GLM]", _dur, 0)
        sys.exit(0)
    elif blog_ok or social_ok:
        log("Partial success.")
        push_activity("Writing: blog content — partial [GLM]", _dur, 0)
        sys.exit(0)
    else:
        log("Both tasks failed.")
        push_activity("Writing: blog content — failed [GLM]", _dur, 1)
        sys.exit(1)

if __name__ == "__main__":
    main()
