import { expect, test } from 'vitest';

const { broadcastFrameToClients } = require('../remote-server.cts');

function fakeClient() {
  const sent = [];
  return {
    readyState: 1,
    sent,
    send(frame) {
      sent.push(frame);
    },
  };
}

test('state frame is serialized once and delivered byte-identically to every client', () => {
  const a = fakeClient();
  const b = fakeClient();
  const payload = {
    workspaces: [{ id: 'w1', name: 'One', tasks: [{ id: 't1' }] }],
    missions: [],
  };

  const frame = broadcastFrameToClients(new Set([a, b]), 'state', payload);

  // Exactly one send per client, and both got the SAME serialized string.
  expect(a.sent.length).toBe(1);
  expect(b.sent.length).toBe(1);
  expect(a.sent[0]).toBe(frame);
  expect(b.sent[0]).toBe(frame);
  // Byte-identical across clients.
  expect(a.sent[0] === b.sent[0]).toBe(true);
  expect(a.sent[0]).toBe(JSON.stringify({ type: 'state', payload }));
});

test('broadcast skips clients whose socket is not open (readyState !== 1)', () => {
  const open = fakeClient();
  const closing = fakeClient();
  closing.readyState = 2; // CLOSING

  broadcastFrameToClients(new Set([open, closing]), 'state', { ok: true });

  expect(open.sent.length).toBe(1);
  expect(closing.sent.length).toBe(0);
});

test('broadcast returns null and sends nothing when the payload cannot be serialized', () => {
  const client = fakeClient();
  const circular = {};
  circular.self = circular;

  const frame = broadcastFrameToClients(new Set([client]), 'state', circular);

  expect(frame).toBe(null);
  expect(client.sent.length).toBe(0);
});

test('a client that throws on send does not abort delivery to the other clients', () => {
  const flaky = {
    readyState: 1,
    send() {
      throw new Error('socket write failed');
    },
  };
  const healthy = fakeClient();

  broadcastFrameToClients(new Set([flaky, healthy]), 'state', { ok: true });

  expect(healthy.sent.length).toBe(1);
});
