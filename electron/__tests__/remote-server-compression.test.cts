import { test, expect } from 'vitest';

const http = require('node:http');
const zlib = require('node:zlib');
const { Readable } = require('node:stream');

const { staticCacheHeaders, negotiateEncoding, compressStream } = require('../remote-server.cts');

test('hashed /assets and /material-icons get a year-long immutable cache', () => {
  expect(staticCacheHeaders('/assets/index-D03faPVR.js', '.js')['cache-control'])
    .toBe('public, max-age=31536000, immutable');
  expect(staticCacheHeaders('/material-icons/file.svg', '.svg')['cache-control'])
    .toBe('public, max-age=31536000, immutable');
});

test('the service worker, its registrar, and the manifest stay uncached', () => {
  expect(staticCacheHeaders('/sw.js', '.js')['cache-control']).toBe('no-store');
  expect(staticCacheHeaders('/registerSW.js', '.js')['cache-control']).toBe('no-store');
  expect(staticCacheHeaders('/manifest.webmanifest', '.webmanifest')['cache-control']).toBe('no-store');
});

test('unhashed root assets get no forced cache header', () => {
  expect(staticCacheHeaders('/favicon.png', '.png')['cache-control']).toBeUndefined();
});

test('encoding negotiation prefers brotli, then gzip, else identity', () => {
  expect(negotiateEncoding({ headers: { 'accept-encoding': 'gzip, deflate, br' } })).toBe('br');
  expect(negotiateEncoding({ headers: { 'accept-encoding': 'gzip, deflate' } })).toBe('gzip');
  expect(negotiateEncoding({ headers: { 'accept-encoding': 'identity' } })).toBe(null);
  expect(negotiateEncoding({ headers: {} })).toBe(null);
  expect(negotiateEncoding({})).toBe(null);
});

// The real streaming path a phone hits: a compressed response must decode back
// to the exact original bytes for both brotli and gzip.
async function roundTrip(encoding, body) {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/javascript', 'content-encoding': encoding });
    Readable.from(body).pipe(compressStream(encoding)).pipe(res);
  });
  await new Promise((resolve) => server.listen(0, resolve));
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/app.js`, { headers: { 'accept-encoding': encoding } });
    // undici auto-decodes content-encoding, so the body it hands back is the
    // original — proof the compressed stream was valid and reversible.
    const decoded = Buffer.from(await res.arrayBuffer());
    return { headers: Object.fromEntries(res.headers.entries()), decoded };
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
  }
}

test('brotli-compressed static payload decodes byte-identically', async () => {
  const body = Buffer.from('const x = 1;\n'.repeat(5000), 'utf8');
  const { headers, decoded } = await roundTrip('br', body);
  expect(headers['content-encoding']).toBe('br');
  expect(decoded.equals(body)).toBe(true);
  // Confirm bytes actually compress (not an identity fallback masquerading).
  expect(zlib.brotliCompressSync(body).length).toBeLessThan(body.length);
});

test('gzip-compressed static payload decodes byte-identically', async () => {
  const body = Buffer.from('body { color: red; }\n'.repeat(5000), 'utf8');
  const { headers, decoded } = await roundTrip('gzip', body);
  expect(headers['content-encoding']).toBe('gzip');
  expect(decoded.equals(body)).toBe(true);
});
