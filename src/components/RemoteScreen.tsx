import { useCallback, useEffect, useState } from 'react';
import {
  Check, Copy, ExternalLink, Loader2, RefreshCw, ShieldAlert,
  Smartphone, Trash2, Wifi,
} from 'lucide-react';
import { cn } from '../lib/utils';
import { Button } from './ui/button';
import { Spinner } from './ui/spinner';
import {
  aceApi,
  isRemoteClient,
  type RemoteDevice,
  type RemoteEnrollmentPayload,
  type RemoteStatus,
  type RemoteTunnelInfo,
} from '../lib/ace-api';
import { RemoteAccessQR } from './RemoteAccessQR';
import { buildEnrollmentUrl } from '../lib/enrollment-url';

type TunnelOption = RemoteStatus['tunnelMode'];

const TUNNEL_ORDER: TunnelOption[] = ['lan', 'tailscale', 'loopback'];

const TUNNEL_LABELS: Record<TunnelOption, string> = {
  loopback: 'Loopback only',
  lan: 'LAN (mDNS)',
  tailscale: 'Tailscale',
};

const TUNNEL_DESCRIPTIONS: Record<TunnelOption, string> = {
  loopback: 'Accessible only from this machine. Useful for testing.',
  lan: 'Easiest option — phone on the same WiFi scans a QR and connects instantly. No app install needed on your phone.',
  tailscale: 'Tailscale must be installed on this Mac AND on your phone, both signed in to the same Tailnet. Works across any network.',
};

const TUNNEL_NOT_INSTALLED: Record<string, string> = {
  tailscale: 'Install Tailscale on this Mac and sign in with `tailscale up`. Then install the Tailscale app on your phone and sign in to the same account.',
};

export function RemoteScreen() {
  return (
    <div className="shell-sidebar-surface flex h-full min-h-0 flex-col overflow-hidden text-foreground">
      <div className="min-h-0 flex-1 overflow-y-auto px-6">
        <div className="mx-auto w-full max-w-4xl px-4 pb-16 pt-6 sm:px-8 sm:pt-10">
          <div className="mb-1 flex items-center gap-2">
            <Wifi className="h-5 w-5 text-foreground/70" />
            <h2 className="font-display text-lg font-semibold tracking-tight">Remote</h2>
          </div>
          <p className="mb-8 text-sm text-muted-foreground">
            Run Ace in a browser tab on your phone, tablet, or another computer.
            Workspaces run on this desktop. Authorized remote clients and agent providers can receive workspace data.
          </p>
          {isRemoteClient() ? <RemoteClientNotice /> : <RemoteAccessBody />}
        </div>
      </div>
    </div>
  );
}

function RemoteClientNotice() {
  return (
    <div className="rounded-xl border border-dashed border-white/[0.08] bg-white/[0.01] px-6 py-10 text-center">
      <p className="text-sm font-medium text-foreground/90">
        Remote access is managed from the desktop
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        Open Ace on the host machine to add or revoke devices.
      </p>
    </div>
  );
}

