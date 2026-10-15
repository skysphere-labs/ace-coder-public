import { afterEach, expect, test, vi } from 'vitest';
import {
  consumePendingPreferencesTab,
  onPreferencesTabRequest,
  openPreferencesTab,
} from './preferences-tab';

// Node has EventTarget + CustomEvent; the module only needs window to carry
// them, so a bare EventTarget stands in for the renderer window.
vi.stubGlobal('window', new EventTarget());

afterEach(() => {
  consumePendingPreferencesTab(); // drain between tests
});

test('a mount after the call consumes the pending tab exactly once', () => {
  openPreferencesTab('accounts');
  expect(consumePendingPreferencesTab()).toBe('accounts');
  expect(consumePendingPreferencesTab()).toBe(null);
});

test('an already-mounted screen receives the event and the pending value clears', () => {
  const seen: string[] = [];
  const off = onPreferencesTabRequest((tab) => seen.push(tab));
  openPreferencesTab('accounts');
  expect(seen).toEqual(['accounts']);
  // The listener consumed the request — a later mount must not replay it.
  expect(consumePendingPreferencesTab()).toBe(null);
  off();
  openPreferencesTab('general');
  expect(seen).toEqual(['accounts']); // unsubscribed
  expect(consumePendingPreferencesTab()).toBe('general'); // pending path still works
});
