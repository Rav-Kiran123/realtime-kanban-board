// =====================================================================
//  Ordering with "fractional indexing"
//
//  Every task/column has a REAL `position`. To put an item between A and B we
//  just give it (A + B) / 2. So a drag & drop only updates ONE row instead of
//  renumbering the whole column. Much cheaper, and two people moving different
//  cards don't touch each other's rows at all.
//
//  When numbers get too close (after ~40 inserts in the same gap) we
//  "rebalance" the list back to 1024, 2048, 3072 ... and tell the clients.
//
//  IMPORTANT for drag-drop conflicts: the client only sends the IDs of the
//  neighbours it dropped between (prevId / nextId), never a raw number. The
//  server looks those neighbours up in the CURRENT database state. If a
//  neighbour was moved away by someone else meanwhile, we fall back gracefully
//  (see placeBetween) instead of failing.
// =====================================================================
const { getDb } = require('../db/database');

const GAP = 1024;
const MIN_GAP = 1e-6;

function positionBetween(prevPos, nextPos) {
  if (prevPos == null && nextPos == null) return GAP;    // empty list
  if (prevPos == null) return nextPos - GAP;             // put at the top
  if (nextPos == null) return prevPos + GAP;             // put at the bottom
  return (prevPos + nextPos) / 2;                        // somewhere in the middle
}

// Scopes describe "which list" we are ordering. Table/where are hard-coded
// here (never user input), so building SQL with them is safe.
const taskScope = (tenantId, columnId) => ({
  table: 'tasks',
  where: 'tenant_id = ? AND column_id = ? AND deleted_at IS NULL',
  params: [tenantId, columnId],
});

const columnScope = (tenantId, boardId) => ({
  table: 'columns',
  where: 'tenant_id = ? AND board_id = ?',
  params: [tenantId, boardId],
});

// Renumber a whole list to 1024, 2048, ... Returns the new positions.
function rebalance(scope) {
  const db = getDb();
  const rows = db.prepare(`SELECT id FROM ${scope.table} WHERE ${scope.where} ORDER BY position, id`).all(...scope.params);
  const update = db.prepare(`UPDATE ${scope.table} SET position = ? WHERE id = ?`);
  return rows.map((row, i) => {
    const position = (i + 1) * GAP;
    update.run(position, row.id);
    return { id: row.id, position };
  });
}

/**
 * Figures out the position for an item dropped between prevId and nextId.
 * `movingId` is excluded from the lookups (it's the thing being moved).
 *
 * Fallback rules (this is how drag-drop conflicts are resolved):
 *   1. prev still exists in this list  -> go right after prev
 *   2. else next still exists          -> go right before next
 *   3. else (both moved away / none)   -> go to the end of the list
 * We always re-read the REAL neighbour, so the result is always a valid slot.
 */
function placeBetween(scope, prevId, nextId, movingId = null, alreadyRebalanced = false) {
  const db = getDb();
  const base = `FROM ${scope.table} WHERE ${scope.where} AND id <> ?`;
  const params = [...scope.params, movingId ?? -1];

  const findById = (id) => (id ? db.prepare(`SELECT id, position ${base} AND id = ?`).get(...params, id) : undefined);
  const firstAfter = (pos) => db.prepare(`SELECT id, position ${base} AND position > ? ORDER BY position ASC LIMIT 1`).get(...params, pos);
  const lastBefore = (pos) => db.prepare(`SELECT id, position ${base} AND position < ? ORDER BY position DESC LIMIT 1`).get(...params, pos);
  const lastItem = () => db.prepare(`SELECT id, position ${base} ORDER BY position DESC LIMIT 1`).get(...params);

  let prev = findById(prevId);
  let next;
  if (prev) {
    next = firstAfter(prev.position);
  } else {
    next = findById(nextId);
    if (next) prev = lastBefore(next.position);
    else prev = lastItem();
  }

  // numbers are too close together -> renumber the list once, then try again
  if (prev && next && next.position - prev.position < MIN_GAP && !alreadyRebalanced) {
    const rebalanced = rebalance(scope);
    const retry = placeBetween(scope, prevId, nextId, movingId, true);
    return { position: retry.position, rebalanced };
  }

  return { position: positionBetween(prev?.position, next?.position), rebalanced: null };
}

module.exports = { GAP, positionBetween, placeBetween, taskScope, columnScope, rebalance };
