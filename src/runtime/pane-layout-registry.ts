import { useSyncExternalStore } from 'react';

// Pane layout: each pane is a tab container holding 1+ tabs and rendering one
// at a time. The screen's body is a 1×1, 2×1, 1×2, or up to 2×2 grid of panes.
// Splits go vertical (columns) first, then horizontal (rows within a column).
// Tabs MOVE between panes — never duplicate. Closing the last tab of a pane
// removes the pane (and the column if empty).

export type TabRef =
  | { kind: 'variant'; variantId: string }
  | { kind: 'conversation'; conversationId: string }
  | { kind: 'file'; path: string }
  | { kind: 'terminal' }
  | { kind: 'scratch'; tabId: string }
  | { kind: 'promptMarkdown'; path: string }
  // Singleton per task (like 'terminal'): the manual read-only spec/rubric
  // tab. Content derives from the task spec at render time, so the ref
  // carries no payload.
  | { kind: 'spec' };

export type PaneTab = { id: string; ref: TabRef };
export type Pane = { id: string; tabs: PaneTab[]; activeTabId: string };
export type PaneColumn = { id: string; panes: Pane[] };
export type PaneLayout = {
  columns: PaneColumn[];
  focusedPaneId: string;
};

export const PANE_TAB_DRAG_MIME = 'application/x-ace-pane-tab';

export type PaneTabDragPayload = {
  paneId: string;
  tabId: string;
  ref: TabRef;
};

function refsEqual(a: TabRef, b: TabRef): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'variant':
      return a.variantId === (b as { variantId: string }).variantId;
    case 'conversation':
      return a.conversationId === (b as { conversationId: string }).conversationId;
    case 'file':
      return a.path === (b as { path: string }).path;
    case 'promptMarkdown':
      return a.path === (b as { path: string }).path;
    case 'scratch':
      return a.tabId === (b as { tabId: string }).tabId;
    case 'terminal':
    case 'spec':
      return true;
  }
}

function refKey(ref: TabRef): string {
  switch (ref.kind) {
    case 'variant':
      return `variant:${ref.variantId}`;
    case 'conversation':
      return `conversation:${ref.conversationId}`;
    case 'file':
      return `file:${ref.path}`;
    case 'promptMarkdown':
      return `promptMarkdown:${ref.path}`;
    case 'scratch':
      return `scratch:${ref.tabId}`;
    case 'terminal':
      return 'terminal';
    case 'spec':
      return 'spec';
  }
}

function uid(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

function findPane(layout: PaneLayout, paneId: string): Pane | null {
  for (const col of layout.columns) {
    const pane = col.panes.find((p) => p.id === paneId);
    if (pane) return pane;
  }
  return null;
}

function findPaneContaining(layout: PaneLayout, tabId: string): { col: PaneColumn; pane: Pane } | null {
  for (const col of layout.columns) {
    for (const pane of col.panes) {
      if (pane.tabs.some((t) => t.id === tabId)) return { col, pane };
    }
  }
  return null;
}

function findPaneByRef(layout: PaneLayout, ref: TabRef): { pane: Pane; tab: PaneTab } | null {
  for (const col of layout.columns) {
    for (const pane of col.panes) {
      const tab = pane.tabs.find((t) => refsEqual(t.ref, ref));
      if (tab) return { pane, tab };
    }
  }
  return null;
}

function makeTab(ref: TabRef): PaneTab {
  return { id: uid('tab'), ref };
}

function makePane(tabs: PaneTab[]): Pane {
  return { id: uid('pane'), tabs, activeTabId: tabs[0]?.id ?? '' };
}

function makeColumn(panes: Pane[]): PaneColumn {
  return { id: uid('col'), panes };
}

function singleLayout(refs: TabRef[]): PaneLayout {
  const tabs = refs.map(makeTab);
  const pane = makePane(tabs);
  return { columns: [makeColumn([pane])], focusedPaneId: pane.id };
}

const states = new Map<string, PaneLayout>();
const listeners = new Map<string, Set<() => void>>();

const STORAGE_PREFIX = 'ace:pane-layout:';

function storageKey(taskId: string) {
  return `${STORAGE_PREFIX}${taskId}`;
}

function persistLayout(taskId: string, layout: PaneLayout) {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(storageKey(taskId), JSON.stringify(layout));
  } catch {
    // localStorage full or unavailable — not worth surfacing.
  }
}

