/**
 * wiki-graph-indexer.cts
 *
 * Builds a ace.ops.wiki-graph.v1 graph from an Obsidian-style markdown vault
 * (default: the selected ACE_HOME profile's wiki directory).
 *
 * Design constraints:
 *   - NO electron / store / IPC imports — only Node built-ins: fs, os, path.
 *   - ZERO hardcoded http(s) URLs.
 *   - Fail-safe: any missing/unreadable root → empty graph, never throws.
 *   - All heuristic fields are labeled as derived, never presented as measured.
 *
 * Confidence formula (documented, heuristic, always confidenceBasis:'heuristic'):
 *   base   = 0.3
 *   fresh  = freshness === 'fresh' ? 1 : freshness === 'stale' ? 0.5 : freshness === 'expired' ? 0.1 : 0
 *   linked = backlinks > 0 ? 1 : 0
 *   score  = 0.3 + 0.4 * fresh + 0.3 * linked   (clamped to [0, 1])
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FRESH_MS   = 7  * 24 * 60 * 60 * 1000;  //  7 days
const STALE_MS   = 30 * 24 * 60 * 60 * 1000;  // 30 days

/** Max excerpt length (chars) for hover summaries. */
const EXCERPT_LENGTH = 240;

/** Directories to skip during recursive walk. */
const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', '.obsidian', '.trash']);

/**
 * Tag taxonomy — single-sourced in electron/harness/knowledge-contract.cts
 * (the SCHEMA.md vocabulary plus knowledge-plane additions). Used to
 * recognise tags that appear as bare #hashtags inside prose — kept as a Set
 * for O(1) lookup.
 */
const {
  TAG_VOCABULARY,
  TRUST_TIERS,
  inferVaultTrust,
  parseFrontmatter,
} = require('./harness/knowledge-contract.cts');
const SCHEMA_TAGS: Set<string> = new Set(TAG_VOCABULARY as string[]);

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface NodeRecord {
  id: string;
  path: string;
  title: string;
  tags: string[];
  updatedAt: string | null;
  freshness: 'fresh' | 'stale' | 'expired' | 'unknown';
  /** Knowledge-plane trust tier: frontmatter trust, else inferred from the vault path. */
  trust: 'canon' | 'working' | 'raw' | 'external';
  provenance: 'distilled' | 'raw' | 'mixed';
  confidence: number;
  confidenceBasis: 'heuristic';
  backlinks: number;
  /** First ~240 chars of body, frontmatter + markdown syntax stripped. For hover summaries. */
  excerpt: string;
}

interface WikiPageOk {
  ok: true;
  relPath: string;
  title: string;
  content: string;
  mtime: string;      // ISO 8601
  sizeBytes: number;
  excerpt: string;
}

interface WikiPageErr {
  ok: false;
  error: 'invalid-args' | 'path-escape' | 'not-markdown' | 'not-found' | 'read-error';
}

type WikiPageResult = WikiPageOk | WikiPageErr;

interface Edge {
  from: string;
  to: string;
}

interface WikiGraph {
  $schema: 'ace.ops.wiki-graph.v1';
  generatedAt: string;
  root: string;
  nodes: NodeRecord[];
  edges: Edge[];
  stats: { nodeCount: number; edgeCount: number; orphanCount: number };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Recursively collect all *.md file paths under `dir`, skipping SKIP_DIRS.
 * Returns [] on any error.
 */
function collectMarkdownFiles(dir: string): string[] {
  const results: string[] = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const sub = collectMarkdownFiles(full);
        for (const f of sub) results.push(f);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        results.push(full);
      }
    }
  } catch {
    // unreadable directory → return what we have so far
  }
  return results;
}

/**
 * Read file content safely. Returns '' on error.
 */
function readSafe(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return '';
  }
}

/**
 * Extract title: first `# ` heading line, else basename without extension.
 */
function extractTitle(content: string, filePath: string): string {
  const match = content.match(/^#\s+(.+)$/m);
  if (match) return match[1].trim();
  return path.basename(filePath, '.md');
}

/**
 * Strip a leading YAML frontmatter block (`---` ... `---`) from content.
 * Returns content unchanged when no frontmatter is present.
 */
function stripFrontmatter(content: string): string {
  return content.replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*(\r?\n|$)/, '');
}

/**
 * Strip common markdown syntax for plain-text excerpts:
 * code fences, inline code, images/links (keep text), wikilinks (keep
 * alias/target), heading markers, blockquotes, list bullets, emphasis,
 * HTML tags. Collapses whitespace.
 */
