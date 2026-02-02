// ============================================================
// Kandé VendTech — Financial Dashboard JS
// ============================================================

let currentPeriod = 'month';
let machines = [], locations = [], routes = [];
let charts = {};

const $ = id => document.getElementById(id);
const fmt = n => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = n => (Number(n) || 0).toFixed(1) + '%';

// ============================================================
// INIT
// ============================================================
document.addEventListener('DOMContentLoaded', async () => {
  // Set default dates
  const today = new Date().toISOString().split('T')[0];
  document.querySelectorAll('input[type="date"]').forEach(el => { if (!el.value) el.value = today; });

  // Tab switching
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      $('tab-' + btn.dataset.tab).classList.add('active');
    });
  });

  // Period switching
  document.querySelectorAll('#globalPeriod .period-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#globalPeriod .period-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentPeriod = btn.dataset.period;
      refreshAll();
    });
  });

  await loadBaseData();
  await refreshAll();
});

// ============================================================
// DATA LOADING
// ============================================================
async function api(url, opts) {
  const res = await fetch(url, opts);
  return res.json();
}

async function loadBaseData() {
  [machines, locations, routes] = await Promise.all([
    api('/api/machines'),
    api('/api/locations'),
    api('/api/routes')
  ]);
  populateSelects();
}

function populateSelects() {
  const machSelects = ['revMachine', 'expMachine', 'mLocation'];
  const locSelects = ['expLocation', 'invoiceLocation', 'cLocation', 'rLocations'];
  const routeSelects = ['expRoute', 'labRoute'];

  // Machine selects
  ['revMachine', 'expMachine'].forEach(id => {
    const el = $(id);
    if (!el) return;
    const isOptional = id !== 'revMachine';
    el.innerHTML = (isOptional ? '<option value="">— None —</option>' : '') +
      machines.map(m => `<option value="${m.id}">${m.name}</option>`).join('');
  });

  // Location selects
  ['mLocation', 'invoiceLocation', 'cLocation'].forEach(id => {
    const el = $(id);
    if (!el) return;
    el.innerHTML = locations.map(l => `<option value="${l.id}">${l.name}</option>`).join('');
  });

  ['expLocation'].forEach(id => {
    const el = $(id);
    if (!el) return;
    el.innerHTML = '<option value="">— None —</option>' +
      locations.map(l => `<option value="${l.id}">${l.name}</option>`).join('');
  });

  // Route selects
  routeSelects.forEach(id => {
    const el = $(id);
    if (!el) return;
    el.innerHTML = '<option value="">— None —</option>' +
      routes.map(r => `<option value="${r.id}">${r.name}</option>`).join('');
  });

  // Multi-select for route locations
  const rLocs = $('rLocations');
  if (rLocs) {
    rLocs.innerHTML = locations.map(l => `<option value="${l.id}">${l.name}</option>`).join('');
  }
}

// ============================================================
// REFRESH ALL
// ============================================================
async function refreshAll() {
  const p = currentPeriod;
  const [stats, comp, trend, byMachine, byLocation, byRoute, expBreakdown,
         profitLoc, profitRoute, machineROI, commCalc, commHistory,
         laborData, underperforming] = await Promise.all([
    api('/api/analytics/quick-stats'),
    api(`/api/analytics/period-comparison?period=${p}`),
    api(`/api/analytics/revenue-trend?period=${p}`),
    api(`/api/analytics/revenue-by-machine?period=${p}`),
    api(`/api/analytics/revenue-by-location?period=${p}`),
    api(`/api/analytics/revenue-by-route?period=${p}`),
    api(`/api/analytics/expense-breakdown?period=${p}`),
    api(`/api/analytics/profit-by-location?period=${p}`),
    api(`/api/analytics/profit-by-route?period=${p}`),
    api('/api/analytics/machine-roi'),
    api(`/api/analytics/commission-calc?period=${p}`),
    api('/api/commissions'),
    api(`/api/labor?period=${p}`),
    api('/api/analytics/underperforming')
  ]);

  renderQuickStats(stats, comp);
  renderAlerts(underperforming);
  renderRevenueTrend(trend);
  renderMachineRevenue(byMachine);
  renderLocationRevenue(byLocation);
  renderRouteRevenue(byRoute);
  renderCostBreakdown(expBreakdown);
  renderCOGS(byMachine);
  renderFuelCosts(byRoute);
  renderLaborTable(laborData);
  renderProfitLocation(profitLoc);
  renderProfitRoute(profitRoute);
  renderROI(machineROI);
  renderCommissionCalc(commCalc);
  renderCommissionHistory(commHistory);
  renderManageTables();
}

