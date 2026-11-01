// Presence = "who is online in this branch right now, and what are they looking at".
// Kept in memory only (it's temporary info, no point saving it to the DB).
//
//   tenants: Map<tenantId, Map<socketId, { userId, name, color, boardId, focusTaskId }>>
//
// One user can have several tabs open (several sockets) - list() merges them
// so the avatar shows up only once.
const tenants = new Map();

function join(tenantId, socket) {
  if (!tenants.has(tenantId)) tenants.set(tenantId, new Map());
  tenants.get(tenantId).set(socket.id, {
    userId: socket.user.id,
    name: socket.user.name,
    color: socket.user.avatar_color,
    boardId: null,
    focusTaskId: null,
  });
}

function leave(tenantId, socketId) {
  const room = tenants.get(tenantId);
  if (!room) return;
  room.delete(socketId);
  if (room.size === 0) tenants.delete(tenantId); // don't leak memory for empty rooms
}

function update(tenantId, socketId, changes) {
  const entry = tenants.get(tenantId)?.get(socketId);
  if (entry) Object.assign(entry, changes);
}

function list(tenantId) {
  const room = tenants.get(tenantId);
  if (!room) return [];
  const byUser = new Map();
  for (const entry of room.values()) {
    const existing = byUser.get(entry.userId);
    if (!existing) {
      byUser.set(entry.userId, { ...entry, tabs: 1 });
    } else {
      existing.tabs += 1;
      // prefer the tab that is actually doing something
      if (entry.focusTaskId) existing.focusTaskId = entry.focusTaskId;
      if (entry.boardId) existing.boardId = entry.boardId;
    }
  }
  return [...byUser.values()];
}

function clearTenant(tenantId) {
  tenants.delete(tenantId);
}

module.exports = { join, leave, update, list, clearTenant };
