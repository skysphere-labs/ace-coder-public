const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// Contamination/secret patterns and the failed-snapshot sentinel are
// single-sourced in electron/harness/knowledge-contract.cts (shipped with the
// CLI bundle, same as electron/harness/completion-result.cts).
const {
  WIKI_FAILED_SNAPSHOT_SENTENCE: FAILED_SNAPSHOT_SENTENCE,
  SECRET_PATTERNS,
  RAW_TRANSCRIPT_PATTERNS,
  DORMANT_STREAM_PATTERNS,
  FAILED_PROBE_PATTERNS,
  VAGUE_PATTERNS,
} = require('../../../electron/harness/knowledge-contract.cts');

const DUMP_SCHEMA = 'AceDumpRecord/v1';
const CANDIDATE_SCHEMA = 'AceProjectUpdateCandidate/v1';
const PACK_SCHEMA = 'AceWikiPack/v1';

function aceDir(projectDir: any) {
  return path.join(path.resolve(String(projectDir || process.cwd())), '.ace');
}

function dumpDir(projectDir: any) {
  return path.join(aceDir(projectDir), 'wiki-dump');
}

function wikiDir(projectDir: any) {
  return path.join(aceDir(projectDir), 'wiki');
}

function isoNow(now?: any) {
  return now ? new Date(now).toISOString() : new Date().toISOString();
}

function datePart(iso: string) {
  return iso.slice(0, 10);
}

function asArray(value: any) {
  if (Array.isArray(value)) return value.filter((item) => item !== undefined && item !== null && String(item).trim() !== '');
  if (value === undefined || value === null || String(value).trim() === '') return [];
  return [value];
}

function cleanText(value: any) {
  return String(value == null ? '' : value).trim();
}

function slugify(value: any) {
  const text = cleanText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return text || 'project';
}

function projectSlug(value: any) {
  return slugify(value?.projectSlug || value?.projectName || value?.projectId || value?.workspaceId || 'project');
}

function stableJson(value: any): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: any) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : stableJson(value)).digest('hex');
}

function writeJson(filePath: string, value: any) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(filePath: string) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function allText(value: any): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(allText).join('\n');
  if (typeof value === 'object') return Object.values(value).map(allText).join('\n');
  return String(value);
}

function secretHits(value: any) {
  const text = allText(value);
  return SECRET_PATTERNS.filter((rx: any) => rx.test(text)).map((rx: any) => rx.source);
}

function redactedValue(value: any): any {
  if (typeof value === 'string') {
    return SECRET_PATTERNS.reduce((text: any, rx: any) => text.replace(rx, '[REDACTED]'), value);
  }
  if (Array.isArray(value)) return value.map(redactedValue);
  if (value && typeof value === 'object') {
    const out: any = {};
    for (const [key, child] of Object.entries(value)) out[key] = redactedValue(child);
    return out;
  }
  return value;
}

function contaminationReasons(value: any) {
  const text = allText(value);
  const reasons = [];
  if (RAW_TRANSCRIPT_PATTERNS.some((rx: any) => rx.test(text)) || DORMANT_STREAM_PATTERNS.some((rx: any) => rx.test(text))) {
    reasons.push('raw-transcript-or-dormant-stream');
  }
  if (FAILED_PROBE_PATTERNS.some((rx: any) => rx.test(text)) && !text.includes(FAILED_SNAPSHOT_SENTENCE)) {
    reasons.push('failed-probe-without-sentinel');
  }
  return reasons;
}

function sourceLabel(record: any) {
  return cleanText(record.source || record.sourceUrl || record.rawPath || record.sessionId || record.missionId || record.prNumber || record.kind || 'unknown');
}

function normalizeDumpRecord(input: any) {
  const capturedAt = cleanText(input.capturedAt) || isoNow(input.now);
  const record: any = {
    schema: DUMP_SCHEMA,
    kind: cleanText(input.kind) || 'operator_note',
    identity: cleanText(input.identity) || 'chief',
    projectId: cleanText(input.projectId || input.workspaceId) || '',
    projectName: cleanText(input.projectName) || cleanText(input.projectId || input.workspaceId) || 'Project',
    missionId: cleanText(input.missionId) || null,
    featureId: cleanText(input.featureId) || null,
    prNumber: input.prNumber === undefined || input.prNumber === null || input.prNumber === '' ? null : Number(input.prNumber),
    sessionId: cleanText(input.sessionId) || null,
    source: cleanText(input.source) || null,
    sourceUrl: cleanText(input.sourceUrl) || null,
    fetchStatus: cleanText(input.fetchStatus) || null,
    capturedAt,
    trust: cleanText(input.trust) || (cleanText(input.kind) === 'external_link' ? 'external_unverified' : 'self_report'),
    title: cleanText(input.title) || cleanText(input.kind) || 'Project update',
    summary: cleanText(input.summary) || '',
    proposedNextActions: asArray(input.proposedNextActions || input.nextActions || input.nextAction),
    completedItems: asArray(input.completedItems || input.completed || input.done),
    decisions: asArray(input.decisions || input.decision),
    blockers: asArray(input.blockers || input.blocker),
    evidence: asArray(input.evidence),
    rawPath: cleanText(input.rawPath) || null,
  };
  record.source = record.source || sourceLabel(record);
  if (input.status) record.status = cleanText(input.status);
  if (input.nextAction) record.nextAction = cleanText(input.nextAction);
  if (input.cliCommand) record.cliCommand = cleanText(input.cliCommand);
  if (input.cliResult) record.cliResult = input.cliResult;
  if (input.category) record.category = cleanText(input.category);
  const tags = asArray(input.tags).map((tag: any) => cleanText(tag).toLowerCase()).filter(Boolean);
  if (tags.length > 0) record.tags = tags;
  return record;
}

