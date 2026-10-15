// Props-driven Hermes Desktop surface section. No IPC here — a glue component
// in PreferencesScreen mounts this and wires aceApi.hermesDesktop through.
// A null status means the dashboard-manager namespace is absent in this
// build: the segmented control renders disabled on the lanes default.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '../../lib/utils';
import { aceApi } from '../../lib/ace-api';
import { SettingsRow, SettingsSection } from './primitives';
import {
  describeHermesSurface,
  HERMES_SURFACE_OPTIONS,
  HERMES_SURFACE_ROW_TITLE,
  HERMES_SURFACE_SECTION_TITLE,
  type HermesDesktopStatusLike,
  type HermesSurface,
} from './hermes-surface-logic';

export function HermesSurfaceSection({
  status,
  onSetSurface,
}: {
  status: HermesDesktopStatusLike | null;
  onSetSurface: (surface: HermesSurface) => void;
}) {
  const view = describeHermesSurface(status);
  return (
    <SettingsSection title={HERMES_SURFACE_SECTION_TITLE}>
      <SettingsRow
        title={HERMES_SURFACE_ROW_TITLE}
        description={
          view.runningDetail ? (
            <>
              {view.detail}
              <span className="mt-1 block text-foreground/70">{view.runningDetail}</span>
            </>
          ) : (
            view.detail
          )
        }
        action={
          <div
            className={cn(
              'inline-flex h-7 shrink-0 overflow-hidden rounded-full border border-white/[0.07] bg-white/[0.02] p-0.5',
              !view.enabled && 'pointer-events-none opacity-50'
            )}
          >
            {HERMES_SURFACE_OPTIONS.map((option) => (
              <SurfaceOption
                key={option.id}
                value={option.id}
                current={view.surface}
                label={option.label}
                disabled={!view.enabled}
                onSelect={onSetSurface}
              />
            ))}
          </div>
        }
      />
      <HermesUpdateRow enabled={view.enabled} />
    </SettingsSection>
  );
}

// "Update Hermes" row. Manual only: no background version check, timer, or
// monitoring collector. The explicit action still runs the safe branch-aware
// update (rebase ace/patches + patch-guard + rebuild).
function HermesUpdateRow({ enabled }: { enabled: boolean }) {
  const [applyState, setApplyState] = useState<'idle' | 'updating' | 'done' | 'error'>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const apply = useCallback(async () => {
    if (!aceApi.hermesDesktop?.applyUpdate) return;
    setApplyState('updating');
    setMessage('Updating Hermes — rebasing patches, verifying, and rebuilding the desktop app. This can take a few minutes…');
    try {
      const res = await aceApi.hermesDesktop.applyUpdate({ rebuild: true });
      if (!mounted.current) return;
      if (res?.ok) {
        setApplyState('done');
        setMessage('Hermes updated. The embed reconnects on the new version automatically.');
      } else {
        setApplyState('error');
        setMessage(res?.message || `Update failed (${res?.reason || 'unknown'}). Your checkout was left unchanged.`);
      }
    } catch (err) {
      if (mounted.current) {
        setApplyState('error');
        setMessage(err instanceof Error ? err.message : 'Update failed.');
      }
    }
  }, []);

  const phase = applyState;
  const busy = applyState === 'updating';
  const badge =
    phase === 'updating' ? 'Updating…'
    : phase === 'done' ? 'Updated'
    : phase === 'error' ? 'Needs retry'
    : '';

  return (
    <SettingsRow
      title="Hermes version"
      description={
        message ? (
          <span className={cn(phase === 'error' && 'text-rose-300/85')}>{message}</span>
        ) : (
          'Update the embedded Hermes agent + desktop app to the latest upstream, keeping your local patches (safe rebase — never a hard reset).'
        )
      }
      action={
        <div className="inline-flex items-center gap-2">
          {badge && (
            <span
              className={cn(
                'rounded-full px-2 py-0.5 text-[10.5px] font-medium',
                phase === 'done' ? 'bg-emerald-400/12 text-emerald-200/90'
                  : phase === 'error' ? 'bg-rose-400/12 text-rose-200/90'
                  : 'bg-white/[0.06] text-foreground/60'
              )}
            >
              {badge}
            </span>
          )}
          <button
            type="button"
            onClick={apply}
            disabled={!enabled || busy}
            className={cn(
              'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-white/[0.08] bg-white/[0.04] px-3 text-[11.5px] font-medium text-foreground transition-colors hover:bg-white/[0.08]',
              (!enabled || busy) && 'pointer-events-none opacity-50'
            )}
          >
            {busy && <Loader2 className="h-3 w-3 animate-spin" />}
            {applyState === 'updating' ? 'Updating…' : 'Update Hermes'}
          </button>
        </div>
      }
    />
  );
}

// Segmented option modeled on PreferencesScreen's DefaultViewOption.
function SurfaceOption({
  value,
  current,
  label,
  disabled,
  onSelect,
}: {
  value: HermesSurface;
  current: HermesSurface;
  label: string;
  disabled: boolean;
  onSelect: (surface: HermesSurface) => void;
}) {
  const active = current === value;
  return (
    <button
      type="button"
      onClick={() => onSelect(value)}
      aria-pressed={active}
      disabled={disabled}
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2.5 text-[11.5px] font-medium transition-colors',
        active
          ? 'bg-white/[0.08] text-foreground'
          : 'text-muted-foreground hover:text-foreground'
      )}
    >
      {label}
    </button>
  );
}
