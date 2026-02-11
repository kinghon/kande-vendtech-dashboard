const fs = require('fs');
const path = require('path');

const PAGES_DIR = path.join(__dirname, 'dashboard', 'pages');

const NAV_LINKS = [
  { href: '/', label: 'Home' },
  { href: '/snack-vending-machines', label: 'Snack' },
  { href: '/coffee-vending-machines', label: 'Coffee' },
  { href: '/combo-vending-machines', label: 'Combo' },
  { href: '/drink-vending-machines', label: 'Drinks' },
  { href: '/healthy-vending-machines', label: 'Healthy' },
  { href: '/meal-vending-machines', label: 'Meals' },
  { href: '/apartment-building-vending-machines', label: 'Apartments' },
  { href: '/gym-vending-machines', label: 'Gyms' },
  { href: '/hospital-vending-machines', label: 'Hospitals' },
  { href: '/hotel-vending-machines', label: 'Hotels' },
  { href: '/school-vending-machines', label: 'Schools' },
  { href: '/workplace-vending-machines', label: 'Workplace' },
  { href: '/office-vending-machines', label: 'Office' },
];

function navHTML(currentHref) {
  const links = NAV_LINKS.map(l => {
    const active = l.href === currentHref ? ' class="active"' : '';
    return `<a href="${l.href}"${active}>${l.label}</a>`;
  }).join('\n            ');
  return links;
}

function footerLinks(currentHref) {
  const product = NAV_LINKS.filter(l => ['/snack-vending-machines','/coffee-vending-machines','/combo-vending-machines','/drink-vending-machines','/healthy-vending-machines','/meal-vending-machines'].includes(l.href));
  const vertical = NAV_LINKS.filter(l => ['/apartment-building-vending-machines','/gym-vending-machines','/hospital-vending-machines','/hotel-vending-machines','/school-vending-machines','/workplace-vending-machines','/office-vending-machines'].includes(l.href));
  
  const productLinks = product.map(l => `<li><a href="${l.href}">${l.label} Vending</a></li>`).join('\n                  ');
  const verticalLinks = vertical.map(l => `<li><a href="${l.href}">${l.label} Vending</a></li>`).join('\n                  ');
  return { productLinks, verticalLinks };
}

