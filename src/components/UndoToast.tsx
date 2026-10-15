import { dismissToast, useToast } from '../runtime/undo-registry';

export function UndoToast() {
  const toast = useToast();
  if (!toast) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-[100] flex justify-center px-4">
      <div className="pointer-events-auto flex items-center gap-3 rounded-full border border-white/10 bg-black/80 px-4 py-2 text-sm text-foreground shadow-[0_8px_32px_-8px_hsl(0_0%_0%/0.6)] backdrop-blur-md">
        <span>{toast.message}</span>
        {toast.action && (
          <button
            type="button"
            onClick={() => {
              toast.action?.onClick();
            }}
            className="rounded-full bg-white/10 px-3 py-0.5 text-xs font-medium text-foreground transition-colors hover:bg-white/15"
          >
            {toast.action.label}
          </button>
        )}
        <button
          type="button"
          onClick={dismissToast}
          aria-label="Dismiss"
          className="rounded-full px-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          ×
        </button>
      </div>
    </div>
  );
}
