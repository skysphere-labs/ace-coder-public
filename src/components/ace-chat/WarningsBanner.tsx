import { useState } from 'react';
import { AlertCircle, ChevronRight } from 'lucide-react';
import { cn } from '../../lib/utils';
import { aceApi } from '../../lib/ace-api';

export function WarningsBanner({
  streamId,
  warnings,
}: {
  streamId: string;
  warnings: Array<{ code: string; error?: string; tAt: number }>;
}) {
  const [open, setOpen] = useState(false);
  if (!warnings.length) return null;
  return (
    <div className="rounded-md border border-amber-400/25 bg-amber-500/[0.05] text-[12px] text-amber-200">
      <div className="flex w-full items-center gap-2 px-3 py-2">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex flex-1 items-center gap-2 text-left"
          aria-expanded={open}
        >
          <ChevronRight className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-90')} />
          <AlertCircle className="h-3.5 w-3.5" />
          <span>
            {warnings.length} session event{warnings.length === 1 ? '' : 's'} couldn't be mapped
          </span>
        </button>
        <button
          type="button"
          onClick={() => {
            void aceApi.streams.snapshot(streamId);
          }}
          className="rounded bg-white/[0.06] px-2 py-0.5 text-[11px] hover:bg-white/[0.1]"
        >
          Open snapshot
        </button>
      </div>
      {open && (
        <div className="max-h-40 overflow-auto border-t border-amber-400/20 px-3 py-2 font-mono text-[11px] text-amber-200/85">
          {warnings.map((w, i) => (
            <div key={i}>{w.code}{w.error ? `: ${w.error}` : ''}</div>
          ))}
        </div>
      )}
    </div>
  );
}
