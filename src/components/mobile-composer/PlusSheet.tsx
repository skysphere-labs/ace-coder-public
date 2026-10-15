import {
  BrushCleaning,
  FileText,
  Gauge,
  ImageIcon,
  Palette,
  TerminalSquare,
} from 'lucide-react';
import { cn } from '../../lib/utils';
import { type ProviderUsageMeter } from '../../lib/ace-api';
import { AGENTS, type AgentId } from '../../lib/types';
import { useProviderUsage } from '../../runtime/usage-registry';
import { ActionSheet, SheetButton } from './ActionSheet';

// The `+` sheet — quick actions we want a thumb to reach. Shared between chat
// and terminal modes, but the handlers for Terminal / Clean-up Codebase
// route based on the caller's intent since they can't access the composer
// state themselves.
export function PlusSheet({
  agent,
  onClose,
  onPickImage,
  onPickFile,
  onOpenTerminal,
  onCleanupCodebase,
  onOpenAppearance,
  imageInputId,
  fileInputId,
}: {
  agent: AgentId | null;
  onClose: () => void;
  onPickImage?: () => void;
  onPickFile?: () => void;
  // Terminal / Clean-up are workspace-task actions. The Agents/Hermes chat
  // lane has no task behind it, so it omits these and the sheet shows just
  // the Photo / File pickers (plus the usage block).
  onOpenTerminal?: () => void;
  onCleanupCodebase?: () => void;
  // Opens the mobile appearance sheet (accent + glass tint) — the "change
  // appearance from the smart bar" path for the terminal composer.
  onOpenAppearance?: () => void;
  // When set, the Photo / File rows render as `<label htmlFor>` so iOS
  // Safari opens the picker directly from the user tap. The sheet should stay
  // mounted until the input change event reports selected files.
  imageInputId?: string;
  fileInputId?: string;
}) {
  return (
    <ActionSheet title="Actions" onClose={onClose}>
      <SheetButton
        icon={<ImageIcon className="h-5 w-5" />}
        label="Photo"
        description="Attach an image to the message"
        onClick={onPickImage}
        htmlFor={imageInputId}
      />
      <SheetButton
        icon={<FileText className="h-5 w-5" />}
        label="File"
        description="Reference a file as @path"
        onClick={onPickFile}
        htmlFor={fileInputId}
      />
      {onOpenTerminal && (
        <SheetButton
          icon={<TerminalSquare className="h-5 w-5" />}
          label="Terminal"
          description="Open a shared terminal tab for this task"
          onClick={onOpenTerminal}
        />
      )}
      {onCleanupCodebase && (
        <SheetButton
          icon={<BrushCleaning className="h-5 w-5" />}
          label="Clean up codebase"
          description="Send the pruning prompt to the agent"
          onClick={onCleanupCodebase}
        />
      )}
      {onOpenAppearance && (
        <SheetButton
          icon={<Palette className="h-5 w-5" />}
          label="Appearance"
          description="Accent color and glass tint"
          onClick={onOpenAppearance}
        />
      )}
      <UsageBlock agent={agent} />
    </ActionSheet>
  );
}

// Inline usage summary shown at the bottom of the + sheet. Subscribes to the
// shared usage store only while the sheet is mounted, so no background timer
// per composer — updates arrive pushed from the desktop/remote bridge.
function UsageBlock({ agent }: { agent: AgentId | null }) {
  const { report, error } = useProviderUsage();

  const providers = report?.providers ?? [];
  const pinned = agent ? providers.find((p) => p.id === agent) : null;
  const primary = pinned ?? providers[0] ?? null;
  const meta = primary ? AGENTS.find((a) => a.id === primary.id) : null;
  const agentName = meta?.name ?? primary?.id ?? 'Provider';
  const agentColor = meta?.color ?? '#888';

  return (
    <div
      data-usage-generated-at={report?.generatedAt ?? ''}
      className="mt-2 rounded-2xl border border-white/[0.06] bg-white/[0.02] p-3"
    >
      <div className="mb-2 flex items-center gap-2">
        <Gauge className="h-4 w-4 text-muted-foreground/75" />
        <span className="text-[12px] font-medium text-foreground">
          {primary ? `${agentName} usage` : 'Provider usage'}
        </span>
        {primary && (
          <span
            className="ml-auto h-1.5 w-1.5 rounded-full"
            style={{ backgroundColor: agentColor, boxShadow: `0 0 6px ${agentColor}66` }}
          />
        )}
      </div>
      {error && <div className="text-[11px] text-rose-300/90">{error}</div>}
      {!error && !report && (
        <div className="text-[11px] text-muted-foreground/70">Reading local usage…</div>
      )}
      {!error && report && !primary && (
        <div className="text-[11px] text-muted-foreground/70">
          No provider data yet — run an agent locally to populate usage meters.
        </div>
      )}
      {primary && (
        <div className="flex flex-col gap-1.5">
          <UsageRow label="5-hour session" meter={primary.session} />
          <UsageRow label="Weekly" meter={primary.weekly} />
        </div>
      )}
    </div>
  );
}

function UsageRow({
  label,
  meter,
}: {
  label: string;
  meter: ProviderUsageMeter | undefined;
}) {
  const pct =
    typeof meter?.percent === 'number' ? Math.max(0, Math.min(100, meter.percent)) : null;
  const tone =
    pct === null
      ? 'bg-white/20'
      : pct >= 90
        ? 'bg-rose-400'
        : pct >= 70
          ? 'bg-amber-400'
          : 'bg-foreground/70';
  return (
    <div className="flex items-center gap-2 text-[11.5px]">
      <span className="w-28 shrink-0 text-muted-foreground/75">{label}</span>
      <span className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-white/[0.08]">
        <span
          className={cn('absolute inset-y-0 left-0 transition-[width] duration-500', tone)}
          style={{ width: `${pct ?? 0}%` }}
        />
      </span>
      <span className="w-10 shrink-0 text-right tabular-nums text-foreground/80">
        {pct === null ? '—' : `${pct.toFixed(pct < 10 ? 1 : 0)}%`}
      </span>
    </div>
  );
}
