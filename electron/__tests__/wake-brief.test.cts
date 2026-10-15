import { afterEach, expect, test, vi } from 'vitest';

const {
  buildWakeBriefPayload,
  formatWakeBrief,
  formatDiagnosticWakeBrief,
  buildPointerWakeBrief,
  buildHermesWakePrompt,
  buildOperatorWakeParagraph,
  buildOperatorRehydrationContract,
  shouldDeliverAutoWakePrompt,
  HERMES_AUTO_WAKE_PROMPT_DEBOUNCE_MS,
  FIRST_LINE,
  buildWakeFirstLine,
  WAKE_POINTER_SENTENCE,
  ACTIONABILITY,
} = require('../wake-brief.cts');

function render(input) {
  const payload = buildWakeBriefPayload(input);
  return { payload, text: formatWakeBrief(payload) };
}

function freezeTime(isoString) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(isoString));
}

afterEach(() => {
  vi.useRealTimers();
});

test('the spec pointer sentence is preserved verbatim', () => {
  expect(WAKE_POINTER_SENTENCE).toBe(
    'Read the clean wiki current-state and Mission Board. Do not infer state from raw dormant streams.'
  );
});

test('empty state operator-safe brief contains the structural sections', () => {
  const { text } = render({ streams: [], workspaces: [] });
  expect(text.startsWith(FIRST_LINE)).toBe(true);
  expect(text).toContain('Hermes wake-up brief (operator-safe');
  expect(text).toContain('Operator mandate');
  expect(text).toContain('Handoff — what needs you next');
  expect(text).toContain('Per-workspace derived state');
  expect(text).toContain('Needs action now');
  expect(text).toContain('Can wait');
  // No raw dormant listing markers.
  expect(text).not.toMatch(/dormant \(\d+\):/);
  expect(text).not.toContain('| state=dormant');
});

test('operator-safe brief never lists raw dormant streams individually', () => {
  const workspaces = [
    {
      id: 'ws_1',
      name: 'alpha',
      tasks: [{ id: 'tsk_2', name: 'follow-up', agent: 'codex', status: 'done', updated_at: '2026-04-22T11:30:00.000Z' }],
    },
  ];
  const streams = [
    {
      streamId: 'conversation:d1',
      agent: 'codex',
      state: 'dormant',
      label: 'follow-up',
      taskId: 'tsk_2',
      workspaceId: 'ws_1',
      live: false,
    },
    {
      streamId: 'conversation:d2',
      agent: 'codex',
      state: 'dormant',
      label: 'older',
      taskId: 'tsk_2',
      workspaceId: 'ws_1',
      live: false,
    },
  ];
  const { text, payload } = render({ streams, workspaces });
  expect(text).not.toContain('conversation:d1');
  expect(text).not.toContain('conversation:d2');
  // But the rollup count is still surfaced.
  expect(text).toContain('2 dormant (diagnostic)');
  // Payload still carries derived actionability so callers can inspect.
  const ws = payload.workspaces[0];
  expect(ws.streams).toHaveLength(2);
  for (const s of ws.streams) {
    expect(s.actionability.label).toBe(ACTIONABILITY.DIAGNOSTIC_DORMANT);
  }
});

test('dormant streams never appear in "Needs action now"', () => {
  const workspaces = [{ id: 'ws_1', name: 'alpha', tasks: [] }];
  const streams = [
    {
      streamId: 'conversation:d1',
      agent: 'codex',
      state: 'dormant',
      taskId: null,
      workspaceId: 'ws_1',
      live: false,
    },
  ];
  const { text, payload } = render({ streams, workspaces });
  expect(payload.workspaces[0].handoff.nextAction).toBeNull();
  expect(payload.workspaces[0].handoff.needsAction).toBe(false);
  const needsBlock = text.split('Needs action now')[1].split('Can wait')[0];
  expect(needsBlock).toContain('(nothing)');
});

