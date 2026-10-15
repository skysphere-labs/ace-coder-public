const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const wk = require('../wiki-knowledge.cts');
const curator = require('../project-wiki-curator.cts');
const verdict = require('../verdict.cts');

function tempProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-wiki-knowledge-'));
  fs.mkdirSync(path.join(dir, '.ace'), { recursive: true });
  return dir;
}
function baseEvent(extra = {}) {
  return {
    kind: 'goal_done', projectId: 'prj_demo', projectName: 'Demo',
    summary: 'Shipped the canon-first retrieval path', sourceRef: '900', confidence: 0.9, ...extra,
  };
}
function wikiText(projectDir, rel) {
  return fs.readFileSync(path.join(projectDir, '.ace', 'wiki', rel), 'utf8');
}

// --- KnowledgeEvent store (A2.1) -------------------------------------------

test('appendKnowledgeEvent appends an append-only, schema-tagged record', () => {
  const dir = tempProject();
  const result = wk.appendKnowledgeEvent({ projectDir: dir, event: baseEvent() });
  assert.equal(result.appended, true);
  assert.match(result.eventId, /^evt_[0-9a-f]{16}$/);
  const events = wk.readKnowledgeEvents({ projectDir: dir });
  assert.equal(events.length, 1);
  assert.equal(events[0].schema, 'AceKnowledgeEvent/v1');
  assert.equal(events[0].kind, 'goal_done');
});

test('appendKnowledgeEvent is content-addressed: re-emitting the same event dedupes', () => {
  const dir = tempProject();
  const first = wk.appendKnowledgeEvent({ projectDir: dir, event: baseEvent() });
  const second = wk.appendKnowledgeEvent({ projectDir: dir, event: baseEvent() });
  assert.equal(first.eventId, second.eventId);
  assert.equal(second.appended, false);
  assert.equal(wk.readKnowledgeEvents({ projectDir: dir }).length, 1);
});

test('appendKnowledgeEvent requires a projectId', () => {
  const dir = tempProject();
  assert.throws(() => wk.appendKnowledgeEvent({ projectDir: dir, event: baseEvent({ projectId: '' }) }), /projectId/);
});

test('appendKnowledgeEvent redacts secrets and quarantines contamination', () => {
  const dir = tempProject();
  const secret = wk.appendKnowledgeEvent({ projectDir: dir, event: baseEvent({ summary: 'token=sk-abcdefghijklmnopqrstuvwxyz123456' }) });
  assert.ok(JSON.stringify(secret.event).includes('[REDACTED]'));
  const dirty = wk.appendKnowledgeEvent({ projectDir: dir, event: baseEvent({ summary: 'normal', facts: ['User: ' + 'x'.repeat(130) + ' Assistant: leak'] }) });
  assert.equal(dirty.event.quarantined, true);
  // Quarantined events are excluded from default reads and never produce candidates.
  assert.deepEqual(wk.eventToCandidates(dirty.event), []);
});

test('appendKnowledgeEvent never writes canon directly (A4.3 — evidence only)', () => {
  const dir = tempProject();
  wk.appendKnowledgeEvent({ projectDir: dir, event: baseEvent() });
  assert.equal(fs.existsSync(path.join(dir, '.ace', 'wiki')), false);
});

// --- Candidate extraction (A2.2 / A2.3) ------------------------------------

test('eventToCandidates populates sourceEventIds on every candidate (A2.2)', () => {
  const event = wk.appendKnowledgeEvent({
    projectDir: tempProject(),
    event: baseEvent({ decisions: ['Threshold is 0.8'], blockers: ['CI flake'], completedItems: ['Wired gate'] }),
  }).event;
  const candidates = wk.eventToCandidates(event);
  assert.ok(candidates.length >= 4);
  for (const candidate of candidates) {
    assert.deepEqual(candidate.sourceEventIds, [event.eventId]);
    assert.match(candidate.candidateId, /^cand_/);
  }
  assert.ok(candidates.some((c) => c.type === 'decision'));
});

test('gate rejects a candidate with no resolvable source event (A2.3)', () => {
  const candidate = { type: 'fact', text: 'a sourceless claim about things', sourceEventIds: [], confidence: 0.95, sensitivity: 'public', candidateId: 'cand_x' };
  const result = wk.gateCandidate(candidate, { canonStatements: [] });
  assert.equal(result.decision, 'reject');
  assert.ok(result.reasons.includes('missing-source-event'));
});

// --- Tiered promotion gate (A3.1–A3.3) -------------------------------------

function candidate(extra = {}) {
  return {
    type: 'status_update', text: 'The release gate requires validator PASS before merge',
    sourceEventIds: ['evt_1'], confidence: 0.9, sensitivity: 'public', supersedes: null,
    candidateId: 'cand_1', projectId: 'prj_demo', targetPage: 'projects/demo.md', ...extra,
  };
}

