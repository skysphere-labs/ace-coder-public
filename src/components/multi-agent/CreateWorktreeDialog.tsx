import { useEffect, useMemo, useState } from 'react';
import { X, GitBranch, AlertCircle } from 'lucide-react';
import { cn } from '../../lib/utils';
import { agentMeta } from '../../lib/agent-style';
import AgentLogo from '../ProviderGlyph';
import { Checkbox } from '../ui/checkbox';
import { useAgentCatalog } from '../../runtime/agent-registry';

interface CreateWorktreeDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onAdd: (data: { name: string; agent: string; branch: string; reviewMode: boolean }) => void;
  defaultBranch?: string;
  existingNames?: string[];
}
export default function CreateWorktreeDialog({
  isOpen,
  onClose,
  onAdd,
  defaultBranch = 'main',
  existingNames = [],
}: CreateWorktreeDialogProps) {
  if (!isOpen) return null;

  return (
    <CreateWorktreeDialogContent
      defaultBranch={defaultBranch}
      existingNames={existingNames}
      onAdd={onAdd}
      onClose={onClose}
    />
  );
}

function CreateWorktreeDialogContent({
  onClose,
  onAdd,
  defaultBranch,
  existingNames,
}: {
  onClose: () => void;
  onAdd: CreateWorktreeDialogProps['onAdd'];
  defaultBranch: string;
  existingNames: string[];
}) {
  const [name, setName] = useState('');
  const agentOptions = useAgentCatalog();
  const defaultAgent = useMemo(
    () => agentOptions.find((entry) => entry.launchable)?.id ?? agentOptions[0]?.id ?? 'claude',
    [agentOptions]
  );
  const [selectedAgent, setSelectedAgent] = useState<string>('claude');
  const [branch, setBranch] = useState(defaultBranch);
  const [reviewMode, setReviewMode] = useState(false);
  const selectedAgentOption = agentOptions.find((agent) => agent.id === selectedAgent) ?? null;
  const effectiveAgentId = selectedAgentOption?.launchable ? selectedAgent : defaultAgent;
  const effectiveAgentOption = agentOptions.find((agent) => agent.id === effectiveAgentId) ?? null;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const isDuplicate = name.trim() !== '' && existingNames.includes(name.trim());
  const canConfirm = name.trim() !== '' && !isDuplicate && !!effectiveAgentOption?.launchable;

  const handleAdd = () => {
    if (!canConfirm) return;
    onAdd({ name: name.trim(), agent: effectiveAgentId, branch, reviewMode });
    onClose();
  };

  return (
    <>
      <div className="glass-overlay absolute inset-0 z-40" onClick={onClose} />
      <div className="absolute inset-x-0 top-[15%] z-50 mx-auto w-full max-w-md px-6">
        <div className="glass-surface overflow-hidden rounded-2xl">
          <div className="flex items-center justify-between border-b border-white/[0.06] px-5 py-4">
            <div>
              <h3 className="text-sm font-semibold text-foreground">Add Agent Worktree</h3>
              <p className="mt-0.5 text-[11px] text-muted-foreground">Pick an agent, name, and base branch</p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="space-y-3 border-b border-white/[0.06] px-5 py-4">
            <div>
              <label className="mb-1.5 block text-[11px] font-medium text-muted-foreground">
                Worktree name
              </label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. feature-x"
                autoFocus
                className={cn(
                  'h-9 w-full rounded-lg border bg-white/[0.03] px-3 text-xs text-foreground',
                  'placeholder:text-muted-foreground/50',
                  'focus:outline-none focus:ring-0',
                  isDuplicate
                    ? 'border-destructive focus:border-destructive'
                    : 'border-white/[0.08] focus:border-white/20'
                )}
              />
              {isDuplicate && (
                <div className="mt-1 flex items-center gap-1 text-[10px] text-destructive">
                  <AlertCircle className="h-3 w-3" />
                  <span>A worktree with this name already exists</span>
                </div>
              )}
            </div>
            <div>
              <label className="mb-1.5 block text-[11px] font-medium text-muted-foreground">
                Base branch
              </label>
              <input
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                className="h-9 w-full rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 text-xs text-foreground placeholder:text-muted-foreground/50 focus:border-white/20 focus:outline-none focus:ring-0"
              />
            </div>
            <label className="flex items-start justify-between gap-3 rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 py-2.5 text-xs">
              <div className="flex-1">
                <div className="font-medium text-foreground">Review mode</div>
                <div className="mt-0.5 text-[10px] text-muted-foreground">
                  Run a focused review pass instead of editing
                </div>
              </div>
              <Checkbox checked={reviewMode} onCheckedChange={setReviewMode} className="mt-0.5" />
            </label>
          </div>

          <div className="max-h-64 overflow-y-auto p-2">
            {agentOptions.map((option) => {
              const meta = agentMeta[option.id];
              const isSelected = effectiveAgentId === option.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  disabled={!option.launchable}
                  onClick={() => setSelectedAgent(option.id)}
                  aria-current={isSelected || undefined}
                  className={cn(
                    'glass-item flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm',
                    isSelected ? 'text-foreground' : 'text-foreground/80',
                    !option.launchable && 'cursor-not-allowed opacity-45 hover:bg-transparent'
                  )}
                >
                  <AgentLogo agent={option.id} className="h-5 w-5 shrink-0" />
                  <span className="flex-1 font-medium">
                    {meta?.label ?? option.id}
                    {!option.launchable ? ` · ${option.status === 'missing' ? 'Not installed' : 'Unavailable'}` : ''}
                  </span>
                  {isSelected && <span className="h-2 w-2 rounded-full bg-foreground/60" />}
                </button>
              );
            })}
          </div>
          {selectedAgentOption && !selectedAgentOption.launchable && (
            <div className="border-t border-white/[0.06] px-5 py-2 text-[11px] text-muted-foreground">
              {selectedAgentOption.reason}
            </div>
          )}

          <div className="flex items-center justify-between border-t border-white/[0.06] px-5 py-3">
            <div className="flex min-w-0 flex-1 items-center gap-1.5 text-[11px] text-muted-foreground">
              <GitBranch className="h-3 w-3 shrink-0" />
              <span className="truncate">{name.trim() || 'name…'}</span>
            </div>
            <button
              type="button"
              disabled={!canConfirm}
              onClick={handleAdd}
              className={cn(
                'rounded-lg px-4 py-1.5 text-xs font-medium transition-all',
                canConfirm
                  ? 'bg-foreground text-background shadow-sm hover:bg-foreground/90'
                  : 'cursor-not-allowed bg-white/[0.04] text-muted-foreground'
              )}
            >
              Add Worktree
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
