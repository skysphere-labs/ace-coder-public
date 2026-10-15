// wiki-bootstrap.cts — the project-enumeration fix for dump-only-no-canon.
//
// Root cause (see docs/architecture/ace-llm-wiki-memory-root-cause.md):
// the autonomous nightly loop (local-core.cts knowledgeNightly) curated only
// projects whose `.ace/wiki/` ALREADY existed — it derived its target list
// from `knowledgeSources()`, which registers a `project-wiki` source only when
// the wiki dir is present. A project with `.ace/wiki-dump/` but no
// `.ace/wiki/` was therefore never fed to the curator, so canon never
// bootstrapped.
//
// This module owns the corrected enumeration: curate every project that has
// dumps OR a wiki (so dump-only projects bootstrap on the next nightly), plus
// thin delegators to the curator's bootstrap/backfill. It is intentionally tiny
// and side-effect-light so local-core can call it with one delegating line.
//
// Constraints: Node built-ins only; fail-safe (unreadable dirs are skipped).

'use strict';

const fs = require('fs');
const path = require('path');

// Lazy + dual-extension require so this loads at runtime (.cjs bundle) and in
// isolated tsx tests (.cts source), matching memory-handlers/local-core.
function curator(): any {
  try { return require('../tools/ace/src/project-wiki-curator.cjs'); } catch { /* fall through */ }
  return require('../tools/ace/src/project-wiki-curator.cts');
}

function acePath(projectPath: any, ...rest: string[]): string {
  return path.join(String(projectPath || ''), '.ace', ...rest);
}

function dirHasFile(dir: string, predicate: (name: string) => boolean): boolean {
  let stack = [dir];
  let guard = 0;
  while (stack.length && guard < 10000) {
    guard += 1;
    const current = stack.pop()!;
    let entries: any[] = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && predicate(entry.name)) return true;
    }
  }
  return false;
}

/** A project has dumps when `.ace/wiki-dump/` holds at least one record. */
function projectHasDumps(projectPath: any): boolean {
  const dir = acePath(projectPath, 'wiki-dump');
  return fs.existsSync(dir) && dirHasFile(dir, (name) => name.endsWith('.json'));
}

/** A project has a wiki when `.ace/wiki/` holds at least one markdown page. */
function projectHasWiki(projectPath: any): boolean {
  const dir = acePath(projectPath, 'wiki');
  return fs.existsSync(dir) && dirHasFile(dir, (name) => name.endsWith('.md'));
}

/** Dump-only = has dumps but no wiki markdown at all (the bug shape). */
function projectIsDumpOnly(projectPath: any): boolean {
  return projectHasDumps(projectPath) && !projectHasWiki(projectPath);
}

/**
 * LEGACY (buggy) enumeration: curate only projects that already have a wiki.
 * Retained so the regression test can demonstrate the skip. DO NOT USE — kept
 * for documentation of the defect.
 */
function legacyWikiOnlyTargets(projects: any[]): any[] {
  return (Array.isArray(projects) ? projects : [])
    .filter((p: any) => p && typeof p.path === 'string' && projectHasWiki(p.path));
}

/**
 * FIXED enumeration: curate every project that has dumps OR a wiki. Dump-only
 * projects are included (and flagged) so the curator bootstraps their canon.
 */
function enumerateCurationTargets(projects: any[]): any[] {
  return (Array.isArray(projects) ? projects : [])
    .filter((p: any) => p && typeof p.path === 'string' && (projectHasDumps(p.path) || projectHasWiki(p.path)))
    .map((p: any) => ({ id: p.id ?? null, path: p.path, dumpOnly: projectIsDumpOnly(p.path) }));
}

/** Bootstrap the OKF skeleton + promote dumps into canon for one project. */
function bootstrapAndCurate(input: any = {}): any {
  return curator().backfillProject({
    projectDir: input.projectDir || input.path,
    projectId: input.projectId,
    projectName: input.projectName,
    identity: input.identity || 'all',
    describeCommands: input.describeCommands,
    now: input.now,
  });
}

/**
 * Curate a whole project list with the FIXED enumeration. Each dump-or-wiki
 * project is bootstrapped + curated; results are collected fail-safe (one bad
 * project never aborts the loop). This is what local-core's nightly should call
 * instead of filtering to existing `project-wiki` sources.
 */
function curateAllProjects(input: any = {}): any {
  const targets = enumerateCurationTargets(input.projects || []);
  const results: any[] = [];
  for (const target of targets) {
    try {
      const result = bootstrapAndCurate({
        projectDir: target.path,
        projectId: target.id,
        describeCommands: input.describeCommands,
        now: input.now,
      });
      results.push({ project: target.id, path: target.path, dumpOnlyBefore: target.dumpOnly, ok: true, result });
    } catch (err: any) {
      results.push({ project: target.id, path: target.path, ok: false, error: String(err?.message || err) });
    }
  }
  return { schema: 'AceWikiCurateAll/v1', targets: targets.length, results };
}

module.exports = {
  projectHasDumps,
  projectHasWiki,
  projectIsDumpOnly,
  legacyWikiOnlyTargets,
  enumerateCurationTargets,
  bootstrapAndCurate,
  curateAllProjects,
};
