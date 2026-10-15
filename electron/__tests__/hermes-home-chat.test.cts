import { expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

// Policy under test (electron/hermes-home-chat.cts): canonical home-chat
// restore (shipped) + the capability-gated cron→home delivery relay (inert on
// the shipped GET-only sidecar; POST-route scenarios are contract tests for
// the pending fork capability). Injected fakes only — no sidecar, no Electron.
const homeChat = require('../hermes-home-chat.cts');

function tmpLedgerPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ace-home-chat-')), 'ledger.json');
}

// The canonical fixture roster: a home chat plus every excluded lane. The
// cron row is deliberately the MOST RECENT — a `--continue`-style "latest"
// pick would choose it, the policy must not.
function vectorSessionRows() {
  return [
    { id: 'sess-home', source: 'desktop', profile: 'vector', last_active: 1_000, message_count: 12, title: 'Vector home' },
    { id: 'sess-cron', source: 'cron', profile: 'vector', last_active: 9_000, message_count: 4 },
    { id: 'sess-worker', source: 'worker', profile: 'vector', last_active: 8_000, message_count: 4 },
    { id: 'sess-test', source: 'test', profile: 'vector', last_active: 7_000, message_count: 4 },
    { id: 'sess-maint', source: 'maintenance', profile: 'vector', last_active: 6_000, message_count: 4 },
    { id: 'sess-other', source: 'desktop', profile: 'scout', last_active: 5_000, message_count: 4 },
    { id: 'sess-archived', source: 'desktop', profile: 'vector', last_active: 4_000, message_count: 4, archived: true },
  ];
}

// ── A1: canonical home pick ─────────────────────────────────────────────────

test('pickHomeRestoreSession restores the home chat, never the newest background session', () => {
  const picked = homeChat.pickHomeRestoreSession(vectorSessionRows(), { profile: 'vector' });
  expect(picked).not.toBeNull();
  expect(picked.id).toBe('sess-home');
});

test('every excluded source class is rejected even when it is the only recent row', () => {
  for (const source of homeChat.HOME_RESTORE_EXCLUDED_SOURCES) {
    const picked = homeChat.pickHomeRestoreSession(
      [{ id: `sess-${source}`, source, profile: 'vector', last_active: 99_000, message_count: 9 }],
      { profile: 'vector' }
    );
    expect(picked).toBeNull();
  }
  expect(homeChat.HOME_RESTORE_EXCLUDED_SOURCES).toEqual(['cron', 'worker', 'test', 'maintenance']);
});

test('other-profile and archived sessions are excluded from home restore', () => {
  expect(
    homeChat.isHomeRestoreCandidate(
      { id: 'a', source: 'desktop', profile: 'scout' },
      { profile: 'vector' }
    )
  ).toBe(false);
  expect(
    homeChat.isHomeRestoreCandidate(
      { id: 'a', source: 'desktop', profile: 'vector', archived: true },
      { profile: 'vector' }
    )
  ).toBe(false);
  // Identity-home sidecars stamp rows 'default'; those are the operator's own.
  expect(
    homeChat.isHomeRestoreCandidate(
      { id: 'a', source: 'desktop', profile: 'default' },
      { profile: 'vector' }
    )
  ).toBe(true);
});

test('a mixed-case scraped profile keys the same rows as the sidecar lower-cased id', () => {
  // The rail label arrives as a DISPLAY name ('Vector'); rows are stamped with the
  // sidecar's lower-cased id ('vector'). Both sides of the filter normalize
  // identically, so the candidate is NOT excluded — no wrong/default-profile bind
  // after an in-frame switch. 'Default' still collapses to the owned sentinel.
  expect(
    homeChat.isHomeRestoreCandidate(
      { id: 'a', source: 'desktop', profile: 'vector' },
      { profile: 'Vector' }
    )
  ).toBe(true);
  expect(
    homeChat.isHomeRestoreCandidate(
      { id: 'a', source: 'desktop', profile: 'Default' },
      { profile: 'vector' }
    )
  ).toBe(true);
  const picked = homeChat.pickHomeRestoreSession(
    [{ id: 'sess-home', source: 'desktop', profile: 'vector', last_active: 1000, message_count: 5 }],
    { profile: 'VECTOR' }
  );
  expect(picked?.id).toBe('sess-home');
});

test('a user-pinned sidecar row is home ahead of any deeper-history unpinned chat', () => {
  // `row.pinned` is an explicit, durable operator signal — the authoritative home
  // identity, honored ahead of the content heuristic even when another chat has
  // strictly more history (precedence tier 2, above depth/recency).
  const deepUnpinned = {
    id: 'sess-deep', source: 'desktop', profile: 'vector', last_active: 2000, message_count: 40,
  };
  const userPinned = {
    id: 'sess-pinned', source: 'desktop', profile: 'vector', last_active: 500, message_count: 6, pinned: true,
  };
  const picked = homeChat.pickHomeRestoreSession([deepUnpinned, userPinned], { profile: 'vector' });
  expect(picked.id).toBe('sess-pinned');
});

test('the pick is an explicit id from the input rows — no resume tokens, null when nothing is eligible', () => {
  const rows = vectorSessionRows();
  const picked = homeChat.pickHomeRestoreSession(rows, { profile: 'vector' });
  expect(rows.some((row) => row.id === picked.id)).toBe(true);
  // Never a generic latest-session token (the `seen`/`--continue` regression).
  expect(picked.id).not.toBe('seen');
  expect(homeChat.pickHomeRestoreSession([], { profile: 'vector' })).toBeNull();
  expect(
    homeChat.pickHomeRestoreSession(
      [{ id: 'sess-cron', source: 'cron', profile: 'vector', last_active: 1 }],
      { profile: 'vector' }
    )
  ).toBeNull();
});

test('sessions shortlist query excludes background sources server-side too', () => {
  const apiPath = homeChat.homeRestoreSessionsApiPath();
  expect(apiPath.startsWith('/api/sessions?')).toBe(true);
  expect(apiPath).toContain('order=recent');
  expect(decodeURIComponent(apiPath)).toContain('exclude_sources=cron,worker,test,maintenance');
});

// ── A1: cold-start seed script (run in a fake SPA window) ───────────────────

function runRestoreScript(script, { hash = '#/', storage = {} } = {}) {
  const store = new Map(Object.entries(storage));
  const sandbox = {
    window: null,
  };
  const win = {
    __aceHomeRestoreRan: undefined,
    location: { hash },
    localStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => { store.set(key, String(value)); },
    },
  };
  sandbox.window = win;
  const result = vm.runInNewContext(script, sandbox);
  return { result, win, store };
}

test('cold start with wiped storage seeds the remembered keys and navigates to the home chat', () => {
  const script = homeChat.buildHomeRestoreScript('sess-home', 'vector');
  const { result, win, store } = runRestoreScript(script, { hash: '#/' });
  expect(result).toEqual({ restored: true, sessionId: 'sess-home' });
  expect(store.get('hermes.desktop.lastSessionId.vector')).toBe('sess-home');
  expect(store.get('hermes.desktop.lastRoute.vector')).toBe('/sess-home');
  expect(win.location.hash).toBe('#/sess-home');
});

test('a remembered session (explicit New Chat included) is never overridden', () => {
  const script = homeChat.buildHomeRestoreScript('sess-home', 'vector');
  const { result, win } = runRestoreScript(script, {
    hash: '#/',
    storage: { 'hermes.desktop.lastSessionId.vector': 'sess-user-pick' },
  });
  expect(result.restored).toBe(false);
  expect(result.reason).toBe('remembered-session');
  expect(win.location.hash).toBe('#/');
});

