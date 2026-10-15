---
name: ace-prompt-refactor-migration
description: Type-specific prompt enhancer for large MECHANICAL REFACTOR / RENAME / MOVE / EXTRACT and DATA/SCHEMA/FORMAT/VERSION MIGRATION goals. Use after ace-prompt-enhancer classifies a request as a high-volume deterministic transform (taskType refactor/migration) and before dispatching a Codex worker. Pins the WHAT that keeps a mechanical sweep safe — the exact old→new mapping, behavior-preservation, complete-site-list, reversible/idempotent migration — while leaving the order of operations and tooling open. Trigger on "rename X to Y everywhere", "move/extract module", "migrate the schema/format/version", "codemod", or any no-op transform across many files.
metadata:
  type: ace-skill
  tier: prompting
  tags: [ace, prompting, refactor, rename, migration, schema, codemod, codex]
---

# Ace refactor-migration prompt enhancer

The domain specialization of `ace-prompt-enhancer` for **pure transform** work.
A refactor or migration is not feature work — its defining property is that nothing
observable changes. That is exactly why a vague brief is dangerous here: the
failure mode is silent (a half-finished sweep, a dropped row, a one-way migration)
and looks green until it bites. The whole job of the brief is to make the invariant
explicit and make completeness checkable.

Driver: **Codex** (high-volume, deterministic, mechanical — `claude-codex-specialty-router`
hard-routes large refactor/migration to Codex). Effort: **xhigh always**
(`model_reasoning_effort=xhigh`, never `fast`) — a sweep that caps coverage to save
time is the bug.

## Pin the WHAT (refactor/migration contract)
- **Exact scope + mapping**: name precisely what is renamed/moved/extracted and the
  literal old→new mapping (symbol, path, table, key, version). No "and similar".
- **Behavior-preservation invariant** (the core of a refactor): the full test suite
  is GREEN and **identical** before and after — capture both runs. Public API stays
  stable; no signature, default, or import-path drift the caller can observe.
- **Migration safety** (for data/schema/format/version): an `up` AND a tested
  `down`/rollback; **idempotent** (re-running is a no-op, not a double-apply);
  **dry-run first** with a diff/count preview; explicit data-loss guardrails
  (column drops, type narrowing, truncation called out, not implied).
- **Completeness**: the COMPLETE call-site list, or the exact command to enumerate
  every site (`grep -rn`, `rg`, AST scan) — and the rule that a partial sweep is a
  failure, not a milestone. Silent truncation is the named enemy.
- **Boundaries**: allowed paths and never-touch paths; do not "improve" adjacent
  code while passing through.

## Leave OPEN (the worker's mechanics)
The order of operations, the internal mechanics of the transform, and the tooling
(codemod/AST script vs `sed` vs hand edits, one big patch vs staged). Pin the
invariant and the coverage proof; free the how.

## Acceptance (refactor/migration, each a runnable check)
- `A1` **Test suite identical before+after**: capture the pre-change run, do the
  transform, capture the post-change run — both GREEN, same set of tests passing.
- `A2` Build/typecheck green (the exact command) with 0 errors — the non-negotiable gate.
- `A3` **ALL call sites updated**: grep/rg for the old symbol/path/key returns ZERO
  stragglers (paste the command and its empty output as proof).
- `A4` **No behavior change**: public API stable and diff is mechanical — OR, for a
  migration, data verified row-for-row (counts + spot-check) against the source.
- `A5` Migration is **reversible** (`down` executed and verified) and **idempotent**
  (second run is a clean no-op).
- `A6` **PR opened** with the URL in the DONE trailer (every agent produces a PR).

## Driver codewords (Codex)
`/goal` · "bias to action" · `model_reasoning_effort=xhigh` · `apply_patch` ·
`multi_tool_use.parallel` (fan out across many files at once) · "no behavior change
— pure transform; tests must be identical before and after". End with
`DONE: <summary + PR URL>` or `BLOCKED: <reason>`.

## Hard rules
- A behavior change is a **failure**, not a bonus — refactors are surgical, not
  feature work.
- NEVER leave a partial sweep. If you must cap coverage, say so EXPLICITLY in the
  trailer — an unannounced straggler is the worst outcome.
- Migrations MUST be reversible and dry-runnable before they touch real data.
- Reference skill ids — never inline their bodies.

## References
- `ace-prompt-enhancer` — the general enhancer this specializes.
- `claude-codex-specialty-router` — why high-volume refactor/migration routes to Codex at xhigh.
