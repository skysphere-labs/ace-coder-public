import { describe, expect, it } from 'vitest';

const {
  tagSessionResponseProfile,
} = require('../hermes-desktop-bridge.cts');

describe('tagSessionResponseProfile', () => {
  it('tags profile-rooted session rows with the logical Teams profile', () => {
    const response = {
      total: 466,
      sessions: [
        { id: 'session-a', title: 'No profile row' },
        { id: 'session-b', title: 'Default row', profile: 'default' },
        { id: 'session-c', title: 'Already scoped', profile: 'other' },
      ],
    };

    const tagged = tagSessionResponseProfile('/api/sessions?limit=40', response, 'alpha');

    expect(tagged).not.toBe(response);
    expect(tagged.sessions.map((session) => session.profile)).toEqual([
      'alpha',
      'alpha',
      'other',
    ]);
    expect(tagged.profile_totals.alpha).toBe(466);
    expect(response.sessions[0].profile).toBeUndefined();
  });

  it('keeps non-session payloads and default-profile payloads unchanged', () => {
    const status = { ok: true, sessions: [{ id: 'not-a-session-list' }] };
    const sessions = { total: 1, sessions: [{ id: 'session-a' }] };

    expect(tagSessionResponseProfile('/api/status', status, 'beta')).toBe(status);
    expect(tagSessionResponseProfile('/api/sessions', sessions, 'default')).toBe(sessions);
    expect(tagSessionResponseProfile('/api/sessions', sessions, null)).toBe(sessions);
  });

  it('maps default profile totals to the logical profile for sidebar pagination', () => {
    const response = {
      profile_totals: { default: 217 },
      sessions: [{ id: 'session-a', profile: 'default' }],
    };

    const tagged = tagSessionResponseProfile('/api/profiles/sessions?profile=alpha', response, 'alpha');

    expect(tagged.sessions[0].profile).toBe('alpha');
    expect(tagged.profile_totals).toEqual({ default: 217, alpha: 217 });
  });
});
