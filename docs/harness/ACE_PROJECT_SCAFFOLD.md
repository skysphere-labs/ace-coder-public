# Ace Project Scaffold

Status: canonical scaffold for a Ace-managed application project.

## Files

The default project harness lives in `.ace-template/` and initializes a project-local `.ace/` directory:

```text
.ace/
  PROJECT_BRIEF.md
  ARCHITECTURE_RULES.md
  FEATURES.json
  WAVE_PLAN.yaml
  PROGRESS.md
  DECISIONS.md
  OPEN_QUESTIONS.md
  WIKI_INDEX.md
  WORKFLOW.md
  AGENT_ROSTER.json
  EVENT_TRIGGERS.json
  run/
  memory/
  wiki/
  init.sh
```

Run from a target repo:

```bash
/path/to/ace/scripts/init-ace-project-harness.sh --project <name>
```

The script copies `.ace-template/`, creates runtime folders, runs
`.ace/init.sh`, and preserves existing project files unless `--force` is passed.

## Worker Read Order

Every worker reads:

1. `.ace/PROJECT_BRIEF.md`
2. `.ace/ARCHITECTURE_RULES.md`
3. `.ace/FEATURES.json`
4. `.ace/WAVE_PLAN.yaml`
5. `.ace/PROGRESS.md`
6. `.ace/WORKFLOW.md`
7. `.ace/DECISIONS.md`
8. task-specific files

## Feature Checks

`FEATURES.json` is the project acceptance checklist. Features start with `passes: false`. Builders may add evidence to completion artifacts, but only validator roles may mark a feature passing.

## Waves

`WAVE_PLAN.yaml` records the execution shape. The default is simple-first: one GoalAgent, one branch/PR, then one validator-fixer-merger. External Ace worker waves are explicit escalations for independent large work only.

## Runs

Each worker run writes:

```text
.ace/run/<runId>/completion.json
.ace/run/<runId>/trace.ndjson
.ace/run/<runId>/evidence.md
.ace/run/<runId>/validation.json
```

Evaluators run `ace task validate --run <runId> --feature <featureId>` before any feature is marked passing. A passing verdict emits `feature.passed`; a failing verdict emits `feature.failed` so the default fixback trigger can respond.

## Memory And Wiki

Workers and validators may propose durable lessons through `CompletionResult.memoryCandidates[]` or suggested wiki deltas. Hermes reviews, dedupes, and promotes approved lessons into `.ace/wiki/`, then updates `WIKI_INDEX.md`.

## Event Triggers

`EVENT_TRIGGERS.json` is deterministic JSON, not a general rules engine. The default scaffold includes:

- legacy worker DONE -> spawn evaluator (disabled by default)
- legacy feature failed -> send fixback (disabled by default)
- feature passed -> notify Hermes to review wiki/status updates

Handlers should stay explicit and testable.
