import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  auditVault,
  applyQuarantine,
  rotateKnowledgeArtifacts,
  renderAuditReport,
} = require('../knowledge-audit.cts');

let root = '';

function writePage(relPath, content) {
  const target = path.join(root, relPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

function countFiles(dir) {
  let count = 0;
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else count += 1;
    }
  };
  walk(dir);
  return count;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-audit-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('auditVault', () => {
  it('flags every finding type with decay + proposals and never deletes anything', () => {
    const now = Date.parse('2026-06-10T12:00:00Z');
    // invalid frontmatter (claims schema, bad kind + canon without sources)
    writePage('decisions/bad.md', '---\nschema: AceOpsPage/v1\nkind: nonsense\ntrust: canon\nsources: []\n---\nbody');
    // contamination in a curated page
    writePage('concepts/dirty.md', '# Dirty\ndormant (3): stream wall');
    // expired fact
    writePage('todo/expired.md', '---\nschema: AceOpsPage/v1\nkind: todo\ntrust: working\nexpiresAt: 2026-01-01T00:00:00Z\n---\nold todo');
    // stale canon (legacy Updated: line far in the past)
    writePage('concepts/stale.md', '# Stale concept\n\nUpdated: 2025-01-01 10:00:00 EST\n\nold but canon');
    // duplicate titles — older copy decays
    writePage('lessons/dup-new.md', `---\nschema: AceOpsPage/v1\nkind: lesson\ntrust: canon\nsources: [run_2]\ntitle: Same Lesson\nupdatedAt: 2026-06-09T00:00:00Z\n---\nnew copy`);
    writePage('lessons/dup-old.md', `---\nschema: AceOpsPage/v1\nkind: lesson\ntrust: canon\nsources: [run_1]\ntitle: Same Lesson\nupdatedAt: 2026-05-01T00:00:00Z\n---\nold copy`);
    // dead wikilink
    writePage('concepts/linker.md', '# Linker\nSee [[does-not-exist]].');
    // raw-tier secret → quarantine candidate
    writePage('inbox/leak.md', '# Leak\ntoken: abcdef1234567890XYZ');
    // free tags used often → promotion proposal
    for (let i = 0; i < 7; i += 1) {
      writePage(`references/tagged-${i}.md`, `---\nschema: AceOpsPage/v1\nkind: reference\ntrust: working\ntags: [x/marathon]\nupdatedAt: 2026-06-09T00:00:00Z\n---\npage ${i}`);
    }

    const before = countFiles(root);
    const result = auditVault({ root, label: 'test', now });

    const types = new Set(result.findings.map((finding) => finding.type));
    for (const expected of ['invalid-frontmatter', 'contamination', 'expired-fact', 'stale-canon', 'superseded-duplicate', 'dead-wikilink', 'secret-content']) {
      expect(types.has(expected), `missing finding: ${expected}`).toBe(true);
    }

    // decay assignments, recomputed not ratcheted, never deletions
    expect(result.decayByPath[path.join(root, 'concepts/dirty.md')].decay).toBe(0.1);
    expect(result.decayByPath[path.join(root, 'lessons/dup-old.md')].decay).toBe(0.5);
    expect(result.decayByPath[path.join(root, 'lessons/dup-new.md')]).toBeUndefined();
    expect(result.decayByPath[path.join(root, 'todo/expired.md')].reasons).toContain('expired-fact');

    // quarantine candidates limited to raw tier
    expect(result.quarantineCandidates.length).toBe(1);
    expect(result.quarantineCandidates[0].path).toContain('inbox/leak.md');

    // proposals exist (incl. tag promotion); audit itself deleted nothing
    expect(result.proposals.some((proposal) => proposal.type === 'promote-tag')).toBe(true);
    expect(countFiles(root)).toBe(before);
  });

  it('passes a clean healthy vault with zero findings', () => {
    writePage('lessons/clean.md', `---\nschema: AceOpsPage/v1\nkind: lesson\ntrust: canon\nsources: [run_1]\ntitle: Clean\nupdatedAt: ${new Date().toISOString()}\ntags: [lesson]\n---\nAll good.`);
    const result = auditVault({ root, label: 'test', now: Date.now() });
    expect(result.findings).toEqual([]);
    expect(Object.keys(result.decayByPath)).toEqual([]);
  });
});

describe('applyQuarantine', () => {
  it('moves raw offenders into quarantine/YYYY-MM-DD with reason sidecars — never deletes', () => {
    const offender = writePage('inbox/leak.md', '# Leak\ntoken: abcdef1234567890XYZ');
    const moved = applyQuarantine({ root, candidates: [{ path: offender, reason: 'secret-content' }], now: Date.parse('2026-06-10T12:00:00Z') });
    expect(moved.length).toBe(1);
    expect(fs.existsSync(offender)).toBe(false);
    expect(fs.existsSync(moved[0].to)).toBe(true); // content preserved
    const sidecar = JSON.parse(fs.readFileSync(`${moved[0].to}.quarantine.json`, 'utf8'));
    expect(sidecar.reason).toBe('secret-content');
    expect(moved[0].to).toContain(path.join('quarantine', '2026-06-10'));
  });

  it('refuses to move anything outside the vault root', () => {
    const outside = path.join(os.tmpdir(), `outside-${Date.now()}.md`);
    fs.writeFileSync(outside, 'outside');
    const moved = applyQuarantine({ root, candidates: [{ path: outside, reason: 'x' }] });
    expect(moved.length).toBe(0);
    expect(fs.existsSync(outside)).toBe(true);
    fs.rmSync(outside, { force: true });
  });
});

describe('rotateKnowledgeArtifacts', () => {
  it('archives old log.md months and trims ndjson, preserving every line', () => {
    const now = Date.parse('2026-06-10T12:00:00Z');
    const oldLines = Array.from({ length: 3000 }, (_, i) => `- [2026-05-01T00:00:0${i % 10}Z] note — old entry ${i} ${'x'.repeat(80)}`);
    const newLines = Array.from({ length: 10 }, (_, i) => `- [2026-06-09T00:00:00Z] note — current entry ${i}`);
    writePage('log.md', `# log\n${[...oldLines, ...newLines].join('\n')}\n`);

    const stateDir = path.join(root, 'state');
    fs.mkdirSync(path.join(stateDir, 'probes'), { recursive: true });
    const ndjsonLines = Array.from({ length: 6000 }, (_, i) => JSON.stringify({ i, pad: 'y'.repeat(200) }));
    fs.writeFileSync(path.join(stateDir, 'probes', '2026-06-01.ndjson'), `${ndjsonLines.join('\n')}\n`);

    const result = rotateKnowledgeArtifacts({ wikiRoot: root, stateDir, now });
    expect(result.rotated.length).toBe(2);

    // log.md: current month kept, old month archived, nothing lost
    const keptLog = fs.readFileSync(path.join(root, 'log.md'), 'utf8');
    const archivedLog = fs.readFileSync(path.join(root, 'logs', '2026-06', 'log.md'), 'utf8');
    expect(keptLog).toContain('current entry 0');
    expect(keptLog).not.toContain('old entry 0');
    expect(archivedLog).toContain('old entry 0');
    expect(archivedLog.split('\n').filter(Boolean).length).toBe(oldLines.length);

    // ndjson: last 500 kept live, the rest archived
    const keptNdjson = fs.readFileSync(path.join(stateDir, 'probes', '2026-06-01.ndjson'), 'utf8').split('\n').filter(Boolean);
    const archivedNdjson = fs.readFileSync(path.join(stateDir, 'probes', 'archive', '2026-06-01.ndjson.2026-06.ndjson'), 'utf8').split('\n').filter(Boolean);
    expect(keptNdjson.length).toBe(500);
    expect(keptNdjson.length + archivedNdjson.length).toBe(ndjsonLines.length);
  });

  it('proposes (never rewrites) current-state rotation', () => {
    writePage('dashboards/current-state.md', `# state\n${'z'.repeat(60 * 1024)}`);
    const result = rotateKnowledgeArtifacts({ wikiRoot: root, stateDir: path.join(root, 'state'), now: Date.now() });
    expect(result.proposals.some((proposal) => proposal.type === 'rotate-current-state')).toBe(true);
    expect(fs.readFileSync(path.join(root, 'dashboards', 'current-state.md'), 'utf8').length).toBeGreaterThan(60 * 1024);
  });
});

describe('renderAuditReport', () => {
  it('renders a AceKnowledgeAuditReport/v1 page with findings + proposals', () => {
    const report = renderAuditReport({
      generatedAt: '2026-06-10T03:30:00Z',
      vaults: [{ findings: [{ type: 'contamination', path: '/x.md', detail: 'raw-dormant-stream', severity: 'yellow' }], proposals: [{ type: 'clean-contamination', path: '/x.md', detail: 'raw-dormant-stream' }], pagesChecked: 5, decayByPath: {}, quarantineCandidates: [] }],
      rotation: { rotated: [], proposals: [] },
      quarantined: [],
      curation: [],
      indexStats: { indexed: 3, removed: 0, scanned: 10 },
    });
    expect(report).toContain('schema: AceKnowledgeAuditReport/v1');
    expect(report).toContain('contamination — /x.md');
    expect(report).toContain('pages checked: 5');
    expect(report).toContain('nothing auto-deleted');
  });
});

describe('resolveQuarantineItem', () => {
  const { resolveQuarantineItem } = require('../knowledge-audit.cts');

  function quarantineFixture() {
    const offender = writePage('inbox/leak.md', '# Leak\ntoken: abcdef1234567890XYZ');
    const [moved] = applyQuarantine({ root, candidates: [{ path: offender, reason: 'secret-content' }], now: Date.parse('2026-06-10T12:00:00Z') });
    return moved;
  }

  it('approve restores the file to its original path and archives the sidecar', () => {
    const moved = quarantineFixture();
    const result = resolveQuarantineItem({ wikiRoot: root, itemPath: moved.to, action: 'approve', now: Date.parse('2026-06-11T09:00:00Z') });
    expect(result.ok).toBe(true);
    expect(result.restoredTo).toBe(path.join(root, 'inbox/leak.md'));
    expect(fs.existsSync(result.restoredTo)).toBe(true);
    expect(fs.existsSync(moved.to)).toBe(false);
    // sidecar archived under resolved/, not deleted
    const resolvedDir = path.join(root, 'quarantine', 'resolved');
    expect(fs.readdirSync(resolvedDir).length).toBe(1);
  });

  it('approve falls back to inbox/restored-* when the original path is occupied', () => {
    const moved = quarantineFixture();
    fs.writeFileSync(path.join(root, 'inbox', 'leak.md'), '# replacement');
    const result = resolveQuarantineItem({ wikiRoot: root, itemPath: moved.to, action: 'approve' });
    expect(result.ok).toBe(true);
    expect(result.restoredTo).toContain(path.join('inbox', 'restored-leak.md'));
  });

  it('reject parks the file + sidecar under quarantine/rejected/ — kept on disk', () => {
    const moved = quarantineFixture();
    const result = resolveQuarantineItem({ wikiRoot: root, itemPath: moved.to, action: 'reject', now: Date.parse('2026-06-11T09:00:00Z') });
    expect(result.ok).toBe(true);
    expect(result.movedTo).toContain(path.join('quarantine', 'rejected', '2026-06-11'));
    expect(fs.existsSync(result.movedTo)).toBe(true);
    expect(fs.existsSync(`${result.movedTo}.quarantine.json`)).toBe(true);
  });

  it('refuses paths outside quarantine and bad actions', () => {
    const canonPage = writePage('lessons/safe.md', '# Safe');
    expect(resolveQuarantineItem({ wikiRoot: root, itemPath: canonPage, action: 'reject' }).ok).toBe(false);
    expect(resolveQuarantineItem({ wikiRoot: root, itemPath: canonPage, action: 'shred' }).ok).toBe(false);
    expect(fs.existsSync(canonPage)).toBe(true);
  });
});
