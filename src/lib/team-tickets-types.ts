/** Desktop-only ticket intake. Tokens are write-only and never part of responses. */
export type TeamTicketConnectionKind = 'jira-cloud' | 'jira-datacenter' | 'json-board';

export interface TeamTicketConnection {
  id: string;
  name: string;
  kind: TeamTicketConnectionKind;
  baseUrl: string;
  email: string | null;
  cloudId: string | null;
  defaultQuery: string;
  hasToken: boolean;
}

export interface TeamTicketConnectionInput {
  id?: string;
  name: string;
  kind: TeamTicketConnectionKind;
  baseUrl: string;
  email?: string | null;
  cloudId?: string | null;
  defaultQuery?: string;
  /** Omit or leave empty to retain a token only when its destination is unchanged. */
  token?: string;
}

export interface TeamTicket {
  connectionId: string;
  id: string;
  key: string;
  title: string;
  description: string;
  status: string;
  assignee: string | null;
  labels: string[];
  url: string | null;
  updatedAt: string | null;
}

export interface TeamTicketSearchInput {
  connectionId: string;
  /** JQL for Jira; free text for JSON boards. */
  query?: string;
  cursor?: string | null;
  limit?: number;
}

export interface TeamTicketSearchResult {
  tickets: TeamTicket[];
  nextCursor: string | null;
}

export interface TeamTicketGetInput { connectionId: string; key: string }
export interface TeamTicketPromptInput { ticket: TeamTicket; instruction?: string }

export interface TeamTicketPreview extends TeamTicket { previewToken: string }
export interface TeamTicketLaunchInput {
  ticket: TeamTicketPreview;
  workspaceId: string;
  agent: string;
  instruction?: string;
  useWorktree: boolean;
}
