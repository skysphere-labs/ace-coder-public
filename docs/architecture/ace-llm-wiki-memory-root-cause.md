# Root cause — dump-only-no-canon (Phase 0)

- **Mission:** msn-a204c57b · **Feature:** ft-4b07a844
- **Symptom:** a workspace can accumulate `.ace/wiki-dump/` records yet never
  bootstrap `.ace/wiki/`. Raw dumps are searchable but canonical project
  pages never exist. `ace memory search` and the nightly look alive while
  canon is empty. Brampton `prj-e33a215d` is the reproduction shape.

## The exact upstream skip (file:line)

The defect is an **enumeration skip**, not a curator bug. The curator already
mkdirs + writes canon when invoked (`project-wiki-curator.runNightlyProjectWikiCuration`
→ `applyProjectPageUpdates` does `fs.mkdirSync(root, { recursive: true })`). The
gap is **which projects get fed to it**.

1. `electron/local-core.cts` → `knowledgeSources()` (~L6030-6041) registers a
   `project-wiki` source **only when `.ace/wiki/` already exists**:

   ```js
   if (fs.existsSync(wikiRoot)) {
     sources.push({ source: 'project-wiki', root: wikiRoot, project: row.id, defaultTrust: 'canon' });
   }
   ```

2. `electron/local-core.cts` → `knowledgeNightly()` (~L6170 and the curation
   loop ~L6203) derived its per-project curation targets by **filtering those
   sources to `source === 'project-wiki'`**:

   ```js
   const projectVaults = knowledgeSources().filter((s) => s.source === 'project-wiki');
   for (const source of projectVaults) { /* curate */ }
   ```

A dump-only project has no `wiki/`, so step 1 never registers it, so step 2
never curates it → its canon never bootstraps. The bug is self-perpetuating:
canon is only created for projects that already have canon.

## The fix

- `electron/wiki-bootstrap.cts` owns the corrected enumeration:
  `enumerateCurationTargets(projects)` returns every project with **dumps OR a
  wiki** (dump-only projects are included and flagged), and `curateAllProjects`
  bootstraps the OKF skeleton + curates each.
- `electron/local-core.cts` `knowledgeNightly()` now enumerates project rows
  directly (`SELECT id, path FROM projects`) and delegates to
  `wikiBootstrap.curateAllProjects({ projects })`, so the autonomous nightly
  bootstraps dump-only projects. (One small, contained delegation; all logic +
  tests live in the in-scope modules.)
- `ace wiki backfill` is the operator-runnable fix for existing dump-only
  projects (idempotent): bootstrap skeleton + promote dumps into canon.
- `wiki health` / `memory status` flag any dump-only project — the warning that
  would have caught this bug.

## Regression coverage

- `tools/ace/src/__tests__/wiki-backfill.test.cts`
  - `A0.1` a dump-only project has dumps but no canon (the bug).
  - `A0.2` `legacyWikiOnlyTargets` (the old behaviour) SKIPS it; the fixed
    `enumerateCurationTargets` includes it and flags `dumpOnly`.
  - `A1.2` `backfillProject` flips `dumpOnly: true → false` and writes canon
    containing the dump's content; re-run is a no-op (idempotent).
  - `curateAllProjects` bootstraps canon for every dump-or-wiki project.
