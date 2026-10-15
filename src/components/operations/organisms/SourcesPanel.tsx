import { useCallback, useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { OpsRefreshSource, OpsSources, OpsSourceStatus } from '../../../lib/ace-api';
import { aceApi } from '../../../lib/ace-api';
import { cn, formatRelativeTime } from '../../../lib/utils';
import { Button } from '../../ui/button';
import { Input } from '../../ui/input';
import { Chip, type ChipTone } from '../atoms/Chip';
import { CountBadge } from '../atoms/CountBadge';
import { InfoTip } from '../atoms/InfoTip';
import { PanelShell } from '../atoms/PanelShell';
import { SectionHeader } from '../atoms/SectionHeader';
import { LoadingState, ErrorState, EmptyState } from '../atoms/states';

// ─── Types ────────────────────────────────────────────────────────────────────

type WatchlistKey = keyof OpsSources['watchlists'];

// Per-source refresh state chip: ok keeps the freshness-green token; every
// degrade is amber (degraded/recoverable — rose stays reserved for freshness
// chips + price deltas).
const STATUS_TONE: Record<OpsSourceStatus, ChipTone> = {
  ok: 'emerald',
  error: 'amber',
  'auth-needed': 'amber',
  unavailable: 'amber',
};
const STATUS_LABEL: Record<OpsSourceStatus, string> = {
  ok: 'ok',
  error: 'error',
  'auth-needed': 'auth needed',
  unavailable: 'unavailable',
};

// Watchlist entry → refresh-engine source id (electron/ops-refresh.cts
// registry derivation): feeds/repos are per-entry native sources; accounts and
// changelogs ride ONE aggregate research-agent source each, so every row in
// those groups shares (and honestly shows) the same agent state.
function sourceIdFor(key: WatchlistKey, entry: string): string {
  if (key === 'feeds') return `feed:${entry}`;
  if (key === 'repos') return `repo:${entry}`;
  return key === 'accounts' ? 'agent:social' : 'agent:vendors';
}

// `mono` marks groups whose entries are machine identifiers (URLs, owner/repo
// slugs) — those render in the 13px mono token; accounts stay proportional.
const WATCHLIST_GROUPS: {
  key: WatchlistKey;
  label: string;
  placeholder: string;
  mono: boolean;
}[] = [
  { key: 'feeds', label: 'Feeds', placeholder: 'https://example.com/feed.xml', mono: true },
  { key: 'accounts', label: 'Accounts', placeholder: '@handle or username', mono: false },
  { key: 'repos', label: 'Repos', placeholder: 'owner/repo', mono: true },
  { key: 'changelogs', label: 'Changelogs', placeholder: 'https://example.com/changelog', mono: true },
];

// ─── EntryRow ─────────────────────────────────────────────────────────────────
// One labeled list row per watchlist entry: 13px name, a real freshness cell
// (per-source status chip + last-success relative age from the refresh engine;
// '—' only when this entry has no tracked state yet — never blank), and a
// remove button at /60. Rows replaced the old 11px chip-cloud per the type
// standard.
function EntryRow({
  label,
  mono,
  state,
  onRemove,
  disabled,
}: {
  label: string;
  mono: boolean;
  state: OpsRefreshSource | null;
  onRemove: () => void;
  disabled: boolean;
}) {
  // FIX 2 (additive backend field): `broken` marks a misconfigured/dead entry
  // (invalid URL, 404) — a config problem the owner fixes here, distinct from a
  // transient `error`. Read via a local widening so ace-api stays untouched.
  const broken = state ? (state as OpsRefreshSource & { broken?: boolean }).broken === true : false;
  return (
    <div className="flex flex-col gap-1 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <span
          className={cn(
            'min-w-0 truncate text-foreground/90',
            mono ? 'font-mono text-code' : 'text-[13px]'
          )}
          title={label}
        >
          {label}
        </span>
        <div className="flex shrink-0 items-center gap-2">
          {state ? (
            <span className="flex items-center gap-1.5" title={state.error ?? undefined}>
              <Chip tone={STATUS_TONE[state.status]}>
                {broken ? 'broken' : STATUS_LABEL[state.status]}
              </Chip>
              <span
                className="text-xs tabular-nums text-foreground/60"
                title={state.lastSuccess ?? 'no successful pull yet'}
              >
                {state.lastSuccess ? formatRelativeTime(state.lastSuccess) : 'never'}
              </span>
            </span>
          ) : (
            <span
              className="text-xs text-foreground/40"
              title="No fetch state recorded for this entry yet"
              aria-label="Fetch status not tracked yet"
            >
              —
            </span>
          )}
          <Button
            variant="ghost"
            size="icon"
            onClick={onRemove}
            disabled={disabled}
            aria-label={`Remove ${label}`}
            className="h-5 w-5 shrink-0 p-0 text-foreground/60 hover:text-rose-400 focus-visible:ring-1 focus-visible:ring-sky-500/40"
          >
            <X className="h-3 w-3" aria-hidden="true" />
          </Button>
        </div>
      </div>
      {/* Broken entries surface their reason inline (actionable), not just on
          hover — the fix is to edit/remove this entry. */}
      {broken && state?.error && (
        <p className="max-w-[72ch] text-xs leading-snug text-amber-200/90">{state.error}</p>
      )}
    </div>
  );
}

// ─── WatchlistGroup ───────────────────────────────────────────────────────────
// One group section: a 'Feeds · 3' header (label + CountBadge), labeled list
// rows for existing entries, and an add-input + Add button row. Fires
// onRemove/onAdd callbacks upward so the parent can do the immutable-update +
// API write.
function WatchlistGroup({
  groupKey,
  label,
  placeholder,
  mono,
  entries,
  stateFor,
  onRemove,
  onAdd,
  busy,
}: {
  groupKey: WatchlistKey;
  label: string;
  placeholder: string;
  mono: boolean;
  entries: string[];
  stateFor: (key: WatchlistKey, entry: string) => OpsRefreshSource | null;
  onRemove: (key: WatchlistKey, value: string) => void;
  onAdd: (key: WatchlistKey, value: string) => void;
  busy: boolean;
}) {
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  function commitAdd() {
    const val = draft.trim();
    if (!val || busy) return;
    onAdd(groupKey, val);
    setDraft('');
    inputRef.current?.focus();
  }

  return (
    <div className="flex flex-col gap-2">
      {/* Group header: 'Feeds · 3' */}
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold text-foreground/70">{label}</span>
        <CountBadge count={entries.length} />
      </div>

      {/* Entry rows */}
      {entries.length === 0 ? (
        <p className="text-xs text-foreground/60">No entries yet — add one below.</p>
      ) : (
        <div
          className="flex flex-col divide-y divide-white/[0.05]"
          role="list"
          aria-label={`${label} entries`}
        >
          {entries.map((entry) => (
            <div key={entry} role="listitem">
              <EntryRow
                label={entry}
                mono={mono}
                state={stateFor(groupKey, entry)}
                onRemove={() => onRemove(groupKey, entry)}
                disabled={busy}
              />
            </div>
          ))}
        </div>
      )}

      {/* Add row */}
      <div className="flex items-center gap-2">
        <Input
          ref={inputRef}
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitAdd();
          }}
          placeholder={placeholder}
          disabled={busy}
          aria-label={`New ${label.toLowerCase()} entry`}
          className="h-8 min-w-0 flex-1 bg-white/[0.04] px-2.5 text-[13px] placeholder:text-foreground/45 focus-visible:ring-1 focus-visible:ring-sky-500/40 focus-visible:ring-offset-0"
        />
        <Button
          variant="outline"
          size="sm"
          onClick={commitAdd}
          disabled={!draft.trim() || busy}
          className="text-xs shrink-0"
        >
          Add
        </Button>
      </div>
    </div>
  );
}

