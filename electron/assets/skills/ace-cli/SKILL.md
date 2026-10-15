---
name: ace-cli
description: Drive Ace agent tabs and orchestrate sub-agents via the ace CLI
# Injected by the Ace main process into every agent/sidecar spawn — never
# prompt for these. Declaring them here registers them with the Hermes
# env-passthrough allowlist so sandboxed execute_code/terminal children
# inherit them (the sandbox otherwise scrubs ACE_TOKEN as a secret and
# denies AF_UNIX, which is why ACE_URL + ACE_TOKEN are the working
# transport from inside a sandbox).
required_environment_variables:
  - name: ACE_SOCK
    optional: true
  - name: ACE_URL
    optional: true
  - name: ACE_TOKEN
    optional: true
  - name: ACE_USER_DATA_TAG
    optional: true
  - name: ACE_CALLER_INSTANCE_TAG
    optional: true
  - name: ACE_HOME
    optional: true
---

# Ace CLI

> Read `ace-runtime-contract` first for the compact baseline (wiki + Mission Board as rehydration spine, derived stream actionability, wake-brief deprecation, run-scoped tool proof). This skill is the `ace` command surface and worker trailer contract layered on top.

## Transport

The `ace` CLI talks to the main process over the Unix socket in `ACE_SOCK` by default, and switches to the authenticated loopback HTTP transport when `ACE_URL` + `ACE_TOKEN` are set. Sandboxed exec environments (Hermes `execute_code`/terminal) deny Unix-socket connects, so from inside a sandbox the HTTP transport is the one that works — the env vars above are already injected; just run `ace` commands normally and do not hunt for sockets or tokens on disk.

## When to use this skill

You are an agent running inside a Ace tab and need to inspect, drive, or orchestrate another agent tab in the same Ace instance. Use this skill when the user asks you to spawn a helper sub-agent, delegate a scoped task to a specialist, relay between two tabs, observe another stream, or wait for a remote turn to finish. The CLI is your only surface, and `ace describe` is the canonical reference.

## Project wiki commands

- `ace wiki dump` writes untrusted, timestamped project evidence under `.ace/wiki-dump/`; it never changes canonical pages.
- `ace wiki candidates` previews structured project update candidates extracted from dumps.
- `ace wiki nightly` is the curator promotion path from safe source-backed candidates into `.ace/wiki/`.
- `ace wiki pack --role <role>` emits compact role-specific canonical context. Use packs instead of loading the whole vault.
- `ace wiki audit` fails on dump/canon contamination, missing frontmatter/sources, raw transcript walls, failed probes without sentinel, forbidden pack pages, and stale CLI claims.

Hard rule: dumps are not truth; canonical project wiki pages are curator-owned durable truth; Mission Board/live commands remain authoritative for in-flight state. Agents may propose, but must not edit canon directly or treat external links/tweets/failed probes/self-reports as truth before capture, redaction, and curation. Operator-lane and Ace dumps stay separated until curated into shared canon.

## Validator role (orchestrators only)

If you are running as a Ace orchestrator, you are a **validator**. The control-plane
operator lanes are the standing Ace operator lanes; repo workspace orchestrators
are opt-in, and Claude is a fresh medium/large Goal Mode controller, explicit
specialist, or legacy recovery lane. You
plan, delegate, and verify — you do NOT write code, edit files, run write-side
git, or invoke agent binaries directly. Every file-touching action happens in
a child worktree you spawned via `ace task run --new-task`.

**Allowed surface (the complete list):**

- `ace task run <agent> --workspace <id> --new-task --spec /tmp/spec.json` — delegate code work.
- `ace ask|send|submit|keys|slash|ref|approve|interrupt|abort` — drive a child tab.
- `ace wait|state|screen|follow|watch|ls` — observe children.
- `ace spawn|spawn-adhoc|close|rename|relay|task chat` — lifecycle + cross-tab plumbing.
- `ace integrate push --task <taskId>` — gateway-owned branch push for a tracked task.
- `ace integrate pr-open --task <taskId> --title <title> --allow-path <path>` — open a draft PR only after remote-base and allowed-path preflight.
- `ace integrate gate --task <taskId> --pr <n>` — read-only PR gate evidence before validation/merge decisions.
- `ace integrate pr-merge --task <taskId> --pr <n> [--auto|--admin --admin-reason <reason>]` — controller-owned merge through Ace's integration gateway after control-plane operator validation and branch-policy reconciliation.
- `ace composer clear <stream>` — clear a stuck prompt composer without submitting duplicate text.
- `ace smoke fast-lifecycle --workspace <id> [--no-code]` — verify the fast control-plane path for small/no-code lifecycle decisions.
- Read-only shell: `ls`, `cat`, `rg`/`grep`, `find`, `pwd`, `git status`, `git log`, `git diff`, `git branch --list`, `gh pr view`, `gh run view`.

