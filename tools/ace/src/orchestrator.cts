// High-level orchestration on top of the raw Ace primitives.
//
// runTask: one-call "spawn → deliver framed prompt → wait turn-complete →
// parse DONE/BLOCKED → optionally loop" — the building block Hermes and
// in-tab agents use to delegate a whole task to a sub-agent.
//
// runChat: scripted multi-turn where each step declares its own wait
// predicate. For structured ping-pong beyond the DONE/BLOCKED trailer.
//
// All calls go through the shared client from client.cjs so the MCP shim
// and the CLI hit the same socket with the same semantics — no drift.

const {
  buildTaskPromptEnvelope,
  parseTrailer,
  lastLine,
  resolveRoleMode: resolvePromptRoleMode,
} = require('./prompt.cjs');
const { deriveNextStep } = require('./next-step.cjs');
const { parseSpec, normalizeGoalMode } = require('./spec.cjs');
const { routeForSpec } = require('./routing-policy.cjs');
const {
  createChildRegistry,
  createFileDb,
  defaultStorePath,
} = require('./child-registry.cjs');
const { evaluateMergeGate } = require('./pr-gate.cjs');
const { launchIntentSkillIds } = require('./skill-loader.cjs');
const { execFileSync } = require('child_process');

const DEFAULT_WAIT_TIMEOUT = 10 * 60 * 1000; // 10 min per round
const DEFAULT_MAX_ROUNDS = 3;
const DEFAULT_MAX_VERIFY_ROUNDS = 3;
const DEFAULT_MODE = 'paste';
const REFRESH_BASE_MODES = new Set(['false', 'auto', 'force']);
const CLAUDE_LAUNCH_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const CODEX_LAUNCH_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh']);
const CODEX_APP_PARITY_PROFILE = 'app-parity';
const CODEX_APP_PARITY_FEATURE_OVERRIDES = Object.freeze([
  'features.apps=true',
  'features.plugins=true',
  'features.browser_use=true',
  'features.browser_use_external=true',
  'features.computer_use=true',
  'features.in_app_browser=true',
  'features.enable_mcp_apps=true',
]);
const CODEX_APP_PARITY_CAPABILITIES = new Set(['app-parity', 'computer-use', 'browser']);
const TASK_RUN_RESULT_SCHEMA = 'AceTaskRunResult/v1';
const TASK_RUN_RESULT_VERSION = 1;
const TASK_RUN_TELEMETRY_SCHEMA = 'AceTaskRunTelemetry/v1';
let cachedCodexCliVersion: string | null | undefined;

// Heuristic: does this spec imply the worker should produce real code/file
// changes, or is it pure research/analysis? Used when the caller didn't
// explicitly set requireChanges. Matches common code-task phrasing in
// deliverables and acceptance.
const CODE_HINT_RX = /\.(ts|tsx|js|jsx|cjs|mjs|py|go|rs|java|rb|md|css|html|json|yaml|yml)\b|src\/|tests?\/|spec\/|\bfile\b|\bcommit\b|npm run|yarn |pnpm |make\b|cargo\b|pytest|jest|mocha|vitest/i;

function specImpliesCode(spec: any) {
  const pieces = []
    .concat(asArray(spec?.deliverables))
    .concat(asArray(spec?.acceptance))
    .concat(asArray(spec?.constraints))
    .concat([spec?.goal || '', spec?.context || '']);
  for (const p of pieces) {
    if (CODE_HINT_RX.test(String(p || ''))) return true;
  }
  return false;
}

function asArray(v: any) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function isReadOnlyRoleMode(spec: any) {
  const roleMode = resolvePromptRoleMode(spec);
  return roleMode === 'reviewer' || roleMode === 'no-code';
}

function normalizeMaxRounds(value: any, fallback: any) {
  if (value === 0) return { limit: Infinity, unbounded: true };
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return { limit: Math.floor(n), unbounded: false };
  return { limit: fallback, unbounded: false };
}

function normalizeBudgetCount(value: any, fallback: number) {
  const n = Number(value);
  if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  return fallback;
}

function isCodexAgent(agent: any) {
  return String(agent || '').trim().toLowerCase() === 'codex';
}

function isClaudeDriver(agent: any) {
  const driver = String(agent || '').trim().toLowerCase();
  return driver === 'claude' || driver === 'claude-code';
}

function normalizeCodexRuntimeProfile(value: any) {
  const profile = String(value || '').trim().toLowerCase();
  if (profile === CODEX_APP_PARITY_PROFILE || profile === 'app_parity') return CODEX_APP_PARITY_PROFILE;
  return '';
}

function codexToolOverrideReason(telemetry: any = {}) {
  for (const candidate of [
    telemetry?.toolOverrideReason,
    telemetry?.tool_override_reason,
    telemetry?.appParityAuditReason,
    telemetry?.app_parity_audit_reason,
  ]) {
    const reason = String(candidate || '').trim();
    if (reason) return reason;
  }
  return '';
}

function codexAppParityRequest(telemetry: any = {}) {
  const explicit = normalizeCodexRuntimeProfile(
    telemetry?.codexRuntimeProfile || telemetry?.codex_runtime_profile || telemetry?.runtimeProfile || telemetry?.runtime_profile
  );
  const capabilities = new Set(asArray(telemetry?.capabilities).map((c: any) => String(c || '').trim().toLowerCase()));
  const appParityCapabilities = [...capabilities].filter((cap) => CODEX_APP_PARITY_CAPABILITIES.has(cap));
  const browserMode = String(telemetry?.browserMode || '').trim().toLowerCase();
  const toolMode = String(telemetry?.toolMode || '').trim().toLowerCase();
  return {
    explicit,
    appParityCapabilities,
    modeRequested: browserMode === 'on' || toolMode === 'on',
    auditReason: codexToolOverrideReason(telemetry),
  };
}

function codexAppParityRequested(telemetry: any = {}) {
  const request = codexAppParityRequest(telemetry);
  return Boolean(
    request.auditReason &&
      (request.explicit || request.modeRequested || request.appParityCapabilities.length)
  );
}

// launchIntentSkillIds moved to ./skill-loader.cjs (imported above) so the
// Mission Board dispatch path in electron/local-core can share the exact same
// extractor — keeping skill→doctrine wiring identical on both spawn paths.

function buildLaunchIntent(driver: any, telemetry: any = {}) {
  const effort = String(telemetry?.effort || '').trim().toLowerCase();
  const skillIds = launchIntentSkillIds(telemetry);
  if (isClaudeDriver(driver)) {
    const reasoningEffort = CLAUDE_LAUNCH_EFFORTS.has(effort) ? effort : null;
    // UltraCode is the in-session `/effort ultracode` prelude — orthogonal to
    // the `--effort` reasoning flag. The `max` lane implies it, and a caller
    // (the spine, for every Claude worker) can request it explicitly at any
    // effort via spec.ultraCode → telemetry.ultraCode, so a Claude worker runs
    // at xhigh AND enters UltraCode/dynamic-workflow before its brief.
    const ultraCode = reasoningEffort === 'max' || telemetry?.ultraCode === true;
    return {
      provider: 'claude',
      // Explicit lane-ownership marker: every intent this producer mints is a
      // DELEGATED orchestrator worker, so lane classification (the MCP/plugin/
      // connector strip) reads this flag, not the `provider` shape.
      delegated: true,
      reasoningEffort,
      cliArgs: reasoningEffort ? ['--effort', reasoningEffort] : [],
      workflowMode: ultraCode ? 'dynamic-workflow' : null,
      ultraCode,
      effortCommand: ultraCode ? '/effort ultracode' : null,
      preludeCommands: ultraCode ? ['/effort ultracode'] : [],
      guidance: ultraCode
        ? 'Claude max lanes must enter UltraCode/dynamic-workflow with /effort ultracode before /goal delivery; xhigh remains extra-high reasoning only.'
        : null,
      skillIds,
      warnings: [],
    };
  }
  if (!isCodexAgent(driver)) return null;
  const unsupportedReasoningEffort = effort && !CODEX_LAUNCH_EFFORTS.has(effort) ? effort : null;
  const reasoningEffort = CODEX_LAUNCH_EFFORTS.has(effort) ? effort : null;
  const toolMode = String(telemetry?.toolMode || 'off').trim().toLowerCase();
  const mcpMode = String(telemetry?.mcpMode || 'off').trim().toLowerCase();
  // Model pin (spec.codexModel → telemetry.codexModel): delivered to the codex
  // CLI as `-c model="<id>"` via applyCodexConfigOverrides ('model' is in
  // CODEX_SAFE_TOP_LEVEL_CONFIG_KEYS). Empty ⇒ the user's config.toml model.
  const codexModel = String(telemetry?.codexModel || telemetry?.codex_model || '').trim();
  const appParityRequest = codexAppParityRequest(telemetry);
  const appParityRequested = Boolean(
    appParityRequest.explicit || appParityRequest.modeRequested || appParityRequest.appParityCapabilities.length
  );
  const appParity = appParityRequested && Boolean(appParityRequest.auditReason);
  const warnings = [];
  if (unsupportedReasoningEffort) {
    warnings.push(
      `Codex reasoning effort "${unsupportedReasoningEffort}" is not supported by the Ace Codex launcher; use xhigh or choose Claude max.`
    );
  }
  if (appParityRequested && !appParityRequest.auditReason) {
    warnings.push(
      'Codex app-parity runtime requires toolOverrideReason when requested by codexRuntimeProfile, tool/browser mode, or app/browser/computer-use capabilities.'
    );
  }
  return {
    provider: 'codex',
    // Explicit lane-ownership marker (see the Claude branch): a delegated
    // orchestrator worker, classified by this flag rather than `provider` shape.
    delegated: true,
    reasoningEffort,
    codexConfigOverrides: [
      ...(codexModel ? [`model="${codexModel}"`] : []),
      ...(reasoningEffort ? [`model_reasoning_effort="${reasoningEffort}"`] : []),
      ...(appParity ? CODEX_APP_PARITY_FEATURE_OVERRIDES : []),
    ],
    ...(appParity ? {
      codexRuntimeProfile: CODEX_APP_PARITY_PROFILE,
      toolOverrideReason: appParityRequest.auditReason,
      appServer: { required: true },
      pluginSurface: { required: true },
      computerUse: { required: true },
      readinessChecks: [
        'codex --help exposes app-server/plugin/features',
        'codex app-server --help exposes --listen',
        'codex features list includes apps/plugins/browser_use/browser_use_external/computer_use/in_app_browser/enable_mcp_apps',
      ],
    } : {}),
    requestedToolMode: toolMode || 'off',
    requestedMcpMode: mcpMode || 'off',
    enableMcp: appParity || mcpMode !== 'off',
    effectiveToolMode: appParity ? CODEX_APP_PARITY_PROFILE : 'off',
    ...(appParityRequested ? {
      requestedCodexRuntimeProfile: appParityRequest.explicit || CODEX_APP_PARITY_PROFILE,
      appParityAuditReason: appParityRequest.auditReason || null,
    } : {}),
    ...(unsupportedReasoningEffort ? { requestedReasoningEffort: unsupportedReasoningEffort } : {}),
    ...(unsupportedReasoningEffort || (appParityRequested && !appParityRequest.auditReason) ? { blocked: true } : {}),
    skillIds,
    warnings,
  };
}