test('awaiting-input alone (no current mission card) is stale, not actionable', () => {
  freezeTime('2026-04-22T12:00:00.000Z');
  const workspaces = [{ id: 'ws_1', name: 'alpha', tasks: [{ id: 'tsk_w', name: 'worker', agent: 'codex', status: 'active' }] }];
  const streams = [
    {
      streamId: 'conversation:w1',
      agent: 'codex',
      state: 'awaiting-input',
      taskId: 'tsk_w',
      workspaceId: 'ws_1',
      live: true,
      lastChangeAt: Date.parse('2026-04-22T11:59:00.000Z'),
      hasCurrentMissionCard: false,
    },
  ];
  const payload = buildWakeBriefPayload({ streams, workspaces });
  const s = payload.workspaces[0].streams[0];
  expect(s.actionability.label).toBe(ACTIONABILITY.STALE_AWAITING_INPUT);
  expect(payload.workspaces[0].handoff.needsAction).toBe(false);
});

test('awaiting-input attached to a live mission card becomes awaiting-chief and triggers review handoff', () => {
  freezeTime('2026-04-22T12:00:00.000Z');
  const workspaces = [{ id: 'ws_1', name: 'alpha', tasks: [{ id: 'tsk_w', name: 'worker', agent: 'codex', status: 'active' }] }];
  const streams = [
    {
      streamId: 'conversation:w1',
      agent: 'codex',
      state: 'awaiting-input',
      taskId: 'tsk_w',
      workspaceId: 'ws_1',
      live: true,
      lastChangeAt: Date.parse('2026-04-22T11:59:00.000Z'),
      hasCurrentMissionCard: true,
    },
  ];
  const payload = buildWakeBriefPayload({ streams, workspaces });
  const s = payload.workspaces[0].streams[0];
  expect(s.actionability.label).toBe(ACTIONABILITY.AWAITING_CHIEF);
  expect(payload.workspaces[0].handoff.nextAction).toBe('review conversation:w1 (agent=codex)');
  expect(payload.workspaces[0].handoff.needsAction).toBe(true);
});

test('awaiting-approval becomes blocked-approval only when attached to a live card', () => {
  const workspaces = [{ id: 'ws_1', name: 'alpha', tasks: [{ id: 'tsk_w', name: 'worker', agent: 'codex', status: 'active' }] }];
  const blockingStream = {
    streamId: 'conversation:w1',
    agent: 'codex',
    state: 'awaiting-approval',
    taskId: 'tsk_w',
    workspaceId: 'ws_1',
    live: true,
    hasCurrentMissionCard: true,
  };
  const payloadBlocking = buildWakeBriefPayload({ streams: [blockingStream], workspaces });
  expect(payloadBlocking.workspaces[0].streams[0].actionability.label).toBe(ACTIONABILITY.BLOCKED_APPROVAL);
  expect(payloadBlocking.workspaces[0].handoff.needsAction).toBe(true);

  const orphanStream = { ...blockingStream, hasCurrentMissionCard: false };
  const payloadOrphan = buildWakeBriefPayload({ streams: [orphanStream], workspaces });
  expect(payloadOrphan.workspaces[0].streams[0].actionability.label).toBe(ACTIONABILITY.STALE_AWAITING_INPUT);
  expect(payloadOrphan.workspaces[0].handoff.needsAction).toBe(false);
});

test('interrupted streams are not clean-ready', () => {
  const workspaces = [{ id: 'ws_1', name: 'alpha', tasks: [] }];
  const streams = [
    {
      streamId: 'conversation:w1',
      agent: 'codex',
      state: 'interrupted',
      taskId: null,
      workspaceId: 'ws_1',
      live: true,
    },
  ];
  const payload = buildWakeBriefPayload({ streams, workspaces });
  expect(payload.workspaces[0].streams[0].actionability.label).toBe(ACTIONABILITY.INTERRUPTED);
});

