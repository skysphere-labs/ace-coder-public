export function isUndoShortcut(e: KeyboardEvent): boolean {
  const mod = e.metaKey || e.ctrlKey;
  if (!mod || e.altKey) return false;
  return e.key.toLowerCase() === 'z' && !e.shiftKey;
}

export function isRedoShortcut(e: KeyboardEvent): boolean {
  const mod = e.metaKey || e.ctrlKey;
  if (!mod || e.altKey) return false;
  const key = e.key.toLowerCase();
  return (key === 'z' && e.shiftKey) || key === 'y';
}

export function isTextEditingSurface(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'INPUT') return true;
  if ((el as HTMLElement).isContentEditable) return true;
  if (el.closest('.monaco-editor')) return true;
  if (el.closest('.xterm')) return true;
  return false;
}
