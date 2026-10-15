import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fs = require('fs');
const os = require('os');
const path = require('path');
const sources = require('../ops-sources.cts');
const todos = require('../ops-todos.cts');
const reports = require('../vector-ops-adapter.cts');
const wiki = require('../wiki-graph-indexer.cts');
const wikiUpdater = require('../wiki-updater.cts');
const briefs = require('../ops-brief-scheduler.cts');
const hermes = require('../hermes-memory-reader.cts');
const tap = require('../usage-statusline-tap.cts');
const { SshDaemonManager } = require('../ssh-daemon.cts');

const keys = ['ACE_HOME', 'ACE_CODEX_HOME', 'ACE_DATA_ROOT', 'ACE_WIKI_ROOT', 'ACE_WIKI_PATH', 'ACE_WIKI_LOG_PATH', 'ACE_WIKI_DAILY_PATH'];
let savedEnv = {};
let root = '';
let home = '';
let profile = '';

function write(relative, content) {
  const target = path.join(home, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-public-profile-'));
  home = path.join(root, 'home');
  profile = path.join(root, 'profile');
  fs.mkdirSync(profile, { recursive: true });
  savedEnv = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  keys.forEach((key) => delete process.env[key]);
  process.env.ACE_HOME = profile;
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  write('.ace/ops-sources.json', JSON.stringify({ watchlists: { feeds: ['private-feed'] } }));
  write('.ace/ops-todos.json', JSON.stringify([{ id: 'private-todo', text: 'Private task' }]));
  write('.ace/ops-config.json', JSON.stringify({ refresh: { research: { scheduled: true } } }));
  write('.hermes/vector-ops-dashboard/site/data/latest.json', JSON.stringify({ report: { generated_at: new Date().toISOString() } }));
  write('.hermes/memories/private.md', '# Private memory');
  write('wiki/ace-ops/private.md', '# Private wiki');
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

describe('fresh public profile isolation', () => {
  it('does not discover legacy sources, todos, reports, research config, wiki, or Hermes memories', () => {
    expect(sources.loadLocalSources().watchlists.feeds).toEqual([]);
    expect(todos.listTodos()).toEqual([]);
    expect(reports.loadLatestReport().report).toBeNull();
    expect(reports.loadLatestReport().path).toBe(path.join(profile, 'ops', 'latest.json'));
    expect(briefs.readResearchScheduled()).toBe(false);
    expect(wiki.buildWikiGraph().nodes).toEqual([]);
    expect(wiki.readWikiPage({ relPath: 'private.md' }).ok).toBe(false);
    expect(hermes.collectHermesMemoryDocs({ userDataPath: profile })).toEqual([]);
    expect(hermes.isHermesPath(path.join(home, '.hermes', 'memories', 'private.md'), profile)).toBe(true);
  });

  it('keeps writes, wiki dashboards, and usage cache paths inside the selected profile', () => {
    sources.saveLocalSources({ feeds: ['public-feed'], accounts: [], repos: [], changelogs: [] });
    todos.addTodo({ text: 'Public task' });
    expect(sources.loadLocalSources().watchlists.feeds).toEqual(['public-feed']);
    expect(todos.listTodos().map((todo) => todo.text)).toEqual(['Public task']);
    expect(fs.existsSync(path.join(profile, 'ops-sources.json'))).toBe(true);
    expect(fs.existsSync(path.join(profile, 'ops-todos.json'))).toBe(true);
    expect(wikiUpdater.wikiPath()).toBe(path.join(profile, 'wiki', 'dashboards', 'current-state.md'));
    expect(briefs.resolveTodayBriefPath()).toBe(path.join(profile, 'wiki', 'dashboards', 'today.md'));
    expect(tap.tapPaths(path.join(root, 'chosen-claude')).usageDir).toBe(path.join(profile, 'usage'));
    expect(JSON.parse(fs.readFileSync(path.join(home, '.ace', 'ops-todos.json'), 'utf8'))[0].text).toBe('Private task');
  });

  it('uses the public fallback directory when ACE_HOME is absent', () => {
    delete process.env.ACE_HOME;
    expect(sources.loadLocalSources().watchlists.feeds).toEqual([]);
    expect(todos.listTodos()).toEqual([]);
    expect(wiki.buildWikiGraph().root).toBe(path.join(home, '.ace-coder', 'wiki'));
    expect(reports.loadLatestReport().path).toBe(path.join(home, '.ace-coder', 'ops', 'latest.json'));
    expect(tap.tapPaths(path.join(root, 'chosen-claude')).usageDir).toBe(path.join(home, '.ace-coder', 'usage'));
  });

  it('preserves explicit wiki, report, and shared Hermes source selection', () => {
    const selectedWiki = path.join(home, 'wiki', 'ace-ops');
    process.env.ACE_WIKI_ROOT = selectedWiki;
    expect(wiki.buildWikiGraph().nodes.map((node) => node.id)).toEqual(['private']);
    expect(wiki.readWikiPage({ relPath: 'private.md' }).ok).toBe(true);
    expect(briefs.resolveTodayBriefPath()).toBe(path.join(selectedWiki, 'dashboards', 'today.md'));
    expect(wikiUpdater.wikiPath()).toBe(path.join(selectedWiki, 'dashboards', 'current-state.md'));
    expect(reports.loadLatestReport({ path: path.join(home, '.hermes', 'vector-ops-dashboard', 'site', 'data', 'latest.json') }).report).not.toBeNull();
    expect(hermes.collectHermesMemoryDocs({ userDataPath: profile, homeDir: home }).map((doc) => doc.title)).toEqual(['Private memory']);
  });

  it('uses a separate remote daemon and paste directory without starting SSH', () => {
    const manager = new SshDaemonManager();
    const regular = manager.get('example.invalid');
    expect(regular.remotePath).toBe('~/.ace-coder/ace-coder-daemon');
    expect(regular.pastesDir).toBe('~/.ace-coder/pastes');
    const agent = manager.get('example.invalid', 'agent');
    expect(agent.remotePath).toBe('/home/agent/.ace-coder/ace-coder-daemon');
    expect(agent.pastesDir).toBe('/home/agent/.ace-coder/pastes');
    expect(regular.proc).toBeNull();
    expect(agent.proc).toBeNull();
    manager.closeAll();
  });

  it('isolates the Codex worker home while preserving explicitly selected provider credentials', () => {
    const { ensureAceCodexHome } = require('../local-core.cts');
    const sourceHome = path.join(root, 'selected-codex');
    fs.mkdirSync(sourceHome, { recursive: true });
    fs.writeFileSync(path.join(sourceHome, 'auth.json'), JSON.stringify({ testFixture: true }));
    const target = ensureAceCodexHome({ CODEX_HOME: sourceHome, ACE_HOME: profile });
    expect(target).toBe(path.join(profile, 'codex-home'));
    expect(JSON.parse(fs.readFileSync(path.join(target, 'auth.json'), 'utf8'))).toEqual({ testFixture: true });
    const explicitTarget = path.join(root, 'selected-worker');
    expect(ensureAceCodexHome({ CODEX_HOME: sourceHome, ACE_CODEX_HOME: explicitTarget })).toBe(explicitTarget);
    expect(fs.existsSync(path.join(home, '.ace', 'codex-home'))).toBe(false);
  });
});
