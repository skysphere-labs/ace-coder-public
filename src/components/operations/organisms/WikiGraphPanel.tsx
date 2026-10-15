/**
 * WikiGraphPanel — browser-first wiki (PRD v2 D12) + demoted graph + reader.
 *
 * Two sub-views toggled by the shared SegmentedControl (Browser is the
 * DEFAULT — the graph is a secondary visualization, not the front door):
 *   • Browser — quiet folder tree: hairline-free 13px rows, hover fill only,
 *     freshness as a tiny color dot with a title tooltip (color+title pairing
 *     for accessibility) instead of a chip per row.
 *   • Graph   — deterministic SVG radial/cluster layout. Motion is a CSS
 *     keyframe drift per node (no rAF re-render loop); freshness fill opacity
 *     stays CONSTANT so the data encoding never flickers. Stats line + legend
 *     live only inside this view.
 *
 * Selecting a node (graph dot, browser row, or backlink chip) opens the
 * PageReader — a reading surface (15px/1.65 body, ~70ch measure, clean
 * heading hierarchy): real markdown content via aceApi.ops.wikiPage,
 * metadata behind a Details disclosure, and Reveal-in-Finder (ops.wikiReveal).
 *
 * Search lives in the panel header so it works in BOTH views; in Graph view
 * matches highlight and non-matches dim to 0.25.
 *
 * confidence is ALWAYS labeled "heuristic" per rubric R8 (with an InfoTip).
 * prefers-reduced-motion is respected: all graph motion collapses to static.
 *
 * Dependency-free SVG — no d3/vis/cytoscape.
 */

import { useState, useEffect, useMemo, useCallback, memo } from 'react';
import { BookOpen, ChevronDown, ChevronRight, FolderOpen, GitFork, Search, X } from 'lucide-react';
import type { OpsWikiGraph, OpsWikiNode, OpsWikiPage } from '../../../lib/ace-api';
import { aceApi } from '../../../lib/ace-api';
import { cn, formatRelativeTime } from '../../../lib/utils';
import { DisclosureRow } from '../atoms/DisclosureRow';
import { PanelShell } from '../atoms/PanelShell';
import { SectionHeader } from '../atoms/SectionHeader';
import { LoadingState, ErrorState, EmptyState } from '../atoms/states';
import { Chip, type ChipTone } from '../atoms/Chip';
import { CountBadge } from '../atoms/CountBadge';
import { Eyebrow } from '../atoms/Eyebrow';
import { InfoTip } from '../atoms/InfoTip';
import { FreshnessLabel } from '../atoms/FreshnessLabel';
import { SegmentedControl } from '../molecules/SegmentedControl';
import { Button } from '../../ui/button';
import { Markdown } from '../../ace-chat/render';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type View = 'graph' | 'browser';

interface NodePosition {
  id: string;
  x: number;
  y: number;
  /** base radius (clamped 3–9) */
  r: number;
  /** index used for drift phase offset */
  i: number;
}

interface ClusterCaption {
  folder: string;
  x: number;
  y: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SVG_W = 800;
const SVG_H = 560;
const CX = SVG_W / 2;
const CY = SVG_H / 2;
const OUTER_RADIUS = 220;
const INNER_RADIUS = 60;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Clamp a value to [min, max]. */
function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}

/** Extract the top-level folder from a node path. */
function topFolder(path: string): string {
  const slash = path.indexOf('/');
  return slash === -1 ? '__root__' : path.slice(0, slash);
}

/** Human label for a folder group ('__root__' = pages at the wiki root). */
function folderLabel(folder: string): string {
  return folder === '__root__' ? 'root' : folder;
}

/** Single freshness → color truth: graph node fill, tree/reader dots, and
    tooltip text all derive from one map. */
const FRESHNESS_META: Record<
  OpsWikiNode['freshness'],
  { hex: string; text: string }
> = {
  fresh:   { hex: '#34d399', text: 'text-emerald-200' }, // emerald-400
  stale:   { hex: '#fbbf24', text: 'text-amber-200'   }, // amber-400
  expired: { hex: '#fb7185', text: 'text-rose-200'    }, // rose-400
  unknown: { hex: '#71717a', text: 'text-foreground/70' }, // zinc-500
};

/** Legend color chip label. */
const FRESHNESS_LEGEND: { freshness: OpsWikiNode['freshness']; label: string }[] = [
  { freshness: 'fresh',   label: 'Fresh'   },
  { freshness: 'stale',   label: 'Stale'   },
  { freshness: 'expired', label: 'Expired' },
  { freshness: 'unknown', label: 'Unknown' },
];

/** Knowledge-plane trust tier → color truth (matches the search panel chips:
 *  canon emerald > working sky > external violet > raw amber). */
const TRUST_META: Record<
  OpsWikiNode['trust'],
  { hex: string; tone: ChipTone; text: string }
