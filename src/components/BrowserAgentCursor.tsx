import { useEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import type { BrowserCursorSignal } from '../lib/ace-api';

type Point = { x: number; y: number };
type Vector = { dx: number; dy: number };
type Size = { width: number; height: number };
type Glyph =
  | { kind: 'arrow' }
  | { kind: 'keycap'; label: string }
  | { kind: 'ibeam' }
  | { kind: 'caret' };

type MotionPlan = {
  start: Point;
  control1: Point;
  control2: Point;
  end: Point;
  startedAt: number;
  duration: number;
  popPlayed: boolean;
};

type CursorEffect =
  | { kind: 'collapseRing'; origin: Point; color: string; startRadius: number; lifetime: number; age: number }
  | { kind: 'burstRing'; origin: Point; color: string; maxRadius: number; lifetime: number; age: number }
  | { kind: 'shard'; origin: Point; angle: number; color: string; speed: number; lifetime: number; age: number }
  | { kind: 'sparkle'; origin: Point; color: string; drift: Vector; size: number; lifetime: number; age: number }
  | { kind: 'glow'; origin: Point; color: string; lifetime: number; age: number; maxRadius: number }
  | { kind: 'chevronEcho'; origin: Point; axis: 'vertical' | 'horizontal'; direction: 1 | -1; color: string; lifetime: number; age: number }
  | { kind: 'orbitSpark'; center: Point; color: string; lifetime: number; age: number; radius: number; phase: number };

type CursorState = {
  visible: boolean;
  visibilityAlpha: number;
  lastActivityAt: number;
  position: Point;
  angle: number;
  angleVelocity: number;
  scale: number;
  scaleVelocity: number;
  glyph: Glyph;
  isPressed: boolean;
  isTyping: boolean;
  caretStartedAt: number;
  actionInProgress: boolean;
  motion: MotionPlan | null;
  trail: Point[];
  trailAlpha: number;
  trailAlphaVelocity: number;
  effects: CursorEffect[];
  idleSeed: number;
  idleBreathOffsetX: number;
  idleBreathOffsetY: number;
  beaconPhase: number;
  nextOrbitAt: number;
  scrollStreakUntil: number;
  scrollNodAngle: number;
  lastEchoAt: number;
  scrollOrigin: Point;
  scrollAxis: 'vertical' | 'horizontal';
  scrollDirection: 1 | -1;
  color: string;
  name: string;
};

const BASE_DURATION_MS = 1280;
const SPEED_MULTIPLIER = 1.45;
const DRAW_ANGLE_OFFSET = 0;
const ARROW_HOME_ANGLE = 0;
const CLICK_HOLD_MS = 120;
const SCROLL_STREAK_MS = 750;
const SCROLL_DWELL_MS = 850;
const TYPE_ARROW_TO_IBEAM_MS = 200;
const TYPE_IBEAM_TO_CARET_MS = 220;
const TYPE_CHARACTER_INTERVAL_MS = 90;
const TYPE_TAIL_DWELL_MS = 350;
const KEY_PRE_BOUNCE_MS = 180;
const KEY_HOLD_MS = 180;
const KEY_RELEASE_MS = 350;
const IDLE_HIDE_DELAY_MS = 60_000;
const FADE_OUT_MS = 420;
const TRAIL_LENGTH = 52;
const TRAIL_MAX_WIDTH = 9.5;
const ECHO_INTERVAL_MS = 110;
const ORBIT_SPARK_INTERVAL_MS = 5200;
const DEFAULT_CURSOR_COLOR = '#0095A1';
const DEFAULT_CURSOR_NAME = 'Codex';

export function BrowserAgentCursor({ signal }: { signal: BrowserCursorSignal | null }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const cursorRef = useRef<CursorState | null>(null);
  const sizeRef = useRef<Size>({ width: 0, height: 0 });
  const timersRef = useRef<number[]>([]);
  const lastSignalRef = useRef<BrowserCursorSignal | null>(null);
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });

  useEffect(() => {
    const node = hostRef.current;
    if (!node) return;
    const measure = () => {
      const rect = node.getBoundingClientRect();
      const next = {
        width: Math.max(0, Math.round(rect.width)),
        height: Math.max(0, Math.round(rect.height)),
      };
      sizeRef.current = next;
      setSize(next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!signal) return;
    if (lastSignalRef.current === signal) return;
    lastSignalRef.current = signal;
    startCursorAction(signal, cursorRef, sizeRef.current, timersRef);
  }, [signal]);

  useEffect(() => {
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(Math.max((now - last) / 1000, 1 / 240), 1 / 24);
      last = now;
      const ctx = canvasRef.current?.getContext('2d');
      const cursor = cursorRef.current;
      if (ctx && cursor) {
        advanceCursor(cursor, now, dt);
        drawCursor(ctx, cursor, sizeRef.current);
      } else if (ctx) {
        ctx.clearRect(0, 0, sizeRef.current.width, sizeRef.current.height);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      clearTimers(timersRef);
    };
  }, []);

  const pixelRatio = typeof window === 'undefined' ? 1 : Math.max(1, window.devicePixelRatio || 1);

  return (
    <div ref={hostRef} className="pointer-events-none absolute inset-0 z-10 overflow-hidden">
      <canvas
        ref={canvasRef}
        width={Math.max(1, Math.round(size.width * pixelRatio))}
        height={Math.max(1, Math.round(size.height * pixelRatio))}
        style={{
          width: '100%',
          height: '100%',
        }}
      />
    </div>
  );
}

