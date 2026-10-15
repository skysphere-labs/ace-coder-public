// Ace CLI entry point. The executable is `ace`.
//
// Registry-driven dispatcher. Every subcommand is described in
// commands.cjs; this file's job is to parse argv against that registry,
// route to an IPC method or special handler, wrap the response in a
// structured envelope, and exit with a meaningful code.
//
// Output contract:
//   stdout — single-line JSON `{"ok":true,"data":{...}}` for every command,
//            EXCEPT `screen` and `follow` which print raw text unless the
//            global `--json` flag (or env ACE_JSON=1) is set.
//   stderr — single-line JSON `{"ok":false,"code":N,"error":"slug",
//            "message":"...","details":{...}}` for errors.
//   exit   — 0 ok, 2 arg-error, 3 transport-error, 4 timeout,
//            5 server-error, 6 not-found, 7 conflict.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { createClient } = require('./client.cjs');
const { COMMANDS, EXIT_CODES, getCommand } = require('./commands.cjs');
const toolContract = require('./tool-contract.cjs');
const changeRiskPolicy = require('./change-risk-policy.cjs');
const loopCli = require('./loop-cli.cjs');
const {
  createChildRegistry: createChildRegistryStore,
  createFileDb: createChildRegistryFileDb,
  defaultStorePath: defaultChildRegistryStorePath,
  isInternalSubagentCompletion,
} = require('./child-registry.cjs');
const {
  parseValidatorRecordVerdict,
  parseJsonObject: parseVerdictJsonObject,
} = require('./verdict.cjs');
const { listTerminalTrailers } = require('./trailers.cjs');
const { normalizeValidationFailurePacket } = require('./validation-artifacts.cjs');
const { evaluatePrScope } = require('./pr-scope-policy.cjs');

const CLI_NAME = 'ace';

// Defect 5: the sync audit accepts scoped observability commands as proof.
// For an operator to satisfy a run-scoped audit with `task result` / `run list`
// / `screen` / `state` / `mission next`, the CLI must accept the tool-contract
// scope flags (--role, --phase, --workspace, --mission, --task, --stream,
// --run, --project-dir) on those commands. The registry stays in commands.cts;
// we inject the scope flags here so we don't fork the catalog file.
const TOOL_CONTRACT_SCOPE_FLAGS = [
  { name: '--role', type: 'string', required: false, description: 'Tool-contract role for ledger auto-record (e.g. orchestrator).' },
  { name: '--phase', type: 'string', required: false, description: 'Tool-contract phase for ledger auto-record (e.g. sync).' },
  { name: '--workspace', type: 'string', required: false, description: 'Workspace id for ledger scope.' },
  { name: '--mission', type: 'string', required: false, description: 'Mission id for ledger scope.' },
  { name: '--task', type: 'string', required: false, description: 'Task id for ledger scope.' },
  { name: '--stream', type: 'string', required: false, description: 'Stream id for ledger scope.' },
  { name: '--run', type: 'string', required: false, description: 'Run id for run-scoped ledger proof.' },
  { name: '--project-dir', type: 'string', required: false, description: 'Project directory whose .ace ledger should be written.' },
];

const TOOL_CONTRACT_SCOPE_COMMANDS = new Set([
  'screen',
  'state',
  'task result',
  'run list',
]);

for (const entry of COMMANDS) {
  if (!TOOL_CONTRACT_SCOPE_COMMANDS.has(entry.cli)) continue;
  const existingNames = new Set((entry.flags || []).map((flag: any) => flag.name));
  entry.flags = [
    ...(entry.flags || []),
    ...TOOL_CONTRACT_SCOPE_FLAGS.filter((flag) => !existingNames.has(flag.name)),
  ];
}
const {
  applyEnforcement,
  ctxFromEnv,
  enforceDelegation,
  findRelatedHealthyStream,
  resolveActiveInstanceTag,
} = require('./enforcement.cjs');
const { validateCompletionResult } = require('../../../electron/harness/completion-result.cts');
const { createProjectHarnessHandlers } = require('./project-harness-handlers.cjs');
const { createWikiKnowledgeHandlers } = require('./wiki-knowledge-handlers.cjs');
const projectWikiCurator = require('./project-wiki-curator.cjs');

const PKG = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  } catch {
    return { version: '0.0.0' };
  }
})();

function tryRead(filePath: string) {
  try {
    return fs.readFileSync(filePath, 'utf8').trim();
  } catch {
    return null;
  }
}

function tryReadJson(filePath: string) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function resolveGitDir(repoRoot: string) {
  const dotGit = path.join(repoRoot, '.git');
  const stat = (() => {
    try { return fs.statSync(dotGit); } catch { return null; }
  })();
  if (!stat) return null;
  if (stat.isDirectory()) return { gitDir: dotGit, commonDir: dotGit };
  const content = tryRead(dotGit);
  const match = content?.match(/^gitdir:\s*(.+)$/i);
  if (!match) return null;
  const gitDir = path.resolve(repoRoot, match[1].trim());
  const commonDirText = tryRead(path.join(gitDir, 'commondir'));
  const commonDir = commonDirText
    ? path.resolve(gitDir, commonDirText)
    : gitDir;
  return { gitDir, commonDir };
}

function readGitRef(gitPaths: any, ref: string) {
  for (const base of [gitPaths.gitDir, gitPaths.commonDir]) {
    const value = tryRead(path.join(base, ref));
    if (value) return value;
  }
  for (const base of [gitPaths.gitDir, gitPaths.commonDir]) {
    const packed = tryRead(path.join(base, 'packed-refs'));
    if (!packed) continue;
    const line = packed.split(/\r?\n/).find((row: string) => row.endsWith(ref));
    if (line) return line.split(/\s+/)[0];
  }
  return null;
}

function readSourceGitSha(repoRoot: string) {
  const gitPaths = resolveGitDir(repoRoot);
  if (!gitPaths) return null;
  const head = tryRead(path.join(gitPaths.gitDir, 'HEAD'));
  if (!head) return null;
  const refMatch = head.match(/^ref:\s*(.+)$/);
  if (refMatch) return readGitRef(gitPaths, refMatch[1].trim());
  return /^[0-9a-f]{40}$/i.test(head) ? head : null;
}

function normalizeExpectedSha(value: any) {
  const text = String(value || '').trim();
  if (!text) return null;
  return /^[0-9a-f]{7,40}$/i.test(text) ? text.toLowerCase() : text;
}

function expectedRuntimeSha(flags: any = {}) {
  return normalizeExpectedSha(flags.expectedRuntimeSha || process.env.ACE_EXPECTED_RUNTIME_SHA);
}

function runtimeExpectation(payload: any, expectedSha: any) {
  const expected = normalizeExpectedSha(expectedSha);
  if (!expected) return null;
  const actual = normalizeExpectedSha(payload.gitSha);
  const current = Boolean(actual && actual.startsWith(expected));
  return {
    expectedSha: expected,
    actualSha: actual,
    current,
    source: payload.gitSource || null,
  };
}

function withRuntimeExpectation(payload: any, expectedSha: any) {
  const expectation = runtimeExpectation(payload, expectedSha);
  return expectation ? { ...payload, runtimeExpectation: expectation } : payload;
}

function assertRuntimeCurrent(payload: any, expectedSha: any) {
  const expectation = runtimeExpectation(payload, expectedSha);
  if (!expectation || expectation.current) return;
  die({
    code: 5,
    error: 'runtime_sha_mismatch',
    message: `runtime SHA ${expectation.actualSha || 'unknown'} does not match expected ${expectation.expectedSha}`,
    details: { runtimeExpectation: expectation },
  });
}

function expectedShaFromArgv(argv: string[]) {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--expected-runtime-sha' || arg === '--expect-sha') return argv[i + 1] || null;
    if (arg.startsWith('--expected-runtime-sha=')) return arg.slice('--expected-runtime-sha='.length);
    if (arg.startsWith('--expect-sha=')) return arg.slice('--expect-sha='.length);
  }
  return process.env.ACE_EXPECTED_RUNTIME_SHA || null;
}

let cachedVersionPayload: any = null;
function buildVersionPayload() {
  if (cachedVersionPayload) return cachedVersionPayload;
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const cliPkg = PKG;
  const repoPkg = tryReadJson(path.join(repoRoot, 'package.json')) || {};
  const buildInfo = tryReadJson(path.join(__dirname, 'build-info.json'));
  const sourceGitSha = readSourceGitSha(repoRoot);
  const gitSha = sourceGitSha || buildInfo?.gitSha || null;
  const gitShortSha = gitSha ? gitSha.slice(0, 12) : null;
  const isGit = Boolean(resolveGitDir(repoRoot));
  const sourceDir = path.dirname(__dirname);
  const packagedHint = sourceDir.includes(path.join('app.asar', 'tools')) || sourceDir.includes('Resources/app.asar');
  cachedVersionPayload = {
    schema: 'ace.cli.version.v1',
    cliVersion: cliPkg.version,
    cliName: CLI_NAME,
    appVersion: repoPkg.version || null,
    appName: repoPkg.name || null,
    repoPath: isGit ? repoRoot : null,
    sourcePath: sourceDir,
    cliPath: process.argv[1] || null,
    gitSha,
    gitShortSha,
    gitSource: sourceGitSha ? 'git' : buildInfo?.gitSha ? 'build-info' : null,
    buildInfo: buildInfo ? {
      gitSha: buildInfo.gitSha || null,
      gitShortSha: buildInfo.gitShortSha || null,
      builtAt: buildInfo.builtAt || null,
    } : null,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    packaged: packagedHint,
    sourceMode: packagedHint ? 'packaged' : 'source',
    transportMode: process.env.ACE_URL ? 'remote' : 'socket',
  };
  return cachedVersionPayload;
}

function renderVersionText(expectedSha: any = null) {
  const payload = withRuntimeExpectation(buildVersionPayload(), expectedSha);
  const lines = [
    `${payload.cliName} v${payload.cliVersion}`,
    payload.appVersion ? `Ace desktop: v${payload.appVersion}` : null,
    payload.gitShortSha ? `Source SHA: ${payload.gitShortSha}` : null,
    payload.repoPath ? `Repo: ${payload.repoPath}` : null,
    payload.cliPath ? `CLI: ${payload.cliPath}` : null,
    `Node: ${payload.node}`,
    `Platform: ${payload.platform}/${payload.arch}`,
    `Packaged: ${payload.packaged ? 'yes' : 'source'}`,
    payload.runtimeExpectation ? `Runtime current: ${payload.runtimeExpectation.current ? 'yes' : 'no'} (expected ${payload.runtimeExpectation.expectedSha})` : null,
  ].filter(Boolean);
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Output / error envelopes
// ---------------------------------------------------------------------------

function isEpipe(err: any) {
  return err && err.code === 'EPIPE';
}

function writeOutput(stream: any, text: string) {
  try {
    stream.write(text);
  } catch (err) {
    if (isEpipe(err)) process.exit(0);
    throw err;
  }
}

process.stdout.on('error', (err: any) => {
  if (isEpipe(err)) process.exit(0);
  throw err;
});

function printJson(obj: any) {
  writeOutput(process.stdout, JSON.stringify(obj) + '\n');
}

let jsonErrorsToStdout = false;
let activeCliInvocation: any = null;
let activeCliInvocationRecorded = false;

function emitOk(data: any) {
  printJson({ ok: true, data: data ?? null });
}

function renderTaskRunStatus(result: any) {
  const labels = {
    done: 'Completed',
    'done-unverified': 'Completed (unverified)',
    blocked: 'Blocked',
    'awaiting-approval': 'Awaiting approval',
    'max-rounds': 'Incomplete',
    dispatched: 'Dispatched',
    'dry-run': 'Dry run',
    timeout: 'Timed out',
    error: 'Error',
  };
  const label = labels[result?.outcome] || String(result?.outcome || 'unknown');
  return result?.detail ? `${label}: ${result.detail}` : label;
}

function die({ code, error, message, details }: any) {
  recordActiveCliInvocation(false, message || error);
  const env = { ok: false, code, error, message: message || error };
  if (details) env.details = details;
  const line = JSON.stringify(env) + '\n';
  if (jsonErrorsToStdout) writeOutput(process.stdout, line);
  else process.stderr.write(line);
  process.exit(code);
}

function cliEventContext(command: any, parsed: any) {
  const flags = parsed?.flags || {};
  return {
    command: command?.cli || null,
    role: flags.role || process.env.ACE_ROLE || null,
    phase: flags.phase || process.env.ACE_PHASE || null,
    workspaceId: flags.workspace || process.env.ACE_WORKSPACE_ID || null,
    missionId: flags.mission || process.env.ACE_MISSION_ID || null,
    taskId: flags.task || process.env.ACE_TASK_ID || null,
    streamId: flags.stream || process.env.ACE_STREAM_ID || parsed?.positionals?.[0] || null,
    runId: flags.run || process.env.ACE_RUN_ID || null,
    projectDir: flags.projectDir || null,
  };
}

function shouldAutoRecordCli(command: any) {
  if (!command?.cli) return false;
  return !String(command.cli).startsWith('tool ');
}

function recordActiveCliInvocation(ok: boolean, error: any = null) {
  if (!activeCliInvocation || activeCliInvocationRecorded) return;
  activeCliInvocationRecorded = true;
  if (!shouldAutoRecordCli(activeCliInvocation.command)) return;
  try {
    toolContract.writeToolUseEvent({
      ...activeCliInvocation.context,
      ok,
      error,
      durationMs: Date.now() - activeCliInvocation.startedAt,
    });
  } catch {
    // Ledger recording must never break the CLI command it is observing.
  }
}

process.once('beforeExit', () => {
  recordActiveCliInvocation(true);
});

// ---------------------------------------------------------------------------
// Argv parser — registry-aware. Supports:
//   --flag value
//   --flag=value
//   -f value
//   -f=value
//   boolean flags (no value)
//   string-repeated (collected into an array)
// ---------------------------------------------------------------------------

function findFlagSpec(flags: any, token: any) {
  // token is "--name" or "-x". Match against name or alias.
  for (const f of flags) {
    if (f.name === token) return f;
    if (f.alias && f.alias === token) return f;
  }
  return null;
}

function parseArgs(argv: any, command: any) {
  const flagSpecs = command.flags || [];
  const positionals = command.positionals || [];

  const out = { flags: {}, positionals: [] };
  const knownFlagNames = flagSpecs.flatMap((f: any) => (f.alias ? [f.name, f.alias] : [f.name]));

  // Pre-populate defaults and string-repeated buckets.
  for (const f of flagSpecs) {
    if (f.type === 'string-repeated') out.flags[stripDashes(f.name)] = [];
    else if (f.default !== undefined) out.flags[stripDashes(f.name)] = f.default;
  }

  let i = 0;
  while (i < argv.length) {
    const tok = argv[i];

    if (tok === '--') {
      // explicit positional separator
      out.positionals.push(...argv.slice(i + 1));
      break;
    }

    if (tok.startsWith('-')) {
      // Split --flag=value or -f=value.
      let name = tok;
      let inlineValue = null;
      const eq = tok.indexOf('=');
      if (eq > 0) {
        name = tok.slice(0, eq);
        inlineValue = tok.slice(eq + 1);
      }

      const spec = findFlagSpec(flagSpecs, name);
      if (!spec) {
        die({
          code: 2,
          error: 'unknown_flag',
          message: `unknown flag: ${name}`,
          details: { flag: name, command: command.cli, known: knownFlagNames },
        });
      }

      const key = stripDashes(spec.name);

      if (spec.type === 'boolean') {
        if (inlineValue !== null) {
          // --flag=true / --flag=false
          out.flags[key] = inlineValue === 'true' || inlineValue === '1';
        } else {
          out.flags[key] = true;
        }
        i += 1;
        continue;
      }

      let value = inlineValue;
      if (value === null) {
        value = argv[i + 1];
        if (value === undefined || (typeof value === 'string' && value.startsWith('-'))) {
          die({
            code: 2,
            error: 'missing_arg',
            message: `flag ${spec.name} requires a value`,
            details: { flag: spec.name, command: command.cli },
          });
        }
        i += 2;
      } else {
        i += 1;
      }

      if (spec.type === 'number') {
        const n = Number(value);
        if (!Number.isFinite(n)) {
          die({
            code: 2,
            error: 'invalid_number',
            message: `flag ${spec.name} expects a number, got ${value}`,
            details: { flag: spec.name, value, command: command.cli },
          });
        }
        out.flags[key] = n;
      } else if (spec.type === 'string-repeated') {
        out.flags[key].push(String(value));
      } else {
        // string
        if (spec.choices && !spec.choices.includes(value)) {
          die({
            code: 2,
            error: 'invalid_choice',
            message: `flag ${spec.name} must be one of ${spec.choices.join('|')}`,
            details: { flag: spec.name, value, choices: spec.choices, command: command.cli },
          });
        }
        out.flags[key] = String(value);
      }
      continue;
    }

    out.positionals.push(tok);
    i += 1;
  }

  // Required-flag enforcement.
  for (const f of flagSpecs) {
    if (!f.required) continue;
    const key = stripDashes(f.name);
    const v = out.flags[key];
    if (v === undefined || v === null || (Array.isArray(v) && v.length === 0)) {
      die({
        code: 2,
        error: 'missing_arg',
        message: `required flag ${f.name} not provided`,
        details: { flag: f.name, command: command.cli },
      });
    }
  }

  // Required-positional enforcement.
  for (let idx = 0; idx < positionals.length; idx++) {
    const p = positionals[idx];
    if (!p.required) continue;
    if (out.positionals[idx] === undefined || out.positionals[idx] === '') {
      die({
        code: 2,
        error: 'missing_arg',
        message: `missing required positional argument: ${p.name}`,
        details: { positional: p.name, command: command.cli },
      });
    }
  }

  return out;
}

function stripDashes(flag: any) {
  return flag.replace(/^-+/, '').replace(/-([a-z])/g, (_: any, c: any) => c.toUpperCase());
}

// ---------------------------------------------------------------------------
// Help / describe rendering
// ---------------------------------------------------------------------------

function transportInfo() {
  return {
    socket: {
      env: ['ACE_SOCK', 'ACE_USER_DATA_TAG', 'XDG_RUNTIME_DIR'],
      description: 'Default. Local Unix socket spawned by the running Ace desktop app.',
    },
    remote: {
      env: ['ACE_URL', 'ACE_TOKEN'],
      description: 'Set both to talk to a remote Ace instance over HTTP/HTTPS.',
    },
    timeout: {
      env: 'ACE_TIMEOUT_MS',
      defaultMs: 60000,
      description: 'Per-request client-side deadline. Overridden by --timeout on commands that accept it.',
    },
  };
}

function describeManifest() {
  return {
    version: PKG.version,
    commands: COMMANDS,
    exitCodes: EXIT_CODES,
    transport: transportInfo(),
  };
}

function flagMeta(flag: any, { markdown = false }: any = {}) {
  const meta = [flag.type];
  if (flag.required) meta.push('required');
  if (flag.default !== undefined) {
    meta.push(markdown ? `default \`${flag.default}\`` : `default=${flag.default}`);
  }
  if (flag.choices) {
    meta.push(markdown ? `choices \`${flag.choices.join('|')}\`` : `choices=${flag.choices.join('|')}`);
  }
  return meta.join(', ');
}

function renderPositionals(command: any, { markdown = false }: any = {}) {
  if (!command.positionals?.length) return [];
  if (markdown) {
    return [
      '**Positionals:**',
      '',
      ...command.positionals.map((p: any) => `- \`<${p.name}>\`${p.required ? '' : ' _(optional)_'} — ${p.description}`),
      '',
    ];
  }
  return [
    'Positionals:',
    ...command.positionals.map((p: any) => `  <${p.name}>${p.required ? '' : ' (optional)'} — ${p.description || ''}`),
    '',
  ];
}

function renderFlags(command: any, { markdown = false }: any = {}) {
  if (!command.flags?.length) return [];
  if (markdown) {
    return [
      '**Flags:**',
      '',
      ...command.flags.map((f: any) => `- \`${f.name}\` (${flagMeta(f, { markdown })}) — ${f.description}`),
      '',
    ];
  }
  const lines = ['Flags:'];
  for (const f of command.flags) {
    lines.push(`  ${f.name}${f.alias ? `, ${f.alias}` : ''}  [${flagMeta(f)}]`);
    if (f.description) lines.push(`      ${f.description}`);
  }
  lines.push('');
  return lines;
}

function renderExamples(command: any, { markdown = false }: any = {}) {
  if (!command.examples?.length) return [];
  if (markdown) {
    return [
      '**Examples:**',
      '',
      ...command.examples.flatMap((ex: any) => [
        '```bash',
        `$ ${ex.cmd}`,
        '```',
        ...(ex.description ? [ex.description] : []),
        '',
      ]),
    ];
  }
  const lines = ['Examples:'];
  for (const ex of command.examples) {
    lines.push(`  $ ${ex.cmd}`);
    if (ex.description) lines.push(`      ${ex.description}`);
  }
  lines.push('');
  return lines;
}

function renderExitCodes(command: any) {
  return [
    'Exit codes:',
    ...Object.entries(command.exitCodes || {}).map(([code, slug]) => `  ${code}  ${slug}`),
    '',
  ];
}

function renderHelp(command: any) {
  return [
    `${CLI_NAME} ${command.cli} — ${command.description}`,
    '',
    ...renderPositionals(command),
    ...renderFlags(command),
    ...renderExitCodes(command),
    ...renderExamples(command),
  ].join('\n');
}

function renderCommandMarkdown(command: any) {
  return [
    `### \`${CLI_NAME} ${command.cli}\``,
    '',
    command.description,
    '',
    ...renderPositionals(command, { markdown: true }),
    ...renderFlags(command, { markdown: true }),
    ...renderExamples(command, { markdown: true }),
  ];
}

function renderManifestMarkdown() {
  const m = describeManifest();
  const lines = [
    `# ${CLI_NAME} v${m.version}`,
    '',
    'Drive any Ace agent tab from the command line. Every subcommand emits structured JSON on stdout (use --json on `screen`/`follow` to opt in) and a `{ok:false,code,error,message}` envelope on stderr for failures.',
    '',
    '## Exit codes',
    '',
    '| code | meaning |',
    '| ---- | ------- |',
    ...Object.entries(m.exitCodes).map(([code, slug]) => `| ${code} | ${slug} |`),
    '',
    '## Transport',
    '',
    '- **Local socket** (default): resolved via `ACE_SOCK`, `ACE_USER_DATA_TAG`, or `XDG_RUNTIME_DIR`.',
    '- **Remote HTTP**: set `ACE_URL` + `ACE_TOKEN`.',
    `- **Client deadline**: \`ACE_TIMEOUT_MS\` (default ${m.transport.timeout.defaultMs}ms).`,
    '',
    '## Commands',
    '',
    ...m.commands.flatMap(renderCommandMarkdown),
  ];
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Global flag handling — extract --json (and -h/--help on a command)
// before we hand argv to the registry parser.
// ---------------------------------------------------------------------------

function extractGlobalFlags(argv: any) {
  const out = { json: false, help: false, rest: [] };
  if (process.env.ACE_JSON === '1') out.json = true;
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === '--') {
      out.rest.push(...argv.slice(i));
      break;
    }
    if (tok === '--json') { out.json = true; continue; }
    if (tok === '--help' || tok === '-h') { out.help = true; continue; }
    out.rest.push(tok);
  }
  return out;
}

// ---------------------------------------------------------------------------
// IPC error → exit code mapping
// ---------------------------------------------------------------------------

function mapTransportError(err: any) {
  if (err && (err.code === 'NOT_FOUND' || err.error === 'not_found')) {
    return {
      code: 6,
      error: 'not_found',
      message: err.message,
      details: err.details || undefined,
    };
  }
  // Errors tagged by client.cjs. SOCKET_UNREACHABLE → 3, TIMEOUT → 4.
  if (err && err.code === 'TIMEOUT') {
    return { code: 4, error: 'timeout', message: err.message };
  }
  if (err && err.code === 'SOCKET_UNREACHABLE') {
    return { code: 3, error: 'transport_failed', message: err.message };
  }
  if (err && (err.error === 'scope_violation' || err.error === 'instance_mismatch' || err.error === 'invalid_spec')) {
    return {
      code: err.code || 2,
      error: err.error,
      message: err.message,
      details: err.details || undefined,
    };
  }
  if (err && err.error === 'reuse_recommended') {
    return {
      code: err.code || 7,
      error: err.error,
      message: err.message,
      details: err.details || undefined,
    };
  }
  if (err && typeof err.applicationCode === 'string') {
    return {
      code: 5,
      error: err.applicationCode,
      message: err.message,
    };
  }
  // Anything thrown from the IPC layer that didn't tag itself we treat
  // conservatively as a transport failure — the operator can re-run with
  // ACE_TIMEOUT_MS to disambiguate.
  return { code: 5, error: 'server_error', message: err?.message || String(err) };
}

// ---------------------------------------------------------------------------
// Special handlers
// ---------------------------------------------------------------------------

function normalizeText(value: any) {
  const text = String(value == null ? '' : value).trim();
  return text || null;
}

function normalizeNameKey(value: any) {
  return String(value == null ? '' : value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function safeBasename(value: any) {
  const text = normalizeText(value);
  return text ? path.basename(text) : null;
}

function summarizeWorkspace(workspace: any) {
  return {
    id: workspace?.id || null,
    name: workspace?.name || null,
    path: workspace?.isRemote
      ? (workspace?.remotePath || workspace?.path || null)
      : (workspace?.path || null),
  };
}

async function fetchActiveWorkspaceSummaries(client: any) {
  const state = await client.invoke('getState', {});
  return Array.isArray(state?.workspaces) ? state.workspaces.map(summarizeWorkspace) : [];
}

function findMatchingWorkspaces(workspaces: any, env: any = process.env) {
  const repoRoot = normalizeText(env.ACE_REPO_ROOT);
  const workspaceName = normalizeText(env.ACE_WORKSPACE_NAME);
  const repoBase = safeBasename(repoRoot);
  const workspaceKey = normalizeNameKey(workspaceName);
  const repoKey = normalizeNameKey(repoBase);

  return (Array.isArray(workspaces) ? workspaces : [])
    .map((workspace: any) => {
      const name = normalizeText(workspace?.name);
      const wsPath = normalizeText(workspace?.path);
      const nameKey = normalizeNameKey(name);
      const pathBaseKey = normalizeNameKey(safeBasename(wsPath));
      let score = 0;

      if (repoRoot && wsPath && wsPath === repoRoot) score += 100;
      if (workspaceKey && nameKey && nameKey === workspaceKey) score += 80;
      if (repoKey && nameKey && nameKey === repoKey) score += 60;
      if (repoKey && pathBaseKey && pathBaseKey === repoKey) score += 50;
      if (workspaceKey && nameKey && (nameKey.includes(workspaceKey) || workspaceKey.includes(nameKey))) score += 20;
      if (repoKey && nameKey && nameKey.includes(repoKey)) score += 15;
      if (repoKey && pathBaseKey && pathBaseKey.includes(repoKey)) score += 10;

      return { ...workspace, score };
    })
    .filter((workspace: any) => workspace.id && workspace.name && workspace.score > 0)
    .sort((a: any, b: any) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, 3);
}

function buildWorkspaceHint({ workspaces, activeInstanceTag, env = process.env }: any) {
  const matches = findMatchingWorkspaces(workspaces, env);
  if (!matches.length) return null;
  const label = matches.map((workspace: any) => `${workspace.name} (${workspace.id})`).join(', ');
  const where = activeInstanceTag
    ? `in active instance '${activeInstanceTag}'`
    : 'in the active instance';
  return `matching workspaces ${where}: ${label}`;
}

function isWorkspaceNotFoundError(err: any) {
  const message = String(err?.message || '');
  return /workspace not found|unknown projectId/i.test(message);
}

async function augmentWorkspaceNotFound(client: any, err: any, { workspaceId, env = process.env }: any = {}) {
  if (!workspaceId || !isWorkspaceNotFoundError(err)) return err;
  const activeInstanceTag = resolveActiveInstanceTag({ env });
  const workspaces = await fetchActiveWorkspaceSummaries(client).catch(() => []);
  const hint = buildWorkspaceHint({ workspaces, activeInstanceTag, env });
  const next = new Error(hint ? `${err.message}\nHint: ${hint}` : err.message);
  next.code = 'NOT_FOUND';
  next.error = 'not_found';
  next.details = {
    targetWorkspace: workspaceId,
    activeInstanceTag,
  };
  return next;
}

function renderSuperviseTable(rows: any) {
  if (!rows.length) return '(no child-registry rows)\n';
  const cols = ['taskId', 'branch', 'prState', 'prChecks', 'prUrl'];
  const widths = cols.map((c: any) =>
    Math.max(c.length, ...rows.map((r: any) => String(r[c] == null ? '' : r[c]).length))
  );
  const pad = (s: any, w: any) => String(s == null ? '' : s).padEnd(w, ' ');
  const header = cols.map((c: any, i: any) => pad(c, widths[i])).join('  ');
  const sep = widths.map((w: any) => '-'.repeat(w)).join('  ');
  const body = rows
    .map((r: any) => cols.map((c: any, i: any) => pad(r[c], widths[i])).join('  '))
    .join('\n');
  return `${header}\n${sep}\n${body}\n`;
}

function repoRootFromCli() {
  return path.resolve(__dirname, '..', '..', '..');
}

function resolveProjectDirFlag(flags: any) {
  return path.resolve(flags.projectDir || process.cwd());
}

function aceDir(projectDir: any) {
  return path.join(projectDir, '.ace');
}

function readJsonFile(filePath: any) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    die({
      code: 2,
      error: 'invalid_json',
      message: `failed to read JSON file ${filePath}: ${err.message}`,
    });
  }
}