test('A3.1 sourced + high-confidence + non-sensitive + non-conflicting auto-promotes', () => {
  const result = wk.gateCandidate(candidate(), { canonStatements: [], threshold: 0.8 });
  assert.equal(result.decision, 'auto_promote');
  assert.equal(result.candidate.status, 'auto_promoted');
});

test('A3.2 a supersede/contradiction ALWAYS routes to inbox, even at confidence 1.0', () => {
  const sup = wk.gateCandidate(candidate({ confidence: 1.0, text: 'The threshold no longer 0.8 — this replaces the prior policy' }), { canonStatements: [], threshold: 0.8 });
  assert.equal(sup.decision, 'inbox');
  assert.ok(sup.reasons.some((r) => r.startsWith('contradicts-canon')));

  // value-conflict against existing canon also forces inbox
  const canon = [{ page: 'decisions/demo-decisions.md', text: 'Auto-promote threshold is 0.8' }];
  const conflict = wk.gateCandidate(candidate({ type: 'decision', confidence: 1.0, text: 'Auto-promote threshold is 0.9' }), { canonStatements: canon, threshold: 0.8 });
  assert.equal(conflict.decision, 'inbox');
});

test('A3.3 sensitive (restricted/forbidden) candidate never auto-promotes', () => {
  for (const sensitivity of ['restricted', 'forbidden']) {
    const result = wk.gateCandidate(candidate({ confidence: 1.0, sensitivity }), { canonStatements: [], threshold: 0.8 });
    assert.equal(result.decision, 'inbox', `sensitivity=${sensitivity}`);
    assert.ok(result.reasons.some((r) => r.startsWith('sensitive')));
  }
});

test('low-confidence candidate routes to inbox', () => {
  const result = wk.gateCandidate(candidate({ confidence: 0.5 }), { canonStatements: [], threshold: 0.8 });
  assert.equal(result.decision, 'inbox');
  assert.ok(result.reasons.some((r) => r.startsWith('below-confidence-threshold')));
});

// --- End-to-end curation + inbox + promote (A3.4) --------------------------

test('curateFromEvents auto-promotes safe events to canon and queues the rest in the inbox', () => {
  const dir = tempProject();
  curator.bootstrapWikiSkeleton({ projectDir: dir, projectId: 'prj_demo', projectName: 'Demo' });
  wk.appendKnowledgeEvent({ projectDir: dir, event: baseEvent({ summary: 'Completed the merge-gate wiring end to end' }) });
  wk.appendKnowledgeEvent({ projectDir: dir, event: baseEvent({ kind: 'chief_decision', summary: 'New policy replaces the prior merge rule', confidence: 0.95 }) });
  wk.appendKnowledgeEvent({ projectDir: dir, event: baseEvent({ kind: 'research_capture', summary: 'Private customer detail', sensitivity: 'restricted', confidence: 0.95 }) });

  const result = wk.curateFromEvents({ projectDir: dir });
  assert.equal(result.autoPromoted, 1);
  assert.equal(result.inboxed, 2);
  assert.ok(wikiText(dir, 'projects/demo.md').includes('merge-gate wiring'));

  // Inbox is durable and pending until reviewed.
  const pending = wk.readInbox({ projectDir: dir });
  assert.equal(pending.length, 2);

  // Idempotent: re-running adds no new inbox entries.
  wk.curateFromEvents({ projectDir: dir });
  assert.equal(wk.readInbox({ projectDir: dir }).length, 2);
});

test('A3.4 wiki promote writes the reviewed candidate into canon and resolves the inbox entry', () => {
  const dir = tempProject();
  curator.bootstrapWikiSkeleton({ projectDir: dir, projectId: 'prj_demo', projectName: 'Demo' });
  wk.appendKnowledgeEvent({ projectDir: dir, event: baseEvent({ kind: 'chief_decision', decisions: ['Adopt trunk-based flow, replacing the old gitflow'], confidence: 0.95, summary: '' }) });
  wk.curateFromEvents({ projectDir: dir });
  const entry = wk.readInbox({ projectDir: dir })[0];
  assert.ok(entry);

  const promoted = wk.promoteInboxEntry({ projectDir: dir, inboxId: entry.inboxId });
  assert.equal(promoted.ok, true);
  assert.ok(promoted.written.length >= 1);
  assert.ok(wikiText(dir, 'decisions/demo-decisions.md').includes('trunk-based flow'));
  // Resolved → no longer pending.
  assert.equal(wk.readInbox({ projectDir: dir }).length, 0);
});

