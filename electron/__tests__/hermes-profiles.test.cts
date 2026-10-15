// @ts-nocheck — vitest loads this entry through the vite pipeline, which does
// not strip TS syntax from .cts test entries; keep this file plain JS.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const Database = require('better-sqlite3');
const {
  aceSessionOperators,
  aceUserDataCandidatePaths,
  listHermesProfilesFromHome,
} = require('../hermes-profiles.cts');

function makeTempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ace-hermes-profiles-'));
}

function writeConfig(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

// Owner-shaped operators.json exactly as the operators.cts migration writes
// it for an install with the legacy Rook/King personal agents.
function ownerOperatorsConfig() {
  return {
    schema: 'ace.operators.v1',
    defaultOperatorId: 'rook',
    operators: [
      {
        id: 'rook',
        label: 'Rook',
        emoji: '♜',
        agent: 'hermes',
        providerKind: 'builtin-personal',
        isControlPlane: true,
        autoStart: true,
        sortOrder: 0,
        workspaceDirName: 'personal-workspace',
        terminalDirName: 'personal-hermes',
      },
      {
        id: 'king',
        label: 'King',
        emoji: '♔',
        agent: 'hermes',
        providerKind: 'builtin-personal',
        isControlPlane: true,
        autoStart: true,
        sortOrder: 1,
        workspaceDirName: 'king-workspace',
        terminalDirName: 'king-hermes',
      },
    ],
    migratedFrom: 'rook-king-v1',
  };
}

function seedOwnerAceDb(aceData, opts = {}) {
  const rookHome = path.join(aceData, 'hermes-home-prj-rook');
  const kingHome = path.join(aceData, 'hermes-home-prj-king');
  writeConfig(
    path.join(rookHome, 'config.yaml'),
    `model:\n  provider: openai-codex\n  default: gpt-5.5\nterminal:\n  cwd: ${path.join(aceData, 'personal-workspace')}\napi_key: should-not-leak\n`
  );
  writeConfig(
    path.join(kingHome, 'config.yaml'),
    `model:\n  provider: anthropic\n  default: claude-opus-4-7\nterminal:\n  cwd: ${path.join(aceData, 'king-workspace')}\n`
  );

  const db = new Database(path.join(aceData, 'ace.db'));
  db.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      is_personal INTEGER NOT NULL DEFAULT 0,
      personal_identity TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      primary_agent TEXT NOT NULL,
      archived_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      title TEXT NOT NULL,
      agent TEXT NOT NULL,
      is_main INTEGER NOT NULL DEFAULT 0,
      display_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
  `);
  if (!opts.skipAgentLanes) {
    db.exec(`
      CREATE TABLE agent_lanes (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        agent TEXT NOT NULL,
        provider_kind TEXT NOT NULL,
        profile_id TEXT,
        profile_home TEXT,
        project_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        archived_at TEXT,
        created_at TEXT NOT NULL
      );
    `);
  }
  const now = new Date().toISOString();
  db.prepare('INSERT INTO projects (id, name, path, is_personal, personal_identity, created_at) VALUES (?, ?, ?, 1, ?, ?)')
    .run('prj-rook', 'Rook', path.join(aceData, 'personal-workspace'), 'rook', now);
  db.prepare('INSERT INTO projects (id, name, path, is_personal, personal_identity, created_at) VALUES (?, ?, ?, 1, ?, ?)')
    .run('prj-king', 'King', path.join(aceData, 'king-workspace'), 'king', now);
  db.prepare('INSERT INTO tasks (id, project_id, kind, name, primary_agent, archived_at, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?)')
    .run('thr-rook', 'prj-rook', 'thread', 'Hermes Orchestrator — HER', 'hermes', now);
  db.prepare('INSERT INTO tasks (id, project_id, kind, name, primary_agent, archived_at, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?)')
    .run('thr-king', 'prj-king', 'thread', 'Hermes Orchestrator — KIN', 'hermes', now);
  db.prepare('INSERT INTO conversations (id, task_id, title, agent, is_main, display_order, created_at) VALUES (?, ?, ?, ?, 1, 0, ?)')
    .run('conv-rook', 'thr-rook', 'Rook', 'hermes', now);
  db.prepare('INSERT INTO conversations (id, task_id, title, agent, is_main, display_order, created_at) VALUES (?, ?, ?, ?, 1, 0, ?)')
    .run('conv-king', 'thr-king', 'King', 'hermes', now);
  if (!opts.skipAgentLanes) {
    db.prepare('INSERT INTO agent_lanes (id, label, agent, provider_kind, profile_id, profile_home, project_id, task_id, sort_order, archived_at, created_at) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL, ?)')
      .run('lane-rook', 'Rook', 'hermes', 'builtin-personal', rookHome, 'prj-rook', 'thr-rook', 0, now);
    db.prepare('INSERT INTO agent_lanes (id, label, agent, provider_kind, profile_id, profile_home, project_id, task_id, sort_order, archived_at, created_at) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL, ?)')
      .run('lane-king', 'King', 'hermes', 'builtin-personal', kingHome, 'prj-king', 'thr-king', 1, now);
  }
  db.close();
  return { rookHome, kingHome };
}

test('listHermesProfilesFromHome discovers default and named Hermes Agent profiles without leaking config contents', () => {
  const home = makeTempHome();
  writeConfig(
    path.join(home, '.hermes', 'config.yaml'),
    `model:\n  provider: openai\n  default: gpt-5.5\nterminal:\n  cwd: /tmp/default-hermes\nsecret_token: should-not-leak\n`
  );
  writeConfig(
    path.join(home, '.hermes', 'profiles', 'vector', 'config.yaml'),
    `model:\n  provider: anthropic\n  default: claude-opus-4-7\nterminal:\n  cwd: /tmp/vector\napi_key: should-not-leak\n`
  );
  fs.mkdirSync(path.join(home, '.hermes', 'profiles', 'empty'), { recursive: true });

  const profiles = listHermesProfilesFromHome(home, { hermesLaunchable: true });

  assert.deepEqual(profiles.map((profile) => profile.id), ['default', 'vector']);
  assert.deepEqual(
    profiles.map((profile) => ({
      id: profile.id,
      label: profile.label,
      modelProvider: profile.modelProvider,
      modelName: profile.modelName,
      terminalCwd: profile.terminalCwd,
      launchable: profile.launchable,
    })),
    [
      {
        id: 'default',
        label: 'Hermes Default',
        modelProvider: 'openai',
        modelName: 'gpt-5.5',
        terminalCwd: '/tmp/default-hermes',
        launchable: true,
      },
      {
        id: 'vector',
        label: 'Vector',
        modelProvider: 'anthropic',
        modelName: 'claude-opus-4-7',
        terminalCwd: '/tmp/vector',
        launchable: true,
      },
    ]
  );
  assert.equal(JSON.stringify(profiles).includes('should-not-leak'), false);
});

test('listHermesProfilesFromHome returns an empty list when no config files exist', () => {
  const home = makeTempHome();
  assert.deepEqual(listHermesProfilesFromHome(home), []);
});

test('listHermesProfilesFromHome also discovers Ace-managed Rook and King persistent Hermes sessions', () => {
  const home = makeTempHome();
  const aceData = path.join(home, 'Library', 'Application Support', 'Ace');
  const { rookHome, kingHome } = seedOwnerAceDb(aceData);

  const profiles = listHermesProfilesFromHome(home, {
    hermesLaunchable: true,
    aceUserDataPaths: [aceData],
  });

  const rook = profiles.find((profile) => profile.id === 'ace-session:rook');
  const king = profiles.find((profile) => profile.id === 'ace-session:king');
  assert.ok(rook, 'Rook persistent Ace Hermes session should be surfaced as a profile template');
  assert.ok(king, 'King persistent Ace Hermes session should be surfaced as a profile template');
  assert.equal(rook.label, 'Rook');
  assert.equal(rook.homePath, rookHome);
  assert.equal(rook.source, 'ace-session');
  assert.equal(rook.projectId, 'prj-rook');
  assert.equal(rook.taskId, 'thr-rook');
  assert.equal(rook.conversationId, 'conv-rook');
  assert.equal(rook.modelName, 'gpt-5.5');
  assert.equal(king.label, 'King');
  assert.equal(king.homePath, kingHome);
  assert.equal(king.modelProvider, 'anthropic');
  assert.equal(JSON.stringify(profiles).includes('should-not-leak'), false);
});

test('ROLLBACK-COMPAT: owner-shaped operators.json changes nothing — ids, labels, and candidate ordering identical', () => {
  // Proves both directions of the rollback contract:
  //  - a NEW build reading the owner's operators.json surfaces exactly the
  //    same session profiles (ids/labels/ordering) as the legacy fallback;
  //  - an OLD build that never reads operators.json sees the same world,
  //    because the no-config fallback IS the legacy hardcoded behavior.
  const home = makeTempHome();
  const aceData = path.join(home, 'Library', 'Application Support', 'Ace');
  seedOwnerAceDb(aceData);
  const snapshot = (profiles) =>
    profiles.map((profile) => ({
      id: profile.id,
      label: profile.label,
      homePath: profile.homePath,
      source: profile.source,
      providerKind: profile.providerKind,
    }));

  // Pass 1: no operators.json (legacy wrapper / old-build world).
  const withoutConfig = listHermesProfilesFromHome(home, {
    hermesLaunchable: true,
    aceUserDataPaths: [aceData],
  });
  assert.equal(
    fs.existsSync(path.join(aceData, 'operators.json')),
    false,
    'profile listing must never create operators.json (read-only contract)'
  );

  // Pass 2: owner-shaped operators.json present (new-build world).
  const configPath = path.join(aceData, 'operators.json');
  const configBytes = JSON.stringify(ownerOperatorsConfig(), null, 2) + '\n';
  fs.writeFileSync(configPath, configBytes);
  const withConfig = listHermesProfilesFromHome(home, {
    hermesLaunchable: true,
    aceUserDataPaths: [aceData],
  });

  assert.deepEqual(snapshot(withConfig), snapshot(withoutConfig));
  assert.deepEqual(
    withConfig.map((profile) => ({ id: profile.id, label: profile.label })),
    [
      { id: 'ace-session:rook', label: 'Rook' },
      { id: 'ace-session:king', label: 'King' },
    ]
  );

  // Read-only contract: listing must not rewrite or back up the config.
  assert.equal(fs.readFileSync(configPath, 'utf8'), configBytes);
  assert.equal(fs.existsSync(path.join(aceData, 'operators.json.bak')), false);
  assert.deepEqual(
    fs.readdirSync(aceData).filter((name) => name.endsWith('.tmp')),
    []
  );
});

test('aceSessionOperators: config operators first, legacy rook/king kept as fallback', () => {
  const userData = makeTempHome();

  // No config at all -> the legacy rook/king fallback keeps its historical
  // ids, labels, and ranks.
  const noConfig = aceSessionOperators(userData);
  const rookNoConfig = noConfig.find((op) => op.id === 'rook');
  const kingNoConfig = noConfig.find((op) => op.id === 'king');
  assert.deepEqual(rookNoConfig, { id: 'rook', label: 'Rook', sortOrder: 0 });
  assert.deepEqual(kingNoConfig, { id: 'king', label: 'King', sortOrder: 1 });

  // Owner-shaped config -> exactly the config operators, no duplicates.
  fs.writeFileSync(
    path.join(userData, 'operators.json'),
    JSON.stringify(ownerOperatorsConfig(), null, 2) + '\n'
  );
  assert.deepEqual(aceSessionOperators(userData), [
    { id: 'rook', label: 'Rook', sortOrder: 0 },
    { id: 'king', label: 'King', sortOrder: 1 },
  ]);
});

test('custom operator config drives session ids and labels for non-rook/king identities', () => {
  const home = makeTempHome();
  const aceData = path.join(home, 'Library', 'Application Support', 'Ace');
  // Fallback path only (no agent_lanes table) to exercise the SQL filter.
  seedOwnerAceDb(aceData, { skipAgentLanes: true });

  const db = new Database(path.join(aceData, 'ace.db'));
  const now = new Date().toISOString();
  db.prepare('INSERT INTO projects (id, name, path, is_personal, personal_identity, created_at) VALUES (?, ?, ?, 1, ?, ?)')
    .run('prj-atlas', 'Atlas Project', path.join(aceData, 'atlas-workspace'), 'atlas', now);
  db.prepare('INSERT INTO tasks (id, project_id, kind, name, primary_agent, archived_at, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?)')
    .run('thr-atlas', 'prj-atlas', 'thread', 'Hermes Orchestrator — ATL', 'hermes', now);
  db.prepare('INSERT INTO conversations (id, task_id, title, agent, is_main, display_order, created_at) VALUES (?, ?, ?, ?, 1, 0, ?)')
    .run('conv-atlas', 'thr-atlas', 'Atlas', 'hermes', now);
  db.close();

  const config = ownerOperatorsConfig();
  config.operators.unshift({
    id: 'atlas',
    label: 'Atlas',
    agent: 'hermes',
    providerKind: 'builtin-personal',
    isControlPlane: true,
    autoStart: true,
    sortOrder: -1,
    workspaceDirName: 'atlas-workspace',
    terminalDirName: 'atlas-hermes',
  });
  config.defaultOperatorId = 'atlas';
  fs.writeFileSync(
    path.join(aceData, 'operators.json'),
    JSON.stringify(config, null, 2) + '\n'
  );

  const profiles = listHermesProfilesFromHome(home, {
    hermesLaunchable: true,
    aceUserDataPaths: [aceData],
  });
  const sessions = profiles.filter((profile) => profile.source === 'ace-session');

  // Config sortOrder drives the ordering: atlas (-1) before rook (0) / king (1).
  assert.deepEqual(
    sessions.map((profile) => ({ id: profile.id, label: profile.label })),
    [
      { id: 'ace-session:atlas', label: 'Atlas' },
      { id: 'ace-session:rook', label: 'Rook' },
      { id: 'ace-session:king', label: 'King' },
    ]
  );
});

test('neutral operators config still surfaces legacy rook/king sessions via the fallback', () => {
  const home = makeTempHome();
  const aceData = path.join(home, 'Library', 'Application Support', 'Ace');
  seedOwnerAceDb(aceData, { skipAgentLanes: true });
  // Neutral config (fresh install shape) lacks rook/king operators entirely.
  fs.writeFileSync(
    path.join(aceData, 'operators.json'),
    JSON.stringify({
      schema: 'ace.operators.v1',
      defaultOperatorId: 'hermes',
      operators: [
        {
          id: 'hermes',
          label: 'Hermes',
          agent: 'hermes',
          providerKind: 'builtin-personal',
          isControlPlane: true,
          autoStart: true,
          sortOrder: 0,
          workspaceDirName: 'personal-workspace',
          terminalDirName: 'personal-hermes',
        },
      ],
    }, null, 2) + '\n'
  );

  const profiles = listHermesProfilesFromHome(home, {
    hermesLaunchable: true,
    aceUserDataPaths: [aceData],
  });
  assert.deepEqual(
    profiles
      .filter((profile) => profile.source === 'ace-session')
      .map((profile) => ({ id: profile.id, label: profile.label })),
    [
      { id: 'ace-session:rook', label: 'Rook' },
      { id: 'ace-session:king', label: 'King' },
    ]
  );
});

test('aceUserDataCandidatePaths uses stable Ace data as external profile source without echoing current dev lanes', () => {
  const appSupport = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-app-support-'));
  const stable = path.join(appSupport, 'Ace');
  const currentDev = path.join(appSupport, 'Ace-Ace');
  fs.mkdirSync(stable, { recursive: true });
  fs.mkdirSync(currentDev, { recursive: true });

  assert.deepEqual(aceUserDataCandidatePaths(currentDev), [stable]);
  assert.deepEqual(aceUserDataCandidatePaths(stable), []);
});
