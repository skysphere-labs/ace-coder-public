const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createScreenReader } = require('../screen-reader.cjs');
const { createStateMachine, compileProfile } = require('../state-machine.cjs');

function loadProfile(id) {
  const raw = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'profiles', `${id}.json`), 'utf8')
  );
  return compileProfile(raw);
}

function loadClaudeLegacyPromptProfile() {
  const raw = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'profiles', 'claude-code.json'), 'utf8')
  );
  raw.ready = { pattern: '(?:^|\\n)[❯>]\\s*(?:▌)?\\s*$' };
  raw.turnComplete = { pattern: '(?:^|\\n)[❯>]\\s*(?:▌)?\\s*$' };
  return compileProfile(raw);
}

function loadFixture(profileId, name) {
  return JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'fixtures', profileId, `${name}.json`), 'utf8')
  );
}

async function replay(profile, fixture) {
  const screen = createScreenReader();
  const sm = createStateMachine({ screen, emit: () => {} });
  const streamId = `test:${fixture.profile}`;
  screen.ensure(streamId);
  sm.ensure(streamId, profile);
  const transitions = [];
  for (const frame of fixture.frames) {
    if (frame.type === 'data') {
      screen.write(streamId, frame.chunk);
      await screen.flush(streamId);
      sm.evaluate(streamId);
    } else if (frame.type === 'submit') {
      sm.markSubmit(streamId);
    } else if (frame.type === 'approve') {
      sm.markApprovalAnswered(streamId);
    } else if (frame.type === 'expect-state') {
      await screen.flush(streamId);
      // Advance past the state machine's byte-activity quiet window
      // AND its MIN_TURN_DURATION_MS grace period (2500ms) so
      // turn-complete / awaiting-approval can resolve in tests. Real
      // consumers rely on the controller's trailing-eval timer; the
      // harness just reaches past the threshold directly.
      if (frame.state === 'turn-complete' || frame.state === 'awaiting-approval') {
        await new Promise((r) => setTimeout(r, 2600));
      }
      sm.evaluate(streamId);
      const got = sm.get(streamId)?.state;
      transitions.push({ expected: frame.state, got });
      assert.equal(
        got,
        frame.state,
        `${fixture.profile}: expected ${frame.state}, got ${got} at frame ${transitions.length}`
      );
    }
  }
  return transitions;
}

for (const profileId of ['claude-code', 'codex', 'gemini']) {
  test(`${profileId} basic-arc fixture`, async () => {
    const profile = loadProfile(profileId);
    const fixture = loadFixture(profileId, 'basic-arc');
    const transitions = await replay(profile, fixture);
    assert.ok(transitions.length >= 5, `expected multiple transitions, got ${transitions.length}`);
  });
}

for (const name of ['embedded-error-arc', 'fatal-banner-arc']) {
  test(`codex ${name} fixture`, async () => {
    const profile = loadProfile('codex');
    const fixture = loadFixture('codex', name);
    await replay(profile, fixture);
  });
}

test('claude-code prompt-ready fixture leaves booting with legacy ready regex', async () => {
  const profile = loadClaudeLegacyPromptProfile();
  const fixture = loadFixture('claude-code', 'prompt-ready-booting-arc');
  await replay(profile, fixture);
});

test('claude-code prompt line with interrupt footer stays booting', async () => {
  const profile = loadProfile('claude-code');
  const screen = createScreenReader();
  const sm = createStateMachine({ screen, emit: () => {} });
  const streamId = 'test:claude-interrupt-footer';
  screen.ensure(streamId);
  sm.ensure(streamId, profile);

  screen.write(
    streamId,
    [
      '✢ Thinking… (2m 15s)',
      '',
      '────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────',
      '❯  ',
      '────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────',
      '  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt',
      '',
    ].join('\r\n')
  );
  await screen.flush(streamId);
  sm.evaluate(streamId);

  assert.equal(sm.get(streamId).state, 'booting');
});

test('turn-complete requires busy seen since submit', async () => {
  const profile = loadProfile('claude-code');
  const screen = createScreenReader();
  const sm = createStateMachine({ screen, emit: () => {} });
  const streamId = 'test:no-premature-turn-complete';
  screen.ensure(streamId);
  sm.ensure(streamId, profile);

  screen.write(streamId, 'Claude Code v2\r\n\u276f \r\n');
  await screen.flush(streamId);
  sm.evaluate(streamId);
  assert.equal(sm.get(streamId).state, 'awaiting-input');

  sm.markSubmit(streamId);
  screen.write(streamId, '\u276f hi\r\n\u276f \r\n');
  await screen.flush(streamId);
  sm.evaluate(streamId);
  assert.notEqual(
    sm.get(streamId).state,
    'turn-complete',
    'ready re-rendered without any busy in between should not be turn-complete'
  );
});

