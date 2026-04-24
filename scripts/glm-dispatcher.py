#!/usr/bin/env python3
"""
glm-dispatcher.py
Runs every 10 minutes. Always finds something for GLM to do.
Priority order:
  1. Ralph backlog (if P0/P1 items exist)
  2. Prospect deep research (Tier A/B leads without decision maker)
  3. Competitor analysis (write up on a competitor)
  4. SEO gap analysis (check which keywords we're missing)
  5. Content ideation (generate topic list for Piper)

Never idle. Always produces output.
"""

import json, sys, os, subprocess, datetime, urllib.request, time

CRM_BASE = "https://vend.kandedash.com"
CRM_KEY  = "kande2026"
MC_URL   = "https://kande-mission-control-production.up.railway.app/api/sync/office-activity"

def push_activity(agent, action, message, duration_ms=None, exit_code=None):
    try:
        evt = {"agent": agent, "action": action, "message": message, "timestamp": datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")}
        if duration_ms is not None:
            evt["durationMs"] = duration_ms
        if exit_code is not None:
            evt["exitCode"] = exit_code
        events = [evt]
        data = json.dumps({"events": events}).encode()
        req = urllib.request.Request(MC_URL, data=data, headers={"Content-Type": "application/json", "x-api-key": "kande2026"}, method="POST")
        urllib.request.urlopen(req, timeout=5)
    except Exception:
        pass
LOG      = "/Users/kurtishon/clawd/logs/glm-dispatcher.log"
BACKLOG  = "/Users/kurtishon/clawd/tasks/backlog.md"
BRAVE    = "BSA8enLl2f0NW0JBRjem3n4eNpiNzbz"

LOCK = "/tmp/glm-dispatcher.lock"

VALUE_ADD_JOBS = [
    "python3 /Users/kurtishon/clawd/scripts/jobs/vending-news-monitor.py",
    "python3 /Users/kurtishon/clawd/scripts/jobs/ocs-research.py",
    "python3 /Users/kurtishon/clawd/scripts/jobs/competitor-monitor.py",
    "python3 /Users/kurtishon/clawd/scripts/jobs/pb-competitor-monitor.py",
    "python3 /Users/kurtishon/clawd/scripts/jobs/research-reconciler.py",
    "python3 /Users/kurtishon/clawd/scripts/jobs/enrich-decision-maker.py",
    "python3 /Users/kurtishon/clawd/scripts/jobs/seo-gap-analysis.py",
    "python3 /Users/kurtishon/clawd/scripts/jobs/case-study-draft.py",
    "python3 /Users/kurtishon/clawd/scripts/jobs/internal-docs.py",
]
VALUE_ADD_STATE = "/Users/kurtishon/clawd/logs/glm-run-counter.json"

def get_run_count():
    try:
        return json.load(open(VALUE_ADD_STATE)).get("count", 0)
    except:
        return 0

def inc_run_count():
    count = get_run_count() + 1
    with open(VALUE_ADD_STATE, "w") as f:
        json.dump({"count": count}, f)
    return count


def log(msg):
    ts = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{ts}] {msg}"
    print(line)
    os.makedirs(os.path.dirname(LOG), exist_ok=True)
    with open(LOG, "a") as f:
        f.write(line + "\n")

def acquire_lock():
    if os.path.exists(LOCK):
        age = time.time() - os.path.getmtime(LOCK)
        if age < 3600:  # 60 min — if older than this, assume killed by SIGKILL
            log(f"Lock held ({age:.0f}s old) — GLM busy, exiting")
            sys.exit(0)
        log(f"Stale lock ({age:.0f}s old) — removing")
        os.remove(LOCK)
    open(LOCK, "w").write(str(os.getpid()))
    import signal
    signal.signal(signal.SIGTERM, lambda s, f: (release_lock(), sys.exit(0)))
    signal.signal(signal.SIGINT,  lambda s, f: (release_lock(), sys.exit(0)))

def release_lock():
    try: os.remove(LOCK)
    except: pass

