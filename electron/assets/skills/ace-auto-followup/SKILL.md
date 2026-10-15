---
name: ace-auto-followup
description: After dispatching a ace worker (especially --fire-and-forget), automatically schedule a wakeup to poll status and report back. Do not ask the user for permission to schedule.
---

# Ace Auto-Followup

## When to use

Apply this skill any time you dispatch a background worker via `ace task run` — especially with `--fire-and-forget` — or kick off any long-running background process the user expects you to follow up on.

## Core rule

**Never ask "want me to /schedule a wakeup?"** for a worker you just dispatched. The user has explicitly directed you to handle follow-up autonomously. Schedule the wakeup yourself before ending the turn.

## Fallback when no wakeup scheduler tool exists

Some CLI/operator environments do not expose `ScheduleWakeup`. In that case, do not pretend a wakeup was scheduled and do not stop tracking. Start a lightweight background watcher with the terminal/process tool and report its `proc_*` id.

Example:

```bash
while true; do
  state=$(ace --json state <streamId> | python3 -c 'import sys,json; print(json.load(sys.stdin).get("data",{}).get("state","unknown"))')
  echo "$(date -Iseconds) state=$state"
  case "$state" in
    turn-complete|awaiting-input|awaiting-approval|error|dormant) break ;;
  esac
  sleep 120
done
ace --json screen <streamId> --tail 120 > /tmp/<label>-watch-final.json || true
```

This is inferior to a durable scheduled wakeup, but it preserves autonomous follow-up inside the active session. If the background watcher exits, poll its `proc_*` before trusting stale notifications.

When sending a follow-up to an already-finished or prompt-ready worker, `state` can remain `busy` even though the pane is visibly at a prompt or already printed a `DONE:` line. Do not rely on state alone. Inspect the screen after the exact follow-up anchor text you sent. If the follow-up body is visibly sitting in the composer and no tool/model turn started, press `Enter`/`submit` once and recheck. If a `DONE:`/`BLOCKED:` appears only before your anchor, it belongs to the previous task, not the follow-up.

Watcher false-positive / partial-completion pitfall: `screen --tail` often contains the echoed task prompt, including the escape-hatch examples `DONE:` and `BLOCKED:`. A watcher must not treat mere substring presence as completion. Parse only standalone trailer lines near the latest assistant output, and allow Ace/Codex screen indentation such as `  DONE:` or `  BLOCKED:` (`^\\s*(DONE|BLOCKED):`). Prefer requiring the trailer to appear after the worker's final model activity, not inside `# Acceptance`, `# Escape hatch`, or a user-sent prompt. If in doubt, keep watching and inspect the tail manually.

Watcher loop-exhaustion pitfall: a watcher process exiting is not the same as all workers completing. If the summary shows one stream still `busy` with no anchored trailer while another has `DONE:`, report the completed lane and spawn/retry the incomplete lane instead of synthesizing a verdict yourself. For Ace PR validators, if a validator remains busy far past expected time and the tail shows an apparent conclusion (for example `No code findings`) but no final trailer, mark that validator stale/stuck, interrupt/abort it if safe, then spawn a tighter replacement validator.

Known Ace worker startup/fixback patterns from the 2026-05-06 and 2026-05-07 lean-orchestration waves:
- Codex workers may still show unwanted MCP/browser startup before the installed runtime has no-MCP-default provider launch. Press `Escape`, then send a same-worker continuation that says no MCP/browser/external services unless explicitly required. If this occurs on no-code/research tasks, record it as evidence for a Wave 1 startup/trust fix; see `ace-github-flow/references/ace-lean-orchestration-fast-workers-2026-05-07.md`.
- Current prompts may hard-block on missing optional skills. If the missing skill was not explicitly marked REQUIRED, send a same-worker fixback: `the missing <skill> is optional for this task, not a blocker; continue with direct repo/gh/git/Ace CLI inspection and end DONE/BLOCKED`.
- `task run`, `integrate push`, or `integrate pr-open` can fail with `spawn EBADF` when the installed Ace main process is holding thousands of regular `.ace/worktrees` FDs (observed ~10k). Verify with `lsof -nP -p <AcePid>` before spawning more. Source fix PR #128 default-disables the full-tree watcher path; until it is merged/rebuilt, mitigation is launching Ace with `ACE_DISABLE_GIT_WATCHER=1`, while explicit developer opt-in is `ACE_ENABLE_FULL_TREE_GIT_WATCHER=1`. If the owner authorizes a controlled relaunch-only reset, relaunch with the mitigation env, verify `.ace/worktrees` REG FDs drop to 0, then resume validators/workers.
- Treat those first BLOCKED/EBADF turns as validation evidence for the bug class, not as final worker failure, unless the worker still blocks after the fixback or FD reset. Always include `--new-task` on implementation delegations; without it, `ace task run --workspace ...` creates an adhoc thread with no isolated worktree.
- When FD health is already bad but the owner approves a narrow wave, dispatch only one controlled worker, start one watcher, and treat success as a controlled exception — not proof that broad fanout is safe. Use exact Ace main-process matching when counting FDs; loose substring matching can pick a child process and falsely report tiny FD counts. See `references/fd-leaky-single-worker-option1-2026-05-06.md`.

For long-lived control-plane operator/conversation lanes, also treat provider context overflow/compression as a special stuck-busy mode. If `screen --tail` shows context-window overflow or repeated compression/retry text and `interrupt`/`abort` returns ok but state remains `busy`, stop relying on that lane for review evidence; spawn a fresh compact reviewer lane or use exact-head temp checkout review instead. See `references/lane-overflow-stuck-busy-recovery-2026-05-05.md` for the incident pattern and recovery checklist.

