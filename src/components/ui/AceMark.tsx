import { useId } from 'react';
import { cn } from '../../lib/utils';

// The single source of truth for the Ace mark — the "Indigo Spade" (master v4,
// approved 2026-07-02, mirrored from public/logo/ace-mark.svg and the PWA icon
// set): the SkySphere bird's layered-blade anatomy re-read as a fanned deck
// forming a spade, drawn in the company indigo ramp with a pip dot echoing the
// eye. Every surface that shows the brand (Rail, WindowBar, WelcomeScreen,
// HomeDeck) consumes this component so the mark has exactly one definition,
// and the shimmer clips to the same geometry.
export const ACE_SPADE_TAIL =
  'M 252 314 C 258 384, 294 432, 356 452 C 304 458, 240 442, 222 392 C 213 360, 230 332, 252 314 Z';
export const ACE_SPADE_BODY =
  'M 256 64 C 320 128, 396 200, 416 278 C 428 334, 392 372, 344 368 C 310 364, 282 346, 258 320 C 228 284, 222 162, 256 64 Z';
export const ACE_SPADE_BLADE_OUTER =
  'M 252 66 C 180 118, 106 194, 94 280 C 86 338, 120 372, 164 368 C 188 366, 208 354, 222 340 C 204 342, 190 344, 172 344 C 138 346, 112 320, 118 276 C 128 200, 190 124, 252 66 Z';
export const ACE_SPADE_BLADE_MID =
  'M 244 88 C 188 134, 152 200, 152 262 C 152 308, 174 338, 210 346 C 184 332, 170 304, 172 262 C 174 208, 204 140, 244 88 Z';
export const ACE_SPADE_BLADE_IN =
  'M 250 96 C 216 140, 198 200, 202 252 C 205 288, 224 310, 248 320 C 232 302, 220 282, 218 252 C 215 205, 228 148, 250 96 Z';

// Flat-fill indigo for contexts that opt out of the gradient ramp.
const ACE_INDIGO = '#6673E4';

type AceMarkProps = {
  /** Rendered px size (square). Default 28. */
  size?: number;
  /** Sweep a cool-white sheen ~once every 3.2s. Only for hero/at-rest marks. */
  shimmer?: boolean;
  /** Indigo gradient ramp vs flat company indigo. Defaults to `true`. */
  gradient?: boolean;
  className?: string;
  /** a11y label. Default "ACE CODER". */
  title?: string;
};

export function AceMark({
  size = 28,
  shimmer = false,
  gradient = true,
  className,
  title = 'ACE CODER',
}: AceMarkProps) {
  // Unique per-instance ids so several marks on screen never collide on the
  // shared gradient / clipPath defs. useId() emits colons, which are invalid
  // inside url(#…) fragment refs on some engines, so strip them.
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const ids = {
    tail: `ace-tail-${uid}`,
    body: `ace-body-${uid}`,
    outer: `ace-outer-${uid}`,
    mid: `ace-mid-${uid}`,
    inner: `ace-in-${uid}`,
    sheen: `ace-sheen-${uid}`,
    clip: `ace-clip-${uid}`,
  };

  const fills = gradient
    ? {
        tail: `url(#${ids.tail})`,
        body: `url(#${ids.body})`,
        outer: `url(#${ids.outer})`,
        mid: `url(#${ids.mid})`,
        inner: `url(#${ids.inner})`,
      }
    : {
        tail: ACE_INDIGO,
        body: ACE_INDIGO,
        outer: ACE_INDIGO,
        mid: ACE_INDIGO,
        inner: ACE_INDIGO,
      };

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 512 512"
      fill="none"
      role="img"
      aria-label={title}
      className={cn('shrink-0', className)}
    >
      <defs>
        {gradient && (
          <>
            <linearGradient id={ids.outer} x1="0" y1="0" x2="0.55" y2="1">
              <stop offset="0" stopColor="#C3CCF8" />
              <stop offset="1" stopColor="#6673E4" />
            </linearGradient>
            <linearGradient id={ids.mid} x1="0" y1="0" x2="0.5" y2="1">
              <stop offset="0" stopColor="#8B97EE" />
              <stop offset="1" stopColor="#4A52C0" />
            </linearGradient>
            <linearGradient id={ids.inner} x1="0" y1="0" x2="0.4" y2="1">
              <stop offset="0" stopColor="#4A52C0" />
              <stop offset="1" stopColor="#31368A" />
            </linearGradient>
            <linearGradient id={ids.body} x1="0.2" y1="0" x2="0.55" y2="1">
              <stop offset="0" stopColor="#9FAAF2" />
              <stop offset="0.55" stopColor="#5A64D6" />
              <stop offset="1" stopColor="#3A40A0" />
            </linearGradient>
            <linearGradient id={ids.tail} x1="0" y1="0" x2="0.7" y2="1">
              <stop offset="0" stopColor="#3A40A0" />
              <stop offset="1" stopColor="#232868" />
            </linearGradient>
          </>
        )}
        {shimmer && (
          <>
            <linearGradient id={ids.sheen} x1="0" y1="0" x2="1" y2="0">
              <stop offset="0" stopColor="#E9EDFD" stopOpacity="0" />
              <stop offset="0.5" stopColor="#F7F9FF" stopOpacity="0.85" />
              <stop offset="1" stopColor="#E9EDFD" stopOpacity="0" />
            </linearGradient>
            <clipPath id={ids.clip}>
              <path d={ACE_SPADE_TAIL} />
              <path d={ACE_SPADE_BODY} />
              <path d={ACE_SPADE_BLADE_OUTER} />
              <path d={ACE_SPADE_BLADE_MID} />
              <path d={ACE_SPADE_BLADE_IN} />
            </clipPath>
          </>
        )}
      </defs>

      {/* the Indigo Spade — fanned blades over body + tail, pip echoing the eye */}
      <path fill={fills.tail} d={ACE_SPADE_TAIL} />
      <path fill={fills.body} d={ACE_SPADE_BODY} />
      <path fill={fills.outer} d={ACE_SPADE_BLADE_OUTER} />
      <path fill={fills.mid} d={ACE_SPADE_BLADE_MID} />
      <path fill={fills.inner} d={ACE_SPADE_BLADE_IN} />
      <circle cx="342" cy="268" r="11" fill="#EEF1FC" />

      {/* premium light glint — a cool-white band swept across, clipped to the
          mark. The .ace-sheen-band animation (and its reduced-motion off) lives
          in index.css so the media query applies. */}
      {shimmer && (
        <g clipPath={`url(#${ids.clip})`}>
          <rect
            className="ace-sheen-band"
            x="192"
            y="-128"
            width="128"
            height="768"
            fill={`url(#${ids.sheen})`}
          />
        </g>
      )}
    </svg>
  );
}
