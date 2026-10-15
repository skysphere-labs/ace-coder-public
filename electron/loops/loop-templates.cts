// loop-templates — the built-in EDITABLE code-kind loop templates seeded into the
// catalog alongside the kind:'system' maintenance loops (PRD §10).
//
// Unlike the system builtins (which run an in-process aceStore method and are
// locked in the UI via builtin:true), these are ordinary kind:'code' LoopSpecs: a
// starting point the operator can forge over, edit, or delete. They map 1:1 onto the
// canonical agentic-loop archetypes (WS-F research §3 "loop archetypes"):
//
//   loop-validate-park  builder → validator cycle; parks at ready_to_review on a
//                        validator PASS (evaluator-optimizer / builder-reviewer).
//   loop-ci-harden      re-run the repo checks and fix failures until green for 3
//                        consecutive iterations (optimize-to-threshold).
//   loop-docs-sweep      docs↔code drift scan → one bounded fix per sweep; stops when
//                        a sweep finds nothing (cadence maintenance sweep).
//   loop-dep-triage     one dependency bump per iteration, verified in isolation;
//                        stops when the queue is empty (triage / queue-driven).
//
// SAFETY (loop-spec §7): every template requests ZERO owner-approval permissions and
// carries an owner-gated merge with NO tokenRef, so a converged code iteration PARKS
// at ready_to_review and the operator merges it. NO template ever sets ownerApproved.
// Every template passes validateLoopSpec (loop-templates.test.cts asserts this).
//
// PURITY: a plain data module — no I/O, no clock, no Electron. loops-service seeds
// these through its idempotent seedBuiltins (which never clobbers an operator edit),
// the same path the system builtins take.

import type { LoopSpec } from './loop-spec.cts';

// A PLACEHOLDER execution target: the checkout root. code-kind loops require a
// routing.target.repo to validate, but a starter template does not know the project
// yet — edit routing.target.repo (and optionally routing.target.workspaceId to a real
// projects.id) before running a template against a specific project, else the loop
// falls back to the injected spine workspace (ACE_SPINE_WORKSPACE_ID).
const TEMPLATE_REPO_PLACEHOLDER = '.';

