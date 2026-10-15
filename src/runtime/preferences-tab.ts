// One-shot deep link into a Settings tab (e.g. LedgerStrip "Manage accounts"
// → Preferences → Accounts). The pending value covers a screen that mounts
// after the call; the event covers one that is already mounted.

export type PreferencesTabId = 'general' | 'agents' | 'accounts' | 'repository' | 'appearance';

let pendingTab: PreferencesTabId | null = null;
const TAB_EVENT = 'ace:preferences-tab';

export function openPreferencesTab(tab: PreferencesTabId) {
  pendingTab = tab;
  window.dispatchEvent(new CustomEvent(TAB_EVENT, { detail: tab }));
}

export function consumePendingPreferencesTab(): PreferencesTabId | null {
  const tab = pendingTab;
  pendingTab = null;
  return tab;
}

export function onPreferencesTabRequest(cb: (tab: PreferencesTabId) => void): () => void {
  const handler = (e: Event) => {
    pendingTab = null;
    cb((e as CustomEvent).detail as PreferencesTabId);
  };
  window.addEventListener(TAB_EVENT, handler);
  return () => window.removeEventListener(TAB_EVENT, handler);
}
