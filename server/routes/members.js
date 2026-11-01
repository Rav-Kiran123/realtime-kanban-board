// /api/tenants/:tenantId/members -> who belongs to this branch
const express = require('express');
const { getDb, transaction } = require('../db/database');
const { ROLE_LEVEL } = require('../services/access');
const { recordActivity } = require('../services/activity');
const { requireRole } = require('../middleware/access');
const { requireText, oneOf, paramId } = require('../utils/validate');
const { badRequest, notFound, conflict, forbidden } = require('../utils/httpError');
const hub = require('../realtime/hub');

const router = express.Router({ mergeParams: true });
const BRANCH_ROLES = ['MEMBER', 'TENANT_ADMIN'];

// branch members + org admins (they can see every branch too)
function listMembers(tenantId, orgId) {
  const rows = getDb().prepare(`
    SELECT u.id, u.name, u.email, u.avatar_color, m.role
    FROM memberships m JOIN users u ON u.id = m.user_id
    WHERE m.tenant_id = ? OR (m.org_id = ? AND m.tenant_id IS NULL AND m.role = 'ORG_ADMIN')
    ORDER BY u.name
  `).all(tenantId, orgId);

  // someone can be org admin AND a branch member -> keep the highest role
  const byId = new Map();
  for (const r of rows) {
    const existing = byId.get(r.id);
    if (!existing || ROLE_LEVEL[r.role] > ROLE_LEVEL[existing.role]) {
      byId.set(r.id, { id: r.id, name: r.name, email: r.email, avatarColor: r.avatar_color, role: r.role });
    }
  }
  return [...byId.values()];
}

router.get('/members', (req, res) => {
  res.json({ members: listMembers(req.tenant.id, req.tenant.orgId) });
});

router.post('/members', requireRole('TENANT_ADMIN'), (req, res) => {
  const tenantId = req.tenant.id;
  const email = requireText(req.body?.email, 'email', 120).toLowerCase();
  const role = oneOf(req.body?.role ?? 'MEMBER', 'role', BRANCH_ROLES);

  const user = getDb().prepare('SELECT id, name FROM users WHERE email = ?').get(email);
  if (!user) throw badRequest('No user with that email - ask them to register first');

  const activity = transaction((db) => {
    if (db.prepare('SELECT 1 FROM memberships WHERE user_id = ? AND tenant_id = ?').get(user.id, tenantId)) {
      throw conflict(`${user.name} is already in this branch`);
    }
    db.prepare('INSERT INTO memberships (user_id, org_id, tenant_id, role) VALUES (?, ?, ?, ?)').run(user.id, req.tenant.orgId, tenantId, role);
    return recordActivity({ tenantId, userId: req.user.id, action: 'member.added', entityType: 'member', entityId: user.id, details: { userName: user.name, role } });
  });

  hub.emitToTenant(tenantId, 'members:changed', {});
  hub.emitToTenant(tenantId, 'activity:new', { activity });
  hub.emitToUser(user.id, 'access:changed', {}); // their branch switcher should refresh
  res.status(201).json({ members: listMembers(tenantId, req.tenant.orgId) });
});

router.patch('/members/:userId', requireRole('TENANT_ADMIN'), (req, res) => {
  const tenantId = req.tenant.id;
  const userId = paramId(req.params.userId, 'Member');
  const role = oneOf(req.body?.role, 'role', BRANCH_ROLES);

  const activity = transaction((db) => {
    const row = db.prepare(`SELECT u.name FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.user_id = ? AND m.tenant_id = ?`).get(userId, tenantId);
    if (!row) throw notFound('Member (org admins are managed at org level)');
    db.prepare('UPDATE memberships SET role = ? WHERE user_id = ? AND tenant_id = ?').run(role, userId, tenantId);
    return recordActivity({ tenantId, userId: req.user.id, action: 'member.role_changed', entityType: 'member', entityId: userId, details: { userName: row.name, role } });
  });

  hub.emitToTenant(tenantId, 'members:changed', {});
  hub.emitToTenant(tenantId, 'activity:new', { activity });
  hub.emitToUser(userId, 'access:changed', {});
  res.json({ members: listMembers(tenantId, req.tenant.orgId) });
});

router.delete('/members/:userId', requireRole('TENANT_ADMIN'), async (req, res) => {
  const tenantId = req.tenant.id;
  const userId = paramId(req.params.userId, 'Member');
  if (userId === req.user.id && req.role !== 'ORG_ADMIN') throw forbidden("You can't remove yourself");

  const activity = transaction((db) => {
    const row = db.prepare(`SELECT u.name FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.user_id = ? AND m.tenant_id = ?`).get(userId, tenantId);
    if (!row) throw notFound('Member (org admins are managed at org level)');
    db.prepare('DELETE FROM memberships WHERE user_id = ? AND tenant_id = ?').run(userId, tenantId);
    db.prepare('UPDATE tasks SET assignee_id = NULL WHERE tenant_id = ? AND assignee_id = ?').run(tenantId, userId);
    return recordActivity({ tenantId, userId: req.user.id, action: 'member.removed', entityType: 'member', entityId: userId, details: { userName: row.name } });
  });

  // kick their open tabs out of the live channel straight away
  await hub.kickUserFromTenant(userId, tenantId);
  hub.emitToUser(userId, 'access:changed', {});
  hub.emitToTenant(tenantId, 'members:changed', { boardsNeedReload: true });
  hub.emitToTenant(tenantId, 'activity:new', { activity });
  res.json({ members: listMembers(tenantId, req.tenant.orgId) });
});

module.exports = router;
