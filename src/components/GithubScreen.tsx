import { useEffect, useMemo, useState } from 'react';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import {
  ArrowUpDown, BookOpen, Building2, Check, ChevronDown, Download, ExternalLink, Flame, FolderOpen,
  GitFork, Link as LinkIcon, Loader2, MapPin, Plus, RefreshCw, Search, Star, Users, X,
} from 'lucide-react';

function Github({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <path d="M12 .5C5.73.5.77 5.46.77 11.73c0 4.92 3.19 9.1 7.62 10.58.56.1.76-.24.76-.54v-1.9c-3.1.67-3.75-1.49-3.75-1.49-.51-1.29-1.24-1.63-1.24-1.63-1.01-.69.08-.68.08-.68 1.12.08 1.7 1.15 1.7 1.15.99 1.7 2.6 1.21 3.23.92.1-.72.39-1.21.71-1.49-2.48-.28-5.09-1.24-5.09-5.53 0-1.22.44-2.22 1.15-3-.11-.28-.5-1.42.11-2.96 0 0 .94-.3 3.08 1.14.89-.25 1.85-.38 2.8-.38s1.91.13 2.8.38c2.13-1.44 3.07-1.14 3.07-1.14.61 1.54.23 2.68.11 2.96.72.78 1.15 1.78 1.15 3 0 4.3-2.62 5.25-5.11 5.52.4.34.76 1.02.76 2.06v3.05c0 .3.2.65.77.54 4.42-1.48 7.6-5.66 7.6-10.58C23.23 5.46 18.27.5 12 .5z" />
    </svg>
  );
}
import { useApp } from '../store';
import { aceApi } from '../lib/ace-api';
import type { GithubContributions, GithubRepo, GithubTrendingRow, TrackedGithubProject } from '../lib/ace-api';
import { useCoreSelector } from '../runtime/core-registry';
import {
  loadRepos, loadStars, loadTrending,
  recheckAvailability, refreshAccounts, toggleStar,
  useGithubState,
} from '../runtime/github-registry';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Spinner } from './ui/spinner';
import { cn } from '../lib/utils';

type Tab = 'tracked' | 'repos' | 'stars' | 'trending';
type SortKey = 'updated' | 'oldest' | 'stars';

const SORT_OPTIONS: { id: SortKey; label: string }[] = [
  { id: 'updated', label: 'Recently updated' },
  { id: 'oldest', label: 'Oldest first' },
  { id: 'stars', label: 'Most stars' },
];

function sortRepos(list: GithubRepo[], key: SortKey): GithubRepo[] {
  if (key === 'updated') return list;
  const copy = [...list];
  if (key === 'oldest') {
    copy.sort((a, b) => new Date(a.pushedAt).getTime() - new Date(b.pushedAt).getTime());
  } else if (key === 'stars') {
    copy.sort((a, b) => b.stars - a.stars);
  }
  return copy;
}

export function GithubScreen() {
  const state = useGithubState();
  const [tab, setTab] = useState<Tab>('tracked');

  if (!state.availability) {
    return (
      <Shell>
        <div className="flex h-full items-center justify-center">
          <Spinner size="lg" className="text-muted-foreground" />
        </div>
      </Shell>
    );
  }

  if (!state.availability.installed) {
    return (
      <Shell>
        <NotInstalled />
      </Shell>
    );
  }

  if (state.accounts.length === 0) {
    return (
      <Shell>
        <Header />
        <NoAccounts />
      </Shell>
    );
  }

  const activeAccount = state.accounts.find((a) => a.isActive) ?? state.accounts[0] ?? null;

  return (
    <div className="shell-sidebar-surface flex h-full flex-col text-foreground">
      <div className="shrink-0">
        <Header />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {activeAccount && <ProfileHeader account={activeAccount} />}
        <div className="mx-auto w-full max-w-5xl">
          <Tabs tab={tab} setTab={setTab} />
          <div className="px-4 py-4 sm:px-6">
            {tab === 'repos' && <ReposTab />}
            {tab === 'tracked' && <TrackedProjectsTab />}
            {tab === 'stars' && <StarsTab />}
            {tab === 'trending' && <TrendingTab />}
          </div>
        </div>
      </div>
    </div>
  );
}

