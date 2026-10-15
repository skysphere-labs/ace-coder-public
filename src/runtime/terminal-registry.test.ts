import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  sanitizeComposerDraftText,
  sanitizeTerminalInputPayload,
} from './terminal-safety';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, 'terminal-registry.ts'), 'utf8');
// PTY-input helpers (writeTerminalInput / pasteToTerminal) live in the
// xterm-free terminal-io sibling so the eager boot graph can import them
// without pulling xterm; terminal-registry re-exports them.
const ioSource = readFileSync(resolve(here, 'terminal-io.ts'), 'utf8');
const apiSource = readFileSync(resolve(here, '../lib/ace-api.ts'), 'utf8');
const feedSource = readFileSync(resolve(here, '../components/TerminalFeed.tsx'), 'utf8');
const cssSource = readFileSync(resolve(here, '../index.css'), 'utf8');

describe('terminal-registry xterm options', () => {
  it('drops generated terminal control payloads with invalid coordinates before PTY stdin', () => {
    expect(sanitizeTerminalInputPayload('\x1b[<0;NaN;NaNM')).toBeNull();
    expect(sanitizeTerminalInputPayload('\x1b[NaN;NaNM')).toBeNull();
    expect(sanitizeTerminalInputPayload('\x1b[<0;Infinity;2M')).toBeNull();
    expect(sanitizeTerminalInputPayload('aN;NaNMaN;NaNMaN;NaNMa')).toBeNull();
    expect(sanitizeTerminalInputPayload('ship itaN;NaNMaN;NaNMa')).toBe('ship it');
    expect(sanitizeTerminalInputPayload('NaN')).toBe('NaN');
    expect(sanitizeTerminalInputPayload('\x1b[200~NaN\x1b[201~')).toBe(
      '\x1b[200~NaN\x1b[201~'
    );
  });

  it('removes generated NaN fragments from composer draft text only when they are garbage', () => {
    expect(sanitizeComposerDraftText('aN;NaNMaN;NaNMa')).toBe('');
    expect(sanitizeComposerDraftText('\x1b[<0;NaN;NaNM')).toBe('');
    expect(sanitizeComposerDraftText('continue this plzaN;NaNMaN;NaNMa')).toBe(
      'continue this plz'
    );
    expect(sanitizeComposerDraftText('explain JavaScript NaN')).toBe('explain JavaScript NaN');
  });

  it('wires the onData boundary through the generated-control sanitizer', () => {
    expect(source).toContain('sanitizeTerminalInputPayload(data)');
    expect(source).toContain('if (safe === null) return;');
    expect(source).toContain('aceApi.runtime.writeTerminalInput(streamId, safe)');
    // pasteToTerminal moved to the xterm-free terminal-io module; the draft
    // sanitizer boundary lives there now.
    expect(ioSource).toContain('sanitizeComposerDraftText(content.text)');
  });

  it('guards renderer terminal and send-submit IPC payloads', () => {
    expect(source).toContain('const safe = sanitizeTerminalInputPayload(data)');
    expect(apiSource).toContain('sanitizeTerminalInputPayload(data)');
    expect(apiSource).toContain('sanitizeStreamTextPayload(text)');
    expect(apiSource).toContain("invoke<{ ok: boolean }>('streamSendSubmit', { streamId, text: safe })");
  });

  it('uses lineHeight 1.0 so Hermes/Rook/King streaming output is not vertically padded', () => {
    expect(source).toContain('lineHeight: 1.0');
    expect(source).not.toContain('lineHeight: 1.2');
  });

  it('keeps a 13px monospace baseline so the cursor row matches the composer reserve area', () => {
    expect(source).toContain('fontSize: 13');
    expect(source).toContain('FALLBACK_FONTS');
  });

  it('keeps terminal panes shrinkable and clipped so wide CLI output refits instead of sliding under side panels', () => {
    expect(feedSource).toContain('terminal-surface relative h-full min-w-0 w-full overflow-hidden');
    expect(feedSource).toContain('terminal-host h-full min-w-0 w-full overflow-hidden');
    expect(cssSource).toContain('.terminal-host .ace-terminal-session');
    expect(cssSource).toContain('max-width: 100%');
  });

  it('attaches and fits the terminal only while the CLI surface is active', () => {
    expect(feedSource).toContain('active = true');
    expect(feedSource).toContain('if (!container || !streamId || !active) return;');
    expect(feedSource).toContain('[streamId, interactive, active]');
  });

  it('opens terminal URL clicks through the external browser bridge', () => {
    expect(source).toContain('function openTerminalLink(event: MouseEvent | undefined, uri: string)');
    expect(source).toContain('aceApi.workspaces.openExternal(uri, { forceExternal: true })');
    expect(source).toContain('new WebLinksAddon(openTerminalLink)');
    expect(source).not.toContain('new WebLinksAddon()');
  });

  it('makes OSC 8 hyperlinks and touch taps open links, web schemes only', () => {
    // OSC 8 escape-sequence hyperlinks route through the same opener as
    // plain-text URLs.
    expect(source).toContain('linkHandler: {');
    expect(source).toContain('activate: (event, text) => openTerminalLink(event, text)');
    // The opener refuses non-web schemes (OSC 8 can carry arbitrary ones).
    expect(source).toContain("if (!/^https?:\\/\\//i.test(uri)) return;");
    // A touch tap over a URL opens it instead of focusing the input, and the
    // synthesized-click echo can't open a second tab.
    expect(source).toContain('findLinkAtCoords(terminal, wrapper, startX, startY)');
    expect(source).toContain('lastOpenedLinkUri');
  });

  it('lets xterm own its internal viewport, screen, and helper textarea geometry', () => {
    expect(cssSource).toContain('.terminal-host .xterm {');
    expect(cssSource).not.toMatch(/\.terminal-host \.xterm-viewport,\s*\.terminal-host \.xterm-screen,\s*\.terminal-host \.xterm-helper-textarea\s*\{\s*height: 100%;/);
    expect(cssSource).not.toMatch(/\.terminal-host \.xterm-helper-textarea\s*\{[^}]*height: 100%;/);
  });
});

describe('mobile terminal perf + scroll fixes', () => {
  it('never snaps the viewport to the bottom on erase-in-display', () => {
    // Agent TUIs erase-display on every streaming repaint; snap-to-bottom
    // yanks a scrolled-up reader down several times a second. Touch got the
    // fix first; desktop's kept snap read as unresponsive scrolling and is
    // gone too. The "jump to live" chip is the way back down everywhere.
    expect(source).toContain('scrollOnEraseInDisplay: false');
    expect(source).not.toContain('scrollOnEraseInDisplay: true');
    expect(source).not.toContain('scrollOnEraseInDisplay: !isTouchOrRemoteClient()');
  });

  it('budgets WebGL contexts for the client: iOS Safari caps far below desktop Chromium', () => {
    // Pool eviction: terminal-webgl-pool.test.ts. Attach/park/catch-up
    // wiring: terminal-feed-lifecycle.render.test.tsx. Resync behavior:
    // terminal-parked-integration.test.ts. Only the client-budget constant
    // is pinned here - no unit suite can exercise a real GPU cap.
    expect(source).toContain('isTouchOrRemoteClient() ? 4 : 12');
  });

  it('settles viewport churn before refitting so the keyboard does not thrash the PTY', () => {
    // The soft keyboard / URL bar fire the ResizeObserver every frame; a settle
    // timer coalesces the burst so exactly one resize lands at the final size.
    expect(feedSource).toContain('scheduleFitSettled');
    expect(feedSource).toContain('new ResizeObserver(scheduleFitSettled)');
    expect(feedSource).toContain("window.addEventListener('resize', scheduleFitSettled)");
  });
});
