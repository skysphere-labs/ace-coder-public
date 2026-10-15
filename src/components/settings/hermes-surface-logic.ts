// Pure normalizers and copy-builders for HermesSurfaceSection. React-free so
// the mutual-exclusion copy (which must stay brutally honest) is pinned by
// unit tests, mirroring storage-section-logic.
//
// HermesDesktopStatusLike is a LOCAL structural mirror of the documented
// aceApi.hermesDesktop contract ({ surface, dashboards: [{ homeKey,
// running }] }). The namespace ships with the dashboard manager (a separate
// unit); this module duplicates the shape on purpose so it compiles
// standalone — structural typing keeps the IPC integration unit compatible.

export type HermesSurface = 'lanes' | 'dashboard';

export const DEFAULT_HERMES_SURFACE: HermesSurface = 'lanes';

export interface HermesDashboardLike {
  homeKey: string;
  running: boolean;
}

export interface HermesDesktopStatusLike {
  surface: HermesSurface;
  dashboards: HermesDashboardLike[];
}

export const HERMES_SURFACE_SECTION_TITLE = 'Hermes Desktop';

export const HERMES_SURFACE_ROW_TITLE = 'Surface';

export interface HermesSurfaceOption {
  id: HermesSurface;
  label: string;
}

/** Lanes first — it is the default and the only surface that exists today. */
export const HERMES_SURFACE_OPTIONS: readonly HermesSurfaceOption[] = [
  { id: 'lanes', label: 'Lanes' },
  { id: 'dashboard', label: 'Hermes Desktop' },
] as const;

export const SURFACE_MUTUAL_EXCLUSION_COPY =
  'Switching a home to the desktop surface pauses its terminal lane while the desktop surface owns that home; operator homes pause their orchestration loop.';

export const MANAGER_UNAVAILABLE_NOTICE =
  'The Hermes Desktop manager is not available in this build yet — every Hermes home stays on the Lanes surface.';

/** Anything that is not exactly 'dashboard' falls back to the lanes default. */
export function normalizeHermesSurface(value: unknown): HermesSurface {
  return value === 'dashboard' ? 'dashboard' : DEFAULT_HERMES_SURFACE;
}

/**
 * Normalize an unknown IPC payload into a status snapshot. Returns null for
 * anything without a `surface` field (e.g. `{ ok: true }` acks), so a write
 * acknowledgement can never masquerade as a fresh status and clobber state.
 */
export function normalizeHermesDesktopStatus(value: unknown): HermesDesktopStatusLike | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as { surface?: unknown; dashboards?: unknown };
  if (typeof raw.surface !== 'string') return null;
  const dashboards: HermesDashboardLike[] = Array.isArray(raw.dashboards)
    ? raw.dashboards.flatMap((entry) => {
        if (typeof entry !== 'object' || entry === null) return [];
        const item = entry as { homeKey?: unknown; running?: unknown };
        if (typeof item.homeKey !== 'string' || item.homeKey.length === 0) return [];
        return [{ homeKey: item.homeKey, running: item.running === true }];
      })
    : [];
  return { surface: normalizeHermesSurface(raw.surface), dashboards };
}

export interface HermesSurfaceView {
  surface: HermesSurface;
  /** False when the manager namespace is absent — the control renders inert. */
  enabled: boolean;
  detail: string;
  /** Non-null only when desktop surfaces actually own homes right now. */
  runningDetail: string | null;
}

/**
 * View model for the section. A null status means the manager IPC namespace
 * is not present in this build: the control is disabled on the lanes default
 * and the copy says so — nothing may imply otherwise.
 */
export function describeHermesSurface(status: HermesDesktopStatusLike | null): HermesSurfaceView {
  if (status === null) {
    return {
      surface: DEFAULT_HERMES_SURFACE,
      enabled: false,
      detail: MANAGER_UNAVAILABLE_NOTICE,
      runningDetail: null,
    };
  }
  const running = status.dashboards.filter((dashboard) => dashboard.running).length;
  return {
    surface: status.surface,
    enabled: true,
    detail: SURFACE_MUTUAL_EXCLUSION_COPY,
    runningDetail:
      running === 0
        ? null
        : running === 1
          ? '1 home is currently owned by the desktop surface.'
          : `${running} homes are currently owned by the desktop surface.`,
  };
}
