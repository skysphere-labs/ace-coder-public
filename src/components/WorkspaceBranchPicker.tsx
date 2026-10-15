import { useState } from 'react';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { GitBranch, ChevronDown, Search, Check } from 'lucide-react';
import { cn } from '../lib/utils';

interface WorkspaceBranchPickerProps {
  baseBranch?: string;
  branchOptions: string[];
  isLoadingBranches?: boolean;
  isSavingBaseBranch?: boolean;
  onBaseBranchChange?: (value: string) => void;
}

export default function WorkspaceBranchPicker({
  baseBranch,
  branchOptions,
  isLoadingBranches = false,
  isSavingBaseBranch = false,
  onBaseBranchChange,
}: WorkspaceBranchPickerProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');

  const placeholder = isLoadingBranches
    ? 'Loading…'
    : branchOptions.length === 0
      ? 'No branches'
      : 'Select branch';

  const filtered = branchOptions.filter((b) => b.toLowerCase().includes(search.toLowerCase()));

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          disabled={isSavingBaseBranch || (isLoadingBranches && branchOptions.length === 0)}
          className={cn(
            'inline-flex h-7 items-center gap-1.5 rounded-md border border-white/[0.06] bg-white/[0.02] px-2 text-[11px] font-medium text-foreground/90 transition-colors',
            'hover:border-white/[0.10] hover:bg-white/[0.04]',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
            'disabled:cursor-not-allowed disabled:opacity-50'
          )}
        >
          <GitBranch className="h-3 w-3 shrink-0 text-muted-foreground" />
          <span className="truncate font-mono">{baseBranch || placeholder}</span>
          <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          sideOffset={6}
          align="start"
          className="glass-surface z-[120] w-[320px] overflow-hidden rounded-xl p-0 text-foreground animate-in fade-in-0 zoom-in-95"
        >
          <div className="border-b border-white/[0.06] p-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                autoFocus
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search branches"
                className="h-8 w-full rounded-lg border border-white/[0.06] bg-white/[0.03] pl-8 pr-3 text-xs placeholder:text-muted-foreground focus:border-white/20 focus:outline-none"
              />
            </div>
          </div>
          <div className="max-h-[280px] overflow-y-auto p-1.5">
            {filtered.length > 0 ? (
              filtered.map((branch) => {
                const isCurrent = branch === baseBranch;
                return (
                  <button
                    key={branch}
                    type="button"
                    onClick={() => {
                      onBaseBranchChange?.(branch);
                      setOpen(false);
                    }}
                    aria-current={isCurrent || undefined}
                    className={cn(
                      'glass-item flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left font-mono text-[12px]',
                      isCurrent ? 'text-foreground' : 'text-foreground/80'
                    )}
                  >
                    <span className={isCurrent ? 'font-semibold' : ''}>{branch}</span>
                    {isCurrent && <Check className="h-3.5 w-3.5 text-foreground/60" />}
                  </button>
                );
              })
            ) : (
              <div className="px-3 py-4 text-center text-xs text-muted-foreground">
                No matching branches
              </div>
            )}
          </div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
