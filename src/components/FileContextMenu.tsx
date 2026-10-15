import * as ContextMenu from '@radix-ui/react-context-menu';
import { type ReactNode } from 'react';
import { cn } from '../lib/utils';

export type ContextMenuItem =
  | { kind: 'item'; label: string; onSelect: () => void; disabled?: boolean; danger?: boolean }
  | { kind: 'separator' };

export function FileContextMenu({
  children, items,
}: {
  children: ReactNode;
  items: ContextMenuItem[];
}) {
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          className="glass-surface z-[200] min-w-[220px] overflow-hidden rounded-xl p-1.5 text-[13px] animate-in fade-in-0 zoom-in-95"
          collisionPadding={8}
        >
          {items.map((item, i) => {
            if (item.kind === 'separator') {
              return (
                <ContextMenu.Separator
                  key={`sep-${i}`}
                  className="my-1 h-px bg-white/[0.06]"
                />
              );
            }
            return (
              <ContextMenu.Item
                key={`${item.label}-${i}`}
                disabled={item.disabled}
                onSelect={() => item.onSelect()}
                className={cn(
                  'glass-item flex cursor-pointer items-center px-2.5 py-1.5 outline-none',
                  'data-[disabled]:cursor-not-allowed data-[disabled]:opacity-40',
                  item.danger
                    ? 'text-red-300/85 data-[highlighted]:text-red-200'
                    : 'text-foreground/85'
                )}
              >
                {item.label}
              </ContextMenu.Item>
            );
          })}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
