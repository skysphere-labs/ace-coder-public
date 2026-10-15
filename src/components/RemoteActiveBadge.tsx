import { useEffect, useState } from 'react';
import { Radio } from 'lucide-react';
import { aceApi, type RemoteStatus, isRemoteClient } from '../lib/ace-api';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';

export function RemoteActiveBadge() {
  const [status, setStatus] = useState<RemoteStatus | null>(null);

  useEffect(() => {
    if (isRemoteClient()) return;
    aceApi.remote.getStatus().then(setStatus).catch(() => setStatus(null));
    const off = aceApi.remote.onStatusChanged((next) => setStatus(next));
    return () => off();
  }, []);

  if (isRemoteClient()) return null;
  if (!status || !status.running || status.connectedClients === 0) return null;

  const label = `${status.connectedClients} device${status.connectedClients === 1 ? '' : 's'}`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className="flex h-6 items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 text-[11px] font-medium text-emerald-400"
          role="status"
          aria-live="polite"
        >
          <Radio className="h-3 w-3 animate-pulse" />
          <span>Remote · {label}</span>
        </div>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        Sleep paused while remote clients are connected.
      </TooltipContent>
    </Tooltip>
  );
}
