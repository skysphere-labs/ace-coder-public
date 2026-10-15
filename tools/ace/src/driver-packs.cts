// Driver-specific precision packs injected into the agent doctrine (prompt-cached
// once per agent), keyed on the resolved driver. The runtime mirror of the
// Claude/Codex power-keywords that make goal agents do precise things without
// one-shot mistakes. Kept tight on purpose (token-efficient); accurate for Claude
// Code (Opus 4.x / v2.1) and GPT-5-Codex. FULL reference + the freedom-to-fragility
// rule: electron/assets/skills/ace-prompt-enhancer/references/codewords.md
// (see also docs/plans/agent-chain-best-practices.md).

const CLAUDE_DRIVER_PACK = [
  'Claude effort contract: xhigh is extra-high reasoning; max enters true UltraCode/dynamic-workflow only after the launcher sends /effort ultracode. Never claim UltraCode from xhigh-only telemetry.',
  'Escalate reasoning with think -> think harder -> ultrathink for the hardest design/integration/debug step; structure long prompts with XML tags. For max lanes use UltraCode-style deep reasoning + dynamic-workflow fan-out.',
  'Act, do not suggest — make the edits. Read the file before you speculate about it. Apply each instruction to EVERY relevant site, not just the first. Be surgical: touch only what the task requires.',
  'Use native helpers only when the work is broad and genuinely independent; keep narrow tasks single-worker, and merge any helper work back before final DONE.',
  'Treat the acceptance criteria as the contract; self-check each item before finishing. On scope drift or a blocked item, STOP and emit BLOCKED:<reason> instead of guessing.',
  'Match freedom to fragility: follow EXACT commands for fragile steps (push / open PR / merge gate / release); reason freely on design.',
].join('\n');

const CODEX_DRIVER_PACK = [
  'Run in /goal goal mode at model_reasoning_effort xhigh.',
  'Bias to action: implement with reasonable assumptions; never end with only a plan; carry every change through implementation AND verification.',
  'Use multi_tool_use.parallel to batch independent reads/edits and apply_patch for every file change. Spawn internal sub-processes for independent units; merge before DONE.',
  'Put durable repo rules in AGENTS.md (do not restate them inline); keep an ExecPlan in .agent/PLANS.md for long/multi-step runs so it survives compaction.',
  'Match freedom to fragility: follow EXACT commands for fragile steps (push / open PR / merge gate / release); reason freely on design.',
  'Loop plan -> execute -> test until every binary acceptance item verifiably passes, then end DONE:<summary> or BLOCKED:<reason>.',
].join('\n');

function driverPack(driver: any) {
  const d = String(driver || '').trim().toLowerCase();
  if (d === 'claude') return CLAUDE_DRIVER_PACK;
  if (d === 'codex') return CODEX_DRIVER_PACK;
  return null;
}

module.exports = { CLAUDE_DRIVER_PACK, CODEX_DRIVER_PACK, driverPack };