test('quiet mid-turn stays busy, not idle', async () => {
  const profile = loadProfile('claude-code');
  const screen = createScreenReader();
  const sm = createStateMachine({ screen, emit: () => {} });
  const streamId = 'test:quiet-mid-turn';
  screen.ensure(streamId);
  sm.ensure(streamId, profile);

  screen.write(streamId, '\u276f \r\n');
  await screen.flush(streamId);
  sm.evaluate(streamId);
  sm.markSubmit(streamId);
  screen.write(streamId, '\u273b Thinking...\r\n');
  await screen.flush(streamId);
  sm.evaluate(streamId);
  assert.equal(sm.get(streamId).state, 'busy');

  screen.write(streamId, 'some intermediate output\r\n');
  await screen.flush(streamId);
  sm.evaluate(streamId);
  assert.equal(
    sm.get(streamId).state,
    'busy',
    'no ready and no busy marker in a quiet gap should still read as busy after submit'
  );
});

for (const profileId of ['default', 'codex', 'hermes']) {
  test(`${profileId} context length failure text is classified as error`, async () => {
    const profile = loadProfile(profileId);
    const screen = createScreenReader();
    const sm = createStateMachine({ screen, emit: () => {} });
    const streamId = `test:${profileId}:context-length-error`;
    screen.ensure(streamId);
    sm.ensure(streamId, profile);

    sm.markSubmit(streamId);
    screen.write(streamId, 'Thinking...\r\ncontext_length_exceeded: model context window exhausted\r\n');
    await screen.flush(streamId);
    sm.evaluate(streamId);

    assert.equal(sm.get(streamId).state, 'error');
  });

  test(`${profileId} observed context window overflow text is classified as error`, async () => {
    const profile = loadProfile(profileId);
    const screen = createScreenReader();
    const sm = createStateMachine({ screen, emit: () => {} });
    const streamId = `test:${profileId}:observed-context-window-error`;
    screen.ensure(streamId);
    sm.ensure(streamId, profile);

    sm.markSubmit(streamId);
    screen.write(
      streamId,
      'Thinking...\r\nYour input exceeds the context window of this model. Please adjust your input and try again.\r\n'
    );
    await screen.flush(streamId);
    sm.evaluate(streamId);

    assert.equal(sm.get(streamId).state, 'error');
  });

  test(`${profileId} ordinary context compression progress is not an error`, () => {
    const profile = loadProfile(profileId);
    assert.equal(profile._rx.error.test('compressing context for the next turn...'), false);
    assert.equal(profile._rx.error.test('Compacting conversation context...'), false);
  });
}

test('interrupted busy turn stays interrupted until fresh terminal activity', async () => {
  const profile = loadProfile('codex');
  const screen = createScreenReader();
  const sm = createStateMachine({ screen, emit: () => {} });
  const streamId = 'test:interrupted-busy';
  screen.ensure(streamId);
  sm.ensure(streamId, profile);

  screen.write(streamId, '\u203a \r\n');
  await screen.flush(streamId);
  sm.evaluate(streamId);
  assert.equal(sm.get(streamId).state, 'awaiting-input');

  sm.markSubmit(streamId);
  screen.write(streamId, 'Thinking...\r\ntokens used: 200000\r\n');
  await screen.flush(streamId);
  sm.evaluate(streamId);
  assert.equal(sm.get(streamId).state, 'busy');

  sm.markInterrupted(streamId, 'abort');
  sm.evaluate(streamId);
  assert.equal(sm.get(streamId).state, 'interrupted');

  screen.write(streamId, 'cleanup is still running\r\n');
  await screen.flush(streamId);
  sm.evaluate(streamId);
  assert.equal(sm.get(streamId).state, 'busy');
});