export const CODE_LOOP_TEMPLATES: LoopSpec[] = [
  {
    id: 'loop-validate-park',
    name: 'Validate & Park',
    description:
      'Builder → validator cycle over the run-ledger spine. Each iteration implements the requested change on a branch, then a validator verifies it against the acceptance criteria. Converges on a validator PASS and PARKS the PR at ready_to_review — it never merges (owner-gated).',
    useWhen:
      'You have a scoped change or feature to build and want a builder→validator loop that stops when the validator passes and the work is parked at ready_to_review for your review. It never merges.',
    kind: 'code',
    inputs: {
      type: 'object',
      properties: { feature: { type: 'string', description: 'What to build (fills {{feature}} in the goal).' } },
    },
    goalTemplate:
      'Iteration {{iteration}}: implement the requested change ({{feature}}) on a branch, open a PR, and have a validator verify it against the acceptance criteria. Prior outcome: {{priorOutcome}}. Stop when the validator PASSES and the PR is parked at ready_to_review. Do not merge.',
    routing: {
      agent: 'auto',
      skills: ['ace-agent-pack-engineer'],
      workspace: 'loops',
      target: { repo: TEMPLATE_REPO_PLACEHOLDER, allow: ['**'] },
    },
    contract: {
      stop: { primary: 'converged' },
      ceilings: {},
      verify: { requireValidatorPass: true, requireComputerUseEvidence: false },
      permissions: [],
      merge: { ownerGated: true },
    },
    evidence: {
      type: 'object',
      properties: {
        criteria: {
          type: 'string',
          const: 'A validator PASS on the exact head plus a PR parked at ready_to_review.',
        },
      },
    },
    builtin: false,
    meta: { version: 1 },
  },
  {
    id: 'loop-ci-harden',
    name: 'CI Harden',
    description:
      "Re-run the repository's checks (lint, typecheck, tests) and fix failures until they pass green for 3 consecutive iterations (optimize-to-threshold). Parks for review; never merges.",
    useWhen:
      'The repository checks are flaky or red and you want a loop that re-runs them and fixes failures until they are green for 3 consecutive runs. It parks for review and never merges.',
    kind: 'code',
    inputs: { type: 'object', properties: {} },
    goalTemplate:
      'Iteration {{iteration}}: run the repository checks (lint, typecheck, tests). If any fail, make the MINIMAL fix and re-run. Prior outcome: {{priorOutcome}}. Stop only once the checks pass green for 3 consecutive iterations, attaching the command output as evidence. Do not merge.',
    routing: {
      agent: 'auto',
      skills: ['gh-fix-ci'],
      workspace: 'loops',
      target: { repo: TEMPLATE_REPO_PLACEHOLDER, allow: ['.github/**', 'src/**', 'tests/**', 'test/**'] },
    },
    contract: {
      stop: { primary: 'converged' },
      ceilings: { maxIterations: 15 },
      verify: { requireValidatorPass: true, requireComputerUseEvidence: false },
      permissions: [],
      merge: { ownerGated: true },
    },
    evidence: {
      type: 'object',
      properties: {
        criteria: {
          type: 'string',
          const: 'All repository checks green for 3 consecutive iterations, with the command output attached.',
        },
      },
    },
    builtin: false,
    meta: { version: 1 },
  },
  {
    id: 'loop-docs-sweep',
    name: 'Docs Sweep',
    description:
      'Scan for documentation that has drifted from the code, make ONE bounded documentation fix per iteration, and leave a PR-ready branch. Stops when a full sweep finds no remaining drift (a clean no-op sweep). Parks for review.',
    useWhen:
      'Documentation may have drifted from the code and you want a loop that finds drift, fixes exactly one bounded item per iteration, and stops when a sweep finds nothing left to fix. It parks for review.',
    kind: 'code',
    inputs: {
      type: 'object',
      properties: { area: { type: 'string', description: 'Optional docs area to scope the sweep (fills {{area}}).' } },
    },
    goalTemplate:
      'Iteration {{iteration}}: scan {{area}} for documentation that has drifted from the code. Fix exactly ONE bounded drift item and update the affected docs on the branch. Prior outcome: {{priorOutcome}}. Stop when a full sweep finds no remaining drift (a clean no-op sweep). Do not merge.',
    routing: {
      agent: 'auto',
      skills: [],
      workspace: 'loops',
      target: { repo: TEMPLATE_REPO_PLACEHOLDER, allow: ['docs/**', 'README.md', '**/*.md'] },
    },
    contract: {
      stop: { primary: 'no-progress' },
      ceilings: { maxIterations: 20 },
      verify: { requireValidatorPass: false, requireComputerUseEvidence: false },
      permissions: [],
      merge: { ownerGated: true },
    },
    evidence: {
      type: 'object',
      properties: {
        criteria: {
          type: 'string',
          const: 'A PR-ready branch with one documentation drift fixed, or a clean sweep reporting no remaining drift.',
        },
      },
    },
    builtin: false,
    meta: { version: 1 },
  },
  {
    id: 'loop-dep-triage',
    name: 'Dependency Triage',
    description:
      'Bump ONE dependency per iteration, verify it in isolation (install + checks), and stop when the pending-update queue is empty (triage / queue-driven). Risk-ordered, one item per iteration; parks for review.',
    useWhen:
      'You have a backlog of dependency updates and want a loop that bumps one dependency per iteration, verifies it in isolation, and stops when the queue is empty. It parks for review and never merges.',
    kind: 'code',
    inputs: { type: 'object', properties: {} },
    goalTemplate:
      'Iteration {{iteration}}: pick the highest-priority pending dependency update, bump exactly ONE dependency, and verify it in isolation (install + checks). Prior outcome: {{priorOutcome}}. Stop when no pending dependency updates remain (the queue is empty). Do not merge.',
    routing: {
      agent: 'auto',
      skills: [],
      workspace: 'loops',
      target: { repo: TEMPLATE_REPO_PLACEHOLDER, allow: ['package.json', 'package-lock.json', 'src/**'] },
    },
    contract: {
      stop: { primary: 'no-progress' },
      ceilings: { maxIterations: 25 },
      verify: { requireValidatorPass: false, requireComputerUseEvidence: false },
      permissions: [],
      merge: { ownerGated: true },
    },
    evidence: {
      type: 'object',
      properties: {
        criteria: {
          type: 'string',
          const: 'One dependency bumped and verified in isolation per iteration; a queue-empty report when done.',
        },
      },
    },
    builtin: false,
    meta: { version: 1 },
  },
];

