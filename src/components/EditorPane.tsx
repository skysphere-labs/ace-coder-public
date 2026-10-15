import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Eye, Pencil, Save } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import { cn } from '../lib/utils';
import { aceApi } from '../lib/ace-api';
import { setDirty } from '../runtime/editor-registry';

const MonacoFileEditor = lazy(() =>
  import('./MonacoFileEditor').then((module) => ({ default: module.MonacoFileEditor }))
);

const LANGUAGE_BY_EXT: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', jsonc: 'json',
  md: 'markdown', markdown: 'markdown', mdx: 'markdown',
  html: 'html', htm: 'html', xml: 'xml', svg: 'xml',
  css: 'css', scss: 'scss', less: 'less',
  yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini',
  sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java',
  c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cc: 'cpp',
  cs: 'csharp', php: 'php', swift: 'swift', kt: 'kotlin',
  sql: 'sql', graphql: 'graphql', gql: 'graphql',
  dockerfile: 'dockerfile',
};

function languageFor(filePath: string): string {
  const base = filePath.split('/').pop() ?? filePath;
  if (base.toLowerCase() === 'dockerfile') return 'dockerfile';
  const ext = base.includes('.') ? base.slice(base.lastIndexOf('.') + 1).toLowerCase() : '';
  return LANGUAGE_BY_EXT[ext] ?? 'plaintext';
}

function isMarkdown(filePath: string) {
  return languageFor(filePath) === 'markdown';
}

export function EditorPane({ taskId, path }: { taskId: string; path: string }) {
  return (
    <div className="flex h-full min-w-0 flex-col">
      <FileEditor key={`${taskId}:${path}`} taskId={taskId} path={path} />
    </div>
  );
}

function FileEditor({ taskId, path }: { taskId: string; path: string }) {
  const [mode, setMode] = useState<'edit' | 'preview'>(
    isMarkdown(path) ? 'preview' : 'edit'
  );
  const [content, setContent] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const savedRef = useRef<string>('');
  const isMd = isMarkdown(path);

  useEffect(() => {
    let cancelled = false;
    aceApi.fs
      .readTaskFile(taskId, path)
      .then((result) => {
        if (cancelled) return;
        setContent(result.content);
        savedRef.current = result.content;
        setDirty(taskId, path, false);
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : 'Failed to open file');
      });
    return () => {
      cancelled = true;
    };
  }, [taskId, path]);

  useEffect(() => {
    return aceApi.core.onGitChanged(async (payload) => {
      if (payload.taskId !== taskId) return;
      if (content !== savedRef.current) return;
      try {
        const result = await aceApi.fs.readTaskFile(taskId, path);
        if (result.content !== content) {
          setContent(result.content);
          savedRef.current = result.content;
          setDirty(taskId, path, false);
        }
      } catch {}
    });
  }, [taskId, path, content]);

  const save = useCallback(async () => {
    if (content === null) return;
    try {
      await aceApi.fs.writeTaskFile(taskId, path, content);
      savedRef.current = content;
      setDirty(taskId, path, false);
    } catch (err) {
      console.error('[ace] save failed:', err);
    }
  }, [taskId, path, content]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [save]);

  const onEditorChange = useCallback(
    (value: string | undefined) => {
      const next = value ?? '';
      setContent(next);
      setDirty(taskId, path, next !== savedRef.current);
    },
    [taskId, path]
  );

  const language = useMemo(() => languageFor(path), [path]);

  if (loadError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 px-6">
        <p className="text-center text-xs font-medium text-red-300/80">Unable to open file</p>
        <p className="text-center text-[10px] text-muted-foreground/60">{loadError}</p>
      </div>
    );
  }
  if (content === null) {
    return (
      <div className="flex h-full items-center justify-center px-6">
        <p className="text-center text-xs text-muted-foreground/70">Loading…</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center justify-between border-b border-white/[0.04] px-3 py-1.5">
        <div className="flex items-center gap-2">
          {isMd && (
            <div className="inline-flex items-center gap-0.5 rounded-md bg-[hsl(0_0%_100%/0.04)] p-0.5">
              <ToolbarToggle
                active={mode === 'edit'}
                onClick={() => setMode('edit')}
                icon={<Pencil className="h-3 w-3" />}
                label="Edit"
              />
              <ToolbarToggle
                active={mode === 'preview'}
                onClick={() => setMode('preview')}
                icon={<Eye className="h-3 w-3" />}
                label="Preview"
              />
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={() => void save()}
          className="flex h-6 items-center gap-1 rounded-md px-2 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-[hsl(0_0%_100%/0.04)] hover:text-foreground"
          title="Save (⌘S)"
        >
          <Save className="h-3 w-3" />
          Save
        </button>
      </div>

      <div className="min-h-0 flex-1">
        {isMd && mode === 'preview' ? (
          <MarkdownPreview content={content} />
        ) : (
          <Suspense fallback={<EditorLoading />}>
            <MonacoFileEditor
              language={language}
              value={content}
              onChange={onEditorChange}
            />
          </Suspense>
        )}
      </div>
    </div>
  );
}

function ToolbarToggle({
  active, onClick, icon, label,
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex h-5 items-center gap-1 rounded px-2 text-[10px] font-medium transition-colors',
        active
          ? 'bg-[hsl(0_0%_100%/0.08)] text-foreground'
          : 'text-muted-foreground hover:text-foreground'
      )}
    >
      {icon}
      {label}
    </button>
  );
}

function EditorLoading() {
  return (
    <div className="flex h-full items-center justify-center px-6">
      <p className="text-center text-xs text-muted-foreground/70">Loading editor...</p>
    </div>
  );
}

function MarkdownPreview({ content }: { content: string }) {
  return (
    <div className="h-full overflow-y-auto px-12 py-8 lg:px-20">
      <article className="ace-md prose prose-invert mx-auto max-w-[1100px] text-sm leading-relaxed prose-headings:font-display prose-headings:tracking-tight prose-h1:text-2xl prose-h2:text-xl prose-h3:text-base prose-a:text-blue-300 prose-code:rounded prose-code:bg-white/[0.06] prose-code:px-1 prose-code:py-0.5 prose-code:text-[0.85em] prose-code:before:content-[''] prose-code:after:content-[''] prose-pre:bg-black/40 prose-pre:text-foreground/90 prose-img:rounded-md prose-hr:border-white/[0.06] prose-th:text-left prose-td:align-middle">
        <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]}>{content}</ReactMarkdown>
      </article>
    </div>
  );
}
