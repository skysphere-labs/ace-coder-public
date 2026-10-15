---
name: autoreview
description: Run structured code review closeout for validators; Codex is the default reviewer when no engine is specified.
source: https://github.com/openclaw/agent-skills/blob/main/skills/autoreview/SKILL.md
---

# Auto Review

Use this for validator and non-trivial closeout review work.
It is advisory code review: verify every finding in the real code before
accepting it, and reject speculative rewrites that do not expose a concrete
bug, regression, or security risk.

## Contract

- Prefer the structured autoreview helper when it is available in the checkout
  or installed skills directory; otherwise perform the same review manually and
  say the helper was unavailable.
- Default to Codex review unless the task explicitly requests another engine.
- Review the right target: dirty local patch for uncommitted work, branch diff
  against the PR base for PR work, or an explicit commit for committed work.
- Keep validator lanes read-only unless the task is a fixback lane.
- For each finding, cite file/line evidence, acceptance impact, severity, and a
  minimal fix direction.
- If a review-triggered fix changes code, rerun focused tests and rerun review.
- Stop once the final helper/review pass has no accepted actionable findings.

## Helper Discovery

Try these paths before falling back to manual review:

```bash
.agents/skills/autoreview/scripts/autoreview --help
skills/autoreview/scripts/autoreview --help
~/.codex/skills/agent-scripts/autoreview/scripts/autoreview --help
```

Useful target modes:

```bash
<autoreview-helper> --mode local
<autoreview-helper> --mode branch --base origin/main
<autoreview-helper> --mode commit --commit HEAD
```

For PR branches, prefer the actual PR base when `gh pr view` works:

```bash
base=$(gh pr view --json baseRefName --jq .baseRefName)
<autoreview-helper> --mode branch --base "origin/$base"
```

## Final Report

Include the review command or manual fallback used, tests/proof run, accepted or
rejected findings with rationale, and the final clean result or remaining
blocker.
