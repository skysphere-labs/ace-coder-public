import { Plus } from 'lucide-react';

// The single ruled capture line on the Today deck — no card chrome, one amber
// hairline on focus. Optionally carries a small workspace tag select (default:
// no tag) so a jotted todo can be filed against a project. Enter submits.
export function CaptureInput({
  value,
  onChange,
  onSubmit,
  disabled = false,
  placeholder = 'Jot a todo…',
  workspaces,
  workspaceId = null,
  onWorkspaceIdChange,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  disabled?: boolean;
  placeholder?: string;
  workspaces?: Array<{ id: string; name: string }>;
  workspaceId?: string | null;
  onWorkspaceIdChange?: (id: string | null) => void;
}) {
  return (
    <div className="flex items-center gap-2.5 border-b border-white/[0.06] py-2 transition-colors focus-within:border-[hsl(var(--ace-accent)/0.6)]">
      <Plus className="h-4 w-4 shrink-0 text-foreground/35" strokeWidth={1.75} aria-hidden />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onSubmit();
        }}
        disabled={disabled}
        placeholder={placeholder}
        aria-label="New todo"
        className="min-w-0 flex-1 bg-transparent text-[13px] leading-snug text-foreground outline-none placeholder:text-foreground/35 disabled:opacity-50"
      />
      {workspaces && workspaces.length > 0 && onWorkspaceIdChange && (
        <select
          value={workspaceId ?? ''}
          onChange={(e) => onWorkspaceIdChange(e.target.value || null)}
          disabled={disabled}
          aria-label="Tag a workspace"
          className="max-w-[38%] shrink-0 truncate rounded-md border border-white/[0.06] bg-white/[0.02] px-2 py-1 text-[11px] text-foreground/60 outline-none transition-colors hover:border-white/[0.12] focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
        >
          <option value="">No project</option>
          {workspaces.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
