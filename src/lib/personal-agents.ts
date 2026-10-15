import { getOperatorsSnapshot } from '../runtime/operators-registry';
import { getOperator } from './operators';
import type { OperatorsConfig } from './operators';
import type { Workspace } from './types';

/**
 * Operator id (see src/lib/operators.ts). Shipped default is 'hermes'; legacy
 * owner installs carry 'rook' / 'king' as local config.
 */
export type PersonalAgentIdentity = string;

/**
 * Normalize a raw identity value against the operator registry. Empty/nullish
 * → null; a known operator id (case-insensitive) → its canonical id; any other
 * non-empty value falls back to the config's defaultOperatorId.
 */
export function normalizePersonalAgentIdentity(
  value: unknown,
  config: OperatorsConfig = getOperatorsSnapshot()
): PersonalAgentIdentity | null {
  const key = String(value ?? '').trim();
  if (!key) return null;
  return getOperator(config, key)?.id ?? config.defaultOperatorId;
}

/**
 * Identity of a personal workspace. Post-migration personal_identity is always
 * populated, so there is no display-name fallback: a personal workspace with a
 * null identity resolves to null.
 */
export function getWorkspacePersonalIdentity(
  workspace: Pick<Workspace, 'isPersonal' | 'personalIdentity'>,
  config?: OperatorsConfig
): PersonalAgentIdentity | null {
  if (!workspace.isPersonal) return null;
  return normalizePersonalAgentIdentity(workspace.personalIdentity, config);
}

function getPersonalIdentityWorkspace(
  workspaces: Array<Pick<Workspace, 'isPersonal' | 'personalIdentity' | 'tasks'>>,
  identity: PersonalAgentIdentity,
  config?: OperatorsConfig
) {
  return (
    workspaces.find((workspace) => getWorkspacePersonalIdentity(workspace, config) === identity) ??
    null
  );
}

export function getPersonalIdentityTaskId(
  workspaces: Array<Pick<Workspace, 'isPersonal' | 'personalIdentity' | 'tasks'>>,
  identity: PersonalAgentIdentity,
  config?: OperatorsConfig
): string | null {
  return getPersonalIdentityWorkspace(workspaces, identity, config)?.tasks[0]?.id ?? null;
}
