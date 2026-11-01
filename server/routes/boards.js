// /api/tenants/:tenantId/boards
// Note: req.tenant is already checked by loadTenant before we get here.
const express = require('express');
const { transaction, now } = require('../db/database');
const { getBoard, listBoards, listColumns, listTasks, createBoard } = require('../services/boards');
const { recordActivity } = require('../services/activity');
const { requireRole } = require('../middleware/access');
const { requireText, optionalText, requireVersion, paramId } = require('../utils/validate');
const { notFound, versionConflict } = require('../utils/httpError');
const { toBoard, toColumn, toTask } = require('../utils/mappers');
const hub = require('../realtime/hub');

const router = express.Router({ mergeParams: true });

router.get('/boards', (req, res) => {
  res.json({ boards: listBoards(req.tenant.id).map(toBoard) });
});

// one call returns everything needed to draw the board
router.get('/boards/:boardId', (req, res) => {
  const tenantId = req.tenant.id;
  const board = getBoard(tenantId, paramId(req.params.boardId, 'Board'));
  if (!board) throw notFound('Board');

  res.json({
    board: toBoard(board),
    columns: listColumns(tenantId, board.id).map(toColumn),
    tasks: listTasks(tenantId, board.id).map(toTask),
  });
});

router.post('/boards', requireRole('TENANT_ADMIN'), (req, res) => {
  const tenantId = req.tenant.id;
  const name = requireText(req.body?.name, 'name', 100);
  const description = optionalText(req.body?.description, 'description', 1000) ?? '';

  const { board, activity } = transaction(() => {
    const board = createBoard({ tenantId, name, description, userId: req.user.id, withDefaultColumns: req.body?.withDefaultColumns !== false });
    const activity = recordActivity({ tenantId, boardId: board.id, userId: req.user.id, action: 'board.created', entityType: 'board', entityId: board.id, details: { name } });
    return { board, activity };
  });

  hub.emitToTenant(tenantId, 'board:created', { board: toBoard(board) });
  hub.emitToTenant(tenantId, 'activity:new', { activity });
  res.status(201).json({ board: toBoard(board) });
});

router.patch('/boards/:boardId', requireRole('TENANT_ADMIN'), (req, res) => {
  const tenantId = req.tenant.id;
  const boardId = paramId(req.params.boardId, 'Board');
  const version = requireVersion(req.body?.version);
  const name = req.body?.name !== undefined ? requireText(req.body.name, 'name', 100) : undefined;
  const description = optionalText(req.body?.description, 'description', 1000);

  const { board, activity } = transaction((db) => {
    const current = getBoard(tenantId, boardId);
    if (!current) throw notFound('Board');
    if (current.version !== version) throw versionConflict(toBoard(current));

    db.prepare(`
      UPDATE boards SET name = ?, description = ?, version = version + 1, updated_at = ?
      WHERE id = ? AND tenant_id = ? AND version = ?
    `).run(name ?? current.name, description ?? current.description, now(), boardId, tenantId, version);

    const board = getBoard(tenantId, boardId);
    const activity = recordActivity({ tenantId, boardId, userId: req.user.id, action: 'board.updated', entityType: 'board', entityId: boardId, details: { name: board.name, oldName: current.name } });
    return { board, activity };
  });

  hub.emitToTenant(tenantId, 'board:updated', { board: toBoard(board) });
  hub.emitToTenant(tenantId, 'activity:new', { activity });
  res.json({ board: toBoard(board) });
});

router.delete('/boards/:boardId', requireRole('TENANT_ADMIN'), (req, res) => {
  const tenantId = req.tenant.id;
  const boardId = paramId(req.params.boardId, 'Board');

  const activity = transaction((db) => {
    const current = getBoard(tenantId, boardId);
    if (!current) throw notFound('Board');
    db.prepare('DELETE FROM boards WHERE id = ? AND tenant_id = ?').run(boardId, tenantId); // columns + tasks cascade
    // board_id = NULL because the board doesn't exist any more
    return recordActivity({ tenantId, userId: req.user.id, action: 'board.deleted', entityType: 'board', entityId: boardId, details: { name: current.name } });
  });

  hub.emitToTenant(tenantId, 'board:deleted', { boardId });
  hub.emitToTenant(tenantId, 'activity:new', { activity });
  res.json({ ok: true });
});

module.exports = router;
