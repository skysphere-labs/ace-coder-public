// Single source-of-truth registry for every ace CLI command.
//
// Each entry describes invocation, dispatch target (IPC method or special
// handler), flags, positionals, exit codes, examples, and an output shape.
// The CLI dispatcher in index.cjs reads from here; `ace describe`
// surfaces it to agents at runtime so there's no SKILL.md drift.
//
// Conventions:
//   - `cli` is the user-typed invocation, e.g. "ls", "task run".
//   - `ipcMethod` is either a backend method name ("streamList") or a
//     pseudo-method prefixed with `orchestrator:` / `special:` for handlers
//     that don't translate to a single IPC call.
//   - flag types: 'string' | 'number' | 'boolean' | 'string-repeated'.
//   - Exit codes: 0 ok, 2 arg-error, 3 transport-error, 4 timeout,
//     5 server-error. Per-command may add 6 not-found, 7 conflict.

const EXIT_CODES = Object.freeze({
  0: 'ok',
  2: 'arg-error',
  3: 'transport-error',
  4: 'timeout',
  5: 'server-error',
  6: 'not-found',
  7: 'conflict',
});

const baseExits = { 0: 'ok', 2: 'arg-error', 3: 'transport-error', 4: 'timeout', 5: 'server-error' };
const withNotFound = { ...baseExits, 6: 'not-found' };
const withConflict = { ...baseExits, 6: 'not-found', 7: 'conflict' };