function assertLaunchIntentSupported(launchIntent: any) {
  if (!launchIntent?.blocked) return;
  const err: any = new Error(
    launchIntent.warnings?.[0] || 'launch intent is unsupported by this launcher'
  );
  err.code = 2;
  err.error = 'invalid_spec';
  throw err;
}

function isClaudeAgent(agent: any) {
  const a = String(agent || '').trim().toLowerCase();
  return a === 'claude' || a === 'claude-code';
}

// Stale-booting fallback: the Claude Ace's prompt is visible on screen
// but the state machine has not transitioned out of `booting`. This can
// happen when the ready-pattern check loses a race against busy-footer
// remnants or terminal redraws, leaving an empty worker that never
// receives the task prompt. A visible `❯` line with no busy footer is a
// strong signal Claude is actually idle.
const CLAUDE_VISIBLE_READY_RX =
  /(?:^|\n)[ \t ]*(?:│[ \t ]*)?[❯>](?:[ \t ]+|[ \t ]*▌|$)/m;
const CLAUDE_VISIBLE_BUSY_FOOTER_RX = /esc to interrupt|esc\s*\(interrupt\)/i;

function screenShowsStaleClaudePrompt({ state, screenText }: any) {
  if (state !== 'booting') return false;
  const text = String(screenText || '');
  if (!text) return false;
  if (CLAUDE_VISIBLE_BUSY_FOOTER_RX.test(text)) return false;
  return CLAUDE_VISIBLE_READY_RX.test(text);
}

function specSizeClass(spec: any) {
  return String(spec?.sizeClass || spec?.size_class || '').trim().toLowerCase();
}

function normalizeRefreshBaseMode(value: any) {
  const mode = String(value == null ? 'false' : value).trim().toLowerCase();
  return REFRESH_BASE_MODES.has(mode) ? mode : 'false';
}

function mcpModeForProvider(_provider: any, spec: any = null) {
  return String(spec?.mcpMode || spec?.mcp_mode || 'off').trim().toLowerCase() || 'off';
}

