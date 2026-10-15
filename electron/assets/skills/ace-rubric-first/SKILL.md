---
name: ace-rubric-first
description: Use when control-plane operator lanes are about to execute complex Ace product, agentic, multi-agent, UI, Blender/MCP, legal/security, or high-drift work; requires a written rubric and durable plan/architecture anchor before implementation.
---

# Ace Rubric-First Execution

## Core rule

Before implementation, delegation, PR creation, or broad debugging on complex/high-drift work, create or update a durable rubric and plan/architecture document. Do not let worker momentum replace the success definition.

This skill is for the control-plane operator lanes as controller lanes. It prevents drift by making the mission, non-goals, acceptance tests, and blocker conditions explicit before workers start.

## When to use

Use this when any of these are true:

- The owner explicitly asks for a rubric, eval, test plan, architecture doc, or "do not drift" guardrail.
- The task involves agentic behavior, Ace-spawned workers, Claude/Codex orchestration, Blender/MCP/browser/computer use, or multi-process local automation.
- The task spans more than one subsystem or could silently turn into a different product.
- The output might be mistaken for a stronger claim than it supports, e.g. reference mesh vs editable CAD.
- The work has customer, security, legal, credential, production, or expensive-provider implications.

## Required sequence

1. Ground the request.
   - Inspect live repo/app/process state needed to define the rubric.
   - Separate confirmed facts, assumptions, risks, and blocked prerequisites.

2. Write the rubric first.
   - Save it in the target repo or workspace, usually under `.hermes/rubrics/` or `docs/**/RUBRIC.md`.
   - Include success criteria, failure criteria, test cases, scoring, and evidence requirements.

3. Write/update the plan or architecture anchor.
   - Save it under `.hermes/plans/` for session-local execution plans or `docs/architecture/` / `docs/plan/` for repo-visible doctrine.
   - Link the rubric path inside the plan and the plan path inside the rubric.

4. Only then dispatch workers or implement.
   - Every worker spec must name the rubric and plan paths.
   - Worker acceptance must map directly to rubric items.
   - Workers must end `DONE:` or `BLOCKED:` and report rubric evidence, not just implementation claims.

5. Validate against the rubric before reporting success.
   - PASS requires all must-pass criteria to be proven.
   - FAIL/BLOCKED is the correct outcome if live prerequisites are absent.
   - Do not soften a blocker into "done with caveats" when a must-pass item failed.

## Rubric shape

Use an eval-inspired structure:

```markdown
# <Mission> Rubric

## Mission anchor
- Goal:
- Non-goals:
- Source-of-truth docs:
- Target user-visible behavior:
- Forbidden claims:

## Must-pass criteria
| ID | Criterion | Grader | Evidence required | Pass threshold |
|----|-----------|--------|-------------------|----------------|
| R1 | ... | code/manual/LLM | command, screenshot, log, manifest | binary/score |

## Test cases
| ID | Scenario | Steps/input | Expected result | Failure mode caught |
|----|----------|-------------|-----------------|---------------------|

## Scoring
- `PASS`: all must-pass criteria pass with evidence.
- `FAIL`: any must-pass criterion fails.
- `BLOCKED`: prerequisite unavailable; include exact unblock step.
- Optional numeric/ordinal scoring may be used for qualitative judgement, but must have concrete anchors.

## Drift guards
- Anti-goals:
- What must not be silently substituted:
- Required user-visible proof:
- Required artifact/log proof:
```

## Anthropic eval principles to apply

- Define success criteria before testing.
- Prefer code-based grading when the property is deterministic and observable.
- Use human/manual grading for high-quality visual judgement when needed, but make the rubric concrete.
- Use LLM grading only for nuanced judgement and with explicit, empirical rubrics; ask the grader to reason first, then output a constrained score/verdict.
- Create multiple test cases from baseline examples; do not rely on a single happy path.
- Keep qualitative criteria anchored to exact observable behavior.

## Ace build-work rubric anchor

The acceptance-rubric format for build work is the PRD Behavioral Test Plan in
`ace-grill-prd`; the machine ledger is `acceptance.json`
(`ace.acceptance-ledger/v1`), materialized by the runtime at dispatch.

## Ace worker handoff requirements

Every worker spec for rubric-gated work must include:

- `Rubric: <absolute path>`
- `Plan/architecture doc: <absolute path>`
- `Must pass: <IDs>`
- `Do not implement outside this rubric without returning BLOCKED.`
- `If a prerequisite is absent, implement the blocker/probe or return BLOCKED; do not fake success.`

For validators, require a concise packet:

```text
PASS/FAIL/BLOCKED
Rubric IDs checked:
Evidence:
Blockers:
DONE: or BLOCKED:
```

## Common pitfalls

1. Writing code first, then inventing criteria that match the code.
2. Treating an implementation artifact as proof of product behavior.
3. Accepting "works locally" without screenshots/logs/commands/manifest evidence.
4. Letting a worker change the architecture because a lower-level tool was easier.
5. Spawning too many workers before the mission anchor is stable.
6. Reporting a partial prototype as if the core promise passed.

## Verification checklist

- [ ] Rubric file exists and contains must-pass criteria.
- [ ] Plan/architecture doc exists and links back to the rubric.
- [ ] Worker specs cite rubric/plan paths.
- [ ] Tests/evidence map to rubric IDs.
- [ ] Final report says PASS/FAIL/BLOCKED, not vague progress.
- [ ] Any drift from the rubric is called out before further execution.
