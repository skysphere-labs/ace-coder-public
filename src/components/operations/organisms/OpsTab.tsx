import type { OperationsState } from '../../../runtime/operations-registry';
import type { AttentionTab } from '../attention';
import { useRunLedgerBoard } from '../use-run-ledger-board';
import { AttentionStrip } from '../molecules/AttentionStrip';
import { RunBoardPanel } from './RunBoardPanel';

// ─── OpsTab ──────────────────────────────────────────────────────────────────
// Operations → Board (the landing tab): the LEAN, READ-ONLY run-ledger board
// (aceApi.missions.runBoard) — a pure projection over the event ledger that
// watches runs move through the lifecycle (To Do → In Progress → Ready to
// Review → Done / Blocked). A watcher, never a gate: it never dispatches,
// gates, or mutates.
//
// This tab owns the ONE shared board fetch (useRunLedgerBoard) and feeds it to
// BOTH the thin "Needs you" attention strip and the board below — so the ledger
// is read once, with no extra polling / IPC. The board owns its own scroll, so
// it sits under the strip in a flex column.
export function OpsTab({
  state,
  onNavigate,
}: {
  state: OperationsState;
  onNavigate: (tab: AttentionTab) => void;
}) {
  const { board, error } = useRunLedgerBoard();
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <AttentionStrip
        status={state.status}
        pulse={state.pulse}
        board={board}
        onNavigate={onNavigate}
      />
      <div className="min-h-0 flex-1">
        <RunBoardPanel board={board} error={error} />
      </div>
    </div>
  );
}
