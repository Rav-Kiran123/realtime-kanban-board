// Loading data + switching org / branch / board.
// Every loader remembers which branch/board it was started for and throws the
// result away if the user switched in the meantime (no stale data on screen).
import { api } from './api.js';
import { state, notify, currentOrg, currentTenant } from './store.js';
import { joinTenant, leaveTenant, sendPresence, disconnectSocket } from './realtime.js';
import { clearHistory } from './history.js';
import { closeTask } from './taskPanel.js';

const save = (key, value) => localStorage.setItem(key, String(value));
const load = (key) => Number(localStorage.getItem(key)) || null;

export async function loadMe() {
  const data = await api.get('/auth/me');
  state.user = data.user;
  state.orgs = data.orgs;
  notify();
}

export async function selectOrg(orgId) {
  state.orgId = orgId;
  if (orgId) save('tb_org', orgId);
  const org = currentOrg();
  const savedTenant = load(`tb_tenant_${orgId}`);
  const tenant = org?.tenants.find((t) => t.id === savedTenant) || org?.tenants[0];
  await selectTenant(tenant?.id ?? null);
}

export async function selectTenant(tenantId) {
  closeTask();
  clearHistory();
  // wipe everything from the previous branch FIRST - nothing may leak across
  Object.assign(state, {
    tenantId, role: null, boards: [], boardId: null, board: null, columns: [], tasks: {},
    members: [], presence: [], activity: [], loadingTenant: !!tenantId,
  });
  notify();
  if (!tenantId) { leaveTenant(); return; }

  save(`tb_tenant_${state.orgId}`, tenantId);
  state.role = currentTenant()?.role ?? null;

  await joinTenant(tenantId);
  await Promise.all([loadBoards(), loadMembers()]);
  if (state.tenantId !== tenantId) return; // user already switched again
  state.loadingTenant = false; // now "No boards yet" really means no boards

  const savedBoard = load(`tb_board_${tenantId}`);
  const board = state.boards.find((b) => b.id === savedBoard) || state.boards[0];
  await selectBoard(board?.id ?? null);
}

export async function selectBoard(boardId) {
  closeTask();
  clearHistory(); // undo only makes sense inside one board
  Object.assign(state, { boardId, board: null, columns: [], tasks: {} });
  notify();
  if (boardId) save(`tb_board_${state.tenantId}`, boardId);
  sendPresence({ focusTaskId: null });
  await Promise.all([loadBoard(), loadActivity()]);
}

export async function loadBoards() {
  const tenantId = state.tenantId;
  const { boards } = await api.get(`/tenants/${tenantId}/boards`);
  if (state.tenantId !== tenantId) return;
  state.boards = boards;
  notify();
}

export async function loadBoard() {
  const { tenantId, boardId } = state;
  if (!tenantId || !boardId) return;
  const data = await api.get(`/tenants/${tenantId}/boards/${boardId}`);
  if (state.tenantId !== tenantId || state.boardId !== boardId) return; // stale
  state.board = data.board;
  state.columns = data.columns;
  state.tasks = Object.fromEntries(data.tasks.map((t) => [t.id, t]));
  notify();
}

export async function loadMembers() {
  const tenantId = state.tenantId;
  if (!tenantId) return;
  const { members } = await api.get(`/tenants/${tenantId}/members`);
  if (state.tenantId !== tenantId) return;
  state.members = members;
  notify();
}

export async function loadActivity() {
  const { tenantId, boardId } = state;
  if (!tenantId) return;
  const query = boardId ? `?boardId=${boardId}&limit=50` : '?limit=50';
  const { activity } = await api.get(`/tenants/${tenantId}/activity${query}`);
  if (state.tenantId !== tenantId || state.boardId !== boardId) return;
  state.activity = activity;
  notify();
}

// after reconnecting: reload everything for the current branch/board
export async function resyncTenant() {
  await Promise.all([loadBoards(), loadMembers(), loadBoard(), loadActivity()]);
}

// my memberships changed (added/removed/kicked/branch deleted) -> refresh selectors
export async function refreshAccess() {
  await loadMe();
  const org = currentOrg();
  if (!org) return selectOrg(state.orgs[0]?.id ?? null);
  const tenant = currentTenant();
  if (!tenant) return selectOrg(org.id);  // lost access to this branch
  if (tenant.role !== state.role) {       // role changed -> update permissions in UI
    state.role = tenant.role;
    notify();
  }
}

export function logout() {
  localStorage.removeItem('tb_token');
  disconnectSocket();
  location.reload();
}
