import { useEffect, useState } from 'react';
import {
  Play,
  Pencil,
  Square,
  Trash2,
  ShieldAlert,
  ScrollText,
  SlidersHorizontal,
  FileInput,
  Clock,
  Lock,
} from 'lucide-react';
import { PanelShell } from '../atoms/PanelShell';
import { SectionHeader } from '../atoms/SectionHeader';
import { SegmentedControl, type SegmentedOption } from '../molecules/SegmentedControl';
import { EmptyState } from '../atoms/states';
import { Chip } from '../atoms/Chip';
import { Button } from '../../ui/button';
import { cn, formatRelativeTime } from '../../../lib/utils';
import { aceApi } from '../../../lib/ace-api';
import type { LoopSpec, LoopPermission } from '../../../runtime/loops-registry';

// ─── LoopDetailPane ───────────────────────────────────────────────────────────
// Middle pane (PRD §6): Overview / Options(runtime contract) / Inputs sub-tabs for
// the selected loop, plus the action row [Run][Edit][Stop][Delete]. Run / Delete
// are gated by a ConfirmDialog owned by the parent (LoopsTab); this pane raises
// intent via the on* callbacks. A spec stuck at UNSAFE_REQUIRES_APPROVAL (an
// owner-approval permission without ack) is surfaced and Run is disabled.

type DetailSubTab = 'overview' | 'options' | 'inputs';

const SUBTABS: SegmentedOption<DetailSubTab>[] = [
  { value: 'overview', label: 'Overview', icon: ScrollText },
  { value: 'options', label: 'Options', icon: SlidersHorizontal },
  { value: 'inputs', label: 'Inputs', icon: FileInput },
];

// The owner-approval permission set (PRD §7) — present here only to flag an
// unsafe spec; the authoritative gate is lockOnLoopSpec (fail-closed).
const OWNER_APPROVAL_PERMISSIONS: LoopPermission[] = [
  'merge_to_main',
  'deploy_prod',
  'spend_money',
  'send_external_message',
  'delete_or_archive_data',
];

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs uppercase tracking-wide text-foreground/45">{label}</dt>
      <dd className="text-[13px] text-foreground/85">{value}</dd>
    </div>
  );
}

function OverviewPanel({ loop }: { loop: LoopSpec }) {
  return (
    <dl className="flex flex-col gap-3">
      <Field label="Description" value={loop.description || '—'} />
      <Field label="Use when" value={loop.useWhen || '—'} />
      <Field label="Kind" value={<span className="uppercase">{loop.kind}</span>} />
      <Field
        label="Goal template"
        value={
          <pre className="whitespace-pre-wrap rounded-md border border-white/[0.06] bg-black/30 px-2.5 py-2 font-mono text-xs leading-relaxed text-foreground/80">
            {loop.goalTemplate || '—'}
          </pre>
        }
      />
      <Field
        label="Routing"
        value={
          <span className="font-mono text-xs">
            agent={loop.routing.agent} · workspace={loop.routing.workspace}
            {loop.routing.target.workspace && loop.routing.target.workspace !== 'loops'
              ? ` · target=${loop.routing.target.workspace}`
              : ''}
            {loop.routing.target.repo ? ` · repo=${loop.routing.target.repo}` : ''}
          </span>
        }
      />
      {Array.isArray(loop.triggers) && loop.triggers.length > 0 && (
        <Field
          label="Triggers"
          value={
            <div className="flex flex-wrap gap-1">
              {loop.triggers.map((t, i) => (
                <span
                  key={t.id || i}
                  className={`rounded border px-1.5 py-0.5 font-mono text-[11px] ${
                    t.enabled
                      ? 'border-amber-500/30 bg-amber-500/[0.08] text-amber-200'
                      : 'border-white/[0.08] bg-white/[0.02] text-foreground/45'
                  }`}
                >
                  {t.kind === 'schedule'
                    ? t.everyMs
                      ? `every ${Math.round(t.everyMs / 60_000)}m`
                      : `daily ${t.dailyAt}`
                    : `event:${t.event}`}
                  {t.enabled ? '' : ' (off)'}
                </span>
              ))}
            </div>
          }
        />
      )}
      {loop.routing.skills.length > 0 && (
        <Field
          label="Skills"
          value={
            <div className="flex flex-wrap gap-1">
              {loop.routing.skills.map((skill) => (
                <span
                  key={skill}
                  className="rounded bg-white/[0.05] px-1.5 py-0.5 font-mono text-xs text-foreground/70"
                >
                  {skill}
                </span>
              ))}
            </div>
          }
        />
      )}
    </dl>
  );
}

