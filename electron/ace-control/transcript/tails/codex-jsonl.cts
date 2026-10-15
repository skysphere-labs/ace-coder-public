const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');

// Append-only JSONL tailer. Emits one parsed JSON object per new line.
// Strategy: open the file read-only, read from byteOffset to EOF, buffer
// partial trailing line, watch the file for changes, repeat.
function createCodexJsonlTail({ filePath, byteOffset = 0, onEvent, onWarning, onClose }: any) {
  let offset = byteOffset | 0;
  let buf = '';
  let closed = false;
  let watcher: any = null;
  let ticking = false;
  let retryTimer: any = null;

  async function drain() {
    if (closed) return;
    if (ticking) return;
    ticking = true;
    try {
      const stat = await fsp.stat(filePath).catch(() => null);
      if (!stat) {
        // File vanished — likely /clear deleted it. Caller handles via
        // linker reset logic; we just wait for the next watch tick.
        return;
      }
      if (stat.size < offset) {
        // File truncated (rewrite / resume) — rewind and let caller observe
        // by calling reset semantics.
        offset = 0;
        buf = '';
        if (onWarning) onWarning({ code: 'codex:truncated', size: stat.size });
      }
      if (stat.size === offset) return;
      const stream = fs.createReadStream(filePath, { start: offset, end: stat.size - 1, encoding: 'utf8' });
      await new Promise<void>((resolve, reject) => {
        stream.on('data', (chunk: any) => {
          buf += chunk;
          let idx;
          while ((idx = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, idx);
            buf = buf.slice(idx + 1);
            if (!line.trim()) continue;
            try {
              const evt = JSON.parse(line);
              onEvent(evt);
            } catch (err: any) {
              if (onWarning) onWarning({ code: 'codex:parse', error: err.message, line: line.slice(0, 200) });
            }
          }
        });
        stream.on('end', () => {
          offset = stat.size;
          resolve();
        });
        stream.on('error', reject);
      });
    } finally {
      ticking = false;
    }
  }

  function schedule() {
    if (closed) return;
    drain().catch((err: any) => {
      if (onWarning) onWarning({ code: 'codex:drain', error: err.message });
      if (retryTimer) return;
      retryTimer = setTimeout(() => { retryTimer = null; schedule(); }, 500);
    });
  }

  function startWatcher() {
    try {
      watcher = fs.watch(filePath, { persistent: false }, () => schedule());
    } catch (err: any) {
      if (onWarning) onWarning({ code: 'codex:watch', error: err.message });
      // Fallback: poll mtime every 500ms.
      let last = 0;
      const id = setInterval(async () => {
        if (closed) return clearInterval(id);
        try {
          const stat = await fsp.stat(filePath);
          if (stat.mtimeMs !== last) {
            last = stat.mtimeMs;
            schedule();
          }
        } catch {}
      }, 500);
      watcher = { close: () => clearInterval(id) };
    }
  }

  async function start() {
    // Prime: drain any content from the recorded offset forward.
    schedule();
    startWatcher();
  }

  function close() {
    if (closed) return;
    closed = true;
    if (retryTimer) clearTimeout(retryTimer);
    try { watcher?.close(); } catch {}
    if (onClose) onClose();
  }

  function getOffset() {
    return offset;
  }

  return { start, close, getOffset, drain: schedule, _filePath: filePath };
}

module.exports = { createCodexJsonlTail };
void path;
