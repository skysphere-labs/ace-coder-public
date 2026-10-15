// knowledge-eval.cts — deterministic self-check for the knowledge plane.
//
// LongMemEval-inspired categories, scaled to minutes and graded WITHOUT an
// LLM judge: a fixture corpus with gold answers, retrieval graded as R@5
// plus decay-filter assertions. Five categories:
//   lookup            — single-fact retrieval (gold doc in top-5)
//   cross-project     — project filters isolate the right corpus
//   temporal          — fresh facts outrank stale; expired facts excluded
//   knowledge-update  — newer canon outranks its superseded duplicate
//   abstention        — answers that exist ONLY in decayed/raw content must
//                       not surface as authoritative (the decay engine test)
//
// The eval takes the SEARCH FUNCTION as input, so a sabotaged ranking
// (inverted trust, broken decay filter) measurably FAILS — that is the
// regression-detection guarantee, asserted in tests.
//
// Constraints: Node built-ins only; Database injected; fail-safe.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { KNOWLEDGE_SCHEMAS } = require('./harness/knowledge-contract.cts');
const { createKnowledgeIndex } = require('./knowledge-index.cts');

const TOP_K = 5;

function isoDaysAgo(now: number, days: number) {
  return new Date(now - days * 24 * 60 * 60 * 1000).toISOString();
}

function page({ kind = 'lesson', trust = 'canon', title, tags = ['ace'], updatedAt, expiresAt, body }: any) {
  return [
    '---',
    'schema: AceOpsPage/v1',
    `kind: ${kind}`,
    `title: ${title}`,
    `trust: ${trust}`,
    trust === 'canon' ? 'sources: [eval-fixture]' : null,
    `tags: [${tags.join(', ')}]`,
    updatedAt ? `updatedAt: ${updatedAt}` : null,
    expiresAt ? `expiresAt: ${expiresAt}` : null,
    '---',
    '',
    `# ${title}`,
    body,
  ].filter((line) => line !== null).join('\n');
}

/**
 * Write the fixture corpus. Distinctive vocabulary per gold doc plus shared
 * distractor terms so BM25 alone cannot trivially win — trust/freshness/decay
 * weighting has to do real work.
 */