function writeJsonFile(filePath: any, value: any) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n');
}

const {
  handleProjectInitHarness,
  handleTaskResult,
  handleTaskValidate,
  handleFeatureList,
  handleWaveList,
  handleRunList,
  handleFeatureMark,
  handleMemoryCandidates,
  handleWikiUpdate,
  handleWikiDump,
  handleWikiCandidates,
  handleWikiNightly,
  handleWikiPack,
  handleWikiAudit,
  handleEventEmit,
} = createProjectHarnessHandlers({
  fs,
  path,
  die,
  normalizeText,
  repoRootFromCli,
  resolveProjectDirFlag,
  aceDir,
  readJsonFile,
  writeJsonFile,
  validateCompletionResult,
  describeCommands: () => COMMANDS.map((command: any) => command.cli),
});

const { createMemoryHandlers } = require('./memory-handlers.cjs');
const { handleMemoryRemember } = createMemoryHandlers({
  die,
  normalizeText,
  resolveProjectDirFlag,
});

const { createKnowledgeMigrateHandlers } = require('./knowledge-migrate.cjs');
const { handleKnowledgeMigrate } = createKnowledgeMigrateHandlers({
  die,
  normalizeText,
  resolveProjectDirFlag,
});

const {
  handleWikiBackfill,
  handleWikiGenerate,
  handleWikiWriteback,
  handleWikiCurateEvents,
  handleWikiInbox,
  handleWikiPromote,
  handleWikiHealth,
  handleMemoryStatus,
  handleMemoryExplain,
} = createWikiKnowledgeHandlers({
  die,
  normalizeText,
  resolveProjectDirFlag,
  describeCommands: () => COMMANDS.map((command: any) => command.cli),
});

const WIKI_DUMP_HOOK_COMMANDS = new Set([
  'mission create',
  'mission sync',
  'mission validate',
  'mission gate',
  'mission fixback',
  'mission release-gate',
  'integrate gate',
  'integrate pr-merge',
  'integrate cleanup',
]);

function missionHookProjectDir(flags: any = {}) {
  const projectDir = path.resolve(flags.projectDir || process.env.ACE_PROJECT_DIR || process.cwd());
  const hasDir = fs.existsSync(path.join(projectDir, '.ace'));
  return hasDir ? projectDir : null;
}

function recordProjectWikiDumpHook(command: any, parsed: any, result: any) {
  if (!WIKI_DUMP_HOOK_COMMANDS.has(command.cli)) return;
  const flags = parsed.flags || {};
  const projectDir = missionHookProjectDir(flags);
  if (!projectDir) return;
  try {
    const projectId = flags.workspace || result?.workspaceId || result?.mission?.workspaceId || path.basename(projectDir);
    const missionId = flags.mission || result?.missionId || result?.mission?.missionId || null;
    const featureId = flags.feature || result?.featureId || result?.feature?.id || null;
    const prNumber = flags.pr || result?.pr || result?.prNumber || null;
    const next = result?.nextStep?.next || result?.nextAction || flags.nextAction || null;
    const blocked = result?.blocked || result?.verdict === 'blocked' || result?.status === 'blocked';
    projectWikiCurator.writeDumpRecord({
      projectDir,
      record: {
        kind: command.cli.startsWith('integrate ') ? 'pr_gate' : 'ace_mission',
        identity: 'ace',
        projectId,
        projectName: path.basename(projectDir),
        missionId,
        featureId,
        prNumber,
        source: `ace ${command.cli}`,
        trust: 'self_report',
        title: `ace ${command.cli}`,
        summary: `${command.cli} completed for ${featureId || missionId || prNumber || projectId}`,
        proposedNextActions: next ? [String(next)] : [],
        completedItems: blocked ? [] : [`${command.cli} completed`],
        blockers: blocked ? [result?.reason || result?.message || `${command.cli} blocked`] : [],
        evidence: [`command: ace ${command.cli}`],
      },
    });
  } catch {
    // Wiki dump hooks are observability only and must not change command exit behavior.
  }
}

function inferredToolRole(flags: any = {}, env: any = process.env) {
  const explicit = String(flags.role || env.ACE_ROLE || '').trim().toLowerCase();
  if (explicit) return explicit;

  const agentRole = String(env.ACE_AGENT_ROLE || '').trim().toLowerCase();
  if (agentRole === 'reviewer') return 'validator';
  if (toolContract.ROLES.includes(agentRole)) return agentRole;
  if (agentRole === 'implementer' || agentRole === 'builder') return 'worker';
  if (env.ACE_TASK_ID) return 'worker';
  if (env.ACE_WORKSPACE_ID || env.ACE_STREAM_ID) return 'orchestrator';
  return null;
}

function inferredToolPhase(flags: any = {}, env: any = process.env) {
  const explicit = String(flags.phase || env.ACE_PHASE || '').trim().toLowerCase();
  if (explicit) return explicit;
  return inferredToolRole(flags, env) ? 'start' : null;
}

function toolScopeFromFlags(flags: any = {}, env: any = process.env) {
  return {
    role: inferredToolRole(flags, env),
    phase: inferredToolPhase(flags, env),
    workspaceId: flags.workspace || env.ACE_WORKSPACE_ID || null,
    missionId: flags.mission || env.ACE_MISSION_ID || null,
    taskId: flags.task || env.ACE_TASK_ID || null,
    streamId: flags.stream || env.ACE_STREAM_ID || null,
    runId: flags.run || env.ACE_RUN_ID || null,
    since: flags.since || null,
    windowMs: Number.isFinite(flags.windowMs) ? Number(flags.windowMs) : null,
    projectDir: flags.projectDir || null,
  };
}

async function toolScopeFromFlagsWithWorkspace(client: any, flags: any = {}) {
  const scope = toolScopeFromFlags(flags);
  if (!scope.projectDir && scope.workspaceId && client) {
    const projectDir = await resolveWorkspaceProjectDir(client, scope.workspaceId).catch(() => null);
    if (projectDir) scope.projectDir = projectDir;
  }
  return scope;
}

async function handleToolManifest(parsed: any) {
  const flags = parsed.flags || {};
  const scope = toolScopeFromFlags(flags);
  const manifest = toolContract.manifestFor({
    role: scope.role,
    phase: scope.phase,
    compact: flags.compact === true,
  });
  const proof = toolContract.writeToolUseEvent({
    ...scope,
    command: 'tool manifest',
    ok: true,
    durationMs: 0,
  });
  return { ...manifest, ledgerPath: proof.path || null };
}

async function handleToolHeartbeat(parsed: any) {
  const flags = parsed.flags || {};
  return toolContract.writeToolUseEvent({
    ...toolScopeFromFlags(flags),
    command: 'tool heartbeat',
    ok: true,
    durationMs: 0,
  });
}

async function handleToolAudit(parsed: any, client: any = null) {
  const flags = parsed.flags || {};
  const scope = await toolScopeFromFlagsWithWorkspace(client, flags);
  const audit = toolContract.auditToolUse(scope);
  toolContract.writeToolUseEvent({
    ...scope,
    command: 'tool audit',
    ok: audit.ok,
    error: audit.ok ? null : `missing: ${audit.missingRequiredEvents.join(', ')}`,
    durationMs: 0,
  });
  return audit;
}

function readToolBatchInput(inputRef: any) {
  const source = String(inputRef || '').trim();
  if (!source) {
    const err: any = new Error('--input is required');
    err.code = 'invalid_batch';
    throw err;
  }
  const text = source === '-'
    ? fs.readFileSync(0, 'utf8')
    : source.startsWith('{')
      ? source
      : fs.readFileSync(path.resolve(source), 'utf8');
  try {
    return JSON.parse(text);
  } catch (err) {
    const wrapped: any = new Error(`invalid batch JSON: ${err?.message || String(err)}`);
    wrapped.code = 'invalid_batch';
    throw wrapped;
  }
}

function batchScope(batch: any, parsed: any) {
  const flags = parsed.flags || {};
  const runId = batch.runId || batch.run || flags.run || process.env.ACE_RUN_ID || null;
  return {
    role: batch.role || null,
    phase: batch.phase || null,
    workspaceId: batch.workspaceId || null,
    missionId: batch.missionId || null,
    taskId: batch.taskId || null,
    streamId: batch.streamId || null,
    runId,
    projectDir: flags.projectDir || null,
  };
}

function toolBatchNeedsTransport(batch: any) {
  return (batch.calls || []).some((call: any) => {
    const command = getCommand(call.command);
    if (!command) return false;
    if (command.cli === 'tool manifest' || command.cli === 'tool heartbeat' || command.cli === 'tool audit') return false;
    return !String(command.ipcMethod || '').startsWith('special:') || command.cli === 'mission board' || command.cli === 'mission ready';
  });
}

function batchParsedCall(call: any, batch: any, parsed: any) {
  const args = call.args || {};
  const projectDir = args.projectDir || parsed.flags?.projectDir || null;
  const streamId = args.stream || args.streamId || batch.streamId || process.env.ACE_STREAM_ID || null;
  const workspaceId = args.workspace || args.workspaceId || batch.workspaceId || null;
  const missionId = args.mission || args.missionId || batch.missionId || null;
  const taskId = args.task || args.taskId || batch.taskId || null;
  const runId = args.run || args.runId || batch.runId || batch.run || parsed.flags?.run || process.env.ACE_RUN_ID || null;
  const flags = {
    ...args,
    role: args.role || batch.role || null,
    phase: args.phase || batch.phase || null,
    workspace: workspaceId,
    mission: missionId,
    task: taskId,
    stream: streamId,
    run: runId,
    projectDir,
  };
  const positionals = [];
  if (call.command === 'screen' || call.command === 'state') positionals.push(streamId);
  return { flags, positionals };
}

function batchIpcParams(command: any, call: any, batch: any, parsed: any) {
  const callParsed = batchParsedCall(call, batch, parsed);
  if ((command.cli === 'screen' || command.cli === 'state') && !callParsed.positionals[0]) {
    throw new Error(`${command.cli} requires args.stream or args.streamId`);
  }
  if (command.cli === 'context' && !callParsed.flags.stream) {
    throw new Error('context requires args.stream, args.streamId, or ACE_STREAM_ID');
  }
  return buildIpcParams(command, callParsed);
}

function batchSummary(command: string, result: any) {
  if (command === 'tool heartbeat') return 'heartbeat recorded';
  if (command === 'tool manifest') return 'manifest returned';
  if (command === 'tool audit') return result?.ok === false ? 'audit failed' : 'audit passed';
  if (command === 'context') return 'context resolved';
  if (command === 'mission board') return 'mission board read';
  if (command === 'mission ready') return 'mission ready read';
  if (command === 'ls') return 'streams listed';
  if (command === 'state') return 'state read';
  if (command === 'screen') return 'screen read';
  if (command === 'integrate gate') return 'integration gate inspected';
  if (command === 'run board') return 'run board read';
  if (command === 'run list') return 'runs listed';
  return `${command} ok`;
}

async function runToolBatchCall(client: any, call: any, batch: any, parsed: any) {
  const started = Date.now();
  try {
    const command = getCommand(call.command);
    if (!command) throw new Error(`unknown command: ${call.command}`);
    const callParsed = batchParsedCall(call, batch, parsed);
    let result: any;
    if (command.cli === 'tool heartbeat') {
      result = { written: true };
    } else if (command.cli === 'tool manifest') {
      result = toolContract.manifestFor({
        role: callParsed.flags.role,
        phase: callParsed.flags.phase,
        compact: callParsed.flags.compact !== false,
      });
    } else if (command.cli === 'tool audit') {
      result = toolContract.auditToolUse(toolScopeFromFlags(callParsed.flags));
    } else if (command.cli === 'task result') {
      result = await handleTaskResult(callParsed);
    } else if (command.cli === 'feature list') {
      result = await handleFeatureList(callParsed);
    } else if (command.cli === 'wave list') {
      result = await handleWaveList(callParsed);
    } else if (command.cli === 'run list') {
      result = await handleRunList(callParsed);
    } else {
      if (!client) throw new Error(`${command.cli} requires Ace transport`);
      const params = batchIpcParams(command, call, batch, parsed);
      result = await client.invoke(command.ipcMethod, params);
    }
    if (result && result.ok === false) throw new Error(result.error || 'server returned ok:false');
    return {
      id: call.id,
      command: call.command,
      ok: true,
      durationMs: Date.now() - started,
      summary: batchSummary(command.cli, result),
    };
  } catch (err) {
    return {
      id: call.id,
      command: call.command,
      ok: false,
      isError: true,
      durationMs: Date.now() - started,
      summary: String(err?.message || err).slice(0, 500),
      error: String(err?.message || err).slice(0, 500),
    };
  }
}

async function runLayer(calls: any[], runner: any, parallel: boolean, maxConcurrency: number) {
  if (!parallel || calls.length <= 1) {
    const results = [];
    for (const call of calls) results.push(await runner(call));
    return results;
  }
  const results = new Array(calls.length);
  let next = 0;
  async function worker() {
    while (next < calls.length) {
      const index = next++;
      results[index] = await runner(calls[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(maxConcurrency, calls.length) }, worker));
  return results;
}

async function handleToolBatch(client: any, parsed: any, preloadedInput: any = null) {
  const flags = parsed.flags || {};
  const rawInput = preloadedInput || readToolBatchInput(flags.input);
  const validation = toolContract.validateBatchInput(rawInput);
  const batch = validation.batch;
  const layers = toolContract.dependencyLayers(batch);
  const parallel = flags.parallel === true;
  const maxConcurrency = Math.max(1, Math.round(Number(flags.maxConcurrency || 4)));
  const started = Date.now();
  const results = [];
  for (const layer of layers) {
    const layerResults = await runLayer(layer, (call: any) => runToolBatchCall(client, call, batch, parsed), parallel, maxConcurrency);
    results.push(...layerResults);
  }
  const event = {
    ...batchScope(batch, parsed),
    parallel,
    maxConcurrency,
    durationMs: Date.now() - started,
    results,
    ok: results.every((result: any) => result.ok !== false),
  };
  const proof = toolContract.writeToolBatchResult(event);
  return { ...proof.event, ledgerPath: proof.path || null };
}

function artifactStamp(flags: any = {}) {
  const explicit = normalizeText(flags.run);
  if (explicit) return explicit.replace(/[^A-Za-z0-9_.-]+/g, '-');
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function gitHeadSha(projectDir: string) {
  try {
    const value = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
      cwd: projectDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    });
    return String(value || '').trim() || null;
  } catch {
    return null;
  }
}

function runClawpatch(projectDir: string, args: string[], timeoutMs = 120_000) {
  const { spawnSync } = require('node:child_process');
  const result = spawnSync('clawpatch', args, {
    cwd: projectDir,
    encoding: 'utf8',
    timeout: Math.max(5_000, Math.floor(timeoutMs)),
    maxBuffer: 1024 * 1024,
  });
  return {
    command: `clawpatch ${args.join(' ')}`.trim(),
    ok: result.status === 0,
    status: result.status,
    stdout: String(result.stdout || '').slice(0, 20_000),
    stderr: String(result.stderr || '').slice(0, 20_000),
    error: result.error ? String(result.error.message || result.error) : null,
  };
}

function summarizeFindings(text: string) {
  const out = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const key of Object.keys(out)) {
    const match = text.match(new RegExp(`${key}[^0-9]{0,20}(\\d+)`, 'i'));
    if (match) out[key] = Number(match[1]) || 0;
  }
  return out;
}

async function handleValidationClawpatch(parsed: any, client: any = null) {
  const flags = parsed.flags || {};
  const workspaceProjectDir =
    flags.workspace && client
      ? await resolveWorkspaceProjectDir(client, flags.workspace).catch(() => null)
      : null;
  const projectDir = path.resolve(flags.projectDir || workspaceProjectDir || process.cwd());
  const validatedHeadSha = gitHeadSha(projectDir);
  // Bound --limit so a runaway value can't be forwarded to `clawpatch review`.
  const CLAWPATCH_LIMIT_MAX = 100;
  const limit = Number.isFinite(flags.limit) && flags.limit > 0
    ? Math.min(Math.floor(flags.limit), CLAWPATCH_LIMIT_MAX)
    : 10;
  // Per-command timeout (doctor/init/map/report) keeps the historical 120s default.
  const timeoutMsExplicit = Number.isFinite(flags.timeoutMs) && flags.timeoutMs > 0;
  const timeoutMs = timeoutMsExplicit ? Math.floor(flags.timeoutMs) : 120_000;
  // The `review` step is the slow one. When --timeout-ms is set we honour it
  // exactly (base behavior preserved); when unset we give review a longer 300s
  // budget so a large repo doesn't spuriously time out. Opt-in, additive.
  const reviewTimeoutMs = timeoutMsExplicit ? timeoutMs : 300_000;
  const policy = changeRiskPolicy.classifyChangeRisk({
    taskType: flags.noCode === true ? 'no-code' : undefined,
    roleMode: flags.noCode === true ? 'no-code' : undefined,
    taskClass: flags.riskClass || undefined,
    goal: flags.noCode === true ? 'no-code smoke diagnostic' : '',
    context: flags.riskClass ? `risk-class:${flags.riskClass}` : '',
    explicitClawpatchRequired: flags.required === true,
    clawpatchRiskRequired: ['high', 'medium'].includes(flags.riskClass),
  });
  const riskClass = flags.riskClass || policy.riskClass;
  const required = flags.required === true || ['high', 'medium'].includes(flags.riskClass) || policy.clawpatchRequired === true;
  if (!required) {
    const stamp = artifactStamp(flags);
    const validationDir = path.join(aceDir(projectDir), 'validation', 'clawpatch');
    fs.mkdirSync(validationDir, { recursive: true });
    const artifactPath = path.join(validationDir, `${stamp}.json`);
    const artifact = {
      schema: toolContract.CLAWPATCH_SCHEMA,
      validatedHeadSha,
      required: false,
      skipped: true,
      reason: 'risk-policy-not-required',
      riskClass,
      status: 'skipped',
      doctorOk: null,
      commandsRun: [],
      stateDir: '.clawpatch',
      reportPath: null,
      findings: { critical: 0, high: 0, medium: 0, low: 0 },
      blockingFindings: [],
      blockedReason: null,
      projectDir,
      workspaceId: flags.workspace || null,
      timeoutMs,
      runId: flags.run || null,
      taskId: flags.task || null,
      missionId: flags.mission || null,
      featureId: flags.feature || null,
      waveId: flags.wave || null,
      evidence: [],
      artifactPath,
      markdownPath: null,
    };
    writeJsonFile(artifactPath, artifact);
    toolContract.writeToolUseEvent({
      projectDir,
      command: 'validation clawpatch',
      role: 'orchestrator',
      phase: flags.wave ? 'gate' : 'validate',
      missionId: flags.mission || null,
      taskId: flags.task || null,
      ok: true,
      error: null,
      durationMs: 0,
    });
    return artifact;
  }
  const commandsRun = [];
  const evidence = [];
  let status = 'pass';
  let doctorOk = false;
  let blockedReason = null;

  const doctor = runClawpatch(projectDir, ['doctor'], timeoutMs);
  commandsRun.push(doctor.command);
  evidence.push({ command: doctor.command, ok: doctor.ok, status: doctor.status, stdout: doctor.stdout, stderr: doctor.stderr, error: doctor.error });
  doctorOk = doctor.ok;
  // Advisory-only version note. Recommend clawpatch@0.5.0 for the best review
  // signal but NEVER auto-install or block on it. Purely informational —
  // recorded on the artifact as `clawpatchVersion` + `versionAdvisory`.
  const RECOMMENDED_CLAWPATCH_VERSION = '0.5.0';
  const versionMatch = `${doctor.stdout || ''}\n${doctor.stderr || ''}`.match(
    /clawpatch[^0-9]{0,20}v?(\d+\.\d+\.\d+)/i
  );
  const clawpatchVersion = versionMatch ? versionMatch[1] : null;
  const versionAdvisory =
    clawpatchVersion === RECOMMENDED_CLAWPATCH_VERSION
      ? null
      : `advisory: recommend clawpatch@${RECOMMENDED_CLAWPATCH_VERSION}${clawpatchVersion ? ` (detected ${clawpatchVersion})` : ' (version not detected)'}; not auto-installing — run \`npm install -g clawpatch@${RECOMMENDED_CLAWPATCH_VERSION}\` if desired`;
  if (!doctor.ok) {
    status = 'blocked';
    blockedReason = 'Clawpatch validation required for this long/wave task, but clawpatch is not installed or clawpatch doctor failed. Install/check: npm install -g clawpatch && clawpatch doctor';
  } else {
    if (!fs.existsSync(path.join(projectDir, '.clawpatch'))) {
      const init = runClawpatch(projectDir, ['init'], timeoutMs);
      commandsRun.push(init.command);
      evidence.push({ command: init.command, ok: init.ok, status: init.status, stdout: init.stdout, stderr: init.stderr, error: init.error });
      if (!init.ok) {
        status = 'blocked';
        blockedReason = 'clawpatch init failed';
      }
    }
    if (status !== 'blocked') {
      const commandArgs = [['map'], ['review', '--limit', String(limit)]];
      if (flags.report === true) commandArgs.push(['report']);
      for (const args of commandArgs) {
        // The slow review step gets the (longer-by-default) review budget;
        // every other clawpatch command keeps the historical per-command timeout.
        const perCommandTimeout = args[0] === 'review' ? reviewTimeoutMs : timeoutMs;
        const result = runClawpatch(projectDir, args, perCommandTimeout);
        commandsRun.push(result.command);
        evidence.push({ command: result.command, ok: result.ok, status: result.status, stdout: result.stdout, stderr: result.stderr, error: result.error });
        if (!result.ok) {
          status = 'fail';
          blockedReason = `${result.command} failed`;
          break;
        }
      }
    }
  }

  const reportPath = path.join(projectDir, '.clawpatch', 'report.md');
  const reportText = fs.existsSync(reportPath)
    ? fs.readFileSync(reportPath, 'utf8').slice(0, 40_000)
    : evidence.map((item: any) => `${item.command}\n${item.stdout}\n${item.stderr}`).join('\n\n');
  const findings = summarizeFindings(reportText);
  const blockingFindings = [];
  if (findings.critical > 0) blockingFindings.push({ severity: 'critical', count: findings.critical });
  if (findings.high > 0) blockingFindings.push({ severity: 'high', count: findings.high });
  if (blockingFindings.length > 0) status = 'fail';

  const stamp = artifactStamp(flags);
  const validationDir = path.join(aceDir(projectDir), 'validation', 'clawpatch');
  fs.mkdirSync(validationDir, { recursive: true });
  const artifactPath = path.join(validationDir, `${stamp}.json`);
  const markdownPath = path.join(validationDir, `${stamp}.md`);
  const artifact = {
    schema: toolContract.CLAWPATCH_SCHEMA,
    validatedHeadSha,
    required: true,
    doctorOk,
    commandsRun,
    stateDir: '.clawpatch',
    reportPath: fs.existsSync(reportPath) ? '.clawpatch/report.md' : null,
    findings,
    blockingFindings,
    status,
    blockedReason,
    projectDir,
    timeoutMs,
    reviewTimeoutMs,
    limit,
    clawpatchVersion,
    recommendedVersion: RECOMMENDED_CLAWPATCH_VERSION,
    versionAdvisory,
    runId: flags.run || null,
    taskId: flags.task || null,
    missionId: flags.mission || null,
    featureId: flags.feature || null,
    waveId: flags.wave || null,
    evidence,
    artifactPath,
    markdownPath,
  };
  writeJsonFile(artifactPath, artifact);
  fs.writeFileSync(markdownPath, reportText || `# Clawpatch validation\n\nStatus: ${status}\n`);
  toolContract.writeToolUseEvent({
    projectDir,
    command: 'validation clawpatch',
    role: 'orchestrator',
    phase: flags.wave ? 'gate' : 'validate',
    missionId: flags.mission || null,
    taskId: flags.task || null,
    ok: status === 'pass',
    error: status === 'pass' ? null : blockedReason || `clawpatch ${status}`,
    durationMs: 0,
  });
  return artifact;
}

function buildFilteredRegistry(sourceRegistry: any, predicate: any) {
  // Wrap the underlying registry with a workspace filter so the supervisor
  // sees only the rows for one workspace without us having to copy state.
  return {
    list() {
      return sourceRegistry.list().filter(predicate);
    },
    updatePrState(taskId: any, patch: any) {
      return sourceRegistry.updatePrState(taskId, patch);
    },
    register(row: any) {
      return sourceRegistry.register(row);
    },
    get(taskId: any) {
      return sourceRegistry.get(taskId);
    },
    remove(taskId: any) {
      return sourceRegistry.remove(taskId);
    },
  };
}

function normalizeBranchName(value: any) {
  const text = String(value == null ? '' : value).trim();
  return text || null;
}

function isGitRepoCwd(value: any) {
  const candidate = normalizeText(value);
  if (!candidate) return false;
  try {
    const stat = fs.statSync(candidate);
    if (!stat.isDirectory()) return false;
    return fs.existsSync(path.join(candidate, '.git'));
  } catch {
    return false;
  }
}

function resolveSuperviseBaseBranch(rows: any, env: any = process.env) {
  const envBase = normalizeBranchName(env.ACE_BASE_BRANCH);
  if (envBase) return envBase;
  const rowBases = Array.from(
    new Set(
      (Array.isArray(rows) ? rows : [])
        .map((row: any) => normalizeBranchName(row?.baseBranch))
        .filter(Boolean)
    )
  );
  return rowBases.length === 1 ? rowBases[0] : 'main';
}

function resolveSuperviseCwd(rows: any, env: any = process.env) {
  const candidates = [
    env.ACE_REPO_ROOT,
    env.ACE_WORKTREE_PATH,
    ...(Array.isArray(rows) ? rows.map((row: any) => row?.worktreePath) : []),
    process.cwd(),
  ];
  for (const candidate of candidates) {
    if (isGitRepoCwd(candidate)) return normalizeText(candidate);
  }
  return null;
}

function stalePatch(row: any) {
  return {
    prState: row.prState || 'stale',
    staleClassification: row.classification || 'stale',
    staleReason: row.reason || null,
    stalePrState: row.prState || null,
    previousPrState: row.previousPrState || null,
    closedAt: row.closedAt || null,
    mergedAt: row.mergedAt || null,
    expectedBaseBranch: row.expectedBaseBranch || null,
  };
}

function applyStaleRows(rows: any, staleRows: any, registry: any) {
  if (!Array.isArray(staleRows) || staleRows.length === 0) return rows;
  const byTaskId = new Map(staleRows.map((row: any) => [row.taskId, row]));
  for (const stale of staleRows) {
    try {
      registry.updatePrState(stale.taskId, stalePatch(stale));
    } catch {
      // Keep supervise best-effort: rows may be edited by another process.
    }
  }
  return rows.map((row: any) => {
    const stale = byTaskId.get(row.taskId);
    return stale ? { ...row, ...stalePatch(stale) } : row;
  });
}

function closeoutText(value: any) {
  const text = String(value ?? '').trim();
  return text || null;
}

function closeoutObject(value: any) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function closeoutArray(value: any) {
  return Array.isArray(value) ? value : [];
}

function closeoutUnique(values: any[]) {
  return Array.from(new Set(values.map((value) => closeoutText(value)).filter(Boolean)));
}

function closeoutPrNumber(value: any, url: any = null) {
  const direct = Number(value);
  if (Number.isInteger(direct) && direct > 0) return direct;
  const match = String(url || '').match(/\/pull\/([1-9]\d*)(?:\b|$)/);
  return match ? Number(match[1]) : null;
}

