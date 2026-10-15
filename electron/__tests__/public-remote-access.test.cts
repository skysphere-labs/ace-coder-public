const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { createRemoteServer } = require('../remote-server.cts');

function fixture(mode = 'loopback', port = 9419) {
  const settings = { enabled: false, tunnelMode: mode, port, serverSecret: 'synthetic-local-test-secret' };
  const devices = [];
  let privateCalls = 0;
  const store = {
    getRemoteSettings: () => ({ ...settings, cloudflareDomain: 'private.example.test' }),
    setRemoteTunnelMode: (value) => { settings.tunnelMode = value; },
    setRemoteEnabled: (value) => { settings.enabled = value; },
    onState: () => () => {},
    getState: () => ({ workspaces: [] }),
    updateTask: (payload) => ({ id: payload.id }),
    registerRemoteDevice: ({ name, tokenHash }) => {
      const device = { id: `device-${devices.length}`, name, tokenHash, revoked: false };
      devices.push(device);
      return device;
    },
    findRemoteDeviceByHash: (hash) => devices.find((device) => device.tokenHash === hash),
    touchRemoteDevice: () => {},
    listRemoteDevices: () => devices,
  };
  for (const method of ['ticketsStart', 'teamTicketsList', 'teamTicketsSave', 'teamTicketsGet', 'teamTicketsSearch', 'teamTicketsAgents', 'teamTicketsLaunch', 'teamTicketsDelete', 'updateInstall', 'cloudflareInventory', 'setRemoteCloudflareConfig']) {
    store[method] = () => { privateCalls += 1; };
  }
  return { server: createRemoteServer({ aceStore: store }), settings, devices, privateCalls: () => privateCalls };
}

async function freePort() {
  const socket = net.createServer();
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

function request(port, route, body = {}, token = null, host = `127.0.0.1:${port}`) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: route, method: 'POST',
      headers: { host, 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    }, (res) => {
      let bodyText = '';
      res.on('data', (chunk) => { bodyText += chunk; });
      res.on('end', () => {
        let body = bodyText;
        try { body = JSON.parse(bodyText); } catch {}
        resolve({ status: res.statusCode, body });
      });
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

test('unsupported saved exposure modes become loopback without rewriting the database', async () => {
  const { server, settings } = fixture('cloudflared');
  server.refreshSettings();
  assert.equal(server.getStatus().tunnelMode, 'loopback');
  assert.equal(server.primaryUrl(), 'http://127.0.0.1:9419');
  assert.equal(settings.tunnelMode, 'cloudflared');
  assert.equal(server.getStatus().enabled, false);
  assert.equal('cloudflareDomain' in server.getStatus(), false);
  assert.equal('serverSecret' in server.getStatus(), false);
  await assert.rejects(server.setTunnelMode('cloudflared'), /Unsupported remote access mode/);
  for (const mode of ['lan', 'tailscale', 'loopback']) {
    assert.equal((await server.setTunnelMode(mode)).tunnelMode, mode);
  }
});

test('paired remote API preserves authorization while refusing removed private capabilities', async (t) => {
  const port = await freePort();
  const { server, devices, privateCalls } = fixture('loopback', port);
  const oldPath = process.env.PATH;
  process.env.PATH = '';
  t.after(async () => {
    await server.stop();
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
  });
  await server.start();
  assert.equal((await request(port, '/api/getState')).status, 403);
  assert.equal((await request(port, '/enroll', { enrollmentToken: 'invalid' })).status, 403);
  const enrollment = server.mintEnrollment();
  const paired = await request(port, '/enroll', { enrollmentToken: enrollment.token, name: 'Test device' });
  assert.equal(paired.status, 200);
  assert.equal((await request(port, '/enroll', { enrollmentToken: enrollment.token })).status, 403);
  const token = paired.body.token;
  assert.equal((await request(port, '/api/getState', {}, token)).status, 200);
  assert.equal((await request(port, '/api/getState', {}, token, 'private.example.test')).status, 403);
  const status = await request(port, '/api/remoteGetStatus', {}, token);
  assert.equal(status.status, 200);
  assert.equal('cloudflareDomain' in status.body.result, false);
  assert.equal('serverSecret' in status.body.result, false);
  for (const method of ['ticketsStart', 'teamTicketsList', 'teamTicketsSave', 'teamTicketsGet', 'teamTicketsSearch', 'teamTicketsAgents', 'teamTicketsLaunch', 'teamTicketsDelete', 'updateInstall', 'cloudflareInventory', 'setRemoteCloudflareConfig']) {
    assert.equal((await request(port, `/api/${method}`, {}, token)).status, 404);
  }
  assert.equal(privateCalls(), 0);
  assert.equal((await request(port, '/api/updateTask', { id: 'task-1' }, token)).status, 200);
  assert.equal((await request(port, '/api/remoteMintEnrollment', {}, token)).status, 200);
  devices[0].revoked = true;
  assert.equal((await request(port, '/api/getState', {}, token)).status, 403);
});
