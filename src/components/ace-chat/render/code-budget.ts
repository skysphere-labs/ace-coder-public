// Huge markdown fallback helper, kept outside MarkdownText so fast-refresh stays
// component-only.

export interface CodeChunk {
  text: string;
  lines: number;
}

/** Split into N-line chunks so a huge block can render with content-visibility. */
export function chunkByLines(code: string, perChunk: number): CodeChunk[] {
  const lines = code.split('\n');
  if (lines.length <= perChunk) return [{ text: code, lines: lines.length }];
  const chunks: CodeChunk[] = [];
  for (let i = 0; i < lines.length; i += perChunk) {
    const slice = lines.slice(i, i + perChunk);
    chunks.push({ text: slice.join('\n'), lines: slice.length });
  }
  return chunks;
}
