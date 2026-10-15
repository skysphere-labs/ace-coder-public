export type TerminalDimensions = {
  cols: number;
  rows: number;
};

// Scrollback rows a client's xterm keeps — and the cap it asks the server to
// serialize into reattach snapshots (serializing more than the client will
// retain wastes main-thread serialize time, tunnel bytes, and phone parse
// time). Touch clients pay for scrollback in parse + memory on much weaker
// hardware; 1500 rows is still ~50 screens of history there.
export const TOUCH_TERMINAL_SCROLLBACK = 1500;
export const DESKTOP_TERMINAL_SCROLLBACK = 5000;

export function clientTerminalScrollback(): number {
  if (
    typeof document !== 'undefined' &&
    document.documentElement.classList.contains('ace-touch')
  ) {
    return TOUCH_TERMINAL_SCROLLBACK;
  }
  return DESKTOP_TERMINAL_SCROLLBACK;
}

const ESC = String.fromCharCode(27);
const BRACKETED_PASTE_START = `${ESC}[200~`;
const BRACKETED_PASTE_END = `${ESC}[201~`;
const INVALID_NUMBER_TEXT = /(?:NaN|Infinity)/i;
const GENERATED_TEXT_RUN = /(?:(?:aN|NaN);NaNM)+(?:aN?)?|(?:;NaNM)+(?:aN?)?/gi;

export function sanitizeTerminalDimensions(
  cols: unknown,
  rows: unknown,
  minCols = 1,
  minRows = 1
): TerminalDimensions | null {
  const c = Number(cols);
  const r = Number(rows);
  if (!Number.isFinite(c) || !Number.isFinite(r)) return null;
  const normalized = { cols: Math.trunc(c), rows: Math.trunc(r) };
  if (normalized.cols < minCols || normalized.rows < minRows) return null;
  return normalized;
}

function stripInvalidCsiNumbers(text: string): string {
  let output = '';
  let index = 0;
  while (index < text.length) {
    const start = text.indexOf(`${ESC}[`, index);
    if (start < 0) return output + text.slice(index);
    output += text.slice(index, start);

    let end = start + 2;
    while (end < text.length) {
      const code = text.charCodeAt(end);
      if (code >= 0x40 && code <= 0x7e) {
        if (startsInvalidNumber(text, end)) {
          index = invalidCsiEnd(text, end);
          break;
        }
        const sequence = text.slice(start, end + 1);
        if (!INVALID_NUMBER_TEXT.test(sequence)) output += sequence;
        index = end + 1;
        break;
      }
      end += 1;
    }

    if (end >= text.length) {
      const sequence = text.slice(start);
      return INVALID_NUMBER_TEXT.test(sequence) ? output : output + sequence;
    }
  }
  return output;
}

function startsInvalidNumber(text: string, index: number): boolean {
  const lower = text.slice(index, index + 8).toLowerCase();
  return lower.startsWith('nan') || lower.startsWith('infinity');
}

function invalidCsiEnd(text: string, invalidIndex: number): number {
  const nextEscape = text.indexOf(ESC, invalidIndex + 1);
  const limit = nextEscape >= 0 ? nextEscape : text.length;
  const mouseEnd = text.indexOf('M', invalidIndex);
  return mouseEnd >= 0 && mouseEnd < limit ? mouseEnd + 1 : limit;
}

function stripGeneratedTerminalFragments(text: string): string {
  return text.replace(GENERATED_TEXT_RUN, '');
}

function hasMeaningfulInput(text: string): boolean {
  return text
    .replaceAll(BRACKETED_PASTE_START, '')
    .replaceAll(BRACKETED_PASTE_END, '')
    .length > 0;
}

export function isGeneratedTerminalGarbage(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0 && stripGeneratedTerminalFragments(trimmed).trim().length === 0;
}

export function sanitizeTerminalInputPayload(data: string): string | null {
  const stripped = stripGeneratedTerminalFragments(stripInvalidCsiNumbers(data));
  if (!stripped || !hasMeaningfulInput(stripped) || isGeneratedTerminalGarbage(stripped)) return null;
  return stripped;
}

export function sanitizeComposerDraftText(text: string): string {
  const stripped = stripGeneratedTerminalFragments(stripInvalidCsiNumbers(text));
  return isGeneratedTerminalGarbage(stripped) ? '' : stripped;
}
