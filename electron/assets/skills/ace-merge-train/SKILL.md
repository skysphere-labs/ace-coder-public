---
name: ace-merge-train
description: "Serialize and land a set of open PRs as one merge train: order by dependency, merge main into each branch, resolve conflicts with judgment rules, gate on CI, squash-merge with [skip ci] except the last so exactly ONE dev build fires, handle stacked PRs, close superseded PRs, delete branches, clean worktrees. Use after a BIG/HUGE mission leaves multiple lane PRs, when the owner says 'merge the open PRs', 'run the merge train', 'resolve conflicts and merge to main', or 'create a new build from the open PRs'. Owner-held ship: auto-merge only autoChain missions; otherwise present the ready train."
---

# Ace Merge Train

You are a DISPOSABLE merge-train conductor for exactly one train. Collect the
candidate PRs, land them serially against a moving main, fire exactly ONE build
at the end, and leave the repo clean: no stale branches, no zombie worktrees,
no superseded PRs left open. You resolve conflicts with judgment — never blind.

## When to use

- A BIG/HUGE goal fanned into multiple run-ledger runs whose lanes left multiple
  open PRs (you are dispatched as the final integration step).
- The owner says "merge the open PRs", "resolve conflicts between them",
  "run the merge train", "so many PRs open — how do we proceed", "create a new
  build".
- A standing PR-pressure routine found ≥N mergeable PRs piling up (propose-only).

## Core rule

**Serialize. One PR at a time against a freshly-moved main, CI green before
every merge, `[skip ci]` on every merge subject except the LAST — exactly one
dev build per train.** Merging to main auto-publishes a dev release, so the
train is a release act: the last merge is the build trigger; everything before
it must be invisible to the release pipeline.

## Ship authority (owner-held)

- AUTO-merge only PRs whose mission carries `autoChain: true`, or when the
  owner authorized this train in so many words ("merge them", "proceed") —
  that authorization covers the whole train.
- Without authority: do ALL the work (sync, resolve, CI, order) and STOP at
  merge-ready. Present the ordered train + one command to fire, end with
  `BLOCKED: train ready, awaiting owner ship`.
- NEVER `--admin` past a failing required check. Admin satisfies the
  approval-count rule on a solo repo only — red CI is an absolute stop.

## The train, step by step

1. **COLLECT + ORDER.** `gh pr list --state open --json
   number,title,headRefName,baseRefName,mergeable,isDraft`. Drop drafts. Honor
   explicit supersessions (a PR whose title says it supersedes others: merge
   it, close those after). Order: docs/infra-only → foundation code others
   depend on → independents → stacked chains in base order → LARGEST-overlap
   PR last (it gets the most careful resolution and fires the build).
2. **STACKED PRS — retarget BEFORE the base merges.** For every PR based on
   another PR's branch: `gh pr edit N --base main` BEFORE merging/deleting its
   base — deleting the base branch CLOSES the child PR; it does not retarget.
   If one closes anyway, recreate it from the still-existing head branch with
   the same title/body.
3. **PER PR — sync in a throwaway worktree.** `git fetch origin` FRESH each
   time (a stale origin/main means you resolve against the wrong base), then
   `git worktree add /tmp/train-<n> origin/<head> -b train-<n>` and
   `git merge origin/main` (merge, not rebase: force-push is blocked by repo
   rules; the squash flattens history anyway). Symlink node_modules from a
   built checkout to run tests.
