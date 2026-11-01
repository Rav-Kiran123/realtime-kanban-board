// The DB uses snake_case, the API/JSON uses camelCase.
// These functions convert one DB row into what we send to the browser.

const toUser = (row) => row && ({
  id: row.id,
  name: row.name,
  email: row.email,
  avatarColor: row.avatar_color,
});

const toBoard = (row) => row && ({
  id: row.id,
  tenantId: row.tenant_id,
  name: row.name,
  description: row.description,
  version: row.version,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const toColumn = (row) => row && ({
  id: row.id,
  tenantId: row.tenant_id,
  boardId: row.board_id,
  name: row.name,
  position: row.position,
  wipLimit: row.wip_limit,
  version: row.version,
});

const toTask = (row) => row && ({
  id: row.id,
  tenantId: row.tenant_id,
  boardId: row.board_id,
  columnId: row.column_id,
  title: row.title,
  description: row.description,
  priority: row.priority,
  assigneeId: row.assignee_id,
  dueDate: row.due_date,
  position: row.position,
  version: row.version,
  createdBy: row.created_by,
  updatedBy: row.updated_by,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const toActivity = (row) => row && ({
  id: row.id,
  tenantId: row.tenant_id,
  boardId: row.board_id,
  userId: row.user_id,
  userName: row.user_name || 'Someone',
  userColor: row.avatar_color || '#6c757d',
  action: row.action,
  entityType: row.entity_type,
  entityId: row.entity_id,
  details: JSON.parse(row.details || '{}'),
  createdAt: row.created_at,
});

module.exports = { toUser, toBoard, toColumn, toTask, toActivity };
