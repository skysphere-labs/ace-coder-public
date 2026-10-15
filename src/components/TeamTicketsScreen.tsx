import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ExternalLink, FolderGit2, Plus, RefreshCw, Search, Ticket, X } from 'lucide-react';
import { aceApi, isRemoteClient } from '../lib/ace-api';
import type { AgentCatalogEntry, AgentId } from '../lib/types';
import type { TeamTicket, TeamTicketConnection, TeamTicketConnectionInput, TeamTicketPreview } from '../lib/team-tickets-types';
import { useWorkspaceCatalog } from '../runtime/workspace-registry';
import { showToast } from '../runtime/undo-registry';
import { useApp } from '../store';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Spinner } from './ui/spinner';

const fieldClass = 'w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50';
const kinds = { 'jira-cloud': 'Jira Cloud', 'jira-datacenter': 'Jira Data Center', 'json-board': 'JSON board' };

/** Keep the desktop hook subtree unmounted on paired browser clients. */
export function TeamTicketsScreen() {
  return (
    <div className="shell-sidebar-surface flex h-full flex-col overflow-y-auto text-foreground">
      <header className="mx-auto w-full max-w-7xl px-5 pb-6 pt-8 sm:px-8">
        <div className="mb-3 flex items-center gap-2 text-xs font-medium uppercase tracking-widest text-muted-foreground"><Ticket className="h-4 w-4" /> Team tickets</div>
        <h1 className="text-2xl font-semibold tracking-tight">From your board to a coding task</h1>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted-foreground">Connect Jira or your own ticket service, review the context, and launch an agent in a project you choose. Tickets stay unchanged in your board.</p>
      </header>
      {isRemoteClient() ? (
        <div className="mx-auto w-full max-w-7xl px-5 sm:px-8"><div className="rounded-xl border border-border p-6 text-sm text-muted-foreground">Open Tickets in the desktop app to manage connections and launch work. Ticket credentials and previews are unavailable in paired browser sessions.</div></div>
      ) : <DesktopTeamTickets />}
    </div>
  );
}

