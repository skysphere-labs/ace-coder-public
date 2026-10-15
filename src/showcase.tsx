/**
 * Browser-only screenshot fixture entry. Start Vite on loopback and visit
 * /showcase.html?view=home (or workspaces, workspace, lane-deck, board, loops,
 * todos, plugins, github, remote, knowledge, monitor, intel, settings, setup,
 * hermes-chat, editor). Select README.md in the file panel to preview/edit it.
 * Vite's production entry is index.html; this file is never imported by it.
 * Every value below is fictional. No Electron preload, API, filesystem,
 * credentials, provider process, or real repository is used.
 */
import { DEFAULT_OPERATORS } from './lib/operators';
import type { Workspace, Task, RunLedgerCard, AgentId } from './lib/types';
import type { RendererLoopSpec, OpsTodo, StreamEntry, TerminalSyncPayload, StreamEventPayload } from './lib/ace-api';

if (!import.meta.env.DEV || window.aceDesktop || !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) {
  throw new Error('The fictional showcase only runs in a loopback development browser without Electron.');
}

const now = Date.now();
const requested = new URLSearchParams(location.search).get('view') ?? 'home';
const at = new Date(now).toISOString();
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
const blockedMethods = new Set<string>();
const syncListeners = new Set<(payload: TerminalSyncPayload) => void>();
Object.defineProperty(window, '__ACE_SHOWCASE__', { value: { synthetic: true, blockedMethods }, writable: false });
// Never allow an accidental HTTP bridge fallback or outgoing page request.
const localFetch = window.fetch.bind(window);
window.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input), location.href);
  if (url.origin !== location.origin || /^\/(api|enroll|ws)(\/|$)/.test(url.pathname)) {
    return Promise.reject(new Error('Showcase network access is disabled.'));
  }
  return localFetch(input, init);
};
window.open = () => null;
document.addEventListener('click', (event) => {
  const anchor = (event.target as Element | null)?.closest?.('a');
  if (anchor?.href && new URL(anchor.href).origin !== location.origin) event.preventDefault();
}, true);

const task = (id: string, name: string, agent: AgentId, age: number): Task => ({
  id, name, branch: `demo/${id}`, type: 'task', status: 'idle', agent,
  updatedAt: ago(age), agentInstalled: true, autoApproveEnabled: false,
  additions: 84 + age, deletions: 12, initialPrompt: `Fictional demo task: ${name}.`,
  worktrees: [{ worktreeId: `wt-${id}`, displayName: name, branch: `demo/${id}`, path: `/fictional/worktrees/${id}`,
    variants: [{ id: `lane-${id}`, name: agent === 'claude' ? 'Claude' : 'Codex', agent, branch: `demo/${id}`, worktreeId: `wt-${id}`, kind: 'cli' }] }],
  conversations: [], fileChanges: [{ path: 'src/components/Overview.tsx', status: 'modified', additions: 84, deletions: 12 }],
});
const tasks = [
  task('accessible-search', 'Accessible command search', 'claude', 4),
  task('cache-index', 'Incremental document indexing', 'codex', 12),
  task('keyboard-review', 'Keyboard navigation review', 'codex', 25),
];
if (requested === 'hermes-chat') {
  const hermes = task('release-review', 'Release notes review', 'hermes', 3);
  hermes.worktrees![0].variants[0].name = 'Hermes';
  tasks.push(hermes);
}
const workspaces: Workspace[] = [
  { id: 'demo-observatory', name: 'Observatory', path: '/fictional/projects/observatory', isRemote: false,
    sshHost: null, sshUser: null, remotePath: null, agentUser: null, defaultBranch: 'main',
    tasks, archivedTasks: [], githubRepo: 'fictional-demo/observatory', isInitialized: true, branches: [], openPrs: [], cleanupBranches: [] },
  { id: 'demo-field-notes', name: 'Field Notes', path: '/fictional/projects/field-notes', isRemote: false,
    sshHost: null, sshUser: null, remotePath: null, agentUser: null, defaultBranch: 'main',
    tasks: [task('export-notes', 'Markdown export', 'claude', 58)], archivedTasks: [],
    githubRepo: 'fictional-demo/field-notes', isInitialized: true, branches: [], openPrs: [], cleanupBranches: [] },
];
const todos: OpsTodo[] = [
  ['todo-search', 'Review the accessible search preview', 'demo-observatory', 'high'],
  ['todo-notes', 'Document the Markdown export format', 'demo-field-notes', 'medium'],
  ['todo-index', 'Compare indexing results on the demo corpus', 'demo-observatory', 'medium'],
].map(([id, text, workspaceId, priority]) => ({ $schema: 'ace.ops.todo.v1', id, text, workspaceId,
  priority: priority as OpsTodo['priority'], kind: 'dev', status: 'open', owner: null,
  createdAt: ago(120), updatedAt: ago(5), promotedMissionId: null, notes: 'Fictional showcase item.',
  source: 'showcase', dueAt: null, tags: ['demo'] }));