function ProfileHeader({ account }: { account: import('../lib/ace-api').GithubAccount }) {
  return (
    <div className="mx-auto w-full max-w-7xl px-6 py-8 sm:px-10 sm:py-10">
      <div className="flex flex-col gap-8 lg:flex-row lg:items-center lg:gap-10">
        <div className="flex shrink-0 flex-col items-start gap-4 lg:w-64">
          <Avatar url={account.avatarUrl} login={account.login} size={176} />
          <div className="w-full">
            <div className="min-w-0">
              {account.name && (
                <h2 className="font-display text-2xl font-semibold leading-tight truncate">
                  {account.name}
                </h2>
              )}
              <div className="text-base text-muted-foreground truncate">{account.login}</div>
            </div>
            {account.bio && (
              <p className="mt-3 text-sm text-foreground/85">{account.bio}</p>
            )}
            <div className="mt-4 flex flex-col gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void aceApi.workspaces.openExternal(account.htmlUrl)}
              >
                <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
                View on GitHub
              </Button>
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12px] text-muted-foreground">
              <ProfileStat icon={Users} label={`${formatCount(account.followers ?? 0)} followers`} />
              <span className="text-foreground/25">·</span>
              <ProfileStat label={`${formatCount(account.following ?? 0)} following`} />
            </div>
            {(account.company || account.location || account.blog) && (
              <div className="mt-3 flex flex-col gap-1.5 text-[12px] text-muted-foreground">
                {account.company && <ProfileStat icon={Building2} label={account.company} />}
                {account.location && <ProfileStat icon={MapPin} label={account.location} />}
                {account.blog && (
                  <button
                    type="button"
                    onClick={() =>
                      void aceApi.workspaces.openExternal(
                        account.blog!.startsWith('http') ? account.blog! : `https://${account.blog}`
                      )
                    }
                    className="inline-flex items-center gap-1.5 truncate text-left hover:text-foreground"
                  >
                    <LinkIcon className="h-3 w-3 shrink-0" />
                    <span className="truncate">{account.blog}</span>
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
        <div className="min-w-0 flex-1">
          <ContributionGraph login={account.login} />
        </div>
      </div>
    </div>
  );
}

function ProfileStat({
  icon: Icon,
  label,
}: {
  icon?: React.ComponentType<{ className?: string }>;
  label: string;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {Icon && <Icon className="h-3 w-3" />}
      <span className="tabular-nums">{label}</span>
    </span>
  );
}

function ContributionGraph({ login }: { login: string }) {
  const currentYear = new Date().getFullYear();
  const years = [currentYear, currentYear - 1, currentYear - 2, currentYear - 3, currentYear - 4];
  const [selectedYear, setSelectedYear] = useState<number | null>(null);
  const activeYear = selectedYear ?? currentYear;
  const [state, setState] = useState<{
    loadedFor: string | null;
    data: GithubContributions | null;
    error: string | null;
  }>({ loadedFor: null, data: null, error: null });

  const requestKey = `${login}:${activeYear}`;

  useEffect(() => {
    let cancelled = false;
    aceApi.github
      .fetchContributions(selectedYear ? { login, year: selectedYear } : { login })
      .then((d) => {
        if (!cancelled) setState({ loadedFor: requestKey, data: d, error: null });
      })
      .catch((e: Error) => {
        if (!cancelled) setState({ loadedFor: requestKey, data: null, error: e.message });
      });
    return () => {
      cancelled = true;
    };
  }, [login, selectedYear, requestKey]);

  const loading = state.loadedFor !== requestKey;
  const data = loading ? null : state.data;
  const error = loading ? null : state.error;
  const label = selectedYear
    ? `contributions in ${selectedYear}`
    : 'contributions in the last year';

  return (
    <div className="flex items-start gap-4">
      <div className="min-w-0 flex-1">
        <div className="mb-3 flex items-baseline justify-between">
          <div className="text-sm font-medium text-foreground/85">
            {data ? (
              <>
                <span className="tabular-nums">{formatCount(data.total)}</span>
                <span className="text-muted-foreground"> {label}</span>
              </>
            ) : error ? (
              <span className="text-muted-foreground">Contributions unavailable</span>
            ) : (
              <span className="inline-flex items-center gap-2 text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" /> Loading contributions…
              </span>
            )}
          </div>
        </div>
        {data ? (
          <ContributionHeatmap weeks={data.weeks} />
        ) : (
          <div className="h-[110px] animate-pulse rounded-md bg-white/[0.02]" />
        )}
      </div>
      <div className="flex shrink-0 flex-col gap-1">
        {years.map((y) => {
          const active = activeYear === y;
          return (
            <button
              key={y}
              type="button"
              onClick={() => setSelectedYear(y === currentYear ? null : y)}
              className={cn(
                'rounded-md px-3 py-1 text-left text-[12px] font-medium tabular-nums transition-colors',
                active
                  ? 'bg-white/[0.08] text-foreground'
                  : 'text-muted-foreground hover:bg-white/[0.04] hover:text-foreground',
              )}
            >
              {y}
            </button>
          );
        })}
      </div>
    </div>
  );
}

const LEVEL_BG = [
  'bg-white/[0.04]',
  'bg-emerald-500/20',
  'bg-emerald-500/45',
  'bg-emerald-500/70',
  'bg-emerald-400',
];

function ContributionHeatmap({ weeks }: { weeks: GithubContributions['weeks'] }) {
  const monthLabels = computeMonthLabels(weeks);
  return (
    <div className="overflow-x-auto">
      <div className="inline-block">
        <div className="flex gap-[3px] pl-[22px] text-[10px] text-muted-foreground">
          {monthLabels.map((label, i) => (
            <div key={i} style={{ width: 11 }}>
              {label}
            </div>
          ))}
        </div>
        <div className="mt-1 flex gap-[3px]">
          <div className="flex flex-col justify-between pr-1 pt-[10px] text-[10px] text-muted-foreground">
            <span>Mon</span>
            <span>Wed</span>
            <span>Fri</span>
          </div>
          {weeks.map((week, wi) => (
            <div key={wi} className="flex flex-col gap-[3px]">
              {Array.from({ length: 7 }).map((_, di) => {
                const day = week.days.find((_, idx) => idx === di);
                if (!day) return <div key={di} className="h-[11px] w-[11px]" />;
                return (
                  <div
                    key={di}
                    title={`${day.count} contribution${day.count === 1 ? '' : 's'} · ${day.date}`}
                    className={cn('h-[11px] w-[11px] rounded-[2px]', LEVEL_BG[day.level])}
                  />
                );
              })}
            </div>
          ))}
        </div>
        <div className="mt-2 flex items-center justify-end gap-1.5 text-[10px] text-muted-foreground">
          <span>Less</span>
          {LEVEL_BG.map((bg, i) => (
            <span key={i} className={cn('h-[11px] w-[11px] rounded-[2px]', bg)} />
          ))}
          <span>More</span>
        </div>
      </div>
    </div>
  );
}

function computeMonthLabels(weeks: GithubContributions['weeks']): string[] {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  let lastMonth = -1;
  return weeks.map((week) => {
    const first = week.days[0];
    if (!first) return '';
    const m = new Date(first.date).getMonth();
    if (m !== lastMonth) {
      lastMonth = m;
      return months[m];
    }
    return '';
  });
}

// ── Layout ────────────────────────────────────────────────────────────────

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="shell-sidebar-surface flex h-full flex-col text-foreground">
      <div className="mx-auto flex min-h-0 w-full max-w-5xl flex-1 flex-col">
        {children}
      </div>
    </div>
  );
}

function Header() {
  const { setView } = useApp();
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-white/[0.06] px-4 py-4 sm:px-6">
      <Github className="h-5 w-5 text-muted-foreground" />
      <h1 className="font-display text-lg font-semibold">GitHub</h1>
      <div className="ml-auto">
        <Button
          variant="outline"
          size="sm"
          onClick={() => setView('github-browser')}
          title="Open github.com in an embedded browser"
        >
          <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
          Browse github.com
        </Button>
      </div>
    </div>
  );
}

