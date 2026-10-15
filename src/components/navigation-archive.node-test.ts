import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function readSource(relativePath: string) {
  return readFileSync(resolve(ROOT, relativePath), 'utf8');
}

test('visible navigation surfaces do not expose archived Missions', () => {
  for (const relativePath of [
    'components/WorkspaceRail.tsx',
    'components/QuickLauncher.tsx',
    'components/MobileShell.tsx',
  ]) {
    const source = readSource(relativePath);
    assert.doesNotMatch(source, /\bMissions\b/, `${relativePath} still exposes Missions`);
    assert.doesNotMatch(source, /['"]automations['"]/, `${relativePath} still exposes automations view`);
  }
});

test('workspace canvas no longer routes to the archived mission library', () => {
  const source = readSource('components/WorkspaceCanvas.tsx');
  assert.doesNotMatch(source, /\bMissionLibrary\b/);
  assert.doesNotMatch(source, /['"]automations['"]/);
});