const card = (id: string, name: string, stage: RunLedgerCard['stage'], agent: string, workspaceId: string): RunLedgerCard => ({
  id, key: id, name, agentId: agent, missionId: null, workspaceId, stage, assignee: agent,
  branch: `demo/${id}`, prUrl: null, prStatus: null, currentHeadSha: null, validatedHeadSha: null,
  skysphereRef: null, skysphere: null, workerOutcome: stage === 'done' ? 'DONE' : null,
  validationStatus: stage === 'done' ? 'PASS' : null, blocked: stage === 'blocked',
  nextAction: stage === 'todo' ? 'Review acceptance criteria' : stage === 'ready_to_review' ? 'Review the keyboard navigation evidence' : null,
  autoshipStatus: null, autoshipReason: null, lastEventType: 'demo_snapshot', lastTs: now - 180_000,
  loop: null, telemetry: { agent, rubric: 'fictional demo', score: stage === 'done' ? 100 : null, commands: 9, durationMs: 340_000, tokens: 8400, reports: 1 },
  detail: { description: 'A fictional task showing the local run ledger and its evidence.', context: 'Synthetic showcase data.',
    acceptance: ['Keyboard controls work', 'Focused checks pass', 'Owner review is required before publishing'], constraints: ['Use local fixtures'], risk: 'low',
    worker: { taskId: tasks[0].id, streamId: `variant:lane-${tasks[0].id}`, branch: `demo/${id}`, worktreePath: `/fictional/worktrees/${id}`, outcome: null },
    validator: { taskId: null, streamId: null, outcome: stage === 'done' ? 'PASS' : null, computerUseRequired: false, evidence: 'Fictional example evidence' },
    pr: { number: null, url: null, state: null, mergeable: null, checkState: null, changedFiles: ['src/components/Overview.tsx'] },
    merge: { merged: stage === 'done', sha: null, cleanedUp: false }, decision: { next: 'Owner review', reason: 'Demo only' },
    history: [{ type: 'run.created', ts: now - 600_000 }], gate: null, autoship: null },
});
const cards = [
  card('plan-export', 'Plan structured note export', 'todo', 'claude', 'demo-field-notes'),
  card('accessible-search', 'Accessible command search', 'in_progress', 'claude', 'demo-observatory'),
  card('cache-index', 'Incremental document indexing', 'in_progress', 'codex', 'demo-observatory'),
  card('keyboard-review', 'Keyboard navigation review', 'ready_to_review', 'codex', 'demo-observatory'),
  card('local-store', 'Local storage migration checks', 'done', 'claude', 'demo-field-notes'),
];
const board = { cards, columns: Object.fromEntries(['todo', 'in_progress', 'ready_to_review', 'done', 'blocked'].map(stage => [stage, cards.filter(c => c.stage === stage).map(c => c.id)])),
  counts: { todo: 1, inProgress: 2, readyToReview: 1, done: 1, blocked: 0, total: 5 },
  followUps: { $schema: 'ace.follow-up-digest.v1', generatedAt: now, pendingCount: 0, text: 'No demo follow-ups pending.', items: [] } };
