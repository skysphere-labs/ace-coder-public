/**
 * KnowledgeQuarantinePanel — owner review queue for quarantined knowledge.
 *
 * The nightly audit MOVES raw-tier offenders (secrets/contamination) into
 * quarantine/YYYY-MM-DD/ with reason sidecars. Nothing is ever deleted:
 *   • Approve — restore the file to its original path (or inbox/ if taken).
 *   • Reject  — move it under quarantine/rejected/ (kept on disk forever).
 * The resolve handler is rename-only by construction.
 */

import { useCallback, useEffect, useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import type { KnowledgeQuarantineItem } from '../../../lib/ace-api';
import { aceApi } from '../../../lib/ace-api';
import { formatRelativeTime } from '../../../lib/utils';
import { PanelShell } from '../atoms/PanelShell';
import { SectionHeader } from '../atoms/SectionHeader';
import { InfoTip } from '../atoms/InfoTip';
import { Chip } from '../atoms/Chip';
import { CountBadge } from '../atoms/CountBadge';
import { ErrorState } from '../atoms/states';
import { Button } from '../../ui/button';

export function KnowledgeQuarantinePanel() {
  const [items, setItems] = useState<KnowledgeQuarantineItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const [lastOutcome, setLastOutcome] = useState<string | null>(null);

  // No synchronous setLoading(true) here — initial state is loading, and
  // resolve-triggered refreshes update silently (react-hooks effect rule).
  const refresh = useCallback(() => {
    aceApi.knowledge
      .quarantineList()
      .then((result) => {
        setItems(result.ok ? (result.items ?? []) : []);
        setError(result.ok ? null : 'failed to list quarantine');
      })
      .catch((err) => setError(String(err?.message ?? err)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const resolve = useCallback(
    (item: KnowledgeQuarantineItem, action: 'approve' | 'reject') => {
      setBusyPath(item.path);
      aceApi.knowledge
        .quarantineResolve({ path: item.path, action })
        .then((result) => {
          if (result.ok) {
            setLastOutcome(
              action === 'approve'
                ? `Restored to ${result.restoredTo ?? 'original location'}`
                : `Moved to ${result.movedTo ?? 'quarantine/rejected/'} (kept on disk)`
            );
          } else {
            setLastOutcome(`Failed: ${result.error ?? 'unknown error'}`);
          }
        })
        .catch((err) => setLastOutcome(`Failed: ${String(err?.message ?? err)}`))
        .finally(() => {
          setBusyPath(null);
          refresh();
        });
    },
    [refresh]
  );

  // Render nothing until there's something to review — the quarantine is empty
  // in the common case, so an "empty" panel would just be clutter. The list
  // fetch is cheap; we still surface a real load error.
  if (loading || (!error && items.length === 0)) return null;

  return (
    <PanelShell>
      <SectionHeader
        title="Quarantine Review"
        icon={ShieldAlert}
        leading={items.length > 0 ? <CountBadge count={items.length} /> : null}
        actions={
          <InfoTip label="Raw-tier pages the nightly audit flagged for secrets or contamination. Approve restores the file; Reject parks it under quarantine/rejected/. Both are renames — nothing is ever deleted." />
        }
      />
      {error && <ErrorState message={error} />}
      {!error && items.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {items.map((item) => (
            <div
              key={item.path}
              className="flex flex-wrap items-center gap-2 rounded-md border border-amber-500/20 bg-amber-500/[0.04] px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="truncate font-mono text-xs text-foreground/85">
                    {item.originalPath ?? item.path}
                  </span>
                  <Chip tone="amber">{item.reason}</Chip>
                </div>
                {item.quarantinedAt && (
                  <p className="mt-0.5 text-[11px] text-foreground/45">
                    quarantined {formatRelativeTime(item.quarantinedAt)}
                  </p>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busyPath === item.path}
                  onClick={() => resolve(item, 'approve')}
                >
                  Approve
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-rose-200 hover:text-rose-100"
                  disabled={busyPath === item.path}
                  onClick={() => resolve(item, 'reject')}
                >
                  Reject
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
      {lastOutcome && <p className="text-[11px] text-foreground/50">{lastOutcome}</p>}
    </PanelShell>
  );
}
