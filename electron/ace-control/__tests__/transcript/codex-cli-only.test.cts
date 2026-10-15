const fsp = require('fs').promises;
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createTranscriptStore } = require('../../transcript/store.cts');

function createLinkOnlyDb() {
  const links = new Map();
  return {
    exec() {},
    prepare(sql: string) {
      if (sql.includes('INSERT OR REPLACE INTO tui_transcript_links')) {
        return {
          run(row: any) {
            links.set(row.stream_id, row);
          },
        };
      }
      if (
        sql.includes('SELECT stream_id, agent, session_id, session_file, cwd, linked_at, byte_offset, turn_state') &&
        sql.includes('WHERE stream_id = ?')
      ) {
        return {
          get(streamId: string) {
            return links.get(streamId);
          },
        };
      }
      if (
        sql.includes('SELECT stream_id, agent, session_id, session_file, cwd, linked_at, byte_offset, turn_state') &&
        !sql.includes('WHERE')
      ) {
        return {
          all() {
            return Array.from(links.values());
          },
        };
      }
      if (sql.includes('DELETE FROM tui_transcript_links WHERE stream_id = ?')) {
        return {
          run(streamId: string) {
            links.delete(streamId);
          },
        };
      }
      return { run() {}, get() { return null; }, all() { return []; } };
    },
  };
}

test('Codex transcript block exists for session-id capture (chat pane stays CLI-only)', async () => {
  // The Codex chat pane stays CLI-only (#547): the store drops codex links
  // and the renderer ignores codex chat availability. But the LINKER opt-in
  // must stay — it is how Ace learns the real rollout session id
  // (payload.id) so `codex resume <id>` reattaches the exact session after a
  // restart instead of `resume --last` grabbing another tab's session.
  const profilePath = path.join(__dirname, '../../profiles/codex.json');
  const profile = JSON.parse(await fsp.readFile(profilePath, 'utf8'));
  assert.equal(profile.transcript?.kind, 'jsonl-append');
  assert.ok(String(profile.transcript?.sessionGlob || '').includes('.codex/sessions'));
  assert.equal(profile.transcript?.matchByCwdField, 'payload.cwd');
  assert.equal(profile.detect?.agent, 'codex');
  assert.ok(profile.detect?.argv?.includes('codex'));
});

test('Codex transcript links are ignored by the persistent transcript store', () => {
  const store = createTranscriptStore({ db: createLinkOnlyDb() });
  store.link('conversation:conv-codex', {
    agent: 'codex',
    sessionId: 'codex-session',
    sessionFile: '/tmp/codex.jsonl',
    cwd: '/tmp/workspace',
    linkedAt: 1,
  });
  assert.equal(store.getLink('conversation:conv-codex'), null);

  store.link('conversation:conv-hermes', {
    agent: 'hermes',
    sessionId: '20260509_120000_abcd12',
    sessionFile: '/tmp/hermes/state.db',
    cwd: '/tmp/workspace',
    linkedAt: 2,
  });
  assert.equal(store.getLink('conversation:conv-hermes').agent, 'hermes');
  store.close();
});
