// loop-cli — pure helpers for the `ace loop` command group.
//
// The transport-facing handlers live in index.cts (they call the ace socket's
// loops* methods and print/exit). Everything that is PURE — parsing --input
// key=value pairs, mapping a loop's finishReason onto the CLI exit-code contract,
// and rendering the human tables/pretty views — lives HERE so it is unit-testable
// in isolation with no socket, no process, and no clock (loop-cli.test.cts).
//
// Nothing in this module performs I/O or calls process.exit; it only shapes strings
// and numbers. The handlers own the side effects.

// The terminal finishReasons the outer loop (loop-host LoopFinishReason) can settle
// on. Exposed so the watch path knows when to stop rendering transitions.
const TERMINAL_FINISH_REASONS: ReadonlySet<string> = new Set([
  'converged',
  'no-progress',
  'cap-hit',
  'hard-cap',
  'blocked',
  'killed',
  'spec-not-found',
  'system',
  'error',
]);

export function isTerminalFinishReason(reason: any): boolean {
  return TERMINAL_FINISH_REASONS.has(String(reason));
}

/**
 * Map a loop's finishReason onto the `ace loop run` exit-code contract (WS-F spec):
 *   0  converged  (and a system loop that completed in-process)
 *   2  ran but did NOT converge — no-progress / cap-hit / hard-cap / killed
 *   3  BLOCKED    (a hard block / needs-decision terminal)
 *
 * spec-not-found (unknown loop id) and error (internal throw) are surfaced by the
 * handler as die() (exit 6 / 5) BEFORE this is consulted, so they never reach the
 * default here; the default stays a safe non-zero (2) for any unforeseen reason.
 */
export function loopRunExitCode(finishReason: any): number {
  switch (String(finishReason)) {
    case 'converged':
    case 'system':
      return 0;
    case 'blocked':
      return 3;
    case 'no-progress':
    case 'cap-hit':
    case 'hard-cap':
    case 'killed':
      return 2;
    default:
      return 2;
  }
}

/**
 * Parse repeated `--input key=value` flags into an inputs object. The FIRST `=`
 * splits key from value (later `=` stay in the value); a bare `key` with no `=` maps
 * to boolean true. Blank / non-string entries are skipped. Deterministic + pure.
 */
