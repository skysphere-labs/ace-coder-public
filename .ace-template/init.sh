#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

mkdir -p "$root/.ace/run" "$root/.ace/memory" "$root/.ace/wiki"

if [ -f "$root/.ace/FEATURES.json" ]; then
  node -e "const fs=require('fs'); const features=JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); if (!Array.isArray(features)) throw new Error('FEATURES.json must be an array'); for (const feature of features) { if (feature.passes !== false) throw new Error('all features must start with passes=false'); }" "$root/.ace/FEATURES.json"
fi

printf 'Ace project harness ready at %s/.ace\n' "$root"