function startCursorAction(
  signal: BrowserCursorSignal,
  cursorRef: MutableRefObject<CursorState | null>,
  size: Size,
  timersRef: MutableRefObject<number[]>
) {
  if (!Number.isFinite(signal.x) || !Number.isFinite(signal.y)) return;
  clearTimers(timersRef);

  const now = performance.now();
  const color = normalizeColor(signal.color) || DEFAULT_CURSOR_COLOR;
  const name = signal.name?.trim() || DEFAULT_CURSOR_NAME;
  const target = clampPoint({ x: signal.x, y: signal.y }, size);
  let cursor = cursorRef.current;
  if (!cursor) {
    cursor = createCursorState(target, size, now, color, name);
    cursorRef.current = cursor;
  }

  cursor.color = color;
  cursor.name = name;
  cursor.visible = true;
  cursor.visibilityAlpha = 1;
  cursor.lastActivityAt = now;
  cursor.isPressed = false;
  cursor.isTyping = false;
  cursor.actionInProgress = true;
  cursor.glyph = { kind: 'arrow' };
  cursor.scrollStreakUntil = 0;
  cursor.scrollNodAngle = 0;

  const duration = planMotion(cursor, target, now, size);

  if (signal.kind === 'click') {
    schedule(timersRef, duration, () => {
      cursor.isPressed = true;
      pushClickBurst(cursor, target);
    });
    schedule(timersRef, duration + CLICK_HOLD_MS, () => {
      cursor.isPressed = false;
      endAction(cursor);
    });
    return;
  }

  if (signal.kind === 'scroll') {
    const axis = Math.abs(signal.deltaX || 0) > Math.abs(signal.deltaY || 0) ? 'horizontal' : 'vertical';
    const delta = axis === 'horizontal' ? signal.deltaX || 0 : signal.deltaY || 0;
    const direction: 1 | -1 = delta >= 0 ? 1 : -1;
    schedule(timersRef, duration, () => {
      cursor.scrollOrigin = target;
      cursor.scrollAxis = axis;
      cursor.scrollDirection = direction;
      cursor.scrollStreakUntil = performance.now() + SCROLL_STREAK_MS;
      cursor.scrollNodAngle = nodAngleFor(axis, direction);
      cursor.lastEchoAt = 0;
    });
    schedule(timersRef, duration + SCROLL_DWELL_MS, () => {
      cursor.scrollNodAngle = 0;
      endAction(cursor);
    });
    return;
  }

  if (signal.kind === 'type') {
    const text = signal.text || '';
    schedule(timersRef, duration, () => {
      cursor.glyph = { kind: 'ibeam' };
    });
    schedule(timersRef, duration + TYPE_ARROW_TO_IBEAM_MS, () => {
      cursor.glyph = { kind: 'caret' };
      cursor.isTyping = true;
      cursor.caretStartedAt = performance.now();
    });
    const visibleChars = Array.from(text).slice(0, 24);
    visibleChars.forEach((_, index) => {
      schedule(
        timersRef,
        duration + TYPE_ARROW_TO_IBEAM_MS + TYPE_IBEAM_TO_CARET_MS + index * TYPE_CHARACTER_INTERVAL_MS,
        () => {
          cursor.effects.push({
            kind: 'sparkle',
            origin: {
              x: cursor.position.x + randomBetween(-3, 3),
              y: cursor.position.y - 4 + randomBetween(-1, 1),
            },
            drift: {
              dx: randomBetween(-0.6, 0.6),
              dy: randomBetween(-1.4, -0.9),
            },
            color: cursor.color,
            size: randomBetween(2.4, 3.6),
            lifetime: 620,
            age: 0,
          });
        }
      );
    });
    schedule(
      timersRef,
      duration +
        TYPE_ARROW_TO_IBEAM_MS +
        TYPE_IBEAM_TO_CARET_MS +
        visibleChars.length * TYPE_CHARACTER_INTERVAL_MS +
        TYPE_TAIL_DWELL_MS,
      () => {
        cursor.isTyping = false;
        endAction(cursor);
      }
    );
    return;
  }

  if (signal.kind === 'key') {
    const label = keycapLabel(signal.key || '');
    schedule(timersRef, duration, () => {
      cursor.glyph = { kind: 'keycap', label };
    });
    schedule(timersRef, duration + KEY_PRE_BOUNCE_MS, () => {
      cursor.isPressed = true;
      cursor.effects.push({
        kind: 'burstRing',
        origin: { x: target.x, y: target.y + 6 },
        color: cursor.color,
        maxRadius: 18,
        lifetime: 380,
        age: 0,
      });
    });
    schedule(timersRef, duration + KEY_PRE_BOUNCE_MS + KEY_HOLD_MS, () => {
      cursor.isPressed = false;
    });
    schedule(timersRef, duration + KEY_PRE_BOUNCE_MS + KEY_HOLD_MS + KEY_RELEASE_MS, () => endAction(cursor));
  }
}