function writeDumpRecord(input: any) {
  const projectDir = input.projectDir || process.cwd();
  let record = normalizeDumpRecord(input.record || input);
  if (!record.projectId) throw new Error('projectId is required for dump records');

  const secrets = secretHits(record);
  if (secrets.length > 0) {
    record = redactedValue(record);
    record.redactions = ['secret-like-content'];
  }

  const reasons = contaminationReasons(record);
  const bodyForHash = { ...record };
  delete bodyForHash.id;
  delete bodyForHash.sha256;
  record.sha256 = sha256(bodyForHash);
  record.id = cleanText((input.record || input).id) || `dump_${record.sha256.slice(0, 16)}`;

  let targetDir;
  if (reasons.length > 0) {
    record.status = 'quarantined';
    record.quarantineReasons = reasons;
    targetDir = path.join(dumpDir(projectDir), 'quarantine');
  } else if (record.identity === 'external') {
    targetDir = path.join(dumpDir(projectDir), 'external', datePart(record.capturedAt));
  } else {
    targetDir = path.join(dumpDir(projectDir), slugify(record.identity), datePart(record.capturedAt));
  }
  const target = path.join(targetDir, `${record.id}.json`);
  writeJson(target, record);
  return { path: target, record, quarantined: reasons.length > 0, redacted: secrets.length > 0 };
}

function walkJsonFiles(root: string) {
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  for (const name of fs.readdirSync(root)) {
    const child = path.join(root, name);
    const stat = fs.statSync(child);
    if (stat.isDirectory()) out.push(...walkJsonFiles(child));
    else if (name.endsWith('.json')) out.push(child);
  }
  return out;
}

function collectDumpRecords(input: any = {}) {
  const projectDir = input.projectDir || process.cwd();
  const identity = cleanText(input.identity || '');
  const includeQuarantine = input.includeQuarantine === true;
  const records = [];
  for (const filePath of walkJsonFiles(dumpDir(projectDir))) {
    const rel = path.relative(dumpDir(projectDir), filePath);
    if (!includeQuarantine && rel.startsWith(`quarantine${path.sep}`)) continue;
    const record = readJson(filePath);
    if (identity && record.identity !== identity) continue;
    records.push({ ...record, dumpPath: filePath });
  }
  records.sort((a: any, b: any) => String(a.capturedAt).localeCompare(String(b.capturedAt)));
  return records;
}

function itemText(item: any) {
  if (typeof item === 'string') return cleanText(item);
  return cleanText(item?.text || item?.summary || item?.title || item?.decision || item?.blocker || item?.nextAction || '');
}

function candidateFrom(record: any, type: string, text: string, targetPage: string, extra: any = {}) {
  const sourceDumpIds = [record.id].filter(Boolean);
  const body = {
    schema: CANDIDATE_SCHEMA,
    projectId: record.projectId,
    projectName: record.projectName,
    identity: record.identity,
    type,
    text,
    targetPage,
    sourceDumpIds,
    evidence: asArray(extra.evidence || record.evidence).map(itemText).filter(Boolean),
    confidence: extra.confidence || (record.trust === 'verified' ? 'high' : 'medium'),
    status: 'candidate',
    createdAt: record.capturedAt || isoNow(),
    missionId: record.missionId || null,
    featureId: record.featureId || null,
    prNumber: record.prNumber || null,
  };
  return { ...body, id: `cand_${sha256(body).slice(0, 16)}` };
}

function extractProjectUpdateCandidates(input: any) {
  const records = Array.isArray(input) ? input : (input.records || []);
  const candidates = [];
  for (const record of records) {
    if (record.status === 'quarantined') continue;
    if (record.kind === 'external_link' && record.fetchStatus === 'failed') continue;
    if (!record.projectId) continue;
    const slug = projectSlug(record);
    const projectPage = `projects/${slug}.md`;
    const decisionPage = `decisions/${slug}-decisions.md`;

    if (cleanText(record.summary)) {
      candidates.push(candidateFrom(record, 'status_update', cleanText(record.summary), projectPage));
    }
    for (const item of record.completedItems || []) {
      const text = itemText(item);
      if (text) candidates.push(candidateFrom(record, 'completed_item', text, projectPage));
    }
    for (const item of record.proposedNextActions || []) {
      const text = itemText(item);
      if (text) candidates.push(candidateFrom(record, 'next_action', text, projectPage));
    }
    for (const item of record.blockers || []) {
      const text = itemText(item);
      if (text) candidates.push(candidateFrom(record, 'blocker', text, projectPage));
      const next = cleanText(item?.nextSafeStep || item?.nextAction);
      if (next) candidates.push(candidateFrom(record, 'next_action', next, projectPage));
    }
    for (const item of record.decisions || []) {
      const text = itemText(item);
      if (text) candidates.push(candidateFrom(record, 'decision', text, decisionPage));
    }
  }
  return dedupeBy(candidates, (candidate: any) => `${candidate.type}:${normalizeLine(candidate.text)}:${candidate.targetPage}:${candidate.sourceDumpIds.join(',')}`);
}

