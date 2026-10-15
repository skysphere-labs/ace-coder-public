// Pure-Node STORE-method zip writer shared by updater test fixtures so zip
// creation never shells out to platform tools (/usr/bin/ditto is macOS-only;
// ci-fast runs these suites on Ubuntu).
//
// Entries carry unix external attributes (version-made-by 3 = UNIX) so both
// `ditto -x -k` (macOS) and `unzip` (Linux/macOS) restore file modes — the
// staged-app validation requires the Contents/MacOS executable bit to
// survive the round trip.
//
// NOTE: required from vitest entry files that must stay plain-JS compatible,
// so this module uses the same default-parameter typing convention.

const fs = require('fs');
const path = require('path');

let crcTable = JSON.parse('null');

function crc32(bytes = Buffer.alloc(0)) {
  if (crcTable === null) {
    crcTable = [];
    for (let i = 0; i < 256; i += 1) {
      let value = i;
      for (let bit = 0; bit < 8; bit += 1) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      }
      crcTable[i] = value >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function listFiles(root = '') {
  // [''].slice(1) seeds a string[] without TS annotation syntax (this file is
  // required from plain-JS vitest entries), which also breaks the TS7023
  // implicit-any cycle on the recursive call.
  const out = [''].slice(1);
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out.sort();
}

// version-made-by: high byte 3 = UNIX (so external attrs carry st_mode),
// low byte 20 = zip spec 2.0.
const VERSION_MADE_BY_UNIX = (3 << 8) | 20;

function writeStoreZip(root = '', zipPath = '') {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const file of listFiles(root)) {
    const name = path.relative(root, file).split(path.sep).join('/');
    const nameBytes = Buffer.from(name, 'utf8');
    const data = fs.readFileSync(file);
    const mode = fs.statSync(file).mode & 0o7777;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBytes, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(VERSION_MADE_BY_UNIX, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    // External attributes: unix st_mode (regular file + permissions) in the
    // high 16 bits — what unzip/ditto restore as the extracted file mode.
    central.writeUInt32LE(((0o100000 | mode) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBytes);

    offset += local.length + nameBytes.length + data.length;
  }

  const centralOffset = offset;
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const fileCount = localParts.length / 3;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(fileCount, 8);
  eocd.writeUInt16LE(fileCount, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  eocd.writeUInt16LE(0, 20);
  fs.writeFileSync(zipPath, Buffer.concat([...localParts, ...centralParts, eocd]));
}

module.exports = {
  crc32,
  listFiles,
  writeStoreZip,
};
