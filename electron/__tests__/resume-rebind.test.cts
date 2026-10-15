import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Session self-heal contract: a lane whose recorded claude session id no
// longer resolves to a file must rebind to the newest real session for its
// cwd (excluding sessions bound to other lanes), never silently mint a fresh
// session that orphans the lane's transcript history.
const providers = require('../agent-providers.cjs');

const CLAUDE = providers.getProvider('claude');

function slugFor(cwd) {
  return String(cwd).replace(/[^A-Za-z0-9_-]/g, '-');
}

describe('findNewestSessionIdInCwd', () => {
  let home;
  let prevHome;
  const cwd = '/tmp/some repo/wt';
  const A = '11111111-aaaa-4aaa-8aaa-111111111111';
  const B = '22222222-bbbb-4bbb-8bbb-222222222222';

  beforeEach(() => {
    prevHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), 'ace-rebind-'));
    process.env.HOME = home;
    mkdirSync(join(home, '.claude', 'projects', slugFor(cwd)), { recursive: true });
  });

  afterEach(() => {
    process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  function writeSession(id, content, mtimeMs) {
    const file = join(home, '.claude', 'projects', slugFor(cwd), `${id}.jsonl`);
    writeFileSync(file, content);
    const when = new Date(mtimeMs);
    require('node:fs').utimesSync(file, when, when);
  }

  it('returns the newest non-empty uuid-named session', () => {
    writeSession(A, '{"x":1}\n', Date.now() - 60_000);
    writeSession(B, '{"x":2}\n', Date.now() - 5_000);
    expect(providers.findNewestSessionIdInCwd(CLAUDE, cwd)).toBe(B);
  });

  it('skips empty files and non-uuid names', () => {
    writeSession(A, '{"x":1}\n', Date.now() - 60_000);
    writeSession(B, '', Date.now() - 5_000); // empty: claude never got a turn
    writeFileSync(join(home, '.claude', 'projects', slugFor(cwd), 'notes.jsonl'), '{"x":3}\n');
    expect(providers.findNewestSessionIdInCwd(CLAUDE, cwd)).toBe(A);
  });

  it('honors the exclusion set so sibling tabs cannot be stolen', () => {
    writeSession(A, '{"x":1}\n', Date.now() - 60_000);
    writeSession(B, '{"x":2}\n', Date.now() - 5_000);
    expect(providers.findNewestSessionIdInCwd(CLAUDE, cwd, new Set([B]))).toBe(A);
  });

  it('returns null for a virgin cwd and for non-claude providers', () => {
    expect(providers.findNewestSessionIdInCwd(CLAUDE, '/tmp/nowhere-at-all')).toBeNull();
    expect(providers.findNewestSessionIdInCwd(providers.getProvider('codex'), cwd)).toBeNull();
  });
});

// The external-SSD false-missing guard hinges on distinguishing a definitive
// ENOENT from a transient stat failure. A collapsed "any throw == missing"
// (the old behavior) is what triggered the cross-attach.
describe('sessionFileState (transient vs definitive absence)', () => {
  const throwsCode = (code) => () => {
    const err = new Error(code);
    err.code = code;
    throw err;
  };

  it('reports present for a real file', () => {
    expect(providers.sessionFileState('/x', () => ({ isFile: () => true }))).toBe('present');
  });

  it('reports absent only for ENOENT (and for a non-file)', () => {
    expect(providers.sessionFileState('/x', throwsCode('ENOENT'))).toBe('absent');
    expect(providers.sessionFileState('/x', () => ({ isFile: () => false }))).toBe('absent');
    expect(providers.sessionFileState('', throwsCode('ENOENT'))).toBe('absent'); // no path
  });

  it('reports unknown for every transient errno (SSD race, not a real absence)', () => {
    for (const code of ['EIO', 'ENOTCONN', 'EBUSY', 'EAGAIN', 'ETIMEDOUT', 'EPERM', 'ENOTDIR']) {
      expect(providers.sessionFileState('/x', throwsCode(code))).toBe('unknown');
    }
  });
});