function compactGoalLine(value: any, maxChars = 220) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1)).trim()}…`;
}

function firstItems(value: any, limit: number) {
  return Array.isArray(value) ? value.map((item: any) => compactGoalLine(item, 180)).filter(Boolean).slice(0, limit) : [];
}

function buildGoalCommand(spec: any, budget: any = {}, opts: any = {}) {
  // `rich` mode: for a Claude goal worker the /goal IS the whole delivery (it
  // auto-starts the worker, so no separate framed brief follows), so carry the
  // full goal + acceptance + constraints + deliverables, capped under the 4000-
  // char /goal argument limit. Codex keeps the compact pointer (its brief lands
  // separately right after).
  const rich = opts.rich === true;
  const goal = compactGoalLine(spec?.goal, rich ? 600 : 360);
  const constraints = firstItems(spec?.constraints, rich ? 6 : 2);
  const acceptance = firstItems(spec?.acceptance, rich ? 8 : 2);
  const deliverables = rich ? firstItems(spec?.deliverables, 3) : [];
  const ledgerPath = String(spec?.goalLedgerPath || spec?.goal_ledger_path || '').trim();
  // File-first: when a GoalAgentSpec/ValidatorGoalSpec exists, point the
  // worker at it instead of inlining the goal/constraints/acceptance — the
  // spec file is the durable instruction; the /goal call is a pointer.
  const specPath = String(
    spec?.workerSpecPath ||
      spec?.worker_spec_path ||
      spec?.validatorSpecPath ||
      spec?.validator_spec_path ||
      spec?.goalAgentSpecPath ||
      spec?.goal_agent_spec_path ||
      ''
  ).trim();
  const budgetParts = [];
  if (budget.maxRounds === 0 || spec?.maxRounds === 0 || spec?.max_rounds === 0) budgetParts.push('unbounded rounds allowed until terminal result');
  else {
    const maxRounds = budget.maxRounds ?? spec?.maxRounds ?? spec?.max_rounds;
    if (Number.isFinite(maxRounds)) budgetParts.push(`max rounds ${maxRounds}`);
  }
  const maxVerifyRounds = budget.maxVerifyRounds ?? spec?.maxVerifyRounds ?? spec?.max_verify_rounds;
  if (Number.isFinite(maxVerifyRounds)) budgetParts.push(`verify rounds ${maxVerifyRounds}`);
  const head = specPath
    ? `Complete the GoalAgentSpec at ${specPath}.`
    : `Complete ${goal}`;
  const objective = [
    head,
    !specPath && constraints.length ? `Constraints: ${constraints.join('; ')}` : '',
    acceptance.length ? `Done when: ${acceptance.join('; ')}` : 'Done when all acceptance criteria pass with evidence.',
    !specPath && deliverables.length ? `Deliver: ${deliverables.join('; ')}` : '',
    'BLOCKED on unsafe scope, missing guidance, or exhausted budget.',
    ledgerPath
      ? `Maintain the ledger at ${ledgerPath} and keep implementation-notes.html current at checkpoints, before compaction, and before final handoff.`
      : '',
    budgetParts.length ? `Budget: ${budgetParts.join(', ')}.` : '',
  ].filter(Boolean).join(' ');
  return `/goal ${compactGoalLine(objective, rich ? 3500 : 1200)}`;
}

function shouldQueueCodexGoal({ agent, spec, goalMode, fireAndForget = false, routeInferredTaskClass = false }: any) {
  const mode = normalizeGoalMode(goalMode || spec?.goalMode) || 'auto';
  if (!isCodexAgent(agent) || mode === 'off') return { mode, queue: false };
  // goalMode:on (or goalLedgerMode:on) is a hard signal — this run is a
  // true goal agent, so /goal must be queued even when the caller is using
  // fire-and-forget dispatch. Previously fireAndForget=true short-circuited
  // every queue path, which made Mission dispatch/wave/validate effectively
  // skip Codex's native /goal setup.
  const ledgerMode = String(spec?.goalLedgerMode || spec?.goal_ledger_mode || '').trim().toLowerCase();
  if (mode === 'on' || ledgerMode === 'on') return { mode, queue: true };
  if (fireAndForget === true) return { mode, queue: false };
  const sizeClass = specSizeClass(spec);
  const taskClass = String(spec?.taskClass || '').trim().toLowerCase();
  const taskType = String(spec?.taskType || '').trim().toLowerCase();
  const roleMode = resolvePromptRoleMode(spec);
  const codeOrUiTask =
    (!routeInferredTaskClass && (taskClass === 'code_change' || taskClass === 'ui_product_design')) ||
    taskType === 'ui' ||
    taskType === 'frontend' ||
    specImpliesCode(spec);
  const queue =
    sizeClass === 'medium' ||
    sizeClass === 'large' ||
    (codeOrUiTask && roleMode !== 'reviewer' && roleMode !== 'no-code');
  return { mode, queue };
}

function codexCliVersion() {
  if (cachedCodexCliVersion !== undefined) return cachedCodexCliVersion;
  try {
    const out = execFileSync('codex', ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1000,
    });
    cachedCodexCliVersion = String(out || '').trim() || null;
  } catch {
    cachedCodexCliVersion = null;
  }
  return cachedCodexCliVersion;
}

// Queue the `/goal <objective>` prelude turn. Engine-agnostic: `/goal` is the
// native goal-mode trigger on BOTH Codex and Claude (ace-goal-worker), so
// this same prelude locks either driver onto its objective before the framed
// brief lands.
async function queueGoalMode(client: any, { streamId, timeoutMs, mode, spec, maxRounds, maxVerifyRounds }: any) {
  const readyTimeoutMs = timeoutMs > 0
    ? Math.max(5_000, timeoutMs)
    : Math.min(DEFAULT_WAIT_TIMEOUT, 30_000);
  // By the time goal-mode is queued the Claude UltraCode prelude (or Codex's
  // direct boot) has already cleared any approval gate, so a plain awaitingInput
  // wait is correct here.
  await client.invoke('streamWaitFor', {
    streamId,
    predicate: { awaitingInput: true },
    timeoutMs: readyTimeoutMs,
  });
  await client.invoke('streamSendInput', {
    streamId,
    text: buildGoalCommand(spec, { maxRounds, maxVerifyRounds }),
    mode: mode || DEFAULT_MODE,
  });
  await client.invoke('streamSubmit', { streamId });
  await client.invoke('streamWaitFor', {
    streamId,
    predicate: { awaitingInput: true },
    timeoutMs: readyTimeoutMs,
  });
}

// Boot/prelude readiness that ALSO clears an initial approval gate. A Claude
// worker can spawn into `awaiting-approval` (the trust/permission prompt) BEFORE
// it ever reaches `awaiting-input`; a bare awaitingInput wait would hang there
// until timeout and the framed prompt would never be delivered (the empty-turn
// dispatch bug). Wait for either state, approve any pending gate, then re-wait
// for input. Harmless for Codex — it reaches awaiting-input directly, so the
// loop returns on the first wait with no approval sent.
async function waitReadyClearingApprovals(client: any, { streamId, timeoutMs, maxApprovals = 3 }: any) {
  const readyTimeoutMs = timeoutMs > 0
    ? Math.max(5_000, timeoutMs)
    : Math.min(DEFAULT_WAIT_TIMEOUT, 30_000);
  let approvals = 0;
  for (;;) {
    const waitResult = await client.invoke('streamWaitFor', {
      streamId,
      predicate: { awaitingInputOrApproval: true },
      timeoutMs: readyTimeoutMs,
    });
    let state = waitResult && waitResult.state;
    if (!state) {
      try { state = (await client.invoke('streamGetState', { streamId }))?.state; } catch {}
    }
    if (state === 'awaiting-approval' && approvals < maxApprovals) {
      approvals += 1;
      try { await client.invoke('streamApprove', { streamId, answer: 'yes' }); } catch {}
      continue;
    }
    return { state, approvals, elapsedMs: waitResult && waitResult.elapsedMs };
  }
}

function shouldQueueClaudeUltraCodePrelude({ agent, launchIntent }: any) {
  return isClaudeDriver(agent) && launchIntent?.ultraCode === true && !!launchIntent?.effortCommand;
}

// Inline (non-file-first) goals: a Claude worker should also enter native
// goal-mode with a `/goal <objective>` prelude — the same way Codex does — so
// both engines spawn in /goal mode. File-first specs already lead the framed
// prompt with `/goal` (prompt.cts), so re-queuing it there would double up.
function specIsFileFirstGoal(spec: any) {
  const specPath = String(
    spec?.workerSpecPath || spec?.worker_spec_path ||
      spec?.validatorSpecPath || spec?.validator_spec_path ||
      spec?.goalAgentSpecPath || spec?.goal_agent_spec_path || ''
  ).trim();
  if (!specPath) return false;
  const mode = String(spec?.goalMode || '').trim().toLowerCase();
  const ledgerMode = String(spec?.goalLedgerMode || spec?.goal_ledger_mode || '').trim().toLowerCase();
  return mode === 'on' || ledgerMode === 'on';
}

function shouldQueueClaudeGoal({ agent, spec, goalMode }: any) {
  if (!isClaudeDriver(agent)) return { queue: false };
  const mode = normalizeGoalMode(goalMode || spec?.goalMode) || 'auto';
  if (mode === 'off') return { queue: false };
  const ledgerMode = String(spec?.goalLedgerMode || spec?.goal_ledger_mode || '').trim().toLowerCase();
  if (mode !== 'on' && ledgerMode !== 'on') return { queue: false };
  if (specIsFileFirstGoal(spec)) return { queue: false };
  return { queue: true };
}

// Claude slash-command preludes (`/effort ultracode`, `/goal …`) must be TYPED,
// never bracket-pasted: a pasted slash line shows as "[Pasted text #N]" and
// Claude's slash parser never fires, so two pasted preludes collide into one
// rejected line (e.g. `/effort ultracode/goal Complete…` → "Invalid argument").
// streamSendSubmit(mode:'type') types char-by-char (the slash parser fires) and
// runs Claude's submit/re-submit safety net; the trailing awaitingInput wait +
// settle let the command execute and clear the input before the next prelude.
async function sendClaudeSlashPrelude(client: any, { streamId, text, timeoutMs }: any) {
  const readyTimeoutMs = timeoutMs > 0
    ? Math.max(5_000, timeoutMs)
    : Math.min(DEFAULT_WAIT_TIMEOUT, 30_000);
  await waitReadyClearingApprovals(client, { streamId, timeoutMs: readyTimeoutMs });
  await client.invoke('streamSendSubmit', { streamId, text, mode: 'type' });
  await client.invoke('streamWaitFor', {
    streamId,
    predicate: { awaitingInput: true },
    timeoutMs: readyTimeoutMs,
  });
  // Settle so Claude finishes executing the slash command and clears the input
  // line before the next prelude (or the framed brief) types into it.
  await new Promise((r) => setTimeout(r, 400));
}

function telemetryWithTimings(base: any, timings: any = {}) {
  const readyMs = timings.readyMs ?? base?.timings?.readyMs ?? base?.readyMs ?? null;
  const promptMs = timings.promptMs ?? base?.timings?.promptMs ?? base?.promptMs ?? null;
  const firstOutputMs = timings.firstOutputMs ?? base?.timings?.firstOutputMs ?? base?.firstOutputMs ?? null;
  const provider = base?.provider || base?.driver || null;
  return {
    ...base,
    schema: base?.schema || TASK_RUN_TELEMETRY_SCHEMA,
    version: base?.version || TASK_RUN_RESULT_VERSION,
    provider,
    codexCliVersion: provider === 'codex' ? codexCliVersion() : null,
    roleMode: base?.roleMode || null,
    taskType: base?.taskType || 'generic',
    skillPack: base?.skillPack || null,
    renderedPromptChars: typeof base?.renderedPromptChars === 'number' ? base.renderedPromptChars : null,
    skillCount: typeof base?.skillCount === 'number' ? base.skillCount : null,
    mcpMode: base?.mcpMode || 'off',
    toolMode: base?.toolMode || 'off',
    browserMode: base?.browserMode || 'off',
    effort: base?.effort || null,
    launchIntent: base?.launchIntent || null,
    baseRefreshMode: base?.baseRefreshMode || 'false',
    readyMs,
    promptMs,
    firstOutputMs,
    timings: {
      readyMs,
      promptMs,
      firstOutputMs,
    },
  };
}

function taskRunResult(result: any) {
  return {
    schema: TASK_RUN_RESULT_SCHEMA,
    version: TASK_RUN_RESULT_VERSION,
    ...result,
  };
}

function spawnTelemetry(base: any, context: any, timings: any = {}) {
  return telemetryWithTimings({
    ...base,
    provider: context.provider || base?.driver || null,
    streamId: context.streamId || null,
    taskId: context.taskId || null,
    mcpMode: context.mcpMode || 'global',
    baseRefreshMode: context.baseRefreshMode || 'false',
  }, timings);
}

function logPromptTelemetry(phase: any, telemetry: any) {
  if (!telemetry) return;
  const timing = telemetry.timings || {};
  console.error(
    [
      `[ace] ${phase}`,
      `renderedPromptChars=${telemetry.renderedPromptChars}`,
      `skillCount=${telemetry.skillCount}`,
      `taskType=${telemetry.taskType || 'generic'}`,
      `driver=${telemetry.driver || 'unknown'}`,
      `effort=${telemetry.effort || 'unknown'}`,
      `mcpMode=${telemetry.mcpMode || 'off'}`,
      `toolMode=${telemetry.toolMode || 'off'}`,
      `browserMode=${telemetry.browserMode || 'off'}`,
      `roleMode=${telemetry.roleMode || 'unknown'}`,
      `readyMs=${timing.readyMs ?? 'na'}`,
      `promptMs=${timing.promptMs ?? 'na'}`,
      `firstOutputMs=${timing.firstOutputMs ?? 'na'}`,
    ].join(' ')
  );
}

// Resolve a streamId to run against. Priority:
//  1. Explicit streamId (attach to an existing tab)
//  2. Spawn via streamSpawn (requires an existing taskId)
//  3. newTask=true + workspaceId: create a real task (new branch + worktree)
//     via streamCreateDelegatedTask, then spawn into it. Feature-delegation path.
//  4. Spawn via streamSpawnAdhoc (requires workspaceId; creates a thread task
//     with no worktree — chat-only aside).
const WORKTREE_REQUIRED_KINDS = new Set(['mission-board', 'mission-fixback', 'goal-agent']);
const WORKTREE_REQUIRED_TASK_TYPES = new Set([
  'feature-impl',
  'validator',
  'validator-merger',
  'fixback',
  'release',
]);

function requiresWorktreeBackedStream({ kind, taskType }: any = {}) {
  const normalizedKind = String(kind || '').trim().toLowerCase();
  const normalizedTaskType = String(taskType || '').trim().toLowerCase();
  return WORKTREE_REQUIRED_KINDS.has(normalizedKind) || WORKTREE_REQUIRED_TASK_TYPES.has(normalizedTaskType);
}

function effectiveStreamKindForTask(kind: any, spec: any = {}) {
  const requested = String(kind || 'cli').trim() || 'cli';
  if (requiresWorktreeBackedStream({ kind: requested, taskType: spec?.taskType })) {
    return requested === 'chat' ? 'task-worktree' : requested;
  }
  return requested;
}

async function ensureStream(client: any, { streamId, agent, taskId, workspaceId, newTask, kind, label, goal, taskType, prompt, refreshBase, waveId, laneId, launchIntent }: any) {
  if (streamId) return { streamId, created: false };
  if (!agent) throw new Error('ensureStream: agent required when no streamId');

  if (taskId) {
    const res = await client.invoke('streamSpawn', {
      agent,
      taskId,
      kind: kind || 'cli',
      ...(launchIntent ? { launchIntent } : {}),
    });
    if (!res || !res.streamId) throw new Error('streamSpawn returned no streamId');
    return { streamId: res.streamId, conversationId: res.conversationId, taskId, created: true };
  }

  if (newTask && workspaceId) {
    const created = await client.invoke('streamCreateDelegatedTask', {
      workspaceId,
      agent,
      goal: goal || null,
      label: label || null,
      taskType: taskType || null,
      refreshBase: normalizeRefreshBaseMode(refreshBase),
      // Persist the framed prompt to tasks.initial_prompt so the worker-tab
      // TaskSpecPane can render Goal/Constraints/Deliverables read-only,
      // driver-agnostic. Without this, Codex tabs (which don't surface the
      // initial user turn in their own scrollback) show "No spec recorded".
      prompt: prompt || null,
      ...(waveId ? { waveId, laneId: laneId || null } : {}),
    });
    if (!created || !created.taskId) {
      throw new Error('streamCreateDelegatedTask returned no taskId');
    }

    const worktreeRequired = requiresWorktreeBackedStream({ kind, taskType });

    let variantSpawnError: any = null;
    if (created.variantId) {
      try {
        const res = await client.invoke('streamSpawnIntoVariant', {
          variantId: created.variantId,
          agent,
          ...(launchIntent ? { launchIntent } : {}),
        });
        if (!res || !res.streamId) throw new Error('streamSpawnIntoVariant returned no streamId');
        return {
          streamId: res.streamId,
          conversationId: null,
          taskId: created.taskId,
          worktreeId: created.worktreeId,
          worktreePath: created.worktreePath,
          branch: created.branch,
          baseBranch: created.baseBranch,
          baseHygiene: created.baseHygiene || null,
          baseRefreshMode: created.baseRefreshMode || normalizeRefreshBaseMode(refreshBase),
          created: true,
        };
      } catch (err) {
        variantSpawnError = err;
        console.warn(
          `[ace] ensureStream fallback to streamSpawn for task ${created.taskId}: ${err && err.message ? err.message : err}`
        );
      }
    }

    if (worktreeRequired) {
      const reason = created.variantId
        ? `streamSpawnIntoVariant failed${variantSpawnError && variantSpawnError.message ? `: ${variantSpawnError.message}` : ''}`
        : 'streamCreateDelegatedTask returned no variantId';
      throw new Error(`worktree-backed GoalAgent spawn requires a delegated variant (${reason})`);
    }

    const res = await client.invoke('streamSpawn', {
      agent,
      taskId: created.taskId,
      kind: effectiveStreamKindForTask(kind, { taskType }),
      ...(launchIntent ? { launchIntent } : {}),
    });
    if (!res || !res.streamId) throw new Error('streamSpawn (after createDelegatedTask) returned no streamId');
    return {
      streamId: res.streamId,
      conversationId: res.conversationId,
      taskId: created.taskId,
      worktreeId: created.worktreeId,
      worktreePath: created.worktreePath,
      branch: created.branch,
      baseBranch: created.baseBranch,
      baseHygiene: created.baseHygiene || null,
      baseRefreshMode: created.baseRefreshMode || normalizeRefreshBaseMode(refreshBase),
      created: true,
    };
  }

  if (workspaceId) {
    const res = await client.invoke('streamSpawnAdhoc', {
      agent,
      workspaceId,
      kind: kind || 'cli',
      label: label || null,
      initialPrompt: prompt || null,
      ...(launchIntent ? { launchIntent } : {}),
    });
    if (!res || !res.streamId) throw new Error('streamSpawnAdhoc returned no streamId');
    return {
      streamId: res.streamId,
      conversationId: res.conversationId,
      taskId: res.taskId,
      created: true,
    };
  }

  throw new Error(
    'ensureStream: need one of {streamId, taskId, workspaceId} to locate or create a stream'
  );
}

// One turn: deliver the prompt, wait for turn-complete or awaiting-approval,
// return the worker's new output. Thin wrapper over streamAsk — we keep it
// separate from runTask because MCP's ace_ask tool and runChat both
// want the same primitive without the multi-round logic.
// Note: streamAsk still honors profile safety (for example Gemini disables
// bracketed paste), but the caller's `mode` now flows through both normal and
// fire-and-forget task delivery.
async function askOnce(client: any, { streamId, prompt, timeoutMs, mode, caller, command }: any) {
  const params: any = { streamId, prompt };
  if (timeoutMs != null) params.timeoutMs = timeoutMs;
  if (mode) params.mode = mode;
  if (caller?.streamId) params.caller = { ...caller, command: command || caller.command || 'ask' };
  const clientTimeoutMs = Math.max(60_000, (timeoutMs || DEFAULT_WAIT_TIMEOUT) + 15_000);
  return client.invoke('streamAsk', params, clientTimeoutMs);
}

function summarizeForNextRound(newOutput: any, limit: any = 2400) {
  const body = String(newOutput || '').trim();
  if (body.length <= limit) return body;
  // Keep the end — the trailer and recent reasoning matter more than the
  // first page of a long turn.
  return `…[truncated ${body.length - limit} chars]…\n` + body.slice(-limit);
}

// Extract the PR URL and number from `gh pr create` stdout. gh prints the URL
// on its own line when the PR is created successfully; we match the canonical
// github.com/<owner>/<repo>/pull/<n> shape rather than trusting the first URL.
function parsePrFromStdout(stdout: any) {
  const text = String(stdout || '');
  const match = text.match(/https?:\/\/[^\s]*\/pull\/(\d+)/);
  if (!match) return { prUrl: null, prNumber: null };
  return { prUrl: match[0], prNumber: Number(match[1]) };
}

function appendDetail(detail: any, extra: any) {
  if (!extra) return detail || null;
  return `${detail || ''}${detail ? '; ' : ''}${extra}`;
}

// NOTE: the inline auto-chain (spec.integrate.autoChain — validate/fixback/
// merge/release driven from inside runTask) was REMOVED. The mission-card bus
// loop (electron/ace-control/auto-rally.cts + auto-validator.cts) is the
// only chain; runTask's integrate flow is push → openPr → optional EXPLICIT
// gated merge, nothing more.
function normalizeIntegrateSpec(spec: any) {
  const raw = spec?.integrate;
  if (raw === true) {
    return {
      push: true,
      openPr: true,
      merge: null,
      title: null,
      body: null,
      draft: false,
      postMergeCleanup: true,
    };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const openPr = raw.openPr !== false;
  const openPrOptions =
    openPr && raw.openPr && typeof raw.openPr === 'object' ? raw.openPr : {};
  const merge =
    raw.merge === true
      ? {}
      : raw.merge && typeof raw.merge === 'object' && !Array.isArray(raw.merge)
        ? { ...raw.merge }
        : null;
  return {
    push: raw.push !== false,
    openPr,
    merge,
    title:
      typeof raw.title === 'string'
        ? raw.title
        : typeof openPrOptions.title === 'string'
          ? openPrOptions.title
          : null,
    body:
      typeof raw.body === 'string'
        ? raw.body
        : typeof openPrOptions.body === 'string'
          ? openPrOptions.body
          : null,
    // Default NON-draft: the merge gate hard-fails draft PRs (pr-gate.cts
    // draft_pr) and nothing in the loop un-drafts, so a draft default makes
    // every gated merge dead on arrival. Explicit draft:true is still honored.
    draft:
      typeof raw.draft === 'boolean'
        ? raw.draft
        : typeof openPrOptions.draft === 'boolean'
          ? openPrOptions.draft
          : false,
    validationRequired:
      raw.validationRequired === true ||
      (merge && merge.validationRequired === true),
    postMergeCleanup: raw.postMergeCleanup !== false,
  };
}

async function runTask(client: any, options: any) {
  const {
    agent,
    streamId: streamIdArg,
    taskId,
    workspaceId,
    newTask = false,
    kind,
    label,
    spec: rawSpec,
    waitTimeoutMs,
    maxRounds,
    maxVerifyRounds,
    goalMode,
    requireChanges,
    fireAndForget = false,
    mode = DEFAULT_MODE,
    refreshBase = 'false',
    childRegistry: childRegistryOpt,
    caller,
    waveId,
    laneId,
    isRootGoalAgent,
    parallelTeams,
    onStreamCreated,
  } = options || {};

  let spec;
  try {
    spec = parseSpec(rawSpec);
  } catch (err) {
    throw new Error(`runTask: invalid TaskSpec (${err?.message || err})`);
  }
  const route = routeForSpec(spec);
  const routeInferredTaskClass = !spec.taskClass && route.taskClass;
  if (routeInferredTaskClass) spec.taskClass = route.taskClass;
  const driverAgent = String(agent || '').trim() || route.agent;
  const roundWaitTimeoutMs = waitTimeoutMs == null ? DEFAULT_WAIT_TIMEOUT : waitTimeoutMs;
  const requestedBaseRefreshMode = normalizeRefreshBaseMode(refreshBase);
  const telemetryContext = {
    provider: driverAgent || 'claude',
    streamId: null,
    taskId: null,
    mcpMode: mcpModeForProvider(driverAgent, spec),
    baseRefreshMode: requestedBaseRefreshMode,
  };

  // Build the framed prompt up-front so we can persist it to
  // tasks.initial_prompt at delegation time (read by TaskSpecPane). The
  // first-round delivery below regenerates the same text from currentSpec —
  // they match because currentSpec === {...spec} on round 0.
  const initialEnvelope = buildTaskPromptEnvelope(spec, { driver: driverAgent || 'claude' });
  const initialPrompt = initialEnvelope.text;
  const launchIntent = buildLaunchIntent(driverAgent, initialEnvelope.telemetry);
  assertLaunchIntentSupported(launchIntent);
  for (const warning of launchIntent?.warnings || []) {
    console.error(`[ace] WARN: ${warning}`);
  }
  let latestTelemetry = spawnTelemetry({ ...initialEnvelope.telemetry, launchIntent }, telemetryContext);
  logPromptTelemetry('prompt.rendered', latestTelemetry);

  const resolved = await ensureStream(client, {
    streamId: streamIdArg,
    agent: driverAgent,
    taskId,
    workspaceId,
    newTask,
    kind,
    label,
    goal: spec.goal,
    taskType: spec.taskType || null,
    prompt: initialPrompt,
    refreshBase: requestedBaseRefreshMode,
    waveId: waveId || null,
    laneId: laneId || null,
    launchIntent,
  });
  const streamId = resolved.streamId;
  const resolvedTaskId = resolved.taskId || taskId || null;
  telemetryContext.streamId = streamId;
  telemetryContext.taskId = resolvedTaskId;
  telemetryContext.baseRefreshMode = resolved.baseRefreshMode || requestedBaseRefreshMode;
  if (typeof onStreamCreated === 'function') {
    await onStreamCreated({
      streamId,
      conversationId: resolved.conversationId || null,
      taskId: resolvedTaskId,
      worktreeId: resolved.worktreeId || null,
      worktreePath: resolved.worktreePath || null,
      branch: resolved.branch || null,
      baseBranch: resolved.baseBranch || null,
      baseHygiene: resolved.baseHygiene || null,
      created: resolved.created,
      agent: driverAgent,
    });
  }

  // Register the wave/lane membership at dispatch time. fireAndForget
  // returns long before the post-DONE integrate block, so without an
  // early write the wave-join gate would never see this lane and could
  // green-light a validator against an empty registry.
  if ((waveId || laneId) && resolvedTaskId) {
    const earlyRegistry =
      childRegistryOpt ||
      createChildRegistry({ db: createFileDb(defaultStorePath()) });
    earlyRegistry.register({
      taskId: resolvedTaskId,
      workspaceId: workspaceId || null,
      branch: resolved.branch || null,
      baseBranch: resolved.baseBranch || process.env.ACE_BASE_BRANCH || null,
      remoteBaseRef: resolved.baseHygiene?.remoteBaseRef || null,
      baseSha: resolved.baseHygiene?.remoteBaseSha || null,
      baseHygiene: resolved.baseHygiene || null,
      worktreePath: resolved.worktreePath || null,
      waveId: waveId ?? null,
      laneId: laneId ?? null,
      // Group lanes: explicit ROOT lineage (the lineage filters must not
      // classify a wave member as an internal subagent) + the explicit
      // parallel-wave marker the shared wave validator keys on.
      ...(isRootGoalAgent === true ? { isRootGoalAgent: true } : {}),
      ...(parallelTeams === true ? { parallelTeams: true } : {}),
    });
  }
  const goalModeDecision = shouldQueueCodexGoal({ agent: driverAgent, spec, goalMode, fireAndForget, routeInferredTaskClass });
  const effectiveMaxRounds = normalizeBudgetCount(
    maxRounds ?? spec.maxRounds ?? spec.max_rounds,
    DEFAULT_MAX_ROUNDS
  );
  const effectiveMaxVerifyRounds = normalizeBudgetCount(
    maxVerifyRounds ?? spec.maxVerifyRounds ?? spec.max_verify_rounds,
    DEFAULT_MAX_VERIFY_ROUNDS
  );
  if (shouldQueueClaudeUltraCodePrelude({ agent: driverAgent, launchIntent })) {
    await sendClaudeSlashPrelude(client, {
      streamId,
      timeoutMs: waitTimeoutMs,
      text: launchIntent.effortCommand || '/effort ultracode',
    });
  }
  // Claude goal-mode (inline goals). Claude's `/goal` AUTO-STARTS the worker (it
  // is the work trigger, unlike Codex's setup-only /goal), so a separate framed
  // brief can never follow — the worker is already busy. Therefore for the
  // fire-and-forget path the /goal IS the delivery (folded into the dispatch
  // block below, as a rich objective). Only the rare interactive (non-FF) path
  // sends /goal as a standalone prelude.
  const claudeGoalQueue = shouldQueueClaudeGoal({ agent: driverAgent, spec, goalMode }).queue;
  const claudeGoalDelivery = fireAndForget && claudeGoalQueue;
  if (claudeGoalQueue && !fireAndForget) {
    await sendClaudeSlashPrelude(client, {
      streamId,
      timeoutMs: waitTimeoutMs,
      text: buildGoalCommand(spec, { maxRounds: effectiveMaxRounds, maxVerifyRounds: effectiveMaxVerifyRounds }),
    });
  }
  if (goalModeDecision.queue) {
    await queueGoalMode(client, {
      streamId,
      timeoutMs: waitTimeoutMs,
      mode,
      spec,
      maxRounds: effectiveMaxRounds,
      maxVerifyRounds: effectiveMaxVerifyRounds,
    });
  }

  const rounds = [];
  let currentSpec = { ...spec };
  let outcome = 'timeout';
  let detail = null;
  let lastAssistantText = '';

  const roundLimit = normalizeMaxRounds(effectiveMaxRounds, DEFAULT_MAX_ROUNDS);

  // Decide whether to verify the worktree before accepting DONE.
  // Precedence: read-only role mode > explicit flag > spec.requireChanges > newTask default > heuristic.
  // When `newTask` is set the caller is creating a fresh worktree explicitly
  // to hold real changes, so we default requireChanges=true — pure analysis
  // tasks should go through chat-only adhoc spawns instead or declare
  // roleMode=no-code/reviewer.
  // Verification only runs when we have a taskId pointing at a worktree.
  const hasWorktreeHint = !!(resolved.worktreePath || newTask);
  const readOnlyRoleMode = isReadOnlyRoleMode(spec);
  let shouldVerify;
  if (readOnlyRoleMode) shouldVerify = false;
  else if (typeof requireChanges === 'boolean') shouldVerify = requireChanges;
  else if (typeof spec.requireChanges === 'boolean') shouldVerify = spec.requireChanges;
  else if (newTask) shouldVerify = true;
  else shouldVerify = hasWorktreeHint && specImpliesCode(spec);
  shouldVerify = shouldVerify && !!resolvedTaskId;
  const verifyBudget = effectiveMaxVerifyRounds;

  let verifyResult = null;
  let verifyRoundsUsed = 0;

  // Outer loop: on DONE, optionally verify the worktree has real changes.
  // If not, feed the worker concrete verification feedback and loop.
  // We always run at least one outer iteration (the first ask).
  outer: for (let v = 0; v <= verifyBudget; v++) {
    // Reset per-verify-iteration inner state.
    let innerDone = false;
    for (let i = 0; i < roundLimit.limit; i++) {
      const promptEnvelope = buildTaskPromptEnvelope(currentSpec, { driver: driverAgent || 'claude' });
      const prompt = promptEnvelope.text;
      latestTelemetry = spawnTelemetry({ ...promptEnvelope.telemetry, launchIntent }, telemetryContext);

      if (fireAndForget) {
        // Deliver without waiting for a full turn, but still require the child
        // stream to become healthy/ready first. Otherwise a boot-time error can
        // leave an empty tab with no prompt ever delivered.
        // An explicit caller-provided timeout wins over the default boot cap so
        // `mission dispatch --timeout 60000` actually waits 60s, not 30s.
        const readyTimeoutMs = waitTimeoutMs > 0
          ? Math.max(5_000, waitTimeoutMs)
          : Math.min(DEFAULT_WAIT_TIMEOUT, 30_000);
        try {
          const readyStart = Date.now();
          const readyResult = await client.invoke('streamWaitFor', {
            streamId,
            predicate: { awaitingInput: true },
            timeoutMs: readyTimeoutMs,
          });
          const readyMs =
            readyResult && typeof readyResult.elapsedMs === 'number'
              ? readyResult.elapsedMs
              : Date.now() - readyStart;
          const promptStart = Date.now();
          // Claude goal-mode delivery: send the rich `/goal <objective>` (TYPED so
          // the slash parser fires) — it is the whole delivery and auto-starts the
          // worker, so we return immediately after (no blocking post-wait), which
          // lets the spine link the run and correlate the eventual completion.
          const deliverText = claudeGoalDelivery
            ? buildGoalCommand(spec, { maxRounds: effectiveMaxRounds, maxVerifyRounds: effectiveMaxVerifyRounds }, { rich: true })
            : prompt;
          const deliverMode = claudeGoalDelivery ? 'type' : mode;
          const sendResult = await client.invoke('streamSendSubmit', {
            streamId,
            text: deliverText,
            mode: deliverMode,
            caller: caller?.streamId ? { ...caller, command: caller.command || 'task run' } : undefined,
          });
          const promptMs =
            typeof sendResult?.telemetry?.promptMs === 'number'
              ? sendResult.telemetry.promptMs
              : Date.now() - promptStart;
          latestTelemetry = spawnTelemetry({ ...promptEnvelope.telemetry, launchIntent }, telemetryContext, {
            readyMs,
            promptMs,
            firstOutputMs: null,
          });
          logPromptTelemetry('prompt.dispatched', latestTelemetry);
          const result = {
            streamId,
            conversationId: resolved.conversationId || null,
            taskId: resolvedTaskId,
            worktreeId: resolved.worktreeId || null,
            worktreePath: resolved.worktreePath || null,
            branch: resolved.branch || null,
            baseBranch: resolved.baseBranch || null,
            baseHygiene: resolved.baseHygiene || null,
            fireAndForget: true,
            rounds: 0,
            verifyRounds: 0,
            outcome: 'dispatched',
            detail: null,
            deliveryStatus: 'prompt_delivered',
            streamCreated: true,
            promptDelivered: true,
            readyMs,
            promptMs,
            lastAssistantText: '',
            created: resolved.created,
            telemetry: latestTelemetry,
            warnings: launchIntent?.warnings || [],
            // Launch-mode proof for fire-and-forget dispatches: goal mode is
            // active either because the rich `/goal` WAS the delivery (Claude)
            // or because the `/goal` prelude was queued before this delivery
            // (Codex). Together with telemetry.launchIntent (reasoningEffort +
            // ultraCode + effortCommand) this makes one `run submit` provably
            // sufficient — no follow-up mode commands required.
            goalMode: {
              mode: claudeGoalDelivery ? 'on' : goalModeDecision.mode,
              injected: claudeGoalDelivery || goalModeDecision.queue,
              ...(claudeGoalDelivery ? { deliveredVia: 'goal-command' } : {}),
            },
          };
          result.nextStep = deriveNextStep(result);
          return taskRunResult(result);
        } catch (err) {
          let state = 'unknown';
          let screenText = '';
          try {
            const s = await client.invoke('streamGetState', { streamId });
            state = s?.state || state;
          } catch {}
          try {
            const scr = await client.invoke('streamReadScreen', { streamId, tail: 80 });
            screenText = scr?.text || '';
          } catch {}

          // Stale-booting fallback for Claude: streamWaitFor timed out but the
          // pane visibly shows the empty Claude prompt with no busy footer.
          // Deliver once instead of leaving an empty worker. Idempotent —
          // only runs in the timeout catch block, so the normal happy path
          // (which already returned above) cannot also send.
          if (
            isClaudeAgent(driverAgent) &&
            screenShowsStaleClaudePrompt({ state, screenText })
          ) {
            try {
              const promptStart = Date.now();
              const sendResult = await client.invoke('streamSendSubmit', {
                streamId,
                text: prompt,
                mode,
                caller: caller?.streamId
                  ? { ...caller, command: caller.command || 'task run' }
                  : undefined,
              });
              const promptMs =
                typeof sendResult?.telemetry?.promptMs === 'number'
                  ? sendResult.telemetry.promptMs
                  : Date.now() - promptStart;
              latestTelemetry = spawnTelemetry({ ...promptEnvelope.telemetry, launchIntent }, telemetryContext, {
                readyMs: null,
                promptMs,
                firstOutputMs: null,
              });
              logPromptTelemetry('prompt.dispatched', latestTelemetry);
              const fallbackResult = {
                streamId,
                conversationId: resolved.conversationId || null,
                taskId: resolvedTaskId,
                worktreeId: resolved.worktreeId || null,
                worktreePath: resolved.worktreePath || null,
                branch: resolved.branch || null,
                baseBranch: resolved.baseBranch || null,
                baseHygiene: resolved.baseHygiene || null,
                fireAndForget: true,
                rounds: 0,
                verifyRounds: 0,
                outcome: 'dispatched',
                detail: 'delivered via stale-booting visible-prompt fallback',
                deliveryStatus: 'prompt_delivered',
                streamCreated: true,
                promptDelivered: true,
                readyMs: null,
                promptMs,
                lastAssistantText: '',
                created: resolved.created,
                telemetry: latestTelemetry,
                warnings: launchIntent?.warnings || [],
                readyFallback: 'visible-prompt-stale-booting',
              };
              fallbackResult.nextStep = deriveNextStep(fallbackResult);
              return taskRunResult(fallbackResult);
            } catch (fallbackErr) {
              // fall through to existing error response, but enrich detail
              err = new Error(
                `${(err as any)?.message || err}; fallback send failed: ${
                  (fallbackErr as any)?.message || fallbackErr
                }`
              );
            }
          }

          const result = {
            streamId,
            conversationId: resolved.conversationId || null,
            taskId: resolvedTaskId,
            worktreeId: resolved.worktreeId || null,
            worktreePath: resolved.worktreePath || null,
            branch: resolved.branch || null,
            baseBranch: resolved.baseBranch || null,
            baseHygiene: resolved.baseHygiene || null,
            fireAndForget: true,
            rounds: 0,
            verifyRounds: 0,
            outcome: 'error',
            detail: `fire-and-forget delivery failed before ready (state=${state}): ${err?.message || err}`,
            deliveryStatus: 'stream_created_prompt_not_delivered',
            streamCreated: true,
            promptDelivered: false,
            state,
            retryAllowed: true,
            lastAssistantText: screenText,
            created: resolved.created,
            telemetry: latestTelemetry,
            warnings: launchIntent?.warnings || [],
          };
          result.nextStep = deriveNextStep(result);
          return taskRunResult(result);
        }
      }

      const askResult = await askOnce(client, {
        streamId,
        prompt,
        timeoutMs: roundWaitTimeoutMs,
        mode,
        caller,
        command: 'task run',
      });
      const askTiming = askResult?.telemetry || {};
      latestTelemetry = spawnTelemetry({ ...promptEnvelope.telemetry, launchIntent }, telemetryContext, {
        readyMs: askTiming.readyMs,
        promptMs: askTiming.promptMs,
        firstOutputMs:
          typeof askTiming.firstOutputMs === 'number'
            ? askTiming.firstOutputMs
            : askResult?.newOutput
              ? askResult?.elapsedMs
              : null,
      });
      logPromptTelemetry('prompt.completed', latestTelemetry);

      lastAssistantText = askResult?.newOutput || '';
      const trailer = parseTrailer(lastAssistantText);
      rounds.push({
        index: rounds.length,
        verifyIndex: v,
        renderedPromptChars: latestTelemetry.renderedPromptChars,
        skillCount: latestTelemetry.skillCount,
        taskType: latestTelemetry.taskType,
        driver: latestTelemetry.driver,
        roleMode: latestTelemetry.roleMode,
        readyMs: latestTelemetry.timings.readyMs,
        promptMs: latestTelemetry.timings.promptMs,
        firstOutputMs: latestTelemetry.timings.firstOutputMs,
        endState: askResult?.endState || null,
        elapsedMs: askResult?.elapsedMs || null,
        outcome: trailer.outcome,
        detail: trailer.detail,
        lastLine: lastLine(lastAssistantText),
      });

      if (!askResult || askResult.ok === false) {
        outcome = 'error';
        detail = askResult?.error || 'streamAsk failed';
        break outer;
      }

      if (askResult.endState === 'awaiting-approval') {
        outcome = 'awaiting-approval';
        detail = 'worker paused for an approval prompt';
        break outer;
      }

      if (trailer.outcome === 'done') {
        outcome = 'done';
        detail = trailer.detail;
        innerDone = true;
        break;
      }
      if (trailer.outcome === 'blocked') {
        // Respect BLOCKED — do not reverify a worker that said they're stuck.
        outcome = 'blocked';
        detail = trailer.detail;
        break outer;
      }

      // No trailer → the worker stopped mid-task. Loop with a compact prior
      // round summary so the next turn has context without re-sending the
      // whole spec verbatim.
      currentSpec = {
        ...currentSpec,
        priorRoundSummary: summarizeForNextRound(lastAssistantText),
      };
    }

    if (!innerDone) {
      // Inner loop exhausted without DONE — max-rounds. Don't burn verify
      // budget re-asking; the worker has already failed to trailer 3x.
      outcome = 'max-rounds';
      detail = `no DONE/BLOCKED trailer after ${roundLimit.limit} rounds`;
      break outer;
    }

    // DONE reached. If we're not verifying, accept it.
    if (!shouldVerify) break outer;

    // Verify the worktree has real changes.
    try {
      verifyResult = await client.invoke('streamVerifyTaskProgress', { taskId: resolvedTaskId });
    } catch (err) {
      // If verify itself fails (e.g. no worktree), trust DONE rather than
      // trap the user in an infinite loop. Surface the error in detail.
      detail = `${detail || ''}${detail ? ' ' : ''}(verify skipped: ${err?.message || err})`;
      break outer;
    }
    if (verifyResult && verifyResult.hasChanges) break outer;
    if (verifyResult && verifyResult.hasWorktree === false) {
      // No worktree to diff — nothing to verify against.
      break outer;
    }

    // No changes. If we're out of verify budget, mark done-unverified.
    verifyRoundsUsed = v + 1;
    if (verifyRoundsUsed > verifyBudget) {
      outcome = 'done-unverified';
      detail = `DONE emitted ${verifyRoundsUsed} times but no changes in the worktree (base ${verifyResult?.baseBranch || '<base>'})`;
      break outer;
    }

    // Feed the worker concrete verification feedback and loop.
    const fb = [
      `Your previous DONE was rejected: \`git diff ${verifyResult?.baseBranch || '<base>'}..HEAD\` and staged/unstaged diffs in the worktree are empty.`,
      'If the deliverables require code, edit/create files in the current directory (this is the task\'s dedicated worktree) and stage or commit them.',
      'When files are actually changed, emit `DONE: <summary>` again.',
      'If this task legitimately produces no code (pure research/planning), emit `DONE: no-code <reason>` — that token will be accepted.',
    ].join(' ');
    // Orchestrator-internal verify-feedback rounds carry the original spec
    // (constraints/deliverables/acceptance) plus the verification packet,
    // which routinely runs ~1.4k chars — past the lean 1200 fixback hard
    // cap. Stamp a system override reason so the role-aware budget still
    // refuses oversized hand-crafted fixback specs from external callers.
    currentSpec = {
      ...currentSpec,
      verifyFeedback: fb,
      priorRoundSummary: undefined,
      promptBudgetOverrideReason:
        currentSpec.promptBudgetOverrideReason ||
        'orchestrator-internal verify feedback round',
    };

    // Allow a "no-code" escape even though we're looping.
    if (/\bDONE\s*:\s*no-code\b/i.test(lastAssistantText)) {
      outcome = 'done';
      detail = (detail || '').replace(/^done$/i, 'done (no-code acknowledged)');
      break outer;
    }
  }

  if (outcome === 'timeout') {
    outcome = 'max-rounds';
    detail = detail || `no DONE/BLOCKED trailer after ${roundLimit.limit} rounds`;
  }

  // §8 post-DONE integration — when spec.integrate is set and the worker
  // produced real changes (outcome='done'), drive the push + openPR flow
  // through the integration gateway. The child (editor role) was responsible
  // for committing; the orchestrator drives shared-state mutation from here
  // so the PR trail is consistent even when the child skips the ace-github-flow
  // skill. Updates child-registry with the resulting PR URL/number so
  // `ace supervise` can surface it.
  let prNumber = null;
  let prUrl = null;
  let integrateDetail = null;
  const integrateSpec = readOnlyRoleMode ? null : normalizeIntegrateSpec(spec);
  if (integrateSpec && outcome === 'done' && resolvedTaskId) {
    const registry =
      childRegistryOpt ||
      createChildRegistry({ db: createFileDb(defaultStorePath()) });
    try {
      registry.register({
        taskId: resolvedTaskId,
        workspaceId: workspaceId || null,
        branch: resolved.branch || null,
        baseBranch: resolved.baseBranch || process.env.ACE_BASE_BRANCH || null,
        remoteBaseRef: resolved.baseHygiene?.remoteBaseRef || null,
        baseSha: resolved.baseHygiene?.remoteBaseSha || null,
        baseHygiene: resolved.baseHygiene || null,
        worktreePath: resolved.worktreePath || null,
        waveId: waveId ?? null,
        laneId: laneId ?? null,
      });
      registry.updatePrState(resolvedTaskId, {
        lastTrailer: detail || null,
        laneStatus: outcome,
      });

      if (integrateSpec.push) {
        const pushEnv = await client.invoke('integrationPush', {
          taskId: resolvedTaskId,
          branch: resolved.branch || undefined,
        });
        if (!pushEnv || pushEnv.ok !== true) {
          integrateDetail = `integration push failed: ${pushEnv?.result?.stderr || pushEnv?.result?.error || 'unknown'}`;
          registry.updatePrState(resolvedTaskId, { prState: 'push-failed' });
        }
      }

      if (!integrateDetail && integrateSpec.openPr) {
        const title =
          integrateSpec.title ||
          (spec.goal || '').slice(0, 70) ||
          'ace delegated task';
        const body =
          integrateSpec.body ||
          [
            '## Summary',
            spec.goal || '',
            '',
            '🤖 Opened by Ace orchestrator (post-DONE integrate)',
          ].join('\n');
        const prEnv = await client.invoke('integrationOpenPr', {
          taskId: resolvedTaskId,
          title,
          body,
          draft: integrateSpec.draft,
        });
        if (!prEnv || prEnv.ok !== true) {
          integrateDetail = `integration openPr failed: ${prEnv?.result?.stderr || prEnv?.result?.error || 'unknown'}`;
          registry.updatePrState(resolvedTaskId, { prState: 'pr-open-failed' });
        } else {
          const parsed = parsePrFromStdout(prEnv?.result?.stdout || '');
          prNumber = parsed.prNumber;
          prUrl = parsed.prUrl;
          registry.updatePrState(resolvedTaskId, {
            prNumber,
            prUrl,
            prState: 'open',
            baseBranch: resolved.baseBranch || process.env.ACE_BASE_BRANCH || null,
          });
        }
      }

      // Explicit gated merge ONLY (integrate.merge set by the caller). The
      // autonomous merge path lives in the mission-card bus loop (auto-rally →
      // release-goal worker → integration gateway), not here.
      const mergeCfg = integrateSpec.merge || null;
      if (!integrateDetail && mergeCfg) {
        const mergePrNumber = mergeCfg.prNumber ?? prNumber;
        if (mergePrNumber == null) {
          integrateDetail = appendDetail(
            integrateDetail,
            'integration mergePr skipped: no prNumber available'
          );
        } else {
          const row = registry.get(resolvedTaskId) || {};
          const expectedBaseBranch = process.env.ACE_BASE_BRANCH || row.baseBranch || resolved.baseBranch || null;
          const gateRow = row;
          // Allowed paths for the PR scope check. The validator spec already
          // carries the worker's scope; the gate needs it too, or evaluatePrScope
          // returns scope_missing for every non-empty changed-file list. Source
          // from the row/spec scope; null only when genuinely unscoped.
          const mergeAllowedPaths =
            (Array.isArray(row.allowPaths) && row.allowPaths.length ? row.allowPaths : null) ||
            (Array.isArray(spec?.scope?.paths) && spec.scope.paths.length ? spec.scope.paths : null) ||
            (Array.isArray(spec?.scope?.allow) && spec.scope.allow.length ? spec.scope.allow : null) ||
            (Array.isArray(spec?.allowPaths) && spec.allowPaths.length ? spec.allowPaths : null) ||
            null;
          const mergeGate = evaluateMergeGate({
            prNumber: mergePrNumber,
            tracked: gateRow.prNumber != null && Number(gateRow.prNumber) === Number(mergePrNumber),
            baseBranch: gateRow.baseBranch || resolved.baseBranch || null,
            prState: gateRow.prState || null,
            checkState: gateRow.checkState || gateRow.prChecks || null,
            mergeable: gateRow.mergeable || null,
            validation: gateRow.validation || null,
            validationRequired: integrateSpec.validationRequired === true,
            branch: gateRow.branch || resolved.branch || null,
            worktreePath: gateRow.worktreePath || resolved.worktreePath || null,
            branchExistsRemote: gateRow.branchExistsRemote,
            expectedBaseBranch,
            // Scope: feed the worker's allowed paths so evaluatePrScope can
            // validate the changed files instead of returning scope_missing.
            ...(mergeAllowedPaths ? { allowedPaths: mergeAllowedPaths } : {}),
          });
          if (!mergeGate.ok) {
            registry.updatePrState(resolvedTaskId, {
              prState: 'merge-blocked',
              mergeGate,
            });
            integrateDetail = appendDetail(
              integrateDetail,
              `integration mergePr blocked by gate: ${mergeGate.failures.map((failure: any) => failure.code).join(', ')}`
            );
          } else {
            const mergeEnv = await client.invoke('integrationMergePr', {
              taskId: resolvedTaskId,
              prNumber: mergePrNumber,
              method: mergeCfg.method,
              deleteBranch: mergeCfg.deleteBranch,
              gate: mergeGate,
              // Pass the worker's scope so the gateway's AUTHORITATIVE gate
              // re-evaluation (fresh intel) also has allowedPaths and does not
              // re-derive scope_missing.
              ...(mergeAllowedPaths ? { allowedPaths: mergeAllowedPaths } : {}),
            });
            if (!mergeEnv || mergeEnv.ok !== true) {
              integrateDetail = appendDetail(
                integrateDetail,
                `integration mergePr failed: ${mergeEnv?.result?.stderr || mergeEnv?.result?.error || 'unknown'}`
              );
              registry.updatePrState(resolvedTaskId, { prState: 'merge-failed' });
            } else {
              registry.updatePrState(resolvedTaskId, { prState: 'merged' });
              const cleanupSummary =
                mergeEnv?.result?.postMergeCleanup ||
                (integrateSpec.postMergeCleanup
                  ? await client.invoke('integrationPostMergeCleanup', {
                      taskId: resolvedTaskId,
                      branch: resolved.branch || undefined,
                      worktreePath: resolved.worktreePath || undefined,
                      prUrl: prUrl || undefined,
                    })
                  : null);
              if (cleanupSummary && cleanupSummary.ok === false) {
                integrateDetail = appendDetail(
                  integrateDetail,
                  'post-merge cleanup reported one or more failed steps'
                );
              }
            }
          }
        }
      }
    } catch (err) {
      integrateDetail = `integrate flow error: ${err?.message || err}`;
    }
  }

  const result = {
    streamId,
    conversationId: resolved.conversationId || null,
    taskId: resolvedTaskId,
    worktreeId: resolved.worktreeId || null,
    worktreePath: resolved.worktreePath || null,
    branch: resolved.branch || null,
    baseBranch: resolved.baseBranch || null,
    baseHygiene: resolved.baseHygiene || null,
    fireAndForget: false,
    rounds: rounds.length,
    verifyRounds: verifyRoundsUsed,
    verify: verifyResult
      ? {
          hasChanges: !!verifyResult.hasChanges,
          filesChanged: verifyResult.filesChanged || 0,
          linesAdded: verifyResult.linesAdded || 0,
          linesDeleted: verifyResult.linesDeleted || 0,
          changedPaths: verifyResult.changedPaths || [],
        }
      : null,
    roundDetails: rounds,
    outcome,
    detail: integrateDetail ? `${detail || ''}${detail ? '; ' : ''}${integrateDetail}` : detail,
    lastAssistantText,
    created: resolved.created,
    telemetry: latestTelemetry,
    warnings: launchIntent?.warnings || [],
    goalMode: {
      mode: goalModeDecision.mode,
      injected: goalModeDecision.queue,
    },
    ...(prNumber != null ? { prNumber } : {}),
    ...(prUrl != null ? { prUrl } : {}),
  };
  result.nextStep = deriveNextStep(result);
  return taskRunResult(result);
}