function closeoutGithubRepoKey(url: any) {
  const text = closeoutText(url);
  if (!text) return null;
  const match = text.match(/github\.com[:/]([^/\s]+)\/([^/\s#?]+?)(?:\.git)?(?:\/|$)/i);
  if (!match) return null;
  return `${match[1].toLowerCase()}/${match[2].replace(/\.git$/i, '').toLowerCase()}`;
}

function closeoutFindCard(board: any, runId: any) {
  const id = String(runId || '').trim();
  return closeoutArray(board?.cards).find((card: any) => String(card?.id || '') === id) || null;
}

function closeoutReadChildRows() {
  try {
    const registry = createChildRegistryStore({
      db: createChildRegistryFileDb(defaultChildRegistryStorePath()),
    });
    return registry.list();
  } catch {
    return [];
  }
}

function closeoutFindChildRow(card: any, rows: any[]) {
  const detail = closeoutObject(card?.detail);
  const worker = closeoutObject(detail.worker);
  const pr = closeoutObject(detail.pr);
  const taskId = closeoutText(worker.taskId);
  const branch = closeoutText(worker.branch || card?.branch);
  const prNumber = closeoutPrNumber(pr.number, pr.url || card?.prUrl);
  return closeoutArray(rows).find((row: any) => {
    if (taskId && row?.taskId === taskId) return true;
    if (branch && row?.branch === branch) return true;
    if (prNumber != null && Number(row?.prNumber) === prNumber) return true;
    return false;
  }) || null;
}

function closeoutIdentity({ runId, card, row, flags }: any) {
  const detail = closeoutObject(card?.detail);
  const worker = closeoutObject(detail.worker);
  const validator = closeoutObject(detail.validator);
  const pr = closeoutObject(detail.pr);
  const allowOverride = closeoutArray(flags.allowPath);
  const allowedPaths = allowOverride.length
    ? allowOverride
    : closeoutArray(row?.allowedPaths).length
      ? row.allowedPaths
      : closeoutArray(pr.allowedPaths);
  const prUrl = closeoutText(pr.url || row?.prUrl || card?.prUrl);
  return {
    runId: String(runId),
    workspaceId: closeoutText(worker.workspaceId || row?.workspaceId || card?.workspaceId),
    taskId: closeoutText(worker.taskId || row?.taskId),
    workerStreamId: closeoutText(worker.streamId || row?.streamId),
    validatorTaskId: closeoutText(validator.taskId || row?.validatorTaskId),
    validatorStreamId: closeoutText(validator.streamId || row?.validatorStreamId),
    branch: closeoutText(worker.branch || row?.branch || card?.branch),
    baseBranch: closeoutText(pr.baseBranch || row?.baseBranch),
    worktreePath: closeoutText(worker.worktreePath || row?.worktreePath),
    prNumber: closeoutPrNumber(pr.number || row?.prNumber, prUrl),
    prUrl,
    allowedPaths,
    projection: {
      stage: card?.stage || null,
      nextAction: card?.nextAction || null,
      workerOutcome: worker.outcome || card?.workerOutcome || null,
      validationStatus: validator.outcome || card?.validationStatus || null,
      pr: {
        number: pr.number ?? null,
        url: pr.url || card?.prUrl || null,
        state: pr.state || card?.prStatus || null,
        headSha: pr.headSha || null,
        checkState: pr.checkState || null,
        mergeable: pr.mergeable || null,
      },
    },
    autoship: closeoutObject(detail.autoship),
  };
}

async function closeoutStreamSnapshot(client: any, streamId: any) {
  const id = closeoutText(streamId);
  if (!id) return null;
  const snapshot: any = { streamId: id, state: null, text: '', terminalTrailer: null, errors: [] };
  try {
    const state = await client.invoke('streamGetState', { streamId: id });
    snapshot.state = state?.state || state?.result?.state || null;
  } catch (err: any) {
    snapshot.errors.push(err?.message || String(err));
  }
  try {
    const screen = await client.invoke('streamReadScreen', { streamId: id, tail: 8000 });
    snapshot.text = String(screen?.text || screen?.result?.text || '');
    const trailers = listTerminalTrailers(snapshot.text);
    snapshot.terminalTrailer = trailers.length ? trailers[trailers.length - 1] : null;
  } catch (err: any) {
    snapshot.errors.push(err?.message || String(err));
  }
  return snapshot;
}

function closeoutWorkerDone(identity: any, workerSnapshot: any) {
  const projected = String(identity.projection.workerOutcome || '').toUpperCase();
  const terminal = workerSnapshot?.terminalTrailer;
  if (projected === 'DONE') return true;
  return terminal?.kind === 'done';
}

function closeoutWorkerBlocked(identity: any, workerSnapshot: any) {
  const projected = String(identity.projection.workerOutcome || '').toUpperCase();
  const terminal = workerSnapshot?.terminalTrailer;
  if (projected === 'BLOCKED') return true;
  return terminal?.kind === 'blocked';
}

function closeoutGateResult(envelope: any, identity: any = {}) {
  const result = closeoutObject(envelope?.result || envelope);
  const gate = closeoutObject(result.gate || result.mergeGate || result);
  const pr = closeoutObject(result.pr || result.pullRequest || gate.pr);
  const headSha = closeoutText(
    pr.headSha ||
      pr.headRefOid ||
      gate.actualHeadSha ||
      gate.headSha ||
      result.headSha ||
      identity.projection?.pr?.headSha
  );
  const prUrl = closeoutText(pr.url || result.prUrl || identity.prUrl);
  const prNumber = closeoutPrNumber(pr.number ?? result.prNumber ?? identity.prNumber, prUrl);
  const failures = [
    ...closeoutArray(gate.failures),
    ...closeoutArray(result.failures),
    ...closeoutArray(result.blockers),
  ].map((failure: any) => {
    const object = typeof failure === 'object' && failure != null ? failure : { code: failure };
    return {
      code: closeoutText(object.code || object.reason || object.id) || 'gate_blocked',
      message: closeoutText(object.message || object.detail || object.reason) || null,
      actual: object.actual ?? null,
      expected: object.expected ?? null,
      unexpectedFiles: closeoutArray(object.unexpectedFiles),
    };
  });
  const ok =
    gate.ok === true ||
    gate.readyToMerge === true ||
    result.status === 'PASS' ||
    result.status === 'MERGE_READY';
  return {
    envelope,
    result,
    gate,
    pr: {
      number: prNumber,
      url: prUrl,
      repository: closeoutGithubRepoKey(prUrl),
      state: closeoutText(pr.state || result.prState || gate.prState),
      isDraft: pr.isDraft === true || pr.draft === true || result.isDraft === true,
      headRefName: closeoutText(pr.headRefName || pr.headBranch || result.headBranch || gate.headBranch),
      baseRefName: closeoutText(pr.baseRefName || pr.baseBranch || result.baseBranch || gate.baseBranch),
      headSha,
      baseSha: closeoutText(pr.baseSha || pr.baseRefOid || result.baseSha || gate.baseSha),
      checkState: closeoutText(pr.checkState || result.checkState || gate.checkState),
      mergeable: closeoutText(pr.mergeable || result.mergeable || gate.mergeable),
      files: closeoutArray(pr.files || pr.changedFiles || result.files || result.changedFiles || gate.changedFiles),
      checks: closeoutArray(pr.checks || pr.statusCheckRollup || result.checks || result.statusCheckRollup || gate.checks || gate.statusCheckRollup),
    },
    validation: closeoutObject(result.validation || gate.validation),
    allowedPaths: closeoutArray(result.allowedPaths || gate.allowedPaths || identity.allowedPaths),
    failures,
    ok,
    status: closeoutText(result.status || gate.status) || (ok ? 'PASS' : 'BLOCKED'),
  };
}

async function closeoutRunGate(client: any, identity: any) {
  if (!identity.taskId || identity.prNumber == null) {
    return {
      ok: false,
      error: 'run identity is missing task id or PR number',
      failures: [{ code: 'run_identity_incomplete', message: 'run closeout requires taskId and prNumber before gate' }],
      pr: { number: identity.prNumber, url: identity.prUrl, headSha: null },
    };
  }
  const envelope = await client.invoke('integrationGate', {
    taskId: identity.taskId,
    prNumber: identity.prNumber,
    branch: identity.branch || undefined,
    allowedPaths: identity.allowedPaths || [],
  });
  return closeoutGateResult(envelope, identity);
}

function closeoutValidationFromText(textValue: any, expectedHeadSha: any) {
  const detail = String(textValue || '').trim();
  const parsed = parseValidatorRecordVerdict({ detail });
  const object = parsed?.packetInput || parseVerdictJsonObject(detail) || {};
  const verdict = parsed?.verdict || null;
  const validatedHeadSha = closeoutText(
    object.validatedHeadSha ||
      object.validated_head_sha ||
      object.headSha ||
      object.prHeadSha ||
      object.currentHeadSha
  );
  const expected = closeoutText(expectedHeadSha);
  return {
    verdict,
    packetInput: object,
    detail,
    scorecard: parsed?.scorecard || [],
    validatedHeadSha,
    exactHead: Boolean(expected && validatedHeadSha && validatedHeadSha === expected),
  };
}

function closeoutValidationFromSnapshot(snapshot: any, expectedHeadSha: any) {
  if (!snapshot) return null;
  const terminal = snapshot.terminalTrailer;
  if (terminal?.detail) return closeoutValidationFromText(terminal.detail, expectedHeadSha);
  if (snapshot.text) return closeoutValidationFromText(snapshot.text, expectedHeadSha);
  return null;
}

function closeoutValidationPrompt(identity: any, gate: any) {
  const pr = gate.pr || {};
  return [
    `Ace run closeout validation for ${identity.runId}.`,
    `Validate the exact current PR head ${pr.headSha || 'UNKNOWN_HEAD'} for PR ${pr.url || identity.prUrl || identity.prNumber}.`,
    'Do not modify files. Do not merge. Review only the current PR diff, checks, and acceptance.',
    'End with exactly one trailer:',
    'DONE: VERDICT=pass {"verdict":"pass","validatedHeadSha":"<exact head sha>","scorecard":[{"id":"A1","met":true,"evidence":"<pointer>"}]}',
    'DONE: VERDICT=request-changes {"verdict":"request-changes","validatedHeadSha":"<exact head sha>","failingChecks":["<check>"],"failingFiles":["<path>"],"actual":"<what failed>"}',
    'BLOCKED: VERDICT=block — <reason validation could not be completed>',
  ].join('\n');
}

function closeoutValidationFailurePacket(identity: any, validation: any, gate: any, round: number) {
  const input = closeoutObject(validation?.packetInput);
  const findings = closeoutArray(input.findings);
  const failingChecks = closeoutUnique([
    ...closeoutArray(input.failingChecks || input.failing_checks),
    ...findings.map((finding: any) => (typeof finding === 'string' ? finding : finding?.criterion || finding?.status)),
  ]);
  const failingFiles = closeoutUnique(input.failingFiles || input.failing_files || input.files || []);
  return normalizeValidationFailurePacket({
    status: validation?.verdict === 'block' ? 'BLOCKED' : 'FAIL',
    verdict: validation?.verdict === 'block' ? 'block' : 'request-changes',
    round,
    taskId: identity.taskId,
    streamId: identity.workerStreamId,
    worktreePath: identity.worktreePath,
    prUrl: gate.pr.url || identity.prUrl,
    prNumber: gate.pr.number || identity.prNumber,
    branch: gate.pr.headRefName || identity.branch,
    baseBranch: gate.pr.baseRefName || identity.baseBranch,
    blockerReasons: validation?.verdict === 'block' ? ['validation_blocked'] : ['validation_failed'],
    evidence: [
      validation?.validatedHeadSha ? `validatedHeadSha=${validation.validatedHeadSha}` : null,
      gate.pr.headSha ? `currentHeadSha=${gate.pr.headSha}` : null,
    ].filter(Boolean),
    failingChecks,
    failingFiles,
    expected: input.expected || input.expectedBehavior || 'All closeout acceptance passes at the current PR head.',
    actual: input.actual || input.actualBehavior || validation?.detail || 'Validator requested changes.',
    rootCause: input.rootCause || input.root_cause || null,
    reproduction: input.reproduction || input.reproductionCommands || input.reproduction_commands || [],
  });
}

function closeoutFailureScope(identity: any, packet: any, gate: any) {
  const changedFiles = packet.failingFiles && packet.failingFiles.length
    ? packet.failingFiles
    : gate.pr.files;
  return evaluatePrScope({ allowedPaths: identity.allowedPaths || [], changedFiles });
}

function closeoutSafeFixback(identity: any, packet: any, gate: any) {
  const blockers = [];
  if (!identity.workerStreamId) blockers.push({ code: 'worker_stream_missing', message: 'cannot send same-worker fixback without worker stream id' });
  if (!identity.taskId) blockers.push({ code: 'task_id_missing', message: 'cannot send fixback without task id' });
  if (!identity.worktreePath) blockers.push({ code: 'worktree_missing', message: 'cannot prove same worktree for fixback' });
  const currentBranch = gate.pr.headRefName || identity.branch;
  if (!identity.branch || !currentBranch || identity.branch !== currentBranch) {
    blockers.push({
      code: 'branch_mismatch',
      message: 'fixback must stay on the same worker branch',
      actual: currentBranch || null,
      expected: identity.branch || null,
    });
  }
  const scope = closeoutFailureScope(identity, packet, gate);
  if (!scope.ok) {
    blockers.push({
      code: scope.code || 'scope_contamination',
      message: scope.message || 'validation failure is outside allowed scope',
      unexpectedFiles: scope.unexpectedFiles || [],
    });
  }
  if (packet.status === 'BLOCKED') {
    blockers.push({ code: 'validation_blocked', message: 'validator blocked instead of requesting in-scope code changes' });
  }
  return { safe: blockers.length === 0, blockers, scope };
}

function closeoutContextBlockers(identity: any, gate: any) {
  const pr = gate?.pr || {};
  const blockers = [];
  if (identity.prNumber != null && pr.number != null && Number(identity.prNumber) !== Number(pr.number)) {
    blockers.push({
      code: 'wrong_pr',
      message: 'current PR number does not match the run identity',
      actual: pr.number,
      expected: identity.prNumber,
    });
  }
  const expectedRepo = closeoutGithubRepoKey(identity.prUrl);
  const actualRepo = closeoutGithubRepoKey(pr.url);
  if (expectedRepo && actualRepo && expectedRepo !== actualRepo) {
    blockers.push({
      code: 'wrong_github_repo',
      message: 'current PR repository does not match the worker PR repository',
      actual: actualRepo,
      expected: expectedRepo,
    });
  }
  if (identity.branch && pr.headRefName && identity.branch !== pr.headRefName) {
    blockers.push({
      code: 'wrong_branch',
      message: 'current PR head branch does not match the worker branch',
      actual: pr.headRefName,
      expected: identity.branch,
    });
  }
  if (identity.baseBranch && pr.baseRefName && identity.baseBranch !== pr.baseRefName) {
    blockers.push({
      code: 'wrong_base_branch',
      message: 'current PR base branch does not match the worker base branch',
      actual: pr.baseRefName,
      expected: identity.baseBranch,
    });
  }
  return blockers;
}

function closeoutNormalizeCheckState(value: any) {
  const state = String(value || '').trim().toLowerCase().replace(/[_\s]+/g, '-');
  if (!state) return null;
  if (['success', 'succeeded', 'pass', 'passed', 'ok', 'neutral', 'skipped'].includes(state)) return 'success';
  if (['pending', 'queued', 'in-progress', 'in-progress', 'requested', 'waiting', 'expected'].includes(state)) return 'pending';
  if (['cancelled', 'canceled'].includes(state)) return 'cancelled';
  if (['failure', 'failed', 'fail', 'error', 'errored', 'timed-out', 'timeout', 'action-required'].includes(state)) return 'failure';
  if (/cancel/.test(state)) return 'cancelled';
  if (/pending|queued|progress|waiting|requested/.test(state)) return 'pending';
  if (/fail|error|timed?-?out|required/.test(state)) return 'failure';
  return state;
}

function closeoutNormalizeCheck(check: any, index = 0) {
  const object = closeoutObject(check);
  const name =
    closeoutText(object.name || object.context || object.workflowName || object.workflow || object.title || object.app?.name) ||
    `check-${index + 1}`;
  const rawState = object.state || object.status || object.conclusion || object.result || object.outcome;
  return {
    name,
    state: closeoutNormalizeCheckState(rawState),
    rawState: rawState == null ? null : String(rawState),
    url: closeoutText(object.url || object.targetUrl || object.target_url || object.detailsUrl || object.details_url || object.htmlUrl || object.html_url),
  };
}

function closeoutParseChecksText(textValue: any) {
  const checks: any[] = [];
  for (const line of String(textValue || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || /^[-\s]+$/.test(trimmed) || /^name\s+/i.test(trimmed)) continue;
    const tabParts = trimmed.split(/\t+/).map((part) => part.trim()).filter(Boolean);
    const parts = tabParts.length > 1 ? tabParts : trimmed.split(/\s{2,}/).map((part) => part.trim()).filter(Boolean);
    if (parts.length < 2) continue;
    const url = parts.find((part) => /^https?:\/\//i.test(part));
    checks.push(closeoutNormalizeCheck({
      name: parts[0],
      state: parts[1],
      url,
    }, checks.length));
  }
  return checks;
}

function closeoutChecksFromEnvelope(envelope: any, gate: any) {
  const result = closeoutObject(envelope?.result || envelope);
  const direct = [
    ...closeoutArray(result.checks),
    ...closeoutArray(result.checkRuns),
    ...closeoutArray(result.statusCheckRollup),
    ...closeoutArray(result.pr?.checks),
    ...closeoutArray(result.pr?.statusCheckRollup),
    ...closeoutArray(gate?.pr?.checks),
  ];
  const parsed = closeoutParseChecksText(`${result.stdout || ''}\n${result.stderr || ''}`);
  return [...direct.map((check: any, index: number) => closeoutNormalizeCheck(check, index)), ...parsed];
}

function closeoutRollupCiState(checks: any[], fallback: any, envelope: any) {
  const states = closeoutArray(checks).map((check: any) => closeoutNormalizeCheckState(check.state)).filter(Boolean);
  if (states.includes('cancelled')) return 'cancelled';
  if (states.includes('failure')) return 'failure';
  if (states.includes('pending')) return 'pending';
  if (states.length && states.every((state: any) => state === 'success')) return 'success';
  const fallbackState = closeoutNormalizeCheckState(fallback);
  if (fallbackState) return fallbackState;
  const phase = closeoutNormalizeCheckState(envelope?.phase);
  if (phase) return phase;
  if (envelope?.ok === false) return 'failure';
  return null;
}

function closeoutCiSnapshot(envelope: any, gate: any, expectedHeadSha: any) {
  const result = closeoutObject(envelope?.result || envelope);
  const checks = closeoutChecksFromEnvelope(envelope, gate);
  const headSha = closeoutText(result.headSha || result.pr?.headSha || expectedHeadSha);
  const expected = closeoutText(expectedHeadSha);
  return {
    schema: 'ace.ci_snapshot.v1',
    source: 'integrationPollChecks',
    prNumber: result.prNumber ?? result.pr?.number ?? gate?.pr?.number ?? null,
    prUrl: result.prUrl || result.pr?.url || gate?.pr?.url || null,
    branch: result.branch || result.pr?.headRefName || gate?.pr?.headRefName || null,
    headSha,
    expectedHeadSha: expected,
    exactHead: Boolean(expected && headSha && expected === headSha),
    state: closeoutRollupCiState(checks, result.checkState || result.state || gate?.pr?.checkState, envelope),
    checks,
    raw: {
      ok: envelope?.ok ?? null,
      phase: envelope?.phase || null,
      code: result.code ?? null,
      attempts: result.attempts ?? null,
      elapsedMs: result.elapsedMs ?? null,
      stdout: closeoutText(result.stdout)?.slice(0, 4000) || null,
      stderr: closeoutText(result.stderr)?.slice(0, 4000) || null,
    },
  };
}

async function closeoutWatchCi(client: any, identity: any, gate: any, flags: any, actions: any[], dryRun: boolean) {
  const contextBlockers = closeoutContextBlockers(identity, gate);
  if (contextBlockers.length) {
    return { ok: false, gate, ci: closeoutCiSnapshot({ ok: null, phase: 'blocked', result: { checkState: gate.pr?.checkState } }, gate, gate.pr?.headSha), blockers: contextBlockers };
  }
  if (dryRun) {
    actions.push({ type: 'would_watch_ci', via: 'integrationPollChecks', mutation: null, prNumber: identity.prNumber, headSha: gate.pr?.headSha });
    return {
      ok: false,
      gate,
      ci: closeoutCiSnapshot({ ok: null, phase: 'dry-run', result: { checkState: gate.pr?.checkState } }, gate, gate.pr?.headSha),
      blockers: [{ code: 'dry_run', message: 'dry-run did not watch required CI' }],
    };
  }
  actions.push({ type: 'watch_ci', via: 'integrationPollChecks', mutation: null, taskId: identity.taskId, prNumber: identity.prNumber, headSha: gate.pr?.headSha });
  const poll = await client.invoke('integrationPollChecks', {
    taskId: identity.taskId,
    prNumber: identity.prNumber,
    branch: gate.pr?.headRefName || identity.branch || undefined,
    timeoutMs: flags.timeout,
  });
  let ci = closeoutCiSnapshot(poll, gate, gate.pr?.headSha);
  actions.push({ type: 'read_integration_gate_after_ci', via: 'integrationGate', mutation: null, taskId: identity.taskId, prNumber: identity.prNumber });
  const verifiedGate = await closeoutRunGate(client, identity);
  const verifyBlockers = closeoutContextBlockers(identity, verifiedGate);
  if (gate.pr?.headSha && verifiedGate.pr?.headSha && gate.pr.headSha !== verifiedGate.pr.headSha) {
    verifyBlockers.push({
      code: 'ci_head_changed',
      message: 'PR head changed while CI was being watched; rerun closeout for the new exact head',
      actual: verifiedGate.pr.headSha,
      expected: gate.pr.headSha,
    });
  }
  ci = {
    ...ci,
    headSha: ci.headSha || verifiedGate.pr?.headSha || gate.pr?.headSha || null,
    exactHead: Boolean(gate.pr?.headSha && verifiedGate.pr?.headSha && gate.pr.headSha === verifiedGate.pr.headSha),
    verifiedPr: {
      number: verifiedGate.pr?.number ?? null,
      url: verifiedGate.pr?.url || null,
      branch: verifiedGate.pr?.headRefName || null,
      headSha: verifiedGate.pr?.headSha || null,
    },
  };
  if (verifyBlockers.length) return { ok: false, gate: verifiedGate, ci, blockers: verifyBlockers };
  if (ci.state === 'success') return { ok: true, gate: verifiedGate, ci, blockers: [] };
  return { ok: false, gate: verifiedGate, ci, blockers: [] };
}

function closeoutCiFailureKind(ci: any) {
  const body = [
    ci?.state,
    ci?.raw?.stdout,
    ci?.raw?.stderr,
    ...closeoutArray(ci?.checks).flatMap((check: any) => [check.name, check.state, check.rawState, check.url]),
  ].map((part: any) => String(part || '')).join('\n');
  if (ci?.state === 'pending') {
    return { fixable: false, code: 'ci_pending', message: 'required CI is still pending' };
  }
  if (ci?.state === 'cancelled' || /\bcancell?ed\b/i.test(body)) {
    return { fixable: false, code: 'ci_cancelled', message: 'required CI was cancelled' };
  }
  if (/unauthori[sz]ed|authentication required|bad credentials|forbidden|insufficient permission|not authorized|resource not accessible|HTTP\s+(?:401|403)|gh auth login|credential|secret|token/i.test(body)) {
    return { fixable: false, code: 'ci_permission_blocked', message: 'CI failure appears to be credentials or permissions related' };
  }
  if (/outage|incident|service unavailable|rate limit|network|runner.*(?:lost|offline|unavailable)|infrastructure|capacity|no space left|hosted runner/i.test(body)) {
    return { fixable: false, code: 'ci_infra_blocked', message: 'CI failure appears to be infrastructure or external outage related' };
  }
  return { fixable: true, code: 'ci_checks_failed', message: 'required CI checks failed' };
}

function closeoutCiFailurePacket(identity: any, ci: any, gate: any, round: number) {
  const kind = closeoutCiFailureKind(ci);
  const failedChecks = closeoutArray(ci?.checks)
    .filter((check: any) => closeoutNormalizeCheckState(check.state) !== 'success')
    .map((check: any) => check.url ? `${check.name} (${check.state}) ${check.url}` : `${check.name} (${check.state || 'unknown'})`);
  return normalizeValidationFailurePacket({
    status: kind.fixable ? 'FAIL' : 'BLOCKED',
    verdict: kind.fixable ? 'request-changes' : 'block',
    round,
    taskId: identity.taskId,
    streamId: identity.workerStreamId,
    worktreePath: identity.worktreePath,
    prUrl: gate.pr.url || identity.prUrl,
    prNumber: gate.pr.number || identity.prNumber,
    branch: gate.pr.headRefName || identity.branch,
    baseBranch: gate.pr.baseRefName || identity.baseBranch,
    blockerReasons: [{ code: kind.code, message: kind.message }],
    evidence: [
      `ciState=${ci?.state || 'unknown'}`,
      gate.pr.headSha ? `currentHeadSha=${gate.pr.headSha}` : null,
      ...closeoutArray(ci?.checks).map((check: any) => check.url ? `${check.name}: ${check.state} ${check.url}` : `${check.name}: ${check.state || 'unknown'}`),
    ].filter(Boolean),
    failingChecks: failedChecks.length ? failedChecks : [kind.message],
    failingFiles: kind.fixable ? gate.pr.files : [],
    expected: 'Required CI checks pass on the exact current PR head.',
    actual: kind.message,
    reproduction: [`ace --json run closeout --run ${identity.runId}`],
  });
}

function closeoutCiSafeFixback(identity: any, packet: any, gate: any, ci: any) {
  const kind = closeoutCiFailureKind(ci);
  if (!kind.fixable) {
    return { safe: false, blockers: [{ code: kind.code, message: kind.message }], scope: null };
  }
  return closeoutSafeFixback(identity, packet, gate);
}

function closeoutFixbackPrompt(identity: any, packet: any) {
  return [
    `Ace run closeout fixback for ${identity.runId}.`,
    `Repair the existing branch ${identity.branch || '<unknown branch>'} and existing PR ${identity.prUrl || identity.prNumber || '<unknown PR>'}.`,
    'Do not open a replacement PR. Do not merge. Stay inside the allowed paths and same worktree.',
    'ValidationFailurePacket:',
    JSON.stringify(packet),
    'After fixing, run the focused checks, commit to the same branch, push if needed, and end with DONE or BLOCKED.',
  ].join('\n');
}

function closeoutReviewBlockersOnly(blockers: any[]) {
  const reviewCodes = new Set(['draft_pr', 'review_required', 'owner_approval_required']);
  return blockers.length > 0 && blockers.every((blocker: any) => reviewCodes.has(blocker.code));
}

function closeoutMergeAuthorized(flags: any, identity: any, gate: any) {
  if (flags.merge !== true) return { authorized: false, reason: 'merge flag not set' };
  const configured = process.env.ACE_OWNER_AUTH_TOKEN || '';
  if (flags.ownerToken && configured && flags.ownerToken === configured) {
    return { authorized: true, reason: 'owner token accepted' };
  }
  if (identity.autoship?.autoMergeAllowed === true || gate.result?.autoship?.autoMergeAllowed === true) {
    return { authorized: true, reason: 'autoship policy allows merge' };
  }
  return { authorized: false, reason: 'merge requested but no owner token/autoship authorization matched' };
}

function closeoutPacket(input: any) {
  const blockers = closeoutArray(input.blockers);
  const actions = closeoutArray(input.actions);
  return {
    schema: 'ace.run_closeout_packet.v1',
    runId: input.identity.runId,
    status: input.status,
    packet: {
      status: input.status,
      summary: input.summary || null,
      identity: input.identity,
      projection: input.identity.projection,
      pr: input.gate?.pr || null,
      validation: input.validation || null,
      ci: input.ci || null,
      gate: input.gate ? {
        ok: input.gate.ok === true,
        status: input.gate.status || null,
        failures: input.gate.failures || [],
      } : null,
      validationFailurePacket: input.validationFailurePacket || null,
      ciFailurePacket: input.ciFailurePacket || null,
    },
    actions,
    blockers,
    noMutation: {
      dryRun: input.dryRun === true,
      streamPrompts: actions.filter((action: any) => action.mutation === 'streamAsk').length,
      merges: actions.some((action: any) => action.mutation === 'integrationMergePr'),
      cleanup: false,
      rawGit: false,
      rawGhMerge: false,
      hiddenSpawn: false,
    },
  };
}

async function closeoutAsk(client: any, streamId: string, prompt: string, timeoutMs: any, actions: any[], type: string) {
  actions.push({ type, via: 'streamAsk', mutation: 'streamAsk', streamId });
  return client.invoke('streamAsk', {
    streamId,
    prompt,
    timeoutMs,
    caller: communicationCallerContext('run closeout'),
  }, timeoutMs ? Math.max(60_000, Number(timeoutMs) + 15_000) : undefined);
}

async function handleRunCloseout(client: any, parsed: any) {
  const flags = parsed.flags || {};
  const runId = flags.run;
  const dryRun = flags.dryRun === true;
  const actions: any[] = [{ type: 'read_run_board', via: 'runBoard', mutation: null }];
  const board = await client.invoke('runBoard');
  const card = closeoutFindCard(board, runId);
  if (!card) {
    const identity = { runId: String(runId || ''), projection: {} };
    return closeoutPacket({
      identity,
      status: 'blocked',
      summary: 'run not found on run board',
      blockers: [{ code: 'run_not_found', message: `run ${runId} is not present on the run board` }],
      actions,
      dryRun,
    });
  }

  const row = closeoutFindChildRow(card, closeoutReadChildRows());
  const identity = closeoutIdentity({ runId, card, row, flags });
  const workerSnapshot = await closeoutStreamSnapshot(client, identity.workerStreamId);
  if (workerSnapshot) actions.push({ type: 'read_worker_stream', via: 'streamGetState+streamReadScreen', mutation: null, streamId: identity.workerStreamId });

  if (workerSnapshot && ['busy', 'booting'].includes(String(workerSnapshot.state || '').toLowerCase()) && !closeoutWorkerDone(identity, workerSnapshot)) {
    return closeoutPacket({
      identity,
      status: 'blocked',
      summary: 'worker is still busy; waiting for terminal DONE/BLOCKED',
      blockers: [{ code: 'worker_busy', message: 'worker stream is still busy' }],
      actions,
      dryRun,
    });
  }
  if (closeoutWorkerBlocked(identity, workerSnapshot)) {
    return closeoutPacket({
      identity,
      status: 'blocked',
      summary: 'worker returned BLOCKED',
      blockers: [{ code: 'worker_blocked', message: workerSnapshot?.terminalTrailer?.detail || 'worker projection is BLOCKED' }],
      actions,
      dryRun,
    });
  }
  if (!closeoutWorkerDone(identity, workerSnapshot)) {
    return closeoutPacket({
      identity,
      status: 'blocked',
      summary: 'worker is not complete',
      blockers: [{ code: 'worker_not_done', message: 'closeout requires a worker DONE before validation/gate' }],
      actions,
      dryRun,
    });
  }

  actions.push({ type: 'read_integration_gate', via: 'integrationGate', mutation: null, taskId: identity.taskId, prNumber: identity.prNumber });
  let gate = await closeoutRunGate(client, identity);
  if (!gate.pr?.headSha) {
    return closeoutPacket({
      identity,
      status: 'blocked',
      summary: 'current PR head is unknown',
      gate,
      blockers: [{ code: 'pr_head_unknown', message: 'exact-head validation requires current PR head SHA' }, ...(gate.failures || [])],
      actions,
      dryRun,
    });
  }
  const initialContextBlockers = closeoutContextBlockers(identity, gate);
  if (initialContextBlockers.length) {
    return closeoutPacket({
      identity,
      status: 'blocked',
      summary: 'current PR context does not match the run identity',
      gate,
      blockers: initialContextBlockers,
      actions,
      dryRun,
    });
  }

  const validatorSnapshot = await closeoutStreamSnapshot(client, identity.validatorStreamId);
  if (validatorSnapshot) actions.push({ type: 'read_validator_stream', via: 'streamGetState+streamReadScreen', mutation: null, streamId: identity.validatorStreamId });
  let validation = closeoutValidationFromSnapshot(validatorSnapshot, gate.pr.headSha);

  const hasCurrentValidation =
    validation &&
    validation.exactHead === true &&
    ['pass', 'request-changes', 'block'].includes(validation.verdict);
  if (!hasCurrentValidation) {
    if (!identity.validatorStreamId) {
      return closeoutPacket({
        identity,
        status: 'blocked',
        summary: 'exact-head validator stream is missing',
        gate,
        validation,
        blockers: [{ code: 'validation_required', message: 'current PR head must be validated before gate' }],
        actions,
        dryRun,
      });
    }
    if (validatorSnapshot && ['busy', 'booting'].includes(String(validatorSnapshot.state || '').toLowerCase())) {
      return closeoutPacket({
        identity,
        status: 'blocked',
        summary: 'validator is still busy',
        gate,
        validation,
        blockers: [{ code: 'validator_busy', message: 'validator stream is still busy; cannot start exact-head validation' }],
        actions,
        dryRun,
      });
    }
    if (dryRun) {
      actions.push({ type: 'would_validate_exact_head', via: 'streamAsk', mutation: null, streamId: identity.validatorStreamId, headSha: gate.pr.headSha });
      return closeoutPacket({
        identity,
        status: 'blocked',
        summary: 'dry-run: exact-head validation would be requested',
        gate,
        validation,
        blockers: [{ code: 'validation_required', message: 'dry-run did not ask validator stream' }],
        actions,
        dryRun,
      });
    }
    const askValidation = await closeoutAsk(
      client,
      identity.validatorStreamId,
      closeoutValidationPrompt(identity, gate),
      flags.timeout,
      actions,
      'validate_exact_head'
    );
    validation = closeoutValidationFromText(askValidation?.newOutput || askValidation?.result?.newOutput || '', gate.pr.headSha);
  }

  if (validation.verdict === 'request-changes' || validation.verdict === 'block') {
    let failurePacket;
    try {
      failurePacket = closeoutValidationFailurePacket(identity, validation, gate, 1);
    } catch (err: any) {
      return closeoutPacket({
        identity,
        status: 'blocked',
        summary: 'validator failed but the failure packet could not be normalized',
        gate,
        validation,
        blockers: [{ code: 'validation_failure_packet_invalid', message: err?.message || String(err) }],
        actions,
        dryRun,
      });
    }
    const safety = closeoutSafeFixback(identity, failurePacket, gate);
    if (!safety.safe || dryRun) {
      if (dryRun && safety.safe) actions.push({ type: 'would_send_fixback', via: 'streamAsk', mutation: null, streamId: identity.workerStreamId });
      return closeoutPacket({
        identity,
        status: 'blocked',
        summary: dryRun ? 'dry-run: safe same-worker fixback would be sent' : 'validation failed outside safe fixback scope',
        gate,
        validation,
        validationFailurePacket: failurePacket,
        blockers: dryRun && safety.safe ? [{ code: 'dry_run', message: 'dry-run did not send fixback' }] : safety.blockers,
        actions,
        dryRun,
      });
    }

    const fixback = await closeoutAsk(
      client,
      identity.workerStreamId,
      closeoutFixbackPrompt(identity, failurePacket),
      flags.timeout,
      actions,
      'send_same_worker_fixback'
    );
    const fixOutput = String(fixback?.newOutput || fixback?.result?.newOutput || '');
    const fixTrailer = listTerminalTrailers(fixOutput).slice(-1)[0] || null;
    if (fixTrailer?.kind !== 'done') {
      return closeoutPacket({
        identity,
        status: 'fixback_sent',
        summary: 'fixback was sent but did not return DONE',
        gate,
        validation,
        validationFailurePacket: failurePacket,
        blockers: [{ code: 'fixback_not_done', message: fixTrailer?.detail || 'fixback stream did not return DONE' }],
        actions,
        dryRun,
      });
    }

    actions.push({ type: 'read_integration_gate_after_fixback', via: 'integrationGate', mutation: null, taskId: identity.taskId, prNumber: identity.prNumber });
    const postFixGate = await closeoutRunGate(client, identity);
    if (!postFixGate.pr?.headSha || postFixGate.pr.headSha === gate.pr.headSha) {
      return closeoutPacket({
        identity,
        status: 'fixback_sent',
        summary: 'fixback completed but PR head did not advance',
        gate: postFixGate,
        validation,
        validationFailurePacket: failurePacket,
        blockers: [{ code: 'fixback_no_new_head', message: 'revalidation requires a new PR head after fixback' }],
        actions,
        dryRun,
      });
    }
    gate = postFixGate;

    const revalidationAsk = await closeoutAsk(
      client,
      identity.validatorStreamId,
      closeoutValidationPrompt(identity, gate),
      flags.timeout,
      actions,
      'revalidate_exact_head_after_fixback'
    );
    validation = closeoutValidationFromText(revalidationAsk?.newOutput || revalidationAsk?.result?.newOutput || '', gate.pr.headSha);
    if (validation.verdict !== 'pass' || !validation.exactHead) {
      return closeoutPacket({
        identity,
        status: 'fixback_sent',
        summary: 'fixback was sent; revalidation has not passed the new exact head',
        gate,
        validation,
        validationFailurePacket: failurePacket,
        blockers: [{ code: 'revalidation_failed', message: 'validator did not return exact-head PASS after fixback' }],
        actions,
        dryRun,
      });
    }
  }

  if (validation.verdict !== 'pass' || !validation.exactHead) {
    return closeoutPacket({
      identity,
      status: 'blocked',
      summary: 'exact-head validation did not pass',
      gate,
      validation,
      blockers: [{ code: 'validation_required', message: 'closeout cannot gate without exact-head validator PASS' }],
      actions,
      dryRun,
    });
  }

  let ciResult = await closeoutWatchCi(client, identity, gate, flags, actions, dryRun);
  if (!ciResult.ok) {
    if (ciResult.blockers?.some((blocker: any) => blocker.code === 'dry_run')) {
      return closeoutPacket({
        identity,
        status: 'blocked',
        summary: 'dry-run: required CI would be watched',
        gate: ciResult.gate || gate,
        validation,
        ci: ciResult.ci,
        blockers: ciResult.blockers,
        actions,
        dryRun,
      });
    }
    let ciFailurePacket = null;
    try {
      ciFailurePacket = closeoutCiFailurePacket(identity, ciResult.ci, ciResult.gate || gate, 1);
    } catch (err: any) {
      return closeoutPacket({
        identity,
        status: 'blocked',
        summary: 'CI did not pass and the CI failure packet could not be normalized',
        gate: ciResult.gate || gate,
        validation,
        ci: ciResult.ci,
        blockers: [{ code: 'ci_failure_packet_invalid', message: err?.message || String(err) }],
        actions,
        dryRun,
      });
    }
    const safety = ciResult.blockers?.length
      ? { safe: false, blockers: ciResult.blockers, scope: null }
      : closeoutCiSafeFixback(identity, ciFailurePacket, ciResult.gate || gate, ciResult.ci);
    if (!safety.safe || dryRun) {
      if (dryRun && safety.safe) actions.push({ type: 'would_send_ci_fixback', via: 'streamAsk', mutation: null, streamId: identity.workerStreamId });
      return closeoutPacket({
        identity,
        status: 'blocked',
        summary: dryRun ? 'dry-run: CI fixback would be sent if checks failed safely' : 'CI did not pass inside safe fixback policy',
        gate: ciResult.gate || gate,
        validation,
        ci: ciResult.ci,
        ciFailurePacket,
        blockers: dryRun && safety.safe ? [{ code: 'dry_run', message: 'dry-run did not send CI fixback' }] : safety.blockers,
        actions,
        dryRun,
      });
    }

    const fixback = await closeoutAsk(
      client,
      identity.workerStreamId,
      closeoutFixbackPrompt(identity, ciFailurePacket),
      flags.timeout,
      actions,
      'send_same_worker_ci_fixback'
    );
    const fixOutput = String(fixback?.newOutput || fixback?.result?.newOutput || '');
    const fixTrailer = listTerminalTrailers(fixOutput).slice(-1)[0] || null;
    if (fixTrailer?.kind !== 'done') {
      return closeoutPacket({
        identity,
        status: 'fixback_sent',
        summary: 'CI fixback was sent but did not return DONE',
        gate: ciResult.gate || gate,
        validation,
        ci: ciResult.ci,
        ciFailurePacket,
        blockers: [{ code: 'ci_fixback_not_done', message: fixTrailer?.detail || 'fixback stream did not return DONE' }],
        actions,
        dryRun,
      });
    }

    actions.push({ type: 'read_integration_gate_after_ci_fixback', via: 'integrationGate', mutation: null, taskId: identity.taskId, prNumber: identity.prNumber });
    const postCiFixGate = await closeoutRunGate(client, identity);
    if (!postCiFixGate.pr?.headSha || postCiFixGate.pr.headSha === (ciResult.gate || gate).pr?.headSha) {
      return closeoutPacket({
        identity,
        status: 'fixback_sent',
        summary: 'CI fixback completed but PR head did not advance',
        gate: postCiFixGate,
        validation,
        ci: ciResult.ci,
        ciFailurePacket,
        blockers: [{ code: 'ci_fixback_no_new_head', message: 'revalidation and CI require a new PR head after fixback' }],
        actions,
        dryRun,
      });
    }
    gate = postCiFixGate;

    ciResult = await closeoutWatchCi(client, identity, gate, flags, actions, dryRun);
    if (!ciResult.ok) {
      return closeoutPacket({
        identity,
        status: 'fixback_sent',
        summary: 'CI fixback was sent; CI did not pass on the new exact head',
        gate: ciResult.gate || gate,
        validation,
        ci: ciResult.ci,
        ciFailurePacket,
        blockers: ciResult.blockers?.length ? ciResult.blockers : [{ code: 'ci_rewatch_failed', message: 'required CI did not pass after fixback' }],
        actions,
        dryRun,
      });
    }
    gate = ciResult.gate || gate;

    const revalidationAsk = await closeoutAsk(
      client,
      identity.validatorStreamId,
      closeoutValidationPrompt(identity, gate),
      flags.timeout,
      actions,
      'revalidate_exact_head_after_ci_fixback'
    );
    validation = closeoutValidationFromText(revalidationAsk?.newOutput || revalidationAsk?.result?.newOutput || '', gate.pr.headSha);
    if (validation.verdict !== 'pass' || !validation.exactHead) {
      return closeoutPacket({
        identity,
        status: 'fixback_sent',
        summary: 'CI fixback was sent; revalidation has not passed the new exact head',
        gate,
        validation,
        ci: ciResult.ci,
        ciFailurePacket,
        blockers: [{ code: 'ci_revalidation_failed', message: 'validator did not return exact-head PASS after CI fixback' }],
        actions,
        dryRun,
      });
    }
  } else {
    gate = ciResult.gate || gate;
  }

  actions.push({ type: 'read_final_integration_gate', via: 'integrationGate', mutation: null, taskId: identity.taskId, prNumber: identity.prNumber });
  const finalGate = await closeoutRunGate(client, identity);
  const blockers = finalGate.failures || [];
  if (!finalGate.ok) {
    const status = closeoutReviewBlockersOnly(blockers) ? 'ready_to_review' : 'blocked';
    return closeoutPacket({
      identity,
      status,
      summary: status === 'ready_to_review' ? 'parked for owner review' : 'integration gate blocked closeout',
      gate: finalGate,
      validation,
      ci: ciResult.ci,
      blockers,
      actions,
      dryRun,
    });
  }

  const mergeAuth = closeoutMergeAuthorized(flags, identity, finalGate);
  if (!mergeAuth.authorized) {
    return closeoutPacket({
      identity,
      status: 'merge_ready',
      summary: mergeAuth.reason,
      gate: finalGate,
      validation,
      ci: ciResult.ci,
      blockers: [{ code: 'owner_approval_required', message: mergeAuth.reason }],
      actions,
      dryRun,
    });
  }

  actions.push({ type: 'merge_via_gateway', via: 'integrationMergePr', mutation: 'integrationMergePr', taskId: identity.taskId, prNumber: finalGate.pr.number || identity.prNumber });
  const merge = await client.invoke('integrationMergePr', {
    taskId: identity.taskId,
    prNumber: finalGate.pr.number || identity.prNumber,
    allowedPaths: identity.allowedPaths || [],
  });
  const mergeResult = closeoutObject(merge?.result || merge);
  if (merge?.ok === false || (!mergeResult.mergedSha && !mergeResult.sha && !mergeResult.merge?.sha)) {
    return closeoutPacket({
      identity,
      status: 'blocked',
      summary: 'integration gateway merge did not complete',
      gate: finalGate,
      validation,
      ci: ciResult.ci,
      blockers: [{ code: 'merge_gateway_blocked', message: mergeResult.error || 'integrationMergePr returned no merged SHA' }],
      actions,
      dryRun,
    });
  }
  return closeoutPacket({
    identity,
    status: 'merged',
    summary: 'merged through integration gateway',
    gate: finalGate,
    validation,
    ci: ciResult.ci,
    actions,
    dryRun,
  });
}

const RUN_FOLLOWUP_SCHEMA = 'ace.run_followup_packet.v1';
const RUN_FOLLOWUP_TERMINAL_STATUSES = new Set([
  'PR_NEEDED',
  'READY_FOR_REVIEW',
  'MERGE_AUTH_NEEDED',
  'MERGED',
  'BLOCKED',
]);

function followupAllowArgs(allowedPaths: any[] = []) {
  return closeoutArray(allowedPaths)
    .map((allowPath: any) => ` --allow-path ${JSON.stringify(String(allowPath))}`)
    .join('');
}

function followupCommandBase(identity: any) {
  if (identity.runId) return `ace --json run followup --run ${identity.runId}`;
  if (identity.taskId && identity.prNumber != null) return `ace --json run followup --task ${identity.taskId} --pr ${identity.prNumber}`;
  if (identity.taskId) return `ace --json run followup --task ${identity.taskId}`;
  return 'ace --json run followup';
}

function followupSafeCommand(status: string, identity: any) {
  const allow = followupAllowArgs(identity.allowedPaths || []);
  if (status === 'PR_NEEDED') {
    const title = JSON.stringify(`Ace follow-up ${identity.runId || identity.taskId || 'run'}`);
    return identity.taskId
      ? `ace integrate push --task ${identity.taskId} && ace integrate pr-open --task ${identity.taskId} --title ${title}${allow}`
      : null;
  }
  if (status === 'MERGE_AUTH_NEEDED') {
    return identity.taskId && identity.prNumber != null
      ? `ace integrate pr-merge --task ${identity.taskId} --pr ${identity.prNumber} --auto${allow}`
      : null;
  }
  if (['WORKER_ACTIVE', 'VALIDATOR_DISPATCHED', 'FIXBACK_SENT', 'CHECKS_PENDING', 'VALIDATOR_NEEDED'].includes(status)) {
    return `${followupCommandBase(identity)} --auto${allow}`;
  }
  return null;
}

function followupPrFromText(textValue: any) {
  const text = String(textValue || '');
  const url = closeoutText((text.match(/https:\/\/github\.com\/[^\s)]+\/pull\/[1-9]\d*/i) || [])[0]);
  const number = closeoutPrNumber((text.match(/\bPR\s*#?([1-9]\d*)\b/i) || [])[1], url);
  return number != null || url ? { number, url } : null;
}

function followupPrFromOpen(envelope: any) {
  const result = closeoutObject(envelope?.result || envelope);
  const stdout = closeoutText(result.stdout || envelope?.stdout);
  const textPr = followupPrFromText(stdout);
  const url = closeoutText(result.prUrl || result.url || result.htmlUrl || result.pr?.url || textPr?.url);
  const number = closeoutPrNumber(result.prNumber ?? result.number ?? result.pr?.number ?? textPr?.number, url);
  return { number, url };
}

function followupEnvelopeBlocked(envelope: any) {
  if (!envelope) return true;
  if (envelope.ok === false) return true;
  const phase = String(envelope.phase || '').toLowerCase();
  return phase === 'blocked' || phase === 'failure' || phase === 'error';
}

function followupBlockerFromEnvelope(envelope: any, fallbackCode: string) {
  const result = closeoutObject(envelope?.result || envelope);
  const failures = closeoutArray(result.failures || result.blockers || result.gate?.failures);
  if (failures.length) return failures;
  return [{
    code: closeoutText(result.code || result.error) || fallbackCode,
    message: closeoutText(result.message || result.error || envelope?.message) || fallbackCode,
  }];
}

function followupFindCard(board: any, flags: any = {}) {
  const runId = closeoutText(flags.run);
  if (runId) return closeoutFindCard(board, runId);
  const taskId = closeoutText(flags.task);
  const prNumber = closeoutPrNumber(flags.pr);
  return closeoutArray(board?.cards).find((card: any) => {
    const detail = closeoutObject(card?.detail);
    const worker = closeoutObject(detail.worker);
    const pr = closeoutObject(detail.pr);
    if (taskId && worker.taskId === taskId) return true;
    if (prNumber != null && closeoutPrNumber(pr.number, pr.url || card?.prUrl) === prNumber) return true;
    return false;
  }) || null;
}

function followupFindChildRow(card: any, rows: any[], flags: any = {}) {
  const taskId = closeoutText(flags.task);
  const prNumber = closeoutPrNumber(flags.pr);
  if (taskId || prNumber != null) {
    const direct = closeoutArray(rows).find((row: any) => {
      if (taskId && row?.taskId === taskId) return true;
      if (prNumber != null && Number(row?.prNumber) === prNumber) return true;
      return false;
    });
    if (direct) return direct;
  }
  return card ? closeoutFindChildRow(card, rows) : null;
}

function followupIdentity({ flags, card, row }: any) {
  const detail = closeoutObject(card?.detail);
  const worker = closeoutObject(detail.worker);
  const validator = closeoutObject(detail.validator);
  const pr = closeoutObject(detail.pr);
  const prUrl = closeoutText(pr.url || row?.prUrl || card?.prUrl);
  const allowedPaths = closeoutArray(flags.allowPath).length
    ? closeoutArray(flags.allowPath)
    : closeoutArray(row?.allowedPaths).length
      ? closeoutArray(row.allowedPaths)
      : closeoutArray(pr.allowedPaths);
  const prNumber = closeoutPrNumber(flags.pr ?? pr.number ?? row?.prNumber, prUrl);
  return {
    runId: closeoutText(flags.run || card?.id || row?.runId),
    workspaceId: closeoutText(worker.workspaceId || row?.workspaceId || card?.workspaceId),
    taskId: closeoutText(flags.task || worker.taskId || row?.taskId),
    workerStreamId: closeoutText(worker.streamId || row?.streamId),
    validatorTaskId: closeoutText(validator.taskId || row?.validatorTaskId),
    validatorStreamId: closeoutText(validator.streamId || row?.validatorStreamId),
    branch: closeoutText(worker.branch || row?.branch || card?.branch),
    baseBranch: closeoutText(pr.baseBranch || row?.baseBranch),
    worktreePath: closeoutText(worker.worktreePath || row?.worktreePath),
    prNumber,
    prUrl,
    allowedPaths,
    projection: {
      stage: card?.stage || null,
      nextAction: card?.nextAction || null,
      workerOutcome: worker.outcome || row?.laneStatus || row?.outcome || card?.workerOutcome || null,
      validationStatus: validator.outcome || row?.validationStatus || card?.validationStatus || null,
      pr: {
        number: pr.number ?? row?.prNumber ?? null,
        url: pr.url || row?.prUrl || card?.prUrl || null,
        state: pr.state || row?.prState || card?.prStatus || null,
        headSha: pr.headSha || null,
        checkState: pr.checkState || row?.checkState || row?.prChecks || null,
        mergeable: pr.mergeable || row?.mergeable || null,
      },
    },
    autoship: closeoutObject(detail.autoship),
  };
}

function followupWithPr(identity: any, prPatch: any = {}) {
  const prUrl = closeoutText(prPatch.url || identity.prUrl);
  const prNumber = closeoutPrNumber(prPatch.number ?? identity.prNumber, prUrl);
  return {
    ...identity,
    prNumber,
    prUrl,
    projection: {
      ...identity.projection,
      pr: {
        ...(identity.projection?.pr || {}),
        number: prNumber,
        url: prUrl,
      },
    },
  };
}

function followupPacket(input: any) {
  const identity = input.identity || {};
  const gatePr = input.gate?.pr || {};
  const prNumber = closeoutPrNumber(identity.prNumber ?? gatePr.number, identity.prUrl || gatePr.url);
  const status = input.status || 'BLOCKED';
  return {
    schema: RUN_FOLLOWUP_SCHEMA,
    status,
    runId: identity.runId || null,
    taskId: identity.taskId || null,
    streamId: identity.workerStreamId || null,
    validator: {
      taskId: input.validator?.taskId ?? identity.validatorTaskId ?? null,
      streamId: input.validator?.streamId ?? identity.validatorStreamId ?? null,
      status: input.validator?.status || identity.projection?.validationStatus || null,
    },
    pr: {
      number: prNumber,
      url: identity.prUrl || gatePr.url || null,
      state: gatePr.state || identity.projection?.pr?.state || null,
      headSha: gatePr.headSha || identity.projection?.pr?.headSha || null,
      checkState: gatePr.checkState || identity.projection?.pr?.checkState || null,
      mergeable: gatePr.mergeable || identity.projection?.pr?.mergeable || null,
    },
    evidence: closeoutArray(input.evidence),
    nextAction: input.nextAction || 'inspect follow-up state',
    safeNextCommand: input.safeNextCommand === undefined ? followupSafeCommand(status, { ...identity, prNumber }) : input.safeNextCommand,
    stopCondition: input.stopCondition || null,
    blockers: closeoutArray(input.blockers),
    actions: closeoutArray(input.actions),
    closeout: input.closeout || null,
  };
}

function followupGateFailureCodes(gate: any) {
  return [
    ...closeoutArray(gate?.failures),
    ...closeoutArray(gate?.gate?.failures),
    ...closeoutArray(gate?.result?.failures),
  ].map((failure: any) => closeoutText(typeof failure === 'object' && failure ? failure.code || failure.reason || failure.id : failure)).filter(Boolean);
}

function followupGateRequiresValidation(gate: any) {
  const failureCodes = followupGateFailureCodes(gate);
  if (failureCodes.includes('validation_required') || failureCodes.includes('independent_validation_required')) return true;
  const validation = closeoutObject(gate?.validation || gate?.gate?.validation);
  const independent = String(validation.independent || validation.independentValidation || '').toUpperCase();
  const self = String(validation.self || validation.selfValidation || '').toUpperCase();
  return validation.required === true && independent !== 'PASS' && self !== 'PASS';
}

function followupCloseoutStatus(closeout: any) {
  const blockers = closeoutArray(closeout?.blockers);
  const codes = blockers.map((blocker: any) => closeoutText(blocker?.code)).filter(Boolean);
  if (closeout?.status === 'merged') return 'MERGED';
  if (closeout?.status === 'fixback_sent') return 'FIXBACK_SENT';
  if (closeout?.status === 'ready_to_review') return 'READY_FOR_REVIEW';
  if (closeout?.status === 'merge_ready') return 'MERGE_AUTH_NEEDED';
  if (codes.includes('worker_busy')) return 'WORKER_ACTIVE';
  if (codes.includes('validation_required')) return 'VALIDATOR_NEEDED';
  if (codes.includes('validator_busy')) return 'VALIDATOR_ACTIVE';
  if (codes.includes('ci_pending')) return 'CHECKS_PENDING';
  if (codes.some((code: any) => String(code).startsWith('ci_')) || codes.includes('checks_not_green')) return 'CHECKS_FAILED';
  return 'BLOCKED';
}

function followupNextAction(status: string) {
  switch (status) {
    case 'WORKER_ACTIVE':
      return 'poll worker until DONE or BLOCKED';
    case 'PR_NEEDED':
      return 'open or link a PR through the integration gateway';
    case 'PR_OPENED':
      return 'run follow-up again to validate the opened PR';
    case 'VALIDATOR_NEEDED':
      return 'dispatch exact-head validator';
    case 'VALIDATOR_DISPATCHED':
      return 'wait for validator verdict, then rerun follow-up';
    case 'VALIDATOR_ACTIVE':
      return 'wait for validator to finish';
    case 'FIXBACK_SENT':
      return 'wait for same-worker fixback completion and new PR head';
    case 'CHECKS_PENDING':
      return 'wait for PR checks to finish';
    case 'CHECKS_FAILED':
      return 'send safe same-worker fixback or park for review';
    case 'READY_FOR_REVIEW':
      return 'park for owner review';
    case 'MERGE_AUTH_NEEDED':
      return 'owner or autoship authorization required for gateway merge';
    case 'MERGED':
      return 'stop; PR merged through gateway';
    default:
      return 'resolve blocker before continuing';
  }
}

function followupFromCloseout(closeout: any, actions: any[] = []) {
  const identity = closeout?.packet?.identity || {};
  const status = followupCloseoutStatus(closeout);
  return followupPacket({
    identity,
    status,
    gate: closeout?.packet?.gate ? { gate: closeout.packet.gate, pr: closeout.packet.pr } : null,
    evidence: [
      { type: 'closeout_status', status: closeout?.status || null, summary: closeout?.packet?.summary || null },
      { type: 'closeout_actions', actions: closeoutArray(closeout?.actions).map((action: any) => action.type || action.via || 'unknown') },
    ],
    nextAction: followupNextAction(status),
    stopCondition: status === 'MERGED' ? 'PR merged' : closeout?.packet?.summary || null,
    blockers: closeoutArray(closeout?.blockers),
    actions: [...actions, ...closeoutArray(closeout?.actions)],
    closeout,
  });
}

async function followupOpenPr(client: any, identity: any, actions: any[], flags: any) {
  actions.push({ type: 'gateway_push', via: 'integrationPush', mutation: 'integrationPush', taskId: identity.taskId });
  const push = await client.invoke('integrationPush', {
    taskId: identity.taskId,
    branch: identity.branch || undefined,
  });
  if (followupEnvelopeBlocked(push)) {
    return followupPacket({
      identity,
      status: 'BLOCKED',
      evidence: [{ type: 'integration_push', envelope: push }],
      nextAction: 'resolve integration push blocker',
      blockers: followupBlockerFromEnvelope(push, 'integration_push_blocked'),
      actions,
      safeNextCommand: identity.taskId ? `ace integrate push --task ${identity.taskId}` : null,
    });
  }

  const title = `Ace follow-up ${identity.runId || identity.taskId || 'run'}`;
  actions.push({ type: 'gateway_pr_open', via: 'integrationOpenPr', mutation: 'integrationOpenPr', taskId: identity.taskId });
  const opened = await client.invoke('integrationOpenPr', {
    taskId: identity.taskId,
    title,
    body: `Automated Ace follow-up for ${identity.runId || identity.taskId || 'run'}.`,
    base: identity.baseBranch || undefined,
    head: identity.branch || undefined,
    allowedPaths: identity.allowedPaths || [],
    draft: false,
  });
  if (followupEnvelopeBlocked(opened)) {
    return followupPacket({
      identity,
      status: 'BLOCKED',
      evidence: [{ type: 'integration_pr_open', envelope: opened }],
      nextAction: 'resolve integration PR-open blocker',
      blockers: followupBlockerFromEnvelope(opened, 'integration_pr_open_blocked'),
      actions,
      safeNextCommand: identity.taskId
        ? `ace integrate pr-open --task ${identity.taskId} --title ${JSON.stringify(title)}${followupAllowArgs(identity.allowedPaths || [])}`
        : null,
    });
  }

  const pr = followupPrFromOpen(opened);
  const nextIdentity = followupWithPr(identity, pr);
  if (nextIdentity.prNumber == null && !nextIdentity.prUrl) {
    return followupPacket({
      identity,
      status: 'PR_NEEDED',
      evidence: [{ type: 'integration_pr_open', envelope: opened }],
      nextAction: 'link the opened PR number or rerun after registry refresh',
      blockers: [{ code: 'pr_number_missing', message: 'integrationOpenPr did not return a PR number or URL' }],
      actions,
    });
  }
  return followupPacket({
    identity: nextIdentity,
    status: 'PR_OPENED',
    evidence: [
      { type: 'integration_push', ok: push?.ok !== false, phase: push?.phase || null },
      { type: 'integration_pr_open', ok: opened?.ok !== false, phase: opened?.phase || null },
    ],
    nextAction: followupNextAction('PR_OPENED'),
    stopCondition: 'PR exists; validation/gate still pending',
    actions,
  });
}

async function followupDispatchValidator(client: any, identity: any, gate: any, actions: any[]) {
  if (!identity.taskId) {
    return followupPacket({
      identity,
      status: 'BLOCKED',
      evidence: [{ type: 'validator_dispatch', reason: 'task missing' }],
      nextAction: 'link the task before dispatching validation',
      blockers: [{ code: 'task_id_missing', message: 'validator dispatch requires a task id' }],
      actions,
    });
  }
  actions.push({ type: 'spawn_validator', via: 'streamSpawn', mutation: 'streamSpawn', taskId: identity.taskId });
  const spawned = await client.invoke('streamSpawn', {
    agent: 'codex',
    taskId: identity.taskId,
    kind: 'cli',
  });
  const streamId = closeoutText(spawned?.streamId || spawned?.conversationId);
  if (!streamId) {
    return followupPacket({
      identity,
      status: 'BLOCKED',
      evidence: [{ type: 'validator_spawn', result: spawned }],
      nextAction: 'resolve validator spawn blocker',
      blockers: [{ code: 'validator_spawn_failed', message: 'streamSpawn returned no validator stream id' }],
      actions,
    });
  }
  const prompt = closeoutValidationPrompt(identity, gate);
  actions.push({ type: 'send_validator_prompt', via: 'streamSendInput+streamSubmit', mutation: 'streamSendInput', streamId });
  await client.invoke('streamSendInput', {
    streamId,
    text: prompt,
    mode: 'paste',
    caller: communicationCallerContext('run followup'),
  });
  await client.invoke('streamSubmit', { streamId });
  return followupPacket({
    identity: { ...identity, validatorStreamId: streamId },
    status: 'VALIDATOR_DISPATCHED',
    validator: { taskId: identity.taskId, streamId, status: 'dispatched' },
    gate,
    evidence: [{ type: 'validator_dispatch', streamId, taskId: identity.taskId, headSha: gate?.pr?.headSha || null }],
    nextAction: followupNextAction('VALIDATOR_DISPATCHED'),
    stopCondition: 'validator returns exact-head PASS/request-changes/BLOCKED',
    actions,
  });
}

async function handleRunFollowupOnce(client: any, parsed: any) {
  const flags = parsed.flags || {};
  if (!flags.run && !flags.task && flags.pr == null) {
    die({
      code: 2,
      error: 'missing_arg',
      message: 'run followup requires --run, --task, or --pr',
      details: { command: 'run followup' },
    });
  }

  const actions: any[] = [{ type: 'read_run_board', via: 'runBoard', mutation: null }];
  const board = await client.invoke('runBoard');
  const card = followupFindCard(board, flags);
  const row = followupFindChildRow(card, closeoutReadChildRows(), flags);
  let identity = followupIdentity({ flags, card, row });
  if (!identity.runId && !identity.taskId && !identity.workerStreamId && identity.prNumber == null) {
    return followupPacket({
      identity,
      status: 'BLOCKED',
      evidence: [{ type: 'identity', boardFound: Boolean(card), registryFound: Boolean(row) }],
      nextAction: 'provide --run, --task, or --pr that resolves to a tracked lane',
      blockers: [{ code: 'identity_unresolved', message: 'could not resolve run/task/stream/PR identity' }],
      actions,
    });
  }

  const workerSnapshot = await closeoutStreamSnapshot(client, identity.workerStreamId);
  if (workerSnapshot) actions.push({ type: 'read_worker_stream', via: 'streamGetState+streamReadScreen', mutation: null, streamId: identity.workerStreamId });
  const recoveredPr = !identity.prNumber && workerSnapshot?.terminalTrailer?.detail
    ? followupPrFromText(workerSnapshot.terminalTrailer.detail)
    : null;
  if (recoveredPr) identity = followupWithPr(identity, recoveredPr);

  if (workerSnapshot && ['busy', 'booting'].includes(String(workerSnapshot.state || '').toLowerCase()) && !closeoutWorkerDone(identity, workerSnapshot)) {
    return followupPacket({
      identity,
      status: 'WORKER_ACTIVE',
      evidence: [{ type: 'worker_state', state: workerSnapshot.state, terminalTrailer: workerSnapshot.terminalTrailer }],
      nextAction: followupNextAction('WORKER_ACTIVE'),
      stopCondition: 'worker DONE or BLOCKED',
      actions,
    });
  }
  if (closeoutWorkerBlocked(identity, workerSnapshot)) {
    return followupPacket({
      identity,
      status: 'BLOCKED',
      evidence: [{ type: 'worker_trailer', terminalTrailer: workerSnapshot?.terminalTrailer || null }],
      nextAction: 'resolve worker BLOCKED reason or cancel the lane',
      blockers: [{ code: 'worker_blocked', message: workerSnapshot?.terminalTrailer?.detail || 'worker projection is BLOCKED' }],
      stopCondition: 'worker BLOCKED',
      actions,
    });
  }
  if (!closeoutWorkerDone(identity, workerSnapshot) && identity.prNumber == null) {
    return followupPacket({
      identity,
      status: 'WORKER_ACTIVE',
      evidence: [{ type: 'worker_state', state: workerSnapshot?.state || null, terminalTrailer: workerSnapshot?.terminalTrailer || null }],
      nextAction: followupNextAction('WORKER_ACTIVE'),
      stopCondition: 'worker DONE or PR linked',
      actions,
    });
  }

  if (identity.prNumber == null && !identity.prUrl) {
    if (flags.auto === true && identity.taskId) {
      return followupOpenPr(client, identity, actions, flags);
    }
    return followupPacket({
      identity,
      status: 'PR_NEEDED',
      evidence: [{ type: 'worker_done', source: workerSnapshot?.terminalTrailer ? 'terminal_trailer' : 'projection' }],
      nextAction: followupNextAction('PR_NEEDED'),
      stopCondition: 'PR opened or linked',
      blockers: [{ code: 'pr_missing', message: 'worker is DONE but no PR is linked' }],
      actions,
    });
  }

  if (!identity.taskId || identity.prNumber == null) {
    return followupPacket({
      identity,
      status: 'BLOCKED',
      evidence: [{ type: 'identity', taskId: identity.taskId, prNumber: identity.prNumber, prUrl: identity.prUrl }],
      nextAction: 'link both task id and PR number before gate',
      blockers: [{ code: 'task_or_pr_missing', message: 'integration gate requires task id and PR number' }],
      actions,
    });
  }

  actions.push({ type: 'read_integration_gate', via: 'integrationGate', mutation: null, taskId: identity.taskId, prNumber: identity.prNumber });
  const gate = await closeoutRunGate(client, identity);
  if (!gate.pr?.headSha) {
    return followupPacket({
      identity,
      status: 'BLOCKED',
      gate,
      evidence: [{ type: 'integration_gate', status: gate.status, failures: gate.failures || [] }],
      nextAction: 'recover current PR head evidence before validation',
      blockers: [{ code: 'pr_head_unknown', message: 'current PR head SHA is required' }, ...(gate.failures || [])],
      actions,
    });
  }

  if (followupGateRequiresValidation(gate) && !identity.validatorStreamId) {
    if (flags.auto === true) return followupDispatchValidator(client, identity, gate, actions);
    return followupPacket({
      identity,
      status: 'VALIDATOR_NEEDED',
      gate,
      evidence: [{ type: 'integration_gate', status: gate.status, failures: gate.failures || [] }],
      nextAction: followupNextAction('VALIDATOR_NEEDED'),
      stopCondition: 'exact-head validator PASS/request-changes/BLOCKED',
      blockers: [{ code: 'validation_required', message: 'current PR head requires a validator stream' }],
      actions,
    });
  }

  if (!identity.runId) {
    const checkState = closeoutNormalizeCheckState(gate.pr?.checkState);
    const status = checkState === 'pending'
      ? 'CHECKS_PENDING'
      : checkState === 'failure'
        ? 'CHECKS_FAILED'
        : gate.ok
          ? 'READY_FOR_REVIEW'
          : 'BLOCKED';
    return followupPacket({
      identity,
      status,
      gate,
      evidence: [{ type: 'integration_gate', status: gate.status, failures: gate.failures || [] }],
      nextAction: followupNextAction(status),
      blockers: gate.ok ? [] : gate.failures || [],
      actions,
    });
  }

  const closeoutParsed = {
    ...parsed,
    flags: {
      ...flags,
      run: identity.runId,
      dryRun: flags.auto !== true,
      merge: flags.auto === true,
      allowPath: identity.allowedPaths || [],
    },
  };
  const closeout = await handleRunCloseout(client, closeoutParsed);
  return followupFromCloseout(closeout, actions);
}

function sleep(ms: number) {
  return new Promise((resolve: any) => setTimeout(resolve, ms));
}

async function handleRunFollowup(client: any, parsed: any, { json }: any) {
  const flags = parsed.flags || {};
  if (flags.watch === true && flags.once === true) {
    die({
      code: 2,
      error: 'invalid_args',
      message: 'run followup accepts only one of --once or --watch',
      details: { command: 'run followup' },
    });
  }
  if (flags.watch !== true) return handleRunFollowupOnce(client, parsed);

  const intervalMs = Number.isFinite(flags.intervalMs) && flags.intervalMs > 0 ? flags.intervalMs : 30_000;
  let stopped = false;
  const stop = () => { stopped = true; };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  while (!stopped) {
    const packet = await handleRunFollowupOnce(client, parsed);
    if (json) printJson({ ok: true, data: packet });
    else process.stdout.write(`${packet.status}: ${packet.nextAction}\n`);
    if (RUN_FOLLOWUP_TERMINAL_STATUSES.has(packet.status)) break;
    await sleep(intervalMs);
  }
  return 0;
}


// ---- run watch: multi-run transition watcher over the lean board ----------
// The board projection is read-only; this is purely a poll+diff loop with a
// persisted cursor so `--once` can answer "what changed since I last looked?"
// across separate invocations (the manager-agent turn-start pulse).
const RUN_WATCH_RESTING = new Set(['done', 'ready_to_review', 'blocked']);
const RUN_WATCH_ATTENTION = new Set(['ready_to_review', 'blocked']);
const RUN_WATCH_HINTS: Record<string, string> = {
  ready_to_review: 'parked - merge via `run followup --run <id> --auto` with the owner token, or arm autoship',
  blocked: 'inspect via `run followup --run <id>` for the safe next action',
  done: 'complete',
  in_progress: 'working',
  todo: 'queued',
};

function runWatchCursorPath(flags: any) {
  if (flags.cursor) return String(flags.cursor);
  const base = process.env.ACE_HOME || require('path').join(require('os').homedir(), '.ace');
  return require('path').join(base, 'run-watch-cursor.json');
}

function readRunWatchCursor(file: string) {
  try {
    return JSON.parse(require('fs').readFileSync(file, 'utf8'))?.stages || {};
  } catch {
    return {};
  }
}

function writeRunWatchCursor(file: string, stages: any) {
  const fs = require('fs');
  const path = require('path');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ stages, at: new Date().toISOString() }, null, 2));
  } catch {}
}

async function fetchRunWatchCards(client: any, watched: Set<string> | null) {
  const board = await client.invoke('runBoard', {});
  const cards = new Map<string, any>();
  for (const card of board?.cards || []) {
    const runId = String(card?.runId ?? card?.id ?? '');
    if (!runId) continue;
    if (watched && !watched.has(runId)) continue;
    cards.set(runId, {
      runId,
      stage: String(card?.stage ?? card?.column ?? 'todo'),
      name: String(card?.name ?? card?.title ?? runId),
      agentId: card?.agentId ?? card?.agent ?? null,
    });
  }
  return cards;
}

function diffRunWatch(prevStages: any, cards: Map<string, any>) {
  const transitions = [];
  for (const [runId, card] of cards) {
    const from = prevStages[runId] ?? null;
    if (from !== card.stage) {
      transitions.push({
        at: new Date().toISOString(),
        runId,
        from,
        to: card.stage,
        name: card.name,
        agentId: card.agentId,
        hint: RUN_WATCH_HINTS[card.stage] || card.stage,
      });
    }
  }
  return transitions;
}

function runWatchSummary(cards: Map<string, any>) {
  const summary: Record<string, number> = { total: cards.size };
  for (const card of cards.values()) summary[card.stage] = (summary[card.stage] || 0) + 1;
  return summary;
}

function printRunWatchLine(tr: any) {
  const from = tr.from == null ? 'new' : tr.from;
  process.stdout.write(`${tr.runId} ${from} -> ${tr.to} | ${tr.name}${tr.agentId ? ` | ${tr.agentId}` : ''} | ${tr.hint}\n`);
}

function appendRunWatchDigest(file: string | null, transitions: any[]) {
  if (!file || !transitions.length) return;
  const fs = require('fs');
  const path = require('path');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, transitions.map((t: any) => JSON.stringify(t)).join('\n') + '\n');
  } catch {}
}