test('an ambient remembered route of "/" does not block restore, a real one does', () => {
  const script = homeChat.buildHomeRestoreScript('sess-home', 'vector');
  // The SPA's own remember-effect writes '/' on every boot — ambient, not a choice.
  const ambient = runRestoreScript(script, {
    hash: '#/',
    storage: { 'hermes.desktop.lastRoute.vector': '/' },
  });
  expect(ambient.result.restored).toBe(true);
  const real = runRestoreScript(script, {
    hash: '#/',
    storage: { 'hermes.desktop.lastRoute.vector': '/skills' },
  });
  expect(real.result.restored).toBe(false);
  expect(real.result.reason).toBe('remembered-route');
});

test('a frame already routed away from new-chat is left alone, and the script runs once per load', () => {
  const script = homeChat.buildHomeRestoreScript('sess-home', 'vector');
  const routed = runRestoreScript(script, { hash: '#/sess-user-pick' });
  expect(routed.result.restored).toBe(false);
  expect(routed.result.reason).toBe('routed');
  expect(routed.win.location.hash).toBe('#/sess-user-pick');

  const sandboxRun = runRestoreScript(script, { hash: '#/' });
  const second = vm.runInNewContext(script, { window: sandboxRun.win });
  expect(second.restored).toBe(false);
  expect(second.reason).toBe('already-ran');
});

test('the default profile seeds the unsuffixed keys', () => {
  const script = homeChat.buildHomeRestoreScript('sess-home', 'default');
  const { store } = runRestoreScript(script, { hash: '' });
  expect(store.get('hermes.desktop.lastSessionId')).toBe('sess-home');
  expect(store.get('hermes.desktop.lastRoute')).toBe('/sess-home');
});

// ── A2: cron mutation hygiene ───────────────────────────────────────────────

test('cron job creation from the embed stays isolated: attach/origin fields stripped, deliver pinned local', () => {
  const body = {
    prompt: 'daily brief',
    schedule: 'every 1h',
    attach_to_session: true,
    origin: { platform: 'webchat', chat_id: 'sess-home' },
    session_target: 'main',
  };
  const sanitized = homeChat.sanitizeCronJobMutationBody(body, 'POST');
  expect(sanitized.attach_to_session).toBeUndefined();
  expect(sanitized.origin).toBeUndefined();
  expect(sanitized.session_target).toBeUndefined();
  expect(sanitized.deliver).toBe('local');
  expect(sanitized.prompt).toBe('daily brief');
  // The original body is not mutated.
  expect(body.attach_to_session).toBe(true);
});

test('explicit deliver targets pass through; update bodies are scrubbed inside updates', () => {
  expect(homeChat.sanitizeCronJobMutationBody({ schedule: '* * * * *', deliver: 'telegram' }, 'POST').deliver).toBe('telegram');
  const update = homeChat.sanitizeCronJobMutationBody({
    updates: { prompt: 'x', attach_to_session: true, origin: {} },
  }, 'PUT');
  expect(update.updates.attach_to_session).toBeUndefined();
  expect(update.updates.origin).toBeUndefined();
  expect(update.updates.prompt).toBe('x');
  // Update bodies never grow a deliver field they did not carry.
  expect(update.deliver).toBeUndefined();
});

test('a PUT body without an updates wrapper never gains an injected deliver', () => {
  // Injecting deliver:'local' on an update would silently rewrite an existing
  // job's explicit routing during an unrelated edit.
  const put = homeChat.sanitizeCronJobMutationBody({ name: 'renamed', attach_to_session: true }, 'PUT');
  expect(put.deliver).toBeUndefined();
  expect(put.attach_to_session).toBeUndefined();
  expect(put.name).toBe('renamed');
});

test('isCronJobMutation matches only cron job create (collection POST) / update (item PUT)', () => {
  expect(homeChat.isCronJobMutation('/api/cron/jobs', 'POST')).toBe(true); // create
  expect(homeChat.isCronJobMutation('/api/cron/jobs/j1', 'PUT')).toBe(true); // update
  expect(homeChat.isCronJobMutation('/api/cron/jobs', 'GET')).toBe(false);
  // A POST on the ITEM is NOT a create — it must not be rewritten (deliver:'local'
  // injected). Only the collection POST creates; item POSTs (pause/resume) live
  // under sub-paths and are likewise not mutations here.
  expect(homeChat.isCronJobMutation('/api/cron/jobs/j1', 'POST')).toBe(false);
  expect(homeChat.isCronJobMutation('/api/cron/jobs/j1/pause', 'POST')).toBe(false);
  expect(homeChat.isCronJobMutation('/api/cron/jobs/j1/trigger', 'POST')).toBe(false);
  // Update is PUT on the item, never POST on the item.
  expect(homeChat.isCronJobMutation('/api/cron/jobs', 'PUT')).toBe(false);
  expect(homeChat.isCronJobMutation('/api/sessions', 'POST')).toBe(false);
});

// ── A2: exactly-once ledger ─────────────────────────────────────────────────

test('ledger claims are exactly-once across instances (restart survival)', () => {
  const filePath = tmpLedgerPath();
  const first = homeChat.createCronDeliveryLedger({ filePath });
  expect(first.claim('default', 'job-1', 'run-1').granted).toBe(true);
  first.confirm('default', 'job-1', 'run-1');
  expect(first.claim('default', 'job-1', 'run-1').granted).toBe(false);
  // A fresh instance over the same file (app restart) still refuses.
  const second = homeChat.createCronDeliveryLedger({ filePath });
  expect(second.isDelivered('default', 'job-1', 'run-1')).toBe(true);
  expect(second.claim('default', 'job-1', 'run-1').granted).toBe(false);
});

test('ledger keys are profile-scoped: identical run ids in two profiles never collide', () => {
  const filePath = tmpLedgerPath();
  const ledger = homeChat.createCronDeliveryLedger({ filePath });
  expect(ledger.claim('alpha', 'job-1', 'run-1').granted).toBe(true);
  ledger.confirm('alpha', 'job-1', 'run-1');
  // The SAME jobId/runId under another profile store is an independent run.
  expect(ledger.isDelivered('beta', 'job-1', 'run-1')).toBe(false);
  expect(ledger.claim('beta', 'job-1', 'run-1').granted).toBe(true);
});

test('a released claim is retryable; a stale pending claim (crash) is flagged for reconciliation', () => {
  const filePath = tmpLedgerPath();
  let clock = 0;
  const ledger = homeChat.createCronDeliveryLedger({ filePath, now: () => clock });
  expect(ledger.claim('default', 'job-1', 'run-1').granted).toBe(true);
  ledger.release('default', 'job-1', 'run-1');
  const clean = ledger.claim('default', 'job-1', 'run-1');
  expect(clean.granted).toBe(true);
  expect(clean.retriedAfterCrash).toBe(false);
  // Fresh pending claim blocks a concurrent claimant…
  expect(ledger.claim('default', 'job-1', 'run-1').granted).toBe(false);
  // …until the retry window passes (crashed mid-delivery) — and the retry is
  // marked so the caller reconciles the transcript before appending again.
  clock = 11 * 60_000;
  const crashed = ledger.claim('default', 'job-1', 'run-1');
  expect(crashed.granted).toBe(true);
  expect(crashed.retriedAfterCrash).toBe(true);
});

// ── A2: controller end-to-end against a scripted sidecar ────────────────────
// Fixture mirrors production contracts (session-row /runs with paging, direct
// row lookup, transcript-sourced output). POST-append behavior is the
// documented FORWARD contract — not shipped-runtime acceptance.

const RUN_ID = 'cron_job-1_20260805-010000';
// Old enough that an empty transcript counts as definitively terminal.
const RUN_ENDED_AT = 100;

