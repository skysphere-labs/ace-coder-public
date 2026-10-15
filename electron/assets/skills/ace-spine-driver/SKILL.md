---
name: ace-spine-driver
description: "Operator guide for Hermes agents (Claude/Codex workers) driving the Run-Ledger autonomy spine after the mission-domain excision. The old `ace mission *` CLI is RETIRED — do NOT use it. You DRIVE the spine with TWO commands: `ace run submit` (mint + dispatch a run) and `ace run board [--json]` (read-only watcher, never a gate). Submit dispatches a REAL worktree+agent by default (the loop is live whenever ACE_RUN_LEDGER != 0; ACE_AUTO_RALLY / ACE_SPINE_EFFECTS are DEAD env vars — do not set them). Merge is FAIL-CLOSED: a run only merges to main with BOTH env ACE_OWNER_AUTH_TOKEN set AND a matching --owner-token AND a validator-PASS gate; otherwise it parks at ready_to_review, main untouched. Architecture doctrine: ace-run-ledger. Source: electron/run-ledger/* + tools/ace/src/commands.cts."
---

# Ace Spine Driver

How a Hermes agent (the orchestrator) **drives** the Run-Ledger autonomy spine.
For the architecture (the 4 rings, why the board is a watcher) read
**`ace-run-ledger`** first — this is the day-to-day operating manual. Source of
truth: `electron/run-ledger/*`, `electron/ace-control/index.cts`, and
`tools/ace/src/commands.cts`.

## Your active surface = exactly two commands

```
ace run submit --goal "<goal>" --workspace <projectId> [flags]   # DRIVE: mint + dispatch a run
ace run board [--json]                                           # OBSERVE: read-only watcher
```

Everything between dispatch and the final park/merge is **automatic**. You never
hand-run dispatch / validate / gate / merge for a spine run.

## 1. DRIVE — `ace run submit`

This is the kernel intake — the brain's single entry point. It appends
`intent.created` + `run.created` to the ledger and **immediately drives the run**
(`runSubmit` → `driveRun` → `runToQuiescence`, `ace-control/index.cts`), so a
real git worktree + agent is dispatched right away. Returns `{ runId }`.

```
ace run submit \
  --goal "<what to build, as an outcome>" \
  --workspace <projectId> \           # REQUIRED — a projects.id (see "Finding a workspace")
  [--agent codex|claude] \            # optional — omit to let the router pick
  [--acceptance "<criterion>" ...] \  # repeatable
  [--allow <path> ...] \              # repeatable — scope the worker to these paths
  [--risk trivial|small|medium|high] \
  [--owner-token <tok>] \             # optional — REQUIRED to ever merge (see Safety)
  [--json]
```

- `--goal` and `--workspace` are **required**. (`commands.cts` `run submit` →
  ipcMethod `runSubmit`; the CLI shapes flat flags into
  `{ intent: { goal, scope: { workspaceId, allow[] }, agent?, acceptance?, risk?, ownerAuthToken? } }`.)
- **No `--owner-token` ⇒ the run can NEVER merge** — it parks at `ready_to_review`
  and waits for you/the owner. That is the safe default.
- Driver pick (Claude vs Codex) is automatic via the `next-goal.cts` router unless
  you pass `--agent`: implementation-heavy / high-volume → **codex**; planning /
  ambiguity / review / debug → **claude**. Don't route ad-hoc; let the router decide.

### Finding a workspace
`--workspace` is a `projects.id` (a registered project). If you set
`ACE_SPINE_WORKSPACE_ID` it becomes the default and `--workspace` can be
omitted. Intake now fail-fasts: `runSubmit` REJECTS an intent whose workspace
is missing or unknown before minting a run (the error names the exact fix), so
a bad submit costs one command, not a blocked run. Past intake, consecutive
spawn/link failures are capped (`DISPATCH_RETRY_CAP` = 3 in
`orchestration-policy.cts`) and the run terminally blocks — fix the spec and
submit a FRESH run; never re-submit the same broken spec. List projects via
the projects/workspaces surface before submitting.

## 2. OBSERVE — `ace run board`

```
ace run board            # the lean watcher board (human view)
ace run board --json     # machine-readable (for tooling)
```

`board-projection.cts` folds the ledger into lifecycle columns
(`todo / in_progress / ready_to_review / done / blocked`) of **agent-keyed** cards
with per-card telemetry. It is a **READ-ONLY watcher, NEVER a gate**: the loop never
reads or waits on it, it spends **zero tokens**, and it returns an empty board if
the spine is off. Glance at it for situational awareness; **never block on it**. If
you catch the loop waiting on the board, that is a bug. For transition-driven
eyes, prefer `ace run watch --once` (cursor-diffed pulse, exit 3 = actionable)
and a background `ace run watch --runs <ids> --digest <file>` per dispatch
batch — see `ace-hermes-router`.

## The drive loop (what happens after you submit)

1. **SUBMIT** → `run.created`, reconciler decides `DISPATCH_GOAL_WORKER`.
2. **WORKER DISPATCH → linked** — `spine-effects.dispatchWorker` creates a REAL git
   worktree, builds the size-correct prompt (taskType inferred from the goal + skill
   floor), spawns a real claude/codex agent, and appends a durable
   `worker.dispatch.linked` event `{taskId, streamId, branch, worktreePath}` — the
   run↔task join the board and gate key off. The card sits in `in_progress`.
