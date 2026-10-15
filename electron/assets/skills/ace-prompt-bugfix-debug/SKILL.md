---
name: ace-prompt-bugfix-debug
description: Type-specific prompt enhancer for BUG-FIX / HARD-DEBUG / UNKNOWN-ROOT-CAUSE goals. Use after ace-prompt-enhancer classifies a request as a defect (taskType bugfix/debug) and before dispatching a Claude worker. Pins the WHAT that makes a fix trustworthy — exact repro, a reproducing test, root-cause naming, a minimal surgical diff — while leaving the hypothesis and investigation path open. Trigger on "fix this bug / crash / regression", "X is broken / wrong / flaky", "track down why...", or any defect with an unclear cause.
metadata:
  type: ace-skill
  tier: prompting
  tags: [ace, prompting, bugfix, debug, root-cause, repro, testing, claude]
---

# Ace bugfix-debug prompt enhancer

The domain specialization of `ace-prompt-enhancer` for **defect** work.
Debugging is where a vague brief produces a symptom-patch that masks the bug and
spawns three more — and a tight brief produces a named root cause, a test that
locks it, and a diff you can read in one sitting. The whole difference lives in
the WHAT you pin. The golden rule: **reproduce first, fix the ROOT CAUSE, prove
it with a test, ship the minimal diff.** No symptom-patching, ever.

Driver: **Claude** (debugging is ambiguity + judgment + unknown root cause —
`claude-codex-specialty-router` hard-routes hard debug to Claude). Effort:
**xhigh + UltraCode** (`/effort ultracode` prelude) for the hardest
unknown-root-cause cases; let the model think before it touches a line.

## Pin the WHAT (defect contract)
- **The EXACT repro**: numbered steps + the environment (OS, build, branch/SHA,
  data state) + **expected vs actual** + the verbatim error text / stack trace
  if any. A bug you cannot describe precisely is a bug you cannot fix.
- **A failing test**: point at an existing red test, or instruct the worker to
  **ADD one that captures the bug** before touching product code — the test is
  the contract, not the prose.
- **Minimal-diff, no scope-creep**: fix the bug, not the neighborhood. No adjacent refactor, no drive-by cleanup, no
  "while I'm here". Refactors are a separate task.
- **Blast-radius boundary**: name the files/modules in play (allowed) and the
  ones to **never touch** (frozen). Keep the change inside the fault.
- **Root-cause-in-the-trailer**: require the worker to state the actual cause in
  the `DONE:` trailer — "the why", not "fixed it".

## Leave OPEN (the worker's reasoning)
The root-cause **hypothesis**, the investigation path, and the fix approach.
This is precisely what you must NOT prescribe — handing the worker your guess
short-circuits the diagnosis. Pin the symptom
and the proof bar; leave the diagnosis to the debugger.

## Acceptance (defect, each a runnable check)
- `A1` **A reproducing test exists and now PASSES**: it was RED on the bug and is
  GREEN after the fix — give the exact command (e.g. `npm run test -- <file>`).
- `A2` **Full suite still green**: no regressions — the exact suite command runs
  clean.
- `A3` **Root cause named** in the `DONE:` trailer — the mechanism, not "fixed".
- `A4` **Minimal diff**: `git diff` touches only lines that trace to the bug; no
  adjacent refactor or formatting churn.
- `A5` **Build / typecheck green**: the exact build/typecheck command compiles
  with 0 errors.
- `A6` **PR opened** with the URL in the `DONE:` trailer (every agent produces a PR).

## Driver codewords (Claude)
`/effort ultracode` (prelude, hard cases) · "reproduce before you fix" · "think →
think harder → ultrathink for the root cause" · "minimal-diff, no adjacent
refactor" · "name the root cause, not the symptom". End with
`DONE: <root cause + fix + PR URL>` or `BLOCKED: <what's needed to reproduce>`.

## Hard rules
- No fix without a reproducing test — the test is the acceptance, not the claim.
- Fix the root cause, not the symptom — a patch that hides the failure is a regression.
- Minimal diff — refactors are a separate task.
- **BLOCK** if you cannot reproduce rather than guessing a fix into the dark.
- Reference skill ids (`ace-github-flow`) — never inline their bodies.

## References
- `ace-prompt-enhancer` — the general enhancer this specializes.
- `claude-codex-specialty-router` — why hard debug routes to Claude at xhigh/ultracode.
