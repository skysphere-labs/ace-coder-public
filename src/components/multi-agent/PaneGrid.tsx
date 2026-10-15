import { useRef, useState, type ReactNode } from 'react';
import { dataTransferHasType } from '../../lib/clipboard';
import { cn } from '../../lib/utils';
import {
  PANE_TAB_DRAG_MIME,
  type Pane,
  type PaneColumn,
  type PaneLayout,
  type PaneTab,
  type PaneTabDragPayload,
  type TabRef,
} from '../../runtime/pane-layout-registry';
import PaneTabStrip, { type TabPresentation } from './PaneTabStrip';
import type { ContextMenuItem } from '../FileContextMenu';

interface PaneGridProps {
  layout: PaneLayout;
  renderTab: (ref: TabRef, paneId: string, isFocused: boolean) => ReactNode;
  resolveTab: (tab: PaneTab) => TabPresentation;
  onSelectTab: (paneId: string, tabId: string) => void;
  onCloseTab: (paneId: string, tabId: string) => void;
  onFocusPane: (paneId: string) => void;
  onSplitColumn: (payload: PaneTabDragPayload, side: 'left' | 'right') => void;
  onSplitRow: (payload: PaneTabDragPayload, targetPaneId: string, side: 'top' | 'bottom') => void;
  onMoveTab: (payload: PaneTabDragPayload, targetPaneId: string) => void;
  onAddTab?: (paneId: string) => void;
  resolveTabContextMenu?: (tab: PaneTab, paneId: string) => ContextMenuItem[];
  firstPaneLeading?: ReactNode;
  firstPaneTrailing?: ReactNode;
}

type SplitDir = 'horizontal' | 'vertical' | 'none';
type Zone = 'left' | 'right' | 'top' | 'bottom';

