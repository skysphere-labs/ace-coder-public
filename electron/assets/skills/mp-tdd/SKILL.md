---
name: mp-tdd
description: Test-first build contract and test-quality rubric (Matt Pocock "tdd"). Red-green-refactor in vertical tracer-bullet slices; tests verify behavior through public interfaces, never implementation. Use when a worker builds a feature or fixes a bug test-first, or needs a rubric for whether tests are good.
---

# Test-Driven Development (vendored: mattpocock/skills `tdd`)

## Philosophy

**Core principle:** tests verify behavior through public interfaces, not
implementation details. Code can change entirely; tests should not.

**Good tests** are integration-style: they exercise real code paths through
public APIs, describe _what_ the system does (not _how_), and survive refactors.
A good test reads like a spec — "user can checkout with valid cart".

**Bad tests** couple to implementation: they mock internal collaborators, test
private methods, or verify through side channels (querying a DB directly instead
of using the interface). Warning sign: the test breaks on refactor while behavior
is unchanged. Rename an internal function and tests fail -> those tests test
implementation, not behavior.

## Anti-pattern: horizontal slices

**DO NOT write all tests first, then all implementation.** Horizontal slicing
(RED = "write all tests", GREEN = "write all code") produces crap tests: written
in bulk they test _imagined_ behavior and the _shape_ of things (data structures,
signatures) rather than user-facing behavior, become insensitive to real changes,
and commit to test structure before you understand the implementation.

**Correct approach:** vertical slices via tracer bullets. One test -> one
implementation -> repeat. Each test responds to what you learned in the previous
cycle.

```
WRONG (horizontal):  RED: test1..test5  then  GREEN: impl1..impl5
RIGHT (vertical):    RED->GREEN: test1->impl1, test2->impl2, ...
```

## Workflow

### 1. Planning
When exploring the codebase, use the ace-ops wiki glossary so test names and
interface vocabulary match the project's language, and respect wiki ADRs in the
area you touch. Before writing code:
- [ ] Confirm what interface changes are needed.
- [ ] Confirm which behaviors to test (prioritize — you can't test everything).
- [ ] Identify deep-module opportunities (small interface, deep implementation).
- [ ] Design interfaces for testability.
- [ ] List behaviors to test (not implementation steps).
- [ ] Get approval on the plan.
Focus testing effort on critical paths and complex logic, not every edge case.

### 2. Tracer bullet
Write ONE test that confirms ONE thing end-to-end.
```
RED:   write test for first behavior -> fails
GREEN: minimal code to pass -> passes
```

### 3. Incremental loop
For each remaining behavior: RED (next test fails) -> GREEN (minimal code passes).
Rules: one test at a time; only enough code to pass the current test; do not
anticipate future tests; keep tests on observable behavior.

### 4. Refactor
After all tests pass: extract duplication, deepen modules (complexity behind
simple interfaces), apply SOLID where natural, reconsider existing code, run tests
after each step. **Never refactor while RED — get to GREEN first.**

## Checklist per cycle
```
[ ] Test describes behavior, not implementation
[ ] Test uses public interface only
[ ] Test would survive internal refactor
[ ] Code is minimal for this test
[ ] No speculative features added
```

## Handoff

This is a build contract inside a worker, not a separate role. When the slice is
green and refactored, continue the worker's normal path (merge any internal
sub-worktrees, then the integration sub-agent runs push -> openPr -> validator
seal -> mergePr). End the build turn with `DONE: <slice> green, tests cover the
criterion` or `BLOCKED: <one-line reason — e.g. no correct test seam>`.
