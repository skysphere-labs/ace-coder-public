# Skysphere ACE CODER feature tour

Skysphere ACE CODER connects the everyday parts of agent-assisted development: deciding
what to build, running agents, watching progress, reviewing changes, and keeping
the context for the next task. This tour describes capabilities present in the
public-edition source. Availability also depends on your operating system,
installed CLIs, accounts, and configuration.

Explore the [screenshot tour](screenshots/README.md) for a visual walkthrough
covering all 19 capability groups. The images use fictional demo data; the
coverage table distinguishes captured interface views from native or CLI
behavior that was not exercised by the showcase.

## Projects, tasks, and isolated worktrees

Open a local repository, create a workspace, or clone a repository through
GitHub. Keep task conversations, terminals, editor tabs, and browser tabs attached
to the work they support.

Use an ordinary session for exploration, or give a development task a dedicated
Git branch and worktree. Worktree preparation runs separately from the interface
so the task can show its preparation state while the checkout is created. A task
can contain multiple agent variants and additional worktrees.

Worktrees keep independent edits in separate working directories. They do not
eliminate merge conflicts or restrict an agent's operating-system permissions.

## Parallel panes and the lane deck

Arrange task panes around agents, files, and browser tabs. Broadcast an
instruction to all variants or select the variants that should receive it.
Supporting shell terminals remain available in the task's terminal drawer.

The lane deck provides a workspace-wide view of live coding lanes. Tiles expose
the lane name, branch, and current stream state, and expand into the full task
view. Working, awaiting input, awaiting approval, completed, interrupted, and
error states help you find the session that needs attention.

Persistent orchestrator lanes can be configured separately from individual
coding tasks. Their presence does not imply that every open agent is part of
the same autonomous run.

## Scoped runs, workers, and validation

Represent a unit of work as a run with a goal, repository/workspace scope, and
acceptance criteria. The orchestration layer records lifecycle events, dispatches
workers, observes completion, and coordinates validation and follow-up work.

The Run Board projects that history into a usable overview: queued work, active
runs, work ready for review, completed results, and blockers. Evidence and
recorded state make it possible to inspect what happened after an agent stops.

The run ledger is append-only. A board status is a view of recorded events,
not a substitute for reviewing the resulting code or checking the relevant
pull request. Automatic integration depends on the configured owner
authorization and checks.

## Reusable loops

Save a workflow, give it inputs and a target, and follow its iterations from the
Loops interface. Templates include:

- **Validate & Park:** a builder/validator cycle that stops with work ready for review.
- **CI Harden:** repeat repository checks and repair failures toward the template's passing threshold.
- **Docs Sweep:** run a scoped documentation maintenance workflow.
- **Dependency Triage:** inspect and work through dependency maintenance.
- **Ship:** an explicitly authorized integration workflow with additional validation requirements.

Loop definitions carry their own scope, skills, evidence contract, permissions,
and stop conditions. The engine tracks lineage and progress, and can stop for
convergence, no progress, a blocker, or a required owner decision. Optional
ceilings include iterations, elapsed runtime, expiry, and reported spend.

Configured interval and daily schedules run inside the application; ACE CODER
must be running for them to fire. Event triggers require the corresponding
event integration. Reported-spend ceilings depend on available telemetry and
are not a provider billing cap.

## Native terminals and session continuity

Agent sessions run in real PTYs. Coding lanes retain the native CLI interface,
including the provider's own interactive commands and prompts. Extra shell
terminals let you run tests, inspect output, or perform supporting work alongside
the agent.

The application tracks stream state, terminal buffers, and session identifiers.
It includes detached PTY-host adoption and provider-specific resume handling to
restore supported sessions after relaunch. Resume behavior varies by provider;
not every CLI exposes the same session controls.

The backend includes transcript normalization for Claude, Codex, Gemini, and
Hermes. In the current interface, **structured chat rendering is enabled for
Hermes; Claude, Codex, and Gemini coding lanes use the terminal view**. The
existence of a transcript adapter is not a promise of a chat toggle for every
provider.

Hermes home sharing uses filesystem symlinks. On Windows, that flow requires
permission to create symlinks; it is not validated by the browser showcase.

## Rich input on supported chat surfaces

The enhanced composer supports draft persistence, file references, slash-command
selection, file/image attachments, paste and drag-and-drop input, and attachment
previews. Provider-specific composer implementations connect the controls to
the relevant CLI behavior. Mobile input adds touch-oriented actions and
terminal keys.

Attachment handling preserves the difference between files already on the
desktop and files uploaded from a remote device. Submission errors are surfaced
when bytes cannot be persisted. Which enhanced composer is reachable follows
the chat-surface limits above; native CLI capabilities remain provider-specific.

## Code, diffs, and GitHub

Browse and edit task files in the Monaco editor, review changed files, stage or
unstage individual files or all changes, and commit from the application.
Branch and worktree controls keep the checked-out context visible.

Connect your own GitHub account to browse repositories, clone projects, and use
repository/PR operations. The integration gateway supports branch pushes,
draft/open pull requests, checks, review requests, merges, and cleanup. It
evaluates task scope, expected base state, PR head state, and relevant checks
as part of the integration workflow.

Those checks make integration decisions inspectable; they do not guarantee
that a change is correct or secure. Your GitHub permissions and repository
branch rules still apply. GitHub sign-in is optional for local-only work.

## Jira and in-house team tickets

