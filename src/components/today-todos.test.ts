import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(here, rel), 'utf8');

const todayTodos = read('TodayTodos.tsx');
const todosPanel = read('operations/organisms/TodosPanel.tsx');
const opsScreen = read('operations/OpsScreens.tsx');

describe('TodayTodos — minimal Today surface', () => {
  it('reuses the SHARED ops todo backend (same create/done as Operations)', () => {
    expect(todayTodos).toContain('aceApi.ops.todos.list');
    expect(todayTodos).toContain('aceApi.ops.todos.create');
    expect(todayTodos).toContain('aceApi.ops.todos.update');
    expect(todayTodos).toContain('aceApi.ops.todos.digest');
    // Done toggle is reopen-aware, byte-identical contract to TodosPanel.
    expect(todayTodos).toContain("status: t.status === 'done' ? 'open' : 'done'");
  });

  it('is composed from the shared mobile atoms, not bolted-on divs', () => {
    expect(todayTodos).toContain("from './ui/mobile'");
    expect(todayTodos).toContain('SectionLabel');
    expect(todayTodos).toContain('MobilePressable');
  });

  it('renders each todo as an Apple-Reminders bar: circle + title + due date, NO note body', () => {
    // Title only on the row (one line) — never the long note body.
    expect(todayTodos).toContain('{t.text}');
    expect(todayTodos).not.toContain('.notes');
    // A quiet due date, red when overdue (the macOS Reminders look).
    expect(todayTodos).toContain('t.dueAt');
    expect(todayTodos).toContain('isOverdue');
    expect(todayTodos).toContain('formatDue');
    expect(todayTodos).toMatch(/text-rose/); // overdue dates read red
    // Tap-circle Done per row.
    expect(todayTodos).toContain('rounded-full');
  });

  it('keeps the synthesizer but COLLAPSED into bullet points (not the dense digest card)', () => {
    // Collapsed by default — the only disclosure on Today.
    expect(todayTodos).toContain('synthOpen');
    expect(todayTodos).toContain('useState(false)');
    expect(todayTodos).toContain('Synthesis');
    expect(todayTodos).toContain('aria-expanded={synthOpen}');
    // Bullet list, built from the digest goals + suggestions.
    expect(todayTodos).toContain('digest.goals');
    expect(todayTodos).toContain('digest.suggestions');
    expect(todayTodos).toContain('<ul');
    // NOT the heavy Operations digest organism/atoms.
    expect(todayTodos).not.toContain('DigestCard');
    expect(todayTodos).not.toContain('DisclosureRow');
  });

  it('shows a small open-count line and caps the open preview (A2)', () => {
    expect(todayTodos).toMatch(/const PREVIEW = \d/);
    expect(todayTodos).toContain('open.slice(0, PREVIEW)');
    // The count line reports the TRUE total, never the capped preview length.
    expect(todayTodos).toMatch(/count=\{open\.length\}/);
  });

  it('drops Operations-only density (A2) — no group headers, tags, kind, details', () => {
    // No lifecycle group headers / disclosures.
    expect(todayTodos).not.toContain('GroupDisclosure');
    expect(todayTodos).not.toContain('Promoted');
    expect(todayTodos).not.toContain('Open & assigned');
    // No tag filter.
    expect(todayTodos).not.toContain('tagFilter');
    expect(todayTodos).not.toContain('Filter by tag');
    // No kind segmented control, no edit drawer / overflow / details disclosure.
    expect(todayTodos).not.toContain('SegmentedControl');
    expect(todayTodos).not.toContain('EvidenceDrawer');
    expect(todayTodos).not.toContain('OverflowMenu');
    expect(todayTodos).not.toContain('DetailsFields');
  });

  it('keeps the full dense panel reachable, not duplicated, via the Todos surface', () => {
    expect(todayTodos).toContain("setView('todos')");
    // Today must NOT import or render the dense organism.
    expect(todayTodos).not.toContain('organisms/TodosPanel');
    expect(todayTodos).not.toContain('<TodosPanel');
  });
});

describe('Todos surface stays full/dense (A3)', () => {
  it('the promoted Todos screen still embeds the unchanged full TodosPanel organism', () => {
    expect(opsScreen).toContain("import { TodosPanel } from './organisms/TodosPanel'");
    expect(opsScreen).toContain('<TodosPanel />');
  });

  it('the full panel keeps its dense Operations affordances', () => {
    // Density that Today deliberately omits must remain in the Operations panel.
    expect(todosPanel).toContain('DigestCard');
    expect(todosPanel).toContain('GroupDisclosure');
    expect(todosPanel).toContain('Filter by tag');
    expect(todosPanel).toContain('SegmentedControl');
    expect(todosPanel).toContain('EvidenceDrawer');
  });
});
