/**
 * ops-sources.cts
 *
 * Self-contained Sources/watchlist store for the Operations Command Center (W7).
 * Derives watchlist seeds from a latest.json report object and manages a
 * local editable config in the selected ACE_HOME profile.
 *
 * NO electron/store/IPC imports — only Node built-ins fs, os, path.
 * Zero hardcoded http(s) URLs or account ids.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// ---------------------------------------------------------------------------
// Default path (no literal home path — uses os.homedir() at runtime)
// ---------------------------------------------------------------------------

function defaultSourcesPath(): string {
  return path.join(process.env.ACE_HOME || path.join(os.homedir(), '.ace-coder'), 'ops-sources.json');
}

// ---------------------------------------------------------------------------
// Types (JSDoc-compatible shapes; no TS annotation syntax in exported surface)
// ---------------------------------------------------------------------------

/** Empty watchlists shape used as fallback throughout. */
function emptyWatchlists(): {
  feeds: string[];
  accounts: string[];
  repos: string[];
  changelogs: string[];
} {
  return { feeds: [], accounts: [], repos: [], changelogs: [] };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Deduplicate an array of strings, preserving insertion order. Never throws. */
function dedup(arr: string[]): string[] {
  try {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const item of arr) {
      const key = String(item);
      if (!seen.has(key)) {
        seen.add(key);
        result.push(key);
      }
    }
    return result;
  } catch {
    return [];
  }
}

/** Safely get a string array from an arbitrary value. Never throws. */
function safeStringArray(val: unknown): string[] {
  try {
    if (!Array.isArray(val)) return [];
    return val.map((item) => String(item ?? '')).filter((s) => s.length > 0);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// deriveWatchlists
// ---------------------------------------------------------------------------

/**
 * Derive watchlists from a latest.json report object.
 *
 * - accounts: dedup of report.platform_accounts[].handle (fallback .name / .label)
 * - feeds: dedup of report.official_feeds[].feed
 * - repos: dedup of report.github_watch[].repo
 * - changelogs: dedup of report.platform_changelogs[].vendor (fallback `${vendor} ${product}`)
 *
 * Null/missing report or null/missing fields -> empty arrays. Never throws.
 */
function deriveWatchlists(report: unknown): {
  feeds: string[];
  accounts: string[];
  repos: string[];
  changelogs: string[];
} {
  try {
    const r: any = report;
    if (!r || typeof r !== 'object') return emptyWatchlists();

    // accounts — platform_accounts[].handle, fallback .name / .label
    const accounts: string[] = [];
    if (Array.isArray(r.platform_accounts)) {
      for (const acct of r.platform_accounts) {
        try {
          const handle =
            (acct?.handle ?? acct?.name ?? acct?.label ?? '') as string;
          const v = String(handle).trim();
          if (v.length > 0) accounts.push(v);
        } catch {
          // skip malformed entry
        }
      }
    }

    // feeds — official_feeds[].feed
    const feeds: string[] = [];
    if (Array.isArray(r.official_feeds)) {
      for (const entry of r.official_feeds) {
        try {
          const v = String(entry?.feed ?? '').trim();
          if (v.length > 0) feeds.push(v);
        } catch {
          // skip
        }
      }
    }

    // repos — github_watch[].repo
    const repos: string[] = [];
    if (Array.isArray(r.github_watch)) {
      for (const entry of r.github_watch) {
        try {
          const v = String(entry?.repo ?? '').trim();
          if (v.length > 0) repos.push(v);
        } catch {
          // skip
        }
      }
    }

    // changelogs — platform_changelogs[].vendor (fallback `${vendor} ${product}`)
    const changelogs: string[] = [];
    if (Array.isArray(r.platform_changelogs)) {
      for (const entry of r.platform_changelogs) {
        try {
          const vendor = String(entry?.vendor ?? '').trim();
          const product = String(entry?.product ?? '').trim();
          const label = vendor.length > 0
            ? product.length > 0
              ? `${vendor} ${product}`
              : vendor
            : product;
          if (label.length > 0) changelogs.push(label);
        } catch {
          // skip
        }
      }
    }

    return {
      feeds: dedup(feeds),
      accounts: dedup(accounts),
      repos: dedup(repos),
      changelogs: dedup(changelogs),
    };
  } catch {
    return emptyWatchlists();
  }
}

// ---------------------------------------------------------------------------
// loadLocalSources
// ---------------------------------------------------------------------------

/**
 * Read local ops-sources.json.
 *
 * Missing or corrupt file returns the empty shape (never throws).
 * opts.filePath is injectable for tests.
 */
function loadLocalSources(opts?: { filePath?: string }): {
  watchlists: { feeds: string[]; accounts: string[]; repos: string[]; changelogs: string[] };
  editableAt: string | null;
} {
  const filePath: string = opts?.filePath ?? defaultSourcesPath();

  try {
    const raw: string = fs.readFileSync(filePath, 'utf-8');
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { watchlists: emptyWatchlists(), editableAt: null };
    }

    if (!parsed || typeof parsed !== 'object') {
      return { watchlists: emptyWatchlists(), editableAt: null };
    }

    const wl = parsed.watchlists;
    const watchlists = (wl && typeof wl === 'object')
      ? {
          feeds: safeStringArray(wl.feeds),
          accounts: safeStringArray(wl.accounts),
          repos: safeStringArray(wl.repos),
          changelogs: safeStringArray(wl.changelogs),
        }
      : emptyWatchlists();

    const editableAt: string | null =
      typeof parsed.editableAt === 'string' ? parsed.editableAt : null;

    return { watchlists, editableAt };
  } catch {
    return { watchlists: emptyWatchlists(), editableAt: null };
  }
}

// ---------------------------------------------------------------------------
// saveLocalSources
// ---------------------------------------------------------------------------

/**
 * Write watchlists to local ops-sources.json (mkdir -p as needed).
 *
 * FAIL-CLOSED: swallows write errors, never throws.
 * Returns the payload it attempted to write regardless of I/O success.
 *
 * opts.now ISO string overrides editableAt; opts.filePath is injectable for tests.
 */
function saveLocalSources(
  watchlists: { feeds: string[]; accounts: string[]; repos: string[]; changelogs: string[] },
  opts?: { filePath?: string; now?: string },
): {
  watchlists: { feeds: string[]; accounts: string[]; repos: string[]; changelogs: string[] };
  editableAt: string;
} {
  const filePath: string = opts?.filePath ?? defaultSourcesPath();
  const editableAt: string = opts?.now ?? new Date().toISOString();

  const payload = { watchlists, editableAt };

  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf-8');
  } catch {
    // FAIL-CLOSED: swallow write errors
  }

  return payload;
}

