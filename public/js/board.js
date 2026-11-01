// =====================================================================
//  Kanban board rendering + drag & drop (native HTML5 DnD, no library)
//
//  I simply re-render the whole board from `state` whenever something
//  changes. It's a few dozen cards, so that's fast enough and much easier
//  to get right than patching the DOM by hand. Two tricks make it usable:
//    * no re-render WHILE dragging (it would cancel the drag)
//    * keep the text + focus of the "add task" input you're typing in
// =====================================================================
import { state, hasRole, tasksInColumn, sortedColumns, memberById } from './store.js';
import { escapeHtml, avatarHtml, safely } from './ui.js';
import * as actions from './actions.js';
import { openTask, openTaskId } from './taskPanel.js';

const boardEl = () => document.getElementById('board');
let drag = null;            // { taskId, fromColumnId, prevId, nextId, el }
let renderPending = false;
const placeholder = document.createElement('div');
placeholder.className = 'card-placeholder';

// ---------------- rendering ----------------

function cardHtml(task, viewersByTask) {
  const assignee = memberById(task.assigneeId);
  const viewers = viewersByTask.get(task.id) || [];
  const today = new Date().toISOString().slice(0, 10);
  const overdue = task.dueDate && task.dueDate < today;

  return `
    <article class="card prio-${escapeHtml(task.priority)} ${task.pending ? 'pending' : ''} ${openTaskId() === task.id ? 'selected' : ''}"
             draggable="${task.pending ? 'false' : 'true'}" data-task-id="${escapeHtml(task.id)}">
      <div class="card-title">${escapeHtml(task.title)}</div>
      <div class="card-meta">
        <span class="chip">${escapeHtml(task.priority)}</span>
        ${task.dueDate ? `<span class="chip ${overdue ? 'overdue' : ''}">📅 ${escapeHtml(task.dueDate)}</span>` : ''}
        ${task.description ? '<span title="Has a description">📝</span>' : ''}
        <span class="spacer"></span>
        ${viewers.length ? `<span class="viewing" title="Open by ${escapeHtml(viewers.map((v) => v.name).join(', '))}">👀 ${viewers.length}</span>` : ''}
        ${assignee ? avatarHtml(assignee, 'sm') : ''}
      </div>
    </article>`;
}

function columnHtml(col, index, total, isAdmin, viewersByTask) {
  const tasks = tasksInColumn(col.id);
  const over = col.wipLimit && tasks.length > col.wipLimit;
  return `
    <section class="column" data-column-id="${col.id}">
      <header class="column-header">
        <h3 title="${escapeHtml(col.name)}">${escapeHtml(col.name)}</h3>
        <span class="count ${over ? 'over' : ''}" title="${col.wipLimit ? 'WIP limit ' + col.wipLimit : ''}">${tasks.length}${col.wipLimit ? ' / ' + col.wipLimit : ''}</span>
        ${isAdmin ? `
          <div class="col-actions">
            <button class="icon-btn" data-action="col-left" ${index === 0 ? 'disabled' : ''} title="Move left">◀</button>
            <button class="icon-btn" data-action="col-right" ${index === total - 1 ? 'disabled' : ''} title="Move right">▶</button>
            <button class="icon-btn" data-action="col-edit" title="Rename / WIP limit">✎</button>
            <button class="icon-btn" data-action="col-delete" title="Delete column">🗑</button>
          </div>` : ''}
      </header>
      <div class="task-list" data-column-id="${col.id}">
        ${tasks.map((t) => cardHtml(t, viewersByTask)).join('')}
      </div>
      <form class="add-task" data-column-id="${col.id}">
        <input name="title" data-key="add-${col.id}" placeholder="+ Add a task" maxlength="200" autocomplete="off">
      </form>
    </section>`;
}

export function renderBoard() {
  const el = boardEl();
  if (state.dragging) { renderPending = true; return; }
  renderPending = false;

  if (!state.tenantId) {
    el.innerHTML = '<div class="empty-state"><h2>No branch selected</h2><p>Pick an organization and branch at the top, or create a new organization with ＋.</p></div>';
    return;
  }
  if (state.loadingTenant) {
    el.innerHTML = '<div class="empty-state">Loading branch…</div>';
    return;
  }
  if (!state.boardId) {
    el.innerHTML = `<div class="empty-state"><h2>No boards yet</h2><p>${hasRole('TENANT_ADMIN') ? 'Create one with the ＋ next to "Board".' : 'Ask a branch admin to create one.'}</p></div>`;
    return;
  }
  if (!state.board) {
    el.innerHTML = '<div class="empty-state">Loading board…</div>';
    return;
  }

  // who (other than me) has which card open -> 👀 badge on cards
  const viewersByTask = new Map();
  for (const p of state.presence) {
    if (p.userId === state.user?.id || !p.focusTaskId) continue;
    if (!viewersByTask.has(p.focusTaskId)) viewersByTask.set(p.focusTaskId, []);
    viewersByTask.get(p.focusTaskId).push(p);
  }

  // remember focus/typing + scroll positions so re-rendering doesn't annoy the user
  const active = document.activeElement;
  const focusKey = active?.dataset?.key;
  const focusValue = active?.value;
  const scrolls = [...el.querySelectorAll('.task-list')].map((l) => [l.dataset.columnId, l.scrollTop]);

  const isAdmin = hasRole('TENANT_ADMIN');
  const cols = sortedColumns();
  el.innerHTML = cols.map((c, i) => columnHtml(c, i, cols.length, isAdmin, viewersByTask)).join('')
    + (isAdmin ? '<button class="add-column" data-action="add-column">＋ Add column</button>' : '');

  for (const [id, top] of scrolls) {
    const list = el.querySelector(`.task-list[data-column-id="${id}"]`);
    if (list) list.scrollTop = top;
  }
  if (focusKey) {
    const input = el.querySelector(`[data-key="${focusKey}"]`);
    if (input) { input.value = focusValue; input.focus(); }
  }
}