function normalizeLine(value: any) {
  return cleanText(value).toLowerCase().replace(/\s+/g, ' ');
}

function dedupeBy(items: any[], keyFn: any) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function dumpExists(projectDir: string, id: string) {
  return walkJsonFiles(dumpDir(projectDir)).some((filePath) => {
    try { return readJson(filePath).id === id; } catch { return false; }
  });
}

function candidateCliClaims(text: string) {
  const claims = [];
  const rx = /ace\s+([a-z][a-z0-9-]*(?:\s+[a-z][a-z0-9-]*)?)/gi;
  let match;
  while ((match = rx.exec(text))) claims.push(match[1].trim());
  return claims;
}

function validateCandidate(candidate: any, options: any = {}) {
  const errors = [];
  const text = cleanText(candidate.text);
  if (!candidate.sourceDumpIds || candidate.sourceDumpIds.length === 0) errors.push('missing-source-dump');
  if (options.projectDir) {
    for (const id of candidate.sourceDumpIds || []) {
      if (!dumpExists(options.projectDir, id)) errors.push(`missing-source:${id}`);
    }
  }
  if (!candidate.targetPage) errors.push('missing-target-page');
  if (text.length < 12 || VAGUE_PATTERNS.some((rx: any) => rx.test(text))) errors.push('vague-candidate');
  if (secretHits(candidate).length > 0) errors.push('secret-like-content');
  errors.push(...contaminationReasons(candidate));

  const commands = options.describeCommands || [];
  if (commands.length > 0) {
    for (const claim of candidateCliClaims(text)) {
      if (!commands.includes(claim)) errors.push(`cli-claim-not-installed:${claim}`);
    }
  }

  if (errors.length > 0) {
    const status = errors.some((err) => err.startsWith('cli-claim-not-installed')) ? 'conflicted' : 'rejected';
    return { ok: false, status, errors, candidate: { ...candidate, status } };
  }
  return { ok: true, status: 'accepted', errors: [], candidate: { ...candidate, status: 'accepted' } };
}

function yamlList(items: any[]) {
  if (!items.length) return '[]';
  return `\n${items.map((item) => `  - ${JSON.stringify(String(item))}`).join('\n')}`;
}

function frontmatter(fields: any) {
  const lines = ['---'];
  for (const [key, value] of Object.entries(fields)) {
    if (Array.isArray(value)) lines.push(`${key}:${yamlList(value)}`);
    else if (value && typeof value === 'object') {
      lines.push(`${key}:`);
      for (const [childKey, childValue] of Object.entries(value)) {
        if (Array.isArray(childValue)) {
          lines.push(`  ${childKey}:`);
          for (const item of childValue) lines.push(`    - ${String(item)}`);
        } else {
          lines.push(`  ${childKey}: ${JSON.stringify(childValue)}`);
        }
      }
    } else {
      lines.push(`${key}: ${JSON.stringify(value)}`);
    }
  }
  lines.push('---', '');
  return lines.join('\n');
}

function acceptedCandidates(candidates: any[]) {
  return candidates.filter((candidate) => candidate.status === 'accepted' || candidate.status === undefined);
}

function groupBy(items: any[], keyFn: any) {
  const groups = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return groups;
}

function sourceFor(candidate: any) {
  return candidate.sourceDumpIds?.[0] || 'unknown';
}