async function handleRunWatch(client: any, parsed: any, { json }: any) {
  const flags = parsed.flags || {};
  const watched = flags.runs
    ? new Set(String(flags.runs).split(',').map((s: string) => s.trim()).filter(Boolean))
    : null;
  const cursorFile = runWatchCursorPath(flags);
  const digestFile = flags.digest ? String(flags.digest) : null;
  let stages = readRunWatchCursor(cursorFile);

  const pulse = async () => {
    const cards = await fetchRunWatchCards(client, watched);
    const transitions = diffRunWatch(stages, cards);
    for (const card of cards.values()) stages[card.runId] = card.stage;
    writeRunWatchCursor(cursorFile, stages);
    appendRunWatchDigest(digestFile, transitions);
    return { cards, transitions, summary: runWatchSummary(cards) };
  };

  if (flags.once === true) {
    const { cards, transitions, summary } = await pulse();
    if (json) printJson({ ok: true, data: { transitions, summary } });
    else {
      for (const tr of transitions) printRunWatchLine(tr);
      process.stdout.write(`pulse: ${JSON.stringify(summary)}\n`);
    }
    const attention = [...cards.values()].some((c) => RUN_WATCH_ATTENTION.has(c.stage));
    process.exitCode = attention ? 3 : 0;
    return 0;
  }

  const intervalMs = (Number.isFinite(flags.interval) && flags.interval > 0 ? flags.interval : 20) * 1000;
  const deadline = Date.now() + (Number.isFinite(flags.timeoutMinutes) && flags.timeoutMinutes > 0 ? flags.timeoutMinutes : 120) * 60_000;
  let stopped = false;
  const stop = () => { stopped = true; };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  while (!stopped && Date.now() < deadline) {
    const { cards, transitions, summary } = await pulse();
    if (json && transitions.length) printJson({ ok: true, data: { transitions, summary } });
    else for (const tr of transitions) printRunWatchLine(tr);
    // Rest when every watched run needs nothing from the spine any more —
    // done, parked for the owner, or blocked awaiting inspection.
    const resting = cards.size > 0 && [...cards.values()].every((c) => RUN_WATCH_RESTING.has(c.stage));
    if (resting) {
      const attention = [...cards.values()].some((c) => RUN_WATCH_ATTENTION.has(c.stage));
      if (!json) process.stdout.write(`rest: ${JSON.stringify(summary)}\n`);
      process.exitCode = attention ? 3 : 0;
      return 0;
    }
    await sleep(intervalMs);
  }
  return 0;
}

