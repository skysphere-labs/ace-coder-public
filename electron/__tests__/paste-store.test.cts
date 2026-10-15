import { test, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const { writePasteImage, coerceBuffer } = require('../paste-store.cts');

const PAYLOAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function withTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ace-paste-test-'));
}

test('coerceBuffer accepts base64 strings (HTTP/PWA bridge contract)', () => {
  const base64 = PAYLOAD.toString('base64');
  const buf = coerceBuffer(base64);
  expect(buf).toBeInstanceOf(Buffer);
  expect(Buffer.compare(buf, PAYLOAD)).toBe(0);
});

test('coerceBuffer accepts Uint8Array (Electron IPC contract)', () => {
  const buf = coerceBuffer(new Uint8Array(PAYLOAD));
  expect(buf).toBeInstanceOf(Buffer);
  expect(Buffer.compare(buf, PAYLOAD)).toBe(0);
});

test('coerceBuffer rebuilds a numeric-keyed object (JSON-serialized Uint8Array)', () => {
  // This is what JSON.stringify(new Uint8Array([…])) produces — the regression
  // that broke PWA attachments because the old coerceBuffer returned null
  // for plain objects and writePasteImage silently produced { path: null }.
  const jsonShaped = {};
  for (let i = 0; i < PAYLOAD.length; i += 1) {
    jsonShaped[String(i)] = PAYLOAD[i];
  }
  const buf = coerceBuffer(jsonShaped);
  expect(buf).toBeInstanceOf(Buffer);
  expect(Buffer.compare(buf, PAYLOAD)).toBe(0);
});

test('coerceBuffer rejects unrelated objects', () => {
  expect(coerceBuffer(null)).toBeNull();
  expect(coerceBuffer({ unrelated: 'shape' })).toBeNull();
});

test('writePasteImage persists a PNG via base64 (image attachment path)', async () => {
  const dir = withTempDir();
  try {
    const result = await writePasteImage({
      bytes: PAYLOAD.toString('base64'),
      ext: 'png',
      baseTempDir: dir,
    });
    expect(result.path).toBeTruthy();
    expect(result.path.endsWith('.png')).toBe(true);
    const written = fs.readFileSync(result.path);
    expect(Buffer.compare(written, PAYLOAD)).toBe(0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writePasteImage persists a non-image file (generic File attachment path)', async () => {
  const dir = withTempDir();
  try {
    const text = Buffer.from('hello, attachment\n');
    const result = await writePasteImage({
      bytes: text.toString('base64'),
      ext: 'txt',
      baseTempDir: dir,
    });
    expect(result.path).toBeTruthy();
    expect(result.path.endsWith('.txt')).toBe(true);
    expect(fs.readFileSync(result.path, 'utf8')).toBe('hello, attachment\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writePasteImage persists when bytes arrive as a JSON-serialized Uint8Array', async () => {
  // PWA/HTTP regression coverage: even if a caller forgets to base64-encode,
  // the receiver should still rebuild a Buffer from the numeric-keyed object.
  const dir = withTempDir();
  const jsonShaped = {};
  for (let i = 0; i < PAYLOAD.length; i += 1) {
    jsonShaped[String(i)] = PAYLOAD[i];
  }
  try {
    const result = await writePasteImage({
      bytes: jsonShaped,
      ext: 'png',
      baseTempDir: dir,
    });
    expect(result.path).toBeTruthy();
    const written = fs.readFileSync(result.path);
    expect(Buffer.compare(written, PAYLOAD)).toBe(0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writePasteImage surfaces an error string for empty input', async () => {
  const dir = withTempDir();
  try {
    const result = await writePasteImage({ bytes: '', ext: 'png', baseTempDir: dir });
    expect(result.path).toBeNull();
    expect(typeof result.error).toBe('string');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
