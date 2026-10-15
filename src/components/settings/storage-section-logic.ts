// Pure validators and copy-builders for StorageSection's change-data-root
// flow. React-free so the copy (which must stay brutally honest) is pinned by
// unit tests.
//
// DataRootLike / OperatorLike are LOCAL structural mirrors of the electron
// contracts (external-data-root / operators units). Duplicated on purpose so
// this unit compiles standalone; structural typing keeps the IPC integration
// unit compatible.

export interface DataRootLike {
  root: string | null;
  active: boolean;
  source: string;
  reason?: string;
}

export interface OperatorLike {
  id: string;
  label: string;
  emoji: string;
  terminalDirName: string;
  hermesHome?: string | null;
  memoryDbPath?: string | null;
  isControlPlane?: boolean;
}

export const DEFAULT_ROOT_LABEL = 'Default (application data folder)';

export const RELAUNCH_REQUIRED_NOTICE =
  'Relaunch required — Ace keeps using the current data root until you quit and reopen it.';

export interface DataRootDescription {
  rootLabel: string;
  statusLabel: 'Active' | 'Fallback';
  badgeVariant: 'success' | 'warning';
  detail: string | null;
}

export function describeDataRoot(info: DataRootLike): DataRootDescription {
  const rootLabel = info.root ?? DEFAULT_ROOT_LABEL;
  if (info.active) {
    return { rootLabel, statusLabel: 'Active', badgeVariant: 'success', detail: null };
  }
  return {
    rootLabel,
    statusLabel: 'Fallback',
    badgeVariant: 'warning',
    detail: info.reason
      ? `Not active — ${info.reason}`
      : 'Not active — Ace fell back to the default location.',
  };
}

export type PickedDirectoryValidation = { ok: true } | { ok: false; reason: string };

export function validatePickedDirectory(
  currentRoot: string | null,
  picked: string
): PickedDirectoryValidation {
  const trimmed = picked.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: 'No directory selected.' };
  }
  if (!trimmed.startsWith('/')) {
    return { ok: false, reason: 'The data root must be an absolute path.' };
  }
  if (currentRoot !== null && trimmed === currentRoot) {
    return { ok: false, reason: 'That folder is already the data root.' };
  }
  return { ok: true };
}

export const DB_WARNING_COPY =
  'The selected folder already contains a ace.db. Continue only if you intend to switch to that existing dataset.';

export interface ChangeRootConfirmation {
  title: string;
  warningLines: string[];
  dbWarning: string | null;
  confirmLabel: string;
}

export function buildChangeRootConfirmation(opts: {
  currentRoot: string | null;
  pickedRoot: string;
  destinationHasDb: boolean;
}): ChangeRootConfirmation {
  const currentLabel = opts.currentRoot ?? 'the default application data folder';
  return {
    title: `Use ${opts.pickedRoot} as the data root?`,
    warningLines: [
      'This does NOT move existing data.',
      `Ace will use the new location after relaunch; your current agents/data stay at ${currentLabel}.`,
      'Use the migration script to copy data first.',
    ],
    dbWarning: opts.destinationHasDb ? DB_WARNING_COPY : null,
    confirmLabel: 'Use new location',
  };
}

export function describeOperatorHome(operator: OperatorLike): string {
  const home = operator.hermesHome?.trim();
  return home && home.length > 0 ? home : 'Default location';
}
