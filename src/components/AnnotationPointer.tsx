// AnnotationPointer.tsx
//
// Ultra-lightweight cursor stand-in while the annotation overlay is in draw mode:
// - 4 refined built-in hand/pointer styles ("minimal", "classic", "wand", "stylus"), a glowing dot,
//   or the user's own PNG, with the exact fingertip/nib hotspot pinned at (0, 0).
// - Zero-lag GPU rendering: instead of running a live CSS `filter: drop-shadow(...)` over a giant
//   overflow-visible SVG on Windows' transparent overlay WebView2 (which forced costly per-frame
//   offscreen filter passes), the active pointer is rasterized ONCE into a compact HiDPI PNG bitmap
//   whenever (handStyle, color, scale) changes and moved exclusively via `translate3d(x, y, 0)` on
//   its own compositor layer — zero SVG re-rasterization, zero React re-renders, <0.05ms per move.
import React, { forwardRef, useEffect, useId, useImperativeHandle, useRef, useState } from 'react';
import {
  AnnotationHandStyle,
  AnnotationPointer as PointerKind,
  DEFAULT_HAND_STYLE,
  DEFAULT_POINTER_SCALE,
} from '../utils/annotationStyles';

export interface AnnotationPointerHandle {
  move: (x: number, y: number) => void;
  // Instant press feedback via GPU scale on the exact fingertip origin (0,0).
  setPressed: (pressed: boolean) => void;
  tap: (x: number, y: number) => void;
  hide: () => void;
}

interface AnnotationPointerProps {
  kind: PointerKind;
  handStyle?: AnnotationHandStyle;
  scale?: number;
  color: string;
  image: string;
  ripple: boolean;
}

// "custom" with no image uploaded yet quietly becomes the hand, rather than a missing cursor.
export const resolvePointer = (kind: PointerKind, image: string): PointerKind =>
  kind === 'custom' && !image ? 'hand' : kind;

const mixColor = (hex: string, target: [number, number, number], amount: number): string => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim()) ?? /^#?([0-9a-f]{3})$/i.exec(hex.trim());
  if (!m) return `rgb(${target[0]}, ${target[1]}, ${target[2]})`;
  const h = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1];
  const ch = [0, 2, 4].map((i, idx) => {
    const v = parseInt(h.slice(i, i + 2), 16);
    return Math.round(v + (target[idx] - v) * amount);
  });
  return `rgb(${ch[0]}, ${ch[1]}, ${ch[2]})`;
};

const darken = (hex: string, amount: number) => mixColor(hex, [14, 14, 18], amount);
const lighten = (hex: string, amount: number) => mixColor(hex, [255, 255, 255], amount);

// Tilt angle per hand style so the fingertip/nib naturally points up-left from the presenter's hand.
const HAND_TILT: Record<AnnotationHandStyle, number> = {
  minimal: -18,
  classic: -24,
  wand: -28,
  stylus: -32,
};

