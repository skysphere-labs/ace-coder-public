const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Guard against rename drift. The CLI was renamed ace-tui -> ace
// (commit 9af0ac0); there is NO ace-tui binary on PATH. Seeded doctrine
// skills are packaged into the app and read by rook/king at runtime, so a
// stale `ace-tui` token points agents at a binary that does not exist.
// Likewise, ace-wiki-manager was consolidated into ace-github-flow and
// no longer exists on disk, in the seed, or in the catalog. These assertions
// convert future drift into a CI failure instead of a silent runtime break.

const SKILLS_ROOT = path.join(__dirname, '..', 'assets', 'skills');
const STALE_CLI_TOKEN = 'ace-tui';
const DANGLING_SKILL = 'ace-wiki-manager';

// Word-boundary-aware check: only flag the exact token `ace-tui`, not a
// longer hyphenated id that merely contains it as a prefix. (No such id exists
// today, but matching on the bare token keeps the guard from false-positiving
// if a future skill is named with a `ace-tui...` prefix.)
function containsStaleCliToken(text) {
  // `-` is a word char for our purposes, so we cannot rely on \b. Match the
  // token only when it is NOT immediately followed by another id character
  // ([A-Za-z0-9-]) and NOT immediately preceded by one.
  const re = /(^|[^A-Za-z0-9-])ace-tui(?![A-Za-z0-9-])/;
  return re.test(text);
}

function collectSkillFiles(dir) {
  const found = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...collectSkillFiles(full));
    } else if (entry.isFile() && entry.name === 'SKILL.md') {
      found.push(full);
    }
  }
  return found;
}

test('no seeded SKILL.md references the removed ace-tui binary', () => {
  const skillFiles = collectSkillFiles(SKILLS_ROOT);
  assert.ok(skillFiles.length > 0, 'expected to find seeded SKILL.md files');

  const offenders = [];
  for (const file of skillFiles) {
    const body = fs.readFileSync(file, 'utf8');
    if (containsStaleCliToken(body)) {
      offenders.push(path.relative(SKILLS_ROOT, file));
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `stale '${STALE_CLI_TOKEN}' token found in seeded doctrine (CLI is now 'ace'): ${offenders.join(', ')}`
  );
});

test('wake-brief.cts does not reference the removed ace-wiki-manager skill', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'wake-brief.cts'), 'utf8');
  assert.ok(
    !source.includes(DANGLING_SKILL),
    `wake-brief.cts points agents at '${DANGLING_SKILL}', which no longer exists (consolidated into ace-github-flow)`
  );
});

test('seeded SKILL.md descriptions with YAML mapping separators are quoted', () => {
  const skillFiles = collectSkillFiles(SKILLS_ROOT);
  assert.ok(skillFiles.length > 0, 'expected to find seeded SKILL.md files');

  const offenders = [];
  for (const file of skillFiles) {
    const body = fs.readFileSync(file, 'utf8');
    const frontmatter = body.match(/^---\n([\s\S]*?)\n---/);
    if (!frontmatter) continue;
    const description = frontmatter[1].split('\n').find((line) => line.startsWith('description: '));
    if (description && /^description: [^"'][^#\n]*: /.test(description)) {
      offenders.push(path.relative(SKILLS_ROOT, file));
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `unquoted YAML description values containing ': ' break strict skill parsers: ${offenders.join(', ')}`
  );
});
