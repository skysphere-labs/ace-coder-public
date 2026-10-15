# Ace Prune Plan

Status: active first-pass prune plan for the harness rebuild.

## Evidence Baseline

Knip was run before pruning:

```bash
npx --yes knip --no-exit-code
```

Result summary:

- 51 unused files reported.
- 5 unused dependencies reported.
- 2 unlisted dependencies reported.
- 4 unused exports reported.
- 59 unused exported types reported.

The reported unused files include active Electron and CLI entry points such as `electron/main.cts`, `electron/local-core.cts`, `electron/skills-core.cts`, `tools/ace/src/index.cts`, and `tools/ace/src/commands.cts`. These are load-bearing but invisible to Knip's current project graph. They are not deletion candidates from this result alone.

## First-Pass Prune Decision

No runtime code is deleted in this slice.

Safe first-pass cleanup is limited to:

- creating canonical harness docs
- adding project scaffold templates
- adding schema files and smoke tests
- shortening root doctrine references
- marking older docs as superseded where replacements exist

## Immediate Candidates

### Harness Docs

Canonical replacement:

- `docs/harness/ACE_HARNESS_BLUEPRINT.md`
- `docs/harness/ACE_GOAL_PROTOCOL.md`

Superseded docs already deleted after reference updates:

- `docs/harness-sdk-overview.md`
- `docs/ace-sdk-architecture.md`
- `docs/harness/handoff-trace-schema.md`
- `docs/cli-orchestrator-code-paths.md`

Historical skill-routing docs already deleted after the bundled
`ace-subagent-prompting` and `ace-cli` skills became canonical.

Deletion gate for a later PR:

- replacement exists
- references updated
- `rg` proves no tooling depends on old paths
- lint, build, and targeted docs/tests pass

### Delegation Doctrine

Canonical replacements:

- `AGENTS.md`
- `docs/harness/ACE_GOAL_PROTOCOL.md`

Keep runtime skills, but make future edits reference the protocol rather than restating full doctrine in every skill.

### Skill Catalog Bloat

Keep bundled runtime skills. Optional external marketplace/reference skills should remain disabled-by-default reference entries unless explicitly requested by a task.

Do not split or delete `electron/skills-catalog.json` until `skills-core` and catalog UI have tests for the split shape.

## Medium-Risk Candidates

These require separate PRs:

- Plugins/MCP management UI simplification while keeping `skills-core`.
- Mission Library simplification after a compact wave/task dashboard exists.
- `ace` metadata slimming without changing command behavior.

## High-Risk Candidates

Do not prune without explicit feature-retirement approval:

- Remote/PWA/SSH surface
- GitHub explorer/account UI
- broad workspace orchestrator runtime
- advanced `ace` verbs
- broad `electron/local-core.cts` deletion

## Rollback

Because this slice adds docs, templates, and tests without deleting runtime behavior, rollback is a git revert of the harness artifact commit.
