import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, ExternalLink, GitBranch, ScrollText } from 'lucide-react';
import { cn } from '../lib/utils';
import { aceApi } from '../lib/ace-api';
import { parseInitialPrompt, type TaskSpecResult } from '../lib/task-spec';
import { Badge } from './ui/badge';

// Pinned read-only pane above the worker-tab canvas. Surfaces the
// framed prompt that was delivered at delegation time — goal, skills,
// acceptance criteria, branch, PR link — so the human opening the tab
// can see what was asked without scrolling the terminal. Driver-agnostic:
// the spec comes from tasks.initial_prompt, never the scrollback.

const STORAGE_PREFIX = 'ace.taskSpecPane.collapsed.';

function useCollapsedState(taskId: string) {
  const storageKey = `${STORAGE_PREFIX}${taskId}`;
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    try {
      return window.localStorage.getItem(storageKey) === '1';
    } catch {
      return false;
    }
  });
  const toggle = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(storageKey, next ? '1' : '0');
      } catch {
        // localStorage can throw in private-mode / quota scenarios — the
        // pane still works, just forgets the toggle across reloads.
      }
      return next;
    });
  };
  return [collapsed, toggle] as const;
}

type TaskSpecPaneProps = {
  taskId: string;
  // When set, the header shows an "open spec tab" affordance that reopens
  // the full spec/rubric sidecar tab beside the worker tabs.
  onOpenSpecTab?: () => void;
};

export function TaskSpecPane({ taskId, onOpenSpecTab }: TaskSpecPaneProps) {
  return <TaskSpecPaneInner key={taskId} taskId={taskId} onOpenSpecTab={onOpenSpecTab} />;
}

function TaskSpecPaneInner({ taskId, onOpenSpecTab }: TaskSpecPaneProps) {
  const [spec, setSpec] = useState<TaskSpecResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, toggle] = useCollapsedState(taskId);

  useEffect(() => {
    let cancelled = false;
    aceApi.workspaces
      .getTaskSpec(taskId)
      .then((res) => {
        if (!cancelled) setSpec(res);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load spec');
      });
    return () => {
      cancelled = true;
    };
  }, [taskId]);

  const parsed = useMemo(
    () => parseInitialPrompt(spec?.initialPrompt ?? null),
    [spec?.initialPrompt]
  );

  const Icon = collapsed ? ChevronRight : ChevronDown;
  const branchLabel = spec?.branch;
  const baseLabel = spec?.baseBranch;

  return (
    <div className="shrink-0 border-b border-border/40 bg-muted/20">
      <div className="flex items-center gap-2 px-3 py-1.5">
        <button
          type="button"
          onClick={toggle}
          className={cn(
            'flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[11px] font-medium',
            'text-foreground/90 hover:bg-muted hover:text-foreground'
          )}
          aria-expanded={!collapsed}
        >
          <Icon className="h-3.5 w-3.5" />
          <span>Task spec</span>
        </button>
        {branchLabel && (
          <span className="inline-flex items-center gap-1 rounded-md bg-muted/50 px-1.5 py-0.5 text-[10px] text-muted-foreground">
            <GitBranch className="h-3 w-3" />
            <span className="font-mono">{branchLabel}</span>
            {baseLabel && baseLabel !== branchLabel && (
              <>
                <span className="text-muted-foreground/60">←</span>
                <span className="font-mono text-muted-foreground/80">{baseLabel}</span>
              </>
            )}
          </span>
        )}
        {spec?.prUrl && spec.prNumber != null && (
          <button
            type="button"
            onClick={() => void aceApi.workspaces.openExternal(spec.prUrl!)}
            className="inline-flex items-center gap-1 rounded-md bg-muted/50 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground"
            title={spec.prUrl}
          >
            <ExternalLink className="h-3 w-3" />
            <span>PR #{spec.prNumber}</span>
          </button>
        )}
        {spec?.archivedAt && (
          <Badge variant="muted" className="text-[10px]">
            Archived
          </Badge>
        )}
        {onOpenSpecTab && (
          <button
            type="button"
            onClick={onOpenSpecTab}
            className="inline-flex items-center gap-1 rounded-md bg-muted/50 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground"
            title="Open the full spec & rubric as a tab"
          >
            <ScrollText className="h-3 w-3" />
            <span>Spec tab</span>
          </button>
        )}
      </div>
      {!collapsed && (
        <div className="border-t border-border/30 px-3 py-2 text-[12px] text-foreground/90">
          {error ? (
            <p className="text-[11px] text-muted-foreground">Failed to load spec: {error}</p>
          ) : !spec ? (
            <p className="text-[11px] text-muted-foreground">Loading spec…</p>
          ) : !parsed.hasContent ? (
            <p className="text-[11px] text-muted-foreground">No spec recorded for this task.</p>
          ) : (
            <SpecBody parsed={parsed} />
          )}
        </div>
      )}
    </div>
  );
}

