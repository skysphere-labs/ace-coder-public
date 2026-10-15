import { useEffect } from 'react';
import { aceApi } from '../lib/ace-api';
import type { AgentCatalogEntry } from '../lib/types';
import { createSnapshotStore, useStoreValue } from './create-snapshot-store';

const starredStore = createSnapshotStore<string[]>([]);
let starredLoaded = false;
let starredSub: (() => void) | null = null;

function ensureStarredLoaded() {
  if (starredLoaded) return;
  starredLoaded = true;
  aceApi.agents
    .getStarred()
    .then((list) => starredStore.setSnapshot(list))
    .catch(() => starredStore.setSnapshot([]));
  if (!starredSub) {
    starredSub = aceApi.agents.onStarredChanged((payload) => {
      starredStore.setSnapshot(payload.starred ?? []);
    });
  }
}

export function useStarredAgents(): string[] {
  useEffect(() => {
    ensureStarredLoaded();
  }, []);
  return useStoreValue(starredStore);
}

export async function toggleStarredAgent(agentId: string): Promise<void> {
  const current = starredStore.getSnapshot();
  const isStarred = current.includes(agentId);
  const { starred } = await aceApi.agents.setStarred(agentId, !isStarred);
  starredStore.setSnapshot(starred);
}

export type AgentCatalogScope = {
  sshHost?: string | null;
  agentUser?: string | null;
};

function scopeKey(scope?: AgentCatalogScope) {
  if (!scope || !scope.sshHost) return 'local';
  return `remote::${scope.sshHost}::${scope.agentUser || 'root'}`;
}

const stores = new Map<string, ReturnType<typeof createSnapshotStore<AgentCatalogEntry[]>>>();
const loading = new Map<string, Promise<void>>();

function storeFor(key: string) {
  let store = stores.get(key);
  if (!store) {
    store = createSnapshotStore<AgentCatalogEntry[]>([]);
    stores.set(key, store);
  }
  return store;
}

function loadAgentCatalog(scope?: AgentCatalogScope): Promise<void> {
  const key = scopeKey(scope);
  const existing = loading.get(key);
  if (existing) return existing;
  const promise = aceApi.agents
    .getCatalog(scope && scope.sshHost ? scope : undefined)
    .then((catalog) => {
      storeFor(key).setSnapshot(catalog);
    })
    .catch(() => {
      storeFor(key).setSnapshot([]);
    })
    .finally(() => {
      loading.delete(key);
    });
  loading.set(key, promise);
  return promise;
}

export function invalidateAgentCatalog(scope?: AgentCatalogScope) {
  const key = scopeKey(scope);
  stores.get(key)?.setSnapshot([]);
  void loadAgentCatalog(scope);
}

export function useAgentCatalog(scope?: AgentCatalogScope) {
  const key = scopeKey(scope);
  const store = storeFor(key);
  const sshHost = scope?.sshHost;
  const agentUser = scope?.agentUser;
  useEffect(() => {
    if (store.getSnapshot().length === 0) void loadAgentCatalog(scope);
  }, [agentUser, key, scope, sshHost, store]);
  return useStoreValue(store);
}
