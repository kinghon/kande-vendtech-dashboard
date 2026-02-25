#!/usr/bin/env python3
"""
Merge duplicate prospects in CRM.
- Keeps the record with more data (activities, contacts) as primary
- Merges missing fields from duplicate into primary
- Moves contacts and activities to primary (skipping exact duplicates)
- Deletes the duplicate after merge
"""

import json, urllib.request
from collections import Counter

API = 'https://sales.kandedash.com'
KEY = 'kande2026'

DRY_RUN = False  # Set True to preview without making changes


def api_get(path):
    req = urllib.request.Request(f'{API}{path}', headers={'x-api-key': KEY})
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read())


def api_put(path, data):
    body = json.dumps(data).encode()
    req = urllib.request.Request(f'{API}{path}', data=body, method='PUT',
                                 headers={'x-api-key': KEY, 'Content-Type': 'application/json'})
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read())


def api_post(path, data):
    body = json.dumps(data).encode()
    req = urllib.request.Request(f'{API}{path}', data=body,
                                 headers={'x-api-key': KEY, 'Content-Type': 'application/json'})
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read())


def api_delete(path):
    req = urllib.request.Request(f'{API}{path}', method='DELETE',
                                 headers={'x-api-key': KEY})
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read())


def pick_best_value(v1, v2):
    """Pick the more informative value."""
    if not v1 and v2:
        return v2
    if not v2 and v1:
        return v1
    if v1 and v2:
        # Prefer longer/more detailed value
        if isinstance(v1, str) and isinstance(v2, str):
            return v1 if len(v1) >= len(v2) else v2
        return v1
    return v1


def merge_pair(primary, duplicate, all_activities, all_contacts):
    """Merge duplicate into primary."""
    pid = primary['id']
    did = duplicate['id']
    name = primary.get('name', '?')
    
    print(f"\n{'='*60}")
    print(f"MERGING: {name}")
    print(f"  Primary: #{pid} (created {primary.get('created_at','?')[:10]})")
    print(f"  Duplicate: #{did} (created {duplicate.get('created_at','?')[:10]})")
    
    # 1. Merge prospect fields
    merge_fields = ['address', 'type', 'property_type', 'units', 'notes', 'source',
                    'lat', 'lng', 'hours', 'phone', 'website', 'contact_name',
                    'contact_email', 'contact_phone']
    
    updates = {}
    for field in merge_fields:
        pval = primary.get(field)
        dval = duplicate.get(field)
        best = pick_best_value(pval, dval)
        if best != pval and best is not None:
            updates[field] = best
            print(f"  📝 Field '{field}': '{str(pval)[:40]}' → '{str(best)[:40]}'")
    
    # Merge notes (append if different)
    pnotes = (primary.get('notes') or '').strip()
    dnotes = (duplicate.get('notes') or '').strip()
    if dnotes and dnotes != pnotes and dnotes not in pnotes:
        combined = f"{pnotes}\n---\n{dnotes}" if pnotes else dnotes
        updates['notes'] = combined
        print(f"  📝 Notes merged (appended duplicate's notes)")
    
    if updates and not DRY_RUN:
        api_put(f'/api/prospects/{pid}', updates)
        print(f"  ✅ Prospect #{pid} updated with {len(updates)} fields")
    elif updates:
        print(f"  [DRY RUN] Would update {len(updates)} fields")
    
    # 2. Move contacts (skip duplicates by email)
    primary_contacts = [c for c in all_contacts if c.get('prospect_id') == pid]
    dupe_contacts = [c for c in all_contacts if c.get('prospect_id') == did]
    
    primary_emails = set((c.get('email') or '').lower() for c in primary_contacts)
    primary_names = set((c.get('name') or '').lower() for c in primary_contacts)
    
    for dc in dupe_contacts:
        dc_email = (dc.get('email') or '').lower()
        dc_name = (dc.get('name') or '').lower()
        
        if dc_email and dc_email in primary_emails:
            print(f"  ⏭️ Contact '{dc.get('name')}' already exists (same email), skipping")
            if not DRY_RUN:
                try:
                    api_delete(f'/api/directory/contacts/{dc["id"]}')
                except:
                    pass
            continue
        
        if dc_name and dc_name in primary_names:
            print(f"  ⏭️ Contact '{dc.get('name')}' already exists (same name), skipping")
            if not DRY_RUN:
                try:
                    api_delete(f'/api/directory/contacts/{dc["id"]}')
                except:
                    pass
            continue
        
        # Move contact to primary
        print(f"  📇 Moving contact '{dc.get('name')}' ({dc.get('email')}) → #{pid}")
        if not DRY_RUN:
            try:
                api_put(f'/api/directory/contacts/{dc["id"]}', {'prospect_id': pid})
            except:
                # If can't update, create new + delete old
                try:
                    api_post(f'/api/prospects/{pid}/contacts', {
                        'name': dc.get('name'), 'role': dc.get('role'),
                        'email': dc.get('email'), 'phone': dc.get('phone')
                    })
                    api_delete(f'/api/directory/contacts/{dc["id"]}')
                except Exception as e:
                    print(f"    ❌ Failed: {e}")
    
    # 3. Move activities (skip exact duplicates by type+description)
    primary_acts = [a for a in all_activities if a.get('prospect_id') == pid]
    dupe_acts = [a for a in all_activities if a.get('prospect_id') == did]
    
    primary_act_sigs = set()
    for a in primary_acts:
        sig = f"{a.get('type','')}__{a.get('description','')}"
        primary_act_sigs.add(sig)
    
    for da in dupe_acts:
        sig = f"{da.get('type','')}__{da.get('description','')}"
        
        if sig in primary_act_sigs:
            print(f"  ⏭️ Activity '{da.get('type')}: {da.get('description','')[:50]}' already exists, deleting dupe")
            if not DRY_RUN:
                try:
                    api_delete(f'/api/activities/{da["id"]}')
                except:
                    pass
            continue
        
        # Move activity to primary
        print(f"  📋 Moving activity '{da.get('type')}: {da.get('description','')[:50]}' → #{pid}")
        if not DRY_RUN:
            try:
                api_put(f'/api/activities/{da["id"]}', {'prospect_id': pid})
            except:
                try:
                    api_post(f'/api/activities', {
                        'prospect_id': pid,
                        'type': da.get('type'),
                        'description': da.get('description')
                    })
                    api_delete(f'/api/activities/{da["id"]}')
                except Exception as e:
                    print(f"    ❌ Failed: {e}")
    
    # 4. Delete the duplicate prospect
    print(f"  🗑️ Deleting duplicate #{did}")
    if not DRY_RUN:
        try:
            api_delete(f'/api/prospects/{did}')
            print(f"  ✅ Duplicate #{did} deleted")
        except Exception as e:
            print(f"  ❌ Failed to delete: {e}")
    else:
        print(f"  [DRY RUN] Would delete #{did}")