test('interrupted busy turn becomes awaiting-input when ready prompt repaints', async () => {
  const profile = loadProfile('codex');
  const screen = createScreenReader();
  const sm = createStateMachine({ screen, emit: () => {} });
  const streamId = 'test:interrupted-ready';
  screen.ensure(streamId);
  sm.ensure(streamId, profile);

  screen.write(streamId, '\u203a \r\n');
  await screen.flush(streamId);
  sm.evaluate(streamId);
  assert.equal(sm.get(streamId).state, 'awaiting-input');

  sm.markSubmit(streamId);
  screen.write(streamId, 'Thinking...\r\ntokens used: 200000\r\n');
  await screen.flush(streamId);
  sm.evaluate(streamId);
  assert.equal(sm.get(streamId).state, 'busy');

  sm.markInterrupted(streamId, 'abort');
  sm.evaluate(streamId);
  assert.equal(sm.get(streamId).state, 'interrupted');

  screen.write(streamId, 'Turn interrupted.\r\n\u203a \r\n');
  await screen.flush(streamId);
  sm.evaluate(streamId);
  assert.equal(sm.get(streamId).state, 'awaiting-input');
});

test('stale booting reconciles to turn-complete when Claude glyph DONE trailer is on screen', async () => {
  const profile = loadProfile('claude-code');
  const screen = createScreenReader();
  const sm = createStateMachine({ screen, emit: () => {}, settle: { minTurnMs: 40, quietMs: 40 } });
  const streamId = 'test:stale-done-trailer';
  screen.ensure(streamId);
  sm.ensure(streamId, profile);

  sm.markSubmit(streamId);
  // No ready cursor was ever observed \u2014 the stream is stuck in `booting`.
  // The worker still printed a final DONE trailer though, so the wave
  // joiner needs the state to reconcile.
  screen.write(streamId, 'thinking...\r\n⏺ DONE: shipped the thing\r\n');
  await screen.flush(streamId);
  assert.equal(sm.get(streamId).state, 'booting');

  // The reconcile is settle-gated: cross the (test-shortened) quiet window.
  await new Promise((r) => setTimeout(r, 120));
  sm.evaluate(streamId);
  assert.equal(sm.get(streamId).state, 'turn-complete');
});

test('stale busy reconciles to turn-complete when Claude glyph BLOCKED trailer is on screen', async () => {
  const profile = loadProfile('claude-code');
  const screen = createScreenReader();
  const sm = createStateMachine({ screen, emit: () => {}, settle: { minTurnMs: 40, quietMs: 40 } });
  const streamId = 'test:stale-blocked-trailer';
  screen.ensure(streamId);
  sm.ensure(streamId, profile);

  // Drive the stream into busy with an open turn.
  screen.write(streamId, '\u276f \r\n');
  await screen.flush(streamId);
  sm.evaluate(streamId);
  sm.markSubmit(streamId);
  screen.write(streamId, '\u273b Working...\r\n');
  await screen.flush(streamId);
  sm.evaluate(streamId);
  assert.equal(sm.get(streamId).state, 'busy');

  // Worker emits BLOCKED but the prompt never repaints \u2014 without
  // reconciliation we'd stay busy forever.
  screen.write(streamId, '⏺ BLOCKED: ran out of budget\r\n');
  await screen.flush(streamId);
  // The reconcile is settle-gated: cross the (test-shortened) quiet window.
  await new Promise((r) => setTimeout(r, 120));
  sm.evaluate(streamId);
  assert.equal(sm.get(streamId).state, 'turn-complete');
});

test('stale trailer reconciliation ignores prompt-contained command registry text', async () => {
  const profile = loadProfile('codex');
  const screen = createScreenReader();
  const sm = createStateMachine({ screen, emit: () => {} });
  const streamId = 'test:registry-trailer-no-reconcile';
  screen.ensure(streamId);
  sm.ensure(streamId, profile);

  sm.markSubmit(streamId);
  screen.write(
    streamId,
    'BLOCKED: trailer state back to the feature.","ipcMethod":"special:missionSync","flags":\r\n'
  );
  await screen.flush(streamId);
  sm.evaluate(streamId);

  assert.notEqual(sm.get(streamId).state, 'turn-complete');
});

test('booting reconciles to turn-complete when DONE trailer lands without submit', async () => {
  const profile = loadProfile('claude-code');
  const screen = createScreenReader();
  const sm = createStateMachine({ screen, emit: () => {}, settle: { minTurnMs: 40, quietMs: 40 } });
  const streamId = 'test:no-submit-done-trailer';
  screen.ensure(streamId);
  sm.ensure(streamId, profile);

  screen.write(streamId, 'thinking...\r\nDONE: shipped without controller submit\r\n');
  await screen.flush(streamId);
  // The reconcile is settle-gated: cross the (test-shortened) quiet window.
  await new Promise((r) => setTimeout(r, 120));
  sm.evaluate(streamId);

  assert.equal(sm.get(streamId).state, 'turn-complete');
});