// ---------------- drag & drop helpers ----------------

const cardId = (card) => {
  const n = Number(card?.dataset.taskId);
  return Number.isInteger(n) ? n : null; // ignore pending "tmp-" cards
};

// first card whose middle is below the mouse -> we insert before it
function cardAfterPointer(list, y) {
  return [...list.querySelectorAll('.card:not(.dragging)')].find((c) => {
    const box = c.getBoundingClientRect();
    return y < box.top + box.height / 2;
  });
}

function siblingCard(el, direction) {
  let node = el[direction];
  while (node && (!node.classList.contains('card') || node.classList.contains('dragging'))) node = node[direction];
  return node;
}

function endDrag() {
  placeholder.remove();
  drag?.el.classList.remove('dragging');
  drag = null;
  state.dragging = false;
  if (renderPending) renderBoard();
}

// ---------------- event wiring (event delegation = one listener per event type) ----------------

export function initBoard() {
  const el = boardEl();

  el.addEventListener('click', (e) => {
    const actionBtn = e.target.closest('[data-action]');
    if (actionBtn) {
      const columnId = Number(actionBtn.closest('.column')?.dataset.columnId);
      const run = {
        'add-column': () => actions.addColumn(),
        'col-left': () => actions.shiftColumn(columnId, -1),
        'col-right': () => actions.shiftColumn(columnId, +1),
        'col-edit': () => actions.editColumn(columnId),
        'col-delete': () => actions.deleteColumn(columnId),
      }[actionBtn.dataset.action];
      if (run) safely(run);
      return;
    }
    const card = e.target.closest('.card');
    if (card && cardId(card)) openTask(cardId(card));
  });

  // quick-add task at the bottom of a column
  el.addEventListener('submit', (e) => {
    const form = e.target.closest('.add-task');
    if (!form) return;
    e.preventDefault();
    const input = form.elements.title;
    const title = input.value.trim();
    if (!title) return;
    input.value = '';
    safely(() => actions.createTask(Number(form.dataset.columnId), title));
  });

  el.addEventListener('dragstart', (e) => {
    const card = e.target.closest('.card');
    const taskId = cardId(card);
    if (!taskId) return e.preventDefault();

    const task = state.tasks[taskId];
    drag = {
      taskId,
      el: card,
      fromColumnId: task.columnId,
      prevId: cardId(siblingCard(card, 'previousElementSibling')),
      nextId: cardId(siblingCard(card, 'nextElementSibling')),
    };
    state.dragging = true;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(taskId)); // Firefox needs some data

    placeholder.style.height = `${card.offsetHeight}px`;
    // hide the real card on the next frame (after the browser took its drag picture)
    requestAnimationFrame(() => {
      card.classList.add('dragging');
      card.after(placeholder);
    });
  });

  el.addEventListener('dragover', (e) => {
    const list = e.target.closest('.column')?.querySelector('.task-list');
    if (!drag || !list) return;
    e.preventDefault(); // allows dropping
    e.dataTransfer.dropEffect = 'move';
    const after = cardAfterPointer(list, e.clientY);
    if (after) list.insertBefore(placeholder, after);
    else list.appendChild(placeholder);
  });

  el.addEventListener('drop', (e) => {
    const list = e.target.closest('.column')?.querySelector('.task-list');
    if (!drag || !list) return;
    e.preventDefault();

    const columnId = Number(list.dataset.columnId);
    const prevId = cardId(siblingCard(placeholder, 'previousElementSibling'));
    const nextId = cardId(siblingCard(placeholder, 'nextElementSibling'));
    const { taskId, fromColumnId } = drag;
    const unchanged = columnId === fromColumnId && prevId === drag.prevId && nextId === drag.nextId;
    endDrag();

    // only send what we know: the card + the ids of its new neighbours
    if (!unchanged) safely(() => actions.moveTask(taskId, columnId, prevId, nextId));
  });

  // dropped outside a column / pressed Esc
  el.addEventListener('dragend', () => { if (drag) endDrag(); });
}
