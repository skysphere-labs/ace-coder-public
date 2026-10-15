// The one Hermes Desktop embed in the ACE renderer. Mounted above the shell
// swap; collapsed/popup/full change host layout only, never the pane.
// See docs/architecture/resident-operator-surface.md.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type Ref,
} from 'react';
import { Minus, Maximize2, Minimize2, TriangleAlert, Loader2 } from 'lucide-react';
import { useApp } from '../../store';
import { DEFAULT_OPERATORS, getOperator, listControlPlaneOperators } from '../../lib/operators';
import { useOperators } from '../../runtime/operators-registry';
import { useIsMobileViewport } from '../../runtime/use-mobile-viewport';
import {
  resolveResidentMode,
  setResidentOperatorMode,
  useResidentAnchor,
  useResidentOperatorMode,
} from '../../runtime/resident-operator-registry';
import { HermesDesktopAppPane, type HermesFramePhase } from './HermesDesktopAppPane';

const POPUP_WIDTH = 460;
const POPUP_HEIGHT = 660;
const GUTTER = 16;
// Clears the Ledger strip (h-6) plus the stage's pb-2.
const DESKTOP_BOTTOM = 'calc(2.25rem + env(safe-area-inset-bottom))';
// Clears the floating mobile dock and its wrapper padding.
const MOBILE_BOTTOM = 'calc(5.25rem + env(safe-area-inset-bottom))';
const RIGHT = `calc(${GUTTER}px + env(safe-area-inset-right))`;

// Neutral fallback identity: read from the shipped default, never a literal.
const NEUTRAL = DEFAULT_OPERATORS.operators[0];

type Rect = { top: number; left: number; width: number; height: number };

export function ResidentOperatorSurface() {
  const { showDiffViewer } = useApp();
  const storedMode = useResidentOperatorMode();
  const anchor = useResidentAnchor();
  const operators = useOperators();
  const compact = useIsMobileViewport();
  const [phase, setPhase] = useState<HermesFramePhase>('starting');
  const [anchorRect, setAnchorRect] = useState<Rect | null>(null);
  const launcherRef = useRef<HTMLButtonElement | null>(null);
  const headerControlRef = useRef<HTMLButtonElement | null>(null);
  // Focus follows the affordance the user just activated.
  const pendingFocusRef = useRef<'host' | 'launcher' | null>(null);

  const mode = resolveResidentMode({ mode: storedMode, showDiffViewer });

  // Full mode copies the mounted shell's content rect.
  useEffect(() => {
    if (!anchor) return;
    const measure = () => {
      const r = anchor.getBoundingClientRect();
      setAnchorRect((prev) =>
        prev && prev.top === r.top && prev.left === r.left && prev.width === r.width && prev.height === r.height
          ? prev
          : { top: r.top, left: r.left, width: r.width, height: r.height }
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(anchor);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [anchor]);

  useEffect(() => {
    const target = pendingFocusRef.current;
    if (!target) return;
    pendingFocusRef.current = null;
    if (target === 'host') headerControlRef.current?.focus();
    else launcherRef.current?.focus();
  }, [mode]);

  const operator = useMemo(
    () => getOperator(operators, operators.defaultOperatorId) ?? listControlPlaneOperators(operators)[0] ?? null,
    [operators]
  );
  const label = operator?.label ?? NEUTRAL.label;
  const glyph = operator?.emoji ?? NEUTRAL.emoji;

  // Presentation is host state, not navigation: nothing here touches the router.
  const go = useCallback((next: 'collapsed' | 'popup' | 'full') => {
    pendingFocusRef.current = next === 'collapsed' ? 'launcher' : 'host';
    setResidentOperatorMode(next);
  }, []);

  const openPopup = useCallback(() => go('popup'), [go]);
  const minimize = useCallback(() => go('collapsed'), [go]);
  const expand = useCallback(() => go('full'), [go]);
  const restoreFromFull = useCallback(() => go('popup'), [go]);

  // Host-scoped, not window: webview keystrokes are another renderer process,
  // so an active Hermes composer keeps its own Escape.
  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key !== 'Escape' || mode === 'collapsed') return;
      event.stopPropagation();
      // Escape steps down one level rather than dumping full canvas straight
      // to the launcher.
      go(mode === 'full' ? 'popup' : 'collapsed');
    },
    [go, mode]
  );

  const hostStyle: CSSProperties = useMemo(() => {
    if (mode === 'full' && anchorRect) {
      return {
        position: 'fixed',
        top: anchorRect.top,
        left: anchorRect.left,
        width: anchorRect.width,
        height: anchorRect.height,
      };
    }
    const inset = `(${GUTTER * 2}px + env(safe-area-inset-left) + env(safe-area-inset-right))`;
    return {
      position: 'fixed',
      right: RIGHT,
      bottom: compact ? MOBILE_BOTTOM : DESKTOP_BOTTOM,
      width: compact ? `calc(100vw - ${inset})` : `min(${POPUP_WIDTH}px, calc(100vw - ${inset}))`,
      height: compact ? `min(${POPUP_HEIGHT}px, calc(100dvh - 7.5rem))` : `min(${POPUP_HEIGHT}px, calc(100dvh - 6rem))`,
      // Hidden, not unmounted: display:none would zero the host box, and with it
      // the webview, and fire the pane's ResizeObserver effects at width 0.
      ...(mode === 'collapsed' ? { visibility: 'hidden' as const, pointerEvents: 'none' as const } : null),
    };
  }, [anchorRect, compact, mode]);

  return (
    <>
      {mode === 'collapsed' && (
        <OperatorLauncher ref={launcherRef} label={label} glyph={glyph} phase={phase} compact={compact} onOpen={openPopup} />
      )}

      <div
        data-resident-operator-host
        data-mode={mode}
        onKeyDown={onKeyDown}
        aria-hidden={mode === 'collapsed' ? true : undefined}
        style={{ ...hostStyle, zIndex: 70 }}
        className={
          mode === 'full'
            ? 'flex flex-col overflow-hidden'
            : 'flex flex-col overflow-hidden rounded-xl border border-white/[0.08] bg-[hsl(var(--ace-surface))] shadow-raise-lg'
        }
      >
        <HostHeader
          controlRef={headerControlRef}
          label={label}
          glyph={glyph}
          phase={phase}
          mode={mode}
          onMinimize={minimize}
          onExpand={expand}
          onRestore={restoreFromFull}
        />
        <div className="relative min-h-0 flex-1 overflow-hidden">
          <HermesDesktopAppPane onPhaseChange={setPhase} />
        </div>
      </div>
    </>
  );
}