> = {
  canon:    { hex: '#34d399', tone: 'emerald', text: 'text-emerald-200' }, // emerald-400
  working:  { hex: '#38bdf8', tone: 'sky',     text: 'text-sky-200'     }, // sky-400
  external: { hex: '#a78bfa', tone: 'neutral', text: 'text-violet-200'  }, // violet-400
  raw:      { hex: '#fbbf24', tone: 'amber',   text: 'text-amber-200'   }, // amber-400
};

const TRUST_LEGEND: { trust: OpsWikiNode['trust']; label: string }[] = [
  { trust: 'canon',    label: 'Canon'   },
  { trust: 'working',  label: 'Working' },
  { trust: 'external', label: 'Hermes'  },
  { trust: 'raw',      label: 'Raw'     },
];

/** Node bubble color encoding: page trust tier or page freshness. */
type ColorMode = 'trust' | 'freshness';
const COLOR_MODE_OPTIONS: { value: ColorMode; label: string }[] = [
  { value: 'trust',     label: 'Trust' },
  { value: 'freshness', label: 'Freshness' },
];

/** Truncate a node title for in-graph labels. */
function truncateLabel(title: string): string {
  return title.length > 24 ? `${title.slice(0, 23)}…` : title;
}

/** Labeled byte size for the page reader ("size 4.2 KB"). */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Honest, user-facing copy for ops.wikiPage failure codes. */
function wikiPageErrorMessage(code: Extract<OpsWikiPage, { ok: false }>['error']): string {
  switch (code) {
    case 'not-found':
      return 'Page file not found on disk — the graph index may be out of date.';
    case 'not-markdown':
      return 'This entry is not a markdown page, so it cannot be rendered here.';
    case 'path-escape':
    case 'invalid-args':
      return 'This path cannot be opened from the wiki viewer.';
    case 'read-error':
    default:
      return 'Could not read the page file.';
  }
}

/** Shared query → matching-node predicate (browser filter + graph highlight). */
function nodeMatches(node: OpsWikiNode, q: string): boolean {
  return (
    node.title.toLowerCase().includes(q) ||
    node.path.toLowerCase().includes(q) ||
    node.tags.some((t) => t.toLowerCase().includes(q))
  );
}

/**
 * Deterministic radial/cluster layout.
 * Groups nodes by top-level folder, places cluster centres around a large
 * circle, then distributes nodes within each cluster on a smaller ring.
 * Uses node index for a seeded angle so layout is stable across renders.
 * Also emits a caption position per cluster so the spatial grouping is
 * legible (folder name rendered above each cluster).
 */
function computeLayout(nodes: OpsWikiNode[]): {
  positions: NodePosition[];
  clusters: ClusterCaption[];
} {
  if (nodes.length === 0) return { positions: [], clusters: [] };

  // Group by folder
  const groups = new Map<string, OpsWikiNode[]>();
  for (const node of nodes) {
    const folder = topFolder(node.path);
    if (!groups.has(folder)) groups.set(folder, []);
    groups.get(folder)!.push(node);
  }

  const folders = Array.from(groups.keys()).sort();
  const numFolders = folders.length;
  const positions: NodePosition[] = [];
  const clusters: ClusterCaption[] = [];
  let globalIndex = 0;

  folders.forEach((folder, fi) => {
    const clusterAngle = (2 * Math.PI * fi) / numFolders - Math.PI / 2;
    const clusterX = CX + OUTER_RADIUS * Math.cos(clusterAngle);
    const clusterY = CY + OUTER_RADIUS * Math.sin(clusterAngle);
    const members = groups.get(folder)!;
    const numMembers = members.length;

    let sumX = 0;
    let minY = Number.POSITIVE_INFINITY;

    members.forEach((node, mi) => {
      let x: number;
      let y: number;

      if (numMembers === 1) {
        x = clusterX;
        y = clusterY;
      } else {
        // Spread members on a smaller arc around the cluster centre.
        // Use a deterministic angle derived from member index.
        const memberAngle = clusterAngle + (2 * Math.PI * mi) / numMembers;
        x = clusterX + INNER_RADIUS * Math.cos(memberAngle);
        y = clusterY + INNER_RADIUS * Math.sin(memberAngle);
      }

      // Clamp to SVG bounds with padding.
      x = clamp(x, 14, SVG_W - 14);
      y = clamp(y, 14, SVG_H - 14);

      const r = clamp(3 + node.backlinks * 0.5, 3, 9);

      positions.push({ id: node.id, x, y, r, i: globalIndex });
      globalIndex++;
      sumX += x;
      minY = Math.min(minY, y);
    });

    clusters.push({
      folder,
      x: clamp(sumX / numMembers, 30, SVG_W - 30),
      y: clamp(minY - 16, 12, SVG_H - 12),
    });
  });

  return { positions, clusters };
}

// ---------------------------------------------------------------------------
// Atoms / sub-components
// ---------------------------------------------------------------------------

/**
 * Tiny freshness dot — replaces the per-row freshness Chip in the quiet tree
 * (D12). Color is never the only channel: the title tooltip + aria-label name
 * the freshness state (and last-updated time when known).
 */
