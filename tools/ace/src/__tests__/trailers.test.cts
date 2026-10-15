const test = require('node:test');
const assert = require('node:assert/strict');
const { parseTrailers, listTrailers, listTerminalTrailers } = require('../trailers.cjs');

test('parseTrailers: detects DONE', () => {
  const r = parseTrailers('lots of work\nDONE: shipped the feature');
  assert.equal(r.done, 'shipped the feature');
  assert.equal(r.blocked, undefined);
  assert.equal(r.verdict, undefined);
  assert.match(r.raw, /shipped the feature/);
});

test('parseTrailers: detects BLOCKED', () => {
  const r = parseTrailers('I tried X but\nBLOCKED: missing DB creds');
  assert.equal(r.blocked, 'missing DB creds');
  assert.equal(r.done, undefined);
});

test('parseTrailers: detects VERDICT', () => {
  const r = parseTrailers('Reviewed the PR.\nVERDICT: request-changes');
  assert.equal(r.verdict, 'request-changes');
  assert.equal(r.done, undefined);
  assert.equal(r.blocked, undefined);
});

test('parseTrailers: returns all three when present', () => {
  const r = parseTrailers([
    'Audit run.',
    'BLOCKED: needed extra context but proceeded anyway',
    'VERDICT: approve',
    'DONE: review complete',
  ].join('\n'));
  assert.equal(r.done, 'review complete');
  assert.equal(r.blocked, 'needed extra context but proceeded anyway');
  assert.equal(r.verdict, 'approve');
});

test('parseTrailers: last occurrence of a repeated trailer wins', () => {
  const r = parseTrailers('DONE: first try\nactually no\nDONE: second try');
  assert.equal(r.done, 'second try');
});

test('parseTrailers: detects DONE after Codex bullet prefix', () => {
  const r = parseTrailers('work complete\n• DONE: no-code goal-mode smoke completed\n─');
  assert.equal(r.done, 'no-code goal-mode smoke completed');
});

test('parseTrailers: detects BLOCKED after Codex bullet prefix', () => {
  const r = parseTrailers('stopped\n• BLOCKED: missing approval');
  assert.equal(r.blocked, 'missing approval');
});

test('parseTrailers: detects Claude status glyph trailers', () => {
  const r = parseTrailers('work complete\n⏺ DONE: fixed trigger parsing\n⏺ BLOCKED: later blocker');
  assert.equal(r.done, 'fixed trigger parsing');
  assert.equal(r.blocked, 'later blocker');
});

test('parseTrailers: bullet trailer lines are captured; last occurrence wins', () => {
  // Bullet/markdown-bold forms are real trailers per the hardened parser.
  // `parseTrailers` is a non-terminal scan and "last occurrence of a kind wins",
  // so an earlier bullet BLOCKED is preserved unless overridden later.
  const r = parseTrailers([
    '# Deliverables',
    '- DONE: VERDICT=<pass|request-changes|block> on PR #192.',
    '# Escape hatch',
    '- BLOCKED: missing context',
    '',
    'Posted verdict.',
    'DONE: VERDICT=pass on PR #192.',
  ].join('\n'));
  assert.equal(r.done, 'VERDICT=pass on PR #192.');
  assert.equal(r.blocked, 'missing context');
});

test('parseTrailers: no trailers → only raw is set', () => {
  const r = parseTrailers('just rambling text, no marker');
  assert.equal(r.done, undefined);
  assert.equal(r.blocked, undefined);
  assert.equal(r.verdict, undefined);
  assert.equal(r.raw, 'just rambling text, no marker');
});

test('parseTrailers: handles empty/non-string input', () => {
  assert.deepEqual(parseTrailers(''), { raw: '' });
  assert.deepEqual(parseTrailers(null), { raw: '' });
  assert.deepEqual(parseTrailers(undefined), { raw: '' });
});

test('parseTrailers: trailer without detail returns null', () => {
  const r = parseTrailers('DONE:');
  assert.equal(r.done, null);
});

test('listTrailers: preserves visible trailer order for event queues', () => {
  assert.deepEqual(
    listTrailers('BLOCKED: waiting on auth\nVERDICT: fail\nDONE: later success'),
    [
      { kind: 'blocked', detail: 'waiting on auth' },
      { kind: 'verdict', detail: 'fail' },
      { kind: 'done', detail: 'later success' },
    ]
  );
});

test('trailers ignore command registry text that wraps onto a BLOCKED-looking line', () => {
  const text = 'BLOCKED: trailer state back to the feature.","ipcMethod":"special:missionSync","flags":';
  const parsed = parseTrailers(text);
  assert.equal(parsed.blocked, undefined);
  assert.deepEqual(listTrailers(text), []);
  assert.deepEqual(listTerminalTrailers(text), []);
});

test('listTerminalTrailers returns only the final assistant trailer', () => {
  assert.deepEqual(
    listTerminalTrailers([
      'BLOCKED: trailer state back to the feature.","ipcMethod":"special:missionSync","flags":',
      'worker output',
      'DONE: lane A observed describe/mission commands; no code changes.',
      '›',
    ].join('\n')),
    [{ kind: 'done', detail: 'lane A observed describe/mission commands; no code changes.' }]
  );
});

