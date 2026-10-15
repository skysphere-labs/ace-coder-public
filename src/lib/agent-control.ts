// Pure shaping helpers for the Operations → Agents "Agent Control" panel.
// No IPC here — the panel fetches lanes/streams/backends through existing
// ace-api surfaces and this module joins/formats them. Unit-tested with
// injected fakes in src/lib/agent-control.test.ts.

import type { AgentLane } from './agent-lanes';
import type { StreamEntry } from './ace-api';

// Mirrors AgentsScreen's persisted active-lane slot so "Open lane" from
// Operations lands on the exact tab AgentsScreen restores on mount.
export const ACTIVE_AGENT_LANE_STORAGE_KEY = 'ace:agents-active-lane-v1';

export type AgentLaneControlRow = {
  lane: AgentLane;
  stream: StreamEntry | null;
  // Stream state when a tracked stream is joined; 'untracked' when the lane
  // has no stream row at all (never fabricated as idle/healthy).
  streamState: string;
  live: boolean;
  workspace: string | null;
};

// Workspace display label from a stream cwd — last path segment only (never
// the full path; rows must stay machine-neutral on screen).
export function workspaceLabelFromCwd(cwd: string | null | undefined): string | null {
  const raw = String(cwd ?? '').trim();
  if (!raw) return null;
  const parts = raw.split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : null;
}

// Lane provider wording — matches AgentsScreen's laneProfileLabel.
export function laneProviderLabel(lane: Pick<AgentLane, 'providerKind' | 'profileId'>): string {
  if (lane.providerKind === 'hermes-profile') return lane.profileId || 'profile';
  if (lane.providerKind === 'builtin-personal') return 'personal';
  return 'native';
}

// Join lanes to their tracked streams by taskId. A live stream always wins
// over a dormant catalog row for the same task; lanes without any stream row
// surface as 'untracked' (status read-only — no process control implied).
export function joinLanesWithStreams(
  lanes: AgentLane[],
  streams: StreamEntry[]
): AgentLaneControlRow[] {
  const byTask = new Map<string, StreamEntry>();
  for (const stream of Array.isArray(streams) ? streams : []) {
    const taskId = typeof stream?.taskId === 'string' ? stream.taskId : '';
    if (!taskId) continue;
    const existing = byTask.get(taskId);
    if (!existing || (stream.live === true && existing.live !== true)) {
      byTask.set(taskId, stream);
    }
  }
  return (Array.isArray(lanes) ? lanes : []).map((lane) => {
    const stream = byTask.get(lane.taskId) ?? null;
    return {
      lane,
      stream,
      streamState: stream ? String(stream.state || 'unknown') : 'untracked',
      live: stream?.live === true,
      workspace: workspaceLabelFromCwd(stream?.cwd),
    };
  });
}

// Stream-state chip tone on the shared Chip scale. Severity-neutral wording:
// busy/awaiting are sky (in-flight), idle/turn-complete emerald (responsive),
// error rose, everything else neutral.
export function streamStateTone(
  state: string
): 'neutral' | 'sky' | 'amber' | 'emerald' | 'rose' {
  if (state === 'busy' || state === 'awaiting-approval') return 'sky';
  if (state === 'idle' || state === 'turn-complete') return 'emerald';
  if (state === 'error') return 'rose';
  if (state === 'interrupted') return 'amber';
  return 'neutral';
}
