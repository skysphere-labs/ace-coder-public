#!/usr/bin/env bash
# Reap orphaned test-runner worker processes on a self-hosted CI runner.
#
# The leak: when a CI step running a test suite is cancelled (a workflow's
# `concurrency: cancel-in-progress` firing on a re-push) or its process is
# otherwise killed, the runner's per-file/pool worker processes are not in that
# kill scope. They reparent to launchd/init (PPID 1) and keep spinning, piling
# up on the shared runner across runs. Observed 2026-07-18: ~11 stuck
# `node (vitest N)` workers at 15-45% CPU each.
#
# Two worker shapes are reaped, both only when their parent is PID 1:
#   - vitest tinypool workers, whose title is "node (vitest <n>)".
#   - node's built-in runner (`node --test`): the parent (`node --test <files>`)
#     and its per-file children (`node [args] <file>.test.<ext>`), which is how
#     ci-heavy / spine-guard / part of ci-fast run their suites.
#
# Identification is deliberately narrow: the vitest title carries a "(vitest N)"
# marker, and node --test workers end in a "*.test.<ext>" file argument. We only
# ever signal a PID whose parent is 1 — a worker owned by a LIVE run always has
# a live (non-1) parent, so an in-progress run is never touched, on this job or
# a co-located one. If killing an orphaned `node --test` parent re-orphans its
# children, the next job's pre-clean invocation reaps them.
#
# Coverage caveat (do not overstate this in the workflow): an `if: always()`
# step reliably runs on step failure and on job cancellation, but a job-level
# `timeout-minutes` can terminate the job before later steps run. Timeout
# recovery therefore relies on the PRE-clean invocation at the start of the next
# job — so any workflow that runs tests should invoke this both as a pre-clean
# step and as an always() post step.
#
# This script never fails the job.
set -u

# is_test_worker: succeeds when the given command line is a reapable test-runner
# worker. Two shapes, both requiring the executable to actually be `node` so an
# unrelated orphan (an editor, `tail -f`, `deno`, a shell script) that merely
# ends in a "*.test.*" name is never matched:
#   1. a vitest tinypool worker, titled "node (vitest <n>)";
#   2. a node --test parent/child, i.e. a `node` process whose final argument is
#      a "*.test.<ext>" file (children are `node [args] <file>`, the parent is
#      `node --test <files>`).
# Combined with the PPID==1 gate the caller applies, this only ever reaps a
# leaked, orphaned node test process — never a live run's worker (which has a
# live parent) and never a non-node process. Kept in one place so selection and
# the pre-kill re-validation share identical logic and stay unit-testable.
is_test_worker() {
  local cmd="$1" exe
  exe="${cmd%% *}"      # first token = executable path
  exe="${exe##*/}"      # basename
  [ "$exe" = "node" ] || return 1
  case "$cmd" in
    *"(vitest "[0-9]*) return 0 ;;
    *.test.cts|*.test.mts|*.test.ts|*.test.tsx|*.test.mjs|*.test.cjs|*.test.js|*.test.jsx)
      return 0 ;;
  esac
  return 1
}

# select_orphans: reads `ps`-style "pid ppid command..." lines on stdin and
# echoes the PIDs that are PPID-1 AND a test worker. Pure (no side effects), so
# the selection logic is unit-testable against synthetic snapshots without
# needing a real orphaned process.
select_orphans() {
  local line pid ppid cmd
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    # shellcheck disable=SC2086
    set -- $line
    [ "$#" -ge 3 ] || continue
    pid="$1"; ppid="$2"; shift 2; cmd="$*"
    [ "$ppid" = "1" ] || continue
    is_test_worker "$cmd" && echo "$pid"
  done
}

reap_live() {
  local candidates pid info ppid cmd killed=""
  candidates="$(ps -A -o pid=,ppid=,command= 2>/dev/null | select_orphans)"
  for pid in $candidates; do
    # Re-read parent AND command right before signaling: if the PID was
    # recycled, or the worker re-parented to a live process since the snapshot,
    # ppid != 1 or the command no longer matches and we skip it.
    info="$(ps -o ppid=,command= -p "$pid" 2>/dev/null || true)"
    [ -z "$info" ] && continue
    # shellcheck disable=SC2086
    set -- $info
    ppid="$1"; shift; cmd="$*"
    [ "$ppid" = "1" ] || continue
    is_test_worker "$cmd" || continue
    if kill -9 "$pid" 2>/dev/null; then
      killed="$killed $pid"
    fi
  done
  if [ -n "${killed# }" ]; then
    echo "reap-orphan-test-workers: reaped orphaned test workers:$killed"
  else
    echo "reap-orphan-test-workers: no orphaned test workers found"
  fi
}

# Run the live reap only when executed directly. When this file is sourced (the
# unit test sources it to exercise select_orphans / is_test_worker), skip the
# reap so no kills happen and the sourcing shell is not exited.
if [ "${BASH_SOURCE[0]:-}" = "${0}" ]; then
  reap_live
  exit 0
fi
