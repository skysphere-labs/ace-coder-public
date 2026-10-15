// Pure helpers for the mobile composer's IME / autocorrect handling, kept out
// of the component so the controlled-textarea commit rules can be unit-tested
// without a DOM.

// A controlled <textarea> must mirror every committed input into React state —
// the ONLY exception is the intermediate states of an active IME composition
// session, where re-rendering the controlled value mid-compose fights the IME.
//
// The browser's own InputEvent.isComposing flag is the authoritative signal for
// "a composition is in progress right now". Gating on it (instead of a
// manually-held ref) is what keeps an autocorrect / keyboard-suggestion commit
// — which arrives as `insertReplacementText`, with isComposing already false and
// firing NO compositionend — from wedging the box. Previously such a commit set
// a `composingRef` true with no path to reset it, so every later onChange was
// dropped and the visible textarea froze. Anchoring on isComposing means a
// committed suggestion always reaches state.
export function shouldCommitComposerInput(isComposing: boolean | undefined): boolean {
  return isComposing !== true;
}

// iOS Safari occasionally double-appends the just-composed chunk when a
// controlled value re-renders at the moment composition commits (a composed
// "the" lands as "thethe"). When the final value ends with the composition data
// twice, strip the duplicate copy. No data, or no doubling → value unchanged.
export function dedupeComposedValue(final: string, data: string | null | undefined): string {
  if (data && final.endsWith(data + data)) {
    return final.slice(0, final.length - data.length);
  }
  return final;
}
