#!/usr/bin/env tsx

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const pty = require('node-pty');

const FEATURE_FLAGS = [
  'apps',
  'plugins',
  'browser_use',
  'browser_use_external',
  'computer_use',
  'in_app_browser',
  'enable_mcp_apps',
];
const READY_RX = /(?:^|\n)\s*›(?:\s|$)|(?:^|\n)(?:>|user:|codex>)\s*$/;

function argValue(name: string, fallback: string | null = null) {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length) return fallback;
  return process.argv[index + 1];
}

function hasFlag(name: string) {
  return process.argv.includes(name);
}

function run(cmd: string, args: string[], opts: any = {}) {
  const startedAt = Date.now();
  const result = spawnSync(cmd, args, {
    cwd: opts.cwd || process.cwd(),
    encoding: 'utf8',
    timeout: opts.timeoutMs || 15_000,
    maxBuffer: opts.maxBuffer || 1024 * 1024,
    env: opts.env || process.env,
  });
  return {
    cmd: [cmd, ...args].join(' '),
    exitCode: result.status,
    signal: result.signal,
    durationMs: Date.now() - startedAt,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
    error: result.error ? String(result.error.message || result.error) : null,
  };
}

function truncate(text: string, max = 6000) {
  return text.length <= max ? text : `${text.slice(0, max)}\n...[truncated ${text.length - max} chars]`;
}

function stripAnsi(text: string) {
  return String(text || '')
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, '')
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

function parseFeatures(text: string) {
  const seen: Record<string, string> = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = line.match(/^([a-z0-9_]+)\s+\S+\s+(\S+)/);
    if (match) seen[match[1]] = match[2];
  }
  return seen;
}

function psSample(pid: number | null) {
  if (!pid) return null;
  const out = spawnSync('ps', ['-o', 'pid=,rss=,pcpu=', '-p', String(pid)], { encoding: 'utf8' });
  const parts = String(out.stdout || '').trim().split(/\s+/);
  if (parts.length < 3) return null;
  return { pid: Number(parts[0]), rssKb: Number(parts[1]), cpuPercent: Number(parts[2]) };
}

function codexPromptReady(text: string) {
  return (
    READY_RX.test(text) ||
    /›\s*Use\s+\/skills\s+to\s+list\s+available\s+skills/.test(text) ||
    /›[^\r\n]{0,240}gpt-[0-9a-z. -]+·/.test(text)
  );
}

function codexArgs() {
  return [
    '--no-alt-screen',
    '-c', 'check_for_update_on_startup=false',
    '-c', 'model_reasoning_effort="low"',
    ...FEATURE_FLAGS.flatMap((flag) => ['--enable', flag]),
  ];
}

function launchSession(index: number, cwd: string, timeoutMs: number, holdMs: number) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let output = '';
    let readyAt: number | null = null;
    let statusSent = false;
    let updateSkipped = false;
    let trustAccepted = false;
    const term = pty.spawn('codex', codexArgs(), {
      name: 'xterm-256color',
      cols: 120,
      rows: 40,
      cwd,
      env: {
        ...process.env,
        ACE_CODEX_APP_PARITY: '1',
        ACE_CODEX_RUNTIME_PROFILE: 'app-parity',
      },
    });
    const finish = (result: any) => {
      const resource = psSample(term.pid || null);
      try { term.kill(); } catch {}
      resolve({
        index,
        pid: term.pid || null,
        ...result,
        outputTail: truncate(output.slice(-6000)),
        resource,
      });
    };
    const timer = setTimeout(() => {
      finish({
        ready: false,
        startupLatencyMs: null,
        heldMs: Math.max(0, Date.now() - startedAt),
        error: `timeout waiting for Codex prompt after ${timeoutMs}ms`,
      });
    }, timeoutMs);
    term.onData((chunk: string) => {
      output += chunk;
      const visibleOutput = stripAnsi(output);
      const compactOutput = visibleOutput.replace(/[^A-Za-z0-9?]+/g, '');
      if (!updateSkipped && /Update now \(runs `npm install -g @openai\/codex`\)/.test(visibleOutput) && /\bSkip\b/.test(visibleOutput)) {
        updateSkipped = true;
        term.write('\x1b[B\r');
      }
      if (!trustAccepted && /Doyoutrustthecontentsofthisdirectory\?/.test(compactOutput) && /Yescontinue/.test(compactOutput)) {
        trustAccepted = true;
        term.write('\r');
      }
      if (!readyAt && codexPromptReady(visibleOutput)) {
        readyAt = Date.now();
        if (!statusSent) {
          statusSent = true;
          term.write('/status\r');
        }
        setTimeout(() => {
          clearTimeout(timer);
          finish({
            ready: true,
            startupLatencyMs: readyAt! - startedAt,
            readinessLatencyMs: Date.now() - readyAt!,
            heldMs: Date.now() - startedAt,
            error: null,
          });
        }, holdMs);
      }
    });
    term.onExit(({ exitCode, signal }: any) => {
      if (!readyAt) {
        clearTimeout(timer);
        finish({
          ready: false,
          startupLatencyMs: null,
          heldMs: Math.max(0, Date.now() - startedAt),
          exitCode,
          signal,
          error: 'Codex exited before prompt readiness',
        });
      }
    });
  });
}

