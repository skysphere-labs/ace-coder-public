// usage-events — event-driven freshness for the provider usage meters.
//
// Watches the OFFICIAL usage sources on disk — the Claude statusline tap
// cache directory (~/.ace/usage, written tmp+rename by the tap script) and
// the Codex session JSONL tree (~/.codex/sessions) — and on change
// invalidates the usage-core cache, re-scans (serialized), and publishes one
// typed `usage:changed` report to every subscriber. main.cts fans the report
// out to renderer windows (ace:usage-changed) and remote-server.cts to
// websocket clients, so meters update within a debounce of the source write
// instead of on a 30-second poll. A slow fallback rescan remains for dropped
// events and watcher-less states; percentages stay provider-reported.
//
// Watcher lifecycle follows git-watcher.cts: injected deps for tests, bursts
// coalesced through one trailing debounce, overlapping scans serialized with
// a dirty flag, and a re-arm loop that survives deleted/renamed/missing
// directories (fs.watch handles die with their inode).

const fs = require('fs');
const path = require('path');
const os = require('os');
const usageCore = require('./usage-core.cts');
const statuslineTap = require('./usage-statusline-tap.cts');

const DEFAULT_DEBOUNCE_MS = 250;
const DEFAULT_FALLBACK_MS = 60_000;

function defaultWatchTargets() {
  return [
    {
      id: 'claude-tap',
      dir: statuslineTap.tapPaths().usageDir,
      recursive: false,
      match: (name: any) => /^claude-.*\.json$/.test(name),
    },
    {
      id: 'codex-sessions',
      dir: path.join(os.homedir(), '.codex', 'sessions'),
      recursive: true,
      match: (name: any) => name.endsWith('.jsonl'),
    },
  ];
}

function createUsageEvents({
  targets = defaultWatchTargets(),
  scan = usageCore.getProviderUsage,
  isEnabled = usageCore.isProviderUsageEnabled,
  invalidate = usageCore.invalidateUsageCache,
  debounceMs = DEFAULT_DEBOUNCE_MS,
  fallbackMs = DEFAULT_FALLBACK_MS,
  fsImpl = fs,
}: any = {}) {
  const subscribers = new Set<any>();
  const watchers = new Map<string, any>(); // target.id -> fs.FSWatcher
  // Fixed for the life of the feed: the claude statusline tap dir and the codex
  // sessions tree.
  const watchTargets = [...targets];
  let debounceTimer: any = null;
  let fallbackTimer: any = null;
  let pumping = false;
  let dirty = false;
  let started = false;

  function emit(report: any) {
    for (const cb of subscribers) {
      try { cb(report); } catch { /* one bad sink must not break the rest */ }
    }
  }

  // Serialized scan: bursts landing mid-scan set `dirty` and trigger exactly
  // one follow-up scan, so overlapping source writes can never interleave
  // scans or drop the freshest data.
  async function pump() {
    if (!isEnabled()) {
      stop();
      emit(usageCore.disabledProviderUsage());
      return;
    }
    if (pumping) { dirty = true; return; }
    pumping = true;
    try {
      do {
        dirty = false;
        invalidate();
        const report = await scan();
        // stop() may have landed while the scan was in flight: a stopped
        // pipeline must neither broadcast nor run the dirty follow-up.
        if (!started) return;
        emit(report);
      } while (dirty);
    } catch { /* scan failures degrade to the next tick, never throw upward */ }
    finally { pumping = false; }
  }

  function schedule() {
    if (!started) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void pump();
    }, debounceMs);
  }

  function disarm(id: any) {
    const armed = watchers.get(id);
    if (!armed) return;
    try { armed.watcher.close(); } catch {}
    watchers.delete(id);
  }

  // (Re)establish the fs.watch for every target whose directory exists. A
  // missing directory (e.g. ~/.ace/usage before the first tap write) stays
  // unarmed and is retried on every fallback tick — the same tick that also
  // covers dropped events, so recovery needs no extra machinery. fs.watch
  // binds to the INODE and goes silent (no error event on macOS) when the
  // directory is deleted or replaced, so each pass first drops handles whose
  // directory is gone or is a different inode than the one armed against.
  function armWatchers() {
    if (!isEnabled()) { stop(); return; }
    for (const target of watchTargets) {
      const armed = watchers.get(target.id);
      let stat = null;
      try { stat = fsImpl.statSync(target.dir); } catch { /* missing */ }
      const dirOk = !!stat && stat.isDirectory();
      if (armed) {
        if (dirOk && stat.ino === armed.ino) continue; // still watching the live inode
        disarm(target.id);
      }
      if (!dirOk) continue;
      let watcher;
      try {
        watcher = fsImpl.watch(
          target.dir,
          { recursive: !!target.recursive, persistent: false },
          (_event: any, filename: any) => {
            // A null filename is a platform "something changed" — treat as a hit.
            const name = filename == null ? null : path.basename(String(filename));
            if (name !== null && typeof target.match === 'function' && !target.match(name)) return;
            schedule();
          }
        );
      } catch { continue; }
      watcher.on('error', () => {
        // The watched inode went away (dir deleted/renamed). Drop the handle;
        // the fallback tick re-arms once the directory exists again.
        disarm(target.id);
      });
      watchers.set(target.id, { watcher, ino: stat.ino });
    }
  }

  function start() {
    if (started) return;
    if (!isEnabled()) { emit(usageCore.disabledProviderUsage()); return; }
    started = true;
    armWatchers();
    if (fallbackMs > 0) {
      fallbackTimer = setInterval(() => {
        armWatchers();
        void pump();
      }, fallbackMs);
      if (typeof fallbackTimer.unref === 'function') fallbackTimer.unref();
    }
    void pump(); // publish an initial report so late subscribers aren't blank
  }

  function stop() {
    started = false;
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    if (fallbackTimer) { clearInterval(fallbackTimer); fallbackTimer = null; }
    for (const id of [...watchers.keys()]) disarm(id);
  }

  function subscribe(cb: any) {
    subscribers.add(cb);
    return () => { subscribers.delete(cb); };
  }

  return {
    start,
    stop,
    subscribe,
    schedule,
    pump,
    // exposed for tests
    _watcherCount: () => watchers.size,
  };
}

// Process-wide singleton: main.cts starts it; remote-server.cts subscribes to
// the same instance, so both sinks see the identical report object.
let singleton: any = null;

function usageEvents() {
  if (!singleton) singleton = createUsageEvents();
  return singleton;
}

function startUsageEvents() {
  usageEvents().start();
  return singleton;
}

function stopUsageEvents() {
  if (singleton) singleton.stop();
}

function subscribeUsageChanged(cb: any) {
  return usageEvents().subscribe(cb);
}

module.exports = {
  createUsageEvents,
  defaultWatchTargets,
  startUsageEvents,
  stopUsageEvents,
  subscribeUsageChanged,
};
