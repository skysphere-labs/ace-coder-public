# Ace LLM Wiki / Memory — Acceptance Rubric (as built)

- **Mission:** msn-a204c57b · **Feature:** ft-4b07a844
- **PRD:** `ace-llm-wiki-memory-prd.md` · **Root cause:** `ace-llm-wiki-memory-root-cause.md`
- **Legend:** ✅ shipped + unit test · ⊙ computer-use behavioural check DEFERRED to
  the Codex validator (worker cannot run computer-use) · ▢ documented gate.
- Tests: `node --test` suites under `tools/ace/src/__tests__/wiki-*.test.cts`
  (run via `cd tools/ace && npm test`) + `WikiHealthPanel.test.tsx` (vitest).

## Phase 0 — Root-cause + repro
- **A0.1 ✅** Failing-then-green repro: `wiki-backfill.test.cts` — dump-only project has dumps, no canon; legacy enumeration skips it, the fix includes it.
- **A0.2 ✅** Root-cause note names the exact skip with file:line (`ace-llm-wiki-memory-root-cause.md`: `local-core.knowledgeSources` ~L6036 / `knowledgeNightly` curation loop ~L6203).

## Phase 1 — Bootstrap + backfill
- **A1.1 ✅ / ⊙** OKF skeleton (`index.md`, `log.md`, `00_index/`) on bootstrap/backfill (`bootstrapWikiSkeleton`). ⊙ create-a-project-in-app.
- **A1.2 ✅ / ⊙** `wiki backfill` bootstraps dump-only projects idempotently (`backfillProject`, re-run = no-op). ⊙ run on Brampton `prj-e33a215d`.
- **A1.3 ✅** Skeleton frontmatter conforms (schema + sources[] + ISO timestamps) — `wiki-backfill.test.cts`.

## Phase 2 — Event + candidate spine
- **A2.1 ✅** KnowledgeEvent append-only, schema-tagged, content-addressed/idempotent — `wiki-knowledge.test.cts`.
- **A2.2 ✅** WikiCandidate extraction populates `sourceEventIds` on every candidate.
- **A2.3 ✅** No candidate without a resolvable source event (gate hard-rejects; quarantined events emit none).

## Phase 3 — Tiered promotion gate
- **A3.1 ✅** Sourced + high-confidence + non-sensitive + non-conflicting auto-promotes to canon.
- **A3.2 ✅** Contradiction/supersede ALWAYS routes to inbox, even at confidence 1.0 (the BEE-scar guard).
- **A3.3 ✅** restricted/forbidden candidate never auto-promotes.
- **A3.4 ✅ / ⊙** `wiki inbox` lists pending; `wiki promote <id>` writes canon (git-diffable). ⊙ promote in app, git diff shows canon change.

## Phase 4 — Writeback triggers
- **A4.1 ✅ / ⊙** WIKI_UPDATE packet parses into KnowledgeEvents; DONE/BLOCKED/VERDICT/scorecard parsing proven unaffected. ⊙ real GoalAgent DONE emits an event. (Other triggers — PR/validator/release/chief/research/nightly — share the same `appendKnowledgeEvent`/`ingestWikiUpdate` spine; wiring each runtime emitter is a follow-up, see PRD §7.)
- **A4.3 ✅** Internal subagents feed evidence only: `appendKnowledgeEvent`/`ingestWikiUpdate` never write canon (test asserts no canon after ingest).

## Phase 5 — Canon-first retrieval
- **A5.1 ✅** Canon outranks raw (trust weighting canon 1.0 > working 0.8 > external 0.6 > raw 0.4); raw fallback EXPLICITLY labeled — `wiki-knowledge-contract.test.cts` + `wiki-knowledge-handlers.test.cts`.
- **A5.2 ✅ / ⊙** Every explain result carries citations (canon page `sources` / dump ids). ⊙ `memory explain <q>` shows citations.
- **A5.3 ✅** `forbidden` sensitivity never returned (explain excludes it).

## Phase 6 — Health/audit
- **A6.1 ✅ / ⊙** `wiki health` reports last nightly, dump-only count, candidates accepted/rejected, stale pages, source coverage, raw-vs-canon ratio, index freshness. ⊙ CLI output real numbers.
- **A6.2 ⊙** `WikiHealthPanel.tsx` renders the same metrics (`deriveWikiHealthView` unit-tested). ⊙ panel screenshot with real data (data-feed wiring deferred — see PRD §7).
- **A6.3 ✅** Health flags any dump-only project (would have caught the bug).

## Phase 7 — Accelerator indexes
- **A7.1 ✅(pre-existing)** Link-graph index + `WikiGraphPanel` already exist (`wiki-graph-indexer.cts`); unchanged this PR.
- **A7.2 ▢** Entity/mission/decision/artifact/staleness/contradiction indexes — documented gate, not built (not required for the slice).
- **A7.3 ▢** Vector index OMITTED behind a documented gate (FTS5 sufficient; no silent dependency) — PRD §5 Phase 7.

## Phase 8 — Migration
- **A8.1 ✅** `wiki backfill` is the idempotent, re-run-safe migration for dump-only projects; the autonomous nightly migrates on next run.
- **A8.2 ▢** Broad one-shot migration of legacy stale pages — documented gate (deferred; backfill is additive and never deletes).

## Cross-cutting gates
- **AX.1 ✅** Lint clean on changed source files (`.cts` are not linted by config; `.tsx` clean — followed the `BriefPanel.tsx` `react-refresh` disable idiom).
- **AX.2 ✅** `npm run build` succeeds.
- **AX.3 ✅** `tsc --noEmit -p tsconfig.electron.json`: 0 new errors in changed electron files (baseline ~1540 in local-core unchanged by my edit).
- **AX.4 ✅** Scoped tests green: full `tools/ace` suite 728/729 (1 pre-existing, unrelated `mission dispatch` failure confirmed on the clean base) + 4/4 panel vitest. New wiki suites: 46/46.
- **AX.5 ⊙** Computer-use validation — DEFERRED to the Codex behavioural validator (worker cannot run computer-use).
- **AX.6 ✅** No new third-party runtime dependency; no merge/release.

## Per-phase verdict (worker self-assessment)
Phases 0–6 implemented with unit evidence; phases 7–8 are documented gates. All
⊙ computer-use items and the final behavioural sign-off are handed to the Codex
validator on the exact PR head.
