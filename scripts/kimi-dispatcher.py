#!/usr/bin/env python3
"""
kimi-dispatcher.py
Runs every 5 minutes. Always finds something for Kimi K2.6 to do.
Priority order:
  1. Lead enrichment (if unenriched leads exist)
  2. Scout maps rotate (if a new batch is due)
  3. Lead qualification (if unscored leads exist)
  4. Competitor research (web search + CRM comparison)
  5. CRM data quality (find and flag stale/bad records)

Never exits with "nothing to do." Always executes something.
"""

import json, sys, os, subprocess, datetime, urllib.request, time, re
sys.path.insert(0, "/Users/kurtishon/clawd/scripts")
from job_lock import is_job_running, lock_path

CRM_BASE = "https://vend.kandedash.com"
CRM_KEY  = "kande2026"
MC_URL   = "https://kande-mission-control-production.up.railway.app/api/sync/office-activity"
LOG      = "/Users/kurtishon/clawd/logs/kimi-dispatcher.log"

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
STATE    = "/Users/kurtishon/clawd/logs/scout-rotate-state.json"
BRAVE    = "BSA8enLl2f0NW0JBRjem3n4eNpiNzbz"

LOCK = "/tmp/kimi-dispatcher.lock"

VALUE_ADD_JOBS = [
    "python3 /Users/kurtishon/clawd/scripts/jobs/kimi-researcher.py",
    "python3 /Users/kurtishon/clawd/scripts/jobs/competitor-discovery.py",
    "python3 /Users/kurtishon/clawd/scripts/jobs/permit-filings.py",
    "python3 /Users/kurtishon/clawd/scripts/jobs/crm-data-gaps.py",
]
VALUE_ADD_STATE = "/Users/kurtishon/clawd/logs/kimi-run-counter.json"

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
    if not os.environ.get("QUIET"):
        print(line)
    os.makedirs(os.path.dirname(LOG), exist_ok=True)
    with open(LOG, "a") as f:
        f.write(line + "\n")

def summary(msg):
    """Always prints — used for final status line only."""
    print(msg)

def acquire_lock():
    if os.path.exists(LOCK):
        age = time.time() - os.path.getmtime(LOCK)
        if age < 3600:  # 60 min max — if older, assume killed by SIGKILL
            log(f"Lock held ({age:.0f}s old) — another instance running, exiting")
            sys.exit(0)
        log(f"Stale lock ({age:.0f}s old) — removing and continuing")
        os.remove(LOCK)
    open(LOCK, "w").write(str(os.getpid()))
    # Register SIGTERM handler so lock is released even if killed
    import signal
    signal.signal(signal.SIGTERM, lambda s, f: (release_lock(), sys.exit(0)))
    signal.signal(signal.SIGINT,  lambda s, f: (release_lock(), sys.exit(0)))

def release_lock():
    try: os.remove(LOCK)
    except: pass

def crm_get(path):
    req = urllib.request.Request(f"{CRM_BASE}{path}", headers={"x-api-key": CRM_KEY})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read())

def job_name_from_cmd(cmd):
    """Extract lock name from a job command string."""
    m = re.search(r'/(\w[\w-]*)\.py', cmd)
    if m:
        return m.group(1).replace('_', '-')
    return None

def run(cmd, _timeout=1800):
    """Blocking — launches script and waits for completion so we can measure real duration.
    Skips if the job already has an active PID lock."""
    import subprocess as _sp, time as _time
    # Check per-job lock before spawning
    name = job_name_from_cmd(cmd)
    if name and is_job_running(name):
        log(f"SKIP (already running): {name}")
        return 1, "job_locked"
    log_out = open("/tmp/ds-run-out.log", "a")
    for attempt in range(3):
        try:
            proc = _sp.Popen(cmd, shell=True, stdout=log_out, stderr=_sp.STDOUT)
            log(f"Launched (pid {proc.pid}): {cmd[:80]}")
            try:
                proc.wait(timeout=_timeout)
            except _sp.TimeoutExpired:
                proc.kill()
                log(f"Killed (timeout {_timeout}s): {cmd[:80]}")
            return proc.returncode or 0, f"pid={proc.pid}"
        except BlockingIOError:
            log(f"Fork failed (attempt {attempt+1}/3) — waiting 5s")
            _time.sleep(5)
    log(f"Could not launch after 3 attempts: {cmd[:80]}")
    return 1, "fork_failed"

def count_unenriched():
    try:
        leads = crm_get("/api/prospects?limit=1000")
        if isinstance(leads, dict): leads = leads.get("data", [])
        return sum(1 for l in leads
                   if not l.get("enriched_at")  # not yet attempted
                   and not l.get("phone") and not l.get("website")
                   and not any(c.get("email") for c in l.get("contacts", []))
                   and l.get("qual_combined_tier") in ("A", "B", None))  # only worth enriching high-value leads
    except:
        return 0

PROTECTED_STATUSES = {"active", "proposal_sent", "signed", "lost", "negotiating", "won", "opening_soon", "pipeline", "closed"}