**Forbidden — delegate these to a child via `task run --new-task`:**

- Invoking agent binaries directly (`claude`, `codex`, `hermes`, `gemini`, `cursor`, `aider`, `cline`, …). No bare-CLI chats.
- Editing files (`vim`, `nano`, `code`, heredoc writes, `sed -i`, `awk -i`, `>`/`>>` that mutates source).
- Write-side git: `commit`, `push`, `pull`, `merge`, `rebase`, `reset`, `checkout <branch|file>`, `restore`, `stash pop`, `clean`, `tag`, `am`, `cherry-pick`. Validated PR merge must use `ace integrate pr-merge`, not raw `git`/`gh`.
- Package/build mutations: `npm|pnpm|yarn install|add|run build|publish`, `pip install`, `cargo build|add`, `go get`, `brew install`, `make`, lockfile edits.
- Destructive filesystem ops: `rm -rf`, `mv` of tracked files, `chmod`/`chown` on repo files.

## Remote-base and scope contract

Multiple Ace worktrees are normal; do not treat them as dirty-state
blockers. Root untracked `.agent/` and `.clawpatch/` files are cleanup noise,
not base correctness blockers. Mission worker branches must come from the
recorded remote base ref/SHA when one exists, not from a stale or locally
diverged `main`. `ace workspace base-branch --workspace <id> --set
origin/main` is valid; `--clear` and `--unset` remove a stale preferred base.

PR open and merge gate are base/scope gates, not CI-status shortcuts.
`integrate pr-open` must pass remote-base and allowed-path preflight before
GitHub PR creation. `integrate gate` must still reject `scope_missing`,
`scope_contamination`, `base_sha_mismatch`, and draft PRs even when CI is
green. CI green is never scope proof.

`tool batch --run <runId>` is valid only when the installed manifest says so:
verify with `ace --json describe "tool batch"`. Prefer run-scoped
tool proof for Mission dispatch/sync/validate/gate:
`ace tool batch --run <runId> ...` followed by
`ace tool audit --run <runId> ...`.

**Examples.**

Wrong — orchestrator edits directly:

```bash
# BAD: orchestrator patches the file itself
sed -i '' 's/foo/bar/g' src/app.ts && git commit -am "rename foo"
```

Right — orchestrator writes a spec and delegates:

```bash
cat > /tmp/spec.json <<'JSON'
{
  "goal": "Rename foo → bar across src/",
  "constraints": ["surgical change", "no unrelated refactors"],
  "deliverables": ["updated src/**/*.ts", "push branch + open draft PR per ace-github-flow skill"],
  "acceptance": ["rg '\\bfoo\\b' src/ returns zero matches", "npm run lint passes"]
}
JSON
ace task run codex --workspace "$ACE_WORKSPACE_ID" --new-task --spec /tmp/spec.json
```

Wrong — orchestrator shells out to a bare agent:

```bash
# BAD: no Ace framing, no worktree isolation, no DONE/BLOCKED trailer
claude "please refactor auth.ts"
```

Right — same work, inside Ace:

```bash
ace task run codex --workspace "$ACE_WORKSPACE_ID" --new-task \
  --goal "Refactor src/auth.ts: extract token verification into its own module" \
  --acceptance "existing tests pass" --acceptance "no behaviour change"
```

Wrong — orchestrator commits directly:

```bash
# BAD: orchestrators never run write-side git
git checkout -b fix/typo && git commit -am "fix typo" && git push
```

Right — delegate even the tiny change so the PR trail is consistent:

```bash
ace task run codex --workspace "$ACE_WORKSPACE_ID" --new-task \
  --goal "Fix typo in README.md: 'recieve' → 'receive'" \
  --deliverable "push branch + open draft PR per ace-github-flow skill"
```

If you catch yourself about to run a forbidden command, STOP and write a `task run` spec instead.

Mission implementation specs must include concrete allowed edit paths in
`scope.paths`, `scope.allow`, `allowPaths`, or linked Mission `sourceFiles`.
If the allowed paths are missing, fix the spec before spawning. Mission
PR links must sync the worker completion inbox before validation. A linked PR
for an in-progress worker is not review-ready until Mission records DONE or
BLOCKED. Mission validation with linked PR + exact head SHA is VERDICT-ONLY:
it reviews the exact PR/head, cannot edit or push commits, and may emit
same-worker fixback packets. Validators never merge — the release-goal worker
is the sole merge authority via the gated integration gateway after the
evidence gate passes.

## Right-sizing delegations

One child = one coherent PR. Prefer **one well-scoped child** over three narrow ones. Bundle specs that touch overlapping files, belong to the same feature, or would be reviewed together. Split only when branches are truly independent — different subsystem, no shared files, reviewable in isolation.

Three worked examples:

**1. Two endpoints that share a middleware → one spec.**