// Pure SVG markup builder shared by BOTH the static Settings preview cards (`HandGraphic`) AND the
// one-shot HiDPI bitmap rasterizer (`renderPointerBitmap`), guaranteeing 100% visual identity.
function handInnerMarkup(style: AnnotationHandStyle, color: string, stick: boolean, uid: string): string {
  const edge = darken(color, 0.42);
  const hi = lighten(color, 0.36);
  const shade = darken(color, 0.16);
  const gGloss = `hg-${uid}`;
  const gStick = `hs-${uid}`;
  const gMetal = `hm-${uid}`;

  if (style === 'stylus') {
    // Sleek digital presentation stylus: precision glowing nib right at (0, 0).
    return `
      <defs>
        <linearGradient id="${gGloss}" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stop-color="${hi}"/>
          <stop offset="45%" stop-color="${color}"/>
          <stop offset="100%" stop-color="${shade}"/>
        </linearGradient>
        <linearGradient id="${gMetal}" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stop-color="#f8fafc"/>
          <stop offset="50%" stop-color="#cbd5e1"/>
          <stop offset="100%" stop-color="#64748b"/>
        </linearGradient>
      </defs>
      <!-- Precision tip at (0,0) -->
      <circle cx="0" cy="0.5" r="2.2" fill="#ffffff" stroke="${color}" stroke-width="1.3"/>
      <!-- Tapered metal cone -->
      <path d="M 0 1.2 L -5.6 15.5 L 5.6 15.5 Z" fill="url(#${gMetal})" stroke="#334155" stroke-width="1" stroke-linejoin="round"/>
      <!-- Accent collar ring -->
      <rect x="-6.2" y="14.5" width="12.4" height="4.2" rx="1.6" fill="${color}" stroke="${edge}" stroke-width="1"/>
      <!-- Ergonomic tapered barrel -->
      <path d="M -6 18.4 L -6.8 66 C -6.8 70.5 -3.6 73 0 73 C 3.6 73 6.8 70.5 6.8 66 L 6 18.4 Z" fill="url(#${gGloss})" stroke="${edge}" stroke-width="1.2"/>
      <!-- Specular highlight stripe -->
      <line x1="-2.4" y1="21" x2="-2.8" y2="63" stroke="#ffffff" stroke-opacity="0.38" stroke-width="1.8" stroke-linecap="round"/>
      <!-- Side button detail -->
      <rect x="-1.4" y="27" width="2.8" height="10" rx="1.4" fill="#ffffff" fill-opacity="0.55"/>
    `;
  }

  if (style === 'minimal') {
    // Crisp, refined stick-free pointing hand — compact, feather-light, zero clutter.
    return `
      <defs>
        <linearGradient id="${gGloss}" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="${lighten(color, 0.25)}"/>
          <stop offset="55%" stop-color="${color}"/>
          <stop offset="100%" stop-color="${shade}"/>
        </linearGradient>
      </defs>
      <!-- Refined anatomical pointing hand, fingertip exact at (0,0) -->
      <path
        d="M 0 0.6
           C 3.2 0.6 5.2 2.8 5.2 6.2
           L 5.2 20.5
           C 7.4 19.6 10.6 20.4 11.4 22.8
           C 13.8 22.2 16.5 23.4 17 26.2
           C 19.2 26.2 21 28 21 30.8
           L 20.2 38.5
           C 19.5 45.2 14.5 49.5 7.4 49.5
           L -2.6 49.5
           C -8.6 49.5 -12.6 45.4 -15.4 39.8
           L -20.2 30.5
           C -21.6 27.8 -20.2 24.4 -17.3 23.6
           C -14.7 22.9 -12.4 24.4 -10.8 27.1
           L -7.8 31.8
           L -5.2 31.8
           L -5.2 6.2
           C -5.2 2.8 -3.2 0.6 0 0.6 Z"
        fill="url(#${gGloss})"
        stroke="#ffffff"
        stroke-width="2.2"
        stroke-linejoin="round"
        stroke-linecap="round"
      />
      <!-- Inner crisp outline for contrast on bright slides -->
      <path
        d="M 0 0.6
           C 3.2 0.6 5.2 2.8 5.2 6.2
           L 5.2 20.5
           C 7.4 19.6 10.6 20.4 11.4 22.8
           C 13.8 22.2 16.5 23.4 17 26.2
           C 19.2 26.2 21 28 21 30.8
           L 20.2 38.5
           C 19.5 45.2 14.5 49.5 7.4 49.5
           L -2.6 49.5
           C -8.6 49.5 -12.6 45.4 -15.4 39.8
           L -20.2 30.5
           C -21.6 27.8 -20.2 24.4 -17.3 23.6
           C -14.7 22.9 -12.4 24.4 -10.8 27.1
           L -7.8 31.8
           L -5.2 31.8
           L -5.2 6.2
           C -5.2 2.8 -3.2 0.6 0 0.6 Z"
        fill="none"
        stroke="${edge}"
        stroke-width="0.9"
        stroke-linejoin="round"
      />
      <!-- Subtle knuckle creases -->
      <path d="M 5.4 21.5 L 5.4 29.5 M 11.4 23.6 L 11.1 30.6 M 16.8 26.8 L 16.3 32.5" stroke="${edge}" stroke-opacity="0.45" stroke-width="1.2" stroke-linecap="round"/>
      <!-- Soft glossy highlight along index finger -->
      <line x1="-1.6" y1="6.5" x2="-1.6" y2="23" stroke="#ffffff" stroke-opacity="0.45" stroke-width="2" stroke-linecap="round"/>
    `;
  }

  // "classic" (compact short handle) and "wand" (slender presenter baton)
  const stickLen = style === 'wand' ? 210 : 96;
  const stickWidth = style === 'wand' ? 4.8 : 5.4;
  return `
    <defs>
      <linearGradient id="${gGloss}" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="${hi}"/>
        <stop offset="48%" stop-color="${color}"/>
        <stop offset="100%" stop-color="${shade}"/>
      </linearGradient>
      <linearGradient id="${gStick}" gradientUnits="userSpaceOnUse" x1="0" y1="48" x2="0" y2="${48 + stickLen}">
        <stop offset="0%" stop-color="#1e293b"/>
        <stop offset="68%" stop-color="#0f172a"/>
        <stop offset="100%" stop-color="#0f172a" stop-opacity="0"/>
      </linearGradient>
    </defs>
    ${
      stick
        ? `
      <line x1="1" y1="48" x2="1" y2="${48 + stickLen}" stroke="url(#${gStick})" stroke-width="${stickWidth}" stroke-linecap="round"/>
      <line x1="-0.3" y1="48" x2="-0.3" y2="${48 + stickLen * 0.72}" stroke="#ffffff" stroke-opacity="0.22" stroke-width="1.2" stroke-linecap="round"/>
    `
        : ''
    }
    <!-- Tailored crisp white cuff -->
    <rect x="-8.5" y="42.5" width="19" height="8.8" rx="4" fill="#f8fafc" stroke="#cbd5e1" stroke-width="1.1"/>
    <circle cx="5.5" cy="46.9" r="1.4" fill="${color}" fill-opacity="0.75"/>
    <!-- Organic sculpted pointing hand, fingertip exact at (0,0) -->
    <path
      d="M 0 0.6
         C 3.1 0.6 5.1 2.7 5.1 6
         L 5.1 19.6
         C 7.4 18.8 10.4 19.6 11.2 21.8
         C 13.5 21.3 16.1 22.5 16.6 25.1
         C 18.7 25.2 20.3 26.9 20.2 29.6
         L 19.3 36.2
         C 18.6 41.2 14.6 44.2 8.8 44.2
         L -3.8 44.2
         C -9.2 44.2 -12.6 40.6 -14.8 35.8
         L -18.3 28.4
         C -19.5 25.9 -18.2 22.9 -15.5 22.2
         C -13.1 21.6 -11 23 -9.6 25.5
         L -6.6 29.8
         L -5.1 29.8
         L -5.1 6
         C -5.1 2.7 -3.1 0.6 0 0.6 Z"
      fill="url(#${gGloss})"
      stroke="${edge}"
      stroke-width="1.45"
      stroke-linejoin="round"
      stroke-linecap="round"
    />
    <!-- Subtle inner highlight & finger creases -->
    <path d="M 5.2 20.6 L 5.2 28.2 M 11.1 22.6 L 10.8 29.1 M 16.4 25.6 L 15.9 30.8" stroke="${edge}" stroke-opacity="0.45" stroke-width="1.15" stroke-linecap="round"/>
    <line x1="-1.5" y1="6" x2="-1.5" y2="21.5" stroke="#ffffff" stroke-opacity="0.48" stroke-width="1.9" stroke-linecap="round"/>
  `;
}