// Pure rebind precedence: own-history > newest-in-cwd-if-unambiguous > fresh.
describe('decideSessionRebind (precedence)', () => {
  const OWN = 'own-1111-4111-8111-111111111111';
  const NEWEST = 'new-2222-4222-8222-222222222222';
  const STALE = 'stale-333-4333-8333-333333333333';

  it('prefers this tab OWN existing history over newest-in-cwd', () => {
    const d = providers.decideSessionRebind({
      ownHistory: [{ sessionId: OWN, exists: true }],
      taken: new Set(),
      newestInCwd: NEWEST,
      claudeTabCount: 5,
      staleSessionId: STALE,
    });
    expect(d).toEqual({ mode: 'resume', sessionId: OWN, reason: 'rebind-own-history' });
  });

  it('skips an own-history session whose file is gone or already taken', () => {
    const gone = providers.decideSessionRebind({
      ownHistory: [{ sessionId: OWN, exists: false }],
      taken: new Set(),
      newestInCwd: null,
      claudeTabCount: 1,
      staleSessionId: STALE,
    });
    expect(gone.mode).toBe('fresh');
    const taken = providers.decideSessionRebind({
      ownHistory: [{ sessionId: OWN, exists: true }],
      taken: new Set([OWN]),
      newestInCwd: null,
      claudeTabCount: 2,
      staleSessionId: STALE,
    });
    expect(taken.mode).toBe('fresh');
  });

  it('rebinds to newest-in-cwd ONLY when the cwd has <=1 claude tab', () => {
    const single = providers.decideSessionRebind({
      ownHistory: [],
      taken: new Set(),
      newestInCwd: NEWEST,
      claudeTabCount: 1,
      staleSessionId: STALE,
    });
    expect(single).toEqual({ mode: 'resume', sessionId: NEWEST, reason: 'rebind-newest' });
  });

  it('prefers FRESH over stealing a sibling when multiple tabs share the cwd', () => {
    const many = providers.decideSessionRebind({
      ownHistory: [],
      taken: new Set(),
      newestInCwd: NEWEST, // a sibling's session — must NOT be grabbed
      claudeTabCount: 3,
      staleSessionId: STALE,
    });
    expect(many).toEqual({ mode: 'fresh', sessionId: null, reason: 'fresh-no-match' });
  });

  it('never rebinds to the stale id being replaced', () => {
    const d = providers.decideSessionRebind({
      ownHistory: [{ sessionId: STALE, exists: true }],
      taken: new Set(),
      newestInCwd: STALE,
      claudeTabCount: 1,
      staleSessionId: STALE,
    });
    expect(d.mode).toBe('fresh');
  });
});

describe('local-core resume wiring (source contract)', () => {
  const src = readFileSync(resolve(__dirname, '..', 'local-core.cts'), 'utf8');

  it('only a DEFINITIVE absence rebinds; a transient SSD stat keeps the stored id', () => {
    // The check is state-based now, and ONLY 'absent' (ENOENT) falls through.
    expect(src).toMatch(/let state = sessionFileState\(file\);/);
    expect(src).toMatch(/if \(state === 'absent'\) \{\s*\n\s*return planRebindOrFresh/);
    // A transient/unknown state must NOT rebind — the old `if (!exists)` bug.
    expect(src).not.toMatch(/try \{ exists = fs\.statSync\(file\)\.isFile\(\); \} catch \{\}/);
    // The transient keep leaves an audit breadcrumb.
    expect(src).toMatch(/reason: 'transient-error-kept-stored'/);
  });

  it('rebind is own-session-aware, ambiguity-gated, and persists the choice', () => {
    expect(src).toMatch(/planRebindOrFresh\(\{ provider, resume, agent, cwd, staleSessionId: sessionId, streamId \}\)/);
    expect(src).toMatch(/const ownHistory = ownHistorySessionsForStream\(/);
    expect(src).toMatch(/const newestInCwd = findNewestSessionIdInCwd\(provider, cwd, taken\);/);
    expect(src).toMatch(/const decision = decideSessionRebind\(/);
    // The rebound id must persist so the DB self-heals.
    expect(src).toMatch(/storedSessionId: decision\.sessionId,\s*\n\s*willPersist: decision\.sessionId,/);
    // A null session id (brand-new tab) must NOT rebind to old history.
    expect(src).not.toMatch(/planRebindOrFresh\(\{[^}]*staleSessionId: null/);
  });

  it('the concurrent-respawn race is closed by reservations + an audit trail', () => {
    // Reserved ids join `taken` so a second concurrent planResume can't pick them.
    expect(src).toMatch(/for \(const sid of reservedSessionIds\(\)\) \{/);
    expect(src).toMatch(/reserveSessionId\(decision\.sessionId\);/);
    // The reservation is released once the id is durably persisted.
    expect(src).toMatch(/releaseSessionReservation\(sessionId\);/);
    // Every rebind/fresh persists through writeSessionIdForStream with a reason.
    expect(src).toMatch(/writeSessionIdForStream\(streamId, plan\.willPersist, plan\.reason\);/);
  });

  it('foreign holders of a session are reaped before spawning', () => {
    expect(src).toMatch(/function reapForeignSessionHolders\(/);
    expect(src).toMatch(/--resume \$\{sid\}|--resume \$\{sid\}/);
    // Only when no live stream of our own exists.
    expect(src).toMatch(/resumeTarget && \(!existingLive \|\| existingLive\.status !== 'running'\)/);
  });

  it('an unavailable cwd defers instead of clearing resume state', () => {
    expect(src).toMatch(/deferred: true, error: `cwd unavailable/);
    expect(src).toMatch(/else if \(!res\?\.deferred\) clearAgentResumeState\(streamId\);/);
  });
});
