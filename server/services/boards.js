// Reusable board/column/task lookups. EVERY function takes tenantId as its
// first argument and puts it in the WHERE clause - that's my simple rule to
// make cross-tenant leaks basically impossible to write by accident.
const { getDb } = require('../db/database');
const { GAP } = require('./ordering');

const DEFAULT_COLUMNS = ['To Do', 'In Progress', 'Review', 'Done'];

function getBoard(tenantId, boardId) {
  return getDb().prepare('SELECT * FROM boards WHERE id = ? AND tenant_id = ?').get(boardId, tenantId);
}

function listBoards(tenantId) {
  return getDb().prepare('SELECT * FROM boards WHERE tenant_id = ? ORDER BY created_at, id').all(tenantId);
}

function getColumn(tenantId, columnId) {
  return getDb().prepare('SELECT * FROM columns WHERE id = ? AND tenant_id = ?').get(columnId, tenantId);
}

function listColumns(tenantId, boardId) {
  return getDb().prepare('SELECT * FROM columns WHERE tenant_id = ? AND board_id = ? ORDER BY position, id').all(tenantId, boardId);
}

// soft-deleted tasks are hidden unless includeDeleted (used by "restore")
function getTask(tenantId, taskId, { includeDeleted = false } = {}) {
  const sql = `SELECT * FROM tasks WHERE id = ? AND tenant_id = ?${includeDeleted ? '' : ' AND deleted_at IS NULL'}`;
  return getDb().prepare(sql).get(taskId, tenantId);
}

function listTasks(tenantId, boardId) {
  return getDb().prepare(
    'SELECT * FROM tasks WHERE tenant_id = ? AND board_id = ? AND deleted_at IS NULL ORDER BY column_id, position, id'
  ).all(tenantId, boardId);
}

// Creates a board and (optionally) the usual 4 columns. Must run inside a transaction.
function createBoard({ tenantId, name, description = '', userId, withDefaultColumns = true }) {
  const db = getDb();
  const info = db.prepare('INSERT INTO boards (tenant_id, name, description, created_by) VALUES (?, ?, ?, ?)')
    .run(tenantId, name, description, userId);
  const boardId = info.lastInsertRowid;

  if (withDefaultColumns) {
    const addColumn = db.prepare('INSERT INTO columns (tenant_id, board_id, name, position) VALUES (?, ?, ?, ?)');
    DEFAULT_COLUMNS.forEach((colName, i) => addColumn.run(tenantId, boardId, colName, (i + 1) * GAP));
  }
  return getBoard(tenantId, boardId);
}

module.exports = { DEFAULT_COLUMNS, getBoard, listBoards, getColumn, listColumns, getTask, listTasks, createBoard };
