import { useCallback, useEffect, useMemo, useState } from 'react';
import { Settings, Bot, GitBranch, ExternalLink, KeyRound, Palette, Plug, Wifi, Wrench, ChevronRight, MessageSquare, TerminalSquare } from 'lucide-react';
import { cn } from '../lib/utils';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { useAgentCatalog } from '../runtime/agent-registry';
import { aceApi, isRemoteClient } from '../lib/ace-api';
import type { DataRootSummary, OperatorsLoadResult } from '../lib/ace-api';
import type { OperatorsConfig, OperatorProfile } from '../lib/operators';
import AgentLogo from './ProviderGlyph';
import { TintControls } from './TintPicker';
import { useApp } from '../store';
import { useIsMobileViewport } from '../runtime/use-mobile-viewport';
import {
  type ChatViewMode,
  useDefaultViewMode,
  writeDefaultViewMode,
} from '../runtime/ace-chat-preferences';
import { StorageSection } from './settings/StorageSection';
import { OperatorsSection } from './settings/OperatorsSection';
import { HermesSurfaceSection } from './settings/HermesSurfaceSection';
import type { OperatorLike } from './settings/storage-section-logic';
import {
  normalizeHermesDesktopStatus,
  type HermesDesktopStatusLike,
  type HermesSurface,
} from './settings/hermes-surface-logic';
import {
  consumePendingPreferencesTab,
  onPreferencesTabRequest,
} from '../runtime/preferences-tab';

type TabDef = {
  id: 'general' | 'agents' | 'accounts' | 'repository' | 'appearance' | 'docs';
  icon: typeof Settings;
  label: string;
  external?: boolean;
};

const TABS: readonly TabDef[] = [
  { id: 'general', icon: Settings, label: 'General' },
  { id: 'agents', icon: Bot, label: 'Agents' },
  { id: 'accounts', icon: KeyRound, label: 'Accounts' },
  { id: 'repository', icon: GitBranch, label: 'Repository' },
  { id: 'appearance', icon: Palette, label: 'Appearance' },
  { id: 'docs', icon: ExternalLink, label: 'Docs', external: true },
] as const;

type Tab = TabDef['id'];

const DOCS_URL = 'https://github.com/skysphere-labs/ace-coder-public';

