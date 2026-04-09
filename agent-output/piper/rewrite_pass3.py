#!/usr/bin/env python3
"""
Pass 3: Handle files with non-standard structure (no <article> tags).
Directly insert links and 'At Kande VendTech' into remaining files.
"""

import os
import re
import glob

VENDTECH_DIR = "/Users/kurtishon/clawd/agent-output/piper/blogs/vendtech"

LINK_BLOCK = """
    <p>To learn more about how our <a href="/services/">free vending placement program</a> works, including installation, stocking, and ongoing maintenance at no cost to you, visit our services page.</p>

    <p>If you are ready to explore vending options for your property, <a href="/contact/">contact Kande VendTech</a> or call us at (725) 228-8822 for a free site evaluation.</p>

    <p>We also work with <a href="/apartment-building-vending-machines/">apartment communities across Las Vegas</a>, providing the same full-service vending program with no cost and no hassle for property managers.</p>

    <p>Many of our locations benefit from <a href="/combo-vending-machines/">combo vending machines</a> that offer both snacks and cold beverages in a single unit, saving floor space while maximizing product variety.</p>

    <p>For properties that want to promote wellness, we offer <a href="/healthy-vending-machines/">healthy vending options</a> stocked with better-for-you snacks, low-sugar drinks, and protein-rich choices.</p>
"""

KANDE_PARAGRAPH = '\n    <p>At Kande VendTech, we believe every property deserves reliable, modern vending service backed by a local team that responds quickly and keeps machines fully stocked. As a family-owned Las Vegas vending company, we take pride in understanding each location and tailoring our machines to the specific needs of the people who use them every day.</p>\n'


def count_internal_links(content):
    return len(re.findall(r'href="/(services|apartment|combo|healthy|meal|coffee|hotel|office|contact|about|blog)', content))


def has_at_kande(content):
    return 'At Kande VendTech, we' in content


def fix_file(filepath):
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()
    
    original = content
    changes = []
    
    links = count_internal_links(content)
    has_k = has_at_kande(content)
    
    if links >= 5 and has_k:
        return []
    
    # Find a good insertion point - before footer or CTA section
    # Look for common patterns
    insert_point = None
    
    # Try to find footer
    for marker in ['<!-- Footer', '<!-- CTA', '<footer', '<div class="bg-blue-600', '<div class="bg-indigo-600']:
        idx = content.rfind(marker)
        if idx > 0:
            insert_point = idx
            break
    
    if insert_point is None:
        # Find last </section> or </div> before </body>
        body_end = content.rfind('</body>')
        if body_end > 0:
            insert_point = body_end
    
    if insert_point is None:
        return []
    
    inserts = ""
    
    if not has_k:
        inserts += KANDE_PARAGRAPH
        changes.append("added 'At Kande VendTech, we...'")
    
    if links < 5:
        # Only add links we don't already have
        needed_links = []
        if 'href="/services/' not in content:
            needed_links.append('<p>To learn more about how our <a href="/services/">free vending placement program</a> works, including installation, stocking, and ongoing maintenance at no cost to you, visit our services page.</p>')
        if 'href="/contact/' not in content:
            needed_links.append('<p>If you are ready to explore vending options for your property, <a href="/contact/">contact Kande VendTech</a> or call us at (725) 228-8822 for a free site evaluation.</p>')
        if 'href="/apartment' not in content:
            needed_links.append('<p>We also work with <a href="/apartment-building-vending-machines/">apartment communities across Las Vegas</a>, providing the same full-service vending program with no cost and no hassle for property managers.</p>')
        if 'href="/combo' not in content:
            needed_links.append('<p>Many of our locations benefit from <a href="/combo-vending-machines/">combo vending machines</a> that offer both snacks and cold beverages in a single unit, saving floor space while maximizing product variety.</p>')
        if 'href="/healthy' not in content:
            needed_links.append('<p>For properties that want to promote wellness, we offer <a href="/healthy-vending-machines/">healthy vending options</a> stocked with better-for-you snacks, low-sugar drinks, and protein-rich choices.</p>')
        if 'href="/about/' not in content:
            needed_links.append('<p>Kande VendTech is a <a href="/about/">family-owned Las Vegas vending company</a> focused on smart, full-service vending for commercial and residential properties across the valley.</p>')
        if 'href="/blog/' not in content:
            needed_links.append('<p>Check out our <a href="/blog/">vending blog</a> for more insights on vending machine placement, product selection, and what to look for in a vending partner.</p>')
        
        # Add enough to reach 5
        current = links
        for link_p in needed_links:
            if current >= 5:
                break
            inserts += '\n    ' + link_p
            current += 1
        
        changes.append(f"added internal links (now {current})")
    
    if inserts:
        content = content[:insert_point] + '\n' + inserts + '\n\n  ' + content[insert_point:]
    
    if content != original:
        with open(filepath, 'w', encoding='utf-8') as f:
            f.write(content)
    
    return changes


def main():
    vendtech_files = sorted(glob.glob(os.path.join(VENDTECH_DIR, "*.html")))
    
    print("=== Pass 3: Fixing remaining files ===")
    fixed = 0
    for f in vendtech_files:
        basename = os.path.basename(f)
        changes = fix_file(f)
        if changes:
            fixed += 1
            print(f"  ✓ {basename}: {', '.join(changes)}")
    
    print(f"\n  Fixed {fixed} files")
    
    # Final audit
    print("\n=== Final Audit ===")
    all_pass = True
    for f in vendtech_files:
        basename = os.path.basename(f)
        with open(f, 'r') as fh:
            content = fh.read()
        links = count_internal_links(content)
        has_k = has_at_kande(content)
        issues = []
        if links < 5:
            issues.append(f"links={links}")
        if not has_k:
            issues.append("missing 'At Kande VendTech'")
        if issues:
            print(f"  ⚠ {basename}: {', '.join(issues)}")
            all_pass = False
    
    if all_pass:
        print("  ✅ All 39 VendTech files pass audit!")


if __name__ == "__main__":
    main()
