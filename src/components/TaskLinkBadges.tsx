import { MessageSquare } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import type { TaskContext } from '../lib/types';

interface TaskLinkBadgesProps {
  context?: TaskContext;
}

export function TaskLinkBadges({ context }: TaskLinkBadgesProps) {
  if (!context) return null;

  return (
    <div className="inline-flex items-center gap-2">
      {context.linearIssue && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-muted px-2 text-xs font-medium text-foreground hover:bg-muted/80 dark:border-border dark:bg-muted dark:hover:bg-muted/80"
            >
              <span className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-[3px] bg-[#5e6ad2] text-[8px] font-bold text-white">L</span>
              <span>{context.linearIssue.identifier}</span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-sm">
            <div className="text-xs">
              <div className="font-medium">{context.linearIssue.title}</div>
              {context.linearIssue.state && (
                <div className="mt-1 text-muted-foreground">{context.linearIssue.state}</div>
              )}
            </div>
          </TooltipContent>
        </Tooltip>
      )}

      {context.githubIssue && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-muted px-2 text-xs font-medium text-foreground hover:bg-muted/80"
            >
              <span className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-full bg-foreground text-[8px] font-bold text-background">G</span>
              <span>#{context.githubIssue.number}</span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-sm">
            <div className="text-xs font-medium">{context.githubIssue.title}</div>
          </TooltipContent>
        </Tooltip>
      )}

      {context.jiraIssue && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-muted px-2 text-xs font-medium text-foreground hover:bg-muted/80"
            >
              <span className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-[3px] bg-[#0052cc] text-[8px] font-bold text-white">J</span>
              <span>{context.jiraIssue.key}</span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-sm">
            <div className="text-xs font-medium">{context.jiraIssue.summary}</div>
          </TooltipContent>
        </Tooltip>
      )}

      {(context.unsentComments ?? 0) > 0 && (
        <button
          type="button"
          className="relative inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-muted px-2 text-xs font-medium text-foreground hover:bg-muted/80"
        >
          <MessageSquare className="h-3.5 w-3.5 shrink-0" />
          <span>Comments</span>
          <span className="absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-blue-500 px-1 text-[10px] font-semibold text-white">
            {context.unsentComments}
          </span>
        </button>
      )}
    </div>
  );
}
