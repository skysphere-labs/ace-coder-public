
const fs = require('fs');
const os = require('os');
const path = require('path');


const PREREQUISITES: any = {




  node: {
    probe: 'npm',
    label: 'Node.js 20+ (via nvm)',
    minMajor: 20,
    versionCmd: "node -v 2>/dev/null | sed 's/^v//; s/[.].*//'",





    install: [
      'unset npm_config_prefix',
      'curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash',
      'export NVM_DIR="$HOME/.nvm"',
      '[ -s "$NVM_DIR/nvm.sh" ] && \\. "$NVM_DIR/nvm.sh"',
      'nvm install --lts',
      'nvm use --lts',
    ].join(' && '),
  },



  uv: {
    probe: 'uv',
    label: 'uv (Astral)',
    install: [
      'curl -LsSf https://astral.sh/uv/install.sh | sh',
      'export PATH="$HOME/.local/bin:$PATH"',
    ].join(' && '),
  },


  'python-3.11': {
    probe: 'python3.11',
    label: 'Python 3.11 (via uv)',
    install: [
      'export PATH="$HOME/.local/bin:$PATH"',
      'uv python install 3.11',
      'mkdir -p "$HOME/.local/bin"',
      'ln -sf "$(uv python find 3.11)" "$HOME/.local/bin/python3.11"',
    ].join(' && '),
  },
};