export function PreferencesScreen() {
  const { setView } = useApp();
  const isMobile = useIsMobileViewport();
  const remote = isRemoteClient();
  // GitHub credentials are managed on the desktop host.
  const tabs = useMemo(() => (remote ? TABS.filter((t) => t.id !== 'accounts') : TABS), [remote]);
  const [activeTab, setActiveTab] = useState<Tab>(
    () => consumePendingPreferencesTab() ?? 'general'
  );
  useEffect(
    () =>
      onPreferencesTabRequest((tab) => {
        if (tabs.some((t) => t.id === tab && !t.external)) setActiveTab(tab);
      }),
    [tabs]
  );
  // Derived, not corrected in an effect: a tab that isn't in `tabs` (Accounts on
  // a remote client, including a deep link straight to it) falls back to General
  // rather than rendering a blank pane.
  const currentTab: Tab = tabs.some((t) => t.id === activeTab) ? activeTab : 'general';

  const handleTabClick = (tab: TabDef) => {
    if (tab.external) {
      void aceApi.workspaces.openExternal(DOCS_URL);
      return;
    }
    setActiveTab(tab.id);
  };

  return (
    <div className="shell-sidebar-surface flex h-full min-h-0 flex-col overflow-hidden text-foreground">
      <div className="min-h-0 flex-1 overflow-y-auto px-2 sm:px-6">
        <div className="mx-auto w-full max-w-4xl px-2 pb-16 pt-4 sm:px-8 sm:pt-10">
          <div className="mb-1 flex items-center gap-2">
            <Settings className="h-5 w-5 text-foreground/70" />
            <h2 className="font-display text-lg font-semibold tracking-tight">Settings</h2>
          </div>
          <p className="mb-8 text-sm text-muted-foreground">
            Manage your workspace configuration
          </p>

          <div className="flex min-h-0 flex-col gap-6 sm:flex-row sm:gap-10">
            <nav className="flex w-full shrink-0 flex-row gap-1 overflow-x-auto sm:w-44 sm:flex-col sm:overflow-x-visible">
              {tabs.map((tab) => {
                const Icon = tab.icon;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => handleTabClick(tab)}
                    className={cn(
                      'flex min-h-[40px] shrink-0 items-center gap-2 whitespace-nowrap rounded-lg px-3 py-2 text-[13px] transition-colors sm:min-h-0',
                      !tab.external && currentTab === tab.id
                        ? 'bg-white/[0.06] font-medium text-foreground'
                        : 'text-muted-foreground hover:bg-white/[0.04] hover:text-foreground',
                      tab.external && 'text-muted-foreground/70'
                    )}
                  >
                    <Icon className="h-3.5 w-3.5 shrink-0" />
                    <span className="flex-1 text-left">{tab.label}</span>
                    {tab.external && <ExternalLink className="ml-auto h-3 w-3" />}
                  </button>
                );
              })}
            </nav>

            <div className="min-w-0 flex-1">
              <div className="flex flex-col gap-8">
                {currentTab === 'general' && <GeneralSettings />}
                {currentTab === 'agents' && <AgentsSettings />}
                {currentTab === 'accounts' && <GithubAccountSettings />}
                {currentTab === 'repository' && <RepositorySettings />}
                {currentTab === 'appearance' && <AppearanceSettings />}
                {isMobile && (
                  <SettingsSection title="More">
                    <NavRow
                      title="Plugins"
                      description="Skills & MCP servers"
                      icon={<Plug className="h-4 w-4 text-foreground/70" />}
                      onClick={() => setView('plugins')}
                    />
                    {!remote && (
                      <NavRow
                        title="Remote"
                        description="Enable remote access from other devices"
                        icon={<Wifi className="h-4 w-4 text-foreground/70" />}
                        onClick={() => setView('remote')}
                      />
                    )}
                  </SettingsSection>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function SettingsSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2.5">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">
        {title}
      </h3>
      {children}
    </div>
  );
}

function SettingsRow({
  title,
  description,
  icon,
  action,
}: {
  title: string;
  description: string;
  icon?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-3">
      {icon && <div className="shrink-0">{icon}</div>}
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{description}</p>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

function ToggleRow({
  label,
  description,
  defaultOn = false,
}: {
  label: string;
  description: string;
  defaultOn?: boolean;
}) {
  const [on, setOn] = useState(defaultOn);
  return (
    <SettingsRow
      title={label}
      description={description}
      action={
        <button
          type="button"
          role="switch"
          onClick={() => setOn(!on)}
          aria-checked={on}
          aria-label={label}
          className={cn(
            'flex h-[22px] w-[40px] shrink-0 items-center rounded-full border px-[3px] transition-colors duration-150',
            on
              ? 'justify-end border-emerald-400/30 bg-emerald-500/25'
              : 'justify-start border-white/[0.08] bg-white/[0.04]'
          )}
        >
          <div
            className={cn(
              'h-4 w-4 rounded-full transition-colors duration-150',
              on ? 'bg-foreground' : 'bg-foreground/60'
            )}
          />
        </button>
      }
    />
  );
}

function DefaultViewRow() {
  const mode = useDefaultViewMode();
  return (
    <SettingsRow
      title="Default view"
      description="Which view new Claude, Codex, Gemini, and Hermes tabs open in. Switching a specific tab still overrides this."
      action={
        <div className="inline-flex h-7 shrink-0 overflow-hidden rounded-full border border-white/[0.07] bg-white/[0.02] p-0.5">
          <DefaultViewOption
            value="chat"
            current={mode}
            icon={<MessageSquare className="h-3 w-3" />}
            label="Chat"
          />
          <DefaultViewOption
            value="cli"
            current={mode}
            icon={<TerminalSquare className="h-3 w-3" />}
            label="Terminal"
          />
        </div>
      }
    />
  );
}

function DefaultViewOption({
  value,
  current,
  icon,
  label,
}: {
  value: ChatViewMode;
  current: ChatViewMode;
  icon: React.ReactNode;
  label: string;
}) {
  const active = current === value;
  return (
    <button
      type="button"
      onClick={() => writeDefaultViewMode(value)}
      aria-pressed={active}
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2.5 text-[11.5px] font-medium transition-colors',
        active
          ? 'bg-white/[0.08] text-foreground'
          : 'text-muted-foreground hover:text-foreground'
      )}
    >
      {icon}
      {label}
    </button>
  );
}

