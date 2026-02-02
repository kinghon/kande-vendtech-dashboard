/**
 * Kande VendTech — Global Navigation Component v2
 * Grouped sidebar navigation with collapsible sections.
 * Include via: <script src="/nav.js"></script>
 */
(function () {
  'use strict';

  var NAV_GROUPS = [
    {
      label: 'Dashboard', icon: '📊', href: '/', items: []
    },
    {
      label: 'Sales', icon: '💰', items: [
        { label: 'CRM',          href: '/crm' },
        { label: 'Pipeline',     href: '/pipeline-board' },
        { label: 'Outreach',     href: '/outreach' },
        { label: 'Site Survey',  href: '/site-survey' },
        { label: 'Proposals',    href: '/proposal-generator' },
        { label: 'Contracts',    href: '/contracts' }
      ]
    },
    {
      label: 'Operations', icon: '📋', items: [
        { label: 'Overview',     href: '/operations' },
        { label: 'Schedule',     href: '/schedule' },
        { label: 'Routes',       href: '/routes' },
        { label: 'Warehouse',    href: '/warehouse' },
        { label: 'Fleet',        href: '/fleet' },
        { label: 'Driver Mobile', href: '/driver' }
      ]
    },
    {
      label: 'Intelligence', icon: '📈', items: [
        { label: 'Product Mix',  href: '/product-mix' },
        { label: 'Site Surveys', href: '/property-analysis' },
        { label: 'Tasks',        href: '/tasks' },
        { label: 'Analytics',    href: '/analytics', badge: 'soon' }
      ]
    },
    {
      label: 'Financial', icon: '💵', href: '/finance', items: []
    },
    {
      label: 'Clients', icon: '👤', items: [
        { label: 'Client Portal', href: '/client-portal' }
      ]
    }
  ];

  var path = location.pathname;

  function isActive(href) {
    if (href === '/') return path === '/' || path === '/index.html' || path === '/home';
    return path === href || path.startsWith(href + '/');
  }

  function groupIsActive(group) {
    if (group.href && isActive(group.href)) return true;
    return group.items && group.items.some(function (i) { return isActive(i.href); });
  }

  /* ── CSS ──────────────────────────────────────────── */
  var css = document.createElement('style');
  css.textContent = `
    /* Reset body */
    body.kv-nav-active { padding-top: 0 !important; margin: 0; }
    
    /* Sidebar */
    #kv-sidebar {
      position: fixed; top: 0; left: 0; bottom: 0; width: 240px; z-index: 9999;
      background: #f8fafc; color: #475569; overflow-y: auto; overflow-x: hidden; border-right: 1px solid #e2e8f0;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      transition: transform 0.3s ease;
      scrollbar-width: thin; scrollbar-color: #cbd5e1 transparent;
    }
    #kv-sidebar::-webkit-scrollbar { width: 4px; }
    #kv-sidebar::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 2px; }

    .kv-sidebar-brand {
      display: flex; align-items: center; gap: 10px; padding: 20px 18px 16px;
      border-bottom: 1px solid #e2e8f0; text-decoration: none;
    }
    .kv-sidebar-brand img { height: 32px; border-radius: 6px; }
    .kv-sidebar-brand span { font-size: 0.95rem; font-weight: 700; color: #0f172a; letter-spacing: -0.3px; }

    .kv-nav-section { padding: 8px 0; }

    /* Group header (top-level) */
    .kv-nav-group-header {
      display: flex; align-items: center; gap: 10px; padding: 10px 18px; cursor: pointer;
      font-size: 0.82rem; font-weight: 600; color: #475569; text-decoration: none;
      transition: all 0.15s; user-select: none; border: none; background: none; width: 100%; text-align: left;
    }
    .kv-nav-group-header:hover { color: #0f172a; background: #e2e8f0; }
    .kv-nav-group-header.active { color: #3b82f6; }
    .kv-nav-group-header .kv-icon { font-size: 1rem; width: 22px; text-align: center; flex-shrink: 0; }
    .kv-nav-group-header .kv-chevron {
      margin-left: auto; font-size: 0.65rem; transition: transform 0.2s; color: #475569;
    }
    .kv-nav-group-header.open .kv-chevron { transform: rotate(90deg); }

    /* Sub items */
    .kv-nav-items { overflow: hidden; max-height: 0; transition: max-height 0.25s ease; }
    .kv-nav-items.open { max-height: 500px; }
    .kv-nav-items a {
      display: flex; align-items: center; gap: 8px; padding: 8px 18px 8px 50px;
      color: #64748b; text-decoration: none; font-size: 0.8rem; font-weight: 500;
      transition: all 0.15s; border-left: 2px solid transparent;
    }
    .kv-nav-items a:hover { color: #0f172a; background: #e2e8f0; }
    .kv-nav-items a.active {
      color: #60a5fa; background: rgba(96,165,250,0.08); border-left-color: #60a5fa; font-weight: 600;
    }
    .kv-nav-items .kv-badge {
      font-size: 0.6rem; background: #e2e8f0; color: #64748b; padding: 1px 6px;
      border-radius: 8px; margin-left: auto; text-transform: uppercase; font-weight: 700;
    }

    /* Direct link group (no children) */
    a.kv-nav-group-header.active {
      color: #60a5fa; background: rgba(96,165,250,0.1);
    }

    /* Top bar (mobile + breadcrumb) */
    #kv-topbar {
      position: fixed; top: 0; left: 240px; right: 0; height: 52px; z-index: 9998;
      background: #ffffff; border-bottom: 1px solid #e2e8f0;
      display: flex; align-items: center; padding: 0 24px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }
    #kv-topbar .kv-hamburger {
      display: none; background: none; border: none; font-size: 1.3rem; cursor: pointer;
      padding: 6px; margin-right: 12px; color: #334155;
    }
    #kv-topbar .kv-page-title { font-size: 0.9rem; font-weight: 600; color: #1e293b; }
    #kv-topbar .kv-topbar-right { margin-left: auto; display: flex; align-items: center; gap: 12px; }
    #kv-topbar .kv-status-dot { width: 8px; height: 8px; border-radius: 50%; background: #22c55e; }
    #kv-topbar .kv-user { font-size: 0.8rem; color: #64748b; font-weight: 500; }

    /* Main content area */
    .kv-main-content { margin-left: 240px; padding-top: 52px; min-height: 100vh; }

    /* Overlay for mobile */
    #kv-overlay {
      display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0,0,0,0.5); z-index: 9998;
    }
    #kv-overlay.open { display: block; }

    /* Mobile responsive */
    @media (max-width: 1024px) {
      #kv-sidebar { transform: translateX(-100%); }
      #kv-sidebar.open { transform: translateX(0); }
      #kv-topbar { left: 0; }
      #kv-topbar .kv-hamburger { display: block; }
      .kv-main-content { margin-left: 0; }
    }
  `;
  document.head.appendChild(css);

  /* ── Determine current page title ─────────────────── */
  var pageTitle = 'Dashboard';
  NAV_GROUPS.forEach(function (g) {
    if (g.href && isActive(g.href)) pageTitle = g.label;
    if (g.items) g.items.forEach(function (i) {
      if (isActive(i.href)) pageTitle = i.label;
    });
  });

  /* ── Build sidebar HTML ───────────────────────────── */
  var sidebarHTML = '<a class="kv-sidebar-brand" href="/">' +
    '<img src="/logo.png" alt="K" onerror="this.style.display=\'none\'">' +
    '<span>Kande VendTech</span></a><div class="kv-nav-section">';

  NAV_GROUPS.forEach(function (g) {
    var active = groupIsActive(g);
    var hasItems = g.items && g.items.length > 0;

    if (!hasItems) {
      // Direct link
      sidebarHTML += '<a class="kv-nav-group-header' + (active ? ' active' : '') + '" href="' + g.href + '">' +
        '<span class="kv-icon">' + g.icon + '</span>' + g.label + '</a>';
    } else {
      // Collapsible group
      sidebarHTML += '<button class="kv-nav-group-header' + (active ? ' active open' : '') + '" data-group>' +
        '<span class="kv-icon">' + g.icon + '</span>' + g.label +
        '<span class="kv-chevron">▶</span></button>';
      sidebarHTML += '<div class="kv-nav-items' + (active ? ' open' : '') + '">';
      g.items.forEach(function (i) {
        sidebarHTML += '<a href="' + i.href + '"' + (isActive(i.href) ? ' class="active"' : '') + '>' +
          i.label + (i.badge ? '<span class="kv-badge">' + i.badge + '</span>' : '') + '</a>';
      });
      sidebarHTML += '</div>';
    }
  });
  sidebarHTML += '</div>';

  /* ── Inject sidebar ───────────────────────────────── */
  var sidebar = document.createElement('nav');
  sidebar.id = 'kv-sidebar';
  sidebar.innerHTML = sidebarHTML;
  document.body.prepend(sidebar);

  /* ── Inject topbar ────────────────────────────────── */
  var topbar = document.createElement('div');
  topbar.id = 'kv-topbar';
  topbar.innerHTML = '<button class="kv-hamburger" aria-label="Menu">☰</button>' +
    '<span class="kv-page-title">' + pageTitle + '</span>' +
    '<div class="kv-topbar-right"><span class="kv-status-dot"></span><span class="kv-user">Kurtis</span></div>';
  sidebar.parentNode.insertBefore(topbar, sidebar.nextSibling);

  /* ── Overlay for mobile ───────────────────────────── */
  var overlay = document.createElement('div');
  overlay.id = 'kv-overlay';
  topbar.parentNode.insertBefore(overlay, topbar.nextSibling);

  /* ── Wrap existing content ────────────────────────── */
  var mainWrap = document.createElement('div');
  mainWrap.className = 'kv-main-content';
  while (document.body.childNodes.length > 3) {
    // Move everything after sidebar+topbar+overlay into the wrapper
    var node = document.body.childNodes[3];
    mainWrap.appendChild(node);
  }
  document.body.appendChild(mainWrap);

  /* ── Body class ───────────────────────────────────── */
  document.body.classList.add('kv-nav-active');

  /* ── Toggle groups ────────────────────────────────── */
  sidebar.querySelectorAll('[data-group]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      btn.classList.toggle('open');
      var items = btn.nextElementSibling;
      if (items) items.classList.toggle('open');
    });
  });

  /* ── Mobile hamburger ─────────────────────────────── */
  var hamburger = topbar.querySelector('.kv-hamburger');
  hamburger.addEventListener('click', function () {
    sidebar.classList.toggle('open');
    overlay.classList.toggle('open');
  });
  overlay.addEventListener('click', function () {
    sidebar.classList.remove('open');
    overlay.classList.remove('open');
  });

  /* ── Hide old inline navs ─────────────────────────── */
  document.querySelectorAll('.top-nav, .topbar').forEach(function (el) {
    if (el.id !== 'kv-sidebar' && el.id !== 'kv-topbar') el.style.display = 'none';
  });
})();
