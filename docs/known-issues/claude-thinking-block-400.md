# Known issue: Claude `thinking`/`redacted_thinking` block 400

## Symptom

A `claude` agent tab fails mid-run with:

```
API Error: 400 messages.5.content.11: `thinking` or `redacted_thinking` blocks
in the latest assistant message cannot be modified. These blocks must remain as
they were in the original response.
```

## Root cause — upstream Claude Code CLI, not Ace

This is a bug in the **Claude Code CLI** (`@anthropic-ai/claude-code`), which
Ace spawns as a subprocess (see `electron/agent-providers.cjs`: `cli: "claude"`,
resume via `--resume`/`--continue`). When the CLI rebuilds conversation history
mid-run — on compaction, retry, or tool-result injection — it mutates or
re-serializes the immutable `thinking`/`redacted_thinking` blocks of the latest
assistant message before re-sending to the Anthropic API. The API rejects the
modified blocks with the 400 above.

**It is not a Ace bug.** Ace has no Anthropic SDK dependency and never
builds the API `messages` array:

- No `@anthropic-ai/sdk` in `package.json`; no `messages.create` anywhere in source.
- `electron/tui-control/transcript/normalize/*.cts` is **display-only** — it parses
  the CLI's stream/transcript for the UI and never feeds anything back to Anthropic.
- `electron/agent-cli-driver.cts` only renders `▸ thinking…` for display
  (`renderEvent`), it does not resend blocks.

There is therefore no Ace source change that fixes the root cause.

## Version note

At time of writing the installed CLI is `2.1.154`, which is also the latest
published version (`npm view @anthropic-ai/claude-code version`). So there is no
newer release to upgrade to that fixes it yet — the fix must land upstream.

## What Ace does about it

Because Ace *spawns* the CLI, it adds a defensive guard on the **headless**
agent path (`electron/agent-cli-driver.cts`):

- `isThinkingBlock400()` detects the error signature.
- For a `claude` headless run it **retries once with a fresh single-shot
  invocation** (no prior assistant turn to corrupt).
- If it still fails, it throws a **classified, honest error** explaining the
  upstream cause and remedy, instead of a bare `exited with code 1`.

## Interactive tabs (the screenshot case) — follow-up

The screenshot error is the **interactive PTY tab**, driven through the
`tui-control` layer, not the headless driver. Recovery there means detecting the
on-screen 400 in `electron/tui-control/screen-reader.cts` and offering a
"restart session fresh" affordance (dropping the poisoned `--resume` state).
That layer currently has unrelated uncommitted WIP, so it was intentionally left
untouched here and is filed as a follow-up.

## Workarounds for now

- Start the affected tab as a **fresh session** (do not `--resume`/`--continue`
  into the poisoned history).
- Watch for an upstream Claude Code release that preserves thinking blocks
  verbatim across compaction/retry, then upgrade.

## Upstream fix (for reference)

In the CLI's message-reconstruction layer, pass thinking blocks through untouched:

```ts
// WRONG: drops/transforms thinking blocks
const newContent = msg.content.filter(b => b.type !== 'thinking').map(transformBlock);
// CORRECT: preserve thinking / redacted_thinking verbatim
const newContent = msg.content.map(b =>
  (b.type === 'thinking' || b.type === 'redacted_thinking') ? b : transformBlock(b));
```