```json
{
  "goal": "Add GET /api/users/me and GET /api/users/:id, both behind the existing auth middleware",
  "deliverables": [
    "src/routes/users.ts: two new handlers",
    "src/routes/users.test.ts: cover both endpoints",
    "push branch + open draft PR per ace-github-flow skill"
  ]
}
```

Both handlers live in the same file, share the same middleware wiring, and review naturally as one diff. One child.

**2. Backend API + unrelated UI polish → two specs.**

A new `/api/reports` endpoint and a fix to `<NavDropdown>` spacing have no shared files and no review-coupling. Spawn two independent children with labels like `reports-feat` and `nav-ui`. Their PRs can land in either order.

**3. "Add feature X" + "tidy the nearby imports you noticed" → one spec, tidy inside the same child.**

If the orchestrator spotted unused imports in the file the child will already be editing, put it in the spec as a small additional deliverable. Don't spawn a separate `cleanup-refactor` child — that's two PRs for one coherent change.

```json
{
  "goal": "Add the streaming response path to src/api/chat.ts",
  "deliverables": [
    "src/api/chat.ts: streaming handler",
    "while in chat.ts, drop the three unused imports (readFileSync, path, assert)",
    "push branch + open draft PR per ace-github-flow skill"
  ]
}
```

The test: every changed line in the child's PR should trace to the one goal. If the goal needs an `and` that joins unrelated subsystems, split. If the goal is "feature X, done cleanly" and the tidy is in the same file, bundle.

## Research lanes

Cheap local exploration still belongs in the controller tab: use `rg`, `cat`,
`git log`, and `gh pr view`, then fold findings into the next code spec's
`context` field.

When the work depends on external/current research, broad repo archaeology, or
an unresolved product/architecture question, spawn a visible no-code research
lane with `roleMode: "no-code"` and `requireChanges: false`. The research lane
reports findings, sources, and open questions back to Hermes/user or the Claude
controller before implementation continues.

Rich example — orchestrator has already explored and is now delegating one code change:

```json
{
  "goal": "Add rate limiting to POST /api/auth/login (5 attempts / 15 min / IP)",
  "context": [
    "Existing middleware pattern in src/middleware/auth.ts:12-48 (excerpt below):",
    "  export function requireAuth(req, res, next) {",
    "    const token = req.headers.authorization?.split(' ')[1];",
    "    if (!token) return res.status(401).json({error: 'no token'});",
    "    ...",
    "  }",
    "",
    "Current login handler in src/routes/auth.ts:",
    "  router.post('/login', validateBody(LoginSchema), async (req, res) => { ... })",
    "",
    "Prior discussion on rate-limit library choice landed here: https://github.com/org/repo/pull/812 — we standardized on `express-rate-limit` in that PR. Use the same package; do not introduce a second one.",
    "",
    "Constraint I discovered while exploring: the auth tests in src/routes/auth.test.ts mock time with `vi.useFakeTimers()`. Any rate-limit window logic must be compatible with that mock (express-rate-limit's `Date.now` path is fine; don't use `process.hrtime`)."
  ],
  "constraints": ["use express-rate-limit (already in package.json)", "keep error shape consistent with existing 401 handler"],
  "deliverables": [
    "src/middleware/rateLimit.ts: new middleware following the requireAuth pattern",
    "src/routes/auth.ts: wire the limiter onto POST /login",
    "src/routes/auth.test.ts: add a test that exercises the 6th attempt -> 429",
    "push branch + open draft PR per ace-github-flow skill"
  ],
  "acceptance": ["npm run lint passes", "npm run build passes", "new test passes locally"]
}
```

Everything the implementation child needs is in `context`.

**Anti-pattern — do not do this:**

```
Child 1 (label: research-rate-limit): "Investigate rate-limit libraries and summarize."
  → returns DONE with a summary, no code, no PR.
Child 2 (label: implement-rate-limit): "Implement rate limiting on /login."
  → has to re-explore anyway because it didn't see child 1's context.
```

Two tabs, one PR, duplicated exploration, and the first child produced no useful
new information. Collapse it: controller explores, pastes findings into context,
and spawns one child that ships the PR. Use a research lane only when it will
answer a real dependency the controller cannot cheaply settle.

If a child needs to re-verify something mid-task, it can `rg`/`cat` inside its own worktree before editing. That's in-task exploration, not a separate research delegation.

## Branch naming

When you call `task run --new-task --label <label>`, Ace uses `<label>` to name the git branch. Pick it as `<slug>-<type>`:

- `<slug>` — short kebab-case scope of the feature/bug (e.g. `smoke`, `weebee`, `social-login`, `auth`, `dashboard`). Lowercase. No spaces.
- `<type>` — one of:
  - `feat` — new feature / capability
  - `bug` — bugfix
  - `ui` — UI polish, styling, layout
  - `refactor` — internal restructure, no behavior change
  - `review` — review-only pass
  - `ops` — infra, CI, tooling, deploy
  - `update` — dependency bumps, copy/content updates, non-feature changes

