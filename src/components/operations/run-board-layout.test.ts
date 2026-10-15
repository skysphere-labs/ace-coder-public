import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Run Board rendering guards (house idiom: source-text assertions, see
// operations-minimal.test.ts) — pins the empty-card CSS fix, the drawer
// cutover, the Archived strip, and the live-refresh wiring without booting
// Electron. The pure derive helpers behind these have real unit tests in
// run-board-derive.test.ts.
const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(here, rel), 'utf8');

const panel = read('organisms/RunBoardPanel.tsx');
const hook = read('use-run-ledger-board.ts');

describe('ticket cards render full-size (the blank-skeleton root cause)', () => {
  it('keeps shrink-0 on the card: an overflow-hidden flex item has min-size 0, so without it a crowded column crushes every card into a blank bar', () => {
    expect(panel).toMatch(/className="group shrink-0 overflow-hidden rounded-lg/);
  });

  it('each column body scrolls vertically on its own', () => {
    expect(panel).toContain('flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2');
  });

  it('the stage bar scrolls horizontally when columns overflow', () => {
    expect(panel).toMatch(/flex min-h-0 flex-1 gap-3 overflow-x-auto/);
  });

  it('drops the spring layout animation on crowded columns (perf over motion)', () => {
    expect(panel).toContain('MOTION_CARD_CAP');
    expect(panel).toMatch(/layout=\{animate\}/);
  });

  it('every card face carries a stage-appropriate status line and an age label', () => {
    expect(panel).toContain('deriveCardStatus(card)');
    expect(panel).toContain('fmtAge(card.lastTs)');
  });
});

describe('card click opens the EvidenceDrawer (no more inline expand)', () => {
  it('imports and renders the shared drawer (THE detail surface, C2)', () => {
    expect(panel).toContain("import { EvidenceDrawer } from './EvidenceDrawer'");
    expect(panel).toContain('<EvidenceDrawer');
    expect(panel).toContain('eyebrow="Board card"');
  });

  it('the inline collapsible ticket body is gone', () => {
    expect(panel).not.toMatch(/const \[open, setOpen\] = useState/);
    expect(panel).not.toContain('max-h-[58vh]');
  });

  it('keeps the drawer fresh by re-resolving the selected card from each board projection', () => {
    expect(panel).toMatch(/cards\.find\(\(c\) => c\.id === selectedId\)/);
  });

  it('the drawer shows the transition history and a lazy read-only log tail', () => {
    expect(panel).toContain('d.history');
    expect(panel).toContain('aceApi.streams');
    expect(panel).toContain('readScreen');
    expect(panel).toContain('no live stream');
  });
});

describe('Archived strip (done > 24h, collapsed by default)', () => {
  it('derives from the project-filtered cards via the pure splitArchived helper', () => {
    expect(panel).toContain("import { deriveCardStatus, fmtAge, splitArchived } from '../run-board-derive'");
    expect(panel).toMatch(/splitArchived\(filtered\)/);
  });

  it('renders a chevron-toggle "Archived (N)" affordance, collapsed by default, hidden when empty', () => {
    expect(panel).toMatch(/const \[archivedOpen, setArchivedOpen\] = useState\(false\)/);
    expect(panel).toContain('Archived ({archived.length})');
    expect(panel).toMatch(/\{archived\.length > 0 \? \(/);
  });
});

describe('the board stays a read-only watcher', () => {
  it('never submits, dispatches, gates, or mutates spine state', () => {
    expect(panel).not.toMatch(/runSubmit|runLoopStop|\.submit\(|dispatch\w*\(/);
  });
});

describe('live auto-update (no manual Refresh)', () => {
  it('the shared board hook subscribes to the run-ledger changed push alongside state/git/stream', () => {
    expect(hook).toContain('aceApi.core.onRunLedgerChanged');
    expect(hook).toContain('aceApi.core.subscribe');
    expect(hook).toContain('aceApi.core.onGitChanged');
    expect(hook).toContain('aceApi.streams.onEvent');
  });

  it('the push channel is wired end to end: controller notify → main broadcast → preload listener → bridge', () => {
    const controller = readFileSync(resolve(here, '../../../electron/ace-control/index.cts'), 'utf8');
    const main = readFileSync(resolve(here, '../../../electron/main.cts'), 'utf8');
    const preload = readFileSync(resolve(here, '../../../electron/preload.cts'), 'utf8');
    const api = readFileSync(resolve(here, '../../lib/ace-api.ts'), 'utf8');
    expect(controller).toContain('function notifyRunLedgerChanged()');
    expect(controller).toContain('onRunLedgerChanged:');
    expect(main).toContain("broadcast('ace:run-ledger-changed', payload)");
    expect(preload).toContain("ipcRenderer.on('ace:run-ledger-changed', h)");
    // Optional on the bridge so a stale preload (mixed-version update) or the
    // remote WS client degrades to the existing subscriptions + safety poll.
    expect(api).toMatch(/onRunLedgerChanged\?:/);
    expect(api).toMatch(/d\.onRunLedgerChanged \? d\.onRunLedgerChanged\(listener\) : \(\) => \{\}/);
  });
});
