#!/usr/bin/env python3
"""
Bidirectional Email → CRM Sync
Watches ALL inbound + outbound emails for both VendTech and PhotoBooths.
Matches to CRM prospects and logs activities. Never double-logs.

Usage: python3 email-crm-sync.py [--dry-run]
"""

import json, subprocess, re, datetime, sys, urllib.request
from pathlib import Path

ACCOUNTS = [
    {
        "email":      "kurtis@kandevendtech.com",
        "password":   "kandepb2026",
        "crm_base":   "https://vend.kandedash.com",
        "crm_key":    "kande2026",
        "crm_auth":   "api-key",
        "label":      "VendTech",
        "staff":      ["jordan@kandevendtech.com"],
    },
    {
        "email":      "kurtis@kandephotobooths.com",
        "password":   "kandepb2026",
        "crm_base":   "https://pb.kandedash.com",
        "crm_key":    "kpb-ops-2026",
        "crm_auth":   "bearer",
        "label":      "PhotoBooths",
        "staff":      ["mary@kandephotobooths.com", "coreen@kandephotobooths.com"],
    },
]

INTERNAL_EMAILS = {
    "jordan@kandevendtech.com", "kurtis@kandevendtech.com",
    "mary@kandephotobooths.com", "coreen@kandephotobooths.com",
    "kurtis@kandephotobooths.com", "kurtis.hon@gmail.com",
}
# All staff across all accounts (built dynamically below)
ALL_STAFF = set()

STATE_FILE = Path("/Users/kurtishon/clawd/logs/email-sync-state.json")
DRY_RUN    = "--dry-run" in sys.argv
TODAY      = datetime.date.today().isoformat()

# ── State ─────────────────────────────────────────────────────────────────────
def load_state():
    if STATE_FILE.exists():
        return json.loads(STATE_FILE.read_text())
    return {"processed_ids": []}

def save_state(state):
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(state, indent=2))

# ── Gmail ─────────────────────────────────────────────────────────────────────
def gog(account, password, args):
    import os
    env = dict(os.environ)
    env["GOG_KEYRING_PASSWORD"] = password
    env["GOG_ACCOUNT"]          = account
    r = subprocess.run(
        ["/opt/homebrew/bin/gog"] + args + [f"--account={account}", "--plain", "--no-input"],
        capture_output=True, env=env, timeout=30)
    return r.stdout.decode("utf-8", errors="replace").strip()

def search_emails(account, password, query, max_results=25):
    out = gog(account, password, ["gmail", "search", query, "--max", str(max_results)])
    emails = []
    for line in out.splitlines():
        if not line.strip() or line.startswith("ID\t"):
            continue
        parts = line.split("\t")
        if len(parts) >= 4:
            emails.append({
                "id":      parts[0].strip(),
                "date":    parts[1].strip(),
                "from":    parts[2].strip(),
                "subject": parts[3].strip(),
            })
    return emails

def get_email_detail(account, password, msg_id):
    """Returns dict with to, from, subject from gog get output."""
    out = gog(account, password, ["gmail", "get", msg_id])
    detail = {}
    for line in out.splitlines():
        parts = line.split("\t", 1)
        if len(parts) == 2:
            detail[parts[0].strip().lower()] = parts[1].strip()
    return detail

def extract_email_addr(raw):
    """Extract plain email from 'Name <email>' or return as-is."""
    m = re.search(r'<([^>]+)>', raw)
    return m.group(1).lower().strip() if m else raw.lower().strip()

