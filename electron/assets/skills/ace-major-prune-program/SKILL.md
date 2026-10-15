---
name: ace-major-prune-program
description: "Doctrine for shrinking Ace aggressively without breaking runtime: evidence-first deletion, feature-retirement gates, LOC measurement, and staged PRs."
---

# Ace major prune program

Use this when the owner asks to cut thousands of lines from Ace while preserving working behavior.

## Blunt rule

A 20k LOC reduction is not a refactor; it is a product-surface decision unless proven dead code exists. Splitting modules improves maintainability but usually does not reduce LOC.

## Safe pruning order

1. Count from clean `origin/main`, not a dirty local tree.
2. Rank largest directories/files.
3. Before launching prune workers, repair obvious state-trust issues: stale `ace supervise` rows, wrong reconciliation base, dirty/unknown repo cwd, or unmerged reviewed PRs. If the board lies, prune planning burns tokens and spawns duplicate workers.
4. Prove unused/orphan status by search, route/import inspection, and tests.
5. Delete one coherent surface per PR.
6. Run lint/build/tests and report exact LOC delta.
7. Merge only after validation; do not rebuild/relaunch without owner consent.

## Candidate categories

Safe/high-confidence:
- unmounted UI surfaces
- IPC/API bridges used only by deleted surfaces
- obsolete feature-specific tests/docs
- stale evidence artifacts that belong outside runtime

Medium-risk:
- duplicate desktop/mobile panes
- monolithic components simplified into shared smaller UI
- old smoke tools replaced by tests
- legacy orchestration paths retired by doctrine

High-risk / owner approval required:
- GitHub integration UI/backend
- Remote/PWA/SSH daemon surfaces
- MCP/plugin catalog UI/backend
- Mission/ticket system
- terminal/runtime control core

### Mission domain is load-bearing (verified 2026-06-15) — NOT a clean delete

The Run-Ledger spine is a COMPLEMENT to the mission board, not yet a replacement.
"Delete the mission domain and place in the spine" looks attractive but is blocked:

- The **off-limits Operations tab** consumes it directly: `BriefPanel`,
  `TodosPanel`, `AgentActivityPanel` call `aceApi.missions.create/dispatch/
  board`; `ops-pulse.cts` reads `getMissionBoard`. Deleting the domain bricks the
  protected tab.
- The **integration-gateway** (`integrationOpenPr`, a NON-mission IPC handler)
  reaches into local-core "mission" helpers (`cleanMissionString` — misnamed,
  actually a generic PR-string cleaner — `updateTaskWorktreeBaseEvidence`,
  `findMissionFeatureByTask`, `missionFeatureGateEvidence`).
- `missions.cts` is re-exported into `createAceStore`, which powers 50+
  non-mission IPC handlers; ~37 mission store methods + ~67 call sites.

So retirement is **delete-after-parity, owner-gated**: run the spine loop live
behind `ACE_AUTO_RALLY`, observe MATCH parity, migrate the Operations + the
integration consumers OFF the mission methods, THEN excise. Two whole-codebase
sweeps found NO orphan mission code to cut cheaply. See `ace-run-ledger`.

## LOC target interpretation

- 1k: easy dead-surface prune.
- 4k-8k: realistic no-feature-loss target after several evidence-backed PRs.
- 12k-20k: likely requires retiring product surfaces or replacing custom UI with simpler flows.

Never claim 20k is safe without naming which features disappear or what replacement preserves them.

## PR acceptance

Every prune PR must include:
- baseline SHA counted
- files deleted/changed
- source LOC before/after
- product behavior impact
- rollback path
- validation commands and results

## Current post-PR64 baseline

After Branch Visibility prune and the control-plane merge wave at `6c8dac1`:
- TS/JS-ish source files: 247
- source LOC: ~66,212
- nonblank LOC: ~61,028
- production LOC: ~59,129
- test LOC: ~7,083

Largest target areas:
- `src/components` ~32k LOC total
- `electron/local-core.cts` ~7.2k LOC
- `tools/ace` ~8.1k LOC
- `electron/ace-control` ~4.4k LOC
- `electron/missions.cts` ~2.5k LOC

See `references/prune-program-baseline-2026-05.md` for the earlier 20k-prune planning artifact and `references/prune-baseline-harness-session-2026-05-04.md` for the later harness-session baseline, including the native Mission Board/Kanban bridge dependency, measured candidate surfaces, and the warning not to count gitignored generated `.cjs` files as real repo shrinkage.

## Workflow correction

For Ace pruning, do not perform implementation locally in the control-plane operator lane unless explicitly operating as a temporary bootstrap workaround. Spawn Ace-visible workers with `ace task run --new-task`, track stream/task/worktree/branch/PR IDs, and validate/merge through PR gates. The owner called out direct local work as a workflow failure.

## Tool Proof Contract

Prune work is high-risk by default. It must leave Mission Board/task evidence, compact tool-use ledger proof, and Clawpatch validation evidence before a gate can pass. Skills describe the doctrine; tool events prove the workflow happened.

Do not let Clawpatch or any worker become a hidden runtime, scheduler, queue, committer, pusher, PR opener, or merger. Ace remains the control plane, Hermes remains supported, and all deletions stay behind explicit validation, rollback evidence, and human/validator gates.
