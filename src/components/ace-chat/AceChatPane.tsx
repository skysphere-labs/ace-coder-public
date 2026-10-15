import { useEffect, useRef, useState } from 'react';
import { MessageSquare } from 'lucide-react';
import { cn } from '../../lib/utils';
import { TerminalFeed } from '../TerminalFeed';
import { ViewToggle } from './ViewToggle';
import { Composer } from './Composer';
import { ContextStatusPill } from './ContextStatusPill';
import { TranscriptList } from './TranscriptList';
import { WarningsBanner } from './WarningsBanner';
import {
  attachTranscript,
  loadOlderTranscript,
  useChatAvailable,
  useTranscript,
} from '../../runtime/transcript-registry';
import { attachStreamState, useStreamState } from '../../runtime/stream-state-registry';
import { useCoreSelector } from '../../runtime/core-registry';
import { useAceChatMode, type AceChatAgent } from '../../runtime/ace-chat-mode-registry';
import { subscribeChatViewMode } from '../../runtime/ace-chat-view-mode';
import { aceApi, type StreamState } from '../../lib/ace-api';
import { DEFAULT_OPERATORS, getOperator } from '../../lib/operators';
import { agentMeta } from '../../lib/agent-style';
import type { OperatorProfile } from '../../lib/operators';
import { getWorkspacePersonalIdentity, type PersonalAgentIdentity } from '../../lib/personal-agents';
import { useOperators } from '../../runtime/operators-registry';
import { useIsMobileViewport } from '../../runtime/use-mobile-viewport';
import { useApp } from '../../store';
import {
  operatorBusyPlaceholder,
  operatorBusyRow,
  operatorEmoji,
  operatorPlaceholder,
} from './operator-copy';

type ProfilePayload = {
  id?: string;
  detect?: { agent?: string };
  slash?: string[];
  composer?: { placeholders?: { default?: string; busy?: string } };
};

type NativeChatIdentity = PersonalAgentIdentity | null;

function agentLabelFor(operator: OperatorProfile | null): string | null {
  return operator?.label ?? null;
}

function busyCopyFor(operator: OperatorProfile | null, fallback?: string) {
  if (!operator) {
    return {
      row: 'Agent is working…',
      placeholder: fallback ?? 'Agent is working… (Esc to interrupt)',
    };
  }
  const row = operatorBusyRow(operator) ?? fallback ?? `${operator.label} is working…`;
  return {
    row,
    placeholder: operatorBusyPlaceholder(operator) ?? row,
  };
}

function defaultPlaceholderFor(operator: OperatorProfile | null, fallback?: string) {
  if (!operator) return fallback;
  return operatorPlaceholder(operator) ?? `Message ${operator.label}`;
}

function identityMarkFor(operator: OperatorProfile | null) {
  return operatorEmoji(operator);
}

function stateLabelFor(state: StreamState) {
  if (state === 'busy') return 'working';
  if (state === 'awaiting-approval') return 'approval';
  if (state === 'booting') return 'booting';
  if (state === 'interrupted') return 'interrupted';
  return 'ready';
}

function stateDotClass(state: StreamState): string {
  if (state === 'busy') return 'ace-live bg-[hsl(var(--ace-accent))]';
  if (state === 'awaiting-approval') return 'ace-live bg-[hsl(var(--ace-danger))]';
  if (state === 'booting' || state === 'interrupted') return 'bg-foreground/30';
  return 'bg-[hsl(var(--ace-ok))]';
}

function LaneIdentityPill({
  operator,
  agentLabel,
  state,
}: {
  operator: OperatorProfile | null;
  agentLabel: string | null;
  state: StreamState;
}) {
  const label = agentLabel ?? 'Hermes';
  const mark = identityMarkFor(operator);
  const stateLabel = stateLabelFor(state);
  return (
    <div
      className="ace-chat-identity-pill inline-flex min-w-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-medium"
      title={`Messaging ${label} · ${stateLabel}`}
      aria-label={`Messaging ${label}, ${stateLabel}`}
    >
      {mark ? (
        <span aria-hidden className="shrink-0 text-[12px] leading-none">
          {mark}
        </span>
      ) : (
        <MessageSquare aria-hidden className="h-3 w-3 shrink-0" strokeWidth={2.25} />
      )}
      <span className="min-w-0 truncate">{label}</span>
      <span
        aria-hidden
        className={cn('h-1.5 w-1.5 shrink-0 rounded-full', stateDotClass(state))}
      />
      <span className="shrink-0 text-foreground/55">{stateLabel}</span>
    </div>
  );
}