function stripMarkdownSyntax(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')                 // fenced code blocks
    .replace(/`([^`]*)`/g, '$1')                     // inline code
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')        // images → alt text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')         // links → link text
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')   // [[target|alias]] → alias
    .replace(/\[\[([^\]]+)\]\]/g, '$1')              // [[target]] → target
    .replace(/^#{1,6}\s+/gm, '')                     // heading markers
    .replace(/^>\s?/gm, '')                          // blockquote markers
    .replace(/^\s*[-*+]\s+/gm, '')                   // unordered list bullets
    .replace(/^\s*\d+\.\s+/gm, '')                   // ordered list markers
    .replace(/(\*{1,3}|_{1,3}|~~)([^*_~]+)\1/g, '$2') // emphasis/strike
    .replace(/<[^>]+>/g, ' ')                        // HTML tags
    .replace(/\s+/g, ' ')                            // collapse whitespace
    .trim();
}

/**
 * Build a hover-summary excerpt: first ~EXCERPT_LENGTH chars of the body
 * with frontmatter and markdown syntax stripped.
 */
function makeExcerpt(content: string): string {
  const plain = stripMarkdownSyntax(stripFrontmatter(content));
  return plain.slice(0, EXCERPT_LENGTH).trim();
}

/**
 * Extract tags from content using three heuristics:
 *   1. YAML-style frontmatter line: `tags: foo, bar` or `tags: [foo, bar]`
 *   2. `Tags:` prose line (as used in this vault): `Tags: ace, project, ...`
 *   3. `#tag` hashtag occurrences where tag is a known taxonomy word.
 * Returns deduplicated lowercase array.
 */
function extractTags(content: string): string[] {
  const found = new Set<string>();

  // Heuristic 1+2: any line matching `tags:` or `Tags:` (case-insensitive)
  const frontmatterPattern = /^tags\s*:\s*(.+)$/im;
  const fmMatch = content.match(frontmatterPattern);
  if (fmMatch) {
    const raw = fmMatch[1].replace(/[\[\]]/g, ''); // strip brackets
    const parts = raw.split(/[,\s]+/);
    for (const p of parts) {
      const tag = p.trim().toLowerCase();
      if (tag.length > 0) found.add(tag);
    }
  }

  // Heuristic 3: #hashtag tokens that are in the known taxonomy
  const hashPattern = /#([a-z][a-z0-9-]*)/g;
  let m: RegExpExecArray | null;
  while ((m = hashPattern.exec(content)) !== null) {
    const tag = m[1].toLowerCase();
    if (SCHEMA_TAGS.has(tag)) found.add(tag);
  }

  return Array.from(found);
}

/**
 * Parse [[wikilinks]] (and [[target|alias]] → target) from content.
 * Returns an array of raw target strings (not yet resolved to node ids).
 */
function parseWikilinks(content: string): string[] {
  const targets: string[] = [];
  const pattern = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(content)) !== null) {
    const raw = m[1].trim().replace(/^\.\//, ''); // strip leading ./
    if (raw.length > 0) targets.push(raw);
  }
  return targets;
}

/**
 * Compute freshness from mtime vs now.
 */
function computeFreshness(
  mtime: number | null,
  now: number,
): 'fresh' | 'stale' | 'expired' | 'unknown' {
  if (mtime === null) return 'unknown';
  const age = now - mtime;
  if (age < FRESH_MS)  return 'fresh';
  if (age < STALE_MS)  return 'stale';
  return 'expired';
}

/**
 * Compute heuristic confidence score.
 *
 * Formula:
 *   score = 0.3 + 0.4 * freshnessScore + 0.3 * linkedScore
 * where:
 *   freshnessScore = fresh→1, stale→0.5, expired→0.1, unknown→0
 *   linkedScore    = backlinks > 0 ? 1 : 0
 * Result clamped to [0, 1].
 */
function computeConfidence(
  freshness: 'fresh' | 'stale' | 'expired' | 'unknown',
  backlinks: number,
): number {
  const freshnessScore =
    freshness === 'fresh'   ? 1   :
    freshness === 'stale'   ? 0.5 :
    freshness === 'expired' ? 0.1 : 0;
  const linkedScore = backlinks > 0 ? 1 : 0;
  const score = 0.3 + 0.4 * freshnessScore + 0.3 * linkedScore;
  return Math.max(0, Math.min(1, score));
}

// ---------------------------------------------------------------------------
// buildWikiGraph
// ---------------------------------------------------------------------------

