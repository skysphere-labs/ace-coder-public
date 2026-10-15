# __NAME__ — event-driven loop

<!-- A loop WAITS on an async event without re-invoking the LLM to poll.
     Fill in the trigger, the OODA body, and ALL FOUR guards. Delete the
     trigger options you don't use. -->

## Goal

<!-- One line: what terminal state are we waiting for, and what do we do then? -->
Wait for __EVENT__; on success __ACT__; on failure __RECOVER__.

## 1) Trigger — pick ONE

| Trigger | Use when | Mechanism |
| --- | --- | --- |
| Routines / Cron (cloud) | standing automation; a GitHub event should wake you (pull_request, push, issue, check_run, workflow_run, discussion, release, merge_queue); fixed schedule; HTTP POST | `CronCreate` / Routines |
| Monitor (local) | local interactive; watch one async job to terminal state, interrupted only on the event | `Monitor` tool |
| Bash run_in_background | one completion ping; command EXITS when condition true | `Bash run_in_background:true` |
| ScheduleWakeup | self-paced; external state the harness can't notify you about | `ScheduleWakeup` |
| /loop (local) | babysit on a cadence / self-paced, up to ~3 days | `/loop` |

**Chosen trigger:** __FILL_IN__ — because __WHY__.

## 2) OODA body (one iteration)

```bash
# OBSERVE — query real state, never assume
st=$(gh run view "$RID" --json status,conclusion \
      -q '.status+"/"+(.conclusion//"-")' 2>/dev/null || echo "query-fail/-")

# DECIDE — terminal? which terminal?
case "$st" in
  completed/success)   echo "DONE: $st"; exit 0;;          # ACT: next step
  completed/*)         echo "FAILED: $st"; exit 1;;        # ACT: escalate/recover
esac
# else: keep waiting via the PLATFORM (do NOT re-LLM)
```

After ACT, **OBSERVE the result** before declaring done (CI green ≠ runtime-correct —
verify the artifact, not just the check).

## 3) Guards — ALL FOUR required

- **Iteration cap** — bound the wait: `for i in $(seq 1 50)` / a `timeout_ms` /
  a max-tick count. Never unbounded `while true`.
- **Repeat-action detection** — same action + same result twice → stop, escalate.
- **Terminal-state coverage — silence ≠ success** — emit on EVERY terminal state
  (success | failure | cancelled | timeout). Always echo a final line after the
  loop so a crash can't masquerade as "still running".
- **Cache-aware delays** — `<300s` keeps cache warm (fast-changing state);
  `1200–1800s` for idle ticks; avoid `300s`. Monitor on a ~15-min run →
  `timeout_ms: 2400000`.

## 4) Token rule

Never re-invoke the LLM just to re-check state — polling in the agent loop replays
the whole transcript every tick. Let the platform notify you.

**Never:** `gh run watch` / `gh pr checks` in a foreground turn; fixed tight
intervals; re-reading the transcript to re-check; a filter that emits only on
success.

## Canonical Monitor poll-to-terminal recipe

```bash
RID=<run-id>
for i in $(seq 1 50); do
  st=$(gh run view "$RID" --json status,conclusion \
        -q '.status+"/"+(.conclusion//"-")' 2>/dev/null || echo "query-fail/-")
  case "$st" in completed/*) echo "run FINISHED: $st"; exit 0;; esac
  sleep 45
done
echo "still $st after timeout"
```

Run it via the `Monitor` tool with a generous `timeout_ms`; `persistent:true`
only for session-length watches.

## Related

- **ace-spine-driver** — this pattern applied end-to-end on the run-ledger spine.
- **ace-github-flow** — the pipeline rules the loop drives on top of.