function OptionsPanel({ loop }: { loop: LoopSpec }) {
  const { contract } = loop;
  const ceilings = contract.ceilings ?? {};
  const ceilingEntries = Object.entries(ceilings).filter(([, v]) => v != null);
  return (
    <dl className="flex flex-col gap-3">
      <Field label="Stop primary" value={contract.stop.primary} />
      <Field
        label="Ceilings"
        value={
          ceilingEntries.length === 0 ? (
            <span className="text-foreground/55">Unset — stop on converged / no-progress</span>
          ) : (
            <div className="flex flex-wrap gap-1">
              {ceilingEntries.map(([k, v]) => (
                <span
                  key={k}
                  className="rounded bg-white/[0.05] px-1.5 py-0.5 font-mono text-xs text-foreground/70"
                >
                  {k}={String(v)}
                </span>
              ))}
            </div>
          )
        }
      />
      <Field
        label="Verify"
        value={
          <span className="font-mono text-xs">
            validatorPass={String(contract.verify.requireValidatorPass)} · computerUse=
            {String(contract.verify.requireComputerUseEvidence)}
          </span>
        }
      />
      <Field
        label="Merge"
        value={
          <span className="font-mono text-xs">
            ownerGated={String(contract.merge.ownerGated)}
            {contract.merge.tokenRef ? ` · token=${contract.merge.tokenRef}` : ' · no token'}
          </span>
        }
      />
      <Field
        label="Permissions"
        value={
          contract.permissions.length === 0 ? (
            <span className="text-foreground/55">Autonomous only (read / branch / evidence)</span>
          ) : (
            <div className="flex flex-wrap gap-1">
              {contract.permissions.map((perm) => (
                <span
                  key={perm}
                  className={cn(
                    'rounded px-1.5 py-0.5 font-mono text-xs',
                    OWNER_APPROVAL_PERMISSIONS.includes(perm)
                      ? 'bg-amber-500/15 text-amber-200'
                      : 'bg-white/[0.05] text-foreground/70'
                  )}
                >
                  {perm}
                </span>
              ))}
            </div>
          )
        }
      />
    </dl>
  );
}

function InputsPanel({ loop }: { loop: LoopSpec }) {
  const entries = Object.entries(loop.inputs ?? {});
  if (entries.length === 0) {
    return <EmptyState label="No declared inputs" hint="This loop runs from its goal template alone." />;
  }
  return (
    <pre className="overflow-x-auto whitespace-pre-wrap rounded-md border border-white/[0.06] bg-black/30 px-2.5 py-2 font-mono text-xs leading-relaxed text-foreground/80">
      {JSON.stringify(loop.inputs, null, 2)}
    </pre>
  );
}

// ─── System loop detail (PRD §10 / GRILLED DESIGN #2) ──────────────────────────
// A builtin kind==='system' loop has no agent-iteration contract to show. Instead
// we surface its schedule, last run (from loopStatus().system), and a Run-now
// control disabled with an owner-approval hint when the spec carries a gated
// permission and is not acked.

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' && v ? v : fallback;
}

