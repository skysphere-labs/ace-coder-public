// Orchestrator bootstrap prompt builder.
//
// The full doctrine (manager role, prompt-enhancement, BIG/SMALL routing,
// driver selection, delegation contract, forbidden verbs) lives in the bundled
// skill `ace-hermes-router` at
// `electron/assets/skills/ace-hermes-router/SKILL.md`, which Ace
// materialises into every orchestrator tab's skill directory at spawn. This
// module keeps the live startup packet tight: role + workspace identity + a
// pointer to the skill + the hard-enforced viewer/forbidden summary + first
// action.
//
// Enforcement of the forbidden verbs is not prose — it runs at the call site
// in `tools/ace/src/enforcement.cts` (assertViewerRole +
// FORBIDDEN_VIEWER_VERBS). The summary here is a contract reminder, not the
// gate.

const fs = require('fs');
const path = require('path');

const ORCHESTRATOR_SKILL_ID = 'ace-hermes-router';
const OPERATOR_POLICY_SKILL_ID = 'ace-runtime-contract';

// Rehydration-injection caps. The injected block is advisory context lifted
// from the wiki + knowledge index; it must stay small (a big dump would drown
// the tight startup packet) and must fail OPEN — a missing wiki or a throwing
// index leaves the prompt byte-identical to its pre-injection form.
const MAX_INJECT_CHARS = 2000;
const MAX_NEXT_ACTIONS_CHARS = 900;
const MAX_SNIPPET_CHARS = 180;
const MAX_KNOWLEDGE_HITS = 5;

function loadAgentProviders() {
  try {
    return require('./agent-providers.cjs');
  } catch (err: any) {
    if (err?.code !== 'MODULE_NOT_FOUND' || !String(err?.message || '').includes('./agent-providers.cjs')) {
      throw err;
    }
    // Source tests can run before Electron CJS artifacts exist. Use the CTS
    // source in that case so CI does not depend on local build leftovers.
    return require('./agent-providers.cts');
  }
}

const { getProvider } = loadAgentProviders();

// One-line reminder; the full forbidden-verb list lives in the skill and is
// gated in code by assertViewerRole / FORBIDDEN_VIEWER_VERBS.
const FORBIDDEN_VERBS_SUMMARY =
  'push, PR creation, file edits, write-side git, destructive ops, direct agent invocation';

function displayNameFor(agent: any) {
  const id = String(agent || '').trim().toLowerCase();
  if (!id || id === 'claude') return 'Claude';
  if (id === 'hermes') return 'Hermes';
  const provider = getProvider(id);
  if (provider?.name) return provider.name.replace(/\s+Code$/i, '');
  return id
    .split(/[^a-z0-9]+/i)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ') || 'Agent';
}

/** Collapse whitespace and hard-truncate to `max` chars with an ellipsis. */
function truncateText(text: any, max: number): string {
  const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

/** Project wiki root for a workspace path (`<repo>/.ace/wiki`), or null. */
function deriveWikiPath(workspacePath: any): string | null {
  if (!workspacePath || typeof workspacePath !== 'string') return null;
  return path.join(workspacePath, '.ace', 'wiki');
}

/**
 * Read the project's `00_index/NEXT_ACTIONS.md` body (frontmatter stripped),
 * or '' when the wiki/file is absent or unreadable. Never throws.
 */
function readNextActions(wikiPath: any): string {
  if (!wikiPath || typeof wikiPath !== 'string') return '';
  try {
    const raw = fs.readFileSync(path.join(wikiPath, '00_index', 'NEXT_ACTIONS.md'), 'utf8');
    return String(raw).replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*(\r?\n|$)/, '').trim();
  } catch {
    return '';
  }
}

/**
 * Build the advisory rehydration block: the project NEXT_ACTIONS body plus the
 * top knowledge-index hits for the goal/workspace. Returns [] (no injection)
 * whenever nothing is available — the caller then emits its pre-injection
 * prompt unchanged. Fail-open: any error yields []. Hard-capped at
 * MAX_INJECT_CHARS.
 */
function buildRehydrationBlock({ goal, workspaceName, wikiPath, knowledgeSearch }: any): string[] {
  const lines: string[] = [];
  try {
    const nextActions = readNextActions(wikiPath);
    if (nextActions) {
      lines.push('Wiki NEXT_ACTIONS (project `00_index/NEXT_ACTIONS.md`):');
      lines.push(truncateText(nextActions, MAX_NEXT_ACTIONS_CHARS));
    }

    const query = String(goal || workspaceName || '').trim();
    if (query && typeof knowledgeSearch === 'function') {
      let hits: any[] = [];
      try {
        const result = knowledgeSearch({ query, limit: MAX_KNOWLEDGE_HITS });
        hits = Array.isArray(result?.results) ? result.results.slice(0, MAX_KNOWLEDGE_HITS) : [];
      } catch {
        hits = [];
      }
      if (hits.length > 0) {
        lines.push(`Relevant knowledge for "${truncateText(query, 80)}" (canon > working > raw; verify before acting):`);
        for (const hit of hits) {
          const tier = String(hit?.trust || 'raw');
          const title = truncateText(hit?.title || hit?.relPath || hit?.path || 'untitled', 80);
          const snippet = truncateText(hit?.excerpt || '', MAX_SNIPPET_CHARS);
          lines.push(`- [${tier}] ${title}${snippet ? ` — ${snippet}` : ''}`);
        }
      }
    }
  } catch {
    return [];
  }

  if (lines.length === 0) return [];
  const block = [
    'Rehydration context (auto-injected from the wiki + knowledge index; advisory):',
    ...lines,
  ];
  const joined = block.join('\n');
  return joined.length > MAX_INJECT_CHARS
    ? `${joined.slice(0, MAX_INJECT_CHARS - 1).trimEnd()}…`.split('\n')
    : block;
}

