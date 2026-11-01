// Little UI helpers: escaping, toasts, modals, avatars, "2m ago".

// ALWAYS escape user text before putting it in innerHTML (XSS protection)
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function initials(name = '?') {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
}

// colour comes from our own DB, but we still only allow "#abc123" style values
const safeColor = (c) => (/^#[0-9a-f]{3,8}$/i.test(c || '') ? c : '#6b7385');

export function avatarHtml(user, extraClass = '') {
  if (!user) return '';
  const color = safeColor(user.avatarColor || user.color);
  return `<span class="avatar ${extraClass}" style="background:${color};color:${color}" title="${escapeHtml(user.name)}"><span style="color:#fff">${escapeHtml(initials(user.name))}</span></span>`;
}

export function timeAgo(iso) {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

// ---------- toasts ----------
export function toast(message, type = 'info', ms = 3500) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => el.remove(), ms);
}

// Runs an async action and shows a toast if it fails (keeps event handlers short)
export async function safely(fn) {
  try {
    return await fn();
  } catch (err) {
    toast(err.message || 'Something went wrong', 'error');
    return null;
  }
}

// ---------- modal ----------
// buttons: [{ label, value, kind: 'primary' | 'danger' }]
// Resolves with the clicked button's value (null when closed with Esc / outside click).
export function modal({ title, body, buttons = [{ label: 'OK', value: true, kind: 'primary' }], onOpen }) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <form class="modal">
        <h3>${escapeHtml(title)}</h3>
        <div class="modal-body"></div>
        <div class="modal-buttons">
          ${buttons.map((b, i) => `<button type="${b.kind === 'primary' ? 'submit' : 'button'}" class="btn ${b.kind || ''}" data-i="${i}">${escapeHtml(b.label)}</button>`).join('')}
        </div>
      </form>`;

    const bodyEl = overlay.querySelector('.modal-body');
    if (typeof body === 'string') bodyEl.innerHTML = body;
    else if (body) bodyEl.appendChild(body);

    const close = (value) => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      resolve(value);
    };
    const onKey = (e) => { if (e.key === 'Escape') close(null); };

    overlay.querySelector('form').addEventListener('submit', (e) => {
      // only the modal's own submit button closes it (inner forms handle themselves)
      if (e.target !== overlay.querySelector('form')) return;
      e.preventDefault();
      close(buttons.find((b) => b.kind === 'primary')?.value ?? true);
    });
    overlay.querySelectorAll('.modal-buttons button[type="button"]').forEach((btn) => {
      btn.addEventListener('click', () => close(buttons[btn.dataset.i].value));
    });
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(null); });
    document.addEventListener('keydown', onKey);

    document.getElementById('modal-root').appendChild(overlay);
    onOpen?.(overlay, close);
    overlay.querySelector('.modal-body input, .modal-body textarea')?.focus();
  });
}

// prompt() replacement that looks nicer
export async function promptText(title, { label = '', value = '', placeholder = '' } = {}) {
  const wrap = document.createElement('label');
  wrap.innerHTML = `${escapeHtml(label)}<input maxlength="100" placeholder="${escapeHtml(placeholder)}" value="${escapeHtml(value)}">`;
  const input = wrap.querySelector('input');
  const ok = await modal({
    title,
    body: wrap,
    buttons: [{ label: 'Cancel', value: false }, { label: 'Save', value: true, kind: 'primary' }],
  });
  const text = input.value.trim();
  return ok && text ? text : null;
}

export async function confirmDialog(title, message, okLabel = 'Delete') {
  const ok = await modal({
    title,
    body: `<p>${escapeHtml(message)}</p>`,
    buttons: [{ label: 'Cancel', value: false }, { label: okLabel, value: true, kind: 'primary' }],
  });
  return ok === true;
}