function scriptedSidecar({
  rows = vectorSessionRows(),
  appendStatus = 200,
  extraJobs = [],
  homeTranscript = [],
  runsByJob = null,
  runTranscripts = null,
  detailRows = [],
  baseJobDeliver = undefined,
  transcriptErrors = {},
  detailErrors = {},
  transcriptPageCap = 0,
} = {}) {
  const appended = [];
  const calls = [];
  const transcripts = new Map([
    [RUN_ID, [
      { role: 'user', content: 'nightly brief prompt' },
      { role: 'assistant', content: 'brief text' },
    ]],
    ['sess-home', [...homeTranscript]],
    ...(runTranscripts ? Object.entries(runTranscripts) : []),
  ]);
  const jobs = [
    { id: 'job-1', name: 'Nightly brief', profile: 'default', ...(baseJobDeliver !== undefined ? { deliver: baseJobDeliver } : {}) },
    ...extraJobs,
  ];
  const runs = runsByJob || {
    'job-1': [
      { id: RUN_ID, source: 'cron', started_at: 90, ended_at: RUN_ENDED_AT, last_active: 100, preview: 'nightly brief prompt' },
      { id: 'cron_job-1_20260805-020000', source: 'cron', started_at: 200, ended_at: null, preview: 'nightly brief prompt' },
    ],
  };
  const state = { appendStatus };
  const fetchApi = async (url, _token, options = {}) => {
    const method = (options.method || 'GET').toUpperCase();
    const parsed = new URL(url);
    calls.push(`${method} ${parsed.pathname}${parsed.search}`);
    if (parsed.pathname === '/api/sessions' && method === 'GET') {
      return { sessions: rows, total: rows.length };
    }
    if (parsed.pathname === '/api/cron/jobs' && method === 'GET') {
      // Production defaults to profile=all; the controller must always scope.
      const scope = parsed.searchParams.get('profile');
      const visible = scope && scope !== 'all' ? jobs.filter((job) => job.profile === scope) : jobs;
      return { jobs: visible };
    }
    const runsMatch = parsed.pathname.match(/^\/api\/cron\/jobs\/([^/]+)\/runs$/);
    if (runsMatch && method === 'GET') {
      const all = runs[decodeURIComponent(runsMatch[1])] || [];
      const limit = Number(parsed.searchParams.get('limit')) || 20;
      const offset = Number(parsed.searchParams.get('offset')) || 0;
      return { runs: all.slice(offset, offset + limit), limit };
    }
    const messagesMatch = parsed.pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/);
    if (messagesMatch && method === 'GET') {
      const id = decodeURIComponent(messagesMatch[1]);
      if (transcriptErrors[id]) {
        const err = new Error(`${transcriptErrors[id]}: transcript read failed`);
        err.statusCode = transcriptErrors[id];
        throw err;
      }
      const all = transcripts.get(id) ?? [];
      let limit = Number(parsed.searchParams.get('limit')) || all.length || 1;
      // Simulate a sidecar that clamps the page smaller than requested, so the
      // final message can sit beyond the first page — the caller must page.
      if (transcriptPageCap > 0) limit = Math.min(limit, transcriptPageCap);
      const offset = Number(parsed.searchParams.get('offset')) || 0;
      return { session_id: id, messages: all.slice(offset, offset + limit) };
    }
    if (messagesMatch && method === 'POST') {
      if (state.appendStatus >= 400) {
        const err = new Error(`${state.appendStatus}: nope`);
        if (state.appendStatus !== 599) err.statusCode = state.appendStatus;
        throw err;
      }
      const id = decodeURIComponent(messagesMatch[1]);
      appended.push({ path: parsed.pathname, body: options.body });
      if (!transcripts.has(id)) transcripts.set(id, []);
      transcripts.get(id).push(options.body);
      return { ok: true };
    }
    const detailMatch = parsed.pathname.match(/^\/api\/sessions\/([^/]+)$/);
    if (detailMatch && method === 'GET') {
      const id = decodeURIComponent(detailMatch[1]);
      if (detailErrors[id]) {
        // A non-404 lookup failure: the session's existence is UNVERIFIED
        // (transient), distinct from a 404 that proves it is gone.
        const err = new Error(`${detailErrors[id]}: session lookup failed`);
        err.statusCode = detailErrors[id];
        throw err;
      }
      const row = [...rows, ...detailRows].find((r) => r.id === id);
      if (!row) {
        const err = new Error('404: Session not found');
        err.statusCode = 404;
        throw err;
      }
      return { session: row };
    }
    throw new Error(`unexpected call: ${method} ${parsed.pathname}`);
  };
  return {
    fetchApi,
    appended,
    calls,
    transcripts,
    setAppendStatus: (status) => { state.appendStatus = status; },
  };
}

function makeConnection(profile = 'vector') {
  return async () => ({
    baseUrl: 'http://127.0.0.1:1',
    token: 't',
    profile,
    backendProfile: 'default',
  });
}

function makeController(sidecar, filePath = tmpLedgerPath(), nowFn = undefined, profile = 'vector') {
  return homeChat.createHomeChatController({
    connection: makeConnection(profile),
    ledgerPath: filePath,
    fetchApi: sidecar.fetchApi,
    ...(nowFn ? { now: nowFn } : {}),
  });
}

test('restoreHomeSession resolves the canonical pick and a seed script', async () => {
  const sidecar = scriptedSidecar();
  const controller = makeController(sidecar);
  const result = await controller.restoreHomeSession();
  expect(result.sessionId).toBe('sess-home');
  expect(result.script).toContain('hermes.desktop.lastSessionId');
  expect(sidecar.calls[0]).toContain('GET /api/sessions');
});

test('cron delivery reaches the home chat exactly once across repeated syncs and restarts', async () => {
  const sidecar = scriptedSidecar();
  const ledgerFile = tmpLedgerPath();
  const controller = makeController(sidecar, ledgerFile);

  const first = await controller.syncCronHomeDelivery();
  expect(first.ok).toBe(true);
  expect(first.delivered).toEqual([{ jobId: 'job-1', runId: RUN_ID, sessionId: 'sess-home' }]);
  expect(first.partial).toBeUndefined();

  const second = await controller.syncCronHomeDelivery();
  expect(second.delivered).toEqual([]);

  // App restart: a new controller over the same ledger file still refuses.
  const rebooted = makeController(sidecar, ledgerFile);
  const third = await rebooted.syncCronHomeDelivery();
  expect(third.delivered).toEqual([]);

  expect(sidecar.appended).toHaveLength(1);
  expect(sidecar.appended[0].path).toBe('/api/sessions/sess-home/messages');
  // The delivered text is the run transcript's FINAL ASSISTANT message (the
  // production run row carries only the prompt preview), plus the marker.
  expect(sidecar.appended[0].body.content).toContain('brief text');
  expect(sidecar.appended[0].body.content).not.toContain('nightly brief prompt');
  expect(sidecar.appended[0].body.content).toContain(homeChat.cronHomeDeliveryMarker('job-1', RUN_ID));
  // The append carries the sidecar-side idempotency key (the same per-run
  // marker) + a delivery display_kind, so the fork append route dedupes an
  // ambiguous-response retry (has_platform_message_id) as well as the ledger.
  expect(sidecar.appended[0].body.dedupe_key).toBe(homeChat.cronHomeDeliveryMarker('job-1', RUN_ID));
  expect(sidecar.appended[0].body.display_kind).toBe('ace-home-delivery');
  // Every cron call was profile-scoped — never the profile=all default.
  const cronCalls = sidecar.calls.filter((c) => c.includes('/api/cron/'));
  expect(cronCalls.length).toBeGreaterThan(0);
  for (const call of cronCalls) expect(call).toContain('profile=default');
});

