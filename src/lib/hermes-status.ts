// Hermes renders a single-line status indicator above the prompt that
// reports the model, the current context-window usage, an ASCII bar, and
// elapsed timers. Example, taken verbatim from a status test fixture:
//
//   ⚕ gpt-5.5 │ 19.4K/600K │ [░░░░░░░░░░] 3% │ 31m │ ⏲ 3s
//
// We parse `used/limit` and the `%` token to surface the live context
// window and percent-left in the chat header. Personal Hermes lanes
// (Rook/King) inherit this format because they ride the same Ace.

export type HermesContextStatus = {
  usedTokens: number;
  usedLabel: string;
  limitTokens: number;
  limitLabel: string;
  percentUsed: number;
  percentLeft: number;
};

const SUFFIX_FACTORS: Record<string, number> = {
  '': 1,
  K: 1_000,
  M: 1_000_000,
  B: 1_000_000_000,
};

function toTokens(label: string): number | null {
  const match = /^([0-9]+(?:\.[0-9]+)?)([KMB]?)$/i.exec(label.trim());
  if (!match) return null;
  const factor = SUFFIX_FACTORS[match[2].toUpperCase()];
  if (factor === undefined) return null;
  return Math.round(Number(match[1]) * factor);
}

type TranscriptTokenSummary = { used: number; haveData: boolean };

function formatTokens(value: number): string {
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k`;
  return String(value);
}

// Decides what to render on the context pill, in priority order:
//   1. Live Hermes screen status line ⇒ "Context 600K · 97% left"
//   2. Transcript token totals        ⇒ "Context · ~Xk used"
//   3. Honest unknown fallback        ⇒ "Context · unknown · no token telemetry"
//
// Never invents a percent-left when we don't know the window limit.
export function buildContextPillCopy({
  hermesStatus,
  transcript,
}: {
  hermesStatus: HermesContextStatus | null;
  transcript: TranscriptTokenSummary;
}): { primary: string; secondary: string; title: string } {
  if (hermesStatus) {
    return {
      primary: `Context ${hermesStatus.limitLabel}`,
      secondary: `${hermesStatus.percentLeft}% left`,
      title: `Context window: ${hermesStatus.usedLabel} of ${hermesStatus.limitLabel} used (${hermesStatus.percentUsed}%)`,
    };
  }
  if (transcript.haveData) {
    return {
      primary: `Context · ~${formatTokens(transcript.used)} tokens`,
      secondary: 'used',
      title: `Context window usage: ${transcript.used} tokens`,
    };
  }
  return {
    primary: 'Context · unknown',
    secondary: 'no token telemetry',
    title: 'Context window: no usage data reported by this agent',
  };
}

// Iterate the screen line-by-line and pick the last status line we can
// confidently parse — Hermes redraws the bar on every input, so the most
// recent occurrence is the freshest snapshot of the conversation.
export function parseHermesStatusLine(screen: string): HermesContextStatus | null {
  if (!screen) return null;
  const re = /([0-9]+(?:\.[0-9]+)?[KMB]?)\s*\/\s*([0-9]+(?:\.[0-9]+)?[KMB]?)[\s\S]*?([0-9]+(?:\.[0-9]+)?)\s*%/g;
  let last: HermesContextStatus | null = null;
  for (const line of screen.split(/\r?\n/)) {
    re.lastIndex = 0;
    const match = re.exec(line);
    if (!match) continue;
    const used = toTokens(match[1]);
    const limit = toTokens(match[2]);
    const percentUsed = Number(match[3]);
    if (used === null || limit === null || !Number.isFinite(percentUsed)) continue;
    if (limit <= 0) continue;
    const clamped = Math.max(0, Math.min(100, percentUsed));
    last = {
      usedTokens: used,
      usedLabel: match[1],
      limitTokens: limit,
      limitLabel: match[2],
      percentUsed: clamped,
      percentLeft: Math.max(0, 100 - clamped),
    };
  }
  return last;
}
