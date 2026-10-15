// Desktop "Command Deck" presentational layer — atoms + molecules composed by
// HomeDeck and the LedgerStrip. Token-driven, no data fetching, shared Button.
export { DeckCard } from './DeckCard';
export { LedgerRow } from './LedgerRow';
export { StatCell, type StatTone } from './StatCell';
export { LiveDot } from './LiveDot';
export { MonoStat } from './MonoStat';
export { FleetRow } from './FleetRow';
export { RunCountsBar } from './RunCountsBar';
export { RecentRow } from './RecentRow';
export { TodoRow } from './TodoRow';
export { CaptureInput } from './CaptureInput';
export { SynthesisCard } from './SynthesisCard';
export { NextMoveRow } from './NextMoveRow';
export { parseDue, isOverdue, formatDue } from './due';
export {
  deriveNextMoves,
  priorityRank,
  dueToMs,
  compareNextItems,
  type NextItem,
} from './next-moves';