test('rejecting an inbox entry resolves it without writing canon', () => {
  const dir = tempProject();
  curator.bootstrapWikiSkeleton({ projectDir: dir, projectId: 'prj_demo', projectName: 'Demo' });
  wk.appendKnowledgeEvent({ projectDir: dir, event: baseEvent({ summary: 'New rule replaces the old one', confidence: 0.95 }) });
  wk.curateFromEvents({ projectDir: dir });
  const entry = wk.readInbox({ projectDir: dir })[0];
  const res = wk.resolveInbox({ projectDir: dir, inboxId: entry.inboxId, status: 'rejected' });
  assert.equal(res.ok, true);
  assert.equal(wk.readInbox({ projectDir: dir }).length, 0);
});

// --- WIKI_UPDATE writeback packet (A4.1) -----------------------------------

const DONE_WITH_PACKET = [
  'DONE: VERDICT=PASS on https://x/pr/900 {"verdict":"pass","scorecard":[{"id":"A1","met":true},{"id":"A2","met":false}]}',
  '',
  'WIKI_UPDATE:',
  '  project: prj_demo',
  '  events:',
  '    - kind: pr_merge',
  '      summary: Merged PR 900 to main',
  '      sourceRef: 900',
  '      sensitivity: internal',
  '      confidence: 0.9',
  '    - kind: validator_pass',
  '      summary: Validator passed on exact head',
  '      sourceRef: conv-abc',
].join('\n');

test('parseWikiUpdatePacket extracts the events block', () => {
  const packet = wk.parseWikiUpdatePacket(DONE_WITH_PACKET);
  assert.equal(packet.project, 'prj_demo');
  assert.equal(packet.events.length, 2);
  assert.equal(packet.events[0].kind, 'pr_merge');
  assert.equal(packet.events[0].sourceRef, '900');
  assert.equal(packet.events[1].kind, 'validator_pass');
});

test('parseWikiUpdatePacket returns null when no packet is present', () => {
  assert.equal(wk.parseWikiUpdatePacket('DONE: VERDICT=PASS on https://x/pr/1 {"verdict":"pass"}'), null);
});

test('A4.1 a WIKI_UPDATE block does not disturb DONE/BLOCKED/VERDICT parsing', () => {
  // The verdict parser is independent: same verdict + scorecard with or without the packet.
  assert.equal(verdict.parseVerdictText(DONE_WITH_PACKET), 'pass');
  const scorecard = verdict.parseCriterionScorecard(DONE_WITH_PACKET);
  assert.equal(scorecard.length, 2);
  assert.equal(scorecard.find((s) => s.id === 'A1').met, true);
  assert.equal(scorecard.find((s) => s.id === 'A2').met, false);
});

test('projectId-only WIKI_UPDATE resolves to the existing project page (no projects/<projectId>.md duplicate)', () => {
  const dir = tempProject();
  // An existing project canon page: projectId prj-e33a215d, name "Brampton".
  curator.writeDumpRecord({ projectDir: dir, record: { kind: 'operator_note', identity: 'chief', projectId: 'prj-e33a215d', projectName: 'Brampton', summary: 'Existing Brampton project page' } });
  curator.backfillProject({ projectDir: dir, projectId: 'prj-e33a215d', projectName: 'Brampton' });
  assert.ok(fs.existsSync(path.join(dir, '.ace', 'wiki', 'projects', 'brampton.md')));
  // projectId resolves to the existing page's name.
  assert.equal(wk.resolveProjectName(dir, 'prj-e33a215d', null), 'Brampton');

  // A projectId-ONLY (no projectName), high-confidence WIKI_UPDATE.
  wk.ingestWikiUpdate({
    projectDir: dir,
    text: ['DONE', 'WIKI_UPDATE:', '  project: prj-e33a215d', '  events:',
      '    - kind: goal_done', '      summary: Shipped the canon-first retrieval path for Brampton', '      confidence: 0.9'].join('\n'),
  });
  wk.curateFromEvents({ projectDir: dir });

  const pages = fs.readdirSync(path.join(dir, '.ace', 'wiki', 'projects'));
  assert.ok(pages.includes('brampton.md'));
  assert.ok(!pages.includes('prj-e33a215d.md'), 'must not mint a projectId-named duplicate page');
  assert.ok(wikiText(dir, 'projects/brampton.md').includes('canon-first retrieval path for Brampton'));
});

test('ingestWikiUpdate appends one KnowledgeEvent per packet event', () => {
  const dir = tempProject();
  const result = wk.ingestWikiUpdate({ projectDir: dir, text: DONE_WITH_PACKET });
  assert.equal(result.project, 'prj_demo');
  assert.equal(result.events.length, 2);
  const events = wk.readKnowledgeEvents({ projectDir: dir });
  assert.equal(events.length, 2);
  assert.ok(events.some((e) => e.kind === 'pr_merge'));
  // No canon written by ingest — promotion is a separate gated step (A4.3).
  assert.equal(curator.hasCanon(dir), false);
});
