# ace

Command-line driver for any agent tab running inside the Ace desktop app.
Every Ace PTY gets `ace` on its `PATH`, so an agent (human or
bot) can inspect, drive, spawn, orchestrate, and record sibling tabs without
leaving the terminal.

The CLI is a thin dispatcher over a registry (`src/commands.cjs`). The
registry is the source of truth — `ace describe` and
`ace <cmd> --help` read from it directly, so this README cannot
drift from the real surface. When in doubt, run `describe`.

## Overview

- Binary: `bin/ace` -> `src/index.cjs`. `ace` is the only CLI name.
- Local transport: Unix socket auto-discovered from the running Ace
  desktop app (`ACE_SOCK` / `ACE_USER_DATA_TAG` / `XDG_RUNTIME_DIR`).
- Remote transport: set `ACE_URL` + `ACE_TOKEN` to hit a Ace
  remote HTTP bridge.
- Output contract: every command prints a single-line JSON envelope on
  stdout — `{"ok":true,"data":{...}}` on success, `{"ok":false,"code",...}`
  on stderr — except `screen` and `follow`, which print raw ANSI unless
  `--json` (or `ACE_JSON=1`) is set.
- Per-command help: `ace <cmd> --help`.
- Full machine-readable manifest: `ace describe` (JSON) or
  `ace describe --markdown`.

## Install

No install step. Ace installs `ace` into `~/.local/bin` and
injects that directory onto `PATH` for every PTY it spawns. Outside a
Ace PTY the socket discovery still works as long as the desktop app is
running.

## Discovery

Self-describing, registry-driven commands.

```bash
ace describe                 # full manifest as single-line JSON
ace describe ls              # one command's schema
ace describe --markdown      # human-readable rendering
ace context                  # {workspaceId, taskId, worktreePath, branch, ...}
ace context --stream <id>    # explicit stream id (defaults to $ACE_STREAM_ID)
```

`context` resolves the current agent's workspace/task/branch metadata from
the stream id Ace injects as `$ACE_STREAM_ID`. The same values are
also available as environment variables in every spawned PTY:
`ACE_STREAM_ID`, `ACE_WORKSPACE_ID`, `ACE_WORKSPACE_NAME`,
`ACE_TASK_ID`, `ACE_CONVERSATION_ID`, `ACE_AGENT`,
`ACE_WORKTREE_PATH`, `ACE_BRANCH`, `ACE_BASE_BRANCH`,
`ACE_REPO_ROOT`, `ACE_IS_REMOTE`.

## Inspect

```bash
ace ls                               # list every stream
ace --json ls | jq '.data.streams[].streamId'
ace state conversation:abc           # state-machine state
ace screen conversation:abc          # full ANSI screen
ace --json screen conversation:abc --tail 50
ace follow conversation:abc          # diff since last follow
ace --json follow conversation:abc
ace watch --event state,ready        # NDJSON event stream (local socket only)
ace watch --event worker-completion  # passive DONE/BLOCKED/VERDICT events
ace completion list                  # queued validation-ready completions
ace completion ack wc_123_1          # mark one queued completion consumed
ace watch --id conversation:abc
```

State names (from the state machine): `booting | awaiting-input | busy |
turn-complete | awaiting-approval | interrupted | error`.

`worker-completion` events are emitted when a stream reaches a ready state
and a fresh `DONE:`, `BLOCKED:`, or `VERDICT:` trailer appeared during that
turn. The same records are kept in the completion inbox until a controller
acknowledges them, so Rook/King can consume validation-ready work when they
are ready without receiving any prompt or interrupt.

## Drive

```bash
ace ask conversation:abc "What did you change?"      # send + wait turn-complete
ace send conversation:abc "hello" --mode type        # paste | type | keys
ace submit conversation:abc                          # press Enter on composer
ace keys conversation:abc Enter                      # named key
ace keys conversation:abc Down --repeat 5
ace slash conversation:abc clear                     # /clear (no leading slash)
ace ref conversation:abc src/index.ts                # @-mention a file
ace approve conversation:abc                         # answer "yes" (default)
ace approve conversation:abc --no                    # answer "no"
ace interrupt conversation:abc                       # agent-specific interrupt
ace abort conversation:abc                           # Esc / Ctrl+C per profile
```

