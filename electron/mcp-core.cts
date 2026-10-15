

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const jsoncParser = require('jsonc-parser');

let _tomlModule: any = null;
async function getToml() {
  if (!_tomlModule) _tomlModule = await import('smol-toml');
  return _tomlModule;
}

const HOME = os.homedir();

const AGENT_CONFIGS: Record<string, any> = {
  claude: {
    name: 'Claude Code',
    pathSegments: ['.claude.json'],
    serversPath: ['mcpServers'],
    template: { mcpServers: {} },
    adapter: 'passthrough',
    supportsHttp: true,
  },
  cursor: {
    name: 'Cursor',
    pathSegments: ['.cursor', 'mcp.json'],
    serversPath: ['mcpServers'],
    template: { mcpServers: {} },
    adapter: 'cursor',
    supportsHttp: true,
  },
  codex: {
    name: 'Codex',
    pathSegments: ['.codex', 'config.toml'],
    serversPath: ['mcp_servers'],
    template: { mcp_servers: {} },
    adapter: 'codex',
    supportsHttp: false,
    format: 'toml',
  },
  opencode: {
    name: 'OpenCode',
    pathSegments: ['.config', 'opencode', 'opencode.json'],
    serversPath: ['mcp'],
    template: { mcp: {} },
    adapter: 'opencode',
    supportsHttp: true,
    format: 'jsonc',
  },
  amp: {
    name: 'Amp',
    pathSegments: ['.config', 'amp', 'settings.json'],
    serversPath: ['mcpServers'],
    template: { mcpServers: {} },
    adapter: 'passthrough',
    supportsHttp: true,
  },
  gemini: {
    name: 'Gemini CLI',
    pathSegments: ['.gemini', 'settings.json'],
    serversPath: ['mcpServers'],
    template: { mcpServers: {} },
    adapter: 'gemini',
    supportsHttp: true,
  },
  qwen: {
    name: 'Qwen',
    pathSegments: ['.qwen', 'settings.json'],
    serversPath: ['mcpServers'],
    template: { mcpServers: {} },
    adapter: 'gemini',
    supportsHttp: true,
  },
  copilot: {
    name: 'GitHub Copilot',
    pathSegments: ['.copilot', 'mcp-config.json'],
    serversPath: ['mcpServers'],
    template: { mcpServers: {} },
    adapter: 'copilot',
    supportsHttp: true,
  },
  droid: {
    name: 'Droid',
    pathSegments: ['.droid', 'settings.json'],
    serversPath: ['mcpServers'],
    template: { mcpServers: {} },
    adapter: 'passthrough',
    supportsHttp: true,
  },
};

function getAllAgentIds() {
  return Object.keys(AGENT_CONFIGS);
}

function getAgentMeta(agentId: any) {
  const def = AGENT_CONFIGS[agentId];
  if (!def) return null;
  return {
    agentId,
    name: def.name,
    configPath: path.join(HOME, ...def.pathSegments),
    configDir: path.join(HOME, ...def.pathSegments.slice(0, -1)),
    serversPath: def.serversPath,
    template: def.template,
    adapter: def.adapter,
    supportsHttp: def.supportsHttp,
    format: def.format || 'json',
  };
}

function extractAtPath(obj: any, segments: any) {
  let cur = obj;
  for (const key of segments) {
    if (typeof cur !== 'object' || cur === null) return {};
    cur = cur[key];
    if (cur === undefined) return {};
  }
  if (typeof cur !== 'object' || cur === null || Array.isArray(cur)) return {};
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(cur)) {
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) out[k] = v;
  }
  return out;
}

function setAtPath(obj: any, segments: any, value: any) {
  let cur = obj;
  for (let i = 0; i < segments.length - 1; i++) {
    const k = segments[i];
    if (typeof cur[k] !== 'object' || cur[k] === null) cur[k] = {};
    cur = cur[k];
  }
  if (segments.length) cur[segments[segments.length - 1]] = value;
}

function cloneTemplate(tpl: any) {
  return JSON.parse(JSON.stringify(tpl));
}

const JSONC_PARSE_OPTS = { allowTrailingComma: true, disallowComments: false };

