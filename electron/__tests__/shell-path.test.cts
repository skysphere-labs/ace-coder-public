import { test, expect } from 'vitest';

const { commonBinPaths, mergePaths } = require('../shell-path.cts');

test('mergePaths keeps primary order, appends extras, dedupes', () => {
  const merged = mergePaths('/usr/bin:/bin', ['/opt/homebrew/bin', '/usr/bin']);
  const parts = merged.split(':');
  expect(parts[0]).toBe('/usr/bin');
  expect(parts[1]).toBe('/bin');
  expect(parts).toContain('/opt/homebrew/bin');
  expect(parts.filter((p) => p === '/usr/bin').length).toBe(1);
});

test('mergePaths tolerates empty primary', () => {
  const merged = mergePaths('', ['/a', '/b', '/a']);
  expect(merged.split(':')).toEqual(['/a', '/b']);
});

test('commonBinPaths returns absolute unix paths off win32', () => {
  if (process.platform === 'win32') return;
  const paths = commonBinPaths();
  expect(paths.length).toBeGreaterThan(0);
  for (const p of paths) expect(p.startsWith('/')).toBe(true);
});