def run(cmd, timeout=1800):
    """Blocking — launches script and waits for completion so we can measure real duration."""
    import subprocess as _sp, time as _time
    log_out = open("/tmp/glm-run-out.log", "a")
    for attempt in range(3):
        try:
            proc = _sp.Popen(cmd, shell=True, stdout=log_out, stderr=_sp.STDOUT)
            log(f"Launched (pid {proc.pid}): {cmd[:80]}")
            try:
                proc.wait(timeout=timeout)
            except _sp.TimeoutExpired:
                proc.kill()
                log(f"Killed (timeout {timeout}s): {cmd[:80]}")
            return proc.returncode or 0, f"pid={proc.pid}"
        except BlockingIOError:
            log(f"Fork failed (attempt {attempt+1}/3) — waiting 5s")
            _time.sleep(5)
    log(f"Could not launch after 3 attempts: {cmd[:80]}")
    return 1, "fork_failed"

def crm_get(path):
    req = urllib.request.Request(f"{CRM_BASE}{path}", headers={"x-api-key": CRM_KEY})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read())

def has_open_backlog():
    try:
        content = open(BACKLOG).read()
        import re
        open_items = re.findall(r'^## P[01]:.*(?!.*SHIPPED)(?!.*RESOLVED)(?!.*COMPLETED)', content, re.MULTILINE)
        # Check that they truly aren't shipped
        items = [i for i in open_items if "SHIPPED" not in i and "RESOLVED" not in i and "COMPLETED" not in i]
        return len(items) > 0
    except:
        return False

def get_unresearched_prospects():
    try:
        leads = crm_get("/api/prospects?limit=1000")
        if isinstance(leads, dict): leads = leads.get("data", [])
        return [l for l in leads
                if l.get("qual_combined_tier") in ("A", "B")
                and not l.get("decision_maker_found")
                and not l.get("enrich_notes")]
    except:
        return []

def main():
    acquire_lock()
    try:
        _main()
    finally:
        release_lock()

