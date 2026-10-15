import { useState } from 'react';
import { FileText, RotateCw } from 'lucide-react';
import { cn } from '../../lib/utils';
import { Markdown } from '../ace-chat/render';
import { fetchTaskSpec, getPromptMarkdownSource, useTaskSpec } from './spec-sidecar';

// Read-only spec/rubric sidecar tab rendered beside spawned worker tabs.
// Shows the full GoalAgentSpec markdown when the framed prompt points at
// one, otherwise the framed prompt itself. Complements (does not replace)
// the pinned TaskSpecPane summary above the canvas.

export function SpecSidecarPane({ taskId }: { taskId: string }) {
  const spec = useTaskSpec(taskId);
  const [refreshing, setRefreshing] = useState(false);

  const content = spec?.goalSpecMarkdown ?? spec?.initialPrompt ?? null;
  const specFileName = spec?.goalSpecPath?.split('/').pop() ?? null;

  const refresh = async () => {
    setRefreshing(true);
    try {
      await fetchTaskSpec(taskId, { force: true });
    } catch {
      // Stale content stays visible; the next refresh can retry.
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border/30 px-3">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Spec
        </span>
        {spec?.goalSpecMarkdown && specFileName && (
          <span
            className="inline-flex min-w-0 items-center gap-1 rounded-md bg-muted/50 px-1.5 py-0.5 text-[10px] text-muted-foreground"
            title={spec.goalSpecPath ?? undefined}
          >
            <FileText className="h-3 w-3 shrink-0" />
            <span className="truncate font-mono">{specFileName}</span>
          </span>
        )}
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={refreshing}
          className={cn(
            'flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground',
            'hover:bg-muted hover:text-foreground disabled:opacity-50'
          )}
          title="Reload spec"
          aria-label="Reload spec"
        >
          <RotateCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!spec ? (
          <p className="px-4 py-3 text-[12px] text-muted-foreground">Loading spec…</p>
        ) : !content ? (
          <p className="px-4 py-3 text-[12px] text-muted-foreground">
            No spec recorded for this task.
          </p>
        ) : (
          <div className="mx-auto w-full max-w-3xl px-4 py-3 text-[13px] leading-relaxed">
            <Markdown>{content}</Markdown>
          </div>
        )}
      </div>
    </div>
  );
}

export function PromptMarkdownSourcePane({ taskId, path }: { taskId: string; path: string }) {
  const spec = useTaskSpec(taskId);
  const [refreshing, setRefreshing] = useState(false);
  const source = getPromptMarkdownSource(spec, path);
  const filename = source?.name ?? path.split('/').pop() ?? path;

  const refresh = async () => {
    setRefreshing(true);
    try {
      await fetchTaskSpec(taskId, { force: true });
    } catch {
      // Stale content stays visible; the next refresh can retry.
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border/30 px-3">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Source
        </span>
        <span
          className="inline-flex min-w-0 items-center gap-1 rounded-md bg-muted/50 px-1.5 py-0.5 text-[10px] text-muted-foreground"
          title={source?.path ?? path}
        >
          <FileText className="h-3 w-3 shrink-0" />
          <span className="truncate font-mono">{filename}</span>
        </span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={refreshing}
          className={cn(
            'flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground',
            'hover:bg-muted hover:text-foreground disabled:opacity-50'
          )}
          title="Reload source"
          aria-label="Reload source"
        >
          <RotateCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!spec ? (
          <p className="px-4 py-3 text-[12px] text-muted-foreground">Loading source…</p>
        ) : !source ? (
          <p className="px-4 py-3 text-[12px] text-muted-foreground">
            No Markdown source recorded for this tab.
          </p>
        ) : (
          <div className="mx-auto w-full max-w-3xl px-4 py-3 text-[13px] leading-relaxed">
            <Markdown>{source.markdown}</Markdown>
          </div>
        )}
      </div>
    </div>
  );
}