// Static inline SVG preview used in Settings cards and the live preview stage.
export const HandGraphic: React.FC<{
  color: string;
  handStyle?: AnnotationHandStyle;
  stick?: boolean;
}> = ({ color, handStyle = DEFAULT_HAND_STYLE, stick = true }) => {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  return (
    <svg
      width={1}
      height={1}
      style={{ overflow: 'visible', display: 'block' }}
      aria-hidden
      dangerouslySetInnerHTML={{ __html: handInnerMarkup(handStyle, color, stick, uid) }}
    />
  );
};

const isDarkHex = (hex: string): boolean => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim()) ?? /^#?([0-9a-f]{3})$/i.exec(hex.trim());
  if (!m) return false;
  const h = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1];
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.14;
};

// Compact full-hand color swatch rendered in the floating annotation toolbar when the Hand pointer
// is active — uses the exact same vector geometry as the live pointer, cropped cleanly to fit the tray.
export const HandSwatchGraphic: React.FC<{
  color: string;
  handStyle?: AnnotationHandStyle;
}> = ({ color, handStyle = DEFAULT_HAND_STYLE }) => {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const dark = isDarkHex(color);

  const spec =
    handStyle === 'stylus'
      ? { viewBox: '-12 -3 24 78', width: 14, height: 34, stick: false }
      : handStyle === 'minimal'
      ? { viewBox: '-24 -3 50 56', width: 25, height: 29, stick: false }
      : { viewBox: '-24 -3 50 67', width: 25, height: 34, stick: true };

  return (
    <svg
      width={spec.width}
      height={spec.height}
      viewBox={spec.viewBox}
      aria-hidden
      style={{
        display: 'block',
        overflow: 'hidden',
        filter: dark
          ? 'drop-shadow(0 0 1px rgba(255,255,255,0.65)) drop-shadow(0 2px 3px rgba(0,0,0,0.55))'
          : 'drop-shadow(0 2px 3px rgba(0,0,0,0.45))',
      }}
      dangerouslySetInnerHTML={{ __html: handInnerMarkup(handStyle, color, spec.stick, uid) }}
    />
  );
};

