---
name: ace-run-ledger
description: "Doctrine for the Run-Ledger spine-kernel: an append-only event ledger is the SINGLE source of truth; the reconciler folds events into the orchestration-policy state and asks the spine for the next action; projections (six-panel + the LEAN board) are pure VIEWS that never own state. The board is a READ-ONLY watcher, NEVER a gate — the autonomy loop never reads or waits on it and the watcher spends zero tokens. Agents write telemetry into the ledger AFTER they finish (rubric/commands/duration/their own token spend); cards are keyed by the working agent. Ring-1 drivers are the loop's EFFECTS that append events; the kernel + harness + `ace run board` CLI are the one composition. Source: electron/run-ledger/*."
---

# Ace Run-Ledger spine

The autonomy spine is a small kernel with thin plugs. Source of truth lives in
`electron/run-ledger/`. Read `ARCHITECTURE.md` there for the verified ring census;
this skill is the operating doctrine.

## The one rule (4 rings)

A module earns its place only as **(0) the kernel**, **(1) a driver** (an effect
the loop calls), **(2) an event source** (appends events the loop reads), or
**(3) a surface** (UI that renders a projection or issues a command). Anything in
no ring is cut.

```
 Ring 2 event sources ──append──▶ Ring 0 KERNEL (pure) ──calls──▶ Ring 1 drivers (effects)
 (completion observer)            event-ledger · reconciler        dispatch/validate/gate/merge
                                  projection · kernel · drivers     │
 Ring 3 surfaces ◀──projections── (board = a VIEW)                  └─append events──▶ ledger
 (lean board, panels)
```

## Event ledger = the single source of truth

`event-ledger.cts` is an append-only NDJSON log. Every event is
`{id, runId, ts, type, payload}`, idempotent by `id`, keyed by `runId`. Event
types: `intent.created · run.created · worker.dispatched · worker.progress ·
worker.completed · worker.telemetry · validator.dispatched · validator.completed ·
gate.evaluated · review.requested · fixback.dispatched · merged · released ·
memory.promoted · run.blocked · next-goal.derived`. `review.requested` records
the ready-head review request (ReviewBot ready/trigger + `/codex review`) for
one exact PR head — its id is keyed by `headSha`, so re-gating the same head
never double-requests, and every push re-arms the request. **Append first
(durable), then act** — on boot, replay open runs to resume. Single-writer; no
lock dependency.

## The reconciler owns NO decisions

`reconciler.reconcile(runId, ledger)` folds the run's events into the exact
`state` shape `tools/ace/src/orchestration-policy.cts:nextActionForFeature`
already understands, then calls it. The next action and the merge gate
(`pr-gate.cts:evaluateMergeGate`) come from the spine verbatim — the reconciler
only translates events → state. Never re-implement the decision tree; never write
another VERDICT regex (`verdict.cts` is the single parser).

## The board is a READ-ONLY watcher, NEVER a gate

Owner directive. The autonomy loop runs **only** on the ledger + the spine: append
an event, reconcile, call a driver. It **never reads or waits on the board**.

- `board-projection.cts:projectLeanBoard(ledger)` is a PURE fold of the events
  into lifecycle columns (`todo / in_progress / ready_to_review / done / blocked`)
  of agent-keyed cards. **Zero side-effects.** Contrast the retired
  `getMissionBoard`, which did archive DB WRITES inside its read and was called by
  the loop — the coupling that made the system slow and token-wasteful.
- The watcher spends **zero tokens**: it is plain JS over events. Nothing has to
  "update the board" for the system to advance. Recompute on read; the UI
  re-fetches when events change (it auto-refreshes on the existing
  `state-changed` / `stream-event` pushes).
- **Loop ⟂ board.** If you ever find the loop blocking on a board read, that is a
  bug.

## Telemetry: agents write it AFTER they finish

Agents (Hermes/Claude/Codex) collect their own telemetry and append it to the
ledger when their unit of work completes — the watcher folds it for free.

- Append a `worker.telemetry` event, or ride a `telemetry` object on
  `worker.completed` / `validator.completed`. Shape:
  `{ agent, rubric, score, commands[], durationMs, tokens, notes }`. `tokens` is
  the AGENT's spend — the board's is zero.
- `reconciler.mergeTelemetry` folds it into `state.telemetry`
  (`entries` + `latest` + `totals`). It is **descriptive only**:
  `nextActionForFeature` and `evaluateMergeGate` NEVER read telemetry, so
  decisions stay deterministic.
- Cards are **keyed by the working agent** (`card.agentId`, display `card.key =
  agent/runId`). Distinct agent-tasks (distinct runIds) are distinct cards; the
  runId stays the spine's per-run lifecycle key. Do NOT fragment a run's history
  across agents to make a card — surface the agent on the card instead.

## Ring-1 drivers are the loop's EFFECTS (they append events, not board writes)

`drivers.cts:createDrivers(effects)` is the plug map keyed by the kernel's
`ACTION_DRIVER` names (`dispatchWorker · dispatchFixback · runValidation ·
syncWorker · gatePr · release`). A driver runs the injected real effect and
RETURNS the event(s) the kernel appends. Async dispatches return the completion
only when the effect produced one synchronously; otherwise the Ring-2 completion
observer appends `worker.completed` / `validator.completed` later. **Drivers never
write the board** — they append events; the board folds them.

Contractual review closure rides these drivers: `gatePr` marks a draft PR ready
and requests the ready-head review once per head (`review.requested`);
`dispatchFixback` returns ordinary findings (failing ReviewBot/CI, validator
request-changes) INTO the original worker stream — resuming the linked stream,
or respawning onto the SAME task/worktree when the stream is gone — so a fixback
round never creates a new run, lane, or board card; `syncWorker` pulls the
resumed stream's NEW trailer (a trailer identical to a prior recorded completion
is the stale original verdict and is dropped). Rounds are bounded by
`FIXBACK_RETRY_CAP` (3); merges stay owner-gated in `release`.

## One harness, one CLI

`harness.cts:createRunLedgerHarness({ ledger | ledgerPath, effects })` is THE
single composition: ledger + kernel + drivers + `runToQuiescence` (the loop over
one run). `board()` reads the lean view over the SAME events. The kernel surface
is `createKernel({ ledger, drivers }) → { submitIntent, recordEvent, reconcile,
project, runStep, ledger }`. The CLI reads the lean board with
`ace run board` (`--json` for tooling) — read-only, never dispatches.

## What NOT to do

- Do not add decision logic to the reconciler, projection, or drivers — reuse the
  spine policies.
- Do not make the board a gate, a writer, or a loop dependency.
- Do not let telemetry influence a decision.

## Status: the mission domain has been excised (owner-directed)

The spine is now THE autonomy, not a complement. The mission backend was deleted
from `local-core.cts` (the ~47 `mission*` ceremony bodies + their publicApi
registrations + the `ace mission *` CLI). A few **live "tendon" helpers were
kept** because non-mission code still calls them — they degrade to null/empty
over the now-empty mission tables:

- `getMissionBoard` still feeds the off-limits Operations `ops-pulse` panel, but
  returns an EMPTY board (no rows) — Operations renders, just without mission
  cards.
- `findMissionFeatureByTask` / `missionFeatureGateEvidence` /
  `missionFeatureValidationForGate` still back the **integration-gateway** PR-open
  / gate / merge path; with no mission rows they return null, so the PR pipeline
  degrades cleanly to "no mission linkage."

The retirement of those last tendons (migrating the integration gate-evidence to
the ledger, and Operations to a spine projection) is delete-after-parity,
owner-gated. For the operator's how-to, see **`ace-spine-driver`**.