`ask` returns `{ok, endState, elapsedMs, newOutput}`. `send --mode paste`
is fast; `type` is visible to the human tailing the tab; `keys` sends a
named key.

## Lifecycle

```bash
ace spawn claude --task tsk_42                                 # into existing task
ace spawn-adhoc claude --workspace prj_42 --label scratch      # new lightweight thread
ace spawn-adhoc claude --workspace prj_42 --prompt "Read README" --mode type
ace close conversation:abc                                     # kill PTY, keep DB row
ace rename conversation:abc "review pass"                      # relabel tab
ace goal launch --workspace prj_42 --brief /tmp/hermes.md      # Hermes intake -> worker or fresh Claude controller
ace task run claude --workspace prj_42 --new-task --goal "Polish the UX"
ace orchestrator start --workspace prj_42                      # manual/recovery Claude controller
ace orchestrator start --workspace prj_42 --agent hermes       # explicit Hermes intake/recovery lane
```

`spawn` needs `--task`. `spawn-adhoc` creates a new thread task so it needs
`--workspace`. Both accept `--kind cli|chat` (default `cli`).
`goal launch` is the preferred Hermes intake path. It dispatches one direct
worker for tiny/small deterministic goals and spawns a fresh Claude controller
stream in the same workspace for medium/large goals. `orchestrator start`
remains one-per-(workspace, agent) for manual/recovery compatibility; do not use
it as the default big-goal path.

## Wait

```bash
ace wait conversation:abc --turn-complete --timeout 60000
ace wait conversation:abc --awaiting-input --timeout 30000
ace wait conversation:abc --awaiting-approval --timeout 30000
ace wait conversation:abc --state busy --timeout 5000
ace wait conversation:abc --pattern "Y/n" --timeout 10000
ace wait conversation:abc --quiet-for 2000 --timeout 30000
```

Exactly one predicate flag per call. Returns `{matched, elapsedMs}`. Times
out with exit code 4.

## Orchestrate

### `goal launch`

Hermes intake path: take a brain dump or brief and choose the smallest visible
Ace lane.

```bash
# Fresh same-workspace Claude controller for non-trivial goals
ace goal launch --workspace prj_42 --brief /tmp/hermes-brief.md --size large

# One worker, one worktree, no standing controller for tiny tasks
ace goal launch --workspace prj_42 --goal "Fix README typo" --size tiny

# Inspect route, skill pack, and prompt budget without opening a transport
ace --json goal launch --workspace prj_42 --goal "Rebuild auth flow" --dry-run
```

The Claude controller is an adhoc workspace stream, not an implementation
worktree. It organizes plan/risks/lanes/questions, then spawns code, research,
and validator workers with `task run --workspace <same workspace> --new-task`.

### `task run`

High-level: spawn (or reuse) a stream, deliver a framed task prompt
(`prompt.cjs::buildTaskPrompt`), wait for turn-complete, parse the
`DONE:` / `BLOCKED:` trailer, loop if missing, optionally verify the
worktree for real changes.

```bash
# Code delegation: fresh branch + worktree, worker lands in it
ace task run claude --workspace prj_42 --new-task --goal "Add a hello route"

# Reuse an existing stream, loop up to 5 rounds
ace task run codex --stream conversation:abc --spec /tmp/spec.json --max-rounds 5

# Chat-only aside (no worktree) — side-conversation that won't write code
ace task run claude --workspace prj_42 --goal "Explain the router"

# Route dry-run: validate spec, classify, resolve skills, and print one JSON envelope
ace --json task run --dry-run --spec /tmp/spec.json
```

Flags (see `describe task run` for the authoritative list):

- `--workspace <id>` — target workspace.
- `--new-task` — with `--workspace`, create a fresh task + git worktree +
  branch and spawn into it. Required for real code delegations so the
  child's changes don't collide with the orchestrator's branch.
- `--task <id>` — spawn into an existing task. Conflicts with `--new-task`.
- `--stream <id>` — attach to an existing stream. Conflicts with `--new-task`.
- `--spec <path>` — JSON spec file with
  `{goal, context, constraints[], deliverables[], acceptance[], taskType?, taskClass?, baselineSkills?, taskPackSkills?, validationSkills?, requiredSkills?, optionalSkills?, skills?, maxRounds?, maxVerifyRounds?, requireChanges?, escapeHatch?, promptBudgetOverrideReason?}`.
