// Tests for the release architecture gate (scripts/verify-artifact-arch.cts).
//
// Headers are synthesized byte-by-byte so the gate is exercised without
// shipping real 150MB binaries: thin/fat Mach-O, PE with a large DOS stub,
// truncated and lying headers, and bundle/executable resolution.
//
// NOTE: vitest loads test entry files through Rollup's plain-JS parser, so
// this file must stay JS-compatible (no TS annotation syntax).

import { expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const {
  verifyArtifactArch,
  binaryArchs,
  mainExecutable,
  foreignArchBinaries,
  isForeignArchPath,
} = require('../../scripts/verify-artifact-arch.cts');

const CPU_TYPE_X86_64 = 0x01000007;
const CPU_TYPE_ARM64 = 0x0100000c;

function tmpDir(name = 'arch') {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ace-verify-arch-${name}-`));
}

/** Thin 64-bit Mach-O header (host-endian magic + cputype), zero-padded. */
function thinMacho(cpuType = CPU_TYPE_ARM64, pad = 256) {
  const buf = Buffer.alloc(pad);
  buf.writeUInt32LE(0xfeedfacf, 0);
  buf.writeUInt32LE(cpuType, 4);
  return buf;
}

/**
 * 32-bit fat Mach-O wrapper. `declared` are the cputypes in the fat table;
 * `actual` are the cputypes of the thin slices they point at — they differ
 * only when a test is deliberately building a lying wrapper.
 */
function fatMacho(declared = [CPU_TYPE_ARM64], actual = declared, sliceGap = 0) {
  const entrySize = 20;
  const tableEnd = 8 + declared.length * entrySize;
  const sliceSize = 256;
  const firstSlice = tableEnd + sliceGap;
  const total = firstSlice + declared.length * sliceSize;
  const buf = Buffer.alloc(total);
  buf.writeUInt32BE(0xcafebabe, 0);
  buf.writeUInt32BE(declared.length, 4);
  declared.forEach((cpu, i) => {
    const base = 8 + i * entrySize;
    const offset = firstSlice + i * sliceSize;
    buf.writeUInt32BE(cpu, base);
    buf.writeUInt32BE(0, base + 4);
    buf.writeUInt32BE(offset, base + 8);
    buf.writeUInt32BE(sliceSize, base + 12);
    buf.writeUInt32BE(12, base + 16);
    if (actual[i] !== undefined) thinMacho(actual[i], sliceSize).copy(buf, offset);
  });
  return buf;
}

/** PE with a configurable DOS stub size, so e_lfanew can sit past any fixed read. */
function pe(machine = 0x8664, stubBytes = 0x80) {
  const peOffset = 0x40 + stubBytes;
  const buf = Buffer.alloc(peOffset + 64);
  buf.writeUInt16LE(0x5a4d, 0);
  buf.writeUInt32LE(peOffset, 0x3c);
  buf.writeUInt32LE(0x00004550, peOffset);
  buf.writeUInt16LE(machine, peOffset + 4);
  return buf;
}

function writeFile(dir = '', name = '', bytes = Buffer.alloc(0)) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, bytes);
  return p;
}

function makeAppBundle(dir = '', execName = 'Ace', bytes = thinMacho()) {
  const app = path.join(dir, 'Ace.app');
  fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true });
  fs.writeFileSync(path.join(app, 'Contents', 'MacOS', execName), bytes);
  fs.writeFileSync(
    path.join(app, 'Contents', 'Info.plist'),
    `<plist><dict><key>CFBundleExecutable</key><string>${execName}</string></dict></plist>`,
  );
  return app;
}

test('thin Mach-O reports exactly its own arch', () => {
  const dir = tmpDir('thin');
  expect(binaryArchs(writeFile(dir, 'arm', thinMacho(CPU_TYPE_ARM64)))).toEqual(['arm64']);
  expect(binaryArchs(writeFile(dir, 'intel', thinMacho(CPU_TYPE_X86_64)))).toEqual(['x64']);
});

test('universal Mach-O reports every contained arch', () => {
  const dir = tmpDir('fat');
  const p = writeFile(dir, 'fat', fatMacho([CPU_TYPE_X86_64, CPU_TYPE_ARM64]));
  expect(binaryArchs(p).sort()).toEqual(['arm64', 'x64']);
});

test('a fat wrapper that lies about a slice is rejected', () => {
  // Declares arm64, the slice is actually x64 — the app would not launch.
  const dir = tmpDir('fat-lie');
  const p = writeFile(dir, 'lying', fatMacho([CPU_TYPE_ARM64], [CPU_TYPE_X86_64]));
  expect(() => binaryArchs(p)).toThrow(/declares arm64 but contains x64/);
});

test('a fat slice pointing at non-Mach-O bytes is rejected', () => {
  const dir = tmpDir('fat-bad');
  const bytes = fatMacho([CPU_TYPE_ARM64]);
  // Corrupt the slice magic the table points at.
  bytes.writeUInt32LE(0, bytes.readUInt32BE(8 + 8));
  const p = writeFile(dir, 'corrupt', bytes);
  expect(() => binaryArchs(p)).toThrow(/is not a Mach-O binary/);
});

test('PE machine type is read even when the DOS stub pushes e_lfanew far out', () => {
  const dir = tmpDir('pe');
  // 8KB stub puts the PE header well past any fixed-size header buffer.
  expect(binaryArchs(writeFile(dir, 'big.exe', pe(0x8664, 8192)))).toEqual(['x64']);
  expect(binaryArchs(writeFile(dir, 'arm.exe', pe(0xaa64, 8192)))).toEqual(['arm64']);
});

test('truncated and non-executable files fail instead of guessing', () => {
  const dir = tmpDir('trunc');
  expect(() => binaryArchs(writeFile(dir, 'short.exe', Buffer.from([0x4d, 0x5a])))).toThrow(/truncated/);
  expect(() => binaryArchs(writeFile(dir, 'junk', Buffer.alloc(64)))).toThrow(/not a Mach-O binary/);
  expect(() => binaryArchs(writeFile(dir, 'junk.exe', Buffer.alloc(64)))).toThrow(/missing MZ header/);
});

test('the bundle executable comes from CFBundleExecutable, not directory order', () => {
  const dir = tmpDir('bundle');
  const app = makeAppBundle(dir, 'Ace', thinMacho(CPU_TYPE_X86_64));
  // A helper that sorts first must not be the one verified.
  fs.writeFileSync(path.join(app, 'Contents', 'MacOS', 'AAA-helper'), thinMacho(CPU_TYPE_ARM64));
  expect(mainExecutable(app)).toBe(path.join(app, 'Contents', 'MacOS', 'Ace'));
  expect(verifyArtifactArch(app, 'x64', { deep: false }).archs).toEqual(['x64']);
  // ...and the deep scan still refuses to ship that arm64 helper alongside it.
  expect(() => verifyArtifactArch(app, 'x64')).toThrow(/AAA-helper/);
});

test('a bundle whose declared executable is missing fails loudly', () => {
  const dir = tmpDir('bundle-missing');
  const app = makeAppBundle(dir);
  fs.unlinkSync(path.join(app, 'Contents', 'MacOS', 'Ace'));
  expect(() => mainExecutable(app)).toThrow(/not found/);
});

test('windows unpacked dir picks the product launcher over other exes', () => {
  const dir = tmpDir('win');
  const unpacked = path.join(dir, 'win-unpacked');
  fs.mkdirSync(unpacked);
  fs.writeFileSync(path.join(unpacked, 'Uninstall Ace.exe'), pe(0x14c));
  fs.writeFileSync(path.join(unpacked, 'Ace.exe'), pe(0x8664));
  expect(mainExecutable(unpacked)).toBe(path.join(unpacked, 'Ace.exe'));
  expect(verifyArtifactArch(unpacked, 'x64').archs).toEqual(['x64']);
});

test('an ambiguous windows dir refuses rather than picking one', () => {
  const dir = tmpDir('win-ambiguous');
  const unpacked = path.join(dir, 'win-unpacked');
  fs.mkdirSync(unpacked);
  fs.writeFileSync(path.join(unpacked, 'a.exe'), pe(0x8664));
  fs.writeFileSync(path.join(unpacked, 'b.exe'), pe(0x8664));
  expect(() => mainExecutable(unpacked)).toThrow(/ambiguous executable/);
});

test('a mismatched claim fails in both directions', () => {
  const dir = tmpDir('mismatch');
  const intel = makeAppBundle(dir, 'Ace', thinMacho(CPU_TYPE_X86_64));
  expect(() => verifyArtifactArch(intel, 'arm64')).toThrow(/is x64 but the release claims arm64/);
  const armDir = tmpDir('mismatch-arm');
  const arm = makeAppBundle(armDir, 'Ace', thinMacho(CPU_TYPE_ARM64));
  expect(() => verifyArtifactArch(arm, 'x64')).toThrow(/is arm64 but the release claims x64/);
});

test('a universal build satisfies either claim; unknown arches are refused', () => {
  const dir = tmpDir('universal');
  const app = makeAppBundle(dir, 'Ace', fatMacho([CPU_TYPE_X86_64, CPU_TYPE_ARM64]));
  expect(verifyArtifactArch(app, 'x64').archs.sort()).toEqual(['arm64', 'x64']);
  expect(verifyArtifactArch(app, 'arm64').archs.sort()).toEqual(['arm64', 'x64']);
  expect(() => verifyArtifactArch(app, 'ia32')).toThrow(/unsupported expected arch/);
});

// ---------------------------------------------------------------------------
// deep bundle scan — a correct launcher next to a foreign-arch native module
// launches and then dies the first time that module loads.
// ---------------------------------------------------------------------------

function addUnpacked(app = '', relPath = '', bytes = thinMacho()) {
  const full = path.join(app, 'Contents', 'Resources', 'app.asar.unpacked', relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, bytes);
  return full;
}

test('arch-named prebuild dirs for OTHER arches are ignored, not failed', () => {
  // node-pty ships every platform's prebuild and picks one at runtime, so an
  // arm64 prebuild inside an x64 app is expected and inert.
  expect(isForeignArchPath(path.join('node_modules', 'node-pty', 'prebuilds', 'darwin-arm64', 'pty.node'), 'x64')).toBe(true);
  expect(isForeignArchPath(path.join('node_modules', 'node-pty', 'bin', 'darwin-arm64-145', 'node-pty.node'), 'x64')).toBe(true);
  expect(isForeignArchPath(path.join('node_modules', 'node-pty', 'prebuilds', 'darwin-x64', 'pty.node'), 'arm64')).toBe(true);
  // The loadable path itself is never excused.
  expect(isForeignArchPath(path.join('node_modules', 'node-pty', 'build', 'Release', 'pty.node'), 'x64')).toBe(false);
});

test('a foreign-arch native module on the loadable path fails the release', () => {
  const dir = tmpDir('deep-bad');
  const app = makeAppBundle(dir, 'Ace', thinMacho(CPU_TYPE_X86_64));
  addUnpacked(app, path.join('node_modules', 'better-sqlite3', 'build', 'Release', 'db.node'), thinMacho(CPU_TYPE_ARM64));
  const offenders = foreignArchBinaries(app, 'x64');
  expect(offenders).toHaveLength(1);
  expect(offenders[0].file).toContain('db.node');
  expect(() => verifyArtifactArch(app, 'x64')).toThrow(/bundled binaries do not provide it/);
});

test('a matching-arch bundle with other-arch prebuilds passes the deep scan', () => {
  const dir = tmpDir('deep-ok');
  const app = makeAppBundle(dir, 'Ace', thinMacho(CPU_TYPE_X86_64));
  addUnpacked(app, path.join('node_modules', 'node-pty', 'build', 'Release', 'pty.node'), thinMacho(CPU_TYPE_X86_64));
  addUnpacked(app, path.join('node_modules', 'node-pty', 'prebuilds', 'darwin-arm64', 'pty.node'), thinMacho(CPU_TYPE_ARM64));
  // Universal dependencies satisfy either claim.
  addUnpacked(app, path.join('node_modules', 'fsevents', 'fsevents.node'), fatMacho([CPU_TYPE_X86_64, CPU_TYPE_ARM64]));
  expect(foreignArchBinaries(app, 'x64')).toEqual([]);
  expect(verifyArtifactArch(app, 'x64').scanned).toBe(true);
});

test('a foreign-arch helper app inside Frameworks fails the release', () => {
  const dir = tmpDir('deep-helper');
  const app = makeAppBundle(dir, 'Ace', thinMacho(CPU_TYPE_X86_64));
  const helper = path.join(app, 'Contents', 'Frameworks', 'Ace Helper.app', 'Contents', 'MacOS');
  fs.mkdirSync(helper, { recursive: true });
  fs.writeFileSync(path.join(helper, 'Ace Helper'), thinMacho(CPU_TYPE_ARM64));
  expect(() => verifyArtifactArch(app, 'x64')).toThrow(/Ace Helper/);
});

test('non-binary bundle files are skipped rather than failed', () => {
  const dir = tmpDir('deep-assets');
  const app = makeAppBundle(dir, 'Ace', thinMacho(CPU_TYPE_X86_64));
  addUnpacked(app, path.join('assets', 'icon.png'), Buffer.from('not a binary at all'));
  addUnpacked(app, path.join('scripts', 'run.sh'), Buffer.from('#!/bin/sh\necho hi\n'));
  expect(foreignArchBinaries(app, 'x64')).toEqual([]);
});

test('--no-deep verifies only the main executable', () => {
  const dir = tmpDir('deep-off');
  const app = makeAppBundle(dir, 'Ace', thinMacho(CPU_TYPE_X86_64));
  addUnpacked(app, path.join('node_modules', 'x', 'build', 'Release', 'bad.node'), thinMacho(CPU_TYPE_ARM64));
  expect(() => verifyArtifactArch(app, 'x64')).toThrow(/bundled binaries/);
  expect(verifyArtifactArch(app, 'x64', { deep: false }).scanned).toBe(false);
});