function pushClickBurst(cursor: CursorState, origin: Point) {
  cursor.effects.push({
    kind: 'collapseRing',
    origin,
    color: cursor.color,
    startRadius: 18,
    lifetime: 220,
    age: 0,
  });
  cursor.effects.push({
    kind: 'burstRing',
    origin,
    color: cursor.color,
    maxRadius: 26,
    lifetime: 460,
    age: 0,
  });
  cursor.effects.push({
    kind: 'glow',
    origin,
    color: cursor.color,
    lifetime: 360,
    age: 0,
    maxRadius: 22,
  });
  for (let i = 0; i < 4; i += 1) {
    const angle = (Math.PI / 4) + (Math.PI / 2) * i;
    cursor.effects.push({
      kind: 'shard',
      origin,
      angle,
      color: cursor.color,
      speed: 110 + Math.random() * 30,
      lifetime: 480,
      age: 0,
    });
  }
}

function createCursorState(target: Point, size: Size, now: number, color: string, name: string): CursorState {
  const start = edgeEntrancePoint(size);
  return {
    visible: true,
    visibilityAlpha: 1,
    lastActivityAt: now,
    position: start,
    angle: ARROW_HOME_ANGLE,
    angleVelocity: 0,
    scale: 1,
    scaleVelocity: 0,
    glyph: { kind: 'arrow' },
    isPressed: false,
    isTyping: false,
    caretStartedAt: now,
    actionInProgress: true,
    motion: null,
    trail: [],
    trailAlpha: 0,
    trailAlphaVelocity: 0,
    effects: [{ kind: 'glow', origin: target, color, lifetime: 480, age: 0, maxRadius: 24 }],
    idleSeed: Math.random() * 1000,
    idleBreathOffsetX: 0,
    idleBreathOffsetY: 0,
    beaconPhase: 0,
    nextOrbitAt: now + ORBIT_SPARK_INTERVAL_MS + Math.random() * 1500,
    scrollStreakUntil: 0,
    scrollNodAngle: 0,
    lastEchoAt: 0,
    scrollOrigin: target,
    scrollAxis: 'vertical',
    scrollDirection: 1,
    color,
    name,
  };
}

function planMotion(cursor: CursorState, target: Point, now: number, size: Size): number {
  if (!cursor.visible || cursor.visibilityAlpha <= 0.01) {
    const start = edgeEntrancePoint(size);
    cursor.position = start;
    cursor.trail = [];
  }

  const distance = Math.max(1, pointDistance(cursor.position, target));
  const direction = normalize({ dx: target.x - cursor.position.x, dy: target.y - cursor.position.y }, { dx: 1, dy: 0 });
  const normal = { dx: -direction.dy, dy: direction.dx };
  const side = Math.random() > 0.5 ? 1 : -1;
  const arcMagnitude = 0.42 * distance * 0.5 * side;
  const flow = 0.72;
  const duration = transitDuration(distance);

  cursor.motion = {
    start: { ...cursor.position },
    control1: {
      x: cursor.position.x + direction.dx * distance * 0.94 * flow + normal.dx * arcMagnitude,
      y: cursor.position.y + direction.dy * distance * 0.94 * flow + normal.dy * arcMagnitude,
    },
    control2: {
      x: target.x - direction.dx * distance * 0.38 * flow + normal.dx * arcMagnitude * 0.4,
      y: target.y - direction.dy * distance * 0.38 * flow + normal.dy * arcMagnitude * 0.4,
    },
    end: { ...target },
    startedAt: now,
    duration,
    popPlayed: false,
  };
  return duration;
}