test('stale booting validator screen ignores prompt examples and pending input after final DONE', async () => {
  const profile = loadProfile('claude-code');
  const screen = createScreenReader();
  const sm = createStateMachine({ screen, emit: () => {}, settle: { minTurnMs: 40, quietMs: 40 } });
  const streamId = 'test:stale-validator-done-pending-input';
  screen.ensure(streamId);
  sm.ensure(streamId, profile);

  screen.write(
    streamId,
    [
      'Claude Code v2.1.138',
      '',
      '❯ # Deliverables',
      '- PR comment with VERDICT: pass|request-changes|block and concise findings.',
      '- DONE: VERDICT=<pass|request-changes|block> on PR #192.',
      '',
      '# Escape hatch',
      '- BLOCKED: missing context',
      '',
      '⏺ Posted verdict on PR #192.',
      '',
      '  DONE: VERDICT=pass on PR #192.',
      '',
      '✻ Baked for 1m 6s',
      '',
      '────────────────────────────────────────────────────────────────────────────────',
      '❯ merge it',
      '────────────────────────────────────────────────────────────────────────────────',
    ].join('\r\n')
  );
  await screen.flush(streamId);
  assert.equal(sm.get(streamId).state, 'booting');

  // The reconcile is settle-gated: cross the (test-shortened) quiet window.
  await new Promise((r) => setTimeout(r, 120));
  sm.evaluate(streamId);
  assert.equal(sm.get(streamId).state, 'turn-complete');
});

test('previous DONE in scrollback before new submit does not terminate the new turn', async () => {
  const profile = loadProfile('claude-code');
  const screen = createScreenReader();
  const sm = createStateMachine({ screen, emit: () => {} });
  const streamId = 'test:stale-trailer-new-submit';
  screen.ensure(streamId);
  sm.ensure(streamId, profile);

  // Previous turn finished with DONE on screen.
  screen.write(streamId, '❯ \r\n');
  await screen.flush(streamId);
  sm.evaluate(streamId);
  sm.markSubmit(streamId);
  screen.write(streamId, '✻ Working...\r\nDONE: previous turn shipped\r\n❯ \r\n');
  await screen.flush(streamId);
  await new Promise((r) => setTimeout(r, 2600));
  sm.evaluate(streamId);
  assert.equal(sm.get(streamId).state, 'turn-complete');

  // New turn submitted. The previous DONE is still in scrollback and
  // the worker has not produced any output for the new turn yet — the
  // stream must NOT be reconciled to turn-complete.
  sm.markSubmit(streamId);
  sm.evaluate(streamId);
  assert.notEqual(
    sm.get(streamId).state,
    'turn-complete',
    'old DONE in scrollback must not terminate the freshly-submitted turn'
  );
});

test('historical DONE trailer in scrollback does not terminate a fresh idle stream', async () => {
  const profile = loadProfile('claude-code');
  const screen = createScreenReader();
  const sm = createStateMachine({ screen, emit: () => {} });
  const streamId = 'test:no-stale-historical-trailer';
  screen.ensure(streamId);
  sm.ensure(streamId, profile);

  // Last turn already printed DONE and the prompt has come back. The
  // state machine should land on awaiting-input, not turn-complete,
  // because no new turn is open.
  screen.write(streamId, 'DONE: previous turn\r\n\u276f \r\n');
  await screen.flush(streamId);
  sm.evaluate(streamId);
  assert.equal(sm.get(streamId).state, 'awaiting-input');
});