function DesktopTeamTickets() {
  const { openTask } = useApp();
  const projects = useWorkspaceCatalog().filter(workspace => !workspace.isRemote && !workspace.isPersonal);
  const [connections, setConnections] = useState<TeamTicketConnection[]>([]);
  const [agents, setAgents] = useState<AgentCatalogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [connectionId, setConnectionId] = useState('');
  const [form, setForm] = useState<TeamTicketConnection | 'new' | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [query, setQuery] = useState('');
  const [searchedQuery, setSearchedQuery] = useState('');
  const [tickets, setTickets] = useState<TeamTicket[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [preview, setPreview] = useState<TeamTicketPreview | null>(null);
  const [selectedKey, setSelectedKey] = useState('');
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const [workspaceId, setWorkspaceId] = useState('');
  const [agent, setAgent] = useState<AgentId | ''>('');
  const [instruction, setInstruction] = useState('');
  const [useWorktree, setUseWorktree] = useState(true);
  const [launching, setLaunching] = useState(false);
  const [launchError, setLaunchError] = useState('');
  const [launched, setLaunched] = useState(false);
  const searchRequest = useRef(0);
  const previewRequest = useRef(0);
  const launchPending = useRef(false);
  const connection = connections.find(item => item.id === connectionId);
  const project = projects.find(item => item.id === workspaceId);
  const eligibleAgents = agents.filter(item => item.status === 'available' && item.launchable);
  const selectedAgent = eligibleAgents.find(item => item.id === agent);
  const canLaunch = !!preview && !!project && !!selectedAgent && !launching && !previewing;

  useEffect(() => {
    let active = true;
    void Promise.all([aceApi.teamTickets.listConnections(), aceApi.teamTickets.getLaunchAgents()]).then(([items, catalog]) => {
      if (!active) return;
      setConnections(items);
      setAgents(catalog);
      setConnectionId(items[0]?.id ?? '');
      setQuery(items[0]?.defaultQuery ?? '');
    }).catch(() => {
      if (active) setLoadError('Could not load ticket connections. Reopen Tickets to try again.');
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; searchRequest.current++; previewRequest.current++; };
  }, []);

  function selectConnection(item?: TeamTicketConnection) {
    searchRequest.current++;
    previewRequest.current++;
    setConnectionId(item?.id ?? '');
    setQuery(item?.defaultQuery ?? '');
    setTickets([]); setNextCursor(null); setSearched(false); setSearching(false); setSearchError('');
    setPreview(null); setSelectedKey(''); setPreviewing(false); setPreviewError('');
    setLaunchError(''); setLaunched(false); setConfirmDelete(false); setForm(null);
  }

  async function search(more = false) {
    if (!connection || launching) return;
    const request = ++searchRequest.current;
    const requestedQuery = more ? searchedQuery : query;
    if (!more) {
      previewRequest.current++;
      setPreview(null); setSelectedKey(''); setPreviewing(false); setPreviewError('');
      setTickets([]); setNextCursor(null); setSearched(false); setLaunchError(''); setLaunched(false);
    }
    setSearching(true); setSearchError('');
    try {
      const result = await aceApi.teamTickets.searchTickets({ connectionId: connection.id, query: requestedQuery, limit: 25, ...(more && nextCursor ? { cursor: nextCursor } : {}) });
      if (request !== searchRequest.current) return;
      setTickets(previous => more ? [...previous, ...result.tickets.filter(item => !previous.some(existing => existing.key === item.key))] : result.tickets);
      setNextCursor(result.nextCursor); setSearchedQuery(requestedQuery); setSearched(true);
    } catch {
      if (request === searchRequest.current) setSearchError('Could not load tickets. Check the connection credentials, board permissions, and search query.');
    } finally { if (request === searchRequest.current) setSearching(false); }
  }

  async function showTicket(ticket: Pick<TeamTicket, 'connectionId' | 'key'>) {
    if (launchPending.current) return;
    const request = ++previewRequest.current;
    setSelectedKey(ticket.key); setPreview(null); setPreviewing(true); setPreviewError(''); setLaunchError(''); setLaunched(false);
    try {
      const result = await aceApi.teamTickets.getTicket({ connectionId: ticket.connectionId, key: ticket.key });
      if (result.connectionId !== ticket.connectionId || result.key !== ticket.key) throw new Error('Ticket mismatch');
      if (request === previewRequest.current) setPreview(result);
    } catch {
      if (request === previewRequest.current) setPreviewError('Could not load this ticket. Refresh the preview or check your connection.');
    } finally { if (request === previewRequest.current) setPreviewing(false); }
  }

  async function removeConnection() {
    if (!connection || deleting || launching) return;
    setDeleting(true); setLoadError('');
    try {
      const result = await aceApi.teamTickets.deleteConnection(connection.id);
      if (!result.deleted) throw new Error('Connection not deleted');
      const remaining = connections.filter(item => item.id !== connection.id);
      setConnections(remaining); selectConnection(remaining[0]);
    } catch { setLoadError('Could not remove the connection. Try again.'); }
    finally { setDeleting(false); }
  }

  async function launch() {
    if (!canLaunch || !preview || !project || !selectedAgent || launchPending.current) return;
    launchPending.current = true;
    setLaunching(true); setLaunchError('');
    try {
      const result = await aceApi.teamTickets.launch({ ticket: preview, workspaceId: project.id, agent: selectedAgent.id, instruction: instruction.trim() || undefined, useWorktree: project.isInitialized !== false && useWorktree });
      setPreview(null); setLaunched(true);
      openTask(project.id, result.taskId);
      if (!result.promptDelivered) showToast('Task created. Complete agent setup, then send the saved ticket context from Task spec.');
    } catch {
      setLaunchError('Could not launch this ticket. Refresh the preview if it expired or the connection changed, and check that the project and agent are still available.');
    } finally { launchPending.current = false; setLaunching(false); }
  }

  return (
    <div className="mx-auto w-full max-w-7xl space-y-5 px-5 pb-8 sm:px-8">
      {loadError && <p role="alert" className="text-sm text-red-400">{loadError}</p>}
      <section className="rounded-xl border border-border bg-white/[0.02] p-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="min-w-52 flex-1 space-y-1.5 text-xs text-muted-foreground">Connection
            <select aria-label="Connection" className={fieldClass} value={connectionId} disabled={loading || launching || deleting} onChange={event => selectConnection(connections.find(item => item.id === event.target.value))}>
              {!connections.length && <option value="">{loading ? 'Loading connections…' : 'No connections yet'}</option>}
              {connections.map(item => <option key={item.id} value={item.id}>{item.name} · {kinds[item.kind]}</option>)}
            </select>
          </label>
          <Button variant="outline" disabled={loading || launching || deleting} onClick={() => { setForm('new'); setConfirmDelete(false); }}><Plus className="mr-2 h-4 w-4" /> Add connection</Button>
          {connection && <><Button variant="ghost" disabled={launching || deleting} onClick={() => { setForm(connection); setConfirmDelete(false); }}>Edit connection</Button><Button variant="ghost" disabled={launching || deleting} onClick={() => { setConfirmDelete(true); setForm(null); }}>Remove</Button></>}
        </div>
        {confirmDelete && connection && <div className="mt-4 flex flex-wrap items-center gap-3 text-sm"><span>Remove {connection.name} and its saved credential from this app?</span><Button variant="destructive" size="sm" disabled={deleting} onClick={() => void removeConnection()}>Remove connection</Button><Button variant="ghost" size="sm" disabled={deleting} onClick={() => setConfirmDelete(false)}>Cancel</Button></div>}
        {form && <ConnectionForm key={form === 'new' ? 'new' : form.id} connection={form === 'new' ? undefined : form} onCancel={() => setForm(null)} onSave={saved => { setConnections(previous => [...previous.filter(item => item.id !== saved.id), saved]); selectConnection(saved); setLoadError(''); }} />}
        {!loading && !connection && !form && <p className="mt-4 text-sm text-muted-foreground">Add your Jira site or a service implementing the JSON ticket API. Bring your own credentials; no Skysphere account is required.</p>}
      </section>
      {connection && <div className="grid min-h-[480px] gap-5 lg:grid-cols-[minmax(260px,0.85fr)_minmax(0,1.5fr)]">
        <section className="min-w-0 rounded-xl border border-border bg-white/[0.02] p-4">
          <form onSubmit={event => { event.preventDefault(); void search(); }} className="space-y-3">
            <label className="block space-y-1.5 text-xs text-muted-foreground">{connection.kind === 'json-board' ? 'Search tickets' : 'Jira query (JQL)'}
              <Input aria-label={connection.kind === 'json-board' ? 'Search tickets' : 'Jira query (JQL)'} value={query} disabled={launching} onChange={event => setQuery(event.target.value)} placeholder={connection.kind === 'json-board' ? 'Search your board…' : 'project = DEMO ORDER BY updated DESC'} />
            </label>
            <Button type="submit" variant="outline" size="sm" disabled={searching || launching}><Search className="mr-2 h-4 w-4" />{searching ? 'Searching…' : 'Search'}</Button>
          </form>
          {searchError && <p role="alert" className="mt-4 text-sm text-red-400">{searchError}</p>}
          <div className="mt-4 space-y-2" aria-label="Ticket results">
            {tickets.map(ticket => <button key={ticket.key} type="button" aria-pressed={selectedKey === ticket.key} disabled={launching} onClick={() => void showTicket(ticket)} className={`w-full rounded-lg border p-3 text-left transition-colors hover:bg-white/[0.05] disabled:opacity-50 ${selectedKey === ticket.key ? 'border-primary/60 bg-primary/5' : 'border-border bg-white/[0.02]'}`}><div className="mb-1 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground"><span>{ticket.key}</span><span>{ticket.status}</span></div><div className="text-sm font-medium">{ticket.title}</div>{ticket.assignee && <div className="mt-1 text-xs text-muted-foreground">{ticket.assignee}</div>}</button>)}
            {!searching && !tickets.length && <p className="py-8 text-center text-sm text-muted-foreground">{searched ? 'No tickets match this query.' : 'Search your board to choose a ticket.'}</p>}
          </div>
          {nextCursor && <Button className="mt-4" variant="outline" size="sm" disabled={searching || launching || query !== searchedQuery} onClick={() => void search(true)}>Load more</Button>}
        </section>
        <section className="min-w-0 rounded-xl border border-border bg-white/[0.02] p-5">
          <div className="mb-4 flex items-center justify-between gap-3"><h2 className="text-sm font-semibold">Review ticket context</h2>{selectedKey && <Button size="sm" variant="ghost" disabled={previewing || launching} onClick={() => void showTicket({ connectionId, key: selectedKey })}><RefreshCw className="mr-2 h-3.5 w-3.5" />Refresh preview</Button>}</div>
          {previewing && <div role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner size="sm" />Loading ticket…</div>}
          {previewError && <p role="alert" className="text-sm text-red-400">{previewError}</p>}
          {launched && <p role="status" className="text-sm text-muted-foreground">Task launched. Refresh the preview before starting another task from this ticket.</p>}
          {!preview && !previewing && !previewError && !launched && <div className="flex min-h-64 flex-col items-center justify-center gap-3 text-center text-muted-foreground"><Ticket className="h-8 w-8 opacity-50" /><p className="max-w-xs text-sm">Select a result to inspect its description before sending it to an agent.</p></div>}
          {preview && <>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"><span>{preview.key}</span><span>·</span><span>{preview.status || 'No status'}</span>{preview.assignee && <><span>·</span><span>{preview.assignee}</span></>}{preview.url && /^https?:\/\//i.test(preview.url) && <Button variant="link" size="sm" className="ml-auto h-auto p-0" onClick={() => void aceApi.workspaces.openExternal(preview.url!).catch(() => setPreviewError('Could not open the ticket link.'))}>Open ticket <ExternalLink className="ml-1 h-3 w-3" /></Button>}</div>
            <h3 className="mt-2 text-xl font-semibold leading-snug">{preview.title}</h3>
            {preview.labels.length > 0 && <div className="mt-3 flex flex-wrap gap-1.5">{preview.labels.map(label => <span key={label} className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">{label}</span>)}</div>}
            <div className="my-4 max-h-72 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-black/10 p-4 text-sm leading-relaxed">{preview.description || 'No description provided.'}</div>
            <div className="space-y-4 border-t border-border pt-4">
              <div className="flex items-center gap-2 text-sm font-semibold"><FolderGit2 className="h-4 w-4" /> Launch in a local project</div>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="space-y-1.5 text-xs text-muted-foreground">Project<select aria-label="Project" className={fieldClass} value={workspaceId} disabled={launching} onChange={event => { setWorkspaceId(event.target.value); setUseWorktree(true); }}><option value="">Choose a local project…</option>{projects.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
                <label className="space-y-1.5 text-xs text-muted-foreground">Agent<select aria-label="Agent" className={fieldClass} value={agent} disabled={launching} onChange={event => setAgent(event.target.value as AgentId | '')}><option value="">Choose an installed agent…</option>{eligibleAgents.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
              </div>
              {!projects.length && <p className="text-xs text-muted-foreground">Add a local project from Home first. Remote and personal workspaces are excluded.</p>}
              {!eligibleAgents.length && <p className="text-xs text-muted-foreground">Install and authenticate an eligible agent in Settings, then reopen Tickets. Profiles that always bypass permission prompts are excluded.</p>}
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!project && project.isInitialized !== false && useWorktree} disabled={!project || project.isInitialized === false || launching} onChange={event => setUseWorktree(event.target.checked)} />Use an isolated Git worktree</label>
              {project?.isInitialized === false && <p className="text-xs text-muted-foreground">This project has no initialized Git repository. The task will use the project directory.</p>}
              <label className="block space-y-1.5 text-xs text-muted-foreground">Your instruction (optional)<textarea aria-label="Your instruction (optional)" className={`${fieldClass} min-h-20 resize-y`} maxLength={8000} value={instruction} disabled={launching} onChange={event => setInstruction(event.target.value)} placeholder="For example: implement the acceptance criteria and run focused tests." /></label>
              <p className="text-xs leading-relaxed text-muted-foreground">The reviewed title, description, and ticket metadata will be sent to your chosen agent and may reach its model provider. Treat ticket text as untrusted context. ACE does not enable permission bypass for this task; your provider’s configuration still applies.</p>
              <Button variant="accent" disabled={!canLaunch} onClick={() => void launch()}>{launching ? 'Launching…' : 'Launch task from ticket'}</Button>
            </div>
          </>}
          {launchError && <p role="alert" className="mt-4 text-sm text-red-400">{launchError}</p>}
        </section>
      </div>}
    </div>
  );
}

function ConnectionForm({ connection, onSave, onCancel }: { connection?: TeamTicketConnection; onSave: (connection: TeamTicketConnection) => void; onCancel: () => void }) {
  const [name, setName] = useState(connection?.name ?? '');
  const [kind, setKind] = useState<TeamTicketConnectionInput['kind']>(connection?.kind ?? 'jira-cloud');
  const [baseUrl, setBaseUrl] = useState(connection?.baseUrl ?? '');
  const [email, setEmail] = useState(connection?.email ?? '');
  const [cloudId, setCloudId] = useState(connection?.cloudId ?? '');
  const [defaultQuery, setDefaultQuery] = useState(connection?.defaultQuery ?? '');
  const [token, setToken] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);
  const unchangedDestination = connection?.kind === kind && connection?.baseUrl === baseUrl.trim() && (connection?.email ?? '') === (kind === 'jira-cloud' ? email.trim() : '') && (connection?.cloudId ?? '') === (kind === 'jira-cloud' ? cloudId.trim() : '');
  const needsToken = kind !== 'json-board' && !(connection?.hasToken && unchangedDestination);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending.current) return;
    pending.current = true; setSaving(true); setError('');
    try {
      const saved = await aceApi.teamTickets.saveConnection({ id: connection?.id, name: name.trim(), kind, baseUrl: baseUrl.trim(), ...(kind === 'jira-cloud' ? { email: email.trim(), cloudId: cloudId.trim() } : {}), defaultQuery: defaultQuery.trim(), ...(token ? { token } : {}) });
      setToken(''); onSave(saved);
    } catch { setError('Could not save the connection. Check the URL and credentials. Changing the destination requires its token again; secure credential storage must be available on this computer.'); }
    finally { pending.current = false; setSaving(false); }
  }

  return <form onSubmit={event => void submit(event)} className="mt-5 space-y-4 border-t border-border pt-5" aria-label={connection ? 'Edit ticket connection' : 'Add ticket connection'}>
    <div className="flex items-center justify-between"><h2 className="text-sm font-semibold">{connection ? 'Edit connection' : 'Connect your ticket board'}</h2><Button type="button" variant="ghost" size="icon-sm" disabled={saving} aria-label="Close connection form" onClick={onCancel}><X className="h-4 w-4" /></Button></div>
    <fieldset disabled={saving} className="grid gap-4 sm:grid-cols-2">
      <label className="space-y-1.5 text-xs text-muted-foreground">Connection name<Input aria-label="Connection name" required maxLength={100} value={name} onChange={event => setName(event.target.value)} placeholder="Engineering board" /></label>
      <label className="space-y-1.5 text-xs text-muted-foreground">Service<select aria-label="Service" className={fieldClass} value={kind} onChange={event => { setKind(event.target.value as TeamTicketConnectionInput['kind']); setToken(''); }}>{Object.entries(kinds).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label className="space-y-1.5 text-xs text-muted-foreground sm:col-span-2">{kind === 'json-board' ? 'API base URL' : 'Jira site URL'}<Input aria-label="Base URL" type="url" required value={baseUrl} onChange={event => setBaseUrl(event.target.value)} placeholder={kind === 'json-board' ? 'https://tickets.example.com/api' : 'https://your-team.atlassian.net'} /><span className="block">HTTPS required. HTTP is supported only for a literal loopback address.</span></label>
      {kind === 'jira-cloud' && <><label className="space-y-1.5 text-xs text-muted-foreground">Atlassian email<Input aria-label="Atlassian email" type="email" required value={email} onChange={event => setEmail(event.target.value)} autoComplete="off" /></label><label className="space-y-1.5 text-xs text-muted-foreground">Cloud ID (for scoped API tokens)<Input aria-label="Cloud ID (for scoped API tokens)" value={cloudId} onChange={event => setCloudId(event.target.value)} placeholder="Optional for unscoped tokens" /></label></>}
      <label className="space-y-1.5 text-xs text-muted-foreground sm:col-span-2">{kind === 'jira-cloud' ? 'API token' : kind === 'jira-datacenter' ? 'Personal access token' : 'Bearer token (optional)'}<Input aria-label="Connection token" type="password" required={needsToken} value={token} onChange={event => setToken(event.target.value)} autoComplete="new-password" spellCheck={false} placeholder={connection?.hasToken && unchangedDestination ? 'Saved securely · leave blank to keep' : 'Enter your own token'} /><span className="block">Stored with the operating system’s secure storage. Saved tokens are never displayed or included in agent instructions.</span></label>
      <label className="space-y-1.5 text-xs text-muted-foreground sm:col-span-2">Default {kind === 'json-board' ? 'search' : 'JQL'} (optional)<Input aria-label="Default query" value={defaultQuery} onChange={event => setDefaultQuery(event.target.value)} placeholder={kind === 'json-board' ? 'My team’s queue' : 'assignee = currentUser() ORDER BY updated DESC'} /></label>
    </fieldset>
    <p className="text-xs leading-relaxed text-muted-foreground">Saving stores this connection locally. Use Search to test access. Choose credentials with only the ticket access you need.</p>
    {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
    <div className="flex gap-2"><Button variant="outline" type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save connection'}</Button><Button variant="ghost" type="button" disabled={saving} onClick={onCancel}>Cancel</Button></div>
  </form>;
}