function parseJsonc(raw: any) {
  const errors: any[] = [];
  const parsed = jsoncParser.parse(raw, errors, JSONC_PARSE_OPTS);
  if (errors.length || typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('invalid JSONC');
  }
  return parsed;
}

async function readServers(meta: any) {
  let raw;
  try {
    raw = await fsp.readFile(meta.configPath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return {};
    throw err;
  }
  if (!raw.trim()) return {};

  let parsed;
  try {
    if (meta.format === 'toml') {
      const toml = await getToml();
      parsed = toml.parse(raw);
    } else if (meta.format === 'jsonc') {
      parsed = parseJsonc(raw);
    } else {
      parsed = JSON.parse(raw);
    }
  } catch (err) {
    console.warn(
      `[ace] invalid ${meta.format} in ${meta.configPath}, treating as empty:`,
      err.message
    );
    return {};
  }
  return extractAtPath(parsed, meta.serversPath);
}

async function writeServers(meta: any, servers: any) {
  await fsp.mkdir(path.dirname(meta.configPath), { recursive: true });

  let existingRaw = null;
  try {
    existingRaw = await fsp.readFile(meta.configPath, 'utf8');
  } catch (err) {
    if (err && err.code !== 'ENOENT') throw err;
  }

  if (meta.format === 'toml') {
    const toml = await getToml();
    let existing;
    try {
      existing = existingRaw && existingRaw.trim() ? toml.parse(existingRaw) : cloneTemplate(meta.template);
    } catch {
      existing = cloneTemplate(meta.template);
    }
    setAtPath(existing, meta.serversPath, servers);
    await fsp.writeFile(meta.configPath, toml.stringify(existing));
    return;
  }

  if (meta.format === 'jsonc') {



    if (existingRaw && existingRaw.trim()) {
      try {
        parseJsonc(existingRaw);
        const edits = jsoncParser.modify(existingRaw, meta.serversPath, servers, {});
        const next = jsoncParser.applyEdits(existingRaw, edits);
        await fsp.writeFile(meta.configPath, next);
        return;
      } catch {

      }
    }
    const shell = cloneTemplate(meta.template);
    setAtPath(shell, meta.serversPath, servers);
    await fsp.writeFile(meta.configPath, JSON.stringify(shell, null, 2) + '\n');
    return;
  }


  let existing;
  try {
    existing = existingRaw && existingRaw.trim() ? JSON.parse(existingRaw) : cloneTemplate(meta.template);
  } catch {
    existing = cloneTemplate(meta.template);
  }
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
    existing = cloneTemplate(meta.template);
  }
  setAtPath(existing, meta.serversPath, servers);
  await fsp.writeFile(meta.configPath, JSON.stringify(existing, null, 2) + '\n');
}

const ACCEPT = 'application/json, text/event-stream';

function isHttp(entry: any) {
  return entry && entry.type === 'http';
}
function isStdio(entry: any) {
  return entry && !isHttp(entry) && typeof entry.command === 'string';
}
function clone(v: any) {
  return JSON.parse(JSON.stringify(v));
}
function ensureHeader(h: any, key: any, val: any) {
  if (typeof h[key] !== 'string') h[key] = val;
}
function stripAccept(entry: any) {
  if (!entry.headers || typeof entry.headers !== 'object') return;
  if (entry.headers.Accept === ACCEPT) {
    delete entry.headers.Accept;
    if (!Object.keys(entry.headers).length) delete entry.headers;
  }
}