// ============================================================
// RENDER: Quick Stats
// ============================================================
function renderQuickStats(stats, comp) {
  $('statToday').textContent = fmt(stats.today_revenue);
  $('statMonth').textContent = fmt(stats.month_revenue);
  $('statAvg').textContent = fmt(stats.avg_per_machine);
  $('statMachineCount').textContent = `${stats.active_machines} active machines`;
  $('statBest').textContent = stats.best_machine.name;
  $('statBestAmt').textContent = fmt(stats.best_machine.total) + ' this month';
  $('statWorst').textContent = stats.worst_machine.name;
  $('statWorstAmt').textContent = fmt(stats.worst_machine.total) + ' this month';
  $('statMargin').textContent = pct(stats.profit_margin);
  $('statCosts').textContent = fmt(stats.total_costs) + ' total costs';

  const changeEl = $('periodComparison');
  if (comp.change_pct !== 0) {
    const up = comp.change_pct > 0;
    changeEl.className = 'change ' + (up ? 'up' : 'down');
    changeEl.textContent = `${up ? '▲' : '▼'} ${Math.abs(comp.change_pct)}% vs previous ${comp.period}`;
  } else {
    changeEl.textContent = '';
  }

  const card = $('statMonth').closest('.stat-card');
  if (comp.change_pct > 0) {
    $('statMonthChange').innerHTML = `<span class="text-green">▲ ${comp.change_pct}%</span> vs last ${comp.period}`;
  } else if (comp.change_pct < 0) {
    $('statMonthChange').innerHTML = `<span class="text-red">▼ ${Math.abs(comp.change_pct)}%</span> vs last ${comp.period}`;
  }
}

// ============================================================
// RENDER: Alerts
// ============================================================
function renderAlerts(underperforming) {
  const el = $('alertBanner');
  if (!underperforming.length) { el.innerHTML = ''; return; }
  el.innerHTML = underperforming.map(u =>
    `<div class="alert alert-warning">⚠️ <strong>${u.name}</strong> is underperforming: ${fmt(u.month_revenue)} / ${fmt(u.monthly_minimum)} minimum this month</div>`
  ).join('');
}

// ============================================================
// RENDER: Revenue Trend
// ============================================================
function renderRevenueTrend(trend) {
  if (charts.trend) charts.trend.destroy();
  const ctx = $('revenueTrendChart').getContext('2d');
  charts.trend = new Chart(ctx, {
    type: 'line',
    data: {
      labels: trend.map(r => r.date),
      datasets: [{
        label: 'Daily Revenue',
        data: trend.map(r => r.total),
        borderColor: '#6c5ce7',
        backgroundColor: 'rgba(108,92,231,0.1)',
        fill: true,
        tension: 0.3,
        pointRadius: 2,
        pointHoverRadius: 5
      }]
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { color: 'rgba(42,45,58,0.5)' }, ticks: { color: '#8b8da3', maxTicksLimit: 15 } },
        y: { grid: { color: 'rgba(42,45,58,0.5)' }, ticks: { color: '#8b8da3', callback: v => '$' + v } }
      }
    }
  });
}

