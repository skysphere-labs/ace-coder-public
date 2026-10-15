import { useEffect, useRef, useState } from 'react';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import {
  Settings, Plus, Loader2, LogOut, RefreshCw, PanelLeftClose, PanelLeftOpen,
} from 'lucide-react';
import { cn } from '../lib/utils';
import { useApp } from '../store';
import { NAV_ITEMS } from './navigation-items';
import { AceMark } from './ui/AceMark';
import { GithubGlyph } from './ui/github-glyph';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import { TintPicker } from './TintPicker';
import {
  NAV_RAIL_COLLAPSED_WIDTH,
  NAV_RAIL_EXPANDED_WIDTH,
  toggleNavRailPinned,
  useNavRailPinned,
} from '../runtime/nav-rail-registry';
import {
  refreshAccounts as refreshGithubAccounts,
  signOutAccount as signOutGithubAccount,
  switchActiveAccount,
  useGithubState,
} from '../runtime/github-registry';

// Shared expanded-row shell so every item (brand, nav, footer) aligns its icon
// column and label identically.
const EXPANDED_ROW =
  'group relative flex h-10 w-full items-center gap-3 rounded-lg px-2.5 text-left transition-colors';
const ICON_SLOT = 'flex w-7 shrink-0 items-center justify-center';
const HOVER_IN_MS = 200;
const HOVER_OUT_MS = 150;

// The slim 56px icon Rail — the "Command Deck" section switcher. It is the one
// piece of chrome that is ALWAYS present (the Workspace Panel collapses
// independently); switching global sections never depends on the tree being
// open. Top: the shimmering brand mark (also the Home affordance). Middle: the
// shared NAV_ITEMS glyphs. Bottom cluster: Settings (with the update dot),
// TintPicker, the GitHub account switcher, and the pin toggle.
//
// Hovering the rail (with a short intent delay) expands it to a labelled panel;
// when unpinned this is an OVERLAY that takes no layout width, when pinned the
// rail stays expanded and takes real layout width (see DesktopShell's clamp).
export function NavRail() {
  const { view, setView } = useApp();
  const navItems = NAV_ITEMS;
  const pinned = useNavRailPinned();
  const [hovered, setHovered] = useState(false);
  const enterTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const expanded = pinned || hovered;
  const overlay = hovered && !pinned;

  useEffect(
    () => () => {
      if (enterTimer.current) clearTimeout(enterTimer.current);
      if (leaveTimer.current) clearTimeout(leaveTimer.current);
    },
    []
  );

  const onEnter = () => {
    if (pinned) return;
    if (leaveTimer.current) { clearTimeout(leaveTimer.current); leaveTimer.current = null; }
    if (hovered || enterTimer.current) return;
    enterTimer.current = setTimeout(() => { enterTimer.current = null; setHovered(true); }, HOVER_IN_MS);
  };
  const onLeave = () => {
    if (enterTimer.current) { clearTimeout(enterTimer.current); enterTimer.current = null; }
    if (!hovered || leaveTimer.current) return;
    leaveTimer.current = setTimeout(() => { leaveTimer.current = null; setHovered(false); }, HOVER_OUT_MS);
  };

  return (
    <div
      className="relative shrink-0"
      style={{
        width: pinned ? NAV_RAIL_EXPANDED_WIDTH : NAV_RAIL_COLLAPSED_WIDTH,
        // Raise above the sibling panels only while overlaying — the shell forces
        // every .shell-stage child to z-index:1, so an inline value is required.
        ...(overlay ? { zIndex: 40 } : null),
      }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      <nav
        aria-label="Sections"
        className={cn(
          'absolute inset-y-0 left-0 flex flex-col gap-1 overflow-hidden py-2 transition-[width] duration-150 ease-out motion-reduce:transition-none',
          expanded ? 'w-52 px-2' : 'w-14 items-center',
          expanded && 'rounded-2xl border border-white/[0.05] bg-[hsl(var(--ace-surface)/0.92)] backdrop-blur-2xl',
          overlay && 'shadow-raise-lg'
        )}
      >
        {/* Brand anchor + Home affordance — the one shimmering mark on the Rail. */}
        {expanded ? (
          <button
            type="button"
            onClick={() => setView('home')}
            aria-label="Home"
            aria-current={view === 'home' ? 'page' : undefined}
            className={cn(
              EXPANDED_ROW,
              'hover:bg-[hsl(var(--ace-surface-2))] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
              view === 'home' && 'bg-white/[0.06]'
            )}
          >
            <span className={ICON_SLOT}><AceMark size={26} shimmer /></span>
            <span className="min-w-0 flex-1 truncate text-sm font-semibold tracking-tight text-foreground">ACE CODER</span>
          </button>
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => setView('home')}
                aria-label="Home"
                aria-current={view === 'home' ? 'page' : undefined}
                className={cn(
                  'flex h-10 w-10 items-center justify-center rounded-lg transition-colors hover:bg-[hsl(var(--ace-surface-2))] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                  view === 'home' && 'bg-white/[0.06]'
                )}
              >
                <AceMark size={26} shimmer />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">Home</TooltipContent>
          </Tooltip>
        )}

        <div className={cn('my-1 h-px rounded-full bg-white/[0.06]', expanded ? 'mx-2.5 self-stretch' : 'w-6')} />

        <div className={cn('flex flex-col gap-1', !expanded && 'items-center')}>
          {navItems.map(({ id, icon, label }) => (
            <RailButton
              key={id}
              icon={icon}
              label={label}
              active={view === id}
              expanded={expanded}
              onClick={() => setView(id)}
            />
          ))}
        </div>

        <div className={cn('mt-auto flex flex-col gap-1 pt-2', !expanded && 'items-center')}>
          <div className={cn('mb-1 h-px rounded-full bg-white/[0.06]', expanded ? 'mx-2.5 self-stretch' : 'w-6')} />
          <RailButton
            icon={Settings}
            label="Settings"
            active={view === 'settings'}
            expanded={expanded}
            onClick={() => setView('settings')}
          />
          {expanded ? (
            <div className="flex h-10 items-center gap-3 rounded-lg px-2.5">
              <span className={ICON_SLOT}><TintPicker className="h-[18px] w-[18px] rounded-md" /></span>
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground/60">Appearance</span>
            </div>
          ) : (
            <TintPicker className="h-10 w-10 rounded-lg" />
          )}
          <GithubSidebarButton
            active={view === 'github-browser'}
            expanded={expanded}
            onOpenTab={() => setView('github-browser')}
          />
          <PinToggle pinned={pinned} expanded={expanded} />
        </div>
      </nav>
    </div>
  );
}

