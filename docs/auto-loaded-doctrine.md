# Auto-Loaded Doctrine

Ace keeps durable worker doctrine in repo-root driver files plus bundled skills, not in every task prompt. That lets every git worktree inherit the same rules automatically while task prompts stay focused on the work at hand.

## Pattern

| Layer | Ace mechanism | Repo path(s) | Driver behavior |
| --- | --- | --- | --- |
| Repo-root doctrine | Commit driver-native doctrine files at the repo root | `CLAUDE.md`, `AGENTS.md` | Claude Code auto-reads `CLAUDE.md`; Codex, Cursor, and similar workers auto-read `AGENTS.md` from the worktree root. |
| Bundled skills | Ship SKILL.md assets with the app, then materialize them into driver-native skill homes | `electron/assets/skills/<id>/SKILL.md`, `electron/skills-core.cts` | Ace mounts the baseline pack into `~/.claude/skills/<id>/SKILL.md`, `~/.codex/skills/<id>/SKILL.md`, and sibling driver homes. |
| Task prompt | Carry only task-specific context | task specs, mission prompts, inline goals | Prompts contain the goal, local constraints, and acceptance criteria for that task, not global doctrine repeated every run. |

## Lifecycle

1. Worktree creation clones the repo state into `.ace/worktrees/...`, so git-tracked doctrine files like `CLAUDE.md` and `AGENTS.md` come along automatically.
2. Ace seeds bundled skills from `electron/assets/skills/`, and `electron/skills-core.cts` copies them into each driver's native skills directory.
3. When the driver starts, it reads its repo-root doctrine file plus whatever `SKILL.md` files exist in its native home.
4. Per-task prompts add only the delta: goal, task-local context, deliverables, and acceptance criteria.

## Why This Split Works

- Doctrine is versioned with the repo, so every worktree sees the same worker rules.
- Skills stay driver-native, which keeps compatibility with Claude, Codex, Cursor, Gemini, and the rest of Ace's driver set.
- Prompts stay short because house rules are not repasted into every delegated task.
- Doctrine changes are normal git changes, not hidden runtime prompt state.

## Comparison

| System | Doctrine surface | Skill or agent-pack surface | Similarity to Ace |
| --- | --- | --- | --- |
| Ace | Repo-root `CLAUDE.md` and `AGENTS.md` | `electron/assets/skills/` materialized by `electron/skills-core.cts` into `~/.claude/skills/`, `~/.codex/skills/`, and other driver homes | Native-driver auto-load for both repo doctrine and bundled skills. |
| OpenHands | Repo-local instructions plus `.openhands/microagents/` | `.openhands/microagents/` | Same durable pattern: workers discover repo-local doctrine and agent packs without each task prompt inlining them. |

## Relevant Files

- `CLAUDE.md`: canonical Claude doctrine for this repo.
- `AGENTS.md`: driver-agnostic sibling for Codex, Cursor, and similar workers.
- `electron/skills-core.cts`: maps bundled skills into driver-native homes such as `~/.claude/skills/` and `~/.codex/skills/`.
- `electron/assets/skills/`: source of truth for bundled `SKILL.md` assets Ace ships.

## Guardrail

`electron/local-core.cts` performs a post-worktree preflight that checks for `CLAUDE.md` and `AGENTS.md` inside the new worktree. Missing doctrine produces a loud `console.warn` pointing to this document, but it never blocks worktree creation because some repos may intentionally ship only one driver file.
