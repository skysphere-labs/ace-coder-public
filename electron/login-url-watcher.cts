// login-url-watcher — detect OAuth/sign-in URLs that agent CLIs print to
// their PTY (claude /login, codex login, gemini auth, gh device flow) and
// open them in an in-app browser scratch tab.
//
// Why: the CLI opens the URL itself in the DESKTOP's default browser. When
// the owner drives Ace from a phone (remote PWA), that browser is unreachable
// — and the OAuth callback targets localhost on the desktop, so signing in on
// the phone's own browser can never complete. Detecting the printed URL and
// opening it in an Ace browser tab (hosted on the desktop, streamed to the
// phone) makes /login work from anywhere. The external browser may still
// open on the desktop; that is harmless and intentional.

const crypto = require('crypto');

// Curated auth endpoints only — prefix-matched after URL extraction. Generic
// "login"/"oauth" heuristics over-trigger on ordinary agent chatter.
const AUTH_URL_PATTERNS = [
  /^https:\/\/claude\.ai\/oauth\//i,
  /^https:\/\/console\.anthropic\.com\/(oauth|login|activate)/i,
  /^https:\/\/auth\.openai\.com\//i,
  /^https:\/\/github\.com\/login\/device/i,
  /^https:\/\/accounts\.google\.com\/(o\/oauth2?\/|signin)/i,
];

// RFC 3986 characters — used both to find URL ends and to decide whether a
// wrapped line continues a URL.
const URL_CHAR = /[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]/;
const MAX_URL_LEN = 2048;
const TAIL_KEEP = 600;
// A line must be at least this long for its break to count as terminal
// wrapping — shorter lines that end mid-URL simply end the URL. Phone-sized
// terminals run ~45+ cols, so real wraps clear this bar.
const WRAP_MIN_COLS = 40;

function stripAnsi(text: any) {
  return String(text ?? '')
    // OSC sequences (title updates, hyperlinks) terminated by BEL or ST
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, '')
    // CSI sequences (colors, cursor movement)
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    // remaining single-char escapes
    .replace(/\x1b[@-Z\\-_]/g, '');
}

function isAuthUrl(url: any) {
  return AUTH_URL_PATTERNS.some((rx) => rx.test(String(url || '')));
}

function trimUrl(raw: any) {
  let url = String(raw || '');
  // Strip punctuation that prose or box-drawing leaves glued to the URL.
  while (url && /[.,;:!?)'"\]>]$/.test(url)) url = url.slice(0, -1);
  return url;
}

// Reassemble a URL starting at `start`, following it across hard line breaks.
// Agent CLIs (ink UIs especially) hard-wrap long URLs at the terminal width;
// the printed continuation line may carry indentation or box-drawing
// decoration. Joining stops at a blank line, a non-URL character, a line too
// short to have been wrapped, or the length cap — real CLI login screens
// separate the URL from surrounding prose with blank lines.
//
// `held: true` means the candidate ran into the end of the scanned text and
// may continue in the next PTY chunk — the caller keeps a tail buffer and
// rescans, so held candidates must NOT be emitted (a truncated OAuth URL is
// worse than a slightly later one).
function readUrlAt(text: string, start: number) {
  let url = '';
  let i = start;
  let lineStart = text.lastIndexOf('\n', start) + 1;
  while (i < text.length && url.length < MAX_URL_LEN) {
    const ch = text[i];
    if (URL_CHAR.test(ch)) {
      url += ch;
      i++;
      if (url.length > 8 && url.endsWith('https://')) {
        // Swallowed the start of a SECOND url (e.g. the same login URL
        // reprinted on the next redraw line) — a wrapped continuation never
        // begins a new scheme. Keep only the first.
        return { url: url.slice(0, -8), held: false };
      }
      continue;
    }
    if (ch !== '\r' && ch !== '\n') return { url, held: false };
    const lineLen = i - lineStart;
    let j = i;
    if (text[j] === '\r') j++;
    if (j >= text.length) return { url, held: true };
    if (text[j] !== '\n') return { url, held: false }; // lone \r: same-line redraw
    j++;
    const nextLineStart = j;
    while (j < text.length && /[ \t│┃║|]/.test(text[j])) j++;
    if (j >= text.length) return { url, held: true };
    if (text[j] === '\r' || text[j] === '\n') return { url, held: false }; // blank line
    if (lineLen >= WRAP_MIN_COLS && URL_CHAR.test(text[j])) {
      // The broken line was long enough to have wrapped. Classify the next
      // line by its leading URL-char run: a line-filling run continues the
      // URL; a short run is the URL's final tail only when a blank line (or
      // nothing) follows it — a short line with more content after it is an
      // unrelated line (TUI redraw, prose), not a continuation.
      let k = j;
      while (k < text.length && URL_CHAR.test(text[k])) k++;
      const runLen = k - j;
      if (runLen >= WRAP_MIN_COLS) {
        i = j;
        lineStart = nextLineStart;
        continue;
      }
      if (k >= text.length) return { url, held: true };
      const after = text[k];
      if (after !== '\r' && after !== '\n') return { url, held: false };
      let m = k;
      if (text[m] === '\r') m++;
      if (text[m] === '\n') m++;
      while (m < text.length && /[ \t│┃║|]/.test(text[m])) m++;
      if (m >= text.length) return { url, held: true };
      if (text[m] === '\r' || text[m] === '\n') {
        i = j;
        lineStart = nextLineStart;
        continue;
      }
      return { url, held: false };
    }
    return { url, held: false };
  }
  if (url.length >= MAX_URL_LEN) return { url, held: false };
  return { url, held: true };
}

function extractLoginUrls(text: any) {
  const found: string[] = [];
  const push = (raw: any) => {
    const url = trimUrl(raw);
    if (url && isAuthUrl(url) && !found.includes(url)) found.push(url);
  };
  const source = String(text ?? '');
  // OSC 8 hyperlinks carry the complete URI regardless of visual wrapping —
  // always the most reliable source when present.
  const osc8 = /\x1b\]8;[^;\x07\x1b]*;([^\x07\x1b]+)(?:\x07|\x1b\\)/g;
  let m;
  while ((m = osc8.exec(source))) push(m[1]);
  const stripped = stripAnsi(source);
  let idx = stripped.indexOf('https://');
  while (idx !== -1) {
    const candidate = readUrlAt(stripped, idx);
    if (!candidate.held) push(candidate.url);
    idx = stripped.indexOf('https://', idx + 8);
  }
  return found;
}

