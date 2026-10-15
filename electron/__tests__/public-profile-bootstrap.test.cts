import { describe, expect, it } from 'vitest';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

describe('public desktop profile bootstrap', () => {
  it('clears inherited private data paths before selecting the public profile, preserving provider auth and disable flags', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'main.cts'), 'utf8');
    const start = source.indexOf("for (const key of ['ACE_DATA_ROOT'");
    const end = source.indexOf('const resolveAppExternalDataRoot', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(end).toBeLessThan(source.indexOf("require('./local-core.cjs')"));
    const privatePaths = ['ACE_DATA_ROOT', 'ACE_EXTERNAL_DATA_ROOT', 'ACE_USE_EXTERNAL_DATA_ROOT',
      'ACE_DATA_ROOT_CANDIDATES', 'ACE_CHILD_REGISTRY_PATH', 'ACE_FOLLOW_UP_STORE_PATH',
      'ACE_WIKI_ROOT', 'ACE_WIKI_PATH', 'ACE_WIKI_LOG_PATH', 'ACE_WIKI_DAILY_PATH',
      'ACE_WIKI_JOURNAL_DIR', 'ACE_KNOWLEDGE_DB', 'ACE_CODEX_HOME', 'ACE_SHARED_USER_DATA_PATH'];
    const env = Object.fromEntries(privatePaths.map(key => [key, '/fictional/private-profile']));
    env.ACE_HOME = '/fictional/private-profile';
    env.CODEX_HOME = '/fictional/provider-auth';
    env.ACE_WIKI_DISABLE = '1';
    env.ACE_KNOWLEDGE_NIGHTLY_DISABLE = '1';
    const localUserDataPath = path.join('fictional', 'public-profile');
    vm.runInNewContext(source.slice(start, end), { process: { env }, path, localUserDataPath });
    privatePaths.forEach(key => expect(env[key], key).toBeUndefined());
    expect(env.ACE_HOME).toBe(path.join(localUserDataPath, '.ace'));
    expect(env.CODEX_HOME).toBe('/fictional/provider-auth');
    expect(env.ACE_WIKI_DISABLE).toBe('1');
    expect(env.ACE_KNOWLEDGE_NIGHTLY_DISABLE).toBe('1');
    expect(source).toContain("fs.existsSync(path.join(localUserDataPath, 'external-data-root.json'))");
  });
});