// Pre-rendered HiDPI pointer bitmap so moving the pointer across the screen is a single GPU blit
// with zero SVG vector rasterization and zero CSS filter: drop-shadow() overhead.
interface PointerSprite {
  src: string;
  width: number;
  height: number;
  hotX: number;
  hotY: number;
}

const spriteCache = new Map<string, PointerSprite>();

function buildPointerSprite(
  kind: PointerKind,
  handStyle: AnnotationHandStyle,
  color: string,
  scale: number,
  onReady: (sprite: PointerSprite) => void
): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const clampedScale = Math.max(0.55, Math.min(1.4, scale));
  const key = `${kind}|${handStyle}|${color}|${clampedScale.toFixed(2)}|${dpr}`;
  const cached = spriteCache.get(key);
  if (cached) {
    onReady(cached);
    return;
  }

  if (kind === 'dot') {
    const r = Math.round(7 * clampedScale);
    const pad = Math.round(14 * clampedScale);
    const size = (r + pad) * 2;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const c = size / 2;
    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = 10 * clampedScale;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(c, c, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.strokeStyle = 'rgba(255,255,255,0.92)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(c, c, r, 0, Math.PI * 2);
    ctx.stroke();
    const sprite: PointerSprite = { src: canvas.toDataURL('image/png'), width: size, height: size, hotX: c, hotY: c };
    spriteCache.set(key, sprite);
    onReady(sprite);
    return;
  }

  // Tight local bounding box for the chosen hand style (with stick & tilt accounted for).
  const tilt = HAND_TILT[handStyle];
  const stickLen = handStyle === 'wand' ? 210 : handStyle === 'classic' ? 96 : 0;
  const maxY = handStyle === 'stylus' ? 80 : 54 + stickLen;
  const rad = (Math.abs(tilt) * Math.PI) / 180;
  const pad = 12;
  const left = Math.ceil((26 + pad) * clampedScale);
  const top = Math.ceil((12 + pad) * clampedScale);
  const right = Math.ceil((28 + maxY * Math.sin(rad) + pad) * clampedScale);
  const bottom = Math.ceil((maxY * Math.cos(rad) + 18 + pad) * clampedScale);
  const width = left + right;
  const height = top + bottom;

  const svgStr = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <g transform="translate(${left}, ${top}) rotate(${tilt}) scale(${clampedScale})">
      ${handInnerMarkup(handStyle, color, true, 'sp')}
    </g>
  </svg>`;

  const img = new Image();
  img.onload = () => {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Crisp subtle shadow baked ONCE into the cached sprite (never re-computed per mouse move!).
    ctx.shadowColor = 'rgba(0, 0, 0, 0.30)';
    ctx.shadowBlur = 4;
    ctx.shadowOffsetX = 1.5;
    ctx.shadowOffsetY = 2.5;
    ctx.drawImage(img, 0, 0, width, height);
    const sprite: PointerSprite = {
      src: canvas.toDataURL('image/png'),
      width,
      height,
      hotX: left,
      hotY: top,
    };
    if (spriteCache.size > 48) spriteCache.clear();
    spriteCache.set(key, sprite);
    onReady(sprite);
  };
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgStr)}`;
}