// Resolve which task owns a PTY stream from a full state snapshot. Stream ids
// are `conversation:<id>`, `variant:<id>`, or `shell:<taskId>[:N]` — same
// scheme the renderer's terminal registry uses.
function findTaskIdForStream(state: any, streamId: any) {
  const m = /^(variant|conversation|shell):(.+)$/.exec(String(streamId ?? ''));
  if (!m) return null;
  const kind = m[1];
  const rawId = kind === 'shell' ? m[2].replace(/:\d+$/, '') : m[2];
  for (const ws of state?.workspaces || []) {
    for (const task of [...(ws.tasks || []), ...(ws.archivedTasks || [])]) {
      if (!task) continue;
      if (kind === 'shell' && task.id === rawId) return task.id;
      if (kind === 'conversation' && (task.conversations || []).some((c: any) => c && c.id === rawId)) {
        return task.id;
      }
      if (kind === 'variant') {
        for (const wt of task.worktrees || []) {
          if ((wt?.variants || []).some((v: any) => v && v.id === rawId)) return task.id;
        }
      }
    }
  }
  return null;
}

function createLoginUrlWatcher({
  store,
  emitUiRequest,
  ttlMs = 10 * 60_000,
  cooldownMs = 60_000,
  now = Date.now,
}: any) {
  if (!store) throw new Error('login-url-watcher: store required');
  // Per-stream scan state: a raw tail so URLs split across PTY chunks still
  // match, plus dedupe bookkeeping. Agent TUIs redraw the same screen many
  // times per second, so the same login URL is re-extracted constantly —
  // `seen` (per URL) and `lastEmitAt` (per stream) keep that to one tab.
  const streams = new Map();

  function streamState(streamId: any) {
    let s = streams.get(streamId);
    if (!s) {
      s = { tail: '', seen: new Map(), lastEmitAt: 0 };
      streams.set(streamId, s);
    }
    return s;
  }

  function openLoginTab(taskId: any, url: any) {
    let saved: any = { tabs: [], activeId: null };
    try {
      saved = store.listScratchTabs({ taskId }) || saved;
    } catch {
      return;
    }
    const tabs = Array.isArray(saved.tabs) ? saved.tabs : [];
    const existing = tabs.find((t: any) => t && t.kind === 'browser' && t.url === url);
    if (existing) {
      emitUiRequest?.({ type: 'activate', taskId, tabId: existing.id, source: 'login-url' });
      return;
    }
    const tabId = `br-${crypto.randomBytes(5).toString('hex')}`;
    let host = 'Sign in';
    try {
      host = `Sign in — ${new URL(url).hostname}`;
    } catch {}
    const tab = { id: tabId, kind: 'browser', title: host, url };
    try {
      const result = store.saveScratchTabs({ taskId, tabs: [...tabs, tab], activeId: tabId });
      if (result && result.ok === false) return;
    } catch {
      return;
    }
    emitUiRequest?.({ type: 'open', taskId, tabId, url, source: 'login-url' });
  }

  function handlePtyData(payload: any) {
    const streamId = payload?.id;
    const chunk = payload?.chunk;
    if (!streamId || typeof chunk !== 'string' || !chunk) return;
    const s = streamState(streamId);
    const text = s.tail + chunk;
    s.tail = text.slice(-TAIL_KEEP);
    if (!text.includes('http')) return;
    const ts = now();
    if (ts - s.lastEmitAt < cooldownMs && s.lastEmitAt) {
      // Still record sightings so the TTL keeps suppressing redraws.
      for (const url of extractLoginUrls(text)) s.seen.set(url, ts);
      return;
    }
    for (const url of extractLoginUrls(text)) {
      const seenAt = s.seen.get(url);
      s.seen.set(url, ts);
      if (seenAt && ts - seenAt < ttlMs) continue;
      let taskId = null;
      try {
        taskId = findTaskIdForStream(store.getState(), streamId);
      } catch {}
      if (!taskId) continue;
      s.lastEmitAt = ts;
      openLoginTab(taskId, url);
      break; // at most one tab per burst
    }
    // GC stale sightings so long-lived streams don't grow unbounded.
    if (s.seen.size > 32) {
      for (const [url, at] of s.seen) {
        if (ts - at > ttlMs) s.seen.delete(url);
      }
    }
  }

  function reset(streamId: any) {
    streams.delete(streamId);
  }

  return { handlePtyData, reset };
}

module.exports = {
  AUTH_URL_PATTERNS,
  stripAnsi,
  extractLoginUrls,
  findTaskIdForStream,
  createLoginUrlWatcher,
};