// ─── SourcesPanel ─────────────────────────────────────────────────────────────
// Organism: self-fetching editable watchlist over latest.json source fields +
// local config. Renders 4 groups (Feeds / Accounts / Repos / Changelogs).
// Edits build an immutable-updated watchlists object and persist via
// aceApi.ops.sources.update — saved to local settings only.
export function SourcesPanel() {
  // ── Load state ──────────────────────────────────────────────────────────────
  const [sources, setSources] = useState<OpsSources | null>(null);
  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [loadError, setLoadError] = useState<string | null>(null);

  // busy = true while an update call is in-flight (disables all inputs)
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoadState('loading');
    setLoadError(null);
    try {
      const result = await aceApi.ops.sources.get();
      setSources(result);
      setLoadState('idle');
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load sources');
      setLoadState('error');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // ── Helpers: immutable watchlists update ──────────────────────────────────
  async function applyWatchlists(
    next: OpsSources['watchlists']
  ) {
    if (!sources || busy) return;
    setBusy(true);
    try {
      // update() returns only { watchlists, editableAt } — it omits the
      // additive `refresh` per-source state that get() attaches. Re-fetch so
      // the freshness chips + "Last pull" line survive an add/remove.
      await aceApi.ops.sources.update({ watchlists: next });
      setSources(await aceApi.ops.sources.get());
    } catch (err) {
      // Surface error without nuking existing state
      setLoadError(err instanceof Error ? err.message : 'Update failed');
      setLoadState('error');
    } finally {
      setBusy(false);
    }
  }

  function handleRemove(key: WatchlistKey, value: string) {
    if (!sources) return;
    const next: OpsSources['watchlists'] = {
      ...sources.watchlists,
      [key]: sources.watchlists[key].filter((v) => v !== value),
    };
    void applyWatchlists(next);
  }

  function handleAdd(key: WatchlistKey, value: string) {
    if (!sources) return;
    const trimmed = value.trim();
    if (!trimmed) return;
    // Deduplicate: skip if already present
    if (sources.watchlists[key].includes(trimmed)) return;
    const next: OpsSources['watchlists'] = {
      ...sources.watchlists,
      [key]: [...sources.watchlists[key], trimmed],
    };
    void applyWatchlists(next);
  }

  // ── Per-entry refresh state lookup (S3 refresh field — additive) ──────────
  const refreshState = sources?.refresh ?? null;
  const stateFor = useCallback(
    (key: WatchlistKey, entry: string): OpsRefreshSource | null => {
      if (!refreshState) return null;
      const id = sourceIdFor(key, entry);
      return refreshState.sources.find((s) => s.id === id) ?? null;
    },
    [refreshState]
  );

  // ── Edited stamp ────────────────────────────────────────────────────────────
  // The pipeline-provenance footnote moved into the header InfoTip — the
  // "edited <date>" stamp is the only header annotation (calm-by-default).
  function renderEditedStamp(src: OpsSources) {
    if (!src.editableAt) return null;
    const d = new Date(src.editableAt);
    const formatted = isNaN(d.getTime())
      ? src.editableAt
      : d.toLocaleString(undefined, {
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
        });
    return (
      <span className="text-xs font-normal text-foreground/60">
        edited {formatted}
      </span>
    );
  }

  return (
    <PanelShell>
      {/* Header */}
      <SectionHeader
        title="Sources"
        leading={sources ? renderEditedStamp(sources) ?? undefined : undefined}
        actions={
          <>
            <InfoTip label="The intel pipeline scans these watchlists on every sync — feeds, accounts, repos, and changelogs. Edits are saved to your local settings; the shipped defaults stay untouched." />
            {loadState === 'error' && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => { setLoadState('idle'); setLoadError(null); void load(); }}
                className="text-xs"
              >
                Retry
              </Button>
            )}
          </>
        }
      />

      {/* Persistence note */}
      <p className="text-xs leading-relaxed text-foreground/60">
        Saved to your local settings.
      </p>

      {/* Last refresh-engine run across the whole registry (S3). The age is
          the glanceable fact; the trigger word (scheduled/manual/startup) +
          raw timestamp live in the tooltip. */}
      {refreshState?.lastRunAt && (
        <p
          className="text-xs tabular-nums text-foreground/60"
          title={
            refreshState.lastTrigger
              ? `${refreshState.lastRunAt} · trigger: ${refreshState.lastTrigger}`
              : refreshState.lastRunAt
          }
        >
          Last pull: {formatRelativeTime(refreshState.lastRunAt) || refreshState.lastRunAt}
        </p>
      )}

      {/* Loading */}
      {loadState === 'loading' && <LoadingState />}

      {/* Error */}
      {loadState === 'error' && (
        <ErrorState
          message={loadError ?? 'Failed to load sources.'}
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={() => { setLoadState('idle'); setLoadError(null); void load(); }}
              className="text-xs mt-1"
            >
              Retry
            </Button>
          }
        />
      )}

      {/* Empty (loaded but all groups empty) */}
      {loadState === 'idle' && sources && (() => {
        const total =
          sources.watchlists.feeds.length +
          sources.watchlists.accounts.length +
          sources.watchlists.repos.length +
          sources.watchlists.changelogs.length;
        return total === 0 ? (
          <EmptyState
            label="No watchlist entries yet"
            hint="Add feeds, accounts, repos, or changelogs below."
          />
        ) : null;
      })()}

      {/* Groups */}
      {loadState === 'idle' && sources && (
        <div className="flex flex-col gap-4" aria-label="Watchlist groups">
          {WATCHLIST_GROUPS.map(({ key, label, placeholder, mono }) => (
            <div
              key={key}
              className="flex flex-col gap-2 rounded-md border border-white/[0.06] bg-white/[0.02] px-4 py-3"
            >
              <WatchlistGroup
                groupKey={key}
                label={label}
                placeholder={placeholder}
                mono={mono}
                entries={sources.watchlists[key]}
                stateFor={stateFor}
                onRemove={handleRemove}
                onAdd={handleAdd}
                busy={busy}
              />
            </div>
          ))}
        </div>
      )}
    </PanelShell>
  );
}