test('trailer surviving only in raw bytes (TUI repaint) reconciles and exposes the parsed trailer', async () => {
  const profile = loadProfile('claude-code');
  const screen = createScreenReader();
  const sm = createStateMachine({ screen, emit: () => {}, settle: { minTurnMs: 40, quietMs: 40 } });
  const streamId = 'test:tui-repaint-trailer';
  screen.ensure(streamId);
  sm.ensure(streamId, profile);

  // An open turn: the worker streams output after a submit.
  sm.markSubmit(streamId);
  screen.write(streamId, 'working on it...\r\n');
  await screen.flush(streamId);

  // The worker prints its final trailer, then the TUI repaints the screen:
  // clear + home + composer chrome. The rendered scrollback no longer ends
  // with the trailer, but the ANSI-stripped raw byte ring still holds it.
  screen.write(streamId, '\u001b[32mDONE: healed the stranded run \u2014 PR #1\u001b[0m\r\n');
  screen.write(
    streamId,
    '\u001b[2J\u001b[H\u256d\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256e\r\n\u2502 >     \u2502\r\n\u2570\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256f\r\n  \u23f5\u23f5 bypass permissions on (shift+tab to cycle)\r\n'
  );
  await screen.flush(streamId);

  // Mid-stream (bytes still active) the reconcile must NOT fire — the quiet
  // gate keeps a prompt echo or narration line from completing a turn early.
  sm.evaluate(streamId);
  assert.notEqual(sm.get(streamId).state, 'turn-complete', 'no reconcile while bytes are active');

  // Past the quiet window + post-submit grace, the raw-ring trailer wins.
  await new Promise((r) => setTimeout(r, 120));
  sm.evaluate(streamId);

  const m = sm.get(streamId);
  assert.equal(m.state, 'turn-complete');
  assert.equal(m.lastCompletionReason, 'trailer-reconciled');
  assert.deepEqual(m.lastReconciledTrailer, {
    kind: 'done',
    detail: 'healed the stranded run \u2014 PR #1',
  });

  // Emitting the completion advances the baseline: the same trailer can
  // never reconcile (or re-emit) again.
  sm.markTrailerEmitted(streamId);
  assert.equal(sm.get(streamId).lastReconciledTrailer, null);
  screen.write(streamId, '\u001b[2J\u001b[Hrepaint again\r\n');
  await screen.flush(streamId);
  await new Promise((r) => setTimeout(r, 120));
  sm.evaluate(streamId);
  assert.equal(
    sm.get(streamId).lastCompletionReason,
    null,
    'stale trailer must not re-reconcile after emit'
  );
});

test('prompt-echo trailer lines never reconcile; the worker one does', async () => {
  const profile = loadProfile('claude-code');
  const screen = createScreenReader();
  const sm = createStateMachine({ screen, emit: () => {}, settle: { minTurnMs: 40, quietMs: 40 } });
  const streamId = 'test:prompt-echo-guard';
  screen.ensure(streamId);
  sm.ensure(streamId, profile);

  const prompt = [
    'Do the task.',
    'End with exactly one trailer, for example:',
    'DONE: <one-line result>',
    'BLOCKED: cannot proceed',
  ].join('\n');
  sm.markSubmit(streamId, prompt);
  // The pty ECHOES the submitted prompt — including its literal trailer lines.
  screen.write(streamId, prompt.replace(/\n/g, '\r\n') + '\r\n');
  await screen.flush(streamId);
  await new Promise((r) => setTimeout(r, 120));
  sm.evaluate(streamId);
  assert.notEqual(
    sm.get(streamId).state,
    'turn-complete',
    'echoed prompt trailers must not complete the turn'
  );

  // The worker's REAL trailer (different detail) reconciles normally.
  screen.write(streamId, 'working...\r\nDONE: actually shipped the task\r\n');
  await screen.flush(streamId);
  await new Promise((r) => setTimeout(r, 120));
  sm.evaluate(streamId);
  const m = sm.get(streamId);
  assert.equal(m.state, 'turn-complete');
  assert.deepEqual(m.lastReconciledTrailer, { kind: 'done', detail: 'actually shipped the task' });
});

test('trailer + ready-prompt repaint arriving together still exposes the pending raw trailer', async () => {
  const profile = loadProfile('claude-code');
  const screen = createScreenReader();
  const sm = createStateMachine({ screen, emit: () => {}, settle: { minTurnMs: 40, quietMs: 40 } });
  const streamId = 'test:trailer-plus-ready-repaint';
  screen.ensure(streamId);
  sm.ensure(streamId, profile);

  sm.markSubmit(streamId, 'do the work');
  screen.write(streamId, 'working...\r\n');
  await screen.flush(streamId);
  sm.evaluate(streamId); // busy — leaves booting without losing the pending trailer
  screen.write(streamId, 'DONE: finished with a repaint\r\n\u276f \r\n');
  await screen.flush(streamId);
  sm.evaluate(streamId); // early tick — settle window not yet crossed
  assert.equal(sm.hasPendingRawTrailer(streamId), true, 'probe sees the unconsumed trailer');
  await new Promise((r) => setTimeout(r, 120));
  sm.evaluate(streamId);
  const m = sm.get(streamId);
  assert.equal(m.state, 'turn-complete');
  assert.equal(m.lastCompletionReason, 'trailer-reconciled');
  assert.equal(sm.hasPendingRawTrailer(streamId), true, 'still pending until the observer emits');
  sm.markTrailerEmitted(streamId);
  assert.equal(sm.hasPendingRawTrailer(streamId), false, 'consumed after emit');
});

