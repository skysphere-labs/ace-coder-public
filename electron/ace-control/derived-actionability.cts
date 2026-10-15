// Derived stream actionability.
//
// The raw state machine (state-machine.cts) emits primitive PTY states:
// booting, awaiting-input, busy, awaiting-approval, turn-complete,
// interrupted, error. Those primitives are too coarse for operator routing —
// awaiting-input alone is not actionable, dormant alone is not urgent, and
// the system has no honest way today to distinguish "clean ready" from
// "stale awaiting-input contamination."
//
// This module preserves the raw state machine and layers a *derived*
// actionability classification on top. The 11 classifications match the
// AGENT_2 spec.
//
// Pure function. Takes already-collected inputs and returns one of the
// classification labels with structured detail. No I/O, no mutation.

const ACTIONABILITY = {
  AWAITING_CHIEF: 'awaiting-chief',
  AWAITING_WORKER: 'awaiting-worker',
  STALE_AWAITING_INPUT: 'stale-awaiting-input',
  INTERRUPTED: 'interrupted',
  CLEAN_READY: 'clean-ready',
  TASK_COMPLETE_UNVALIDATED: 'task-complete-unvalidated',
  DIAGNOSTIC_DORMANT: 'diagnostic-dormant',
  BLOCKED_APPROVAL: 'blocked-approval',
  ACTIVE_WORKING: 'active-working',
  NO_STANDING_ORCHESTRATOR_EXPECTED: 'no-standing-orchestrator-expected',
  REQUIRED_ORCHESTRATOR_MISSING: 'required-orchestrator-missing',
} as const;

type ActionabilityLabel =(typeof ACTIONABILITY)[keyof typeof ACTIONABILITY];

const STALE_AWAITING_INPUT_MS = 30 * 60_000; // 30 minutes
const COMPOSER_PROMPT_HINTS = /^[ \t ]*(?:│[ \t ]*)?[❯>][ \t ]+(?!Try ")[^\n]+/m;
const INTERRUPTED_BANNER = /Conversation\s+interrupted/i;

type StreamInput ={
  streamId?: string;
  state?: string;
  agent?: string | null;
  live?: boolean;
  taskId?: string | null;
  workspaceId?: string | null;
  lastChangeAt?: number | string | null;
  composerText?: string | null;
  rawTail?: string | null;
  hasCurrentMissionCard?: boolean;
  hasCleanEnvelope?: boolean;
  validationStatus?: string | null;
  doneTrailerSeen?: boolean;
};

type WorkspaceInput ={
  id?: string;
  isPersonal?: boolean;
  alwaysOnOrchestrator?: boolean;
  alwaysOnAgent?: string | null;
};

type ClassifyOptions ={
  nowMs?: number;
  staleAwaitingInputMs?: number;
};

type ClassifyResult ={
  label: ActionabilityLabel;
  reason: string;
  blocking: boolean;
  diagnostic: boolean;
};

function isPersonal(workspace: WorkspaceInput | null | undefined) {
  return !!(workspace && workspace.isPersonal);
}

function expectsStandingOrchestrator(workspace: WorkspaceInput | null | undefined) {
  if (!workspace) return false;
  if (isPersonal(workspace)) return false;
  if (String(workspace.alwaysOnAgent || 'hermes').toLowerCase() === 'claude') return false;
  return !!workspace.alwaysOnOrchestrator;
}

function ageMs(value: number | string | null | undefined, nowMs: number) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, nowMs - value);
  if (typeof value === 'string' && value) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return Math.max(0, nowMs - parsed);
  }
  return 0;
}

function detectInterrupted(stream: StreamInput) {
  if (stream.state === 'interrupted') return true;
  if (stream.rawTail && INTERRUPTED_BANNER.test(stream.rawTail)) return true;
  return false;
}

function detectComposerHasUnsentText(stream: StreamInput) {
  if (stream.composerText && stream.composerText.trim().length > 0) return true;
  if (stream.rawTail && COMPOSER_PROMPT_HINTS.test(stream.rawTail)) return true;
  return false;
}

