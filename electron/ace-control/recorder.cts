const fs = require('fs');
const path = require('path');

function createRecorders() {
  const recorders = new Map();

  function start(streamId: any, outPath: any) {
    if (recorders.has(streamId)) return { ok: false, error: 'already recording' };
    const abs = path.resolve(outPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const stream = fs.createWriteStream(abs, { flags: 'w' });
    stream.write(JSON.stringify({ kind: 'stream-record', version: 1, streamId, startedAt: Date.now() }) + '\n');
    recorders.set(streamId, { stream, path: abs, startedAt: Date.now() });
    return { ok: true, path: abs };
  }

  function write(streamId: any, frame: any) {
    const r = recorders.get(streamId);
    if (!r) return;
    try {
      r.stream.write(JSON.stringify({ t: Date.now() - r.startedAt, ...frame }) + '\n');
    } catch {}
  }

  function stop(streamId: any) {
    const r = recorders.get(streamId);
    if (!r) return { ok: false, error: 'not recording' };
    r.stream.end();
    recorders.delete(streamId);
    return { ok: true, path: r.path };
  }

  function isRecording(streamId: any) {
    return recorders.has(streamId);
  }

  function disposeAll() {
    for (const [, r] of recorders) {
      try { r.stream.end(); } catch {}
    }
    recorders.clear();
  }

  return { start, write, stop, isRecording, disposeAll };
}

function loadRecording(recordPath: any) {
  const raw = fs.readFileSync(recordPath, 'utf8');
  const frames = raw.split('\n').filter(Boolean).map((line: any) => JSON.parse(line));
  const header = frames.shift();
  return { header, frames };
}

module.exports = { createRecorders, loadRecording };
