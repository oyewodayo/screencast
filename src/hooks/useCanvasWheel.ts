// hooks/useCanvasWheel.ts
//
// Trackpad, touchscreen, and mouse wheel navigation for a pan-and-zoom canvas:
// - Trackpad pinch (Chromium/WebView2 wheel with ctrlKey=true, or Safari gesturechange) zooms
//   smoothly about the pointer
// - Ctrl/Cmd + mouse wheel zooms about the pointer (~1.2x per notch)
// - Two-finger trackpad scroll pans smoothly
// - Two-finger touchscreen pinch zooms + pans simultaneously about the midpoint between fingers
//
// Shared by the whiteboard and mindmap so every infinite canvas feels consistent.
import { RefObject, useEffect, useRef } from "react";

// Per-event delta cap, in pixels, before the exponential. Bounds a single mouse notch (and the
// occasional huge synthetic delta) without touching the small deltas a pinch actually produces.
const MAX_DELTA_PX = 60;
// Exponential rate for discrete mouse wheel notches (~1.2x per notch when clamped at 60px).
const ZOOM_RATE = 0.0032;
// Windows Precision Touchpads and macOS trackpads emit small pixel deltas (1-15px) per pinch
// event; a ~3x higher sensitivity gives crisp, responsive 1:1 pinch zooming without overshooting.
const PINCH_ZOOM_RATE = 0.0095;
const PINCH_MAX_DELTA_PX = 40;
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

// The multiplier one mouse-wheel event applies to the current zoom. Exported for test. Negative
// delta (scrolling "up") magnifies, matching every other canvas tool.
export function wheelZoomFactor(pixelDeltaY: number): number {
  const clamped = Math.max(-MAX_DELTA_PX, Math.min(MAX_DELTA_PX, pixelDeltaY));
  return Math.exp(-clamped * ZOOM_RATE);
}

// The multiplier one trackpad pinch event (small DOM_DELTA_PIXEL deltas with ctrlKey=true) applies
// to the current zoom. Exported for test.
export function pinchZoomFactor(pixelDeltaY: number): number {
  const clamped = Math.max(-PINCH_MAX_DELTA_PX, Math.min(PINCH_MAX_DELTA_PX, pixelDeltaY));
  return Math.exp(-clamped * PINCH_ZOOM_RATE);
}

function touchPairMetrics(t0: Touch, t1: Touch): { dist: number; cx: number; cy: number } {
  const dx = t1.clientX - t0.clientX;
  const dy = t1.clientY - t0.clientY;
  return {
    dist: Math.hypot(dx, dy),
    cx: (t0.clientX + t1.clientX) / 2,
    cy: (t0.clientY + t1.clientY) / 2,
  };
}

