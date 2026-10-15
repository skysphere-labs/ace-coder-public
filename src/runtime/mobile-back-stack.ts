import { useEffect, useRef } from 'react';

// A tiny LIFO registry of "close me first" handlers for the mobile back
// button. Screens with local overlay state (e.g. the New-tab picker inside
// ParallelTaskScreen / SessionScreen) register while the overlay is open; the
// shell consumes the most recently registered handler before falling back to
// view-level navigation.

type Handler = () => void;
const stack: Handler[] = [];

export function consumeMobileBack(): boolean {
  const handler = stack[stack.length - 1];
  if (!handler) return false;
  handler();
  return true;
}

export function useMobileBackHandler(active: boolean, handler: Handler) {
  const latest = useRef(handler);
  useEffect(() => {
    latest.current = handler;
  }, [handler]);

  useEffect(() => {
    if (!active) return;
    const fn = () => latest.current();
    stack.push(fn);
    return () => {
      const i = stack.lastIndexOf(fn);
      if (i >= 0) stack.splice(i, 1);
    };
  }, [active]);
}