function applyProjectPageUpdates(input: any) {
  const projectDir = input.projectDir || process.cwd();
  const now = isoNow(input.now);
  const candidates = acceptedCandidates(input.candidates || []);
  const root = wikiDir(projectDir);
  const written = [];
  fs.mkdirSync(root, { recursive: true });

  const byProject = groupBy(candidates, (candidate: any) => projectSlug(candidate));
  for (const [slug, projectCandidates] of byProject.entries()) {
    const projectId = projectCandidates[0]?.projectId || slug;
    const projectName = projectCandidates[0]?.projectName || projectId;
    const sources = Array.from(new Set(projectCandidates.flatMap((candidate: any) => candidate.sourceDumpIds || [])));
    const status = [...projectCandidates].reverse().find((candidate: any) => candidate.type === 'status_update')?.text ||
      'Curated project page generated from source-backed project updates.';
    const completed = dedupeBy(projectCandidates.filter((candidate: any) => candidate.type === 'completed_item'), (candidate: any) => normalizeLine(candidate.text));
    const completedKeys = new Set(completed.map((candidate: any) => normalizeLine(candidate.text)));
    const next = dedupeBy(projectCandidates.filter((candidate: any) => candidate.type === 'next_action'), (candidate: any) => normalizeLine(candidate.text))
      .filter((candidate: any) => !completedKeys.has(normalizeLine(candidate.text)));
    const blockers = dedupeBy(projectCandidates.filter((candidate: any) => candidate.type === 'blocker'), (candidate: any) => normalizeLine(candidate.text));

    const projectPath = path.join(root, 'projects', `${slug}.md`);
    const lines = [
      frontmatter({
        schema: 'AceProjectPage/v1',
        title: projectName,
        projectId,
        status: 'active',
        updatedAt: now,
        createdAt: now,
        confidence: 'high',
        sources,
        tags: ['project'],
        agentLoad: { roles: ['orchestrator', 'rook', 'king'] },
      }),
      `# ${projectName}`,
      '',
      '## Current status',
      '',
      status,
      '',
      '## Open next actions',
      '',
      ...(next.length ? next.flatMap((candidate: any) => [
        `- [ ] ${candidate.text}`,
        `  source: ${sourceFor(candidate)} - owner: orchestrator - created: ${candidate.createdAt} - status: open`,
      ]) : ['(none)']),
      '',
      '## Recently completed',
      '',
      ...(completed.length ? completed.flatMap((candidate: any) => [
        `- [x] ${candidate.text}`,
        `  source: ${sourceFor(candidate)} - completed: ${candidate.createdAt}`,
      ]) : ['(none)']),
      '',
      '## Active Missions / PRs',
      '',
      '| Kind | ID | Status | Link | Last update |',
      '|---|---|---|---|---|',
      ...missionRows(projectCandidates),
      '',
      '## Blockers',
      '',
      '| Blocker | Source | Next safe step | Status |',
      '|---|---|---|---|',
      ...(blockers.length ? blockers.map((candidate: any) => `| ${escapeCell(candidate.text)} | ${sourceFor(candidate)} | Review source dump and resolve safely. | open |`) : ['| (none) | - | - | - |']),
      '',
      '## Decisions',
      '',
      `See [[../decisions/${slug}-decisions|Decision log]].`,
      '',
      '## Timeline',
      '',
      ...timelineLines(projectCandidates),
      '',
      '## Source notes',
      '',
      ...sources.map((source) => `- ${source}`),
      '',
    ];
    writeText(projectPath, lines.join('\n'));
    written.push(projectPath);

    const decisions = dedupeBy(projectCandidates.filter((candidate: any) => candidate.type === 'decision'), (candidate: any) => normalizeLine(candidate.text));
    const decisionPath = path.join(root, 'decisions', `${slug}-decisions.md`);
    writeText(decisionPath, [
      frontmatter({
        schema: 'AceDecisionLog/v1',
        projectId,
        status: 'canonical',
        updatedAt: now,
        createdAt: now,
        sources,
        tags: ['decisions'],
      }),
      `# ${projectName} decisions`,
      '',
      '## Open decisions',
      '',
      '| Decision | Options | Owner | Due | Source |',
      '|---|---|---|---|---|',
      '| (none) | - | - | - | - |',
      '',
      '## Closed decisions',
      '',
      ...(decisions.length ? decisions.flatMap((candidate: any) => [
        `### ${candidate.createdAt} - ${candidate.text}`,
        '',
        '**Decision:**',
        candidate.text,
        '',
        '**Why:**',
        'Promoted from a source-backed project update.',
        '',
        '**Source:**',
        sourceFor(candidate),
        '',
        '**Revisit if:**',
        'New source-backed evidence contradicts this decision.',
        '',
      ]) : ['(none)', '']),
    ].join('\n'));
    written.push(decisionPath);
  }

  written.push(...writeIndexes(root, byProject, now));
  written.push(...writeTemplates(root, now));
  return { written };
}

function escapeCell(value: any) {
  return cleanText(value).replace(/\|/g, '\\|');
}

function missionRows(candidates: any[]) {
  const rows = [];
  const seen = new Set();
  for (const candidate of candidates) {
    if (candidate.missionId && !seen.has(`mission:${candidate.missionId}`)) {
      seen.add(`mission:${candidate.missionId}`);
      rows.push(`| mission | ${candidate.missionId} | ${candidate.type} | - | ${candidate.createdAt} |`);
    }
    if (candidate.prNumber && !seen.has(`pr:${candidate.prNumber}`)) {
      seen.add(`pr:${candidate.prNumber}`);
      rows.push(`| PR | ${candidate.prNumber} | ${candidate.type} | - | ${candidate.createdAt} |`);
    }
  }
  return rows.length ? rows : ['| (none) | - | - | - | - |'];
}

