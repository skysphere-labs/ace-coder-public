import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const { rewriteHermesDesktopProxyText } = require('../remote-server.cts');

test('remote server injects a root base tag for deep-link mobile asset loading', () => {
  const remote = readFileSync(join(process.cwd(), 'electron/remote-server.cts'), 'utf8');

  assert.match(remote, /function htmlWithRemoteBase\(data: any\)/);
  assert.match(remote, /<base href="\/" data-ace-remote-base \/>/);
  assert.match(remote, /function sendIndexHtml\(res: any, data: any\)/);
  assert.ok(remote.includes("if (ext === '.html')"));
  assert.match(remote, /if \(ext === '[^']+'\) \{[\s\S]*sendIndexHtml\(res, data\);/);
  assert.match(remote, /const fallback = path\.join\(distDir, 'index\.html'\);[\s\S]*sendIndexHtml\(res, data\);/);
});

test('remote server does not let mobile PWA bootstrap files stay cached', () => {
  const remote = readFileSync(join(process.cwd(), 'electron/remote-server.cts'), 'utf8');

  assert.match(remote, /function staticCacheHeaders\(relPath: string, ext: string\)/);
  assert.match(remote, /relPath === '\/sw\.js'/);
  assert.match(remote, /relPath === '\/registerSW\.js'/);
  assert.match(remote, /ext === '\.webmanifest'/);
  assert.match(remote, /'cache-control': 'no-store'/);
  assert.match(remote, /\.\.\.staticCacheHeaders\(relPath, ext\)/);
});

test('remote server permits clipboard APIs only on the proxied Hermes Desktop mobile surface', () => {
  const remote = readFileSync(join(process.cwd(), 'electron/remote-server.cts'), 'utf8');

  assert.match(remote, /const HERMES_DESKTOP_CLIPBOARD_PERMISSIONS_POLICY = 'clipboard-read=\(self\), clipboard-write=\(self\)'/);
  assert.match(remote, /function withHermesDesktopClipboardPolicy\(headers: any = \{\}\)/);
  assert.match(remote, /delete next\['permissions-policy'\]/);
  assert.match(remote, /delete next\['feature-policy'\]/);
  assert.match(remote, /next\['permissions-policy'\] = HERMES_DESKTOP_CLIPBOARD_PERMISSIONS_POLICY/);
  assert.match(remote, /const responseHeaders = withHermesDesktopClipboardPolicy\(headers\)/);
  assert.match(remote, /delete responseHeaders\['transfer-encoding'\]/);
  assert.equal((remote.match(/withHermesDesktopClipboardPolicy\(/g) || []).length, 2);
  const sendIndex = remote.slice(remote.indexOf('function sendIndexHtml'), remote.indexOf('function staticCacheHeaders'));
  const proxyVite = remote.slice(remote.indexOf('function proxyToVite'), remote.indexOf('function proxyViteUpgrade'));
  const serveFromDist = remote.slice(remote.indexOf('function serveFromDist'), remote.indexOf('function handleUpgrade'));
  assert.doesNotMatch(sendIndex, /withHermesDesktopClipboardPolicy/);
  assert.doesNotMatch(proxyVite, /withHermesDesktopClipboardPolicy/);
  assert.doesNotMatch(serveFromDist, /withHermesDesktopClipboardPolicy/);
});

test('remote Hermes Desktop proxy rewrites dashboard base path and absolute assets', () => {
  const html = [
    '<script type="module" src="/assets/index.js"></script>',
    '<link rel="stylesheet" href="/assets/index.css">',
    '<script>window.__HERMES_BASE_PATH__="";</script>',
  ].join('');
  const rewritten = rewriteHermesDesktopProxyText(html, 'text/html; charset=utf-8');
  assert.match(rewritten, /src="\/hermes-desktop\/assets\/index\.js"/);
  assert.match(rewritten, /href="\/hermes-desktop\/assets\/index\.css"/);
  assert.match(rewritten, /window\.__HERMES_BASE_PATH__="\/hermes-desktop"/);

  const css = '.logo{background:url(/assets/logo.png)}';
  assert.equal(
    rewriteHermesDesktopProxyText(css, 'text/css'),
    '.logo{background:url(/hermes-desktop/assets/logo.png)}'
  );
});

test('remote Hermes Desktop proxy strips remote credentials and tracks raw tunnels', () => {
  const remote = readFileSync(join(process.cwd(), 'electron/remote-server.cts'), 'utf8');

  assert.match(remote, /delete headers\.authorization;/);
  assert.match(remote, /delete headers\['proxy-authorization'\];/);
  assert.match(remote, /const hermesProxySockets = new Set\(\);/);
  assert.match(remote, /function trackHermesProxySocket\(socket: any, deviceId: any = null\)/);
  assert.match(remote, /trackHermesProxySocket\(socket, device\.id\);/);
  assert.match(remote, /trackHermesProxySocket\(upstream, device\.id\);/);
  assert.match(remote, /for \(const socket of \[\.\.\.hermesProxySockets\]\)/);
});

test('remote Hermes Desktop proxy is single-sidecar: one app sidecar, no per-profile sub-proxy', () => {
  const remote = readFileSync(join(process.cwd(), 'electron/remote-server.cts'), 'utf8');

  // The old multi-profile (/__profile/) sub-proxy is removed — mobile hosts the
  // SAME single app sidecar the desktop webview does.
  assert.doesNotMatch(remote, /HERMES_DESKTOP_PROFILE_PROXY_PREFIX/);
  assert.doesNotMatch(remote, /function hermesDesktopProxyRoute/);
  assert.doesNotMatch(remote, /__profile/);
  // HTTP + websocket both proxy to the base app-sidecar target.
  assert.match(remote, /async function hermesDesktopProxyTarget\(\)/);
  assert.match(remote, /path: upstreamHermesPath\(url\)/);
  assert.match(remote, /GET \$\{upstreamHermesPath\(url\)\} HTTP\/1\.1/);
});

test('remote server closes revoked device websocket and Hermes proxy tunnels', () => {
  const remote = readFileSync(join(process.cwd(), 'electron/remote-server.cts'), 'utf8');

  assert.match(remote, /function closeDeviceConnections\(deviceId: any/);
  assert.match(remote, /aceStore\.onRemoteDevicesChanged/);
  assert.match(remote, /\(ws as any\)\.aceDeviceId !== deviceId/);
  assert.match(remote, /\(socket as any\)\.aceDeviceId !== deviceId/);
  assert.match(remote, /if \(deviceIsRevoked\(device\.id\)\)/);
});

test('remote server cleans up failed starts and rebinds when tunnel mode changes bind host', () => {
  const remote = readFileSync(join(process.cwd(), 'electron/remote-server.cts'), 'utf8');

  assert.match(remote, /let boundHost: any = null;/);
  assert.match(remote, /function desiredBindHost\(\)/);
  assert.match(remote, /catch \(err\) \{[\s\S]*wsServer = null;[\s\S]*httpServer = null;[\s\S]*boundHost = null;[\s\S]*throw err;/);
  assert.match(remote, /boundHost = bindHost;/);
  assert.match(remote, /previousBindHost && previousBindHost !== desiredBindHost\(\)/);
  assert.match(remote, /await stop\(\);[\s\S]*await start\(\);/);
});

test('Hermes Desktop resource trust uses exact platform app.asar entrypoints', () => {
  const dashboard = readFileSync(join(process.cwd(), 'electron/hermes-dashboard.cts'), 'utf8');

  assert.match(dashboard, /function trustedHermesDesktopApp\(options: any = \{\}\)/);
  assert.match(dashboard, /resolveHermesDesktopApp\(config, fsImpl, options\.globalHermesHome \|\| defaultGlobalHermesHome\)/);
  assert.match(dashboard, /const expected = normalizeTrustedResourcePath/);
  assert.match(dashboard, /if \(resolved !== expected\) return false;/);
  assert.doesNotMatch(dashboard, /resolved\.endsWith\(suffix\)/);
});

test('remote bridge keeps operator methods available without a private updater', () => {
  const remote = readFileSync(join(process.cwd(), 'electron/remote-server.cts'), 'utf8');

  assert.doesNotMatch(remote, /appUpdater|onUpdateEvent|REMOTE_UPDATE_METHODS/);
  assert.match(remote, /if \(method === 'operatorsList'\) \{[\s\S]*operators\.loadOperatorsConfig\(userDataPath\)/);
  assert.match(remote, /if \(method === 'operatorsSave'\) \{[\s\S]*operators\.saveOperatorsConfig\(userDataPath, payload\?\.config\)/);
});

test('remote dev server proxies Vite websocket upgrades only in dev proxy mode', () => {
  const remote = readFileSync(join(process.cwd(), 'electron/remote-server.cts'), 'utf8');

  assert.match(remote, /function proxyViteUpgrade\(req: any, socket: any, head: any, url: any\)/);
  assert.match(remote, /const upstream = net\.connect\(Number\(target\.port\) \|\| 80, target\.hostname\)/);
  assert.match(remote, /if \(headers\.origin\) headers\.origin = target\.origin;/);
  assert.match(remote, /if \(url\.pathname !== '\/ws'\) \{[\s\S]*if \(devProxyUrl\) \{[\s\S]*proxyViteUpgrade\(req, socket, head, url\);/);
});
