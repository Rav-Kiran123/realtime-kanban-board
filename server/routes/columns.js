// /api/tenants/:tenantId/... columns (only TENANT_ADMIN and above can change the board layout)
const express = require('express');
const { getDb, transaction, now } = require('../db/database');
const { getBoard, getColumn } = require('../services/boards');
const { placeBetween, columnScope } = require('../services/ordering');
const { recordActivity } = require('../services/activity');
const { requireRole } = require('../middleware/access');
const { requireText, requireVersion, optionalId, optionalPositiveInt, paramId } = require('../utils/validate');
const { notFound, versionConflict, conflict } = require('../utils/httpError');
const { toColumn } = require('../utils/mappers');
const hub = require('../realtime/hub');

const router = express.Router({ mergeParams: true });
// every route in this file needs TENANT_ADMIN (added per route, NOT with router.use,
// because this router is mounted at '/' and router.use would also block task routes)
const adminOnly = requireRole('TENANT_ADMIN');

// add a column at the end of the board
router.post('/boards/:boardId/columns', adminOnly, (req, res) => {
  const tenantId = req.tenant.id;
  const boardId = paramId(req.params.boardId, 'Board');
  const name = requireText(req.body?.name, 'name', 60);
  const wipLimit = optionalPositiveInt(req.body?.wipLimit, 'wipLimit') ?? null;

  const { column, activity } = transaction((db) => {
    if (!getBoard(tenantId, boardId)) throw notFound('Board');
    const { position } = placeBetween(columnScope(tenantId, boardId), null, null); // null/null = append
    const info = db.prepare('INSERT INTO columns (tenant_id, board_id, name, position, wip_limit) VALUES (?, ?, ?, ?, ?)')
      .run(tenantId, boardId, name, position, wipLimit);
    const column = getColumn(tenantId, info.lastInsertRowid);
    const activity = recordActivity({ tenantId, boardId, userId: req.user.id, action: 'column.created', entityType: 'column', entityId: column.id, details: { name } });
    return { column, activity };
  });

  hub.emitToTenant(tenantId, 'column:created', { column: toColumn(column) });
  hub.emitToTenant(tenantId, 'activity:new', { activity });
  res.status(201).json({ column: toColumn(column) });
});

// rename / change WIP limit
router.patch('/columns/:columnId', adminOnly, (req, res) => {
  const tenantId = req.tenant.id;
  const columnId = paramId(req.params.columnId, 'Column');
  const version = requireVersion(req.body?.version);
  const name = req.body?.name !== undefined ? requireText(req.body.name, 'name', 60) : undefined;
  const wipLimit = optionalPositiveInt(req.body?.wipLimit, 'wipLimit');

  const { column, activity } = transaction((db) => {
    const current = getColumn(tenantId, columnId);
    if (!current) throw notFound('Column');
    if (current.version !== version) throw versionConflict(toColumn(current));

    db.prepare(`
      UPDATE columns SET name = ?, wip_limit = ?, version = version + 1, updated_at = ?
      WHERE id = ? AND tenant_id = ? AND version = ?
    `).run(name ?? current.name, wipLimit === undefined ? current.wip_limit : wipLimit, now(), columnId, tenantId, version);

    const column = getColumn(tenantId, columnId);
    const activity = recordActivity({ tenantId, boardId: column.board_id, userId: req.user.id, action: 'column.updated', entityType: 'column', entityId: columnId, details: { name: column.name, oldName: current.name } });
    return { column, activity };
  });

  hub.emitToTenant(tenantId, 'column:updated', { column: toColumn(column) });
  hub.emitToTenant(tenantId, 'activity:new', { activity });
  res.json({ column: toColumn(column) });
});

// reorder columns (same neighbour-based logic as tasks)
router.post('/columns/:columnId/move', adminOnly, (req, res) => {
  const tenantId = req.tenant.id;
  const columnId = paramId(req.params.columnId, 'Column');
  const version = requireVersion(req.body?.version);
  const prevId = optionalId(req.body?.prevColumnId, 'prevColumnId');
  const nextId = optionalId(req.body?.nextColumnId, 'nextColumnId');

  const result = transaction((db) => {
    const current = getColumn(tenantId, columnId);
    if (!current) throw notFound('Column');
    if (current.version !== version) throw versionConflict(toColumn(current));

    const { position, rebalanced } = placeBetween(columnScope(tenantId, current.board_id), prevId, nextId, columnId);
    db.prepare('UPDATE columns SET position = ?, version = version + 1, updated_at = ? WHERE id = ? AND tenant_id = ?')
      .run(position, now(), columnId, tenantId);

    const column = getColumn(tenantId, columnId);
    const activity = recordActivity({ tenantId, boardId: column.board_id, userId: req.user.id, action: 'column.moved', entityType: 'column', entityId: columnId, details: { name: column.name } });
    return { column, activity, rebalanced };
  });

  if (result.rebalanced) hub.emitToTenant(tenantId, 'columns:reordered', { boardId: result.column.board_id, positions: result.rebalanced });
  hub.emitToTenant(tenantId, 'column:updated', { column: toColumn(result.column) });
  hub.emitToTenant(tenantId, 'activity:new', { activity: result.activity });
  res.json({ column: toColumn(result.column) });
});

// Only empty columns can be deleted. If someone is adding a card to it at the
// same moment, we'd rather refuse than silently destroy their work.
router.delete('/columns/:columnId', adminOnly, (req, res) => {
  const tenantId = req.tenant.id;
  const columnId = paramId(req.params.columnId, 'Column');

  const { column, activity } = transaction((db) => {
    const column = getColumn(tenantId, columnId);
    if (!column) throw notFound('Column');
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE tenant_id = ? AND column_id = ? AND deleted_at IS NULL').get(tenantId, columnId);
    if (n > 0) throw conflict(`Column still has ${n} task(s) - move or delete them first`);

    db.prepare('DELETE FROM columns WHERE id = ? AND tenant_id = ?').run(columnId, tenantId);
    const activity = recordActivity({ tenantId, boardId: column.board_id, userId: req.user.id, action: 'column.deleted', entityType: 'column', entityId: columnId, details: { name: column.name } });
    return { column, activity };
  });

  hub.emitToTenant(tenantId, 'column:deleted', { columnId, boardId: column.board_id });
  hub.emitToTenant(tenantId, 'activity:new', { activity });
  res.json({ ok: true });
});

module.exports = router;