const rawCommands = [
  {
    cli: 'ls',
    description: 'List all Ace agent streams (live PTYs and dormant conversations).',
    ipcMethod: 'streamList',
    examples: [
      { cmd: 'ace ls', description: 'List every stream the running Ace exposes.' },
      { cmd: 'ace --json ls | jq \'.data.streams[].streamId\'', description: 'Pipe stream ids to another tool.' },
    ],
    outputShape: {
      type: 'object',
      properties: {
        streams: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              streamId: { type: 'string' },
              agent: { type: 'string' },
              state: { type: 'string' },
              taskId: { type: 'string' },
              workspaceId: { type: 'string' },
              label: { type: 'string' },
            },
          },
        },
      },
    },
  },
  {
    cli: 'screen',
    description: 'Read current screen + scrollback of a stream. Without --json, prints raw ANSI.',
    ipcMethod: 'streamReadScreen', notFound: true,
    flags: [
      { name: '--tail', type: 'number', required: false, description: 'Return only the last N lines.' },
    ],
    positionals: [
      { name: 'streamId', required: true, description: 'Stream id from `ace ls`.' },
    ],
    examples: [
      { cmd: 'ace screen conversation:abc', description: 'Print full screen as ANSI text.' },
      { cmd: 'ace --json screen conversation:abc --tail 50', description: 'JSON envelope, last 50 lines.' },
    ],
    outputShape: {
      type: 'object',
      properties: { text: { type: 'string' }, lines: { type: 'integer' } },
    },
  },
  {
    cli: 'state',
    description: 'Get the state-machine state: booting | awaiting-input | busy | turn-complete | awaiting-approval | interrupted | error.',
    ipcMethod: 'streamGetState', notFound: true,
    positionals: [
      { name: 'streamId', required: true, description: 'Stream id.' },
    ],
    examples: [
      { cmd: 'ace state conversation:abc', description: 'Print current state JSON.' },
    ],
    outputShape: {
      type: 'object',
      properties: { state: { type: 'string' }, lastTransitionAt: { type: 'integer' } },
    },
  },
  {
    cli: 'ask',
    description: 'Deliver a prompt to a stream and wait for turn-complete. Returns {endState, elapsedMs, newOutput}.',
    ipcMethod: 'streamAsk', notFound: true,
    flags: [
      { name: '--timeout', type: 'number', required: false, description: 'Per-turn timeout in milliseconds.' },
    ],
    positionals: [
      { name: 'streamId', required: true, description: 'Target stream id.' },
      { name: 'prompt', required: true, description: 'Text to deliver.' },
    ],
    examples: [
      { cmd: 'ace ask conversation:abc "What did you change?"', description: 'Send a prompt and block until done.' },
    ],
    outputShape: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        endState: { type: 'string' },
        elapsedMs: { type: 'integer' },
        newOutput: { type: 'string' },
      },
    },
  },
  {
    cli: 'send',
    description: 'Send input to a stream without waiting. Modes: paste | type | keys.',
    ipcMethod: 'streamSendInput', notFound: true,
    flags: [
      { name: '--mode', type: 'string', required: false, default: 'paste', choices: ['paste', 'type', 'keys'], description: 'Delivery mode. paste is fast; type is visible; keys is for special keys.' },
    ],
    positionals: [
      { name: 'streamId', required: true, description: 'Target stream id.' },
      { name: 'text', required: true, description: 'Text payload.' },
    ],
    examples: [
      { cmd: 'ace send conversation:abc "hello" --mode type', description: 'Type the text key-by-key.' },
    ],
    outputShape: { type: 'object', properties: { ok: { type: 'boolean' } } },
  },
  {
    cli: 'keys',
    description: 'Send a named key (Enter, Escape, Ctrl+C, etc.) to a stream. Optional repeat count.',
    ipcMethod: 'streamSendKeys', notFound: true,
    flags: [
      { name: '--repeat', type: 'number', required: false, description: 'Send the key N times.' },
    ],
    positionals: [
      { name: 'streamId', required: true, description: 'Target stream id.' },
      { name: 'name', required: true, description: 'Key name (Enter, Escape, Up, Down, Tab, Ctrl+C, ...).' },
    ],
    examples: [
      { cmd: 'ace keys conversation:abc Enter', description: 'Press Enter once.' },
      { cmd: 'ace keys conversation:abc Down --repeat 5', description: 'Cursor down five times.' },
    ],
    outputShape: { type: 'object', properties: { ok: { type: 'boolean' } } },
  },
  {
    cli: 'submit',
    description: 'Press Enter on a stream to submit the currently composed input.',
    ipcMethod: 'streamSubmit', notFound: true,
    positionals: [
      { name: 'streamId', required: true, description: 'Target stream id.' },
    ],
    examples: [
      { cmd: 'ace submit conversation:abc', description: 'Submit pending input.' },
    ],
    outputShape: { type: 'object', properties: { ok: { type: 'boolean' } } },
  },
  {
    cli: 'composer clear',
    description: 'Clear the current composer/input buffer without submitting it.',
    ipcMethod: 'streamClearComposer', notFound: true,
    positionals: [
      { name: 'streamId', required: true, description: 'Target stream id.' },
    ],
    examples: [
      { cmd: 'ace composer clear conversation:abc', description: 'Clear pending composer text before reusing a stream.' },
    ],
    outputShape: { type: 'object', properties: { ok: { type: 'boolean' }, streamId: { type: 'string' } } },
  },
  {
    cli: 'abort',
    description: 'Abort the current turn on a stream (Esc / Ctrl+C semantics depending on agent profile).',
    ipcMethod: 'streamAbort', notFound: true,
    positionals: [
      { name: 'streamId', required: true, description: 'Target stream id.' },
    ],
    examples: [
      { cmd: 'ace abort conversation:abc', description: 'Cancel the in-flight turn.' },
    ],
    outputShape: { type: 'object', properties: { ok: { type: 'boolean' }, state: { type: 'string' } } },
  },
  {
    cli: 'wait',
    description: 'Wait for a predicate on a stream: turn-complete, awaiting-input, awaiting-approval, named state, regex match, or quiet-for window.',
    ipcMethod: 'streamWaitFor', notFound: true,
    flags: [
      { name: '--turn-complete', type: 'boolean', required: false, description: 'Wait for the worker to finish its current turn.' },
      { name: '--awaiting-input', type: 'boolean', required: false, description: 'Wait for the worker to be ready for input.' },
      { name: '--awaiting-approval', type: 'boolean', required: false, description: 'Wait for an approval prompt.' },
      { name: '--busy', type: 'boolean', required: false, description: 'Wait for the worker to enter the busy state.' },
      { name: '--state', type: 'string', required: false, description: 'Wait for a specific named state.' },
      { name: '--pattern', type: 'string', required: false, description: 'Wait until this regex matches the screen.' },
      { name: '--quiet-for', type: 'number', required: false, description: 'Wait until the screen has been quiet for N ms.' },
      { name: '--timeout', type: 'number', required: false, description: 'Overall timeout in milliseconds.' },
    ],
    positionals: [
      { name: 'streamId', required: true, description: 'Target stream id.' },
    ],
    examples: [
      { cmd: 'ace wait conversation:abc --turn-complete --timeout 60000', description: 'Block up to 60s for the next turn-complete.' },
      { cmd: 'ace wait conversation:abc --pattern "Y/n" --timeout 10000', description: 'Wait for a Y/n prompt to appear.' },
    ],
    outputShape: { type: 'object', properties: { matched: { type: 'string' }, elapsedMs: { type: 'integer' } } },
  },
  {
    cli: 'slash',
    description: 'Issue an in-app slash command on a stream (e.g. /clear, /model).',
    ipcMethod: 'streamSlash', notFound: true,
    positionals: [
      { name: 'streamId', required: true, description: 'Target stream id.' },
      { name: 'command', required: true, description: 'Slash command name (without the leading /).' },
    ],
    examples: [
      { cmd: 'ace slash conversation:abc clear', description: 'Run /clear inside the agent.' },
    ],
    outputShape: { type: 'object', properties: { ok: { type: 'boolean' } } },
  },
  {
    cli: 'ref',
    description: 'Drop a file reference into the agent\'s composer (uses the agent-specific @-mention syntax).',
    ipcMethod: 'streamRef', notFound: true,
    positionals: [
      { name: 'streamId', required: true, description: 'Target stream id.' },
      { name: 'path', required: true, description: 'File path to reference.' },
    ],
    examples: [
      { cmd: 'ace ref conversation:abc src/index.ts', description: 'Reference src/index.ts in the composer.' },
    ],
    outputShape: { type: 'object', properties: { ok: { type: 'boolean' } } },
  },
  {
    cli: 'approve',
    description: 'Answer an awaiting-approval prompt. Defaults to "yes".',
    ipcMethod: 'streamApprove', notFound: true,
    flags: [
      { name: '--yes', type: 'boolean', required: false, description: 'Approve (default).' },
      { name: '--no', type: 'boolean', required: false, description: 'Reject.' },
    ],
    positionals: [
      { name: 'streamId', required: true, description: 'Target stream id.' },
    ],
    examples: [
      { cmd: 'ace approve conversation:abc --no', description: 'Reject the pending approval.' },
    ],
    outputShape: { type: 'object', properties: { ok: { type: 'boolean' } } },
  },
  {
    cli: 'interrupt',
    description: 'Send the agent-specific interrupt sequence (typically Ctrl+C) to a stream.',
    ipcMethod: 'streamInterrupt', notFound: true,
    positionals: [
      { name: 'streamId', required: true, description: 'Target stream id.' },
    ],
    examples: [
      { cmd: 'ace interrupt conversation:abc', description: 'Hard-interrupt the running turn.' },
    ],
    outputShape: { type: 'object', properties: { ok: { type: 'boolean' }, state: { type: 'string' } } },
  },
  {
    cli: 'spawn',
    description: 'Spawn a new agent conversation inside an existing workspace task. Requires --task.',
    ipcMethod: 'streamSpawn', conflict: true,
    flags: [
      { name: '--task', type: 'string', required: true, description: 'Existing task id.' },
      { name: '--kind', type: 'string', required: false, default: 'cli', choices: ['cli', 'chat'], description: 'Stream kind.' },
      { name: '--force-new', type: 'boolean', required: false, description: 'Bypass related-stream reuse guard and intentionally spawn a duplicate.' },
    ],
    positionals: [
      { name: 'agent', required: true, description: 'Agent id (claude, codex, gemini, ...).' },
    ],
    examples: [
      { cmd: 'ace spawn claude --task tsk_42', description: 'Open a Claude PTY against task tsk_42.' },
    ],
    outputShape: {
      type: 'object',
      properties: { streamId: { type: 'string' }, conversationId: { type: 'string' } },
    },
  },
  {
    cli: 'spawn-adhoc',
    description: 'Create a lightweight thread task in a workspace and spawn an agent into it. No pre-existing task needed.',
    ipcMethod: 'streamSpawnAdhoc', conflict: true,
    flags: [
      { name: '--workspace', type: 'string', required: true, description: 'Target workspace id.' },
      { name: '--label', type: 'string', required: false, description: 'Human-readable tab title.' },
      { name: '--kind', type: 'string', required: false, default: 'cli', choices: ['cli', 'chat'], description: 'Stream kind.' },
      { name: '--force-new', type: 'boolean', required: false, description: 'Bypass related-stream reuse guard and intentionally spawn a duplicate.' },
      { name: '--prompt', type: 'string', required: false, description: 'Opening prompt to type into the tab once it is ready (visible to the user).' },
      { name: '--mode', type: 'string', required: false, default: 'type', choices: ['paste', 'type'], description: 'Delivery mode for --prompt. Type is visible; paste is fast.' },
    ],
    positionals: [
      { name: 'agent', required: true, description: 'Agent id.' },
    ],
    examples: [
      { cmd: 'ace spawn-adhoc claude --workspace prj_42 --label scratch', description: 'Spawn a scratch Claude tab.' },
      { cmd: 'ace spawn-adhoc claude --workspace prj_42 --prompt "Read README.md and summarize"', description: 'Spawn and deliver an opening prompt.' },
    ],
    outputShape: {
      type: 'object',
      properties: {
        streamId: { type: 'string' },
        conversationId: { type: 'string' },
        taskId: { type: 'string' },
        promptDelivered: { type: 'boolean' },
        promptError: { type: 'string' },
      },
    },
  },
  {
    cli: 'orchestrator start',
    description: 'Start (or reuse) a manual/recovery controller thread in a workspace. Defaults to Claude; Hermes remains available explicitly for intake/recovery lanes.',
    ipcMethod: 'streamStartOrchestrator', notFound: true,
    flags: [
      { name: '--workspace', type: 'string', required: true, description: 'Target workspace id.' },
      { name: '--agent', type: 'string', required: false, default: 'claude', choices: ['hermes', 'claude', 'codex', 'qwen', 'gemini', 'opencode', 'cursor', 'amp', 'copilot', 'droid'], description: 'Which supported CLI provider drives the controller thread.' },
    ],
    examples: [
      { cmd: 'ace orchestrator start --workspace prj_42', description: 'Start (or reuse) the Claude manual/recovery controller for prj_42.' },
      { cmd: 'ace orchestrator start --workspace prj_42 --agent hermes', description: 'Explicitly start a Hermes intake/recovery lane.' },
    ],
    outputShape: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        agent: { type: 'string' },
        reused: { type: 'boolean' },
      },
    },
  },
  {
    cli: 'workspace create',
    description: 'Create a local directory if needed, add it as a Ace workspace, and optionally initialize git.',
    ipcMethod: 'special:workspaceCreate', notFound: true,
    flags: [
      { name: '--path', type: 'string', required: true, description: 'Local directory path to create/import. Supports ~ for the home directory.' },
      { name: '--init-git', type: 'boolean', required: false, description: 'Run git init after importing the workspace if it is not already initialized.' },
      { name: '--dry-run', type: 'boolean', required: false, description: 'Resolve the path and report what would happen without creating directories or contacting Ace.' },
    ],
    examples: [
      { cmd: 'ace workspace create --path ~/Projects/new-app --init-git', description: 'Create/import a workspace and initialize git.' },
      { cmd: 'ace --json workspace create --path /tmp/scratch --dry-run', description: 'Show the resolved workspace path without changing disk state.' },
    ],
    outputShape: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string' },
        path: { type: 'string' },
        existed: { type: 'boolean' },
        createdDirectory: { type: 'boolean' },
        initialized: { type: 'boolean' },
        dryRun: { type: 'boolean' },
      },
    },
  },
  {
    cli: 'workspace base-branch',
    description: 'Get or set the preferred base branch for a workspace. Without --set, returns the current effective base branch.',
    ipcMethod: 'special:workspaceBaseBranch', notFound: true,
    flags: [
      { name: '--workspace', type: 'string', required: true, description: 'Target workspace id.' },
      { name: '--set', type: 'string', required: false, description: 'Preferred base branch/ref to persist after validating it exists, for example main, origin/main, or refs/remotes/origin/main.' },
      { name: '--clear', type: 'boolean', required: false, description: 'Clear the preferred base branch and return the workspace effective base.' },
      { name: '--unset', type: 'boolean', required: false, description: 'Alias for --clear.' },
    ],
    examples: [
      { cmd: 'ace workspace base-branch --workspace prj_42', description: 'Print the current effective base branch.' },
      { cmd: 'ace workspace base-branch --workspace prj_42 --set origin/main', description: 'Persist origin/main as the preferred base branch.' },
    ],
    outputShape: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        preferredBaseBranch: { type: 'string' },
        defaultBranch: { type: 'string' },
        effectiveBaseBranch: { type: 'string' },
      },
    },
  },
  {
    cli: 'doctor workspace',
    description: 'Print the caller-vs-active workspace instance context and the workspaces visible in the active Ace instance.',
    ipcMethod: 'special:doctorWorkspace', notFound: true,
    examples: [
      { cmd: 'ace doctor workspace', description: 'Show active instance tag, caller tag, caller workspace id, mismatch flag, and active-instance workspaces.' },
    ],
    outputShape: {
      type: 'object',
      properties: {
        activeInstanceTag: { type: 'string' },
        callerInstanceTag: { type: 'string' },
        callerWorkspaceId: { type: 'string' },
        mismatch: { type: 'boolean' },
        workspacesInActiveInstance: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
            },
          },
        },
      },
    },
  },
  {
    cli: 'control-plane status',
    description: 'Run a compact Ace control-plane health check for one workspace, including Mission Board, Hermes home, skills, ledger, wiki, and GitHub auth posture.',
    ipcMethod: 'special:controlPlaneStatus', notFound: true,
    flags: [
      { name: '--workspace', type: 'string', required: true, description: 'Workspace id to inspect.' },
      { name: '--expected-runtime-sha', alias: '--expect-sha', type: 'string', required: false, description: 'Expected source/build SHA for installed-runtime freshness checks.' },
    ],
    examples: [
      { cmd: 'ace --json control-plane status --workspace prj_42', description: 'Check workspace control-plane health.' },
    ],
    outputShape: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string' },
        repoRoot: { type: ['string', 'null'] },
        aceSocket: { type: 'string' },
        missionBoard: { type: 'string' },
        hermesHome: { type: 'string' },
        skills: { type: 'string' },
        toolLedgerPath: { type: 'string' },
        wikiPath: { type: 'string' },
        wikiHealth: { type: 'string' },
        githubAuth: { type: 'string' },
        activeNextActions: { type: 'array' },
        sourceRuntime: { type: 'object' },
        warnings: { type: 'array' },
      },
    },
  },
  {
    cli: 'ops status',
    description: 'Run the Operations Cockpit health probes (runtime, fd, db, service, ci) and return a severity-tagged HealthFinding rollup (ace.ops.status.v1). Read-only; exits 0 even when findings are red or black. Workspace is optional — omit it for system-wide probes.',
    ipcMethod: 'special:opsStatus', notFound: true,
    flags: [
      { name: '--workspace', type: 'string', required: false, description: 'Workspace id to scope CI/PR-drift probing. Omit for system-wide probes.' },
      { name: '--probes', type: 'string', required: false, description: 'Comma-separated subset of runtime,fd,db,service,ci (default: all five).' },
      { name: '--config', type: 'string', required: false, description: 'Path to ops-config.json (default: $ACE_HOME/ops-config.json or ~/.ace-coder/ops-config.json). Missing/unparseable config degrades to defaults with a warning.' },
      { name: '--expected-runtime-sha', alias: '--expect-sha', type: 'string', required: false, description: 'Expected source/build SHA for runtime drift detection (reused from control-plane status).' },
    ],
    examples: [
      { cmd: 'ace --json ops status', description: 'Run all five probes system-wide.' },
      { cmd: 'ace --json ops status --probes runtime,db', description: 'Run only the runtime and DB/WAL probes.' },
      { cmd: 'ace --json ops status --workspace prj_42', description: 'Include CI/PR-drift for one workspace.' },
    ],
    outputShape: {
      type: 'object',
      properties: {
        schema: { type: 'string' },
        timestamp: { type: 'string' },
        workspaceId: { type: ['string', 'null'] },
        configPath: { type: 'string' },
        rollup: {
          type: 'object',
          properties: {
            severity: { type: 'string' },
            green: { type: 'number' },
            yellow: { type: 'number' },
            red: { type: 'number' },
            black: { type: 'number' },
            counts: { type: 'object' },
          },
        },
        findings: { type: 'array' },
        warnings: { type: 'array' },
      },
    },
  },
  {
    cli: 'perf health',
    description: 'Read the in-memory desktop performance ring buffer for slow core spans and long visible spinners (ace.perf-health/v1). Read-only; use after reproducing a spinner or lag event in the running app.',
    ipcMethod: 'perfHealth', notFound: true,
    flags: [],
    examples: [
      { cmd: 'ace --json perf health', description: 'Return slow spans, long spinners, counts, and recent events from the running desktop app.' },
    ],
    outputShape: {
      type: 'object',
      properties: {
        schema: { type: 'string' },
        generatedAt: { type: 'string' },
        ok: { type: 'boolean' },
        counts: { type: 'object' },
        slowSpans: { type: 'array' },
        longSpinners: { type: 'array' },
        recent: { type: 'array' },
      },
    },
  },
  {
    cli: 'github tracked-projects',
    description: 'List GitHub repositories currently tracked as Ace workspaces, including wiki entrypoints, active tasks, and open PRs.',
    ipcMethod: 'streamTrackedGithubProjects', notFound: true,
    examples: [
      { cmd: 'ace github tracked-projects --json', description: 'Give agents a current Ace GitHub project/wiki/action index.' },
    ],
    outputShape: {
      type: 'object',
      properties: {
        projects: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              workspaceId: { type: 'string' },
              workspaceName: { type: 'string' },
              workspacePath: { type: ['string', 'null'] },
              githubRepo: { type: 'string' },
              githubUrl: { type: 'string' },
              defaultBranch: { type: 'string' },
              wikiPath: { type: ['string', 'null'] },
              wikiExists: { type: 'boolean' },
              activeTasks: { type: 'array' },
              openPrs: { type: 'array' },
            },
          },
        },
      },
    },
  },
  {
    cli: 'close',
    description: 'Close a stream (kills the PTY; keeps the DB row).',
    ipcMethod: 'streamClose', notFound: true,
    positionals: [
      { name: 'streamId', required: true, description: 'Target stream id.' },
    ],
    examples: [
      { cmd: 'ace close conversation:abc', description: 'Kill the PTY for this stream.' },
    ],
    outputShape: { type: 'object', properties: { ok: { type: 'boolean' } } },
  },
  {
    cli: 'rename',
    description: 'Rename a stream\'s tab label.',
    ipcMethod: 'streamRename', notFound: true,
    positionals: [
      { name: 'streamId', required: true, description: 'Target stream id.' },
      { name: 'label', required: true, description: 'New label.' },
    ],
    examples: [
      { cmd: 'ace rename conversation:abc "review pass"', description: 'Re-label the tab.' },
    ],
    outputShape: { type: 'object', properties: { ok: { type: 'boolean' } } },
  },
  {
    cli: 'record',
    description: 'Start recording a stream\'s output to the given file path (NDJSON of PTY frames).',
    ipcMethod: 'streamRecordStart', notFound: true,
    positionals: [
      { name: 'streamId', required: true, description: 'Target stream id.' },
      { name: 'outPath', required: true, description: 'Output file path.' },
    ],
    examples: [
      { cmd: 'ace record conversation:abc /tmp/sess.ndjson', description: 'Record the stream until `record-stop`.' },
    ],
    outputShape: { type: 'object', properties: { ok: { type: 'boolean' }, path: { type: 'string' } } },
  },
  {
    cli: 'record-stop',
    description: 'Stop an active recording on a stream.',
    ipcMethod: 'streamRecordStop', notFound: true,
    positionals: [
      { name: 'streamId', required: true, description: 'Target stream id.' },
    ],
    examples: [
      { cmd: 'ace record-stop conversation:abc', description: 'Stop the recording.' },
    ],
    outputShape: { type: 'object', properties: { ok: { type: 'boolean' } } },
  },
  {
    cli: 'replay',
    description: 'Replay a previously recorded NDJSON file into a fresh agent stream.',
    ipcMethod: 'streamReplay', notFound: true,
    flags: [
      { name: '--agent', type: 'string', required: false, description: 'Agent id to replay against.' },
    ],
    positionals: [
      { name: 'recordPath', required: true, description: 'Path to a recording produced by `record`.' },
    ],
    examples: [
      { cmd: 'ace replay /tmp/sess.ndjson --agent claude', description: 'Replay a recorded session.' },
    ],
    outputShape: {
      type: 'object',
      properties: { streamId: { type: 'string' }, frames: { type: 'integer' } },
    },
  },
  {
    cli: 'follow',
    description: 'Read all output produced since the previous follow call. Without --json, prints raw text.',
    ipcMethod: 'streamFollow', notFound: true,
    positionals: [
      { name: 'streamId', required: true, description: 'Target stream id.' },
    ],
    examples: [
      { cmd: 'ace follow conversation:abc', description: 'Print new output since last follow.' },
      { cmd: 'ace --json follow conversation:abc', description: 'Same, wrapped in {ok,data}.' },
    ],
    outputShape: { type: 'object', properties: { text: { type: 'string' } } },
  },
  {
    cli: 'snapshot',
    description: 'Save a stream\'s screen as .ansi + .txt under $TMPDIR/ace-snapshots.',
    ipcMethod: 'streamSnapshot', notFound: true,
    positionals: [
      { name: 'streamId', required: true, description: 'Target stream id.' },
    ],
    examples: [
      { cmd: 'ace snapshot conversation:abc', description: 'Save snapshot files; print their paths.' },
    ],
    outputShape: {
      type: 'object',
      properties: { ansiPath: { type: 'string' }, textPath: { type: 'string' } },
    },
  },
  {
    cli: 'watch',
    description: 'Subscribe to event stream (state, ready, approval, worker-completion, ...). Local socket transport only. Blocks until interrupted.',
    ipcMethod: 'special:watch',
    flags: [
      { name: '--id', type: 'string', required: false, description: 'Filter to a single stream id.' },
      { name: '--event', type: 'string', required: false, description: 'Comma-separated event names to allow.' },
    ],
    examples: [
      { cmd: 'ace watch --event state,ready', description: 'Stream state + ready events.' },
      { cmd: 'ace watch --event worker-completion', description: 'Stream passive worker DONE/BLOCKED/VERDICT handoff events without messaging an operator lane.' },
      { cmd: 'ace watch --id conversation:abc', description: 'Stream events for one stream.' },
    ],
    outputShape: {
      type: 'object',
      description: 'Streamed line-delimited JSON events; each line is {event, payload, ts}.',
    },
  },
  {
    cli: 'completion list',
    description: 'List passive worker completion inbox records queued from DONE/BLOCKED/VERDICT trailers. Does not message or interrupt any stream.',
    ipcMethod: 'streamCompletionList',
    flags: [
      { name: '--workspace', type: 'string', required: false, description: 'Filter to a workspace id.' },
      { name: '--id', type: 'string', required: false, description: 'Filter to a stream id.' },
      { name: '--include-acked', type: 'boolean', required: false, description: 'Include records already acknowledged by a controller.' },
    ],
    examples: [
      { cmd: 'ace completion list', description: 'List unacknowledged validation-ready worker completions.' },
      { cmd: 'ace --json completion list --workspace prj_42', description: 'Return queued completions for one workspace.' },
    ],
    outputShape: {
      type: 'object',
      properties: {
        completions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              streamId: { type: 'string' },
              taskId: { type: 'string' },
              workspaceId: { type: 'string' },
              branch: { type: 'string' },
              worktreePath: { type: 'string' },
              kind: { type: 'string' },
              detail: { type: 'string' },
              timestamp: { type: 'integer' },
            },
          },
        },
      },
    },
  },
  {
    cli: 'completion ack',
    description: 'Acknowledge one worker completion inbox record after a controller has consumed it.',
    ipcMethod: 'streamCompletionAck',
    notFound: true,
    positionals: [
      { name: 'id', required: true, description: 'Completion id from `completion list`.' },
    ],
    examples: [
      { cmd: 'ace completion ack wc_123_1', description: 'Mark a queued completion consumed.' },
    ],
    outputShape: {
      type: 'object',
      properties: { ok: { type: 'boolean' }, completion: { type: 'object' } },
    },
  },
  {
    cli: 'profiles',
    description: 'List loaded agent profiles (paste vs type, prompt detector, etc.).',
    ipcMethod: 'streamProfiles',
    examples: [
      { cmd: 'ace profiles', description: 'Print the loaded profile registry.' },
    ],
    outputShape: { type: 'object', properties: { profiles: { type: 'array' } } },
  },
  {
    cli: 'reload',
    description: 'Hot-reload profile JSON from disk without restarting Ace.',
    ipcMethod: 'streamReloadProfiles',
    examples: [
      { cmd: 'ace reload', description: 'Re-read profile files.' },
    ],
    outputShape: { type: 'object', properties: { ok: { type: 'boolean' }, count: { type: 'integer' } } },
  },
  {
    cli: 'browser',
    description: 'Control task-scoped Ace browser tabs. Subcommands: list, open, activate, info, navigate, screenshot, click, type, key, scroll, js, cdp, wait, elements, console, inspect-ref, click-ref, type-ref, skills.',
    ipcMethod: 'special:browser', notFound: true,
    flags: [
      { name: '--task', type: 'string', required: false, description: 'Task id. Defaults to $ACE_TASK_ID when available.' },
      { name: '--no-activate', type: 'boolean', required: false, description: 'For open: create the browser tab without activating it.' },
      { name: '--wait', type: 'string', required: false, choices: ['load', 'domcontentloaded', 'none'], description: 'For navigate: wait condition after loadURL.' },
      { name: '--timeout-ms', type: 'number', required: false, description: 'Browser operation timeout in milliseconds.' },
      { name: '--out', type: 'string', required: false, description: 'For screenshot: output PNG path.' },
      { name: '--full-page', type: 'boolean', required: false, description: 'For screenshot: capture beyond the visible viewport.' },
      { name: '--annotate', type: 'boolean', required: false, description: 'For screenshot: also write visible element summaries.' },
      { name: '--x', type: 'number', required: false, description: 'Viewport x coordinate.' },
      { name: '--y', type: 'number', required: false, description: 'Viewport y coordinate.' },
      { name: '--button', type: 'string', required: false, choices: ['left', 'right', 'middle'], description: 'Mouse button for click.' },
      { name: '--click-count', type: 'number', required: false, description: 'Mouse click count.' },
      { name: '--dx', type: 'number', required: false, description: 'Horizontal scroll delta.' },
      { name: '--dy', type: 'number', required: false, description: 'Vertical scroll delta.' },
      { name: '--session-id', type: 'string', required: false, description: 'Optional CDP session id.' },
      { name: '--load', type: 'boolean', required: false, description: 'For wait: wait for page load.' },
      { name: '--text', type: 'string', required: false, description: 'For wait: text that must appear in document body.' },
      { name: '--selector', type: 'string', required: false, description: 'For wait: CSS selector that must exist.' },
      { name: '--url', type: 'string', required: false, description: 'For wait: URL regex pattern.' },
      { name: '--visible', type: 'boolean', required: false, description: 'For elements: include only visible viewport elements.' },
      { name: '--all', type: 'boolean', required: false, description: 'For elements: include non-visible matching elements.' },
      { name: '--level', type: 'string', required: false, choices: ['all', 'problems', 'error', 'warning', 'warnings'], description: 'For console: diagnostic level filter.' },
      { name: '--errors', type: 'boolean', required: false, description: 'For console: shorthand for --level error.' },
      { name: '--limit', type: 'number', required: false, description: 'For elements/console: max rows.' },
      { name: '--since-seq', type: 'number', required: false, description: 'For console: only diagnostics after this sequence.' },
      { name: '--clear', type: 'boolean', required: false, description: 'For type-ref: select existing text before typing.' },
    ],
    positionals: [
      { name: 'subcommand', required: false, description: 'Browser subcommand.' },
      { name: 'args', required: false, description: 'Subcommand arguments.' },
    ],
    examples: [
      { cmd: 'ace browser list --task tsk_42', description: 'List browser tabs saved for one task.' },
      { cmd: 'ace browser open https://github.com --task tsk_42', description: 'Open a visible task-scoped browser tab after permission.' },
      { cmd: 'ace browser screenshot br-abc --task tsk_42 --out /tmp/ace-browser.png', description: 'Capture an attached tab.' },
      { cmd: 'ace browser click br-abc --task tsk_42 --x 412 --y 530', description: 'Click viewport coordinates in an attached tab.' },
    ],
    outputShape: {
      type: 'object',
      description: 'JSON result from the underlying browser controller method.',
    },
  },
  {
    cli: 'mcp-browser',
    description: 'Run the Ace Browser MCP stdio server against visible task-scoped browser tabs.',
    ipcMethod: 'special:mcpBrowser',
    examples: [
      { cmd: 'ace mcp-browser', description: 'Serve ace_browser_* tools over MCP stdio.' },
    ],
    outputShape: {
      type: 'object',
      description: 'JSON-RPC 2.0 MCP messages on stdin/stdout.',
    },
  },
  {
    cli: 'mcp-core',
    description: 'Run the compact Ace control-plane MCP stdio server for orchestrators.',
    ipcMethod: 'special:mcpCore',
    examples: [
      { cmd: 'ace mcp-core', description: 'Serve ace_core control-plane tools over MCP stdio.' },
    ],
    outputShape: {
      type: 'object',
      description: 'JSON-RPC 2.0 MCP messages on stdin/stdout.',
    },
  },
  {
    cli: 'goal launch',
    description: 'Launch a Hermes-organized goal: tiny/small goals dispatch one worker; medium/large goals spawn a fresh Claude workspace orchestrator controller.',
    ipcMethod: 'special:goalLaunch',
    flags: [
      { name: '--workspace', type: 'string', required: true, description: 'Workspace id where the goal, orchestrator, or worker should be visible.' },
      { name: '--goal', type: 'string', required: false, description: 'Inline brain-dump goal text. Use with or instead of --brief.' },
      { name: '--brief', type: 'string', required: false, description: 'Path to a Markdown/text brief produced from Hermes intake.' },
      { name: '--size', type: 'string', required: false, default: 'auto', choices: ['auto', 'tiny', 'small', 'medium', 'large'], description: 'Routing size. tiny/small dispatch one worker; medium/large spawn a Claude orchestrator. auto defaults to Claude orchestrator unless the text looks trivial.' },
      { name: '--task-type', type: 'string', required: false, description: 'Direct-worker task type for tiny/small launches. Defaults to feature-impl.' },
      { name: '--worker', type: 'string', required: false, description: 'Direct-worker agent override for tiny/small launches.' },
      { name: '--orchestrator-agent', type: 'string', required: false, default: 'claude', description: 'Controller agent for medium/large launches. Defaults to claude.' },
      { name: '--context', type: 'string', required: false, description: 'Extra context appended to the generated TaskSpec context.' },
      { name: '--constraint', type: 'string-repeated', required: false, description: 'Extra constraint, repeatable.' },
      { name: '--deliverable', type: 'string-repeated', required: false, description: 'Extra deliverable, repeatable.' },
      { name: '--acceptance', type: 'string-repeated', required: false, description: 'Acceptance criterion, repeatable.' },
      { name: '--label', type: 'string', required: false, description: 'Tab/task label. Defaults from the launch mode.' },
      { name: '--mode', type: 'string', required: false, default: 'paste', choices: ['paste', 'type'], description: 'Prompt delivery mode.' },
      { name: '--wait', type: 'boolean', required: false, description: 'Wait for the first turn to finish. By default goal launch is fire-and-forget.' },
      { name: '--timeout', type: 'number', required: false, description: 'Per-round wait timeout in milliseconds when --wait is set.' },
      { name: '--dry-run', type: 'boolean', required: false, description: 'Return the resolved launch mode, route, manifest, and prompt budget without spawning.' },
    ],
    examples: [
      { cmd: 'ace goal launch --workspace prj_42 --brief /tmp/hermes-brief.md --size large', description: 'Spawn a fresh Claude orchestrator controller in the workspace.' },
      { cmd: 'ace goal launch --workspace prj_42 --goal "Fix the typo in README" --size tiny', description: 'Dispatch one direct worker for a tiny deterministic task.' },
      { cmd: 'ace --json goal launch --workspace prj_42 --brief /tmp/brief.md --dry-run', description: 'Inspect the resolved launch route without contacting Ace.' },
    ],
    outputShape: {
      type: 'object',
      properties: {
        schema: { type: 'string' },
        launchMode: { type: 'string', enum: ['claude-orchestrator', 'direct-worker'] },
        workspaceId: { type: 'string' },
        size: { type: 'string' },
        agent: { type: 'string' },
        newTask: { type: 'boolean' },
        dryRun: { type: 'boolean' },
        route: { type: 'object' },
        promptChars: { type: 'integer' },
        result: { type: 'object' },
      },
    },
  },
  {
    cli: 'task run',
    description: 'High-level: spawn (or reuse) a stream, deliver a framed task prompt, wait for turn-complete, parse DONE/BLOCKED, optionally loop. Blocks until done unless --fire-and-forget.',
    ipcMethod: 'orchestrator:runTask', conflict: true,
    flags: [
      { name: '--workspace', type: 'string', required: false, description: 'Spawn into this workspace. Without --new-task, creates an adhoc thread (chat-only, no git worktree). With --new-task, creates a full task with its own branch + worktree.' },
      { name: '--new-task', type: 'boolean', required: false, description: 'With --workspace: create a fresh task + git worktree + branch and spawn the agent into it. Required for real feature/bugfix delegations so the child\'s changes don\'t collide.' },
      { name: '--task', type: 'string', required: false, description: 'Spawn into this existing task.' },
      { name: '--stream', type: 'string', required: false, description: 'Attach to this existing stream id.' },
      { name: '--spec', type: 'string', required: false, description: 'Path to a JSON spec file.' },
      { name: '--goal', type: 'string', required: false, description: 'Inline goal text (alternative to --spec).' },
      { name: '--task-type', type: 'string', required: false, description: 'Task type for prompt skill pack and default routing.' },
      { name: '--role-mode', type: 'string', required: false, choices: ['implementer', 'reviewer', 'fixback', 'no-code'], description: 'Prompt/routing mode. Defaults from role + task type.' },
      { name: '--skill-pack', type: 'string', required: false, description: 'Compact skill-pack manifest id. Defaults from --task-type.' },
      { name: '--effort', type: 'string', required: false, choices: ['low', 'medium', 'high', 'xhigh', 'max'], description: 'Agent reasoning effort. Scoped subagents default to medium; non-default values require --effort-override.' },
      { name: '--effort-override', type: 'string', required: false, description: 'Required reason when selecting non-default effort.' },
      { name: '--capability', type: 'string-repeated', required: false, description: 'Capability metadata for routing/prompt manifest (repeatable).' },
      { name: '--tool-mode', type: 'string', required: false, choices: ['off', 'on'], description: 'Tool access mode. Default off; on requires --tool-override.' },
      { name: '--mcp-mode', type: 'string', required: false, choices: ['off', 'global'], description: 'MCP access mode. Default off; global requires --tool-override.' },
      { name: '--browser-mode', type: 'string', required: false, choices: ['off', 'on'], description: 'Browser access mode. Default off; on requires --tool-override.' },
      { name: '--codex-runtime-profile', type: 'string', required: false, choices: ['app-parity'], description: 'Codex runtime profile. app-parity enables app/plugin/computer-use readiness and requires --tool-override.' },
      { name: '--tool-override', type: 'string', required: false, description: 'Required reason for tool, MCP, or browser opt-in.' },
      { name: '--baseline-skill', type: 'string-repeated', required: false, description: 'Override baseline skill ids for the manifest (repeatable).' },
      { name: '--task-pack-skill', type: 'string-repeated', required: false, description: 'Override task-pack skill ids. Prompt rendering caps this list at four.' },
      { name: '--validation-skill', type: 'string-repeated', required: false, description: 'Validation skill ids to stack into the manifest (repeatable).' },
      { name: '--required-skill', type: 'string-repeated', required: false, description: 'Required skill ids; missing required skills block before spawn.' },
      { name: '--optional-skill', type: 'string-repeated', required: false, description: 'Optional skill ids; missing optional skills warn but do not block.' },
      { name: '--context', type: 'string', required: false, description: 'Inline context block.' },
      { name: '--constraint', type: 'string-repeated', required: false, description: 'Add a constraint (repeatable).' },
      { name: '--deliverable', type: 'string-repeated', required: false, description: 'Add a deliverable (repeatable).' },
      { name: '--acceptance', type: 'string-repeated', required: false, description: 'Add an acceptance criterion (repeatable).' },
      { name: '--escape-hatch', type: 'string', required: false, description: 'Override the default DONE/BLOCKED trailer instructions.' },
      { name: '--prompt-budget-override', type: 'string', required: false, description: 'Required reason when the rendered worker prompt exceeds the role-aware hard cap (implementer 2200, reviewer 1800, fixback 1200, no-code 2200).' },
      { name: '--max-rounds', type: 'number', required: false, description: 'Max retry loops if the worker stops without a trailer. Use 0 for unbounded long-run mode (stops only on DONE/BLOCKED/approval/timeout/user interrupt).' },
      { name: '--require-changes', type: 'string', required: false, choices: ['auto', 'true', 'false'], description: 'Require the worktree to contain real changes before accepting DONE. Default auto: enabled when the spec implies code deliverables.' },
      { name: '--max-verify-rounds', type: 'number', required: false, description: 'Max loops spent re-asking the worker to produce changes after a premature DONE (default 3).' },
      { name: '--goal-mode', type: 'string', required: false, choices: ['auto', 'on', 'off'], description: 'Native /goal goal-mode policy (both drivers). Default auto queues a TaskSpec-derived /goal objective for Codex code/UI work; on always activates goal mode — Codex gets the /goal prelude, Claude gets the rich /goal as its fire-and-forget delivery after /effort ultracode; off never queues it.' },
      { name: '--dry-run', type: 'boolean', required: false, description: 'Route dry-run: validate the spec and return a route explanation plus a single JSON route/manifest/prompt-budget envelope without spawning or contacting Ace.' },
      { name: '--force-new', type: 'boolean', required: false, description: 'Bypass related-stream reuse guard and intentionally spawn a duplicate stream.' },
      { name: '--refresh-base', type: 'string', required: false, default: 'false', choices: ['false', 'auto', 'force'], description: 'Base refresh policy for --new-task. Default false avoids git fetch on the spawn hot path; auto uses the threshold refresh, force refreshes before branch selection.' },
      { name: '--mode', type: 'string', required: false, default: 'paste', choices: ['paste', 'type'], description: 'Delivery mode.' },
      { name: '--fire-and-forget', type: 'boolean', required: false, description: 'Send and return immediately; do not wait.' },
      { name: '--timeout', type: 'number', required: false, description: 'Per-round wait timeout in milliseconds.' },
      { name: '--label', type: 'string', required: false, description: 'Tab label for spawned streams.' },
      { name: '--kind', type: 'string', required: false, default: 'cli', choices: ['cli', 'chat'], description: 'Stream kind for new spawns.' },
    ],
    positionals: [
      { name: 'agent', required: false, description: 'Agent id (claude, codex, gemini, ...). Omit to use role/task routing.' },
    ],
    examples: [
      { cmd: 'ace task run codex --workspace prj_42 --new-task --goal "Add a hello route"', description: 'Create a fresh task + worktree and delegate implementation work to Codex.' },
      { cmd: 'ace task run codex --stream conversation:abc --spec /tmp/spec.json --max-rounds 5', description: 'Reuse an existing stream and loop up to 5 times.' },
      { cmd: 'ace task run codex --stream conversation:abc --spec /tmp/spec.json --max-rounds 0', description: 'Run overnight without an arbitrary round cap; still stops on trailer, approval, timeout, or interrupt.' },
      { cmd: 'ace task run claude --workspace prj_42 --goal "Explain the UI bug"', description: 'Explicit Claude specialist aside (no --new-task, no worktree).' },
    ],
    outputShape: {
      type: 'object',
      properties: {
        streamId: { type: 'string' },
        conversationId: { type: 'string' },
        taskId: { type: 'string' },
        agent: { type: 'string' },
        provider: { type: 'string' },
        roleMode: { type: 'string' },
        taskClass: { type: 'string' },
        baselineSkills: { type: 'array' },
        taskPackSkills: { type: 'array' },
        validationSkills: { type: 'array' },
        requiredSkills: { type: 'array' },
        optionalSkills: { type: 'array' },
        warnings: { type: 'array' },
        promptChars: { type: 'integer' },
        validationPolicy: { type: 'object' },
        route: { type: 'object' },
        dryRun: { type: 'boolean' },
        worktreePath: { type: 'string' },
        branch: { type: 'string' },
        baseBranch: { type: 'string' },
        outcome: { type: 'string', enum: ['done', 'done-unverified', 'blocked', 'awaiting-approval', 'max-rounds', 'dispatched', 'dry-run', 'timeout', 'error'] },
        detail: { type: 'string' },
        rounds: { type: 'integer' },
        verifyRounds: { type: 'integer' },
        roundDetails: { type: 'array' },
        telemetry: { type: 'object' },
        lastAssistantText: { type: 'string' },
        fireAndForget: { type: 'boolean' },
        created: { type: 'boolean' },
        verify: {
          type: 'object',
          properties: {
            hasChanges: { type: 'boolean' },
            filesChanged: { type: 'integer' },
            linesAdded: { type: 'integer' },
            linesDeleted: { type: 'integer' },
            changedPaths: { type: 'array' },
          },
        },
      },
    },
  },
  {
    cli: 'task chat',
    description: 'Scripted multi-turn chat against a stream. Each script step is {text, stopOn?, timeoutMs?, mode?}.',
    ipcMethod: 'orchestrator:runChat', conflict: true,
    flags: [
      { name: '--workspace', type: 'string', required: false, description: 'Spawn-adhoc into this workspace.' },
      { name: '--task', type: 'string', required: false, description: 'Spawn into this existing task.' },
      { name: '--stream', type: 'string', required: false, description: 'Attach to this existing stream id.' },
      { name: '--script', type: 'string', required: true, description: 'Path to a JSON-array script file.' },
      { name: '--mode', type: 'string', required: false, default: 'type', choices: ['paste', 'type'], description: 'Delivery mode.' },
      { name: '--label', type: 'string', required: false, description: 'Tab label for spawned streams.' },
      { name: '--kind', type: 'string', required: false, default: 'cli', choices: ['cli', 'chat'], description: 'Stream kind for new spawns.' },
    ],
    positionals: [
      { name: 'agent', required: true, description: 'Agent id.' },
    ],
    examples: [
      { cmd: 'ace task chat claude --stream conversation:abc --script /tmp/chat.json', description: 'Run a scripted multi-turn chat.' },
    ],
    outputShape: {
      type: 'object',
      properties: {
        streamId: { type: 'string' },
        turns: { type: 'array' },
        created: { type: 'boolean' },
      },
    },
  },
  {
    cli: 'relay',
    description: 'Two-stream ping-pong: read last turn of A, send to B, wait, reverse. Stops on DONE/BLOCKED, --stop-on regex, or --max-rounds.',
    ipcMethod: 'orchestrator:relay', notFound: true,
    flags: [
      { name: '--max-rounds', type: 'number', required: false, description: 'Maximum number of rounds (default 8). Use 0 for unbounded long-run relay.' },
      { name: '--stop-on', type: 'string', required: false, description: 'Stop when this regex matches the latest output.' },
      { name: '--seed', type: 'string', required: false, description: 'Opening message sent to <toStreamId> on round 0.' },
      { name: '--mode', type: 'string', required: false, default: 'type', choices: ['paste', 'type'], description: 'Delivery mode.' },
    ],
    positionals: [
      { name: 'fromStreamId', required: true, description: 'Source stream id.' },
      { name: 'toStreamId', required: true, description: 'Target stream id (must differ from <fromStreamId>).' },
    ],
    examples: [
      { cmd: 'ace relay conversation:a conversation:b --max-rounds 6', description: 'Ping-pong six rounds between two streams.' },
    ],
    outputShape: {
      type: 'object',
      properties: {
        rounds: { type: 'integer' },
        roundDetails: { type: 'array' },
        stopReason: { type: 'string' },
        lastSource: { type: 'string' },
        lastTarget: { type: 'string' },
      },
    },
  },
  {
    cli: 'context',
    description: 'Print the current agent\'s workspace/worktree/branch context as JSON. Reads ACE_STREAM_ID from env; override with --stream.',
    ipcMethod: 'streamGetContext', notFound: true,
    flags: [
      { name: '--stream', type: 'string', required: false, description: 'Stream id to look up (defaults to $ACE_STREAM_ID).' },
    ],
    examples: [
      { cmd: 'ace context', description: 'Print this agent\'s context (uses $ACE_STREAM_ID).' },
      { cmd: 'ace context --stream conversation:abc123', description: 'Explicit stream id.' },
      { cmd: 'ace --json context | jq .worktreePath', description: 'Extract the worktree path.' },
    ],
    outputShape: {
      type: 'object',
      properties: {
        streamId: { type: 'string' },
        workspaceId: { type: 'string' },
        workspaceName: { type: 'string' },
        taskId: { type: 'string' },
        conversationId: { type: 'string' },
        agent: { type: 'string' },
        worktreePath: { type: 'string' },
        branch: { type: 'string' },
        baseBranch: { type: 'string' },
        repoRoot: { type: 'string' },
        isRemote: { type: 'boolean' },
        cwd: { type: 'string' },
      },
    },
  },
  {
    cli: 'run board',
    description: 'Read the LEAN run-ledger board — agent-keyed lifecycle cards (todo/in_progress/ready_to_review/done/blocked) with per-card telemetry, projected purely from the event ledger. READ-ONLY watcher: it never dispatches, spawns, gates, or mutates anything; the autonomy loop never reads or waits on it.',
    ipcMethod: 'runBoard',
    flags: [],
    examples: [
      { cmd: 'ace run board', description: 'List the lean run-ledger cards by lifecycle column.' },
      { cmd: 'ace --json run board', description: 'JSON lean board (columns + cards + counts) for tooling.' },
    ],
    outputShape: {
      type: 'object',
      properties: {
        columns: { type: 'object' },
        cards: { type: 'array' },
        counts: { type: 'object' },
      },
    },
  },
  {
    cli: 'run watch',
    description: 'Multi-run transition watcher over the lean run-ledger board — the background eyes a manager agent attaches after dispatch. Polls the READ-ONLY board projection and reports ONLY transitions (state changes for the watched runs), with an action hint per resting state. Never dispatches, gates, or mutates. `--once` is the turn-start pulse: diff against the saved cursor, print what changed since the last pulse, exit 3 when anything needs attention (blocked or parked at ready_to_review).',
    ipcMethod: 'special:runWatch',
    flags: [
      { name: '--runs', type: 'string', required: false, description: 'Comma-separated run ids to watch. Default: every run currently on the board.' },
      { name: '--once', type: 'boolean', required: false, description: 'Single pulse: report transitions since the saved cursor, then exit (0 = calm, 3 = attention needed).' },
      { name: '--interval', type: 'number', required: false, description: 'Watch polling interval in seconds (default 20).' },
      { name: '--timeout-minutes', type: 'number', required: false, description: 'Max watch duration before a summary exit (default 120).' },
      { name: '--digest', type: 'string', required: false, description: 'Append one ndjson record per transition to this file — lets a background watcher feed a manager agent that reads the digest on its next turn.' },
      { name: '--cursor', type: 'string', required: false, description: 'Cursor state file override (default $ACE_HOME/run-watch-cursor.json).' },
    ],
    examples: [
      { cmd: 'ace run watch --once', description: 'Turn-start pulse: what changed since I last looked? Exit 3 = something needs attention.' },
      { cmd: 'ace run watch --runs run-42,run-43 --interval 30 --digest ~/.ace/hermes-watch.ndjson', description: 'Background watcher over two dispatched runs, appending transitions to a digest file until both rest.' },
    ],
    outputShape: {
      type: 'object',
      properties: {
        transitions: { type: 'array' },
        summary: { type: 'object' },
      },
    },
  },
  {
    cli: 'run submit',
    description: 'Submit a goal into the run-ledger spine (the kernel intake). Mints a run, appends intent.created + run.created, and — in the default boot — the autonomy loop dispatches a real worker (and validator) in an isolated worktree, parking the run at ready_to_review unless --autoship or a valid --owner-token can pass the merge gate. Add --auto-iterate to keep refining the SAME branch (a fresh worker per cycle) until it converges — guarded by --max-iterations, a no-progress detector, and computer-use-validated convergence.',
    ipcMethod: 'runSubmit',
    flags: [
      { name: '--goal', type: 'string', required: true, description: 'The goal/spec the worker should accomplish.' },
      { name: '--workspace', type: 'string', required: true, description: 'Workspace id (projects.id) the run dispatches into.' },
      { name: '--agent', type: 'string', required: false, description: 'Driver override (codex/claude). Omit to let the spine pick by task size.' },
      { name: '--acceptance', type: 'string-repeated', required: true, description: 'An acceptance criterion (repeatable; at least one required — dispatch-side parseSpec rejects acceptance-less specs).' },
      { name: '--allow', type: 'string-repeated', required: false, description: 'An allowed path the worker may touch (repeatable).' },
      { name: '--risk', type: 'string', required: false, description: 'Risk tier hint (trivial/small/medium/high).' },
      { name: '--autoship', type: 'boolean', required: false, description: 'Opt this run into the Auto-Ship Loop: after exact-head validator PASS, green current PR checks, clean scope, and policy eligibility, merge through the integration gateway without an owner-token. High-risk/UI/release/hold cases park for owner review.' },
      { name: '--owner-token', type: 'string', required: false, description: 'Per-run owner authorization for merge-to-main. Verified against ACE_OWNER_AUTH_TOKEN; absent => never merges.' },
      { name: '--auto-iterate', type: 'boolean', required: false, description: 'Arm the autonomy OUTER loop: when the run settles with new work, the spine authors the next goal and continues the SAME branch with a fresh worker, until it converges (validator pass + computer-use evidence + no new gaps) or a guard trips (max-iterations / no-progress). Every cycle PARKS — no cycle merges; you merge the converged branch yourself (so --owner-token is ignored with --auto-iterate). Disable all loops with ACE_AUTONOMY_LOOP=0; stop one with `run loop --stop`.' },
      { name: '--max-iterations', type: 'number', required: false, description: 'Max auto-iterate cycles for this lineage before escalating to you (default 5). Only meaningful with --auto-iterate.' },
    ],
    examples: [
      { cmd: 'ace run submit --goal "Add a --version flag" --workspace prj_42 --acceptance "ace --version prints the version"', description: 'Dispatch a run; it parks at ready_to_review (no merge).' },
      { cmd: 'ace --json run submit --goal "Fix flaky test" --workspace prj_42 --agent codex --allow src/ --acceptance "test passes"', description: 'Scoped run, JSON envelope with the runId.' },
      { cmd: 'ace run submit --goal "Fix flaky test" --workspace prj_42 --allow src/ --acceptance "test passes 5x in a row" --autoship', description: 'Opt in to policy-gated autoship after exact-head validation and green PR checks.' },
      { cmd: 'ace run submit --goal "Build the settings panel" --workspace prj_42 --acceptance "settings panel renders and saves" --auto-iterate --max-iterations 4', description: 'Auto-iterate: refine the same branch until converged (≤4 cycles), parked for your merge token.' },
    ],
    outputShape: {
      type: 'object',
      properties: {
        runId: { type: 'string' },
      },
    },
  },
  {
    cli: 'run loop',
    description: 'Control an autonomy OUTER loop lineage. --stop <lineageId> halts a specific loop (it appends a terminal marker so boot-replay never re-arms it); the lineageId is the runId of the lineage\'s first (root) run, shown by `run submit --auto-iterate`. To disable ALL loops at once use the env kill ACE_AUTONOMY_LOOP=0 (the inner spine keeps running).',
    ipcMethod: 'runLoopStop',
    flags: [
      { name: '--stop', type: 'string', required: true, description: 'Lineage id (the root runId) to halt.' },
    ],
    examples: [
      { cmd: 'ace run loop --stop run-7', description: 'Halt the auto-iterate lineage rooted at run-7.' },
      { cmd: 'ace --json run loop --stop run-7', description: 'Halt it and get the structured envelope.' },
    ],
    outputShape: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        lineageId: { type: 'string' },
        stopped: { type: 'boolean' },
      },
    },
  },
  {
    cli: 'run archive',
    description: 'Archive finished runs OFF the run-ledger board: move every event line of the selected runs from events.ndjson to the sibling events-archive.ndjson (append-first, crash-safe swap — nothing is ever lost, just relocated). The board is a pure projection over the live events, so archived runs stop rendering as cards. Select explicitly with repeatable --run ids, or by policy: --terminal picks done/blocked runs older than the thresholds (done>24h, blocked>48h; --older-than overrides both). Without --terminal the policy also sweeps DEAD in_progress lanes idle >72h — archived as-is and reported as deadLanes (no history is ever fabricated). --dry-run reports the selection without moving anything. The same policy auto-runs at spine boot (disable with ACE_RUN_ARCHIVE=0).',
    ipcMethod: 'runArchive',
    flags: [
      { name: '--run', type: 'string-repeated', required: false, description: 'A run id to archive (repeatable). Explicit selection skips the threshold policy.' },
      { name: '--terminal', type: 'boolean', required: false, description: 'Policy selection limited to terminal runs (done/blocked past their age thresholds); dead in_progress lanes are left alone.' },
      { name: '--older-than', type: 'number', required: false, description: 'Age threshold in HOURS overriding the per-bucket defaults (done 24h / blocked 48h / idle in_progress 72h).' },
      { name: '--dry-run', type: 'boolean', required: false, description: 'Report which runs WOULD be archived (with reasons) without touching the ledger.' },
    ],
    examples: [
      { cmd: 'ace --json run archive --terminal --older-than 24', description: 'Move every done/blocked run untouched for 24h+ to the archive file.' },
      { cmd: 'ace run archive --run run-7 --run run-9', description: 'Archive two specific runs off the board.' },
      { cmd: 'ace --json run archive --dry-run', description: 'Preview the full hygiene sweep (done/blocked/dead-lane buckets) without moving events.' },
    ],
    outputShape: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        dryRun: { type: 'boolean' },
        archived: { type: 'integer', description: 'Event lines moved to events-archive.ndjson.' },
        remaining: { type: 'integer', description: 'Event lines left in the live ledger.' },
        runIds: { type: 'array', description: 'Run ids that moved (or would move under --dry-run).' },
        byReason: { type: 'object', description: 'Selection buckets: done / blocked / deadLanes / explicit.' },
      },
    },
  },
  {
    cli: 'run closeout',
    description: 'Close out one run-ledger task by reconciling run-board projection against current PR truth, exact-head validation, same-repo/current-head CI watch, safe same-worker fixback, revalidation, and the read-only integration gate. Defaults to no merge; --dry-run performs no stream prompts or gateway mutations.',
    ipcMethod: 'special:runCloseout',
    flags: [
      { name: '--run', type: 'string', required: true, description: 'Run id from the run-ledger board.' },
      { name: '--dry-run', type: 'boolean', required: false, description: 'Plan closeout from current board/PR truth without asking validator/worker streams or merging.' },
      { name: '--timeout', type: 'number', required: false, description: 'Per streamAsk validation/fixback timeout in milliseconds.' },
      { name: '--merge', type: 'boolean', required: false, description: 'After a passing gate, merge only through the integration gateway when owner token or autoship policy authorizes it.' },
      { name: '--owner-token', type: 'string', required: false, description: 'Per-run owner merge authorization. Must match ACE_OWNER_AUTH_TOKEN when --merge is used.' },
      { name: '--allow-path', type: 'string-repeated', required: false, description: 'Allowed changed path/glob override for closeout gate/fixback scope checks; repeat for multiple paths.' },
    ],
    examples: [
      { cmd: 'ace --json run closeout --run run-7 --dry-run', description: 'Inspect the closeout packet and planned actions without mutating streams or GitHub.' },
      { cmd: 'ace --json run closeout --run run-7', description: 'Validate exact PR head, send safe same-worker fixback if needed, revalidate, and report gate blockers.' },
    ],
    outputShape: {
      type: 'object',
      properties: {
        schema: { type: 'string' },
        runId: { type: 'string' },
        status: { type: 'string', enum: ['ready_to_review', 'fixback_sent', 'blocked', 'merge_ready', 'merged'] },
        packet: { type: 'object' },
        actions: { type: 'array' },
        blockers: { type: 'array' },
        noMutation: { type: 'object' },
      },
    },
  },
  {
    cli: 'run followup',
    description: 'Reusable post-worker follow-up loop for one run/task/PR: reconcile worker DONE/BLOCKED, recover or open PRs through the integration gateway, dispatch missing validators, route safe fixback, inspect checks/gate, and merge-or-park fail-closed.',
    ipcMethod: 'special:runFollowup',
    flags: [
      { name: '--run', type: 'string', required: false, description: 'Run id from the run-ledger board.' },
      { name: '--task', type: 'string', required: false, description: 'Task id to reconcile when run id is absent or ambiguous.' },
      { name: '--pr', type: 'number', required: false, description: 'Known PR number to inspect or adopt.' },
      { name: '--auto', type: 'boolean', required: false, description: 'Allow gateway-mediated PR open, validator dispatch, same-worker fixback, CI watch, and policy-gated merge attempt. Without it, the command reports the safe next action.' },
      { name: '--once', type: 'boolean', required: false, description: 'Run one reconciliation pass (default).' },
      { name: '--watch', type: 'boolean', required: false, description: 'Poll until a terminal merge/park/block state or interruption; emits one JSON packet per pass in --json mode.' },
      { name: '--interval-ms', type: 'number', required: false, description: 'Watch polling interval in milliseconds.' },
      { name: '--timeout', type: 'number', required: false, description: 'Per validator/fixback/check wait timeout in milliseconds.' },
      { name: '--owner-token', type: 'string', required: false, description: 'Per-run owner merge authorization, forwarded only to the integration-gateway closeout path.' },
      { name: '--allow-path', type: 'string-repeated', required: false, description: 'Allowed changed path/glob override for PR open/gate/merge; repeat for multiple paths.' },
    ],
    examples: [
      { cmd: 'ace --json run followup --run run-7 --auto', description: 'Reconcile a completed run through PR, validator, checks, gate, and policy-gated merge-or-park.' },
      { cmd: 'ace --json run followup --task tsk_42 --pr 17', description: 'Inspect one task/PR follow-up without mutating streams or GitHub.' },
      { cmd: 'ace --json run followup --run run-7 --watch --interval-ms 30000', description: 'Poll one lifecycle lane and emit decision packets.' },
    ],
    outputShape: {
      type: 'object',
      properties: {
        schema: { type: 'string' },
        status: { type: 'string' },
        runId: { type: ['string', 'null'] },
        taskId: { type: ['string', 'null'] },
        streamId: { type: ['string', 'null'] },
        validator: { type: 'object' },
        pr: { type: 'object' },
        evidence: { type: 'array' },
        nextAction: { type: 'string' },
        safeNextCommand: { type: ['string', 'null'] },
      },
    },
  },
  {
    cli: 'loop list',
    description: 'List the loop catalog — id, kind, name, builtin, and trigger count. A loop is a saved run-template plus a recursion engine composed over the run-ledger spine.',
    ipcMethod: 'special:loopList',
    flags: [],
    examples: [
      { cmd: 'ace loop list', description: 'Show the loop catalog as a table.' },
      { cmd: 'ace --json loop list', description: 'JSON array of the full loop specs.' },
    ],
    outputShape: {
      type: 'array',
      items: { type: 'object' },
    },
  },
  {
    cli: 'loop show',
    description: "Show one loop's full spec: routing, contract (stop / ceilings / verify / permissions / owner-gated merge), triggers, and evidence.",
    ipcMethod: 'special:loopShow', notFound: true,
    positionals: [
      { name: 'id', required: true, description: 'Loop id from `ace loop list`.' },
    ],
    examples: [
      { cmd: 'ace loop show loop-validate-park', description: 'Pretty-print the loop spec.' },
      { cmd: 'ace --json loop show loop-ci-harden', description: 'The full LoopSpec as JSON.' },
    ],
    outputShape: {
      type: 'object',
    },
  },
  {
    cli: 'loop forge',
    description: 'Compile a free-text description into a proposed LoopSpec draft (deterministic NL→spec) and print its fail-closed validation result. With --save, lock-on the validated draft and persist it to the catalog.',
    ipcMethod: 'special:loopForge',
    flags: [
      { name: '--save', type: 'boolean', required: false, description: 'Lock-on the compiled draft (fail-closed validation) and persist it. Without it, only the draft + validation are printed.' },
    ],
    positionals: [
      { name: 'description', required: true, description: 'Free-text description of the loop to forge.' },
    ],
    examples: [
      { cmd: 'ace loop forge "produce a daily intel digest of findings"', description: 'Compile a draft and show validation results without saving.' },
      { cmd: 'ace loop forge "harden CI until the checks pass green" --save', description: 'Compile, lock-on, and persist the loop.' },
    ],
    outputShape: {
      type: 'object',
      properties: {
        draft: { type: 'object' },
        notes: { type: 'array' },
        saved: { type: ['object', 'null'] },
        errors: { type: 'array' },
      },
    },
  },
  {
    cli: 'loop run',
    description: 'Run a loop through the run-ledger spine and block until it settles. Each iteration is a canonical run (worker → validator → park); merge stays owner-gated (a converged code loop parks at ready_to_review). Exit 0 ONLY when the loop CONVERGED; 2 when it stopped without converging (no-progress / cap-hit); 3 when BLOCKED.',
    ipcMethod: 'special:loopRun', notFound: true,
    flags: [
      { name: '--input', type: 'string-repeated', required: false, description: 'A key=value input for the loop goal template (repeatable).' },
      { name: '--watch', type: 'boolean', required: false, description: 'Print each iteration transition (index, run id, classification) as the loop settles.' },
      { name: '--timeout', type: 'number', required: false, description: 'Client wait deadline in milliseconds (loops can run many worker iterations; default is generous).' },
    ],
    positionals: [
      { name: 'id', required: true, description: 'Loop id to run (from `ace loop list`).' },
    ],
    examples: [
      { cmd: 'ace loop run loop-validate-park --input feature=settings-panel', description: 'Run the validate-park loop with a template input; it parks at ready_to_review.' },
      { cmd: 'ace --json loop run loop-ci-harden --watch', description: 'Run the CI-harden loop, streaming per-iteration transitions.' },
    ],
    outputShape: {
      type: 'object',
      properties: {
        invocationId: { type: 'string' },
        loopId: { type: 'string' },
        finished: { type: 'boolean' },
        finishReason: { type: 'string' },
        reasonDetail: { type: 'string' },
        iterations: { type: 'array' },
      },
    },
  },
  {
    cli: 'loop status',
    description: 'Show loop status: active invocations, in-flight iteration count, and the folded lineage of a loop\'s runs from the ledger. With an id, show just that loop; omit it for every loop with runs.',
    ipcMethod: 'special:loopStatus', notFound: true,
    positionals: [
      { name: 'id', required: false, description: 'Loop id, or omit for all loops.' },
    ],
    examples: [
      { cmd: 'ace loop status', description: 'Aggregate gauges + per-loop lineage for every loop with runs.' },
      { cmd: 'ace --json loop status loop-validate-park', description: 'Folded lineage for one loop as JSON.' },
    ],
    outputShape: {
      type: 'object',
      properties: {
        active: { type: 'array' },
        inFlight: { type: 'number' },
        lineage: { type: 'object' },
        lineages: { type: 'object' },
      },
    },
  },
  {
    cli: 'loop stop',
    description: 'Halt an active loop invocation before its next iteration dispatch. Accepts a host invocation id (loopinv-…) or a loop id (stops every active invocation of that loop).',
    ipcMethod: 'special:loopStop', notFound: true,
    positionals: [
      { name: 'invocationId', required: true, description: 'Invocation id (loopinv-…) or loop id to stop.' },
    ],
    examples: [
      { cmd: 'ace loop stop loopinv-loop-ci-harden-1', description: 'Stop a specific invocation.' },
      { cmd: 'ace loop stop loop-ci-harden', description: 'Stop every active invocation of the loop.' },
    ],
    outputShape: {
      type: 'object',
      properties: {
        stopped: { type: 'boolean' },
      },
    },
  },
  {
    cli: 'smoke fast-lifecycle',
    description: 'Run a side-effect-free fast lifecycle smoke: control-plane readable, mission-next policy callable, no-code risk bypass, release-gate diagnostic, and Clawpatch skip.',
    ipcMethod: 'special:smokeFastLifecycle', conflict: true,
    flags: [
      { name: '--workspace', type: 'string', required: true, description: 'Workspace id to smoke.' },
      { name: '--no-code', type: 'boolean', required: true, description: 'Required safety flag: do not push, PR, merge, cleanup, or spawn validators.' },
    ],
    examples: [
      { cmd: 'ace --json smoke fast-lifecycle --workspace prj_42 --no-code', description: 'Run the quick no-code control-plane smoke.' },
    ],
    outputShape: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        workspaceId: { type: 'string' },
        smokeKind: { type: 'string' },
        noCode: { type: 'boolean' },
        validationRequired: { type: 'boolean' },
        clawpatch: { type: 'object' },
        sideEffects: { type: 'object' },
        steps: { type: 'array' },
      },
    },
  },
  {
    cli: 'integrate context-import',
    description: 'Fail-closed preview/apply registration of an existing verified local worktree as an Ace integration context.',
    ipcMethod: 'integrationContextImport', notFound: true,
    flags: [
      { name: '--workspace', type: 'string', required: true, description: 'Exact existing local workspace id.' },
      { name: '--repo', type: 'string', required: true, description: 'Canonical existing repository path.' },
      { name: '--worktree', type: 'string', required: true, description: 'Canonical existing linked-worktree path.' },
      { name: '--branch', type: 'string', required: true, description: 'Exact checked-out branch.' },
      { name: '--head-sha', type: 'string', required: true, description: 'Exact full HEAD commit SHA.' },
      { name: '--base-branch', type: 'string', required: true, description: 'Exact origin base branch name.' },
      { name: '--base-sha', type: 'string', required: true, description: 'Exact full origin base commit SHA.' },
      { name: '--allow-path', type: 'string-repeated', required: true, description: 'Literal changed repository-relative path; repeat for each path.' },
      { name: '--request-id', type: 'string', required: true, description: 'Caller-generated idempotency key.' },
      { name: '--preview', type: 'boolean', required: false, description: 'Verify and return a digest without writes.' },
      { name: '--apply', type: 'boolean', required: false, description: 'Rerun verification and atomically register.' },
      { name: '--digest', type: 'string', required: false, description: 'Exact preview digest required by apply.' },
    ],
    examples: [
      {
        cmd: 'ace --json integrate context-import --workspace prj_42 --repo /repo --worktree /repo-wt --branch feat/x --head-sha 1111111111111111111111111111111111111111 --base-branch main --base-sha 2222222222222222222222222222222222222222 --allow-path src/x.ts --request-id req-42 --preview',
        description: 'Preview a fully explicit import without writing.',
      },
    ],
    outputShape: {
      type: 'object',
      description: 'Preview evidence/digest or applied task/worktree/audit ids.',
    },
  },
  {
    cli: 'integrate push',
    description: 'Push a task\'s branch to its remote via the integration gateway (git push with retries).',
    ipcMethod: 'integrationPush', notFound: true,
    flags: [
      { name: '--task', type: 'string', required: true, description: 'Task id whose branch should be pushed.' },
      { name: '--branch', type: 'string', required: false, description: 'Branch override (defaults to the task\'s branch).' },
      { name: '--remote', type: 'string', required: false, default: 'origin', description: 'Remote name (default origin).' },
      { name: '--force', type: 'boolean', required: false, description: 'Use --force-with-lease on the push.' },
    ],
    examples: [
      { cmd: 'ace integrate push --task tsk_42', description: 'Push the task\'s branch to origin.' },
      { cmd: 'ace --json integrate push --task tsk_42', description: 'Get the structured envelope on stdout.' },
    ],
    outputShape: {
      type: 'object',
      description: 'Integration envelope: { ok, phase, action, params, result, durationMs, timestamp }.',
    },
  },
  {
    cli: 'integrate pr-open',
    description: 'Open a pull request for a task branch after remote-base and allowed-path preflight.',
    ipcMethod: 'integrationOpenPr', notFound: true,
    flags: [
      { name: '--task', type: 'string', required: true, description: 'Task id.' },
      { name: '--title', type: 'string', required: true, description: 'PR title.' },
      { name: '--body', type: 'string', required: false, description: 'PR body (default empty).' },
      { name: '--base', type: 'string', required: false, description: 'Base branch (defaults to task\'s base branch).' },
      { name: '--head', type: 'string', required: false, description: 'Head branch (defaults to task\'s branch).' },
      { name: '--allow-path', type: 'string-repeated', required: false, description: 'Allowed changed path/glob; repeat for multiple paths.' },
      { name: '--ready', type: 'boolean', required: false, description: 'Deprecated no-op: PRs open ready-for-review by default.' },
      { name: '--draft', type: 'boolean', required: false, description: 'Open as a DRAFT (the merge gate refuses drafts; only for explicitly parked work).' },
    ],
    examples: [
      { cmd: 'ace integrate pr-open --task tsk_42 --title "add hello route"', description: 'Open a ready-for-review PR.' },
    ],
    outputShape: {
      type: 'object',
      description: 'Integration envelope.',
    },
  },
  {
    cli: 'integrate gate',
    description: 'Read-only PR integration gate for a task/PR. Reports exact head/base refs, checks, mergeability, validation, fixback, cleanup inputs, and PASS/BLOCKED reasons without merging or cleanup.',
    ipcMethod: 'integrationGate', notFound: true,
    flags: [
      { name: '--task', type: 'string', required: true, description: 'Task id (for gateway context).' },
      { name: '--pr', type: 'number', required: true, description: 'PR number to inspect.' },
      { name: '--branch', type: 'string', required: false, description: 'Branch override (defaults to the task branch).' },
      { name: '--remote', type: 'string', required: false, default: 'origin', description: 'Remote name for read-only local SHA evidence.' },
      { name: '--allow-path', type: 'string-repeated', required: false, description: 'Allowed changed path/glob override; repeat for multiple paths.' },
    ],
    examples: [
      { cmd: 'ace --json integrate gate --task tsk_42 --pr 17', description: 'Report whether PR 17 may be merged without performing the merge.' },
    ],
    outputShape: {
      type: 'object',
      description: 'Integration envelope whose result.status is PASS or BLOCKED and whose result.gate contains exact read-only evidence.',
    },
  },
  {
    cli: 'integrate pr-merge',
    description: 'Merge a tracked PR, or adopt an untracked PR only when its head/base match the task branch/base.',
    ipcMethod: 'integrationMergePr', notFound: true,
    flags: [
      { name: '--task', type: 'string', required: true, description: 'Task id (for gateway context).' },
      { name: '--pr', type: 'number', required: true, description: 'PR number to merge.' },
      { name: '--method', type: 'string', required: false, default: 'squash', choices: ['squash', 'merge', 'rebase'], description: 'Merge strategy.' },
      { name: '--keep-branch', type: 'boolean', required: false, description: 'Skip --delete-branch on the merge.' },
      { name: '--auto', type: 'boolean', required: false, description: 'Let Ace wait for checks, re-read conflicts, merge when GitHub reports MERGEABLE, verify MERGED/base evidence, and clean up. If branch policy blocks a normal merge, Ace falls back to direct admin merge after the gate passes.' },
      { name: '--admin', type: 'boolean', required: false, description: 'Use GitHub admin merge through the Ace integration gateway. Requires --admin-reason and a passing gate.' },
      { name: '--admin-reason', type: 'string', required: false, description: 'Required justification for --admin.' },
      { name: '--allow-path', type: 'string-repeated', required: false, description: 'Allowed changed path/glob override for merge gating; repeat for multiple paths.' },
    ],
    examples: [
      { cmd: 'ace integrate pr-merge --task tsk_42 --pr 17', description: 'Squash-merge PR 17 and delete its branch.' },
      { cmd: 'ace integrate pr-merge --task tsk_42 --pr 17 --keep-branch', description: 'Adopt a task-matched PR and preserve its remote branch.' },
      { cmd: 'ace integrate pr-merge --task tsk_42 --pr 17 --auto', description: 'Wait for checks and merge through Ace when the PR is mergeable.' },
      { cmd: 'ace integrate pr-merge --task tsk_42 --pr 17 --admin --admin-reason "validated exact head; owner approved"', description: 'Admin-merge only after gate evidence and explicit reason.' },
    ],
    outputShape: {
      type: 'object',
      description: 'Integration envelope. Auto mode may return phase=pending with mergeVerification evidence instead of cleanup.',
    },
  },
  {
    cli: 'integrate cleanup',
    description: 'Delete the task\'s local (and by default remote) branch idempotently — safe to re-run.',
    ipcMethod: 'integrationCleanup', notFound: true,
    flags: [
      { name: '--task', type: 'string', required: true, description: 'Task id.' },
      { name: '--branch', type: 'string', required: false, description: 'Branch override.' },
      { name: '--remote', type: 'string', required: false, default: 'origin', description: 'Remote name.' },
      { name: '--local-only', type: 'boolean', required: false, description: 'Skip deleting the remote branch.' },
      { name: '--dry-run', type: 'boolean', required: false, description: 'Report safety checks and planned cleanup without deleting a worktree or branch.' },
      { name: '--pr-state', type: 'string', required: false, description: 'Known PR state evidence. OPEN blocks cleanup; MERGED/CLOSED is recorded in the safety report.' },
      { name: '--merged-sha', type: 'string', required: false, description: 'Verified merge commit/base SHA contained in the target base. Required for squash-merge cleanup safety.' },
    ],
    examples: [
      { cmd: 'ace integrate cleanup --task tsk_42 --dry-run', description: 'Audit cleanup safety without deleting anything.' },
      { cmd: 'ace integrate cleanup --task tsk_42 --local-only', description: 'Delete only the local branch.' },
    ],
    outputShape: {
      type: 'object',
      description: 'Integration envelope.',
    },
  },
  {
    cli: 'supervise',
    description: 'List the child-registry rows for a workspace: taskId / branch / prState / prChecks / prUrl. Reads from the orchestrator\'s persistent store; no transport required. Pass --live to keep polling each child\'s gh pr/CI/branch state and emit one JSON line per tick.',
    ipcMethod: 'special:supervise',
    flags: [
      { name: '--workspace', type: 'string', required: true, description: 'Workspace id to filter rows by (matches the taskId prefix the orchestrator registered).' },
      { name: '--live', type: 'boolean', required: false, description: 'Stream per-tick supervisor snapshots as JSON Lines on stdout. Polls gh + git for every registered child and writes intel back to the registry until interrupted.' },
      { name: '--interval-ms', type: 'number', required: false, description: 'Poll interval in milliseconds for --live mode (default 30000).' },
      { name: '--max-ticks', type: 'number', required: false, description: 'Stop --live after N ticks (default: run until interrupted). Useful for tests and one-shot diagnostics.' },
    ],
    examples: [
      { cmd: 'ace supervise --workspace prj_42', description: 'Human-readable table of child rows.' },
      { cmd: 'ace --json supervise --workspace prj_42', description: 'JSON envelope with the rows array.' },
    ],
    outputShape: {
      type: 'object',
      properties: {
        workspace: { type: 'string' },
        rows: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              taskId: { type: 'string' },
              branch: { type: 'string' },
              prNumber: { type: 'integer' },
              prUrl: { type: 'string' },
              prState: { type: 'string' },
              prChecks: { type: 'string' },
              lastTrailer: { type: 'string' },
              waveId: { type: 'string' },
              laneId: { type: 'string' },
              laneStatus: { type: 'string' },
              updatedAt: { type: 'integer' },
            },
          },
        },
        waves: {
          type: 'array',
          description: 'Per-wave join verdict for rows that carry a waveId. ready=true means every lane has reached a terminal status and the wave validator may launch.',
          items: {
            type: 'object',
            properties: {
              waveId: { type: 'string' },
              ready: { type: 'boolean' },
              laneCount: { type: 'integer' },
              terminalCount: { type: 'integer' },
              nonterminalCount: { type: 'integer' },
              nonterminalLanes: { type: 'array', items: { type: 'string' } },
              missingLanes: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      },
    },
  },
  {
    cli: 'project init-harness',
    description: 'Initialize a project-local .ace harness from the bundled .ace-template.',
    ipcMethod: 'special:projectInitHarness',
    flags: [
      { name: '--project', type: 'string', required: true, description: 'Project name to write into PROJECT_BRIEF.md.' },
      { name: '--project-dir', type: 'string', required: false, description: 'Target project directory. Defaults to the current working directory.' },
      { name: '--force', type: 'boolean', required: false, description: 'Overwrite existing scaffold files.' },
    ],
    examples: [
      { cmd: 'ace project init-harness --project kova', description: 'Create .ace/ in the current project.' },
    ],
    outputShape: {
      type: 'object',
      properties: {
        projectDir: { type: 'string' },
        targetDir: { type: 'string' },
        copied: { type: 'array' },
        skipped: { type: 'array' },
      },
    },
  },
  {
    cli: 'task result',
    description: 'Read and validate .ace/run/<runId>/completion.json for a project harness run.',
    ipcMethod: 'special:taskResult',
    flags: [
      { name: '--run', type: 'string', required: true, description: 'Run id under .ace/run/.' },
      { name: '--project-dir', type: 'string', required: false, description: 'Project directory. Defaults to the current working directory.' },
    ],
    examples: [
      { cmd: 'ace task result --run run_123', description: 'Read .ace/run/run_123/completion.json.' },
    ],
    outputShape: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        valid: { type: 'boolean' },
        errors: { type: 'array' },
        result: { type: 'object' },
      },
    },
  },
  {
    cli: 'task validate',
    description: 'Run the project-harness validator loop: validate completion.json, mark the feature, and fire pass/fail triggers.',
    ipcMethod: 'special:taskValidate',
    flags: [
      { name: '--run', type: 'string', required: true, description: 'Run id under .ace/run/.' },
      { name: '--feature', type: 'string', required: true, description: 'Feature id in .ace/FEATURES.json.' },
      { name: '--project-dir', type: 'string', required: false, description: 'Project directory. Defaults to the current working directory.' },
    ],
    examples: [
      { cmd: 'ace task validate --run run_123 --feature project.harness.initialized', description: 'Validate a worker result and route feature.passed/feature.failed triggers.' },
    ],
    outputShape: {
      type: 'object',
      properties: {
        runId: { type: 'string' },
        featureId: { type: 'string' },
        verdict: { type: 'string' },
        valid: { type: 'boolean' },
        errors: { type: 'array' },
        validationPath: { type: 'string' },
        actions: { type: 'array' },
      },
    },
  },
  {
    cli: 'feature list',
    description: 'Read .ace/FEATURES.json from a project harness.',
    ipcMethod: 'special:featureList',
    flags: [
      { name: '--project-dir', type: 'string', required: false, description: 'Project directory. Defaults to the current working directory.' },
    ],
    examples: [
      { cmd: 'ace feature list', description: 'List project feature checks from .ace/FEATURES.json.' },
    ],
    outputShape: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        features: { type: 'array' },
      },
    },
  },
  {
    cli: 'wave list',
    description: 'Read .ace/WAVE_PLAN.yaml from a project harness.',
    ipcMethod: 'special:waveList',
    flags: [
      { name: '--project-dir', type: 'string', required: false, description: 'Project directory. Defaults to the current working directory.' },
    ],
    examples: [
      { cmd: 'ace wave list', description: 'Print the project wave plan from .ace/WAVE_PLAN.yaml.' },
    ],
    outputShape: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        text: { type: 'string' },
      },
    },
  },
  {
    cli: 'run list',
    description: 'List .ace/run directories and completion result validity.',
    ipcMethod: 'special:runList',
    flags: [
      { name: '--project-dir', type: 'string', required: false, description: 'Project directory. Defaults to the current working directory.' },
    ],
    examples: [
      { cmd: 'ace run list', description: 'List run ids under .ace/run/.' },
    ],
    outputShape: {
      type: 'object',
      properties: {
        runs: { type: 'array' },
      },
    },
  },
  {
    cli: 'feature mark',
    description: 'Mark a feature check pass/fail with evidence. Passing requires --role evaluator.',
    ipcMethod: 'special:featureMark',
    flags: [
      { name: '--id', type: 'string', required: true, description: 'Feature id in .ace/FEATURES.json.' },
      { name: '--pass', type: 'boolean', required: false, description: 'Mark the feature passing. Requires --role evaluator.' },
      { name: '--fail', type: 'boolean', required: false, description: 'Mark the feature failing.' },
      { name: '--evidence', type: 'string', required: true, description: 'Evidence text or run id.' },
      { name: '--run', type: 'string', required: false, description: 'Run id that produced the evidence.' },
      { name: '--role', type: 'string', required: false, description: 'Caller role. Use evaluator to mark passing.' },
      { name: '--project-dir', type: 'string', required: false, description: 'Project directory. Defaults to the current working directory.' },
    ],
    examples: [
      { cmd: 'ace feature mark --id project.harness.initialized --pass --role evaluator --evidence run_123', description: 'Mark a feature passing with evaluator evidence.' },
    ],
    outputShape: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        feature: { type: 'object' },
      },
    },
  },
  {
    cli: 'memory candidates',
    description: 'List memory candidates found in project completion results.',
    ipcMethod: 'special:memoryCandidates',
    flags: [
      { name: '--project-dir', type: 'string', required: false, description: 'Project directory. Defaults to the current working directory.' },
    ],
    examples: [
      { cmd: 'ace memory candidates', description: 'List memoryCandidates[] from .ace/run/*/completion.json.' },
    ],
    outputShape: {
      type: 'object',
      properties: {
        candidates: { type: 'array' },
      },
    },
  },
  {
    cli: 'memory search',
    description: 'Search the unified knowledge base (ops wiki + project wikis + dump intake). Ranked by BM25 × trust tier (canon>working>external>raw) × freshness × decay. Decayed/contaminated content is excluded by default — never cite raw or decayed results as authoritative.',
    ipcMethod: 'knowledgeSearch',
    flags: [
      { name: '--project', type: 'string', required: false, description: 'Filter to one project/workspace id.' },
      { name: '--tier', type: 'string', required: false, choices: ['canon', 'working', 'raw', 'external'], description: 'Filter to one trust tier.' },
      { name: '--kind', type: 'string', required: false, description: 'Filter by page kind (lesson, decision, journal, run-digest, ...).' },
      { name: '--tag', type: 'string-repeated', required: false, description: 'Require a tag (repeatable; all must match).' },
      { name: '--limit', type: 'number', required: false, description: 'Max results (default 10, cap 50).' },
      { name: '--include-decayed', type: 'boolean', required: false, description: 'Include decayed/contaminated results (they carry decayReasons).' },
    ],
    positionals: [
      { name: 'query', required: true, description: 'Free-text query (max 500 chars).' },
    ],
    examples: [
      { cmd: 'ace memory search "release gate" --project prj_42 --limit 5', description: 'Top project knowledge about the release gate.' },
      { cmd: 'ace memory search "worktree base" --tier canon --tag lesson', description: 'Canon lessons tagged lesson.' },
    ],
    outputShape: {
      type: 'object',
      properties: {
        schema: { type: 'string' },
        query: { type: 'string' },
        total: { type: 'number' },
        results: { type: 'array' },
      },
    },
  },
  {
    cli: 'memory get',
    description: 'Read one knowledge-base entry by absolute path (from a memory search result). The path must resolve inside a registered knowledge root; body is capped at 16KB.',
    ipcMethod: 'knowledgeGet',
    positionals: [
      { name: 'path', required: true, description: 'Absolute path returned by `ace memory search`.' },
    ],
    examples: [
      { cmd: 'ace memory get /path/to/wiki/lessons/release-gate.md', description: 'Fetch the full page behind a search hit.' },
    ],
    outputShape: {
      type: 'object',
      properties: {
        schema: { type: 'string' },
        path: { type: 'string' },
        body: { type: 'string' },
        truncated: { type: 'boolean' },
      },
    },
  },
  {
    cli: 'memory remember',
    description: 'Record a durable claim (lesson, decision, fact, todo) as an UNTRUSTED dump record under .ace/wiki-dump/. Never writes canon — the nightly curator validates and promotes. Inherits secret scanning, redaction and quarantine.',
    ipcMethod: 'special:memoryRemember',
    flags: [
      { name: '--category', type: 'string', required: true, choices: ['lesson', 'decision', 'fact', 'todo'], description: 'What kind of claim this is.' },
      { name: '--project-id', type: 'string', required: false, description: 'Project/workspace id (defaults to ACE_PROJECT_ID).' },
      { name: '--tag', type: 'string-repeated', required: false, description: 'Tag from the controlled vocabulary or x/<free-tag>.' },
      { name: '--source', type: 'string', required: false, description: 'Short source label (run id, PR, session).' },
      { name: '--identity', type: 'string', required: false, description: 'Writer identity (defaults to ACE_AGENT_IDENTITY or agent).' },
      { name: '--project-dir', type: 'string', required: false, description: 'Project directory. Defaults to the current working directory.' },
    ],
    positionals: [
      { name: 'claim', required: true, description: 'The claim to remember (one clear sentence or short paragraph).' },
    ],
    examples: [
      { cmd: 'ace memory remember "Vitest must be scoped with --dir in this repo" --category lesson --project-id prj_42 --tag lesson', description: 'Dump a lesson for nightly curation.' },
    ],
    outputShape: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        record: { type: 'object' },
        quarantined: { type: 'boolean' },
        redacted: { type: 'boolean' },
      },
    },
  },
  {
    cli: 'memory reindex',
    description: 'Incrementally reindex the unified knowledge base (ops wiki + project wikis + dumps) in the running Ace app.',
    ipcMethod: 'knowledgeReindex',
    examples: [
      { cmd: 'ace memory reindex', description: 'Refresh the knowledge index after manual wiki edits.' },
    ],
    outputShape: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        scanned: { type: 'number' },
        indexed: { type: 'number' },
        removed: { type: 'number' },
      },
    },
  },
  {
    cli: 'memory eval',
    description: 'Deterministic knowledge-plane self-check (minutes): fixture corpus graded as retrieval R@5 + decay assertions across lookup, cross-project, temporal, knowledge-update, and abstention categories. Report lands in <wiki>/logs/eval/.',
    ipcMethod: 'knowledgeEval',
    examples: [
      { cmd: 'ace memory eval', description: 'Verify search ranking, decay filtering and abstention behave correctly.' },
    ],
    outputShape: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        categories: { type: 'array' },
        reportPath: { type: 'string' },
      },
    },
  },
  {
    cli: 'knowledge migrate',
    description: 'One-shot vault migration, propose-by-default: stamp inferred AceOpsPage/v1 frontmatter on legacy ops-wiki pages, backfill promoteToWiki memory candidates as dump records, run the initial rotation, and append the taxonomy to SCHEMA.md. Nothing changes without --apply; legacy pages stay valid forever.',
    ipcMethod: 'special:knowledgeMigrate',
    flags: [
      { name: '--apply', type: 'boolean', required: false, description: 'Execute the migration. Without it, a dry-run report is returned.' },
      { name: '--wiki-root', type: 'string', required: false, description: 'Ops wiki root (defaults to ACE_WIKI_ROOT or ~/wiki/ace-ops).' },
      { name: '--project-id', type: 'string', required: false, description: 'Project id stamped onto backfilled candidate dumps.' },
      { name: '--skip-rotation', type: 'boolean', required: false, description: 'Skip the initial log.md rotation.' },
      { name: '--project-dir', type: 'string', required: false, description: 'Project directory whose completion.json candidates get backfilled.' },
    ],
    examples: [
      { cmd: 'ace knowledge migrate', description: 'Dry-run: list pages missing frontmatter and candidates to backfill.' },
      { cmd: 'ace knowledge migrate --apply', description: 'Stamp frontmatter, backfill candidates, rotate, update SCHEMA.md.' },
    ],
    outputShape: {
      type: 'object',
      properties: {
        applied: { type: 'boolean' },
        pagesNeedingFrontmatter: { type: 'number' },
        stamped: { type: 'number' },
        candidatesBackfilled: { type: 'number' },
      },
    },
  },
  {
    cli: 'memory explain',
    description: 'Canon-first answer to a question, read directly from the Markdown canon (the source of truth) plus dump evidence. Cites the source event/dump ids. When no canon page matches, the answer is an EXPLICITLY labeled raw fallback — treat it as unverified.',
    ipcMethod: 'special:memoryExplain',
    flags: [
      { name: '--project-dir', type: 'string', required: false, description: 'Project directory. Defaults to the current working directory.' },
    ],
    positionals: [
      { name: 'query', required: true, description: 'The question to answer from canon.' },
    ],
    examples: [
      { cmd: 'ace memory explain "what is the release gate policy"', description: 'Canon answer with citations; labeled raw fallback if no canon hit.' },
    ],
    outputShape: {
      type: 'object',
      properties: {
        schema: { type: 'string' }, found: { type: 'boolean' }, rawFallback: { type: 'boolean' },
        label: { type: 'string' }, answer: { type: 'string' }, citations: { type: 'array' },
      },
    },
  },
  {
    cli: 'memory status',
    description: 'Knowledge/retrieval status for a project: canon vs raw counts, dump-only flag, last nightly, source coverage, inbox backlog, and index freshness. Reinforces that Markdown canon is truth and the FTS index is a disposable helper.',
    ipcMethod: 'special:memoryStatus',
    flags: [
      { name: '--projects-root', type: 'string', required: false, description: 'Scan every immediate subdirectory that has a .ace/ as a project.' },
      { name: '--project-dir', type: 'string', required: false, description: 'Single project directory. Defaults to the current working directory.' },
    ],
    examples: [
      { cmd: 'ace memory status', description: 'Show canon/raw/dump-only/source-coverage for this project.' },
    ],
    outputShape: {
      type: 'object',
      properties: {
        schema: { type: 'string' }, severity: { type: 'string' },
        canonPages: { type: 'number' }, dumpRecords: { type: 'number' }, dumpOnlyProjects: { type: 'array' },
      },
    },
  },
  {
    cli: 'wiki update',
    description: 'Write or append a project wiki page under .ace/wiki/. Canon writes are role-gated (hermes/orchestrator/curator/chief); workers use `wiki dump` or `memory remember`, or write to wiki/diagnostic/.',
    ipcMethod: 'special:wikiUpdate',
    flags: [
      { name: '--page', type: 'string', required: true, description: 'Wiki page path under .ace/wiki/.' },
      { name: '--text', type: 'string', required: true, description: 'Markdown text to write or append.' },
      { name: '--append', type: 'boolean', required: false, description: 'Append instead of replacing the page.' },
      { name: '--role', type: 'string', required: false, description: 'Caller role (defaults to ACE_AGENT_ROLE). Worker/validator roles are denied canon writes.' },
      { name: '--project-dir', type: 'string', required: false, description: 'Project directory. Defaults to the current working directory.' },
    ],
    examples: [
      { cmd: 'ace wiki update --page lessons.md --append --text \"- Workers read FEATURES.json first.\"', description: 'Append a Memory Librarian note to the project wiki.' },
    ],
    outputShape: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        appended: { type: 'boolean' },
      },
    },
  },
  {
    cli: 'wiki dump',
    description: 'Write one untrusted project wiki dump record under .ace/wiki-dump/. Does not modify canonical wiki pages.',
    ipcMethod: 'special:wikiDump',
    flags: [
      { name: '--kind', type: 'string', required: true, description: 'Dump kind, for example rook_session, king_session, ace_mission, validator, pr_gate, operator_note, or external_link.' },
      { name: '--identity', type: 'string', required: true, description: 'Source identity: rook, king, ace, chief, or external.' },
      { name: '--project-id', type: 'string', required: true, description: 'Project/workspace id this dump belongs to.' },
      { name: '--project-name', type: 'string', required: false, description: 'Human-readable project name.' },
      { name: '--mission', type: 'string', required: false, description: 'Mission id.' },
      { name: '--feature', type: 'string', required: false, description: 'Feature/card id.' },
      { name: '--pr', type: 'number', required: false, description: 'Pull request number.' },
      { name: '--session', type: 'string', required: false, description: 'Source session id.' },
      { name: '--source', type: 'string', required: false, description: 'Short source label.' },
      { name: '--source-url', type: 'string', required: false, description: 'Source URL for external links or PRs.' },
      { name: '--fetch-status', type: 'string', required: false, choices: ['ok', 'failed'], description: 'Capture result for external source URLs.' },
      { name: '--trust', type: 'string', required: false, description: 'Trust label such as untrusted, self_report, verified, or external_unverified.' },
      { name: '--title', type: 'string', required: false, description: 'Dump title.' },
      { name: '--summary', type: 'string', required: false, description: 'Short source-backed summary.' },
      { name: '--next-action', type: 'string-repeated', required: false, description: 'Proposed next action.' },
      { name: '--completed', type: 'string-repeated', required: false, description: 'Completed project item.' },
      { name: '--decision', type: 'string-repeated', required: false, description: 'Source-backed decision.' },
      { name: '--blocker', type: 'string-repeated', required: false, description: 'Open blocker.' },
      { name: '--evidence', type: 'string-repeated', required: false, description: 'Evidence reference, not raw transcript text.' },
      { name: '--raw-path', type: 'string', required: false, description: 'Optional path to redacted raw source material.' },
      { name: '--project-dir', type: 'string', required: false, description: 'Project directory. Defaults to the current working directory.' },
    ],
    examples: [
      { cmd: 'ace wiki dump --kind ace_mission --identity ace --project-id prj_42 --summary "Mission smoke passed" --completed "Smoke passed"', description: 'Store an untrusted mission dump without changing canon.' },
    ],
    outputShape: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        record: { type: 'object' },
        quarantined: { type: 'boolean' },
        redacted: { type: 'boolean' },
      },
    },
  },
  {
    cli: 'wiki candidates',
    description: 'Extract and validate project wiki update candidates from dump records without promoting them to canon.',
    ipcMethod: 'special:wikiCandidates',
    flags: [
      { name: '--identity', type: 'string', required: false, description: 'Filter dumps by source identity.' },
      { name: '--project-dir', type: 'string', required: false, description: 'Project directory. Defaults to the current working directory.' },
    ],
    examples: [
      { cmd: 'ace wiki candidates --identity rook', description: "Preview candidate updates from one operator identity's dumps." },
    ],
    outputShape: {
      type: 'object',
      properties: {
        dumps: { type: 'number' },
        candidates: { type: 'array' },
        accepted: { type: 'array' },
        rejected: { type: 'array' },
      },
    },
  },
  {
    cli: 'wiki generate',
    description: 'Source-grounded repo-wiki generator (AutoWiki): survey live source (package.json, README, AGENTS.md, FEATURES.json, the live CLI registry, bundled skills), plan dependency-ordered pages, and emit source-grounded facts THROUGH the tiered promotion gate into canon. Per-page source-input hashes drive --incremental; retired surfaces are filtered out so docs never reference a command that no longer exists. Never writes canon directly.',
    ipcMethod: 'special:wikiGenerate',
    flags: [
      { name: '--incremental', type: 'boolean', required: false, description: 'Regenerate only pages whose source inputs changed since the last run (per-page hashes in .ace/wiki-generate.manifest.json).' },
      { name: '--dry-run', type: 'boolean', required: false, description: 'Survey and plan only: report what would regenerate without emitting events or writing canon.' },
      { name: '--project-id', type: 'string', required: false, description: 'Project id for emitted events. Defaults to package.json name or the directory name.' },
      { name: '--project-name', type: 'string', required: false, description: 'Project display name. Defaults to package.json name or the project id.' },
      { name: '--project-dir', type: 'string', required: false, description: 'Project directory. Defaults to the current working directory.' },
    ],
    examples: [
      { cmd: 'ace wiki generate --project-dir /path/to/repo', description: 'Generate a source-grounded wiki for any repo through the tiered gate.' },
      { cmd: 'ace wiki generate --incremental', description: 'Refresh only the pages whose source changed (CI-friendly).' },
      { cmd: 'ace wiki generate --dry-run', description: 'Preview the plan and the changed-set without writing anything.' },
    ],
    outputShape: {
      type: 'object',
      properties: {
        schema: { type: 'string' },
        projectId: { type: 'string' },
        projectName: { type: 'string' },
        incremental: { type: 'boolean' },
        surveyed: { type: 'number' },
        regenerated: { type: 'number' },
        skipped: { type: 'number' },
        eventsAppended: { type: 'number' },
        curation: { type: ['object', 'null'] },
        pages: { type: 'array' },
        manifestPath: { type: 'string' },
      },
    },
  },
  {
    cli: 'wiki nightly',
    description: 'Run the project wiki curator: read dumps, validate candidates, update canonical pages, rebuild packs, audit, and write a nightly report.',
    ipcMethod: 'special:wikiNightly',
    flags: [
      { name: '--identity', type: 'string', required: false, default: 'all', description: 'Identity filter. Use all to read every dump identity.' },
      { name: '--project-dir', type: 'string', required: false, description: 'Project directory. Defaults to the current working directory.' },
    ],
    examples: [
      { cmd: 'ace wiki nightly --identity all --project-dir /path/to/Ace', description: 'Promote safe source-backed project updates into canon.' },
    ],
    outputShape: {
      type: 'object',
      properties: {
        reportPath: { type: 'string' },
        dumpsRead: { type: 'number' },
        candidatesExtracted: { type: 'number' },
        candidatesAccepted: { type: 'number' },
        audit: { type: 'object' },
      },
    },
  },
  {
    cli: 'wiki pack',
    description: 'Build a role-specific project wiki pack from canonical pages only.',
    ipcMethod: 'special:wikiPack',
    flags: [
      { name: '--role', type: 'string', required: true, choices: ['orchestrator', 'worker', 'validator', 'rook', 'king'], description: 'Agent role receiving the pack.' },
      { name: '--project', type: 'string', required: false, description: 'Project id or slug.' },
      { name: '--project-id', type: 'string', required: false, description: 'Project/workspace id.' },
      { name: '--workspace', type: 'string', required: false, description: 'Workspace id alias for --project-id.' },
      { name: '--project-dir', type: 'string', required: false, description: 'Project directory. Defaults to the current working directory.' },
    ],
    examples: [
      { cmd: 'ace wiki pack --role orchestrator --project prj_42', description: 'Build an orchestrator pack without loading dumps.' },
    ],
    outputShape: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        pack: { type: 'object' },
      },
    },
  },
  {
    cli: 'wiki audit',
    description: 'Audit canonical project wiki pages and role packs for dump/canon contamination and required source metadata.',
    ipcMethod: 'special:wikiAudit',
    flags: [
      { name: '--project-dir', type: 'string', required: false, description: 'Project directory. Defaults to the current working directory.' },
    ],
    examples: [
      { cmd: 'ace wiki audit --project-dir /path/to/project', description: 'Fail if canonical wiki pages or packs are contaminated.' },
    ],
    outputShape: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        errors: { type: 'array' },
        checked: { type: 'array' },
      },
    },
  },
  {
    cli: 'wiki backfill',
    description: 'Bootstrap the OKF wiki skeleton (index.md, log.md, 00_index/) and promote existing dumps into canon for a dump-only project. Idempotent — safe to re-run. Fixes projects that have .ace/wiki-dump/ but no .ace/wiki/.',
    ipcMethod: 'special:wikiBackfill',
    flags: [
      { name: '--project-id', type: 'string', required: false, description: 'Project/workspace id for the skeleton frontmatter.' },
      { name: '--project-name', type: 'string', required: false, description: 'Human-readable project name.' },
      { name: '--identity', type: 'string', required: false, default: 'all', description: 'Dump identity filter (default all).' },
      { name: '--project-dir', type: 'string', required: false, description: 'Project directory. Defaults to the current working directory.' },
    ],
    examples: [
      { cmd: 'ace wiki backfill --project-dir /path/to/dump-only-project', description: 'Bootstrap canon for a project that only had wiki-dump/.' },
    ],
    outputShape: {
      type: 'object',
      properties: {
        schema: { type: 'string' },
        before: { type: 'object' },
        after: { type: 'object' },
        skeletonCreated: { type: 'boolean' },
        curation: { type: 'object' },
      },
    },
  },
  {
    cli: 'wiki writeback',
    description: 'Parse a worker DONE/BLOCKED WIKI_UPDATE packet and append one KnowledgeEvent per listed event to .ace/wiki-events.ndjson. Does not write canon (the tiered gate promotes). DONE/BLOCKED/VERDICT trailer parsing is unaffected.',
    ipcMethod: 'special:wikiWriteback',
    flags: [
      { name: '--text', type: 'string', required: false, description: 'The DONE/BLOCKED output containing a WIKI_UPDATE: block.' },
      { name: '--file', type: 'string', required: false, description: 'Path to a file containing the DONE/BLOCKED output.' },
      { name: '--project-id', type: 'string', required: false, description: 'Fallback project id when the packet omits project:.' },
      { name: '--project-name', type: 'string', required: false, description: 'Human-readable project name.' },
      { name: '--mission', type: 'string', required: false, description: 'Mission id default for events.' },
      { name: '--feature', type: 'string', required: false, description: 'Feature id default for events.' },
      { name: '--project-dir', type: 'string', required: false, description: 'Project directory. Defaults to the current working directory.' },
    ],
    examples: [
      { cmd: 'ace wiki writeback --file completion.txt --project-id prj_42', description: 'Ingest a worker completion WIKI_UPDATE packet as KnowledgeEvents.' },
    ],
    outputShape: {
      type: 'object',
      properties: { schema: { type: 'string' }, project: { type: 'string' }, events: { type: 'array' } },
    },
  },
  {
    cli: 'wiki curate-events',
    description: 'Run the tiered promotion gate over pending KnowledgeEvents: extract candidates, auto-promote only sourced + high-confidence + non-sensitive + non-contradicting ones into canon, and route the rest (contradictions/supersedes/sensitive/low-confidence) to the wiki inbox.',
    ipcMethod: 'special:wikiCurateEvents',
    flags: [
      { name: '--threshold', type: 'number', required: false, description: 'Auto-promote confidence threshold (default 0.8).' },
      { name: '--project-dir', type: 'string', required: false, description: 'Project directory. Defaults to the current working directory.' },
    ],
    examples: [
      { cmd: 'ace wiki curate-events --project-dir /path/to/project', description: 'Promote safe events to canon; queue the rest for review.' },
    ],
    outputShape: {
      type: 'object',
      properties: {
        eventsRead: { type: 'number' }, candidatesExtracted: { type: 'number' },
        autoPromoted: { type: 'number' }, inboxed: { type: 'number' }, rejected: { type: 'number' },
      },
    },
  },
  {
    cli: 'wiki inbox',
    description: 'List WikiCandidates awaiting owner review (contradictions/supersedes/sensitive/low-confidence). These never auto-promote — the BEE-scar guard.',
    ipcMethod: 'special:wikiInbox',
    flags: [
      { name: '--all', type: 'boolean', required: false, description: 'Include resolved (promoted/rejected) entries.' },
      { name: '--project-dir', type: 'string', required: false, description: 'Project directory. Defaults to the current working directory.' },
    ],
    examples: [
      { cmd: 'ace wiki inbox', description: 'Show pending candidate reviews for this project.' },
    ],
    outputShape: {
      type: 'object',
      properties: { schema: { type: 'string' }, pending: { type: 'number' }, entries: { type: 'array' } },
    },
  },
  {
    cli: 'wiki promote',
    description: 'Promote one inbox WikiCandidate into canon (writes a git-diffable page change), or --reject it. Owner-gated review action.',
    ipcMethod: 'special:wikiPromote',
    flags: [
      { name: '--reject', type: 'boolean', required: false, description: 'Reject the candidate instead of promoting it.' },
      { name: '--project-dir', type: 'string', required: false, description: 'Project directory. Defaults to the current working directory.' },
    ],
    positionals: [
      { name: 'inboxId', required: true, description: 'Inbox entry id from `ace wiki inbox`.' },
    ],
    examples: [
      { cmd: 'ace wiki promote inbox_ab12cd34ef56', description: 'Write the reviewed candidate into canon.' },
    ],
    outputShape: {
      type: 'object',
      properties: { schema: { type: 'string' }, promoted: { type: 'boolean' }, written: { type: 'array' } },
    },
  },
  {
    cli: 'wiki health',
    description: 'Report wiki/knowledge health: last nightly, dump-only projects (the warning that catches dump-only-no-canon), candidates accepted/rejected, stale pages, source coverage, raw-vs-canon ratio, index freshness, and an overall severity.',
    ipcMethod: 'special:wikiHealth',
    flags: [
      { name: '--projects-root', type: 'string', required: false, description: 'Scan every immediate subdirectory that has a .ace/ as a project.' },
      { name: '--project-dir', type: 'string', required: false, description: 'Single project directory. Defaults to the current working directory.' },
    ],
    examples: [
      { cmd: 'ace wiki health --projects-root /path/to/workspaces', description: 'Health across all workspaces, flagging dump-only projects.' },
    ],
    outputShape: {
      type: 'object',
      properties: {
        schema: { type: 'string' }, severity: { type: 'string' },
        dumpOnlyProjects: { type: 'array' }, rawVsCanonRatio: { type: 'number' }, flags: { type: 'array' },
      },
    },
  },
  {
    cli: 'event emit',
    description: 'Append a harness event to .ace/events.ndjson.',
    ipcMethod: 'special:eventEmit',
    flags: [
      { name: '--payload', type: 'string', required: false, description: 'JSON payload object. Defaults to {}.' },
      { name: '--project-dir', type: 'string', required: false, description: 'Project directory. Defaults to the current working directory.' },
    ],
    positionals: [
      { name: 'event', required: true, description: 'Event name, for example worker.completion.detected.' },
    ],
    examples: [
      { cmd: 'ace event emit worker.completion.detected --payload \'{\"kind\":\"DONE\"}\'', description: 'Append one event line to .ace/events.ndjson.' },
    ],
    outputShape: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        event: { type: 'object' },
        actions: { type: 'array' },
      },
    },
  },
  {
    cli: 'tool manifest',
    description: 'Return the compact Ace Tool Contract for a role/phase.',
    ipcMethod: 'special:toolManifest',
    flags: [
      { name: '--role', type: 'string', required: false, description: 'Tool-contract role; defaults from the current Ace session.' },
      { name: '--phase', type: 'string', required: false, description: 'Tool-contract phase; defaults to the current phase or start.' },
      { name: '--compact', type: 'boolean', required: false, description: 'Return compact required/allowed commands.' },
      { name: '--project-dir', type: 'string', required: false, description: 'Project directory for ledger recording. Defaults to cwd/.ace when present.' },
    ],
    examples: [
      { cmd: 'ace tool manifest --role orchestrator --phase start --compact', description: 'Print the compact start-phase contract.' },
    ],
    outputShape: {
      type: 'object',
      properties: {
        schema: { type: 'string' },
        role: { type: 'string' },
        phase: { type: 'string' },
        required: { type: 'array' },
        allowed: { type: 'array' },
      },
    },
  },
  {
    cli: 'tool heartbeat',
    description: 'Write a compact Ace tool-use proof event to the project ledger.',
    ipcMethod: 'special:toolHeartbeat',
    flags: [
      { name: '--role', type: 'string', required: false, description: 'Tool-contract role; defaults from the current Ace session.' },
      { name: '--phase', type: 'string', required: false, description: 'Tool-contract phase; defaults to the current phase or start.' },
      { name: '--workspace', type: 'string', required: false, description: 'Workspace id.' },
      { name: '--mission', type: 'string', required: false, description: 'Mission id.' },
      { name: '--task', type: 'string', required: false, description: 'Task id.' },
      { name: '--stream', type: 'string', required: false, description: 'Stream id.' },
      { name: '--project-dir', type: 'string', required: false, description: 'Project directory for ledger recording. Defaults to cwd/.ace when present.' },
    ],
    examples: [
      { cmd: 'ace tool heartbeat --role orchestrator --phase start --workspace prj_42', description: 'Record a start-phase heartbeat.' },
    ],
    outputShape: {
      type: 'object',
      properties: {
        written: { type: 'boolean' },
        path: { type: 'string' },
        event: { type: 'object' },
      },
    },
  },
  {
    cli: 'tool audit',
    description: 'Audit the Ace tool-use ledger for missing required proof events.',
    ipcMethod: 'special:toolAudit',
    flags: [
      { name: '--role', type: 'string', required: false, description: 'Tool-contract role.' },
      { name: '--phase', type: 'string', required: false, description: 'Tool-contract phase.' },
      { name: '--workspace', type: 'string', required: false, description: 'Workspace id.' },
      { name: '--mission', type: 'string', required: false, description: 'Mission id.' },
      { name: '--task', type: 'string', required: false, description: 'Task id.' },
      { name: '--stream', type: 'string', required: false, description: 'Stream id.' },
      { name: '--run', type: 'string', required: false, description: 'Run id; restricts proof to events emitted under this run id (excludes stale evidence).' },
      { name: '--since', type: 'string', required: false, description: 'ISO timestamp; only events at-or-after this time qualify.' },
      { name: '--window-ms', type: 'number', required: false, description: 'Sliding window in milliseconds; only events within the trailing window qualify.' },
      { name: '--project-dir', type: 'string', required: false, description: 'Project directory for ledger recording. Defaults to cwd/.ace when present.' },
    ],
    examples: [
      { cmd: 'ace tool audit --role orchestrator --phase start --workspace prj_42', description: 'Check start-phase proof before dispatch.' },
      { cmd: 'ace tool audit --role orchestrator --phase dispatch --run run-abc123', description: 'Run-scoped audit; only this run\'s events satisfy required proof.' },
    ],
    outputShape: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        missingRequiredEvents: { type: 'array' },
        commandsSeen: { type: 'array' },
        driftWarnings: { type: 'array' },
      },
    },
  },
  {
    cli: 'tool batch',
    description: 'Run a validated batch of independent Ace tool/read commands and write one compact ledger event.',
    ipcMethod: 'special:toolBatch',
    flags: [
      { name: '--input', type: 'string', required: true, description: 'JSON file path, inline JSON object, or - for stdin using ace.tool_batch.v1.' },
      { name: '--parallel', type: 'boolean', required: false, description: 'Run independent dependency-layer calls concurrently.' },
      { name: '--max-concurrency', type: 'number', required: false, default: 4, description: 'Maximum concurrent calls per dependency layer.' },
      { name: '--run', type: 'string', required: false, description: 'Run id stamped onto the batch event and child call scope.' },
      { name: '--project-dir', type: 'string', required: false, description: 'Project directory for ledger recording. Defaults to cwd/.ace when present.' },
    ],
    examples: [
      { cmd: 'ace tool batch --parallel --max-concurrency 4 --input /tmp/ace-start-batch.json', description: 'Record start proof with heartbeat, manifest, context, board, and stream reads.' },
    ],
    outputShape: {
      type: 'object',
      properties: {
        schema: { type: 'string' },
        role: { type: 'string' },
        phase: { type: 'string' },
        parallel: { type: 'boolean' },
        maxConcurrency: { type: 'integer' },
        durationMs: { type: 'integer' },
        results: { type: 'array' },
      },
    },
  },
  {
    cli: 'validation clawpatch',
    description: 'Run the safe Clawpatch semantic validation loop and write a Ace validation artifact.',
    ipcMethod: 'special:validationClawpatch',
    flags: [
      { name: '--project-dir', type: 'string', required: false, description: 'Project directory. Defaults to cwd.' },
      { name: '--workspace', type: 'string', required: false, description: 'Workspace id; resolves to the workspace project directory when a Ace transport is available.' },
      { name: '--run', type: 'string', required: false, description: 'Harness run id for artifact naming.' },
      { name: '--task', type: 'string', required: false, description: 'Task id.' },
      { name: '--mission', type: 'string', required: false, description: 'Mission id.' },
      { name: '--feature', type: 'string', required: false, description: 'Feature id.' },
      { name: '--wave', type: 'string', required: false, description: 'Wave id.' },
      { name: '--limit', type: 'number', required: false, description: 'Finding/review limit. Defaults to 10.' },
      { name: '--report', type: 'boolean', required: false, description: 'Run and persist clawpatch report output.' },
      { name: '--timeout-ms', type: 'number', required: false, description: 'Per-clawpatch-command timeout in milliseconds. Defaults to 120000.' },
      { name: '--json-output', type: 'boolean', required: false, description: 'Ask clawpatch for JSON when supported.' },
      { name: '--required', type: 'boolean', required: false, description: 'Force Clawpatch to run even when risk policy would skip it.' },
      { name: '--risk-class', type: 'string', required: false, choices: ['trivial', 'small', 'medium', 'high'], description: 'Risk class used to decide whether Clawpatch is required by default.' },
      { name: '--no-code', type: 'boolean', required: false, description: 'Declare a no-code diagnostic/smoke path; skips Clawpatch unless --required is also passed.' },
    ],
    examples: [
      { cmd: 'ace validation clawpatch --project-dir . --mission msn_42 --wave wave-1 --limit 10 --report', description: 'Record Clawpatch validation evidence for a wave gate.' },
      { cmd: 'ace validation clawpatch --workspace prj_42 --risk-class small --no-code', description: 'Record a risk-policy skip artifact without running Clawpatch.' },
    ],
    outputShape: {
      type: 'object',
      properties: {
        schema: { type: 'string' },
        status: { type: 'string' },
        validatedHeadSha: { type: ['string', 'null'] },
        required: { type: 'boolean' },
        skipped: { type: 'boolean' },
        reason: { type: 'string' },
        doctorOk: { type: 'boolean' },
        commandsRun: { type: 'array' },
        artifactPath: { type: 'string' },
        markdownPath: { type: 'string' },
      },
    },
  },
  {
    cli: 'version',
    description: 'Print ace build identity (cli version, app version, source SHA, node, platform). Works without a live socket.',
    ipcMethod: 'special:version',
    flags: [
      { name: '--expected-runtime-sha', alias: '--expect-sha', type: 'string', required: false, description: 'Expected source/build SHA; exits non-zero when the running CLI does not match.' },
    ],
    positionals: [],
    examples: [
      { cmd: 'ace version', description: 'Human-readable build identity.' },
      { cmd: 'ace version --json', description: 'JSON envelope with cli/app/git/node fields.' },
      { cmd: 'ace --version', description: 'Same payload via the short flag.' },
    ],
    outputShape: {
      type: 'object',
      properties: {
        cliVersion: { type: 'string' },
        appVersion: { type: ['string', 'null'] },
        gitSha: { type: ['string', 'null'] },
        gitShortSha: { type: ['string', 'null'] },
        repoPath: { type: ['string', 'null'] },
        sourcePath: { type: 'string' },
        cliPath: { type: ['string', 'null'] },
        node: { type: 'string' },
        platform: { type: 'string' },
        arch: { type: 'string' },
        packaged: { type: 'boolean' },
        sourceMode: { type: 'string' },
      },
    },
  },
  {
    cli: 'describe',
    description: 'Print the CLI registry as a machine-readable manifest. Run with no args for full surface, with a command name for one entry, or --markdown for human-readable.',
    ipcMethod: 'special:describe', notFound: true,
    flags: [
      { name: '--markdown', type: 'boolean', required: false, description: 'Render a human-readable markdown manifest instead of JSON.' },
    ],
    positionals: [
      { name: 'command', required: false, description: 'Optional command name to describe just that entry.' },
    ],
    examples: [
      { cmd: 'ace describe', description: 'Full registry as single-line JSON.' },
      { cmd: 'ace describe ls', description: 'Just the `ls` entry.' },
      { cmd: 'ace describe --markdown', description: 'Human-readable rendering.' },
    ],
    outputShape: {
      type: 'object',
      properties: {
        version: { type: 'string' },
        commands: { type: 'array' },
        exitCodes: { type: 'object' },
        transport: { type: 'object' },
      },
    },
  },
];

function normalizeCommand(command: any) {
  const { notFound, conflict, ...rest } = command;
  const exitCodes = conflict ? withConflict : (notFound ? withNotFound : baseExits);
  return {
    ...rest,
    flags: rest.flags || [],
    positionals: rest.positionals || [],
    exitCodes: { ...exitCodes },
  };
}

const COMMANDS = rawCommands.map(normalizeCommand);
const byCli = new Map(COMMANDS.map((c: any) => [c.cli, c]));

function getCommand(cli: any) {
  return byCli.get(cli) || null;
}

function allCommands() {
  return COMMANDS.slice();
}

module.exports = { COMMANDS, EXIT_CODES, getCommand, allCommands };
