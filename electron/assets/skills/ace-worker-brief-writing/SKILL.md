---
name: ace-worker-brief-writing
description: Write a tight brief/TaskSpec for a single EXTERNAL Ace build worker - the 6-field skeleton, capability-card prompt doctrine, referenced skill ids, and compact driver hints.
---

# Ace Worker Brief Writing

How to brief ONE external build worker dispatched as its own Ace tab. This
replaces `ace-subagent-prompting`.

This is for briefing a single dispatched worker. It is NOT for nested sub-agent
dispatch. The build worker owns one root GoalAgent lane, including validation
inside root GoalAgent. Internal helpers are optional evidence-gathering tools,
not a separate Mission or merge authority.

## 6-field skeleton

Every brief is exactly six fields. If a field is empty, the brief is not ready.
FAIL-CLOSED: if acceptance (Done-when) or boundaries/allowed-paths is empty, the
brief is BLOCKED, not sent.

1. goal - one measurable sentence. If it joins unrelated subsystems, it is two
   briefs; split it.
2. acceptance criteria (Done-when) - binary checks the worker self-verifies and
   the validator grades against. These ARE the PRD contract. Carry STABLE IDs
   VERBATIM so the four files interlock: A1, A2, A3, ... (one per criterion),
   with A0 reserved for "no out-of-scope change". Each A-ID is a RUNNABLE check:
   state the exact command OR example input->output. The FINAL A-ID is always an
   E2E "the feature actually runs in the built app" check (closes the
   CI-green-but-broken-at-boot class). The worker copies these IDs verbatim,
   self-checks each before DONE, and reports `A<i>: pass/fail`; the validator
   grades the SAME IDs against the diff. Attach the `behavioral` block
   alongside acceptance (per A-ID: id/artifactType/steps/expected/evidence),
   copied VERBATIM from the PRD's Behavioral Test Plan — `parseSpec` transports
   it and the runtime materializes `acceptance.json` from it.
3. output format - the exact shape of the deliverable: trailer, expected diff
   surface, file/format of any artifact, test/command output to paste. A
   first-class field, not folded into constraints.
4. boundaries (allowed / never-touch) - THREE TIERS, a first-class field, not
   folded into constraints: ALWAYS-EDIT (in scope) / ASK-FIRST (touch only with
   a noted reason) / NEVER-TOUCH (main/prod, unrelated subsystems, lockfiles,
   secrets). Name the concrete paths per tier; do not make the worker hunt.
5. constraints / non-goals - remaining hard rules only: no rebuild, no new
   dependency/daemon, no app relaunch, plus an explicit non-goals list so the
   worker does not over-build. (Path scope now lives in boundaries.)
6. context / file map - non-derivable facts only: workspace, base branch/PR,
   and owner intent.

## Reference skill ids, do not paste doctrine

Cite skill ids; never inline their text. The worker materializes them itself.

- `ace-task-worker` - trailer contract, acceptance verification, PR handoff.
- `ace-github-flow` - branch, PR, GitHub Actions/current-head, and merge-gate evidence.
- Mention at most four task-pack skill ids; baseline skills are already mounted.

## Driver pack

Pick the driver (`driverPack: claude|codex`); codewords doctrine is
`ace-prompt-enhancer/references/codewords.md` — the runtime injects the
full pack from `tools/ace/src/driver-packs.cts`; never paste pack blocks
into the brief.

## Capability cards and PR handoff

Add only the capability cards that fit the task:

- `validation` - always for code/product work; prove acceptance with commands,
  tests, or observable behavior inside the root GoalAgent.
- `browser/computer-use` - for user-visible UI, browser, desktop, or runtime
  behavior; capture screenshot/flow evidence when available, or name the exact
  blocker when the required tool is unavailable.
- `GitHub Actions/current-head` - for PR/CI work; cite the current PR head SHA,
  changed files, and check state when CI exists.
- `security`, `Clawpatch`, or `dynamic workflow` - only when owner policy, risk,
  or scale calls for it.

For PR work, tell the worker to use the Ace integration gateway for scoped
push/PR handoff and to report evidence. Do not promise merge ownership or make a
separate validator/merge lane the ordinary default.

## Skill routing

Pick 1-4 optional skills that match the capability cards:

- UI/web/runtime behavior: frontend/design/browser QA skills as relevant.
- PR/CI work: `ace-github-flow`, `autoreview`, or GitHub workflow skills.
- Security/auth/infra/customer data: security review skills and Clawpatch-if-policy.
- Broad migrations/refactors: `ace-internal-subagents` only when workflow
  fan-out or repeatable verification actually helps.
- Small deterministic fixes: debugging, TDD, and surgical-change skills.

If a useful skill is unavailable and not required by policy, continue with repo
inspection and direct verification. If policy requires the missing skill, emit
`BLOCKED:` with the exact missing capability.

## Keep it small

- Normal brief target: <=1,500 rendered chars.
- Complex brief soft cap: <=2,200 chars; hard cap 3,000 without explicit reason.
- Context is only what the worker cannot cheaply derive from the repo.
- Constraints are task-specific boundaries, not copied doctrine.
- Require the exact final trailer:
  - `DONE: <one-line summary>`
  - `BLOCKED: <one-line reason>`

## Good compact brief

```json
{
  "schema": "TaskSpec/v1",
  "goal": "Fix Codex error misclassification in the TUI prompt path.",
  "baseBranch": "main",
  "role": "editor",
  "acceptance": [
    "A1: targeted regression test passes — `npm run test -- prompt-classify`",
    "A2: clean fatal input still flagged — input `panic: x` -> classified fatal",
    "A3 (E2E): `npm run build` then launch built app, run a prompt, no false fatal in TUI"
  ],
  "behavioral": [
    { "id": "A3", "artifactType": "UI", "steps": "launch built app; submit prompt `panic: x` in the TUI", "expected": "prompt completes; no false-fatal banner", "evidence": "screenshot" }
  ],
  "outputFormat": "Unified diff under tools/ace/src/** plus pasted test+build output; end with DONE/BLOCKED trailer.",
  "boundaries": {
    "alwaysEdit": ["tools/ace/src/**"],
    "askFirst": ["tools/ace/test/** (only to extend the regression case)"],
    "neverTouch": ["main/prod config", "package-lock.json", "unrelated subsystems"]
  },
  "constraints": ["surgical", "no unrelated refactors", "no app relaunch"],
  "nonGoals": ["no error-handling rewrite", "no new logging framework"],
  "context": "Error regex is too broad; keep real fatal detection.",
  "driverPack": "codex",
  "skills": ["ace-task-worker"]
}
```

## Checklist before sending

- All six fields present and the goal is one sentence.
- Acceptance carries stable A-IDs (A1, A2, ...; A0 = no out-of-scope change),
  each a runnable check, and the FINAL A-ID is the E2E "runs in the built app"
  check. The worker self-checks `A<i>: pass/fail`; the validator grades the same
  IDs against the diff.
- Output format and boundaries (allowed/never-touch, three tiers) are first-class
  fields, not folded into constraints.
- FAIL-CLOSED: if acceptance or boundaries is empty, emit BLOCKED, do not send.
- Constraints and non-goals are explicit; non-goals prevent over-build.
- Skills are referenced by id, not inlined.
- `behavioral` is copied VERBATIM from the PRD's Behavioral Test Plan.
- `driverPack` is set; no pack blocks pasted (the runtime injects them).
- The brief states root validation evidence and PR handoff responsibilities.
- The worker must end with exactly one DONE/BLOCKED trailer.

## References

- `ace-task-worker`
- `ace-validator-worker`
- `ace-runtime-contract`
