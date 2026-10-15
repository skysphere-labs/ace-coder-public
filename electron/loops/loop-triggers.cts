// loop-triggers — fire loops on a schedule/event WITHOUT a button press (PRD §9
// Slice 3), reusing the existing in-process injected-timer scheduler pattern
// (electron/knowledge-nightly-scheduler.cts et al.) — NOT a new scheduling engine
// (PRD §2 invariant 6). Every effect (clock, timers, listLoops, runLoop) is
// INJECTED, so the module is pure + unit-testable with fake timers and never
// auto-fires in a test/isolated boot unless the caller wires real timers.
//
// A `schedule` trigger fires on an interval (everyMs) or a daily wall-clock time
// (dailyAt HH:MM, local). An `event` trigger is matched by name via fireEvent — the
// manager seam (PRD §9 "manager invokeLoop"); it is never auto-conjured (PRD §12),
// firing it is an explicit call. Launch via any trigger is the SAME runLoop the
// button calls (PRD §7 "same invokeLoop API serves manager/triggers").
//
// PURITY (PRD §5, §R2): no better-sqlite3, no Electron, no top-level Date.now /
// Math.random / argless new Date(). The clock is injected; `new Date(injectedMs)`
// (with an argument) is used only to resolve a daily wall-clock boundary.

import type { LoopSpec, LoopTrigger } from './loop-spec.cts';

const DAY_MS = 86_400_000;
const MIN_EVERY_MS = 60_000;

function isValidHhMm(v: any): boolean {
  return typeof v === 'string' && /^([01]?\d|2[0-3]):([0-5]\d)$/.test(v.trim());
}

/**
 * The next fire time (ms epoch) for a single trigger given `nowMs`, or null when it
 * never time-fires (disabled, an event trigger, or a malformed schedule). For an
 * interval trigger the next fire is now + everyMs; for a daily trigger it is the
 * next local HH:MM strictly after now (today if still ahead, else tomorrow).
 */
export function computeNextFire(trigger: LoopTrigger | any, nowMs: number): number | null {
  const t = trigger && typeof trigger === 'object' ? trigger : null;
  if (!t || t.enabled !== true || t.kind !== 'schedule') return null;
  const now = Number(nowMs);
  if (!Number.isFinite(now)) return null;

  if (Number.isFinite(t.everyMs) && Number(t.everyMs) >= MIN_EVERY_MS) {
    return now + Number(t.everyMs);
  }
  if (isValidHhMm(t.dailyAt)) {
    const [hh, mm] = String(t.dailyAt).trim().split(':').map((s: string) => parseInt(s, 10));
    const d = new Date(now);
    const candidate = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hh, mm, 0, 0).getTime();
    return candidate > now ? candidate : candidate + DAY_MS;
  }
  return null;
}

/** Enabled schedule triggers across all loops, paired with their loopId. */
export function scheduleTriggersOf(loops: LoopSpec[] | any): Array<{ loopId: string; trigger: LoopTrigger }> {
  const out: Array<{ loopId: string; trigger: LoopTrigger }> = [];
  for (const loop of Array.isArray(loops) ? loops : []) {
    const triggers = loop && Array.isArray(loop.triggers) ? loop.triggers : [];
    for (const t of triggers) {
      if (t && t.kind === 'schedule' && t.enabled === true) out.push({ loopId: String(loop.id), trigger: t });
    }
  }
  return out;
}

/** Loop ids whose ENABLED event trigger matches `eventName` (the manager seam). */
export function loopsForEvent(loops: LoopSpec[] | any, eventName: string): string[] {
  const want = String(eventName || '').trim();
  if (!want) return [];
  const out: string[] = [];
  for (const loop of Array.isArray(loops) ? loops : []) {
    const triggers = loop && Array.isArray(loop.triggers) ? loop.triggers : [];
    for (const t of triggers) {
      if (t && t.kind === 'event' && t.enabled === true && String(t.event || '').trim() === want) {
        out.push(String(loop.id));
        break;
      }
    }
  }
  return out;
}

