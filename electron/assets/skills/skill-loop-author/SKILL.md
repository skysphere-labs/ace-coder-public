---
name: skill-loop-author
description: Author a new Ace skill (reusable agent playbook) and/or an event-driven loop, and install it to all three skill brains. Use when asked to "make a skill", "turn this into a reusable thing so all agents can use it", "write a playbook", "create a loop/automation", "babysit/watch something without burning tokens", or to scaffold a SKILL.md + references. Picks the right event trigger (Routines/webhook, Monitor, background task, ScheduleWakeup, /loop) instead of polling.
---

# Skill & Loop Author

The meta-skill: make a skill, and make an event-driven loop. A **skill** is a
reusable agent playbook on disk; a **loop** is a standing/recurring task wired to
a platform event so it never re-invokes the LLM just to re-check state. This skill
gives you the anatomy, the trigger decision table, the guards, and a scaffolder
that writes the files and installs them to all three brains.

## Loop engineering — the model

> "You shouldn't be prompting coding agents anymore. You should be designing
> loops that prompt your agents." — @steipete · "My job is to write loops."
> — @bcherny (head of Claude Code)

**Loop engineering is replacing yourself as the person who prompts the agent —
you design the system that does it instead.** A loop is a *recursive goal*: you
define a purpose and the AI iterates until a **verifiable** stop condition holds.
The leverage point moves from "write a good prompt, read the reply, write the
next one" to "build a small system that finds the work, hands it out, checks it,
records what's done, and decides the next thing — then let it poke the agents
instead of you."

A loop is built from **five blocks + memory**, and Claude Code and Codex both
ship all of them — so design the loop to work in either:

| # | Block | What it does | Claude Code | Codex |
| --- | --- | --- | --- | --- |
| 1 | **Automations** (the heartbeat) | makes it a *loop*, not a one-off run; discovery + triage on a cadence/event | `/loop`, `CronCreate`, hooks, GitHub Actions, **Routines** (webhook); `/goal` = run until a verifiable stop | Automations tab; `/goal` |
| 2 | **Worktrees** (isolation) | parallel agents don't collide on files | `git worktree`, `--worktree`, `isolation: worktree` on subagents | built-in worktrees |
| 3 | **Skills** (intent on disk) | project knowledge the agent would otherwise re-guess every run | `SKILL.md` folder — *this skill authors them* | `SKILL.md` folder, `$`/`/skills` |
| 4 | **Plugins & connectors** (MCP) | touch real tools — issue tracker, DB, Slack, the PR | MCP connectors; plugins bundle skills+connectors | MCP connectors |
| 5 | **Sub-agents** (maker ≠ checker) | the one who writes ≠ the one who checks; adversarial verify | `.claude/agents`, agent teams | `.codex/agents/*.toml` |
| 6 | **Memory** (the spine) | lives *outside* the conversation; holds what's done / what's next | markdown / Mission Board / `~/.claude/.../memory` | same |

**Memory is the sixth and the most underrated.** The model forgets everything
between runs, so the state must be on disk, not in the context — *the agent
forgets, the repo doesn't.* A markdown file or a board that records what was
tried, what passed, what's still open is what lets tomorrow's run pick up where
today's stopped. Every long-running loop depends on it.

`/goal` is the maker≠checker split applied to the **stop condition itself**: a
fresh small model grades "are we done?" each turn, so the agent that wrote the
code isn't the one declaring it correct. Give it something verifiable ("all
tests in `test/auth` pass and lint is clean"), not a vibe.

**Stay the engineer.** Three problems get *sharper* as the loop gets smoother,
not easier — design against all three:

- **Verification is still on you.** A loop running unattended is a loop making
  mistakes unattended. "Done" is a claim, not a proof — that's why the verifier
  sub-agent is separate from the maker, and why you still confirm the artifact
  (see `ace-computer-use-validator`: CI green ≠ runtime-correct).
- **Comprehension debt.** The faster the loop ships code you didn't write, the
  bigger the gap between what exists and what you understand. Read what the loop
  made.
- **Cognitive surrender + slop.** When it runs itself it's tempting to stop
  having an opinion and take whatever it returns. Same action — designing a loop
  — is the cure when done with judgement and the accelerant when done to avoid
  thinking. Watch token cost too: usage varies wildly, so cap and measure.

Two people can build the identical loop and get opposite results; the loop
doesn't know the difference, you do. **Build the loop. Stay the engineer.**