// ============================================================
// RENDER: Revenue by Machine
// ============================================================
function renderMachineRevenue(data) {
  // Bar chart
  if (charts.machineBar) charts.machineBar.destroy();
  const ctx = $('machineBarChart').getContext('2d');
  const colors = ['#6c5ce7', '#a29bfe', '#74b9ff', '#00b894', '#ffd93d', '#ff6b6b', '#fd79a8', '#00cec9'];
  charts.machineBar = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: data.map(r => r.name),
      datasets: [{
        label: 'Revenue',
        data: data.map(r => r.total),
        backgroundColor: data.map((_, i) => colors[i % colors.length]),
        borderRadius: 6
      }]
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { display: false }, ticks: { color: '#8b8da3' } },
        y: { grid: { color: 'rgba(42,45,58,0.5)' }, ticks: { color: '#8b8da3', callback: v => '$' + v } }
      }
    }
  });

  // Table
  $('machineRevenueTable').innerHTML = data.map(r =>
    `<tr><td>${r.name}</td><td class="text-right">${fmt(r.total)}</td></tr>`
  ).join('') || '<tr><td colspan="2" class="text-muted">No data</td></tr>';
}

// ============================================================
// RENDER: Revenue by Location
// ============================================================
function renderLocationRevenue(data) {
  $('locationRevenueTable').innerHTML = data.map(r => {
    const badge = r.underperforming
      ? '<span class="badge badge-red">Below Min</span>'
      : '<span class="badge badge-green">On Track</span>';
    return `<tr>
      <td>${r.name}</td>
      <td class="text-right">${fmt(r.total)}</td>
      <td class="text-right">${fmt(r.monthly_minimum)}</td>
      <td>${badge}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="4" class="text-muted">No data</td></tr>';
}

// ============================================================
// RENDER: Revenue by Route
// ============================================================
function renderRouteRevenue(data) {
  $('routeRevenueTable').innerHTML = data.map(r =>
    `<tr><td>${r.name}</td><td>${r.driver || '—'}</td><td class="text-right">${fmt(r.total)}</td></tr>`
  ).join('') || '<tr><td colspan="3" class="text-muted">No data</td></tr>';
}

// ============================================================
// RENDER: Cost Breakdown
// ============================================================
function renderCostBreakdown(data) {
  const total = data.reduce((s, r) => s + r.total, 0);

  // Pie chart
  if (charts.costPie) charts.costPie.destroy();
  const ctx = $('costPieChart').getContext('2d');
  const colors = ['#6c5ce7', '#ff6b6b', '#ffd93d', '#00b894', '#74b9ff', '#fd79a8', '#00cec9', '#a29bfe'];
  charts.costPie = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: data.map(r => r.category),
      datasets: [{
        data: data.map(r => r.total),
        backgroundColor: data.map((_, i) => colors[i % colors.length]),
        borderWidth: 0
      }]
    },
    options: {
      responsive: true,
      plugins: {
        legend: { position: 'right', labels: { color: '#8b8da3', padding: 15 } }
      }
    }
  });

  // Table
  $('costBreakdownTable').innerHTML = data.map(r =>
    `<tr><td>${r.category}</td><td class="text-right">${fmt(r.total)}</td><td class="text-right">${total > 0 ? pct(r.total / total * 100) : '0%'}</td></tr>`
  ).join('') || '<tr><td colspan="3" class="text-muted">No data</td></tr>';
}

// ============================================================
// RENDER: COGS table (product costs per machine)
// ============================================================
function renderCOGS(machineData) {
  // We'll show each machine and fetch their COGS from expenses
  $('cogsTable').innerHTML = machineData.map(m => {
    const loc = locations.find(l => {
      const mach = machines.find(mm => mm.id === m.id);
      return mach && l.id === mach.location_id;
    });
    return `<tr><td>${m.name}</td><td>${loc ? loc.name : '—'}</td><td class="text-right">—</td></tr>`;
  }).join('') || '<tr><td colspan="3" class="text-muted">No machines</td></tr>';

  // Update with actual COGS data
  api(`/api/expenses?category=COGS&period=${currentPeriod}`).then(expenses => {
    const byMachine = {};
    expenses.forEach(e => {
      if (e.machine_id) {
        byMachine[e.machine_id] = (byMachine[e.machine_id] || 0) + e.amount;
      }
    });
    $('cogsTable').innerHTML = machines.map(m => {
      const loc = locations.find(l => l.id === m.location_id);
      return `<tr><td>${m.name}</td><td>${loc ? loc.name : '—'}</td><td class="text-right">${fmt(byMachine[m.id] || 0)}</td></tr>`;
    }).join('') || '<tr><td colspan="3" class="text-muted">No machines</td></tr>';
  });
}

// ============================================================
// RENDER: Fuel Costs
// ============================================================
function renderFuelCosts(routeData) {
  api(`/api/expenses?category=Fuel&period=${currentPeriod}`).then(expenses => {
    const byRoute = {};
    expenses.forEach(e => {
      if (e.route_id) {
        byRoute[e.route_id] = (byRoute[e.route_id] || 0) + e.amount;
      }
    });
    $('fuelTable').innerHTML = routes.map(r =>
      `<tr><td>${r.name}</td><td>${r.driver || '—'}</td><td class="text-right">${fmt(byRoute[r.id] || 0)}</td></tr>`
    ).join('') || '<tr><td colspan="3" class="text-muted">No routes</td></tr>';
  });
}

// ============================================================
// RENDER: Labor Table
// ============================================================
function renderLaborTable(data) {
  $('laborTable').innerHTML = data.map(l =>
    `<tr>
      <td>${l.worker_name}</td>
      <td>${l.role}</td>
      <td class="text-right">${l.hours.toFixed(1)}</td>
      <td class="text-right">${fmt(l.rate)}/hr</td>
      <td class="text-right">${fmt(l.hours * l.rate)}</td>
      <td>${l.date}</td>
    </tr>`
  ).join('') || '<tr><td colspan="6" class="text-muted">No labor logs</td></tr>';
}

// ============================================================
// RENDER: Profit by Location
// ============================================================
function renderProfitLocation(data) {
  // Chart
  if (charts.locationProfit) charts.locationProfit.destroy();
  const ctx = $('locationProfitChart').getContext('2d');
  charts.locationProfit = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: data.map(r => r.name),
      datasets: [
        { label: 'Revenue', data: data.map(r => r.revenue), backgroundColor: '#6c5ce7', borderRadius: 6 },
        { label: 'Expenses', data: data.map(r => r.expenses), backgroundColor: '#ff6b6b', borderRadius: 6 },
        { label: 'Commission', data: data.map(r => r.commission), backgroundColor: '#ffd93d', borderRadius: 6 },
        { label: 'Gross Profit', data: data.map(r => r.gross_profit), backgroundColor: '#00b894', borderRadius: 6 }
      ]
    },
    options: {
      responsive: true,
      plugins: { legend: { labels: { color: '#8b8da3' } } },
      scales: {
        x: { grid: { display: false }, ticks: { color: '#8b8da3' } },
        y: { grid: { color: 'rgba(42,45,58,0.5)' }, ticks: { color: '#8b8da3', callback: v => '$' + v } }
      }
    }
  });

  // Table
  $('profitLocationTable').innerHTML = data.map(r => {
    const marginClass = r.gross_margin >= 50 ? 'text-green' : r.gross_margin >= 25 ? 'text-yellow' : 'text-red';
    const statusBadge = r.underperforming
      ? '<span class="badge badge-red">⚠️ Below $2K</span>'
      : '<span class="badge badge-green">✓ Healthy</span>';
    return `<tr>
      <td>${r.name}</td>
      <td class="text-right">${fmt(r.revenue)}</td>
      <td class="text-right">${fmt(r.expenses)}</td>
      <td class="text-right">${fmt(r.commission)}</td>
      <td class="text-right">${fmt(r.gross_profit)}</td>
      <td class="text-right ${marginClass}">${pct(r.gross_margin)}</td>
      <td>${statusBadge}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="7" class="text-muted">No data</td></tr>';
}

// ============================================================
// RENDER: Profit by Route
// ============================================================
function renderProfitRoute(data) {
  $('profitRouteTable').innerHTML = data.map(r => {
    const marginClass = r.net_margin >= 50 ? 'text-green' : r.net_margin >= 25 ? 'text-yellow' : 'text-red';
    return `<tr>
      <td>${r.name}</td>
      <td>${r.driver || '—'}</td>
      <td class="text-right">${fmt(r.revenue)}</td>
      <td class="text-right">${fmt(r.expenses)}</td>
      <td class="text-right">${fmt(r.labor_cost)}</td>
      <td class="text-right">${fmt(r.net_profit)}</td>
      <td class="text-right ${marginClass}">${pct(r.net_margin)}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="7" class="text-muted">No data</td></tr>';
}

// ============================================================
// RENDER: ROI
// ============================================================
function renderROI(data) {
  // Chart
  if (charts.roi) charts.roi.destroy();
  const ctx = $('roiChart').getContext('2d');
  charts.roi = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: data.map(r => r.name),
      datasets: [
        { label: 'Purchase Cost', data: data.map(r => r.purchase_cost), backgroundColor: 'rgba(255,107,107,0.6)', borderRadius: 6 },
        { label: 'Net Profit', data: data.map(r => Math.max(0, r.net_profit)), backgroundColor: 'rgba(0,184,148,0.6)', borderRadius: 6 }
      ]
    },
    options: {
      responsive: true,
      plugins: { legend: { labels: { color: '#8b8da3' } } },
      scales: {
        x: { grid: { display: false }, ticks: { color: '#8b8da3' } },
        y: { grid: { color: 'rgba(42,45,58,0.5)' }, ticks: { color: '#8b8da3', callback: v => '$' + v } }
      }
    }
  });

  // Table
  $('roiTable').innerHTML = data.map(r => {
    const roiClass = r.roi_pct >= 100 ? 'text-green' : r.roi_pct >= 50 ? 'text-yellow' : 'text-red';
    const beText = r.paid_off ? '✅ Paid Off' : (r.break_even_months_remaining !== null ? `${r.break_even_months_remaining} months` : 'N/A');
    const statusBadge = r.paid_off
      ? '<span class="badge badge-green">ROI+</span>'
      : '<span class="badge badge-yellow">Paying Off</span>';
    return `<tr>
      <td>${r.name}</td>
      <td class="text-right">${fmt(r.purchase_cost)}</td>
      <td class="text-right">${fmt(r.cumulative_revenue)}</td>
      <td class="text-right">${fmt(r.cumulative_expenses)}</td>
      <td class="text-right">${fmt(r.net_profit)}</td>
      <td class="text-right ${roiClass}">${pct(r.roi_pct)}</td>
      <td class="text-right">${beText}</td>
      <td>${statusBadge}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="8" class="text-muted">No machines</td></tr>';
}

// ============================================================
// RENDER: Commission Calculator
// ============================================================
function renderCommissionCalc(data) {
  // Chart
  if (charts.commission) charts.commission.destroy();
  const ctx = $('commissionChart').getContext('2d');
  charts.commission = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: data.map(r => r.name),
      datasets: [
        { label: 'Revenue', data: data.map(r => r.revenue), backgroundColor: '#6c5ce7', borderRadius: 6 },
        { label: 'Commission Due', data: data.map(r => r.commission_due), backgroundColor: '#ffd93d', borderRadius: 6 }
      ]
    },
    options: {
      responsive: true,
      plugins: { legend: { labels: { color: '#8b8da3' } } },
      scales: {
        x: { grid: { display: false }, ticks: { color: '#8b8da3' } },
        y: { grid: { color: 'rgba(42,45,58,0.5)' }, ticks: { color: '#8b8da3', callback: v => '$' + v } }
      }
    }
  });

  const totalComm = data.reduce((s, r) => s + r.commission_due, 0);
  $('commissionCalcTable').innerHTML = data.map(r =>
    `<tr>
      <td>${r.name}</td>
      <td class="text-right">${pct(r.rev_share_pct)}</td>
      <td class="text-right">${fmt(r.revenue)}</td>
      <td class="text-right text-yellow">${fmt(r.commission_due)}</td>
    </tr>`
  ).join('') +
  `<tr style="font-weight:700;border-top:2px solid var(--border);">
    <td colspan="3">Total Commission Due</td>
    <td class="text-right text-yellow">${fmt(totalComm)}</td>
  </tr>`;
}

// ============================================================
// RENDER: Commission History
// ============================================================
function renderCommissionHistory(data) {
  $('commissionHistoryTable').innerHTML = data.map(r => {
    const badge = r.status === 'paid'
      ? '<span class="badge badge-green">Paid</span>'
      : '<span class="badge badge-yellow">Pending</span>';
    return `<tr>
      <td>${r.location_name || 'Unknown'}</td>
      <td>${r.period_start} — ${r.period_end}</td>
      <td class="text-right">${fmt(r.amount)}</td>
      <td>${badge}</td>
      <td>${r.paid_date || '—'}</td>
      <td>
        ${r.status === 'pending' ? `<button class="btn btn-sm btn-primary" onclick="markCommissionPaid('${r.id}')">Mark Paid</button>` : ''}
      </td>
    </tr>`;
  }).join('') || '<tr><td colspan="6" class="text-muted">No commission records</td></tr>';
}

// ============================================================
// RENDER: Manage Tables
// ============================================================
function renderManageTables() {
  // Machines
  $('machinesTable').innerHTML = machines.map(m => {
    const loc = locations.find(l => l.id === m.location_id);
    return `<tr>
      <td>${m.name}</td>
      <td>${m.type}</td>
      <td>${loc ? loc.name : '—'}</td>
      <td class="text-right">${fmt(m.purchase_cost)}</td>
      <td>${m.install_date || '—'}</td>
      <td><span class="badge ${m.status === 'active' ? 'badge-green' : 'badge-red'}">${m.status}</span></td>
      <td><button class="btn btn-sm btn-danger" onclick="deleteMachine('${m.id}')">Delete</button></td>
    </tr>`;
  }).join('') || '<tr><td colspan="7" class="text-muted">No machines</td></tr>';

  // Locations
  $('locationsTable').innerHTML = locations.map(l =>
    `<tr>
      <td>${l.name}</td>
      <td>${l.address || '—'}</td>
      <td>${l.contact_name || '—'}</td>
      <td class="text-right">${pct(l.rev_share_pct)}</td>
      <td class="text-right">${fmt(l.monthly_minimum)}</td>
      <td><button class="btn btn-sm btn-danger" onclick="deleteLocation('${l.id}')">Delete</button></td>
    </tr>`
  ).join('') || '<tr><td colspan="6" class="text-muted">No locations</td></tr>';

  // Routes
  $('routesTable').innerHTML = routes.map(r => {
    const locNames = (r.location_ids || []).map(lid => {
      const l = locations.find(loc => loc.id === lid);
      return l ? l.name : lid;
    }).join(', ');
    return `<tr>
      <td>${r.name}</td>
      <td>${r.driver || '—'}</td>
      <td>${locNames || '—'}</td>
      <td><button class="btn btn-sm btn-danger" onclick="deleteRoute('${r.id}')">Delete</button></td>
    </tr>`;
  }).join('') || '<tr><td colspan="4" class="text-muted">No routes</td></tr>';
}

// ============================================================
// ACTIONS: Revenue
// ============================================================
async function addRevenue() {
  const machine_id = $('revMachine').value;
  const amount = parseFloat($('revAmount').value);
  const date = $('revDate').value;
  const notes = $('revNotes').value;
  if (!machine_id || !amount || !date) return alert('Fill in machine, amount, and date');
  await api('/api/revenue', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ machine_id, amount, date, notes })
  });
  $('revAmount').value = '';
  $('revNotes').value = '';
  refreshAll();
}

