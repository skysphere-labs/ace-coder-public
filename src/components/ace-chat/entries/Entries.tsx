import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, Brain, ChevronRight, Inbox, Send, Sparkles } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { MarkdownText } from '../render';
import { formatHermesReadableText } from '../hermes-chat-format';
import type { StreamState } from '../../../lib/ace-api';
import { aceApi } from '../../../lib/ace-api';
import type { OperatorsConfig } from '../../../lib/operators';
import { useOperators } from '../../../runtime/operators-registry';
import { ToolWidget } from '../widgets/ToolWidgets';
import {
  DEFAULT_REASONING_VOCAB,
  findOperatorByLabelOrId,
  operatorIdentityVocab,
} from '../operator-copy';
import type { GerundPair, IdentityVocab } from '../operator-copy';
import { isVisibleSystemInfoText } from './system-info-filter';

export function UserEntry({ text }: { text: string }) {
  return (
    <div className="group flex min-w-0 flex-col items-end gap-1">
      <div
        className="ace-chat-user-bubble min-w-0 max-w-[85%] overflow-hidden whitespace-pre-wrap break-words rounded-2xl px-4 py-2 text-[15px] leading-[1.5] md:text-[13.5px]"
      >
        {text}
      </div>
      <div className="ace-chat-author-label ace-chat-author-label-user pr-1 text-[11px] uppercase tracking-[0.14em] text-muted-foreground/80">
        Chief
      </div>
    </div>
  );
}

export function AgentEntry({
  text,
  lifecycle,
  agentLabel,
  tokens: _tokens,
  startedAt: _startedAt,
}: {
  text: string;
  lifecycle: 'open' | 'finished';
  agentLabel?: string | null;
  tokens?: number;
  startedAt?: number;
}) {
  void _tokens;
  void _startedAt;
  const formattedText = formatHermesReadableText(text);
  if (!formattedText) return null;
  return (
    <div className="group flex min-w-0 flex-col items-start gap-1">
      <div className="ace-chat-agent-bubble min-w-0 w-fit max-w-full overflow-hidden break-words rounded-2xl px-4 py-3 text-[14.5px] leading-[1.6] md:text-[14px] md:leading-[1.65]">
        <MarkdownText text={formattedText} streaming={lifecycle === 'open'} />
        {lifecycle === 'open' && (
          <span className="ace-chat-warm-bg ml-0.5 inline-block h-3 w-1 animate-pulse align-middle" />
        )}
      </div>
      {agentLabel && (
        <div className="ace-chat-author-label ace-chat-author-label-agent pl-1 text-[11px] uppercase tracking-[0.14em] text-muted-foreground/80">
          {agentLabel}
        </div>
      )}
    </div>
  );
}

type ReasoningIdentity = { vocab: IdentityVocab; operatorLabel: string | null };

// Resolve the reasoning vocab for an agent label via the operator registry.
// Operators carrying a full identity vocab (mark + rotation pairs, e.g. a
// migrated install's chess sets) personalize the labels; everything else —
// unknown labels and operators without their own vocab — keeps the universal
// built-in vocab with anonymous labels.
function reasoningVocabFor(
  config: OperatorsConfig,
  agentLabel: string | null | undefined
): ReasoningIdentity {
  const operator = findOperatorByLabelOrId(config, agentLabel);
  const vocab = operatorIdentityVocab(operator);
  if (operator && vocab) return { vocab, operatorLabel: operator.label };
  return { vocab: DEFAULT_REASONING_VOCAB, operatorLabel: null };
}

function reasoningLabelFor(operatorLabel: string | null, streaming: boolean, pair: GerundPair, vocab: IdentityVocab) {
  if (operatorLabel) {
    return streaming ? `${pair.emoji} ${operatorLabel} ${pair.verb}` : `${vocab.default} ${operatorLabel} — summary`;
  }
  return streaming ? `${pair.emoji} ${pair.verb}` : `${vocab.default} Thought summary`;
}

function previewSentence(text: string, fallback?: string) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return fallback || '';
  const firstSentence = normalized.match(/^.*?[.!?](?:\s|$)/)?.[0]?.trim() || normalized;
  return firstSentence.slice(0, 140);
}

function formatSeconds(ms: number) {
  return `${Math.max(0, Math.floor(ms / 1000))}s`;
}

function ElapsedSpan({
  startedAt,
  endedAt,
  streaming,
}: {
  startedAt?: number;
  endedAt?: number;
  streaming: boolean;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!streaming) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [streaming]);
  const start = startedAt ?? now;
  const end = streaming ? now : endedAt ?? now;
  return <span>{formatSeconds(end - start)}</span>;
}