function classifyStreamActionability(
  stream: StreamInput | null | undefined,
  workspace: WorkspaceInput | null | undefined = null,
  opts: ClassifyOptions = {}
): ClassifyResult {
  const s = (stream || {}) as StreamInput;
  const nowMs = typeof opts.nowMs === 'number' ? opts.nowMs : Date.now();
  const staleMs = typeof opts.staleAwaitingInputMs === 'number'
    ? opts.staleAwaitingInputMs
    : STALE_AWAITING_INPUT_MS;
  const state = s.state || 'unknown';
  const live = !!s.live;

  if (!live || state === 'dormant') {
    return {
      label: ACTIONABILITY.DIAGNOSTIC_DORMANT,
      reason: 'stream is not live; dormant rows are diagnostic only',
      blocking: false,
      diagnostic: true,
    };
  }

  if (state === 'awaiting-approval') {
    if (s.hasCurrentMissionCard === false) {
      return {
        label: ACTIONABILITY.STALE_AWAITING_INPUT,
        reason: 'awaiting-approval without an attached live Mission card — treat as stale',
        blocking: false,
        diagnostic: true,
      };
    }
    return {
      label: ACTIONABILITY.BLOCKED_APPROVAL,
      reason: 'awaiting-approval attached to a live current task/card',
      blocking: true,
      diagnostic: false,
    };
  }

  if (detectInterrupted(s)) {
    return {
      label: ACTIONABILITY.INTERRUPTED,
      reason: 'stream shows interrupted state; not clean-ready',
      blocking: false,
      diagnostic: true,
    };
  }

  if (state === 'error') {
    return {
      label: ACTIONABILITY.STALE_AWAITING_INPUT,
      reason: 'error state requires inspection; not actionable until cleared',
      blocking: false,
      diagnostic: true,
    };
  }

  if (state === 'busy' || state === 'booting') {
    return {
      label: ACTIONABILITY.ACTIVE_WORKING,
      reason: 'worker is mid-turn; nothing required from operator',
      blocking: false,
      diagnostic: false,
    };
  }

  if (state === 'turn-complete') {
    if (s.doneTrailerSeen && !s.validationStatus) {
      return {
        label: ACTIONABILITY.TASK_COMPLETE_UNVALIDATED,
        reason: 'DONE trailer present but validation/gate has not passed',
        blocking: true,
        diagnostic: false,
      };
    }
    if (s.validationStatus && s.validationStatus !== 'passed') {
      return {
        label: ACTIONABILITY.TASK_COMPLETE_UNVALIDATED,
        reason: `validation status=${s.validationStatus}; gate still open`,
        blocking: true,
        diagnostic: false,
      };
    }
    if (!s.hasCurrentMissionCard) {
      return {
        label: ACTIONABILITY.AWAITING_WORKER,
        reason: 'turn-complete on a stream without a current Mission card',
        blocking: false,
        diagnostic: false,
      };
    }
    return {
      label: ACTIONABILITY.CLEAN_READY,
      reason: 'turn-complete, validated, current card aligned',
      blocking: false,
      diagnostic: false,
    };
  }

  if (state === 'awaiting-input') {
    const ageSinceChange = ageMs(s.lastChangeAt, nowMs);
    const composerDirty = detectComposerHasUnsentText(s);
    if (composerDirty) {
      return {
        label: ACTIONABILITY.STALE_AWAITING_INPUT,
        reason: 'composer holds unsent text; not clean-ready',
        blocking: false,
        diagnostic: true,
      };
    }
    if (!s.hasCurrentMissionCard) {
      return {
        label: ACTIONABILITY.STALE_AWAITING_INPUT,
        reason: 'awaiting-input without an attached current Mission card',
        blocking: false,
        diagnostic: true,
      };
    }
    if (ageSinceChange >= staleMs) {
      return {
        label: ACTIONABILITY.STALE_AWAITING_INPUT,
        reason: `awaiting-input older than ${Math.round(staleMs / 60_000)}m without progression`,
        blocking: false,
        diagnostic: true,
      };
    }
    if (s.hasCleanEnvelope === false) {
      return {
        label: ACTIONABILITY.STALE_AWAITING_INPUT,
        reason: 'awaiting-input lacks a clean envelope (interrupted history or contamination)',
        blocking: false,
        diagnostic: true,
      };
    }
    return {
      label: ACTIONABILITY.AWAITING_CHIEF,
      reason: 'fresh awaiting-input attached to a current Mission card',
      blocking: false,
      diagnostic: false,
    };
  }

  return {
    label: ACTIONABILITY.DIAGNOSTIC_DORMANT,
    reason: `unhandled state=${state}; treat as diagnostic`,
    blocking: false,
    diagnostic: true,
  };
}

function classifyOrchestratorPresence(
  workspace: WorkspaceInput | null | undefined,
  hasLiveOrchestrator: boolean
): ClassifyResult {
  if (hasLiveOrchestrator) {
    return {
      label: ACTIONABILITY.ACTIVE_WORKING,
      reason: 'live orchestrator stream present',
      blocking: false,
      diagnostic: false,
    };
  }
  if (expectsStandingOrchestrator(workspace)) {
    return {
      label: ACTIONABILITY.REQUIRED_ORCHESTRATOR_MISSING,
      reason: 'workspace requires a standing orchestrator but none is live',
      blocking: true,
      diagnostic: false,
    };
  }
  return {
    label: ACTIONABILITY.NO_STANDING_ORCHESTRATOR_EXPECTED,
    reason: 'workspace does not require a standing orchestrator',
    blocking: false,
    diagnostic: false,
  };
}

function isBlockingLabel(label: ActionabilityLabel) {
  return (
    label === ACTIONABILITY.BLOCKED_APPROVAL ||
    label === ACTIONABILITY.TASK_COMPLETE_UNVALIDATED ||
    label === ACTIONABILITY.REQUIRED_ORCHESTRATOR_MISSING
  );
}

function isDiagnosticLabel(label: ActionabilityLabel) {
  return (
    label === ACTIONABILITY.DIAGNOSTIC_DORMANT ||
    label === ACTIONABILITY.STALE_AWAITING_INPUT ||
    label === ACTIONABILITY.INTERRUPTED
  );
}

module.exports = {
  ACTIONABILITY,
  classifyStreamActionability,
  classifyOrchestratorPresence,
  isBlockingLabel,
  isDiagnosticLabel,
};
