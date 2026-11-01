// =====================================================================
//  App entry point: login screen, top bar, keyboard shortcuts, render loop
// =====================================================================
import { api, setUnauthorizedHandler } from './api.js';
import { state, subscribe, notify, hasRole, currentOrg } from './store.js';
import { toast, safely, avatarHtml, escapeHtml, modal } from './ui.js';
import { undo, redo, canUndo, canRedo } from './history.js';
import * as loaders from './loaders.js';
import * as actions from './actions.js';
import { connectSocket } from './realtime.js';
import { initBoard, renderBoard } from './board.js';
import { initTaskPanel, refreshPanel, closeTask } from './taskPanel.js';
import { renderActivity, openMembersDialog } from './panels.js';

const $ = (id) => document.getElementById(id);

// ---------------- login / register ----------------

function showLogin() {
  $('app-view').classList.add('hidden');
  $('login-view').classList.remove('hidden');
}

async function afterLogin({ token }) {
  state.token = token;
  localStorage.setItem('tb_token', token);
  await startApp();
}

$('login-form').addEventListener('submit', (e) => {
  e.preventDefault();
  safely(async () => afterLogin(await api.post('/auth/login', {
    email: $('login-email').value, password: $('login-password').value,
  })));
});

$('register-form').addEventListener('submit', (e) => {
  e.preventDefault();
  safely(async () => afterLogin(await api.post('/auth/register', {
    name: $('reg-name').value, email: $('reg-email').value, password: $('reg-password').value,
  })));
});

$('toggle-register').addEventListener('click', (e) => {
  e.preventDefault();
  const registering = $('register-form').classList.toggle('hidden') === false;
  $('login-form').classList.toggle('hidden', registering);
  e.target.textContent = registering ? 'Already have an account? Log in' : 'New here? Create an account';
});

// demo buttons just fill in the form and log in
document.querySelectorAll('.demo').forEach((btn) => {
  btn.addEventListener('click', () => {
    $('login-email').value = btn.dataset.email;
    $('login-password').value = 'password123';
    $('login-form').requestSubmit();
  });
});

// ---------------- top bar ----------------

// only rebuild a <select> when its options actually changed (keeps it usable)
function setOptions(select, items, value) {
  const signature = JSON.stringify(items);
  if (select.dataset.sig !== signature) {
    select.innerHTML = items.length
      ? items.map((i) => `<option value="${i.id}">${escapeHtml(i.name)}</option>`).join('')
      : '<option value="">—</option>';
    select.dataset.sig = signature;
  }
  select.value = value ?? '';
}

function renderTopbar() {
  const org = currentOrg();
  setOptions($('org-select'), state.orgs.map((o) => ({ id: o.id, name: o.name })), state.orgId);
  setOptions($('tenant-select'), (org?.tenants || []).map((t) => ({ id: t.id, name: t.name })), state.tenantId);
  setOptions($('board-select'), state.boards.map((b) => ({ id: b.id, name: b.name })), state.boardId);

  // hide buttons the role isn't allowed to use (the server checks again anyway!)
  document.querySelectorAll('.admin-org').forEach((el) => el.classList.toggle('hidden', !org?.isOrgAdmin));
  document.querySelectorAll('.admin-tenant').forEach((el) => el.classList.toggle('hidden', !hasRole('TENANT_ADMIN')));
  $('board-menu-btn').classList.toggle('hidden', !hasRole('TENANT_ADMIN') || !state.board);

  $('undo-btn').disabled = !canUndo();
  $('redo-btn').disabled = !canRedo();
  $('me-name').textContent = state.user?.name || '';
  $('role-badge').textContent = state.role ? state.role.replace('_', ' ') : '';

  // presence: who's online in this branch (me first)
  const people = [...state.presence].sort((a, b) => (b.userId === state.user?.id) - (a.userId === state.user?.id));
  $('presence').innerHTML = people.map((p) => {
    const board = state.boards.find((b) => b.id === p.boardId);
    return avatarHtml({ ...p, name: `${p.name}${p.userId === state.user?.id ? ' (you)' : ''}${board ? ` - on ${board.name}` : ''}` });
  }).join('');

  $('conn-status').className = `conn-status ${state.connection}`;
  $('conn-status').title = { online: 'Live', offline: 'Offline', reconnecting: 'Reconnecting…' }[state.connection] || state.connection;
  $('offline-banner').classList.toggle('hidden', state.connection === 'online' || state.connection === 'connecting');
}

