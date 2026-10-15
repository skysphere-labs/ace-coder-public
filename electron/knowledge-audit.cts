// knowledge-audit.cts — deterministic nightly integrity checks for the
// knowledge plane. NO LLM involved: every check is a pure rule, every outcome
// is a decay assignment or a proposal. Nothing is ever deleted:
//   - canon/working offenders are DOWN-RANKED (decay) and listed as proposals
//     for the owner — never moved, never deleted (owner no-auto-archive rule).
//   - raw-tier offenders (inbox/, raw/) carrying secrets or contamination are
//     MOVED to quarantine/YYYY-MM-DD/ with a .quarantine.json reason sidecar —
//     still never deleted.
//   - rotation moves oversized machine logs to logs/YYYY-MM/ archives.
//
// Decay is recomputed from CURRENT findings each run (never ratcheted): a page
// whose findings clear recovers to 1.0 automatically.
//
// Constraints (mirrors wiki-graph-indexer.cts): Node built-ins only, fail-safe
// — unreadable files are skipped, the audit never throws.

'use strict';

const fs = require('fs');
const path = require('path');

const {
  KNOWLEDGE_SCHEMAS,
  TRUST_TIERS,
  DECAY_MIN,
  FREE_TAG_PREFIX,
  describeContamination,
  inferVaultTrust,
  parseFrontmatter,
  secretHits,
  validateOpsPageFrontmatter,
} = require('./harness/knowledge-contract.cts');

const { parseWikilinks, extractTags, extractTitle } = require('./wiki-graph-indexer.cts');

const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', '.obsidian', '.trash', 'quarantine', 'logs']);
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const STALE_CANON_MS = 90 * 24 * 60 * 60 * 1000;
const LOG_MD_ROTATE_BYTES = 256 * 1024;
const CURRENT_STATE_WARN_BYTES = 48 * 1024;
const NDJSON_ROTATE_BYTES = 1024 * 1024;
const NDJSON_KEEP_LINES = 500;
const FREE_TAG_PROMOTE_THRESHOLD = 5;

// Finding type → decay multiplier (the strongest single finding wins; decay
// floors at DECAY_MIN).
const DECAY_BY_FINDING: Record<string, number> = {
  'contamination': 0.1,
  'secret-content': 0.05,
  'invalid-frontmatter': 0.4,
  'expired-fact': 0.1,
  'stale-canon': 0.6,
  'superseded-duplicate': 0.5,
};

function collectMarkdown(dir: string, out: string[] = []): string[] {
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) collectMarkdown(full, out);
      else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full);
    }
  } catch { /* unreadable dir → partial result */ }
  return out;
}