async function handleSupervise(cmdEntry: any, parsed: any, { json }: any) {
  const workspace = parsed.flags.workspace;
  const {
    createChildRegistry,
    createFileDb,
    defaultStorePath,
  } = require('./child-registry.cjs');
  const storePath = process.env.ACE_CHILD_REGISTRY_PATH || defaultStorePath();
  const registry = createChildRegistry({ db: createFileDb(storePath) });
  let followUpModule: any;
  try {
    followUpModule = require('./follow-up-supervisor.cjs');
  } catch {
    followUpModule = require('./follow-up-supervisor.cts');
  }
  const followUpStore = followUpModule.createFollowUpStore({
    filePath: process.env.ACE_FOLLOW_UP_STORE_PATH || followUpModule.defaultFollowUpStorePath(),
  });

  const matchesWorkspace = (r: any) => r.workspaceId === workspace;
  let rows = registry.list().filter(matchesWorkspace);
  const baseBranch = resolveSuperviseBaseBranch(rows);
  const reconcileCwd = resolveSuperviseCwd(rows);

  if (parsed.flags.live === true) {
    const { createSupervisor, DEFAULT_POLL_INTERVAL_MS } = require('./supervisor.cjs');
    const intervalMs = Number.isFinite(parsed.flags.intervalMs) && parsed.flags.intervalMs > 0
      ? parsed.flags.intervalMs
      : DEFAULT_POLL_INTERVAL_MS;
    const maxTicks = Number.isFinite(parsed.flags.maxTicks) && parsed.flags.maxTicks > 0
      ? parsed.flags.maxTicks
      : null;
    const filteredRegistry = buildFilteredRegistry(registry, matchesWorkspace);

    let ticksSeen = 0;
    let resolveDone;
    const done = new Promise((resolve: any) => { resolveDone = resolve; });

    const supervisor = createSupervisor({
      childRegistry: filteredRegistry,
      pollIntervalMs: intervalMs,
      cwd: reconcileCwd || process.cwd(),
      baseBranch,
      followUpStore,
      onTick: (snap: any) => {
        printJson({ ok: true, data: { workspace, ...snap } });
        ticksSeen += 1;
        if (maxTicks != null && ticksSeen >= maxTicks) {
          supervisor.stop();
          resolveDone();
        }
      },
    });
    const onSig = () => { supervisor.stop(); resolveDone(); };
    process.once('SIGINT', onSig);
    process.once('SIGTERM', onSig);
    supervisor.start();
    await done;
    return 0;
  }

  let prReconciliation = null;
  if (json && rows.length && process.env.ACE_SUPERVISE_RECONCILE !== '0') {
    const { defaultGh, reconcileWorkspacePullRequests } = require('./supervisor.cjs');
    if (reconcileCwd) {
      prReconciliation = await reconcileWorkspacePullRequests({
        rows,
        gh: defaultGh,
        cwd: reconcileCwd,
        baseBranch,
      });
      rows = applyStaleRows(rows, prReconciliation?.staleRows, registry);
    } else {
      prReconciliation = {
        ok: false,
        baseBranch,
        cwd: null,
        pullRequests: [],
        staleRows: [],
        error: 'no git repository cwd found for supervise reconciliation',
      };
    }
  }
  const { summarizeWaveJoin } = require('./wave-join.cjs');
  const waves = summarizeWaveJoin(rows);
  if (json) {
    const now = Date.now();
    const followUps = rows.length
      ? followUpModule.updateFollowUpsFromSupervisorSnapshot({
          store: followUpStore,
          rows,
          children: rows.map((row: any) => ({
            taskId: row.taskId,
            branch: row.branch || null,
            prNumber: row.prNumber != null ? row.prNumber : null,
            prUrl: row.prUrl || null,
            prState: row.prState || null,
            checkState: row.checkState || null,
            mergeable: row.mergeable || null,
            stuckTicks: row.stuckTicks || 0,
          })),
          prReconciliation,
          now,
        })
      : { records: [], pings: [], digest: followUpStore.digest({ workspaceId: workspace, now }) };
    emitOk({ workspace, rows, prReconciliation, waves, followUps });
  } else {
    process.stdout.write(renderSuperviseTable(rows));
  }
  return 0;
}

async function handleDescribe(cmdEntry: any, parsed: any, { json }: any) {
  const target = parsed.positionals.join(' ').trim();
  if (parsed.flags.markdown) {
    process.stdout.write(renderManifestMarkdown());
    return 0;
  }
  if (!target) {
    emitOk(describeManifest());
    return 0;
  }
  const found = COMMANDS.find((c: any) => c.cli === target);
  if (!found) {
    die({
      code: 6,
      error: 'unknown_command',
      message: `no command named '${target}'`,
      details: { name: target },
    });
  }
  emitOk(found);
  return 0;
}

function expandWorkspacePath(rawPath: any) {
  const raw = String(rawPath || '').trim();
  if (!raw) {
    die({
      code: 2,
      error: 'missing_arg',
      message: 'required flag --path not provided',
      details: { flag: '--path', command: 'workspace create' },
    });
  }
  const expanded = raw === '~'
    ? os.homedir()
    : raw.startsWith(`~${path.sep}`)
      ? path.join(os.homedir(), raw.slice(2))
      : raw;
  return path.resolve(expanded);
}

async function handleWorkspaceCreate(client: any, parsed: any) {
  const flags = parsed.flags || {};
  const workspacePath = expandWorkspacePath(flags.path);
  let existed = false;
  try {
    const stat = fs.statSync(workspacePath);
    existed = true;
    if (!stat.isDirectory()) {
      die({
        code: 2,
        error: 'not_directory',
        message: `workspace path exists but is not a directory: ${workspacePath}`,
        details: { path: workspacePath },
      });
    }
  } catch (err: any) {
    if (err?.code !== 'ENOENT') throw err;
  }

  const dryRun = flags.dryRun === true;
  if (dryRun) {
    return {
      workspaceId: null,
      path: workspacePath,
      existed,
      createdDirectory: false,
      wouldCreateDirectory: !existed,
      initialized: false,
      wouldInitialize: flags.initGit === true,
      dryRun: true,
    };
  }

  if (!client) throw new Error('workspace create requires a Ace transport');
  if (!existed) fs.mkdirSync(workspacePath, { recursive: true });
  const imported = await client.invoke('importWorkspace', { workspacePath });
  const workspaceId = imported?.id || imported?.workspaceId;
  if (!workspaceId) {
    throw new Error('workspace create: importWorkspace returned no workspace id');
  }
  let initialized = false;
  if (flags.initGit === true) {
    await client.invoke('initializeWorkspace', { workspaceId });
    initialized = true;
    await client.invoke('refreshWorkspace', { workspaceId }).catch(() => null);
  }
  return {
    workspaceId,
    path: workspacePath,
    existed,
    createdDirectory: !existed,
    initialized,
    dryRun: false,
  };
}

async function handleWorkspaceBaseBranch(client: any, parsed: any, { json }: any) {
  const workspaceId = parsed.flags.workspace;
  const branch = parsed.flags.set;
  const clear = parsed.flags.clear === true || parsed.flags.unset === true;
  if (branch && clear) {
    const err: any = new Error('workspace base-branch accepts either --set or --clear/--unset, not both');
    err.code = 'invalid_args';
    throw err;
  }
  const method = branch || clear ? 'projectsSetBaseBranch' : 'projectsGetEffectiveBaseBranch';
  const result = await client.invoke(method, branch
    ? { projectId: workspaceId, branch }
    : clear
      ? { projectId: workspaceId, clear: true }
      : { projectId: workspaceId });
  if (json) {
    emitOk(result);
  } else {
    process.stdout.write(`${result?.effectiveBaseBranch || ''}\n`);
  }
  return 0;
}

async function handleDoctorWorkspace(client: any) {
  const ctx = ctxFromEnv(process.env);
  const activeInstanceTag = resolveActiveInstanceTag({ env: process.env });
  const workspaces = await fetchActiveWorkspaceSummaries(client);
  return {
    activeInstanceTag,
    callerInstanceTag: ctx.callerInstanceTag,
    callerWorkspaceId: ctx.workspaceId,
    mismatch: Boolean(
      ctx.workspaceId &&
      ctx.callerInstanceTag &&
      activeInstanceTag &&
      ctx.callerInstanceTag !== activeInstanceTag
    ),
    workspacesInActiveInstance: workspaces
      .filter((workspace: any) => workspace.id && workspace.name)
      .map((workspace: any) => ({ id: workspace.id, name: workspace.name })),
  };
}

async function resolveWorkspaceProjectDir(client: any, workspaceId: any) {
  const id = normalizeText(workspaceId);
  if (!id) return null;
  const workspaces = await fetchActiveWorkspaceSummaries(client).catch(() => []);
  const workspace = workspaces.find((row: any) => row.id === id);
  if (workspace?.path) return workspace.path;
  const tracked = await client.invoke('streamTrackedGithubProjects', {}).catch(() => null);
  const project = (tracked?.projects || []).find((row: any) => row.workspaceId === id);
  return project?.workspacePath || null;
}

function userDataPathForTag(tag: any) {
  const clean = normalizeText(tag) || 'Ace';
  if (path.isAbsolute(clean)) return clean;
  const local = path.join(os.homedir(), 'Library', 'Application Support', clean);
  const envRoot = normalizeText(process.env.ACE_DATA_ROOT || process.env.ACE_EXTERNAL_DATA_ROOT);
  if (envRoot) return path.resolve(envRoot.replace(/^~(?=$|[\\/])/, os.homedir()));

  const configured = tryReadJson(path.join(local, 'external-data-root.json'));
  if (configured?.enabled === true && configured.root) {
    return path.resolve(String(configured.root).replace(/^~(?=$|[\\/])/, os.homedir()));
  }
  return local;
}

function readTerminalCwd(configPath: any) {
  try {
    const text = fs.readFileSync(configPath, 'utf8');
    const match = text.match(/^\s*cwd:\s*(.+)$/m);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

function checkHermesHome({ workspaceId, repoRoot, activeInstanceTag }: any) {
  const warnings: string[] = [];
  const userDataPath = userDataPathForTag(activeInstanceTag);
  const hermesHomePath = path.join(userDataPath, `hermes-home-${String(workspaceId || '').replace(/[^\w.-]/g, '_')}`);
  const skillsPath = path.join(hermesHomePath, 'skills');
  const stateDbPath = path.join(hermesHomePath, 'state.db');
  const configPath = path.join(hermesHomePath, 'config.yaml');
  const requiredSkills = ['ace-task-worker', 'ace-runtime-contract', 'ace-github-flow'];
  const missingSkills = requiredSkills.filter((skill) => !fs.existsSync(path.join(skillsPath, skill, 'SKILL.md')));
  const exists = fs.existsSync(hermesHomePath);
  const skillsExists = fs.existsSync(skillsPath);
  const skillsSymlink = (() => {
    try { return fs.lstatSync(skillsPath).isSymbolicLink(); } catch { return false; }
  })();
  const terminalCwd = readTerminalCwd(configPath);
  if (!exists) warnings.push(`workspace Hermes home missing: ${hermesHomePath}`);
  if (!skillsExists) warnings.push(`skills path missing: ${skillsPath}`);
  if (skillsExists && !skillsSymlink) warnings.push('skills path is not a symlink; verify it is Ace-controlled');
  if (missingSkills.length) warnings.push(`missing required Ace skills: ${missingSkills.join(', ')}`);
  if (terminalCwd && repoRoot && path.resolve(terminalCwd) !== path.resolve(repoRoot)) {
    warnings.push(`Hermes terminal cwd ${terminalCwd} does not match workspace repo ${repoRoot}`);
  }
  const hermesStatus = !exists ? 'fail' : (fs.existsSync(stateDbPath) ? 'ok' : 'degraded');
  const skillsStatus = !skillsExists || missingSkills.length ? 'fail' : (skillsSymlink ? 'ok' : 'degraded');
  return {
    userDataPath,
    hermesHomePath,
    stateDbPath,
    stateDbLocal: stateDbPath.startsWith(hermesHomePath),
    terminalCwd,
    hermesStatus,
    skillsStatus,
    warnings,
  };
}

function githubAuthStatus() {
  try {
    execFileSync('gh', ['auth', 'status'], { stdio: 'ignore', timeout: 5000 });
    return 'ok';
  } catch (err: any) {
    if (err?.code === 'ENOENT') return 'unknown';
    return 'fail';
  }
}

function wikiMirrorPaths() {
  const root = process.env.ACE_WIKI_ROOT && String(process.env.ACE_WIKI_ROOT).trim()
    ? path.resolve(String(process.env.ACE_WIKI_ROOT).trim())
    : path.join(os.homedir(), 'wiki', 'ace-ops');
  return {
    currentStatePath: process.env.ACE_WIKI_PATH && String(process.env.ACE_WIKI_PATH).trim()
      ? path.resolve(String(process.env.ACE_WIKI_PATH).trim())
      : path.join(root, 'dashboards', 'current-state.md'),
    logPath: process.env.ACE_WIKI_LOG_PATH && String(process.env.ACE_WIKI_LOG_PATH).trim()
      ? path.resolve(String(process.env.ACE_WIKI_LOG_PATH).trim())
      : path.join(root, 'log.md'),
  };
}

function compactMissionLinesFromCurrentState(text: string, missionId: string) {
  const sectionStart = `<!-- ace:section:start id=mission:${missionId} -->`;
  const sectionEnd = `<!-- ace:section:end id=mission:${missionId} -->`;
  const start = text.indexOf(sectionStart);
  const end = text.indexOf(sectionEnd, start);
  const section = start >= 0 && end > start ? text.slice(start, end) : text;
  return section
    .split(/\r?\n/)
    .filter((line) => /^- \[[^\]]+\]\s+/.test(line))
    .map((line) => line.includes(`mission=${missionId}`)
      ? line
      : line.replace(/^(- \[[^\]]+\]\s+\S+(?: \([^)]+\))?)/, `$1 mission=${missionId}`))
    .filter(Boolean);
}

