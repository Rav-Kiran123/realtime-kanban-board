// ===== A tiny global store =====
// Not Redux - just one object + a list of listeners. Any module changes
// `state` and then calls notify(); the UI re-renders on the next microtask
// (so 10 changes in a row only cause 1 render).

export const state = {
  token: localStorage.getItem('tb_token'),
  user: null,
  orgs: [],          // access tree from /auth/me
  orgId: null,
  tenantId: null,
  role: null,        // my role in the current branch
  boards: [],
  boardId: null,
  board: null,
  columns: [],
  tasks: {},         // id -> task (an object, so lookups are O(1))
  members: [],
  presence: [],
  activity: [],
  connection: 'connecting',
  dragging: false,   // while true the board doesn't re-render (it would cancel the drag)
};

const listeners = new Set();
let queued = false;

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function notify() {
  if (queued) return;
  queued = true;
  queueMicrotask(() => {
    queued = false;
    listeners.forEach((fn) => fn(state));
  });
}

// ---------- small selectors ----------
const ROLE_LEVEL = { MEMBER: 1, TENANT_ADMIN: 2, ORG_ADMIN: 3 };
export const hasRole = (minRole) => (ROLE_LEVEL[state.role] || 0) >= ROLE_LEVEL[minRole];
export const currentOrg = () => state.orgs.find((o) => o.id === state.orgId) || null;
export const currentTenant = () => currentOrg()?.tenants.find((t) => t.id === state.tenantId) || null;
export const memberById = (id) => state.members.find((m) => m.id === id) || null;
export const columnById = (id) => state.columns.find((c) => c.id === id) || null;

// order by position, ties broken by id (same as the server)
export function byPosition(a, b) {
  return a.position - b.position || (Number(a.id) || Infinity) - (Number(b.id) || Infinity);
}

export function tasksInColumn(columnId) {
  return Object.values(state.tasks).filter((t) => t.columnId === columnId).sort(byPosition);
}

export const sortedColumns = () => [...state.columns].sort(byPosition);

// same maths as server/services/ordering.js - used for the optimistic UI only.
// The server recalculates the real position from the neighbour ids.
export function localPosition(prevId, nextId) {
  const prev = prevId ? state.tasks[prevId] : null;
  const next = nextId ? state.tasks[nextId] : null;
  if (prev && next) return (prev.position + next.position) / 2;
  if (prev) return prev.position + 1024;
  if (next) return next.position - 1024;
  return 1024;
}

// ---------- mutations used by realtime + actions ----------

// Only accept a task if it's NEWER than what we have (version check).
// This also de-duplicates our own changes echoed back through the socket.
export function upsertTask(task) {
  if (task.boardId !== state.boardId) return;
  const local = state.tasks[task.id];
  if (local && local.version > task.version) return;
  state.tasks[task.id] = task;
  notify();
}

export function removeTask(id) {
  if (!state.tasks[id]) return;
  delete state.tasks[id];
  notify();
}

export function upsertColumn(column) {
  if (column.boardId !== state.boardId) return;
  const i = state.columns.findIndex((c) => c.id === column.id);
  if (i === -1) state.columns.push(column);
  else if (state.columns[i].version <= column.version) state.columns[i] = column;
  notify();
}

export function upsertBoard(board) {
  const i = state.boards.findIndex((b) => b.id === board.id);
  if (i === -1) state.boards.push(board);
  else state.boards[i] = board;
  if (state.board?.id === board.id) state.board = board;
  notify();
}

// clientKeys of tasks I'm creating right now (to ignore my own socket echo)
export const pendingCreates = new Set();