/**
 * Build a ace.ops.wiki-graph.v1 graph from an Obsidian-style vault.
 *
 * @param opts.root  - Vault root directory. Defaults to ACE_WIKI_ROOT or the profile's wiki.
 * @param opts.now   - Epoch ms used for freshness + generatedAt. Defaults to Date.now().
 */
function buildWikiGraph(opts?: { root?: string; now?: number }): WikiGraph {
  const root: string = opts?.root || process.env.ACE_WIKI_ROOT || path.join(process.env.ACE_HOME || path.join(os.homedir(), '.ace-coder'), 'wiki');
  const now: number = opts?.now ?? Date.now();

  const emptyGraph = (): WikiGraph => ({
    $schema: 'ace.ops.wiki-graph.v1',
    generatedAt: new Date(now).toISOString(),
    root,
    nodes: [],
    edges: [],
    stats: { nodeCount: 0, edgeCount: 0, orphanCount: 0 },
  });

  // Guard: missing or unreadable root → empty graph
  try {
    if (!fs.existsSync(root)) return emptyGraph();
    const stat = fs.statSync(root);
    if (!stat.isDirectory()) return emptyGraph();
  } catch {
    return emptyGraph();
  }

  // -------------------------------------------------------------------------
  // Phase 1: collect files and build raw node records
  // -------------------------------------------------------------------------

  const files = collectMarkdownFiles(root);
  if (files.length === 0) return emptyGraph();

  // Map from nodeId → partial NodeRecord (backlinks filled later)
  const nodeMap = new Map<string, NodeRecord>();
  // Map from nodeId → raw wikilink targets found in that file
  const rawLinksMap = new Map<string, string[]>();

  for (const absPath of files) {
    try {
      // Compute relative path from root (posix slashes)
      const relPath = path.relative(root, absPath).split(path.sep).join('/');
      // id = relative path without .md extension
      const id = relPath.endsWith('.md') ? relPath.slice(0, -3) : relPath;

      const content = readSafe(absPath);
      const title = extractTitle(content, absPath);
      const tags = extractTags(content);

      // mtime
      let updatedAt: string | null = null;
      let mtime: number | null = null;
      try {
        const st = fs.statSync(absPath);
        const mtimeMs: number = st.mtimeMs;
        mtime = mtimeMs;
        updatedAt = new Date(mtimeMs).toISOString();
      } catch {
        // leave null
      }

      const freshness = computeFreshness(mtime, now);

      // provenance: 'raw' if relative path starts with 'raw/', else 'distilled'
      const provenance: 'distilled' | 'raw' = relPath.startsWith('raw/')
        ? 'raw'
        : 'distilled';

      // Trust tier: frontmatter wins, vault-path inference otherwise (same
      // rules the knowledge index uses, so graph color == search tier).
      const { data: frontmatter } = parseFrontmatter(content);
      const trust = (TRUST_TIERS.includes(String(frontmatter?.trust))
        ? String(frontmatter.trust)
        : inferVaultTrust(relPath)) as NodeRecord['trust'];

      // Confidence will be updated after backlinks are computed; placeholder 0
      const node: NodeRecord = {
        id,
        path: relPath,
        title,
        tags,
        updatedAt,
        freshness,
        trust,
        provenance,
        confidence: 0,
        confidenceBasis: 'heuristic',
        backlinks: 0,
        excerpt: makeExcerpt(content),
      };

      nodeMap.set(id, node);
      rawLinksMap.set(id, parseWikilinks(content));
    } catch {
      // skip any file that errors during processing
    }
  }

  // -------------------------------------------------------------------------
  // Phase 2: resolve wikilinks → edges
  // -------------------------------------------------------------------------

  const edgeSet = new Set<string>(); // de-dupe "from::to"
  const edges: Edge[] = [];

  for (const [fromId, targets] of rawLinksMap.entries()) {
    for (const target of targets) {
      // Resolve target to a node id:
      //   1. Exact match
      //   2. Match by basename: a node whose id ends with '/<target>' or equals '<target>'
      let resolvedId: string | null = null;

      if (nodeMap.has(target)) {
        resolvedId = target;
      } else {
        // Basename match
        for (const nodeId of nodeMap.keys()) {
          if (nodeId === target || nodeId.endsWith('/' + target)) {
            resolvedId = nodeId;
            break;
          }
        }
      }

      if (resolvedId === null) continue; // unresolved → skip (no phantom nodes)
      if (resolvedId === fromId)  continue; // skip self-links

      const key = `${fromId}::${resolvedId}`;
      if (edgeSet.has(key)) continue;
      edgeSet.add(key);
      edges.push({ from: fromId, to: resolvedId });
    }
  }

  // -------------------------------------------------------------------------
  // Phase 3: compute backlinks and confidence
  // -------------------------------------------------------------------------

  for (const edge of edges) {
    const target = nodeMap.get(edge.to);
    if (target) target.backlinks += 1;
  }

  for (const node of nodeMap.values()) {
    node.confidence = computeConfidence(node.freshness, node.backlinks);
  }

  // -------------------------------------------------------------------------
  // Phase 4: stats
  // -------------------------------------------------------------------------

  const nodes = Array.from(nodeMap.values());
  const nodeCount = nodes.length;
  const edgeCount = edges.length;

  // Orphan = node with no incoming AND no outgoing edges
  const hasOutgoing = new Set(edges.map((e) => e.from));
  const hasIncoming = new Set(edges.map((e) => e.to));
  const orphanCount = nodes.filter(
    (n) => !hasOutgoing.has(n.id) && !hasIncoming.has(n.id),
  ).length;

  return {
    $schema: 'ace.ops.wiki-graph.v1',
    generatedAt: new Date(now).toISOString(),
    root,
    nodes,
    edges,
    stats: { nodeCount, edgeCount, orphanCount },
  };
}

