// spine-effects — the Ring-1 REAL dispatch effects for the run-ledger spine.
//
// createDrivers(effects) (drivers.cts) injects these so the autonomy loop stops
// being a dry no-op and actually drives work: dispatchWorker creates a REAL git
// worktree, assembles the LEAN size-correct prompt (prompt-pack), and spawns a
// REAL claude/codex agent in that worktree. It returns null — a TRUE async
// dispatch — so the live Ring-2 completion observer (ace-control) appends
// worker.completed when the agent finishes, exactly like the dry path.
//
// This is the proven mission-dispatch recipe (streamCreateDelegatedTask ->
// streamSpawnIntoVariant -> deliver), minus the deleted mission_features tables:
// the dispatch facts are recorded into the run-ledger, not a mission row.
//
// gate (gatePr) supplies LIVE PR facts from the integration gateway so the
// reconciler can decide mergeability; release (merge to main) is FAIL-CLOSED —
// it fires ONLY with a valid per-run owner token (ownerAuthorizedBypass), and
// the reconciler only reaches it after current-head release evidence passes. No token => return
// {} => drivers.cts emits no `merged` event => the run parks at ready_to_review
// and main is untouched.
//
// Pure of electron: the only side-effect channel is the injected `client`
// (the in-process IPC client) + the run spec carried on ctx.state.spec.

// Reuse the owner-auth predicate verbatim (default-off when
// ACE_OWNER_AUTH_TOKEN is unset). The spine never invents merge authority.
let automergePolicyModule: any;
try { automergePolicyModule = require('../../tools/ace/src/automerge-policy.cts'); }
catch { automergePolicyModule = require('../../tools/ace/src/automerge-policy.cjs'); }
const { ownerAuthorizedBypass } = automergePolicyModule;

let autoshipPolicyModule: any;
try { autoshipPolicyModule = require('../../tools/ace/src/autoship-policy.cts'); }
catch { autoshipPolicyModule = require('../../tools/ace/src/autoship-policy.cjs'); }
const { autoshipConfig, evaluateAutoshipPolicy } = autoshipPolicyModule;

// The SINGLE source of trailer truth — the same parser the live completion inbox
// uses (completion-inbox.observeReady), so the push observer and the syncWorker
// PULL agree on exactly what a terminal DONE/BLOCKED completion is.
let trailersModule: any;
try { trailersModule = require('../../tools/ace/src/trailers.cts'); }
catch { trailersModule = require('../../tools/ace/src/trailers.cjs'); }
const { listTerminalTrailers, listTerminalTrailersLoose } = trailersModule;

let taskTitleModule: any;
try { taskTitleModule = require('../task-title.cts'); }
catch { taskTitleModule = require('../task-title.cjs'); }
const { deriveTaskTitle } = taskTitleModule;

// Review-bot check facts (gate) + failing-state predicate (fixback authoring).
let reviewBotModule: any;
try { reviewBotModule = require('../../tools/ace/src/review-bot.cjs'); }
catch { reviewBotModule = require('../../tools/ace/src/review-bot.cts'); }
const { isFailingCheckState } = reviewBotModule;

// The fixback round cap — the same bound the policy applies before deciding
// DISPATCH_FIXBACK_WORKER, echoed into the fixback prompt's remaining-rounds.
let orchestrationPolicyModule: any;
try { orchestrationPolicyModule = require('../../tools/ace/src/orchestration-policy.cjs'); }
catch { orchestrationPolicyModule = require('../../tools/ace/src/orchestration-policy.cts'); }
const { FIXBACK_RETRY_CAP } = orchestrationPolicyModule;

// Exact-head computer-use artifact verifier for the worker worktree.
let goalValidationPolicyModule: any;
try { goalValidationPolicyModule = require('../../tools/ace/src/goal-validation-policy.cjs'); }
catch { goalValidationPolicyModule = require('../../tools/ace/src/goal-validation-policy.cts'); }
const { readBehavioralCompletion } = goalValidationPolicyModule;

// The canonical validator-verdict parser — the fixback author reads the last
// validator.completed record's findings through the SAME parser the reconciler
// folds verdicts with (verdict.cts is the single VERDICT regex owner).
let verdictModule: any;
try { verdictModule = require('../../tools/ace/src/verdict.cjs'); }
catch { verdictModule = require('../../tools/ace/src/verdict.cts'); }
const { parseValidatorRecordVerdict } = verdictModule;

// Validator lane model pin (owner doctrine): validator lanes run gpt-5.6-sol
// at HIGH reasoning. ACE_VALIDATOR_CODEX_MODEL is the escape hatch when the
// account lacks the pinned model (the id is pushed blind to the codex CLI).
const VALIDATOR_CODEX_MODEL_DEFAULT = 'gpt-5.6-sol';
function validatorCodexModel() {
  return String(process.env.ACE_VALIDATOR_CODEX_MODEL || '').trim() || VALIDATOR_CODEX_MODEL_DEFAULT;
}

// A spine-owned prompt exception may cover framework/manifest overhead, but it
// must not turn into an unlimited bypass for an oversized structured intent.
const SPINE_PROMPT_BUDGET_OVERRIDE_MAX_SPEC_CHARS = 2_200;

// The intent the caller submitted lives verbatim on ctx.state.spec
// (reconciler folds RUN_CREATED.payload.spec -> state.spec).
function specFromCtx(ctx: any) {
  return (ctx && ctx.state && ctx.state.spec) || {};
}

function allowedPathsOf(spec: any) {
  const cfg = autoshipConfig(spec);
  if (Array.isArray(cfg.allowPaths) && cfg.allowPaths.length) return cfg.allowPaths;
  const scope = spec.scope || {};
  const paths = scope.allow || scope.paths || spec.allowPaths || [];
  return Array.isArray(paths) ? paths : [];
}

function targetBaseBranchOf(spec: any) {
  const cfg = autoshipConfig(spec);
  return Array.isArray(cfg.targetBranches) && cfg.targetBranches.length === 1 ? cfg.targetBranches[0] : null;
}

function acceptanceIdsOf(spec: any) {
  const items = Array.isArray(spec?.acceptance) ? spec.acceptance : [];
  return items
    .map((item: any) => {
      if (item && typeof item === 'object' && item.id != null) return String(item.id).trim();
      const match = /^\s*(A\d+)\b/i.exec(String(item || ''));
      return match ? match[1] : '';
    })
    .filter(Boolean);
}

// Infer the manifest taskType from the goal text when the caller didn't set one,
// so a "build a website" run mounts the UI skill pack + routes correctly instead
// of falling back to the generic engineer pack. Conservative: returns null on no
// match (preserving today's 'feature-impl' default for everything else).
function inferTaskTypeFromGoal(goal: any) {
  const g = String(goal == null ? '' : goal).toLowerCase();
  if (/\b(websites?|web ?site|landing ?page|marketing site|frontend|front-end|\bui\b|\bux\b|web app|web page|web design)\b/.test(g)) return 'frontend';
  if (/\b(api|backend|back-end|endpoint|server|database|migration)\b/.test(g)) return 'backend';
  return null;
}

// A per-taskType skill FLOOR so a worker is never skill-less and frontend work
// always carries the UI/aesthetic pack even when the caller passed no skillIds.
// Only IDs that exist on disk (validateRunSpecSkills fail-closes on missing) —
// anthropics-frontend-design is reference-only, so it is NOT defaulted here.
function defaultSkillsForTaskType(taskType: any) {
  const t = String(taskType == null ? '' : taskType).toLowerCase();
  if (t === 'frontend' || t === 'ui' || t === 'ux' || t === 'design') {
    return ['ace-agent-pack-ui-designer', 'steipete-frontend-design'];
  }
  return [];
}


