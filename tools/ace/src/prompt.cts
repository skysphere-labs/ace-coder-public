// Prompt builder for Ace task delegation.
//
// One source of truth for the framed worker prompt an orchestrator hands to
// a spawned agent. The DONE:/BLOCKED: trailer contract is enforced here and
// parsed back in `parseTrailer`. Pure, sync, no I/O.

// Accept bullet/markdown-bold-decorated trailer lines. Workers sometimes emit
// `• BLOCKED: reason`, `- **BLOCKED:** reason`, or `**DONE:** summary` instead
// of a bare keyword; the markdown bold can wrap the keyword with or without
// the colon inside the asterisks. Leading whitespace is tolerated.
const TRAILER_LINE_RX = /^\s*(?:[•·⏺*\-]\s+)?(?:\*\*)?(DONE|BLOCKED)(?:\*\*)?\s*:\s*(?:\*\*)?\s*([^\n]*?)\s*$/i;

function isTrailerTailNoise(line: any) {
  const trimmed = String(line || '').trim();
  return (
    !trimmed ||
    /^>\s*$/.test(trimmed) ||
    /^❯\s*$/.test(trimmed) ||
    /^[>❯]\s+\S/.test(trimmed) ||
    /^[─━-]+$/.test(trimmed) ||
    /^─+\s*Worked for\b/i.test(trimmed) ||
    /^✻\s+\S/.test(trimmed) ||
    /^⏵+/.test(trimmed) ||
    /^›/.test(trimmed) ||
    /^Use \/skills\b/i.test(trimmed) ||
    /^Goal (?:blocked|completed|paused)\b/i.test(trimmed) ||
    /^gpt-[\w.-]+(?:\s+\w+)*\s+·\s+/i.test(trimmed) ||
    /^tokens used:\s*\d+(?:\b.*)?$/i.test(trimmed)
  );
}

function isCommandRegistryTrailer(detail: any) {
  const text = String(detail || '');
  return /"?ipcMethod"?\s*:/.test(text) || /"?flags"?\s*:/.test(text) || /\bspecial:missionSync\b/.test(text);
}