test('Conversation-interrupted banner in raw tail forces interrupted classification', () => {
  const workspaces = [{ id: 'ws_1', name: 'alpha', tasks: [] }];
  const streams = [
    {
      streamId: 'conversation:w1',
      agent: 'codex',
      state: 'awaiting-input',
      taskId: null,
      workspaceId: 'ws_1',
      live: true,
      rawTail: 'something happened\nConversation interrupted by user\n❯ ',
      hasCurrentMissionCard: true,
    },
  ];
  const payload = buildWakeBriefPayload({ streams, workspaces });
  expect(payload.workspaces[0].streams[0].actionability.label).toBe(ACTIONABILITY.INTERRUPTED);
});

test('turn-complete with DONE trailer but no validation is task-complete-unvalidated', () => {
  const workspaces = [{ id: 'ws_1', name: 'alpha', tasks: [] }];
  const streams = [
    {
      streamId: 'conversation:w1',
      agent: 'codex',
      state: 'turn-complete',
      taskId: 'tsk',
      workspaceId: 'ws_1',
      live: true,
      doneTrailerSeen: true,
      hasCurrentMissionCard: true,
    },
  ];
  const payload = buildWakeBriefPayload({ streams, workspaces });
  expect(payload.workspaces[0].streams[0].actionability.label).toBe(ACTIONABILITY.TASK_COMPLETE_UNVALIDATED);
});

test('turn-complete + validated + current card = clean-ready', () => {
  const workspaces = [{ id: 'ws_1', name: 'alpha', tasks: [] }];
  const streams = [
    {
      streamId: 'conversation:w1',
      agent: 'codex',
      state: 'turn-complete',
      taskId: 'tsk',
      workspaceId: 'ws_1',
      live: true,
      doneTrailerSeen: true,
      validationStatus: 'passed',
      hasCurrentMissionCard: true,
    },
  ];
  const payload = buildWakeBriefPayload({ streams, workspaces });
  expect(payload.workspaces[0].streams[0].actionability.label).toBe(ACTIONABILITY.CLEAN_READY);
});

test('blocked task handoff marks the workspace as needing action', () => {
  freezeTime('2026-04-22T12:00:00.000Z');
  const workspaces = [
    {
      id: 'ws_1',
      name: 'alpha',
      tasks: [
        {
          id: 'tsk_1',
          name: 'API polish',
          agent: 'claude',
          status: 'blocked',
          updated_at: '2026-04-22T11:58:00.000Z',
        },
      ],
    },
  ];
  const payload = buildWakeBriefPayload({ streams: [], workspaces });
  expect(payload.workspaces[0].handoff.blocker).toBe('task API polish blocked');
  expect(payload.workspaces[0].handoff.nextAction).toBe('unblock task API polish blocked');
  expect(payload.workspaces[0].handoff.needsAction).toBe(true);
});

test('repo workspace with only a Claude worker does not require a standing orchestrator', () => {
  const workspaces = [
    {
      id: 'ws_2',
      name: 'beta',
      alwaysOnOrchestrator: false,
      tasks: [{ id: 'tsk_w', name: 'specialist pass', agent: 'claude', status: 'active' }],
    },
  ];
  const streams = [
    {
      streamId: 'conversation:w',
      agent: 'claude',
      state: 'busy',
      taskId: 'tsk_w',
      workspaceId: 'ws_2',
      live: true,
    },
  ];
  const payload = buildWakeBriefPayload({ streams, workspaces });
  expect(payload.workspaces[0].orchestratorActionability.label).toBe(ACTIONABILITY.NO_STANDING_ORCHESTRATOR_EXPECTED);
  expect(payload.workspaces[0].handoff.nextAction).toBeNull();
  expect(payload.workspaces[0].handoff.needsAction).toBe(false);
});

