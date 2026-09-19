// hooks/useCanvasWheel.ts
//
// Trackpad/mouse wheel navigation for a pan-and-zoom canvas: pinch or Ctrl+wheel zooms about the
// pointer, two fingers pan. Shared by the whiteboard and the mindmap so both surfaces feel like the
// same tool under the same hand.
//
// Two things here are easy to get wrong, and both were wrong before this hook existed:
//
// 1. THE LISTENER MUST BE NATIVE AND NON-PASSIVE. React delegates `onWheel` to the root container
//    and registers it as a PASSIVE listener, which makes `e.preventDefault()` inside a React wheel
//    handler a silent no-op (Chromium only warns in the console). The default action it fails to
//    cancel is the webview's own page zoom - so a pinch scaled the entire app chrome, toolbar and
//    panels included, instead of the canvas. Only a listener attached by hand with
//    `{ passive: false }` can cancel it, which is why this is a hook over a ref rather than a JSX
//    prop.
//
// 2. PINCH AND WHEEL ARRIVE AS THE SAME EVENT AT WILDLY DIFFERENT SCALES. Browsers report a
//    trackpad pinch as a wheel event with `ctrlKey` synthesized true even though no key is held -
//    that is the platform convention, and it's why pinch and Ctrl+wheel are deliberately one code
//    path here. But a pinch emits a fast stream of small deltas (~1-10px each) while one mouse notch
//    emits a single ~100px jolt. A fixed per-event step (the old `zoom * 1.1`) therefore rockets
//    through the zoom range under a pinch. Clamping the delta and then exponentiating gives one
//    curve that is smooth under a pinch and still a sensible ~1.2x per mouse notch, and it stays
//    geometric, so zooming out then back in returns to where it started.
import { RefObject, useEffect, useRef } from "react";

// Per-event delta cap, in pixels, before the exponential. Bounds a single mouse notch (and the
// occasional huge synthetic delta) without touching the small deltas a pinch actually produces.
const MAX_DELTA_PX = 60;
// Exponential rate. MAX_DELTA_PX * ZOOM_RATE is the natural log of the fastest single-event zoom
// step, so a full-size notch lands at about 1.2x.
const ZOOM_RATE = 0.0032;
// Wheel events can measure in lines or pages rather than pixels (some mice, and Firefox by
// default). Normalize to pixels so the tuning above means the same thing everywhere.
const LINE_HEIGHT_PX = 16;

export interface CanvasWheelOptions {
  zoom: number;
  pan: { x: number; y: number };
  minZoom: number;
  maxZoom: number;
  onZoomChange: (zoom: number) => void;
  onPanChange: (pan: { x: number; y: number }) => void;
  // Set false to ignore the wheel entirely (e.g. while a modal owns the surface).
  enabled?: boolean;
}

// Exported for test - a wheel event's units depend on the device and browser, and getting this wrong
// makes zooming either imperceptible or violent on exactly the hardware we don't have to hand.
export function pixelDelta(value: number, deltaMode: number, pageSize: number): number {
  if (deltaMode === 1) return value * LINE_HEIGHT_PX;
  if (deltaMode === 2) return value * pageSize;
  return value;
}

// The multiplier one wheel event applies to the current zoom. Exported for test. Negative delta
// (scrolling/pinching "up") magnifies, matching every other canvas tool.
export function wheelZoomFactor(pixelDeltaY: number): number {
  const clamped = Math.max(-MAX_DELTA_PX, Math.min(MAX_DELTA_PX, pixelDeltaY));
  return Math.exp(-clamped * ZOOM_RATE);
}

export default function useCanvasWheel(ref: RefObject<HTMLElement | null>, options: CanvasWheelOptions): void {
  // The handler reads the latest callbacks/limits through a ref rather than closing over them.
  // Re-attaching a listener on every pan frame would mean tearing down and rebuilding it mid-gesture,
  // dozens of times a second, for no behavioural gain.
  const latest = useRef(options);
  latest.current = options;

  // The live view transform, advanced by the handler itself rather than re-read from props each
  // event. A pinch emits wheel events faster than React re-renders, so several can land in one frame;
  // reading `props.zoom` for each of them would have every event in that frame start from the same
  // stale value and all but the last be thrown away - a pinch would crawl. Accumulating here makes a
  // burst compound correctly. `emitted` remembers what we last sent up, which is how an external
  // change (the zoom buttons, Fit, loading a document) is told apart from our own value echoing back
  // through props: if props no longer match what we emitted, someone else moved the view and wins.
  const live = useRef({ zoom: options.zoom, pan: options.pan });
  const emitted = useRef({ zoom: options.zoom, pan: options.pan });
  if (options.zoom !== emitted.current.zoom || options.pan.x !== emitted.current.pan.x || options.pan.y !== emitted.current.pan.y) {
    live.current = { zoom: options.zoom, pan: options.pan };
    emitted.current = { zoom: options.zoom, pan: options.pan };
  }

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const onWheel = (e: WheelEvent) => {
      const { minZoom, maxZoom, onZoomChange, onPanChange, enabled } = latest.current;
      if (enabled === false) return;
      const { zoom, pan } = live.current;

      // Claim the gesture before anything else: unhandled, the webview zooms itself (pinch) or
      // rubber-band-scrolls the page (two fingers).
      e.preventDefault();

      const rect = el.getBoundingClientRect();
      const dy = pixelDelta(e.deltaY, e.deltaMode, rect.height);

      if (e.ctrlKey || e.metaKey) {
        const next = Math.min(maxZoom, Math.max(minZoom, zoom * wheelZoomFactor(dy)));
        if (next === zoom) return;
        // Keep whatever sits under the cursor pinned there as the scale changes, so the pinch grows
        // the thing being pinched rather than the canvas origin.
        const px = e.clientX - rect.left;
        const py = e.clientY - rect.top;
        const nextPan = { x: px - ((px - pan.x) / zoom) * next, y: py - ((py - pan.y) / zoom) * next };
        live.current = { zoom: next, pan: nextPan };
        emitted.current = live.current;
        onPanChange(nextPan);
        onZoomChange(next);
      } else {
        const nextPan = { x: pan.x - pixelDelta(e.deltaX, e.deltaMode, rect.width), y: pan.y - dy };
        live.current = { zoom, pan: nextPan };
        emitted.current = live.current;
        onPanChange(nextPan);
      }
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [ref]);
}
