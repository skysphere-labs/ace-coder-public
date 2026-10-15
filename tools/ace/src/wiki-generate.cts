// wiki-generate.cts — source-grounded repo-wiki GENERATOR (Factory AutoWiki,
// ADAPTED to Ace, not cloned).
//
// What it does, in Ace-native terms:
//   1. SURVEY  — run a set of source collectors over a project dir. Each
//      collector reads LIVE source (package.json, README, AGENTS.md,
//      FEATURES.json, the live CLI command registry, the bundled skills) and
//      returns short, source-grounded facts. Retired/stale surfaces
//      (ace-tui, the legacy mission verbs) are filtered out so generated
//      docs never reference a command that no longer exists.
//   2. PLAN    — collectors run in a fixed dependency order (overview → features
//      → commands → skills); each yields one logical "page" of facts plus the
//      content hashes of the source inputs it read.
//   3. GENERATE— each stale page is emitted as a KnowledgeEvent
//      (kind=research_capture, high confidence) and flows THROUGH the existing
//      tiered promotion gate (appendKnowledgeEvent → curateFromEvents). The gate
//      auto-promotes source-grounded facts to canon and routes anything that
//      CHANGED (same-key/different-value) to the inbox for owner review. The
//      generator never writes canon directly.
//   4. INCREMENTAL — a generator-owned manifest (.ace/wiki-generate.manifest.json)
//      records each page's source-input hashes. `--incremental` regenerates only
//      pages whose inputs changed. (The gate itself is idempotent regardless;
//      incremental just suppresses no-op churn and gives a clean changed-set.)
//
// Pure + dependency-light (node:crypto/fs/path only) so it is fully testable
// offline. The wiki-knowledge gate is injected (deps.wikiKnowledge) so tests can
// stub it; in production it falls back to the real module (.cjs built, .cts for
// tsx tests), mirroring the requireWikiKnowledge() pattern in the handlers.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA = 'AceWikiGenerate/v1';
const MANIFEST_SCHEMA = 'AceWikiGenerateManifest/v1';
const MANIFEST_FILE = 'wiki-generate.manifest.json';

// Source-grounded generation is high-confidence by construction (every fact
// cites a file it was read from). 0.9 clears the gate's 0.8 auto-promote bar.
const GENERATED_CONFIDENCE = 0.9;
const GENERATED_SENSITIVITY = 'internal';
const MAX_FACT_LEN = 280;
const MAX_FACTS_PER_PAGE = 40;

// Static require so esbuild keeps it; .cjs at runtime, .cts fallback for tsx tests.
function requireWikiKnowledge(): any {
  try { return require('./wiki-knowledge.cjs'); } catch { /* fall through */ }
  return require('./wiki-knowledge.cts');
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function sha16(value: any): string {
  const input = typeof value === 'string' ? value : JSON.stringify(value);
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 16);
}