test('missing required orchestrator becomes a real gap', () => {
  const workspaces = [
    {
      id: 'ws_2',
      name: 'beta',
      alwaysOnOrchestrator: true,
      alwaysOnAgent: 'hermes',
      tasks: [{ id: 'tsk_w', name: 'feat', agent: 'claude', status: 'active' }],
    },
  ];
  const streams = [
    {
      streamId: 'conversation:w',
      agent: 'claude',
      state: 'busy',
      taskId: 'tsk_w',
      workspaceId: 'ws_2',
      live: true,
    },
  ];
  const payload = buildWakeBriefPayload({ streams, workspaces });
  expect(payload.workspaces[0].orchestratorActionability.label).toBe(ACTIONABILITY.REQUIRED_ORCHESTRATOR_MISSING);
  expect(payload.workspaces[0].handoff.nextAction).toBe('start orchestrator');
  expect(payload.workspaces[0].handoff.needsAction).toBe(true);
});

test('legacy Claude always-on rows are not reported as wake gaps', () => {
  const workspaces = [
    {
      id: 'ws_2',
      name: 'beta',
      alwaysOnOrchestrator: true,
      alwaysOnAgent: 'claude',
      tasks: [],
    },
  ];
  const payload = buildWakeBriefPayload({ streams: [], workspaces });
  expect(payload.workspaces[0].orchestratorActionability.label).toBe(ACTIONABILITY.NO_STANDING_ORCHESTRATOR_EXPECTED);
  expect(payload.workspaces[0].handoff.nextAction).toBeNull();
  expect(payload.workspaces[0].handoff.needsAction).toBe(false);
});

test('personal Rook/King lanes do not tell Hermes to start another orchestrator while waking', () => {
  const workspaces = [
    {
      id: 'prj-king',
      name: 'King',
      isPersonal: true,
      personalIdentity: 'king',
      alwaysOnOrchestrator: true,
      alwaysOnAgent: 'hermes',
      tasks: [{ id: 'thr-king', name: 'Hermes Orchestrator — KIN', agent: 'hermes', status: 'active' }],
    },
  ];
  const payload = buildWakeBriefPayload({ streams: [], workspaces });
  expect(payload.workspaces[0].orchestratorActionability.label).toBe(ACTIONABILITY.NO_STANDING_ORCHESTRATOR_EXPECTED);
  expect(payload.workspaces[0].handoff.nextAction).toBeNull();
  expect(payload.workspaces[0].handoff.needsAction).toBe(false);
});

test('active workers only means nothing is needed from the user', () => {
  const workspaces = [
    {
      id: 'ws_3',
      name: 'gamma',
      tasks: [
        { id: 'tsk_o', name: 'Codex Orchestrator — A', agent: 'codex', status: 'active' },
        { id: 'tsk_w', name: 'ship it', agent: 'claude', status: 'active' },
      ],
    },
  ];
  const streams = [
    {
      streamId: 'conversation:o1',
      agent: 'codex',
      state: 'busy',
      taskId: 'tsk_o',
      workspaceId: 'ws_3',
      live: true,
    },
    {
      streamId: 'conversation:w1',
      agent: 'claude',
      state: 'busy',
      taskId: 'tsk_w',
      workspaceId: 'ws_3',
      live: true,
    },
  ];
  const payload = buildWakeBriefPayload({ streams, workspaces });
  expect(payload.workspaces[0].handoff.nextAction).toBeNull();
  expect(payload.workspaces[0].handoff.needsAction).toBe(false);
  for (const s of payload.workspaces[0].streams) {
    expect(s.actionability.label).toBe(ACTIONABILITY.ACTIVE_WORKING);
  }
});

test('default buildHermesWakePrompt is pointer-only and contains the spec pointer sentence', () => {
  const prompt = buildHermesWakePrompt({ identity: 'rook' });
  expect(prompt).toContain(WAKE_POINTER_SENTENCE);
  expect(prompt).toContain('pointer mode');
  expect(prompt).toContain(buildOperatorWakeParagraph('rook'));
  // No raw dormant inventory, no operator-safe brief sections.
  expect(prompt).not.toContain('dormant (');
  expect(prompt).not.toContain('Per-workspace derived state');
  expect(prompt).not.toContain('Hermes wake-up brief (operator-safe');
});

