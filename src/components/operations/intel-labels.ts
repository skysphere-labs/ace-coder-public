import type { OpsIntelItem, OpsIntelSection } from '../../lib/ace-api';

// C2 jargon containment: internal feed keys leak raw into section titles when
// the report uses keys as titles — map known keys to friendly display labels.
// Lives outside the component files so react-refresh stays component-only.
const FRIENDLY_SECTION_LABEL: Record<string, string> = {
  top_signals: 'Top signals',
  vendor_updates: 'Vendor updates',
  platform_changelogs: 'Platform changelogs',
  official_feeds: 'Official feeds',
  platform_accounts: 'Platform accounts',
  github_watch: 'GitHub watch',
  github_trending: 'GitHub trending',
  hackernews: 'Hacker News',
  world_news: 'World news',
  reddit: 'Reddit',
  arxiv: 'arXiv',
};

// Display label for a feed section: trust a real title, but never surface a
// raw internal key — fall back to the friendly map, then prettify unknowns.
export function sectionDisplayLabel(section: Pick<OpsIntelSection, 'key' | 'title'>): string {
  const title = section.title.trim();
  if (title && title !== section.key) return title;
  return FRIENDLY_SECTION_LABEL[section.key] ?? section.key.replace(/_/g, ' ');
}

// ── D5: source classes ───────────────────────────────────────────────────────
// Chief's pain: "what's from X, what's from news, what's from GitHub" — every
// feed key maps to ONE of a small set of source classes; the SourceBadge atom
// renders a fixed icon + short label per class so the distinction is visual,
// not prose. 'signal' is the curated/unknown bucket (Top signals, Hot App).
export type IntelSourceClass =
  | 'github'
  | 'social'
  | 'news'
  | 'hackernews'
  | 'research'
  | 'reddit'
  | 'vendor'
  | 'signal';

export const SOURCE_CLASS_BY_KEY: Record<string, IntelSourceClass> = {
  top_signals: 'signal',
  github_watch: 'github',
  github_trending: 'github',
  platform_accounts: 'social',
  world_news: 'news',
  hackernews: 'hackernews',
  arxiv: 'research',
  reddit: 'reddit',
  vendor_updates: 'vendor',
  platform_changelogs: 'vendor',
  official_feeds: 'vendor',
};

export const SOURCE_CLASS_LABEL: Record<IntelSourceClass, string> = {
  github: 'GitHub',
  social: 'X / Social',
  news: 'News',
  hackernews: 'Hacker News',
  research: 'Research',
  reddit: 'Reddit',
  vendor: 'Vendor',
  signal: 'Signal',
};

export function sectionSourceClass(key: string): IntelSourceClass {
  return SOURCE_CLASS_BY_KEY[key] ?? 'signal';
}

// Honest provenance refinement for CURATED items only (Top signals / Hot App,
// where the section key says nothing about origin): classify from the item's
// own URL host / declared source string. Never guesses beyond exact host or
// source-name matches — anything else stays 'signal'.
function classFromItemProvenance(
  item: Pick<OpsIntelItem, 'url' | 'source'>
): IntelSourceClass | null {
  let host = '';
  if (item.url) {
    try {
      host = new URL(item.url).hostname.toLowerCase();
    } catch {
      host = '';
    }
  }
  const probe = `${host} ${(item.source ?? '').toLowerCase()}`;
  if (probe.includes('github')) return 'github';
  if (/(^|[\s.])x\.com|twitter/.test(probe)) return 'social';
  if (probe.includes('ycombinator') || /hacker ?news/.test(probe)) return 'hackernews';
  if (probe.includes('arxiv')) return 'research';
  if (probe.includes('reddit')) return 'reddit';
  return null;
}

// Source class for one item: the section key decides for real feed sections;
// curated sections ('signal' class) refine per item from its own provenance.
export function itemSourceClass(
  item: Pick<OpsIntelItem, 'url' | 'source'>,
  sectionKey: string
): IntelSourceClass {
  const base = sectionSourceClass(sectionKey);
  if (base !== 'signal') return base;
  return classFromItemProvenance(item) ?? 'signal';
}

// ── D6: standardized Send-to-King handoff brief ──────────────────────────────
// Built from REAL item fields only — missing fields drop their line rather
// than fabricating content. The Request line is the fixed King contract.
export function buildIntelHandoffBrief(
  item: Pick<OpsIntelItem, 'title' | 'summary' | 'url' | 'handle' | 'why' | 'move'>,
  sourceClass: IntelSourceClass
): string {
  const handle = item.handle?.trim();
  const lines = [
    'INTEL HANDOFF',
    `Title: ${item.title}`,
    `Source: ${SOURCE_CLASS_LABEL[sourceClass]}${handle ? ` · ${handle}` : ''}`,
  ];
  if (item.summary.trim()) lines.push(`Summary: ${item.summary.trim()}`);
  if (item.why?.trim()) lines.push(`Why: ${item.why.trim()}`);
  if (item.move?.trim()) lines.push(`Suggested move: ${item.move.trim()}`);
  if (item.url) lines.push(`Link: ${item.url}`);
  lines.push(
    'Request: assess usefulness against our projects/knowledge base; if useful, synthesize a task and dispatch a worker (claude or codex); if skill-worthy, draft the skill.'
  );
  return lines.join('\n');
}