- `--goal <text>` — inline goal (alternative to `--spec`).
- `--context <text>` / `--constraint <text>` / `--deliverable <text>` /
  `--acceptance <text>` — inline spec pieces (the constraint / deliverable /
  acceptance flags are repeatable).
- `--escape-hatch <text>` — override the default DONE/BLOCKED trailer text.
- `--dry-run` — route dry-run; returns provider, role mode, task class, skill
  stack/resolution, prompt chars, warnings, and validation policy without
  opening a Ace transport or spawning a worker.
- `--max-rounds <n>` — retries if the worker stops without a trailer
  (default 3). `0` means unbounded until DONE/BLOCKED/approval/timeout; a
  TaskSpec `maxRounds` value is honored when the flag is omitted.
- `--effort low|medium|high|xhigh|max` — provider reasoning effort. Codex
  launches support through `xhigh`; Codex `max` is rejected before spawn
  instead of silently launching without a reasoning override. Claude supports
  `max` via `--effort max`; that launch intent is the Claude
  UltraCode/dynamic-workflow lane (`workflowMode: "dynamic-workflow"` and
  `ultraCode: true`). Claude `xhigh` is extra-high reasoning only and must not
  be reported as UltraCode. Managers should spawn Claude dynamic-workflow lanes
  with `--effort max --effort-override <reason>` and keep internal fan-out
  inside that worker tab.
- `--require-changes auto|true|false` — gate DONE on a non-empty worktree
  diff. Default `auto`: on when the spec implies code (deliverables mention
  files / `src/` / `npm run` / build tools), off for pure research.
- `--max-verify-rounds <n>` — how many times to re-ask after a premature
  DONE when the worktree is empty (default 3).
- `--mode paste|type` (default `paste`) — delivery mode. `paste` is fast;
  use `type` only when visible keystrokes matter more than speed.
- `--fire-and-forget` — send and return immediately.
- `--timeout <ms>` — per-round wait timeout.
- `--label <text>` / `--kind cli|chat` (default `cli`) — new-spawn metadata.

Output (success): `AceTaskRunResult/v1` with `{schema, version, streamId,
conversationId, taskId, worktreePath, branch, baseBranch, outcome, detail,
rounds, verifyRounds, roundDetails, verify, lastAssistantText, fireAndForget,
created, telemetry}`. `outcome` is one of `done | done-unverified | blocked |
awaiting-approval | max-rounds | dispatched | timeout | error`. `telemetry`
is `AceTaskRunTelemetry/v1` and preserves the prompt telemetry fields while
also guaranteeing `{provider, roleMode, taskType, skillPack,
renderedPromptChars, skillCount, mcpMode, baseRefreshMode, readyMs, promptMs,
firstOutputMs}`; unknown timings are `null`.

#### Browser automation opt-in

Browser automation is not part of the worker baseline. The in-app controller is
task-scoped and controls only visible Ace browser tabs after the desktop app
prompts for per-task permission.

```bash
ace describe browser
ace browser list --task tsk_42
ace browser open https://github.com --task tsk_42
ace browser screenshot br-abc --task tsk_42 --out /tmp/ace-browser.png
ace browser click br-abc --task tsk_42 --x 412 --y 530
ace browser js br-abc --task tsk_42 'document.title'
```

The optional `ace_browser` MCP catalog entry runs `ace mcp-browser`;
it is disabled by default and has no credentials, profile path, or hidden
browser runtime. Playwright remains available as a separate opt-in MCP
capability. If a worker cannot access the requested browser tool, it should
return `BLOCKED:` instead of starting an ungated runtime.

#### DONE / BLOCKED trailer contract

A delegated worker MUST end its final turn with exactly one of:

- `DONE: <one-line summary>` — task complete.
- `BLOCKED: <one-line reason>` — cannot proceed; do not loop.

`prompt.cjs::parseTrailer` scans the last-turn output. If both appear, `DONE`
wins only when it appears strictly later in the output; otherwise `BLOCKED`
wins (avoids silently treating a stuck turn as success). Without either,
the orchestrator folds a compact summary of the last turn into the next
round's spec (`priorRoundSummary`) and re-asks up to `--max-rounds` times.