function advanceCursor(cursor: CursorState, now: number, dt: number) {
  cursor.beaconPhase = (cursor.beaconPhase + dt * 1.6) % (Math.PI * 2);

  if (cursor.motion) {
    const progress = motionProgress(cursor.motion, now);
    const eased = easeInOutCubic(progress);
    cursor.position = cubicBezier(
      cursor.motion.start,
      cursor.motion.control1,
      cursor.motion.control2,
      cursor.motion.end,
      eased
    );
    const targetAngle = ARROW_HOME_ANGLE + cursor.scrollNodAngle;
    const angleSpring = angularSpring(cursor.angle, cursor.angleVelocity, targetAngle, 32, 12, dt);
    cursor.angle = angleSpring.value;
    cursor.angleVelocity = angleSpring.velocity;

    if (progress > 0.9 && !cursor.motion.popPlayed) {
      cursor.motion.popPlayed = true;
      cursor.scaleVelocity += 4.2;
      cursor.effects.push({
        kind: 'glow',
        origin: cursor.motion.end,
        color: cursor.color,
        lifetime: 360,
        age: 0,
        maxRadius: 18,
      });
    }
    if (progress >= 1) {
      cursor.position = { ...cursor.motion.end };
      cursor.motion = null;
    }
  } else if (cursor.visible) {
    cursor.idleSeed += dt * 0.6;
    const breathX = Math.sin(cursor.idleSeed * 0.9) * 1.6;
    const breathY = Math.cos(cursor.idleSeed * 0.7) * 1.2;
    cursor.position = {
      x: cursor.position.x + (breathX - cursor.idleBreathOffsetX) * 0.08,
      y: cursor.position.y + (breathY - cursor.idleBreathOffsetY) * 0.08,
    };
    cursor.idleBreathOffsetX = breathX;
    cursor.idleBreathOffsetY = breathY;
    const wobble = Math.sin(cursor.idleSeed * 1.3) * 0.05;
    const targetAngle = ARROW_HOME_ANGLE + wobble + cursor.scrollNodAngle;
    const angleSpring = angularSpring(cursor.angle, cursor.angleVelocity, targetAngle, 8, 4, dt);
    cursor.angle = angleSpring.value;
    cursor.angleVelocity = angleSpring.velocity;
  }

  const scaleTarget = cursor.isPressed ? 0.92 : 1;
  const scale = scalarSpring(cursor.scale, cursor.scaleVelocity, scaleTarget, 120, 14, dt);
  cursor.scale = scale.value;
  cursor.scaleVelocity = scale.velocity;

  updateTrail(cursor, dt);

  if (now < cursor.scrollStreakUntil) {
    if (now - cursor.lastEchoAt > ECHO_INTERVAL_MS) {
      cursor.lastEchoAt = now;
      cursor.effects.push({
        kind: 'chevronEcho',
        origin: { ...cursor.scrollOrigin },
        axis: cursor.scrollAxis,
        direction: cursor.scrollDirection,
        color: cursor.color,
        lifetime: 620,
        age: 0,
      });
    }
  }

  if (!cursor.actionInProgress && !cursor.motion && now >= cursor.nextOrbitAt && cursor.visible) {
    cursor.effects.push({
      kind: 'orbitSpark',
      center: { ...cursor.position },
      color: cursor.color,
      lifetime: 1100,
      age: 0,
      radius: 14,
      phase: Math.random() * Math.PI * 2,
    });
    cursor.nextOrbitAt = now + ORBIT_SPARK_INTERVAL_MS + Math.random() * 1500;
  }

  cursor.effects = cursor.effects
    .map((effect) => ({ ...effect, age: effect.age + dt * 1000 }))
    .filter((effect) => effect.age < effect.lifetime);

  const active = !!cursor.motion || cursor.actionInProgress || cursor.isPressed || cursor.effects.length > 0;
  if (active) {
    cursor.lastActivityAt = now;
    cursor.visible = true;
    cursor.visibilityAlpha = 1;
  } else {
    const idleFor = now - cursor.lastActivityAt;
    if (idleFor <= IDLE_HIDE_DELAY_MS) {
      cursor.visible = true;
      cursor.visibilityAlpha = 1;
    } else {
      const fade = Math.min(1, Math.max(0, (idleFor - IDLE_HIDE_DELAY_MS) / FADE_OUT_MS));
      cursor.visibilityAlpha = 1 - fade;
      cursor.visible = cursor.visibilityAlpha > 0.01;
    }
  }
}

function updateTrail(cursor: CursorState, dt: number) {
  const last = cursor.trail[cursor.trail.length - 1];
  const moved = !last || pointDistance(last, cursor.position) > 0.6;
  if (moved) {
    cursor.trail.push({ ...cursor.position });
    if (cursor.trail.length > TRAIL_LENGTH) cursor.trail.shift();
  } else if (cursor.trail.length > 0) {
    cursor.trail.shift();
  }

  const trailTarget = cursor.motion ? 1 : 0;
  // Snap up while moving, drift down slowly when stopped so the ribbon lingers
  const stiffness = trailTarget === 1 ? 220 : 36;
  const damping = trailTarget === 1 ? 18 : 10;
  const spring = scalarSpring(cursor.trailAlpha, cursor.trailAlphaVelocity, trailTarget, stiffness, damping, dt);
  cursor.trailAlpha = spring.value;
  cursor.trailAlphaVelocity = spring.velocity;
}

function drawCursor(ctx: CanvasRenderingContext2D, cursor: CursorState, size: Size) {
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size.width, size.height);
  const alpha = cursor.visibilityAlpha;
  if (alpha <= 0.01) return;

  drawRibbonTrail(ctx, cursor.trail, cursor.color, alpha * cursor.trailAlpha);
  drawGlyph(ctx, cursor, alpha);
  for (const effect of cursor.effects) {
    drawEffect(ctx, effect);
  }
}

function drawRibbonTrail(ctx: CanvasRenderingContext2D, trail: Point[], color: string, alpha: number) {
  if (trail.length < 3 || alpha <= 0.01) return;
  const last = trail.length - 1;
  // Outer halo pass — wide, soft, holds presence into the tail
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (let i = 1; i <= last; i += 1) {
    const t = i / last;
    const taper = Math.sqrt(t);
    const width = TRAIL_MAX_WIDTH * taper;
    if (width < 0.4) continue;
    const segAlpha = 0.42 * taper * alpha;
    ctx.strokeStyle = rgba(color, segAlpha);
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(trail[i - 1].x, trail[i - 1].y);
    ctx.lineTo(trail[i].x, trail[i].y);
    ctx.stroke();
  }
  ctx.restore();
  // Inner core pass — bright, narrower
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (let i = 1; i <= last; i += 1) {
    const t = i / last;
    const taper = Math.sqrt(t);
    const width = TRAIL_MAX_WIDTH * 0.5 * taper;
    if (width < 0.3) continue;
    const segAlpha = 0.85 * taper * alpha;
    ctx.strokeStyle = i > last - 6
      ? `rgba(255, 255, 255, ${segAlpha})`
      : rgba(color, segAlpha * 0.9);
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(trail[i - 1].x, trail[i - 1].y);
    ctx.lineTo(trail[i].x, trail[i].y);
    ctx.stroke();
  }
  ctx.restore();
}

