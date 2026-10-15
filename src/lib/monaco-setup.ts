import * as monaco from 'monaco-editor';
import { loader } from '@monaco-editor/react';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

declare global {
  interface Window {
    MonacoEnvironment?: {
      getWorker: (moduleId: string, label: string) => Worker;
    };
  }
}

let configured = false;
export function setupMonaco() {
  if (configured) return;
  configured = true;

  self.MonacoEnvironment = {
    getWorker(_moduleId, label) {
      if (label === 'json') return new jsonWorker();
      if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker();
      if (label === 'html' || label === 'handlebars' || label === 'razor') {
        return new htmlWorker();
      }
      if (label === 'typescript' || label === 'javascript') return new tsWorker();
      return new editorWorker();
    },
  };

  loader.config({ monaco });
  monaco.editor.defineTheme('ace-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#00000000',
      'editor.foreground': '#f9fafb',
      'editorLineNumber.foreground': '#6b7280',
      'editorLineNumber.activeForeground': '#d1d5db',
      'editorCursor.foreground': '#f9fafb',
      'editor.selectionBackground': '#3b82f640',
      'editor.inactiveSelectionBackground': '#3b82f620',
      'editor.lineHighlightBackground': '#ffffff08',
      'editorIndentGuide.background': '#ffffff0c',
      'editorIndentGuide.activeBackground': '#ffffff18',
      'editorWidget.background': '#111111',
      'editorWidget.border': '#ffffff1a',
      'editorSuggestWidget.background': '#111111',
      'editorSuggestWidget.border': '#ffffff1a',
      'scrollbarSlider.background': '#ffffff14',
      'scrollbarSlider.hoverBackground': '#ffffff24',
      'scrollbarSlider.activeBackground': '#ffffff30',
    },
  });
}
