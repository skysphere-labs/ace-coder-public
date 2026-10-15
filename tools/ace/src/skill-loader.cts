// Skill loader for ace: resolves a skill id (or qualified reference)
// to its SKILL.md body.
//
// Ace materializes skills into native agent dirs like ~/.codex/skills and
// ~/.claude/skills. The prompt path now stays compact for every driver and
// points workers at those mounted skills instead of inlining giant skill bodies.
// This loader remains useful for tests, diagnostics, and any future tooling
// that needs to inspect the resolved SKILL.md on disk.
//
// Qualified addressing
// --------------------
//
// To prevent name collisions between real skills and reference documents the
// loader supports a small prefix grammar:
//
//   skill:<id>                — load the SKILL.md body for skill <id>.
//   ref:<skill>/<reference>   — load a reference doc bundled alongside a
//                               skill at <skill>/<reference> (any file).
//                               References never register as installable
//                               skill ids; they are inert documentation.
//   path:<absolute-or-repo-relative-path>
//                             — load the file at the given path verbatim.
//                               Useful for ops doc anchors that are not
//                               themselves SKILL.md bodies.
//
// Unqualified (bare) ids are accepted for backwards compatibility, but when
// the bare id matches both a real skill and a registered reference, the
// loader returns an `ambiguous` error envelope and asks the caller to use
// the qualified form. This keeps existing call-sites working while making
// new collisions impossible to ship by accident.
//
// Resolution order for `skill:<id>` and bare ids (first match wins):
//   1. $HOME/.codex/skills/<id>/SKILL.md     — Codex per-agent skills dir
//   2. $HOME/.claude/skills/<id>/SKILL.md    — Claude per-agent skills dir
//   3. $HOME/Library/Application Support/Ace/hermes-home/skills/<id>/SKILL.md
//   4. repo-bundled electron/assets/skills/<id>/SKILL.md
//
// Returns { id, path, body } on hit, null on miss. Never throws on a
// missing file; I/O errors other than ENOENT propagate.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const REFERENCE_FILE_HINTS = [
  'reference', 'references',
  'docs', 'doc',
  'examples',
];

function candidatePaths(skillId: any, home: any) {
  const base = home || os.homedir();
  return [
    path.join(base, '.codex', 'skills', skillId, 'SKILL.md'),
    path.join(base, '.claude', 'skills', skillId, 'SKILL.md'),
    path.join(base, 'Library', 'Application Support', 'Ace', 'hermes-home', 'skills', skillId, 'SKILL.md'),
    path.join(__dirname, '..', '..', '..', 'electron', 'assets', 'skills', skillId, 'SKILL.md'),
  ];
}

function referenceCandidatePaths(skillId: any, refPath: any, home: any) {
  const base = home || os.homedir();
  return [
    path.join(base, '.codex', 'skills', skillId, refPath),
    path.join(base, '.claude', 'skills', skillId, refPath),
    path.join(base, 'Library', 'Application Support', 'Ace', 'hermes-home', 'skills', skillId, refPath),
    path.join(__dirname, '..', '..', '..', 'electron', 'assets', 'skills', skillId, refPath),
  ];
}

function parseQualifiedAddress(spec: any) {
  if (!spec || typeof spec !== 'string') return null;
  const trimmed = spec.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('skill:')) {
    const id = trimmed.slice('skill:'.length).trim();
    if (!id) return { kind: 'invalid', reason: 'skill:<id> requires a non-empty id' };
    return { kind: 'skill', id };
  }
  if (trimmed.startsWith('ref:')) {
    const rest = trimmed.slice('ref:'.length).trim();
    if (!rest) return { kind: 'invalid', reason: 'ref:<skill>/<reference> requires a non-empty target' };
    const slashIndex = rest.indexOf('/');
    if (slashIndex <= 0 || slashIndex === rest.length - 1) {
      return { kind: 'invalid', reason: 'ref:<skill>/<reference> requires a skill and reference path' };
    }
    const skillId = rest.slice(0, slashIndex);
    const refPath = rest.slice(slashIndex + 1);
    if (refPath.includes('..')) {
      return { kind: 'invalid', reason: 'ref path may not contain ..' };
    }
    return { kind: 'ref', skillId, refPath };
  }
  if (trimmed.startsWith('path:')) {
    const p = trimmed.slice('path:'.length).trim();
    if (!p) return { kind: 'invalid', reason: 'path:<file> requires a non-empty path' };
    return { kind: 'path', path: p };
  }
  if (trimmed.includes(':')) {
    // Unknown prefix — surface as invalid so the caller picks the right one.
    return { kind: 'invalid', reason: `unknown address prefix in "${trimmed}" — use skill:, ref:, or path:` };
  }
  return { kind: 'bare', id: trimmed };
}

function tryReadFirst(paths: any[]) {
  for (const p of paths) {
    try {
      const body = fs.readFileSync(p, 'utf8');
      return { path: p, body };
    } catch (err) {
      if (err && err.code === 'ENOENT') continue;
      throw err;
    }
  }
  return null;
}

function loadSkillById(skillId: any, home: any) {
  const hit = tryReadFirst(candidatePaths(skillId, home));
  if (!hit) return null;
  return { id: skillId, path: hit.path, body: hit.body, kind: 'skill' };
}