function timelineLines(candidates: any[]) {
  const byDate = groupBy(candidates, (candidate: any) => String(candidate.createdAt || '').slice(0, 10) || 'undated');
  const lines = [];
  for (const [date, items] of byDate.entries()) {
    lines.push(`### ${date}`);
    for (const candidate of items) lines.push(`- ${candidate.createdAt} - ${candidate.text}. Source: ${sourceFor(candidate)}.`);
    lines.push('');
  }
  return lines.length ? lines : ['(none)'];
}

function writeText(filePath: string, text: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text.endsWith('\n') ? text : `${text}\n`);
}

function writeIndexes(root: string, byProject: Map<string, any[]>, now: string) {
  const written = [];
  const indexDir = path.join(root, '00_index');
  const allCandidates = Array.from(byProject.values()).flat();
  const sources = Array.from(new Set(allCandidates.flatMap((candidate: any) => candidate.sourceDumpIds || [])));
  const pageSources = sources.length ? sources : ['project-wiki-curator'];
  const projectsRows = [];
  for (const [slug, candidates] of byProject.entries()) {
    const nextCount = candidates.filter((candidate: any) => candidate.type === 'next_action').length;
    const blockers = candidates.filter((candidate: any) => candidate.type === 'blocker').length;
    projectsRows.push(`| [[../projects/${slug}|${candidates[0]?.projectName || slug}]] | active | ${nextCount} | ${blockers} | ${now} |`);
  }
  const pages = [
    ['README.md', ['# Project wiki', '', 'Curated durable project organization. Dumps are not truth; canonical pages are produced by nightly curation.', '']],
    ['PROJECTS.md', ['# Projects', '', '| Project | Status | Open next actions | Blockers | Updated |', '|---|---|---:|---:|---|', ...(projectsRows.length ? projectsRows : ['| (none) | - | 0 | 0 | - |']), '']],
    ['NEXT_ACTIONS.md', ['# Next actions', '', '## Critical', '', '## This week', '', ...allCandidates.filter((candidate: any) => candidate.type === 'next_action').map((candidate: any) => `- [ ] ${candidate.text}  \n  source: ${sourceFor(candidate)}`), '', '## Backlog', '', '## Waiting / blocked', '', ...allCandidates.filter((candidate: any) => candidate.type === 'blocker').map((candidate: any) => `- ${candidate.text}  \n  source: ${sourceFor(candidate)}`), '']],
    ['RECENT_CHANGES.md', ['# Recent changes', '', `## ${now.slice(0, 10)}`, '', ...allCandidates.map((candidate: any) => `- ${candidate.createdAt} - ${candidate.projectName || candidate.projectId} - ${candidate.text} - source: ${sourceFor(candidate)}`), '']],
    ['nightly-curation-report.md', ['# Nightly curation report', '', 'Run `ace wiki nightly` to refresh this report.', '']],
  ];
  for (const [name, body] of pages) {
    const filePath = path.join(indexDir, name);
    writeText(filePath, [
      frontmatter({
        schema: 'AceWikiIndex/v1',
        title: String(name).replace(/\.md$/, ''),
        status: 'canonical',
        updatedAt: now,
        createdAt: now,
        sources: pageSources,
        confidence: 'high',
        tags: ['project-wiki', 'index'],
        agentLoad: { roles: ['orchestrator', 'worker', 'validator', 'rook', 'king'] },
      }),
      ...body,
    ].join('\n'));
    written.push(filePath);
  }
  return written;
}

function writeTemplates(root: string, now: string) {
  const templates = [
    ['templates/project-page.md', 'AceProjectPage/v1 project page template.'],
    ['templates/decision-log.md', 'AceDecisionLog/v1 decision log template.'],
  ];
  const written = [];
  for (const [rel, title] of templates) {
    const filePath = path.join(root, rel);
    if (fs.existsSync(filePath)) continue;
    writeText(filePath, [
      frontmatter({
        schema: 'AceWikiTemplate/v1',
        title,
        status: 'canonical',
        updatedAt: now,
        createdAt: now,
        sources: ['project-wiki-curator-template'],
        confidence: 'high',
        tags: ['template'],
        agentLoad: { roles: [] },
      }),
      `# ${title}`,
      '',
      'Use this as a curation template only. Agents must not write canonical pages directly.',
      '',
    ].join('\n'));
    written.push(filePath);
  }
  return written;
}

function pageHasFrontmatter(text: string) {
  return text.startsWith('---\n') && text.indexOf('\n---', 4) > 0;
}

function frontmatterBlock(text: string) {
  if (!pageHasFrontmatter(text)) return '';
  return text.slice(4, text.indexOf('\n---', 4));
}

function hasSources(text: string) {
  const fm = frontmatterBlock(text);
  return /sources:\s*\n\s*-\s+/m.test(fm) || /sources:\s*\[[^\]]+\]/m.test(fm);
}

function markdownFiles(root: string) {
  if (!fs.existsSync(root)) return [];
  const files = [];
  for (const filePath of walkFiles(root)) {
    if (filePath.endsWith('.md')) files.push(filePath);
  }
  return files;
}