function SystemDetailPane({
  loop,
  onRun,
}: {
  loop: LoopSpec;
  onRun: (loop: LoopSpec) => void;
}) {
  const [system, setSystem] = useState<Record<string, unknown> | null>(null);

  // System loops have no ledger lineage; pull the matching scheduler state via
  // loops.status({ id }) (returns { system }). Best-effort — a missing reader
  // just leaves the digest empty.
  useEffect(() => {
    let cancelled = false;
    aceApi.loops
      .status({ id: loop.id })
      .then((res) => {
        if (cancelled) return;
        const sys = (res?.system ?? null) as Record<string, unknown> | null;
        setSystem(sys);
      })
      .catch(() => {
        if (!cancelled) setSystem(null);
      });
    return () => {
      cancelled = true;
    };
  }, [loop.id]);

  // Owner-approval gate: a system loop carrying a gated permission (e.g.
  // delete_or_archive_data) cannot Run-now until the owner acks. The saved spec
  // has no ack representation, so we treat any gated permission as locked.
  const gated = loop.contract.permissions.some((p) =>
    OWNER_APPROVAL_PERMISSIONS.includes(p)
  );
  const lastAt = str((system?.state as Record<string, unknown> | undefined)?.at);

  return (
    <PanelShell className="h-full min-h-0">
      <SectionHeader
        title={loop.name}
        icon={Clock}
        tone="sky"
        leading={
          <Chip tone="sky" className="uppercase tracking-wide">
            <Lock className="h-3 w-3" aria-hidden="true" />
            system
          </Chip>
        }
        actions={
          <Button
            variant="default"
            size="sm"
            onClick={() => onRun(loop)}
            disabled={gated}
            className="h-7 gap-1 px-2 text-xs"
            title={gated ? 'Needs owner approval (gated permission)' : 'Run this maintenance loop now'}
          >
            <Play className="h-3.5 w-3.5" aria-hidden="true" />
            Run now
          </Button>
        }
      />

      {gated && (
        <div className="flex items-center gap-2 rounded-md border border-amber-500/25 bg-amber-500/[0.08] px-3 py-2 text-xs text-amber-100">
          <ShieldAlert className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          Needs owner approval — this loop requests a gated permission
          {loop.contract.permissions.length > 0
            ? ` (${loop.contract.permissions.join(', ')})`
            : ''}{' '}
          and stays disabled until acknowledged.
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        <dl className="flex flex-col gap-3">
          <Field label="Description" value={loop.description || '—'} />
          <Field label="Use when" value={loop.useWhen || '—'} />
          <Field
            label="Schedule"
            value={
              loop.schedule ? (
                <span className="inline-flex items-center gap-1.5 font-mono text-xs text-foreground/85">
                  <Clock className="h-3 w-3 text-foreground/45" aria-hidden="true" />
                  {loop.schedule}
                </span>
              ) : (
                '—'
              )
            }
          />
          <Field
            label="Last run"
            value={
              lastAt ? (
                <span title={lastAt}>{formatRelativeTime(lastAt) || lastAt}</span>
              ) : (
                <span className="text-foreground/55">Never run</span>
              )
            }
          />
          {loop.contract.permissions.length > 0 && (
            <Field
              label="Permissions"
              value={
                <div className="flex flex-wrap gap-1">
                  {loop.contract.permissions.map((perm) => (
                    <Chip
                      key={perm}
                      tone={OWNER_APPROVAL_PERMISSIONS.includes(perm) ? 'amber' : 'neutral'}
                    >
                      {perm}
                    </Chip>
                  ))}
                </div>
              }
            />
          )}
        </dl>
      </div>
    </PanelShell>
  );
}

export function LoopDetailPane({
  loop,
  isRunning,
  onRun,
  onEdit,
  onStop,
  onDelete,
}: {
  loop: LoopSpec | null;
  isRunning: boolean;
  onRun: (loop: LoopSpec) => void;
  onEdit: (loop: LoopSpec) => void;
  onStop: (loop: LoopSpec) => void;
  onDelete: (loop: LoopSpec) => void;
}) {
  const [subTab, setSubTab] = useState<DetailSubTab>('overview');

  if (!loop) {
    return (
      <PanelShell className="h-full min-h-0">
        <SectionHeader title="Loop detail" icon={ScrollText} />
        <div className="flex flex-1 items-center justify-center">
          <EmptyState
            label="No loop selected"
            hint="Pick a loop from the catalog, or forge a new one."
          />
        </div>
      </PanelShell>
    );
  }

  // System loops (PRD §10) are kind-aware: schedule / last-run / Run-now + a
  // result/summary surface, NOT the agent Overview/Options/Inputs sub-tabs.
  if (loop.kind === 'system') {
    return <SystemDetailPane loop={loop} onRun={onRun} />;
  }

  // A spec carrying an owner-approval permission has no ack representation in the
  // saved spec (lock-on strips unsafe drafts), but we still guard Run defensively
  // when the contract declares one of the gated permissions.
  const unsafe = loop.contract.permissions.some((p) =>
    OWNER_APPROVAL_PERMISSIONS.includes(p)
  );

  return (
    <PanelShell className="h-full min-h-0">
      <SectionHeader
        title={loop.name}
        icon={ScrollText}
        tone="sky"
        actions={
          <div className="flex items-center gap-1.5">
            <Button
              variant="default"
              size="sm"
              onClick={() => onRun(loop)}
              disabled={isRunning || unsafe}
              className="h-7 gap-1 px-2 text-xs"
              title={unsafe ? 'Requires owner approval (gated permission)' : 'Run this loop'}
            >
              <Play className="h-3.5 w-3.5" aria-hidden="true" />
              Run
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => onStop(loop)}
              disabled={!isRunning}
              className="h-7 gap-1 px-2 text-xs"
            >
              <Square className="h-3.5 w-3.5" aria-hidden="true" />
              Stop
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => onEdit(loop)}
              className="h-7 gap-1 px-2 text-xs"
            >
              <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
              Edit
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => onDelete(loop)}
              className="h-7 gap-1 px-2 text-xs text-rose-200 hover:text-rose-100"
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              Delete
            </Button>
          </div>
        }
      />

      {unsafe && (
        <div className="flex items-center gap-2 rounded-md border border-amber-500/25 bg-amber-500/[0.08] px-3 py-2 text-xs text-amber-100">
          <ShieldAlert className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          This loop declares an owner-approval permission and cannot run autonomously.
        </div>
      )}

      <SegmentedControl options={SUBTABS} value={subTab} onChange={setSubTab} ariaLabel="Loop detail section" />

      <div className="min-h-0 flex-1 overflow-y-auto">
        {subTab === 'overview' && <OverviewPanel loop={loop} />}
        {subTab === 'options' && <OptionsPanel loop={loop} />}
        {subTab === 'inputs' && <InputsPanel loop={loop} />}
      </div>
    </PanelShell>
  );
}
