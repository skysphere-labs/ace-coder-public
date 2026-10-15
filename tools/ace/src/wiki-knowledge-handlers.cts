// wiki-knowledge-handlers.cts — CLI handlers for the LLM-wiki writeback +
// canon-first retrieval surface. All handlers are LOCAL-FIRST: they read the
// Markdown canon under `.ace/wiki/` directly (the source of truth) and the
// ndjson event/inbox stores, with no dependency on the running app or its
// disposable FTS index. That keeps them faithful to OKF doctrine (Markdown is
// truth, indexes are helpers) and fully testable offline.
//
// Commands: wiki backfill | wiki writeback | wiki curate-events | wiki inbox |
// wiki promote ; memory explain | memory status | wiki health.

const fs = require('node:fs');
const path = require('node:path');

const {
  parseFrontmatter,
  computeFreshness,
  TRUST_TIERS,
  explainFromResults,
  summarizeWikiHealth,
} = require('../../../electron/harness/knowledge-contract.cts');

// Static requires (esbuild-friendly); .cjs at runtime, .cts fallback for tsx tests.
function requireWikiKnowledge(): any {
  try { return require('./wiki-knowledge.cjs'); } catch { /* fall through */ }
  return require('./wiki-knowledge.cts');
}
function requireCurator(): any {
  try { return require('./project-wiki-curator.cjs'); } catch { /* fall through */ }
  return require('./project-wiki-curator.cts');
}
function requireWikiGenerate(): any {
  try { return require('./wiki-generate.cjs'); } catch { /* fall through */ }
  return require('./wiki-generate.cts');
}
const wikiKnowledge = requireWikiKnowledge();
const projectWikiCurator = requireCurator();
const wikiGenerate = requireWikiGenerate();

const EXCERPT_LEN = 240;
const STALE_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

function clean(value: any): string {
  return String(value == null ? '' : value).trim();
}
function ace(projectDir: any, ...rest: string[]): string {
  return path.join(path.resolve(String(projectDir || process.cwd())), '.ace', ...rest);
}
function listMarkdown(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: any[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.md')) out.push(full);
    }
  };
  walk(root);
  return out;
}
function listJson(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: any[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.json')) out.push(full);
    }
  };
  walk(root);
  return out;
}
function firstHeading(body: string): string {
  const m = String(body || '').match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : '';
}
function excerptAround(body: string, tokens: string[]): string {
  const text = String(body || '').replace(/\s+/g, ' ').trim();
  const lower = text.toLowerCase();
  let idx = -1;
  for (const token of tokens) { const at = lower.indexOf(token); if (at >= 0) { idx = at; break; } }
  if (idx < 0) return text.slice(0, EXCERPT_LEN);
  const start = Math.max(0, idx - 60);
  return (start > 0 ? '…' : '') + text.slice(start, start + EXCERPT_LEN).trim();
}
function queryTokens(query: any): string[] {
  return clean(query).toLowerCase().split(/\s+/).map((t) => t.replace(/[^a-z0-9]/g, '')).filter((t) => t.length >= 2);
}

// ---------------------------------------------------------------------------
// Local canon-first document gathering + ranking (no FTS index needed)
// ---------------------------------------------------------------------------

