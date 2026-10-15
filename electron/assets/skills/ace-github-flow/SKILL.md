---
name: ace-github-flow
description: Single source of truth for GitHub + project management across every repo Ace touches — branch model (Enterprise dev/prod vs Solo trunk), how agents push and open PRs, the verdict-only validator + gated merge, Cloudflare dev/prod deploy gating, conflict handling, the owner-facing one-paragraph PR rubric summary, and new-project scaffolding.
---

# Ace GitHub Flow

This is the **one** doctrine for how Ace agents and the owner manage GitHub
across all repos and every new project. It replaces the retired `ace-pr`,
`ace-validator-gate`, and `ace-project-management` skills and the old
`docs/orchestrator-github-flow.md`. Every orchestrator, worker, and validator
loads it at baseline — so any agent, pushing to any repo we set up, follows the
same rules.

## Two modes — pick per repo

| | **Enterprise** (team repos, outside developers) | **Solo** (owner's own projects) |
| --- | --- | --- |
| Branches | `dev` (freely pushable, deploys a Cloudflare preview) + `main`/`prod` (owner-approved only) | `main` trunk + short-lived feature branches |
| Who merges to prod | Only the owner, via approval gate | The owner, fast |
| Conflicts | Bot labels + auto-comments a rebase suggestion on the PR | Auto-resolved on merge to main via `git rerere` + `solo-merge` |
| Review surface | Owner reads ONE paragraph (what it does / safe to merge / rubric) | Owner self-merges; CI is the gate |
| Prod deploy | Gated by GitHub Environment required reviewer | Direct on green CI |

A repo declares its mode in `.ace/repo.json` (`{"mode":"enterprise"|"solo"}`)
written by the scaffolder. When absent, default to **solo** for personal
accounts and **enterprise** for org repos.

## Branch model & push rules (all agents, all repos)

- **Never push to `main`/`prod` directly.** Agents push only to `dev` or a
  short-lived feature branch and open a PR. The base of the PR is the repo's
  default/recorded base, never a push target.
- Branch naming: `feat/<slug>`, `fix/<slug>`, `chore/<slug>`; mission/worktree
  lanes keep their `mission-…`/`pr<n>-…` prefixes.
- Enterprise: feature branch → PR into `dev` (CI + preview) → PR `dev` → `main`
  only with owner approval. Solo: feature branch → PR into `main` (or push to a
  trunk feature branch) → fast-forward on green.
- Keep `git rerere` on everywhere: `git config --global rerere.enabled true`.

## How every agent pushes & opens a PR (the integration gateway)

Branches are created locally only; if you don't push, the work never leaves the
machine. Use the Ace integration gateway — **never hand-type `gh pr create`**
— so scope, base SHA, and the audit trail stay intact.

```bash
ace context                              # JSON: branch, baseBranch, repoRoot, worktreePath
TASK="$ACE_TASK_ID"; BR="$ACE_BRANCH"; BASE="$ACE_BASE_BRANCH"
REMOTE_BASE="${ACE_REMOTE_BASE_REF:-origin/$BASE}"
cd "$ACE_WORKTREE_PATH"

git rev-list --count "$REMOTE_BASE..HEAD"    # must be >= 1
git status --porcelain                       # commit first if dirty (focused subject, no blind git add -A)

ace --json integrate push --task "$TASK"

cat > /tmp/pr-body.md <<'EOF'
## Summary
<2–4 bullets: what changed and why, tied to the spec deliverables>

## Test plan
- [ ] <how a human verifies this>

🤖 Spawned by Ace
EOF

ace --json integrate pr-open \
  --task "$TASK" --base "$BASE" --head "$BR" \
  --title "<=70-char imperative summary" \
  --body "$(cat /tmp/pr-body.md)" \
  --allow-path "<allowed/glob/from/spec>"      # repeat per authorized path; no invented broad paths
```

Rules:
- `--draft` by default for medium/large/epic; `--ready` only for a `size_class:
  small` deterministic case with acceptance met.
- Stop and emit `BLOCKED:` with the exact reason on `scope_missing`,
  `scope_contamination`, `remote_base_unresolved`, or `base_sha_mismatch`. Do
  not fall back to raw `gh`.
- Before `pr-open`, scan `git log -p "$REMOTE_BASE..HEAD"` for secrets; if found,
  `BLOCKED: possible secret in commit <sha>` — do not rewrite history yourself.
- Capture the PR URL in the trailer:
  `DONE: shipped <one-line>. PR: https://github.com/<owner>/<repo>/pull/<n>`.
  If push succeeds but PR creation fails, still return the branch URL.

Gotchas: no push to the default branch; for private forks run `gh repo
set-default` before retrying; if submodules changed, `BLOCKED: submodule push
needs human review`.

## The merge gate

Before merge, evidence must match the exact PR/head where the implementer
emitted `DONE:` with a PR URL. Root GoalAgent validation is the first proof:
commands/tests, changed files, acceptance evidence, GitHub Actions/current-head
state when CI exists, and browser/computer-use QA when user-visible behavior is
in scope.

### Simple-First Is The Default

Independent validator/fixer/merger review is a policy or risk escalation, not
the ordinary prompt default. Use it for high-risk, cross-cutting, security,
broad regression, owner-requested validation, or when the Mission policy
requires an external gate. Any independent gate validates the root agent's exact
PR/head; child completions under that root are evidence only.

When escalated, the validator may spawn five parallel sub-validators:

1. **security-audit** — hardcoded secrets, command/SQL injection, XSS, prompt
   injection, unsafe deserialization, missing authz, PII in logs, weak crypto.
2. **bug-hunt** — logic bugs, races, off-by-one, null/undefined derefs,
   unhandled rejections, broken error paths, swallowed exceptions, regex
   catastrophic backtracking.
3. **spec-compliance** — every acceptance criterion met by real code, no scope
   creep, no partial implementation, tests present.
4. **regression-check** — features that may be silently broken, missing tests
   for the changed surface.
5. **code-quality** — lint/types/complexity, dead exports, unused deps
   (knip-style), broken docs.

### Gate rule (AND of all five)

The gate blocks merge unless ALL FIVE sub-validators return PASS. A FAIL from any
one is a FAIL overall.

### PASS-no-caveats Rule

There is no `pass-with-caveats`. Every sub-validator check is binary pass/fail.
Demote to `request-changes` or `block` when required tests/checks did not run,
acceptance is unverified, build/lint fails, or any sub-validator cannot confirm
the exercised path.

### Independent validator family when an independent gate is required

When Mission policy, risk, or owner request requires an independent validator,
prefer a cross-family review for PR, diff, and CI gate work.
Use Claude for ambiguous UI/product validation or explicit owner request. The
goal is to avoid same-model rubber-stamping without making external validation
the ordinary prompt default.

| Implementer | Preferred independent validator |
| --- | --- |
| `claude` | `codex` |
| `codex` | `claude` |
| other/unclear | `codex` |

### Validator spec requirements

Validators are VERDICT-ONLY (viewer role) and scoped to the exact PR/head —
they never fix, merge, or push. Spec includes `"role": "viewer"`,
`"roleMode": "reviewer"`, `requireChanges: false`, goal = "validate the exact
PR/head and post one verdict", deliverables = the per-criterion scorecard plus
one trailer per `tools/ace/src/verdict.cts` (plus `ValidationFailurePacket`
on non-pass), skills include `ace-validator-worker`, `ace-github-flow`,
and `autoreview`.

### ValidationFailurePacket

```json
{
  "verdict": "request-changes" | "block",
  "pr": "<pr-url>",
  "implementerFamily": "claude|codex|other",
  "validatorFamily": "claude|codex|other",
  "subValidator": "security-audit|bug-hunt|spec-compliance|regression-check|code-quality",
  "findings": [
    {
      "criterion": "<acceptance line or sub-validator check>",
      "status": "unmet|unverified|regressed",
      "evidence": "<file:line, test, or failing output>",
      "fix": "<one-line fix>"
    }
  ],
  "rerunGate": true
}
```

### Merge authority

Merge and cleanup are Ace integration-gate actions.
Do not hand-type raw `git push` or `gh pr merge` from the validator-orchestrator lane.

Emit a merge-ready packet or call the scoped Ace integration gate after PASS.
Use `integrate: { merge: true }` or `ace integrate pr-merge`
(e.g. `--task <taskId> --pr <n>`) so the audit trail and cleanup stay intact.
In the auto-chain, the release-goal worker is the SOLE merge authority via the
gated integration gateway; validators are verdict-only and never merge.

## Enterprise GitHub controls

Set up once per repo by `tools/repo-ops/bin/gh-bootstrap.mjs`; enforced by GitHub:

- **Rulesets** (native, replaces legacy branch protection) — `rulesets/dev.json`
  and `rulesets/prod.json` applied via `gh api`:
  - `dev`: require PR + at least 1 approval + required status checks; block force
    push. Developers (write role) push freely to feature branches → PR into dev.
  - `main`/`prod`: require PR + CODEOWNERS approval + **merge queue** + linear
    history + the full status-check suite (`merge_group` event). Only the owner
    (admin) bypasses.
- **`.github/CODEOWNERS`** routes required approvals to the owner for infra/core.
- **Merge queue**: `gh api` enables it on `main`; CI runs on `pull_request` AND
  `merge_group`.
- **Conflict bot**: `.github/workflows/conflict-detector.yml` labels conflicting
  PRs and auto-comments a rebase suggestion so developers fix conflicts before
  the owner ever looks.
- **Owner-facing one-paragraph review** (the only thing the owner must read):
  `.github/workflows/pr-summary.yml` runs `anthropics/claude-code-action` to post
  exactly one comment with **What it does · Safe to merge? · Rubric compliance**
  against the repo's `RUBRIC.md`. Hard rubric gates that must never merge live in
  `dangerfile.js` (tests-for-code, conventional title, size, no stray logs).
- **Prod deploy gate**: the production deploy job uses a GitHub Environment named
  `production` with a **required reviewer (the owner)**; merge to `main` does not
  reach prod until the owner approves.

## Solo flow — fast and auto-resolving

- Trunk-based: short-lived feature branches → PR into `main`, fast CI (lint +
  type-check + unit on PR; e2e + build on `merge_group`).
- **Automatic conflict resolution on merge to main**: `git rerere` is enabled and
  `tools/repo-ops/bin/solo-merge.mjs <branch>` fetches `main`, rebases the branch
  with recorded rerere resolutions reused automatically, re-runs CI, and
  fast-forwards. New conflict classes are resolved once and remembered.
- No approval gate; CI green is the merge condition. Keep it easy.

## Landing a PR yourself — owner-directed merge + CI watch

When the owner tells you to land / merge / "fix the merge" on a PR, you own it
**end to end**. Do not stop at "it's not mergeable, want me to…?" — resolve,
verify, watch, merge. A per-mission GoalAgentSpec `do not merge` line is a default
for an autonomous worker lane, **not** a ceiling over a direct owner instruction in
the same session.

1. **Bring main in & resolve.** Stash unrelated working-tree edits first
   (`git stash push <paths>`), then `git merge origin/main` (or rebase). For
   independent additions on both sides (e.g. each side appends a new tab/case),
   **keep both** — never drop one side. Reverify before committing the merge:
   focused tests + `lint` + `build`, and confirm **zero NEW** typecheck errors vs
   the pre-merge baseline (count errors on pristine `origin/main` too — worktree
   paths can contain your feature name, so anchor `grep` at `^src/...`, never a
   bare substring). Commit the merge, `git stash pop`, push.
2. **Arm the merge.** Repo is **squash-only** with `deleteBranchOnMerge: true`.
   Mark the PR ready if it is a draft (`gh pr ready <n>` — drafts can't merge),
   then `gh pr merge <n> --squash --auto`. Auto-merge respects the protect-main
   ruleset and lands the instant required checks pass, without babysitting.
3. **Watch CI event-driven, not busy-poll.** Cadence = the slowest required check
   (here `heavy` ≈ 4–5 min). Loop on `gh pr view <n> --json state,mergedAt` +
   `gh pr checks <n>` every ~45s until `state=MERGED`; bail on any `=fail`. Use
   `run_in_background` / `ScheduleWakeup` for long waits instead of blocking.
4. **Gotcha — all checks green but it won't auto-merge.** `gh pr view <n> --json
   mergeStateStatus,mergeable` shows `mergeState: BLOCKED` while `mergeable:
   MERGEABLE`. That's the protect-main **ruleset review gate**, not a failed check
   (legacy `branches/main/protection` returns nulls — rulesets don't surface
   there). If `gh api repos/<owner>/<repo>/branches/main/protection` shows
   `enforce_admins.enabled=false` **and CI is genuinely green**, the sanctioned
   resolution is `gh pr merge <n> --squash --admin`. This satisfies the review
   gate as owner-admin — it is **NOT** a bypass of failing checks. Never
   `--admin` over red/pending CI; that's the blind bypass the merge gate forbids.
5. **Merging `main` auto-fires the dev release** (release.yml → R2 dev channel →
   in-app update toast). Always call that out in the report; it is a release, not
   just a merge.

## Cloudflare dev/prod (config the scaffolder writes)

Always Cloudflare-hosted, Cloudflare stack. `.github/workflows/deploy.yml`:

- **PR → preview**: deploy to a stable per-branch Workers preview URL
  (`<branch>-<worker>.<subdomain>.workers.dev`) so developers test "dev" live.
- **main → production**: a job with `environment: production` (required reviewer)
  runs `cloudflare/wrangler-action@v4 --env production`. Steps are guarded by
  `if: ${{ secrets.CLOUDFLARE_API_TOKEN != '' }}` so the workflow is valid before
  credentials exist.
- Separate dev/prod resources: Worker envs, D1 databases, KV namespaces, R2
  buckets. Secrets via `wrangler secret` / GitHub Environment secrets, scoped to
  the env. `wrangler.jsonc` carries `env.production` routes/vars.

## Cross-project control plane (live delta)

Don't rediscover from scratch. Summarize from durable notes, then verify only the
deltas live:
- `gh pr list --repo <owner/repo> --state all --limit 30 --json number,title,state,isDraft,baseRefName,headRefName,mergedAt,url`
- `git worktree list --porcelain`
- `ace ls` for in-flight Ace streams.
After a material change (new branch policy, merged infra shift), record it.

## Scaffolding a new project

```bash
node tools/repo-ops/bin/new-project.mjs --name <name> --mode enterprise|solo [--dir <path>]
node tools/repo-ops/bin/gh-bootstrap.mjs --repo <owner/name> --mode enterprise|solo
```

`new-project` renders the best-practice Cloudflare stack and `.github/`; it enables
`git rerere`, writes `.ace/repo.json`, `RUBRIC.md`, and a README whose success
criterion is `curl https://<preview>/health → {ok:true}`. `gh-bootstrap` creates
the private repo, pushes, creates `dev`, applies the rulesets, creates the
`production` environment + required reviewer, enables merge queue, and sets
placeholder secrets.

**Default stack (free + secure only — no paid deps):** Cloudflare Workers
(+ static assets) · Hono API · D1 + Drizzle ORM · better-auth · Vite + the
Cloudflare Vite plugin · Biome · Vitest + `@cloudflare/vitest-pool-workers` ·
strict TypeScript (`@total-typescript/tsconfig`). Security gates baked in:
`pnpm --frozen-lockfile`, `npm audit --audit-level=high`, `google/osv-scanner`
(HIGH/CRITICAL), and Dependabot. Adapt the stack to the project, but stay on
Cloudflare and never add a paid or unmaintained dependency.

## See also

- `ace-validator-worker` — the validator child's working contract.
- `ace-integration` — scoped PR handoff and optional gated merge helper.
- `ace-cli` — the Ace command surface used above.
- `autoreview` — structured review evidence consumed by the gate.
- `tools/repo-ops/` — the scaffolder, bootstrap, and solo-merge implementations.
