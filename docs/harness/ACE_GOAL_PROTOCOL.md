# Ace Goal Protocol

Status: canonical worker handoff protocol for Ace goals.

## Codex Persistent Goals

Codex `/goal` is a thread-scoped persistent objective for long-running work.
Use it only when the task has one bounded objective, hard constraints,
verifiable completion criteria, and a validation loop. Do not use it for a
loose backlog or a directionless chat.

For Codex code/UI workers, Ace `goalMode=auto` queues a compact
TaskSpec-derived command before the framed worker prompt:

```text
/goal Complete <goal>. Constraints: <hard boundaries>. Done when:
<acceptance criteria>. Verify with evidence before DONE; pause or BLOCKED on
unsafe scope, missing guidance, or exhausted budget. Maintain the agent-owned
ledger at <path> and keep implementation-notes.html current at checkpoints,
before compaction, and before final handoff. Budget: <round limits>.
```

When Mission Board dispatch creates a Goal Ledger, the ledger pointer is also
threaded into the Claude/Codex worker prompt as a `## Goal Ledger` section.
Workers must read `GOAL.md` before work and refresh
`implementation-notes.html` at checkpoints — the ledger is the rehydration
spine that lets Rook/King resume without rebuilding context from raw streams.
The ledger is **not** validation proof; the actual validation command/result
must be recorded for any acceptance claim to count.

The durable Codex goal is not the full task packet. It is the thread objective
that survives follow-up turns and status checks. The framed TaskSpec below
remains the source of detailed context, deliverables, completion artifacts, and
Ace control-plane constraints.

Lifecycle:

- create: `goalMode=auto|on` queues `/goal <objective>` for eligible Codex
  workers before the TaskSpec prompt.
- inspect: `/goal` without arguments is status only; it must not be used as the
  setup command.
- continue: keep working in checkpoints until acceptance has evidence.
- pause/block: pause or return `BLOCKED:` when constraints conflict, guidance is
  missing, approval is required, or budget is exhausted.
- clear: clear or replace the goal only when the task is done, blocked, or
  changing direction.

## Standard Goal Shape

Every generated worker prompt should use this structure:

```text
/goal

# [Wave]-[Task Name]

## Worker Role
[Codex builder | Claude planner | Claude evaluator | Claude goal orchestrator | Hermes intake router]

## Mission
One clear outcome.

## Read First
- PROJECT_BRIEF.md
- ARCHITECTURE_RULES.md
- FEATURES.json
- WAVE_PLAN.yaml
- PROGRESS.md
- DECISIONS.md
- [task-specific files]

## Scope
You may change:
- [paths]

You must not change:
- [paths]

## Context
Short, non-derivable context only.

## Constraints
- Simple
- Surgical
- No unrelated refactors
- No raw output as truth
- Use structured completion

## Deliverables
- Concrete artifacts

## Acceptance Criteria
- Binary checks

## Verification
- Commands, manual checks, screenshots, logs, or artifacts that prove each
  acceptance item.

## Lifecycle/Budget
- Work in checkpoints.
- Continue across turns until acceptance is verified, `BLOCKED:` is true, or
  the configured round/verification budget is exhausted.
- Treat worker `DONE:` as evidence only; validation decides pass/fail.

## Completion
- Write `.ace/run/<runId>/completion.json`
- Update `PROGRESS.md`
- Update `FEATURES.json` only if evaluator role
- End with exactly `DONE: <one-line summary>` or `BLOCKED: <one-line reason>`
```

## Provider Adjustments

Codex builder:

- Give exact paths and exact commands.
- Keep context compact.
- Use repo-local scripts.
- Run tests or report why they cannot run.
- Do not mark feature checks passing.

Claude planner/evaluator:

- Planner writes clear specs, UX plans, and acceptance criteria.
- Validator-fixer-merger is skeptical, records evidence, and may repair ordinary in-scope defects on the same PR.
- Validator-fixer-merger may mark `FeatureCheck.passes=true` only with real evidence.

Hermes intake router:

- Organizes brain dumps into goals, constraints, acceptance, risks, and open questions.
- Launches one direct worker for tiny/small deterministic tasks.
- Launches a fresh same-workspace Claude goal orchestrator for medium/large or ambiguous work.
- Does not edit files directly.

Claude goal orchestrator:

- Plans, delegates, watches events, and verifies from a visible workspace controller stream.
- Spawns implementation/research/validator workers through `ace task run --workspace <same workspace> --new-task`.
- Does not edit files directly or use hidden side channels.
- Routes fixbacks and summarizes current state back to Hermes/user.

Cursor:

- Use for focused IDE-style changes only when explicitly selected.
- It is not the default orchestrator.

## Fixback Prompt

Use this only after explicit escalation when acceptance failures cannot be repaired by the active validator-fixer-merger:

```text
/goal FIXBACK

# Fixback for <taskId>

## Original Goal
<goal>

## Validator Failures
1. <failure>
2. <failure>

## Required Fix
Fix only these failures.

## Do Not Do
- Do not redesign unrelated code.
- Do not change acceptance criteria.
- Do not edit unrelated modules.
- Do not mark feature passing yourself.

## Required Verification
- <commands>
- <manual checks>

## Completion
Update completion.json, PROGRESS.md, and end with DONE/BLOCKED.
```

## Acceptance Discipline

- Every acceptance item is binary.
- Passing tests are evidence only when they cover the requirement.
- If ordinary verification fails, the validator-fixer-merger repairs the same branch/PR or blocks with scope/permission evidence.
- Send a separate fixback only when explicitly escalated.
- If the task is blocked, record the exact blocker with `BLOCKED:`.

## Artifact Paths

Workers write:

```text
.ace/run/<runId>/completion.json
.ace/run/<runId>/trace.ndjson
.ace/run/<runId>/evidence.md
```

The trailer remains the terminal signal; `completion.json` is the structured truth used by evaluators and automation.