function FreshnessDot({
  freshness,
  updatedAt,
}: {
  freshness: OpsWikiNode['freshness'];
  updatedAt: string | null;
}) {
  const label = `${freshness}${updatedAt ? ` · updated ${formatRelativeTime(updatedAt)}` : ''}`;
  return (
    <span
      role="img"
      aria-label={`freshness: ${label}`}
      title={`freshness: ${label}`}
      className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
      style={{ background: FRESHNESS_META[freshness].hex }}
    />
  );
}

/**
 * Heuristic confidence mini-bar — the SINGLE rendition (browser rows dropped
 * their inline duplicate). ALWAYS labeled "heuristic" per rubric R8, with an
 * InfoTip explaining what is being estimated.
 */
function ConfidenceBar({ confidence }: { confidence: number }) {
  const pct = clamp(confidence * 100, 0, 100);
  return (
    <div className="flex items-center gap-1.5">
      <span className="shrink-0 text-xs text-foreground/65">confidence · heuristic</span>
      <InfoTip label="Heuristic estimate derived from page freshness and backlinks — not a measured value." />
      <div className="relative h-1 w-20 flex-1 rounded-full bg-white/[0.06]">
        <div
          className="absolute left-0 top-0 h-1 rounded-full bg-sky-400/60"
          style={{ width: `${pct}%` }}
          aria-label={`${Math.round(pct)}% (heuristic)`}
        />
      </div>
      <span className="shrink-0 text-xs tabular-nums text-foreground/75">{Math.round(pct)}%</span>
    </div>
  );
}

/** Clickable neighbor link chip — module scope (stable reference). */
function NeighborChip({
  node,
  onSelect,
}: {
  node: OpsWikiNode | undefined;
  onSelect: (id: string) => void;
}) {
  if (!node) return null;
  return (
    <button
      type="button"
      onClick={() => onSelect(node.id)}
      className="inline-flex max-w-full items-center rounded border border-white/[0.08] bg-white/[0.03] px-2 py-0.5 text-xs text-sky-200 transition-colors duration-150 hover:border-sky-400/30 hover:bg-sky-500/[0.06] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sky-400/60"
      title={node.path}
    >
      <span className="truncate">{node.title}</span>
    </button>
  );
}

/** Bounded lists (C5): neighbor chip lists cap at this many visible chips. */
const NEIGHBOR_CHIP_CAP = 5;

/**
 * Capped neighbor chip list — at most NEIGHBOR_CHIP_CAP chips, with a
 * "Show all N" toggle when there are more. Lives inside PageReader (which is
 * keyed by node.id), so the toggle resets per page. Renders nothing for an
 * empty id list, preserving the old conditional-section behavior.
 */
