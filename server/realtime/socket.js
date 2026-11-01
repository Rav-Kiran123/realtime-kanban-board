// =====================================================================
//  WebSocket server (Socket.IO)
//
//  Design decision: the socket is (almost) READ-ONLY for business data.
//  All changes go through the REST API (validated + permission-checked in one
//  place) and the server then pushes events into the tenant's room.
//  The socket itself only handles: joining a branch room + presence.
// =====================================================================
const { userFromToken } = require('../services/auth');
const { getTenantAccess, getAccessTree } = require('../services/access');
const presence = require('./presence');
const hub = require('./hub');

function setupSocket(io) {
  // Step 1: authenticate the handshake with the same JWT as the REST API
  io.use((socket, next) => {
    const user = userFromToken(socket.handshake.auth?.token);
    if (!user) return next(new Error('UNAUTHORIZED'));
    socket.user = user;
    next();
  });

  io.on('connection', (socket) => {
    const userId = socket.user.id;

    // Step 2: personal room + rooms for every org the user belongs to
    socket.join(hub.userRoom(userId));
    for (const org of getAccessTree(userId)) socket.join(hub.orgRoom(org.id));

    // Step 3: join ONE branch room at a time (switching branch leaves the old one)
    socket.on('tenant:join', (data, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      const tenantId = Number(data?.tenantId);
      const access = Number.isInteger(tenantId) ? getTenantAccess(userId, tenantId) : null;

      // same answer for "doesn't exist" and "not yours" -> nothing leaks
      if (!access) return reply({ ok: false, error: 'You do not have access to this branch' });

      hub.leaveTenant(socket);
      socket.join(hub.tenantRoom(tenantId));
      socket.data.tenantId = tenantId;
      presence.join(tenantId, socket);
      hub.broadcastPresence(tenantId);

      reply({ ok: true, tenantId, role: access.role, presence: presence.list(tenantId) });
    });

    socket.on('tenant:leave', () => hub.leaveTenant(socket));

    // Step 4: presence updates - which board I'm on, which card I have open
    socket.on('presence:update', (data) => {
      const tenantId = socket.data.tenantId;
      if (!tenantId) return;
      presence.update(tenantId, socket.id, {
        boardId: Number(data?.boardId) || null,
        focusTaskId: Number(data?.focusTaskId) || null,
      });
      hub.broadcastPresence(tenantId);
    });

    // Step 5: clean up on disconnect (closing a tab, losing wifi ...)
    socket.on('disconnect', () => hub.leaveTenant(socket));
  });
}

module.exports = { setupSocket };
