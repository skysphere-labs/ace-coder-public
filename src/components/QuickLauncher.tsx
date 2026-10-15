import { useCallback, useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Search, FolderOpen, Settings, Plug,
  Plus, MessageSquare, Ticket,
} from 'lucide-react';
import { useApp } from '../store';

const COMMANDS = [
  { id: 'home', icon: FolderOpen, label: 'Go to Home', group: 'Navigation' },
  { id: 'settings', icon: Settings, label: 'Open Settings', group: 'Navigation', shortcut: '⌘,' },
  { id: 'plugins', icon: Plug, label: 'Plugins', group: 'Navigation' },
  { id: 'tickets', icon: Ticket, label: 'Tickets · Jira and team boards', group: 'Navigation' },
  { id: 'new-task', icon: Plus, label: 'New Task', group: 'Actions', shortcut: '⌘N' },
  { id: 'new-thread', icon: MessageSquare, label: 'New Thread', group: 'Actions' },
];

export function QuickLauncher() {
  const { showCommandPalette, setShowCommandPalette, setView, activeWorkspaceId } = useApp();
  const [query, setQuery] = useState('');

  const closePalette = useCallback(() => {
    setShowCommandPalette(false);
    setQuery('');
  }, [setShowCommandPalette]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setShowCommandPalette((value) => !value);
      }
      if (e.key === 'Escape') closePalette();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [closePalette, setShowCommandPalette]);

  const visibleCommands = useMemo(() => {
    const search = query.trim().toLowerCase();
    if (!search) return COMMANDS;
    return COMMANDS.filter(
      (command) =>
        command.label.toLowerCase().includes(search) ||
        command.group.toLowerCase().includes(search)
    );
  }, [query]);

  const handleSelect = (id: string) => {
    closePalette();
    switch (id) {
      case 'home': setView('home'); break;
      case 'settings': setView('settings'); break;
      case 'plugins': setView('plugins'); break;
      case 'tickets': setView('tickets'); break;
      case 'new-task':
      case 'new-thread':
        setView(activeWorkspaceId ? 'new-chat' : 'home');
        break;
    }
  };

  return (
    <AnimatePresence>
      {showCommandPalette && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="glass-overlay fixed inset-0 z-[130] flex items-start justify-center pt-[14vh]"
          onClick={closePalette}
        >
          <motion.div
            initial={{ opacity: 0, y: -8, scale: 0.995 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.995 }}
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
            onClick={(e) => e.stopPropagation()}
            className="glass-surface w-full max-w-xl overflow-hidden rounded-2xl"
          >
            <div className="flex h-14 items-center gap-3 border-b border-white/[0.06] px-5">
              <Search className="h-4 w-4 text-muted-foreground" />
              <input
                autoFocus
                placeholder="Type a command..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
              />
              <kbd className="rounded border border-white/[0.08] bg-white/[0.04] px-1.5 py-0.5 text-[10px] text-muted-foreground">
                ESC
              </kbd>
            </div>

            <div className="max-h-[420px] overflow-y-auto p-2">
              {['Navigation', 'Actions'].map((group) => (
                <div key={group} className="mb-1 last:mb-0">
                  <div className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50">
                    {group}
                  </div>
                  {visibleCommands.filter((command) => command.group === group).map((cmd) => (
                    <button
                      key={cmd.id}
                      onClick={() => handleSelect(cmd.id)}
                      className="glass-item flex w-full items-center gap-3 px-2 py-2 text-sm"
                    >
                      <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/[0.04] text-muted-foreground">
                        <cmd.icon className="h-4 w-4" />
                      </div>
                      <span className="min-w-0 flex-1 text-left">{cmd.label}</span>
                      {cmd.shortcut && (
                        <span className="text-[11px] text-muted-foreground">{cmd.shortcut}</span>
                      )}
                    </button>
                  ))}
                </div>
              ))}
              {visibleCommands.length === 0 && (
                <div className="px-2 py-6 text-center text-sm text-muted-foreground">No commands match your search.</div>
              )}
            </div>

            <div className="flex items-center justify-between border-t border-white/[0.06] px-5 py-2.5">
              <span className="text-[10px] text-muted-foreground">Navigate with ↑↓, select with ↵</span>
              <span className="text-[10px] text-muted-foreground">⌘K to toggle</span>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
