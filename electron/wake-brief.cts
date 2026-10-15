// Hermes wake-up brief builder.
//
// The wake brief is deprecated as a rehydration source. The clean wiki and
// the Mission Board are now the rehydration spine; the wake prompt's job is
// to point the operator lanes at those, not to paste a giant dump that
// re-pollutes the personal lanes with raw dormant stream inventory.
//
// Surface:
//   buildWakeBriefPayload(input)      — pure; structured payload enriched
//                                        with derived actionability.
//   formatWakeBrief(payload)          — operator-safe rendering. Never
//                                        includes raw dormant stream
//                                        inventory. Used for actionable-
//                                        deltas mode and as the "see also"
//                                        block inside diagnostic mode.
//   formatDiagnosticWakeBrief(payload)— full inventory, including dormant.
//                                        Diagnostic only — never sent to
//                                        operator-facing wake text.
//   buildPointerWakeBrief(opts)       — the new pointer-only default. Just
//                                        the spec's exact pointer sentence
//                                        plus optional structured fields.
//   buildHermesWakePrompt(opts)       — wraps brief text in an identity-
//                                        specific operator framing. The
//                                        default mode is 'pointer'.
//   classifyStreamActionability(...)  — re-exported from derived-actionability.

const crypto = require('crypto');
// Prefer the compiled .cjs (runtime path after `npm run build:electron-main`);
// fall back to the .cts source so vitest can load wake-brief.cts without a
// prior compile step. Matches the pattern in electron/missions.cts.
let derivedActionability: any;
try {
  derivedActionability = require('./ace-control/derived-actionability.cjs');
} catch {
  derivedActionability = require('./ace-control/derived-actionability.cts');
}
const {
  ACTIONABILITY,
  classifyStreamActionability,
  classifyOrchestratorPresence,
  isBlockingLabel,
  isDiagnosticLabel,
} = derivedActionability;

// Operator-profile templating (cross-unit contract with electron/operators.cts).
// All operator/owner copy is templated over
// { operatorLabel, controlPlaneLabels, ownerTitle }. Defaults mirror the
// neutral shipped operator profile; callers pass the loaded operators config
// (an owner-shaped config renders byte-identical legacy output — see
// electron/__tests__/wake-brief.test.cts).
const DEFAULT_CONTROL_PLANE_LABELS = ['Hermes'];
const DEFAULT_OWNER_TITLE = 'the owner';
const DEFAULT_OPERATOR_IDENTITY = 'hermes';

function normalizeControlPlaneLabels(labels: any) {
  const list = Array.isArray(labels)
    ? labels.map((label) => String(label || '').trim()).filter(Boolean)
    : [];
  return list.length > 0 ? list : DEFAULT_CONTROL_PLANE_LABELS;
}

