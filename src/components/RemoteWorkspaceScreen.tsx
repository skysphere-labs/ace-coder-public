import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  ChevronRight,
  CornerUpLeft,
  Folder,
  FolderPlus,
  GitBranch,
  Home as HomeIcon,
  Server,
  ShieldCheck,
  X,
} from 'lucide-react';
import { cn } from '../lib/utils';
import { useApp } from '../store';
import { landingView } from '../runtime/use-mobile-viewport';
import { aceApi } from '../lib/ace-api';

type SshHost = {
  alias: string;
  host: string;
  user: string | null;
  port: number | null;
};

type DirListing = {
  path: string;
  home: string;
  parent: string | null;
  hasGit: boolean;
  entries: Array<{ name: string; kind: 'dir' }>;
};

const HELPER_USER = 'ace-agent';
const HELPER_HOME = `/home/${HELPER_USER}`;
const HELPER_WORKSPACES = `${HELPER_HOME}/workspaces`;

const CHOWN_DENYLIST = new Set([
  '/', '/etc', '/usr', '/var', '/srv', '/home', '/root', '/opt',
  '/bin', '/sbin', '/lib', '/lib64', '/proc', '/sys', '/dev',
  '/tmp', '/run', '/boot', '/mnt', '/media',
]);

type AgentUserMode = 'ace-agent' | 'root';

