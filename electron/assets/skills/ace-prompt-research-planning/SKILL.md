---
name: ace-prompt-research-planning
description: Type-specific prompt enhancer for RESEARCH / PLANNING / PRD / DOCS / ANALYSIS (no-code) goals. Use after ace-prompt-enhancer classifies a request as research/planning (taskType research/prd/planning/docs/analysis) and before dispatching a Claude worker. Pins the WHAT that makes an analysis decision-grade — the precise question, what a good answer contains, scope/sources, output structure, surfaced tradeoffs — while leaving the investigation path open. Trigger on "research X", "write a PRD / plan / proposal", "investigate / analyze / compare", "should we A or B", or any no-code "figure it out and write it up" goal.
metadata:
  type: ace-skill
  tier: prompting
  tags: [ace, prompting, research, planning, prd, docs, analysis, claude]
---

# Ace research-planning prompt enhancer

The domain specialization of `ace-prompt-enhancer` for **no-code thinking**
work — research, planning, PRDs, design docs, analysis. Here a vague brief
produces a confident-but-ungrounded essay; a tight brief produces a decision.
The difference is almost entirely in pinning the *question*, what a *good answer*
contains, and the *decision it must unblock* — never a search script. Research
agents reason best with room.

Driver: **Claude** (synthesis, judgment, holding ambiguity — `claude-codex-specialty-router`
hard-routes research/PRD/planning to Claude). Effort: **xhigh**; use
UltraCode / dynamic-workflow fan-out ONLY for broad multi-source sweeps (one
agent per source/angle, synthesize).

## Pin the WHAT (research contract)
- **The question / objective**: the precise thing to answer, stated as a question
  or a single objective — not a topic ("research auth"). One sharp sentence.
- **What a GOOD answer contains**: the decision it unblocks, and the sections the
  doc must have so the reader can act. An answer that doesn't move a decision is a
  failure regardless of length.
- **Scope + sources**: what to consult (codebase paths, files, docs, the web) and
  what is explicitly OUT of scope. Bound the sweep; name the no-go areas.
- **Output format**: the doc path AND structure — problem, options, tradeoffs,
  recommendation, risks/unknowns. For a PRD: acceptance criteria with **stable
  IDs** (`A1..An`) and phasing.
- **The "don't pick silently" requirement**: surface assumptions and real
  tradeoffs; weigh ≥2 options. A silent single pick is a defect even if correct.

## Leave OPEN (the worker's method)
The investigation path, which sources to read first, the internal reasoning
method, how to structure the search. Give the question and the bar — never a
step-by-step search recipe. The "how to find out" is the worker's job.

## Acceptance (research, each a check)
- `A1` The question is **answered with EVIDENCE** — citations, links, file refs —
  not assertion. Every load-bearing claim is traceable.
- `A2` **Real tradeoffs surfaced**: ≥2 options weighed honestly, not one silent
  pick dressed up as inevitable.
- `A3` A clear **RECOMMENDATION** with rationale — the doc takes a position.
- `A4` Risks, unknowns, and assumptions are **labelled as such**, not buried.
- `A5` Output matches the **required doc structure** at the named path.
- `A6` **Artifact delivered** — the doc / PRD is committed/written at its path and
  named in the DONE trailer. NO code changes, NO code PR (this is a no-code role).

## Driver codewords (Claude)
"think harder for the synthesis" · "weigh ≥2 options, recommend one, don't pick
silently" · "cite evidence, don't assert" · "label risks/unknowns/assumptions" ·
for broad sweeps: "dynamic-workflow: one agent per source/angle, then synthesize".
End with `DONE: <recommendation + artifact path>` or `BLOCKED: <what's missing>`.

## Hard rules
- **No-code role**: NO code edits, NO code PRs, NO merges. The deliverable is the
  document/analysis only. (A6 is the artifact, not a code PR.)
- Never pick an option silently — surface tradeoffs.
- Cite evidence; do not assert. An ungrounded claim is a defect.
- Reference skill ids (`ace-grill-prd`, `mp-to-prd`, `ace-rubric-first`) — never inline their bodies.

## References
- `ace-prompt-enhancer` — the general enhancer this specializes.
- `ace-grill-prd` — the grill-then-PRD agent for high-ambiguity scoping.
- `claude-codex-specialty-router` — why research/planning routes to Claude at xhigh.
