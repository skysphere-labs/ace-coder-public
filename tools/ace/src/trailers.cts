// Trailer parser — see the ace-github-flow skill (DONE/BLOCKED) and
// §3 (VERDICT). Pure, sync, no I/O.
//
// A delegated worker ends every turn with one of three trailers:
//   DONE: <one-line summary>           — task complete
//   BLOCKED: <one-line reason>         — cannot proceed
//   VERDICT: <one-line verdict>        — review outcome (review/PR-check role)
//
// parseTrailers returns whichever trailers appear, preserving the raw text.
// If the same trailer appears more than once, the LAST occurrence wins —
// agents often narrate ("I was BLOCKED earlier… DONE: fixed it").

// Accept bullet/markdown-bold-decorated trailers anywhere in the body and
// also strict line-anchored trailers. Workers sometimes emit
// `• BLOCKED: reason`, `- **BLOCKED:** reason`, or `**DONE:** summary` instead
// of a bare keyword; the markdown bold can wrap the keyword with or without
// the colon inside the asterisks. Leading whitespace is tolerated.
const TRAILER_RX = /(?:^|\n)[ \t]*(?:[•·⏺*\-]\s+)?(?:\*\*)?(DONE|BLOCKED|VERDICT)(?:\*\*)?\s*:\s*(?:\*\*)?\s*([^\n]*?)\s*(?=\n|$)/gi;
const TRAILER_LINE_RX = /^\s*(?:[•·⏺*\-]\s+)?(?:\*\*)?(DONE|BLOCKED|VERDICT)(?:\*\*)?\s*:\s*(?:\*\*)?\s*([^\n]*?)\s*$/i;

function isTrailerTailNoise(line: any) {
  const trimmed = String(line || '').trim();
  return (
    !trimmed ||
    /^>\s*$/.test(trimmed) ||
    /^❯\s*$/.test(trimmed) ||
    /^[>❯]\s+\S/.test(trimmed) ||
    /^[─━-]+$/.test(trimmed) ||
    /^─+\s*Worked for\b/i.test(trimmed) ||
    /^✻\s+\S/.test(trimmed) ||
    /^⏵+/.test(trimmed) ||
    /^›/.test(trimmed) ||
    /^Use \/skills\b/i.test(trimmed) ||
    /^Goal (?:blocked|completed|paused)\b/i.test(trimmed) ||
    /^gpt-[\w.-]+(?:\s+\w+)*\s+·\s+/i.test(trimmed) ||
    /^tokens used:\s*\d+(?:\b.*)?$/i.test(trimmed)
  );
}

function isCommandRegistryTrailer(detail: any) {
  const text = String(detail || '');
  return /"?ipcMethod"?\s*:/.test(text) || /"?flags"?\s*:/.test(text) || /\bspecial:missionSync\b/.test(text);
}

// ANSI/control stripping for the RAW pty byte ring. TUI renderers (claude
// code) repaint the screen with cursor addressing, so a worker's DONE line
// survives only in the raw output bytes — never reliably in the rendered
// scrollback. Bare \r is a line REWRITE, so it becomes a line boundary.
// Every alternative is linear (no lazy any-char scans). An UNTERMINATED
// OSC/DCS/PM/APC deliberately fails its alternative and falls through to the
// bare 2-char ESC rule: only the lead strips and the payload stays as inert
// text, so a truncated sequence can never swallow a trailing DONE line.
const ANSI_RX = new RegExp(
  [
    '\\u001B\\][^\\u0007\\u001B]*(?:\\u0007|\\u001B\\\\)', // OSC … BEL|ST
    '\\u001B[P^_][^\\u001B]*\\u001B\\\\', // DCS/PM/APC … ST
    '\\u001B\\[[0-9;:?<=>]*[ -/]*[@-~]', // CSI
    '\\u001B[@-Z\\\\-_]', // bare 2-char ESC sequences
    '[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001A\\u001C-\\u001F\\u007F]', // other C0 + DEL
  ].join('|'),
  'g'
);