export function ReasoningEntry({
  text,
  subject,
  lifecycle = 'finished',
  agentLabel,
  tokens,
  startedAt,
  endedAt,
}: {
  text: string;
  subject?: string;
  lifecycle?: 'open' | 'finished';
  agentLabel?: string | null;
  tokens?: number;
  startedAt?: number;
  endedAt?: number;
}) {
  const streaming = lifecycle === 'open';
  const [open, setOpen] = useState(false);
  const [userCollapsed, setUserCollapsed] = useState(false);
  const operators = useOperators();
  const { vocab: gerunds, operatorLabel } = useMemo(
    () => reasoningVocabFor(operators, agentLabel),
    [agentLabel, operators]
  );
  const [pairIndex, setPairIndex] = useState(0);
  useEffect(() => {
    if (!streaming) return;
    const id = window.setInterval(() => {
      setPairIndex((idx) => (idx + 1) % gerunds.pairs.length);
    }, 4500);
    return () => window.clearInterval(id);
  }, [gerunds.pairs.length, streaming]);
  const expanded = streaming ? !userCollapsed : open;
  const preview = previewSentence(text, subject);
  const label = reasoningLabelFor(operatorLabel, streaming, gerunds.pairs[pairIndex] || gerunds.pairs[0], gerunds);
  const toggle = () => {
    if (streaming) {
      setUserCollapsed((collapsed) => !collapsed);
      return;
    }
    setOpen((o) => !o);
  };

  return (
    <div
      className={cn(
        'rounded-xl border text-[13px]',
        streaming
          ? 'ace-chat-reasoning-warm bg-white/[0.015]'
          : 'border-white/[0.04] bg-white/[0.015]'
      )}
    >
      <button
        type="button"
        onClick={toggle}
        className="ace-chat-reasoning-header flex w-full min-w-0 items-start gap-2 px-3 py-2 text-left"
      >
        <ChevronRight
          className={cn(
            'mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform',
            expanded && 'rotate-90'
          )}
        />
        <Brain
          className={cn(
            'mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground',
            streaming && 'ace-chat-warm-text animate-pulse'
          )}
        />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
            <span
              className={cn(
                'shrink-0 text-[10.5px] font-semibold uppercase tracking-[0.16em]',
                streaming ? 'ace-chat-warm-text' : 'text-muted-foreground/70'
              )}
            >
              {label}
            </span>
            <span className="shrink-0 text-[11px] text-muted-foreground/60">
              <ElapsedSpan startedAt={startedAt} endedAt={endedAt} streaming={streaming} />
              {tokens !== undefined && <> · {tokens} tok</>}
            </span>
          </span>
          <span className="min-w-0 truncate text-[12.5px] leading-[1.45] text-muted-foreground/85">
            {preview || 'Reasoning'}
          </span>
        </span>
        {streaming && (
          <span className="ace-chat-warm-bg mt-1.5 h-1.5 w-1.5 shrink-0 animate-pulse rounded-full" />
        )}
      </button>
      {expanded && (
        <div className="border-t border-white/[0.04] px-3 py-2">
          {subject && <div className="mb-1 text-[12px] font-medium text-foreground/85">{subject}</div>}
          <div className="text-[12.5px] leading-[1.55] text-muted-foreground/90">
            <MarkdownText text={text} streaming={streaming} />
            {streaming && (
              <span className="ace-chat-warm-bg ml-0.5 inline-block h-3 w-1 animate-pulse align-middle" />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function CommunicationEntry({
  direction,
  command,
  body,
  peerLabel,
  peerAgent,
  peerStreamId,
  redacted,
  truncated,
}: {
  direction: 'sent' | 'received';
  command: string;
  body: string;
  peerLabel?: string;
  peerAgent?: string;
  peerStreamId?: string;
  redacted?: boolean;
  truncated?: boolean;
}) {
  const Icon = direction === 'sent' ? Send : Inbox;
  const peerName = peerLabel || peerAgent || peerStreamId || 'agent';
  const tone =
    direction === 'sent'
      ? 'border-cyan-300/15 bg-cyan-400/[0.035]'
      : 'border-emerald-300/15 bg-emerald-400/[0.035]';
  const iconTone = direction === 'sent' ? 'text-cyan-200/80' : 'text-emerald-200/80';
  return (
    <div className={cn('rounded-xl border p-3 text-[12px]', tone)}>
      <div className="flex min-w-0 items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Icon className={cn('h-3.5 w-3.5 shrink-0', iconTone)} />
          <span className="shrink-0 font-semibold uppercase tracking-wider text-foreground/80">
            {direction === 'sent' ? 'Sent' : 'Received'}
          </span>
          <span className="truncate rounded-md border border-white/[0.06] bg-black/20 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
            {command || 'message'}
          </span>
        </div>
        {(redacted || truncated) && (
          <span className="shrink-0 rounded-md border border-amber-300/15 bg-amber-400/[0.06] px-1.5 py-0.5 text-[10.5px] uppercase tracking-wider text-amber-100/80">
            {truncated ? 'Truncated' : 'Redacted'}
          </span>
        )}
      </div>
      <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-muted-foreground">
        <span className="max-w-full truncate text-foreground/80">{peerName}</span>
        {peerAgent && peerAgent !== peerName && <span>{peerAgent}</span>}
        {peerStreamId && <span className="max-w-full truncate font-mono">{peerStreamId}</span>}
      </div>
      <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-black/25 p-2.5 font-mono text-[11.5px] leading-[1.55] text-foreground/85">
        {body}
      </pre>
    </div>
  );
}

export function SystemEntry({ subtype, text }: { subtype: string; text?: string }) {
  if (subtype === 'task_started' || subtype === 'turn_finished' || subtype === 'session_start') return null;
  if (subtype === 'error') {
    return (
      <div className="flex items-start gap-2 rounded-xl border border-rose-400/20 bg-rose-500/[0.06] p-3 text-[12px] text-rose-200">
        <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <div>{text || 'Error'}</div>
      </div>
    );
  }
  if (!text) return null;
  if (subtype === 'info') {
    if (!isVisibleSystemInfoText(text)) return null;
    return (
      <div className="ace-chat-status-breadcrumb flex items-start gap-2 rounded-lg border border-amber-300/15 bg-amber-300/[0.045] px-3 py-2 text-[12px] leading-[1.45] text-amber-50/85">
        <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-200/80" />
        <div className="min-w-0 break-words">{text}</div>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 rounded-md border border-white/[0.05] bg-white/[0.02] px-3 py-1.5 text-[11.5px] text-muted-foreground">
      <Sparkles className="h-3 w-3" />
      {text}
    </div>
  );
}

export function ToolEntry({
  name,
  args,
  result,
  status,
  lifecycle,
}: {
  name: string;
  args: unknown;
  result: unknown;
  status: 'running' | 'ok' | 'error' | 'denied' | 'canceled';
  lifecycle: 'open' | 'finished';
}) {
  return <ToolWidget name={name} args={args} result={result} status={status} lifecycle={lifecycle} />;
}

// Approval entry couples the transcript (static prompt text) with the live
// Ace state plane (buttons enable only while state === awaiting-approval).
export function ApprovalEntry({
  streamId,
  prompt,
  context,
  status,
  streamState,
}: {
  streamId: string;
  prompt: string;
  context: string;
  status: 'pending' | 'approved' | 'denied';
  streamState: StreamState;
}) {
  const [busy, setBusy] = useState(false);
  const disabled = busy || status !== 'pending' || streamState !== 'awaiting-approval';
  const run = async (answer: 'yes' | 'no') => {
    setBusy(true);
    try {
      await aceApi.streams.approve(streamId, answer);
    } finally {
      setBusy(false);
    }
  };
  const tone =
    status === 'approved'
      ? 'border-emerald-400/25 bg-emerald-500/[0.04]'
      : status === 'denied'
      ? 'border-rose-400/25 bg-rose-500/[0.04]'
      : 'border-amber-400/25 bg-amber-500/[0.04]';
  const label =
    status === 'approved'
      ? 'Approved'
      : status === 'denied'
      ? 'Denied'
      : 'Approval requested';
  return (
    <div className={cn('rounded-xl border p-3', tone)}>
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-amber-200/90">
          {label}
        </span>
      </div>
      <div className="mt-1 text-[12.5px] text-foreground/85">{prompt}</div>
      {context && (
        <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-black/30 p-2 font-mono text-[11px] text-foreground/85">
          {context}
        </pre>
      )}
      {status === 'pending' && (
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            disabled={disabled}
            onClick={() => run('yes')}
            className="inline-flex items-center gap-1 rounded-md bg-emerald-500/10 px-3 py-1.5 text-[12px] font-medium text-emerald-200 hover:bg-emerald-500/20 disabled:opacity-45"
          >
            Allow
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => run('no')}
            className="inline-flex items-center gap-1 rounded-md border border-white/[0.08] px-3 py-1.5 text-[12px] font-medium text-foreground hover:bg-white/[0.04] disabled:opacity-45"
          >
            Deny
          </button>
        </div>
      )}
    </div>
  );
}
