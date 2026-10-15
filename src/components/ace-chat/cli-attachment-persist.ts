// Pure helpers extracted from useDesktopCliAttachments so the renderer→backend
// persistence contract can be tested without a DOM. The discriminated outcome
// is what keeps backend error strings (e.g. "ENOSPC", "attachment bytes were
// unreadable") from being collapsed into the generic "Could not write
// attachment to a temp file" message the picker used to surface.

export type PasteResult = { path?: string | null; error?: string } | null | undefined;

export type PersistOutcome =
  | { kind: 'ok'; path: string }
  | { kind: 'error'; error: string }
  | { kind: 'empty' };

export const DEFAULT_TEMP_WRITE_ERROR = 'Could not write attachment to a temp file';

export function interpretPasteResult(
  result: PasteResult,
  fallback: string = DEFAULT_TEMP_WRITE_ERROR
): PersistOutcome {
  if (result && typeof result.path === 'string' && result.path.length > 0) {
    return { kind: 'ok', path: result.path };
  }
  if (result && typeof result.error === 'string' && result.error.length > 0) {
    return { kind: 'error', error: result.error };
  }
  return { kind: 'error', error: fallback };
}

// Plan describes which IPC the picker should use first for a given workspace
// context. Remote workspaces MUST persist bytes to the remote host (a path
// under window.aceDesktop.getFilePath(file) lives on the user's desktop
// and is unreadable by the remote agent). Local workspaces may take the
// on-disk shortcut and only persist bytes when no path is available.
export type AttachmentPersistPlan =
  | { kind: 'remote-bytes'; taskId: string }
  | { kind: 'local-path-first' };

export function planAttachmentPersist(input: {
  taskId: string | null | undefined;
  isRemoteWorkspace: boolean;
}): AttachmentPersistPlan {
  if (input.isRemoteWorkspace && input.taskId) {
    return { kind: 'remote-bytes', taskId: input.taskId };
  }
  return { kind: 'local-path-first' };
}
