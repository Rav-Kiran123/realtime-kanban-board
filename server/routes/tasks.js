// =====================================================================
//  /api/tenants/:tenantId/... tasks
//
//  Concurrency rule (optimistic locking):
//    every change must send the `version` it was based on.
//    UPDATE ... WHERE id = ? AND version = ?   -> if 0 rows changed, someone
//    else got there first and we answer 409 + the latest copy of the task.
//    The browser then merges (see public/js/conflict.js).
// =====================================================================
const express = require('express');
const { getDb, transaction, now } = require('../db/database');
const { getColumn, getTask } = require('../services/boards');
const { placeBetween, taskScope } = require('../services/ordering');
const { recordActivity, listActivity } = require('../services/activity');
const { getTenantAccess } = require('../services/access');
const v = require('../utils/validate');
const { notFound, badRequest, versionConflict } = require('../utils/httpError');
const { toTask } = require('../utils/mappers');
const hub = require('../realtime/hub');

const router = express.Router({ mergeParams: true });

const PRIORITIES = ['low', 'medium', 'high', 'urgent'];

// API field name -> DB column name (also acts as a whitelist of editable fields)
const EDITABLE = { title: 'title', description: 'description', priority: 'priority', assigneeId: 'assignee_id', dueDate: 'due_date' };

// Reads + validates the editable fields that were actually sent.
function readTaskFields(body, tenantId, creating) {
  const fields = {};
  if (creating || body.title !== undefined) fields.title = v.requireText(body.title, 'title', 200);
  if (body.description !== undefined) fields.description = v.optionalText(body.description, 'description', 5000);
  if (body.priority !== undefined) fields.priority = v.oneOf(body.priority, 'priority', PRIORITIES);
  if (body.dueDate !== undefined) fields.dueDate = v.optionalDate(body.dueDate, 'dueDate');
  if (body.assigneeId !== undefined) {
    const assigneeId = v.optionalId(body.assigneeId, 'assigneeId');
    // you can only assign people who can actually see this branch
    if (assigneeId && !getTenantAccess(assigneeId, tenantId)) throw badRequest('Assignee must be a member of this branch');
    fields.assigneeId = assigneeId;
  }
  return fields;
}

// small helper so every route publishes the same way
function publish(tenantId, event, payload, activity, rebalanced) {
  if (rebalanced) hub.emitToTenant(tenantId, 'tasks:reordered', rebalanced);
  hub.emitToTenant(tenantId, event, payload);
  if (activity) hub.emitToTenant(tenantId, 'activity:new', { activity });
}

