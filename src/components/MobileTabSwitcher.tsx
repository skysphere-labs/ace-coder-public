import { useMemo } from 'react';
import {
  Check, FileText, Globe, Plus, ScrollText, StickyNote, TerminalSquare, X,
} from 'lucide-react';
import { cn } from '../lib/utils';
import { useApp } from '../store';
import {
  closeTab,
  openRef,
  usePaneLayout,
  type TabRef,
} from '../runtime/pane-layout-registry';
import { useScratchTabs, closeScratchTab } from '../runtime/scratch-tabs-registry';
import { useTaskSessions } from '../runtime/session-registry';
import { useMobileBackHandler } from '../runtime/mobile-back-stack';
import { requestNewTab } from '../runtime/mobile-new-tab-bus';
import { getAgentAccentColor } from '../lib/agent-style';
import AgentLogo from './ProviderGlyph';
import { MobilePill } from './ui/mobile';
import type { ScratchTab } from '../runtime/scratch-tabs-registry';
import type { AgentId, Conversation, Variant } from '../lib/types';

export function MobileTabSwitcher({ onClose }: { onClose: () => void }) {
  const { activeTask } = useApp();
  useMobileBackHandler(true, onClose);

  // Hooks can't be conditional — always run, resolve empty if no task.
  const taskId = activeTask?.id ?? null;
  const layout = usePaneLayout(taskId);
  const scratchState = useScratchTabs(taskId);
  const sessionRecord = useTaskSessions(taskId);

  const flat = useMemo(() => {
    const rows: { paneId: string; tabId: string; ref: TabRef }[] = [];
    for (const col of layout.columns) {
      for (const pane of col.panes) {
        for (const t of pane.tabs) {
          rows.push({ paneId: pane.id, tabId: t.id, ref: t.ref });
        }
      }
    }
    return rows;
  }, [layout]);

  const scratchById = useMemo(() => {
    const map = new Map<string, ScratchTab>();
    for (const t of scratchState.tabs) map.set(t.id, t);
    return map;
  }, [scratchState.tabs]);

  const conversationById = useMemo(() => {
    const map = new Map<string, Conversation>();
    for (const c of sessionRecord?.conversations ?? []) map.set(c.id, c);
    return map;
  }, [sessionRecord]);

  const variantById = useMemo(() => {
    const map = new Map<string, Variant>();
    for (const wt of activeTask?.worktrees ?? []) {
      for (const v of wt.variants) map.set(v.id, v);
    }
    return map;
  }, [activeTask]);

  const handleOpen = (ref: TabRef) => {
    if (!taskId) return;
    openRef(taskId, ref);
    onClose();
  };

  const handleClose = (paneId: string, tabId: string, ref: TabRef) => {
    if (!taskId) return;
    closeTab(taskId, paneId, tabId);
    if (ref.kind === 'scratch') closeScratchTab(taskId, ref.tabId);
  };

  const handleNew = () => {
    requestNewTab();
    onClose();
  };

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col text-foreground">
      <header className="flex h-12 shrink-0 items-center justify-center px-4">
        <h1 className="text-[13px] font-semibold text-foreground/80">
          {activeTask?.name || 'Tabs'}
        </h1>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {flat.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <p className="text-sm text-muted-foreground">No tabs yet. Tap + to add one.</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 landscape:grid-cols-4 landscape:gap-2">
            {flat.map((row) => (
              <TabCard
                key={row.tabId}
                tabRef={row.ref}
                variantById={variantById}
                conversationById={conversationById}
                scratchById={scratchById}
                onOpen={() => handleOpen(row.ref)}
                onClose={() => handleClose(row.paneId, row.tabId, row.ref)}
              />
            ))}
          </div>
        )}
      </div>

      <div
        className="flex shrink-0 items-center gap-3 px-5 pt-2"
        style={{ paddingBottom: 'max(env(safe-area-inset-bottom), 14px)' }}
      >
        <MobilePill onClick={handleNew} aria-label="New tab" className="h-10 w-10 text-foreground">
          <Plus className="h-[22px] w-[22px]" strokeWidth={2.25} />
        </MobilePill>
        <div className="flex flex-1 justify-center">
          <span className="mobile-header-pill inline-flex h-10 items-center rounded-full px-5 text-[13px] font-semibold text-foreground/90">
            {flat.length} {flat.length === 1 ? 'Tab' : 'Tabs'}
          </span>
        </div>
        <MobilePill onClick={onClose} aria-label="Done" className="h-10 w-10 text-foreground">
          <Check className="h-[22px] w-[22px]" strokeWidth={2.5} />
        </MobilePill>
      </div>
    </div>
  );
}

