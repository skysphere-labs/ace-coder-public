---
name: mp-grill-me
description: No-glossary fallback grilling (Matt Pocock "grill-me"). Interview the owner relentlessly about a plan or design until shared understanding, resolving each branch of the decision tree. Use when stress-testing a plan and no ace-ops wiki glossary exists yet, or for a quick grill before mp-grill-with-docs.
---

# Grill Me (vendored: mattpocock/skills `grill-me`)

The lightweight fallback to `mp-grill-with-docs` — same relentless interview, no
glossary/ADR machinery. Use when the wiki has no glossary for this area or the
owner wants a fast grill.

## What to do

Interview the owner relentlessly about every aspect of this plan until you reach a
shared understanding. Walk down each branch of the design tree, resolving
dependencies between decisions one-by-one. For each question, provide your
recommended answer.

Ask the questions one at a time, waiting for feedback before continuing.

If a question can be answered by exploring the codebase, explore the codebase
instead of asking.

## Discipline

- One question per turn; do not stack questions.
- Always state your recommended answer so the owner steers rather than authors.
- Probe with concrete invented scenarios to force precise boundaries.
- When code can settle a question, read the code — do not ask.

## Handoff

If the work is BIG and durable terms keep surfacing, recommend switching to
`mp-grill-with-docs` so decisions land in the ace-ops wiki. When understanding
is shared, end with `DONE: grill complete — shared understanding reached` or
`BLOCKED: <one-line unresolved decision>` if the owner must decide and is AFK.
