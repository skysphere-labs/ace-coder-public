// Latest-value coalescer for renderer-side broadcast storms.
//
// The main process can emit several full-state broadcasts inside one frame
// (mutation bursts, git watcher, remote poller). Applying each one re-runs
// every store selector; under load that starves the JS event loop and is a
// direct cause of embedded-webview jank. This applies the FIRST broadcast
// immediately (zero perceived latency), then collapses any burst to one
// trailing apply of the LATEST value per window — intermediate snapshots are
// superseded, never queued.
export function createLatestCoalescer<T>(
  apply: (value: T) => void,
  windowMs: number
): (value: T) => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: { value: T } | null = null;

  const flushTrailing = () => {
    timer = null;
    if (!pending) return;
    const { value } = pending;
    pending = null;
    run(value);
  };

  const run = (value: T) => {
    try {
      apply(value);
    } finally {
      timer = setTimeout(flushTrailing, windowMs);
    }
  };

  return (value: T) => {
    if (timer) {
      pending = { value };
      return;
    }
    run(value);
  };
}