test('the run transcript final message beyond the first page is still delivered', async () => {
  // The final assistant message sits past a clamped page; a single unpaginated
  // read would miss it and falsely confirm terminal-empty, losing the delivery.
  const sidecar = scriptedSidecar({
    transcriptPageCap: 2,
    runsByJob: { 'job-1': [{ id: RUN_ID, source: 'cron', ended_at: RUN_ENDED_AT, preview: 'nightly brief prompt' }] },
    runTranscripts: {
      [RUN_ID]: [
        { role: 'user', content: 'nightly brief prompt' },
        { role: 'tool', content: 'tool step one' },
        { role: 'tool', content: 'tool step two' },
        { role: 'assistant', content: 'FINAL brief on the last page' },
      ],
    },
  });
  const result = await makeController(sidecar).syncCronHomeDelivery();
  expect(result.delivered).toEqual([{ jobId: 'job-1', runId: RUN_ID, sessionId: 'sess-home' }]);
  expect(sidecar.appended).toHaveLength(1);
  expect(sidecar.appended[0].body.content).toContain('FINAL brief on the last page');
});

test('a full run window still delivers its deliverable run and reports partial', async () => {
  // 200 rows returned = a full window: older runs exist beyond it (historical,
  // deliberately not flooded), but the recent deliverable run must still land
  // and `partial` must signal the truncation rather than claim completeness.
  const pending = Array.from({ length: 199 }, (_v, i) => ({ id: `cron_job-1_p${i}`, source: 'cron', ended_at: null }));
  const sidecar = scriptedSidecar({
    runsByJob: { 'job-1': [{ id: RUN_ID, source: 'cron', ended_at: RUN_ENDED_AT, preview: 'nightly brief prompt' }, ...pending] },
  });
  const result = await makeController(sidecar).syncCronHomeDelivery();
  expect(result.delivered).toEqual([{ jobId: 'job-1', runId: RUN_ID, sessionId: 'sess-home' }]);
  expect(result.partial).toBe(true);
});

test("another profile's cron jobs are never delivered into this home chat", async () => {
  const sidecar = scriptedSidecar({
    extraJobs: [{ id: 'job-other', name: 'Scout job', profile: 'scout' }],
  });
  const controller = makeController(sidecar);
  const result = await controller.syncCronHomeDelivery();
  expect(result.ok).toBe(true);
  expect(result.delivered).toHaveLength(1);
  expect(result.delivered[0].jobId).toBe('job-1');
  // The other profile's job runs were never even fetched.
  expect(sidecar.calls.some((c) => c.includes('job-other'))).toBe(false);
});

test('a run backlog within the recent window is fully delivered (no per-job cap loss)', async () => {
  // 105 completed runs, all inside the most-recent window (200): every one is
  // delivered in a single windowed request and `partial` stays unset. The old
  // fixed per-job page cap silently lost the tail; the window does not.
  const backlog = [];
  const runTranscripts = {};
  for (let i = 0; i < 105; i += 1) {
    const id = `cron_job-1_${String(i).padStart(4, '0')}`;
    backlog.push({ id, source: 'cron', started_at: i, ended_at: i + 1, preview: 'p' });
    runTranscripts[id] = [
      { role: 'user', content: 'p' },
      { role: 'assistant', content: `result ${i}` },
    ];
  }
  const sidecar = scriptedSidecar({ runsByJob: { 'job-1': backlog }, runTranscripts });
  const controller = makeController(sidecar);
  const result = await controller.syncCronHomeDelivery();
  expect(result.ok).toBe(true);
  expect(result.delivered).toHaveLength(105);
  expect(result.partial).toBeUndefined();
  expect(sidecar.appended).toHaveLength(105);
});

test('an ambiguous append failure retains the claim and reconciles before any retry', async () => {
  const ledgerFile = tmpLedgerPath();
  let clock = 20 * 60_000;
  // 599 throws WITHOUT a statusCode — a transport-level failure whose write
  // outcome is unknown (timeout / connection reset).
  const sidecar = scriptedSidecar({ appendStatus: 599 });
  const controller = makeController(sidecar, ledgerFile, () => clock);

  const first = await controller.syncCronHomeDelivery();
  expect(first.delivered).toEqual([]);
  // The claim stays pending: an immediate retry must NOT re-append blindly.
  const second = await controller.syncCronHomeDelivery();
  expect(second.delivered).toEqual([]);
  expect(sidecar.appended).toHaveLength(0);

  // Case A: the ambiguous append actually LANDED (marker in the transcript).
  // After the stale window the retry reconciles and never appends again.
  sidecar.setAppendStatus(200);
  const marker = homeChat.cronHomeDeliveryMarker('job-1', RUN_ID);
  sidecar.transcripts.get('sess-home').push({ role: 'user', content: `Cron result\n\n${marker}` });
  clock += 11 * 60_000;
  const reconciled = await controller.syncCronHomeDelivery();
  expect(reconciled.delivered).toEqual([]);
  expect(sidecar.appended).toHaveLength(0);
  // Controller claims are scoped by logical+backend profile.
  expect(homeChat.createCronDeliveryLedger({ filePath: ledgerFile }).isDelivered('vector/default', 'job-1', RUN_ID)).toBe(true);
});

test('an ambiguous failure whose append did NOT land delivers exactly once after the window', async () => {
  const ledgerFile = tmpLedgerPath();
  let clock = 20 * 60_000;
  const sidecar = scriptedSidecar({ appendStatus: 599 });
  const controller = makeController(sidecar, ledgerFile, () => clock);
  await controller.syncCronHomeDelivery();
  expect(sidecar.appended).toHaveLength(0);
  // No marker in the transcript: the write provably never landed.
  sidecar.setAppendStatus(200);
  clock += 11 * 60_000;
  const retried = await controller.syncCronHomeDelivery();
  expect(retried.delivered).toHaveLength(1);
  expect(sidecar.appended).toHaveLength(1);
});

test('empty assistant output stays retryable until definitively terminal', async () => {
  const ledgerFile = tmpLedgerPath();
  // Run ended 1 minute ago (clock units: ms; ended_at: seconds).
  let clock = 10 * 60_000;
  const freshRun = { id: 'cron_job-1_fresh', source: 'cron', started_at: 500, ended_at: clock / 1000 - 60, preview: 'p' };
  const sidecar = scriptedSidecar({
    runsByJob: { 'job-1': [freshRun] },
    runTranscripts: { 'cron_job-1_fresh': [{ role: 'user', content: 'p' }] },
  });
  const controller = makeController(sidecar, ledgerFile, () => clock);
  const first = await controller.syncCronHomeDelivery();
  expect(first.delivered).toEqual([]);
  expect(sidecar.appended).toHaveLength(0);
  // The transcript flushes late: the run must still deliver.
  sidecar.transcripts.get('cron_job-1_fresh').push({ role: 'assistant', content: 'late result' });
  const second = await controller.syncCronHomeDelivery();
  expect(second.delivered).toHaveLength(1);
  expect(sidecar.appended[0].body.content).toContain('late result');

  // Terminal case: a run that ended long ago with no output is closed for
  // good — output appearing later (impossible in practice) changes nothing.
  clock += 60 * 60_000;
  const staleRun = { id: 'cron_job-1_stale', source: 'cron', started_at: 1, ended_at: 2, preview: 'p' };
  const sidecar2 = scriptedSidecar({
    runsByJob: { 'job-1': [staleRun] },
    runTranscripts: { 'cron_job-1_stale': [{ role: 'user', content: 'p' }] },
  });
  const controller2 = makeController(sidecar2, tmpLedgerPath(), () => clock);
  const third = await controller2.syncCronHomeDelivery();
  expect(third.delivered).toEqual([]);
  sidecar2.transcripts.get('cron_job-1_stale').push({ role: 'assistant', content: 'ghost' });
  const fourth = await controller2.syncCronHomeDelivery();
  expect(fourth.delivered).toEqual([]);
  expect(sidecar2.appended).toHaveLength(0);
});