const loops: RendererLoopSpec[] = [
  { id: 'demo-checks', name: 'Focused regression pass', description: 'Run project checks, inspect failures, and prepare a reviewable fix.', useWhen: 'A small feature needs a repeatable verification pass.', kind: 'code', inputs: {},
    goalTemplate: 'Make the focused checks pass and prepare evidence for owner review.',
    routing: { agent: 'codex', skills: ['test-review'], workspace: 'loops', target: { repo: '/fictional/projects/observatory', allow: ['src/**', 'tests/**'] } },
    contract: { stop: { primary: 'converged' }, ceilings: { maxIterations: 3, maxSpendUsd: 5, maxRuntimeMs: 900000 },
      verify: { requireValidatorPass: true, requireComputerUseEvidence: false }, permissions: [], merge: { ownerGated: true } },
    evidence: {}, triggers: [], meta: { version: 1 } },
  { id: 'demo-docs', name: 'Documentation review', description: 'Inspect public examples for clarity and propose a concise documentation update.', useWhen: 'A feature changes its setup instructions.', kind: 'agentic', inputs: {},
    goalTemplate: 'Prepare a documentation change with tested fictional examples.',
    routing: { agent: 'claude', skills: ['docs-review'], workspace: 'loops', target: { allow: ['docs/**'] } },
    contract: { stop: { primary: 'no-progress' }, ceilings: { maxIterations: 2, maxSpendUsd: 3 },
      verify: { requireValidatorPass: true, requireComputerUseEvidence: false }, permissions: [], merge: { ownerGated: true } },
    evidence: {}, meta: { version: 1 } },
];
const streams: StreamEntry[] = workspaces.flatMap(ws => ws.tasks.flatMap(t => (t.worktrees ?? []).flatMap(wt => wt.variants.map(v => ({
  streamId: `variant:${v.id}`, agent: v.agent, cwd: wt.path, label: t.name, state: (t.id === 'accessible-search' || t.id === 'cache-index') ? 'busy' as const : 'awaiting-input' as const,
  profile: v.agent, taskId: t.id, workspaceId: ws.id, live: true,
})))));
const terminalText = (id: string) => {
  const stream = streams.find(s => s.streamId === id) ?? streams[0];
  return `\x1b[1;36m${stream.agent === 'claude' ? 'Claude' : 'Codex'} · ${stream.label}\x1b[0m\r\n\r\nFictional session — no agent process is running.\r\n\r\n> Review the implementation and verify the focused checks.\r\n\r\n\x1b[32m✓\x1b[0m Read the project brief and acceptance criteria\r\n\x1b[32m✓\x1b[0m Prepared an isolated worktree\r\n\x1b[32m✓\x1b[0m Focused checks: 12 passed\r\n\r\nReady for the next instruction.\r\n`;
};
const catalog = ['claude', 'codex', 'gemini', 'hermes'].map(id => ({ id, name: ({claude:'Claude Code',codex:'Codex',gemini:'Gemini CLI',hermes:'Hermes'})[id], label: id,
  installCommand: null, docUrl: null, status: id === 'hermes' && requested !== 'hermes-chat' ? 'missing' : 'available', launchable: id !== 'hermes' || requested === 'hermes-chat', executable: null, reason: 'Fictional showcase availability' }));
const skills = [
  ['demo-test-review', 'Test review', 'Review focused regression checks and explain evidence.'],
  ['demo-docs-review', 'Documentation review', 'Turn feature changes into clear setup instructions.'],
  ['demo-accessibility', 'Accessibility audit', 'Check keyboard navigation, contrast, and semantics.'],
].map(([id, displayName, description]) => ({ id, displayName, description, source: 'local', provenance: 'external', agentCompatibility: 'shared', installed: true,
  localPath: `/fictional/skills/${id}`, skillMdContent: `# ${displayName}\n\nFictional example skill for the showcase.`, frontmatter: {name: displayName, description} }));
