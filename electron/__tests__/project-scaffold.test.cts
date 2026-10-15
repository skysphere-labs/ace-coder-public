import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const templateDir = path.join(repoRoot, '.ace-template');

const templateFiles = [
  'PROJECT_BRIEF.md',
  'ARCHITECTURE_RULES.md',
  'FEATURES.json',
  'WAVE_PLAN.yaml',
  'PROGRESS.md',
  'DECISIONS.md',
  'OPEN_QUESTIONS.md',
  'WIKI_INDEX.md',
  'WORKFLOW.md',
  'AGENT_ROSTER.json',
  'EVENT_TRIGGERS.json',
  'init.sh',
];

test('project harness template contains required files and parseable JSON', () => {
  for (const file of templateFiles) {
    expect(fs.existsSync(path.join(templateDir, file)), `${file} exists`).toBe(true);
  }
  const features = JSON.parse(fs.readFileSync(path.join(templateDir, 'FEATURES.json'), 'utf8'));
  expect(Array.isArray(features)).toBe(true);
  expect(features.length).toBeGreaterThan(0);
  expect(features.every((feature) => feature.passes === false)).toBe(true);
  const agents = JSON.parse(fs.readFileSync(path.join(templateDir, 'AGENT_ROSTER.json'), 'utf8'));
  expect(agents.some((agent) => agent.id === 'hermes_wiki_curator')).toBe(true);
  const triggers = JSON.parse(fs.readFileSync(path.join(templateDir, 'EVENT_TRIGGERS.json'), 'utf8'));
  expect(triggers.map((trigger) => trigger.id)).toContain('legacy-disabled-worker-done-evaluation');
  expect(triggers.find((trigger) => trigger.id === 'legacy-disabled-worker-done-evaluation')?.enabled).toBe(false);
  expect(triggers.find((trigger) => trigger.id === 'on-feature-pass-request-hermes-wiki-review')?.action).toBe('notify_human');
});

test('init-ace-project-harness copies template into a new project', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-project-harness-'));
  try {
    execFileSync(path.join(repoRoot, 'scripts', 'init-ace-project-harness.sh'), ['--project', 'kova'], {
      cwd: tmp,
      stdio: 'pipe',
    });
    for (const file of templateFiles) {
      expect(fs.existsSync(path.join(tmp, '.ace', file)), `${file} copied`).toBe(true);
    }
    for (const dir of ['run', 'memory', 'wiki']) {
      expect(fs.statSync(path.join(tmp, '.ace', dir)).isDirectory(), `${dir} exists`).toBe(true);
    }
    const brief = fs.readFileSync(path.join(tmp, '.ace', 'PROJECT_BRIEF.md'), 'utf8');
    expect(brief).toContain('Name: kova');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