function fixbackContext(packet: any, row: any = {}) {
  const findings = Array.isArray(packet?.findings) ? packet.findings : [];
  const findingLines = findings.map((finding: any, index: number) => {
    return [
      `${index + 1}. ${finding.criterion}`,
      `status=${finding.status}`,
      `evidence=${finding.evidence}`,
      `fix=${finding.fix}`,
    ].join(' | ');
  });
  return [
    'Validator requested same-worker fixback on the existing branch/PR.',
    packet?.prUrl ? `PR: ${packet.prUrl}` : row.prUrl ? `PR: ${row.prUrl}` : '',
    packet?.branch ? `Branch: ${packet.branch}` : row.branch ? `Branch: ${row.branch}` : '',
    packet?.actual ? `Actual: ${packet.actual}` : '',
    packet?.expected ? `Expected: ${packet.expected}` : '',
    packet?.rootCause ? `Root cause: ${packet.rootCause}` : '',
    packet?.failingChecks?.length ? `Failing checks: ${packet.failingChecks.join('; ')}` : '',
    packet?.failingFiles?.length ? `Failing files: ${packet.failingFiles.join('; ')}` : '',
    findingLines.length ? `Findings:\n${findingLines.join('\n')}` : '',
  ].filter(Boolean).join('\n');
}