function loadPersistedLayout(taskId: string): PaneLayout | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(storageKey(taskId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PaneLayout;
    // Sanity check: must have the shape we expect. Stale refs get reconciled
    // by syncAvailableTabs once the screen mounts, so we don't validate them
    // here.
    if (!parsed || !Array.isArray(parsed.columns)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function notify(taskId: string) {
  const set = listeners.get(taskId);
  if (!set) return;
  for (const fn of set) fn();
}

function subscribe(taskId: string, fn: () => void): () => void {
  let set = listeners.get(taskId);
  if (!set) {
    set = new Set();
    listeners.set(taskId, set);
  }
  set.add(fn);
  return () => {
    set!.delete(fn);
    if (set!.size === 0) listeners.delete(taskId);
  };
}

function setLayout(taskId: string, next: PaneLayout) {
  states.set(taskId, next);
  persistLayout(taskId, next);
  notify(taskId);
}

// Reconcile the layout against the current set of available tab refs:
//   - drops any tabs whose ref disappeared
//   - appends new refs to the focused pane (or the first pane if none focused)
//   - removes empty panes/columns; if everything is empty, seeds with whatever
//     remained (or no-op if `refs` itself is empty)
// `preserveRefs` survive pruning if already present, but are never appended.
// Refs are compared by kind + identifying field (refsEqual). Tabs are
// considered identical to refs even if their tabId differs.
export function syncAvailableTabs(
  taskId: string,
  refs: TabRef[],
  options: { prune?: boolean; preserveRefs?: TabRef[] } = {}
): PaneLayout {
  const { prune = true, preserveRefs = [] } = options;
  // Hydrate from localStorage if we haven't seen this task yet this session.
  let existing = states.get(taskId);
  if (!existing) {
    const persisted = loadPersistedLayout(taskId);
    if (persisted) {
      states.set(taskId, persisted);
      existing = persisted;
    }
  }
  if (!existing || existing.columns.length === 0) {
    const created = singleLayout(refs);
    setLayout(taskId, created);
    return created;
  }

  const refKeys = new Set([...refs, ...preserveRefs].map(refKey));

  // 1. Filter out stale tabs; keep tab identity stable for refs that survived.
  //    When `prune` is false we leave existing tabs alone and only add new ones
  //    — useful on app startup before async registries (files, scratch) have
  //    hydrated, so their persisted tabs don't get wiped and then re-added
  //    to the wrong pane once hydration completes.
  let columns = prune
    ? existing.columns
        .map((col) => ({
          ...col,
          panes: col.panes
            .map((pane) => {
              const tabs = pane.tabs.filter((t) => refKeys.has(refKey(t.ref)));
              const activeTabId = tabs.some((t) => t.id === pane.activeTabId)
                ? pane.activeTabId
                : tabs[0]?.id ?? '';
              return { ...pane, tabs, activeTabId };
            })
            .filter((pane) => pane.tabs.length > 0),
        }))
        .filter((col) => col.panes.length > 0)
    : existing.columns.map((col) => ({ ...col, panes: col.panes.map((p) => ({ ...p })) }));

  // 2. Append new refs (those not in any pane) to the focused pane.
  const seen = new Set<string>();
  for (const col of columns) {
    for (const pane of col.panes) {
      for (const tab of pane.tabs) seen.add(refKey(tab.ref));
    }
  }
  const newRefs = refs.filter((r) => !seen.has(refKey(r)));
  if (newRefs.length > 0) {
    if (columns.length === 0) {
      columns = [makeColumn([makePane(newRefs.map(makeTab))])];
    } else {
      const focusedExists = columns.some((c) => c.panes.some((p) => p.id === existing.focusedPaneId));
      const targetPaneId = focusedExists ? existing.focusedPaneId : columns[0].panes[0].id;
      columns = columns.map((col) => ({
        ...col,
        panes: col.panes.map((pane) => {
          if (pane.id !== targetPaneId) return pane;
          const newTabs = newRefs.map(makeTab);
          const tabs = [...pane.tabs, ...newTabs];
          return { ...pane, tabs, activeTabId: pane.activeTabId || tabs[0].id };
        }),
      }));
    }
  }

  if (columns.length === 0) {
    const empty: PaneLayout = { columns: [], focusedPaneId: '' };
    setLayout(taskId, empty);
    return empty;
  }

  let focusedPaneId = existing.focusedPaneId;
  const stillExists = columns.some((c) => c.panes.some((p) => p.id === focusedPaneId));
  if (!stillExists) focusedPaneId = columns[0].panes[0].id;

  const next: PaneLayout = { columns, focusedPaneId };
  setLayout(taskId, next);
  return next;
}

export function selectTab(taskId: string, paneId: string, tabId: string) {
  const layout = states.get(taskId);
  if (!layout) return;
  setLayout(taskId, {
    ...layout,
    focusedPaneId: paneId,
    columns: layout.columns.map((col) => ({
      ...col,
      panes: col.panes.map((pane) =>
        pane.id === paneId ? { ...pane, activeTabId: tabId } : pane
      ),
    })),
  });
}

// Ensure `ref` is both present in the layout AND the active tab of its pane.
// If it already lives somewhere, that pane becomes focused and activates the
// tab. Otherwise it is appended to the currently-focused pane and activated.
// Used when an external caller (e.g. a chat link click) wants the tab to be
// immediately visible — syncAvailableTabs alone wouldn't steal focus.
export function openRef(taskId: string, ref: TabRef) {
  const layout = states.get(taskId);
  if (!layout || layout.columns.length === 0) return;

  const found = findPaneByRef(layout, ref);
  if (found) {
    setLayout(taskId, {
      ...layout,
      focusedPaneId: found.pane.id,
      columns: layout.columns.map((col) => ({
        ...col,
        panes: col.panes.map((pane) =>
          pane.id === found.pane.id ? { ...pane, activeTabId: found.tab.id } : pane
        ),
      })),
    });
    return;
  }

  const focusedExists = layout.columns.some((c) => c.panes.some((p) => p.id === layout.focusedPaneId));
  const targetPaneId = focusedExists ? layout.focusedPaneId : layout.columns[0].panes[0].id;
  const newTab = makeTab(ref);
  setLayout(taskId, {
    ...layout,
    focusedPaneId: targetPaneId,
    columns: layout.columns.map((col) => ({
      ...col,
      panes: col.panes.map((pane) =>
        pane.id === targetPaneId
          ? { ...pane, tabs: [...pane.tabs, newTab], activeTabId: newTab.id }
          : pane
      ),
    })),
  });
}

export function focusPane(taskId: string, paneId: string) {
  const layout = states.get(taskId);
  if (!layout || layout.focusedPaneId === paneId) return;
  setLayout(taskId, { ...layout, focusedPaneId: paneId });
}

function pruneEmpty(columns: PaneColumn[]): PaneColumn[] {
  return columns
    .map((col) => ({ ...col, panes: col.panes.filter((p) => p.tabs.length > 0) }))
    .filter((col) => col.panes.length > 0);
}

// Removes the tab from its pane. If the pane becomes empty, the pane is
// dropped (and its column too if empty). Returns the new layout.
export function closeTab(taskId: string, paneId: string, tabId: string) {
  const layout = states.get(taskId);
  if (!layout) return;
  const columns = pruneEmpty(
    layout.columns.map((col) => ({
      ...col,
      panes: col.panes.map((pane) => {
        if (pane.id !== paneId) return pane;
        const tabs = pane.tabs.filter((t) => t.id !== tabId);
        const activeTabId =
          pane.activeTabId === tabId ? tabs[0]?.id ?? '' : pane.activeTabId;
        return { ...pane, tabs, activeTabId };
      }),
    }))
  );
  if (columns.length === 0) {
    setLayout(taskId, { columns: [], focusedPaneId: '' });
    return;
  }
  let focusedPaneId = layout.focusedPaneId;
  if (!columns.some((c) => c.panes.some((p) => p.id === focusedPaneId))) {
    focusedPaneId = columns[0].panes[0].id;
  }
  setLayout(taskId, { columns, focusedPaneId });
}

// Move a tab from its current pane to a brand-new column on the given side.
// Caps at 2 columns. Returns true on success.
export function splitColumn(
  taskId: string,
  payload: PaneTabDragPayload,
  side: 'left' | 'right'
): boolean {
  const layout = states.get(taskId);
  if (!layout || layout.columns.length >= 2) return false;
  const located = findPaneContaining(layout, payload.tabId);
  if (!located) return false;
  // Removing the only tab from a column-only pane shouldn't leave 0 panes:
  // if the source pane has only this tab and we'd end up with 0 columns when
  // adding the new one, we'd just be moving a column to the side — pointless.
  if (located.pane.tabs.length === 1 && layout.columns.length === 1 && located.col.panes.length === 1) {
    return false;
  }
  const detachedTab: PaneTab = { id: payload.tabId, ref: payload.ref };
  const sourcePanes: Pane[] = located.col.panes
    .map((pane) => {
      if (pane.id !== located.pane.id) return pane;
      const tabs = pane.tabs.filter((t) => t.id !== payload.tabId);
      const activeTabId = tabs.some((t) => t.id === pane.activeTabId)
        ? pane.activeTabId
        : tabs[0]?.id ?? '';
      return { ...pane, tabs, activeTabId };
    })
    .filter((p) => p.tabs.length > 0);

  const sourceColumn: PaneColumn = { ...located.col, panes: sourcePanes };
  const newPane = makePane([detachedTab]);
  const newColumn = makeColumn([newPane]);

  const remainingColumns = layout.columns.map((c) => (c.id === located.col.id ? sourceColumn : c)).filter((c) => c.panes.length > 0);
  const columns = side === 'left' ? [newColumn, ...remainingColumns] : [...remainingColumns, newColumn];
  setLayout(taskId, { columns, focusedPaneId: newPane.id });
  return true;
}

// Move a tab into a new pane stacked above or below `targetPaneId` within the
// same column. Caps that column at 2 panes.
export function splitRow(
  taskId: string,
  payload: PaneTabDragPayload,
  targetPaneId: string,
  side: 'top' | 'bottom'
): boolean {
  const layout = states.get(taskId);
  if (!layout) return false;
  const targetCol = layout.columns.find((c) => c.panes.some((p) => p.id === targetPaneId));
  if (!targetCol || targetCol.panes.length >= 2) return false;
  const located = findPaneContaining(layout, payload.tabId);
  if (!located) return false;
  if (located.pane.tabs.length === 1 && located.pane.id === targetPaneId) return false;

  const detachedTab: PaneTab = { id: payload.tabId, ref: payload.ref };
  const newPane = makePane([detachedTab]);
  const targetIdx = targetCol.panes.findIndex((p) => p.id === targetPaneId);
  const insertAt = side === 'top' ? targetIdx : targetIdx + 1;

  const updatedColumns = layout.columns.map((col) => {
    // Detach the tab from wherever it lived.
    const panes = col.panes
      .map((pane) => {
        if (pane.id !== located.pane.id) return pane;
        const tabs = pane.tabs.filter((t) => t.id !== payload.tabId);
        const activeTabId = tabs.some((t) => t.id === pane.activeTabId)
          ? pane.activeTabId
          : tabs[0]?.id ?? '';
        return { ...pane, tabs, activeTabId };
      })
      .filter((p) => p.tabs.length > 0);
    if (col.id !== targetCol.id) return { ...col, panes };
    // Insert the new pane in the target column.
    const idx = panes.findIndex((p) => p.id === targetPaneId);
    const finalInsertAt =
      idx < 0 ? panes.length : side === 'top' ? idx : idx + 1;
    if (idx < 0 && insertAt !== panes.length) {
      panes.push(newPane);
    } else {
      panes.splice(finalInsertAt, 0, newPane);
    }
    return { ...col, panes };
  });

  const columns = pruneEmpty(updatedColumns);
  setLayout(taskId, { columns, focusedPaneId: newPane.id });
  return true;
}

// Move a tab from its pane into another existing pane. Used when the user
// drops a tab onto the tab strip of another pane (no split — just a transfer).
export function moveTabToPane(
  taskId: string,
  payload: PaneTabDragPayload,
  targetPaneId: string,
  insertIndex?: number
) {
  const layout = states.get(taskId);
  if (!layout) return;
  const target = findPane(layout, targetPaneId);
  if (!target) return;
  if (target.tabs.some((t) => t.id === payload.tabId)) {
    // Same pane: reorder.
    const without = target.tabs.filter((t) => t.id !== payload.tabId);
    const tab = target.tabs.find((t) => t.id === payload.tabId)!;
    const idx = insertIndex ?? without.length;
    const tabs = [...without.slice(0, idx), tab, ...without.slice(idx)];
    setLayout(taskId, {
      ...layout,
      focusedPaneId: target.id,
      columns: layout.columns.map((col) => ({
        ...col,
        panes: col.panes.map((p) => (p.id === target.id ? { ...p, tabs, activeTabId: tab.id } : p)),
      })),
    });
    return;
  }
  // Cross-pane: detach + insert.
  const detached: PaneTab = { id: payload.tabId, ref: payload.ref };
  const columns = pruneEmpty(
    layout.columns.map((col) => ({
      ...col,
      panes: col.panes.map((pane) => {
        if (pane.id === target.id) {
          const idx = insertIndex ?? pane.tabs.length;
          const tabs = [...pane.tabs.slice(0, idx), detached, ...pane.tabs.slice(idx)];
          return { ...pane, tabs, activeTabId: detached.id };
        }
        const tabs = pane.tabs.filter((t) => t.id !== payload.tabId);
        const activeTabId = tabs.some((t) => t.id === pane.activeTabId)
          ? pane.activeTabId
          : tabs[0]?.id ?? '';
        return { ...pane, tabs, activeTabId };
      }),
    }))
  );
  let focusedPaneId = target.id;
  if (!columns.some((c) => c.panes.some((p) => p.id === focusedPaneId))) {
    focusedPaneId = columns[0]?.panes[0]?.id ?? '';
  }
  setLayout(taskId, { columns, focusedPaneId });
}

export function usePaneLayout(taskId: string | null): PaneLayout {
  const sub = (cb: () => void) => (taskId ? subscribe(taskId, cb) : () => undefined);
  const get = () => {
    if (!taskId) return EMPTY_LAYOUT;
    let layout = states.get(taskId);
    if (!layout) {
      const persisted = loadPersistedLayout(taskId);
      if (persisted) {
        states.set(taskId, persisted);
        layout = persisted;
      }
    }
    return layout ?? EMPTY_LAYOUT;
  };
  return useSyncExternalStore(sub, get, get);
}

const EMPTY_LAYOUT: PaneLayout = { columns: [], focusedPaneId: '' };
