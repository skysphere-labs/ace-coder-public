// loop-forge — compile natural language into a LoopSpec DRAFT (PRD §5, §9 Slice 3).
//
// The owner's grill ask: "input in a text box and it builds the loops using our
// whole framework and it locks on." This is the COMPILE half of lock-on (PRD §4:
// lockOn = compile + validate + bind). loop-spec.lockOnLoopSpec owns validate+bind;
// this module owns COMPILE — turning a free-text intent into a structured draft the
// operator reviews/tweaks before pressing Lock On.
//
// v1 is DETERMINISTIC (PRD §5/§9): keyword-driven router inference + template-fill,
// no model call. The prompt-enhancer skill is agent-only (no backend entrypoint), so
// a model-assisted compile is a later seam — exposed here as an INJECTED `pickAgent`
// override + a structured draft the caller can post-process. The default router
// MIRRORS the canonical run-ledger router (next-goal.pickDriver) so a loop's agent
// inference matches an ordinary run's; kept self-contained (no run-ledger import) to
// stay pure + bundling-safe (PRD §R1/§R2).
//
// PURITY (PRD §5, §R2): no better-sqlite3, no Electron, no top-level Date.now /
// Math.random. compileFromNL is a pure function of (text, deps).

import type { LoopSpec, LoopSpecDraft, LoopKind } from './loop-spec.cts';

// Router keyword lists — mirror electron/run-ledger/next-goal.cts pickDriver so a
// loop's agent inference matches an ordinary run's (kept inline for purity).
const CLAUDE_KEYWORDS = [
  'plan', 'design', 'architect', 'architecture', 'ambig', 'unclear', 'review',
  'request-changes', 'debug', 'root cause', 'investigate', 'orchestrat', 'ui',
  'ux', 'product', 'research', 'prd',
];
const CODEX_KEYWORDS = [
  'refactor', 'rename', 'migrat', 'migration', 'implement', 'backend', 'api',
  'pipeline', 'boilerplate', 'scaffold', 'high-volume', 'mechanical', 'bulk', 'codegen',
];

// Kind inference. AGENTIC = produce evidence/no PR (reports, analysis, monitoring);
// CODE = ship a change through worker → validator → PR.
const AGENTIC_KEYWORDS = [
  'report', 'digest', 'analyze', 'analysis', 'research', 'intel', 'audit', 'summary',
  'summarize', 'monitor', 'watch', 'investigate', 'brief', 'evidence', 'review',
  'survey', 'scan', 'triage', 'classify', 'recommend',
];
const CODE_KEYWORDS = [
  'fix', 'implement', 'refactor', 'build', 'test', 'ci', 'pr', 'merge', 'patch',
  'bug', 'migrate', 'scaffold', 'lint', 'rename', 'pipeline', 'compile', 'deploy',
  'harden', 'green',
];

/**
 * Default router (mirrors next-goal.pickDriver): Codex wins only when it matches and
 * Claude does not; otherwise Claude. Deterministic keyword match.
 */
function defaultPickAgent(goal: string): 'claude' | 'codex' {
  const text = String(goal || '').toLowerCase();
  const claudeHit = CLAUDE_KEYWORDS.some((kw) => text.includes(kw));
  const codexHit = CODEX_KEYWORDS.some((kw) => text.includes(kw));
  if (codexHit && !claudeHit) return 'codex';
  return 'claude';
}

export interface ForgeDeps {
  /** override the agent router (e.g. inject next-goal.pickDriver). Default = inline mirror. */
  pickAgent?: (goal: string) => 'claude' | 'codex';
}

export interface CompiledForge {
  /** the proposed draft — NOT yet locked (the operator reviews/tweaks, then locks). */
  draft: LoopSpecDraft;
  /** human-readable notes on what the compiler inferred (surfaced in the forge). */
  notes: string[];
}

function firstNonEmptyLine(text: string): string {
  for (const line of String(text || '').split(/\r?\n/)) {
    const t = line.trim();
    if (t) return t;
  }
  return '';
}

