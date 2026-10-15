# Skysphere ACE CODER architecture

ACE CODER combines a React renderer, an Electron host, a local control API, and a CLI. The host owns process execution and persistence; the renderer presents workspaces, agent lanes, tasks, mission boards, reusable loops, operations, and knowledge.

## Runtime and data

`electron/main.cts` starts a local runtime through `runtime-boot.cts`. Startup reports readiness or a recoverable error; it does not require a publisher account or cloud entitlement. The preload bridge exposes the supported desktop API. `src/lib/ace-api.ts` provides the renderer interface and paired remote-client transport.

`electron/local-core.cts` owns local workspace and task state. The run ledger, loops, and knowledge modules maintain their SQLite schemas and migrations. Fresh installations create empty application data. No developer databases, user sessions, or cloud database bindings ship with this repository.

Packaged installations use an `ACE CODER` application-data profile; development builds use a project-specific profile. Runtime configuration follows `ACE_HOME`. The CLI discovers the public application profile, with explicit endpoint overrides available to users. External storage requires user configuration. Back up existing data before deliberately selecting it for a development build.

## Agent execution

Provider profiles launch user-installed CLI tools in terminals and isolated Git worktrees. Each provider controls its own authentication, network calls, supported models, and billing. Structured chat is currently available for Hermes; several other providers intentionally use their native terminal experience. Launch-profile availability does not imply equal provider capabilities.

The mission board and run ledger track dispatched work, results, validation, and integration evidence. Loops define reusable execution patterns with iteration and usage controls. Reported spending depends on provider telemetry; a displayed cap is not a guarantee enforced by every provider.

## GitHub and remote access

GitHub integration uses the user's own GitHub authorization and permissions. It operates on repositories that user selects. No publisher organization credentials are bundled.

Remote access supports loopback and explicitly enabled LAN/Tailscale use, with device enrollment, host validation, expiring pairing, and revocation. The source release has no publisher tunnel service, cloud login relay, or hosted update feed. A remote connection grants meaningful control of the host; pair only devices you trust.

## Source map

| Area | Location |
| --- | --- |
| Desktop lifecycle and IPC | `electron/main.cts`, `electron/preload.cts` |
| Local state and database migrations | `electron/local-core.cts` |
| Durable runs and orchestration | `electron/run-ledger/` |
| Reusable agent loops | `electron/loops/` |
| Provider launches and terminal capture | `electron/agent-providers.cts`, `electron/ace-control/` |
| GitHub authorization and operations | `electron/github-core.cts` |
| Paired remote transport | `electron/remote-server.cts` |
| Local knowledge and wiki indexing | `electron/wiki-graph-indexer.cts` and knowledge modules |
| Renderer and screens | `src/components/`, `src/runtime/` |
| User CLI and automation tools | `tools/ace/` |

See [FEATURES.md](FEATURES.md) for the capability inventory and [SECURITY.md](../SECURITY.md) for trust boundaries.
