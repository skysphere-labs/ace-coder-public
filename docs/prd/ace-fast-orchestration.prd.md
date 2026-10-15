# Ace Fast Orchestration PRD

Status: PRD/rubric for Mission `msn-e79f1677`, feature `ft-abcef54b`.
This document defines no runtime behavior by itself. It is the acceptance
contract for faster Ace orchestration waves.

Source anchors:

- Plan: `docs/ops/lean-wave-controller-rebuild-plan.md`
- Wave 1 report: `docs/history/lean-wave-controller-wave-1-report.md`
- Rubric: `.hermes/rubrics/2026-05-08-lean-wave-controller-rebuild-rubric.md`

## Problem

Slow orchestration waves drift when task specs, validators, Kanban rows,
Mission cards, PRs, and compaction resumes do not share a measurable definition
of done. The slow orchestration wave showed workers returning broad `DONE:` summaries,
validators relying on slow judgement where deterministic checks would do, and
stale resumes restarting from memory instead of live Mission, task, branch, and
PR state.

Fast orchestration makes each card gradeable before work starts, then keeps
that grade visible through Mission, Kanban, PR, and validation state.

## Goals

- Reduce worker-to-PR validation latency with deterministic evidence before
  human or Claude product judgement.
- Require every Mission feature to carry measurable success criteria, edge
  cases, allowed commands, and PASS/FAIL/BLOCKED criteria.
- Make Rook, worker, validator, Kanban, PR, and compaction handoffs reference
  the same Mission feature id and evidence packet.
- Prefer Codex/GPT validator-mergers for deterministic PR, GitHub, diff, and
  test work.
- Keep Kanban, Mission, task/worktree/stream, validation, and PR state visible
  and linked.

## Non-Goals

- No runtime code changes are specified by this PRD.
- No new agent provider, queue, MCP server, cloud service, hidden scheduler, or
  wave scheduler beside Ace Missions.
- No accepting worker `DONE:` as final wave validation.
- No automatic merge without a visible Mission feature, PR, evidence packet,
  and validator/merger decision.
- No rebuild, relaunch, deploy, credential access, browser automation, or
  external service usage as part of docs-only validation.

## Wave Model

Mission milestones are waves. Mission features are worker lanes. King/Rook are
controllers: they classify, anchor, dispatch, join, validate, fix back, and
report; they do not implement in the controller lane except for tiny emergency
operator fixes.

Use existing Ace systems:

- `electron/missions.cts`: milestone, feature, event, attachment, validator,
  and PR-link state.
- `tools/ace/src/prompt.cts`: rendered prompt character telemetry.
- `tools/ace/src/manifest.cts`: the four task-pack skill cap.
- `tools/ace/src/child-registry.cts`: worker lane tracking.
- `tools/ace/src/validation-artifacts.cts`: validation and fixback
  artifacts.

Validation is wave-level: dispatch independent lanes, join the whole milestone,
then run one validator-merger. Worker `DONE:` is lane evidence only. Validator
`FAIL` routes fixback to the same worker, branch, and PR unless the original
lane is unavailable or the failure requires a different specialist.

## Metrics

Track these fields per Mission feature or milestone:

| Metric | Target | Evidence |
| --- | --- | --- |
| `criteria_count` | At least 3 measurable criteria before dispatch | Task spec or Mission feature description |
| `edge_case_count` | At least 2 edge cases before dispatch | Task spec or rubric |
| `link_completeness` | 100% for active work | Mission feature has task/stream, branch/worktree, PR, and evidence links when stage-appropriate |
| `rendered_prompt_chars` | Worker <=1500; complex worker <=2200; validator <=1200 plus paths/PR ids; fixback <=800 | Prompt telemetry or Mission event |
| `validation_budget` | Docs/code checks under 10 minutes; UI/product judgement under 30 minutes | Validator packet timestamps or elapsed note |
| `fixback_count` | 0-2 same-worker fixbacks; third failure escalates | Mission events and validator packets |
| `stale_resume_rate` | 0 accepted stale resumes | Resume packet live recheck commands |

## Wave 1 Checkpoint

Final verdict: PASS after fixbacks.

Wave 1 validated the docs lane and four runtime lanes as one cohort:

- #168 aligned docs/rubric/playbook around Mission milestone waves, character
  budgets, wave validation, same-worker fixback, and prune-first doctrine.
- #169 added reachable mission wave dispatch, `WaveManifest/v1`, wave
  attachments, registry-visible `waveId`/`laneId`, and expected lane ids.
- #170 added role-aware prompt budget telemetry/enforcement.
- #171 added wave join/readiness gating, stale DONE reconciliation, wait
  timeout propagation, and `mission validate --wave` blocking for nonterminal
  or missing lanes.
- #172 added `WaveVerdict/v1` and same-worker `FixbackPacket/v1` derivation.

Final validation evidence: PRs #168-#172 had green `lint-and-build`, clean
merge state, and a synthetic sequential merge order of #168 -> #169 -> #170 ->
#171 -> #172 without conflicts. King did not merge during the run.

## No-Drift Rules

- Worker prompts include Mission id, feature id, branch/worktree target,
  deliverables, constraints, allowed verification, and trailer format.
- Worker, validator, and fixback prompts cite docs, paths, PR ids, and rubric
  paths instead of pasting full docs, diffs, skill bodies, or chat history.
- Validators inspect the diff or changed files before issuing PASS.
- Validators cannot substitute transcript review for file, diff, command, or
  PR evidence.
- Kanban rows count only when linked to a Ace Mission feature and at least
  one task, stream, branch, worktree, PR, or evidence field appropriate to the
  stage.
- Compaction resumes reread this PRD, the active task spec, and live
  Mission/task/branch/PR state before continuing.
- Codex/GPT validators are the default for deterministic docs/code/GitHub/test
  work. Claude validators are only for UI/product judgement or explicit Claude
  judgement tasks.
- LLM graders reason before scoring, score only PASS/FAIL/BLOCKED, and cite
  empirical evidence for each criterion.

## Risks

- Over-specification can slow small tasks. Mitigation: keep ordinary worker
  prompts <=1500 rendered characters and put shared doctrine in linked docs.
- Validator-mergers may over-trust green commands. Mitigation: require diff
  inspection and forbidden substitution checks.
- Kanban and Mission state can diverge. Mitigation: Mission feature state is
  authoritative for execution.
- Compaction can revive old assumptions. Mitigation: require live rechecks and
  block stale watchers from side effects.

## Rollback

Rollback remains PR-scoped until the cohort is merged:

1. Stop requiring the new rubrics in new worker/validator prompts.
2. Keep existing Mission, task, stream, worktree, and PR data unchanged.
3. Mark affected Mission features with `gate_status=blocked` and
   `gate_detail=fast-orchestration-rubric-disabled` if a wave was already
   dispatched under these docs.
4. Revert only the docs PR if the doctrine is rejected; do not modify runtime
   state as rollback for this document.

## Acceptance

PASS requires goals, non-goals, wave model, metrics, no-drift rules, risks,
rollback, and acceptance to be present and measurable from task specs, files,
command output, Mission rows, PR state, or validator packets.

FAIL if the document authorizes hidden work, unlinked Kanban execution,
automatic external service use, transcript-only validation, worker `DONE:` as a
wave verdict, or a new scheduler beside Ace Missions.