test('concurrent sync triggers coalesce into one delivery', async () => {
  const sidecar = scriptedSidecar();
  const controller = makeController(sidecar);
  const [a, b] = await Promise.all([
    controller.syncCronHomeDelivery(),
    controller.syncCronHomeDelivery(),
  ]);
  expect(sidecar.appended).toHaveLength(1);
  expect(a).toBe(b);
});

test('delivery only ever targets the home chat — never a cron or worker session', async () => {
  // Only background sessions exist: sync must not deliver anywhere.
  const sidecar = scriptedSidecar({
    rows: [
      { id: 'sess-cron', source: 'cron', profile: 'vector', last_active: 9_000 },
      { id: 'sess-worker', source: 'worker', profile: 'vector', last_active: 8_000 },
    ],
  });
  const controller = makeController(sidecar);
  const result = await controller.syncCronHomeDelivery();
  expect(result.ok).toBe(true);
  expect(result.reason).toBe('no-home-session');
  expect(sidecar.appended).toHaveLength(0);
});

test('a sidecar without the append route fails closed and releases the claim for later', async () => {
  const ledgerFile = tmpLedgerPath();
  const missing = scriptedSidecar({ appendStatus: 405 });
  const controller = makeController(missing, ledgerFile);
  const result = await controller.syncCronHomeDelivery();
  expect(result.ok).toBe(false);
  expect(result.unsupported).toBe(true);
  expect(result.delivered).toEqual([]);

  // A capable sidecar later delivers the SAME run exactly once — immediately,
  // because a definitive no-write releases rather than parking the claim.
  const capable = scriptedSidecar();
  const retried = makeController(capable, ledgerFile);
  const retry = await retried.syncCronHomeDelivery();
  expect(retry.delivered).toHaveLength(1);
  expect(capable.appended).toHaveLength(1);
});

test('the canonical pick is pinned: a newer ordinary chat does not re-target restore or delivery', async () => {
  const ledgerFile = tmpLedgerPath();
  const rows = vectorSessionRows();
  const sidecar = scriptedSidecar({ rows });
  const controller = makeController(sidecar, ledgerFile);
  const first = await controller.restoreHomeSession();
  expect(first.sessionId).toBe('sess-home');
  // A second ordinary chat appears and is fresher — the pin must hold.
  rows.push({ id: 'sess-newer', source: 'desktop', profile: 'vector', last_active: 99_000, message_count: 3 });
  const second = await controller.restoreHomeSession();
  expect(second.sessionId).toBe('sess-home');
  const sweep = await controller.syncCronHomeDelivery();
  expect(sweep.delivered[0].sessionId).toBe('sess-home');
});

test('a pin outside the bounded shortlist is verified directly, not discarded', async () => {
  const ledgerFile = tmpLedgerPath();
  const rows = vectorSessionRows();
  const sidecar = scriptedSidecar({ rows });
  const controller = makeController(sidecar, ledgerFile);
  expect((await controller.restoreHomeSession()).sessionId).toBe('sess-home');
  // The pinned session ages out of the newest-50 window but still exists and
  // is eligible: the direct lookup must keep the pin.
  const aged = rows.filter((row) => row.id !== 'sess-home');
  aged.push({ id: 'sess-newer', source: 'desktop', profile: 'vector', last_active: 99_000, message_count: 3 });
  const agedSidecar = scriptedSidecar({
    rows: aged,
    detailRows: [{ id: 'sess-home', source: 'desktop', profile: 'vector', last_active: 1_000, message_count: 12, title: 'Vector home' }],
  });
  const agedController = makeController(agedSidecar, ledgerFile);
  expect((await agedController.restoreHomeSession()).sessionId).toBe('sess-home');
  expect(agedSidecar.calls.some((c) => c === 'GET /api/sessions/sess-home')).toBe(true);
  // Only a PROVEN-missing pin (direct 404) repicks.
  const goneSidecar = scriptedSidecar({ rows: aged });
  const goneController = makeController(goneSidecar, ledgerFile);
  expect((await goneController.restoreHomeSession()).sessionId).toBe('sess-newer');
});

test('upgrade with several eligible chats and no pin: the most-established chat is home, not the newest', async () => {
  // The exact upgrade recency-first picking got wrong: a user upgrades with an
  // established home AND a freshly-opened scratch chat, no pin yet. Home is the
  // one with accumulated history, never the newer-but-emptier scratch.
  const established = { id: 'sess-home', source: 'desktop', profile: 'vector', last_active: 1_000, message_count: 12, title: 'Vector home' };
  const scratch = { id: 'sess-scratch', source: 'desktop', profile: 'vector', last_active: 99_000, message_count: 2, title: 'quick question' };
  expect(homeChat.pickHomeRestoreSession([scratch, established], { profile: 'vector' }).id).toBe('sess-home');

  // End to end: the bootstrap pins the established chat and holds it even as an
  // even-newer empty chat appears afterward — the pin, not recency, is home.
  const ledgerFile = tmpLedgerPath();
  const rows = [established, scratch];
  const controller = makeController(scriptedSidecar({ rows }), ledgerFile);
  expect((await controller.restoreHomeSession()).sessionId).toBe('sess-home');
  rows.push({ id: 'sess-newer', source: 'desktop', profile: 'vector', last_active: 999_000, message_count: 1 });
  const sweep = await controller.syncCronHomeDelivery();
  expect(sweep.delivered[0].sessionId).toBe('sess-home');
});

test('delivery fails closed when the pinned home cannot be verified; restore keeps last-known-good', async () => {
  const ledgerFile = tmpLedgerPath();
  // Establish the pin on a healthy sidecar.
  expect((await makeController(scriptedSidecar(), ledgerFile).restoreHomeSession()).sessionId).toBe('sess-home');

  // The pin ages out of the shortlist AND its direct lookup fails transiently
  // (503, not 404) — existence unverified. A fresher eligible chat is present,
  // to prove delivery does not silently re-home onto it.
  const aged = vectorSessionRows().filter((row) => row.id !== 'sess-home');
  aged.push({ id: 'sess-newer', source: 'desktop', profile: 'vector', last_active: 99_000, message_count: 3 });
  const flaky = scriptedSidecar({ rows: aged, detailErrors: { 'sess-home': 503 } });
  const flakyController = makeController(flaky, ledgerFile);

  // Delivery fails closed: no append, no re-home, claim retriable next sweep.
  const sweep = await flakyController.syncCronHomeDelivery();
  expect(sweep.reason).toBe('no-home-session');
  expect(flaky.appended).toHaveLength(0);
  // Restore, by contrast, keeps last-known-good so the user still lands home.
  expect((await flakyController.restoreHomeSession()).sessionId).toBe('sess-home');

  // The pin was never discarded: once the lookup recovers, delivery lands on
  // sess-home — never the fresher sess-newer.
  const recovered = scriptedSidecar({
    rows: aged,
    detailRows: [{ id: 'sess-home', source: 'desktop', profile: 'vector', last_active: 1_000, message_count: 12, title: 'Vector home' }],
  });
  const recoveredSweep = await makeController(recovered, ledgerFile).syncCronHomeDelivery();
  expect(recoveredSweep.delivered[0].sessionId).toBe('sess-home');
});

