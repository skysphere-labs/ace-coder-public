import { describe, expect, test } from 'vitest';

const {
  extractLoginUrls,
  findTaskIdForStream,
  createLoginUrlWatcher,
} = require('../login-url-watcher.cts');

const CLAUDE_URL =
  'https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A54545%2Fcallback&scope=org%3Acreate_api_key&state=abc123DEF456';

describe('extractLoginUrls', () => {
  test('finds a plain claude.ai oauth URL in CLI output', () => {
    const chunk = `Opening browser to sign in…\r\n\r\nIf your browser doesn't open, use this URL:\r\n\r\n${CLAUDE_URL}\r\n\r\nPaste code here if prompted >\r\n`;
    expect(extractLoginUrls(chunk)).toEqual([CLAUDE_URL]);
  });

  test('finds URLs wrapped in ANSI color and cursor sequences', () => {
    const chunk = `\x1b[2m\x1b[38;2;153;153;153m${CLAUDE_URL}\x1b[39m\x1b[22m\r\n\r\n\x1b[2mWaiting…\x1b[22m`;
    expect(extractLoginUrls(chunk)).toEqual([CLAUDE_URL]);
  });

  test('holds a candidate that runs into the end of the chunk (may continue)', () => {
    expect(extractLoginUrls(`use this: ${CLAUDE_URL.slice(0, 60)}`)).toEqual([]);
  });

  test('does not swallow a second URL printed on the following redraw line', () => {
    const chunk = `${CLAUDE_URL}\r\n${CLAUDE_URL}\r\n\r\n`;
    expect(extractLoginUrls(chunk)).toEqual([CLAUDE_URL]);
  });

  test('does not join a short line onto following prose', () => {
    const chunk = `go to https://github.com/login/device\r\nThen enter the code shown.\r\n`;
    expect(extractLoginUrls(chunk)).toEqual(['https://github.com/login/device']);
  });

  test('reassembles a URL hard-wrapped across terminal lines', () => {
    const wrapped =
      CLAUDE_URL.slice(0, 74) + '\r\n' + CLAUDE_URL.slice(74, 148) + '\r\n' + CLAUDE_URL.slice(148);
    const chunk = `Use this URL:\r\n\r\n${wrapped}\r\n\r\nWaiting…`;
    expect(extractLoginUrls(chunk)).toEqual([CLAUDE_URL]);
  });

  test('reassembles a wrapped URL with box-drawing decoration on continuation lines', () => {
    const chunk = `│ ${CLAUDE_URL.slice(0, 60)}\r\n│ ${CLAUDE_URL.slice(60, 120)}\r\n│ ${CLAUDE_URL.slice(120)}\r\n│\r\n`;
    expect(extractLoginUrls(chunk)).toEqual([CLAUDE_URL]);
  });

  test('does not join across a blank line', () => {
    const url = 'https://github.com/login/device';
    const chunk = `${url}\r\n\r\nhttps://example.com/unrelated`;
    expect(extractLoginUrls(chunk)).toEqual([url]);
  });

  test('prefers OSC 8 hyperlink URIs (never wrapped)', () => {
    const chunk = `\x1b]8;;${CLAUDE_URL}\x07sign in\x1b]8;;\x07`;
    expect(extractLoginUrls(chunk)).toEqual([CLAUDE_URL]);
  });

  test('recognizes the other agent CLI auth hosts', () => {
    for (const url of [
      'https://console.anthropic.com/oauth/authorize?client_id=x',
      'https://auth.openai.com/oauth/authorize?response_type=code',
      'https://github.com/login/device',
      'https://accounts.google.com/o/oauth2/v2/auth?client_id=x',
    ]) {
      expect(extractLoginUrls(`visit ${url} to continue\r\n`)).toEqual([url]);
    }
  });

  test('ignores ordinary web URLs', () => {
    expect(
      extractLoginUrls('see https://github.com/foo/bar and https://claude.ai/chats today\r\n')
    ).toEqual([]);
  });

  test('strips trailing punctuation glued by prose', () => {
    expect(extractLoginUrls('go to https://github.com/login/device. ok\r\n')).toEqual([
      'https://github.com/login/device',
    ]);
  });
});

