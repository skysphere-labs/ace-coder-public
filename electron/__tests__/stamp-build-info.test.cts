// Tests for scripts/stamp-build-info.cts option resolution and the --local
// prerelease stamp that keeps locally packaged builds BELOW published
// `<v>-dev.N` builds in compareSemver (so dev-channel updates stay offered).
//
// NOTE: vitest loads test entry files through Rollup's plain-JS parser, so
// this file must stay JS-compatible (no TS annotation syntax) — same
// convention as update-types.test.cts.

import { afterEach, describe, expect, it } from 'vitest';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { resolveStampOptions, stampBuildInfo } = require('../../scripts/stamp-build-info.cts');

const PKG = { version: '0.1.0' };

let activeTmpDir = '';

function tmpDir() {
  activeTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-stamp-build-info-'));
  return activeTmpDir;
}

afterEach(() => {
  if (activeTmpDir) {
    fs.rmSync(activeTmpDir, { recursive: true, force: true });
    activeTmpDir = '';
  }
});

// ---------------------------------------------------------------------------
// resolveStampOptions
// ---------------------------------------------------------------------------
describe('resolveStampOptions', () => {
  it('keeps the plain package version for the CI form (--channel latest)', () => {
    const resolved = resolveStampOptions(['--channel', 'latest'], PKG, {});
    expect(resolved.version).toBe('0.1.0');
    expect(resolved.channel).toBe('latest');
    expect(resolved.outPath.endsWith(path.join('electron', 'build-info.json'))).toBe(true);
  });

  it('--local stamps a prerelease version and defaults channel to dev', () => {
    const resolved = resolveStampOptions(['--local'], PKG, {});
    expect(resolved.version).toBe('0.1.0-dev.0');
    expect(resolved.channel).toBe('dev');
  });

  it('an explicit --version beats --local', () => {
    const resolved = resolveStampOptions(['--local', '--version', '9.9.9'], PKG, {});
    expect(resolved.version).toBe('9.9.9');
  });

  it('--channel beats ACE_CHANNEL env', () => {
    const resolved = resolveStampOptions(['--channel', 'latest'], PKG, {
      ACE_CHANNEL: 'dev',
    });
    expect(resolved.channel).toBe('latest');
  });

  it('respects ACE_CHANNEL env when no --channel flag is given', () => {
    const resolved = resolveStampOptions([], PKG, { ACE_CHANNEL: 'latest' });
    expect(resolved.channel).toBe('latest');
  });

  it('resolves an --out override', () => {
    const resolved = resolveStampOptions(['--out', 'some/dir/info.json'], PKG, {});
    expect(resolved.outPath).toBe(path.resolve('some/dir/info.json'));
  });

  it('throws when the package has no version and no --version flag', () => {
    expect(() => resolveStampOptions([], {}, {})).toThrow(/no version/);
  });

  it('throws on unknown arguments', () => {
    expect(() => resolveStampOptions(['--bogus'], PKG, {})).toThrow(/unknown argument/);
  });
});

// ---------------------------------------------------------------------------
// stampBuildInfo write path (--local equivalent)
// ---------------------------------------------------------------------------
describe('stampBuildInfo --local write path', () => {
  it('writes build-info.v1 JSON with a prerelease version under --local', () => {
    const dir = tmpDir();
    const pkgPath = path.join(dir, 'package.json');
    fs.writeFileSync(pkgPath, JSON.stringify({ version: '0.1.0' }));
    const outPath = path.join(dir, 'build-info.json');

    const { changed, info } = stampBuildInfo({
      local: true,
      out: outPath,
      packageJsonPath: pkgPath,
      gitSha: 'a'.repeat(40),
      builtAt: '2026-06-05T00:00:00.000Z',
      env: {},
    });

    expect(changed).toBe(true);
    const written = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    expect(written).toEqual(info);
    expect(written.schema).toBe('ace.app.build-info.v1');
    expect(written.version).toBe('0.1.0-dev.0');
    expect(written.channel).toBe('dev');
    expect(written.gitShortSha).toBe('aaaaaaa');
    expect(written.builtAt).toBe('2026-06-05T00:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// electron/build-info.json is gitignored, so a packaging script that skips the
// stamp ships a build the updater disables outright with 'missing-build-info'.
// ---------------------------------------------------------------------------
describe('packaging scripts stamp build info before packaging', () => {
  const scripts = require('../../package.json').scripts;

  for (const name of ['package', 'package:mac', 'package:win']) {
    it(`${name} stamps before invoking electron-builder`, () => {
      const cmd = String(scripts[name] || '');
      const stamp = cmd.indexOf('stamp-build-info.cts');
      const builder = cmd.indexOf('electron-builder');
      expect(stamp).toBeGreaterThan(-1);
      expect(builder).toBeGreaterThan(-1);
      expect(stamp).toBeLessThan(builder);
    });
  }
});
