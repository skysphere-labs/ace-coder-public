const fs = require('fs');
const fsp = require('fs').promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');

function sha256(text: any) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

const LINK_WINDOW_MS = 60_000;
const JSON_META_PREFIX_BYTES = 64 * 1024;

function expandTilde(p: any) {
  if (!p) return p;
  if (p.startsWith('~')) return path.join(os.homedir(), p.slice(1));
  return p;
}

function rootFromGlob(glob: any) {
  // Strip the first wildcard-bearing segment; the dirwatch lives on the
  // closest static ancestor.
  const expanded = expandTilde(glob);
  const parts = expanded.split(path.sep);
  const staticParts = [];
  for (const part of parts) {
    if (part.includes('*') || part.includes('?')) break;
    staticParts.push(part);
  }
  return staticParts.join(path.sep) || '/';
}

function hasGlobMagic(part: any) {
  return String(part || '').includes('*') || String(part || '').includes('?');
}

async function rootsFromGlob(glob: any) {
  const expanded = expandTilde(glob);
  const dirPattern = path.dirname(expanded);
  const parts = dirPattern.split(path.sep);
  const firstWildcard = parts.findIndex(hasGlobMagic);
  if (firstWildcard < 0) return [dirPattern];
  const hasStaticSuffix = parts.slice(firstWildcard + 1).some((part: any) => !hasGlobMagic(part));
  if (!hasStaticSuffix) return [rootFromGlob(glob)];
  const base = parts.slice(0, firstWildcard).join(path.sep) || '/';
  const patternParts = parts.slice(firstWildcard);
  async function expand(baseDir: any, index: any): Promise<any[]> {
    if (index >= patternParts.length) return [baseDir];
    const part = patternParts[index];
    if (!hasGlobMagic(part)) {
      const next = path.join(baseDir, part);
      try {
        const stat = await fsp.stat(next);
        if (!stat.isDirectory()) return [];
      } catch {
        return [];
      }
      return expand(next, index + 1);
    }
    let entries;
    try {
      entries = await fsp.readdir(baseDir, { withFileTypes: true });
    } catch {
      return [];
    }
    const rx = globToRegex(part);
    const out: any[] = [];
    for (const ent of entries) {
      if (!ent.isDirectory() || !rx.test(ent.name)) continue;
      out.push(...await expand(path.join(baseDir, ent.name), index + 1));
    }
    return out;
  }
  return expand(base, 0);
}

function matchGlob(glob: any, candidatePath: any) {
  const rx = globToRegex(expandTilde(glob));
  return rx.test(candidatePath);
}

function globToRegex(pattern: any) {
  let rx = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        rx += '.*';
        i++;
      } else {
        rx += '[^/]*';
      }
    } else if (c === '?') {
      rx += '.';
    } else if ('.+^$(){}|[]\\'.includes(c)) {
      rx += '\\' + c;
    } else {
      rx += c;
    }
  }
  return new RegExp('^' + rx + '$');
}

// Recursively walk the glob root, returning entries that match the glob.
// Bounded: the watcher only sees files new since spawnedAt anyway.
async function walkRoot(root: any, glob: any) {
  const out: any[] = [];
  async function visit(dir: any) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        await visit(full);
      } else if (ent.isFile() && matchGlob(glob, full)) {
        out.push(full);
      }
    }
  }
  await visit(root);
  return out;
}

