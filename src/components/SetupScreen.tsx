import { useEffect, useMemo, useState } from 'react';
import {
  ArrowRight,
  Check,
  Copy,
  ExternalLink,
  Loader2,
  RefreshCw,
  Wrench,
  X,
} from 'lucide-react';
import { cn } from '../lib/utils';
import { aceApi, type CliStatus, type SystemTool } from '../lib/ace-api';
import type { AgentCatalogEntry, AgentId } from '../lib/types';
import { useAgentCatalog, invalidateAgentCatalog } from '../runtime/agent-registry';
import { markSetupCompleted, useApp } from '../store';
import { landingView } from '../runtime/use-mobile-viewport';
import AgentLogo from './ProviderGlyph';
import { InstallAgentDialog } from './InstallAgentDialog';

// Featured agents shown on the setup screen. The full catalog is still
// reachable from Settings → Agents; this list is just the curated short
// list a new user is most likely to start with.
const FEATURED_AGENTS: AgentId[] = ['claude', 'codex', 'gemini', 'cursor'];

export function SetupScreen() {
  const { setView } = useApp();
  const [tools, setTools] = useState<SystemTool[] | null>(null);
  const [refreshingTools, setRefreshingTools] = useState(false);
  const catalog = useAgentCatalog();
  const [installAgent, setInstallAgent] = useState<AgentCatalogEntry | null>(null);
  const [cliStatus, setCliStatus] = useState<CliStatus | null>(null);

  const refreshCli = async () => {
    try {
      setCliStatus(await aceApi.cli.getStatus());
    } catch {
      setCliStatus(null);
    }
  };

  const refreshTools = async () => {
    setRefreshingTools(true);
    try {
      const next = await aceApi.agents.getSystemTools();
      setTools(next);
    } catch {
      setTools([]);
    } finally {
      setRefreshingTools(false);
    }
  };

  useEffect(() => {
    void refreshTools();
    void refreshCli();
  }, []);

  const featuredAgents = useMemo(() => {
    const byId = new Map(catalog.map((entry) => [entry.id, entry]));
    return FEATURED_AGENTS.map((id) => byId.get(id)).filter(
      (entry): entry is AgentCatalogEntry => !!entry
    );
  }, [catalog]);

  const requiredTools = (tools ?? []).filter((t) => t.kind === 'required');
  const recommendedTools = (tools ?? []).filter((t) => t.kind === 'recommended');
  const hasAgent = featuredAgents.some((a) => a.launchable);
  // Required gate: every required tool ok + at least one agent launchable.
  // Doesn't block the Continue button; just informs the badge.
  const requiredOk = requiredTools.every((t) => t.ok) && hasAgent;

  const finish = () => {
    markSetupCompleted();
    setView(landingView());
  };

  const skip = () => {
    markSetupCompleted();
    setView(landingView());
  };

  return (
    <div className="shell-sidebar-surface flex h-full min-h-0 flex-col overflow-hidden text-foreground">
      <div className="min-h-0 flex-1 overflow-y-auto px-6">
        <div className="mx-auto w-full max-w-3xl px-4 pb-16 pt-6 sm:px-8 sm:pt-10">
          <div className="mb-1 flex items-center gap-2">
            <Wrench className="h-5 w-5 text-foreground/70" />
            <h2 className="font-display text-lg font-semibold tracking-tight">
              Set up Ace
            </h2>
            <div className="flex-1" />
            <button
              type="button"
              onClick={() => {
                void refreshTools();
                void refreshCli();
                invalidateAgentCatalog();
              }}
              disabled={refreshingTools}
              aria-label="Recheck"
              className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-white/[0.04] hover:text-foreground disabled:opacity-50"
            >
              <RefreshCw className={cn('h-4 w-4', refreshingTools && 'animate-spin')} />
            </button>
          </div>
          <p className="mb-8 text-sm text-muted-foreground">
            A few prerequisites need to be installed before Ace can drive an
            agent. You can revisit this screen any time from Settings.
          </p>

          <Section
            title="Required"
            subtitle="Install these to use Ace."
            status={
              tools === null
                ? 'loading'
                : requiredTools.every((t) => t.ok)
                  ? 'ok'
                  : 'missing'
            }
          >
            {tools === null ? (
              <SkeletonRow />
            ) : (
              requiredTools.map((tool) => <ToolRow key={tool.id} tool={tool} />)
            )}
          </Section>

          <Section
            title="Coding agents"
            subtitle="Install at least one to start chatting. You can add more later."
            status={
              catalog.length === 0
                ? 'loading'
                : hasAgent
                  ? 'ok'
                  : 'missing'
            }
          >
            {catalog.length === 0 ? (
              <SkeletonRow />
            ) : (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {featuredAgents.map((agent) => (
                  <AgentRow
                    key={agent.id}
                    agent={agent}
                    onInstall={() => setInstallAgent(agent)}
                  />
                ))}
              </div>
            )}
          </Section>

          <Section
            title="Recommended"
            subtitle="Optional but unlocks the GitHub integrations (open PRs list, create PR from Changes)."
            status={
              tools === null
                ? 'loading'
                : recommendedTools.every((t) => t.ok)
                  ? 'ok'
                  : 'pending'
            }
          >
            {tools === null ? (
              <SkeletonRow />
            ) : (
              recommendedTools.map((tool) => <ToolRow key={tool.id} tool={tool} />)
            )}
          </Section>

          {cliStatus?.supported && (
            <Section
              title="Command-line companion"
              subtitle="Lets an orchestrating agent drive any Ace tab. Optional."
              status={
                cliStatus.installed && cliStatus.installedPointsToBundle ? 'ok' : 'pending'
              }
            >
              <CliRow status={cliStatus} onChanged={refreshCli} />
            </Section>
          )}

          <div className="mt-8 flex items-center justify-between gap-3 rounded-xl border border-white/[0.06] bg-white/[0.02] p-3">
            <div className="text-[12px] text-muted-foreground">
              {requiredOk
                ? 'Everything required is installed. You\u2019re ready to go.'
                : 'You can continue without all required tools, but some workspaces won\u2019t work until they\u2019re installed.'}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={skip}
                className="rounded-lg px-3 py-1.5 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground"
              >
                Skip for now
              </button>
              <button
                type="button"
                onClick={finish}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-medium transition-all',
                  requiredOk
                    ? 'bg-foreground text-background shadow-sm hover:bg-foreground/90'
                    : 'bg-white/[0.08] text-foreground hover:bg-white/[0.12]'
                )}
              >
                Continue
                <ArrowRight className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        </div>
      </div>

      {installAgent && (
        <InstallAgentDialog
          agent={installAgent}
          onClose={() => setInstallAgent(null)}
          onInstalled={() => {
            // Catalog refreshes itself via invalidateAgentCatalog inside the
            // dialog; no further action needed here.
          }}
        />
      )}
    </div>
  );
}

