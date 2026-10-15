// Stand-in for node-pty used by pty-host tests (the real module is built for
// Electron's ABI and cannot load in the plain-node test runner). Echoes
// writes back as output; `__EXIT__<code>` input makes the fake process exit.
const { EventEmitter } = require('events');

function spawn(bin, args, _opts) {
  const em = new EventEmitter();
  let exited = false;
  const exit = (code) => {
    if (exited) return;
    exited = true;
    setImmediate(() => em.emit('exit', { exitCode: code }));
  };
  const proc = {
    pid: process.pid,
    onData(cb) {
      em.on('data', cb);
    },
    onExit(cb) {
      em.on('exit', cb);
    },
    write(data) {
      if (exited) return;
      const text = String(data);
      const m = text.match(/__EXIT__(\d+)/);
      if (m) {
        exit(Number(m[1]));
        return;
      }
      setImmediate(() => em.emit('data', `echo:${text}`));
    },
    resize() {},
    kill() {
      exit(0);
    },
  };
  setImmediate(() => em.emit('data', `spawned:${bin}:${(args || []).join(',')}`));
  return proc;
}

module.exports = { spawn };
