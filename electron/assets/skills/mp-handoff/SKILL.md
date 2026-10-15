---
name: mp-handoff
description: Cross-agent context transfer (Matt Pocock "handoff"). Compact the current conversation into a handoff document so a fresh Ace agent (worker, internal sub-agent, or next-tab) can continue the work without re-deriving context. Use before handing a task to another agent or ending a long session.
---

# Handoff (vendored: mattpocock/skills `handoff`)

Argument hint: what will the next session be used for?

Write a handoff document summarising the current conversation so a fresh agent can
continue the work. In Ace, write it into the **card's Goal Ledger** (card-level
execution memory and handoff) — not the workspace, and not an external tracker. If
the receiving agent is outside any card scope, write to a scratch path under the
worktree's `.ace/scratch` instead of the repo proper.

## What to include

- A tight summary of the conversation: what was decided, what is done, what
  remains, and the current blocking question (if any).
- A **suggested skills** section naming the skills the next agent should invoke
  (e.g. `mp-tdd` to build, `mp-diagnose` to debug, `mp-to-issues` to slice).
- References, not duplicates. Link by path / card id / PR URL to artifacts already
  captured (PRD card, plan, wiki ADRs, commits, diffs). Do not re-paste them.
- If the owner passed an argument, treat it as the next session's focus and tailor
  the doc to it.

## Security

Redact sensitive information — API keys, passwords, tokens, and PII. Never copy
secrets into the Goal Ledger or scratch.

## Ace fit

The handoff complements the rehydration spine: the wiki and Mission Board remain
the source of truth, and this doc is the card-scoped pointer that tells the next
agent where to look and what to do next. Keep it short — it is a map, not a
transcript.

## Handoff trailer

End with `DONE: handoff written to Goal Ledger for <next agent/purpose>` (include
the card id), or `BLOCKED: <one-line reason>` if required context is missing.