const FORWARD: Record<string, (servers: any) => any> = {
  passthrough: (servers: any) => clone(servers),

  gemini: (servers: any) => {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(servers) as Array<[string, any]>) {
      if (!isHttp(v)) {
        out[k] = clone(v);
        continue;
      }
      const headers = { ...(v.headers || {}) };
      ensureHeader(headers, 'Accept', ACCEPT);
      const entry: any = { httpUrl: v.url || '', headers };
      if (v.env && typeof v.env === 'object') entry.env = v.env;
      out[k] = entry;
    }
    return out;
  },

  cursor: (servers: any) => {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(servers) as Array<[string, any]>) {
      if (!isHttp(v)) {
        out[k] = clone(v);
        continue;
      }
      const entry: any = { url: v.url || '', headers: v.headers || {} };
      if (v.env && typeof v.env === 'object') entry.env = v.env;
      out[k] = entry;
    }
    return out;
  },

  copilot: (servers: any) => {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(servers) as Array<[string, any]>) {
      if (v && typeof v === 'object' && !('tools' in v)) {
        out[k] = { ...clone(v), tools: ['*'] };
      } else {
        out[k] = clone(v);
      }
    }
    return out;
  },



  codex: (servers: any) => {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(servers) as Array<[string, any]>) {
      if (v && typeof v === 'object' && isStdio(v)) out[k] = clone(v);
    }
    return out;
  },




  opencode: (servers: any) => {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(servers) as Array<[string, any]>) {
      if (!v || typeof v !== 'object') {
        out[k] = v;
        continue;
      }
      if (isHttp(v)) {
        const headers = { ...(v.headers || {}) };
        ensureHeader(headers, 'Accept', ACCEPT);
        const entry: any = { type: 'remote', url: v.url || '', headers, enabled: true };
        if (v.env && typeof v.env === 'object') entry.env = v.env;
        out[k] = entry;
      } else if (isStdio(v)) {
        const command = [];
        if (typeof v.command === 'string' && v.command) command.push(v.command);
        if (Array.isArray(v.args)) command.push(...v.args);
        const entry: any = { type: 'local', command, enabled: true };
        if (v.env && typeof v.env === 'object') entry.env = v.env;
        out[k] = entry;
      } else {
        out[k] = clone(v);
      }
    }
    return out;
  },
};

const REVERSE: Record<string, (servers: any) => any> = {
  passthrough: (servers: any) => clone(servers),

  gemini: (servers: any) => {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(servers) as Array<[string, any]>) {
      if (v && typeof v === 'object' && 'httpUrl' in v) {
        const { httpUrl, ...rest } = v;
        const entry = { ...rest, type: 'http', url: httpUrl };
        stripAccept(entry);
        out[k] = entry;
      } else {
        out[k] = clone(v);
      }
    }
    return out;
  },

  cursor: (servers: any) => {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(servers) as Array<[string, any]>) {
      if (v && typeof v === 'object' && 'url' in v && !('command' in v)) {
        out[k] = { ...clone(v), type: 'http' };
      } else {
        out[k] = clone(v);
      }
    }
    return out;
  },

  copilot: (servers: any) => {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(servers) as Array<[string, any]>) {
      if (v && typeof v === 'object') {
        const c = clone(v);
        if (Array.isArray(c.tools) && c.tools.length === 1 && c.tools[0] === '*') delete c.tools;
        out[k] = c;
      } else {
        out[k] = v;
      }
    }
    return out;
  },


  codex: (servers: any) => clone(servers),



  opencode: (servers: any) => {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(servers) as Array<[string, any]>) {
      if (!v || typeof v !== 'object') {
        out[k] = v;
        continue;
      }
      if (v.type === 'remote') {
        const { type: _t, enabled: _e, ...rest } = v;
        const entry = { ...rest, type: 'http' };
        if (entry.headers && typeof entry.headers === 'object' && entry.headers.Accept === ACCEPT) {
          delete entry.headers.Accept;
          if (!Object.keys(entry.headers).length) delete entry.headers;
        }
        out[k] = entry;
      } else if (v.type === 'local' && Array.isArray(v.command)) {
        const [command, ...args] = v.command;
        const entry: any = {};
        if (command) entry.command = command;
        if (args.length) entry.args = args;
        if (v.env && typeof v.env === 'object') entry.env = v.env;
        out[k] = entry;
      } else {
        out[k] = clone(v);
      }
    }
    return out;
  },
};

function adaptForward(adapter: any, servers: any) {
  return (FORWARD[adapter] || FORWARD.passthrough)(servers);
}
function adaptReverse(adapter: any, servers: any) {
  return (REVERSE[adapter] || REVERSE.passthrough)(servers);
}

