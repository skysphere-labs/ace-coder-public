---
name: skill-cleaner
description: Audit Ace/Codex/OpenClaw skills for duplicate roots, unused skills, prompt-budget cost, and compact descriptions.
source: https://github.com/steipete/agent-scripts/blob/main/skills/skill-cleaner/SKILL.md
---

# Skill Cleaner

Use this when adding, trimming, or retiring skills. Keep skill metadata compact:
the model sees every skill name and description before it decides what to load.

## Workflow

1. Prefer the analyzer when the `agent-scripts` checkout or skill bundle is
   available:

```bash
node --experimental-strip-types skills/skill-cleaner/scripts/skill-cleaner.ts --months 3
node --experimental-strip-types skills/skill-cleaner/scripts/skill-cleaner.ts --no-logs
```

2. Read the report in this order:

- Skill budget and prompt-list pressure.
- Description candidates with long or redundant wording.
- Duplicates across Codex, plugin cache, repo, and personal roots.
- Unused candidates from recent skill mentions, `SKILL.md` reads, and logs.
- Root summary and disabled/configured roots.

3. Before editing or deleting:

- Verify the kept copy exists and is loaded.
- Preserve trigger nouns in descriptions: product, tool, action, object.
- Prefer compact descriptions over clever names.
- Keep repo-local skills only when they encode Ace policy or live
  operations.
- Do not delete ignored or untracked skill dirs without naming the destination
  or confirming they are disposable.

If the analyzer is unavailable, apply the same checklist manually with `rg`,
`find`, catalog inspection, and focused tests.
