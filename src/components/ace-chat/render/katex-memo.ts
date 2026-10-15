/**
 * Memoizing wrapper around `rehype-katex`, ported near-verbatim from Hermes
 * (`apps/desktop/src/lib/katex-memo.ts`). Framework-agnostic — it is a unified
 * rehype plugin, so it drops straight onto raw `streamdown`'s `plugins.math`
 * slot with no `@assistant-ui` coupling (PRD D8).
 *
 * Why: streamdown re-runs the math rehype pass on every markdown commit. During
 * streaming that means each new token re-runs KaTeX on EVERY math node —
 * including equations that have not changed since the last token. For
 * math-heavy answers that is a major source of jank. This walks the hast tree,
 * keys math nodes by `(displayMode, value)`, and serves repeats from an LRU so
 * each unique equation pays the KaTeX cost once (PRD §7: "memoized katex, LRU
 * 512").
 *
 * Compatibility: produces the same hast structure rehype-katex itself produces
 * (same `hast-util-from-html-isomorphic` fragment parsing, same parent-splice
 * semantics, same `<pre>`-walk-up for display mode). The shape returned by
 * `createMemoizedMathPlugin` matches streamdown's `MathPlugin` interface.
 */

import type { Element, ElementContent, Parent, Root } from 'hast';
import { fromHtmlIsomorphic } from 'hast-util-from-html-isomorphic';
import { toText } from 'hast-util-to-text';
import katex from 'katex';
import remarkMath from 'remark-math';
import type { Pluggable } from 'unified';
import { SKIP, visitParents } from 'unist-util-visit-parents';
import type { VFile } from 'vfile';

interface KatexMemoOptions {
  errorColor?: string;
}

interface MathPluginConfig {
  /**
   * Match `singleDollarTextMath`. When true the remark-math parser treats `$x$`
   * as inline math; when false it requires `$$x$$`. Models almost always emit
   * the single-dollar form, so the call site defaults it to true.
   */
  singleDollarTextMath?: boolean;
  errorColor?: string;
}

/** Cached rendered hast — children to splice into the math node's parent. */
type CachedRender = ElementContent[];

const CACHE_LIMIT = 512;

class LruCache<K, V> {
  private readonly map = new Map<K, V>();

  get(key: K): undefined | V {
    const value = this.map.get(key);
    if (value === undefined) return undefined;
    // Refresh recency by re-inserting at the tail.
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= CACHE_LIMIT) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, value);
  }
}

const cache = new LruCache<string, CachedRender>();

function cacheKey(displayMode: boolean, value: string): string {
  return `${displayMode ? 'd' : 'i'}${value}`;
}

function renderMath(
  value: string,
  displayMode: boolean,
  errorColor: string,
  file: VFile,
  element: Element
): ElementContent[] {
  let html: string;
  try {
    html = katex.renderToString(value, { displayMode, throwOnError: true });
  } catch (error) {
    const cause = error as Error;
    file.message('Could not render math with KaTeX', {
      cause,
      place: element.position,
      ruleId: cause.name?.toLowerCase() ?? 'katex',
      source: 'rehype-katex-memo',
    });
    try {
      html = katex.renderToString(value, {
        displayMode,
        errorColor,
        strict: 'ignore',
        throwOnError: false,
      });
    } catch {
      return [
        {
          type: 'element',
          tagName: 'span',
          properties: {
            className: ['katex-error'],
            style: `color:${errorColor}`,
            title: String(error),
          },
          children: [{ type: 'text', value }],
        },
      ];
    }
  }

  const fragment = fromHtmlIsomorphic(html, { fragment: true });
  return fragment.children as ElementContent[];
}

function createMemoizedRehypeKatex(options: KatexMemoOptions = {}): Pluggable {
  const errorColor = options.errorColor ?? 'var(--color-muted-foreground, #b0a48f)';

  return () =>
    function transform(tree: Root, file: VFile): undefined {
      visitParents(tree, 'element', (element, parents) => {
        const classes = Array.isArray(element.properties?.className)
          ? (element.properties.className as string[])
          : [];

        const languageMath = classes.includes('language-math');
        const mathDisplay = classes.includes('math-display');
        const mathInline = classes.includes('math-inline');

        if (!(languageMath || mathDisplay || mathInline)) return;

        let displayMode = mathDisplay;
        let scope: Element = element;
        let parent: Parent | undefined = parents[parents.length - 1];

        if (languageMath && parent && parent.type === 'element' && (parent as Element).tagName === 'pre') {
          scope = parent as Element;
          parent = parents[parents.length - 2];
          displayMode = true;
        }

        if (!parent) return;

        const value = toText(scope, { whitespace: 'pre' });
        const key = cacheKey(displayMode, value);
        let cached = cache.get(key);

        if (!cached) {
          cached = renderMath(value, displayMode, errorColor, file, scope);
          cache.set(key, cached);
        }

        // Splice CLONES of the cached children so downstream plugins can't
        // mutate the cached subtree and break the next cache hit.
        const clonedChildren = cached.map((child) => structuredClone(child));
        const index = parent.children.indexOf(scope as ElementContent);
        if (index === -1) return;
        parent.children.splice(index, 1, ...clonedChildren);
        return SKIP;
      });
    };
}

/**
 * Build a streamdown `MathPlugin` that uses the memoized rehype-katex wrapper.
 * Drop-in for the `plugins.math` slot.
 */
export function createMemoizedMathPlugin(config: MathPluginConfig = {}) {
  const remarkPlugin: Pluggable = [
    remarkMath,
    { singleDollarTextMath: config.singleDollarTextMath ?? false },
  ];
  const rehypePlugin = createMemoizedRehypeKatex({ errorColor: config.errorColor });
  return {
    name: 'katex' as const,
    type: 'math' as const,
    remarkPlugin,
    rehypePlugin,
    getStyles: () => 'katex/dist/katex.min.css',
  };
}
