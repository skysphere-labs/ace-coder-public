import { useId, type ChangeEvent, type ReactNode } from 'react';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { AlertCircle, FileText, ImageIcon, Loader2, Paperclip, X } from 'lucide-react';
import type { CliAttachment } from '../../lib/cli-attachments';
import { cn } from '../../lib/utils';

export function DesktopCliAttachmentButton({
  disabled,
  onAddFiles,
}: {
  disabled?: boolean;
  onAddFiles: (files: File[]) => void;
}) {
  // Use native <label htmlFor> so iOS Safari/Chrome opens the file picker
  // directly from the user gesture. Programmatic .click() on a display:none
  // input was unreliable on mobile — labels are the platform-blessed path.
  const baseId = useId();
  const imageInputId = `cli-attach-image-${baseId}`;
  const fileInputId = `cli-attach-file-${baseId}`;

  const onInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    if (!input.files) return;
    onAddFiles(Array.from(input.files));
    input.value = '';
  };

  return (
    <>
      <PopoverPrimitive.Root>
        <PopoverPrimitive.Trigger asChild>
          <button
            type="button"
            disabled={disabled}
            aria-label="Attach"
            title="Attach"
            className="flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-white/[0.05] hover:text-foreground disabled:opacity-40"
          >
            <Paperclip className="h-4 w-4" strokeWidth={1.85} />
          </button>
        </PopoverPrimitive.Trigger>
        <PopoverPrimitive.Portal>
          <PopoverPrimitive.Content
            side="top"
            align="start"
            sideOffset={8}
            className="glass-surface z-[230] w-48 overflow-hidden rounded-2xl p-1 animate-in fade-in-0 zoom-in-95"
          >
            <AttachmentMenuLabel
              icon={<ImageIcon className="h-4 w-4" />}
              label="Photo"
              htmlFor={imageInputId}
            />
            <AttachmentMenuLabel
              icon={<FileText className="h-4 w-4" />}
              label="File"
              htmlFor={fileInputId}
            />
          </PopoverPrimitive.Content>
        </PopoverPrimitive.Portal>
      </PopoverPrimitive.Root>
      {/* Visually hidden but kept in layout — `display: none` blocks the
          file picker on iOS Safari, so we ship a zero-size offscreen input
          that the labels above can target via htmlFor. */}
      <input
        id={imageInputId}
        type="file"
        accept="image/*"
        multiple
        disabled={disabled}
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={onInputChange}
      />
      <input
        id={fileInputId}
        type="file"
        multiple
        disabled={disabled}
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={onInputChange}
      />
    </>
  );
}

export function DesktopCliAttachmentTray({
  attachments,
  blockReason,
  onRemove,
}: {
  attachments: CliAttachment[];
  blockReason: string | null;
  onRemove: (id: string) => void;
}) {
  if (attachments.length === 0 && !blockReason) return null;
  return (
    <div className="mb-2 flex flex-col gap-1.5">
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {attachments.map((attachment) => (
            <AttachmentChip
              key={attachment.id}
              attachment={attachment}
              onRemove={() => onRemove(attachment.id)}
            />
          ))}
        </div>
      )}
      {blockReason && (
        <div className="flex items-center gap-1.5 text-[11px] text-amber-200/90">
          <AlertCircle className="h-3 w-3" />
          <span className="min-w-0 truncate">{blockReason}</span>
        </div>
      )}
    </div>
  );
}

function AttachmentMenuLabel({
  icon,
  label,
  htmlFor,
}: {
  icon: ReactNode;
  label: string;
  htmlFor: string;
}) {
  return (
    <label
      htmlFor={htmlFor}
      className="flex w-full cursor-pointer items-center gap-2 rounded-xl px-2.5 py-2 text-left text-[13px] text-foreground/90 hover:bg-white/[0.06]"
    >
      <span className="text-muted-foreground">{icon}</span>
      <span>{label}</span>
    </label>
  );
}

function AttachmentChip({
  attachment,
  onRemove,
}: {
  attachment: CliAttachment;
  onRemove: () => void;
}) {
  const isError = attachment.status === 'error';
  const isUploading = attachment.status === 'uploading';
  if (attachment.previewUrl) {
    return (
      <div
        className={cn(
          'relative h-14 w-14 overflow-hidden rounded-lg border border-white/[0.08]',
          isError && 'border-amber-400/40'
        )}
        title={attachment.error || attachment.path || attachment.name}
      >
        <img src={attachment.previewUrl} alt={attachment.name} className="h-full w-full object-cover" />
        {isUploading && (
          <span className="absolute inset-0 flex items-center justify-center bg-black/45">
            <Loader2 className="h-4 w-4 animate-spin text-foreground/90" />
          </span>
        )}
        {isError && (
          <span className="absolute inset-0 flex items-center justify-center bg-amber-950/60 text-amber-100">
            <AlertCircle className="h-4 w-4" />
          </span>
        )}
        <button
          type="button"
          onClick={onRemove}
          className="absolute right-0.5 top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-black/60 text-foreground/90 hover:bg-black/80"
        >
          <X className="h-2.5 w-2.5" />
        </button>
      </div>
    );
  }
  return (
    <div
      title={attachment.error || attachment.path || attachment.name}
      className={cn(
        'flex items-center gap-1.5 rounded-full border pl-2 pr-1 py-0.5 text-[11px]',
        isError
          ? 'border-amber-400/40 bg-amber-500/[0.08] text-amber-200'
          : 'border-white/[0.08] bg-white/[0.03] text-foreground/85'
      )}
    >
      {isUploading ? (
        <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
      ) : isError ? (
        <AlertCircle className="h-3 w-3" />
      ) : (
        <FileText className="h-3 w-3 text-muted-foreground" />
      )}
      <span className="max-w-[180px] truncate">{attachment.name}</span>
      <button
        type="button"
        onClick={onRemove}
        className="flex h-4 w-4 items-center justify-center rounded-full hover:bg-white/[0.08]"
      >
        <X className="h-2.5 w-2.5" />
      </button>
    </div>
  );
}