function RailButton({
  icon: Icon,
  label,
  active,
  onClick,
  expanded,
  badge,
}: {
  icon: typeof Settings;
  label: string;
  active: boolean;
  onClick: () => void;
  expanded: boolean;
  badge?: React.ReactNode;
}) {
  const glyph = (
    <Icon
      className={cn(
        'h-[18px] w-[18px] shrink-0',
        active ? 'text-[hsl(var(--ace-accent))]' : 'text-foreground/60 group-hover:text-foreground'
      )}
    />
  );
  const button = (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-current={active ? 'page' : undefined}
      className={cn(
        expanded
          ? EXPANDED_ROW
          : 'group relative flex h-10 w-10 items-center justify-center rounded-lg transition-colors',
        'text-foreground/60 hover:bg-[hsl(var(--ace-surface-2))] hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        active && 'sidebar-active-indicator bg-white/[0.06] text-foreground'
      )}
    >
      {expanded ? <span className={ICON_SLOT}>{glyph}</span> : glyph}
      {expanded && <span className="min-w-0 flex-1 truncate text-sm font-medium">{label}</span>}
      {badge}
    </button>
  );
  if (expanded) return button;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

// Pin/unpin the expanded rail. Pinned → rail keeps layout width; unpinned → slim
// icon rail with hover-overlay. State persists via nav-rail-registry.
function PinToggle({ pinned, expanded }: { pinned: boolean; expanded: boolean }) {
  const label = pinned ? 'Unpin sidebar' : 'Pin sidebar';
  const Icon = pinned ? PanelLeftClose : PanelLeftOpen;
  const glyph = <Icon className="h-[18px] w-[18px] shrink-0" />;
  const button = (
    <button
      type="button"
      onClick={toggleNavRailPinned}
      aria-label={label}
      aria-pressed={pinned}
      className={cn(
        expanded
          ? EXPANDED_ROW
          : 'group relative flex h-10 w-10 items-center justify-center rounded-lg transition-colors',
        'text-foreground/60 hover:bg-[hsl(var(--ace-surface-2))] hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'
      )}
    >
      {expanded ? <span className={ICON_SLOT}>{glyph}</span> : glyph}
      {expanded && <span className="min-w-0 flex-1 truncate text-sm font-medium">{label}</span>}
    </button>
  );
  if (expanded) return button;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

// GitHub account switcher — relocated from WorkspaceRail's footer to the Rail as
// an icon trigger (avatar or glyph). The popover contents + every handler
// (switch active, sign out, refresh, add) are preserved verbatim; only the
// trigger shape and the popover side changed for the vertical Rail.
function GithubSidebarButton({
  active,
  expanded,
  onOpenTab,
}: {
  active: boolean;
  expanded: boolean;
  onOpenTab: () => void;
}) {
  const state = useGithubState();
  const { setShowAddGithubAccountDialog } = useApp();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const activeAccount = state.accounts.find((a) => a.isActive) ?? state.accounts[0] ?? null;

  const handlePickAccount = async (login: string) => {
    const current = state.accounts.find((a) => a.isActive);
    if (current?.login !== login) {
      setBusy(login);
      try { await switchActiveAccount(login); }
      catch (e) { alert((e as Error).message); setBusy(null); return; }
      setBusy(null);
    }
    setOpen(false);
    onOpenTab();
  };

  const handleAdd = async () => {
    setOpen(false);
    setShowAddGithubAccountDialog(true);
  };

  const triggerButton = (
    <button
      type="button"
      aria-label={activeAccount ? `GitHub — ${activeAccount.login}` : 'GitHub'}
      className={cn(
        expanded
          ? EXPANDED_ROW
          : 'flex h-10 w-10 items-center justify-center rounded-lg transition-colors',
        'text-foreground/60 hover:bg-[hsl(var(--ace-surface-2))] hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        (active || open) && 'bg-white/[0.06] text-foreground'
      )}
    >
      {expanded ? (
        <>
          <span className={ICON_SLOT}>
            {activeAccount ? (
              <AccountAvatar url={activeAccount.avatarUrl} login={activeAccount.login} size={22} />
            ) : (
              <GithubGlyph className="h-[18px] w-[18px] shrink-0 text-foreground/60" />
            )}
          </span>
          <span className="min-w-0 flex-1 truncate text-sm font-medium">
            {activeAccount ? activeAccount.login : 'GitHub'}
          </span>
        </>
      ) : activeAccount ? (
        <AccountAvatar url={activeAccount.avatarUrl} login={activeAccount.login} size={24} />
      ) : (
        <GithubGlyph className="h-[18px] w-[18px] shrink-0 text-foreground/60" />
      )}
    </button>
  );

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      {expanded ? (
        <PopoverPrimitive.Trigger asChild>{triggerButton}</PopoverPrimitive.Trigger>
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverPrimitive.Trigger asChild>{triggerButton}</PopoverPrimitive.Trigger>
          </TooltipTrigger>
          <TooltipContent side="right">
            {activeAccount ? activeAccount.login : 'GitHub'}
          </TooltipContent>
        </Tooltip>
      )}
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          side="right"
          align="end"
          sideOffset={8}
          collisionPadding={16}
          className="glass-surface z-[120] w-80 overflow-hidden rounded-xl p-0 text-foreground animate-in fade-in-0 zoom-in-95"
        >
          <div className="flex items-center justify-between border-b border-white/[0.06] px-4 py-3">
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wider text-foreground/80">
                GitHub accounts
              </div>
              <div className="mt-0.5 text-[10px] text-muted-foreground">
                Signed in via gh CLI
              </div>
            </div>
            <button
              type="button"
              onClick={() => { void refreshGithubAccounts(); }}
              title="Refresh accounts"
              aria-label="Refresh accounts"
              className="rounded-md p-1.5 text-muted-foreground hover:bg-white/[0.05] hover:text-foreground"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="max-h-72 overflow-y-auto p-1.5">
            {state.accounts.map((acc) => {
              const isActive = acc.login === activeAccount?.login;
              return (
                <div key={acc.login} className="group flex items-center gap-1">
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => void handlePickAccount(acc.login)}
                    className={cn(
                      'flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm transition-colors',
                      isActive ? 'bg-white/[0.06]' : 'hover:bg-white/[0.04]',
                    )}
                  >
                    <AccountAvatar url={acc.avatarUrl} login={acc.login} size={24} />
                    <span className="min-w-0 flex-1 truncate font-medium">{acc.login}</span>
                    {isActive && (
                      <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-300">
                        Active
                      </span>
                    )}
                    {busy === acc.login && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
                  </button>
                  <button
                    type="button"
                    className="shrink-0 rounded-md p-1.5 text-muted-foreground opacity-0 transition-opacity hover:bg-rose-500/10 hover:text-rose-300 group-hover:opacity-100"
                    title={`Sign out ${acc.login}`}
                    aria-label={`Sign out ${acc.login}`}
                    onClick={async () => {
                      if (!confirm(`Sign ${acc.login} out of gh?`)) return;
                      try {
                        await signOutGithubAccount(acc.login);
                        if (isActive) setOpen(false);
                      } catch (e) { alert((e as Error).message); }
                    }}
                  >
                    <LogOut className="h-3.5 w-3.5" />
                  </button>
                </div>
              );
            })}
          </div>
          <div className="border-t border-white/[0.06] p-1.5">
            <button
              type="button"
              onClick={() => void handleAdd()}
              className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-white/[0.04] hover:text-foreground"
            >
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-dashed border-white/[0.18]">
                <Plus className="h-3.5 w-3.5" />
              </span>
              <span className="min-w-0 flex-1 truncate font-medium">Add account</span>
            </button>
          </div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

function AccountAvatar({ url, login, size }: { url: string | null; login: string; size: number }) {
  if (url) {
    return (
      <img
        src={url}
        alt={login}
        width={size}
        height={size}
        className="shrink-0 rounded-full"
        onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
      />
    );
  }
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-full bg-white/[0.1] text-[10px] font-semibold uppercase"
      style={{ width: size, height: size }}
    >
      {login.slice(0, 1)}
    </div>
  );
}
