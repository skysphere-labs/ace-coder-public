#!/usr/bin/env bash
# Cross-compile the ace-coder-daemon remote daemon for every supported target
# and stage the binaries under electron/bin/. Run from the repo root
# or from electron/remote-daemon — both work.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
out="$here/../bin"
mkdir -p "$out"

targets=(
  "linux amd64"
  "linux arm64"
  "darwin amd64"
  "darwin arm64"
)

cd "$here"

for t in "${targets[@]}"; do
  os="${t% *}"
  arch="${t#* }"
  name="ace-coder-daemon-${os}-${arch}"
  echo "→ building $name"
  CGO_ENABLED=0 GOOS="$os" GOARCH="$arch" \
    go build -trimpath -ldflags="-s -w" -o "$out/$name" .
done

echo "✓ built binaries in $out"
ls -lh "$out"