// ─── Section + status pill ────────────────────────────────────────────────

type SectionStatus = 'loading' | 'ok' | 'missing' | 'pending';

function Section({
  title,
  subtitle,
  status,
  children,
}: {
  title: string;
  subtitle: string;
  status: SectionStatus;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-6">
      <div className="mb-3 flex items-baseline gap-2">
        <h3 className="text-[13px] font-semibold text-foreground">{title}</h3>
        <SectionPill status={status} />
        <span className="ml-auto text-[11px] text-muted-foreground/70">{subtitle}</span>
      </div>
      <div className="flex flex-col gap-2">{children}</div>
    </section>
  );
}

function SectionPill({ status }: { status: SectionStatus }) {
  if (status === 'loading') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-white/[0.06] bg-white/[0.04] px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
        <Loader2 className="h-2.5 w-2.5 animate-spin" />
        Checking
      </span>
    );
  }
  if (status === 'ok') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/25 bg-emerald-500/[0.08] px-1.5 py-0.5 text-[10px] font-medium text-emerald-300">
        <Check className="h-2.5 w-2.5" />
        Ready
      </span>
    );
  }
  if (status === 'missing') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/25 bg-amber-500/[0.08] px-1.5 py-0.5 text-[10px] font-medium text-amber-300">
        Action needed
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-white/[0.06] bg-white/[0.04] px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
      Optional
    </span>
  );
}

// ─── Tool row (git, node, gh) ─────────────────────────────────────────────

function ToolRow({ tool }: { tool: SystemTool }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    if (!tool.installHint) return;
    try {
      await navigator.clipboard.writeText(tool.installHint);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };
  const statusLine = tool.ok
    ? tool.version
      ? `Installed · ${tool.version}`
      : 'Installed'
    : tool.found && tool.warnIfBelowMajor
      ? `Found ${tool.version ?? 'older version'} — needs ${tool.warnIfBelowMajor}+`
      : 'Not found on PATH';

  return (
    <div
      className={cn(
        'flex items-start gap-3 rounded-xl border bg-white/[0.02] p-3 transition-colors',
        tool.ok
          ? 'border-emerald-500/15'
          : tool.kind === 'required'
            ? 'border-amber-500/20'
            : 'border-white/[0.06]'
      )}
    >
      <StatusDot ok={tool.ok} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-[13px] font-medium text-foreground">{tool.label}</span>
          <span
            className={cn(
              'text-[10.5px]',
              tool.ok ? 'text-emerald-300/80' : 'text-amber-300/80'
            )}
          >
            {statusLine}
          </span>
        </div>
        <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
          {tool.description}
        </p>
        {!tool.ok && tool.installHint && (
          <div className="mt-2 flex items-center gap-2 rounded-lg border border-white/[0.06] bg-black/30 px-2.5 py-1.5">
            <code className="flex-1 truncate font-mono text-[11px] text-foreground/85">
              {tool.installHint}
            </code>
            <button
              type="button"
              onClick={handleCopy}
              title={copied ? 'Copied' : 'Copy'}
              className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground"
            >
              {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
            </button>
          </div>
        )}
        {!tool.ok && tool.postInstallHint && (
          <p className="mt-1.5 text-[10.5px] text-muted-foreground/80">
            {tool.postInstallHint}
          </p>
        )}
      </div>
      {tool.docsUrl && (
        <a
          href={tool.docsUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[10.5px] text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground"
          onClick={(e) => {
            e.preventDefault();
            void aceApi.workspaces.openExternal(tool.docsUrl!);
          }}
        >
          <ExternalLink className="h-3 w-3" />
          Docs
        </a>
      )}
    </div>
  );
}

// ─── Agent row ────────────────────────────────────────────────────────────

function AgentRow({
  agent,
  onInstall,
}: {
  agent: AgentCatalogEntry;
  onInstall: () => void;
}) {
  const installed = agent.launchable;
  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-xl border bg-white/[0.02] p-3 transition-colors',
        installed ? 'border-emerald-500/15' : 'border-white/[0.06] hover:border-white/[0.1]'
      )}
    >
      <AgentLogo agent={agent.id} className="h-7 w-7 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-[13px] font-medium text-foreground">{agent.label}</span>
          {installed ? (
            <span className="text-[10.5px] text-emerald-300/80">Installed</span>
          ) : (
            <span className="text-[10.5px] text-muted-foreground/80">Not installed</span>
          )}
        </div>
        {agent.reason && !installed && (
          <p className="mt-0.5 truncate text-[10.5px] text-muted-foreground/70">
            {agent.reason}
          </p>
        )}
      </div>
      <button
        type="button"
        onClick={onInstall}
        className={cn(
          'inline-flex shrink-0 items-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors',
          installed
            ? 'text-muted-foreground hover:bg-white/[0.06] hover:text-foreground'
            : 'bg-white/[0.08] text-foreground hover:bg-white/[0.12]'
        )}
      >
        {installed ? 'Reinstall' : 'Install'}
      </button>
    </div>
  );
}

