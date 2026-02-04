/**
 * Kande VendTech — Top Navigation Bar v3
 * Horizontal top nav with hover dropdowns, mobile hamburger.
 * Include via: <script src="/nav.js"></script>
 */
(function () {
  'use strict';

  /* ── Navigation structure ─────────────────────────── */
  var NAV_ITEMS = [
    { label: 'Dashboard', href: '/' },
    { label: 'Today', href: '/daily-planner' },
    { label: 'Performance', href: '/performance' },
    {
      label: 'Sales', items: [
        { label: 'CRM',       href: '/crm' },
        { label: 'Pipeline',  href: '/pipeline-board' },
        { label: 'Follow-Ups', href: '/follow-ups' },
        { label: 'Lead Import', href: '/lead-import' },
        { label: 'Outreach',  href: '/outreach' },
        { label: 'Proposals', href: '/proposal-generator' },
        { label: 'Revenue Calculator', href: '/revenue-calculator' },
        { label: 'Contracts', href: '/contracts' },
        { label: 'Contract Gen', href: '/contract-generator' },
        { label: 'Gift Baskets', href: '/gift-baskets' }
      ]
    },
    {
      label: 'Operations', items: [
        { label: 'Overview',       href: '/operations' },
        { label: 'Schedule',       href: '/schedule' },
        { label: 'Weekly Routes',  href: '/weekly-routes' },
        { label: 'Routes',         href: '/routes' },
        { label: 'Machines',       href: '/machines' },
        { label: 'Restock Planner', href: '/restock-planner' },
        { label: 'Inventory',      href: '/inventory' },
        { label: 'Pricing',        href: '/pricing' },
        { label: 'Warehouse',      href: '/warehouse' },
        { label: 'Fleet',          href: '/fleet' },
        { label: 'Restock',        href: '/restock' },
        { label: 'Vendors',        href: '/vendors' },
        { label: 'Machine Locator', href: '/machine-locator' },
        { label: 'Driver Mobile',  href: '/driver' }
      ]
    },
    {
      label: 'Intelligence', items: [
        { label: 'Product Mix',   href: '/product-mix' },
        { label: 'Apollo Contacts', href: '/apollo' },
        { label: 'Site Surveys',  href: '/property-analysis' },
        { label: 'Win/Loss Analysis', href: '/win-loss' },
        { label: 'Tasks',         href: '/tasks' },
        { label: 'Analytics',     href: '/analytics' }
      ]
    },
    {
      label: 'Financial', items: [
        { label: 'Overview',  href: '/financials' },
        { label: 'Revenue Tracking', href: '/revenue' },
        { label: 'Expenses', href: '/expenses' }
      ]
    },
    { label: 'Clients',   href: '/client-portal' },
    {
      label: 'Help', items: [
        { label: 'Resources & Training', href: '/resources' },
        { label: 'Playbook',             href: '/playbook' },
        { label: 'Call Scripts',         href: '/call-scripts' },
        { label: 'Email Templates',      href: '/email-templates' }
      ]
    }
  ];

  var path = location.pathname;

  function isActive(href) {
    if (href === '/') return path === '/' || path === '/index.html' || path === '/home' || path === '/home.html';
    return path === href || path === href + '.html' || path.startsWith(href + '/');
  }

  function groupIsActive(item) {
    if (item.href) return isActive(item.href);
    return item.items && item.items.some(function (i) { return isActive(i.href); });
  }

  /* ── CSS ──────────────────────────────────────────── */
  var css = document.createElement('style');
  css.textContent = [
    '/* Reset */',
    'body.kv-nav-active { margin: 0; padding: 0 !important; }',
    '',
    '/* ── Top Navigation Bar ── */',
    '#kv-topnav {',
    '  position: fixed; top: 0; left: 0; right: 0; height: 56px; z-index: 9999;',
    '  background: #ffffff; border-bottom: 1px solid #e2e8f0;',
    '  box-shadow: 0 1px 3px rgba(0,0,0,0.04);',
    '  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;',
    '  display: flex; align-items: center; padding: 0 20px;',
    '  box-sizing: border-box;',
    '}',
    '',
    '/* Brand */',
    '#kv-topnav .kv-brand {',
    '  display: flex; align-items: center; gap: 10px; text-decoration: none;',
    '  margin-right: 32px; flex-shrink: 0;',
    '}',
    '#kv-topnav .kv-brand img { height: 28px; border-radius: 6px; }',
    '#kv-topnav .kv-brand span {',
    '  font-size: 0.92rem; font-weight: 700; color: #0f172a; letter-spacing: -0.3px;',
    '  white-space: nowrap;',
    '}',
    '',
    '/* Nav items container */',
    '#kv-topnav .kv-nav-items {',
    '  display: flex; align-items: center; gap: 2px; flex: 1; min-width: 0;',
    '}',
    '',
    '/* Individual nav item (wrapper for link + dropdown) */',
    '#kv-topnav .kv-nav-item {',
    '  position: relative;',
    '}',
    '',
    '/* Nav link / trigger */',
    '#kv-topnav .kv-nav-link {',
    '  display: flex; align-items: center; gap: 4px;',
    '  padding: 8px 14px; border-radius: 6px;',
    '  font-size: 0.84rem; font-weight: 600; color: #475569;',
    '  text-decoration: none; white-space: nowrap;',
    '  transition: color 0.15s, background 0.15s;',
    '  cursor: pointer; border: none; background: none;',
    '  font-family: inherit; line-height: 1;',
    '}',
    '#kv-topnav .kv-nav-link:hover {',
    '  color: #0f172a; background: #f1f5f9;',
    '}',
    '#kv-topnav .kv-nav-link.active {',
    '  color: #3b82f6;',
    '}',
    '#kv-topnav .kv-nav-link .kv-caret {',
    '  font-size: 0.6rem; margin-left: 2px; color: #94a3b8;',
    '  transition: transform 0.2s;',
    '}',
    '',
    '/* Dropdown menu */',
    '#kv-topnav .kv-dropdown {',
    '  position: absolute; top: 100%; left: 0; margin-top: 4px;',
    '  background: #ffffff; border: 1px solid #e2e8f0;',
    '  border-radius: 8px; box-shadow: 0 4px 16px rgba(0,0,0,0.08);',
    '  min-width: 180px; padding: 6px 0;',
    '  opacity: 0; visibility: hidden; transform: translateY(-4px);',
    '  transition: opacity 0.15s, transform 0.15s, visibility 0.15s;',
    '  z-index: 10000;',
    '}',
    '#kv-topnav .kv-nav-item:hover > .kv-dropdown,',
    '#kv-topnav .kv-nav-item.kv-open > .kv-dropdown {',
    '  opacity: 1; visibility: visible; transform: translateY(0);',
    '}',
    '#kv-topnav .kv-dropdown a {',
    '  display: block; padding: 9px 16px;',
    '  font-size: 0.82rem; font-weight: 500; color: #475569;',
    '  text-decoration: none; transition: all 0.1s;',
    '}',
    '#kv-topnav .kv-dropdown a:hover {',
    '  background: #f1f5f9; color: #0f172a;',
    '}',
    '#kv-topnav .kv-dropdown a.active {',
    '  color: #3b82f6; background: #eff6ff; font-weight: 600;',
    '}',
    '',
    '/* Right side (user) */',
    '#kv-topnav .kv-nav-right {',
    '  margin-left: auto; display: flex; align-items: center; gap: 10px;',
    '  flex-shrink: 0; padding-left: 16px;',
    '}',
    '#kv-topnav .kv-status-dot {',
    '  width: 8px; height: 8px; border-radius: 50%; background: #22c55e;',
    '}',
    '#kv-topnav .kv-user {',
    '  font-size: 0.82rem; color: #64748b; font-weight: 500;',
    '}',
    '',
    '/* Hamburger (hidden on desktop) */',
    '#kv-topnav .kv-hamburger {',
    '  display: none; background: none; border: none;',
    '  font-size: 1.4rem; cursor: pointer; padding: 4px 8px;',
    '  color: #334155; margin-right: 8px; line-height: 1;',
    '}',
    '',
    '/* ── Main content area ── */',
    '.kv-main-content {',
    '  margin-left: 0 !important; padding-top: 56px; min-height: 100vh;',
    '}',
    '',
    '/* Pre-wrap: offset body before DOMContentLoaded wrapping */',
    'body.kv-nav-active:not(.kv-nav-wrapped) {',
    '  margin-left: 0; padding-top: 56px;',
    '}',
    'body.kv-nav-active.kv-nav-wrapped { margin-left: 0; padding-top: 0; }',
    '',
    '/* ── Mobile overlay ── */',
    '#kv-overlay {',
    '  display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0;',
    '  background: rgba(0,0,0,0.4); z-index: 9998;',
    '}',
    '#kv-overlay.open { display: block; }',
    '',
    '/* ── Mobile menu ── */',
    '#kv-mobile-menu {',
    '  display: none; position: fixed; top: 56px; left: 0; right: 0;',
    '  background: #ffffff; border-bottom: 1px solid #e2e8f0;',
    '  box-shadow: 0 8px 24px rgba(0,0,0,0.1);',
    '  z-index: 9999; max-height: calc(100vh - 56px); overflow-y: auto;',
    '  padding: 8px 0;',
    '}',
    '#kv-mobile-menu.open { display: block; }',
    '#kv-mobile-menu .kv-mob-link {',
    '  display: block; padding: 12px 20px;',
    '  font-size: 0.9rem; font-weight: 600; color: #475569;',
    '  text-decoration: none; border-bottom: 1px solid #f1f5f9;',
    '}',
    '#kv-mobile-menu .kv-mob-link:hover { background: #f8fafc; color: #0f172a; }',
    '#kv-mobile-menu .kv-mob-link.active { color: #3b82f6; }',
    '#kv-mobile-menu .kv-mob-group-label {',
    '  display: flex; align-items: center; justify-content: space-between;',
    '  padding: 12px 20px; font-size: 0.9rem; font-weight: 600; color: #475569;',
    '  cursor: pointer; border-bottom: 1px solid #f1f5f9;',
    '  background: none; border-left: none; border-right: none; border-top: none;',
    '  width: 100%; text-align: left; font-family: inherit;',
    '}',
    '#kv-mobile-menu .kv-mob-group-label:hover { background: #f8fafc; }',
    '#kv-mobile-menu .kv-mob-group-label.active { color: #3b82f6; }',
    '#kv-mobile-menu .kv-mob-group-label .kv-mob-caret {',
    '  font-size: 0.6rem; transition: transform 0.2s; color: #94a3b8;',
    '}',
    '#kv-mobile-menu .kv-mob-group-label.open .kv-mob-caret { transform: rotate(180deg); }',
    '#kv-mobile-menu .kv-mob-subitems { display: none; background: #f8fafc; }',
    '#kv-mobile-menu .kv-mob-subitems.open { display: block; }',
    '#kv-mobile-menu .kv-mob-subitems a {',
    '  display: block; padding: 10px 20px 10px 36px;',
    '  font-size: 0.84rem; font-weight: 500; color: #64748b;',
    '  text-decoration: none; border-bottom: 1px solid #f1f5f9;',
    '}',
    '#kv-mobile-menu .kv-mob-subitems a:hover { color: #0f172a; background: #f1f5f9; }',
    '#kv-mobile-menu .kv-mob-subitems a.active { color: #3b82f6; font-weight: 600; }',
    '',
    '/* ── Notification Bell ── */',
    '#kv-topnav .kv-notification-bell {',
    '  position: relative; display: flex; align-items: center;',
    '  margin-right: 8px; font-size: 1.15rem; text-decoration: none;',
    '  padding: 6px 8px; border-radius: 6px; transition: background 0.15s;',
    '}',
    '#kv-topnav .kv-notification-bell:hover { background: #f1f5f9; }',
    '/* ── Settings Gear ── */',
    '#kv-topnav .kv-settings-gear {',
    '  display: flex; align-items: center;',
    '  margin-right: 12px; font-size: 1.1rem; text-decoration: none;',
    '  padding: 6px 8px; border-radius: 6px; transition: all 0.15s;',
    '}',
    '#kv-topnav .kv-settings-gear:hover { background: #f1f5f9; transform: rotate(45deg); }',
    '#kv-topnav .kv-badge {',
    '  position: absolute; top: 0; right: 0;',
    '  background: #ef4444; color: #fff;',
    '  font-size: 0.6rem; font-weight: 700;',
    '  padding: 2px 5px; border-radius: 10px;',
    '  min-width: 16px; text-align: center; line-height: 1.2;',
    '  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;',
    '}',
    '',
    '/* ── Responsive ── */',
    '@media (max-width: 900px) {',
    '  #kv-topnav .kv-nav-items { display: none; }',
    '  #kv-topnav .kv-hamburger { display: block; }',
    '  #kv-topnav .kv-brand { margin-right: auto; }',
    '}'
  ].join('\n');
  document.head.appendChild(css);

  /* ── Build top navbar HTML ────────────────────────── */
  var navHTML = '';

  // Hamburger (mobile)
  navHTML += '<button class="kv-hamburger" aria-label="Menu">☰</button>';

  // Brand
  navHTML += '<a class="kv-brand" href="/">';
  navHTML += '<img src="/logo.png" alt="K" onerror="this.style.display=\'none\'">';
  navHTML += '<span>Kande VendTech</span></a>';

  // Nav items
  navHTML += '<div class="kv-nav-items">';
  NAV_ITEMS.forEach(function (item) {
    var active = groupIsActive(item);

    if (!item.items || !item.items.length) {
      // Simple link
      navHTML += '<div class="kv-nav-item">';
      navHTML += '<a class="kv-nav-link' + (active ? ' active' : '') + '" href="' + item.href + '">' + item.label + '</a>';
      navHTML += '</div>';
    } else {
      // Dropdown
      navHTML += '<div class="kv-nav-item">';
      navHTML += '<span class="kv-nav-link' + (active ? ' active' : '') + '">' + item.label + ' <span class="kv-caret">▾</span></span>';
      navHTML += '<div class="kv-dropdown">';
      item.items.forEach(function (sub) {
        navHTML += '<a href="' + sub.href + '"' + (isActive(sub.href) ? ' class="active"' : '') + '>' + sub.label + '</a>';
      });
      navHTML += '</div></div>';
    }
  });
  navHTML += '</div>';

  // Right side
  navHTML += '<div class="kv-nav-right">';
  navHTML += '<a href="/notifications" class="kv-notification-bell" id="kv-notification-bell" title="Notifications">';
  navHTML += '🔔<span class="kv-badge" id="kv-notification-badge" style="display:none;">0</span>';
  navHTML += '</a>';
  navHTML += '<a href="/settings" class="kv-settings-gear" title="Settings">⚙️</a>';
  navHTML += '<span class="kv-status-dot"></span>';
  navHTML += '<span class="kv-user">Kurtis</span>';
  navHTML += '</div>';

  /* ── Build mobile menu HTML ───────────────────────── */
  var mobileHTML = '';
  NAV_ITEMS.forEach(function (item) {
    var active = groupIsActive(item);

    if (!item.items || !item.items.length) {
      mobileHTML += '<a class="kv-mob-link' + (active ? ' active' : '') + '" href="' + item.href + '">' + item.label + '</a>';
    } else {
      mobileHTML += '<button class="kv-mob-group-label' + (active ? ' active' : '') + '">' + item.label + ' <span class="kv-mob-caret">▾</span></button>';
      mobileHTML += '<div class="kv-mob-subitems' + (active ? ' open' : '') + '">';
      item.items.forEach(function (sub) {
        mobileHTML += '<a href="' + sub.href + '"' + (isActive(sub.href) ? ' class="active"' : '') + '>' + sub.label + '</a>';
      });
      mobileHTML += '</div>';
    }
  });
  // Add Settings at bottom of mobile menu
  mobileHTML += '<a class="kv-mob-link' + (isActive('/settings') ? ' active' : '') + '" href="/settings" style="border-top: 2px solid #e2e8f0; margin-top: 8px;">⚙️ Settings</a>';

  /* ── Inject elements ──────────────────────────────── */
  var topnav = document.createElement('nav');
  topnav.id = 'kv-topnav';
  topnav.innerHTML = navHTML;
  document.body.prepend(topnav);

  var mobileMenu = document.createElement('div');
  mobileMenu.id = 'kv-mobile-menu';
  mobileMenu.innerHTML = mobileHTML;
  topnav.parentNode.insertBefore(mobileMenu, topnav.nextSibling);

  var overlay = document.createElement('div');
  overlay.id = 'kv-overlay';
  mobileMenu.parentNode.insertBefore(overlay, mobileMenu.nextSibling);

  /* ── Body class ───────────────────────────────────── */
  document.body.classList.add('kv-nav-active');

  /* ── Wrap existing content (deferred until DOM is fully parsed) ── */
  function wrapPageContent() {
    if (document.querySelector('.kv-main-content')) return;
    var mainWrap = document.createElement('div');
    mainWrap.className = 'kv-main-content';
    var children = Array.prototype.slice.call(document.body.childNodes);
    children.forEach(function (node) {
      if (node === topnav || node === mobileMenu || node === overlay) return;
      mainWrap.appendChild(node);
    });
    document.body.appendChild(mainWrap);
    document.body.classList.add('kv-nav-wrapped');
    /* Hide any old inline navs from legacy pages */
    document.querySelectorAll('.top-nav, .topbar, #kv-sidebar').forEach(function (el) {
      if (el.id !== 'kv-topnav') el.style.display = 'none';
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wrapPageContent);
  } else {
    wrapPageContent();
  }

  /* ── Mobile hamburger toggle ──────────────────────── */
  var hamburger = topnav.querySelector('.kv-hamburger');

  function closeMobile() {
    mobileMenu.classList.remove('open');
    overlay.classList.remove('open');
  }

  hamburger.addEventListener('click', function () {
    var isOpen = mobileMenu.classList.contains('open');
    if (isOpen) {
      closeMobile();
    } else {
      mobileMenu.classList.add('open');
      overlay.classList.add('open');
    }
  });

  overlay.addEventListener('click', closeMobile);

  /* ── Mobile accordion toggles ─────────────────────── */
  mobileMenu.querySelectorAll('.kv-mob-group-label').forEach(function (btn) {
    btn.addEventListener('click', function () {
      btn.classList.toggle('open');
      var subs = btn.nextElementSibling;
      if (subs) subs.classList.toggle('open');
    });
  });

  /* ── Desktop: close dropdowns when clicking outside ── */
  document.addEventListener('click', function (e) {
    if (!e.target.closest('#kv-topnav')) {
      topnav.querySelectorAll('.kv-nav-item.kv-open').forEach(function (el) {
        el.classList.remove('kv-open');
      });
    }
  });

  /* ── Notification badge updater ── */
  function updateNotificationBadge() {
    var badge = document.getElementById('kv-notification-badge');
    if (!badge) return;
    
    fetch('/api/notifications/count')
      .then(function(r) { return r.ok ? r.json() : { count: 0 }; })
      .then(function(data) {
        var count = data.count || 0;
        if (count > 0) {
          badge.textContent = count > 99 ? '99+' : String(count);
          badge.style.display = 'block';
        } else {
          badge.style.display = 'none';
        }
      })
      .catch(function() { badge.style.display = 'none'; });
  }
  
  // Update badge on load and every 60 seconds
  updateNotificationBadge();
  setInterval(updateNotificationBadge, 60000);

})();