function walkFiles(root: string) {
  const out: string[] = [];
  for (const name of fs.readdirSync(root)) {
    const child = path.join(root, name);
    const stat = fs.statSync(child);
    if (stat.isDirectory()) out.push(...walkFiles(child));
    else out.push(child);
  }
  return out;
}

function auditProjectWiki(input: any = {}) {
  const projectDir = input.projectDir || process.cwd();
  const root = wikiDir(projectDir);
  const errors = [];
  const checked = [];
  for (const filePath of markdownFiles(root)) {
    const rel = path.relative(root, filePath);
    if (rel.startsWith(`deprecated${path.sep}`)) continue;
    const text = fs.readFileSync(filePath, 'utf8');
    checked.push(rel);
    if (!pageHasFrontmatter(text)) errors.push(`${rel}: missing frontmatter`);
    if (!hasSources(text)) errors.push(`${rel}: missing sources`);
    for (const reason of contaminationReasons(text)) errors.push(`${rel}: ${reason}`);
    if (secretHits(text).length > 0) errors.push(`${rel}: secret-like-content`);
    if (/^- \[ \] .+\n(?!\s*source:)/m.test(text)) errors.push(`${rel}: unchecked next action without source`);
    if (/^### .+\n(?![\s\S]{0,240}\*\*Source:\*\*)/m.test(text) && rel.startsWith('decisions/')) {
      errors.push(`${rel}: decision entry without source`);
    }
    for (const link of obsidianLinks(text)) {
      const target = path.resolve(path.dirname(filePath), `${link}.md`);
      if (!target.startsWith(root) || !fs.existsSync(target)) errors.push(`${rel}: broken link ${link}`);
    }
  }
  for (const filePath of walkJsonFiles(path.join(root, '00_index'))) {
    if (!path.basename(filePath).startsWith('agent-pack-')) continue;
    const pack = readJson(filePath);
    for (const page of pack.pages || []) {
      if (forbiddenPackPath(page)) errors.push(`${path.relative(root, filePath)}: forbidden pack page ${page}`);
      const pagePath = path.join(root, page);
      if (!fs.existsSync(pagePath)) errors.push(`${path.relative(root, filePath)}: missing pack page ${page}`);
      else if (!pageHasFrontmatter(fs.readFileSync(pagePath, 'utf8'))) errors.push(`${path.relative(root, filePath)}: non-canonical pack page ${page}`);
    }
  }
  return { ok: errors.length === 0, errors, checked };
}

function obsidianLinks(text: string) {
  const links = [];
  const rx = /\[\[([^|\]]+)(?:\|[^\]]+)?\]\]/g;
  let match;
  while ((match = rx.exec(text))) links.push(match[1]);
  return links;
}

function forbiddenPackPath(page: string) {
  return /(^|\/)(wiki-dump|ace-dump|dump|quarantine|diagnostic|deprecated|inbox)(\/|$)/.test(page);
}

function canonicalPage(projectDir: string, rel: string) {
  if (forbiddenPackPath(rel)) return false;
  const filePath = path.join(wikiDir(projectDir), rel);
  return fs.existsSync(filePath) && pageHasFrontmatter(fs.readFileSync(filePath, 'utf8'));
}

function buildAgentPack(input: any = {}) {
  const projectDir = input.projectDir || process.cwd();
  const role = cleanText(input.role) || 'orchestrator';
  const projectId = cleanText(input.projectId || input.project) || '';
  const root = wikiDir(projectDir);
  const projectPages = markdownFiles(path.join(root, 'projects'));
  const slug = projectId ? findProjectSlugById(projectPages, projectId) || slugify(projectId) : (projectPages[0] ? path.basename(projectPages[0], '.md') : 'project');
  const candidates = role === 'worker'
    ? [`projects/${slug}.md`, '00_index/NEXT_ACTIONS.md']
    : role === 'validator'
      ? [`projects/${slug}.md`, `decisions/${slug}-decisions.md`, '00_index/NEXT_ACTIONS.md', 'runbooks/validator-merger.md']
      : [`projects/${slug}.md`, `decisions/${slug}-decisions.md`, '00_index/NEXT_ACTIONS.md', 'runbooks/mission-lifecycle.md'];
  const pages = candidates.filter((page) => canonicalPage(projectDir, page));
  const pack = {
    schema: PACK_SCHEMA,
    role,
    projectId: projectId || slug,
    pages,
    forbidden: ['ace-dump/**', 'wiki-dump/**', 'inbox/**', 'quarantine/**', 'diagnostic/**', 'deprecated/**'],
    summary: 'Use these pages only as canonical durable project context.',
  };
  const target = path.join(root, '00_index', `agent-pack-${role}.json`);
  writeJson(target, pack);
  return { path: target, pack };
}

