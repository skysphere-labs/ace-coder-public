import { useEffect, type CSSProperties, type RefObject } from 'react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function useClickAway<T extends HTMLElement>(
  ref: RefObject<T | null>,
  onClose: () => void,
  enabled = true
) {
  useEffect(() => {
    if (!enabled) return;

    const handler = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        onClose();
      }
    };

    const timer = window.setTimeout(() => {
      document.addEventListener('mousedown', handler);
    }, 0);

    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('mousedown', handler);
    };
  }, [enabled, onClose, ref]);
}

export function formatRelativeTime(value?: string, compact = false): string {
  if (!value) return '';

  const time = new Date(value).getTime();
  const diffMs = Date.now() - time;
  if (Number.isNaN(time) || diffMs < 0) return '';

  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return compact ? 'now' : 'just now';
  if (minutes < 60) return compact ? `${minutes}m` : `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return compact ? `${hours}h` : `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 30) return compact ? `${days}d` : `${days}d ago`;

  const months = Math.floor(days / 30);
  if (months < 12) return compact ? `${months}mo` : `${months}mo ago`;

  const years = Math.floor(days / 365);
  return compact ? `${years}y` : `${years}y ago`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  const gb = mb / 1024;
  return `${gb < 10 ? gb.toFixed(1) : Math.round(gb)} GB`;
}

export function formatCompactNumber(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}K`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}K`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

export function cssVar(name: `--${string}`, value: string | undefined): CSSProperties {
  return { [name]: value } as CSSProperties;
}