export interface LoopTriggerSchedulerDeps {
  /** injected clock — ms epoch (no top-level Date.now). */
  now: () => number;
  /** injected timer (Electron main's global, or a fake in tests). Returns a handle. */
  setTimeout: (fn: () => void, ms: number) => any;
  clearTimeout: (handle: any) => void;
  /** read the current saved loops (the catalog) — re-read on each (re)schedule. */
  listLoops: () => LoopSpec[];
  /** fire a loop — the SAME runLoop the button/IPC calls (PRD §7). */
  runLoop: (loopId: string) => void | Promise<any>;
  logger?: { error?: (...a: any[]) => void; info?: (...a: any[]) => void };
}

export interface LoopTriggerScheduler {
  /** (re)arm timers for every enabled schedule trigger. Idempotent (clears first). */
  start: () => void;
  /** clear all armed timers. */
  stop: () => void;
  /** fire every loop whose enabled event trigger matches; returns the fired ids. */
  fireEvent: (eventName: string) => string[];
  /** armed timer count (gauge / test introspection). */
  armedCount: () => number;
}

/**
 * Build the trigger scheduler. Mirrors the daily-scheduler pattern: a single
 * self-rescheduling setTimeout per enabled schedule trigger (re-reads the catalog
 * each cycle so an edited/removed trigger drops out), plus an explicit fireEvent
 * for event triggers. Never throws out of a fired runLoop (logs + reschedules).
 */
export function createLoopTriggerScheduler(deps: LoopTriggerSchedulerDeps): LoopTriggerScheduler {
  if (!deps || typeof deps.now !== 'function' || typeof deps.setTimeout !== 'function' || typeof deps.clearTimeout !== 'function') {
    throw new Error('loop-triggers: createLoopTriggerScheduler requires injected { now, setTimeout, clearTimeout }');
  }
  const now = deps.now;
  const setT = deps.setTimeout;
  const clearT = deps.clearTimeout;
  const listLoops = typeof deps.listLoops === 'function' ? deps.listLoops : () => [];
  const runLoop = typeof deps.runLoop === 'function' ? deps.runLoop : () => {};
  const logger = deps.logger || {};

  const handles = new Set<any>();
  let stopped = false;

  function triggerKey(loopId: string, trigger: LoopTrigger): string {
    return `${loopId}::${trigger.id || trigger.dailyAt || trigger.everyMs || 'sched'}`;
  }

  function armOne(loopId: string, trigger: LoopTrigger): void {
    if (stopped) return;
    const next = computeNextFire(trigger, now());
    if (next == null) return;
    const delay = Math.max(0, next - now());
    const handle = setT(() => {
      handles.delete(handle);
      if (stopped) return;
      // Re-read the catalog: only fire if the trigger still exists + is enabled.
      const live = scheduleTriggersOf(listLoops()).find((s) => triggerKey(s.loopId, s.trigger) === triggerKey(loopId, trigger));
      if (live) {
        try {
          const r = runLoop(loopId);
          if (r && typeof (r as any).catch === 'function') (r as any).catch((e: any) => logger.error && logger.error('loop-trigger run failed', e));
        } catch (e) {
          if (logger.error) logger.error('loop-trigger run threw', e);
        }
        armOne(loopId, trigger); // reschedule the next cycle
      }
    }, delay);
    handles.add(handle);
  }

  function start(): void {
    stop();
    stopped = false;
    for (const { loopId, trigger } of scheduleTriggersOf(listLoops())) armOne(loopId, trigger);
  }

  function stop(): void {
    stopped = true;
    for (const h of handles) clearT(h);
    handles.clear();
    stopped = false;
  }

  function fireEvent(eventName: string): string[] {
    const ids = loopsForEvent(listLoops(), eventName);
    for (const id of ids) {
      try {
        const r = runLoop(id);
        if (r && typeof (r as any).catch === 'function') (r as any).catch((e: any) => logger.error && logger.error('loop-event run failed', e));
      } catch (e) {
        if (logger.error) logger.error('loop-event run threw', e);
      }
    }
    return ids;
  }

  function armedCount(): number {
    return handles.size;
  }

  return { start, stop, fireEvent, armedCount };
}

module.exports = {
  computeNextFire,
  scheduleTriggersOf,
  loopsForEvent,
  createLoopTriggerScheduler,
  MIN_EVERY_MS,
};
