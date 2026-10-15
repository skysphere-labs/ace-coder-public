import { useState } from 'react';
import { motion } from 'framer-motion';
import { Plug, RefreshCw } from 'lucide-react';
import { cn } from '../lib/utils';
import { refreshSkillCatalog, loadMcp } from '../runtime/catalog-registry';
import { SkillsPanel } from './SkillCatalog';
import { ToolServersPanel } from './ToolServerCatalog';

type TabId = 'skills' | 'mcp';

const TABS: { id: TabId; label: string }[] = [
  { id: 'skills', label: 'Skills' },
  { id: 'mcp', label: 'MCP Servers' },
];

export function PluginsScreen() {
  const [activeTab, setActiveTab] = useState<TabId>('skills');
  const [refreshing, setRefreshing] = useState(false);

  const handleRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await (activeTab === 'skills' ? refreshSkillCatalog() : loadMcp());
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="shell-sidebar-surface flex h-full min-h-0 flex-col overflow-hidden text-foreground">
      <div className="min-h-0 flex-1 overflow-y-auto px-6">
        <div className="mx-auto w-full max-w-4xl px-4 pb-16 pt-6 sm:px-8 sm:pt-10">
          <div className="mb-1 flex items-center gap-2">
            <Plug className="h-5 w-5 text-foreground/70" />
            <h2 className="font-display text-lg font-semibold tracking-tight">Plugins</h2>
            <div className="flex-1" />
            <button
              type="button"
              onClick={handleRefresh}
              disabled={refreshing}
              aria-label="Refresh"
              className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-white/[0.04] hover:text-foreground disabled:opacity-50"
            >
              <RefreshCw className={cn('h-4 w-4', refreshing && 'animate-spin')} />
            </button>
          </div>
          <p className="mb-6 text-sm text-muted-foreground">
            Extend agent capabilities with skills and MCP servers
          </p>

          <div className="border-b border-white/[0.06]">
            <div className="flex items-center gap-1">
              {TABS.map((tab) => {
                const isActive = activeTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setActiveTab(tab.id)}
                    className={cn(
                      'group relative flex h-10 items-center gap-2 px-4 text-sm font-medium transition-colors',
                      isActive
                        ? 'text-foreground'
                        : 'text-muted-foreground hover:text-foreground'
                    )}
                  >
                    {tab.label}
                    {isActive && (
                      <motion.span
                        layoutId="plugins-tab-indicator"
                        className="absolute inset-x-3 -bottom-px h-0.5 rounded-full bg-foreground"
                        transition={{ type: 'spring', stiffness: 380, damping: 30 }}
                      />
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="mt-8">
            {activeTab === 'skills' && <SkillsPanel />}
            {activeTab === 'mcp' && <ToolServersPanel />}
          </div>
        </div>
      </div>
    </div>
  );
}
