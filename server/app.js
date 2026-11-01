// Builds the Express app (kept separate from index.js so the tests can reuse it).
const path = require('path');
const express = require('express');
const { requireAuth } = require('./middleware/auth');
const { loadTenant } = require('./middleware/access');
const { errorHandler } = require('./middleware/errorHandler');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  // the frontend is plain static files - no build step needed
  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.get('/api/health', (req, res) => res.json({ ok: true }));
  app.use('/api/auth', require('./routes/auth'));
  app.use('/api/orgs', requireAuth, require('./routes/orgs'));

  // ---- everything below is scoped to ONE tenant (branch) ----
  // requireAuth -> who are you?   loadTenant -> are you allowed in this branch?
  const tenantRouter = express.Router({ mergeParams: true });
  tenantRouter.use(require('./routes/members'));
  tenantRouter.use(require('./routes/boards'));
  tenantRouter.use(require('./routes/columns'));
  tenantRouter.use(require('./routes/tasks'));
  tenantRouter.use(require('./routes/activity'));
  app.use('/api/tenants/:tenantId', requireAuth, loadTenant, tenantRouter);

  // unknown API route -> JSON 404 (instead of Express' HTML page)
  app.use('/api', (req, res) => res.status(404).json({ error: 'NOT_FOUND', message: 'No such API route' }));

  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
