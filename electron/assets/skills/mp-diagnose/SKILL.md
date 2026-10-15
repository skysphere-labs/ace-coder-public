---
name: mp-diagnose
description: Systematic debugging and regression discipline (Matt Pocock "diagnose"). A six-phase loop for hard bugs and perf regressions — build a feedback loop, reproduce, hypothesise, instrument, fix + regression-test, cleanup + post-mortem. Use when a worker is debugging a non-trivial bug or a regression.
---

# Diagnose (vendored: mattpocock/skills `diagnose`)

A discipline for hard bugs. Skip phases only when explicitly justified. When
exploring the codebase, use the ace-ops wiki glossary for a clear mental model
of the relevant modules, and check wiki ADRs in the area you touch.

## Phase 1 — Build a feedback loop

**This is the skill.** Everything else is mechanical. With a fast, deterministic,
agent-runnable pass/fail signal you will find the cause; without one, staring at
code will not save you. Spend disproportionate effort here. **Be aggressive. Be
creative. Refuse to give up.**

Ways to construct one, roughly in order of preference:
1. Failing test at whatever seam reaches the bug (unit / integration / e2e).
2. Curl / HTTP script against a running dev server.
3. CLI invocation with a fixture input, diffing stdout vs a known-good snapshot.
4. Headless browser script (Playwright / Puppeteer) asserting DOM/console/network.
5. Replay a captured trace (saved request / payload / event log) in isolation.
6. Throwaway harness — minimal subset of the system exercising the path in one call.
7. Property / fuzz loop for "sometimes wrong output" — 1000 random inputs.
8. Bisection harness — automate "boot at state X, check, repeat" for `git bisect run`.
9. Differential loop — same input through old vs new (or two configs), diff outputs.
10. HITL bash script — last resort; drive the human via a structured loop so output still feeds back.

**Iterate on the loop itself.** Make it faster (cache setup, skip unrelated init,
narrow scope), sharper (assert the specific symptom), more deterministic (pin
time, seed RNG, isolate FS, freeze network). A 2-second deterministic loop is a
superpower; a 30-second flaky loop is barely better than none.

**Non-deterministic bugs:** the goal is a higher reproduction rate, not a clean
repro. Loop 100x, parallelise, add stress, narrow timing windows, inject sleeps.
A 50%-flake is debuggable; 1% is not — raise the rate until it is.

**If you genuinely cannot build a loop:** stop and say so. List what you tried and
ask for (a) access to a reproducing environment, (b) a captured artifact (HAR,
log dump, core dump, timestamped screen recording), or (c) permission for
temporary production instrumentation. Do not hypothesise without a loop.

## Phase 2 — Reproduce
Run the loop; watch the bug appear. Confirm: it produces the failure the **owner**
described (not a nearby one — wrong bug = wrong fix); it reproduces across runs
(or at a high enough rate); and you captured the exact symptom for later
verification. Do not proceed until reproduced.

## Phase 3 — Hypothesise
Generate **3-5 ranked, falsifiable hypotheses** before testing any (single-
hypothesis generation anchors on the first plausible idea). Each must state a
prediction: "If <X> is the cause, then <changing Y> will make the bug disappear /
<changing Z> will make it worse." No prediction = a vibe; discard or sharpen.
Show the ranked list to the owner before testing (cheap checkpoint, often re-ranks
instantly) — but proceed with your ranking if the owner is AFK.

## Phase 4 — Instrument
Each probe maps to a specific Phase-3 prediction; change one variable at a time.
Prefer debugger/REPL (one breakpoint beats ten logs), then targeted logs at
distinguishing boundaries; never "log everything and grep". Tag every debug log
with a unique prefix e.g. `[DEBUG-a4f2]` so cleanup is one grep. For perf
regressions, logs are usually wrong — establish a baseline measurement
(timing harness, profiler, query plan), then bisect. Measure first, fix second.

## Phase 5 — Fix + regression test
Write the regression test **before the fix** — but only if a **correct seam**
exists (the test exercises the real bug pattern as it occurs at the call site). A
too-shallow seam gives false confidence. **If no correct seam exists, that itself
is the finding** — note it; the architecture is preventing lockdown. If a correct
seam exists: turn the minimised repro into a failing test, watch it fail, apply
the fix, watch it pass, then re-run the Phase 1 loop against the original
un-minimised scenario.

## Phase 6 — Cleanup + post-mortem
Required before done:
- [ ] Original repro no longer reproduces (re-run the Phase 1 loop).
- [ ] Regression test passes (or absence of seam is documented).
- [ ] All `[DEBUG-...]` instrumentation removed (grep the prefix).
- [ ] Throwaway prototypes deleted (or moved to a clearly-marked debug location).
- [ ] The correct hypothesis is stated in the commit / PR message.

Then ask: what would have prevented this bug? If the answer is architectural
(no good seam, tangled callers, hidden coupling), record the recommendation in the
ace-ops wiki **after** the fix is in — you know more now than at the start.

## Handoff

End with `DONE: <bug> fixed — repro gone, regression test green` (include the PR
when the fix touched code), or `BLOCKED: <one-line reason — e.g. cannot build a
feedback loop, need reproducing environment>`.
