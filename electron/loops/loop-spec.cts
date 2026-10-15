// loop-spec — the LoopSpec runtime contract: the "lock-on" artifact for a Loop.
//
// A Loop is composition over the run-ledger spine (see ace-loops.prd.md §0):
// a saved run-template + a recursion engine + a trigger. This module owns the
// SHARED runtime contract that every other loops module depends on — the types,
// the fail-closed validator, and the deterministic lock-on (compile + validate +
// bind). It is the stable public surface for loop-store / loop-controller /
// loop-lineage / loop-host / loop-forge.
//
// PURITY (PRD §5, §R2): no better-sqlite3, no Electron, no top-level Date.now /
// Math.random. lockOnLoopSpec accepts an injected { now } clock + { idFromName }
// normalizer so meta.version stamping and id derivation stay deterministic and
// unit-testable with in-memory fakes — exactly the spine's createKernel({...})
// injection pattern. Compile here is a deterministic no-op pass-through (the NL
// → spec compilation lives in the separate loop-forge module per PRD §5).
//
// FAIL-CLOSED (PRD §4 validation rules, §7 permissions): an incomplete or unsafe
// draft does NOT lock. Any permission in OWNER_APPROVAL_PERMISSIONS without an
// explicit owner ack leaves the spec UNSAFE_REQUIRES_APPROVAL and not runnable.

/**
 * code  = worker → validator → ready_for_review (opens a PR; owner-gated merge).
 * agentic = finish on evidence, no PR.
 * @typedef {('code'|'agentic')} LoopKind
 */
export type LoopKind = 'code' | 'agentic' | 'system';

/**
 * Terminal stop states a loop iteration / lineage can land on.
 * @typedef {(
 *   'DONE' | 'BLOCKED' | 'CLEAN_NOOP' | 'READY_FOR_REVIEW' |
 *   'NEEDS_OWNER_DECISION' | 'STALLED_NO_PROGRESS' | 'UNSAFE_REQUIRES_APPROVAL'
 * )} StopState
 */
export type StopState =
  | 'DONE'
  | 'BLOCKED'
  | 'CLEAN_NOOP'
  | 'READY_FOR_REVIEW'
  | 'NEEDS_OWNER_DECISION'
  | 'STALLED_NO_PROGRESS'
  | 'UNSAFE_REQUIRES_APPROVAL';

/**
 * Owner-approval-required capability. A loop may NOT do any of these
 * autonomously without an explicit owner ack (see OWNER_APPROVAL_PERMISSIONS).
 * Everything else (read, analyze, branch work, open PRs, produce evidence) is
 * autonomous.
 * @typedef {(
 *   'merge_to_main' | 'deploy_prod' | 'spend_money' |
 *   'send_external_message' | 'delete_or_archive_data'
 * )} LoopPermission
 */
export type LoopPermission =
  | 'merge_to_main'
  | 'deploy_prod'
  | 'spend_money'
  | 'send_external_message'
  | 'delete_or_archive_data';

/**
 * A minimal JSON-schema-shaped object. Loops carry typed inputs/evidence schemas;
 * v1 treats them as opaque JSON objects (structure validated by consumers).
 * @typedef {Object} JsonSchema
 */
export interface JsonSchema {
  type?: string;
  properties?: Record<string, any>;
  required?: string[];
  [key: string]: any;
}