function TabCard({
  tabRef,
  variantById,
  conversationById,
  scratchById,
  onOpen,
  onClose,
}: {
  tabRef: TabRef;
  variantById: Map<string, Variant>;
  conversationById: Map<string, Conversation>;
  scratchById: Map<string, ScratchTab>;
  onOpen: () => void;
  onClose: () => void;
}) {
  const info = resolveTabInfo(tabRef, { variantById, conversationById, scratchById });

  return (
    <div className="relative aspect-[3/4] overflow-hidden rounded-2xl border border-white/[0.08] bg-white/[0.04] shadow-[0_8px_24px_hsl(0_0%_0%/0.35)] landscape:aspect-square">
      <button
        type="button"
        onClick={onOpen}
        className="flex h-full w-full flex-col items-stretch text-left transition-colors active:bg-white/[0.04]"
      >
        <div
          className="relative flex flex-1 items-center justify-center"
          style={{
            background: info.accent
              ? `radial-gradient(120% 120% at 50% 0%, ${info.accent}28, transparent 70%)`
              : 'radial-gradient(120% 120% at 50% 0%, hsl(0 0% 100% / 0.04), transparent 70%)',
          }}
        >
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-white/[0.08] bg-white/[0.06]">
            {info.icon}
          </div>
        </div>
        <div className="flex items-center gap-2 border-t border-white/[0.06] bg-white/[0.02] px-3 py-2.5">
          <span
            className={cn(
              'flex h-5 w-5 shrink-0 items-center justify-center rounded-md',
              info.badgeClass ?? 'bg-white/[0.06]'
            )}
          >
            {info.badge}
          </span>
          <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground/90">
            {info.name}
          </span>
        </div>
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        aria-label="Close tab"
        className="absolute right-1.5 top-1.5 flex h-7 w-7 items-center justify-center rounded-full bg-black/55 text-foreground backdrop-blur-md transition-colors active:bg-black/75"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

type ResolveCtx = {
  variantById: Map<string, Variant>;
  conversationById: Map<string, Conversation>;
  scratchById: Map<string, ScratchTab>;
};

function resolveTabInfo(
  ref: TabRef,
  ctx: ResolveCtx
): { icon: React.ReactNode; badge: React.ReactNode; name: string; accent?: string; badgeClass?: string } {
  switch (ref.kind) {
    case 'variant': {
      const v = ctx.variantById.get(ref.variantId);
      const agent: AgentId = (v?.agent ?? 'claude') as AgentId;
      const accent = getAgentAccentColor(agent);
      return {
        icon: <AgentLogo agent={agent} className="h-8 w-8" />,
        badge: <AgentLogo agent={agent} className="h-3 w-3" />,
        name: v?.name ?? 'Agent',
        accent,
      };
    }
    case 'conversation': {
      const c = ctx.conversationById.get(ref.conversationId);
      const agent: AgentId = (c?.agent ?? 'claude') as AgentId;
      const accent = getAgentAccentColor(agent);
      return {
        icon: <AgentLogo agent={agent} className="h-8 w-8" />,
        badge: <AgentLogo agent={agent} className="h-3 w-3" />,
        name: c?.title ?? 'Chat',
        accent,
      };
    }
    case 'scratch': {
      const s = ctx.scratchById.get(ref.tabId);
      if (s?.kind === 'browser') {
        return {
          icon: <Globe className="h-7 w-7 text-sky-400/90" />,
          badge: <Globe className="h-3 w-3 text-sky-400" />,
          name: s.title || 'New tab',
          accent: 'hsl(200 90% 55%)',
        };
      }
      return {
        icon: <StickyNote className="h-7 w-7 text-amber-300/90" />,
        badge: <StickyNote className="h-3 w-3 text-amber-300" />,
        name: s?.title || 'Notes',
        accent: 'hsl(42 95% 60%)',
      };
    }
    case 'file': {
      const name = ref.path.split('/').pop() || ref.path;
      return {
        icon: <FileText className="h-7 w-7 text-foreground/70" />,
        badge: <FileText className="h-3 w-3 text-foreground/70" />,
        name,
      };
    }
    case 'promptMarkdown': {
      const name = ref.path.split('/').pop() || ref.path;
      return {
        icon: <FileText className="h-7 w-7 text-foreground/70" />,
        badge: <FileText className="h-3 w-3 text-foreground/70" />,
        name,
      };
    }
    case 'terminal':
      return {
        icon: <TerminalSquare className="h-7 w-7 text-emerald-400/90" />,
        badge: <TerminalSquare className="h-3 w-3 text-emerald-400" />,
        name: 'Terminal',
        accent: 'hsl(145 70% 55%)',
      };
    case 'spec':
      return {
        icon: <ScrollText className="h-7 w-7 text-violet-300/90" />,
        badge: <ScrollText className="h-3 w-3 text-violet-300" />,
        name: 'Spec',
        accent: 'hsl(262 80% 65%)',
      };
  }
}