/** Derive a short Title-Case name from the intent's first line (≤6 words). */
function deriveName(text: string): string {
  const line = firstNonEmptyLine(text)
    .replace(/^[\s>*\-•]+/, '')
    .replace(/[.!?].*$/, '') // first sentence only
    .trim();
  const words = line.split(/\s+/).filter(Boolean).slice(0, 6);
  if (!words.length) return 'Untitled Loop';
  return words
    .map((w) => (w.length > 2 ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

/** Detect an absolute repo path mentioned in the text (first match), else null. */
function detectRepo(text: string): string | null {
  const m = String(text || '').match(/(\/(?:[\w.@\-]+\/){1,}[\w.@\-]+)/);
  return m ? m[1] : null;
}

/** Extract allow-list-looking glob tokens (e.g. `.github/**`, `src/**`). */
function detectAllow(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /([\w.\-]+\/(?:\*\*|\*|[\w.\-/]*\*\*?))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(String(text || ''))) !== null) {
    const tok = m[1];
    if (!seen.has(tok)) {
      seen.add(tok);
      out.push(tok);
    }
  }
  return out;
}

/** Infer the loop kind from the intent + whether a repo was detected. */
function inferKind(text: string, hasRepo: boolean): LoopKind {
  const t = String(text || '').toLowerCase();
  const codeHit = CODE_KEYWORDS.some((kw) => t.includes(kw));
  const agenticHit = AGENTIC_KEYWORDS.some((kw) => t.includes(kw));
  // A concrete repo target is the strongest signal of a code loop (it ships edits).
  if (hasRepo) return 'code';
  // Otherwise: agentic when it reads like produce-evidence and not like ship-code.
  if (agenticHit && !codeHit) return 'agentic';
  // A pure code signal with no repo is still a code intent (operator adds the repo).
  if (codeHit && !agenticHit) return 'code';
  // Ambiguous / neither: default agentic (the safe, no-PR, no-merge kind).
  return 'agentic';
}

/**
 * Pull an evidence-criteria phrase for agentic loops: the clause after a cue like
 * "evidence:", "produce", "with", or "that includes"; else the whole first line.
 */
function deriveEvidenceCriteria(text: string): string {
  const t = String(text || '');
  const cue = t.match(/(?:evidence\s*:|must produce|should produce|produce|that includes|with at least|with)\s+([^\n.]{4,160})/i);
  if (cue) return cue[1].trim();
  return firstNonEmptyLine(t).slice(0, 160);
}

/**
 * Compile free-text intent into a LoopSpec draft (PRD §4/§5). Deterministic: infers
 * kind, agent, name, repo/allow (code), and an evidence criterion (agentic), then
 * fills a complete-enough scaffold. The draft is NOT locked — the caller runs it
 * through lockOnLoopSpec (validate + bind) after the operator reviews it.
 */
export function compileFromNL(text: string, deps: ForgeDeps = {}): CompiledForge {
  const intent = String(text == null ? '' : text).trim();
  const pickAgent = typeof deps.pickAgent === 'function' ? deps.pickAgent : defaultPickAgent;
  const notes: string[] = [];

  const repo = detectRepo(intent);
  const kind = inferKind(intent, !!repo);
  const agent = pickAgent(intent);
  const name = deriveName(intent);
  const allow = kind === 'code' ? detectAllow(intent) : [];

  notes.push(`kind → ${kind}${repo ? ' (repo detected)' : ''}`);
  notes.push(`agent → ${agent}`);
  if (kind === 'code') {
    if (repo) notes.push(`repo → ${repo}`);
    else notes.push('repo → (none detected — add a repo path before lock-on)');
    if (allow.length) notes.push(`allow → ${allow.join(', ')}`);
    else notes.push('allow → (none detected — add allow-listed paths before lock-on)');
  } else {
    notes.push('agentic: finishes on evidence, no PR');
  }

  const draft: LoopSpecDraft = {
    name,
    description: intent,
    useWhen: intent,
    kind,
    goalTemplate: intent,
    inputs: {},
    routing: {
      agent,
      skills: [],
      workspace: 'loops',
      target: kind === 'code' ? { repo: repo || '', allow } : { allow: [] },
    },
    contract: {
      stop: { primary: 'converged' },
      ceilings: {},
      verify: {
        requireValidatorPass: kind === 'code',
        requireComputerUseEvidence: false,
      },
      permissions: [],
      merge: { ownerGated: true },
    },
    evidence: kind === 'agentic' ? { criteria: deriveEvidenceCriteria(intent) } : {},
  };

  return { draft, notes };
}

// ───────────────────────────────────────────────────────────────────────────────
// Manager seam (PRD §9 Slice 3 "manager invokeLoop"): given a free-text intent,
// SELECT the best-matching saved loop by its useWhen/name/description. This is a
// pure matcher only — it never fires anything (PRD §12: loops are explicitly
// launched; the caller decides whether to invokeLoop the match). Deterministic
// token-overlap score, so the same intent always picks the same loop.
// ───────────────────────────────────────────────────────────────────────────────

const STOPWORDS = new Set([
  'the', 'a', 'an', 'to', 'of', 'and', 'or', 'for', 'in', 'on', 'with', 'is', 'are',
  'be', 'it', 'this', 'that', 'each', 'when', 'run', 'loop', 'every', 'until', 'i',
  'we', 'should', 'must', 'can', 'will', 'do', 'my', 'our',
]);

function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of String(text || '').toLowerCase().split(/[^a-z0-9]+/)) {
    const t = raw.trim();
    if (t.length >= 3 && !STOPWORDS.has(t)) out.add(t);
  }
  return out;
}

export interface LoopMatch {
  loopId: string;
  score: number;
}

export interface SelectResult {
  /** the best match above threshold, or null when nothing matches confidently. */
  match: LoopMatch | null;
  /** all candidates scored, ranked high → low (for a manager/UI to inspect). */
  ranked: LoopMatch[];
}

/**
 * Select the saved loop that best fits a free-text intent (PRD §9 manager seam).
 * Scores each loop's useWhen + name + description token-overlap against the intent
 * (Jaccard, weighting useWhen highest). Returns the top match only when it clears a
 * small confidence threshold; never fires it. `minScore` defaults to 0.12.
 */
export function selectLoopForIntent(
  description: string,
  loops: LoopSpec[] | any,
  opts: { minScore?: number } = {},
): SelectResult {
  const want = tokenize(description);
  const minScore = Number.isFinite(opts.minScore) ? Number(opts.minScore) : 0.12;
  const ranked: LoopMatch[] = [];

  for (const loop of Array.isArray(loops) ? loops : []) {
    if (!loop || !loop.id) continue;
    // useWhen is the deliberate selection key (PRD §4), so weight it double.
    const have = tokenize(`${loop.useWhen || ''} ${loop.useWhen || ''} ${loop.name || ''} ${loop.description || ''}`);
    if (!want.size || !have.size) {
      ranked.push({ loopId: String(loop.id), score: 0 });
      continue;
    }
    let inter = 0;
    for (const w of want) if (have.has(w)) inter += 1;
    const union = new Set([...want, ...have]).size;
    ranked.push({ loopId: String(loop.id), score: union ? inter / union : 0 });
  }

  ranked.sort((a, b) => b.score - a.score);
  const top = ranked.length ? ranked[0] : null;
  return { match: top && top.score >= minScore ? top : null, ranked };
}

module.exports = {
  compileFromNL,
  selectLoopForIntent,
};
