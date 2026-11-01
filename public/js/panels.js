// Activity side panel + "Members" dialog
import { api, tp } from './api.js';
import { state, hasRole } from './store.js';
import { escapeHtml, avatarHtml, timeAgo, modal, toast, safely } from './ui.js';

const q = (s) => `“${escapeHtml(s)}”`;

// turns an activity row into a readable sentence (HTML, already escaped)
export function describeActivity(a) {
  const d = a.details || {};
  const who = `<b>${escapeHtml(a.userName)}</b>`;
  switch (a.action) {
    case 'task.created': return `${who} created ${q(d.title)} in ${escapeHtml(d.columnName)}`;
    case 'task.updated': return `${who} edited ${q(d.title)} <span class="muted">(${escapeHtml((d.fields || []).join(', '))})</span>`;
    case 'task.moved': return d.fromColumn === d.toColumn
      ? `${who} reordered ${q(d.title)} in ${escapeHtml(d.toColumn)}`
      : `${who} moved ${q(d.title)} from ${escapeHtml(d.fromColumn)} → ${escapeHtml(d.toColumn)}`;
    case 'task.deleted': return `${who} deleted ${q(d.title)}`;
    case 'task.restored': return `${who} restored ${q(d.title)}`;
    case 'column.created': return `${who} added column ${q(d.name)}`;
    case 'column.updated': return d.oldName && d.oldName !== d.name ? `${who} renamed column ${q(d.oldName)} → ${q(d.name)}` : `${who} updated column ${q(d.name)}`;
    case 'column.moved': return `${who} moved column ${q(d.name)}`;
    case 'column.deleted': return `${who} deleted column ${q(d.name)}`;
    case 'board.created': return `${who} created board ${q(d.name)}`;
    case 'board.updated': return `${who} renamed board to ${q(d.name)}`;
    case 'board.deleted': return `${who} deleted board ${q(d.name)}`;
    case 'member.added': return `${who} added ${escapeHtml(d.userName)} as ${escapeHtml(d.role)}`;
    case 'member.role_changed': return `${who} made ${escapeHtml(d.userName)} ${escapeHtml(d.role)}`;
    case 'member.removed': return `${who} removed ${escapeHtml(d.userName)} from the branch`;
    default: return `${who} ${escapeHtml(a.action)}`;
  }
}

export function renderActivity() {
  const list = document.getElementById('activity-list');
  if (document.getElementById('activity-panel').classList.contains('hidden')) return;
  list.innerHTML = state.activity.length
    ? state.activity.map((a) => `
        <li class="${a.isNew ? 'new' : ''}">
          ${avatarHtml({ name: a.userName, avatarColor: a.userColor }, 'sm')}
          <div>${describeActivity(a)}<span class="when">${timeAgo(a.createdAt)}</span></div>
        </li>`).join('')
    : '<li class="muted">Nothing happened here yet</li>';
  state.activity.forEach((a) => { a.isNew = false; }); // only flash once
}

// ---------------- members dialog ----------------

function membersHtml(members, canManage) {
  return members.map((m) => {
    const editable = canManage && m.role !== 'ORG_ADMIN';
    return `
      <div class="member-row" data-user-id="${m.id}">
        ${avatarHtml(m)}
        <div class="info"><b>${escapeHtml(m.name)}</b><br><span class="muted small">${escapeHtml(m.email)}</span></div>
        ${editable ? `
          <select data-role>
            <option value="MEMBER" ${m.role === 'MEMBER' ? 'selected' : ''}>Member</option>
            <option value="TENANT_ADMIN" ${m.role === 'TENANT_ADMIN' ? 'selected' : ''}>Tenant Admin</option>
          </select>
          <button type="button" class="icon-btn" data-remove title="Remove from branch">✕</button>`
        : `<span class="role-badge">${escapeHtml(m.role.replace('_', ' '))}</span>`}
      </div>`;
  }).join('');
}

export async function openMembersDialog() {
  const canManage = hasRole('TENANT_ADMIN');
  const body = document.createElement('div');

  const draw = () => {
    body.innerHTML = `
      <div class="members">${membersHtml(state.members, canManage)}</div>
      ${canManage ? `
        <h4>Add someone to this branch</h4>
        <div class="row">
          <input data-email type="email" placeholder="their@email.com (must be registered)">
          <select data-new-role style="max-width:140px"><option value="MEMBER">Member</option><option value="TENANT_ADMIN">Tenant Admin</option></select>
          <button type="button" class="btn primary" data-add style="flex:0">Add</button>
        </div>` : '<p class="small muted">Only branch admins can change members.</p>'}
      <p class="small muted">Org admins can see every branch automatically.</p>`;
  };
  draw();

  const update = async (fn) => {
    const res = await safely(fn);
    if (res?.members) { state.members = res.members; draw(); }
  };

  body.addEventListener('change', (e) => {
    if (!e.target.matches('[data-role]')) return;
    const userId = e.target.closest('.member-row').dataset.userId;
    update(() => api.patch(tp(`/members/${userId}`), { role: e.target.value }));
  });
  body.addEventListener('click', (e) => {
    if (e.target.matches('[data-remove]')) {
      const userId = e.target.closest('.member-row').dataset.userId;
      update(() => api.del(tp(`/members/${userId}`)));
    }
    if (e.target.matches('[data-add]')) {
      const email = body.querySelector('[data-email]').value.trim();
      if (!email) return toast('Enter an email first', 'warn');
      update(() => api.post(tp('/members'), { email, role: body.querySelector('[data-new-role]').value }));
    }
  });

  await modal({ title: `Members of ${document.getElementById('tenant-select').selectedOptions[0]?.text || 'branch'}`, body, buttons: [{ label: 'Close', value: true }] });
}
