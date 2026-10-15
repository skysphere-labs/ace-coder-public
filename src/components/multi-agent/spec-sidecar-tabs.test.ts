import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  openRef,
  syncAvailableTabs,
  type TabRef,
} from '../../runtime/pane-layout-registry';
import {
  getPromptMarkdownSources,
  hasSpecSidecarContent,
} from './spec-sidecar';
import type { TaskSpecResult } from '../../lib/task-spec';

// Prompt Markdown artifact tabs — auto-opened adjacent to the worker tab,
// while the generic Spec sidecar remains manual-only. Renderer wiring is
// asserted on source, per this repo's convention; the pane-layout behavior
// is exercised directly (it is pure in a node env).

const here = dirname(fileURLToPath(import.meta.url));
const parallelSource = readFileSync(resolve(here, '../ParallelTaskScreen.tsx'), 'utf8');
const mobileSwitcherSource = readFileSync(resolve(here, '../MobileTabSwitcher.tsx'), 'utf8');
const taskSpecPaneSource = readFileSync(resolve(here, '../TaskSpecPane.tsx'), 'utf8');
const sidecarPaneSource = readFileSync(resolve(here, 'SpecSidecarPane.tsx'), 'utf8');

function makeSpec(overrides: Partial<TaskSpecResult> = {}): TaskSpecResult {
  return {
    taskId: 'tsk-x',
    name: 'x',
    agent: 'claude',
    initialPrompt: null,
    branch: null,
    baseBranch: null,
    worktreePath: null,
    archivedAt: null,
    prNumber: null,
    prUrl: null,
    goalSpecPath: null,
    goalSpecMarkdown: null,
    promptMarkdownSources: [],
    ...overrides,
  };
}

describe('pane layout: spec tab lifecycle', () => {
  it('A1: a prompt Markdown source ref synced after the worker variant lands adjacent to it', () => {
    const refs: TabRef[] = [
      { kind: 'variant', variantId: 'v1' },
      { kind: 'promptMarkdown', path: '/tmp/widget-fix.md' },
    ];
    const layout = syncAvailableTabs('task-spec-adjacent', refs);
    const tabs = layout.columns[0].panes[0].tabs;
    expect(tabs.map((t) => t.ref.kind)).toEqual(['variant', 'promptMarkdown']);
  });

  it('prompt Markdown refs are singleton per source path', () => {
    const taskId = 'task-prompt-md-singleton';
    const sourceRef: TabRef = { kind: 'promptMarkdown', path: '/tmp/widget-fix.md' };
    syncAvailableTabs(taskId, [{ kind: 'variant', variantId: 'v1' }, sourceRef]);
    syncAvailableTabs(taskId, [{ kind: 'variant', variantId: 'v1' }, sourceRef]);
    openRef(taskId, sourceRef);
    const layout = syncAvailableTabs(taskId, [
      { kind: 'variant', variantId: 'v1' },
      sourceRef,
      { kind: 'promptMarkdown', path: '/tmp/other.md' },
    ]);
    const promptMdTabs = layout.columns
      .flatMap((c) => c.panes)
      .flatMap((p) => p.tabs)
      .filter((t) => t.ref.kind === 'promptMarkdown');
    expect(promptMdTabs).toHaveLength(2);
  });

  it('manual spec ref is a singleton: re-sync and openRef never duplicate it', () => {
    const taskId = 'task-spec-singleton';
    syncAvailableTabs(taskId, [{ kind: 'variant', variantId: 'v1' }, { kind: 'spec' }]);
    syncAvailableTabs(taskId, [{ kind: 'variant', variantId: 'v1' }, { kind: 'spec' }]);
    openRef(taskId, { kind: 'spec' });
    const layout = syncAvailableTabs(taskId, [
      { kind: 'variant', variantId: 'v1' },
      { kind: 'spec' },
    ]);
    const specTabs = layout.columns
      .flatMap((c) => c.panes)
      .flatMap((p) => p.tabs)
      .filter((t) => t.ref.kind === 'spec');
    expect(specTabs).toHaveLength(1);
  });

  it('syncing without the spec ref prunes the tab unless it is preserved', () => {
    const taskId = 'task-spec-dismiss';
    syncAvailableTabs(taskId, [{ kind: 'variant', variantId: 'v1' }, { kind: 'spec' }]);
    const layout = syncAvailableTabs(taskId, [{ kind: 'variant', variantId: 'v1' }]);
    const kinds = layout.columns.flatMap((c) => c.panes).flatMap((p) => p.tabs).map((t) => t.ref.kind);
    expect(kinds).toEqual(['variant']);
  });

  it('preserveRefs keeps a manual spec tab without auto-creating one', () => {
    const emptyTaskId = 'task-spec-preserve-empty';
    const withoutExisting = syncAvailableTabs(
      emptyTaskId,
      [{ kind: 'variant', variantId: 'v1' }],
      { preserveRefs: [{ kind: 'spec' }] }
    );
    expect(withoutExisting.columns[0].panes[0].tabs.map((t) => t.ref.kind)).toEqual(['variant']);

    const persistedTaskId = 'task-spec-preserve-existing';
    syncAvailableTabs(persistedTaskId, [{ kind: 'variant', variantId: 'v1' }, { kind: 'spec' }]);
    const withExisting = syncAvailableTabs(
      persistedTaskId,
      [{ kind: 'variant', variantId: 'v1' }],
      { preserveRefs: [{ kind: 'spec' }] }
    );
    expect(withExisting.columns[0].panes[0].tabs.map((t) => t.ref.kind)).toEqual(['variant', 'spec']);
  });
});