const PROVIDERS: any[] = [
  {
    id: 'claude',
    name: 'Claude Code',
    cli: 'claude',
    installCommand: 'npm install -g @anthropic-ai/claude-code',
    docUrl: 'https://docs.claude.com/en/docs/claude-code',
    autoApproveFlag: '--dangerously-skip-permissions',
    defaultArgs: [],
    prerequisites: ['node'],





    resume: {
      style: 'flag',
      token: '--resume',
      sessionIdFlag: '--session-id',
      sessionFileLocator: 'claude-projects',
    },
  },
  {
    id: 'codex',
    name: 'Codex',
    cli: 'codex',
    installCommand: 'npm install -g @openai/codex',
    docUrl: 'https://github.com/openai/codex',
    autoApproveFlag: '--dangerously-bypass-approvals-and-sandbox',
    defaultArgs: [],
    prerequisites: ['node'],







    resume: {
      style: 'subcommand',
      // Exact-id resume only. No `resume --last` fallback: with more than one
      // codex tab it attaches the globally newest rollout — a different tab's
      // session. When the concrete rollout id is unknown we start fresh (see
      // planResume); the transcript linker captures the real id from
      // ~/.codex/sessions and persists it for the next resume.
      exactToken: 'resume',
      sessionFileLocator: 'codex-sessions',
      requiresSessionFile: true,
    },
  },
  {
    id: 'cursor',
    name: 'Cursor',
    cli: 'cursor-agent',
    installCommand: 'curl https://cursor.com/install -fsS | bash',
    docUrl: 'https://cursor.com/cli',
    autoApproveFlag: '-f',
    defaultArgs: [],
    prerequisites: [],
  },
  {
    id: 'gemini',
    name: 'Gemini',
    cli: 'gemini',
    installCommand: 'npm install -g @google/gemini-cli',
    docUrl: 'https://github.com/google-gemini/gemini-cli',
    autoApproveFlag: '--yolo',
    defaultArgs: [],
    prerequisites: ['node'],



    resume: { style: 'token', token: '--resume' },
  },
  {
    id: 'qwen',
    name: 'Qwen Code',
    cli: 'qwen',
    installCommand: 'npm install -g @qwen-code/qwen-code',
    docUrl: 'https://github.com/QwenLM/qwen-code',
    autoApproveFlag: '--yolo',
    defaultArgs: [],
    prerequisites: ['node'],
    resume: { style: 'token', token: '--continue' },
  },
  {
    id: 'droid',
    name: 'Droid',
    cli: 'droid',
    installCommand: 'curl -fsSL https://app.factory.ai/cli | sh',
    docUrl: 'https://docs.factory.ai/cli/getting-started/quickstart',
    autoApproveFlag: null,
    defaultArgs: [],
    prerequisites: [],
  },
  {
    id: 'amp',
    name: 'Amp',
    cli: 'amp',
    installCommand: 'npm install -g @sourcegraph/amp',
    docUrl: 'https://ampcode.com/manual#install',
    autoApproveFlag: '--dangerously-allow-all',
    defaultArgs: [],
    prerequisites: ['node'],
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    cli: 'opencode',
    installCommand: 'npm install -g opencode-ai',
    docUrl: 'https://opencode.ai/docs/cli/',
    autoApproveFlag: null,
    defaultArgs: [],
    prerequisites: ['node'],
  },
  {
    id: 'hermes',
    name: 'Hermes Agent',
    cli: 'hermes',






    // Desktop embedding depends on a compatible user-managed Hermes build.
    // Never replace an existing installation with an owner-specific fork.
    installCommand: null,
    installCommandWindows: null,
    docUrl: 'https://hermes-agent.nousresearch.com/docs/',
    autoApproveFlag: '--yolo',
    // Hermes inside a Ace workspace always launches with permission
    // bypass — same contract we already give Claude/Codex. Honored by
    // buildAgentCommand / buildRemoteAgentCommand regardless of the task's
    // `auto_approve` setting.
    alwaysAutoApprove: true,
    defaultArgs: [],
    // Hermes supports exact `--resume <session>` and latest-only `--continue`.
    // User-facing Ace streams should persist exact session ids only;
    // `--continue` can attach to background sessions inside the same state.db.
    resume: {
      style: 'token',
      token: '--continue',
      exactToken: '--resume',
      exactSessionIdPattern: /^\d{8}_\d{6}_[A-Za-z0-9_-]+$/,
    },
    prerequisites: ['uv', 'python-3.11'],






    systemPackages: ['build-essential', 'python3-dev', 'libffi-dev'],





    installWarning: {
      title: 'Manual Hermes installation',
      body:
        'Install Hermes using its documentation, then make the hermes command available on PATH. The embedded desktop requires a compatible build and is not guaranteed by the upstream CLI installation.',
      confirmLabel: 'I understand that desktop compatibility depends on my installation',
    },
  },
  {
    id: 'copilot',
    name: 'GitHub Copilot',
    cli: 'copilot',
    installCommand: 'npm install -g @github/copilot',
    docUrl: 'https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli',
    autoApproveFlag: '--allow-all-tools',
    defaultArgs: [],
    prerequisites: ['node'],
  },
  {
    id: 'charm',
    name: 'Charm',
    cli: 'crush',
    installCommand: 'npm install -g @charmland/crush',
    docUrl: 'https://github.com/charmbracelet/crush',
    autoApproveFlag: '--yolo',
    defaultArgs: [],
    prerequisites: ['node'],
  },
  {
    id: 'auggie',
    name: 'Auggie',
    cli: 'auggie',
    installCommand: 'npm install -g @augmentcode/auggie',
    docUrl: 'https://docs.augmentcode.com/cli/overview',
    autoApproveFlag: null,
    defaultArgs: ['--allow-indexing'],
    prerequisites: ['node'],
  },
  {
    id: 'goose',
    name: 'Goose',
    cli: 'goose',




    installCommand:
      'curl -fsSL https://github.com/block/goose/releases/download/stable/download_cli.sh | CONFIGURE=false bash',
    docUrl: 'https://block.github.io/goose/docs/quickstart/',
    autoApproveFlag: null,
    defaultArgs: ['session'],
    prerequisites: [],
  },
  {
    id: 'kimi',
    name: 'Kimi',
    cli: 'kimi',
    installCommand: 'uv tool install kimi-cli',
    docUrl: 'https://www.kimi.com/code/docs/en/kimi-cli/guides/getting-started.html',
    autoApproveFlag: '--yolo',
    defaultArgs: [],
    prerequisites: ['uv'],
  },
  {
    id: 'kilocode',
    name: 'Kilocode',
    cli: 'kilocode',
    installCommand: 'npm install -g @kilocode/cli',
    docUrl: 'https://kilo.ai/docs/cli',
    autoApproveFlag: null,
    defaultArgs: [],
    prerequisites: ['node'],
  },
  {
    id: 'kiro',
    name: 'Kiro',
    cli: 'kiro-cli',
    installCommand: 'curl -fsSL https://cli.kiro.dev/install | bash',
    docUrl: 'https://kiro.dev/docs/cli/',
    autoApproveFlag: null,
    defaultArgs: ['chat'],
    prerequisites: [],


    systemPackages: ['unzip'],
  },
  {
    id: 'rovo',
    name: 'Rovo Dev',
    cli: 'acli',
    installCommand: 'acli rovodev auth login',
    docUrl:
      'https://support.atlassian.com/rovo/docs/install-and-run-rovo-dev-cli-on-your-device/',
    autoApproveFlag: '--yolo',
    defaultArgs: ['rovodev', 'run'],
    prerequisites: [],
  },
  {
    id: 'cline',
    name: 'Cline',
    cli: 'cline',
    installCommand: 'npm install -g cline',
    docUrl: 'https://docs.cline.bot/cline-cli/overview',
    autoApproveFlag: '--yolo',
    defaultArgs: [],
    prerequisites: ['node'],
  },
  {
    id: 'continue',
    name: 'Continue',
    cli: 'cn',
    installCommand: 'npm install -g @continuedev/cli',
    docUrl: 'https://docs.continue.dev/guides/cli',
    autoApproveFlag: null,
    defaultArgs: [],
    prerequisites: ['node'],
  },
  {
    id: 'codebuff',
    name: 'Codebuff',
    cli: 'codebuff',
    installCommand: 'npm install -g codebuff',
    docUrl: 'https://www.codebuff.com/docs/help/quick-start',
    autoApproveFlag: null,
    defaultArgs: [],
    prerequisites: ['node'],
  },
  {
    id: 'mistral',
    name: 'Mistral Vibe',
    cli: 'vibe',
    installCommand: 'curl -LsSf https://mistral.ai/vibe/install.sh | bash',
    docUrl: 'https://github.com/mistralai/mistral-vibe',
    autoApproveFlag: null,
    defaultArgs: [],
    prerequisites: [],
  },
  {
    id: 'pi',
    name: 'Pi',
    cli: 'pi',
    installCommand: 'npm install -g @mariozechner/pi-coding-agent',
    docUrl: 'https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent',
    autoApproveFlag: null,
    defaultArgs: [],
    prerequisites: ['node'],
  },
  {
    id: 'autohand',
    name: 'Autohand Code',
    cli: 'autohand',
    installCommand: 'npm install -g autohand-cli',
    docUrl: 'https://autohand.ai/code/',
    autoApproveFlag: '--unrestricted',
    defaultArgs: [],
    prerequisites: ['node'],
  },
  {
    id: 'forge',
    name: 'Forge',





    cli: 'forgecode',
    installCommand:
      'curl -fsSL https://forgecode.dev/cli | sh && ' +
      'mkdir -p "$HOME/.local/bin" && ' +
      'FORGE_BIN="$(command -v forge 2>/dev/null || echo "$HOME/.local/bin/forge")" && ' +
      'ln -sf "$FORGE_BIN" "$HOME/.local/bin/forgecode"',
    docUrl: 'https://forgecode.dev/docs/',
    autoApproveFlag: null,
    defaultArgs: [],
    prerequisites: [],
  },
];