// Terminal-first wrapper for agent tabs. CLI is the default and shows only the
// live PTY surface; chat mode adds the transcript plus live current-turn
// activity. The smart composer always rides along the bottom for local panes
// so attachments and Enter-send work without flipping into chat mode. Remote
// workspaces fall back to the bare terminal — the IPC required by the smart
// toolbar's attachment pipeline only exists in-process.
export function AceChatPane({
  streamId,
  agent,
  taskId,
  agentsChatIdentity = null,
  className,
}: {
  streamId: string;
  agent: AceChatAgent;
  taskId?: string | null;
  agentsChatIdentity?: PersonalAgentIdentity | null;
  className?: string;
}) {
  const available = useChatAvailable(streamId);
  const operators = useOperators();
  const workspaceContext = useCoreSelector((snap) => {
    const fallbackIdentity: NativeChatIdentity =
      agent === 'hermes' ? agentsChatIdentity ?? DEFAULT_OPERATORS.defaultOperatorId : null;
    if (!taskId) return { isRemoteWorkspace: false, identity: fallbackIdentity };
    for (const ws of snap.workspaces) {
      const all = [...ws.tasks, ...ws.archivedTasks];
      if (all.some((t) => t.id === taskId)) {
        return {
          isRemoteWorkspace: ws.isRemote === true,
          identity:
            agent === 'hermes'
              ? getWorkspacePersonalIdentity(ws, operators) ?? agentsChatIdentity ?? DEFAULT_OPERATORS.defaultOperatorId
              : null,
        };
      }
    }
    return { isRemoteWorkspace: false, identity: fallbackIdentity };
  });
  const isRemoteWorkspace = workspaceContext.isRemoteWorkspace;
  const isMobile = useIsMobileViewport();
  const { view } = useApp();
  const showToggle = (available || agent === 'hermes') && !isRemoteWorkspace;
  const showComposer = !isRemoteWorkspace;
  // On mobile the dedicated MobileTaskComposer is the single input surface, but
  // it only renders inside the workspace task view (MobileShell's TaskBottomBar
  // is gated on view === 'workspace'). On every other surface — notably the
  // Agents view where the user chats with the configured operators — nothing
  // else covers the pane, so the inline composer must stay or the lane has no
  // chat box at all.
  const mobileComposerCoversPane = isMobile && view === 'workspace';
  const showInlineComposer = showComposer && !mobileComposerCoversPane;
  const modeScopeKey = streamId;
  const [mode, setMode] = useAceChatMode(agent, modeScopeKey);
  const effectiveMode = showToggle ? mode : 'cli';
  const pendingReturnRef = useRef(false);
  const sawBusyRef = useRef(false);

  const transcript = useTranscript(streamId);
  const streamStatus = useStreamState(streamId);
  const [slashCommands, setSlashCommands] = useState<string[]>([]);
  const [placeholders, setPlaceholders] = useState<{ default?: string; busy?: string }>({});
  const identityOperator = getOperator(operators, workspaceContext.identity);
  const busyCopy = busyCopyFor(identityOperator, placeholders.busy);
  const defaultPlaceholder = defaultPlaceholderFor(identityOperator, placeholders.default);
  const agentLabel = agentLabelFor(identityOperator);
  const agentNameStreaming = transcript.entries.some(
    (entry) =>
      (entry.role === 'agent' || entry.role === 'reasoning' || entry.role === 'tool') &&
      entry.lifecycle === 'open'
  );
  const compactStatus =
    agent === 'hermes' && transcript.lastResetReason === 'compact'
      ? {
          reason: 'compact' as const,
          state: transcript.revivalState ?? 'reviving',
          at: transcript.lastCompactedAt,
        }
      : null;
  const terminalActive = effectiveMode === 'cli';

  useEffect(() => {
    if (!showComposer) return;
    const detachState = attachStreamState(streamId);
    const detachTranscript = attachTranscript(streamId);
    return () => {
      detachState();
      detachTranscript();
    };
  }, [streamId, showComposer]);

  useEffect(() => {
    if (!showComposer) return;
    let cancelled = false;
    const load = async () => {
      try {
        const res = await aceApi.streams.profiles();
        if (cancelled) return;
        const profiles = (res.profiles || []) as ProfilePayload[];
        const profile = profiles.find((p) => p.detect?.agent === agent);
        setSlashCommands(Array.isArray(profile?.slash) ? (profile?.slash as string[]) : []);
        setPlaceholders(profile?.composer?.placeholders ?? {});
      } catch {
        if (!cancelled) {
          setSlashCommands([]);
          setPlaceholders({});
        }
      }
    };
    void load();
    const off = aceApi.streams.onEvent((payload) => {
      if (payload?.event === 'profiles-reloaded') void load();
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [agent, showComposer]);

  useEffect(() => {
    const offMode = subscribeChatViewMode(streamId, (next) => {
      if (next === 'cli') {
        pendingReturnRef.current = true;
        sawBusyRef.current = false;
        setMode('cli');
      } else {
        pendingReturnRef.current = false;
        sawBusyRef.current = false;
        setMode('chat');
      }
    });
    const offEvent = aceApi.streams.onEvent((payload) => {
      if (payload?.event !== 'state-change') return;
      const p = payload.payload as { streamId?: string; to?: string };
      if (p?.streamId !== streamId || !p?.to || !pendingReturnRef.current) return;
      const settled = p.to === 'awaiting-input' || p.to === 'turn-complete';
      if (!settled) {
        sawBusyRef.current = true;
        return;
      }
      if (sawBusyRef.current) {
        pendingReturnRef.current = false;
        sawBusyRef.current = false;
        setMode('chat');
      }
    });
    return () => {
      offMode();
      offEvent();
    };
  }, [setMode, streamId]);

  return (
    <div
      data-ace-chat-pane-stream={streamId}
      data-ace-chat-pane-agent={agent}
      data-ace-chat-streaming={agentNameStreaming ? 'true' : 'false'}
      className={cn(
        'grid h-full min-h-0 min-w-0 overflow-hidden',
        // The 3-row template is header / content / composer. On mobile inside
        // a workspace task both header and composer are dropped, so the
        // content (the terminal) would auto-place into the `auto` header row
        // and collapse to its content height — squishing the PTY to a few
        // rows and leaving the 1fr row as a giant dead gap below the CLI.
        mobileComposerCoversPane
          ? 'grid-rows-[minmax(0,1fr)]'
          : 'grid-rows-[auto_minmax(0,1fr)_auto]',
        className
      )}
    >
      {/* On mobile inside a workspace task the MobileTaskComposer owns the
          CLI/chat toggle and the shell header shows the agent badge, so this
          in-pane header would duplicate the toggle and steal vertical space.
          Drop it there; keep it everywhere else (desktop + the Agents view). */}
      {!mobileComposerCoversPane && (
        <div
          className={cn(
            'flex items-center justify-between gap-3 px-3 py-1.5',
            !showToggle && agent !== 'hermes' && 'h-0 overflow-hidden p-0'
          )}
        >
          {agent === 'hermes' ? (
            <div className="flex min-w-0 items-center gap-2">
              <LaneIdentityPill
                operator={identityOperator}
                agentLabel={agentLabel}
                state={streamStatus.state}
              />
              <ContextStatusPill
                entries={transcript.entries}
                streamId={streamId}
                agent={agent}
              />
            </div>
          ) : showToggle ? (
            <LaneIdentityPill
              operator={null}
              agentLabel={agentMeta[agent]?.label ?? agent}
              state={streamStatus.state}
            />
          ) : (
            <span aria-hidden className="min-w-0" />
          )}
          {showToggle && (
            <ViewToggle
              kind={effectiveMode}
              onChange={(next) => {
                pendingReturnRef.current = false;
                sawBusyRef.current = false;
                setMode(next);
              }}
            />
          )}
        </div>
      )}
      <div className="relative min-h-0 min-w-0 overflow-hidden">
        <div
          aria-hidden={effectiveMode !== 'cli' ? true : undefined}
          className={cn('relative h-full min-w-0 w-full', effectiveMode !== 'cli' && 'hidden')}
        >
          <TerminalFeed
            streamId={streamId}
            active={terminalActive}
            interactive={effectiveMode === 'cli'}
          />
        </div>
        {showToggle && (
          <div className={cn('flex h-full min-w-0 w-full flex-col overflow-hidden', effectiveMode !== 'chat' && 'hidden')}>
            <TranscriptList
              streamId={streamId}
              entries={transcript.entries}
              streamState={streamStatus.state}
              agentLabel={agentLabel}
              hasOlder={transcript.hasOlder}
              loadingOlder={transcript.loadingOlder}
              olderError={transcript.olderError}
              onLoadOlder={() => void loadOlderTranscript(streamId)}
              compactStatus={compactStatus}
            />
            {transcript.warnings.length > 0 && (
              <div className="mx-auto w-full max-w-3xl px-6 pb-2">
                <WarningsBanner streamId={streamId} warnings={transcript.warnings} />
              </div>
            )}
          </div>
        )}
      </div>
      {showInlineComposer && (
        <div className="ace-composer-slot min-w-0 shrink-0">
          <Composer
            key={streamId}
            streamId={streamId}
            agent={agent}
            state={streamStatus.state}
            slashCommands={slashCommands}
            placeholders={{ ...placeholders, default: defaultPlaceholder, busy: busyCopy.placeholder }}
            taskId={taskId ?? null}
          />
        </div>
      )}
    </div>
  );
}
