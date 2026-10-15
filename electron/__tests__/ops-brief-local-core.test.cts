import { describe, expect, it } from 'vitest';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { createAceStore } = require('../local-core.cts');
const { getTelemetryStore } = require('../telemetry.cts');

function fakePty() {
  return {
    spawn(bin, args, opts) {
      return {
        bin,
        args,
        opts,
        onData() {},
        onExit() {},
        write() {},
        resize() {},
        kill() {},
      };
    },
  };
}

function emptyOpsSources() {
  const watchlists = { feeds: [], accounts: [], repos: [], changelogs: [] };
  return {
    deriveWatchlists: () => watchlists,
    loadLocalSources: () => ({ watchlists, editableAt: null }),
    mergeSources: () => ({
      $schema: 'ace.ops.sources.v1',
      watchlists,
      editableAt: null,
      fromLatestJson: false,
    }),
  };
}

describe('local-core scheduled Today Brief delivery', () => {
  it('uses only the selected profile wiki when no vault override is configured', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-public-core-wiki-'));
    const previousHome = process.env.ACE_HOME;
    const previousWiki = process.env.ACE_WIKI_ROOT;
    process.env.ACE_HOME = path.join(root, 'profile');
    delete process.env.ACE_WIKI_ROOT;
    const store = createAceStore(path.join(root, 'user-data'), { ptyImpl: fakePty() });
    try {
      const graph = store.opsWikiGraph();
      expect(graph.root).toBe(path.join(process.env.ACE_HOME, 'wiki'));
      expect(graph.nodes).toEqual([]);
      expect(store.opsWikiPage({ relPath: 'private.md' }).ok).toBe(false);
    } finally {
      await store.shutdown();
      getTelemetryStore()?.close();
      if (previousHome === undefined) delete process.env.ACE_HOME;
      else process.env.ACE_HOME = previousHome;
      if (previousWiki === undefined) delete process.env.ACE_WIKI_ROOT;
      else process.env.ACE_WIKI_ROOT = previousWiki;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('refreshes sources without invoking the research agent by default', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-ops-brief-local-core-'));
    const userDataPath = path.join(root, 'user-data');
    const wikiRoot = path.join(root, 'wiki', 'ace-ops');
    const previousWikiRoot = process.env.ACE_WIKI_ROOT;
    const previousAceHome = process.env.ACE_HOME;
    const previousWikiDisable = process.env.ACE_WIKI_DISABLE;
    process.env.ACE_WIKI_ROOT = wikiRoot;
    process.env.ACE_HOME = path.join(root, 'public-profile');
    delete process.env.ACE_WIKI_DISABLE;

    let researchCalls = 0;
    const store = createAceStore(userDataPath, {
      ptyImpl: fakePty(),
      opsSources: emptyOpsSources(),
      readOpsRefreshConfig: () => ({
        fetchTimeoutMs: 1,
        research: { enabled: true, agent: 'claude', effort: null, timeoutMs: 1 },
      }),
      agentCliDriver: {
        runAgentPrompt: async () => {
          researchCalls += 1;
          return JSON.stringify({
            sections: [
              { key: 'platform_accounts', items: [] },
              { key: 'world_news', items: [] },
              { key: 'vendor_updates', items: [] },
            ],
          });
        },
      },
      runOpsStatus: async () => ({ rollup: { severity: 'green' }, findings: [] }),
    });

    try {
      const result = await store.deliverOpsBrief({
        lens: 'morning',
        now: Date.parse('2026-06-27T12:00:00.000Z'),
        refreshSources: true,
      });

      expect(researchCalls).toBe(0);
      expect(result.delivered).toBe(true);
      expect(result.todayPath).toBe(path.join(wikiRoot, 'dashboards', 'today.md'));
      expect(result.todayWritten).toBe(true);
      expect(fs.existsSync(result.todayPath)).toBe(true);
      // A delayed startup refresh is unattended too, even though its trigger
      // differs from the regular scheduler. Unknown background triggers fail closed.
      for (const trigger of ['catch-up', 'scheduled', 'background']) {
        await store.opsRefreshSources({ trigger });
        expect(researchCalls, trigger).toBe(0);
      }
      await store.opsRefreshSources({ trigger: 'manual', allowResearchAgent: true });
      expect(researchCalls).toBe(1);
    } finally {
      try {
        await store.shutdown();
        getTelemetryStore()?.close();
      } catch {
        // shutdown is best-effort in this focused test.
      }
      if (previousWikiRoot === undefined) delete process.env.ACE_WIKI_ROOT;
      else process.env.ACE_WIKI_ROOT = previousWikiRoot;
      if (previousAceHome === undefined) delete process.env.ACE_HOME;
      else process.env.ACE_HOME = previousAceHome;
      if (previousWikiDisable === undefined) delete process.env.ACE_WIKI_DISABLE;
      else process.env.ACE_WIKI_DISABLE = previousWikiDisable;
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});