function gatherCanonDocs(projectDir: any): any[] {
  const root = ace(projectDir, 'wiki');
  const docs: any[] = [];
  for (const filePath of listMarkdown(root)) {
    const rel = path.relative(root, filePath).split(path.sep).join('/');
    if (/^(templates|deprecated)\//.test(rel)) continue;
    let content = '';
    try { content = fs.readFileSync(filePath, 'utf8'); } catch { continue; }
    const { data, body } = parseFrontmatter(content);
    const trust = TRUST_TIERS.includes(clean(data.trust)) ? clean(data.trust) : 'canon';
    const sources = Array.isArray(data.sources) ? data.sources.map(clean).filter(Boolean) : [];
    let mtimeMs = 0;
    try { mtimeMs = fs.statSync(filePath).mtimeMs; } catch { /* ignore */ }
    docs.push({
      path: filePath, relPath: rel, source: 'project-wiki', trust,
      project: clean(data.projectId) || null, title: clean(data.title) || firstHeading(body) || rel,
      sensitivity: clean(data.sensitivity) || null, sources, body, updatedAt: clean(data.updatedAt) || null, mtimeMs,
    });
  }
  return docs;
}

function gatherDumpDocs(projectDir: any): any[] {
  const root = ace(projectDir, 'wiki-dump');
  const docs: any[] = [];
  for (const filePath of listJson(root)) {
    let record: any;
    try { record = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { continue; }
    if (!record || typeof record !== 'object') continue;
    const parts = [record.title, record.summary,
      ...(Array.isArray(record.decisions) ? record.decisions : []),
      ...(Array.isArray(record.completedItems) ? record.completedItems : []),
      ...(Array.isArray(record.proposedNextActions) ? record.proposedNextActions : []),
      ...(Array.isArray(record.blockers) ? record.blockers : [])].filter((p) => typeof p === 'string' && p.trim());
    docs.push({
      path: filePath, relPath: path.relative(root, filePath).split(path.sep).join('/'), source: 'project-dump',
      trust: 'raw', project: clean(record.projectId) || null, title: clean(record.title || record.kind || 'dump'),
      sensitivity: null, sources: [clean(record.id)].filter(Boolean), body: parts.join('\n'),
    });
  }
  return docs;
}

function rankDocs(docs: any[], query: any): any[] {
  const tokens = queryTokens(query);
  if (tokens.length === 0) return [];
  const ranked: any[] = [];
  for (const doc of docs) {
    const title = String(doc.title || '').toLowerCase();
    const body = String(doc.body || '').toLowerCase();
    let score = 0;
    for (const token of tokens) {
      if (title.includes(token)) score += 3;
      const bodyHits = body.split(token).length - 1;
      score += Math.min(bodyHits, 5);
    }
    if (score <= 0) continue;
    ranked.push({ ...doc, score, excerpt: excerptAround(doc.body, tokens) });
  }
  ranked.sort((a, b) => b.score - a.score);
  return ranked;
}

// ---------------------------------------------------------------------------
// Health gathering (filesystem-only, faithful proxy for the disposable index)
// ---------------------------------------------------------------------------

function readReportCount(projectDir: any, label: string): number {
  const reportPath = ace(projectDir, 'wiki', '00_index', 'nightly-curation-report.md');
  try {
    const text = fs.readFileSync(reportPath, 'utf8');
    const m = text.match(new RegExp(`- ${label}:\\s*(\\d+)`));
    return m ? Number(m[1]) : 0;
  } catch { return 0; }
}

function gatherProjectHealth(projectDir: any, projectId?: any): any {
  const root = ace(projectDir, 'wiki');
  const now = Date.now();
  let canonPages = 0;
  let pagesWithSources = 0;
  let stalePages = 0;
  let lastNightlyAt: string | null = null;
  for (const doc of gatherCanonDocs(projectDir)) {
    canonPages += 1;
    if (doc.sources && doc.sources.length > 0) pagesWithSources += 1;
    const stamp = doc.updatedAt && !Number.isNaN(Date.parse(doc.updatedAt)) ? Date.parse(doc.updatedAt) : doc.mtimeMs;
    if (computeFreshness(stamp, now) === 'expired' || (stamp && now - stamp > STALE_DAYS_MS)) stalePages += 1;
    if (doc.relPath === '00_index/nightly-curation-report.md' && doc.updatedAt) lastNightlyAt = doc.updatedAt;
  }
  const dumpRecords = listJson(ace(projectDir, 'wiki-dump')).length;
  const inboxPending = wikiKnowledge.readInbox({ projectDir }).length;
  return {
    id: projectId || path.basename(path.resolve(String(projectDir))),
    path: String(projectDir),
    dumpOnly: projectWikiCurator.isDumpOnly(projectDir),
    hasCanon: canonPages > 0,
    canonPages,
    pagesWithSources,
    stalePages,
    dumpRecords,
    lastNightlyAt,
    inboxPending,
    accepted: readReportCount(projectDir, 'candidates accepted'),
    rejected: readReportCount(projectDir, 'candidates rejected'),
  };
}

function discoverProjects(rootDir: string): string[] {
  const out: string[] = [];
  let entries: any[] = [];
  try { entries = fs.readdirSync(rootDir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const projectDir = path.join(rootDir, entry.name);
    if (fs.existsSync(path.join(projectDir, '.ace'))) out.push(projectDir);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function createWikiKnowledgeHandlers(deps: any) {
  const { die, normalizeText, resolveProjectDirFlag, describeCommands } = deps;
  const text = (v: any) => (typeof normalizeText === 'function' ? normalizeText(v) : clean(v));

  async function handleWikiBackfill(parsed: any) {
    const flags = parsed.flags || {};
    const projectDir = resolveProjectDirFlag(flags);
    const commands = typeof describeCommands === 'function' ? describeCommands() : [];
    return projectWikiCurator.backfillProject({
      projectDir,
      projectId: text(flags.projectId || flags.project || flags.workspace),
      projectName: text(flags.projectName),
      identity: text(flags.identity) || 'all',
      describeCommands: commands,
    });
  }

  async function handleWikiWriteback(parsed: any) {
    const flags = parsed.flags || {};
    const projectDir = resolveProjectDirFlag(flags);
    let body = flags.text != null ? String(flags.text) : '';
    if (!body && flags.file) {
      try { body = fs.readFileSync(path.resolve(String(flags.file)), 'utf8'); } catch (err: any) {
        die({ code: 6, error: 'not_found', message: `--file not readable: ${String(err?.message || err)}` });
      }
    }
    if (!clean(body)) die({ code: 2, error: 'missing_arg', message: 'provide --text "<DONE/BLOCKED output>" or --file <path>' });
    const result = wikiKnowledge.ingestWikiUpdate({
      projectDir,
      text: body,
      defaults: {
        projectId: text(flags.projectId || flags.project || flags.workspace),
        projectName: text(flags.projectName),
        missionId: text(flags.mission),
        featureId: text(flags.feature),
      },
    });
    if (!result) return { schema: 'AceWikiWriteback/v1', project: null, events: [], note: 'no WIKI_UPDATE packet found in input' };
    return result;
  }

  async function handleWikiGenerate(parsed: any) {
    const flags = parsed.flags || {};
    const projectDir = resolveProjectDirFlag(flags);
    return wikiGenerate.generate({
      projectDir,
      incremental: flags.incremental === true,
      dryRun: flags.dryRun === true,
      projectId: text(flags.projectId || flags.project || flags.workspace),
      projectName: text(flags.projectName),
    });
  }

  async function handleWikiCurateEvents(parsed: any) {
    const flags = parsed.flags || {};
    const projectDir = resolveProjectDirFlag(flags);
    const threshold = flags.threshold != null ? Number(flags.threshold) : undefined;
    return wikiKnowledge.curateFromEvents({ projectDir, threshold });
  }

  async function handleWikiInbox(parsed: any) {
    const flags = parsed.flags || {};
    const projectDir = resolveProjectDirFlag(flags);
    const entries = wikiKnowledge.readInbox({ projectDir, includeResolved: flags.all === true });
    return { schema: 'AceWikiInboxList/v1', pending: entries.filter((e: any) => e.status === 'pending').length, entries };
  }

  async function handleWikiPromote(parsed: any) {
    const flags = parsed.flags || {};
    const projectDir = resolveProjectDirFlag(flags);
    const inboxId = text(parsed.positionals?.[0] || flags.id);
    if (!inboxId) die({ code: 2, error: 'missing_arg', message: 'inbox id required: ace wiki promote <inboxId>' });
    if (flags.reject === true) {
      const result = wikiKnowledge.resolveInbox({ projectDir, inboxId, status: 'rejected' });
      if (!result.ok) die({ code: 6, error: 'not_found', message: result.error });
      return { schema: 'AceWikiPromote/v1', rejected: true, entry: result.entry };
    }
    const result = wikiKnowledge.promoteInboxEntry({ projectDir, inboxId });
    if (!result.ok) die({ code: 6, error: 'not_found', message: result.error });
    return { schema: 'AceWikiPromote/v1', promoted: true, written: result.written, entry: result.entry };
  }

  function buildHealth(flags: any) {
    const projectsRoot = text(flags.projectsRoot);
    const projectDirs = projectsRoot ? discoverProjects(path.resolve(projectsRoot)) : [resolveProjectDirFlag(flags)];
    const projects = projectDirs.map((dir) => gatherProjectHealth(dir, undefined));
    const nightlyAt = projects.map((p: any) => p.lastNightlyAt).filter(Boolean).sort().reverse()[0] || null;
    return summarizeWikiHealth({
      projects,
      nightly: nightlyAt ? { at: nightlyAt, status: 'ok' } : null,
      inbox: { pending: projects.reduce((s: number, p: any) => s + (p.inboxPending || 0), 0) },
      curation: {
        accepted: projects.reduce((s: number, p: any) => s + (p.accepted || 0), 0),
        rejected: projects.reduce((s: number, p: any) => s + (p.rejected || 0), 0),
      },
    });
  }

  async function handleWikiHealth(parsed: any) {
    return buildHealth(parsed.flags || {});
  }

  async function handleMemoryStatus(parsed: any) {
    const flags = parsed.flags || {};
    const health = buildHealth(flags);
    return {
      ...health,
      schema: 'AceMemoryStatus/v1',
      note: 'Canon-first: Markdown under .ace/wiki/ is the source of truth; the FTS index is a disposable, rebuildable helper owned by the running app (ace memory reindex).',
    };
  }

  async function handleMemoryExplain(parsed: any) {
    const flags = parsed.flags || {};
    const projectDir = resolveProjectDirFlag(flags);
    const query = text(parsed.positionals?.[0]);
    if (!query) die({ code: 2, error: 'missing_arg', message: 'query required: ace memory explain "<question>"' });
    const docs = [...gatherCanonDocs(projectDir), ...gatherDumpDocs(projectDir)];
    const ranked = rankDocs(docs, query);
    const citationsByPath: Record<string, any> = {};
    for (const doc of ranked) citationsByPath[doc.path] = doc.sources && doc.sources.length ? doc.sources : [doc.relPath];
    return explainFromResults({ query, results: ranked, citationsByPath });
  }

  return {
    handleWikiBackfill,
    handleWikiGenerate,
    handleWikiWriteback,
    handleWikiCurateEvents,
    handleWikiInbox,
    handleWikiPromote,
    handleWikiHealth,
    handleMemoryStatus,
    handleMemoryExplain,
  };
}

module.exports = { createWikiKnowledgeHandlers, _internal: { gatherCanonDocs, gatherDumpDocs, rankDocs, gatherProjectHealth, discoverProjects } };
