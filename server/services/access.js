// "Who can see what" - the heart of the tenancy model.
// Used by BOTH the REST middleware and the WebSocket server, so the rules are
// written once and can't drift apart.
const { getDb } = require('../db/database');

// Higher number = more power. ORG_ADMIN can do everything a TENANT_ADMIN can, etc.
const ROLE_LEVEL = { MEMBER: 1, TENANT_ADMIN: 2, ORG_ADMIN: 3 };
const ROLES = Object.keys(ROLE_LEVEL);

function hasRole(role, minRole) {
  return (ROLE_LEVEL[role] || 0) >= ROLE_LEVEL[minRole];
}

function isOrgAdmin(userId, orgId) {
  const row = getDb().prepare(
    `SELECT 1 FROM memberships WHERE user_id = ? AND org_id = ? AND tenant_id IS NULL AND role = 'ORG_ADMIN'`
  ).get(userId, orgId);
  return !!row;
}

// any membership at all inside this org (admin or some branch)
function isOrgMember(userId, orgId) {
  return !!getDb().prepare('SELECT 1 FROM memberships WHERE user_id = ? AND org_id = ? LIMIT 1').get(userId, orgId);
}

/**
 * Can this user open this tenant (branch)? Returns { tenant, role } or null.
 * Rule 1: an ORG_ADMIN of the tenant's organization gets in to every branch.
 * Rule 2: otherwise you need a membership row for exactly this branch.
 */
function getTenantAccess(userId, tenantId) {
  const db = getDb();
  const tenant = db.prepare('SELECT id, org_id, name FROM tenants WHERE id = ?').get(tenantId);
  if (!tenant) return null;

  if (isOrgAdmin(userId, tenant.org_id)) {
    return { tenant, role: 'ORG_ADMIN' };
  }

  const membership = db.prepare('SELECT role FROM memberships WHERE user_id = ? AND tenant_id = ?').get(userId, tenantId);
  if (!membership) return null;
  return { tenant, role: membership.role };
}

/**
 * Builds the data for the "organization selector + branch switcher":
 * [{ id, name, isOrgAdmin, tenants: [{ id, name, role }] }]
 */
function getAccessTree(userId) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT o.id AS org_id, o.name AS org_name, m.tenant_id, m.role
    FROM memberships m
    JOIN organizations o ON o.id = m.org_id
    WHERE m.user_id = ?
    ORDER BY o.name
  `).all(userId);

  // group the membership rows by organization
  const orgs = new Map();
  for (const row of rows) {
    if (!orgs.has(row.org_id)) {
      orgs.set(row.org_id, { id: row.org_id, name: row.org_name, isOrgAdmin: false, branchRoles: new Map() });
    }
    const org = orgs.get(row.org_id);
    if (row.role === 'ORG_ADMIN') org.isOrgAdmin = true;
    else org.branchRoles.set(row.tenant_id, row.role);
  }

  return [...orgs.values()].map((org) => {
    const allTenants = db.prepare('SELECT id, name FROM tenants WHERE org_id = ? ORDER BY name').all(org.id);
    const tenants = allTenants
      .filter((t) => org.isOrgAdmin || org.branchRoles.has(t.id)) // members only see their own branches
      .map((t) => ({ id: t.id, name: t.name, role: org.isOrgAdmin ? 'ORG_ADMIN' : org.branchRoles.get(t.id) }));
    return { id: org.id, name: org.name, isOrgAdmin: org.isOrgAdmin, tenants };
  });
}

module.exports = { ROLE_LEVEL, ROLES, hasRole, isOrgAdmin, isOrgMember, getTenantAccess, getAccessTree };