const repos = workspaces.map((ws, i) => ({ id: i + 1, name: ws.name.toLowerCase().replaceAll(' ', '-'), fullName: ws.githubRepo, owner: 'fictional-demo', ownerAvatarUrl: null,
  description: i === 0 ? 'A local-first workspace dashboard.' : 'A small Markdown notebook.', private: false, fork: false,
  htmlUrl: `https://example.invalid/${ws.githubRepo}`, cloneUrl: `https://example.invalid/${ws.githubRepo}.git`, sshUrl: '', defaultBranch: 'main', stars: 18 + i * 7, language: 'TypeScript', pushedAt: ago(32), updatedAt: at, lastCommit: null }));
const knowledge = { ok: true, total: 24, dbPath: '/fictional/profile/knowledge.sqlite', wikiRoot: '/fictional/projects/wiki',
  byTrust: [{ trust: 'canon', n: 14 }, { trust: 'working', n: 8 }, { trust: 'raw', n: 2 }],
  bySource: [{ source: 'project-wiki', n: 18 }, { source: 'run-ledger', n: 6 }],
  byProject: [{ project: 'Observatory', docs: 16, lastAt: at }, { project: 'Field Notes', docs: 8, lastAt: at }],
  agents: [{ identity: 'codex', project: 'Observatory', docs: 6, lastAt: at }, { identity: 'claude', project: 'Field Notes', docs: 4, lastAt: at }],
  hermes: [], candidates: [{ project: 'Observatory', docs: 2, lastAt: at }],
  recentRuns: [{ title: 'Keyboard navigation verification', path: '/fictional/wiki/runs/navigation.md', relPath: 'runs/navigation.md', project: 'Observatory', updatedAt: at }],
  recentJournal: [{ title: 'Local storage design decisions', path: '/fictional/wiki/journal/storage.md', relPath: 'journal/storage.md', updatedAt: at }] };
const findings = ['Local database', 'Run ledger', 'Provider lanes'].map((title, i) => ({ $schema: 'ace.ops.health-finding.v1', id: `demo-health-${i}`, category: i === 0 ? 'db' : 'runtime',
  severity: 'green', status: 'ok', title, message: 'Fictional healthy status for the showcase.',
  evidence: { source: 'ace-electron', path: null, command: null, lastChecked: at, freshness: 'fresh', ageSeconds: 0 }, recommendedAction: null, confidence: 1, isLive: false, details: {} }));
const remote = { enabled: false, running: false, port: 4317, tunnelMode: 'loopback', lanHost: null, tailscaleHost: null,
  primaryUrl: 'http://127.0.0.1:4317', allowlist: [], connectedClients: 0 };
