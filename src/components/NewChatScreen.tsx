import { useEffect, useState } from 'react';
import { ArrowLeft, MessageSquare, GitBranch, FolderOpen, Zap } from 'lucide-react';
import { cn } from '../lib/utils';
import { useApp } from '../store';
import { landingView, useIsMobileViewport } from '../runtime/use-mobile-viewport';
import { AgentPickerGrid } from './AgentPickerGrid';
import { InstallAgentDialog } from './InstallAgentDialog';
import { Checkbox } from './ui/checkbox';
import {
  createWorkspaceTask,
  createWorkspaceThread,
} from '../runtime/workspace-registry';
import type { AgentCatalogScope } from '../runtime/agent-registry';
import { deriveFromPrompt, randomSlug } from '../lib/chat-name';
import type { AgentCatalogEntry, AgentId } from '../lib/types';

type Kind = 'thread' | 'task';

export function NewChatScreen() {
  const {
    activeWorkspace, activeWorkspaceId, openTask, setView,
    pendingChatKind, setPendingChatKind,
  } = useApp();
  const isMobile = useIsMobileViewport();
  const [kind, setKind] = useState<Kind>(pendingChatKind ?? 'thread');
  useEffect(() => {
    if (pendingChatKind) setPendingChatKind(null);
    // Only consume once on mount — subsequent kind toggles should be user-driven.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [slug] = useState(() => randomSlug());
  const [name, setName] = useState(() => slug);
  const [nameManuallyEdited, setNameManuallyEdited] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [autoApprove, setAutoApprove] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [installAgent, setInstallAgent] = useState<AgentCatalogEntry | null>(null);

  const catalogScope: AgentCatalogScope | undefined = activeWorkspace?.isRemote
    ? { sshHost: activeWorkspace.sshHost, agentUser: activeWorkspace.agentUser }
    : undefined;

  const effectiveAutoApprove = autoApprove;
  const canPick = !busy && name.trim().length > 0;

  const handlePromptChange = (value: string) => {
    setPrompt(value);
    if (!nameManuallyEdited) {
      setName(deriveFromPrompt(value) ?? slug);
    }
  };

  const handleNameChange = (value: string) => {
    setName(value);
    setNameManuallyEdited(true);
    setError(null);
  };

  const handleSelect = async (agent: AgentCatalogEntry) => {
    if (!activeWorkspaceId || !canPick) return;
    setBusy(true);
    setError(null);
    try {
      const input = {
        name: name.trim(),
        agent: agent.id as AgentId,
        prompt: prompt.trim() || undefined,
        autoApproveEnabled: effectiveAutoApprove,
      };
      const result =
        kind === 'task'
          ? await createWorkspaceTask(activeWorkspaceId, input)
          : await createWorkspaceThread(activeWorkspaceId, input);
      openTask(activeWorkspaceId, result.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create.');
      setBusy(false);
    }
  };

  if (!activeWorkspace) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
        Select a workspace first.
      </div>
    );
  }

  return (
    <div className="relative flex h-full flex-col overflow-y-auto">
      {!isMobile && (
        <button
          type="button"
          onClick={() => setView(landingView())}
          className="absolute left-6 top-6 z-10 flex h-8 items-center gap-1.5 rounded-lg px-2 text-xs text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground"
          aria-label="Back"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back
        </button>
      )}

      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 pb-12 pt-6 sm:gap-10 sm:px-8 sm:pb-16 sm:pt-20">
        <div className="flex flex-col items-center gap-3 text-center">
          <button
            type="button"
            onClick={() => setView(landingView())}
            className="inline-flex items-center gap-1.5 rounded-full border border-white/[0.08] bg-white/[0.03] px-3 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:border-white/15 hover:text-foreground"
            title={`Back to ${activeWorkspace.name}`}
          >
            <FolderOpen className="h-3 w-3" />
            {activeWorkspace.name}
          </button>
          <h1 className="font-display text-2xl font-semibold tracking-tight sm:text-4xl">
            Start something new
          </h1>
          <p className="text-sm text-muted-foreground">
            Pick a shape, name it, and hand it to an agent.
          </p>
        </div>

        <div className="inline-flex self-center rounded-full border border-white/[0.08] bg-white/[0.03] p-1">
          <KindPill
            active={kind === 'thread'}
            onClick={() => setKind('thread')}
            icon={<MessageSquare className="h-3.5 w-3.5" />}
            label="Thread"
            hint="Direct chat in the repo"
          />
          <KindPill
            active={kind === 'task'}
            onClick={() => setKind('task')}
            icon={<GitBranch className="h-3.5 w-3.5" />}
            label="Task"
            hint="New worktree branch"
          />
        </div>

        <div className="flex flex-col gap-4">
          <div>
            <label className="mb-1.5 flex items-baseline justify-between text-xs font-medium text-foreground">
              <span>Name</span>
              <span className="text-[10px] font-normal text-muted-foreground/60">
                {nameManuallyEdited ? 'edited' : 'auto'}
              </span>
            </label>
            <input
              value={name}
              onChange={(e) => handleNameChange(e.target.value)}
              placeholder={slug}
              className="h-11 w-full rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 text-sm text-foreground placeholder:text-muted-foreground focus:border-white/20 focus:outline-none focus:ring-0"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-foreground">
              Initial prompt <span className="text-muted-foreground/60">(optional)</span>
            </label>
            <textarea
              autoFocus
              rows={3}
              value={prompt}
              onChange={(e) => handlePromptChange(e.target.value)}
              placeholder={
                kind === 'task'
                  ? 'What should the agent do?'
                  : 'What do you want to discuss?'
              }
              className="w-full resize-none rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:border-white/20 focus:outline-none focus:ring-0"
            />
          </div>
          {error && (
            <div className="rounded-lg border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
              {error}
            </div>
          )}

          <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 py-2.5 transition-colors hover:border-white/15 hover:bg-white/[0.05]">
            <Checkbox
              checked={effectiveAutoApprove}
              onCheckedChange={(checked) => setAutoApprove(checked === true)}
              className="mt-0.5"
            />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                <Zap className="h-3 w-3" />
                Auto-approve agent actions
              </div>
              <div className="text-[11px] text-muted-foreground">
                Passes --dangerously-skip-permissions. Agents run without asking for each edit or command.
              </div>
            </div>
          </label>
        </div>

        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/70">
              Pick an agent
            </span>
            <span className="h-px flex-1 bg-white/[0.06]" />
          </div>
          <AgentPickerGrid
            onSelect={handleSelect}
            onMissingSelect={(agent) => setInstallAgent(agent)}
            onReinstall={(agent) => setInstallAgent(agent)}
            scope={catalogScope}
            disabled={!canPick}
            hint={busy ? 'Creating…' : undefined}
          />
        </div>
      </div>

      {installAgent && (
        <InstallAgentDialog
          agent={installAgent}
          scope={catalogScope}
          onClose={() => setInstallAgent(null)}
        />
      )}
    </div>
  );
}

function KindPill({
  active,
  onClick,
  icon,
  label,
  hint,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  hint: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex items-center gap-2 rounded-full px-4 py-1.5 text-xs font-medium transition-colors',
        active
          ? 'bg-white/[0.08] text-foreground shadow-[inset_0_0_0_1px_hsl(0_0%_100%/0.06)]'
          : 'text-muted-foreground hover:text-foreground'
      )}
      title={hint}
    >
      {icon}
      {label}
    </button>
  );
}
