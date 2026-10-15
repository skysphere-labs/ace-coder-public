// knowledge-migrate.cts — one-shot, propose-by-default vault migration.
//
// Stamps inferred AceOpsPage/v1 frontmatter onto legacy ops-wiki pages
// (kind/trust from directory, title from the heading, updatedAt from the
// legacy `Updated:` line or mtime, tags from inline `Tags:`), backfills
// promoteToWiki memory candidates as untrusted dump records, optionally runs
// the initial rotation, and appends the taxonomy section to SCHEMA.md.
//
// Dry-run by default: prints every proposal; nothing changes without --apply.
// Existing frontmatter pages and machine logs are never touched. Legacy pages
// remain valid forever — migration is optional convenience, not a requirement.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  OPS_PAGE_SCHEMA,
  TAG_VOCABULARY,
  FREE_TAG_PREFIX,
  inferVaultKind,
  inferVaultTrust,
  isAllowedTag,
  parseFrontmatter,
} = require('../../../electron/harness/knowledge-contract.cts');
const { extractTitle, extractTags } = require('../../../electron/wiki-graph-indexer.cts');
const { rotateKnowledgeArtifacts } = require('../../../electron/knowledge-audit.cts');
const projectWikiCurator = require('./project-wiki-curator.cjs');

const SKIP_DIRS = new Set(['node_modules', '.git', '.obsidian', '.trash', 'quarantine', 'logs']);
const SKIP_FILES = new Set(['log.md', 'SCHEMA.md']);
const TAXONOMY_MARKER = '## Knowledge-plane taxonomy';

function defaultWikiRoot() {
  const override = process.env.ACE_WIKI_ROOT;
  if (override && override.trim()) return path.resolve(override.trim());
  return path.join(process.env.ACE_HOME || path.join(os.homedir(), '.ace-coder'), 'wiki', 'ace-ops');
}

function collectMarkdown(dir: string, out: string[] = []): string[] {
  let entries: any[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectMarkdown(full, out);
    else if (entry.isFile() && entry.name.endsWith('.md') && !SKIP_FILES.has(entry.name)) out.push(full);
  }
  return out;
}

function legacyUpdatedAt(content: string, filePath: string): string {
  const match = content.slice(0, 2000).match(/^Updated:\s*(.+)$/im);
  if (match) {
    const parsed = Date.parse(match[1].trim());
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  }
  try {
    return new Date(fs.statSync(filePath).mtimeMs).toISOString();
  } catch {
    return new Date().toISOString();
  }
}

function migrationTags(content: string): string[] {
  const tags = extractTags(content)
    .map((tag: string) => (isAllowedTag(tag) ? tag : isAllowedTag(`${FREE_TAG_PREFIX}${tag}`) ? `${FREE_TAG_PREFIX}${tag}` : null))
    .filter(Boolean) as string[];
  return tags.length ? Array.from(new Set(tags)) : ['wiki'];
}

function buildStampProposal(root: string, filePath: string) {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  const { data } = parseFrontmatter(content);
  if (data && data.schema) return null; // already schema'd (any family)
  const relPath = path.relative(root, filePath).split(path.sep).join('/');
  return {
    path: filePath,
    relPath,
    kind: inferVaultKind(relPath),
    trust: inferVaultTrust(relPath),
    title: extractTitle(content, filePath),
    updatedAt: legacyUpdatedAt(content, filePath),
    tags: migrationTags(content),
  };
}

function stampPage(proposal: any) {
  const content = fs.readFileSync(proposal.path, 'utf8');
  const frontmatter = [
    '---',
    `schema: ${OPS_PAGE_SCHEMA}`,
    `kind: ${proposal.kind}`,
    `title: ${proposal.title}`,
    'status: active',
    `trust: ${proposal.trust}`,
    `updatedAt: ${proposal.updatedAt}`,
    `tags: [${proposal.tags.join(', ')}]`,
    'sources: [migration-backfill]',
    '---',
    '',
  ].join('\n');
  const tmp = `${proposal.path}.tmp-migrate`;
  fs.writeFileSync(tmp, `${frontmatter}${content}`);
  fs.renameSync(tmp, proposal.path);
}

