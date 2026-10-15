import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createMemoizedMathPlugin } from './katex-memo';

// Lane 1 — Hermes-style renderer (PRD §7). This repo verifies renderer wiring by
// asserting on source + pure logic (no jsdom); the live shiki/katex DOM render is
// proven separately in a real browser (docs/ops/spike + headless proof).
const here = dirname(fileURLToPath(import.meta.url));
const markdownText = readFileSync(resolve(here, 'MarkdownText.tsx'), 'utf8');
const katexMemo = readFileSync(resolve(here, 'katex-memo.ts'), 'utf8');
const codeBudget = readFileSync(resolve(here, 'code-budget.ts'), 'utf8');
const barrel = readFileSync(resolve(here, 'index.ts'), 'utf8');

describe('renderer is built on the lifted libs, not @assistant-ui (PRD D8)', () => {
  it('MarkdownText renders through raw streamdown', () => {
    expect(markdownText).toMatch(/from 'streamdown'/);
    expect(markdownText).toMatch(/<Streamdown/);
  });
  it('no file in render/ imports @assistant-ui', () => {
    for (const src of [markdownText, katexMemo, codeBudget, barrel]) {
      expect(src).not.toMatch(/from ['"]@assistant-ui/);
    }
  });
});

describe('streaming smoothness (PRD §7 / R3 / A3)', () => {
  it('MarkdownText uses SmoothReveal + useDeferredValue', () => {
    expect(markdownText).toMatch(/useSmoothReveal/);
    expect(markdownText).toMatch(/useDeferredValue/);
  });
  it('keeps the ~33ms commit floor and rAF reveal', () => {
    expect(markdownText).toMatch(/REVEAL_MIN_COMMIT_MS\s*=\s*33/);
    expect(markdownText).toMatch(/requestAnimationFrame/);
  });
  it('LRU markdown-parse cache is wired into streamdown', () => {
    expect(markdownText).toMatch(/parseMarkdownIntoBlocksCached/);
    expect(markdownText).toMatch(/parseMarkdownIntoBlocksFn=\{parseMarkdownIntoBlocksCached\}/);
  });
});

describe('huge message fallback (PRD §7 / R4)', () => {
  it('MarkdownText caps whole-message size with a chunked fallback', () => {
    expect(markdownText).toMatch(/MAX_MARKDOWN_CHARS\s*=\s*200_000/);
    expect(markdownText).toMatch(/HugeTextFallback/);
    expect(codeBudget).toMatch(/chunkByLines/);
  });
});

describe('Ace behavior is preserved (no regressions — A9)', () => {
  it('MarkdownText keeps the file-ref / external-link logic from the old markdown.tsx', () => {
    expect(markdownText).toMatch(/workspaces\.openExternal/);
    expect(markdownText).toMatch(/workspaces\.openFolder/);
    expect(markdownText).toMatch(/FILE_PATH_RE/);
  });
  it('highlights fenced code via streamdown native shiki (dark theme pair)', () => {
    expect(markdownText).toMatch(/shikiTheme=\{CODE_THEME\}/);
    expect(markdownText).toMatch(/github-dark-default/);
  });
  it('exposes the old `Markdown` drop-in + the new MarkdownText', () => {
    expect(barrel).toMatch(/MarkdownText/);
    expect(barrel).toMatch(/Markdown/);
    expect(markdownText).toMatch(/export function Markdown/);
  });
});

describe('the old bare renderer is gone (PRD D2)', () => {
  it('markdown.tsx is deleted', () => {
    expect(existsSync(resolve(here, '..', 'markdown.tsx'))).toBe(false);
  });
});

describe('memoized katex plugin (PRD §7 LRU 512)', () => {
  it('katex-memo keeps a 512-entry LRU', () => {
    expect(katexMemo).toMatch(/CACHE_LIMIT\s*=\s*512/);
  });
  it('produces a streamdown-compatible math plugin', () => {
    const plugin = createMemoizedMathPlugin({ singleDollarTextMath: true });
    expect(plugin.name).toBe('katex');
    expect(plugin.type).toBe('math');
    expect(plugin.remarkPlugin).toBeTruthy();
    expect(plugin.rehypePlugin).toBeTruthy();
    expect(typeof plugin.getStyles).toBe('function');
    expect(plugin.getStyles?.()).toBe('katex/dist/katex.min.css');
  });
});