test('restore keeps last-known-good and delivery fails closed when the shortlist request itself fails', async () => {
  const ledgerFile = tmpLedgerPath();
  // Establish the pin on a healthy sidecar.
  expect((await makeController(scriptedSidecar(), ledgerFile).restoreHomeSession()).sessionId).toBe('sess-home');

  // Now the shortlist request (GET /api/sessions) ITSELF fails transiently —
  // distinct from the direct pinned-session lookup covered above. The pin is
  // loaded before this request, so restore must still reopen last-known-good.
  const base = scriptedSidecar();
  const shortlistDown = {
    ...base,
    fetchApi: async (url, token, options = {}) => {
      const parsed = new URL(url);
      if (parsed.pathname === '/api/sessions' && (options.method || 'GET').toUpperCase() === 'GET') {
        const err = new Error('503: sessions shortlist unavailable');
        err.statusCode = 503;
        throw err;
      }
      return base.fetchApi(url, token, options);
    },
  };
  const controller = makeController(shortlistDown, ledgerFile);

  // Read side: last-known-good pin still reopens home despite the shortlist being down.
  expect((await controller.restoreHomeSession()).sessionId).toBe('sess-home');

  // Write side: delivery fails closed — no append into an unverified destination.
  const sweep = await controller.syncCronHomeDelivery();
  expect(sweep.reason).toBe('no-home-session');
  expect(base.appended).toHaveLength(0);
});

test('extractCompletedCronRuns consumes the production run-session row shape', () => {
  // _list_cron_job_runs_sync returns SESSION rows: cron_<jobId>_<ts> ids,
  // ended_at marks completion, preview carries the PROMPT (not the result).
  const runs = homeChat.extractCompletedCronRuns('job-1', {
    runs: [
      { id: 'cron_job-1_a', source: 'cron', started_at: 1, ended_at: 5, preview: 'prompt' },
      { id: 'cron_job-1_b', source: 'cron', started_at: 2, ended_at: null, preview: 'prompt' },
      { id: 'cron_job-2_c', source: 'cron', started_at: 3, ended_at: 9, preview: 'other job' },
      { id: 'unrelated', source: 'desktop', started_at: 4, ended_at: 9 },
    ],
  });
  expect(runs).toHaveLength(1);
  expect(runs[0]).toMatchObject({ jobId: 'job-1', runId: 'cron_job-1_a', finishedAt: 5 });
});

test('extractFinalAssistantOutput reads the last assistant message, string or part-list', () => {
  expect(
    homeChat.extractFinalAssistantOutput({
      messages: [
        { role: 'user', content: 'prompt' },
        { role: 'assistant', content: 'first' },
        { role: 'assistant', content: [{ type: 'text', text: 'final result' }] },
        { role: 'user', content: 'noise after' },
      ],
    })
  ).toBe('final result');
  expect(homeChat.extractFinalAssistantOutput({ messages: [{ role: 'user', content: 'only prompt' }] })).toBeNull();
  expect(homeChat.extractFinalAssistantOutput({ messages: [] })).toBeNull();
});

test('two logical profiles on identity-home backends (both backendProfile=default) never suppress each other', async () => {
  // Identity-home sidecars ALL report backendProfile 'default'; independent
  // state.dbs can mint identical cron_<jobId>_<ts> ids. The ledger scope must
  // include the logical operator profile or one delivery suppresses the other.
  const ledgerFile = tmpLedgerPath();
  const homeRows = (profile) => [
    { id: 'sess-home', source: 'desktop', profile: 'default', last_active: 1_000, message_count: 2 },
  ];
  const vectorSidecar = scriptedSidecar({ rows: homeRows('vector') });
  const scoutSidecar = scriptedSidecar({ rows: homeRows('scout') });
  const vectorController = makeController(vectorSidecar, ledgerFile, undefined, 'vector');
  const scoutController = makeController(scoutSidecar, ledgerFile, undefined, 'scout');

  const first = await vectorController.syncCronHomeDelivery();
  expect(first.delivered).toHaveLength(1);
  // Same job id, same run id, same shared ledger file — different operator.
  const second = await scoutController.syncCronHomeDelivery();
  expect(second.delivered).toHaveLength(1);
  expect(vectorSidecar.appended).toHaveLength(1);
  expect(scoutSidecar.appended).toHaveLength(1);
});

test('a corrupt ledger fails closed: reconciliation before any append, never fail-open redelivery', async () => {
  const ledgerFile = tmpLedgerPath();
  const marker = homeChat.cronHomeDeliveryMarker('job-1', RUN_ID);
  // The delivery already landed once; then the ledger file is corrupted.
  fs.writeFileSync(ledgerFile, '{"version":1,"entr'); // torn write
  const sidecar = scriptedSidecar({
    homeTranscript: [{ role: 'user', content: `Cron result\n\n${marker}` }],
  });
  const controller = makeController(sidecar, ledgerFile);
  const result = await controller.syncCronHomeDelivery();
  expect(result.ok).toBe(true);
  expect(result.delivered).toEqual([]);
  expect(sidecar.appended).toHaveLength(0);
  // The reconciled run is re-confirmed in the rebuilt ledger.
  expect(homeChat.createCronDeliveryLedger({ filePath: ledgerFile }).isDelivered('vector/default', 'job-1', RUN_ID)).toBe(true);

  // Corrupt ledger with NO marker in the transcript: the run provably never
  // delivered — it delivers exactly once.
  const ledgerFile2 = tmpLedgerPath();
  fs.writeFileSync(ledgerFile2, 'not json at all');
  const sidecar2 = scriptedSidecar();
  const controller2 = makeController(sidecar2, ledgerFile2);
  const retry = await controller2.syncCronHomeDelivery();
  expect(retry.delivered).toHaveLength(1);
  expect(sidecar2.appended).toHaveLength(1);
});

test('overlapping ledger instances cannot double-claim (atomic exclusive create + single-winner takeover)', () => {
  const filePath = tmpLedgerPath();
  const a = homeChat.createCronDeliveryLedger({ filePath });
  const b = homeChat.createCronDeliveryLedger({ filePath });
  // The claim is a wx-create marker file: a second instance racing the same
  // key hits EEXIST and stands down — no shared read-modify-write window.
  expect(a.claim('s', 'j', 'r').granted).toBe(true);
  expect(b.claim('s', 'j', 'r').granted).toBe(false);
  a.confirm('s', 'j', 'r');
  expect(b.isDelivered('s', 'j', 'r')).toBe(true);
  expect(b.claim('s', 'j', 'r').granted).toBe(false);

  // Stale takeover is an atomic rename: exactly one contender wins, and the
  // winner is flagged for marker reconciliation.
  let clock = 0;
  const c = homeChat.createCronDeliveryLedger({ filePath, now: () => clock });
  const d = homeChat.createCronDeliveryLedger({ filePath, now: () => clock });
  expect(c.claim('s', 'j', 'r2').granted).toBe(true);
  clock = 11 * 60_000;
  const winners = [c, d].map((ledger) => ledger.claim('s', 'j', 'r2')).filter((r) => r.granted);
  expect(winners).toHaveLength(1);
  expect(winners[0].retriedAfterCrash).toBe(true);
});

test('jobs with an explicit non-local delivery target are never home-relayed (no dual delivery)', async () => {
  const sidecar = scriptedSidecar({ baseJobDeliver: 'telegram' });
  const controller = makeController(sidecar);
  const result = await controller.syncCronHomeDelivery();
  expect(result.ok).toBe(true);
  expect(result.delivered).toEqual([]);
  expect(sidecar.appended).toHaveLength(0);
  // The relay never even fetched the platform-delivered job's runs.
  expect(sidecar.calls.some((c) => c.includes('/api/cron/jobs/job-1/runs'))).toBe(false);
});

test('a deleted run session is terminal-skipped without flagging the append route unsupported', async () => {
  const sidecar = scriptedSidecar({ transcriptErrors: { [RUN_ID]: 404 } });
  const ledgerFile = tmpLedgerPath();
  const controller = makeController(sidecar, ledgerFile);
  const result = await controller.syncCronHomeDelivery();
  expect(result.ok).toBe(true);
  expect(result.unsupported).toBeUndefined();
  expect(result.delivered).toEqual([]);
  expect(sidecar.appended).toHaveLength(0);
  // Permanently undeliverable — closed for good, no retry spin.
  expect(homeChat.createCronDeliveryLedger({ filePath: ledgerFile }).isDelivered('vector/default', 'job-1', RUN_ID)).toBe(true);
});

