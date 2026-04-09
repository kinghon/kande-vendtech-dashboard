#!/usr/bin/env python3
"""
Pass 2: Force-add internal links and 'At Kande VendTech, we...' to files that still need them.
"""

import os
import re
import glob

VENDTECH_DIR = "/Users/kurtishon/clawd/agent-output/piper/blogs/vendtech"

# Available blog slugs for cross-linking
BLOG_SLUGS = [
    ("apartment-vending-machine-benefits", "apartment vending benefits"),
    ("free-vending-machine-service-whats-the-catch", "free vending service"),
    ("how-to-choose-vending-machine-company-las-vegas", "choosing a vending company"),
    ("why-las-vegas-apartments-switching-smart-vending", "smart vending for apartments"),
    ("break-room-vending-las-vegas-warehouses-distribution-centers", "break room vending"),
    ("smart-vending-machine-service-henderson-nv", "Henderson vending service"),
]

# Contextual link insertions - sentences to add near end of articles
LINK_SENTENCES = [
    ('services', '<p>To learn more about how our <a href="/services/">free vending placement program</a> works, including installation, stocking, and ongoing maintenance at no cost to you, visit our services page.</p>'),
    ('contact', '<p>If you are ready to explore vending options for your property, <a href="/contact/">contact Kande VendTech</a> or call us at (725) 228-8822 for a free site evaluation.</p>'),
    ('apartment', '<p>We also work with <a href="/apartment-building-vending-machines/">apartment communities across Las Vegas</a>, providing the same full-service vending program with no cost and no hassle for property managers.</p>'),
    ('combo', '<p>Many of our locations benefit from <a href="/combo-vending-machines/">combo vending machines</a> that offer both snacks and cold beverages in a single unit, saving floor space while maximizing product variety.</p>'),
    ('healthy', '<p>For properties that want to promote wellness, we offer <a href="/healthy-vending-machines/">healthy vending options</a> stocked with better-for-you snacks, low-sugar drinks, and protein-rich choices.</p>'),
    ('about', '<p>Kande VendTech is a <a href="/about/">family-owned Las Vegas vending company</a> focused on smart, full-service vending for commercial and residential properties across the valley.</p>'),
    ('blog', '<p>Check out our <a href="/blog/">vending blog</a> for more insights on vending machine placement, product selection, and what to look for in a vending partner.</p>'),
]


def count_internal_links(content):
    article_match = re.search(r'<article[^>]*>(.*?)</article>', content, re.DOTALL)
    text = article_match.group(1) if article_match else content
    return len(re.findall(r'href="/(services|apartment|combo|healthy|meal|coffee|hotel|office|contact|about|blog)', text))


def has_at_kande(content):
    return 'At Kande VendTech, we' in content


def force_add_links(filepath):
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()
    
    current_links = count_internal_links(content)
    if current_links >= 5:
        return False, current_links
    
    needed = 5 - current_links
    
    # Find the closing </article> tag and insert link paragraphs before it
    article_end = content.rfind('</article>')
    if article_end == -1:
        return False, current_links
    
    # Find the last </p> or </ol> or </h2> before </article>
    # Insert link paragraphs before the last section heading or at end of article
    last_h2 = content.rfind('<h2>', 0, article_end)
    
    # Check which link categories are already present
    existing = set()
    for cat in ['services', 'contact', 'apartment', 'combo', 'healthy', 'about', 'blog']:
        if f'href="/{cat}' in content:
            existing.add(cat)
    
    inserts = []
    for cat, sentence in LINK_SENTENCES:
        if len(inserts) >= needed:
            break
        if cat not in existing:
            inserts.append(sentence)
            existing.add(cat)
    
    if not inserts:
        return False, current_links
    
    # Insert before the last H2 section (usually "Getting Started" or CTA section)
    insert_text = '\n\n    ' + '\n\n    '.join(inserts) + '\n\n    '
    
    if last_h2 > 0:
        content = content[:last_h2] + insert_text + content[last_h2:]
    else:
        content = content[:article_end] + insert_text + content[article_end:]
    
    with open(filepath, 'w', encoding='utf-8') as f:
        f.write(content)
    
    new_count = count_internal_links(content)
    return True, new_count