test('pointer brief includes optional structured fields verbatim when provided', () => {
  const prompt = buildHermesWakePrompt({
    identity: 'king',
    ownerTitle: 'Chief',
    latestChiefRequest: 'tighten the wiki guardrails',
    wikiCurrentStatePath: '~/wiki/ace-ops/dashboards/current-state.md',
    missionBoardSummary: '2 cards in progress, 1 awaiting validation',
    blockers: ['validator stuck on PR #128'],
    nextAction: 'rerun mission validate on ft_42',
  });
  expect(prompt).toContain(WAKE_POINTER_SENTENCE);
  expect(prompt).toContain('latest Chief-visible request: tighten the wiki guardrails');
  expect(prompt).toContain('wiki current-state: ~/wiki/ace-ops/dashboards/current-state.md');
  expect(prompt).toContain('Mission Board: 2 cards in progress, 1 awaiting validation');
  expect(prompt).toContain('validator stuck on PR #128');
  expect(prompt).toContain('next concrete action: rerun mission validate on ft_42');
});

test('actionable-deltas mode embeds the operator-safe brief but not the raw dormant inventory', () => {
  const workspaces = [{ id: 'ws_1', name: 'alpha', tasks: [] }];
  const streams = [
    {
      streamId: 'conversation:d1',
      agent: 'codex',
      state: 'dormant',
      taskId: null,
      workspaceId: 'ws_1',
      live: false,
    },
  ];
  const payload = buildWakeBriefPayload({ streams, workspaces });
  const prompt = buildHermesWakePrompt({ identity: 'rook', mode: 'actionable-deltas', payload });
  expect(prompt).toContain(WAKE_POINTER_SENTENCE);
  expect(prompt).toContain('Hermes wake-up brief (operator-safe');
  expect(prompt).not.toContain('conversation:d1');
});

test('diagnostic mode is opt-in and uses the operator-safe brief in the prompt', () => {
  const payload = buildWakeBriefPayload({ streams: [], workspaces: [] });
  const prompt = buildHermesWakePrompt({ identity: 'rook', mode: 'diagnostic', payload });
  expect(prompt).toContain('Diagnostic mode'.toLowerCase().includes('diagnostic') ? 'diagnostic mode' : 'diagnostic');
  expect(prompt).toContain(buildOperatorRehydrationContract('rook'));
});

test('formatDiagnosticWakeBrief is the only path that lists raw dormant stream ids', () => {
  const workspaces = [{ id: 'ws_1', name: 'alpha', tasks: [] }];
  const streams = [
    {
      streamId: 'conversation:d1',
      agent: 'codex',
      state: 'dormant',
      taskId: null,
      workspaceId: 'ws_1',
      live: false,
      label: 'follow-up',
    },
  ];
  const payload = buildWakeBriefPayload({ streams, workspaces });
  const diag = formatDiagnosticWakeBrief(payload);
  expect(diag).toContain('conversation:d1');
  expect(diag).toContain('(diagnostic, NOT operator-facing)');
});

test('buildPointerWakeBrief alone is enough to wake without injecting any state', () => {
  const text = buildPointerWakeBrief({ identity: 'rook' });
  expect(text.startsWith(FIRST_LINE)).toBe(true);
  expect(text).toContain(WAKE_POINTER_SENTENCE);
  // The pointer sentence mentions "raw dormant streams" by name as a
  // warning, but it must NOT include a listing of individual dormant rows
  // or per-stream awaiting-* badges.
  expect(text).not.toMatch(/state=dormant/i);
  expect(text).not.toMatch(/dormant \(\d+\):/);
  expect(text).not.toMatch(/awaiting-input \(\d+\):/);
});