test('a failed reconciliation read keeps the claim pending — never append over an unknown outcome', async () => {
  const ledgerFile = tmpLedgerPath();
  let clock = 20 * 60_000;
  const ledger = homeChat.createCronDeliveryLedger({ filePath: ledgerFile, now: () => clock });
  // Unknown-outcome claim from a prior attempt.
  expect(ledger.claim('vector/default', 'job-1', RUN_ID).granted).toBe(true);
  clock += 11 * 60_000;
  const sidecar = scriptedSidecar({ transcriptErrors: { 'sess-home': 500 } });
  const controller = makeController(sidecar, ledgerFile, () => clock);
  const result = await controller.syncCronHomeDelivery();
  expect(result.delivered).toEqual([]);
  expect(sidecar.appended).toHaveLength(0);
  // The re-claimed pending entry still guards the run: an immediate retry is
  // refused rather than appending over the unknown outcome.
  expect(homeChat.createCronDeliveryLedger({ filePath: ledgerFile, now: () => clock }).claim('vector/default', 'job-1', RUN_ID).granted).toBe(false);
});

test('a gap claimant during a takeover is forced through reconciliation (steal tokens persist)', () => {
  const filePath = tmpLedgerPath();
  let clock = 0;
  const ledger = homeChat.createCronDeliveryLedger({ filePath, now: () => clock });
  // Stale claim gets taken over; simulate the loser's window by planting the
  // takeover token the winner keeps until confirm.
  expect(ledger.claim('s', 'j', 'r').granted).toBe(true);
  clock = 11 * 60_000;
  const takeover = ledger.claim('s', 'j', 'r');
  expect(takeover.granted).toBe(true);
  expect(takeover.retriedAfterCrash).toBe(true);
  // The takeover token survives a release: any later claimant — including a
  // FRESH wx-create that slips into the delete→recreate gap — still sees the
  // doubt and must reconcile before appending.
  ledger.release('s', 'j', 'r');
  const gapClaim = ledger.claim('s', 'j', 'r');
  expect(gapClaim.granted).toBe(true);
  expect(gapClaim.retriedAfterCrash).toBe(true);
  // confirm() resolves the key and retires the doubt: the next key claim in
  // this scope is clean again.
  ledger.confirm('s', 'j', 'r');
  expect(ledger.claim('s', 'j', 'r').granted).toBe(false);
  const fresh = ledger.claim('s', 'j', 'r2');
  expect(fresh.granted).toBe(true);
  expect(fresh.retriedAfterCrash).toBe(false);
});

test('an unsupported backend is recorded and not hammered; a respawned backend probes again', async () => {
  const sidecar = scriptedSidecar({ appendStatus: 405 });
  const controller = homeChat.createHomeChatController({
    connection: makeConnection(),
    ledgerPath: tmpLedgerPath(),
    fetchApi: sidecar.fetchApi,
  });
  const first = await controller.syncCronHomeDelivery();
  expect(first.unsupported).toBe(true);
  expect(first.suppressed).toBeUndefined();
  const callsAfterFirst = sidecar.calls.length;
  // Same backend: the known-missing route is not hammered again.
  const second = await controller.syncCronHomeDelivery();
  expect(second.unsupported).toBe(true);
  expect(second.suppressed).toBe(true);
  expect(sidecar.calls.length).toBe(callsAfterFirst);
  // A respawned sidecar has a fresh baseUrl — the same controller probes it.
  const capable = scriptedSidecar();
  const respawned = homeChat.createHomeChatController({
    connection: async () => ({ baseUrl: 'http://127.0.0.1:2', token: 't', profile: 'vector', backendProfile: 'default' }),
    ledgerPath: tmpLedgerPath(),
    fetchApi: capable.fetchApi,
  });
  const third = await respawned.syncCronHomeDelivery();
  expect(third.delivered).toHaveLength(1);
});

test('an append 404 (home session vanished) drops the pin and re-picks — never poisons the backend', async () => {
  const ledgerFile = tmpLedgerPath();
  const gone = scriptedSidecar({ appendStatus: 404 });
  const controller = makeController(gone, ledgerFile);
  const first = await controller.syncCronHomeDelivery();
  expect(first.ok).toBe(false);
  expect(first.reason).toBe('home-session-missing');
  expect(first.unsupported).toBeUndefined();
  // The backend is NOT suppressed and the pin was dropped: the next sweep on
  // the same baseUrl re-picks and delivers exactly once.
  gone.setAppendStatus(200);
  const second = await controller.syncCronHomeDelivery();
  expect(second.suppressed).toBeUndefined();
  expect(second.delivered).toHaveLength(1);
  expect(gone.appended).toHaveLength(1);
});

test('a legacy v1 ledger migrates faithfully: delivered entries never redeliver, pending entries reconcile', async () => {
  const ledgerFile = tmpLedgerPath();
  // v1 stored entries inline; the delivered key matches the controller scope.
  fs.writeFileSync(ledgerFile, JSON.stringify({
    version: 1,
    entries: {
      [`vector/default::job-1#${RUN_ID}`]: { status: 'delivered', at: 1 },
      ['vector/default::job-1#cron_job-1_pending']: { status: 'pending', at: 1 },
    },
  }) + '\n');
  const ledger = homeChat.createCronDeliveryLedger({ filePath: ledgerFile });
  // Migrated delivered entry: still delivered, never re-claimable.
  expect(ledger.isDelivered('vector/default', 'job-1', RUN_ID)).toBe(true);
  expect(ledger.claim('vector/default', 'job-1', RUN_ID).granted).toBe(false);
  // Migrated pending entry: unknown outcome — next claim must reconcile.
  const pending = ledger.claim('vector/default', 'job-1', 'cron_job-1_pending');
  expect(pending.granted).toBe(true);
  expect(pending.retriedAfterCrash).toBe(true);
  // End-to-end: a sweep over the migrated ledger delivers nothing new.
  const sidecar = scriptedSidecar();
  const controller = makeController(sidecar, ledgerFile);
  const result = await controller.syncCronHomeDelivery();
  expect(result.delivered).toEqual([]);
  expect(sidecar.appended).toHaveLength(0);
});

test('unsupported caching is per backend INSTANCE: a same-port respawn with a capable sidecar recovers', async () => {
  const ledgerFile = tmpLedgerPath();
  let token = 'spawn-1';
  const state = { sidecar: scriptedSidecar({ appendStatus: 405 }) };
  const controller = homeChat.createHomeChatController({
    connection: async () => ({ baseUrl: 'http://127.0.0.1:1', token, profile: 'vector', backendProfile: 'default' }),
    ledgerPath: ledgerFile,
    fetchApi: (url, t, options) => state.sidecar.fetchApi(url, t, options),
  });
  const first = await controller.syncCronHomeDelivery();
  expect(first.unsupported).toBe(true);
  const second = await controller.syncCronHomeDelivery();
  expect(second.suppressed).toBe(true);
  // Same port, NEW spawn (fresh per-spawn token), capable sidecar: probes again.
  token = 'spawn-2';
  state.sidecar = scriptedSidecar();
  const third = await controller.syncCronHomeDelivery();
  expect(third.suppressed).toBeUndefined();
  expect(third.delivered).toHaveLength(1);
});

test('unverifiable ledger state fails closed — an I/O error never permits an append', async () => {
  const sidecar = scriptedSidecar();
  const brokenFs = {
    ...fs,
    statSync: (p) => {
      if (String(p).includes('.delivered')) {
        const err = new Error('EACCES: permission denied');
        err.code = 'EACCES';
        throw err;
      }
      return fs.statSync(p);
    },
  };
  const controller = homeChat.createHomeChatController({
    connection: makeConnection(),
    ledgerPath: tmpLedgerPath(),
    fetchApi: sidecar.fetchApi,
    fsImpl: brokenFs,
  });
  const result = await controller.syncCronHomeDelivery();
  expect(result.delivered).toEqual([]);
  expect(sidecar.appended).toHaveLength(0);
});