function rawToServer(name: any, raw: any, providers: any) {
  const http = raw.type === 'http' || ('url' in raw && !('command' in raw));
  return {
    name,
    transport: http ? 'http' : 'stdio',
    command: typeof raw.command === 'string' ? raw.command : undefined,
    args: Array.isArray(raw.args) ? raw.args : undefined,
    url: typeof raw.url === 'string' ? raw.url : undefined,
    headers: raw.headers && typeof raw.headers === 'object' ? raw.headers : undefined,
    env: raw.env && typeof raw.env === 'object' ? raw.env : undefined,
    providers: Array.from(providers),
  };
}

function serverToRaw(server: any) {
  const raw: any = {};
  if (server.transport === 'http') {
    raw.type = 'http';
    if (server.url) raw.url = server.url;
    if (server.headers && Object.keys(server.headers).length) raw.headers = server.headers;
  } else {
    if (server.command) raw.command = server.command;
    if (server.args && server.args.length) raw.args = server.args;
  }
  if (server.env && Object.keys(server.env).length) raw.env = server.env;
  return raw;
}

function richness(server: any) {
  let n = 0;
  if (server.command) n++;
  if (server.args && server.args.length) n++;
  if (server.url) n++;
  if (server.headers && Object.keys(server.headers).length) n++;
  if (server.env && Object.keys(server.env).length) n++;
  return n;
}

let writeLock = Promise.resolve();
function withLock(fn: any) {
  const prev = writeLock;
  let release: any;
  writeLock = new Promise((r: any) => (release = r));
  return prev.then(fn).finally(() => release());
}

async function loadAll() {
  return withLock(async () => {
    const byName = new Map();
    for (const agentId of getAllAgentIds()) {
      const meta = getAgentMeta(agentId);
      if (!meta) continue;
      let raw;
      try {
        raw = await readServers(meta);
      } catch (err) {
        console.warn(`[ace] read MCP for ${agentId} failed:`, err.message);
        continue;
      }
      const canonical = adaptReverse(meta.adapter, raw);
      for (const [name, entry] of Object.entries(canonical)) {
        const prior = byName.get(name);
        if (prior) {
          prior.providers.add(agentId);
          const next = rawToServer(name, entry, prior.providers);
          if (richness(next) > richness(prior.server)) prior.server = next;
        } else {
          const providers = new Set([agentId]);
          byName.set(name, { server: rawToServer(name, entry, providers), providers });
        }
      }
    }
    const installed = [];
    for (const { server, providers } of byName.values()) {
      installed.push({ ...server, providers: Array.from(providers) });
    }
    return { installed, catalog: getCatalog() };
  });
}

async function saveServer(server: any) {
  if (!server || !server.name || !/^[\w\-._]+$/.test(server.name)) {
    throw new Error(`invalid MCP server name "${server && server.name}"`);
  }
  return withLock(async () => {
    const selected = new Set(server.providers || []);
    const raw = serverToRaw(server);
    const writes = [];
    for (const agentId of getAllAgentIds()) {
      const meta = getAgentMeta(agentId);
      if (!meta) continue;
      let existing;
      try {
        existing = await readServers(meta);
      } catch (err) {
        throw new Error(`failed to read config for ${agentId}: ${err.message}`);
      }
      if (selected.has(agentId)) {
        const adapted = adaptForward(meta.adapter, { [server.name]: raw })[server.name];
        if (!adapted) continue;
        writes.push({ meta, servers: { ...existing, [server.name]: adapted } });
      } else if (server.name in existing) {
        const next = { ...existing };
        delete next[server.name];
        writes.push({ meta, servers: next });
      }
    }
    for (const { meta, servers } of writes) {
      try {
        await writeServers(meta, servers);
      } catch (err) {
        throw new Error(`failed to write config for ${meta.agentId}: ${err.message}`);
      }
    }
  });
}

async function removeServer({ serverName }: any) {
  return withLock(async () => {
    for (const agentId of getAllAgentIds()) {
      const meta = getAgentMeta(agentId);
      if (!meta) continue;
      let existing;
      try {
        existing = await readServers(meta);
      } catch {
        continue;
      }
      if (!(serverName in existing)) continue;
      const next = { ...existing };
      delete next[serverName];
      try {
        await writeServers(meta, next);
      } catch (err) {
        console.warn(`[ace] remove MCP from ${agentId} failed:`, err.message);
      }
    }
  });
}

