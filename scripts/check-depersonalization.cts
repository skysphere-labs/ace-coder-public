// scripts/check-depersonalization.cts — de-personalization regression gate.
//
// Scans src/, electron/, tools/, and scripts/ for personalization tokens
// (the pre-operator hardcoded identities, the owner's username, the owner's
// external volume) and for mic/voice regrowth tokens (the voice stack was
// fully removed; nothing may quietly reintroduce microphone access).
//
// Run: npx tsx scripts/check-depersonalization.cts   (exits non-zero on any
// violation outside the justified allowlist below). Wired into `npm test`
// as test:depersonalization.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const SCAN_DIRS = ['src', 'electron', 'tools', 'scripts'];

// Personalization tokens: legacy operator identities as standalone words,
// the owner's username, and the owner's external data volume.
const PERSONALIZATION = /\brook\b|\bking\b|\/Volumes\/Storage/i;
// Mic regrowth tokens: the voice/dictation stack was removed by this batch;
// any of these reappearing means microphone features are growing back.
const MIC_REGROWTH = /NSMicrophoneUsageDescription|getUserMedia|moonshine/i;

type AllowEntry = { path: string; reason: string };

// Every entry must carry a one-line justification. Directory entries end
// with '/'. Never add an entry to dodge real hardcoding — fixtures,
// migration seams, and explicitly owner-directed surfaces only.
const ALLOWLIST: AllowEntry[] = [
  // — specced allowlist —
  // self: this gate defines the patterns it scans for.
  { path: 'scripts/check-depersonalization.cts', reason: 'self (pattern definitions)' },
  // LEGACY_KING_PERSONA constant + migration detection strings (sanctioned home).
  { path: 'electron/operators.cts', reason: 'LEGACY_KING_PERSONA + migration detection strings' },
  // owner-layout migration fixtures proving the rook/king migration.
  { path: 'electron/__tests__/operators.test.cts', reason: 'migration fixtures (owner layout)' },
  // pins the migrated King persona source.
  { path: 'electron/__tests__/king-soul-source.test.cts', reason: 'migration fixtures (King persona)' },
  // historical transcript-linking fixtures.
  { path: 'electron/ace-control/__tests__/transcript/linker.test.cts', reason: 'historical fixtures' },
  // GOLDEN test — pins the missions module identity defaults; unmodifiable.
  { path: 'electron/__tests__/mission-context.test.cts', reason: 'golden historical fixtures (pins missions identity defaults)' },
  // OWNER DIRECTIVE (2026-06-05): the Operations tab keeps intentional
  // Rook/King references and de-personalizes only on the owner's schedule.
  { path: 'src/components/operations/', reason: 'owner directive: Operations tab (intentional)' },
  { path: 'electron/ops-status.cts', reason: 'owner directive: Operations tab (intentional)' },
  { path: 'electron/wiki-updater.cts', reason: 'owner directive: Operations tab (intentional)' },

  // — byte-identity / persistence test fixtures (this batch's own guarantees) —
  // proves migrated owner profiles still yield lane-rook/Rook + lane-king/King.
  { path: 'electron/__tests__/agent-lanes.test.cts', reason: 'byte-identity migration fixtures (owner lane ids)' },
  // proves an owner-shaped operators config renders the legacy wake copy.
  { path: 'electron/__tests__/wake-brief.test.cts', reason: 'byte-identity fixtures (owner wake copy)' },

  // — run-ledger spine telemetry fixtures (example agent/driver ids) —
  // The spine keys lifecycle cards by the agent's self-reported telemetry; these
  // tests use 'rook'/'king' purely as example agent/driver ids (test fixtures,
  // not shipped behavior — the spine source itself is depersonalized).
  { path: 'electron/run-ledger/__tests__/drivers.test.cts', reason: 'spine telemetry fixtures (example agent/driver ids)' },
  { path: 'electron/run-ledger/__tests__/harness.test.cts', reason: 'spine telemetry fixtures (example agent/driver ids)' },
  { path: 'electron/run-ledger/__tests__/pulse-wiring.test.cts', reason: 'spine telemetry fixtures (example agent/driver ids)' },
  { path: 'electron/run-ledger/__tests__/telemetry.test.cts', reason: 'spine telemetry fixtures (example agent/driver ids)' },

  // — golden-pinned module defaults + migration seams in runtime code —
  // module-default identity config pinned by the golden mission-context test;
  // runtime values are injected from operators.json via setMissionIdentityConfig.
  { path: 'electron/missions.cts', reason: 'module defaults pinned by golden mission-context.test.cts; runtime injected from operators config' },
  // legacy-stream suppression regexes + pre-operator row migration detection
  // (single-writer file; matching historical on-disk/on-screen artifacts).
  { path: 'electron/local-core.cts', reason: 'legacy-stream suppression + pre-operator row migration detection' },
  // fixtures exercising the migration seams above.
  { path: 'electron/__tests__/local-core.test.cts', reason: 'historical fixtures (migration seams)' },
  // legacy owner auth-dir splice retained for migration compatibility.
  { path: 'electron/hermes-home.cts', reason: 'legacy auth-dir migration compatibility (follow-up: make config-only)' },
  { path: 'electron/__tests__/hermes-home.test.cts', reason: 'fixtures for the legacy auth-dir compatibility' },
  // legacy profile-ordering fallback retained for migration compatibility.
  { path: 'electron/hermes-profiles.cts', reason: 'legacy profile fallback for migration compatibility (follow-up: make config-only)' },
  { path: 'electron/__tests__/hermes-profiles.test.cts', reason: 'fixtures for the legacy profile fallback' },

  // — Operations cockpit cluster (same owner directive surface as ops-status) —
  { path: 'electron/ops-brief-scheduler.cts', reason: 'owner ops cockpit: Rook brief copy (owner directive)' },
  { path: 'electron/__tests__/ops-brief-scheduler.test.cts', reason: 'owner ops cockpit fixtures' },
  { path: 'electron/vector-ops-adapter.cts', reason: 'owner ops cockpit: default signal owner (owner directive)' },
  { path: 'electron/__tests__/vector-ops-adapter.test.cts', reason: 'owner ops cockpit fixtures' },
  { path: 'electron/__tests__/ops-todos.test.cts', reason: 'owner ops cockpit fixtures' },
  // ops cockpit wiring comments in single-writer IPC files (off-limits files).
  { path: 'electron/main.cts', reason: 'ops cockpit wiring comments (single-writer file)' },
  { path: 'src/lib/ace-api.ts', reason: 'ops cockpit bridge comments (single-writer file)' },

  // — historical comments/doc text in non-owned source (no behavior) —
  { path: 'electron/skills-catalog.json', reason: 'bundled skill catalog descriptions (owner doctrine text)' },
  { path: 'electron/ace-control/index.cts', reason: 'historical comment (owner-lane session semantics)' },
  { path: 'electron/ace-control/transcript/index.cts', reason: 'historical comment (owner-lane session semantics)' },
  { path: 'electron/ace-control/transcript/linker.cts', reason: 'historical comments (owner-lane session semantics)' },
  { path: 'electron/__tests__/skills-doctrine.test.cts', reason: 'comment naming runtime skill consumers' },
  { path: 'electron/__tests__/doctrine-seeding.test.cts', reason: 'asserts ABSENCE of legacy identities (regex literal matches itself)' },
  { path: 'electron/__tests__/external-data-root.test.cts', reason: 'historical comment in fixture' },
  { path: 'electron/ace-control/__tests__/controller.test.cts', reason: 'historical stream fixtures' },
  { path: 'electron/ace-control/__tests__/transcript/session-link-persistence.test.cts', reason: 'historical transcript fixtures' },
  { path: 'src/index.css', reason: 'historical comment (token pill provenance)' },
  { path: 'src/runtime/terminal-registry.ts', reason: 'historical comment (lineHeight rationale)' },
  { path: 'src/runtime/terminal-registry.test.ts', reason: 'test name mirroring the comment above' },
  { path: 'src/components/ace-chat/Composer.tsx', reason: 'historical comment (Hermes lane provenance)' },
  { path: 'src/components/ace-chat/ContextStatusPill.tsx', reason: 'historical comment (status-line provenance)' },
  { path: 'src/components/ace-chat/HermesTerminalMirror.tsx', reason: 'comment example of agent-name gerund rows' },
  { path: 'src/components/ace-chat/composers/HermesComposer.tsx', reason: 'historical comment (shell provenance)' },
  { path: 'src/components/ace-chat/hermes-terminal-mirror-parser.test.ts', reason: 'live-lane transcript fixtures' },
  { path: 'src/lib/hermes-status.ts', reason: 'historical comment (status format provenance)' },
  { path: 'src/lib/operators.ts', reason: 'doc comments describing migrated owner installs' },
  { path: 'src/lib/personal-agents.ts', reason: 'doc comment describing migrated owner installs' },
  { path: 'src/lib/personal-agents.test.ts', reason: 'owner-config fixtures (migration shape)' },
  { path: 'src/lib/types.ts', reason: 'doc comment describing migrated owner installs' },
  { path: 'src/lib/agent-lanes.test.ts', reason: 'owner lane-id fixtures' },
  { path: 'src/lib/cli-attachments.node-test.ts', reason: 'owner chat-copy fixtures (operator gerunds)' },

  // — CLI/ops tooling mirroring the golden-pinned identity enums —
  { path: 'tools/ace/src/commands.cts', reason: 'CLI identity choices mirror golden-pinned missions defaults (follow-up: config-driven)' },
  { path: 'tools/ace/src/enforcement.cts', reason: 'control-plane identity check mirrors golden-pinned defaults (follow-up: config-driven)' },
  { path: 'tools/ace/src/project-wiki-curator.cts', reason: 'agent-pack roles mirror golden-pinned defaults (follow-up: config-driven)' },
  { path: 'tools/ace/src/__tests__/cli.test.cts', reason: 'CLI fixtures for the identity enums' },
  { path: 'tools/ace/src/__tests__/enforcement.test.cts', reason: 'fixtures for the control-plane identity check' },
  { path: 'tools/ace/src/__tests__/project-wiki-curator.test.cts', reason: 'fixtures for the agent-pack roles' },
  { path: 'tools/ace/README.md', reason: 'docs describing validation-ready consumption by operator lanes' },
  { path: 'scripts/ace-mission-loop.sh', reason: 'owner ops loop script (controller default; follow-up: config-driven)' },
];