export interface LoopRoutingTarget {
  /** repo path; REQUIRED for kind==='code'. */
  repo?: string;
  /** allow-listed paths the loop may edit; non-empty REQUIRED for kind==='code'. */
  allow: string[];
  /**
   * EXECUTION-target workspace (PRD §8 §9 Slice 4 — control vs target plane). The
   * loop's CONTROL surface stays the Loops workspace (routing.workspace='loops':
   * lineage, watch, the Loops tab), but each iteration can EXECUTE in a different
   * workspace (edit project X) while still surfacing in Loops via its loopId tag.
   * Absent ⇒ 'loops' (the v1 default: control and target are the same workspace).
   */
  workspace?: string;
  /**
   * EXECUTION project id — a REAL `projects.id` the spine's worker dispatch spawns
   * a worktree from (resolveRunTask(workspaceId)). Distinct from `workspace` (a
   * human label / Slice-4 control-vs-target tag): the spine cannot spawn a worker
   * from a label, only from a registered project. Absent ⇒ the loop layer falls
   * back to the injected spine workspace (ACE_SPINE_WORKSPACE_ID). Without a
   * real id (here or injected) a code/agentic loop dispatches but the worker never
   * attaches (parseSpec: scope must declare at least one of {repo,paths,workspaceId}).
   */
  workspaceId?: string;
}

export interface LoopRouting {
  /** auto = claude-codex router inference from taskType. */
  agent: 'claude' | 'codex' | 'auto';
  /** skills auto-attached at lock-on. */
  skills: string[];
  /** v1: always the Loops workspace (PRD §8 targeting). */
  workspace: 'loops';
  target: LoopRoutingTarget;
}

export interface LoopCeilings {
  maxIterations?: number;
  maxSpendUsd?: number;
  maxRuntimeMs?: number;
  expiryIso?: string;
}

export interface LoopVerify {
  requireValidatorPass: boolean;
  requireComputerUseEvidence: boolean;
}

export interface LoopMerge {
  ownerGated: true;
  /** present ⇒ may auto-merge converged cycles. */
  tokenRef?: string;
}

export interface LoopContract {
  /** Chief: evidence/no-progress primary, NOT a fixed cap. */
  stop: { primary: 'converged' | 'no-progress' };
  /** OPTIONAL owner guardrails; default UNSET. */
  ceilings: LoopCeilings;
  verify: LoopVerify;
  permissions: LoopPermission[];
  merge: LoopMerge;
}

/**
 * A trigger that can fire a loop without an explicit button press (PRD §9 Slice 3).
 * v1 reuses the existing in-process injected-timer scheduler pattern (no new
 * scheduling engine, PRD §2 invariant 6): a `schedule` trigger fires on an interval
 * or a daily wall-clock time; an `event` trigger names a bus event a manager seam
 * can match (wiring deferred per PRD §12 — the trigger is stored + matchable, never
 * auto-conjured). Launch via a trigger is the SAME invokeLoop the button calls.
 */
export interface LoopTrigger {
  /** stable id (optional; caller may stamp). */
  id?: string;
  kind: 'schedule' | 'event';
  /** disabled triggers are stored but never fire. */
  enabled: boolean;
  /** schedule: fire every N ms (>= 60_000 enforced at validate to avoid hot loops). */
  everyMs?: number;
  /** schedule: fire daily at this wall-clock HH:MM (24h). */
  dailyAt?: string;
  /** event: the named event a manager seam matches to fire this loop. */
  event?: string;
}

export interface LoopMeta {
  /** timestamps stamped by the caller, not in the pure module. */
  createdAtRef?: string;
  version: number;
  /** optional provenance/approval note (e.g. an owner-approval date for a ship loop). */
  note?: string;
}

export interface LoopSpec {
  /** stable kebab id. */
  id: string;
  name: string;
  description: string;
  /** human/manager-readable trigger description (selection key for routing). */
  useWhen: string;
  kind: LoopKind;
  /** typed inputs; the forge fills some, the run form fills the rest. */
  inputs: JsonSchema;
  /** per-iteration goal, parameterized by inputs + prior evidence. */
  goalTemplate: string;
  routing: LoopRouting;
  contract: LoopContract;
  /** what each iteration must produce to ingest cleanly. */
  evidence: JsonSchema;
  /** optional triggers (PRD §9 Slice 3); absent ⇒ explicit-launch only. */
  triggers?: LoopTrigger[];
  /** builtin system loops (PRD §10): seeded, not forge-created, not deletable. */
  builtin?: boolean;
  /** for kind==='system': the aceStore method that "run now" invokes. */
  systemRunRef?: string;
  /** display-only schedule string mirrored from the in-process scheduler. */
  schedule?: string;
  /**
   * Explicit owner ack of any OWNER_APPROVAL_PERMISSIONS this spec requests
   * (§7). A LOCKED spec persists the ack (a draft carries it on LoopSpecDraft);
   * validateLoopSpec reads it, so an owner-approved ship loop (merge_to_main)
   * passes validation while an un-acked one stays UNSAFE_REQUIRES_APPROVAL. It is
   * NOT a secret — it never carries a token (see contract.merge.tokenRef, which is
   * a NAME resolved at runtime).
   */
  ownerApproved?: boolean;
  meta: LoopMeta;
}