# ── CRM ───────────────────────────────────────────────────────────────────────
def load_prospects(crm_base, crm_key, crm_auth="api-key"):
    try:
        if crm_auth == "bearer":
            # PB uses inbox as its lead system
            req = urllib.request.Request(
                f"{crm_base}/api/inbox",
                headers={"Authorization": f"Bearer {crm_key}"})
            with urllib.request.urlopen(req, timeout=15) as r:
                data = json.loads(r.read())
            # Convert inbox emails to prospect-like objects for matching
            emails = data.get("emails", [])
            return [{
                "id":       e["id"],
                "name":     e.get("from", "?").split("<")[0].strip(),
                "contacts": [{"email": extract_email_addr(e.get("from", ""))}],
                "status":   "new",
                "_pb_inbox": True,
            } for e in emails]
        else:
            req = urllib.request.Request(
                f"{crm_base}/api/prospects?limit=1000",
                headers={"x-api-key": crm_key})
            with urllib.request.urlopen(req, timeout=15) as r:
                data = json.loads(r.read())
            return data if isinstance(data, list) else data.get("data", [])
    except Exception as e:
        print(f"    ⚠️ Could not load prospects: {e}")
        return []

def find_prospect(prospects, email_addr):
    email_addr = extract_email_addr(email_addr)
    for p in prospects:
        for c in (p.get("contacts") or []):
            if extract_email_addr(c.get("email") or "") == email_addr:
                return p
        if email_addr in (p.get("primary_contact") or "").lower():
            return p
        # Domain match (non-generic)
        if "@" in email_addr:
            domain = email_addr.split("@")[1]
            if domain not in {"gmail.com","yahoo.com","hotmail.com","outlook.com","icloud.com","aol.com"}:
                for c in (p.get("contacts") or []):
                    ce = (c.get("email") or "")
                    if "@" in ce and ce.split("@")[1].lower() == domain:
                        return p
    return None

