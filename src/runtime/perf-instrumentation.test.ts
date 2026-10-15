import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

describe('snappiness perf instrumentation', () => {
  it('records route.switch after app view transitions paint', () => {
    const store = readFileSync(join(root, 'src/store.tsx'), 'utf8');

    expect(store).toContain("name: 'route.switch'");
    expect(store).toContain('afterNextPaint');
    expect(store).toContain('routeChangeRef.current = { from: current, to: resolved');
  });

  it('records chat.send spans for every smart composer send path', () => {
    const perf = readFileSync(join(root, 'src/runtime/perf-health.ts'), 'utf8');
    expect(perf).toContain('export async function timePerf');

    for (const file of [
      'src/components/ace-chat/composers/ClaudeComposer.tsx',
      'src/components/ace-chat/composers/CodexComposer.tsx',
      'src/components/ace-chat/composers/GeminiComposer.tsx',
      'src/components/ace-chat/composers/HermesComposer.tsx',
    ]) {
      const source = readFileSync(join(root, file), 'utf8');
      expect(source).toMatch(/timePerf\(\s*['"]chat\.send['"]/);
      expect(source).toContain('chars:');
      expect(source).toContain('attachmentCount');
      expect(source).not.toContain('meta: { text');
    }
  });
});
