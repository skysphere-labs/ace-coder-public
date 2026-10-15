const ADJECTIVES = [
  'swift', 'silent', 'bright', 'clever', 'gentle', 'bold', 'quiet', 'warm',
  'nimble', 'crisp', 'amber', 'ember', 'lucid', 'mellow', 'fresh', 'neat',
  'rapid', 'keen', 'calm', 'snug',
];

const NOUNS = [
  'fox', 'otter', 'river', 'spark', 'grove', 'willow', 'harbor', 'hollow',
  'pine', 'maple', 'brook', 'cedar', 'orbit', 'drift', 'lattice', 'comet',
  'haven', 'rune', 'finch', 'cove',
];

function pick<T>(list: readonly T[]): T {
  return list[Math.floor(Math.random() * list.length)];
}

export function randomSlug(): string {
  return `${pick(ADJECTIVES)}-${pick(NOUNS)}`;
}

export function deriveFromPrompt(text: string, limit = 40): string | null {
  if (!text) return null;
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (!collapsed) return null;
  const stripped = collapsed.replace(/^[\s>*\-#•·]+/, '').trim();
  if (!stripped) return null;
  const capped =
    stripped.length <= limit ? stripped : stripped.slice(0, limit).trimEnd();
  const cleaned = capped.replace(/[\s.,;:!?]+$/, '');
  return cleaned.length > 0 ? cleaned : null;
}
