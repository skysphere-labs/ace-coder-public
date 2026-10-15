#!/usr/bin/env bash
# Focused verification for the orphan test-worker reaper's selection logic.
# Sources the reaper (which does not reap when sourced) and drives the pure
# select_orphans function against synthetic `ps`-style snapshots, covering both
# worker shapes, candidate selection, live-worker exclusion, and no-match.
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=/dev/null
source "$here/reap-orphan-test-workers.sh"

fail=0
sel() { printf '%s\n' "$1" | select_orphans | tr '\n' ' ' | sed 's/ *$//'; }
check() {
  if [ "$2" = "$3" ]; then
    echo "ok   - $1"
  else
    echo "FAIL - $1: expected [$3], got [$2]"
    fail=1
  fi
}

# --- vitest tinypool worker ---
check "selects orphaned vitest tinypool worker" \
  "$(sel '111 1 node (vitest 3)')" "111"
check "excludes live (non-orphan) vitest worker" \
  "$(sel '222 999 node (vitest 3)')" ""
check "excludes non-tinypool vitest CLI/main process" \
  "$(sel '333 1 node /repo/node_modules/.bin/vitest run')" ""
check "excludes detached vitest --watch" \
  "$(sel '444 1 node /repo/node_modules/vitest/vitest.mjs --watch')" ""

# --- node --test workers ---
check "selects orphaned node --test per-file child (.cts)" \
  "$(sel '555 1 node --require tsx/cjs /repo/electron/__tests__/gateway.test.cts')" "555"
check "selects orphaned node --test child (.mjs)" \
  "$(sel '666 1 /path/node /repo/hang.test.mjs')" "666"
check "selects orphaned node --test parent process" \
  "$(sel '777 1 node --test /repo/a.test.cts /repo/b.test.cts')" "777"
check "excludes live node --test child (non-orphan)" \
  "$(sel '888 4242 node --require tsx/cjs /repo/a.test.cts')" ""

# --- non-workers ---
check "no match on unrelated orphaned node process" \
  "$(sel '901 1 node server.js')" ""
check "no match on the reaper's own shell (.test.sh, not a worker)" \
  "$(sel '902 1 bash /repo/scripts/ci/__tests__/reap-orphan-test-workers.test.sh')" ""

# --- non-node executables that merely end in a test-file name must NOT match ---
check "no match on an editor holding a .test.ts file" \
  "$(sel '903 1 vim /repo/electron/__tests__/foo.test.ts')" ""
check "no match on tail -f of a .test.js file" \
  "$(sel '904 1 tail -f /repo/x.test.js')" ""
check "no match on a non-node (deno) runner of a .test.ts file" \
  "$(sel '905 1 /usr/local/bin/deno run /repo/x.test.ts')" ""
check "no match on a shell running a .test.mjs file" \
  "$(sel '906 1 /bin/bash /repo/run.test.mjs')" ""

# --- mixed snapshot: only the PPID-1 workers ---
check "mixed snapshot selects only orphaned workers" \
  "$(sel '111 1 node (vitest 1)
222 999 node (vitest 2)
333 1 node server.js
444 1 node --require tsx/cjs /repo/x.test.ts
555 4242 node --require tsx/cjs /repo/live.test.ts')" "111 444"

if [ "$fail" -eq 0 ]; then
  echo "reap-orphan-test-workers.test: all checks passed"
else
  echo "reap-orphan-test-workers.test: FAILURES above" >&2
fi
exit "$fail"