/** A draft is the loosely-typed shape the forge / run form produce pre-lock. */
export type LoopSpecDraft = Partial<LoopSpec> & {
  /** explicit owner ack of any OWNER_APPROVAL_PERMISSIONS the draft requests. */
  ownerApproved?: boolean;
  [key: string]: any;
};

export interface ValidateResult {
  ok: boolean;
  errors: string[];
  spec?: LoopSpec;
}

export interface LockOnResult {
  locked: boolean;
  spec?: LoopSpec;
  reason?: string;
}

/**
 * Owner-approval-required permission set (PRD §7). A loop may NOT do any of these
 * autonomously without an explicit owner ack. Frozen so consumers can `.has(p)`
 * without mutating the contract.
 */
export const OWNER_APPROVAL_PERMISSIONS: ReadonlySet<LoopPermission> = Object.freeze(
  new Set<LoopPermission>([
    'merge_to_main',
    'deploy_prod',
    'spend_money',
    'send_external_message',
    'delete_or_archive_data',
  ]),
) as ReadonlySet<LoopPermission>;

// 'system' = a builtin maintenance loop (PRD §10) that runs an in-process
// aceStore method (systemRunRef), NOT a spine worker. It carries a minimal
// valid routing (workspace:'loops', empty target.allow) so the code-kind repo/
// allow requirements below never apply to it.
const LOOP_KINDS: ReadonlySet<string> = Object.freeze(new Set(['code', 'agentic', 'system']));
const ROUTING_AGENTS: ReadonlySet<string> = Object.freeze(new Set(['claude', 'codex', 'auto']));

/** Floor for a schedule trigger's everyMs — 60s, so a misconfig can't hot-loop. */
export const MIN_TRIGGER_EVERY_MS = 60_000;

function isNonEmptyString(v: any): boolean {
  return typeof v === 'string' && v.trim().length > 0;
}

/** A valid 24h HH:MM string (00:00–23:59). */
function isValidHhMm(v: any): boolean {
  if (typeof v !== 'string') return false;
  const m = v.trim().match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  return !!m;
}

/**
 * Normalize an arbitrary name/id into a stable kebab id. Deterministic (regex
 * only). Lowercases, collapses any run of non-alphanumerics into a single dash,
 * and trims leading/trailing dashes.
 */
