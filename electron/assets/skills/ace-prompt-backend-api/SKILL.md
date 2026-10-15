---
name: ace-prompt-backend-api
description: Type-specific prompt enhancer for BACKEND / API / SERVICE / PIPELINE / data-model build goals. Use after ace-prompt-enhancer classifies a request as backend (taskType backend/api/service) and before dispatching a Codex worker. Pins the WHAT that keeps server-side work correct — the interface contract, migration safety, boundary-only error handling, backward compatibility, a REAL test+build gate — while leaving the implementation open. Trigger on "build an API / endpoint / service / job / pipeline", "add a migration", "wire up persistence / IPC / CLI", or any non-visible server-side goal.
metadata:
  type: ace-skill
  tier: prompting
  tags: [ace, prompting, backend, api, service, migration, contract, codex]
---

# Ace backend-api prompt enhancer

The domain specialization of `ace-prompt-enhancer` for **server-side** work.
Backend is where a vague brief silently breaks an existing caller or ships an
irreversible migration — the failure is invisible until production. The win is
almost entirely in the WHAT you pin: nail the *contract* and the *safety
envelope*, then trust the worker for the implementation underneath.

Driver: **Codex** (well-specified backend is deterministic, spec-locked
implementation — `claude-codex-specialty-router` hard-routes a clear API/service
spec to Codex). Effort: **Codex xhigh, always** (never `fast` for a contract or a
migration), driven through `/goal` with **bias to action** and `apply_patch`.

## Pin the WHAT (backend contract)
- **The interface contract** (the spine — pin it exactly): endpoint paths /
  function signatures, request/response shapes, status codes, and the types or
  schema. This is the one thing that must NOT drift.
- **Data model + migration safety**: schema changes are **additive and
  reversible** by default; no destructive change (drop/rename/narrow) without an
  explicit OK; every migration has a down path and applies cleanly on a copy.
- **Backward compatibility**: do not break existing callers — preserve current
  routes, signatures, and observable behavior; add, don't mutate, unless the
  spec says otherwise.
- **Error handling at REAL boundaries only**: validate and handle at user input
  and external-API edges; **trust internal callers** — no defensive try/catch
  walls around code you control.
- **Idempotency where it matters**: writes that can be retried (webhooks, jobs,
  enqueue) are safe to replay; name the dedup key.
- **Observability hooks** *if the codebase already has them*: emit on the same
  logger/metric/event spine — match the existing pattern, don't invent one.
- **Tests**: unit at the contract (the signature/shape), integration at the
  boundary (the real route / DB / IPC round-trip) — not just happy-path mocks.

## Leave OPEN (the worker's judgment)
Internal implementation, helper decomposition, control flow, file layout, and
library choice (unless a lib is pinned). Give the contract and the constraints;
let the worker shape what lives behind them.

## Acceptance (backend, each a runnable check)
- `A1` **Build/typecheck green**: the exact command (e.g. `npm run build` /
  `tsc --noEmit -p tsconfig.electron.json`) compiles with 0 errors.
- `A2` **Tests pass and cover the contract**: the exact test command runs green
  and includes a case asserting the request→response shape, not just internals.
- `A3` **Contract honored**: a stated example request yields the expected
  response/status (paste the example → expected pair).
- `A4` **No collateral damage**: existing callers unbroken; no behavior change
  outside the named scope (grep the touched signatures/routes).
- `A5` **Migrations reversible + clean**: up applies on a fresh copy, down
  reverts, no destructive step without the explicit OK.
- `A6` **PR opened** with the URL in the DONE trailer (every agent produces a PR).

## Driver codewords (Codex)
`/goal` · "bias to action" · `model_reasoning_effort=xhigh` · `apply_patch` ·
"no new dependency without justification" · "minimal-diff, match existing
patterns" · "error-handle only at real boundaries; trust internal callers".
End with `DONE: <summary + PR URL>` or `BLOCKED: <reason>`.

## Hard rules
- The REAL test+build gate (A1/A2) is mandatory — a green typecheck alone is not
  acceptance for a contract change.
- Never break an existing caller; additive-and-reversible is the migration floor.
- Error-handle only at real boundaries — defensive walls around internal code are
  a smell, not safety.
- Reference skill ids (`ace-agent-pack-backend`, `ace-github-flow`) —
  never inline their bodies.
- Pin the contract, free the implementation; the signature is sacred, the guts
  are the worker's.

## References
- `ace-prompt-enhancer` — the general enhancer this specializes.
- `ace-agent-pack-backend` — the mounted backend/API/data role pack.
- `claude-codex-specialty-router` — why a clear backend spec routes to Codex at xhigh.