Examples: `smoke-ui`, `weebee-feat`, `social-update`, `auth-bug`, `dashboard-refactor`, `ci-ops`, `readme-update`.

Ace auto-adds a `-2`, `-3`, ... collision suffix if the same label is reused in the workspace — you don't need to manage uniqueness yourself. Just pick the right slug and type; Ace handles the rest.

## Baseline skills bundle

Ace pre-installs baseline skills at `$HERMES_HOME/skills/<id>/SKILL.md` on every orchestrator, and auto-syncs the lane-appropriate baseline into every spawned child's agent config dir. You do NOT need to list them in the spec `skills` array unless you want to emphasize one.

- `ace-cli`       — this skill: the CLI + MCP surface + DONE/BLOCKED trailer contract.
- `ace-runtime-contract` — autonomous escalation, routing, validator, merge, reporting, and rehydration policy.
- `ace-github-flow`        — how a sub-agent pushes its worktree branch and opens a draft PR before DONE.

## Self-discovery — START HERE

Always run `describe` once at the start of a session before relying on this doc. The registry baked into the binary is the source of truth; this skill is hand-curated guidance on top of it.

## Fast validation lifecycle

Before dispatching validators, fixbacks, release goals, or merges, ask the live
policy:

```bash
ace --json mission next --feature <featureId>
```

Use the returned `riskClass`, `independentValidatorRequired`,
`clawpatchRequired`, `currentHeadSha`, `validatedHeadSha`, and
`validationBypass` instead of guessing from chat history. Ordinary review stays
in the original worker lane and is completed by native review, ReviewBot, and
`/codex review` — and the CONTROLLER closes that loop contractually: after the
PR exists it marks a draft ready and requests the ready-head ReviewBot +
`/codex review` once per exact head (`review.requested`); draft, pending,
skipped, stale, and failed review states are all non-terminal. Ordinary
findings (failing ReviewBot `validate` check, failing CI, validator
request-changes) return automatically INTO the original worker stream as a
same-stream fixback round — never via Hermes/operator forwarding, never as a
new lane or card — bounded by the fixback retry cap (3), past which the run
blocks as a bounded blocker. Every push invalidates prior evidence and repeats
the exact-head review until it passes. A standalone independent validator is
never auto-dispatched; it remains available only when the owner requests and
attaches it deliberately. Medium/high risk may still require Clawpatch or
computer-use evidence. These are hard release gates, not labels: worker `DONE`
stays on the read-only gate until current-head native review and ReviewBot PASS
are present; medium/high also need a clean current-head Clawpatch artifact, and
high-risk UI/browser work needs verified exact-head computer-use evidence.
Production merges stay owner-gated (owner token / autoship policy) regardless.

For an explicit owner-requested independent validation, pin it to the PR head:

```bash
ace --json mission validate --feature <featureId> --head <currentHeadSha>
```

If `mission next` reports stale validation evidence, rerun with:

```bash
ace --json mission validate --feature <featureId> --head <currentHeadSha> --replace-stale-validator
```

If prompt delivery fails, use `composer clear` and re-enter the flow from
`mission next`; do not mark the card as validating from stream creation alone.
Run `validation clawpatch --required` only when policy or the spec requires it.
For merge, use `integrate pr-merge`; if branch protection rejects a normal
merge, retry with `--auto`, or use `--admin --admin-reason <reason>` only for an
explicit policy-approved bypass.

```bash
ace describe                 # full machine-readable manifest (one-line JSON)
ace describe ls              # one command's schema, flags, exit codes
ace describe --markdown      # human-readable rendering of the entire surface
ace <cmd> --help             # per-command help (also lifted from the registry)
```

If anything in this skill ever conflicts with `describe` output, trust `describe`.

## Know where you are — READ THIS FIRST

Ace injects your context into every PTY it spawns. Before doing anything else, read it:

```bash
ace context                       # JSON: {workspaceId, taskId, worktreePath, branch, baseBranch, repoRoot, ...}
echo "$ACE_WORKSPACE_ID"              # same info available as env vars
echo "$ACE_WORKTREE_PATH"             # your dedicated worktree (when delegated via --new-task)
echo "$ACE_BRANCH / $ACE_BASE_BRANCH"
echo "$ACE_REPO_ROOT"
```

Available env vars (always set when present): `ACE_STREAM_ID`, `ACE_WORKSPACE_ID`, `ACE_WORKSPACE_NAME`, `ACE_TASK_ID`, `ACE_CONVERSATION_ID`, `ACE_AGENT`, `ACE_WORKTREE_PATH`, `ACE_BRANCH`, `ACE_BASE_BRANCH`, `ACE_REPO_ROOT`, `ACE_IS_REMOTE`.