test('auto wake prompt debounce still suppresses recent duplicates', () => {
  const sentAt = Date.parse('2026-05-02T12:00:00.000Z');
  for (const identity of ['rook', 'king']) {
    const prompt = buildHermesWakePrompt({ identity });
    const first = shouldDeliverAutoWakePrompt({ promptText: prompt, nowMs: sentAt });
    expect(first.deliver).toBe(true);

    const repeated = shouldDeliverAutoWakePrompt({
      promptText: prompt,
      lastPromptHash: first.promptHash,
      lastPromptAt: new Date(sentAt).toISOString(),
      nowMs: sentAt + 5 * 60_000,
    });
    expect(repeated.deliver).toBe(false);
    expect(repeated.reason).toBe('duplicate-auto-wake');

    const later = shouldDeliverAutoWakePrompt({
      promptText: prompt,
      lastPromptHash: first.promptHash,
      lastPromptAt: new Date(sentAt).toISOString(),
      nowMs: sentAt + HERMES_AUTO_WAKE_PROMPT_DEBOUNCE_MS + 1,
    });
    expect(later.deliver).toBe(true);
  }
});

// ── operator-profile label templating (cross-unit contract) ──

test('default first line is the neutral operator copy; owner labels render the legacy line', () => {
  expect(buildWakeFirstLine()).toBe(FIRST_LINE);
  expect(FIRST_LINE).toBe(
    'Morning. Ace Agents are up — Hermes is the standing operator lane; repo workspace orchestrators are opt-in.'
  );
  expect(buildWakeFirstLine(['Rook', 'King'])).toBe(
    'Morning. Ace Agents are up — Rook and King are the standing operator lanes; repo workspace orchestrators are opt-in.'
  );
});

test('neutral defaults contain no owner personalization', () => {
  const prompt = buildHermesWakePrompt({});
  expect(prompt).toContain('Hermes is the standing operator lane');
  expect(prompt).toContain('Hermes wake — pointer mode.');
  expect(prompt).toContain("act on the owner's latest visible request");
  expect(prompt).not.toMatch(/\bRook\b|\bKing\b|\bChief\b/);
});

test('owner-shaped config renders the legacy wake prompt byte-identically', () => {
  // BYTE-IDENTITY GUARANTEE: an owner-shaped operators config (the migrated
  // Rook/King profiles) must reproduce the exact wake copy the legacy
  // hardcoded defaults produced, so the owner's lanes see zero copy drift
  // after the legacy fallback removal.
  const ownerOpts = {
    controlPlaneLabels: ['Rook', 'King'],
    ownerTitle: 'Chief',
  };
  const legacyPointerPrompt = [
    'Morning. Ace Agents are up — Rook and King are the standing operator lanes; repo workspace orchestrators are opt-in.',
    '',
    'Rook wake — pointer mode. Wake brief is deprecated as a rehydration source.',
    '',
    'Read the clean wiki current-state and Mission Board. Do not infer state from raw dormant streams.',
    '',
    "Role: Rook Ace operator. Treat the wake brief as rehydration context, then answer or act on Chief's latest visible request. You may inspect state, plan, create tickets, and create/delegate Ace tasks through the app's normal task flow when a handoff requires it. Keep shared repos safe: do not directly push, merge, fork, or edit repo files from this personal lane; implementation belongs in specialist task worktrees or explicit user-approved flows.",
  ].join('\n');
  expect(
    buildHermesWakePrompt({ identity: 'rook', operatorLabel: 'Rook', ...ownerOpts })
  ).toBe(legacyPointerPrompt);

  const kingPointer = buildPointerWakeBrief({
    identity: 'king',
    operatorLabel: 'King',
    ...ownerOpts,
  });
  expect(kingPointer).toBe(
    [
      'Morning. Ace Agents are up — Rook and King are the standing operator lanes; repo workspace orchestrators are opt-in.',
      '',
      'King wake — pointer mode. Wake brief is deprecated as a rehydration source.',
      '',
      'Read the clean wiki current-state and Mission Board. Do not infer state from raw dormant streams.',
    ].join('\n')
  );

  const contract = buildOperatorRehydrationContract('king', {
    operatorLabel: 'King',
    ...ownerOpts,
  });
  expect(contract).toContain('Operator rehydration contract for King:');
  expect(contract).toContain(
    '- Treat Rook and King as persistent Hermes operator lanes, not disposable test chats.'
  );
  expect(contract).toContain(
    'Do not reset, hard-clear, or delete Rook/King history unless Chief explicitly asks.'
  );
});