function SpecBody({ parsed }: { parsed: ReturnType<typeof parseInitialPrompt> }) {
  return (
    <div className="space-y-2">
      {parsed.goal && (
        <Section title="Goal">
          <p className="whitespace-pre-wrap text-[12px] leading-snug">{parsed.goal}</p>
        </Section>
      )}
      {parsed.skills.length > 0 && (
        <Section title="Skills">
          <div className="flex flex-wrap gap-1">
            {parsed.skills.map((skill) => (
              <span
                key={skill}
                className="inline-flex items-center rounded-md border border-border/60 bg-muted/40 px-1.5 py-0.5 font-mono text-[10px] text-foreground/85"
              >
                {skill}
              </span>
            ))}
          </div>
        </Section>
      )}
      {(parsed.roleMode || parsed.skillPack || parsed.capabilities.length > 0 || parsed.taskPackSkills.length > 0) && (
        <Section title="Manifest">
          <div className="flex flex-wrap gap-1">
            {parsed.roleMode && <SpecChip value={`role:${parsed.roleMode}`} />}
            {parsed.skillPack && <SpecChip value={`pack:${parsed.skillPack}`} />}
            {parsed.capabilities.map((capability) => (
              <SpecChip key={`cap:${capability}`} value={`cap:${capability}`} />
            ))}
            {parsed.taskPackSkills.map((skill) => (
              <SpecChip key={`pack:${skill}`} value={skill} />
            ))}
          </div>
        </Section>
      )}
      {parsed.constraints.length > 0 && (
        <Section title="Constraints">
          <BulletList items={parsed.constraints} />
        </Section>
      )}
      {parsed.deliverables.length > 0 && (
        <Section title="Deliverables">
          <BulletList items={parsed.deliverables} />
        </Section>
      )}
      {parsed.acceptance.length > 0 && (
        <Section title="Acceptance criteria">
          <BulletList items={parsed.acceptance} />
        </Section>
      )}
      {parsed.goal == null &&
        parsed.skills.length === 0 &&
        !parsed.roleMode &&
        !parsed.skillPack &&
        parsed.capabilities.length === 0 &&
        parsed.taskPackSkills.length === 0 &&
        parsed.constraints.length === 0 &&
        parsed.deliverables.length === 0 &&
        parsed.acceptance.length === 0 && (
          <pre className="whitespace-pre-wrap break-words text-[11px] leading-snug text-foreground/80">
            {parsed.raw}
          </pre>
        )}
    </div>
  );
}

function SpecChip({ value }: { value: string }) {
  return (
    <span className="inline-flex items-center rounded-md border border-border/60 bg-muted/40 px-1.5 py-0.5 font-mono text-[10px] text-foreground/85">
      {value}
    </span>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </div>
      {children}
    </div>
  );
}

function BulletList({ items }: { items: string[] }) {
  return (
    <ul className="space-y-0.5 text-[12px] leading-snug">
      {items.map((item, i) => (
        <li key={i} className="flex gap-1.5">
          <span className="text-muted-foreground">•</span>
          <span className="whitespace-pre-wrap">{item}</span>
        </li>
      ))}
    </ul>
  );
}
