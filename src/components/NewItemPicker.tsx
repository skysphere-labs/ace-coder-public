import { useState } from 'react';
import { Globe, MessageSquarePlus, StickyNote, Zap } from 'lucide-react';
import { AgentPickerGrid } from './AgentPickerGrid';
import { InstallAgentDialog } from './InstallAgentDialog';
import { Checkbox } from './ui/checkbox';
import { cn } from '../lib/utils';
import type { AgentCatalogScope } from '../runtime/agent-registry';
import type { AgentCatalogEntry } from '../lib/types';

interface NewItemPickerProps {
  agentTitle?: string;
  agentDescription?: string;
  scope?: AgentCatalogScope;
  onSelectAgent: (agent: AgentCatalogEntry) => void | Promise<void>;
  onSelectBrowser: () => void;
  onSelectNotes: () => void;
  autoApproveEnabled?: boolean;
  onAutoApproveChange?: (next: boolean) => void | Promise<void>;
}

export function NewItemPicker({
  agentTitle = 'New chat',
  agentDescription = 'Pick an agent for a new chat tab',
  scope,
  onSelectAgent,
  onSelectBrowser,
  onSelectNotes,
  autoApproveEnabled,
  onAutoApproveChange,
}: NewItemPickerProps) {
  const [installAgent, setInstallAgent] = useState<AgentCatalogEntry | null>(null);
  const showAutoApprove =
    typeof autoApproveEnabled === 'boolean' && !!onAutoApproveChange;

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-8 py-10">
        <div className="flex flex-col gap-1">
          <h2 className="font-display text-xl font-semibold tracking-tight">New tab</h2>
          <p className="text-xs text-muted-foreground">
            Start a chat with an agent, open a browser, or jot quick notes.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <OptionCard
            selected
            icon={<MessageSquarePlus className="h-4 w-4" />}
            title="New chat"
            description="Pick an agent below"
          />
          <OptionCard
            onClick={onSelectBrowser}
            icon={<Globe className="h-4 w-4" />}
            title="New browser"
            description="Logged in sessions persist"
          />
          <OptionCard
            onClick={onSelectNotes}
            icon={<StickyNote className="h-4 w-4" />}
            title="New notes"
            description="Save to the task folder"
          />
        </div>

        <div className="flex flex-col gap-1 border-t border-border/30 pt-5">
          <h3 className="text-sm font-semibold tracking-tight">{agentTitle}</h3>
          <p className="text-xs text-muted-foreground">{agentDescription}</p>
        </div>

        {showAutoApprove && (
          <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 py-2.5 transition-colors hover:border-white/15 hover:bg-white/[0.05]">
            <Checkbox
              checked={!!autoApproveEnabled}
              onCheckedChange={(checked) => onAutoApproveChange?.(checked === true)}
              className="mt-0.5"
            />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                <Zap className="h-3 w-3" />
                Auto-approve agent actions
              </div>
              <div className="text-[11px] text-muted-foreground">
                Passes --dangerously-skip-permissions. Applies to agents launched next from this task.
              </div>
            </div>
          </label>
        )}

        <AgentPickerGrid
          scope={scope}
          onSelect={(agent) => void onSelectAgent(agent)}
          onMissingSelect={(agent) => setInstallAgent(agent)}
          onReinstall={(agent) => setInstallAgent(agent)}
        />
      </div>
      {installAgent && (
        <InstallAgentDialog
          agent={installAgent}
          scope={scope}
          onClose={() => setInstallAgent(null)}
        />
      )}
    </div>
  );
}

function OptionCard({
  icon,
  title,
  description,
  selected,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  selected?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'group flex items-start gap-3 rounded-xl border px-3 py-3 text-left transition-all',
        selected
          ? 'border-foreground/20 bg-white/[0.04]'
          : 'border-border/40 bg-white/[0.02] hover:-translate-y-0.5 hover:border-foreground/20 hover:bg-white/[0.04]'
      )}
    >
      <div
        className={cn(
          'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border transition-colors',
          selected
            ? 'border-foreground/25 bg-foreground/10 text-foreground'
            : 'border-border/40 bg-background/40 text-muted-foreground group-hover:border-foreground/20 group-hover:text-foreground'
        )}
      >
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-foreground">{title}</div>
        <div className="mt-0.5 text-[11px] text-muted-foreground">{description}</div>
      </div>
    </button>
  );
}
