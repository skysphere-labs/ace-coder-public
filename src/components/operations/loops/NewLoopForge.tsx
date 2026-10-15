import { useState } from 'react';
import { Lock, Sparkles, Wand2, X } from 'lucide-react';
import { PanelShell } from '../atoms/PanelShell';
import { SectionHeader } from '../atoms/SectionHeader';
import { ErrorState } from '../atoms/states';
import { Button } from '../../ui/button';
import { compileLoop, lockOnLoop, saveLoop } from '../../../runtime/loops-registry';
import type { LoopSpec, LoopSpecDraft } from '../../../runtime/loops-registry';

// ─── NewLoopForge ─────────────────────────────────────────────────────────────
// The forge (PRD §6): a text box → loops.lockOn(draftFromText) → proposed LoopSpec
// preview → operator reviews/tweaks the name/kind/repo → "Lock On" (fail-closed
// validate) → loops.save → appears in the catalog. lockOn is the authoritative
// gate: an incomplete/unsafe draft returns errors and never locks.
//
// v1 deterministic draft-fill (PRD §5 loop-forge): we shape a LoopSpecDraft from
// the operator's text + a few explicit fields and hand it to lockOnLoopSpec, which
// fills/validates the rest. We do NOT invent the spec on the renderer.

// Build a draft from the operator's intent text + explicit fields. lock-on
// fail-closes on anything missing, so we send a complete-enough scaffold and let
// the operator iterate on the returned errors.
function draftFromText(input: {
  text: string;
  name: string;
  kind: 'code' | 'agentic';
  repo: string;
  allow: string;
  /** optional execution-target workspace (cross-workspace targeting; default loops). */
  targetWorkspace: string;
  /** agentic only: require a real computer-use attestation to count an iteration converged. */
  requireComputerUseEvidence: boolean;
  /** agentic only: free-text description of what each iteration must produce to ship. */
  evidenceCriteria: string;
  /** optional schedule trigger: fire every N minutes (0 = none). */
  everyMinutes: number;
  /** optional schedule trigger: fire daily at HH:MM (empty = none). */
  dailyAt: string;
}): LoopSpecDraft {
  const text = input.text.trim();
  const allowList = input.allow
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const isAgentic = input.kind === 'agentic';
  const criteria = input.evidenceCriteria.trim();
  const targetWorkspace = input.targetWorkspace.trim();
  // Build an optional schedule trigger (PRD §9 Slice 3). everyMinutes >= 1 ⇒ interval
  // (clamped to the 60s floor by validate); else a valid dailyAt ⇒ daily.
  const triggers: NonNullable<LoopSpecDraft['triggers']> = [];
  if (Number.isFinite(input.everyMinutes) && input.everyMinutes >= 1) {
    triggers.push({ kind: 'schedule', enabled: true, everyMs: Math.round(input.everyMinutes * 60_000) });
  } else if (/^([01]?\d|2[0-3]):([0-5]\d)$/.test(input.dailyAt.trim())) {
    triggers.push({ kind: 'schedule', enabled: true, dailyAt: input.dailyAt.trim() });
  }
  return {
    name: input.name.trim() || 'Untitled loop',
    description: text,
    useWhen: text,
    kind: input.kind,
    goalTemplate: text,
    routing: {
      agent: 'auto',
      skills: [],
      workspace: 'loops',
      target:
        input.kind === 'code'
          ? { repo: input.repo.trim(), allow: allowList, ...(targetWorkspace ? { workspace: targetWorkspace } : {}) }
          : { allow: [], ...(targetWorkspace ? { workspace: targetWorkspace } : {}) },
    },
    contract: {
      stop: { primary: 'converged' },
      ceilings: {},
      verify: {
        // code loops gate on a validator pass; agentic loops finish on evidence
        // (no validator/PR) and optionally on a real computer-use attestation.
        requireValidatorPass: input.kind === 'code',
        requireComputerUseEvidence: isAgentic ? input.requireComputerUseEvidence : false,
      },
      permissions: [],
      merge: { ownerGated: true },
    },
    inputs: {},
    // The agentic completion contract (PRD §1/§9): what each iteration must produce
    // to ingest cleanly. Optional descriptor — surfaced to the worker via the goal,
    // not a hard schema gate in v1.
    evidence: isAgentic && criteria ? { criteria } : {},
    ...(triggers.length ? { triggers } : {}),
  } as LoopSpecDraft;
}

