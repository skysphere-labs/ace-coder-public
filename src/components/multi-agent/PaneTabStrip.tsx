import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Plus, X } from 'lucide-react';
import { dataTransferHasType } from '../../lib/clipboard';
import { cn, cssVar } from '../../lib/utils';
import { getTabBackground } from '../../lib/agent-style';
import { Spinner } from '../ui/spinner';
import type { ContextMenuItem } from '../FileContextMenu';
import {
  PANE_TAB_DRAG_MIME,
  type Pane,
  type PaneTab,
  type PaneTabDragPayload,
} from '../../runtime/pane-layout-registry';

export type TabPresentation = {
  icon: ReactNode;
  label: string;
  title?: string;
  accent?: string;
  isBusy?: boolean;
  isDirty?: boolean;
};

interface PaneTabStripProps {
  pane: Pane;
  isFocused: boolean;
  resolveTab: (tab: PaneTab) => TabPresentation;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onDropOnStrip: (payload: PaneTabDragPayload) => void;
  onAddTab?: () => void;
  resolveTabContextMenu?: (tab: PaneTab, paneId: string) => ContextMenuItem[];
  leading?: ReactNode;
  trailing?: ReactNode;
}

function startTabDrag(e: React.DragEvent, payload: PaneTabDragPayload) {
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData(PANE_TAB_DRAG_MIME, JSON.stringify(payload));
}

function readTabDrag(e: React.DragEvent): PaneTabDragPayload | null {
  const raw = e.dataTransfer.getData(PANE_TAB_DRAG_MIME);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PaneTabDragPayload;
  } catch {
    return null;
  }
}

function hasTabDrag(e: React.DragEvent): boolean {
  return dataTransferHasType(e.dataTransfer, PANE_TAB_DRAG_MIME);
}

