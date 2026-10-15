---
name: mp-to-prd
description: Brain-dump / conversation context to PRD (Matt Pocock "to-prd"). Synthesize the current context into a Product Requirements Document and post it as a Mission Board card — no fresh interview. Use after mp-grill-with-docs / mp-grill-me to turn shared understanding into a PRD.
---

# To PRD (vendored: mattpocock/skills `to-prd`)

Take the current conversation context plus codebase understanding and produce a
PRD. Do NOT re-interview the owner — synthesize what you already know (the grill
already happened). Publish to the **Mission Board**, not an external issue tracker.

## Process

1. Explore the repo to understand current state (if not already done). Use the
   ace-ops wiki glossary vocabulary throughout the PRD, and respect any wiki
   ADRs in the area you are touching.

2. Sketch the major modules to build or modify. Actively look for **deep
   modules**: a deep module encapsulates a lot of functionality behind a simple,
   testable interface that rarely changes (the opposite of a shallow module).
   Confirm with the owner that the modules match expectations, and which modules
   they want tests written for.

3. Write the PRD using the template below and post it as a Mission Board card.
   Mark it ready for slicing (the next step is `mp-to-issues`). Do not publish to
   GitHub/Linear; the Mission Board is the work authority.

## PRD template

### Problem Statement
The problem the user faces, from the user's perspective.

### Solution
The solution to the problem, from the user's perspective.

### User Stories
A LONG, numbered list. Each story: `As an <actor>, I want a <feature>, so that
<benefit>`. Make this extensive — cover all aspects of the feature.

### Implementation Decisions
Modules built/modified, their interfaces, technical clarifications, architectural
decisions, schema changes, API contracts, specific interactions. Do NOT include
file paths or code snippets — they go stale fast. Exception: if a prototype
produced a snippet that encodes a decision more precisely than prose (state
machine, reducer, schema, type shape), inline the decision-rich bits and note it
came from a prototype.

### Testing Decisions
What makes a good test (test external behavior, not implementation details),
which modules will be tested, and prior art (similar tests already in the
codebase).

### Out of Scope
What is explicitly out of scope for this PRD.

### Further Notes
Anything else relevant.

## Handoff

End with `DONE: PRD posted to Mission Board — ready for mp-to-issues` (include the
card reference). Then the slicing step is `mp-to-issues`. If a required module
expectation is unresolved and the owner is AFK, emit
`BLOCKED: <one-line unresolved module/decision>`.
