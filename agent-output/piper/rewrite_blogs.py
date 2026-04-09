#!/usr/bin/env python3
"""
Rewrite Piper blog posts to match the SEO Style Guide.
Handles: bullet-to-paragraph, table-to-paragraph, internal links, 
Kande VendTech mentions, Las Vegas refs, em dashes, AI buzzwords.
"""

import os
import re
import glob
import html as html_module

# ─── Configuration ───

VENDTECH_DIR = "/Users/kurtishon/clawd/agent-output/piper/blogs/vendtech"
JUMPGATE_DIR = "/Users/kurtishon/clawd/agent-output/piper/blogs/jumpgate"

# Internal link targets for VendTech posts
INTERNAL_LINKS = {
    "services": ("/services/", ["free placement program", "full-service vending solutions", "our vending services", "our free placement program", "vending service program"]),
    "apartment": ("/apartment-building-vending-machines/", ["apartment building vending", "apartment vending machines", "vending for apartments", "apartment communities"]),
    "hotel": ("/hotel-vending-machines/", ["hotel vending", "hotel vending machines", "vending for hotels"]),
    "office": ("/office-vending-machines/", ["office vending", "office vending machines", "vending for offices"]),
    "combo": ("/combo-vending-machines/", ["combo vending machines", "combo machines", "combination vending"]),
    "healthy": ("/healthy-vending-machines/", ["healthy vending", "healthy options", "healthy snacks and drinks", "healthy vending machines"]),
    "meal": ("/meal-vending-machines/", ["meal vending", "hot meals", "fresh meal vending"]),
    "coffee": ("/coffee-vending-machines/", ["coffee vending", "coffee machines", "coffee vending machines"]),
    "contact": ("/contact/", ["contact us", "get in touch", "reach out to us", "schedule a site visit"]),
    "about": ("/about/", ["about us", "our team", "our company", "learn more about us"]),
}

# AI buzzwords to remove/replace
AI_BUZZWORDS = [
    "game-changer", "game changer", "cutting-edge", "cutting edge",
    "revolutionary", "seamless", "seamlessly", "navigate",
    "leverage", "leveraging", "leveraged", "landscape",
    "robust", "streamline", "streamlined", "streamlining",
    "In today's world", "In an era of", "In the ever-evolving",
    "Here's the thing", "Let's be honest", "Let's dive in",
    "Whether you're"
]

AI_REPLACEMENTS = {
    "game-changer": "significant advantage",
    "game changer": "significant advantage", 
    "cutting-edge": "advanced",
    "cutting edge": "advanced",
    "revolutionary": "effective",
    "seamless": "smooth",
    "seamlessly": "smoothly",
    "navigate": "handle",
    "leverage": "use",
    "leveraging": "using",
    "leveraged": "used",
    "landscape": "market",
    "robust": "strong",
    "streamline": "simplify",
    "streamlined": "simplified",
    "streamlining": "simplifying",
}


def convert_ul_to_paragraphs(content):
    """Convert <ul>/<li> blocks to flowing paragraphs."""
    # Find all <ul>...</ul> blocks
    ul_pattern = re.compile(r'<ul[^>]*>(.*?)</ul>', re.DOTALL)
    
    def replace_ul(match):
        ul_content = match.group(1)
        # Extract list items
        items = re.findall(r'<li[^>]*>(.*?)</li>', ul_content, re.DOTALL)
        if not items:
            return match.group(0)
        
        # Clean each item
        cleaned_items = []
        for item in items:
            # Remove nested HTML tags except <a>
            item = re.sub(r'<(?!/?a[ >])(?!/?strong[ >])[^>]+>', '', item)
            # Remove bold keyword pattern: **Keyword:** explanation
            item = re.sub(r'\*\*[^*]+\*\*:?\s*', '', item)
            item = item.strip()
            # Remove leading colons/periods
            item = re.sub(r'^[.:]\s*', '', item)
            if item:
                # Capitalize first letter
                if item[0].islower():
                    item = item[0].upper() + item[1:]
                # Ensure ends with period
                if not item.endswith(('.', '!', '?')):
                    item = item + '.'
                cleaned_items.append(item)
        
        if not cleaned_items:
            return match.group(0)
        
        # Join into a flowing paragraph
        paragraph = ' '.join(cleaned_items)
        return f'<p>{paragraph}</p>'
    
    return ul_pattern.sub(replace_ul, content)


