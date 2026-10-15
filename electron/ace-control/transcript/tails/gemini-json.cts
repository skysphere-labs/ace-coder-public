const fs = require('fs');
const fsp = require('fs').promises;

// Gemini session file: single JSON doc, overwritten on every update.
// Strategy: debounce reads (50ms), re-read the whole file, emit the full
// snapshot. Caller diffs against the last emission.
//
// Hermes also rides this tail (transcript.kind: "json-rewrite"). Hermes
// rewrites session_*.json on every turn, occasionally via atomic rename
// (write tmp + rename), which can break a long-lived `fs.watch` on the
// original inode silently. We layer a periodic mtime stat poll on top of
// fs.watch so missed events still resync within `pollIntervalMs` — without
// it, the chat overlay strands on the boot snapshot until the renderer
// remounts.
function createGeminiJsonTail({
  filePath,
  onSnapshot,
  onWarning,
  onClose,
  debounceMs = 50,
  pollIntervalMs = 1500,
  watch = true,
}: any) {
  let closed = false;
  let watcher: any = null;
  let pollTimer: any = null;
  let timer: any = null;
  let reading = false;
  let pending = false;
  let lastMtimeMs = 0;

  async function readNow() {
    if (closed) return;
    if (reading) {
      pending = true;
      return;
    }
    reading = true;
    try {
      const stat = await fsp.stat(filePath).catch(() => null);
      if (!stat) {
        if (onWarning) onWarning({ code: 'gemini:missing' });
        return;
      }
      if (stat.mtimeMs === lastMtimeMs) return;
      lastMtimeMs = stat.mtimeMs;
      const raw = await fsp.readFile(filePath, 'utf8');
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (err: any) {
        if (onWarning) onWarning({ code: 'gemini:parse', error: err.message });
        return;
      }
      onSnapshot(parsed);
    } finally {
      reading = false;
      if (pending) {
        pending = false;
        setImmediate(readNow);
      }
    }
  }

  function schedule() {
    if (closed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      readNow().catch((err: any) => {
        if (onWarning) onWarning({ code: 'gemini:read', error: err.message });
      });
    }, debounceMs);
  }

  function startWatcher() {
    try {
      watcher = fs.watch(filePath, { persistent: false }, () => schedule());
    } catch (err: any) {
      if (onWarning) onWarning({ code: 'gemini:watch', error: err.message });
      watcher = null;
    }
  }

  // Periodic stat. fs.watch is best-effort on macOS / atomic rename and
  // can silently miss events; polling ensures we catch up within
  // `pollIntervalMs` even if the watcher stops firing.
  function startPoll() {
    pollTimer = setInterval(() => {
      if (closed) {
        clearInterval(pollTimer);
        return;
      }
      schedule();
    }, pollIntervalMs);
  }

  async function start() {
    // Prime with an immediate read so consumers get a snapshot without
    // waiting for the next write.
    schedule();
    if (watch) startWatcher();
    startPoll();
  }

  function close() {
    if (closed) return;
    closed = true;
    if (timer) clearTimeout(timer);
    if (pollTimer) clearInterval(pollTimer);
    try { watcher?.close(); } catch {}
    if (onClose) onClose();
  }

  return { start, close, readNow, _filePath: filePath };
}

module.exports = { createGeminiJsonTail };
