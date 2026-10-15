---
name: ace-internal-subagents
description: How a Ace build worker fans out INTERNALLY inside its single tab — Task tool or dynamic-workflow agent()+pipeline()+parallel() with worktree isolation, 1-level nesting only, sub-worktrees merged back before DONE. Replaces the old "spawn external Ace agents" model.
---

# Ace Internal Sub-Agents

A build worker is ONE Ace tab on ONE branch. When the work fans out, you
fan out INSIDE your own session — you do NOT spawn external Ace agents and
you do NOT call `ace task run`. This skill is the worker's internal
fan-out doctrine and it REPLACES the old orchestra/external-spawn model.

## Fan out only when it helps

Default to one root GoalAgent lane. Use internal sub-agents only when the work
has genuinely independent units, repeatable verification, or a capability card
that benefits from cross-checking. Validation stays inside root GoalAgent; child
outputs are evidence only and do not advance Mission, merge, or release state.

## Fan-out mechanism (Claude)

- Prefer the dynamic-workflow surface: `agent()` + `pipeline()` + `parallel()`.
  Wrap every MUTATING sub-agent in `isolation: 'worktree'` so concurrent edits
  never collide.
- Capability-check dynamic workflows first — they are a research preview. If the
  surface is unavailable in this runtime, FALL BACK to sequential Task-tool
  sub-agents. Do not block on the preview API.
- Use `parallel()` for independent units, `pipeline()` to chain dependent
  stages (research -> implement -> verify -> synthesize).

## Fan-out mechanism (Codex)

- Codex fans out via sub-processes, not the Task tool. Use `multi_tool_use.parallel`
  for independent calls; keep each child scoped to its own paths.

## 1-level nesting ONLY

A sub-agent must NOT spawn its own sub-agents. Exactly one level of nesting.
If a sub-agent's brief is too big to do flat, the worker re-plans and splits it
into more sibling sub-agents — the worker owns the fan-out, not the children.

## Tight scoped briefs

Each sub-agent gets a minimal brief: its exact goal, the concrete allowed edit
paths (or read-only research scope), the success criterion, and a stop
condition. No pasted doctrine — reference skill ids. For the hardest design or
synthesis steps, ask for careful reasoning and enough output budget to capture
the decision.

## Model routing inside the worker

- Route VERIFY / JUDGE / lint-check / mechanical stages to cheaper models.
- Reserve the strongest available model for synthesis, design, and ambiguity.
- This keeps fan-out cheap without starving the load-bearing steps.

## Results fold back

Every sub-agent's result returns into the worker's own session — the worker
reads, reconciles conflicts, and is the single author of the final answer. A
sub-agent never reports DONE to the orchestrator; only the worker does.

## Merge sub-worktrees BEFORE final DONE

If sub-agents ran in `isolation: 'worktree'`, their changes live on separate
sub-worktrees. The worker MUST merge all sub-worktrees back onto its single
branch before final DONE, so Ace's `requireChanges` diff gate sees real
changes on the worker branch. Unmerged sub-worktree work is invisible to the
gate and counts as no change.

## Long-run hygiene

- Pre-allowlist `npm` and `git` (and the project's test/build commands) up front
  so long parallel runs do not stall on permission prompts mid-flight.
- Honor the runtime's concurrency / agent caps. Do not exceed the configured
  max parallel agents; queue extra units instead of oversubscribing.
- Keep scratch under `.ace/scratch` (see `session-memory-notes`).

## Escape hatch contract

End your final turn with exactly one of:
`DONE: <one-line summary>`
`BLOCKED: <one-line reason>`

After sub-worktrees are merged and acceptance is verified, complete the scoped
PR handoff described by `ace-github-flow`/`ace-integration` before the
final `DONE:`.

## References

- `ace-integration` — scoped PR handoff and optional gated merge helper.
- `ace-task-worker` — trailer contract, acceptance verification, scoped prune.
- `ace-github-flow` — branch, PR, GitHub Actions/current-head, and merge-gate evidence.
- `session-memory-notes` — per-task scratch hygiene.