// ---------- create ----------
router.post('/boards/:boardId/tasks', (req, res) => {
  const tenantId = req.tenant.id;
  const body = req.body || {};
  const boardId = v.paramId(req.params.boardId, 'Board');
  const columnId = v.optionalId(body.columnId, 'columnId');
  if (!columnId) throw badRequest('columnId is required');
  const fields = readTaskFields(body, tenantId, true);

  const result = transaction((db) => {
    const column = getColumn(tenantId, columnId);
    if (!column || column.board_id !== boardId) throw notFound('Column'); // also blocks other tenants' columns

    const { position, rebalanced } = placeBetween(
      taskScope(tenantId, columnId), v.optionalId(body.prevTaskId, 'prevTaskId'), v.optionalId(body.nextTaskId, 'nextTaskId'),
    );
    const info = db.prepare(`
      INSERT INTO tasks (tenant_id, board_id, column_id, title, description, priority, assignee_id, due_date, position, created_by, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(tenantId, boardId, columnId, fields.title, fields.description ?? '', fields.priority ?? 'medium',
      fields.assigneeId ?? null, fields.dueDate ?? null, position, req.user.id, req.user.id);

    const task = getTask(tenantId, info.lastInsertRowid);
    const activity = recordActivity({ tenantId, boardId, userId: req.user.id, action: 'task.created', entityType: 'task', entityId: task.id, details: { title: task.title, columnName: column.name } });
    return { task, activity, rebalanced: rebalanced && { columnId, positions: rebalanced } };
  });

  // clientKey lets the creator's browser match this event to its optimistic "temp" card
  const clientKey = typeof body.clientKey === 'string' ? body.clientKey.slice(0, 64) : null;
  publish(tenantId, 'task:created', { task: toTask(result.task), clientKey }, result.activity, result.rebalanced);
  res.status(201).json({ task: toTask(result.task) });
});

// ---------- read one (with its history, for the detail panel) ----------
router.get('/tasks/:taskId', (req, res) => {
  const task = getTask(req.tenant.id, v.paramId(req.params.taskId, 'Task'));
  if (!task) throw notFound('Task');
  res.json({ task: toTask(task), activity: listActivity(req.tenant.id, { taskId: task.id, limit: 30 }) });
});

// ---------- edit fields ----------
router.patch('/tasks/:taskId', (req, res) => {
  const tenantId = req.tenant.id;
  const taskId = v.paramId(req.params.taskId, 'Task');
  const body = req.body || {};
  const version = v.requireVersion(body.version);
  const fields = readTaskFields(body, tenantId, false);
  if (Object.keys(fields).length === 0) throw badRequest('Nothing to update');

  const result = transaction((db) => {
    const current = getTask(tenantId, taskId);
    if (!current) throw notFound('Task');
    if (current.version !== version) throw versionConflict(toTask(current));

    // only the fields that were sent are written -> this is what makes
    // "auto merge" possible when two people edit DIFFERENT fields
    const columns = Object.keys(fields).map((f) => `${EDITABLE[f]} = ?`).join(', ');
    const info = db.prepare(`
      UPDATE tasks SET ${columns}, version = version + 1, updated_by = ?, updated_at = ?
      WHERE id = ? AND tenant_id = ? AND version = ? AND deleted_at IS NULL
    `).run(...Object.values(fields), req.user.id, now(), taskId, tenantId, version);
    if (info.changes !== 1) throw versionConflict(toTask(getTask(tenantId, taskId))); // belt and braces

    const task = getTask(tenantId, taskId);
    const before = {}; const after = {};
    for (const f of Object.keys(fields)) { before[f] = toTask(current)[f]; after[f] = toTask(task)[f]; }
    const activity = recordActivity({ tenantId, boardId: task.board_id, userId: req.user.id, action: 'task.updated', entityType: 'task', entityId: taskId, details: { title: task.title, fields: Object.keys(fields), before, after } });
    return { task, activity };
  });

  publish(tenantId, 'task:updated', { task: toTask(result.task) }, result.activity);
  res.json({ task: toTask(result.task) });
});

// ---------- move (drag & drop) ----------
router.post('/tasks/:taskId/move', (req, res) => {
  const tenantId = req.tenant.id;
  const taskId = v.paramId(req.params.taskId, 'Task');
  const body = req.body || {};
  const version = v.requireVersion(body.version);
  const columnId = v.optionalId(body.columnId, 'columnId');
  if (!columnId) throw badRequest('columnId is required');
  const prevId = v.optionalId(body.prevTaskId, 'prevTaskId');
  const nextId = v.optionalId(body.nextTaskId, 'nextTaskId');

  const result = transaction((db) => {
    const current = getTask(tenantId, taskId);
    if (!current) throw notFound('Task');
    if (current.version !== version) throw versionConflict(toTask(current), 'This card was changed by someone else while you were dragging it');

    const toColumn = getColumn(tenantId, columnId);
    if (!toColumn || toColumn.board_id !== current.board_id) throw notFound('Column'); // no moving across boards/branches
    const fromColumn = getColumn(tenantId, current.column_id);

    const { position, rebalanced } = placeBetween(taskScope(tenantId, columnId), prevId, nextId, taskId);
    db.prepare(`
      UPDATE tasks SET column_id = ?, position = ?, version = version + 1, updated_by = ?, updated_at = ?
      WHERE id = ? AND tenant_id = ? AND version = ?
    `).run(columnId, position, req.user.id, now(), taskId, tenantId, version);

    const task = getTask(tenantId, taskId);
    const activity = recordActivity({ tenantId, boardId: task.board_id, userId: req.user.id, action: 'task.moved', entityType: 'task', entityId: taskId, details: { title: task.title, fromColumn: fromColumn?.name, toColumn: toColumn.name } });
    return { task, activity, rebalanced: rebalanced && { columnId, positions: rebalanced } };
  });

  publish(tenantId, 'task:moved', { task: toTask(result.task) }, result.activity, result.rebalanced);
  res.json({ task: toTask(result.task) });
});

// ---------- delete (soft) ----------
router.delete('/tasks/:taskId', (req, res) => {
  const tenantId = req.tenant.id;
  const taskId = v.paramId(req.params.taskId, 'Task');
  const version = req.body?.version !== undefined ? v.requireVersion(req.body.version) : null;

  const result = transaction((db) => {
    const current = getTask(tenantId, taskId);
    if (!current) throw notFound('Task');
    if (version !== null && current.version !== version) throw versionConflict(toTask(current), 'This card was edited by someone else - check it before deleting');

    db.prepare('UPDATE tasks SET deleted_at = ?, version = version + 1, updated_by = ?, updated_at = ? WHERE id = ? AND tenant_id = ?')
      .run(now(), req.user.id, now(), taskId, tenantId);
    const activity = recordActivity({ tenantId, boardId: current.board_id, userId: req.user.id, action: 'task.deleted', entityType: 'task', entityId: taskId, details: { title: current.title } });
    return { current, activity };
  });

  publish(tenantId, 'task:deleted', { taskId, boardId: result.current.board_id }, result.activity);
  res.json({ ok: true, taskId });
});

// ---------- restore (used by "undo delete") ----------
router.post('/tasks/:taskId/restore', (req, res) => {
  const tenantId = req.tenant.id;
  const taskId = v.paramId(req.params.taskId, 'Task');

  const result = transaction((db) => {
    const current = getTask(tenantId, taskId, { includeDeleted: true });
    if (!current) throw notFound('Task');
    if (!current.deleted_at) return { task: current, activity: null }; // already restored -> idempotent

    db.prepare('UPDATE tasks SET deleted_at = NULL, version = version + 1, updated_by = ?, updated_at = ? WHERE id = ? AND tenant_id = ?')
      .run(req.user.id, now(), taskId, tenantId);
    const task = getTask(tenantId, taskId);
    const activity = recordActivity({ tenantId, boardId: task.board_id, userId: req.user.id, action: 'task.restored', entityType: 'task', entityId: taskId, details: { title: task.title } });
    return { task, activity };
  });

  if (result.activity) publish(tenantId, 'task:restored', { task: toTask(result.task) }, result.activity);
  res.json({ task: toTask(result.task) });
});

module.exports = router;
