---
name: mp-grill-with-docs
description: Primary glossary-aware PRD-grilling session (Matt Pocock "grill-with-docs"). Interview the owner relentlessly about a plan, stress-test it against the ace-ops wiki glossary and ADRs, sharpen terminology, and update the wiki inline as decisions crystallise. Use to harden a BIG-routed brain dump before a PRD exists.
---

# Grill With Docs (vendored: mattpocock/skills `grill-with-docs`)

Run this as the grill+PRD agent's first pass on any BIG-routed work. Goal: shared
understanding before a single line of PRD or code.

## What to do

Interview the owner relentlessly about every aspect of this plan until you reach a
shared understanding. Walk down each branch of the design tree, resolving
dependencies between decisions one-by-one. For each question, provide your
recommended answer.

Ask questions one at a time, waiting for feedback on each before continuing.

If a question can be answered by exploring the codebase, explore the codebase
instead of asking.

## Domain awareness (ace-ops wiki, not a tracker)

The glossary and decision records live in the ace-ops wiki — there is no
GitHub/Linear lookup here. Before grilling, read the wiki glossary and the ADRs
for the area you are touching:

- Glossary: the ace-ops wiki `glossary` (a project- or module-scoped term list).
- Decision records: the ace-ops wiki `adr/` entries for the touched area.

Create wiki pages lazily — only when you have something to write. If no glossary
page exists, create one when the first term is resolved. If no ADR section
exists, create it when the first ADR is needed. Do NOT publish to any external
issue tracker.

## During the session

- **Challenge against the glossary.** When the owner uses a term that conflicts
  with the wiki glossary, call it out immediately: "the glossary defines
  'cancellation' as X, but you seem to mean Y — which is it?"
- **Sharpen fuzzy language.** When the owner uses vague or overloaded terms,
  propose a precise canonical term. "You're saying 'account' — Customer or User?
  Those are different things."
- **Discuss concrete scenarios.** Stress-test domain relationships with specific
  invented scenarios that probe edge cases and force precise boundaries.
- **Cross-reference with code.** When the owner states how something works, check
  whether the code agrees. Surface contradictions: "your code cancels entire
  Orders, but you just said partial cancellation is possible — which is right?"
- **Update the glossary inline.** When a term is resolved, write it to the wiki
  glossary right there. Do not batch — capture as it happens. The glossary is a
  glossary and nothing else: keep it devoid of implementation detail. It is not a
  spec, scratchpad, or decision dump.
- **Offer ADRs sparingly.** Only offer an ADR to the wiki when all three hold:
  1. Hard to reverse — meaningful cost to change later.
  2. Surprising without context — a future reader will ask "why this way?".
  3. The result of a real trade-off — genuine alternatives, picked for reasons.
  If any is missing, skip the ADR.

## Glossary format (wiki)

Keep entries tight (1-2 sentences, define what it IS not what it does), be
opinionated (pick one canonical term, list alternatives under `Avoid:`), include
only project-specific terms (skip general programming concepts), and group under
subheadings when natural clusters emerge.

```
# {Context Name}
{One or two sentence description of what this context is and why it exists.}

## Language
**Order**: A confirmed customer request for goods. Avoid: Purchase, transaction
**Invoice**: A request for payment sent after delivery. Avoid: Bill, payment request
```

## ADR format (wiki)

Sequential numbering (`0001-slug`, `0002-slug`); increment the current highest.
Minimal ADR = title + 1-3 sentences (context, decision, rationale). Add optional
Status / Considered Options / Consequences sections only when they genuinely
clarify.

## Handoff

When understanding is shared and the wiki reflects it, end by pointing the owner
to `mp-to-prd` (synthesize the PRD from this context) and emit
`DONE: grill complete — glossary/ADRs updated, ready for mp-to-prd`. If the owner
goes AFK mid-grill or a decision needs them, emit
`BLOCKED: <one-line unresolved decision>`.