const PROVIDER_MAP = new Map(PROVIDERS.map((p: any) => [p.id, p]));

function getProvider(id: any) {
  return PROVIDER_MAP.get(id) || null;
}

function getAllAgentIds() {
  return PROVIDERS.map((p: any) => p.id);
}

// Returns the expected path where the provider persists the session for the
// given cwd + sessionId, or null if we don't know how to locate it. Callers
// use this to verify `--resume`-able sessions actually exist on disk before
// handing the id to the CLI, which avoids "Resume failed" fallbacks from
// stale ids Ace persisted before the CLI ever wrote a session file.
function resolveSessionFile(provider: any, cwd: any, sessionId: any) {
  const loc = provider?.resume?.sessionFileLocator;
  if (!loc || !sessionId) return null;
  if (loc === 'claude-projects') {
    if (!cwd) return null;
    const home = process.env.HOME || os.homedir();
    // Claude encodes the cwd by replacing any char not in [A-Za-z0-9_-] with
    // `-` (verified against ~/.claude/projects entries for paths with '/',
    // ' ', and '.').
    const encoded = String(cwd).replace(/[^A-Za-z0-9_-]/g, '-');
    return path.join(home, '.claude', 'projects', encoded, `${sessionId}.jsonl`);
  }
  if (loc === 'codex-sessions') {
    const home = process.env.HOME || os.homedir();
    return findCodexSessionFile(path.join(home, '.codex', 'sessions'), sessionId, cwd);
  }
  if (loc === 'hermes-sessions') {
    const home = process.env.HOME || os.homedir();
    return path.join(home, '.hermes', 'sessions', `session_${sessionId}.json`);
  }
  return null;
}

