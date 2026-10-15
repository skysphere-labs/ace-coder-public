import { describe, expect, it, vi } from 'vitest';
const { createTeamTicketHandlers, isTrustedTicketSender, PREVIEW_TTL_MS, EXTERNAL_TICKET_MARKER } = require('../team-ticket-launch.cts');

function fixture() {
  let clock = 1000;
  const ticket = {
    connectionId: 'team-demo', id: '1', key: 'DEMO-1', title: 'Improve queue filters',
    description: 'Acceptance: filters remain selected after refresh.', status: 'Ready',
    assignee: 'Demo engineer', labels: ['ui'], url: 'https://example.atlassian.net/browse/DEMO-1', updatedAt: null,
  };
  const service = {
    listConnections: vi.fn(() => [{ id: 'team-demo' }]),
    saveConnection: vi.fn((input) => input), deleteConnection: vi.fn(() => ({ deleted: true })),
    getTicket: vi.fn(async () => ({ ...ticket })), searchTickets: vi.fn(async () => ({ tickets: [ticket], nextCursor: null })),
  };
  const state = { workspaces: [{ id: 'project-demo', isRemote: false, isPersonal: false, isInitialized: true,
    tasks: [{ id: 'task-demo', worktrees: [{ variants: [{ id: 'variant-demo' }] }] }],
  }] };
  const store = {
    getState: vi.fn(() => state),
    getAgentCatalog: vi.fn(async () => [
      { id: 'codex', status: 'available', launchable: true },
      { id: 'claude', status: 'missing', launchable: false },
      { id: 'hermes', status: 'available', launchable: true },
      { id: 'invented-command', status: 'available', launchable: true },
    ]),
    createTask: vi.fn(async () => ({ id: 'task-demo' })),
    createThread: vi.fn(async () => ({ id: 'thread-demo', conversationId: 'conversation-demo' })),
    ensureStreamStarted: vi.fn(async () => ({ ok: true })),
    streamWaitFor: vi.fn(async () => ({ state: 'awaiting-input' })),
    streamSendSubmit: vi.fn(async () => ({ ok: true })),
  };
  const handlers = createTeamTicketHandlers({ service, store, now: () => clock });
  const preview = () => handlers.getTicket({ connectionId: ticket.connectionId, key: ticket.key });
  const input = async (extra = {}) => ({ ticket: await preview(), workspaceId: 'project-demo', agent: 'codex', useWorktree: true, ...extra });
  return { handlers, ticket, service, store, state, input, preview, advance: () => { clock += PREVIEW_TTL_MS + 1; } };
}

