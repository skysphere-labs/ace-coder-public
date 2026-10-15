# What to steal from the OpenAI Agents SDK (and what not to)

Reference: https://developers.openai.com/api/docs/guides/agents

Ace's runtime is fundamentally different from the OpenAI SDK's: we do not own the model loop. Claude Code (or Codex, or Gemini) owns its own loop inside a PTY, and Ace drives it from the outside via `ace`. That constraint rules some of their primitives out entirely and makes others even more valuable than they are in-SDK.

## Adoptable — worth copying

- **Handoff primitives as explicit envelopes, not free-form prompts.** Their SDK requires every handoff to declare who owns the reply; we currently hand off via long prose prompts. → Formalising `HandoffEnvelope` (see `docs/harness/schemas/handoff-envelope.schema.json`) is the direct port.
- **Guardrails as a pipeline stage, not a prompt hint.** In the SDK guardrails can block execution before or after a tool call. Ace already has `--require-changes` and `ace approve`, but there's no named "guardrail" stage between envelope-parse and first-turn. → Add a pre-turn validation step that rejects envelopes with missing deliverables/trailer contract before the worker ever sees them.
- **Structured trace format distinct from raw logs.** Their tracing treats tool calls, handoffs, and outputs as typed events — debuggable by query, not only by replay. We have `ace record` (PTY bytes) and `ace watch` (state/ready/approval). → A semantic TraceEvent NDJSON stream alongside the PTY recording is the right shape to copy.
- **Specialist ownership decisions up front.** Their model: decide the orchestrator/worker/reviewer split at handoff-creation time. → Encode the `role` on both `source` and `target` of a HandoffEnvelope so trace tooling can group events by role.
- **Evaluation loops built on traces.** Their workflow: trace first, then add evals on those traces. → Same order for us — ship the trace store before trying to build eval harnesses.
- **Explicit continuation strategy when a turn ends without a trailer.** SDK distinguishes "model stopped" from "task done". We half-have this via `--max-rounds`, but the retry prompt is hard-coded. → Lift the retry-prompt template into the envelope (`budget.retryPrompt`) so different workflows can pick different nags.

## Not adoptable — their runtime, not ours

- **Owned agent loop / tool dispatcher.** They execute tool calls in-process via SDK hooks. We can't — Claude Code runs the loop and dispatches tools itself inside its own CLI. We observe from outside the PTY. Trying to reproduce this would mean rebuilding the Claude Code tool layer.
- **In-process conversation state object.** Their SDK keeps a typed state object across turns; ours lives inside the worker's context window plus whatever we serialize into the prompt. Mimicking it would duplicate what Claude Code already persists for itself.
- **Hosted tools.** Their hosted tool pattern assumes their infrastructure hosts the tool. Ace's "hosted" tools are MCP servers the worker is already wired to — there's no parallel registry we should invent.
- **Function-tool auto-registration via decorators.** Language/runtime-specific; not meaningful for a PTY-driven harness.
- **Streaming-token-level hooks.** We see post-render screen + state transitions, not token deltas. Trying to build per-token hooks on top of ANSI scraping is strictly worse than what Claude Code already exposes internally.
- **Model-switching mid-run.** Their SDK can swap the underlying model between turns. Ace's model is fixed per stream by the CLI that spawned it; mid-run switches would require killing and respawning the stream — which is already doable via `ace close` + `ace spawn`, and doesn't need a new primitive.

## Rough ordering if we were going to ship this

1. HandoffEnvelope v0 (three new optional fields on the existing `--spec`).
2. Correlation id threaded into the rendered prompt's trailer instruction.
3. NDJSON trace sink fed by `ace watch`, four event types only.
4. `ace trace <handoffId>` read verb.
5. Guardrail pre-turn stage (envelope validation).
6. Richer TraceEvent types (`tool-call` / `tool-result` / `approval-*`).

Everything past (3) is speculative until we see how the first trace store gets used.
