import { cva, type VariantProps } from 'class-variance-authority';
import { GitPullRequest, GitMerge, GitPullRequestClosed, GitPullRequestDraft } from 'lucide-react';
import { cn } from '../../lib/utils';

const badgeVariants = cva(
  'inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground',
        secondary: 'border-transparent bg-secondary text-secondary-foreground',
        destructive: 'border-transparent bg-destructive text-destructive-foreground',
        outline: 'text-foreground',
        success: 'border-transparent bg-[hsl(var(--ace-ok)/0.16)] text-[hsl(var(--ace-ok))]',
        // Amber = live / attention — the one place a badge carries the brand accent.
        warning: 'border-transparent bg-[hsl(var(--ace-accent)/0.16)] text-[hsl(var(--ace-accent))]',
        muted: 'border-border/70 bg-muted/40 text-muted-foreground',
      },
    },
    defaultVariants: { variant: 'default' },
  }
);

export function Badge({
  className,
  variant,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & VariantProps<typeof badgeVariants>) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

type PrStatus = 'open' | 'merged' | 'closed' | 'draft';

const PR_STATUS_STYLES: Record<PrStatus, string> = {
  open: 'border-[hsl(var(--ace-ok)/0.25)] bg-[hsl(var(--ace-ok)/0.08)] text-[hsl(var(--ace-ok))] hover:bg-[hsl(var(--ace-ok)/0.14)] hover:border-[hsl(var(--ace-ok)/0.35)]',
  merged: 'border-[hsl(var(--ace-pr-merged)/0.25)] bg-[hsl(var(--ace-pr-merged)/0.08)] text-[hsl(var(--ace-pr-merged))] hover:bg-[hsl(var(--ace-pr-merged)/0.14)] hover:border-[hsl(var(--ace-pr-merged)/0.35)]',
  closed: 'border-[hsl(var(--ace-danger)/0.25)] bg-[hsl(var(--ace-danger)/0.08)] text-[hsl(var(--ace-danger))] hover:bg-[hsl(var(--ace-danger)/0.14)] hover:border-[hsl(var(--ace-danger)/0.35)]',
  draft: 'border-white/10 bg-white/[0.04] text-muted-foreground hover:bg-white/[0.07] hover:text-foreground',
};

const PR_STATUS_ICON: Record<PrStatus, typeof GitPullRequest> = {
  open: GitPullRequest,
  merged: GitMerge,
  closed: GitPullRequestClosed,
  draft: GitPullRequestDraft,
};

export function PrBadge({
  prNumber,
  status,
  size = 'sm',
  className,
  onClick,
  asButton = true,
}: {
  prNumber: number;
  status?: PrStatus;
  size?: 'xs' | 'sm';
  className?: string;
  onClick?: (e: React.MouseEvent) => void;
  asButton?: boolean;
}) {
  const resolved: PrStatus = status ?? 'open';
  const Icon = PR_STATUS_ICON[resolved];
  const sizeClasses =
    size === 'xs'
      ? 'gap-1 px-1.5 py-0 text-[10px] leading-[16px]'
      : 'gap-1 px-1.5 py-0.5 text-[11px]';
  const iconClass = size === 'xs' ? 'h-2.5 w-2.5' : 'h-3 w-3';
  const cls = cn(
    'inline-flex items-center rounded-md border font-medium tabular-nums transition-colors',
    sizeClasses,
    PR_STATUS_STYLES[resolved],
    className
  );
  const content = (
    <>
      <Icon className={iconClass} />
      <span>#{prNumber}</span>
    </>
  );
  if (!asButton) {
    return (
      <span className={cls} title={`PR #${prNumber}`}>
        {content}
      </span>
    );
  }
  return (
    <button type="button" onClick={onClick} className={cls} title={`PR #${prNumber}`}>
      {content}
    </button>
  );
}
