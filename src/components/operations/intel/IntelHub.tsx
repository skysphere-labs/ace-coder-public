import { useEffect, useState } from 'react';
import { FileText, Radar, Rss } from 'lucide-react';
import type { OpsBrief } from '../../../lib/ace-api';
import { aceApi } from '../../../lib/ace-api';
import type { SliceState } from '../../../runtime/operations-registry';
import { SegmentedControl, type SegmentedOption } from '../molecules/SegmentedControl';
import { BriefsTab } from '../organisms/BriefsTab';
import { VectorOpsPanel } from '../organisms/VectorOpsPanel';
import { SourcesPanel } from '../organisms/SourcesPanel';

// ─── IntelHub ─────────────────────────────────────────────────────────────────
// WS-C: one Intelligence surface unifying what used to be three sibling tabs —
// Brief, Intel (the full Vector Ops dashboard), and Sources (the watchlist
// editor). It COMPOSES the existing organisms as children (no rewrite): each
// still owns its data, freshness, provenance/judged badges (VectorOpsPanel),
// broken-source visibility (SourcesPanel), and Send-to-King (IntelItemRow). A
// segmented sub-nav switches between them within one scroll surface so the
// dense organisms don't stack into an unreadable column.
//
// Exported as a named export; the IntelScreen top-level surface mounts it on
// desktop, and the existing child organisms keep their own exports.

type HubView = 'brief' | 'intel' | 'sources';

const HUB_OPTIONS: SegmentedOption<HubView>[] = [
  { value: 'brief', label: 'Brief', icon: FileText },
  { value: 'intel', label: 'Intel', icon: Radar },
  { value: 'sources', label: 'Sources', icon: Rss },
];

export function IntelHub({ initialView = 'intel' }: { initialView?: HubView } = {}) {
  const [view, setView] = useState<HubView>(initialView);

  // Seed the Brief sub-view's slice by fetching the morning brief (BriefsTab
  // drives the other lenses + regenerate itself). setState lives inside the
  // async .then/.catch under a cancelled guard, never synchronously in the
  // effect (react-hooks/set-state-in-effect).
  const [briefSlice, setBriefSlice] = useState<SliceState<OpsBrief | null>>({
    status: 'loading',
    data: null,
    error: null,
  });
  useEffect(() => {
    let cancelled = false;
    aceApi.ops
      .brief({ lens: 'morning' })
      .then((brief) => {
        if (!cancelled) setBriefSlice({ status: 'ready', data: brief, error: null });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setBriefSlice({
            status: 'error',
            data: null,
            error: err instanceof Error ? err.message : 'Failed to load brief.',
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex items-center gap-2 px-5 pt-4">
        <SegmentedControl
          options={HUB_OPTIONS}
          value={view}
          onChange={setView}
          ariaLabel="Intelligence view"
        />
      </div>
      {/* One scroll surface for whichever child is active. The children are
          built to mount inside a scroller (VectorOpsPanel embedded, BriefsTab
          and SourcesPanel own no scroll). */}
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {view === 'brief' && <BriefsTab slice={briefSlice} />}
        {view === 'intel' && <VectorOpsPanel embedded />}
        {view === 'sources' && <SourcesPanel />}
      </div>
    </div>
  );
}