async function runFixback(client: any, { row, packet, attempts, remaining, wait }: any = {}) {
  // Prefer the original stream (same-worker fixback). When that tab is gone,
  // a taskId + agent is enough: ensureStream respawns onto the SAME task and
  // worktree, so the fixback still lands on the original branch/PR.
  const fixbackAgent = row?.workerAgent || packet?.implementerFamily || row?.agent || null;
  if (!row?.streamId && !fixbackAgent) {
    throw new Error('runFixback: original streamId (or an agent to respawn onto the task) required');
  }
  if (!row?.taskId && !packet?.taskId) throw new Error('runFixback: original taskId required');
  // parseSpec requires a non-empty scope object. The fixback runs in the SAME
  // worktree/branch as the original worker, so reuse that worker's scope
  // (workspace + allowed paths) from the row/packet. Without this, every fixback
  // dispatch threw `parseSpec: scope required (object)` and the loop bailed.
  const fixbackScope: any = {};
  const fixbackWorkspaceId = row.workspaceId || packet?.workspaceId || null;
  if (fixbackWorkspaceId) fixbackScope.workspaceId = fixbackWorkspaceId;
  if (row.repo || packet?.repo) fixbackScope.repo = row.repo || packet?.repo;
  // `paths` is always set (possibly []), so scope is never empty — satisfies
  // parseSpec even when neither workspace nor repo is known.
  fixbackScope.paths = Array.isArray(row.allowPaths)
    ? row.allowPaths
    : Array.isArray(packet?.allowedPaths)
      ? packet.allowedPaths
      : [];
  const spec = {
    goal: `Fix validator findings for ${packet?.prUrl || row.prUrl || row.branch || row.taskId}`,
    baseBranch: packet?.baseBranch || row.baseBranch || process.env.ACE_BASE_BRANCH || 'main',
    role: 'editor',
    taskType: 'fixback',
    roleMode: 'fixback',
    skillPack: 'generic',
    scope: fixbackScope,
    context: fixbackContext(packet, row),
    constraints: [
      'Patch only the reported validation failure.',
      'Use the existing task worktree, branch, and PR.',
      'Do not create a replacement worker, branch, or PR.',
    ],
    deliverables: [
      'Commit a targeted fix to the existing branch.',
      'Push/update the existing PR if remote credentials are available.',
    ],
    acceptance: [
      'Validator findings are addressed.',
      'Relevant targeted checks pass or any remaining blocker is reported with BLOCKED.',
    ],
    requireChanges: true,
    promptBudgetOverrideReason: 'auto-rally structured fixback packet',
    fixback: {
      attempts,
      remaining,
      validationFailurePacket: packet || null,
    },
  };
  return runTask(client, {
    agent: fixbackAgent,
    streamId: row.streamId,
    taskId: row.taskId || packet?.taskId,
    workspaceId: row.workspaceId || packet?.workspaceId || null,
    newTask: false,
    kind: 'mission-fixback',
    label: `Fixback ${row.taskId || packet?.taskId}`,
    spec,
    // Auto-chain fixback (wait:true) MUST await the worker's DONE so the
    // subsequent re-validation runs against the actually-fixed, pushed head —
    // fire-and-forget here would race a worker that has not yet fixed anything.
    // The legacy `mission fixback` path (wait unset) keeps fire-and-forget.
    maxRounds: wait ? 6 : 1,
    maxVerifyRounds: 0,
    waitTimeoutMs: wait ? 900_000 : 30_000,
    fireAndForget: wait ? false : true,
    mode: 'paste',
  });
}

