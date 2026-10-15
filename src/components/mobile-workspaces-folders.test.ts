import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const screen = readFileSync(resolve(here, 'MobileWorkspacesScreen.tsx'), 'utf8');
const registry = readFileSync(resolve(here, '../runtime/workspace-folders-registry.ts'), 'utf8');

describe('Workspaces collapsible folders', () => {
  it('drives the screen from the folders registry', () => {
    expect(screen).toContain('useWorkspaceFolders');
    expect(screen).toContain('reconcile(');
    expect(screen).toContain('UNGROUPED_ID');
  });

  it('renders collapsible folder sections with persisted collapse', () => {
    expect(screen).toContain('FolderSection');
    expect(screen).toContain('setCollapsed(');
    expect(screen).toContain('motion-safe:animate-in'); // expand/collapse animation
  });

  it('lets a workspace be moved between folders', () => {
    expect(screen).toContain('MoveToFolderSheet');
    expect(screen).toContain('assignWorkspace(');
    expect(screen).toContain('createFolder(');
  });

  it('offers generic, opt-in auto-grouping by repo', () => {
    expect(screen).toContain('applyAutoSuggestions(');
  });

  it('persists folders under a versioned localStorage key via useSyncExternalStore', () => {
    expect(registry).toContain("'ace:workspace-folders-v1'");
    expect(registry).toContain('useSyncExternalStore');
  });
});
