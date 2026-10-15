const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  listCustomAgents,
  getCustomAgent,
  generateAgentDoctrine,
  MANAGED_BEGIN,
  MANAGED_END,
} = require('../custom-agents.cts');

function tmpWorktree() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ace-custom-agent-'));
}

test('registry exposes the expected roles', () => {
  const roles = listCustomAgents();
  for (const r of ['engineer', 'backend', 'ui-designer', 'security', 'architect', 'reviewer', 'research-grill']) {
    assert.ok(roles.includes(r), `${r} should be a custom agent`);
    assert.ok(getCustomAgent(r).skills.length > 0, `${r} has a skill pack`);
  }
});

test('claude agent writes .claude/agents/<role>.md with frontmatter + skills + driver keywords', () => {
  const wt = tmpWorktree();
  try {
    const r = generateAgentDoctrine(wt, 'engineer', 'claude');
    assert.equal(r.ok, true);
    const body = fs.readFileSync(path.join(wt, '.claude', 'agents', 'engineer.md'), 'utf8');
    assert.match(body, /^---\nname: engineer/);
    assert.match(body, /skills: \[ace-agent-pack-engineer/);
    assert.match(body, /UltraCode\/dynamic-workflow/); // claude driver pack
    assert.match(body, /Never claim UltraCode from xhigh-only telemetry/);
    assert.match(body, /DONE: <summary>/);
  } finally {
    fs.rmSync(wt, { recursive: true, force: true });
  }
});

test('codex agent writes .codex/agents/<role>.toml + AGENTS.md managed block, never clobbering existing AGENTS.md', () => {
  const wt = tmpWorktree();
  try {
    fs.writeFileSync(path.join(wt, 'AGENTS.md'), '# My repo rules\nDo not break the build.\n');
    const r = generateAgentDoctrine(wt, 'backend', 'codex');
    assert.equal(r.ok, true);
    const toml = fs.readFileSync(path.join(wt, '.codex', 'agents', 'backend.toml'), 'utf8');
    assert.doesNotMatch(toml, /^\[agent\]/m);
    assert.match(toml, /name = "backend"/);
    assert.match(toml, /model_reasoning_effort = "xhigh"/);
    assert.match(toml, /\/goal goal mode/); // codex driver pack
    const agents = fs.readFileSync(path.join(wt, 'AGENTS.md'), 'utf8');
    assert.match(agents, /# My repo rules/); // preserved
    assert.ok(agents.includes(MANAGED_BEGIN) && agents.includes(MANAGED_END));
    assert.match(agents, /Ace agent: backend/);
  } finally {
    fs.rmSync(wt, { recursive: true, force: true });
  }
});

test('regenerating replaces the managed block in place (idempotent, no duplication)', () => {
  const wt = tmpWorktree();
  try {
    fs.writeFileSync(path.join(wt, 'AGENTS.md'), '# Keep me\n');
    generateAgentDoctrine(wt, 'backend', 'codex');
    generateAgentDoctrine(wt, 'security', 'codex');
    const agents = fs.readFileSync(path.join(wt, 'AGENTS.md'), 'utf8');
    assert.match(agents, /# Keep me/);
    assert.equal((agents.match(new RegExp(MANAGED_BEGIN, 'g')) || []).length, 1, 'exactly one managed block');
    assert.match(agents, /Ace agent: security/);
  } finally {
    fs.rmSync(wt, { recursive: true, force: true });
  }
});

test('unknown role returns ok:false without writing', () => {
  const wt = tmpWorktree();
  try {
    const r = generateAgentDoctrine(wt, 'not-a-role', 'claude');
    assert.equal(r.ok, false);
  } finally {
    fs.rmSync(wt, { recursive: true, force: true });
  }
});
