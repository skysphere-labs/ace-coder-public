/**
 * KnowledgeResultRow — one knowledge-base search hit.
 *
 * Tier chip (canon emerald > working sky > external neutral > raw amber),
 * decay indicator with reasons (rose — decayed content is deprioritized for a
 * reason and must not be cited as authoritative), tags, freshness, excerpt.
 * Clicking expands the full entry inline via aceApi.knowledge.get (16KB
 * cap server-side) — works for every source root, not just the ops wiki.
 */

import { useCallback, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { KnowledgeHit } from '../../../lib/ace-api';
import { aceApi } from '../../../lib/ace-api';
import { cn, formatRelativeTime } from '../../../lib/utils';
import { Chip, type ChipTone } from '../atoms/Chip';
import { InfoTip } from '../atoms/InfoTip';
import { Markdown } from '../../ace-chat/render';

const TIER_TONE: Record<string, ChipTone> = {
  canon: 'emerald',
  working: 'sky',
  external: 'neutral',
  raw: 'amber',
};

export function KnowledgeResultRow({ hit }: { hit: KnowledgeHit }) {
  const [expanded, setExpanded] = useState(false);
  const [body, setBody] = useState<string | null>(null);
  const [bodyError, setBodyError] = useState<string | null>(null);
  const decayed = hit.decay < 1;

  const toggle = useCallback(() => {
    setExpanded((prev) => !prev);
    if (body === null && bodyError === null) {
      aceApi.knowledge
        .get({ path: hit.path })
        .then((entry) => {
          if (entry.ok && typeof entry.body === 'string') {
            setBody(entry.truncated ? `${entry.body}\n\n…truncated (16KB cap)` : entry.body);
          } else {
            setBodyError(entry.error ?? 'Entry is not directly readable (structured source).');
          }
        })
        .catch((err) => setBodyError(String(err?.message ?? err)));
    }
  }, [body, bodyError, hit.path]);

  return (
    <div className="rounded-md border border-white/[0.06] bg-white/[0.02]">
      <button
        type="button"
        onClick={toggle}
        className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-white/[0.03]"
      >
        {expanded ? (
          <ChevronDown className="mt-0.5 h-3.5 w-3.5 shrink-0 text-foreground/50" aria-hidden="true" />
        ) : (
          <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-foreground/50" aria-hidden="true" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate text-[13px] font-medium text-foreground/90">{hit.title}</span>
            <Chip tone={TIER_TONE[hit.trust] ?? 'neutral'}>{hit.trust}</Chip>
            {decayed && (
              <Chip tone="rose" className="gap-1">
                decay {hit.decay}
                <InfoTip
                  label={`Deprioritized: ${hit.decayReasons.join(', ') || 'decayed'}. Do not cite as authoritative.`}
                />
              </Chip>
            )}
            {hit.tags.slice(0, 4).map((tag) => (
              <Chip key={tag}>{tag}</Chip>
            ))}
          </div>
          <p className="mt-1 line-clamp-2 break-words text-xs text-foreground/65">{hit.excerpt}</p>
          <p className="mt-1 truncate font-mono text-[11px] text-foreground/40">
            {hit.project ? `${hit.project} · ` : ''}
            {hit.relPath}
            {hit.updatedAt ? ` · ${formatRelativeTime(hit.updatedAt)}` : ''}
            {` · score ${hit.score}`}
          </p>
        </div>
      </button>
      {expanded && (
        <div className={cn('border-t border-white/[0.06] px-4 py-3', decayed && 'opacity-80')}>
          {bodyError ? (
            <p className="text-xs text-foreground/55">{bodyError}</p>
          ) : body === null ? (
            <p className="text-xs text-foreground/55">Loading…</p>
          ) : (
            <div className="prose-sm max-w-none text-[13px]">
              <Markdown>{body}</Markdown>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