// ============================================================
// ACTIONS: Expenses
// ============================================================
async function addExpense() {
  const category = $('expCategory').value;
  const amount = parseFloat($('expAmount').value);
  const date = $('expDate').value;
  if (!amount || !date) return alert('Fill in amount and date');
  await api('/api/expenses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      category, amount, date,
      machine_id: $('expMachine').value || null,
      route_id: $('expRoute').value || null,
      location_id: $('expLocation').value || null,
      description: $('expDesc').value || null
    })
  });
  $('expAmount').value = '';
  $('expDesc').value = '';
  refreshAll();
}

// ============================================================
// ACTIONS: Labor
// ============================================================
async function addLabor() {
  const worker_name = $('labWorker').value;
  const role = $('labRole').value;
  const hours = parseFloat($('labHours').value);
  const rate = parseFloat($('labRate').value);
  const date = $('labDate').value;
  if (!worker_name || !hours || !rate || !date) return alert('Fill in all required fields');
  await api('/api/labor', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      worker_name, role, hours, rate, date,
      route_id: $('labRoute').value || null
    })
  });
  $('labWorker').value = '';
  $('labHours').value = '';
  refreshAll();
}

// ============================================================
// ACTIONS: Machines, Locations, Routes CRUD
// ============================================================
function openModal(id) { $(id).classList.add('open'); }
function closeModal(id) { $(id).classList.remove('open'); }

