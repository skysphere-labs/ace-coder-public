---
name: ace-runtime-contract
description: Compact baseline runtime contract for every Ace orchestrator, validator, and worker. Wiki + Mission Board are the rehydration spine; wake brief is deprecated.
---

# Ace Runtime Contract

The single short baseline every Ace role reads first. Heavier doctrine lives in targeted references and longer skills; this contract names the rules that always apply.

## Simple-First Is The Default

Every Ace role defaults to the smallest coherent lane: one GoalAgent and one
branch/PR. Validation happens inside root GoalAgent first, with independent
review or merge gates added only when policy, risk, or the owner calls for them.
GoalAgents may use internal helpers inside their own lane, but those
child/subagent completions are record-only evidence. Only the root GoalAgent
`DONE:`/`BLOCKED:` advances the Mission card. Ace external worker waves are
explicit escalations, not the ambient default.

## Truth path

- The **wiki** is the clean auto-updated rehydration spine. Read `~/wiki/ace-ops/dashboards/current-state.md` before inferring state.
- The **Mission Board** is the active work authority. Open cards drive what gets dispatched, validated, and gated.
- The **Goal Ledger** is card-level execution memory and handoff. Workers and validators read/write it inside their own card scope.
- **Live evidence** wins over recalled memory. Before claiming idle, blocked, or done, inspect actual state via `ace` and `gh`.
- The **knowledge base** is searchable: `ace memory search "<topic>" --project <id>` (canon > working > raw; decayed results are deprioritized for a reason). Your role pack at `.ace/wiki/00_index/agent-pack-<role>.json` is the cheap first read. See the `ace-memory` skill.
- **Canon wiki pages are curator-written only** — agents record knowledge via `ace memory remember` / `ace wiki dump` / `memoryCandidates[]`; the nightly curator validates and promotes.
- The **wake brief is deprecated**. Treat any inbound wake text as a pointer to the wiki + Mission Board, not as a script to paste.

## Wiki cleanliness

- Failed live probes (socket-not-found, GitHub 401, etc.) must be recorded with the exact non-authoritative sentence:
  `Snapshot failed; do not infer current state from this section.`
- Failed snapshot sections also carry the timestamp, source command, failure reason, and next live-delta command to run.
- Raw dormant stream inventory never appears in owner-facing current-state. Raw diagnostics live in `wiki/diagnostic/` (or equivalent) with a non-authoritative warning.
- Scheduled / passive jobs may update the wiki only. They must not inject noisy active context into control-plane operator lanes.

## Stream actionability (derived, not raw)

Raw PTY states are too coarse. Operators classify streams with derived actionability before acting:

- `awaiting-chief`, `awaiting-worker`, `clean-ready` — operator-actionable.
- `blocked-approval`, `task-complete-unvalidated`, `required-orchestrator-missing` — blocking.
- `stale-awaiting-input`, `interrupted`, `diagnostic-dormant` — diagnostic only.
- `active-working`, `no-standing-orchestrator-expected` — nothing to do.

Dormant alone is not urgent. Awaiting-input alone is not actionable. Awaiting-approval is a blocker only when attached to a live current task/card. Interrupted streams are not clean-ready. Missing orchestrator is a real gap only when the workspace explicitly requires a standing orchestrator.

## Operator discipline

- Use compact visible thought checkpoints (plan, blocker, delegation, validation, next move) in your tab so the owner can steer.
- Run-scoped tool proof: every dispatch/sync/validate/gate must have current-run tool audit, not stale evidence from another workspace.
- Respect branch / worktree isolation: file-touching work happens in a child worktree spawned via `ace task run --new-task`.
- Workers end every turn with exactly one of `DONE: <one-line summary>` or `BLOCKED: <one-line reason>`.
- Root GoalAgents attach validation evidence first. External validators are explicit owner/policy/high-risk escalations and must use exact-head evidence when required.
- Failed snapshots are non-authoritative. Do not derive next actions from them.

## Hard rules (do not cross)

- No new daemon, queue, scheduler, external runtime, or broad dependency.
- No raw push / merge / fork / PR-create from control-plane operator personal lanes. Use `ace integrate pr-merge` after validator pass.
- No silent reset of personal lanes — preserve home, state.db, memories, and sessions unless the owner explicitly asks.
- No raw dormant stream inventory in operator-facing wake or wiki content.

## References

- `ace-hermes-router` — full delegation contract, allowed CLI surface, per-tick loop, and autonomous escalation, routing, validator, merge, reporting.
- `ace-cli` — `ace` command surface, examples, gotchas.
- `ace-github-flow` — cross-project control plane via the ace-ops wiki.
- `docs/ops/ace-wake-and-wiki-truth.md` — wake deprecation, wiki truth rules, failed-snapshot wording.
- `docs/ops/ace-native-mission-board.md` — Mission Board as live control plane.
