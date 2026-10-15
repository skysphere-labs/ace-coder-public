# launch-and-drive — concrete reference

Operational detail behind the behavioral-test loop. Ground truth:
`tools/ace/src/goal-validation-policy.cts` (the gate's artifact readers)
and the `ace browser` CLI — read them if anything here looks stale.

## 1. Launch the exact produced code

```bash
# Step 0 — provision the worktree (worktrees have no node_modules)
bash scripts/provision-worktree.sh <worktree>

# Pin to the VALIDATED head SHA (not a moving branch tip)
git fetch origin
git checkout <validated-head-sha>

# Every round — dev run (isolated userData/socket per worktree)
npm run dev

# FINAL pre-merge round ONLY — packaged-from-branch boot proof:
npm run package:branch
# The script writes .ace/goals/<missionId>/validator/<featureId>/branch-proof.json
# (script-written; required for auto-chain merges). It never touches
# /Applications or the live app.
```

Confirm the app actually reached a healthy state. A window that never appears,
a boot that throws, or a main-process crash IS a finding — record it and return
request-changes. (CI-green + boot-crash is exactly the dev.51 failure this tier
exists to catch.)

## 2. Verify-at-start regression smoke (the 3 fixed steps)

Before testing the new feature, run the previous release's critical path:

1. **App boots healthy** — window appears, no fatal during startup.
2. **Chat overlay opens** — the core interaction surface still works.
3. **No main-process fatal** — console/log shows no main-process crash.

A regression here is REQUEST-CHANGES even if the new feature works. Record the
result as `regressionSmoke` in completion.json — the gate enforces
`regressionSmoke.passed=true` for UI runs.

## 3. Drive via `ace browser`

The validator drives the REAL dev-run app through the `ace browser` CLI —
no bridge, no separate harness:

- `ace browser list` — find the running app's targets/windows.
- `ace browser open` — open/navigate to the surface under test.
- `ace browser wait` — wait for the control named in the test plan steps.
- `ace browser elements` — locate and interact with the real control.
- `ace browser screenshot` — capture before/after evidence.
- `ace browser console` — capture console errors (boot/main-process fatals).

Follow the test plan's `steps` exactly; the `expected` observable is what you
screenshot/capture. CLI and API artifacts need no browser at all — run the real
command / call the real endpoint and capture stdout/exit code or the response.

## 4. completion.json (the evidence bundle)

Write it to the EXACT path named in the spec Inputs. Under a mission this is
typically `.ace/goals/<missionId>/validator/<featureId>/computer-use/completion.json`;
under the **run-ledger spine** (no mission) the spec names
`.ace/computer-use/completion.json` relative to your worktree root. Either
way the gate AND the autonomy loop read that deterministic path, never your prose.

```json
{
  "schema": "ace.computer_use_behavioral_validation.v1",
  "artifactType": "UI",
  "validatedHeadSha": "<sha>",
  "launch": { "mode": "npm run dev", "healthy": true, "notes": "window up, no boot error" },
  "regressionSmoke": { "passed": true, "notes": "boots healthy; chat overlay opens; no main-process fatal" },
  "checkedAcceptance": [
    { "id": "A3", "status": "pass", "evidence": "screenshots/a3-after.png" },
    { "id": "A4", "status": "pass", "evidence": "stdout: exit 0, new flag listed" }
  ],
  "screenshots": ["screenshots/a3-before.png", "screenshots/a3-after.png"],
  "capturedOutput": null,
  "passed": true,
  "followups": [
    "the toggle does not persist across a window reload",
    "no empty-state copy when the list is empty"
  ],
  "proposedNextGoal": "Persist the dark-mode toggle across reloads and add empty-state copy, then re-run the behavioral test",
  "taskId": "<task>",
  "missionId": "<mission>"
}
```

`followups` + `proposedNextGoal` feed the **autonomy outer loop** (when armed with
`run submit --auto-iterate`). They are ADVERSARIAL, not a courtesy: actively HUNT
for new gaps, regressions, and edge cases the worker missed or that surfaced only
under real use — beyond the original acceptance criteria. List each as a short,
de-duplicated `followups[]` entry. `proposedNextGoal` is the single best next goal,
phrased the way the owner would write it (concrete, outcome-first). If the feature
is genuinely complete and you found nothing new, OMIT both (empty `followups`) — a
clean pass with no new gaps is how the loop CONVERGES and stops. These are additive
fields; the merge gate ignores them (it still keys on schema/sha/acceptance).

Rules the gate enforces:

- must be at the validated head (`validatedHeadSha` matches);
- `checkedAcceptance` (`[{id, status, evidence}]`) must cover EVERY behavioral
  A-ID, every entry passing for a pass;
- UI runs require `regressionSmoke.passed=true`;
- there is no `packagedBoot` field — the packaged-boot proof is the separate
  script-written `branch-proof.json` from `npm run package:branch`.

For CLI/API artifacts, drop the screenshots and put stdout/exit-code or the
response body in `capturedOutput` and the per-ID `evidence` pointers.

## 5. Return

Per-criterion `A<i>: MET/UNMET` lines, then the single trailer per the SKILL
verdict contract. Never fix; never test anything other than the real produced
surface at the validated head.
