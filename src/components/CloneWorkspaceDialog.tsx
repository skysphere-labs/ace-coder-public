import { useEffect, useState } from 'react';
import { FolderOpen, X } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { useApp } from '../store';
import { cloneWorkspaceRepository, pickWorkspaceDirectory } from '../runtime/workspace-registry';

function inferDirectoryName(repoUrl: string) {
  const cleaned = repoUrl.trim().replace(/#.*$/, '').replace(/\?.*$/, '').replace(/\/+$/, '');
  const sshMatch = cleaned.match(/[:/]([^/]+?)(?:\.git)?$/);
  return sshMatch ? sshMatch[1] : '';
}

export function CloneWorkspaceDialog() {
  const { showCloneWorkspaceModal, setShowCloneWorkspaceModal, openWorkspace } = useApp();
  const [repoUrl, setRepoUrl] = useState('');
  const [localPath, setLocalPath] = useState('');
  const [pathEdited, setPathEdited] = useState(false);
  const [isCloning, setIsCloning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!showCloneWorkspaceModal) {
      setRepoUrl('');
      setLocalPath('');
      setPathEdited(false);
      setIsCloning(false);
      setError(null);
    }
  }, [showCloneWorkspaceModal]);

  if (!showCloneWorkspaceModal) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="glass-overlay fixed inset-0 z-[100] flex items-center justify-center"
        onClick={() => {
          if (!isCloning) {
            setShowCloneWorkspaceModal(false);
          }
        }}
      >
        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: 8 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 8 }}
          transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
          onClick={(event) => event.stopPropagation()}
          className="glass-surface flex max-h-[calc(100dvh-48px)] w-full max-w-xl flex-col overflow-hidden rounded-2xl"
        >
          <div className="flex shrink-0 items-center justify-between px-6 pr-4 pt-6">
            <div>
              <h2 className="font-display text-lg font-semibold">Clone Repository</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Clone a Git repository into a local workspace and add it to Ace.
              </p>
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={isCloning}
              onClick={() => setShowCloneWorkspaceModal(false)}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>

          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-5">
            <div>
              <label className="mb-1.5 block text-xs font-medium">Repository URL</label>
              <Input
                autoFocus
                value={repoUrl}
                onChange={(event) => {
                  const nextUrl = event.target.value;
                  setRepoUrl(nextUrl);
                  setError(null);
                  if (!pathEdited) {
                    const suggestion = inferDirectoryName(nextUrl);
                    setLocalPath(suggestion);
                  }
                }}
                placeholder="https://github.com/owner/repo.git"
                className="h-10"
              />
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-medium">Destination path</label>
              <div className="flex gap-2">
                <Input
                  value={localPath}
                  onChange={(event) => {
                    setLocalPath(event.target.value);
                    setPathEdited(true);
                    setError(null);
                  }}
                  placeholder="/path/to/workspace"
                  className="h-10"
                />
                <Button
                  variant="outline"
                  size="sm"
                  className="h-10 gap-1.5"
                  disabled={isCloning}
                  onClick={async () => {
                    const picked = await pickWorkspaceDirectory({
                      title: 'Clone Repository',
                      message: 'Select or create a destination folder for the cloned workspace.',
                      createDirectory: true,
                    });
                    if (picked.path) {
                      setLocalPath(picked.path);
                      setPathEdited(true);
                      setError(null);
                    }
                  }}
                >
                  <FolderOpen className="h-3.5 w-3.5" />
                  Choose
                </Button>
              </div>
            </div>

            {error && (
              <div className="rounded-md border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
                {error}
              </div>
            )}
          </div>

          <div className="flex shrink-0 items-center justify-end gap-2 border-t border-white/[0.05] px-6 py-4">
            <Button
              variant="ghost"
              size="sm"
              disabled={isCloning}
              onClick={() => setShowCloneWorkspaceModal(false)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={isCloning || !repoUrl.trim() || !localPath.trim()}
              onClick={async () => {
                const trimmedUrl = repoUrl.trim();
                const trimmedPath = localPath.trim();
                if (!trimmedUrl || !trimmedPath) return;
                setIsCloning(true);
                setError(null);
                try {
                  const cloned = await cloneWorkspaceRepository(trimmedUrl, trimmedPath);
                  openWorkspace(cloned.id);
                  setShowCloneWorkspaceModal(false);
                } catch (cloneError) {
                  setError(
                    cloneError instanceof Error
                      ? cloneError.message
                      : 'Failed to clone repository.'
                  );
                } finally {
                  setIsCloning(false);
                }
              }}
            >
              {isCloning ? 'Cloning...' : 'Clone Repository'}
            </Button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
