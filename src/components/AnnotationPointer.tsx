// AnnotationPointer.tsx
//
// What follows the cursor while the annotation overlay is in draw mode: a little glove on a stick
// (tinted to the current ink colour, so the pointer always tells you what colour you're about to
// draw), a glowing dot, or the user's own PNG. The hotspot - the fingertip - sits exactly on the
// real cursor position; only the stick sways, swinging on a spring when the cursor moves fast and
// settling when it stops.
//
// Everything per-frame is imperative (refs + a rAF spring that sleeps once settled), never React
// state, so tracking the mouse at 1000Hz re-renders nothing.
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import type { AnnotationPointer as PointerKind } from '../utils/annotationStyles';

export interface AnnotationPointerHandle {
  move: (x: number, y: number) => void;
  // Press feedback: the hand squeezes, and a ring expands where it landed.
  setPressed: (pressed: boolean) => void;
  tap: (x: number, y: number) => void;
  hide: () => void;
}

interface AnnotationPointerProps {
  kind: PointerKind;
  color: string;
  image: string;
  ripple: boolean;
}

// "custom" with no image uploaded yet quietly becomes the hand, rather than a missing cursor.
export const resolvePointer = (kind: PointerKind, image: string): PointerKind =>
  kind === 'custom' && !image ? 'hand' : kind;

const mixWithBlack = (hex: string, amount: number): string => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim()) ?? /^#?([0-9a-f]{3})$/i.exec(hex.trim());
  if (!m) return '#222222';
  const h = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1];
  const ch = [0, 2, 4].map((i) => Math.round(parseInt(h.slice(i, i + 2), 16) * (1 - amount)));
  return `rgb(${ch[0]}, ${ch[1]}, ${ch[2]})`;
};

// Local coordinates have the fingertip at (0,0) with the stick running down +y; the caller rotates
// the whole thing about that origin. `stick` is off for the small static previews in Settings.
export const HandGraphic: React.FC<{ color: string; stick?: boolean }> = ({ color, stick = true }) => {
  const edge = mixWithBlack(color, 0.38);
  const gloss = 'hand-gloss';
  return (
    <svg width={1} height={1} style={{ overflow: 'visible', display: 'block' }} aria-hidden>
      <defs>
        <linearGradient id={gloss} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity="0.55" />
          <stop offset="0.5" stopColor="#fff" stopOpacity="0" />
          <stop offset="1" stopColor="#000" stopOpacity="0.18" />
        </linearGradient>
      </defs>
      {stick && (
        <>
          <line x1={0} y1={58} x2={0} y2={1800} stroke="#151515" strokeWidth={7} strokeLinecap="round" />
          <line x1={-1.7} y1={58} x2={-1.7} y2={1800} stroke="#fff" strokeOpacity={0.2} strokeWidth={1.6} />
        </>
      )}
      <rect x={-12} y={50} width={24} height={13} rx={5} fill="#f5f5f4" stroke="#d6d3d1" strokeWidth={1} />
      <g stroke={edge} strokeWidth={1.4} fill={color}>
        <rect x={-17} y={26} width={34} height={30} rx={13} />
        {[33, 41, 49].map((y) => (
          <rect key={y} x={6} y={y} width={14} height={8.5} rx={4.25} />
        ))}
        <ellipse cx={-16.5} cy={41} rx={6.5} ry={9} transform="rotate(-14 -16.5 41)" />
        <rect x={-7.5} y={0.7} width={15} height={38} rx={7.5} />
      </g>
      <rect x={-17} y={26} width={34} height={30} rx={13} fill={`url(#${gloss})`} />
      <rect x={-7.5} y={0.7} width={15} height={38} rx={7.5} fill={`url(#${gloss})`} />
    </svg>
  );
};

// Resting tilt (finger up-left, stick running off toward the bottom-right) and how far the spring
// may swing from it.
const REST_ANGLE = -26;
const MAX_SWAY = 22;

