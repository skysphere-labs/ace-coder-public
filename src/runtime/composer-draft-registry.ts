import { useCallback, useState } from 'react';
import { sanitizeComposerDraftText } from './terminal-safety';

const drafts = new Map<string, string>();

function keyFor(streamId: string | null | undefined): string | null {
  const key = streamId?.trim();
  return key ? key : null;
}

export function getComposerDraft(streamId: string | null | undefined): string {
  const key = keyFor(streamId);
  if (!key) return '';
  const current = drafts.get(key) ?? '';
  const safe = sanitizeComposerDraftText(current);
  if (safe !== current) {
    if (safe.length > 0) drafts.set(key, safe);
    else drafts.delete(key);
  }
  return safe;
}

export function setComposerDraft(streamId: string | null | undefined, text: string): void {
  const key = keyFor(streamId);
  if (!key) return;
  const safe = sanitizeComposerDraftText(text);
  if (safe.length > 0) drafts.set(key, safe);
  else drafts.delete(key);
}

export function clearComposerDraft(streamId: string | null | undefined): void {
  const key = keyFor(streamId);
  if (key) drafts.delete(key);
}

export function useComposerDraft(streamId: string): readonly [string, (next: string) => void] {
  const [state, setState] = useState(() => ({ streamId, text: getComposerDraft(streamId) }));
  const text = state.streamId === streamId ? state.text : getComposerDraft(streamId);

  const setText = useCallback(
    (next: string) => {
      const safe = sanitizeComposerDraftText(next);
      setComposerDraft(streamId, safe);
      setState({ streamId, text: safe });
    },
    [streamId]
  );

  return [text, setText] as const;
}
