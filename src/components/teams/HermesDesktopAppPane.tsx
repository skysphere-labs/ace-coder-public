// Full Hermes.app embed for Teams. This is intentionally not lane-scoped:
// ensure() without an owner starts the global desktop backend and returns the
// installed Hermes.app renderer + preload bridge.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Loader2, PanelLeft, TriangleAlert } from 'lucide-react';
import { aceApi, isRemoteClient, type HermesDesktopEvent } from '../../lib/ace-api';
import { requestBrowserOpen } from '../../lib/github-browser';
import { getOperator, listControlPlaneOperators } from '../../lib/operators';
import { useOperators } from '../../runtime/operators-registry';
import { recordPerf, useSpinnerPerf } from '../../runtime/perf-health';
import { Button } from '../ui/button';
import {
  HERMES_DESKTOP_APP_PARTITION,
  HERMES_DESKTOP_APP_OWNER_KEY,
  HERMES_DESKTOP_REMOTE_PATH,
  HERMES_RESUME_SCRIPT,
  homeRestoreResultIsStale,
  isAbortedLoadError,
  isOutsideHermesRemotePath,
  isRetryableLoadError,
  resolveActiveEmbedProfile,
  STARTING_RETRY_COPY,
  WEBVIEW_MAX_RETRIES,
  WEBVIEW_RETRY_DELAY_MS,
} from './hermes-dashboard-pane-logic';

type WebviewEl = HTMLElement & {
  reload(): void;
  loadURL(url: string): Promise<void>;
  insertCSS?(css: string): Promise<string>;
  executeJavaScript?(code: string): Promise<unknown>;
};

function perfNow() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

// A Hermes "profile" surfaced as a Ace host-chrome tab. The embedded
// Hermes.app calls these lanes "profiles"; key is the normalized name the
// injected adaptations script tags each rail item with.
type ProfileTab = { name: string; key: string; active: boolean };

// Each lane's identity emoji comes from the operator config (data-driven, so
// the shipped code carries no owner-specific identities); the tab falls back to
// the profile's first initial when no operator matches.

function sameProfiles(a: ProfileTab[], b: ProfileTab[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].key !== b[i].key || a[i].name !== b[i].name || a[i].active !== b[i].active) return false;
  }
  return true;
}

// Reads the (already tagged) Hermes profile rail and returns the lane list +
// which one is active, so Ace can render its own top tab strip. Relies on
// the adaptations script having tagged items with data-ace-profile-* first;
// syncProfiles always runs adaptations before this read.
const HERMES_PROFILE_READ_SCRIPT = `
  (() => {
    try {
      const tablist = document.querySelector('[role="tablist"][aria-label="Profiles"]');
      if (!tablist) return { profiles: [] };
      const cleanProfileName = (value) => {
        const raw = String(value || '')
          .replace(/^Reorder\\s+/i, '')
          .replace(/^(?:switch to|activate|select|use)\\s+(?:the\\s+)?profile\\s+/i, '')
          .replace(/^profile:\\s*/i, '')
          .replace(/\\s+/g, ' ')
          .trim();
        if (!raw || /^(profiles?|show all profiles|all|manage(?: profiles?)?\\.{0,3}|new(?: profile)?|more)$/i.test(raw)) return '';
        if (/session actions|keyboard shortcuts|settings|sidebar/i.test(raw)) return '';
        return raw
          .replace(/[-_]+/g, ' ')
          .replace(/\\b\\w/g, (letter) => letter.toUpperCase());
      };
      const items = Array.from(
        tablist.querySelectorAll('[data-ace-profile-name], [aria-label], [title], button, [role="button"], [tabindex]')
      );
      const seen = new Set();
      const profiles = [];
      let hasNew = false;
      for (const el of items) {
        const rawLabel = String(
          el.getAttribute('data-ace-profile-name') ||
          el.getAttribute('aria-label') ||
          el.getAttribute('title') ||
          el.textContent ||
          ''
        ).replace(/\\s+/g, ' ').trim();
        if (el.getAttribute('data-ace-profile-action') === 'new' || /^(?:new profile|new)$/i.test(rawLabel)) {
          hasNew = true;
          continue;
        }
        const name = cleanProfileName(rawLabel);
        if (!name) continue;
        const key = el.getAttribute('data-ace-profile-key') || name.toLowerCase().replace(/\\s+/g, '');
        if (seen.has(key)) continue;
        seen.add(key);
        const active =
          el.getAttribute('aria-selected') === 'true' ||
          el.getAttribute('aria-pressed') === 'true' ||
          el.getAttribute('data-state') === 'checked' ||
          !!el.closest('[aria-selected="true"], [data-state="checked"]');
        profiles.push({ name, key, active });
      }
      hasNew = hasNew || !!tablist.querySelector('[data-ace-profile-action="new"]');
      return { profiles, hasNew };
    } catch (error) {
      return { profiles: [], error: error && (error.message || String(error)) };
    }
  })()
`;

// Switch by clicking the (visually-hidden) Hermes rail button for the lane:
// that drives the SPA's own selectProfile → swap-minimal gateway routing,
// which reconnects the live gateway to the lane's pooled backend with NO
// webview reload and NO sidecar restart. The previous bridge-first path
// (window.hermesDesktop.profile.set) re-roots the primary backend: it kills
// the python sidecar, respawns it under the new HERMES_HOME, and reloads the
// whole SPA — a ~5s freeze on every tab click. The historical reason for
// preferring the bridge (stale hermes:last-session ids stranding the embed on
// "Loading session") is gone: the SPA now persists stored DB session ids
// only, and profile backends open persistent per-identity homes (see
// local-core resolveOperatorProfileHome), so remembered ids survive backend
// respawns. The bridge switch remains as the fallback when the rail item
// hasn't been tagged yet (adaptations not run / CSP-blocked read).
function profileClickScript(key: string): string {
  return `
    (() => {
      const profile = ${JSON.stringify(key)};
      const norm = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
      // Find and click the profile's rail item. Tagged items win (the adaptations
      // tagger can stamp the key on non-button descendants like a reorder handle,
      // so prefer the actual button); else match by normalized aria-label inside
      // the Profiles tablist only, so menu items never match.
      const clickProfile = () => {
        const tagged = Array.from(
          document.querySelectorAll('[data-ace-profile-key=' + JSON.stringify(profile) + ']')
        );
        const el = tagged.find((item) => item.matches('button, [role="button"]')) || tagged[0];
        if (el) { el.click(); return true; }
        const tablist = document.querySelector('[role="tablist"][aria-label="Profiles"]');
        if (tablist) {
          const candidates = Array.from(tablist.querySelectorAll('button, [role="button"]'));
          const match = candidates.find((item) => {
            const label =
              item.getAttribute('aria-label') || item.getAttribute('title') || item.textContent || '';
            const normalized = norm(label);
            return normalized === profile || normalized === 'switchtoprofile' + profile;
          });
          if (match) { match.click(); return true; }
        }
        return false;
      };
      try {
        // Fast path: the rail is mounted (always on desktop; on mobile only while
        // the sidebar is open). This is the non-destructive in-SPA selectProfile
        // switch — no sidecar restart, so an in-flight turn survives.
        if (clickProfile()) return true;
        // Mobile collapsed-rail path: Ace auto-collapses the embed sidebar on
        // phones (so the chat is visible), and the SPA UNMOUNTS the Profiles rail
        // with it — leaving the host lane tabs nothing to click (the reported
        // "mobile tabs do nothing" bug). Re-open the sidebar to remount the rail,
        // click the profile, then re-arm the once-per-load auto-collapse so the
        // next adaptations tick hides the sidebar again and the chat stays visible.
        const expand = Array.from(document.querySelectorAll('button, [role="button"]')).find((b) => {
          const label = b.getAttribute('aria-label') || b.getAttribute('title') || b.textContent || '';
          return /show sidebar|open sidebar|expand sidebar/i.test(label);
        });
        if (!expand) {
          // No rail and no way to mount it: last-resort bridge. On desktop this
          // re-roots the sidecar (slow, kills an in-flight turn) so it is a true
          // last resort; on the mobile shim it is an inert no-op.
          const bridgeSwitch = window.hermesDesktop?.profile?.set;
          if (typeof bridgeSwitch === 'function') {
            return Promise.resolve(bridgeSwitch(profile)).then(() => true).catch(() => false);
          }
          return false;
        }
        expand.click();
        return new Promise((resolve) => {
          let tries = 0;
          const tick = () => {
            if (clickProfile()) {
              try { window.__aceHermesSidebarAutoCollapsed = false; } catch (e) {}
              resolve(true);
              return;
            }
            if (tries++ > 20) { resolve(false); return; }
            setTimeout(tick, 50);
          };
          setTimeout(tick, 50);
        });
      } catch (error) { return false; }
    })()
  `;
}

// Reflect whether Ace host-chrome lane tabs are rendered into the embed,
// so the injected CSS can retire the desktop foot-rail. Host-driven (not part
// of the profile read): the tabs now come from the operators registry, so
// they can be live even when the DOM read finds nothing.
function hostTabsAttrScript(on: boolean): string {
  return `
    (() => {
      try {
        ${on
          ? `document.body.setAttribute('data-ace-host-tabs', 'on');`
          : `document.body.removeAttribute('data-ace-host-tabs');`}
        return true;
      } catch (error) { return false; }
    })()
  `;
}

const HERMES_PROFILE_NEW_SCRIPT = `
  (() => {
    const clickNew = () => {
      const tagged = document.querySelector('[data-ace-profile-action="new"]');
      if (tagged) { tagged.click(); return true; }
      // Untagged fallback inside the Profiles rail (adaptations may not have run).
      const tablist = document.querySelector('[role="tablist"][aria-label="Profiles"]');
      if (tablist) {
        const candidates = Array.from(tablist.querySelectorAll('button, [role="button"]'));
        const match = candidates.find((item) => {
          const label = item.getAttribute('aria-label') || item.getAttribute('title') || item.textContent || '';
          return /^(?:new profile|new)$/i.test(String(label).trim());
        });
        if (match) { match.click(); return true; }
      }
      return false;
    };
    try {
      // Fast path: rail mounted.
      if (clickNew()) return true;
      // Mobile collapsed-rail path (mirrors profileClickScript): the "+" target
      // lives in the unmounted rail, so re-open the sidebar, click, re-arm the
      // auto-collapse latch.
      const expand = Array.from(document.querySelectorAll('button, [role="button"]')).find((b) => {
        const label = b.getAttribute('aria-label') || b.getAttribute('title') || b.textContent || '';
        return /show sidebar|open sidebar|expand sidebar/i.test(label);
      });
      if (!expand) return false;
      expand.click();
      return new Promise((resolve) => {
        let tries = 0;
        const tick = () => {
          if (clickNew()) {
            try { window.__aceHermesSidebarAutoCollapsed = false; } catch (e) {}
            resolve(true);
            return;
          }
          if (tries++ > 20) { resolve(false); return; }
          setTimeout(tick, 50);
        };
        setTimeout(tick, 50);
      });
    } catch (error) { return false; }
  })()
`;