function openAddMachine() { openModal('modalMachine'); }
function openAddLocation() { openModal('modalLocation'); }
function openAddRoute() { openModal('modalRoute'); }
function openRecordCommission() { openModal('modalCommission'); }

async function saveMachine() {
  const data = {
    name: $('mName').value,
    type: $('mType').value,
    location_id: $('mLocation').value,
    purchase_cost: parseFloat($('mCost').value) || 0,
    install_date: $('mDate').value || null
  };
  if (!data.name) return alert('Name required');
  await api('/api/machines', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  closeModal('modalMachine');
  $('mName').value = '';
  await loadBaseData();
  refreshAll();
}

async function saveLocation() {
  const data = {
    name: $('lName').value,
    address: $('lAddress').value,
    contact_name: $('lContact').value,
    contact_email: $('lEmail').value,
    contact_phone: $('lPhone').value,
    rev_share_pct: parseFloat($('lRevShare').value) || 0,
    monthly_minimum: parseFloat($('lMinimum').value) || 2000
  };
  if (!data.name) return alert('Name required');
  await api('/api/locations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  closeModal('modalLocation');
  $('lName').value = '';
  $('lAddress').value = '';
  await loadBaseData();
  refreshAll();
}

async function saveRoute() {
  const locSelect = $('rLocations');
  const location_ids = Array.from(locSelect.selectedOptions).map(o => o.value);
  const data = { name: $('rName').value, driver: $('rDriver').value, location_ids };
  if (!data.name) return alert('Name required');
  await api('/api/routes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  closeModal('modalRoute');
  $('rName').value = '';
  await loadBaseData();
  refreshAll();
}

async function deleteMachine(id) {
  if (!confirm('Delete this machine?')) return;
  await api(`/api/machines/${id}`, { method: 'DELETE' });
  await loadBaseData();
  refreshAll();
}

async function deleteLocation(id) {
  if (!confirm('Delete this location?')) return;
  await api(`/api/locations/${id}`, { method: 'DELETE' });
  await loadBaseData();
  refreshAll();
}

async function deleteRoute(id) {
  if (!confirm('Delete this route?')) return;
  await api(`/api/routes/${id}`, { method: 'DELETE' });
  await loadBaseData();
  refreshAll();
}

// ============================================================
// ACTIONS: Commissions
// ============================================================
async function saveCommission() {
  const data = {
    location_id: $('cLocation').value,
    amount: parseFloat($('cAmount').value),
    period_start: $('cStart').value,
    period_end: $('cEnd').value,
    status: $('cStatus').value,
    notes: $('cNotes').value
  };
  if (!data.location_id || !data.amount || !data.period_start || !data.period_end) return alert('Fill all required fields');
  await api('/api/commissions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  closeModal('modalCommission');
  refreshAll();
}

async function markCommissionPaid(id) {
  const today = new Date().toISOString().split('T')[0];
  await api(`/api/commissions/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'paid', paid_date: today })
  });
  refreshAll();
}

// ============================================================
// INVOICE GENERATOR
// ============================================================
async function generateInvoice() {
  const location_id = $('invoiceLocation').value;
  const period_start = $('invoiceStart').value;
  const period_end = $('invoiceEnd').value;
  if (!location_id || !period_start || !period_end) return alert('Select location and date range');

  const invoice = await api(`/api/invoice/${location_id}?period_start=${period_start}&period_end=${period_end}`);

  const preview = $('invoicePreview');
  preview.style.display = 'block';
  preview.innerHTML = `
    <div class="card" style="max-width:700px;">
      <div class="flex justify-between items-center mb-2">
        <div>
          <h2 style="color:var(--accent-light);">🏪 Kandé VendTech</h2>
          <p class="text-muted">Commission Statement</p>
        </div>
        <div class="text-right">
          <div class="text-muted">Invoice #</div>
          <div style="font-weight:700;">${invoice.invoice_number}</div>
          <div class="text-muted mt-1">Date: ${invoice.date}</div>
        </div>
      </div>

      <div style="border-top:1px solid var(--border);padding-top:1rem;margin-bottom:1rem;">
        <div class="text-muted" style="font-size:0.8rem;">BILL TO</div>
        <div style="font-weight:600;">${invoice.location.name}</div>
        <div class="text-muted">${invoice.location.address || ''}</div>
        ${invoice.location.contact_name ? `<div class="text-muted">${invoice.location.contact_name}</div>` : ''}
      </div>

      <div class="text-muted mb-1">Period: ${invoice.period.start} — ${invoice.period.end}</div>

      <div class="table-wrap">
        <table>
          <thead><tr><th>Date</th><th>Machine</th><th class="text-right">Amount</th></tr></thead>
          <tbody>
            ${invoice.line_items.map(li =>
              `<tr><td>${li.date}</td><td>${li.machine_name}</td><td class="text-right">${fmt(li.amount)}</td></tr>`
            ).join('')}
          </tbody>
        </table>
      </div>

      <div style="border-top:2px solid var(--border);margin-top:1rem;padding-top:1rem;">
        <div class="flex justify-between"><span>Total Revenue</span><span>${fmt(invoice.total_revenue)}</span></div>
        <div class="flex justify-between"><span>Rev Share (${invoice.rev_share_pct}%)</span><span>${fmt(invoice.commission_due)}</span></div>
        <div class="flex justify-between mt-1" style="font-size:1.2rem;font-weight:700;color:var(--accent-light);">
          <span>Commission Due</span><span>${fmt(invoice.commission_due)}</span>
        </div>
      </div>

      <div class="flex gap-1 mt-2 no-print">
        <button class="btn btn-primary" onclick="window.print()">🖨️ Print Invoice</button>
      </div>
    </div>
  `;
}

// ============================================================
// SEED DATA
// ============================================================
async function seedData() {
  const result = await api('/api/seed', { method: 'POST' });
  alert(result.msg);
  await loadBaseData();
  refreshAll();
}