// When a lane's recorded session id no longer resolves to a file, find the
// newest non-empty session the CLI actually wrote for this cwd so the lane
// rebinds to its own real history instead of minting a fresh session (which
// permanently orphans the old transcript — the "lane changed streams" bug).
// `exclude` holds session ids already bound to OTHER lanes: project-root
// conversations share a cwd, and rebinding must never steal a sibling tab's
// session. Claude-projects only: codex resumes via the `seen` sentinel and
// hermes via `--continue`, so neither keeps a per-cwd session dir to scan.
function findNewestSessionIdInCwd(provider: any, cwd: any, exclude?: any) {
  if (provider?.resume?.sessionFileLocator !== 'claude-projects' || !cwd) return null;
  const home = process.env.HOME || os.homedir();
  const encoded = String(cwd).replace(/[^A-Za-z0-9_-]/g, '-');
  const dir = path.join(home, '.claude', 'projects', encoded);
  let best: any = null;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    const sessionId = entry.name.slice(0, -'.jsonl'.length);
    // Claude session files are uuid-named; skip anything else.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) continue;
    if (exclude && typeof exclude.has === 'function' && exclude.has(sessionId)) continue;
    let stat;
    try {
      stat = fs.statSync(path.join(dir, entry.name));
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size === 0) continue;
    if (!best || stat.mtimeMs > best.mtimeMs) best = { sessionId, mtimeMs: stat.mtimeMs };
  }
  return best ? best.sessionId : null;
}

// Classify a session file's on-disk state, DISTINGUISHING a definitive absence
// from a transient stat failure — the load-bearing distinction for the
// external-SSD false-missing bug. `fs.statSync` throws for BOTH "file is gone"
// (ENOENT) and "the volume momentarily could not be read" (EIO/ENOTCONN/EBUSY/
// EAGAIN/ETIMEDOUT/EPERM, an unmount race on /Volumes). The old callers
// collapsed every throw to "missing" and rebound the lane — stealing a sibling
// tab's transcript over a blip. Callers MUST treat 'unknown' as "assume
// present": resuming a genuinely-missing id self-heals via the fast-exit
// fallback, whereas rebinding on a false-missing is unrecoverable. `statFn` is
// injectable so tests can force each errno class deterministically.
function sessionFileState(file: any, statFn?: any): 'present' | 'absent' | 'unknown' {
  if (!file) return 'absent';
  const stat = typeof statFn === 'function' ? statFn : fs.statSync;
  try {
    return stat(file).isFile() ? 'present' : 'absent';
  } catch (err: any) {
    // Only ENOENT positively proves the file is gone; everything else is a
    // transient/ambiguous read of the (external) volume.
    return err && err.code === 'ENOENT' ? 'absent' : 'unknown';
  }
}

