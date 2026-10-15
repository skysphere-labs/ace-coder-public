# Lane auth and rendering

Ace runs every agent lane as the machine's own CLI, on the machine's own login.
There is no credential gateway, no account registry, no rotation, and no
credential env injected into a lane. A `claude` lane is the same process you
would get by typing `claude` in a terminal, with two deliberate differences.

## 1. Credential hygiene (`claude-auth-policy.cts`)

Before a claude lane spawns, `sanitizeClaudeSubscriptionEnv(env)` strips every
inherited credential that would outrank the user's subscription OAuth login:

- `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` — either would flip the lane to
  metered API billing.
- `ANTHROPIC_BASE_URL` and the cloud-provider toggles — either would point the
  lane at something other than the user's own account.

`CLAUDE_CODE_OAUTH_TOKEN` is deliberately KEPT: it sits *below* the keychain
claude.ai login in the CLI's precedence order, so it is ignored when a keychain
login exists (which is what keeps claude.ai connectors working), and it is the
only credential for a user whose login is supplied through that env var alone.

A lane that still prints the CLI's "API Usage Billing" banner is killed by
`createClaudeStartupAuthDetector` — with no injected credentials that banner can
only mean something leaked into the lane env.

## 2. Renderer (`applyClaudeLaneRenderer`)

Lanes spawn with `--settings '{"tui":"default"}'`.

Claude Code's `fullscreen` renderer draws on the alternate screen and owns its
own virtualised scrollback, which it expects the terminal to drive through
DECSET 1007 (alternate scroll). Real terminals implement 1007; xterm.js does
not, so inside an Ace pane a fullscreen lane cannot be scrolled at all.
Fullscreen also repaints the whole viewport every frame, and in Ace each of
those repaints has to cross the pty-host socket, the main process, and the
renderer's parser, for every visible lane.

`--settings` is a highest-precedence settings *source* that merges over the
user's `settings.json`, so this overrides `tui` alone — model, effort and
permissions still come from the user's own settings, and a real terminal keeps
whatever renderer the owner configured.

## What the pty-host daemon does

Multiplex ptys and buffer their output for reattach. Nothing else. It opens no
TCP listener; `electron/__tests__/pty-host.test.cts` asserts that.

## Usage meters

`usage-core.cts` reports exactly one (ambient) account per provider: Claude from
the statusline tap (`usage-statusline-tap.cts`), Codex from its session JSONL
rate-limit events. There is nothing to attribute per-account, so there is no
per-account cache keying and no probing.
