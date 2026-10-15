// Fixed CLI sizing for phones. A phone viewport changes width constantly
// (keyboard, URL bar, rotation) and every width change used to reflow the
// PTY horizontally, shredding full-screen TUIs like Claude Code mid-paint.
// Instead of fitting columns to the container, mobile pins the column count
// and fits the FONT SIZE to the width: the terminal app sees one stable
// geometry and never reflows. 50 columns trades line width for legibility —
// a portrait iPhone lands at ~13px instead of the unreadable 8px that the
// original 80-column "desktop view" produced, and Claude Code/Codex TUIs
// render fine at this width.
export const MOBILE_TERMINAL_COLS = 50;

// Floor keeps degenerate widths from going microscopic; ceiling matches the
// desktop terminal default so wide/landscape phones never exceed it.
export const MOBILE_TERMINAL_MIN_FONT = 8;
export const MOBILE_TERMINAL_MAX_FONT = 13;

/**
 * Largest integer font size whose MOBILE_TERMINAL_COLS-wide line fits the
 * container. `charWidthPerFontPx` is the measured monospace advance width of
 * one cell per 1px of font size (≈0.6 for Menlo); monospace metrics scale
 * linearly so one reference measurement covers every candidate size.
 */
export function mobileTerminalFontSize(
  containerWidth: number,
  charWidthPerFontPx: number
): number {
  if (
    !Number.isFinite(containerWidth) ||
    !Number.isFinite(charWidthPerFontPx) ||
    containerWidth <= 0 ||
    charWidthPerFontPx <= 0
  ) {
    return MOBILE_TERMINAL_MIN_FONT;
  }
  const fit = Math.floor(containerWidth / (MOBILE_TERMINAL_COLS * charWidthPerFontPx));
  return Math.max(MOBILE_TERMINAL_MIN_FONT, Math.min(MOBILE_TERMINAL_MAX_FONT, fit));
}
