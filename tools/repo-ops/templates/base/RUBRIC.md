# Merge Rubric — {{project_name}}

The PR-summary bot scores every PR against this rubric and posts a one-paragraph
verdict for the owner. Hard gates (must pass to merge) are enforced by CI +
`dangerfile.js`; soft gates are advisory.

## Hard gates (block merge)
1. **CI green** — lint, type-check, and unit tests pass.
2. **Security** — `pnpm audit` (high+) and OSV-Scanner report no new HIGH/CRITICAL; no secrets in the diff.
3. **Tests for code** — non-trivial code changes include or update tests.
4. **Scope** — the diff stays within the PR's stated scope; no drive-by refactors.
5. **Conventional title** — `feat|fix|chore|docs|refactor|test(scope): …`.

## Soft gates (advisory, surfaced in the summary)
- PR is small/reviewable (< ~400 changed lines) or explains why not.
- No `console.log`/debug code left in `src/`.
- Public API changes are documented.
- Dev preview verified (`GET /health` ok) before requesting prod approval.

## Owner read
The bot's paragraph answers: **What does this PR do? · Is it safe to merge? · Does it follow the rubric?**
Approve prod only when all three are clean.
