import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Mobile touch polish — Ember Spade icons + phone usability pass. Source-
// assertion style, matching the rest of the mobile suite (vitest under node,
// no jsdom). Locks the touch-scroll physics, 44px tap targets, haptic wiring
// and the PWA icon set so refactors can't quietly regress the phone client.
const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(resolve(here, p), 'utf8');
const transcript = read('ace-chat/TranscriptList.tsx');
const taskComposer = read('MobileTaskComposer.tsx');
const chatComposer = read('ace-chat/MobileChatComposer.tsx');
const shell = read('MobileShell.tsx');
const task = read('ParallelTaskScreen.tsx');
const terminalRegistry = read('../runtime/terminal-registry.ts');
const haptics = read('../runtime/haptics.ts');
const viteConfig = read('../../vite.config.ts');
const indexHtml = read('../../index.html');

describe('chat transcript — native touch scrolling', () => {
  it('keeps vertical scrolling browser-native and contains overscroll', () => {
    expect(transcript).toContain('[-webkit-overflow-scrolling:touch]');
    expect(transcript).toContain('[overscroll-behavior-y:contain]');
    expect(transcript).toContain('[touch-action:pan-y]');
  });

  it('uses a momentum-tolerant bottom-stick threshold', () => {
    expect(transcript).toMatch(/scrollHeight - el\.scrollTop - el\.clientHeight < 80/);
  });
});

describe('composers — 44px tap targets', () => {
  it('MobileTaskComposer buttons are 44px (h-11 w-11), none left at 40px', () => {
    expect(taskComposer).not.toContain('h-10 w-10');
    expect(taskComposer.match(/h-11 w-11/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });

  it('MobileTaskComposer textarea is comfortably tappable', () => {
    expect(taskComposer).toContain('min-h-[40px]');
    expect(taskComposer).not.toContain('min-h-[28px]');
  });

  it('MobileChatComposer attach button is 44px', () => {
    expect(chatComposer).toContain('h-11 w-11');
    expect(chatComposer).not.toContain('h-9 w-9');
  });

  it('MobileTaskComposer re-autosizes when the soft keyboard opens', () => {
    expect(taskComposer).toContain('useMobileKeyboardInset');
    expect(taskComposer).toMatch(/useEffect\(autosize, \[keyboardInset, autosize\]\)/);
  });
});

describe('haptics — Android tick, iOS no-op', () => {
  it('haptics util guards on navigator.vibrate and never throws', () => {
    expect(haptics).toContain("typeof vibrate !== 'function'");
    expect(haptics).toMatch(/catch\s*\{\s*return false;?\s*\}/);
  });

  it('is wired to nav taps, back gestures, tab paging and terminal send', () => {
    expect(shell).toContain("import { haptic } from '../runtime/haptics'");
    expect(shell.match(/haptic\('tick'\)/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(task).toContain("haptic('tick')");
    expect(taskComposer).toContain("haptic('tick')");
  });
});

describe('terminal touch scroll — flick velocity clamp', () => {
  it('clamps computed velocity to MAX_VELOCITY', () => {
    expect(terminalRegistry).toContain('MAX_VELOCITY');
    expect(terminalRegistry).toMatch(/Math\.max\(-MAX_VELOCITY, Math\.min\(MAX_VELOCITY/);
  });
});

describe('terminal smoothness — mobile fast path', () => {
  it('skips per-cell alpha blending everywhere (solid backgrounds on every client)', () => {
    // Desktop glass moved to an opaque charcoal terminal surface, so no
    // client pays for per-cell alpha blending anymore — touch/remote
    // included.
    expect(terminalRegistry).toContain('allowTransparency: false');
    expect(terminalRegistry).not.toContain('allowTransparency: true');
  });

  it('re-arms WebGL quickly on phones and on visibility restore after context loss', () => {
    expect(terminalRegistry).toMatch(/isTouchOrRemoteClient\(\) \? 5000 : 30000/);
    expect(terminalRegistry).toContain("addEventListener('visibilitychange'");
  });

  it('quantizes the fitted width so viewport jitter cannot thrash the glyph atlas', () => {
    expect(terminalRegistry).toContain('Math.floor(containerWidth / 8) * 8');
  });
});

describe('PWA — Ember Spade icon set', () => {
  it('manifest declares the ember icons with maskable variants and graphite theme', () => {
    expect(viteConfig).toContain("theme_color: '#17181C'");
    expect(viteConfig).toContain("{ src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' }");
    expect(viteConfig).toContain("{ src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }");
  });

  it('icon files exist in public/', () => {
    for (const name of [
      'favicon.png',
      'apple-touch-icon.png',
      'icon-192.png',
      'icon-512.png',
      'icon-maskable-192.png',
      'icon-maskable-512.png',
    ]) {
      expect(existsSync(resolve(here, '../../public', name)), name).toBe(true);
    }
  });

  it('index.html theme-color matches the graphite ground', () => {
    expect(indexHtml).toContain('<meta name="theme-color" content="#17181C" />');
  });
});
