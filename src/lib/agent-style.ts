function isGlassShell(): boolean {
  if (typeof document === 'undefined') return true;
  return document.documentElement.classList.contains('shell-style-glass');
}

// Touch/remote client detection. Mirrors main.tsx's shell-class logic and
// ace-api's isRemoteClient (`!window.aceDesktop`), duplicated here so this
// styling module stays import-free (it's pulled into the eager boot graph).
export function isTouchOrRemoteClient(): boolean {
  if (typeof window === 'undefined') return false;
  if (!(window as { aceDesktop?: unknown }).aceDesktop) return true;
  if (typeof navigator !== 'undefined') {
    if (/iPad|iPhone|iPod|Android|Mobi/i.test(navigator.userAgent)) return true;
  }
  return false;
}

// The desktop terminal canvas color. Solid and deliberately NOT black: a
// warm charcoal from the --ace-surface family (hsl 32 9% 12%). The WebGL
// renderer needs an opaque background — the old glass rgba(0,0,0,0) theme
// rendered as flat black there — and an opaque paint also covers any stale
// DOM-renderer rows a renderer swap leaves behind (seen as doubled lines).
// Keep in sync with the .terminal-surface rule in index.css.
export const TERMINAL_BG = '#211f1c';

// The touch/remote (phone PWA) terminal canvas. Also deliberately NOT black:
// an indigo-cast graphite one step up from the Indigo Ledger ground, so the
// CLI reads as a designed instrument panel instead of a black rectangle
// floating on the theme. Keep in sync with --m-terminal in index.css (the
// .terminal-surface frame must be the exact same color or the padding reads
// as a border).
export const TOUCH_TERMINAL_BG = '#171a24';

export function getTerminalBackground(): string {
  return isTouchOrRemoteClient() ? TOUCH_TERMINAL_BG : TERMINAL_BG;
}

export function getTabBackground(): string {
  if (isGlassShell()) return 'hsl(0 0% 100% / 0.07)';
  return getTerminalBackground();
}

export function getTerminalThemeOverride() {
  const bg = getTerminalBackground();
  return {
    background: bg,
    // Agent CLIs paint their whole screen truecolor-black; the PTY mirror
    // rewrites that to palette black (see pty-stream-states.cts). Mapping
    // palette black onto the surface color keeps those screens reading as
    // the surface instead of a black rectangle inside a matching frame.
    black: bg,
    selectionBackground: 'rgba(96, 165, 250, 0.35)',
    selectionForeground: '#f9fafb',
    cursorAccent: bg,
  };
}

export function getAgentAccentColor(agent: string): string {
  switch (agent) {
    case 'claude':   return '#d97706';
    case 'codex':    return '#10b981';
    case 'cursor':   return '#8b5cf6';
    case 'gemini':   return '#3b82f6';
    case 'qwen':     return '#9333ea';
    case 'droid':    return '#06b6d4';
    case 'amp':      return '#f97316';
    case 'opencode': return '#14b8a6';
    case 'hermes':   return '#0ea5e9';
    case 'copilot':  return '#6366f1';
    case 'charm':    return '#ec4899';
    case 'auggie':   return '#84cc16';
    case 'goose':    return '#22c55e';
    case 'kimi':     return '#f472b6';
    case 'kilocode': return '#fb923c';
    case 'kiro':     return '#f59e0b';
    case 'rovo':     return '#0052cc';
    case 'cline':    return '#818cf8';
    case 'continue': return '#64748b';
    case 'codebuff': return '#a855f7';
    case 'mistral':  return '#ff7000';
    case 'pi':       return '#059669';
    case 'autohand': return '#d946ef';
    case 'forge':    return '#ef4444';
    default:         return '#6b7280';
  }
}

export const agentMeta: Record<string, { label: string }> = {
  claude:   { label: 'Claude Code' },
  codex:    { label: 'Codex' },
  cursor:   { label: 'Cursor' },
  gemini:   { label: 'Gemini' },
  qwen:     { label: 'Qwen Code' },
  droid:    { label: 'Droid' },
  amp:      { label: 'Amp' },
  opencode: { label: 'OpenCode' },
  hermes:   { label: 'Hermes Agent' },
  copilot:  { label: 'GitHub Copilot' },
  charm:    { label: 'Charm' },
  auggie:   { label: 'Auggie' },
  goose:    { label: 'Goose' },
  kimi:     { label: 'Kimi' },
  kilocode: { label: 'Kilocode' },
  kiro:     { label: 'Kiro' },
  rovo:     { label: 'Rovo Dev' },
  cline:    { label: 'Cline' },
  continue: { label: 'Continue' },
  codebuff: { label: 'Codebuff' },
  mistral:  { label: 'Mistral Vibe' },
  pi:       { label: 'Pi' },
  autohand: { label: 'Autohand Code' },
  forge:    { label: 'Forge' },
};