// Open/close the embedded Hermes sessions sidebar from Ace host chrome.
// On phones the SPA force-collapses the sessions pane into its hover-reveal
// OVERLAY (Pane forceCollapsed={narrowViewport}). In that mode the pane's `open`
// is pinned false and `$sidebarOpen` is ignored, so the SPA's titlebar toggle —
// which only flips $sidebarOpen — does nothing. The overlay is revealed solely
// by the pane's `forced` flag, toggled by a `hermes:pane-toggle-reveal` event
// (exactly what the SPA's own narrow-viewport keybind dispatches). With no hover
// on touch and no keyboard on a phone, nothing else can open it — which is why
// the session list was unreachable on mobile. We dispatch that event for the
// chat-sidebar pane; the matching HERMES_EMBED_CSS rule surfaces the
// force-revealed overlay (data-pane-hover-reveal="open") as the drawer. The
// titlebar-codicon click is kept as a fallback for wider remote widths where the
// pane is a normal (non-force-collapsed) collapsible sidebar.
// After toggling, if the drawer is now OPEN, arm a one-shot capture-phase
// outside-tap listener inside the embed: a tap anywhere outside the
// chat-sidebar pane re-dispatches the same toggle to close it (native mobile
// drawer behaviour). A tap inside the drawer is ignored. The listener removes
// itself on fire, and re-toggling tears it down — so this never restarts Hermes
// or interferes with lane/profile switching (which use different scripts).
const HERMES_SIDEBAR_TOGGLE_SCRIPT = `
  (() => {
    try {
      window.dispatchEvent(
        new CustomEvent('hermes:pane-toggle-reveal', { detail: { id: 'chat-sidebar' } })
      );
      const icon = document.querySelector('.codicon-layout-sidebar-left');
      const toggle = icon && icon.closest('button, [role="button"]');
      if (toggle) toggle.click();
      var teardown = function () {
        if (window.__aceSidebarOutsideTap) {
          document.removeEventListener('pointerdown', window.__aceSidebarOutsideTap, true);
          window.__aceSidebarOutsideTap = null;
        }
      };
      setTimeout(function () {
        teardown();
        var pane = document.querySelector('[data-pane-id="chat-sidebar"]');
        var open = pane && pane.getAttribute('data-pane-hover-reveal') === 'open';
        if (!open) return;
        var handler = function (e) {
          var p = document.querySelector('[data-pane-id="chat-sidebar"]');
          if (p && p.contains(e.target)) return; // tap inside the drawer keeps it open
          teardown();
          window.dispatchEvent(
            new CustomEvent('hermes:pane-toggle-reveal', { detail: { id: 'chat-sidebar' } })
          );
        };
        window.__aceSidebarOutsideTap = handler;
        // Defer arming so the tap that OPENED the drawer doesn't close it.
        setTimeout(function () {
          document.addEventListener('pointerdown', handler, true);
        }, 0);
      }, 0);
      return true;
    } catch (error) { return false; }
  })()
`;

/** Embed lifecycle as host chrome sees it. The pane stays the owner of the
 *  real state; this is only mirrored out so a host launcher can label itself
 *  honestly while the pane is hidden. */
export type HermesFramePhase = 'starting' | 'live' | 'error';

type AppFrameState =
  | { phase: 'starting'; url: null; preload: null; error: null; ownerKey: string | null }
  | {
      phase: 'live';
      url: string;
      preload: string | null;
      error: null;
      ownerKey: string;
      // Whether the live `url` survives a backend restart. The packaged
      // bundle's file:// renderer does ('desktop'); the sidecar's own served
      // web UI does NOT ('web') — it is bound to a per-spawn loopback port and
      // session token, both of which change on every respawn.
      surface: 'desktop' | 'web';
    }
  | { phase: 'error'; url: null; preload: null; error: string; ownerKey: string | null };

const INITIAL_STATE: AppFrameState = {
  phase: 'starting',
  url: null,
  preload: null,
  error: null,
  ownerKey: null,
};

// Cadence of the bounded cron→home delivery sweep while the embed is live.
const CRON_HOME_SYNC_INTERVAL_MS = 5 * 60_000;

// Ace re-skin of the embedded Hermes desktop UI. Durable across Hermes
// auto-updates by construction: we register a "ace" theme through Hermes's
// OWN theme system (its localStorage contract) from this per-load hook, so
// Hermes's applyTheme() emits the Ace palette as its inline seed vars. The
// source of truth is THIS constant (Ace source), re-applied on every load —
// an update only swaps the file:// bundle, never this.
// Ace's near-monochrome dark palette (from src/index.css :root), mapped onto
// Hermes's DesktopThemeColors. Blue accent (#3c83f6 = Ace --accent-indicator)
// carries branded strokes (active pills, streaming cursor, composer focus).
// The embed runs dark, so colors and darkColors share one palette (referenced
// below) — applyTheme emits Ace-dark in either mode.
const ACE_DESKTOP_COLORS = {
  background: '#171717',
  foreground: '#f0f0f0',
  card: '#1c1c1c',
  cardForeground: '#f0f0f0',
  muted: '#212121',
  mutedForeground: '#a1a1a1',
  popover: '#1c1c1c',
  popoverForeground: '#f0f0f0',
  primary: '#f5f5f5',
  primaryForeground: '#141414',
  secondary: '#212121',
  secondaryForeground: '#f0f0f0',
  accent: '#262626',
  accentForeground: '#f0f0f0',
  border: '#2e2e2e',
  input: '#2e2e2e',
  ring: '#6b6b6b',
  midground: '#3c83f6',
  composerRing: '#3c83f6',
  destructive: '#ef4444',
  destructiveForeground: '#fafafa',
  sidebarBackground: '#0f0f0f',
  sidebarBorder: '#292929',
  userBubble: '#262626',
  userBubbleBorder: '#2e2e2e',
};
const ACE_DESKTOP_THEME = {
  name: 'ace',
  label: 'Ace',
  description: 'Ace host theme — monochrome dark with a blue accent.',
  colors: ACE_DESKTOP_COLORS,
  darkColors: ACE_DESKTOP_COLORS,
  typography: {
    fontSans: '-apple-system, BlinkMacSystemFont, "SF Pro Text", Inter, system-ui, sans-serif',
    fontMono: '"SF Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
  },
};
// Runs in the embedded webview on every load. Writes Hermes's theme localStorage
// keys, then reloads ONCE per session if anything changed (Hermes reads its theme
// registry once at module load, so freshly-written keys need one reload to take —
// the boot-* keys make that reload paint Ace-dark with no flash). The
// safety-net <style> covers the two holdouts applyTheme never writes inline
// (hardcoded light input bg + amber selection).
const ACE_THEME_BOOTSTRAP_SCRIPT = `(() => {
  try {
    var THEME = ${JSON.stringify(ACE_DESKTOP_THEME)};
    var ls = window.localStorage;
    var changed = false;
    var users = {};
    try { var rawU = ls.getItem('hermes-desktop-user-themes-v1'); users = rawU ? JSON.parse(rawU) : {}; if (!users || typeof users !== 'object' || Array.isArray(users)) users = {}; } catch (e) { users = {}; }
    if (JSON.stringify(users.ace) !== JSON.stringify(THEME)) { users.ace = THEME; ls.setItem('hermes-desktop-user-themes-v1', JSON.stringify(users)); changed = true; }
    if (ls.getItem('hermes-desktop-theme-v2') !== 'ace') { ls.setItem('hermes-desktop-theme-v2', 'ace'); changed = true; }
    var prof = {};
    try { var rawP = ls.getItem('hermes-desktop-profile-themes-v1'); prof = rawP ? JSON.parse(rawP) : {}; if (!prof || typeof prof !== 'object' || Array.isArray(prof)) prof = {}; } catch (e) { prof = {}; }
    var profChanged = (prof.default !== 'ace'); prof.default = 'ace';
    for (var pk in prof) { if (Object.prototype.hasOwnProperty.call(prof, pk) && prof[pk] !== 'ace') { prof[pk] = 'ace'; profChanged = true; } }
    if (profChanged) { ls.setItem('hermes-desktop-profile-themes-v1', JSON.stringify(prof)); changed = true; }
    if (ls.getItem('hermes-desktop-mode-v1') !== 'dark') { ls.setItem('hermes-desktop-mode-v1', 'dark'); changed = true; }
    if (ls.getItem('hermes-boot-background') !== '#171717') { ls.setItem('hermes-boot-background', '#171717'); }
    if (ls.getItem('hermes-boot-color-scheme') !== 'dark') { ls.setItem('hermes-boot-color-scheme', 'dark'); }
    var SN = ':root{--ui-bg-input:#1c1c1c !important;--ui-selection-background:rgba(60,131,246,0.40) !important;}';
    var styleEl = document.getElementById('__ace-theme-safetynet');
    if (!styleEl) { styleEl = document.createElement('style'); styleEl.id = '__ace-theme-safetynet'; (document.head || document.documentElement).appendChild(styleEl); }
    if (styleEl.textContent !== SN) styleEl.textContent = SN;
    // Reload once so Hermes re-reads the freshly written theme keys. Guard in
    // localStorage (the SAME store the theme keys live in) plus an in-memory
    // flag — NOT sessionStorage, which iOS clears when it suspends a backgrounded
    // PWA, defeating the guard and re-firing location.reload() on every return to
    // Teams. With the guard co-located with the theme keys: if localStorage
    // survives, 'changed' is already false (no reload); if it's evicted, the guard
    // is gone with it and one legitimate reload reapplies the theme.
    var guard = !!window.__aceThemeReloaded;
    try { if (ls.getItem('__ace_theme_reloaded') === '1') guard = true; } catch (e) {}
    if (changed && !guard) {
      try { ls.setItem('__ace_theme_reloaded', '1'); } catch (e) {}
      window.__aceThemeReloaded = true;
      location.reload();
    }
  } catch (e) {}
})();`;