test('parseTrailers/listTerminalTrailers: accept every bullet/markdown trailer form', () => {
  const cases: Array<[string, 'done' | 'blocked', string]> = [
    ['DONE: summary',                       'done',    'summary'],
    ['BLOCKED: reason',                     'blocked', 'reason'],
    ['• BLOCKED: reason',                   'blocked', 'reason'],
    ['⏺ BLOCKED: reason',                   'blocked', 'reason'],
    ['- BLOCKED: reason',                   'blocked', 'reason'],
    ['* BLOCKED: reason',                   'blocked', 'reason'],
    ['• DONE: summary',                     'done',    'summary'],
    ['- **BLOCKED:** reason',               'blocked', 'reason'],
    ['• **DONE:** summary',                 'done',    'summary'],
    ['  • BLOCKED: reason',                 'blocked', 'reason'],
    ['**BLOCKED:** reason',                 'blocked', 'reason'],
  ];
  for (const [input, kind, detail] of cases) {
    const parsed = parseTrailers(input);
    assert.equal(parsed[kind], detail, `parseTrailers should match ${JSON.stringify(input)}`);
    assert.deepEqual(
      listTerminalTrailers(input),
      [{ kind, detail }],
      `listTerminalTrailers should match ${JSON.stringify(input)}`
    );
  }
});

test('listTerminalTrailers accepts Claude post-DONE status footer chrome', () => {
  assert.deepEqual(
    listTerminalTrailers([
      '⏺ DONE: lane B live event trigger completed.',
      '',
      '✻ Crunched for 1s',
      '',
      '────────────────────────────────────────────────────────────────',
      '❯ ',
      '────────────────────────────────────────────────────────────────',
      '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents',
    ].join('\n')),
    [{ kind: 'done', detail: 'lane B live event trigger completed.' }]
  );
});

test('listTerminalTrailers accepts wrapped BLOCKED before goal/status footer chrome', () => {
  assert.deepEqual(
    listTerminalTrailers([
      '• BLOCKED: GoalAgentSpec has no allowed code/static paths declared, so no Smoke Lab page file is',
      '  authorized for edits.',
      'Use /skills to list available skills',
      'gpt-5.5 high fast · ~/Projects/Ace',
      'Goal blocked (/goal resume)',
      'tokens used: 12345',
    ].join('\n')),
    [{
      kind: 'blocked',
      detail: 'GoalAgentSpec has no allowed code/static paths declared, so no Smoke Lab page file is authorized for edits.',
    }]
  );
});

test('listTerminalTrailers accepts Codex bullet trailer hard-wrapped without indentation', () => {
  assert.deepEqual(
    listTerminalTrailers([
      'final response',
      '• DONE: simple-first GoalAgent feature complete; PR https://github.com/example-org/example-project/pull/287',
      'open with evidence recorded.',
      '›▌',
    ].join('\n')),
    [{
      kind: 'done',
      detail: 'simple-first GoalAgent feature complete; PR https://github.com/example-org/example-project/pull/287 open with evidence recorded.',
    }]
  );
});

// --- ANSI-stripped raw-ring parsing (TUI repaint survival) ---------------
// A TUI renderer (claude code) repaints the screen with cursor addressing,
// so a worker's final DONE line survives only in the raw output bytes. The
// loose parser strips ANSI, drops composer/status chrome, and keeps the
// terminal-anchor safety property: substantive output after the trailer
// still refuses the parse.
const { listTerminalTrailersLoose, stripAnsi } = require('../trailers.cjs');
const ESC = '\u001b';

test('stripAnsi: removes CSI/OSC sequences and treats bare CR as a line boundary', () => {
  const raw = `${ESC}[2J${ESC}[H${ESC}]0;title\u0007line one${ESC}[31m red ${ESC}[0m\rrewritten\r\nnext`;
  const s = stripAnsi(raw);
  assert.equal(s.includes(ESC), false);
  assert.equal(s.includes('\u0007'), false);
  assert.deepEqual(s.split('\n'), ['line one red ', 'rewritten', 'next']);
});

test('listTerminalTrailersLoose: finds a DONE buried under ANSI + composer chrome', () => {
  const ring = [
    `${ESC}[1mSummary of the work${ESC}[0m`,
    'All checks passed.',
    `${ESC}[32mDONE: shipped the loop fix — https://github.com/org/repo/pull/1${ESC}[0m`,
    '╭──────────────────────────────╮',
    '│ >                            │',
    '╰──────────────────────────────╯',
    '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    '✻ Cooked for 27m 45s · 1 turn · 71.9k tokens',
    '? for shortcuts',
  ].join('\r\n');
  assert.deepEqual(listTerminalTrailersLoose(ring), [
    { kind: 'done', detail: 'shipped the loop fix — https://github.com/org/repo/pull/1' },
  ]);
});