## When to use

- "Make a skill" / "write a playbook" / "document this as a procedure".
- "Turn this into a reusable thing" / "so all (Claude/Codex/Hermes) agents can use it".
- "Create a loop" / "automate this" / "babysit PRs" / "watch the release" / "poll X".
- Any time you're about to write a `gh run watch` or `gh pr checks`-every-turn
  poll by hand — stop, author a proper event-driven loop instead.

## Core rule

A skill's `description` is the **retrieval surface** — agents pick the skill from
it, so it must trigger on the right intents. A loop's job is to **wait without
burning tokens** — let the platform notify you; never replay the transcript to poll.

## Anatomy of a skill

One directory per skill under `~/.claude/skills/<kebab-name>/`:

```
<kebab-name>/
  SKILL.md            # YAML frontmatter (name, description) + Markdown body
  references/         # optional: scripts, templates, longer docs
    *.sh  *.md
```

- **Frontmatter — exactly two keys**: `name` (kebab, matches the dir) and
  `description`. Nothing else.
- **`description` IS the retrieval surface.** Write it to fire on the right
  intents: concrete verbs + nouns the user/agent will actually say, one or two
  sentences. Lead with the action ("Author a…", "Watch a…", "Push and open a PR…"),
  name the triggering phrases, and the domain nouns. Vague descriptions never get
  retrieved. Test it: would the phrase the user typed match these words?
- **Body — rule-first, imperative, short sections.** House voice:
  `## When to use`, `## Core rule`, a recipe in fenced blocks with real commands,
  `## Anti-patterns`. No fluff, no narration. Copy-pasteable over prose.
- **`references/`** — heavy material that would bloat the body: scaffolders,
  templates, schemas, worked examples. Link to them from the body by relative path.
- **Scripts** must be `set -euo pipefail`, idempotent, and `chmod +x`.

## The three brains

A skill must be installed identically in all three skill roots so every runtime
sees it:

| Brain | Path |
| --- | --- |
| Claude Code | `~/.claude/skills/` |
| Codex | `~/.codex/skills/` |
| Hermes | `~/.hermes/skills/` (may symlink to an external data volume on some installs) |

