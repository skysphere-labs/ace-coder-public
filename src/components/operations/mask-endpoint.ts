// Mask any URL down to its host so the cockpit never renders a raw endpoint
// (contracts: endpoint masked, never raw URL). Non-URL strings pass through
// unchanged (they are likely already opaque endpoint ids).
export function maskEndpoint(value: string | null | undefined): string {
  if (!value) return '';
  try {
    const url = new URL(value);
    const host = url.hostname;
    // Show only the last two labels of the host (e.g. example.com), eliding any
    // subdomain or account-id prefix that could leak a personal identifier.
    const labels = host.split('.');
    const tail = labels.length > 2 ? labels.slice(-2).join('.') : host;
    return labels.length > 2 ? `…${tail}` : tail;
  } catch {
    return value;
  }
}
