// Operator-driven chat copy resolution for the native chat surfaces.
//
// The registry snapshot (src/runtime/operators-registry.ts) starts from the
// renderer DEFAULT_OPERATORS mirror and is hydrated from the install's
// electron config (electron/operators.cts), whose chat shape is looser than
// the renderer mirror: `chat` may be null, its fields are optional, `emoji`
// may be null, gerunds may be the full `{ default, pairs }` identity vocab,
// and a `busyPlaceholder` may ride along. These helpers read both shapes
// structurally so a migrated install reproduces its exact legacy copy while
// neutral installs keep today's neutral strings.

import { getOperator } from '../../lib/operators';
import type { OperatorProfile, OperatorsConfig } from '../../lib/operators';

export type GerundPair = { emoji: string; verb: string };
export type IdentityVocab = { default: string; pairs: GerundPair[] };

/** Universal built-in reasoning vocab — the neutral Hermes set. */
export const DEFAULT_REASONING_VOCAB: IdentityVocab = {
  default: '🧠',
  pairs: [
    { emoji: '💭', verb: 'Thinking' },
    { emoji: '🤔', verb: 'Pondering' },
    { emoji: '🔎', verb: 'Searching' },
    { emoji: '⚗️', verb: 'Synthesizing' },
    { emoji: '✍️', verb: 'Drafting' },
    { emoji: '🌀', verb: 'Spinning-up' },
  ],
};

type LooseChatCopy = {
  placeholder?: string | null;
  busyRow?: string | null;
  busyPlaceholder?: string | null;
  gerunds?: unknown;
} | null;

function chatCopyOf(operator: OperatorProfile | null | undefined): LooseChatCopy {
  return (operator?.chat ?? null) as LooseChatCopy;
}

function cleanText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function cleanPairs(value: unknown): GerundPair[] {
  if (!Array.isArray(value)) return [];
  const pairs: GerundPair[] = [];
  for (const entry of value) {
    const emoji = cleanText((entry as { emoji?: unknown } | null)?.emoji);
    const verb = cleanText((entry as { verb?: unknown } | null)?.verb);
    if (emoji && verb) pairs.push({ emoji, verb });
  }
  return pairs;
}

/** Case-insensitive operator match by canonical id or display label. */
export function findOperatorByLabelOrId(
  config: OperatorsConfig,
  value: unknown
): OperatorProfile | null {
  const key = String(value ?? '').trim().toLowerCase();
  if (!key) return null;
  return (
    getOperator(config, key) ??
    config.operators.find((operator) => operator.label.trim().toLowerCase() === key) ??
    null
  );
}

/**
 * An operator's own identity vocab. Requires the full electron-shaped
 * `gerunds: { default, pairs }` (identity mark plus rotation pairs); bare
 * pair arrays (the renderer-mirror default) and absent chat copy resolve to
 * null so those lanes keep the universal anonymous vocab.
 */
export function operatorIdentityVocab(
  operator: OperatorProfile | null | undefined
): IdentityVocab | null {
  const gerunds = chatCopyOf(operator)?.gerunds;
  if (!gerunds || typeof gerunds !== 'object' || Array.isArray(gerunds)) return null;
  const mark = cleanText((gerunds as { default?: unknown }).default);
  const pairs = cleanPairs((gerunds as { pairs?: unknown }).pairs);
  if (!mark || pairs.length === 0) return null;
  return { default: mark, pairs };
}

/** Identity mark shown in chat chrome (null when the operator has none). */
export function operatorEmoji(operator: OperatorProfile | null | undefined): string | null {
  return cleanText(operator?.emoji);
}

/** Idle composer placeholder owned by the operator, if any. */
export function operatorPlaceholder(operator: OperatorProfile | null | undefined): string | null {
  return cleanText(chatCopyOf(operator)?.placeholder);
}

/** Busy row copy owned by the operator, if any. */
export function operatorBusyRow(operator: OperatorProfile | null | undefined): string | null {
  return cleanText(chatCopyOf(operator)?.busyRow);
}

/** Busy composer placeholder owned by the operator, if any. */
export function operatorBusyPlaceholder(
  operator: OperatorProfile | null | undefined
): string | null {
  return cleanText(chatCopyOf(operator)?.busyPlaceholder);
}