function clean(value: any): string {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function readFileSafe(absPath: string): string | null {
  try { return fs.readFileSync(absPath, 'utf8'); } catch { return null; }
}

function readJsonSafe(absPath: string): any {
  const raw = readFileSafe(absPath);
  if (raw == null) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// Tokens that must never appear in a generated fact:
//  - supersede markers would force the gate to route the fact to the inbox
//    (and they do not belong in steady-state documentation anyway);
//  - retired surfaces (ace-tui, the legacy mission command verbs) are stale
//    and would document commands that no longer exist.
const SUPERSEDE_RX = /\b(supersedes?|superseding|replaces?|replacing|deprecates?|overrides?|no longer|instead of|rolled back|reverts?)\b/i;
const STALE_RX = [
  /\bace-tui\b/i,
  /\bmission\s+(create|dispatch|checkpoint|resume|board|sync|gate|validate)\b/i,
];

/** Normalize one fact; return null if it would be rejected/routed by the gate. */
function factSafe(text: any): string | null {
  const t = clean(text);
  if (t.length < 12) return null;          // gate hard-rejects < 12 chars
  if (SUPERSEDE_RX.test(t)) return null;   // would force inbox
  for (const rx of STALE_RX) if (rx.test(t)) return null; // retired surface
  return t.length > MAX_FACT_LEN ? `${t.slice(0, MAX_FACT_LEN - 1)}…` : t;
}

function resolveRef(projectDir: string, ref: string): string {
  return path.isAbsolute(ref) ? ref : path.join(projectDir, ref);
}

// ---------------------------------------------------------------------------
// Collectors — each reads LIVE source and returns { sourceRefs, facts, summary }
// or null when its inputs are absent (so the engine degrades gracefully on any
// repo). Generic collectors work on any project; Ace-aware collectors
// auto-skip when their paths do not exist. No project is hardcoded.
// ---------------------------------------------------------------------------

function collectPackage(projectDir: string): any {
  const ref = 'package.json';
  const pkg = readJsonSafe(resolveRef(projectDir, ref));
  if (!pkg || typeof pkg !== 'object') return null;
  const facts: string[] = [];
  const name = clean(pkg.name);
  if (name) facts.push(`Package name: ${name}${clean(pkg.version) ? ` (version ${clean(pkg.version)})` : ''}.`);
  if (clean(pkg.description)) facts.push(`Package description: ${clean(pkg.description)}.`);
  const scripts = pkg.scripts && typeof pkg.scripts === 'object' ? Object.keys(pkg.scripts) : [];
  for (const s of scripts.slice(0, 12)) facts.push(`npm script available: \`npm run ${clean(s)}\`.`);
  return { sourceRefs: [ref], summary: name ? `Project overview for ${name}.` : 'Project overview.', facts };
}

function collectReadme(projectDir: string): any {
  for (const ref of ['README.md', 'readme.md']) {
    const body = readFileSafe(resolveRef(projectDir, ref));
    if (body == null) continue;
    const facts: string[] = [];
    const headingMatch = body.match(/^#\s+(.+)$/m);
    if (headingMatch) facts.push(`README title: ${clean(headingMatch[1])}.`);
    // Section headings make a stable, source-grounded table of contents.
    const headings = [...body.matchAll(/^##\s+(.+)$/gm)].map((m) => clean(m[1])).filter(Boolean);
    for (const h of headings.slice(0, 12)) facts.push(`README documents a section: ${h}.`);
    if (!facts.length) return null;
    return { sourceRefs: [ref], summary: 'README-derived overview.', facts };
  }
  return null;
}

function collectDoctrine(projectDir: string): any {
  const facts: string[] = [];
  const sourceRefs: string[] = [];
  for (const ref of ['AGENTS.md', 'CLAUDE.md']) {
    const body = readFileSafe(resolveRef(projectDir, ref));
    if (body == null) continue;
    sourceRefs.push(ref);
    const headings = [...body.matchAll(/^##\s+(.+)$/gm)].map((m) => clean(m[1])).filter(Boolean);
    for (const h of headings.slice(0, 8)) facts.push(`${ref} defines a doctrine section: ${h}.`);
  }
  if (!facts.length) return null;
  return { sourceRefs, summary: 'Agent/worker doctrine surfaces.', facts };
}

function collectFeatures(projectDir: string): any {
  for (const ref of ['.ace/FEATURES.json', '.ace-template/FEATURES.json']) {
    const data = readJsonSafe(resolveRef(projectDir, ref));
    if (!data) continue;
    const list = Array.isArray(data) ? data : Array.isArray(data.features) ? data.features : [];
    if (!list.length) continue;
    const facts: string[] = [];
    for (const f of list.slice(0, 20)) {
      const id = clean(f?.id || f?.key);
      const title = clean(f?.title || f?.name || f?.description);
      if (id || title) facts.push(`Tracked feature: ${[id, title].filter(Boolean).join(' — ')}.`);
    }
    if (!facts.length) continue;
    return { sourceRefs: [ref], summary: 'Tracked feature inventory.', facts };
  }
  return null;
}

// Ace-aware: enumerate the LIVE CLI command registry so the command
// reference is always current and never names a retired verb. Falls back to
// the .cts source under tsx. Skips entirely (returns null) on a non-Ace repo.
function collectCommands(projectDir: string): any {
  const candidates = [
    'tools/ace/src/commands.cjs',
    'tools/ace/src/commands.cts',
  ];
  let ref: string | null = null;
  let registry: any = null;
  for (const rel of candidates) {
    const abs = resolveRef(projectDir, rel);
    if (!fs.existsSync(abs)) continue;
    try { registry = require(abs); ref = rel; break; } catch { /* try next */ }
  }
  if (!registry || typeof registry.allCommands !== 'function') return null;
  let commands: any[] = [];
  try { commands = registry.allCommands(); } catch { return null; }
  if (!Array.isArray(commands) || !commands.length) return null;
  const facts: string[] = [];
  for (const cmd of commands) {
    const cli = clean(cmd?.cli);
    if (!cli) continue;
    const desc = clean(cmd?.description);
    facts.push(desc ? `CLI command \`ace ${cli}\`: ${desc}` : `CLI command \`ace ${cli}\` is available.`);
  }
  if (!facts.length) return null;
  return { sourceRefs: [ref as string], summary: `Live CLI command surface (${facts.length} commands).`, facts };
}

// Ace-aware: enumerate bundled skill packs by scanning the assets dir
// (never a hardcoded list, so it stays current as skills are added/removed).
function collectSkills(projectDir: string): any {
  const dirRel = 'electron/assets/skills';
  const dirAbs = resolveRef(projectDir, dirRel);
  let entries: any[] = [];
  try { entries = fs.readdirSync(dirAbs, { withFileTypes: true }); } catch { return null; }
  const facts: string[] = [];
  const sourceRefs: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillMd = path.join(dirAbs, entry.name, 'SKILL.md');
    if (!fs.existsSync(skillMd)) continue;
    facts.push(`Bundled skill pack: ${clean(entry.name)}.`);
    sourceRefs.push(`${dirRel}/${entry.name}/SKILL.md`);
  }
  if (!facts.length) return null;
  return { sourceRefs, summary: `Bundled skill packs (${facts.length}).`, facts };
}

const DEFAULT_COLLECTORS = [
  { id: 'overview', title: 'Project Overview', run: collectPackage },
  { id: 'readme', title: 'README', run: collectReadme },
  { id: 'doctrine', title: 'Agent Doctrine', run: collectDoctrine },
  { id: 'features', title: 'Feature Inventory', run: collectFeatures },
  { id: 'commands', title: 'CLI Command Reference', run: collectCommands },
  { id: 'skills', title: 'Skill Packs', run: collectSkills },
];

// ---------------------------------------------------------------------------
// Survey + plan
// ---------------------------------------------------------------------------

/**
 * Run collectors in dependency order. Returns the ordered plan: one page spec
 * per collector that produced facts, each carrying its source-input content
 * hashes and a stable pageHash over (facts + summary + input hashes).
 */
function surveyRepo(input: any = {}): any[] {
  const projectDir = path.resolve(String(input.projectDir || process.cwd()));
  const collectors = Array.isArray(input.collectors) && input.collectors.length ? input.collectors : DEFAULT_COLLECTORS;
  const pages: any[] = [];
  for (const collector of collectors) {
    let result: any = null;
    try { result = collector.run(projectDir); } catch { result = null; }
    if (!result) continue;
    const facts = (result.facts || []).map(factSafe).filter(Boolean).slice(0, MAX_FACTS_PER_PAGE);
    const summary = factSafe(result.summary) || clean(result.summary);
    if (!facts.length && !summary) continue;
    const sourceRefs = (result.sourceRefs || []).map(clean).filter(Boolean);
    const inputHashes: Record<string, string> = {};
    for (const ref of sourceRefs) inputHashes[ref] = sha16(readFileSafe(resolveRef(projectDir, ref)) ?? '');
    const pageHash = sha16({ facts, summary, inputHashes });
    pages.push({ id: collector.id, title: collector.title, summary, facts, sourceRefs, inputHashes, pageHash });
  }
  return pages;
}

// ---------------------------------------------------------------------------
// Incremental manifest
// ---------------------------------------------------------------------------

function manifestPathFor(projectDir: string): string {
  return path.join(path.resolve(String(projectDir)), '.ace', MANIFEST_FILE);
}

function readManifest(projectDir: string): any {
  const data = readJsonSafe(manifestPathFor(projectDir));
  if (!data || typeof data !== 'object') return { schema: MANIFEST_SCHEMA, pages: {} };
  if (!data.pages || typeof data.pages !== 'object') data.pages = {};
  return data;
}

/** Split a plan into stale (changed or new) and fresh (unchanged) pages. */
function diffIncremental(plan: any[], manifest: any): any {
  const known = (manifest && manifest.pages) || {};
  const stale: any[] = [];
  const fresh: any[] = [];
  for (const page of plan) {
    if (known[page.id]?.pageHash === page.pageHash) fresh.push(page);
    else stale.push(page);
  }
  return { stale, fresh };
}

function writeManifest(projectDir: string, plan: any[], now: any): string {
  const target = manifestPathFor(projectDir);
  const pages: Record<string, any> = {};
  for (const page of plan) {
    pages[page.id] = { pageHash: page.pageHash, inputHashes: page.inputHashes, sourceRefs: page.sourceRefs, factCount: page.facts.length };
  }
  const manifest = {
    schema: MANIFEST_SCHEMA,
    generatedAt: clean(now) || new Date(typeof now === 'number' ? now : Date.now()).toISOString(),
    pages,
  };
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`);
  return target;
}

// ---------------------------------------------------------------------------
// Page → KnowledgeEvent
// ---------------------------------------------------------------------------

function pageToEvent(page: any, ctx: any): any {
  return {
    kind: 'research_capture',
    projectId: ctx.projectId,
    projectName: ctx.projectName,
    sourceRef: page.sourceRefs[0] || page.id,
    summary: page.summary || `${page.title} (source-grounded by wiki generate).`,
    payload: { facts: page.facts },
    sensitivity: GENERATED_SENSITIVITY,
    confidence: GENERATED_CONFIDENCE,
    now: ctx.now,
  };
}

function resolveProjectIdentity(projectDir: string, flags: any = {}): any {
  const explicitId = clean(flags.projectId || flags.project || flags.workspace);
  const explicitName = clean(flags.projectName);
  const pkg = readJsonSafe(resolveRef(projectDir, 'package.json')) || {};
  const base = path.basename(path.resolve(String(projectDir)));
  const projectId = explicitId || clean(pkg.name) || base;
  const projectName = explicitName || clean(pkg.name) || projectId;
  return { projectId, projectName };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Survey → plan → (incremental diff) → emit gated events → curate → write
 * manifest. Returns a structured, JSON-serializable report. Never writes canon
 * directly; canon is produced only by the tiered gate (curateFromEvents).
 */
function generate(input: any = {}): any {
  const projectDir = path.resolve(String(input.projectDir || process.cwd()));
  const incremental = input.incremental === true;
  const dryRun = input.dryRun === true;
  const now = input.now;
  const { projectId, projectName } = resolveProjectIdentity(projectDir, input.flags || input);
  const wikiKnowledge = input.wikiKnowledge || (input.deps && input.deps.wikiKnowledge) || requireWikiKnowledge();

  const plan = surveyRepo({ projectDir, collectors: input.collectors });
  const manifest = readManifest(projectDir);
  const { stale, fresh } = incremental ? diffIncremental(plan, manifest) : { stale: plan, fresh: [] };

  const pageReports = plan.map((page: any) => ({
    id: page.id,
    title: page.title,
    facts: page.facts.length,
    sourceRefs: page.sourceRefs,
    regenerated: incremental ? stale.includes(page) : true,
  }));

  const base = {
    schema: SCHEMA,
    projectDir,
    projectId,
    projectName,
    incremental,
    dryRun,
    surveyed: plan.length,
    regenerated: stale.length,
    skipped: fresh.length,
    pages: pageReports,
  };

  if (dryRun) {
    return { ...base, eventsAppended: 0, curation: null, manifestPath: manifestPathFor(projectDir), note: 'dry-run: no events emitted, no canon written, manifest untouched' };
  }

  const ctx = { projectId, projectName, now };
  let eventsAppended = 0;
  const eventIds: string[] = [];
  for (const page of stale) {
    const res = wikiKnowledge.appendKnowledgeEvent({ projectDir, event: pageToEvent(page, ctx) });
    if (res && res.appended) eventsAppended += 1;
    if (res && res.eventId) eventIds.push(res.eventId);
  }

  // Nothing stale → nothing to do. Skip the gate so a true no-op run leaves canon
  // byte-identical (curateFromEvents re-stamps page timestamps every time it runs).
  // When stale pages exist the gate is full + idempotent: it re-derives candidates
  // from ALL events and dedupes canon writes, so it promotes everything safely
  // even when only a subset of events was (re-)appended this run.
  const curation = stale.length > 0 ? wikiKnowledge.curateFromEvents({ projectDir, now }) : null;
  const manifestPath = writeManifest(projectDir, plan, now);

  return {
    ...base,
    eventsAppended,
    eventIds,
    curation: curation && {
      autoPromoted: curation.autoPromoted,
      inboxed: curation.inboxed,
      rejected: curation.rejected,
      written: curation.written,
    },
    manifestPath,
  };
}

module.exports = {
  generate,
  surveyRepo,
  diffIncremental,
  readManifest,
  writeManifest,
  pageToEvent,
  resolveProjectIdentity,
  manifestPathFor,
  DEFAULT_COLLECTORS,
  SCHEMA,
  MANIFEST_SCHEMA,
  MANIFEST_FILE,
  _internal: { factSafe, sha16, collectPackage, collectReadme, collectDoctrine, collectFeatures, collectCommands, collectSkills },
};