describe('findTaskIdForStream', () => {
  const state = {
    workspaces: [
      {
        tasks: [
          {
            id: 'task-1',
            conversations: [{ id: 'conv-9' }],
            worktrees: [{ variants: [{ id: 'var-5' }] }],
          },
        ],
        archivedTasks: [{ id: 'task-2', conversations: [{ id: 'conv-arch' }] }],
      },
    ],
  };

  test('resolves conversation, variant, and shell stream ids', () => {
    expect(findTaskIdForStream(state, 'conversation:conv-9')).toBe('task-1');
    expect(findTaskIdForStream(state, 'variant:var-5')).toBe('task-1');
    expect(findTaskIdForStream(state, 'shell:task-1')).toBe('task-1');
    expect(findTaskIdForStream(state, 'shell:task-1:2')).toBe('task-1');
    expect(findTaskIdForStream(state, 'conversation:conv-arch')).toBe('task-2');
  });

  test('returns null for unknown or malformed ids', () => {
    expect(findTaskIdForStream(state, 'conversation:nope')).toBe(null);
    expect(findTaskIdForStream(state, 'garbage')).toBe(null);
    expect(findTaskIdForStream(state, null)).toBe(null);
  });
});

describe('createLoginUrlWatcher', () => {
  function makeHarness(nowRef) {
    const scratch = new Map();
    const requests = [];
    const store = {
      getState: () => ({
        workspaces: [
          { tasks: [{ id: 'task-1', conversations: [{ id: 'conv-9' }] }], archivedTasks: [] },
        ],
      }),
      listScratchTabs: ({ taskId }) => scratch.get(taskId) || { tabs: [], activeId: null },
      saveScratchTabs: ({ taskId, tabs, activeId }) => {
        scratch.set(taskId, { tabs, activeId });
        return { ok: true };
      },
    };
    const watcher = createLoginUrlWatcher({
      store,
      emitUiRequest: (payload) => requests.push(payload),
      now: () => nowRef.t,
    });
    return { watcher, requests, scratch };
  }

  test('opens exactly one browser tab per login URL despite TUI redraws', () => {
    const nowRef = { t: 1_000 };
    const { watcher, requests, scratch } = makeHarness(nowRef);
    for (let i = 0; i < 5; i++) {
      watcher.handlePtyData({ id: 'conversation:conv-9', chunk: `redraw\r\n${CLAUDE_URL}\r\n\r\n` });
      nowRef.t += 500;
    }
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      type: 'open',
      taskId: 'task-1',
      url: CLAUDE_URL,
      source: 'login-url',
    });
    const saved = scratch.get('task-1');
    expect(saved.tabs).toHaveLength(1);
    expect(saved.tabs[0]).toMatchObject({ kind: 'browser', url: CLAUDE_URL });
    expect(saved.activeId).toBe(saved.tabs[0].id);
  });

  test('matches a URL split across two PTY chunks', () => {
    const nowRef = { t: 1_000 };
    const { watcher, requests } = makeHarness(nowRef);
    watcher.handlePtyData({ id: 'conversation:conv-9', chunk: `url: ${CLAUDE_URL.slice(0, 40)}` });
    watcher.handlePtyData({ id: 'conversation:conv-9', chunk: `${CLAUDE_URL.slice(40)}\r\n\r\n` });
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe(CLAUDE_URL);
  });

  test('re-activates an existing tab instead of duplicating it after the TTL', () => {
    const nowRef = { t: 1_000 };
    const { watcher, requests } = makeHarness(nowRef);
    watcher.handlePtyData({ id: 'conversation:conv-9', chunk: `${CLAUDE_URL}\r\n\r\n` });
    nowRef.t += 11 * 60_000; // past dedupe TTL and cooldown
    watcher.handlePtyData({ id: 'conversation:conv-9', chunk: `${CLAUDE_URL}\r\n\r\n` });
    expect(requests).toHaveLength(2);
    expect(requests[1].type).toBe('activate');
    expect(requests[1].tabId).toBe(requests[0].tabId);
  });

  test('ignores streams that resolve to no task', () => {
    const nowRef = { t: 1_000 };
    const { watcher, requests } = makeHarness(nowRef);
    watcher.handlePtyData({ id: 'conversation:unknown', chunk: `${CLAUDE_URL}\r\n\r\n` });
    expect(requests).toHaveLength(0);
  });

  test('reset clears per-stream dedupe state', () => {
    const nowRef = { t: 1_000 };
    const { watcher, requests } = makeHarness(nowRef);
    watcher.handlePtyData({ id: 'conversation:conv-9', chunk: `${CLAUDE_URL}\r\n\r\n` });
    watcher.reset('conversation:conv-9');
    nowRef.t += 61_000; // past cooldown, inside what WOULD have been the TTL
    watcher.handlePtyData({ id: 'conversation:conv-9', chunk: `${CLAUDE_URL}\r\n\r\n` });
    expect(requests).toHaveLength(2);
    expect(requests[1].type).toBe('activate'); // tab already exists → activate
  });
});
