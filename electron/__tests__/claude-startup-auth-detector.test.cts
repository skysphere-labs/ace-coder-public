import { describe, it, expect } from 'vitest';
const policy = require('../claude-auth-policy.cts');

const frame = (badge) =>
  ` ▐▛███▜▌   Claude Code v2.1.252\r\n▝▜█████▛▘  Opus 5 · ${badge}\r\n`;

describe('claude startup auth detector', () => {
  it('terminates a lane that reports metered API Usage Billing', () => {
    const d = policy.createClaudeStartupAuthDetector();
    expect(d.push(frame('API Usage Billing'))).toBe('api');
  });

  it('leaves a setup-token login alone despite its "Claude API" branding', () => {
    // classifyClaudeSubscriptionAuthStatus ACCEPTS this login shape (a
    // first-party oauth_token), and every spawn path runs that preflight before
    // this detector sees a byte — so the label alone must not kill the lane.
    const accepted = policy.classifyClaudeSubscriptionAuthStatus(
      JSON.stringify({ loggedIn: true, authMethod: 'oauth_token', apiProvider: 'firstParty' }),
      { hasSetupToken: true }
    );
    expect(accepted.ok).toBe(true);

    const d = policy.createClaudeStartupAuthDetector();
    expect(d.push(frame('Claude API'))).toBe(null);
  });

  it('ignores the phrase in ordinary output, not just the startup frame', () => {
    const d = policy.createClaudeStartupAuthDetector();
    expect(d.push('some log line mentioning API Usage Billing in passing\n')).toBe(null);
  });

  it('survives the banner arriving split across PTY chunks', () => {
    const d = policy.createClaudeStartupAuthDetector();
    const whole = frame('API Usage Billing');
    const cut = Math.floor(whole.length / 2);
    expect(d.push(whole.slice(0, cut))).toBe(null);
    expect(d.push(whole.slice(cut))).toBe('api');
  });
});
