// Asserts that the v3.1 validator-gate policy strings live in the bundled
// ace-github-flow SKILL.md so the doctrine survives compaction and
// restart inside delegated children.
//
// The skill body is the durable contract; this test pins it.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

import skillsCatalog from '../skills-catalog.json';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const entry = skillsCatalog.skills.find((skill) => skill.id === 'ace-github-flow');
if (!entry) throw new Error('ace-github-flow catalog entry missing');
const bundledPath = path.join(__dirname, '..', entry.bundledPath);
const body = fs.readFileSync(bundledPath, 'utf8');

test('ace-github-flow skill exists in the bundled catalog', () => {
  expect(entry.provenance).toBe('bundled');
  expect(fs.existsSync(bundledPath)).toBe(true);
});

test('skill documents Ace integration-gate merge authority', () => {
  expect(body).toMatch(/Merge and cleanup are Ace integration-gate actions/i);
  expect(body).toMatch(/Do not hand-type raw `git push` or\s+`gh pr merge`/i);
  expect(body).toMatch(/"role":\s*"viewer"/);
  expect(body).toMatch(/"roleMode":\s*"reviewer"/);
  expect(body).toMatch(/"taskType":\s*"validator-merger"/);
});

test('skill documents PASS-no-caveats Rule', () => {
  expect(body).toMatch(/##\s+PASS-no-caveats Rule/);
  expect(body).toMatch(/no\s+`?pass-with-caveats`?/i);
  expect(body).toMatch(/binary/i);
});

test('skill documents Codex/GPT-5.5-default validator-merger family routing (v3.1)', () => {
  expect(body).toMatch(/##\s+Default validator-merger family:\s+Codex\/GPT-5\.5/);
  expect(body).toMatch(/Codex\/GPT-5\.5 is the\s+default validator-merger family/i);
  expect(body).toMatch(/Claude is reserved\s+\*\*ONLY for ambiguous UI\/product validation/);
  expect(body).not.toMatch(/##\s+Default validator-merger family:\s+Claude\b/);
});

test('skill documents the ValidationFailurePacket rally-protocol schema', () => {
  expect(body).toMatch(/ValidationFailurePacket/);
  expect(body).toMatch(/"verdict":\s*"request-changes"\s*\|\s*"block"/);
  expect(body).toMatch(/"findings":\s*\[/);
  expect(body).toMatch(/"rerunGate":\s*true/);
});

test('Merge-trigger ownership routes PASS through the scoped integration gate', () => {
  expect(body).toMatch(/Emit a merge-ready packet or call the scoped Ace integration gate/i);
  expect(body).toMatch(/Use `integrate: \{ merge: true \}` or\s+`ace integrate pr-merge`/i);
});