function GeneralSettings() {
  const { setView } = useApp();
  // Storage settings belong to the local desktop.
  const remote = isRemoteClient();
  return (
    <>
      <SettingsSection title="Application">
        <ToggleRow label="Launch at login" description="Start Ace when you log in" />
        <DefaultViewRow />
        <NavRow
          title="Setup"
          description="Recheck prerequisites (git, node, gh) and install agents"
          icon={<Wrench className="h-4 w-4 text-foreground/70" />}
          onClick={() => setView('setup')}
        />
      </SettingsSection>
      {!remote && <StorageSettings />}
      <SettingsSection title="Notifications">
        <ToggleRow label="Sound notifications" description="Play sound when agent completes a task" defaultOn />
        <ToggleRow label="Desktop notifications" description="Show native desktop notifications" defaultOn />
      </SettingsSection>
      <SettingsSection title="Local diagnostics">
        <p className="text-sm text-muted-foreground">Operational diagnostics are stored on this device. ACE CODER does not upload them.</p>
      </SettingsSection>
    </>
  );
}

function GithubAccountSettings() {
  const { setView } = useApp();
  return <SettingsRow title="GitHub accounts" description="Connect your own GitHub account to browse and clone repositories. Local work does not require sign-in."
    action={<Button onClick={() => setView('github')}>Manage GitHub accounts</Button>} />;
}

