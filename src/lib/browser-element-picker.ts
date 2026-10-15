// Element picker for the in-app browser. The picker runs *inside* the
// webview's page context (not in Ace's renderer), injected via
// `webview.executeJavaScript`. The host awaits the returned Promise, which
// resolves with the picked element or null on cancel.

export type PickedElement = {
  tag: string;
  id: string | null;
  classes: string[];
  text: string;
  ariaLabel: string | null;
  role: string | null;
  href: string | null;
  name: string | null;
  placeholder: string | null;
  title: string | null;
  type: string | null;
  value: string | null;
  selector: string;
  xpath: string;
  outerHTML: string;
  bbox: { x: number; y: number; w: number; h: number };
  url: string;
  pageTitle: string;
  // Nearest semantic ancestor (header/main/footer/nav/etc.) or ARIA landmark role.
  landmark: string | null;
  // Where this sits vertically in the document: top / mid / bot third.
  pos: 'top' | 'mid' | 'bot';
  // Document-relative center point as percentages. This survives scroll state
  // and makes "bottom GitHub" vs "hero GitHub" obvious.
  pagePos: { x: number; y: number };
  context: string | null;
  // How many same-tag elements on the page share this visible text. >1 signals
  // ambiguity to the agent (e.g. two GitHub buttons: header and footer).
  textCount: number;
  textIndex: number;
};

