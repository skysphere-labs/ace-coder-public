import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MarkdownText } from './MarkdownText';

// Proves the streamdown wiring decision empirically: fenced code flows through
// Streamdown's code plugin, and `$…$` math renders through the memoized katex
// plugin. A static render is enough to confirm both the routing and the
// synchronous katex output.

// aceApi is only referenced inside link click handlers (never at render); the
// module pulls in the preload bridge, so stub it for the node render.
vi.mock('../../../lib/ace-api', () => ({ aceApi: { workspaces: {} } }));

const SAMPLE = [
  'Here is a note with `inline code` and a [link](https://example.com).',
  '',
  '```js',
  'function add(a, b) {',
  '  return a + b;',
  '}',
  '```',
  '',
  'Euler: $e^{i\\pi} + 1 = 0$',
].join('\n');

describe('renderer produces real shiki + katex DOM (PRD A1)', () => {
  const html = renderToStaticMarkup(<MarkdownText text={SAMPLE} streaming={false} />);

  it('renders fenced code as a highlighted <pre> code block (streamdown shiki)', () => {
    expect(html).toContain('<pre');
    expect(html).toContain('function add');
    // shiki emits per-token spans carrying the dark theme CSS variables
    expect(html).toMatch(/--shiki-dark|--sdm-c/);
  });
  it('renders inline code with the Ace pill', () => {
    expect(html).toContain('ace-chat-md-code');
  });
  it('renders katex math (memoized plugin ran)', () => {
    expect(html).toContain('katex');
  });
  it('renders the markdown prose container', () => {
    expect(html).toContain('ace-chat-md');
  });
});
