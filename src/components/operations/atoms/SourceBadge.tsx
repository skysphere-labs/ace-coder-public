import {
  AtSign,
  Flame,
  GitBranch,
  Globe,
  GraduationCap,
  MessagesSquare,
  Package,
  Radar,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '../../../lib/utils';
import { Chip, type ChipTone } from './Chip';
import { SOURCE_CLASS_LABEL, type IntelSourceClass } from '../intel-labels';

// D5 source badge — answers "what's from X vs news vs GitHub" at a glance.
// Each source class gets a FIXED icon + short label, always paired: the
// distinct icons carry the distinction; tones stay on the existing Chip
// palette (greyscale + the sky accent — amber/emerald/rose remain reserved
// signal colours). Curated items ('signal') get the sky tint so the operator's
// own picks read apart from raw feeds.
const ICON_BY_CLASS: Record<IntelSourceClass, LucideIcon> = {
  github: GitBranch,
  social: AtSign,
  news: Globe,
  hackernews: Flame,
  research: GraduationCap,
  reddit: MessagesSquare,
  vendor: Package,
  signal: Radar,
};

const TONE_BY_CLASS: Record<IntelSourceClass, ChipTone> = {
  github: 'neutral',
  social: 'sky',
  news: 'neutral',
  hackernews: 'neutral',
  research: 'neutral',
  reddit: 'neutral',
  vendor: 'neutral',
  signal: 'sky',
};

export function SourceBadge({
  sourceClass,
  className,
}: {
  sourceClass: IntelSourceClass;
  className?: string;
}) {
  const Icon = ICON_BY_CLASS[sourceClass];
  return (
    <Chip tone={TONE_BY_CLASS[sourceClass]} className={cn('shrink-0', className)}>
      <Icon className="h-3 w-3" aria-hidden="true" />
      {SOURCE_CLASS_LABEL[sourceClass]}
    </Chip>
  );
}
