#!/usr/bin/env bash
# provision-worktree.sh <worktree-dir>
#
# Step 0 of every validation round: a delegated worktree has no node_modules,
# so `npm run dev` fails until dependencies + native modules (better-sqlite3,
# node-pty) are installed/rebuilt. Idempotent — a provisioned worktree is a
# fast no-op. First run costs minutes; that is the price of running the REAL
# app, and it is paid once per worktree.
set -euo pipefail

WORKTREE="${1:-.}"
cd "$WORKTREE"

if [ ! -f package.json ]; then
  echo "provision-worktree: no package.json in $PWD" >&2
  exit 2
fi

if [ -d node_modules ] && [ -e node_modules/.ace-provisioned ]; then
  echo "provision-worktree: already provisioned ($PWD)"
  exit 0
fi

echo "provision-worktree: npm ci ($PWD)"
npm ci --no-audit --no-fund

echo "provision-worktree: rebuilding native modules for Electron"
npm run rebuild-native

touch node_modules/.ace-provisioned
echo "provision-worktree: done"
