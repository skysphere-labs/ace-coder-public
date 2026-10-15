import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { auditVault } = require('../knowledge-audit.cts');

let root = '';

function writePage(relPath, content) {
  const target = path.join(root, relPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

function page(title, updatedAt, body = 'digest body') {
  return [`---`, `title: ${title}`, `updatedAt: ${updatedAt}`, `---`, '', body].join('\n');
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-audit-runs-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('superseded-duplicate detection excludes runs/**', () => {
  const now = Date.parse('2026-07-01T12:00:00Z');

  it('does not flag duplicate-titled run artifacts, but still flags duplicates elsewhere', () => {
    // Run artifacts legitimately share task titles across many append-only
    // events — these must NOT count as superseded duplicates.
    writePage('runs/2026-06/msn-abc-ft_1.md', page('Fix run-ledger effort override', '2026-06-20T00:00:00Z'));
    writePage('runs/2026-06/msn-abc-ft_2.md', page('Fix run-ledger effort override', '2026-06-21T00:00:00Z'));
    writePage('runs/2026-06/msn-abc-ft_3.md', page('Fix run-ledger effort override', '2026-06-22T00:00:00Z'));

    // A genuine duplicate outside runs/ must still be flagged.
    writePage('lessons/dup-new.md', page('Release gate lesson', '2026-06-09T00:00:00Z'));
    writePage('lessons/dup-old.md', page('Release gate lesson', '2026-05-01T00:00:00Z'));

    const result = auditVault({ root, label: 'test', now });
    const superseded = result.findings.filter((f) => f.type === 'superseded-duplicate');

    // Zero superseded-duplicate findings originate under runs/.
    expect(superseded.some((f) => f.path.includes(`${path.sep}runs${path.sep}`))).toBe(false);
    // The non-runs duplicate still flags exactly its older copy.
    expect(superseded.length).toBe(1);
    expect(superseded[0].path).toContain(path.join('lessons', 'dup-old.md'));
    expect(result.decayByPath[path.join(root, 'lessons/dup-old.md')].reasons).toContain('superseded-duplicate');
  });

  it('keeps all other checks (e.g. dead-wikilink) active for run artifacts', () => {
    writePage('runs/2026-06/msn-xyz-ft_1.md', page('Some run', '2026-06-20T00:00:00Z', 'See [[does-not-exist]].'));

    const result = auditVault({ root, label: 'test', now });
    const dead = result.findings.filter((f) => f.type === 'dead-wikilink');
    expect(dead.length).toBe(1);
    expect(dead[0].path).toContain(path.join('runs', '2026-06', 'msn-xyz-ft_1.md'));
    // ...and it is excluded from superseded-duplicate detection only.
    expect(result.findings.some((f) => f.type === 'superseded-duplicate')).toBe(false);
  });
});
