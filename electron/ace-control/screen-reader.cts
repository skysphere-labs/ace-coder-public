const { Terminal: HeadlessTerminal } = require('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize');
let trailersModule: any;
try { trailersModule = require('../../tools/ace/src/trailers.cts'); }
catch { trailersModule = require('../../tools/ace/src/trailers.cjs'); }
const { stripAnsi } = trailersModule;

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 40;
const SCROLLBACK = 4000;
const RAW_RING_BYTES = 64 * 1024;

function createScreenReader() {
  const readers = new Map();

  function ensure(streamId: any, cols?: any, rows?: any) {
    let r = readers.get(streamId);
    if (r) return r;
    const term = new HeadlessTerminal({
      cols: Math.max(2, cols || DEFAULT_COLS),
      rows: Math.max(1, rows || DEFAULT_ROWS),
      scrollback: SCROLLBACK,
      allowProposedApi: true,
    });
    const serialize = new SerializeAddon();
    term.loadAddon(serialize);
    r = {
      term,
      serialize,
      cols: term.cols,
      rows: term.rows,
      rawRing: '',
      lastText: '',
      lastActivityMs: Date.now(),
      activitySeq: 0,
      spawnedAt: Date.now(),
    };
    readers.set(streamId, r);
    return r;
  }

  function write(streamId: any, chunk: any) {
    const r = ensure(streamId);
    r.term.write(chunk);
    r.rawRing = (r.rawRing + chunk).slice(-RAW_RING_BYTES);
    r.lastActivityMs = Date.now();
    r.activitySeq++;
  }

  function resize(streamId: any, cols: any, rows: any) {
    const r = readers.get(streamId);
    if (!r) return;
    try {
      r.term.resize(Math.max(2, cols | 0), Math.max(1, rows | 0));
      r.cols = r.term.cols;
      r.rows = r.term.rows;
    } catch {}
  }

  function dispose(streamId: any) {
    const r = readers.get(streamId);
    if (!r) return;
    try { r.term.dispose(); } catch {}
    readers.delete(streamId);
  }

  function has(streamId: any) {
    return readers.has(streamId);
  }

  // The parser writes asynchronously in some cases; flush with an empty write
  // callback before reading the buffer so state detection never lags behind
  // bytes that have already been .write()'d.
  function flush(streamId: any) {
    return new Promise<void>((resolve) => {
      const r = readers.get(streamId);
      if (!r) return resolve();
      r.term.write('', () => resolve());
    });
  }

  function rawRing(streamId: any) {
    const r = readers.get(streamId);
    return r ? r.rawRing : '';
  }

  // ANSI-stripped view of the raw ring — the redraw-immune text domain used
  // for trailer observation. Cached per activitySeq: evaluate() runs on every
  // pty chunk, and re-stripping 64 KiB each time would be pure waste.
  function strippedRing(streamId: any) {
    const r = readers.get(streamId);
    if (!r) return '';
    if (r.strippedRingSeq !== r.activitySeq) {
      r.strippedRingValue = stripAnsi(r.rawRing);
      r.strippedRingSeq = r.activitySeq;
    }
    return r.strippedRingValue || '';
  }

  function lastActivityMs(streamId: any) {
    const r = readers.get(streamId);
    return r ? r.lastActivityMs : 0;
  }

  function activitySeq(streamId: any) {
    const r = readers.get(streamId);
    return r ? r.activitySeq : 0;
  }

  function spawnedAt(streamId: any) {
    const r = readers.get(streamId);
    return r ? r.spawnedAt : 0;
  }

  function text(streamId: any) {
    const r = readers.get(streamId);
    if (!r) return '';
    const buf = r.term.buffer.active;
    const lines = [];
    // Viewport rows live at [baseY, baseY + rows), not [0, rows). After any
    // scrolling, row 0 is the oldest scrollback line — so iterating from 0
    // would read stale history instead of what's on screen right now.
    const baseY = buf.baseY;
    const cursorAbsY = baseY + buf.cursorY;
    const cursorX = buf.cursorX;
    for (let y = baseY; y < baseY + r.term.rows; y++) {
      const line = buf.getLine(y);
      if (!line) { lines.push(''); continue; }
      let s = line.translateToString(true);
      if (y === cursorAbsY) {
        const marker = '▌';
        s = s.slice(0, cursorX) + marker + s.slice(cursorX);
      }
      lines.push(s);
    }
    return lines.join('\n').replace(/\s+$/u, '');
  }

  function scrollback(streamId: any, n: any) {
    const r = readers.get(streamId);
    if (!r) return '';
    const buf = r.term.buffer.active;
    const total = buf.length;
    const rows = r.term.rows;
    const wanted = Math.max(1, Math.min(SCROLLBACK + rows, n | 0 || rows));
    const start = Math.max(0, total - wanted);
    const lines = [];
    for (let y = start; y < total; y++) {
      const line = buf.getLine(y);
      if (!line) { lines.push(''); continue; }
      lines.push(line.translateToString(true));
    }
    return lines.join('\n').replace(/\s+$/u, '');
  }

  function match(streamId: any, regex: any) {
    const full = scrollback(streamId, SCROLLBACK);
    const rx = regex instanceof RegExp ? regex : new RegExp(regex, 'm');
    const lines = full.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = rx.exec(lines[i]);
      if (m) return { match: m[0], line: i + 1, groups: m.slice(1) };
    }
    return null;
  }

  // Snapshot from scrollback rather than the live viewport. text() shows only
  // ~40 visible rows, so any Ace (e.g. Codex) that prints >40 lines of
  // reasoning/tool output and then redraws a fresh "> " ready prompt would
  // scroll the DONE trailer out of the viewport before ask() reads the diff —
  // parseTrailer would then see just the prompt and loop to max-rounds.
  // Using scrollback preserves every line that was ever on screen this turn;
  // the longest-common-prefix compare still yields just the bytes added since
  // the last diff() call.
  function diff(streamId: any) {
    const r = readers.get(streamId);
    if (!r) return '';
    const current = scrollback(streamId, SCROLLBACK);
    const prev = r.lastText;
    r.lastText = current;
    if (!prev) return current;
    const prevLines = prev.split('\n');
    const curLines = current.split('\n');
    // Longest common prefix: everything before the first differing line is
    // considered unchanged. The rest is the "new output" — good enough for
    // the agent-facing API, which wants to see what scrolled in since last
    // time, not a semantic diff of in-place rewrites.
    let i = 0;
    while (i < prevLines.length && i < curLines.length && prevLines[i] === curLines[i]) i++;
    return curLines.slice(i).join('\n');
  }

  function ansiSnapshot(streamId: any) {
    const r = readers.get(streamId);
    if (!r) return '';
    try { return r.serialize.serialize(); } catch { return ''; }
  }

  function cursor(streamId: any) {
    const r = readers.get(streamId);
    if (!r) return null;
    const buf = r.term.buffer.active;
    return { row: buf.cursorY, col: buf.cursorX };
  }

  return {
    ensure,
    write,
    resize,
    dispose,
    has,
    flush,
    text,
    scrollback,
    match,
    diff,
    cursor,
    ansiSnapshot,
    rawRing,
    strippedRing,
    lastActivityMs,
    activitySeq,
    spawnedAt,
    streamIds: () => Array.from(readers.keys()),
  };
}

module.exports = { createScreenReader };
