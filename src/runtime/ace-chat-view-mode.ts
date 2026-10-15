export type ChatViewMode = 'cli' | 'chat';

const listeners = new Map<string, Set<(mode: ChatViewMode) => void>>();

export function requestChatViewMode(streamId: string, mode: ChatViewMode) {
  const set = listeners.get(streamId);
  if (!set) return;
  for (const fn of set) fn(mode);
}

export function subscribeChatViewMode(
  streamId: string,
  listener: (mode: ChatViewMode) => void
): () => void {
  let set = listeners.get(streamId);
  if (!set) {
    set = new Set();
    listeners.set(streamId, set);
  }
  set.add(listener);
  return () => {
    const current = listeners.get(streamId);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) listeners.delete(streamId);
  };
}
