import { useState } from 'react';
import { ChevronRight, FolderOpen, FolderSearch, GitFork, Server } from 'lucide-react';
import { useApp } from '../store';
import { isRemoteClient } from '../lib/ace-api';
import { useCoreSelector } from '../runtime/core-registry';
import { importWorkspacePath } from '../runtime/workspace-registry';
import { RemoteFileBrowser } from './RemoteFileBrowser';
import { AceMark } from './ui/AceMark';
import { HomeDeck } from './HomeDeck';

// Desktop lands on the live Command Deck (HomeDeck); remote clients (no native
// dialogs) keep the workspace-picker RemoteWelcome. The mobile Today landing is
// a separate component (TodayDashboard) and is untouched.
export function WelcomeScreen() {
  const remote = isRemoteClient();
  return remote ? <RemoteWelcome /> : <HomeDeck />;
}

// ─── Remote welcome (workspace picker, no native dialogs) ────────────────

function RemoteWelcome() {
  const { openWorkspace, setShowCloneWorkspaceModal, setView } = useApp();
  const workspaces = useCoreSelector((s) => s.workspaces.filter((w) => !w.isPersonal));
  const [browsing, setBrowsing] = useState(false);
  const [importing, setImporting] = useState(false);

  const handleBrowseSelect = async (selectedPath: string) => {
    setImporting(true);
    try {
      const workspace = await importWorkspacePath(selectedPath);
      if (workspace) openWorkspace(workspace.id);
    } catch {
      // importWorkspacePath will throw if the path is invalid — stay
      // on the browser so the user can pick another folder.
    } finally {
      setImporting(false);
      setBrowsing(false);
    }
  };

  return (
    <WelcomeShell>
      <div className="w-full">
        {browsing ? (
          <div className="w-full">
            <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">
              Browse host filesystem
            </h3>
            {importing ? (
              <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
                Opening workspace…
              </div>
            ) : (
              <RemoteFileBrowser
                onSelect={handleBrowseSelect}
                onCancel={() => setBrowsing(false)}
              />
            )}
          </div>
        ) : (
          <>
            {/* Action cards */}
            <div className="mb-6 grid w-full grid-cols-1 gap-2 sm:grid-cols-3">
              <RemoteActionCard
                icon={FolderSearch}
                title="Open Workspace"
                description="Browse folders on the host"
                onClick={() => setBrowsing(true)}
              />
              <RemoteActionCard
                icon={GitFork}
                title="Clone from GitHub"
                description="Clone a repo to the host"
                onClick={() => setShowCloneWorkspaceModal(true)}
              />
              <RemoteActionCard
                icon={Server}
                title="Add Remote"
                description="Connect via SSH"
                onClick={() => setView('new-remote')}
              />
            </div>

            {/* Existing workspaces */}
            <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">
              Workspaces
            </h3>
            {workspaces.length === 0 ? (
              <div className="rounded-xl border border-dashed border-white/[0.1] bg-white/[0.015] px-6 py-10 text-center backdrop-blur-xl">
                <p className="text-sm text-muted-foreground">
                  No workspaces yet. Browse folders above to open one.
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-1.5">
                {workspaces.map((w) => (
                  <button
                    key={w.id}
                    type="button"
                    onClick={() => openWorkspace(w.id)}
                    className="mobile-glass-card group flex w-full items-center gap-3 rounded-xl px-4 py-3 text-left transition-colors active:bg-white/[0.08] sm:hover:bg-white/[0.05]"
                  >
                    <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-foreground">{w.name}</p>
                      <p className="mt-0.5 text-[11px] text-muted-foreground">
                        {w.tasks.length} {w.tasks.length === 1 ? 'thread' : 'threads'}
                        {w.githubRepo && (
                          <span className="ml-1.5 text-muted-foreground/50">· {w.githubRepo}</span>
                        )}
                      </p>
                    </div>
                    <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/50" />
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </WelcomeShell>
  );
}

// ─── Shared shell ─────────────────────────────────────────────────────────

function WelcomeShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="shell-sidebar-surface flex h-full flex-col overflow-y-auto text-foreground">
      <div className="mx-auto flex min-h-full w-full max-w-2xl flex-1 flex-col items-center justify-center px-4 py-12 sm:px-8">
        <div className="mb-10 flex flex-col items-center gap-3">
          <AceMark size={40} shimmer />
          <div className="text-center">
            <h1 className="font-display text-3xl font-semibold tracking-tight text-foreground">
              Ace
            </h1>
            <p className="mt-1.5 text-sm text-muted-foreground">
              Your desktop agent orchestrator
            </p>
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}

// ─── Remote action card (compact, no hover lift) ──────────────────────────

function RemoteActionCard({
  icon: Icon,
  title,
  description,
  onClick,
}: {
  icon: typeof FolderOpen;
  title: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mobile-glass-card flex w-full items-center gap-3 rounded-xl p-3 text-left transition-colors active:bg-white/[0.09] sm:hover:bg-white/[0.06]"
    >
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-white/[0.1] bg-white/[0.06]">
        <Icon className="h-3.5 w-3.5 text-foreground/90" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[12px] font-semibold text-foreground">{title}</p>
        <p className="text-[10px] text-muted-foreground">{description}</p>
      </div>
    </button>
  );
}
