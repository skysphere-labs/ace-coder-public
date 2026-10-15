---
name: ace-task-worker
description: Durable doctrine for Ace task workers - trailer contract, acceptance verification, PR handoff, and bundled skill reminders.
---

# Ace Task Worker

Follow this doctrine for every delegated Ace task.

## Project wiki boundary

- A wiki dump is not truth. You may write source-backed dumps or proposed updates with `ace wiki dump`, but do not edit canonical project wiki pages directly.
- Canonical project wiki pages are curator-owned durable project organization; `ace wiki nightly` is the promotion path.
- Mission Board and live commands are authoritative for in-flight work.
- Use role packs when given (`ace wiki pack --role worker`) and do not load the whole vault, dump, quarantine, diagnostic, deprecated, or inbox folders as truth.
- Do not treat external links, tweets, failed probes, or agent assertions as authoritative unless they were captured, redacted, and curated.

## Simple-First Is The Default

You own one bounded task lane. Use internal helpers only when your CLI supports
them and the work stays inside this task's allowed scope. Do not spawn Ace
external worker waves from a task worker.
If you spawn internal helpers/subagents, keep them linked under your root task.
Their `DONE:`/`BLOCKED:` trailers are evidence for you only; they must not
claim Mission validation, fixback, release, merge, or final card completion.
Only your root GoalAgent trailer advances the Mission feature.

## Escape hatch contract

End your final turn with exactly one of these lines:
`DONE: <one-line summary>`
`BLOCKED: <one-line reason>`

Do not add any lines after the trailer. Keep the summary or reason to one line.
The orchestrator parses those prefixes exactly.

## Before `DONE:`

If you are an implementation or fixback worker, the GoalAgentSpec must name
concrete allowed edit paths. If it does not, do not guess a repo path and do not
edit arbitrary files; end with `BLOCKED: missing allowed edit paths in spec`.

If you made code changes in a Ace worktree, use the `ace-github-flow` skill
before `DONE:`: push your branch, open a draft PR, and include the PR URL in
the `DONE:` line when available.

PR handoff must preserve the recorded base and scope. The branch should diff
against `ACE_REMOTE_BASE_REF`/`ACE_BASE_SHA`, and PR creation must pass
only the concrete allowed paths from the spec or Mission feature. If the
gateway reports `scope_missing`, `scope_contamination`, `remote_base_unresolved`,
or `base_sha_mismatch`, emit `BLOCKED:` with the exact blocker.
Do not treat multiple Ace worktrees as dirty state; they are expected
during parallel work. Root untracked `.agent/` or `.clawpatch/` files are
cleanup noise, not a reason to abandon the recorded remote base. If local
`main` diverges from `origin/main`, workers must keep using the recorded
remote base evidence instead of branching or diffing against local `main`.
CI green is not scope proof.

For small deterministic or no-code work, include enough evidence for the Mission
policy to decide whether independent validation can be bypassed: current PR head
SHA when available, changed files, and the exact checks/commands you ran. Do not
claim validator PASS, Clawpatch PASS, merge readiness, or cleanup; the
orchestrator records those through `mission next`, `mission gate`, and the
integration gateway.

If you are stuck, emit `BLOCKED:` instead of narrating around it.

## After `DONE:` — contractual review closure

Your `DONE:` is not the end of the review loop. The controller marks your draft
PR ready, requests the ready-head ReviewBot + `/codex review` for the exact PR
head, and — when the review or CI fails — delivers the findings BACK INTO THIS
SAME stream as a `Fixback round N/3` prompt. You stay the owner: fix the
findings in your existing worktree/branch, push so the exact-head review
re-runs, and end with a fresh `DONE:`/`BLOCKED:` trailer. Never wait for an
operator to forward findings, and never open a replacement worker, branch, or
PR for a fixback round.

## Acceptance verification

Before declaring `DONE:`, verify every acceptance criterion explicitly. Run the
required checks, inspect the changed files, and confirm the deliverables are
actually present. If a check fails or cannot be run, say so and either fix it
or emit `BLOCKED:`.

## Scoped prune rule

While editing, remove dead or obsolete code/docs/tests inside the touched
scope: unused imports, orphan helpers, stale feature flags, duplicate docs,
tests that only assert removed behavior, and branches made unreachable by this
change. Do not do broad unrelated cleanup. If dead code is outside scope,
report it instead of touching it.

## Browser/computer-use QA

Use browser/computer-use QA when acceptance depends on user-visible web,
desktop, installed-app, or runtime behavior, or when the task spec explicitly
asks for it. Keep it inside the current task/worktree and do not add
credentials, persistent browser profile paths, or hidden runners. If the
required tool is unavailable, emit `BLOCKED:` with the exact reason.

## Other bundled skills

Also consult these bundled skills when relevant:
- `ace-runtime-contract`
- `docs/ops/lean-operator-contract.md`
- `ace-cli`
- `ace-github-flow`

## Knowledge

Read your role pack (`.ace/wiki/00_index/agent-pack-worker.json`) before asking questions; search specifics with `ace memory search "<topic>" --project <id>`; record durable lessons before `DONE:` via `ace memory remember` (see `ace-memory`).

## Tool Proof Contract

Workers should use the Ace commands and skills provided by the task instead of inventing side channels. The orchestrator will verify progress through Mission Board/task evidence and compact tool-use ledger events.
When `ace --json describe "tool batch"` exposes `--run`, use
`ace tool batch --run <runId>` and
`ace tool audit --run <runId>` for run-scoped proof. Run-scoped audit
is preferred for Mission proof because stale global ledger events must not
satisfy a current worker run.

If your task is long, wave, high-risk, merge-gate, security, deploy, release, prune, or cross-cutting, expect independent validation and possible Clawpatch before the gate can pass. Small fixes and small bugfixes should not detour through Clawpatch unless risk, `validationRequired`, or the spec explicitly asks for it. Do not create hidden runtimes, hidden queues, raw merge flows, or unrelated file mutations.