**Rules that follow from this:**
- Your `cwd` is already set to your worktree/workspace. Don't `cd` to a guessed path — trust `pwd`.
- When delegated via `task run --new-task`, you own the worktree at `$ACE_WORKTREE_PATH`; commits there don't collide with the orchestrator's branch.
- When Ace asks "which repo/branch am I on?" run `ace context`; do not infer from `git remote -v` alone.
- Stay inside `$ACE_WORKSPACE_ID` — orchestrators are scope-restricted to their workspace; don't touch siblings.

## Quick orientation

- Binary `ace` lives on `PATH` (Ace installs it to `~/.local/bin/ace`). `ace` is the only CLI name.
- Local Unix socket is auto-discovered via `ACE_SOCK` / `ACE_USER_DATA_TAG` / `XDG_RUNTIME_DIR`. No flags needed in normal use.
- Remote HTTP transport: set `ACE_URL` + `ACE_TOKEN`.
- Pass `--json` for guaranteed JSON envelopes on stdout: `{ok:true,data:{...}}` on success, `{ok:false,code,error,message}` on stderr.
- Per-command help: `ace <cmd> --help`.
- Client-enforced timeout: default 60s per command. Override with `--timeout <ms>` on commands that accept it, or set `ACE_TIMEOUT_MS` globally.

### Exit codes (lifted from registry `EXIT_CODES`)

| code | meaning |
| ---- | ------- |
| 0 | ok |
| 2 | arg-error (missing/invalid flag) |
| 3 | transport-error (socket unreachable) |
| 4 | timeout (client deadline hit) |
| 5 | server-error (backend returned `{ok:false}`) |
| 6 | not-found (streamId/taskId/workspaceId unknown) |
| 7 | conflict (e.g. spawn-adhoc dedup hit) |

## Discover streams

```bash
ace ls
ace --json ls | jq '.data.streams[].streamId'
```

`ls` returns `streams: [{streamId, agent, state, taskId, workspaceId, label}]`. `streamId` is the handle every other command takes.

```bash
ace state conversation:abc                       # current state JSON
ace screen conversation:abc                      # full ANSI screen
ace --json screen conversation:abc --tail 50     # last 50 lines, JSON
ace follow conversation:abc                      # text since last follow
ace --json follow conversation:abc               # same, JSON-wrapped
ace watch --event state,ready                    # NDJSON event stream
ace watch --id conversation:abc                  # filter to one stream
```

`screen` and `follow` print raw ANSI by default (so a human tailing in a terminal still sees colors). Pass `--json` to get `{ok:true,data:{text,lines}}` you can `jq` into.

## Drive a tab

```bash
ace ask conversation:abc "What did you change?"          # send + wait for turn-complete
ace send conversation:abc "hello" --mode type            # send without waiting
ace submit conversation:abc                              # press Enter on composer
ace keys conversation:abc Enter                          # named key
ace keys conversation:abc Down --repeat 5                # cursor down 5x
ace slash conversation:abc clear                         # /clear (no leading slash)
ace ref conversation:abc src/index.ts                    # @-mention a file in the composer
ace approve conversation:abc                             # answer "yes" to a prompt (default)
ace approve conversation:abc --no                        # answer "no"
ace interrupt conversation:abc                           # Ctrl+C-style interrupt
ace abort conversation:abc                               # Esc / Ctrl+C per agent profile
```

`send --mode` choices: `paste` (fast), `type` (visible to the human), `keys` (special keys). `ask` returns `{ok, endState, elapsedMs, newOutput}`.

## Lifecycle

```bash
ace spawn claude --task tsk_42                                     # spawn into existing task
ace spawn-adhoc claude --workspace prj_42 --label scratch          # new lightweight thread task
ace close conversation:abc                                         # kill PTY, keep DB row
ace rename conversation:abc "review pass"                          # relabel tab
```

`spawn` requires `--task`. `spawn-adhoc` requires `--workspace`. Both accept `--kind cli|chat` (default `cli`). Both return `{streamId, conversationId, ...}`.

## Wait for state

```bash
ace wait conversation:abc --turn-complete --timeout 60000          # block ≤60s for turn end
ace wait conversation:abc --awaiting-input --timeout 30000
ace wait conversation:abc --awaiting-approval --timeout 30000
ace wait conversation:abc --state busy --timeout 5000
ace wait conversation:abc --pattern "Y/n" --timeout 10000          # regex match on screen
ace wait conversation:abc --quiet-for 2000 --timeout 30000         # screen idle 2s
```

Real state names from the codebase: `booting | awaiting-input | busy | turn-complete | awaiting-approval | interrupted | error`.

Returns `{matched, elapsedMs}`. Exit 4 on timeout.

## Orchestrate sub-agents

### `task run` — fire a framed task at a worker, wait for DONE/BLOCKED, optionally loop

