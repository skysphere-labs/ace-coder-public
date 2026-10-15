# Ace Mission Workflow

This project uses Ace as a visible mission-board control plane. Every unit
of work is tracked as a Mission feature card, executed by a worker in an
isolated worktree, validated by one validator-fixer-merger, and then either
repaired on that same PR or marked ready for merge.

## End goal

The end goal is not "a worker said DONE." The end goal is:

1. Mission card exists and names the acceptance criteria.
2. Worker branch/worktree/stream is attached to the card.
3. Worker writes `.ace/run/<runId>/completion.json`.
4. Evaluator runs `ace task validate --run <runId> --feature <featureId>`.
5. Failing validation emits `feature.failed` and creates a fixback packet.
6. Passing validation emits `feature.passed`, creates a memory candidate, and
   leaves the card ready for the validator/merge gate.
7. Memory librarian promotes durable lessons to `.ace/wiki/`.

## One-click launch

From a repo with Ace running:

```bash
scripts/ace-mission-loop.sh \
  --workspace "$ACE_WORKSPACE_ID" \
  --project "{{PROJECT_NAME}}" \
  --mission "{{PROJECT_NAME}} launch" \
  --feature "First slice::Implement the first end-to-end product slice"
```

The script initializes `.ace/`, creates a native Mission, dispatches ready
cards, syncs worker trailers, launches validator tasks, gates validator
trailers, and stops only when the mission has no dispatchable/validatable work
remaining or a blocker is recorded.

## Routing defaults

- Hermes/Rook/King stay thin orchestrators. They read user intent, dispatch one
  bounded GoalAgent by default, track state/status, and curate canonical wiki
  updates. They never edit app code directly.
- Codex is the default builder for backend, data, tests, deterministic refactor,
  prune, and CLI work. Codex code workers use a TaskSpec-derived `/goal
  <objective>` automatically in auto mode for code/UI tasks that need it.
- Claude is the default UI/product/planner/research specialist. Claude workers
  get explicit Goal, Context, Constraints, Deliverables, and Acceptance framing
  in the TaskSpec prompt; do not send Codex-only `/goal` to Claude.
- Validator-fixer-merger work defaults to Codex for PR/diff/CI mechanical rigor.
  It may repair ordinary in-scope defects on the same PR before final PASS.
- GoalAgents may use internal subagents or planning inside their own lane.
  Ace external worker waves require explicit `explicit-wave` escalation.

## Loop contract

Each feature follows this loop:

```text
Mission card
  -> worker dispatch
  -> DONE/BLOCKED trailer
  -> completion artifact
  -> validator-fixer-merger validates exact PR/head
  -> feature.checked
  -> request-changes -> same validator repairs same PR or blocks
  -> feature.passed -> Hermes wiki/status review -> validator/merge gate
```

The orchestrator should not skip later steps because an earlier command
completed. Completion is step-local; the mission loop continues until the end
goal is satisfied or a true blocker is recorded.

## Validator trigger policy

Ace treats worker completion as an event. The controller should subscribe
to `worker-completion`, auto-route the next step, and keep that routing visible
through Mission events, the child registry, and validator task links.

Single-lane low-risk fixes may self-review instead of spawning an independent
validator. Ordinary validation uses one validator-fixer-merger for the exact
PR/head. Waves join lanes and spawn one wave validator only when the Mission is
explicitly in `explicit-wave` mode. Separate fixback workers are explicit
escalations, not the default repair path.

When a worker changes user-visible UI or browser workflow behavior, validation
must exercise the flow with the approved browser/computer-use tool, click the
changed controls, and capture evidence before PASS.

## Lean-codebase guardrail

Prune work is a first-class Mission card, not opportunistic deletion. Every
prune card must include import/search evidence, LOC delta, risk, rollback path,
tests, and explicit product-surface approval for high-risk areas. Prefer fewer
files, fewer commands, fewer role abstractions, and no hidden runtimes.
