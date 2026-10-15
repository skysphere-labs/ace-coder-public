import { aceApi } from '../lib/ace-api';
import { createSnapshotStore, useStoreValue } from './create-snapshot-store';

export type UndoScope =
  | { kind: 'task'; id: string }
  | { kind: 'workspace'; id: string };

export type UndoEntry = {
  kind: 'file-delete';
  id: number;
  createdAt: number;
  scope: UndoScope;
  trashPath: string;
  originalPath: string;
  relativePath: string;
  label: string;
};

const MAX_ENTRIES = 50;
let entrySeq = 0;
const undoStack: UndoEntry[] = [];
const redoStack: UndoEntry[] = [];

const listStore = createSnapshotStore<UndoEntry[]>([]);

function emitEntries() {
  listStore.setSnapshot([...undoStack]);
}

export function useUndoEntries(): UndoEntry[] {
  return useStoreValue(listStore);
}

type ToastAction = { label: string; onClick: () => void };
export type ToastState = {
  id: number;
  message: string;
  action?: ToastAction;
} | null;

const toastStore = createSnapshotStore<ToastState>(null);
let toastTimer: ReturnType<typeof setTimeout> | null = null;
let toastSeq = 0;

export function showToast(message: string, action?: ToastAction): void {
  if (toastTimer) clearTimeout(toastTimer);
  toastSeq += 1;
  toastStore.setSnapshot({ id: toastSeq, message, action });
  toastTimer = setTimeout(() => {
    toastStore.setSnapshot(null);
    toastTimer = null;
  }, 5000);
}

export function dismissToast(): void {
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = null;
  toastStore.setSnapshot(null);
}

export function useToast(): ToastState {
  return useStoreValue(toastStore);
}

type NewUndoEntry = Omit<UndoEntry, 'id' | 'createdAt'>;

export function pushUndo(entry: NewUndoEntry): void {
  entrySeq += 1;
  const stamped: UndoEntry = { ...entry, id: entrySeq, createdAt: Date.now() };
  undoStack.push(stamped);
  if (undoStack.length > MAX_ENTRIES) undoStack.shift();
  redoStack.length = 0;
  emitEntries();
}

async function runInverse(entry: UndoEntry, direction: 'undo' | 'redo'): Promise<string | null> {
  if (direction === 'undo') {
    try {
      await aceApi.fs.restoreFromTrash(entry.trashPath, entry.originalPath);
      return `Restored ${entry.label}`;
    } catch {
      return `Couldn't restore ${entry.label}`;
    }
  }
  try {
    if (entry.scope.kind === 'task') {
      await aceApi.fs.deleteTaskPath(entry.scope.id, entry.relativePath);
    } else {
      await aceApi.fs.deleteWorkspacePath(entry.scope.id, entry.relativePath);
    }
    return `Deleted ${entry.label}`;
  } catch {
    return `Couldn't redo delete of ${entry.label}`;
  }
}

export async function undo(): Promise<void> {
  const entry = undoStack.pop();
  if (!entry) {
    showToast('Nothing to undo');
    emitEntries();
    return;
  }
  emitEntries();
  const message = await runInverse(entry, 'undo');
  redoStack.push(entry);
  if (redoStack.length > MAX_ENTRIES) redoStack.shift();
  if (message) showToast(message, { label: 'Redo', onClick: () => { void redo(); } });
}

export async function redo(): Promise<void> {
  const entry = redoStack.pop();
  if (!entry) {
    showToast('Nothing to redo');
    return;
  }
  const message = await runInverse(entry, 'redo');
  undoStack.push(entry);
  if (undoStack.length > MAX_ENTRIES) undoStack.shift();
  emitEntries();
  if (message) showToast(message, { label: 'Undo', onClick: () => { void undo(); } });
}

export function clearUndo(): void {
  undoStack.length = 0;
  redoStack.length = 0;
  emitEntries();
}
