import { useState, useEffect, useRef } from 'react';
import { Zap, X, CornerDownLeft, Users } from 'lucide-react';
import { cn } from '../../lib/utils';
import AgentLogo from '../ProviderGlyph';
import type { Variant } from '../../lib/types';

interface BroadcastPanelProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (message: string, targetIds: string[]) => void;
  variants: Variant[];
}

export default function BroadcastPanel({
  isOpen,
  onClose,
  onSubmit,
  variants,
}: BroadcastPanelProps) {
  if (!isOpen) return null;

  return <BroadcastPanelContent onClose={onClose} onSubmit={onSubmit} variants={variants} />;
}

function BroadcastPanelContent({
  onClose,
  onSubmit,
  variants,
}: Omit<BroadcastPanelProps, 'isOpen'>) {
  const [animIn, setAnimIn] = useState(false);
  const [message, setMessage] = useState('');
  const [targetMode, setTargetMode] = useState<'all' | 'select'>('all');
  const [selectedAgents, setSelectedAgents] = useState<Set<number>>(new Set());
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const frame = requestAnimationFrame(() => setAnimIn(true));
    const focusTimer = window.setTimeout(() => inputRef.current?.focus(), 50);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(focusTimer);
    };
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const toggleAgent = (idx: number) => {
    setSelectedAgents((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleSubmit = () => {
    if (!message.trim()) return;
    const targets =
      targetMode === 'all' ? variants.map((v) => v.id) : Array.from(selectedAgents).map((i) => variants[i].id);
    onSubmit(message, targets);
    onClose();
  };

  const activeCount = targetMode === 'all' ? variants.length : selectedAgents.size;

  return (
    <>
      <div
        className={cn(
          'glass-overlay absolute inset-0 z-40 transition-opacity duration-200',
          animIn ? 'opacity-100' : 'opacity-0'
        )}
        onClick={onClose}
      />

      <div
        className={cn(
          'absolute inset-x-0 z-50 mx-auto transition-all duration-200',
          'top-[18%] w-full max-w-2xl px-6',
          animIn ? 'translate-y-0 opacity-100' : '-translate-y-4 opacity-0'
        )}
      >
        <div className="glass-surface overflow-hidden rounded-2xl">
          <div className="flex items-center gap-3 border-b border-white/[0.06] px-5 py-4">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/[0.05]">
              <Zap className="h-4 w-4 text-foreground/60" />
            </div>
            <div className="flex-1">
              <h3 className="text-sm font-semibold text-foreground">Broadcast Command</h3>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                Send a message to{' '}
                {targetMode === 'all'
                  ? 'all agents'
                  : `${activeCount} selected agent${activeCount !== 1 ? 's' : ''}`}
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-2 border-b border-white/[0.06] px-5 py-3">
            <button
              type="button"
              onClick={() => setTargetMode('all')}
              className={cn(
                'flex items-center gap-1.5 rounded-full px-3 py-1 text-[11px] font-medium transition-colors',
                targetMode === 'all'
                  ? 'bg-white/[0.08] text-foreground shadow-[inset_0_0_0_1px_hsl(0_0%_100%/0.06)]'
                  : 'text-muted-foreground hover:bg-white/[0.06] hover:text-foreground'
              )}
            >
              <Users className="h-3 w-3" />
              All agents
            </button>

            <div className="h-4 w-px bg-white/10" />

            {variants.map((variant, idx) => {
              const isSelected = targetMode === 'select' && selectedAgents.has(idx);
              const isBusy = variant.busy;

              return (
                <button
                  key={variant.id}
                  type="button"
                  onClick={() => {
                    if (targetMode !== 'select') setTargetMode('select');
                    toggleAgent(idx);
                  }}
                  className={cn(
                    'flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium transition-all',
                    isSelected
                      ? 'bg-white/[0.08] text-foreground shadow-[inset_0_0_0_1px_hsl(0_0%_100%/0.06)]'
                      : targetMode === 'all'
                        ? 'bg-white/[0.03] text-foreground/70'
                        : 'text-muted-foreground hover:bg-white/[0.06] hover:text-foreground'
                  )}
                >
                  <AgentLogo agent={variant.agent} className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{variant.name}</span>
                  {isBusy && (
                    <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-amber-400" />
                  )}
                </button>
              );
            })}
          </div>

          <div className="px-5 py-4">
            <textarea
              ref={inputRef}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Tell the agents what to do..."
              className={cn(
                'w-full resize-none rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 py-2.5 text-sm text-foreground',
                'placeholder:text-muted-foreground/50',
                'focus:border-white/20 focus:outline-none focus:ring-0',
                'transition-colors'
              )}
              rows={3}
            />
          </div>

          <div className="flex items-center justify-between border-t border-white/[0.06] px-5 py-3">
            <div className="flex items-center gap-3">
              <div className="flex -space-x-1">
                {variants.map((variant, idx) => {
                  const isTarget = targetMode === 'all' || (targetMode === 'select' && selectedAgents.has(idx));
                  if (!isTarget) return null;
                  return (
                    <div
                      key={variant.id}
                      className="flex h-5 w-5 items-center justify-center rounded-full border border-white/10 bg-white/[0.05]"
                      title={variant.name}
                    >
                      <AgentLogo agent={variant.agent} className="h-3 w-3" />
                    </div>
                  );
                })}
              </div>
              <span className="text-[10px] text-muted-foreground">
                {activeCount} agent{activeCount !== 1 ? 's' : ''} will receive this
              </span>
            </div>

            <div className="flex items-center gap-2">
              <span className="text-[10px] text-muted-foreground/60">↵ send · esc close</span>
              <button
                type="button"
                onClick={handleSubmit}
                disabled={!message.trim() || (targetMode === 'select' && selectedAgents.size === 0)}
                className={cn(
                  'flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-all',
                  message.trim() && (targetMode === 'all' || selectedAgents.size > 0)
                    ? 'bg-foreground text-background shadow-sm hover:bg-foreground/90'
                    : 'cursor-not-allowed bg-white/[0.04] text-muted-foreground'
                )}
              >
                <CornerDownLeft className="h-3 w-3" />
                Send
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
