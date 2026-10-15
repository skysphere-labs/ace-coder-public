import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The Operations hub was retired: its kept features are now their own top-level
// surfaces, and the Tickets tab moved to the embedded Sky control plane. This
// repo verifies renderer wiring by asserting on source rather than booting
// Electron, so these source assertions guard the new IA — the Sky embed + the
// promoted Board/Todos/Intel/Monitor/Knowledge surfaces — stays reachable.
const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(here, rel), 'utf8');

const shellSource = read('MobileShell.tsx');
const canvasSource = read('WorkspaceCanvas.tsx');
const desktopShellSource = read('DesktopShell.tsx');
const storeSource = read('../store.tsx');
const navItemsSource = read('navigation-items.ts');
const opsScreensSource = read('operations/OpsScreens.tsx');
const runBoardSource = read('operations/organisms/RunBoardPanel.tsx');

describe('Operations hub retired', () => {
  it('drops the operations view from the store and the canvas route', () => {
    expect(storeSource).not.toContain("| 'operations'");
    expect(canvasSource).not.toContain("view === 'operations'");
    expect(canvasSource).not.toContain('OperationsScreen');
    // The old hub-only mobile pill is gone.
    expect(shellSource).not.toContain("'operations'");
  });

  it('deletes the hub shell + native Tickets panel files', () => {
    for (const gone of [
      'operations/OperationsScreen.tsx',
      'operations/ops-tabs.ts',
      'operations/molecules/OpsTabBar.tsx',
      'operations/organisms/TicketsPanel.tsx',
    ]) {
      expect(() => read(gone)).toThrow();
    }
  });
});

describe('public navigation has no private control plane', () => {
  it('removes private service tabs and automatic ticket calls', () => {
    for (const source of [navItemsSource, shellSource, desktopShellSource]) {
      expect(source).not.toMatch(/<(SkyScreen|AdminScreen)\b|id:\s*'(sky|admin)'/);
    }
    expect(storeSource).not.toContain('aceApi.tickets');
  });
});

describe('Promoted Operations surfaces are reachable + keep their panels', () => {
  it('adds board/todos/intel/monitor/knowledge to the store and canvas routes', () => {
    for (const v of ['board', 'todos', 'intel', 'monitor', 'knowledge']) {
      expect(storeSource).toContain(`| '${v}'`);
      expect(canvasSource).toContain(`if (view === '${v}') return`);
    }
  });

  it('exposes Intel / Monitor / Knowledge as desktop nav-rail tabs', () => {
    expect(navItemsSource).toMatch(/id:\s*'intel'/);
    expect(navItemsSource).toMatch(/id:\s*'monitor'/);
    expect(navItemsSource).toMatch(/id:\s*'knowledge'/);
  });

  it('reaches the promoted surfaces on mobile as Today drill-ins', () => {
    expect(shellSource).toContain('OPS_DRILL_IN_VIEWS');
    expect(shellSource).toMatch(/OPS_DRILL_IN_VIEWS[\s\S]*?'board'[\s\S]*?'todos'[\s\S]*?'intel'[\s\S]*?'monitor'[\s\S]*?'knowledge'/);
    // A drill-in shows a back button and pops back to Today.
    expect(shellSource).toContain('OPS_DRILL_IN_VIEWS.includes(view)');
  });

  it('composes the SAME existing panels (no rewrite, same data wiring)', () => {
    expect(opsScreensSource).toContain('useOperationsData');
    // Monitor: merged agents + health/services/cloudflare/updater grid.
    expect(opsScreensSource).toContain('<AgentsPanel />');
    expect(opsScreensSource).toContain('<SystemHealthPanel slice={state.status} />');
    expect(opsScreensSource).toContain('<ServicesPanel slice={state.status} />');
    expect(opsScreensSource).not.toContain('<CloudflareInventoryPanel />');
    expect(opsScreensSource).not.toContain('<UpdaterStatusCard />');
    // Intel: unified IntelHub on desktop, stacked panel on mobile.
    expect(opsScreensSource).toMatch(
      /isMobile \? <MobileIntelPanel slice=\{state\.brief\} \/> : <IntelHub \/>/
    );
    expect(opsScreensSource).toMatch(
      /<BriefsTab slice=\{slice\} \/>[\s\S]*?<VectorOpsPanel embedded \/>[\s\S]*?<SourcesPanel \/>/
    );
    // Todos + Knowledge reuse their organisms.
    expect(opsScreensSource).toContain("import { TodosPanel } from './organisms/TodosPanel'");
    expect(opsScreensSource).toContain('<TodosPanel />');
    expect(opsScreensSource).toContain('<KnowledgeSearchPanel />');
    expect(opsScreensSource).toContain('<CollapsedWikiGraph />');
    // Board reuses the run-ledger OpsTab.
    expect(opsScreensSource).toContain('<OpsTab state={state}');
  });

  it('keeps the run board mobile-safe (header wraps, columns scroll)', () => {
    expect(runBoardSource).toContain('flex-wrap');
    expect(runBoardSource).toContain('overflow-x-auto');
  });
});

describe('Loops stays a first-class top-level section', () => {
  it('canvas routes the loops view and both rails expose it', () => {
    expect(canvasSource).toContain("if (view === 'loops') return");
    expect(canvasSource).toContain('LoopsScreen');
    expect(storeSource).toContain("| 'loops'");
    expect(navItemsSource).toMatch(/id:\s*'loops',\s*icon:\s*Repeat,\s*label:\s*'Loops'/);
    // Teams is retired from both rails, so Loops now anchors against Sky only.
    expect(navItemsSource).toMatch(/'loops'[\s\S]*?'intel'/);
    expect(shellSource).toMatch(/'loops'[\s\S]*?'settings'/);
  });
});
