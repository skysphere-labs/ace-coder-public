import { describe, expect, it } from 'vitest';
import {
  DEFAULT_OPERATORS,
  OPERATORS_SCHEMA,
  getOperator,
  listControlPlaneOperators,
  normalizeOperatorId,
} from './operators';
import type { OperatorsConfig } from './operators';
import {
  getPersonalIdentityTaskId,
  getWorkspacePersonalIdentity,
  normalizePersonalAgentIdentity,
} from './personal-agents';

function ownerConfig(): OperatorsConfig {
  const base = DEFAULT_OPERATORS.operators[0];
  return {
    schema: OPERATORS_SCHEMA,
    defaultOperatorId: 'rook',
    operators: [
      { ...base, id: 'rook', label: 'Rook', emoji: '♜', sortOrder: 0 },
      { ...base, id: 'king', label: 'King', emoji: '♔', sortOrder: 1 },
    ],
  };
}

describe('operators contract', () => {
  it('ships one neutral hermes control-plane operator', () => {
    expect(DEFAULT_OPERATORS.schema).toBe(OPERATORS_SCHEMA);
    expect(DEFAULT_OPERATORS.defaultOperatorId).toBe('hermes');
    expect(DEFAULT_OPERATORS.operators).toHaveLength(1);
    expect(DEFAULT_OPERATORS.operators[0].id).toBe('hermes');
    expect(DEFAULT_OPERATORS.operators[0].label).toBe('Hermes');
    expect(DEFAULT_OPERATORS.operators[0].isControlPlane).toBe(true);
  });

  it('looks up operators case-insensitively', () => {
    expect(getOperator(DEFAULT_OPERATORS, ' Hermes ')?.id).toBe('hermes');
    expect(getOperator(DEFAULT_OPERATORS, 'rook')).toBeNull();
    expect(getOperator(DEFAULT_OPERATORS, '')).toBeNull();
    expect(getOperator(DEFAULT_OPERATORS, null)).toBeNull();
  });

  it('lists control-plane operators sorted by sortOrder', () => {
    expect(listControlPlaneOperators(ownerConfig()).map((op) => op.id)).toEqual(['rook', 'king']);
  });

  it('normalizes operator ids with lane: passthrough and strict unknowns', () => {
    expect(normalizeOperatorId('Hermes')).toBe('hermes');
    expect(normalizeOperatorId('lane:claude-main')).toBe('lane:claude-main');
    expect(normalizeOperatorId('unknown')).toBeNull();
    expect(normalizeOperatorId('')).toBeNull();
    expect(normalizeOperatorId(null)).toBeNull();
    expect(normalizeOperatorId('King', ownerConfig())).toBe('king');
  });
});

describe('personal agents', () => {
  it('normalizes identities against the default registry', () => {
    expect(normalizePersonalAgentIdentity('hermes')).toBe('hermes');
    expect(normalizePersonalAgentIdentity(' Hermes ')).toBe('hermes');
    expect(normalizePersonalAgentIdentity('')).toBeNull();
    expect(normalizePersonalAgentIdentity(null)).toBeNull();
    expect(normalizePersonalAgentIdentity(undefined)).toBeNull();
    // Unknown ids fall back to the config's default operator.
    expect(normalizePersonalAgentIdentity('rook')).toBe('hermes');
  });

  it('normalizes identities against an injected owner config', () => {
    const config = ownerConfig();
    expect(normalizePersonalAgentIdentity('rook', config)).toBe('rook');
    expect(normalizePersonalAgentIdentity('King', config)).toBe('king');
    expect(normalizePersonalAgentIdentity('other', config)).toBe('rook');
  });

  it('uses explicit personalIdentity only — no display-name sniffing', () => {
    const config = ownerConfig();
    expect(
      getWorkspacePersonalIdentity({ isPersonal: true, personalIdentity: 'king' }, config)
    ).toBe('king');
    expect(getWorkspacePersonalIdentity({ isPersonal: true, personalIdentity: null })).toBeNull();
    expect(
      getWorkspacePersonalIdentity({ isPersonal: false, personalIdentity: 'king' }, config)
    ).toBeNull();
  });

  it('selects separate Rook and King task ids from personal workspaces', () => {
    const config = ownerConfig();
    const workspaces = [
      {
        isPersonal: true,
        personalIdentity: 'rook',
        tasks: [{ id: 'rook-main' }],
      },
      {
        isPersonal: true,
        personalIdentity: 'king',
        tasks: [{ id: 'king-main' }],
      },
    ];

    expect(getPersonalIdentityTaskId(workspaces as never, 'rook', config)).toBe('rook-main');
    expect(getPersonalIdentityTaskId(workspaces as never, 'king', config)).toBe('king-main');
    expect(getPersonalIdentityTaskId([] as never, 'rook', config)).toBeNull();
  });
});