// Scripted chat: each step is {text, waitFor?, timeoutMs?, mode?}.
// `waitFor` defaults to {turnComplete: true}. Useful for smoke tests and
// workflows where DONE/BLOCKED doesn't apply.
async function runChat(client: any, options: any) {
  const {
    agent,
    streamId: streamIdArg,
    taskId,
    workspaceId,
    kind,
    label,
    script,
    mode = DEFAULT_MODE,
  } = options || {};

  if (!Array.isArray(script) || script.length === 0) {
    throw new Error('runChat: script (non-empty array) required');
  }

  const resolved = await ensureStream(client, {
    streamId: streamIdArg,
    agent,
    taskId,
    workspaceId,
    kind,
    label,
  });
  const streamId = resolved.streamId;

  const turns = [];
  for (const step of script) {
    if (!step || typeof step.text !== 'string' || !step.text) {
      throw new Error('runChat: each script step needs non-empty text');
    }
    const stepMode = step.mode || mode;
    const timeoutMs = step.timeoutMs || DEFAULT_WAIT_TIMEOUT;
    const r = await askOnce(client, { streamId, prompt: step.text, timeoutMs, mode: stepMode });
    turns.push({
      input: step.text,
      endState: r?.endState || null,
      elapsedMs: r?.elapsedMs || null,
      newOutput: r?.newOutput || '',
      ok: r?.ok !== false,
      error: r?.error || null,
    });
    if (r?.ok === false) break;
    if (step.stopOn === 'done' && parseTrailer(r?.newOutput).outcome === 'done') break;
    if (step.stopOn === 'blocked' && parseTrailer(r?.newOutput).outcome === 'blocked') break;
  }

  return {
    streamId,
    conversationId: resolved.conversationId || null,
    taskId: resolved.taskId || taskId || null,
    turns,
    created: resolved.created,
  };
}

module.exports = {
  runTask,
  runFixback,
  runChat,
  ensureStream,
  effectiveStreamKindForTask,
  requiresWorktreeBackedStream,
  askOnce,
  parsePrFromStdout,
  buildLaunchIntent,
  assertLaunchIntentSupported,
  codexAppParityRequested,
  CODEX_APP_PARITY_PROFILE,
  CODEX_APP_PARITY_FEATURE_OVERRIDES,
  mcpModeForProvider,
  normalizeRefreshBaseMode,
  taskRunResult,
  telemetryWithTimings,
  TASK_RUN_RESULT_SCHEMA,
  TASK_RUN_RESULT_VERSION,
  TASK_RUN_TELEMETRY_SCHEMA,
};
