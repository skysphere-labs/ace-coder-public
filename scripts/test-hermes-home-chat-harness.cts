// Safe runtime harness for the vector-home-session fix (A4).
//
// Drives the REAL runtime modules over real loopback HTTP — no live Hermes
// data, no real sidecar; everything scoped to scratch dirs. Claimed scope:
//
//   ACCEPTANCE (shipped runtime behavior):
//   1. Reopening the bubble after the partition-hygiene storage clear
//      restores the exact canonical home chat: a marker survives two
//      simulated reopens, the fresher cron session is never the target, and
//      a newer ordinary chat cannot re-target the pin.
//   2. Against a sidecar shaped like TODAY's shipped fork lane (transcript
//      route GET-only), the delivery relay is inert and fail-closed:
//      unsupported, claims released, no transcript touched anywhere.
//
//   FORWARD CONTRACT (append capability — NOT shipped; pending a fork PR
//   adding POST /api/sessions/<id>/messages):
//   3. Once a capable sidecar exists, one local cron fixture's final result
//      appears in that SAME chat exactly once across repeated sweeps and a
//      simulated app restart, and released claims from a GET-only era
//      deliver exactly once later. The fixture serves the documented target
//      contract; it is a contract test, not shipped-runtime acceptance.
//
// Fixture responses mirror production shapes (_list_cron_job_runs_sync
// session rows; /messages transcripts). The SPA is a vm sandbox with the
// localStorage/location surface the seed script touches.

import assert from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

const { createHomeChatController } = require('../electron/hermes-home-chat.cts');

const TOKEN = 'harness-token';
const HOME_MARKER = 'MARKER-vector-home-7f3a';
const CRON_OUTPUT = 'CRON-RESULT-nightly-brief-2b81';
const RUN_ID = 'cron_job-nightly_20260805-040000';

type Message = { role: string; content: string; source?: string };

function startFixtureSidecar({ appendRoute = true } = {}) {
  const transcripts = new Map<string, Message[]>([
    ['sess-home', [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: `noted: ${HOME_MARKER}` },
    ]],
    // The cron run session: prompt + final assistant result (production
    // shape — the /runs row never carries the output).
    [RUN_ID, [
      { role: 'user', content: 'nightly brief prompt' },
      { role: 'assistant', content: CRON_OUTPUT },
    ]],
  ]);
  const sessions = [
    { id: 'sess-home', source: 'desktop', profile: 'vector', last_active: 1_000, message_count: 2, title: 'Vector home' },
    // Deliberately fresher than the home chat: a latest-session pick would
    // grab it; the policy must not.
    { id: RUN_ID, source: 'cron', profile: 'vector', last_active: 9_000, message_count: 2 },
  ];

  const server = http.createServer((req, res) => {
    const url = new URL(String(req.url), 'http://127.0.0.1');
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.headers['x-hermes-session-token'] !== TOKEN) {
      send(401, { detail: 'bad token' });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/sessions') {
      // Honor the server-side source exclusion the controller requests.
      const excluded = String(url.searchParams.get('exclude_sources') || '')
        .split(',').map((s) => s.trim()).filter(Boolean);
      const rows = sessions.filter((s) => !excluded.includes(s.source));
      send(200, { sessions: rows, total: rows.length });
      return;
    }
    const messagesMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/);
    if (messagesMatch) {
      const id = decodeURIComponent(messagesMatch[1]);
      if (!transcripts.has(id)) { send(404, { detail: 'no such session' }); return; }
      if (req.method === 'GET') {
        // Honor limit/offset like the real transcript route so paged reads
        // terminate (the controller pages the run transcript to its end).
        const all = transcripts.get(id)!;
        const limit = Number(url.searchParams.get('limit')) || all.length || 1;
        const offset = Number(url.searchParams.get('offset')) || 0;
        send(200, { session_id: id, messages: all.slice(offset, offset + limit) });
        return;
      }
      if (req.method === 'POST') {
        if (!appendRoute) {
          // Today's shipped fork lane registers GET only on this route.
          send(405, { detail: 'Method Not Allowed' });
          return;
        }
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          transcripts.get(id)!.push(body);
          send(200, { ok: true });
        });
        return;
      }
    }
    if (req.method === 'GET' && url.pathname === '/api/cron/jobs') {
      // Production defaults to profile=all; a scoped request narrows it. Ship
      // a foreign-profile job either way so the controller's scoping shows.
      const all = [
        { id: 'job-nightly', name: 'Nightly brief', deliver: 'local', profile: 'default' },
        { id: 'job-foreign', name: 'Scout job', deliver: 'local', profile: 'scout' },
      ];
      const scope = url.searchParams.get('profile');
      const jobs = scope && scope !== 'all' ? all.filter((j) => j.profile === scope) : all;
      send(200, { jobs });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/cron/jobs/job-nightly/runs') {
      // PRODUCTION row shape: session rows, ended_at marks completion,
      // preview is the prompt, never the result.
      send(200, {
        runs: [
          { id: RUN_ID, source: 'cron', started_at: 8_400, ended_at: 8_500, last_active: 8_500, preview: 'nightly brief prompt' },
        ],
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/cron/jobs/job-foreign/runs') {
      send(200, {
        runs: [
          { id: 'cron_job-foreign_1', source: 'cron', started_at: 1, ended_at: 2, preview: 'foreign prompt' },
        ],
      });
      return;
    }
    send(404, { detail: `unhandled ${req.method} ${url.pathname}` });
  });

  return new Promise<{
    baseUrl: string;
    sessions: typeof sessions;
    transcripts: Map<string, Message[]>;
    close: () => void;
  }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as { port: number };
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        sessions,
        transcripts,
        close: () => server.close(),
      });
    });
  });
}