// ---------------------------------------------------------------------------
// readWikiPage
// ---------------------------------------------------------------------------

/**
 * Safely read a single markdown page under the vault root.
 *
 * Security model (defense in depth, never throws):
 *   1. relPath must be a non-empty relative string ending in `.md`.
 *   2. Absolute relPath is rejected outright.
 *   3. `path.resolve(root, relPath)` must stay inside the resolved root
 *      (prefix check guarded with path.sep — blocks `../` traversal and
 *      sibling-prefix escapes like `/root-evil`).
 *   4. `fs.realpathSync` on both sides must still nest — blocks symlink
 *      escapes (a symlink inside the vault pointing outside it).
 *
 * @param opts.root    - Vault root directory. Defaults to ACE_WIKI_ROOT or the profile's wiki.
 * @param opts.relPath - Path of the page relative to root, e.g. 'concepts/x.md'.
 * @returns { ok:true, relPath, title, content, mtime, sizeBytes, excerpt }
 *          or { ok:false, error } — never throws.
 */
function readWikiPage(opts?: { root?: string; relPath?: string }): WikiPageResult {
  const root: string =
    typeof opts?.root === 'string' && opts.root.length > 0
      ? opts.root
      : process.env.ACE_WIKI_ROOT || path.join(process.env.ACE_HOME || path.join(os.homedir(), '.ace-coder'), 'wiki');
  const relPath = opts?.relPath;

  if (typeof relPath !== 'string' || relPath.trim().length === 0) {
    return { ok: false, error: 'invalid-args' };
  }
  if (path.isAbsolute(relPath)) {
    return { ok: false, error: 'path-escape' };
  }

  const resolvedRoot = path.resolve(root);
  const resolvedFile = path.resolve(resolvedRoot, relPath);
  if (!resolvedFile.startsWith(resolvedRoot + path.sep)) {
    return { ok: false, error: 'path-escape' };
  }

  if (!resolvedFile.endsWith('.md')) {
    return { ok: false, error: 'not-markdown' };
  }

  let stat: any;
  try {
    stat = fs.statSync(resolvedFile);
  } catch {
    return { ok: false, error: 'not-found' };
  }
  if (!stat.isFile()) {
    return { ok: false, error: 'not-found' };
  }

  // Symlink-escape guard: real paths of both sides must still nest.
  try {
    const realRoot: string = fs.realpathSync(resolvedRoot);
    const realFile: string = fs.realpathSync(resolvedFile);
    if (!realFile.startsWith(realRoot + path.sep)) {
      return { ok: false, error: 'path-escape' };
    }
  } catch {
    return { ok: false, error: 'not-found' };
  }

  let content: string;
  try {
    content = fs.readFileSync(resolvedFile, 'utf-8');
  } catch {
    return { ok: false, error: 'read-error' };
  }

  const normalizedRel = path
    .relative(resolvedRoot, resolvedFile)
    .split(path.sep)
    .join('/');

  return {
    ok: true,
    relPath: normalizedRel,
    title: extractTitle(content, resolvedFile),
    content,
    mtime: new Date(stat.mtimeMs).toISOString(),
    sizeBytes: stat.size,
    excerpt: makeExcerpt(content),
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  buildWikiGraph,
  readWikiPage,
  // Shared text helpers (reused by knowledge-index.cts / knowledge-audit.cts)
  extractTitle,
  extractTags,
  stripFrontmatter,
  stripMarkdownSyntax,
  makeExcerpt,
  parseWikilinks,
};
