// Middleware that decides WHICH tenant/org a request is about and whether the
// logged-in user is allowed in. After loadTenant runs, route code uses
// req.tenant.id for every query - it never trusts a tenantId from the body.
const { getTenantAccess, isOrgAdmin, isOrgMember, hasRole } = require('../services/access');
const { getDb } = require('../db/database');
const { notFound, forbidden } = require('../utils/httpError');
const { paramId } = require('../utils/validate');

// for routes under /api/tenants/:tenantId/...
function loadTenant(req, res, next) {
  const tenantId = paramId(req.params.tenantId, 'Branch');
  const access = getTenantAccess(req.user.id, tenantId);

  // 404 on purpose: "not yours" looks exactly like "doesn't exist"
  if (!access) return next(notFound('Branch'));

  req.tenant = { id: access.tenant.id, orgId: access.tenant.org_id, name: access.tenant.name };
  req.role = access.role;
  next();
}

// for routes under /api/orgs/:orgId/...
function loadOrg(req, res, next) {
  const orgId = paramId(req.params.orgId, 'Organization');
  const org = getDb().prepare('SELECT * FROM organizations WHERE id = ?').get(orgId);
  if (!org || !isOrgMember(req.user.id, orgId)) return next(notFound('Organization'));

  req.org = org;
  req.isOrgAdmin = isOrgAdmin(req.user.id, orgId);
  next();
}

// requireRole('TENANT_ADMIN') -> TENANT_ADMIN and ORG_ADMIN pass, MEMBER gets 403
function requireRole(minRole) {
  return (req, res, next) => {
    if (!hasRole(req.role, minRole)) {
      return next(forbidden(`This needs the ${minRole} role (you are ${req.role})`));
    }
    next();
  };
}

function requireOrgAdmin(req, res, next) {
  if (!req.isOrgAdmin) return next(forbidden('Only an organization admin can do this'));
  next();
}

module.exports = { loadTenant, loadOrg, requireRole, requireOrgAdmin };