// A fresh SPA window whose storage was wiped by the partition-hygiene clear.
function makeSpaWindow() {
  const store = new Map<string, string>();
  return {
    window: {
      __aceHomeRestoreRan: undefined as unknown,
      location: { hash: '#/' },
      localStorage: {
        getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
        setItem: (key: string, value: string) => { store.set(key, String(value)); },
      },
    },
    store,
  };
}

function makeConnection(baseUrl: string) {
  return async () => ({ baseUrl, token: TOKEN, profile: 'vector', backendProfile: 'default' });
}

async function main() {
  const sidecar = await startFixtureSidecar();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-home-chat-harness-'));
  const ledgerPath = path.join(scratch, 'cron-home-delivery.json');
  const connection = makeConnection(sidecar.baseUrl);
  const controller = createHomeChatController({ connection, ledgerPath });

  try {
    // ── Reopen #1: wiped storage → restore lands on the exact home chat ──
    const restore = await controller.restoreHomeSession();
    assert.strictEqual(restore.sessionId, 'sess-home', 'restore must pick the home chat, not the fresher cron session');
    const spa1 = makeSpaWindow();
    const outcome1 = vm.runInNewContext(restore.script, spa1);
    assert.strictEqual(outcome1.restored, true);
    assert.strictEqual(spa1.window.location.hash, '#/sess-home');
    assert.strictEqual(spa1.store.get('hermes.desktop.lastSessionId.vector'), 'sess-home');
    const restored1 = sidecar.transcripts.get('sess-home')!.map((m) => m.content).join('\n');
    assert.ok(restored1.includes(HOME_MARKER), 'the marker must survive into the restored chat');

    // ── Pin stability: a fresher ordinary chat must not re-target home ──
    sidecar.sessions.push({ id: 'sess-second-chat', source: 'desktop', profile: 'vector', last_active: 50_000, message_count: 5, title: 'Second chat' });
    sidecar.transcripts.set('sess-second-chat', [{ role: 'user', content: 'another conversation' }]);
    const pinned = await controller.restoreHomeSession();
    assert.strictEqual(pinned.sessionId, 'sess-home', 'the canonical pin must hold against a fresher ordinary chat');

    // ── Cron sweep ×2 + app restart: exactly one delivery in the same chat ──
    const sweep1 = await controller.syncCronHomeDelivery();
    assert.strictEqual(sweep1.ok, true, `first sweep failed: ${sweep1.reason}`);
    assert.strictEqual(sweep1.delivered.length, 1);
    assert.strictEqual(sweep1.delivered[0].sessionId, 'sess-home');
    assert.strictEqual(sweep1.delivered[0].runId, RUN_ID);
    const sweep2 = await controller.syncCronHomeDelivery();
    assert.strictEqual(sweep2.delivered.length, 0, 'second sweep must not redeliver');
    const rebooted = createHomeChatController({ connection, ledgerPath });
    const sweep3 = await rebooted.syncCronHomeDelivery();
    assert.strictEqual(sweep3.delivered.length, 0, 'a restarted app must not redeliver');

    const home = sidecar.transcripts.get('sess-home')!;
    const cronDeliveries = home.filter((m) => m.content.includes(`[ace-cron job-nightly#${RUN_ID}]`));
    assert.strictEqual(cronDeliveries.length, 1, 'the cron result must appear exactly once');
    assert.ok(cronDeliveries[0].content.includes(CRON_OUTPUT), 'the delivered message carries the final transcript output');
    assert.ok(!cronDeliveries[0].content.includes('nightly brief prompt'), 'the prompt preview is never what gets delivered');
    assert.strictEqual(sidecar.transcripts.get(RUN_ID)!.length, 2, 'no append may ever target a cron session');
    assert.ok(
      !home.some((m) => m.content.includes('job-foreign')),
      'another profile\'s cron job must never reach this home chat'
    );

    // ── Reopen #2: storage wiped again → same chat, marker AND cron result ──
    const restoreAgain = await controller.restoreHomeSession();
    assert.strictEqual(restoreAgain.sessionId, 'sess-home');
    const spa2 = makeSpaWindow();
    const outcome2 = vm.runInNewContext(restoreAgain.script, spa2);
    assert.strictEqual(outcome2.restored, true);
    assert.strictEqual(spa2.window.location.hash, '#/sess-home');
    const restored2 = home.map((m) => m.content).join('\n');
    assert.ok(restored2.includes(HOME_MARKER), 'the marker must survive the second reopen');
    assert.ok(restored2.includes(CRON_OUTPUT), 'the cron result stays in the restored chat');

    // ── Explicit New Chat stays blank: a remembered session blocks the seed ──
    const spa3 = makeSpaWindow();
    spa3.store.set('hermes.desktop.lastSessionId.vector', 'sess-new-chat');
    const outcome3 = vm.runInNewContext(restoreAgain.script, spa3);
    assert.strictEqual(outcome3.restored, false);
    assert.strictEqual(outcome3.reason, 'remembered-session');
    assert.strictEqual(spa3.window.location.hash, '#/');

    // ── Explicit blank with INTACT storage (survival sentinel present, session
    // memory deliberately cleared): never restored over ──
    const spa4 = makeSpaWindow();
    spa4.store.set('ace.homeRestore.epoch.vector', '1');
    const outcome4 = vm.runInNewContext(restoreAgain.script, spa4);
    assert.strictEqual(outcome4.restored, false);
    assert.strictEqual(outcome4.reason, 'explicit-blank');
    assert.strictEqual(spa4.window.location.hash, '#/');

    process.stdout.write('[harness] ACCEPTANCE PASS marker survives reopen (x2) on the canonical home chat\n');
    process.stdout.write('[harness] ACCEPTANCE PASS canonical pin holds against a fresher ordinary chat\n');
    process.stdout.write('[harness] CONTRACT PASS (append capability, fixture route) one local cron fixture delivered into the same chat exactly once\n');
    process.stdout.write('[harness] ACCEPTANCE PASS explicit New Chat / explicit blank state is never overridden\n');
  } finally {
    sidecar.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  }

  // ── Phase 3: today's SHIPPED sidecar (GET-only transcript route) ──
  const shipped = await startFixtureSidecar({ appendRoute: false });
  const scratch2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-home-chat-harness-shipped-'));
  try {
    const shippedController = createHomeChatController({
      connection: makeConnection(shipped.baseUrl),
      ledgerPath: path.join(scratch2, 'cron-home-delivery.json'),
    });
    const sweep = await shippedController.syncCronHomeDelivery();
    assert.strictEqual(sweep.ok, false);
    assert.strictEqual(sweep.unsupported, true, 'a GET-only sidecar must report unsupported');
    assert.strictEqual(sweep.delivered.length, 0);
    assert.strictEqual(shipped.transcripts.get('sess-home')!.length, 2, 'fail-closed: the home transcript is untouched');
    // The claim was released: a capable sidecar delivers the SAME run later.
    const capable = await startFixtureSidecar();
    try {
      const retried = createHomeChatController({
        connection: makeConnection(capable.baseUrl),
        ledgerPath: path.join(scratch2, 'cron-home-delivery.json'),
      });
      const retry = await retried.syncCronHomeDelivery();
      assert.strictEqual(retry.delivered.length, 1, 'the released claim must deliver once on a capable sidecar');
    } finally {
      capable.close();
    }
    process.stdout.write('[harness] ACCEPTANCE PASS shipped (GET-only) sidecar: relay inert + fail-closed; released claim delivers exactly once on a capable (contract) sidecar\n');
  } finally {
    shipped.close();
    fs.rmSync(scratch2, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('[harness] FAIL', err);
  process.exit(1);
});
