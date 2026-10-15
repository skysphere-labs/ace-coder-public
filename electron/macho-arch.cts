// Shared Mach-O / PE architecture reader.
//
// NO Electron imports — used by the release gate (scripts/verify-artifact-arch)
// and by the updater before it swaps a staged bundle. Both must agree, so the
// parser lives in exactly one place: release-time and install-time validation
// drifting apart is how a wrong-arch build reaches users.

const fs = require('node:fs') as typeof import('node:fs');

export type BinaryArch = 'arm64' | 'x64';

// Mach-O cputype (mach/machine.h): CPU_ARCH_ABI64 | CPU_TYPE_{X86,ARM}
const CPU_TYPE_X86_64 = 0x01000007;
const CPU_TYPE_ARM64 = 0x0100000c;
// PE IMAGE_FILE_MACHINE_* (winnt.h)
const IMAGE_FILE_MACHINE_AMD64 = 0x8664;
const IMAGE_FILE_MACHINE_ARM64 = 0xaa64;

class ArchReadError extends Error {}

function fail(message: string): never {
  throw new ArchReadError(message);
}

/** Reads exactly `length` bytes at `position`; short reads are a hard error. */
function readAt(fd: number, length: number, position: number): Buffer {
  if (position < 0 || length <= 0) fail(`refusing to read ${length} bytes at offset ${position}`);
  const buf = Buffer.alloc(length);
  const read = fs.readSync(fd, buf, 0, length, position);
  if (read < length) fail(`truncated file: wanted ${length} bytes at ${position}, got ${read}`);
  return buf;
}

function archFromCpuType(cpuType: number): BinaryArch | null {
  if (cpuType === CPU_TYPE_X86_64) return 'x64';
  if (cpuType === CPU_TYPE_ARM64) return 'arm64';
  return null;
}

function isThinMachoMagic(magic: number): boolean {
  return magic === 0xfeedfacf || magic === 0xfeedface;
}

/**
 * Every architecture a Mach-O file really contains. Fat slices are followed to
 * their offset and confirmed there — a wrapper that merely claims an arch it
 * does not contain must not pass, since that app would not launch.
 */
function machoArchs(fd: number): BinaryArch[] {
  const head = readAt(fd, 8, 0);
  const magic = head.readUInt32BE(0);
  // Fat headers are big-endian regardless of host byte order.
  if (magic === 0xcafebabe || magic === 0xcafebabf) {
    const is64 = magic === 0xcafebabf;
    const entrySize = is64 ? 32 : 20;
    const count = head.readUInt32BE(4);
    if (count === 0 || count > 32) fail(`implausible fat arch count ${count}`);
    const table = readAt(fd, count * entrySize, 8);
    const archs: BinaryArch[] = [];
    for (let i = 0; i < count; i += 1) {
      const base = i * entrySize;
      const declared = archFromCpuType(table.readUInt32BE(base));
      const sliceOffset = is64
        ? Number(table.readBigUInt64BE(base + 8))
        : table.readUInt32BE(base + 8);
      const sliceHead = readAt(fd, 8, sliceOffset);
      if (!isThinMachoMagic(sliceHead.readUInt32LE(0))) {
        fail(`fat slice ${i} at offset ${sliceOffset} is not a Mach-O binary`);
      }
      const actual = archFromCpuType(sliceHead.readUInt32LE(4));
      if (declared && actual && declared !== actual) {
        fail(`fat slice ${i} declares ${declared} but contains ${actual}`);
      }
      if (actual && !archs.includes(actual)) archs.push(actual);
    }
    return archs;
  }
  const magicLE = head.readUInt32LE(0);
  if (isThinMachoMagic(magicLE)) {
    const arch = archFromCpuType(head.readUInt32LE(4));
    return arch ? [arch] : [];
  }
  fail(`not a Mach-O binary (magic 0x${magic.toString(16)})`);
}

/** PE machine type. e_lfanew may point far past any fixed-size header read. */
function peArch(fd: number): BinaryArch[] {
  const dos = readAt(fd, 0x40, 0);
  if (dos.readUInt16LE(0) !== 0x5a4d) fail('not a PE binary (missing MZ header)');
  const peOffset = dos.readUInt32LE(0x3c);
  const coff = readAt(fd, 6, peOffset);
  if (coff.readUInt32LE(0) !== 0x00004550) fail('not a PE binary (missing PE signature)');
  const machine = coff.readUInt16LE(4);
  if (machine === IMAGE_FILE_MACHINE_AMD64) return ['x64'];
  if (machine === IMAGE_FILE_MACHINE_ARM64) return ['arm64'];
  fail(`unsupported PE machine type 0x${machine.toString(16)}`);
}

/** Architectures in `filePath`, dispatching on file type. Throws on bad input. */
function binaryArchs(filePath: string): BinaryArch[] {
  const fd = fs.openSync(filePath, 'r');
  try {
    return filePath.toLowerCase().endsWith('.exe') ? peArch(fd) : machoArchs(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** Never-throwing variant: [] means "no verdict", never "mismatch". */
function binaryArchsSafe(filePath: string): BinaryArch[] {
  try {
    return binaryArchs(filePath);
  } catch {
    return [];
  }
}

export type MachoArchRuntime = {
  binaryArchs: typeof binaryArchs;
  binaryArchsSafe: typeof binaryArchsSafe;
  machoArchs: typeof machoArchs;
  peArch: typeof peArch;
  ArchReadError: typeof ArchReadError;
};

module.exports = { binaryArchs, binaryArchsSafe, machoArchs, peArch, ArchReadError };
