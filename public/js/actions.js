// =====================================================================
//  Actions = things the user does. Task actions are OPTIMISTIC:
//    1. change local state right away (UI feels instant)
//    2. call the API
//    3. success -> replace with the server copy, push an undo command
//       failure -> roll back (or take the server's latest copy on 409)
// =====================================================================
import { api, tp } from './api.js';
import {
  state, notify, upsertTask, removeTask, upsertColumn, upsertBoard, tasksInColumn, sortedColumns,
  localPosition, pendingCreates, columnById,
} from './store.js';
import { pushHistory } from './history.js';
import { findClashes, askUserToResolve } from './conflict.js';
import { promptText, confirmDialog, toast } from './ui.js';

const pick = (obj, keys) => Object.fromEntries(keys.map((k) => [k, obj[k] ?? null]));
const realId = (id) => (Number.isInteger(id) ? id : null); // temp cards have string ids

// put the server copy in, even if its version equals ours
function replaceTask(task) {
  if (task.boardId !== state.boardId) return;
  state.tasks[task.id] = task;
  notify();
}

// ids of the cards directly above/below a task (used to undo a move)
function neighboursOf(task) {
  const list = tasksInColumn(task.columnId).filter((t) => t.id !== task.id);
  const index = list.findIndex((t) => t.position > task.position);
  const prev = index === -1 ? list.at(-1) : list[index - 1];
  const next = index === -1 ? null : list[index];
  return { prevId: realId(prev?.id), nextId: realId(next?.id) };
}

// ---------------- tasks ----------------

