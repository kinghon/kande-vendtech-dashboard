#!/usr/bin/env python3
"""
push-learnings.py — Push agent learnings from local files to vend.kandedash.com/api/team/learnings

Reads:
  - agent-output/shared/learnings.md      (cross-team learnings, patterns, strategies)
  - feedback/lessons.md                   (if present — per-agent lessons in markdown)
  - feedback/feedback-log.jsonl           (if present — structured {agent, type, text} entries)

Posts merged, deduplicated result to API. Safe to run multiple times (idempotent).

Cron: push-learnings (10:30 AM + 9:30 PM daily)
"""

import json
import os
import re
import sys
import urllib.request
import urllib.error
from datetime import datetime, timezone

API   = 'https://vend.kandedash.com'
KEY   = 'kande2026'
BASE  = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # /Users/kurtishon/clawd

LEARNINGS_MD   = os.path.join(BASE, 'agent-output', 'shared', 'learnings.md')
LESSONS_MD     = os.path.join(BASE, 'feedback', 'lessons.md')
FEEDBACK_JSONL = os.path.join(BASE, 'feedback', 'feedback-log.jsonl')

KNOWN_AGENTS = {'scout', 'relay', 'ralph', 'mary', 'shared'}


# ── HTTP helpers ─────────────────────────────────────────────────────────────

def api_get(path):
    req = urllib.request.Request(
        f'{API}{path}',
        headers={'x-api-key': KEY, 'Accept': 'application/json'}
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())


def api_post(path, data):
    body = json.dumps(data, ensure_ascii=False).encode('utf-8')
    req = urllib.request.Request(
        f'{API}{path}',
        data=body,
        method='POST',
        headers={
            'x-api-key': KEY,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
        }
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())


# ── Parsers ───────────────────────────────────────────────────────────────────

def read_file(path):
    """Return file contents or None if file doesn't exist."""
    if not os.path.isfile(path):
        return None
    with open(path, 'r', encoding='utf-8') as f:
        return f.read()


def parse_feedback_jsonl(path):
    """
    Parse feedback-log.jsonl.
    Each line: {"agent": "ralph", "type": "mistake"|"learning", "text": "..."}
    Returns dict: { agent_name -> [{text, type}] }
    """
    result = {}
    content = read_file(path)
    if not content:
        return result
    for i, line in enumerate(content.splitlines(), 1):
        line = line.strip()
        if not line:
            continue
        try:
            entry = json.loads(line)
            agent = entry.get('agent', '').lower().strip()
            text  = entry.get('text', '').strip()
            kind  = entry.get('type', 'learning').lower().strip()
            if not agent or not text:
                continue
            if agent not in result:
                result[agent] = []
            result[agent].append({'text': text, 'type': kind})
        except json.JSONDecodeError as e:
            print(f"   ⚠️  feedback-log.jsonl line {i} parse error: {e}")
    return result


def extract_patterns_from_markdown(md):
    """
    Pull bullet-point patterns/strategies from the learnings markdown.
    Looks for lines starting with `- ` or `* ` and grabs the text.
    Returns a list of unique pattern strings (capped at 200 chars each).
    """
    patterns = []
    for line in md.splitlines():
        m = re.match(r'^\s*[-*]\s+\*{0,2}(.+)', line)
        if m:
            text = m.group(1).strip().rstrip('*').strip()
            # Skip very short or header-like lines
            if len(text) > 20:
                patterns.append(text[:250])
    return patterns


def parse_lessons_md(md):
    """
    Parse feedback/lessons.md for per-agent lessons.
    Expected format (loose):
        ## Ralph
        - Lesson text
        - Another lesson

        ## Relay
        - Lesson text
    Returns dict: { agent_name -> [{text, type}] }
    """
    result = {}
    current_agent = None
    for line in md.splitlines():
        heading = re.match(r'^#{1,3}\s+(\w+)', line)
        if heading:
            name = heading.group(1).lower()
            if name in KNOWN_AGENTS:
                current_agent = name
            else:
                current_agent = None
            continue
        if current_agent:
            bullet = re.match(r'^\s*[-*]\s+(.+)', line)
            if bullet:
                text = bullet.group(1).strip()
                if text:
                    if current_agent not in result:
                        result[current_agent] = []
                    result[current_agent].append({'text': text, 'type': 'learning'})
    return result


# ── Merge helpers ─────────────────────────────────────────────────────────────

def dedupe_items(existing, new_items):
    """Merge new items into existing, deduplicating by text (case-insensitive)."""
    seen = {item['text'].lower() for item in existing}
    merged = list(existing)
    added = 0
    for item in new_items:
        key = item['text'].lower()
        if key not in seen:
            merged.append(item)
            seen.add(key)
            added += 1
    return merged, added


def dedupe_list(existing, new_items):
    """Deduplicate a plain string list."""
    seen = {s.lower() for s in existing}
    merged = list(existing)
    added = 0
    for item in new_items:
        if item.lower() not in seen:
            merged.append(item)
            seen.add(item.lower())
            added += 1
    return merged, added