const snapshots: Record<string, unknown> = {
  runtimeState: {status: 'ready'}, getState: { workspaces, missions: [], rev: 1 },
  getAgentCatalog: catalog, getStarredAgents: ['claude', 'codex'], listAgentLanes: [], listHermesProfiles: [],
  getSystemTools: ['git', 'node', 'gh'].map(id => ({ id, label: id, description: 'Fictional demo tool', kind: 'required', found: true, ok: true, version: 'demo' })),
  operatorsList: { config: DEFAULT_OPERATORS, source: 'default' },
  dataRootGet: { root: '/fictional/profile/ACE CODER', active: true, source: 'local', reason: null, configuredRoot: null },
  hermesDesktopStatus: { surface: 'lanes', config: { version: 1, defaultSurface: 'lanes', workspaceOverrides: {}, dashboard: { host: '127.0.0.1', extraArgs: [], desktopAppPath: null } }, dashboards: [] },
  hermesDesktopGetActiveProfile: { profile: null },
  cliGetStatus: { installed: false, method: null, path: null },
  usageGetProviders: { generatedAt: now, providers: ['claude', 'codex'].map((id, i) => ({ id, name: i === 0 ? 'Claude' : 'Codex', plan: 'Fictional', accountLabel: 'Demo account', state: 'live', asOf: now,
    session: { tokens: null, limit: null, percent: 18 + i * 12, windowMinutes: 300, resetsAt: now + 7200000 },
    weekly: { tokens: null, limit: null, percent: 34 + i * 8, windowMinutes: 10080, resetsAt: now + 172800000 }, lastActivityMs: now })) },
  opsTodosList: todos, opsTodoDigest: { $schema: 'ace.ops.todo-digest.v1', slot: 'morning', generatedAt: at, openCount: 3,
    groups: [{label:'Project work',todoIds:todos.map(t=>t.id)}], goals: [{text:'Prepare Observatory for a focused review.',todoIds:[todos[0].id]}], suggestions: [], markdown: 'Three fictional next steps across two workspaces.', source: 'rules' },
  runBoard: board, loopsList: loops, loopsStatus: { active: [], inFlight: 0, lineages: {} },
  streamList: { streams }, streamGetState: {state:'awaiting-input'},
  streamProfiles: {profiles:[{id:'hermes',detect:{agent:'hermes'},slash:['help','compact','model','status','tools','skills'],composer:{placeholders:{default:'Message Hermes…'}}}]},
  skillsGetCatalog: { version: 1, lastUpdated: at, skills }, skillsRefreshCatalog: { version: 1, lastUpdated: at, skills }, skillsDetectedAgents: [],
  mcpLoadAll: { installed: [{name:'Local documentation',transport:'stdio',command:'demo-docs-server',args:[],providers:['claude','codex']}],
    catalog: [{key:'demo-docs',name:'Local documentation',description:'Fictional MCP server example.',docsUrl:'https://example.invalid/docs',defaultConfig:{},credentialKeys:[]}] },
  mcpGetProviders: [{id:'claude',name:'Claude Code',installed:true,supportsHttp:true},{id:'codex',name:'Codex',installed:true,supportsHttp:true}],
  githubIsAvailable: { installed: true, version: 'Fictional gh fixture' }, githubRefreshAvailability: { installed: true },
  githubListAccounts: [{login:'fictional-demo',avatarUrl:null,isActive:true,name:'Demo Developer',bio:'Fictional account for ACE CODER screenshots.',htmlUrl:'https://example.invalid/demo',followers:42,following:12,publicRepos:2,location:null,company:null,blog:null}],
  githubListRepos: repos, githubListStars: [repos[0]], githubListTrending: {at:now,data:[]},
  githubFetchContributions: {total:128,year:2026,weeks:Array.from({length:26},(_,week)=>({days:Array.from({length:7},(_,day)=>({date:new Date(now-(182-week*7-day)*86400000).toISOString().slice(0,10),count:(week+day)%5,level:(week+day)%5}))}))},
  listTrackedGithubProjects: { projects: workspaces.map(ws => ({workspaceId:ws.id,workspaceName:ws.name,workspacePath:ws.path,isRemote:false,githubRepo:ws.githubRepo,githubUrl:`https://example.invalid/${ws.githubRepo}`,defaultBranch:'main',wikiPath:`${ws.path}/wiki/index.md`,wikiExists:true,activeTasks:ws.tasks,openPrs:[]})) },
  remoteGetStatus: remote, remoteListDevices: [], remoteDetectTunnels: [{id:'tailscale',name:'Tailscale',recommended:false,available:false,host:null}],
  knowledgeStatus: knowledge, knowledgeOverview: knowledge, knowledgeNightlyStatus: {ok:true,state:null,history:[],disabled:true,curator:{enabled:false,workspaceId:null,agent:'codex'}}, knowledgeQuarantineList: {ok:true,items:[]},
  opsStatus: {schema:'ace.ops.status.v1',timestamp:at,workspaceId:null,configPath:'/fictional/profile/ops-config.json',rollup:{severity:'green',green:3,yellow:0,red:0,black:0,counts:{}},findings,warnings:[]},
  opsSignals: [], opsRecommendations: [], opsPulse: {schema:'ace.ops.pulse.v1',timestamp:at,days:7,projects:[],opsFindings:{yellow:0,red:0,black:0,titles:[]}},
  opsBrief: {$schema:'ace.ops.brief.v1',lens:'morning',generatedAt:at,intelAsOf:at,sourceFreshness:'fresh',headline:'Two projects, three clear next steps.',sections:[{title:'Project focus',items:[{text:'Review accessible search in Observatory.',why:'The implementation is ready for keyboard testing.'},{text:'Confirm the Field Notes export format.',why:'A small documentation decision unblocks the next task.'}]}],deltaSummary:'Fictional showcase summary.',candidateCount:0},
  opsBriefSchedule: {slots:[]}, opsSourceState: {sources:[],lastRunAt:null,lastTrigger:null}, opsSourcesGet: {$schema:'ace.ops.sources.v1',watchlists:{feeds:[],accounts:[],repos:[],changelogs:[]},editableAt:null,fromLatestJson:false},
  opsIntel: {at,generatedAt:at,sourcePath:'/fictional/intel.json',status:'ok',freshness:'fresh',sections:[],projectFit:[],projectMoves:{facts:[],suggestions:[]},hotAiApp:null,prices:[],seenItemsTotal:0},
  opsWikiGraph: {$schema:'ace.ops.wiki-graph.v1',generatedAt:at,root:'/fictional/wiki',nodes:[],edges:[],stats:{nodeCount:0,edgeCount:0,orphanCount:0}},
  telemetryQuery: {ok:true,events:[],rows:[],total:0},
  gitStatus: {staged:[],unstaged:tasks[0].fileChanges,totals:{additions:84,deletions:12},branch:'demo/accessible-search',ahead:1,behind:0,hasUpstream:false,githubRepo:'fictional-demo/observatory'},
  gitLog: {commits:[]}, listTaskFiles: {entries:[{name:'src',kind:'dir',relativePath:'src'},{name:'README.md',kind:'file',relativePath:'README.md'}]},
  listWorkspaceFiles: {entries:[{name:'src',kind:'dir',relativePath:'src'},{name:'README.md',kind:'file',relativePath:'README.md'}]},
  listEditorOpenFiles: {openFiles:[],activeFile:null}, listScratchTabs: {tabs:[],activeId:null}, browserList: {tabs:[]},
  getTaskSpec: {ok:false,error:'Fictional showcase: no on-disk task spec.'},
  getWorkspaceStats: {files:46,bytes:240000,loc:3820}, getWorkspaceStatsDetail: {files:46,bytes:240000,loc:3820,topByBytes:[],topByLoc:[],byDir:[],skipped:{binaryExt:0,binaryNull:0}},
  listRemoteHosts: {hosts:[]}, perfRecord: {ok:true},
};
async function invoke(method: string, payload: unknown): Promise<unknown> {
  const input = (payload ?? {}) as Record<string, string>;
  if (method in snapshots) return structuredClone(snapshots[method]);
  if (method === 'loopsGet') return loops.find(l => l.id === input.id) ?? null;
  if (method === 'skillsGetDetail') return skills.find(s => s.id === input.skillId) ?? null;
  if (method === 'skillsSearch') return skills;
  if (method === 'getTerminalSync') return {streamId:input.streamId,state:terminalText(input.streamId),seq:1,cols:100,rows:32};
  if (method === 'getStreamSnapshot') return {id:input.streamId,agent:'codex',status:'idle',chunks:[terminalText(input.streamId)]};
  if (method === 'streamReadScreen' || method === 'streamFollow') return {text:terminalText(input.streamId),cursor:null,state:'awaiting-input'};
  if (method === 'streamTranscript') return {streamId:input.streamId,sessionId:'fictional-session',sessionFile:'/fictional/transcript.jsonl',agent:input.streamId.includes('release-review') ? 'hermes' : 'codex',entries:[
    {id:1,role:'user',text:'Review the release notes for Observatory. Summarize the changes and suggest a short owner-review checklist.',lifecycle:'finished',tAt:now-300000},
    {id:2,role:'tool',name:'read_file',args:{path:'docs/release-notes.md'},result:'Fictional fixture: keyboard search, incremental indexing, and Markdown export.',status:'ok',lifecycle:'finished',tAt:now-240000},
    {id:3,role:'agent',text:'The draft covers three changes:\n\n- **Keyboard search:** discover commands without leaving the editor.\n- **Incremental indexing:** update only documents that changed.\n- **Markdown export:** keep notes portable.\n\nBefore release, review the keyboard flow, inspect a sample export, and confirm the setup guide.\n\n*This is a fictional transcript; no agent or file operation ran.*',model:'Fictional model',tokens:{input:1200,output:180,total:1380},lifecycle:'finished',tAt:now-120000}
  ],nextCursor:3,warnings:[],state:'idle'};
  // Synthetic terminal session/resize plumbing never creates a process.
  if (method === 'ensureVariantSession' || method === 'ensureWorkItemSession') return {sessionId:input.variantId ? `variant:${input.variantId}` : `conversation:${input.conversationId}`};
  if (method === 'ensureStreamStarted' || method === 'resizeTerminal') {
    const sync = {streamId:input.streamId,state:terminalText(input.streamId),seq:1,cols:Number(input.cols)||100,rows:Number(input.rows)||32};
    queueMicrotask(() => syncListeners.forEach(listener => listener(sync)));
    return {ok:true};
  }
  if (method === 'knowledgeSearch') return {ok:true,query:input.query,total:2,results:[{path:'/fictional/wiki/design.md',relPath:'design.md',source:'project-wiki',project:'Observatory',title:'Accessible command search',kind:'design',trust:'canon',tags:['keyboard','search'],updatedAt:at,freshness:'fresh',decay:1,decayReasons:[],excerpt:'Keyboard navigation, focus order, and the local search index contract.',score:1},{path:'/fictional/wiki/export.md',relPath:'export.md',source:'project-wiki',project:'Field Notes',title:'Markdown export format',kind:'guide',trust:'working',tags:['markdown'],updatedAt:at,freshness:'fresh',decay:1,decayReasons:[],excerpt:'Portable notes with deterministic Markdown output.',score:0.8}]};
  if (method === 'knowledgeGet' || method === 'readTaskFile' || method === 'readWorkspaceFile') return {ok:true,path:input.path,body:'# Fictional project notes\n\nThis is synthetic showcase content.',content:'# Observatory\n\nA fictional project used to demonstrate the ACE CODER editor.\n\n## Release checklist\n\n- [x] Design keyboard command search\n- [x] Document the incremental index\n- [ ] Review the exported Markdown\n\n## Local development\n\n```sh\nnpm install\nnpm run dev\n```\n\nAll text on this page is synthetic. No file is read or written.\n'};
  if (method === 'openExternal' || method === 'openFolder') return {ok:false};
  blockedMethods.add(method);
  throw new Error(`Fictional showcase: ${method} is unavailable. No backend action was taken.`);
}
const noop = () => {};
window.aceDesktop = new Proxy({ invoke }, {
  get(target, property) {
    if (property === 'invoke') return target.invoke;
    if (property === 'onPtySync') return (listener: (payload: TerminalSyncPayload) => void) => {
      syncListeners.add(listener);
      return () => syncListeners.delete(listener);
    };
    if (property === 'onStreamEvent') return (listener: (payload: StreamEventPayload) => void) => {
      const timer = window.setTimeout(() => streams.forEach(stream => listener({event:'state-change',payload:{streamId:stream.streamId,to:stream.state}} as StreamEventPayload)), 100);
      return () => window.clearTimeout(timer);
    };
    if (property === 'subscribe' || String(property).startsWith('on')) return () => noop;
    if (String(property).startsWith('send')) return noop;
    return undefined;
  },
}) as NonNullable<Window['aceDesktop']>;

const views = ['home','today','workspaces','workspace','lane-deck','new-chat','new-remote','board','loops','todos','plugins','github','github-browser','remote','knowledge','monitor','intel','settings','setup'];
const view = requested === 'hermes-chat' || requested === 'editor' ? 'workspace' : views.includes(requested) ? requested : 'home';
if (requested === 'hermes-chat') localStorage.setItem('ace:ace-chat-mode:hermes:variant:lane-release-review', 'chat');
localStorage.setItem('ace:setup-v1', '1');
localStorage.setItem('ace:nav-v1', JSON.stringify({view,activeWorkspaceId:workspaces[0].id,activeTaskId:requested === 'hermes-chat' ? 'release-review' : view === 'workspace' ? tasks[0].id : null}));
void import('./main');
