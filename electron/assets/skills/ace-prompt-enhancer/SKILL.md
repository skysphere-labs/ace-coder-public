---
name: ace-prompt-enhancer
description: "Lean prompt enhancement for Ace: turn the owner's raw brain dump into a compact, high-signal worker handoff. Preserve intent, pin outcome/acceptance/boundaries, leave the HOW open — workers are smart. Mode/effort/driver packs are runtime-owned and never written into prompts. Trigger on \"enhance this prompt\", \"prompt-enhance\", \"clean up my brain dump\", or before any dispatch."
metadata:
  type: ace-skill
  tier: prompting
  tags: [ace, prompting, claude, codex, hermes, brief, lean]
---

# Ace prompt enhancer — lean contract

A prompt is good when a strong worker can execute it without losing the
owner's intent. It is bad when it becomes a spec dossier that buries the
worker. The active job: messy intent → compact, high-signal handoff. The
canonical template is `ace-hermes-router`'s lean goal (≤6 lines); this skill
is the deeper doctrine behind it.

## Core principle: specify the WHAT, not the HOW

Deliver the **contract** precisely — objective, acceptance, boundaries —
then **leave the solution space open**. Agents reason best with room to
think; prescribing the step-by-step HOW produces brittle, literal work.

- **Pin** the WHAT: goal, 1-3 binary acceptance checks, allowed/never-touch
  paths when material, and the fragile contract steps (push / PR / merge
  gate / release) as exact commands.
- **Leave open** the HOW: approach, file-by-file plan, decomposition, design.
- If you find yourself writing implementation steps, stop — state the
  acceptance instead and let the agent find the path. Research lanes get the
  question + what a good answer looks like, never a search script.

## Loop

1. **INGEST** the raw dump. Preserve the real ask and tone.
2. **RESTATE** as the lean goal: outcome sentence → acceptance → boundaries →
   the 1-2 context lines the worker cannot infer from the repo.
3. **SURFACE assumptions** — anything inferred to fill a gap is labelled
   ASSUMING, never silently baked in.
4. **PICK THE DRIVER** per `claude-codex-specialty-router` (judgment → claude,
   throughput → codex, none → omit `--agent`).
5. **REFERENCE, don't inline** — skill ids and file PATHS (PRD path + a 3-line
   summary), never pasted doctrine or full documents.
6. **STOP.** Do not add sections to satisfy a template. For tiny tasks the
   whole handoff is one paragraph.

## Runtime-owned (never write these into a prompt)

- Driver packs — injected by the spine from `tools/ace/src/driver-packs.cts`.
- Mode — no `/goal`, no goal-mode framing.
- Effort — no `/effort`, no `ultracode`, no `xhigh` incantations; the catalog
  enforces defaults (claude/codex xhigh, hermes high) and rejects silent
  downgrades.

## Size discipline

Default is the ≤6-line goal. A genuinely complex lane may reach ~1,200
characters. Anything larger means the task is BIG: hand it to `ace-grill-prd`
for a PRD file and dispatch a pointer goal at the PRD path. Never push a
wall of text through `--goal`.

## Verification doctrine (lean ≠ weak)

- Code: focused tests plus relevant build/type/lint.
- UI/product: run the app and exercise the real workflow.
- API/backend: call the real endpoint or production module path.
- PR work: verify repo/base/head/diff/check state.
- DONE needs evidence appropriate to the task; BLOCKED needs the exact
  blocker. If verification cannot be performed, say so — never fake proof.

## Regular planning chat lanes — not dispatch

When the owner explicitly asks for planning/research chat (company/legal/
strategy), use the named visible lane in regular chat mode — no `ace run
submit`, no goal framing. Instruct the lane to research before drafting, ask
one owner-facing question at a time with a recommended default, and keep
legal/accounting review separate. See
`references/fable-regular-planning-lanes.md`.

## References

- `ace-hermes-router` — the manager that runs this step; canonical template.
- `claude-codex-specialty-router` — which driver gets the task.
- `ace-grill-prd` — BIG tasks: PRD file + pointer goal.
- `references/codewords.md` — background on driver strengths (the runtime
  injects the packs; do not paste them).
