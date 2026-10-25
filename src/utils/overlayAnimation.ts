// utils/overlayAnimation.ts
//
// A text/image overlay's whole-box entry and exit animation (fade, pop, slides) at a moment of its
// life - the live preview (VideoOverlayLayer) and the animation picker's tiles (OverlayDockedPanels)
// both draw it from here. Export mirrors it: overlay_pop_scale_expr / overlay_position_expr /
// the fade filter in conversion.rs.
import type { OverlayAnimation } from "./videoEditTypes";

// Shared entry/exit timing envelope for OverlayAnimation - text and image overlays both use the
// exact same "ramp over the first/last ANIMATION_RAMP_DURATION_SEC of the overlay's own time
// range" shape, just driving different CSS (opacity for fade, a translate offset for slide), so
// this is one function feeding both render paths below instead of two near-duplicates.
const ANIMATION_RAMP_DURATION_SEC = 0.4;
// How far off its resting position a "slide" overlay sits at the very start/end of its ramp, as a
// fraction of the frame dimension it travels along - large enough to read clearly as a slide,
// small enough that it doesn't travel distractingly far across the frame.
const SLIDE_DISTANCE_FRACTION = 0.12;

export interface OverlayAnimationStyle {
  opacity: number;
  translateXPx: number;
  translateYPx: number;
  scale: number;
  // Horizontal squash on top of `scale` - a flip turning edge-on. Undefined = 1.
  scaleX?: number;
}

// How far a "drop" falls from, as a fraction of the frame height.
const DROP_DISTANCE_FRACTION = 0.3;
const easeOutBounce = (t: number): number => {
  const n1 = 7.5625;
  const d1 = 2.75;
  if (t < 1 / d1) return n1 * t * t;
  if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75;
  if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375;
  return n1 * (t -= 2.625 / d1) * t + 0.984375;
};

// Standard ease-out-back overshoot curve (t:0..1 -> slightly past 1, settling back to 1) - the
// "pop" animation's whole visual identity is that overshoot, so a plain ease-out wouldn't read as
// distinct from a slower fade/scale.
const easeOutBack = (t: number): number => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2;
};

export const overlayAnimationStyle = (
  animation: OverlayAnimation | undefined,
  startTime: number,
  endTime: number,
  currentTime: number,
  frameWidth: number,
  frameHeight: number
): OverlayAnimationStyle => {
  if (!animation || animation === "none") return { opacity: 1, translateXPx: 0, translateYPx: 0, scale: 1 };

  const ramp = Math.min(ANIMATION_RAMP_DURATION_SEC, (endTime - startTime) / 2);
  // 0 right at either edge of the overlay's time range, ramping up to 1 once fully "arrived" -
  // clamped to half the overlay's own duration so a very short overlay still finishes entering
  // before it starts leaving, same reasoning fade already used before this was generalized.
  const progress = ramp <= 0 ? 1 : Math.max(0, Math.min(1, (currentTime - startTime) / ramp, (endTime - currentTime) / ramp));

  if (animation === "fade") return { opacity: progress, translateXPx: 0, translateYPx: 0, scale: 1 };

  // Pop keeps full opacity throughout - only its scale ramps, overshooting past 1 before settling
  // (same overall shape as CSS's ease-out-back), symmetric on both entry and exit since `progress`
  // already accounts for both edges via the min() above.
  if (animation === "pop") {
    const scale = progress >= 1 ? 1 : easeOutBack(progress);
    return { opacity: 1, translateXPx: 0, translateYPx: 0, scale };
  }

  // Flip: a pop that spins in like a tossed coin - one and a half turns about the vertical axis,
  // shown as the box squashing edge-on and back (export: overlay_flip_sx_expr).
  if (animation === "flip") {
    const scale = progress >= 1 ? 1 : easeOutBack(progress);
    const scaleX = progress >= 1 ? 1 : Math.max(0.02, Math.abs(Math.cos(Math.pow(1 - progress, 3) * 3 * Math.PI)));
    return { opacity: 1, translateXPx: 0, translateYPx: 0, scale, scaleX };
  }

  // Zoom: rushes in from 2.5x while fading in (and back out the same way).
  if (animation === "zoom") return { opacity: progress, translateXPx: 0, translateYPx: 0, scale: 1 + 1.5 * Math.pow(1 - progress, 3) };

  // Drop: falls from above and bounces to rest; rises back out.
  if (animation === "drop") return { opacity: 1, translateXPx: 0, translateYPx: -(1 - easeOutBounce(progress)) * frameHeight * DROP_DISTANCE_FRACTION, scale: 1 };

  // Slide keeps full opacity throughout - only its position ramps. `remaining` is "how far from
  // fully in place" (1 at either edge, 0 once arrived), so multiplying it by the travel distance
  // gives an offset that shrinks to 0 as the overlay settles in, then grows back as it leaves -
  // out the same side it came in from, a deliberate "peek and retreat" rather than a conveyor
  // that enters one side and exits the other.
  const remaining = 1 - progress;
  const distanceX = frameWidth * SLIDE_DISTANCE_FRACTION;
  const distanceY = frameHeight * SLIDE_DISTANCE_FRACTION;
  switch (animation) {
    case "slide-left":
      return { opacity: 1, translateXPx: -distanceX * remaining, translateYPx: 0, scale: 1 };
    case "slide-right":
      return { opacity: 1, translateXPx: distanceX * remaining, translateYPx: 0, scale: 1 };
    case "slide-up":
      return { opacity: 1, translateXPx: 0, translateYPx: -distanceY * remaining, scale: 1 };
    case "slide-down":
      return { opacity: 1, translateXPx: 0, translateYPx: distanceY * remaining, scale: 1 };
    default:
      return { opacity: 1, translateXPx: 0, translateYPx: 0, scale: 1 };
  }
};
