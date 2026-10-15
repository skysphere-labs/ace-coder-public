import { FolderOpen } from 'lucide-react';
import { motion } from 'framer-motion';
import { useApp } from '../store';
import { useMobileBackHandler } from '../runtime/mobile-back-stack';
import { useBodyScrollLock } from '../runtime/use-body-scroll-lock';
import { SWIPE_MIN_PX, SWIPE_MIN_VELOCITY } from '../runtime/use-swipe';
import { SheetHeader } from './ui/mobile';
import type { Workspace } from '../lib/types';

// Workspace chooser for the Today dashboard's New task / New chat actions.
// Tapping a primary action with more than one workspace opens this sheet so the
// owner picks the target instead of the app auto-directing into one project.
// Mirrors the MoveToFolderSheet bottom-sheet pattern (drag-to-dismiss spring +
// hardware-back + body-scroll-lock) so it feels native and consistent.
export function MobileWorkspacePickerSheet({
  workspaces,
  chatKind,
  onClose,
}: {
  workspaces: Workspace[];
  chatKind: 'thread' | 'task' | null;
  onClose: () => void;
}) {
  const { openWorkspace, setPendingChatKind } = useApp();
  useMobileBackHandler(true, onClose);
  useBodyScrollLock();

  const handleSelectWorkspace = (workspace: Workspace) => {
    if (chatKind) setPendingChatKind(chatKind);
    openWorkspace(workspace.id, 'new-chat');
    onClose();
  };

  return (
    <>
      <motion.div
        key="picker-backdrop"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.22, ease: [0.32, 0.72, 0, 1] }}
        onClick={onClose}
        className="fixed inset-0 z-[79] bg-[var(--m-scrim)]"
      />
      <motion.div
        // Drag-down-to-dismiss, reusing the slide-up entry spring on release.
        drag="y"
        dragDirectionLock
        dragConstraints={{ top: 0, bottom: 0 }}
        dragElastic={{ top: 0, bottom: 0.9 }}
        onDragEnd={(_, info) => {
          if (info.offset.y > SWIPE_MIN_PX || info.velocity.y > SWIPE_MIN_VELOCITY * 1000) onClose();
        }}
        initial={{ y: '100%' }}
        animate={{ y: 0 }}
        exit={{ y: '100%' }}
        transition={{ type: 'spring', stiffness: 360, damping: 34, mass: 0.9 }}
        className="mobile-drawer-surface fixed inset-x-0 bottom-0 z-[80] flex max-h-[70vh] flex-col rounded-t-3xl"
        style={{ paddingBottom: 'max(env(safe-area-inset-bottom), 14px)' }}
      >
        <SheetHeader title={chatKind === 'thread' ? 'New chat in…' : 'New task in…'} onBack={onClose} />
        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-2">
          {workspaces.map((ws) => (
            <button
              key={ws.id}
              type="button"
              onClick={() => handleSelectWorkspace(ws)}
              className="mobile-press flex min-h-12 w-full items-center gap-3 rounded-xl px-3 text-left text-[15px] text-[var(--m-text)] transition-colors active:bg-[var(--m-surface-press)]"
            >
              <FolderOpen className="h-4 w-4 shrink-0 text-[var(--m-text-tertiary)]" />
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{ws.name}</p>
                {ws.githubRepo && (
                  <p className="mono-data mt-0.5 truncate text-[12.5px] text-[var(--m-text-tertiary)]">
                    {ws.githubRepo}
                  </p>
                )}
              </div>
            </button>
          ))}
        </div>
      </motion.div>
    </>
  );
}