// Rebuild a role pack only when missing or stale. Used at task dispatch so
// every spawned agent gets a fresh-enough pack without paying a rebuild on
// every spawn. Fail-safe: any error returns null (dispatch never blocks on
// pack freshness).
function ensureFreshAgentPack(input: any = {}) {
  const projectDir = input.projectDir || process.cwd();
  const role = cleanText(input.role) || 'worker';
  const maxAgeMs = Number.isFinite(Number(input.maxAgeMs)) ? Number(input.maxAgeMs) : 6 * 60 * 60 * 1000;
  const target = path.join(wikiDir(projectDir), '00_index', `agent-pack-${role}.json`);
  try {
    const stat = fs.statSync(target);
    if (Date.now() - stat.mtimeMs <= maxAgeMs) return { path: target, rebuilt: false };
  } catch { /* missing → rebuild */ }
  try {
    const built = buildAgentPack({ projectDir, role, projectId: input.projectId });
    return { path: built.path, rebuilt: true };
  } catch {
    return null;
  }
}

function findProjectSlugById(projectPages: string[], projectId: string) {
  for (const filePath of projectPages) {
    const text = fs.readFileSync(filePath, 'utf8');
    const fm = frontmatterBlock(text);
    if (fm.includes(`projectId: ${JSON.stringify(projectId)}`) || fm.includes(`projectId: ${projectId}`)) {
      return path.basename(filePath, '.md');
    }
  }
  return null;
}

function runNightlyProjectWikiCuration(input: any = {}) {
  const projectDir = input.projectDir || process.cwd();
  const now = isoNow(input.now);
  const records = collectDumpRecords({ projectDir, identity: input.identity === 'all' ? '' : input.identity });
  const candidates = extractProjectUpdateCandidates(records);
  const describeCommands = input.describeCommands || [];
  const validations = candidates.map((candidate: any) => validateCandidate(candidate, { projectDir, describeCommands }));
  const accepted = dedupeBy(validations.filter((result: any) => result.ok).map((result: any) => result.candidate), (candidate: any) => `${candidate.type}:${normalizeLine(candidate.text)}:${candidate.targetPage}`);
  const rejected = validations.filter((result: any) => !result.ok && result.status === 'rejected').map((result: any) => result.candidate);
  const conflicted = validations.filter((result: any) => !result.ok && result.status === 'conflicted').map((result: any) => result.candidate);
  const applied = applyProjectPageUpdates({ projectDir, candidates: accepted, now });
  const packs = ['orchestrator', 'worker', 'validator', 'rook', 'king'].map((role) => buildAgentPack({ projectDir, role }));
  const audit = auditProjectWiki({ projectDir });
  const reportPath = path.join(wikiDir(projectDir), '00_index', 'nightly-curation-report.md');
  writeText(reportPath, [
    frontmatter({
      schema: 'AceNightlyCurationReport/v1',
      title: 'nightly-curation-report',
      status: 'canonical',
      updatedAt: now,
      createdAt: now,
      sources: records.length ? records.map((record: any) => record.id) : ['project-wiki-curator'],
      confidence: 'high',
      tags: ['project-wiki', 'nightly'],
      agentLoad: { roles: ['orchestrator', 'rook', 'king'] },
    }),
    '# Nightly curation report',
    '',
    `- dumps read: ${records.length}`,
    `- candidates extracted: ${candidates.length}`,
    `- candidates accepted: ${accepted.length}`,
    `- candidates rejected: ${rejected.length}`,
    `- candidates quarantined: ${collectDumpRecords({ projectDir, includeQuarantine: true }).filter((record: any) => record.status === 'quarantined').length}`,
    `- conflicts found: ${conflicted.length}`,
    `- project pages updated: ${applied.written.filter((filePath: string) => filePath.includes(`${path.sep}projects${path.sep}`)).length}`,
    `- agent packs rebuilt: ${packs.length}`,
    `- audit result: ${audit.ok ? 'PASS' : 'FAIL'}`,
    '',
    ...audit.errors.map((error: string) => `- audit: ${error}`),
    ...conflicted.map((candidate: any) => `- conflict: ${candidate.text}`),
    '',
  ].join('\n'));
  return {
    reportPath,
    dumpsRead: records.length,
    candidatesExtracted: candidates.length,
    candidatesAccepted: accepted.length,
    candidatesRejected: rejected.length,
    candidatesConflicted: conflicted.length,
    projectPagesUpdated: applied.written,
    agentPacksRebuilt: packs.map((item) => item.path),
    audit,
  };
}

// ---------------------------------------------------------------------------
// OKF skeleton bootstrap + dump-only backfill
//
// The dump-only-no-canon defect: a project can accumulate `.ace/wiki-dump/`
// records yet never bootstrap `.ace/wiki/`, so raw dumps are searchable but
// canonical pages never exist. These helpers create the OKF skeleton (index.md,
// log.md, 00_index/) and backfill canon from existing dumps, idempotently.
// ---------------------------------------------------------------------------

