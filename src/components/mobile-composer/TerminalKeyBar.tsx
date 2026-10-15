import type { PointerEvent, ReactNode } from 'react';
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Undo2,
} from 'lucide-react';
import { writeTerminalInput } from '../../runtime/terminal-io';

// Raw byte sequences the PTY interprets the same as a hardware keyboard.
// Arrow keys use CSI (xterm "application cursor" mode off — every Ace we care
// about handles both, and CSI is the safer default).
const SEQ_UP = '\x1b[A';
const SEQ_DOWN = '\x1b[B';
const SEQ_RIGHT = '\x1b[C';
const SEQ_LEFT = '\x1b[D';
const SEQ_ESC = '\x1b';
// Claude Code / Codex treat a rapid double-esc as "rewind to previous
// checkpoint". Sending them back-to-back matches what a hardware keyboard
// would emit when the user taps esc twice in quick succession.
const SEQ_REWIND = '\x1b\x1b';

export function TerminalKeyBar({ streamId }: { streamId: string }) {
  const send = (seq: string) => {
    void writeTerminalInput(streamId, seq);
  };
  return (
    <div className="mobile-composer-pill flex items-stretch gap-1 rounded-full p-1">
      <Key label="Left" onPress={() => send(SEQ_LEFT)}>
        <ChevronLeft className="h-[18px] w-[18px]" strokeWidth={2} />
      </Key>
      <Key label="Down" onPress={() => send(SEQ_DOWN)}>
        <ChevronDown className="h-[18px] w-[18px]" strokeWidth={2} />
      </Key>
      <Key label="Up" onPress={() => send(SEQ_UP)}>
        <ChevronUp className="h-[18px] w-[18px]" strokeWidth={2} />
      </Key>
      <Key label="Right" onPress={() => send(SEQ_RIGHT)}>
        <ChevronRight className="h-[18px] w-[18px]" strokeWidth={2} />
      </Key>
      <Key label="Escape" onPress={() => send(SEQ_ESC)}>
        <span className="text-[12px] font-semibold tracking-wide text-foreground">esc</span>
      </Key>
      <Key label="Rewind (esc esc)" onPress={() => send(SEQ_REWIND)}>
        <Undo2 className="h-[15px] w-[15px]" strokeWidth={2} />
      </Key>
    </div>
  );
}

function Key({
  label,
  onPress,
  children,
}: {
  label: string;
  onPress: () => void;
  children: ReactNode;
}) {
  // Fire on pointerdown + preventDefault so the press lands immediately and
  // the composer textarea (and its soft keyboard) never lose focus — tapping
  // a key while mid-typed draft would otherwise dismiss the keyboard.
  const onPointerDown = (e: PointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    onPress();
  };
  return (
    <button
      type="button"
      aria-label={label}
      onPointerDown={onPointerDown}
      className="mobile-glass-key flex h-11 min-w-[44px] flex-1 basis-0 items-center justify-center rounded-full text-foreground transition-colors"
    >
      {children}
    </button>
  );
}