def count_unscored():
    try:
        leads = crm_get("/api/prospects?limit=1000")
        if isinstance(leads, dict): leads = leads.get("data", [])
        return sum(1 for l in leads
                   if not l.get("qual_date")
                   and l.get("status", "") not in PROTECTED_STATUSES
                   and l.get("last_completed_action", "") not in ("Pop In",))
    except:
        return 0

def scout_due():
    try:
        state = json.load(open(STATE))
        last = state.get("last_run", "")
        if not last: return True
        last_dt = datetime.datetime.strptime(last, "%Y-%m-%d %H:%M")
        return (datetime.datetime.now() - last_dt).total_seconds() > 7200  # 2h
    except:
        return True

def main():
    acquire_lock()
    try:
        _main()
    finally:
        release_lock()

def _main():
    log("=== Kimi K2.6 Dispatcher ===")
    import random

    # 50/50 split: even runs = lead gen pipeline, odd runs = value-add jobs
    run_count = inc_run_count()
    if run_count % 2 == 0:
        log(f"Run #{run_count}: value-add mode")
        # Shuffle and try jobs in order — skip any that are already running
        candidates = list(VALUE_ADD_JOBS)
        random.shuffle(candidates)
        for job in candidates:
            job_name = job_name_from_cmd(job)
            if job_name and is_job_running(job_name):
                log(f"SKIP (locked): {job_name}")
                continue
            task_name = job.split('/')[-1].replace('.py','')
            log(f"TASK: {task_name}")
            # For kimi-researcher, show which company is being researched
            detail = task_name
            if 'researcher' in task_name:
                try:
                    import json as _json
                    state = _json.loads(open('/Users/kurtishon/clawd/logs/kimi-researcher-state.json').read())
                    COMPETITORS = ['First Class Vending','Royal Vending','Canteen','A&L Vending','Nevada Vending','Aramark','Sodexo']
                    comp = COMPETITORS[state.get('comp_idx',0) % len(COMPETITORS)]
                    detail = f"Researching: {comp}"
                except Exception:
                    detail = 'Competitor research'
            push_activity("kimi", "working", f"{detail} [Kimi K2.6]")
            _t0 = time.time()
            code, out = run(job)
            _dur = int((time.time() - _t0) * 1000)
            push_activity("kimi", "completed", f"{task_name} — done [Kimi K2.6]", duration_ms=_dur, exit_code=code)
            log(f"Done (exit {code}): {out[-200:].strip()}")
            return
        log("All value-add jobs currently running — skipping this cycle")
        return
    log(f"Run #{run_count}: lead gen mode")

    # Priority 1: Lead enrichment
    unenriched = count_unenriched()
    log(f"Unenriched leads: {unenriched}")
    if unenriched > 0:
        log(f"TASK: Lead enrichment ({unenriched} leads need data)")
        try:
            all_leads = crm_get("/api/prospects?limit=1000")
            if isinstance(all_leads, dict): all_leads = all_leads.get("data", [])
            enrich_names = ', '.join([l.get('name','?')[:15] for l in all_leads if not l.get('enriched_at') and not l.get('phone') and l.get('qual_combined_tier') in ('A','B',None)][:3])
        except Exception:
            enrich_names = f'{unenriched} leads'
        push_activity("kimi", "working", f"Enriching: {enrich_names} [Kimi K2.6]")
        _t0 = time.time()
        code, out = run("python3 /Users/kurtishon/clawd/scripts/lead-enrich.py")
        _dur = int((time.time() - _t0) * 1000)
        push_activity("kimi", "completed", f"Enriching: {enrich_names} — done [Kimi K2.6]", duration_ms=_dur, exit_code=code)
        log(f"Enrichment done (exit {code}): {out[-200:].strip()}")
        return

    # Priority 2: Scout maps (if 2h since last run)
    if scout_due():
        log("TASK: Scout maps rotate")
        push_activity("scout", "working", "Scout maps rotate [Kimi K2.6]")
        _t0 = time.time()
        code, out = run("python3 /Users/kurtishon/clawd/scripts/scout-maps-rotate.py")
        _dur = int((time.time() - _t0) * 1000)
        push_activity("scout", "completed", f"Scout maps rotate — done [Kimi K2.6]", duration_ms=_dur, exit_code=code)
        log(f"Scout done (exit {code}): {out[-200:].strip()}")
        return

    # Priority 3: Lead qualification
    unscored = count_unscored()
    log(f"Unscored leads: {unscored}")
    if unscored > 0:
        log(f"TASK: Lead qualification ({unscored} leads to score)")
        try:
            all_leads2 = crm_get("/api/prospects?limit=1000")
            if isinstance(all_leads2, dict): all_leads2 = all_leads2.get("data", [])
            qual_names = ', '.join([l.get('name','?')[:15] for l in all_leads2 if not l.get('qual_date') and l.get('status','') not in PROTECTED_STATUSES][:3])
            qual_label = f"{qual_names} +{unscored-3} more" if unscored > 3 else qual_names
        except Exception:
            qual_label = f'{unscored} leads'
        push_activity("kimi", "working", f"Qualifying: {qual_label} [Kimi K2.6]")
        _t0 = time.time()
        code, out = run("python3 /Users/kurtishon/clawd/scripts/lead-qual-combined.py --commit --only-unscored")
        _dur = int((time.time() - _t0) * 1000)
        push_activity("kimi", "completed", f"Qualifying: {qual_label} — done [Kimi K2.6]", duration_ms=_dur, exit_code=code)
        log(f"Qual done (exit {code}): {out[-200:].strip()}")
        return

    # Priority 4: CRM data quality — find closed/stale leads
    log("TASK: CRM data quality check")
    push_activity("kimi", "working", "CRM data quality check [Kimi K2.6]")
    try:
        leads = crm_get("/api/prospects?limit=1000")
        if isinstance(leads, dict): leads = leads.get("data", [])
        stale = [l for l in leads
                 if l.get("maps_business_status") in ("CLOSED_PERMANENTLY", "CLOSED_TEMPORARILY")
                 and l.get("status") not in ("closed", "lost")]
        if stale:
            log(f"Found {len(stale)} stale leads to mark closed")
            for l in stale[:20]:
                req = urllib.request.Request(
                    f"{CRM_BASE}/api/prospects/{l['id']}",
                    data=json.dumps({"status": "closed", "notes": f"Auto-closed: maps_business_status={l['maps_business_status']}"}).encode(),
                    method="PUT",
                    headers={"x-api-key": CRM_KEY, "Content-Type": "application/json"}
                )
                urllib.request.urlopen(req, timeout=10)
            log(f"Marked {min(len(stale),20)} stale leads as closed")
            return
    except Exception as e:
        log(f"Data quality check error: {e}")

      # Priority 4b: Process GLM discovery queue (enrich + add to CRM)
    GLM_QUEUE = "/Users/kurtishon/clawd/agent-output/scout/glm-discovery-queue.jsonl"
    if os.path.exists(GLM_QUEUE):
        try:
            lines = open(GLM_QUEUE).readlines()
            pending = [json.loads(l) for l in lines if l.strip()]
            if pending:
                log(f"TASK: Processing {len(pending)} GLM discovery queue entries")
                processed = []
                for entry in pending[:5]:  # batch of 5
                    name = entry.get("name", "")
                    addr = entry.get("address", "Las Vegas, NV")
                    # Try to add via CRM (it will run Maps lookup)
                    try:
                        body = json.dumps({
                            "name": name, "address": addr,
                            "status": "new", "source": "glm-scout",
                            "notes": f"GLM-Scout: {entry.get('snippet','')[:150]}",
                            "website": entry.get("url", ""),
                        }).encode()
                        req = urllib.request.Request(
                            f"{CRM_BASE}/api/prospects", data=body, method="POST",
                            headers={"x-api-key": CRM_KEY, "Content-Type": "application/json"}
                        )
                        result = json.loads(urllib.request.urlopen(req, timeout=15).read())
                        lead_id = result.get("id") or result.get("_id") or result.get("prospect", {}).get("id")
                        log(f"  Added from GLM queue: {name[:50]} (id:{lead_id})")
                        processed.append(entry)
                    except Exception as e:
                        err = str(e)
                        if "422" in err or "qualification" in err.lower():
                            log(f"  Qual rejected: {name[:50]}")
                            processed.append(entry)  # remove from queue
                        else:
                            log(f"  CRM error for {name[:50]}: {err[:80]}")
                # Remove processed entries from queue
                remaining = [l for l in lines if json.loads(l) not in processed]
                open(GLM_QUEUE, "w").writelines(remaining)
                if processed:
                    return
        except Exception as e:
            log(f"GLM queue error: {e}")

    # Priority 5: Re-enrich empty A/B leads (worth retrying)
    log("TASK: Re-enrichment of empty A/B leads")
    try:
        leads = crm_get("/api/prospects?limit=1000")
        if isinstance(leads, dict): leads = leads.get("data", [])
        empty = [l for l in leads
                 if l.get("enriched_at")
                 and not l.get("phone") and not l.get("website")
                 and not any(c.get("email") for c in l.get("contacts", []))
                 and l.get("qual_combined_tier") in ("A", "B")]
        if empty:
            import random
            batch = random.sample(empty, min(10, len(empty)))
            log(f"Clearing enriched_at on {len(batch)} empty A/B leads for retry")
            for l in batch:
                req = urllib.request.Request(
                    f"{CRM_BASE}/api/prospects/{l['id']}",
                    data=__import__('json').dumps({"enriched_at": None}).encode(),
                    method="PUT",
                    headers={"x-api-key": CRM_KEY, "Content-Type": "application/json"}
                )
                urllib.request.urlopen(req, timeout=10)
            code, out = run("python3 /Users/kurtishon/clawd/scripts/lead-enrich.py")
            log(f"Re-enrichment done (exit {code}): {out[-200:].strip()}")
            return
    except Exception as e:
        log(f"Re-enrichment error: {e}")

    summary("DONE")  # minimal stdout for cron agent


if __name__ == "__main__":
    main()  # main() handles acquire/release lock internally
