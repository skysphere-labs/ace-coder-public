// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  remote: false,
  listConnections: vi.fn(), getLaunchAgents: vi.fn(), saveConnection: vi.fn(), deleteConnection: vi.fn(),
  searchTickets: vi.fn(), getTicket: vi.fn(), launch: vi.fn(), openTask: vi.fn(), openExternal: vi.fn(), showToast: vi.fn(),
}));
vi.mock('../lib/ace-api', () => ({
  isRemoteClient: () => mocks.remote,
  aceApi: { teamTickets: mocks, workspaces: { openExternal: mocks.openExternal } },
}));
vi.mock('../store', () => ({ useApp: () => ({ openTask: mocks.openTask }) }));
vi.mock('../runtime/undo-registry', () => ({ showToast: mocks.showToast }));
vi.mock('../runtime/workspace-registry', () => ({
  useWorkspaceCatalog: () => [
    { id: 'local', name: 'Local project', isRemote: false, isInitialized: true },
    { id: 'plain', name: 'Plain folder', isRemote: false, isInitialized: false },
    { id: 'remote', name: 'Remote project', isRemote: true, isInitialized: true },
    { id: 'personal', name: 'Personal workspace', isRemote: false, isPersonal: true },
  ],
}));
import { TeamTicketsScreen } from './TeamTicketsScreen';

const connection = { id: 'board', name: 'Engineering', kind: 'jira-cloud', baseUrl: 'https://example.atlassian.net', email: 'demo@example.com', cloudId: null, defaultQuery: 'project = DEMO', hasToken: true };
const ticket = { connectionId: 'board', id: '1', key: 'DEMO-1', title: 'Accessible search', description: 'Use keyboard navigation. <img src=x onerror=alert(1)>', status: 'To do', assignee: null, labels: ['accessibility'], url: 'https://example.atlassian.net/browse/DEMO-1', updatedAt: null };
const preview = { ...ticket, previewToken: 'one-use-fixture-preview' };
const roots: Root[] = [];

