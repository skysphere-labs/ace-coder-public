import type { WorkspaceStatsDetail, WorkspaceStatsDirRow, WorkspaceStatsFile } from '../lib/ace-api';
import { formatBytes, formatCompactNumber } from '../lib/utils';
import { Spinner } from './ui/spinner';

function truncatePath(p: string, max = 42): string {
  if (p.length <= max) return p;
  return '…' + p.slice(p.length - (max - 1));
}

export function ActivityStatsPopoverContent({
  detail,
  loading,
  error,
}: {
  detail: WorkspaceStatsDetail | null;
  loading: boolean;
  error: string | null;
}) {
  return (
    <div>
      <div className="flex items-center justify-between border-b border-white/[0.06] px-4 py-3">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wider text-foreground/80">
            File Breakdown
          </div>
          <div className="mt-0.5 text-[10px] text-muted-foreground">
            Text/code files · binaries excluded
          </div>
        </div>
        {loading && <Spinner className="h-3 w-3 text-muted-foreground" />}
      </div>

      <div className="max-h-[440px] overflow-y-auto">
        {error && (
          <div className="px-4 py-6 text-center">
            <div className="text-[12px] text-foreground/80">Couldn't read breakdown</div>
            <div className="mt-1 text-[10px] leading-snug text-muted-foreground">{error}</div>
          </div>
        )}

        {detail?.remote && (
          <div className="px-4 py-6 text-center text-[11px] text-muted-foreground">
            Remote workspace — breakdown unavailable.
          </div>
        )}

        {detail && !detail.remote && detail.totals.files === 0 && !loading && (
          <div className="px-4 py-6 text-center text-[11px] text-muted-foreground">
            No text/code files found.
          </div>
        )}

        {detail && !detail.remote && detail.totals.files > 0 && (
          <>
            <Section title="By directory">
              {detail.byDir.slice(0, 8).map((row) => (
                <DirRow key={row.dir} row={row} total={detail.totals.bytes} />
              ))}
            </Section>

            <Section title="Largest files">
              {detail.topByBytes.slice(0, 8).map((f) => (
                <FileRow key={`b:${f.path}`} file={f} mode="bytes" total={detail.topByBytes[0]?.bytes ?? 1} />
              ))}
            </Section>

            <Section title="Most lines">
              {detail.topByLoc.slice(0, 8).map((f) => (
                <FileRow key={`l:${f.path}`} file={f} mode="loc" total={detail.topByLoc[0]?.loc ?? 1} />
              ))}
            </Section>

            {(detail.skipped.binaryExt > 0 || detail.skipped.binaryNull > 0) && (
              <div className="border-t border-white/[0.06] px-4 py-2.5 text-[10px] text-muted-foreground/70">
                {detail.skipped.binaryExt + detail.skipped.binaryNull} binary file
                {detail.skipped.binaryExt + detail.skipped.binaryNull === 1 ? '' : 's'} excluded
                {detail.skipped.binaryNull > 0 && ` (${detail.skipped.binaryNull} by content)`}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-white/[0.04] last:border-b-0">
      <div className="px-4 pt-3 pb-1.5 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground/60">
        {title}
      </div>
      <div className="px-2 pb-2">{children}</div>
    </div>
  );
}

function DirRow({ row, total }: { row: WorkspaceStatsDirRow; total: number }) {
  const pct = total > 0 ? (row.bytes / total) * 100 : 0;
  return (
    <div className="group rounded-md px-2 py-1.5 transition-colors hover:bg-white/[0.03]">
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-[11.5px] font-medium text-foreground/90">{row.dir}</span>
        <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
          {formatBytes(row.bytes)} · {formatCompactNumber(row.loc)} lines · {row.files}{' '}
          {row.files === 1 ? 'file' : 'files'}
        </span>
      </div>
      <div className="mt-1 h-1 overflow-hidden rounded-full bg-white/[0.05]">
        <div
          className="h-full bg-foreground/55 transition-[width] duration-500"
          style={{ width: `${Math.max(2, Math.min(100, pct))}%` }}
        />
      </div>
    </div>
  );
}

function FileRow({
  file,
  mode,
  total,
}: {
  file: WorkspaceStatsFile;
  mode: 'bytes' | 'loc';
  total: number;
}) {
  const value = mode === 'bytes' ? file.bytes : file.loc;
  const pct = total > 0 ? (value / total) * 100 : 0;
  const primary = mode === 'bytes' ? formatBytes(file.bytes) : `${formatCompactNumber(file.loc)} lines`;
  const secondary = mode === 'bytes' ? `${formatCompactNumber(file.loc)} lines` : formatBytes(file.bytes);
  return (
    <div className="group rounded-md px-2 py-1.5 transition-colors hover:bg-white/[0.03]" title={file.path}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate font-mono text-[10.5px] text-foreground/85">
          {truncatePath(file.path)}
        </span>
        <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
          {primary} <span className="text-muted-foreground/50">· {secondary}</span>
        </span>
      </div>
      <div className="mt-1 h-1 overflow-hidden rounded-full bg-white/[0.05]">
        <div
          className="h-full bg-foreground/55 transition-[width] duration-500"
          style={{ width: `${Math.max(2, Math.min(100, pct))}%` }}
        />
      </div>
    </div>
  );
}