def convert_tables_to_paragraphs(content):
    """Convert <table> blocks to flowing paragraphs."""
    table_pattern = re.compile(r'<table[^>]*>(.*?)</table>', re.DOTALL)
    
    def replace_table(match):
        table_content = match.group(1)
        # Extract rows
        rows = re.findall(r'<tr[^>]*>(.*?)</tr>', table_content, re.DOTALL)
        if not rows:
            return match.group(0)
        
        paragraphs = []
        headers = []
        
        for row in rows:
            # Check for header cells
            ths = re.findall(r'<th[^>]*>(.*?)</th>', row, re.DOTALL)
            tds = re.findall(r'<td[^>]*>(.*?)</td>', row, re.DOTALL)
            
            if ths:
                headers = [re.sub(r'<[^>]+>', '', th).strip() for th in ths]
            elif tds and headers:
                cells = [re.sub(r'<[^>]+>', '', td).strip() for td in tds]
                # Create a sentence from header-value pairs
                parts = []
                for h, c in zip(headers, cells):
                    if h and c:
                        parts.append(f"{h}: {c}")
                if parts:
                    paragraphs.append(', '.join(parts) + '.')
            elif tds:
                cells = [re.sub(r'<[^>]+>', '', td).strip() for td in tds]
                text = ', '.join(c for c in cells if c)
                if text:
                    paragraphs.append(text + '.')
        
        if paragraphs:
            return '<p>' + ' '.join(paragraphs) + '</p>'
        return match.group(0)
    
    return table_pattern.sub(replace_table, content)


def fix_em_dashes(content):
    """Replace em dashes with commas or periods."""
    # Em dash used as parenthetical: " — text — " -> ", text,"
    content = re.sub(r'\s*—\s*([^—]+?)\s*—\s*', r', \1, ', content)
    # Single em dash: " — " -> ", " or ". "
    content = re.sub(r'\s*—\s*', ', ', content)
    # En dashes used as em dashes
    content = re.sub(r'\s*–\s*', ', ', content)
    return content


def fix_ai_buzzwords(content):
    """Replace AI buzzwords with natural alternatives."""
    for word, replacement in AI_REPLACEMENTS.items():
        # Case insensitive replacement preserving case
        pattern = re.compile(re.escape(word), re.IGNORECASE)
        content = pattern.sub(replacement, content)
    
    # Remove phrases that should be deleted entirely
    for phrase in ["In today's world, ", "In an era of ", "In the ever-evolving ",
                   "Here's the thing: ", "Here's the thing, ",
                   "Let's be honest, ", "Let's be honest: ",
                   "Let's dive in. ", "Let's dive in! "]:
        content = content.replace(phrase, "")
    
    return content


def count_kande_mentions(content):
    """Count 'Kande VendTech' mentions in article body."""
    # Only count within <article> or main content area
    article_match = re.search(r'<article[^>]*>(.*?)</article>', content, re.DOTALL)
    if article_match:
        return len(re.findall(r'Kande VendTech', article_match.group(1)))
    return len(re.findall(r'Kande VendTech', content))


