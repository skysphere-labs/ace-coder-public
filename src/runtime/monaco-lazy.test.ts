import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

describe('Monaco boot path', () => {
  it('keeps Monaco out of the top-level renderer startup bundle', () => {
    const main = readFileSync(join(root, 'src/main.tsx'), 'utf8');
    expect(main).not.toContain('monaco-setup');
    expect(main).not.toContain('setupMonaco()');
  });

  it('loads Monaco only from the file editor surface', () => {
    const editorPane = readFileSync(join(root, 'src/components/EditorPane.tsx'), 'utf8');
    const monacoEditor = readFileSync(join(root, 'src/components/MonacoFileEditor.tsx'), 'utf8');

    expect(editorPane).toContain("lazy(() =>");
    expect(editorPane).toContain("import('./MonacoFileEditor')");
    expect(monacoEditor).toContain("import { setupMonaco } from '../lib/monaco-setup';");
    expect(monacoEditor).toContain('setupMonaco();');
  });

  it('does not ask Vite to preload Monaco during shell startup', () => {
    const viteConfig = readFileSync(join(root, 'vite.config.ts'), 'utf8');

    expect(viteConfig).toContain('isDeferredStartupDependency');
    expect(viteConfig).toContain('modulePreload');
    expect(viteConfig).toContain('resolveDependencies');
    expect(viteConfig).not.toContain("return 'monaco'");
  });

  it('keeps deferred editor assets out of the PWA precache', () => {
    const viteConfig = readFileSync(join(root, 'vite.config.ts'), 'utf8');

    expect(viteConfig).not.toContain("**/*.{js,css,html,svg,png,ico,woff,woff2}");
    expect(viteConfig).toContain("'assets/MonacoFileEditor-*'");
    expect(viteConfig).toContain("'assets/*.worker-*.js'");
  });
});
