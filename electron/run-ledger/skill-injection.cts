// skill-injection — make a RunSpec's skills MOUNT into a run, and BLOCK the run
// before it starts if any are missing.
//
// This is the preflight skill-mount gate that kills the scope_missing class:
// a run never begins with a skillId that does not resolve on disk, so a worker
// can never silently lose its role/keyword doctrine.
//
// THIN wrapper. All resolution lives in the skill-loader; this module does not
// re-walk skill dirs. It calls loadSkillContent(`skill:<id>`) and shapes the
// answer into injectable pointers. See the real loader API + resolution order:
//   ../../tools/ace/src/skill-loader.cts  (loadSkillContent)
// Pointer / qualified-address grammar (skill:<id>) is defined there too.
//
// Pure-ish: no Date.now()/Math.random() at module top level; the only side
// effect is the loader's read-only fs lookups, which it owns.

// Build-agnostic sibling import: the compiled .cjs is gitignored and may be
// absent in a fresh worktree, so fall back to the .cts that tsx resolves.
let skillLoader: any;
try {
  skillLoader = require('../../tools/ace/src/skill-loader.cjs');
} catch {
  skillLoader = require('../../tools/ace/src/skill-loader.cts');
}
const { loadSkillContent } = skillLoader;

// The injectable pointer form workers consume. Mirrors the loader's
// skill:<id> qualified address (skill-loader.cts parseQualifiedAddress).
function skillPointer(id: any) {
  return `skill:${String(id || '').trim()}`;
}

function normalizeIds(skillIds: any) {
  const list = Array.isArray(skillIds) ? skillIds : [];
  const out: any[] = [];
  const seen = new Set();
  for (const raw of list) {
    const id = String(raw && typeof raw === 'object' ? (raw.id || raw.name) : raw || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

// Locate each id via the skill-loader (per-agent dirs + repo-bundled dir, in
// the loader's resolution order). Returns one entry per id plus the missing
// list. opts is forwarded to the loader (notably opts.home for tests).
function resolveSkills(skillIds: any = [], opts: any = {}) {
  const ids = normalizeIds(skillIds);
  const resolved: any[] = [];
  const missing: any[] = [];
  for (const id of ids) {
    const hit = loadSkillContent(skillPointer(id), opts);
    // A hit is the {id,path,body,kind} envelope. A miss is null; an error
    // envelope ({ok:false,...}) has no body — treat both as not-found.
    const found = !!(hit && hit.body && hit.kind);
    resolved.push({ id, path: found ? hit.path : null, found });
    if (!found) missing.push(id);
  }
  return { resolved, missing };
}

// Turn skillIds into injectable pointers, BLOCKING ON MISSING: ok is false when
// any id fails to resolve, so a run can refuse to start rather than spawn a
// worker without its doctrine. Pointers are emitted only for resolved ids.
function injectSkills(skillIds: any = [], opts: any = {}) {
  const { resolved, missing } = resolveSkills(skillIds, opts);
  const pointers = resolved.filter((r: any) => r.found).map((r: any) => skillPointer(r.id));
  return { pointers, missing, ok: missing.length === 0 };
}

// Preflight gate over a RunSpec: ok only when every runspec.skillIds resolves.
function validateRunSpecSkills(runspec: any = {}, opts: any = {}) {
  const { missing } = resolveSkills(runspec && runspec.skillIds, opts);
  return { ok: missing.length === 0, missing };
}

module.exports = {
  resolveSkills,
  injectSkills,
  validateRunSpecSkills,
  skillPointer,
};
