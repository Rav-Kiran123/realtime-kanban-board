// =====================================================================
//  Task detail panel
//  `base` = the copy of the task the form was filled from. When saving we
//  only send fields that differ from base, and we tell updateTask what we
//  expected (base values) so it can merge with other people's edits.
// =====================================================================
import { api, tp } from './api.js';
import { state, notify, columnById, memberById } from './store.js';
import { escapeHtml, toast, timeAgo, avatarHtml, safely, confirmDialog } from './ui.js';
import { updateTask, deleteTask } from './actions.js';
import { sendPresence } from './realtime.js';
import { describeActivity } from './panels.js';

const $ = (id) => document.getElementById(id);
const FIELDS = ['title', 'description', 'priority', 'assigneeId', 'dueDate'];

let currentId = null;
let base = null;
let saving = false;
let history = [];

export const openTaskId = () => currentId;
const norm = (v) => (v === undefined || v === '' ? null : v);

function readForm() {
  return {
    title: $('tp-title').value.trim(),
    description: $('tp-desc').value,
    priority: $('tp-priority').value,
    assigneeId: $('tp-assignee').value ? Number($('tp-assignee').value) : null,
    dueDate: $('tp-due').value || null,
  };
}

// fields where the form differs from base
function changedFields() {
  const form = readForm();
  const changes = {};
  for (const f of FIELDS) if (norm(form[f]) !== norm(base[f])) changes[f] = form[f];
  return changes;
}

const isDirty = () => base && Object.keys(changedFields()).length > 0;

function fillForm(task) {
  $('tp-title').value = task.title;
  $('tp-desc').value = task.description || '';
  $('tp-priority').value = task.priority;
  $('tp-due').value = task.dueDate || '';
  $('tp-assignee').innerHTML = '<option value="">— Unassigned —</option>'
    + state.members.map((m) => `<option value="${m.id}">${escapeHtml(m.name)}</option>`).join('');
  $('tp-assignee').value = task.assigneeId ?? '';
}

function renderHistory() {
  $('tp-history').innerHTML = history.length
    ? history.map((a) => `<li>${avatarHtml({ name: a.userName, avatarColor: a.userColor }, 'sm')}<div>${describeActivity(a)}<span class="when">${timeAgo(a.createdAt)}</span></div></li>`).join('')
    : '<li class="muted">No history yet</li>';
}

async function loadHistory(taskId) {
  const data = await api.get(tp(`/tasks/${taskId}`)).catch(() => null);
  if (data && currentId === taskId) {
    history = data.activity;
    renderHistory();
  }
}

export function openTask(taskId) {
  const task = state.tasks[taskId];
  if (!task) return;
  currentId = taskId;
  base = { ...task };
  history = [];
  fillForm(task);
  $('tp-notice').classList.add('hidden');
  $('task-panel').classList.remove('hidden');
  $('activity-panel').classList.add('hidden');
  sendPresence({ focusTaskId: taskId }); // others see 👀 on this card
  refreshPanel();
  renderHistory();
  loadHistory(taskId);
  notify(); // highlight the selected card
}

export function closeTask() {
  if (currentId === null) return;
  currentId = null;
  base = null;
  $('task-panel').classList.add('hidden');
  sendPresence({ focusTaskId: null });
  notify();
}

// called on every store change
export function refreshPanel() {
  if (currentId === null) return;
  const task = state.tasks[currentId];
  if (!task) {
    closeTask();
    toast('This task was deleted (or moved out of view) by someone else', 'warn');
    return;
  }

  // someone else saved a newer version while the panel is open
  if (!saving && task.version !== base.version) {
    if (isDirty()) {
      const who = memberById(task.updatedBy)?.name || 'Someone';
      $('tp-notice').textContent = `${who} just changed this task. When you save, your edits are merged with theirs (you'll be asked if you both changed the same field).`;
      $('tp-notice').classList.remove('hidden');
    } else {
      base = { ...task }; // nothing typed yet -> just show the new data
      fillForm(task);
    }
  }

  const col = columnById(task.columnId);
  $('tp-column').textContent = col ? `In "${col.name}"` : '';
  const editor = memberById(task.updatedBy);
  $('tp-meta').textContent = `Version ${task.version}${editor ? ` · last change by ${editor.name}` : ''}${task.updatedAt ? ` · ${timeAgo(task.updatedAt)}` : ''}`;

  const others = state.presence.filter((p) => p.focusTaskId === currentId && p.userId !== state.user?.id);
  $('tp-viewers').innerHTML = others.length ? `👀 ${others.map((p) => escapeHtml(p.name)).join(', ')} also ${others.length > 1 ? 'have' : 'has'} this task open` : '';
}

// live history entries for the open task
export function onTaskActivity(activity) {
  if (activity.entityType === 'task' && activity.entityId === currentId) {
    history.unshift(activity);
    renderHistory();
  }
}

async function save(e) {
  e.preventDefault();
  if (currentId === null) return;
  const changes = changedFields();
  if (Object.keys(changes).length === 0) return toast('Nothing changed');
  if ('title' in changes && !changes.title) return toast('Title cannot be empty', 'error');

  const expected = Object.fromEntries(Object.keys(changes).map((k) => [k, base[k] ?? null]));
  saving = true;
  try {
    await updateTask(currentId, changes, { expected });
    base = { ...state.tasks[currentId] };
    fillForm(base);
    $('tp-notice').classList.add('hidden');
    toast('Saved', 'success', 1500);
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    saving = false;
    refreshPanel();
  }
}

export function initTaskPanel() {
  $('task-form').addEventListener('submit', save);
  $('tp-close').addEventListener('click', closeTask);
  $('tp-delete').addEventListener('click', async () => {
    const id = currentId;
    const task = state.tasks[id];
    if (!task || !(await confirmDialog('Delete task', `Delete "${task.title}"? (You can undo with Ctrl+Z)`))) return;
    closeTask();
    safely(() => deleteTask(id));
  });
}
