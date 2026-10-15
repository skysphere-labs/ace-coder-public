import { describe, expect, it } from 'vitest';

const contract = require('../harness/knowledge-contract.cts');

describe('knowledge-contract', () => {
  it('exposes the exact failed-snapshot sentinel', () => {
    expect(contract.WIKI_FAILED_SNAPSHOT_SENTENCE).toBe(
      'Snapshot failed; do not infer current state from this section.',
    );
  });

  it('flags dormant-stream and transcript contamination', () => {
    expect(contract.describeContamination('dormant (3): old streams')).toContain('raw-dormant-stream');
    expect(contract.describeContamination('| state=dormant |')).toContain('raw-dormant-stream');
    expect(contract.describeContamination('live=false')).toContain('raw-dormant-stream');
    expect(contract.describeContamination('raw terminal transcript follows')).toContain('raw-transcript');
    expect(contract.describeContamination('a perfectly clean status line')).toEqual([]);
  });

  it('treats failed probes as leaks unless sentinel accompanies them (allowSentinel)', () => {
    const probeText = 'probe: ECONNREFUSED on socket';
    expect(contract.describeContamination(probeText)).toContain('failed-probe-leak');
    expect(contract.describeContamination(probeText, { allowSentinel: false })).toContain('failed-probe-leak');
    const withSentinel = `${probeText}\n${contract.WIKI_FAILED_SNAPSHOT_SENTENCE}`;
    expect(contract.describeContamination(withSentinel, { allowSentinel: true })).toEqual([]);
    expect(contract.describeContamination(withSentinel, { allowSentinel: false })).toContain('failed-probe-leak');
  });

  it('detects and redacts secret-like content', () => {
    const dirty = 'api_key: abcd1234efgh5678ijkl';
    expect(contract.secretHits(dirty).length).toBeGreaterThan(0);
    expect(contract.redactSecrets(dirty)).toContain('[REDACTED]');
    expect(contract.secretHits({ nested: ['ghp_' + 'a'.repeat(24)] }).length).toBeGreaterThan(0);
    expect(contract.secretHits('no secrets here')).toEqual([]);
  });

  it('formats the failed-snapshot section with the sentinel', () => {
    const block = contract.formatFailedSnapshotSection({
      section: 'GitHub',
      command: 'gh pr list',
      failureReason: '401 unauthorized',
      nextLiveCommand: 'gh auth status',
    });
    expect(block).toContain('## GitHub');
    expect(block).toContain(contract.WIKI_FAILED_SNAPSHOT_SENTENCE);
    expect(block).toContain('- status: non-authoritative');
  });

  it('parses frontmatter with scalars, inline arrays and block arrays', () => {
    const page = [
      '---',
      'schema: AceOpsPage/v1',
      'kind: lesson',
      'title: Hard-won lesson',
      'trust: canon',
      'tags: [ace, lesson, x/gym]',
      'sources:',
      '  - run_abc',
      '  - dump_def',
      'confidence: 0.9',
      'updatedAt: 2026-06-10T00:00:00Z',
      '---',
      '',
      '# Hard-won lesson',
    ].join('\n');
    const { present, data, body } = contract.parseFrontmatter(page);
    expect(present).toBe(true);
    expect(data.schema).toBe('AceOpsPage/v1');
    expect(data.tags).toEqual(['ace', 'lesson', 'x/gym']);
    expect(data.sources).toEqual(['run_abc', 'dump_def']);
    expect(data.confidence).toBe(0.9);
    expect(body).toContain('# Hard-won lesson');
    expect(contract.parseFrontmatter('no frontmatter').present).toBe(false);
  });

  it('validates AceOpsPage/v1 frontmatter and tolerates legacy pages forever', () => {
    const legacy = contract.validateOpsPageFrontmatter({});
    expect(legacy.ok).toBe(true);
    expect(legacy.legacy).toBe(true);
    const otherSchema = contract.validateOpsPageFrontmatter({ schema: 'AceProjectPage/v1' });
    expect(otherSchema.ok).toBe(true);

    const good = contract.validateOpsPageFrontmatter({
      schema: 'AceOpsPage/v1', kind: 'decision', trust: 'canon',
      sources: ['run_1'], tags: ['decision', 'x/side-project'],
    });
    expect(good).toMatchObject({ ok: true, legacy: false });

    const canonNoSources = contract.validateOpsPageFrontmatter({
      schema: 'AceOpsPage/v1', kind: 'decision', trust: 'canon', sources: [],
    });
    expect(canonNoSources.ok).toBe(false);
    expect(canonNoSources.errors.join(' ')).toContain('sources');

    const badTag = contract.validateOpsPageFrontmatter({
      schema: 'AceOpsPage/v1', kind: 'lesson', trust: 'working', tags: ['totally-free-tag'],
    });
    expect(badTag.ok).toBe(false);
    expect(badTag.errors.join(' ')).toContain('x/');
  });

  it('infers trust and kind from vault paths', () => {
    expect(contract.inferVaultTrust('inbox/idea.md')).toBe('raw');
    expect(contract.inferVaultTrust('dashboards/current-state.md')).toBe('canon');
    expect(contract.inferVaultTrust('journal/2026/2026-06-10.md')).toBe('working');
    expect(contract.inferVaultTrust('somewhere-else/page.md')).toBe('working');
    expect(contract.inferVaultKind('lessons/foo.md')).toBe('lesson');
    expect(contract.inferVaultKind('portfolios/ace.md')).toBe('project');
    expect(contract.inferVaultKind('runs/2026-06/run_1.md')).toBe('run-digest');
  });

  it('allows vocabulary tags and x/ free tags only', () => {
    expect(contract.isAllowedTag('ace')).toBe(true);
    expect(contract.isAllowedTag('lesson')).toBe(true);
    expect(contract.isAllowedTag('x/marathon')).toBe(true);
    expect(contract.isAllowedTag('x/')).toBe(false);
    expect(contract.isAllowedTag('random-tag')).toBe(false);
  });
});