function readPayload(e: React.DragEvent): PaneTabDragPayload | null {
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

// What direction can this pane offer? Vertical (left/right) once on a single
// column; horizontal (top/bottom) only when we already have ≥2 columns and the
// hovered pane's column still has room for another row. Returns 'none' when
// the pane is at max capacity.
function splitDirFor(layout: PaneLayout, col: PaneColumn): SplitDir {
  if (layout.columns.length < 2) return 'horizontal';
  if (col.panes.length < 2) return 'vertical';
  return 'none';
}

export default function PaneGrid({
  layout,
  renderTab,
  resolveTab,
  onSelectTab,
  onCloseTab,
  onFocusPane,
  onSplitColumn,
  onSplitRow,
  onMoveTab,
  onAddTab,
  resolveTabContextMenu,
  firstPaneLeading,
  firstPaneTrailing,
}: PaneGridProps) {
  const firstPaneId = layout.columns[0]?.panes[0]?.id ?? null;
  return (
    <div className="flex h-full w-full">
      {layout.columns.map((col, colIdx) => (
        <ColumnView
          key={col.id}
          col={col}
          colIdx={colIdx}
          layout={layout}
          renderTab={renderTab}
          resolveTab={resolveTab}
          onSelectTab={onSelectTab}
          onCloseTab={onCloseTab}
          onFocusPane={onFocusPane}
          onSplitColumn={onSplitColumn}
          onSplitRow={onSplitRow}
          onMoveTab={onMoveTab}
          onAddTab={onAddTab}
          resolveTabContextMenu={resolveTabContextMenu}
          firstPaneId={firstPaneId}
          firstPaneLeading={firstPaneLeading}
          firstPaneTrailing={firstPaneTrailing}
        />
      ))}
    </div>
  );
}

function ColumnView({
  col,
  colIdx,
  layout,
  renderTab,
  resolveTab,
  onSelectTab,
  onCloseTab,
  onFocusPane,
  onSplitColumn,
  onSplitRow,
  onMoveTab,
  onAddTab,
  resolveTabContextMenu,
  firstPaneId,
  firstPaneLeading,
  firstPaneTrailing,
}: {
  col: PaneColumn;
  colIdx: number;
  firstPaneId: string | null;
} & PaneGridProps) {
  return (
    <>
      {colIdx > 0 && <div className="w-px shrink-0 bg-border/30" />}
      <div className="flex min-w-0 flex-1 flex-col">
        {col.panes.map((pane, paneIdx) => (
          <PaneCell
            key={pane.id}
            pane={pane}
            col={col}
            isFirstRow={paneIdx === 0}
            layout={layout}
            renderTab={renderTab}
            resolveTab={resolveTab}
            onSelectTab={onSelectTab}
            onCloseTab={onCloseTab}
            onFocusPane={onFocusPane}
            onSplitColumn={onSplitColumn}
            onSplitRow={onSplitRow}
            onMoveTab={onMoveTab}
            onAddTab={onAddTab}
            resolveTabContextMenu={resolveTabContextMenu}
            leading={pane.id === firstPaneId ? firstPaneLeading : undefined}
            trailing={pane.id === firstPaneId ? firstPaneTrailing : undefined}
          />
        ))}
      </div>
    </>
  );
}

function PaneCell({
  pane,
  col,
  isFirstRow,
  layout,
  renderTab,
  resolveTab,
  onSelectTab,
  onCloseTab,
  onFocusPane,
  onSplitColumn,
  onSplitRow,
  onMoveTab,
  onAddTab,
  resolveTabContextMenu,
  leading,
  trailing,
}: {
  pane: Pane;
  col: PaneColumn;
  isFirstRow: boolean;
  leading?: ReactNode;
  trailing?: ReactNode;
} & Omit<PaneGridProps, 'firstPaneLeading' | 'firstPaneTrailing'>) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [hoverZone, setHoverZone] = useState<Zone | null>(null);
  const isFocused = layout.focusedPaneId === pane.id;
  const dir = splitDirFor(layout, col);
  const activeTab = pane.tabs.find((t) => t.id === pane.activeTabId) ?? pane.tabs[0];

  const pickZone = (e: React.DragEvent): Zone | null => {
    const rect = bodyRef.current?.getBoundingClientRect();
    if (!rect || dir === 'none') return null;
    if (dir === 'horizontal') {
      const x = (e.clientX - rect.left) / rect.width;
      return x < 0.5 ? 'left' : 'right';
    }
    const y = (e.clientY - rect.top) / rect.height;
    return y < 0.5 ? 'top' : 'bottom';
  };

  return (
    <>
      {!isFirstRow && <div className="h-px shrink-0 bg-border/30" />}
      <div
        onMouseDown={() => onFocusPane(pane.id)}
        className={cn(
          'flex min-h-0 flex-1 flex-col overflow-hidden rounded-md',
          isFocused && layout.columns.length + col.panes.length > 2 && 'ring-1 ring-inset ring-foreground/10'
        )}
      >
        <PaneTabStrip
          pane={pane}
          isFocused={isFocused}
          resolveTab={resolveTab}
          onSelectTab={(tabId) => onSelectTab(pane.id, tabId)}
          onCloseTab={(tabId) => onCloseTab(pane.id, tabId)}
          onDropOnStrip={(payload) => onMoveTab(payload, pane.id)}
          onAddTab={onAddTab ? () => onAddTab(pane.id) : undefined}
          resolveTabContextMenu={resolveTabContextMenu}
          leading={leading}
          trailing={trailing}
        />
        <div
          ref={bodyRef}
          onDragOver={(e) => {
            if (!hasTabDrag(e)) return;
            if (dir === 'none') return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            setHoverZone(pickZone(e));
          }}
          onDragLeave={(e) => {
            if (!hasTabDrag(e)) return;
            const related = e.relatedTarget as Node | null;
            if (related && bodyRef.current?.contains(related)) return;
            setHoverZone(null);
          }}
          onDrop={(e) => {
            if (!hasTabDrag(e)) return;
            e.preventDefault();
            const payload = readPayload(e);
            const zone = pickZone(e);
            setHoverZone(null);
            if (!payload || !zone) return;
            if (zone === 'left' || zone === 'right') {
              onSplitColumn(payload, zone);
            } else {
              onSplitRow(payload, pane.id, zone);
            }
          }}
          className="relative min-h-0 flex-1"
        >
          <div className="h-full w-full">{activeTab && renderTab(activeTab.ref, pane.id, isFocused)}</div>
          {hoverZone && dir !== 'none' && <DropOverlay zone={hoverZone} dir={dir} />}
        </div>
      </div>
    </>
  );
}

function DropOverlay({ zone, dir }: { zone: Zone; dir: Exclude<SplitDir, 'none'> }) {
  // Two big half-area guides; only the hovered one fills with sky.
  const aActive = dir === 'horizontal' ? zone === 'left' : zone === 'top';
  const bActive = dir === 'horizontal' ? zone === 'right' : zone === 'bottom';
  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex" style={dir === 'vertical' ? { flexDirection: 'column' } : undefined}>
      <DropHalf active={aActive} />
      <DropHalf active={bActive} />
    </div>
  );
}

function DropHalf({ active }: { active: boolean }) {
  return (
    <div
      className={cn(
        'm-1 flex-1 rounded-lg border-2 border-dashed transition-colors duration-75',
        active
          ? 'border-sky-400/80 bg-sky-400/15'
          : 'border-foreground/20 bg-foreground/[0.02]'
      )}
    />
  );
}
