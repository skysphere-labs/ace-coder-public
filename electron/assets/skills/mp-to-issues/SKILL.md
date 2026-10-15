---
name: mp-to-issues
description: PRD / plan to sliced Mission Board cards (Matt Pocock "to-issues"). Break a plan, spec, or PRD into independently-grabbable tracer-bullet vertical slices, tag each AFK (safe for unattended worker handoff) or HITL (hold for owner), and post them as Mission Board cards in dependency order. Use to convert an approved PRD into buildable work.
---

# To Issues (vendored: mattpocock/skills `to-issues`)

Break a plan into independently-grabbable Mission Board cards using vertical
slices (tracer bullets). The work authority is the **Mission Board** — no external
issue tracker.

## AFK / HITL tags (Ace semantics)

Every slice is tagged:

- **AFK** — safe for a worker to implement, validate inside its root GoalAgent,
  and hand off scoped PR/check evidence without owner interaction.
- **HITL** — hold for the owner: needs an architectural decision, design review,
  or sign-off before merge. The worker may build and open a PR but must NOT
  claim merge authority; it stops at the gate for the owner.

Prefer AFK over HITL where possible. If a hard trigger applies (ambiguity,
migration, auth, new module/dependency, irreversible change), mark it HITL.

## Process

### 1. Gather context
Work from whatever is already in context. If the owner passes a Mission Board card
reference as an argument, read its full body and history first.

### 2. Explore the codebase (optional)
If not already explored, do so. Card titles and descriptions should use the
ace-ops wiki glossary vocabulary, and respect wiki ADRs in the area you touch.

### 3. Draft vertical slices
Each slice is a thin vertical slice cutting through ALL integration layers
end-to-end (schema, API, UI, tests) — NOT a horizontal slice of one layer.
- Each slice delivers a narrow but COMPLETE path through every layer.
- A completed slice is demoable or verifiable on its own.
- Prefer many thin slices over few thick ones.

### 4. Quiz the owner
Present the breakdown as a numbered list. For each slice show:
- **Title** — short descriptive name
- **Type** — AFK / HITL
- **Blocked by** — which slices (if any) must complete first
- **User stories covered** — which PRD stories this addresses

Ask: does the granularity feel right (too coarse / too fine)? Are dependencies
correct? Should any slices merge or split? Are AFK/HITL tags correct? Iterate
until the owner approves.

### 5. Post the cards to the Mission Board
For each approved slice, create a Mission Board card using the body template
below, carrying its AFK/HITL tag. Post in dependency order (blockers first) so
you can reference real card identifiers in "Blocked by".

## Card body template

**Parent** — reference to the parent card (if the source was an existing card;
otherwise omit).

**What to build** — concise description of this vertical slice. Describe the
end-to-end behavior, not layer-by-layer implementation. Avoid file paths and code
snippets (they go stale). Exception: a prototype snippet that encodes a decision
more precisely than prose (state machine, reducer, schema, type shape) may be
inlined, trimmed to the decision-rich bits, noted as from a prototype.

**Acceptance criteria**
- [ ] Criterion 1
- [ ] Criterion 2
- [ ] Criterion 3

**Blocked by** — reference to the blocking card, or "None — can start
immediately".

Do NOT close or modify any parent card.

## Handoff

End with `DONE: <N> slices posted to Mission Board (<a> AFK / <b> HITL)`. Each
AFK card is now ready for one Ace build worker to validate inside its root
GoalAgent and hand off scoped PR/check evidence; HITL cards stop at the gate for
the owner. If the owner never approves the breakdown and is AFK, emit
`BLOCKED: breakdown unapproved`.
