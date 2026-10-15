const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'local-core.cts'), 'utf8');

test('core getState has a short duplicate-call cache and emitState forces rebuild', () => {
  assert.match(source, /const STATE_SNAPSHOT_CACHE_MS = 250;/);
  assert.match(source, /let cachedStateSnapshot/);
  assert.match(source, /cacheHit: true/);
  assert.match(source, /cacheHit: false/);
  assert.match(source, /function emitState\(\) \{\s*const state = getState\(\{ allowCache: false \}\);/);
});

test('internal status readers use shallow workspace summaries instead of full state', () => {
  assert.match(source, /function projectWorkspaceSummaries\(db, metaCache\)/);
  assert.match(source, /name: 'core\.workspaceSummaries'/);
  assert.match(source, /archivedTasks: \[\]/);
  assert.match(source, /function listTrackedGithubProjects\(\) \{\s*const workspaces = projectWorkspaceSummaries\(db, workspaceMetaCache\) \|\| \[\];/);
  assert.match(source, /const workspaces = projectWorkspaceSummaries\(db, workspaceMetaCache\) \|\| \[\];\s*const payload = buildWakeBriefPayload/);
  assert.match(source, /listWorkspaces: \(\) => projectWorkspaceSummaries\(db, workspaceMetaCache\) \|\| \[\]/);
  assert.doesNotMatch(source, /listWorkspaces: \(\) => getState\(\)\.workspaces/);
});
