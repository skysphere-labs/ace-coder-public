import { useRef, useState } from 'react';
import { TerminalPanel } from './TerminalPanel';

const MIN_HEIGHT = 140;
const MAX_HEIGHT = 640;

export function TerminalBottomDrawer({ workItemId }: { workItemId: string }) {
  const [height, setHeight] = useState(280);
  const dragStart = useRef<{ y: number; h: number } | null>(null);

  const onMouseDown = (e: React.MouseEvent) => {
    dragStart.current = { y: e.clientY, h: height };
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    const onMove = (move: MouseEvent) => {
      if (!dragStart.current) return;
      const dy = dragStart.current.y - move.clientY;
      const next = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, dragStart.current.h + dy));
      setHeight(next);
    };
    const onUp = () => {
      dragStart.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  return (
    <div className="mt-1 flex shrink-0 flex-col px-1 pb-1">
      <div
        onMouseDown={onMouseDown}
        className="group relative mx-auto flex h-3 w-full items-center justify-center shrink-0 cursor-row-resize"
      >
        <span className="block h-[3px] w-10 rounded-full bg-white/[0.08] transition-colors group-hover:bg-white/25" />
        <div className="absolute inset-x-0 -top-1 -bottom-1" />
      </div>
      <div className="shrink-0" style={{ height }}>
        <TerminalPanel workItemId={workItemId} />
      </div>
    </div>
  );
}
