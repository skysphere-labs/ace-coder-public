import { useState, useMemo } from 'react';
import {
  Search, ArrowUpRight,
  CheckCircle2, XCircle, Clock, GitPullRequest,
} from 'lucide-react';
import { cn } from '../lib/utils';
import { Input } from './ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import { aceApi } from '../lib/ace-api';
import type { OpenPr } from '../lib/types';

function GithubMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.1.79-.25.79-.56v-2.07c-3.2.69-3.87-1.36-3.87-1.36-.52-1.32-1.27-1.67-1.27-1.67-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.02 1.75 2.68 1.24 3.34.95.1-.74.4-1.24.72-1.52-2.55-.29-5.23-1.27-5.23-5.66 0-1.25.45-2.27 1.18-3.07-.12-.29-.51-1.46.11-3.05 0 0 .96-.31 3.16 1.17.92-.26 1.9-.39 2.88-.39s1.96.13 2.88.39c2.2-1.48 3.16-1.17 3.16-1.17.62 1.59.23 2.76.11 3.05.74.8 1.18 1.82 1.18 3.07 0 4.4-2.69 5.36-5.25 5.65.41.36.78 1.05.78 2.13v3.16c0 .31.21.67.8.56C20.21 21.39 23.5 17.08 23.5 12 23.5 5.65 18.35.5 12 .5z" />
    </svg>
  );
}

type FilterId = 'all' | 'review' | 'draft';

const FILTER_PRESETS: { id: FilterId; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'review', label: 'Needs review' },
  { id: 'draft', label: 'Drafts' },
];

function reviewLabel(decision?: string) {
  switch (decision) {
    case 'APPROVED':
      return { label: 'Approved', className: 'text-emerald-300', dot: 'bg-emerald-400' };
    case 'CHANGES_REQUESTED':
      return { label: 'Changes requested', className: 'text-rose-300', dot: 'bg-rose-400' };
    case 'REVIEW_REQUIRED':
      return { label: 'Review required', className: 'text-amber-300', dot: 'bg-amber-400' };
    default:
      return null;
  }
}

function CheckStatusIcon({ status }: { status?: 'success' | 'pending' | 'failure' }) {
  if (status === 'success') return <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-400" />;
  if (status === 'failure') return <XCircle className="h-3.5 w-3.5 shrink-0 text-rose-400" />;
  if (status === 'pending') return <Clock className="h-3.5 w-3.5 shrink-0 text-amber-400" />;
  return null;
}

export default function PullRequestQueue({ prs }: { prs: OpenPr[] }) {
  const [filter, setFilter] = useState<FilterId>('all');
  const [query, setQuery] = useState('');

  const filteredPrs = useMemo(() => {
    let result = prs;
    if (filter === 'draft') result = result.filter((p) => p.isDraft);
    if (filter === 'review') result = result.filter((p) => p.reviewDecision === 'REVIEW_REQUIRED');
    if (query.trim()) {
      const q = query.toLowerCase();
      result = result.filter(
        (p) =>
          p.title.toLowerCase().includes(q) ||
          p.headRef.toLowerCase().includes(q) ||
          p.author.toLowerCase().includes(q) ||
          String(p.number).includes(q)
      );
    }
    return result;
  }, [prs, filter, query]);

  const openOnGithub = (pr: OpenPr) => {
    if (!pr.url) return;
    void aceApi.workspaces.openExternal(pr.url);
  };

  return (
    <div className="flex flex-col gap-5">
      <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
        Open pull requests on this workspace. Filter by state or search by title, branch,
        or author.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search pull requests"
            className="h-9 pl-9"
          />
        </div>
        <div className="flex items-center gap-1 rounded-md border border-white/[0.06] bg-white/[0.02] p-0.5">
          {FILTER_PRESETS.map((preset) => {
            const isActive = filter === preset.id;
            return (
              <button
                key={preset.id}
                type="button"
                onClick={() => setFilter(preset.id)}
                className={cn(
                  'inline-flex h-7 items-center rounded px-2.5 text-[11px] font-medium transition-colors',
                  isActive
                    ? 'bg-white/[0.08] text-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {preset.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="text-xs text-muted-foreground">
        {filteredPrs.length} {filteredPrs.length === 1 ? 'pull request' : 'pull requests'}
        {query && ` matching "${query}"`}
      </div>

      <div className="flex flex-col gap-2">
        {filteredPrs.length > 0 ? (
          filteredPrs.map((pr) => {
            const review = reviewLabel(pr.reviewDecision);
            return (
              <button
                key={pr.number}
                type="button"
                onClick={() => openOnGithub(pr)}
                disabled={!pr.url}
                className="group flex items-center gap-3 rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-3 text-left transition-colors hover:border-white/[0.10] hover:bg-white/[0.04] disabled:cursor-default"
              >
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-white/[0.06] bg-white/[0.03]">
                  <GitPullRequest className="h-4 w-4 text-muted-foreground" />
                </div>

                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[11px] text-muted-foreground">#{pr.number}</span>
                    <CheckStatusIcon status={pr.checksStatus} />
                    <span className="truncate text-sm font-medium">{pr.title}</span>
                    {pr.isDraft && (
                      <span className="shrink-0 rounded border border-white/[0.06] bg-white/[0.03] px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                        Draft
                      </span>
                    )}
                    {review && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className={cn('inline-flex shrink-0 items-center gap-1 text-[10px] font-medium', review.className)}>
                            <span className={cn('h-1.5 w-1.5 rounded-full', review.dot)} />
                            {review.label}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent side="top">Review: {review.label}</TooltipContent>
                      </Tooltip>
                    )}
                  </div>
                  <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                    <span className="truncate font-mono">{pr.headRef}</span>
                    <span className="text-muted-foreground/40">·</span>
                    <span>{pr.author}</span>
                    {(pr.additions > 0 || pr.deletions > 0) && (
                      <>
                        <span className="text-muted-foreground/40">·</span>
                        <span className="inline-flex items-center gap-1 font-medium tabular-nums">
                          {pr.additions > 0 && (
                            <span className="text-emerald-400">+{pr.additions.toLocaleString()}</span>
                          )}
                          {pr.deletions > 0 && (
                            <span className="text-rose-400">-{pr.deletions.toLocaleString()}</span>
                          )}
                        </span>
                      </>
                    )}
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-1 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
                  <GithubMark className="h-3.5 w-3.5" />
                  <ArrowUpRight className="h-3 w-3" />
                </div>
              </button>
            );
          })
        ) : (
          <div className="rounded-xl border border-dashed border-white/[0.08] bg-white/[0.01] px-4 py-10 text-center text-sm text-muted-foreground">
            {prs.length === 0 ? 'No open pull requests for this workspace.' : 'No PRs match this filter.'}
          </div>
        )}
      </div>
    </div>
  );
}
