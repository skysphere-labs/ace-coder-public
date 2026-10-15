import React, {
  type ComponentProps,
  memo,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Streamdown, parseMarkdownIntoBlocks } from 'streamdown';
import { createCodePlugin } from '@streamdown/code';
import { FolderOpen } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { aceApi } from '../../../lib/ace-api';
import { createMemoizedMathPlugin } from './katex-memo';
import { chunkByLines } from './code-budget';

/**
 * The Hermes-style chat text layer (PRD Lane 1). Ports the framework-agnostic
 * pieces of Hermes's `markdown-text.tsx` — `useSmoothReveal`, the LRU block
 * cache, the memoized katex plugin, the budget gates — onto the **raw**
 * `streamdown` component (PRD D8: no `@assistant-ui`). The streaming runtime
 * stays Ace's: callers pass `{ text, streaming }`, not assistant-ui message
 * parts.
 *
 * Replaces the old `markdown.tsx` bare `react-markdown` renderer (PRD D2).
 */

const FILE_PATH_RE = /^([a-zA-Z0-9_\-./]+):(\d+)(?::(\d+))?$/;
const FILE_URL_RE = /^file:/i;
const LOCAL_PATH_RE = /^(?:\/|~\/|\.{1,2}\/)/;

function fileUrlToPath(url: string): string {
  if (!FILE_URL_RE.test(url)) return url;
  try {
    return decodeURIComponent(url.replace(/^file:\/\//i, '').replace(/^file:/i, ''));
  } catch {
    return url.replace(/^file:\/\//i, '').replace(/^file:/i, '');
  }
}

// Math plugin (KaTeX). Module-scope so the prop identity is stable; the memo
// cache lives inside (see katex-memo.ts). `singleDollarTextMath` enables `$x$`
// inline math (the de-facto LLM convention).
const mathPlugin = createMemoizedMathPlugin({ singleDollarTextMath: true });

// Memoized block splitter (PRD §7 "LRU markdown-parse cache"). Streamdown lexes
// the whole message per flush; an LRU keyed on the exact source string removes
// repeat parses on remount / multi-surface render with zero correctness risk
// (same input → same output). Streaming tail growth misses by design.
const BLOCK_CACHE_MAX = 64;
const BLOCK_CACHE_MIN_LENGTH = 1024;
const blockCache = new Map<string, string[]>();

function parseMarkdownIntoBlocksCached(markdown: string): string[] {
  if (markdown.length < BLOCK_CACHE_MIN_LENGTH) return parseMarkdownIntoBlocks(markdown);
  const hit = blockCache.get(markdown);
  if (hit) {
    blockCache.delete(markdown);
    blockCache.set(markdown, hit);
    return hit;
  }
  const blocks = parseMarkdownIntoBlocks(markdown);
  blockCache.set(markdown, blocks);
  if (blockCache.size > BLOCK_CACHE_MAX) {
    blockCache.delete(blockCache.keys().next().value as string);
  }
  return blocks;
}

// Steady character-reveal for streaming text, ported verbatim from Hermes
// (`useSmoothReveal`). Decouples visible cadence from bursty arrival so text
// flows instead of popping — mandatory for Codex's line-paced file-tail deltas
// (PRD R3) and for not "popping in" plan-mode blocks (A3). Framework-agnostic.
const REVEAL_DRAIN_MS = 500;
const REVEAL_MAX_CHARS_PER_FRAME = 30;
const REVEAL_MIN_COMMIT_MS = 33;

function useSmoothReveal(text: string, isRunning: boolean): string {
  const [displayed, setDisplayed] = useState(isRunning ? '' : text);
  const targetRef = useRef(text);
  const shownRef = useRef(displayed);
  const frameRef = useRef<number | null>(null);
  const lastTickRef = useRef(0);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    // Track the latest target text for the rAF tick. `shownRef` is kept current
    // by the tick itself (and the reset below), so it never needs a render-time
    // write — the throttle cache lives entirely in effects, not in render.
    targetRef.current = text;

    // Non-extending change (regenerate / history swap): restart from empty
    // while streaming, else snap to the replacement.
    if (!text.startsWith(shownRef.current)) {
      shownRef.current = isRunning ? '' : text;
      setDisplayed(shownRef.current);
    }

    if (shownRef.current.length >= text.length || frameRef.current !== null) return;

    lastTickRef.current = performance.now();

    const tick = () => {
      const now = performance.now();
      const dt = now - lastTickRef.current;
      if (dt < REVEAL_MIN_COMMIT_MS) {
        frameRef.current = requestAnimationFrame(tick);
        return;
      }
      lastTickRef.current = now;
      const remaining = targetRef.current.length - shownRef.current.length;
      const add = Math.min(
        remaining,
        Math.ceil((REVEAL_MAX_CHARS_PER_FRAME * dt) / 16.7),
        Math.max(1, Math.ceil((remaining * dt) / REVEAL_DRAIN_MS))
      );
      shownRef.current = targetRef.current.slice(0, shownRef.current.length + add);
      setDisplayed(shownRef.current);
      frameRef.current =
        shownRef.current.length < targetRef.current.length ? requestAnimationFrame(tick) : null;
    };

    frameRef.current = requestAnimationFrame(tick);
  }, [text, isRunning]);

  useEffect(
    () => () => {
      if (frameRef.current !== null && typeof window !== 'undefined') {
        cancelAnimationFrame(frameRef.current);
      }
    },
    []
  );

  return displayed;
}

// Ace is dark-only (`<html class="dark">`); both slots of the shiki theme
// pair are the dark theme so fenced code highlights in dark colors regardless of
// `light-dark()` resolution. The `@streamdown/code` plugin is what actually runs
// shiki (the `shikiTheme` prop alone only builds CSS-var scaffolding); it folds
// the github-dark tokens into the `--shiki-dark` vars our code-block CSS reads.
const CODE_THEME: ['github-dark-default', 'github-dark-default'] = [
  'github-dark-default',
  'github-dark-default',
];
const codePlugin = createCodePlugin({ themes: CODE_THEME });

function AceLink({ href, children }: ComponentProps<'a'>) {
  const url = typeof href === 'string' ? href : '';
  const match = FILE_PATH_RE.exec(url);
  if (match) {
    // `path:line` code references: reveal the file in Finder (no open-at-line
    // IPC exists; never auto-launch an untrusted link).
    return (
      <button
        type="button"
        onClick={() => {
          if (match[1]) void aceApi.workspaces.openFolder(match[1]);
        }}
        className="break-words text-sky-300 underline-offset-2 hover:underline"
        title={`Reveal ${match[1]} in Finder`}
      >
        {children}
      </button>
    );
  }
  const isFileArtifact = FILE_URL_RE.test(url) || LOCAL_PATH_RE.test(url);
  if (isFileArtifact) {
    const path = fileUrlToPath(url);
    return (
      <a
        href={url}
        onClick={(e) => {
          e.preventDefault();
          if (path) void aceApi.workspaces.openFolder(path);
        }}
        className="inline-flex items-center gap-1 break-all text-sky-300 underline-offset-2 hover:underline"
        title={`Reveal ${path} in Finder`}
      >
        <FolderOpen className="inline-block h-3.5 w-3.5 shrink-0" aria-hidden />
        {children}
      </a>
    );
  }
  return (
    <a
      href={url}
      onClick={(e) => {
        e.preventDefault();
        if (!url) return;
        void aceApi.workspaces.openExternal(url);
      }}
      className="break-all text-sky-300 underline-offset-2 hover:underline"
    >
      {children}
    </a>
  );
}

const COMPONENTS = (() => {
  return {
    a: AceLink,
    // Render semantic <strong>/<em> rather than streamdown's
    // <span data-streamdown="strong">, so the `.ace-chat-md strong` gold-tint
    // CSS applies and bold stays accessible (matches the old markdown.tsx).
    strong: ({ children }: ComponentProps<'strong'>) => <strong>{children}</strong>,
    em: ({ children }: ComponentProps<'em'>) => <em>{children}</em>,
    // Fenced code is highlighted by streamdown's native shiki CodeBlock (wired
    // via `shikiTheme` below — streamdown bundles no shiki, so we install it).
    // Inline code keeps Ace's pill styling.
    inlineCode: ({ children }: ComponentProps<'code'>) => (
      <code className="ace-chat-md-code break-all rounded bg-white/[0.06] px-1 py-0.5 font-mono text-[12.5px] text-foreground/95">
        {children}
      </code>
    ),
    h1: ({ children }: ComponentProps<'h1'>) => (
      <h1 className="mt-3 mb-2 text-[16px] font-semibold tracking-tight">{children}</h1>
    ),
    h2: ({ children }: ComponentProps<'h2'>) => (
      <h2 className="mt-3 mb-2 text-[15px] font-semibold tracking-tight">{children}</h2>
    ),
    h3: ({ children }: ComponentProps<'h3'>) => (
      <h3 className="mt-2.5 mb-1.5 text-[14px] font-semibold tracking-tight">{children}</h3>
    ),
    h4: ({ children }: ComponentProps<'h4'>) => (
      <h4 className="mt-2 mb-1 text-[13.5px] font-semibold tracking-tight text-foreground/95">{children}</h4>
    ),
    p: ({ children }: ComponentProps<'p'>) => <p className="my-2 leading-[1.65]">{children}</p>,
    ul: ({ children }: ComponentProps<'ul'>) => (
      <ul className="my-2 ml-5 list-disc space-y-1 marker:text-foreground/50">{children}</ul>
    ),
    // Forward `start`: agents write numbered points split by sub-bullets, which
    // break the list in CommonMark so each point becomes its own <ol start="N">.
    ol: ({ children, start }: ComponentProps<'ol'>) => (
      <ol start={start} className="my-2 ml-5 list-decimal space-y-1 marker:text-foreground/55">{children}</ol>
    ),
    li: ({ children }: ComponentProps<'li'>) => <li className="leading-[1.6]">{children}</li>,
    blockquote: ({ children }: ComponentProps<'blockquote'>) => (
      <blockquote className="my-2 border-l-2 border-white/15 pl-3 text-foreground/85">{children}</blockquote>
    ),
    hr: () => <hr className="my-3 border-white/10" />,
    table: ({ children }: ComponentProps<'table'>) => (
      <div className="my-2 max-w-full overflow-x-auto">
        <table className="min-w-full border-collapse text-[12.5px]">{children}</table>
      </div>
    ),
    th: ({ children }: ComponentProps<'th'>) => (
      <th className="border border-white/10 bg-white/[0.04] px-2 py-1 text-left font-semibold">{children}</th>
    ),
    td: ({ children }: ComponentProps<'td'>) => (
      <td className="border border-white/10 px-2 py-1 align-top">{children}</td>
    ),
  } as ComponentProps<typeof Streamdown>['components'];
})();

const MAX_MARKDOWN_CHARS = 200_000;

function HugeTextFallback({ text }: { text: string }) {
  const chunks = useMemo(() => chunkByLines(text, 200), [text]);
  return (
    <div className="ace-chat-md w-full max-w-none overflow-hidden rounded-lg border border-white/[0.06] bg-black/40 p-2 font-mono text-[11px] leading-relaxed text-foreground/90">
      {chunks.map((chunk, index) => (
        <div
          className="whitespace-pre-wrap [content-visibility:auto]"
          key={index}
          style={{ containIntrinsicSize: `auto ${chunk.lines * 16}px` }}
        >
          {chunk.text}
        </div>
      ))}
    </div>
  );
}

export interface MarkdownTextProps {
  text: string;
  /** True while the underlying transcript entry is still `lifecycle: 'open'`. */
  streaming?: boolean;
  className?: string;
}

/**
 * Token-live markdown surface. `streaming` drives the SmoothReveal + defer-shiki
 * path; when false (settled messages, static callers) the full text renders at
 * once.
 */
export const MarkdownText = memo(function MarkdownText({ text, streaming = false, className }: MarkdownTextProps) {
  const revealed = useSmoothReveal(text || '', streaming);
  const deferred = useDeferredValue(revealed);

  if (deferred.length > MAX_MARKDOWN_CHARS) {
    return <HugeTextFallback text={deferred} />;
  }

  return (
    <div className={cn('ace-chat-md min-w-0', className)}>
      <Streamdown
        mode={streaming ? 'streaming' : 'static'}
        className="min-w-0"
        components={COMPONENTS}
        plugins={{ math: mathPlugin, code: codePlugin }}
        parseMarkdownIntoBlocksFn={parseMarkdownIntoBlocksCached}
        shikiTheme={CODE_THEME}
        lineNumbers={false}
      >
        {deferred}
      </Streamdown>
    </div>
  );
});

/**
 * Backward-compatible drop-in for the old `markdown.tsx` `Markdown` component.
 * Same `{ children: string }` signature so the non-streaming callers
 * (SpecSidecar, KnowledgeResultRow, WikiGraphPanel)
 * migrate with an import-path change only (PRD D2/A9).
 */
export function Markdown({ children }: { children: string }) {
  return <MarkdownText text={children} streaming={false} />;
}