function stripAnsi(text: any) {
  return String(text || '')
    .replace(ANSI_RX, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
}

// STRUCTURAL TUI chrome that repaints after a worker's final trailer: box
// frames, EMPTY composer rows, spinner/status/footer lines. Deliberately
// narrow — a box row carrying content or a ⎿ tool-result line is SUBSTANTIVE
// output and must keep refusing a tail-anchored trailer above it.
function isTuiChromeNoise(line: any) {
  const trimmed = String(line || '').trim();
  return (
    !trimmed ||
    /^[╭╰├┬┴┼╮╯┤┌└┐┘][╌╍┄┅┈┉═━─\s]*[╮╯┤┐┘╭╰├]?$/.test(trimmed) ||
    /^[│┃]\s*(?:[>❯]\s*)?▌?\s*[│┃]?$/.test(trimmed) ||
    /^[╌╍┄┅┈┉═━]+$/.test(trimmed) ||
    /^\[Pasted text #?\d[^\]]*\]$/i.test(trimmed) ||
    /^\? for shortcuts$/i.test(trimmed) ||
    /^[✻✽✶✳✢∗]\s+\S+(?:…|\.\.\.)/.test(trimmed) ||
    /^[✻✽✶✳✢∗]\s+\w+\s+for\s+\d+[smh]/i.test(trimmed) ||
    /^⏵+\s/.test(trimmed) ||
    /^\S+\s+·\s+\d+(?:\.\d+)?k?\s+tokens\b/i.test(trimmed) ||
    /^\d+(?:\.\d+)?k?\s+tokens\b/i.test(trimmed)
  );
}

function isHardWrappedTrailerContinuation(line: any, previousLine: any) {
  const raw = String(line || '');
  const trimmed = raw.trim();
  if (!trimmed) return false;
  if (/^\s+\S/.test(raw)) return true;
  if (String(previousLine || '').length < 72) return false;
  if (isTrailerTailNoise(raw) || TRAILER_LINE_RX.test(raw)) return false;
  if (/^(?:[#>`]|[•·⏺*\-]\s+)/.test(trimmed)) return false;
  if (/^[A-Z][a-z]+(?:\s|$)/.test(trimmed)) return false;
  return true;
}

function parseTrailers(text: any) {
  const raw = typeof text === 'string' ? text : '';
  const out = { raw };
  if (!raw) return out;

  let match;
  TRAILER_RX.lastIndex = 0;
  while ((match = TRAILER_RX.exec(raw)) !== null) {
    const kind = match[1].toLowerCase();
    const detail = (match[2] || '').trim();
    if (isCommandRegistryTrailer(detail)) continue;
    out[kind] = detail || null;
  }
  return out;
}

function listTrailers(text: any) {
  const raw = typeof text === 'string' ? text : '';
  const out: any[] = [];
  if (!raw) return out;

  let match;
  TRAILER_RX.lastIndex = 0;
  while ((match = TRAILER_RX.exec(raw)) !== null) {
    const detail = String(match[2] || '').trim();
    if (isCommandRegistryTrailer(detail)) continue;
    out.push({
      kind: String(match[1] || '').toLowerCase(),
      detail: detail || null,
    });
  }
  return out;
}

function listTerminalTrailers(text: any) {
  const raw = typeof text === 'string' ? text : '';
  if (!raw) return [];
  return terminalTrailersFromLines(raw.split(/\r?\n/));
}

// Loose variant for the RAW pty byte ring: strip ANSI, drop TUI chrome lines
// (a repaint interleaves chrome between the trailer and its continuations),
// then apply the SAME tail-anchored algorithm — substantive output after the
// trailer still refuses the parse.
function listTerminalTrailersLoose(text: any) {
  return listTerminalTrailersLooseStripped(stripAnsi(text));
}

// Same, for input that is ALREADY ANSI-stripped (avoids a second 64 KiB pass
// on the screen-reader's cached stripped ring).
function listTerminalTrailersLooseStripped(stripped: any) {
  const s = typeof stripped === 'string' ? stripped : '';
  if (!s) return [];
  // Cover the ENTIRE 64 KiB pty ring (stripped ≤ raw): a trailer buried under
  // hours of idle chrome repaints must still be observable.
  const capped = s.length > 65536 ? s.slice(-65536) : s;
  const kept = capped.split('\n').filter((line: any) => !isTuiChromeNoise(line));
  return terminalTrailersFromLines(kept);
}

function terminalTrailersFromLines(lines: any[]) {
  let end = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!isTrailerTailNoise(lines[i])) {
      end = i;
      break;
    }
  }
  if (end < 0) return [];

  for (let i = end; i >= 0; i -= 1) {
    const match = TRAILER_LINE_RX.exec(lines[i]);
    if (!match) continue;

    const continuation = lines.slice(i + 1, end + 1).filter((line: any) => String(line || '').trim());
    let previousLine = lines[i];
    for (const line of continuation) {
      if (!isHardWrappedTrailerContinuation(line, previousLine)) return [];
      previousLine = line;
    }
    const detail = [match[2] || '', ...continuation.map((line: any) => String(line).trim())]
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (isCommandRegistryTrailer(detail)) return [];
    return [{
      kind: String(match[1] || '').toLowerCase(),
      detail: detail || null,
    }];
  }

  return [];
}

function hasTerminalTrailer(text: any) {
  return listTerminalTrailers(text).length > 0;
}

module.exports = {
  parseTrailers,
  listTrailers,
  listTerminalTrailers,
  listTerminalTrailersLoose,
  listTerminalTrailersLooseStripped,
  hasTerminalTrailer,
  stripAnsi,
};
