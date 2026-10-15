import { describe, expect, it } from 'vitest';
import { isRemoteCredentialRejection } from './remote-response';

describe('remote 403 classification', () => {
  it('clears enrollment only for the plain credential rejection', () => {
    expect(isRemoteCredentialRejection(403, null)).toBe(true);
    expect(isRemoteCredentialRejection(403, {
      ok: false,
      error: 'This action is available only in the ACE desktop app.',
    })).toBe(false);
  });

  it('never classifies non-403 failures as credential rejection', () => {
    expect(isRemoteCredentialRejection(401, null)).toBe(false);
    expect(isRemoteCredentialRejection(500, null)).toBe(false);
  });
});