// Function is stringified into `executeJavaScript`; keep it self-contained
// (no outside references, no TS-only syntax). Types are erased at runtime.
function pickerFn(): Promise<unknown> {
  return new Promise((resolve) => {
    const w = window as unknown as Record<string, unknown>;
    if (w.__acePickerActive) {
      resolve(null);
      return;
    }
    w.__acePickerActive = true;

    const overlay = document.createElement('div');
    overlay.style.cssText = [
      'position:fixed',
      'pointer-events:none',
      'z-index:2147483647',
      'border:2px solid #60a5fa',
      'background:rgba(96,165,250,0.15)',
      'border-radius:2px',
      'box-sizing:border-box',
      'transition:all 60ms ease-out',
      'top:-9999px',
      'left:-9999px',
      'width:0',
      'height:0',
    ].join(';');
    document.documentElement.appendChild(overlay);

    const tag = document.createElement('div');
    tag.style.cssText = [
      'position:fixed',
      'pointer-events:none',
      'z-index:2147483647',
      'font:500 11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace',
      'padding:3px 6px',
      'background:#60a5fa',
      'color:white',
      'border-radius:3px',
      'white-space:nowrap',
      'box-shadow:0 2px 8px rgba(0,0,0,0.3)',
      'top:-9999px',
      'left:-9999px',
    ].join(';');
    document.documentElement.appendChild(tag);

    const prevCursor = document.documentElement.style.cursor;
    document.documentElement.style.cursor = 'crosshair';

    let current: Element | null = null;

    const CSSAny = (typeof CSS !== 'undefined' ? (CSS as unknown as { escape?: (s: string) => string }) : null);
    const esc = (s: string): string =>
      CSSAny && typeof CSSAny.escape === 'function'
        ? CSSAny.escape(s)
        : s.replace(/[^\w-]/g, '\\$&');
    const escAttr = (s: string): string => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

    function classList(el: Element): string[] {
      const cn = (el as HTMLElement).className;
      if (typeof cn !== 'string') return [];
      return cn.trim().split(/\s+/).filter(Boolean);
    }

    const STRONG_ROOTS: Record<string, true> = {
      HEADER: true,
      MAIN: true,
      FOOTER: true,
      NAV: true,
      ASIDE: true,
      FORM: true,
      DIALOG: true,
    };
    const WEAK_ROOTS: Record<string, true> = {
      ARTICLE: true,
      SECTION: true,
    };
    const LANDMARK_ROLES: Record<string, true> = {
      banner: true,
      navigation: true,
      main: true,
      contentinfo: true,
      complementary: true,
      search: true,
    };

    function isStrongAnchor(el: Element): boolean {
      const role = el.getAttribute('role');
      return STRONG_ROOTS[el.tagName] || !!(role && LANDMARK_ROLES[role]);
    }

    function uniqueAttrSelector(el: Element): string | null {
      const attrs = ['data-testid', 'data-test', 'data-cy', 'name', 'aria-label', 'title'];
      for (let i = 0; i < attrs.length; i++) {
        const attr = attrs[i];
        const value = el.getAttribute(attr);
        if (!value) continue;
        const selector = el.tagName.toLowerCase() + '[' + attr + '="' + escAttr(value) + '"]';
        try {
          if (document.querySelectorAll(selector).length === 1) return selector;
        } catch {
          // Ignore malformed third-party attribute values and keep building an
          // nth-child path.
        }
      }
      return null;
    }

    // Positional selector anchored at a durable root: id first, then strong
    // page landmarks (footer/main/nav/...), otherwise body. Generic sections
    // are kept in the path but do not stop the selector because many pages have
    // several visually unrelated <section>s with the same child shape.
    function makeSelector(start: Element): string {
      const startId = (start as HTMLElement).id;
      if (startId) return '#' + esc(startId);
      const startAttr = uniqueAttrSelector(start);
      if (startAttr) return startAttr;

      const parts: string[] = [];
      let node: Element | null = start;
      while (node && node.nodeType === 1 && node !== document.documentElement) {
        if (node !== start) {
          const nid = (node as HTMLElement).id;
          if (nid) {
            parts.unshift('#' + esc(nid));
            break;
          }
          const attrSelector = uniqueAttrSelector(node);
          if (attrSelector) {
            parts.unshift(attrSelector);
            break;
          }
          if (isStrongAnchor(node) || node.tagName === 'BODY') {
            parts.unshift(node.tagName.toLowerCase());
            break;
          }
        }
        const parent = node.parentElement;
        let part = node.tagName.toLowerCase();
        if (parent) {
          const siblings = Array.prototype.slice.call(parent.children) as Element[];
          if (siblings.length > 1) {
            part += ':nth-child(' + (siblings.indexOf(node) + 1) + ')';
          }
        }
        parts.unshift(part);
        node = parent;
      }
      return parts.join(' > ');
    }

    function findLandmark(el: Element): string | null {
      let weak: string | null = null;
      let node: Element | null = el.parentElement;
      while (node && node !== document.documentElement) {
        const role = node.getAttribute('role');
        if (role && LANDMARK_ROLES[role]) return role;
        if (STRONG_ROOTS[node.tagName]) return node.tagName.toLowerCase();
        if (!weak && WEAK_ROOTS[node.tagName]) weak = node.tagName.toLowerCase();
        node = node.parentElement;
      }
      return weak;
    }

    function posBand(r: DOMRect): 'top' | 'mid' | 'bot' {
      const docY = r.top + window.scrollY;
      const docH = Math.max(document.documentElement.scrollHeight, 1);
      const relY = docY / docH;
      if (relY < 0.33) return 'top';
      if (relY < 0.66) return 'mid';
      return 'bot';
    }

    function pagePos(r: DOMRect): { x: number; y: number } {
      const docW = Math.max(document.documentElement.scrollWidth, window.innerWidth, 1);
      const docH = Math.max(document.documentElement.scrollHeight, 1);
      const centerX = r.left + window.scrollX + r.width / 2;
      const centerY = r.top + window.scrollY + r.height / 2;
      return {
        x: Math.max(0, Math.min(100, Math.round((centerX / docW) * 100))),
        y: Math.max(0, Math.min(100, Math.round((centerY / docH) * 100))),
      };
    }

    function sameTextStats(el: Element, text: string): { count: number; index: number } {
      if (!text || text.length > 200) return { count: 0, index: 0 };
      const target = text.trim();
      if (!target) return { count: 0, index: 0 };
      let count = 0;
      let index = 0;
      const candidates = document.getElementsByTagName(el.tagName);
      for (let i = 0; i < candidates.length; i++) {
        const other = candidates[i] as HTMLElement;
        const t = (other.innerText || other.textContent || '').replace(/\s+/g, ' ').trim();
        if (t === target) {
          count++;
          if (other === el) index = count;
          if (count > 20) break;
        }
      }
      return { count, index };
    }

    function nearestContext(el: Element): string | null {
      const selector = 'h1,h2,h3,h4,h5,h6,legend,caption,[aria-label],[data-testid],[data-test],[data-cy]';
      let node: Element | null = el.parentElement;
      while (node && node !== document.body && node !== document.documentElement) {
        const label =
          node.getAttribute('aria-label') ||
          node.getAttribute('data-testid') ||
          node.getAttribute('data-test') ||
          node.getAttribute('data-cy');
        if (label) return trim(label, 80);

        const heading = node.querySelector(selector);
        if (heading && heading !== el && !el.contains(heading)) {
          const headingText =
            heading.getAttribute('aria-label') ||
            heading.getAttribute('data-testid') ||
            (heading as HTMLElement).innerText ||
            heading.textContent;
          const context = trim(headingText, 80);
          if (context) return context;
        }

        if (isStrongAnchor(node) || WEAK_ROOTS[node.tagName]) {
          const ownText = trim((node as HTMLElement).innerText || node.textContent, 120);
          const elText = trim((el as HTMLElement).innerText || el.textContent, 120);
          if (ownText && ownText !== elText) return ownText;
        }

        node = node.parentElement;
      }
      return null;
    }

    function getXPath(start: Element): string {
      const id = (start as HTMLElement).id;
      if (id) return '//*[@id="' + id + '"]';
      const parts: string[] = [];
      let node: Element | null = start;
      while (node && node.nodeType === 1 && node !== document.documentElement) {
        let i = 1;
        let sib = node.previousSibling;
        while (sib) {
          if (sib.nodeType === 1 && (sib as Element).tagName === node.tagName) i++;
          sib = sib.previousSibling;
        }
        parts.unshift(node.tagName.toLowerCase() + '[' + i + ']');
        node = node.parentElement;
      }
      return '/' + parts.join('/');
    }

    function labelFor(el: Element): string {
      let s = el.tagName.toLowerCase();
      const id = (el as HTMLElement).id;
      if (id) s += '#' + id;
      const cls = classList(el).slice(0, 2).join('.');
      if (cls) s += '.' + cls;
      return s;
    }

    function trim(s: string | null | undefined, n: number): string {
      if (!s) return '';
      const t = s.replace(/\s+/g, ' ').trim();
      return t.length > n ? t.slice(0, n) + '...' : t;
    }

    function snapshot(el: Element) {
      const r = el.getBoundingClientRect();
      const he = el as HTMLElement;
      const implicit: Record<string, string> = {
        A: 'link',
        BUTTON: 'button',
        INPUT: 'textbox',
        TEXTAREA: 'textbox',
        SELECT: 'combobox',
      };
      const implicitRole = implicit[el.tagName] || null;
      const inputEl = el as HTMLInputElement;
      const linkEl = el.closest('a[href]') as HTMLAnchorElement | null;
      const text = trim(he.innerText || el.textContent || '', 300);
      const textStats = sameTextStats(el, text);
      return {
        tag: el.tagName.toLowerCase(),
        id: he.id || null,
        classes: classList(el),
        text,
        ariaLabel: el.getAttribute('aria-label'),
        role: el.getAttribute('role') || implicitRole,
        href: el.getAttribute('href') || (linkEl ? linkEl.href : null),
        name: el.getAttribute('name'),
        placeholder: el.getAttribute('placeholder'),
        title: el.getAttribute('title'),
        type: el.getAttribute('type'),
        value: 'value' in el ? inputEl.value || null : null,
        selector: makeSelector(el),
        xpath: getXPath(el),
        outerHTML: (he.outerHTML || '').slice(0, 800),
        bbox: {
          x: Math.round(r.left),
          y: Math.round(r.top),
          w: Math.round(r.width),
          h: Math.round(r.height),
        },
        url: location.href,
        pageTitle: document.title,
        landmark: findLandmark(el),
        pos: posBand(r),
        pagePos: pagePos(r),
        context: nearestContext(el),
        textCount: textStats.count,
        textIndex: textStats.index,
      };
    }

    function update(el: Element) {
      const r = el.getBoundingClientRect();
      overlay.style.left = r.left + 'px';
      overlay.style.top = r.top + 'px';
      overlay.style.width = r.width + 'px';
      overlay.style.height = r.height + 'px';
      tag.textContent = labelFor(el);
      tag.style.left = r.left + 'px';
      tag.style.top = (r.top - 22 < 2 ? r.top + 4 : r.top - 22) + 'px';
    }

    function cleanup() {
      w.__acePickerActive = false;
      w.__acePickerCancel = null;
      overlay.remove();
      tag.remove();
      document.documentElement.style.cursor = prevCursor;
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('contextmenu', onCtx, true);
    }

    function onMove(e: MouseEvent) {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el || el === overlay || el === tag) return;
      current = el;
      update(el);
    }

    function onClick(e: MouseEvent) {
      if (!current) return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      const data = snapshot(current);
      cleanup();
      resolve(data);
    }

    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        cleanup();
        resolve(null);
      }
    }

    function onCtx(e: MouseEvent) {
      e.preventDefault();
      cleanup();
      resolve(null);
    }

    w.__acePickerCancel = () => {
      cleanup();
      resolve(null);
    };

    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('contextmenu', onCtx, true);
  });
}

