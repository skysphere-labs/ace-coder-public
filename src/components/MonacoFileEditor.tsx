import Editor, { type OnMount } from '@monaco-editor/react';
import { setupMonaco } from '../lib/monaco-setup';

type MonacoFileEditorProps = {
  language: string;
  value: string;
  onChange: (value: string | undefined) => void;
};

export function MonacoFileEditor({ language, value, onChange }: MonacoFileEditorProps) {
  setupMonaco();

  const handleMount: OnMount = (editor) => {
    setTimeout(() => editor.focus(), 0);
    // iOS only pops the software keyboard from within a genuine user-gesture
    // tap. Monaco routes mouse events through its own overlay, so a plain
    // editor.focus() scheduled off the tap handler sometimes misses. Hook
    // the hidden textarea into the touchstart so every tap on the editor
    // area lands focus inside the iOS gesture window.
    const dom = editor.getDomNode();
    if (!dom) return;
    const focusTextarea = () => {
      const textarea = dom.querySelector<HTMLTextAreaElement>('textarea.inputarea');
      if (textarea) textarea.focus({ preventScroll: true });
      else editor.focus();
    };
    dom.addEventListener('touchstart', focusTextarea, { passive: true });
    dom.addEventListener('pointerdown', focusTextarea);
  };

  return (
    <Editor
      theme="ace-dark"
      language={language}
      value={value}
      onChange={onChange}
      onMount={handleMount}
      options={{
        fontFamily: 'Menlo, Monaco, "Courier New", monospace',
        fontSize: 13,
        lineHeight: 20,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        smoothScrolling: true,
        padding: { top: 12, bottom: 12 },
        renderLineHighlight: 'line',
        roundedSelection: false,
        tabSize: 2,
        automaticLayout: true,
        scrollbar: {
          verticalScrollbarSize: 8,
          horizontalScrollbarSize: 8,
        },
        overviewRulerLanes: 0,
        folding: true,
        wordWrap: 'off',
        cursorBlinking: 'smooth',
        cursorSmoothCaretAnimation: 'on',
        bracketPairColorization: { enabled: true },
        // Mobile polish: hide widgets that surface a floating keyboard /
        // quick-action affordance on touch.
        lightbulb: { enabled: 'off' as const },
        contextmenu: false,
        quickSuggestions: false,
        suggestOnTriggerCharacters: false,
        parameterHints: { enabled: false },
        hover: { enabled: false },
        codeLens: false,
      }}
    />
  );
}
