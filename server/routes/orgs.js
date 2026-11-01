// /api/orgs  -> organizations, their branches (tenants) and org admins.
// Everything here is ORG-level, so permissions are "org member" / "org admin".
const express = require('express');
const { getDb, transaction, now } = require('../db/database');
const { getAccessTree } = require('../services/access');
const { createBoard } = require('../services/boards');
const { loadOrg, requireOrgAdmin } = require('../middleware/access');
const { requireText, paramId } = require('../utils/validate');
const { notFound, badRequest, conflict } = require('../utils/httpError');
const hub = require('../realtime/hub');

const router = express.Router();

const getTenantInOrg = (orgId, tenantId) =>
  getDb().prepare('SELECT * FROM tenants WHERE id = ? AND org_id = ?').get(tenantId, orgId);

// new branches start with one ready-to-use board
function createTenantWithBoard(orgId, name, userId) {
  const info = getDb().prepare('INSERT INTO tenants (org_id, name) VALUES (?, ?)').run(orgId, name);
  createBoard({ tenantId: info.lastInsertRowid, name: 'Main Board', userId });
  return getDb().prepare('SELECT * FROM tenants WHERE id = ?').get(info.lastInsertRowid);
}

// ---------- organizations ----------

// my orgs (same tree as /auth/me)
router.get('/', (req, res) => {
  res.json({ orgs: getAccessTree(req.user.id) });
});

// anyone can start a new organization - they become its ORG_ADMIN
router.post('/', (req, res) => {
  const name = requireText(req.body?.name, 'name', 80);
  const firstBranch = req.body?.firstBranchName ? requireText(req.body.firstBranchName, 'firstBranchName', 80) : 'Head Office';

  const org = transaction((db) => {
    const info = db.prepare('INSERT INTO organizations (name) VALUES (?)').run(name);
    const orgId = info.lastInsertRowid;
    db.prepare(`INSERT INTO memberships (user_id, org_id, tenant_id, role) VALUES (?, ?, NULL, 'ORG_ADMIN')`).run(req.user.id, orgId);
    createTenantWithBoard(orgId, firstBranch, req.user.id);
    return db.prepare('SELECT * FROM organizations WHERE id = ?').get(orgId);
  });

  hub.emitToUser(req.user.id, 'access:changed', {});
  res.status(201).json({ org: { id: org.id, name: org.name } });
});

router.get('/:orgId', loadOrg, (req, res) => {
  const tree = getAccessTree(req.user.id).find((o) => o.id === req.org.id);
  res.json({ org: tree });
});

router.patch('/:orgId', loadOrg, requireOrgAdmin, (req, res) => {
  const name = requireText(req.body?.name, 'name', 80);
  getDb().prepare('UPDATE organizations SET name = ?, updated_at = ? WHERE id = ?').run(name, now(), req.org.id);
  hub.emitToOrg(req.org.id, 'org:changed', {});
  res.json({ org: { id: req.org.id, name } });
});

router.delete('/:orgId', loadOrg, requireOrgAdmin, (req, res) => {
  const tenantIds = getDb().prepare('SELECT id FROM tenants WHERE org_id = ?').all(req.org.id).map((t) => t.id);
  getDb().prepare('DELETE FROM organizations WHERE id = ?').run(req.org.id); // cascades to everything below
  hub.emitToOrg(req.org.id, 'org:changed', { deleted: true });
  tenantIds.forEach(hub.closeTenantRoom);
  res.json({ ok: true });
});

// ---------- tenants (branches) ----------

router.get('/:orgId/tenants', loadOrg, (req, res) => {
  const tree = getAccessTree(req.user.id).find((o) => o.id === req.org.id);
  res.json({ tenants: tree ? tree.tenants : [] });
});

router.post('/:orgId/tenants', loadOrg, requireOrgAdmin, (req, res) => {
  const name = requireText(req.body?.name, 'name', 80);
  const tenant = transaction(() => createTenantWithBoard(req.org.id, name, req.user.id));
  hub.emitToOrg(req.org.id, 'org:changed', {});
  res.status(201).json({ tenant: { id: tenant.id, orgId: tenant.org_id, name: tenant.name } });
});

router.patch('/:orgId/tenants/:tenantId', loadOrg, requireOrgAdmin, (req, res) => {
  const tenantId = paramId(req.params.tenantId, 'Branch');
  if (!getTenantInOrg(req.org.id, tenantId)) throw notFound('Branch'); // must be inside THIS org
  const name = requireText(req.body?.name, 'name', 80);
  getDb().prepare('UPDATE tenants SET name = ?, updated_at = ? WHERE id = ? AND org_id = ?').run(name, now(), tenantId, req.org.id);
  hub.emitToOrg(req.org.id, 'org:changed', {});
  res.json({ tenant: { id: tenantId, orgId: req.org.id, name } });
});

router.delete('/:orgId/tenants/:tenantId', loadOrg, requireOrgAdmin, (req, res) => {
  const tenantId = paramId(req.params.tenantId, 'Branch');
  if (!getTenantInOrg(req.org.id, tenantId)) throw notFound('Branch');
  getDb().prepare('DELETE FROM tenants WHERE id = ? AND org_id = ?').run(tenantId, req.org.id);
  hub.closeTenantRoom(tenantId);
  hub.emitToOrg(req.org.id, 'org:changed', {});
  res.json({ ok: true });
});

// ---------- org admins ----------

router.get('/:orgId/admins', loadOrg, requireOrgAdmin, (req, res) => {
  const admins = getDb().prepare(`
    SELECT u.id, u.name, u.email FROM memberships m JOIN users u ON u.id = m.user_id
    WHERE m.org_id = ? AND m.role = 'ORG_ADMIN' ORDER BY u.name
  `).all(req.org.id);
  res.json({ admins });
});

router.post('/:orgId/admins', loadOrg, requireOrgAdmin, (req, res) => {
  const email = requireText(req.body?.email, 'email', 120).toLowerCase();
  const user = getDb().prepare('SELECT id, name FROM users WHERE email = ?').get(email);
  if (!user) throw badRequest('No user with that email - they need to register first');
  if (getDb().prepare(`SELECT 1 FROM memberships WHERE user_id = ? AND org_id = ? AND tenant_id IS NULL`).get(user.id, req.org.id)) {
    throw conflict('That user is already an org admin');
  }
  getDb().prepare(`INSERT INTO memberships (user_id, org_id, tenant_id, role) VALUES (?, ?, NULL, 'ORG_ADMIN')`).run(user.id, req.org.id);
  hub.emitToUser(user.id, 'access:changed', {});
  res.status(201).json({ admin: user });
});

module.exports = router;
