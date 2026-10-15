import { describe, expect, test } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const { ensureCodexTrustedProject } = require('../codex-trust.cts');

function tmpConfig(initial) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-trust-'));
  const configPath = path.join(dir, 'config.toml');
  if (initial !== undefined) fs.writeFileSync(configPath, initial);
  return configPath;
}

describe('ensureCodexTrustedProject', () => {
  test('appends a trust block for a new project', () => {
    const configPath = tmpConfig('model = "gpt-5.5"\n');
    const r = ensureCodexTrustedProject('/data/workspaces/sandbox', { configPath });
    expect(r.changed).toBe(true);
    const out = fs.readFileSync(configPath, 'utf8');
    expect(out).toContain('[projects."/data/workspaces/sandbox"]');
    expect(out).toContain('trust_level = "trusted"');
    expect(out.startsWith('model = "gpt-5.5"')).toBe(true);
  });

  test('is idempotent — a trusted project is not appended twice', () => {
    const configPath = tmpConfig('');
    ensureCodexTrustedProject('/repo/a', { configPath });
    const r2 = ensureCodexTrustedProject('/repo/a', { configPath });
    expect(r2.changed).toBe(false);
    expect(r2.reason).toBe('already-trusted');
    const out = fs.readFileSync(configPath, 'utf8');
    expect(out.match(/\[projects\."\/repo\/a"\]/g).length).toBe(1);
  });

  test('creates the config file when the codex dir exists without one', () => {
    const configPath = tmpConfig(); // dir exists, file does not
    const r = ensureCodexTrustedProject('/repo/b', { configPath });
    expect(r.changed).toBe(true);
    expect(fs.readFileSync(configPath, 'utf8')).toContain('[projects."/repo/b"]');
  });

  test('no-ops safely on relative, empty, and quote-bearing paths', () => {
    const configPath = tmpConfig('');
    expect(ensureCodexTrustedProject('relative/path', { configPath }).changed).toBe(false);
    expect(ensureCodexTrustedProject('', { configPath }).changed).toBe(false);
    expect(ensureCodexTrustedProject('/bad/"quote', { configPath }).changed).toBe(false);
    expect(fs.readFileSync(configPath, 'utf8')).toBe('');
  });

  test('flips an existing untrusted block to trusted', () => {
    const configPath = tmpConfig('[projects."/repo/u"]\ntrust_level = "untrusted"\n\n[projects."/repo/other"]\ntrust_level = "untrusted"\n');
    const r = ensureCodexTrustedProject('/repo/u', { configPath });
    expect(r.changed).toBe(true);
    expect(r.reason).toBe('updated');
    const out = fs.readFileSync(configPath, 'utf8');
    expect(out).toContain('[projects."/repo/u"]\ntrust_level = "trusted"');
    expect(out).toContain('[projects."/repo/other"]\ntrust_level = "untrusted"');
  });

  test('inserts trust_level into an existing block that lacks it', () => {
    const configPath = tmpConfig('[projects."/repo/bare"]\nsome_other_key = 1\n');
    const r = ensureCodexTrustedProject('/repo/bare', { configPath });
    expect(r.changed).toBe(true);
    expect(r.reason).toBe('inserted');
    const out = fs.readFileSync(configPath, 'utf8');
    expect(out).toContain('[projects."/repo/bare"]\ntrust_level = "trusted"');
    expect(out).toContain('some_other_key = 1');
  });

  test('no-ops when the codex dir is absent', () => {
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-trust-absent-'));
    const missing = path.join(fresh, 'does-not-exist', 'config.toml');
    const r = ensureCodexTrustedProject('/repo/c', { configPath: missing });
    expect(r.changed).toBe(false);
    expect(r.reason).toBe('no-codex');
  });

  test('a commented-out header is never treated as a real table', () => {
    const configPath = tmpConfig('# [projects."/repo/ghost"]\n# trust_level = "untrusted"\nmodel = "gpt-5.5"\n');
    const r = ensureCodexTrustedProject('/repo/ghost', { configPath });
    expect(r.changed).toBe(true);
    expect(r.reason).toBe('appended');
    const out = fs.readFileSync(configPath, 'utf8');
    // The commented lines are untouched; a REAL block was appended at the end.
    expect(out).toContain('# [projects."/repo/ghost"]');
    expect(out).toContain('# trust_level = "untrusted"');
    expect(out).toContain('\n[projects."/repo/ghost"]\ntrust_level = "trusted"');
  });

  test('block edits stop at the next real table header, not a commented one', () => {
    const configPath = tmpConfig('[projects."/repo/a"]\nnote = 1\n# [not-a-header]\n\n[projects."/repo/b"]\ntrust_level = "untrusted"\n');
    const r = ensureCodexTrustedProject('/repo/a', { configPath });
    expect(r.reason).toBe('inserted');
    const out = fs.readFileSync(configPath, 'utf8');
    expect(out).toContain('[projects."/repo/a"]\ntrust_level = "trusted"\nnote = 1');
    // /repo/b's block is untouched.
    expect(out).toContain('[projects."/repo/b"]\ntrust_level = "untrusted"');
  });

  test('an existing header with an inline comment is the SAME table (no duplicate)', () => {
    const configPath = tmpConfig('[projects."/repo/ic"]   # added by ace\ntrust_level = "untrusted"\n');
    const r = ensureCodexTrustedProject('/repo/ic', { configPath });
    expect(r.reason).toBe('updated');
    const out = fs.readFileSync(configPath, 'utf8');
    expect(out.match(/\[projects\."\/repo\/ic"\]/g).length).toBe(1);
    expect(out).toContain('trust_level = "trusted"');
  });

  test('a single-quoted trust_level is recognized and rewritten (no duplicate key)', () => {
    const configPath = tmpConfig("[projects.\"/repo/sq\"]\ntrust_level = 'untrusted'  # keep\n");
    const r = ensureCodexTrustedProject('/repo/sq', { configPath });
    expect(r.reason).toBe('updated');
    const out = fs.readFileSync(configPath, 'utf8');
    expect(out.match(/trust_level/g).length).toBe(1);
    expect(out).toContain('trust_level = "trusted"  # keep');
  });

  test('single-quoted already-trusted is recognized as trusted', () => {
    const configPath = tmpConfig("[projects.\"/repo/sq2\"]\ntrust_level = 'trusted'\n");
    const r = ensureCodexTrustedProject('/repo/sq2', { configPath });
    expect(r.changed).toBe(false);
    expect(r.reason).toBe('already-trusted');
  });

  test('TOML-unsafe path characters are refused; spaces are allowed', () => {
    const configPath = tmpConfig('');
    expect(ensureCodexTrustedProject('/repo/back\\slash', { configPath }).reason).toBe('unsafe-path');
    expect(ensureCodexTrustedProject('/repo/cr\rreturn', { configPath }).reason).toBe('unsafe-path');
    expect(fs.readFileSync(configPath, 'utf8')).toBe('');
    const ok = ensureCodexTrustedProject('/repo/with space/dir', { configPath });
    expect(ok.changed).toBe(true);
  });

  test('ACE_CODEX_AUTOTRUST=0 disables all writes', () => {
    const configPath = tmpConfig('');
    const prior = process.env.ACE_CODEX_AUTOTRUST;
    process.env.ACE_CODEX_AUTOTRUST = '0';
    try {
      const r = ensureCodexTrustedProject('/repo/off', { configPath });
      expect(r.changed).toBe(false);
      expect(r.reason).toBe('disabled');
      expect(fs.readFileSync(configPath, 'utf8')).toBe('');
    } finally {
      if (prior === undefined) delete process.env.ACE_CODEX_AUTOTRUST;
      else process.env.ACE_CODEX_AUTOTRUST = prior;
    }
  });
});
