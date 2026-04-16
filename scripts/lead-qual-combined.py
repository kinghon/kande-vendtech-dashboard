#!/usr/bin/env python3
"""
Lead Qualification — Combined V1 + V2 Score
Runs both systems and produces a single final tier.

Logic:
- Combined score = average of v1 + v2 (0-12 scale)
- Tier A: combined >= 9 AND neither system below Tier B (7+)
- Tier B: combined >= 6.5 AND neither system is Tier D
- Tier C: combined >= 4
- Tier D: combined < 4 OR either system is Tier D

Usage:
  python3 lead-qual-combined.py --dry-run
  python3 lead-qual-combined.py --dry-run --batch 50
  python3 lead-qual-combined.py --commit
"""

import json, sys, time, argparse, datetime, re, subprocess
from pathlib import Path

TODAY      = datetime.date.today().isoformat()
OUTPUT_DIR = Path("/Users/kurtishon/clawd/agent-output/scout")
CRM_BASE   = "https://vend.kandedash.com"
CRM_KEY    = "kande2026"

import urllib.request
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

def crm_delete(path):
    req = urllib.request.Request(f"{CRM_BASE}{path}", method="DELETE",
          headers={"x-api-key": CRM_KEY})
    with urllib.request.urlopen(req, timeout=10) as r:
        return r.status

# Import scoring functions from both scripts
sys.path.insert(0, str(Path(__file__).parent))
import importlib.util

def load_module(path, name):
    spec   = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

SCRIPTS_DIR = Path(__file__).parent
v1 = load_module(SCRIPTS_DIR / "lead-qual-v1.py", "v1")
v2 = load_module(SCRIPTS_DIR / "lead-qual-v2.py", "v2")

TIER_ORDER = {"A": 4, "B": 3, "C": 2, "D": 1, None: 0}