async function renderScreen() {
  const container = document.createElement('div'); document.body.appendChild(container);
  const root = createRoot(container); roots.push(root);
  await act(async () => { root.render(<TeamTicketsScreen />); });
  return container;
}
function button(container: HTMLElement, text: string) {
  const result = Array.from(container.querySelectorAll('button')).find(item => item.textContent?.trim() === text);
  if (!result) throw new Error(`Missing button: ${text}`);
  return result;
}
async function click(container: HTMLElement, text: string) {
  await act(async () => { button(container, text).click(); });
}
async function change(container: HTMLElement, label: string, value: string) {
  const field = container.querySelector(`[aria-label="${label}"]`) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
  if (!field) throw new Error(`Missing field: ${label}`);
  await act(async () => {
    const prototype = field instanceof HTMLSelectElement ? HTMLSelectElement.prototype : field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(field, value);
    field.dispatchEvent(new Event(field instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
}
async function review(container: HTMLElement) {
  await click(container, 'Search');
  const result = container.querySelector('[aria-label="Ticket results"] button') as HTMLButtonElement;
  await act(async () => { result.click(); });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}

beforeEach(() => {
  document.body.innerHTML = ''; mocks.remote = false;
  Object.values(mocks).forEach(mock => { if (typeof mock === 'function') mock.mockReset(); });
  mocks.listConnections.mockResolvedValue([connection]);
  mocks.getLaunchAgents.mockResolvedValue([
    { id: 'codex', name: 'Codex', status: 'available', launchable: true },
    { id: 'claude', name: 'Claude', status: 'missing', launchable: false },
  ]);
  mocks.searchTickets.mockResolvedValue({ tickets: [ticket], nextCursor: null });
  mocks.getTicket.mockResolvedValue(preview);
  mocks.launch.mockResolvedValue({ taskId: 'created-task', promptDelivered: true });
  mocks.deleteConnection.mockResolvedValue({ deleted: true });
  mocks.openExternal.mockResolvedValue({ ok: true });
});
afterEach(() => { for (const root of roots.splice(0)) act(() => root.unmount()); });

describe('desktop ticket intake', () => {
  it('does not read connection or agent data from a paired browser', async () => {
    mocks.remote = true;
    const container = await renderScreen();
    expect(container.textContent).toContain('Open Tickets in the desktop app');
    expect(mocks.listConnections).not.toHaveBeenCalled();
    expect(mocks.getLaunchAgents).not.toHaveBeenCalled();
  });

  it('requires review and explicit local project and installed agent choices before launching', async () => {
    const container = await renderScreen();
    expect(mocks.searchTickets).not.toHaveBeenCalled();
    await review(container);
    expect(mocks.launch).not.toHaveBeenCalled();
    expect(button(container, 'Launch task from ticket').disabled).toBe(true);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(container.querySelector('[aria-label="Project"]')?.textContent).not.toMatch(/Remote project|Personal workspace/);
    expect(container.querySelector('[aria-label="Agent"]')?.textContent).not.toContain('Claude');
    await change(container, 'Project', 'local');
    expect(button(container, 'Launch task from ticket').disabled).toBe(true);
    await change(container, 'Agent', 'codex');
    await change(container, 'Your instruction (optional)', '  Run the accessibility checks.  ');
    await click(container, 'Launch task from ticket');
    expect(mocks.launch).toHaveBeenCalledExactlyOnceWith({ ticket: preview, workspaceId: 'local', agent: 'codex', instruction: 'Run the accessibility checks.', useWorktree: true });
    expect(mocks.openTask).toHaveBeenCalledWith('local', 'created-task');
    expect(container.textContent).not.toContain('one-use-fixture-preview');
    expect(container.textContent).toContain('Task launched.');
    expect(mocks.showToast).not.toHaveBeenCalled();
  });

  it('opens a created task and explains when agent setup prevented context delivery', async () => {
    mocks.launch.mockResolvedValue({ taskId: 'setup-task', promptDelivered: false });
    const container = await renderScreen(); await review(container);
    await change(container, 'Project', 'local'); await change(container, 'Agent', 'codex');
    await click(container, 'Launch task from ticket');
    expect(mocks.openTask).toHaveBeenCalledExactlyOnceWith('local', 'setup-task');
    expect(mocks.showToast).toHaveBeenCalledExactlyOnceWith('Task created. Complete agent setup, then send the saved ticket context from Task spec.');
  });

  it('uses the project folder when its Git repository is not initialized', async () => {
    const container = await renderScreen(); await review(container);
    await change(container, 'Project', 'plain'); await change(container, 'Agent', 'codex');
    const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(checkbox.disabled).toBe(true); expect(checkbox.checked).toBe(false);
    await click(container, 'Launch task from ticket');
    expect(mocks.launch.mock.calls[0][0].useWorktree).toBe(false);
  });

  it('ignores an older preview that resolves after the newly selected ticket', async () => {
    const other = { ...ticket, id: '2', key: 'DEMO-2', title: 'Newest selection' };
    const first = deferred<typeof preview>();
    mocks.searchTickets.mockResolvedValue({ tickets: [ticket, other], nextCursor: null });
    mocks.getTicket.mockImplementation(({ key }: { key: string }) => key === ticket.key ? first.promise : Promise.resolve({ ...other, previewToken: 'second' }));
    const container = await renderScreen(); await click(container, 'Search');
    const results = container.querySelectorAll('[aria-label="Ticket results"] button');
    await act(async () => { (results[0] as HTMLButtonElement).click(); });
    await act(async () => { (results[1] as HTMLButtonElement).click(); });
    await act(async () => { first.resolve(preview); });
    expect(container.querySelector('h3')?.textContent).toBe('Newest selection');
    await change(container, 'Project', 'local'); await change(container, 'Agent', 'codex');
    await click(container, 'Launch task from ticket');
    expect(mocks.launch.mock.calls[0][0].ticket.key).toBe('DEMO-2');
  });

  it('retains saved credentials on a blank edit without exposing them', async () => {
    mocks.saveConnection.mockResolvedValue({ ...connection, name: 'Renamed board' });
    const container = await renderScreen(); await click(container, 'Edit connection');
    const secret = container.querySelector('[aria-label="Connection token"]') as HTMLInputElement;
    expect(secret.type).toBe('password'); expect(secret.value).toBe(''); expect(secret.required).toBe(false);
    await change(container, 'Connection name', 'Renamed board');
    await click(container, 'Save connection');
    expect(mocks.saveConnection.mock.calls[0][0]).not.toHaveProperty('token');
    expect(mocks.saveConnection.mock.calls[0][0].id).toBe('board');
    expect(container.querySelector('[aria-label="Connection token"]')).toBeNull();
  });

  it('requires a fresh Jira token when editing its destination', async () => {
    const container = await renderScreen(); await click(container, 'Edit connection');
    await change(container, 'Base URL', 'https://other.atlassian.net');
    expect((container.querySelector('[aria-label="Connection token"]') as HTMLInputElement).required).toBe(true);
  });

  it('refreshes an expired preview and never displays raw launch error details', async () => {
    mocks.launch.mockRejectedValueOnce(new Error('SENSITIVE internal response')).mockResolvedValueOnce({ taskId: 'fresh-task' });
    const container = await renderScreen(); await review(container);
    await change(container, 'Project', 'local'); await change(container, 'Agent', 'codex');
    await click(container, 'Launch task from ticket');
    expect(container.textContent).toContain('Refresh the preview');
    expect(container.textContent).not.toContain('SENSITIVE');
    mocks.getTicket.mockResolvedValue({ ...preview, previewToken: 'fresh-preview' });
    await click(container, 'Refresh preview'); await click(container, 'Launch task from ticket');
    expect(mocks.launch.mock.calls[1][0].ticket.previewToken).toBe('fresh-preview');
    expect(mocks.openTask).toHaveBeenCalledExactlyOnceWith('local', 'fresh-task');
  });

  it('does not combine pagination from different queries', async () => {
    mocks.searchTickets.mockResolvedValue({ tickets: [ticket], nextCursor: 'page-two' });
    const container = await renderScreen(); await click(container, 'Search');
    await change(container, 'Jira query (JQL)', 'project = OTHER');
    expect(button(container, 'Load more').disabled).toBe(true);
    await change(container, 'Jira query (JQL)', connection.defaultQuery); await click(container, 'Load more');
    expect(mocks.searchTickets.mock.calls[1][0]).toEqual({ connectionId: 'board', query: connection.defaultQuery, cursor: 'page-two', limit: 25 });
    expect(container.querySelectorAll('[aria-label="Ticket results"] button')).toHaveLength(1);
  });

  it('removes a connection only after confirmation and clears the preview', async () => {
    const container = await renderScreen(); await review(container); await click(container, 'Remove');
    expect(mocks.deleteConnection).not.toHaveBeenCalled();
    await click(container, 'Remove connection');
    expect(mocks.deleteConnection).toHaveBeenCalledExactlyOnceWith('board');
    expect(container.querySelector('h3')).toBeNull();
    expect(container.textContent).toContain('No connections yet');
  });
});