function toMs(value: any) {
  if (!value) return 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

function parseJsonStringLiteral(raw: any) {
  try {
    return JSON.parse(`"${raw}"`);
  } catch {
    return String(raw || '');
  }
}

function jsonPrefixField(raw: any, keys: any) {
  for (const key of keys) {
    const escaped = String(key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp(`"${escaped}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`).exec(raw);
    if (match) return parseJsonStringLiteral(match[1]);
  }
  return null;
}

function sessionIdFromRewriteFilename(filePath: any) {
  const name = path.basename(filePath, path.extname(filePath));
  return name.replace(/^session[_-]/, '') || null;
}

async function readJsonRewriteMetaPrefix(filePath: any) {
  const fh = await fsp.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(JSON_META_PREFIX_BYTES);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const raw = buf.slice(0, bytesRead).toString('utf8');
    return {
      sessionId: jsonPrefixField(raw, ['sessionId', 'session_id']),
      cwd: jsonPrefixField(raw, ['cwd']),
      projectHash: jsonPrefixField(raw, ['projectHash']),
      activityAtMs: toMs(jsonPrefixField(raw, ['last_updated', 'lastUpdated', 'updatedAt'])),
      sessionStartedAtMs: toMs(jsonPrefixField(raw, ['session_start', 'sessionStart'])),
    };
  } finally {
    await fh.close();
  }
}

function sessionIdStartedAtMs(sessionId: any) {
  const m = /^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/.exec(String(sessionId || ''));
  if (!m) return 0;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
}

function candidateActivityAtMs(candidate: any) {
  return candidate.meta.activityAtMs || candidate.stat.mtimeMs || 0;
}

function candidateStartedAtMs(candidate: any) {
  return candidate.meta.sessionStartedAtMs || sessionIdStartedAtMs(candidate.meta.sessionId) || 0;
}

function compareMostRecentCandidate(a: any, b: any) {
  const byActivity = candidateActivityAtMs(b) - candidateActivityAtMs(a);
  if (byActivity) return byActivity;
  const byStartedAt = candidateStartedAtMs(b) - candidateStartedAtMs(a);
  if (byStartedAt) return byStartedAt;
  return a.filePath.localeCompare(b.filePath);
}

function createLinker({
  profiles,
  onLink,
  onWarning,
  isCurrentLink,
  resolveExpectedSessionId,
  canSwitchSession,
  resolveSelectedSessionId,
}: any) {
  // Per-agent watcher + pending-tab queue.
  // agentRoots: agent -> { glob, root, watcher?, pending: Set<tab>, knownFiles: Set<path> }
  const byAgent = new Map();

  function profileTranscript(agentId: any) {
    for (const p of profiles) {
      if (p.detect?.agent === agentId && p.transcript) return p.transcript;
    }
    return null;
  }

  async function registerAgent(agentId: any) {
    if (byAgent.has(agentId)) return byAgent.get(agentId);
    const transcript = profileTranscript(agentId);
    if (!transcript) return null;
    const glob = transcript.sessionGlob;
    if (!glob) return null;
    const root = rootFromGlob(glob);
    try {
      await fsp.mkdir(root, { recursive: true });
    } catch {}
    const state: any = {
      agent: agentId,
      transcript,
      glob,
      root,
      roots: new Set(),
      pending: new Set(),
      knownFiles: new Set(),
      watchers: new Map(),
    };
    await refreshRoots(state);
    byAgent.set(agentId, state);
    return state;
  }

  async function refreshRoots(state: any) {
    const roots = await rootsFromGlob(state.glob);
    if (!roots.includes(state.root)) {
      watchRoot(state, state.root, false);
    }
    for (const root of roots) {
      if (state.roots.has(root)) continue;
      state.roots.add(root);
      try {
        const initial = await walkRoot(root, state.glob);
        for (const f of initial) state.knownFiles.add(f);
      } catch {}
      watchRoot(state, root, root === state.root);
    }
  }

  function watchRoot(state: any, root: any, recursive: any) {
    if (state.watchers.has(root)) return;
    try {
      const watcher = fs.watch(root, { recursive, persistent: false }, (_evt: any, filename: any) => {
        onAgentWatchTick(state, filename).catch((err: any) => {
          if (onWarning) onWarning({ agent: state.agent, code: 'linker:watch', error: err.message });
        });
      });
      state.watchers.set(root, watcher);
    } catch (err: any) {
      if (onWarning) onWarning({ agent: state.agent, code: 'linker:watch-init', root, error: err.message });
    }
  }

  async function onAgentWatchTick(state: any, _filename: any) {
    if (state.pending.size === 0) return;
    await refreshRoots(state);
    const fresh: any[] = [];
    for (const root of state.roots) {
      fresh.push(...await walkRoot(root, state.glob));
    }
    for (const f of fresh) {
      if (state.knownFiles.has(f)) {
        // Existing file with a later mtime — interesting only if a pending
        // tab is resume-linked. Keep the fallthrough below simple: pull the
        // mtime and try match if it's newer than spawnedAt.
      } else {
        state.knownFiles.add(f);
      }
    }
    await tryMatch(state, fresh);
  }

  async function tryMatch(state: any, filePaths: any) {
    if (state.pending.size === 0) return;
    const matchCwd = state.transcript.matchByCwdField;
    const matchHash = state.transcript.projectHashField;
    // Hermes identity lanes (Rook/King) share the `hermes` agent across
    // workspaces, so we discriminate on the per-workspace HERMES_HOME
    // path segment (`hermes-home-${workspaceId}`) baked into every session
    // file path. Without this, two pending Hermes streams would race for
    // the first matching file and Rook could claim King's session.
    const matchWorkspaceHome = state.transcript.matchByWorkspaceHome === true;
    // Per-profile expiry: Hermes/Rook lanes can legitimately take well past
    // the default 60s before their first session file write (boot + skill load).
    const linkWindowMs = state.transcript.linkWindowMs || LINK_WINDOW_MS;
    const paths = Array.isArray(filePaths) ? filePaths : [filePaths];
    const allowExisting = state.transcript.allowExistingSessionFiles === true;
    const preferActiveSession = allowExisting && matchWorkspaceHome;
    const activeTabs = Array.from(state.pending as Set<any>).filter((tab: any) => {
      if (Date.now() - tab.spawnedAt <= linkWindowMs) return true;
      return preferActiveSession && tab.linked === true;
    });
    const hasConfirmedSwitch = activeTabs.some((tab: any) => tab.allowSessionSwitch && tab.sessionSwitchConfirmed);
    const workspaceIds = matchWorkspaceHome
      ? new Set(activeTabs.map((tab: any) => tab.workspaceId).filter(Boolean))
      : null;
    const candidatePaths = workspaceIds
      ? paths.filter((filePath: any) => Array.from(workspaceIds).some((id: any) => filePath.includes(`hermes-home-${id}`)))
      : paths;
    // Cheap prefilter: when existing files can't link anyway (the default),
    // skip the content probe for anything older than the earliest pending
    // spawn. Session roots like ~/.codex/sessions accumulate thousands of
    // files; without this every watch tick re-reads all of them.
    const minSpawnedAt = activeTabs.length
      ? Math.min(...activeTabs.map((tab: any) => tab.spawnedAt))
      : Date.now();
    const candidates: any[] = [];
    for (const filePath of candidatePaths) {
      let stat;
      try {
        stat = await fsp.stat(filePath);
      } catch {
        continue;
      }
      if (!allowExisting && !hasConfirmedSwitch && stat.mtimeMs < minSpawnedAt - 1000) continue;
      const meta = await readMeta(state, filePath).catch(() => null);
      if (!meta) continue;
      candidates.push({ filePath, stat, meta });
    }
    if (candidates.length === 0) return;
    // Opt-in: allow linking files that already exist (mtime older than
    // spawnedAt). Hermes identity lanes (Rook/King) keep one rolling
    // `session_*.json` per workspace and rewrite it across app restarts;
    // without this we'd reject the live session forever after a renderer
    // reload because the file's mtime predates the new tab registration.
    // Codex/Gemini keep the default guard so they don't cross-link to a
    // stale session file from a prior unrelated run.
    if (preferActiveSession) candidates.sort(compareMostRecentCandidate);
    for (const tab of Array.from(state.pending) as any[]) {
      const expired = Date.now() - tab.spawnedAt > linkWindowMs;
      if (expired && !(preferActiveSession && tab.linked === true)) {
        state.pending.delete(tab);
        continue;
      }
      const selectedSessionId = tab.allowSessionSwitch && tab.sessionSwitchConfirmed && typeof resolveSelectedSessionId === 'function'
        ? resolveSelectedSessionId(tab.streamId, state.agent)
        : null;
      for (const candidate of candidates) {
        const { filePath, stat, meta } = candidate;
        if (!allowExisting && !tab.sessionSwitchConfirmed && stat.mtimeMs < tab.spawnedAt - 1000) continue;
        let sessionSwitch = false;
        if (state.transcript.matchBySessionId === true) {
          // Deterministic claim: Ace mints the CLI session id at spawn
          // (claude --session-id <uuid>) and the CLI names its session file
          // after it, so the owner row already knows exactly which file is
          // ours. Resolve at match time — the id is written to the DB just
          // after spawn, so a pending entry captured too early would
          // otherwise never match. No fallback: with an unknown id we leave
          // the chat dark rather than claim another tab's session file.
          const want =
            typeof resolveExpectedSessionId === 'function'
              ? resolveExpectedSessionId(tab.streamId, state.agent)
              : null;
          if (!want || want === 'seen' || want === 'live') continue;
          if (String(meta.sessionId) === String(want)) {
            // Ignore the old id while armed because /resume may touch it before the selected file.
            if (tab.allowSessionSwitch) continue;
          } else {
            if (!tab.allowSessionSwitch || !tab.sessionSwitchConfirmed || !tab.sessionDir) continue;
            if (path.resolve(path.dirname(filePath)) !== path.resolve(tab.sessionDir)) continue;
            if (!selectedSessionId || String(meta.sessionId) !== String(selectedSessionId)) continue;
            if (
              typeof canSwitchSession === 'function' &&
              canSwitchSession(tab.streamId, meta.sessionId) === false
            ) continue;
            sessionSwitch = true;
          }
        }
        if (matchWorkspaceHome) {
          // No fallback: if we don't know the workspace, refuse to link a
          // shared-agent file. Better to leave native chat dark than to
          // cross-link Rook into King's transcript.
          if (!tab.workspaceId) continue;
          if (!filePath.includes(`hermes-home-${tab.workspaceId}`)) continue;
        }
        if (matchCwd) {
          if (!meta.cwd || !tab.cwd) continue;
          if (path.resolve(meta.cwd) !== path.resolve(tab.cwd)) continue;
        } else if (matchHash) {
          // Gemini doesn't record cwd in its session file, but it hashes the
          // cwd into `projectHash` (sha256 of the absolute path as-is). We
          // mirror that hash on the tab side so two simultaneous Gemini tabs
          // for different workspaces don't cross-link. Without this, the
          // first-pending, first-served fallback could assign the wrong
          // history to either tab.
          if (!tab.cwd) continue;
          const tabHash = sha256(path.resolve(tab.cwd));
          if (tabHash !== meta.projectHash) continue;
        }
        // Re-pending (e.g. after /clear) skips the stream's existing link so
        // we claim the NEW session file, not the old one whose mtime may still
        // be within the grace window from its last write.
        if (isCurrentLink && isCurrentLink(tab.streamId, filePath)) {
          if (preferActiveSession) {
            const activityAtMs = candidateActivityAtMs(candidate);
            if (tab.currentLinkActivityAtMs && activityAtMs <= tab.currentLinkActivityAtMs) break;
            tab.linked = true;
            tab.spawnedAt = Date.now();
            tab.currentLinkActivityAtMs = activityAtMs;
            onLink({
              streamId: tab.streamId,
              agent: state.agent,
              sessionId: meta.sessionId,
              sessionFile: filePath,
              cwd: meta.cwd || tab.cwd || null,
              byteOffset: 0,
            });
            return;
          }
          continue;
        }
        const linked = onLink({
          streamId: tab.streamId,
          agent: state.agent,
          sessionId: meta.sessionId,
          sessionFile: filePath,
          cwd: meta.cwd || tab.cwd || null,
          byteOffset: 0,
          sessionSwitch,
        });
        if (linked === false) return;
        if (preferActiveSession) {
          tab.linked = true;
          tab.spawnedAt = Date.now();
          tab.currentLinkActivityAtMs = candidateActivityAtMs(candidate);
        } else {
          state.pending.delete(tab);
        }
        return;
      }
    }
  }

  async function readMeta(state: any, filePath: any) {
    if (state.transcript.kind === 'jsonl-append') {
      // Hermes' JSONL first line is a plain chat record (role/content/
      // timestamp) — no payload.id/cwd. When the profile sets
      // `sessionIdFrom: "filename"`, derive sessionId from the file's
      // basename and skip the payload probe entirely; the file's mere
      // existence is enough to link. Codex keeps the original probe.
      if (state.transcript.sessionIdFrom === 'filename') {
        const sessionId = path.basename(filePath, path.extname(filePath));
        if (!sessionId) return null;
        return { sessionId, cwd: null };
      }
      // Read only the first line.
      const fh = await fsp.open(filePath, 'r');
      try {
        const buf = Buffer.alloc(32 * 1024);
        const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
        const chunk = buf.slice(0, bytesRead).toString('utf8');
        const nl = chunk.indexOf('\n');
        if (nl < 0) return null;
        const first = JSON.parse(chunk.slice(0, nl));
        const sessionId = first?.payload?.id || null;
        const cwd = first?.payload?.cwd || null;
        if (!sessionId) return null;
        return { sessionId, cwd };
      } finally {
        await fh.close();
      }
    }
    if (state.transcript.kind === 'json-rewrite') {
      if (state.transcript.matchByWorkspaceHome === true) {
        const meta = await readJsonRewriteMetaPrefix(filePath).catch(() => null);
        const sessionId = meta?.sessionId || sessionIdFromRewriteFilename(filePath);
        if (!sessionId) return null;
        return { ...meta, sessionId };
      }
      const raw = await fsp.readFile(filePath, 'utf8').catch(() => null);
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw);
        // Hermes uses snake_case `session_id`; Gemini uses `sessionId`.
        // Accept both so the linker is agnostic to the on-disk casing.
        const sessionId = parsed.sessionId || parsed.session_id || null;
        if (!sessionId) return null;
        return {
          sessionId,
          cwd: parsed.cwd || null,
          projectHash: parsed.projectHash || null,
          activityAtMs: toMs(parsed.last_updated || parsed.lastUpdated || parsed.updatedAt),
          sessionStartedAtMs: toMs(parsed.session_start || parsed.sessionStart),
        };
      } catch {
        return null;
      }
    }
    return null;
  }

  async function pending(
    streamId: any,
    {
      agent,
      cwd,
      workspaceId,
      spawnedAt,
      linked,
      allowSessionSwitch,
      sessionDir,
      deferInitialMatch,
    }: any
  ) {
    const state = await registerAgent(agent);
    if (!state) return { ok: false, reason: 'no-profile' };
    // A stream is "pending" for the lifetime of the tab, not just until the
    // first link. Re-enqueuing replaces the prior entry so we always track
    // the latest spawnedAt (post-restart, post-/clear) — otherwise a stale
    // spawnedAt would reject the new session file as "too old".
    let prior: any = null;
    for (const existing of Array.from(state.pending) as any[]) {
      if (existing.streamId === streamId) {
        prior = existing;
        state.pending.delete(existing);
      }
    }
    state.pending.add({
      streamId,
      cwd: cwd || null,
      workspaceId: workspaceId || null,
      spawnedAt: spawnedAt || Date.now(),
      linked: linked === true,
      currentLinkActivityAtMs: prior?.currentLinkActivityAtMs || 0,
      allowSessionSwitch: allowSessionSwitch === true,
      sessionSwitchConfirmed: false,
      sessionDir: sessionDir || null,
    });
    // Opportunistic pass in case the file was written just before the watcher
    // got online, or the tab registered after the write.
    if (deferInitialMatch !== true) await onAgentWatchTick(state, null);
    return { ok: true };
  }

  async function confirmSessionSwitch(streamId: any) {
    for (const state of byAgent.values()) {
      for (const tab of Array.from(state.pending) as any[]) {
        if (tab.streamId !== streamId || !tab.allowSessionSwitch) continue;
        tab.sessionSwitchConfirmed = true;
        await onAgentWatchTick(state, null);
        return { ok: true };
      }
    }
    return { ok: false, reason: 'not-armed' };
  }

  function isSessionSwitchArmed(streamId: any) {
    for (const state of byAgent.values()) {
      for (const tab of Array.from(state.pending) as any[]) {
        if (tab.streamId === streamId && tab.allowSessionSwitch) return true;
      }
    }
    return false;
  }

  function cancel(streamId: any) {
    for (const state of byAgent.values()) {
      for (const tab of Array.from(state.pending) as any[]) {
        if (tab.streamId === streamId) state.pending.delete(tab);
      }
    }
  }

  // Resume path: the caller already knows the sessionId and file; skip the
  // dir walk entirely.
  function linkExisting(streamId: any, { agent, sessionFile, sessionId, cwd, byteOffset }: any) {
    onLink({ streamId, agent, sessionId, sessionFile, cwd: cwd || null, byteOffset: byteOffset || 0 });
  }

  function shutdown() {
    for (const state of byAgent.values()) {
      for (const watcher of state.watchers?.values?.() || []) {
        try { watcher?.close(); } catch {}
      }
    }
    byAgent.clear();
  }

  return {
    pending,
    cancel,
    confirmSessionSwitch,
    isSessionSwitchArmed,
    linkExisting,
    shutdown,
    _registerAgent: registerAgent,
  };
}

module.exports = { createLinker, matchGlob, rootFromGlob, rootsFromGlob, expandTilde, sha256 };