export default function PaneTabStrip({
  pane,
  isFocused,
  resolveTab,
  onSelectTab,
  onCloseTab,
  onDropOnStrip,
  onAddTab,
  resolveTabContextMenu,
  leading,
  trailing,
}: PaneTabStripProps) {
  const [dragOver, setDragOver] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    items: ContextMenuItem[];
  } | null>(null);
  const stripRef = useRef<HTMLDivElement | null>(null);

  // Native contextmenu listener. React's synthetic onContextMenu was getting
  // eaten by something in this render tree (draggable tabs + focus state
  // updates on the parent pane); binding directly to the DOM element is
  // bulletproof.
  useEffect(() => {
    const el = stripRef.current;
    if (!el || !resolveTabContextMenu) return;
    const handler = (e: MouseEvent) => {
      const target = (e.target as HTMLElement | null)?.closest('[data-tab-id]');
      if (!target) return;
      const tabId = target.getAttribute('data-tab-id');
      if (!tabId) return;
      const tab = pane.tabs.find((t) => t.id === tabId);
      if (!tab) return;
      const items = resolveTabContextMenu(tab, pane.id);
      if (!items || items.length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      setContextMenu({ x: e.clientX, y: e.clientY, items });
    };
    el.addEventListener('contextmenu', handler);
    return () => el.removeEventListener('contextmenu', handler);
  }, [pane, resolveTabContextMenu]);

  const handleStripDragOver = (e: React.DragEvent) => {
    if (!hasTabDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOver(true);
  };
  const handleStripDrop = (e: React.DragEvent) => {
    if (!hasTabDrag(e)) return;
    e.preventDefault();
    const payload = readTabDrag(e);
    setDragOver(false);
    if (payload) onDropOnStrip(payload);
  };

  return (
    <div className={cn('flex h-9 shrink-0 items-stretch border-b border-border/30')}>
      {leading && (
        <div className="flex shrink-0 items-center gap-1 border-r border-border/30 pl-1.5 pr-2">
          {leading}
        </div>
      )}
      <div
        ref={stripRef}
        onDragOver={handleStripDragOver}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleStripDrop}
        className={cn(
          'flex min-w-0 flex-1 items-end gap-1 overflow-x-auto overflow-y-hidden px-1',
          dragOver && 'bg-sky-400/5'
        )}
      >
        {pane.tabs.map((tab) => {
        const { icon, label, title, accent, isBusy, isDirty } = resolveTab(tab);
        const isActive = pane.activeTabId === tab.id;
        const bg = getTabBackground();
        return (
          <div
            key={tab.id}
            data-tab-id={tab.id}
            role="tab"
            tabIndex={0}
            onClick={() => onSelectTab(tab.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onSelectTab(tab.id);
              }
            }}
            draggable
            onDragStart={(e) =>
              startTabDrag(e, { paneId: pane.id, tabId: tab.id, ref: tab.ref })
            }
            aria-selected={isActive}
            className={cn(
              'group relative flex h-8 min-w-0 max-w-[220px] cursor-default items-center gap-2 rounded-t-md px-2.5 text-xs font-medium transition-colors',
              'border border-b-0 border-transparent',
              isActive
                ? 'z-10 bg-[var(--tab-active-bg)] text-foreground shadow-[0_-1px_4px_rgba(0,0,0,0.06)]'
                : 'text-muted-foreground hover:bg-[hsl(0_0%_100%/0.04)] hover:text-foreground/70'
            )}
            style={cssVar('--tab-active-bg', isActive ? bg : undefined)}
            title={title ?? label}
          >
            <span className="flex h-4 w-4 shrink-0 items-center justify-center">{icon}</span>
            <span className="min-w-0 flex-1 truncate">{label}</span>
            {isBusy && (
              <Spinner
                size="sm"
                className={cn(
                  'h-3 w-3 shrink-0',
                  isActive ? 'text-foreground/70' : 'text-muted-foreground/50'
                )}
              />
            )}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onCloseTab(tab.id);
              }}
              className={cn(
                'flex h-4 w-4 shrink-0 items-center justify-center rounded-sm transition-colors',
                isActive
                  ? 'text-foreground/55 hover:bg-black/10 hover:text-foreground/90'
                  : 'text-muted-foreground/40 hover:bg-muted hover:text-muted-foreground/80'
              )}
              title={`Close ${label}`}
              aria-label={`Close ${label}`}
            >
              {isDirty ? (
                <>
                  <span className="h-1.5 w-1.5 rounded-full bg-current group-hover:hidden" />
                  <X className="hidden h-3 w-3 group-hover:block" />
                </>
              ) : (
                <X className="h-3 w-3 opacity-0 group-hover:opacity-100" />
              )}
            </button>
            {isActive && (
              <div
                className="absolute bottom-0 left-2 right-2 h-[2px] rounded-full"
                style={{ backgroundColor: accent ?? 'currentColor' }}
              />
            )}
          </div>
        );
      })}

        {onAddTab && (
          <button
            type="button"
            onClick={onAddTab}
            className={cn(
              'mb-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors',
              'text-muted-foreground hover:bg-muted hover:text-foreground'
            )}
            title="New Tab"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        )}
        <div className="flex-1" />
        {isFocused && <div className="h-px w-1 self-end opacity-0">.</div>}
      </div>
      {trailing && (
        <div className="flex shrink-0 items-center gap-1 border-l border-border/30 px-1.5">
          {trailing}
        </div>
      )}
      {contextMenu && (
        <FloatingMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenu.items}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}

function FloatingMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}) {
  useEffect(() => {
    const onDown = () => onClose();
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('contextmenu', onDown);
    window.addEventListener('keydown', onEsc);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('contextmenu', onDown);
      window.removeEventListener('keydown', onEsc);
    };
  }, [onClose]);

  return createPortal(
    <div
      role="menu"
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
      style={{ left: x, top: y }}
      className="glass-surface fixed z-[200] min-w-[220px] overflow-hidden rounded-xl p-1.5 text-[13px] animate-in fade-in-0 zoom-in-95"
    >
      {items.map((item, i) => {
        if (item.kind === 'separator') {
          return <div key={`sep-${i}`} className="my-1 h-px bg-white/[0.06]" />;
        }
        return (
          <button
            key={`${item.label}-${i}`}
            type="button"
            disabled={item.disabled}
            onClick={() => {
              if (item.disabled) return;
              item.onSelect();
              onClose();
            }}
            className={cn(
              'glass-item flex w-full cursor-pointer items-center px-2.5 py-1.5 text-left outline-none',
              'disabled:cursor-not-allowed disabled:opacity-40',
              item.danger
                ? 'text-red-300/85 hover:text-red-200'
                : 'text-foreground/85'
            )}
          >
            {item.label}
          </button>
        );
      })}
    </div>,
    document.body
  );
}
