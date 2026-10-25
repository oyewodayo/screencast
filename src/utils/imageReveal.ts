// utils/imageReveal.ts
//
// How a picture overlay (a logo, a sticker, an end card) makes its entrance: a soft-edged wipe, a
// wipe followed by a light streak across the logo (the classic brand reveal), a pull into focus,
// or a plain fade - plus an optional shine that sweeps across again every few seconds. One state
// function drives both the live preview (ImageRevealWrap, CSS masks per animation frame) and
// export (renderImageOverlayToPng with a state, as a frame sequence), so they match.
//
// Separate from ImageOverlay.animation (fade/slide/pop of the whole box) and from keyframes - those
// still move the box; this decides what of the picture inside it is showing.

export type ImageRevealStyle = "wipe" | "glare" | "focus" | "fade";
export type ImageRevealDirection = "right" | "left" | "down" | "up" | "diagonal";

export interface ImageRevealSettings {
  style: ImageRevealStyle;
  // Which way a wipe travels. Default "right".
  direction?: ImageRevealDirection;
  // Length of the reveal in seconds. Default 1.2.
  seconds?: number;
  // Play the reveal backwards at the end. Default false.
  exit?: boolean;
  // Sweep the glare across again every this many seconds while on screen; 0/undefined = once.
  shineEvery?: number;
  // Colour of the light streak. Default white.
  shineColor?: string;
}

export const IMAGE_REVEAL_FPS = 30;
const DEFAULT_SECONDS = 1.2;
// How long one pass of the shine takes.
const SHINE_SEC = 0.8;

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

export interface ImageRevealState {
  // How far the wipe has travelled: 0 = hidden, 1 = fully shown.
  wipe: number;
  // Fraction of the box the wipe's soft edge spans.
  soft: number;
  // Where the light streak's centre is along the box's diagonal (0..1), or null when none.
  shine: number | null;
  // Blur, as a fraction of the box's shorter side.
  blur: number;
  scale: number;
  opacity: number;
  // Frames with equal keys look the same - what export renders once.
  key: string;
}

export const imageRevealSeconds = (settings: ImageRevealSettings, duration: number): number =>
  Math.max(0.1, Math.min(settings.seconds ?? DEFAULT_SECONDS, duration * 0.45));

// The picture's reveal state `t` seconds into an overlay `duration` long.
export function imageRevealState(settings: ImageRevealSettings, t: number, duration: number): ImageRevealState {
  const len = imageRevealSeconds(settings, duration);
  const exiting = !!settings.exit && t > duration - len;
  // Progress through the reveal - runs backwards over the exit.
  const p = exiting ? clamp01((duration - t) / len) : clamp01(t / len);
  const k = Math.round(t * IMAGE_REVEAL_FPS);
  const state: ImageRevealState = { wipe: 1, soft: 0.18, shine: null, blur: 0, scale: 1, opacity: 1, key: "still" };
  const moving = p < 1;

  switch (settings.style) {
    case "wipe":
      state.wipe = easeInOut(p);
      break;
    case "glare": {
      // The wipe takes the first 60%; the streak crosses over the last 65% (they overlap).
      state.wipe = easeInOut(clamp01(p / 0.6));
      if (!exiting && p > 0.35 && p < 1) state.shine = easeInOut((p - 0.35) / 0.65);
      break;
    }
    case "focus":
      state.blur = (1 - easeOutCubic(p)) * 0.08;
      state.scale = 1 + (1 - easeOutCubic(p)) * 0.08;
      state.opacity = clamp01(p * 1.6);
      break;
    default:
      state.opacity = easeInOut(p);
  }

  if (moving) {
    state.key = `f${k}`;
    return state;
  }

  // Settled: an optional shine repeats on a fixed period, measured from the end of the reveal.
  const every = settings.shineEvery ?? 0;
  if (every > 0 && !exiting) {
    const since = t - len;
    const phase = since - Math.floor(since / every) * every;
    if (phase < SHINE_SEC) {
      state.shine = easeInOut(phase / SHINE_SEC);
      state.key = `s${Math.round(phase * IMAGE_REVEAL_FPS)}`;
    }
  }
  return state;
}

// The wipe's visible region as a CSS mask over a w x h box - the same gradient export draws.
export function wipeMaskCss(direction: ImageRevealDirection | undefined, wipe: number, soft: number, w: number, h: number): string | null {
  if (wipe >= 1) return null;
  const { angle, length } = wipeAxis(direction, w, h);
  const s = soft * length;
  // The edge travels from fully before the box (-soft) to fully past it.
  const edge = -s + (length + s) * wipe;
  return `linear-gradient(${angle}deg, #000 ${edge}px, transparent ${edge + s}px)`;
}

// Direction of travel as a CSS gradient angle and the box's extent along it.
export function wipeAxis(direction: ImageRevealDirection | undefined, w: number, h: number): { angle: number; length: number; dx: number; dy: number } {
  switch (direction) {
    case "left":
      return { angle: 270, length: w, dx: -1, dy: 0 };
    case "down":
      return { angle: 180, length: h, dx: 0, dy: 1 };
    case "up":
      return { angle: 0, length: h, dx: 0, dy: -1 };
    case "diagonal": {
      // CSS's corner-to-corner gradient line length for a w x h box at 135deg.
      const a = (135 * Math.PI) / 180;
      return { angle: 135, length: Math.abs(w * Math.sin(a)) + Math.abs(h * Math.cos(a)), dx: Math.SQRT1_2, dy: Math.SQRT1_2 };
    }
    default:
      return { angle: 90, length: w, dx: 1, dy: 0 };
  }
}