export default function useCanvasWheel(ref: RefObject<HTMLElement | null>, options: CanvasWheelOptions): void {
  const latest = useRef(options);
  latest.current = options;

  // Live view transform advanced synchronously inside gesture handlers and flushed to React at most
  // once per animation frame. Crucially, we only re-sync `live` from incoming React props when the
  // props change *externally* (Fit, +/- buttons, page switch) — NOT when an older React render
  // echoes back a value we ourselves emitted 1-2 frames ago while a 120Hz touchpad pinch is still
  // streaming new events (which previously clobbered live zoom backwards during heavy canvases!).
  const live = useRef({ zoom: options.zoom, pan: options.pan });
  const prevProps = useRef({ zoom: options.zoom, pan: options.pan });
  const recentEmitted = useRef<{ zoom: number; px: number; py: number }[]>([]);
  const rafId = useRef<number | null>(null);

  const propsChanged =
    options.zoom !== prevProps.current.zoom ||
    options.pan.x !== prevProps.current.pan.x ||
    options.pan.y !== prevProps.current.pan.y;

  if (propsChanged) {
    prevProps.current = { zoom: options.zoom, pan: options.pan };
    const idx = recentEmitted.current.findIndex(
      (e) =>
        Math.abs(e.zoom - options.zoom) < 1e-6 &&
        Math.abs(e.px - options.pan.x) < 0.5 &&
        Math.abs(e.py - options.pan.y) < 0.5
    );
    if (idx >= 0) {
      // Echo of our own gesture emit — drop older echoes, keep live ahead.
      recentEmitted.current.splice(0, idx + 1);
    } else {
      // External camera change (Fit, zoom buttons, Reset, page switch, camera animation).
      live.current = { zoom: options.zoom, pan: options.pan };
      recentEmitted.current = [];
    }
  }

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const scheduleFlush = () => {
      if (rafId.current !== null) return;
      rafId.current = requestAnimationFrame(() => {
        rafId.current = null;
        const snap = { zoom: live.current.zoom, pan: { ...live.current.pan } };
        recentEmitted.current.push({ zoom: snap.zoom, px: snap.pan.x, py: snap.pan.y });
        if (recentEmitted.current.length > 24) recentEmitted.current.shift();
        latest.current.onPanChange(snap.pan);
        latest.current.onZoomChange(snap.zoom);
      });
    };

    const applyZoomAroundPoint = (factor: number, clientX: number, clientY: number) => {
      const { minZoom, maxZoom } = latest.current;
      const { zoom, pan } = live.current;
      const next = Math.min(maxZoom, Math.max(minZoom, zoom * factor));
      if (next === zoom) return;
      const rect = el.getBoundingClientRect();
      const px = clientX - rect.left;
      const py = clientY - rect.top;
      const nextPan = {
        x: px - ((px - pan.x) / zoom) * next,
        y: py - ((py - pan.y) / zoom) * next,
      };
      live.current = { zoom: next, pan: nextPan };
      scheduleFlush();
    };

    const onWheel = (e: WheelEvent) => {
      if (latest.current.enabled === false) return;
      // Claim the gesture before anything else: unhandled, the webview zooms itself (pinch) or
      // rubber-band-scrolls the page (two fingers).
      e.preventDefault();

      const rect = el.getBoundingClientRect();
      const dy = pixelDelta(e.deltaY, e.deltaMode, rect.height);
      const dx = pixelDelta(e.deltaX, e.deltaMode, rect.width);

      if (e.ctrlKey || e.metaKey) {
        if (dy === 0) return;
        // Trackpad pinch gestures emit DOM_DELTA_PIXEL with small continuous deltas (< 40px);
        // discrete mouse wheels emit larger notched jumps (~100px) or DOM_DELTA_LINE.
        const isTrackpadPinch = e.deltaMode === 0 && Math.abs(dy) < PINCH_MAX_DELTA_PX;
        const factor = isTrackpadPinch ? pinchZoomFactor(dy) : wheelZoomFactor(dy);
        applyZoomAroundPoint(factor, e.clientX, e.clientY);
      } else {
        const { zoom, pan } = live.current;
        live.current = { zoom, pan: { x: pan.x - dx, y: pan.y - dy } };
        scheduleFlush();
      }
    };

    // Two-finger touchscreen / touch-mode pinch & pan
    let lastTouchPair: { dist: number; cx: number; cy: number } | null = null;
    const onTouchStart = (e: TouchEvent) => {
      if (latest.current.enabled === false) return;
      if (e.touches.length === 2) {
        lastTouchPair = touchPairMetrics(e.touches[0], e.touches[1]);
      } else {
        lastTouchPair = null;
      }
    };
    const onTouchMove = (e: TouchEvent) => {
      if (latest.current.enabled === false) return;
      if (e.touches.length !== 2 || !lastTouchPair) return;
      e.preventDefault();
      const cur = touchPairMetrics(e.touches[0], e.touches[1]);
      const { minZoom, maxZoom } = latest.current;
      const { zoom, pan } = live.current;
      const scaleFactor = lastTouchPair.dist > 4 ? cur.dist / lastTouchPair.dist : 1;
      const next = Math.min(maxZoom, Math.max(minZoom, zoom * scaleFactor));
      const rect = el.getBoundingClientRect();
      const prevPx = lastTouchPair.cx - rect.left;
      const prevPy = lastTouchPair.cy - rect.top;
      const curPx = cur.cx - rect.left;
      const curPy = cur.cy - rect.top;
      const nextPan = {
        x: curPx - ((prevPx - pan.x) / zoom) * next,
        y: curPy - ((prevPy - pan.y) / zoom) * next,
      };
      live.current = { zoom: next, pan: nextPan };
      lastTouchPair = cur;
      scheduleFlush();
    };
    const onTouchEnd = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        lastTouchPair = touchPairMetrics(e.touches[0], e.touches[1]);
      } else {
        lastTouchPair = null;
      }
    };

    // macOS / WebKit Safari trackpad gesture events (when ctrlKey wheel isn't synthesized)
    let lastGestureScale = 1;
    const onGestureStart = (e: Event) => {
      if (latest.current.enabled === false) return;
      e.preventDefault();
      lastGestureScale = (e as unknown as { scale?: number }).scale ?? 1;
    };
    const onGestureChange = (e: Event) => {
      if (latest.current.enabled === false) return;
      e.preventDefault();
      const ge = e as unknown as { scale?: number; clientX?: number; clientY?: number };
      const curScale = ge.scale ?? 1;
      if (lastGestureScale > 0 && curScale > 0) {
        const rect = el.getBoundingClientRect();
        const cx = ge.clientX ?? rect.left + rect.width / 2;
        const cy = ge.clientY ?? rect.top + rect.height / 2;
        applyZoomAroundPoint(curScale / lastGestureScale, cx, cy);
      }
      lastGestureScale = curScale;
    };

    // Capture phase ensures nested nodes/tables/images never swallow trackpad pinch events.
    el.addEventListener("wheel", onWheel, { passive: false, capture: true });
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd, { passive: true });
    el.addEventListener("touchcancel", onTouchEnd, { passive: true });
    el.addEventListener("gesturestart", onGestureStart, { passive: false });
    el.addEventListener("gesturechange", onGestureChange, { passive: false });

    return () => {
      if (rafId.current !== null) {
        cancelAnimationFrame(rafId.current);
        rafId.current = null;
      }
      el.removeEventListener("wheel", onWheel, { capture: true });
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchEnd);
      el.removeEventListener("gesturestart", onGestureStart);
      el.removeEventListener("gesturechange", onGestureChange);
    };
  }, [ref]);
}
