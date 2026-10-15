---
name: knip-maintenance
description: Use knip for maintenance and pruning audits.
---

# Knip Maintenance

Use this skill when the task is explicitly about maintenance, pruning, or
reducing dead code surface area.

Run knip to find:

- Unused files
- Unused exports
- Unused dependencies
- Unused devDependencies
- Stale config entries

Canonical invocation:

```bash
npx knip
```

Interpret the output as a review queue, not a deletion list.

- Treat unused files as candidates for manual inspection.
- Check whether unused exports are public API, test helpers, or dynamic entry points.
- Confirm dependency removals against scripts, generated code, Electron packaging, and CI.
- Prefer small cleanup commits grouped by risk.

Do not run knip as a reflex during feature work.

Avoid knip-driven pruning:

- Immediately before a release cut
- When CI-only or packaging-only paths may be invisible locally
- When the repository uses dynamic imports or generated entry points you have not checked
- When you cannot review every deletion candidate

Never auto-delete from knip output without human-readable review notes.
