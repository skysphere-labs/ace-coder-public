import { useLayoutEffect, useRef } from 'react';
import { ArchiveRestore, CheckCircle2, ChevronUp, Loader2 } from 'lucide-react';
import type { TranscriptEntry, StreamState } from '../../lib/ace-api';
import type { TranscriptCompactStatus } from '../../runtime/transcript-registry';
import { Button } from '../ui/button';
import { renderEntry } from './entries/render';

function streamStatusLabel(streamState: StreamState, compactStatus: TranscriptCompactStatus, hasPostCompactUser: boolean) {
  if (streamState === 'busy' || streamState === 'awaiting-approval') return 'working';
  if (streamState === 'booting') return 'queued';
  if (streamState === 'interrupted') return 'interrupted';
  if (streamState === 'error') return 'error';
  if (compactStatus.state === 'recovered') return 'ready';
  if (hasPostCompactUser) return 'sent';
  return 'reviving';
}

function CompactionRevivalNotice({
  compactStatus,
  streamState,
  hasPostCompactUser,
}: {
  compactStatus: TranscriptCompactStatus;
  streamState: StreamState;
  hasPostCompactUser: boolean;
}) {
  const recovered = compactStatus.state === 'recovered';
  const statusLabel = streamStatusLabel(streamState, compactStatus, hasPostCompactUser);
  const Icon = recovered ? CheckCircle2 : ArchiveRestore;
  return (
    <div
      role="status"
      aria-label={`Hermes auto-compacted prior context; revival is ${statusLabel}`}
      className="rounded-xl border border-amber-300/25 bg-amber-300/[0.075] px-3.5 py-3 text-amber-50 shadow-sm shadow-black/20"
    >
      <div className="flex min-w-0 items-start gap-3">
        <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-amber-200/20 bg-black/25 text-amber-100">
          <Icon className="h-4 w-4" strokeWidth={2.25} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <div className="min-w-0 break-words text-[13px] font-semibold leading-snug">
              Hermes auto-compacted this chat
            </div>
            <span className="shrink-0 rounded-full border border-amber-200/20 bg-black/25 px-2 py-0.5 text-[10.5px] font-medium uppercase tracking-wide text-amber-100/85">
              {statusLabel}
            </span>
          </div>
          <div className="mt-1 break-words text-[12px] leading-relaxed text-amber-50/80">
            Prior context was summarized.{' '}
            {recovered
              ? 'Continuation is ready from the compacted context.'
              : 'Reviving from compacted context so the next turn continues after the summary.'}
          </div>
        </div>
      </div>
    </div>
  );
}

export function TranscriptList({
  streamId,
  entries,
  streamState,
  agentLabel = null,
  hasOlder,
  loadingOlder,
  olderError,
  onLoadOlder,
  compactStatus = null,
}: {
  streamId: string;
  entries: TranscriptEntry[];
  streamState: StreamState;
  agentLabel?: string | null;
  hasOlder: boolean;
  loadingOlder: boolean;
  olderError: string | null;
  onLoadOlder: () => void;
  compactStatus?: TranscriptCompactStatus | null;
}) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const stickyRef = useRef(true);
  const lastStreamIdRef = useRef(streamId);
  const prevLayoutRef = useRef({ firstId: null as number | null, scrollHeight: 0 });

  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const streamChanged = lastStreamIdRef.current !== streamId;
    if (streamChanged) {
      lastStreamIdRef.current = streamId;
      stickyRef.current = true;
    }
    const firstId = entries[0]?.id ?? null;
    const prev = prevLayoutRef.current;
    const prepended = !streamChanged && firstId !== null && prev.firstId !== null && firstId < prev.firstId;
    if (stickyRef.current || streamChanged) {
      el.scrollTop = el.scrollHeight;
    } else if (prepended) {
      el.scrollTop += el.scrollHeight - prev.scrollHeight;
    }
    prevLayoutRef.current = { firstId, scrollHeight: el.scrollHeight };
  }, [streamId, entries]);

  const onScroll = () => {
    const el = scrollerRef.current;
    if (!el) return;
    // 80px keeps the stick decision stable through touch momentum bounce —
    // 40px made a small overscroll on the phone silently unpin the bottom.
    stickyRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const content = contentRef.current;
    if (!scroller || !content || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (stickyRef.current) scroller.scrollTop = scroller.scrollHeight;
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  const showOlderControl = hasOlder || loadingOlder || !!olderError;
  const hasPostCompactUser =
    compactStatus?.at !== null &&
    compactStatus?.at !== undefined &&
    entries.some((entry) => entry.role === 'user' && entry.tAt >= compactStatus.at!);

  return (
    <div
      ref={scrollerRef}
      onScroll={onScroll}
      // touch-action:pan-y lets the browser own vertical scrolling natively
      // (momentum stays smooth) while horizontal pointer moves still reach the
      // swipe system; overscroll containment stops the pull gesture from
      // rubber-banding the whole PWA shell.
      className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto [-webkit-overflow-scrolling:touch] [overscroll-behavior-y:contain] [touch-action:pan-y]"
    >
      <div ref={contentRef} className="mx-auto flex w-full min-w-0 max-w-3xl flex-col gap-5 px-4 pb-6 pt-8 sm:px-6 landscape:gap-4 landscape:pt-4">
        {showOlderControl && (
          <div className="flex flex-col items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 px-2.5 text-[11px]"
              onClick={onLoadOlder}
              disabled={loadingOlder || !hasOlder}
            >
              {loadingOlder ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <ChevronUp className="h-3 w-3" />
              )}
              {loadingOlder ? 'Loading older messages' : 'Show older messages'}
            </Button>
            {olderError && (
              <div className="max-w-full break-words text-center text-[11px] text-destructive">
                {olderError}
              </div>
            )}
          </div>
        )}
        {compactStatus && (
          <CompactionRevivalNotice
            compactStatus={compactStatus}
            streamState={streamState}
            hasPostCompactUser={hasPostCompactUser}
          />
        )}
        {entries.map((e) => renderEntry(e, streamId, streamState, agentLabel))}
      </div>
    </div>
  );
}
