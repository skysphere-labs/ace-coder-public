import {
  getIconForDirectoryPath,
  getIconForFilePath,
  getIconUrlByName,
  type MaterialIcon,
} from 'vscode-material-icons';

// Build the icons base URL once, anchored to the document's actual
// baseURI. The previous "./material-icons" string relied on the browser
// resolving against the current URL, which behaves inconsistently across
// Electron's file:// context and dev/prod bases. Anchoring to baseURI
// guarantees the icons resolve regardless of navigation state.
function computeIconsBase(): string {
  try {
    // document.baseURI reflects the <base> tag or the URL the HTML was
    // loaded from. new URL('material-icons/', baseURI) collapses to the
    // correct absolute URL for both http (dev) and file:// (packaged).
    const base = new URL('material-icons/', document.baseURI);
    // Strip the trailing slash so getIconUrlByName's own concatenation
    // produces exactly one separator.
    return base.toString().replace(/\/$/, '');
  } catch {
    return './material-icons';
  }
}

const ICONS_URL = computeIconsBase();

function urlFor(name: MaterialIcon) {
  return getIconUrlByName(name, ICONS_URL);
}

export function FileIcon({
  path,
  className,
}: {
  path: string;
  className?: string;
}) {
  const iconName = getIconForFilePath(path);
  return (
    <img
      src={urlFor(iconName)}
      alt=""
      aria-hidden="true"
      draggable={false}
      className={className}
    />
  );
}

export function FolderIcon({
  path,
  open = false,
  className,
}: {
  path: string;
  open?: boolean;
  className?: string;
}) {
  const base = getIconForDirectoryPath(path);
  const iconName = (open ? `${base}-open` : base) as MaterialIcon;
  return (
    <img
      src={urlFor(iconName)}
      alt=""
      aria-hidden="true"
      draggable={false}
      className={className}
    />
  );
}
