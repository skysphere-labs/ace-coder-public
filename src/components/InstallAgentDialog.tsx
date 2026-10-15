import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { AlertTriangle, Check, Copy, ExternalLink, Play, X } from 'lucide-react';
import { cn } from '../lib/utils';
import { aceApi } from '../lib/ace-api';
import { invalidateAgentCatalog, type AgentCatalogScope } from '../runtime/agent-registry';
import AgentLogo from './ProviderGlyph';
import { Checkbox } from './ui/checkbox';
import type { AgentCatalogEntry } from '../lib/types';

interface InstallAgentDialogProps {
  agent: AgentCatalogEntry;
  scope?: AgentCatalogScope;
  onClose: () => void;
  onInstalled?: () => void;
}

type InstallStatus = 'idle' | 'running' | 'success' | 'failed';

export function InstallAgentDialog({
  agent,
  scope,
  onClose,
  onInstalled,
}: InstallAgentDialogProps) {
  const command = agent.installCommand;
  const warning = agent.installWarning ?? null;
  const [copied, setCopied] = useState(false);
  const [status, setStatus] = useState<InstallStatus>('idle');
  const [log, setLog] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const logRef = useRef<HTMLPreElement | null>(null);
  const activeStreamRef = useRef<string | null>(null);

  const isRemote = !!scope?.sshHost;
  const target = isRemote
    ? `remote host${scope?.agentUser ? ` (${scope.agentUser})` : ''}`
    : 'your machine';
  const alreadyInstalled = agent.launchable;
  const verb = alreadyInstalled ? 'Reinstall' : 'Install';

  const appendLog = (chunk: string) => {
    setLog((prev) => {
      const next = prev + chunk;
      requestAnimationFrame(() => {
        if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
      });
      return next;
    });
  };

  const handleCopy = async () => {
    if (!command) return;
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };

  const onInstallData = useEffectEvent((payload: { streamId: string; chunk: string }) => {
    if (payload.streamId !== activeStreamRef.current) return;
    appendLog(payload.chunk);
  });

  const onInstallExit = useEffectEvent((payload: { streamId: string; code: number | null }) => {
    if (payload.streamId !== activeStreamRef.current) return;
    activeStreamRef.current = null;
    if (payload.code === 0) {
      setStatus('success');
      appendLog(`\n[install complete]\n`);
      invalidateAgentCatalog(scope);
      onInstalled?.();
      return;
    }
    setStatus('failed');
    appendLog(`\n[exit ${payload.code}]\n`);
  });

  useEffect(() => {
    const unsubData = aceApi.agents.onInstallData(onInstallData);
    const unsubExit = aceApi.agents.onInstallExit(onInstallExit);
    return () => {
      unsubData();
      unsubExit();
    };
  }, []);

  const needsAck = !!warning;
  const runDisabled =
    status === 'running' || (needsAck && !acknowledged);

  const handleRun = async () => {
    if (!command || status === 'running') return;
    if (needsAck && !acknowledged) return;
    setStatus('running');
    setLog(`$ ${command}\n`);
    try {
      const { streamId } = await aceApi.agents.startInstall({
        agentId: agent.id,
        sshHost: scope?.sshHost ?? null,
        agentUser: scope?.agentUser ?? null,
      });
      activeStreamRef.current = streamId;
    } catch (err) {
      setStatus('failed');
      appendLog(`\n[error] ${err instanceof Error ? err.message : String(err)}\n`);
    }
  };

  return (
    <div
      className="glass-overlay fixed inset-0 z-[120] flex items-center justify-center"
      onClick={onClose}
    >
      <div
        className="glass-surface flex w-full max-w-2xl flex-col gap-4 rounded-2xl p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <AgentLogo agent={agent.id} className="h-9 w-9 shrink-0" />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <h2 className="font-display text-lg font-semibold">
              {verb} {agent.label}
            </h2>
            <p className="text-xs text-muted-foreground">
              {alreadyInstalled
                ? `Already installed on ${target}. Re-running will upgrade or repair it.`
                : `Not installed on ${target}. Run the install command to enable it.`}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {command ? (
          <div className="rounded-lg border border-white/[0.08] bg-black/30 p-3">
            <div className="flex items-start gap-2">
              <code className="flex-1 break-all font-mono text-[12px] leading-relaxed text-foreground/90">
                {command}
              </code>
              <button
                type="button"
                onClick={handleCopy}
                className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground"
                title={copied ? 'Copied' : 'Copy'}
                aria-label="Copy install command"
              >
                {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              </button>
            </div>
          </div>
        ) : (
          <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 p-3 text-xs text-amber-200">
            No install command is registered for this agent. Check the docs link below
            for manual installation steps.
          </div>
        )}

        {warning && (
          <div className="rounded-lg border border-amber-500/25 bg-amber-500/[0.06] p-3.5">
            <div className="flex items-start gap-2.5">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <div className="text-xs font-semibold text-amber-200">
                  {warning.title}
                </div>
                <p className="text-[11px] leading-relaxed text-amber-100/90">
                  {warning.body}
                </p>
                {warning.recommendation && (
                  <p className="text-[11px] leading-relaxed text-amber-200/90">
                    {warning.recommendation}
                  </p>
                )}
                <label
                  className={cn(
                    'mt-1 flex cursor-pointer items-start gap-2 rounded-md border border-amber-500/20 bg-amber-500/[0.04] px-2.5 py-2 transition-colors hover:border-amber-400/40',
                    acknowledged && 'border-amber-400/50 bg-amber-500/10'
                  )}
                >
                  <Checkbox
                    checked={acknowledged}
                    onCheckedChange={(checked) => setAcknowledged(checked === true)}
                    className="mt-0.5 border-amber-400/40 data-[state=checked]:border-amber-300 data-[state=checked]:bg-amber-400 data-[state=checked]:text-background"
                  />
                  <span className="text-[11px] font-medium text-amber-100">
                    {warning.confirmLabel}
                  </span>
                </label>
              </div>
            </div>
          </div>
        )}

        {log && (
          <pre
            ref={logRef}
            className="max-h-64 overflow-auto rounded-lg border border-white/[0.08] bg-black/50 p-3 font-mono text-[11px] leading-relaxed text-foreground/80"
          >
            {log}
          </pre>
        )}

        <div className="flex items-center justify-between gap-2">
          {agent.docUrl ? (
            <a
              href={agent.docUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
            >
              <ExternalLink className="h-3 w-3" />
              Docs
            </a>
          ) : (
            <span />
          )}

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg px-4 py-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground"
            >
              {status === 'success' ? 'Done' : 'Cancel'}
            </button>
            {command && status !== 'success' && (
              <button
                type="button"
                onClick={handleRun}
                disabled={runDisabled}
                title={
                  needsAck && !acknowledged
                    ? 'Check the acknowledgement box above to proceed'
                    : undefined
                }
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-xs font-medium transition-all',
                  status === 'running'
                    ? 'cursor-wait bg-white/[0.04] text-muted-foreground'
                    : runDisabled
                      ? 'cursor-not-allowed bg-white/[0.04] text-muted-foreground'
                      : 'bg-foreground text-background shadow-sm hover:bg-foreground/90'
                )}
              >
                <Play className="h-3 w-3" />
                {status === 'running'
                  ? alreadyInstalled ? 'Reinstalling…' : 'Installing…'
                  : status === 'failed'
                    ? `Retry ${verb.toLowerCase()}`
                    : `Run ${verb.toLowerCase()}`}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