function buildFixtureCorpus(rootDir: string, now: number) {
  const vault = path.join(rootDir, 'ops-vault');
  const projectA = path.join(rootDir, 'project-a-wiki');
  const projectB = path.join(rootDir, 'project-b-wiki');
  const write = (dir: string, rel: string, content: string) => {
    const target = path.join(dir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    return target;
  };
  const fresh = isoDaysAgo(now, 1);
  const stale = isoDaysAgo(now, 45);

  const paths: Record<string, string> = {};

  // lookup golds
  paths.lookupRelease = write(vault, 'lessons/release-gate.md', page({
    title: 'Release gate verification', updatedAt: fresh, tags: ['ace', 'lesson'],
    body: 'Always verify the release gate workflow before merging the train to main. Distractor: deployment pipeline.',
  }));
  paths.lookupWorktree = write(vault, 'lessons/worktree-base.md', page({
    title: 'Worktree base policy', updatedAt: fresh, tags: ['ace', 'lesson'],
    body: 'Workflow worktrees must rebase onto origin main before building. Distractor: deployment pipeline.',
  }));
  paths.lookupRotation = write(vault, 'decisions/rotation-policy.md', page({
    kind: 'decision', title: 'Rotation policy decision', updatedAt: fresh, tags: ['ace', 'decision'],
    body: 'Oversized machine logs rotate into monthly archives and are never deleted. Distractor: deployment pipeline.',
  }));
  // lookup distractors (raw tier, same shared vocabulary)
  for (let i = 0; i < 6; i += 1) {
    write(vault, `inbox/distractor-${i}.md`, `# Distractor ${i}\nDeployment pipeline chatter about gates, worktrees and rotation ${i}.`);
  }

  // cross-project golds (same wording in both projects)
  paths.projectAFact = write(projectA, 'projects/widget.md', page({
    kind: 'project', title: 'Widget service notes', updatedAt: fresh, tags: ['project'],
    body: 'The widget service exposes the conveyor endpoint on port nine thousand.',
  }));
  paths.projectBFact = write(projectB, 'projects/widget.md', page({
    kind: 'project', title: 'Widget service notes', updatedAt: fresh, tags: ['project'],
    body: 'The widget service exposes the conveyor endpoint on port four thousand.',
  }));

  // temporal: fresh vs stale, plus an expired fact
  paths.temporalFresh = write(vault, 'concepts/runner-current.md', page({
    kind: 'concept', title: 'Runner capacity current', updatedAt: fresh,
    body: 'The build runner fleet currently has eight macOS runners online.',
  }));
  paths.temporalStale = write(vault, 'concepts/runner-old.md', page({
    kind: 'concept', title: 'Runner capacity archive', updatedAt: stale,
    body: 'The build runner fleet currently has three macOS runners online.',
  }));
  paths.temporalExpired = write(vault, 'todo/expired-cert.md', page({
    kind: 'todo', trust: 'working', title: 'Certificate renewal sprint', updatedAt: stale,
    expiresAt: isoDaysAgo(now, 10),
    body: 'Renew the signing certificate before the sprint deadline next week.',
  }));

  // knowledge-update: superseded duplicate pair (decay applied post-index)
  paths.updateNew = write(vault, 'decisions/index-engine-new.md', page({
    kind: 'decision', title: 'Index engine decision', updatedAt: fresh,
    body: 'We standardize the knowledge index on SQLite FTS five with trust weighting.',
  }));
  paths.updateOld = write(vault, 'decisions/index-engine-old.md', page({
    kind: 'decision', title: 'Index engine decision', updatedAt: stale,
    body: 'We standardize the knowledge index on ripgrep scanning with trust weighting.',
  }));

  // abstention: the only "answer" lives in contaminated raw content
  paths.abstentionPoisoned = write(vault, 'inbox/poisoned-secret-rotation.md',
    '# Vault rotation rumor\nThe production vault master passphrase rotates every nine days, allegedly.');

  return { vault, projectA, projectB, paths };
}

function inTopK(results: any[], goldPath: string, k = TOP_K) {
  return results.slice(0, k).some((hit: any) => hit.path === goldPath);
}

/**
 * Run the eval against a search function `(params) => AceMemorySearchResult`.
 * Returns AceMemoryEvalReport/v1 with per-category checks.
 */
function evaluateSearch({ search, paths, now }: any) {
  const categories: any[] = [];
  const category = (name: string) => {
    const record = { name, checks: [] as any[], passed: 0, total: 0 };
    categories.push(record);
    return (label: string, ok: boolean, detail = '') => {
      record.checks.push({ label, ok, detail });
      record.total += 1;
      if (ok) record.passed += 1;
    };
  };

  const lookup = category('lookup');
  {
    const releaseHits = search({ query: 'verify release gate before merging', now }).results || [];
    lookup('release gate gold in top-5', inTopK(releaseHits, paths.lookupRelease));
    const worktreeHits = search({ query: 'worktrees rebase origin main', now }).results || [];
    lookup('worktree gold in top-5', inTopK(worktreeHits, paths.lookupWorktree));
    const rotationHits = search({ query: 'logs rotate monthly archives', now }).results || [];
    lookup('rotation gold in top-5', inTopK(rotationHits, paths.lookupRotation));
    lookup('canon outranks raw distractors', (releaseHits[0]?.trust === 'canon'),
      `top hit trust=${releaseHits[0]?.trust || 'none'}`);
  }

  const crossProject = category('cross-project');
  {
    const projectAHits = search({ query: 'widget conveyor endpoint port', project: 'prj_a', now }).results || [];
    crossProject('project filter isolates prj_a', inTopK(projectAHits, paths.projectAFact) && projectAHits.every((hit: any) => hit.project === 'prj_a'));
    const projectBHits = search({ query: 'widget conveyor endpoint port', project: 'prj_b', now }).results || [];
    crossProject('project filter isolates prj_b', inTopK(projectBHits, paths.projectBFact) && projectBHits.every((hit: any) => hit.project === 'prj_b'));
  }

  const temporal = category('temporal');
  {
    const runnerHits = search({ query: 'runner fleet macos online', now }).results || [];
    const freshIndex = runnerHits.findIndex((hit: any) => hit.path === paths.temporalFresh);
    const staleIndex = runnerHits.findIndex((hit: any) => hit.path === paths.temporalStale);
    temporal('fresh fact outranks stale fact', freshIndex !== -1 && (staleIndex === -1 || freshIndex < staleIndex),
      `fresh@${freshIndex} stale@${staleIndex}`);
    const certHits = search({ query: 'renew signing certificate sprint', now }).results || [];
    temporal('expired fact excluded by default', !inTopK(certHits, paths.temporalExpired, 20));
    const certForensics = search({ query: 'renew signing certificate sprint', includeDecayed: true, now }).results || [];
    temporal('expired fact still reachable for forensics', inTopK(certForensics, paths.temporalExpired, 20));
  }

  const knowledgeUpdate = category('knowledge-update');
  {
    const engineHits = search({ query: 'standardize knowledge index trust weighting', now }).results || [];
    const newIndex = engineHits.findIndex((hit: any) => hit.path === paths.updateNew);
    const oldIndex = engineHits.findIndex((hit: any) => hit.path === paths.updateOld);
    knowledgeUpdate('newer decision outranks superseded copy', newIndex !== -1 && (oldIndex === -1 || newIndex < oldIndex),
      `new@${newIndex} old@${oldIndex}`);
    const oldHit = engineHits.find((hit: any) => hit.path === paths.updateOld);
    knowledgeUpdate('superseded copy carries decay reasons when visible',
      !oldHit || (oldHit.decay < 1 && oldHit.decayReasons.length > 0));
  }

  const abstention = category('abstention');
  {
    const poisonedHits = search({ query: 'vault master passphrase rotates', now }).results || [];
    abstention('poisoned-only answer never surfaces by default', poisonedHits.every((hit: any) => hit.path !== paths.abstentionPoisoned));
    abstention('no authoritative tier fabricated for it', poisonedHits.every((hit: any) => hit.trust !== 'canon'));
    const nothingHits = search({ query: 'zanzibar quantum espresso protocol', now }).results || [];
    abstention('unknown topic returns nothing', nothingHits.length === 0, `got ${nothingHits.length}`);
  }

  const overall = categories.every((entry) => entry.passed === entry.total);
  return {
    schema: 'AceMemoryEvalReport/v1',
    generatedAt: new Date(now).toISOString(),
    ok: overall,
    categories: categories.map((entry) => ({
      name: entry.name,
      passed: entry.passed,
      total: entry.total,
      ok: entry.passed === entry.total,
      failures: entry.checks.filter((check: any) => !check.ok),
    })),
  };
}

/**
 * Full deterministic eval: build fixture corpus in a temp dir, index it,
 * apply the decay scenario (superseded + contaminated), evaluate, clean up
 * the temp dir (fixture artifacts only — never user data).
 */
function runKnowledgeEval({ Database, now = Date.now(), searchOverride }: any) {
  if (typeof Database !== 'function') return { ok: false, error: 'Database constructor required' };
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-eval-'));
  let index: any = null;
  try {
    const { vault, projectA, projectB, paths } = buildFixtureCorpus(rootDir, now);
    index = createKnowledgeIndex({ Database, dbPath: ':memory:' });
    index.reindex({
      sources: [
        { source: 'ops-wiki', root: vault, project: null },
        { source: 'project-wiki', root: projectA, project: 'prj_a', defaultTrust: 'canon' },
        { source: 'project-wiki', root: projectB, project: 'prj_b', defaultTrust: 'canon' },
      ],
    });
    // Decay scenario: nightly-audit outcomes, applied directly.
    index.setDecay(paths.updateOld, 0.5, ['superseded-duplicate']);
    index.setDecay(paths.abstentionPoisoned, 0.1, ['contamination:raw-claim']);

    const search = searchOverride
      ? (params: any) => searchOverride(index, params)
      : (params: any) => index.search(params);
    const report = evaluateSearch({ search, paths, now });
    return report;
  } catch (err: any) {
    return { ok: false, error: String(err?.message || err), schema: 'AceMemoryEvalReport/v1' };
  } finally {
    try { index?.close(); } catch { /* closed */ }
    try { fs.rmSync(rootDir, { recursive: true, force: true }); } catch { /* tmp cleanup */ }
  }
}

/** Render the eval report as a wiki page (logs/eval/). */
function renderEvalReport(report: any) {
  const lines = [
    '---',
    `schema: ${KNOWLEDGE_SCHEMAS.auditReport}`,
    'kind: reference',
    `title: Memory eval ${String(report.generatedAt || '').slice(0, 10)}`,
    'trust: working',
    `updatedAt: ${report.generatedAt}`,
    'tags: [ace, wiki]',
    'sources: [knowledge-eval]',
    '---',
    '',
    `# Memory eval — ${report.ok ? 'PASS' : 'FAIL'}`,
    '',
    ...(report.categories || []).map((category: any) =>
      `- ${category.ok ? '✅' : '❌'} ${category.name}: ${category.passed}/${category.total}${category.failures.length ? ` — ${category.failures.map((f: any) => f.label).join('; ')}` : ''}`),
    '',
  ];
  return lines.join('\n') + '\n';
}

module.exports = { runKnowledgeEval, evaluateSearch, buildFixtureCorpus, renderEvalReport };