function isAllowed(relPath: string): AllowEntry | null {
  for (const entry of ALLOWLIST) {
    if (entry.path.endsWith('/')) {
      if (relPath.startsWith(entry.path)) return entry;
    } else if (relPath === entry.path) {
      return entry;
    }
  }
  return null;
}

function listFiles(): string[] {
  const out = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '--', ...SCAN_DIRS],
    { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  );
  return out.split('\n').map((line: string) => line.trim()).filter(Boolean);
}

function isBinary(buffer: Buffer): boolean {
  const probe = buffer.subarray(0, 8192);
  return probe.includes(0);
}

function main() {
  const files = listFiles();
  const violations: string[] = [];
  const usedAllowlist = new Set<string>();
  let scanned = 0;
  let allowlistedHits = 0;

  for (const relPath of files) {
    const absPath = path.join(REPO_ROOT, relPath);
    let buffer: Buffer;
    try {
      buffer = fs.readFileSync(absPath);
    } catch {
      continue; // deleted/unreadable race — nothing to scan
    }
    if (isBinary(buffer)) continue;
    scanned += 1;

    const text = buffer.toString('utf8');
    if (!PERSONALIZATION.test(text) && !MIC_REGROWTH.test(text)) continue;

    const allowed = isAllowed(relPath);
    // The allowlist sanctions PERSONALIZATION fixtures only. Mic regrowth has
    // no sanctioned home anywhere except this gate's own pattern definitions.
    const micExempt = relPath === 'scripts/check-depersonalization.cts';
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const personalization = line.match(PERSONALIZATION);
      const mic = line.match(MIC_REGROWTH);
      if (!personalization && !mic) continue;
      if (mic && !micExempt) {
        violations.push(`${relPath}:${i + 1}: [mic-regrowth: ${mic[0]}] ${line.trim().slice(0, 160)}`);
        continue;
      }
      if (allowed) {
        usedAllowlist.add(allowed.path);
        allowlistedHits += 1;
        continue;
      }
      if (!personalization) continue; // mic hit inside the self-exempt gate
      violations.push(`${relPath}:${i + 1}: [${personalization[0]}] ${line.trim().slice(0, 160)}`);
    }
  }

  const unused = ALLOWLIST.filter((entry) => !usedAllowlist.has(entry.path));
  if (unused.length > 0) {
    console.log('note: allowlist entries with no current hits (candidates for removal):');
    for (const entry of unused) console.log(`  - ${entry.path}`);
  }

  if (violations.length > 0) {
    console.error(`\nDE-PERSONALIZATION GATE FAILED — ${violations.length} violation(s):\n`);
    for (const violation of violations) console.error(`  ${violation}`);
    console.error(
      '\nFix the hit, or — ONLY for test fixtures / historical artifacts — add a justified allowlist entry in scripts/check-depersonalization.cts.'
    );
    process.exit(1);
  }

  console.log(
    `de-personalization gate passed: ${scanned} files scanned, 0 violations (${allowlistedHits} allowlisted hits in ${usedAllowlist.size} files).`
  );
}

main();
