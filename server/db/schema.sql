-- =====================================================================
--  TeamBoard database schema (SQLite)
--
--  Hierarchy:  organizations -> tenants (branches) -> boards -> columns -> tasks
--
--  Tenant isolation idea (my main design rule):
--    * EVERY business table (boards, columns, tasks, activity_logs) has a
--      tenant_id column, even when it could be "derived" through a parent.
--    * Child tables use COMPOSITE foreign keys like (board_id, tenant_id), so
--      the database itself refuses a column/task that points at a parent in a
--      different tenant. Even if my app code had a bug, SQLite would block it.
-- =====================================================================

-- ---------- Organizations (top level, e.g. "Acme Corp") ----------
CREATE TABLE IF NOT EXISTS organizations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ---------- Tenants = branches of an organization ----------
CREATE TABLE IF NOT EXISTS tenants (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id      INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name        TEXT    NOT NULL,
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (org_id, name),
  UNIQUE (id, org_id)            -- needed so memberships can reference (tenant_id, org_id)
);

-- ---------- Users (global - one login can belong to many orgs) ----------
CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT    NOT NULL,
  email          TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  password_hash  TEXT    NOT NULL,
  avatar_color   TEXT    NOT NULL DEFAULT '#6c757d',
  created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ---------- Memberships (who can access what, and with which role) ----------
--  ORG_ADMIN     -> tenant_id IS NULL  (applies to every branch in the org)
--  TENANT_ADMIN  -> tenant_id set      (manages one branch)
--  MEMBER        -> tenant_id set      (works on tasks in one branch)
CREATE TABLE IF NOT EXISTS memberships (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id      INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  tenant_id   INTEGER,
  role        TEXT    NOT NULL CHECK (role IN ('ORG_ADMIN', 'TENANT_ADMIN', 'MEMBER')),
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  -- the branch must really belong to the same organization
  FOREIGN KEY (tenant_id, org_id) REFERENCES tenants(id, org_id) ON DELETE CASCADE,
  -- org admins are org-wide, everyone else is tied to one branch
  CHECK ((role = 'ORG_ADMIN' AND tenant_id IS NULL) OR (role <> 'ORG_ADMIN' AND tenant_id IS NOT NULL))
);
-- one org-level row per user per org, one row per user per branch
CREATE UNIQUE INDEX IF NOT EXISTS ux_membership_org    ON memberships(user_id, org_id)    WHERE tenant_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_membership_tenant ON memberships(user_id, tenant_id) WHERE tenant_id IS NOT NULL;
CREATE INDEX        IF NOT EXISTS ix_membership_tenant ON memberships(tenant_id);

-- ---------- Boards (belong to one tenant) ----------
CREATE TABLE IF NOT EXISTS boards (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id    INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name         TEXT    NOT NULL,
  description  TEXT    NOT NULL DEFAULT '',
  version      INTEGER NOT NULL DEFAULT 1,       -- optimistic locking counter
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (id, tenant_id)
);
CREATE INDEX IF NOT EXISTS ix_boards_tenant ON boards(tenant_id);

-- ---------- Columns (lists inside a board) ----------
CREATE TABLE IF NOT EXISTS columns (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id   INTEGER NOT NULL,
  board_id    INTEGER NOT NULL,
  name        TEXT    NOT NULL,
  position    REAL    NOT NULL,                  -- fractional index (see README)
  wip_limit   INTEGER,                           -- optional "work in progress" limit
  version     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (board_id, tenant_id) REFERENCES boards(id, tenant_id) ON DELETE CASCADE,
  UNIQUE (id, board_id, tenant_id)
);
CREATE INDEX IF NOT EXISTS ix_columns_board ON columns(tenant_id, board_id, position);

-- ---------- Tasks (cards) ----------
CREATE TABLE IF NOT EXISTS tasks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id    INTEGER NOT NULL,
  board_id     INTEGER NOT NULL,
  column_id    INTEGER NOT NULL,
  title        TEXT    NOT NULL,
  description  TEXT    NOT NULL DEFAULT '',
  priority     TEXT    NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
  assignee_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  due_date     TEXT,                             -- 'YYYY-MM-DD'
  position     REAL    NOT NULL,                 -- order inside the column
  version      INTEGER NOT NULL DEFAULT 1,       -- bumped on EVERY change
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at   TEXT,                             -- soft delete (makes "undo delete" possible)
  FOREIGN KEY (board_id, tenant_id)             REFERENCES boards(id, tenant_id)             ON DELETE CASCADE,
  FOREIGN KEY (column_id, board_id, tenant_id)  REFERENCES columns(id, board_id, tenant_id)  ON DELETE CASCADE
);
-- the hot query: "all live tasks of a column in order"
CREATE INDEX IF NOT EXISTS ix_tasks_column ON tasks(tenant_id, column_id, position) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_tasks_board  ON tasks(tenant_id, board_id);

-- ---------- Activity log (audit trail per tenant) ----------
CREATE TABLE IF NOT EXISTS activity_logs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id    INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  board_id     INTEGER,                          -- NULL for tenant-wide things (members etc.)
  user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action       TEXT    NOT NULL,                 -- e.g. 'task.moved'
  entity_type  TEXT    NOT NULL,                 -- 'task' | 'column' | 'board' | 'member'
  entity_id    INTEGER,
  details      TEXT    NOT NULL DEFAULT '{}',    -- JSON blob with before/after info
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS ix_activity_tenant ON activity_logs(tenant_id, id DESC);
CREATE INDEX IF NOT EXISTS ix_activity_entity ON activity_logs(tenant_id, entity_type, entity_id);
