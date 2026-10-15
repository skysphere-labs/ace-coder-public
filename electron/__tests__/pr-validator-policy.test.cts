import { expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(__dirname, '..', '..');

test('Reviewbot gate@main is the only AI review lane', () => {
  const workflow = fs.readFileSync(
    path.join(repoRoot, '.github', 'workflows', 'reviewbot-gate.yml'),
    'utf8'
  );

  expect(fs.existsSync(path.join(repoRoot, '.github', 'workflows', 'pr-validator.yml'))).toBe(
    false
  );
  expect(fs.existsSync(path.join(repoRoot, 'scripts', 'pr-validator-review.sh'))).toBe(false);

  expect(workflow).toContain('uses: skysphere-labs/reviewbot/gate@main');
  expect(workflow).toContain('name: AI review gate');
  expect(workflow).toContain("reasoning_effort: 'high'");
  expect(workflow).toContain("codex_timeout_s: '900'");
  expect(workflow).toContain('timeout-minutes: 25');
  expect(workflow).toContain('contents: write');
});

test('the owner-intent register the reviewer reads from the base ref exists', () => {
  const intent = fs.readFileSync(
    path.join(repoRoot, 'docs', 'review', 'OWNER-INTENT.md'),
    'utf8'
  );
  expect(intent).toMatch(/\(ACCEPTED\)/);
  expect(intent).toMatch(/\(INVARIANT\)/);
});