test('listTerminalTrailersLoose: chrome interleaved inside a wrapped trailer still parses', () => {
  const ring = [
    'DONE: healed the stranded run and recorded the completion into the ledger so the',
    '│ >                            │',
    'board can advance to validation.',
    '────────────────────────────────',
  ].join('\n');
  assert.deepEqual(listTerminalTrailersLoose(ring), [
    { kind: 'done', detail: 'healed the stranded run and recorded the completion into the ledger so the board can advance to validation.' },
  ]);
});

test('listTerminalTrailersLoose: substantive output after the trailer refuses the parse', () => {
  const ring = [
    'DONE: looks finished',
    'Actually there is one more thing to investigate here.',
  ].join('\n');
  assert.deepEqual(listTerminalTrailersLoose(ring), []);
});

test('listTerminalTrailersLoose: a tool-result gutter line after the trailer is SUBSTANTIVE', () => {
  assert.deepEqual(
    listTerminalTrailersLoose('DONE: looks complete\n⎿ Error: tests are still red\n'),
    []
  );
});

test('listTerminalTrailersLoose: a composer row WITH content is substantive; only empty rows are chrome', () => {
  assert.deepEqual(
    listTerminalTrailersLoose('DONE: looks complete\n│ actually keep going with the next task │\n'),
    []
  );
  assert.deepEqual(
    listTerminalTrailersLoose('DONE: looks complete\n│ > ▌ │\n╰────╯\n'),
    [{ kind: 'done', detail: 'looks complete' }]
  );
});

test('listTerminalTrailersLoose: placeholder/shortcut-lookalike PROSE is substantive', () => {
  assert.deepEqual(
    listTerminalTrailersLoose('DONE: looks complete\nPasted text handling failed after migration.\n'),
    []
  );
  assert.deepEqual(
    listTerminalTrailersLoose('DONE: looks complete\n? for shortcuts we should add a help pane\n'),
    []
  );
  // The REAL placeholder and footer forms stay chrome.
  assert.deepEqual(
    listTerminalTrailersLoose('DONE: looks complete\n[Pasted text #1 +12 lines]\n? for shortcuts\n'),
    [{ kind: 'done', detail: 'looks complete' }]
  );
});

test('listTerminalTrailersLoose: footer-lookalike prose is substantive', () => {
  assert.deepEqual(
    listTerminalTrailersLoose('DONE: looks complete\nthe bypass permissions on flag needs esc to interrupt handling\n'),
    []
  );
});

test('listTerminalTrailersLoose: a backticked contract example mid-sentence never matches', () => {
  const ring = [
    'End with exactly one trailer: `DONE: <one-line result>` or `BLOCKED: <one-line reason>`.',
    '╭──────────────────────────────╮',
    '│ >                            │',
  ].join('\n');
  assert.deepEqual(listTerminalTrailersLoose(ring), []);
});

test('stripAnsi: unterminated OSC/DCS consume only to the next ESC — never quadratic, trailer survives', () => {
  // A crafted ring of unterminated DCS leads must strip in linear time and
  // still leave the real trailer parseable.
  const hostile = (ESC + 'Punfinished-dcs-payload ').repeat(2000) + '\nDONE: survived hostile ring\n';
  const t0 = Date.now();
  const out = stripAnsi(hostile);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 1000, `stripAnsi took ${elapsed}ms on a hostile 64KiB-class ring`);
  assert.equal(out.includes(ESC), false);
  assert.deepEqual(listTerminalTrailersLoose(hostile), [
    { kind: 'done', detail: 'survived hostile ring' },
  ]);
});

test('listTerminalTrailersLoose: BLOCKED under a status footer parses with the last occurrence winning', () => {
  const ring = [
    'BLOCKED: first attempt failed',
    'retrying with a new approach',
    `${ESC}[33mBLOCKED: missing owner token — parking the run${ESC}[0m`,
    '⏵⏵ bypass permissions on (shift+tab to cycle)',
  ].join('\n');
  assert.deepEqual(listTerminalTrailersLoose(ring), [
    { kind: 'blocked', detail: 'missing owner token — parking the run' },
  ]);
});

test('listTerminalTrailersLoose: spinner-glyph PROSE is substantive; structured status stays chrome', () => {
  assert.deepEqual(
    listTerminalTrailersLoose('DONE: looks complete\n✽ continuing work after the apparent DONE\n'),
    []
  );
  assert.deepEqual(
    listTerminalTrailersLoose('DONE: looks complete\n✽ Thinking…\n✻ Cooked for 27m 45s · 1 turn\n'),
    [{ kind: 'done', detail: 'looks complete' }]
  );
});

test('listTerminalTrailersLoose: a trailer buried under >32KiB of chrome repaints is still found', () => {
  const chrome = '✻ Cooked for 1s · 1 turn · 1k tokens\n'.repeat(1200); // ~44KiB
  const ring = 'DONE: buried but valid\n' + chrome;
  assert.deepEqual(listTerminalTrailersLoose(ring), [
    { kind: 'done', detail: 'buried but valid' },
  ]);
});