test('custom operator labels fully replace Rook/King/Chief in the pointer wake prompt', () => {
  const prompt = buildHermesWakePrompt({
    identity: 'atlas',
    operatorLabel: 'Atlas',
    controlPlaneLabels: ['Atlas'],
    ownerTitle: 'Captain',
    latestChiefRequest: 'review the deploy',
  });
  expect(prompt).toContain('Atlas is the standing operator lane');
  expect(prompt).toContain('Atlas wake — pointer mode.');
  expect(prompt).toContain('Role: Atlas Ace operator.');
  expect(prompt).toContain("act on Captain's latest visible request");
  expect(prompt).toContain('latest Captain-visible request: review the deploy');
  expect(prompt).toContain(WAKE_POINTER_SENTENCE);
  expect(prompt).not.toContain('Rook');
  expect(prompt).not.toContain('King');
  expect(prompt).not.toContain('Chief');
});

test('custom labels thread through diagnostic mode, the brief, and the rehydration contract', () => {
  const payload = buildWakeBriefPayload({ streams: [], workspaces: [] });
  const prompt = buildHermesWakePrompt({
    identity: 'atlas',
    mode: 'diagnostic',
    payload,
    operatorLabel: 'Atlas',
    controlPlaneLabels: ['Atlas', 'Vega'],
    ownerTitle: 'Captain',
  });
  expect(prompt).toContain('Atlas wake-up: diagnostic mode.');
  expect(prompt).toContain('Do not post it verbatim unless Captain explicitly asks for the raw brief.');
  expect(prompt).toContain('Atlas and Vega are the standing operator lanes');
  expect(prompt).toContain("Answer Captain's latest visible request first");
  expect(prompt).toContain('Operator rehydration contract for Atlas:');
  expect(prompt).toContain('Treat Atlas and Vega as persistent Hermes operator lanes');
  expect(prompt).toContain('delete Atlas/Vega history unless Captain explicitly asks');
  expect(prompt).not.toContain('Rook');
  expect(prompt).not.toContain('King');
  expect(prompt).not.toContain('Chief');
});

test('a single custom control-plane label uses singular lane copy', () => {
  const contract = buildOperatorRehydrationContract('atlas', {
    operatorLabel: 'Atlas',
    controlPlaneLabels: ['Atlas'],
    ownerTitle: 'Captain',
  });
  expect(contract).toContain('Treat Atlas as a persistent Hermes operator lane, not a disposable test chat.');
  expect(contract).toContain('delete Atlas history unless Captain explicitly asks');
});

test('hash drift between near-identical wakes still triggers recent-auto-wake suppression', () => {
  const sentAt = Date.parse('2026-05-02T12:00:00.000Z');
  const a = buildHermesWakePrompt({ identity: 'rook', missionBoardSummary: '8h ago' });
  const b = buildHermesWakePrompt({ identity: 'rook', missionBoardSummary: '9h ago' });
  const first = shouldDeliverAutoWakePrompt({ promptText: a, nowMs: sentAt });
  const repeated = shouldDeliverAutoWakePrompt({
    promptText: b,
    lastPromptHash: first.promptHash,
    lastPromptAt: new Date(sentAt).toISOString(),
    nowMs: sentAt + 5 * 60_000,
  });
  expect(repeated.deliver).toBe(false);
  expect(repeated.reason).toBe('recent-auto-wake');
});
