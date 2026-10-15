---
name: session-memory-notes
description: Lightweight per-task memory hygiene for any CLI agent — scratchpad files, focused commit subjects, and the DONE trailer as the durable contract.
---

# Session Memory Notes

Driver-agnostic guidance for keeping per-task memory useful and durable. Works
under any CLI agent (Claude Code, Codex, Gemini, OpenCode, etc.). Nothing here
relies on a vendor-specific plugin or hook surface.

## Why this skill exists

Most CLI coding agents start each task with a fresh context window. Anything
worth remembering across turns — and especially across handoffs — has to live
in files the next reader can grep. Treat the worktree as your memory.

## Scratchpad — `.ace/scratch/`

Use `.ace/scratch/` inside the worktree for transient per-task notes:

- `notes.md` — running log of decisions, dead ends, things to revisit.
- `plan.md` — the step-by-step you're working from (update as it changes).
- `verify.md` — the exact commands you ran for acceptance, with results.

Rules:

- One subdirectory per task. Don't share scratch across tasks.
- `.ace/scratch/` is gitignored by Ace; do not commit it.
- Treat scratch as ephemeral — it disappears with the worktree.

## Commit subjects are memory

Every commit subject should read as a one-line answer to "what changed and why",
in present tense, ≤72 chars. Future-you (and the reviewer) reads `git log
--oneline` as the durable trail.

Good: `fix task prompt persistence paths`
Bad: `wip`, `updates`, `fix things`

If the body needs more, put it under the subject — don't expand the subject.

## DONE trailer is the contract

The orchestrator reads exactly one of:

- `DONE: <one-line summary>` — task complete; include the PR URL when applicable.
- `BLOCKED: <one-line reason>` — cannot proceed; name the blocker, no narrative.

Keep the line single, no surrounding prose, no trailing summary. The trailer is
the only piece of working memory the orchestrator can rely on after the PTY
buffer scrolls.

## What NOT to do

- Don't paste long internal monologues into the chat tab. They evaporate.
- Don't store secrets or credentials in scratch — it's still on disk.
- Don't rely on the agent's built-in memory across tasks; assume nothing carries.

## Durable knowledge

Before `DONE:`, promote anything a future agent needs out of scratch: `ace memory remember "<claim>" --category lesson|decision|fact|todo`, or `memoryCandidates[]` in completion.json. Scratch evaporates; the knowledge base persists (see `ace-memory`).