describe('ticket-to-CLI launch boundary', () => {
  it('browsing and previewing never creates a task or launches an agent', async () => {
    const f = fixture();
    await f.handlers.listConnections();
    await f.handlers.searchTickets({ connectionId: 'team-demo' });
    await f.preview();
    expect(f.store.createTask).not.toHaveBeenCalled();
    expect(f.store.createThread).not.toHaveBeenCalled();
    expect(await f.handlers.getLaunchAgents()).toEqual([{ id: 'codex', status: 'available', launchable: true }]);
  });

  it('creates a chosen local worktree task with the exact reviewed snapshot and approvals retained', async () => {
    const f = fixture();
    const input = await f.input({ instruction: 'Implement and run the focused checks.' });
    f.service.getTicket.mockImplementation(async () => { throw new Error('Should not refetch on launch'); });
    expect(await f.handlers.launch(input)).toEqual({ taskId: 'task-demo', promptDelivered: true });
    const payload = f.store.createTask.mock.calls[0][0];
    expect(payload).toMatchObject({ workspaceId: 'project-demo', input: { agent: 'codex', autoApproveEnabled: false, useWorktree: true, taskType: 'team-ticket' } });
    expect(payload.input.prompt.startsWith(EXTERNAL_TICKET_MARKER)).toBe(true);
    expect(payload.input.prompt).toContain(f.ticket.description);
    expect(payload.input.prompt).toContain('Implement and run the focused checks.');
    expect(payload.input).not.toHaveProperty('command');
    expect(payload.input).not.toHaveProperty('baseBranch');
    expect(payload.input.delegated).toBe(true);
    expect(f.store.ensureStreamStarted).toHaveBeenCalledWith({ streamId: 'variant:variant-demo', cols: 120, rows: 40 });
    expect(f.store.streamWaitFor).toHaveBeenCalledWith({ streamId: 'variant:variant-demo', predicate: { awaitingInput: true }, timeoutMs: 15000 });
    expect(f.store.streamSendSubmit).toHaveBeenCalledWith({ streamId: 'variant:variant-demo', text: payload.input.prompt });
    expect(f.store.streamWaitFor.mock.invocationCallOrder[0]).toBeLessThan(f.store.streamSendSubmit.mock.invocationCallOrder[0]);
    expect(f.store.createThread).not.toHaveBeenCalled();
  });

  it('opens a CLI thread in the selected project when worktree is off', async () => {
    const f = fixture();
    f.state.workspaces[0].isInitialized = false;
    expect(await f.handlers.launch(await f.input({ useWorktree: false }))).toEqual({ taskId: 'thread-demo', promptDelivered: true });
    expect(f.store.createThread.mock.calls[0][0].input.kind).toBe('cli');
    expect(f.store.createTask).not.toHaveBeenCalled();
    expect(f.store.ensureStreamStarted.mock.calls[0][0].streamId).toBe('conversation:conversation-demo');
  });

  it('retains the created task without sending context when CLI startup fails', async () => {
    const f = fixture();
    f.store.ensureStreamStarted.mockResolvedValue({ ok: false });
    expect(await f.handlers.launch(await f.input())).toEqual({ taskId: 'task-demo', promptDelivered: false });
    expect(f.store.streamWaitFor).not.toHaveBeenCalled();
    expect(f.store.streamSendSubmit).not.toHaveBeenCalled();
  });

  it('never types through a trust/login prompt or retries uncertain delivery', async () => {
    const f = fixture();
    f.store.streamWaitFor.mockRejectedValue(new Error('not ready'));
    expect(await f.handlers.launch(await f.input())).toEqual({ taskId: 'task-demo', promptDelivered: false });
    expect(f.store.streamSendSubmit).not.toHaveBeenCalled();
    f.store.streamWaitFor.mockResolvedValue({ state: 'awaiting-input' });
    f.store.streamSendSubmit.mockResolvedValue({ ok: false });
    expect(await f.handlers.launch(await f.input())).toEqual({ taskId: 'task-demo', promptDelivered: false });
    expect(f.store.streamSendSubmit).toHaveBeenCalledTimes(1);
  });

  it('rejects unreviewed, expired, changed, and replayed previews', async () => {
    const f = fixture();
    await expect(f.handlers.launch({ ticket: f.ticket })).rejects.toThrow(/preview/);
    const changed = await f.input();
    changed.ticket.description = 'Changed after review';
    await expect(f.handlers.launch(changed)).rejects.toThrow(/preview/);
    const expired = await f.input();
    f.advance();
    await expect(f.handlers.launch(expired)).rejects.toThrow(/preview/);
    const valid = await f.input();
    await f.handlers.launch(valid);
    await expect(f.handlers.launch(valid)).rejects.toThrow(/preview/);
    expect(f.store.createTask).toHaveBeenCalledTimes(1);
  });

  it('two concurrent launch clicks produce only one task', async () => {
    const f = fixture();
    const input = await f.input();
    const results = await Promise.allSettled([f.handlers.launch(input), f.handlers.launch(input)]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(f.store.createTask).toHaveBeenCalledTimes(1);
  });

  it('connection edits and deletion invalidate outstanding previews', async () => {
    for (const action of ['saveConnection', 'deleteConnection']) {
      const f = fixture();
      const input = await f.input();
      await f.handlers[action]('team-demo');
      await expect(f.handlers.launch(input)).rejects.toThrow(/preview/);
      expect(f.store.createTask).not.toHaveBeenCalled();
    }
  });

  it('a response arriving after disconnect cannot mint a usable preview', async () => {
    const f = fixture();
    let finish;
    f.service.getTicket.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const pending = f.preview();
    f.handlers.deleteConnection('team-demo');
    finish(f.ticket);
    await expect(pending).rejects.toThrow(/connection changed/);
  });

  it.each([
    ['workspaceId', 'unknown'], ['agent', 'missing'], ['agent', 'hermes'], ['agent', 'invented-command'],
    ['agent', 'codex; echo bad'], ['useWorktree', 'false'],
  ])('rejects invalid launch choice %s=%s', async (field, value) => {
    const f = fixture();
    await expect(f.handlers.launch(await f.input({ [field]: value }))).rejects.toThrow();
    expect(f.store.createTask).not.toHaveBeenCalled();
    expect(f.store.createThread).not.toHaveBeenCalled();
  });

  it.each(['isRemote', 'isPersonal'])('refuses %s projects', async (field) => {
    const f = fixture();
    f.state.workspaces[0][field] = true;
    await expect(f.handlers.launch(await f.input())).rejects.toThrow(/local project/);
    expect(f.store.createTask).not.toHaveBeenCalled();
  });

  it('requires Git initialization for worktree launch and refuses removed connections', async () => {
    const f = fixture();
    f.state.workspaces[0].isInitialized = false;
    await expect(f.handlers.launch(await f.input())).rejects.toThrow(/Git repository/);
    f.service.listConnections.mockReturnValue([]);
    await expect(f.handlers.launch(await f.input({ useWorktree: false }))).rejects.toThrow(/connection was removed/);
    expect(f.store.createTask).not.toHaveBeenCalled();
  });
});

describe('desktop ticket sender check', () => {
  const expected = 'file:///C:/app/dist/index.html';
  function event(url = expected, type = 'window') {
    const frame = { url };
    return { senderFrame: frame, sender: { mainFrame: frame, getType: () => type } };
  }
  it('accepts only the local main renderer document', () => {
    expect(isTrustedTicketSender(event(), expected)).toBe(true);
    expect(isTrustedTicketSender(event(expected + '#tickets'), expected)).toBe(true);
    expect(isTrustedTicketSender(event('https://board.example.test/'), expected)).toBe(false);
    expect(isTrustedTicketSender(event('file:///C:/app/dist/showcase.html'), expected)).toBe(false);
    expect(isTrustedTicketSender(event(expected, 'webview'), expected)).toBe(false);
    const child = event(); child.senderFrame = { url: expected };
    expect(isTrustedTicketSender(child, expected)).toBe(false);
    expect(isTrustedTicketSender({}, expected)).toBe(false);
    expect(isTrustedTicketSender(event('http://localhost:5173/'), 'http://localhost:5173')).toBe(true);
    expect(isTrustedTicketSender(event('http://localhost:5173/other'), 'http://localhost:5173')).toBe(false);
  });
});
