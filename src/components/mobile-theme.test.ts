import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Indigo Ledger — the mobile-native theme + gesture upgrades. Source-assertion
// style, matching the rest of the mobile suite (the repo runs vitest under node,
// no jsdom). These lock in the theme's defining moves so a future refactor can't
// quietly regress them — especially the mobile-only scoping (desktop untouched).
const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(resolve(here, p), 'utf8');
const indexCss = read('../index.css');
const indexHtml = read('../../index.html');
const atom = (n: string) => read(`ui/mobile/atoms/${n}.tsx`);
const shell = read('MobileShell.tsx');
const task = read('ParallelTaskScreen.tsx');
const today = read('TodayDashboard.tsx');
const aceMark = read('ui/AceMark.tsx');

describe('Indigo Ledger — theme is mobile-scoped (desktop untouched)', () => {
  it('gates the token block, the ground and every .mobile-* override under :root.ace-touch', () => {
    expect(indexCss).toMatch(/:root\.ace-touch\s*\{[\s\S]*--m-bg:/);
    expect(indexCss).toContain(':root.ace-touch body');
    expect(indexCss).toContain(':root.ace-touch .mobile-glass-card');
    expect(indexCss).toContain(':root.ace-touch .mobile-nav-pill');
    expect(indexCss).toContain(':root.ace-touch .mobile-drawer-surface');
  });

  it('defines the cool-ground + single-indigo-accent token system', () => {
    for (const t of [
      '--m-bg:', '--m-text:', '--m-text-secondary:', '--m-accent:', '--m-hairline:',
      '--m-font-sans:', '--m-font-mono:', '--m-accent-quiet:', '--m-sheet-shadow:', '--m-radial-breath:',
    ]) {
      expect(indexCss).toContain(t);
    }
    // Electric indigo (hue 233, the Indigo Spade turned up), not the retired
    // warm amber, is the accent/busy signal.
    expect(indexCss).toMatch(/--m-accent:\s*hsl\(233/);
    expect(indexCss).toContain('--m-status-busy: 233');
  });

  it('loads Inter as the deterministic chrome face, Inter-first in the stack', () => {
    expect(indexHtml).toContain('family=Inter');
    expect(indexCss).toMatch(/--m-font-sans:\s*'Inter'/);
  });

  it('forces tabular mono on agent-data runs (build-log alignment)', () => {
    expect(indexCss).toContain('.mono-data');
    expect(indexCss).toContain('tabular-nums');
    expect(indexCss).toContain("'tnum'");
  });

  it('honors reduced-motion (no un-gated infinite animation)', () => {
    expect(indexCss).toContain('prefers-reduced-motion: reduce');
    expect(indexCss).toContain('@keyframes m-breathe');
  });
});

describe('Indigo Ledger — floating glass chrome', () => {
  it('defines the tint-reactive glass tokens for the floating bars', () => {
    for (const t of ['--m-glass-bg:', '--m-glass-border:', '--m-glass-edge:', '--m-glass-shadow:']) {
      expect(indexCss).toContain(t);
    }
    // Glass follows the user tint so the appearance sheet re-colors it live.
    expect(indexCss).toMatch(/--m-glass-bg:[\s\S]*?var\(--glass-tint-h, 233\)/);
  });

  it('the bottom nav is a floating blurred capsule with a shimmer sweep', () => {
    const navRule = indexCss.slice(indexCss.indexOf(':root.ace-touch .mobile-nav-pill'));
    expect(navRule).toContain('backdrop-filter: blur(');
    expect(navRule).toContain('border-radius: 9999px');
    expect(indexCss).toContain('@keyframes m-glass-shimmer');
    // Shimmer must degrade under reduced-motion.
    expect(indexCss).toMatch(
      /prefers-reduced-motion: reduce[\s\S]*?\.mobile-nav-pill::before\s*\{\s*animation:\s*none/
    );
  });

  it('the shell mounts the nav as a detached dock, not an edge-to-edge slab', () => {
    expect(shell).toMatch(/<div className="shrink-0 px-5 pb-2\.5 pt-1\.5">\s*<nav className="mobile-nav-pill/);
    expect(shell).toContain('max-w-[368px]');
  });

  it('smart-bar chips and the armed send are re-skinned on touch only', () => {
    expect(indexCss).toContain(':root.ace-touch .ace-pill');
    expect(indexCss).toContain(':root.ace-touch .ace-pill-accent');
    expect(indexCss).toMatch(
      /:root\.ace-touch \.ace-composer-send:not\(:disabled\)\s*\{[\s\S]*?var\(--m-accent-fill\)/
    );
  });
});

describe('Indigo Ledger — the blue mark', () => {
  it('AceMark renders the Indigo Spade ramp, not the retired amber caret', () => {
    expect(aceMark).toContain('#6673E4');
    expect(aceMark).toContain('#C3CCF8');
    expect(aceMark).toContain('viewBox="0 0 512 512"');
    expect(aceMark).not.toContain('#FBB254');
    expect(aceMark).not.toContain('#EF8A1C');
  });

  it('keeps the sheen shimmer clipped to the mark geometry', () => {
    expect(aceMark).toContain('ace-sheen-band');
    expect(indexCss).toContain('@keyframes ace-sheen');
  });
});

describe('Indigo Ledger — appearance from the smart bar', () => {
  const appearancePill = read('ace-chat/composers/AppearancePill.tsx');
  const appearanceSheet = read('mobile-composer/MobileAppearanceSheet.tsx');
  const plusSheet = read('mobile-composer/PlusSheet.tsx');
  const accentRegistry = read('../runtime/mobile-accent-registry.ts');

  it('every composer smart bar carries the appearance entry point', () => {
    for (const composer of [
      'ace-chat/composers/ClaudeComposer.tsx',
      'ace-chat/composers/CodexComposer.tsx',
      'ace-chat/composers/GeminiComposer.tsx',
      'ace-chat/MobileChatComposer.tsx',
    ]) {
      expect(read(composer), composer).toContain('<AppearancePill />');
    }
    // Mobile-only: the pill self-hides on desktop.
    expect(appearancePill).toContain('useIsMobileViewport');
    expect(appearancePill).toMatch(/if \(!isMobile\) return null/);
  });

  it('the terminal composer reaches appearance through the + sheet', () => {
    expect(plusSheet).toContain('onOpenAppearance');
    const taskComposer = read('MobileTaskComposer.tsx');
    expect(taskComposer).toContain('MobileAppearanceSheet');
    expect(taskComposer).toContain("setSheet('appearance')");
  });

  it('the sheet swaps accents through the registry and keeps tint control', () => {
    expect(appearanceSheet).toContain('setMobileAccent');
    expect(appearanceSheet).toContain('TintControls');
    expect(appearanceSheet).toContain("haptic('success')");
    // Registry writes the full var set and is touch-gated.
    expect(accentRegistry).toContain("'--m-accent'");
    expect(accentRegistry).toContain("'--m-status-busy'");
    expect(accentRegistry).toContain('isTouchClient()');
  });
});

describe('Indigo Ledger — restyled atoms', () => {
  it('SectionLabel is a sentence-case editorial eyebrow with an optional mono count-chip', () => {
    const s = atom('SectionLabel');
    expect(s).not.toContain('uppercase');
    expect(s).not.toContain('foreground/45');
    expect(s).toContain('mono-data');
    expect(s).toContain('padStart(2');
  });
  it('MobileEmptyState is a recessed shelf, not a dashed box', () => {
    const s = atom('MobileEmptyState');
    expect(s).not.toContain('border-dashed');
    expect(s).toContain('var(--m-bg-sunken)');
  });
  it('NavTab is a bare glyph with ONE indicator — the fixed-size gliding accent disc', () => {
    const s = atom('NavTab');
    expect(s).toContain('layoutId="mobile-tab-pill"');
    expect(s).not.toContain('mobile-tab-pill absolute inset-0'); // old filled-pill usage gone
    expect(s).toContain('bg-[var(--m-accent)]'); // SOLID disc, not a tonal smudge
    expect(s).toContain('text-[var(--m-accent-ink)]'); // glyph knocked out in ink
    expect(s).toMatch(/h-10 w-10/); // fixed-size — never a stretched capsule
    // Icon-only: no painted label (the old 10.5px caption is gone), no
    // secondary pip; the name lives in aria-label + the header title.
    expect(s).not.toContain('text-[10.5px]');
    expect(s).toContain('aria-label={label}');
  });
  it('StatusDot busy is the one loud breathing-accent signal; idle is a hollow ring', () => {
    const s = atom('StatusDot');
    expect(s).toContain('m-busy-dot');
    expect(s).toContain('hsl(var(--m-status-busy))');
    expect(s).toContain('bg-transparent'); // idle hollow ring
  });
  it('IconWell gains an accent tone for the single primary action', () => {
    const s = atom('IconWell');
    expect(s).toContain('accent:');
    expect(s).toContain('var(--m-accent-quiet)');
  });
  it('GestureDots renders count dots with a layoutId accent capsule on the active index', () => {
    const s = atom('GestureDots');
    expect(s).toContain('layoutId');
    expect(s).toContain('count');
    expect(s).toMatch(/i === index/);
    expect(s).toContain('bg-[var(--m-accent)]');
  });
});

describe('Indigo Ledger — Today IA', () => {
  it('drops the 2x2 launchpad for a display greeting + Todo intake', () => {
    expect(today).not.toContain('grid-cols-2');
    expect(today).not.toContain('New task');
    expect(today).toContain('TodayTodos'); // minimal Today todo surface (not the dense Operations panel)
    expect(today).toMatch(/fontWeight:\s*680/); // 30px display greeting
  });
});

describe('Indigo Ledger — gesture model', () => {
  it('drives section + edge-back swipes with follow-finger progress + accent seam', () => {
    expect(shell).toContain('onProgress');
    expect(shell).toContain('onPagerProgress');
    expect(shell).toContain('m-pager-track');
    expect(shell).toContain('m-swipe-seam');
  });
  it('swipe-LEFT dismisses a tab-less back screen — the owner ask', () => {
    expect(shell).toContain('backSwipeEnabled');
    expect(shell).toMatch(/backSwipeEnabled\)\s*backDismiss\(\)/);
  });
  it('renders the always-on section dot-rail', () => {
    expect(shell).toContain('GestureDots');
    expect(shell).toContain('layoutId="m-section-dots"');
  });
  it('pages task tabs on the pane body and keeps the default isSwipeBlocked guard', () => {
    expect(task).toContain('taskTabSwipeRef');
    expect(task).toContain('useSwipe');
    expect(task).not.toContain('blockWhen'); // default guard kept → terminals/Monaco/webviews win
    expect(task).toContain('selectTab(task.id, focusedPane.id');
    expect(task).toContain('clamp at the ends, no wrap');
  });
});
