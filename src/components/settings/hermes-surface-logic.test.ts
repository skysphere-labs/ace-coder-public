import { expect, test } from 'vitest';

import {
  DEFAULT_HERMES_SURFACE,
  describeHermesSurface,
  HERMES_SURFACE_OPTIONS,
  MANAGER_UNAVAILABLE_NOTICE,
  normalizeHermesDesktopStatus,
  normalizeHermesSurface,
  SURFACE_MUTUAL_EXCLUSION_COPY,
} from './hermes-surface-logic';

// ---------------------------------------------------------------------------
// normalizeHermesSurface — lanes is the only safe fallback.
// ---------------------------------------------------------------------------

test('default surface is lanes', () => {
  expect(DEFAULT_HERMES_SURFACE).toBe('lanes');
});

test('normalizeHermesSurface accepts only the exact dashboard value', () => {
  expect(normalizeHermesSurface('dashboard')).toBe('dashboard');
  expect(normalizeHermesSurface('lanes')).toBe('lanes');
  expect(normalizeHermesSurface('Dashboard')).toBe('lanes');
  expect(normalizeHermesSurface('desktop')).toBe('lanes');
  expect(normalizeHermesSurface(undefined)).toBe('lanes');
  expect(normalizeHermesSurface(null)).toBe('lanes');
  expect(normalizeHermesSurface(1)).toBe('lanes');
});

// ---------------------------------------------------------------------------
// normalizeHermesDesktopStatus
// ---------------------------------------------------------------------------

test('normalizeHermesDesktopStatus rejects non-status payloads', () => {
  expect(normalizeHermesDesktopStatus(null)).toBeNull();
  expect(normalizeHermesDesktopStatus(undefined)).toBeNull();
  expect(normalizeHermesDesktopStatus('lanes')).toBeNull();
  // A write acknowledgement must never masquerade as a status snapshot.
  expect(normalizeHermesDesktopStatus({ ok: true })).toBeNull();
  expect(normalizeHermesDesktopStatus({ surface: 7 })).toBeNull();
});

test('normalizeHermesDesktopStatus normalizes surface and dashboards', () => {
  expect(normalizeHermesDesktopStatus({ surface: 'dashboard' })).toEqual({
    surface: 'dashboard',
    dashboards: [],
  });
  expect(
    normalizeHermesDesktopStatus({
      surface: 'lanes',
      dashboards: [
        { homeKey: '/data/home-a', running: true },
        { homeKey: '/data/home-b', running: 'yes' },
        { homeKey: '', running: true },
        'garbage',
        null,
      ],
    })
  ).toEqual({
    surface: 'lanes',
    dashboards: [
      { homeKey: '/data/home-a', running: true },
      { homeKey: '/data/home-b', running: false },
    ],
  });
});

test('normalizeHermesDesktopStatus maps unknown surface strings to lanes', () => {
  expect(normalizeHermesDesktopStatus({ surface: 'something-new' })).toEqual({
    surface: 'lanes',
    dashboards: [],
  });
});

// ---------------------------------------------------------------------------
// Options — exactly two, Lanes first (the default).
// ---------------------------------------------------------------------------

test('segmented control offers exactly Lanes and Hermes Desktop', () => {
  expect(HERMES_SURFACE_OPTIONS).toEqual([
    { id: 'lanes', label: 'Lanes' },
    { id: 'dashboard', label: 'Hermes Desktop' },
  ]);
});

// ---------------------------------------------------------------------------
// describeHermesSurface — copy is contractually honest.
// ---------------------------------------------------------------------------

test('manager absent: disabled on the lanes default with honest notice', () => {
  const view = describeHermesSurface(null);
  expect(view.surface).toBe('lanes');
  expect(view.enabled).toBe(false);
  expect(view.detail).toBe(MANAGER_UNAVAILABLE_NOTICE);
  expect(view.runningDetail).toBeNull();
});

test('manager-unavailable notice admits the manager is missing and lanes stay active', () => {
  expect(MANAGER_UNAVAILABLE_NOTICE).toContain('not available in this build yet');
  expect(MANAGER_UNAVAILABLE_NOTICE).toContain('stays on the Lanes surface');
});

test('mutual-exclusion copy names both pause consequences', () => {
  expect(SURFACE_MUTUAL_EXCLUSION_COPY).toBe(
    'Switching a home to the desktop surface pauses its terminal lane while the desktop surface owns that home; operator homes pause their orchestration loop.'
  );
});

test('manager present: enabled with the mutual-exclusion copy', () => {
  const view = describeHermesSurface({ surface: 'dashboard', dashboards: [] });
  expect(view.surface).toBe('dashboard');
  expect(view.enabled).toBe(true);
  expect(view.detail).toBe(SURFACE_MUTUAL_EXCLUSION_COPY);
  expect(view.runningDetail).toBeNull();
});

test('running detail counts only running dashboards, singular and plural', () => {
  const none = describeHermesSurface({
    surface: 'dashboard',
    dashboards: [{ homeKey: '/a', running: false }],
  });
  expect(none.runningDetail).toBeNull();

  const one = describeHermesSurface({
    surface: 'dashboard',
    dashboards: [
      { homeKey: '/a', running: true },
      { homeKey: '/b', running: false },
    ],
  });
  expect(one.runningDetail).toBe('1 home is currently owned by the desktop surface.');

  const two = describeHermesSurface({
    surface: 'dashboard',
    dashboards: [
      { homeKey: '/a', running: true },
      { homeKey: '/b', running: true },
    ],
  });
  expect(two.runningDetail).toBe('2 homes are currently owned by the desktop surface.');
});