export function RemoteWorkspaceScreen() {
  const { setView, openWorkspace } = useApp();
  const [hosts, setHosts] = useState<SshHost[] | null>(null);
  const [hostError, setHostError] = useState<string | null>(null);
  const [manualHost, setManualHost] = useState('');
  const [activeHost, setActiveHost] = useState<string | null>(null);
  const [sshUser, setSshUser] = useState<string | null>(null);
  const [agentUserMode, setAgentUserMode] = useState<AgentUserMode>('root');
  const [listing, setListing] = useState<DirListing | null>(null);
  const [listingLoading, setListingLoading] = useState(false);
  const [listingError, setListingError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [chownConfirm, setChownConfirm] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    aceApi.workspaces
      .listRemoteHosts()
      .then((result) => {
        if (cancelled) return;
        setHosts(result.hosts);
      })
      .catch((err) => {
        if (cancelled) return;
        setHostError(err instanceof Error ? err.message : 'Failed to read ~/.ssh/config');
        setHosts([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const browse = useCallback(
    async (host: string, path: string | undefined, useAgentUser: boolean) => {
      setListingLoading(true);
      setListingError(null);
      try {
        const result = await aceApi.workspaces.listRemoteDir(
          host,
          path,
          useAgentUser ? HELPER_USER : null
        );
        setListing(result);
      } catch (err) {
        setListingError(err instanceof Error ? err.message : 'Failed to read directory');
      } finally {
        setListingLoading(false);
      }
    },
    []
  );

  const createFolder = useCallback(
    async (name: string): Promise<string | null> => {
      if (!activeHost || !listing) return 'No active folder to create inside.';
      const trimmed = name.trim();
      if (!trimmed) return 'Name is required.';
      if (/[/\0]/.test(trimmed)) return 'Folder names can\u2019t contain / or null.';
      const useAgentUser = agentUserMode === 'ace-agent';
      const target = listing.path.endsWith('/')
        ? `${listing.path}${trimmed}`
        : `${listing.path}/${trimmed}`;
      try {
        await aceApi.workspaces.createRemoteDir(
          activeHost,
          target,
          useAgentUser ? HELPER_USER : null
        );
        await browse(activeHost, listing.path, useAgentUser);
        return null;
      } catch (err) {
        return err instanceof Error ? err.message : 'Failed to create folder.';
      }
    },
    [activeHost, listing, agentUserMode, browse]
  );

  const effectiveAgentUser = agentUserMode === 'ace-agent' ? HELPER_USER : null;

  const willChownInPlace = useMemo(() => {
    if (!listing || agentUserMode !== 'ace-agent') return false;
    if (!listing.path) return false;
    if (listing.path === HELPER_HOME || listing.path.startsWith(`${HELPER_HOME}/`)) {
      return false;
    }
    return true;
  }, [listing, agentUserMode]);

  const chownBlocked = useMemo(() => {
    if (!willChownInPlace || !listing) return false;
    return CHOWN_DENYLIST.has(listing.path);
  }, [willChownInPlace, listing]);

  const connectToHost = async (host: string) => {
    const known = hosts?.find((h) => h.alias === host);
    const initialSshUser = known?.user ?? null;
    setSshUser(initialSshUser);
    const isRootConnection = initialSshUser === 'root';
    const initialMode: AgentUserMode = isRootConnection ? 'ace-agent' : 'root';
    setAgentUserMode(initialMode);
    setActiveHost(host);
    setListing(null);
    setConnectError(null);
    setListingLoading(true);

    const startPath = initialMode === 'ace-agent' ? HELPER_WORKSPACES : '/';
    await browse(host, startPath, initialMode === 'ace-agent');
  };

  const onChangeMode = async (next: AgentUserMode) => {
    if (!activeHost || next === agentUserMode) return;
    setAgentUserMode(next);
    const useAgent = next === 'ace-agent';
    const currentPath = listing?.path ?? '/';
    const targetPath =
      useAgent && !currentPath.startsWith(HELPER_HOME)
        ? HELPER_WORKSPACES
        : currentPath;
    await browse(activeHost, targetPath, useAgent);
  };

  const handleOpen = async () => {
    if (!activeHost || !listing) return;
    if (chownBlocked) {
      setConnectError(
        `Refusing to chown ${listing.path} — pick a subdirectory instead.`
      );
      return;
    }
    if (willChownInPlace) {
      setChownConfirm(listing.path);
      return;
    }
    await performImport(false);
  };

  const performImport = async (chownInPlace: boolean) => {
    if (!activeHost || !listing) return;
    setBusy(true);
    setConnectError(null);
    setChownConfirm(null);
    try {
      const result = await aceApi.workspaces.importRemoteWorkspace(
        activeHost,
        listing.path,
        {
          agentUser: effectiveAgentUser,
          chownInPlace,
        }
      );
      openWorkspace(result.id);
    } catch (err) {
      setConnectError(err instanceof Error ? err.message : 'Failed to open folder');
      setBusy(false);
    }
  };

  return (
    <div className="relative flex h-full flex-col overflow-y-auto">
      <button
        type="button"
        onClick={() => (activeHost ? setActiveHost(null) : setView(landingView()))}
        className="absolute left-6 top-6 z-10 flex h-8 items-center gap-1.5 rounded-lg px-2 text-xs text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        {activeHost ? 'Change host' : 'Back'}
      </button>

      <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-8 pb-16 pt-20">
        {!activeHost ? (
          <HostPicker
            hosts={hosts}
            hostError={hostError}
            manualHost={manualHost}
            onManualHostChange={setManualHost}
            onSelect={(host) => {
              setManualHost('');
              void connectToHost(host);
            }}
            onManualConnect={() => {
              if (manualHost.trim()) void connectToHost(manualHost.trim());
            }}
          />
        ) : (
          <FolderBrowser
            host={activeHost}
            sshUser={sshUser}
            agentUserMode={agentUserMode}
            onChangeMode={onChangeMode}
            listing={listing}
            loading={listingLoading}
            error={listingError}
            showHidden={showHidden}
            onToggleHidden={() => setShowHidden((v) => !v)}
            onNavigate={(path) =>
              browse(activeHost, path, agentUserMode === 'ace-agent')
            }
            onHome={() =>
              browse(
                activeHost,
                agentUserMode === 'ace-agent' ? HELPER_WORKSPACES : '~',
                agentUserMode === 'ace-agent'
              )
            }
            onOpen={handleOpen}
            onCreateFolder={createFolder}
            busy={busy}
            connectError={connectError}
            willChownInPlace={willChownInPlace}
            chownBlocked={chownBlocked}
          />
        )}
      </div>

      {chownConfirm && (
        <ChownConfirmDialog
          path={chownConfirm}
          onCancel={() => setChownConfirm(null)}
          onConfirm={() => performImport(true)}
        />
      )}
    </div>
  );
}

function HostPicker({
  hosts,
  hostError,
  manualHost,
  onManualHostChange,
  onSelect,
  onManualConnect,
}: {
  hosts: SshHost[] | null;
  hostError: string | null;
  manualHost: string;
  onManualHostChange: (v: string) => void;
  onSelect: (host: string) => void;
  onManualConnect: () => void;
}) {
  return (
    <>
      <div className="flex flex-col items-center gap-3 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-white/[0.08] bg-white/[0.03]">
          <Server className="h-5 w-5 text-foreground/70" />
        </div>
        <h1 className="font-display text-3xl font-semibold tracking-tight">
          Connect a remote workspace
        </h1>
        <p className="max-w-md text-sm text-muted-foreground">
          Pick a host and browse for the folder you want to open.
          Hosts are read from your <code>~/.ssh/config</code>.
        </p>
      </div>

      {hostError && (
        <div className="rounded-lg border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
          {hostError}
        </div>
      )}

      {hosts === null ? (
        <div className="flex h-11 items-center justify-center rounded-lg border border-white/[0.08] bg-white/[0.03] text-xs text-muted-foreground">
          Reading ~/.ssh/config…
        </div>
      ) : hosts.length > 0 ? (
        <div className="grid gap-2 sm:grid-cols-2">
          {hosts.map((host) => (
            <button
              key={host.alias}
              type="button"
              onClick={() => onSelect(host.alias)}
              className={cn(
                'group flex flex-col items-start gap-1 rounded-xl border px-4 py-3 text-left transition-all',
                'border-white/[0.08] bg-white/[0.03] hover:-translate-y-[1px] hover:border-white/15 hover:bg-white/[0.06] hover:shadow-[0_10px_30px_hsl(0_0%_0%/0.35)]'
              )}
            >
              <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                <Server className="h-3.5 w-3.5 text-muted-foreground" />
                {host.alias}
              </div>
              <div className="truncate text-[11px] text-muted-foreground">
                {host.user ? `${host.user}@` : ''}
                {host.host}
                {host.port && host.port !== 22 ? `:${host.port}` : ''}
              </div>
            </button>
          ))}
        </div>
      ) : (
        <p className="text-center text-[11px] text-muted-foreground">
          No hosts found in ~/.ssh/config.
        </p>
      )}

      <div className="flex flex-col gap-1.5">
        <label className="text-xs font-medium text-foreground">Or connect to a host manually</label>
        <div className="flex gap-2">
          <input
            value={manualHost}
            onChange={(e) => onManualHostChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onManualConnect();
            }}
            placeholder="user@host or ssh-config-alias"
            className="h-11 flex-1 rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 text-sm text-foreground placeholder:text-muted-foreground focus:border-white/20 focus:outline-none focus:ring-0"
          />
          <button
            type="button"
            disabled={!manualHost.trim()}
            onClick={onManualConnect}
            className={cn(
              'rounded-lg px-4 text-sm font-medium transition-all',
              manualHost.trim()
                ? 'bg-foreground text-background shadow-sm hover:bg-foreground/90'
                : 'cursor-not-allowed bg-white/[0.04] text-muted-foreground'
            )}
          >
            Connect
          </button>
        </div>
      </div>
    </>
  );
}

function FolderBrowser({
  host,
  sshUser,
  agentUserMode,
  onChangeMode,
  listing,
  loading,
  error,
  showHidden,
  onToggleHidden,
  onNavigate,
  onHome,
  onOpen,
  onCreateFolder,
  busy,
  connectError,
  willChownInPlace,
  chownBlocked,
}: {
  host: string;
  sshUser: string | null;
  agentUserMode: AgentUserMode;
  onChangeMode: (next: AgentUserMode) => void;
  listing: DirListing | null;
  loading: boolean;
  error: string | null;
  showHidden: boolean;
  onToggleHidden: () => void;
  onNavigate: (path: string) => void;
  onHome: () => void;
  onOpen: () => void;
  onCreateFolder: (name: string) => Promise<string | null>;
  busy: boolean;
  connectError: string | null;
  willChownInPlace: boolean;
  chownBlocked: boolean;
}) {
  const [newFolderName, setNewFolderName] = useState('');
  const [newFolderMode, setNewFolderMode] = useState(false);
  const [newFolderError, setNewFolderError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const submitNewFolder = async () => {
    if (creating) return;
    setCreating(true);
    const err = await onCreateFolder(newFolderName);
    setCreating(false);
    if (err) {
      setNewFolderError(err);
      return;
    }
    setNewFolderName('');
    setNewFolderError(null);
    setNewFolderMode(false);
  };

  const cancelNewFolder = () => {
    setNewFolderName('');
    setNewFolderError(null);
    setNewFolderMode(false);
  };
  const segments = listing ? buildSegments(listing.path, listing.home) : [];
  const filtered = (listing?.entries ?? []).filter(
    (entry) => showHidden || !entry.name.startsWith('.')
  );

  const showModePicker = sshUser === 'root';

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Server className="h-3.5 w-3.5" />
        Browsing <span className="font-medium text-foreground">{host}</span>
        {sshUser && (
          <span className="text-muted-foreground/60">· as {sshUser}</span>
        )}
      </div>

      {showModePicker && (
        <div className="flex flex-col gap-2 rounded-xl border border-white/[0.08] bg-white/[0.03] p-3">
          <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/80">
            <ShieldCheck className="h-3 w-3" />
            Run agents as
          </div>
          <div className="flex gap-1.5">
            <ModePill
              active={agentUserMode === 'ace-agent'}
              label={`${HELPER_USER}`}
              sub="Recommended · auto-approve works"
              onClick={() => onChangeMode('ace-agent')}
            />
            <ModePill
              active={agentUserMode === 'root'}
              label="root"
              sub="Auto-approve unavailable"
              onClick={() => onChangeMode('root')}
            />
          </div>
          <p className="text-[11px] text-muted-foreground">
            {agentUserMode === 'ace-agent'
              ? `Ace will auto-create ${HELPER_USER} on first import so Claude's --dangerously-skip-permissions flag works. New workspaces default to ${HELPER_WORKSPACES}/.`
              : 'The daemon will run as root. Claude refuses --dangerously-skip-permissions under root, so auto-approve will be disabled for chats in this workspace.'}
          </p>
        </div>
      )}

      <div className="flex min-h-[32px] flex-wrap items-center gap-1 rounded-lg border border-white/[0.08] bg-white/[0.03] px-2.5 py-1.5 text-xs">
        <button
          type="button"
          onClick={onHome}
          className="flex h-6 items-center gap-1 rounded px-1.5 text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground"
          title="Home"
        >
          <HomeIcon className="h-3 w-3" />
        </button>
        {segments.map((seg, i) => (
          <div key={`${seg.path}-${i}`} className="flex items-center gap-1">
            <ChevronRight className="h-3 w-3 text-muted-foreground/50" />
            <button
              type="button"
              onClick={() => onNavigate(seg.path)}
              className={cn(
                'rounded px-1.5 py-0.5 transition-colors',
                i === segments.length - 1
                  ? 'font-medium text-foreground'
                  : 'text-muted-foreground hover:bg-white/[0.06] hover:text-foreground'
              )}
            >
              {seg.label}
            </button>
          </div>
        ))}
      </div>

      <div className="overflow-hidden rounded-xl border border-white/[0.08] bg-white/[0.02]">
        <div className="flex items-center justify-between border-b border-white/[0.06] px-3 py-2 text-[11px]">
          <span className="text-muted-foreground">
            {listing?.hasGit ? (
              <span className="inline-flex items-center gap-1 text-foreground/80">
                <GitBranch className="h-3 w-3" /> Git repository
              </span>
            ) : (
              'Not a git repo — threads only until initialized'
            )}
          </span>
          <div className="flex items-center gap-3">
            {listing && !newFolderMode && (
              <button
                type="button"
                onClick={() => setNewFolderMode(true)}
                className="flex items-center gap-1 text-muted-foreground transition-colors hover:text-foreground"
                title="Create a new folder here"
              >
                <FolderPlus className="h-3 w-3" />
                New folder
              </button>
            )}
            {listing?.parent && (
              <button
                type="button"
                onClick={() => listing.parent && onNavigate(listing.parent)}
                className="flex items-center gap-1 text-muted-foreground transition-colors hover:text-foreground"
              >
                <CornerUpLeft className="h-3 w-3" />
                Up
              </button>
            )}
            <button
              type="button"
              onClick={onToggleHidden}
              className="text-muted-foreground transition-colors hover:text-foreground"
            >
              {showHidden ? 'Hide hidden' : 'Show hidden'}
            </button>
          </div>
        </div>
        <div className="max-h-[380px] overflow-y-auto">
          {newFolderMode && listing && (
            <div className="flex flex-col gap-1.5 border-b border-white/[0.06] bg-white/[0.02] px-3 py-2.5">
              <div className="flex items-center gap-2">
                <Folder className="h-4 w-4 shrink-0 text-foreground/50" />
                <input
                  autoFocus
                  value={newFolderName}
                  disabled={creating}
                  onChange={(e) => {
                    setNewFolderName(e.target.value);
                    if (newFolderError) setNewFolderError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void submitNewFolder();
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      cancelNewFolder();
                    }
                  }}
                  placeholder="Folder name"
                  className="h-7 flex-1 rounded border border-white/[0.08] bg-white/[0.03] px-2 text-[13px] text-foreground placeholder:text-muted-foreground/50 focus:border-white/20 focus:outline-none focus:ring-0 disabled:opacity-50"
                />
                <button
                  type="button"
                  onClick={() => void submitNewFolder()}
                  disabled={creating || !newFolderName.trim()}
                  className={cn(
                    'rounded px-2 py-1 text-[11px] font-medium transition-colors',
                    creating || !newFolderName.trim()
                      ? 'cursor-not-allowed bg-white/[0.04] text-muted-foreground'
                      : 'bg-foreground text-background hover:bg-foreground/90'
                  )}
                >
                  {creating ? 'Creating…' : 'Create'}
                </button>
                <button
                  type="button"
                  onClick={cancelNewFolder}
                  disabled={creating}
                  className="rounded px-1.5 py-1 text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground disabled:opacity-50"
                  aria-label="Cancel"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
              {newFolderError && (
                <div className="pl-6 text-[11px] text-rose-300/85">{newFolderError}</div>
              )}
            </div>
          )}
          {(loading || !listing) && !error && (
            <div className="flex items-center justify-center gap-2 px-4 py-10 text-xs text-muted-foreground">
              <span className="h-3 w-3 animate-spin rounded-full border-2 border-white/15 border-t-white/60" />
              Loading…
            </div>
          )}
          {error && (
            <div className="px-4 py-6 text-center text-xs text-rose-300/80">
              {error}
            </div>
          )}
          {!loading && !error && listing && filtered.length === 0 && !newFolderMode && (
            <div className="px-4 py-10 text-center text-xs text-muted-foreground">
              No folders here.
            </div>
          )}
          {!loading && !error && listing && filtered.map((entry) => (
            <button
              key={entry.name}
              type="button"
              onClick={() => listing && onNavigate(joinPath(listing.path, entry.name))}
              className="flex w-full items-center gap-2.5 border-b border-white/[0.03] px-3 py-2 text-left text-[13px] text-foreground/85 transition-colors last:border-b-0 hover:bg-white/[0.05] hover:text-foreground"
            >
              <Folder className="h-4 w-4 shrink-0 text-foreground/50" />
              <span className="flex-1 truncate">{entry.name}</span>
            </button>
          ))}
        </div>
      </div>

      {connectError && (
        <div className="rounded-lg border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
          {connectError}
        </div>
      )}

      {willChownInPlace && !chownBlocked && (
        <div className="flex items-start gap-2.5 rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2.5 text-[11px] text-amber-100/90">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <div className="flex flex-col gap-0.5">
            <div className="font-medium text-amber-100">
              This folder will be chowned to {HELPER_USER}
            </div>
            <div>
              Files stay at this path, but ownership changes so {HELPER_USER} can read
              and write them. Root retains access via group membership. Click Open to
              review the exact commands before proceeding.
            </div>
          </div>
        </div>
      )}

      {chownBlocked && listing && (
        <div className="flex items-start gap-2.5 rounded-lg border border-rose-500/20 bg-rose-500/10 px-3 py-2.5 text-[11px] text-rose-100/90">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <div>
            Refusing to chown <span className="font-mono">{listing.path}</span> — it&apos;s
            a system directory. Pick a subdirectory instead, or create a new folder
            under <span className="font-mono">{HELPER_WORKSPACES}</span>.
          </div>
        </div>
      )}

      <div className="flex items-center justify-between">
        <div className="text-[11px] text-muted-foreground">
          {listing ? <>Selected: <span className="text-foreground/80">{listing.path}</span></> : null}
        </div>
        <button
          type="button"
          disabled={!listing || busy || chownBlocked}
          onClick={onOpen}
          className={cn(
            'rounded-lg px-5 py-2 text-sm font-medium transition-all',
            listing && !busy && !chownBlocked
              ? willChownInPlace
                ? 'bg-amber-500 text-background shadow-sm hover:bg-amber-500/90'
                : 'bg-foreground text-background shadow-sm hover:bg-foreground/90'
              : 'cursor-not-allowed bg-white/[0.04] text-muted-foreground'
          )}
        >
          {busy
            ? 'Opening…'
            : willChownInPlace
              ? 'Open and chown to ace-agent'
              : 'Open this folder'}
        </button>
      </div>
    </div>
  );
}

function ModePill({
  active,
  label,
  sub,
  onClick,
}: {
  active: boolean;
  label: string;
  sub: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex flex-1 flex-col items-start gap-0.5 rounded-lg border px-3 py-2 text-left transition-all',
        active
          ? 'border-white/20 bg-white/[0.08] shadow-[inset_0_0_0_1px_hsl(0_0%_100%/0.06)]'
          : 'border-white/[0.08] bg-white/[0.02] hover:border-white/15 hover:bg-white/[0.05]'
      )}
    >
      <div className="text-xs font-medium text-foreground">{label}</div>
      <div className="text-[10px] text-muted-foreground">{sub}</div>
    </button>
  );
}

function ChownConfirmDialog({
  path,
  onCancel,
  onConfirm,
}: {
  path: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [typedPath, setTypedPath] = useState('');
  const canConfirm = typedPath.trim() === path;

  return (
    <div
      className="glass-overlay fixed inset-0 z-[120] flex items-center justify-center"
      onClick={onCancel}
    >
      <div
        className="glass-surface flex w-full max-w-lg flex-col gap-4 rounded-2xl p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-amber-500/30 bg-amber-500/10">
            <AlertTriangle className="h-4 w-4 text-amber-400" />
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <h2 className="font-display text-lg font-semibold">
              Confirm chown in place
            </h2>
            <p className="text-xs text-muted-foreground">
              This will run the following commands on the remote host as root:
            </p>
          </div>
        </div>

        <div className="rounded-lg border border-white/[0.08] bg-black/30 p-3 font-mono text-[11px] leading-relaxed text-foreground/80">
          <div># create helper user if missing</div>
          <div>useradd -m -s /bin/bash {HELPER_USER}</div>
          <div className="mt-2"># add root to the helper group so both can edit</div>
          <div>usermod -aG {HELPER_USER} root</div>
          <div className="mt-2"># chown the workspace</div>
          <div>chown -R {HELPER_USER}:{HELPER_USER} {path}</div>
          <div>chmod -R g+rwX {path}</div>
          <div className="mt-2"># tell git the mixed-ownership state is fine</div>
          <div>git config --global --add safe.directory &apos;*&apos;</div>
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-[11px] font-medium text-foreground">
            Type the full path to confirm
          </label>
          <input
            value={typedPath}
            onChange={(e) => setTypedPath(e.target.value)}
            placeholder={path}
            className="h-9 w-full rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 font-mono text-xs text-foreground placeholder:text-muted-foreground/50 focus:border-white/20 focus:outline-none focus:ring-0"
            autoFocus
          />
        </div>

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg px-4 py-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!canConfirm}
            onClick={onConfirm}
            className={cn(
              'rounded-lg px-4 py-2 text-xs font-medium transition-all',
              canConfirm
                ? 'bg-amber-500 text-background shadow-sm hover:bg-amber-500/90'
                : 'cursor-not-allowed bg-white/[0.04] text-muted-foreground'
            )}
          >
            Run chown
          </button>
        </div>
      </div>
    </div>
  );
}

function buildSegments(
  fullPath: string,
  home: string
): Array<{ path: string; label: string }> {
  if (!fullPath) return [];
  let rest = fullPath;
  const segments: Array<{ path: string; label: string }> = [];
  if (home && fullPath === home) {
    return [{ path: home, label: '~' }];
  }
  if (home && fullPath.startsWith(home + '/')) {
    segments.push({ path: home, label: '~' });
    rest = fullPath.slice(home.length + 1);
  } else {
    segments.push({ path: '/', label: '/' });
    rest = fullPath.replace(/^\/+/, '');
  }
  const parts = rest.split('/').filter(Boolean);
  let acc = segments[segments.length - 1].path;
  for (const part of parts) {
    acc = acc === '/' ? `/${part}` : `${acc}/${part}`;
    segments.push({ path: acc, label: part });
  }
  return segments;
}

function joinPath(base: string, child: string): string {
  if (!base || base === '/') return `/${child}`;
  return `${base}/${child}`;
}
