import React from 'react';
import ReactDOM from 'react-dom/client';
// NOTE: @xterm/xterm/css/xterm.css deliberately does NOT load here. Importing
// it from the eager entry made rollup emit a static import of the whole 570KB
// xterm JS chunk just to carry the stylesheet's side effect, putting xterm on
// every boot's critical path — the mobile shell never renders a terminal at
// boot. terminal-registry imports it instead, so the CSS arrives exactly when
// the first terminal chunk does.
// Chat renderer (PRD Lane 1): streamdown's prebuilt component styles + KaTeX
// fonts. Side-effect imports so they ship in the same bundle the PWA/remote
// renderer loads (A7), without adding streamdown's node_modules to Tailwind's
// content scan.
import 'streamdown/styles.css';
import 'katex/dist/katex.min.css';
import App from './App';
import './index.css';
import { dataTransferHasType } from './lib/clipboard';
import {
  isRecursiveAceEmbed,
  SELF_EMBED_NOTICE,
} from './components/teams/hermes-dashboard-pane-logic';
import './runtime/tint-registry';
// Re-applies a persisted mobile accent (--m-accent* vars) before first paint;
// no-op on desktop and when the default indigo is active.
import './runtime/mobile-accent-registry';

// Files dropped anywhere outside an explicit dropzone would otherwise make
// the renderer navigate to file:// — that bricks the window. Swallow stray
// drags at the window level; composer/terminal dropzones still handle the
// bubbling drop event because this guard only cancels the browser default.
window.addEventListener('dragover', (e) => {
  if (
    dataTransferHasType(e.dataTransfer, 'Files') ||
    dataTransferHasType(e.dataTransfer, 'application/x-ace-paths')
  ) {
    e.preventDefault();
  }
}, { capture: true });
window.addEventListener('drop', (e) => {
  if (
    dataTransferHasType(e.dataTransfer, 'Files') ||
    dataTransferHasType(e.dataTransfer, 'application/x-ace-paths')
  ) {
    e.preventDefault();
  }
}, { capture: true });

const root = document.documentElement;
const isMac = /Mac/.test(navigator.platform) && !/iPod|iPhone|iPad/.test(navigator.platform);
const isElectron = 'aceDesktop' in window;
const isTouch =
  !isElectron &&
  (window.matchMedia?.('(pointer: coarse)').matches ||
    /iPad|iPhone|iPod|Android|Mobi/i.test(navigator.userAgent));
root.classList.add('dark');
if (isElectron && isMac) {
  root.classList.add('shell-style-glass', 'platform-macos');
}
if (!isElectron) root.classList.add('ace-remote', 'shell-style-glass');
if (isTouch) root.classList.add('ace-touch');

// Never boot the full shell inside a same-origin iframe of ourselves: that
// only happens when the Teams Hermes embed was served the Ace bundle
// back (service-worker navigateFallback or a proxy redirect escape), and
// rendering <App /> there nests Teams inside Teams without bound.
if (isRecursiveAceEmbed(window)) {
  document.getElementById('root')!.innerHTML =
    `<div style="display:flex;height:100%;min-height:100vh;align-items:center;justify-content:center;padding:24px;text-align:center;color:rgba(255,255,255,0.6);font:14px/1.5 system-ui,sans-serif;background:#0f0f10">${SELF_EMBED_NOTICE}</div>`;
} else {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}
