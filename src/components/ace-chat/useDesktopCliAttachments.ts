import { useCallback, useEffect, useRef, useState } from 'react';
import { aceApi } from '../../lib/ace-api';
import { resolveLocalFilePath } from '../../lib/clipboard';
import {
  attachmentSizeError,
  fileExtensionForAttachment,
  getCliAttachmentBlockReason,
  type CliAttachment,
} from '../../lib/cli-attachments';
import { useCoreSelector } from '../../runtime/core-registry';
import {
  interpretPasteResult,
  planAttachmentPersist,
  type PersistOutcome,
} from './cli-attachment-persist';

type UseDesktopCliAttachmentsOptions = {
  taskId?: string | null;
};

type AttachmentDraft = CliAttachment & { file?: File };

export function useDesktopCliAttachments({ taskId }: UseDesktopCliAttachmentsOptions) {
  const [attachments, setAttachments] = useState<CliAttachment[]>([]);
  const attachmentsRef = useRef<CliAttachment[]>([]);
  const taskIdRef = useRef(taskId);
  // A path under window.aceDesktop.getFilePath(file) lives on the user's
  // macOS desktop. For a remote (SSH'd) workspace the agent runs on the other
  // host and can't read that path, so the local-path shortcut must be gated
  // on the workspace actually being local.
  const isRemoteWorkspace = useCoreSelector((snap) => {
    if (!taskId) return false;
    for (const ws of snap.workspaces) {
      const all = [...ws.tasks, ...ws.archivedTasks];
      if (all.some((t) => t.id === taskId)) return ws.isRemote === true;
    }
    return false;
  });
  const isRemoteRef = useRef(isRemoteWorkspace);

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  useEffect(() => {
    taskIdRef.current = taskId;
  }, [taskId]);

  useEffect(() => {
    isRemoteRef.current = isRemoteWorkspace;
  }, [isRemoteWorkspace]);

  const revokePreview = useCallback((attachment: CliAttachment | undefined) => {
    if (attachment?.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
  }, []);

  useEffect(() => () => {
    attachmentsRef.current.forEach(revokePreview);
  }, [revokePreview]);

  const replaceAttachment = useCallback((id: string, next: CliAttachment) => {
    setAttachments((prev) => prev.map((a) => (a.id === id ? next : a)));
  }, []);

  const resolveFile = useCallback(
    async (draft: AttachmentDraft) => {
      if (!draft.file) return;
      try {
        const file = draft.file;
        const markReady = (path: string) =>
          replaceAttachment(draft.id, {
            id: draft.id,
            name: draft.name,
            status: 'ready',
            path,
            previewUrl: draft.previewUrl,
          });

        const plan = planAttachmentPersist({
          taskId: taskIdRef.current ?? null,
          isRemoteWorkspace: isRemoteRef.current,
        });

        if (plan.kind === 'remote-bytes') {
          // Remote workspace: skip the local-path shortcut entirely — a path
          // on the user's desktop is useless to a remote agent. Persist
          // bytes to the remote host's pastes dir, and on failure surface
          // the backend error (no local /tmp fallback, since that path
          // would not be readable on the target host either).
          const remoteOutcome = await persistFile(file, plan.taskId);
          if (remoteOutcome.kind === 'ok') {
            markReady(remoteOutcome.path);
            return;
          }
          if (remoteOutcome.kind === 'empty') {
            throw new Error('Attachment was empty');
          }
          throw new Error(remoteOutcome.error);
        }

        // Local workspace: prefer the on-disk path the OS already has —
        // works for picker- and drag-dropped files (image or not) and skips
        // the bytes round-trip.
        const localPath = resolveLocalFilePath(file);
        if (localPath) {
          markReady(localPath);
          return;
        }
        const localOutcome = await persistFile(file, null);
        if (localOutcome.kind === 'ok') {
          markReady(localOutcome.path);
          return;
        }
        if (localOutcome.kind === 'empty') {
          throw new Error('Attachment was empty');
        }
        // The backend already reported the underlying reason (e.g.
        // "attachment bytes were unreadable", "ENOSPC"). Surface that
        // instead of collapsing every failure into a generic message.
        throw new Error(localOutcome.error);
      } catch (err) {
        replaceAttachment(draft.id, {
          id: draft.id,
          name: draft.name,
          status: 'error',
          error: err instanceof Error ? err.message : 'Attachment failed',
          previewUrl: draft.previewUrl,
        });
      }
    },
    [replaceAttachment]
  );

  const addFiles = useCallback(
    (files: File[]) => {
      const drafts = files.map((file) => {
        const name = file.name || (file.type.startsWith('image/') ? 'pasted-image' : 'attachment');
        // Size guard (A8): oversize files never start uploading — they land as a
        // resolved `error` so the composer's block-reason tray explains why
        // rather than failing silently mid base64-encode.
        const sizeError = attachmentSizeError({ name, size: file.size });
        if (sizeError) {
          return { id: makeAttachmentId(), name, status: 'error' as const, error: sizeError, file: undefined };
        }
        return {
          id: makeAttachmentId(),
          name,
          status: 'uploading' as const,
          previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined,
          file,
        };
      });
      setAttachments((prev) => [...prev, ...drafts.map(({ file: _file, ...draft }) => draft)]);
      drafts.forEach((draft) => {
        if (draft.file) void resolveFile(draft);
      });
    },
    [resolveFile]
  );

  const addPaths = useCallback((paths: string[]) => {
    const ready = paths
      .filter((path) => path.trim().length > 0)
      .map((path) => ({
        id: makeAttachmentId(),
        name: basename(path),
        status: 'ready' as const,
        path,
      }));
    if (ready.length > 0) setAttachments((prev) => [...prev, ...ready]);
  }, []);

  const removeAttachment = useCallback(
    (id: string) => {
      setAttachments((prev) => {
        const removed = prev.find((a) => a.id === id);
        revokePreview(removed);
        return prev.filter((a) => a.id !== id);
      });
    },
    [revokePreview]
  );

  const clearAttachments = useCallback(() => {
    setAttachments((prev) => {
      prev.forEach(revokePreview);
      return [];
    });
  }, [revokePreview]);

  return {
    attachments,
    addFiles,
    addPaths,
    removeAttachment,
    clearAttachments,
    blockReason: getCliAttachmentBlockReason(attachments),
  };
}

async function persistFile(file: File, taskId: string | null): Promise<PersistOutcome> {
  if (file.size === 0) return { kind: 'empty' };
  // Encode to base64 so the bytes survive both the Electron IPC structured
  // clone and the HTTP/PWA bridge's JSON.stringify (which would otherwise
  // turn a Uint8Array into a {"0":n,"1":n,…} numeric-keyed object that the
  // backend's coerceBuffer used to silently reject).
  const base64 = await fileToBase64(file);
  if (!base64) return { kind: 'empty' };
  const ext = fileExtensionForAttachment(file);
  const result = taskId
    ? await aceApi.runtime.pasteClipboardImageRemote(taskId, base64, ext)
    : await aceApi.runtime.pasteClipboardImage(base64, ext);
  const outcome = interpretPasteResult(result);
  if (outcome.kind === 'error') {
    console.warn('[ace] attachment write reported:', outcome.error);
  }
  return outcome;
}

async function fileToBase64(file: File): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const data = reader.result;
      if (typeof data !== 'string') {
        reject(new Error('FileReader returned non-string'));
        return;
      }
      const comma = data.indexOf(',');
      resolve(comma >= 0 ? data.slice(comma + 1) : '');
    };
    reader.onerror = () => reject(reader.error || new Error('FileReader failed'));
    reader.readAsDataURL(file);
  });
}

function makeAttachmentId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `attachment-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function basename(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const index = normalized.lastIndexOf('/');
  return index >= 0 ? normalized.slice(index + 1) : normalized;
}
