export type CliAttachmentStatus = 'uploading' | 'ready' | 'error';

export type CliAttachment = {
  id: string;
  name: string;
  status: CliAttachmentStatus;
  path?: string;
  previewUrl?: string;
  error?: string;
};

export type CliAttachmentSubmission =
  | { ok: true; text: string }
  | { ok: false; reason: string };

// Client-side max-size guard (PRD Lane A / A8). Until now the only check was an
// empty-file guard; a multi-hundred-MB paste/upload would OOM the base64 encode
// or blow the Electron IPC / PWA-WS structured-clone budget. The limit is
// generous enough for photos, PDFs and short clips; oversize files surface a
// clear blocked-reason in the tray instead of silently failing mid-upload.
export const MAX_CLI_ATTACHMENT_BYTES = 50 * 1024 * 1024; // 50 MB

function formatAttachmentBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/**
 * Returns a human blocked-reason when the file is over the limit, else null.
 * Cross-platform: same guard fires on desktop, mobile and remote (the bytes all
 * travel the same persist path).
 */
export function attachmentSizeError(file: Pick<File, 'name' | 'size'>): string | null {
  if (file.size > MAX_CLI_ATTACHMENT_BYTES) {
    return `${file.name || 'Attachment'} is ${formatAttachmentBytes(file.size)} — over the ${formatAttachmentBytes(
      MAX_CLI_ATTACHMENT_BYTES
    )} attachment limit`;
  }
  return null;
}

export function getCliAttachmentBlockReason(attachments: CliAttachment[]): string | null {
  const uploading = attachments.find((a) => a.status === 'uploading');
  if (uploading) return `Still attaching ${uploading.name}`;
  const failed = attachments.find((a) => a.status === 'error');
  if (failed) return failed.error || `Could not attach ${failed.name}`;
  const unresolved = attachments.find((a) => a.status === 'ready' && !a.path);
  if (unresolved) return `No path available for ${unresolved.name}`;
  return null;
}

export function buildCliAttachmentSubmission(
  text: string,
  attachments: CliAttachment[]
): CliAttachmentSubmission {
  const reason = getCliAttachmentBlockReason(attachments);
  if (reason) return { ok: false, reason };
  const body = text.trim();
  const paths = attachments
    .filter((a) => a.status === 'ready' && a.path)
    .map((a) => `@${a.path}`);
  if (paths.length === 0) return { ok: true, text: body };
  // Append @path lines AFTER the body so a leading slash command (e.g. `/goal …`)
  // stays at the very start of the message. Prepending the attachment refs pushed
  // `/goal` off the first line, so the CLI never recognized the command.
  return {
    ok: true,
    text: body ? `${body}\n\n${paths.join('\n')}` : paths.join('\n'),
  };
}

export function fileExtensionForAttachment(file: Pick<File, 'name' | 'type'>): string {
  const byName = /\.([a-z0-9]{1,8})$/i.exec(file.name || '');
  if (byName) return byName[1].toLowerCase();
  const byType = /^[-\w]+\/([-+\w.]+)$/.exec(file.type || '');
  if (byType) {
    const subtype = byType[1].toLowerCase();
    if (subtype === 'jpeg') return 'jpg';
    if (/^[a-z0-9]{1,8}$/.test(subtype)) return subtype;
  }
  return 'bin';
}