function createSpineEffects({ client, workspaceId = null, runTask: injectedRunTask = null }: any = {}) {
  if (!client || typeof client.invoke !== 'function') {
    throw new Error('createSpineEffects: an in-process client with .invoke is required');
  }

  // In-process bound for the post-success / marker-write-failure window (see
  // ensureReadyHeadReview). A landed /codex review post is latched here (keyed
  // run+head) BEFORE its durable ledger marker is attempted, so that if the
  // marker append throws, later gate ticks RETRY only the append (recovery) and
  // NEVER re-post. Without this, act-then-record would repost the /codex review
  // comment on every tick for as long as ledger.append kept failing. The ledger
  // scan (reviewAlreadyRequested) remains the cross-process authority; this Set
  // only bounds duplicate posts within a single effects instance to ONE per head
  // while the durable write is failing. Cleared on process restart — the sole
  // residual exposure is at most one benign re-post per restart, and only when a
  // post landed but its marker never became durable before the restart.
  const reviewPostedThisProcess = new Set<string>();

  // The PROVEN spawn+deliver primitive (orchestrator.runTask): ensureStream
  // (variant spawn + health/readiness + initial_prompt persistence + stale-boot
  // fallback) + the framed prompt the agent actually acts on. Injectable for
  // unit tests; lazy-required in the app so spine-effects stays import-light.
  let _runTask = injectedRunTask;
  function resolveRunTask() {
    if (_runTask) return _runTask;
    let mod: any;
    try { mod = require('../../tools/ace/src/orchestrator.cjs'); }
    catch { mod = require('../../tools/ace/src/orchestrator.cts'); }
    _runTask = mod.runTask;
    return _runTask;
  }

  // Map a run spec → the runTask spec. The structured brain intent (goal +
  // context + constraints + acceptance + skills) flows through verbatim so the
  // worker gets a real, framed prompt — not an empty tab.
  // runTask's parseSpec requires acceptance/constraints/deliverables to be arrays
  // of NON-EMPTY STRINGS — but an intent may carry {id,text} rows. Coerce.
  function toStrings(items: any) {
    return (Array.isArray(items) ? items : [])
      .map((x: any) => typeof x === 'string' ? x : (x && (x.text || x.title || x.id)) || '')
      .map((s: any) => String(s).trim())
      .filter(Boolean);
  }

  function runSpecFor(spec: any, opts: any, goal: any, taskType: any) {
    // Skill floor: the intent's skillIds win; otherwise seed a taskType default
    // (the UI pack for frontend) so the worker is never skill-less.
    const skillIds = (Array.isArray(spec.skillIds) && spec.skillIds.length)
      ? spec.skillIds
      : defaultSkillsForTaskType(taskType);
    const out: any = {
      goal,
      baseBranch: spec.baseBranch || process.env.ACE_BASE_BRANCH || 'main',
      role: 'editor',
      scope: spec.scope || {},
      taskType,
      // Owner policy: spine workers always run at xhigh reasoning — Codex at
      // xhigh (never fast), Claude at xhigh AND UltraCode/dynamic-workflow (the
      // launch intent forces ultracode regardless of effort). An explicit
      // spec.effort wins (e.g. an operator escalating Claude to max).
      effort: spec.effort || 'xhigh',
      context: spec.context,
      constraints: toStrings(spec.constraints),
      deliverables: toStrings(spec.deliverables),
      acceptance: toStrings(spec.acceptance),
      maxRounds: 1,
      maxVerifyRounds: 0,
    };
    if (skillIds.length) { out.baselineSkills = skillIds; out.skillIds = skillIds; }
    // Carry the operator's EXPLICIT capability/tool opt-ins through to the worker
    // so `--tool-mode/--browser-mode/--mcp-mode/--capability` survive the spine
    // (route resolution defaults a MISSING mode to 'off', so dropping these here
    // would silently downgrade an explicitly-requested capability). The
    // tool-override reason rides along so the catalog's audit gate is satisfied
    // by the operator's own reason rather than failing closed for lack of one.
    if (spec.toolMode) out.toolMode = spec.toolMode;
    if (spec.mcpMode) out.mcpMode = spec.mcpMode;
    if (spec.browserMode) out.browserMode = spec.browserMode;
    if (spec.codexRuntimeProfile) out.codexRuntimeProfile = spec.codexRuntimeProfile;
    if (spec.codexModel) out.codexModel = spec.codexModel;
    if (spec.toolOverrideReason) out.toolOverrideReason = spec.toolOverrideReason;
    if (Array.isArray(spec.capabilities) && spec.capabilities.length) out.capabilities = spec.capabilities;
    if (spec.effortOverrideReason) out.effortOverrideReason = spec.effortOverrideReason;
    if (opts.mode === 'validate') out.roleMode = 'reviewer';
    // Every agent must produce a PR. Instruct the WORKER/fixback (never the
    // validator, which reviews) to open a pull request and report its URL in the
    // DONE trailer. Phrased defensively so a remote-less sandbox doesn't block;
    // the gate's idempotent integrationOpenPr remains the backstop, so a run
    // still gets a PR even if the agent forgets.
    if (opts.mode !== 'validate') {
      out.deliverables = [
        ...out.deliverables,
        'Open a pull request for your branch: commit your work, and (if a git remote is configured) push the branch and run `gh pr create` — or reuse the existing PR — then include the PR URL in your DONE trailer.',
      ];
    }
    // Preserve a caller's explicit audit reason. Generic spine intents otherwise
    // receive a measured exception only when the complete nested spec is itself
    // within the implementer fence; larger specs still need an explicit reason.
    if (spec.promptBudgetOverrideReason) {
      out.promptBudgetOverrideReason = spec.promptBudgetOverrideReason;
    } else {
      const structuredSpecChars = JSON.stringify(out).length;
      if (structuredSpecChars <= SPINE_PROMPT_BUDGET_OVERRIDE_MAX_SPEC_CHARS) {
        out.promptBudgetOverrideReason =
          `run-ledger spine bounded structured spec (${structuredSpecChars}/${SPINE_PROMPT_BUDGET_OVERRIDE_MAX_SPEC_CHARS} chars)`;
      }
    }
    return out;
  }

  // The durable link a `*.dispatch.linked` annotation wrote: the stream/task/
  // branch/worktree that the gate, merge, AND the syncWorker pull act on. Reads
  // the LAST matching link (a re-dispatch supersedes). streamId is what the
  // syncWorker pull reconciles against (it is always present on the link, even
  // when a later completion record's taskId is not).
  function linkForRun(ctx: any, linkType: string) {
    try {
      const events = ctx.ledger.readRun(ctx.runId);
      for (let i = events.length - 1; i >= 0; i -= 1) {
        const e = events[i];
        if (e && e.type === linkType && e.payload && e.payload.taskId) {
          return {
            taskId: String(e.payload.taskId),
            streamId: e.payload.streamId || null,
            branch: e.payload.branch || null,
            worktreePath: e.payload.worktreePath || null,
            agent: e.payload.agent || null,
            linkedTs: typeof e.ts === 'number' && Number.isFinite(e.ts) ? e.ts : 0,
          };
        }
      }
    } catch { /* no link yet */ }
    return null;
  }
  // The WORKER's link for this run — the branch/PR the gate and merge act on.
  function workerLinkForRun(ctx: any) { return linkForRun(ctx, 'worker.dispatch.linked'); }
  function validatorLinkForRun(ctx: any) { return linkForRun(ctx, 'validator.dispatch.linked'); }
  function workerTaskIdForRun(ctx: any) {
    const link = workerLinkForRun(ctx);
    return link ? link.taskId : null;
  }

  function dispatchAttemptIndex(ctx: any, linkType: string) {
    const markerTypes = linkType === 'validator.dispatch.linked'
      ? ['validator.dispatched']
      : ['worker.dispatched', 'fixback.dispatched'];
    let count = 0;
    try {
      for (const e of ctx.ledger.readRun(ctx.runId)) {
        if (e && markerTypes.indexOf(e.type) !== -1) count += 1;
      }
    } catch { /* direct effect tests may not have a readable ledger */ }
    return count;
  }

  function appendDispatchLink(ctx: any, linkType: string, payload: any) {
    const p = payload || {};
    if (!p.streamId || !p.taskId) return null;
    return ctx.ledger.append({
      id: `${ctx.runId}:${linkType}:${dispatchAttemptIndex(ctx, linkType)}:${p.taskId}:${p.streamId}`,
      runId: ctx.runId,
      type: linkType,
      payload: {
        agent: p.agent || null, driver: p.driver || p.agent || null, workspaceId: p.workspaceId || null,
        taskId: p.taskId, streamId: p.streamId,
        worktreeId: p.worktreeId || null, worktreePath: p.worktreePath || null,
        branch: p.branch || null, baseBranch: p.baseBranch || null,
        // Launch-mode facts (durable proof of xhigh/ultracode/goal-mode launch).
        effort: p.effort || null, ultraCode: p.ultraCode === true, goalMode: p.goalMode || null,
        // Same-stream fixback resume: this link re-attaches the SAME task/stream
        // rather than recording a fresh spawn.
        resumed: p.resumed === true,
      },
    });
  }

  // Read a linked stream's SETTLED terminal trailer via the in-process client.
  // Returns the last DONE/BLOCKED trailer ({ kind, detail }) when the stream is
  // turn-complete/awaiting-input, or null while it is still working / has no
  // trailer yet. Uses streamPeekScreen — a NON-WAKING read ({ text, state }) — so
  // reconciling a finished worker NEVER re-spawns/restarts a dormant PTY (that
  // would relaunch the agent's work). If the controller is not yet tracking the
  // stream (e.g. before pty-host adoption) the peek returns empty/unknown and we
  // wait for the next tick rather than fabricate a completion. Tolerant of the
  // client's {result} wrapper so it works in-process and in tests.
  async function readTerminalTrailer(streamId: any) {
    if (!streamId) return null;
    let r: any;
    try { r = await client.invoke('streamPeekScreen', { streamId, tail: 8000 }); }
    catch { return null; }
    const out = (r && typeof r === 'object' && r.result && typeof r.result === 'object') ? r.result : (r || {});
    const state = out.state;
    if (state !== 'turn-complete' && state !== 'awaiting-input') return null; // still working
    // A trailer matching a trailer-shaped line of the SUBMITTED prompt is the
    // prompt's pty echo, never worker output.
    const echoKeys = new Set(Array.isArray(out.echoTrailerKeys) ? out.echoTrailerKeys : []);
    const notEcho = (t: any) => !echoKeys.has(`${t.kind} ${t.detail || ''}`);
    const trailers = listTerminalTrailers(String(out.text || '')).filter(notEcho);
    if (trailers.length) return trailers[trailers.length - 1]; // the latest terminal trailer wins
    // Rendered scrollback came up empty — fall back to the ANSI-stripped raw
    // ring tail the peek also carries (a TUI repaint erases the DONE line
    // from the rendered text).
    const looseTrailers = listTerminalTrailersLoose(String(out.rawTail || '')).filter(notEcho);
    if (!looseTrailers.length) return null;
    return looseTrailers[looseTrailers.length - 1];
  }

  // Spawn the real worktree + agent for one run via the proven fire-and-forget
  // dispatch (spawn → framed prompt delivered → return). Returns null (Ring 2
  // appends the completion later) — never fabricate a synchronous completion.
  async function dispatchOne(ctx: any, opts: any = {}) {
    // opts.specOverride wins (the validator passes a full validator spec); the
    // worker/fixback use the run spec verbatim.
    const spec = opts.specOverride || specFromCtx(ctx);
    const wsId = (spec.scope && spec.scope.workspaceId) || spec.workspaceId || workspaceId;
    if (!wsId) throw new Error('spine-effects: workspaceId (a projects.id) required on spec.scope.workspaceId or at injection');

    const agent = String(opts.agent || spec.agent || spec.workerAgent || 'codex').trim();
    const taskType = opts.taskType || spec.taskType || inferTaskTypeFromGoal(spec.goal) || 'feature-impl';
    const goal = opts.goalPrefix ? `${opts.goalPrefix}${spec.goal}` : spec.goal;
    const runSpec = runSpecFor(spec, opts, goal, taskType);
    const displayTitle = deriveTaskTitle({ label: spec.label, goal: spec.goal, agent, fallback: 'Ace task' });
    // Outer-loop continuation: a cycle-N+1 WORKER continues the converging line of
    // work by basing off the PRIOR cycle's branch (pushed when that cycle opened
    // its PR) instead of cutting fresh off origin/main — so the prior work is
    // present and the cycle builds on it (fresh worker, clean context, same line).
    if (opts.mode !== 'validate' && spec.continueBranch) {
      runSpec.baseBranch = String(spec.continueBranch);
      runSpec.context = [
        String(runSpec.context || ''),
        `You are CONTINUING the existing feature branch \`${spec.continueBranch}\` from a prior autonomy cycle — its work is already in your worktree; build directly on it and reuse/refresh its open PR rather than starting over.`,
      ].filter(Boolean).join('\n\n');
    }
    // Owner policy: every Claude worker enters UltraCode/dynamic-workflow — the
    // launcher sends `/effort ultracode` before the brief (orthogonal to the
    // xhigh reasoning flag runSpecFor already set). Codex stays xhigh (never
    // fast); it has no ultracode prelude.
    const agentLower = agent.toLowerCase();
    if (agentLower === 'claude' || agentLower === 'claude-code') runSpec.ultraCode = true;
    const linkType = opts.linkType || 'worker.dispatch.linked';
    const linkPayload = (link: any) => ({
      agent,
      driver: agent,
      workspaceId: wsId,
      taskId: link && link.taskId,
      streamId: link && link.streamId,
      worktreeId: link && link.worktreeId,
      worktreePath: link && link.worktreePath,
      branch: link && link.branch,
      baseBranch: link && link.baseBranch,
      // Launch-mode facts: the ledger is the durable proof that one submit
      // launched the worker at xhigh, with the UltraCode prelude (Claude) and
      // goal mode active — no manager follow-up commands involved.
      effort: runSpec.effort,
      ultraCode: runSpec.ultraCode === true,
      goalMode: 'on',
    });

    // Reuse the battle-tested spawn+deliver (the same path as
    // `task run --fire-and-forget`): a real worktree off origin/<base>, the agent
    // spawned + made ready, and the framed prompt actually delivered. Returns
    // { taskId, streamId, worktreeId, branch } after delivery.
    const result = await resolveRunTask()(client, {
      agent,
      workspaceId: wsId,
      newTask: true,
      kind: 'mission-board',
      label: (opts.labelPrefix || '') + displayTitle,
      spec: runSpec,
      fireAndForget: true,
      goalMode: 'on',
      maxRounds: 1,
      maxVerifyRounds: 0,
      refreshBase: 'auto',
      onStreamCreated: (link: any) => {
        appendDispatchLink(ctx, linkType, linkPayload(link));
      },
    });
    // Fail closed: a dispatch is only real when runTask created BOTH a visible
    // stream AND a task (a `ace ls` stream + the task/worktree the gate and
    // merge act on). A partial/empty result means the spawn did not actually
    // land — throw so the kernel records worker.dispatch.failed and the run
    // blocks with this exact error rather than leaving a phantom "dispatched".
    if (!result || !result.streamId || !result.taskId) {
      throw new Error(
        `spine-effects: dispatch did not create a linked stream/task `
        + `(streamId=${(result && result.streamId) || 'null'}, taskId=${(result && result.taskId) || 'null'})`,
      );
    }

    // Record the real-dispatch FACTS into the ledger (the dispatch MARKER is
    // already appended by the kernel runStep — this annotation links the run to
    // its task/branch so the completion closes the right run and the gate/merge
    // act on this branch). This append is NOT best-effort: if the link cannot be
    // recorded the dispatch is not durably linked, so let it propagate and fail
    // closed (kernel records worker.dispatch.failed) — never report a dispatch we
    // cannot prove is linked.
    appendDispatchLink(ctx, linkType, linkPayload(result));

    return null; // TRUE async dispatch — Ring 2 appends the completion later.
  }

  // Fixback evidence directives — the fixer must attack what actually FAILED,
  // not re-run the original goal blind. Three sources, all optional:
  //   1. the last validator.completed request-changes findings (ledger),
  //   2. failing PR CI checks (state.pr.checkState),
  //   3. the failing review-bot ('validate' / PR Validator) verdict + its
  //      Must-fix findings (state.pr.reviewBot, folded from gate facts).
  // Mirrors the loop-ship composeShipGoal directive style (loop-fixback.cts).
  function fixbackDirectives(ctx: any) {
    const st = (ctx && ctx.state) || {};
    const pr = (st.pr && typeof st.pr === 'object') ? st.pr : {};
    const parts: string[] = [];
    try {
      const events = ctx.ledger.readRun(ctx.runId);
      for (let i = events.length - 1; i >= 0; i -= 1) {
        const e = events[i];
        if (!e || e.type !== 'validator.completed') continue;
        const parsed = e.payload && e.payload.record ? parseValidatorRecordVerdict(e.payload.record) : null;
        if (parsed && parsed.verdict === 'request-changes') {
          const findings = Array.isArray(parsed.packetInput && parsed.packetInput.findings)
            ? parsed.packetInput.findings.map((f: any) => String(f || '').trim()).filter(Boolean)
            : [];
          parts.push(
            findings.length
              ? `The validator returned VERDICT=request-changes. Address every finding:\n${findings.map((f: string) => `  - ${f}`).join('\n')}`
              : `The validator returned VERDICT=request-changes: ${parsed.detail}`,
          );
        }
        break; // only the LAST validator verdict is live
      }
    } catch { /* no ledger in direct effect tests — findings stay optional */ }
    const prRef = pr.number != null ? `#${pr.number}` : (pr.url || 'the open PR');
    if (pr.exists && isFailingCheckState(pr.checkState)) {
      parts.push(
        `CI is FAILING on PR ${prRef} (checkState=${pr.checkState}). Identify the failing checks with `
        + `\`gh pr checks${pr.number != null ? ` ${pr.number}` : ''}\`, read their logs with `
        + '`gh run view --log-failed`, fix the underlying failures on the branch, and push so the checks re-run.',
      );
    }
    const reviewBot = (pr.reviewBot && typeof pr.reviewBot === 'object') ? pr.reviewBot : null;
    if (reviewBot && isFailingCheckState(reviewBot.state)) {
      const mustFix = Array.isArray(reviewBot.mustFix)
        ? reviewBot.mustFix.map((f: any) => String(f || '').trim()).filter(Boolean)
        : [];
      parts.push(
        `The PR review-bot check '${reviewBot.name || 'validate'}' is FAILING on PR ${prRef}`
        + `${reviewBot.score != null ? ` (score ${reviewBot.score}/5)` : ''}. `
        + (mustFix.length
          ? `Fix every Must-fix finding:\n${mustFix.map((f: string) => `  - ${f}`).join('\n')}`
          : 'Read its review comment on the PR and address every Must-fix finding.')
        + ' Push so the check re-runs.',
      );
    }
    return parts.join('\n\n');
  }

  // Is the linked stream settled and addressable (turn-complete/awaiting-input)?
  // Non-waking peek — a dead/unknown stream reads as not-alive and the fixback
  // falls back to a same-task respawn instead of failing the round.
  async function streamSettled(streamId: any) {
    if (!streamId) return false;
    try {
      const r = await client.invoke('streamPeekScreen', { streamId, tail: 200 });
      const out = (r && typeof r === 'object' && r.result && typeof r.result === 'object') ? r.result : (r || {});
      return out.state === 'turn-complete' || out.state === 'awaiting-input';
    } catch {
      return false;
    }
  }

  // SAME-STREAM fixback: ordinary review findings (ReviewBot Must-fix, failing
  // CI, validator request-changes) are delivered back into the ORIGINAL worker
  // stream — the same conversation that produced the PR — so closure never
  // requires Hermes/operator forwarding and never opens a new lane or card.
  // Fallback ladder, most-preserving first:
  //   1. original stream settled  -> paste the round prompt into that stream;
  //   2. stream gone, task known  -> respawn the agent onto the SAME task/
  //      worktree/branch (runTask taskId path) — same lane, same PR;
  //   3. no worker link at all    -> FAIL CLOSED (bounded blocker). A run with
  //      no recorded lineage cannot resume anything, and a fresh dispatch here
  //      would spawn a replacement lane (new worktree/branch/PR) that orphans
  //      the original — exactly what this contract forbids.
  async function resumeFixback(ctx: any) {
    const wlink = workerLinkForRun(ctx);
    if (!wlink || !wlink.taskId) {
      throw new Error(
        'spine-effects: fixback has no linked worker lineage (no worker.dispatch.linked with a taskId) '
        + '— refusing to spawn a replacement lane; owner may re-dispatch explicitly',
      );
    }
    const spec = specFromCtx(ctx);
    const st = (ctx && ctx.state) || {};
    const pr = (st.pr && typeof st.pr === 'object') ? st.pr : {};
    const wsId = (spec.scope && spec.scope.workspaceId) || spec.workspaceId || workspaceId;
    const alive = await streamSettled(wlink.streamId);
    // ctx.state was reconciled BEFORE the kernel appended this round's
    // fixback.dispatched marker, so attempts is the count of PRIOR rounds.
    const round = (Number(st.fixback && st.fixback.attempts) || 0) + 1;
    const humanDirectives = typeof ctx?.decision?.fixbackDirectives === 'string'
      ? ctx.decision.fixbackDirectives.trim()
      : '';
    const directives = [fixbackDirectives(ctx), humanDirectives].filter(Boolean).join('\n\n');
    const prRef = pr.url || (pr.number != null ? `PR #${pr.number}` : wlink.branch || wlink.taskId);
    const agent = wlink.agent || spec.agent || spec.workerAgent || 'codex';
    const fixbackSpec: any = {
      goal: `Fixback round ${round}/${FIXBACK_RETRY_CAP}: resolve the review findings on ${prRef} and push the fix`,
      baseBranch: pr.baseBranch || spec.baseBranch || process.env.ACE_BASE_BRANCH || 'main',
      role: 'editor',
      taskType: 'fixback',
      roleMode: 'fixback',
      skillPack: 'generic',
      // parseSpec requires a scope object; paths is always an array so the
      // scope is never empty even without a workspace.
      scope: { ...(spec.scope || {}), ...(wsId ? { workspaceId: wsId } : {}), paths: allowedPathsOf(spec) },
      // The original context rides along for the same-TASK respawn path, whose
      // fresh pty has none of the original conversation (on a same-stream
      // resume it is redundant but harmless).
      context: [
        `You are the SAME worker that produced ${prRef} — continue in your existing worktree/branch (${wlink.branch || '?'}).`,
        String(spec.context || ''),
        directives,
      ].filter(Boolean).join('\n\n'),
      constraints: [
        'Patch only the reported findings.',
        'Use the existing task worktree, branch, and PR.',
        'Do not create a replacement worker, branch, or PR.',
      ],
      deliverables: [
        'Commit the fix to the existing branch and push so the PR head advances and the exact-head review re-runs.',
        `End with exactly one trailer of the form \`DONE: fixback round ${round} — <summary>\` or \`BLOCKED: fixback round ${round} — <reason>\` (the round tag makes your verdict distinguishable from earlier trailers in this stream).`,
      ],
      acceptance: [
        'Every Must-fix finding and failing check is addressed on a newly pushed head.',
      ],
      requireChanges: true,
      promptBudgetOverrideReason: 'spine same-stream fixback directives',
      fixback: { attempts: round, remaining: Math.max(0, FIXBACK_RETRY_CAP - round) },
    };
    const linkPayload = (link: any) => ({
      agent,
      driver: agent,
      workspaceId: wsId || null,
      taskId: (link && link.taskId) || wlink.taskId,
      streamId: link && link.streamId,
      worktreeId: (link && link.worktreeId) || null,
      worktreePath: (link && link.worktreePath) || wlink.worktreePath,
      branch: (link && link.branch) || wlink.branch,
      baseBranch: (link && link.baseBranch) || null,
      effort: fixbackSpec.effort || null,
      resumed: true,
    });
    // NOTE deliberately NO onStreamCreated here: runTask fires it right after
    // the (pre-existing) stream resolves, BEFORE delivery — appending the link
    // that early would hand the kernel its link proof for a round whose prompt
    // may never have landed. The link is appended only after delivery below.
    const result = await resolveRunTask()(client, {
      agent,
      // Same-stream when the original conversation is addressable; otherwise
      // respawn onto the SAME task/worktree (ensureStream's taskId path).
      ...(alive ? { streamId: wlink.streamId } : {}),
      taskId: wlink.taskId,
      workspaceId: wsId || null,
      newTask: false,
      kind: 'mission-fixback',
      label: `fix ${deriveTaskTitle({ label: spec.label, goal: spec.goal, agent, fallback: 'Ace task' })}`,
      spec: fixbackSpec,
      fireAndForget: true,
      maxRounds: 1,
      maxVerifyRounds: 0,
      mode: 'paste',
    });
    // Fail closed exactly like dispatchOne — but delivery-aware: runTask's
    // fire-and-forget path RESOLVES (never throws) with {outcome:'error',
    // promptDelivered:false} when the prompt could not be delivered. A round is
    // only real when a stream took the delivery, so anything short throws and
    // the kernel records worker.dispatch.failed (bounded blocker), instead of a
    // phantom in-flight round the sync pull would wait on forever.
    const deliveryFailed =
      !result ||
      !result.streamId ||
      result.outcome === 'error' ||
      result.promptDelivered === false;
    if (deliveryFailed) {
      throw new Error(
        `spine-effects: same-stream fixback delivery did not land `
        + `(streamId=${(result && result.streamId) || 'null'}, taskId=${(result && result.taskId) || wlink.taskId}, `
        + `outcome=${(result && result.outcome) || 'null'}, promptDelivered=${result ? String(result.promptDelivered) : 'null'})`,
      );
    }
    appendDispatchLink(ctx, 'worker.dispatch.linked', linkPayload(result));
    return null; // completion arrives via Ring 2 or the syncWorker pull
  }

  return {
    // Worker + fixback (drivers.cts falls dispatchFixback back to dispatchWorker
    // if absent, but we provide it explicitly so findings resume the original
    // worker stream instead of spawning a replacement lane).
    dispatchWorker: (ctx: any) => dispatchOne(ctx, {}),
    dispatchFixback: (ctx: any) => resumeFixback(ctx),

    // syncWorker — the PULL reconcile for an in-flight worker/validator whose
    // completion PUSH never landed. The Ring-2 completion observer mirrors a
    // worker's DONE/BLOCKED trailer into the ledger, but it depends on an
    // in-memory completion turn; a long-running fire-and-forget worker (these run
    // in a detached pty-host) that finishes after a controller restart loses that
    // turn, so the push never fires and the run sits forever at SYNC_WORKER —
    // board stuck in_progress with a DONE trailer on the stream. The reconciler
    // already asks for SYNC_WORKER on a dispatched+linked-but-not-done worker (or
    // validator); this effect PULLS the live stream's settled terminal trailer and
    // returns the completion so the run advances — a worker DONE walks to the
    // computer-use validator (review), NEVER straight to done. Returns null while
    // the stream is still working, so the loop's no-progress guard simply pauses
    // (cheap + idempotent to re-run on the periodic reconcile tick).
    syncWorker: async (ctx: any) => {
      const st = (ctx && ctx.state) || {};
      const worker = st.worker || {};
      const validator = st.validator || {};
      // Pull completions carry the same descriptive auto-telemetry the Ring-2
      // push synthesizes (agent + wall-clock from the dispatch link) — without
      // this, every pull-healed run stays telemetry-null on the board forever.
      const autoTelemetry = (link: any) => {
        const durationMs = link && link.linkedTs > 0 ? Math.max(0, Date.now() - link.linkedTs) : 0;
        if (!link?.agent && durationMs === 0) return undefined;
        return {
          ...(link?.agent ? { agent: link.agent } : {}),
          ...(durationMs > 0 ? { durationMs } : {}),
          notes: 'auto-collected:spine-sync',
        };
      };
      // Sync whichever agent the spine is currently waiting on. The validator is
      // checked first: once the worker is done, SYNC_WORKER means the VALIDATOR is
      // in flight, and its verdict trailer must close validator.completed.
      if (validator.dispatched && !validator.done) {
        const vlink = validatorLinkForRun(ctx);
        if (!vlink || !vlink.streamId) return null;
        const term = await readTerminalTrailer(vlink.streamId);
        if (!term) return null;
        const telemetry = autoTelemetry(vlink);
        return {
          event: {
            type: 'validator.completed',
            payload: {
              record: { detail: term.detail },
              streamId: vlink.streamId,
              ...(telemetry ? { telemetry } : {}),
            },
          },
        };
      }
      if (worker.dispatched && !worker.done) {
        const wlink = workerLinkForRun(ctx);
        if (!wlink || !wlink.streamId) return null;
        const term = await readTerminalTrailer(wlink.streamId);
        if (!term) return null;
        const telemetry = autoTelemetry(wlink);
        return {
          outcome: term.kind === 'blocked' ? 'BLOCKED' : 'DONE',
          detail: term.detail,
          streamId: wlink.streamId,
          ...(wlink.agent ? { agent: wlink.agent } : {}),
          ...(telemetry ? { telemetry } : {}),
        };
      }
      // A same-stream fixback round is in flight: worker.done stays true from
      // the ORIGINAL completion, so the round is visible only via the
      // fixbackInFlight fold. Pull the resumed stream's NEW settled trailer.
      // STALE-TRAILER GUARD: the original DONE is still in that stream's
      // scrollback — a trailer identical to any prior recorded completion is
      // the old verdict re-read, never this round's result. Only a trailer the
      // ledger has not seen closes the round (duplicate/stale verdicts are
      // dropped here, which also keeps a replayed pull idempotent).
      if (worker.done && worker.fixbackInFlight) {
        const wlink = workerLinkForRun(ctx);
        if (!wlink || !wlink.streamId) return null;
        const term = await readTerminalTrailer(wlink.streamId);
        if (!term) return null;
        const seen = new Set();
        try {
          for (const e of ctx.ledger.readRun(ctx.runId)) {
            if (e && e.type === 'worker.completed' && e.payload) {
              const kind = String(e.payload.outcome || '').trim().toUpperCase() === 'BLOCKED' ? 'blocked' : 'done';
              seen.add(`${kind}\u0000${String(e.payload.detail == null ? '' : e.payload.detail)}`);
            }
          }
        } catch { /* no readable ledger in direct effect tests — accept the trailer */ }
        if (seen.has(`${term.kind}\u0000${String(term.detail == null ? '' : term.detail)}`)) return null;
        const telemetry = autoTelemetry(wlink);
        return {
          outcome: term.kind === 'blocked' ? 'BLOCKED' : 'DONE',
          detail: term.detail,
          streamId: wlink.streamId,
          ...(wlink.agent ? { agent: wlink.agent } : {}),
          ...(telemetry ? { telemetry } : {}),
        };
      }
      return null;
    },

    // Validator — ALWAYS codex (owner rule), driving the computer-use validator
    // skill. It reviews the WORKER's committed change (read from the dispatch
    // annotation's worktreePath — the worker doesn't push, so the on-disk worktree
    // is the only local source of truth) and MUST end with a VERDICT trailer the
    // reconciler folds: pass -> gate, request-changes -> fixback (up to the cap).
    runValidation: (ctx: any) => {
      const runSpec = specFromCtx(ctx);
      const link = workerLinkForRun(ctx);
      const accept = toStrings(runSpec.acceptance);
      const context = [
        'You are the VALIDATOR (codex, computer-use). Independently verify the worker did the job — do NOT modify any files.',
        link && link.worktreePath
          ? `The worker's change is in the worktree at ${link.worktreePath} (branch ${link.branch || '?'}). Review it: \`git -C ${link.worktreePath} --no-pager diff origin/main\` (catches committed + uncommitted) and read the changed files in that directory.`
          : 'Review the change in your worktree.',
        accept.length
          ? `Verify each acceptance criterion holds, with concrete evidence:\n${accept.map((a: any, i: number) => `  - A${i + 1}: ${a}`).join('\n')}`
          : 'Verify the stated goal is satisfied, with evidence.',
        // Evidence artifact + adversarial followups — the autonomy OUTER loop reads
        // this completion.json (never the trailer prose) to gate convergence on REAL
        // computer-use evidence and to author the next cycle's goal.
        'Write your computer-use evidence bundle (schema `ace.computer_use_behavioral_validation.v1`) to `.ace/computer-use/completion.json` in your worktree root — include `validatedHeadSha`, `checkedAcceptance[]` (every behavioral A-ID, each passing for a pass), and `passed`. The autonomy loop reads this ARTIFACT, not your prose.',
        'Fail closed on runtime capability: before judging acceptance, confirm the Codex app-parity runtime exposes app/plugin/computer-use tools. If list-apps/app-state/screenshot or the scoped harmless UI action cannot run because the runtime, plugin, app-server, or macOS/TCC permission is unavailable, write completion.json with `passed:false` and return `BLOCKED: VERDICT=block — <precise missing runtime/permission>`.',
        'ADVERSARIALLY HUNT for new gaps, regressions, and edge cases beyond the acceptance criteria — things that surfaced only under real use. Record each as a short, de-duplicated `followups[]` entry in completion.json, and set `proposedNextGoal` to the single best next goal phrased as the owner would write it (concrete, outcome-first). If the feature is genuinely complete and you found nothing new, leave `followups` empty — that is how the loop CONVERGES and stops.',
        'End your FINAL message with EXACTLY ONE trailer (a real verdict — never invent a pass):',
        '  DONE: VERDICT=pass {"verdict":"pass","scorecard":[{"id":"A1","met":true,"evidence":"<pointer>"}]}',
        '  DONE: VERDICT=request-changes {"verdict":"request-changes","findings":["<what fails>"]}',
        '  BLOCKED: VERDICT=block — <reason you could not validate>',
      ].filter(Boolean).join('\n\n');
      return dispatchOne(ctx, {
        agent: 'codex', taskType: 'validator', goalPrefix: 'Validate (computer-use): ',
        labelPrefix: 'validate ', linkType: 'validator.dispatch.linked', mode: 'validate',
        specOverride: {
          ...runSpec, agent: 'codex', mode: 'validate',
          skillIds: ['ace-computer-use-validator'],
          // Owner doctrine: validator lanes are pinned to gpt-5.6-sol at HIGH
          // reasoning (below the codex xhigh default, so the agent-catalog
          // contract requires the override reason; raising would not).
          codexModel: validatorCodexModel(),
          effort: 'high',
          effortOverrideReason: `owner doctrine: validator lanes run ${validatorCodexModel()} at high reasoning`,
          codexRuntimeProfile: 'app-parity',
          toolMode: 'on',
          mcpMode: 'global',
          browserMode: 'on',
          toolOverrideReason: 'computer-use validator requires Codex app-parity runtime readiness.',
          capabilities: Array.from(new Set([...(Array.isArray(runSpec.capabilities) ? runSpec.capabilities : []), 'app-parity', 'browser', 'computer-use', 'runtime'])),
          context,
          constraints: ["Validation only — do not modify the worker's files."],
          // The validator prompt legitimately exceeds the lean reviewer cap (it
          // carries the verdict contract + worktree diff + acceptance rubric).
          promptBudgetOverrideReason: 'computer-use validator contract + worker worktree diff + acceptance rubric',
        },
      });
    },

    // gatePr — supply LIVE PR FACTS (no merge). Ensure the worker's PR exists
    // (idempotent open), then read its gate facts from the integration gateway.
    // drivers.cts wraps these as gate.evaluated; the reconciler folds them and
    // re-runs evaluateMergeGate to decide mergeability. Field names match the
    // reconciler GATE_EVALUATED fold exactly (prExists, not exists).
    gatePr: async (ctx: any) => openAndGate(ctx),

    // release — the merge GOAL. Normal policy reaches this only after the
    // read-only gate has produced complete current-head release evidence. The
    // no-PR branch remains as a safe compatibility backstop:
    //  (1) NO PR yet  -> push the branch + open the PR + read its gate facts and
    //      emit a gate.evaluated. This is SAFE and needs no owner token (it never
    //      touches main). Without it nothing ever opens the PR, so the run would
    //      stall at ready_to_review forever (the policy keeps asking to "open PR
    //      via the release goal" but the merge-only effect can't, because there
    //      is no PR number yet). This is the open phase that unblocks the
    //      ready_to_review -> done progression.
    //  (2) PR EXISTS  -> FAIL-CLOSED merge to main: fires ONLY with a valid
    //      per-run owner token. No token (or an incomplete merge) => return {} =>
    //      no `merged` event => the run parks at ready_to_review with an OPEN,
    //      gated, reviewable PR, main untouched.
    release: async (ctx: any) => {
      const pr = (ctx && ctx.state && ctx.state.pr) || {};
      if (!pr.exists) {
        // Open phase — emit the PR's gate facts so pr.exists flips true and the
        // run advances toward the gate/merge instead of stalling.
        const facts = await openAndGate(ctx);
        if (!facts.prExists) return {};
        return { event: { type: 'gate.evaluated', payload: facts } };
      }
      // A direct or stale release walk cannot bypass the evidence verdict.
      if (ctx?.decision?.releaseEvidence?.ok !== true) return {};
      // Merge phase — owner-token-gated (fail closed). Belt-and-braces: never
      // merge past a FAILING review-bot verdict — the policy should never route
      // here with red checks (rollupCheckState folds the review-bot check into
      // checkState), but a stale walk must park, not merge.
      const reviewBot = (pr.reviewBot && typeof pr.reviewBot === 'object') ? pr.reviewBot : null;
      if (reviewBot && isFailingCheckState(reviewBot.state)) return {};
      const spec = specFromCtx(ctx);
      const ownerAuthorized = ownerAuthorizedBypass(spec);
      const autoship = ownerAuthorized
        ? null
        : evaluateAutoshipPolicy({ spec, state: ctx.state, gate: ctx.gate });
      if (!ownerAuthorized && autoship?.autoMergeAllowed !== true) return {};
      const taskId = workerTaskIdForRun(ctx);
      const prNumber = pr.number ?? null;
      if (!taskId || prNumber == null) return {};
      const gate = ownerAuthorized ? undefined : autoshipMergeGate(ctx, autoship);
      if (!ownerAuthorized) {
        ctx.ledger.append({
          runId: ctx.runId,
          type: 'autoship.merge.started',
          payload: { prNumber, status: autoship.status, reason: autoship.reason },
        });
      }
      let merged: any;
      try {
        merged = await client.invoke('integrationMergePr', {
          taskId,
          prNumber,
          ...(gate ? { gate, allowedPaths: gate.allowedPaths } : {}),
        });
      } catch (err: any) {
        if (!ownerAuthorized) {
          ctx.ledger.append({
            runId: ctx.runId,
            type: 'autoship.merge.blocked',
            payload: {
              prNumber,
              reason: err && err.message ? String(err.message) : String(err),
            },
          });
        }
        return {};
      }
      const res = (merged && merged.result) || {};
      const verificationPr = res.mergeVerification?.pr || {};
      const sha =
        res.mergedSha ??
        res.sha ??
        (res.merge && res.merge.sha) ??
        verificationPr.mergeCommitSha ??
        verificationPr.baseShaAfter ??
        null;
      if (merged && merged.ok !== false && sha) {
        return {
          sha,
          headSha: res.headSha ?? verificationPr.headSha ?? null,
          cleanedUp: res.cleanedUp === true || res.postMergeCleanup?.ok === true,
          prNumber,
          prUrl: pr.url || verificationPr.url || null,
          prState: 'MERGED',
          baseBranch: pr.baseBranch || verificationPr.baseRefName || null,
          headBranch: pr.headBranch || verificationPr.headRefName || null,
        };
      }
      if (!ownerAuthorized) {
        ctx.ledger.append({
          runId: ctx.runId,
          type: 'autoship.merge.blocked',
          payload: {
            prNumber,
            reason: res.error || (Array.isArray(res.failures) && res.failures[0]?.code) || 'integration merge did not complete',
          },
        });
      }
      return {}; // merge not completed -> stay parked, never a phantom `merged`
    },
  };

  // Shared open+gate: ensure the worker's PR exists (idempotent open), read its
  // live gate facts, then enforce the ready-head review request (mark a draft
  // ready + request ReviewBot//codex review once per exact head). Used by gatePr
  // (the GATE action) AND release's open phase, so the same facts shape feeds
  // the reconciler GATE_EVALUATED fold.
  async function openAndGate(ctx: any) {
    const taskId = workerTaskIdForRun(ctx);
    if (!taskId) return { prExists: false, mergeable: false, checkState: 'pending' };
    const allow = allowedPathsOf(specFromCtx(ctx));
    const cfg = autoshipConfig(specFromCtx(ctx));
    let prNumber: any = null;
    try {
      const opened = await client.invoke('integrationOpenPr', {
        taskId,
        allowedPaths: allow,
        ...(targetBaseBranchOf(specFromCtx(ctx)) ? { base: targetBaseBranchOf(specFromCtx(ctx)) } : {}),
        ...(cfg.draftBehavior === 'draft' ? { draft: true } : {}),
      });
      const or = (opened && opened.result) || {};
      prNumber = or.prNumber ?? (or.pr && or.pr.number) ?? opened?.prNumber ?? null;
    } catch { /* no PR could be opened — park */ }
    if (prNumber == null) return { prExists: false, mergeable: false, checkState: 'pending' };

    const facts = await readGateFacts(ctx, taskId, prNumber, allow);
    return ensureReadyHeadReview(ctx, taskId, allow, facts);
  }

  // The gateway NEVER throws for gh failures — it resolves {ok:false} envelopes
  // (integration-gateway runOnce). A try/catch alone would read every failure
  // as success, so both request steps below must check `ok` explicitly.
  function envelopeOk(env: any) {
    const e = (env && typeof env === 'object') ? env : {};
    return e.ok !== false;
  }

  // Has the ready-head review already been requested for this EXACT head? The
  // ledger is the authority (not the folded last-wins scalar): a head that
  // oscillates A→B→A must not re-post the /codex review comment for A.
  function reviewAlreadyRequested(ctx: any, headSha: any) {
    try {
      for (const e of ctx.ledger.readRun(ctx.runId)) {
        if (e && e.type === 'review.requested' && e.payload && String(e.payload.headSha) === String(headSha)) {
          return true;
        }
      }
    } catch { /* no readable ledger in direct effect tests */ }
    return false;
  }

  // A1 of the contractual review closure: after the PR exists, the CONTROLLER
  // requests the ready-head review — a draft is marked ready (the review-bot
  // skips drafts, and ready_for_review triggers it at the current head) and the
  // /codex review request is posted ONCE per exact head. Idempotency is the
  // ledger: review.requested is appended with an id keyed by headSha and the
  // ledger is scanned before posting. A failed request appends nothing, so the
  // next gate tick retries. Every push produces a new head, which re-arms the
  // request — that is the "repeat exact-head review until pass" loop.
  // Owner draft policy is respected: when the spec's autoship config explicitly
  // asks for draft PRs (draftBehavior 'draft'), the controller never un-drafts —
  // the run parks at the (non-terminal) draft gate until the owner readies it.
  async function ensureReadyHeadReview(ctx: any, taskId: any, allow: any, facts: any) {
    if (!facts || facts.prExists !== true || facts.headSha == null) return facts;
    let out = facts;
    if (out.isDraft === true) {
      if (autoshipConfig(specFromCtx(ctx)).draftBehavior === 'draft') return out; // owner-held draft
      let readied: any;
      try {
        readied = await client.invoke('integrationReadyPr', { taskId, prNumber: out.prNumber });
      } catch {
        return out; // still draft — the run keeps gating (non-terminal) and retries
      }
      if (!envelopeOk(readied)) return out; // gh failed — retry next gate tick
      try {
        out = await readGateFacts(ctx, taskId, out.prNumber, allow);
      } catch {
        return facts;
      }
      if (!out || out.prExists !== true || out.headSha == null) return out;
    }
    if (!reviewAlreadyRequested(ctx, out.headSha)) {
      const postKey = `${ctx.runId}:${out.headSha}`;
      // Finalize the headSha-keyed durable idempotency marker. Isolated so both
      // the post-success path and the retry-only path below write the identical
      // record; a throw here is caught by each caller (the ledger append is the
      // fragile step this whole guard exists to survive).
      const recordRequested = () => {
        ctx.ledger.append({
          id: `${ctx.runId}:review.requested:${out.headSha}`,
          runId: ctx.runId,
          type: 'review.requested',
          payload: {
            headSha: out.headSha,
            prNumber: out.prNumber ?? null,
            via: ['ready-head-review-bot', 'codex-review'],
          },
        });
      };
      if (reviewPostedThisProcess.has(postKey)) {
        // The post already LANDED this process, but its durable marker is still
        // missing (reviewAlreadyRequested was false), so a prior append threw.
        // RETRY only the append — never the post. This is the bound + recovery
        // for the post-success/marker-write-failure window: a persistently
        // failing ledger write costs exactly one post (already made) and self-
        // heals the instant the append succeeds, instead of reposting /codex
        // review on every tick.
        try { recordRequested(); } catch { /* still unwritable — re-attempt next tick, no re-post */ }
        return out;
      }
      // Act-then-record: post the /codex review FIRST, and only finalize the
      // headSha-keyed record once the post actually lands. The gateway never
      // throws — a gh failure resolves {ok:false} — so both a throw and a false
      // envelope must return WITHOUT recording (and WITHOUT marking posted), or
      // the intent sticks for a post that never happened and the exact-head
      // request is never retried (the /codex review silently dropped). A failed
      // post therefore freely retries the post next tick; a succeeded post can
      // never repost because postKey is now latched.
      let requested: any;
      try {
        requested = await client.invoke('integrationRequestReview', {
          taskId,
          prNumber: out.prNumber,
          body: '/codex review',
        });
      } catch {
        return out; // post threw — nothing posted, retry next gate tick
      }
      if (!envelopeOk(requested)) return out; // gh failed {ok:false} — retry next tick
      // The post landed. Latch it in-process BEFORE attempting the durable
      // append so a failing append can never escalate into a second post.
      reviewPostedThisProcess.add(postKey);
      try { recordRequested(); } catch { /* post landed; marker write failed — bounded: retried next tick via the postKey branch, never re-posted */ }
    }
    return out;
  }

  // Read the PR's live gate facts from the integration gateway. FAIL CLOSED on
  // a failed or incomplete read: the gateway resolves {ok:false} envelopes
  // (never throws), and recording "facts" from one would emit a gate.evaluated
  // that clears event-order staleness while the fold retains the PREVIOUS
  // head's check states — authorizing a spurious fixback round from stale
  // evidence. A throw here records nothing; the run parks and the next tick
  // re-reads.
  async function readGateFacts(ctx: any, taskId: any, prNumber: any, allow: any) {
    const gated = await client.invoke('integrationGate', {
      taskId,
      prNumber,
      allowedPaths: allow,
      clawpatchEnforced: ctx?.decision?.clawpatchRequired === true,
    });
    if (gated && gated.ok === false) {
      throw new Error(
        `spine-effects: integration gate read failed (${(gated.result && gated.result.error) || 'gateway failure'}) — facts not recorded, retried next tick`,
      );
    }
    const pr = (gated && gated.result && gated.result.pr) || {};
    if (pr.headSha == null) {
      throw new Error(
        'spine-effects: integration gate returned no PR head — incomplete facts not recorded, retried next tick',
      );
    }
    const headSha = pr.headSha ?? null;
    const rawValidation = (gated && gated.result && gated.result.validation) ?? null;
    const rawReviewBot = (gated && gated.result && gated.result.reviewBot) ?? null;
    const rawClawpatch =
      (gated && gated.result && gated.result.clawpatch) ??
      (gated && gated.result && gated.result.gate && gated.result.gate.clawpatch) ??
      null;
    let computerUseEvidence: any = null;
    if (ctx?.decision?.computerUseRequired === true) {
      const workerLink = workerLinkForRun(ctx);
      const artifactPath = workerLink?.worktreePath
        ? require('node:path').join(String(workerLink.worktreePath), '.ace', 'computer-use', 'completion.json')
        : null;
      const verified = readBehavioralCompletion({
        completionJsonPath: artifactPath,
        validatedHeadSha: headSha,
        requiredIds: acceptanceIdsOf(specFromCtx(ctx)),
      });
      computerUseEvidence = {
        verified: verified?.ok === true,
        headSha,
        artifactPath,
        reason: verified?.ok === true ? null : verified?.reason || 'computer-use evidence unavailable',
      };
    }
    return {
      prExists: true,
      prNumber: pr.number ?? prNumber,
      prUrl: pr.url ?? null,
      prState: pr.state ?? null,
      isDraft: pr.isDraft === true,
      headBranch: pr.headRefName ?? null,
      baseBranch: pr.baseRefName ?? null,
      headSha,
      baseSha: pr.baseSha ?? null,
      checkState: pr.checkState ?? null,
      mergeable: pr.mergeable ?? null,
      changedFiles: pr.files ?? [],
      allowedPaths: allow,
      validation: rawValidation ? { ...rawValidation } : null,
      // The review-bot ('validate' / PR Validator) check by name — folded to
      // state.pr.reviewBot. Pin it to the head whose status rollup supplied it.
      reviewBot: rawReviewBot ? { ...rawReviewBot, headSha } : null,
      clawpatch: rawClawpatch ? { ...rawClawpatch } : null,
      computerUseEvidence,
    };
  }

  function autoshipMergeGate(ctx: any, autoship: any) {
    const st = (ctx && ctx.state) || {};
    const spec = specFromCtx(ctx);
    const cfg = autoshipConfig(spec);
    const validator = st.validator || {};
    const pr = st.pr || {};
    const gate = ctx.gate && typeof ctx.gate === 'object' ? ctx.gate : {};
    const validation = gate.validation && typeof gate.validation === 'object' ? gate.validation : {};
    const expectedHeadSha = st.validatedHeadSha || validator.validatedHeadSha || st.currentHeadSha || pr.headSha || null;
    return {
      ...gate,
      automerge: true,
      releaseTrainGuard: cfg.releaseTrainGuard !== false,
      releaseWorkflow: autoship?.releaseWorkflow || gate.releaseWorkflow || null,
      expectedBaseBranch: targetBaseBranchOf(spec) || gate.expectedBaseBranch || pr.baseBranch || null,
      expectedHeadSha,
      expectedPrHeadSha: expectedHeadSha,
      validation: {
        ...validation,
        independent: 'PASS',
        required: true,
      },
      allowedPaths: Array.isArray(pr.allowedPaths) && pr.allowedPaths.length ? pr.allowedPaths : allowedPathsOf(spec),
      computerUseEvidence: validator.computerUseEvidence === true || gate.computerUseEvidence === true,
    };
  }
}

module.exports = { createSpineEffects };