const HERMES_MOBILE_SIDEBAR_WIDTH = 700;
const PROFILE_SWITCH_CONFIRM_TIMEOUT_MS = 4_000;
const PROFILE_SYNC_POLL_INTERVAL_MS = 10_000;

const HERMES_EMBED_CSS = `
  html,
  body,
  #root {
    width: 100% !important;
    height: 100% !important;
    min-height: 0 !important;
    margin: 0 !important;
    overflow: hidden !important;
  }

  #root > * {
    min-height: 0 !important;
    height: 100% !important;
  }

  @media (max-width: 700px) {
    div:has(> [data-pane-main]) {
      grid-template-columns: minmax(0, 1fr) !important;
    }

    [data-pane-main] {
      grid-column: 1 / -1 !important;
    }

    [data-pane-id="chat-sidebar"] {
      bottom: 0 !important;
      box-shadow: 16px 0 40px rgba(15, 23, 42, 0.18) !important;
      height: 100% !important;
      left: 0 !important;
      max-width: 88vw !important;
      position: fixed !important;
      right: auto !important;
      top: 0 !important;
      transform: none !important;
      width: min(18rem, 88vw) !important;
      z-index: 50 !important;
    }

    [data-pane-id="chat-sidebar"][data-pane-open="false"]:not([data-pane-hover-reveal="open"]),
    [data-pane-id="preview"][data-pane-open="false"],
    [data-pane-id="review"][data-pane-open="false"]:not([data-pane-hover-reveal="open"]),
    [data-pane-id="file-browser"][data-pane-open="false"] {
      display: none !important;
    }

    /* On phones the sessions pane is force-collapsed into the SPA's hover-reveal
       overlay, where data-pane-open stays "false" and openness is signalled by
       data-pane-hover-reveal="open" (set when the host-chrome Sessions toggle
       dispatches hermes:pane-toggle-reveal). Surface that as the drawer instead
       of leaving it hidden — the rule above no longer hides it in this state. */
    [data-pane-id="chat-sidebar"][data-pane-hover-reveal="open"] {
      display: block !important;
    }

    [data-pane-id="preview"]:not([data-pane-open="false"]),
    [data-pane-id="review"]:not([data-pane-open="false"]),
    [data-pane-id="review"][data-pane-hover-reveal="open"],
    [data-pane-id="file-browser"]:not([data-pane-open="false"]) {
      background: rgba(248, 250, 252, 0.98) !important;
      bottom: 0 !important;
      box-shadow: -16px 0 40px rgba(15, 23, 42, 0.18) !important;
      display: flex !important;
      height: 100% !important;
      max-width: 88vw !important;
      min-width: 0 !important;
      overflow: hidden !important;
      position: fixed !important;
      right: 0 !important;
      top: 0 !important;
      transform: none !important;
      width: min(20rem, 88vw) !important;
      z-index: 60 !important;
    }

    [data-pane-id="preview"][data-ace-mobile-suppressed="true"],
    [data-pane-id="review"][data-ace-mobile-suppressed="true"],
    [data-pane-id="file-browser"][data-ace-mobile-suppressed="true"] {
      display: none !important;
    }

    body[data-ace-keyboard-open="true"] [data-pane-main] {
      padding-bottom: var(--ace-mobile-keyboard-inset, 0px) !important;
    }

    body[data-ace-keyboard-open="true"] input:focus,
    body[data-ace-keyboard-open="true"] textarea:focus,
    body[data-ace-keyboard-open="true"] [contenteditable="true"]:focus {
      scroll-margin-bottom: calc(var(--ace-mobile-keyboard-inset, 0px) + 1rem) !important;
    }

  }

  /* Ace renders its own Chrome-style lane tabs in host chrome, so on
     desktop widths visually retire the Hermes app's foot rail once the host
     tabs are live (body[data-ace-host-tabs="on"], set by the host pane).
     Kept in the DOM (not display:none) and clickable so host tabs can drive
     the SPA's own profile switch. On mobile widths the rail keeps its native
     look (the small per-profile squares) — the previous white "PROFILES" box
     restyle is gone for good. */
  @media (min-width: ${HERMES_MOBILE_SIDEBAR_WIDTH + 1}px) {
    body[data-ace-host-tabs="on"] [data-pane-id="chat-sidebar"] [role="tablist"][aria-label="Profiles"] {
      clip: rect(0 0 0 0) !important;
      clip-path: inset(50%) !important;
      height: 1px !important;
      width: 1px !important;
      margin: -1px !important;
      padding: 0 !important;
      border: 0 !important;
      overflow: hidden !important;
      position: absolute !important;
      white-space: nowrap !important;
    }
  }
`;