function isHardWrappedTrailerContinuation(line: any, previousLine: any) {
  const raw = String(line || '');
  const trimmed = raw.trim();
  if (!trimmed) return false;
  if (/^\s+\S/.test(raw)) return true;
  if (String(previousLine || '').length < 72) return false;
  if (isTrailerTailNoise(raw) || TRAILER_LINE_RX.test(raw)) return false;
  if (/^(?:[#>`]|[•·⏺*\-]\s+)/.test(trimmed)) return false;
  if (/^[A-Z][a-z]+(?:\s|$)/.test(trimmed)) return false;
  return true;
}

let manifestCore: any;
try {
  manifestCore = require('./manifest.cjs');
} catch {
  manifestCore = require('./manifest.cts');
}
const { MAX_TASK_PACK_SKILLS, resolveTaskManifest } = manifestCore;
let agentCatalogCore: any;
try {
  agentCatalogCore = require('./agent-catalog.cjs');
} catch {
  agentCatalogCore = require('./agent-catalog.cts');
}
const { resolveAgentCatalog } = agentCatalogCore;

// Role-aware character budgets. Soft is the target/warn threshold (telemetry
// records it); hard is the dispatch fence (build throws unless the spec sets a
// promptBudgetOverrideReason). Targets come from the lean controller plan:
// worker 1500 / complex 2200 / validator 1200 / fixback 800.
const PROMPT_BUDGET = Object.freeze({
  byRole: Object.freeze({
    implementer: Object.freeze({ soft: 1500, hard: 2200 }),
    reviewer:    Object.freeze({ soft: 1200, hard: 1800 }),
    fixback:     Object.freeze({ soft:  800, hard: 1200 }),
    'no-code':   Object.freeze({ soft: 1500, hard: 2200 }),
  }),
  maxDeclaredSkills: 7,
  maxTaskPackSkills: MAX_TASK_PACK_SKILLS,
});

function budgetForRole(roleMode: any) {
  return PROMPT_BUDGET.byRole[roleMode as keyof typeof PROMPT_BUDGET.byRole] ||
    PROMPT_BUDGET.byRole.implementer;
}

function budgetExceededLevel(chars: number, budget: { soft: number; hard: number }) {
  if (chars > budget.hard) return 'hard';
  if (chars > budget.soft) return 'soft';
  return 'none';
}

function asList(value: any) {
  if (value == null) return [];
  if (Array.isArray(value)) return value.map((v: any) => String(v)).filter((s: any) => s.trim());
  return [String(value)].filter((s: any) => s.trim());
}

// Drop exact-duplicate lines (normalized: single-spaced, trimmed). Callers
// sometimes merge constraint packs from multiple sources and land with
// identical entries; rendering each twice is pure noise for the worker.
function dedupe(items: any) {
  const seen = new Set();
  const out = [];
  for (const raw of items) {
    const key = String(raw).replace(/\s+/g, ' ').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(raw);
  }
  return out;
}

// priorRoundSummary ballooned once verification rounds started feeding full
// worker turns back in. Cap at 400 chars so the framed prompt stays compact;
// the orchestrator already keeps the full turn in its own summary buffer.
const PRIOR_ROUND_MAX_CHARS = 400;

function truncatePriorRound(text: any) {
  const body = String(text || '').trim();
  if (body.length <= PRIOR_ROUND_MAX_CHARS) return body;
  return `…[truncated ${body.length - PRIOR_ROUND_MAX_CHARS} chars]…\n` + body.slice(-PRIOR_ROUND_MAX_CHARS);
}

function section(title: any, body: any) {
  const trimmed = body && body.trim();
  if (!trimmed) return '';
  return `# ${title}\n${trimmed}\n`;
}

function bulletList(items: any) {
  if (!items.length) return '';
  return items.map((item: any) => `- ${item.replace(/\n/g, ' ').trim()}`).join('\n');
}

const REFERENCE_ONLY_SKILLS: Record<string, { description: string; sourceUrl: string }> = {
  'trailofbits-security-review': {
    description: 'Trail of Bits security review',
    sourceUrl: 'https://github.com/trailofbits/skills',
  },
  'anthropics-frontend-design': {
    description: 'Design and build frontend UI components and layouts',
    sourceUrl: 'https://github.com/anthropics/skills/tree/main/skills/frontend-design',
  },
};

function skillReferenceLines(skills: any) {
  return skills
    .map((skillId: any) => REFERENCE_ONLY_SKILLS[skillId])
    .filter(Boolean)
    .map((ref: any) => `Reference: ${ref.description} — see ${ref.sourceUrl}`);
}

function skillLoadPolicyLine(skillHome: any) {
  return `Load from ${skillHome}<id>/SKILL.md. Follow workspace AGENTS.md / CLAUDE.md when present. If repo doctrine is absent, use Ace's seeded fallback or task-local instructions; do not block on doctrine absence alone. Missing listed skills are nonfatal: warn and continue. BLOCKED only for a task-marked REQUIRED skill.`;
}

function normalizeRoleMode(value: any) {
  const mode = String(value || '').trim().toLowerCase();
  if (mode === 'implementer' || mode === 'reviewer' || mode === 'fixback' || mode === 'no-code') {
    return mode;
  }
  return null;
}

function resolveRoleMode(spec: any) {
  const explicit = normalizeRoleMode(spec?.roleMode || spec?.role_mode || spec?.workerMode || spec?.worker_mode);
  if (explicit) return explicit;
  const taskType = String(spec?.taskType || '').trim().toLowerCase();
  const role = String(spec?.role || '').trim().toLowerCase();
  if (taskType === 'github-steward') return 'no-code';
  if (role === 'viewer' || taskType === 'code-review' || taskType === 'reviewer') return 'reviewer';
  if (taskType === 'fixback' || spec?.verifyFeedback) return 'fixback';
  if (
    taskType === 'no-code' ||
    taskType === 'research' ||
    taskType === 'planning' ||
    taskType === 'plan' ||
    taskType === 'architect' ||
    taskType === 'architecture' ||
    taskType === 'docs' ||
    taskType === 'documentation'
  ) return 'no-code';
  return 'implementer';
}

function normalizeNativeTeamMode(value: any) {
  if (value === true) return 'optional';
  if (value === false) return 'off';
  const mode = String(value || '').trim().toLowerCase();
  if (mode === 'auto' || mode === 'on' || mode === 'optional') return 'optional';
  if (mode === 'off' || mode === 'false' || mode === 'none') return 'off';
  return null;
}

function resolveNativeTeamMode(spec: any, manifest: any) {
  const explicit = normalizeNativeTeamMode(spec?.nativeTeamMode ?? spec?.native_team_mode);
  if (explicit) return explicit;
  const capabilities = new Set(asList(manifest?.capabilities));
  return capabilities.has('native-team') || capabilities.has('native-teams') ? 'optional' : 'off';
}

function nativeTeamModeLine(driver: any) {
  const agent = driver === 'claude' || driver === 'codex' ? driver : 'agent';
  return [
    `Optional/capability-gated: if this ${agent} CLI exposes native subagents/team mode, use it only for large shared-context research/implementation inside this same worker lane.`,
    'Choose single worker for narrow work; choose Ace fanout for independent PR/worktree lanes. Native helpers stay in the same worktree/channel, must keep edits non-overlapping, synthesize concisely, and create no hidden merge boundaries.',
    'Reference rubric/plan/custom-agent anchors by path/ID; do not duplicate them.',
  ].join('\n');
}

function roleModeLine(mode: any, agentClass: any) {
  if (agentClass === 'orchestrator') {
    return 'orchestrator: organize the brief, create visible Mission/task state when useful, spawn implementation/research/validator workers with `ace task run --workspace <same workspace> --new-task`, join results, and report concise status. Do not edit files, run raw write-side git, open raw PRs, or merge outside Ace integration.';
  }
  if (agentClass === 'validator-merger') {
    return 'validator-fixer-merger: validate the exact PR/head. If the spec grants editor scope, fix ordinary in-scope defects on the same branch/PR, rerun checks, then use Ace integration gate and Ace integration pr-merge on PASS only. If read-only or out of scope, emit a fixback/block packet. Do not raw GitHub merge, open replacement PRs, or clean up branches outside Ace integration.';
  }
  if (agentClass === 'github-merger') {
    return 'github-merger: PR/merge steward; may use Ace integration gate, merge, and cleanup commands only after required gates pass. Do not edit implementation files.';
  }
  if (mode === 'reviewer') {
    return 'reviewer/validator: read-only review; do not edit, push, open PRs, merge, or clean up branches.';
  }
  if (mode === 'fixback') {
    return 'You are an expert engineer: production-grade, minimal-diff fixes. fixback: patch only the reported failure on the existing task/branch/PR.';
  }
  if (mode === 'no-code') {
    return 'no-code: produce analysis or planning output only; do not edit files, create PRs, merge, clean up, or delete branches/worktrees.';
  }
  // Identity + quality bar lead the implementer line — the ONE section present
  // for every non-file-first worker — so every worker is locked onto WHO it is
  // and the bar it ships to. Domain specifics (e.g. frontend/motion) ride in the
  // intent's # Context + the mounted skill pack, not here. Kept to one sentence.
  return 'You are an expert engineer: ship production-grade, tested, minimal-diff work to a high bar, verified by a real build. implementer: make scoped changes only under allowed paths and verify.';
}

function prioritizedExplicitSkills(skills: any, roleMode: any) {
  const explicit = asList(skills).map((s: any) => s.trim()).filter(Boolean);
  const filtered =
    roleMode === 'reviewer' || roleMode === 'no-code'
      ? explicit.filter((id: any) => id !== 'ace-github-flow' && id !== 'ace-task-worker')
      : explicit;
  return [
    ...filtered.filter((id: any) => id === 'ace-github-flow'),
    ...filtered.filter((id: any) => id !== 'ace-github-flow'),
  ];
}

function uniqueSkillStack(items: any) {
  const seen = new Set();
  const out = [];
  for (const id of items.map((item: any) => String(item || '').trim()).filter(Boolean)) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function resolveSkills(spec: any) {
  const roleMode = resolveRoleMode(spec);
  const manifest = resolveTaskManifest({ ...spec, roleMode });
  const required = prioritizedExplicitSkills(manifest.requiredSkills, 'implementer');
  const optional = prioritizedExplicitSkills(manifest.optionalSkills, roleMode);
  const out = uniqueSkillStack([
    ...required,
    ...manifest.baselineSkills,
    ...manifest.taskPackSkills,
    ...manifest.validationSkills,
    ...optional,
  ]);
  return {
    roleMode,
    manifest,
    skillStack: out,
    skills: out.slice(0, PROMPT_BUDGET.maxDeclaredSkills),
    omittedSkills: out.slice(PROMPT_BUDGET.maxDeclaredSkills),
  };
}

function promptBudgetOverrideReason(spec: any, opts: any = {}) {
  return String(
    opts.promptBudgetOverrideReason ||
      spec?.promptBudgetOverrideReason ||
      spec?.prompt_budget_override_reason ||
      ''
  ).trim();
}

function hasManifestInput(spec: any) {
  return !!(
    (spec?.manifest && typeof spec.manifest === 'object' && !Array.isArray(spec.manifest)) ||
    spec?.roleMode != null ||
    spec?.role_mode != null ||
    spec?.skillPack != null ||
    spec?.skill_pack != null ||
    spec?.taskClass != null ||
    spec?.task_class != null ||
    spec?.agentClass != null ||
    spec?.agent_class != null ||
    spec?.effort != null ||
    spec?.toolMode != null ||
    spec?.tool_mode != null ||
    spec?.mcpMode != null ||
    spec?.mcp_mode != null ||
    spec?.browserMode != null ||
    spec?.browser_mode != null ||
    spec?.nativeTeamMode != null ||
    spec?.native_team_mode != null ||
    spec?.capabilities != null ||
    spec?.baselineSkills != null ||
    spec?.baseline_skills != null ||
    spec?.taskPackSkills != null ||
    spec?.task_pack_skills != null ||
    spec?.validationSkills != null ||
    spec?.validation_skills != null ||
    spec?.requiredSkills != null ||
    spec?.required_skills != null ||
    spec?.optionalSkills != null ||
    spec?.optional_skills != null ||
    spec?.risk != null ||
    spec?.riskLevel != null ||
    spec?.risk_level != null ||
    spec?.clawpatchRequired != null ||
    spec?.clawpatch_required != null
  );
}

function buildTaskPromptEnvelope(spec: any, opts: any = {}) {
  if (!spec || typeof spec !== 'object') {
    throw new Error('buildTaskPrompt: spec object required');
  }
  const goal = String(spec.goal || '').trim();
  if (!goal) throw new Error('buildTaskPrompt: spec.goal required');

  const driver = String(opts.driver || 'claude').trim().toLowerCase() || 'claude';
  const taskType = String(spec.taskType || 'generic').trim().toLowerCase() || 'generic';

  const constraints = dedupe(asList(spec.constraints));
  const deliverables = dedupe(asList(spec.deliverables));
  const acceptance = dedupe(asList(spec.acceptance));
  const context = String(spec.context || '').trim();
  const priorRoundSummary = truncatePriorRound(spec.priorRoundSummary);
  const verifyFeedback = String(spec.verifyFeedback || '').trim();
  const customEscapeHatch = String(spec.escapeHatch || '').trim();
  const resolvedSkills = resolveSkills(spec);
  const { roleMode, manifest, skills, omittedSkills } = resolvedSkills;
  const catalog = resolveAgentCatalog(spec, { manifest, provider: driver });
  const nativeTeamMode = resolveNativeTeamMode(spec, manifest);
  const overrideReason = promptBudgetOverrideReason(spec, opts);
  const riskLevel = String(spec.riskLevel || spec.risk_level || spec.risk || '').trim();
  const hasClawpatchRequired = spec.clawpatchRequired != null || spec.clawpatch_required != null;
  const clawpatchRequired = spec.clawpatchRequired === true || spec.clawpatch_required === true;

  // File-first prompt: when the orchestrator wrote a GoalAgentSpec/v1 (or a
  // ValidatorGoalSpec/FixbackGoalSpec) we point the worker at the file rather
  // than inlining a giant context block. Heavier doctrine lives in the spec
  // file and the linked ledger; the chat prompt becomes a short pointer.
  const goalAgentSpecPath = String(
    spec.workerSpecPath ||
      spec.worker_spec_path ||
      spec.validatorSpecPath ||
      spec.validator_spec_path ||
      spec.goalAgentSpecPath ||
      spec.goal_agent_spec_path ||
      ''
  ).trim();
  const goalLedgerPathHint = String(
    spec.goalLedgerPath || spec.goal_ledger_path || ''
  ).trim();
  const fileFirst =
    !!goalAgentSpecPath &&
    (String(spec.goalMode || '').trim().toLowerCase() === 'on' ||
      String(spec.goalLedgerMode || '').trim().toLowerCase() === 'on');

  const parts = [];

  // File-first goal agents (goalMode/on or goalLedgerMode/on with a
  // GoalAgentSpec on disk) must lead with the literal `/goal` token as the
  // first user-visible line — no `# Goal` header, no Skills/Role manifest
  // section before it. This is what triggers goal-mode language on Claude
  // and matches the Codex native `/goal` setup so workers, validators,
  // fixbacks, and release agents all enter goal-mode the same way.
  if (fileFirst) {
    const fileFirstRoleLine =
      catalog.agentClass === 'validator-merger'
        ? 'Validate the exact PR/head; on PASS use Ace integration merge only.'
        : catalog.agentClass === 'github-merger'
          ? 'Gate and merge only through Ace integration commands.'
          : roleMode === 'reviewer'
        ? 'Validate; edit only if the spec grants validator-fixer-merger scope.'
        : roleMode === 'fixback'
          ? 'Patch only the listed failures on the existing branch.'
          : 'Implement only what the spec scopes.';
    const fileFirstGoalBlock = [
      '/goal',
      '',
      'Read and execute:',
      goalAgentSpecPath,
      goalLedgerPathHint
        ? [
            '',
            'Use the Goal Ledger:',
            `${goalLedgerPathHint}/GOAL.md`,
            `${goalLedgerPathHint}/implementation-notes.html`,
          ].join('\n')
        : '',
      '',
      fileFirstRoleLine,
      'Do not re-plan outside scope.',
      'Work only on allowed files/paths.',
      goalLedgerPathHint ? 'Update implementation-notes.html at each meaningful checkpoint.' : '',
      'End with exactly DONE or BLOCKED.',
    ].filter(Boolean).join('\n');
    parts.push(fileFirstGoalBlock);
  }

  // Keep the prompt compact for every driver. Skills are materialized into the
  // agent's native skill dir by Ace, and repo doctrine now lives in compact
  // AGENTS.md / CLAUDE.md files inside the workspace. Point at those surfaces;
  // do not inline giant skill bodies or vendor-specific manuals here.
  if (!fileFirst && skills.length) {
    const skillHome = driver === 'claude' ? '~/.claude/skills/' : driver === 'codex' ? '~/.codex/skills/' : '$AGENT_CONFIG/skills/';
    const references = skillReferenceLines(skills);
    parts.push(
      section(
        'Skills to load',
        [
          bulletList(skills),
          ...references,
          omittedSkills.length
            ? `Omitted ${omittedSkills.length} extra prompt-declared skill(s) due to the ${PROMPT_BUDGET.maxDeclaredSkills}-skill prompt cap; mounted baseline skills remain available.`
            : '',
          skillLoadPolicyLine(skillHome),
        ].filter(Boolean).join('\n')
      )
    );
  }

  if (!fileFirst && hasManifestInput(spec)) {
    parts.push(
      section(
        'Role manifest',
        [
          `role: ${manifest.roleMode} (${manifest.roleLabel})`,
          `agentClass: ${catalog.agentClass}`,
          `skillPack: ${manifest.skillPack}`,
          manifest.taskClass ? `taskClass: ${manifest.taskClass}` : '',
          `effort: ${catalog.effort}`,
          `toolMode: ${catalog.toolMode}`,
          `mcpMode: ${catalog.mcpMode}`,
          `browserMode: ${catalog.browserMode}`,
          nativeTeamMode !== 'off' ? `nativeTeamMode: ${nativeTeamMode}` : '',
          riskLevel ? `riskLevel: ${riskLevel}` : '',
          hasClawpatchRequired ? `clawpatchRequired: ${clawpatchRequired}` : '',
          manifest.capabilities.length ? `capabilities: ${manifest.capabilities.join(', ')}` : '',
          manifest.baselineSkills.length ? `baselineSkills: ${manifest.baselineSkills.join(', ')}` : '',
          manifest.taskPackSkills.length ? `taskPackSkills: ${manifest.taskPackSkills.join(', ')}` : '',
          manifest.validationSkills.length ? `validationSkills: ${manifest.validationSkills.join(', ')}` : '',
          manifest.requiredSkills.length ? `requiredSkills: ${manifest.requiredSkills.join(', ')}` : '',
          manifest.optionalSkills.length ? `optionalSkills: ${manifest.optionalSkills.join(', ')}` : '',
          manifest.omittedTaskPackSkills.length
            ? `omittedTaskPackSkills: ${manifest.omittedTaskPackSkills.length} over cap ${PROMPT_BUDGET.maxTaskPackSkills}`
            : '',
        ].filter(Boolean).join('\n')
      )
    );
  }

  if (!fileFirst) {
    parts.push(
      section(
        'Role mode',
        roleModeLine(roleMode, catalog.agentClass)
      )
    );
  }

  if (!fileFirst && nativeTeamMode !== 'off' && (roleMode === 'implementer' || roleMode === 'fixback')) {
    parts.push(section('Native team mode', nativeTeamModeLine(driver)));
  }

  // Driver precision keywords (Claude UltraCode/dynamic-workflow/fan-out; Codex
  // /goal/bias-to-action/apply_patch) are NOT injected per-prompt — that bloats
  // every task and breaks the compact-prompt budgets. They live in the
  // custom-agent doctrine files (.claude/agents / .codex/agents, see
  // driver-packs.cts), loaded once per agent and prompt-cached for efficiency.

  if (fileFirst) {
    // Goal block is already pushed at the top of parts so `/goal` is the
    // first user-visible line. Only prior-round/verify-feedback context
    // belongs here.
    if (priorRoundSummary) {
      parts.push(section('Prior round', priorRoundSummary));
    }
    if (verifyFeedback) {
      parts.push(section('Verification feedback', verifyFeedback));
    }
  } else {
    parts.push(section('Goal', goal));

    if (context) parts.push(section('Context', context));

    if (priorRoundSummary) {
      parts.push(section('Prior round', priorRoundSummary));
    }

    if (constraints.length) {
      parts.push(section('Constraints', bulletList(constraints)));
    }

    if (deliverables.length) {
      parts.push(section('Deliverables', bulletList(deliverables)));
    }

    if (acceptance.length) {
      parts.push(section('Acceptance', bulletList(acceptance)));
    }
  }

  const goalLedgerPath = !fileFirst ? String(spec.goalLedgerPath || spec.goal_ledger_path || '').trim() : '';
  if (goalLedgerPath) {
    parts.push(
      section(
        'Goal Ledger',
        [
          `Ledger path: ${goalLedgerPath}`,
          'Read GOAL.md before work.',
          'Keep implementation-notes.html current after meaningful checkpoints, before compaction, and before final handoff.',
          'Add evidence files only for bulky logs/screenshots/command output.',
          'Do not treat the ledger as validation proof unless the actual validation command/result is recorded.',
        ].join('\n')
      )
    );
  }

  // Knowledge-base pointer (~140 chars). File-first specs carry a full
  // `## Knowledge` section in the spec file instead (zero prompt cost), so
  // this only renders on inline prompts. It is DROPPABLE context: when the
  // rendered prompt would blow the role's hard budget, this section is
  // removed (telemetry.knowledgePointerDropped) rather than throwing.
  let knowledgeSectionText = '';
  if (!fileFirst && spec.knowledge && typeof spec.knowledge === 'object') {
    const knowledgeProject = String(spec.knowledge.project || '').trim();
    const knowledgePack = String(spec.knowledge.packPath || '').trim();
    knowledgeSectionText = section(
      'Knowledge',
      [
        `kb: ace memory search "<topic>"${knowledgeProject ? ` --project ${knowledgeProject}` : ''}`,
        knowledgePack ? `pack: ${knowledgePack}` : '',
        'Canon > working > raw; never cite decayed/raw results as authoritative.',
      ].filter(Boolean).join('\n')
    );
    parts.push(knowledgeSectionText);
  }

  if (!fileFirst && verifyFeedback) {
    parts.push(section('Verification feedback', verifyFeedback));
  }

  const trailer = customEscapeHatch
    ? customEscapeHatch
    : 'End with exactly one of: `DONE: <one-line summary>` or `BLOCKED: <one-line reason>`.';

  if (!fileFirst) {
    parts.push(section('Escape hatch', trailer));
  }

  if (overrideReason) {
    parts.push(section('Prompt budget override', overrideReason));
  }

  let text = parts.filter(Boolean).join('\n').trim() + '\n';
  const budget = budgetForRole(roleMode);
  let promptBudgetExceeded = budgetExceededLevel(text.length, budget);
  let knowledgePointerDropped = false;
  if (promptBudgetExceeded === 'hard' && knowledgeSectionText && !overrideReason) {
    const knowledgeIndex = parts.indexOf(knowledgeSectionText);
    if (knowledgeIndex >= 0) {
      parts.splice(knowledgeIndex, 1);
      knowledgePointerDropped = true;
      text = parts.filter(Boolean).join('\n').trim() + '\n';
      promptBudgetExceeded = budgetExceededLevel(text.length, budget);
    }
  }
  const telemetry = {
    renderedPromptChars: text.length,
    knowledgePointerDropped,
    skillCount: skills.length,
    omittedSkillCount: omittedSkills.length,
    taskPackSkillCount: manifest.taskPackSkills.length,
    omittedTaskPackSkillCount: manifest.omittedTaskPackSkills.length,
    skillPack: manifest.skillPack,
    agentClass: catalog.agentClass,
    effort: catalog.effort,
    // Orthogonal to effort: an explicit UltraCode request (the spine sets this
    // for every Claude worker) so the launcher sends `/effort ultracode` before
    // the brief even at xhigh. Plumbed into buildLaunchIntent.
    ultraCode: spec?.ultraCode === true,
    toolMode: catalog.toolMode,
    mcpMode: catalog.mcpMode,
    browserMode: catalog.browserMode,
    codexRuntimeProfile: typeof spec?.codexRuntimeProfile === 'string' && spec.codexRuntimeProfile.trim()
      ? spec.codexRuntimeProfile.trim()
      : null,
    codexModel: typeof spec?.codexModel === 'string' && spec.codexModel.trim()
      ? spec.codexModel.trim()
      : null,
    nativeTeamMode,
    riskLevel: riskLevel || null,
    clawpatchRequired: hasClawpatchRequired ? clawpatchRequired : null,
    toolOverrideReason: catalog.toolOverrideReason,
    effortOverrideReason: catalog.effortOverrideReason,
    capabilities: manifest.capabilities,
    baselineSkills: manifest.baselineSkills,
    taskPackSkills: manifest.taskPackSkills,
    validationSkills: manifest.validationSkills,
    requiredSkills: manifest.requiredSkills,
    optionalSkills: manifest.optionalSkills,
    taskType,
    driver,
    roleMode,
    manifest: {
      roleMode: manifest.roleMode,
      roleLabel: manifest.roleLabel,
      skillPack: manifest.skillPack,
      agentClass: catalog.agentClass,
      effort: catalog.effort,
      toolMode: catalog.toolMode,
      mcpMode: catalog.mcpMode,
      browserMode: catalog.browserMode,
      codexRuntimeProfile: typeof spec?.codexRuntimeProfile === 'string' && spec.codexRuntimeProfile.trim()
        ? spec.codexRuntimeProfile.trim()
        : null,
      codexModel: typeof spec?.codexModel === 'string' && spec.codexModel.trim()
        ? spec.codexModel.trim()
        : null,
      nativeTeamMode,
      riskLevel: riskLevel || null,
      clawpatchRequired: hasClawpatchRequired ? clawpatchRequired : null,
      capabilities: manifest.capabilities,
      taskPackSkills: manifest.taskPackSkills,
      omittedTaskPackSkillCount: manifest.omittedTaskPackSkills.length,
      baselineSkills: manifest.baselineSkills,
      validationSkills: manifest.validationSkills,
      requiredSkills: manifest.requiredSkills,
      optionalSkills: manifest.optionalSkills,
      taskClass: manifest.taskClass,
    },
    promptBudgetClass: roleMode,
    promptBudgetSoftChars: budget.soft,
    promptBudgetHardChars: budget.hard,
    promptBudgetExceeded,
    promptBudgetOverrideReason: overrideReason || null,
  };

  if (promptBudgetExceeded === 'hard' && !overrideReason) {
    throw new Error(
      `buildTaskPrompt: rendered prompt ${text.length} chars exceeds ${budget.hard} hard cap for role '${roleMode}'; set promptBudgetOverrideReason to explain the exception`
    );
  }

  return {
    text,
    telemetry,
  };
}

function buildTaskPrompt(spec: any, opts: any = {}) {
  return buildTaskPromptEnvelope(spec, opts).text;
}

// Parse a worker's last-turn output for the DONE:/BLOCKED: trailer. The last
// real content line must be a trailer; terminal prompt/footer noise after it is
// ignored, but prose after a trailer means the worker is still talking.
function parseTrailer(text: any) {
  const body = typeof text === 'string' ? text : '';
  const lines = body.split(/\r?\n/);
  let end = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!isTrailerTailNoise(lines[i])) {
      end = i;
      break;
    }
  }
  if (end < 0) return { outcome: 'none', detail: null };

  for (let i = end; i >= 0; i -= 1) {
    const match = TRAILER_LINE_RX.exec(lines[i]);
    if (!match) continue;

    const continuation = lines.slice(i + 1, end + 1).filter((line: any) => String(line || '').trim());
    let previousLine = lines[i];
    for (const line of continuation) {
      if (!isHardWrappedTrailerContinuation(line, previousLine)) {
        return { outcome: 'none', detail: null };
      }
      previousLine = line;
    }
    const detail = [match[2] || '', ...continuation.map((line: any) => String(line).trim())]
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (isCommandRegistryTrailer(detail)) return { outcome: 'none', detail: null };
    return {
      outcome: match[1].toLowerCase(),
      detail: detail || null,
    };
  }

  return { outcome: 'none', detail: null };
}

// Convenience: pull the last non-empty line from a worker turn — useful when
// the trailer contract wasn't followed but the caller still wants a summary.
function lastLine(text: any) {
  const lines = String(text || '').split(/\r?\n/).map((l: any) => l.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1] : '';
}

module.exports = {
  buildTaskPrompt,
  buildTaskPromptEnvelope,
  parseTrailer,
  lastLine,
  resolveRoleMode,
  resolveSkills,
  resolveTaskManifest,
  PROMPT_BUDGET,
};