Connect Jira Cloud with your own email/API token, Jira Data Center with a PAT,
or a JSON ticket service with optional Bearer authentication. Save multiple
connections, search by JQL or your service's query, page through results, and
read the ticket's normalized text before choosing what to run.

Select a local project and an eligible installed agent, optionally add your
instruction, then launch the reviewed snapshot in a Git worktree or the project
directory. The app starts the CLI and submits the context once it is ready.
If provider login or setup blocks delivery, the created task still opens and
keeps the context in Task spec for you to send after setup. Launch previews
expire after ten minutes and are single-use. Refresh before launching again.

Tokens remain in OS-encrypted desktop storage and are excluded from the prompt.
The ticket connector performs no board writeback and is unavailable to paired
remote clients. ACE does not enable permission bypass for these tasks; profiles
that always bypass permission prompts are excluded. Provider configuration and
data-sharing rules still apply. This is not a sandbox or a Jira Marketplace
integration. See the [setup and JSON API guide](TEAM-TICKETS.md), including the
Jira Cloud personal/internal-use scope and distributed-app requirements.

## Task-scoped browser workspace

Keep browser tabs alongside a task's terminals and editor panes. Browser controls
support navigation and page inspection, and the CLI exposes task-scoped browser
operations such as screenshots, element inspection, and input.

The optional browser MCP surface lets compatible agents access those controls.
It operates against attached browser tabs; it is not a universal automation
driver for arbitrary desktop applications. Browser pages can contact external
services and maintain their own sessions.

## Skills, MCP servers, and automation interfaces

Search the skills catalog, inspect skill content, install or remove available
skills, and create local skills. Bundled workflow skills provide reusable
instructions for planning, building, reviewing, and operating agent work.

The MCP catalog supports installed-server management, catalog entries, and
custom server configuration. Select compatible providers and supply your own
service configuration and credentials where required. A catalog listing does
not supply a service account or guarantee that a third-party server is working.

The `ace` command-line interface exposes machine-readable command descriptions
and operations for streams, tasks, runs, integration, memory, loops, and browser
tabs. `ace mcp-core` and `ace mcp-browser` provide MCP stdio entry points for
compatible clients. The desktop runtime must be available for operations that
act on its workspace state.

## Searchable project knowledge and wiki graphs

Keep project knowledge in local files and retrieve it through a SQLite FTS5
index. Search combines text relevance with trust, freshness, and decay signals.
Results retain provenance and metadata so an old note need not be mistaken for
a current fact.

The Knowledge interface brings together search, wiki health, quarantine review,
and a linked-page graph. Wiki indexing tracks links, backlinks, trust tiers, and
freshness. Curated knowledge and raw agent observations remain distinct; a
retrieved note is still something to assess against current evidence.

The knowledge database is a rebuildable index. It is not model training, and
the feature does not promise that agents will recall every past interaction.

## Monitor, intelligence, and provider usage

The Monitor view combines agent liveness with runtime, database, service, and
repository/CI findings. Open the relevant lane, inspect evidence, or refresh
probes when something needs attention. The Intel surfaces organize configured
sources, briefs, and related operational context.

Provider usage surfaces read available Claude/Codex signals and show freshness
or missing-data states. They do not infer a complete account bill or fabricate
limits for providers that expose none. Local telemetry records operational
events and supports queries and rollups by project, agent, lane, and severity.
Treat application logs and transcripts as potentially sensitive local data.

## Remote access and mobile layout

Remote access is optional. Enable it for a chosen network mode: loopback, LAN,
or your own Tailscale setup. Pair a browser using a short-lived enrollment link
or QR code, then manage and revoke enrolled devices from the desktop.

The responsive interface provides mobile navigation, task views, agent lanes,
terminals, and browser interactions. The desktop remains the host and must stay
running. Tailscale HTTPS availability depends on your installation and setup;
LAN mode is intended for a network you trust.

A paired browser can control the workspace. Device pairing does not turn this
into a hardened, multi-tenant public hosting service. The public edition has no
Skysphere-operated Cloudflare tunnel or release-service dependency.

## Local data and storage choices

ACE CODER creates and maintains its local SQLite databases, including application
state, transcripts, and the knowledge index. Schema setup and migrations remain
part of the application. Fresh installations use their own data; the public
source does not need an existing production database.

Storage settings expose the active data root and agent data locations. External
storage routing is opt-in and requires platform-appropriate configuration.
Changing the configured root takes effect after relaunch and **does not move
the existing dataset**. The current chooser's path validation is POSIX-oriented;
native Windows path selection needs validation before relying on that UI flow.

## Public-edition boundaries

- Local desktop startup does not require Skysphere authentication or an ACE seat.
- GitHub uses your own account; coding agents use your own provider access.
- The private Cloudflare release pipeline and private automatic updater are not part of the public-edition workflow.
- Provider APIs, MCP servers, browser pages, GitHub, and optional services can send data over the network. Local state is not a promise that code never leaves your machine.
- macOS and Windows packaging targets are configured. Linux desktop packages and feature parity across every CLI/platform are not claimed here.
- This feature tour is a source-backed description, not a certification that every integration has passed an end-to-end test in your environment.
- This repository is a read-only source release. Develop changes in your own fork; the release mirror does not accept pull requests or offer a maintenance commitment.

See the [README](../README.md) for setup and the [third-party notices](../THIRD_PARTY_NOTICES.md)
for licensing information.
