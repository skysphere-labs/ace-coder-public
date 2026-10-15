import { useEffect } from 'react';
import { aceApi } from '../lib/ace-api';
import type { GithubAccount, GithubRepo, GithubTrendingRow } from '../lib/ace-api';
import { createSnapshotStore, useStoreValue } from './create-snapshot-store';

type Availability = { installed: boolean; version?: string } | null;

type TrendingPayload = {
  at: number;
  data: GithubTrendingRow[];
  error?: string | null;
} | null;

type GithubState = {
  availability: Availability;
  accounts: GithubAccount[];
  repos: { data: GithubRepo[]; loading: boolean; error: string | null };
  stars: { data: GithubRepo[]; loading: boolean; error: string | null };
  trending: { data: TrendingPayload; loading: boolean; error: string | null };
};

const initialState: GithubState = {
  availability: null,
  accounts: [],
  repos: { data: [], loading: false, error: null },
  stars: { data: [], loading: false, error: null },
  trending: { data: null, loading: false, error: null },
};

const store = createSnapshotStore<GithubState>(initialState);

let bootstrapped = false;

export function useGithubState() {
  useEffect(() => {
    if (!bootstrapped) {
      bootstrapped = true;
      void bootstrap();
    }
  }, []);
  return useStoreValue(store);
}

async function bootstrap() {
  const availability = await aceApi.github.isAvailable().catch(() => ({ installed: false }));
  store.setSnapshot((s) => ({ ...s, availability }));
  if (!availability.installed) return;
  await refreshAccounts();
  // Prime the stars list so star/unstar buttons on other tabs know which
  // repos are already starred without needing a per-row fetch.
  const { accounts } = store.getSnapshot();
  if (accounts.length > 0) void loadStars();
}

export async function refreshAccounts() {
  try {
    const accounts = await aceApi.github.listAccounts({ force: true });
    store.setSnapshot((s) => ({ ...s, accounts }));
    return true;
  } catch {
    store.setSnapshot((s) => ({ ...s, accounts: [] }));
    return false;
  }
}

export async function recheckAvailability() {
  const availability = await aceApi.github.refreshAvailability().catch(() => ({
    installed: false,
  }));
  store.setSnapshot((s) => ({ ...s, availability }));
  if (availability.installed) await refreshAccounts();
}

export async function switchActiveAccount(login: string) {
  const accounts = await aceApi.github.switchAccount(login);
  store.setSnapshot((s) => ({
    ...s,
    accounts,
    repos: { data: [], loading: false, error: null },
    stars: { data: [], loading: false, error: null },
  }));
  // Refresh stars for the newly active account so StarButton state is
  // correct everywhere (Repos / Stars / Trending all read `stars.data`).
  void loadStars();
}

export async function signOutAccount(login: string) {
  const accounts = await aceApi.github.removeAccount(login);
  store.setSnapshot((s) => ({ ...s, accounts }));
}

export async function loadRepos() {
  store.setSnapshot((s) => ({ ...s, repos: { ...s.repos, loading: true, error: null } }));
  try {
    const data = await aceApi.github.listRepos();
    store.setSnapshot((s) => ({ ...s, repos: { data, loading: false, error: null } }));
  } catch (err) {
    store.setSnapshot((s) => ({
      ...s,
      repos: { data: [], loading: false, error: (err as Error).message },
    }));
  }
}

export async function loadStars() {
  store.setSnapshot((s) => ({ ...s, stars: { ...s.stars, loading: true, error: null } }));
  try {
    const data = await aceApi.github.listStars();
    store.setSnapshot((s) => ({ ...s, stars: { data, loading: false, error: null } }));
  } catch (err) {
    store.setSnapshot((s) => ({
      ...s,
      stars: { data: [], loading: false, error: (err as Error).message },
    }));
  }
}

// Optimistically toggle the starred state, then reconcile with the server.
// The Stars tab, Repos tab, and Trending all read from `stars.data` (as a
// Set of fullNames) to know whether a repo is already starred.
export async function toggleStar(repo: { fullName: string; cloneUrl?: string; name?: string; id?: number }) {
  const snapshot = store.getSnapshot();
  const existing = snapshot.stars.data.find((r) => r.fullName === repo.fullName);
  const nextStarred = !existing;

  // Build a minimal GithubRepo for the optimistic insert. Fields we don't
  // know yet are filled with sensible defaults — the next loadStars() call
  // replaces the row with the canonical payload from GitHub.
  const optimistic = existing ?? {
    id: repo.id ?? Math.floor(Math.random() * 1_000_000_000),
    name: repo.name ?? repo.fullName.split('/').pop() ?? repo.fullName,
    fullName: repo.fullName,
    owner: repo.fullName.split('/')[0] ?? '',
    ownerAvatarUrl: null,
    description: null,
    private: false,
    fork: false,
    htmlUrl: `https://github.com/${repo.fullName}`,
    cloneUrl: repo.cloneUrl ?? `https://github.com/${repo.fullName}.git`,
    sshUrl: `git@github.com:${repo.fullName}.git`,
    defaultBranch: 'main',
    stars: 0,
    language: null,
    pushedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastCommit: null,
  };

  store.setSnapshot((s) => ({
    ...s,
    stars: {
      ...s.stars,
      data: nextStarred
        ? [optimistic, ...s.stars.data]
        : s.stars.data.filter((r) => r.fullName !== repo.fullName),
    },
  }));

  try {
    if (nextStarred) await aceApi.github.starRepo({ fullName: repo.fullName });
    else await aceApi.github.unstarRepo({ fullName: repo.fullName });
  } catch (err) {
    // Roll back on failure.
    store.setSnapshot((s) => ({
      ...s,
      stars: {
        ...s.stars,
        data: nextStarred
          ? s.stars.data.filter((r) => r.fullName !== repo.fullName)
          : existing
            ? [existing, ...s.stars.data]
            : s.stars.data,
        error: (err as Error).message,
      },
    }));
    throw err;
  }
}

export async function loadTrending(opts: {
  since?: 'daily' | 'weekly' | 'monthly';
  language?: string | null;
}) {
  store.setSnapshot((s) => ({
    ...s,
    trending: { ...s.trending, loading: true, error: null },
  }));
  try {
    const result = await aceApi.github.listTrending(opts);
    store.setSnapshot((s) => ({
      ...s,
      trending: { data: result, loading: false, error: result.error ?? null },
    }));
  } catch (err) {
    store.setSnapshot((s) => ({
      ...s,
      trending: { data: null, loading: false, error: (err as Error).message },
    }));
  }
}