export function parseInputPairs(pairs: any): Record<string, any> {
  const out: Record<string, any> = {};
  for (const raw of Array.isArray(pairs) ? pairs : []) {
    if (typeof raw !== 'string') continue;
    const s = raw.trim();
    if (!s) continue;
    const eq = s.indexOf('=');
    if (eq === -1) {
      out[s] = true;
      continue;
    }
    const key = s.slice(0, eq).trim();
    if (!key) continue;
    out[key] = s.slice(eq + 1);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Renderers (human, non-JSON mode)
// ---------------------------------------------------------------------------

function padCell(value: any, width: number): string {
  const s = String(value == null ? '' : value);
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

function triggerSummary(spec: any): string {
  const triggers = spec && Array.isArray(spec.triggers) ? spec.triggers : [];
  if (!triggers.length) return '-';
  const kinds = triggers.map((t: any) => (t && t.kind ? String(t.kind) : '?'));
  return `${triggers.length} (${kinds.join(',')})`;
}

/** Render the loop catalog as an aligned table: id, kind, name, builtin, triggers. */
export function renderLoopList(loops: any): string {
  const rows = Array.isArray(loops) ? loops : [];
  if (!rows.length) return 'No loops in the catalog.';
  const header = { id: 'ID', kind: 'KIND', name: 'NAME', builtin: 'BUILTIN', triggers: 'TRIGGERS' };
  const cells = rows.map((spec: any) => ({
    id: String(spec && spec.id ? spec.id : ''),
    kind: String(spec && spec.kind ? spec.kind : ''),
    name: String(spec && spec.name ? spec.name : ''),
    builtin: spec && spec.builtin === true ? 'yes' : 'no',
    triggers: triggerSummary(spec),
  }));
  const widthOf = (key: keyof typeof header) =>
    Math.max(header[key].length, ...cells.map((c: any) => String(c[key]).length));
  const w = {
    id: widthOf('id'),
    kind: widthOf('kind'),
    name: widthOf('name'),
    builtin: widthOf('builtin'),
    triggers: widthOf('triggers'),
  };
  const line = (c: any) =>
    [
      padCell(c.id, w.id),
      padCell(c.kind, w.kind),
      padCell(c.name, w.name),
      padCell(c.builtin, w.builtin),
      padCell(c.triggers, w.triggers),
    ].join('  ');
  const out = [line(header)];
  for (const c of cells) out.push(line(c));
  return out.join('\n');
}

/** Pretty (multi-line, key: value) rendering of one full LoopSpec. */
export function renderLoopShow(spec: any): string {
  if (!spec || typeof spec !== 'object') return 'Loop not found.';
  const routing = spec.routing && typeof spec.routing === 'object' ? spec.routing : {};
  const target = routing.target && typeof routing.target === 'object' ? routing.target : {};
  const contract = spec.contract && typeof spec.contract === 'object' ? spec.contract : {};
  const stop = contract.stop && typeof contract.stop === 'object' ? contract.stop : {};
  const ceilings = contract.ceilings && typeof contract.ceilings === 'object' ? contract.ceilings : {};
  const verify = contract.verify && typeof contract.verify === 'object' ? contract.verify : {};
  const merge = contract.merge && typeof contract.merge === 'object' ? contract.merge : {};
  const permissions = Array.isArray(contract.permissions) ? contract.permissions : [];
  const skills = Array.isArray(routing.skills) ? routing.skills : [];
  const allow = Array.isArray(target.allow) ? target.allow : [];
  const triggers = Array.isArray(spec.triggers) ? spec.triggers : [];

  const lines: string[] = [];
  lines.push(`${spec.name || spec.id} (${spec.id})`);
  lines.push(`  kind:        ${spec.kind || ''}${spec.builtin === true ? ' [builtin]' : ''}`);
  if (spec.description) lines.push(`  description: ${spec.description}`);
  if (spec.useWhen) lines.push(`  useWhen:     ${spec.useWhen}`);
  if (spec.goalTemplate) lines.push(`  goal:        ${spec.goalTemplate}`);
  lines.push('  routing:');
  lines.push(`    agent:     ${routing.agent || ''}`);
  lines.push(`    workspace: ${routing.workspace || ''}`);
  if (skills.length) lines.push(`    skills:    ${skills.join(', ')}`);
  if (target.repo) lines.push(`    repo:      ${target.repo}`);
  if (target.workspaceId) lines.push(`    workspaceId: ${target.workspaceId}`);
  if (allow.length) lines.push(`    allow:     ${allow.join(', ')}`);
  lines.push('  contract:');
  lines.push(`    stop:      ${stop.primary || ''}`);
  const ceilingKeys = Object.keys(ceilings);
  lines.push(`    ceilings:  ${ceilingKeys.length ? ceilingKeys.map((k) => `${k}=${ceilings[k]}`).join(', ') : '(unset)'}`);
  lines.push(`    verify:    validatorPass=${verify.requireValidatorPass === true} computerUse=${verify.requireComputerUseEvidence === true}`);
  lines.push(`    permissions: ${permissions.length ? permissions.join(', ') : '(none)'}`);
  lines.push(`    merge:     ownerGated=${merge.ownerGated === true}${merge.tokenRef ? ` tokenRef=${merge.tokenRef}` : ' (no token — parks)'}`);
  if (triggers.length) {
    lines.push('  triggers:');
    for (const t of triggers) {
      const parts = [t && t.kind ? String(t.kind) : '?', t && t.enabled === false ? 'disabled' : 'enabled'];
      if (t && t.everyMs) parts.push(`everyMs=${t.everyMs}`);
      if (t && t.dailyAt) parts.push(`dailyAt=${t.dailyAt}`);
      if (t && t.event) parts.push(`event=${t.event}`);
      lines.push(`    - ${parts.join(' ')}`);
    }
  }
  return lines.join('\n');
}

/**
 * Render the forge result. `compile` = { draft, notes } from compileLoop; `lock` =
 * { spec } on a successful lock-on, or { errors } fail-closed. `saved` (optional) is
 * the persisted spec when --save succeeded.
 */
export function renderForge(compile: any, lock: any, saved?: any): string {
  const draft = compile && compile.draft ? compile.draft : {};
  const notes = compile && Array.isArray(compile.notes) ? compile.notes : [];
  const lines: string[] = [];
  lines.push(`Proposed loop: ${draft.name || draft.id || '(unnamed)'}${draft.kind ? ` [${draft.kind}]` : ''}`);
  if (notes.length) {
    lines.push('Inference notes:');
    for (const n of notes) lines.push(`  - ${n}`);
  }
  if (lock && lock.spec) {
    lines.push(`Validation: OK (locks on as '${lock.spec.id}')`);
    if (saved && saved.id) lines.push(`Saved to the catalog as '${saved.id}'.`);
    else lines.push('Not saved (re-run with --save to persist).');
  } else {
    const errors = lock && Array.isArray(lock.errors) ? lock.errors : ['lock-on failed'];
    lines.push('Validation: FAILED (fail-closed — not runnable)');
    for (const e of errors) lines.push(`  - ${e}`);
  }
  return lines.join('\n');
}

/**
 * Render a completed `loop run`. In watch mode every iteration transition is listed
 * (the outer loop runs to quiescence in a single call, so this is the transition log
 * the loop produced); a compact final line is always shown last.
 */
export function renderLoopRun(result: any, opts: { watch?: boolean } = {}): string {
  const r = result && typeof result === 'object' ? result : {};
  const iterations = Array.isArray(r.iterations) ? r.iterations : [];
  const lines: string[] = [];
  if (opts.watch) {
    if (!iterations.length) lines.push('(no iterations)');
    for (const it of iterations) {
      const idx = it && it.index != null ? it.index : '?';
      const runId = it && it.runId ? it.runId : '(no run)';
      const cls = it && (it.classification || it.reason) ? it.classification || '' : '';
      const reason = it && it.reason ? it.reason : '';
      lines.push(`  [${idx}] ${runId} ${cls}${reason ? ` — ${reason}` : ''}`);
    }
  }
  const outcome = r.latestRunOutcome ? ` (outcome: ${r.latestRunOutcome})` : '';
  const detail = r.reasonDetail ? `: ${r.reasonDetail}` : '';
  lines.push(`${r.finishReason || 'unknown'}${detail}${outcome} [${iterations.length} iteration(s)]`);
  return lines.join('\n');
}

/** Render `loop status` — gauges plus a per-loop lineage summary. */
export function renderLoopStatus(status: any, id?: string | null): string {
  const s = status && typeof status === 'object' ? status : {};
  const active = Array.isArray(s.active) ? s.active : [];
  const lines: string[] = [];
  lines.push(`active: ${active.length}  inFlight: ${typeof s.inFlight === 'number' ? s.inFlight : 0}`);
  if (active.length) lines.push(`  invocations: ${active.join(', ')}`);

  if (s.system) {
    lines.push('system loop state:');
    lines.push('  ' + JSON.stringify(s.system));
    return lines.join('\n');
  }

  const summarizeLineage = (loopId: string, lin: any): string => {
    const l = lin && typeof lin === 'object' ? lin : {};
    return `  ${loopId}: iterations=${l.iterationCount || 0} lastProgressAt=${l.lastProgressAt == null ? '-' : l.lastProgressAt} outcome=${l.latestRunOutcome || '-'} tokens=${l.totalTokens || 0}`;
  };

  if (s.lineage) {
    lines.push('lineage:');
    lines.push(summarizeLineage(id || (s.lineage.loopId || ''), s.lineage));
  } else if (s.lineages && typeof s.lineages === 'object') {
    const ids = Object.keys(s.lineages);
    if (ids.length) {
      lines.push('lineages:');
      for (const loopId of ids) lines.push(summarizeLineage(loopId, s.lineages[loopId]));
    } else {
      lines.push('lineages: (none)');
    }
  }
  return lines.join('\n');
}

module.exports = {
  isTerminalFinishReason,
  loopRunExitCode,
  parseInputPairs,
  renderLoopList,
  renderLoopShow,
  renderForge,
  renderLoopRun,
  renderLoopStatus,
};