3. **CARD MOVES** — when the live worker finishes, the Ring-2 completion observer
   (`observeCompletions`) maps it via `from-completion.cts`, resolves the originating
   `runId` from the `dispatch.linked` annotation (`resolveSpineRunId`), records the
   event, and drives the run again. The card advances.
4. **CONTRACTUAL REVIEW CLOSURE** — ordinary review is the ReviewBot (`validate` /
   PR Validator) check + `/codex review` on the PR head, and the controller owns
   the loop end to end: `gatePr` marks a draft PR ready and requests the
   ready-head review once per exact head (`review.requested` event; draft /
   pending / skipped / stale / failed review states are all NON-terminal). A
   failing ReviewBot or CI verdict, or an owner-requested validator's
   request-changes, is returned automatically INTO the **original worker
   stream** as a same-stream fixback round (`dispatchFixback` resumes the linked
   stream, or respawns onto the SAME task/worktree when the stream is gone) —
   never a new lane, card, or operator forwarding. Rounds are bounded by
   `FIXBACK_RETRY_CAP` = 3, then BLOCKED (bounded blocker). Every push
   invalidates prior head-pinned evidence and repeats the exact-head review
   until it passes. A standalone independent validator is dispatched only as a
   deliberate owner action (`runValidation`, skill `ace-computer-use-validator`,
   `VERDICT` trailer via `verdict.cts`).
5. **GATE** — `gatePr` opens the PR and reads **live** PR facts (checks, mergeable,
   head/base SHA); the reconciler re-runs `evaluateMergeGate` (`pr-gate.cts`). The
   gate supplies facts only — it does not merge.
6. **RELEASE or FAIL-CLOSED PARK** — only after a PASS gate. `release` merges **only**
   if `ownerAuthorizedBypass(spec)` holds (env `ACE_OWNER_AUTH_TOKEN` set AND
   equal to the run's `--owner-token`). Otherwise it returns `{}` → no `merged` event
   → the run **parks at `ready_to_review`, main untouched**.

Crash-safe: every event is appended **before** its effect; on reboot the controller
replays open runs and `SYNC_WORKER` (not re-DISPATCH) prevents duplicate worktrees.

## Sizing: how many runs to fan a goal into

One run = one `runId` = one unit the spine drives to terminal/blocked. Multiple runs
multitask on the **same ledger + harness** with **zero cross-run interference**
(`__tests__/spine-multitasking.test.cts`). You decide the *split*, not the per-run
validation — `classifyChangeRisk(spec)` (in **`tools/ace/src/change-risk-policy.cts`**)
sets `validationRequired` / `computerUseRequired` from the spec + risk.

| Size   | Split | Per run |
|--------|-------|---------|
| small  | **1 run** | same-worker review closure → gate |
| medium | **1 run** | same-worker review closure; failing review/CI → same-stream fixback (≤ cap) then BLOCKED |
| big    | **N-lane wave** — one `run submit` per lane, all on the same ledger | each lane runs the same closure loop independently and concurrently |

Submit each lane of a big goal as its own `run submit`. **Do not serialize a wave
through one run**, and do not invent a separate orchestrator loop — the one harness
handles N runs.

## Gating env (verified against merged code)

- **`ACE_RUN_LEDGER`** — default **ON**. `=0` is the master kill: no ledger, no
  effects, no loop; the board returns empty and `run submit` refuses.
- **`ACE_OWNER_AUTH_TOKEN`** — the env side of merge authority. A run merges only
  if this is set **and** equals the run's `--owner-token` **and** the gate PASSed.
- **`ACE_SPINE_WORKSPACE_ID`** — optional default workspace for `--workspace`.
- **DEAD — do NOT set:** `ACE_AUTO_RALLY`, `ACE_SPINE_EFFECTS`. They appear
  only in code comments and read NOTHING; the loop + real effects are already live
  under `ACE_RUN_LEDGER`. Setting them does nothing — don't expect them to "arm"
  anything.

## Write telemetry after you finish (workers)

Append a `worker.telemetry` event (or ride a `telemetry` object on
`worker.completed` / `validator.completed`):
`{ agent, rubric, score, commands[], durationMs, tokens, notes }`. `tokens` is YOUR
spend; the board's own cost stays zero. Telemetry is **descriptive only** —
`nextActionForFeature` and `evaluateMergeGate` never read it, so decisions stay
deterministic. Cards key off `agent`, so always self-report it.

## Safety invariants you can rely on (and must not break)

- **Append-first, idempotent.** Every event is durable before any effect; events
  dedup by `id`, so a duplicate completion collapses to one.
- **Credentials redacted at the write boundary** (`event-ledger.redactSecrets`) — but
  still source creds from env/keychain; never paste a token into a trailer or goal.
- **Fail-closed, owner-gated merge.** No silent auto-merge: merge needs a PASS gate
  via `evaluateMergeGate` **and** the owner-token match above. Default to parking.
- **Telemetry never decides. The board never gates. The loop ⟂ the board.**

## What NOT to do

- Don't run `ace mission *` (deleted) or hand-merge to main.
- Don't set `ACE_AUTO_RALLY` / `ACE_SPINE_EFFECTS` (dead).
- Don't add decision logic to the reconciler/projection/drivers — reuse the spine
  policies (`nextActionForFeature`, `evaluateMergeGate`, `verdict.cts`).
- Don't make the board a writer, a gate, or a loop dependency; don't block on it.
- Don't let telemetry influence a decision; don't serialize a wave that should be N
  concurrent runs.