function phaseCopy(phase: HermesFramePhase): { text: string; Icon: typeof Loader2 | null } {
  if (phase === 'starting') return { text: 'Starting', Icon: Loader2 };
  if (phase === 'error') return { text: 'Needs attention', Icon: TriangleAlert };
  return { text: 'Ready', Icon: null };
}

function OperatorLauncher({
  ref,
  label,
  glyph,
  phase,
  compact,
  onOpen,
}: {
  ref: Ref<HTMLButtonElement>;
  label: string;
  glyph: string;
  phase: HermesFramePhase;
  compact: boolean;
  onOpen: () => void;
}) {
  const { text, Icon } = phaseCopy(phase);
  return (
    <button
      ref={ref}
      type="button"
      data-resident-operator-launcher
      onClick={onOpen}
      aria-label={`Open ${label} — ${text}`}
      aria-expanded={false}
      title={`${label} — ${text}`}
      style={{ position: 'fixed', right: RIGHT, bottom: compact ? MOBILE_BOTTOM : DESKTOP_BOTTOM, zIndex: 71 }}
      className="flex h-11 items-center gap-2 rounded-full border border-white/[0.10] bg-[hsl(var(--ace-surface-2))] pl-3 pr-4 text-[13px] font-medium text-foreground/85 shadow-raise-lg outline-none motion-safe:transition-colors hover:bg-[hsl(var(--ace-overlay))] focus-visible:ring-2 focus-visible:ring-[hsl(var(--ace-accent))]"
    >
      <span aria-hidden className="text-[17px] leading-none">
        {glyph}
      </span>
      <span className="truncate">{label}</span>
      {/* Icon + text, never color alone. */}
      {Icon && (
        <Icon
          aria-hidden
          className={
            phase === 'starting'
              ? 'h-3.5 w-3.5 shrink-0 text-foreground/50 motion-safe:animate-spin'
              : 'h-3.5 w-3.5 shrink-0 text-rose-300/90'
          }
        />
      )}
      <span className="sr-only">{text}</span>
    </button>
  );
}

// Host chrome only — Hermes owns its own navigation.
function HostHeader({
  controlRef,
  label,
  glyph,
  phase,
  mode,
  onMinimize,
  onExpand,
  onRestore,
}: {
  controlRef: Ref<HTMLButtonElement>;
  label: string;
  glyph: string;
  phase: HermesFramePhase;
  mode: ResidentOperatorModeType;
  onMinimize: () => void;
  onExpand: () => void;
  onRestore: () => void;
}) {
  const { text, Icon } = phaseCopy(phase);
  return (
    <div className="flex h-9 shrink-0 items-center gap-2 border-b border-white/[0.06] bg-[hsl(var(--ace-surface))] px-2.5">
      <span aria-hidden className="text-[15px] leading-none">
        {glyph}
      </span>
      <span className="truncate text-[13px] font-medium text-foreground/85">{label}</span>
      <span className="flex items-center gap-1 text-[11px] text-foreground/45">
        {Icon && (
          <Icon
            aria-hidden
            className={phase === 'starting' ? 'h-3 w-3 shrink-0 motion-safe:animate-spin' : 'h-3 w-3 shrink-0 text-rose-300/90'}
          />
        )}
        {text}
      </span>
      <div className="ml-auto flex items-center gap-0.5">
        {mode === 'full' ? (
          <HostControl ref={controlRef} label={`Restore ${label} to popup`} onClick={onRestore}>
            <Minimize2 className="h-3.5 w-3.5" />
          </HostControl>
        ) : (
          <HostControl ref={controlRef} label={`Expand ${label} to full canvas`} onClick={onExpand}>
            <Maximize2 className="h-3.5 w-3.5" />
          </HostControl>
        )}
        <HostControl label={`Minimize ${label}`} onClick={onMinimize}>
          <Minus className="h-3.5 w-3.5" />
        </HostControl>
      </div>
    </div>
  );
}

type ResidentOperatorModeType = ReturnType<typeof resolveResidentMode>;

function HostControl({
  ref,
  label,
  onClick,
  children,
}: {
  ref?: Ref<HTMLButtonElement>;
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="flex h-7 w-7 items-center justify-center rounded-md text-foreground/55 outline-none motion-safe:transition-colors hover:bg-white/10 hover:text-foreground/90 focus-visible:ring-2 focus-visible:ring-[hsl(var(--ace-accent))]"
    >
      {children}
    </button>
  );
}