function NeighborChipList({
  heading,
  ids,
  nodeById,
  onSelect,
}: {
  heading: string;
  ids: string[];
  nodeById: Map<string, OpsWikiNode>;
  onSelect: (id: string) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  if (ids.length === 0) return null;
  const shown = showAll ? ids : ids.slice(0, NEIGHBOR_CHIP_CAP);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold text-foreground/65">
          {heading} ({ids.length})
        </p>
        {ids.length > NEIGHBOR_CHIP_CAP && (
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={showAll}
            onClick={() => setShowAll((v) => !v)}
            className="h-6 px-2 text-xs text-foreground/70"
          >
            {showAll ? 'Show less' : `Show all ${ids.length}`}
          </Button>
        )}
      </div>
      <div className="flex flex-wrap gap-1">
        {shown.map((id) => (
          <NeighborChip key={id} node={nodeById.get(id)} onSelect={onSelect} />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page reader (replaces the metadata-only detail strip)
// ---------------------------------------------------------------------------

type PageState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; page: Extract<OpsWikiPage, { ok: true }> };

interface PageReaderProps {
  node: OpsWikiNode;
  graph: OpsWikiGraph;
  onSelectNode: (id: string | null) => void;
  onClose: () => void;
}

// Keyed by node.id at the call site, so state resets per page (the effect
// only calls setState inside async callbacks — no setState-in-effect).
const PageReader = memo(function PageReader({
  node,
  graph,
  onSelectNode,
  onClose,
}: PageReaderProps) {
  const [pageState, setPageState] = useState<PageState>({ status: 'loading' });
  const [revealError, setRevealError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    aceApi.ops
      .wikiPage({ relPath: node.path })
      .then((res) => {
        if (cancelled) return;
        if (res.ok) setPageState({ status: 'ready', page: res });
        else setPageState({ status: 'error', message: wikiPageErrorMessage(res.error) });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setPageState({
          status: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [node.path]);

  const handleReveal = useCallback(() => {
    setRevealError(null);
    aceApi.ops
      .wikiReveal({ relPath: node.path })
      .then((res) => {
        if (!res.ok) setRevealError(res.error ?? 'the file may be missing on disk');
      })
      .catch((err: unknown) => {
        setRevealError(err instanceof Error ? err.message : String(err));
      });
  }, [node.path]);

  const outgoing = useMemo(
    () => graph.edges.filter((e) => e.from === node.id).map((e) => e.to),
    [graph.edges, node.id]
  );
  const incoming = useMemo(
    () => graph.edges.filter((e) => e.to === node.id).map((e) => e.from),
    [graph.edges, node.id]
  );
  const nodeById = useMemo(() => {
    const m = new Map<string, OpsWikiNode>();
    for (const n of graph.nodes) m.set(n.id, n);
    return m;
  }, [graph.nodes]);

  const title = pageState.status === 'ready' ? pageState.page.title : node.title;
  const mtime = pageState.status === 'ready' ? pageState.page.mtime : node.updatedAt;

  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-lg border border-white/[0.06] bg-white/[0.03] p-4">
      {/* Title row (D12): minimal — freshness dot + title + Reveal + Close.
          Path/provenance/size move behind the Details disclosure below. */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2 py-0.5">
          <FreshnessDot freshness={node.freshness} updatedAt={mtime} />
          <p className="truncate text-[15px] font-semibold text-foreground" title={node.path}>
            {title}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            onClick={handleReveal}
            className="h-7 gap-1 px-2 text-xs"
          >
            <FolderOpen className="h-3.5 w-3.5 text-foreground/60" aria-hidden="true" />
            Reveal in Finder
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            aria-label="Close page"
            className="h-7 w-7"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
      {revealError && (
        <p className="text-xs text-rose-200">Could not reveal in Finder — {revealError}.</p>
      )}

      {/* Details (C1): path/provenance/updated/size/backlinks + tags sit
          behind a collapsed disclosure so the surface reads like a document.
          User choice persists via storageKey. */}
      <DisclosureRow label="Details" storageKey="wiki.reader.details">
        <p className="truncate font-mono text-xs text-foreground/60" title={node.path}>
          {node.path}
        </p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <FreshnessLabel timestamp={mtime} prefix="updated" />
          {pageState.status === 'ready' && (
            <span className="text-xs tabular-nums text-foreground/60">
              size {formatBytes(pageState.page.sizeBytes)}
            </span>
          )}
          <span className="text-xs text-foreground/60">
            <span className="tabular-nums text-foreground/85">{node.backlinks}</span> backlink
            {node.backlinks !== 1 ? 's' : ''}
          </span>
          <span className="inline-flex items-center gap-1">
            <Chip>{node.provenance}</Chip>
            <InfoTip label="Provenance: whether this page was distilled by an agent, written raw, or a mix of both." />
          </span>
        </div>
        {node.tags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {node.tags.map((tag) => (
              <Chip key={tag}>#{tag}</Chip>
            ))}
          </div>
        )}
      </DisclosureRow>

      {/* Confidence (heuristic) */}
      <ConfidenceBar confidence={node.confidence} />

      {/* Outgoing neighbors — capped at 5 with Show-all (C5) */}
      <NeighborChipList
        heading="Links to"
        ids={outgoing}
        nodeById={nodeById}
        onSelect={onSelectNode}
      />

      {/* Incoming neighbors (backlinks — clickable, opens that page) */}
      <NeighborChipList
        heading="Linked from"
        ids={incoming}
        nodeById={nodeById}
        onSelect={onSelectNode}
      />

      {/* Page body — a reading surface (D12/D4): 15px/1.65 body capped at a
          ~70ch measure, h1 stepped up to 18px, relaxed lists, and quiet code
          blocks. The arbitrary-variant overrides win over the chat Markdown
          defaults by descendant-selector specificity. */}
      <div className="border-t border-white/[0.06] pt-3">
        {pageState.status === 'loading' && <LoadingState label="Opening page…" />}
        {pageState.status === 'error' && <ErrorState message={pageState.message} />}
        {pageState.status === 'ready' && (
          <div className="max-h-[60vh] min-w-0 overflow-y-auto pr-2">
            <div className="max-w-[70ch] text-[15px] leading-[1.65] text-foreground/90 [&_h1]:text-[18px] [&_li]:leading-[1.65] [&_pre]:bg-white/[0.04]">
              <Markdown>{pageState.page.content}</Markdown>
            </div>
          </div>
        )}
      </div>
    </div>
  );
});

// ---------------------------------------------------------------------------
// Graph view
// ---------------------------------------------------------------------------

interface GraphViewProps {
  graph: OpsWikiGraph;
  query: string;
  selectedId: string | null;
  onSelectNode: (id: string | null) => void;
  colorMode: ColorMode;
}

const GraphView = memo(function GraphView({
  graph,
  query,
  selectedId,
  onSelectNode,
  colorMode,
}: GraphViewProps) {
  // Detect prefers-reduced-motion once — reduced motion = fully static layout.
  const prefersReducedMotion = useMemo(
    () =>
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    []
  );

  const [hoveredId, setHoveredId] = useState<string | null>(null);

  // Deterministic layout — computed once per graph identity.
  const { positions, clusters } = useMemo(() => computeLayout(graph.nodes), [graph.nodes]);

  // Quick lookup maps.
  const posMap = useMemo(() => {
    const m = new Map<string, NodePosition>();
    for (const p of positions) m.set(p.id, p);
    return m;
  }, [positions]);

  const nodeMap = useMemo(() => {
    const m = new Map<string, OpsWikiNode>();
    for (const n of graph.nodes) m.set(n.id, n);
    return m;
  }, [graph.nodes]);

  // Header search → highlight matches, dim non-matches to 0.25.
  const matchedIds = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    const s = new Set<string>();
    for (const n of graph.nodes) {
      if (nodeMatches(n, q)) s.add(n.id);
    }
    return s;
  }, [graph.nodes, query]);

  // Selection → connected edges light up, unrelated nodes dim to 0.3.
  const relatedIds = useMemo(() => {
    if (!selectedId) return null;
    const s = new Set<string>([selectedId]);
    for (const e of graph.edges) {
      if (e.from === selectedId) s.add(e.to);
      if (e.to === selectedId) s.add(e.from);
    }
    return s;
  }, [graph.edges, selectedId]);

  const clearHover = useCallback((id: string) => {
    setHoveredId((prev) => (prev === id ? null : prev));
  }, []);

  if (graph.nodes.length === 0) {
    return (
      <EmptyState
        label={`No wiki pages indexed — expected ${graph.root}`}
        hint="Run the wiki-graph-indexer to build the graph."
      />
    );
  }

  const { nodeCount, edgeCount, orphanCount } = graph.stats;
  const hoveredNode = hoveredId ? nodeMap.get(hoveredId) : null;
  const hoveredPos = hoveredId ? posMap.get(hoveredId) : null;

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {/* Stats line — every number labeled, orphans explained */}
      <div className="flex flex-wrap items-center gap-1">
        <p className="text-xs tabular-nums text-foreground/70">
          {nodeCount} nodes · {edgeCount} edges · {orphanCount} orphan
          {orphanCount !== 1 ? 's' : ''}
        </p>
        <InfoTip label="Orphans are pages with no links in or out." />
      </div>

      {/* SVG graph */}
      <div className="relative w-full overflow-hidden rounded-lg border border-white/[0.06] bg-white/[0.01]">
        {/* CSS drift keyframes — replaces the old rAF setState loop. Gated by
            the prefersReducedMotion check on each node's style. */}
        <style>{`@keyframes wiki-node-drift{0%,100%{transform:translate(0,0)}50%{transform:translate(2.5px,-2px)}}@keyframes wiki-ring-in{from{opacity:0}}`}</style>
        <svg
          viewBox={`0 0 ${SVG_W} ${SVG_H}`}
          width="100%"
          aria-label="Wiki knowledge graph"
          role="img"
          className="block"
          style={{ userSelect: 'none' }}
        >
          {/* Cluster captions — name the spatial grouping (sanctioned 11px eyebrow) */}
          <g aria-hidden="true">
            {clusters.map((c) => (
              <text
                key={c.folder}
                x={c.x}
                y={c.y}
                textAnchor="middle"
                fontSize={11}
                fontWeight={600}
                letterSpacing="0.06em"
                fill="white"
                fillOpacity={0.6}
                style={{ pointerEvents: 'none' }}
              >
                {folderLabel(c.folder).toUpperCase()}
              </text>
            ))}
          </g>

          {/* Edges — connected edges light up sky when a node is selected */}
          <g aria-hidden="true">
            {graph.edges.map((edge, ei) => {
              const from = posMap.get(edge.from);
              const to = posMap.get(edge.to);
              if (!from || !to) return null;
              const connected =
                selectedId !== null && (edge.from === selectedId || edge.to === selectedId);
              const bothMatch =
                matchedIds === null || (matchedIds.has(edge.from) && matchedIds.has(edge.to));
              const strokeOpacity = connected ? 0.5 : bothMatch ? 0.1 : 0.04;
              return (
                <line
                  key={`e-${ei}`}
                  x1={from.x}
                  y1={from.y}
                  x2={to.x}
                  y2={to.y}
                  stroke={connected ? '#38bdf8' : 'white'}
                  strokeOpacity={strokeOpacity}
                  strokeWidth={connected ? 1.25 : 1}
                  style={{ transition: 'stroke-opacity 150ms ease-out' }}
                />
              );
            })}
          </g>

          {/* Nodes */}
          <g>
            {positions.map((pos) => {
              const node = nodeMap.get(pos.id);
              if (!node) return null;
              const isSelected = selectedId === pos.id;
              const isHovered = hoveredId === pos.id;
              const isMatch = matchedIds?.has(pos.id) ?? false;

              // Dim priority: search non-match (0.25) > unrelated-to-selection (0.3).
              const groupOpacity =
                matchedIds && !matchedIds.has(pos.id)
                  ? 0.25
                  : relatedIds && !relatedIds.has(pos.id)
                  ? 0.3
                  : 1;

              const fill =
                colorMode === 'trust'
                  ? TRUST_META[node.trust]?.hex ?? FRESHNESS_META.unknown.hex
                  : FRESHNESS_META[node.freshness].hex;
              const showLabel =
                node.backlinks >= 2 || graph.nodes.length <= 25 || isSelected || isHovered;

              return (
                <g
                  key={pos.id}
                  role="button"
                  aria-label={`${node.title} — ${colorMode === 'trust' ? node.trust : node.freshness}`}
                  aria-pressed={isSelected}
                  tabIndex={0}
                  onClick={() => onSelectNode(isSelected ? null : pos.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onSelectNode(isSelected ? null : pos.id);
                    }
                  }}
                  onMouseEnter={() => setHoveredId(pos.id)}
                  onMouseLeave={() => clearHover(pos.id)}
                  onFocus={() => setHoveredId(pos.id)}
                  onBlur={() => clearHover(pos.id)}
                  style={{
                    cursor: 'pointer',
                    outline: 'none',
                    opacity: groupOpacity,
                    transition: 'opacity 150ms ease-out',
                    ...(prefersReducedMotion
                      ? {}
                      : {
                          animation: `wiki-node-drift ${5 + (pos.i % 3)}s ease-in-out infinite`,
                          animationDelay: `${(-(pos.i % 7) * 0.7).toFixed(1)}s`,
                        }),
                  }}
                >
                  {/* Selection ring */}
                  {isSelected && (
                    <circle
                      cx={pos.x}
                      cy={pos.y}
                      r={pos.r + 4}
                      fill="none"
                      stroke="#38bdf8"
                      strokeWidth={1.5}
                      strokeOpacity={0.6}
                      style={
                        prefersReducedMotion
                          ? undefined
                          : { animation: 'wiki-ring-in 150ms ease-out' }
                      }
                    />
                  )}
                  {/* Search-match highlight ring */}
                  {isMatch && !isSelected && (
                    <circle
                      cx={pos.x}
                      cy={pos.y}
                      r={pos.r + 3}
                      fill="none"
                      stroke="#38bdf8"
                      strokeWidth={1}
                      strokeOpacity={0.5}
                    />
                  )}
                  {/* Main node circle — fill opacity CONSTANT (no flicker) */}
                  <circle
                    cx={pos.x}
                    cy={pos.y}
                    r={isHovered ? pos.r * 1.25 : pos.r}
                    fill={fill}
                    fillOpacity={isHovered ? 1 : 0.85}
                    style={{ transition: 'r 120ms ease-out, fill-opacity 120ms ease-out' }}
                  />
                  {/* Node label — prominent nodes always, all nodes on hover */}
                  {showLabel && (
                    <text
                      x={pos.x}
                      y={pos.y + pos.r + 12}
                      textAnchor="middle"
                      fontSize={11}
                      fill="white"
                      fillOpacity={isHovered || isSelected ? 0.9 : 0.6}
                      style={{ pointerEvents: 'none' }}
                    >
                      {truncateLabel(node.title)}
                    </text>
                  )}
                </g>
              );
            })}
          </g>
        </svg>

        {/* Hover tooltip — title + freshness + excerpt (node.excerpt) */}
        {hoveredNode && hoveredPos && (
          <div
            role="tooltip"
            className="pointer-events-none absolute z-10 w-60 rounded-md border border-white/[0.10] bg-zinc-900/95 p-2.5 shadow-lg"
            style={{
              left: `${(hoveredPos.x / SVG_W) * 100}%`,
              top: `${(hoveredPos.y / SVG_H) * 100}%`,
              transform:
                hoveredPos.y < 140 ? 'translate(-50%, 14px)' : 'translate(-50%, calc(-100% - 12px))',
            }}
          >
            <p className="truncate text-[13px] font-medium text-foreground/90">
              {hoveredNode.title}
            </p>
            <p className="mt-0.5 text-xs text-foreground/60">
              <span className={TRUST_META[hoveredNode.trust]?.text ?? 'text-foreground/70'}>
                {hoveredNode.trust}
              </span>
              {' · '}
              <span className={FRESHNESS_META[hoveredNode.freshness].text}>
                {hoveredNode.freshness}
              </span>
              {hoveredNode.updatedAt
                ? ` · updated ${formatRelativeTime(hoveredNode.updatedAt)}`
                : ''}
              {` · ${hoveredNode.backlinks} backlink${hoveredNode.backlinks !== 1 ? 's' : ''}`}
            </p>
            {hoveredNode.excerpt && (
              <p className="mt-1 line-clamp-3 text-xs leading-relaxed text-foreground/70">
                {hoveredNode.excerpt}
              </p>
            )}
          </div>
        )}

        {/* Legend — color key + size key */}
        <div className="absolute bottom-3 left-3 flex flex-col gap-1">
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {(colorMode === 'trust'
              ? TRUST_LEGEND.map(({ trust, label }) => ({ key: trust, hex: TRUST_META[trust].hex, label }))
              : FRESHNESS_LEGEND.map(({ freshness, label }) => ({ key: freshness, hex: FRESHNESS_META[freshness].hex, label }))
            ).map(({ key, hex, label }) => (
              <div key={key} className="flex items-center gap-1.5">
                <span
                  className="inline-block h-2.5 w-2.5 rounded-full"
                  style={{ background: hex }}
                />
                <span className="text-xs text-foreground/75">{label}</span>
              </div>
            ))}
          </div>
          <p className="text-xs text-foreground/60">node size = backlinks</p>
        </div>
      </div>
    </div>
  );
});

// ---------------------------------------------------------------------------
// Browser view (Obsidian-style list, grouped by top-level folder)
// ---------------------------------------------------------------------------

type SortKey = 'title' | 'backlinks' | 'freshness';

// Module-scope so it's a stable reference (no useMemo dependency churn).
const FRESHNESS_ORDER: Record<OpsWikiNode['freshness'], number> = {
  fresh: 0,
  stale: 1,
  expired: 2,
  unknown: 3,
};

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: 'backlinks', label: 'Backlinks' },
  { value: 'freshness', label: 'Freshness' },
  { value: 'title',     label: 'A–Z' },
];

interface BrowserViewProps {
  graph: OpsWikiGraph;
  query: string;
  selectedId: string | null;
  onSelectNode: (id: string | null) => void;
}

const BrowserView = memo(function BrowserView({
  graph,
  query,
  selectedId,
  onSelectNode,
}: BrowserViewProps) {
  const [sortKey, setSortKey] = useState<SortKey>('backlinks');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q ? graph.nodes.filter((n) => nodeMatches(n, q)) : [...graph.nodes];

    list.sort((a, b) => {
      if (sortKey === 'backlinks') return b.backlinks - a.backlinks;
      if (sortKey === 'freshness') return FRESHNESS_ORDER[a.freshness] - FRESHNESS_ORDER[b.freshness];
      return a.title.localeCompare(b.title);
    });
    return list;
  }, [graph.nodes, query, sortKey]);

  // Group by top-level folder (root pages first), preserving sort order.
  const groups = useMemo(() => {
    const map = new Map<string, OpsWikiNode[]>();
    for (const node of filtered) {
      const folder = topFolder(node.path);
      if (!map.has(folder)) map.set(folder, []);
      map.get(folder)!.push(node);
    }
    return Array.from(map.entries()).sort(([a], [b]) => {
      if (a === '__root__') return -1;
      if (b === '__root__') return 1;
      return a.localeCompare(b);
    });
  }, [filtered]);

  const toggleFolder = useCallback((folder: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(folder)) next.delete(folder);
      else next.add(folder);
      return next;
    });
  }, []);

  const expandAll = useCallback(() => {
    setCollapsed(new Set());
  }, []);

  const collapseAll = useCallback(() => {
    setCollapsed(new Set(groups.map(([folder]) => folder)));
  }, [groups]);

  if (graph.nodes.length === 0) {
    return (
      <EmptyState
        label={`No wiki pages indexed — expected ${graph.root}`}
        hint="Run the wiki-graph-indexer to build the graph."
      />
    );
  }

  const searching = query.trim().length > 0;

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {/* Count + expand/collapse + sort controls */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1">
          <span className="text-xs tabular-nums text-foreground/60">
            {filtered.length} of {graph.nodes.length} pages
          </span>
          {/* Hidden while searching — search force-expands every folder, so
              these would be dead controls (C8). */}
          {!searching && (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={expandAll}
                className="h-6 px-2 text-xs text-foreground/70"
              >
                Expand all
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={collapseAll}
                className="h-6 px-2 text-xs text-foreground/70"
              >
                Collapse all
              </Button>
            </>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <Eyebrow>Sort</Eyebrow>
          <SegmentedControl
            size="sm"
            ariaLabel="Sort wiki pages"
            options={SORT_OPTIONS}
            value={sortKey}
            onChange={setSortKey}
          />
        </div>
      </div>

      {/* Grouped list */}
      {filtered.length === 0 ? (
        <EmptyState label="No pages match your search." />
      ) : (
        <div className="flex flex-col gap-2">
          {groups.map(([folder, members]) => {
            // Searching auto-expands so matches are never hidden.
            const open = searching || !collapsed.has(folder);
            return (
              <div key={folder} className="flex flex-col">
                <button
                  type="button"
                  aria-expanded={open}
                  onClick={() => toggleFolder(folder)}
                  className="flex items-center gap-1.5 rounded px-1 py-1 text-left transition-colors duration-150 hover:bg-white/[0.03] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sky-400/60"
                >
                  {open ? (
                    <ChevronDown className="h-3.5 w-3.5 shrink-0 text-foreground/40" aria-hidden="true" />
                  ) : (
                    <ChevronRight className="h-3.5 w-3.5 shrink-0 text-foreground/40" aria-hidden="true" />
                  )}
                  <Eyebrow>{folderLabel(folder)}</Eyebrow>
                  <CountBadge count={members.length} />
                </button>

                {/* Quiet tree rows (D12): hairline-free — hover fill only,
                    13px titles with generous line height, freshness as a tiny
                    dot+tooltip. Full path lives in the row tooltip. */}
                {open &&
                  members.map((node) => {
                    const isSelected = selectedId === node.id;
                    return (
                      <button
                        key={node.id}
                        type="button"
                        aria-pressed={isSelected}
                        onClick={() => onSelectNode(isSelected ? null : node.id)}
                        title={node.path}
                        className={cn(
                          'flex min-w-0 items-center gap-2 rounded px-2 py-1 pl-7 text-left transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sky-400/60',
                          isSelected ? 'bg-sky-500/[0.08]' : 'hover:bg-white/[0.04]'
                        )}
                      >
                        <FreshnessDot freshness={node.freshness} updatedAt={node.updatedAt} />
                        <span
                          className={cn(
                            'min-w-0 flex-1 truncate text-[13px] leading-6',
                            isSelected ? 'text-foreground' : 'text-foreground/80'
                          )}
                        >
                          {node.title}
                        </span>
                        <span
                          className="shrink-0 text-xs tabular-nums text-foreground/50"
                          title="pages that link to this page"
                        >
                          {node.backlinks}
                        </span>
                      </button>
                    );
                  })}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
});

// ---------------------------------------------------------------------------
// WikiGraphPanel (main export)
// ---------------------------------------------------------------------------

// Browser-first (D12): reading order matches the default view.
const VIEW_OPTIONS: { value: View; label: string; icon: typeof BookOpen }[] = [
  { value: 'browser', label: 'Browser', icon: BookOpen },
  { value: 'graph',   label: 'Graph',   icon: GitFork  },
];

export function WikiGraphPanel() {
  const [graph, setGraph] = useState<OpsWikiGraph | null>(null);
  const [status, setStatus] = useState<'loading' | 'error' | 'ready'>('loading');
  const [error, setError] = useState<string | null>(null);

  const [view, setView] = useState<View>('browser');
  const [colorMode, setColorMode] = useState<ColorMode>('trust');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  // Self-fetch on mount. Status initializes to 'loading'; the effect only calls
  // setState inside the async callbacks (avoids react-hooks/set-state-in-effect).
  useEffect(() => {
    let cancelled = false;
    aceApi.ops
      .wikiGraph()
      .then((g) => {
        if (cancelled) return;
        setGraph(g);
        setStatus('ready');
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setStatus('error');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Plain setter — views pass null explicitly to deselect, neighbor chips
  // always pass an id (so clicking a backlink never toggles the reader shut).
  const handleSelectNode = useCallback((id: string | null) => {
    setSelectedId(id);
  }, []);

  const selectedNode = useMemo(
    () => (graph && selectedId ? graph.nodes.find((n) => n.id === selectedId) ?? null : null),
    [graph, selectedId]
  );

  return (
    <PanelShell className="gap-4">
      <SectionHeader
        title="Wiki"
        icon={BookOpen}
        tone="amber"
        leading={
          graph ? (
            <span
              className="hidden min-w-0 truncate font-mono text-xs text-foreground/60 sm:inline"
              title={graph.root}
            >
              {graph.root}
            </span>
          ) : null
        }
        actions={
          <div className="flex items-center gap-2">
            {view === 'graph' && (
              <SegmentedControl
                ariaLabel="Node color encoding"
                options={COLOR_MODE_OPTIONS}
                value={colorMode}
                onChange={setColorMode}
              />
            )}
            <SegmentedControl
              ariaLabel="Wiki view"
              options={VIEW_OPTIONS}
              value={view}
              onChange={setView}
            />
          </div>
        }
      />

      {status === 'loading' && <LoadingState label="Indexing wiki graph…" />}
      {status === 'error' && (
        <ErrorState message={error ?? 'Failed to load wiki graph.'} />
      )}

      {status === 'ready' && graph && (
        <>
          {/* Header search — works in BOTH views (graph highlights matches) */}
          <div className="relative flex min-w-0 items-center">
            <Search
              className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-foreground/40"
              aria-hidden="true"
            />
            <input
              type="search"
              aria-label="Search wiki pages"
              placeholder="Search pages, tags, paths…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="h-9 w-full rounded-md border border-white/[0.06] bg-white/[0.02] pl-8 pr-3 text-[13px] text-foreground/85 placeholder:text-foreground/50 focus:outline-none focus:ring-1 focus:ring-sky-400/50"
            />
          </div>

          <div className="flex min-w-0 items-start gap-4">
            {/* Main view — crossfade on view switch */}
            <div
              key={view}
              className="min-w-0 flex-1 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-200"
            >
              {view === 'graph' ? (
                <GraphView
                  graph={graph}
                  query={query}
                  selectedId={selectedId}
                  onSelectNode={handleSelectNode}
                  colorMode={colorMode}
                />
              ) : (
                <BrowserView
                  graph={graph}
                  query={query}
                  selectedId={selectedId}
                  onSelectNode={handleSelectNode}
                />
              )}
            </div>

            {/* Page reader — slides in alongside the main view. Wider than the
                old w-96 so the 15px reading column gets a usable measure. */}
            {selectedNode && (
              <div className="w-full motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-right-2 motion-safe:duration-200 sm:w-[28rem] sm:shrink-0 xl:w-[32rem]">
                <PageReader
                  key={selectedNode.id}
                  node={selectedNode}
                  graph={graph}
                  onSelectNode={handleSelectNode}
                  onClose={() => setSelectedId(null)}
                />
              </div>
            )}
          </div>
        </>
      )}
    </PanelShell>
  );
}