describe('spec sidecar store', () => {
  it('hasSpecSidecarContent: fallback spec file or framed prompt remains available', () => {
    expect(hasSpecSidecarContent(null)).toBe(false);
    expect(hasSpecSidecarContent(makeSpec())).toBe(false);
    expect(hasSpecSidecarContent(makeSpec({ initialPrompt: '# Goal\nx' }))).toBe(true);
    expect(hasSpecSidecarContent(makeSpec({ goalSpecMarkdown: '# Spec' }))).toBe(true);
  });

  it('prompt Markdown sources coexist with manual spec content availability', () => {
    const spec = makeSpec({
      initialPrompt: '# Goal\nx',
      promptMarkdownSources: [
        { path: '/tmp/widget-fix.md', name: 'widget-fix.md', markdown: '# Widget fix' },
      ],
    });

    expect(getPromptMarkdownSources(spec)).toHaveLength(1);
    expect(hasSpecSidecarContent(spec)).toBe(true);
  });
});

describe('ParallelTaskScreen wiring', () => {
  it('A1/A2: pushes prompt Markdown source refs immediately after worker variant refs', () => {
    expect(parallelSource).toMatch(
      /for \(const v of variants\) refs\.push\(\{ kind: 'variant', variantId: v\.id \}\);\s*\n\s*for \(const source of promptMarkdownSources\) refs\.push\(\{ kind: 'promptMarkdown', path: source\.path \}\);\s*\n\s*for \(const c of conversations\) refs\.push/
    );
    expect(parallelSource).not.toMatch(/refs\.push\(\{ kind: 'spec' \}\)/);
  });

  it('renders prompt Markdown source panes and fallback spec panes', () => {
    expect(parallelSource).toContain("case 'promptMarkdown':");
    expect(parallelSource).toContain('<PromptMarkdownSourcePane taskId={task.id} path={ref.path} />');
    expect(parallelSource).toContain("case 'spec':");
    expect(parallelSource).toContain('<SpecSidecarPane taskId={task.id} />');
  });

  it('manual Spec tabs are preserved without being auto-created by tab sync', () => {
    expect(parallelSource).toContain("preserveRefs: specAvailable ? [{ kind: 'spec' }] : []");
  });

  it('A3: spec fetch joins the hydration barrier so persisted tabs are not pruned early', () => {
    expect(parallelSource).toMatch(
      /Promise\.all\(\[\s*hydrateScratchTabs\(task\.id\),\s*hydrateEditorOpenFiles\(task\.id\),\s*fetchTaskSpec\(task\.id\)\.catch/
    );
  });

  it('A4: exactly one pinned TaskSpecPane — the sidecar adds no second top bar', () => {
    expect(parallelSource.match(/<TaskSpecPane/g)).toHaveLength(1);
    expect(parallelSource).toContain('onOpenSpecTab={');
  });
});

describe('MobileTabSwitcher wiring (A5)', () => {
  it('presents prompt Markdown source tabs by filename and still handles manual spec tabs', () => {
    expect(mobileSwitcherSource).toContain("case 'promptMarkdown':");
    expect(mobileSwitcherSource).toContain("case 'spec':");
    expect(mobileSwitcherSource).toContain("name: 'Spec'");
    expect(mobileSwitcherSource).toContain("const name = ref.path.split('/').pop() || ref.path;");
  });
});

describe('TaskSpecPane preserved behavior (A4)', () => {
  it('the reopen affordance is optional — absent prop leaves the pane unchanged', () => {
    expect(taskSpecPaneSource).toContain('onOpenSpecTab?: () => void');
    expect(taskSpecPaneSource).toMatch(/\{onOpenSpecTab && \(/);
  });
});

describe('SpecSidecarPane content (A2)', () => {
  it('renders GoalAgentSpec markdown first, framed prompt as fallback', () => {
    expect(sidecarPaneSource).toContain('spec?.goalSpecMarkdown ?? spec?.initialPrompt');
    expect(sidecarPaneSource).toContain('<Markdown>{content}</Markdown>');
  });

  it('renders prompt Markdown source content through the existing Markdown renderer', () => {
    expect(sidecarPaneSource).toContain('getPromptMarkdownSource(spec, path)');
    expect(sidecarPaneSource).toContain('<Markdown>{source.markdown}</Markdown>');
  });
});
