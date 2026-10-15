import { describe, expect, it } from 'vitest';
import {
  clearComposerDraft,
  getComposerDraft,
  setComposerDraft,
} from './composer-draft-registry';

describe('composer draft registry safety', () => {
  it('does not persist generated NaN terminal garbage as a draft', () => {
    setComposerDraft('conversation:claude', 'aN;NaNMaN;NaNMa');
    expect(getComposerDraft('conversation:claude')).toBe('');

    setComposerDraft('conversation:claude', '\x1b[<0;NaN;NaNM');
    expect(getComposerDraft('conversation:claude')).toBe('');
  });

  it('strips generated terminal garbage from mixed human drafts', () => {
    setComposerDraft('conversation:claude', 'keep workingaN;NaNMaN;NaNMa');
    expect(getComposerDraft('conversation:claude')).toBe('keep working');
    clearComposerDraft('conversation:claude');
  });

  it('keeps human text that mentions NaN', () => {
    setComposerDraft('conversation:claude', 'explain why Number.NaN is not equal to itself');
    expect(getComposerDraft('conversation:claude')).toBe(
      'explain why Number.NaN is not equal to itself'
    );
    clearComposerDraft('conversation:claude');
  });
});
