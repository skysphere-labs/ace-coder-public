import { describe, expect, it } from 'vitest';
import type { AgentLane } from './agent-lanes';
import { chooseActiveAgentLane, sortAgentLanes } from './agent-lanes';

// NOTE: the source-string snapshot suites that asserted on the Mission Board UI
// (MissionBoardPanel + mission-board/* + the OpsTab board mount) were removed in
// the run-ledger spine cutover, which deleted that UI. The pure agent-lane
// ordering/selection helpers below are non-mission and survive unchanged.

describe('agent lane renderer helpers', () => {
  const lanes: AgentLane[] = [
    {
      id: 'lane-vector',
      label: 'Vector',
      agent: 'hermes',
      providerKind: 'hermes-profile',
      profileId: 'vector',
      profileHome: '/tmp/.hermes/profiles/vector',
      projectId: 'prj-vector',
      taskId: 'thr-vector',
      mainConversationId: 'conv-vector',
      sortOrder: 20,
      autoStart: true,
      isBuiltin: false,
      createdAt: '2026-05-02T00:00:00.000Z',
      updatedAt: '2026-05-02T00:00:00.000Z',
    },
    {
      id: 'lane-claude-pm',
      label: 'Claude PM',
      agent: 'claude',
      providerKind: 'native-orchestrator',
      projectId: 'prj-claude',
      taskId: 'thr-claude',
      mainConversationId: 'conv-claude',
      sortOrder: 10,
      autoStart: true,
      isBuiltin: false,
      createdAt: '2026-05-02T00:00:00.000Z',
      updatedAt: '2026-05-02T00:00:00.000Z',
    },
  ];

  it('sorts arbitrary configured lanes without requiring Rook or King', () => {
    expect(sortAgentLanes(lanes).map((lane) => lane.id)).toEqual([
      'lane-claude-pm',
      'lane-vector',
    ]);
  });

  it('keeps an arbitrary stored lane id active and falls back to the first sorted lane', () => {
    expect(chooseActiveAgentLane(lanes, 'lane-vector')?.id).toBe('lane-vector');
    expect(chooseActiveAgentLane(lanes, 'rook')?.id).toBe('lane-claude-pm');
    expect(chooseActiveAgentLane([], 'lane-vector')).toBeNull();
  });
});
