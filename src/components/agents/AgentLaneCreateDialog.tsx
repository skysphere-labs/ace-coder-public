import { useEffect, useMemo, useState } from 'react';
import { Bot, Loader2, Sparkles, X } from 'lucide-react';
import { aceApi } from '../../lib/ace-api';
import type { AgentLane, OrchestratorTemplate } from '../../lib/agent-lanes';
import { defaultLabelForTemplate } from '../../lib/agent-lanes';
import { cn } from '../../lib/utils';
import AgentLogo from '../ProviderGlyph';

export function AgentLaneCreateDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (lane: AgentLane) => void;
}) {
  const [templates, setTemplates] = useState<OrchestratorTemplate[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    aceApi.agentLanes
      .listOrchestratorTemplates()
      .then((result) => {
        if (cancelled) return;
        const next = result.templates ?? [];
        setTemplates(next);
        const preferred = next.find((template) => template.id.startsWith('hermes-profile:vector'))
          ?? next.find((template) => template.agent === 'claude' && template.launchable)
          ?? next.find((template) => template.launchable)
          ?? next[0]
          ?? null;
        setSelectedId(preferred?.id ?? null);
        setLabel(preferred ? defaultLabelForTemplate(preferred) : '');
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const selected = useMemo(
    () => templates.find((template) => template.id === selectedId) ?? null,
    [templates, selectedId]
  );

  if (!open) return null;

  const create = async () => {
    if (!selected || creating) return;
    setCreating(true);
    setError(null);
    try {
      const lane = await aceApi.agentLanes.create({
        label: label.trim() || defaultLabelForTemplate(selected),
        agent: selected.agent,
        providerKind: selected.providerKind,
        profileId: selected.profileId ?? null,
        profileHome: selected.profileHome ?? null,
        autoStart: true,
      });
      onCreated(lane);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="absolute inset-0 z-[80] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <div className="glass-surface flex max-h-[min(720px,calc(100dvh-2rem))] w-[42rem] max-w-full flex-col overflow-hidden rounded-2xl border border-white/[0.08] text-foreground shadow-2xl">
        <div className="flex shrink-0 items-center justify-between border-b border-white/[0.08] px-4 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-sky-400/10 text-sky-200">
              <Bot className="h-4.5 w-4.5" />
            </div>
            <div className="min-w-0">
              <h2 className="truncate text-sm font-semibold">Add orchestrator agent</h2>
              <p className="truncate text-xs text-foreground/50">Create a persistent Agents tab from Claude, Hermes, or a Hermes profile.</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-foreground/50 hover:bg-white/[0.06] hover:text-foreground"
            aria-label="Close add orchestrator dialog"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-foreground/55">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading orchestrator templates…
            </div>
          ) : templates.length === 0 ? (
            <div className="rounded-xl border border-white/[0.08] bg-white/[0.03] p-4 text-sm text-foreground/60">
              No orchestrator templates were detected yet. Install Hermes or Claude Code, then reopen this dialog.
            </div>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {templates.map((template) => {
                const selectedTemplate = template.id === selectedId;
                return (
                  <button
                    key={template.id}
                    type="button"
                    onClick={() => {
                      setSelectedId(template.id);
                      setLabel(defaultLabelForTemplate(template));
                    }}
                    className={cn(
                      'flex min-h-[7rem] flex-col items-start gap-2 rounded-xl border p-3 text-left transition-colors',
                      selectedTemplate
                        ? 'border-sky-300/40 bg-sky-400/10 text-foreground'
                        : 'border-white/[0.08] bg-white/[0.03] text-foreground/70 hover:border-white/[0.16] hover:bg-white/[0.06]'
                    )}
                  >
                    <div className="flex w-full items-center justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-2">
                        {template.providerKind === 'hermes-profile' ? (
                          <Sparkles className="h-4 w-4 shrink-0 text-sky-200" />
                        ) : (
                          <AgentLogo agent={template.agent} className="h-4 w-4 shrink-0" />
                        )}
                        <span className="truncate text-sm font-medium">{template.label}</span>
                      </div>
                      <span className={cn('h-1.5 w-1.5 rounded-full', template.launchable ? 'bg-emerald-300' : 'bg-amber-300')} />
                    </div>
                    <p className="line-clamp-2 text-xs text-foreground/50">{template.description}</p>
                    {(template.modelName || template.terminalCwd || template.reason) && (
                      <p className="line-clamp-2 text-[11px] text-foreground/38">
                        {template.modelName ? `${template.modelProvider ?? 'model'} / ${template.modelName}` : template.reason ?? template.terminalCwd}
                      </p>
                    )}
                  </button>
                );
              })}
            </div>
          )}

          <label className="mt-4 block text-xs font-medium text-foreground/55">
            Lane label
            <input
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              className="mt-1 w-full rounded-xl border border-white/[0.08] bg-black/30 px-3 py-2 text-sm text-foreground outline-none placeholder:text-foreground/30 focus:border-sky-300/40"
              placeholder="Vector, Claude PM, Hermes Ops…"
            />
          </label>

          {error && <p className="mt-3 text-xs text-rose-300/85">{error}</p>}
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-white/[0.08] px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-3 py-2 text-sm text-foreground/55 hover:bg-white/[0.06] hover:text-foreground"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void create()}
            disabled={!selected || creating}
            className={cn(
              'inline-flex items-center gap-2 rounded-lg bg-sky-400/15 px-3 py-2 text-sm font-medium text-sky-100 hover:bg-sky-400/25',
              (!selected || creating) && 'opacity-50'
            )}
          >
            {creating && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {creating ? 'Creating…' : 'Create lane'}
          </button>
        </div>
      </div>
    </div>
  );
}