function ensureWikiLogHasMission(currentStatePath: string, logPath: string, missionId: string) {
  let currentText = '';
  let logText = '';
  try { currentText = fs.readFileSync(currentStatePath, 'utf8'); } catch {}
  try { logText = fs.readFileSync(logPath, 'utf8'); } catch {}
  if (!currentText.includes(missionId) || logText.includes(missionId)) {
    return { currentStateAppears: currentText.includes(missionId), logEventAppears: logText.includes(missionId), backfilled: false };
  }
  const lines = compactMissionLinesFromCurrentState(currentText, missionId)
    .filter((line) => !logText.includes(line));
  if (lines.length) {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, `${lines.join('\n')}\n`);
    logText = fs.readFileSync(logPath, 'utf8');
  }
  return { currentStateAppears: currentText.includes(missionId), logEventAppears: logText.includes(missionId), backfilled: lines.length > 0 };
}

async function handleControlPlaneStatus(client: any, parsed: any) {
  const flags = parsed.flags || {};
  const workspaceId = normalizeText(flags.workspace);
  if (!workspaceId) throw new Error('--workspace required');
  const warnings: string[] = [];
  const activeInstanceTag = resolveActiveInstanceTag({ env: process.env });
  const repoRoot = await resolveWorkspaceProjectDir(client, workspaceId);
  if (!repoRoot) warnings.push(`workspace repo root not found for ${workspaceId}`);

  // Mission-board reporting retired with the mission domain; the run-ledger
  // spine (`run board`) is now the lifecycle projection. Keys kept with
  // retired/empty values to preserve the control-plane status return shape.
  const missionBoard: any = 'retired';
  const activeNextActions: any[] = [];
  const hermes = checkHermesHome({ workspaceId, repoRoot, activeInstanceTag });
  warnings.push(...hermes.warnings);
  const ledgerPath = repoRoot
    ? toolContract.resolveLedgerPath({ projectDir: repoRoot, createExplicit: false })
    : toolContract.resolveLedgerPath({ createExplicit: false });
  const wikiPath = path.join(os.homedir(), 'wiki', 'ace-ops', 'dashboards', 'current-state.md');
  const wikiHealth = fs.existsSync(wikiPath) ? 'healthy' : 'degraded';
  const version = buildVersionPayload();
  const expectation = runtimeExpectation(version, expectedRuntimeSha(flags));
  return {
    workspaceId,
    repoRoot,
    aceSocket: 'ok',
    missionBoard,
    hermesHome: hermes.hermesStatus,
    skills: hermes.skillsStatus,
    toolLedgerPath: ledgerPath,
    wikiPath,
    wikiHealth,
    githubAuth: githubAuthStatus(),
    activeNextActions,
    sourceRuntime: {
      sourcePath: version.sourcePath,
      cliPath: version.cliPath,
      sourceSha: version.gitSha,
      runtimeSha: version.gitSha,
      installedSha: version.packaged ? version.gitSha : null,
      gitSource: version.gitSource,
      buildInfo: version.buildInfo,
      runtimeExpectation: expectation,
      packaged: version.packaged,
      sourceMode: version.sourceMode,
      driftWarning: version.packaged ? null : 'running source checkout; use --expected-runtime-sha after rebuild/relaunch to validate the installed app',
    },
    warnings,
    hermesHomePath: hermes.hermesHomePath,
    stateDbPath: hermes.stateDbPath,
    stateDbLocal: hermes.stateDbLocal,
    terminalCwd: hermes.terminalCwd,
  };
}

// Operations Cockpit status. THIN CLI shim: the probe logic lives in the
// electron core (electron/ops-status.cts) and is exposed as the `opsStatus`
// store method, so the CLI and the renderer share one implementation. This
// handler only normalizes flags + forwards the build-version payload (for
// runtime drift) and lets the core run the probes.
//
// Unlike handleControlPlaneStatus, --workspace is OPTIONAL here (system-wide
// when omitted); we never call the workspace-required control-plane handler.
async function handleOpsStatus(client: any, parsed: any) {
  const flags = parsed.flags || {};
  const workspaceId = normalizeText(flags.workspace);
  const probes = normalizeText(flags.probes);
  const configPath = normalizeText(flags.config);
  const expectedSha = expectedRuntimeSha(flags);
  const params: any = {
    workspaceId: workspaceId || null,
    probes: probes || null,
    configPath: configPath || null,
    expectedRuntimeSha: expectedSha || null,
    // Pass the CLI-computed version payload so the runtime probe can detect
    // build-hash drift without re-deriving git state inside electron.
    version: buildVersionPayload(),
    source: 'ace-cli',
  };
  return client.invoke('opsStatus', params);
}

async function handleSmokeFastLifecycle(client: any, parsed: any) {
  const flags = parsed.flags || {};
  const workspaceId = normalizeText(flags.workspace);
  if (!workspaceId) throw new Error('--workspace required');
  if (flags.noCode !== true) throw new Error('smoke fast-lifecycle is non-destructive; pass --no-code');
  const steps: any[] = [];
  const sideEffects = {
    validatorSpawned: false,
    pushed: false,
    openedPr: false,
    merged: false,
    cleanup: false,
  };
  const status = await handleControlPlaneStatus(client, parsed);
  steps.push({ step: 'control-plane status', ok: status.aceSocket === 'ok', status });
  const risk = changeRiskPolicy.classifyChangeRisk({
    taskType: 'no-code',
    roleMode: 'no-code',
    goal: 'no-code fast lifecycle smoke diagnostic only',
    changedLineCount: 0,
    changedFiles: [],
  });
  steps.push({
    step: 'risk policy no-code bypass',
    ok: risk.riskClass === 'trivial' && risk.validationRequired === false,
    risk,
  });
  const next = require('./orchestration-policy.cjs').nextActionForFeature({
    worker: { dispatched: true, done: true, outcome: 'DONE' },
    spec: { taskType: 'no-code', roleMode: 'no-code', goal: 'no-code smoke fixture' },
    validationBypass: { allowed: true },
    pr: { exists: false },
    merge: { merged: false, cleanedUp: false },
  });
  steps.push({
    step: 'mission next policy callable',
    ok: next.next !== 'dispatch_goal_validator',
    next,
  });
  const clawpatch = {
    schema: toolContract.CLAWPATCH_SCHEMA,
    required: false,
    skipped: true,
    reason: 'risk-policy-not-required',
    riskClass: risk.riskClass,
    status: 'skipped',
  };
  steps.push({ step: 'clawpatch skipped', ok: clawpatch.skipped === true, clawpatch });
  const releaseGateDiagnostic = {
    status: 'PASS',
    release: {
      allowed: true,
      diagnostic: true,
      performsAction: false,
      reason: 'fast lifecycle diagnostic only; no product release action performed',
    },
  };
  steps.push({ step: 'release-gate diagnostic', ok: releaseGateDiagnostic.release.performsAction === false, releaseGate: releaseGateDiagnostic });
  return {
    ok: steps.every((step) => step.ok !== false),
    workspaceId,
    smokeKind: 'fast-lifecycle',
    noCode: true,
    validationRequired: risk.validationRequired,
    clawpatch,
    sideEffects,
    steps,
  };
}

function communicationCallerContext(command: any) {
  const ctx = ctxFromEnv(process.env);
  if (!ctx.streamId) return undefined;
  return {
    streamId: ctx.streamId,
    identity: ctx.personalIdentity || null,
    agent: ctx.agent || null,
    taskId: ctx.taskId || null,
    command,
  };
}

function handleWatch(client: any, parsed: any) {
  if (client.transport !== 'socket') {
    die({
      code: 2,
      error: 'invalid_choice',
      message: 'watch requires the local Unix socket transport (do not set ACE_URL).',
      details: { transport: client.transport },
    });
  }
  const filterId = parsed.flags.id || null;
  const filterEvents = parsed.flags.event || null;
  const allowed = filterEvents
    ? new Set(String(filterEvents).split(',').map((s: any) => s.trim()).filter(Boolean))
    : null;
  return new Promise(() => {
    client.onEvent((msg: any) => {
      if (allowed && !allowed.has(msg.event)) return;
      if (filterId && msg.payload?.streamId !== filterId) return;
      printJson(msg);
    });
    // Block forever — Ctrl+C exits the process.
  });
}

const DEFAULT_INLINE_ACCEPTANCE = 'Worker emits a DONE or BLOCKED trailer.';
const GOAL_LAUNCH_SCHEMA = 'AceGoalLaunchResult/v1';
const GOAL_LAUNCH_DIRECT_SIZES = new Set(['tiny', 'small']);
const GOAL_LAUNCH_ORCHESTRATOR_SIZES = new Set(['medium', 'large']);

function normalizeInlineMode(value: any) {
  return String(value || '').trim().toLowerCase();
}

function normalizeGoalLaunchSize(value: any) {
  const size = String(value || 'auto').trim().toLowerCase();
  if (size === 'auto' || GOAL_LAUNCH_DIRECT_SIZES.has(size) || GOAL_LAUNCH_ORCHESTRATOR_SIZES.has(size)) {
    return size;
  }
  die({
    code: 2,
    error: 'invalid_choice',
    message: `goal launch --size must be one of auto|tiny|small|medium|large, got ${value}`,
    details: { command: 'goal launch', size: value },
  });
}

function readGoalLaunchBrief(flags: any) {
  const parts = [];
  if (flags.goal) parts.push(String(flags.goal).trim());
  if (flags.brief) {
    try {
      parts.push(fs.readFileSync(flags.brief, 'utf8').trim());
    } catch (err) {
      die({
        code: 2,
        error: 'missing_arg',
        message: `cannot read goal launch --brief ${flags.brief}: ${err.message}`,
        details: { command: 'goal launch', brief: flags.brief },
      });
    }
  }
  const brief = parts.filter(Boolean).join('\n\n');
  if (!brief) {
    die({
      code: 2,
      error: 'missing_arg',
      message: 'goal launch requires --goal TEXT, --brief FILE, or both',
      details: { command: 'goal launch' },
    });
  }
  return brief;
}

function isTrivialGoalLaunchBrief(brief: any) {
  const text = String(brief || '').replace(/\s+/g, ' ').trim();
  if (text.length > 180) return false;
  return /\b(typo|spelling|copy|readme|one[- ]liner|small bug|obvious fix|simple fix)\b/i.test(text);
}

function goalLaunchModeFor(size: any, brief: any) {
  if (GOAL_LAUNCH_DIRECT_SIZES.has(size)) return 'direct-worker';
  if (GOAL_LAUNCH_ORCHESTRATOR_SIZES.has(size)) return 'research-grill';
  return isTrivialGoalLaunchBrief(brief) ? 'direct-worker' : 'research-grill';
}

function firstGoalLine(brief: any) {
  const line = String(brief || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean) || 'Ace goal';
  return line.length <= 120 ? line : `${line.slice(0, 117).trim()}...`;
}

function goalLaunchLabel(flags: any, mode: any, brief: any) {
  if (flags.label) return flags.label;
  const head = firstGoalLine(brief).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 36) || 'goal';
  return mode === 'direct-worker' ? `${head}-worker` : `${head}-research-grill`;
}

function goalLaunchAcceptance(flags: any, mode: any) {
  if (flags.acceptance?.length) return flags.acceptance;
  return mode === 'direct-worker'
    ? ['The change described in the brief is in place and behaves as described; you verified it directly and recorded the evidence (command output or observed behavior).']
    : ['Grill the owner until ambiguity is gone, research the codebase, and emit a rigorous PRD (goal, non-goals, an outcome-level definition of done, allowed-paths). Then implement against the PRD using internal sub-agents only, self-validate that each outcome holds with evidence, and report DONE with the PR or BLOCKED.'];
}

function buildGoalLaunchSpec(flags: any) {
  const workspaceId = String(flags.workspace || '').trim();
  const brief = readGoalLaunchBrief(flags);
  const size = normalizeGoalLaunchSize(flags.size);
  const launchMode = goalLaunchModeFor(size, brief);
  const context = [
    'Hermes intake brief:',
    brief,
    flags.context ? `Additional context:\n${flags.context}` : '',
  ].filter(Boolean).join('\n\n');
  const constraints = launchMode === 'direct-worker'
    ? [
        'This is a Hermes fast-lane direct goal-agent launch for a tiny/small deterministic task.',
        'Use this task worktree only; do not spawn additional Ace workers unless the task is impossible without returning BLOCKED. You may use internal sub-agents within your own lane only.',
        'Keep changes surgical and scoped to the request. Read the relevant files before editing and apply the change at every relevant site.',
        ...(flags.constraint || []),
      ]
    : [
        'You are a research+grill+PRD agent spawned from Hermes intake (no orchestra).',
        'First GRILL the owner with sharp clarifying questions until ambiguity is gone (you have the grill skills); the owner answers — this is cheap and prevents rework.',
        'Then research the codebase + blast radius and write a rigorous PRD: goal, non-goals, an outcome-level definition of done (observable behaviors / bug no longer reproducing / contract satisfied — NOT a dictated list of test cases), and an explicit allowed-paths list.',
        'Then IMPLEMENT against the PRD in this same lane by spawning INTERNAL sub-agents only — Claude Task tool / dynamic-workflow agent() with isolation:\'worktree\', or Codex sub-processes. Each internal sub-agent loads the engineering skill pack. Cap fan-out at 3-5 and merge sub-worktrees back onto this branch before final DONE.',
        `Do NOT spawn external Ace workers (no ${CLI_NAME} task run --new-task) and do NOT create a standing orchestrator. All spawning is internal to this lane.`,
        'Self-validate that each outcome in the definition of done holds, with evidence (you choose how to test); then push + open a PR and report DONE with the PR, or BLOCKED with the exact reason.',
        'Do not create hidden daemons, queues, raw PR merges, or non-Ace side channels.',
        ...(flags.constraint || []),
      ];
  return {
    launchMode,
    workspaceId,
    size,
    brief,
    label: goalLaunchLabel(flags, launchMode, brief),
    agent: launchMode === 'direct-worker'
      ? (String(flags.worker || '').trim() || null)
      : (String(flags.orchestratorAgent || 'claude').trim() || 'claude'),
    newTask: launchMode === 'direct-worker',
    spec: launchMode === 'direct-worker'
      ? {
          goal: firstGoalLine(brief),
          baseBranch: process.env.ACE_BASE_BRANCH || 'main',
          role: 'editor',
          scope: { workspaceId, cli: 'goal launch' },
          taskType: flags.taskType || 'feature-impl',
          roleMode: 'implementer',
          goalMode: 'on',
          context,
          constraints,
          deliverables: flags.deliverable || [],
          acceptance: goalLaunchAcceptance(flags, launchMode),
          requireChanges: true,
        }
      : {
          goal: `Research, grill, PRD, then implement from Hermes intake: ${firstGoalLine(brief)}`,
          baseBranch: process.env.ACE_BASE_BRANCH || 'main',
          role: 'editor',
          scope: { workspaceId, cli: 'goal launch' },
          taskType: 'research-grill',
          roleMode: 'no-code',
          taskClass: 'no_code_research',
          agentClass: 'orchestrator',
          preferredAgent: String(flags.orchestratorAgent || 'claude').trim() || 'claude',
          baselineSkills: ['ace-runtime-contract', 'ace-hermes-router'],
          optionalSkills: ['ace-internal-subagents', 'ace-integration'],
          promptBudgetOverrideReason: 'goal launch carries the Hermes intake brief to the research+grill+PRD agent',
          context,
          constraints,
          deliverables: flags.deliverable || [
            'Sharp grilling of the owner until ambiguity is gone',
            'A rigorous PRD (goal, non-goals, outcome-level definition of done, allowed-paths)',
            'Implementation against the PRD via internal sub-agents only, then a PR',
          ],
          acceptance: goalLaunchAcceptance(flags, launchMode),
          requireChanges: false,
          nativeTeamMode: 'optional',
        },
  };
}

function explainGoalLaunch(parsed: any) {
  const launch = buildGoalLaunchSpec(parsed.flags);
  const { buildTaskPromptEnvelope } = require('./prompt.cjs');
  const { routeForSpec, validatorPolicyForSpec } = require('./routing-policy.cjs');
  const { buildLaunchIntent, assertLaunchIntentSupported, telemetryWithTimings } = require('./orchestrator.cjs');
  const route = routeForSpec(launch.spec);
  const agent = launch.agent || route.agent;
  const { skillPlan, skillResolution } = resolveTaskRunSkillPlan(launch.spec);
  blockOnMissingRequiredSkills(skillResolution);
  const promptEnvelope = buildTaskPromptEnvelope(launch.spec, { driver: agent });
  const launchIntent = buildLaunchIntent(agent, {
    ...promptEnvelope.telemetry,
    effort: route.effort,
    toolMode: route.toolMode,
    mcpMode: route.mcpMode,
    baselineSkills: skillPlan.manifest.baselineSkills,
    taskPackSkills: skillPlan.manifest.taskPackSkills,
    validationSkills: skillPlan.manifest.validationSkills,
    requiredSkills: skillResolution.requiredSkills,
    optionalSkills: skillResolution.optionalSkills,
  });
  try {
    assertLaunchIntentSupported(launchIntent);
  } catch (err: any) {
    die({
      code: err.code || 2,
      error: err.error || 'invalid_spec',
      message: err.message || String(err),
      details: { command: 'goal launch' },
    });
  }
  return {
    schema: GOAL_LAUNCH_SCHEMA,
    dryRun: true,
    outcome: 'dry-run',
    launchMode: launch.launchMode,
    workspaceId: launch.workspaceId,
    size: launch.size,
    label: launch.label,
    agent,
    provider: agent,
    newTask: launch.newTask,
    fireAndForget: parsed.flags.wait !== true,
    briefChars: launch.brief.length,
    roleMode: route.roleMode,
    taskClass: route.taskClass,
    agentClass: route.agentClass,
    baselineSkills: skillPlan.manifest.baselineSkills,
    taskPackSkills: skillPlan.manifest.taskPackSkills,
    optionalSkills: skillResolution.optionalSkills,
    warnings: [
      ...skillResolution.warnings,
      ...(launchIntent?.warnings || []),
    ],
    promptChars: promptEnvelope.telemetry.renderedPromptChars,
    promptBudgetClass: promptEnvelope.telemetry.promptBudgetClass,
    promptBudgetExceeded: promptEnvelope.telemetry.promptBudgetExceeded,
    validationPolicy: validatorPolicyForSpec(launch.spec),
    route,
    spec: launch.spec,
    telemetry: telemetryWithTimings({
      driver: agent,
      provider: agent,
      routeAgent: route.agent,
      routeReason: route.reason,
      roleMode: route.roleMode,
      taskClass: route.taskClass,
      skillPack: route.skillPack,
      agentClass: route.agentClass,
      effort: route.effort,
      toolMode: route.toolMode,
      browserMode: route.browserMode,
      taskType: launch.spec.taskType || 'generic',
      capabilities: route.capabilities,
      renderedPromptChars: promptEnvelope.telemetry.renderedPromptChars,
      skillCount: promptEnvelope.telemetry.skillCount,
      mcpMode: route.mcpMode,
      baseRefreshMode: 'false',
      promptChars: promptEnvelope.telemetry.renderedPromptChars,
      promptBudgetClass: promptEnvelope.telemetry.promptBudgetClass,
      promptBudgetSoftChars: promptEnvelope.telemetry.promptBudgetSoftChars,
      promptBudgetHardChars: promptEnvelope.telemetry.promptBudgetHardChars,
      promptBudgetExceeded: promptEnvelope.telemetry.promptBudgetExceeded,
      launchIntent,
    }),
  };
}

// Repoint legacy intake through the spine: a NEW dispatch becomes a kernel intent
// (run-N), so the run-ledger owns the whole lifecycle (dispatch worktree+agent,
// validate, gate, owner-gated merge) — one nervous system, no bypass. The run
// advances ASYNCHRONOUSLY; this returns { runId } immediately (watch `run board`).
async function submitSpecToSpine(client: any, { spec, agent, workspaceId, label, risk }: any) {
  const intent: any = {
    goal: spec.goal,
    scope: { ...(spec.scope || {}), workspaceId, allow: spec.allowedPaths || (spec.scope && spec.scope.allow) || [] },
    acceptance: spec.acceptance || [],
    skillIds: [...(spec.baselineSkills || []), ...(spec.optionalSkills || [])],
  };
  if (agent) intent.agent = agent;
  if (spec.context) intent.context = spec.context;
  if (Array.isArray(spec.constraints) && spec.constraints.length) intent.constraints = spec.constraints;
  if (spec.taskType) intent.taskType = spec.taskType;
  if (label) intent.label = label;
  if (risk) intent.risk = risk;
  if (spec.autoShip) intent.autoShip = spec.autoShip;
  // Owner doctrine: an autonomous spine run must NEVER reach done on the worker's
  // own DONE alone — it requires the independent computer-use validator + its
  // evidence first. Force validation on (so a low-risk run does not take the
  // self-review bypass straight to the gate) and require computer-use evidence,
  // unless the caller explicitly opted out. A worker DONE therefore walks to the
  // validator and parks at ready_to_review (review) — gaps surface there, not as
  // a premature done. (Spine's runValidation is always the codex computer-use
  // validator, so "validation required" == "computer-use proof required".)
  intent.explicitValidationRequired = spec.explicitValidationRequired === false ? false : true;
  intent.computerUseRequired = spec.computerUseRequired === false ? false : true;
  // Carry the operator's EXPLICIT capability/tool opt-ins into the spine intent
  // so the dispatched worker actually gets them (runSpecFor reads them off the
  // run spec). Dropping them here silently downgrades an explicitly-requested
  // --tool-mode/--browser-mode/--capability to the route's 'off' default.
  if (spec.toolMode) intent.toolMode = spec.toolMode;
  if (spec.mcpMode) intent.mcpMode = spec.mcpMode;
  if (spec.browserMode) intent.browserMode = spec.browserMode;
  if (spec.codexRuntimeProfile) intent.codexRuntimeProfile = spec.codexRuntimeProfile;
  if (spec.toolOverrideReason) intent.toolOverrideReason = spec.toolOverrideReason;
  if (Array.isArray(spec.capabilities) && spec.capabilities.length) intent.capabilities = spec.capabilities;
  if (spec.effort) intent.effort = spec.effort;
  if (spec.effortOverrideReason) intent.effortOverrideReason = spec.effortOverrideReason;
  return client.invoke('runSubmit', { intent });
}

async function handleGoalLaunch(client: any, parsed: any) {
  if (parsed.flags.dryRun === true) return explainGoalLaunch(parsed);
  const launch = buildGoalLaunchSpec(parsed.flags);
  const { routeForSpec } = require('./routing-policy.cjs');
  const route = routeForSpec(launch.spec);
  const agent = launch.agent || route.agent;
  const { skillResolution } = resolveTaskRunSkillPlan(launch.spec);
  blockOnMissingRequiredSkills(skillResolution);
  for (const warning of skillResolution.warnings) {
    process.stderr.write(`WARN: ${warning}\n`);
  }

  if (launch.newTask && String(process.env.ACE_ROLE || '').toLowerCase() === 'orchestrator') {
    const audit = toolContract.auditToolUse({
      role: 'orchestrator',
      phase: 'start',
      workspaceId: launch.workspaceId || process.env.ACE_WORKSPACE_ID || null,
      projectDir: parsed.flags.projectDir || null,
    });
    if (!audit.ok) {
      return {
        schema: GOAL_LAUNCH_SCHEMA,
        outcome: 'done-unverified',
        launchMode: launch.launchMode,
        workspaceId: launch.workspaceId,
        detail: `tool contract missing for orchestrator.start: ${audit.missingRequiredEvents.join(', ')}`,
        created: false,
        toolAudit: audit,
      };
    }
  }

  const submit: any = await submitSpecToSpine(client, {
    spec: launch.spec,
    agent,
    workspaceId: launch.workspaceId,
    label: launch.label,
    risk: launch.size,
  });
  return {
    schema: GOAL_LAUNCH_SCHEMA,
    launchMode: launch.launchMode,
    workspaceId: launch.workspaceId,
    size: launch.size,
    label: launch.label,
    agent,
    newTask: launch.newTask,
    fireAndForget: true,
    // Honest intake outcome: the spine accepted the run and drives dispatch
    // asynchronously — no worker is dispatched at this point. The board reports
    // 'dispatched' only once a real stream/task/worktree is created and linked.
    outcome: 'submitted',
    runId: submit && submit.runId,
    detail: `run-ledger intake ${submit && submit.runId} — the spine drives dispatch→validate→gate (watch: ${CLI_NAME} run board)`,
    result: submit,
  };
}

function isReadOnlyRoleMode(value: any) {
  const mode = normalizeInlineMode(value);
  return mode === 'reviewer' || mode === 'no-code';
}

function isNoCodeTaskType(value: any) {
  const type = normalizeInlineMode(value);
  return type === 'no-code' || type === 'research' || type === 'planning' || type === 'plan';
}

function inlineScopeFromFlags(flags: any) {
  const scope: any = {};
  if (flags.workspace) scope.workspaceId = flags.workspace;
  if (flags.task) scope.taskId = flags.task;
  if (flags.stream) scope.streamId = flags.stream;
  return Object.keys(scope).length ? scope : { cli: 'task run' };
}

function buildInlineSpec(flags: any) {
  if (!flags.goal) return null;
  const roleMode = flags.roleMode || (isNoCodeTaskType(flags.taskType) ? 'no-code' : undefined);
  const spec: any = {
    goal: flags.goal,
    baseBranch: process.env.ACE_BASE_BRANCH || 'main',
    role: isReadOnlyRoleMode(roleMode) ? 'viewer' : (flags.newTask === true || flags.task ? 'editor' : 'viewer'),
    scope: inlineScopeFromFlags(flags),
    taskType: flags.taskType,
    roleMode,
    context: flags.context,
    constraints: flags.constraint || [],
    deliverables: flags.deliverable || [],
    acceptance: (flags.acceptance && flags.acceptance.length)
      ? flags.acceptance
      : [DEFAULT_INLINE_ACCEPTANCE],
    escapeHatch: flags.escapeHatch,
    promptBudgetOverrideReason: flags.promptBudgetOverride,
    goalMode: flags.goalMode,
  };
  if (flags.skillPack) spec.skillPack = flags.skillPack;
  if (flags.effort) spec.effort = flags.effort;
  if (flags.effortOverride) spec.effortOverrideReason = flags.effortOverride;
  if (flags.toolMode) spec.toolMode = flags.toolMode;
  if (flags.mcpMode) spec.mcpMode = flags.mcpMode;
  if (flags.browserMode) spec.browserMode = flags.browserMode;
  if (flags.codexRuntimeProfile) spec.codexRuntimeProfile = flags.codexRuntimeProfile;
  if (flags.toolOverride) spec.toolOverrideReason = flags.toolOverride;
  if (flags.capability?.length) spec.capabilities = flags.capability;
  if (flags.baselineSkill?.length) spec.baselineSkills = flags.baselineSkill;
  if (flags.taskPackSkill?.length) spec.taskPackSkills = flags.taskPackSkill;
  if (flags.validationSkill?.length) spec.validationSkills = flags.validationSkill;
  if (flags.requiredSkill?.length) spec.requiredSkills = flags.requiredSkill;
  if (flags.optionalSkill?.length) spec.optionalSkills = flags.optionalSkill;
  if (isReadOnlyRoleMode(roleMode)) spec.requireChanges = false;
  return spec;
}

function validateTaskSpec(input: any, source: any, details: any = {}) {
  const { parseSpec } = require('./spec.cjs');
  try {
    return parseSpec(input);
  } catch (err) {
    die({
      code: 2,
      error: 'invalid_spec',
      message: `task run ${source} failed TaskSpec validation: ${err?.message || err}`,
      details,
    });
  }
}

function loadSpec(specPath: any, inlineSpec: any) {
  if (specPath) {
    let raw;
    try {
      raw = fs.readFileSync(specPath, 'utf8');
    } catch (err) {
      die({
        code: 2,
        error: 'missing_arg',
        message: `cannot read spec file ${specPath}: ${err.message}`,
        details: { spec: specPath },
      });
    }
    return validateTaskSpec(raw, `spec file ${specPath}`, { spec: specPath });
  }
  if (inlineSpec) return validateTaskSpec(inlineSpec, 'inline --goal', { command: 'task run' });
  return null;
}