function generatePage(config) {
  const { filename, slug, metaTitle, metaDescription, h1, heroSubtitle, heroCTA, benefitsTitle, benefits, featuresTitle, features, howItWorksTitle, steps, socialProof, ctaTitle, ctaSubtitle, mainContent, schemaDescription } = config;
  
  const nav = navHTML(slug);
  const { productLinks, verticalLinks } = footerLinks(slug);
  
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${metaTitle} | Kande VendTech</title>
  <meta name="description" content="${metaDescription}">
  <meta name="robots" content="index, follow">
  <link rel="canonical" href="https://kandevendtech.com${slug === '/' ? '' : slug}">
  <meta property="og:title" content="${metaTitle} | Kande VendTech">
  <meta property="og:description" content="${metaDescription}">
  <meta property="og:url" content="https://kandevendtech.com${slug === '/' ? '' : slug}">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="Kande VendTech">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${metaTitle} | Kande VendTech">
  <meta name="twitter:description" content="${metaDescription}">
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "LocalBusiness",
    "name": "Kande VendTech",
    "description": "${schemaDescription || metaDescription}",
    "url": "https://kandevendtech.com",
    "telephone": "+1-725-228-8822",
    "email": "kurtis@kandevendtech.com",
    "address": {
      "@type": "PostalAddress",
      "streetAddress": "5725 S Valley View Blvd Suite 6",
      "addressLocality": "Las Vegas",
      "addressRegion": "NV",
      "postalCode": "89118",
      "addressCountry": "US"
    },
    "areaServed": [
      { "@type": "City", "name": "Las Vegas" },
      { "@type": "City", "name": "Henderson" },
      { "@type": "City", "name": "North Las Vegas" },
      { "@type": "City", "name": "Summerlin" },
      { "@type": "City", "name": "Boulder City" }
    ],
    "priceRange": "Free",
    "openingHours": "Mo-Su 00:00-23:59",
    "sameAs": []
  }
  </script>
  <style>
    /* === RESET & BASE === */
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html { scroll-behavior: smooth; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      color: #e0e6ed;
      background: #0a0f1a;
      line-height: 1.7;
      font-size: 16px;
    }
    a { color: #f59e0b; text-decoration: none; transition: color 0.2s; }
    a:hover { color: #fbbf24; }
    img { max-width: 100%; height: auto; }
    
    /* === HEADER / NAV === */
    .site-header {
      background: linear-gradient(135deg, #0d1526 0%, #131d35 100%);
      border-bottom: 1px solid rgba(245, 158, 11, 0.15);
      position: sticky; top: 0; z-index: 100;
    }
    .header-inner {
      max-width: 1200px; margin: 0 auto;
      display: flex; align-items: center; justify-content: space-between;
      padding: 0.75rem 1.5rem;
    }
    .logo {
      font-size: 1.4rem; font-weight: 800; color: #fff;
      display: flex; align-items: center; gap: 0.5rem;
    }
    .logo span { color: #f59e0b; }
    .nav-toggle {
      display: none; background: none; border: none; color: #fff;
      font-size: 1.5rem; cursor: pointer; padding: 0.25rem;
    }
    .nav-links {
      display: flex; flex-wrap: wrap; gap: 0.25rem; align-items: center;
    }
    .nav-links a {
      color: #94a3b8; font-size: 0.85rem; font-weight: 500;
      padding: 0.4rem 0.7rem; border-radius: 6px; transition: all 0.2s;
      white-space: nowrap;
    }
    .nav-links a:hover, .nav-links a.active {
      color: #f59e0b; background: rgba(245, 158, 11, 0.08);
    }
    .nav-cta {
      background: linear-gradient(135deg, #f59e0b, #d97706) !important;
      color: #0a0f1a !important; font-weight: 700 !important;
      padding: 0.5rem 1rem !important; border-radius: 8px !important;
      font-size: 0.85rem !important;
    }
    .nav-cta:hover { transform: translateY(-1px); box-shadow: 0 4px 15px rgba(245, 158, 11, 0.3); }

    @media (max-width: 900px) {
      .nav-toggle { display: block; }
      .nav-links {
        display: none; flex-direction: column; width: 100%;
        position: absolute; top: 100%; left: 0;
        background: #131d35; border-top: 1px solid rgba(245, 158, 11, 0.1);
        padding: 1rem; gap: 0.25rem;
      }
      .nav-links.open { display: flex; }
      .nav-links a { padding: 0.6rem 1rem; width: 100%; }
    }

    /* === HERO === */
    .hero {
      background: linear-gradient(160deg, #0d1526 0%, #162038 40%, #1a1a2e 100%);
      padding: 5rem 1.5rem 4rem;
      text-align: center;
      position: relative; overflow: hidden;
    }
    .hero::before {
      content: ''; position: absolute; top: -50%; right: -30%;
      width: 600px; height: 600px;
      background: radial-gradient(circle, rgba(245, 158, 11, 0.06) 0%, transparent 70%);
      border-radius: 50%;
    }
    .hero-inner { max-width: 800px; margin: 0 auto; position: relative; z-index: 1; }
    .hero-badge {
      display: inline-block; background: rgba(245, 158, 11, 0.1);
      color: #f59e0b; font-size: 0.85rem; font-weight: 600;
      padding: 0.4rem 1.2rem; border-radius: 50px;
      border: 1px solid rgba(245, 158, 11, 0.2); margin-bottom: 1.5rem;
      letter-spacing: 0.5px;
    }
    .hero h1 {
      font-size: clamp(2rem, 5vw, 3.2rem); font-weight: 800;
      color: #fff; margin-bottom: 1rem;
      line-height: 1.2;
    }
    .hero h1 em { color: #f59e0b; font-style: normal; }
    .hero p {
      font-size: 1.15rem; color: #94a3b8; margin-bottom: 2rem;
      max-width: 600px; margin-left: auto; margin-right: auto;
    }
    .hero-actions { display: flex; gap: 1rem; justify-content: center; flex-wrap: wrap; }

    /* === BUTTONS === */
    .btn {
      display: inline-flex; align-items: center; gap: 0.5rem;
      padding: 0.85rem 2rem; border-radius: 10px; font-weight: 700;
      font-size: 1rem; cursor: pointer; border: none; transition: all 0.3s;
      text-decoration: none;
    }
    .btn-primary {
      background: linear-gradient(135deg, #f59e0b, #d97706);
      color: #0a0f1a; box-shadow: 0 4px 20px rgba(245, 158, 11, 0.25);
    }
    .btn-primary:hover { transform: translateY(-2px); box-shadow: 0 8px 30px rgba(245, 158, 11, 0.35); color: #0a0f1a; }
    .btn-secondary {
      background: rgba(255,255,255,0.05); color: #e0e6ed;
      border: 1px solid rgba(255,255,255,0.15);
    }
    .btn-secondary:hover { background: rgba(255,255,255,0.1); color: #fff; }

    /* === SECTIONS === */
    .section { padding: 5rem 1.5rem; }
    .section-inner { max-width: 1100px; margin: 0 auto; }
    .section-dark { background: #0d1526; }
    .section-darker { background: #0a0f1a; }
    .section-title {
      font-size: clamp(1.6rem, 3.5vw, 2.4rem); font-weight: 800;
      color: #fff; text-align: center; margin-bottom: 0.75rem;
    }
    .section-subtitle {
      color: #94a3b8; text-align: center; font-size: 1.05rem;
      max-width: 650px; margin: 0 auto 3rem;
    }

    /* === GRID CARDS === */
    .grid { display: grid; gap: 1.5rem; }
    .grid-2 { grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); }
    .grid-3 { grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); }
    .grid-4 { grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); }
    .card {
      background: linear-gradient(145deg, #131d35, #0f1729);
      border: 1px solid rgba(255,255,255,0.06);
      border-radius: 16px; padding: 2rem;
      transition: all 0.3s;
    }
    .card:hover {
      border-color: rgba(245, 158, 11, 0.2);
      transform: translateY(-3px);
      box-shadow: 0 10px 40px rgba(0,0,0,0.3);
    }
    .card-icon {
      width: 56px; height: 56px; border-radius: 14px;
      background: rgba(245, 158, 11, 0.1); display: flex;
      align-items: center; justify-content: center; font-size: 1.5rem;
      margin-bottom: 1.25rem;
    }
    .card h3 {
      font-size: 1.15rem; font-weight: 700; color: #fff;
      margin-bottom: 0.5rem;
    }
    .card p { color: #94a3b8; font-size: 0.95rem; }

    /* === STEPS (How It Works) === */
    .steps { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 2rem; counter-reset: step; }
    .step {
      text-align: center; padding: 2rem 1.5rem;
      position: relative; counter-increment: step;
    }
    .step::before {
      content: counter(step);
      display: flex; align-items: center; justify-content: center;
      width: 56px; height: 56px; border-radius: 50%;
      background: linear-gradient(135deg, #f59e0b, #d97706);
      color: #0a0f1a; font-size: 1.3rem; font-weight: 800;
      margin: 0 auto 1.25rem;
    }
    .step h3 { font-size: 1.15rem; color: #fff; margin-bottom: 0.5rem; }
    .step p { color: #94a3b8; font-size: 0.95rem; }

    /* === TRUST BAR === */
    .trust-bar {
      display: flex; flex-wrap: wrap; justify-content: center;
      gap: 2rem; padding: 2.5rem 1.5rem;
      border-top: 1px solid rgba(255,255,255,0.05);
      border-bottom: 1px solid rgba(255,255,255,0.05);
    }
    .trust-item {
      display: flex; align-items: center; gap: 0.5rem;
      color: #94a3b8; font-size: 0.9rem; font-weight: 500;
    }
    .trust-item .icon { font-size: 1.2rem; color: #f59e0b; }

    /* === STATS === */
    .stats { display: flex; flex-wrap: wrap; justify-content: center; gap: 3rem; margin: 3rem 0; }
    .stat { text-align: center; }
    .stat-number { font-size: 2.5rem; font-weight: 800; color: #f59e0b; }
    .stat-label { color: #94a3b8; font-size: 0.9rem; margin-top: 0.25rem; }

    /* === CTA SECTION === */
    .cta-section {
      background: linear-gradient(135deg, #162038 0%, #1a1a2e 100%);
      padding: 5rem 1.5rem; text-align: center;
      border-top: 1px solid rgba(245, 158, 11, 0.1);
    }
    .cta-section h2 { font-size: clamp(1.6rem, 3.5vw, 2.4rem); color: #fff; margin-bottom: 0.75rem; }
    .cta-section p { color: #94a3b8; font-size: 1.05rem; max-width: 550px; margin: 0 auto 2rem; }
    .cta-contact {
      display: flex; flex-wrap: wrap; justify-content: center; gap: 2rem;
      margin-top: 2rem;
    }
    .cta-contact a {
      display: flex; align-items: center; gap: 0.5rem;
      font-size: 1.05rem; font-weight: 600;
    }

    /* === TESTIMONIAL === */
    .testimonial-card {
      background: linear-gradient(145deg, #131d35, #0f1729);
      border: 1px solid rgba(245, 158, 11, 0.15);
      border-radius: 16px; padding: 2.5rem; text-align: center;
      max-width: 700px; margin: 0 auto;
    }
    .testimonial-card .stars { color: #f59e0b; font-size: 1.3rem; margin-bottom: 1rem; }
    .testimonial-card blockquote {
      color: #cbd5e1; font-size: 1.05rem; font-style: italic;
      margin-bottom: 1rem; line-height: 1.8;
    }
    .testimonial-card .author { color: #f59e0b; font-weight: 600; }

    /* === CONTENT SECTION === */
    .content-block { max-width: 800px; margin: 0 auto; }
    .content-block h2 {
      font-size: 1.6rem; color: #fff; margin: 2.5rem 0 1rem;
      padding-bottom: 0.5rem; border-bottom: 2px solid rgba(245, 158, 11, 0.2);
    }
    .content-block p { color: #b0bec5; margin-bottom: 1rem; font-size: 1rem; }
    .content-block ul {
      list-style: none; margin-bottom: 1.5rem;
    }
    .content-block ul li {
      padding: 0.4rem 0 0.4rem 1.5rem; color: #b0bec5;
      position: relative;
    }
    .content-block ul li::before {
      content: '✓'; position: absolute; left: 0;
      color: #f59e0b; font-weight: 700;
    }

    /* === FAQ === */
    .faq-item { margin-bottom: 1.5rem; }
    .faq-item h3 { color: #fff; font-size: 1.1rem; margin-bottom: 0.5rem; }
    .faq-item p { color: #94a3b8; }

    /* === FOOTER === */
    .site-footer {
      background: #070b14; border-top: 1px solid rgba(255,255,255,0.05);
      padding: 4rem 1.5rem 2rem;
    }
    .footer-inner {
      max-width: 1100px; margin: 0 auto;
      display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 2.5rem;
    }
    .footer-col h4 {
      color: #fff; font-size: 1rem; font-weight: 700;
      margin-bottom: 1rem; text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .footer-col p, .footer-col a { color: #64748b; font-size: 0.9rem; }
    .footer-col ul { list-style: none; }
    .footer-col ul li { margin-bottom: 0.5rem; }
    .footer-col ul li a:hover { color: #f59e0b; }
    .footer-bottom {
      max-width: 1100px; margin: 2.5rem auto 0;
      padding-top: 2rem; border-top: 1px solid rgba(255,255,255,0.05);
      text-align: center; color: #475569; font-size: 0.85rem;
    }

    /* === SERVICE AREA === */
    .service-area {
      display: flex; flex-wrap: wrap; justify-content: center; gap: 0.75rem;
      margin-top: 1.5rem;
    }
    .area-tag {
      background: rgba(245, 158, 11, 0.08); color: #f59e0b;
      padding: 0.35rem 1rem; border-radius: 50px; font-size: 0.85rem;
      font-weight: 500; border: 1px solid rgba(245, 158, 11, 0.15);
    }

    /* === RESPONSIVE === */
    @media (max-width: 600px) {
      .hero { padding: 3rem 1rem 2.5rem; }
      .section { padding: 3rem 1rem; }
      .card { padding: 1.5rem; }
      .stats { gap: 1.5rem; }
      .stat-number { font-size: 2rem; }
    }
  </style>
</head>
<body>

  <!-- HEADER -->
  <header class="site-header">
    <div class="header-inner">
      <a href="/" class="logo">🟠 Kande <span>VendTech</span></a>
      <button class="nav-toggle" onclick="this.nextElementSibling.classList.toggle('open')" aria-label="Toggle navigation">☰</button>
      <nav class="nav-links">
        ${nav}
        <a href="tel:7252288822" class="nav-cta">📞 725-228-8822</a>
      </nav>
    </div>
  </header>

  <!-- HERO -->
  <section class="hero">
    <div class="hero-inner">
      <div class="hero-badge">${config.heroBadge || '🤖 AI-Powered Smart Vending in Las Vegas'}</div>
      <h1>${h1}</h1>
      <p>${heroSubtitle}</p>
      <div class="hero-actions">
        <a href="tel:7252288822" class="btn btn-primary">📞 ${heroCTA || 'Get a Free Vending Machine'}</a>
        <a href="mailto:kurtis@kandevendtech.com" class="btn btn-secondary">✉️ Request a Free Quote</a>
      </div>
    </div>
  </section>

  <!-- TRUST BAR -->
  <div class="trust-bar">
    <div class="trust-item"><span class="icon">✅</span> FREE Installation</div>
    <div class="trust-item"><span class="icon">🔧</span> FREE Maintenance</div>
    <div class="trust-item"><span class="icon">📦</span> FREE Restocking</div>
    <div class="trust-item"><span class="icon">🤖</span> AI-Powered</div>
    <div class="trust-item"><span class="icon">💳</span> Cashless / Contactless</div>
    <div class="trust-item"><span class="icon">📍</span> Local Las Vegas Team</div>
  </div>

  <!-- BENEFITS -->
  <section class="section section-dark">
    <div class="section-inner">
      <h2 class="section-title">${benefitsTitle}</h2>
      <p class="section-subtitle">Kande VendTech provides next-generation vending solutions powered by SandStar AI Smart Cooler technology — completely free for qualified locations.</p>
      <div class="grid grid-3">
${benefits.map(b => `        <div class="card">
          <div class="card-icon">${b.icon}</div>
          <h3>${b.title}</h3>
          <p>${b.text}</p>
        </div>`).join('\n')}
      </div>
    </div>
  </section>

  <!-- FEATURES -->
  <section class="section section-darker">
    <div class="section-inner">
      <h2 class="section-title">${featuresTitle}</h2>
      <p class="section-subtitle">${config.featuresSubtitle || 'Our SandStar AI Smart Coolers use computer vision and AI to deliver a seamless grab-and-go experience — no buttons, no waiting.'}</p>
      <div class="grid grid-2">
${features.map(f => `        <div class="card">
          <div class="card-icon">${f.icon}</div>
          <h3>${f.title}</h3>
          <p>${f.text}</p>
        </div>`).join('\n')}
      </div>
    </div>
  </section>

  <!-- CONTENT -->
  <section class="section section-dark">
    <div class="section-inner">
      <div class="content-block">
        ${mainContent}
      </div>
    </div>
  </section>

  <!-- HOW IT WORKS -->
  <section class="section section-darker">
    <div class="section-inner">
      <h2 class="section-title">${howItWorksTitle || 'How It Works'}</h2>
      <p class="section-subtitle">Getting a free vending machine from Kande VendTech is simple. We handle everything — you just enjoy the benefits.</p>
      <div class="steps">
${steps.map(s => `        <div class="step">
          <h3>${s.title}</h3>
          <p>${s.text}</p>
        </div>`).join('\n')}
      </div>
    </div>
  </section>

  <!-- SOCIAL PROOF -->
  <section class="section section-dark">
    <div class="section-inner">
      <h2 class="section-title">Trusted Across Las Vegas</h2>
      <div class="stats">
        <div class="stat"><div class="stat-number">24/7</div><div class="stat-label">Remote Monitoring</div></div>
        <div class="stat"><div class="stat-number">100%</div><div class="stat-label">Free Service</div></div>
        <div class="stat"><div class="stat-number">AI</div><div class="stat-label">Smart Technology</div></div>
        <div class="stat"><div class="stat-number">Local</div><div class="stat-label">Las Vegas Based</div></div>
      </div>
      <div class="testimonial-card">
        <div class="stars">★★★★★</div>
        <blockquote>"${socialProof}"</blockquote>
        <div class="author">— Local Las Vegas Business</div>
      </div>
    </div>
  </section>

  <!-- SERVICE AREA -->
  <section class="section section-darker">
    <div class="section-inner" style="text-align:center;">
      <h2 class="section-title">Serving the Greater Las Vegas Area</h2>
      <p class="section-subtitle">Kande VendTech proudly serves businesses and properties throughout the Las Vegas metropolitan area.</p>
      <div class="service-area">
        <span class="area-tag">Las Vegas</span>
        <span class="area-tag">Henderson</span>
        <span class="area-tag">North Las Vegas</span>
        <span class="area-tag">Summerlin</span>
        <span class="area-tag">Boulder City</span>
        <span class="area-tag">Enterprise</span>
        <span class="area-tag">Spring Valley</span>
        <span class="area-tag">Paradise</span>
      </div>
    </div>
  </section>

  <!-- CTA -->
  <section class="cta-section">
    <h2>${ctaTitle}</h2>
    <p>${ctaSubtitle}</p>
    <div class="hero-actions">
      <a href="tel:7252288822" class="btn btn-primary">📞 Call Now: 725-228-8822</a>
      <a href="mailto:kurtis@kandevendtech.com" class="btn btn-secondary">✉️ Email Us</a>
    </div>
    <div class="cta-contact">
      <a href="tel:7252288822">📞 725-228-8822</a>
      <a href="mailto:kurtis@kandevendtech.com">✉️ kurtis@kandevendtech.com</a>
    </div>
  </section>

  <!-- FOOTER -->
  <footer class="site-footer">
    <div class="footer-inner">
      <div class="footer-col">
        <h4>Kande VendTech</h4>
        <p>AI-powered smart vending machines for Las Vegas businesses and properties. Free installation, maintenance, and restocking.</p>
        <p style="margin-top:1rem;">
          📍 5725 S Valley View Blvd Suite 6<br>
          Las Vegas, NV 89118<br>
          📞 <a href="tel:7252288822">725-228-8822</a><br>
          ✉️ <a href="mailto:kurtis@kandevendtech.com">kurtis@kandevendtech.com</a>
        </p>
      </div>
      <div class="footer-col">
        <h4>Vending Machines</h4>
        <ul>
          ${productLinks}
        </ul>
      </div>
      <div class="footer-col">
        <h4>Industries We Serve</h4>
        <ul>
          ${verticalLinks}
        </ul>
      </div>
      <div class="footer-col">
        <h4>Why Kande VendTech</h4>
        <ul>
          <li>✅ 100% Free Installation</li>
          <li>🔧 Free Maintenance & Repairs</li>
          <li>📦 Free Restocking</li>
          <li>🤖 AI Smart Cooler Technology</li>
          <li>💳 Cashless & Contactless</li>
          <li>📊 24/7 Remote Monitoring</li>
          <li>📍 Locally Owned & Operated</li>
        </ul>
      </div>
    </div>
    <div class="footer-bottom">
      <p>© ${new Date().getFullYear()} Kande VendTech. All rights reserved. | AI Smart Vending Machines in Las Vegas, NV</p>
    </div>
  </footer>

</body>
</html>`;
}

// ============================
// PAGE DEFINITIONS
// ============================

const pages = [
  // 1. HOMEPAGE
  {
    filename: 'index.html',
    slug: '/',
    metaTitle: 'AI Smart Vending Machines in Las Vegas',
    metaDescription: 'Kande VendTech provides FREE AI-powered smart vending machines in Las Vegas. No cost for installation, maintenance, or restocking. SandStar AI Smart Coolers with grab-and-go technology. Call 725-228-8822.',
    h1: 'AI Smart <em>Vending Machines</em> in Las Vegas',
    heroSubtitle: 'Get a FREE AI-powered smart vending machine for your business or property. Zero cost — we handle installation, stocking, maintenance, and everything else.',
    heroCTA: 'Get a Free Vending Machine',
    heroBadge: '🤖 Las Vegas\'s #1 Smart Vending Provider',
    benefitsTitle: 'Why Choose Kande VendTech?',
    benefits: [
      { icon: '💰', title: '100% Free — No Cost to You', text: 'We install, stock, and maintain your vending machine completely free. No contracts, no hidden fees, no catch. We earn from product sales — you get the amenity.' },
      { icon: '🤖', title: 'AI-Powered Smart Coolers', text: 'Our SandStar AI Smart Coolers use computer vision to let customers grab what they want and walk away. No buttons, no selections — just grab and go.' },
      { icon: '💳', title: 'Cashless & Contactless', text: 'Accept credit cards, debit cards, Apple Pay, Google Pay, and more. Modern payment technology means more sales and happier customers.' },
      { icon: '📊', title: '24/7 Remote Monitoring', text: 'We monitor every machine in real-time. Low stock? We\'re already on the way. Technical issue? We know before you do.' },
      { icon: '🏠', title: 'Local Las Vegas Team', text: 'We\'re not a faceless corporation. Kande VendTech is locally owned and operated right here in Las Vegas. Fast response, personal service.' },
      { icon: '🔧', title: 'Full-Service Operation', text: 'Installation, stocking, maintenance, cleaning, repairs — we do it all. Your only job is to enjoy having a vending machine on your property.' },
    ],
    featuresTitle: 'SandStar AI Smart Cooler Technology',
    featuresSubtitle: 'The future of vending is here. Our AI-powered coolers deliver a revolutionary shopping experience.',
    features: [
      { icon: '👁️', title: 'Computer Vision AI', text: 'Advanced cameras identify products as customers grab them — no buttons, no scanning, no waiting in line.' },
      { icon: '🚪', title: 'Grab & Go Experience', text: 'Open the door, take what you want, close the door. Payment is automatic. It\'s that simple.' },
      { icon: '📱', title: 'Smart Inventory Tracking', text: 'Real-time inventory monitoring ensures your machine is always stocked with what people actually want.' },
      { icon: '🔒', title: 'Secure & Reliable', text: 'Enterprise-grade security, weatherproof design, and built to handle high-traffic Las Vegas environments.' },
    ],
    howItWorksTitle: 'Get Your Free Vending Machine in 3 Easy Steps',
    steps: [
      { title: 'Contact Us', text: 'Call us at 725-228-8822 or email kurtis@kandevendtech.com. Tell us about your location and we\'ll do a quick evaluation.' },
      { title: 'We Install — Free', text: 'We deliver and install your AI smart cooler at no cost. We handle all setup, electrical, and configuration.' },
      { title: 'Enjoy the Benefits', text: 'Your tenants, employees, or guests get convenient snacks and drinks. We handle all restocking and maintenance forever.' },
    ],
    socialProof: 'Kande VendTech made it incredibly easy. They showed up, installed the machine, and now our tenants love having snacks and drinks available 24/7. And we don\'t pay a dime!',
    ctaTitle: 'Ready for a Free Smart Vending Machine?',
    ctaSubtitle: 'Join Las Vegas businesses already enjoying the future of vending. Zero cost, zero hassle — just call or email.',
    mainContent: `
        <h2>Las Vegas's Premier Smart Vending Solution</h2>
        <p>Kande VendTech is revolutionizing the vending industry in Las Vegas with AI-powered smart coolers that deliver a futuristic grab-and-go experience. Whether you manage an apartment complex, hotel, office building, hospital, or school — our vending machines are the perfect amenity for your property.</p>
        
        <h2>What Makes Our Vending Machines Different?</h2>
        <p>Traditional vending machines are outdated. They jam, they only take cash, and they offer stale products. Kande VendTech's SandStar AI Smart Coolers are different:</p>
        <ul>
          <li>AI computer vision identifies products instantly — no buttons or selections needed</li>
          <li>Grab-and-go technology: open, take, close, done</li>
          <li>Accept all major credit cards, Apple Pay, Google Pay, and contactless payment</li>
          <li>Real-time inventory monitoring ensures fresh, fully-stocked machines</li>
          <li>Sleek, modern design that looks great in any setting</li>
          <li>Energy-efficient cooling technology</li>
        </ul>
        
        <h2>Products We Stock</h2>
        <p>We customize the product selection based on your location and audience. Popular categories include:</p>
        <ul>
          <li>Cold beverages: water, sodas, energy drinks, juices, iced teas</li>
          <li>Snacks: chips, protein bars, nuts, trail mix, candy</li>
          <li>Healthy options: fresh fruit cups, yogurt, salads, protein shakes</li>
          <li>Meals: sandwiches, wraps, burritos, fresh-prepared meals</li>
          <li>Coffee and hot beverages (select locations)</li>
        </ul>
        
        <h2>Locations We Serve in Las Vegas</h2>
        <p>Kande VendTech serves the entire Las Vegas metropolitan area including Las Vegas, Henderson, North Las Vegas, Summerlin, Boulder City, Enterprise, Spring Valley, and Paradise. We specialize in placing vending machines in apartment buildings, hotels, offices, hospitals, schools, gyms, and workplaces throughout the valley.</p>
    `,
    schemaDescription: 'Kande VendTech provides free AI-powered smart vending machines in Las Vegas, Henderson, and surrounding areas. SandStar AI Smart Coolers with grab-and-go technology.'
  },

  // 2. SNACK VENDING MACHINES
  {
    filename: 'snack-vending-machines.html',
    slug: '/snack-vending-machines',
    metaTitle: 'Snack Vending Machines in Las Vegas',
    metaDescription: 'FREE snack vending machines for Las Vegas businesses. AI-powered smart coolers stocked with chips, protein bars, candy, nuts, and more. No cost for installation or restocking. Call 725-228-8822.',
    h1: 'Snack <em>Vending Machines</em> in Las Vegas',
    heroSubtitle: 'Keep your team, tenants, or guests happy with a FREE AI-powered snack vending machine. Loaded with popular brands and fresh favorites — at zero cost to you.',
    heroCTA: 'Get a Free Snack Machine',
    heroBadge: '🍿 Smart Snack Vending in Las Vegas',
    benefitsTitle: 'Why Choose a Kande VendTech Snack Machine?',
    benefits: [
      { icon: '🍫', title: 'Popular Brands & Variety', text: 'From Lay\'s and Doritos to KIND bars and Clif bars — we stock the snacks people actually crave. We rotate products based on real sales data.' },
      { icon: '🤖', title: 'AI-Powered Grab & Go', text: 'No buttons, no vending jams. Customers open the door, grab their snack, and close it. Our AI handles the rest automatically.' },
      { icon: '💰', title: 'Completely Free Service', text: 'Installation, stocking, maintenance, and repairs are all on us. You never pay a penny for your snack vending machine.' },
      { icon: '📊', title: 'Data-Driven Stocking', text: 'Our AI tracks what sells best at your location and automatically adjusts the product mix. Your machine always has what people want.' },
      { icon: '🔄', title: 'Regular Restocking', text: 'We monitor inventory in real-time and restock before products run out. Your snack machine is always fully loaded.' },
      { icon: '💳', title: 'Modern Payment Options', text: 'Credit cards, debit cards, Apple Pay, Google Pay — no cash needed. Cashless means more convenience and more sales.' },
    ],
    featuresTitle: 'Snacks Available in Our Smart Coolers',
    featuresSubtitle: 'We stock a wide variety of snacks tailored to your location and audience preferences.',
    features: [
      { icon: '🥜', title: 'Chips & Salty Snacks', text: 'Lay\'s, Doritos, Cheetos, Pringles, SunChips, pretzels, popcorn, mixed nuts, and more popular salty snack brands.' },
      { icon: '💪', title: 'Protein & Energy Bars', text: 'KIND bars, Clif bars, RXBAR, Quest bars, Nature Valley — perfect for on-the-go energy and between-meal fuel.' },
      { icon: '🍬', title: 'Sweet Treats & Candy', text: 'Snickers, M&Ms, Reese\'s, Skittles, gummy bears, cookies, and other sweet favorites for that afternoon pick-me-up.' },
      { icon: '🥗', title: 'Healthy Snack Options', text: 'Trail mix, dried fruit, rice cakes, veggie chips, hummus cups, and other better-for-you snack alternatives.' },
    ],
    howItWorksTitle: 'Get Your Free Snack Machine in 3 Steps',
    steps: [
      { title: 'Contact Us', text: 'Call 725-228-8822 or email us. We\'ll discuss your snack vending needs and evaluate your location.' },
      { title: 'Free Installation', text: 'We deliver and set up your AI smart cooler at no cost. Stocked with snacks your people will love.' },
      { title: 'We Handle Everything', text: 'Regular restocking, maintenance, and cleaning — all free. You just enjoy the convenience.' },
    ],
    socialProof: 'Our employees love the new snack machine. It\'s always stocked with great options and the grab-and-go technology is so convenient. Best of all, we didn\'t pay anything for it!',
    ctaTitle: 'Get a Free Snack Vending Machine Today',
    ctaSubtitle: 'Popular snacks, AI technology, zero cost. Contact Kande VendTech for a free snack vending machine in Las Vegas.',
    mainContent: `
        <h2>Premium Snack Vending for Las Vegas</h2>
        <p>Kande VendTech's snack vending machines bring the best of AI technology to everyday snacking. Our SandStar Smart Coolers are stocked with a curated selection of chips, protein bars, candy, nuts, and healthy alternatives — all available through our revolutionary grab-and-go system.</p>
        
        <h2>Snack Options We Carry</h2>
        <p>Every location is different, and we customize the snack selection based on your audience. Here are some of the most popular items in our Las Vegas snack vending machines:</p>
        <ul>
          <li>Chips and salty snacks: Lay's, Doritos, Cheetos, Pringles, SunChips, Kettle Brand</li>
          <li>Protein and granola bars: KIND, Clif, RXBAR, Quest, Nature Valley, Perfect Bar</li>
          <li>Candy and chocolate: Snickers, M&Ms, Reese's, Twix, Kit Kat, Hershey's</li>
          <li>Nuts and trail mix: Planters, Blue Diamond, mixed nut blends, dried fruit</li>
          <li>Cookies and pastries: Oreos, Chips Ahoy, Little Debbie, Famous Amos</li>
          <li>Healthy snacks: rice cakes, veggie chips, fruit cups, hummus packs</li>
        </ul>
        
        <h2>Perfect for Any Las Vegas Location</h2>
        <p>Our snack vending machines are ideal for apartment buildings, office break rooms, hotel lobbies, hospital waiting areas, school campuses, and any high-traffic location in Las Vegas, Henderson, North Las Vegas, Summerlin, and Boulder City. Wherever people need a quick snack, Kande VendTech delivers.</p>
        
        <h2>AI-Powered Snack Vending Technology</h2>
        <p>Unlike traditional vending machines that jam, run out of stock without warning, and only accept cash, our AI smart coolers solve every common vending frustration. Computer vision technology means no mechanical arms to jam. Real-time monitoring means we know the exact inventory at all times. And cashless payment means your customers always have a way to pay.</p>
    `,
  },

  // 3. COFFEE VENDING MACHINES
  {
    filename: 'coffee-vending-machines.html',
    slug: '/coffee-vending-machines',
    metaTitle: 'Coffee Vending Machines in Las Vegas',
    metaDescription: 'FREE coffee and hot beverage vending machines in Las Vegas. AI-powered smart coolers with premium coffee, tea, and hot chocolate. Zero cost installation. Call Kande VendTech at 725-228-8822.',
    h1: 'Coffee <em>Vending Machines</em> in Las Vegas',
    heroSubtitle: 'Give your people access to premium coffee and hot beverages with a FREE AI-powered vending solution. Quality coffee — no barista needed.',
    heroCTA: 'Get a Free Coffee Machine',
    heroBadge: '☕ Smart Coffee & Beverage Vending',
    benefitsTitle: 'Why a Kande VendTech Coffee Vending Machine?',
    benefits: [
      { icon: '☕', title: 'Premium Coffee Selection', text: 'From bold espresso-style brews to smooth iced coffees, we offer quality coffee beverages that rival your local coffee shop.' },
      { icon: '🫖', title: 'Hot & Cold Options', text: 'Hot coffee, iced coffee, tea, hot chocolate, and more. We stock beverages for every preference and every season.' },
      { icon: '💰', title: 'Save vs. Coffee Shops', text: 'Give your people affordable coffee on-site instead of spending $5-7 at a coffee shop. Convenience plus savings.' },
      { icon: '🤖', title: 'AI Smart Technology', text: 'Grab your coffee and go. Our computer vision technology handles everything — no fumbling with buttons or selections.' },
      { icon: '🔄', title: 'Always Fresh & Stocked', text: 'Real-time monitoring means we restock before you run out. Fresh beverages available around the clock.' },
      { icon: '💳', title: 'Tap & Go Payment', text: 'Apple Pay, Google Pay, credit cards, debit cards — quick and contactless. Perfect for the morning rush.' },
    ],
    featuresTitle: 'Coffee & Beverage Options',
    featuresSubtitle: 'Our smart coolers offer a variety of coffee and beverage options to keep everyone energized.',
    features: [
      { icon: '☕', title: 'Bottled & Canned Coffee', text: 'Starbucks Frappuccino, Monster Java, Dunkin\' bottled iced coffee, La Colombe draft lattes, and other popular ready-to-drink coffees.' },
      { icon: '🧊', title: 'Iced & Cold Brew', text: 'Premium cold brew, iced lattes, and chilled coffee beverages — perfect for the Las Vegas heat.' },
      { icon: '🫖', title: 'Tea & Hot Beverages', text: 'Bottled teas, iced green tea, chai lattes, and hot chocolate options for non-coffee drinkers.' },
      { icon: '⚡', title: 'Energy Coffee Drinks', text: 'Coffee-energy hybrids like Monster Java, Bang Coffee, and Starbucks Doubleshot for maximum caffeine.' },
    ],
    howItWorksTitle: 'Get Free Coffee Vending in 3 Steps',
    steps: [
      { title: 'Contact Us', text: 'Call 725-228-8822 or email kurtis@kandevendtech.com to discuss coffee vending for your location.' },
      { title: 'We Set Up Everything', text: 'Free delivery, installation, and initial stocking of your coffee vending machine. Ready to serve in days.' },
      { title: 'Caffeine on Demand', text: 'Your people get convenient, affordable coffee anytime. We handle restocking and maintenance forever.' },
    ],
    socialProof: 'Having a coffee vending machine in our office was a game-changer. The team loves grabbing an iced coffee on break, and Kande VendTech keeps it stocked perfectly.',
    ctaTitle: 'Get Free Coffee Vending for Your Location',
    ctaSubtitle: 'Premium coffee, zero cost, AI technology. Let Kande VendTech power your coffee vending in Las Vegas.',
    mainContent: `
        <h2>Premium Coffee Vending in Las Vegas</h2>
        <p>Coffee is the fuel that keeps Las Vegas running. Whether it's an early morning shift, a long work day, or a late-night study session — your people need access to quality coffee. Kande VendTech's coffee vending machines deliver premium beverages through our AI-powered smart cooler technology, completely free of charge.</p>
        
        <h2>Coffee Brands & Products We Stock</h2>
        <p>We carry the coffee brands and beverages your people already know and love:</p>
        <ul>
          <li>Starbucks Frappuccino and bottled iced coffees</li>
          <li>Dunkin' bottled coffee and iced lattes</li>
          <li>La Colombe draft lattes and cold brew</li>
          <li>Monster Java coffee-energy drinks</li>
          <li>Bang coffee-infused energy drinks</li>
          <li>Arizona iced tea and green tea</li>
          <li>Honest Tea, Pure Leaf, and premium teas</li>
          <li>Hot chocolate and specialty beverages</li>
        </ul>
        
        <h2>Why On-Site Coffee Vending Matters</h2>
        <p>A convenient coffee machine isn't just a perk — it's a productivity tool. Studies show that easy access to coffee reduces break times, improves morale, and keeps people energized. In a city like Las Vegas where temperatures soar, having cold coffee beverages on-site is especially valuable.</p>
        
        <h2>Ideal Locations for Coffee Vending in Las Vegas</h2>
        <p>Our coffee vending machines thrive in offices, apartment building common areas, hotel lobbies, hospital break rooms, university campuses, and co-working spaces throughout Las Vegas, Henderson, North Las Vegas, Summerlin, and the surrounding areas.</p>
    `,
  },

  // 4. COMBO VENDING MACHINES
  {
    filename: 'combo-vending-machines.html',
    slug: '/combo-vending-machines',
    metaTitle: 'Combo Vending Machines in Las Vegas',
    metaDescription: 'FREE combo vending machines in Las Vegas with snacks AND drinks in one machine. AI-powered smart coolers from Kande VendTech. Zero cost installation and maintenance. Call 725-228-8822.',
    h1: 'Combo <em>Vending Machines</em> in Las Vegas',
    heroSubtitle: 'Snacks and drinks in one sleek machine. Get a FREE AI-powered combo vending machine that gives your people everything they need in a single unit.',
    heroCTA: 'Get a Free Combo Machine',
    heroBadge: '🥤🍿 Snacks + Drinks in One Machine',
    benefitsTitle: 'Why Choose a Combo Vending Machine?',
    benefits: [
      { icon: '🎯', title: 'Everything in One Machine', text: 'Snacks and beverages together means you need less space but offer more variety. One machine, maximum convenience.' },
      { icon: '📐', title: 'Space-Efficient Design', text: 'Don\'t have room for two machines? Our combo smart coolers fit snacks and drinks in one compact footprint.' },
      { icon: '🤖', title: 'AI Grab & Go', text: 'No buttons, no selections. Open, grab your snack and drink, close the door. Our AI handles billing automatically.' },
      { icon: '💰', title: 'Completely Free', text: 'Zero cost for installation, stocking, maintenance, and repairs. We handle everything — you provide the space.' },
      { icon: '📊', title: 'Smart Product Mix', text: 'Our AI tracks sales data to optimize the perfect balance of snacks and drinks for your specific location.' },
      { icon: '🔧', title: 'Zero Maintenance', text: 'We handle all restocking, cleaning, and maintenance. Your combo machine is always running and always stocked.' },
    ],
    featuresTitle: 'What\'s Inside Our Combo Machines',
    featuresSubtitle: 'The best of both worlds — popular snacks paired with refreshing beverages in one smart cooler.',
    features: [
      { icon: '🍿', title: 'Snack Selection', text: 'Chips, protein bars, candy, nuts, cookies, and healthy options — all the snack favorites in one convenient place.' },
      { icon: '🥤', title: 'Beverage Selection', text: 'Water, sodas, energy drinks, juices, iced teas, coffee drinks — ice cold and ready to grab.' },
      { icon: '🔄', title: 'Rotating Products', text: 'We analyze sales data and rotate products to keep things fresh and ensure top sellers are always available.' },
      { icon: '🧊', title: 'Temperature Controlled', text: 'Dual-zone cooling keeps drinks perfectly chilled and snacks fresh in our climate-controlled smart cooler.' },
    ],
    howItWorksTitle: 'Get Your Free Combo Machine in 3 Steps',
    steps: [
      { title: 'Tell Us About Your Space', text: 'Call 725-228-8822 or email us with your location details. We\'ll recommend the perfect combo setup.' },
      { title: 'Free Install & Stocking', text: 'We deliver, install, and stock your combo machine at absolutely no cost. Ready to serve in days.' },
      { title: 'Sit Back & Enjoy', text: 'Your people get snacks and drinks anytime. We handle restocking, maintenance, and everything else.' },
    ],
    socialProof: 'The combo machine from Kande VendTech was perfect for our break room. We didn\'t have space for two machines, and this one has everything our team needs. Installation was free and they keep it stocked perfectly.',
    ctaTitle: 'Get a Free Combo Vending Machine',
    ctaSubtitle: 'Snacks and drinks, one machine, zero cost. Contact Kande VendTech for a combo vending machine in Las Vegas.',
    mainContent: `
        <h2>The Best of Both Worlds: Combo Vending in Las Vegas</h2>
        <p>Why choose between a snack machine and a drink machine when you can have both? Kande VendTech's combo vending machines pack a full selection of snacks and cold beverages into one AI-powered smart cooler. Perfect for locations where space is at a premium but variety is still important.</p>
        
        <h2>Combo Machine Product Selection</h2>
        <p>Our combo machines are stocked with the best-selling snacks and beverages, customized for your location:</p>
        <ul>
          <li>Cold drinks: bottled water, Coca-Cola, Pepsi, energy drinks, juices, iced tea</li>
          <li>Chips and salty snacks: Lay's, Doritos, Cheetos, pretzels, popcorn</li>
          <li>Protein bars and granola: KIND, Clif, Nature Valley, Quest</li>
          <li>Sweet snacks: candy bars, cookies, chocolate, gummies</li>
          <li>Coffee drinks: Starbucks Frappuccino, cold brew, energy coffee</li>
          <li>Healthy options: trail mix, dried fruit, rice cakes, veggie chips</li>
        </ul>
        
        <h2>Space-Saving Smart Vending</h2>
        <p>Traditional combo vending machines are bulky and unreliable. Our SandStar AI Smart Coolers combine a sleek, modern design with innovative grab-and-go technology. The compact footprint makes them ideal for smaller break rooms, apartment lobbies, hotel hallways, and other spaces where a traditional double-machine setup won't fit.</p>
        
        <h2>Where Combo Machines Work Best</h2>
        <p>Combo vending machines are especially popular in apartment building common areas, small to mid-size offices, hotel guest areas, hospital waiting rooms, and anywhere you need maximum variety in minimal space. We serve locations throughout Las Vegas, Henderson, North Las Vegas, Summerlin, and Boulder City.</p>
    `,
  },

  // 5. DRINK VENDING MACHINES
  {
    filename: 'drink-vending-machines.html',
    slug: '/drink-vending-machines',
    metaTitle: 'Drink Vending Machines in Las Vegas',
    metaDescription: 'FREE drink vending machines for Las Vegas businesses. AI-powered smart coolers with ice-cold water, soda, energy drinks, juices & more. Zero cost installation. Call Kande VendTech at 725-228-8822.',
    h1: 'Drink <em>Vending Machines</em> in Las Vegas',
    heroSubtitle: 'Ice-cold beverages at the push of... nothing. Our AI smart coolers let you grab your drink and go. Completely free for qualified locations.',
    heroCTA: 'Get a Free Drink Machine',
    heroBadge: '🥤 Smart Beverage Vending in Las Vegas',
    benefitsTitle: 'Why Kande VendTech Drink Vending?',
    benefits: [
      { icon: '🧊', title: 'Always Ice Cold', text: 'In the Las Vegas heat, cold drinks aren\'t a luxury — they\'re a necessity. Our smart coolers keep every beverage perfectly chilled.' },
      { icon: '🥤', title: 'Every Drink They Want', text: 'Water, sodas, energy drinks, juices, teas, sports drinks, coffee — we stock what your people actually drink.' },
      { icon: '🤖', title: 'AI Grab & Go', text: 'Open the door, grab your drink, close it. Our AI identifies what you took and charges automatically. No buttons needed.' },
      { icon: '💰', title: '100% Free', text: 'We install, stock, and maintain your drink machine at zero cost. You provide the space, we provide everything else.' },
      { icon: '📈', title: 'Data-Optimized Selection', text: 'Our system tracks what sells and adjusts inventory. Popular drinks are always available, slow sellers get swapped out.' },
      { icon: '⚡', title: 'Fast & Convenient', text: 'No waiting, no lines. Grab-and-go technology means getting a drink takes seconds, not minutes.' },
    ],
    featuresTitle: 'Beverages in Our Smart Coolers',
    featuresSubtitle: 'A full selection of cold beverages to keep everyone hydrated and energized in the Las Vegas heat.',
    features: [
      { icon: '💧', title: 'Water & Enhanced Water', text: 'Dasani, Aquafina, SmartWater, CORE, Fiji, electrolyte water, and flavored water options for staying hydrated.' },
      { icon: '🥫', title: 'Sodas & Sparkling', text: 'Coca-Cola, Pepsi, Dr Pepper, Mountain Dew, Sprite, sparkling water, and other carbonated favorites.' },
      { icon: '⚡', title: 'Energy & Sports Drinks', text: 'Red Bull, Monster, Celsius, Gatorade, Powerade, Body Armor — fuel for active lifestyles.' },
      { icon: '🧃', title: 'Juices & Tea', text: 'Orange juice, apple juice, Naked smoothies, Arizona tea, Pure Leaf, and other refreshing beverages.' },
    ],
    howItWorksTitle: 'Get Free Drink Vending in 3 Steps',
    steps: [
      { title: 'Reach Out', text: 'Call 725-228-8822 or email kurtis@kandevendtech.com. Tell us about your location and beverage needs.' },
      { title: 'We Install Free', text: 'We deliver and install your drink vending machine at no cost, stocked with ice-cold beverages from day one.' },
      { title: 'Stay Hydrated', text: 'Your people enjoy cold drinks 24/7. We handle all restocking, maintenance, and cleaning forever.' },
    ],
    socialProof: 'In the Las Vegas summer, having ice-cold drinks available in our lobby is a lifesaver. Kande VendTech\'s machine is always stocked and the grab-and-go technology is incredibly smooth.',
    ctaTitle: 'Get a Free Drink Vending Machine',
    ctaSubtitle: 'Ice-cold beverages, AI technology, zero cost. Contact Kande VendTech for drink vending in Las Vegas.',
    mainContent: `
        <h2>Stay Hydrated in Las Vegas with Smart Drink Vending</h2>
        <p>Las Vegas temperatures regularly exceed 100°F. Having cold beverages readily available isn't just convenient — it's essential. Kande VendTech's AI-powered drink vending machines deliver ice-cold beverages through revolutionary grab-and-go technology, keeping your people hydrated and happy.</p>
        
        <h2>Full Beverage Selection</h2>
        <p>Our drink vending machines are stocked with the brands and beverages Las Vegas demands:</p>
        <ul>
          <li>Water: Dasani, Aquafina, SmartWater, CORE, Fiji, electrolyte water</li>
          <li>Sodas: Coca-Cola, Pepsi, Dr Pepper, Mountain Dew, Sprite, root beer</li>
          <li>Energy drinks: Red Bull, Monster, Celsius, Bang, Reign</li>
          <li>Sports drinks: Gatorade, Powerade, Body Armor, Liquid IV</li>
          <li>Juices: Tropicana, Minute Maid, Naked, V8, Welch's</li>
          <li>Iced tea: Arizona, Pure Leaf, Gold Peak, Honest Tea</li>
          <li>Coffee drinks: Starbucks, Dunkin', La Colombe, Monster Java</li>
        </ul>
        
        <h2>Why Beverage Vending Matters in Las Vegas</h2>
        <p>In the desert climate, dehydration is a real concern. Providing easy access to cold beverages shows you care about the people in your building. Whether it's apartment residents coming in from the heat, office workers needing an afternoon pick-me-up, or hotel guests looking for a cold drink — a Kande VendTech beverage machine is the answer.</p>
        
        <h2>Drink Vending for Every Las Vegas Location</h2>
        <p>Our drink machines are popular in apartment communities, office buildings, hotels, hospitals, schools, recreation centers, and more throughout Las Vegas, Henderson, North Las Vegas, Summerlin, and Boulder City.</p>
    `,
  },

  // 6. HEALTHY VENDING MACHINES
  {
    filename: 'healthy-vending-machines.html',
    slug: '/healthy-vending-machines',
    metaTitle: 'Healthy Vending Machines in Las Vegas',
    metaDescription: 'FREE healthy vending machines in Las Vegas. AI smart coolers stocked with fresh salads, protein bars, fruit cups, yogurt & nutritious snacks. Zero cost. Call Kande VendTech at 725-228-8822.',
    h1: 'Healthy <em>Vending Machines</em> in Las Vegas',
    heroSubtitle: 'Fresh, nutritious snacks and beverages in an AI-powered smart cooler. Give your people healthy options — completely free for your location.',
    heroCTA: 'Get a Free Healthy Machine',
    heroBadge: '🥗 Healthy Smart Vending in Las Vegas',
    benefitsTitle: 'Why Healthy Vending from Kande VendTech?',
    benefits: [
      { icon: '🥗', title: 'Fresh & Nutritious Options', text: 'Salads, fruit cups, protein bars, yogurt, hummus packs, and other genuinely healthy choices — not just "less bad" vending food.' },
      { icon: '🏃', title: 'Wellness-Focused', text: 'Support your community\'s health goals with vending options that include calorie counts, protein content, and clean ingredients.' },
      { icon: '🤖', title: 'AI Freshness Monitoring', text: 'Our smart coolers track expiration dates and freshness. Every product is guaranteed fresh — we replace items before they expire.' },
      { icon: '💰', title: 'Zero Cost to You', text: 'Free installation, free healthy products, free maintenance. A wellness amenity that doesn\'t touch your budget.' },
      { icon: '🌱', title: 'Dietary-Friendly Options', text: 'Gluten-free, vegan, keto, organic, and allergen-conscious options available based on your community\'s needs.' },
      { icon: '📊', title: 'Customized Health Menu', text: 'We tailor the healthy product selection to your specific audience — gym-goers, office workers, students, or residents.' },
    ],
    featuresTitle: 'Healthy Products in Our Smart Coolers',
    featuresSubtitle: 'Real nutrition, not vending machine compromises. Fresh, healthy options powered by AI technology.',
    features: [
      { icon: '🥬', title: 'Fresh Salads & Wraps', text: 'Pre-made salads, chicken wraps, veggie wraps, and other fresh meal options prepared daily and delivered to your machine.' },
      { icon: '🍎', title: 'Fruit & Yogurt', text: 'Fresh fruit cups, apple slices, banana chips, Greek yogurt, parfaits, and other naturally nutritious snacks.' },
      { icon: '💪', title: 'Protein-Rich Options', text: 'RXBAR, Perfect Bar, protein shakes, jerky, hard-boiled eggs, cheese sticks, and high-protein snacks.' },
      { icon: '🧃', title: 'Healthy Beverages', text: 'Coconut water, kombucha, green juice, protein smoothies, low-sugar options, and enhanced water.' },
    ],
    howItWorksTitle: 'Get Free Healthy Vending in 3 Steps',
    steps: [
      { title: 'Tell Us Your Needs', text: 'Call 725-228-8822 or email us. We\'ll discuss healthy vending options tailored to your community.' },
      { title: 'Free Setup & Stocking', text: 'We install your healthy vending machine and stock it with fresh, nutritious products — all at no cost.' },
      { title: 'Healthy Made Easy', text: 'Fresh products, regular restocking, and AI freshness monitoring. We ensure every item is always fresh.' },
    ],
    socialProof: 'We switched to Kande VendTech\'s healthy vending machine and our employees love it. Real salads, fresh fruit, protein bars — not the junk you find in old vending machines. And it\'s completely free!',
    ctaTitle: 'Get a Free Healthy Vending Machine',
    ctaSubtitle: 'Fresh, nutritious options powered by AI. Zero cost for your Las Vegas location. Contact Kande VendTech today.',
    mainContent: `
        <h2>The Healthy Vending Revolution in Las Vegas</h2>
        <p>People want healthier options, and old-fashioned vending machines full of candy and chips don't cut it anymore. Kande VendTech's healthy vending machines stock genuinely nutritious food — fresh salads, fruit cups, protein bars, yogurt, and other wholesome choices — all delivered through AI-powered grab-and-go technology.</p>
        
        <h2>Healthy Products We Stock</h2>
        <p>Our healthy vending machines go beyond "reduced fat" chips. We offer real, nutritious food:</p>
        <ul>
          <li>Fresh salads, chicken wraps, and veggie wraps</li>
          <li>Fruit cups, apple slices, and mixed berry packs</li>
          <li>Greek yogurt, cottage cheese, and string cheese</li>
          <li>Protein bars: RXBAR, Perfect Bar, KIND, Clif</li>
          <li>Nuts, trail mix, and dried fruit without added sugar</li>
          <li>Hummus with veggie sticks and whole grain crackers</li>
          <li>Hard-boiled eggs and protein packs</li>
          <li>Kombucha, coconut water, green juice, and protein smoothies</li>
        </ul>
        
        <h2>AI-Powered Freshness Guarantee</h2>
        <p>The biggest challenge with healthy vending is freshness. Our SandStar AI technology solves this by tracking every product's freshness in real-time. We know exactly when items were stocked, monitor temperature continuously, and replace products well before they expire. Your healthy vending machine always has genuinely fresh food.</p>
        
        <h2>Perfect for Health-Conscious Communities</h2>
        <p>Our healthy vending machines are especially popular in medical offices, corporate wellness programs, fitness-adjacent locations, apartment buildings with health-conscious residents, schools, and university campuses throughout Las Vegas, Henderson, and the surrounding area.</p>
    `,
  },

  // 7. MEAL VENDING MACHINES
  {
    filename: 'meal-vending-machines.html',
    slug: '/meal-vending-machines',
    metaTitle: 'Meal Vending Machines in Las Vegas',
    metaDescription: 'FREE meal vending machines in Las Vegas. AI smart coolers with fresh sandwiches, wraps, burritos, salads & prepared meals. Zero cost installation. Call Kande VendTech at 725-228-8822.',
    h1: 'Meal <em>Vending Machines</em> in Las Vegas',
    heroSubtitle: 'Fresh, prepared meals available 24/7 through AI smart cooler technology. Give your people real food options — not just snacks. Completely free.',
    heroCTA: 'Get a Free Meal Machine',
    heroBadge: '🍱 Fresh Meal Vending in Las Vegas',
    benefitsTitle: 'Why Meal Vending from Kande VendTech?',
    benefits: [
      { icon: '🥪', title: 'Real Meals, Not Just Snacks', text: 'Fresh sandwiches, wraps, burritos, salads, and prepared meals that are actually satisfying. Not a bag of chips pretending to be lunch.' },
      { icon: '🕐', title: '24/7 Meal Access', text: 'Night shifts, early mornings, weekends — your people can grab a real meal anytime, even when restaurants are closed.' },
      { icon: '🤖', title: 'AI Freshness Technology', text: 'Our smart coolers monitor freshness in real-time. Every meal is temperature-controlled and guaranteed fresh.' },
      { icon: '💰', title: 'Affordable & Free to Host', text: 'Meals at vending prices, far cheaper than takeout or delivery. And the machine itself costs you absolutely nothing.' },
      { icon: '🔄', title: 'Daily Fresh Deliveries', text: 'We restock meals frequently to ensure freshness. Popular items are replenished daily in high-traffic locations.' },
      { icon: '🌮', title: 'Variety & Customization', text: 'We customize the meal selection for your audience. Want more vegetarian options? More protein? We adapt.' },
    ],
    featuresTitle: 'Meals Available in Our Smart Coolers',
    featuresSubtitle: 'Fresh, prepared meals that satisfy real hunger — available through grab-and-go AI technology.',
    features: [
      { icon: '🥪', title: 'Sandwiches & Subs', text: 'Turkey, ham, chicken salad, BLT, club, and specialty sandwiches made fresh and delivered to your machine.' },
      { icon: '🌯', title: 'Wraps & Burritos', text: 'Chicken Caesar wraps, veggie wraps, breakfast burritos, and bean burritos for a quick, filling meal.' },
      { icon: '🥗', title: 'Salads & Bowls', text: 'Garden salads, Caesar salads, grain bowls, and protein-packed salad bowls with fresh dressings.' },
      { icon: '🍱', title: 'Prepared Meals', text: 'Pasta dishes, rice bowls, meal prep containers, and other complete meals ready to eat or microwave.' },
    ],
    howItWorksTitle: 'Get Free Meal Vending in 3 Steps',
    steps: [
      { title: 'Contact Us', text: 'Call 725-228-8822 or email kurtis@kandevendtech.com about meal vending for your location.' },
      { title: 'Free Installation', text: 'We install your meal vending smart cooler and stock it with fresh meals — all at no cost to you.' },
      { title: 'Fresh Meals Daily', text: 'We deliver fresh meals regularly and monitor freshness 24/7. Your people always have real food options.' },
    ],
    socialProof: 'Our night shift workers used to survive on fast food or nothing. Now they have fresh sandwiches and wraps available at 2am. The meal vending machine from Kande VendTech has been a huge quality-of-life improvement.',
    ctaTitle: 'Get a Free Meal Vending Machine',
    ctaSubtitle: 'Fresh meals, 24/7 access, zero cost. Contact Kande VendTech for meal vending in Las Vegas.',
    mainContent: `
        <h2>Fresh Meal Vending for Las Vegas</h2>
        <p>Sometimes a snack isn't enough. Your people need real meals — and they need them available at all hours. Kande VendTech's meal vending machines stock fresh, prepared meals including sandwiches, wraps, burritos, salads, and complete meal bowls, all available through our AI-powered grab-and-go technology.</p>
        
        <h2>Meal Options We Provide</h2>
        <p>Our meal vending machines go beyond basic sandwiches. We stock a rotating selection of freshly prepared meals:</p>
        <ul>
          <li>Deli sandwiches: turkey, ham, roast beef, chicken salad, BLT</li>
          <li>Wraps: chicken Caesar, buffalo chicken, veggie, Southwest</li>
          <li>Burritos: breakfast burritos, chicken, bean and rice</li>
          <li>Fresh salads: garden, Caesar, Cobb, Greek, with dressing</li>
          <li>Grain and protein bowls: rice bowls, quinoa bowls, pasta</li>
          <li>Snack plates: cheese and crackers, veggie and dip, protein packs</li>
          <li>Breakfast items: yogurt parfaits, overnight oats, fruit and granola</li>
        </ul>
        
        <h2>The 24/7 Advantage</h2>
        <p>Las Vegas is a 24-hour city, and many businesses operate around the clock. Hospitals, hotels, apartment buildings, and late-night workplaces all need food options at hours when restaurants are closed and delivery isn't available. A meal vending machine ensures your people can eat a real meal anytime.</p>
        
        <h2>Freshness You Can Trust</h2>
        <p>The #1 concern with meal vending is freshness. Our SandStar AI Smart Coolers address this with continuous temperature monitoring, real-time expiration tracking, and frequent restocking schedules. Every meal in our machines is guaranteed fresh and safe to eat. We pull and replace items well before expiration.</p>
    `,
  },

  // 8. APARTMENT BUILDING VENDING MACHINES
  {
    filename: 'apartment-building-vending-machines.html',
    slug: '/apartment-building-vending-machines',
    metaTitle: 'Apartment Building Vending Machines in Las Vegas',
    metaDescription: 'FREE vending machines for Las Vegas apartment buildings. AI smart coolers for lobbies, common areas & resident amenities. Zero cost installation & maintenance. Call Kande VendTech at 725-228-8822.',
    h1: 'Apartment Building <em>Vending Machines</em> in Las Vegas',
    heroSubtitle: 'Add a premium amenity to your apartment complex at zero cost. Residents love 24/7 access to snacks, drinks, and meals — and you never pay a dime.',
    heroCTA: 'Get a Free Machine for Your Complex',
    heroBadge: '🏢 Smart Vending for Apartment Communities',
    benefitsTitle: 'Why Apartment Managers Choose Kande VendTech',
    benefits: [
      { icon: '🏠', title: 'Premium Resident Amenity', text: 'A vending machine in the lobby or common area adds real value. Residents love the convenience — and it helps attract new tenants.' },
      { icon: '💰', title: 'Zero Cost to Property', text: 'We install, stock, maintain, and repair the machine completely free. It\'s a premium amenity that costs your property nothing.' },
      { icon: '🌙', title: '24/7 Convenience', text: 'Late-night snack cravings, early morning coffee runs, lazy Sunday afternoons — residents can grab what they need anytime.' },
      { icon: '🤖', title: 'Modern & Sleek Design', text: 'Our AI smart coolers look great in any lobby or common area. Modern design that matches your property\'s aesthetic.' },
      { icon: '📈', title: 'Boost Resident Satisfaction', text: 'In a competitive rental market, amenities matter. A smart vending machine is a differentiator that helps retention and leasing.' },
      { icon: '🔒', title: 'Secure & Reliable', text: 'Built for 24/7 access with secure payment processing. No vandalism issues — the sleek design discourages tampering.' },
    ],
    featuresTitle: 'Perfect for Apartment Common Areas',
    featuresSubtitle: 'Designed to enhance resident life in Las Vegas apartment communities.',
    features: [
      { icon: '🏢', title: 'Lobby & Entrance Placement', text: 'Perfect for main lobbies, mail rooms, near elevators, or clubhouse areas where residents naturally gather.' },
      { icon: '🏊', title: 'Pool & Recreation Areas', text: 'Ideal near pools, fitness centers, BBQ areas, and outdoor common spaces where residents want cold drinks and snacks.' },
      { icon: '🧺', title: 'Laundry Room Convenience', text: 'Place a machine near the laundry area where residents are waiting and would love a snack or drink.' },
      { icon: '🅿️', title: 'Parking & Entry Points', text: 'Near parking garages or building entries where residents can grab something on their way in or out.' },
    ],
    howItWorksTitle: 'Add a Vending Machine to Your Apartments in 3 Steps',
    steps: [
      { title: 'Contact Us', text: 'Call 725-228-8822 or email kurtis@kandevendtech.com. Tell us about your property and we\'ll schedule a free site evaluation.' },
      { title: 'Free Installation', text: 'We deliver, install, and stock your AI smart cooler. We work around your schedule and handle all setup.' },
      { title: 'Residents Enjoy', text: 'Your residents get 24/7 access to snacks, drinks, and meals. We handle everything — restocking, maintenance, all of it.' },
    ],
    socialProof: 'We added a Kande VendTech machine to our apartment lobby and residents love it. It\'s always stocked, looks great, and didn\'t cost us a penny. It even helped us close a few leases — new tenants were impressed by the tech.',
    ctaTitle: 'Add a Free Vending Machine to Your Property',
    ctaSubtitle: 'Premium amenity, zero cost. Boost resident satisfaction at your Las Vegas apartment community.',
    mainContent: `
        <h2>Smart Vending for Las Vegas Apartment Communities</h2>
        <p>In Las Vegas's competitive rental market, amenities can make or break a lease decision. Kande VendTech's AI-powered smart coolers are the perfect addition to your apartment building — a premium, modern amenity that costs your property absolutely nothing. Residents get 24/7 access to snacks, cold drinks, and fresh meals right in their building.</p>
        
        <h2>Why Apartment Buildings Need Smart Vending</h2>
        <p>Today's renters expect more than basic amenities. Here's why a Kande VendTech machine is a smart addition to your property:</p>
        <ul>
          <li>Resident satisfaction: Convenience is king. 24/7 snack and drink access in the building</li>
          <li>Leasing advantage: Modern amenities help attract quality tenants in a competitive market</li>
          <li>Zero property cost: We pay for installation, products, maintenance, and repairs</li>
          <li>No management burden: We handle everything — your team doesn't lift a finger</li>
          <li>Modern aesthetic: Sleek AI smart coolers enhance your common areas, not clutter them</li>
          <li>Resident retention: Happy residents renew leases. Convenience features reduce turnover</li>
        </ul>
        
        <h2>Best Locations in Your Apartment Complex</h2>
        <p>We've placed vending machines in apartment communities across Las Vegas and know what works best. The most popular and highest-traffic placements include:</p>
        <ul>
          <li>Main lobby or entrance foyer</li>
          <li>Near the mailbox and package room area</li>
          <li>Clubhouse or community room</li>
          <li>Adjacent to the fitness center or pool area</li>
          <li>Near the laundry room or facility</li>
          <li>Ground-floor hallways in high-rise buildings</li>
        </ul>
        
        <h2>Apartment Communities We Serve</h2>
        <p>Kande VendTech serves apartment buildings, condominiums, and multi-family communities throughout Las Vegas, Henderson, North Las Vegas, Summerlin, and Boulder City. Whether you manage a 20-unit garden-style complex or a 500-unit high-rise, we have a smart vending solution for your property.</p>
    `,
  },

  // 9. GYM VENDING MACHINES
  {
    filename: 'gym-vending-machines.html',
    slug: '/gym-vending-machines',
    metaTitle: 'Gym Vending Machines in Las Vegas',
    metaDescription: 'FREE gym vending machines in Las Vegas. AI smart coolers with protein shakes, energy drinks, healthy snacks & recovery drinks for fitness centers. Call Kande VendTech at 725-228-8822.',
    h1: 'Gym <em>Vending Machines</em> in Las Vegas',
    heroSubtitle: 'Fuel your members\' workouts with protein shakes, energy drinks, and healthy snacks. FREE AI-powered vending machines built for fitness environments.',
    heroCTA: 'Get a Free Gym Machine',
    heroBadge: '💪 Smart Vending for Fitness Centers',
    benefitsTitle: 'Why Gyms & Fitness Centers Choose Kande VendTech',
    benefits: [
      { icon: '💪', title: 'Fitness-Focused Products', text: 'Protein shakes, BCAAs, pre-workout drinks, recovery beverages, protein bars, and healthy snacks your members actually want.' },
      { icon: '💰', title: 'Add Revenue or Amenity', text: 'Offer your members convenient post-workout nutrition at no cost to your gym. It\'s a premium amenity or potential revenue share.' },
      { icon: '🤖', title: 'Grab & Go Speed', text: 'Members don\'t want to wait after a workout. Our AI technology means they grab their protein shake and go in seconds.' },
      { icon: '🧊', title: 'Always Cold & Ready', text: 'Cold protein shakes and drinks ready immediately after a workout. No blender needed, no waiting.' },
      { icon: '📊', title: 'Data-Driven Product Mix', text: 'We analyze what your members buy and optimize the selection. The right products for your specific gym community.' },
      { icon: '🔧', title: 'Full-Service Management', text: 'We handle restocking, cleaning, maintenance, and repairs. Your staff can focus on training, not vending logistics.' },
    ],
    featuresTitle: 'Gym-Ready Products in Our Smart Coolers',
    featuresSubtitle: 'Post-workout nutrition and hydration designed for fitness enthusiasts.',
    features: [
      { icon: '🥤', title: 'Protein Shakes & Drinks', text: 'Premier Protein, Muscle Milk, Core Power, Orgain, Fairlife — ready-to-drink protein your members crave after a workout.' },
      { icon: '⚡', title: 'Pre & Post Workout', text: 'Energy drinks, BCAAs, electrolyte drinks, and recovery beverages to support the full workout cycle.' },
      { icon: '🏋️', title: 'Protein Bars & Snacks', text: 'Quest, RXBAR, Perfect Bar, jerky, nuts, and high-protein snacks for on-the-go muscle fuel.' },
      { icon: '💧', title: 'Hydration & Recovery', text: 'Electrolyte water, coconut water, Body Armor, Liquid IV — critical hydration for Las Vegas gym-goers.' },
    ],
    howItWorksTitle: 'Get a Free Gym Vending Machine in 3 Steps',
    steps: [
      { title: 'Contact Us', text: 'Call 725-228-8822 or email us about adding smart vending to your gym or fitness center.' },
      { title: 'Free Setup', text: 'We install and stock your gym\'s AI smart cooler with fitness-focused products at zero cost.' },
      { title: 'Members Love It', text: 'Members grab protein shakes, energy drinks, and healthy snacks. We keep it stocked and maintained.' },
    ],
    socialProof: 'Our members love having protein shakes ready to grab after their workout. The Kande VendTech machine is always stocked with exactly what fitness people want. Installation was free and they handle everything.',
    ctaTitle: 'Get a Free Vending Machine for Your Gym',
    ctaSubtitle: 'Protein shakes, energy drinks, healthy snacks — all free to set up. Contact Kande VendTech.',
    mainContent: `
        <h2>Smart Vending Built for Fitness Centers</h2>
        <p>Your gym members are serious about their nutrition. Post-workout protein, pre-workout energy, and proper hydration are non-negotiable. Kande VendTech's AI-powered smart coolers deliver exactly what fitness enthusiasts need — right in your gym, ready to grab after every workout.</p>
        
        <h2>Products Your Members Actually Want</h2>
        <p>We stock gym vending machines based on what fitness communities actually purchase — not generic vending selections:</p>
        <ul>
          <li>Ready-to-drink protein: Premier Protein, Muscle Milk, Core Power, Fairlife</li>
          <li>Protein bars: Quest, RXBAR, Perfect Bar, ONE Bar, Think!</li>
          <li>Energy and pre-workout: Celsius, C4, Ghost, Alani Nu, Red Bull</li>
          <li>Recovery drinks: Body Armor, Pedialyte Sport, coconut water</li>
          <li>Electrolyte water: SmartWater, CORE, Essentia, Liquid IV</li>
          <li>Healthy snacks: beef jerky, almonds, trail mix, rice cakes</li>
        </ul>
        
        <h2>The Gym Vending Advantage</h2>
        <p>A well-stocked vending machine enhances your gym's value proposition. Members appreciate the convenience of grabbing a cold protein shake immediately after training, rather than driving to a supplement store or waiting to get home. It's a retention tool disguised as a convenience feature.</p>
        
        <h2>Gym Locations We Serve in Las Vegas</h2>
        <p>Kande VendTech places vending machines in gyms, fitness studios, CrossFit boxes, martial arts academies, yoga studios, rock climbing gyms, and other fitness facilities throughout Las Vegas, Henderson, North Las Vegas, Summerlin, and Boulder City.</p>
    `,
  },

  // 10. HOSPITAL VENDING MACHINES
  {
    filename: 'hospital-vending-machines.html',
    slug: '/hospital-vending-machines',
    metaTitle: 'Hospital Vending Machines in Las Vegas',
    metaDescription: 'FREE hospital vending machines in Las Vegas. AI smart coolers for waiting rooms, break rooms & lobbies. Healthy options for staff & visitors. Call Kande VendTech at 725-228-8822.',
    h1: 'Hospital <em>Vending Machines</em> in Las Vegas',
    heroSubtitle: 'Keep staff, visitors, and patients nourished around the clock. FREE AI-powered vending machines designed for healthcare environments.',
    heroCTA: 'Get a Free Hospital Machine',
    heroBadge: '🏥 Smart Vending for Healthcare',
    benefitsTitle: 'Why Healthcare Facilities Choose Kande VendTech',
    benefits: [
      { icon: '🏥', title: 'Built for Healthcare', text: 'We understand hospital needs: 24/7 staffing, stressed visitors, long waits. Our machines provide comfort food and healthy options around the clock.' },
      { icon: '🕐', title: '24/7 Access Critical', text: 'When the cafeteria is closed at 3am, night-shift nurses and worried families still need food. Our machines never close.' },
      { icon: '🥗', title: 'Healthy & Comfort Options', text: 'A thoughtful mix of nutritious meals, comfort snacks, and beverages that cater to diverse dietary needs.' },
      { icon: '💰', title: 'Zero Budget Impact', text: 'Healthcare budgets are tight. Our vending machines cost nothing — free installation, stocking, and maintenance.' },
      { icon: '🧼', title: 'Contactless & Hygienic', text: 'Cashless payment and grab-and-go technology minimize touchpoints — important in healthcare environments.' },
      { icon: '🔧', title: 'Reliable & Monitored', text: 'We monitor machines 24/7 and respond quickly to issues. Healthcare facilities can\'t afford downtime.' },
    ],
    featuresTitle: 'Healthcare-Appropriate Vending Options',
    featuresSubtitle: 'Thoughtfully stocked for the unique needs of hospital staff, patients, and visitors.',
    features: [
      { icon: '🥪', title: 'Fresh Meals & Sandwiches', text: 'Real meals for night-shift staff and visitors: sandwiches, wraps, salads, and prepared meals available 24/7.' },
      { icon: '💧', title: 'Hydration & Beverages', text: 'Water, juice, tea, coffee drinks, and electrolyte beverages for long shifts and stressful hospital visits.' },
      { icon: '🍎', title: 'Healthy Choices', text: 'Fresh fruit, yogurt, protein bars, and nutritious snacks that align with healthcare wellness initiatives.' },
      { icon: '🍫', title: 'Comfort Snacks', text: 'Sometimes you need comfort food. Chips, candy, cookies, and familiar favorites for stressed visitors and tired staff.' },
    ],
    howItWorksTitle: 'Get Free Hospital Vending in 3 Steps',
    steps: [
      { title: 'Contact Us', text: 'Call 725-228-8822 or email kurtis@kandevendtech.com about vending solutions for your healthcare facility.' },
      { title: 'Site Assessment & Install', text: 'We evaluate the best placement locations and install machines at no cost. We work around hospital schedules.' },
      { title: 'Reliable 24/7 Service', text: 'We maintain, restock, and monitor your machines around the clock — matching your facility\'s 24/7 operation.' },
    ],
    socialProof: 'Our nursing staff relies on the Kande VendTech machines during overnight shifts. Fresh sandwiches at 3am is a game-changer. The machine is always stocked, always clean, and we never have to worry about it.',
    ctaTitle: 'Get Free Vending for Your Healthcare Facility',
    ctaSubtitle: '24/7 food and beverages for staff and visitors. Zero cost. Contact Kande VendTech today.',
    mainContent: `
        <h2>Smart Vending for Las Vegas Healthcare Facilities</h2>
        <p>Hospitals and healthcare facilities operate 24/7, but cafeterias don't. Night-shift nurses, ER staff, anxious family members, and patients all need access to food and beverages at any hour. Kande VendTech's AI-powered smart coolers solve this problem with fresh meals, healthy snacks, and cold beverages available around the clock.</p>
        
        <h2>Why Hospitals Need Modern Vending</h2>
        <p>Healthcare vending has unique requirements that traditional machines fail to meet:</p>
        <ul>
          <li>24/7 reliability: Night shifts and emergencies don't follow business hours</li>
          <li>Fresh food options: Staff working 12-hour shifts need real meals, not just candy</li>
          <li>Hygienic design: Contactless payment reduces touchpoints in clinical environments</li>
          <li>Diverse dietary needs: Diabetic-friendly, low-sodium, allergen-aware options</li>
          <li>Visitor comfort: Stressed families waiting for news need easy access to food and drinks</li>
          <li>Zero maintenance burden: Hospital facilities teams are already stretched thin</li>
        </ul>
        
        <h2>Best Placement in Healthcare Facilities</h2>
        <p>We recommend placing smart coolers in these high-traffic hospital locations:</p>
        <ul>
          <li>Emergency room and urgent care waiting areas</li>
          <li>Main hospital lobby and visitor waiting areas</li>
          <li>Staff break rooms and nursing stations</li>
          <li>Near surgery waiting rooms</li>
          <li>Outpatient clinic lobbies</li>
          <li>Parking garage entrances and walkways</li>
        </ul>
        
        <h2>Healthcare Facilities We Serve</h2>
        <p>Kande VendTech serves hospitals, urgent care centers, medical office buildings, rehabilitation facilities, assisted living communities, and other healthcare facilities throughout Las Vegas, Henderson, North Las Vegas, Summerlin, and Boulder City.</p>
    `,
  },

  // 11. HOTEL VENDING MACHINES
  {
    filename: 'hotel-vending-machines.html',
    slug: '/hotel-vending-machines',
    metaTitle: 'Hotel Vending Machines in Las Vegas',
    metaDescription: 'FREE hotel vending machines in Las Vegas. AI smart coolers for lobbies, hallways & guest floors. Impress guests with modern vending technology. Call Kande VendTech at 725-228-8822.',
    h1: 'Hotel <em>Vending Machines</em> in Las Vegas',
    heroSubtitle: 'Upgrade your guest experience with AI-powered smart coolers. Modern, sleek, and FREE for Las Vegas hotels and resorts.',
    heroCTA: 'Get a Free Hotel Machine',
    heroBadge: '🏨 Smart Vending for Hotels & Resorts',
    benefitsTitle: 'Why Hotels Choose Kande VendTech',
    benefits: [
      { icon: '✨', title: 'Impress Your Guests', text: 'Replace clunky old vending machines with sleek, AI-powered smart coolers that wow guests and match your hotel\'s image.' },
      { icon: '🌙', title: 'Late-Night Convenience', text: 'Guests arriving late, partying on the Strip, early morning flights — your vending machine serves them when room service can\'t.' },
      { icon: '💰', title: 'Free for Your Property', text: 'Upgrade your vending at zero cost. We handle installation, stocking, and maintenance entirely. No investment needed.' },
      { icon: '🤖', title: 'Tech That Impresses', text: 'Las Vegas guests expect innovation. AI grab-and-go technology is a conversation piece and a genuine wow factor.' },
      { icon: '💳', title: 'Tourist-Friendly Payment', text: 'Contactless payment accepts all major cards, Apple Pay, Google Pay — perfect for tourists who don\'t carry cash.' },
      { icon: '🍷', title: 'Curated Product Selection', text: 'We stock hotel-appropriate products: premium snacks, cold beverages, hangover remedies, energy drinks, and quick meals.' },
    ],
    featuresTitle: 'Hotel-Optimized Vending Products',
    featuresSubtitle: 'Curated selections designed specifically for hotel guests in Las Vegas.',
    features: [
      { icon: '🌃', title: 'Late-Night Essentials', text: 'Snacks, drinks, pain relievers (where permitted), energy drinks, and comfort food for guests returning from the Strip.' },
      { icon: '✈️', title: 'Travel Conveniences', text: 'Water, energy bars, grab-and-go breakfast items, and easy meals for guests on tight schedules.' },
      { icon: '🍿', title: 'In-Room Snacking', text: 'Chips, candy, popcorn, cookies, and other snacks guests want for in-room relaxation.' },
      { icon: '💧', title: 'Premium Beverages', text: 'Premium water brands, energy drinks, juice, iced coffee, and specialty beverages that match hotel pricing.' },
    ],
    howItWorksTitle: 'Upgrade Your Hotel Vending in 3 Steps',
    steps: [
      { title: 'Contact Us', text: 'Call 725-228-8822 or email kurtis@kandevendtech.com to discuss vending solutions for your hotel.' },
      { title: 'Free Upgrade', text: 'We remove old machines (if applicable) and install modern AI smart coolers at no cost to your property.' },
      { title: 'Guests Love It', text: 'A modern amenity that impresses guests and provides 24/7 convenience. We handle all operations.' },
    ],
    socialProof: 'Replacing our old vending machines with Kande VendTech\'s smart coolers was the best decision. Guests love the technology, the machines look amazing in our halls, and we didn\'t spend a dollar. Our TripAdvisor reviews even mention the cool vending machines!',
    ctaTitle: 'Upgrade Your Hotel Vending for Free',
    ctaSubtitle: 'Modern AI vending that impresses Las Vegas guests. Zero cost. Contact Kande VendTech.',
    mainContent: `
        <h2>Next-Generation Hotel Vending in Las Vegas</h2>
        <p>Las Vegas is the entertainment capital of the world, and your hotel guests expect modern, premium experiences at every touchpoint. Old-fashioned vending machines with their clunky mechanics and cash-only payment are a relic. Kande VendTech's AI-powered smart coolers are the upgrade your property deserves — sleek design, grab-and-go technology, and zero cost to you.</p>
        
        <h2>Why Las Vegas Hotels Need Smart Vending</h2>
        <p>Hotel vending in Las Vegas faces unique challenges and opportunities:</p>
        <ul>
          <li>Guests return late from the Strip and need snacks and drinks</li>
          <li>Room service has limited hours; vending is always available</li>
          <li>Tourists don't carry cash — contactless payment is essential</li>
          <li>Modern design matters in a hotel setting</li>
          <li>Guests talk about unique experiences — AI vending is memorable</li>
          <li>Convention attendees need quick food options between sessions</li>
        </ul>
        
        <h2>Best Hotel Placement</h2>
        <p>We recommend placing smart coolers in these hotel areas for maximum usage:</p>
        <ul>
          <li>Guest floor hallways (replacing or supplementing traditional machines)</li>
          <li>Hotel lobby or near the front desk</li>
          <li>Near the pool area and fitness center</li>
          <li>Convention and meeting room areas</li>
          <li>Near elevators on high-traffic floors</li>
          <li>Business center or co-working spaces</li>
        </ul>
        
        <h2>Hotels We Serve in Las Vegas</h2>
        <p>Kande VendTech works with boutique hotels, extended-stay properties, independent hotels, and smaller resort properties throughout Las Vegas, Henderson, North Las Vegas, Summerlin, and Boulder City. From 50-room boutique properties to 300-room mid-size hotels, we have the right vending solution.</p>
    `,
  },

  // 12. SCHOOL VENDING MACHINES
  {
    filename: 'school-vending-machines.html',
    slug: '/school-vending-machines',
    metaTitle: 'School Vending Machines in Las Vegas',
    metaDescription: 'FREE school vending machines in Las Vegas. AI smart coolers with healthy, compliant snacks and beverages for students and staff. Zero cost installation. Call Kande VendTech at 725-228-8822.',
    h1: 'School <em>Vending Machines</em> in Las Vegas',
    heroSubtitle: 'Healthy, smart vending for students and staff. FREE AI-powered machines with compliant products that nourish young minds.',
    heroCTA: 'Get a Free School Machine',
    heroBadge: '🎓 Smart Vending for Schools & Universities',
    benefitsTitle: 'Why Schools Choose Kande VendTech',
    benefits: [
      { icon: '🎓', title: 'Education-Focused Selection', text: 'We stock products appropriate for school environments — nutritious options that fuel learning, not just sugar crashes.' },
      { icon: '🥗', title: 'Healthy & Compliant', text: 'We work with your school to ensure products meet nutritional guidelines and any applicable USDA Smart Snacks standards.' },
      { icon: '💰', title: 'Zero Budget Impact', text: 'School budgets are stretched. Our vending machines cost nothing — free installation, products, and maintenance.' },
      { icon: '🤖', title: 'Engaging Technology', text: 'Students love the AI grab-and-go technology. It\'s an engaging, modern experience that feels like the future.' },
      { icon: '💳', title: 'Cashless Convenience', text: 'Students don\'t carry cash. Contactless payment via cards and phone makes buying quick and easy for everyone.' },
      { icon: '🔒', title: 'Secure & Durable', text: 'Built to withstand high-traffic school environments. Secure payment processing and tamper-resistant design.' },
    ],
    featuresTitle: 'School-Appropriate Vending Products',
    featuresSubtitle: 'Nutritious options that support student health and meet school nutrition standards.',
    features: [
      { icon: '🍎', title: 'Fruit & Healthy Snacks', text: 'Fresh fruit cups, apple slices, trail mix, granola bars, rice cakes, and other smart snack options for students.' },
      { icon: '💧', title: 'Water & Healthy Beverages', text: 'Water, flavored water, 100% juice, milk, and low-sugar beverage options that meet school nutrition guidelines.' },
      { icon: '💪', title: 'Protein & Energy', text: 'Protein bars, cheese sticks, yogurt, nuts, and other protein-rich snacks to sustain energy through the school day.' },
      { icon: '🥪', title: 'Light Meals', text: 'Sandwiches, wraps, and grab-and-go meals for students who need more than a snack between classes.' },
    ],
    howItWorksTitle: 'Get Free School Vending in 3 Steps',
    steps: [
      { title: 'Contact Us', text: 'Call 725-228-8822 or email kurtis@kandevendtech.com about vending for your school or campus.' },
      { title: 'Compliance & Setup', text: 'We work with your administration to select compliant products and install at no cost.' },
      { title: 'Students & Staff Enjoy', text: 'Healthy, convenient food options available on campus. We manage restocking and maintenance.' },
    ],
    socialProof: 'Kande VendTech worked with our administration to stock products that meet our nutritional guidelines. The students love the technology, the staff appreciates the convenience, and it didn\'t cost our district a thing.',
    ctaTitle: 'Get a Free Vending Machine for Your School',
    ctaSubtitle: 'Healthy, compliant, AI-powered vending at zero cost. Contact Kande VendTech for schools in Las Vegas.',
    mainContent: `
        <h2>Smart Vending for Las Vegas Schools & Universities</h2>
        <p>Students need fuel to learn, and school cafeterias have limited hours. Kande VendTech's AI-powered smart coolers provide healthy, convenient food options throughout the school day — with products selected to meet nutritional standards. And because it's completely free, it won't touch your already-stretched school budget.</p>
        
        <h2>Products for Educational Environments</h2>
        <p>We carefully curate school vending selections to support student health:</p>
        <ul>
          <li>Fresh fruit cups, apple slices, and mixed berry packs</li>
          <li>Granola bars, protein bars, and oat bars</li>
          <li>String cheese, yogurt, and dairy snacks</li>
          <li>Trail mix, almonds, and dried fruit</li>
          <li>Water, 100% juice, and low-sugar beverages</li>
          <li>Whole grain crackers and pretzels</li>
          <li>Sandwiches and wraps for lunch alternatives</li>
        </ul>
        
        <h2>Meeting School Nutrition Standards</h2>
        <p>We understand that school vending must comply with nutritional guidelines. We work directly with school administrators to ensure our product selections meet applicable USDA Smart Snacks standards and any district-specific nutritional requirements. Every product is vetted for compliance before it enters your machine.</p>
        
        <h2>Campus Placement Recommendations</h2>
        <p>Our smart coolers work best in these school locations:</p>
        <ul>
          <li>Student commons or student union areas</li>
          <li>Near the cafeteria for extended meal access</li>
          <li>Library or study areas</li>
          <li>Staff break rooms and teacher lounges</li>
          <li>Athletic facilities and gym areas</li>
          <li>Dormitories and residential halls (colleges/universities)</li>
        </ul>
        
        <h2>Schools We Serve</h2>
        <p>Kande VendTech provides vending solutions for K-12 schools, colleges, universities, trade schools, and educational campuses throughout Las Vegas, Henderson, North Las Vegas, Summerlin, and Boulder City.</p>
    `,
  },

  // 13. WORKPLACE VENDING MACHINES
  {
    filename: 'workplace-vending-machines.html',
    slug: '/workplace-vending-machines',
    metaTitle: 'Workplace Vending Machines in Las Vegas',
    metaDescription: 'FREE workplace vending machines in Las Vegas. AI smart coolers for break rooms, warehouses, factories & job sites. Boost employee morale. Call Kande VendTech at 725-228-8822.',
    h1: 'Workplace <em>Vending Machines</em> in Las Vegas',
    heroSubtitle: 'Keep your workforce fueled with FREE AI-powered vending machines. Snacks, drinks, and meals for break rooms, warehouses, and job sites.',
    heroCTA: 'Get a Free Workplace Machine',
    heroBadge: '🏭 Smart Vending for the Workplace',
    benefitsTitle: 'Why Workplaces Choose Kande VendTech',
    benefits: [
      { icon: '👷', title: 'Built for Working People', text: 'Hearty snacks, energy drinks, cold water, and real meals for people who work hard. Not dainty — substantial.' },
      { icon: '⏰', title: 'All Shifts Covered', text: 'First shift, second shift, third shift — your vending machine is always stocked and always open, no matter the hour.' },
      { icon: '💰', title: 'Free Employee Perk', text: 'Add a premium amenity to your workplace without spending a dollar. We cover installation, stocking, and maintenance.' },
      { icon: '📈', title: 'Boost Morale & Retention', text: 'Employees notice when you invest in their comfort. A well-stocked break room reduces turnover and improves satisfaction.' },
      { icon: '🤖', title: 'Fast & Convenient', text: 'Short break times need fast solutions. Grab-and-go technology means employees spend their break eating, not waiting.' },
      { icon: '🔧', title: 'Zero Hassle for Management', text: 'We handle everything. Your facilities team doesn\'t need to manage stocking, repairs, or vendor relationships.' },
    ],
    featuresTitle: 'Workplace-Ready Vending Products',
    featuresSubtitle: 'Products selected for hardworking teams who need real fuel during their shift.',
    features: [
      { icon: '🥪', title: 'Meals & Sandwiches', text: 'Fresh sandwiches, wraps, burritos, and prepared meals for employees who need a real lunch on a short break.' },
      { icon: '⚡', title: 'Energy & Hydration', text: 'Energy drinks, coffee, electrolyte water, and sports drinks to power through physically demanding shifts.' },
      { icon: '🍿', title: 'Snacks & Quick Bites', text: 'Chips, protein bars, nuts, candy, and other snacks for break time or a quick pick-me-up on the floor.' },
      { icon: '🧊', title: 'Cold Drinks', text: 'Water, sodas, juices, teas, and more — ice cold and ready for thirsty workers.' },
    ],
    howItWorksTitle: 'Get Free Workplace Vending in 3 Steps',
    steps: [
      { title: 'Contact Us', text: 'Call 725-228-8822 or email us about adding vending to your workplace. We serve all industries.' },
      { title: 'Free Installation', text: 'We evaluate your break room or facility and install a smart cooler stocked with products your team will love.' },
      { title: 'Happy Employees', text: 'Snacks, drinks, and meals available every shift. We handle all restocking and maintenance permanently.' },
    ],
    socialProof: 'We put a Kande VendTech machine in our warehouse break room and our team loves it. Night shift guys can actually get a sandwich at midnight now. The AI technology is cool and it\'s always stocked.',
    ctaTitle: 'Get a Free Workplace Vending Machine',
    ctaSubtitle: 'Fuel your workforce at zero cost. Contact Kande VendTech for workplace vending in Las Vegas.',
    mainContent: `
        <h2>Smart Vending for Las Vegas Workplaces</h2>
        <p>Your employees are your most valuable asset, and they need fuel to perform. Whether it's a warehouse, factory, distribution center, construction site office, or any other workplace — Kande VendTech's AI-powered smart coolers provide convenient food and beverages that keep your team energized and satisfied.</p>
        
        <h2>Why Workplace Vending Matters</h2>
        <p>A stocked break room isn't just a nice perk — it's a business investment:</p>
        <ul>
          <li>Reduced turnover: Employees who feel cared for stay longer</li>
          <li>Increased productivity: Fueled workers perform better</li>
          <li>Shorter breaks: Grab-and-go means employees maximize break time eating, not traveling</li>
          <li>All-shift coverage: Night and weekend workers get the same access as day shift</li>
          <li>Zero cost: It's a benefit that doesn't hit your bottom line</li>
          <li>No management required: We handle everything — your team focuses on work</li>
        </ul>
        
        <h2>Industries We Serve</h2>
        <p>Our workplace vending machines are perfect for a wide range of Las Vegas industries:</p>
        <ul>
          <li>Warehouses and distribution centers</li>
          <li>Manufacturing and production facilities</li>
          <li>Construction site offices and trailers</li>
          <li>Call centers and service centers</li>
          <li>Auto repair shops and dealerships</li>
          <li>Government buildings and facilities</li>
          <li>Churches, community centers, and non-profits</li>
        </ul>
        
        <h2>Las Vegas Workplace Vending Coverage</h2>
        <p>Kande VendTech serves workplaces throughout Las Vegas, Henderson, North Las Vegas, Summerlin, Boulder City, and the entire valley. From small teams to large facilities, we have the right vending solution for your workplace.</p>
    `,
  },

  // 14. OFFICE VENDING MACHINES
  {
    filename: 'office-vending-machines.html',
    slug: '/office-vending-machines',
    metaTitle: 'Office Vending Machines in Las Vegas',
    metaDescription: 'FREE office vending machines in Las Vegas. AI smart coolers for break rooms & kitchens. Premium snacks, drinks & meals for your team. Call Kande VendTech at 725-228-8822.',
    h1: 'Office <em>Vending Machines</em> in Las Vegas',
    heroSubtitle: 'Upgrade your office break room with a FREE AI-powered smart cooler. Premium snacks, cold drinks, and fresh meals that keep your team happy and productive.',
    heroCTA: 'Get a Free Office Machine',
    heroBadge: '🏢 Smart Vending for Modern Offices',
    benefitsTitle: 'Why Offices Love Kande VendTech',
    benefits: [
      { icon: '☕', title: 'Break Room Upgrade', text: 'Transform your break room from boring to brilliant. A smart cooler with great products is the #1 break room improvement employees request.' },
      { icon: '📈', title: 'Productivity Boost', text: 'Employees who don\'t leave the building for food are back at their desk faster. Convenient vending saves time and boosts output.' },
      { icon: '💰', title: 'Zero Cost Perk', text: 'A premium office amenity that costs your company nothing. We handle all costs for installation, stocking, and maintenance.' },
      { icon: '🤖', title: 'Impressive Technology', text: 'AI grab-and-go vending impresses employees, clients, and visitors. It signals that your office embraces innovation.' },
      { icon: '🤝', title: 'Talent Attraction', text: 'Office perks matter in recruiting. A stocked break room with smart vending helps attract and retain talent.' },
      { icon: '🧹', title: 'No Mess, No Management', text: 'We stock, clean, and maintain the machine. No more managing a snack drawer, ordering from Costco, or cleaning up messes.' },
    ],
    featuresTitle: 'Office-Curated Products',
    featuresSubtitle: 'Premium snacks, beverages, and meals selected for the modern office environment.',
    features: [
      { icon: '☕', title: 'Coffee & Energy', text: 'Starbucks, Dunkin\', cold brew, energy drinks — the caffeine your office runs on, always ice cold and ready.' },
      { icon: '🥗', title: 'Lunch & Meals', text: 'Fresh sandwiches, salads, wraps, and bowls so your team can have a real lunch without leaving the building.' },
      { icon: '🍿', title: 'Snacks & Treats', text: 'From healthy protein bars to indulgent chocolate — a curated mix of office-appropriate snacks for every taste.' },
      { icon: '💧', title: 'Beverages', text: 'Water, sparkling water, juice, soda, tea — a full beverage selection to keep your team hydrated all day.' },
    ],
    howItWorksTitle: 'Upgrade Your Office Break Room in 3 Steps',
    steps: [
      { title: 'Contact Us', text: 'Call 725-228-8822 or email kurtis@kandevendtech.com. Tell us about your office and team size.' },
      { title: 'Free Installation', text: 'We deliver and install a smart cooler in your break room, stocked with products your team will love.' },
      { title: 'Team Loves It', text: 'Your employees get premium snacks and drinks on-site. We handle all restocking and maintenance.' },
    ],
    socialProof: 'Our office break room went from empty counter space to the most popular room in the building. The Kande VendTech machine has great snacks, the coffee options are perfect, and our team genuinely loves it. Zero cost to us.',
    ctaTitle: 'Get a Free Office Vending Machine',
    ctaSubtitle: 'Premium break room vending, AI technology, zero cost. Contact Kande VendTech for your Las Vegas office.',
    mainContent: `
        <h2>Smart Vending for the Modern Las Vegas Office</h2>
        <p>The modern office break room is more than a microwave and a water cooler. It's where your team recharges, connects, and refuels. Kande VendTech's AI-powered smart coolers turn your break room into a convenience store — stocked with premium snacks, cold beverages, coffee drinks, and fresh meals — all at zero cost to your company.</p>
        
        <h2>Why Office Vending Is a Smart Investment</h2>
        <p>Even though it's free, here's the business case for office vending:</p>
        <ul>
          <li>Saves employee time: No driving to get food means longer productive hours</li>
          <li>Improves satisfaction: A stocked break room consistently ranks as a top workplace perk</li>
          <li>Aids retention: Small perks add up. Employees who feel valued stay longer</li>
          <li>Impresses clients: Visitors notice modern amenities. An AI smart cooler makes a statement</li>
          <li>Eliminates snack management: No more office managers ordering from Costco or tracking a snack fund</li>
          <li>Zero cost: All the benefits with none of the expense</li>
        </ul>
        
        <h2>Perfect for Any Office Size</h2>
        <p>Whether you're a 50-person company or a 500-person enterprise, our smart coolers adapt to your needs. We adjust product selection and restocking frequency based on your team size and preferences. We serve offices of all types:</p>
        <ul>
          <li>Corporate offices and headquarters</li>
          <li>Law firms and financial services</li>
          <li>Tech companies and startups</li>
          <li>Real estate and insurance offices</li>
          <li>Medical and dental office break rooms</li>
          <li>Co-working spaces and shared offices</li>
          <li>Government offices and public agencies</li>
        </ul>
        
        <h2>Office Vending Throughout Las Vegas</h2>
        <p>Kande VendTech serves offices throughout the Las Vegas metropolitan area including the Las Vegas business district, Henderson, Summerlin, North Las Vegas, and Boulder City. From downtown high-rises to suburban office parks, we deliver the same premium smart vending experience.</p>
    `,
  },
];

// Generate all pages
pages.forEach(config => {
  const html = generatePage(config);
  const filePath = path.join(PAGES_DIR, config.filename);
  fs.writeFileSync(filePath, html, 'utf8');
  console.log(`✅ Created: ${config.filename} (${Math.round(html.length / 1024)}KB)`);
});

console.log(`\n🎉 All ${pages.length} pages generated in ${PAGES_DIR}`);