One directory per skill in each; **keep them in sync**. The scaffolder
(`references/new-skill.sh`) does the propagation for you — it writes
`~/.claude/skills/<name>/` then `cp -R` into the other two brains (skipping any
brain that isn't mounted/present). When editing an existing skill by hand,
re-run the install step or copy the dir to all three yourself.

## Designing an event-driven loop

This is the core IP. A loop waits on an async event (CI finishing, a PR merging,
a release publishing). **Never re-invoke the LLM just to re-check state** — pick a
trigger that makes the *platform* wake you.

### 1) Pick the TRIGGER

| Trigger | Use when | Mechanism |
| --- | --- | --- |
| **Routines / Cron** (cloud) | Standing, zero-idle-token automation; a GitHub event should wake the agent (`pull_request`, `push`, `issue`, `check_run`, `workflow_run`, `discussion`, `release`, `merge_queue`); or a fixed schedule; or an HTTP POST. | `CronCreate` / Claude Code Routines |
| **Monitor** (local, interrupt-driven) | Local interactive session; watch one async job to a terminal state and get interrupted only on the event. The filter emits ONE line on terminal state then exits, so the agent keeps working and doesn't re-LLM each tick. | `Monitor` tool |
| **Bash `run_in_background:true`** | One completion ping — "tell me when the build finishes". A command that EXITS when the condition is true. | `Bash` with `run_in_background:true` |
| **ScheduleWakeup** | Self-paced `/loop` dynamic mode; waiting on external state the harness can't notify you about; you set the next wake. | `ScheduleWakeup` |
| **/loop** (local) | Babysit something locally on a cadence or self-paced, up to ~3 days. | `/loop` |

Rule of thumb: **standing + event-shaped → Routine/webhook**; **local + one
async wait → Monitor or background task**; **self-paced external wait →
ScheduleWakeup**; **recurring local chore → /loop**.

### 2) The OODA body

Each iteration: **Observe → Decide → Act → Observe**.

- **Observe**: query the real state (`gh run view --json status,conclusion`),
  never assume.
- **Decide**: terminal? success/failure/cancelled/timeout? or keep waiting?
- **Act**: on terminal-success do the next step; on terminal-failure escalate/
  recover; otherwise wait via the platform (do NOT loop in the LLM).
- **Observe** the result of your act before declaring done.

### 3) The GUARDS (every loop needs all four)

- **Step / iteration cap.** Bound the wait (`for i in $(seq 1 50)`, a timeout_ms,
  a max-tick count). Never an unbounded `while true`.
- **Repeat-action detection.** If the same action ran with the same result twice,
  stop and escalate — you're stuck, not progressing.
- **Terminal-state coverage — silence ≠ success.** The filter MUST emit on EVERY
  terminal state (success | failure | cancelled | timeout). If it only emits on
  success, a crash looks identical to "still running". Always echo a final line
  after the loop.
- **Cache-aware delays.** `ScheduleWakeup`/poll cadence: `<300s` keeps the prompt
  cache warm (fast-changing external state); `1200–1800s` for genuinely idle
  ticks (one cache miss buys a long wait). Avoid `300s` — worst of both. For
  Monitor on a ~15-min CI run, set `timeout_ms` generously (e.g. `2400000`).

### 4) The TOKEN RULE

Polling in the agent loop replays the whole transcript every tick and re-burns
tokens — an agent that takes 10 ticks burns ~10×. **Let the platform notify you.**
Monitor/background-task for local interactive, ScheduleWakeup for self-paced,
Routines/webhooks for standing cloud.

**Anti-patterns — never:**

- `gh run watch` in a foreground turn (blocks and re-LLMs).
- `gh pr checks` / re-reading state every turn.
- Fixed tight intervals; unbounded `while true`.
- Re-reading the whole transcript just to re-check a condition.
- A filter that emits only on success (a crash then looks like "still running").

### Canonical Monitor recipe (watch a run to terminal state, ONE notification)

```bash
RID=<run-id>
for i in $(seq 1 50); do
  st=$(gh run view "$RID" --json status,conclusion \
        -q '.status+"/"+(.conclusion//"-")' 2>/dev/null || echo "query-fail/-")
  case "$st" in completed/*) echo "run FINISHED: $st"; exit 0;; esac
  sleep 45
done
echo "still $st after timeout"   # silence ≠ success — always emit a terminal line
```

`persistent:true` only for session-length watches. `sleep` is allowed inside
Monitor/background contexts (foreground `sleep` is blocked by the harness).

## Scaffold + install

Use the scaffolder — it writes the dir, a SKILL.md from the template, a
`references/` dir, optionally a `<name>.loop.md`, and installs to all three brains:

```bash
# a plain skill
~/.claude/skills/skill-loop-author/references/new-skill.sh \
  my-new-skill "Author X and do Y. Use when asked to 'do X', 'make Y'."

# a skill that also defines an event-driven loop
~/.claude/skills/skill-loop-author/references/new-skill.sh \
  watch-the-release "Watch a release run to terminal state and verify the artifact." \
  --loop
```

It backs up any existing `SKILL.md` before overwrite, `chmod +x`'s scripts, and
`cp -R`s into `~/.codex/skills/` and `~/.hermes/skills/`. Then fill in the body
and re-run the install (or just re-copy) after edits.

## Quality bar

Before calling a skill/loop done, check every box:

- [ ] **Description triggers** — leads with a verb, names the real intent phrases
      and domain nouns; the user's likely wording matches it.
- [ ] **Frontmatter is exactly `name` + `description`** (name == dir, kebab-case).
- [ ] **Body is rule-first** — `When to use` / `Core rule` / recipe / anti-patterns;
      imperative; real commands in fenced blocks; no fluff.
- [ ] **Loop is event-driven, not polling** — right trigger chosen from the table;
      the platform notifies, the LLM doesn't re-poll.
- [ ] **All four guards present** — iteration cap, repeat-action detection,
      terminal-state coverage (silence ≠ success), cache-aware delays.
- [ ] **Installed to all three brains** (`~/.claude`, `~/.codex`, `~/.hermes`).
- [ ] **Cross-linked** to the skills it builds on; minimal + copy-pasteable.

## Related

- **ace-spine-driver** — the worked example of an autonomous loop end-to-end:
  `ace run submit` → worker → computer-use validator (CI green ≠ runtime-correct)
  → gate → fail-closed owner-gated merge → in-app updater.
- **ace-github-flow** — the GitHub pipeline rules (branch model, push via the
  integration gateway, the validator merge gate, owner PR rubric) that a
  loop executes on top of. Reference it; don't duplicate it.