def _main():
    log("=== GLM Dispatcher ===")
    import random
    now_hour = datetime.datetime.now().hour

    # 50/50 split: even runs = lead gen + Piper, odd runs = value-add jobs
    run_count = inc_run_count()
    if run_count % 2 == 0:
        log(f"Run #{run_count}: value-add mode")
        job = random.choice(VALUE_ADD_JOBS)
        task_name = job.split('/')[-1].replace('.py','')
        log(f"TASK: {task_name}")
        push_activity("glm", "working", f"{task_name} [GLM]")
        _t0 = time.time()
        code, out = run(job)
        _dur = int((time.time() - _t0) * 1000)
        push_activity("glm", "completed", f"{task_name} — done [GLM]", duration_ms=_dur, exit_code=code)
        log(f"Done (exit {code}): {out[-200:].strip()}")
        return
    log(f"Run #{run_count}: lead gen mode")

    # Priority 1: Ralph backlog (runs during ralph's windows: 0-7am, 1pm-11pm)
    ralph_window = (0 <= now_hour < 7) or (13 <= now_hour < 23)
    if ralph_window and has_open_backlog():
        log("TASK: Ralph backlog has open items — Ralph should be handling this via cron")
        # Ralph's cron handles this at :20 past each hour — don't double-run
        # Just log and move on
        log("Ralph's scheduled cron will handle backlog — moving to next priority")

    # Priority 2: Prospect deep research
    unresearched = get_unresearched_prospects()
    log(f"Unresearched Tier A/B prospects: {len(unresearched)}")
    if unresearched:
        picks = unresearched[:3]
        log(f"TASK: Deep research on {len(picks)} prospects")
        names = ', '.join([p.get('name','?')[:20] for p in picks[:3]])
        push_activity("scout", "working", f"Deep research: {names} [GLM]")
        out_dir = "/Users/kurtishon/clawd/agent-output/scout/deep-dives"
        os.makedirs(out_dir, exist_ok=True)
        out_path = f"{out_dir}/{datetime.date.today().isoformat()}-{datetime.datetime.now().strftime('%H%M')}.md"

        for lead in picks:
            name = lead.get("name", "?")
            addr = lead.get("address", "")
            tier = lead.get("qual_combined_tier", "?")
            lead_id = lead.get("id")

            def brave_q(q, count=5):
                url = f"https://api.search.brave.com/res/v1/web/search?q={urllib.request.quote(q)}&count={count}"
                req = urllib.request.Request(url, headers={"Accept": "application/json", "X-Subscription-Token": BRAVE})
                try:
                    with urllib.request.urlopen(req, timeout=10) as r:
                        return json.loads(r.read()).get("web", {}).get("results", [])
                except:
                    return []

            import re
            try:
                contact_res = brave_q(f"{name} property manager contact phone email")
                owner_res   = brave_q(f"{name} owner manager name Las Vegas")
                review_res  = brave_q(f"{name} vending machine snacks amenities")

                phones, emails = [], []
                for r in contact_res + owner_res:
                    desc = r.get("description", "") + r.get("title", "")
                    phones += re.findall(r"\(?\d{3}\)?[\s\-.]+\d{3}[\s\-.]+\d{4}", desc)
                    emails += re.findall(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}", desc)
                phones = list(dict.fromkeys(phones))[:3]
                emails = list(dict.fromkeys(emails))[:3]

                with open(out_path, "a") as f:
                    f.write(f"\n## {name}\n")
                    f.write(f"**Address:** {addr}  \n**Tier:** {tier}  \n**Researched:** {datetime.date.today().isoformat()}\n\n")
                    if phones: f.write(f"**Phone(s):** {', '.join(phones)}\n")
                    if emails: f.write(f"**Email(s):** {', '.join(emails)}\n")
                    f.write("\n### Contact Sources\n")
                    for r in (contact_res + owner_res)[:4]:
                        if any(x in r.get("url","").lower() for x in ["yelp","yellowpages","bbb","linkedin","apartments","apartmentlist"]):
                            f.write(f"- **{r.get('title','')}** — {r.get('description','')[:180]}\n  {r.get('url','')}\n")
                    if review_res:
                        f.write("\n### Vending Relevance\n")
                        for r in review_res[:2]:
                            f.write(f"- {r.get('title','')} — {r.get('description','')[:160]}\n")
                    f.write("\n### Jordan Talking Points\n")
                    f.write(f"- Visit {addr} — ask for property manager by name if found\n")
                    if phones: f.write(f"- Call ahead: {phones[0]}\n")
                    f.write("- Pitch: free smart vending, zero cost to property, rev share available\n")

                enrich_notes = f"Deep researched {datetime.date.today().isoformat()}"
                if phones: enrich_notes += f" | Phone: {phones[0]}"
                if emails: enrich_notes += f" | Email: {emails[0]}"
                body = json.dumps({
                    "enrich_notes": enrich_notes,
                    "decision_maker_found": bool(phones or emails),
                    "phone": phones[0] if phones and not lead.get("phone") else lead.get("phone")
                }).encode()
                put_req = urllib.request.Request(
                    f"{CRM_BASE}/api/prospects/{lead_id}", data=body, method="PUT",
                    headers={"x-api-key": CRM_KEY, "Content-Type": "application/json"}
                )
                urllib.request.urlopen(put_req, timeout=10)
                log(f"Deep researched: {name} | phones:{len(phones)} emails:{len(emails)}")
                time.sleep(1)
            except Exception as e:
                log(f"Research error for {name}: {e}")
        return

    # Priority 3: GLM lead discovery (Brave web search for new A/B leads)
    log("TASK: GLM lead scouting")
    push_activity("scout", "working", "Scouting: new Las Vegas prospects [GLM]")
    _t0 = time.time()
    code, out = run("python3 /Users/kurtishon/clawd/scripts/glm-scout.py")
    _dur = int((time.time() - _t0) * 1000)
    push_activity("scout", "completed", f"Scouting: new Las Vegas prospects — done [GLM]", duration_ms=_dur, exit_code=code)
    log(f"GLM scout done (exit {code}): {out[-200:].strip()}")

    # Priority 4: Piper content generation — fire and forget (non-blocking)
    # piper-run.py takes 20+ min; don't block the dispatcher or hold the lock
    import subprocess as _sp
    _sp.Popen(["python3", "/Users/kurtishon/clawd/scripts/piper-run.py"],
              stdout=open("/tmp/piper-bg.log", "a"),
              stderr=_sp.STDOUT)
    log("TASK: Piper content generation (launched in background)")
    push_activity("piper", "working", "Writing: blog content [GLM]")

if __name__ == "__main__":
    unresearched_before = get_unresearched_prospects()
    had_work = bool(unresearched_before)

    main()  # handles lock internally

    if had_work:
        remaining = get_unresearched_prospects()
        if remaining:
            glm_self_trigger()
