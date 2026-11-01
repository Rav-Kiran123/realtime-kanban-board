// ===== Undo / Redo =====
// Command pattern: every user action pushes { label, undo(), redo() }.
// undo()/redo() are normal API calls (e.g. "move it back"), so they go through
// the same version checks as anything else. If someone else changed the card
// in the meantime the undo fails safely instead of overwriting their work.
import { notify } from './store.js';
import { toast } from './ui.js';

const LIMIT = 50;
const undoStack = [];
const redoStack = [];
let busy = false; // don't run a second undo while the first is still talking to the server

export function pushHistory(command) {
  undoStack.push(command);
  if (undoStack.length > LIMIT) undoStack.shift();
  redoStack.length = 0; // a new action kills the redo branch (like every editor)
  notify();
}

export function clearHistory() {
  undoStack.length = 0;
  redoStack.length = 0;
  notify();
}

export const canUndo = () => undoStack.length > 0 && !busy;
export const canRedo = () => redoStack.length > 0 && !busy;

async function run(from, to, method, verb) {
  if (busy || from.length === 0) return;
  const command = from.pop();
  busy = true;
  notify();
  try {
    await command[method]();
    to.push(command);
    toast(`${verb}: ${command.label}`);
  } catch (err) {
    // the command is dropped - it no longer makes sense on the current board
    toast(`Couldn't ${verb.toLowerCase()} "${command.label}" - ${err.message}`, 'warn', 5000);
  } finally {
    busy = false;
    notify();
  }
}

export const undo = () => run(undoStack, redoStack, 'undo', 'Undo');
export const redo = () => run(redoStack, undoStack, 'redo', 'Redo');
