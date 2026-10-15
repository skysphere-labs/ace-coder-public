import { useEffect, useState } from 'react';
import { aceApi } from '../../lib/ace-api';
import type { RunLedgerBoard } from '../../lib/types';

// Shared run-ledger board fetch — lifted OUT of RunBoardPanel so the Board tab
// can read the same projection ONCE for both the attention strip and the board
// itself (no duplicate IPC). Event-driven: re-reads the pure, zero-token
// projection (aceApi.missions.runBoard) whenever the app pushes a state /
// git / stream event OR a run-ledger append settles ('ace:run-ledger-changed',
// which covers ledger writes that touch neither the store nor a pty stream,
// e.g. an external `ace run submit`), debounced so a burst coalesces into one
// read. A slow 30s poll is only a safety net for a missed event — never
// sub-minute; the ledger is the source of truth, not this poll. (Remote WS
// clients lack the ledger push channel and lean on the other three + the poll.)
//
// This hook owns the ONLY board fetch/subscription/poll: call it once (OpsTab).
export function useRunLedgerBoard(): { board: RunLedgerBoard | null; error: string | null } {
  const [board, setBoard] = useState<RunLedgerBoard | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    let debounce: number | null = null;
    const reload = () =>
      aceApi.missions
        .runBoard()
        .then((b) => {
          if (alive) {
            setBoard(b);
            setError(null);
          }
        })
        .catch((e) => {
          if (alive) setError(String((e && e.message) || e));
        });
    const schedule = () => {
      if (debounce != null) return;
      debounce = window.setTimeout(() => {
        debounce = null;
        reload();
      }, 350);
    };
    reload();
    const offState = aceApi.core.subscribe(() => schedule());
    const offGit = aceApi.core.onGitChanged(() => schedule());
    const offStream = aceApi.streams.onEvent(() => schedule());
    const offLedger = aceApi.core.onRunLedgerChanged(() => schedule());
    const poll = window.setInterval(reload, 30000);
    return () => {
      alive = false;
      try {
        offState?.();
      } catch {
        /* noop */
      }
      try {
        offGit?.();
      } catch {
        /* noop */
      }
      try {
        offStream?.();
      } catch {
        /* noop */
      }
      try {
        offLedger?.();
      } catch {
        /* noop */
      }
      if (debounce != null) window.clearTimeout(debounce);
      window.clearInterval(poll);
    };
  }, []);

  return { board, error };
}