def combined_tier(s1, t1, s2, t2):
    """Combine two scores/tiers into one final verdict."""
    if s1 is None or s2 is None:
        return None, None

    avg = (s1 + s2) / 2.0

    # If either system Tier D → cap at C
    if t1 == "D" or t2 == "D":
        if avg >= 6:
            return round(avg, 1), "C"
        return round(avg, 1), "D"

    # Both must be at least B for an A
    if avg >= 9 and t1 in ("A", "B") and t2 in ("A", "B"):
        return round(avg, 1), "A"
    elif avg >= 6.5:
        return round(avg, 1), "B"
    elif avg >= 4:
        return round(avg, 1), "C"
    else:
        return round(avg, 1), "D"

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", default=True)
    parser.add_argument("--commit",  action="store_true")
    parser.add_argument("--delete",  action="store_true",
                        help="Actually DELETE auto_remove candidates and confirmed duplicates from CRM (requires --commit)")
    parser.add_argument("--batch",   type=int, default=0)
    parser.add_argument("--only-unscored", action="store_true",
                        help="Skip leads that already have qual_date set (for nightly incremental runs)")
    args = parser.parse_args()
    if args.commit:
        args.dry_run = False
    if args.delete and args.dry_run:
        print("⚠️  --delete requires --commit. Ignoring --delete.")
        args.delete = False

    mode = "DRY RUN" if args.dry_run else "COMMIT"
    print(f"\n🔀 Lead Qualification COMBINED — {mode}\n   {TODAY}\n")

    print("📥 Loading CRM leads...")
    leads = crm_get("/api/prospects?limit=1000")
    if isinstance(leads, dict):
        leads = leads.get("data", [])
    print(f"   {len(leads)} leads loaded")

    if args.only_unscored:
        before = len(leads)
        leads = [p for p in leads if not p.get("qual_date")]
        print(f"   Skipping already-scored: {before - len(leads)} leads, {len(leads)} unscored remaining")

    if args.batch:
        leads = leads[:args.batch]
        print(f"   Limiting to {args.batch}")

    # Dedup (use v1's logic)
    print("🔍 Scanning for duplicates...")
    dup_groups    = v1.find_duplicates(leads)
    dup_remove_ids = set()
    for group in dup_groups.values():
        popin_leads = [p for p in group if v1.has_popin(p)]
        no_popin    = [p for p in group if not v1.has_popin(p)]
        if popin_leads and no_popin:
            for p in no_popin:
                if p.get("id"):
                    dup_remove_ids.add(p["id"])
    print(f"   {len(dup_groups)} dup groups, {len(dup_remove_ids)} safe to remove\n")

    print(f"🧮 Processing {len(leads)} leads...\n")

    results = []
    for i, p in enumerate(leads):
        name = p.get("name", "?")
        print(f"  {i+1}/{len(leads)} [{p.get('id','?')}] {name[:40]}...", end=" ", flush=True)

        # Duplicate check
        if p.get("id") in dup_remove_ids:
            print("🗑️  DUPLICATE")
            results.append({"lead": p, "status": "duplicate",
                            "v1_score": 0, "v1_tier": "D",
                            "v2_score": 0, "v2_tier": "D",
                            "combined_score": 0, "combined_tier": "D",
                            "auto_remove": True})
            continue

        # Protection check
        prot, prot_reason = v1.is_protected(p)
        if prot:
            print(f"🛡️  PROTECTED ({prot_reason})")
            results.append({"lead": p, "status": "protected",
                            "v1_score": None, "v1_tier": None,
                            "v2_score": None, "v2_tier": None,
                            "combined_score": None, "combined_tier": None,
                            "auto_remove": False})
            continue

        # Review check (use v2's stricter source=manual detection)
        rev2, rev_reason2 = v2.needs_review(p)
        rev1, rev_reason1 = v1.needs_review(p)
        is_review  = rev1 or rev2
        rev_reason = rev_reason2 or rev_reason1

        # Score both systems
        s1, t1, d1, hf1, hfr1 = v1.score_lead(p)
        s2, t2, d2, hf2, hfr2 = v2.score_lead(p)
        cs, ct = combined_tier(s1, t1, s2, t2)

        tier_emoji = {"A": "🏆", "B": "✅", "C": "⚠️", "D": "🗑️"}.get(ct, "?")
        flag       = "⚠️ REVIEW " if is_review else ""
        print(f"{flag}{tier_emoji} {ct} (v1={s1}/12 v2={s2}/12 avg={cs})")

        results.append({
            "lead":           p,
            "status":         "review" if is_review else "scored",
            "review_reason":  rev_reason if is_review else "",
            "v1_score":       s1, "v1_tier":       t1, "v1_details": d1,
            "v2_score":       s2, "v2_tier":       t2, "v2_details": d2,
            "combined_score": cs, "combined_tier":  ct,
            "hard_fail":      hf1 or hf2,
            "hard_fail_reason": hfr1 or hfr2,
            "auto_remove":    (ct in ("C", "D") and not is_review and
                               (p.get("status") or "new") == "new")
        })

        # Commit combined scores to CRM
        if not args.dry_run and p.get("id"):
            try:
                crm_put(f"/api/prospects/{p['id']}", {
                    "qual_v1_score":       s1, "qual_v1_tier":       t1,
                    "qual_v2_score":       s2, "qual_v2_tier":       t2,
                    "qual_combined_score": cs, "qual_combined_tier":  ct,
                    "qual_date":           TODAY
                })
            except Exception as e:
                print(f"    ⚠️ CRM write failed: {e}")

        time.sleep(0.05)

    # ── Delete pass (after all scoring is done) ───────────────────────────────
    deleted_ids = set()
    if args.delete:
        print("\n🗑️  DELETE PASS — removing auto_remove + confirmed duplicates...")

        # Delete confirmed duplicate non-popin leads
        for pid in dup_remove_ids:
            try:
                crm_delete(f"/api/prospects/{pid}")
                deleted_ids.add(pid)
                print(f"  🗑️  Deleted duplicate [{pid}]")
            except Exception as e:
                print(f"  ⚠️  Delete failed [{pid}]: {e}")

        # Delete Tier D auto_remove candidates
        for r in results:
            if r.get("auto_remove") and r["lead"].get("id") not in deleted_ids:
                pid = r["lead"].get("id")
                if not pid:
                    continue
                try:
                    crm_delete(f"/api/prospects/{pid}")
                    deleted_ids.add(pid)
                    print(f"  🗑️  Deleted Tier D [{pid}] {r['lead'].get('name','?')[:40]}")
                except Exception as e:
                    print(f"  ⚠️  Delete failed [{pid}]: {e}")
                time.sleep(0.05)

        print(f"\n  Total deleted: {len(deleted_ids)}")

        time.sleep(0.05)

    # ── Report ────────────────────────────────────────────────────────────────
    scored    = [r for r in results if r["status"] == "scored"]
    reviewed  = [r for r in results if r["status"] == "review"]
    protected = [r for r in results if r["status"] == "protected"]
    dupes     = [r for r in results if r["status"] == "duplicate"]
    removes   = [r for r in results if r.get("auto_remove")]

    tiers = {t: [r for r in scored if r["combined_tier"] == t]
             for t in ["A", "B", "C", "D"]}

    disagreements = [
        r for r in scored
        if r["v1_tier"] and r["v2_tier"] and r["v1_tier"] != r["v2_tier"]
    ]

    lines = [
        f"# Lead Qualification — Combined Report",
        f"_Run: {TODAY} | Mode: {mode}_\n",
        "## How Combined Scoring Works",
        "- Average of V1 (verification) + V2 (closability) scores",
        "- Tier A: avg ≥ 9 AND both systems ≥ Tier B",
        "- Tier B: avg ≥ 6.5 AND neither system is Tier D",
        "- Tier C: avg ≥ 4",
        "- Tier D: avg < 4 OR either system is Tier D",
        "",
        "## Summary",
        f"- 🛡️ Protected (untouched): {len(protected)}",
        f"- 🗑️ Duplicates removed: {len(dupes)}",
        f"- ⚠️ Flagged for Kurtis review: {len(reviewed)}",
        f"- 🧮 Scored: {len(scored)}",
        f"  - Tier A (Priority): {len(tiers['A'])}",
        f"  - Tier B (Qualified): {len(tiers['B'])}",
        f"  - Tier C (Weak): {len(tiers['C'])}",
        f"  - Tier D (Remove): {len(tiers['D'])}",
        f"- 🗑️ Auto-remove candidates: {len(removes)}",
        f"- 🔀 V1 vs V2 disagreements: {len(disagreements)}",
        "",
    ]

    lines.append("## 🏆 Tier A — Priority Leads")
    for r in sorted(tiers["A"], key=lambda x: -x["combined_score"])[:25]:
        p = r["lead"]
        lines.append(f"- **{p['name']}** | combined={r['combined_score']} | v1={r['v1_score']} {r['v1_tier']} | v2={r['v2_score']} {r['v2_tier']}")

    lines.append("\n## 🗑️ Auto-Remove Candidates (Tier D, new, no contact)")
    for r in removes[:50]:
        p = r["lead"]
        hf = f" | ⛔ {r['hard_fail_reason']}" if r.get("hard_fail") else ""
        lines.append(f"- [{p.get('id')}] **{p['name']}** | v1={r['v1_score']} {r['v1_tier']} | v2={r['v2_score']} {r['v2_tier']}{hf}")

    lines.append("\n## 🔀 Disagreements (V1 and V2 in different tiers)")
    lines.append("_These need a human look — systems disagree on quality_")
    for r in sorted(disagreements, key=lambda x: abs(x["v1_score"] - x["v2_score"]), reverse=True)[:30]:
        p = r["lead"]
        diff = r["v1_score"] - r["v2_score"]
        direction = "V1 higher" if diff > 0 else "V2 higher"
        lines.append(f"- **{p['name']}** | v1={r['v1_score']}{r['v1_tier']} vs v2={r['v2_score']}{r['v2_tier']} | {direction} by {abs(diff)}pts")

    lines.append("\n## ⚠️ Flagged for Kurtis Review")
    for r in reviewed[:40]:
        p = r["lead"]
        lines.append(f"- **{p['name']}** — {r['review_reason']} | combined={r['combined_score']} {r['combined_tier']}")

    lines.append("\n## Score Distribution (Combined)")
    all_scores = [r["combined_score"] for r in scored if r["combined_score"] is not None]
    if all_scores:
        buckets = {}
        for s in all_scores:
            b = round(s * 2) / 2
            buckets[b] = buckets.get(b, 0) + 1
        for b in sorted(buckets):
            bar = "█" * buckets[b]
            lines.append(f"  {b:4.1f}: {bar} ({buckets[b]})")

    report = "\n".join(lines)
    out    = OUTPUT_DIR / f"qual-combined-{TODAY}.md"
    out.write_text(report)
    print(f"\n📊 Report: {out}")
    print("\n" + report[:3000])

if __name__ == "__main__":
    main()
