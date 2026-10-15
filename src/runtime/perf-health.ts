import { useEffect, useRef } from 'react';
import { aceApi, type PerfRecordInput } from '../lib/ace-api';

function now() {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

export function recordPerf(event: PerfRecordInput) {
  void aceApi.perf.record({ source: 'renderer', ...event }).catch(() => undefined);
}

export async function timePerf<T>(
  name: string,
  fn: () => T | Promise<T>,
  meta?: Record<string, unknown>
): Promise<T> {
  const started = now();
  try {
    return await fn();
  } finally {
    recordPerf({
      kind: 'span',
      name,
      durationMs: now() - started,
      meta,
    });
  }
}

export function useSpinnerPerf(input: {
  active: boolean;
  component: string;
  label?: string;
  route?: string;
  trigger?: string;
  previousContent?: boolean;
  meta?: Record<string, unknown>;
}) {
  const startedAt = useRef<number | null>(null);
  const latest = useRef(input);

  useEffect(() => {
    latest.current = input;
  }, [input]);

  useEffect(() => {
    if (input.active) {
      if (startedAt.current == null) startedAt.current = now();
      return;
    }
    if (startedAt.current == null) return;
    const durationMs = now() - startedAt.current;
    startedAt.current = null;
    recordPerf({
      kind: 'spinner',
      component: latest.current.component,
      name: latest.current.component,
      label: latest.current.label,
      route: latest.current.route,
      trigger: latest.current.trigger,
      previousContent: latest.current.previousContent,
      durationMs,
      meta: latest.current.meta,
    });
  }, [input.active]);

  useEffect(() => {
    return () => {
      if (startedAt.current == null) return;
      const durationMs = now() - startedAt.current;
      startedAt.current = null;
      recordPerf({
        kind: 'spinner',
        component: latest.current.component,
        name: latest.current.component,
        label: latest.current.label,
        route: latest.current.route,
        trigger: latest.current.trigger,
        previousContent: latest.current.previousContent,
        durationMs,
        meta: latest.current.meta,
      });
    };
  }, []);
}