Claude-specific stale booting pitfall: if a `task run claude` wrapper or controller stays busy while the child Claude stream reports `booting`, inspect the child screen. If it is visibly at an empty Claude prompt, the prompt likely was not delivered; do not report that Claude is working. Either send/submit the compact handoff once to that child or route a source fix to Codex. Detailed repro: `ace-empty-pane-debugging/references/claude-prompt-ready-stale-booting-taskrun-2026-05-07.md`.

## Goal/slash-command follow-up on busy workers

When the owner asks to apply a slash command or mode change to an already-running worker (for example Codex `/goal`) and the worker is `busy`, do not interrupt unless it is truly stuck. Treat it like queued follow-up:

1. Verify prerequisite runtime state first (for `/goal`, `codex features list | grep '^goals'` should show `true`, or launch future workers with `--enable goals`). Do not assume `goalMode=on` means the goal was set; observed Wave 1 startup printed `/goal <objective> No goal is currently set`, which is just usage/help, not success.
2. Inspect `ace screen <stream>` to confirm the worker is actively editing/testing, not just stale-busy at a prompt.
3. Start a lightweight watcher that polls state and sends/submits the slash command only when state reaches `awaiting-input` or `turn-complete`.
4. Log the watcher path/proc id so the control-plane operator can poll it later.
5. If the stream goes `error`/`dormant`, capture the screen tail and stop rather than repeatedly resending.

Template watcher core:

```bash
STREAM='variant:var-...'
GOAL='/goal <concrete acceptance-gated objective>'
while true; do
  state=$(ace --json state "$STREAM" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("data",{}).get("state","unknown"))')
  case "$state" in
    awaiting-input|turn-complete)
      ace send "$STREAM" "$GOAL" --mode paste
      ace submit "$STREAM"
      break
      ;;
    error|dormant) ace --json screen "$STREAM" --tail 120 > /tmp/<label>-final.json; exit 2 ;;
  esac
  sleep 30
done
```

## Stale process completion notifications

Delayed `proc_* completed` notifications are not automatically blockers. After context compression or multi-attempt fixbacks, old task-run wrappers may report `invalid_spec`, `Error: stream closed`, or timeout while the real PR already merged or the screen is ready despite stale `booting`/`busy` state. Before acting, verify current truth via process log/poll, `gh pr view/list`, `ace ls`, and `screen --tail`. If the intended PR is merged and no open PR remains, report stale/non-blocking and do not respawn work.

For Ace waves with many watcher scripts, identify the current authoritative watcher/gate before reacting. Old planning/implementation watchers can complete long after focused PR validators superseded them; classify those notices as stale/non-blocking after checking their log and the current gate watcher. Record one concise tracker/doc checkpoint only if it prevents future confusion; do not create noisy per-notice churn or ask the owner repeatedly unless the current gate requires a high-stakes decision.

## What to do

1. Dispatch the worker with `ace task run ... --fire-and-forget` (capture the returned `variant:var-…` stream id).
2. Immediately call `ScheduleWakeup` in the same turn:
   - **delaySeconds**: pick based on expected work size:
     - Small fix / one-file change: `300`–`600`s — but prefer `270` (cache-warm) or `1200`+ (one cache miss)
     - Typical feature work: `1200`–`1800`s (20–30 min)
     - Heavy multi-file or research-heavy work: `1800`–`3600`s (30–60 min)
   - **prompt**: a self-contained instruction that re-establishes the worker streamId, what was dispatched, and what to do — see template below.
   - **reason**: short and specific, e.g. `"poll workspace-create worker (var-53344cd1)"`.
3. End the turn with a brief status line. Do not include a "want me to schedule?" question.

## Wakeup prompt template

The wakeup prompt is run by a fresh you with no context. Make it self-contained:

```
Poll ace worker <streamId> dispatched at <timestamp> for <one-line goal>.

Run:
  tools/ace/bin/ace --json state <streamId>
  tools/ace/bin/ace screen <streamId> --tail 200

If state is busy or awaiting-approval: reschedule another wakeup (1200–1800s) and report a one-line status.
If state is awaiting-input or turn-complete: capture the DONE/BLOCKED trailer + PR URL from the screen, run `gh pr view <num>` for confirmation, and report the result. If trailer is missing, send a brief follow-up via `ace ask <streamId> "Status?"` and reschedule.
If state is error/dormant unexpectedly: report and stop the loop.

Worktree: <worktree path>
Task id: <tsk-…>
Workspace: <prj-…>
```

Bake the actual streamId, worktree, and goal into the prompt — do not leave placeholders.

## When NOT to schedule

- The dispatch was synchronous (no `--fire-and-forget`) and you already waited for completion.
- The user explicitly said "don't follow up" / "fire and forget".
- The dispatch failed at the CLI level (no streamId returned) — report the failure instead.

## Edge cases

- **Multiple dispatches in one turn**: schedule a single wakeup that polls all of them; the wakeup prompt enumerates each streamId.
- **Bash watcher keys**: if you use `set -u` plus a Bash associative array, avoid hyphenated unquoted keys like `[control-plane-bridge]=...`; Bash can evaluate the subscript as arithmetic and fail with `unbound variable`. Use underscore keys (`control_plane_bridge`) or quote subscripts explicitly.
- **Reschedule loops**: the wakeup itself is responsible for calling `ScheduleWakeup` again if the worker is still busy. The runtime clamps to [60, 3600]s.
- **PR creation**: when the worker reports DONE with a PR URL, `gh pr view <num> --json state,isDraft,headRefName,url` should confirm it exists and is a draft. Do not merge unless the original spec authorized merging.