def ensure_agent(state, agent):
    """Ensure per-agent sub-object exists with correct shape."""
    if agent not in state or not isinstance(state[agent], dict):
        state[agent] = {
            'items': [],
            'mistakeCount': 0,
            'learningCount': 0,
            'updated': datetime.now(timezone.utc).isoformat(),
        }
    agent_obj = state[agent]
    if 'items' not in agent_obj:
        agent_obj['items'] = []
    return agent_obj


def ensure_shared(state):
    """Ensure shared sub-object exists with correct shape."""
    if 'shared' not in state or not isinstance(state['shared'], dict):
        state['shared'] = {'what_works': [], 'what_fails': [], 'patterns': [], 'strategies': [], 'updated': datetime.now(timezone.utc).isoformat()}
    shared = state['shared']
    for key in ('what_works', 'what_fails', 'patterns', 'strategies'):
        if key not in shared:
            shared[key] = []
    return shared


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    now = datetime.now(timezone.utc)
    print(f"📚 Push Learnings  [{now.strftime('%Y-%m-%dT%H:%M:%SZ')}]")
    print(f"   Base directory: {BASE}")

    # ── 1. Fetch current state ──────────────────────────────────────────────
    print("\n1️⃣  Fetching current teamLearnings from API...")
    try:
        state = api_get('/api/team/learnings')
        print(f"   ✅ Got existing state ({len(state)} top-level keys)")
    except urllib.error.URLError as e:
        print(f"   ❌ Cannot reach API: {e}")
        return 1

    total_added = 0

    # ── 2. Process feedback-log.jsonl ───────────────────────────────────────
    print("\n2️⃣  Reading feedback/feedback-log.jsonl...")
    jsonl_data = parse_feedback_jsonl(FEEDBACK_JSONL)
    if not jsonl_data:
        print("   — File not found or empty (skipping)")
    else:
        for agent, new_items in jsonl_data.items():
            agent_obj = ensure_agent(state, agent)
            merged, added = dedupe_items(agent_obj['items'], new_items)
            agent_obj['items'] = merged
            agent_obj['mistakeCount']  = sum(1 for i in merged if i.get('type') == 'mistake')
            agent_obj['learningCount'] = sum(1 for i in merged if i.get('type') != 'mistake')
            agent_obj['updated'] = now.isoformat()
            total_added += added
            print(f"   {agent:10s}: {added} new items ({len(merged)} total)")

    # ── 3. Process feedback/lessons.md ──────────────────────────────────────
    print("\n3️⃣  Reading feedback/lessons.md...")
    lessons_md = read_file(LESSONS_MD)
    if not lessons_md:
        print("   — File not found (skipping)")
    else:
        lessons_data = parse_lessons_md(lessons_md)
        if not lessons_data:
            print("   — No agent sections found in lessons.md")
        else:
            for agent, new_items in lessons_data.items():
                agent_obj = ensure_agent(state, agent)
                merged, added = dedupe_items(agent_obj['items'], new_items)
                agent_obj['items'] = merged
                agent_obj['mistakeCount']  = sum(1 for i in merged if i.get('type') == 'mistake')
                agent_obj['learningCount'] = sum(1 for i in merged if i.get('type') != 'mistake')
                agent_obj['updated'] = now.isoformat()
                total_added += added
                print(f"   {agent:10s}: {added} new items from lessons.md")

    # ── 4. Process agent-output/shared/learnings.md ─────────────────────────
    print("\n4️⃣  Reading agent-output/shared/learnings.md...")
    learnings_md = read_file(LEARNINGS_MD)
    if not learnings_md:
        print("   — File not found (skipping)")
    else:
        print(f"   ✅ Read {len(learnings_md):,} chars")
        shared = ensure_shared(state)

        # Store last-modified timestamp + char count as metadata
        shared['learnings_md_chars']   = len(learnings_md)
        shared['learnings_md_updated'] = now.isoformat()

        # Extract bullet patterns and deduplicate into shared.patterns
        new_patterns = extract_patterns_from_markdown(learnings_md)
        merged_patterns, added_patterns = dedupe_list(shared['patterns'], new_patterns)
        shared['patterns'] = merged_patterns
        shared['updated']  = now.isoformat()
        total_added += added_patterns
        print(f"   Patterns: {added_patterns} new added ({len(merged_patterns)} total)")

    # ── 5. POST updated state ────────────────────────────────────────────────
    print(f"\n5️⃣  Pushing updated state to API ({total_added} new items total)...")
    try:
        result = api_post('/api/team/learnings', state)
        if result.get('ok'):
            print("   ✅ Push successful")
        else:
            print(f"   ⚠️  Unexpected response: {result}")
    except urllib.error.URLError as e:
        print(f"   ❌ Push failed: {e}")
        return 1

    # ── Summary ──────────────────────────────────────────────────────────────
    print(f"\n{'='*50}")
    print(f"✅ push-learnings complete")
    print(f"   New items pushed: {total_added}")
    print(f"   Sources read:")
    print(f"     feedback-log.jsonl : {'✅' if jsonl_data else '—'}")
    print(f"     feedback/lessons.md: {'✅' if lessons_md else '—'}")
    print(f"     shared/learnings.md: {'✅' if learnings_md else '—'}")

    return 0


if __name__ == '__main__':
    sys.exit(main())
