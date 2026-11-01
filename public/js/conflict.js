// ===== Conflict resolution (3-way merge) =====
//
// When the server says 409 VERSION_CONFLICT it also sends `current` (theirs).
// For every field *I* changed we compare three values:
//
//   expected = value I started editing from (the base)
//   mine     = value I want to save
//   theirs   = value now on the server
//
//   theirs == expected  -> they didn't touch this field   -> fine
//   theirs == mine      -> they made the same change      -> fine
//   otherwise           -> real clash, ask the user
//
// No clashes -> just retry with the new version ("auto-merge"), e.g. Bob edits
// the title while Carol edits the description -> both changes survive.
import { escapeHtml, modal } from './ui.js';
import { memberById } from './store.js';

const norm = (v) => (v === undefined || v === '' ? null : v);

export function findClashes(expected, mine, theirs) {
  const clashes = [];
  for (const field of Object.keys(mine)) {
    const e = norm(expected[field]);
    const m = norm(mine[field]);
    const t = norm(theirs[field]);
    if (t === e || t === m) continue;
    clashes.push({ field, mine: m, theirs: t });
  }
  return clashes;
}

const LABELS = { title: 'Title', description: 'Description', priority: 'Priority', assigneeId: 'Assignee', dueDate: 'Due date' };

function show(field, value) {
  if (value === null) return '<i class="muted">empty</i>';
  if (field === 'assigneeId') return escapeHtml(memberById(value)?.name || `user #${value}`);
  return escapeHtml(value);
}

// Shows the clash table and returns 'mine' or 'theirs'
export async function askUserToResolve(theirs, clashes) {
  const who = memberById(theirs.updatedBy)?.name || 'Someone';
  const rows = clashes.map((c) => `
    <tr><td><b>${LABELS[c.field] || c.field}</b></td><td>${show(c.field, c.theirs)}</td><td>${show(c.field, c.mine)}</td></tr>`).join('');

  const choice = await modal({
    title: 'Edit conflict',
    body: `
      <p>${escapeHtml(who)} changed the same field(s) while you were editing. Which version should we keep?</p>
      <table class="conflict-table">
        <tr><th>Field</th><th>Theirs (saved)</th><th>Mine</th></tr>
        ${rows}
      </table>
      <p class="small muted">Fields that only one of you changed are merged automatically.</p>`,
    buttons: [
      { label: 'Use theirs', value: 'theirs' },
      { label: 'Keep mine', value: 'mine', kind: 'primary' },
    ],
  });
  return choice === 'mine' ? 'mine' : 'theirs';
}
