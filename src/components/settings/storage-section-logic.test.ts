import { expect, test } from 'vitest';

import {
  buildChangeRootConfirmation,
  DB_WARNING_COPY,
  DEFAULT_ROOT_LABEL,
  describeDataRoot,
  describeOperatorHome,
  RELAUNCH_REQUIRED_NOTICE,
  validatePickedDirectory,
  type OperatorLike,
} from './storage-section-logic';

// ---------------------------------------------------------------------------
// describeDataRoot
// ---------------------------------------------------------------------------

test('describeDataRoot: active external root', () => {
  const d = describeDataRoot({ root: '/Volumes/SSD/AceData', active: true, source: 'config' });
  expect(d.rootLabel).toBe('/Volumes/SSD/AceData');
  expect(d.statusLabel).toBe('Active');
  expect(d.badgeVariant).toBe('success');
  expect(d.detail).toBeNull();
});

test('describeDataRoot: null root → default label', () => {
  const d = describeDataRoot({ root: null, active: true, source: 'default' });
  expect(d.rootLabel).toBe(DEFAULT_ROOT_LABEL);
  expect(d.statusLabel).toBe('Active');
});

test('describeDataRoot: fallback with reason surfaces the reason', () => {
  const d = describeDataRoot({
    root: '/Volumes/SSD/AceData',
    active: false,
    source: 'config',
    reason: 'volume not mounted',
  });
  expect(d.statusLabel).toBe('Fallback');
  expect(d.badgeVariant).toBe('warning');
  expect(d.detail).toBe('Not active — volume not mounted');
});

test('describeDataRoot: fallback without reason gets generic detail', () => {
  const d = describeDataRoot({ root: '/somewhere', active: false, source: 'config' });
  expect(d.statusLabel).toBe('Fallback');
  expect(d.detail).toBe('Not active — Ace fell back to the default location.');
});

// ---------------------------------------------------------------------------
// validatePickedDirectory
// ---------------------------------------------------------------------------

test('validatePickedDirectory rejects empty and whitespace input', () => {
  expect(validatePickedDirectory(null, '')).toEqual({
    ok: false,
    reason: 'No directory selected.',
  });
  expect(validatePickedDirectory(null, '   ')).toEqual({
    ok: false,
    reason: 'No directory selected.',
  });
});

test('validatePickedDirectory rejects relative paths', () => {
  const result = validatePickedDirectory(null, 'relative/path');
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toBe('The data root must be an absolute path.');
});

test('validatePickedDirectory rejects picking the current root again', () => {
  const result = validatePickedDirectory('/Volumes/SSD/AceData', '/Volumes/SSD/AceData');
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toBe('That folder is already the data root.');
});

test('validatePickedDirectory accepts a new absolute path', () => {
  expect(validatePickedDirectory('/old/root', '/new/root')).toEqual({ ok: true });
  expect(validatePickedDirectory(null, '/new/root')).toEqual({ ok: true });
});

test('validatePickedDirectory trims before comparing', () => {
  const result = validatePickedDirectory('/old/root', '  /old/root  ');
  expect(result.ok).toBe(false);
});

// ---------------------------------------------------------------------------
// buildChangeRootConfirmation — copy is contractually honest.
// ---------------------------------------------------------------------------

test('confirmation copy: does-not-move warning, old path, migration hint', () => {
  const c = buildChangeRootConfirmation({
    currentRoot: '/Volumes/SSD/AceData',
    pickedRoot: '/Volumes/New/AceData',
    destinationHasDb: false,
  });
  expect(c.title).toBe('Use /Volumes/New/AceData as the data root?');
  expect(c.warningLines[0]).toBe('This does NOT move existing data.');
  expect(c.warningLines[1]).toBe(
    'Ace will use the new location after relaunch; your current agents/data stay at /Volumes/SSD/AceData.'
  );
  expect(c.warningLines[2]).toBe('Use the migration script to copy data first.');
  expect(c.dbWarning).toBeNull();
  expect(c.confirmLabel).toBe('Use new location');
});

test('confirmation copy: null current root names the default folder', () => {
  const c = buildChangeRootConfirmation({
    currentRoot: null,
    pickedRoot: '/Volumes/New/AceData',
    destinationHasDb: false,
  });
  expect(c.warningLines[1]).toContain(
    'your current agents/data stay at the default application data folder'
  );
});

test('confirmation copy: existing ace.db triggers the extra warning', () => {
  const c = buildChangeRootConfirmation({
    currentRoot: '/old',
    pickedRoot: '/new',
    destinationHasDb: true,
  });
  expect(c.dbWarning).toBe(
    'The selected folder already contains a ace.db. Continue only if you intend to switch to that existing dataset.'
  );
  expect(c.dbWarning).toBe(DB_WARNING_COPY);
});

test('relaunch notice never promises an automatic relaunch', () => {
  expect(RELAUNCH_REQUIRED_NOTICE).toContain('Relaunch required');
  expect(RELAUNCH_REQUIRED_NOTICE).toContain('until you quit and reopen it');
  expect(RELAUNCH_REQUIRED_NOTICE.toLowerCase()).not.toContain('automatically');
});

// ---------------------------------------------------------------------------
// describeOperatorHome
// ---------------------------------------------------------------------------

function makeOperator(overrides: Partial<OperatorLike> = {}): OperatorLike {
  return {
    id: 'op-1',
    label: 'Operator',
    emoji: '🤖',
    terminalDirName: 'operator-hermes',
    ...overrides,
  };
}

test('describeOperatorHome shows the configured home', () => {
  expect(describeOperatorHome(makeOperator({ hermesHome: '/data/hermes-home' }))).toBe(
    '/data/hermes-home'
  );
});

test('describeOperatorHome falls back to "Default location"', () => {
  expect(describeOperatorHome(makeOperator())).toBe('Default location');
  expect(describeOperatorHome(makeOperator({ hermesHome: null }))).toBe('Default location');
  expect(describeOperatorHome(makeOperator({ hermesHome: '   ' }))).toBe('Default location');
});
