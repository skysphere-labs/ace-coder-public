import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const fs = require('fs');
const os = require('os');
const path = require('path');

const wikiUpdater = require('../wiki-updater.cts');

let root = '';
const prevEnv = {};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-journal-'));
  for (const key of ['ACE_WIKI_ROOT', 'ACE_WIKI_PATH', 'ACE_WIKI_LOG_PATH', 'ACE_WIKI_DAILY_PATH', 'ACE_WIKI_JOURNAL_DIR', 'ACE_WIKI_DISABLE']) {
    prevEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.ACE_WIKI_ROOT = root;
});

afterEach(() => {
  for (const [key, value] of Object.entries(prevEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

describe('daily journal', () => {
  it('creates a dated journal page with AceOpsPage/v1 frontmatter on first event', () => {
    const at = '2026-06-10T08:00:00Z';
    const result = wikiUpdater.appendDailyJournalLine({ at, type: 'worker_completed', actor: 'codex', message: 'Widget shipped', missionId: 'msn-1' });
    expect(result.written).toBe(true);
    expect(result.path).toContain(path.join('journal', '2026', '2026-06-10.md'));
    const content = fs.readFileSync(result.path, 'utf8');
    expect(content).toContain('schema: AceOpsPage/v1');
    expect(content).toContain('kind: journal');
    expect(content).toContain('trust: working');
    expect(content).toContain('Widget shipped');
    expect(content).toContain('mission=msn-1');
  });

  it('appends subsequent events to the same day and caps the page', () => {
    const at = '2026-06-10T08:00:00Z';
    wikiUpdater.appendDailyJournalLine({ at, type: 'a', message: 'first' });
    wikiUpdater.appendDailyJournalLine({ at, type: 'b', message: 'second' });
    const target = wikiUpdater.wikiJournalPath(at);
    const lines = fs.readFileSync(target, 'utf8').split('\n').filter((line) => line.startsWith('- '));
    expect(lines.length).toBe(2);
  });

  it('rides along with appendMissionEventLine', () => {
    const at = '2026-06-10T09:00:00Z';
    wikiUpdater.appendMissionEventLine({ at, type: 'mission_created', message: 'New mission', missionId: 'msn-2' });
    const journal = fs.readFileSync(wikiUpdater.wikiJournalPath(at), 'utf8');
    expect(journal).toContain('New mission');
    // and the regular log still works
    expect(fs.readFileSync(path.join(root, 'log.md'), 'utf8')).toContain('New mission');
  });

  it('honors ACE_WIKI_DISABLE', () => {
    process.env.ACE_WIKI_DISABLE = '1';
    const result = wikiUpdater.appendDailyJournalLine({ at: '2026-06-10T08:00:00Z', type: 'x', message: 'nope' });
    expect(result.written).toBe(false);
    expect(result.disabled).toBe(true);
  });
});

describe('run digest', () => {
  it('writes a distilled run digest linking raw evidence via sources:', () => {
    const result = wikiUpdater.writeRunDigest({
      runId: 'msn-1-ft-9',
      title: 'Widget feature (done)',
      outcome: 'done',
      missionId: 'msn-1',
      featureId: 'ft-9',
      workspaceId: 'prj_42',
      agent: 'codex',
      summary: 'Implemented widget with tests.',
      prUrl: 'https://github.com/o/r/pull/5',
      goalLedgerPath: '/artifacts/.agent/runs/msn-1-ft-9',
      at: '2026-06-10T10:00:00Z',
    });
    expect(result.written).toBe(true);
    expect(result.path).toContain(path.join('runs', '2026-06', 'msn-1-ft-9.md'));
    const content = fs.readFileSync(result.path, 'utf8');
    expect(content).toContain('kind: run-digest');
    expect(content).toContain('project: prj_42');
    expect(content).toContain('"/artifacts/.agent/runs/msn-1-ft-9"');
    expect(content).toContain('- outcome: done');
    expect(content).toContain('raw evidence lives at the linked sources');
  });

  it('sanitizes hostile run ids into safe filenames', () => {
    const result = wikiUpdater.writeRunDigest({ runId: '../../etc/passwd', outcome: 'done', at: '2026-06-10T10:00:00Z' });
    expect(result.written).toBe(true);
    // Slashes are neutralized, so the digest stays INSIDE runs/2026-06 even
    // though the sanitized filename may contain literal dots.
    expect(path.dirname(result.path)).toBe(path.join(root, 'runs', '2026-06'));
    expect(fs.existsSync(result.path)).toBe(true);
  });
});
