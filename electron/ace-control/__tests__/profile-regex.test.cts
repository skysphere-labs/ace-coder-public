// Profile-regex regressions for the patterns the state machine matches
// against viewport text to leave `booting` and to detect turn-complete.
//
// These guard against a real shipped bug: Claude Code 2.x renders its prompt
// as `❯ Try "fix lint errors"` (placeholder hint visible) inside a rounded
// box (`│ ❯ ... │`). The original `[❯>]\s*(?:▌)?\s*$` pattern only matched
// an empty prompt line, so a Claude pane stayed stuck in `booting` and
// `task run` waited forever for a ready event that never fired. The
// loosened pattern accepts any line whose first non-box character is the
// prompt chevron, regardless of trailing placeholder/cursor content.

import { expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function loadProfile(id) {
  const raw = readFileSync(
    join(process.cwd(), 'electron/ace-control/profiles', `${id}.json`),
    'utf8'
  );
  return JSON.parse(raw);
}

function loadTestFixture(profileId, name) {
  return readFileSync(
    join(process.cwd(), 'electron/ace-control/__tests__/fixtures', profileId, name),
    'utf8'
  );
}

function compile(spec) {
  return new RegExp(spec.pattern, 'm');
}

const claude = loadProfile('claude-code');
const claudeReady = compile(claude.ready);
const claudeTurnComplete = compile(claude.turnComplete);
const codex = loadProfile('codex');
const codexReady = compile(codex.ready);
const hermes = loadProfile('hermes');
const hermesReady = compile(hermes.ready);

test('claude ready matches empty prompt', () => {
  expect(claudeReady.test('\n❯ ')).toBe(true);
  expect(claudeReady.test('\n❯')).toBe(true);
  expect(claudeReady.test('\n❯ ▌')).toBe(true);
});

test('claude ready matches prompt with placeholder text', () => {
  // The shipped regression: visible prompt with placeholder hint.
  const screen = [
    '──────────────────────',
    '',
    '❯ Try "fix lint errors"',
    '',
  ].join('\n');
  expect(claudeReady.test(screen)).toBe(true);
});

test('claude ready matches live placeholder prompt with non-breaking space', () => {
  const screen = [
    '────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────',
    '❯ Try "create a util logging.py that..."',
    '────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────',
    '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
  ].join('\n');
  expect(claudeReady.test(screen)).toBe(true);
});

test('claude ready matches live placeholder prompt with cursor before Try', () => {
  const screen = [
    '────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────',
    '❯ ▌Try "how do I log an error?"',
    '────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────',
    '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents',
  ].join('\n');
  expect(claudeReady.test(screen)).toBe(true);
});

test('claude ready matches box-drawn prompt with placeholder', () => {
  // Claude Code renders its composer inside a rounded box.
  const screen = [
    '╭──────────────────────────────────────╮',
    '│ ❯ Try "fix lint errors"              │',
    '╰──────────────────────────────────────╯',
  ].join('\n');
  expect(claudeReady.test(screen)).toBe(true);
});

test('claude turnComplete matches the same prompt shapes', () => {
  expect(claudeTurnComplete.test('\n❯ ')).toBe(true);
  expect(claudeTurnComplete.test('\n│ ❯ Try "fix lint errors"   │')).toBe(true);
});

test('claude ready matches post-DONE prompt repaint fixture', () => {
  expect(claudeReady.test(loadTestFixture('claude-code', 'done-prompt-repaint.txt'))).toBe(true);
});

test('codex ready matches post-DONE prompt repaint fixture', () => {
  expect(codexReady.test(loadTestFixture('codex', 'done-prompt-repaint.txt'))).toBe(true);
});

test('claude ready does NOT match agent thinking lines', () => {
  // While Claude is busy, no chevron appears on a fresh line — only
  // spinner glyphs and `…ing`. The ready regex must stay quiet.
  expect(claudeReady.test('\n✻ Thinking...')).toBe(false);
  expect(claudeReady.test('\n  Working on it…')).toBe(false);
});

test('claude ready does NOT match resume menu selection rows', () => {
  expect(claudeReady.test('\n❯ /resume\nResume Session')).toBe(false);
  expect(claudeReady.test('\n  ❯ recreate-jewelry-blender-meshy\n  16 seconds ago')).toBe(false);
});

test('hermes ready still matches its bare prompt (no regression)', () => {
  // Hermes profile was not changed; the bare `❯` plus cursor variants
  // must keep matching.
  expect(hermesReady.test('\n❯ ')).toBe(true);
  expect(hermesReady.test('\n❯')).toBe(true);
  expect(hermesReady.test('\n❯ ▌')).toBe(true);
});