const HERMES_MOBILE_ADAPTATIONS_SCRIPT = `
  (() => {
    try {
    const cleanProfileName = (value) => {
      const raw = String(value || '')
        .replace(/^Reorder\\s+/i, '')
        .replace(/^(?:switch to|activate|select|use)\\s+(?:the\\s+)?profile\\s+/i, '')
        .replace(/^profile:\\s*/i, '')
        .replace(/\\s+/g, ' ')
        .trim();
      if (!raw || /^(profiles?|show all profiles|all|manage(?: profiles?)?\\.{0,3}|new(?: profile)?|more)$/i.test(raw)) return '';
      if (/session actions|keyboard shortcuts|settings|sidebar/i.test(raw)) return '';
      return raw
        .replace(/[-_]+/g, ' ')
        .replace(/\\b\\w/g, (letter) => letter.toUpperCase());
    };

    const enhanceProfiles = () => {
      if (window.__aceHermesEnhancingProfiles) return 0;
      window.__aceHermesEnhancingProfiles = true;
      const tablist = document.querySelector('[role="tablist"][aria-label="Profiles"]');
      if (!tablist) {
        window.__aceHermesEnhancingProfiles = false;
        return 0;
      }
      try {
        const items = Array.from(
          tablist.querySelectorAll('[aria-label], [title], button, [role="button"], [tabindex]')
        );
        let profiles = 0;
        for (const item of items) {
          if (item === tablist) continue;
          const rawLabel = String(
            item.getAttribute('aria-label') || item.getAttribute('title') || item.textContent || ''
          ).replace(/\\s+/g, ' ').trim();
          // Tag-only: never rewrite the rail's text or order — the rail keeps
          // its native look (small profile squares); tags exist for the host
          // tab read/click scripts.
          if (/^(?:show all profiles|all)$/i.test(rawLabel)) {
            item.setAttribute('data-ace-profile-action', 'all');
            if (!item.getAttribute('aria-label')) item.setAttribute('aria-label', rawLabel);
            continue;
          }
          if (/^(?:new profile|new)$/i.test(rawLabel)) {
            item.setAttribute('data-ace-profile-action', 'new');
            if (!item.getAttribute('aria-label')) item.setAttribute('aria-label', rawLabel);
            continue;
          }
          if (/^manage(?: profiles?)?\\.{0,3}$/i.test(rawLabel)) {
            item.setAttribute('data-ace-profile-action', 'manage');
            if (!item.getAttribute('aria-label')) item.setAttribute('aria-label', rawLabel);
            continue;
          }
          const label = cleanProfileName(rawLabel);
          if (!label) continue;
          const key = label.toLowerCase().replace(/\\s+/g, '');
          item.setAttribute('data-ace-profile-name', label);
          item.setAttribute('data-ace-profile-key', key);
          if (!item.getAttribute('aria-label')) item.setAttribute('aria-label', label);
          if (!item.getAttribute('title')) item.setAttribute('title', label);
          profiles += 1;
        }
        return profiles;
      } finally {
        window.__aceHermesEnhancingProfiles = false;
      }
    };

    const mobileTextEditorSelector = 'textarea, input, [role="textbox"], [contenteditable]:not([contenteditable="false"])';
    const mobileTextExcludedContainers = [
        '[data-pane-id="terminal"]',
        '[data-ace-terminal]',
        '.xterm',
        '.monaco-editor',
        '[data-code-editor]',
        'pre',
        'code',
        '[role="tree"]',
        '[role="menu"]',
      ].join(',');

    const isMobileTextEditor = (el) => {
      if (!(el instanceof Element)) return false;
      if (!el.matches(mobileTextEditorSelector)) return false;
      if (el.closest(mobileTextExcludedContainers)) return false;
      if (el.matches('input')) {
        const type = (el.getAttribute('type') || 'text').toLowerCase();
        if (!/^(?:text|search)$/.test(type)) return false;
      }
      if (el.matches('[role="combobox"], [aria-autocomplete="list"]')) return false;
      return true;
    };

    const enableMobileTextAssistance = () => {
      if (window.innerWidth > ${HERMES_MOBILE_SIDEBAR_WIDTH}) return 0;
      const editable = Array.from(document.querySelectorAll(mobileTextEditorSelector));
      let assisted = 0;
      for (const el of editable) {
        if (!isMobileTextEditor(el)) continue;
        el.setAttribute('spellcheck', 'true');
        el.setAttribute('autocorrect', 'on');
        el.setAttribute('autocapitalize', 'sentences');
        el.setAttribute('data-ace-mobile-text-assist', 'on');
        assisted += 1;
      }
      return assisted;
    };

    const installMobileAttachmentFallbacks = () => {
      const bridge = window.hermesDesktop;
      if (!bridge || window.__aceHermesMobileAttachmentFallbacks) return false;
      const ua = String(navigator.userAgent || '');
      if (/Electron/i.test(ua)) return false;
      const files = new Map();
      const original = {
        getPathForFile: bridge.getPathForFile?.bind(bridge),
        readFileDataUrl: bridge.readFileDataUrl?.bind(bridge),
        readFileText: bridge.readFileText?.bind(bridge),
        selectPaths: bridge.selectPaths?.bind(bridge),
      };
      const rememberFile = (file) => {
        if (!file) return '';
        const id =
          'ace-mobile-file://' +
          (window.crypto?.randomUUID?.() || Date.now() + '-' + Math.random().toString(16).slice(2)) +
          '/' +
          encodeURIComponent(file.name || 'attachment');
        files.set(id, file);
        return id;
      };
      const fileFor = (target) => files.get(String(target || ''));
      const filenameFor = (target) => {
        const file = fileFor(target);
        if (file?.name) return file.name;
        try {
          return decodeURIComponent(String(target || '').split('/').pop() || 'attachment');
        } catch {
          return 'attachment';
        }
      };
      const fileToDataUrl = (file) =>
        new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
          reader.onerror = () => reject(reader.error || new Error('FileReader failed'));
          reader.readAsDataURL(file);
        });
      const enrichGatewayAttachmentRpc = async (frame) => {
        if (!frame || typeof frame !== 'object') return frame;
        const params = frame.params && typeof frame.params === 'object' ? frame.params : {};
        const path = String(params?.path || '');
        const file = fileFor(path);
        if (!file) return frame;
        const dataUrl = await fileToDataUrl(file);
        if (!dataUrl) return frame;
        if (frame.method === 'file.attach') {
          return {
            ...frame,
            params: { ...params, data_url: params?.data_url || dataUrl, name: params?.name || filenameFor(path) },
          };
        }
        if (frame.method === 'image.attach') {
          return {
            ...frame,
            method: 'image.attach_bytes',
            params: { ...params, content_base64: dataUrl, filename: params?.filename || filenameFor(path) },
          };
        }
        return frame;
      };
      if (!window.__aceHermesMobileAttachmentRpcPatched && window.WebSocket?.prototype?.send) {
        const originalSend = window.WebSocket.prototype.send;
        window.WebSocket.prototype.send = function (payload) {
          if (typeof payload !== 'string') return originalSend.call(this, payload);
          let frame;
          try {
            frame = JSON.parse(payload);
          } catch {
            return originalSend.call(this, payload);
          }
          if (frame?.method !== 'file.attach' && frame?.method !== 'image.attach') {
            return originalSend.call(this, payload);
          }
          enrichGatewayAttachmentRpc(frame)
            .then((next) => originalSend.call(this, JSON.stringify(next)))
            .catch(() => originalSend.call(this, payload));
        };
        window.__aceHermesMobileAttachmentRpcPatched = true;
      }
      const fileToText = (file) =>
        new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
          reader.onerror = () => reject(reader.error || new Error('FileReader failed'));
          reader.readAsText(file.slice(0, 512 * 1024));
        });
      bridge.getPathForFile = (file) => {
        const path = original.getPathForFile?.(file);
        if (path) {
          if (String(path).startsWith('ace-mobile-file://') && file) files.set(String(path), file);
          return path;
        }
        return rememberFile(file);
      };
      bridge.selectPaths = (options = {}) => {
        if (options?.directories) return [];
        if (original.selectPaths) return original.selectPaths(options);
        return new Promise((resolve) => {
          const input = document.createElement('input');
          input.type = 'file';
          input.multiple = options?.multiple !== false;
          input.style.position = 'fixed';
          input.style.left = '-10000px';
          input.style.top = '0';
          input.addEventListener('change', () => {
            const pickedFiles = Array.from(input.files || []);
            input.remove();
            resolve(pickedFiles.map(rememberFile).filter(Boolean));
          }, { once: true });
          input.addEventListener('cancel', () => {
            input.remove();
            resolve([]);
          }, { once: true });
          document.body.appendChild(input);
          input.click();
        });
      };
      bridge.readFileDataUrl = async (target) => {
        const file = fileFor(target);
        if (file) return await fileToDataUrl(file);
        return original.readFileDataUrl?.(target);
      };
      bridge.readFileText = async (target) => {
        const file = fileFor(target);
        if (!file) return original.readFileText?.(target);
        const text = await fileToText(file);
        return {
          binary: text.includes('\\u0000'),
          byteSize: file.size,
          language: 'text',
          mimeType: file.type || 'application/octet-stream',
          path: String(target || ''),
          text,
          truncated: file.size > 512 * 1024,
        };
      };
      window.__aceHermesMobileAttachmentFallbacks = true;
      return true;
    };

    const closeMobileRightDrawer = (drawer) => {
      if (!drawer) return false;
      const id = drawer.getAttribute('data-pane-id');
      if (id && drawer.getAttribute('data-pane-hover-reveal') === 'open') {
        window.dispatchEvent(new CustomEvent('hermes:pane-toggle-reveal', { detail: { id } }));
        return true;
      }
      const controls = Array.from(drawer.querySelectorAll('button, [role="button"]'));
      const close = controls.find((control) => {
        const label = String(
          control.getAttribute('aria-label') ||
          control.getAttribute('title') ||
          control.textContent ||
          ''
        ).replace(/\\s+/g, ' ').trim();
        if (/^(?:close|dismiss|hide|collapse)(?:\\s+(?:panel|drawer|sidebar|preview|review|file browser|files|diffs?))?$/i.test(label)) {
          return true;
        }
        return control.querySelector?.('.codicon-close, .codicon-chrome-close, [data-lucide="x"]');
      });
      if (close) {
        close.click();
        return true;
      }
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      return false;
    };

    const teardownMobileRightDrawerOutsideTap = () => {
      if (window.__aceRightDrawerOutsideTap) {
        document.removeEventListener('pointerdown', window.__aceRightDrawerOutsideTap, true);
        window.__aceRightDrawerOutsideTap = null;
      }
      window.__aceRightDrawerOutsideTapId = null;
    };

    const armMobileRightDrawerOutsideTap = (activeDrawer) => {
      if (!activeDrawer || window.innerWidth > ${HERMES_MOBILE_SIDEBAR_WIDTH}) {
        teardownMobileRightDrawerOutsideTap();
        return;
      }
      const activeId = activeDrawer.getAttribute('data-pane-id') || '';
      if (window.__aceRightDrawerOutsideTap && window.__aceRightDrawerOutsideTapId === activeId) return;
      teardownMobileRightDrawerOutsideTap();
      const handler = (event) => {
        const drawer = document.querySelector('[data-pane-id="' + activeId + '"]');
        if (!drawer || !isMobileRightDrawerOpen(drawer)) {
          teardownMobileRightDrawerOutsideTap();
          return;
        }
        if (drawer.contains(event.target)) return;
        teardownMobileRightDrawerOutsideTap();
        closeMobileRightDrawer(drawer);
      };
      window.__aceRightDrawerOutsideTap = handler;
      window.__aceRightDrawerOutsideTapId = activeId;
      setTimeout(() => {
        if (window.__aceRightDrawerOutsideTap === handler) {
          document.addEventListener('pointerdown', handler, true);
        }
      }, 0);
    };

    const isMobileRightDrawerOpen = (drawer) =>
      drawer.getAttribute('data-pane-open') !== 'false' ||
      drawer.getAttribute('data-pane-hover-reveal') === 'open';

    const syncMobileRightDrawers = (activeHint) => {
      const drawerIds = ['preview', 'review', 'file-browser'];
      const drawers = drawerIds
        .map((id) => document.querySelector('[data-pane-id="' + id + '"]'))
        .filter(Boolean);
      if (window.innerWidth > ${HERMES_MOBILE_SIDEBAR_WIDTH}) {
        drawers.forEach((drawer) => drawer.removeAttribute('data-ace-mobile-suppressed'));
        window.__aceHermesActiveRightDrawer = null;
        teardownMobileRightDrawerOutsideTap();
        return null;
      }
      const openDrawers = drawers.filter(isMobileRightDrawerOpen);
      if (openDrawers.length === 0) {
        teardownMobileRightDrawerOutsideTap();
        window.__aceHermesActiveRightDrawer = null;
        return null;
      }
      if (activeHint && openDrawers.some((drawer) => drawer.getAttribute('data-pane-id') === activeHint)) {
        window.__aceHermesActiveRightDrawer = activeHint;
      }
      if (openDrawers.length <= 1) {
        drawers.forEach((drawer) => drawer.removeAttribute('data-ace-mobile-suppressed'));
        armMobileRightDrawerOutsideTap(openDrawers[0]);
        return openDrawers[0]?.getAttribute('data-pane-id') || null;
      }
      const active =
        openDrawers.find((drawer) => drawer.getAttribute('data-pane-id') === window.__aceHermesActiveRightDrawer) ||
        openDrawers[openDrawers.length - 1];
      const activeId = active.getAttribute('data-pane-id');
      window.__aceHermesActiveRightDrawer = activeId;
      openDrawers.forEach((drawer) => {
        if (drawer.getAttribute('data-pane-id') === activeId) {
          drawer.removeAttribute('data-ace-mobile-suppressed');
        } else {
          drawer.setAttribute('data-ace-mobile-suppressed', 'true');
        }
      });
      armMobileRightDrawerOutsideTap(active);
      return activeId;
    };

    const applyKeyboardInset = () => {
      const viewport = window.visualViewport;
      const inset = viewport
        ? Math.max(0, Math.round(window.innerHeight - viewport.height - viewport.offsetTop))
        : 0;
      const keyboardOpen = window.innerWidth <= ${HERMES_MOBILE_SIDEBAR_WIDTH} && inset > 32;
      document.documentElement.style.setProperty('--ace-mobile-keyboard-inset', keyboardOpen ? inset + 'px' : '0px');
      document.body?.toggleAttribute('data-ace-keyboard-open', keyboardOpen);
      return inset;
    };

    if (!window.__aceHermesVisualViewportBound) {
      const viewport = window.visualViewport;
      viewport?.addEventListener?.('resize', applyKeyboardInset);
      viewport?.addEventListener?.('scroll', applyKeyboardInset);
      window.addEventListener('resize', applyKeyboardInset);
      window.addEventListener('focusin', applyKeyboardInset);
      window.__aceHermesVisualViewportBound = true;
    }

    const profileCount = enhanceProfiles();
    const attachmentFallbacks = installMobileAttachmentFallbacks();
    const textAssisted = enableMobileTextAssistance();
    const activeDrawer = syncMobileRightDrawers();
    const keyboardInset = applyKeyboardInset();
    if (!window.__aceHermesProfileObserver) {
      window.__aceHermesPendingActiveRightDrawer = null;
      const flushAdaptationRefresh = () => {
        window.__aceHermesAdaptationRefreshTimer = null;
        const activeHint = window.__aceHermesPendingActiveRightDrawer;
        window.__aceHermesPendingActiveRightDrawer = null;
        enhanceProfiles();
        installMobileAttachmentFallbacks();
        enableMobileTextAssistance();
        syncMobileRightDrawers(activeHint);
        applyKeyboardInset();
      };
      const scheduleAdaptationRefresh = (activeHint) => {
        if (activeHint) window.__aceHermesPendingActiveRightDrawer = activeHint;
        if (window.__aceHermesAdaptationRefreshTimer) return;
        window.__aceHermesAdaptationRefreshTimer = setTimeout(flushAdaptationRefresh, 150);
      };
      const observer = new MutationObserver((mutations) => {
        let activeHint = null;
        for (const mutation of mutations) {
          const target = mutation.target;
          if (!(target instanceof Element)) continue;
          const pane = target.closest?.('[data-pane-id="preview"], [data-pane-id="review"], [data-pane-id="file-browser"]');
          if (pane && isMobileRightDrawerOpen(pane)) {
            activeHint = pane.getAttribute('data-pane-id') || activeHint;
          }
        }
        scheduleAdaptationRefresh(activeHint);
      });
      observer.observe(document.body, {
        attributes: true,
        attributeFilter: [
          'aria-label',
          'aria-pressed',
          'aria-selected',
          'data-pane-hover-reveal',
          'data-pane-open',
          'data-state',
          'title',
        ],
        childList: true,
        subtree: true,
      });
      window.__aceHermesProfileObserver = observer;
    }

    // Leave the Hermes sidebar/session rail under user control on mobile. The
    // old one-time auto-click made the left chrome look broken and hid other
    // sessions immediately after load.
    return { profiles: profileCount, collapsed: false, activeDrawer, keyboardInset, textAssisted, attachmentFallbacks };
    } catch (error) {
      return {
        profiles: 0,
        collapsed: false,
        textAssisted: 0,
        attachmentFallbacks: false,
        error: error && (error.message || String(error)),
      };
    }
  })()
`;

