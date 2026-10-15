import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mission, Workspace } from '../lib/types';

type CoreApiState = { workspaces: Workspace[]; missions: Mission[] };

function workspace(id: string): Workspace {
  return {
    id,
    name: id,
    path: '',
    isRemote: false,
    sshHost: null,
    sshUser: null,
    remotePath: null,
    agentUser: null,
    defaultBranch: 'main',
    tasks: [],
    archivedTasks: [],
  };
}

const coreApi = vi.hoisted(() => {
  const listeners = new Set<(state: CoreApiState) => void>();
  return {
    listeners,
    getState: vi.fn(),
    subscribe: vi.fn((listener: (state: CoreApiState) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    isRemoteClient: vi.fn(() => false),
  };
});

vi.mock('../lib/ace-api', () => ({
  aceApi: {
    core: {
      getState: coreApi.getState,
      subscribe: coreApi.subscribe,
    },
  },
  isRemoteClient: coreApi.isRemoteClient,
}));

vi.mock('./perf-health', () => ({
  recordPerf: vi.fn(),
}));

import {
  applyState,
  defaultBroadcastFallbackDelayMs,
  getCoreSnapshot,
  runWithCoreStateRefresh,
} from './core-registry';

describe('runWithCoreStateRefresh', () => {
  beforeEach(() => {
    coreApi.listeners.clear();
    coreApi.getState.mockReset();
    coreApi.subscribe.mockClear();
    applyState({ workspaces: [], missions: [] });
  });

  it('uses the next core broadcast instead of issuing a duplicate getState', async () => {
    const broadcastState = {
      workspaces: [workspace('broadcast-workspace')],
      missions: [],
    };

    const result = await runWithCoreStateRefresh(
      async () => {
        for (const listener of Array.from(coreApi.listeners)) listener(broadcastState);
        return 'ok';
      },
      { fallbackDelayMs: 5 }
    );

    expect(result).toBe('ok');
    expect(coreApi.getState).not.toHaveBeenCalled();
    expect(getCoreSnapshot().workspaces[0]?.id).toBe('broadcast-workspace');
  });

  it('falls back to one getState call when no broadcast arrives', async () => {
    coreApi.getState.mockResolvedValue({
      workspaces: [workspace('fallback-workspace')],
      missions: [],
    });

    const result = await runWithCoreStateRefresh(async () => 'ok', {
      fallbackDelayMs: 0,
    });

    expect(result).toBe('ok');
    expect(coreApi.getState).toHaveBeenCalledTimes(1);
    expect(getCoreSnapshot().workspaces[0]?.id).toBe('fallback-workspace');
  });
});

describe('defaultBroadcastFallbackDelayMs', () => {
  it('waits briefly for the broadcast on desktop IPC', () => {
    coreApi.isRemoteClient.mockReturnValue(false);
    expect(defaultBroadcastFallbackDelayMs()).toBe(150);
  });

  it('gives remote clients more headroom before a full-state refetch', () => {
    coreApi.isRemoteClient.mockReturnValue(true);
    expect(defaultBroadcastFallbackDelayMs()).toBe(1500);
  });
});