function drawGlyph(ctx: CanvasRenderingContext2D, cursor: CursorState, alpha: number) {
  if (cursor.glyph.kind === 'keycap') {
    drawArrow(ctx, cursor.position, cursor.angle, cursor.scale * 0.85, alpha * 0.7, cursor.isPressed, cursor.color, cursor.beaconPhase);
    drawKeycap(ctx, cursor.position, cursor.glyph.label, cursor.scale, alpha, cursor.isPressed, cursor.color);
    return;
  }
  if (cursor.glyph.kind === 'ibeam') {
    drawArrow(ctx, cursor.position, cursor.angle, cursor.scale * 0.7, alpha * 0.3, false, cursor.color, cursor.beaconPhase);
    drawIBeam(ctx, cursor.position, cursor.scale, alpha, cursor.color);
    return;
  }
  if (cursor.glyph.kind === 'caret') {
    drawArrow(ctx, cursor.position, cursor.angle, cursor.scale * 0.7, alpha * 0.3, false, cursor.color, cursor.beaconPhase);
    const phase = cursor.isTyping ? ((performance.now() - cursor.caretStartedAt) / 1000 * 1.3) % 1 : 0;
    drawCaret(ctx, cursor.position, cursor.scale, alpha, phase, cursor.color);
    return;
  }
  drawArrow(ctx, cursor.position, cursor.angle, cursor.scale, alpha, cursor.isPressed, cursor.color, cursor.beaconPhase);
}

function arrowOutlinePath(ctx: CanvasRenderingContext2D) {
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, 22.1);
  ctx.lineTo(6.1, 16.5);
  ctx.lineTo(14, 15.1);
  ctx.closePath();
}

function arrowSpinePath(ctx: CanvasRenderingContext2D) {
  ctx.beginPath();
  ctx.moveTo(1.5, 2.7);
  ctx.lineTo(1.5, 16.8);
  ctx.lineTo(3.9, 14);
  ctx.closePath();
}