function Tabs({ tab, setTab }: { tab: Tab; setTab: (t: Tab) => void }) {
  const { repos, stars } = useGithubState();
  const trackedCount = useCoreSelector((s) =>
    s.workspaces.filter((workspace) => workspace.githubRepo && !workspace.isPersonal).length
  );
  const items: Array<{
    id: Tab;
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    count: number | null;
  }> = [
    { id: 'tracked', label: 'Tracked', icon: BookOpen, count: trackedCount || null },
    { id: 'repos', label: 'Repositories', icon: Github, count: repos.data.length || null },
    { id: 'stars', label: 'Stars', icon: Star, count: stars.data.length || null },
    { id: 'trending', label: 'Trending', icon: Flame, count: null },
  ];
  return (
    <div className="flex shrink-0 items-center gap-1 border-b border-white/[0.06] px-3 sm:px-5">
      {items.map((item) => {
        const Icon = item.icon;
        const active = tab === item.id;
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => setTab(item.id)}
            className={cn(
              'flex items-center gap-1.5 border-b-2 px-3 py-2.5 text-[13px] font-medium transition-colors',
              active
                ? 'border-foreground text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            <Icon className="h-3.5 w-3.5" />
            {item.label}
            {item.count !== null && (
              <span className="ml-0.5 rounded-full bg-white/[0.08] px-1.5 py-[1px] text-[10px] font-semibold tabular-nums text-foreground/80">
                {formatCount(item.count)}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ── Not-installed / no-accounts states ────────────────────────────────────

function NotInstalled() {
  const [checking, setChecking] = useState(false);
  return (
    <div className="flex flex-1 items-center justify-center px-6">
      <div className="max-w-md text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl border border-white/[0.08] bg-white/[0.04]">
          <Github className="h-5 w-5 text-foreground/80" />
        </div>
        <h2 className="font-display text-xl font-semibold">Install GitHub CLI</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Ace uses the GitHub CLI (<code className="rounded bg-white/[0.06] px-1">gh</code>) for
          authentication. Install it, then come back and click Re-check.
        </p>
        <div className="mt-5 flex items-center justify-center gap-2">
          <Button
            variant="outline"
            onClick={() => void aceApi.workspaces.openExternal('https://cli.github.com/')}
          >
            <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
            Open cli.github.com
          </Button>
          <Button
            onClick={async () => {
              setChecking(true);
              try { await recheckAvailability(); } finally { setChecking(false); }
            }}
            disabled={checking}
          >
            {checking ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1.5 h-3.5 w-3.5" />}
            Re-check
          </Button>
        </div>
      </div>
    </div>
  );
}

function NoAccounts() {
  return (
    <div className="flex flex-1 items-center justify-center px-6">
      <div className="max-w-md text-center">
        <h2 className="font-display text-lg font-semibold">No accounts yet</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Add a GitHub account to browse your repos, stars, and trending.
        </p>
        <div className="mt-5 flex items-center justify-center gap-2">
          <Button variant="outline" onClick={() => void refreshAccounts()}>
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Refresh
          </Button>
          <AddAccountTrigger />
        </div>
      </div>
    </div>
  );
}

function AddAccountTrigger() {
  const { setShowAddGithubAccountDialog } = useApp();
  return (
    <Button onClick={() => setShowAddGithubAccountDialog(true)}>
      <Plus className="mr-1.5 h-3.5 w-3.5" /> Add account
    </Button>
  );
}

// ── Avatar ────────────────────────────────────────────────────────────────

function Avatar({ url, login, size }: { url: string | null; login: string; size: number }) {
  if (url) {
    return (
      <img
        src={url}
        alt={login}
        width={size}
        height={size}
        className="rounded-full"
        onError={(e) => {
          (e.currentTarget as HTMLImageElement).style.display = 'none';
        }}
      />
    );
  }
  return (
    <div
      className="flex items-center justify-center rounded-full bg-white/[0.1] text-[10px] font-semibold uppercase"
      style={{ width: size, height: size }}
    >
      {login.slice(0, 1)}
    </div>
  );
}

// ── Tracked tab ───────────────────────────────────────────────────────────

function TrackedProjectsTab() {
  const { openWorkspace } = useApp();
  const [projects, setProjects] = useState<TrackedGithubProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await aceApi.workspaces.listTrackedGithubProjects();
      setProjects(result.projects || []);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
  }, []);

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="min-w-0 text-sm text-muted-foreground">
          Ace workspaces with GitHub remotes, wiki entrypoints, active tasks, and open PRs.
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          {loading ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1.5 h-3.5 w-3.5" />}
          Refresh
        </Button>
      </div>
      {loading && projects.length === 0 ? (
        <SkeletonList />
      ) : error ? (
        <ErrorRow error={error} />
      ) : projects.length === 0 ? (
        <EmptyRow message="No Ace workspaces are linked to GitHub repositories yet" />
      ) : (
        <div className="flex flex-col gap-2">
          {projects.map((project) => (
            <div
              key={project.workspaceId}
              className="rounded-xl border border-white/[0.06] bg-white/[0.025] p-3"
            >
              <div className="flex min-w-0 flex-col gap-3 md:flex-row md:items-start md:justify-between">
                <div className="min-w-0">
                  <button
                    type="button"
                    onClick={() => openWorkspace(project.workspaceId, 'new-chat')}
                    className="truncate text-left text-[14px] font-semibold text-foreground hover:underline"
                  >
                    {project.workspaceName}
                  </button>
                  <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted-foreground">
                    <span className="inline-flex min-w-0 items-center gap-1">
                      <Github className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate">{project.githubRepo}</span>
                    </span>
                    <span className="inline-flex min-w-0 items-center gap-1">
                      <GitFork className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate">{project.defaultBranch}</span>
                    </span>
                    {project.workspacePath && (
                      <span className="inline-flex min-w-0 items-center gap-1">
                        <MapPin className="h-3.5 w-3.5 shrink-0" />
                        <span className="truncate">{project.workspacePath}</span>
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  <Button size="sm" variant="outline" onClick={() => openWorkspace(project.workspaceId, 'new-chat')}>
                    Open
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void aceApi.workspaces.openExternal(project.githubUrl)}
                  >
                    <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
                    GitHub
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!project.wikiPath || !project.wikiExists}
                    title={project.wikiPath || 'Remote workspace wiki path is unavailable'}
                    onClick={() => {
                      if (!project.wikiPath) return;
                      void aceApi.workspaces.openFolder(project.wikiPath.replace(/[\\/]+index\.md$/, ''));
                    }}
                  >
                    <FolderOpen className="mr-1.5 h-3.5 w-3.5" />
                    Wiki
                  </Button>
                </div>
              </div>
              <div className="mt-3 grid gap-2 md:grid-cols-2">
                <TrackedMetric label="Active tasks" value={project.activeTasks.length} />
                <TrackedMetric label="Open PRs" value={project.openPrs.length} />
              </div>
              {(project.activeTasks.length > 0 || project.openPrs.length > 0) && (
                <div className="mt-3 grid gap-2 md:grid-cols-2">
                  <TrackedMiniList
                    title="Tasks"
                    rows={project.activeTasks.map((task) => `${task.name} · ${task.agent} · ${task.status}`)}
                  />
                  <TrackedMiniList
                    title="PRs"
                    rows={project.openPrs.map((pr) => `#${pr.number} ${pr.title}`)}
                  />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TrackedMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-white/[0.05] bg-black/10 px-3 py-2">
      <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70">{label}</div>
      <div className="mt-0.5 text-sm font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function TrackedMiniList({ title, rows }: { title: string; rows: string[] }) {
  return (
    <div className="rounded-lg border border-white/[0.05] bg-black/10 px-3 py-2">
      <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70">{title}</div>
      {rows.length === 0 ? (
        <div className="mt-1 text-[12px] text-muted-foreground">None</div>
      ) : (
        <div className="mt-1 flex flex-col gap-1">
          {rows.slice(0, 3).map((row) => (
            <div key={row} className="truncate text-[12px] text-foreground/85">{row}</div>
          ))}
          {rows.length > 3 && (
            <div className="text-[11px] text-muted-foreground">+{rows.length - 3} more</div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Repositories tab ──────────────────────────────────────────────────────

function ReposTab() {
  const { repos, accounts } = useGithubState();
  const active = accounts.find((a) => a.isActive);
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<SortKey>('updated');
  const [subTab, setSubTab] = useState<'owner' | 'collaborating'>('owner');
  useEffect(() => {
    if (active && repos.data.length === 0 && !repos.loading) void loadRepos();
    // Only refetch when the active login changes; we intentionally don't
    // depend on repos.data.length / repos.loading.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.login]);
  const { owned, collab } = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const apply = (list: GithubRepo[]) => {
      const filtered = needle ? list.filter((r) => r.fullName.toLowerCase().includes(needle)) : list;
      return sortRepos(filtered, sort);
    };
    const login = active?.login;
    return {
      owned: apply(repos.data.filter((r) => r.owner === login)),
      collab: apply(repos.data.filter((r) => r.owner !== login)),
    };
  }, [filter, sort, repos.data, active?.login]);
  const visible = subTab === 'owner' ? owned : collab;

  return (
    <div>
      <div className="mb-3 inline-flex overflow-hidden rounded-lg border border-white/[0.08]">
        {(
          [
            { id: 'owner' as const, label: 'Owner', count: owned.length },
            { id: 'collaborating' as const, label: 'Collaborating', count: collab.length },
          ]
        ).map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setSubTab(t.id)}
            className={cn(
              'flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium transition-colors',
              subTab === t.id
                ? 'bg-white/[0.08] text-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {t.label}
            <span className="rounded-full bg-white/[0.08] px-1.5 py-[1px] text-[10px] font-semibold tabular-nums text-foreground/80">
              {formatCount(t.count)}
            </span>
          </button>
        ))}
      </div>
      <ListToolbar
        placeholder="Filter by name"
        value={filter}
        onChange={setFilter}
        onRefresh={() => void loadRepos()}
        refreshing={repos.loading}
        sort={sort}
        onSortChange={setSort}
      />
      {repos.loading && repos.data.length === 0 ? (
        <SkeletonList />
      ) : repos.error ? (
        <ErrorRow error={repos.error} />
      ) : visible.length === 0 ? (
        <EmptyRow
          message={
            repos.data.length === 0
              ? 'No repositories yet'
              : subTab === 'owner'
                ? 'No owned repositories'
                : 'No repositories you collaborate on'
          }
        />
      ) : (
        <div className="flex flex-col">
          {visible.map((r) => <RepoRow key={r.id} repo={r} showVisibility />)}
        </div>
      )}
    </div>
  );
}

// ── Stars tab ─────────────────────────────────────────────────────────────

function StarsTab() {
  const { stars, accounts } = useGithubState();
  const active = accounts.find((a) => a.isActive);
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<SortKey>('updated');
  useEffect(() => {
    if (active && stars.data.length === 0 && !stars.loading) void loadStars();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.login]);
  const filtered = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const base = needle
      ? stars.data.filter((r) => r.fullName.toLowerCase().includes(needle))
      : stars.data;
    return sortRepos(base, sort);
  }, [filter, sort, stars.data]);

  return (
    <div>
      <ListToolbar
        placeholder="Filter by name"
        value={filter}
        onChange={setFilter}
        onRefresh={() => void loadStars()}
        refreshing={stars.loading}
        sort={sort}
        onSortChange={setSort}
      />
      {stars.loading && stars.data.length === 0 ? (
        <SkeletonList />
      ) : stars.error ? (
        <ErrorRow error={stars.error} />
      ) : filtered.length === 0 ? (
        <EmptyRow message={stars.data.length === 0 ? 'No starred repositories' : 'No matches'} />
      ) : (
        <div className="flex flex-col">
          {filtered.map((r) => <RepoRow key={r.id} repo={r} />)}
        </div>
      )}
    </div>
  );
}

// ── Trending tab ──────────────────────────────────────────────────────────

function TrendingTab() {
  const { trending } = useGithubState();
  const [since, setSince] = useState<'daily' | 'weekly' | 'monthly'>('daily');
  const [showAll, setShowAll] = useState(false);
  const [prevSince, setPrevSince] = useState(since);
  if (since !== prevSince) {
    setPrevSince(since);
    setShowAll(false);
  }

  useEffect(() => {
    void loadTrending({ since, language: null });
  }, [since]);

  const rows = trending.data?.data ?? [];
  const visible = showAll ? rows : rows.slice(0, 10);
  const updatedAt = trending.data?.at;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="inline-flex overflow-hidden rounded-lg border border-white/[0.08]">
          {(['daily', 'weekly', 'monthly'] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSince(s)}
              className={cn(
                'px-3 py-1.5 text-[12px] font-medium transition-colors',
                since === s ? 'bg-white/[0.08] text-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {s === 'daily' ? 'Today' : s === 'weekly' ? 'This Week' : 'This Month'}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2 text-[11px] text-muted-foreground">
          {updatedAt && <span>Updated {relativeTime(updatedAt)}</span>}
          <button
            type="button"
            onClick={() => void loadTrending({ since, language: null })}
            className="inline-flex items-center gap-1 rounded hover:text-foreground"
          >
            <RefreshCw className={cn('h-3 w-3', trending.loading && 'animate-spin')} /> Refresh
          </button>
        </div>
      </div>

      {trending.loading && rows.length === 0 ? (
        <SkeletonList />
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-white/[0.08] px-6 py-10 text-center text-sm text-muted-foreground">
          Trending unavailable —{' '}
          <button
            type="button"
            className="underline hover:text-foreground"
            onClick={() =>
              void aceApi.workspaces.openExternal(
                `https://github.com/trending?since=${since}`
              )
            }
          >
            open on github.com
          </button>
        </div>
      ) : (
        <div className="flex flex-col">
          {visible.map((row, index) => (
            <TrendingRow key={row.fullName} row={row} rank={index + 1} />
          ))}
          {rows.length > 10 && !showAll && (
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="mt-2 rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-center text-[12px] text-muted-foreground hover:text-foreground"
            >
              Show more ({rows.length - 10})
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ── Shared rows ───────────────────────────────────────────────────────────

function ListToolbar({
  placeholder, value, onChange, onRefresh, refreshing, sort, onSortChange,
}: {
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  onRefresh: () => void;
  refreshing: boolean;
  sort?: SortKey;
  onSortChange?: (v: SortKey) => void;
}) {
  return (
    <div className="mb-4 flex items-center gap-2">
      <div className="relative flex-1">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="pl-8"
        />
      </div>
      {sort !== undefined && onSortChange && (
        <SortControl value={sort} onChange={onSortChange} />
      )}
      <Button variant="outline" size="sm" onClick={onRefresh} disabled={refreshing}>
        <RefreshCw className={cn('mr-1.5 h-3.5 w-3.5', refreshing && 'animate-spin')} />
        Refresh
      </Button>
    </div>
  );
}

function SortControl({ value, onChange }: { value: SortKey; onChange: (v: SortKey) => void }) {
  const [open, setOpen] = useState(false);
  const current = SORT_OPTIONS.find((o) => o.id === value) ?? SORT_OPTIONS[0];
  const isDefault = value === SORT_OPTIONS[0].id;
  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <div
        className={cn(
          'inline-flex h-8 items-center rounded-lg border text-[12px]',
          isDefault
            ? 'border-white/[0.08] text-muted-foreground'
            : 'border-emerald-500/40 bg-emerald-500/[0.08] text-emerald-100',
        )}
      >
        <PopoverPrimitive.Trigger asChild>
          <button
            type="button"
            className="inline-flex h-full items-center gap-1.5 px-2.5 hover:text-foreground"
          >
            <ArrowUpDown className="h-3.5 w-3.5" />
            <span>{isDefault ? 'Sort' : current.label}</span>
            <ChevronDown className="h-3 w-3 opacity-60" />
          </button>
        </PopoverPrimitive.Trigger>
        {!isDefault && (
          <button
            type="button"
            onClick={() => onChange(SORT_OPTIONS[0].id)}
            title="Clear sort"
            aria-label="Clear sort"
            className="inline-flex h-full items-center border-l border-emerald-500/30 px-1.5 hover:bg-emerald-500/10 hover:text-foreground"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="end"
          sideOffset={6}
          className="z-50 w-56 rounded-xl border border-white/[0.08] bg-[hsl(240_6%_10%)] p-1.5 shadow-[0_10px_40px_hsl(0_0%_0%/0.5)] backdrop-blur-xl"
        >
          <div className="px-2 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
            Sort by
          </div>
          {SORT_OPTIONS.map((o) => (
            <button
              key={o.id}
              type="button"
              onClick={() => { onChange(o.id); setOpen(false); }}
              className={cn(
                'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors',
                value === o.id ? 'bg-white/[0.06]' : 'hover:bg-white/[0.04]',
              )}
            >
              <span className="flex-1">{o.label}</span>
              {value === o.id && <Check className="h-3.5 w-3.5" />}
            </button>
          ))}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

function RepoRow({ repo, showVisibility }: { repo: GithubRepo; showVisibility?: boolean }) {
  return (
    <div className="group flex items-center gap-3 border-b border-white/[0.04] px-2 py-2.5 hover:bg-white/[0.02]">
      <Avatar url={repo.ownerAvatarUrl} login={repo.owner} size={26} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => void aceApi.workspaces.openExternal(repo.htmlUrl)}
            className="truncate text-[13px] font-semibold text-foreground hover:underline"
          >
            {repo.fullName}
          </button>
          {showVisibility && (
            <span
              className={cn(
                'rounded-full border px-1.5 py-[1px] text-[9px] font-semibold uppercase',
                repo.private
                  ? 'border-amber-500/30 bg-amber-500/10 text-amber-200'
                  : 'border-white/[0.1] text-muted-foreground',
              )}
            >
              {repo.private ? 'Private' : 'Public'}
            </span>
          )}
          {repo.fork && (
            <span className="rounded-full border border-white/[0.1] px-1.5 py-[1px] text-[9px] uppercase text-muted-foreground">
              Fork
            </span>
          )}
        </div>
        <div className="mt-0.5 flex items-center gap-3 text-[11px] text-muted-foreground">
          {repo.language && <span>{repo.language}</span>}
          <InlineStarToggle
            fullName={repo.fullName}
            baseCount={repo.stars}
            cloneUrl={repo.cloneUrl}
            name={repo.name}
            id={repo.id}
          />
          <span>Updated {relativeTime(new Date(repo.pushedAt).getTime())}</span>
        </div>
        {repo.description && (
          <p className="mt-0.5 line-clamp-1 text-[11px] text-muted-foreground/80">
            {repo.description}
          </p>
        )}
      </div>
      <CloneButton input={{ fullName: repo.fullName, cloneUrl: repo.cloneUrl, name: repo.name }} />
    </div>
  );
}

function TrendingRow({ row, rank }: { row: GithubTrendingRow; rank: number }) {
  return (
    <div className="group flex items-start gap-3 border-b border-white/[0.04] px-2 py-3 hover:bg-white/[0.02]">
      <div className="w-6 shrink-0 pt-0.5 text-right text-[16px] font-bold text-muted-foreground/40">
        {rank}
      </div>
      <div className="min-w-0 flex-1">
        <button
          type="button"
          onClick={() => void aceApi.workspaces.openExternal(row.htmlUrl)}
          className="truncate text-[13px] font-semibold hover:underline"
        >
          {row.fullName}
        </button>
        {row.description && (
          <p className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground/80">
            {row.description}
          </p>
        )}
        <div className="mt-1 flex items-center gap-3 text-[11px]">
          {row.language && <span className="text-muted-foreground">{row.language}</span>}
          {row.stars != null && (
            <InlineStarToggle
              fullName={row.fullName}
              baseCount={row.stars}
              cloneUrl={row.cloneUrl}
              name={row.name}
            />
          )}
          {row.forks != null && (
            <span className="inline-flex items-center gap-1 tabular-nums text-muted-foreground">
              <GitFork className="h-3 w-3" /> {formatCount(row.forks)}
            </span>
          )}
          {row.starsGained != null && row.starsGained > 0 && (
            <span className="inline-flex items-center gap-1 tabular-nums font-medium text-emerald-300">
              <Star className="h-3 w-3" /> +{formatCount(row.starsGained)}
            </span>
          )}
        </div>
      </div>
      <CloneButton input={{ fullName: row.fullName, cloneUrl: row.cloneUrl, name: row.name }} />
    </div>
  );
}

function InlineStarToggle({
  fullName,
  baseCount,
  cloneUrl,
  name,
  id,
}: {
  fullName: string;
  baseCount: number;
  cloneUrl?: string;
  name?: string;
  id?: number;
}) {
  const { stars } = useGithubState();
  const starred = stars.data.some((r) => r.fullName === fullName);
  const [busy, setBusy] = useState(false);
  // GitHub's displayed count shifts by ±1 relative to the server value while
  // the optimistic toggle is in flight — mirror that locally.
  return (
    <button
      type="button"
      disabled={busy}
      onClick={async (e) => {
        e.stopPropagation();
        setBusy(true);
        try {
          await toggleStar({ fullName, cloneUrl, name, id });
        } catch (err) {
          alert((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
      title={starred ? 'Unstar' : 'Star'}
      className={cn(
        'inline-flex items-center gap-1 tabular-nums transition-colors',
        starred ? 'text-amber-300' : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {busy ? (
        <Loader2 className="h-3 w-3 animate-spin" />
      ) : (
        <Star className={cn('h-3 w-3', starred && 'fill-amber-300')} />
      )}
      {formatCount(baseCount)}
    </button>
  );
}

function CloneButton({
  input,
}: {
  input: { fullName?: string; cloneUrl?: string; name?: string };
}) {
  const { openWorkspace } = useApp();
  const [state, setState] = useState<'idle' | 'cloning' | 'done' | 'error'>('idle');
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (state === 'done' && workspaceId) {
    return (
      <Button
        size="sm"
        variant="outline"
        onClick={() => openWorkspace(workspaceId)}
      >
        Open
      </Button>
    );
  }

  return (
    <Button
      size="sm"
      variant="outline"
      title={error ?? undefined}
      disabled={state === 'cloning'}
      onClick={async () => {
        setState('cloning');
        setError(null);
        try {
          const result = await aceApi.github.cloneRepo(input);
          setWorkspaceId(result.id);
          setState('done');
        } catch (e) {
          setError((e as Error).message);
          setState('error');
          alert((e as Error).message);
        }
      }}
    >
      {state === 'cloning' ? (
        <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
      ) : state === 'done' ? (
        <Check className="mr-1.5 h-3.5 w-3.5" />
      ) : (
        <Download className="mr-1.5 h-3.5 w-3.5" />
      )}
      {state === 'cloning' ? 'Cloning' : state === 'error' ? 'Retry' : 'Clone'}
    </Button>
  );
}

function SkeletonList() {
  return (
    <div className="flex flex-col gap-1">
      {Array.from({ length: 6 }).map((_, i) => (
        <div
          key={i}
          className="h-12 animate-pulse rounded-lg bg-white/[0.03]"
          style={{ animationDelay: `${i * 80}ms` }}
        />
      ))}
    </div>
  );
}

function EmptyRow({ message }: { message: string }) {
  return (
    <div className="rounded-xl border border-dashed border-white/[0.08] px-6 py-10 text-center text-sm text-muted-foreground">
      {message}
    </div>
  );
}

function ErrorRow({ error }: { error: string }) {
  return (
    <div className="rounded-xl border border-rose-500/25 bg-rose-500/[0.06] px-4 py-3 text-sm text-rose-200">
      {error}
    </div>
  );
}

// ── utils ─────────────────────────────────────────────────────────────────

function formatCount(n: number) {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

function relativeTime(ms: number) {
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'just now';
  const m = Math.floor(diff / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  return `${mo}mo ago`;
}