```bash
# Feature delegation: new branch + worktree, worker lands in it (USE THIS FOR CODE WORK)
ace task run codex --workspace prj_42 --new-task --goal "Add a hello route"

# Reuse an existing stream and loop up to 5 rounds
ace task run codex --stream conversation:abc --spec /tmp/spec.json --max-rounds 5

# Overnight mode: no arbitrary round cap; still stops on DONE/BLOCKED/approval/timeout/interrupt
ace task run codex --stream conversation:abc --spec /tmp/spec.json --max-rounds 0

# Explicit Claude specialist aside (no worktree) — side-conversation that won't touch code
ace task run claude --workspace prj_42 --goal "Explain the UI bug"
```

**`--new-task` is the correct choice for every real code delegation.** It creates a fresh task (with its own git worktree + branch named `ace/<slug>-<rand>`) and lands the spawned agent inside it. The child's commits don't collide with yours or a sibling's. Omit `--new-task` only for chat-only asides that will never write files.

Flags (lifted from registry):

- `--workspace <id>` — required for new spawns (NOT `--workspaceId`).
- `--new-task` — with `--workspace`: create a real task + worktree + branch and spawn into it. Required for feature/bugfix delegations.
- `--task <id>` — spawn into existing task instead. (Conflicts with `--new-task`.)
- `--stream <id>` — attach to an existing stream instead. (Conflicts with `--new-task`.)
- `--spec <path>` — JSON spec file with `{goal, context, constraints[], deliverables[], acceptance[], requireChanges?}`.
- `--goal <text>` — inline goal (alternative to `--spec`).
- `--context <text>` / `--constraint <text>` (repeatable) / `--deliverable <text>` (repeatable) / `--acceptance <text>` (repeatable).
- `--escape-hatch <text>` — override default DONE/BLOCKED trailer instructions.
- `--max-rounds <n>` — retry loops if worker stops without trailer (default 3). Use `0` for unbounded long-run mode.
- `--require-changes auto|true|false` — gate DONE on real file changes in the worktree (default `auto`: infer from spec).
- `--max-verify-rounds <n>` — how many times to re-ask the worker when their DONE produces no diff (default 3).
- `--mode paste|type` — delivery mode. **Default `paste`** for speed. Use `--mode type` only when visible keystrokes matter more than speed.
- `--fire-and-forget` — send and return immediately; do not wait.
- `--timeout <ms>` — per-round wait timeout.
- `--label <text>` / `--kind cli|chat` (default `cli`) — for new spawns.

Output shape (success): `{streamId, conversationId, taskId, worktreePath, branch, baseBranch, baseHygiene, outcome, detail, rounds, verifyRounds, roundDetails, verify, lastAssistantText, fireAndForget, created}` where `outcome` is one of `done | done-unverified | blocked | awaiting-approval | max-rounds | dispatched | timeout | error`.

**Browser automation opt-in.** Do not make browser automation a baseline worker
default. For a browser task, use `task run --new-task` with a spec that
explicitly lists `"skills": ["playwright", ...]` and browser-specific
acceptance checks. If the worker cannot access the requested browser tool, it
must return `BLOCKED:` instead of starting a hidden runtime.

### Goal mode

`--goal-mode auto|on|off` controls native `/goal <objective>` goal-mode setup.
`/goal` is the native goal-mode trigger on BOTH drivers — Codex and Claude.

- `auto`: queue a TaskSpec-derived persistent objective for Codex code/UI work,
  including small work that still has real acceptance criteria, and for
  medium/large specs.
- `on`: always queue a TaskSpec-derived persistent objective (either driver).
- `off`: never queue `/goal`.

The queued objective is compact: goal, hard constraints, completion criteria,
evidence requirement, and round/verification budget. Bare `/goal` is status
inspection only and is not enough to create the thread goal.

Driver difference (delivery, not support): Codex's `/goal` is a setup prelude
followed by the framed brief. Claude's `/goal` AUTO-STARTS the worker, so on
fire-and-forget dispatch the rich `/goal` IS the whole delivery, typed after
the `/effort ultracode` prelude. The spine launches every Claude worker this
way (xhigh + UltraCode + goal mode on) from one `run submit` — no follow-up
mode commands.

### Mission-board loop commands

Prefer native Mission cards over loose parallel tabs:

```bash
ace mission create --workspace prj_42 --name "Launch slice" --feature "API::Ship backend contract"
ace mission ready --workspace prj_42
ace --json mission next --workspace prj_42 --feature ft_1
ace mission dispatch --workspace prj_42 --feature ft_1 --agent codex --wave msn_1 --lane ft_1
ace mission sync --workspace prj_42 --feature ft_1
ace mission validate --workspace prj_42 --feature ft_1 --agent codex --wave msn_1 --expected-lane ft_1
ace mission gate --workspace prj_42 --feature ft_1
ace --json mission record-cleanup --feature ft_1 --worktree-removed --branch-removed --remote-branch-removed --merged-sha <sha>
```