function drawArrow(
  ctx: CanvasRenderingContext2D,
  position: Point,
  angle: number,
  scale: number,
  alpha: number,
  pressed: boolean,
  color: string,
  beaconPhase: number
) {
  const clamped = Math.max(0.5, Math.min(scale, 1.8));
  const fillAlpha = alpha * (pressed ? 0.82 : 1);
  ctx.save();
  ctx.translate(position.x, position.y);
  ctx.rotate(angle + DRAW_ANGLE_OFFSET);
  ctx.scale(clamped, clamped);

  // Soft colored ground-shadow halo
  ctx.shadowColor = rgba(color, 0.55 * fillAlpha);
  ctx.shadowBlur = 9;
  ctx.shadowOffsetY = 1;
  arrowOutlinePath(ctx);
  ctx.fillStyle = rgba(color, fillAlpha);
  ctx.fill();
  ctx.shadowColor = 'transparent';

  // Dark contour for legibility on light backgrounds
  arrowOutlinePath(ctx);
  ctx.strokeStyle = rgba(shade(color, -0.65), fillAlpha * 0.85);
  ctx.lineWidth = 1.1;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.stroke();

  // Glossy white inner spine
  arrowSpinePath(ctx);
  ctx.fillStyle = `rgba(255, 255, 255, ${fillAlpha * 0.55})`;
  ctx.fill();

  // Tip beacon (steady when moving, breathing on idle) — sits exactly on the click target
  const breathing = 0.82 + 0.18 * (Math.sin(beaconPhase) * 0.5 + 0.5);
  const beaconRadius = 1.9 * breathing;
  const haloRadius = 6.8 * breathing;
  const halo = ctx.createRadialGradient(0, 0, 0, 0, 0, haloRadius);
  halo.addColorStop(0, rgba(color, 0.85 * fillAlpha));
  halo.addColorStop(0.55, rgba(color, 0.32 * fillAlpha));
  halo.addColorStop(1, rgba(color, 0));
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.arc(0, 0, haloRadius, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = `rgba(255, 255, 255, ${fillAlpha})`;
  ctx.beginPath();
  ctx.arc(0, 0, beaconRadius, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

function drawKeycap(
  ctx: CanvasRenderingContext2D,
  position: Point,
  label: string,
  scale: number,
  alpha: number,
  pressed: boolean,
  color: string
) {
  const clamped = Math.max(0.55, Math.min(scale, 1.8));
  ctx.save();
  ctx.font = `600 ${12 * clamped}px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
  const text = label || 'K';
  const measuredWidth = ctx.measureText(text).width;
  const width = Math.max(28, measuredWidth + 16);
  const rect = { x: -width / 2, y: -32, width, height: 26 };
  const pressOffset = pressed ? 2 : 0;
  ctx.translate(position.x, position.y + pressOffset);
  ctx.scale(clamped, clamped);

  // Ledge / shadow base
  ctx.fillStyle = rgba(shade(color, -0.55), alpha * 0.9);
  roundedRect(ctx, rect.x, rect.y + 3 - pressOffset, rect.width, rect.height, 7);
  ctx.fill();

  // Cap face with vertical gradient
  const grad = ctx.createLinearGradient(0, rect.y, 0, rect.y + rect.height);
  grad.addColorStop(0, rgba(shade(color, 0.2), alpha));
  grad.addColorStop(1, rgba(color, alpha));
  ctx.fillStyle = grad;
  roundedRect(ctx, rect.x, rect.y, rect.width, rect.height, 7);
  ctx.fill();

  // Top accent stripe
  ctx.fillStyle = `rgba(255, 255, 255, ${alpha * (pressed ? 0.1 : 0.22)})`;
  roundedRect(ctx, rect.x + 3, rect.y + 2.5, rect.width - 6, 3, 1.5);
  ctx.fill();

  // Border
  roundedRect(ctx, rect.x, rect.y, rect.width, rect.height, 7);
  ctx.strokeStyle = `rgba(255, 255, 255, ${alpha * 0.55})`;
  ctx.lineWidth = 0.9;
  ctx.stroke();

  // Label
  ctx.fillStyle = `rgba(255, 255, 255, ${alpha})`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 0, rect.y + rect.height / 2 + (pressed ? 0.5 : 0));
  ctx.restore();
}

function drawIBeam(ctx: CanvasRenderingContext2D, position: Point, scale: number, alpha: number, color: string) {
  const clamped = Math.max(0.5, Math.min(scale, 1.8));
  ctx.save();
  ctx.translate(position.x, position.y);
  ctx.scale(clamped, clamped);
  ctx.shadowColor = rgba(color, 0.45 * alpha);
  ctx.shadowBlur = 6;
  ctx.lineCap = 'round';
  // Stem (color), centered on the tip
  ctx.strokeStyle = rgba(color, alpha);
  ctx.lineWidth = 2.2;
  ctx.beginPath();
  ctx.moveTo(0, -13.5);
  ctx.lineTo(0, 13.5);
  ctx.stroke();
  ctx.shadowColor = 'transparent';
  // Serifs (white)
  ctx.strokeStyle = `rgba(255, 255, 255, ${alpha * 0.9})`;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(-4.9, -13.5);
  ctx.lineTo(4.9, -13.5);
  ctx.moveTo(-4.9, 13.5);
  ctx.lineTo(4.9, 13.5);
  ctx.stroke();
  ctx.restore();
}

function drawCaret(ctx: CanvasRenderingContext2D, position: Point, scale: number, alpha: number, phase: number, color: string) {
  const clamped = Math.max(0.5, Math.min(scale, 1.8));
  const blink = alpha * (0.25 + (phase < 0.5 ? 0.75 : 0));
  ctx.save();
  ctx.translate(position.x, position.y);
  ctx.scale(clamped, clamped);
  ctx.shadowColor = rgba(color, 0.7 * blink);
  ctx.shadowBlur = 7;
  // Stem centered on the tip
  roundedRect(ctx, -1.3, -13.5, 2.6, 27, 1.3);
  ctx.fillStyle = rgba(color, blink);
  ctx.fill();
  ctx.shadowColor = 'transparent';
  // Pen-nib top flair
  ctx.beginPath();
  ctx.moveTo(-4, -13.5);
  ctx.lineTo(0, -17.8);
  ctx.lineTo(4, -13.5);
  ctx.closePath();
  ctx.fillStyle = `rgba(255, 255, 255, ${blink})`;
  ctx.fill();
  ctx.restore();
}

function drawEffect(ctx: CanvasRenderingContext2D, effect: CursorEffect) {
  const t = Math.min(1, effect.age / effect.lifetime);
  if (effect.kind === 'collapseRing') {
    const eased = easeOutCubic(t);
    const radius = effect.startRadius * (1 - eased * 0.78);
    ctx.save();
    ctx.strokeStyle = rgba(effect.color, (1 - t) * 0.7);
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.arc(effect.origin.x, effect.origin.y, radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  } else if (effect.kind === 'burstRing') {
    const eased = easeOutQuint(t);
    ctx.save();
    ctx.strokeStyle = rgba(effect.color, (1 - t) * 0.65);
    ctx.lineWidth = 1.8 * (1 - t * 0.6);
    ctx.beginPath();
    ctx.arc(effect.origin.x, effect.origin.y, effect.maxRadius * eased, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  } else if (effect.kind === 'shard') {
    const eased = easeOutQuint(t);
    const distance = effect.speed * (effect.age / 1000);
    const x = effect.origin.x + Math.cos(effect.angle) * distance;
    const y = effect.origin.y + Math.sin(effect.angle) * distance;
    const size = 3.6 * (1 - eased * 0.85);
    if (size < 0.3) return;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(effect.angle + Math.PI / 2 + t * 1.5);
    // Diamond outer (color)
    ctx.fillStyle = rgba(effect.color, (1 - t) * 0.85);
    ctx.beginPath();
    ctx.moveTo(0, -size);
    ctx.lineTo(size * 0.55, 0);
    ctx.lineTo(0, size);
    ctx.lineTo(-size * 0.55, 0);
    ctx.closePath();
    ctx.fill();
    // Diamond inner (white core)
    ctx.fillStyle = `rgba(255, 255, 255, ${(1 - t) * 0.9})`;
    ctx.beginPath();
    ctx.moveTo(0, -size * 0.5);
    ctx.lineTo(size * 0.28, 0);
    ctx.lineTo(0, size * 0.5);
    ctx.lineTo(-size * 0.28, 0);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  } else if (effect.kind === 'sparkle') {
    const x = effect.origin.x + effect.drift.dx * t * 26;
    const y = effect.origin.y + effect.drift.dy * t * 26;
    const fade = 1 - t;
    const size = effect.size * (0.4 + fade * 0.6);
    ctx.save();
    ctx.translate(x, y);
    ctx.shadowColor = rgba(effect.color, fade * 0.7);
    ctx.shadowBlur = 5;
    // Vertical lozenge
    ctx.fillStyle = `rgba(255, 255, 255, ${fade * 0.95})`;
    ctx.beginPath();
    ctx.moveTo(0, -size);
    ctx.lineTo(size * 0.32, 0);
    ctx.lineTo(0, size);
    ctx.lineTo(-size * 0.32, 0);
    ctx.closePath();
    ctx.fill();
    // Horizontal lozenge
    ctx.fillStyle = rgba(effect.color, fade * 0.85);
    ctx.beginPath();
    ctx.moveTo(-size, 0);
    ctx.lineTo(0, -size * 0.32);
    ctx.lineTo(size, 0);
    ctx.lineTo(0, size * 0.32);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  } else if (effect.kind === 'glow') {
    const eased = easeOutQuint(t);
    const radius = 6 + eased * effect.maxRadius;
    const gradient = ctx.createRadialGradient(
      effect.origin.x,
      effect.origin.y,
      0,
      effect.origin.x,
      effect.origin.y,
      radius
    );
    gradient.addColorStop(0, rgba(effect.color, (1 - t) * 0.32));
    gradient.addColorStop(1, rgba(effect.color, 0));
    ctx.save();
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(effect.origin.x, effect.origin.y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  } else if (effect.kind === 'chevronEcho') {
    const eased = easeOutCubic(t);
    const drift = 6 + eased * 30;
    const fade = 1 - t;
    const dx = effect.axis === 'horizontal' ? drift * effect.direction : 0;
    const dy = effect.axis === 'vertical' ? drift * (effect.direction === 1 ? 1 : -1) : 0;
    const cx = effect.origin.x + dx;
    const cy = effect.origin.y + dy;
    const span = 8 - t * 2;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 2 * fade;
    // Outer halo stroke
    ctx.strokeStyle = rgba(effect.color, fade * 0.85);
    ctx.beginPath();
    if (effect.axis === 'vertical') {
      const sign = effect.direction === 1 ? -1 : 1;
      ctx.moveTo(cx - span, cy + 2.6 * sign);
      ctx.lineTo(cx, cy - 2.6 * sign);
      ctx.lineTo(cx + span, cy + 2.6 * sign);
    } else {
      const sign = effect.direction;
      ctx.moveTo(cx - 2.6 * sign, cy - span);
      ctx.lineTo(cx + 2.6 * sign, cy);
      ctx.lineTo(cx - 2.6 * sign, cy + span);
    }
    ctx.stroke();
    // Inner white tip
    ctx.lineWidth = 1.2 * fade;
    ctx.strokeStyle = `rgba(255, 255, 255, ${fade * 0.85})`;
    ctx.stroke();
    ctx.restore();
  } else if (effect.kind === 'orbitSpark') {
    const angle = effect.phase + t * Math.PI * 2;
    const fade = Math.sin(t * Math.PI);
    const x = effect.center.x + Math.cos(angle) * effect.radius;
    const y = effect.center.y - 12 + Math.sin(angle) * (effect.radius * 0.5);
    const size = 1.8 * fade;
    if (size < 0.2) return;
    ctx.save();
    ctx.shadowColor = rgba(effect.color, fade * 0.9);
    ctx.shadowBlur = 6;
    ctx.fillStyle = `rgba(255, 255, 255, ${fade})`;
    ctx.beginPath();
    ctx.arc(x, y, size, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

function endAction(cursor: CursorState) {
  cursor.isPressed = false;
  cursor.isTyping = false;
  cursor.scrollStreakUntil = 0;
  cursor.scrollNodAngle = 0;
  cursor.glyph = { kind: 'arrow' };
  cursor.actionInProgress = false;
  cursor.lastActivityAt = performance.now();
}

function nodAngleFor(axis: 'vertical' | 'horizontal', direction: 1 | -1): number {
  if (axis === 'vertical') return direction === 1 ? 0.18 : -0.18;
  return direction === 1 ? 0.22 : -0.22;
}

function schedule(timersRef: MutableRefObject<number[]>, delay: number, fn: () => void) {
  const id = window.setTimeout(fn, Math.max(0, delay));
  timersRef.current.push(id);
}

function clearTimers(timersRef: MutableRefObject<number[]>) {
  for (const timer of timersRef.current) window.clearTimeout(timer);
  timersRef.current = [];
}

function transitDuration(distance: number): number {
  const base = BASE_DURATION_MS / SPEED_MULTIPLIER;
  const factor = Math.max(0.55, Math.min(1.8, distance / 520));
  return Math.max(420, base * factor);
}

function motionProgress(plan: MotionPlan, now: number): number {
  return Math.min(1, Math.max(0, (now - plan.startedAt) / plan.duration));
}

function cubicBezier(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const oneMinusT = 1 - t;
  const a = oneMinusT * oneMinusT * oneMinusT;
  const b = 3 * oneMinusT * oneMinusT * t;
  const c = 3 * oneMinusT * t * t;
  const d = t * t * t;
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
  };
}

function easeInOutCubic(t: number): number {
  if (t < 0.5) return 4 * t * t * t;
  const remainder = -2 * t + 2;
  return 1 - (remainder * remainder * remainder) / 2;
}

function easeOutCubic(t: number): number {
  const x = 1 - t;
  return 1 - x * x * x;
}

function easeOutQuint(t: number): number {
  const x = 1 - t;
  return 1 - x * x * x * x * x;
}

function normalize(vector: Vector, fallback: Vector): Vector {
  const length = Math.hypot(vector.dx, vector.dy);
  if (length <= 0.0001) return fallback;
  return { dx: vector.dx / length, dy: vector.dy / length };
}

function pointDistance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function edgeEntrancePoint(size: Size): Point {
  const inset = 120;
  const width = Math.max(size.width, 1);
  const height = Math.max(size.height, 1);
  const edge = Math.floor(Math.random() * 4);
  if (edge === 0) return { x: Math.random() * width, y: -inset };
  if (edge === 1) return { x: Math.random() * width, y: height + inset };
  if (edge === 2) return { x: -inset, y: Math.random() * height };
  return { x: width + inset, y: Math.random() * height };
}

function clampPoint(point: Point, size: Size): Point {
  return {
    x: Math.min(Math.max(point.x, 0), Math.max(0, size.width)),
    y: Math.min(Math.max(point.y, 0), Math.max(0, size.height)),
  };
}

function scalarSpring(value: number, velocity: number, target: number, stiffness: number, damping: number, dt: number) {
  const nextVelocity = velocity + ((target - value) * stiffness - velocity * damping) * dt;
  return { value: value + nextVelocity * dt, velocity: nextVelocity };
}

function angularSpring(value: number, velocity: number, target: number, stiffness: number, damping: number, dt: number) {
  let delta = target - value;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  const nextVelocity = velocity + (delta * stiffness - velocity * damping) * dt;
  return { value: value + nextVelocity * dt, velocity: nextVelocity };
}

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function keycapLabel(raw: string): string {
  const parts = raw
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean);
  if (!parts.length) return 'K';
  return parts
    .map((part) => {
      switch (part.toLowerCase()) {
        case 'command':
        case 'cmd':
        case 'meta':
          return 'Cmd';
        case 'control':
        case 'ctrl':
          return 'Ctrl';
        case 'option':
        case 'alt':
          return 'Opt';
        case 'shift':
          return 'Shift';
        case 'return':
        case 'enter':
          return 'Enter';
        case 'escape':
        case 'esc':
          return 'Esc';
        case 'tab':
          return 'Tab';
        case 'delete':
        case 'backspace':
          return 'Del';
        case 'left':
          return '<';
        case 'right':
          return '>';
        case 'up':
          return '^';
        case 'down':
          return 'v';
        case 'space':
          return 'Space';
        default:
          return part.length === 1 ? part.toUpperCase() : part;
      }
    })
    .join('+');
}

function normalizeColor(value: string): string | null {
  const match = value.match(/^#?([a-f0-9]{6})$/i);
  return match ? `#${match[1].toUpperCase()}` : null;
}

function rgba(hex: string, alpha: number): string {
  const color = normalizeColor(hex) || DEFAULT_CURSOR_COLOR;
  const raw = color.slice(1);
  const r = parseInt(raw.slice(0, 2), 16);
  const g = parseInt(raw.slice(2, 4), 16);
  const b = parseInt(raw.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, alpha))})`;
}

function shade(hex: string, amount: number): string {
  const color = normalizeColor(hex) || DEFAULT_CURSOR_COLOR;
  const raw = color.slice(1);
  const r = parseInt(raw.slice(0, 2), 16);
  const g = parseInt(raw.slice(2, 4), 16);
  const b = parseInt(raw.slice(4, 6), 16);
  const blend = (channel: number) => {
    if (amount >= 0) return Math.round(channel + (255 - channel) * amount);
    return Math.round(channel * (1 + amount));
  };
  const toHex = (n: number) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0').toUpperCase();
  return `#${toHex(blend(r))}${toHex(blend(g))}${toHex(blend(b))}`;
}

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}