def log_activity(crm_base, crm_key, crm_auth, prospect_id, atype, notes, direction):
    if DRY_RUN:
        print(f"      [DRY RUN] log {atype} → {prospect_id}")
        return True
    body = json.dumps({"type": atype, "notes": notes, "date": TODAY, "direction": direction}).encode()
    if crm_auth == "bearer":
        # PB: log to /api/activity
        req = urllib.request.Request(
            f"{crm_base}/api/activity",
            data=body, method="POST",
            headers={"Authorization": f"Bearer {crm_key}", "Content-Type": "application/json"})
    else:
        req = urllib.request.Request(
            f"{crm_base}/api/prospects/{prospect_id}/activities",
            data=body, method="POST",
            headers={"x-api-key": crm_key, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status < 300
    except Exception as e:
        print(f"      ⚠️ log failed: {e}")
        return False

def update_status(crm_base, crm_key, crm_auth, prospect_id, status):
    if DRY_RUN or crm_auth == "bearer":
        return  # PB inbox has no status field
    body = json.dumps({"status": status}).encode()
    req  = urllib.request.Request(
        f"{crm_base}/api/prospects/{prospect_id}",
        data=body, method="PUT",
        headers={"x-api-key": crm_key, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            pass
    except:
        pass

# ── Sync one account ──────────────────────────────────────────────────────────
def sync_account(acct, processed):
    email    = acct["email"]
    password = acct["password"]
    crm_base = acct["crm_base"]
    crm_key  = acct["crm_key"]
    crm_auth = acct.get("crm_auth", "api-key")
    label    = acct["label"]
    staff    = set(acct.get("staff", [])) | {email}

    prospects   = load_prospects(crm_base, crm_key, crm_auth)
    new_seen    = []
    logged      = 0

    print(f"\n  [{label}] {len(prospects)} prospects loaded")

    # ── Inbound from prospects ────────────────────────────────────────────────
    print(f"  [{label}] 📥 Checking inbound...")
    inbound = search_emails(email, password,
        "-from:noreply -from:no-reply -from:notifications newer_than:3d", max_results=30)

    for e in inbound:
        mid = e["id"]
        if mid in processed:
            continue

        from_raw  = e["from"]
        from_addr = extract_email_addr(from_raw)
        subject   = e["subject"]

        if from_addr in INTERNAL_EMAILS:
            new_seen.append(mid)
            continue

        p = find_prospect(prospects, from_addr)
        if p:
            atype = "email_reply_received" if re.match(r're:', subject, re.I) else "email_received"
            print(f"    ✉️  [{label}] Inbound: {p['name']} | {subject[:45]}")
            if log_activity(crm_base, crm_key, crm_auth, p["id"], atype,
                            f"Inbound: '{subject}' from {from_addr}", "inbound"):
                logged += 1
        new_seen.append(mid)

    # ── Staff emails (CC'd to Kurtis) ─────────────────────────────────────────
    print(f"  [{label}] 👥 Checking staff CC'd emails...")
    cc_emails = search_emails(email, password,
        f"cc:{email} -from:{email} -from:noreply newer_than:3d", max_results=30)

    for e in cc_emails:
        mid       = e["id"]
        if mid in processed:
            continue

        from_raw  = e["from"]
        from_addr = extract_email_addr(from_raw)
        subject   = e["subject"]

        # Only track emails from this account's staff
        if from_addr not in staff:
            new_seen.append(mid)
            continue

        detail      = get_email_detail(email, password, mid)
        to_addr     = detail.get("to", "")
        sender_name = from_raw.split("<")[0].strip() or from_addr

        p = find_prospect(prospects, to_addr) if to_addr else None
        if p:
            print(f"    👥 [{label}] {sender_name}→{p['name']}: {subject[:40]}")
            if log_activity(crm_base, crm_key, crm_auth, p["id"],
                            "staff_email_sent",
                            f"{sender_name} sent: '{subject}' to {to_addr}", "outbound"):
                if p.get("status") not in ("signed","negotiating","proposal_sent","active"):
                    update_status(crm_base, crm_key, crm_auth, p["id"], "active")
                logged += 1
        new_seen.append(mid)

    # ── Outbound ──────────────────────────────────────────────────────────────
    print(f"  [{label}] 📤 Checking outbound...")
    outbound = search_emails(email, password,
        f"from:{email} in:sent newer_than:3d", max_results=30)

    for e in outbound:
        mid     = e["id"]
        if mid in processed:
            continue
        subject = e["subject"]
        detail  = get_email_detail(email, password, mid)
        to_addr = detail.get("to", "")

        atype = "email_sent"
        if "visit follow" in subject.lower() or "follow-up" in subject.lower():
            atype = "visit_follow_up_email"
        elif "proposal" in subject.lower():
            atype = "proposal_sent"

        p = find_prospect(prospects, to_addr) if to_addr else None
        if p:
            print(f"    📤 [{label}] Outbound: {p['name']} | {subject[:45]}")
            if log_activity(crm_base, crm_key, crm_auth, p["id"], atype,
                            f"Sent: '{subject}' to {to_addr}", "outbound"):
                if atype in ("proposal_sent","visit_follow_up_email"):
                    if p.get("status") not in ("signed","negotiating","proposal_sent"):
                        update_status(crm_base, crm_key, crm_auth, p["id"], "proposal_sent")
                logged += 1
        new_seen.append(mid)

    print(f"  [{label}] ✅ {logged} logged, {len(new_seen)} marked seen")
    return new_seen, logged

# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    state     = load_state()
    processed = set(state.get("processed_ids", []))
    all_new   = []
    total     = 0

    print(f"\n📧 Bidirectional Email-CRM Sync{'  [DRY RUN]' if DRY_RUN else ''}")
    print(f"   {TODAY} | {len(processed)} previously processed")

    for acct in ACCOUNTS:
        new_seen, logged = sync_account(acct, processed)
        all_new.extend(new_seen)
        total += logged

    all_ids = list(processed | set(all_new))
    if len(all_ids) > 1000:
        all_ids = all_ids[-1000:]
    state["processed_ids"] = all_ids
    state["last_run"]      = datetime.datetime.now().isoformat()
    if not DRY_RUN:
        save_state(state)

    print(f"\n✅ Total: {total} activities logged across both accounts.")
    if total == 0:
        print("HEARTBEAT_OK")

if __name__ == "__main__":
    main()
