import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// WS-B — the NavRail hover-expands to a labelled panel and can be pinned open.
// Source-assertion style, matching the rest of the component suite (the node
// test env renders no DOM).
const here = dirname(fileURLToPath(import.meta.url));
const rail = readFileSync(resolve(here, 'NavRail.tsx'), 'utf8');
const shell = readFileSync(resolve(here, 'DesktopShell.tsx'), 'utf8');

describe('NavRail hover-expand + pin', () => {
  it('reads pinned state and the width constants from the registry', () => {
    expect(rail).toContain("from '../runtime/nav-rail-registry'");
    expect(rail).toContain('useNavRailPinned');
    expect(rail).toContain('toggleNavRailPinned');
    expect(rail).toContain('NAV_RAIL_COLLAPSED_WIDTH');
    expect(rail).toContain('NAV_RAIL_EXPANDED_WIDTH');
  });

  it('expands on hover intent with an enter/leave delay', () => {
    expect(rail).toContain('const HOVER_IN_MS = 200');
    expect(rail).toContain('const HOVER_OUT_MS = 150');
    expect(rail).toContain('onMouseEnter={onEnter}');
    expect(rail).toContain('onMouseLeave={onLeave}');
    // enter is gated on not-pinned; hover is ephemeral local state only.
    expect(rail).toMatch(/const onEnter[\s\S]*?if \(pinned\) return;/);
    expect(rail).toContain('const [hovered, setHovered] = useState(false)');
  });

  it('overlays without layout shift when unpinned, takes width when pinned', () => {
    // outer slot width follows the pinned flag; hover never widens the slot.
    expect(rail).toContain('width: pinned ? NAV_RAIL_EXPANDED_WIDTH : NAV_RAIL_COLLAPSED_WIDTH');
    // overlay = hovered && !pinned, raised above sibling panels via inline z.
    expect(rail).toContain('const overlay = hovered && !pinned');
    expect(rail).toContain('overlay ? { zIndex: 40 } : null');
    // expanded body is w-52 (208px) vs the w-14 (56px) icon rail.
    expect(rail).toContain("expanded ? 'w-52 px-2' : 'w-14 items-center'");
  });

  it('animates the width but honours reduced motion', () => {
    expect(rail).toContain('transition-[width]');
    expect(rail).toContain('motion-reduce:transition-none');
  });

  it('suppresses the per-button tooltip once labels are visible', () => {
    // RailButton / PinToggle return the bare button (no Tooltip) when expanded.
    expect(rail).toMatch(/if \(expanded\) return button;/);
  });

  it('exposes a persisted pin toggle in the footer', () => {
    expect(rail).toContain('onClick={toggleNavRailPinned}');
    expect(rail).toContain('aria-pressed={pinned}');
    expect(rail).toContain('<PinToggle pinned={pinned} expanded={expanded} />');
  });

  it('keeps the brand mark at the top and adds the wordmark only when expanded', () => {
    expect(rail).toContain('<AceMark size={26} shimmer />');
    expect(rail).toMatch(/expanded[\s\S]*?>ACE CODER<\/span>/);
  });
});

describe('DesktopShell rail-width clamp', () => {
  it('measures the left panel clamp from the live rail width', () => {
    expect(shell).toContain("from '../runtime/nav-rail-registry'");
    expect(shell).toContain('const railPinned = useNavRailPinned()');
    expect(shell).toContain('railPinned ? NAV_RAIL_EXPANDED_WIDTH : NAV_RAIL_COLLAPSED_WIDTH');
    expect(shell).toContain('e.clientX - railWidthRef.current');
    // the stale fixed constant is gone.
    expect(shell).not.toContain('const RAIL_WIDTH = 56');
  });
});