// ─── Misc ─────────────────────────────────────────────────────────────────

function StatusDot({ ok }: { ok: boolean }) {
  return ok ? (
    <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-300">
      <Check className="h-2.5 w-2.5" />
    </span>
  ) : (
    <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-amber-500/15 text-amber-300">
      <X className="h-2.5 w-2.5" />
    </span>
  );
}

function SkeletonRow() {
  return (
    <div className="flex items-center gap-2 rounded-xl border border-white/[0.05] bg-white/[0.015] p-3 text-[11px] text-muted-foreground/70">
      <Loader2 className="h-3 w-3 animate-spin" />
      Checking…
    </div>
  );
}

// ─── CLI installer row ────────────────────────────────────────────────────

function CliRow({
  status,
  onChanged,
}: {
  status: CliStatus;
  onChanged: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const installed = status.installed && status.installedPointsToBundle;
  const conflict = status.installed && !status.installedPointsToBundle;

  const statusLine = installed
    ? `Installed · ${status.installPath}`
    : conflict
      ? `Different binary at ${status.existingTarget}`
      : 'Not installed';

  const doInstall = async (force: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const res = await aceApi.cli.install(force ? { force: true } : undefined);
      if (!res.ok) setError(res.error || 'install failed');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      await onChanged();
      setBusy(false);
    }
  };

  const doUninstall = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await aceApi.cli.uninstall();
      if (!res.ok) setError(res.error || 'uninstall failed');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      await onChanged();
      setBusy(false);
    }
  };

  return (
    <div
      className={cn(
        'flex items-start gap-3 rounded-xl border bg-white/[0.02] p-3 transition-colors',
        installed ? 'border-emerald-500/15' : 'border-white/[0.06]'
      )}
    >
      <StatusDot ok={installed} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-[13px] font-medium text-foreground">ace</span>
          <span
            className={cn(
              'truncate text-[10.5px]',
              installed ? 'text-emerald-300/80' : 'text-muted-foreground/80'
            )}
          >
            {statusLine}
          </span>
        </div>
        <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
          Symlinks the <code className="font-mono text-[10.5px]">ace</code> binary into{' '}
          <code className="font-mono text-[10.5px]">~/.local/bin</code>. An agent inside Ace can
          then drive any other tab with a single command.
        </p>
        {installed && !status.onPath && (
          <p className="mt-1.5 text-[10.5px] text-amber-300/80">
            {status.installDir} isn’t on your shell PATH. Add{' '}
            <code className="font-mono text-[10.5px]">
              export PATH=&quot;$HOME/.local/bin:$PATH&quot;
            </code>{' '}
            to your shell rc.
          </p>
        )}
        {error && (
          <p className="mt-1.5 text-[10.5px] text-amber-300/80">{error}</p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {installed ? (
          <button
            type="button"
            onClick={doUninstall}
            disabled={busy}
            className="rounded-md px-2.5 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground disabled:opacity-50"
          >
            Uninstall
          </button>
        ) : (
          <button
            type="button"
            onClick={() => doInstall(conflict)}
            disabled={busy || !status.bundledExists}
            className={cn(
              'inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors disabled:opacity-50',
              'bg-white/[0.08] text-foreground hover:bg-white/[0.12]'
            )}
          >
            {busy ? (
              <>
                <Loader2 className="h-3 w-3 animate-spin" />
                Working…
              </>
            ) : conflict ? (
              'Replace'
            ) : (
              'Install'
            )}
          </button>
        )}
      </div>
    </div>
  );
}
