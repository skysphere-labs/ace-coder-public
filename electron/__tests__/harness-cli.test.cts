import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const cliEntry = path.join(repoRoot, 'tools', 'ace', 'src', 'index.cts');
const nodeWithTsx = ['--require', require.resolve('tsx/cjs'), cliEntry];

function run(args, opts = {}) {
  const result = spawnSync('node', [...nodeWithTsx, '--json', ...args], {
    cwd: opts.cwd || repoRoot,
    env: { ...process.env, ACE_SOCK: '/tmp/ace-harness-cli-test.sock', ...(opts.env || {}) },
    encoding: 'utf8',
  });
  const text = result.stdout.trim() || result.stderr.trim();
  const line = text.split(/\r?\n/).at(-1);
  return { result, envelope: line ? JSON.parse(line) : null };
}

test('ace project harness commands operate on .ace files', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-harness-cli-'));
  try {
    let out = run(['project', 'init-harness', '--project', 'kova', '--project-dir', tmp]);
    expect(out.result.status).toBe(0);
    expect(out.envelope.ok).toBe(true);
    expect(fs.existsSync(path.join(tmp, '.ace', 'FEATURES.json'))).toBe(true);

    out = run(['feature', 'list', '--project-dir', tmp]);
    expect(out.envelope.data.features[0].passes).toBe(false);

    out = run(['wave', 'list', '--project-dir', tmp]);
    expect(out.envelope.data.text).toContain('Project harness');

    out = run([
      'feature',
      'mark',
      '--project-dir',
      tmp,
      '--id',
      'project.harness.initialized',
      '--pass',
      '--role',
      'evaluator',
      '--evidence',
      'run_1',
      '--run',
      'run_1',
    ]);
    expect(out.result.status).toBe(0);
    expect(out.envelope.data.feature.passes).toBe(true);
    expect(out.envelope.data.actions[0].action).toBe('notify_human');
    expect(out.envelope.data.actions[0].payload.owner).toBe('hermes');

    const runDir = path.join(tmp, '.ace', 'run', 'run_1');
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(
      path.join(runDir, 'completion.json'),
      JSON.stringify(
        {
          schema: 'ace.completion_result.v1',
          runId: 'run_1',
          taskId: 'tsk_1',
          handoffId: 'hof_1',
          outcome: 'done',
          summary: 'Initialized harness.',
          filesChanged: ['.ace/FEATURES.json'],
          commits: [],
          testsRun: [{ command: 'feature list', status: 'pass' }],
          acceptanceEvidence: [{ criterion: 'feature list works', status: 'pass', evidence: 'test' }],
          risks: [],
          memoryCandidates: [
            {
              schema: 'ace.memory_candidate.v1',
              sourceRunId: 'run_1',
              category: 'lesson',
              claim: 'Harness CLI commands work.',
              evidence: 'harness-cli test',
              confidence: 0.9,
              promoteToWiki: true,
            },
          ],
        },
        null,
        2
      )
    );

    out = run(['task', 'result', '--project-dir', tmp, '--run', 'run_1']);
    expect(out.envelope.data.valid).toBe(true);

    out = run(['task', 'validate', '--project-dir', tmp, '--run', 'run_1', '--feature', 'project.harness.initialized']);
    expect(out.result.status).toBe(0);
    expect(out.envelope.data.verdict).toBe('pass');
    expect(out.envelope.data.actions.some((action) => action.action === 'notify_human')).toBe(true);
    expect(fs.existsSync(path.join(runDir, 'validation.json'))).toBe(true);

    out = run(['run', 'list', '--project-dir', tmp]);
    expect(out.envelope.data.runs).toMatchObject([{ runId: 'run_1', valid: true, outcome: 'done' }]);

    out = run(['memory', 'candidates', '--project-dir', tmp]);
    expect(out.envelope.data.candidates).toHaveLength(1);

    out = run([
      'wiki',
      'update',
      '--project-dir',
      tmp,
      '--page',
      'lessons.md',
      '--append',
      '--text=Harness CLI commands work.',
    ]);
    expect(out.envelope.data.appended).toBe(true);
    expect(fs.readFileSync(path.join(tmp, '.ace', 'wiki', 'lessons.md'), 'utf8')).toContain('Harness CLI');

    out = run([
      'event',
      'emit',
      'worker.completion.detected',
      '--project-dir',
      tmp,
      '--payload',
      '{"kind":"DONE"}',
    ]);
    expect(out.envelope.data.event.event).toBe('worker.completion.detected');
    expect(out.envelope.data.actions).toHaveLength(0);
    expect(fs.existsSync(path.join(tmp, '.ace', 'events.ndjson'))).toBe(true);

    out = run(['event', 'emit', 'feature.failed', '--project-dir', tmp, '--payload', '{"id":"project.harness.initialized"}']);
    expect(out.envelope.data.actions).toHaveLength(0);
    expect(fs.existsSync(path.join(tmp, '.ace', 'run', 'fixbacks.ndjson'))).toBe(false);

    out = run(['event', 'emit', 'feature.passed', '--project-dir', tmp, '--payload', '{"id":"project.harness.initialized"}']);
    expect(out.envelope.data.actions[0].action).toBe('notify_human');
    expect(out.envelope.data.actions[0].payload.owner).toBe('hermes');
    expect(fs.existsSync(path.join(tmp, '.ace', 'events.actions.ndjson'))).toBe(true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('feature mark rejects pass updates from non-evaluator roles', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-harness-cli-'));
  try {
    expect(run(['project', 'init-harness', '--project', 'kova', '--project-dir', tmp]).result.status).toBe(0);
    const out = run([
      'feature',
      'mark',
      '--project-dir',
      tmp,
      '--id',
      'project.harness.initialized',
      '--pass',
      '--role',
      'builder',
      '--evidence',
      'builder claim',
    ]);
    expect(out.result.status).toBe(2);
    expect(out.envelope.error).toBe('role_forbidden');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('task validate emits fixback trigger for invalid completion results', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-harness-cli-'));
  try {
    expect(run(['project', 'init-harness', '--project', 'kova', '--project-dir', tmp]).result.status).toBe(0);
    const runDir = path.join(tmp, '.ace', 'run', 'run_bad');
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(
      path.join(runDir, 'completion.json'),
      JSON.stringify(
        {
          schema: 'ace.completion_result.v1',
          runId: 'run_bad',
          taskId: 'tsk_bad',
          handoffId: 'hof_bad',
          outcome: 'done',
          summary: 'Claimed completion without evidence.',
          filesChanged: ['src/app.ts'],
          commits: [],
          testsRun: [{ command: 'npm test', status: 'not-run' }],
          acceptanceEvidence: [],
          risks: [],
          memoryCandidates: [],
        },
        null,
        2
      )
    );

    const out = run([
      'task',
      'validate',
      '--project-dir',
      tmp,
      '--run',
      'run_bad',
      '--feature',
      'project.harness.initialized',
    ]);
    expect(out.result.status).toBe(0);
    expect(out.envelope.data.verdict).toBe('fail');
    expect(out.envelope.data.errors).toContain('acceptanceEvidence must contain at least one item');
    expect(out.envelope.data.actions.some((action) => action.action === 'send_fixback')).toBe(false);
    expect(fs.existsSync(path.join(tmp, '.ace', 'run', 'fixbacks.ndjson'))).toBe(false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('ace <group> and ace <group> --help print group help instead of unknown_command', () => {
  let out = run(['run']);
  expect(out.result.status).toBe(0);
  expect(out.envelope.ok).toBe(true);
  expect(out.envelope.data.group).toBe('run');
  expect(out.envelope.data.commands.map((c) => c.cli)).toContain('run submit');

  out = run(['loop', '--help']);
  expect(out.result.status).toBe(0);
  expect(out.envelope.data.group).toBe('loop');

  // A true unknown command still fails loudly with exit 6.
  out = run(['definitely-not-a-command']);
  expect(out.result.status).toBe(6);
  expect(out.envelope.error).toBe('unknown_command');

  // Group help never masks an INVALID subcommand: extra tokens = exit 6,
  // with the group's real commands named in the error.
  out = run(['run', 'typo']);
  expect(out.result.status).toBe(6);
  expect(out.envelope.error).toBe('unknown_command');
  expect(out.envelope.message).toContain('run submit');
});

test('ace run submit fails fast at the parser when --acceptance is missing', () => {
  const out = run(['run', 'submit', '--goal', 'g', '--workspace', 'prj_x']);
  expect(out.result.status).toBe(2);
  expect(out.envelope.error).toBe('missing_arg');
  expect(out.envelope.details.flag).toBe('--acceptance');
});

test('ace run submit warns on stderr when --owner-token is dropped under --auto-iterate', () => {
  // The socket is dead in tests, so the invoke fails AFTER param shaping —
  // the warning must already be on stderr by then.
  const out = run([
    'run', 'submit', '--goal', 'g', '--workspace', 'prj_x',
    '--acceptance', 'ok', '--owner-token', 'tok', '--auto-iterate',
  ]);
  expect(out.result.stderr).toContain('--owner-token is ignored with --auto-iterate');
});
