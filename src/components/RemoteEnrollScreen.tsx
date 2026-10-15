import { useEffect, useState } from 'react';
import { Spinner } from './ui/spinner';
import { Button } from './ui/button';
import { remoteEnroll } from '../lib/ace-api';

export function RemoteEnrollScreen({ onEnrolled }: { onEnrolled: () => void }) {
  const [input, setInput] = useState('');
  const [deviceName, setDeviceName] = useState(() => defaultName());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [autoStatus, setAutoStatus] = useState<'idle' | 'attempting' | 'failed'>('idle');

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const parsed = parseFragment(window.location.hash);
    if (!parsed) return;
    setAutoStatus('attempting');
    setBusy(true);
    void (async () => {
      try {
        await remoteEnroll({
          url: parsed.url,
          enrollmentToken: parsed.enrollmentToken,
          name: defaultName(),
        });
        history.replaceState(null, '', window.location.pathname);
        onEnrolled();
      } catch (err) {
        setAutoStatus('failed');
        setError(err instanceof Error ? err.message : String(err));
        history.replaceState(null, '', window.location.pathname);
      } finally {
        setBusy(false);
      }
    })();
  }, [onEnrolled]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const parsed = parseManual(input);
      if (!parsed) {
        throw new Error('Paste either the enrollment URL or the JSON payload from the desktop settings panel.');
      }
      await remoteEnroll({
        url: parsed.url,
        enrollmentToken: parsed.enrollmentToken,
        name: deviceName.trim() || undefined,
      });
      onEnrolled();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (autoStatus === 'attempting') {
    return (
      <div className="flex h-[100dvh] w-full items-center justify-center bg-background text-foreground">
        <div className="flex flex-col items-center gap-3 text-sm text-muted-foreground">
          <Spinner size="lg" className="text-muted-foreground" />
          Enrolling this device…
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-[100dvh] w-full items-center justify-center bg-background p-6 text-foreground">
      <div className="w-full max-w-md space-y-6">
        <div className="space-y-2 text-center">
          <h1 className="font-display text-2xl font-semibold tracking-tight">Connect to Ace</h1>
          <p className="text-sm text-muted-foreground">
            Open <span className="font-medium">Settings → Remote Access</span> on the
            desktop app and scan the QR. To enroll without a camera, paste the
            enrollment URL or JSON payload below.
          </p>
        </div>
        <div className="space-y-3">
          <label className="block text-xs font-medium text-muted-foreground">
            Device name
            <input
              className="mt-1 w-full rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              value={deviceName}
              onChange={(e) => setDeviceName(e.target.value)}
              placeholder="Phone"
            />
          </label>
          <label className="block text-xs font-medium text-muted-foreground">
            Enrollment URL or payload
            <textarea
              className="mt-1 h-32 w-full resize-none rounded-md border border-border bg-card px-3 py-2 font-mono text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="http://…/#enroll=…"
            />
          </label>
          {error && (
            <p className="rounded-md border border-destructive/30 bg-destructive/10 p-2 text-xs text-destructive">
              {error}
            </p>
          )}
          <Button className="w-full" onClick={submit} disabled={busy || !input.trim()}>
            {busy ? 'Connecting…' : 'Connect'}
          </Button>
        </div>
      </div>
    </div>
  );
}

function parseFragment(rawHash: string): { url: string; enrollmentToken: string } | null {
  if (!rawHash || rawHash.length <= 1) return null;
  const params = new URLSearchParams(rawHash.replace(/^#/, ''));
  const token = params.get('enroll');
  if (!token) return null;
  return { url: window.location.origin, enrollmentToken: token };
}

function parseManual(raw: string): { url: string; enrollmentToken: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const u = new URL(trimmed);
    if (u.hash) {
      const params = new URLSearchParams(u.hash.replace(/^#/, ''));
      const token = params.get('enroll');
      if (token) return { url: u.origin, enrollmentToken: token };
    }
  } catch {}
  try {
    const data = JSON.parse(trimmed);
    if (typeof data?.url === 'string' && typeof data?.enrollmentToken === 'string') {
      return { url: data.url, enrollmentToken: data.enrollmentToken };
    }
  } catch {}
  return null;
}

function defaultName(): string {
  try {
    return navigator.platform || 'Browser';
  } catch {
    return 'Browser';
  }
}