Hermes intake/router and workspace controllers MUST consult `mission next` before deciding what to dispatch. It wraps `tools/ace/src/orchestration-policy.cts#nextActionForFeature` over live Mission/PR state and returns `{ next, reason, requiredEvidence }`. Possible `next` values: `dispatch_goal_worker`, `sync_worker`, `dispatch_goal_validator`, `dispatch_fixback_worker`, `gate`, `dispatch_release_goal`, `blocked`, `nothing`.

Mission dispatch, sync, validate, and gate are hard-gated by tool audit. Before dispatch, produce start/dispatch proof with `tool heartbeat`, `tool manifest`, `context`, `mission board`, and `ls`/`state`/`screen`, then audit it. Before sync, validate, and gate, run the relevant Mission/task read commands and `ace tool audit --role orchestrator --phase <sync|validate|gate> --workspace <workspace_id>`. Missing proof blocks with the exact missing event groups.

For file-backed project harness runs, use the local validator loop:

```bash
ace task result --run run_1 --project-dir /repo
ace task validate --run run_1 --feature project.harness.initialized --project-dir /repo
```

`task validate` writes `.ace/run/<runId>/validation.json`, marks the
feature only as validator/evaluator, and emits `feature.failed`/`feature.passed`.
The simple-first scaffold disables legacy auto-fixback/memory triggers by
default; Hermes reviews feature-pass wiki/status updates.

**Verification before accepting DONE.** When the task has a worktree and the spec implies code output, `task run` does not trust the worker's first `DONE:`. It runs `git diff base..HEAD` + staged + unstaged in the worktree; if all are empty it re-asks the worker with concrete feedback, up to `--max-verify-rounds` times. If the worker emits `DONE: no-code <reason>` that's accepted as a legitimate research-task completion. For tasks you know are pure research, set `"requireChanges": false` in the spec or pass `--require-changes false`. If rounds exhaust with no changes, the outcome is `done-unverified`.

### `task chat` — scripted multi-turn chat

```bash
ace task chat claude --stream conversation:abc --script /tmp/chat.json
```

Script is a JSON array of `{text, stopOn?, timeoutMs?, mode?}` steps. Same workspace/task/stream/label/kind/mode flags as `task run`. Returns `{streamId, turns, created}`.

### `relay` — ping-pong between two streams

```bash
ace relay conversation:a conversation:b --max-rounds 6
ace relay conversation:a conversation:b --seed "kick off review" --stop-on "DONE:"
```

Reads last turn of A, sends to B, waits, reverses. Stops on DONE/BLOCKED, `--stop-on <regex>`, or `--max-rounds` (default 8, `0` for unbounded). Flags: `--max-rounds`, `--stop-on`, `--seed`, `--mode paste|type` (default `type`). Returns `{rounds, roundDetails, stopReason, lastSource, lastTarget}`.

## Recording & snapshots

```bash
ace record conversation:abc /tmp/sess.ndjson      # NDJSON of PTY frames
ace record-stop conversation:abc
ace replay /tmp/sess.ndjson --agent claude        # replay into a fresh stream
ace snapshot conversation:abc                     # save .ansi + .txt under $TMPDIR/ace-snapshots
```

## Profile management

```bash
ace profiles                                      # list loaded agent profiles
ace reload                                        # hot-reload profile JSON from disk
```

## Trailer contract (CRITICAL)

A delegated sub-agent MUST end every turn with exactly one of:

- `DONE: <one-line summary>` — task complete.
- `BLOCKED: <one-line reason>` — cannot proceed.

`task run` parses the final screen for these trailers. `DONE` resolves the call as `outcome: "done"`. `BLOCKED` returns `outcome: "blocked"` with the reason in `detail`. Without either, the orchestrator loops up to `--max-rounds` (default 3; `0` means no arbitrary cap) feeding the prior round's tail summary back in. If a bounded worker still hasn't produced a trailer after the last round, `outcome: "max-rounds"`.

When you write a sub-agent prompt (via `--goal` or `--spec`), include explicit instructions to end with one of those exact prefixes. The default escape-hatch text already does this; only override with `--escape-hatch` if you have a reason.

## Parallel sub-agents (handoff to specialists)

Workspace_id is the unit of "specialist scope" (the OpenAI Agents SDK "specialist ownership" pattern — orchestrators are restricted to their own workspace). Fan out N adhoc threads, then join.

