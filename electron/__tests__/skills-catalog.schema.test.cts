import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import nodeTest from 'node:test';

import skillsCatalog from '../skills-catalog.json';

const testDir = path.dirname(__filename);

const VALID_PROVENANCE = new Set(['bundled', 'external', 'reference-only']);
const VALID_AGENT_COMPATIBILITY = new Set(['shared', 'claude-only', 'codex-only']);

function entry(id) {
  return skillsCatalog.skills.find((skill) => skill.id === id);
}

function registerTests(test) {
  test('skills catalog entries declare provenance and agent compatibility', () => {
    for (const skill of skillsCatalog.skills) {
      assert.equal(VALID_PROVENANCE.has(skill.provenance), true, `${skill.id} has valid provenance`);
      assert.equal(
        VALID_AGENT_COMPATIBILITY.has(skill.agentCompatibility),
        true,
        `${skill.id} has valid agentCompatibility`
      );
    }
  });

  test('bundled skills resolve to real bundled paths', () => {
    for (const skill of skillsCatalog.skills) {
      if (skill.provenance !== 'bundled') continue;
      assert.ok(skill.bundledPath, `${skill.id} has bundledPath`);
      assert.equal(
        fs.existsSync(path.join(testDir, '..', skill.bundledPath)),
        true,
        `${skill.id} bundledPath exists`
      );
    }
  });

  test('external and reference-only skills do not declare bundled paths', () => {
    for (const skill of skillsCatalog.skills) {
      if (skill.provenance === 'bundled') continue;
      assert.equal(skill.bundledPath, undefined, `${skill.id} has no bundledPath`);
    }
  });

  test('curated external-skill batch entries ingest with expected metadata', () => {
    const knip = entry('knip-maintenance');
    assert.ok(knip, 'knip-maintenance exists');
    assert.equal(knip.provenance, 'bundled');
    assert.equal(knip.agentCompatibility, 'shared');
    assert.equal(knip.bundledPath, 'assets/skills/knip-maintenance/SKILL.md');

    const trailofbits = entry('trailofbits-security-review');
    assert.ok(trailofbits, 'trailofbits-security-review exists');
    assert.equal(trailofbits.provenance, 'external');
    assert.equal(trailofbits.agentCompatibility, 'shared');
    assert.equal(trailofbits.bundledPath, undefined);
    assert.match(trailofbits.description, /github\.com\/trailofbits\/skills/);
    assert.match(trailofbits.description, /~\/\.claude\/skills\//);
    assert.match(trailofbits.description, /~\/\.codex\/skills\//);

    const design = entry('anthropics-frontend-design');
    assert.ok(design, 'anthropics-frontend-design exists');
    assert.equal(design.provenance, 'external');
    assert.equal(design.agentCompatibility, 'shared');
    assert.equal(design.kind, 'reference');
    assert.equal(design.bundledPath, undefined);
    assert.equal(
      design.sourceUrl,
      'https://github.com/anthropics/skills/tree/main/skills/frontend-design'
    );
  });
}

registerTests(process.env.VITEST ? require('@vitest/runner').test : nodeTest);