const AnnotationPointer = forwardRef<AnnotationPointerHandle, AnnotationPointerProps>(({ kind, color, image, ripple }, ref) => {
  const rootRef = useRef<HTMLDivElement>(null);
  const swayRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const rippleLayerRef = useRef<HTMLDivElement>(null);

  const posRef = useRef({ x: 0, y: 0, hasPos: false });
  const springRef = useRef({ angle: 0, vel: 0, running: false, last: 0 });
  const rafRef = useRef<number | null>(null);
  const kindRef = useRef(kind);
  kindRef.current = kind;
  const rippleRef = useRef(ripple);
  rippleRef.current = ripple;
  const colorRef = useRef(color);
  colorRef.current = color;

  const applySway = (): void => {
    if (swayRef.current) swayRef.current.style.transform = `rotate(${REST_ANGLE + springRef.current.angle}deg)`;
  };

  const step = (now: number): void => {
    const s = springRef.current;
    // Frame-rate independent: 1 unit = one 60Hz frame, capped so a stalled tab can't explode it.
    const dt = Math.min(2.5, (now - s.last) / 16.667);
    s.last = now;
    s.vel += (-0.085 * s.angle - 0.13 * s.vel) * dt;
    s.angle = Math.max(-MAX_SWAY, Math.min(MAX_SWAY, s.angle + s.vel * dt));
    applySway();
    if (Math.abs(s.angle) < 0.04 && Math.abs(s.vel) < 0.04) {
      s.angle = 0;
      s.vel = 0;
      s.running = false;
      rafRef.current = null;
      applySway();
      return;
    }
    rafRef.current = requestAnimationFrame(step);
  };

  const kick = (): void => {
    const s = springRef.current;
    if (s.running) return;
    s.running = true;
    s.last = performance.now();
    rafRef.current = requestAnimationFrame(step);
  };

  useImperativeHandle(ref, () => ({
    move: (x, y) => {
      const p = posRef.current;
      const dx = p.hasPos ? x - p.x : 0;
      p.x = x;
      p.y = y;
      p.hasPos = true;
      const root = rootRef.current;
      if (!root) return;
      root.style.transform = `translate3d(${x}px, ${y}px, 0)`;
      root.style.opacity = '1';
      if (kindRef.current === 'hand' && dx !== 0) {
        // Moving right flings the stick's far end left (and vice versa), like a real pole.
        springRef.current.vel += Math.max(-4, Math.min(4, dx * 0.12));
        kick();
      }
    },
    setPressed: (pressed) => {
      const body = bodyRef.current;
      if (!body) return;
      // Every press/release restarts its own short animation (cancelling whatever is still
      // playing) rather than easing toward a resting value - a CSS transition would still be
      // mid-way when the next tap lands, so five fast taps looked like one. The inline transform
      // is the resting pose (held while drawing); the animation is the visible stab into it.
      body.getAnimations().forEach((a) => a.cancel());
      if (pressed) {
        body.style.transform = 'translateY(-3px) scale(0.9)';
        body.animate(
          [
            { transform: 'translateY(0) scale(1)' },
            { transform: 'translateY(-6px) scale(0.78)', offset: 0.4 },
            { transform: 'translateY(-3px) scale(0.9)' },
          ],
          { duration: 110, easing: 'ease-out' }
        );
      } else {
        body.style.transform = 'translateY(0) scale(1)';
        body.animate(
          [
            { transform: 'translateY(-3px) scale(0.9)' },
            { transform: 'translateY(1px) scale(1.05)', offset: 0.5 },
            { transform: 'translateY(0) scale(1)' },
          ],
          { duration: 100, easing: 'ease-out' }
        );
      }
    },
    tap: (x, y) => {
      const layer = rippleLayerRef.current;
      if (!layer || !rippleRef.current) return;
      const ring = document.createElement('div');
      ring.style.cssText = `position:absolute;left:${x}px;top:${y}px;width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:9999px;border:2.5px solid ${colorRef.current};pointer-events:none;`;
      layer.appendChild(ring);
      const anim = ring.animate(
        [
          { transform: 'scale(0.4)', opacity: 0.85 },
          { transform: 'scale(3.4)', opacity: 0 },
        ],
        { duration: 520, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)' }
      );
      anim.onfinish = () => ring.remove();
    },
    hide: () => {
      if (rootRef.current) rootRef.current.style.opacity = '0';
      posRef.current.hasPos = false;
    },
  }));

  useEffect(() => {
    applySway();
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      springRef.current.running = false;
    };
  }, []);

  return (
    <>
      <div ref={rippleLayerRef} className="fixed inset-0 pointer-events-none overflow-hidden" />
      <div
        ref={rootRef}
        className="fixed left-0 top-0 pointer-events-none"
        style={{ opacity: 0, willChange: 'transform', zIndex: 50 }}
      >
        {kind === 'hand' && (
          <div ref={swayRef} style={{ transformOrigin: '0 0', willChange: 'transform' }}>
            <div
              ref={bodyRef}
              style={{ transformOrigin: '0 0', filter: 'drop-shadow(2px 4px 3px rgba(0,0,0,0.35))' }}
            >
              <div style={{ transform: 'scale(1.15)', transformOrigin: '0 0' }}>
                <HandGraphic color={color} />
              </div>
            </div>
          </div>
        )}
        {kind === 'dot' && (
          <div
            ref={bodyRef}
            style={{
              width: 16,
              height: 16,
              marginLeft: -8,
              marginTop: -8,
              borderRadius: 9999,
              background: color,
              border: '2px solid rgba(255,255,255,0.9)',
              boxShadow: `0 0 12px 3px ${color}`,
            }}
          />
        )}
        {kind === 'custom' && (
          <div ref={bodyRef} style={{ transformOrigin: '50% 0', marginLeft: -32 }}>
            <img src={image} alt="" draggable={false} style={{ height: 64, width: 'auto', maxWidth: 96, objectFit: 'contain' }} />
          </div>
        )}
      </div>
    </>
  );
});
AnnotationPointer.displayName = 'AnnotationPointer';

export default AnnotationPointer;