export async function createTask(columnId, title) {
  const clientKey = `ck-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const tempId = `tmp-${clientKey}`;
  const last = tasksInColumn(columnId).at(-1);

  // 1. optimistic "ghost" card
  state.tasks[tempId] = {
    id: tempId, boardId: state.boardId, columnId, title, description: '', priority: 'medium',
    assigneeId: null, dueDate: null, position: (last?.position ?? 0) + 1024, version: 0, pending: true,
  };
  pendingCreates.add(clientKey);
  notify();

  try {
    // 2. real request
    const { task } = await api.post(tp(`/boards/${state.boardId}/tasks`), {
      columnId, title, prevTaskId: realId(last?.id), clientKey,
    });
    // 3. swap the ghost for the real card
    delete state.tasks[tempId];
    upsertTask(task);
    pushHistory({
      label: `Create "${task.title}"`,
      undo: () => deleteTask(task.id, { record: false }),
      redo: () => restoreTask(task.id),
    });
    return task;
  } catch (err) {
    removeTask(tempId);
    throw err;
  } finally {
    pendingCreates.delete(clientKey);
  }
}

/**
 * Save some fields of a task.
 *   changes  = { title: 'new' }            what I want
 *   expected = { title: 'old' }            what I think is on the server now (for merging)
 *   interactive = false -> on a real clash just fail (used by undo/redo)
 */
export async function updateTask(taskId, changes, { expected, interactive = true, record = true } = {}) {
  const local = state.tasks[taskId];
  if (!local) throw new Error('Task no longer exists');
  const keys = Object.keys(changes);
  expected = expected ?? pick(local, keys);

  // Pre-check against our LOCAL copy first. Thanks to the websocket it may
  // already hold someone else's newer version - if so, its version number
  // would let our PATCH pass the server check and silently overwrite them.
  const localClashes = findClashes(expected, changes, local);
  if (localClashes.length > 0) {
    if (!interactive) throw new Error('someone else changed it meanwhile');
    const choice = await askUserToResolve(local, localClashes);
    if (choice === 'theirs') return local;
  }

  const snapshot = { ...state.tasks[taskId] ?? local };
  state.tasks[taskId] = { ...local, ...changes }; // optimistic
  notify();

  let version = snapshot.version;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { task } = await api.patch(tp(`/tasks/${taskId}`), { version, ...changes });
      replaceTask(task);
      if (record) {
        pushHistory({
          label: `Edit "${task.title}"`,
          // undo = put the old values back, expecting my new values to still be there
          undo: () => updateTask(taskId, expected, { expected: changes, interactive: false, record: false }),
          redo: () => updateTask(taskId, changes, { expected, interactive: false, record: false }),
        });
      }
      return task;
    } catch (err) {
      if (err.status === 409 && err.data.current) {
        const theirs = err.data.current;
        const clashes = findClashes(expected, changes, theirs);

        if (clashes.length > 0) {
          if (!interactive) { replaceTask(theirs); throw new Error('someone else changed it meanwhile'); }
          const choice = await askUserToResolve(theirs, clashes);
          if (choice === 'theirs') { replaceTask(theirs); return theirs; }
        }
        // no clash (or "keep mine") -> retry on top of their version
        version = theirs.version;
        continue;
      }
      // network error etc. -> roll back, unless a newer copy arrived meanwhile
      if (state.tasks[taskId]?.version === snapshot.version) state.tasks[taskId] = snapshot;
      notify();
      throw err;
    }
  }
  throw new Error('Too many conflicting edits, please try again');
}

export async function moveTask(taskId, columnId, prevId, nextId, { record = true } = {}) {
  const task = state.tasks[taskId];
  if (!task) throw new Error('Task no longer exists');
  const from = { columnId: task.columnId, ...neighboursOf(task) };
  const snapshot = { ...task };

  // optimistic: just move it locally
  state.tasks[taskId] = { ...task, columnId, position: localPosition(prevId, nextId) };
  notify();

  try {
    const { task: saved } = await api.post(tp(`/tasks/${taskId}/move`), {
      version: snapshot.version, columnId, prevTaskId: prevId, nextTaskId: nextId,
    });
    replaceTask(saved);
    if (record) {
      const fromName = columnById(from.columnId)?.name;
      const toName = columnById(columnId)?.name;
      pushHistory({
        label: fromName === toName ? `Reorder "${saved.title}"` : `Move "${saved.title}" to ${toName}`,
        undo: () => moveTask(taskId, from.columnId, from.prevId, from.nextId, { record: false }),
        redo: () => moveTask(taskId, columnId, prevId, nextId, { record: false }),
      });
    }
    return saved;
  } catch (err) {
    if (err.status === 409 && err.data.current) {
      // drag-drop conflict: someone changed the card first -> show their version
      replaceTask(err.data.current);
      throw new Error(`${err.message}. The card was refreshed - try again.`);
    }
    if (err.status === 404) removeTask(taskId);
    else if (state.tasks[taskId]?.version === snapshot.version) replaceTask(snapshot);
    throw err;
  }
}

export async function deleteTask(taskId, { record = true } = {}) {
  const task = state.tasks[taskId];
  if (!task) return;
  removeTask(taskId); // optimistic

  try {
    await api.del(tp(`/tasks/${taskId}`), { version: task.version });
    if (record) {
      pushHistory({
        label: `Delete "${task.title}"`,
        undo: () => restoreTask(taskId),
        redo: () => deleteTask(taskId, { record: false }),
      });
    }
  } catch (err) {
    if (err.status === 409 && err.data.current) replaceTask(err.data.current);
    else if (err.status !== 404) replaceTask(task);
    throw err;
  }
}

export async function restoreTask(taskId) {
  const { task } = await api.post(tp(`/tasks/${taskId}/restore`));
  upsertTask(task);
  return task;
}

// ---------------- boards / columns (admin only, not optimistic) ----------------

export async function createBoard() {
  const name = await promptText('New board', { label: 'Board name', placeholder: 'e.g. Marketing' });
  if (!name) return null;
  const { board } = await api.post(tp('/boards'), { name });
  upsertBoard(board);
  return board;
}

export async function renameBoard() {
  if (!state.board) return;
  const name = await promptText('Rename board', { label: 'Board name', value: state.board.name });
  if (!name) return;
  const { board } = await api.patch(tp(`/boards/${state.board.id}`), { version: state.board.version, name });
  upsertBoard(board);
}

export async function deleteBoard() {
  if (!state.board) return false;
  const ok = await confirmDialog('Delete board', `Delete "${state.board.name}" and ALL its tasks? This cannot be undone.`);
  if (!ok) return false;
  await api.del(tp(`/boards/${state.board.id}`));
  return true;
}

export async function addColumn() {
  const name = await promptText('New column', { label: 'Column name', placeholder: 'e.g. Blocked' });
  if (!name) return;
  const { column } = await api.post(tp(`/boards/${state.boardId}/columns`), { name });
  upsertColumn(column);
}

export async function editColumn(columnId) {
  const col = columnById(columnId);
  if (!col) return;
  const name = await promptText('Edit column', { label: 'Column name', value: col.name });
  if (!name) return;
  const limitText = await promptText('WIP limit (optional)', { label: 'Max tasks in this column - leave empty for no limit', value: col.wipLimit ?? '' });
  const wipLimit = limitText ? Number(limitText) : null;
  const { column } = await api.patch(tp(`/columns/${columnId}`), { version: col.version, name, wipLimit });
  upsertColumn(column);
}

export async function deleteColumn(columnId) {
  const col = columnById(columnId);
  if (!col) return;
  if (!(await confirmDialog('Delete column', `Delete the empty column "${col.name}"?`))) return;
  await api.del(tp(`/columns/${columnId}`));
  state.columns = state.columns.filter((c) => c.id !== columnId);
  notify();
}

// dir = -1 (left) or +1 (right)
export async function shiftColumn(columnId, dir) {
  const cols = sortedColumns();
  const i = cols.findIndex((c) => c.id === columnId);
  const j = i + dir;
  if (i === -1 || j < 0 || j >= cols.length) return;
  const prevColumnId = dir < 0 ? cols[j - 1]?.id ?? null : cols[j].id;
  const nextColumnId = dir < 0 ? cols[j].id : cols[j + 1]?.id ?? null;
  const { column } = await api.post(tp(`/columns/${columnId}/move`), { version: cols[i].version, prevColumnId, nextColumnId });
  upsertColumn(column);
}

// ---------------- orgs / branches ----------------

export async function createOrg() {
  const name = await promptText('New organization', { label: 'Organization name' });
  if (!name) return null;
  const { org } = await api.post('/orgs', { name });
  toast(`Created ${org.name} (with a "Head Office" branch)`, 'success');
  return org;
}

export async function createTenant() {
  const name = await promptText('New branch', { label: 'Branch name', placeholder: 'e.g. Chennai Branch' });
  if (!name) return null;
  const { tenant } = await api.post(`/orgs/${state.orgId}/tenants`, { name });
  toast(`Branch "${tenant.name}" created`, 'success');
  return tenant;
}
