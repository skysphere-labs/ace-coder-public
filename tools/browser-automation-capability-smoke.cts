#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-browser-auto-'));
const originalHome = process.env.HOME;

async function main() {
  process.env.HOME = tmpHome;

  for (const key of Object.keys(require.cache)) {
    if (key.includes('/electron/mcp-core.cjs') || key.includes('/electron/mcp-core.cts')) {
      delete require.cache[key];
    }
  }

  const mcpCore = require('../electron/mcp-core.cts');
  const catalog = mcpCore.getCatalog();
  const playwright = catalog.find((entry: any) => entry.key === 'playwright');
  const aceBrowser = catalog.find((entry: any) => entry.key === 'ace_browser');

  assert.ok(playwright, 'playwright catalog entry must exist');
  assert.ok(aceBrowser, 'ace_browser catalog entry must exist');
  assert.equal(playwright.capability, 'browser-automation');
  assert.equal(playwright.enabledByDefault, false);
  assert.deepEqual(playwright.credentialKeys, []);
  assert.deepEqual(playwright.defaultConfig, {
    command: 'npx',
    args: ['@playwright/mcp@latest'],
  });
  assert.equal(aceBrowser.capability, 'browser-automation');
  assert.equal(aceBrowser.enabledByDefault, false);
  assert.deepEqual(aceBrowser.credentialKeys, []);
  assert.deepEqual(aceBrowser.defaultConfig, {
    command: 'ace',
    args: ['mcp-browser'],
  });

  const before = await mcpCore.loadAll();
  const listedPlaywright = before.catalog.find((entry: any) => entry.key === 'playwright');
  const listedAceBrowser = before.catalog.find((entry: any) => entry.key === 'ace_browser');
  assert.equal(listedPlaywright?.capability, 'browser-automation');
  assert.equal(listedPlaywright?.enabledByDefault, false);
  assert.equal(listedAceBrowser?.capability, 'browser-automation');
  assert.equal(listedAceBrowser?.enabledByDefault, false);
  assert.equal(before.installed.length, 0, 'empty HOME must not auto-install browser automation');
  assert.equal(
    fs.existsSync(path.join(tmpHome, '.codex', 'config.toml')),
    false,
    'listing capabilities must not create Codex MCP config'
  );

  await mcpCore.saveServer({
    name: playwright.key,
    transport: 'stdio',
    command: playwright.defaultConfig.command,
    args: playwright.defaultConfig.args,
    providers: ['codex'],
  });

  const codexConfigPath = path.join(tmpHome, '.codex', 'config.toml');
  const codexConfig = fs.readFileSync(codexConfigPath, 'utf8');
  assert.match(codexConfig, /\[mcp_servers\.playwright\]/);
  assert.match(codexConfig, /command = "npx"/);
  assert.match(codexConfig, /"@playwright\/mcp@latest"/);
  assert.doesNotMatch(codexConfig, /api[_-]?key|token|secret|password/i);
  assert.doesNotMatch(codexConfig, /user-data-dir|browser[_-]?profile|profile/i);

  await mcpCore.saveServer({
    name: aceBrowser.key,
    transport: 'stdio',
    command: aceBrowser.defaultConfig.command,
    args: aceBrowser.defaultConfig.args,
    providers: ['codex'],
  });

  const withAceBrowserConfig = fs.readFileSync(codexConfigPath, 'utf8');
  assert.match(withAceBrowserConfig, /\[mcp_servers\.ace_browser\]/);
  assert.match(withAceBrowserConfig, /command = "ace"/);
  assert.match(withAceBrowserConfig, /"mcp-browser"/);
  assert.doesNotMatch(withAceBrowserConfig, /api[_-]?key|token|secret|password/i);
  assert.doesNotMatch(withAceBrowserConfig, /user-data-dir|browser[_-]?profile|profile/i);

  console.log('browser automation capability smoke passed');
}

main()
  .finally(() => {
    if (originalHome == null) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  })
  .catch((err) => {
    console.error(err?.stack || err);
    process.exit(1);
  });