function taxonomySection(): string {
  return [
    '',
    TAXONOMY_MARKER,
    '',
    '- Frontmatter schema: `AceOpsPage/v1` (kind, trust, sources, tags, updatedAt, expiresAt). Legacy inline `Tags:`/`Updated:` pages stay valid forever.',
    '- Trust tiers: `canon` (curator/owner-written, requires sources) > `working` (machine-written journals/digests/todos) > `external` (read-only Hermes memories) > `raw` (inbox/dumps/quarantine).',
    '- Directories: `portfolios/` cross-project pages · `journal/YYYY/` daily activity · `runs/YYYY-MM/` run digests · `decisions/` + `lessons/` promoted knowledge · `inbox/` untrusted intake · `quarantine/` flagged intake (moved, never deleted) · `logs/` archives + audit/eval reports.',
    `- Tags: controlled vocabulary (${TAG_VOCABULARY.join(', ')}); free tags only as \`${FREE_TAG_PREFIX}<name>\` (Obsidian nested tags).`,
    '- Decay: contaminated/expired/superseded/stale content is down-ranked in search (never deleted); the 03:30 nightly audit recomputes it and writes reports to `logs/audit/`.',
    '- Search: `ace memory search "<topic>"` — BM25 × trust × freshness × decay.',
    '',
  ].join('\n');
}

function createKnowledgeMigrateHandlers(deps: any) {
  const { die, normalizeText, resolveProjectDirFlag } = deps;

  async function handleKnowledgeMigrate(parsed: any) {
    const flags = parsed.flags || {};
    const apply = flags.apply === true;
    const root = flags.wikiRoot ? path.resolve(String(flags.wikiRoot)) : defaultWikiRoot();
    if (!fs.existsSync(root)) {
      die({ code: 6, error: 'not_found', message: `wiki root not found: ${root} (set --wiki-root or ACE_WIKI_ROOT)` });
    }

    // 1. Frontmatter stamping proposals
    const proposals = collectMarkdown(root)
      .map((filePath) => buildStampProposal(root, filePath))
      .filter(Boolean);
    let stamped = 0;
    if (apply) {
      for (const proposal of proposals) {
        try {
          stampPage(proposal);
          stamped += 1;
        } catch { /* skip unwritable page; it stays legacy (still valid) */ }
      }
    }

    // 2. promoteToWiki memory-candidate backfill → untrusted dump records
    const backfilled: any[] = [];
    const projectDir = flags.projectDir ? resolveProjectDirFlag(flags) : null;
    if (projectDir) {
      const runDir = path.join(projectDir, '.ace', 'run');
      let runIds: string[] = [];
      try { runIds = fs.readdirSync(runDir); } catch { runIds = []; }
      for (const runId of runIds) {
        let result: any;
        try {
          result = JSON.parse(fs.readFileSync(path.join(runDir, runId, 'completion.json'), 'utf8'));
        } catch {
          continue;
        }
        for (const candidate of result?.memoryCandidates || []) {
          if (candidate?.promoteToWiki !== true) continue;
          const claim = normalizeText(candidate.claim);
          if (!claim) continue;
          const record = {
            kind: 'memory_note',
            identity: 'migration',
            projectId: normalizeText(flags.projectId) || result.taskId || runId,
            source: runId,
            trust: 'self_report',
            title: `[${candidate.category || 'lesson'}] ${claim.slice(0, 80)}`,
            summary: claim,
            category: normalizeText(candidate.category) || 'lesson',
            evidence: candidate.evidence ? [String(candidate.evidence)] : [],
          };
          if (apply) {
            try {
              backfilled.push(projectWikiCurator.writeDumpRecord({ projectDir, record }).path);
            } catch { /* skip malformed candidate */ }
          } else {
            backfilled.push(`(proposed) ${runId}: ${claim.slice(0, 80)}`);
          }
        }
      }
    }

    // 3. Initial rotation (machine artifacts only; archive, never delete)
    let rotation: any = { rotated: [], proposals: [] };
    if (apply && flags.skipRotation !== true) {
      try {
        rotation = rotateKnowledgeArtifacts({ wikiRoot: root, stateDir: null, now: Date.now() });
      } catch { /* rotation is best-effort */ }
    }

    // 4. SCHEMA.md taxonomy section
    const schemaPath = path.join(root, 'SCHEMA.md');
    let schemaUpdated = false;
    if (apply) {
      try {
        const current = fs.existsSync(schemaPath) ? fs.readFileSync(schemaPath, 'utf8') : '# Wiki Schema\n';
        if (!current.includes(TAXONOMY_MARKER)) {
          fs.writeFileSync(schemaPath, `${current}${taxonomySection()}`);
          schemaUpdated = true;
        }
      } catch { /* SCHEMA.md update is best-effort */ }
    }

    return {
      schema: 'AceKnowledgeMigrateResult/v1',
      wikiRoot: root,
      applied: apply,
      pagesNeedingFrontmatter: proposals.length,
      stamped,
      proposals: apply ? [] : proposals.map((proposal: any) => ({
        path: proposal.relPath, kind: proposal.kind, trust: proposal.trust, tags: proposal.tags,
      })),
      candidatesBackfilled: backfilled.length,
      backfilled,
      rotation: { rotated: rotation.rotated.length, proposals: rotation.proposals.length },
      schemaUpdated,
    };
  }

  return { handleKnowledgeMigrate };
}

module.exports = { createKnowledgeMigrateHandlers };
