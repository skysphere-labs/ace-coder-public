import { useEffect, useRef, useState } from 'react';
import { Gauge } from 'lucide-react';
import { aceApi, type TranscriptEntry } from '../../lib/ace-api';
import {
  buildContextPillCopy,
  parseHermesStatusLine,
  type HermesContextStatus,
} from '../../lib/hermes-status';
import { cn } from '../../lib/utils';

// Aggregates the most reliable token signal we have — `tokens.total` (or
// input+output) attached to agent transcript entries. This is a fallback
// for agents whose Ace does not draw a status bar with usage info; for
// Hermes (incl. Rook/King) we always prefer the live status line.
function summarizeTranscriptTokens(entries: TranscriptEntry[]): { used: number; haveData: boolean } {
  let used = 0;
  let haveData = false;
  for (const entry of entries) {
    if (entry.role !== 'agent') continue;
    const tokens = entry.tokens;
    if (!tokens) continue;
    if (typeof tokens.total === 'number' && tokens.total > 0) {
      used = Math.max(used, tokens.total);
      haveData = true;
      continue;
    }
    const input = typeof tokens.input === 'number' ? tokens.input : 0;
    const output = typeof tokens.output === 'number' ? tokens.output : 0;
    if (input + output > 0) {
      used = Math.max(used, input + output);
      haveData = true;
    }
  }
  return { used, haveData };
}

// Hermes redraws its status bar in the terminal stream. Read the screen once
// on mount, then nudge reads from PTY activity instead of polling.
const STATUS_READ_DEBOUNCE_MS = 80;

function useHermesScreenStatus(streamId: string | null, isHermes: boolean): HermesContextStatus | null {
  const [status, setStatus] = useState<HermesContextStatus | null>(null);
  const lastRef = useRef<HermesContextStatus | null>(null);
  const timerRef = useRef<number | null>(null);
  useEffect(() => {
    if (!streamId || !isHermes) {
      // Reset is fine here — running inside an async tick out of the effect
      // body keeps React's set-state-in-effect rule happy.
      lastRef.current = null;
      const reset = () => setStatus(null);
      const handle = window.setTimeout(reset, 0);
      return () => window.clearTimeout(handle);
    }
    let cancelled = false;
    const readStatus = async () => {
      try {
        const snap = await aceApi.streams.readScreen(streamId);
        if (cancelled) return;
        const parsed = snap?.text ? parseHermesStatusLine(snap.text) : null;
        const prev = lastRef.current;
        if (!parsed && !prev) return;
        if (
          parsed &&
          prev &&
          prev.usedTokens === parsed.usedTokens &&
          prev.limitTokens === parsed.limitTokens &&
          prev.percentUsed === parsed.percentUsed
        ) {
          return;
        }
        lastRef.current = parsed;
        setStatus(parsed);
      } catch {
        // readScreen can fail before the PTY is attached. The next terminal
        // byte will schedule another read.
      }
    };
    const scheduleRead = () => {
      if (timerRef.current !== null) return;
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        void readStatus();
      }, STATUS_READ_DEBOUNCE_MS);
    };
    void readStatus();
    const offData = aceApi.core.onPtyData(({ id }) => {
      if (id === streamId) scheduleRead();
    });
    return () => {
      cancelled = true;
      offData();
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [streamId, isHermes]);
  return status;
}

export function ContextStatusPill({
  entries,
  streamId = null,
  agent = null,
  className,
}: {
  entries: TranscriptEntry[];
  streamId?: string | null;
  agent?: string | null;
  className?: string;
}) {
  const isHermes = agent === 'hermes';
  const hermesStatus = useHermesScreenStatus(streamId, isHermes);
  const transcript = summarizeTranscriptTokens(entries);
  const copy = buildContextPillCopy({ hermesStatus, transcript });
  return (
    <div
      className={cn(
        'ace-chat-context-pill inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium',
        className
      )}
      title={copy.title}
    >
      <Gauge className="h-3 w-3" strokeWidth={2.25} />
      <span>{copy.primary}</span>
      <span className="text-foreground/55">· {copy.secondary}</span>
    </div>
  );
}
