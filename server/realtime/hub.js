// The "hub" is how the REST routes talk to connected browsers.
// Routes never touch socket.io directly - they call emitToTenant() etc.
//
// Room naming (this is what keeps channels scoped):
//   tenant:<id>  -> everyone currently viewing that branch
//   org:<id>     -> everyone in an organization (for "branch list changed")
//   user:<id>    -> all tabs of one user (for "your access changed")
const presence = require('./presence');

let io = null;

const tenantRoom = (id) => `tenant:${id}`;
const orgRoom = (id) => `org:${id}`;
const userRoom = (id) => `user:${id}`;

function setIo(server) {
  io = server;
}

// tenantId is ALWAYS stamped onto the payload, so the client can double check
// the event belongs to the branch it's showing (defence in depth).
function emitToTenant(tenantId, event, payload = {}) {
  if (io) io.to(tenantRoom(tenantId)).emit(event, { ...payload, tenantId });
}

function emitToOrg(orgId, event, payload = {}) {
  if (io) io.to(orgRoom(orgId)).emit(event, { ...payload, orgId });
}

function emitToUser(userId, event, payload = {}) {
  if (io) io.to(userRoom(userId)).emit(event, payload);
}

function broadcastPresence(tenantId) {
  emitToTenant(tenantId, 'presence:update', { users: presence.list(tenantId) });
}

// Remove one socket from whatever branch room it's in.
function leaveTenant(socket) {
  const tenantId = socket.data.tenantId;
  if (!tenantId) return;
  socket.leave(tenantRoom(tenantId));
  presence.leave(tenantId, socket.id);
  socket.data.tenantId = null;
  broadcastPresence(tenantId);
}

// Called when a user's membership is removed: kick their open tabs out of the
// branch room immediately, otherwise they'd keep receiving live updates.
async function kickUserFromTenant(userId, tenantId) {
  if (!io) return;
  const sockets = await io.in(userRoom(userId)).fetchSockets();
  for (const s of sockets) {
    if (s.data.tenantId === tenantId) {
      s.leave(tenantRoom(tenantId));
      presence.leave(tenantId, s.id);
      s.data.tenantId = null;
      s.emit('tenant:kicked', { tenantId, reason: 'Your access to this branch was removed' });
    }
  }
  broadcastPresence(tenantId);
}

// Called when a whole branch is deleted.
function closeTenantRoom(tenantId) {
  if (!io) return;
  io.to(tenantRoom(tenantId)).emit('tenant:kicked', { tenantId, reason: 'This branch was deleted' });
  io.in(tenantRoom(tenantId)).socketsLeave(tenantRoom(tenantId));
  presence.clearTenant(tenantId);
}

module.exports = {
  setIo, tenantRoom, orgRoom, userRoom,
  emitToTenant, emitToOrg, emitToUser, broadcastPresence, leaveTenant, kickUserFromTenant, closeTenantRoom,
};