function joinWithAnd(list: any) {
  if (list.length === 1) return list[0];
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

function wakeOwnerTitle(opts: any = {}) {
  const title = typeof opts.ownerTitle === 'string' ? opts.ownerTitle.trim() : '';
  return title || DEFAULT_OWNER_TITLE;
}

function buildWakeFirstLine(controlPlaneLabels?: any) {
  const labels = normalizeControlPlaneLabels(controlPlaneLabels);
  const lanePhrase =
    labels.length === 1
      ? `${labels[0]} is the standing operator lane`
      : `${joinWithAnd(labels)} are the standing operator lanes`;
  return `Morning. Ace Agents are up — ${lanePhrase}; repo workspace orchestrators are opt-in.`;
}

const FIRST_LINE = buildWakeFirstLine();
const HERMES_AUTO_WAKE_PROMPT_DEBOUNCE_MS = 30 * 60_000;

// The exact pointer sentence the spec requires. Do not edit without updating
// docs/ops/ace-wake-and-wiki-truth.md and AGENT_2_SPEC.md.
const WAKE_POINTER_SENTENCE =
  'Read the clean wiki current-state and Mission Board. Do not infer state from raw dormant streams.';

const VALID_WAKE_MODES = new Set(['pointer', 'actionable-deltas', 'diagnostic']);

function wakeIdentityLabel(identity) {
  const key = String(identity || DEFAULT_OPERATOR_IDENTITY).trim().toLowerCase()
    || DEFAULT_OPERATOR_IDENTITY;
  return key.charAt(0).toUpperCase() + key.slice(1);
}

function wakeOperatorLabel(identity: any, opts: any = {}) {
  const label = typeof opts.operatorLabel === 'string' ? opts.operatorLabel.trim() : '';
  return label || wakeIdentityLabel(identity);
}

function buildOperatorWakeParagraph(identity, opts: any = {}) {
  const label = wakeOperatorLabel(identity, opts);
  const owner = wakeOwnerTitle(opts);
  return `Role: ${label} Ace operator. Treat the wake brief as rehydration context, then answer or act on ${owner}'s latest visible request. You may inspect state, plan, create tickets, and create/delegate Ace tasks through the app's normal task flow when a handoff requires it. Keep shared repos safe: do not directly push, merge, fork, or edit repo files from this personal lane; implementation belongs in specialist task worktrees or explicit user-approved flows.`;
}

function buildOperatorRehydrationContract(identity, opts: any = {}) {
  const label = wakeOperatorLabel(identity, opts);
  const owner = wakeOwnerTitle(opts);
  const lanes = normalizeControlPlaneLabels(opts.controlPlaneLabels);
  const lanesAnd = joinWithAnd(lanes);
  const lanesSlash = lanes.join('/');
  const lanesLine =
    lanes.length === 1
      ? `- Treat ${lanesAnd} as a persistent Hermes operator lane, not a disposable test chat.`
      : `- Treat ${lanesAnd} as persistent Hermes operator lanes, not disposable test chats.`;
  return [
    `Operator rehydration contract for ${label}:`,
    lanesLine,
    `- Preserve each lane home, state.db, memories, and sessions. Do not reset, hard-clear, or delete ${lanesSlash} history unless ${owner} explicitly asks.`,
    '- Start project-management context from ~/wiki/ace-ops: SCHEMA.md, index.md, dashboards/current-state.md, then the relevant entity/playbook page. Live Ace, git, GitHub, and transcript checks are deltas after that.',
    '- Load ace-github-flow when managing projects or explaining portfolio state; for wiki/project-management actions use the `ace wiki ...` commands. If a skill name is ambiguous, load the exact local skill path instead of guessing.',
    `- Speak back in short ${owner}-visible thought checkpoints when your plan, uncertainty, blocker, delegation, validation, or next move changes. Do not bury these as reasoning only; make them normal assistant messages ${owner} can see and steer.`,
    `- If ${owner} asks a question, answer the question first from live evidence; do not dump the wake brief back at him unless he explicitly asks for the raw brief.`,
    `- Convert actionable ${owner} requests into Mission Board tickets or Kanban rows when useful, then move the work by delegating visible worker tasks or reporting the exact blocker.`,
    '- Use the new Ace tool contract and harness: `ace tool manifest`, `tool heartbeat`, `tool batch`, `tool audit`; `ace mission create/ready/dispatch/sync/validate/gate/fixback/release-gate`; `ace task result/validate`; `ace feature list/mark`; `ace wave list`; `ace run list`; `ace memory candidates`; `ace wiki update`; `ace event emit`; `ace supervise`; and `ace validation clawpatch` where risk requires it.',
    '- Before major direction changes, check whether we are solving the right problem. Push back on weak strategy, missing evidence, fake urgency, scope creep, or work that does not advance the company portfolio.',
    '- Use persistent memory only for compact stable facts. Use session_search for prior chat/tool-call recall and mission/task/PR rows for current execution state.',
    '- Current healthy Hermes baseline is openai-codex / GPT-5.5 with dark gold truecolor Ace and a state.db-backed chat overlay that surfaces messages, tool calls, skills, and subagent send/receive traffic. If the overlay looks stale or black-and-white, diagnose runtime/env/transcript tailing before blaming memory.',
  ].join('\n');
}

const ORCHESTRATOR_TASK_NAME_PREFIXES = [
  'Hermes Orchestrator',
  'Claude Orchestrator',
  'Codex Orchestrator',
];

function isOrchestratorTaskName(name) {
  if (!name) return false;
  for (const prefix of ORCHESTRATOR_TASK_NAME_PREFIXES) {
    if (name === prefix) return true;
    if (name.startsWith(`${prefix} — `)) return true;
  }
  return false;
}

function streamInfo(stream) {
  return {
    streamId: stream.streamId,
    agent: stream.agent || null,
    state: stream.state || 'unknown',
    label: stream.label || null,
    taskId: stream.taskId || null,
    live: !!stream.live,
    lastChangeAt: stream.lastChangeAt || null,
    composerText: stream.composerText || null,
    rawTail: stream.rawTail || null,
    hasCurrentMissionCard: !!stream.hasCurrentMissionCard,
    hasCleanEnvelope: stream.hasCleanEnvelope !== false,
    validationStatus: stream.validationStatus || null,
    doneTrailerSeen: !!stream.doneTrailerSeen,
  };
}

function bucketForState(stream) {
  if (!stream.live || stream.state === 'dormant') return 'dormant';
  const state = stream.state;
  if (state === 'busy' || state === 'booting') return 'active';
  if (state === 'awaiting-input' || state === 'turn-complete') return 'awaiting';
  if (state === 'awaiting-approval') return 'awaiting';
  if (state === 'error') return 'blocked';
  return 'active';
}

function taskUpdatedAt(task) {
  return task?.updated_at || task?.updatedAt || null;
}

function formatRelativeTime(isoString) {
  const timestamp = Date.parse(isoString || '');
  if (!Number.isFinite(timestamp)) return null;
  const deltaMs = Math.max(0, Date.now() - timestamp);
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(deltaMs / 3_600_000);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(deltaMs / 86_400_000);
  return `${days}d ago`;
}

function taskName(task) {
  return task?.name || task?.id || '(unnamed task)';
}

function buildLastChange(tasks) {
  let latestTask = null;
  let latestAt = -1;
  for (const task of tasks || []) {
    const updatedAt = taskUpdatedAt(task);
    const parsed = Date.parse(updatedAt || '');
    if (!Number.isFinite(parsed)) continue;
    if (parsed > latestAt) {
      latestAt = parsed;
      latestTask = task;
    }
  }
  if (!latestTask) return null;
  const status = latestTask.status || 'unknown';
  return {
    at: taskUpdatedAt(latestTask),
    summary: `${taskName(latestTask)} (${status})`,
  };
}

function firstBlockedTask(tasks) {
  for (const task of tasks || []) {
    if (task?.status === 'blocked') return task;
  }
  return null;
}

function isPersonalWorkspace(workspace) {
  return !!(workspace?.isPersonal || workspace?.is_personal);
}

function expectsLiveWorkspaceOrchestrator(workspace) {
  if (!workspace) return false;
  // Personal operator lanes are themselves the operator lanes. They are
  // auto-started by Ace, so a boot-order race should not tell one
  // operator lane to "start orchestrator" for another during wake-up.
  if (isPersonalWorkspace(workspace)) return false;
  if (String(workspace.alwaysOnAgent || 'hermes').toLowerCase() === 'claude') return false;
  if (!workspace.alwaysOnOrchestrator) return false;
  return true;
}

// Derive a per-workspace handoff. The next-action is gated by derived
// actionability so dormant rows, stale awaiting-input, and interrupted
// streams cannot manufacture fake urgency.
function buildWorkspaceHandoff(entry, workspace) {
  const tasks = workspace?.tasks || [];
  const lastChange = buildLastChange(tasks);
  const blockedTask = firstBlockedTask(tasks);
  const blockingStreams = (entry.streams || []).filter((s) => s.actionability && isBlockingLabel(s.actionability.label));
  const orchestratorPresence = entry.orchestratorActionability || null;
  const orchestratorBlocking = orchestratorPresence && isBlockingLabel(orchestratorPresence.label);

  let nextAction: any = null;
  let blocker: any = null;

  if (orchestratorBlocking) {
    blocker = 'required orchestrator missing';
    nextAction = 'start orchestrator';
  } else if (blockingStreams.length > 0) {
    const s = blockingStreams[0];
    blocker = `${s.streamId} ${s.actionability.label}`;
    nextAction = `unblock ${s.streamId} (${s.actionability.label})`;
  } else if (blockedTask) {
    blocker = `task ${taskName(blockedTask)} blocked`;
    nextAction = `unblock ${blocker}`;
  } else {
    const awaitingChief = (entry.streams || []).find(
      (s) => s.actionability && s.actionability.label === ACTIONABILITY.AWAITING_CHIEF
    );
    if (awaitingChief) {
      nextAction = `review ${awaitingChief.streamId} (agent=${awaitingChief.agent || '?'})`;
    }
  }

  return {
    lastChange,
    blocker,
    nextAction,
    needsAction:
      !!nextAction &&
      (nextAction.startsWith('unblock ') ||
        nextAction.startsWith('review ') ||
        nextAction === 'start orchestrator'),
    orchestratorActionability: orchestratorPresence,
  };
}

function buildWakeBriefPayload({ streams = [], workspaces = [], nowMs = Date.now() } = {} as any) {
  const workspaceById = new Map();
  for (const ws of workspaces) {
    workspaceById.set(ws.id, ws);
  }

  const orchestratorTaskIds = new Map(); // taskId → { workspaceId, agent, name }
  for (const ws of workspaces) {
    for (const task of ws.tasks || []) {
      if (isOrchestratorTaskName(task.name)) {
        orchestratorTaskIds.set(task.id, {
          workspaceId: ws.id,
          agent: task.agent || null,
          name: task.name,
        });
      }
    }
  }

  const perWorkspace = new Map();
  function ensureWs(wsId, wsName, workspace = null) {
    if (!perWorkspace.has(wsId)) {
      perWorkspace.set(wsId, {
        workspaceId: wsId,
        workspaceName: wsName,
        isPersonalWorkspace: isPersonalWorkspace(workspace),
        liveOrchestrator: null,
        activeWorkers: [],
        dormantWorkers: [],
        awaitingInput: [],
        blocked: [],
        streams: [],
        noOrchestratorGap: false,
      });
    } else if (workspace && isPersonalWorkspace(workspace)) {
      perWorkspace.get(wsId).isPersonalWorkspace = true;
    }
    return perWorkspace.get(wsId);
  }

  for (const ws of workspaces) {
    ensureWs(ws.id, ws.name || ws.id, ws);
  }

  const orphans: any[] = [];
  for (const s of streams) {
    const wsId = s.workspaceId || null;
    if (!wsId) {
      const info = streamInfo(s);
      (info as any).actionability = classifyStreamActionability(info, null, { nowMs });
      orphans.push(info);
      continue;
    }
    const wsMeta = workspaceById.get(wsId);
    const entry = ensureWs(wsId, wsMeta?.name || wsId, wsMeta);
    const info = streamInfo(s);
    (info as any).actionability = classifyStreamActionability(info, wsMeta, { nowMs });
    entry.streams.push(info);
    const isPersonalHermesLane = isPersonalWorkspace(wsMeta) && String(s.agent || '').toLowerCase() === 'hermes';
    const isOrch = isPersonalHermesLane || (s.taskId && orchestratorTaskIds.has(s.taskId));

    if (isOrch) {
      if (s.live && !entry.liveOrchestrator) {
        entry.liveOrchestrator = info;
      }
      continue;
    }

    switch (bucketForState(s)) {
      case 'active':
        entry.activeWorkers.push(info);
        break;
      case 'awaiting':
        if (s.state === 'awaiting-approval') {
          entry.blocked.push(info);
        } else {
          entry.awaitingInput.push(info);
        }
        break;
      case 'blocked':
        entry.blocked.push(info);
        break;
      case 'dormant':
        entry.dormantWorkers.push(info);
        break;
    }
  }

  for (const entry of perWorkspace.values()) {
    const workspace = workspaceById.get(entry.workspaceId);
    entry.orchestratorActionability = classifyOrchestratorPresence(workspace || null, !!entry.liveOrchestrator);
    if (!entry.liveOrchestrator && expectsLiveWorkspaceOrchestrator(workspace)) {
      entry.noOrchestratorGap = true;
    }
    entry.handoff = buildWorkspaceHandoff(entry, workspace);
  }

  return {
    workspaces: Array.from(perWorkspace.values()),
    orphanStreams: orphans,
  };
}

function fmtActionability(info) {
  const a = info.actionability;
  if (!a) return `state=${info.state}`;
  return `actionability=${a.label}`;
}

// Operator-safe rendering. Never lists raw dormant streams. Falls back to a
// derived-actionability summary per workspace.
function formatWakeBrief(payload, opts: any = {}) {
  const owner = wakeOwnerTitle(opts);
  const lines: string[] = [];
  lines.push(buildWakeFirstLine(opts.controlPlaneLabels));
  lines.push('');
  lines.push('Hermes wake-up brief (operator-safe / actionable deltas only)');
  lines.push('');
  lines.push('Operator mandate');
  lines.push(`  - Answer ${owner}'s latest visible request first; use this brief as context, not a script to paste.`);
  lines.push('  - For actionable work, create/refresh the Mission Board ticket, delegate visible workers, validate, and report the next transition.');
  lines.push('  - If state is ambiguous, inspect Ace live state before claiming idle or blocked.');
  lines.push('  - Dormant streams are diagnostic only — see `ace ls --include-dormant` if you need that view.');
  lines.push('');
  lines.push('Handoff — what needs you next');

  const wsList = payload?.workspaces || [];
  if (wsList.length === 0) {
    lines.push('  (no workspaces)');
  } else {
    for (const ws of wsList) {
      const handoff = ws.handoff || {};
      const lastChange = handoff.lastChange;
      const relative = lastChange?.at ? formatRelativeTime(lastChange.at) : null;
      const lastLine = lastChange
        ? `${lastChange.summary}${relative ? ` (${relative})` : ''}`
        : '(none)';
      lines.push(`  WORKSPACE ${ws.workspaceName}: ${handoff.nextAction || 'nothing'}`);
      lines.push(`    last: ${lastLine}`);
      lines.push(`    blocker: ${handoff.blocker || '(none)'}`);
    }
  }

  lines.push('');
  lines.push('Per-workspace derived state');

  if (wsList.length === 0) {
    lines.push('  (no workspaces)');
  } else {
    for (const ws of wsList) {
      lines.push(`  WORKSPACE ${ws.workspaceName} (${ws.workspaceId})`);
      const op = ws.orchestratorActionability;
      if (ws.liveOrchestrator) {
        lines.push(
          `    orchestrator: ${ws.liveOrchestrator.streamId} | agent=${ws.liveOrchestrator.agent || '?'} | ${fmtActionability(ws.liveOrchestrator)}`
        );
      } else if (ws.isPersonalWorkspace) {
        lines.push('    orchestrator: (personal lane not awake yet)');
      } else if (op && op.label === ACTIONABILITY.REQUIRED_ORCHESTRATOR_MISSING) {
        lines.push('    orchestrator: (none — gap)');
      } else {
        lines.push('    orchestrator: no standing orchestrator expected');
      }

      // Operator-safe rollup: dormant streams are not listed individually.
      const activeCount = ws.activeWorkers.length;
      const awaitingCount = ws.awaitingInput.length;
      const blockedCount = ws.blocked.length;
      const dormantCount = ws.dormantWorkers.length;
      const rollupParts: string[] = [];
      if (activeCount) rollupParts.push(`${activeCount} active`);
      if (awaitingCount) rollupParts.push(`${awaitingCount} awaiting`);
      if (blockedCount) rollupParts.push(`${blockedCount} blocked`);
      if (dormantCount) rollupParts.push(`${dormantCount} dormant (diagnostic)`);
      lines.push(`    workers: ${rollupParts.length ? rollupParts.join(', ') : '(none)'}`);

      // Only list streams that are NOT diagnostic-dormant.
      const operator = ws.streams.filter((s: any) => s.actionability && !isDiagnosticLabel(s.actionability.label));
      if (operator.length) {
        lines.push('    operator-facing streams:');
        for (const s of operator) {
          lines.push(`    - ${s.streamId} | agent=${s.agent || '?'} | ${fmtActionability(s)}`);
        }
      }
    }
  }

  // Orphans only surface if they are operator-actionable.
  const orphans = (payload?.orphanStreams || []).filter(
    (s: any) => s.actionability && !isDiagnosticLabel(s.actionability.label)
  );
  if (orphans.length) {
    lines.push('  (unassigned operator-facing streams)');
    for (const s of orphans) {
      lines.push(`  - ${s.streamId} | agent=${s.agent || '?'} | ${fmtActionability(s)}`);
    }
  }

  lines.push('');
  lines.push('Needs action now');
  const needs: string[] = [];
  for (const ws of wsList) {
    if (ws.handoff?.needsAction && ws.handoff.nextAction) {
      needs.push(`  - ${ws.workspaceName}: ${ws.handoff.nextAction}`);
    }
  }
  if (needs.length === 0) lines.push('  (nothing)');
  else for (const l of needs) lines.push(l);

  lines.push('');
  lines.push('Can wait');
  const wait: string[] = [];
  for (const ws of wsList) {
    for (const s of ws.activeWorkers) {
      wait.push(`  - ${ws.workspaceName}/${s.streamId}: ${s.actionability ? s.actionability.label : s.state} (agent=${s.agent || '?'})`);
    }
  }
  if (wait.length === 0) lines.push('  (nothing)');
  else for (const l of wait) lines.push(l);

  return lines.join('\n');
}

// Full diagnostic rendering. Includes the raw dormant stream inventory.
// NEVER used in operator-facing wake text — call this only from a
// diagnostic CLI surface.
function formatDiagnosticWakeBrief(payload) {
  const lines: string[] = [];
  lines.push('Wake brief (diagnostic, NOT operator-facing)');
  const wsList = payload?.workspaces || [];
  for (const ws of wsList) {
    lines.push(`WORKSPACE ${ws.workspaceName} (${ws.workspaceId})`);
    for (const s of ws.streams) {
      lines.push(`  ${s.streamId} | agent=${s.agent || '?'} | state=${s.state} | ${fmtActionability(s)} | live=${s.live}`);
    }
    if (ws.dormantWorkers.length) {
      lines.push(`  dormant rows: ${ws.dormantWorkers.length}`);
      for (const s of ws.dormantWorkers) {
        lines.push(`    - ${s.streamId} (agent=${s.agent || '?'}) ${s.label ? `"${s.label}"` : ''}`);
      }
    }
  }
  const orphans = payload?.orphanStreams || [];
  if (orphans.length) {
    lines.push('orphan streams:');
    for (const s of orphans) {
      lines.push(`  - ${s.streamId} | agent=${s.agent || '?'} | state=${s.state} | ${fmtActionability(s)}`);
    }
  }
  return lines.join('\n');
}

function buildPointerWakeBrief({
  identity = DEFAULT_OPERATOR_IDENTITY,
  latestChiefRequest = null,
  wikiCurrentStatePath = null,
  missionBoardSummary = null,
  blockers = [],
  nextAction = null,
  operatorLabel = null,
  controlPlaneLabels = null,
  ownerTitle = null,
} = {} as any) {
  const label = wakeOperatorLabel(identity, { operatorLabel });
  const owner = wakeOwnerTitle({ ownerTitle });
  const lines: string[] = [];
  lines.push(buildWakeFirstLine(controlPlaneLabels));
  lines.push('');
  lines.push(`${label} wake — pointer mode. Wake brief is deprecated as a rehydration source.`);
  lines.push('');
  lines.push(WAKE_POINTER_SENTENCE);

  const extras: string[] = [];
  if (latestChiefRequest) extras.push(`- latest ${owner}-visible request: ${String(latestChiefRequest)}`);
  if (wikiCurrentStatePath) extras.push(`- wiki current-state: ${String(wikiCurrentStatePath)}`);
  if (missionBoardSummary) extras.push(`- Mission Board: ${String(missionBoardSummary)}`);
  if (Array.isArray(blockers) && blockers.length > 0) {
    extras.push('- real blockers:');
    for (const b of blockers) extras.push(`    - ${String(b)}`);
  }
  if (nextAction) extras.push(`- next concrete action: ${String(nextAction)}`);
  if (extras.length > 0) {
    lines.push('');
    for (const l of extras) lines.push(l);
  }
  return lines.join('\n');
}

function buildHermesWakePrompt(opts: any = {}) {
  const identity = opts.identity || DEFAULT_OPERATOR_IDENTITY;
  const explicitMode = opts.mode && VALID_WAKE_MODES.has(opts.mode) ? opts.mode : null;
  const mode = explicitMode || 'pointer';
  const labelOpts = {
    operatorLabel: opts.operatorLabel,
    controlPlaneLabels: opts.controlPlaneLabels,
    ownerTitle: opts.ownerTitle,
  };
  const label = wakeOperatorLabel(identity, labelOpts);
  const owner = wakeOwnerTitle(labelOpts);

  if (mode === 'diagnostic') {
    // Diagnostic prompt uses the supplied or freshly-rendered operator-safe
    // brief, NOT the raw dormant inventory.
    const briefText = opts.briefText || (opts.payload ? formatWakeBrief(opts.payload, labelOpts) : '');
    return [
      `${label} wake-up: diagnostic mode. Use the operator-safe brief below to rehydrate. Do not post it verbatim unless ${owner} explicitly asks for the raw brief.`,
      '',
      '--- BEGIN BRIEF ---',
      briefText,
      '--- END BRIEF ---',
      '',
      buildOperatorWakeParagraph(identity, labelOpts),
      '',
      buildOperatorRehydrationContract(identity, labelOpts),
    ].join('\n');
  }

  if (mode === 'actionable-deltas') {
    const briefText = opts.briefText || (opts.payload ? formatWakeBrief(opts.payload, labelOpts) : '');
    return [
      `${label} wake-up: actionable-deltas mode. The operator-safe brief below contains derived actionability only — raw dormant streams are diagnostic and have been suppressed.`,
      '',
      WAKE_POINTER_SENTENCE,
      '',
      '--- BEGIN BRIEF ---',
      briefText,
      '--- END BRIEF ---',
      '',
      buildOperatorWakeParagraph(identity, labelOpts),
    ].join('\n');
  }

  // Default: pointer-only.
  const pointer = buildPointerWakeBrief({
    identity,
    latestChiefRequest: opts.latestChiefRequest,
    wikiCurrentStatePath: opts.wikiCurrentStatePath,
    missionBoardSummary: opts.missionBoardSummary,
    blockers: opts.blockers,
    nextAction: opts.nextAction,
    operatorLabel: opts.operatorLabel,
    controlPlaneLabels: opts.controlPlaneLabels,
    ownerTitle: opts.ownerTitle,
  });
  return [pointer, '', buildOperatorWakeParagraph(identity, labelOpts)].join('\n');
}

function hashWakePrompt(text) {
  return crypto.createHash('sha256').update(String(text || '')).digest('hex');
}

function shouldDeliverAutoWakePrompt({
  promptText,
  lastPromptHash = null,
  lastPromptAt = null,
  nowMs = Date.now(),
  debounceMs = HERMES_AUTO_WAKE_PROMPT_DEBOUNCE_MS,
} = {} as any) {
  const promptHash = hashWakePrompt(promptText);
  const lastMs = Date.parse(lastPromptAt || '');
  const hasRecentWake =
    Number.isFinite(lastMs) &&
    (nowMs < lastMs || nowMs - lastMs < debounceMs);
  if (hasRecentWake) {
    return {
      deliver: false,
      promptHash,
      reason: lastPromptHash === promptHash ? 'duplicate-auto-wake' : 'recent-auto-wake',
    };
  }
  return { deliver: true, promptHash, reason: null };
}

module.exports = {
  buildWakeBriefPayload,
  formatWakeBrief,
  formatDiagnosticWakeBrief,
  buildPointerWakeBrief,
  buildHermesWakePrompt,
  buildOperatorWakeParagraph,
  buildOperatorRehydrationContract,
  hashWakePrompt,
  shouldDeliverAutoWakePrompt,
  classifyStreamActionability,
  classifyOrchestratorPresence,
  isBlockingLabel,
  isDiagnosticLabel,
  ACTIONABILITY,
  HERMES_AUTO_WAKE_PROMPT_DEBOUNCE_MS,
  FIRST_LINE,
  buildWakeFirstLine,
  WAKE_POINTER_SENTENCE,
  expectsLiveWorkspaceOrchestrator,
};