```bash
# 1. Fan out — fire-and-forget into three different workspaces (or three labels in one workspace)
A=$(ace task run claude --workspace prj_frontend --fire-and-forget \
      --label "spec: nav" --goal "Audit Nav.tsx for a11y issues" --json | jq -r '.data.streamId')
B=$(ace task run codex  --workspace prj_backend  --fire-and-forget \
      --label "spec: api"  --goal "Audit /api/users for input validation" --json | jq -r '.data.streamId')
C=$(ace task run codex  --workspace prj_infra    --fire-and-forget \
      --label "spec: ci"   --goal "Audit .github/workflows for cache misses" --json | jq -r '.data.streamId')

# 2. Wait for each to finish
for s in "$A" "$B" "$C"; do
  ace wait "$s" --turn-complete --timeout 600000 --json >/dev/null
done

# 3. Collect results
for s in "$A" "$B" "$C"; do
  echo "=== $s ==="
  ace screen "$s" --tail 200 --json | jq -r '.data.text'
done
```

For one-off blocking delegation (no fan-out), just call `task run` without `--fire-and-forget` and read the structured result.

## Gotchas

- **Type vs paste mode.** `task run` defaults to `--mode paste` so workers start fast. `task chat` and `relay` still default to `type` for human-visible scripted turns. Use `--mode type` on `task run` only when visible keystrokes matter more than speed.
- **`--fire-and-forget` returns immediately** with `{outcome: "dispatched"}`. Use only when you don't need to wait for DONE/BLOCKED. Pair with `wait --turn-complete` later if you need to join.
- **Approvals BLOCK the sub-agent's PTY.** If a sub-agent hits `awaiting-approval`, it sits there until you act. Detect with `wait --awaiting-approval` (or `state`), then `ace approve <streamId>` (defaults to yes) or `--no`.
- **Workspace scoping is sticky.** `spawn-adhoc --workspace X` binds the new stream to workspace X. Don't reuse another workspace's id by accident — orchestrators are restricted to their own `workspace_id`.
- **Timeouts are client-enforced.** Default 60s per command. Override with `--timeout <ms>` (where supported) or `ACE_TIMEOUT_MS` env var. On timeout you get exit 4 + a structured error envelope on stderr.
- **Single-line JSON.** Every `--json` envelope is one line — pipe directly into `jq` without `-s`.
- **No `--flag=value` reliance.** The parser supports both `--flag value` and `--flag=value`, but if you ever hit weird parsing, prefer `--flag value` (space-separated).
- **`spawn` vs `spawn-adhoc`.** `spawn` needs an existing `--task`. `spawn-adhoc` creates a new lightweight thread task for you and needs `--workspace`. Don't mix them up.

## Compose with shell

```bash
# Find a workspace's active controller stream
ace --json ls | jq '.data.streams[] | select(.workspaceId=="prj_XX" and (.label|test("controller|orchestrator"; "i")))'

# Wait for a specialist to finish, then collect its last 100 lines
ace wait conversation:abc --turn-complete --timeout 600000 --json
ace --json screen conversation:abc --tail 100 | jq -r '.data.text'

# Walk every stream's state in one pass
ace --json ls \
  | jq -r '.data.streams[].streamId' \
  | while read s; do
      printf '%s\t%s\n' "$s" "$(ace --json state "$s" | jq -r '.data.state')"
    done
```

## See also

For the complete machine-readable manifest (every command, every flag, exit codes, output schemas), run `ace describe --json` and parse the result, or `ace describe --markdown` for a human-readable rendering. This skill is hand-curated guidance; the registry is canonical.

## Tool Proof Contract

The Mission Board is the live control plane. Skills are doctrine; tool events are proof. Orchestrators should prefer one `ace tool batch --parallel --max-concurrency 4 --input /tmp/ace-start-batch.json` at start. That batch must include `tool heartbeat`, `tool manifest`, `context`, `mission board`, and `ls` or `state`/`screen`; child commands inside the batch count as proof for `ace tool audit`. Use standalone commands when the work is a small one-file fix or batching adds no value.

Long, wave, high-risk, merge-gate, security, deploy, release, prune, or cross-cutting work must record `ace validation clawpatch` before a validation/gate pass. Small fixes and small bugfixes do not require Clawpatch unless risk, `validationRequired`, or the task explicitly asks for it. Hermes remains intact, and Ace remains the control plane: no hidden runtimes, no raw orchestrator writes, and no full registry dump in prompts.

Validator flow: inspect PR/diff/checks, run normal CLI checks/tests first, then use Ace browser/in-app browser for web/UI tasks. For installed app, macOS, runtime, or desktop UI bugs, use @Computer or @Chrome when available to reproduce the flow, capture evidence, and rerun after fixes. Keep it to one app/flow, do not expose secrets, and do not approve admin/security prompts without explicit user approval. Record screenshot/flow evidence in validation handoff or gate detail; if computer use is unavailable when required, return BLOCKED with the exact reason and fallback evidence.

Finalization order: PASS -> `mission gate` -> Ace/integration PR merge -> release gate -> rebuild/package/relaunch only after release gate PASS or explicit approval -> browser/computer-use runtime validation when UI/runtime changed. No raw orchestrator merge, push, delete, or cleanup.