// Explicit CLI capability/tool flags must WIN over a --spec FILE. loadSpec
// returns the file spec verbatim and ignores the inline flags, so without this
// merge an operator who runs `task run --spec foo.json --tool-mode on
// --capability computer-use` would have those flags silently dropped (and the
// route would default the missing modes to 'off'). Apply the explicit flags
// on top of the loaded spec so the operator's intent is honored, not downgraded.
function applyExplicitCapabilityFlags(spec: any, flags: any) {
  if (!spec || !flags) return spec;
  if (flags.toolMode) spec.toolMode = flags.toolMode;
  if (flags.mcpMode) spec.mcpMode = flags.mcpMode;
  if (flags.browserMode) spec.browserMode = flags.browserMode;
  if (flags.codexRuntimeProfile) spec.codexRuntimeProfile = flags.codexRuntimeProfile;
  if (flags.toolOverride) spec.toolOverrideReason = flags.toolOverride;
  if (flags.effort) spec.effort = flags.effort;
  if (flags.effortOverride) spec.effortOverrideReason = flags.effortOverride;
  if (flags.capability?.length) spec.capabilities = flags.capability;
  return spec;
}

function prepareTaskRunSpec(parsed: any) {
  const flags = parsed.flags;
  const inlineSpec = buildInlineSpec(flags);
  const spec = loadSpec(flags.spec, inlineSpec);
  // Explicit CLI capability flags override the loaded spec (file OR inline).
  applyExplicitCapabilityFlags(spec, flags);
  if (!spec || !spec.goal) {
    die({
      code: 2,
      error: 'missing_arg',
      message: 'task run requires --spec FILE or --goal TEXT',
      details: { command: 'task run' },
    });
  }
  if (!spec.roleMode && isNoCodeTaskType(spec.taskType)) spec.roleMode = 'no-code';
  if (isReadOnlyRoleMode(spec.roleMode)) {
    spec.role = 'viewer';
    spec.requireChanges = false;
  }
  return spec;
}

function resolveTaskRunSkillPlan(spec: any) {
  const { resolveSkills } = require('./prompt.cjs');
  const { resolveSkillRequirements } = require('./skill-loader.cjs');
  const skillPlan = resolveSkills(spec);
  const skillResolution = resolveSkillRequirements(skillPlan.manifest);
  return { skillPlan, skillResolution };
}

function blockOnMissingRequiredSkills(skillResolution: any) {
  if (!skillResolution?.errors?.length) return;
  die({
    code: 2,
    error: 'missing_required_skill',
    message: skillResolution.errors.join('; '),
    details: {
      command: 'task run',
      missingRequired: skillResolution.missingRequired,
    },
  });
}

function explainTaskRunRoute(parsed: any) {
  const spec = parsed.taskRunSpec || prepareTaskRunSpec(parsed);
  const { buildTaskPromptEnvelope } = require('./prompt.cjs');
  const { routeForSpec, validatorPolicyForSpec } = require('./routing-policy.cjs');
  const {
    buildLaunchIntent,
    assertLaunchIntentSupported,
    mcpModeForProvider,
    normalizeRefreshBaseMode,
    taskRunResult,
    telemetryWithTimings,
    effectiveStreamKindForTask,
  } = require('./orchestrator.cjs');
  const route = routeForSpec(spec);
  const positionalAgent = parsed.positionals[0] || '';
  const agent = positionalAgent || route.agent;
  const routeReason = positionalAgent ? 'positional-agent-override' : route.reason;
  const { skillPlan, skillResolution } = resolveTaskRunSkillPlan(spec);
  blockOnMissingRequiredSkills(skillResolution);
  let promptEnvelope;
  try {
    promptEnvelope = buildTaskPromptEnvelope(spec, { driver: agent });
  } catch (err) {
    die({
      code: 2,
      error: 'invalid_spec',
      message: err?.message || String(err),
      details: { command: 'task run' },
    });
  }
  const validationPolicy = validatorPolicyForSpec(spec);
  const baseRefreshMode = normalizeRefreshBaseMode(parsed.flags.refreshBase || 'false');
  const launchIntent = buildLaunchIntent(agent, {
    ...promptEnvelope.telemetry,
    effort: route.effort,
    toolMode: route.toolMode,
    mcpMode: route.mcpMode,
    baselineSkills: skillPlan.manifest.baselineSkills,
    taskPackSkills: skillPlan.manifest.taskPackSkills,
    validationSkills: skillPlan.manifest.validationSkills,
    requiredSkills: skillResolution.requiredSkills,
    optionalSkills: skillResolution.optionalSkills,
  });
  try {
    assertLaunchIntentSupported(launchIntent);
  } catch (err: any) {
    die({
      code: err.code || 2,
      error: err.error || 'invalid_spec',
      message: err.message || String(err),
      details: { command: 'task run' },
    });
  }
  const warnings = [
    ...skillResolution.warnings,
    ...(launchIntent?.warnings || []),
  ];
  return taskRunResult({
    dryRun: true,
    outcome: 'dry-run',
    detail: `${agent} via ${routeReason}`,
    agent,
    provider: agent,
    streamKind: effectiveStreamKindForTask(parsed.flags.kind || 'cli', spec),
    roleMode: route.roleMode,
    taskClass: route.taskClass,
    agentClass: route.agentClass,
    effort: route.effort,
    toolMode: route.toolMode,
    mcpMode: route.mcpMode,
    browserMode: route.browserMode,
    baselineSkills: skillPlan.manifest.baselineSkills,
    taskPackSkills: skillPlan.manifest.taskPackSkills,
    validationSkills: skillPlan.manifest.validationSkills,
    requiredSkills: skillResolution.requiredSkills,
    optionalSkills: skillResolution.optionalSkills,
    warnings,
    promptChars: promptEnvelope.telemetry.renderedPromptChars,
    promptBudgetClass: promptEnvelope.telemetry.promptBudgetClass,
    promptBudgetSoftChars: promptEnvelope.telemetry.promptBudgetSoftChars,
    promptBudgetHardChars: promptEnvelope.telemetry.promptBudgetHardChars,
    promptBudgetExceeded: promptEnvelope.telemetry.promptBudgetExceeded,
    promptBudgetOverrideReason: promptEnvelope.telemetry.promptBudgetOverrideReason,
    validationPolicy,
    route,
    telemetry: telemetryWithTimings({
      driver: agent,
      provider: agent,
      routeAgent: route.agent,
      routeReason,
      roleMode: route.roleMode,
      taskClass: route.taskClass,
      skillPack: route.skillPack,
      agentClass: route.agentClass,
      effort: route.effort,
      toolMode: route.toolMode,
      browserMode: route.browserMode,
      taskType: spec.taskType || 'generic',
      capabilities: route.capabilities,
      renderedPromptChars: promptEnvelope.telemetry.renderedPromptChars,
      skillCount: promptEnvelope.telemetry.skillCount,
      mcpMode: route.mcpMode,
      baseRefreshMode,
      promptChars: promptEnvelope.telemetry.renderedPromptChars,
      promptBudgetClass: promptEnvelope.telemetry.promptBudgetClass,
      promptBudgetSoftChars: promptEnvelope.telemetry.promptBudgetSoftChars,
      promptBudgetHardChars: promptEnvelope.telemetry.promptBudgetHardChars,
      promptBudgetExceeded: promptEnvelope.telemetry.promptBudgetExceeded,
      launchIntent,
    }),
  });
}

async function handleTaskRun(client: any, parsed: any) {
  const flags = parsed.flags;
  const spec = parsed.taskRunSpec || prepareTaskRunSpec(parsed);
  const { routeForSpec } = require('./routing-policy.cjs');
  const route = routeForSpec(spec);
  const agent = parsed.positionals[0] || route.agent;
  if (flags.dryRun === true) return explainTaskRunRoute(parsed);
  const { skillResolution } = resolveTaskRunSkillPlan(spec);
  blockOnMissingRequiredSkills(skillResolution);
  for (const warning of skillResolution.warnings) {
    process.stderr.write(`WARN: ${warning}\n`);
  }

  const newTask = flags.newTask === true;
  if (newTask) {
    if (!flags.workspace) {
      die({
        code: 2,
        error: 'missing_arg',
        message: '--new-task requires --workspace <id>',
        details: { command: 'task run' },
      });
    }
    if (flags.task || flags.stream) {
      die({
        code: 2,
        error: 'invalid_choice',
        message: '--new-task conflicts with --task / --stream',
        details: { command: 'task run' },
      });
    }
  }

  if (newTask && String(process.env.ACE_ROLE || '').toLowerCase() === 'orchestrator') {
    const audit = toolContract.auditToolUse({
      role: 'orchestrator',
      phase: 'start',
      workspaceId: flags.workspace || process.env.ACE_WORKSPACE_ID || null,
      projectDir: flags.projectDir || null,
    });
    if (!audit.ok) {
      const { taskRunResult } = require('./orchestrator.cjs');
      return taskRunResult({
        outcome: 'done-unverified',
        detail: `tool contract missing for orchestrator.start: ${audit.missingRequiredEvents.join(', ')}`,
        rounds: 0,
        verifyRounds: 0,
        fireAndForget: flags.fireAndForget === true,
        created: false,
        toolAudit: audit,
      });
    }
  }

  const rc = flags.requireChanges;
  let requireChanges;
  if (rc === 'true') requireChanges = true;
  else if (rc === 'false') requireChanges = false;
  else requireChanges = undefined; // 'auto' or unset → resolve inside runTask

  if (newTask) {
    // A NEW dispatch routes through the spine (one nervous system). Steering an
    // existing --task/--stream is a message to a LIVE agent, not a new run, so it
    // stays on the direct path below.
    const submit: any = await submitSpecToSpine(client, {
      spec,
      agent,
      workspaceId: flags.workspace,
      label: flags.label,
      risk: spec.size,
    });
    return {
      // Honest intake outcome: the spine has ACCEPTED the run and will drive
      // dispatch asynchronously. The worker is NOT dispatched yet, so we never
      // claim 'dispatched' here — the board flips to dispatched only once a real
      // stream/task/worktree is created and linked (else it blocks with the
      // exact spawn/link error). Watch `run board` for the live status.
      outcome: 'submitted',
      runId: submit && submit.runId,
      agent,
      workspaceId: flags.workspace,
      fireAndForget: true,
      detail: `run-ledger intake ${submit && submit.runId} — the spine drives dispatch→validate→gate (watch: ${CLI_NAME} run board)`,
      result: submit,
    };
  }

  const { runTask } = require('./orchestrator.cjs');
  const result = await runTask(client, {
    agent,
    streamId: flags.stream,
    taskId: flags.task,
    workspaceId: flags.workspace,
    newTask,
    kind: flags.kind || 'cli',
    label: flags.label,
    spec,
    maxRounds: flags.maxRounds,
    maxVerifyRounds: flags.maxVerifyRounds,
    goalMode: flags.goalMode || spec.goalMode,
    requireChanges,
    waitTimeoutMs: flags.timeout,
    fireAndForget: flags.fireAndForget === true,
    mode: flags.mode || 'paste',
    refreshBase: flags.refreshBase || 'false',
    caller: communicationCallerContext('task run'),
  });
  return result;
}

async function handleTaskChat(client: any, parsed: any) {
  const agent = parsed.positionals[0];
  const flags = parsed.flags;
  let script;
  try {
    script = JSON.parse(fs.readFileSync(flags.script, 'utf8'));
  } catch (err) {
    die({
      code: 2,
      error: 'invalid_choice',
      message: `cannot read script file ${flags.script}: ${err.message}`,
      details: { script: flags.script },
    });
  }
  if (!Array.isArray(script)) {
    die({
      code: 2,
      error: 'invalid_choice',
      message: 'script file must contain a JSON array',
      details: { script: flags.script },
    });
  }

  const { runChat } = require('./orchestrator.cjs');
  return runChat(client, {
    agent,
    streamId: flags.stream,
    taskId: flags.task,
    workspaceId: flags.workspace,
    kind: flags.kind || 'cli',
    label: flags.label,
    script,
    mode: flags.mode || 'type',
  });
}

async function handleRelay(client: any, parsed: any) {
  const [fromStreamId, toStreamId] = parsed.positionals;
  const flags = parsed.flags;
  const { relay } = require('./relay.cjs');
  return relay(client, {
    fromStreamId,
    toStreamId,
    maxRounds: flags.maxRounds || undefined,
    stopOn: flags.stopOn || null,
    seed: flags.seed || null,
    mode: flags.mode || 'type',
    caller: communicationCallerContext('relay'),
  });
}

function readStdinSync() {
  try {
    if (process.stdin.isTTY) return null;
    return fs.readFileSync(0, 'utf8');
  } catch {
    return null;
  }
}

function requiredArg(value: any, name: string, command = 'browser') {
  if (value == null || value === '') {
    die({
      code: 2,
      error: 'missing_arg',
      message: `${command} missing required argument: ${name}`,
      details: { command, positional: name },
    });
  }
  return String(value);
}

function browserTask(flags: any, { optional = false }: any = {}) {
  const taskId = flags.task || process.env.ACE_TASK_ID || '';
  if (!taskId && !optional) {
    die({
      code: 2,
      error: 'missing_arg',
      message: 'browser command requires --task <id> or $ACE_TASK_ID',
      details: { command: 'browser', flag: '--task' },
    });
  }
  const ctx = ctxFromEnv(process.env);
  if (taskId && ctx.taskId && taskId !== ctx.taskId && !ctx.isControlPlaneCaller) {
    die({
      code: 2,
      error: 'scope_violation',
      message: `browser cannot target task ${taskId} from caller task ${ctx.taskId}`,
      details: { command: 'browser', callerTask: ctx.taskId, targetTask: taskId },
    });
  }
  return taskId || undefined;
}

function argOrStdin(raw: any, name: string) {
  if (raw === '-') {
    const stdin = readStdinSync();
    if (stdin == null) {
      die({
        code: 2,
        error: 'missing_arg',
        message: `expected ${name} on stdin`,
        details: { command: 'browser', positional: name },
      });
    }
    return stdin;
  }
  return requiredArg(raw, name, 'browser');
}

function jsonArg(raw: any) {
  if (raw == null) return {};
  const text = argOrStdin(raw, 'json').trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (err: any) {
    die({
      code: 2,
      error: 'invalid_json',
      message: `invalid JSON params: ${err?.message || err}`,
      details: { command: 'browser cdp' },
    });
  }
}

async function requireReuseOverride(client: any, command: any, parsed: any) {
  const flags = parsed?.flags || {};
  if (flags.forceNew === true) return;
  let target: any = null;
  if (command.cli === 'spawn') {
    target = { agent: parsed.positionals[0], taskId: flags.task };
  } else if (command.cli === 'spawn-adhoc') {
    target = { agent: parsed.positionals[0], workspaceId: flags.workspace, label: flags.label };
  } else if (command.cli === 'task run' && !flags.stream) {
    target = {
      agent: parsed.positionals[0],
      taskId: flags.task,
      workspaceId: flags.workspace,
      label: flags.label,
    };
  }
  if (!target?.agent || (!target.taskId && !(target.workspaceId && target.label))) return;
  const listed = await client.invoke('streamList', {});
  const existing = findRelatedHealthyStream(listed?.streams || [], target);
  if (!existing) return;
  const err: any = new Error(
    `related healthy stream ${existing.streamId} already exists (${existing.reuseReason}); use --stream ${existing.streamId} or pass --force-new to intentionally spawn another`
  );
  err.code = 7;
  err.error = 'reuse_recommended';
  err.details = { command: command.cli, target, existing };
  throw err;
}

async function handleBrowser(client: any, parsed: any) {
  const flags = parsed.flags;
  const args = parsed.positionals.slice();
  const sub = args.shift();
  if (!sub || sub === 'help') {
    die({
      code: 2,
      error: 'missing_arg',
      message: `browser requires a subcommand. Run \`${CLI_NAME} browser --help\`.`,
      details: { command: 'browser' },
    });
  }

  if (sub === 'skills') {
    const verb = requiredArg(args.shift(), 'verb', 'browser skills');
    const host = requiredArg(args.shift(), 'host', 'browser skills');
    if (verb === 'list') return client.invoke('browserSkillsList', { host });
    if (verb === 'read') return client.invoke('browserSkillsRead', { host });
    die({
      code: 2,
      error: 'invalid_choice',
      message: 'browser skills requires list or read',
      details: { command: 'browser skills', verb },
    });
  }

  if (sub === 'list') {
    return client.invoke('browserList', { taskId: browserTask(flags) });
  }

  if (sub === 'open') {
    return client.invoke('browserOpen', {
      taskId: browserTask(flags),
      url: args.shift(),
      activate: flags.noActivate !== true,
    });
  }

  if (sub === 'inspect-ref' || sub === 'click-ref' || sub === 'type-ref') {
    const taskId = browserTask(flags, { optional: true });
    const ref = argOrStdin(args.shift(), 'browser-ref');
    if (sub === 'inspect-ref') return client.invoke('browserInspectRef', { taskId, ref });
    if (sub === 'click-ref') return client.invoke('browserClickRef', { taskId, ref });
    const text = argOrStdin(args.length ? args.join(' ') : null, 'text');
    return client.invoke('browserTypeRef', { taskId, ref, text, clear: flags.clear === true });
  }

  const tabId = requiredArg(args.shift(), 'tabId', 'browser');
  const taskId = browserTask(flags);
  switch (sub) {
    case 'activate':
      return client.invoke('browserActivate', { taskId, tabId });
    case 'info':
      return client.invoke('browserInfo', { taskId, tabId });
    case 'navigate':
      return client.invoke('browserNavigate', {
        taskId,
        tabId,
        url: requiredArg(args.shift(), 'url', 'browser navigate'),
        waitUntil: flags.wait || 'load',
        timeoutMs: flags.timeoutMs,
      });
    case 'screenshot':
      return client.invoke('browserScreenshot', {
        taskId,
        tabId,
        outPath: flags.out,
        fullPage: flags.fullPage === true,
        annotate: flags.annotate === true,
      });
    case 'click':
      if (flags.x == null || flags.y == null) {
        die({
          code: 2,
          error: 'missing_arg',
          message: 'browser click requires --x and --y',
          details: { command: 'browser click' },
        });
      }
      return client.invoke('browserClick', {
        taskId,
        tabId,
        x: flags.x,
        y: flags.y,
        button: flags.button || 'left',
        clickCount: flags.clickCount || 1,
      });
    case 'type':
      return client.invoke('browserType', {
        taskId,
        tabId,
        text: argOrStdin(args.length ? args.join(' ') : null, 'text'),
      });
    case 'key':
      return client.invoke('browserKey', {
        taskId,
        tabId,
        key: requiredArg(args.shift(), 'key', 'browser key'),
      });
    case 'scroll':
      return client.invoke('browserScroll', {
        taskId,
        tabId,
        x: flags.x,
        y: flags.y,
        deltaX: flags.dx || 0,
        deltaY: flags.dy ?? 600,
      });
    case 'js':
      return client.invoke('browserEval', {
        taskId,
        tabId,
        script: argOrStdin(args.length ? args.join(' ') : null, 'script'),
      });
    case 'cdp':
      return client.invoke('browserCdp', {
        taskId,
        tabId,
        method: requiredArg(args.shift(), 'Domain.method', 'browser cdp'),
        params: jsonArg(args.shift()),
        sessionId: flags.sessionId,
      });
    case 'wait': {
      let until: any = null;
      if (flags.load) until = { kind: 'load' };
      if (flags.text != null) until = { kind: 'text', text: flags.text };
      if (flags.selector != null) until = { kind: 'selector', selector: flags.selector };
      if (flags.url != null) until = { kind: 'url', pattern: flags.url };
      if (!until) {
        die({
          code: 2,
          error: 'missing_arg',
          message: 'browser wait requires --load, --text, --selector, or --url',
          details: { command: 'browser wait' },
        });
      }
      return client.invoke('browserWaitFor', { taskId, tabId, until, timeoutMs: flags.timeoutMs });
    }
    case 'elements':
      return client.invoke('browserElements', {
        taskId,
        tabId,
        visibleOnly: flags.visible === true || flags.all !== true,
        limit: flags.limit || 80,
      });
    case 'console':
      return client.invoke('browserConsole', {
        taskId,
        tabId,
        level: flags.level || (flags.errors ? 'error' : 'all'),
        limit: flags.limit || 50,
        sinceSeq: flags.sinceSeq || 0,
      });
    default:
      die({
        code: 6,
        error: 'unknown_command',
        message: `unknown browser subcommand: ${sub}`,
        details: { command: 'browser', subcommand: sub },
      });
  }
}

function mcpResponse(id: any, result: any) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

function mcpError(id: any, error: any) {
  process.stdout.write(JSON.stringify({
    jsonrpc: '2.0',
    id,
    error: { code: -32000, message: String(error?.message || error) },
  }) + '\n');
}

async function handleMcpBrowser(client: any) {
  const tools = [
    ['ace_browser_list', 'List task-scoped browser tabs', 'browserList'],
    ['ace_browser_open', 'Open a task-scoped browser tab', 'browserOpen'],
    ['ace_browser_info', 'Inspect a browser tab', 'browserInfo'],
    ['ace_browser_screenshot', 'Capture a browser screenshot', 'browserScreenshot'],
    ['ace_browser_click', 'Click viewport coordinates', 'browserClick'],
    ['ace_browser_type', 'Type text into the focused element', 'browserType'],
    ['ace_browser_key', 'Send a named key', 'browserKey'],
    ['ace_browser_scroll', 'Scroll the page', 'browserScroll'],
    ['ace_browser_js', 'Run JavaScript in the tab', 'browserEval'],
    ['ace_browser_cdp', 'Send a raw CDP command', 'browserCdp'],
    ['ace_browser_wait', 'Wait for page state', 'browserWaitFor'],
    ['ace_browser_elements', 'List compact visible element summaries', 'browserElements'],
    ['ace_browser_console', 'Read recent browser console/runtime/network diagnostics', 'browserConsole'],
    ['ace_browser_inspect_ref', 'Resolve a browser-ref', 'browserInspectRef'],
    ['ace_browser_click_ref', 'Click a browser-ref', 'browserClickRef'],
    ['ace_browser_type_ref', 'Type into a browser-ref', 'browserTypeRef'],
  ].map(([name, description, method]) => ({
    name,
    description,
    inputSchema: { type: 'object', additionalProperties: true },
    method,
  }));
  const byName = new Map(tools.map((tool: any) => [tool.name, tool]));

  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      void Promise.resolve()
        .then(async () => {
          const msg = JSON.parse(line);
          if (msg.method === 'initialize') {
            mcpResponse(msg.id, {
              protocolVersion: '2024-11-05',
              capabilities: { tools: {} },
              serverInfo: { name: 'ace-browser', version: '0.1.0' },
            });
            return;
          }
          if (msg.method === 'tools/list') {
            mcpResponse(msg.id, { tools: tools.map(({ method: _method, ...tool }: any) => tool) });
            return;
          }
          if (msg.method === 'tools/call') {
            const name = msg.params?.name;
            const tool: any = byName.get(name);
            if (!tool) throw new Error(`unknown tool: ${name}`);
            const args = msg.params?.arguments || {};
            const result = await client.invoke(tool.method, args);
            mcpResponse(msg.id, {
              content: [{ type: 'text', text: JSON.stringify(result) }],
              structuredContent: result,
            });
            return;
          }
          if (msg.id != null) mcpResponse(msg.id, {});
        })
        .catch((err) => {
          try {
            const msg = JSON.parse(line);
            mcpError(msg.id, err);
          } catch {
            mcpError(null, err);
          }
        });
    }
  });
  await new Promise(() => {});
}

async function handleMcpCore(client: any) {
  const tools = [
    ['ace_context', 'Read the current Ace stream context', 'context'],
    ['ace_describe_compact', 'Return the compact Ace command manifest', 'describe'],
    ['ace_ls', 'List Ace streams', 'ls'],
    ['ace_watch', 'Subscribe to Ace events', 'watch'],
    ['ace_task_run', 'Delegate a task through Ace task run', 'task run'],
    ['ace_mission_board', 'Read Mission Board cards', 'mission board'],
    ['ace_mission_ready', 'Read dispatch-ready Mission Board cards', 'mission ready'],
    ['ace_mission_dispatch', 'Dispatch a Mission Board feature', 'mission dispatch'],
    ['ace_mission_sync', 'Sync worker trailer state to a Mission feature', 'mission sync'],
    ['ace_mission_validate', 'Launch Mission validation', 'mission validate'],
    ['ace_mission_gate', 'Gate Mission validation result', 'mission gate'],
    ['ace_tool_heartbeat', 'Record a Ace tool-contract heartbeat', 'tool heartbeat'],
    ['ace_tool_audit', 'Audit Ace tool-contract proof', 'tool audit'],
    ['ace_tool_batch', 'Run a validated batch of Ace tool/read commands', 'tool batch'],
    ['ace_validation_clawpatch', 'Run Clawpatch validation through Ace', 'validation clawpatch'],
  ].map(([name, description, cli]) => ({
    name,
    description,
    inputSchema: { type: 'object', additionalProperties: true },
    cli,
  }));
  const byName = new Map(tools.map((tool: any) => [tool.name, tool]));
  const localCall = async (cli: string, args: any) => {
    if (cli === 'describe') return describeManifest();
    if (cli === 'tool heartbeat') return handleToolHeartbeat({ flags: args || {}, positionals: [] });
    if (cli === 'tool audit') return handleToolAudit({ flags: args || {}, positionals: [] });
    if (cli === 'tool batch') return handleToolBatch(client, { flags: args || {}, positionals: [] });
    if (cli === 'validation clawpatch') return handleValidationClawpatch({ flags: args || {}, positionals: [] });
    throw new Error(`ace_core tool ${cli} is listed but direct MCP execution is not enabled yet; use ${CLI_NAME} ${cli}`);
  };

  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      void Promise.resolve()
        .then(async () => {
          const msg = JSON.parse(line);
          if (msg.method === 'initialize') {
            mcpResponse(msg.id, {
              protocolVersion: '2024-11-05',
              capabilities: { tools: {} },
              serverInfo: { name: 'ace-core', version: '0.1.0' },
            });
            return;
          }
          if (msg.method === 'tools/list') {
            mcpResponse(msg.id, { tools: tools.map(({ cli: _cli, ...tool }: any) => tool) });
            return;
          }
          if (msg.method === 'tools/call') {
            const name = msg.params?.name;
            const tool: any = byName.get(name);
            if (!tool) throw new Error(`unknown tool: ${name}`);
            const args = msg.params?.arguments || {};
            const result = await localCall(tool.cli, args);
            mcpResponse(msg.id, {
              content: [{ type: 'text', text: JSON.stringify(result) }],
              structuredContent: result,
            });
            return;
          }
          if (msg.id != null) mcpResponse(msg.id, {});
        })
        .catch((err) => {
          try {
            const msg = JSON.parse(line);
            mcpError(msg.id, err);
          } catch {
            mcpError(null, err);
          }
        });
    }
  });
  await new Promise(() => {});
}

