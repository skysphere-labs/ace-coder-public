const projectWikiCurator = require('./project-wiki-curator.cjs');
// Wiki cleanliness guardrails are single-sourced in the knowledge contract,
// which ships inside the ace bundle (same cross-package pattern as
// electron/harness/completion-result.cts required from index.cts).
const {
  WIKI_FAILED_SNAPSHOT_SENTENCE,
  describeContamination,
  formatFailedSnapshotSection,
} = require('../../../electron/harness/knowledge-contract.cts');

function createProjectHarnessHandlers(deps: any) {
  const {
    fs,
    path,
    die,
    normalizeText,
    repoRootFromCli,
    resolveProjectDirFlag,
    aceDir,
    readJsonFile,
    writeJsonFile,
    validateCompletionResult,
    describeCommands,
  } = deps;

  function describeWikiContamination(text: string) {
    // Operator-facing semantics: a failed-probe hint is contamination even
    // when the sentinel is present — callers must use --snapshot-failed.
    return describeContamination(text, { allowSentinel: false })
      .map((reason: string) => (reason === 'raw-transcript' ? 'raw-dormant-stream' : reason));
  }

  function formatFailedSnapshotBlock(opts: any) {
    return `${formatFailedSnapshotSection({
      section: opts.section,
      timestamp: opts.timestamp,
      command: opts.command,
      failureReason: opts.reason,
      nextLiveCommand: opts.nextLiveCommand,
    })}\n`;
  }

  function readCompletionResult(projectDir: any, runId: any) {
    const safeRunId = normalizeText(runId);
    if (!safeRunId) die({ code: 2, error: 'missing_arg', message: '--run is required' });
    const resultPath = path.join(aceDir(projectDir), 'run', safeRunId, 'completion.json');
    if (!fs.existsSync(resultPath)) {
      die({ code: 6, error: 'not_found', message: `completion result not found: ${resultPath}` });
    }
    const result = readJsonFile(resultPath);
    return { resultPath, result, validation: validateCompletionResult(result) };
  }

  async function handleProjectInitHarness(parsed: any) {
    const flags = parsed.flags || {};
    const projectDir = resolveProjectDirFlag(flags);
    const targetDir = aceDir(projectDir);
    const templateDir = path.join(repoRootFromCli(), '.ace-template');
    const project = normalizeText(flags.project);
    if (!project) {
      die({ code: 2, error: 'missing_arg', message: '--project is required' });
    }
    if (!fs.existsSync(templateDir)) {
      die({ code: 5, error: 'template_missing', message: `template not found: ${templateDir}` });
    }
    fs.mkdirSync(targetDir, { recursive: true });
    const copied = [];
    const skipped = [];
    for (const name of fs.readdirSync(templateDir)) {
      const src = path.join(templateDir, name);
      const dst = path.join(targetDir, name);
      if (fs.existsSync(dst) && flags.force !== true) {
        skipped.push(name);
        continue;
      }
      fs.copyFileSync(src, dst);
      copied.push(name);
    }
    for (const dir of ['run', 'memory', 'wiki']) fs.mkdirSync(path.join(targetDir, dir), { recursive: true });
    const briefPath = path.join(targetDir, 'PROJECT_BRIEF.md');
    if (fs.existsSync(briefPath)) {
      const brief = fs.readFileSync(briefPath, 'utf8').replace(/\{\{PROJECT_NAME\}\}/g, project);
      fs.writeFileSync(briefPath, brief);
    }
    const initPath = path.join(targetDir, 'init.sh');
    let initRan = false;
    if (fs.existsSync(initPath)) {
      fs.chmodSync(initPath, 0o755);
      const { execFileSync } = require('node:child_process');
      execFileSync(initPath, [], { cwd: projectDir, stdio: 'pipe' });
      initRan = true;
    }
    return { projectDir, targetDir, copied, skipped, initRan };
  }

  async function handleTaskResult(parsed: any) {
    const flags = parsed.flags || {};
    const projectDir = resolveProjectDirFlag(flags);
    const runId = normalizeText(flags.run);
    const { resultPath, result, validation } = readCompletionResult(projectDir, runId);
    return { path: resultPath, valid: validation.ok, errors: validation.errors, result };
  }

  async function handleTaskValidate(parsed: any) {
    const flags = parsed.flags || {};
    const projectDir = resolveProjectDirFlag(flags);
    const runId = normalizeText(flags.run);
    const featureId = normalizeText(flags.feature);
    const { features } = readFeatures(projectDir);
    if (!features.some((feature: any) => feature.id === featureId)) {
      die({ code: 6, error: 'not_found', message: `feature not found: ${featureId}` });
    }
    const { resultPath, result, validation } = readCompletionResult(projectDir, runId);
    const pass = validation.ok && result.outcome === 'done';
    const checked = appendHarnessEvent(projectDir, 'feature.checked', { featureId, runId, valid: validation.ok, outcome: result.outcome || null, errors: validation.errors });
    const evidence = pass
      ? `validator accepted ${runId}`
      : `validator rejected ${runId}: ${validation.errors.join('; ') || result.outcome || 'unknown outcome'}`;
    const mark = applyFeatureMark(projectDir, { featureId, pass, role: 'evaluator', evidence, runId });
    const validationPath = path.join(aceDir(projectDir), 'run', runId, 'validation.json');
    writeJsonFile(validationPath, {
      schema: 'ace.validation_result.v1', runId, featureId, verdict: pass ? 'pass' : 'fail',
      valid: validation.ok, outcome: result.outcome || null, errors: validation.errors, resultPath,
      checkedEventId: checked.event.eventId, featureEventId: mark.event.eventId,
    });
    return { runId, featureId, verdict: pass ? 'pass' : 'fail', valid: validation.ok, errors: validation.errors, resultPath, validationPath, feature: mark.feature, events: [checked.event, mark.event], actions: [...checked.actions, ...mark.actions] };
  }

  function readFeatures(projectDir: any) {
    const featuresPath = path.join(aceDir(projectDir), 'FEATURES.json');
    if (!fs.existsSync(featuresPath)) {
      die({ code: 6, error: 'not_found', message: `FEATURES.json not found: ${featuresPath}` });
    }
    const features = readJsonFile(featuresPath);
    if (!Array.isArray(features)) {
      die({ code: 2, error: 'invalid_features', message: 'FEATURES.json must be an array' });
    }
    return { featuresPath, features };
  }

  async function handleFeatureList(parsed: any) {
    const projectDir = resolveProjectDirFlag(parsed.flags || {});
    const { featuresPath, features } = readFeatures(projectDir);
    return { path: featuresPath, features };
  }

  async function handleWaveList(parsed: any) {
    const projectDir = resolveProjectDirFlag(parsed.flags || {});
    const wavePath = path.join(aceDir(projectDir), 'WAVE_PLAN.yaml');
    if (!fs.existsSync(wavePath)) {
      die({ code: 6, error: 'not_found', message: `WAVE_PLAN.yaml not found: ${wavePath}` });
    }
    return { path: wavePath, text: fs.readFileSync(wavePath, 'utf8') };
  }

  async function handleRunList(parsed: any) {
    const projectDir = resolveProjectDirFlag(parsed.flags || {});
    const runDir = path.join(aceDir(projectDir), 'run');
    const runs = [];
    if (fs.existsSync(runDir)) {
      for (const runId of fs.readdirSync(runDir)) {
        const resultPath = path.join(runDir, runId, 'completion.json');
        if (!fs.existsSync(resultPath)) {
          runs.push({ runId, hasCompletion: false, valid: false, errors: ['completion.json missing'] });
          continue;
        }
        const result = readJsonFile(resultPath);
        const validation = validateCompletionResult(result);
        runs.push({ runId, hasCompletion: true, valid: validation.ok, errors: validation.errors, outcome: result.outcome || null });
      }
    }
    return { runs };
  }

  function applyFeatureMark(projectDir: any, { featureId, pass, role, evidence, runId }: any) {
    if (!featureId) die({ code: 2, error: 'missing_arg', message: '--id/--feature is required' });
    if (!normalizeText(evidence)) die({ code: 2, error: 'missing_arg', message: '--evidence is required' });
    const normalizedRole = normalizeText(role);
    const canMarkPass =
      normalizedRole === 'evaluator' ||
      normalizedRole === 'validator' ||
      normalizedRole === 'validator-fixer-merger';
    if (pass === true && !canMarkPass) {
      die({ code: 2, error: 'role_forbidden', message: 'only evaluator or validator roles can mark a feature passing' });
    }
    const { featuresPath, features } = readFeatures(projectDir);
    const index = features.findIndex((feature: any) => feature.id === featureId);
    if (index < 0) die({ code: 6, error: 'not_found', message: `feature not found: ${featureId}` });
    const next = { ...features[index], passes: pass === true, evidence, ...(runId ? { lastRunId: runId } : {}) };
    features[index] = next;
    writeJsonFile(featuresPath, features);
    const emitted = appendHarnessEvent(projectDir, pass === true ? 'feature.passed' : 'feature.failed', {
      featureId, runId: runId || null, evidence, role: normalizedRole || null,
    });
    return { path: featuresPath, feature: next, event: emitted.event, actions: emitted.actions };
  }

  async function handleFeatureMark(parsed: any) {
    const flags = parsed.flags || {};
    const projectDir = resolveProjectDirFlag(flags);
    const featureId = normalizeText(flags.id);
    const evidence = normalizeText(flags.evidence);
    if (flags.pass === true && flags.fail === true) {
      die({ code: 2, error: 'invalid_args', message: 'choose either --pass or --fail, not both' });
    }
    if (flags.pass !== true && flags.fail !== true) {
      die({ code: 2, error: 'missing_arg', message: 'feature mark requires --pass or --fail' });
    }
    return applyFeatureMark(projectDir, { featureId, pass: flags.pass === true, role: flags.role, evidence, runId: flags.run });
  }

  async function handleMemoryCandidates(parsed: any) {
    const projectDir = resolveProjectDirFlag(parsed.flags || {});
    const runDir = path.join(aceDir(projectDir), 'run');
    const candidates = [];
    if (fs.existsSync(runDir)) {
      for (const runId of fs.readdirSync(runDir)) {
        const resultPath = path.join(runDir, runId, 'completion.json');
        if (!fs.existsSync(resultPath)) continue;
        const result = readJsonFile(resultPath);
        for (const candidate of result.memoryCandidates || []) {
          candidates.push({ runId, path: resultPath, candidate });
        }
      }
    }
    return { candidates };
  }

  // Canon writers only: direct wiki page writes are reserved for manager/
  // curator lanes. Workers and validators append to the untrusted intake
  // instead (`ace wiki dump` / `ace memory remember`) and the nightly
  // curator promotes. The `diagnostic/` folder stays open to every role.
  // Enforcement is role-keyed: dispatched workers/validators carry
  // ACE_AGENT_ROLE (implementer/reviewer/fixback/no-code) and are denied;
  // owner terminals and orchestrator/Hermes tabs carry no worker role and
  // pass (or declare --role explicitly).
  const WIKI_UPDATE_FORBIDDEN_ROLES = new Set(['implementer', 'reviewer', 'fixback', 'no-code', 'worker', 'validator']);

  async function handleWikiUpdate(parsed: any) {
    const flags = parsed.flags || {};
    const projectDir = resolveProjectDirFlag(flags);
    const page = normalizeText(flags.page);
    if (!page || page.includes('..') || path.isAbsolute(page)) {
      die({ code: 2, error: 'invalid_path', message: '--page must be a relative wiki path without ..' });
    }
    const wikiDir = path.join(aceDir(projectDir), 'wiki');
    const target = path.join(wikiDir, page);

    // Operator-facing wiki pages (Chief-visible current-state) cannot accept
    // raw dormant stream inventory or unattributed failed-probe leakage. The
    // diagnostic carve-out is the `diagnostic/` folder inside the wiki dir,
    // which callers may opt into for raw inventory.
    const isOperatorFacing = !page.startsWith('diagnostic/');

    if (isOperatorFacing) {
      const role = (normalizeText(flags.role) || normalizeText(process.env.ACE_AGENT_ROLE) || '').toLowerCase();
      if (WIKI_UPDATE_FORBIDDEN_ROLES.has(role)) {
        die({
          code: 2,
          error: 'role_forbidden',
          message: `wiki update writes canon and is forbidden for role '${role}'. Workers/validators use \`ace wiki dump\` or \`ace memory remember\` (curated nightly), or write to wiki/diagnostic/.`,
        });
      }
    }

    // --snapshot-failed turns the call into a fail-closed snapshot section
    // with the exact non-authoritative sentence. Useful for scheduled probes
    // that cannot reach the live socket / GitHub / etc.
    const snapshotFailed = flags['snapshot-failed'] === true || flags.snapshotFailed === true;
    if (snapshotFailed) {
      const block = formatFailedSnapshotBlock({
        section: flags.section || page,
        timestamp: flags.timestamp,
        command: flags.command,
        reason: flags.reason,
        nextLiveCommand: flags['next-live'] || flags.nextLive,
      });
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (flags.append === true) fs.appendFileSync(target, block);
      else fs.writeFileSync(target, block);
      return {
        path: target,
        appended: flags.append === true,
        snapshotFailed: true,
        sentence: WIKI_FAILED_SNAPSHOT_SENTENCE,
      };
    }

    const text = String(flags.text == null ? '' : flags.text);
    if (isOperatorFacing) {
      const contamination = describeWikiContamination(text);
      if (contamination.length > 0) {
        die({
          code: 2,
          error: 'wiki_contamination',
          message: `operator-facing wiki sections refuse raw diagnostic content: ${contamination.join(', ')}. Use --snapshot-failed for failed probes or write to wiki/diagnostic/ for raw inventory.`,
        });
      }
    }

    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (flags.append === true) fs.appendFileSync(target, text.endsWith('\n') ? text : `${text}\n`);
    else fs.writeFileSync(target, text.endsWith('\n') ? text : `${text}\n`);
    return { path: target, appended: flags.append === true };
  }

  async function handleWikiDump(parsed: any) {
    const flags = parsed.flags || {};
    const projectDir = resolveProjectDirFlag(flags);
    const record = {
      kind: flags.kind,
      identity: flags.identity,
      projectId: flags.projectId || flags.workspace,
      projectName: flags.projectName,
      missionId: flags.mission,
      featureId: flags.feature,
      prNumber: flags.pr,
      sessionId: flags.session,
      source: flags.source,
      sourceUrl: flags.sourceUrl,
      fetchStatus: flags.fetchStatus,
      trust: flags.trust,
      title: flags.title,
      summary: flags.summary,
      proposedNextActions: flags.nextAction || [],
      completedItems: flags.completed || [],
      decisions: flags.decision || [],
      blockers: flags.blocker || [],
      evidence: flags.evidence || [],
      rawPath: flags.rawPath,
    };
    return projectWikiCurator.writeDumpRecord({ projectDir, record });
  }

  async function handleWikiCandidates(parsed: any) {
    const flags = parsed.flags || {};
    const projectDir = resolveProjectDirFlag(flags);
    const records = projectWikiCurator.collectDumpRecords({ projectDir, identity: flags.identity });
    const candidates = projectWikiCurator.extractProjectUpdateCandidates(records);
    const commands = typeof describeCommands === 'function' ? describeCommands() : [];
    const validations = candidates.map((candidate: any) => projectWikiCurator.validateCandidate(candidate, { projectDir, describeCommands: commands }));
    return {
      dumps: records.length,
      candidates,
      accepted: validations.filter((result: any) => result.ok).map((result: any) => result.candidate),
      rejected: validations.filter((result: any) => !result.ok).map((result: any) => ({ candidate: result.candidate, errors: result.errors, status: result.status })),
    };
  }

  async function handleWikiNightly(parsed: any) {
    const flags = parsed.flags || {};
    const projectDir = resolveProjectDirFlag(flags);
    const commands = typeof describeCommands === 'function' ? describeCommands() : [];
    return projectWikiCurator.runNightlyProjectWikiCuration({
      projectDir,
      identity: flags.identity || 'all',
      describeCommands: commands,
    });
  }

  async function handleWikiPack(parsed: any) {
    const flags = parsed.flags || {};
    const projectDir = resolveProjectDirFlag(flags);
    return projectWikiCurator.buildAgentPack({
      projectDir,
      role: flags.role,
      projectId: flags.project || flags.projectId || flags.workspace,
    });
  }

  async function handleWikiAudit(parsed: any) {
    const flags = parsed.flags || {};
    const projectDir = resolveProjectDirFlag(flags);
    const result = projectWikiCurator.auditProjectWiki({ projectDir });
    if (!result.ok) {
      die({ code: 2, error: 'wiki_audit_failed', message: result.errors.join('; '), details: result });
    }
    return result;
  }

  function triggerConditionMatches(trigger: any, eventName: any, payload: any) {
    if (trigger?.enabled !== true) return false;
    if (trigger.listensTo !== eventName) return false;
    const condition = normalizeText(trigger.condition);
    if (!condition) return true;
    if (condition === "payload.kind == 'DONE'" || condition === 'payload.kind == "DONE"') {
      return payload?.kind === 'DONE';
    }
    return false;
  }

  function appendNdjson(filePath: any, value: any) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, JSON.stringify(value) + '\n');
  }

  function runEventTriggers(projectDir: any, eventName: any, event: any) {
    const triggerPath = path.join(aceDir(projectDir), 'EVENT_TRIGGERS.json');
    if (!fs.existsSync(triggerPath)) return [];
    const triggers = readJsonFile(triggerPath);
    if (!Array.isArray(triggers)) return [];
    const actions = [];
    for (const trigger of triggers) {
      if (!triggerConditionMatches(trigger, eventName, event.payload)) continue;
      const action = {
        triggerId: trigger.id,
        action: trigger.action,
        sourceEventId: event.eventId,
        payload: trigger.payload || {},
        at: new Date().toISOString(),
      };
      if (trigger.action === 'spawn_task') {
        appendNdjson(path.join(aceDir(projectDir), 'run', 'evaluator-tasks.ndjson'), action);
      } else if (trigger.action === 'send_fixback') {
        appendNdjson(path.join(aceDir(projectDir), 'run', 'fixbacks.ndjson'), action);
      } else if (trigger.action === 'create_memory_candidate') {
        appendNdjson(path.join(aceDir(projectDir), 'memory', 'candidates.ndjson'), action);
      } else {
        appendNdjson(path.join(aceDir(projectDir), 'events.actions.ndjson'), action);
      }
      actions.push(action);
    }
    return actions;
  }

  function appendHarnessEvent(projectDir: any, eventName: any, payload: any = {}) {
    const targetDir = aceDir(projectDir);
    fs.mkdirSync(targetDir, { recursive: true });
    const event = {
      schema: 'ace.harness_event.v1',
      eventId: `evt_${Date.now().toString(36)}`,
      event: eventName,
      at: new Date().toISOString(),
      payload,
    };
    const eventPath = path.join(targetDir, 'events.ndjson');
    fs.appendFileSync(eventPath, JSON.stringify(event) + '\n');
    return { path: eventPath, event, actions: runEventTriggers(projectDir, eventName, event) };
  }

  async function handleEventEmit(parsed: any) {
    const flags = parsed.flags || {};
    const projectDir = resolveProjectDirFlag(flags);
    const eventName = normalizeText(parsed.positionals?.[0]);
    if (!eventName) die({ code: 2, error: 'missing_arg', message: 'event name required' });
    let payload = {};
    if (flags.payload) {
      try {
        payload = JSON.parse(flags.payload);
      } catch (err) {
        die({ code: 2, error: 'invalid_json', message: `--payload must be JSON: ${err.message}` });
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        die({ code: 2, error: 'invalid_json', message: '--payload must be a JSON object' });
      }
    }
    return appendHarnessEvent(projectDir, eventName, payload);
  }

  return {
    handleProjectInitHarness,
    handleTaskResult,
    handleTaskValidate,
    handleFeatureList,
    handleWaveList,
    handleRunList,
    handleFeatureMark,
    handleMemoryCandidates,
    handleWikiUpdate,
    handleWikiDump,
    handleWikiCandidates,
    handleWikiNightly,
    handleWikiPack,
    handleWikiAudit,
    handleEventEmit,
  };
}

module.exports = { createProjectHarnessHandlers };
