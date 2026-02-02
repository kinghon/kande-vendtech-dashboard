/**
 * Kandé VendTech Dashboard — Client-side JavaScript
 */

// ─── Modal Helpers ───────────────────────────────────────────────────────────
function showModal(id) {
  document.getElementById(id).style.display = 'flex';
}

function closeModal(id) {
  document.getElementById(id).style.display = 'none';
}

function showAddLeadModal() { showModal('add-lead-modal'); }
function showAddTaskModal() { showModal('add-task-modal'); }
function showAddMachineModal() { showModal('add-machine-modal'); }
function showAddProductModal() { showModal('add-product-modal'); }
function showCreateProposalModal() { showModal('create-proposal-modal'); }
function showAddEventModal() { showModal('add-event-modal'); }
function showAddRouteModal() { showModal('add-route-modal'); }

// Close modal on backdrop click
document.addEventListener('click', (e) => {
  if (e.target.classList.contains('modal')) {
    e.target.style.display = 'none';
  }
});

// ─── API Helper ──────────────────────────────────────────────────────────────
async function api(endpoint, method = 'GET', body = null) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);
  
  const res = await fetch(`/api/${endpoint}`, opts);
  const data = await res.json();
  
  if (!res.ok) {
    alert(`Error: ${data.error || 'Request failed'}`);
    throw new Error(data.error);
  }
  return data;
}

// ─── Lead Functions ──────────────────────────────────────────────────────────
async function submitLead(e) {
  e.preventDefault();
  const form = e.target;
  const data = Object.fromEntries(new FormData(form));
  
  await api('leads', 'POST', data);
  closeModal('add-lead-modal');
  location.reload();
}

async function editLead(id) {
  const { lead } = await api(`leads/${id}`);
  // Simple prompt-based edit for now
  const newStatus = prompt(`Current status: ${lead.status}\nEnter new status (new_lead, contacted, interested, meeting_scheduled, qualified, proposal_sent, negotiating, won, active, dead, lost):`, lead.status);
  if (newStatus && newStatus !== lead.status) {
    await api(`leads/${id}`, 'PUT', { status: newStatus });
    location.reload();
  }
}

async function archiveLead(id) {
  if (!confirm('Archive this lead?')) return;
  await api(`leads/${id}`, 'DELETE');
  location.reload();
}

function filterLeads(query) {
  const rows = document.querySelectorAll('#leads-table tbody tr');
  query = query.toLowerCase();
  rows.forEach(row => {
    const text = row.textContent.toLowerCase();
    row.style.display = text.includes(query) ? '' : 'none';
  });
}

function filterByStatus(status) {
  const rows = document.querySelectorAll('#leads-table tbody tr');
  rows.forEach(row => {
    if (!status) { row.style.display = ''; return; }
    row.style.display = row.dataset.status === status ? '' : 'none';
  });
}

// ─── Task Functions ──────────────────────────────────────────────────────────
async function submitTask(e) {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(e.target));
  await api('tasks', 'POST', data);
  closeModal('add-task-modal');
  location.reload();
}

async function completeTask(id) {
  await api(`tasks/${id}/complete`, 'PUT');
  location.reload();
}

// ─── Machine Functions ───────────────────────────────────────────────────────
async function submitMachine(e) {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(e.target));
  await api('machines', 'POST', data);
  closeModal('add-machine-modal');
  location.reload();
}

// ─── Product Functions ───────────────────────────────────────────────────────
async function submitProduct(e) {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(e.target));
  data.cost_price = parseFloat(data.cost_price) || 0;
  data.retail_price = parseFloat(data.retail_price) || 0;
  await api('products', 'POST', data);
  closeModal('add-product-modal');
  location.reload();
}

// ─── Proposal Functions ──────────────────────────────────────────────────────
async function submitProposal(e) {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(e.target));
  data.machine_count = parseInt(data.machine_count) || 1;
  data.revenue_share_pct = parseFloat(data.revenue_share_pct) || 5;
  data.contract_length_months = parseInt(data.contract_length_months) || 12;
  data.estimated_monthly_rev = parseFloat(data.estimated_monthly_rev) || 0;
  await api('proposals', 'POST', data);
  closeModal('create-proposal-modal');
  location.reload();
}

// ─── Schedule Functions ──────────────────────────────────────────────────────
async function submitEvent(e) {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(e.target));
  await api('schedule', 'POST', data);
  closeModal('add-event-modal');
  location.reload();
}

// ─── Route Functions ─────────────────────────────────────────────────────────
async function submitRoute(e) {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(e.target));
  if (data.estimated_duration_min) data.estimated_duration_min = parseInt(data.estimated_duration_min);
  if (data.estimated_miles) data.estimated_miles = parseFloat(data.estimated_miles);
  await api('routes', 'POST', data);
  closeModal('add-route-modal');
  location.reload();
}

// ─── Kanban Drag & Drop ─────────────────────────────────────────────────────
let draggedCard = null;

function dragStart(e) {
  draggedCard = e.target;
  e.dataTransfer.effectAllowed = 'move';
  e.target.style.opacity = '0.5';
}

document.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
});

document.addEventListener('drop', async (e) => {
  e.preventDefault();
  if (!draggedCard) return;
  
  const column = e.target.closest('.kanban-cards');
  if (!column) return;
  
  const newStatus = column.dataset.status;
  const leadId = draggedCard.dataset.id;
  
  if (leadId && newStatus) {
    try {
      await api(`leads/${leadId}`, 'PUT', { status: newStatus });
      location.reload();
    } catch (err) {
      console.error('Failed to update status:', err);
    }
  }
  
  draggedCard.style.opacity = '1';
  draggedCard = null;
});

document.addEventListener('dragend', () => {
  if (draggedCard) {
    draggedCard.style.opacity = '1';
    draggedCard = null;
  }
});

// ─── Init ────────────────────────────────────────────────────────────────────
console.log('🟠 Kandé VendTech Dashboard loaded');