$('org-select').addEventListener('change', (e) => safely(() => loaders.selectOrg(Number(e.target.value))));
$('tenant-select').addEventListener('change', (e) => safely(() => loaders.selectTenant(Number(e.target.value))));
$('board-select').addEventListener('change', (e) => safely(() => loaders.selectBoard(Number(e.target.value))));

$('new-org-btn').addEventListener('click', () => safely(async () => {
  const org = await actions.createOrg();
  if (!org) return;
  await loaders.loadMe();
  await loaders.selectOrg(org.id);
}));

$('new-tenant-btn').addEventListener('click', () => safely(async () => {
  const tenant = await actions.createTenant();
  if (!tenant) return;
  await loaders.loadMe();
  await loaders.selectTenant(tenant.id);
}));

$('new-board-btn').addEventListener('click', () => safely(async () => {
  const board = await actions.createBoard();
  if (board) await loaders.selectBoard(board.id);
}));

$('board-menu-btn').addEventListener('click', () => safely(async () => {
  const choice = await modal({
    title: `Board: ${state.board?.name}`,
    body: '<p>What do you want to do with this board?</p>',
    buttons: [{ label: 'Delete board', value: 'delete', kind: 'danger' }, { label: 'Rename', value: 'rename', kind: 'primary' }],
  });
  if (choice === 'rename') await actions.renameBoard();
  if (choice === 'delete' && await actions.deleteBoard()) {
    state.boards = state.boards.filter((b) => b.id !== state.boardId);
    await loaders.selectBoard(state.boards[0]?.id ?? null);
  }
}));

$('undo-btn').addEventListener('click', undo);
$('redo-btn').addEventListener('click', redo);
$('members-btn').addEventListener('click', () => state.tenantId && openMembersDialog());
$('activity-btn').addEventListener('click', () => {
  $('activity-panel').classList.toggle('hidden');
  closeTask();
  notify();
});
$('activity-close').addEventListener('click', () => $('activity-panel').classList.add('hidden'));
$('logout-btn').addEventListener('click', loaders.logout);

// ---------------- keyboard shortcuts ----------------
document.addEventListener('keydown', (e) => {
  const typing = e.target.matches('input, textarea, select');
  if (e.key === 'Escape' && !document.querySelector('.modal-overlay')) closeTask();
  if (typing || !(e.ctrlKey || e.metaKey)) return;
  const key = e.key.toLowerCase();
  if (key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
  if (key === 'y' || (key === 'z' && e.shiftKey)) { e.preventDefault(); redo(); }
});

// ---------------- start ----------------

async function startApp() {
  $('login-view').classList.add('hidden');
  $('app-view').classList.remove('hidden');
  await loaders.loadMe();
  connectSocket();
  const savedOrg = Number(localStorage.getItem('tb_org'));
  const org = state.orgs.find((o) => o.id === savedOrg) || state.orgs[0];
  await loaders.selectOrg(org?.id ?? null);
  if (!org) toast('You are not in any organization yet - create one with ＋ or ask an admin to add you', 'info', 6000);
}

setUnauthorizedHandler(() => {
  toast('Session expired, please log in again', 'warn');
  setTimeout(loaders.logout, 1200);
});

initBoard();
initTaskPanel();

// the one render loop: any state change -> redraw what depends on it
subscribe(() => {
  renderTopbar();
  renderBoard();
  renderActivity();
  refreshPanel();
});

// refresh the "2m ago" labels now and then
setInterval(() => renderActivity(), 30000);

if (state.token) {
  startApp().catch(() => showLogin());
} else {
  showLogin();
}
