// Hermes-style chat renderer (PRD Lane 1). The polished text layer that
// replaces the old `markdown.tsx` bare renderer (PRD D2). Built on raw
// streamdown + shiki + katex — no `@assistant-ui` (PRD D8).
export { MarkdownText, Markdown, type MarkdownTextProps } from './MarkdownText';
export { chunkByLines } from './code-budget';
export { createMemoizedMathPlugin } from './katex-memo';
