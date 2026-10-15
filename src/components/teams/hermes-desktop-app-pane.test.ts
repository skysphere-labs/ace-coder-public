import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { homeRestoreResultIsStale, resolveActiveEmbedProfile } from './hermes-dashboard-pane-logic';

const here = resolve(process.cwd(), 'src/components/teams');
const surface = readFileSync(resolve(here, 'ResidentOperatorSurface.tsx'), 'utf8');
const pane = readFileSync(resolve(here, 'HermesDesktopAppPane.tsx'), 'utf8');
const logic = readFileSync(resolve(here, 'hermes-dashboard-pane-logic.ts'), 'utf8');
const aceApi = readFileSync(resolve(process.cwd(), 'src/lib/ace-api.ts'), 'utf8');
const main = readFileSync(resolve(process.cwd(), 'electron/main.cts'), 'utf8');
const githubBrowser = readFileSync(resolve(process.cwd(), 'src/components/GithubBrowserScreen.tsx'), 'utf8');

describe('Hermes Desktop Teams app surface', () => {
  it('mounts the full Hermes app directly instead of the old home-card picker', () => {
    expect(surface).toContain('<HermesDesktopAppPane onPhaseChange={setPhase} />');
    expect(surface).not.toContain('HermesHomeCard');
    expect(surface).not.toContain('HermesDashboardSlot');
    expect(surface).not.toContain('deriveHermesHomeCards');
  });

  it('keeps the embed resident across app tabs instead of unmounting it off-route', () => {
    // The route-scoped owner is gone: nothing may re-introduce a `visible`
    // prop that unmounts the embed when the active view is not 'teams'.
    expect(surface).not.toContain('if (!visible) return null');
    expect(surface).not.toContain("display: visible ? 'flex' : 'none'");
    expect(pane).toContain("if (state.phase !== 'live' || !frameLoaded) return;");
    expect(pane).not.toContain("if (!visible || state.phase !== 'live' || !frameLoaded) return;");
  });

  it('keeps Hermes profile sync light and non-overlapping', () => {
    expect(pane).toContain('const PROFILE_SYNC_POLL_INTERVAL_MS = 10_000');
    expect(pane).toContain('const profileSyncInFlight = useRef(false)');
    expect(pane).toContain('if (profileSyncInFlight.current) return;');
    expect(pane).toContain("document.visibilityState === 'hidden'");
    expect(pane).toContain('name: \'teams.hermes.profileSync\'');
    expect(pane).toContain('window.setInterval(() => void syncProfiles(), PROFILE_SYNC_POLL_INTERVAL_MS)');
    expect(pane).not.toContain('window.setInterval(() => void syncProfiles(), 2000)');
    const syncStart = pane.indexOf('const syncProfiles = useCallback(async () => {');
    const syncEnd = pane.indexOf('  }, [runInFrame]);', syncStart);
    const syncBlock = pane.slice(syncStart, syncEnd);
    expect(syncBlock).toContain('HERMES_PROFILE_READ_SCRIPT');
    expect(syncBlock).not.toContain('HERMES_MOBILE_ADAPTATIONS_SCRIPT');
    expect(pane).toContain('window.__aceHermesAdaptationRefreshTimer');
    expect(pane).toContain('scheduleAdaptationRefresh(activeHint)');
  });

  it('auto-starts the global sidecar without requiring a lane owner', () => {
    expect(pane).toContain('aceApi.hermesDesktop.ensure()');
    expect(pane).not.toContain('aceApi.hermesDesktop.ensure(ownerKey)');
    expect(pane).toContain('HERMES_DESKTOP_APP_OWNER_KEY');
  });

  it('tags the initial embed URL (desktop + mobile) with the active profile for the native hero', () => {
    // The forked Hermes intro reads ?aceProfile; first-load identity is
    // wired here for BOTH the desktop webview and the mobile iframe. The old
    // host-side DOM title scrape was retired.
    expect(pane).toContain('aceApi.hermesDesktop.getActiveProfile()');
    expect(pane).toContain("searchParams.set('aceProfile', name)");
    expect(pane).not.toContain('activeProfileIdentityScript');
    expect(pane).not.toContain('data-ace-profile-hero');
  });

  it('themes the mobile/remote iframe with the Ace bootstrap and a dark host shell', () => {
    // Mobile parity with desktop: the iframe runs the SAME theme bootstrap the
    // webview does, and the host shell is Ace-dark (not the old light bg).
    expect(pane).toContain('win.eval(ACE_THEME_BOOTSTRAP_SCRIPT)');
    expect(pane).toContain('bg-background');
    expect(pane).not.toContain('bg-[#f7f7f7]');
  });

  it('passes the installed Hermes.app preload into a full-size desktop webview', () => {
    expect(pane).toContain('{remote ? (');
    expect(pane).toContain('<iframe');
    expect(pane).toContain('className="block h-full w-full border-0"');
    expect(pane).toContain('<webview');
    expect(pane).toContain('preload={state.preload || undefined}');
    expect(pane).toContain('HERMES_DESKTOP_APP_PARTITION');
    expect(pane).toContain("display: 'flex'");
    expect(pane).toContain("position: 'absolute'");
    expect(pane).toContain("height: '100%'");
    expect(pane).toContain('executeJavaScript?.(HERMES_MOBILE_ADAPTATIONS_SCRIPT)');
    expect(pane).toContain('[data-pane-id="chat-sidebar"]');
    expect(pane).toContain('grid-template-columns: minmax(0, 1fr)');
    expect(pane).toContain('[data-pane-id="chat-sidebar"] [role="tablist"][aria-label="Profiles"]');
    expect(pane).toContain('data-ace-profile-action');
    // The mobile rail keeps its NATIVE look (small per-profile squares): the
    // adaptations tagger only stamps data attributes — no text rewrites, no
    // flex reordering, and no white "PROFILES" pill-box restyle.
    expect(pane).not.toContain('content: attr(data-ace-profile-name)');
    expect(pane).not.toContain('data-ace-profile-action-label');
    expect(pane).not.toContain('compactActionText');
    expect(pane).not.toContain('item.style.order');
    // The host-tabs foot-rail retire applies on desktop widths only, so the
    // mobile sidebar always keeps its own switcher.
    expect(pane).toContain('@media (min-width: ${HERMES_MOBILE_SIDEBAR_WIDTH + 1}px)');
    expect(pane).toContain('body[data-ace-host-tabs="on"]');
    expect(pane).toContain('hostTabsAttrScript(showLaneTabsRef.current)');
    expect(pane).toContain('switch to|activate|select|use');
    expect(pane).toContain('/^(?:show all profiles|all)$/i');
    expect(pane).toContain('/^manage(?: profiles?)?\\\\.{0,3}$/i');
    expect(pane).toContain("item.setAttribute('aria-label', label)");
    expect(pane).toContain("item.setAttribute('title', label)");
    expect(pane).toContain('window.__aceHermesProfileObserver');
    expect(pane).toContain('syncMobileRightDrawers');
    expect(pane).toContain('data-ace-mobile-suppressed');
    expect(pane).toContain('armMobileRightDrawerOutsideTap');
    expect(pane).toContain('__aceRightDrawerOutsideTap');
    expect(pane).toContain('closeMobileRightDrawer');
    expect(pane).toContain('[data-pane-id="review"][data-pane-hover-reveal="open"]');
    expect(pane).toContain('enableMobileTextAssistance');
    expect(pane).toContain("el.setAttribute('autocorrect', 'on')");
    expect(pane).toContain("el.setAttribute('autocapitalize', 'sentences')");
    expect(pane).toContain("el.setAttribute('spellcheck', 'true')");
    expect(pane).toContain("el.setAttribute('data-ace-mobile-text-assist', 'on')");
    expect(pane).toContain("'data-pane-hover-reveal'");
    expect(pane).toContain("'data-pane-open'");
    expect(pane).toContain('window.__aceHermesVisualViewportBound');
    expect(pane).toContain('data-ace-keyboard-open');
    expect(pane).toContain("el.addEventListener('dom-ready', onDomReady)");
    expect(pane).toContain("el.addEventListener('did-stop-loading', onStopLoading)");
  });

  it('waits for the embedded frame before running renderer scripts', () => {
    expect(pane).toContain('if (!frameLoadedRef.current) return Promise.resolve(undefined)');
    expect(pane).toContain('if (!frameLoadedRef.current) return;');
    expect(pane).toContain('frameLoadedRef.current = true;');

    const listenerStart = pane.indexOf("el.addEventListener('dom-ready', onDomReady)");
    const cleanupStart = pane.indexOf('return () => {', listenerStart);
    const postListenerSetup = pane.slice(listenerStart, cleanupStart);
    expect(listenerStart).toBeGreaterThan(-1);
    expect(cleanupStart).toBeGreaterThan(listenerStart);
    expect(postListenerSetup).not.toContain('applyHermesAdaptations();');
    expect(postListenerSetup).not.toContain('scheduleAdaptations(');
  });

  it('never stops the backend on unmount, bounds the spinner, and never restart-storms', () => {
    // Leaving Teams / a shell swap must NOT stop the global sidecar — the
    // session streaming inside the embed has to survive navigation. Only the
    // explicit Restart here (and the manager's stopAll on app shutdown or the
    // Lanes surface flip) stop it.
    expect(pane).not.toMatch(/return \(\) => \{\s*void aceApi\.hermesDesktop\.stop/);
    expect(pane.match(/aceApi\.hermesDesktop\.stop\(/g)).toHaveLength(1);
    expect(pane).toContain(
      'await aceApi.hermesDesktop.stop(state.ownerKey ?? HERMES_DESKTOP_APP_OWNER_KEY)'
    );
    // No self-perpetuating re-ensure loop on backend exit/stop (the old 250ms
    // respawn that produced the infinite spinner).
    expect(pane).not.toContain('}, 250);');
    // The loading overlay always resolves to content or an actionable error.
    expect(pane).toContain('Hermes Desktop did not finish loading');
    // Overlapping ensure() calls are coalesced.
    expect(pane).toContain('ensureInFlight');
  });

  it('re-fetches the URL after a respawn when the live surface is the port-bound web fallback', () => {
    // Regression: with no desktop bundle installed (the normal Windows shape —
    // install.ps1 only builds it with -IncludeDesktop) the live URL IS the
    // sidecar's loopback address. Every respawn allocates a fresh port and
    // session token, so the previous "skip the re-ensure while live" rule left
    // the webview pointed at a dead port, recoverable only by a manual Retry.
    expect(pane).toContain("surface: 'desktop' | 'web'");
    expect(pane).toContain("surface: !remote && result.surface === 'web' ? 'web' : 'desktop'");
    expect(pane).toContain("if (live.phase !== 'live' || live.surface === 'web') {");
    // The old unconditional skip must be gone.
    expect(pane).not.toContain(
      "if (stateRef.current.phase !== 'live') void ensure({ markStarting: false });"
    );
  });

  it('treats the bundle-less loopback guest as a Hermes guest for link routing and hardening', () => {
    // Without this, the no-bundle surface (the normal Windows shape) was not
    // recognized as Hermes: setWindowOpenHandler fell through to wc.loadURL and
    // replaced the whole SPA, will-navigate let a link navigate the guest away,
    // and hardenIfHermesGuest never wired render-process-gone — so a crash
    // produced no remount signal. The pane keys on state.url, which does not
    // change, so nothing recovered it.
    expect(main).toContain('const isHermesDesktopPartition = () => {');
    expect(main).toContain('wc.session === session.fromPartition(HERMES_DESKTOP_APP_PARTITION)');
    expect(main).toContain('return isHermesDesktopPartition() && isLoopbackHttpUrl(currentUrl);');
    // Hardening must use the same widened test, not the preload-trust one.
    expect(main).toContain('if (!trustedIndex && !(isHermesDesktopPartition() && isLoopbackHttpUrl(url))) return;');
    // The PRELOAD trust boundary stays pinned to the exact file:// index.
    expect(main).toContain('const trustedHermesDesktop = isTrustedHermesDesktopWebview(params, webPreferences, {');
  });

  it('routes both navigation and redirect through the tested divert decision', () => {
    // Logic lives in shouldDivertHermesGuestNavigation and is covered
    // behaviorally in electron/__tests__/hermes-dashboard.test.cts (same-origin,
    // cross-origin, subframe, packaged file:// guest). These assertions only pin
    // the WIRING: both events read Electron's isMainFrame argument and defer.
    expect(main).toContain("wc.on('will-navigate', (event: any, url: any, _isInPlace: any, isMainFrame: any) => {");
    expect(main).toContain("wc.on('will-redirect', (event: any, url: any, _isInPlace: any, isMainFrame: any) => {");
    expect(main.match(/if \(!divert\(event, url, isMainFrame\)\) return;/g)).toHaveLength(2);
    expect(main).toContain('isMainFrame: resolveIsMainFrame(event, isMainFrame),');
    // No local re-implementation of the decision.
    expect(main).not.toContain('const isSameOriginAsGuest');
    expect(main).not.toContain('event?.isMainFrame === false');
  });

  it('uses a non-blocking loading indicator after prior Hermes content has loaded', () => {
    expect(pane).toContain('const [hasLoadedFrame, setHasLoadedFrame] = useState(false)');
    expect(pane).toContain('const hasLoadedFrameRef = useRef(hasLoadedFrame)');
    expect(pane).toContain('setHasLoadedFrame(true)');
    expect(pane).toContain('previousContent={hasLoadedFrame}');
    expect(pane).toContain('pointer-events-none absolute right-3 top-3');
    expect(pane).toContain('bg-background/85');
    expect(pane).toContain('setHasLoadedFrame((prev) => prev || frameLoadedRef.current || hasLoadedFrameRef.current)');
  });

  it('keeps mobile and remote adaptations alive across resize and remote loads', () => {
    expect(pane).toContain("key={`${state.url}:${state.preload || ''}`}");
    expect(pane).not.toContain('frameSize.width}x${frameSize.height}');
    expect(pane).toContain('[data-pane-id="preview"]:not([data-pane-open="false"])');
    expect(pane).toContain('[data-pane-id="review"]:not([data-pane-open="false"])');
    expect(pane).toContain('[data-pane-id="file-browser"]:not([data-pane-open="false"])');
    expect(pane).toContain('ref={iframeRef}');
    expect(pane).toContain('onLoad={handleIframeLoad}');
    expect(pane).toContain('applyIframeAdaptations');
    expect(pane).toContain('}, [frameSize.width, remote, state.phase, state.url]);');
    expect(pane).toContain("fetch(url, { cache: 'no-store', credentials: 'include' })");
    expect(pane).toContain("event.type === 'stopped' || event.type === 'exited'");
  });

  it('keeps resize-driven adaptations without retaining a hidden Teams frame', () => {
    expect(pane).toContain("if (!remote || state.phase !== 'live') return;");
    expect(pane).toContain(
      '}, [applyIframeAdaptations, frameSize.width, remote, state.phase, state.url]);'
    );
    expect(pane).toContain("if (remote || state.phase !== 'live') return;");
    expect(pane).not.toContain("|| !visible");
  });

  it('switches host profile tabs via the SPA rail click (fast gateway swap), bridge only as fallback', () => {
    // Rail click first: drives the SPA's selectProfile → swap-minimal gateway
    // reconnect with no webview reload and no sidecar restart. The bridge
    // profile.set path kills + respawns the python backend and reloads the
    // SPA (~5s per tab switch), so it must only be the fallback when the rail
    // item hasn't been tagged yet.
    const railClick = pane.indexOf("document.querySelectorAll('[data-ace-profile-key='");
    const bridge = pane.indexOf('window.hermesDesktop?.profile?.set');
    expect(railClick).toBeGreaterThan(-1);
    expect(bridge).toBeGreaterThan(-1);
    expect(railClick).toBeLessThan(bridge);
    expect(pane).toContain('Promise.resolve(bridgeSwitch(');
    expect(pane).toContain('PROFILE_SWITCH_CONFIRM_TIMEOUT_MS');
    expect(pane).toContain('aceApi.hermesDesktop.setActiveProfile(key)');
    const retryAdapt = pane.indexOf('await runInFrame(HERMES_MOBILE_ADAPTATIONS_SCRIPT)');
    const fallbackSetProfile = pane.indexOf('aceApi.hermesDesktop.setActiveProfile(key)');
    expect(retryAdapt).toBeGreaterThan(-1);
    expect(fallbackSetProfile).toBeGreaterThan(retryAdapt);
    expect(pane).toContain("name: 'teams.hermes.profileFallback'");
    expect(pane).toContain('changed: result.changed !== false');
    expect(pane).toContain('if (result.changed !== false) reloadFrameForProfile(result.profile || key)');
    // The SPA's hermes:last-session restore drives session.resume — the RPC
    // that re-binds a chat's event stream to the live websocket. Clearing it
    // (or force-routing to '/') left detached sessions streaming to the
    // gateway's stdio black hole: the silent operator-lane no-reply bug.
    expect(pane).not.toContain("window.localStorage?.removeItem?.('hermes:last-session:");
    expect(pane).not.toContain("window.location.hash = '/'");
    expect(pane).not.toContain("url.hash = '/'");
    // Untagged fallback before the bridge: the mobile sidecar web UI's rail is
    // icon-only squares whose aria-label IS the profile name.
    const ariaFallback = pane.indexOf("normalized === 'switchtoprofile' + profile");
    expect(ariaFallback).toBeGreaterThan(railClick);
    expect(ariaFallback).toBeLessThan(bridge);
  });

  it('clears both Hermes dashboard partitions when the sidecar lifecycle turns over', () => {
    expect(main).toContain("'persist:ace-browser-hermes'");
    expect(main).toContain("'persist:ace-browser-hermes-desktop-app'");
    expect(main).toContain('session.fromPartition(partition)');
    expect(main).toContain('clearStorageData(origin ? { origin } : undefined)');
  });

  it('routes Hermes web links into the Ace browser instead of replacing chat', () => {
    expect(main).toContain('sendHermesDesktopOpenLink(win.webContents, url)');
    expect(main).toContain('if (isHermesGuest())');
    expect(main).toContain("wc.on('will-navigate'");
    expect(pane).toContain("event.type === 'open-link'");
    expect(pane).toContain('requestBrowserOpen(event.url)');
    expect(githubBrowser).toContain('src={currentUrl}');
    expect(githubBrowser).not.toContain('src={initialSrc}');
  });

  it('derives the lane tab roster from the operators registry, active state from the embed read', () => {
    // The roster of configured operator lanes must render identically on desktop
    // and mobile even when the embed DOM read fails; only ACTIVE state comes
    // from the read (or the just-clicked lane until the read confirms).
    expect(pane).toContain('listControlPlaneOperators(operators)');
    expect(pane).toContain("filter((o) => o.agent === 'hermes')");
    expect(pane).toContain('deriveLaneTabs(operators, profiles, pendingKey)');
    // Vanilla installs (single shipped 'hermes' operator) keep the read-driven
    // behavior so no dead tab appears for a profile that doesn't exist.
    expect(pane).toContain("roster.length > 1 || roster.some((o) => o.id !== 'hermes')");
  });

  it('leaves the mobile sidebar under user control so sessions remain reachable', () => {
    // The embedded Hermes chrome owns its left session rail. Auto-clicking the
    // toggle on load hid other sessions and made the top-left chrome feel
    // broken on phones — so the on-load adaptations script must never collapse
    // or toggle the sidebar.
    expect(pane).toContain('Leave the Hermes sidebar/session rail under user control on mobile');
    // The on-load adaptations script reports the sidebar as not collapsed and
    // never toggles it; only explicit user actions (a profile switch that has to
    // briefly open the rail, or the host-chrome sessions toggle) move it.
    expect(pane).toContain('collapsed: false');
  });

  it('exposes a user-initiated mobile sessions-sidebar toggle in host chrome', () => {
    // On phones the SPA force-collapses the sessions pane into a hover-reveal
    // overlay: $sidebarOpen (what the titlebar toggle flips) is ignored, and the
    // overlay opens only via the pane's `forced` flag — toggled by a
    // hermes:pane-toggle-reveal event (no hover on touch, no keyboard on a
    // phone). Host chrome dispatches that event so the session list is reachable.
    expect(pane).toContain('HERMES_SIDEBAR_TOGGLE_SCRIPT');
    expect(pane).toContain("'hermes:pane-toggle-reveal'");
    expect(pane).toContain("detail: { id: 'chat-sidebar' }");
    // The embed CSS surfaces the force-revealed overlay (data-pane-hover-reveal)
    // as the drawer instead of hiding it on data-pane-open="false".
    expect(pane).toContain('[data-pane-id="chat-sidebar"][data-pane-hover-reveal="open"]');
    expect(pane).toContain(':not([data-pane-hover-reveal="open"])');
    expect(pane).toContain('Toggle sessions sidebar');
    // Mobile (remote) only — the desktop webview already shows full titlebar
    // controls, so the host-chrome toggle is gated on the remote client.
    expect(pane).toContain('remote && state.phase === \'live\' ? toggleEmbedSidebar : undefined');
  });

  it('closes mobile right drawers when tapping outside them', () => {
    expect(pane).toContain('const drawerIds = [\'preview\', \'review\', \'file-browser\'];');
    expect(pane).toContain('isMobileRightDrawerOpen');
    expect(pane).toContain("drawer.getAttribute('data-pane-hover-reveal') === 'open'");
    expect(pane).toContain('armMobileRightDrawerOutsideTap(openDrawers[0])');
    expect(pane).toContain('armMobileRightDrawerOutsideTap(active)');
    expect(pane).toContain('document.addEventListener(\'pointerdown\', handler, true)');
    expect(pane).toContain('if (drawer.contains(event.target)) return;');
    expect(pane).toContain('closeMobileRightDrawer(drawer)');
    expect(pane).toContain("control.querySelector?.('.codicon-close, .codicon-chrome-close, [data-lucide=\"x\"]')");
    expect(pane).toContain("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape'");
  });

  it('pins the mobile sessions drawer to the left edge of the embedded viewport', () => {
    expect(pane).toContain('[data-pane-id="chat-sidebar"]');
    expect(pane).toContain('position: fixed !important;');
    expect(pane).toContain('left: 0 !important;');
    expect(pane).toContain('right: auto !important;');
    expect(pane).toContain('transform: none !important;');
  });

  it('enables mobile autocorrect only on normal Hermes text editors', () => {
    expect(pane).toContain('enableMobileTextAssistance');
    expect(pane).toContain("'textarea, input, [role=\"textbox\"], [contenteditable]:not([contenteditable=\"false\"])'");
    expect(pane).toContain("if (!/^(?:text|search)$/.test(type)) return false;");
    expect(pane).toContain("'.xterm'");
    expect(pane).toContain("'.monaco-editor'");
    expect(pane).toContain("'[data-code-editor]'");
    expect(pane).toContain("if (el.matches('[role=\"combobox\"], [aria-autocomplete=\"list\"]')) return false;");
    expect(pane).toContain("enableMobileTextAssistance();");
  });

  it('does not inject the old mobile Paste fallback inside the embedded Hermes iframe', () => {
    expect(pane).not.toContain('installMobilePasteFallback');
    expect(pane).not.toContain('window.__aceHermesMobilePasteFallback');
    expect(pane).not.toContain('data-ace-mobile-paste');
    expect(pane).not.toContain('Paste from clipboard');
    expect(pane).not.toContain('navigator.clipboard?.readText');
    expect(pane).not.toContain('pasteFallback');

    const genericMobileComposer = readFileSync(
      resolve(process.cwd(), 'src/components/ace-chat/MobileChatComposer.tsx'),
      'utf8'
    );
    expect(genericMobileComposer).not.toContain('Paste from clipboard');
    expect(genericMobileComposer).not.toContain('navigator.clipboard?.readText');
  });

  it('installs a mobile file-picker fallback for the remote Hermes iframe bridge', () => {
    // The remote/mobile shim has no Electron dialog or filesystem paths. Teams
    // must still let Hermes open a real browser file picker, then hand the SPA
    // stable virtual paths whose preview reads resolve from in-memory Files.
    expect(pane).toContain('installMobileAttachmentFallbacks');
    expect(pane).toContain('window.__aceHermesMobileAttachmentFallbacks');
    expect(pane).toContain("if (/Electron/i.test(ua)) return false;");
    expect(pane).toContain('selectPaths: bridge.selectPaths?.bind(bridge)');
    expect(pane).toContain('if (original.selectPaths) return original.selectPaths(options);');
    expect(pane).toContain("bridge.selectPaths = (options = {}) =>");
    expect(pane).toContain("input.type = 'file'");
    expect(pane).toContain('input.multiple = options?.multiple !== false');
    expect(pane).toContain('input.click()');
    expect(pane).toContain("ace-mobile-file://");
    expect(pane).toContain('bridge.getPathForFile = (file) =>');
    expect(pane).toContain('bridge.readFileDataUrl = async (target) =>');
    expect(pane).toContain('bridge.readFileText = async (target) =>');
    expect(pane).toContain('reader.readAsDataURL(file)');
    expect(pane).toContain('reader.readAsText(file.slice(0, 512 * 1024))');
    expect(pane).toContain('enrichGatewayAttachmentRpc');
    expect(pane).toContain("frame.method === 'file.attach'");
    expect(pane).toContain('data_url: params?.data_url || dataUrl');
    expect(pane).toContain("frame.method === 'image.attach'");
    expect(pane).toContain("method: 'image.attach_bytes'");
    expect(pane).toContain('content_base64: dataUrl');
    expect(pane).toContain('window.WebSocket.prototype.send = function (payload)');
    expect(pane).toContain('__aceHermesMobileAttachmentRpcPatched');
    expect(pane).toContain('attachmentFallbacks');
  });

  it('resyncs the embedded Hermes app after tab/background resume without stopping Hermes', () => {
    // Resume is non-destructive: the embed receives the same wake/online
    // signals Hermes already uses to probe and reconnect its websocket.
    expect(pane).toContain('HERMES_RESUME_SCRIPT');
    expect(pane).toContain('resyncFrameForResume');
    expect(pane).not.toContain('hiddenAtRef');
    expect(pane).toContain('resumeResyncAtRef');
    expect(logic).toContain('bridge?.profile?.get?.()');
    expect(logic).toContain('bridge?.touchBackend?.');
    expect(logic).toContain("window.dispatchEvent(new Event('online'))");
    expect(logic).toContain("window.dispatchEvent(new Event('focus'))");
    expect(logic).toContain("document.dispatchEvent(new Event('visibilitychange'))");
    expect(logic).toContain("window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))");
    expect(pane).not.toContain('iframeRef.current?.contentWindow?.location.reload()');
    expect(pane).not.toContain('__aceResumeReload');
    expect(pane).not.toContain('resyncRemoteFrameForResume');
    expect(pane).toContain("document.addEventListener('visibilitychange', onResume)");
    expect(pane).toContain("window.addEventListener('online', onResume)");
    expect(pane).toContain("window.addEventListener('pageshow', onPageShow)");
    expect(pane).toContain('if (remote) applyIframeAdaptations();');
    expect(pane).toContain('resyncFrameForResume();');
    expect(pane.match(/aceApi\.hermesDesktop\.stop\(/g)).toHaveLength(1);
  });

  it('rehydrates the remote cookie before iframe-only Hermes proxy requests', () => {
    expect(aceApi).toContain('function remoteSetTokenCookie(token: string)');
    expect(aceApi).toContain('remoteSetTokenCookie(data.token)');
    expect(aceApi).toContain('remoteSetTokenCookie(ls)');
    expect(aceApi).toContain("'hermesDesktopGetActiveProfile'");
    expect(aceApi).toContain("'hermesDesktopSetActiveProfile'");
    expect(aceApi).toContain("setActiveProfile: (profile: string | null)");
  });

  it('never lets the Ace shell recurse inside its own Hermes embed frame', () => {
    // Root cause of the stacked-Teams mobile bug: the PWA service worker's
    // navigateFallback answered the /hermes-desktop iframe navigation with the
    // cached Ace index.html. The proxy prefix must stay denylisted.
    const viteConfig = readFileSync(resolve(process.cwd(), 'vite.config.ts'), 'utf8');
    expect(viteConfig).toContain(String.raw`/^\/hermes-desktop/`);
    // Boot guard: a same-origin self-embed renders a static notice, not <App />.
    const mainEntry = readFileSync(resolve(process.cwd(), 'src/main.tsx'), 'utf8');
    expect(mainEntry).toContain('isRecursiveAceEmbed(window)');
    expect(mainEntry).toContain('SELF_EMBED_NOTICE');
    // Health-check guard: a proxied redirect that escapes /hermes-desktop is a
    // server-side fault, never an embeddable URL.
    expect(pane).toContain('isOutsideHermesRemotePath(res.url, window.location.origin)');
  });

  it('bounds the loading overlay on the remote iframe too, not just the desktop webview', () => {
    expect(pane).toContain("if (state.phase !== 'live' || frameLoaded) return;");
    expect(pane).not.toContain("if (remote || state.phase !== 'live' || frameLoaded) return;");
  });

  it('targets the delivery sweep at the live active profile, not the stale embed URL', () => {
    // A rail-click profile switch changes the scraped active tab without
    // rewriting state.url, so activeEmbedProfile must read the live profiles
    // list (mirrored into profilesRef) and NOT parse aceProfile off the URL
    // directly — otherwise post-switch sweeps keep targeting the old profile
    // and its completed cron runs age out of the window undelivered.
    expect(pane).toContain('const profilesRef = useRef(profiles)');
    expect(pane).toContain('profilesRef.current = profiles;');
    expect(pane).toContain(
      'resolveActiveEmbedProfile(profilesRef.current, stateRef.current.url, window.location.origin)'
    );
    expect(pane).not.toContain("new URL(url, window.location.origin).searchParams.get('aceProfile')");
  });
});

describe('resolveActiveEmbedProfile', () => {
  const url = '/hermes-desktop/?aceProfile=Atlas';

  it('prefers the live active profile over a stale embed URL (the in-frame-switch bug)', () => {
    const profiles = [
      { name: 'Atlas', active: false },
      { name: 'Nova', active: true },
    ];
    // Canonical (lower-cased) id, not the scraped display name.
    expect(resolveActiveEmbedProfile(profiles, url, 'http://localhost')).toBe('nova');
  });

  it('falls back to the URL aceProfile before the first profile sync lands', () => {
    expect(resolveActiveEmbedProfile([], url, 'http://localhost')).toBe('atlas');
    expect(resolveActiveEmbedProfile([{ name: 'Atlas', active: false }], url, 'http://localhost')).toBe(
      'atlas'
    );
  });

  it('canonicalizes the scraped display name (trim + lower-case) to the sidecar profile id', () => {
    // The rail label is 'Vector' but the sidecar keys everything by 'vector';
    // forwarding the display name verbatim would bind the wrong/default profile.
    expect(
      resolveActiveEmbedProfile([{ name: '  VeCtOr  ', active: true }], url, 'http://localhost')
    ).toBe('vector');
    // The URL param is a display name too — canonicalize it on the fallback path.
    expect(
      resolveActiveEmbedProfile([], '/hermes-desktop/?aceProfile=Nova', 'http://localhost')
    ).toBe('nova');
  });

  it('returns null when neither a live active profile nor an aceProfile param exists', () => {
    expect(resolveActiveEmbedProfile([], '/hermes-desktop/', 'http://localhost')).toBeNull();
    expect(resolveActiveEmbedProfile([], null, 'http://localhost')).toBeNull();
    expect(resolveActiveEmbedProfile([{ name: '', active: true }], null, 'http://localhost')).toBeNull();
  });
});

describe('homeRestoreResultIsStale (async restore race guard)', () => {
  const bound = {
    generationAtStart: 7,
    urlAtStart: '/hermes-desktop/?aceProfile=Atlas',
    profileAtStart: 'Atlas',
  };

  it('lets a result run when the generation, frame, URL, and active profile are unchanged', () => {
    expect(
      homeRestoreResultIsStale({
        ...bound,
        generationNow: 7,
        urlNow: bound.urlAtStart,
        profileNow: 'Atlas',
        frameLoaded: true,
      })
    ).toBe(false);
  });

  it('blocks a result after a same-URL reload into a fresh document (the generation race)', () => {
    // The failure the URL/profile guards cannot see: the guest reloaded into a
    // brand-new document at the SAME URL and SAME profile, and that document is
    // fully loaded (frameLoaded true). Only the load generation advanced — and
    // that alone must condemn the old document's seed script so it never runs in
    // the replacement document.
    expect(
      homeRestoreResultIsStale({
        ...bound,
        generationNow: 8,
        urlNow: bound.urlAtStart,
        profileNow: 'Atlas',
        frameLoaded: true,
      })
    ).toBe(true);
  });

  it('blocks a result whose active profile switched under an UNCHANGED URL and generation (the in-frame-switch race)', () => {
    // A rail-click switch from Atlas to Nova moves the active profile without
    // rewriting state.url or reloading the document (no did-start-loading), so
    // both the URL and the generation still match — the profile check is the
    // only thing that stops Atlas's seed script running in Nova's live frame.
    expect(
      homeRestoreResultIsStale({
        ...bound,
        generationNow: 7,
        urlNow: bound.urlAtStart,
        profileNow: 'Nova',
        frameLoaded: true,
      })
    ).toBe(true);
  });

  it('blocks a result after the embed URL changed', () => {
    expect(
      homeRestoreResultIsStale({
        ...bound,
        generationNow: 7,
        urlNow: '/hermes-desktop/?aceProfile=Nova',
        profileNow: 'Atlas',
        frameLoaded: true,
      })
    ).toBe(true);
  });

  it('blocks a result once the frame has torn down (reload in flight)', () => {
    expect(
      homeRestoreResultIsStale({
        ...bound,
        generationNow: 7,
        urlNow: bound.urlAtStart,
        profileNow: 'Atlas',
        frameLoaded: false,
      })
    ).toBe(true);
  });

  it('an outstanding restore CANNOT execute after the live document was replaced by a same-URL reload', () => {
    // Behavioral simulation of the reload race the pane wires: model the live
    // document by a mutable load generation (what did-start-loading bumps) and a
    // deferred restore that binds the generation at invocation, then resolves
    // only AFTER a reload has begun. The guard must reject it even though URL,
    // profile, and frameLoaded are byte-identical across the reload.
    let liveGeneration = 4; // the document that is live when the restore is bound
    const urlNow = '/hermes-desktop/?aceProfile=Atlas';
    const profileNow = 'Atlas';

    // 1. Restore bound while document gen=4 is live.
    const generationAtStart = liveGeneration;
    let seeded = false;
    const resolveRestore = () => {
      if (
        !homeRestoreResultIsStale({
          generationAtStart,
          urlAtStart: urlNow,
          profileAtStart: profileNow,
          generationNow: liveGeneration,
          urlNow,
          profileNow,
          frameLoaded: true,
        })
      ) {
        seeded = true; // would run result.script in the live frame
      }
    };

    // 2. A same-URL reload begins → did-start-loading bumps the generation.
    liveGeneration += 1; // now gen=5 is (loading, then) live at the same URL/profile

    // 3. The restore bound under gen=4 finally resolves.
    resolveRestore();
    expect(seeded).toBe(false); // the stale seed was rejected — no cross-document leak

    // A restore bound under the NOW-live document still runs.
    let freshSeeded = false;
    if (
      !homeRestoreResultIsStale({
        generationAtStart: liveGeneration,
        urlAtStart: urlNow,
        profileAtStart: profileNow,
        generationNow: liveGeneration,
        urlNow,
        profileNow,
        frameLoaded: true,
      })
    ) {
      freshSeeded = true;
    }
    expect(freshSeeded).toBe(true);
  });

  it('wires the guard to the generation + profile captured at invocation, and bumps generation on did-start-loading', () => {
    // Guard wiring: the restore closure binds the live document's generation and
    // profile at invocation and feeds both (plus the live URL) into the guard.
    expect(pane).toContain('const generationAtStart = loadGenerationRef.current;');
    expect(pane).toContain('const profileAtStart = activeEmbedProfile();');
    expect(pane).toContain('generationNow: loadGenerationRef.current,');
    expect(pane).toContain('profileNow: activeEmbedProfile(),');
    expect(pane).toContain('homeRestoreResultIsStale({');
    expect(pane).not.toContain('if (stateRef.current.url !== urlAtStart || !frameLoadedRef.current) return undefined;');

    // Generation source: a monotonic counter bumped ONLY at document-load start,
    // registered on the webview so an in-frame same-URL reload advances it.
    expect(pane).toContain('const loadGenerationRef = useRef(0);');
    expect(pane).toContain('loadGenerationRef.current += 1;');
    expect(pane).toContain("el.addEventListener('did-start-loading', onStartLoading);");
    expect(pane).toContain("el.removeEventListener('did-start-loading', onStartLoading);");
  });
});