function readSafe(filePath: string): string | null {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function normalizeTitle(title: any): string {
  return String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Run artifacts under `runs/**` legitimately reuse task/feature titles across
 * many append-only run-digest events (one title per mission/feature, many run
 * records), so they are NOT superseded duplicates. They are exempt from
 * duplicate-title detection ONLY — every other check (dead-wikilink,
 * contamination, expiry, …) still applies to them.
 */
function isRunArtifactPath(relPath: string): boolean {
  return /^runs\//.test(String(relPath || ''));
}

function pageTimestamp(data: any, content: string, filePath: string): number | null {
  if (data?.updatedAt) {
    const parsed = Date.parse(String(data.updatedAt));
    if (!Number.isNaN(parsed)) return parsed;
  }
  const legacy = content.slice(0, 2000).match(/^Updated:\s*(.+)$/im);
  if (legacy) {
    const parsed = Date.parse(legacy[1].trim());
    if (!Number.isNaN(parsed)) return parsed;
  }
  try {
    return Math.floor(fs.statSync(filePath).mtimeMs);
  } catch {
    return null;
  }
}

/**
 * Audit one markdown vault (ops wiki or a project wiki).
 * Returns findings, per-path decay assignments, proposals and quarantine
 * actions (computed; the caller decides whether to apply quarantine moves).
 */
function auditVault({ root, label = 'vault', now = Date.now() }: any) {
  const findings: any[] = [];
  const proposals: any[] = [];
  const decayByPath: Record<string, { decay: number; reasons: string[] }> = {};
  const quarantineCandidates: any[] = [];
  const freeTagCounts = new Map<string, number>();
  const titleIndex = new Map<string, Array<{ path: string; updatedAt: number }>>();
  const pageIds = new Set<string>();
  const linksByPage = new Map<string, string[]>();

  const files = collectMarkdown(root);
  let pagesChecked = 0;

  const addFinding = (type: string, filePath: string, detail: string, severity = 'yellow') => {
    findings.push({ type, path: filePath, detail, severity, vault: label });
  };
  const addDecay = (filePath: string, type: string, reason: string) => {
    const multiplier = DECAY_BY_FINDING[type];
    if (multiplier === undefined) return;
    const existing = decayByPath[filePath] || { decay: 1.0, reasons: [] };
    existing.decay = Math.max(DECAY_MIN, Math.min(existing.decay, multiplier));
    if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
    decayByPath[filePath] = existing;
  };

  for (const filePath of files) {
    const content = readSafe(filePath);
    if (content === null) continue;
    pagesChecked += 1;

    const relPath = path.relative(root, filePath).split(path.sep).join('/');
    const pageId = relPath.endsWith('.md') ? relPath.slice(0, -3) : relPath;
    pageIds.add(pageId);
    linksByPage.set(filePath, parseWikilinks(content));

    const { data, body } = parseFrontmatter(content);
    const trust = TRUST_TIERS.includes(String(data.trust)) ? String(data.trust) : inferVaultTrust(relPath);
    const isRawTier = trust === 'raw';

    // 1. Frontmatter validity (legacy pages are never failures)
    const validation = validateOpsPageFrontmatter(data);
    if (!validation.ok) {
      addFinding('invalid-frontmatter', filePath, validation.errors.join('; '));
      addDecay(filePath, 'invalid-frontmatter', 'invalid-frontmatter');
      proposals.push({ type: 'fix-frontmatter', path: filePath, detail: validation.errors.join('; ') });
    }

    // 2. Secrets (the index already refuses these; the vault copy must be
    //    surfaced — quarantine raw tier, propose for curated tiers)
    if (secretHits(content).length > 0) {
      addFinding('secret-content', filePath, 'secret-like content present', 'black');
      addDecay(filePath, 'secret-content', 'secret-content');
      if (isRawTier) quarantineCandidates.push({ path: filePath, reason: 'secret-content' });
      else proposals.push({ type: 'redact-secret', path: filePath, detail: 'secret-like content in curated page' });
    }

    // 3. Contamination (sentinel-accompanied failed probes are sanctioned)
    const contamination = describeContamination(body, { allowSentinel: true });
    if (contamination.length > 0) {
      addFinding('contamination', filePath, contamination.join(', '));
      addDecay(filePath, 'contamination', `contamination:${contamination.join('+')}`);
      if (isRawTier) quarantineCandidates.push({ path: filePath, reason: contamination.join(',') });
      else proposals.push({ type: 'clean-contamination', path: filePath, detail: contamination.join(', ') });
    }

    // 4. Expiry
    if (data.expiresAt) {
      const expires = Date.parse(String(data.expiresAt));
      if (!Number.isNaN(expires) && expires < now) {
        addFinding('expired-fact', filePath, `expired ${String(data.expiresAt)}`, 'green');
        addDecay(filePath, 'expired-fact', 'expired-fact');
      }
    }

    // 5. Canon staleness (>90d untouched) — decay + review proposal
    const timestamp = pageTimestamp(data, content, filePath);
    if (trust === 'canon' && timestamp !== null && now - timestamp > STALE_CANON_MS) {
      addFinding('stale-canon', filePath, `untouched for ${Math.round((now - timestamp) / 86400000)}d`, 'green');
      addDecay(filePath, 'stale-canon', 'stale-canon');
      proposals.push({ type: 'review-stale', path: filePath, detail: 'canon page >90d old — refresh or mark superseded' });
    }

    // 6. Duplicate titles among curated tiers → older copy decays. Run
    //    artifacts under runs/** are exempt: they legitimately share titles.
    if (trust !== 'raw' && !isRunArtifactPath(relPath)) {
      const titleKey = normalizeTitle(data.title || extractTitle(content, filePath));
      if (titleKey) {
        const bucket = titleIndex.get(titleKey) || [];
        bucket.push({ path: filePath, updatedAt: timestamp || 0 });
        titleIndex.set(titleKey, bucket);
      }
    }

    // 7. Free-tag census (x/ tags used often → vocabulary promotion proposal)
    const tags = Array.isArray(data.tags) ? data.tags.map((t: any) => String(t).toLowerCase()) : extractTags(content);
    for (const tag of tags) {
      if (tag.startsWith(FREE_TAG_PREFIX)) freeTagCounts.set(tag, (freeTagCounts.get(tag) || 0) + 1);
    }
  }

  // Dead wikilinks (target resolves to no page in this vault)
  for (const [filePath, targets] of linksByPage.entries()) {
    for (const target of targets) {
      const normalized = target.replace(/\.md$/, '');
      const resolved =
        pageIds.has(normalized) ||
        Array.from(pageIds).some((id) => id === normalized || id.endsWith(`/${normalized}`));
      if (!resolved) {
        findings.push({ type: 'dead-wikilink', path: filePath, detail: `[[${target}]]`, severity: 'green', vault: label });
        proposals.push({ type: 'fix-link', path: filePath, detail: `dead wikilink [[${target}]]` });
      }
    }
  }

  // Duplicate-title resolution: newest copy stays healthy, older copies decay
  for (const [titleKey, copies] of titleIndex.entries()) {
    if (copies.length < 2) continue;
    const sorted = [...copies].sort((a, b) => b.updatedAt - a.updatedAt);
    for (const older of sorted.slice(1)) {
      findings.push({ type: 'superseded-duplicate', path: older.path, detail: `duplicate title "${titleKey}" — newer copy: ${sorted[0].path}`, severity: 'yellow', vault: label });
      const existing = decayByPath[older.path] || { decay: 1.0, reasons: [] };
      existing.decay = Math.max(DECAY_MIN, Math.min(existing.decay, DECAY_BY_FINDING['superseded-duplicate']));
      if (!existing.reasons.includes('superseded-duplicate')) existing.reasons.push('superseded-duplicate');
      decayByPath[older.path] = existing;
      proposals.push({ type: 'consolidate-duplicate', path: older.path, detail: `merge into ${sorted[0].path}` });
    }
  }

  for (const [tag, count] of freeTagCounts.entries()) {
    if (count > FREE_TAG_PROMOTE_THRESHOLD) {
      proposals.push({ type: 'promote-tag', path: root, detail: `free tag ${tag} used ${count}× — consider promoting to the controlled vocabulary` });
    }
  }

  return { findings, proposals, decayByPath, quarantineCandidates, pagesChecked };
}

/** Move raw-tier offenders to quarantine/YYYY-MM-DD/ with reason sidecars. */
function applyQuarantine({ root, candidates, now = Date.now() }: any) {
  const moved: any[] = [];
  const day = new Date(now).toISOString().slice(0, 10);
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    try {
      const rel = path.relative(root, candidate.path);
      if (rel.startsWith('..')) continue; // never move outside the vault
      const targetDir = path.join(root, 'quarantine', day, path.dirname(rel));
      fs.mkdirSync(targetDir, { recursive: true });
      const target = path.join(targetDir, path.basename(candidate.path));
      fs.renameSync(candidate.path, target);
      fs.writeFileSync(`${target}.quarantine.json`, `${JSON.stringify({
        schema: 'AceKnowledgeQuarantine/v1',
        originalPath: candidate.path,
        reason: candidate.reason,
        quarantinedAt: new Date(now).toISOString(),
      }, null, 2)}\n`);
      moved.push({ from: candidate.path, to: target, reason: candidate.reason });
    } catch { /* fail-safe: leave the file where it is */ }
  }
  return moved;
}

/**
 * Resolve one quarantined item (owner action from the Knowledge tab).
 * approve → restore to its original path (or inbox/restored-* if taken);
 * reject → move under quarantine/rejected/YYYY-MM-DD/. RENAME-ONLY by
 * construction — this module contains no unlink/rm calls.
 */
function resolveQuarantineItem({ wikiRoot, itemPath, action, now = Date.now() }: any) {
  if (action !== 'approve' && action !== 'reject') {
    return { ok: false, error: 'action must be approve|reject' };
  }
  const root = path.resolve(String(wikiRoot || ''));
  const quarantineRoot = path.join(root, 'quarantine');
  let real: string;
  try {
    real = fs.realpathSync(path.resolve(String(itemPath || '')));
  } catch {
    return { ok: false, error: 'not_found' };
  }
  if (!real.startsWith(quarantineRoot + path.sep)) {
    return { ok: false, error: 'path_outside_quarantine' };
  }
  const sidecarPath = `${real}.quarantine.json`;
  try {
    const sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
    if (action === 'approve') {
      const original = path.resolve(String(sidecar.originalPath || ''));
      const originalContained = original.startsWith(root + path.sep) && !original.startsWith(quarantineRoot + path.sep);
      const target = originalContained && !fs.existsSync(original)
        ? original
        : path.join(root, 'inbox', `restored-${path.basename(real)}`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.renameSync(real, target);
      const resolvedDir = path.join(quarantineRoot, 'resolved');
      fs.mkdirSync(resolvedDir, { recursive: true });
      fs.renameSync(sidecarPath, path.join(resolvedDir, `${now}-${path.basename(sidecarPath)}`));
      return { ok: true, action, restoredTo: target };
    }
    const rejectedDir = path.join(quarantineRoot, 'rejected', new Date(now).toISOString().slice(0, 10));
    fs.mkdirSync(rejectedDir, { recursive: true });
    const target = path.join(rejectedDir, path.basename(real));
    fs.renameSync(real, target);
    fs.renameSync(sidecarPath, `${target}.quarantine.json`);
    return { ok: true, action, movedTo: target };
  } catch (err: any) {
    return { ok: false, error: String(err?.message || err) };
  }
}

/**
 * Rotate oversized machine artifacts (archive, never delete):
 *   - <wikiRoot>/log.md          >256KB → entries before the current month
 *                                          append to logs/YYYY-MM/log.md
 *   - <stateDir>/probes/*.ndjson >1MB   → keep last 500 lines, archive rest
 * current-state.md only gets a proposal (its sections are bounded already;
 * structural rotation belongs to wiki-updater's section markers).
 */
function rotateKnowledgeArtifacts({ wikiRoot, stateDir, now = Date.now() }: any) {
  const rotated: any[] = [];
  const proposals: any[] = [];
  const month = new Date(now).toISOString().slice(0, 7);

  try {
    const logPath = path.join(wikiRoot, 'log.md');
    const stat = fs.statSync(logPath);
    if (stat.size > LOG_MD_ROTATE_BYTES) {
      const content = fs.readFileSync(logPath, 'utf8');
      const lines = content.split('\n');
      const keep: string[] = [];
      const archive: string[] = [];
      // Keep current-month entries (lines containing [YYYY-MM) + non-entry header lines near the top.
      const currentMonthToken = `[${month}`;
      for (const line of lines) {
        if (/^- \[\d{4}-\d{2}/.test(line) && !line.includes(currentMonthToken)) archive.push(line);
        else keep.push(line);
      }
      if (archive.length > 0) {
        const archiveDir = path.join(wikiRoot, 'logs', month);
        fs.mkdirSync(archiveDir, { recursive: true });
        fs.appendFileSync(path.join(archiveDir, 'log.md'), `${archive.join('\n')}\n`);
        const tmp = `${logPath}.tmp-rotate`;
        fs.writeFileSync(tmp, keep.join('\n'));
        fs.renameSync(tmp, logPath);
        rotated.push({ path: logPath, archivedLines: archive.length, archiveDir });
      }
    }
  } catch { /* missing/unreadable log.md → nothing to rotate */ }

  try {
    const currentState = path.join(wikiRoot, 'dashboards', 'current-state.md');
    const stat = fs.statSync(currentState);
    if (stat.size > CURRENT_STATE_WARN_BYTES) {
      proposals.push({ type: 'rotate-current-state', path: currentState, detail: `current-state.md is ${Math.round(stat.size / 1024)}KB (>48KB) — review sections for retirement` });
    }
  } catch { /* no dashboard yet */ }

  try {
    const probesDir = path.join(String(stateDir || ''), 'probes');
    for (const name of fs.readdirSync(probesDir)) {
      if (!name.endsWith('.ndjson')) continue;
      const filePath = path.join(probesDir, name);
      const stat = fs.statSync(filePath);
      if (stat.size <= NDJSON_ROTATE_BYTES) continue;
      const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
      if (lines.length <= NDJSON_KEEP_LINES) continue;
      const archiveDir = path.join(probesDir, 'archive');
      fs.mkdirSync(archiveDir, { recursive: true });
      fs.appendFileSync(path.join(archiveDir, `${name}.${month}.ndjson`), `${lines.slice(0, lines.length - NDJSON_KEEP_LINES).join('\n')}\n`);
      const tmp = `${filePath}.tmp-rotate`;
      fs.writeFileSync(tmp, `${lines.slice(-NDJSON_KEEP_LINES).join('\n')}\n`);
      fs.renameSync(tmp, filePath);
      rotated.push({ path: filePath, keptLines: NDJSON_KEEP_LINES });
    }
  } catch { /* no probes dir */ }

  return { rotated, proposals };
}

/** Render the nightly audit report markdown (AceKnowledgeAuditReport/v1). */
function renderAuditReport({ generatedAt, vaults, rotation, quarantined, curation, indexStats }: any) {
  const allFindings = vaults.flatMap((vault: any) => vault.findings);
  const allProposals = [
    ...vaults.flatMap((vault: any) => vault.proposals),
    ...(rotation?.proposals || []),
  ];
  const lines = [
    '---',
    `schema: ${KNOWLEDGE_SCHEMAS.auditReport}`,
    `kind: reference`,
    `title: Knowledge audit ${String(generatedAt).slice(0, 10)}`,
    'trust: working',
    `updatedAt: ${generatedAt}`,
    'tags: [ace, wiki]',
    `sources: [knowledge-audit]`,
    '---',
    '',
    `# Knowledge audit — ${String(generatedAt).slice(0, 10)}`,
    '',
    `- pages checked: ${vaults.reduce((sum: number, vault: any) => sum + vault.pagesChecked, 0)}`,
    `- findings: ${allFindings.length}`,
    `- proposals (owner review — nothing auto-deleted): ${allProposals.length}`,
    `- quarantined (raw tier only, moved not deleted): ${quarantined.length}`,
    `- rotated artifacts: ${rotation?.rotated?.length || 0}`,
    indexStats ? `- index: ${indexStats.indexed} indexed / ${indexStats.removed} removed / ${indexStats.scanned} scanned` : '',
    curation ? `- project curation runs: ${curation.length}` : '',
    '',
    '## Findings',
    ...(allFindings.length
      ? allFindings.slice(0, 200).map((finding: any) => `- [${finding.severity}] ${finding.type} — ${finding.path}${finding.detail ? ` — ${finding.detail}` : ''}`)
      : ['- none']),
    '',
    '## Proposals',
    ...(allProposals.length
      ? allProposals.slice(0, 200).map((proposal: any) => `- ${proposal.type} — ${proposal.path}${proposal.detail ? ` — ${proposal.detail}` : ''}`)
      : ['- none']),
    '',
    '## Quarantined',
    ...(quarantined.length
      ? quarantined.map((entry: any) => `- ${entry.from} → ${entry.to} (${entry.reason})`)
      : ['- none']),
    '',
  ].filter((line: any) => line !== '');
  return lines.join('\n') + '\n';
}

module.exports = {
  auditVault,
  applyQuarantine,
  resolveQuarantineItem,
  rotateKnowledgeArtifacts,
  renderAuditReport,
  DECAY_BY_FINDING,
};
