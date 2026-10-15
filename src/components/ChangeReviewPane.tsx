import { X } from 'lucide-react';
import { useApp } from '../store';
import { Button } from './ui/button';
import { ChangesPanel } from './ChangesPanel';

export function ChangeReviewPane() {
  const { activeTask, setShowDiffViewer } = useApp();

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex h-9 shrink-0 items-center border-b border-border bg-muted/50">
        <div className="min-w-0 flex-1 px-3 text-xs font-medium text-foreground">
          Changes
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          className="mr-1 h-7 w-7"
          onClick={() => setShowDiffViewer(false)}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        {activeTask ? (
          <ChangesPanel scope={{ taskId: activeTask.id }} />
        ) : (
          <div className="flex h-full items-center justify-center p-4">
            <p className="text-center text-xs text-muted-foreground">
              Select a task to review changes.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
