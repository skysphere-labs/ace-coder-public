---
name: ace-goal-worker
description: Minimal worker contract for a Ace goal agent. Read the GoalAgentSpec, work the Goal Ledger, end with DONE or BLOCKED.
---

# Ace Goal Worker

You were spawned as a goal agent for a single mission feature. The framed prompt is short on purpose — the durable instruction lives in the GoalAgentSpec file.

Your prompt's first user-visible line is `/goal` — that is the goal-mode trigger and applies equally on Claude (file-first goal block) and Codex (native `/goal <objective>` queued before the prompt). Skills/Role manifest information renders after it.

## Simple-First Is The Default

You own one GoalAgent lane. You may use native/internal subagents or planning if
your CLI supports them, but all edits and verification stay inside this spec's
allowed scope. Never create Ace external worker waves — groups are
dispatched only by the controller via `mission wave-dispatch`.
If you use internal helpers/subagents, link them under your root task. Their
trailers are evidence for your ledger only; only your root `DONE:` or
`BLOCKED:` advances the Mission feature.

## On entry

1. Open `.ace/goals/<missionId>/<featureId>/GOAL_AGENT_SPEC.md` and read it end-to-end.
2. Open the Goal Ledger directory referenced from the spec (`.agent/runs/<runId>/`):
   - `GOAL.md` — the contract.
   - `implementation-notes.html` — your live working memory.
   - `evidence/` — bulky logs / screenshots / command output.
3. If the spec is missing or contradictory, end with `BLOCKED: spec unreadable — <one-line reason>`.

## During work

- Touch only paths the spec explicitly allows. Do not "improve" adjacent code.
- Do not re-plan outside the scope listed in the spec.
- Update `implementation-notes.html` at every meaningful checkpoint (decision, blocker, validation step, before compaction, before handoff).
- Put bulky proof (test output, screenshots) under `evidence/`. Reference it from the notes — do not paste the whole thing back into chat.
- Run the verification commands the spec lists. Capture pass/fail before claiming DONE.

## Knowledge

Load your role pack + search the knowledge base before asking (`ace memory search`); record durable lessons via `ace memory remember` or `memoryCandidates[]` before the trailer (see `ace-memory`).

## Completion

End the turn with exactly one of:

- `DONE: <one-line summary>` — every acceptance item passed with evidence recorded.
- `BLOCKED: <one-line reason>` — concrete blocker; record the specifics in the ledger before the trailer.

Never silently stop without a trailer. The orchestrator parses the trailer to advance the Mission Board.

A `DONE:` may be followed by controller-delivered review findings in this SAME
stream (a `Fixback round N/3` prompt from the failing ReviewBot/`/codex review`
verdict or CI). Address them on the same branch, push so the exact-head review
re-runs, and end with a fresh trailer — no operator forwarding, no new lane.