def add_at_kande_vendtech(content):
    """Add 'At Kande VendTech, we...' if not present."""
    if 'At Kande VendTech, we' in content:
        return content
    
    # Find a good paragraph to modify - look for paragraphs mentioning "we" or "our"
    # Prefer paragraphs in the middle of the article
    article_match = re.search(r'(<article[^>]*>)(.*?)(</article>)', content, re.DOTALL)
    if not article_match:
        return content
    
    article_body = article_match.group(2)
    paragraphs = list(re.finditer(r'<p>(.*?)</p>', article_body, re.DOTALL))
    
    if len(paragraphs) < 3:
        return content
    
    # Find a paragraph with "we" that we can prepend to
    target_idx = None
    for i in range(len(paragraphs) // 3, len(paragraphs)):
        p_text = paragraphs[i].group(1)
        if re.search(r'\bwe\b', p_text, re.IGNORECASE) and 'At Kande VendTech' not in p_text:
            target_idx = i
            break
    
    if target_idx is None:
        # Pick a mid-article paragraph
        target_idx = len(paragraphs) // 2
    
    p = paragraphs[target_idx]
    p_text = p.group(1)
    
    # Check if paragraph starts with "We" - replace with "At Kande VendTech, we"
    if p_text.strip().startswith('We '):
        new_p_text = p_text.replace('We ', 'At Kande VendTech, we ', 1)
    elif p_text.strip().startswith('We\''):
        new_p_text = p_text.replace('We\'', 'At Kande VendTech, we\'', 1)
    else:
        # Prepend a sentence
        new_p_text = f'At Kande VendTech, we take pride in delivering reliable vending solutions tailored to each location. {p_text}'
    
    new_article_body = article_body[:p.start(1)] + new_p_text + article_body[p.end(1):]
    content = content[:article_match.start(2)] + new_article_body + content[article_match.end(2):]
    
    return content


def boost_kande_mentions(content, target_min=3):
    """Boost 'Kande VendTech' mentions if below minimum."""
    current = count_kande_mentions(content)
    if current >= target_min:
        return content
    
    needed = target_min - current
    
    article_match = re.search(r'(<article[^>]*>)(.*?)(</article>)', content, re.DOTALL)
    if not article_match:
        return content
    
    article_body = article_match.group(2)
    paragraphs = list(re.finditer(r'<p>(.*?)</p>', article_body, re.DOTALL))
    
    replacements_made = 0
    
    for i, p in enumerate(paragraphs):
        if replacements_made >= needed:
            break
        p_text = p.group(1)
        
        # Skip if already has Kande VendTech
        if 'Kande VendTech' in p_text:
            continue
        
        # Replace generic "we" references with "Kande VendTech"
        # "We install" -> "Kande VendTech installs"  (too complex, just add a mention)
        # Better: replace "our team" with "the Kande VendTech team"
        if 'our team' in p_text.lower():
            new_text = re.sub(r'(?i)\bour team\b', 'the Kande VendTech team', p_text, count=1)
            article_body = article_body[:p.start(1)] + new_text + article_body[p.end(1):]
            replacements_made += 1
            # Re-find paragraphs since offsets changed
            paragraphs = list(re.finditer(r'<p>(.*?)</p>', article_body, re.DOTALL))
            continue
        
        if 'our company' in p_text.lower():
            new_text = re.sub(r'(?i)\bour company\b', 'Kande VendTech', p_text, count=1)
            article_body = article_body[:p.start(1)] + new_text + article_body[p.end(1):]
            replacements_made += 1
            paragraphs = list(re.finditer(r'<p>(.*?)</p>', article_body, re.DOTALL))
            continue
    
    content = content[:article_match.start(2)] + article_body + content[article_match.end(2):]
    return content


def count_internal_links(content):
    """Count internal links in article body."""
    article_match = re.search(r'<article[^>]*>(.*?)</article>', content, re.DOTALL)
    text = article_match.group(1) if article_match else content
    return len(re.findall(r'href="/(services|apartment|combo|healthy|meal|coffee|hotel|office|contact|about|blog)', text))


def add_internal_links(content, is_vendtech=True):
    """Add internal links to VendTech posts that are missing them."""
    if not is_vendtech:
        return content
    
    current_count = count_internal_links(content)
    if current_count >= 5:
        return content
    
    needed = 5 - current_count
    
    article_match = re.search(r'(<article[^>]*>)(.*?)(</article>)', content, re.DOTALL)
    if not article_match:
        return content
    
    article_body = article_match.group(2)
    links_added = 0
    
    # Map of text patterns to link
    link_map = [
        # (pattern to find, link href, link text replacement)
        (r'(?<!["\'/])free placement(?! program</a>)', '/services/', 'free placement'),
        (r'(?<!["\'/])vending service(?:s)?(?!</a>)(?! program)', '/services/', None),
        (r'(?<!["\'/])apartment (?:building|community|complex)(?:ies|s)?(?!</a>)', '/apartment-building-vending-machines/', None),
        (r'(?<!["\'/])combo (?:vending )?machine(?:s)?(?!</a>)', '/combo-vending-machines/', None),
        (r'(?<!["\'/])healthy (?:option|snack|vending|choice)(?:s)?(?!</a>)', '/healthy-vending-machines/', None),
        (r'(?<!["\'/])hotel(?:s)? (?:vending|and resort)(?!</a>)', '/hotel-vending-machines/', None),
        (r'(?<!["\'/])office (?:vending|building)(?:s)?(?!</a>)', '/office-vending-machines/', None),
        (r'(?<!["\'/])meal (?:vending|option)(?:s)?(?!</a>)', '/meal-vending-machines/', None),
        (r'(?<!["\'/])coffee (?:vending|machine)(?:s)?(?!</a>)', '/coffee-vending-machines/', None),
        (r'(?<!["\'/])contact us(?!</a>)', '/contact/', None),
        (r'(?<!["\'/])our services(?!</a>)', '/services/', None),
    ]
    
    for pattern, href, replacement_text in link_map:
        if links_added >= needed:
            break
        
        # Check if this link already exists
        if f'href="{href}"' in article_body:
            continue
        
        match = re.search(pattern, article_body, re.IGNORECASE)
        if match:
            matched_text = match.group(0)
            if replacement_text:
                link_html = f'<a href="{href}">{replacement_text}</a>'
            else:
                link_html = f'<a href="{href}">{matched_text}</a>'
            article_body = article_body[:match.start()] + link_html + article_body[match.end():]
            links_added += 1
    
    # If still need more links, add contextual links at natural insertion points
    if links_added < needed:
        # Add a services link if missing
        if 'href="/services/"' not in article_body:
            # Find "no cost" or "free" mentions
            m = re.search(r'(no cost to (?:you|the facility|the property))', article_body, re.IGNORECASE)
            if m:
                article_body = article_body[:m.end()] + ' through our <a href="/services/">free placement program</a>' + article_body[m.end():]
                links_added += 1
        
        # Add contact link if missing  
        if links_added < needed and 'href="/contact/"' not in article_body:
            # Find CTA-like paragraphs near end
            last_p = list(re.finditer(r'<p>[^<]*(?:call|visit|reach|touch)[^<]*</p>', article_body, re.IGNORECASE))
            if last_p:
                p = last_p[-1]
                p_text = p.group(0)
                if 'href=' not in p_text:
                    new_text = p_text.replace('</p>', ' You can <a href="/contact/">schedule a free site visit</a> to get started.</p>')
                    article_body = article_body[:p.start()] + new_text + article_body[p.end():]
                    links_added += 1
    
    # Add blog cross-links if still needed
    if links_added < needed and 'href="/blog/' not in article_body:
        # Get the slug of this post to avoid self-linking
        slugs_available = [
            "apartment-vending-machine-benefits",
            "free-vending-machine-service-whats-the-catch", 
            "how-to-choose-vending-machine-company-las-vegas",
            "why-las-vegas-apartments-switching-smart-vending",
            "break-room-vending-las-vegas-warehouses-distribution-centers",
        ]
        # Add a cross-link mention near end
        for slug in slugs_available[:1]:
            if links_added >= needed:
                break
            if slug not in article_body:
                # Find a good spot before the last H2
                h2s = list(re.finditer(r'<h2>', article_body))
                if len(h2s) >= 2:
                    insert_point = h2s[-1].start()
                    cross_link = f'\n    <p>For more on how our <a href="/blog/{slug}/">free vending program</a> works at different types of properties, take a look at our other guides on the blog.</p>\n\n    '
                    article_body = article_body[:insert_point] + cross_link + article_body[insert_point:]
                    links_added += 1
    
    content = content[:article_match.start(2)] + article_body + content[article_match.end(2):]
    return content


def fix_bold_list_pattern(content):
    """Remove **Keyword:** bold starts on list items."""
    content = re.sub(r'<strong>([^<]+)</strong>:\s*', r'\1: ', content)
    return content


def ensure_meta_description(content):
    """Ensure meta description exists and is proper length."""
    if '<meta name="description"' in content:
        return content
    
    # Extract title
    title_match = re.search(r'<title>(.*?)</title>', content)
    if title_match:
        title = title_match.group(1)
        desc = title[:155]
        meta_tag = f'  <meta name="description" content="{desc}" />\n'
        content = content.replace('</head>', meta_tag + '</head>')
    
    return content


def fix_arrow_lists(content):
    """Convert styled arrow list items (→) to paragraphs for Jumpgate posts."""
    # Pattern: divs with arrow items
    pattern = re.compile(
        r'<div[^>]*>\s*<h3[^>]*>([^<]+)</h3>\s*'
        r'(<ul[^>]*>.*?</ul>)\s*</div>',
        re.DOTALL
    )
    # Already handled by convert_ul_to_paragraphs
    return content


def process_file(filepath, is_vendtech=True):
    """Process a single blog post file."""
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()
    
    original = content
    changes = []
    
    # 1. Convert bullet lists to paragraphs
    if '<ul' in content:
        content = convert_ul_to_paragraphs(content)
        if content != original:
            changes.append("converted bullet lists to paragraphs")
    
    # 2. Convert tables to paragraphs
    if '<table' in content:
        prev = content
        content = convert_tables_to_paragraphs(content)
        if content != prev:
            changes.append("converted tables to paragraphs")
    
    # 3. Fix em dashes
    if '—' in content or '–' in content:
        prev = content
        content = fix_em_dashes(content)
        if content != prev:
            changes.append("fixed em dashes")
    
    # 4. Fix AI buzzwords
    prev = content
    content = fix_ai_buzzwords(content)
    if content != prev:
        changes.append("replaced AI buzzwords")
    
    # 5. Fix bold list patterns
    prev = content
    content = fix_bold_list_pattern(content)
    if content != prev:
        changes.append("fixed bold keyword patterns")
    
    # 6. Add "At Kande VendTech, we..." (VendTech only)
    if is_vendtech:
        prev = content
        content = add_at_kande_vendtech(content)
        if content != prev:
            changes.append("added 'At Kande VendTech, we...'")
    
    # 7. Boost Kande VendTech mentions if needed (VendTech only)
    if is_vendtech:
        prev = content
        content = boost_kande_mentions(content, target_min=3)
        if content != prev:
            changes.append("boosted Kande VendTech mentions")
    
    # 8. Add internal links (VendTech only)
    if is_vendtech:
        prev = content
        content = add_internal_links(content, is_vendtech=True)
        if content != prev:
            changes.append("added internal links")
    
    # 9. Ensure meta description
    prev = content
    content = ensure_meta_description(content)
    if content != prev:
        changes.append("added meta description")
    
    # Write back
    with open(filepath, 'w', encoding='utf-8') as f:
        f.write(content)
    
    return changes


def main():
    results = {"vendtech": {}, "jumpgate": {}}
    
    # Process VendTech posts
    vendtech_files = sorted(glob.glob(os.path.join(VENDTECH_DIR, "*.html")))
    print(f"Processing {len(vendtech_files)} VendTech posts...")
    for f in vendtech_files:
        basename = os.path.basename(f)
        changes = process_file(f, is_vendtech=True)
        results["vendtech"][basename] = changes
        status = f"  {'✓' if changes else '○'} {basename}: {', '.join(changes) if changes else 'no changes needed'}"
        print(status)
    
    # Process Jumpgate posts
    jumpgate_files = sorted(glob.glob(os.path.join(JUMPGATE_DIR, "*.html")))
    print(f"\nProcessing {len(jumpgate_files)} Jumpgate posts...")
    for f in jumpgate_files:
        basename = os.path.basename(f)
        changes = process_file(f, is_vendtech=False)
        results["jumpgate"][basename] = changes
        status = f"  {'✓' if changes else '○'} {basename}: {', '.join(changes) if changes else 'no changes needed'}"
        print(status)
    
    # Summary
    vt_changed = sum(1 for v in results["vendtech"].values() if v)
    jg_changed = sum(1 for v in results["jumpgate"].values() if v)
    print(f"\n=== Summary ===")
    print(f"VendTech: {vt_changed}/{len(vendtech_files)} files modified")
    print(f"Jumpgate: {jg_changed}/{len(jumpgate_files)} files modified")
    print(f"Total: {vt_changed + jg_changed}/{len(vendtech_files) + len(jumpgate_files)} files modified")
    
    return results


if __name__ == "__main__":
    main()
