import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Guard: the ~580KB xterm terminal engine must never re-enter the renderer's
// eager startup graph. It is the single biggest chunk a phone would download at
// boot for a terminal that isn't on screen yet, so every path to it must be a
// dynamic import() (lazy screen, lazy TerminalPanel) — not a static import.
//
// Rather than assert on specific source strings (which break on refactors),
// this walks the STATIC import graph from the renderer entry and fails if any
// eager chain reaches an `@xterm/*` JS module. The stylesheet import
// (`@xterm/xterm/css/xterm.css`) is allowed: it ships ~5KB of CSS, not the
// engine, and Vite keeps it out of the JS chunk (see vite.config manualChunks).
const SRC = resolve(process.cwd(), 'src');
const EXTS = ['.ts', '.tsx', '.js', '.jsx'];

function resolveSpec(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null; // bare / node_modules — not followed
  const base = resolve(dirname(fromFile), spec);
  for (const e of EXTS) if (existsSync(base + e)) return base + e;
  for (const e of EXTS) if (existsSync(join(base, 'index' + e))) return join(base, 'index' + e);
  if (existsSync(base) && statSync(base).isFile()) return base;
  return null;
}

// Static specifiers only: `import/export ... from 'x'` and side-effect
// `import 'x'`. Dynamic `import('x')` (which has a paren, never ` from `) is
// intentionally NOT matched — that is exactly the lazy boundary we want.
function staticSpecifiers(file: string): string[] {
  const code = readFileSync(file, 'utf8');
  const specs: string[] = [];
  const fromRe = /(?:^|\n)\s*(?:import|export)\s[^;]*?\sfrom\s*['"]([^'"]+)['"]/g;
  const sideRe = /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = fromRe.exec(code))) specs.push(m[1]);
  while ((m = sideRe.exec(code))) specs.push(m[1]);
  return specs;
}

function eagerXtermChains(): string[][] {
  const entry = join(SRC, 'main.tsx');
  const visited = new Set<string>();
  const queue: Array<[string, string[]]> = [[entry, ['main.tsx']]];
  const hits: string[][] = [];
  while (queue.length) {
    const [file, trail] = queue.shift()!;
    if (visited.has(file)) continue;
    visited.add(file);
    let specs: string[];
    try {
      specs = staticSpecifiers(file);
    } catch {
      continue;
    }
    for (const spec of specs) {
      if (spec.startsWith('@xterm/') && !spec.endsWith('.css')) {
        hits.push([...trail, spec]);
        continue;
      }
      const r = resolveSpec(file, spec);
      if (r && !visited.has(r)) queue.push([r, [...trail, r.slice(SRC.length + 1)]]);
    }
  }
  return hits;
}

describe('xterm boot path', () => {
  it('keeps the xterm JS engine out of the eager renderer startup graph', () => {
    const chains = eagerXtermChains();
    const rendered = chains.map((c) => c.join(' -> ')).join('\n');
    expect(chains, `eager @xterm JS import chain(s):\n${rendered}`).toHaveLength(0);
  });

  it('still allows the xterm stylesheet at boot (styling, not the engine)', () => {
    const main = readFileSync(join(SRC, 'main.tsx'), 'utf8');
    expect(main).toContain("@xterm/xterm/css/xterm.css");
  });

  it('does not bucket xterm CSS into the xterm JS chunk', () => {
    const viteConfig = readFileSync(join(process.cwd(), 'vite.config.ts'), 'utf8');
    // The CSS must be excluded from the manual xterm chunk, else importing it
    // eagerly drags the JS engine back into the boot bundle.
    expect(viteConfig).toContain("id.includes('@xterm') && !id.endsWith('.css')");
  });
});
