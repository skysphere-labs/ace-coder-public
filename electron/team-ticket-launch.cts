// Ticket intake is an explicit desktop action. Remote data never selects an
// executable, working directory, permission mode, or repository to clone.
const { randomBytes } = require('node:crypto');
const { getProvider } = require('./agent-providers.cts');
const { buildTicketPrompt } = require('./team-tickets.cts');

const PREVIEW_TTL_MS = 10 * 60 * 1000;
const EXTERNAL_TICKET_MARKER = '<!-- ace:external-ticket:v1 -->\n';

function ticketSnapshot(ticket: any) {
  return JSON.stringify([
    ticket?.connectionId, ticket?.id, ticket?.key, ticket?.title,
    ticket?.description, ticket?.status, ticket?.assignee,
    ticket?.labels, ticket?.url, ticket?.updatedAt,
  ]);
}

function isTrustedTicketSender(event: any, expectedUrl: string) {
  try {
    if (event?.sender?.getType?.() !== 'window') return false;
    if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) return false;
    const current = new URL(event.senderFrame.url);
    const expected = new URL(expectedUrl);
    // Hash navigation is internal; an arbitrary same-origin document is not.
    return current.protocol === expected.protocol && current.host === expected.host &&
      current.pathname === expected.pathname && current.search === expected.search;
  } catch { return false; }
}

function createTeamTicketHandlers({ service, store, now = Date.now }: any) {
  const previews = new Map<string, { ticket: any; snapshot: string; expiresAt: number }>();
  let connectionGeneration = 0;

  function prune() {
    for (const [token, entry] of previews) if (entry.expiresAt <= now()) previews.delete(token);
    while (previews.size >= 100) previews.delete(previews.keys().next().value!);
  }
  function clearPreviews() { connectionGeneration += 1; previews.clear(); }

  async function getLaunchAgents() {
    const catalog = await store.getAgentCatalog();
    return catalog.filter((entry: any) => {
      const provider = getProvider(entry.id);
      return entry.status === 'available' && entry.launchable && provider?.cli && !provider.alwaysAutoApprove;
    });
  }

  async function getTicket(input: any) {
    const generation = connectionGeneration;
    const ticket = await service.getTicket(input);
    if (generation !== connectionGeneration) throw new Error('The connection changed. Refresh the ticket preview.');
    // Validate before exposing the preview, and retain exactly what was shown.
    buildTicketPrompt({ ticket });
    prune();
    const previewToken = randomBytes(24).toString('hex');
    previews.set(previewToken, { ticket: structuredClone(ticket), snapshot: ticketSnapshot(ticket), expiresAt: now() + PREVIEW_TTL_MS });
    return { ...ticket, previewToken };
  }

  async function launch(input: any) {
    const previewToken = input?.ticket?.previewToken;
    const preview = typeof previewToken === 'string' ? previews.get(previewToken) : null;
    if (!preview || preview.expiresAt <= now() || preview.snapshot !== ticketSnapshot(input?.ticket)) {
      throw new Error('Refresh the ticket preview before launching. It has expired, changed, or already been used.');
    }
    if (typeof input.workspaceId !== 'string' || typeof input.agent !== 'string' || typeof input.useWorktree !== 'boolean') {
      throw new Error('Choose a local project, installed agent, and launch mode.');
    }
    if (!service.listConnections().some((connection: any) => connection.id === preview.ticket.connectionId)) {
      throw new Error('This connection was removed. Connect it again and refresh the ticket.');
    }
    const state = await store.getState({ allowCache: false });
    const workspace = state.workspaces.find((entry: any) => entry.id === input.workspaceId);
    if (!workspace || workspace.isRemote || workspace.isPersonal) throw new Error('Choose an existing local project.');
    if (input.useWorktree && workspace.isInitialized !== true) {
      throw new Error('Initialize the project as a Git repository or turn off the worktree option.');
    }
    const agents = await getLaunchAgents();
    if (!agents.some((entry: any) => entry.id === input.agent)) {
      throw new Error('Choose an installed CLI agent whose profile does not force permission bypass.');
    }
    const prompt = EXTERNAL_TICKET_MARKER + buildTicketPrompt({ ticket: preview.ticket, instruction: input.instruction });
    const name = `${preview.ticket.key}: ${preview.ticket.title}`.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 160);
    // Consume immediately before the first side effect; even concurrent clicks
    // cannot create two paid sessions. Refresh is required after a launch error.
    if (previews.get(previewToken) !== preview) throw new Error('Refresh the ticket preview before launching again.');
    previews.delete(previewToken);
    const options = {
      name, agent: input.agent, prompt, autoApproveEnabled: false,
      useWorktree: input.useWorktree, kind: 'cli', taskType: 'team-ticket',
      // Only selects createTask's awaited worktree preparation path. This is
      // not createDelegatedTask, which would enable approval bypass.
      delegated: true,
    };
    const result = input.useWorktree
      ? await store.createTask({ workspaceId: workspace.id, input: options })
      : await store.createThread({ workspaceId: workspace.id, input: options });
    // Persisting initial_prompt does not itself deliver it. Start the known
    // CLI and wait for its input-ready state before submitting any ticket text.
    // Login/trust/setup prompts remain for the user; never type into a shell.
    try {
      let streamId: string;
      if (input.useWorktree) {
        const current = await store.getState({ allowCache: false });
        const task = current.workspaces.find((entry: any) => entry.id === workspace.id)?.tasks?.find((entry: any) => entry.id === result.id);
        const variantId = task?.worktrees?.[0]?.variants?.[0]?.id;
        if (!variantId) throw new Error('Task variant unavailable');
        streamId = `variant:${variantId}`;
      } else {
        if (!result.conversationId) throw new Error('CLI conversation unavailable');
        streamId = `conversation:${result.conversationId}`;
      }
      const started = await store.ensureStreamStarted({ streamId, cols: 120, rows: 40 });
      if (!started || started.ok === false) throw new Error('CLI did not start');
      await store.streamWaitFor({ streamId, predicate: { awaitingInput: true }, timeoutMs: 15000 });
      const sent = await store.streamSendSubmit({ streamId, text: prompt });
      if (!sent || sent.ok !== true) throw new Error('Ticket context was not sent');
      return { taskId: result.id, promptDelivered: true };
    } catch {
      // A real task already exists. Never report a creation failure that could
      // encourage duplicate work; the saved spec remains available to the user.
      return { taskId: result.id, promptDelivered: false };
    }
  }

  return {
    listConnections: () => service.listConnections(),
    saveConnection: (input: any) => { clearPreviews(); return service.saveConnection(input); },
    deleteConnection: (id: string) => { clearPreviews(); return service.deleteConnection(id); },
    searchTickets: (input: any) => service.searchTickets(input),
    getTicket, getLaunchAgents, launch,
  };
}

module.exports = { createTeamTicketHandlers, isTrustedTicketSender, EXTERNAL_TICKET_MARKER, PREVIEW_TTL_MS };
