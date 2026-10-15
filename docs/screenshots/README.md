# Skysphere ACE CODER screenshot tour

These are captures of the application's interface populated with fictional
local demo data. Projects, repository names, accounts, paths, messages, usage
readings, run states, and results are examples. No live provider account or
private project was used. The visible demo banner identifies this context.

The captures use a browser showcase bridge rather than a live Electron backend.
They show the interface; they do not demonstrate real agent processes, Git
mutations, database writes, SSH connections, device pairing, or completed
automation. See the [feature tour](../FEATURES.md) for capabilities and limits,
and the linked source below for behavior that a screenshot cannot establish.

## Coverage

| Capability | Screenshots | What the capture establishes |
| --- | --- | --- |
| **Projects, tasks, and worktrees** | [Home](home.jpg), [workspace](workspace.jpg), [mobile workspaces](mobile-workspaces.jpg) | Project/task organization and working-context labels. Actual checkout creation is implemented in [local-core](../../electron/local-core.cts). |
| **Parallel workbench** | [Workspace](workspace.jpg), [lane deck](lane-deck.jpg) | Pane arrangement and synthetic terminal output. No native PTY process was launched for these images. |
| **Live lane deck** | [Lane deck](lane-deck.jpg) | Multiple lane tiles, provider grouping, and status presentation with fictional streams. |
| **Scoped runs and orchestration** | [Run Board](board.jpg), [review/completed columns](board-review-done.jpg) | How recorded run states appear. Worker dispatch and validation are implemented in [spine-effects](../../electron/run-ledger/spine-effects.cts); no real worker completed the pictured tasks. |
| **Run Board** | [Active/queued work](board.jpg), [review/completed work](board-review-done.jpg) | Board columns and example lifecycle states. |
| **Reusable loops** | [Loops](loops.jpg) | Workflow discovery and configuration. Scheduling, convergence, and spend limits were not exercised by the capture. |
| **Terminals and resume** | [Workspace](workspace.jpg), [lane deck](lane-deck.jpg) | Terminal presentation with synthetic output. PTY persistence and resume need native runtime verification; see [TerminalFeed](../../src/components/TerminalFeed.tsx). |
| **Transcript normalization and chat** | [Hermes chat](hermes-chat.jpg) | Markdown conversation, a fictional tool card, and a context indicator. Native transcript ingestion was not exercised; see [normalization adapters](../../electron/ace-control/transcript/normalize). Structured chat is currently enabled for Hermes, as defined in the [chat-mode registry](../../src/runtime/ace-chat-mode-registry.ts). |
| **Rich chat composer** | [Hermes composer](hermes-composer.jpg), [chat with draft](hermes-chat.jpg) | Unsent draft, slash-command menu, and attachment control. Uploading or sending files to a provider was not exercised; see the [composer](../../src/components/ace-chat/ComposerShell.tsx). |
| **Git and GitHub** | [GitHub](github.jpg), [workspace](workspace.jpg) | Repository/account presentation and task context using fictional data. Login, push, PR creation, and merge were not performed. |
| **Editor and task browser** | [Monaco editor](editor.jpg), [Markdown preview](editor-preview.jpg), [workspace](workspace.jpg) | Loaded editor and preview with synthetic file content. Saving files and native Electron browser/webview operations were not exercised; see [SessionScreen](../../src/components/SessionScreen.tsx). |
| **Provider catalog** | [Providers](providers.jpg) | CLI configuration/discovery presentation. Demo installation indicators do not prove the CLIs are installed or authenticated. |
| **Skills and MCP** | [Skills/plugins](plugins.jpg), [MCP](mcp.jpg) | Catalog and configuration surfaces. No third-party service was connected. |
| **Project knowledge and wiki** | [Knowledge](knowledge.jpg) | Search and knowledge presentation with example records. No private knowledge store is shown. |
| **Monitor, intelligence, and usage** | [Monitor](monitor.jpg), [Intel](intel.jpg) | Health, operational context, and fictional usage/state presentation. Counts and results are illustrative. |
| **Remote and mobile** | [Remote](remote.jpg), [mobile Today](mobile-today.jpg), [mobile workspaces](mobile-workspaces.jpg) | Remote configuration and responsive layouts. No real device was paired and no real access token is shown. |
| **Local data and storage** | [Settings](settings.jpg) | Configuration presentation only. Database persistence, migrations, and moving a data root were not performed for these images. |
| **Local startup** | [Home](home.jpg) | The account-independent desktop interface. Native boot behavior is covered separately by [runtime boot tests](../../electron/__tests__/runtime-boot.test.cts), not by the screenshot bridge. |

## Browse the captures

### Coordinate the work

![Run Board with fictional queued and active work](board.jpg)

![Run Board with fictional review and completed work](board-review-done.jpg)

![Lane deck with fictional agent output](lane-deck.jpg)

![Task workspace with fictional context](workspace.jpg)

![Hermes structured chat with fictional messages and tool results](hermes-chat.jpg)

![Hermes composer with slash-command menu and attachment control](hermes-composer.jpg)

![Monaco editor displaying a synthetic document](editor.jpg)

![Markdown preview of a synthetic document](editor-preview.jpg)

![Reusable loops interface](loops.jpg)

### Configure your tools

![Skills and plugins catalog](plugins.jpg)

![MCP server catalog](mcp.jpg)

![Coding agent provider settings](providers.jpg)

![GitHub interface with fictional account and repository data](github.jpg)

### Keep context and inspect state

![Project knowledge with fictional records](knowledge.jpg)

![Monitor with fictional runtime state](monitor.jpg)

![Intel with fictional operational context](intel.jpg)

![Application settings](settings.jpg)

### Desktop and mobile

![Desktop home with fictional projects](home.jpg)

![Remote access configuration without a live pairing](remote.jpg)

![Mobile Today with fictional work](mobile-today.jpg)

![Mobile workspace navigation with fictional projects](mobile-workspaces.jpg)
