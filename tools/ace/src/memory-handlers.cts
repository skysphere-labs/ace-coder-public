// memory-handlers.cts — pure-local handlers for the agent-facing memory
// surface. `memory search` / `memory get` / `memory reindex` ride the socket
// to the running app (knowledge.db lives in userData); `memory remember` is
// pure-local so agents can record claims with no app running.
//
// memory remember NEVER writes canon: it delegates to the project wiki
// curator's writeDumpRecord, inheriting secret scanning, redaction and
// contamination quarantine. The nightly curator validates and promotes.

const path = require('node:path');

const projectWikiCurator = require('./project-wiki-curator.cjs');
const { KNOWLEDGE_SCHEMAS } = require('../../../electron/harness/knowledge-contract.cts');

const MAX_CLAIM_CHARS = 2000;
const CATEGORIES = new Set(['lesson', 'decision', 'fact', 'todo']);

// Hermes owns its memory dirs — no knowledge-plane write may target them.
function looksLikeHermesPath(dir: any) {
  const segments = path.resolve(String(dir || '')).split(path.sep);
  return segments.some((segment: any) => segment === '.hermes' || segment.startsWith('hermes-home'));
}

function createMemoryHandlers(deps: any) {
  const { die, normalizeText, resolveProjectDirFlag } = deps;

  async function handleMemoryRemember(parsed: any) {
    const flags = parsed.flags || {};
    const projectDir = resolveProjectDirFlag(flags);
    if (looksLikeHermesPath(projectDir)) {
      die({ code: 2, error: 'readonly_source', message: 'Hermes memory directories are read-only sources; pick a project directory instead' });
    }

    const claim = normalizeText(parsed.positionals?.[0]);
    if (!claim) {
      die({ code: 2, error: 'missing_arg', message: 'claim text is required: ace memory remember "<claim>" --category lesson' });
    }
    if (claim.length > MAX_CLAIM_CHARS) {
      die({ code: 2, error: 'invalid_arg', message: `claim too long (max ${MAX_CLAIM_CHARS} chars) — link evidence instead of pasting it` });
    }

    const category = normalizeText(flags.category);
    if (!CATEGORIES.has(category)) {
      die({ code: 2, error: 'invalid_arg', message: `--category must be one of: ${Array.from(CATEGORIES).join('|')}` });
    }

    const projectId =
      normalizeText(flags.projectId) ||
      normalizeText(process.env.ACE_PROJECT_ID) ||
      normalizeText(process.env.ACE_WORKSPACE_ID);
    if (!projectId) {
      die({ code: 2, error: 'missing_arg', message: '--project-id is required (or set ACE_PROJECT_ID / run inside a Ace task)' });
    }

    const identity =
      normalizeText(flags.identity) ||
      normalizeText(process.env.ACE_AGENT_IDENTITY) ||
      normalizeText(process.env.ACE_AGENT) ||
      'agent';

    const record: any = {
      kind: 'memory_note',
      identity,
      projectId,
      source: normalizeText(flags.source) || null,
      trust: 'self_report',
      title: `[${category}] ${claim.slice(0, 80)}`,
      summary: claim,
      category,
      tags: Array.isArray(flags.tag) ? flags.tag : [],
    };
    if (category === 'decision') record.decisions = [claim];
    if (category === 'todo') record.proposedNextActions = [claim];

    const result = projectWikiCurator.writeDumpRecord({ projectDir, record });
    return { schema: KNOWLEDGE_SCHEMAS.remember, ...result };
  }

  return { handleMemoryRemember };
}

module.exports = { createMemoryHandlers };
