// A thin better-sqlite3-compatible adapter over Node's built-in `node:sqlite`
// (DatabaseSync). The packaged better-sqlite3 is built for the Electron ABI and
// will not load under the plain-Node test runner, so tests inject THIS as
// createAceStore's `testHooks.Database` to boot the REAL store against a driver
// that loads everywhere. It implements only the surface createAceStore uses:
// pragma (setters), exec, prepare -> run/get/all, transaction, function, close.
const { DatabaseSync } = require('node:sqlite');

class StatementShim {
  st: any;
  constructor(st: any) {
    this.st = st;
    // better-sqlite3 binds named parameters by BARE name ({id} for @id); enable
    // the same on node:sqlite so createAceStore's `.run(rowObject)` calls work.
    try { this.st.setAllowBareNamedParameters(true); } catch {}
  }
  run(...args: any[]) {
    const r = this.st.run(...normalizeParams(args));
    return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid };
  }
  get(...args: any[]) { return this.st.get(...normalizeParams(args)); }
  all(...args: any[]) { return this.st.all(...normalizeParams(args)); }
}

// node:sqlite accepts an object of named params OR spread positional params, the
// same two shapes better-sqlite3 accepts, so pass them through unchanged.
function normalizeParams(args: any[]) {
  return args;
}

class BetterSqlite3NodeShim {
  db: any;
  constructor(filename: string, _opts?: any) {
    this.db = new DatabaseSync(filename === '' ? ':memory:' : filename);
  }
  pragma(source: string) {
    // Only setters are used at store construction; run it and return nothing.
    this.db.exec(`PRAGMA ${source}`);
    return undefined;
  }
  exec(sql: string) { this.db.exec(sql); return this; }
  prepare(sql: string) { return new StatementShim(this.db.prepare(sql)); }
  transaction(fn: (...a: any[]) => any) {
    const db = this.db;
    return (...args: any[]) => {
      db.exec('BEGIN');
      try {
        const out = fn(...args);
        db.exec('COMMIT');
        return out;
      } catch (err) {
        try { db.exec('ROLLBACK'); } catch {}
        throw err;
      }
    };
  }
  function(name: string, ...rest: any[]) {
    const fn = rest[rest.length - 1];
    try { this.db.function(name, fn); } catch {}
    return this;
  }
  close() { try { this.db.close(); } catch {} }
}

module.exports = { BetterSqlite3NodeShim };
