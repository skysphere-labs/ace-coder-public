import { describe, expect, it } from 'vitest';
import type { AgentLane } from './agent-lanes';
import type { StreamEntry } from './ace-api';
import {
  ACTIVE_AGENT_LANE_STORAGE_KEY,
  joinLanesWithStreams,
  laneProviderLabel,
  streamStateTone,
  workspaceLabelFromCwd,
} from './agent-control';

function lane(overrides: Partial<AgentLane> = {}): AgentLane {
  return {
    id: 'lane-alpha',
    label: 'Alpha',
    agent: 'hermes',
    providerKind: 'builtin-personal',
    profileId: null,
    profileHome: null,
    projectId: 'prj-1',
    taskId: 'task-1',
    mainConversationId: null,
    sortOrder: 0,
    autoStart: true,
    isBuiltin: true,
    metadata: null,
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
}

function stream(overrides: Partial<StreamEntry> = {}): StreamEntry {
  return {
    streamId: 'st-1',
    agent: 'hermes',
    cwd: '/work/projects/alpha-workspace',
    label: 'Alpha',
    state: 'idle',
    profile: 'hermes',
    taskId: 'task-1',
    workspaceId: 'prj-1',
    live: true,
    ...overrides,
  };
}

describe('agent-control helpers', () => {
  it('keeps the storage key in lockstep with the Agents screen slot', () => {
    expect(ACTIVE_AGENT_LANE_STORAGE_KEY).toBe('ace:agents-active-lane-v1');
  });

  it('workspaceLabelFromCwd keeps only the last path segment', () => {
    expect(workspaceLabelFromCwd('/work/projects/alpha-workspace')).toBe('alpha-workspace');
    expect(workspaceLabelFromCwd('C:\\work\\beta')).toBe('beta');
    expect(workspaceLabelFromCwd('  ')).toBe(null);
    expect(workspaceLabelFromCwd(null)).toBe(null);
  });

  it('laneProviderLabel mirrors the Agents screen wording', () => {
    expect(laneProviderLabel(lane())).toBe('personal');
    expect(
      laneProviderLabel(lane({ providerKind: 'hermes-profile', profileId: 'beta' }))
    ).toBe('beta');
    expect(laneProviderLabel(lane({ providerKind: 'native-orchestrator' }))).toBe('native');
  });

  it('joins lanes to streams by taskId, preferring live over dormant', () => {
    const lanes = [lane(), lane({ id: 'lane-beta', label: 'Beta', taskId: 'task-2' })];
    const streams = [
      stream({ streamId: 'st-dormant', state: 'dormant', live: false }),
      stream({ streamId: 'st-live', state: 'busy', live: true }),
      stream({ streamId: 'st-other', taskId: 'task-999' }),
    ];
    const rows = joinLanesWithStreams(lanes, streams);
    expect(rows).toHaveLength(2);
    expect(rows[0].stream?.streamId).toBe('st-live');
    expect(rows[0].streamState).toBe('busy');
    expect(rows[0].live).toBe(true);
    expect(rows[0].workspace).toBe('alpha-workspace');
    // Lane without any stream row is read-only status: 'untracked', no stream.
    expect(rows[1].stream).toBe(null);
    expect(rows[1].streamState).toBe('untracked');
    expect(rows[1].live).toBe(false);
  });

  it('streamStateTone stays on the shared chip scale', () => {
    expect(streamStateTone('busy')).toBe('sky');
    expect(streamStateTone('idle')).toBe('emerald');
    expect(streamStateTone('error')).toBe('rose');
    expect(streamStateTone('interrupted')).toBe('amber');
    expect(streamStateTone('untracked')).toBe('neutral');
    expect(streamStateTone('dormant')).toBe('neutral');
  });
});