export function HermesDesktopAppPane({
  onPhaseChange,
}: {
  /** Read-only mirror of the embed phase for host chrome. Never drives the
   *  pane: the pane's own lifecycle is unchanged whether or not this is set. */
  onPhaseChange?: (phase: HermesFramePhase) => void;
} = {}) {
  const remote = isRemoteClient();
  const [state, setState] = useState<AppFrameState>(INITIAL_STATE);
  const [frameLoaded, setFrameLoaded] = useState(false);
  const [hasLoadedFrame, setHasLoadedFrame] = useState(false);
  const [frameSize, setFrameSize] = useState({ width: 0, height: 0 });
  const operators = useOperators();
  // Hermes profiles as read out of the embedded frame by syncProfiles. Feeds
  // the host lane tabs' ACTIVE state; the tab roster itself comes from the
  // operators registry so the tabs render even when the DOM read fails (the
  // mobile sidecar web UI's rail is icon-only and not always taggable).
  const [profiles, setProfiles] = useState<ProfileTab[]>([]);
  // Lane the user just clicked, until the embed read confirms the switch.
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const webviewRef = useRef<WebviewEl | null>(null);
  const profileSwitchSeq = useRef(0);
  const profileSwitchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Coalesces overlapping ensure() calls (mount + 'started' event + manual
  // Retry) so a single boot never fires multiple concurrent backend ensures.
  const ensureInFlight = useRef(false);
  // Latest state read inside event callbacks without re-subscribing.
  const stateRef = useRef(state);
  stateRef.current = state;
  // Latest scraped profiles (incl. in-frame switches) for the []-dep sweep callback.
  const profilesRef = useRef(profiles);
  profilesRef.current = profiles;
  const frameLoadedRef = useRef(frameLoaded);
  frameLoadedRef.current = frameLoaded;
  const hasLoadedFrameRef = useRef(hasLoadedFrame);
  hasLoadedFrameRef.current = hasLoadedFrame;
  const resumeResyncAtRef = useRef(0);
  // Monotonic per-document id, bumped on did-start-loading (see homeRestoreResultIsStale).
  const loadGenerationRef = useRef(0);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const update = () => {
      const rect = host.getBoundingClientRect();
      setFrameSize((prev) => {
        const width = Math.max(0, Math.round(rect.width));
        const height = Math.max(0, Math.round(rect.height));
        return prev.width === width && prev.height === height ? prev : { width, height };
      });
    };

    update();
    const observer = new ResizeObserver(update);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  // Mirror the phase to host chrome. Purely outbound — nothing here reads back
  // into the embed, so a host with no listener behaves identically.
  useEffect(() => {
    onPhaseChange?.(state.phase);
  }, [onPhaseChange, state.phase]);

  const ensure = useCallback(async (options: { markStarting?: boolean } = {}) => {
    if (ensureInFlight.current) return;
    ensureInFlight.current = true;
    if (options.markStarting !== false) {
      if (stateRef.current.phase !== 'live' && !hasLoadedFrameRef.current) setHasLoadedFrame(false);
      setState((prev) => ({ ...prev, phase: 'starting', error: null, url: null, preload: null }));
      frameLoadedRef.current = false;
      setFrameLoaded(false);
    }
    const ensureStarted = perfNow();
    try {
      const result = await aceApi.hermesDesktop.ensure();
      recordPerf({
        kind: 'span',
        name: 'teams.hermes.ensure',
        durationMs: perfNow() - ensureStarted,
        meta: { ok: result.ok === true },
      });
      if (!result.ok) {
        setState({
          phase: 'error',
          url: null,
          preload: null,
          error: result.error,
          ownerKey: result.ownerKey ?? HERMES_DESKTOP_APP_OWNER_KEY,
        });
        return;
      }
      let url = remote ? result.remotePath || HERMES_DESKTOP_REMOTE_PATH : result.url;
      if (url) {
        // Native profile hero on first load (desktop webview AND mobile iframe):
        // tag the URL with the active profile so the forked Hermes intro renders
        // the operator identity right away. Replaces the retired host-side DOM
        // title scrape; switches keep using reloadFrameForProfile's aceProfile
        // rewrite. getActiveProfile resolves over the remote API on mobile
        // (aceStore passthrough), so the same path serves both surfaces.
        try {
          const active = await aceApi.hermesDesktop.getActiveProfile();
          const name = String(active?.profile || '').trim();
          if (name) {
            const withProfile = new URL(url, window.location.origin);
            withProfile.searchParams.set('aceProfile', name);
            url = withProfile.toString();
          }
        } catch {
          // Non-fatal: the native hero falls back to its default label.
        }
      }
      if (remote) {
        const res = await fetch(url, { cache: 'no-store', credentials: 'include' });
        if (!res.ok) {
          // 401/403 means this device's session is the problem; anything else
          // (especially 404 "Frontend not built") is the sidecar itself —
          // telling the user to re-enroll for a server-side fault sends them
          // chasing the wrong fix.
          const authProblem = res.status === 401 || res.status === 403;
          setState({
            phase: 'error',
            url: null,
            preload: null,
            error: authProblem
              ? `The Hermes Desktop remote surface rejected this device (HTTP ${res.status}). Re-enroll this device if the session expired.`
              : `The Hermes Desktop backend is not serving its web UI (HTTP ${res.status}). This is a server-side fault — check the Hermes sidecar, not device enrollment.`,
            ownerKey: result.ownerKey,
          });
          return;
        }
        // A redirect that escapes /hermes-desktop lands on the Ace SPA
        // fallback: embedding that response nests Ace inside itself.
        if (isOutsideHermesRemotePath(res.url, window.location.origin)) {
          setState({
            phase: 'error',
            url: null,
            preload: null,
            error:
              'The Hermes Desktop proxy answered from outside its /hermes-desktop path, so embedding it would nest Ace inside itself. This is a server-side fault — check the Hermes sidecar, not device enrollment.',
            ownerKey: result.ownerKey,
          });
          return;
        }
      }
      setState({
        phase: 'live',
        url,
        preload: remote ? null : result.preloadUrl || result.preloadPath || null,
        // The remote surface proxies through a stable /hermes-desktop path, so
        // it is restart-durable like the desktop bundle. Only the LOCAL
        // bundle-less fallback is pinned to a per-spawn port.
        surface: !remote && result.surface === 'web' ? 'web' : 'desktop',
        error: null,
        ownerKey: result.ownerKey,
      });
    } catch (err) {
      recordPerf({
        kind: 'span',
        name: 'teams.hermes.ensure',
        durationMs: perfNow() - ensureStarted,
        meta: { ok: false },
      });
      setState({
        phase: 'error',
        url: null,
        preload: null,
        error: err instanceof Error ? err.message : String(err),
        ownerKey: HERMES_DESKTOP_APP_OWNER_KEY,
      });
    } finally {
      ensureInFlight.current = false;
    }
  }, [remote]);

  // Run a script inside whichever embed frame is live and resolve with its
  // value. The desktop webview uses executeJavaScript; the mobile/remote iframe
  // is same-origin (served by Ace's own remote server) so it uses eval.
  // Either path may be blocked (mid-nav, or a strict CSP) — callers treat an
  // undefined result as "nothing read yet" and retry.
  const runInFrame = useCallback(
    (script: string): Promise<unknown> => {
      // Electron queues executeJavaScript behind did-stop-loading while a
      // webview is still navigating. Several eager adaptation/profile reads
      // can otherwise pile up listeners before dom-ready and trigger a real
      // MaxListeners warning. Every caller retries from a load callback or a
      // bounded timer, so wait until this exact frame reports ready.
      if (!frameLoadedRef.current) return Promise.resolve(undefined);
      if (remote) {
        try {
          const win = iframeRef.current?.contentWindow as
            | (Window & { eval?: (code: string) => unknown })
            | null;
          if (!win?.eval) return Promise.resolve(undefined);
          return Promise.resolve(win.eval(script));
        } catch {
          return Promise.resolve(undefined);
        }
      }
      const el = webviewRef.current;
      if (!el?.executeJavaScript) return Promise.resolve(undefined);
      return el.executeJavaScript(script).catch(() => undefined);
    },
    [remote]
  );

  const reloadFrameForProfile = useCallback(
    (profile: string | null) => {
      const current = stateRef.current;
      if (current.phase !== 'live' || !current.url) return false;
      let nextUrl = current.url;
      try {
        const url = new URL(current.url, window.location.origin);
        const name = String(profile || '').trim();
        if (name) {
          url.searchParams.set('aceProfile', name);
        } else {
          url.searchParams.delete('aceProfile');
        }
        url.searchParams.set('aceProfileReload', String(Date.now()));
        nextUrl = url.toString();
      } catch {
        // Keep the current URL; nextUrl stays the live one (no-op reload).
      }
      if (nextUrl === current.url) return false;
      setHasLoadedFrame((prev) => prev || frameLoadedRef.current || hasLoadedFrameRef.current);
      frameLoadedRef.current = false;
      setFrameLoaded(false);
      // React state is the SINGLE source of truth for the frame URL: the iframe
      // and webview bind src={state.url} with key on state.url, so bumping the
      // state remounts the frame and navigates to nextUrl. Mutating .src /
      // .loadURL imperatively (the previous approach) left state.url stale, so
      // any later re-render — notably toggling off Teams and back (R3) — reverted
      // the frame to the pre-switch profile and reconnected the old session.
      setState((prev) => (prev.phase === 'live' ? { ...prev, url: nextUrl } : prev));
      return true;
    },
    []
  );

  // The operator profile the LIVE frame is bound to. An in-frame rail switch
  // moves the active profile without rewriting the embed URL, so the scraped
  // active tab wins over the URL's aceProfile (stale after such a switch);
  // restore/sync calls bind this identity at invocation so an async result
  // started under one profile can never act on another's frame.
  const activeEmbedProfile = useCallback(
    () =>
      resolveActiveEmbedProfile(profilesRef.current, stateRef.current.url, window.location.origin),
    []
  );

  // Cron-sync results are never silently discarded: an unsupported sidecar
  // (append capability absent) is surfaced once to the perf/telemetry spine
  // so the nonfunctional state is operationally visible, not just retried.
  // Declared before every callback that lists it as a dependency (TDZ).
  const cronSyncUnsupportedReportedRef = useRef(false);
  const runCronHomeDeliverySync = useCallback(() => {
    void aceApi.hermesDesktop
      .cronHomeDeliverySync(activeEmbedProfile())
      .then((result) => {
        if (result?.unsupported && !cronSyncUnsupportedReportedRef.current) {
          cronSyncUnsupportedReportedRef.current = true;
          recordPerf({
            kind: 'span',
            name: 'teams.hermes.cronHomeDeliveryUnsupported',
            durationMs: 0,
            meta: { ok: false, reason: result.reason ?? 'append-route-unsupported' },
          });
        }
      })
      .catch(() => {});
  }, [activeEmbedProfile]);

  const resyncFrameForResume = useCallback(() => {
    if (!frameLoadedRef.current) return;
    const current = stateRef.current;
    if (current.phase !== 'live') return;
    const now = Date.now();
    if (now - resumeResyncAtRef.current < 5_000) return;
    resumeResyncAtRef.current = now;
    void runInFrame(HERMES_RESUME_SCRIPT);
    // Piggyback the exactly-once cron → home-chat delivery sweep on the same
    // resume signal, throttled by the 5s gate above and coalesced in main.
    runCronHomeDeliverySync();
  }, [runCronHomeDeliverySync, runInFrame]);

  // Canonical home-chat restore (the vector-home-session fix), once per
  // loaded DOCUMENT. The guard is the in-frame __aceHomeRestoreRan latch —
  // fresh on every reload — so a same-URL reload (new document, possibly a
  // wiped partition) restores again, while re-fired load events on one
  // document stay no-ops. Main resolves the canonical session by explicit id
  // (cron/worker/test/maintenance and other-profile sessions excluded); the
  // seed script itself is cold-start-only, so an explicit New Chat is never
  // overridden. The cron delivery sweep rides the same signal; the
  // main-process claim ledger keeps it exactly-once.

  // knownLoaded lets a caller that just marked the frame loaded (the load
  // handlers below) assert it directly, so the entry guard never depends on the
  // frameLoaded ref/state having been flushed on this same synchronous tick.
  const maybeRestoreHomeSession = useCallback((knownLoaded = false) => {
    if (stateRef.current.phase !== 'live' || !(knownLoaded || frameLoadedRef.current)) return;
    // Bind the live document's identity (generation/url/profile) so a restore that
    // resolves after the document was replaced is rejected (homeRestoreResultIsStale).
    const generationAtStart = loadGenerationRef.current;
    const urlAtStart = stateRef.current.url;
    const profileAtStart = activeEmbedProfile();
    void runInFrame('window.__aceHomeRestoreRan === true')
      .then((latched) => {
        if (latched === true) return;
        void aceApi.hermesDesktop
          .homeSessionRestore(profileAtStart)
          .then((result) => {
            if (
              homeRestoreResultIsStale({
                generationAtStart,
                urlAtStart,
                profileAtStart,
                generationNow: loadGenerationRef.current,
                urlNow: stateRef.current.url,
                profileNow: activeEmbedProfile(),
                frameLoaded: frameLoadedRef.current,
              })
            )
              return undefined;
            return result?.script ? runInFrame(result.script) : undefined;
          })
          .catch(() => {});
        runCronHomeDeliverySync();
      });
  }, [activeEmbedProfile, runCronHomeDeliverySync, runInFrame]);

  // Bounded periodic delivery sweep while the embed is live, so a run that
  // completes mid-session reaches the home chat without waiting for a
  // load/resume event. Concurrency-safe: the main-process sweep is coalesced
  // and ledger-idempotent, and every append goes through the sidecar (the
  // sole state.db writer). Torn down with the live frame.
  useEffect(() => {
    if (state.phase !== 'live' || !frameLoaded) return;
    const timer = window.setInterval(() => {
      runCronHomeDeliverySync();
    }, CRON_HOME_SYNC_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [frameLoaded, runCronHomeDeliverySync, state.phase]);

  // Whether the host-chrome lane tabs are currently rendered; mirrored into
  // the embed (data-ace-host-tabs) by syncProfiles so the injected CSS can
  // retire the desktop foot-rail. A ref so syncProfiles needn't re-create.
  const showLaneTabsRef = useRef(false);

  // Read the embedded Hermes profile rail out of the active frame so the host
  // lane tabs track the SPA's own active profile. Cheap DOM query; safe to call
  // on load + on a light interval. Keep this cheap: the full mobile adaptations
  // script installs observers/fallbacks and can be expensive while Hermes is
  // streaming, so profile sync only reads the rail.
  const profileSyncInFlight = useRef(false);
  const syncProfiles = useCallback(async () => {
    if (profileSyncInFlight.current) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    profileSyncInFlight.current = true;
    const started = perfNow();
    let profileCount = 0;
    try {
      const result = (await runInFrame(HERMES_PROFILE_READ_SCRIPT)) as
        | { profiles?: ProfileTab[] }
        | undefined;
      const next = Array.isArray(result?.profiles) ? result!.profiles : [];
      profileCount = next.length;
      setProfiles((prev) => (sameProfiles(prev, next) ? prev : next));
      void runInFrame(hostTabsAttrScript(showLaneTabsRef.current));
    } finally {
      profileSyncInFlight.current = false;
      void recordPerf({
        kind: 'span',
        name: 'teams.hermes.profileSync',
        durationMs: perfNow() - started,
        meta: { profiles: profileCount },
      });
    }
  }, [runInFrame]);

  const handleSelectProfile = useCallback(
    (key: string) => {
      const seq = profileSwitchSeq.current + 1;
      profileSwitchSeq.current = seq;
      if (profileSwitchTimeout.current) {
        window.clearTimeout(profileSwitchTimeout.current);
        profileSwitchTimeout.current = null;
      }
      // Bounded optimistic highlight; cleared once the embed read confirms the
      // switch, or by timeout if the embedded app never actually moves.
      setPendingKey(key);
      profileSwitchTimeout.current = window.setTimeout(() => {
        if (profileSwitchSeq.current !== seq) return;
        setPendingKey(null);
        void syncProfiles();
      }, PROFILE_SWITCH_CONFIRM_TIMEOUT_MS);
      void (async () => {
        let clicked = (await runInFrame(profileClickScript(key))) === true;
        if (!clicked) {
          // One bounded repair attempt before the backend fallback. The fallback
          // re-roots the single Hermes Desktop app sidecar and can force a visible
          // reload; most failures here are just an untagged/unmounted rail.
          await runInFrame(HERMES_MOBILE_ADAPTATIONS_SCRIPT);
          clicked = (await runInFrame(profileClickScript(key))) === true;
        }
        if (!clicked) {
          const fallbackStarted = perfNow();
          try {
            const result = await aceApi.hermesDesktop.setActiveProfile(key);
            recordPerf({
              kind: 'span',
              name: 'teams.hermes.profileFallback',
              durationMs: perfNow() - fallbackStarted,
              meta: { ok: true, changed: result.changed !== false },
            });
            if (result.changed !== false) reloadFrameForProfile(result.profile || key);
          } catch {
            recordPerf({
              kind: 'span',
              name: 'teams.hermes.profileFallback',
              durationMs: perfNow() - fallbackStarted,
              meta: { ok: false },
            });
            // The timeout above clears the optimistic state and the next sync
            // leaves the visible active tab tied to the embedded app state.
          }
        }
        window.setTimeout(() => void syncProfiles(), clicked ? 120 : 750);
      })();
    },
    [reloadFrameForProfile, runInFrame, syncProfiles]
  );

  // The embed caught up with the clicked lane — hand active-state tracking
  // back to the read.
  useEffect(() => {
    if (!pendingKey) return;
    if (profiles.some((p) => p.active && p.key === pendingKey)) {
      if (profileSwitchTimeout.current) {
        window.clearTimeout(profileSwitchTimeout.current);
        profileSwitchTimeout.current = null;
      }
      setPendingKey(null);
    }
  }, [pendingKey, profiles]);

  useEffect(() => {
    return () => {
      if (profileSwitchTimeout.current) window.clearTimeout(profileSwitchTimeout.current);
    };
  }, []);

  const handleNewProfile = useCallback(() => {
    void runInFrame(HERMES_PROFILE_NEW_SCRIPT).finally(() => {
      window.setTimeout(() => void syncProfiles(), 200);
    });
  }, [runInFrame, syncProfiles]);

  // Mobile only: drive the embedded SPA's sessions-sidebar toggle from host
  // chrome so the session list is reachable without hunting for the SPA's tiny
  // titlebar codicon. No-op on the desktop webview, which shows full-size
  // titlebar controls already.
  const toggleEmbedSidebar = useCallback(() => {
    void runInFrame(HERMES_SIDEBAR_TOGGLE_SCRIPT);
  }, [runInFrame]);

  // Drop stale tabs whenever the embed is not live (error/restart/leaving).
  useEffect(() => {
    if (state.phase !== 'live') setProfiles([]);
  }, [state.phase]);

  // Light active-state poll so the host tabs track in-app profile switches the
  // user makes inside Hermes; runs on any live surface (desktop or mobile).
  useEffect(() => {
    if (state.phase !== 'live' || !frameLoaded) return;
    void syncProfiles();
    const interval = window.setInterval(() => void syncProfiles(), PROFILE_SYNC_POLL_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [state.phase, state.url, frameLoaded, syncProfiles]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void ensure({ markStarting: false });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [ensure]);

  // No unmount stop: the backend (and any pooled profile backends) must
  // survive everything short of an explicit Stop/Restart, the Lanes surface
  // flip (manager setSurface stopAll), or app shutdown (local-core stopAll).
  // The pane is hosted persistently at the shell level, but it still unmounts
  // on a shell swap (desktop↔mobile resize) — stopping there killed whatever
  // session was streaming inside the embed; remounting re-ensures and
  // reconnects to the still-running backend instead.

  const guestRemountRef = useRef<{ count: number; since: number }>({ count: 0, since: 0 });
  useEffect(() => {
    const unsubscribe = aceApi.hermesDesktop.onEvent((event: HermesDesktopEvent) => {
      if (event.ownerKey && event.ownerKey !== HERMES_DESKTOP_APP_OWNER_KEY) return;
      if (event.type === 'open-link') {
        if (event.url && !requestBrowserOpen(event.url)) {
          void aceApi.workspaces.openExternal(event.url, { forceExternal: true });
        }
        return;
      }
      if (event.type === 'restarting') {
        // Main process is restarting the backend; the file:// renderer is not
        // reloaded, so keep the loaded page (don't blank frameLoaded — that
        // would strand the spinner over working content).
        setState((prev) =>
          prev.phase === 'live'
            ? prev
            : { phase: 'starting', url: null, preload: null, error: null, ownerKey: prev.ownerKey }
        );
      } else if (event.type === 'started') {
        // Backend is up — fetch the URL only if we don't already hold a live
        // one. The in-flight guard in ensure() coalesces overlapping calls.
        //
        // EXCEPT on the bundle-less web surface: there the live URL IS the
        // sidecar's loopback address, and a respawn allocates a fresh port and
        // session token. Holding the old URL would leave the webview pointed at
        // a dead port with no recovery but a manual Retry — the same dead-end
        // this fallback exists to remove. The file:// bundle and the proxied
        // remote path are both restart-durable and keep the old behavior.
        const live = stateRef.current;
        if (live.phase !== 'live' || live.surface === 'web') {
          void ensure({ markStarting: false });
        }
      } else if (event.type === 'guest-renderer-gone') {
        // The embedded renderer crashed (distinct from a backend exit). Remount
        // the webview via React state with a fresh cache-buster — bounded to
        // avoid a hot crash-loop; beyond the ceiling, surface an actionable error.
        const now = Date.now();
        const tracker = guestRemountRef.current;
        if (now - tracker.since > 60_000) {
          tracker.since = now;
          tracker.count = 0;
        }
        if (tracker.count < 3) {
          tracker.count += 1;
          setHasLoadedFrame((prev) => prev || frameLoadedRef.current || hasLoadedFrameRef.current);
          frameLoadedRef.current = false;
          setFrameLoaded(false);
          setState((prev) => {
            if (prev.phase !== 'live' || !prev.url) return prev;
            let next = prev.url;
            try {
              const u = new URL(prev.url);
              u.searchParams.set('__aceGuestReload', String(now));
              next = u.toString();
            } catch {
              next = prev.url + (prev.url.includes('?') ? '&' : '?') + '__aceGuestReload=' + now;
            }
            return { ...prev, url: next };
          });
        } else {
          setHasLoadedFrame(false);
          frameLoadedRef.current = false;
          setFrameLoaded(false);
          setState((prev) => ({
            phase: 'error',
            url: null,
            preload: null,
            error: 'The Hermes Desktop renderer crashed repeatedly. Retry to reconnect.',
            ownerKey: prev.ownerKey ?? HERMES_DESKTOP_APP_OWNER_KEY,
          }));
        }
      } else if (event.type === 'stopped' || event.type === 'exited' || event.type === 'error') {
        // Terminal. The main process owns restart policy (bounded crash-loop
        // ceiling); never auto-re-ensure here — resurrecting a backend the
        // manager deliberately gave up on is the infinite-spinner storm. Surface
        // an actionable error; the Retry / Restart buttons re-ensure on demand.
        setHasLoadedFrame(false);
        frameLoadedRef.current = false;
        setFrameLoaded(false);
        setState((prev) => ({
          phase: 'error',
          url: null,
          preload: null,
          error:
            event.error ||
            (event.type === 'stopped'
              ? 'Hermes Desktop was stopped.'
              : 'Hermes Desktop stopped unexpectedly. Retry to reconnect.'),
          ownerKey: event.ownerKey ?? prev.ownerKey ?? HERMES_DESKTOP_APP_OWNER_KEY,
        }));
      }
    });
    return () => unsubscribe();
  }, [ensure]);

  useEffect(() => {
    if (remote || state.phase !== 'live') return;
    const liveUrl = state.url;
    const ownerKey = state.ownerKey;
    const el = webviewRef.current;
    if (!el) return;
    let retries = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const adaptationTimers = new Set<ReturnType<typeof setTimeout>>();

    const markFrameLoaded = () => {
      frameLoadedRef.current = true;
      setFrameLoaded(true);
      setHasLoadedFrame(true);
    };

    let cssInserted = false;
    const applyHermesAdaptations = () => {
      if (!frameLoadedRef.current) return;
      try {
        el.executeJavaScript?.(ACE_THEME_BOOTSTRAP_SCRIPT).catch(() => {});
      } catch {
        // webview not dom-ready yet; a later adaptation pass retries.
      }
      if (!cssInserted) {
        cssInserted = true;
        try {
          el.insertCSS?.(HERMES_EMBED_CSS).catch(() => {
            cssInserted = false;
          });
        } catch {
          cssInserted = false;
        }
      }
      try {
        el.executeJavaScript?.(HERMES_MOBILE_ADAPTATIONS_SCRIPT).catch(() => {});
      } catch {
        // Electron throws synchronously if the webview is not dom-ready yet.
      }
    };
    const scheduleAdaptations = (delay: number) => {
      const adaptationTimer = window.setTimeout(() => {
        adaptationTimers.delete(adaptationTimer);
        applyHermesAdaptations();
      }, delay);
      adaptationTimers.add(adaptationTimer);
    };
    // did-start-loading fires for every top-level document load/reload but NOT
    // in-page SPA nav, so bumping here (and nowhere else) ids each live document.
    const onStartLoading = () => {
      loadGenerationRef.current += 1;
    };
    const onFinish = () => {
      markFrameLoaded();
      applyHermesAdaptations();
      void syncProfiles();
      maybeRestoreHomeSession(true);
    };
    // Backstops so the loading overlay always clears: did-finish-load can be
    // missed for a hash-route SPA or an in-page navigation, but did-stop-loading
    // and dom-ready still fire.
    const onStopLoading = () => {
      markFrameLoaded();
      applyHermesAdaptations();
      void syncProfiles();
      maybeRestoreHomeSession(true);
    };
    const onDomReady = () => {
      markFrameLoaded();
      applyHermesAdaptations();
      scheduleAdaptations(150);
      scheduleAdaptations(600);
      window.setTimeout(() => void syncProfiles(), 250);
      window.setTimeout(() => void syncProfiles(), 700);
      maybeRestoreHomeSession(true);
    };
    const onFail = (ev: Event) => {
      const anyEv = ev as unknown as { errorCode?: number; isMainFrame?: boolean };
      if (anyEv.isMainFrame === false) return;
      const code = anyEv.errorCode ?? 0;
      if (isAbortedLoadError(code)) return;
      if (isRetryableLoadError(code) && retries < WEBVIEW_MAX_RETRIES) {
        retries += 1;
        timer = setTimeout(() => {
          try {
            el.loadURL(liveUrl).catch(() => {});
          } catch {
            // webview may be mid-teardown.
          }
        }, WEBVIEW_RETRY_DELAY_MS);
        return;
      }
      setHasLoadedFrame(false);
      setState({
        phase: 'error',
        url: null,
        preload: null,
        error: `The Hermes Desktop app did not respond (error ${code}).`,
        ownerKey,
      });
    };

    el.addEventListener('did-start-loading', onStartLoading);
    el.addEventListener('dom-ready', onDomReady);
    el.addEventListener('did-finish-load', onFinish);
    el.addEventListener('did-stop-loading', onStopLoading);
    el.addEventListener('did-fail-load', onFail);
    return () => {
      if (timer) clearTimeout(timer);
      adaptationTimers.forEach((adaptationTimer) => window.clearTimeout(adaptationTimer));
      adaptationTimers.clear();
      el.removeEventListener('did-start-loading', onStartLoading);
      el.removeEventListener('dom-ready', onDomReady);
      el.removeEventListener('did-finish-load', onFinish);
      el.removeEventListener('did-stop-loading', onStopLoading);
      el.removeEventListener('did-fail-load', onFail);
    };
  }, [maybeRestoreHomeSession, remote, state.ownerKey, state.phase, state.url, syncProfiles]);

  useEffect(() => {
    if (remote || state.phase !== 'live') return;
    const el = webviewRef.current;
    if (!el) return;
    try {
      el.executeJavaScript?.(HERMES_MOBILE_ADAPTATIONS_SCRIPT).catch(() => {});
    } catch {
      // Electron throws synchronously if the webview is mid-navigation.
    }
  }, [frameSize.width, remote, state.phase, state.url]);

  // Watchdog: the loading overlay clears on the webview's load events (or the
  // remote iframe's onLoad); if none fire within the timeout (a wedged load),
  // fail to an actionable error rather than spin forever — on mobile the
  // alternative is an eternal "Waiting for the Hermes dashboard…" panel.
  // Re-armed per live URL; cleared the moment frameLoaded flips.
  useEffect(() => {
    if (state.phase !== 'live' || frameLoaded) return;
    const timer = window.setTimeout(() => {
      setState((prev) =>
        prev.phase === 'live'
          ? {
              phase: 'error',
              url: null,
              preload: null,
              error: 'Hermes Desktop did not finish loading. Retry or Restart.',
              ownerKey: prev.ownerKey ?? HERMES_DESKTOP_APP_OWNER_KEY,
            }
          : prev
      );
    }, 20_000);
    return () => window.clearTimeout(timer);
  }, [state.phase, state.url, frameLoaded]);

  const applyIframeAdaptations = useCallback(() => {
    const iframe = iframeRef.current;
    const doc = iframe?.contentDocument;
    const win = iframe?.contentWindow;
    if (!doc || !win) return;
    // Ace re-skin on the mobile/remote iframe — the SAME theme bootstrap the
    // desktop webview runs (single source of truth). Writes Hermes's theme
    // localStorage keys before the SPA reads them so applyTheme() emits Ace.
    try {
      win.eval(ACE_THEME_BOOTSTRAP_SCRIPT);
    } catch {
      // eval blocked / frame not ready; the safety-net CSS below still applies.
    }
    try {
      let style = doc.getElementById('ace-hermes-embed-css') as HTMLStyleElement | null;
      if (!style) {
        style = doc.createElement('style');
        style.id = 'ace-hermes-embed-css';
        doc.head?.appendChild(style);
      }
      if (style.textContent !== HERMES_EMBED_CSS) style.textContent = HERMES_EMBED_CSS;
    } catch {
      // Cross-origin fallback: keep the iframe visible even if injection is blocked.
    }
    try {
      win.eval(HERMES_MOBILE_ADAPTATIONS_SCRIPT);
    } catch {
      // Some browsers or CSPs block eval in iframes; CSS still covers layout.
    }
  }, []);

  const handleIframeLoad = useCallback(() => {
    frameLoadedRef.current = true;
    setFrameLoaded(true);
    setHasLoadedFrame(true);
    applyIframeAdaptations();
    window.setTimeout(applyIframeAdaptations, 150);
    window.setTimeout(applyIframeAdaptations, 600);
    window.setTimeout(() => void syncProfiles(), 250);
    window.setTimeout(() => void syncProfiles(), 700);
    maybeRestoreHomeSession(true);
  }, [applyIframeAdaptations, maybeRestoreHomeSession, syncProfiles]);

  useEffect(() => {
    if (!remote || state.phase !== 'live') return;
    applyIframeAdaptations();
  }, [applyIframeAdaptations, frameSize.width, remote, state.phase, state.url]);

  useEffect(() => {
    const onResume = () => {
      if (document.visibilityState && document.visibilityState !== 'visible') return;
      if (remote) applyIframeAdaptations();
      resyncFrameForResume();
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) onResume();
    };
    document.addEventListener('visibilitychange', onResume);
    window.addEventListener('online', onResume);
    window.addEventListener('pageshow', onPageShow);
    return () => {
      document.removeEventListener('visibilitychange', onResume);
      window.removeEventListener('online', onResume);
      window.removeEventListener('pageshow', onPageShow);
    };
  }, [applyIframeAdaptations, remote, resyncFrameForResume]);

  const restart = useCallback(async () => {
    setHasLoadedFrame(false);
    frameLoadedRef.current = false;
    setFrameLoaded(false);
    setState((prev) => ({ ...prev, phase: 'starting', url: null, preload: null, error: null }));
    try {
      await aceApi.hermesDesktop.stop(state.ownerKey ?? HERMES_DESKTOP_APP_OWNER_KEY);
    } catch {
      // A stale owner key should not block a fresh ensure.
    }
    await ensure();
  }, [ensure, state.ownerKey]);

  // Host-chrome lane tabs on every surface (desktop webview and the
  // mobile/remote iframe). The roster comes from the operators registry — the
  // owner's configured control-plane lanes — so the
  // tabs render identically on mobile even when the embed DOM read fails.
  // The embed read only contributes which lane is currently active.
  const lanes = deriveLaneTabs(operators, profiles, pendingKey);
  const showLaneTabs = state.phase === 'live' && lanes.length > 0;
  showLaneTabsRef.current = showLaneTabs;
  // The sessions-sidebar toggle is a mobile (remote) affordance only. Render the
  // top bar whenever it carries something — lane tabs, or just the mobile sidebar
  // toggle — so a single-lane mobile install still gets a way into the sidebar.
  const sidebarToggle = remote && state.phase === 'live' ? toggleEmbedSidebar : undefined;
  const showHostChrome = showLaneTabs || Boolean(sidebarToggle);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      {showHostChrome && (
        <ProfileTabBar
          lanes={lanes}
          onSelect={handleSelectProfile}
          onNew={handleNewProfile}
          onToggleSidebar={sidebarToggle}
        />
      )}
      <div ref={hostRef} className="relative min-h-0 flex-1 overflow-hidden">
        {state.phase === 'live' ? (
          <>
            {remote ? (
              <iframe
                key={state.url}
                ref={iframeRef}
                src={state.url}
                title="Hermes"
                onLoad={handleIframeLoad}
                allow="clipboard-read; clipboard-write; fullscreen; microphone; camera"
                className="block h-full w-full border-0"
              />
            ) : (
              <webview
                key={`${state.url}:${state.preload || ''}`}
                ref={(el) => {
                  webviewRef.current = el as WebviewEl | null;
                }}
                src={state.url}
                preload={state.preload || undefined}
                partition={HERMES_DESKTOP_APP_PARTITION}
                allowpopups="true"
                style={{
                  position: 'absolute',
                  inset: 0,
                  width: '100%',
                  height: '100%',
                  display: 'flex',
                  minWidth: 0,
                  minHeight: 0,
                }}
              />
            )}
            {!frameLoaded && (
              <LoadingOverlay
                label={STARTING_RETRY_COPY}
                component="teams.hermes.frame"
                previousContent={hasLoadedFrame}
              />
            )}
          </>
        ) : state.phase === 'error' ? (
          <div className="flex h-full flex-col items-center justify-center gap-4 px-5 text-center">
            <TriangleAlert className="h-8 w-8 text-rose-300/80" />
            <div>
              <h2 className="text-base font-semibold text-foreground">Hermes did not start.</h2>
              <p className="mx-auto mt-2 max-w-md text-sm text-rose-300/85">{state.error}</p>
            </div>
            <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => void ensure()} className="h-8 text-[12px]">
              Retry
            </Button>
            <Button size="sm" variant="secondary" onClick={() => void restart()} className="h-8 text-[12px]">
              Restart
            </Button>
            </div>
          </div>
        ) : (
          <LoadingOverlay
            label="Starting Hermes..."
            component="teams.hermes.starting"
            previousContent={false}
          />
        )}
      </div>
    </div>
  );
}

function LoadingOverlay({
  label,
  component,
  previousContent,
}: {
  label: string;
  component: string;
  previousContent: boolean;
}) {
  useSpinnerPerf({
    active: true,
    component,
    label,
    route: 'teams',
    trigger: component,
    previousContent,
  });
  if (previousContent) {
    return (
      <div className="pointer-events-none absolute right-3 top-3 z-20 flex max-w-[min(22rem,calc(100%-1.5rem))] items-center gap-2 rounded-md border border-border/70 bg-background/85 px-3 py-2 text-xs text-foreground/70 shadow-sm backdrop-blur">
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-sky-300/80" />
        <span className="min-w-0 truncate">{label}</span>
      </div>
    );
  }
  return (
    <div className="absolute inset-0 flex items-center justify-center gap-3 bg-background/90 px-4 text-center text-sm text-foreground/60">
      <Loader2 className="h-4 w-4 shrink-0 animate-spin text-sky-300/80" />
      <span className="min-w-0 truncate">{label}</span>
    </div>
  );
}

// One host-chrome lane tab. Roster from the operators registry; active state
// from the embed read (or the just-clicked lane until the read confirms).
type LaneTab = { key: string; label: string; emoji: string; active: boolean };

// The owner's configured control-plane Hermes lanes, marked active from the
// embed read. Falls back to read-profiles-matching-operators when the install
// runs only the shipped neutral default (a single 'hermes' operator), so a
// vanilla install never grows a dead tab for a profile that doesn't exist.
function deriveLaneTabs(
  operators: ReturnType<typeof useOperators>,
  profiles: ProfileTab[],
  pendingKey: string | null
): LaneTab[] {
  const roster = listControlPlaneOperators(operators).filter((o) => o.agent === 'hermes');
  const configured = roster.length > 1 || roster.some((o) => o.id !== 'hermes');
  const readActiveKey = profiles.find((p) => p.active)?.key ?? null;
  const activeKey = pendingKey ?? readActiveKey;
  if (configured) {
    return roster.map((o) => ({
      key: o.id,
      label: o.label,
      emoji: o.emoji,
      active: o.id === activeKey,
    }));
  }
  return profiles
    .filter((p) => getOperator(operators, p.key))
    .map((p) => {
      const operator = getOperator(operators, p.key)!;
      return {
        key: p.key,
        label: operator.label,
        emoji: operator.emoji,
        active: p.key === activeKey,
      };
    });
}

// Chrome-style lane tabs drawn in Ace host chrome above the Hermes embed.
// One tab per configured lane, full name + identity emoji; clicking drives the
// SPA's own in-app profile switch (no webview reload, no extra sidecar).
function ProfileTabBar({
  lanes,
  onSelect,
  onNew,
  onToggleSidebar,
}: {
  lanes: LaneTab[];
  onSelect: (key: string) => void;
  onNew: () => void;
  onToggleSidebar?: () => void;
}) {
  if (lanes.length === 0 && !onToggleSidebar) return null;
  return (
    <div
      role="tablist"
      aria-label="Hermes agents"
      className="flex shrink-0 items-end gap-1 overflow-x-auto border-b border-white/10 bg-[#0e0f12] px-2 pt-1.5"
      style={{ scrollbarWidth: 'none' }}
    >
      {onToggleSidebar && (
        <button
          type="button"
          onClick={onToggleSidebar}
          title="Sessions"
          aria-label="Toggle sessions sidebar"
          className="mb-1 mr-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-white/55 transition-colors hover:bg-white/10 hover:text-white/90"
        >
          <PanelLeft className="h-4 w-4" />
        </button>
      )}
      {lanes.map((p) => {
        const { emoji, label } = p;
        return (
          <button
            key={p.key}
            type="button"
            role="tab"
            aria-selected={p.active}
            onClick={() => onSelect(p.key)}
            title={label}
            className={`flex h-9 max-w-[14rem] shrink-0 items-center gap-1.5 rounded-t-lg border-x border-t px-3.5 text-[13px] font-medium transition-colors ${
              p.active
                ? 'border-white/10 bg-[#1c1d22] text-white'
                : 'border-transparent text-white/55 hover:bg-white/5 hover:text-white/85'
            }`}
          >
            <span aria-hidden className="text-[15px] leading-none">
              {emoji || label.charAt(0).toUpperCase()}
            </span>
            <span className="truncate">{label}</span>
          </button>
        );
      })}
      <button
        type="button"
        onClick={onNew}
        title="New profile"
        aria-label="New profile"
        className="mb-1 ml-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-lg leading-none text-white/45 transition-colors hover:bg-white/10 hover:text-white/85"
      >
        +
      </button>
    </div>
  );
}
