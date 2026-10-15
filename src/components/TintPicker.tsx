import { useState } from 'react';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { Palette, RotateCcw } from 'lucide-react';
import { cn } from '../lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import {
  DEFAULT_TINT,
  resetTint,
  setTint,
  useTint,
  type Tint,
} from '../runtime/tint-registry';

const PRESETS: { label: string; tint: Tint }[] = [
  { label: 'Ocean',   tint: { hue: 220, saturation: 45, alpha: 0.14 } },
  { label: 'Violet',  tint: { hue: 270, saturation: 55, alpha: 0.14 } },
  { label: 'Rose',    tint: { hue: 340, saturation: 60, alpha: 0.14 } },
  { label: 'Amber',   tint: { hue: 38,  saturation: 70, alpha: 0.14 } },
  { label: 'Emerald', tint: { hue: 155, saturation: 55, alpha: 0.14 } },
  { label: 'Cyan',    tint: { hue: 190, saturation: 60, alpha: 0.14 } },
  { label: 'Slate',   tint: { hue: 220, saturation: 10, alpha: 0.08 } },
  { label: 'Sunset',  tint: { hue: 15,  saturation: 65, alpha: 0.14 } },
];

export function TintPicker({ className }: { className?: string } = {}) {
  const [open, setOpen] = useState(false);

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverPrimitive.Trigger asChild>
            <button
              type="button"
              className={cn(
                'group flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-foreground/55 transition-colors hover:bg-white/[0.04] hover:text-foreground',
                open && 'bg-white/[0.06] text-foreground',
                className
              )}
              aria-label="Appearance"
            >
              <Palette className="h-3.5 w-3.5" />
            </button>
          </PopoverPrimitive.Trigger>
        </TooltipTrigger>
        <TooltipContent side="top">Appearance</TooltipContent>
      </Tooltip>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          side="top"
          align="end"
          sideOffset={12}
          collisionPadding={16}
          className="glass-surface z-[150] w-[280px] overflow-hidden rounded-2xl p-3 animate-in fade-in-0 zoom-in-95"
        >
          <TintControls />
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

export function TintControls() {
  const tint = useTint();
  const isDefault =
    tint.hue === DEFAULT_TINT.hue &&
    tint.saturation === DEFAULT_TINT.saturation &&
    Math.abs(tint.alpha - DEFAULT_TINT.alpha) < 0.005;

  return (
    <>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Palette className="h-3.5 w-3.5 text-muted-foreground/80" />
          <h3 className="text-[12px] font-semibold text-foreground">Appearance</h3>
        </div>
        <button
          type="button"
          onClick={() => resetTint()}
          disabled={isDefault}
          className={cn(
            'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors',
            isDefault
              ? 'cursor-default text-muted-foreground/40'
              : 'text-muted-foreground hover:bg-white/[0.05] hover:text-foreground'
          )}
          title="Reset to default"
        >
          <RotateCcw className="h-2.5 w-2.5" />
          Reset
        </button>
      </div>

      <div className="mt-3 grid grid-cols-4 gap-1.5">
        {PRESETS.map((p) => {
          const active =
            tint.hue === p.tint.hue &&
            tint.saturation === p.tint.saturation &&
            Math.abs(tint.alpha - p.tint.alpha) < 0.005;
          return (
            <button
              key={p.label}
              type="button"
              onClick={() => setTint(p.tint)}
              title={p.label}
              className={cn(
                'group relative flex aspect-square items-center justify-center rounded-xl border transition-all hover:scale-[1.04]',
                active
                  ? 'border-white/25 ring-1 ring-white/20'
                  : 'border-white/[0.06] hover:border-white/[0.15]'
              )}
              style={{
                background: `radial-gradient(circle at 30% 30%, hsl(${p.tint.hue} ${p.tint.saturation}% 60% / 0.85), hsl(${p.tint.hue} ${p.tint.saturation}% 35% / 0.65))`,
              }}
            >
              <span className="sr-only">{p.label}</span>
            </button>
          );
        })}
      </div>

      <div className="mt-3 space-y-2">
        <Slider
          label="Hue"
          value={tint.hue}
          min={0}
          max={360}
          step={1}
          onChange={(v) => setTint({ hue: v })}
          thumbColor={`hsl(${tint.hue} 80% 60%)`}
        />
        <Slider
          label="Saturation"
          value={tint.saturation}
          min={0}
          max={100}
          step={1}
          onChange={(v) => setTint({ saturation: v })}
          thumbColor={`hsl(${tint.hue} ${tint.saturation}% 55%)`}
        />
        <Slider
          label="Intensity"
          value={Math.round(tint.alpha * 100)}
          min={0}
          max={40}
          step={1}
          suffix="%"
          onChange={(v) => setTint({ alpha: v / 100 })}
          thumbColor={`hsl(${tint.hue} ${tint.saturation}% 55% / 0.9)`}
        />
      </div>
    </>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  suffix,
  onChange,
  thumbColor,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix?: string;
  onChange: (v: number) => void;
  thumbColor: string;
}) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-[10px] text-muted-foreground/70">
        <span>{label}</span>
        <span className="tabular-nums text-foreground/75">
          {value}
          {suffix ?? ''}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="tint-slider h-1.5 w-full appearance-none rounded-full bg-white/[0.06] accent-foreground outline-none"
        style={{ ['--slider-thumb' as string]: thumbColor }}
      />
    </div>
  );
}
