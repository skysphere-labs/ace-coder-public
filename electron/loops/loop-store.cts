// loop-store — definition persistence for Loops (PRD §5, §8 storage).
//
// A Loop's RUNS live on the existing run-ledger NDJSON event store (zero new run
// tables); this module owns only the persistence of loop DEFINITIONS — the saved
// LoopSpec catalog. Per PRD §8 + OD3 the v1 default is a SINGLE catalog file
// (skill-style), a JSON document keyed by loop id. `list / get / save / remove`.
//
// PURITY (PRD §5, §R2): this module imports NO better-sqlite3 and NO Electron,
// and it does NOT touch node:fs directly. All fs effects — readFile / writeFile /
// listDir — are INJECTED via the factory, exactly the spine's createKernel({...})
// injection pattern. That keeps it unit-testable with an in-memory fake fs and
// dodges the native-ABI mismatch noted in QA. The store is sync-effect shaped to
// mirror the spine's createMemoryEventLog (append/readAll) ergonomics.
//
// FAIL-CLOSED INTEGRITY: every spec read back from disk is re-validated through
// loop-spec.validateLoopSpec; a corrupt/partial/invalid catalog entry is skipped
// on read rather than surfaced as a runnable loop. `save` re-validates before it
// persists, so the catalog only ever holds runnable specs.

import type { LoopSpec } from './loop-spec.cts';

// loop-spec is a sibling .cts; require it directly so esbuild keeps the relative
// resolution intact (ref: esbuild run-ledger bundling — require .cts-first).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { validateLoopSpec } = require('./loop-spec.cts') as typeof import('./loop-spec.cts');

/**
 * Injected filesystem effects (PRD §5). Sync, dependency-free, and the only seam
 * to the outside world. The live wiring passes node:fs-backed implementations
 * (in loops-service); tests pass an in-memory fake.
 *
 *  - readFile(path)  → file contents, or null/undefined when the file is absent.
 *  - writeFile(path, contents) → persist (overwrite). Caller ensures the dir.
 *  - listDir(path)   → entry names in a directory (optional; only used by the
 *                      per-id layout helper — the v1 single-file model never
 *                      requires it, so it may be omitted).
 */
export interface LoopStoreFs {
  readFile: (path: string) => string | null | undefined;
  writeFile: (path: string, contents: string) => void;
  listDir?: (path: string) => string[];
}

export interface LoopStoreDeps extends LoopStoreFs {
  /**
   * Absolute path to the single catalog JSON file (PRD §8 / OD3 default). When
   * omitted, defaults to 'loops/catalog.json' — callers wiring real userData
   * should pass an absolute path.
   */
  catalogPath?: string;
}

export interface LoopStore {
  /** All saved, currently-valid LoopSpecs, ordered by id for determinism. */
  list: () => LoopSpec[];
  /** A single saved LoopSpec by id, or null when absent/invalid. */
  get: (id: string) => LoopSpec | null;
  /**
   * Validate then persist a LoopSpec into the catalog (upsert by id).
   * Returns the saved spec. Throws on an invalid spec (fail-closed) — only
   * runnable specs ever reach disk.
   */
  save: (spec: LoopSpec) => LoopSpec;
  /** Remove a LoopSpec by id. Returns true when an entry was removed. */
  remove: (id: string) => boolean;
}

const DEFAULT_CATALOG_PATH = 'loops/catalog.json';

function isNonEmptyString(v: any): boolean {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * Parse the catalog file content into an id→LoopSpec map, re-validating every
 * entry through validateLoopSpec. Corrupt JSON, a non-object document, or an
 * entry that no longer validates is skipped defensively (never throws) — exactly
 * the event-ledger's parseNdjson "skip corrupt line, never throw" posture.
 */
function parseCatalog(raw: string | null | undefined): Map<string, LoopSpec> {
  const map = new Map<string, LoopSpec>();
  if (!isNonEmptyString(raw as any)) return map;
  let doc: any;
  try {
    doc = JSON.parse(String(raw));
  } catch {
    return map; // corrupt/partial write — treat as empty catalog
  }
  // Catalog shape: { loops: { [id]: LoopSpec } } OR a bare { [id]: LoopSpec }.
  const entries = doc && typeof doc === 'object' && doc.loops && typeof doc.loops === 'object'
    ? doc.loops
    : doc && typeof doc === 'object'
      ? doc
      : {};
  for (const key of Object.keys(entries)) {
    const candidate = entries[key];
    const res = validateLoopSpec(candidate);
    if (!res.ok || !res.spec) continue; // skip invalid entry, never surface it
    // Trust the spec's own id (the validator guarantees it is a non-empty
    // string); ignore a stale map key that disagrees.
    map.set(res.spec.id, res.spec);
  }
  return map;
}

/**
 * Serialize the catalog map back to the on-disk document shape. Keys are sorted
 * for a stable, diff-friendly file (deterministic — no Date/random).
 */
function serializeCatalog(map: Map<string, LoopSpec>): string {
  const loops: Record<string, LoopSpec> = {};
  for (const id of Array.from(map.keys()).sort()) {
    loops[id] = map.get(id) as LoopSpec;
  }
  return `${JSON.stringify({ loops }, null, 2)}\n`;
}

/**
 * Create a Loop definition store backed by a single JSON catalog file, with all
 * fs effects injected (PRD §5/§8, OD3 default). Reads are validated fail-closed;
 * writes are validated before persist so the catalog only holds runnable specs.
 *
 * The store reads the catalog fresh on every call (no in-memory cache) so a
 * concurrent writer or an external edit is always reflected — mirroring the
 * file-backed event-ledger's read-through model. For the v1 single-writer,
 * low-frequency definition store this is correct and dependency-free.
 *
 * @param deps injected fs effects + optional catalogPath.
 */
export function createLoopStore(deps: LoopStoreDeps): LoopStore {
  if (!deps || typeof deps.readFile !== 'function' || typeof deps.writeFile !== 'function') {
    throw new Error('loop-store: createLoopStore requires injected { readFile, writeFile }');
  }
  const catalogPath = isNonEmptyString(deps.catalogPath as any)
    ? String(deps.catalogPath)
    : DEFAULT_CATALOG_PATH;

  function readCatalog(): Map<string, LoopSpec> {
    return parseCatalog(deps.readFile(catalogPath));
  }

  function writeCatalog(map: Map<string, LoopSpec>): void {
    deps.writeFile(catalogPath, serializeCatalog(map));
  }

  function list(): LoopSpec[] {
    const map = readCatalog();
    return Array.from(map.keys())
      .sort()
      .map((id) => map.get(id) as LoopSpec);
  }

  function get(id: string): LoopSpec | null {
    if (!isNonEmptyString(id)) return null;
    const map = readCatalog();
    return map.get(String(id)) ?? null;
  }

  function save(spec: LoopSpec): LoopSpec {
    const res = validateLoopSpec(spec);
    if (!res.ok || !res.spec) {
      throw new Error(`loop-store: refusing to save invalid LoopSpec: ${res.errors.join('; ')}`);
    }
    const map = readCatalog();
    map.set(res.spec.id, res.spec);
    writeCatalog(map);
    return res.spec;
  }

  function remove(id: string): boolean {
    if (!isNonEmptyString(id)) return false;
    const map = readCatalog();
    const existed = map.delete(String(id));
    if (existed) writeCatalog(map);
    return existed;
  }

  return { list, get, save, remove };
}

module.exports = {
  createLoopStore,
};
