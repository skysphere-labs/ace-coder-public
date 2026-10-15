import { useCallback, useEffect, useState } from 'react';
import {
  ArrowLeft, ChevronRight, Folder, FolderOpen, GitBranch,
  Home, Loader2,
} from 'lucide-react';
import { cn } from '../lib/utils';
import { Button } from './ui/button';
import { aceApi } from '../lib/ace-api';

type DirListing = {
  path: string;
  home: string;
  parent: string | null;
  entries: Array<{ name: string; path: string }>;
  hasGit: boolean;
};

export function RemoteFileBrowser({
  onSelect,
  onCancel,
}: {
  onSelect: (path: string) => void;
  onCancel: () => void;
}) {
  const [listing, setListing] = useState<DirListing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const browse = useCallback(async (dirPath?: string) => {
    setLoading(true);
    setError(null);
    try {
      const result = await aceApi.workspaces.browseLocalDir(dirPath);
      setListing(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to browse');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void browse();
  }, [browse]);

  const navigateTo = (dir: string) => void browse(dir);

  if (loading && !listing) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error && !listing) {
    return (
      <div className="px-4 py-6 text-center text-sm text-rose-300/85">{error}</div>
    );
  }

  if (!listing) return null;

  const segments = listing.path.split('/').filter(Boolean);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex min-w-0 items-center gap-1 overflow-x-auto text-[11px]">
        <button
          type="button"
          onClick={() => navigateTo('/')}
          className="shrink-0 rounded px-1 py-0.5 text-muted-foreground transition-colors active:bg-white/[0.06] sm:hover:bg-white/[0.04]"
        >
          <Home className="h-3 w-3" />
        </button>
        {segments.map((seg, i) => {
          const segPath = '/' + segments.slice(0, i + 1).join('/');
          const isLast = i === segments.length - 1;
          return (
            <div key={segPath} className="flex shrink-0 items-center gap-1">
              <ChevronRight className="h-3 w-3 text-muted-foreground/40" />
              {isLast ? (
                <span className="font-medium text-foreground">{seg}</span>
              ) : (
                <button
                  type="button"
                  onClick={() => navigateTo(segPath)}
                  className="rounded px-1 py-0.5 text-muted-foreground transition-colors active:bg-white/[0.06] sm:hover:bg-white/[0.04]"
                >
                  {seg}
                </button>
              )}
            </div>
          );
        })}
      </div>

      <div className="flex items-center justify-between gap-2 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2">
        <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <FolderOpen className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate font-mono">{listing.path}</span>
          {listing.hasGit && (
            <span className="inline-flex shrink-0 items-center gap-1 text-[10px] text-emerald-300">
              <GitBranch className="h-2.5 w-2.5" />
              git
            </span>
          )}
        </div>
        <Button
          size="sm"
          variant="outline"
          className="h-7 shrink-0 gap-1.5 text-[11px]"
          onClick={() => onSelect(listing.path)}
        >
          Open here
        </Button>
      </div>

      <div className="flex items-center gap-1.5">
        {listing.parent && (
          <button
            type="button"
            onClick={() => navigateTo(listing.parent!)}
            className="flex h-7 items-center gap-1 rounded-md border border-white/[0.06] bg-white/[0.02] px-2 text-[11px] text-muted-foreground transition-colors active:bg-white/[0.06] sm:hover:bg-white/[0.04]"
          >
            <ArrowLeft className="h-3 w-3" />
            Up
          </button>
        )}
        <button
          type="button"
          onClick={() => navigateTo(listing.home)}
          className="flex h-7 items-center gap-1 rounded-md border border-white/[0.06] bg-white/[0.02] px-2 text-[11px] text-muted-foreground transition-colors active:bg-white/[0.06] sm:hover:bg-white/[0.04]"
        >
          <Home className="h-3 w-3" />
          Home
        </button>
        <div className="flex-1" />
        <button
          type="button"
          onClick={onCancel}
          className="flex h-7 items-center rounded-md px-2 text-[11px] text-muted-foreground transition-colors active:bg-white/[0.06] sm:hover:bg-white/[0.04]"
        >
          Cancel
        </button>
      </div>

      <div className="flex max-h-[50vh] flex-col gap-0.5 overflow-y-auto">
        {loading && (
          <div className="flex items-center justify-center py-4">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        )}
        {!loading && listing.entries.length === 0 && (
          <p className="px-2 py-4 text-center text-[11px] text-muted-foreground">
            No subfolders
          </p>
        )}
        {!loading &&
          listing.entries.map((entry) => (
            <button
              key={entry.path}
              type="button"
              onClick={() => navigateTo(entry.path)}
              className={cn(
                'flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs transition-colors',
                'active:bg-white/[0.06] sm:hover:bg-white/[0.04]'
              )}
            >
              <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-foreground/90">{entry.name}</span>
              <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground/40" />
            </button>
          ))}
      </div>
    </div>
  );
}
