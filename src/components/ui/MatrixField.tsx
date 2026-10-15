import { useEffect, useRef } from 'react';
import { cn } from '../../lib/utils';

// MatrixField — a decorative full-bleed "matrix rain" atom on one <canvas>, indigo
// ramp (#31368A) with per-column depth. Never affects layout/input (aria-hidden,
// pointer-events:none). Constraints for the pre-auth boot path it lives on:
//   - No new deps: one canvas + requestAnimationFrame; DPR capped at 2; resizes.
//   - cancelAnimationFrame on unmount — no timer outlives the component.
//   - prefers-reduced-motion → no loop, just the wrapper's static indigo gradient.
//   - getContext('2d') null (jsdom) is a silent no-op so render tests don't throw.

type MatrixFieldProps = {
  /**
   * Speed/density multiplier. 1 = calm ambient rain; > 1 accelerates the
   * streams to imply racing into the field. Eased toward at runtime so a
   * change (e.g. bumped while authenticating) ramps rather than snaps.
   * Prop-driven only — no internal timers keyed to it.
   */
  intensity?: number;
  className?: string;
};

// Iconic half-width katakana + digits + a few operators, the matrix alphabet.
const GLYPHS =
  'ｦｧｨｩｪｫｬｭｮｯｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜ0123456789<>=+*|'.split(
    ''
  );

// Near-black indigo the trails fade toward; matches the wrapper gradient tail.
const BASE_FILL = '#05060d';

// Brightest at the head, cooling through the brand indigo ramp with depth.
function headColor(depth: number): string {
  if (depth > 0.8) return '#EEF2FF';
  if (depth > 0.55) return '#C3CCF8';
  if (depth > 0.3) return '#8B97EE';
  return '#5A64D6';
}

type Column = { x: number; row: number; step: number; depth: number; speed: number };

function makeColumn(i: number, height: number, fontSize: number): Column {
  const depth = Math.random();
  return {
    x: i * fontSize,
    // Stagger start rows above the top so streams enter over time.
    row: -Math.floor((Math.random() * height) / fontSize),
    step: Math.random(),
    depth,
    speed: 0.25 + depth * 0.9,
  };
}

export function MatrixField({ intensity = 1, className }: MatrixFieldProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Read the latest intensity inside the animation loop without tearing down
  // the effect (which would reset the field on every prop change).
  const intensityRef = useRef(intensity);
  useEffect(() => {
    intensityRef.current = intensity;
  }, [intensity]);

  useEffect(() => {
    const canvasEl = canvasRef.current;
    if (!canvasEl) return;
    const ctx2d = canvasEl.getContext('2d');
    if (!ctx2d) return; // jsdom/happy-dom or unsupported — decorative no-op.
    // Non-null aliases: control-flow narrowing from the guards above is not
    // carried into the nested draw/measure closures, so pin the types here.
    const canvas: HTMLCanvasElement = canvasEl;
    const ctx: CanvasRenderingContext2D = ctx2d;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const mql =
      typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-reduced-motion: reduce)')
        : null;

    let raf = 0;
    let cols: Column[] = [];
    let width = 0;
    let height = 0;
    let fontSize = 16;
    let curIntensity = intensityRef.current;
    let seeded = false;

    function measure() {
      const rect = canvas.getBoundingClientRect();
      width = Math.max(1, Math.floor(rect.width));
      height = Math.max(1, Math.floor(rect.height));
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      // Setting the backing size resets the transform; re-apply the DPR scale
      // so all drawing below is authored in CSS pixels.
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      fontSize = width < 640 ? 14 : 16;
      const count = Math.ceil(width / fontSize);
      cols = Array.from({ length: count }, (_, i) => makeColumn(i, height, fontSize));
      seeded = false;
    }

    function draw() {
      // Ease toward the requested intensity for a smooth acceleration ramp.
      const target = Math.max(0.2, intensityRef.current);
      curIntensity += (target - curIntensity) * 0.06;

      if (!seeded) {
        // First frame paints an opaque base so the wrapper gradient never
        // bleeds through the partially-transparent trail fills that follow.
        ctx.fillStyle = BASE_FILL;
        ctx.fillRect(0, 0, width, height);
        seeded = true;
      } else {
        // Translucent overlay dims prior glyphs into fading trails; higher
        // intensity fades slower, so racing streams leave longer streaks.
        const fade = Math.max(0.05, 0.16 - (curIntensity - 1) * 0.03);
        ctx.fillStyle = `rgba(8, 10, 22, ${fade})`;
        ctx.fillRect(0, 0, width, height);
      }

      ctx.font = `${fontSize}px ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace`;
      ctx.textBaseline = 'top';

      for (let i = 0; i < cols.length; i++) {
        const c = cols[i];
        c.step += c.speed * curIntensity;
        // Advance whole rows; drawing each stepped-through row keeps trails
        // contiguous and turns fast columns into streaks (never gaps).
        while (c.step >= 1) {
          c.step -= 1;
          c.row += 1;
          if (c.row * fontSize > height && Math.random() > 0.975) {
            c.row = 0;
            c.depth = Math.random();
            c.speed = 0.25 + c.depth * 0.9;
          }
          const glyph = GLYPHS[(Math.random() * GLYPHS.length) | 0];
          ctx.fillStyle = headColor(c.depth);
          ctx.fillText(glyph, c.x, c.row * fontSize);
        }
      }

      raf = requestAnimationFrame(draw);
    }

    function start() {
      if (raf) return;
      if (mql?.matches) {
        // Reduced motion: no loop — leave the canvas clear so the wrapper's
        // static indigo gradient is all that shows.
        ctx.clearRect(0, 0, width, height);
        return;
      }
      seeded = false;
      raf = requestAnimationFrame(draw);
    }

    function stop() {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    }

    measure();
    start();

    const onResize = () => measure();
    window.addEventListener('resize', onResize);

    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver === 'function') {
      ro = new ResizeObserver(() => measure());
      ro.observe(canvas);
    }

    const onMotionChange = () => {
      stop();
      if (mql?.matches) {
        ctx.clearRect(0, 0, width, height);
      } else {
        start();
      }
    };
    mql?.addEventListener?.('change', onMotionChange);

    return () => {
      stop();
      window.removeEventListener('resize', onResize);
      ro?.disconnect();
      mql?.removeEventListener?.('change', onMotionChange);
    };
    // Mount-only: intensity is read live through intensityRef, so this effect
    // must not re-run (and reset the field) when the prop changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      aria-hidden="true"
      className={cn('pointer-events-none absolute inset-0 overflow-hidden', className)}
      // The static reduced-motion state and the animated base both rest on this
      // indigo radial-gradient (#31368A core cooling to near-black).
      style={{
        background:
          'radial-gradient(ellipse at 50% 36%, rgba(49,54,138,0.32), rgba(12,14,32,0.85) 60%, #05060d 100%)',
      }}
    >
      <canvas ref={canvasRef} className="block h-full w-full" />
    </div>
  );
}
