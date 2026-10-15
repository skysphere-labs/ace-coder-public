# Ace Harness Blueprint

Status: canonical harness blueprint. This consolidates the older SDK and handoff sketches without replacing the working runtime.

## Purpose

Ace is a local-first agentic build harness. It should give Hermes, Codex, Claude, Cursor, and future agents one small set of contracts for planning, building, verifying, fixing back, remembering, and pruning work in isolated git worktrees.

The harness stays simple:

```text
Project Scaffold
  -> Wave Plan
  -> TaskSpec
  -> HandoffEnvelope
  -> Worker Run
  -> CompletionResult
  -> Evaluator
  -> FeatureCheck update
  -> Event trigger
  -> Memory candidate
  -> Wiki update
```

## Load-Bearing Architecture

Keep these pieces intact:

- `ace` is the single machine-readable command surface. The command registry remains the source of truth for `describe`, help, routing, and dry runs.
- Code-producing work runs in one git worktree per task. Workers edit child worktrees, not the orchestrator branch.
- Hermes is the intake organizer/router for brain dumps, not the default long-lived repo orchestrator. Codex is the default builder. Fresh Claude workspace orchestrators are the default medium/large goal controller, and Claude remains the default planner, evaluator, research, and UI specialist.
- DONE/BLOCKED trailers remain the terminal signal. Structured artifacts add machine-readable truth, they do not replace trailer compatibility.
- Enforcement remains in `tools/ace/src/enforcement.cts`: workspace scope, no self-spawn/self-stream, viewer restrictions, and validator-merger checks.
- Runtime skills remain bundled and materialized per agent. Optional external skills are reference material, not default worker load.

## Core Contracts

The first harness slice standardizes these artifacts:

- `TaskSpec`: the worker task body and constraints.
- `HandoffEnvelope`: routing, provenance, budget, trailer contract, and context references.
- `TraceEvent`: append-only semantic events for replay and debugging.
- `Guardrail`: input, tool-call, tool-result, output, and handoff boundary decisions.
- `AgentManifest`: compact definition of orchestrator, builder, evaluator, reviewer, memory, and prune roles.
- `CompletionResult`: the worker's structured result, tests, evidence, changed files, risks, and memory candidates.
- `FeatureCheck`: project acceptance checklist. Only evaluators flip checks to passing.
- `MemoryCandidate`: durable lessons proposed by workers and curated into the wiki.
- `EventTrigger`: deterministic JSON trigger rules for follow-up actions.

JSON schemas live in `docs/harness/schemas/`.

## Event Names

Ace should use the existing bus and completion inbox before adding new machinery. The required harness event vocabulary is:

```text
task.created
task.started
task.awaiting-approval
task.completed
task.blocked
task.failed
worker.completion.detected
worker.verdict.detected
feature.checked
feature.passed
feature.failed
fixback.created
memory.candidate.created
memory.promoted
wiki.updated
guardrail.triggered
handoff.created
trace.appended
```

## Result Flow

Worker output is accepted only after verification:

```text
Worker says DONE
  -> Ace reads .ace/run/<runId>/completion.json
  -> CompletionResult validates
  -> evaluator runs ace task validate --run <runId> --feature <featureId>
  -> validator loop checks tests and evidence
  -> evaluator updates FeatureCheck
  -> events fire
  -> memory candidates are reviewed
  -> wiki is updated
```

Reject or fix back when a code task has no completion artifact, invalid schema, missing acceptance evidence, missing tests, changed files outside allowed paths, an empty diff with `requireChanges=true`, or a non-evaluator marking features passed.

## CLI Surface

The first file-backed project harness commands are:

- `ace project init-harness --project <name> [--project-dir <path>]`
- `ace task result --run <runId> [--project-dir <path>]`
- `ace task validate --run <runId> --feature <featureId> [--project-dir <path>]`
- `ace run list [--project-dir <path>]`
- `ace wave list [--project-dir <path>]`
- `ace feature list [--project-dir <path>]`
- `ace feature mark --id <featureId> --pass --role evaluator --evidence <runId>`
- `ace memory candidates [--project-dir <path>]`
- `ace wiki update --page <page.md> --text <markdown> [--append]`
- `ace event emit <event> --payload <json> [--project-dir <path>]`

These commands deliberately use `.ace/` files first. `event emit` applies only enabled deterministic triggers; the default scaffold disables legacy evaluator/fixback automation and records feature-pass notifications for Hermes wiki/status review. Deeper event-bus and database wiring can wrap the same artifacts later without changing the project contract.

## Mission-Board Development Pattern

The project harness is the file-backed contract; the native Mission Board is
the live execution control plane. A production Ace run should follow:

```text
Mission card
  -> task run / mission dispatch
  -> worker completion artifact
  -> validator-fixer-merger validates exact PR/head
  -> same-PR repair, block, or gate
  -> Hermes wiki/status promotion
  -> lean-prune audit when cleanup is needed
```

Use `ace describe` to inspect the commands supported by the installed runtime.
The public source does not include a one-click mission-loop shell wrapper.

## Routing

| Work | Default |
| --- | --- |
| Intake / brain dump organization | Hermes |
| Medium/large goal controller | Fresh Claude workspace orchestrator via `goal launch` |
| Backend/code/tests/prune audit | Codex |
| Planning/spec/research/evaluation/UI judgment | Claude |
| Small one-off code task | Ephemeral Codex |
| Manual/recovery workspace lane | `orchestrator start` |
| IDE-local specialist | Cursor, explicit only |

## Guardrails

Guardrails run at boundaries:

- input guardrails before a task starts
- tool-call guardrails around sensitive tools
- tool-result guardrails after sensitive tools return
- output guardrails before accepting worker results
- handoff guardrails before routing work

Tool guardrails must wrap custom tool invocation, not only the beginning or end of an agent chain.

## Memory And Wiki

Memory is not chat history. It stores durable project lessons: decisions, pitfalls, module conventions, successful prompts, rejected approaches, connector facts, architecture constraints, and project terminology.

Flow:

```text
CompletionResult.memoryCandidates[]
  -> Hermes reviews and dedupes
  -> approved memory is written to project wiki
  -> compact scaffold files reference the wiki
  -> future workers read/search the wiki before acting
```

## Prune Doctrine

Pruning is evidence-backed and staged:

- Do not delete active runtime code from Knip output alone.
- First consolidate docs and doctrine with `SUPERSEDED_BY` notices.
- Delete in a later PR only after replacement exists, links are updated, imports/search prove safety, and lint/build/smoke checks pass.
- High-risk product surfaces such as remote/PWA, plugins/MCP UI, mission engine, GitHub explorer, and broad `local-core` deletion require explicit feature-retirement approval.

## Migration Slices

1. Blueprint, goal protocol, project scaffold, schemas, smoke tests.
2. Structured completion artifacts and optional validation helpers.
3. Feature checklist integration.
4. Event triggers and completion inbox wiring.
5. Memory/wiki promotion loop.
6. Doc/doctrine pruning.
7. Mission dashboard simplification.
8. Product-surface retirements only with explicit approval.
