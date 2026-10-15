import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const schemaDir = path.join(repoRoot, 'docs', 'harness', 'schemas');

function readSchema(name) {
  return JSON.parse(fs.readFileSync(path.join(schemaDir, name), 'utf8'));
}

function expectRequired(schema, value) {
  for (const field of schema.required || []) {
    expect(value[field], `${schema.title}.${field} exists`).not.toBeUndefined();
  }
  for (const [field, spec] of Object.entries(schema.properties || {})) {
    if (value[field] === undefined) continue;
    if (spec.const !== undefined) expect(value[field], `${schema.title}.${field} const`).toBe(spec.const);
    if (spec.enum) expect(spec.enum, `${schema.title}.${field} enum includes value`).toContain(value[field]);
  }
}

const taskSpec = {
  schema: 'ace.task_spec.v1',
  taskId: 'tsk_harness',
  title: 'Create harness scaffold',
  goal: 'Create project harness files.',
  taskType: 'feature-impl',
  context: 'First harness wave.',
  constraints: ['Keep changes scoped.'],
  deliverables: ['.ace-template/'],
  acceptance: ['template files exist'],
  preferredAgent: 'codex',
  goalMode: 'auto',
  requireChanges: 'auto',
  maxRounds: 3,
  maxVerifyRounds: 2,
  verifier: 'ace task validate',
};

const memoryCandidate = {
  schema: 'ace.memory_candidate.v1',
  sourceRunId: 'run_1',
  category: 'lesson',
  claim: 'Workers should read FEATURES.json before editing.',
  evidence: 'Goal protocol read order.',
  confidence: 0.8,
  promoteToWiki: true,
};

test('harness schema files exist and declare stable ids', () => {
  const names = [
    'task-spec.schema.json',
    'handoff-envelope.schema.json',
    'trace-event.schema.json',
    'guardrail.schema.json',
    'agent-manifest.schema.json',
    'completion-result.schema.json',
    'feature-check.schema.json',
    'memory-candidate.schema.json',
    'event-trigger.schema.json',
  ];
  for (const name of names) {
    const schema = readSchema(name);
    expect(schema.$schema).toMatch(/json-schema.org/);
    expect(schema.$id).toMatch(new RegExp(name.replace('.', '\\.')));
    expect(schema.title).toBeTruthy();
  }
});

test('TaskSpec, HandoffEnvelope, TraceEvent, Guardrail, and AgentManifest examples match schema constants', () => {
  expectRequired(readSchema('task-spec.schema.json'), taskSpec);
  expectRequired(readSchema('handoff-envelope.schema.json'), {
    schema: 'ace.handoff_envelope.v1',
    handoffId: 'hof_1',
    parentHandoffId: null,
    source: { agent: 'hermes', streamId: 'conversation:orch', role: 'orchestrator' },
    target: { agent: 'codex', streamId: null, role: 'builder' },
    workspaceId: 'prj_1',
    runId: 'run_1',
    spec: taskSpec,
    contextRefs: [{ kind: 'file', ref: 'AGENTS.md', purpose: 'read-first' }],
    trailerContract: { done: 'DONE:', blocked: 'BLOCKED:' },
    budget: { maxRounds: 3, maxVerifyRounds: 2, perTurnTimeoutMs: 300000 },
    createdAt: '2026-05-16T00:00:00.000Z',
  });
  expectRequired(readSchema('trace-event.schema.json'), {
    schema: 'ace.trace_event.v1',
    eventId: 'evt_1',
    handoffId: 'hof_1',
    seq: 1,
    parentEventId: null,
    streamId: 'conversation:worker',
    agent: 'codex',
    type: 'done',
    at: '2026-05-16T00:01:00.000Z',
    payload: { trailer: 'DONE: harness scaffold' },
  });
  expectRequired(readSchema('guardrail.schema.json'), {
    schema: 'ace.guardrail.v1',
    id: 'require-output-contract',
    appliesTo: 'output',
    match: {},
    decision: 'fixback',
    message: 'Worker must produce completion.json and DONE/BLOCKED trailer.',
  });
  expectRequired(readSchema('agent-manifest.schema.json'), {
    schema: 'ace.agent_manifest.v1',
    id: 'hermes_wiki_curator',
    role: 'wiki-curator',
    provider: 'hermes',
    purpose: 'Review suggested wiki deltas and update wiki pages.',
  });
});

test('CompletionResult, FeatureCheck, MemoryCandidate, and EventTrigger examples match schema constants', () => {
  expectRequired(readSchema('completion-result.schema.json'), {
    schema: 'ace.completion_result.v1',
    runId: 'run_1',
    taskId: 'tsk_harness',
    handoffId: 'hof_1',
    outcome: 'done',
    summary: 'Created harness files.',
    filesChanged: ['.ace-template/FEATURES.json'],
    commits: [],
    testsRun: [{ command: 'npm run lint', status: 'pass' }],
    acceptanceEvidence: [{ criterion: 'template files exist', status: 'pass', evidence: 'project scaffold test' }],
    risks: [],
    memoryCandidates: [memoryCandidate],
  });
  expectRequired(readSchema('feature-check.schema.json'), {
    id: 'project.harness.initialized',
    wave: 0,
    category: 'harness',
    priority: 1,
    description: 'Harness files exist.',
    steps: ['Run init.sh'],
    passes: false,
  });
  expectRequired(readSchema('memory-candidate.schema.json'), memoryCandidate);
  expectRequired(readSchema('event-trigger.schema.json'), {
    schema: 'ace.event_trigger.v1',
    id: 'legacy-disabled-worker-done-evaluation',
    listensTo: 'worker.completion.detected',
    condition: "payload.kind == 'DONE'",
    action: 'spawn_task',
    payload: { taskType: 'evaluation' },
    enabled: false,
  });
});
