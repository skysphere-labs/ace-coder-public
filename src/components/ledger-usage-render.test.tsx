import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

// The popover body is pure props; the strip needs the app bridge stubbed the
// same way render-ssr.test.tsx does (effects never run in a static render, so
// no timers or subscriptions leak).
vi.mock('../lib/ace-api', () => ({
  isRemoteClient: () => false,
  aceApi: {
    missions: { runBoard: async () => null },
    core: { subscribe: () => () => {}, onGitChanged: () => () => {} },
    updates: { getStatus: async () => null },
  },
}));
vi.mock('../store', () => ({
  useApp: () => ({ setView: () => {}, activeWorkspace: null, activeTask: { agent: 'claude' } }),
}));
vi.mock('../runtime/task-activity-registry', () => ({ useBusyTaskIds: () => new Set() }));
vi.mock('../runtime/usage-registry', () => ({
  useProviderUsage: () => ({ report: REPORT, error: null }),
}));

import {
  ProviderSubscriptionsContent,
  ProviderUsagePopoverContent,
} from './ProviderUsagePopover';
import { LedgerStrip } from './LedgerStrip';

const NOW = 1_800_000_000_000;
const meter = (percent: number | null, resetsAt: number | null = null) => ({ percent, resetsAt });

// One meter set per provider — the whole shape after the account vault was
// removed. There is no per-account structure any more: the renderers read the
// provider-level fields directly.
const REPORT = {
  generatedAt: NOW,
  providers: [
    {
      id: 'claude',
      name: 'Claude Code',
      plan: 'Max 20x',
      accountLabel: 'owner@example.com',
      state: 'live',
      asOf: NOW,
      session: meter(2),
      weekly: meter(30),
      lastActivityMs: NOW,
    },
    {
      id: 'codex',
      name: 'Codex CLI',
      plan: 'Pro',
      accountLabel: null,
      state: 'live',
      asOf: NOW,
      session: meter(11),
      weekly: meter(40),
      lastActivityMs: NOW,
    },
  ],
} as never;

describe('usage popover rendered output', () => {
  it('explains disabled collection without showing provider account metadata', () => {
    const disabled = renderToStaticMarkup(
      <ProviderUsagePopoverContent
        report={{ providers: [], generatedAt: NOW, enabled: false, reason: 'disabled' }}
        error={null}
      />
    );
    expect(disabled).toContain('Usage collection is disabled');
    expect(disabled).toContain('docs/operations/provider-usage.md');
    expect(disabled).not.toContain('No usage detected');
    expect(disabled).not.toContain('owner@example.com');
  });

  const html = renderToStaticMarkup(
    <ProviderUsagePopoverContent report={REPORT} error={null} pinned="claude" />
  );

  it('renders BOTH providers with their plan badges', () => {
    expect(html).toContain('Claude Code');
    expect(html).toContain('Codex CLI');
    expect(html).toContain('Max 20x');
    expect(html).toContain('Pro');
  });

  it('renders each provider\'s meters and account label', () => {
    expect(html).toContain('owner@example.com');
    expect(html).toContain('5h session');
    expect(html).toContain('Weekly');
  });

  it('no longer offers any account switching affordance', () => {
    expect(html).not.toContain('Bind new lanes to this subscription');
    expect(html).not.toContain('Manage accounts');
    expect(html).not.toContain('Default (ambient)');
  });

  it('pins the requested provider first without dropping the other', () => {
    expect(html.indexOf('Claude Code')).toBeLessThan(html.indexOf('Codex CLI'));
    const codexFirst = renderToStaticMarkup(
      <ProviderUsagePopoverContent report={REPORT} error={null} pinned="codex" />
    );
    expect(codexFirst.indexOf('Codex CLI')).toBeLessThan(codexFirst.indexOf('Claude Code'));
  });

  it('renders the error panel instead of provider rows when the read failed', () => {
    const failed = renderToStaticMarkup(<ProviderUsagePopoverContent report={null} error="boom" />);
    expect(failed).toContain("Couldn&#x27;t read usage");
    expect(failed).toContain('boom');
    expect(failed).not.toContain('Claude Code');
  });
});

describe('ledger strip rendered triggers (split per provider)', () => {
  const html = renderToStaticMarkup(<LedgerStrip />);

  it('renders one glanceable trigger button PER provider', () => {
    expect(html).toMatch(/<button[^>]*title="Claude Code subscriptions &amp; usage"/);
    expect(html).toMatch(/<button[^>]*title="Codex CLI subscriptions &amp; usage"/);
  });

  it('keeps both provider names, meters, and the push-freshness hook on the triggers', () => {
    expect(html).toContain('Claude Code');
    expect(html).toContain('Codex CLI');
    expect((html.match(new RegExp(`data-usage-generated-at="${NOW}"`, 'g')) || []).length).toBe(2);
    expect(html).toMatch(/5h/i);
    expect(html).toMatch(/wk/i);
  });
});

describe('single-provider popover content', () => {
  const claude = (REPORT as { providers: unknown[] }).providers[0] as never;
  const html = renderToStaticMarkup(<ProviderSubscriptionsContent provider={claude} now={NOW} />);

  it('renders the provider meters with no switcher chrome', () => {
    expect(html).toContain('Claude Code');
    expect(html).toContain('5h session');
    expect(html).toContain('Weekly');
    expect(html).not.toContain('Bind new lanes to this subscription');
    expect(html).not.toContain('Switching accounts is available on the desktop app.');
    expect(html).not.toContain('Manage accounts');
  });

  it('reports an unknown provider honestly instead of inventing numbers', () => {
    const unknown = { ...(claude as object), state: 'unknown' } as never;
    const out = renderToStaticMarkup(<ProviderSubscriptionsContent provider={unknown} now={NOW} />);
    expect(out).toContain('No live usage data yet');
  });
});
