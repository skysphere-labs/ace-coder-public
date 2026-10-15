---
name: claude-codex-specialty-router
description: The Claude-vs-Codex SPECIALTY decision matrix for picking a build-worker driver. Use when deciding "Claude or Codex for this task?" or routing a dispatch by driver. Claude wins planning, architecture, ambiguity, hard debug, orchestration, research, UI, fan-out; Codex wins deterministic high-volume implementation, refactor, migration, backend. Effort/mode/driver packs are runtime-owned — never write them into prompts.
---

# Claude ↔ Codex Specialty Router

Pick the driver for a build worker by **task shape**; the runtime injects the
matching driver pack at dispatch. This is the specialty layer underneath
**ace-hermes-router**'s one-line driver pick — Hermes decides *whether* to
dispatch; this skill decides *which engine*.

## When to use

- "Claude or Codex for this?" / "which driver should this worker be?"
- You're about to dispatch a build worker and need to set `driver:`.
- A task is mixed and you're unsure which engine's strengths dominate.

## Core rule

**Route by task shape, not by habit.** Claude is the **judgment** engine
(ambiguity, design, debugging the unknown, orchestration, anything user-visible);
Codex is the **throughput** engine (deterministic, high-volume, spec-locked
implementation and migrations). When a task is genuinely both, **split it**:
Claude plans/architects, Codex implements the mechanical bulk, Claude reviews the
seam. Don't run one engine against the other's grain.

## The specialty matrix

| Task shape | Driver | Effort | Why |
| --- | --- | --- | --- |
| Planning / architecture / system design | **Claude** | xhigh | holds ambiguity, weighs tradeoffs, names the seams |
| Ambiguous intent (can't pin down in one sentence) | **Claude** | xhigh+ | asks the right question instead of guessing |
| Hard / unknown-root-cause debugging | **Claude** | xhigh+ | hypothesis-driven, tolerates the unknown |
| Orchestration / multi-agent / fan-out design | **Claude** | xhigh+ | dynamic-workflow `agent()`+`pipeline()`+`parallel()` |
| Research / synthesis / PRD / grill | **Claude** | xhigh+ | reads broadly, interrogates, writes the scoped doc |
| UI / product / anything user-visible | **Claude** | xhigh+ | product judgment + computer-use QA |
| Deterministic high-volume implementation | **Codex** | xhigh | bias-to-action, ships the bulk fast |
| Large mechanical refactor (rename/move/extract) | **Codex** | xhigh | `apply_patch` across many files, parallel reads |
| Migration (data / schema / format / version) | **Codex** | xhigh | spec-locked, repeatable, test-gated |
| Backend / API / pipeline plumbing (well-specified) | **Codex** | xhigh | deterministic, acceptance-testable |
| Mixed (design + mechanical bulk) | **split** | — | Claude plans/reviews; Codex implements |

Tie-breaks: frontend or ambiguity → **Claude**. High-volume mechanical with a
crisp spec → **Codex**. Validation is CROSS-FAMILY from the implementer and
ENFORCED IN CODE (`pickValidatorAgent` in `tools/ace/src/auto-validator.cts`:
claude work → codex validates, codex → claude) at xhigh.

## Effort dial (runtime-owned)

Effort and mode are enforced by the agent catalog + driver packs, not by the
prompt: claude/codex default **xhigh**, hermes **high**, and lowering below a
default requires an explicit `effortOverrideReason`. Never write `/effort`,
`ultracode`, or `/goal` into a dispatch — the runtime pack tells the worker
its mode (and explicitly forbids requesting UltraCode unless Chief asks for a
separate UltraCode lane). Your only job here is the driver pick.

## Driver packs

Driver codewords: `ace-prompt-enhancer/references/codewords.md` (doctrine);
the runtime injects the full pack from `tools/ace/src/driver-packs.cts` —
never paste pack blocks into prompts.

## Anti-patterns

- **Codex on ambiguity.** A `/goal` with no crisp acceptance line → it guesses and
  ships the wrong thing. Disambiguate (Claude/grill) FIRST, then hand Codex a spec.
- **Claude on a 200-file mechanical rename.** Throughput task; let Codex's
  `apply_patch` + `multi_tool_use.parallel` chew it.
- **Under-powering Claude** on architecture/hard-debug (don't run it below xhigh).
- **Pasting full doctrine or pack blocks** into the prompt — reference skill ids;
  the runtime injects the pack.
- **Same-family validation** — the runtime routes the validator cross-family;
  don't fight it.
- **Ignoring the split** on a mixed task — forcing one engine end-to-end against
  its grain costs more than the handoff.

## See also

- **ace-hermes-router** — Hermes' one-line driver pick.
- **ace-worker-brief-writing** — writing the tight worker brief.
- **ace-spine-driver** — pick the driver here, then drive the run on the spine there (`ace run submit`).
- **ace-internal-subagents** — how a chosen worker fans out internally (Task / dynamic-workflow, 1-level, worktree isolation).

Install targets (kept in sync; you only write `~/.claude/skills/` — the parent
propagates): `~/.claude/skills/`, `~/.codex/skills/`, `~/.hermes/skills/`.
