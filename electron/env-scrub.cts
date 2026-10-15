// Scrub agent-context ACE_* env inherited from a parent Ace instance.
//
// Agent shells spawned by Ace carry ACE_SOCK/URL/TOKEN plus stream/
// workspace identifiers so the bundled CLI can reach the parent app. If a NEW
// Ace instance is launched from inside such a shell (dev testing, agents
// building Ace itself), inheriting those vars wires the child's control
// plane and CLI surface to the PARENT instance — cross-instance contamination
// observed during the 0.1.0-dev.14 dev-env verification. Each instance must
// pin its OWN socket/tag from a clean slate.
//
// Deliberately KEPT (legitimate boot-time overrides):
// - ACE_DATA_ROOT / ACE_EXTERNAL_DATA_ROOT / ACE_USE_EXTERNAL_DATA_ROOT
//   (user-facing data-root selection, read by external-data-root.cts)
// - ACE_UPDATE_BASE_URL / ACE_UPDATE_ACCESS_CLIENT_ID / _SECRET
//   (updater feed + ZTNA service-token overrides)
// - ACE_DATA_ROOT_FALLBACK (fail-safe-only flag: inheriting it can only
//   SUPPRESS agent auto-start, never enable anything — and sandboxed test
//   boots rely on setting it externally)
const SCRUBBED_AGENT_ENV_VARS = [
  'ACE_SOCK',
  'ACE_USER_DATA_TAG',
  'ACE_URL',
  'ACE_TOKEN',
  'ACE_CALLER_INSTANCE_TAG',
  'ACE_STREAM_ID',
  'ACE_WORKSPACE_ID',
  'ACE_WORKSPACE_NAME',
  'ACE_TASK_ID',
  'ACE_CONVERSATION_ID',
  'ACE_AGENT',
  'ACE_HOME',
  'ACE_ARTIFACT_ROOT',
  'ACE_REPO_ROOT',
  'ACE_DEFAULT_BRANCH',
  'ACE_GITHUB_REPO',
  'ACE_GITHUB_PROJECT_INDEX',
  'ACE_AGENT_ROLE',
  'ACE_KNOWLEDGE_PACK',
];

// Claude sets this marker when it launches a nested Claude Code process. Ace
// can itself be started from an agent lane during development or repair; if
// the marker reaches a top-level lane, Claude disables transcript persistence
// and the native session linker has no file to attach.
const INHERITED_PROVIDER_ENV_VARS = ['CLAUDE_CODE_CHILD_SESSION'];
SCRUBBED_AGENT_ENV_VARS.push(...INHERITED_PROVIDER_ENV_VARS);

// Removes inherited agent-context vars from `env` (default: process.env).
// Returns the names that were scrubbed so boot can log the event.
function scrubInheritedAgentEnv(env: any = process.env): string[] {
  const scrubbed: string[] = [];
  for (const key of SCRUBBED_AGENT_ENV_VARS) {
    if (env[key] !== undefined) {
      delete env[key];
      scrubbed.push(key);
    }
  }
  return scrubbed;
}

module.exports = { SCRUBBED_AGENT_ENV_VARS, scrubInheritedAgentEnv };