If the spec legitimately produces no code (research/planning folded into a
single code spec is the recommended pattern, but edge cases exist) emit
`DONE: no-code <reason>` — that token short-circuits the verify loop.

### `task chat`

Scripted multi-turn chat. Script is a JSON array of
`{text, stopOn?, timeoutMs?, mode?}` steps.

```bash
ace task chat claude --stream conversation:abc --script /tmp/chat.json
```

Same workspace/task/stream/label/kind/mode flags as `task run`. Returns
`{streamId, turns, created}`.

## Cross-tab relay

Two-stream ping-pong. Read A's last turn, send to B, wait, swap.

```bash
ace relay conversation:a conversation:b --max-rounds 6
ace relay conversation:a conversation:b --seed "kick off review" --stop-on "DONE:"
```

Stops on `DONE:` / `BLOCKED:`, a `--stop-on` regex match, `awaiting-approval`,
or `--max-rounds` (default 8). Flags: `--max-rounds`, `--stop-on`, `--seed`,
`--mode paste|type` (default `type`). Returns
`{rounds, roundDetails, stopReason, lastSource, lastTarget}`.

## Recording

```bash
ace record conversation:abc /tmp/sess.ndjson     # start NDJSON PTY-frame log
ace record-stop conversation:abc
ace replay /tmp/sess.ndjson --agent claude       # replay into a fresh stream
ace snapshot conversation:abc                    # .ansi + .txt under $TMPDIR/ace-snapshots
```

## Profiles

```bash
ace profiles                                     # list loaded agent profiles
ace reload                                       # hot-reload profile JSON from disk
```

Profiles live in `electron/ace-control/profiles/` and describe per-agent
paste vs type behavior, prompt detection, and interrupt semantics.

## Transport

- **Local Unix socket** (default): resolved from `ACE_SOCK`,
  `ACE_USER_DATA_TAG`, or `XDG_RUNTIME_DIR`. `client.cjs` tags
  missing-socket / connection-refused as `SOCKET_UNREACHABLE` → exit 3.
- **Remote HTTP**: set `ACE_URL` + `ACE_TOKEN`. `POST
  /api/<method>` with `Authorization: Bearer <token>`. Events are
  socket-only today; on HTTP the CLI's `watch` command is rejected with
  `invalid_choice` and callers should poll via `state`.
- **Timeouts** are client-enforced (`client.cjs::withDeadline`). Default
  60s per command. Override per-command with `--timeout <ms>` (where the
  registry exposes it) or globally with `ACE_TIMEOUT_MS`.

## Exit codes

From `src/commands.cjs::EXIT_CODES`:

| code | meaning |
| ---- | ------- |
| 0    | ok |
| 2    | arg-error (missing/invalid flag or positional) |
| 3    | transport-error (socket unreachable) |
| 4    | timeout (client deadline hit) |
| 5    | server-error (backend returned `{ok:false}`) |
| 6    | not-found (streamId / taskId / workspaceId / command unknown) |
| 7    | conflict (spawn dedup hit, etc.) |

Each command's registry entry lists which of these codes it can emit.

## Tests

```bash
node --test src/__tests__
```

Covers CLI parsing (`cli.test.cjs`), the registry (`commands.test.cjs`),
the orchestration loop including verify fallback
(`orchestrator.test.cjs`), and the prompt builder + trailer parser
(`prompt.test.cjs`).

## Related

- `src/index.cjs` — registry-driven argv parser and dispatcher.
- `src/commands.cjs` — the one registry every other file reads from.
- `src/orchestrator.cjs` — `runTask` / `runChat` loop + verify budget.
- `src/prompt.cjs` — framed task prompt + `DONE:` / `BLOCKED:` parser.
- `src/client.cjs` — socket/HTTP transport + deadline.
- `src/relay.cjs` — two-stream ping-pong.
- `electron/local-core.cjs` — backend IPC: `createDelegatedTask`,
  `verifyTaskProgress`, `startOrchestrator`, `ensureStreamStarted`,
  `planResume`, session resume fallback.
- `electron/ace-control/index.cjs` — maps `stream*` IPC methods to
  `aceStore` functions (the socket bridge the CLI actually hits).
- `electron/hermes-home.cjs` — per-workspace `HERMES_HOME` and skill
  seeding so orchestrators and children don't collide on `--continue`.