async function getProviders() {
  const out = [];
  for (const agentId of getAllAgentIds()) {
    const meta = getAgentMeta(agentId);
    if (!meta) continue;
    let installed = false;
    try {
      await fsp.access(meta.configDir);
      installed = true;
    } catch {

    }
    out.push({
      id: agentId,
      name: meta.name,
      installed,
      supportsHttp: meta.supportsHttp,
    });
  }
  return out;
}

const CATALOG_RAW = {
  ace_core: {
    config: { command: 'ace', args: ['mcp-core'] },
    name: 'Ace Core',
    description: 'Compact Ace control-plane tools for orchestrators',
    docsUrl: 'https://github.com/skysphere-labs/ace-coder-public',
    credentialKeys: [],
    capability: 'ace-control-plane',
    enabledByDefault: true,
    enabledFor: 'orchestrators',
  },
  ace_browser: {
    config: { command: 'ace', args: ['mcp-browser'] },
    name: 'Ace Browser',
    description: 'Task-scoped control of visible Ace browser tabs',
    docsUrl: 'https://github.com/skysphere-labs/ace-coder-public',
    credentialKeys: [],
    capability: 'browser-automation',
    enabledByDefault: false,
  },
  playwright: {
    config: { command: 'npx', args: ['@playwright/mcp@latest'] },
    name: 'Playwright',
    description: 'Browser automation with Playwright',
    docsUrl: 'https://github.com/microsoft/playwright-mcp',
    credentialKeys: [],
    capability: 'browser-automation',
    enabledByDefault: false,
  },
  context7: {
    config: {
      type: 'http',
      url: 'https://mcp.context7.com/mcp',
      headers: { CONTEXT7_API_KEY: 'YOUR_API_KEY' },
    },
    name: 'Context7',
    description: 'Fetch up-to-date documentation and code examples',
    docsUrl: 'https://github.com/upstash/context7',
    credentialKeys: [{ key: 'CONTEXT7_API_KEY', required: false }],
  },
  supabase: {
    config: { type: 'http', url: 'https://mcp.supabase.com/mcp' },
    name: 'Supabase',
    description: 'Manage databases, authentication, and storage',
    docsUrl: 'https://supabase.com/docs/guides/getting-started/mcp',
    credentialKeys: [],
  },
  vercel: {
    config: { type: 'http', url: 'https://mcp.vercel.com' },
    name: 'Vercel',
    description: 'Analyze, debug, and manage projects and deployments',
    docsUrl: 'https://vercel.com/docs/mcp/vercel-mcp',
    credentialKeys: [],
  },
  sentry: {
    config: {
      type: 'http',
      url: 'https://mcp.sentry.dev/mcp',
      headers: { SENTRY_ACCESS_TOKEN: 'YOUR_ACCESS_TOKEN' },
    },
    name: 'Sentry',
    description: 'Search, query, and debug errors intelligently',
    docsUrl: 'https://docs.sentry.io/product/sentry-mcp/',
    credentialKeys: [{ key: 'SENTRY_ACCESS_TOKEN', required: true }],
  },
  stripe: {
    config: {
      type: 'http',
      url: 'https://mcp.stripe.com',
      headers: { STRIPE_SECRET_KEY: 'YOUR_SECRET_KEY' },
    },
    name: 'Stripe',
    description: 'Payment processing and financial infrastructure tools',
    docsUrl: 'https://docs.stripe.com/mcp',
    credentialKeys: [{ key: 'STRIPE_SECRET_KEY', required: true }],
  },
  figma: {
    config: { type: 'http', url: 'https://mcp.figma.com/mcp' },
    name: 'Figma',
    description: 'Generate diagrams and better code from Figma context',
    docsUrl: 'https://help.figma.com/hc/en-us/articles/32132100833559',
    credentialKeys: [],
  },
  linear: {
    config: { type: 'http', url: 'https://mcp.linear.app/mcp' },
    name: 'Linear',
    description: 'Manage issues, projects & team workflows in Linear',
    docsUrl: 'https://linear.app/docs/mcp',
    credentialKeys: [],
  },
  slack: {
    config: { type: 'http', url: 'https://mcp.slack.com/mcp' },
    name: 'Slack',
    description: 'Send messages, create canvases, and fetch Slack data',
    docsUrl: 'https://docs.slack.dev/ai/mcp-server',
    credentialKeys: [],
  },
  cloudflare: {
    config: { type: 'http', url: 'https://bindings.mcp.cloudflare.com/mcp' },
    name: 'Cloudflare Developer Platform',
    description: 'Build applications with compute, storage, and AI',
    docsUrl: 'https://www.cloudflare.com/',
    credentialKeys: [],
  },
  netlify: {
    config: { type: 'http', url: 'https://netlify-mcp.netlify.app/mcp' },
    name: 'Netlify',
    description: 'Create, deploy, manage, and secure websites on Netlify',
    docsUrl: 'https://docs.netlify.com/build/build-with-ai/netlify-mcp-server/',
    credentialKeys: [],
  },
  chrome_devtools: {
    config: { command: 'npx', args: ['chrome-devtools-mcp@latest'] },
    name: 'Chrome DevTools',
    description: 'Browser automation, debugging and performance analysis with Chrome DevTools',
    docsUrl: 'https://github.com/ChromeDevTools/chrome-devtools-mcp',
    credentialKeys: [],
  },
  atlassian: {
    config: { type: 'http', url: 'https://mcp.atlassian.com/v1/mcp' },
    name: 'Atlassian',
    description: 'Access Jira & Confluence from Claude',
    docsUrl: 'https://www.atlassian.com/',
    credentialKeys: [],
  },
  notion: {
    config: { type: 'http', url: 'https://mcp.notion.com/mcp' },
    name: 'Notion',
    description: 'Connect your Notion workspace to search, update, and power workflows',
    docsUrl: 'https://developers.notion.com/docs/mcp',
    credentialKeys: [],
  },
  clerk: {
    config: { type: 'http', url: 'https://mcp.clerk.com/mcp' },
    name: 'Clerk',
    description: 'Add authentication, organizations, and billing',
    docsUrl: 'https://clerk.com/docs/guides/ai/mcp/clerk-mcp-server',
    credentialKeys: [],
  },
  planetscale: {
    config: { type: 'http', url: 'https://mcp.pscale.dev/mcp/planetscale' },
    name: 'PlanetScale',
    description: 'Authenticated access to your Postgres and MySQL DBs',
    docsUrl: 'https://planetscale.com/docs/connect/mcp',
    credentialKeys: [],
  },
  bigquery: {
    config: { type: 'http', url: 'https://bigquery.googleapis.com/mcp' },
    name: 'Google Cloud BigQuery',
    description: 'BigQuery: Advanced analytical insights for agents',
    docsUrl: 'https://cloud.google.com/bigquery/docs/use-bigquery-mcp',
    credentialKeys: [],
  },
  hugging_face: {
    config: { type: 'http', url: 'https://huggingface.co/mcp' },
    name: 'Hugging Face',
    description: 'Access the Hugging Face Hub and thousands of Gradio Apps',
    docsUrl: 'https://huggingface.co/settings/mcp',
    credentialKeys: [],
  },
  exa: {
    config: {
      command: 'npx',
      args: ['-y', 'exa-mcp-server', 'tools=web_search_exa,get_code_context_exa'],
      env: { EXA_API_KEY: 'YOUR_API_KEY' },
    },
    name: 'Exa',
    description: 'Web search and code context retrieval powered by Exa AI',
    docsUrl: 'https://docs.exa.ai/reference/exa-mcp',
    credentialKeys: [{ key: 'EXA_API_KEY', required: true }],
  },
  posthog: {
    config: { type: 'http', url: 'https://mcp.posthog.com/mcp' },
    name: 'PostHog',
    description: 'Query, analyze, and manage your PostHog insights',
    docsUrl: 'https://posthog.com/docs/model-context-protocol',
    credentialKeys: [],
  },
  honeycomb: {
    config: { type: 'http', url: 'https://mcp.honeycomb.io/mcp' },
    name: 'Honeycomb',
    description: 'Query and explore observability data and SLOs',
    docsUrl: 'https://docs.honeycomb.io/',
    credentialKeys: [],
  },
  graphos: {
    config: { type: 'http', url: 'https://mcp.apollographql.com' },
    name: 'GraphOS MCP Tools',
    description: 'Search Apollo docs, specs, and best practices',
    docsUrl: 'https://www.apollographql.com/docs/graphos/platform/graphos-mcp-tools',
    credentialKeys: [],
  },
  sanity: {
    config: { type: 'http', url: 'https://mcp.sanity.io' },
    name: 'Sanity',
    description: 'Create, query, and manage structured content in Sanity',
    docsUrl: 'https://www.sanity.io/docs/ai/mcp-server',
    credentialKeys: [],
  },
  amplitude: {
    config: { type: 'http', url: 'https://mcp.amplitude.com/mcp' },
    name: 'Amplitude',
    description: 'Search, access, and get insights on your Amplitude data',
    docsUrl: 'https://amplitude.com/docs/analytics/amplitude-mcp',
    credentialKeys: [],
  },
  asana: {
    config: { type: 'http', url: 'https://mcp.asana.com/v2/mcp' },
    name: 'Asana',
    description: 'Connect to Asana to coordinate tasks, projects, and goals',
    docsUrl: 'https://developers.asana.com/docs/mcp-server',
    credentialKeys: [],
  },
  clickup: {
    config: { type: 'http', url: 'https://mcp.clickup.com/mcp' },
    name: 'ClickUp',
    description: 'Project management & collaboration for teams & agents',
    docsUrl: 'https://help.clickup.com/',
    credentialKeys: [],
  },
  microsoft_learn: {
    config: { type: 'http', url: 'https://learn.microsoft.com/api/mcp' },
    name: 'Microsoft Learn',
    description: 'Search trusted Microsoft docs to power your development',
    docsUrl: 'https://learn.microsoft.com/en-us/training/support/mcp',
    credentialKeys: [],
  },
  canva: {
    config: { type: 'http', url: 'https://mcp.canva.com/mcp' },
    name: 'Canva',
    description: 'Search, create, autofill, and export Canva designs',
    docsUrl: 'https://www.canva.dev/docs/connect/canva-mcp-server-setup/',
    credentialKeys: [],
  },
  intercom: {
    config: { type: 'http', url: 'https://mcp.intercom.com/mcp' },
    name: 'Intercom',
    description: 'Access to Intercom data for better customer insights',
    docsUrl: 'https://developers.intercom.com/docs/guides/mcp',
    credentialKeys: [],
  },
  deepwiki: {
    config: { type: 'http', url: 'https://mcp.deepwiki.com/mcp' },
    name: 'DeepWiki',
    description: 'Context and Q&A for any GitHub repo via DeepWiki',
    docsUrl: 'https://cognition.ai/blog/deepwiki-mcp-server',
    credentialKeys: [],
  },
};

const CATALOG = Object.entries(CATALOG_RAW).map(([key, entry]: any) => ({
  key,
  name: entry.name,
  description: entry.description,
  docsUrl: entry.docsUrl,
  defaultConfig: entry.config,
  credentialKeys: entry.credentialKeys,
  ...(entry.capability ? { capability: entry.capability } : {}),
  ...(typeof entry.enabledByDefault === 'boolean' ? { enabledByDefault: entry.enabledByDefault } : {}),
  ...(entry.enabledFor ? { enabledFor: entry.enabledFor } : {}),
}));

function getCatalog() {
  return CATALOG.map((entry: any) => ({
    ...entry,
    defaultConfig: clone(entry.defaultConfig),
    credentialKeys: clone(entry.credentialKeys || []),
  }));
}

module.exports = {
  loadAll,
  saveServer,
  removeServer,
  getProviders,
  getCatalog,
  getAllAgentIds,
  getAgentMeta,
};
