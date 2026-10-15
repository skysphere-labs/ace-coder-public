#!/usr/bin/env bash
#
# new-skill.sh — scaffold a Ace skill and install it to all three brains.
#
# USAGE:
#   new-skill.sh <kebab-name> "<description>" [--loop]
#
#   <kebab-name>    lowercase, digits, hyphens (e.g. watch-the-release)
#   <description>   the retrieval surface — lead with a verb, name the intent
#                   phrases + domain nouns, 1–2 sentences. Quote it.
#   --loop          also emit <name>.loop.md (event-driven loop skeleton)
#
# WHAT IT DOES (idempotent + safe):
#   1. mkdir -p ~/.claude/skills/<name>/references
#   2. write SKILL.md from skill-template.md (backs up any existing one first)
#   3. with --loop: write references/<name>.loop.md from loop-template.md
#   4. chmod +x any *.sh in references/
#   5. cp -R the whole skill dir into ~/.codex/skills/ and ~/.hermes/skills/
#      (skips any brain whose parent dir isn't present/mounted, with a warning)
#
# EXAMPLES:
#   new-skill.sh my-skill "Author X. Use when asked to 'do X' or 'make Y'."
#   new-skill.sh watch-the-release "Watch a release run to terminal state." --loop
#
set -euo pipefail

# ---- locate this script's references/ dir (where the templates live) --------
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)"

# ---- the three brains -------------------------------------------------------
CLAUDE_SKILLS="${HOME}/.claude/skills"
CODEX_SKILLS="${HOME}/.codex/skills"
HERMES_SKILLS="${HOME}/.hermes/skills"

usage() {
  sed -n '3,27p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

# ---- args -------------------------------------------------------------------
[ "$#" -ge 2 ] || { echo "ERROR: need <kebab-name> and \"<description>\"." >&2; usage 1; }

NAME="$1"
DESCRIPTION="$2"
WANT_LOOP=0
shift 2
for arg in "$@"; do
  case "$arg" in
    --loop) WANT_LOOP=1;;
    -h|--help) usage 0;;
    *) echo "ERROR: unknown arg: $arg" >&2; usage 1;;
  esac
done

# ---- validate name ----------------------------------------------------------
if ! printf '%s' "$NAME" | grep -Eq '^[a-z0-9]+(-[a-z0-9]+)*$'; then
  echo "ERROR: name must be kebab-case (lowercase/digits/hyphens): '$NAME'" >&2
  exit 1
fi

# TITLE = Name From Kebab
TITLE="$(printf '%s' "$NAME" | tr '-' ' ' | awk '{for(i=1;i<=NF;i++){$i=toupper(substr($i,1,1)) substr($i,2)}}1')"

DEST="${CLAUDE_SKILLS}/${NAME}"
REFS="${DEST}/references"
mkdir -p "$REFS"

# ---- render SKILL.md from template (back up existing first) -----------------
SKILL_MD="${DEST}/SKILL.md"
if [ -f "$SKILL_MD" ]; then
  BAK="${SKILL_MD}.bak.$(date +%Y%m%d-%H%M%S)"
  cp -p "$SKILL_MD" "$BAK"
  echo "backed up existing SKILL.md -> $BAK"
fi

render() {
  # render <template> <outfile> : substitute __NAME__/__TITLE__/__DESCRIPTION__
  local tpl="$1" out="$2"
  if [ ! -f "$tpl" ]; then
    echo "ERROR: template not found: $tpl" >&2; exit 1
  fi
  # use awk so arbitrary description text (slashes, &, etc.) is safe
  awk -v name="$NAME" -v title="$TITLE" -v desc="$DESCRIPTION" '
    { gsub(/__NAME__/, name); gsub(/__TITLE__/, title); gsub(/__DESCRIPTION__/, desc); print }
  ' "$tpl" > "$out"
}

render "${SCRIPT_DIR}/skill-template.md" "$SKILL_MD"
echo "wrote $SKILL_MD"

# ---- optional loop skeleton -------------------------------------------------
if [ "$WANT_LOOP" -eq 1 ]; then
  LOOP_MD="${REFS}/${NAME}.loop.md"
  if [ -f "$LOOP_MD" ]; then
    cp -p "$LOOP_MD" "${LOOP_MD}.bak.$(date +%Y%m%d-%H%M%S)"
  fi
  render "${SCRIPT_DIR}/loop-template.md" "$LOOP_MD"
  echo "wrote $LOOP_MD"
fi

# ---- chmod +x any scripts ---------------------------------------------------
find "$DEST" -name '*.sh' -type f -exec chmod +x {} +

# ---- install to the other two brains ---------------------------------------
install_to() {
  local root="$1" label="$2"
  if [ ! -d "$root" ]; then
    echo "skip $label: $root not present (brain not mounted?) — sync it later" >&2
    return 0
  fi
  mkdir -p "${root}/${NAME}"
  # mirror the dir; -R copies references/ too
  cp -R "${DEST}/." "${root}/${NAME}/"
  echo "installed -> ${root}/${NAME}"
}

install_to "$CODEX_SKILLS"  "codex"
install_to "$HERMES_SKILLS" "hermes"

echo
echo "DONE: skill '${NAME}' scaffolded + installed."
echo "Next: fill in the SKILL.md body, then re-run this script (or re-copy) to re-sync."
