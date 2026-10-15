// wiki-health.cts — electron-side wiki/knowledge health.
//
// The pure summarizer lives in the knowledge contract (electron/harness/
// knowledge-contract.cts) so it ships with the standalone ace CLI too. This
// module adds the electron-side GATHERING (filesystem scan per project + index
// counts + last-nightly state) and assembles the AceWikiHealth/v1 object the
// Wiki tab health panel renders via the `ace:ops-wiki-health` IPC. It is the
// same metric shape `ace wiki health` prints, so the UI and CLI never
// split-brain.

'use strict';

const fs = require('fs');
const path = require('path');

const { parseFrontmatter, computeFreshness, summarizeWikiHealth } = require('./harness/knowledge-contract.cts');

// Cross-package requires (.cjs at runtime, .cts fallback for tsx tests) —
// the same layout local-core uses for project-wiki-curator.
function curator(): any {
  try { return require('../tools/ace/src/project-wiki-curator.cjs'); } catch { /* fall through */ }
  return require('../tools/ace/src/project-wiki-curator.cts');
}
function wikiKnowledge(): any {
  try { return require('../tools/ace/src/wiki-knowledge.cjs'); } catch { /* fall through */ }
  return require('../tools/ace/src/wiki-knowledge.cts');
}

const STALE_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

function clean(value: any): string {
  return String(value == null ? '' : value).trim();
}
function ace(projectDir: any, ...rest: string[]): string {
  return path.join(path.resolve(String(projectDir || '')), '.ace', ...rest);
}
function listFiles(root: string, ext: string): string[] {
  const out: string[] = [];
  let stack = [root];
  let guard = 0;
  while (stack.length && guard < 20000) {
    guard += 1;
    const dir = stack.pop()!;
    let entries: any[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name.endsWith(ext)) out.push(full);
    }
  }
  return out;
}
function reportCount(projectDir: any, label: string): number {
  try {
    const text = fs.readFileSync(ace(projectDir, 'wiki', '00_index', 'nightly-curation-report.md'), 'utf8');
    const m = text.match(new RegExp(`- ${label}:\\s*(\\d+)`));
    return m ? Number(m[1]) : 0;
  } catch { return 0; }
}

/** Filesystem health for one project (no index/IPC needed). */
function gatherProjectHealth(projectDir: any, projectId?: any): any {
  const root = ace(projectDir, 'wiki');
  const now = Date.now();
  let canonPages = 0;
  let pagesWithSources = 0;
  let stalePages = 0;
  let lastNightlyAt: string | null = null;
  for (const filePath of listFiles(root, '.md')) {
    const rel = path.relative(root, filePath).split(path.sep).join('/');
    if (/^(templates|deprecated)\//.test(rel)) continue;
    let content = '';
    try { content = fs.readFileSync(filePath, 'utf8'); } catch { continue; }
    const { present, data } = parseFrontmatter(content);
    if (!present) continue;
    canonPages += 1;
    const sources = Array.isArray(data.sources) ? data.sources.filter((s: any) => clean(s)) : [];
    if (sources.length > 0) pagesWithSources += 1;
    let mtimeMs = 0;
    try { mtimeMs = fs.statSync(filePath).mtimeMs; } catch { /* ignore */ }
    const stamp = data.updatedAt && !Number.isNaN(Date.parse(String(data.updatedAt))) ? Date.parse(String(data.updatedAt)) : mtimeMs;
    if (computeFreshness(stamp, now) === 'expired' || (stamp && now - stamp > STALE_DAYS_MS)) stalePages += 1;
    if (rel === '00_index/nightly-curation-report.md' && data.updatedAt) lastNightlyAt = String(data.updatedAt);
  }
  let inboxPending = 0;
  try { inboxPending = wikiKnowledge().readInbox({ projectDir }).length; } catch { /* optional */ }
  return {
    id: projectId || path.basename(path.resolve(String(projectDir))),
    path: String(projectDir),
    dumpOnly: (() => { try { return curator().isDumpOnly(projectDir); } catch { return false; } })(),
    hasCanon: canonPages > 0,
    canonPages,
    pagesWithSources,
    stalePages,
    dumpRecords: listFiles(ace(projectDir, 'wiki-dump'), '.json').length,
    lastNightlyAt,
    inboxPending,
    accepted: reportCount(projectDir, 'candidates accepted'),
    rejected: reportCount(projectDir, 'candidates rejected'),
  };
}

/**
 * Assemble AceWikiHealth/v1 across a project list. `index` is the optional
 * knowledge-index describe() ({ byTrust:[{trust,n}], total }); `nightly` is the
 * last knowledge-nightly run state ({ at, status }). Both degrade gracefully.
 */
function buildWikiHealth(input: any = {}): any {
  const projectDirs = Array.isArray(input.projectDirs) ? input.projectDirs : [];
  const projects = projectDirs.map((p: any) =>
    typeof p === 'string' ? gatherProjectHealth(p) : gatherProjectHealth(p.path, p.id));

  const byTrust = Array.isArray(input.index?.byTrust) ? input.index.byTrust : [];
  const trustCount = (t: string) => { const r = byTrust.find((x: any) => x && x.trust === t); return r ? Number(r.n) || 0 : 0; };

  return summarizeWikiHealth({
    now: input.now,
    projects,
    index: input.index ? { total: input.index.total ?? null, canonDocs: trustCount('canon'), rawDocs: trustCount('raw') } : undefined,
    nightly: input.nightly || null,
    inbox: { pending: projects.reduce((s: number, p: any) => s + (p.inboxPending || 0), 0) },
    curation: {
      accepted: projects.reduce((s: number, p: any) => s + (p.accepted || 0), 0),
      rejected: projects.reduce((s: number, p: any) => s + (p.rejected || 0), 0),
    },
  });
}

module.exports = { summarizeWikiHealth, gatherProjectHealth, buildWikiHealth };
