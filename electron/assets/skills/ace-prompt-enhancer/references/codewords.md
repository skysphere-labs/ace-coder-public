# Driver codewords — Claude vs Codex trigger packs

Source of truth for the power-keywords that make each driver do precise things
without one-shot mistakes. Used by `ace-prompt-enhancer` (to enhance the
owner's brain dump) and mirrored by `tools/ace/src/driver-packs.cts` (the
runtime pack injected into the agent doctrine). Grounded in
`docs/plans/agent-chain-best-practices.md` (Anthropic/OpenAI 2024-2025).

## The one rule: match degrees of freedom to fragility
(Anthropic agent-skills best practices — "narrow bridge vs open field".)
- **Fragile, must-be-consistent steps** (push / open PR / merge gate / release):
  give **low-freedom EXACT commands**, not heuristics.
- **Design / architecture / ambiguous debug**: give **high-freedom heuristics**
  and let the model reason. Don't over-constrain.

Inject only the codewords the task needs. Codewords are a scalpel, not decoration.

Corollary — **specify the WHAT, not the HOW**: pin the contract (goal /
acceptance / boundaries / fragile steps) and leave the approach open. Goal and
research agents reason best with an open solution space; step-by-step HOW kills
their thinking. Tight, not micromanaged.

## Claude (Claude Code — Opus 4.x / v2.1)
| Codeword / trigger | What it does | When to use |
|---|---|---|
| `think` < `think hard` < `think harder` < `ultrathink` | Escalates the extended-thinking token budget | Hard design / ambiguous debug / architecture. Use the lowest rung that fits. |
| `/effort ultracode` (max lane) | Enters true UltraCode / dynamic-workflow (parallel internal agents) | BIG tasks that decompose into independent units. `xhigh` is extra-high reasoning only — never claim UltraCode from xhigh. |
| Explicit verifiable success criteria + "self-check each before DONE" | Gives Claude a runnable stop condition (it stops at "looks done" otherwise) | Every implementation task. The single biggest reliability lever. |
| XML-tagged structure (`<context>`, `<task>`, `<constraints>`) | Sharper section parsing | Long / multi-part prompts. |
| "Be surgical — touch only what the task requires" | Suppresses scope creep | Scoped edits in a shared codebase. |
| "Read the file before you speculate; apply to EVERY relevant site" | Kills first-match-only edits | Refactors / multi-site changes. |
| `BLOCKED: <reason>` on ambiguity/scope-drift | Halts instead of guessing | Always — the escape hatch. |

## Codex (GPT-5-Codex)
| Codeword / trigger | What it does | When to use |
|---|---|---|
| `/goal` mode | Goal-driven, recursive-until-verified execution | Default for Codex build tasks. |
| "Bias to action — never end with only a plan" | Forces implement + verify, not just a plan | Every build task. Codex under-acts without it. |
| `model_reasoning_effort=xhigh` | Max Codex reasoning | ALWAYS — every Codex `/goal` runs at xhigh (no high default; Codex caps at xhigh, no `max`). |
| `apply_patch` | The structured edit tool | Every file change. |
| `multi_tool_use.parallel` | Batches independent reads/edits | Independent reads/edits; deterministic high-volume. |
| `AGENTS.md` for durable repo rules | Don't restate standing rules inline — put them in AGENTS.md | Repo-wide conventions. |
| `ExecPlan` in `.agent/PLANS.md` | Durable plan for long runs | Multi-step / long tasks; survives compaction. |
| Internal sub-processes, merge before DONE | Parallel fan-out within the one worker | Independent units (1-level nesting only). |
| `DONE: <summary>` / `BLOCKED: <reason>` | The trailer contract | Always. |

## Specialty (who gets the task — see `claude-codex-specialty-router`)
- **Claude (xhigh default; `/effort ultracode` for BIG decomposable goal-mode work):** planning, architecture, ambiguity, hard debug, orchestration, research, UI, dynamic-workflow fan-out.
- **Codex (`/goal` xhigh always):** deterministic high-volume implementation, refactor, migration, backend, mechanical/codegen.
- **Tie-break:** frontend/ambiguity → Claude; high-volume mechanical → Codex. Never same-family validation.

Packs are injected by the runtime from `tools/ace/src/driver-packs.cts` —
never paste them into prompts. This file is the doctrine mirror.
