/**
 * ops-todos.test.cts
 *
 * Unit tests for the ops-todos store (ace.ops.todo.v1).
 * Pure JS-compatible (JSDoc types only, no TS annotation syntax).
 * Uses vitest.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const {
  listTodos,
  addTodo,
  patchTodo,
  removeTodo,
  extractHashtags,
  synthesizeTodoDigest,
  readTodoDigest,
  writeTodoDigest,
} = require('../ops-todos.cts');

// ---------------------------------------------------------------------------
// Temp file helpers
// ---------------------------------------------------------------------------

/** @type {string[]} */
const tmpFiles = [];

/**
 * @returns {string}
 */
function tmpPath() {
  const name = `ops-todos-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
  const p = path.join(os.tmpdir(), name);
  tmpFiles.push(p);
  return p;
}

afterEach(() => {
  for (const p of tmpFiles.splice(0)) {
    try { fs.unlinkSync(p); } catch { /* ignore */ }
  }
});

// ---------------------------------------------------------------------------
// addTodo — correct defaults, persist, listTodos returns it
// ---------------------------------------------------------------------------

describe('addTodo — creates with correct defaults', () => {
  it('creates todo with $schema, status open, kind unclassified, timestamps, and returns it', () => {
    const fp = tmpPath();
    const now = '2026-06-04T10:00:00.000Z';

    const todo = addTodo({ text: 'Write tests' }, { filePath: fp, now });

    expect(todo).not.toBeNull();
    expect(todo.$schema).toBe('ace.ops.todo.v1');
    expect(todo.text).toBe('Write tests');
    expect(todo.kind).toBe('unclassified');
    expect(todo.owner).toBeNull();
    expect(todo.status).toBe('open');
    expect(todo.createdAt).toBe(now);
    expect(todo.updatedAt).toBe(now);
    expect(todo.promotedMissionId).toBeNull();
    expect(typeof todo.id).toBe('string');
    expect(todo.id.startsWith('todo-')).toBe(true);
  });

  it('persists the todo so listTodos returns it', () => {
    const fp = tmpPath();
    const now = '2026-06-04T10:00:00.000Z';

    const added = addTodo({ text: 'Persisted task', kind: 'dev', owner: 'rook' }, { filePath: fp, now });
    expect(added).not.toBeNull();

    const list = listTodos({ filePath: fp });
    expect(list.length).toBe(1);
    expect(list[0].id).toBe(added.id);
    expect(list[0].kind).toBe('dev');
    expect(list[0].owner).toBe('rook');
  });
});

// ---------------------------------------------------------------------------
// addTodo — empty/whitespace text returns null, writes nothing
// ---------------------------------------------------------------------------

describe('addTodo — empty/whitespace text', () => {
  it('returns null for empty string', () => {
    const fp = tmpPath();
    const result = addTodo({ text: '' }, { filePath: fp });
    expect(result).toBeNull();
    expect(fs.existsSync(fp)).toBe(false);
  });

  it('returns null for whitespace-only string', () => {
    const fp = tmpPath();
    const result = addTodo({ text: '   ' }, { filePath: fp });
    expect(result).toBeNull();
    expect(fs.existsSync(fp)).toBe(false);
  });

  it('does not write any file when text is empty', () => {
    const fp = tmpPath();
    addTodo({ text: '' }, { filePath: fp });
    expect(fs.existsSync(fp)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// listTodos — missing file and corrupt JSON
// ---------------------------------------------------------------------------

describe('listTodos — missing/corrupt file', () => {
  it('returns [] for a missing file without throwing', () => {
    const fp = tmpPath(); // never written
    const result = listTodos({ filePath: fp });
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(0);
  });

  it('returns [] for a corrupt JSON file without throwing', () => {
    const fp = tmpPath();
    fs.writeFileSync(fp, '{ not valid json !!!', 'utf-8');
    const result = listTodos({ filePath: fp });
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(0);
  });

  it('returns [] for a file containing non-array JSON without throwing', () => {
    const fp = tmpPath();
    fs.writeFileSync(fp, JSON.stringify({ oops: true }), 'utf-8');
    const result = listTodos({ filePath: fp });
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// patchTodo — updates fields, bumps updatedAt, unknown id -> null
// ---------------------------------------------------------------------------

describe('patchTodo', () => {
  it('updates kind, owner, status and bumps updatedAt', () => {
    const fp = tmpPath();
    const now1 = '2026-06-04T10:00:00.000Z';
    const now2 = '2026-06-04T11:00:00.000Z';

    const todo = addTodo({ text: 'Fix bug' }, { filePath: fp, now: now1 });
    expect(todo).not.toBeNull();

    const patched = patchTodo(
      todo.id,
      { kind: 'dev', owner: 'rook', status: 'assigned' },
      { filePath: fp, now: now2 }
    );

    expect(patched).not.toBeNull();
    expect(patched.kind).toBe('dev');
    expect(patched.owner).toBe('rook');
    expect(patched.status).toBe('assigned');
    expect(patched.updatedAt).toBe(now2);
    expect(patched.createdAt).toBe(now1); // createdAt unchanged
    expect(patched.id).toBe(todo.id);
  });

  it('persists the patch so a subsequent listTodos reflects it', () => {
    const fp = tmpPath();
    const now1 = '2026-06-04T10:00:00.000Z';
    const now2 = '2026-06-04T11:00:00.000Z';

    const todo = addTodo({ text: 'Ship feature' }, { filePath: fp, now: now1 });
    patchTodo(todo.id, { status: 'done' }, { filePath: fp, now: now2 });

    const list = listTodos({ filePath: fp });
    expect(list[0].status).toBe('done');
    expect(list[0].updatedAt).toBe(now2);
  });

  it('returns null for an unknown id', () => {
    const fp = tmpPath();
    addTodo({ text: 'Something' }, { filePath: fp });
    const result = patchTodo('todo-unknown-999', { status: 'done' }, { filePath: fp });
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// removeTodo — removes existing -> true, missing -> false
// ---------------------------------------------------------------------------

describe('removeTodo', () => {
  it('removes an existing todo and returns true', () => {
    const fp = tmpPath();
    const todo = addTodo({ text: 'To remove' }, { filePath: fp });
    expect(todo).not.toBeNull();

    const removed = removeTodo(todo.id, { filePath: fp });
    expect(removed).toBe(true);

    const list = listTodos({ filePath: fp });
    expect(list.length).toBe(0);
  });

  it('returns false for a non-existent id', () => {
    const fp = tmpPath();
    addTodo({ text: 'Keep me' }, { filePath: fp });
    const result = removeTodo('todo-ghost-0000', { filePath: fp });
    expect(result).toBe(false);
  });

  it('returns false on a completely missing file', () => {
    const fp = tmpPath(); // never written
    const result = removeTodo('todo-ghost-0001', { filePath: fp });
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// listTodos is newest-first
// ---------------------------------------------------------------------------

describe('listTodos — newest-first ordering', () => {
  it('returns todos sorted newest-first by createdAt', () => {
    const fp = tmpPath();

    addTodo({ text: 'Oldest' }, { filePath: fp, now: '2026-06-01T08:00:00.000Z' });
    addTodo({ text: 'Middle' }, { filePath: fp, now: '2026-06-02T08:00:00.000Z' });
    addTodo({ text: 'Newest' }, { filePath: fp, now: '2026-06-03T08:00:00.000Z' });

    const list = listTodos({ filePath: fp });
    expect(list.length).toBe(3);
    expect(list[0].text).toBe('Newest');
    expect(list[1].text).toBe('Middle');
    expect(list[2].text).toBe('Oldest');
  });
});

// ---------------------------------------------------------------------------
// kind accepts all valid values
// ---------------------------------------------------------------------------

describe('kind field — all valid values', () => {
  it.each(['dev', 'life', 'company', 'unclassified'])('accepts kind=%s', (kind) => {
    const fp = tmpPath();
    /** @type {'dev'|'life'|'company'|'unclassified'} */
    const typedKind = kind;
    const todo = addTodo({ text: `Task for kind ${kind}`, kind: typedKind }, { filePath: fp });
    expect(todo).not.toBeNull();
    expect(todo.kind).toBe(kind);

    const list = listTodos({ filePath: fp });
    expect(list[0].kind).toBe(kind);
  });
});

// ---------------------------------------------------------------------------
// patchTodo — promotedMissionId round-trip
// ---------------------------------------------------------------------------

describe('patchTodo — promotedMissionId', () => {
  it('sets promotedMissionId and status=promoted', () => {
    const fp = tmpPath();
    const todo = addTodo({ text: 'Promote me', kind: 'dev' }, { filePath: fp });
    expect(todo).not.toBeNull();
    expect(todo.promotedMissionId).toBeNull();

    const patched = patchTodo(
      todo.id,
      { status: 'promoted', promotedMissionId: 'msn-abc123' },
      { filePath: fp }
    );
    expect(patched).not.toBeNull();
    expect(patched.status).toBe('promoted');
    expect(patched.promotedMissionId).toBe('msn-abc123');
  });
});

// ---------------------------------------------------------------------------
// Extended fields — notes, source, workspaceId, priority, dueAt
// ---------------------------------------------------------------------------

describe('extended fields — addTodo', () => {
  it('defaults all extended fields to null when omitted', () => {
    const fp = tmpPath();
    const todo = addTodo({ text: 'Plain todo' }, { filePath: fp });
    expect(todo).not.toBeNull();
    expect(todo.notes).toBeNull();
    expect(todo.source).toBeNull();
    expect(todo.workspaceId).toBeNull();
    expect(todo.priority).toBeNull();
    expect(todo.dueAt).toBeNull();
  });

  it('creates a todo with all extended fields set', () => {
    const fp = tmpPath();
    const todo = addTodo(
      {
        text: 'Full todo',
        kind: 'dev',
        owner: 'rook',
        notes: 'Some detailed notes',
        source: 'wiki',
        workspaceId: 'ws-42',
        priority: 'high',
        dueAt: '2026-06-10T09:00:00.000Z',
      },
      { filePath: fp }
    );
    expect(todo).not.toBeNull();
    expect(todo.notes).toBe('Some detailed notes');
    expect(todo.source).toBe('wiki');
    expect(todo.workspaceId).toBe('ws-42');
    expect(todo.priority).toBe('high');
    expect(todo.dueAt).toBe('2026-06-10T09:00:00.000Z');

    const list = listTodos({ filePath: fp });
    expect(list[0].notes).toBe('Some detailed notes');
    expect(list[0].source).toBe('wiki');
    expect(list[0].workspaceId).toBe('ws-42');
    expect(list[0].priority).toBe('high');
    expect(list[0].dueAt).toBe('2026-06-10T09:00:00.000Z');
  });
});

describe('extended fields — patchTodo sets each field', () => {
  it.each([
    ['notes', 'Updated notes'],
    ['source', 'inbox'],
    ['workspaceId', 'ws-99'],
    ['priority', 'medium'],
    ['dueAt', '2026-07-01T00:00:00.000Z'],
  ])('patches %s', (field, value) => {
    const fp = tmpPath();
    const todo = addTodo({ text: `Patch ${field}` }, { filePath: fp });
    expect(todo).not.toBeNull();
    expect(todo[field]).toBeNull();

    const patched = patchTodo(todo.id, { [field]: value }, { filePath: fp });
    expect(patched).not.toBeNull();
    expect(patched[field]).toBe(value);

    const list = listTodos({ filePath: fp });
    expect(list[0][field]).toBe(value);
  });

  it('leaves extended fields untouched when patch omits them', () => {
    const fp = tmpPath();
    const todo = addTodo(
      { text: 'Keep fields', notes: 'note', source: 'cli', workspaceId: 'ws-1', priority: 'low', dueAt: '2026-06-20T00:00:00.000Z' },
      { filePath: fp }
    );
    const patched = patchTodo(todo.id, { status: 'done' }, { filePath: fp });
    expect(patched.notes).toBe('note');
    expect(patched.source).toBe('cli');
    expect(patched.workspaceId).toBe('ws-1');
    expect(patched.priority).toBe('low');
    expect(patched.dueAt).toBe('2026-06-20T00:00:00.000Z');
  });
});

describe('extended fields — patch to explicit null clears', () => {
  it.each(['notes', 'source', 'workspaceId', 'priority', 'dueAt'])('clears %s with explicit null', (field) => {
    const fp = tmpPath();
    const todo = addTodo(
      { text: 'Clear me', notes: 'n', source: 's', workspaceId: 'w', priority: 'high', dueAt: '2026-06-15T00:00:00.000Z' },
      { filePath: fp }
    );
    expect(todo[field]).not.toBeNull();

    const patched = patchTodo(todo.id, { [field]: null }, { filePath: fp });
    expect(patched).not.toBeNull();
    expect(patched[field]).toBeNull();

    const list = listTodos({ filePath: fp });
    expect(list[0][field]).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Legacy record normalization — old-shape records load with null defaults
// ---------------------------------------------------------------------------

describe('legacy record normalization', () => {
  it('normalizes a raw old-shape record (missing extended fields) to nulls on read', () => {
    const fp = tmpPath();
    const legacy = [
      {
        $schema: 'ace.ops.todo.v1',
        id: 'todo-1700000000000-legacy',
        text: 'Old todo',
        kind: 'dev',
        owner: 'rook',
        status: 'open',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        promotedMissionId: null,
      },
    ];
    fs.writeFileSync(fp, JSON.stringify(legacy, null, 2), 'utf-8');

    const list = listTodos({ filePath: fp });
    expect(list.length).toBe(1);
    expect(list[0].text).toBe('Old todo');
    expect(list[0].notes).toBeNull();
    expect(list[0].source).toBeNull();
    expect(list[0].workspaceId).toBeNull();
    expect(list[0].priority).toBeNull();
    expect(list[0].dueAt).toBeNull();
  });

  it('patches a legacy record and persists the normalized shape', () => {
    const fp = tmpPath();
    const legacy = [
      {
        $schema: 'ace.ops.todo.v1',
        id: 'todo-1700000000001-legacy',
        text: 'Old todo to patch',
        kind: 'unclassified',
        owner: null,
        status: 'open',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        promotedMissionId: null,
      },
    ];
    fs.writeFileSync(fp, JSON.stringify(legacy, null, 2), 'utf-8');

    const patched = patchTodo('todo-1700000000001-legacy', { priority: 'high' }, { filePath: fp });
    expect(patched).not.toBeNull();
    expect(patched.priority).toBe('high');
    expect(patched.notes).toBeNull();
    expect(patched.source).toBeNull();
    expect(patched.workspaceId).toBeNull();
    expect(patched.dueAt).toBeNull();

    const onDisk = JSON.parse(fs.readFileSync(fp, 'utf-8'));
    expect(onDisk[0].priority).toBe('high');
    expect(onDisk[0].notes).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tags — hashtag extraction, explicit tags, normalization, patching
// ---------------------------------------------------------------------------

describe('tags — hashtag extraction on add', () => {
  it('extracts #hashtags lowercased, deduped, stripped of #, keeping them in the text', () => {
    const fp = tmpPath();
    const todo = addTodo({ text: 'Fix the #Ace build #ci and #ace docs' }, { filePath: fp });
    expect(todo).not.toBeNull();
    expect(todo.tags).toEqual(['ace', 'ci']);
    expect(todo.text).toBe('Fix the #Ace build #ci and #ace docs'); // hashtags stay
  });

  it('merges explicit input tags with extracted hashtags, deduped', () => {
    const fp = tmpPath();
    const todo = addTodo({ text: 'note #alpha', tags: ['Beta', '#alpha', 'gamma'] }, { filePath: fp });
    expect(todo.tags).toEqual(['beta', 'alpha', 'gamma']);
  });

  it('defaults tags to [] when text has no hashtags and none are passed', () => {
    const fp = tmpPath();
    const todo = addTodo({ text: 'plain note' }, { filePath: fp });
    expect(todo.tags).toEqual([]);
  });

  it('extractHashtags is exported and pure', () => {
    expect(extractHashtags('a #One #two #one b')).toEqual(['one', 'two']);
    expect(extractHashtags('no tags here')).toEqual([]);
  });
});

describe('tags — normalization of old records', () => {
  it('normalizes legacy records without tags to [] on read', () => {
    const fp = tmpPath();
    const legacy = [
      {
        $schema: 'ace.ops.todo.v1',
        id: 'todo-1700000000002-legacy',
        text: 'Old todo without tags',
        kind: 'dev',
        owner: null,
        status: 'open',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        promotedMissionId: null,
      },
    ];
    fs.writeFileSync(fp, JSON.stringify(legacy, null, 2), 'utf-8');

    const list = listTodos({ filePath: fp });
    expect(list[0].tags).toEqual([]);
  });

  it('normalizes a non-array tags value to []', () => {
    const fp = tmpPath();
    const broken = [
      {
        $schema: 'ace.ops.todo.v1',
        id: 'todo-1700000000003-broken',
        text: 'Broken tags',
        kind: 'life',
        owner: null,
        status: 'open',
        createdAt: '2026-01-02T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
        promotedMissionId: null,
        tags: 'not-an-array',
      },
    ];
    fs.writeFileSync(fp, JSON.stringify(broken, null, 2), 'utf-8');
    expect(listTodos({ filePath: fp })[0].tags).toEqual([]);
  });

  it('patchTodo replaces tags (normalized) and leaves them alone when omitted', () => {
    const fp = tmpPath();
    const todo = addTodo({ text: 'taggable #keep' }, { filePath: fp });
    expect(todo.tags).toEqual(['keep']);

    const untouched = patchTodo(todo.id, { status: 'assigned' }, { filePath: fp });
    expect(untouched.tags).toEqual(['keep']);

    const patched = patchTodo(todo.id, { tags: ['#New', 'new', 'OTHER'] }, { filePath: fp });
    expect(patched.tags).toEqual(['new', 'other']);
  });
});

// ---------------------------------------------------------------------------
// synthesizeTodoDigest — deterministic rule-based proposals
// ---------------------------------------------------------------------------

// Fixed fixture: 5 open/assigned + 1 done + 1 promoted. now is injected so
// every assertion is deterministic.
const DIGEST_NOW = '2026-06-12T08:00:00.000Z';

function digestFixture() {
  const base = {
    $schema: 'ace.ops.todo.v1',
    owner: null,
    promotedMissionId: null,
    notes: null,
    source: null,
    workspaceId: null,
    priority: null,
    dueAt: null,
    tags: [],
  };
  return [
    { ...base, id: 't1', text: 'Ship tag filters #ace', kind: 'dev', status: 'open', priority: 'high', workspaceId: 'ws-1', tags: ['ace'], createdAt: '2026-06-10T08:00:00.000Z', updatedAt: '2026-06-10T08:00:00.000Z' },
    { ...base, id: 't2', text: 'Fix updater retry', kind: 'dev', status: 'assigned', dueAt: '2026-06-13T08:00:00.000Z', createdAt: '2026-06-10T09:00:00.000Z', updatedAt: '2026-06-10T09:00:00.000Z' },
    { ...base, id: 't3', text: 'Book dentist', kind: 'life', status: 'open', createdAt: '2026-06-10T10:00:00.000Z', updatedAt: '2026-06-10T10:00:00.000Z' },
    { ...base, id: 't4', text: 'Quarterly review prep', kind: 'company', status: 'open', createdAt: '2026-06-10T11:00:00.000Z', updatedAt: '2026-06-10T11:00:00.000Z' },
    { ...base, id: 't5', text: 'random thought #later', kind: 'unclassified', status: 'open', tags: ['later'], createdAt: '2026-06-10T12:00:00.000Z', updatedAt: '2026-06-10T12:00:00.000Z' },
    { ...base, id: 't6', text: 'Already finished', kind: 'dev', status: 'done', createdAt: '2026-06-09T08:00:00.000Z', updatedAt: '2026-06-09T08:00:00.000Z' },
    { ...base, id: 't7', text: 'Already promoted', kind: 'dev', status: 'promoted', promotedMissionId: 'msn-1', createdAt: '2026-06-09T09:00:00.000Z', updatedAt: '2026-06-09T09:00:00.000Z' },
  ];
}

describe('synthesizeTodoDigest', () => {
  it('includes only open + assigned todos and stamps schema/slot/now', () => {
    const digest = synthesizeTodoDigest(digestFixture(), { now: DIGEST_NOW, slot: 'morning' });
    expect(digest.$schema).toBe('ace.ops.todo-digest.v1');
    expect(digest.slot).toBe('morning');
    expect(digest.generatedAt).toBe(DIGEST_NOW);
    expect(digest.openCount).toBe(5);
    const allIds = [];
    for (const group of digest.groups) allIds.push(...group.todoIds);
    expect(allIds).not.toContain('t6');
    expect(allIds).not.toContain('t7');
  });

  it('groups by kind then dominant tag, unclassified always loose', () => {
    const digest = synthesizeTodoDigest(digestFixture(), { now: DIGEST_NOW, slot: 'morning' });
    expect(digest.groups).toEqual([
      { label: 'Dev · #ace', todoIds: ['t1'] },
      { label: 'Dev', todoIds: ['t2'] },
      { label: 'Company', todoIds: ['t4'] },
      { label: 'Life', todoIds: ['t3'] },
      { label: 'Loose notes', todoIds: ['t5'] },
    ]);
  });

  it('restates high-priority and due-within-48h items as outcome goals', () => {
    const digest = synthesizeTodoDigest(digestFixture(), { now: DIGEST_NOW, slot: 'morning' });
    expect(digest.goals).toEqual([
      { text: 'Ship: Ship tag filters #ace', todoIds: ['t1'] }, // high priority
      { text: 'Ship: Fix updater retry', todoIds: ['t2'] }, // due in 24h
    ]);
  });

  it('suggests a rule-based next step per todo', () => {
    const digest = synthesizeTodoDigest(digestFixture(), { now: DIGEST_NOW, slot: 'morning' });
    const byId = new Map();
    for (const s of digest.suggestions) byId.set(s.todoId, s.suggestion);
    expect(byId.get('t1')).toBe('Promote to ticket in ws-1');
    expect(byId.get('t2')).toBe('Pick a target project, then promote');
    expect(byId.get('t3')).toBe('Schedule it');
    expect(byId.get('t4')).toBe('Assign an owner');
    expect(byId.get('t5')).toBe('Classify it (dev / life / company), then route it');
  });

  it('renders markdown with the digest heading, sections, and the proposals footer', () => {
    const digest = synthesizeTodoDigest(digestFixture(), { now: DIGEST_NOW, slot: 'night' });
    expect(digest.slot).toBe('night');
    expect(digest.markdown).toContain('# Todo digest — night 2026-06-12');
    expect(digest.markdown).toContain('## Goals');
    expect(digest.markdown).toContain('## By project');
    expect(digest.markdown).toContain('## Loose notes');
    expect(digest.markdown).toContain('**Ship: Ship tag filters #ace**');
    expect(digest.markdown).toContain('Auto-organized proposals — nothing was auto-promoted.');
  });

  it('is deterministic — same todos + same now produce identical digests', () => {
    const a = synthesizeTodoDigest(digestFixture(), { now: DIGEST_NOW, slot: 'morning' });
    const b = synthesizeTodoDigest(digestFixture(), { now: DIGEST_NOW, slot: 'morning' });
    expect(a).toEqual(b);
  });

  it('never throws on junk input and yields an honest empty digest', () => {
    const digest = synthesizeTodoDigest(null, { now: DIGEST_NOW, slot: 'morning' });
    expect(digest.openCount).toBe(0);
    expect(digest.groups).toEqual([]);
    expect(digest.goals).toEqual([]);
    expect(digest.suggestions).toEqual([]);
    expect(digest.markdown).toContain('_No high-priority or due-soon items._');
  });
});

// ---------------------------------------------------------------------------
// Digest read/write round-trip
// ---------------------------------------------------------------------------

describe('readTodoDigest / writeTodoDigest', () => {
  it('round-trips a digest through write + read in a tmp path', () => {
    const fp = tmpPath();
    const digest = synthesizeTodoDigest(digestFixture(), { now: DIGEST_NOW, slot: 'morning' });

    expect(writeTodoDigest(digest, { filePath: fp })).toBe(true);
    const read = readTodoDigest({ filePath: fp });
    expect(read).toEqual(digest);
  });

  it('returns null for a missing digest file', () => {
    const fp = tmpPath(); // never written
    expect(readTodoDigest({ filePath: fp })).toBeNull();
  });

  it('returns null for corrupt or foreign-schema JSON', () => {
    const fp = tmpPath();
    fs.writeFileSync(fp, 'nope{', 'utf-8');
    expect(readTodoDigest({ filePath: fp })).toBeNull();

    fs.writeFileSync(fp, JSON.stringify({ $schema: 'something.else.v1' }), 'utf-8');
    expect(readTodoDigest({ filePath: fp })).toBeNull();
  });

  it('refuses to write a non-digest object', () => {
    const fp = tmpPath();
    expect(writeTodoDigest(null, { filePath: fp })).toBe(false);
    expect(writeTodoDigest({ $schema: 'wrong' }, { filePath: fp })).toBe(false);
    expect(fs.existsSync(fp)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Persistence round-trip — extended fields survive write + re-read
// ---------------------------------------------------------------------------

describe('persistence round-trip — extended fields', () => {
  it('round-trips all extended fields through add, patch, and re-read', () => {
    const fp = tmpPath();

    const todo = addTodo(
      {
        text: 'Round trip',
        notes: 'first note',
        source: 'voice',
        workspaceId: 'ws-rt',
        priority: 'low',
        dueAt: '2026-08-01T12:00:00.000Z',
      },
      { filePath: fp }
    );
    expect(todo).not.toBeNull();

    patchTodo(todo.id, { priority: 'medium', notes: 'second note' }, { filePath: fp });

    const list = listTodos({ filePath: fp });
    expect(list.length).toBe(1);
    expect(list[0].notes).toBe('second note');
    expect(list[0].source).toBe('voice');
    expect(list[0].workspaceId).toBe('ws-rt');
    expect(list[0].priority).toBe('medium');
    expect(list[0].dueAt).toBe('2026-08-01T12:00:00.000Z');

    const onDisk = JSON.parse(fs.readFileSync(fp, 'utf-8'));
    expect(onDisk[0].notes).toBe('second note');
    expect(onDisk[0].priority).toBe('medium');
    expect(onDisk[0].dueAt).toBe('2026-08-01T12:00:00.000Z');
  });
});