function toKebabId(value: any): string {
  return String(value == null ? '' : value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Fail-closed validation of a LoopSpec draft (PRD §4 validation rules + §7
 * permissions). Returns { ok, errors, spec? }. `spec` is only populated when ok.
 *
 * Rules:
 *  - id/name/description/useWhen/kind/goalTemplate required (non-empty strings).
 *  - kind ∈ {code, agentic}; routing.agent ∈ {claude, codex, auto}.
 *  - routing present with skills[] + workspace==='loops' + target.allow[].
 *  - kind==='code' ⇒ routing.target.repo + non-empty routing.target.allow.
 *  - contract.verify present (requireValidatorPass / requireComputerUseEvidence).
 *  - any permission in OWNER_APPROVAL_PERMISSIONS without an explicit owner ack
 *    ⇒ not runnable (UNSAFE_REQUIRES_APPROVAL).
 */
export function validateLoopSpec(draft: LoopSpecDraft | any): ValidateResult {
  const errors: string[] = [];
  const d = draft && typeof draft === 'object' ? draft : {};

  // Required scalar fields.
  for (const field of ['id', 'name', 'description', 'useWhen', 'goalTemplate'] as const) {
    if (!isNonEmptyString(d[field])) errors.push(`missing required field: ${field}`);
  }
  if (!isNonEmptyString(d.kind)) {
    errors.push('missing required field: kind');
  } else if (!LOOP_KINDS.has(String(d.kind))) {
    errors.push(`invalid kind: ${String(d.kind)} (expected code|agentic|system)`);
  }

  // Routing.
  const routing = d.routing && typeof d.routing === 'object' ? d.routing : null;
  if (!routing) {
    errors.push('missing required field: routing');
  } else {
    if (!ROUTING_AGENTS.has(String(routing.agent))) {
      errors.push(`invalid routing.agent: ${String(routing.agent)} (expected claude|codex|auto)`);
    }
    if (!Array.isArray(routing.skills)) errors.push('routing.skills must be an array');
    if (routing.workspace !== 'loops') {
      errors.push(`routing.workspace must be 'loops' (got ${String(routing.workspace)})`);
    }
    const target = routing.target && typeof routing.target === 'object' ? routing.target : null;
    if (!target) {
      errors.push('missing required field: routing.target');
    } else {
      if (!Array.isArray(target.allow)) {
        errors.push('routing.target.allow must be an array');
      }
      // Cross-workspace target (PRD §9 Slice 4): optional, but when present it must
      // be a non-empty workspace id (the execution target; control stays 'loops').
      if (target.workspace != null && !isNonEmptyString(target.workspace)) {
        errors.push('routing.target.workspace must be a non-empty string when set');
      }
    }
    // code-kind hard requirements: repo + non-empty allow.
    if (String(d.kind) === 'code') {
      if (!isNonEmptyString(target && target.repo)) {
        errors.push('code-kind loop requires routing.target.repo');
      }
      if (!Array.isArray(target && target.allow) || target.allow.length === 0) {
        errors.push('code-kind loop requires a non-empty routing.target.allow');
      }
    }
  }

  // Contract + verify.
  const contract = d.contract && typeof d.contract === 'object' ? d.contract : null;
  if (!contract) {
    errors.push('missing required field: contract');
  } else {
    const verify = contract.verify && typeof contract.verify === 'object' ? contract.verify : null;
    if (!verify) {
      errors.push('missing required field: contract.verify');
    } else {
      if (typeof verify.requireValidatorPass !== 'boolean') {
        errors.push('contract.verify.requireValidatorPass must be a boolean');
      }
      if (typeof verify.requireComputerUseEvidence !== 'boolean') {
        errors.push('contract.verify.requireComputerUseEvidence must be a boolean');
      }
    }
  }

  // Permissions safety gate (§7). Any owner-approval permission requested without
  // an explicit owner ack ⇒ not runnable.
  const permissions: any[] = contract && Array.isArray(contract.permissions) ? contract.permissions : [];
  const ownerApprovalRequested = permissions.filter((p) => OWNER_APPROVAL_PERMISSIONS.has(p as LoopPermission));
  const ownerApproved = d.ownerApproved === true;
  if (ownerApprovalRequested.length > 0 && !ownerApproved) {
    errors.push(
      `UNSAFE_REQUIRES_APPROVAL: permission(s) require explicit owner ack: ${ownerApprovalRequested.join(', ')}`,
    );
  }

  // Triggers (PRD §9 Slice 3) — OPTIONAL, but fail-closed on a malformed one so a
  // bad schedule never silently no-ops or hot-loops.
  if (d.triggers != null) {
    if (!Array.isArray(d.triggers)) {
      errors.push('triggers must be an array');
    } else {
      d.triggers.forEach((t: any, i: number) => {
        if (!t || typeof t !== 'object') {
          errors.push(`triggers[${i}] must be an object`);
          return;
        }
        if (t.kind !== 'schedule' && t.kind !== 'event') {
          errors.push(`triggers[${i}].kind must be 'schedule' | 'event'`);
          return;
        }
        if (typeof t.enabled !== 'boolean') errors.push(`triggers[${i}].enabled must be a boolean`);
        if (t.kind === 'schedule') {
          const hasEvery = Number.isFinite(t.everyMs) && Number(t.everyMs) > 0;
          const hasDaily = isValidHhMm(t.dailyAt);
          if (!hasEvery && !hasDaily) {
            errors.push(`triggers[${i}] schedule requires everyMs (>0) or dailyAt (HH:MM)`);
          }
          if (hasEvery && Number(t.everyMs) < MIN_TRIGGER_EVERY_MS) {
            errors.push(`triggers[${i}].everyMs must be >= ${MIN_TRIGGER_EVERY_MS} (no hot loops)`);
          }
          if (t.dailyAt != null && !hasDaily) {
            errors.push(`triggers[${i}].dailyAt must be HH:MM (24h)`);
          }
        } else if (!isNonEmptyString(t.event)) {
          errors.push(`triggers[${i}] event requires a non-empty event name`);
        }
      });
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  return { ok: true, errors: [], spec: d as LoopSpec };
}

/**
 * Compile + validate (fail-closed) + bind a draft into a runnable LoopSpec.
 *
 * Compile here is a deterministic no-op pass-through — NL → spec compilation
 * lives in loop-forge (PRD §5). Bind normalizes the id (kebab from id||name),
 * stamps meta.version (1 for a new spec, +1 when re-locking an existing version),
 * and stamps meta.createdAtRef via the injected clock when provided.
 *
 * @param draft the loosely-typed loop draft
 * @param deps  injected effects (keeps the module pure / deterministic):
 *   - now?: () => number | string         clock for meta.createdAtRef
 *   - idFromName?: (value) => string       id normalizer (defaults to kebab)
 * @returns { locked, spec?, reason? } — locked:false carries the joined errors.
 */
export function lockOnLoopSpec(
  draft: LoopSpecDraft | any,
  deps: { now?: () => number | string; idFromName?: (value: any) => string } = {},
): LockOnResult {
  const d = draft && typeof draft === 'object' ? { ...draft } : {};
  const idFromName = typeof deps.idFromName === 'function' ? deps.idFromName : toKebabId;

  // Bind: normalize the id from an explicit id, else from the name. Done BEFORE
  // validate so a draft with only a name still satisfies the required-id rule
  // (provided the name is present).
  const idSource = isNonEmptyString(d.id) ? d.id : d.name;
  const normalizedId = idFromName(idSource);
  if (isNonEmptyString(normalizedId)) d.id = normalizedId;

  // Bind: stamp meta.version + createdAtRef. version increments on re-lock.
  const priorVersion =
    d.meta && typeof d.meta === 'object' && Number.isFinite(d.meta.version) ? Number(d.meta.version) : 0;
  const nextVersion = priorVersion >= 1 ? priorVersion + 1 : 1;
  const createdAtRef =
    d.meta && typeof d.meta === 'object' && isNonEmptyString(d.meta.createdAtRef)
      ? d.meta.createdAtRef
      : typeof deps.now === 'function'
        ? String(deps.now())
        : undefined;
  d.meta = { ...(d.meta && typeof d.meta === 'object' ? d.meta : {}), version: nextVersion };
  if (createdAtRef !== undefined) d.meta.createdAtRef = createdAtRef;

  const result = validateLoopSpec(d);
  if (!result.ok) {
    return { locked: false, reason: result.errors.join('; ') };
  }
  return { locked: true, spec: result.spec };
}

module.exports = {
  OWNER_APPROVAL_PERMISSIONS,
  validateLoopSpec,
  lockOnLoopSpec,
};
