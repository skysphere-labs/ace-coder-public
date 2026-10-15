// pty-stream-states — per-stream headless terminal mirrors for reattach
// snapshots, the boundary-safe truecolor rewrite, and SOURCE-SIDE BATCHING of
// PTY output.
//
// Why batching lives here: agent CLIs (Claude/Codex) stream MANY tiny chunks
// per second. Per chunk the app paid: the truecolor rewrite, a FULL parse
// through the headless mirror terminal, a seq bump, and one IPC send per
// window plus one WS frame per remote client. With several agents streaming
// concurrently that saturated the main-process event loop — measured as slow,
// laggy terminal streaming on desktop and a starved renderer on the phone
// (touch events queued behind the flood). pump() batches with a
// leading+trailing window: the FIRST chunk after idle flushes immediately
// (keystroke echo stays instant); a continuous stream collapses to one
// rewrite+parse+emit per 16ms window. sync() flushes the pending tail first,
// so a reattach snapshot never misses buffered bytes and no batch spans a
// snapshot boundary.

const { Terminal: HeadlessTerminal } = require('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize');

// Boundary-safe rewriter: replaces ESC[48;2;0;0;0m with ESC[40m in a VT byte
// stream. Tracks partial matches across chunk boundaries via per-stream state.
const TC_BLACK = '\x1b[48;2;0;0;0m';
const PAL_BLACK = '\x1b[40m';

function rewriteTruecolorBlack(chunk, partialRef) {
  let partial = partialRef.buf;
  let out = '';
  for (let i = 0; i < chunk.length; i++) {
    partial += chunk[i];
    if (partial.length <= TC_BLACK.length && TC_BLACK.startsWith(partial)) {
      if (partial === TC_BLACK) {
        out += PAL_BLACK;
        partial = '';
      }
    } else {
      out += partial;
      partial = '';
    }
  }
  partialRef.buf = partial;
  return out;
}

function flushPartial(partialRef) {
  const leftover = partialRef.buf;
  partialRef.buf = '';
  return leftover;
}

function createStreamStateManager() {
  const states = new Map();

  function ensureState(streamId, cols, rows) {
    let state = states.get(streamId);
    if (state) return state;
    // NOTE: an existing mirror is returned with its dims UNTOUCHED — resizing
    // here would race the caller's own PTY resize (which can fail and leave the
    // two mismatched). Callers that (re)spawn a PTY at known dims must call
    // resize() themselves once those dims are the PTY's reality: a reused mirror
    // even two rows short clamps the TUI's absolute-positioned bottom rows onto
    // each other — the footer hint lands ON the composer row — after which every
    // screen-shape consumer (profile ready detection, the lane state machine,
    // auto-resume readiness) misreads the lane for its whole lifetime.
    const headless = new HeadlessTerminal({
      cols: Math.max(2, cols || 100),
      rows: Math.max(1, rows || 28),
      scrollback: 5000,
      allowProposedApi: true,
    });
    const serializeAddon = new SerializeAddon();
    headless.loadAddon(serializeAddon);
    state = {
      headless,
      serializeAddon,
      seq: 0,
      cols: headless.cols,
      rows: headless.rows,
      partial: { buf: '' },
    };
    states.set(streamId, state);
    return state;
  }

  function writeData(streamId, chunk) {
    const state = states.get(streamId);
    if (!state) return { seq: 0, rewritten: chunk };
    // Rewrite truecolor black bg → palette black, boundary-safe
    const rewritten = rewriteTruecolorBlack(chunk, state.partial);
    if (rewritten) state.headless.write(rewritten);
    return { seq: ++state.seq, rewritten: rewritten || '' };
  }

  function resize(streamId, cols, rows) {
    const state = states.get(streamId);
    if (!state) return;
    const c = Math.max(2, cols | 0);
    const r = Math.max(1, rows | 0);
    try {
      state.headless.resize(c, r);
      state.cols = c;
      state.rows = r;
    } catch {}
  }

  function sync(streamId, options) {
    const state = states.get(streamId);
    if (!state) return Promise.resolve(null);
    flushPump(streamId); // snapshot must include any batched tail
    // Cap the serialized scrollback to the client's advertised buffer depth
    // (phones keep 1500 rows vs the mirror's 5000). Serializing beyond what
    // the client retains only burns main-thread serialize time, tunnel
    // bytes, and client parse time.
    const requested = options && options.scrollback;
    const cap =
      Number.isInteger(requested) && requested >= 0 ? requested : undefined;
    return new Promise((resolve) => {
      state.headless.write('', () => {
        try {
          resolve({
            state: state.serializeAddon.serialize(
              cap === undefined ? undefined : { scrollback: cap }
            ),
            seq: state.seq,
            cols: state.cols,
            rows: state.rows,
          });
        } catch {
          resolve(null);
        }
      });
    });
  }

  function remove(streamId) {
    removePump(streamId);
    const state = states.get(streamId);
    if (state) {
      state.partial.buf = '';
      try { state.headless.dispose(); } catch {}
      states.delete(streamId);
    }
  }

  function getSeq(streamId) {
    const state = states.get(streamId);
    return state ? state.seq : 0;
  }

  // ---- source-side batching -------------------------------------------------
  // Agent CLIs stream MANY tiny chunks per second. Per chunk we paid: the
  // truecolor rewrite, a FULL parse through the headless mirror terminal
  // (reattach snapshots), a seq bump, and one IPC send per window plus one WS
  // frame per remote client. With several agents streaming at once that
  // saturated the main process event loop (and starved the phone renderer's
  // touch handling downstream). pump() batches at the source with a
  // leading+trailing 16ms window: the FIRST chunk after idle flushes
  // immediately — keystroke echo stays instant — and a continuous stream
  // collapses to one rewrite+parse+emit per window. sync() flushes the pending
  // tail first, so a reattach snapshot never misses buffered bytes and no
  // batch ever spans a snapshot boundary.
  const PTY_BATCH_MS = 16;
  const pumps = new Map();

  function armPump(pump, streamId) {
    pump.timer = setTimeout(() => {
      pump.timer = null;
      if (!pump.buf) return; // stream went idle: close the window
      const data = pump.buf;
      pump.buf = '';
      const { seq, rewritten } = writeData(streamId, data);
      try { pump.deliver({ seq, rewritten }); } catch {}
      armPump(pump, streamId); // continuous stream: stay in batched mode
    }, PTY_BATCH_MS);
    if (typeof pump.timer.unref === 'function') pump.timer.unref();
  }

  function pump(streamId, chunk, deliver) {
    let entry = pumps.get(streamId);
    if (!entry) {
      entry = { buf: '', timer: null, deliver };
      pumps.set(streamId, entry);
    }
    entry.deliver = deliver;
    if (entry.timer) {
      entry.buf += chunk;
      return;
    }
    const { seq, rewritten } = writeData(streamId, chunk);
    try { deliver({ seq, rewritten }); } catch {}
    armPump(entry, streamId);
  }

  function flushPump(streamId) {
    const entry = pumps.get(streamId);
    if (!entry) return;
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    if (!entry.buf) return;
    const data = entry.buf;
    entry.buf = '';
    const { seq, rewritten } = writeData(streamId, data);
    try { entry.deliver({ seq, rewritten }); } catch {}
  }

  function removePump(streamId) {
    const entry = pumps.get(streamId);
    if (entry && entry.timer) clearTimeout(entry.timer);
    pumps.delete(streamId);
  }

  return { ensureState, writeData, pump, flushPump, resize, sync, remove, getSeq };
}

module.exports = { createStreamStateManager, rewriteTruecolorBlack };