function computerUseProbe(cwd: string) {
  const prompt = [
    'Harmless computer-use readiness probe.',
    'Use only available app/computer-use inspection tools to list visible/running apps and get state for one harmless app if possible.',
    'Do not click, type, send, delete, purchase, approve, or change any setting.',
    'Return PASS with the tool names used, or BLOCKED with the exact missing runtime/plugin/TCC permission.',
  ].join(' ');
  const args = [
    '-c', 'check_for_update_on_startup=false',
    ...FEATURE_FLAGS.flatMap((flag) => ['--enable', flag]),
    'exec',
    '--ephemeral',
    '--color', 'never',
    '-s', 'read-only',
    '-C', cwd,
    prompt,
  ];
  const result = run('codex', args, { cwd, timeoutMs: 180_000, maxBuffer: 2 * 1024 * 1024 });
  return {
    ...result,
    stdout: truncate(result.stdout),
    stderr: truncate(result.stderr),
  };
}

async function main() {
  const sessions = Math.max(1, Number(argValue('--sessions', '2')) || 2);
  const timeoutMs = Math.max(5_000, Number(argValue('--timeout-ms', '45000')) || 45_000);
  const holdMs = Math.max(500, Number(argValue('--hold-ms', '2500')) || 2500);
  const cwd = path.resolve(argValue('--cwd', process.cwd()) || process.cwd());
  const output = path.resolve(argValue('--output', path.join(os.tmpdir(), `codex-app-parity-smoke-${Date.now()}.json`))!);

  const surface = {
    codexPath: run('which', ['codex']).stdout.trim() || null,
    version: run('codex', ['--version']),
    help: run('codex', ['--help']),
    appServerHelp: run('codex', ['app-server', '--help']),
    pluginHelp: run('codex', ['plugin', '--help']),
    mcpList: run('codex', ['mcp', 'list']),
    pluginList: run('codex', ['plugin', 'list']),
    featuresList: run('codex', ['features', 'list']),
  };
  const parsedFeatures = parseFeatures(surface.featuresList.stdout);
  const missingFeatures = FEATURE_FLAGS.filter((flag) => !(flag in parsedFeatures));

  const launched = await Promise.all(
    Array.from({ length: sessions }, (_, index) => launchSession(index + 1, cwd, timeoutMs, holdMs))
  );

  const report = {
    schema: 'ace.codex_app_parity_smoke.v1',
    createdAt: new Date().toISOString(),
    cwd,
    requestedSessions: sessions,
    surface: {
      codexPath: surface.codexPath,
      version: truncate(surface.version.stdout || surface.version.stderr, 1000),
      appServerAvailable: surface.appServerHelp.exitCode === 0 && /--listen\b/.test(surface.appServerHelp.stdout),
      pluginSurfaceAvailable: surface.pluginHelp.exitCode === 0 && /plugin/i.test(surface.pluginHelp.stdout),
      mcpList: truncate(surface.mcpList.stdout || surface.mcpList.stderr, 1000),
      pluginList: truncate(surface.pluginList.stdout || surface.pluginList.stderr, 1000),
      features: parsedFeatures,
      missingFeatures,
    },
    sessions: launched,
    computerUseProbe: hasFlag('--computer-use') ? computerUseProbe(cwd) : null,
  };
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(output);
  if (missingFeatures.length || launched.some((s: any) => !s.ready)) process.exitCode = 1;
}

main().catch((err: any) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
