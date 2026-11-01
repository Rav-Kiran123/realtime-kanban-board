// Activity log = "who did what, when" for one tenant.
// Every write route records one entry INSIDE its transaction, so the log can
// never say something happened that was actually rolled back.
const { getDb } = require('../db/database');
const { toActivity } = require('../utils/mappers');

const SELECT_ACTIVITY = `
  SELECT a.*, u.name AS user_name, u.avatar_color
  FROM activity_logs a
  LEFT JOIN users u ON u.id = a.user_id
`;

function recordActivity({ tenantId, boardId = null, userId, action, entityType, entityId = null, details = {} }) {
  const db = getDb();
  const info = db.prepare(`
    INSERT INTO activity_logs (tenant_id, board_id, user_id, action, entity_type, entity_id, details)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(tenantId, boardId, userId, action, entityType, entityId, JSON.stringify(details));

  const row = db.prepare(`${SELECT_ACTIVITY} WHERE a.id = ? AND a.tenant_id = ?`).get(info.lastInsertRowid, tenantId);
  return toActivity(row);
}

// newest first, with simple "load more" paging using beforeId
function listActivity(tenantId, { boardId = null, taskId = null, beforeId = null, limit = 50 } = {}) {
  let sql = `${SELECT_ACTIVITY} WHERE a.tenant_id = ?`;
  const params = [tenantId];

  if (boardId) {
    sql += ' AND (a.board_id = ? OR a.board_id IS NULL)'; // board events + tenant-wide events
    params.push(boardId);
  }
  if (taskId) {
    sql += ` AND a.entity_type = 'task' AND a.entity_id = ?`;
    params.push(taskId);
  }
  if (beforeId) {
    sql += ' AND a.id < ?';
    params.push(beforeId);
  }
  sql += ' ORDER BY a.id DESC LIMIT ?';
  params.push(Math.min(Math.max(limit, 1), 200));

  return getDb().prepare(sql).all(...params).map(toActivity);
}

module.exports = { recordActivity, listActivity };
