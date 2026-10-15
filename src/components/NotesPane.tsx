import { useCallback, useEffect, useRef, useState, type CompositionEvent, type FormEvent } from 'react';
import { Check, FileText, Loader2, Save } from 'lucide-react';
import { cn } from '../lib/utils';
import { aceApi } from '../lib/ace-api';
import {
  updateScratchTab,
  useScratchTabs,
} from '../runtime/scratch-tabs-registry';

interface NotesPaneProps {
  taskId: string;
  tabId: string;
}

const NOTES_DIR = 'ace-notes';

export function NotesPane({ taskId, tabId }: NotesPaneProps) {
  const state = useScratchTabs(taskId);
  const tab = state.tabs.find((t) => t.id === tabId && t.kind === 'notes');
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const composingRef = useRef(false);

  const title = tab?.title ?? 'Untitled';
  const content = tab?.content ?? '';
  const dirty = !!tab?.dirty;
  const savedPath = tab?.savedPath ?? null;

  const setTitle = useCallback(
    (next: string) => {
      updateScratchTab(taskId, tabId, { title: next || 'Untitled', dirty: true });
    },
    [taskId, tabId]
  );

  const setContent = useCallback(
    (next: string) => {
      updateScratchTab(taskId, tabId, { content: next, dirty: true });
    },
    [taskId, tabId]
  );

  const save = useCallback(async () => {
    if (saving) return;
    const resolved = savedPath || `${NOTES_DIR}/${slugify(title)}.md`;
    setSaving(true);
    setSaveError(null);
    try {
      await aceApi.fs.writeTaskFile(taskId, resolved, content);
      updateScratchTab(taskId, tabId, { savedPath: resolved, dirty: false });
      setJustSaved(true);
      window.setTimeout(() => setJustSaved(false), 1500);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }, [taskId, tabId, savedPath, title, content, saving]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        const target = e.target as HTMLElement | null;
        const inside = target?.closest?.('[data-notes-pane="true"]');
        if (!inside) return;
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save]);

  if (!tab) return null;

  return (
    <div
      data-notes-pane="true"
      className="relative flex h-full w-full flex-col"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-64 opacity-70"
        style={{
          background:
            'radial-gradient(600px 280px at 50% -40%, hsl(40 80% 60% / 0.06), transparent 70%)',
        }}
      />

      <div className="relative flex shrink-0 items-center gap-2 border-b border-white/[0.04] bg-white/[0.015] px-4 py-2.5 backdrop-blur-sm">
        <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Untitled"
          spellCheck={false}
          className="h-7 min-w-0 flex-1 bg-transparent text-[14px] font-semibold tracking-tight text-foreground placeholder:font-normal placeholder:text-muted-foreground/40 focus:outline-none"
        />
        {dirty && (
          <span className="flex shrink-0 items-center gap-1 rounded-full bg-amber-400/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-300/80">
            <span className="h-1 w-1 rounded-full bg-amber-300/80" />
            Unsaved
          </span>
        )}
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving || !dirty}
          title="Save (⌘S)"
          className={cn(
            'inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1 text-[11px] font-medium transition-all',
            saving || !dirty
              ? 'cursor-default bg-white/[0.03] text-muted-foreground/50'
              : 'bg-white/[0.08] text-foreground hover:bg-white/[0.12]'
          )}
        >
          {saving ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : justSaved ? (
            <Check className="h-3 w-3 text-emerald-400" />
          ) : (
            <Save className="h-3 w-3" />
          )}
          {saving ? 'Saving…' : justSaved ? 'Saved' : 'Save'}
        </button>
      </div>

      {saveError && (
        <div className="relative shrink-0 truncate border-b border-rose-500/20 bg-rose-500/10 px-4 py-1.5 text-[11px] text-rose-200">
          {saveError}
        </div>
      )}

      <div className="relative min-h-0 flex-1 overflow-auto">
        <div className="mx-auto h-full w-full max-w-[1100px] px-10 py-6 sm:px-16">
          <textarea
            ref={textareaRef}
            value={content}
            onChange={(e) => {
              if (composingRef.current) return;
              setContent(e.target.value);
            }}
            onCompositionStart={() => { composingRef.current = true; }}
            onCompositionEnd={(e: CompositionEvent<HTMLTextAreaElement>) => {
              composingRef.current = false;
              setContent(e.currentTarget.value);
            }}
            onBeforeInput={(e: FormEvent<HTMLTextAreaElement>) => {
              const it = (e.nativeEvent as InputEvent).inputType;
              if (it === 'insertReplacementText' || it === 'insertFromYank') {
                composingRef.current = true;
              }
            }}
            placeholder={'Jot ideas, plan tasks, keep scratch thoughts…\n\nMarkdown supported. ⌘S to save to the task folder.'}
            spellCheck
            className="h-full min-h-[320px] w-full resize-none bg-transparent font-mono text-[13px] leading-[1.7] text-foreground/90 placeholder:text-muted-foreground/30 focus:outline-none"
          />
        </div>
      </div>

      <div className="relative flex shrink-0 items-center justify-between gap-3 border-t border-white/[0.04] bg-white/[0.015] px-4 py-1.5 text-[10px] text-muted-foreground/60 backdrop-blur-sm">
        <span className="min-w-0 truncate">
          {savedPath ? (
            <>
              Saved to{' '}
              <span className="font-mono text-muted-foreground/80">{savedPath}</span>
            </>
          ) : (
            <>Not saved · <kbd className="rounded border border-white/[0.08] bg-white/[0.04] px-1 py-0.5 text-[9px] font-medium text-muted-foreground/80">⌘S</kbd> to save markdown to the task folder</>
          )}
        </span>
        <span className="shrink-0 tabular-nums text-muted-foreground/50">
          {content.length} chars · {wordCount(content)} words
        </span>
      </div>
    </div>
  );
}

function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || `note-${Date.now()}`;
}

function wordCount(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}
