import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const entriesSource = readFileSync(resolve(here, 'Entries.tsx'), 'utf8');
const renderSource = readFileSync(resolve(here, 'render.tsx'), 'utf8');
const apiSource = readFileSync(resolve(here, '../../../lib/ace-api.ts'), 'utf8');

describe('communication transcript entries', () => {
  it('keeps the native Chat renderer wired to a dedicated communication card', () => {
    expect(renderSource).toContain("entry.role === 'communication'");
    expect(renderSource).toContain('<CommunicationEntry');
    expect(entriesSource).toContain('export function CommunicationEntry');
    expect(entriesSource).toContain("direction === 'sent' ? 'Sent' : 'Received'");
  });

  it('keeps the public TranscriptEntry type carrying peer metadata and safe body flags', () => {
    expect(apiSource).toContain("role: 'communication'");
    expect(apiSource).toContain("direction: 'sent' | 'received'");
    expect(apiSource).toContain('peerStreamId?: string');
    expect(apiSource).toContain('redacted?: boolean');
    expect(apiSource).toContain('truncated?: boolean');
  });
});