function buildOrchestratorPrompt({
  agent = 'claude',
  workspaceId,
  workspaceName,
  workspacePath,
  githubRepo,
  defaultBranch,
  isRemote,
  goal,
  wikiPath,
  knowledgeSearch,
}: any = {}) {
  const path = workspacePath || '(unset — refuse destructive git ops until confirmed)';
  const branch = defaultBranch || '(unknown — resolve via `git symbolic-ref refs/remotes/origin/HEAD`)';
  const repo = githubRepo
    ? `${githubRepo} (origin: https://github.com/${githubRepo})`
    : '(none detected — ask the user before pushing)';
  const displayName = displayNameFor(agent);
  const remoteTag = isRemote ? '  (remote)' : '';
  const agentId = String(agent || 'claude').trim().toLowerCase();
  const roleLine = agentId === 'hermes'
    ? `You are the Hermes intake-router for workspace "${workspaceName}". Role: viewer — organize brain dumps, launch one worker for tiny/small deterministic tasks, or spawn a fresh Claude workspace orchestrator for medium/large goals. All code work goes through \`ace task run --new-task\`.`
    : `You are the ${displayName} validator-orchestrator for workspace "${workspaceName}". Role: viewer — plan, delegate, verify. All code work goes through \`ace task run --new-task\`.`;

  const rehydration = buildRehydrationBlock({
    goal,
    workspaceName,
    wikiPath: wikiPath || deriveWikiPath(workspacePath),
    knowledgeSearch,
  });

  const lines = [
    roleLine,
    '',
    `workspace_id: ${workspaceId}`,
    `workspace_path: ${path}${remoteTag}`,
    `default_branch: ${branch}`,
    `github_repo: ${repo}`,
    '',
    `Doctrine: read bundled skills \`${ORCHESTRATOR_SKILL_ID}\` + \`${OPERATOR_POLICY_SKILL_ID}\` before delegation; after compaction/restart, resume preserved work first and reload doctrine before the next delegation.`,
    `Enforcement: assertViewerRole blocks ${FORBIDDEN_VERBS_SUMMARY}; if blocked, use \`ace task run --new-task\`.`,
    'Integration: use specs; children push/open PR; merge only after validation.',
    `Hard scope: workspace_id=${workspaceId}; never push to ${defaultBranch || 'the default branch'} — children open the PR.`,
    'Index: `ace github tracked-projects --json` lists repos/wiki/tasks/PRs.',
    `Ship loop: for ship-to-main coding work with no human code review, run \`ace loop run loop-ship --input goal="<goal>" --input workspace=${workspaceId} --watch\` and read its exit code (0 = converged/merged, 2 = no-progress/cap, 3 = blocked). It implements, computer-use validates, gates on CI, turns failing checks + Clawpatch findings into the next iteration's fixback, and auto-merges ONLY when every gate is green (owner-approved; fail-closed — parks at ready_to_review when no auto-ship token is configured).`,
    'Knowledge: rehydrate from the wiki nightly report (`.ace/wiki/00_index/nightly-curation-report.md`) and your role pack; specifics via `ace memory search "<topic>"` (canon > working > raw; never cite decayed/raw as authoritative).',
  ];

  // Advisory wiki/knowledge content, only when available (fail-open: no block
  // ⇒ the prompt below is byte-identical to its pre-injection form).
  if (rehydration.length > 0) lines.push('', ...rehydration);

  lines.push(
    '',
    `Fresh session only: run \`ace tool heartbeat\`, \`ace tool manifest --compact\`, \`ace context\`, \`ace run board\`, and \`ace ls\`, then \`ace tool audit\`; these commands infer this session's role, phase, workspace, and stream. After context compression, resume the preserved active task instead of rerunning this fresh-start audit. Do not dispatch before run-board / tool-audit proof exists.`,
    `The run-ledger spine enforces transitions: it dispatches the worker, runs the validator, and reads live gate facts; long/wave/high-risk/merge-gate/security/deploy/prune/cross-cutting gates require validation Clawpatch evidence. Merge is fail-closed and owner-gated (env ACE_OWNER_AUTH_TOKEN + matching --owner-token + validator PASS) -> else the run parks at ready_to_review; rebuild/relaunch only after release gate PASS or explicit approval.`,
  );

  return lines.join('\n');
}

module.exports = {
  buildOrchestratorPrompt,
  displayNameFor,
  ORCHESTRATOR_SKILL_ID,
  OPERATOR_POLICY_SKILL_ID,
  FORBIDDEN_VERBS_SUMMARY,
};