test('a consumed trailer cannot re-reconcile after partial ring rollover of idle chrome', async () => {
  const profile = loadProfile('claude-code');
  const screen = createScreenReader();
  const sm = createStateMachine({ screen, emit: () => {}, settle: { minTurnMs: 40, quietMs: 40 } });
  const streamId = 'test:ring-rollover-consumed';
  screen.ensure(streamId);
  sm.ensure(streamId, profile);

  sm.markSubmit(streamId, 'do the work');
  screen.write(streamId, 'working...\r\n');
  await screen.flush(streamId);
  sm.evaluate(streamId);
  screen.write(streamId, 'DONE: consumed once\r\n');
  await screen.flush(streamId);
  await new Promise((r) => setTimeout(r, 120));
  sm.evaluate(streamId);
  assert.equal(sm.get(streamId).state, 'turn-complete');
  sm.markTrailerEmitted(streamId);

  // ~40 KiB of idle chrome repaints: the 64 KiB ring truncates from the
  // front, the baseline stops being a prefix, but the consumed trailer is
  // STILL inside the ring. It must not reconcile again.
  const chrome = '✻ Cooked for 1s · 1 turn · 1k tokens\r\n';
  for (let i = 0; i < 1100; i += 1) screen.write(streamId, chrome);
  await screen.flush(streamId);
  await new Promise((r) => setTimeout(r, 120));
  sm.evaluate(streamId);
  assert.equal(
    sm.get(streamId).lastCompletionReason,
    null,
    'rolled-over ring must not resurrect the consumed trailer'
  );
});

test('a worker legitimately outputting the exact prompt trailer BEYOND the echo region completes', async () => {
  const profile = loadProfile('claude-code');
  const screen = createScreenReader();
  const sm = createStateMachine({ screen, emit: () => {}, settle: { minTurnMs: 40, quietMs: 40 } });
  const streamId = 'test:verbatim-after-echo-window';
  screen.ensure(streamId);
  sm.ensure(streamId, profile);

  const prompt = 'Reply with exactly:\nDONE: ok';
  sm.markSubmit(streamId, prompt);
  // Enough worker output to leave the bounded echo region, then the exact
  // requested trailer — this is worker output, not echo.
  screen.write(streamId, ('narrating progress on the task at hand\r\n').repeat(200));
  screen.write(streamId, 'DONE: ok\r\n');
  await screen.flush(streamId);
  await new Promise((r) => setTimeout(r, 120));
  sm.evaluate(streamId);
  const m = sm.get(streamId);
  assert.equal(m.state, 'turn-complete');
  assert.deepEqual(m.lastReconciledTrailer, { kind: 'done', detail: 'ok' });
});

test('an IMMEDIATE verbatim reply (echo + worker copy inside the echo window) completes', async () => {
  const profile = loadProfile('claude-code');
  const screen = createScreenReader();
  const sm = createStateMachine({ screen, emit: () => {}, settle: { minTurnMs: 40, quietMs: 40 } });
  const streamId = 'test:immediate-verbatim-reply';
  screen.ensure(streamId);
  sm.ensure(streamId, profile);

  const prompt = 'Reply with exactly:\nDONE: ok';
  sm.markSubmit(streamId, prompt);
  // The pty echoes the prompt's trailer line once, then the worker replies
  // with the same text immediately — two occurrences of a one-occurrence
  // prompt line: the second is worker output.
  screen.write(streamId, 'DONE: ok\r\n');
  screen.write(streamId, 'DONE: ok\r\n');
  await screen.flush(streamId);
  await new Promise((r) => setTimeout(r, 120));
  sm.evaluate(streamId);
  const m = sm.get(streamId);
  assert.equal(m.state, 'turn-complete');
  assert.deepEqual(m.lastReconciledTrailer, { kind: 'done', detail: 'ok' });
});