function RemoteAccessBody() {
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [devices, setDevices] = useState<RemoteDevice[]>([]);
  const [tunnels, setTunnels] = useState<RemoteTunnelInfo[]>([]);
  const [enrollment, setEnrollment] = useState<RemoteEnrollmentPayload | null>(null);
  const [busy, setBusy] = useState<null | 'toggle' | 'tunnel' | 'mint' | 'revoke'>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [s, d, t] = await Promise.all([
        aceApi.remote.getStatus(),
        aceApi.remote.listDevices(),
        aceApi.remote.detectTunnels(),
      ]);
      setStatus(s);
      setDevices(d);
      setTunnels(t);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const offStatus = aceApi.remote.onStatusChanged((next) => setStatus(next));
    const offDevices = aceApi.remote.onDevicesChanged((next) => setDevices(next));
    return () => {
      offStatus();
      offDevices();
    };
  }, [refresh]);

  useEffect(() => {
    if (!enrollment) return;
    const remaining = enrollment.expiresAt - Date.now();
    if (remaining <= 0) {
      setEnrollment(null);
      return;
    }
    const handle = window.setTimeout(() => setEnrollment(null), remaining);
    return () => window.clearTimeout(handle);
  }, [enrollment]);

  const toggle = async (next: boolean) => {
    setBusy('toggle');
    setError(null);
    try {
      const s = await aceApi.remote.setEnabled(next);
      setStatus(s);
      if (!next) setEnrollment(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const setTunnel = async (mode: TunnelOption) => {
    setBusy('tunnel');
    setError(null);
    try {
      const s = await aceApi.remote.setTunnelMode(mode);
      setStatus(s);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const mintQr = async () => {
    setBusy('mint');
    setError(null);
    try {
      const payload = await aceApi.remote.mintEnrollment();
      setEnrollment(payload);
      if (payload) setStatus(payload.status);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const revoke = async (deviceId: string) => {
    setBusy('revoke');
    try {
      const next = await aceApi.remote.revokeDevice(deviceId);
      setDevices(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const copy = (text: string) => {
    try { void navigator.clipboard.writeText(text); } catch {}
  };

  if (!status) {
    return (
      <div className="flex h-40 items-center justify-center">
        <Spinner size="md" className="text-muted-foreground" />
      </div>
    );
  }

  const enabled = status.enabled && status.running;
  const activeDevices = devices.filter((d) => !d.revoked);
  const busyAny = busy !== null;

  return (
    <div className="flex flex-col gap-6">
      <Section>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  'inline-block h-1.5 w-1.5 rounded-full',
                  enabled ? 'bg-emerald-400' : 'bg-muted-foreground/40'
                )}
              />
              <p className="text-sm font-medium">
                {enabled ? 'Listening for devices' : 'Remote access is off'}
              </p>
            </div>
            {enabled && (
              <p className="mt-1.5 text-[11px] text-muted-foreground">
                <span className="font-mono">port {status.port}</span>
                <span className="mx-1.5 text-muted-foreground/40">·</span>
                {status.connectedClients > 0
                  ? `${status.connectedClients} device${status.connectedClients === 1 ? '' : 's'} connected`
                  : 'no devices connected'}
              </p>
            )}
          </div>
          <Toggle
            checked={enabled}
            disabled={busyAny}
            onChange={() => toggle(!enabled)}
            label="Toggle remote access"
          />
        </div>
      </Section>

      {error && (
        <div className="flex items-center gap-2 rounded-xl border border-rose-500/20 bg-rose-500/[0.04] px-3 py-2 text-[11px] text-rose-200">
          <ShieldAlert className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1">{error}</span>
        </div>
      )}

      {enabled && (
        <ConnectionUrl status={status} onCopy={copy} />
      )}

      {enabled && (
        <div className="flex flex-col gap-2.5">
          <SectionHeader title="Connection mode" />
          <div className="grid gap-2 auto-rows-fr sm:grid-cols-2">
            {TUNNEL_ORDER.map((mode) => {
              const info = tunnels.find((t) => t.id === mode);
              const available = mode === 'lan' || mode === 'loopback' || info?.available;
              const current = status.tunnelMode === mode;
              return (
                <TunnelCard
                  key={mode}
                  mode={mode}
                  info={info}
                  status={status}
                  available={!!available}
                  current={current}
                  disabled={busyAny || !available}
                  onSelect={() => setTunnel(mode)}
                />
              );
            })}
          </div>
        </div>
      )}

      {enabled && (
        <div className="flex flex-col gap-2.5">
          <SectionHeader title="Connect a device" />
          {enrollment ? (
            <EnrollmentPanel
              enrollment={enrollment}
              busy={busyAny}
              onRegenerate={mintQr}
              onCopy={copy}
            />
          ) : (
            <Section>
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">Generate enrollment QR</p>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    One-shot token, valid for 5 minutes. Scanning issues the device a
                    long-lived credential you can revoke below.
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={mintQr}
                  disabled={busyAny}
                  className="h-8 gap-1.5 text-xs"
                >
                  {busy === 'mint' ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Smartphone className="h-3.5 w-3.5" />
                  )}
                  Generate QR
                </Button>
              </div>
            </Section>
          )}
        </div>
      )}

      {enabled && (
        <div className="flex flex-col gap-2.5">
          <SectionHeader
            title="Enrolled devices"
            trailing={
              activeDevices.length > 0 ? (
                <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
                  {activeDevices.length}
                </span>
              ) : null
            }
          />
          {activeDevices.length === 0 ? (
            <div className="rounded-xl border border-dashed border-white/[0.08] bg-white/[0.01] px-6 py-8 text-center text-[11px] text-muted-foreground">
              No devices enrolled yet. Generate a QR above to add one.
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              {activeDevices.map((device) => (
                <DeviceRow
                  key={device.id}
                  device={device}
                  disabled={busyAny}
                  onRevoke={() => revoke(device.id)}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Section({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-3">
      {children}
    </div>
  );
}

function SectionHeader({
  title,
  trailing,
}: {
  title: string;
  trailing?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 px-1">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">
        {title}
      </h3>
      {trailing && <div className="ml-auto">{trailing}</div>}
    </div>
  );
}

function Toggle({
  checked,
  disabled,
  onChange,
  label,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      disabled={disabled}
      onClick={onChange}
      aria-checked={checked}
      aria-label={label}
      className={cn(
        'flex h-[22px] w-[40px] shrink-0 items-center rounded-full border px-[3px] transition-colors duration-150',
        checked
          ? 'justify-end border-emerald-400/30 bg-emerald-500/25'
          : 'justify-start border-white/[0.08] bg-white/[0.04]',
        disabled && 'cursor-not-allowed opacity-50'
      )}
    >
      <div
        className={cn(
          'h-4 w-4 rounded-full transition-colors duration-150',
          checked ? 'bg-foreground' : 'bg-foreground/60'
        )}
      />
    </button>
  );
}

function ConnectionUrl({
  status,
  onCopy,
}: {
  status: RemoteStatus;
  onCopy: (text: string) => void;
}) {
  const url = status.primaryUrl;
  const isLoopback = url.includes('127.0.0.1') || url.includes('localhost');
  const tunnelPending = status.tunnelMode === 'tailscale' && !status.tailscaleHost;
  const tailscaleHttpsMissing =
    status.tunnelMode === 'tailscale' && !!status.tailscaleHost && !status.tailscaleHttpsReady;

  if (tunnelPending) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-amber-400/20 bg-amber-400/[0.04] px-4 py-2.5 text-[11px]">
        <Loader2 className="h-3 w-3 shrink-0 animate-spin text-amber-300" />
        <span className="text-amber-200">
          Tailscale hostname not found. Open a terminal and run: tailscale up
        </span>
      </div>
    );
  }

  if (isLoopback && status.tunnelMode !== 'loopback') {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-amber-400/20 bg-amber-400/[0.04] px-4 py-2.5 text-[11px] text-amber-200">
        <ShieldAlert className="h-3 w-3 shrink-0" />
        <span>Tunnel not connected — falling back to loopback ({url})</span>
      </div>
    );
  }

  return (
    <Section>
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
          Reachable at
        </span>
        <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md border border-white/[0.06] bg-white/[0.03] px-2 py-1">
          <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground/90">
            {url}
          </code>
          <button
            type="button"
            onClick={() => onCopy(url)}
            aria-label="Copy URL"
            className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground"
          >
            <Copy className="h-3 w-3" />
          </button>
        </div>
      </div>
      {tailscaleHttpsMissing && (
        <div className="mt-2 flex items-start gap-2 rounded-lg border border-amber-400/20 bg-amber-400/[0.04] px-3 py-2 text-[10px] leading-snug text-amber-200/90">
          <ShieldAlert className="mt-0.5 h-3 w-3 shrink-0" />
          <span>
            Tailscale Serve HTTPS is unavailable for this remote URL. The HTTP URL still works for keyboard and attachments.
            {status.tailscaleHttpsError ? ` (${status.tailscaleHttpsError})` : ''}
          </span>
        </div>
      )}
    </Section>
  );
}

function TunnelCard({
  mode,
  info,
  status,
  available,
  current,
  disabled,
  onSelect,
}: {
  mode: TunnelOption;
  info: RemoteTunnelInfo | undefined;
  status: RemoteStatus;
  available: boolean;
  current: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  const tunnelOk =
    mode === 'tailscale' ? !!status.tailscaleHost :
    true;

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        'group relative flex flex-col gap-1 rounded-xl border p-3 text-left transition-all',
        current
          ? 'border-white/[0.16] bg-white/[0.05]'
          : 'border-white/[0.06] bg-white/[0.02] hover:border-white/[0.10] hover:bg-white/[0.04]',
        disabled && !current && 'cursor-not-allowed opacity-50 hover:border-white/[0.06] hover:bg-white/[0.02]',
        disabled && current && 'cursor-not-allowed'
      )}
    >
      <div className="flex items-center gap-2">
        <p className="text-sm font-medium text-foreground">{TUNNEL_LABELS[mode]}</p>
        {mode === 'tailscale' && info?.recommended && (
          <span className="rounded border border-white/[0.08] bg-white/[0.03] px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-muted-foreground/80">
            Recommended
          </span>
        )}
        {current && tunnelOk && (
          <span className="ml-auto inline-flex items-center gap-1 text-[10px] font-medium text-emerald-300">
            <Check className="h-2.5 w-2.5" />
            Active
          </span>
        )}
        {current && !tunnelOk && (
          <span className="ml-auto text-[10px] font-medium text-amber-300">
            Pending…
          </span>
        )}
      </div>
      <p className="text-[11px] leading-snug text-muted-foreground">
        {!available && TUNNEL_NOT_INSTALLED[mode]
          ? TUNNEL_NOT_INSTALLED[mode]
          : TUNNEL_DESCRIPTIONS[mode]}
      </p>
      {!available && info?.installUrl && (
        <a
          href={info.installUrl}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="mt-1 inline-flex items-center gap-1 self-start rounded border border-white/[0.06] bg-white/[0.03] px-2 py-1 text-[10px] text-foreground/80 transition-colors hover:border-white/[0.10] hover:bg-white/[0.04] hover:text-foreground"
        >
          Install {info.name}
          <ExternalLink className="h-2.5 w-2.5" />
        </a>
      )}
      {current && mode === 'tailscale' && tunnelOk && (
        <div className="mt-2 flex flex-col gap-1.5 rounded-lg border border-amber-400/20 bg-amber-400/[0.04] px-2.5 py-2 text-[10px] leading-snug text-amber-200/90">
          <p className="font-semibold">Your phone needs Tailscale too</p>
          <p className="text-amber-200/70">
            Install the Tailscale app on your phone and sign in to the same
            account. The QR will only work from devices on your Tailnet.
          </p>
        </div>
      )}
    </button>
  );
}

function EnrollmentPanel({
  enrollment,
  busy,
  onRegenerate,
  onCopy,
}: {
  enrollment: RemoteEnrollmentPayload;
  busy: boolean;
  onRegenerate: () => void;
  onCopy: (text: string) => void;
}) {
  const enrollUrl = buildEnrollmentUrl(enrollment.url, enrollment.token);
  return (
    <Section>
      <div className="flex flex-col items-center gap-4">
        <RemoteAccessQR url={enrollment.url} enrollmentToken={enrollment.token} />
        <div className="flex w-full items-center gap-1.5 rounded-md border border-white/[0.06] bg-white/[0.03] px-2 py-1.5 text-[11px]">
          <code className="min-w-0 flex-1 truncate font-mono text-foreground/90">{enrollUrl}</code>
          <button
            type="button"
            onClick={() => onCopy(enrollUrl)}
            aria-label="Copy enrollment URL"
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground"
          >
            <Copy className="h-3 w-3" />
          </button>
        </div>
        <p className="max-w-sm text-center text-[11px] leading-snug text-muted-foreground">
          Scan on a phone already on this network. The token expires in 5 minutes and
          can only be used once.
        </p>
        <div className="flex items-center gap-1.5">
          <Button variant="outline" size="sm" onClick={() => onCopy(enrollUrl)} className="h-7 gap-1.5 text-[11px]">
            <Copy className="h-3 w-3" />
            Copy URL
          </Button>
          <Button variant="outline" size="sm" onClick={onRegenerate} disabled={busy} className="h-7 gap-1.5 text-[11px]">
            <RefreshCw className="h-3 w-3" />
            New QR
          </Button>
        </div>
      </div>
    </Section>
  );
}

function DeviceRow({
  device,
  disabled,
  onRevoke,
}: {
  device: RemoteDevice;
  disabled: boolean;
  onRevoke: () => void;
}) {
  return (
    <div className="group flex items-center gap-3 rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-2.5 transition-colors hover:border-white/[0.10] hover:bg-white/[0.04]">
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-white/[0.06] bg-white/[0.03]">
        <Smartphone className="h-3.5 w-3.5 text-muted-foreground" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">{device.name}</p>
        <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
          Enrolled {formatRelative(device.createdAt)}
          {device.lastSeen && (
            <>
              <span className="mx-1.5 text-muted-foreground/40">·</span>
              Last seen {formatRelative(device.lastSeen)}
            </>
          )}
        </p>
      </div>
      <button
        type="button"
        onClick={onRevoke}
        disabled={disabled}
        aria-label={`Revoke ${device.name}`}
        title="Revoke"
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-all hover:bg-rose-500/10 hover:text-rose-300 group-hover:opacity-100 disabled:cursor-not-allowed"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function formatRelative(iso: string) {
  try {
    const ms = Date.now() - new Date(iso).getTime();
    const minutes = Math.floor(ms / 60_000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  } catch {
    return iso;
  }
}
