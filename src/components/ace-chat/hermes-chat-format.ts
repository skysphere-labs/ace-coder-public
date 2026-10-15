export type HermesToolMarker = {
  count: number;
  toolName: string;
};

const TOOL_MARKER_PATTERN = /\[(\d+)\s+tool calls?:\s*([^\]]+)\]/gi;
const TRAILING_PARTIAL_TOOL_MARKER_PATTERN = /\s*\[\d+\s+tool calls?:[^\]]*$/i;

export function extractHermesToolMarkers(text: string): {
  text: string;
  tools: HermesToolMarker[];
} {
  const tools: HermesToolMarker[] = [];
  const cleaned = String(text || '')
    .replace(TOOL_MARKER_PATTERN, (_match, count: string, toolName: string) => {
      tools.push({
        count: Number(count) || 1,
        toolName: String(toolName || 'tool').trim() || 'tool',
      });
      return ' ';
    })
    .replace(TRAILING_PARTIAL_TOOL_MARKER_PATTERN, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([,.!?;:])/g, '$1')
    .trim();

  return { text: cleaned, tools };
}

export function formatHermesReadableText(text: string): string {
  const cleaned = extractHermesToolMarkers(text).text;
  if (!cleaned) return '';
  if (hasMarkdownStructure(cleaned)) return cleaned;

  const parts = cleaned.split(/\s+-\s+/).map((part) => part.trim()).filter(Boolean);
  if (parts.length < 3) return cleaned;

  const [intro, ...bullets] = parts;
  return [
    intro,
    '',
    ...bullets.map((bullet) => `- ${formatBulletLabel(bullet)}`),
  ].join('\n');
}

function hasMarkdownStructure(text: string): boolean {
  return /(^|\n)\s*(?:[-*]\s+|\d+\.\s+|#{1,6}\s+|```)/.test(text);
}

function formatBulletLabel(text: string): string {
  const match = /^([^:]{2,56}):\s+(.+)$/.exec(text);
  if (!match) return text;
  const label = match[1].trim();
  const body = match[2].trim();
  if (!label || !body || /[`*_]/.test(label)) return text;
  return `**${label}:** ${body}`;
}