export function NewLoopForge({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: (spec: LoopSpec) => void;
}) {
  const [text, setText] = useState('');
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'code' | 'agentic'>('code');
  const [repo, setRepo] = useState('');
  const [allow, setAllow] = useState('');
  const [requireCu, setRequireCu] = useState(false);
  const [evidenceCriteria, setEvidenceCriteria] = useState('');
  const [targetWorkspace, setTargetWorkspace] = useState('');
  const [everyMinutes, setEveryMinutes] = useState('');
  const [dailyAt, setDailyAt] = useState('');
  const [proposed, setProposed] = useState<LoopSpec | null>(null);
  const [errors, setErrors] = useState<string[] | null>(null);
  const [notes, setNotes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);

  // Compile the free-text intent through the backend forge (loop-forge.compileFromNL
  // — deterministic kind/agent/repo inference), then fill the explicit fields so the
  // operator reviews/tweaks before Lock On. "It builds the loop using our framework."
  const handleCompile = async () => {
    if (!text.trim()) return;
    setBusy(true);
    setErrors(null);
    try {
      const { draft, notes: inferred } = await compileLoop(text);
      const r = (draft.routing ?? {}) as NonNullable<LoopSpecDraft['routing']>;
      const target = (r.target ?? {}) as { repo?: string; allow?: string[] };
      const verify = (draft.contract?.verify ?? {}) as {
        requireComputerUseEvidence?: boolean;
      };
      const ev = (draft.evidence ?? {}) as { criteria?: string };
      if (draft.name) setName(String(draft.name));
      if (draft.kind === 'code' || draft.kind === 'agentic') setKind(draft.kind);
      setRepo(target.repo ? String(target.repo) : '');
      setAllow(Array.isArray(target.allow) ? target.allow.join(', ') : '');
      setTargetWorkspace(
        (target as { workspace?: string }).workspace ? String((target as { workspace?: string }).workspace) : '',
      );
      setRequireCu(verify.requireComputerUseEvidence === true);
      setEvidenceCriteria(ev.criteria ? String(ev.criteria) : '');
      setNotes(inferred ?? null);
      setProposed(null);
    } catch (err) {
      setErrors([err instanceof Error ? err.message : String(err)]);
    } finally {
      setBusy(false);
    }
  };

  const handleLockOn = async () => {
    setBusy(true);
    setErrors(null);
    try {
      const draft = draftFromText({
        text,
        name,
        kind,
        repo,
        allow,
        targetWorkspace,
        requireComputerUseEvidence: requireCu,
        evidenceCriteria,
        everyMinutes: Number(everyMinutes) || 0,
        dailyAt,
      });
      const result = await lockOnLoop(draft);
      if (result.spec) {
        setProposed(result.spec);
        setErrors(null);
      } else {
        setProposed(null);
        setErrors(result.errors ?? ['Lock-on failed (no spec returned)']);
      }
    } catch (err) {
      setErrors([err instanceof Error ? err.message : String(err)]);
    } finally {
      setBusy(false);
    }
  };

  const handleSave = async () => {
    if (!proposed) return;
    setBusy(true);
    try {
      const saved = await saveLoop(proposed);
      onSaved(saved);
    } catch (err) {
      setErrors([err instanceof Error ? err.message : String(err)]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <PanelShell className="h-full min-h-0">
      <SectionHeader
        title="New Loop"
        icon={Sparkles}
        tone="sky"
        actions={
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            className="h-7 w-7 p-0 text-foreground/60"
            aria-label="Close forge"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </Button>
        }
      />

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
        <label className="flex flex-col gap-1">
          <span className="text-xs uppercase tracking-wide text-foreground/45">Describe the loop</span>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={4}
            placeholder="e.g. Harden CI until Spine Guard is green 3× straight. Verify with a validator pass each iteration."
            className="resize-y rounded-md border border-white/[0.08] bg-black/30 px-2.5 py-2 text-[13px] text-foreground placeholder:text-foreground/35 focus:border-sky-500/40 focus:outline-none"
          />
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-foreground/40">
              Compile infers kind, agent &amp; repo from the framework — then tweak below.
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={handleCompile}
              disabled={busy || !text.trim()}
              className="h-7 gap-1.5 text-xs"
            >
              <Wand2 className="h-3.5 w-3.5" aria-hidden="true" />
              Compile from intent
            </Button>
          </div>
        </label>

        {notes && notes.length > 0 && (
          <div className="flex flex-col gap-1 rounded-md border border-sky-500/25 bg-sky-500/[0.06] px-3 py-2">
            <span className="text-[11px] font-medium uppercase tracking-wide text-sky-200">
              Compiler inferred
            </span>
            <ul className="flex flex-col gap-0.5 text-xs text-foreground/75">
              {notes.map((n, i) => (
                <li key={i} className="font-mono">
                  · {n}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="grid grid-cols-2 gap-2">
          <label className="flex flex-col gap-1">
            <span className="text-xs uppercase tracking-wide text-foreground/45">Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="CI Green"
              className="rounded-md border border-white/[0.08] bg-black/30 px-2.5 py-1.5 text-[13px] text-foreground placeholder:text-foreground/35 focus:border-sky-500/40 focus:outline-none"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs uppercase tracking-wide text-foreground/45">Kind</span>
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value as 'code' | 'agentic')}
              className="rounded-md border border-white/[0.08] bg-black/30 px-2.5 py-1.5 text-[13px] text-foreground focus:border-sky-500/40 focus:outline-none"
            >
              <option value="code">code (worker → validator → PR)</option>
              <option value="agentic">agentic (evidence, no PR)</option>
            </select>
          </label>
        </div>

        {kind === 'code' && (
          <div className="grid grid-cols-1 gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-xs uppercase tracking-wide text-foreground/45">Repo path</span>
              <input
                value={repo}
                onChange={(e) => setRepo(e.target.value)}
                placeholder="/Users/you/Projects/your-repo"
                className="rounded-md border border-white/[0.08] bg-black/30 px-2.5 py-1.5 font-mono text-xs text-foreground placeholder:text-foreground/35 focus:border-sky-500/40 focus:outline-none"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs uppercase tracking-wide text-foreground/45">
                Allow-list paths (comma / newline separated)
              </span>
              <textarea
                value={allow}
                onChange={(e) => setAllow(e.target.value)}
                rows={2}
                placeholder=".github/workflows, scripts/ci"
                className="resize-y rounded-md border border-white/[0.08] bg-black/30 px-2.5 py-1.5 font-mono text-xs text-foreground placeholder:text-foreground/35 focus:border-sky-500/40 focus:outline-none"
              />
            </label>
          </div>
        )}

        {kind === 'agentic' && (
          <div className="grid grid-cols-1 gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-xs uppercase tracking-wide text-foreground/45">
                Evidence criteria — what each iteration must produce to ship (optional)
              </span>
              <textarea
                value={evidenceCriteria}
                onChange={(e) => setEvidenceCriteria(e.target.value)}
                rows={2}
                placeholder="e.g. A dated intel digest with ≥3 sourced findings and a recommended action."
                className="resize-y rounded-md border border-white/[0.08] bg-black/30 px-2.5 py-1.5 text-[13px] text-foreground placeholder:text-foreground/35 focus:border-sky-500/40 focus:outline-none"
              />
            </label>
            <label className="flex items-center gap-2 text-[13px] text-foreground/80">
              <input
                type="checkbox"
                checked={requireCu}
                onChange={(e) => setRequireCu(e.target.checked)}
                className="h-3.5 w-3.5 accent-sky-500"
              />
              <span>Require computer-use evidence to count an iteration converged</span>
            </label>
          </div>
        )}

        <label className="flex flex-col gap-1">
          <span className="text-xs uppercase tracking-wide text-foreground/45">
            Target workspace (optional — default Loops; set to run against another workspace)
          </span>
          <input
            value={targetWorkspace}
            onChange={(e) => setTargetWorkspace(e.target.value)}
            placeholder="loops"
            className="rounded-md border border-white/[0.08] bg-black/30 px-2.5 py-1.5 font-mono text-xs text-foreground placeholder:text-foreground/35 focus:border-sky-500/40 focus:outline-none"
          />
        </label>

        <div className="grid grid-cols-2 gap-2">
          <label className="flex flex-col gap-1">
            <span className="text-xs uppercase tracking-wide text-foreground/45">
              Schedule — every N min (optional)
            </span>
            <input
              value={everyMinutes}
              onChange={(e) => {
                setEveryMinutes(e.target.value);
                if (e.target.value) setDailyAt('');
              }}
              inputMode="numeric"
              placeholder="e.g. 60"
              className="rounded-md border border-white/[0.08] bg-black/30 px-2.5 py-1.5 text-[13px] text-foreground placeholder:text-foreground/35 focus:border-sky-500/40 focus:outline-none"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs uppercase tracking-wide text-foreground/45">
              …or daily at HH:MM (optional)
            </span>
            <input
              value={dailyAt}
              onChange={(e) => {
                setDailyAt(e.target.value);
                if (e.target.value) setEveryMinutes('');
              }}
              placeholder="e.g. 07:00"
              className="rounded-md border border-white/[0.08] bg-black/30 px-2.5 py-1.5 text-[13px] text-foreground placeholder:text-foreground/35 focus:border-sky-500/40 focus:outline-none"
            />
          </label>
        </div>

        {errors && errors.length > 0 && (
          <ErrorState
            message={
              errors.length === 1
                ? errors[0]
                : `${errors.length} issues: ${errors.join(' · ')}`
            }
          />
        )}

        {proposed && (
          <div className="flex flex-col gap-1.5 rounded-md border border-emerald-500/25 bg-emerald-500/[0.06] px-3 py-2.5">
            <span className="text-xs font-medium uppercase tracking-wide text-emerald-200">
              Locked-on spec preview
            </span>
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-black/30 px-2 py-1.5 font-mono text-xs leading-relaxed text-foreground/80">
              {JSON.stringify(proposed, null, 2)}
            </pre>
          </div>
        )}
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-white/[0.06] pt-3">
        <Button variant="outline" size="sm" onClick={onClose} disabled={busy} className="text-xs">
          Cancel
        </Button>
        {!proposed ? (
          <Button
            variant="default"
            size="sm"
            onClick={handleLockOn}
            disabled={busy || text.trim().length === 0}
            className="gap-1.5 text-xs"
          >
            <Lock className="h-3.5 w-3.5" aria-hidden="true" />
            Lock On
          </Button>
        ) : (
          <Button
            variant="default"
            size="sm"
            onClick={handleSave}
            disabled={busy}
            className="gap-1.5 text-xs"
          >
            <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
            Save to catalog
          </Button>
        )}
      </div>
    </PanelShell>
  );
}