// ---------------------------------------------------------------------------
// mergeSources
// ---------------------------------------------------------------------------

/**
 * Merge derived (from latest.json) and local (from loadLocalSources) watchlists.
 *
 * - Union each list: derived entries first, then local-only extras, deduped.
 * - $schema: 'ace.ops.sources.v1'
 * - editableAt: from local.editableAt
 * - fromLatestJson: true if derived had any entries across all four lists
 */
function mergeSources(
  derived: { feeds: string[]; accounts: string[]; repos: string[]; changelogs: string[] },
  local: {
    watchlists: { feeds: string[]; accounts: string[]; repos: string[]; changelogs: string[] };
    editableAt: string | null;
  },
): {
  $schema: 'ace.ops.sources.v1';
  watchlists: { feeds: string[]; accounts: string[]; repos: string[]; changelogs: string[] };
  editableAt: string | null;
  fromLatestJson: boolean;
} {
  try {
    const dSafe = derived && typeof derived === 'object' ? derived : emptyWatchlists();
    const lSafe = (local?.watchlists && typeof local.watchlists === 'object')
      ? local.watchlists
      : emptyWatchlists();

    const mergeList = (d: string[], l: string[]): string[] =>
      dedup([...(Array.isArray(d) ? d : []), ...(Array.isArray(l) ? l : [])]);

    const watchlists = {
      feeds: mergeList(dSafe.feeds, lSafe.feeds),
      accounts: mergeList(dSafe.accounts, lSafe.accounts),
      repos: mergeList(dSafe.repos, lSafe.repos),
      changelogs: mergeList(dSafe.changelogs, lSafe.changelogs),
    };

    const fromLatestJson =
      (dSafe.feeds?.length ?? 0) > 0 ||
      (dSafe.accounts?.length ?? 0) > 0 ||
      (dSafe.repos?.length ?? 0) > 0 ||
      (dSafe.changelogs?.length ?? 0) > 0;

    return {
      $schema: 'ace.ops.sources.v1',
      watchlists,
      editableAt: local?.editableAt ?? null,
      fromLatestJson,
    };
  } catch {
    return {
      $schema: 'ace.ops.sources.v1',
      watchlists: emptyWatchlists(),
      editableAt: null,
      fromLatestJson: false,
    };
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { deriveWatchlists, loadLocalSources, saveLocalSources, mergeSources };