def force_add_at_kande(filepath):
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()
    
    if has_at_kande(content):
        return False
    
    # Find paragraphs starting with "We " or "We'" in article body
    article_match = re.search(r'(<article[^>]*>)(.*?)(</article>)', content, re.DOTALL)
    if not article_match:
        return False
    
    article_body = article_match.group(2)
    
    # Strategy 1: Replace a "We " paragraph start
    patterns = [
        (r'(<p>)We have been ', r'\1At Kande VendTech, we have been '),
        (r'(<p>)We\'ve been ', r'\1At Kande VendTech, we\'ve been '),
        (r'(<p>)We work ', r'\1At Kande VendTech, we work '),
        (r'(<p>)We install ', r'\1At Kande VendTech, we install '),
        (r'(<p>)We supply ', r'\1At Kande VendTech, we supply '),
        (r'(<p>)We place ', r'\1At Kande VendTech, we place '),
        (r'(<p>)We service ', r'\1At Kande VendTech, we service '),
        (r'(<p>)We stock ', r'\1At Kande VendTech, we stock '),
        (r'(<p>)We offer ', r'\1At Kande VendTech, we offer '),
        (r'(<p>)We handle ', r'\1At Kande VendTech, we handle '),
        (r'(<p>)We manage ', r'\1At Kande VendTech, we manage '),
        (r'(<p>)We provide ', r'\1At Kande VendTech, we provide '),
        (r'(<p>)We maintain ', r'\1At Kande VendTech, we maintain '),
        (r'(<p>)We adjust ', r'\1At Kande VendTech, we adjust '),
        (r'(<p>)We configure ', r'\1At Kande VendTech, we configure '),
        (r'(<p>)We can ', r'\1At Kande VendTech, we can '),
        (r'(<p>)We are ', r'\1At Kande VendTech, we are '),
        (r'(<p>)We\'re ', r'\1At Kande VendTech, we\'re '),
        (r'(<p>)We do ', r'\1At Kande VendTech, we do '),
        (r'(<p>)We don\'t ', r'\1At Kande VendTech, we don\'t '),
        (r'(<p>)We run ', r'\1At Kande VendTech, we run '),
        (r'(<p>)We built ', r'\1At Kande VendTech, we built '),
        (r'(<p>)We designed ', r'\1At Kande VendTech, we designed '),
        (r'(<p>)We tailor ', r'\1At Kande VendTech, we tailor '),
    ]
    
    new_body = article_body
    for pattern, replacement in patterns:
        new_body_candidate = re.sub(pattern, replacement, new_body, count=1)
        if new_body_candidate != new_body:
            new_body = new_body_candidate
            break
    
    if new_body == article_body:
        # Strategy 2: Find any paragraph with " we " and insert before it
        m = re.search(r'(<p>[^<]{20,100})\bwe\b', article_body)
        if m:
            # Just add a new sentence before a mid-article paragraph
            paragraphs = list(re.finditer(r'<p>', article_body))
            if len(paragraphs) >= 4:
                # Insert after the 3rd paragraph
                third_p_end = article_body.find('</p>', paragraphs[2].end()) + len('</p>')
                insert = '\n\n    <p>At Kande VendTech, we believe every property deserves reliable, modern vending service backed by a local team that responds quickly and keeps machines fully stocked.</p>'
                new_body = article_body[:third_p_end] + insert + article_body[third_p_end:]
            else:
                # Just insert before closing
                insert = '\n\n    <p>At Kande VendTech, we believe every property deserves reliable, modern vending service backed by a local team that responds quickly and keeps machines fully stocked.</p>\n'
                new_body = article_body + insert
    
    if new_body != article_body:
        content = content[:article_match.start(2)] + new_body + content[article_match.end(2):]
        with open(filepath, 'w', encoding='utf-8') as f:
            f.write(content)
        return True
    
    return False


def main():
    vendtech_files = sorted(glob.glob(os.path.join(VENDTECH_DIR, "*.html")))
    
    print("=== Pass 2: Force-adding internal links ===")
    link_fixed = 0
    for f in vendtech_files:
        basename = os.path.basename(f)
        changed, count = force_add_links(f)
        if changed:
            link_fixed += 1
            print(f"  ✓ {basename}: now has {count} internal links")
    print(f"  Fixed {link_fixed} files\n")
    
    print("=== Pass 2: Force-adding 'At Kande VendTech, we...' ===")
    kande_fixed = 0
    for f in vendtech_files:
        basename = os.path.basename(f)
        if force_add_at_kande(f):
            kande_fixed += 1
            print(f"  ✓ {basename}")
    print(f"  Fixed {kande_fixed} files\n")
    
    # Final audit
    print("=== Final Audit ===")
    low_links = 0
    no_kande = 0
    for f in vendtech_files:
        basename = os.path.basename(f)
        with open(f, 'r') as fh:
            content = fh.read()
        links = count_internal_links(content)
        has_k = has_at_kande(content)
        issues = []
        if links < 5:
            issues.append(f"links={links}")
            low_links += 1
        if not has_k:
            issues.append("missing 'At Kande VendTech'")
            no_kande += 1
        if issues:
            print(f"  ⚠ {basename}: {', '.join(issues)}")
    
    if low_links == 0 and no_kande == 0:
        print("  All VendTech files pass audit!")
    else:
        print(f"\n  {low_links} files still need more links")
        print(f"  {no_kande} files still missing 'At Kande VendTech'")


if __name__ == "__main__":
    main()