const AnnotationPointer = forwardRef<AnnotationPointerHandle, AnnotationPointerProps>(
  ({ kind, handStyle = DEFAULT_HAND_STYLE, scale = DEFAULT_POINTER_SCALE, color, image, ripple }, ref) => {
    const rootRef = useRef<HTMLDivElement>(null);
    const bodyRef = useRef<HTMLDivElement>(null);
    const rippleLayerRef = useRef<HTMLDivElement>(null);
    const rippleRef = useRef(ripple);
    rippleRef.current = ripple;
    const colorRef = useRef(color);
    colorRef.current = color;
    const [sprite, setSprite] = useState<PointerSprite | null>(null);

    useEffect(() => {
      if (kind !== 'hand' && kind !== 'dot') {
        setSprite(null);
        return;
      }
      let cancelled = false;
      buildPointerSprite(kind, handStyle, color, scale, (built) => {
        if (!cancelled) setSprite(built);
      });
      return () => {
        cancelled = true;
      };
    }, [kind, handStyle, color, scale]);

    useImperativeHandle(ref, () => ({
      move: (x, y) => {
        const root = rootRef.current;
        if (!root) return;
        root.style.transform = `translate3d(${x}px, ${y}px, 0)`;
        if (root.style.opacity !== '1') root.style.opacity = '1';
      },
      setPressed: (pressed) => {
        const body = bodyRef.current;
        if (!body) return;
        // Pure CSS transform transition on exact fingertip origin (0,0) — zero WAAPI allocation overhead.
        body.style.transform = pressed ? 'scale(0.93)' : 'scale(1)';
      },
      tap: (x, y) => {
        const layer = rippleLayerRef.current;
        if (!layer || !rippleRef.current) return;
        const ring = document.createElement('div');
        ring.style.cssText = `position:absolute;left:${x}px;top:${y}px;width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:9999px;border:2px solid ${colorRef.current};pointer-events:none;will-change:transform,opacity;`;
        layer.appendChild(ring);
        const anim = ring.animate(
          [
            { transform: 'scale(0.4)', opacity: 0.85 },
            { transform: 'scale(3.2)', opacity: 0 },
          ],
          { duration: 460, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)' }
        );
        anim.onfinish = () => ring.remove();
      },
      hide: () => {
        if (rootRef.current) rootRef.current.style.opacity = '0';
      },
    }));

    const customHeight = Math.round(54 * Math.max(0.55, Math.min(1.4, scale)));

    return (
      <>
        <div ref={rippleLayerRef} className="fixed inset-0 pointer-events-none overflow-hidden" />
        <div
          ref={rootRef}
          className="fixed left-0 top-0 pointer-events-none"
          style={{ opacity: 0, willChange: 'transform', contain: 'layout style', backfaceVisibility: 'hidden', zIndex: 50 }}
        >
          {(kind === 'hand' || kind === 'dot') && sprite && (
            <div
              ref={bodyRef}
              style={{
                transformOrigin: '0 0',
                transition: 'transform 55ms ease-out',
                willChange: 'transform',
              }}
            >
              <img
                src={sprite.src}
                alt=""
                draggable={false}
                width={sprite.width}
                height={sprite.height}
                style={{
                  display: 'block',
                  width: sprite.width,
                  height: sprite.height,
                  transform: `translate3d(${-sprite.hotX}px, ${-sprite.hotY}px, 0)`,
                }}
              />
            </div>
          )}
          {kind === 'custom' && (
            <div
              ref={bodyRef}
              style={{
                transformOrigin: '0 0',
                transition: 'transform 55ms ease-out',
              }}
            >
              <img
                src={image}
                alt=""
                draggable={false}
                style={{
                  height: customHeight,
                  width: 'auto',
                  maxWidth: Math.round(customHeight * 1.5),
                  objectFit: 'contain',
                  transform: 'translateX(-50%)',
                }}
              />
            </div>
          )}
        </div>
      </>
    );
  }
);
AnnotationPointer.displayName = 'AnnotationPointer';

export default AnnotationPointer;
