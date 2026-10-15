const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  ensureGoalLedger,
  appendGoalLedgerEvent,
  buildGoalLedgerPointer,
  readGoalLedger,
  defaultRunId,
  GOAL_LEDGER_VERSION,
} = require('../goal-ledger.cts');

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ace-goal-ledger-'));
}

test('defaultRunId combines mission/feature/title slug', () => {
  assert.equal(
    defaultRunId({ missionId: 'msn-1', featureId: 'feat-2', title: 'Wire ledger into board' }),
    'msn-1-feat-2-wire-ledger-into-board'
  );
});

test('ensureGoalLedger creates GOAL.md, notes, evidence dir, and GOALS.md index', () => {
  const root = tempRoot();
  const result = ensureGoalLedger({
    rootDir: root,
    missionId: 'msn-aa',
    featureId: 'feat-bb',
    title: 'Attach ledger to mission card',
    objective: 'Couple the Goal Ledger to mission feature dispatch.',
    acceptance: ['Mission Board exposes goalLedgerPath', 'Worker prompt references ledger'],
    goalMode: 'auto',
    escapeHatch: 'End with DONE: <summary> or BLOCKED: <reason>.',
  });

  assert.equal(result.created, true);
  assert.ok(result.ledgerPath.endsWith(path.join('.agent', 'runs', 'msn-aa-feat-bb-attach-ledger-to-mission-card')));
  assert.ok(fs.existsSync(result.goalPath));
  assert.ok(fs.existsSync(result.notesPath));
  assert.ok(fs.statSync(result.evidenceDir).isDirectory());

  const goal = fs.readFileSync(result.goalPath, 'utf8');
  assert.match(goal, /Mission: msn-aa/);
  assert.match(goal, /Feature: feat-bb/);
  assert.match(goal, /## Objective/);
  assert.match(goal, /## Acceptance/);
  assert.match(goal, /## Goal-mode coupling/);
  assert.match(goal, /## Escape hatch/);
  assert.match(goal, /Mission Board exposes goalLedgerPath/);

  const notes = fs.readFileSync(result.notesPath, 'utf8');
  assert.match(notes, /Resume Here/);
  assert.match(notes, /Status:.*started/);
  assert.match(notes, /Phase:.*plan/);
  assert.match(notes, /Next exact action/);
  assert.match(notes, /Last validation/);
  assert.match(notes, /Protected paths/);
  assert.match(notes, /Decisions/);
  assert.match(notes, /Tradeoffs/);
  assert.match(notes, /Validation/);
  assert.match(notes, /Evidence/);
  assert.match(notes, /Next goal candidates/);
  assert.match(notes, /Progress events/);
  assert.match(notes, new RegExp(GOAL_LEDGER_VERSION + '\\.progress'));

  const indexPath = path.join(root, '.agent', 'GOALS.md');
  assert.ok(fs.existsSync(indexPath));
  assert.match(fs.readFileSync(indexPath, 'utf8'), /msn-aa-feat-bb-attach-ledger-to-mission-card/);
});

test('ensureGoalLedger is idempotent — re-running does not overwrite GOAL.md', () => {
  const root = tempRoot();
  const first = ensureGoalLedger({
    rootDir: root,
    missionId: 'msn-1',
    featureId: 'feat-1',
    title: 'First',
    acceptance: ['ok'],
  });
  fs.writeFileSync(first.goalPath, 'EDITED BY WORKER\n');
  const second = ensureGoalLedger({
    rootDir: root,
    missionId: 'msn-1',
    featureId: 'feat-1',
    title: 'First',
    acceptance: ['ok'],
  });
  assert.equal(second.created, false);
  assert.equal(fs.readFileSync(second.goalPath, 'utf8'), 'EDITED BY WORKER\n');
});

test('appendGoalLedgerEvent writes NDJSON and refreshes implementation-notes', () => {
  const root = tempRoot();
  const ledger = ensureGoalLedger({
    rootDir: root,
    missionId: 'msn-x',
    featureId: 'feat-y',
    title: 'Wire ledger',
    acceptance: ['Mission Board exposes goalLedgerPath'],
  });

  appendGoalLedgerEvent({
    ledgerPath: ledger.ledgerPath,
    status: 'checkpoint',
    phase: 'implement',
    actor: 'codex',
    summary: 'Added Goal Ledger column to mission_features',
    evidence: ['electron/missions.cts: ALTER TABLE mission_features ADD COLUMN goal_ledger_path TEXT'],
    nextAction: 'Project goalLedgerPath onto card output',
    title: 'Wire ledger',
    acceptance: ['Mission Board exposes goalLedgerPath'],
  });

  const events = fs
    .readFileSync(ledger.eventsPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line: any) => JSON.parse(line));
  assert.equal(events.length, 1);
  assert.equal(events[0].status, 'checkpoint');
  assert.equal(events[0].phase, 'implement');
  assert.equal(events[0].actor, 'codex');
  assert.match(events[0].schema, /\.progress$/);

  const notes = fs.readFileSync(ledger.notesPath, 'utf8');
  assert.match(notes, /Status:.*checkpoint/);
  assert.match(notes, /Phase:.*implement/);
  assert.match(notes, /Project goalLedgerPath onto card output/);
  assert.match(notes, /ALTER TABLE mission_features ADD COLUMN goal_ledger_path TEXT/);
});

test('appendGoalLedgerEvent rejects unknown status and phase', () => {
  const root = tempRoot();
  const ledger = ensureGoalLedger({
    rootDir: root,
    missionId: 'msn-1',
    featureId: 'feat-1',
    title: 'Reject test',
  });
  assert.throws(
    () => appendGoalLedgerEvent({ ledgerPath: ledger.ledgerPath, status: 'unknown' }),
    /status must be one of/
  );
  assert.throws(
    () =>
      appendGoalLedgerEvent({
        ledgerPath: ledger.ledgerPath,
        status: 'checkpoint',
        phase: 'unknown_phase',
      }),
    /phase must be one of/
  );
});

test('appendGoalLedgerEvent fails clearly when ledgerPath is missing', () => {
  assert.throws(
    () => appendGoalLedgerEvent({ ledgerPath: '/nonexistent/path/that/does/not/exist', status: 'checkpoint' }),
    /ledger directory missing/
  );
  assert.throws(() => appendGoalLedgerEvent({ status: 'checkpoint' }), /ledgerPath required/);
});

test('buildGoalLedgerPointer returns a compact pointer pack', () => {
  const root = tempRoot();
  const ledger = ensureGoalLedger({
    rootDir: root,
    missionId: 'msn-aa',
    featureId: 'feat-bb',
    title: 'Pointer test',
  });
  const pointer = buildGoalLedgerPointer({
    ledgerPath: ledger.ledgerPath,
    runId: ledger.runId,
    missionId: 'msn-aa',
    featureId: 'feat-bb',
  });
  assert.equal(pointer.runId, 'msn-aa-feat-bb-pointer-test');
  assert.equal(pointer.ledgerPath, ledger.ledgerPath);
  assert.equal(pointer.goalPath, path.join(ledger.ledgerPath, 'GOAL.md'));
  assert.equal(pointer.notesPath, path.join(ledger.ledgerPath, 'implementation-notes.html'));
  assert.equal(pointer.eventsPath, path.join(ledger.ledgerPath, 'progress.ndjson'));
  assert.equal(pointer.evidenceDir, path.join(ledger.ledgerPath, 'evidence'));
  assert.equal(pointer.missionId, 'msn-aa');
  assert.equal(pointer.featureId, 'feat-bb');
});

test('readGoalLedger returns parsed events and pointer', () => {
  const root = tempRoot();
  const ledger = ensureGoalLedger({
    rootDir: root,
    missionId: 'msn-1',
    featureId: 'feat-1',
    title: 'Read back',
  });
  appendGoalLedgerEvent({
    ledgerPath: ledger.ledgerPath,
    status: 'started',
    phase: 'plan',
    summary: 'kickoff',
  });
  appendGoalLedgerEvent({
    ledgerPath: ledger.ledgerPath,
    status: 'in_progress',
    phase: 'implement',
    summary: 'midway',
  });
  const read = readGoalLedger({ ledgerPath: ledger.ledgerPath });
  assert.equal(read.events.length, 2);
  assert.equal(read.events[0].status, 'started');
  assert.equal(read.events[1].status, 'in_progress');
  assert.match(read.goalMd, /# GOAL/);
  assert.equal(read.pointer.runId, ledger.runId);
});

test('ensureGoalLedger requires at least one of mission/feature/title', () => {
  const root = tempRoot();
  assert.throws(
    () => ensureGoalLedger({ rootDir: root }),
    /provide at least one of/
  );
});
