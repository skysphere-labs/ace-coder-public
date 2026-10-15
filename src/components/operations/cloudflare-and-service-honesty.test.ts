import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Lane 1 (no-secret Ops monitoring) — source-text assertions (house idiom, see
// ops-freshness-wiring.test.ts): verify the honesty contract on the renderer
// surfaces without booting Electron.
const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(here, rel), 'utf8');

const serviceRowSource = read('molecules/ServiceStatusRow.tsx');
const opsStatusSource = read('../../../electron/ops-status.cts');

// ─── A1/A2: service rows surface id, expected & observed status, freshness ────
describe('ServiceStatusRow surfaces expected vs observed status (A1/A2)', () => {
  it('renders discrete expected and observed HTTP status', () => {
    expect(serviceRowSource).toContain('details?.expectStatus');
    expect(serviceRowSource).toContain('details?.status');
    expect(serviceRowSource).toContain('expected ');
    expect(serviceRowSource).toContain('observed ');
  });

  it('labels an expected non-2xx as a by-design redirect (Access gate, A2)', () => {
    expect(serviceRowSource).toContain('redirectExpected');
    expect(serviceRowSource).toContain('redirect');
  });

  it('keeps the endpoint id as the row label and the last-checked freshness', () => {
    expect(serviceRowSource).toContain('endpointId');
    expect(serviceRowSource).toContain('FreshnessLabel');
    expect(serviceRowSource).toContain("prefix=\"checked\"");
  });
});

// ─── A3: DNS-unresolved planned endpoint is action-needed, not an app failure ─
describe('ServiceStatusRow reframes DNS-unresolved as planned/action-needed (A3)', () => {
  it('detects the dnsUnresolved flag (with a resolver-error fallback)', () => {
    expect(serviceRowSource).toContain('dnsUnresolved');
    expect(serviceRowSource).toMatch(/ENOTFOUND|EAI_AGAIN|getaddrinfo/);
  });

  it('renders DNS-unresolved in amber (action-needed), never the rose hard-fail', () => {
    // A genuine app failure keeps rose; DNS-unresolved is split out as amber.
    expect(serviceRowSource).toContain('hardFailure');
    expect(serviceRowSource).toMatch(/dnsUnresolved && errorText/);
    expect(serviceRowSource).toContain('text-amber-200');
    expect(serviceRowSource).toContain('planned');
    expect(serviceRowSource).toContain('action needed');
  });
});

// ─── Backend: the DNS / redirect classification is typed in ops-status.cts ────
describe('ops-status service probe emits the typed honesty flags', () => {
  it('classifies DNS-resolution failures and expected redirects', () => {
    expect(opsStatusSource).toContain('dnsUnresolved');
    expect(opsStatusSource).toContain('redirectExpected');
    expect(opsStatusSource).toMatch(/ENOTFOUND\|EAI_AGAIN\|getaddrinfo/);
  });
});