/** True when the wiki has at least one canonical (frontmatter) page. */
function hasCanon(projectDir: any) {
  const root = wikiDir(projectDir);
  for (const filePath of markdownFiles(root)) {
    const rel = path.relative(root, filePath).split(path.sep).join('/');
    if (/^(templates|deprecated)\//.test(rel)) continue;
    try { if (pageHasFrontmatter(fs.readFileSync(filePath, 'utf8'))) return true; } catch { /* unreadable → skip */ }
  }
  return false;
}

/** Dump-only = has dump records (incl. quarantined) but no canon pages. */
function isDumpOnly(projectDir: any) {
  const dumps = collectDumpRecords({ projectDir, includeQuarantine: true });
  return dumps.length > 0 && !hasCanon(projectDir);
}

/** Write the OKF skeleton (index.md, log.md, 00_index/) if missing. Idempotent. */
function bootstrapWikiSkeleton(input: any = {}) {
  const projectDir = input.projectDir || process.cwd();
  const now = isoNow(input.now);
  const root = wikiDir(projectDir);
  const projectId = cleanText(input.projectId || input.workspaceId) || slugify(path.basename(path.resolve(String(projectDir))));
  const projectName = cleanText(input.projectName) || projectId;
  const written: string[] = [];
  fs.mkdirSync(path.join(root, '00_index'), { recursive: true });

  const indexPath = path.join(root, 'index.md');
  if (!fs.existsSync(indexPath)) {
    writeText(indexPath, [
      frontmatter({
        schema: 'AceWikiIndex/v1', title: `${projectName} wiki`, projectId,
        status: 'canonical', updatedAt: now, createdAt: now, sources: ['wiki-bootstrap'],
        confidence: 'high', tags: ['project-wiki', 'index'],
        agentLoad: { roles: ['orchestrator', 'worker', 'validator', 'rook', 'king'] },
      }),
      `# ${projectName} wiki`, '',
      'OKF-style Markdown canon for this project. Markdown is the source of truth; the',
      'search index and any external memory store are disposable, rebuildable helpers.', '',
      '## Map', '',
      '- [[00_index/PROJECTS|Projects]]',
      '- [[00_index/NEXT_ACTIONS|Next actions]]',
      '- [[00_index/RECENT_CHANGES|Recent changes]]',
      '- [[log|Curation log]]', '',
      '## Provenance', '',
      'Pages are promoted from sourced KnowledgeEvents/dumps by the nightly curator.',
      'Raw dumps under `.ace/wiki-dump/` are evidence, not canon.', '',
    ].join('\n'));
    written.push(indexPath);
  }

  const logPath = path.join(root, 'log.md');
  if (!fs.existsSync(logPath)) {
    writeText(logPath, [
      frontmatter({
        schema: 'AceWikiLog/v1', title: `${projectName} log`, projectId,
        status: 'canonical', updatedAt: now, createdAt: now, sources: ['wiki-bootstrap'],
        confidence: 'high', tags: ['project-wiki', 'journal'],
      }),
      `# ${projectName} log`, '',
      'Append-only curation log. Each entry cites its source event/dump.', '',
      `## ${now.slice(0, 10)}`, '',
      `- ${now} - wiki bootstrapped (OKF skeleton). Source: wiki-bootstrap.`, '',
    ].join('\n'));
    written.push(logPath);
  }
  return { root, written, created: written.length > 0 };
}

/**
 * Bootstrap the OKF skeleton then promote existing dumps into canon. Idempotent:
 * re-running creates no new skeleton and rewrites the same deterministic pages.
 * This is both the create/import bootstrap and the dump-only backfill path.
 */
function backfillProject(input: any = {}) {
  const projectDir = input.projectDir || process.cwd();
  const now = isoNow(input.now);
  const before = { dumpOnly: isDumpOnly(projectDir), hasCanon: hasCanon(projectDir) };
  const skeleton = bootstrapWikiSkeleton({
    projectDir, projectId: input.projectId, projectName: input.projectName, now,
  });
  const curation = runNightlyProjectWikiCuration({
    projectDir, identity: input.identity || 'all', describeCommands: input.describeCommands, now,
  });
  return {
    schema: 'AceWikiBackfill/v1',
    projectDir,
    before,
    skeletonCreated: skeleton.created,
    skeletonWritten: skeleton.written,
    curation: {
      dumpsRead: curation.dumpsRead,
      candidatesAccepted: curation.candidatesAccepted,
      projectPagesUpdated: curation.projectPagesUpdated,
      reportPath: curation.reportPath,
      audit: curation.audit,
    },
    after: { dumpOnly: isDumpOnly(projectDir), hasCanon: hasCanon(projectDir) },
  };
}

module.exports = {
  writeDumpRecord,
  collectDumpRecords,
  extractProjectUpdateCandidates,
  validateCandidate,
  applyProjectPageUpdates,
  buildAgentPack,
  ensureFreshAgentPack,
  auditProjectWiki,
  runNightlyProjectWikiCuration,
  hasCanon,
  isDumpOnly,
  bootstrapWikiSkeleton,
  backfillProject,
  wikiDir,
  dumpDir,
  _internal: {
    DUMP_SCHEMA,
    CANDIDATE_SCHEMA,
    PACK_SCHEMA,
    slugify,
    contaminationReasons,
    secretHits,
  },
};
