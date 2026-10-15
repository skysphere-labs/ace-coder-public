const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  writeDumpRecord,
  collectDumpRecords,
  extractProjectUpdateCandidates,
  validateCandidate,
  runNightlyProjectWikiCuration,
  auditProjectWiki,
} = require('../project-wiki-curator.cts');

function tempProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-project-wiki-'));
  fs.mkdirSync(path.join(dir, '.ace'), { recursive: true });
  return dir;
}

test('writeDumpRecord writes only to dump and redacts secret-like content', () => {
  const projectDir = tempProject();
  const result = writeDumpRecord({
    projectDir,
    kind: 'operator_note',
    identity: 'chief',
    projectId: 'prj_ace',
    projectName: 'Ace',
    summary: 'api_key=sk-123456789012345678901234 should never enter canon',
    source: 'unit-test',
  });

  assert.match(result.path, /\.ace\/wiki-dump\/chief\//);
  assert.equal(result.redacted, true);
  assert.match(result.record.summary, /\[REDACTED\]/);
  assert.equal(fs.existsSync(path.join(projectDir, '.ace', 'wiki', 'projects', 'ace.md')), false);
  assert.equal(typeof result.record.sha256, 'string');
});

test('writeDumpRecord quarantines raw transcript and failed-probe dumps', () => {
  const projectDir = tempProject();
  const transcript = writeDumpRecord({
    projectDir,
    kind: 'rook_session',
    identity: 'rook',
    projectId: 'prj_ace',
    projectName: 'Ace',
    summary: 'raw terminal transcript\nUser: hello\nAssistant: '.padEnd(180, 'x'),
  });
  assert.equal(transcript.quarantined, true);
  assert.match(transcript.path, /wiki-dump\/quarantine/);

  const probe = writeDumpRecord({
    projectDir,
    kind: 'validator',
    identity: 'ace',
    projectId: 'prj_ace',
    projectName: 'Ace',
    summary: 'socket not found while probing board',
  });
  assert.equal(probe.quarantined, true);
});

test('candidate extraction handles mission completion, blockers, decisions, separated identities, and external failed fetches', () => {
  const projectDir = tempProject();
  const mission = writeDumpRecord({
    projectDir,
    kind: 'ace_mission',
    identity: 'ace',
    projectId: 'prj_ace',
    projectName: 'Ace',
    missionId: 'msn_1',
    featureId: 'ft_1',
    completedItems: ['Mission smoke passed'],
    blockers: [{ text: 'Failed smoke blocks release', nextSafeStep: 'Fix failing smoke before release' }],
    decisions: ['Use dump/canon boundary for project wiki updates'],
    source: 'mission msn_1',
  });
  writeDumpRecord({
    projectDir,
    kind: 'rook_session',
    identity: 'rook',
    projectId: 'prj_ace',
    projectName: 'Ace',
    summary: 'Rook saw project wiki candidate extraction working.',
  });
  writeDumpRecord({
    projectDir,
    kind: 'king_session',
    identity: 'king',
    projectId: 'prj_ace',
    projectName: 'Ace',
    summary: 'King saw project wiki candidate extraction working.',
  });
  writeDumpRecord({
    projectDir,
    kind: 'external_link',
    identity: 'external',
    projectId: 'prj_ace',
    projectName: 'Ace',
    sourceUrl: 'https://x.com/example/status/1',
    fetchStatus: 'failed',
    summary: 'This must not become canon.',
  });

  const records = collectDumpRecords({ projectDir });
  assert.equal(records.filter((record: any) => record.identity === 'rook').length, 1);
  assert.equal(records.filter((record: any) => record.identity === 'king').length, 1);

  const candidates = extractProjectUpdateCandidates(records);
  assert.ok(candidates.some((candidate: any) => candidate.type === 'completed_item' && candidate.text === 'Mission smoke passed'));
  assert.ok(candidates.some((candidate: any) => candidate.type === 'blocker' && candidate.text === 'Failed smoke blocks release'));
  assert.ok(candidates.some((candidate: any) => candidate.type === 'next_action' && candidate.text === 'Fix failing smoke before release'));
  assert.ok(candidates.some((candidate: any) => candidate.type === 'decision'));
  assert.equal(candidates.some((candidate: any) => candidate.sourceDumpIds.includes(mission.record.id)), true);
  assert.equal(candidates.some((candidate: any) => /This must not become canon/.test(candidate.text)), false);
});

test('validateCandidate rejects vague candidates and conflicts on stale CLI claims', () => {
  const projectDir = tempProject();
  const dump = writeDumpRecord({
    projectDir,
    kind: 'operator_note',
    identity: 'chief',
    projectId: 'prj_ace',
    projectName: 'Ace',
    proposedNextActions: ['Ace is broken'],
    source: 'unit-test',
  });
  const vague = extractProjectUpdateCandidates([dump.record])[0];
  assert.equal(validateCandidate(vague, { projectDir }).ok, false);

  const cliClaim = {
    ...vague,
    text: 'Use ace missing command after curation.',
    sourceDumpIds: [dump.record.id],
  };
  const result = validateCandidate(cliClaim, { projectDir, describeCommands: ['wiki dump'] });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'conflicted');
  assert.match(result.errors.join(','), /cli-claim-not-installed/);
});

test('runNightlyProjectWikiCuration promotes sourced canon, dedupes next actions, writes report, and audit passes', () => {
  const projectDir = tempProject();
  writeDumpRecord({
    projectDir,
    kind: 'ace_mission',
    identity: 'ace',
    projectId: 'prj_ace',
    projectName: 'Ace',
    missionId: 'msn_2',
    featureId: 'ft_2',
    summary: 'Project wiki curator v2 has a source-backed nightly path.',
    proposedNextActions: ['Run wiki audit after nightly curation', 'Run wiki audit after nightly curation'],
    completedItems: ['Wire project wiki dump boundary'],
    decisions: ['Canonical project pages are only written by nightly curation'],
    blockers: ['Need validator review before merge'],
    source: 'mission msn_2',
  });

  const result = runNightlyProjectWikiCuration({
    projectDir,
    identity: 'all',
    describeCommands: ['wiki dump', 'wiki nightly', 'wiki pack', 'wiki audit'],
    now: '2026-05-23T12:00:00.000Z',
  });

  assert.equal(result.dumpsRead, 1);
  assert.ok(result.candidatesAccepted >= 5);
  assert.equal(result.audit.ok, true);
  assert.equal(fs.existsSync(result.reportPath), true);

  const projectPage = fs.readFileSync(path.join(projectDir, '.ace', 'wiki', 'projects', 'ace.md'), 'utf8');
  assert.match(projectPage, /^---\n/);
  assert.match(projectPage, /sources:\n  - "dump_/);
  assert.match(projectPage, /Wire project wiki dump boundary/);
  assert.match(projectPage, /Run wiki audit after nightly curation/);

  const nextActions = fs.readFileSync(path.join(projectDir, '.ace', 'wiki', '00_index', 'NEXT_ACTIONS.md'), 'utf8');
  assert.equal((nextActions.match(/Run wiki audit after nightly curation/g) || []).length, 1);
  assert.equal(auditProjectWiki({ projectDir }).ok, true);
});
