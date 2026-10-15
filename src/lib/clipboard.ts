export async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall back below.
  }
  return writeClipboardViaSelection(text);
}

export function dataTransferHasType(
  data: DataTransfer | null | undefined,
  type: string
): boolean {
  const types = data?.types;
  if (!types) return false;
  const maybeList = types as DataTransfer['types'] & {
    includes?: (value: string) => boolean;
    contains?: (value: string) => boolean;
  };
  if (typeof maybeList.includes === 'function') return maybeList.includes(type);
  if (typeof maybeList.contains === 'function') return maybeList.contains(type);
  return Array.from(types).includes(type);
}

export function filesFromClipboard(data: DataTransfer | null | undefined): File[] {
  if (!data) return [];
  const files: File[] = [];
  for (const item of Array.from(data.items || [])) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  return files.length > 0 ? files : Array.from(data.files || []);
}

export function pathsFromDataTransfer(data: DataTransfer): string[] {
  const raw = data.getData('application/x-ace-paths');
  if (raw) {
    try {
      const paths = JSON.parse(raw) as unknown;
      if (Array.isArray(paths)) {
        return paths.filter(
          (p): p is string => typeof p === 'string' && p.trim().length > 0
        );
      }
    } catch {
      // Fall through to dropped files.
    }
  }
  return filesFromClipboard(data).map(resolveLocalFilePath).filter(Boolean);
}

export function resolveLocalFilePath(file: File): string {
  if (typeof window === 'undefined') return '';
  try {
    const fromBridge = window.aceDesktop?.getFilePath?.(file);
    if (fromBridge) return fromBridge;
  } catch {
    // Fall through to Electron's legacy File.path if present.
  }
  const legacy = (file as File & { path?: string }).path;
  return typeof legacy === 'string' ? legacy : '';
}

function writeClipboardViaSelection(text: string): boolean {
  if (typeof document === 'undefined') return false;
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  document.body.removeChild(ta);
  return ok;
}
