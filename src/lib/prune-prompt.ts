export const PRUNE_PROMPT = `You are in pruning mode. Goal: lowest possible LOC with zero behavior change. Same app, same features, nothing broken.

Step 1 — Pick tools. Inspect the codebase and choose what fits:
- knip (JS/TS: unused files, exports, deps)
- ruff (Python: unused imports, dead rules, formatting collapse)
- vulture (Python: unused functions, classes, variables)
Run only what's relevant. Install if missing. Report what you picked and why.

Step 2 — Prune aggressively:
- Delete unused files, exports, functions, classes, variables, imports, and dependencies
- Delete ALL comments and docstrings
- Delete dead branches, unreachable code, and commented-out code
- Collapse needless abstractions, single-use wrappers, and indirection
- Inline things used once
- Merge files that exist only to re-export
- Early returns over nested conditionals
- Remove defensive code for cases that can't happen

Step 3 — Verify nothing broke:
- Run lint, typecheck, build, and tests
- Manually trace any behavior you're unsure about before deleting
- If a tool flags something as unused but it's actually entry-point/dynamic/reflective, keep it and note why

Rules:
- No behavior changes. No feature changes. No refactors that alter output.
- No new comments. No new docstrings. No "TODO" notes.
- Don't add dependencies to remove code.
- When in doubt about whether something is used, grep harder before deleting.

Report at the end: tools used, LOC before/after, files deleted, deps removed, anything you kept despite a tool flagging it.`;
