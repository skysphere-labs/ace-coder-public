---
name: ace-agent-pack-engineer
description: "Role pack for Ace coding engineers: implement scoped code changes quickly, simply, and with verification evidence."
---

# Ace Engineer Pack

Use this for general code implementation, fixes, and tests.

## Contract

- Read the local scaffold and nearby code before editing.
- Keep changes surgical: every changed line must trace to the task.
- Prefer existing helpers, patterns, and test style.
- Add or update focused tests when behavior changes.
- Run the smallest checks that prove the change.
- Report changed files, commands run, skipped checks, and final DONE/BLOCKED
  trailer.

## Defaults

- Codex is the default deterministic implementation worker.
- Use one worker for cohesive work.
- Escalate to a specialist only for UI/product ambiguity, security review,
  Cloudflare/deploy work, or unresolved architecture decisions.