// loop-ship — the ONE end-to-end auto-merge ship loop (owner-approved 2026-07-02).
//
// Unlike the four PARKING templates above (which request ZERO owner-approval
// permissions and carry NO merge tokenRef, so they PARK at ready_to_review), this
// loop takes a coding goal all the way to main with NO human code review: worker →
// computer-use validator → PR → CI gate → (failing checks / Clawpatch findings
// become the next iteration's fixback goal) → AUTO-MERGE when every gate is green.
//
// SAFETY — every merge precondition is fail-closed and INHERITED from the spine, so
// this template does NOT weaken any gate:
//   · merge_to_main is requested WITH an explicit owner ack (ownerApproved:true);
//     without the ack validateLoopSpec fail-closes UNSAFE_REQUIRES_APPROVAL.
//   · contract.merge.tokenRef:'autoship' is only a NAME. The spine's release()
//     resolves the real token at runtime (env ACE_OWNER_AUTH_TOKEN → ops-config
//     autoship.token) via ownerAuthorizedBypass; no token configured ⇒ the run
//     PARKS at ready_to_review exactly like the others. The secret never touches
//     this spec, the catalog, or the ledger.
//   · the reconciler routes to the merge ONLY when pr.checkState==='success' AND
//     the PR is mergeable (orchestration-policy.releaseDecisionAfterValidation), so
//     a RED CI can never be admin-merged — it parks and the loop fixes it back.
//   · requireComputerUseEvidence:true — the validator must attest a real behavioral
//     test before the loop can converge (loop-controller convergence gate).
//
// Edit routing.target.repo (+ routing.target.workspaceId to a real projects.id)
// before running, or pass --input workspace=<id>; the goal + optional allow scope
// define what the worker may touch.
export const SHIP_LOOP_TEMPLATE: LoopSpec = {
  id: 'loop-ship',
  name: 'Ship (auto-merge)',
  description:
    'Take a coding goal end-to-end to main with ZERO human code review: implement on a branch, validate with computer-use evidence, open a PR, gate on CI, turn failing CI checks and Clawpatch findings into the next iteration\'s fixback goal, and AUTO-MERGE to main once every gate is green. Owner-approved full auto-merge (2026-07-02). Fail-closed: no owner token configured ⇒ it parks at ready_to_review exactly like the parking loops.',
  useWhen:
    'You have a coding goal you want shipped to main autonomously — implemented, computer-use validated, CI-gated, and merged with no human code review — and you have configured the owner auto-ship token (env ACE_OWNER_AUTH_TOKEN or ops-config autoship.token). Without a token it still runs but parks at ready_to_review.',
  kind: 'code',
  inputs: {
    type: 'object',
    required: ['goal', 'workspace'],
    properties: {
      goal: { type: 'string', description: 'The coding goal to ship (fills {{goal}}).' },
      workspace: { type: 'string', description: 'Execution project id (a real projects.id) to spawn the worker worktree from.' },
      allow: { type: 'string', description: 'Optional comma/space-separated path scopes the worker may edit (narrows the default **).' },
    },
  },
  goalTemplate:
    'Iteration {{iteration}}: ship this coding goal end-to-end — {{goal}}. Implement it on a branch, open a PR, and have the computer-use validator verify it against the acceptance criteria with real behavioral evidence. Prior outcome: {{priorOutcome}}. When CI is green and the validator PASSES, the loop auto-merges to main; if CI checks fail or the validator requests changes, fix them and continue. Do not stop until the change is merged or genuinely blocked.',
  routing: {
    agent: 'auto',
    skills: ['ace-agent-pack-engineer', 'ace-computer-use-validator'],
    workspace: 'loops',
    target: { repo: TEMPLATE_REPO_PLACEHOLDER, allow: ['**'] },
  },
  contract: {
    stop: { primary: 'converged' },
    // Sane ceiling so a goal that can't be shipped stops instead of burning
    // iterations; the PRIMARY stop stays converged/no-progress (loop-controller).
    ceilings: { maxIterations: 6 },
    verify: { requireValidatorPass: true, requireComputerUseEvidence: true },
    permissions: ['merge_to_main'],
    // tokenRef is a NAME only — the real token is resolved at runtime by the spine
    // (ownerAuthorizedBypass), never persisted here or in the catalog.
    merge: { ownerGated: true, tokenRef: 'autoship' },
  },
  evidence: {
    type: 'object',
    properties: {
      criteria: {
        type: 'string',
        const:
          'The change is merged to main after a computer-use validator PASS at the exact head and green CI — or the run parks/blocks with the exact reason.',
      },
    },
  },
  builtin: false,
  // Explicit owner ack of the merge_to_main permission (validateLoopSpec §7).
  ownerApproved: true,
  meta: { version: 1, note: 'owner-approved full auto-merge when all gates green (2026-07-02)' },
};

// Every seedable code template: the four parking starters PLUS the owner-approved
// ship loop. loops-service seeds this whole set idempotently.
export const ALL_LOOP_TEMPLATES: LoopSpec[] = [...CODE_LOOP_TEMPLATES, SHIP_LOOP_TEMPLATE];

module.exports = { CODE_LOOP_TEMPLATES, SHIP_LOOP_TEMPLATE, ALL_LOOP_TEMPLATES };
