// =====================================================================
//  Socket.IO client
//  - joins ONE branch room at a time
//  - applies events from other users to the store
//  - network recovery: after a reconnect we re-join and re-download the
//    board, because we may have missed events while offline
// =====================================================================
import {
  state, notify, upsertTask, removeTask, upsertColumn, upsertBoard, pendingCreates,
} from './store.js';
import { toast } from './ui.js';
import * as loaders from './loaders.js';
import { onTaskActivity } from './taskPanel.js';

let socket = null;
let needsResync = false;
let focusTaskId = null; // which card I have open (for presence)

export function connectSocket() {
  // window.io comes from /socket.io/socket.io.js
  socket = window.io({ auth: { token: state.token }, reconnectionDelayMax: 5000 });

  socket.on('connect', async () => {
    state.connection = 'online';
    notify();
    if (!state.tenantId) return;
    await joinTenant(state.tenantId);
    if (needsResync) {
      needsResync = false;
      await loaders.resyncTenant();
      toast('Back online - board re-synced', 'success');
    }
  });

  socket.on('disconnect', () => {
    needsResync = true; // whatever happens while we're away we won't hear about
    state.connection = 'offline';
    notify();
  });

  socket.io.on('reconnect_attempt', () => {
    state.connection = 'reconnecting';
    notify();
  });

  socket.on('connect_error', (err) => {
    state.connection = 'offline';
    notify();
    if (err.message === 'UNAUTHORIZED') loaders.logout();
  });

  // ----- branch scoped events -----
  // Extra safety check: ignore anything that isn't for the branch on screen
  // (e.g. an event that was already in flight while switching branch).
  const onTenant = (event, handler) => {
    socket.on(event, (payload) => {
      if (payload?.tenantId !== state.tenantId) return;
      handler(payload);
    });
  };

  onTenant('task:created', ({ task, clientKey }) => {
    if (clientKey && pendingCreates.has(clientKey)) return; // my own card, the HTTP response handles it
    upsertTask(task);
  });
  onTenant('task:updated', ({ task }) => upsertTask(task));
  onTenant('task:moved', ({ task }) => upsertTask(task));
  onTenant('task:restored', ({ task }) => upsertTask(task));
  onTenant('task:deleted', ({ taskId }) => removeTask(taskId));
  onTenant('tasks:reordered', ({ positions }) => {
    for (const p of positions) if (state.tasks[p.id]) state.tasks[p.id].position = p.position;
    notify();
  });

  onTenant('column:created', ({ column }) => upsertColumn(column));
  onTenant('column:updated', ({ column }) => upsertColumn(column));
  onTenant('column:deleted', ({ columnId }) => {
    state.columns = state.columns.filter((c) => c.id !== columnId);
    notify();
  });
  onTenant('columns:reordered', ({ boardId, positions }) => {
    if (boardId !== state.boardId) return;
    for (const p of positions) {
      const col = state.columns.find((c) => c.id === p.id);
      if (col) col.position = p.position;
    }
    notify();
  });

  onTenant('board:created', ({ board }) => upsertBoard(board));
  onTenant('board:updated', ({ board }) => upsertBoard(board));
  onTenant('board:deleted', ({ boardId }) => {
    state.boards = state.boards.filter((b) => b.id !== boardId);
    if (state.boardId === boardId) {
      toast('This board was deleted', 'warn');
      loaders.selectBoard(state.boards[0]?.id ?? null);
    }
    notify();
  });

  onTenant('activity:new', ({ activity }) => {
    onTaskActivity(activity);
    if (activity.boardId && activity.boardId !== state.boardId) return;
    state.activity.unshift({ ...activity, isNew: true });
    state.activity.length = Math.min(state.activity.length, 100);
    notify();
  });

  onTenant('presence:update', ({ users }) => {
    state.presence = users;
    notify();
  });

  onTenant('members:changed', () => loaders.loadMembers());

  // ----- personal / org events -----
  socket.on('tenant:kicked', async ({ tenantId, reason }) => {
    if (tenantId !== state.tenantId) return;
    toast(reason, 'warn', 6000);
    await loaders.refreshAccess();
  });
  socket.on('access:changed', () => loaders.refreshAccess());
  socket.on('org:changed', () => loaders.refreshAccess());
}

// Ask the server to put us in a branch room. Resolves { ok, role, presence }.
export function joinTenant(tenantId) {
  return new Promise((resolve) => {
    if (!socket) return resolve({ ok: false });
    socket.timeout(4000).emit('tenant:join', { tenantId }, (err, res) => {
      if (err) {
        needsResync = true; // didn't get in - resync when the connection works again
        return resolve({ ok: false, error: 'timeout' });
      }
      if (res?.ok) {
        state.presence = res.presence;
        sendPresence();
        notify();
      }
      resolve(res || { ok: false });
    });
  });
}

export function leaveTenant() {
  socket?.emit('tenant:leave');
}

// tell others which board I'm on and which card I have open
export function sendPresence(changes = {}) {
  if ('focusTaskId' in changes) focusTaskId = changes.focusTaskId;
  socket?.emit('presence:update', { boardId: state.boardId, focusTaskId });
}

export function disconnectSocket() {
  socket?.disconnect();
  socket = null;
}
