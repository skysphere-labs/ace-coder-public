import { cn } from '../../../lib/utils';

// Target-workspace picker for promotion flows (todo → Mission Board ticket).
// Promoted from verbatim organism-local copies (ops-v2 audit: TodosPanel and
// CandidatesPanel each hand-rolled this select). Type standard: text-xs floor,
// /80 on the chosen value — this control decides WHERE missions spawn, so it
// sits next to the promote action, never in a distant header.
export function WorkspaceSelect({
  workspaces,
  value,
  onChange,
  placeholder,
  disabled = false,
  ariaLabel = 'Target workspace',
  className,
}: {
  workspaces: Array<{ id: string; name: string }>;
  value: string;
  onChange: (id: string) => void;
  /** Optional empty-value option (e.g. "Default") so callers can model "unset". */
  placeholder?: string;
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
}) {
  if (workspaces.length === 0) return null;
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      aria-label={ariaLabel}
      className={cn(
        'h-8 rounded-md border border-white/[0.06] bg-white/[0.04] px-2 text-xs text-foreground/80 focus:outline-none focus:ring-1 focus:ring-sky-500/40 disabled:opacity-50',
        className
      )}
    >
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {workspaces.map((w) => (
        <option key={w.id} value={w.id}>
          {w.name}
        </option>
      ))}
    </select>
  );
}