// Map IPC method to params builder. For most commands the registry already
// names the IPC method and we feed the parser output directly; for a few
// (slash, ref, approve, keys) the wire param names differ from the flag
// names, so we wire them here.
function buildIpcParams(command: any, parsed: any) {
  const flags = parsed.flags;
  const positionals = parsed.positionals;
  switch (command.cli) {
    case 'run submit':
      // Shape the flat CLI flags into the kernel intent. runSubmit does
      // `intent = p.intent || p`, so the nested scope is built here once.
      // --auto-iterate arms the OUTER loop: iteration starts at 1 and the
      // lineage id is the run's own id (set by the controller). NEVER set
      // featureId/laneId here — the spine resolves the per-cycle runId from the
      // dispatch annotation, and a featureId would collide the cycles into one run.
      if (flags.ownerToken && flags.autoIterate) {
        // The intent below drops the token on purpose (cycles never merge);
        // say so loudly — a silently-ignored token reads as a hung merge.
        process.stderr.write(
          'warning: --owner-token is ignored with --auto-iterate (cycles always park; merge the converged branch yourself)\n',
        );
      }
      return {
        intent: {
          goal: flags.goal,
          scope: { workspaceId: flags.workspace, allow: flags.allow || [] },
          ...(flags.agent ? { agent: flags.agent } : {}),
          ...(flags.acceptance && flags.acceptance.length ? { acceptance: flags.acceptance } : {}),
          ...(flags.risk ? { risk: flags.risk } : {}),
          // Hands-off lane: --autoship also arms the bounded same-branch
          // fixback worker (failing CI / review-bot checks fail-forward instead
          // of parking); plain runs keep simple mode (no fixback worker).
          ...(flags.autoship ? { autoShip: { enabled: true, autoMerge: true }, allowFixbackWorker: true } : {}),
          // Auto-iterate lineages NEVER carry a merge token: every cycle parks at
          // ready_to_review and the owner merges the CONVERGED branch themselves
          // (else an intermediate, not-yet-converged cycle could merge mid-loop).
          // So --owner-token applies only to a single, non-looping run.
          ...(flags.ownerToken && !flags.autoIterate ? { ownerAuthToken: flags.ownerToken } : {}),
          ...(flags.autoIterate
            ? { autoIterate: true, iteration: 1, maxIterations: Number(flags.maxIterations) > 0 ? Number(flags.maxIterations) : 5 }
            : {}),
        },
      };
    case 'run loop':
      return { lineageId: flags.stop };
    case 'run archive':
      // Shape the CLI flags onto the runArchive endpoint params: explicit run
      // ids win over the threshold policy; --older-than is hours.
      return {
        runs: flags.run || [],
        terminal: flags.terminal === true,
        ...(flags.olderThan != null ? { olderThanHours: flags.olderThan } : {}),
        dryRun: flags.dryRun === true,
      };
    case 'screen':
      return { streamId: positionals[0], tail: flags.tail };
    case 'state':
    case 'submit':
    case 'composer clear':
    case 'abort':
    case 'interrupt':
    case 'close':
    case 'follow':
    case 'snapshot':
    case 'record-stop':
      return { streamId: positionals[0] };
    case 'ask':
      return { streamId: positionals[0], prompt: positionals[1], timeoutMs: flags.timeout, caller: communicationCallerContext('ask') };
    case 'send':
      return { streamId: positionals[0], text: positionals[1], mode: flags.mode || 'paste', caller: communicationCallerContext('send') };
    case 'keys':
      return { streamId: positionals[0], key: positionals[1], repeat: flags.repeat };
    case 'wait': {
      const predicate = {};
      if (flags.turnComplete) predicate.turnComplete = true;
      else if (flags.awaitingInput) predicate.awaitingInput = true;
      else if (flags.awaitingApproval) predicate.awaitingApproval = true;
      else if (flags.busy) predicate.state = 'busy';
      else if (flags.state) predicate.state = flags.state;
      else if (flags.pattern) predicate.pattern = flags.pattern;
      else if (flags.quietFor != null) predicate.quietForMs = flags.quietFor;
      else {
        die({
          code: 2,
          error: 'missing_arg',
          message: 'wait requires one of --turn-complete|--awaiting-input|--awaiting-approval|--busy|--state|--pattern|--quiet-for',
          details: { command: 'wait' },
        });
      }
      return { streamId: positionals[0], predicate, timeoutMs: flags.timeout };
    }
    case 'slash':
      return { streamId: positionals[0], command: positionals[1], args: positionals.slice(2) };
    case 'ref':
      return { streamId: positionals[0], filePath: positionals[1] };
    case 'approve': {
      const answer = flags.no ? 'no' : 'yes';
      return { streamId: positionals[0], answer };
    }
    case 'spawn':
      return { agent: positionals[0], taskId: flags.task, kind: flags.kind || 'cli' };
    case 'spawn-adhoc':
      return {
        agent: positionals[0],
        workspaceId: flags.workspace,
        label: flags.label || null,
        kind: flags.kind || 'cli',
        prompt: flags.prompt || null,
        mode: flags.mode || 'type',
      };
    case 'rename':
      return { streamId: positionals[0], label: positionals[1] };
    case 'record':
      return { streamId: positionals[0], outPath: positionals[1] };
    case 'replay':
      return { recordPath: positionals[0], agent: flags.agent };
    case 'profiles':
    case 'reload':
    case 'ls':
      return undefined;
    case 'memory search':
      return {
        query: positionals[0],
        project: flags.project || null,
        tier: flags.tier || null,
        kind: flags.kind || null,
        tags: flags.tag || [],
        limit: flags.limit,
        includeDecayed: flags.includeDecayed === true,
      };
    case 'memory get':
      return { path: positionals[0] };
    case 'memory reindex':
    case 'memory eval':
      return undefined;
    case 'completion list':
      return {
        workspaceId: flags.workspace || null,
        streamId: flags.id || null,
        includeAcked: flags.includeAcked === true,
      };
    case 'completion ack':
      return { id: positionals[0] };
    case 'orchestrator start':
      return { workspaceId: flags.workspace, agent: flags.agent || 'claude' };
    case 'integrate context-import': {
      const preview = flags.preview === true;
      const apply = flags.apply === true;
      if (preview === apply) {
        die({
          code: 2,
          error: 'invalid_mode',
          message: 'choose exactly one of --preview or --apply',
          details: { command: command.cli },
        });
      }
      if (apply && !flags.digest) {
        die({
          code: 2,
          error: 'missing_arg',
          message: '--apply requires --digest',
          details: { flag: '--digest', command: command.cli },
        });
      }
      if (preview && flags.digest) {
        die({
          code: 2,
          error: 'invalid_arg',
          message: '--digest is valid only with --apply',
          details: { flag: '--digest', command: command.cli },
        });
      }
      return {
        workspaceId: flags.workspace,
        repoPath: flags.repo,
        worktreePath: flags.worktree,
        branch: flags.branch,
        headSha: flags.headSha,
        baseBranch: flags.baseBranch,
        baseSha: flags.baseSha,
        allowedPaths: flags.allowPath,
        requestId: flags.requestId,
        mode: preview ? 'preview' : 'apply',
        digest: apply ? flags.digest : null,
      };
    }
    case 'integrate push':
      return {
        taskId: flags.task,
        branch: flags.branch,
        remote: flags.remote,
        force: flags.force === true,
      };
    case 'integrate pr-open':
      return {
        taskId: flags.task,
        title: flags.title,
        body: flags.body,
        base: flags.base,
        head: flags.head,
        allowedPaths: flags.allowPath || [],
        // Ready-for-review by DEFAULT: the merge gate hard-fails draft PRs and
        // nothing in the loop un-drafts, so a draft default dead-ends every
        // gated merge. --draft opts back in explicitly.
        draft: flags.draft === true,
      };
    case 'integrate gate':
      return {
        taskId: flags.task,
        prNumber: flags.pr,
        branch: flags.branch,
        remote: flags.remote,
        allowedPaths: flags.allowPath || [],
      };
    case 'integrate pr-merge':
      return {
        taskId: flags.task,
        prNumber: flags.pr,
        method: flags.method,
        deleteBranch: flags.keepBranch !== true,
        auto: flags.auto === true,
        admin: flags.admin === true,
        adminReason: flags.adminReason || null,
        allowedPaths: flags.allowPath || [],
      };
    case 'integrate cleanup':
      return {
        taskId: flags.task,
        branch: flags.branch,
        remote: flags.remote,
        includeRemote: flags.localOnly !== true,
        dryRun: flags.dryRun === true,
        prState: flags.prState || null,
        mergedSha: flags.mergedSha || null,
      };
    case 'context': {
      const streamId = flags.stream || process.env.ACE_STREAM_ID || '';
      if (!streamId) {
        die({
          code: 2,
          error: 'missing_arg',
          message: 'context requires --stream <id> or $ACE_STREAM_ID in env',
          details: { command: 'context' },
        });
      }
      return { streamId };
    }
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Top-level dispatcher
// ---------------------------------------------------------------------------

const HELP_GROUPS = [
  {
    label: 'Core Streams',
    commands: ['ls', 'screen', 'state', 'ask', 'send', 'keys', 'submit', 'composer clear', 'abort', 'wait', 'slash', 'ref', 'approve', 'interrupt', 'close', 'rename', 'follow', 'snapshot'],
  },
  {
    label: 'Workspaces',
    commands: ['workspace create', 'workspace base-branch', 'doctor workspace', 'control-plane status', 'github tracked-projects'],
  },
  {
    label: 'Delegation',
    commands: ['goal launch', 'task run', 'task chat', 'relay', 'orchestrator start', 'spawn', 'spawn-adhoc', 'completion list', 'completion ack', 'supervise'],
  },
  {
    label: 'Run Ledger',
    commands: ['run submit', 'run board', 'run list', 'run loop', 'run closeout', 'run followup'],
  },
  {
    label: 'Loops',
    commands: ['loop list', 'loop show', 'loop forge', 'loop run', 'loop status', 'loop stop'],
  },
  {
    label: 'Validation And Git',
    commands: ['integrate push', 'integrate pr-open', 'integrate gate', 'integrate pr-merge', 'integrate cleanup', 'validation clawpatch'],
  },
  {
    label: 'Tools',
    commands: ['browser', 'mcp-browser', 'mcp-core', 'record', 'record-stop', 'replay', 'profiles', 'reload', 'watch', 'context', 'tool manifest', 'tool heartbeat', 'tool audit', 'tool batch'],
  },
  {
    label: 'Harness',
    commands: ['project init-harness', 'task result', 'task validate', 'feature list', 'wave list', 'run list', 'feature mark', 'memory candidates', 'wiki update', 'event emit', 'smoke fast-lifecycle', 'version', 'describe'],
  },
];

function renderGroupedCommandList() {
  const byName = new Map(COMMANDS.map((command: any) => [command.cli, command]));
  const used = new Set();
  const lines: string[] = [];
  for (const group of HELP_GROUPS) {
    const entries = group.commands.map((name) => byName.get(name)).filter(Boolean);
    if (!entries.length) continue;
    lines.push(`${group.label}:`);
    for (const command of entries) {
      used.add(command.cli);
      lines.push(`  ${command.cli.padEnd(24)} ${command.description}`);
    }
    lines.push('');
  }
  const ungrouped = COMMANDS.filter((command: any) => !used.has(command.cli));
  if (ungrouped.length) {
    lines.push('Other:');
    for (const command of ungrouped) {
      lines.push(`  ${command.cli.padEnd(24)} ${command.description}`);
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

const TOP_LEVEL_HELP = `${CLI_NAME} v${PKG.version} — drive any Ace agent tab.

Run \`${CLI_NAME} describe\` for the full machine-readable manifest, or
\`${CLI_NAME} describe --markdown\` for a human-readable rendering.
Run \`${CLI_NAME} <command> --help\` for per-command help.

Commands:
${renderGroupedCommandList()}

Global flags:
  --json           Force JSON output even for screen/follow.
  -h, --help       Show this message, or per-command help when after a command.

Transport:
  Defaults to a local Unix socket. Set ACE_URL + ACE_TOKEN for remote.
  Override the client deadline with ACE_TIMEOUT_MS (default 60000ms).
`;

function resolveCommand(rawArgs: any) {
  // Handle multi-word commands ("task run", "task chat") by trying a 2-word
  // match first, then falling back to single-word.
  if (rawArgs.length >= 2) {
    const two = `${rawArgs[0]} ${rawArgs[1]}`;
    if (getCommand(two)) return { entry: getCommand(two), rest: rawArgs.slice(2) };
  }
  if (rawArgs.length >= 1) {
    const one = rawArgs[0];
    if (getCommand(one)) return { entry: getCommand(one), rest: rawArgs.slice(1) };
  }
  return null;
}

async function main() {
  const argv = process.argv.slice(2);

  // `--version` and `-V` are short-circuit: no socket, no registry parsing.
  // Useful when there is no running Ace desktop — agents can still
  // identify which CLI build they're holding.
  if (argv.includes('--version') || argv.includes('-V')) {
    const wantsJson = argv.includes('--json') || process.env.ACE_JSON === '1';
    const expectedSha = expectedShaFromArgv(argv);
    const payload = buildVersionPayload();
    assertRuntimeCurrent(payload, expectedSha);
    if (wantsJson) emitOk(withRuntimeExpectation(payload, expectedSha));
    else process.stdout.write(renderVersionText(expectedSha));
    return;
  }

  if (argv.length === 0 || argv[0] === 'help') {
    process.stdout.write(TOP_LEVEL_HELP);
    return;
  }

  // Pull --json / --help out of the entire argv first so they work in any
  // position (`ace --json ls` and `ace ls --json` both work).
  const globals = extractGlobalFlags(argv);

  // Top-level help with no command.
  if (globals.help && globals.rest.length === 0) {
    process.stdout.write(TOP_LEVEL_HELP);
    return;
  }
  if (globals.rest.length === 0) {
    process.stdout.write(TOP_LEVEL_HELP);
    return;
  }

  const resolved = resolveCommand(globals.rest);
  if (!resolved) {
    // EXACTLY a bare command-group name (`ace run`, `ace run --help` after
    // --help extraction, `ace loop`) is a help request, not an error: agents
    // probe the surface this way constantly, and an unknown_command reply
    // costs the caller a whole extra turn. Anything MORE than the bare group
    // (`ace run typo`) is still an unknown command — group help must never
    // mask an invalid invocation with a success exit.
    const groupPrefix = `${globals.rest[0]} `;
    const groupCommands = COMMANDS.filter((c: any) => String(c.cli || '').startsWith(groupPrefix));
    if (groupCommands.length > 0 && globals.rest.length === 1) {
      if (globals.json) {
        emitOk({ group: globals.rest[0], commands: groupCommands.map((c: any) => ({ cli: c.cli, description: c.description })) });
        return;
      }
      const lines = groupCommands.map((c: any) => {
        const firstSentence = String(c.description || '').split(/(?<=\.)\s/)[0];
        return `  ${String(c.cli).padEnd(24)} ${firstSentence}`;
      });
      process.stdout.write(
        `${CLI_NAME} ${globals.rest[0]} — command group. Run \`${CLI_NAME} <command> --help\` for flags.\n\nCommands:\n${lines.join('\n')}\n`,
      );
      return;
    }
    const unknownName = globals.rest.slice(0, 2).join(' ') || globals.rest[0];
    die({
      code: 6,
      error: 'unknown_command',
      message: groupCommands.length > 0
        ? `unknown command: ${unknownName}. Commands in this group: ${groupCommands.map((c: any) => c.cli).join(', ')}.`
        : `unknown command: ${globals.rest[0]}. Run \`${CLI_NAME} describe\` to list every command.`,
      details: { name: unknownName },
    });
  }

  const { entry: command, rest } = resolved;
  globals.rest = rest;
  jsonErrorsToStdout = globals.json && (command.cli === 'task run' || command.cli === 'goal launch');

  if (globals.help) {
    if (globals.json) {
      emitOk(command);
    } else {
      process.stdout.write(renderHelp(command));
    }
    return;
  }

  const parsed = parseArgs(globals.rest, command);
  activeCliInvocation = {
    command,
    context: cliEventContext(command, parsed),
    startedAt: Date.now(),
  };
  let preloadedToolBatchInput: any = null;

  // Refuse cross-workspace / self-targeting delegation before opening any
  // transport. This keeps orchestrators scoped to their own workspace/task
  // even if the socket is unavailable.
  try {
    applyEnforcement(command, parsed);
  } catch (err) {
    if (err && (err.error === 'scope_violation' || err.error === 'instance_mismatch')) {
      die({
        code: err.code || 2,
        error: err.error,
        message: err.message,
        details: err.details,
      });
    }
    throw err;
  }

  // describe is a pure-local command; never opens a client.
  if (command.ipcMethod === 'special:describe') {
    await handleDescribe(command, parsed, { json: globals.json });
    return;
  }

  // version is a pure-local command; never opens a client.
  if (command.ipcMethod === 'special:version') {
    const expectedSha = expectedRuntimeSha(parsed.flags);
    const payload = buildVersionPayload();
    assertRuntimeCurrent(payload, expectedSha);
    if (globals.json) emitOk(withRuntimeExpectation(payload, expectedSha));
    else process.stdout.write(renderVersionText(expectedSha));
    return;
  }

  // supervise reads the persistent child-registry; no transport needed.
  if (command.ipcMethod === 'special:supervise') {
    await handleSupervise(command, parsed, { json: globals.json });
    return;
  }

  if (command.ipcMethod === 'special:projectInitHarness') {
    emitOk(await handleProjectInitHarness(parsed));
    return;
  }

  if (command.ipcMethod === 'special:taskResult') {
    emitOk(await handleTaskResult(parsed));
    return;
  }

  if (command.ipcMethod === 'special:taskValidate') {
    emitOk(await handleTaskValidate(parsed));
    return;
  }

  if (command.ipcMethod === 'special:featureList') {
    emitOk(await handleFeatureList(parsed));
    return;
  }

  if (command.ipcMethod === 'special:waveList') {
    emitOk(await handleWaveList(parsed));
    return;
  }

  if (command.ipcMethod === 'special:runList') {
    emitOk(await handleRunList(parsed));
    return;
  }

  if (command.ipcMethod === 'special:featureMark') {
    emitOk(await handleFeatureMark(parsed));
    return;
  }

  if (command.ipcMethod === 'special:memoryRemember') {
    emitOk(await handleMemoryRemember(parsed));
    return;
  }
  if (command.ipcMethod === 'special:knowledgeMigrate') {
    emitOk(await handleKnowledgeMigrate(parsed));
    return;
  }
  if (command.ipcMethod === 'special:memoryCandidates') {
    emitOk(await handleMemoryCandidates(parsed));
    return;
  }

  if (command.ipcMethod === 'special:wikiUpdate') {
    emitOk(await handleWikiUpdate(parsed));
    return;
  }

  if (command.ipcMethod === 'special:wikiDump') {
    emitOk(await handleWikiDump(parsed));
    return;
  }

  if (command.ipcMethod === 'special:wikiCandidates') {
    emitOk(await handleWikiCandidates(parsed));
    return;
  }

  if (command.ipcMethod === 'special:wikiNightly') {
    emitOk(await handleWikiNightly(parsed));
    return;
  }

  if (command.ipcMethod === 'special:wikiPack') {
    emitOk(await handleWikiPack(parsed));
    return;
  }

  if (command.ipcMethod === 'special:wikiAudit') {
    emitOk(await handleWikiAudit(parsed));
    return;
  }

  if (command.ipcMethod === 'special:wikiBackfill') {
    emitOk(await handleWikiBackfill(parsed));
    return;
  }
  if (command.ipcMethod === 'special:wikiWriteback') {
    emitOk(await handleWikiWriteback(parsed));
    return;
  }
  if (command.ipcMethod === 'special:wikiGenerate') {
    emitOk(await handleWikiGenerate(parsed));
    return;
  }
  if (command.ipcMethod === 'special:wikiCurateEvents') {
    emitOk(await handleWikiCurateEvents(parsed));
    return;
  }
  if (command.ipcMethod === 'special:wikiInbox') {
    emitOk(await handleWikiInbox(parsed));
    return;
  }
  if (command.ipcMethod === 'special:wikiPromote') {
    emitOk(await handleWikiPromote(parsed));
    return;
  }
  if (command.ipcMethod === 'special:wikiHealth') {
    emitOk(await handleWikiHealth(parsed));
    return;
  }
  if (command.ipcMethod === 'special:memoryStatus') {
    emitOk(await handleMemoryStatus(parsed));
    return;
  }
  if (command.ipcMethod === 'special:memoryExplain') {
    emitOk(await handleMemoryExplain(parsed));
    return;
  }

  if (command.ipcMethod === 'special:eventEmit') {
    emitOk(await handleEventEmit(parsed));
    return;
  }

  if (command.ipcMethod === 'special:toolManifest') {
    emitOk(await handleToolManifest(parsed));
    return;
  }

  if (command.ipcMethod === 'special:toolHeartbeat') {
    emitOk(await handleToolHeartbeat(parsed));
    return;
  }

  if (command.ipcMethod === 'special:toolAudit' && !(parsed.flags.workspace && !parsed.flags.projectDir)) {
    emitOk(await handleToolAudit(parsed));
    return;
  }

  if (command.ipcMethod === 'special:toolBatch') {
    try {
      preloadedToolBatchInput = readToolBatchInput(parsed.flags.input);
      const validation = toolContract.validateBatchInput(preloadedToolBatchInput);
      preloadedToolBatchInput = validation.batch;
      if (!toolBatchNeedsTransport(preloadedToolBatchInput)) {
        emitOk(await handleToolBatch(null, parsed, preloadedToolBatchInput));
        return;
      }
    } catch (err) {
      die({
        code: 2,
        error: err?.code || 'invalid_batch',
        message: err?.message || String(err),
        details: err?.errors ? { errors: err.errors } : { command: command.cli },
      });
    }
  }

  if (command.ipcMethod === 'special:validationClawpatch' && !(parsed.flags.workspace && !parsed.flags.projectDir)) {
    emitOk(await handleValidationClawpatch(parsed));
    return;
  }

  if (command.ipcMethod === 'orchestrator:runTask') {
    parsed.taskRunSpec = prepareTaskRunSpec(parsed);
    if (parsed.flags.dryRun === true) {
      const result = explainTaskRunRoute(parsed);
      if (!globals.json) {
        process.stdout.write(renderTaskRunStatus(result) + '\n');
      } else {
        emitOk(result);
      }
      return;
    }
  }

  if (command.ipcMethod === 'special:goalLaunch' && parsed.flags.dryRun === true) {
    emitOk(explainGoalLaunch(parsed));
    return;
  }

  if (command.ipcMethod === 'special:workspaceCreate' && parsed.flags.dryRun === true) {
    emitOk(await handleWorkspaceCreate(null, parsed));
    return;
  }

  // Everything else needs a transport.
  let client;
  try {
    client = createClient();
  } catch (err) {
    die({ code: 3, error: 'transport_failed', message: err?.message || String(err) });
  }

  try {
    if (command.ipcMethod === 'special:watch') {
      await handleWatch(client, parsed);
      return;
    }
    if (command.ipcMethod === 'special:workspaceBaseBranch') {
      await handleWorkspaceBaseBranch(client, parsed, { json: globals.json });
      return;
    }
    if (command.ipcMethod === 'special:workspaceCreate') {
      emitOk(await handleWorkspaceCreate(client, parsed));
      return;
    }
    if (command.ipcMethod === 'special:doctorWorkspace') {
      emitOk(await handleDoctorWorkspace(client));
      return;
    }
    if (command.ipcMethod === 'special:controlPlaneStatus') {
      emitOk(await handleControlPlaneStatus(client, parsed));
      return;
    }
    if (command.ipcMethod === 'special:opsStatus') {
      // Exit 0 even when findings are red/black — a degraded system is not a
      // CLI error. Only transport/throw paths use the non-zero exit codes.
      emitOk(await handleOpsStatus(client, parsed));
      return;
    }
    if (command.ipcMethod === 'special:smokeFastLifecycle') {
      emitOk(await handleSmokeFastLifecycle(client, parsed));
      return;
    }
    if (command.ipcMethod === 'special:runCloseout') {
      emitOk(await handleRunCloseout(client, parsed));
      return;
    }
    if (command.ipcMethod === 'special:runWatch') {
      const result = await handleRunWatch(client, parsed, { json: globals.json });
      if (result !== 0) emitOk(result);
      return;
    }
    if (command.ipcMethod === 'special:runFollowup') {
      const result = await handleRunFollowup(client, parsed, { json: globals.json });
      if (result !== 0) emitOk(result);
      return;
    }
    if (command.ipcMethod === 'special:loopList') {
      const result = await client.invoke('loopsList');
      if (globals.json) emitOk(result);
      else process.stdout.write(loopCli.renderLoopList(result) + '\n');
      return;
    }
    if (command.ipcMethod === 'special:loopShow') {
      const id = parsed.positionals[0];
      const spec = await client.invoke('loopsGet', { id });
      if (!spec) {
        die({ code: 6, error: 'not_found', message: `loop not found: ${id}`, details: { command: 'loop show', id } });
      }
      if (globals.json) emitOk(spec);
      else process.stdout.write(loopCli.renderLoopShow(spec) + '\n');
      return;
    }
    if (command.ipcMethod === 'special:loopForge') {
      const flags: any = parsed.flags;
      const text = parsed.positionals[0];
      const compiled = await client.invoke('loopsCompile', { text });
      const lock = await client.invoke('loopsLockOn', { draft: (compiled && compiled.draft) || {} });
      // --save is fail-closed: refuse to persist a draft that did not lock on.
      if (flags.save === true && !(lock && lock.spec)) {
        if (!globals.json) process.stdout.write(loopCli.renderForge(compiled, lock) + '\n');
        die({
          code: 5,
          error: 'validation_failed',
          message: 'loop forge --save refused: the draft did not pass fail-closed validation',
          details: { command: 'loop forge', errors: (lock && lock.errors) || ['lock-on failed'] },
        });
      }
      let saved = null;
      if (flags.save === true) {
        saved = await client.invoke('loopsSave', { spec: lock.spec });
      }
      if (globals.json) {
        emitOk({
          draft: (compiled && compiled.draft) || null,
          notes: (compiled && compiled.notes) || [],
          saved,
          errors: (lock && lock.errors) || [],
        });
      } else {
        process.stdout.write(loopCli.renderForge(compiled, lock, saved) + '\n');
      }
      return;
    }
    if (command.ipcMethod === 'special:loopRun') {
      const flags: any = parsed.flags;
      const id = parsed.positionals[0];
      const inputs = loopCli.parseInputPairs(flags.input || []);
      // Loops can run many worker iterations, each a real dispatch — outlast the
      // default 60s client deadline (mirrors the wait/ask timeout growth).
      const requested = Number(flags.timeout);
      const clientTimeoutMs =
        Number.isFinite(requested) && requested > 0 ? Math.max(60_000, requested + 15_000) : 1_800_000;
      const result = await client.invoke('loopsRun', { loopId: id, inputs }, clientTimeoutMs);
      // Unknown loop id / internal throw surface as CLI errors BEFORE the
      // terminal-state exit contract is consulted.
      if (result && result.finishReason === 'spec-not-found') {
        die({ code: 6, error: 'not_found', message: `loop not found: ${id}`, details: { command: 'loop run', id } });
      }
      if (result && result.finishReason === 'error') {
        die({ code: 5, error: 'loop_error', message: result.reasonDetail || 'loop run failed', details: { command: 'loop run', id } });
      }
      if (globals.json) emitOk(result);
      else process.stdout.write(loopCli.renderLoopRun(result, { watch: flags.watch === true }) + '\n');
      // Loop-specific exit contract: 0 converged, 2 no-progress/cap-hit, 3 blocked.
      process.exit(loopCli.loopRunExitCode(result && result.finishReason));
    }
    if (command.ipcMethod === 'special:loopStatus') {
      const id = parsed.positionals[0] || null;
      const result = await client.invoke('loopsStatus', { id });
      if (globals.json) emitOk(result);
      else process.stdout.write(loopCli.renderLoopStatus(result, id) + '\n');
      return;
    }
    if (command.ipcMethod === 'special:loopStop') {
      const target = parsed.positionals[0];
      const result = await client.invoke('loopsStop', { invocationId: target });
      if (globals.json) emitOk(result);
      else process.stdout.write((result && result.stopped ? `stopped ${target}` : `no active invocation for ${target}`) + '\n');
      return;
    }
    if (command.ipcMethod === 'special:toolAudit') {
      emitOk(await handleToolAudit(parsed, client));
      return;
    }
    if (command.ipcMethod === 'special:validationClawpatch') {
      emitOk(await handleValidationClawpatch(parsed, client));
      return;
    }
    if (command.ipcMethod === 'special:mcpBrowser') {
      await handleMcpBrowser(client);
      return;
    }
    if (command.ipcMethod === 'special:mcpCore') {
      await handleMcpCore(client);
      return;
    }

    let result;
    await requireReuseOverride(client, command, parsed);
    if (command.ipcMethod === 'special:toolBatch') {
      result = await handleToolBatch(client, parsed, preloadedToolBatchInput);
    } else if (command.ipcMethod === 'special:browser') {
      result = await handleBrowser(client, parsed);
    } else if (command.ipcMethod === 'special:goalLaunch') {
      result = await handleGoalLaunch(client, parsed);
    } else if (command.ipcMethod === 'orchestrator:runTask') {
      result = await handleTaskRun(client, parsed);
    } else if (command.ipcMethod === 'orchestrator:runChat') {
      result = await handleTaskChat(client, parsed);
    } else if (command.ipcMethod === 'orchestrator:relay') {
      result = await handleRelay(client, parsed);
    } else {
      const params = buildIpcParams(command, parsed);
      // When a command takes its own --timeout (e.g. `wait`, `ask`), the
      // client deadline must outlast the server-side wait or the request
      // throws TIMEOUT after the default 60s no matter what the operator
      // asked for. Pass a deadline grown past `params.timeoutMs` whenever
      // the caller explicitly requested longer than the client default.
      const requested = Number(params?.timeoutMs);
      const clientTimeoutMs =
        Number.isFinite(requested) && requested > 0
          ? Math.max(60_000, requested + 15_000)
          : undefined;
      result = await client.invoke(command.ipcMethod, params, clientTimeoutMs);
    }

    // Server-side {ok:false} surfaces as exit 5.
    if (result && result.ok === false && command.cli !== 'tool batch') {
      die({
        code: 5,
        error: 'server_error',
        message: result.error || 'server returned ok:false',
        details: { command: command.cli, response: result },
      });
    }

    recordProjectWikiDumpHook(command, parsed, result);

    // Raw text for screen/follow when --json is not set.
    if (!globals.json && command.cli === 'task run') {
      process.stdout.write(renderTaskRunStatus(result) + '\n');
      if (result?.nextStep?.next) {
        process.stdout.write(`Next: ${result.nextStep.next}\n`);
      }
    } else if (!globals.json && (command.cli === 'screen' || command.cli === 'follow')) {
      process.stdout.write((result?.text || '') + '\n');
    } else if (!globals.json && command.cli === 'run archive') {
      // Human summary: how many runs/event lines moved (or would move).
      const d: any = result || {};
      const runsCount = Array.isArray(d.runIds) ? d.runIds.length : 0;
      process.stdout.write(
        (d.dryRun
          ? `dry-run: would archive ${runsCount} run(s)`
          : `archived ${runsCount} run(s): ${d.archived || 0} event line(s) -> events-archive.ndjson`) +
          `; ${d.remaining != null ? d.remaining : 0} event line(s) remain live\n`,
      );
    } else {
      emitOk(result);
    }
  } catch (err) {
    const decorated = await augmentWorkspaceNotFound(client, err, {
      workspaceId: parsed?.flags?.workspace || null,
      env: process.env,
    });
    const mapped = mapTransportError(decorated);
    die({
      ...mapped,
      details: { command: command.cli, ...(mapped.details || {}) },
    });
  } finally {
    try { client.close(); } catch {}
  }
}

main().catch((err: any) => {
  die({ code: 1, error: 'internal_error', message: err?.message || String(err) });
});
