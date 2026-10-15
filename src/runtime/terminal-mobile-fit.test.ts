import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  MOBILE_TERMINAL_COLS,
  MOBILE_TERMINAL_MAX_FONT,
  MOBILE_TERMINAL_MIN_FONT,
  mobileTerminalFontSize,
} from './terminal-mobile-fit';
import { sanitizeTerminalDimensions } from './terminal-safety';

const here = dirname(fileURLToPath(import.meta.url));
const registrySource = readFileSync(resolve(here, 'terminal-registry.ts'), 'utf8');
const feedSource = readFileSync(resolve(here, '../components/TerminalFeed.tsx'), 'utf8');
const apiSource = readFileSync(resolve(here, '../lib/ace-api.ts'), 'utf8');
const shellSource = readFileSync(resolve(here, '../components/MobileShell.tsx'), 'utf8');
const chatPaneSource = readFileSync(
  resolve(here, '../components/ace-chat/AceChatPane.tsx'),
  'utf8'
);

// Menlo-class monospace advance width per 1px of font size.
const MENLO_RATIO = 0.6;

describe('mobileTerminalFontSize', () => {
  it('fits a portrait phone width at a readable size', () => {
    // iPhone 15 Pro portrait ≈ 393px → 50 cols at 13px fits (390px), which is
    // also the desktop-default cap. Narrower phones still land ≥10px.
    expect(mobileTerminalFontSize(393, MENLO_RATIO)).toBe(13);
    expect(mobileTerminalFontSize(320, MENLO_RATIO)).toBe(10);
  });

  it('never drops below the floor on degenerate widths', () => {
    expect(mobileTerminalFontSize(200, MENLO_RATIO)).toBe(MOBILE_TERMINAL_MIN_FONT);
    expect(mobileTerminalFontSize(0, MENLO_RATIO)).toBe(MOBILE_TERMINAL_MIN_FONT);
    expect(mobileTerminalFontSize(393, 0)).toBe(MOBILE_TERMINAL_MIN_FONT);
    expect(mobileTerminalFontSize(Number.NaN, MENLO_RATIO)).toBe(MOBILE_TERMINAL_MIN_FONT);
    expect(mobileTerminalFontSize(Number.POSITIVE_INFINITY, MENLO_RATIO)).toBe(MOBILE_TERMINAL_MIN_FONT);
    expect(mobileTerminalFontSize(393, Number.NaN)).toBe(MOBILE_TERMINAL_MIN_FONT);
  });

  it('caps at the desktop default on wide/landscape viewports', () => {
    expect(mobileTerminalFontSize(2000, MENLO_RATIO)).toBe(MOBILE_TERMINAL_MAX_FONT);
  });

  it('always fits the pinned column count within the container', () => {
    for (let width = 300; width <= 900; width += 25) {
      const font = mobileTerminalFontSize(width, MENLO_RATIO);
      if (font > MOBILE_TERMINAL_MIN_FONT) {
        expect(MOBILE_TERMINAL_COLS * font * MENLO_RATIO).toBeLessThanOrEqual(width);
      }
    }
  });
});

// R-mobile-cli — the fixed-size CLI invariants. The PTY column count must be
// pinned on phones (width jitter must never horizontally reflow a TUI), and
// the resume/sync path must neither drop chunks nor strand a client at the
// server's dims. Locked by source assertion per this repo's convention.
describe('mobile fixed CLI sizing wiring', () => {
  it('rejects non-finite and collapsed terminal dimensions before resize', () => {
    expect(sanitizeTerminalDimensions(Number.NaN, 24)).toBeNull();
    expect(sanitizeTerminalDimensions(80, Number.POSITIVE_INFINITY)).toBeNull();
    expect(sanitizeTerminalDimensions('NaN', 24)).toBeNull();
    expect(sanitizeTerminalDimensions(0, 24)).toBeNull();
    expect(sanitizeTerminalDimensions(80, -1)).toBeNull();
    expect(sanitizeTerminalDimensions(80.9, 24.2)).toEqual({ cols: 80, rows: 24 });
  });

  it('pins mobile columns instead of fitting them to the container', () => {
    expect(registrySource).toContain('sanitizeTerminalDimensions(MOBILE_TERMINAL_COLS, rows)');
    expect(feedSource).toContain('proposeMobileDimensions(streamId, container.clientWidth)');
    expect(feedSource).toContain('window.matchMedia(MOBILE_MEDIA_QUERY).matches');
  });

  it('refuses degenerate dims from transient layout collapse', () => {
    expect(feedSource).toContain('sanitizeTerminalDimensions(dims.cols, dims.rows, 20, 4)');
  });

  // The soft keyboard overlays 100dvh rather than shrinking it; without the
  // visualViewport inset the composer hides behind the keyboard and the
  // terminal keeps a dead gap above it.
  it('shrinks the mobile shell to the keyboard-visible viewport', () => {
    expect(shellSource).toContain('useMobileKeyboardInset()');
    expect(shellSource).toContain('calc(100dvh - ${keyboardInset}px)');
  });

  // With the in-pane header and composer dropped on mobile, the terminal is
  // the grid's only child and auto-places into the `auto` header row — it
  // collapses to content height (~100px) and the 1fr row becomes a giant
  // dead gap between the CLI and the composer.
  it('gives the terminal the full pane height when mobile drops header/composer', () => {
    expect(chatPaneSource).toContain("? 'grid-rows-[minmax(0,1fr)]'");
    expect(chatPaneSource).toContain(": 'grid-rows-[auto_minmax(0,1fr)_auto]'");
  });
});

describe('terminal resume sync wiring', () => {
  it('buffers live chunks during a sync replay instead of dropping them', () => {
    expect(registrySource).toContain('session.pendingSyncChunks.push({ chunk, seq });');
    expect(registrySource).toMatch(/const pending = session\.pendingSyncChunks;/);
  });

  it('re-asserts this client\'s dims after a snapshot at foreign dims', () => {
    expect(registrySource).toMatch(
      /\(cols !== session\.lastPtyCols \|\| rows !== session\.lastPtyRows\)\s*\)\s*\{\s*resizeBoth\(streamId, session, session\.lastPtyCols, session\.lastPtyRows\);/
    );
  });

  it('verifies websocket liveness when the page returns to the foreground', () => {
    expect(apiSource).toContain('function ensureSocketAlive()');
    expect(apiSource).toMatch(/visibilitychange[\s\S]*?ensureSocketAlive\(\)/);
    expect(apiSource).toMatch(/'online'[\s\S]*?ensureSocketAlive\(\)/);
    expect(apiSource).toContain("wsSend({ type: 'pty:requestSync', streamId });");
  });
});
