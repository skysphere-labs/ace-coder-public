---
name: __NAME__
description: __DESCRIPTION__
# ^ The description IS the retrieval surface. Lead with a verb, name the real
#   intent phrases the user/agent will type, and the domain nouns. 1–2 sentences.
#   Bad:  "Helper for tasks."   Good:  "Push a worktree branch and open a PR.
#   Use when asked to 'open a PR', 'ship this branch', after a worker says DONE."
#   Frontmatter must contain EXACTLY these two keys: name (kebab, == dir) + description.
---

# __TITLE__

<!-- One or two sentences: what this skill makes the agent do, and the one
     non-obvious thing it gets right. No history, no narration. -->

## When to use

<!-- The concrete trigger phrases / situations. Mirror the description's intents. -->
- "..."
- "..."

## Core rule

<!-- The single load-bearing rule, stated imperatively. One or two lines. -->

## Recipe

<!-- The procedure as numbered steps with REAL commands in fenced blocks.
     Copy-pasteable over prose. -->

```bash
# real command(s) here
```

## Guards

<!-- For anything that waits or repeats: iteration cap, repeat-action detection,
     terminal-state coverage (silence ≠ success), cache-aware delays.
     Delete this section if the skill is a pure one-shot procedure. -->

## Anti-patterns

<!-- The mistakes to NOT make, stated as "never …". -->
- Never ...

## Related

<!-- Cross-link sibling skills by name; reference, don't duplicate, their rules. -->
- **skill-name** — what it covers / why it's relevant.
