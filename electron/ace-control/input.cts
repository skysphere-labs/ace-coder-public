const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
const ESC = String.fromCharCode(27);
const INVALID_NUMBER_TEXT = /(?:NaN|Infinity)/i;
const GENERATED_TEXT_RUN = /(?:(?:aN|NaN);NaNM)+(?:aN?)?|(?:;NaNM)+(?:aN?)?/gi;

const KEY_MAP: any = {
  enter: '\r',
  return: '\r',
  'shift+enter': '\x1b\r',
  esc: '\x1b',
  escape: '\x1b',
  tab: '\t',
  'shift+tab': '\x1b[Z',
  backspace: '\x7f',
  delete: '\x1b[3~',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  home: '\x1b[H',
  end: '\x1b[F',
  pageup: '\x1b[5~',
  pagedown: '\x1b[6~',
  'ctrl+a': '\x01',
  'ctrl+b': '\x02',
  'ctrl+c': '\x03',
  'ctrl+d': '\x04',
  'ctrl+e': '\x05',
  'ctrl+f': '\x06',
  'ctrl+g': '\x07',
  'ctrl+k': '\x0b',
  'ctrl+l': '\x0c',
  'ctrl+n': '\x0e',
  'ctrl+p': '\x10',
  'ctrl+r': '\x12',
  'ctrl+u': '\x15',
  'ctrl+w': '\x17',
  'ctrl+z': '\x1a',
  'ctrl+\\': '\x1c',
  space: ' ',
};

function resolveKey(name: any) {
  const key = String(name || '').toLowerCase().trim();
  const bytes = KEY_MAP[key];
  if (!bytes) throw new Error(`Unknown key: ${name}`);
  return bytes;
}

function wrapBracketed(text: any) {
  return `${PASTE_START}${text}${PASTE_END}`;
}

function stripInvalidCsiNumbers(text: any) {
  const value = String(text);
  let output = '';
  let index = 0;
  while (index < value.length) {
    const start = value.indexOf(`${ESC}[`, index);
    if (start < 0) return output + value.slice(index);
    output += value.slice(index, start);

    let end = start + 2;
    while (end < value.length) {
      const code = value.charCodeAt(end);
      if (code >= 0x40 && code <= 0x7e) {
        if (startsInvalidNumber(value, end)) {
          index = invalidCsiEnd(value, end);
          break;
        }
        const sequence = value.slice(start, end + 1);
        if (!INVALID_NUMBER_TEXT.test(sequence)) output += sequence;
        index = end + 1;
        break;
      }
      end += 1;
    }

    if (end >= value.length) {
      const sequence = value.slice(start);
      return INVALID_NUMBER_TEXT.test(sequence) ? output : output + sequence;
    }
  }
  return output;
}

function startsInvalidNumber(text: any, index: any) {
  const lower = String(text).slice(index, index + 8).toLowerCase();
  return lower.startsWith('nan') || lower.startsWith('infinity');
}

function invalidCsiEnd(text: any, invalidIndex: any) {
  const value = String(text);
  const nextEscape = value.indexOf(ESC, invalidIndex + 1);
  const limit = nextEscape >= 0 ? nextEscape : value.length;
  const mouseEnd = value.indexOf('M', invalidIndex);
  return mouseEnd >= 0 && mouseEnd < limit ? mouseEnd + 1 : limit;
}

function sanitizeTerminalInputPayload(text: any) {
  const stripped = stripInvalidCsiNumbers(text).replace(GENERATED_TEXT_RUN, '');
  const meaningful = stripped.replaceAll(PASTE_START, '').replaceAll(PASTE_END, '');
  return meaningful.length > 0 ? stripped : null;
}

function createInput({ writeTerminalInput, profileFor }: any) {
  async function keys(streamId: any, name: any, opts: any = {}) {
    const repeat = Math.max(1, Math.min(16, opts.repeat | 0 || 1));
    const bytes = resolveKey(name);
    for (let i = 0; i < repeat; i++) {
      await writeTerminalInput(streamId, bytes);
      if (i < repeat - 1 && opts.gapMs) {
        await new Promise((r) => setTimeout(r, opts.gapMs));
      }
    }
    return { ok: true };
  }

  async function type(streamId: any, text: any) {
    if (!text) return { ok: true };
    const safe = sanitizeTerminalInputPayload(text);
    if (safe === null) return { ok: false };
    await writeTerminalInput(streamId, safe);
    return { ok: true };
  }

  async function paste(streamId: any, text: any) {
    if (!text) return { ok: true };
    const safe = sanitizeTerminalInputPayload(text);
    if (safe === null) return { ok: false };
    await writeTerminalInput(streamId, wrapBracketed(safe));
    return { ok: true };
  }

  async function submit(streamId: any) {
    const profile = profileFor(streamId);
    const key = profile?.submit || 'enter';
    await writeTerminalInput(streamId, resolveKey(key));
    return { ok: true };
  }

  async function abort(streamId: any) {
    const profile = profileFor(streamId);
    const spec = profile?.abort;
    const key = typeof spec === 'string' ? spec : spec?.key || 'ctrl+c';
    const repeat = typeof spec === 'object' && spec ? Math.max(1, spec.repeat | 0 || 1) : 1;
    // Small gap between repeats gives the Ace time to process the first
    // signal — Claude Code specifically requires two distinct ctrl+c events
    // to abort, not a single burst.
    return keys(streamId, key, { repeat, gapMs: repeat > 1 ? 80 : 0 });
  }

  return { keys, type, paste, submit, abort };
}

module.exports = {
  createInput,
  resolveKey,
  wrapBracketed,
  sanitizeTerminalInputPayload,
  PASTE_START,
  PASTE_END,
  KEY_MAP,
};
