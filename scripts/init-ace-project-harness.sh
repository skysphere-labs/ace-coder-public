#!/usr/bin/env bash
set -euo pipefail

project=""
force=0
repo_root="$(pwd)"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
template_dir="$(cd "$script_dir/.." && pwd)/.ace-template"
target_dir="$repo_root/.ace"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --project)
      project="${2:-}"
      shift 2
      ;;
    --force)
      force=1
      shift
      ;;
    --help|-h)
      echo "Usage: init-ace-project-harness.sh --project <name> [--force]"
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

if [ -z "$project" ]; then
  echo "--project is required" >&2
  exit 2
fi

if [ ! -d "$template_dir" ]; then
  echo "template not found: $template_dir" >&2
  exit 1
fi

mkdir -p "$target_dir"

for src in "$template_dir"/*; do
  name="$(basename "$src")"
  dst="$target_dir/$name"
  if [ -e "$dst" ] && [ "$force" -ne 1 ]; then
    continue
  fi
  cp "$src" "$dst"
done

mkdir -p "$target_dir/run" "$target_dir/memory" "$target_dir/wiki"

if [ -f "$target_dir/PROJECT_BRIEF.md" ]; then
  tmp="$target_dir/PROJECT_BRIEF.md.tmp"
  sed "s/{{PROJECT_NAME}}/$project/g" "$target_dir/PROJECT_BRIEF.md" > "$tmp"
  mv "$tmp" "$target_dir/PROJECT_BRIEF.md"
fi

chmod +x "$target_dir/init.sh"
"$target_dir/init.sh"
