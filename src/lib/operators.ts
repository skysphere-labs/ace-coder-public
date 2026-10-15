// Renderer-side mirror of the electron operator contract (electron/operators.cts,
// schema ace.operators.v1). Operators describe the personal/control-plane
// agents an install runs (shipped default: one neutral 'hermes' operator; an
// owner install may carry e.g. 'rook'/'king' as local config). Keep the field
// set and helper semantics identical to the electron side — this file must not
// import IPC or window bridges; the registry in src/runtime/operators-registry.ts
// hydrates it via an injected fetcher.
//
// No wake/voice fields: voice features are removed.

export const OPERATORS_SCHEMA = 'ace.operators.v1';

/** One rotating reasoning-vocab entry (mirrors the Entries.tsx GERUNDS pairs). */
export type OperatorGerund = {
  emoji: string;
  verb: string;
};

/** Chat copy owned by an operator profile. */
export type OperatorChatCopy = {
  /** Idle composer placeholder, e.g. 'Message Hermes'. */
  placeholder: string;
  /** Busy row/placeholder copy, e.g. 'Hermes is working…'. */
  busyRow: string;
  /** Rotating reasoning vocab shown while streaming. */
  gerunds: OperatorGerund[];
};

export type OperatorProfile = {
  /** Canonical lowercase operator id ('hermes'; owner installs: 'rook'/'king'). */
  id: string;
  label: string;
  /** Identity mark shown in chat (e.g. '🧠', '♜', '♔'). */
  emoji: string;
  /** Driving agent id ('hermes' | 'claude' | 'codex' | ...). */
  agent: string;
  /** Lane provider kind; personal operators use 'builtin-personal'. */
  providerKind: string;
  isControlPlane: boolean;
  autoStart: boolean;
  sortOrder: number;
  /** Workspace dir name under the data root, e.g. 'personal-workspace'. */
  workspaceDirName: string;
  /** Terminal/home dir name under the data root, e.g. 'personal-hermes'. */
  terminalDirName: string;
  /** Relative-to-data-root when under it, absolute when external. */
  hermesHome?: string | null;
  legacyAuthDirs?: string[];
  memoryDbPath?: string | null;
  personaPath?: string | null;
  /** Persona prompt; null means electron never writes a SOUL.md for it. */
  persona?: string | null;
  chat: OperatorChatCopy;
  /** How the operator addresses the owner (neutral default: 'Owner'). */
  ownerTitle: string;
};

export type OperatorsConfig = {
  schema: typeof OPERATORS_SCHEMA;
  defaultOperatorId: string;
  operators: OperatorProfile[];
  /** Provenance embedded by the electron migration; absent on shipped defaults. */
  migratedFrom?: string;
};

const DEFAULT_HERMES_OPERATOR: OperatorProfile = Object.freeze({
  id: 'hermes',
  label: 'Hermes',
  emoji: '🧠',
  agent: 'hermes',
  providerKind: 'builtin-personal',
  isControlPlane: true,
  autoStart: false,
  sortOrder: 0,
  workspaceDirName: 'personal-workspace',
  terminalDirName: 'personal-hermes',
  hermesHome: null,
  legacyAuthDirs: [],
  memoryDbPath: null,
  personaPath: null,
  persona: null,
  chat: {
    placeholder: 'Message Hermes',
    busyRow: 'Hermes is working…',
    gerunds: [
      { emoji: '💭', verb: 'Thinking' },
      { emoji: '🤔', verb: 'Pondering' },
      { emoji: '🔎', verb: 'Searching' },
      { emoji: '⚗️', verb: 'Synthesizing' },
      { emoji: '✍️', verb: 'Drafting' },
      { emoji: '🌀', verb: 'Spinning-up' },
    ],
  },
  ownerTitle: 'Owner',
});

/**
 * Shipped neutral defaults: a single Hermes control-plane operator. The
 * electron migration replaces this with the install's local operators.json;
 * until that config is fetched the renderer renders these defaults.
 */
export const DEFAULT_OPERATORS: OperatorsConfig = Object.freeze({
  schema: OPERATORS_SCHEMA,
  defaultOperatorId: 'hermes',
  operators: Object.freeze([DEFAULT_HERMES_OPERATOR]) as OperatorProfile[],
});

/** Case-insensitive operator lookup; trims; null for empty/unknown ids. */
export function getOperator(config: OperatorsConfig, id: unknown): OperatorProfile | null {
  const key = String(id ?? '').trim().toLowerCase();
  if (!key) return null;
  return config.operators.find((operator) => operator.id.toLowerCase() === key) ?? null;
}

/** Control-plane operators sorted by sortOrder (stable id tiebreak). */
export function listControlPlaneOperators(config: OperatorsConfig): OperatorProfile[] {
  return config.operators
    .filter((operator) => operator.isControlPlane)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));
}

/**
 * Normalize a raw identity value to a canonical operator id.
 * - empty/nullish → null
 * - 'lane:'-prefixed ids pass through trimmed as-is (orchestrator lane ids
 *   never enter the operator pipeline; mirrors the electron migration filter)
 * - known operator id (case-insensitive) → canonical id
 * - unknown → null (callers that want a fallback use config.defaultOperatorId)
 */
export function normalizeOperatorId(
  value: unknown,
  config: OperatorsConfig = DEFAULT_OPERATORS
): string | null {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  if (raw.toLowerCase().startsWith('lane:')) return raw;
  return getOperator(config, raw)?.id ?? null;
}