def main():
    print("🔄 Fetching all data...")
    prospects = api_get('/api/prospects')
    activities = api_get('/api/activities?limit=2000')
    contacts = api_get('/api/directory/contacts')
    
    # Find duplicates by name
    names = {}
    for p in prospects:
        n = p.get('name', '')
        if n not in names:
            names[n] = []
        names[n].append(p)
    
    dupes = {n: ps for n, ps in names.items() if len(ps) > 1}
    
    # Exclude names where "duplicates" are actually different locations
    DIFFERENT_LOCATIONS = {'FedEx', 'FedEx Ground', 'USPS', 'Amazon', 'US Foods'}
    for skip_name in DIFFERENT_LOCATIONS:
        if skip_name in dupes:
            print(f"⏭️ Skipping '{skip_name}' — different physical locations, not duplicates")
            del dupes[skip_name]
    
    # Manually add near-duplicates with slightly different names
    prospect_map = {p['id']: p for p in prospects}
    MANUAL_MERGES = [
        (3916, 518),  # "Alton Southern Highlands" + "Alton at Southern Highlands"
    ]
    for primary_id, dupe_id in MANUAL_MERGES:
        if primary_id in prospect_map and dupe_id in prospect_map:
            pname = prospect_map[primary_id].get('name', '?')
            dname = prospect_map[dupe_id].get('name', '?')
            key = f"MANUAL: {pname} + {dname}"
            dupes[key] = [prospect_map[primary_id], prospect_map[dupe_id]]
    
    print(f"Found {len(dupes)} duplicate groups ({sum(len(ps) for ps in dupes.values())} total records)")
    
    merged = 0
    for name, group in sorted(dupes.items()):
        if name == 'Unknown (check management)':
            # These are placeholder records, just delete them
            print(f"\n🗑️ Deleting {len(group)} 'Unknown' placeholder records...")
            for p in group:
                p_acts = [a for a in activities if a.get('prospect_id') == p['id']]
                p_contacts = [c for c in contacts if c.get('prospect_id') == p['id']]
                if not p_acts and not p_contacts:
                    if not DRY_RUN:
                        try:
                            api_delete(f'/api/prospects/{p["id"]}')
                            print(f"  Deleted #{p['id']}")
                        except:
                            pass
                else:
                    print(f"  #{p['id']} has data, keeping")
            continue
        
        # Sort by: most activities > most contacts > oldest created
        def score(p):
            p_acts = len([a for a in activities if a.get('prospect_id') == p['id']])
            p_contacts = len([c for c in contacts if c.get('prospect_id') == p['id']])
            return (p_acts, p_contacts, -len(p.get('created_at', '')))
        
        group.sort(key=score, reverse=True)
        primary = group[0]
        
        for duplicate in group[1:]:
            merge_pair(primary, duplicate, activities, contacts)
            merged += 1
    
    print(f"\n{'='*60}")
    print(f"✅ Merged {merged} duplicate pairs")
    if DRY_RUN:
        print("⚠️ DRY RUN — no changes were made")


if __name__ == '__main__':
    main()
