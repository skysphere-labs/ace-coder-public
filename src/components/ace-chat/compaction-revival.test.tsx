import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TranscriptList } from './TranscriptList';

const summaryEntry = {
  id: 1,
  role: 'system' as const,
  subtype: 'info' as const,
  text: 'Hermes auto-compacted prior conversation. Prior context was summarized; reviving from compacted context.',
  lifecycle: 'finished' as const,
  tAt: 1000,
};

describe('TranscriptList compaction revival notice', () => {
  it('renders an obvious Hermes compact/revival notice with stream status', () => {
    const html = renderToStaticMarkup(
      <TranscriptList
        streamId="stream-1"
        entries={[
          summaryEntry,
          { id: 2, role: 'user', text: 'Continue after compact.', lifecycle: 'finished', tAt: 1100 },
        ]}
        streamState="busy"
        hasOlder={false}
        loadingOlder={false}
        olderError={null}
        onLoadOlder={() => {}}
        compactStatus={{ reason: 'compact', state: 'reviving', at: 1000 }}
      />
    );

    expect(html).toContain('Hermes auto-compacted this chat');
    expect(html).toContain('Prior context was summarized');
    expect(html).toContain('Reviving from compacted context');
    expect(html).toContain('working');
  });

  it('does not render the compact notice for ordinary clear/reset states', () => {
    const html = renderToStaticMarkup(
      <TranscriptList
        streamId="stream-1"
        entries={[]}
        streamState="awaiting-input"
        hasOlder={false}
        loadingOlder={false}
        olderError={null}
        onLoadOlder={() => {}}
        compactStatus={null}
      />
    );

    expect(html).not.toContain('Hermes auto-compacted this chat');
    expect(html).not.toContain('Reviving from compacted context');
  });

  it('shows ready copy after compact recovery', () => {
    const html = renderToStaticMarkup(
      <TranscriptList
        streamId="stream-1"
        entries={[summaryEntry]}
        streamState="turn-complete"
        hasOlder={false}
        loadingOlder={false}
        olderError={null}
        onLoadOlder={() => {}}
        compactStatus={{ reason: 'compact', state: 'recovered', at: 1000 }}
      />
    );

    expect(html).toContain('Continuation is ready from the compacted context');
    expect(html).toContain('ready');
  });
});
