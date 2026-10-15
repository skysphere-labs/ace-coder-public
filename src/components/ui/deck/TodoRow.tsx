import { Check } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { formatDue, isOverdue } from './due';

// One open todo on the Today deck — an Apple-Reminders-style bar: a tappable
// completion circle, the title on one line, and a quiet due date (amber-rose
// when overdue). Skinned with the deck --ace-* tokens (mono churn / hairline
// rows), the desktop counterpart to the mobile TodayTodos row.
export function TodoRow({
  text,
  dueAt,
  busy = false,
  onToggle,
}: {
  text: string;
  dueAt?: string | null;
  busy?: boolean;
  onToggle: () => void;
}) {
  const overdue = dueAt ? isOverdue(dueAt) : false;
  return (
    <div className="ledger-row flex items-start gap-3 px-4 py-2.5">
      <button
        type="button"
        onClick={onToggle}
        disabled={busy}
        aria-label={`Mark "${text}" done`}
        className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center disabled:opacity-40"
      >
        <span className="grid h-[18px] w-[18px] place-items-center rounded-full border border-white/15 text-foreground/40 transition-colors hover:border-[hsl(var(--ace-accent))] hover:text-[hsl(var(--ace-accent))]">
          <Check className="h-3 w-3 opacity-0" strokeWidth={2.5} aria-hidden />
        </span>
      </button>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] leading-snug text-foreground/90">{text}</p>
        {dueAt && (
          <p
            className={cn(
              'mono-data mt-0.5 text-[11px] leading-snug',
              overdue ? 'text-rose-300/90' : 'text-foreground/40'
            )}
          >
            {formatDue(dueAt)}
          </p>
        )}
      </div>
    </div>
  );
}