4. **RESOLVE with judgment** (rules below), compile
   (`npm run build:electron-main`), run the suites the PR's files touch plus
   the loop suites (node:test files via `node --test --require tsx/cjs`,
   vitest files via `npx vitest run` — match runner to the file's imports),
   then `git push origin train-<n>:<head>`.
5. **GATE.** Background/Monitor CI wait (recipe below) — never poll a
   foreground turn. All checks green AND `mergeable: MERGEABLE` before
   merging; after every merge the NEXT PR's mergeable must leave `UNKNOWN`
   before you act on it.
6. **MERGE.** `gh pr merge N --squash --delete-branch --subject "<title> (#N)
   [skip ci]"`. LAST PR: NO `[skip ci]` — that merge fires the one
   release-dev build.
7. **SWEEP.** Close superseded PRs with a comment naming the superseder;
   `git worktree remove` every `/tmp/train-*`; delete `train-*` branches;
   confirm `gh run list --workflow release.yml` shows the build running. Do
   NOT install or relaunch anything (a relaunch kills live sessions).
8. **REPORT.** Ordered merged list, conflicts resolved per PR, build run URL,
   anything skipped and why. End with one `DONE:`/`BLOCKED:` trailer.

## Conflict-resolution judgment rules

- **NEVER `git checkout --ours <file>` on a shared file.** It takes the WHOLE
  file and silently discards every non-conflicting change main brought in
  (this once erased a dependency-gate guard mid-train). Full-file ours is for
  both-added (AA) files ONLY, where the branch version is a strict evolution
  of main's (stacked-PR squash artifacts).
- **Resolve hunk-by-hunk.** Mangled it? `git checkout -m <file>` recreates the
  markers — redo, don't guess. Marker labels vary (`HEAD/origin/main` vs
  `ours/theirs`) — match what's actually in the file.
- **Additive-vs-additive hunks → keep BOTH sides, then COMPILE.**
  Concatenation can split a statement across the boundary (dangling
  `db.prepare(`, missing closing brace) — the compiler is the check.
- **Doctrine conflicts → newest owner-approved doctrine wins the semantics;
  graft the other side's orthogonal improvements** (routing tiers won; effort
  law and prompt-enhancer steps grafted in).
- **Deliberate removals stay removed** (e.g. auto-merge-after-validator-PASS
  removed for owner-held ship). Never resurrect from the other side.
- **Newly failing tests encode the merged contract** — update expectations
  only for the other PR's deliberate design (a new gate, a new effort law);
  if a guard you KNOW exists stops firing, suspect your own resolution first.
- **Post-squash stack conflicts** (PR2 vs main after PR1 squashed): content is
  usually identical — merge main in; the surviving hunks are the branch's
  real additions.

## The CI wait (event-driven, all four guards)

```bash
# bounded, auth-tolerant, terminal-state covering
for i in $(seq 1 40); do
  out=$(gh pr checks "$PR" --repo "$REPO" 2>/dev/null)
  [ -z "$out" ] && { sleep 30; continue; }            # gh 401 hiccup ≠ failure
  echo "$out" | grep -q pending && { sleep 30; continue; }
  break
done
gh pr checks "$PR" --repo "$REPO" | awk '{print $1,$2}' # always emit final state
```

Run via `run_in_background:true` or Monitor and keep working. If the same PR
fails the same check twice after a fix, STOP and escalate — you're stuck.

## Anti-patterns

- Merging while checks are pending or mergeable is `UNKNOWN`.
- No `[skip ci]` discipline (a build per merge) — or `[skip ci]` on the LAST
  merge (no build at all).
- Deleting a stacked PR's base branch before retargeting the child.
- Rebase + force-push (repo rules reject it); use merge commits.
- Resolving against a stale `origin/main` (always fetch immediately before
  each per-PR merge).
- Declaring done while `/tmp/train-*` worktrees or superseded PRs remain.

## Loop wiring (who dispatches this, when)

- **Wave-final (primary):** when a BIG/HUGE goal fanned into N run-ledger runs
  leaves >1 open PR, a merge-train agent is dispatched as the final integration
  step after the lanes validate. The manager watches `ace run board --json`;
  the train consolidates the lane PRs. Merge authority is the spine's fail-closed
  owner-gated gate (ACE_OWNER_AUTH_TOKEN + matching --owner-token), not a bus flag.
- **Owner codeword (ad-hoc):** "run the merge train" / "merge the open PRs" —
  authority comes from the ask.
- **PR-pressure routine (optional, propose-only):** a Routine/cron counts open
  non-draft mergeable PRs; past a threshold it posts a proposed train order to
  the owner. It never ships on its own.

Driver: **Claude** (conflict resolution is judgment work — understanding both
features' intent); the CI waits are background tasks either driver can hold.

## Related

- `ace-github-flow` — branch model, gateway, and merge-gate rules underneath.
- `ace-spine-driver` — the run-ledger spine that fans a goal into the lane
  runs this train consolidates, and the fail-closed owner-gated merge.
