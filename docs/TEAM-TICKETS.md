# Jira and in-house team tickets

The desktop **Tickets** screen connects your own Jira site or JSON ticket
service to a local coding task. Search, open a ticket, review its context, then
choose a project and an installed agent. The connector reads tickets; it does
not post comments, transition issues, or change assignments in the source board.

## Connect Jira Cloud

1. Choose **Tickets → Add connection → Jira Cloud**.
2. Enter a name, your Jira site URL, and the Atlassian email that owns the token.
3. Create an API token in your own Atlassian account and paste it into the token
   field. Use the ticket read access your organization permits. Follow
   [Atlassian's token setup instructions](https://support.atlassian.com/atlassian-account/docs/manage-api-tokens-for-your-atlassian-account/).
4. For a scoped API token, also enter the site's **Cloud ID**. The connector
   routes API calls through `https://api.atlassian.com/ex/jira/{cloudId}` while
   keeping ticket browser links on your site. An unscoped token uses the site
   URL directly. See the same [Atlassian token guide](https://support.atlassian.com/atlassian-account/docs/manage-api-tokens-for-your-atlassian-account/)
   for Cloud ID and scoped-token routing.
5. Optionally save a default JQL query, then save and use **Search** to test it.

For example:

```jql
project = DEMO AND statusCategory != Done ORDER BY updated DESC
```

Search uses Jira Cloud's `GET /rest/api/3/search/jql`; the preview uses
`GET /rest/api/3/issue/{key}`. Your Jira permissions and token scopes must allow
both operations. Check the current [issue-search reference](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/)
and [issue reference](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/)
for required access. An empty result does not prove that the account can see
every issue in a project.

This is a bring-your-own-token connector for personal or internal use, not an
Atlassian Marketplace app or an assertion of Atlassian compliance. Atlassian's
[Cloud authentication guidance](https://developer.atlassian.com/cloud/jira/platform/basic-auth-for-rest-apis/)
directs distributed apps away from collecting customer API tokens and toward
a single OAuth 2.0 (3LO) integration. Review those requirements before offering
this connector as a public or commercial integration. This source does not
include a publisher OAuth service.

## Connect Jira Data Center

Choose **Jira Data Center**, enter the instance URL (including its context path
if any), and paste a personal access token. No email or Cloud ID is needed.
The connector sends the token as Bearer authorization and uses the instance's
REST API v2 search and issue endpoints. Create and revoke a PAT using
[Atlassian's Data Center instructions](https://confluence.atlassian.com/enterprise/using-personal-access-tokens-1026032365.html).
Your Jira version and administrator policy must support PAT authentication.

## Connect an in-house JSON board

Choose **JSON board** and supply its API base URL, such as
`https://tickets.example.com/api`. Optionally provide a Bearer token. The
service must implement these read-only endpoints; it does not need Jira.

| Request | Response |
| --- | --- |
| `GET {baseUrl}/tickets?q={query}&limit={limit}&cursor={cursor}` | `{ "tickets": [...], "nextCursor": "..." }` |
| `GET {baseUrl}/tickets/{encodedKey}` | A single ticket object |

The first request omits `cursor`. The screen requests 25 rows; the API accepts
page sizes from 1 to 100. Return `nextCursor: null` or omit it when there are no
more results. Keep cursors opaque strings. Do not return more than 100 rows.
Query parameters and the detail key are URL encoded by the connector.

Example page:

```json
{
  "tickets": [
    {
      "id": "101",
      "key": "DEMO-101",
      "title": "Add keyboard navigation to command search",
      "description": "Arrow keys select a result; Enter opens it.",
      "status": "Ready",
      "assignee": "Demo Developer",
      "labels": ["accessibility"],
      "url": "https://tickets.example.com/tickets/DEMO-101",
      "updatedAt": "2026-10-15T12:00:00Z"
    }
  ],
  "nextCursor": null
}
```

`key` and `title` are required. `id` defaults to the key; other displayed fields
are optional. Use plain-text descriptions, string labels, and an absolute
ticket URL on the same origin as the configured API. Cross-origin ticket links
are omitted. Ticket keys must be 1–128 ASCII letters, numbers, dots, underscores,
colons, or hyphens, starting with a letter or number. Detail responses must identify
the requested ticket. Extra fields are ignored.

Return JSON with a successful HTTP status. The connector refuses redirects,
limits responses to 1 MiB, and times requests out after 15 seconds. Configure
the final API URL and a trusted TLS certificate. HTTPS is required except for
HTTP on `localhost`, `127.0.0.1`, or `[::1]`. Embedded credentials, query strings,
and fragments are not allowed in the base URL. Authentication headers are never
forwarded through redirects.

## Review and launch

1. Search by JQL or board query and select a result. The detail preview displays
   the ticket as plain text. Loading a preview does not start an agent.
2. Choose a **local project** and an **installed eligible agent**. Remote and
   personal workspaces are excluded. The backend rechecks availability at launch.
3. Use an isolated Git worktree, or uncheck it to work in the project directory.
   Projects without initialized Git cannot use the worktree option.
4. Add your own instruction if useful, then click **Launch task from ticket**.

Launch uses the reviewed snapshot, not a silently refetched ticket. Its
single-use preview authorization expires after ten minutes; refresh and review
again if it expires or the connection changes. The title, description, labels,
and other displayed context become part of the task prompt and saved Task spec.
The app starts the chosen CLI and submits the context after it reports a known
ready state. If login, trust, or setup prevents delivery, the created task opens
with a notice: finish setup, then send the saved context from **Task spec**.

ACE does not enable permission bypass for this task. Profiles that always
bypass permission prompts are excluded from this launcher (currently Hermes).
The provider's own configuration still applies; this is not a universal
execution sandbox. Ticket text is untrusted material, and the prompt marks it
as context rather than authority to override the user's instruction.

## Credentials, data, and limits

- Connections are local to the desktop profile. Tokens use operating-system
  encrypted storage; saving a credential fails if that storage is unavailable.
  Connection names, URLs, email, and default query are local configuration data.
- Editing an unchanged connection with a blank token preserves it. Changing
  the destination or account requires entering the token again. To remove a
  token from a JSON board, remove the connection and recreate it without a token.
- Removing a connection deletes its local credential. Revoke the token at the
  issuing service when you no longer need it; local removal does not revoke it.
- Tokens are not returned to the interface, added to task instructions, or
  intentionally passed to provider processes. The desktop process necessarily
  decrypts a credential to authenticate its own requests.
- Search and preview contact the configured board. GET search URLs can be
  logged by its servers or proxies, including the JQL/query string.
- Launch sends the reviewed ticket context to the selected coding agent; that
  agent may send it to its model provider and incur usage charges. Use only
  ticket data you are allowed to share with that provider. Saved task context
  remains in local project/application data after a connection is removed.
- This connector is unavailable to paired remote browsers and the local socket
  API. It does not add webhooks, unattended queue polling, attachment download,
  OAuth login, or board writeback.

The [source](../electron/team-tickets.cts), [launch boundary](../electron/team-ticket-launch.cts),
and [screen](../src/components/TeamTicketsScreen.tsx) define the implementation.
The showcase uses fictional fixtures; it does not demonstrate a live Jira
account, secure-store write, or provider execution.

Run `npm run test:tickets` for the focused connector, credential-store, launch,
UI, task-spec preservation, and remote-access regression checks. These tests
use fixtures; a live Jira or provider smoke test requires your own accounts.