export const PICKER_SCRIPT = `(${pickerFn.toString()})()`;
export const PICKER_CANCEL_SCRIPT =
  'window.__acePickerCancel && window.__acePickerCancel()';

// Single-line, inline-able reference. The user pastes it into a sentence
// ("change the text on this to 'John Doe'. [ref ...]"), so it must stay
// compact: one line, key=val, minimum necessary fields for an agent to
// locate the element in source and interact with it.
export function formatElementReference(
  el: PickedElement,
  scope?: { taskId?: string; tabId?: string }
): string {
  const parts: string[] = ['browser-ref'];
  if (scope?.taskId) parts.push(`task=${scope.taskId}`);
  if (scope?.tabId) parts.push(`tab=${scope.tabId}`);
  parts.push(`tag=${el.tag}`);

  const label = el.ariaLabel || el.text || el.placeholder || el.title || el.value;
  if (label) parts.push(`text=${quote(truncateText(label, 120))}`);

  if (el.landmark) parts.push(`in=${el.landmark}`);
  parts.push(`pos=${el.pos}`);
  if (el.pagePos) parts.push(`at=${el.pagePos.x}%,${el.pagePos.y}%`);
  if (el.textCount > 1) {
    const index = el.textIndex > 0 ? el.textIndex : '?';
    parts.push(`text-match=${index}/${el.textCount}`);
  }
  if (el.context && el.context !== label) {
    parts.push(`near=${quote(truncateText(el.context, 90))}`);
  }

  const selector = el.id ? `#${el.id}` : el.selector;
  parts.push(`css=${quote(selector)}`);

  if (el.role && !isImplicitRole(el.tag, el.role)) parts.push(`role=${el.role}`);
  if (el.href) parts.push(`href=${el.href}`);

  parts.push(`url=${el.url}`);

  return `[${parts.join(' ')}]`;
}

function truncateText(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '...' : s;
}

function quote(s: string): string {
  // Single-line friendly: JSON.stringify handles quotes and newlines but also
  // escapes forward slashes pointlessly. Keep it simple and predictable.
  return JSON.stringify(s);
}

function isImplicitRole(tag: string, role: string): boolean {
  const map: Record<string, string> = {
    a: 'link',
    button: 'button',
    input: 'textbox',
    textarea: 'textbox',
    select: 'combobox',
  };
  return map[tag] === role;
}