test('sync coalescing is keyed per profile — one profile never receives another profile\'s sweep', async () => {
  const sidecar = scriptedSidecar();
  const controller = homeChat.createHomeChatController({
    connection: async (profile) => ({
      baseUrl: 'http://127.0.0.1:1',
      token: 't',
      profile: profile || 'vector',
      backendProfile: 'default',
    }),
    ledgerPath: tmpLedgerPath(),
    fetchApi: sidecar.fetchApi,
  });
  const [same1, same2] = await Promise.all([
    controller.syncCronHomeDelivery({ profile: 'vector' }),
    controller.syncCronHomeDelivery({ profile: 'vector' }),
  ]);
  expect(same1).toBe(same2);
  const other = controller.syncCronHomeDelivery({ profile: 'scout' });
  const again = controller.syncCronHomeDelivery({ profile: 'vector' });
  expect(other).not.toBe(again);
  await Promise.all([other, again]);
});

test('canonical pins are per-profile files — concurrent profiles never clobber each other', async () => {
  const ledgerFile = tmpLedgerPath();
  const rows = (profile) => [
    { id: `sess-home-${profile}`, source: 'desktop', profile: 'default', last_active: 1_000, message_count: 2 },
  ];
  const vectorController = makeController(scriptedSidecar({ rows: rows('vector') }), ledgerFile, undefined, 'vector');
  const scoutController = makeController(scriptedSidecar({ rows: rows('scout') }), ledgerFile, undefined, 'scout');
  const [v, s] = await Promise.all([
    vectorController.restoreHomeSession(),
    scoutController.restoreHomeSession(),
  ]);
  expect(v.sessionId).toBe('sess-home-vector');
  expect(s.sessionId).toBe('sess-home-scout');
  // Both pins persisted independently: fresh controllers read them back.
  const vAgain = makeController(scriptedSidecar({ rows: rows('vector') }), ledgerFile, undefined, 'vector');
  const sAgain = makeController(scriptedSidecar({ rows: rows('scout') }), ledgerFile, undefined, 'scout');
  expect((await vAgain.restoreHomeSession()).sessionId).toBe('sess-home-vector');
  expect((await sAgain.restoreHomeSession()).sessionId).toBe('sess-home-scout');
  const pinDir = `${ledgerFile}.canonical.json.d`;
  expect(fs.readdirSync(pinDir).sort()).toEqual(['scout.json', 'vector.json']);
});

test('a legacy combined pin file is honored read-only and cleared on drop', async () => {
  const ledgerFile = tmpLedgerPath();
  fs.writeFileSync(`${ledgerFile}.canonical.json`, JSON.stringify({
    version: 1,
    profiles: { vector: { sessionId: 'sess-home', pinnedAt: 1 } },
  }) + '\n');
  const sidecar = scriptedSidecar();
  const controller = makeController(sidecar, ledgerFile);
  expect((await controller.restoreHomeSession()).sessionId).toBe('sess-home');
  // Append-404 drops the pin from BOTH the pin dir and the legacy file.
  const gone = scriptedSidecar({ appendStatus: 404 });
  const dropController = makeController(gone, ledgerFile);
  await dropController.syncCronHomeDelivery();
  const legacy = JSON.parse(fs.readFileSync(`${ledgerFile}.canonical.json`, 'utf8'));
  expect(legacy.profiles.vector).toBeUndefined();
});

test('reconciliation pages the whole transcript — a marker beyond page one still prevents a duplicate', async () => {
  const ledgerFile = tmpLedgerPath();
  let clock = 20 * 60_000;
  const ledger = homeChat.createCronDeliveryLedger({ filePath: ledgerFile, now: () => clock });
  expect(ledger.claim('vector/default', 'job-1', RUN_ID).granted).toBe(true);
  // 500 filler messages push the crashed delivery's marker onto page two.
  const marker = homeChat.cronHomeDeliveryMarker('job-1', RUN_ID);
  const filler = Array.from({ length: 500 }, (_, i) => ({ role: 'user', content: `filler ${i}` }));
  const sidecar = scriptedSidecar({
    homeTranscript: [...filler, { role: 'user', content: `Cron result\n\n${marker}` }],
  });
  clock += 11 * 60_000;
  const controller = homeChat.createHomeChatController({
    connection: async () => ({ baseUrl: 'http://127.0.0.1:1', token: 't', profile: 'vector', backendProfile: 'default' }),
    ledgerPath: ledgerFile,
    fetchApi: sidecar.fetchApi,
    now: () => clock,
  });
  const result = await controller.syncCronHomeDelivery();
  expect(result.delivered).toEqual([]);
  expect(sidecar.appended).toHaveLength(0);
  expect(homeChat.createCronDeliveryLedger({ filePath: ledgerFile }).isDelivered('vector/default', 'job-1', RUN_ID)).toBe(true);
});

test('reconciliation survives a sidecar that clamps pages below the request — the marker past the clamp still blocks a duplicate', async () => {
  // A page-heuristic reconcile (advance by page*LIMIT, stop on a short page)
  // misses a marker beyond a clamped first page: it treats the short page as
  // end-of-transcript and re-appends. The reconcile must page by the ACTUAL
  // row count and stop only on an empty page.
  const ledgerFile = tmpLedgerPath();
  let clock = 20 * 60_000;
  const ledger = homeChat.createCronDeliveryLedger({ filePath: ledgerFile, now: () => clock });
  expect(ledger.claim('vector/default', 'job-1', RUN_ID).granted).toBe(true);
  const marker = homeChat.cronHomeDeliveryMarker('job-1', RUN_ID);
  // Clamp to 2 rows/page; the marker sits on the SECOND clamped page.
  const sidecar = scriptedSidecar({
    transcriptPageCap: 2,
    homeTranscript: [
      { role: 'user', content: 'filler 0' },
      { role: 'user', content: 'filler 1' },
      { role: 'user', content: 'filler 2' },
      { role: 'user', content: `Cron result\n\n${marker}` },
    ],
  });
  clock += 11 * 60_000;
  const controller = homeChat.createHomeChatController({
    connection: async () => ({ baseUrl: 'http://127.0.0.1:1', token: 't', profile: 'vector', backendProfile: 'default' }),
    ledgerPath: ledgerFile,
    fetchApi: sidecar.fetchApi,
    now: () => clock,
  });
  const result = await controller.syncCronHomeDelivery();
  expect(result.delivered).toEqual([]);
  expect(sidecar.appended).toHaveLength(0);
  expect(homeChat.createCronDeliveryLedger({ filePath: ledgerFile }).isDelivered('vector/default', 'job-1', RUN_ID)).toBe(true);
});

test('a wiped-storage restore writes the survival sentinel; explicit blank with intact storage is preserved', () => {
  const script = homeChat.buildHomeRestoreScript('sess-home', 'vector');
  // Wiped storage (no sentinel): restores and stamps the sentinel.
  const wiped = runRestoreScript(script, { hash: '#/' });
  expect(wiped.result.restored).toBe(true);
  expect(wiped.store.get('ace.homeRestore.epoch.vector')).toBeTruthy();
  // Intact storage (sentinel present) with deliberately-cleared session
  // memory and the blank route: the user's explicit blank state stays blank.
  const explicit = runRestoreScript(script, {
    hash: '#/',
    storage: { 'ace.homeRestore.epoch.vector': '123' },
  });
  expect(explicit.result.restored).toBe(false);
  expect(explicit.result.reason).toBe('explicit-blank');
  expect(explicit.store.get('hermes.desktop.lastSessionId.vector')).toBeUndefined();
});
