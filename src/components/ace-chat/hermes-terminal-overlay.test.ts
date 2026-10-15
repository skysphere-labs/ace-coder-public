import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const componentsRoot = resolve(here, '..');
const conversationPaneSource = readFileSync(resolve(componentsRoot, 'ConversationPane.tsx'), 'utf8');
const modeRegistrySource = readFileSync(resolve(componentsRoot, '../runtime/ace-chat-mode-registry.ts'), 'utf8');
const toggleSource = readFileSync(resolve(here, 'ViewToggle.tsx'), 'utf8');
const removedOverlayPanePath = resolve(here, 'HermesTerminalPane.tsx');

describe('Hermes terminal single-pane routing', () => {
  it('routes Hermes through AceChatPane so the smart composer toolbar mounts', () => {
    // Chat pane is hermes-only; coding agents always get the raw terminal.
    expect(modeRegistrySource).toContain("return value === 'hermes';");
    expect(modeRegistrySource).not.toContain("value === 'claude'");
    expect(conversationPaneSource).toContain('isAceChatAgent(agent)');
    expect(conversationPaneSource).toContain("key={agent === 'hermes' ? streamId : undefined}");
    expect(conversationPaneSource).toContain('streamId={streamId}');
    expect(conversationPaneSource).toContain('agent={agent}');
    expect(conversationPaneSource).toContain('taskId={taskId ?? null}');
    expect(conversationPaneSource).toContain('<TerminalFeed streamId={streamId} />');
    expect(conversationPaneSource).not.toContain('HermesTerminalPane');
  });

  it('keeps the legacy Hermes terminal-pane overlay file removed', () => {
    expect(existsSync(removedOverlayPanePath)).toBe(false);
    expect(conversationPaneSource).not.toContain('HermesTerminalComposer');
  });

  it('does not mount or import the formatter/readable-output path', () => {
    expect(conversationPaneSource).not.toContain('HermesReadableOutput');
    expect(conversationPaneSource).not.toContain('hermes-readable-output');
    expect(conversationPaneSource).not.toMatch(/Formatted output|Formatted|formatted/);
    expect(existsSync(resolve(here, 'hermes-readable-output.tsx'))).toBe(false);
    expect(existsSync(resolve(here, 'hermes-readable-output-parser.ts'))).toBe(false);
  });

  it('removes formatted as a shared view-toggle mode', () => {
    expect(toggleSource).toContain("export type ViewToggleMode = 'cli' | 'chat';");
    expect(toggleSource).not.toMatch(/formatted|Formatted/);
    expect(toggleSource).not.toContain('FileText');
  });

  it('does not keep a Hermes direct ask composer in the lane pane', () => {
    expect(conversationPaneSource).not.toContain('aceApi.streams.ask');
    expect(conversationPaneSource).not.toContain('agentSpeechQueue');
  });
});