// Pure rebind-precedence decision. planRebindOrFresh gathers the inputs from the
// DB + disk; this decides which session (if any) a stale lane rebinds to.
// Precedence, highest first:
//   1) OWN HISTORY — a session THIS stream previously bound in this cwd whose
//      file still exists. It is the only candidate we KNOW belongs to the tab,
//      so it always wins over anything "newest in cwd".
//   2) NEWEST-IN-CWD — but ONLY when the cwd is unambiguous (<= 1 claude tab):
//      with a single tab the newest session is necessarily its own; with
//      siblings, "newest in cwd" is probably a SIBLING's session, and grabbing
//      it is the exact cross-attach bug.
//   3) FRESH — when siblings share the cwd and no own-history match exists, a
//      fresh (empty, obvious, recoverable) tab is strictly safer than silently
//      STEALING a sibling's live transcript.
// `taken` holds session ids already bound to (or reserved by) other lanes.
function decideSessionRebind({ ownHistory, taken, newestInCwd, claudeTabCount, staleSessionId }: any) {
  const isTaken = (sid: any) => !!(taken && typeof taken.has === 'function' && taken.has(sid));
  for (const h of Array.isArray(ownHistory) ? ownHistory : []) {
    const sid = h && h.sessionId;
    if (sid && h.exists && sid !== staleSessionId && !isTaken(sid)) {
      return { mode: 'resume', sessionId: sid, reason: 'rebind-own-history' };
    }
  }
  const unambiguousCwd = claudeTabCount == null || claudeTabCount <= 1;
  if (unambiguousCwd && newestInCwd && newestInCwd !== staleSessionId && !isTaken(newestInCwd)) {
    return { mode: 'resume', sessionId: newestInCwd, reason: 'rebind-newest' };
  }
  return { mode: 'fresh', sessionId: null, reason: 'fresh-no-match' };
}

function readCodexMeta(filePath: any) {
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(64 * 1024);
    const bytes = fs.readSync(fd, buf, 0, buf.length, 0);
    const raw = buf.slice(0, bytes).toString('utf8');
    const firstLine = raw.slice(0, raw.indexOf('\n') >= 0 ? raw.indexOf('\n') : raw.length);
    const evt = JSON.parse(firstLine);
    if (evt?.type !== 'session_meta') return null;
    return evt.payload || null;
  } catch {
    return null;
  } finally {
    if (fd != null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

function findCodexSessionFile(root: any, sessionId: any, cwd: any) {
  const wantId = String(sessionId || '');
  if (!wantId) return null;
  const wantCwd = cwd ? path.resolve(String(cwd)) : null;

  function visit(dir: any, depth: any): any {
    if (depth > 5) return null;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        const found = visit(full, depth + 1);
        if (found) return found;
        continue;
      }
      if (!ent.isFile() || !ent.name.endsWith('.jsonl') || !ent.name.includes(wantId)) {
        continue;
      }
      const meta = readCodexMeta(full);
      if (!meta || meta.id !== wantId) continue;
      if (wantCwd && (!meta.cwd || path.resolve(String(meta.cwd)) !== wantCwd)) continue;
      return full;
    }
    return null;
  }

  return visit(root, 0);
}

function applyResumeArgs(provider: any, defaultArgs: any, mode: any, freshSessionId: any, storedSessionId: any) {
  const args = Array.isArray(defaultArgs) ? defaultArgs.slice() : [];
  const resume = provider?.resume;
  if (!resume) return args;
  if (mode === 'fresh') {
    if (resume.style === 'flag' && resume.sessionIdFlag && freshSessionId) {
      args.unshift(resume.sessionIdFlag, freshSessionId);
    }
    return args;
  }
  if (mode === 'resume') {
    if (resume.style === 'flag' && resume.token && storedSessionId) {
      args.unshift(resume.token, storedSessionId);
      return args;
    }
    if (
      resume.style === 'subcommand' &&
      resume.exactToken &&
      storedSessionId &&
      storedSessionId !== 'seen'
    ) {
      args.unshift(resume.exactToken, storedSessionId);
      return args;
    }
    if (resume.style === 'subcommand' && Array.isArray(resume.tokens)) {
      args.unshift(...resume.tokens);
      return args;
    }
    if (
      resume.style === 'token' &&
      resume.exactToken &&
      storedSessionId &&
      storedSessionId !== 'seen' &&
      (!resume.exactSessionIdPattern || resume.exactSessionIdPattern.test(String(storedSessionId)))
    ) {
      args.unshift(resume.exactToken, storedSessionId);
      return args;
    }
    if (resume.style === 'token' && resume.token) {
      args.unshift(resume.token);
      return args;
    }
  }
  return args;
}

module.exports = {
  PROVIDERS,
  PREREQUISITES,
  getProvider,
  getAllAgentIds,
  applyResumeArgs,
  resolveSessionFile,
  findNewestSessionIdInCwd,
  sessionFileState,
  decideSessionRebind,
};