// ── Operators / Storage glue ─────────────────────────────────────────────────
// Live operators.json view over the read-only list IPC. source 'default'
// means the owner migration has not created the file yet — saves are blocked
// then, so Settings can never pre-create operators.json and mask the
// migration (owner-agent persistence is the #1 priority of that layer).
function useLiveOperators() {
  const [loaded, setLoaded] = useState<OperatorsLoadResult | null>(null);

  const refresh = useCallback(() => {
    aceApi.operators
      .list()
      .then(setLoaded)
      .catch(() => setLoaded(null));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const patchOperator = useCallback(async (id: string, patch: Partial<OperatorProfile>) => {
    // Re-read the on-disk truth right before writing so a stale snapshot can
    // never clobber concurrent changes.
    const live = await aceApi.operators.list();
    if (live.source === 'default') {
      throw new Error('Operator profiles are not initialized yet. Relaunch Ace first.');
    }
    const next = {
      ...live.config,
      operators: live.config.operators.map((op) => (op.id === id ? { ...op, ...patch } : op)),
    };
    await aceApi.operators.save(next);
    setLoaded({ ...live, config: next });
  }, []);

  return { loaded, patchOperator };
}

function toOperatorLikes(config: OperatorsConfig): OperatorLike[] {
  return config.operators.map((op) => ({
    id: op.id,
    label: op.label,
    // Migrated/neutral electron profiles may carry a null emoji at runtime.
    emoji: op.emoji || '🧠',
    terminalDirName: op.terminalDirName,
    hermesHome: op.hermesHome ?? null,
    memoryDbPath: op.memoryDbPath ?? null,
    isControlPlane: op.isControlPlane,
  }));
}

// ── Storage (General tab) ────────────────────────────────────────────────────
function StorageSettings() {
  const [dataRoot, setDataRoot] = useState<DataRootSummary | null>(null);
  const { loaded, patchOperator } = useLiveOperators();
  const [operatorError, setOperatorError] = useState<string | null>(null);

  useEffect(() => {
    aceApi.storage
      .getDataRoot()
      .then(setDataRoot)
      .catch(() => {});
  }, []);

  if (dataRoot === null) return null;

  return (
    <>
      <StorageSection
        dataRoot={{
          root: dataRoot.root,
          active: dataRoot.active,
          source: dataRoot.source ?? 'local',
          // Raw reason codes only matter when a root was actually configured;
          // the plain local default gets the section's stock copy instead.
          reason: dataRoot.configuredRoot ? (dataRoot.reason ?? undefined) : undefined,
        }}
        onPickDirectory={pickDataRootDirectory}
        onSetDataRoot={async (root) => {
          await aceApi.storage.setDataRoot(root);
        }}
        operators={loaded ? toOperatorLikes(loaded.config) : []}
        onSetOperatorHome={(id, home) => {
          setOperatorError(null);
          patchOperator(id, { hermesHome: home }).catch((err) =>
            setOperatorError(err instanceof Error ? err.message : 'Failed to save operator config.')
          );
        }}
      />
      {operatorError !== null && (
        <SettingsRow title="Operator update failed" description={operatorError} />
      )}
    </>
  );
}

async function pickDataRootDirectory(): Promise<string | null> {
  const result = await aceApi.workspaces.pickDirectory({
    title: 'Select Ace Data Root',
    buttonLabel: 'Use Folder',
    createDirectory: true,
  });
  return result.path;
}

// ── Operators (Agents tab) ───────────────────────────────────────────────────
function OperatorsSettings() {
  const { loaded, patchOperator } = useLiveOperators();
  const [error, setError] = useState<string | null>(null);

  if (loaded === null) return null;

  const onPatch = (id: string, patch: Partial<OperatorProfile>) => {
    setError(null);
    patchOperator(id, patch).catch((err) =>
      setError(err instanceof Error ? err.message : 'Failed to save operator config.')
    );
  };

  return (
    <>
      <OperatorsSection
        operators={toOperatorLikes(loaded.config)}
        onRename={(id, label) => onPatch(id, { label })}
        onSetOperatorHome={(id, home) => onPatch(id, { hermesHome: home })}
      />
      {error !== null && <SettingsRow title="Operator update failed" description={error} />}
    </>
  );
}

// ── Hermes surface (Agents tab) ──────────────────────────────────────────────
// Glue for the props-driven HermesSurfaceSection (UpdatesSettings pattern).
// The aceApi.hermesDesktop namespace ships with the dashboard manager (a
// later unit); until then this glue feature-detects it and renders the
// section disabled on the lanes default — nothing here can start, stop, or
// reroute a lane while the namespace is absent.
type HermesDesktopApiLike = {
  getStatus: () => Promise<unknown>;
  setSurface: (surface: HermesSurface) => Promise<unknown>;
  onEvent?: (listener: (status: unknown) => void) => () => void;
};

function hermesDesktopApi(): HermesDesktopApiLike | null {
  const candidate = (aceApi as unknown as { hermesDesktop?: Partial<HermesDesktopApiLike> })
    .hermesDesktop;
  if (!candidate) return null;
  if (typeof candidate.getStatus !== 'function' || typeof candidate.setSurface !== 'function') {
    return null;
  }
  return candidate as HermesDesktopApiLike;
}

function HermesSurfaceSettings() {
  const [api] = useState(hermesDesktopApi);
  const [status, setStatus] = useState<HermesDesktopStatusLike | null>(null);

  useEffect(() => {
    if (!api) return;
    let alive = true;
    api
      .getStatus()
      .then((raw) => {
        // Never let the initial pull overwrite a fresher push that already
        // arrived through onEvent while the pull was in flight.
        const next = normalizeHermesDesktopStatus(raw);
        if (alive && next) setStatus((prev) => prev ?? next);
      })
      .catch(() => {});
    const unsubscribe = api.onEvent
      ? api.onEvent((raw) => {
          const next = normalizeHermesDesktopStatus(raw);
          if (next) setStatus(next);
        })
      : () => {};
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [api]);

  // Manager present but first status still in flight — wait like
  // UpdatesSettings rather than flashing the disabled state.
  if (api && status === null) return null;

  const handleSetSurface = (surface: HermesSurface) => {
    if (!api) return;
    void api
      .setSurface(surface)
      .then((raw) => {
        // Either return shape works: a status snapshot applies directly, a
        // bare ack triggers a refresh pull.
        const next = normalizeHermesDesktopStatus(raw);
        if (next) {
          setStatus(next);
          return;
        }
        return api.getStatus().then((fresh) => {
          const refreshed = normalizeHermesDesktopStatus(fresh);
          if (refreshed) setStatus(refreshed);
        });
      })
      .catch(() => {});
  };

  return <HermesSurfaceSection status={status} onSetSurface={handleSetSurface} />;
}

function AgentsSettings() {
  const agents = useAgentCatalog();
  // Operator profiles live in the desktop main process; remote clients have
  // no operators IPC surface (same for the Hermes Desktop manager).
  const remote = isRemoteClient();

  return (
    <>
      {!remote && <HermesSurfaceSettings />}
      {!remote && <OperatorsSettings />}
      <SettingsSection title="Agent Settings">
        <ToggleRow label="Auto-approve" description="Automatically approve agent actions without confirmation" />
        <ToggleRow label="Full-screen Ace" description="Run agents in full-screen terminal mode" />
      </SettingsSection>
      <SettingsSection title="Default Agent">
        {(() => {
          const defaultAgent = agents.find((a) => a.launchable);
          return (
            <SettingsRow
              title={defaultAgent?.name ?? 'No launchable agent'}
              description="Default agent for new tasks"
              icon={defaultAgent ? <AgentLogo agent={defaultAgent.id} className="h-6 w-6" /> : undefined}
              action={
                <Badge variant={defaultAgent ? 'success' : 'muted'}>
                  {defaultAgent ? 'Installed' : 'Unavailable'}
                </Badge>
              }
            />
          );
        })()}
      </SettingsSection>
      <SettingsSection title="Installed Agents">
        {agents.map((agent) => (
          <SettingsRow
            key={agent.id}
            title={agent.name}
            description={agent.launchable ? 'Detected and ready to use' : agent.reason ?? 'Not available'}
            icon={<AgentLogo agent={agent.id} className="h-6 w-6" />}
            action={
              <Badge variant={agent.launchable ? 'success' : 'muted'}>
                {agent.launchable ? 'Active' : agent.status === 'missing' ? 'Missing' : 'Unsupported'}
              </Badge>
            }
          />
        ))}
      </SettingsSection>
    </>
  );
}

function AppearanceSettings() {
  return (
    <SettingsSection title="Appearance">
      <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
        <TintControls />
      </div>
    </SettingsSection>
  );
}

function NavRow({
  title,
  description,
  icon,
  onClick,
}: {
  title: string;
  description: string;
  icon: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-3 text-left transition-colors active:bg-white/[0.06] hover:bg-white/[0.04]"
    >
      <div className="shrink-0">{icon}</div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{description}</p>
      </div>
      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/60" />
    </button>
  );
}

function RepositorySettings() {
  return (
    <>
      <SettingsSection title="Git Configuration">
        <SettingsRow
          title="Default branch"
          description="main"
          action={<Button variant="outline" size="sm" className="h-7 text-[11px]">Change</Button>}
        />
        <SettingsRow
          title="Worktree mode"
          description="Create isolated worktrees for each task"
          action={<Badge variant="success">Enabled</Badge>}
        />
      </SettingsSection>
      <SettingsSection title="Branch Cleanup">
        <ToggleRow label="Auto-cleanup merged branches" description="Remove local branches after PR merge" defaultOn />
      </SettingsSection>
    </>
  );
}
