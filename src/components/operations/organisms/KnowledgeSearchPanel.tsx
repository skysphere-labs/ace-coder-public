/**
 * KnowledgeSearchPanel — search the unified knowledge base from the UI.
 *
 * Same engine as `ace memory search` (one FTS5 index, two faces): ops
 * wiki + project wikis + dump intake + memory candidates + goal ledgers +
 * read-only Hermes memories. Ranked BM25 × trust × freshness × decay;
 * decayed/contaminated content is excluded unless the toggle is on.
 *
 * Debounced input; tier filter via SegmentedControl; rows expand inline.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { BrainCircuit, Search, X } from 'lucide-react';
import type { KnowledgeHit, KnowledgeStatus } from '../../../lib/ace-api';
import { aceApi } from '../../../lib/ace-api';
import { PanelShell } from '../atoms/PanelShell';
import { SectionHeader } from '../atoms/SectionHeader';
import { InfoTip } from '../atoms/InfoTip';
import { EmptyState, ErrorState } from '../atoms/states';
import { SegmentedControl } from '../molecules/SegmentedControl';
import { KnowledgeResultRow } from '../molecules/KnowledgeResultRow';

const TIER_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'canon', label: 'Canon' },
  { value: 'working', label: 'Working' },
  { value: 'external', label: 'Hermes' },
  { value: 'raw', label: 'Raw' },
];

const DEBOUNCE_MS = 250;

export function KnowledgeSearchPanel() {
  const [query, setQuery] = useState('');
  const [tier, setTier] = useState('all');
  const [includeDecayed, setIncludeDecayed] = useState(false);
  const [hits, setHits] = useState<KnowledgeHit[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [status, setStatus] = useState<KnowledgeStatus | null>(null);
  const requestSeq = useRef(0);

  useEffect(() => {
    aceApi.knowledge.status().then(setStatus).catch(() => {});
  }, []);

  useEffect(() => {
    const trimmed = query.trim();
    const seq = ++requestSeq.current;
    // All state updates run inside the (possibly zero-delay) timer so the
    // effect never sets state synchronously (react-hooks cascading-render rule).
    const timer = window.setTimeout(() => {
      if (!trimmed) {
        setHits([]);
        setTotal(0);
        setError(null);
        setSearching(false);
        return;
      }
      setSearching(true);
      aceApi.knowledge
        .search({
          query: trimmed,
          tier: tier === 'all' ? null : tier,
          includeDecayed,
          limit: 20,
        })
        .then((result) => {
          if (seq !== requestSeq.current) return;
          if (!result.ok) {
            setError(result.error ?? 'search failed');
            setHits([]);
            setTotal(0);
          } else {
            setError(null);
            setHits(result.results ?? []);
            setTotal(result.total ?? 0);
          }
        })
        .catch((err) => {
          if (seq !== requestSeq.current) return;
          setError(String(err?.message ?? err));
        })
        .finally(() => {
          if (seq === requestSeq.current) setSearching(false);
        });
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query, tier, includeDecayed]);

  const statusLine = useMemo(() => {
    if (!status?.ok) return null;
    const sources = (status.bySource ?? []).map((entry) => `${entry.source}: ${entry.n}`).join(' · ');
    return `${status.total ?? 0} docs indexed${sources ? ` (${sources})` : ''}`;
  }, [status]);

  return (
    <PanelShell>
      <SectionHeader
        title="Knowledge Search"
        icon={BrainCircuit}
        actions={
          <InfoTip label="One index across the ops wiki, project wikis, dump intake, memory candidates, goal ledgers, and read-only Hermes memories — the same engine agents use via `ace memory search`. Ranked BM25 × trust × freshness × decay." />
        }
      />
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[240px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-foreground/40" aria-hidden="true" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search the knowledge base…"
            className="w-full rounded-md border border-white/[0.08] bg-white/[0.03] py-1.5 pl-8 pr-8 text-[13px] text-foreground/90 placeholder:text-foreground/35 focus:border-sky-500/40 focus:outline-none"
            aria-label="Search the knowledge base"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-foreground/40 hover:text-foreground/70"
              aria-label="Clear search"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <SegmentedControl value={tier} onChange={setTier} options={TIER_OPTIONS} />
        <label className="flex items-center gap-1.5 text-xs text-foreground/60">
          <input
            type="checkbox"
            checked={includeDecayed}
            onChange={(event) => setIncludeDecayed(event.target.checked)}
            className="h-3.5 w-3.5 accent-rose-400"
          />
          include decayed
        </label>
      </div>
      {error && <ErrorState message={error} />}
      {!error && query.trim() && !searching && hits.length === 0 && (
        <EmptyState label="No knowledge matched. Try fewer words, or toggle decayed results for forensics." />
      )}
      {hits.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <p className="text-[11px] text-foreground/45">
            {total} match{total === 1 ? '' : 'es'}
            {searching ? ' · updating…' : ''}
          </p>
          {hits.map((hit) => (
            <KnowledgeResultRow key={hit.path} hit={hit} />
          ))}
        </div>
      )}
      {!query.trim() && statusLine && (
        <p className="text-[11px] text-foreground/40">{statusLine}</p>
      )}
    </PanelShell>
  );
}
