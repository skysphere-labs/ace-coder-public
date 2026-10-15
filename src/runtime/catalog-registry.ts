import { useEffect } from 'react';
import { aceApi } from '../lib/ace-api';
import type {
  McpCatalogEntry,
  McpProvider,
  McpServer,
  Skill,
} from '../lib/types';
import { createSnapshotStore, useStoreValue } from './create-snapshot-store';

const skillsStore = createSnapshotStore<Skill[]>([]);
const skillsReady = { loaded: false, inflight: null as Promise<void> | null };

export function loadSkillCatalog(): Promise<void> {
  if (skillsReady.inflight) return skillsReady.inflight;
  skillsReady.inflight = aceApi.skills
    .getCatalog()
    .then((catalog) => {
      skillsStore.setSnapshot(catalog.skills ?? []);
      skillsReady.loaded = true;
    })
    .catch((err) => {
      console.error('[ace] load skills catalog failed:', err);
      skillsStore.setSnapshot([]);
    })
    .finally(() => {
      skillsReady.inflight = null;
    });
  return skillsReady.inflight;
}

export async function refreshSkillCatalog(): Promise<void> {
  try {
    const catalog = await aceApi.skills.refreshCatalog();
    skillsStore.setSnapshot(catalog.skills ?? []);
  } catch (err) {
    console.error('[ace] refresh skills catalog failed:', err);
  }
}

export function useSkillCatalog(): Skill[] {
  useEffect(() => {
    if (!skillsReady.loaded && !skillsReady.inflight) void loadSkillCatalog();
  }, []);
  return useStoreValue(skillsStore);
}

type McpState = {
  installed: McpServer[];
  catalog: McpCatalogEntry[];
  providers: McpProvider[];
};

const mcpStore = createSnapshotStore<McpState>({
  installed: [],
  catalog: [],
  providers: [],
});
const mcpReady = { loaded: false, inflight: null as Promise<void> | null };

export function loadMcp(): Promise<void> {
  if (mcpReady.inflight) return mcpReady.inflight;
  mcpReady.inflight = Promise.all([
    aceApi.mcp.loadAll(),
    aceApi.mcp.getProviders(),
  ])
    .then(([data, providers]) => {
      mcpStore.setSnapshot({
        installed: data.installed ?? [],
        catalog: data.catalog ?? [],
        providers: providers ?? [],
      });
      mcpReady.loaded = true;
    })
    .catch((err) => {
      console.error('[ace] load mcp failed:', err);
      mcpStore.setSnapshot({ installed: [], catalog: [], providers: [] });
    })
    .finally(() => {
      mcpReady.inflight = null;
    });
  return mcpReady.inflight;
}

export function useMcpState(): McpState {
  useEffect(() => {
    if (!mcpReady.loaded && !mcpReady.inflight) void loadMcp();
  }, []);
  return useStoreValue(mcpStore);
}