function loadReference(skillId: any, refPath: any, home: any) {
  const hit = tryReadFirst(referenceCandidatePaths(skillId, refPath, home));
  if (!hit) return null;
  return {
    id: `${skillId}/${refPath}`,
    skillId,
    refPath,
    path: hit.path,
    body: hit.body,
    kind: 'ref',
  };
}

function loadPath(target: any) {
  const abs = path.isAbsolute(target) ? target : path.resolve(process.cwd(), target);
  try {
    const body = fs.readFileSync(abs, 'utf8');
    return { id: target, path: abs, body, kind: 'path' };
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
}

function looksLikeReferenceId(skillId: any) {
  if (!skillId || typeof skillId !== 'string') return false;
  const lower = skillId.toLowerCase();
  return REFERENCE_FILE_HINTS.some((hint) => lower.startsWith(`${hint}-`) || lower.endsWith(`-${hint}`) || lower === hint);
}

function isBareIdAmbiguous(skillId: any, home: any) {
  // Bare id is ambiguous if there is both a real SKILL.md AND a sibling
  // reference doc registered with the same id (rare today, but the loader
  // is structured to detect it once references gain ids).
  const skillHit = !!tryReadFirst(candidatePaths(skillId, home));
  // For now, a "reference id" naming convention triggers the ambiguity
  // guard so callers learn the qualified prefixes before the situation
  // becomes painful.
  return skillHit && looksLikeReferenceId(skillId);
}

function loadSkillContent(spec: any, opts: any = {}) {
  if (!spec || typeof spec !== 'string') return null;
  const home = opts.home || process.env.SKILL_LOADER_HOME || os.homedir();
  const parsed = parseQualifiedAddress(spec);
  if (!parsed) return null;
  if (parsed.kind === 'invalid') {
    return {
      ok: false,
      error: 'invalid_address',
      message: parsed.reason,
    };
  }
  if (parsed.kind === 'skill') {
    return loadSkillById(parsed.id, home);
  }
  if (parsed.kind === 'ref') {
    return loadReference(parsed.skillId, parsed.refPath, home);
  }
  if (parsed.kind === 'path') {
    return loadPath(parsed.path);
  }
  // Bare id — backwards-compatible behaviour, but guarded by ambiguity check.
  if (isBareIdAmbiguous(parsed.id, home)) {
    return {
      ok: false,
      error: 'ambiguous_address',
      message: `"${parsed.id}" matches both an installable skill id and a reference doc convention; use skill:${parsed.id} or ref:<skill>/<reference> to disambiguate`,
    };
  }
  return loadSkillById(parsed.id, home);
}

function availability(skillId: any, opts: any = {}) {
  const hit = loadSkillContent(skillId, opts);
  // Treat error envelopes (ambiguous_address, invalid_address) as
  // unavailable so callers don't silently fall through.
  const available = !!(hit && (hit as any).body && (hit as any).kind !== undefined);
  return {
    id: String(skillId || '').trim(),
    available,
    path: hit && (hit as any).path ? (hit as any).path : null,
    error: hit && (hit as any).error ? (hit as any).error : null,
  };
}

function resolveSkillRequirements(manifest: any, opts: any = {}) {
  const required = Array.isArray(manifest?.requiredSkills) ? manifest.requiredSkills : [];
  const optional = Array.isArray(manifest?.optionalSkills) ? manifest.optionalSkills : [];
  const requiredSkills = required.map((id: any) => availability(id, opts));
  const optionalSkills = optional.map((id: any) => availability(id, opts));
  const missingRequired = requiredSkills.filter((skill: any) => !skill.available);
  const missingOptional = optionalSkills.filter((skill: any) => !skill.available);
  return {
    requiredSkills,
    optionalSkills,
    missingRequired: missingRequired.map((skill: any) => skill.id),
    missingOptional: missingOptional.map((skill: any) => skill.id),
    warnings: missingOptional.map((skill: any) => `optional skill missing: ${skill.id}`),
    errors: missingRequired.map((skill: any) => `required skill missing: ${skill.id}`),
  };
}

// Extract the ordered, de-duplicated skill ids a launch intent should carry,
// from a prompt-telemetry object (the {baselineSkills, taskPackSkills,
// validationSkills, requiredSkills, optionalSkills} arrays buildTaskPromptEnvelope
// returns). Shared by the orchestrator (ace task run) and the Mission Board
// dispatch path (electron/local-core) so BOTH spawn paths wire skillIds → role
// doctrine identically. (Previously this lived privately in orchestrator.cts and
// the mission path never populated skillIds, so karpathy/agent-pack/driver-pack
// doctrine never materialised on mission worker spawns.)
function launchIntentSkillIds(telemetry: any = {}) {
  const out: any[] = [];
  const seen = new Set();
  for (const key of ['baselineSkills', 'taskPackSkills', 'validationSkills', 'requiredSkills', 'optionalSkills']) {
    const values = Array.isArray(telemetry?.[key]) ? telemetry[key] : [];
    for (const value of values) {
      const raw = value && typeof value === 'object' ? (value.id || value.name) : value;
      const id = String(raw || '').trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

module.exports = {
  loadSkillContent,
  candidatePaths,
  referenceCandidatePaths,
  parseQualifiedAddress,
  resolveSkillRequirements,
  launchIntentSkillIds,
};
