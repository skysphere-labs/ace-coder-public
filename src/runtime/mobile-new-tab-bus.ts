import { useEffect, useRef } from 'react';

// The mobile tab switcher's "+" button needs to open the NewItemPicker that
// lives inside ParallelTaskScreen / SessionScreen (they own the pane layout
// and agent-attach context). Exactly one screen is mounted at a time, so a
// single-slot handler is enough — no full fan-out registry needed.

let handler: (() => void) | null = null;

export function requestNewTab() {
  handler?.();
}

export function useNewTabHandler(fn: () => void) {
  const latest = useRef(fn);
  useEffect(() => {
    latest.current = fn;
  }, [fn]);

  useEffect(() => {
    const bound = () => latest.current();
    handler = bound;
    return () => {
      if (handler === bound) handler = null;
    };
  }, []);
}
