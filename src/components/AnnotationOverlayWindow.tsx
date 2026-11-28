// AnnotationOverlayWindow.tsx
//
// The system-wide "stylus annotation" overlay - a transparent window spanning every monitor
// (pre-declared in tauri.conf.json; Dashboard.tsx's toggleAnnotationDrawMode places it over every
// monitor each time it's shown), toggled into "draw mode" by a global hotkey owned by Dashboard.tsx
// (this window has no OS focus/taskbar presence of its own to hang a hotkey off of). Strokes are
// freehand ink on a full-window <canvas> that fade out a few seconds after each one is finished,
// regardless of whether draw mode is still on - so a circle drawn just before exiting draw mode
// still gets to fade naturally instead of vanishing instantly.
import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, emit } from '@tauri-apps/api/event';
import { IoClose, IoPencil, IoSparkles, IoFlash, IoArrowUndo, IoTrashOutline, IoHandLeft, IoEllipse, IoAdd, IoImage, IoVolumeHigh, IoVolumeMute, IoShieldCheckmarkOutline, IoOptionsOutline, IoSettingsOutline } from 'react-icons/io5';
import { BsHighlighter } from 'react-icons/bs';
import { AppSettings, loadSettings, SETTINGS_CHANGED_DOM_EVENT, updateSettings } from '../utils/appSettings';
import type { AutoBlurMode } from '../utils/privacyShield';
import AnnotationPointer, { AnnotationPointerHandle, HandSwatchGraphic, resolvePointer } from './AnnotationPointer';
import ScreenBlurLayer from './ScreenBlurLayer';
import useScreenBlur from '../hooks/useScreenBlur';
import { playTapSound } from '../utils/annotationSound';
import {
  ANNOTATION_COLORS,
  ANNOTATION_FADES,
  ANNOTATION_HAND_STYLES,
  ANNOTATION_POINTERS,
  ANNOTATION_STYLES,
  ANNOTATION_TAP_SOUNDS,
  AnnotationFade,
  AnnotationHandStyle,
  AnnotationInk,
  AnnotationPointer as PointerKind,
  AnnotationStrokePoint,
  AnnotationStyle,
  AnnotationTapSound,
  bakeAnnotationInk,
  BakedInk,
  drawAnnotationInk,
  drawLiveInkSegment,
  fadeTiming,
  fadeTotalMs,
  strokeOpacity,
} from '../utils/annotationStyles';

// Settings > Annotation's pointer/tap options, re-read each time draw mode turns on like the ink.
interface PointerConfig {
  kind: PointerKind;
  handStyle: AnnotationHandStyle;
  scale: number;
  image: string;
  ripple: boolean;
  sound: AnnotationTapSound;
  volume: number;
}

const readPointerConfig = (): PointerConfig => {
  const st = loadSettings();
  return {
    kind: st.annotationPointer,
    handStyle: st.annotationHandStyle,
    scale: st.annotationPointerScale,
    image: st.annotationPointerImage,
    ripple: st.annotationTapRipple,
    sound: st.annotationTapSound,
    volume: st.annotationSoundVolume,
  };
};

// A press that ends within this distance of where it began is a "tap", not a stroke.
const TAP_SLOP_PX = 4;

interface Stroke extends AnnotationInk {
  // Captured per stroke, so switching style/fade mid-presentation doesn't restyle what's already
  // on screen.
  fade: AnnotationFade;
  // performance.now() timestamp of pointerup, i.e. when the fade countdown starts - 0 while the
  // stroke is still being drawn.
  finishedAt: number;
  // The finished stroke as a bitmap (bakeAnnotationInk), made on its first frame after pointerup.
  baked?: BakedInk | null;
}

// Slop distance to differentiate a stationary tap from a stroke.


const STYLE_ICONS: Record<AnnotationStyle, React.ReactNode> = {
  pen: <IoPencil size={14} />,
  marker: <BsHighlighter size={13} />,
  neon: <IoSparkles size={14} />,
  laser: <IoFlash size={14} />,
};

// Style shortcuts in the overlay (with 1-8 for the palette, Backspace to clear, Esc to exit) -
// the whole toolbar from the keyboard, for when it's hidden.
const KEY_STYLES: Record<string, AnnotationStyle> = { p: 'pen', m: 'marker', n: 'neon', l: 'laser' };

const POINTER_ICONS: Record<PointerKind, React.ReactNode> = {
  hand: <IoHandLeft size={15} />,
  dot: <IoEllipse size={12} />,
  system: <IoAdd size={16} />,
  custom: <IoImage size={14} />,
};

const AnnotationOverlayWindow = () => {
  // Dual-canvas architecture for zero-lag drawing during 60fps presenting/recording:
  // - bakedCanvasRef (bottom): holds finished/fading strokes; never repainted while dragging.
  // - liveCanvasRef  (top, desynchronized): draws ONLY the active stroke incrementally in O(1)
  //   per pointer sample, then hands off to bakedCanvasRef on pointerup.
  const bakedCanvasRef = useRef<HTMLCanvasElement>(null);
  const liveCanvasRef = useRef<HTMLCanvasElement>(null);
  const liveCtxRef = useRef<CanvasRenderingContext2D | null>(null);
  const strokesRef = useRef<Stroke[]>([]);
  const currentStrokeRef = useRef<Stroke | null>(null);
  const livePrevMidRef = useRef<{ x: number; y: number } | null>(null);
  const liveDirtyRef = useRef<{ minX: number; minY: number; maxX: number; maxY: number } | null>(null);

  const rafRef = useRef<number | null>(null);
  const wakeTimerRef = useRef<number | null>(null);

  const [drawModeActive, setDrawModeActive] = useState(false);
  // Seeded from Settings > Annotation every time draw mode turns on (see the listener below);
  // the toolbar can change colour/style for the rest of that session.
  const [ink, setInk] = useState(() => {
    const st = loadSettings();
    return { color: st.annotationColor, width: st.annotationWidth, style: st.annotationStyle, fade: st.annotationFade, shadow: st.annotationShadow };
  });
  const inkRef = useRef(ink);
  inkRef.current = ink;
  const [showToolbar, setShowToolbar] = useState(() => loadSettings().annotationShowToolbar);
  const [pointerCfg, setPointerCfg] = useState<PointerConfig>(readPointerConfig);
  const pointerCfgRef = useRef(pointerCfg);
  pointerCfgRef.current = pointerCfg;
  // Null until the toolbar is dragged: it sits bottom-centre, where it's out of the way of the
  // slide's content but still close to hand.
  const [toolbarPos, setToolbarPos] = useState<{ x: number; y: number } | null>(null);
  // Which toolbar popover (pointer / tap sound / live options & Privacy Shield) is open.
  const [menu, setMenu] = useState<'pointer' | 'sound' | 'options' | null>(null);
  const [shieldCfg, setShieldCfg] = useState(() => {
    const st = loadSettings();
    return {
      strength: st.annotationBlurStrength,
      autoWhatsApp: st.annotationAutoBlurWhatsApp,
      autoText: st.annotationAutoBlurText,
    };
  });
  const drawModeActiveRef = useRef(false);
  drawModeActiveRef.current = drawModeActive;
  const toolbarRef = useRef<HTMLDivElement>(null);
  const pointerRef = useRef<AnnotationPointerHandle>(null);
  const pressRef = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const pointerKind = resolvePointer(pointerCfg.kind, pointerCfg.image);

  // Fade/restore the floating toolbar imperatively during a stroke so pointerdown/pointerup never
  // trigger a React re-render mid-gesture.
  const setToolbarDrawing = (active: boolean) => {
    const el = toolbarRef.current;
    if (!el) return;
    el.style.opacity = active ? '0.12' : '1';
    el.style.pointerEvents = active ? 'none' : 'auto';
  };
  // "blur" swaps drawing for placing Privacy Shield blur regions (B). Regions outlive draw mode -
  // they're native windows (services/screen_blur.rs) that stay up, click-through, until removed.
  const [tool, setToolState] = useState<'ink' | 'blur'>('ink');
  const setTool = (next: 'ink' | 'blur' | ((prev: 'ink' | 'blur') => 'ink' | 'blur')) => {
    setToolState((prev) => {
      const resolved = typeof next === 'function' ? next(prev) : next;
      if (resolved !== prev) void emit('annotation-tool-changed', { tool: resolved });
      return resolved;
    });
  };
  const blur = useScreenBlur(drawModeActive);
  const dragStateRef = useRef({ dragging: false, startX: 0, startY: 0, originX: 0, originY: 0 });

  // Sizes both canvases cleanly (capped at 2x DPR so multi-monitor 4K overlays never waste memory
  // bandwidth) and enables `desynchronized: true` on the live canvas for lowest Windows DWM latency.
  useEffect(() => {
    const baked = bakedCanvasRef.current;
    const live = liveCanvasRef.current;
    if (!baked || !live) return;

    const resize = (): void => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = window.innerWidth;
      const h = window.innerHeight;
      for (const c of [baked, live]) {
        c.width = Math.round(w * dpr);
        c.height = Math.round(h * dpr);
        c.style.width = `${w}px`;
        c.style.height = `${h}px`;
      }
      const bCtx = baked.getContext('2d');
      if (bCtx) bCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const lCtx = live.getContext('2d', { desynchronized: true, alpha: true }) ?? live.getContext('2d');
      if (lCtx) lCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      liveCtxRef.current = lCtx;
      requestRender();
    };

    resize();
    window.addEventListener('resize', resize);
    baked.addEventListener('contextrestored', resize);
    live.addEventListener('contextrestored', resize);
    return () => {
      window.removeEventListener('resize', resize);
      baked.removeEventListener('contextrestored', resize);
      live.removeEventListener('contextrestored', resize);
    };
  }, []);

  // Draw-mode on/off comes from the main window (global hotkey, dock or recording pill) -
  // Dashboard.tsx flips this window's click-through state; this listener drives the toolbar's
  // visibility/cursor and optional initial tool here.
  useEffect(() => {
    const unlistenPromise = listen<{ active: boolean; tool?: 'ink' | 'blur' }>('annotation-mode-changed', (event) => {
      if (event.payload.active) {
        if (drawModeActiveRef.current && event.payload.tool) {
          setToolState(event.payload.tool);
          return;
        }
        const st = loadSettings();
        setInk({ color: st.annotationColor, width: st.annotationWidth, style: st.annotationStyle, fade: st.annotationFade, shadow: st.annotationShadow });
        setShowToolbar(st.annotationShowToolbar);
        setPointerCfg(readPointerConfig());
        setShieldCfg({
          strength: st.annotationBlurStrength,
          autoWhatsApp: st.annotationAutoBlurWhatsApp,
          autoText: st.annotationAutoBlurText,
        });
        setMenu(null);
        setToolState(event.payload.tool ?? 'ink');
      } else {
        // "Until I exit" strokes end with draw mode; fading ones get to finish.
        strokesRef.current = strokesRef.current.filter((st) => fadeTotalMs(st.style, st.fade) > 0);
        currentStrokeRef.current = null;
        livePrevMidRef.current = null;
        pressRef.current = null;
        clearLiveCanvas();
        pointerRef.current?.hide();
        setToolbarDrawing(false);
        setMenu(null);
        requestRender();
      }
      setDrawModeActive(event.payload.active);
    });
    const onSettings = (e: Event) => {
      const st = (e as CustomEvent<AppSettings>).detail ?? loadSettings();
      setPointerCfg({
        kind: st.annotationPointer,
        handStyle: st.annotationHandStyle,
        scale: st.annotationPointerScale,
        image: st.annotationPointerImage,
        ripple: st.annotationTapRipple,
        sound: st.annotationTapSound,
        volume: st.annotationSoundVolume,
      });
      setShieldCfg({
        strength: st.annotationBlurStrength,
        autoWhatsApp: st.annotationAutoBlurWhatsApp,
        autoText: st.annotationAutoBlurText,
      });
    };
    window.addEventListener(SETTINGS_CHANGED_DOM_EVENT, onSettings);
    return () => {
      window.removeEventListener(SETTINGS_CHANGED_DOM_EVENT, onSettings);
      unlistenPromise.then((fn) => fn());
    };
  }, []);

  // Esc is a second way out besides the toolbar's close button/the hotkey - both funnel through
  // the same request-to-Dashboard event (see handleRequestExit).
  useEffect(() => {
    if (!drawModeActive) return;

    const handleKeyDown = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        handleUndo();
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === 'escape') {
        void emit('annotation-turn-off-request');
      } else if ((key === 'backspace' || key === 'delete') && e.shiftKey) {
        blur.clear();
      } else if (key === 'backspace' || key === 'delete') {
        handleClear();
      } else if (key === 'b') {
        setTool((t) => (t === 'blur' ? 'ink' : 'blur'));
      } else if (/^[1-8]$/.test(key)) {
        const color = ANNOTATION_COLORS[Number(key) - 1];
        setInk((prev) => ({ ...prev, color }));
        setTool('ink');
      } else {
        const style = KEY_STYLES[key];
        if (style) {
          setInk((prev) => ({ ...prev, style }));
          setTool('ink');
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [drawModeActive]);

  const clearLiveCanvas = (): void => {
    const live = liveCanvasRef.current;
    const lCtx = liveCtxRef.current;
    if (!live || !lCtx) return;
    const dirty = liveDirtyRef.current;
    if (dirty) {
      const pad = 48;
      const x = Math.max(0, Math.floor(dirty.minX - pad));
      const y = Math.max(0, Math.floor(dirty.minY - pad));
      const w = Math.min(window.innerWidth - x, Math.ceil(dirty.maxX - x + pad));
      const h = Math.min(window.innerHeight - y, Math.ceil(dirty.maxY - y + pad));
      if (w > 0 && h > 0) lCtx.clearRect(x, y, w, h);
      liveDirtyRef.current = null;
    } else {
      lCtx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    }
  };

  const expandDirty = (x: number, y: number, pad: number): void => {
    const d = liveDirtyRef.current;
    if (!d) {
      liveDirtyRef.current = { minX: x - pad, minY: y - pad, maxX: x + pad, maxY: y + pad };
    } else {
      if (x - pad < d.minX) d.minX = x - pad;
      if (y - pad < d.minY) d.minY = y - pad;
      if (x + pad > d.maxX) d.maxX = x + pad;
      if (y + pad > d.maxY) d.maxY = y + pad;
    }
  };

  // Draws finished & fading strokes onto bakedCanvasRef on demand — NEVER invoked per mousemove
  // during active drawing, so live strokes never contend with full-screen redraws.
  const render = (): void => {
    rafRef.current = null;
    if (wakeTimerRef.current !== null) {
      window.clearTimeout(wakeTimerRef.current);
      wakeTimerRef.current = null;
    }
    const canvas = bakedCanvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    const now = performance.now();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    strokesRef.current = strokesRef.current.filter((st) => strokeOpacity(now - st.finishedAt, st.style, st.fade) > 0);
    let fadingOut = false;
    let nextFadeAt = Infinity;
    for (const stroke of strokesRef.current) {
      const opacity = strokeOpacity(now - stroke.finishedAt, stroke.style, stroke.fade);
      if (stroke.baked === undefined) stroke.baked = bakeAnnotationInk(stroke, dpr);
      const baked = stroke.baked;
      if (baked) {
        ctx.globalAlpha = opacity;
        ctx.drawImage(baked.image, baked.x, baked.y, baked.width, baked.height);
        ctx.globalAlpha = 1;
      } else {
        drawAnnotationInk(ctx, stroke, opacity);
      }
      if (fadeTotalMs(stroke.style, stroke.fade) === 0) continue;
      const fadeStart = stroke.finishedAt + fadeTiming(stroke.style, stroke.fade).hold;
      if (now >= fadeStart) fadingOut = true;
      else nextFadeAt = Math.min(nextFadeAt, fadeStart);
    }
    if (fadingOut) requestRender();
    else if (Number.isFinite(nextFadeAt)) wakeTimerRef.current = window.setTimeout(requestRender, Math.max(0, nextFadeAt - now));
  };
  const renderRef = useRef(render);
  renderRef.current = render;
  // Stable across renders (reads the latest render through renderRef), so effects and listeners
  // registered once can call it.
  const requestRender = useRef((): void => {
    if (rafRef.current === null) rafRef.current = requestAnimationFrame(() => renderRef.current());
  }).current;

  // Must also clear rafRef: StrictMode's mount -> unmount -> mount cancels the frame the resize
  // effect queued, and a stale non-null id left behind made requestRender think a frame was
  // always pending - so nothing was ever drawn again.
  useEffect(() => () => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    if (wakeTimerRef.current !== null) window.clearTimeout(wakeTimerRef.current);
    wakeTimerRef.current = null;
  }, []);

  // Real stylus pressure (0 for mouse/touch, normalized to 0.5 - perfect-freehand's own
  // simulatePressure kicks in, in drawAnnotationInk, when every point reports that default)
  // is captured per-point so getStroke can taper the outline along the whole stroke, the same way
  // PdfAnnotator's pen tool does.
  const getPoint = (e: React.PointerEvent<HTMLCanvasElement>): AnnotationStrokePoint => ({
    // clientX/Y: the canvas fills the window from (0,0), and coalesced events (handlePointerMove)
    // don't reliably carry offsetX/Y.
    x: e.clientX,
    y: e.clientY,
    pressure: e.pressure > 0 ? e.pressure : 0.5,
  });

  // Native low-latency pointer listener directly on liveCanvasRef (uses `pointerrawupdate` when
  // available on Windows WebView2/Chromium, falling back to `pointermove`). Bypasses React's
  // synthetic event dispatch and draws each incremental segment in O(1) with zero lag.
  useEffect(() => {
    const live = liveCanvasRef.current;
    if (!live) return;

    const onRawMove = (ev: PointerEvent): void => {
      if (!drawModeActiveRef.current) return;
      pointerRef.current?.move(ev.clientX, ev.clientY);
      const stroke = currentStrokeRef.current;
      if (!stroke) return;
      const press = pressRef.current;
      if (press && !press.moved && Math.hypot(ev.clientX - press.x, ev.clientY - press.y) > TAP_SLOP_PX) {
        press.moved = true;
      }

      const lCtx = liveCtxRef.current;
      const pad = Math.max(16, stroke.width * 3.5);

      if (ev.shiftKey) {
        const a = stroke.points[0];
        const dist = Math.hypot(ev.clientX - a.x, ev.clientY - a.y);
        const n = Math.max(2, Math.ceil(dist / 6));
        const line: AnnotationStrokePoint[] = [];
        for (let i = 0; i <= n; i++) {
          const t = i / n;
          line.push({ x: a.x + (ev.clientX - a.x) * t, y: a.y + (ev.clientY - a.y) * t, pressure: 0.5 });
        }
        stroke.points = line;
        clearLiveCanvas();
        if (lCtx) {
          drawLiveInkSegment(lCtx, a, { x: (a.x + ev.clientX) * 0.5, y: (a.y + ev.clientY) * 0.5 }, { x: ev.clientX, y: ev.clientY }, stroke, 0.5);
          expandDirty(a.x, a.y, pad);
          expandDirty(ev.clientX, ev.clientY, pad);
        }
        livePrevMidRef.current = { x: ev.clientX, y: ev.clientY };
        return;
      }

      const coalesced = ev.getCoalescedEvents?.() ?? [];
      const list = coalesced.length > 0 ? coalesced : [ev];
      for (const sample of list) {
        const pts = stroke.points;
        const last = pts[pts.length - 1];
        const pressure = sample.pressure > 0 ? sample.pressure : 0.5;
        const x = sample.clientX;
        const y = sample.clientY;
        if (!last) {
          pts.push({ x, y, pressure });
          livePrevMidRef.current = { x, y };
          expandDirty(x, y, pad);
          continue;
        }
        const dx = x - last.x;
        const dy = y - last.y;
        if (dx * dx + dy * dy < 1.44) continue;
        const mid = { x: (last.x + x) * 0.5, y: (last.y + y) * 0.5 };
        const from = livePrevMidRef.current ?? last;
        if (lCtx) drawLiveInkSegment(lCtx, from, last, mid, stroke, pressure);
        pts.push({ x, y, pressure });
        livePrevMidRef.current = mid;
        expandDirty(x, y, pad);
      }
    };

    const eventName = 'onpointerrawupdate' in window ? 'pointerrawupdate' : 'pointermove';
    live.addEventListener(eventName as 'pointermove', onRawMove, { passive: true });
    return () => {
      live.removeEventListener(eventName as 'pointermove', onRawMove);
    };
  }, []);

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    if (!drawModeActive) return;
    if (menu) setMenu(null);
    e.currentTarget.setPointerCapture(e.pointerId);
    const activeInk = inkRef.current;
    const pt = getPoint(e);
    currentStrokeRef.current = {
      points: [pt],
      ...activeInk,
      finishedAt: 0,
    };
    livePrevMidRef.current = { x: pt.x, y: pt.y };
    const pad = Math.max(16, activeInk.width * 3.5);
    liveDirtyRef.current = { minX: pt.x - pad, minY: pt.y - pad, maxX: pt.x + pad, maxY: pt.y + pad };
    // Draw immediate dot at touchdown so even quick taps feel instantaneous
    const lCtx = liveCtxRef.current;
    if (lCtx) {
      drawLiveInkSegment(lCtx, pt, pt, { x: pt.x + 0.01, y: pt.y + 0.01 }, activeInk, pt.pressure);
    }
    pressRef.current = { x: e.clientX, y: e.clientY, moved: false };
    pointerRef.current?.move(e.clientX, e.clientY);
    pointerRef.current?.setPressed(true);
    playTapSound(pointerCfgRef.current.sound, pointerCfgRef.current.volume);
    setToolbarDrawing(true);
  };

  const finishStroke = (e?: React.PointerEvent<HTMLCanvasElement>): void => {
    pointerRef.current?.setPressed(false);
    const press = pressRef.current;
    pressRef.current = null;
    setToolbarDrawing(false);
    const stroke = currentStrokeRef.current;
    if (!stroke) return;

    if (e) {
      const last = stroke.points[stroke.points.length - 1];
      if (last && Math.hypot(e.clientX - last.x, e.clientY - last.y) >= 0.5) {
        stroke.points.push({
          x: e.clientX,
          y: e.clientY,
          pressure: e.pressure > 0 ? e.pressure : 0.5,
        });
      }
    }

    // A cancel (e.g. the OS taking the pointer) isn't a tap, so no ring.
    if (e?.type === 'pointerup' && press && !press.moved) pointerRef.current?.tap(press.x, press.y);
    stroke.finishedAt = performance.now();
    strokesRef.current.push(stroke);
    currentStrokeRef.current = null;
    livePrevMidRef.current = null;
    clearLiveCanvas();
    requestRender();
  };

  const handleClear = (): void => {
    strokesRef.current = [];
    currentStrokeRef.current = null;
    livePrevMidRef.current = null;
    clearLiveCanvas();
    requestRender();
  };

  // Takes back the most recent stroke still on screen. Strokes that have already faded can't come
  // back - for a pointing tool that's the right call, since undo reaches only what you can see.
  const handleUndo = (): void => {
    if (currentStrokeRef.current) return;
    strokesRef.current.pop();
    requestRender();
  };

  const handleRequestExit = (): void => {
    void emit('annotation-turn-off-request');
  };

  // Manual drag, not `data-tauri-drag-region` - that drags the whole (screen-spanning) OS window,
  // not just this in-page toolbar.
  const handleToolbarDragStart = (e: React.MouseEvent): void => {
    // Still in its centred default: pin its current on-screen position as the drag's origin.
    const rect = toolbarRef.current?.getBoundingClientRect();
    const origin = toolbarPos ?? { x: rect?.left ?? 24, y: rect?.top ?? 24 };
    dragStateRef.current = {
      dragging: true,
      startX: e.clientX,
      startY: e.clientY,
      originX: origin.x,
      originY: origin.y,
    };

    const handleMove = (moveEvent: MouseEvent): void => {
      if (!dragStateRef.current.dragging) return;
      setToolbarPos({
        x: dragStateRef.current.originX + (moveEvent.clientX - dragStateRef.current.startX),
        y: dragStateRef.current.originY + (moveEvent.clientY - dragStateRef.current.startY),
      });
    };
    const handleUp = (): void => {
      dragStateRef.current.dragging = false;
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };

    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
  };

  return (
    <div className="relative w-screen h-screen overflow-hidden">
      <canvas ref={bakedCanvasRef} className="absolute inset-0 pointer-events-none" />
      <canvas
        ref={liveCanvasRef}
        className="absolute inset-0"
        // Marker uses uniform layer opacity so incremental segments don't darken where they overlap.
        style={{
          cursor: !drawModeActive ? 'default' : pointerKind === 'system' ? 'crosshair' : 'none',
          opacity: ink.style === 'marker' ? 0.42 : 1,
        }}
        onPointerDown={handlePointerDown}
        onPointerUp={finishStroke}
        onPointerCancel={finishStroke}
        onPointerLeave={() => {
          if (!currentStrokeRef.current) pointerRef.current?.hide();
        }}
      />

      {drawModeActive && (
        <ScreenBlurLayer
          regions={blur.regions}
          interactive={tool === 'blur'}
          onBegin={(id, mode, rect, pointer) => {
            setMenu(null);
            blur.begin(id, mode, rect, pointer);
          }}
          onTrack={blur.track}
          onEnd={blur.end}
          onRemove={blur.remove}
        />
      )}

      {/* Placing blur uses a plain crosshair - the hand would sit over the very thing being hidden. */}
      {drawModeActive && tool === 'ink' && (
        <AnnotationPointer
          ref={pointerRef}
          kind={pointerKind}
          handStyle={pointerCfg.handStyle}
          scale={pointerCfg.scale}
          color={ink.color}
          image={pointerCfg.image}
          ripple={pointerCfg.ripple}
        />
      )}

      {drawModeActive && showToolbar && (
        <div
          ref={toolbarRef}
          className="absolute flex items-center gap-2 px-3 py-2 rounded-2xl bg-neutral-900/90 backdrop-blur-md shadow-2xl ring-1 ring-white/10 transition-opacity duration-150"
          style={{
            ...(toolbarPos
              ? { left: toolbarPos.x, top: toolbarPos.y }
              : { left: '50%', bottom: 28, transform: 'translateX(-50%)' }),
          }}
          // The toolbar is a real cursor target - the hand steps aside while it's over it.
          onPointerEnter={() => pointerRef.current?.hide()}
        >
          <div
            onMouseDown={handleToolbarDragStart}
            className="w-3 h-6 flex flex-col justify-center gap-0.5 cursor-move mr-1"
            data-tip="Drag to move"
          >
            <div className="w-full h-0.5 bg-white/40 rounded" />
            <div className="w-full h-0.5 bg-white/40 rounded" />
            <div className="w-full h-0.5 bg-white/40 rounded" />
          </div>

          {ANNOTATION_STYLES.map((st) => (
            <button
              key={st.id}
              onClick={() => {
                setInk((prev) => ({ ...prev, style: st.id }));
                setTool('ink');
              }}
              data-tip={st.label}
              aria-label={st.label}
              aria-pressed={tool === 'ink' && ink.style === st.id}
              className={`w-7 h-7 flex items-center justify-center rounded-md transition-colors ${
                tool === 'ink' && ink.style === st.id ? 'bg-white/20 text-white' : 'text-white/60 hover:text-white hover:bg-white/10'
              }`}
            >
              {STYLE_ICONS[st.id]}
            </button>
          ))}

          <button
            onClick={() => setTool((t) => (t === 'blur' ? 'ink' : 'blur'))}
            data-tip="Privacy Shield - drag to blur anything private. You can still click and type underneath."
            data-tip-kbd="B"
            aria-label="Privacy Shield"
            aria-pressed={tool === 'blur'}
            className={`relative w-7 h-7 flex items-center justify-center rounded-md transition-colors ${
              tool === 'blur'
                ? 'bg-sky-500/30 text-sky-300 ring-1 ring-sky-400/50'
                : blur.count > 0 || shieldCfg.autoWhatsApp !== 'off' || shieldCfg.autoText !== 'off'
                ? 'text-emerald-300 hover:text-emerald-200 hover:bg-white/10'
                : 'text-white/60 hover:text-white hover:bg-white/10'
            }`}
          >
            <IoShieldCheckmarkOutline size={15} />
            {blur.count > 0 && (
              <span className="absolute -top-1 -right-1 min-w-[14px] h-[14px] px-0.5 rounded-full bg-sky-500 text-[9px] font-semibold leading-[14px] text-white text-center">
                {blur.count}
              </span>
            )}
          </button>
          {tool === 'blur' && blur.count > 0 && (
            <button
              onClick={blur.clear}
              data-tip="Remove every blur"
              data-tip-kbd="Shift+Backspace"
              className="px-2 h-7 rounded-md text-xs font-medium text-white/75 hover:text-white hover:bg-white/10 whitespace-nowrap"
            >
              Unblur all
            </button>
          )}

          <div className="w-px h-5 bg-white/20 mx-1" />

          {/* The palette, plus Settings' custom colour when it isn't one of them. */}
          <div className={`flex items-end ${pointerKind === 'hand' ? 'gap-1' : 'gap-2'}`}>
            {(ANNOTATION_COLORS.includes(ink.color.toLowerCase()) ? ANNOTATION_COLORS : [...ANNOTATION_COLORS, ink.color]).map((color) => {
              const selected = ink.color.toLowerCase() === color.toLowerCase();
              if (pointerKind === 'hand') {
                return (
                  <button
                    key={color}
                    onClick={() => {
                      setInk((prev) => ({ ...prev, color }));
                      setTool('ink');
                    }}
                    aria-label={`Hand color ${color}`}
                    aria-pressed={selected}
                    className={`relative h-8 flex items-end justify-center transition-transform duration-150 hover:-translate-y-0.5 ${
                      pointerCfg.handStyle === 'stylus' ? 'w-5' : 'w-[26px]'
                    }`}
                  >
                    <span
                      className="block origin-bottom"
                      style={{
                        transform: selected ? 'translateY(-6px) scale(1.12)' : 'translateY(3px) scale(0.95)',
                        transition: 'transform 180ms cubic-bezier(0.3, 1.5, 0.5, 1)',
                      }}
                    >
                      <HandSwatchGraphic color={color} handStyle={pointerCfg.handStyle} />
                    </span>
                  </button>
                );
              }
              return (
                <button
                  key={color}
                  onClick={() => {
                    setInk((prev) => ({ ...prev, color }));
                    setTool('ink');
                  }}
                  aria-label={`Color ${color}`}
                  aria-pressed={selected}
                  className="relative h-8 w-4 flex items-end justify-center"
                >
                  {/* A little pen, colour-coded: the chosen one is lifted out of the tray. */}
                  <span
                    className="block w-3 rounded-t-full rounded-b-[2px] ring-1 ring-black/40 shadow-md"
                    style={{
                      height: 26,
                      backgroundColor: color,
                      backgroundImage: 'linear-gradient(90deg, rgba(255,255,255,0.35), rgba(255,255,255,0) 45%, rgba(0,0,0,0.25))',
                      transform: `translateY(${selected ? -7 : 4}px)`,
                      transition: 'transform 180ms cubic-bezier(0.3, 1.5, 0.5, 1)',
                    }}
                  />
                </button>
              );
            })}
          </div>

          <div className="w-px h-5 bg-white/20 mx-1" />

          {/* Pointer and tap-sound pickers. Like colour and style, a pick here lasts for this
              session; Settings > Annotation holds the defaults. */}
          {(['pointer', 'sound'] as const).map((kind) => {
            const open = menu === kind;
            const options: { id: string; label: string; disabled?: boolean }[] =
              kind === 'pointer'
                ? ANNOTATION_POINTERS.map((p) => ({ ...p, disabled: p.id === 'custom' && !pointerCfg.image }))
                : ANNOTATION_TAP_SOUNDS;
            const current = kind === 'pointer' ? pointerCfg.kind : pointerCfg.sound;
            return (
              <div key={kind} className="relative">
                <button
                  onClick={() => setMenu(open ? null : kind)}
                  aria-label={kind === 'pointer' ? 'Pointer type' : 'Tap sound'}
                  aria-expanded={open}
                  data-tip={kind === 'pointer' ? 'Pointer type' : 'Tap sound'}
                  className={`w-7 h-7 flex items-center justify-center rounded-md transition-colors ${
                    open ? 'bg-white/20 text-white' : 'text-white/70 hover:text-white hover:bg-white/10'
                  }`}
                >
                  {kind === 'pointer' ? POINTER_ICONS[pointerKind] : pointerCfg.sound === 'off' ? <IoVolumeMute size={15} /> : <IoVolumeHigh size={15} />}
                </button>
                {open && (
                  <div
                    className={`absolute left-1/2 -translate-x-1/2 flex flex-col p-1 min-w-[7.5rem] rounded-xl bg-neutral-900/95 backdrop-blur-md shadow-2xl ring-1 ring-white/10 ${
                      toolbarPos && toolbarPos.y < 220 ? 'top-full mt-3' : 'bottom-full mb-3'
                    }`}
                  >
                    {options.map((o) => (
                      <button
                        key={o.id}
                        disabled={o.disabled}
                        onClick={() => {
                          if (kind === 'pointer') {
                            setPointerCfg((prev) => ({ ...prev, kind: o.id as PointerKind }));
                          } else {
                            setPointerCfg((prev) => ({ ...prev, sound: o.id as AnnotationTapSound }));
                            // Audition it, like Settings does.
                            playTapSound(o.id as AnnotationTapSound, pointerCfg.volume);
                          }
                          setMenu(null);
                        }}
                        data-tip={o.disabled ? 'Upload an image in Settings > Annotate & Shield' : undefined}
                        className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs text-left transition-colors disabled:opacity-35 ${
                          current === o.id ? 'bg-white/20 text-white' : 'text-white/75 hover:text-white hover:bg-white/10'
                        }`}
                      >
                        {kind === 'pointer' && <span className="w-4 flex justify-center">{POINTER_ICONS[o.id as PointerKind]}</span>}
                        {o.label}
                      </button>
                    ))}
                    {kind === 'pointer' && pointerCfg.kind === 'hand' && (
                      <div className="mt-1 pt-1 border-t border-white/10 flex flex-col gap-0.5">
                        <span className="px-2 py-0.5 text-[9.5px] font-semibold uppercase tracking-wider text-white/40">Hand style</span>
                        {ANNOTATION_HAND_STYLES.map((hs) => (
                          <button
                            key={hs.id}
                            onClick={() => {
                              setPointerCfg((prev) => ({ ...prev, handStyle: hs.id }));
                              updateSettings({ annotationHandStyle: hs.id });
                              setMenu(null);
                            }}
                            className={`px-2.5 py-1 rounded-lg text-[11px] text-left transition-colors ${
                              pointerCfg.handStyle === hs.id ? 'bg-blue-500/30 text-blue-200' : 'text-white/70 hover:text-white hover:bg-white/10'
                            }`}
                          >
                            {hs.label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}

          <div className="relative">
            <button
              onClick={() => setMenu(menu === 'options' ? null : 'options')}
              aria-label="Ink & Privacy Shield options"
              aria-expanded={menu === 'options'}
              data-tip="Ink size, fade & Privacy Shield"
              className={`w-7 h-7 flex items-center justify-center rounded-md transition-colors ${
                menu === 'options' ? 'bg-white/20 text-white' : 'text-white/70 hover:text-white hover:bg-white/10'
              }`}
            >
              <IoOptionsOutline size={15} />
            </button>
            {menu === 'options' && (
              <div
                className={`absolute right-0 w-72 p-3 rounded-2xl bg-neutral-900/95 backdrop-blur-md shadow-2xl ring-1 ring-white/12 text-white space-y-3 ${
                  toolbarPos && toolbarPos.y < 360 ? 'top-full mt-3' : 'bottom-full mb-3'
                }`}
              >
                <div className="space-y-2.5">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-white/45">Ink</span>
                    <button
                      type="button"
                      onClick={() => {
                        const nextShadow = !ink.shadow;
                        setInk((prev) => ({ ...prev, shadow: nextShadow }));
                        updateSettings({ annotationShadow: nextShadow });
                      }}
                      className={`px-2 py-0.5 rounded-md text-[11px] font-medium transition-colors ${
                        ink.shadow ? 'bg-white/20 text-white' : 'text-white/55 hover:text-white hover:bg-white/10'
                      }`}
                    >
                      Shadow {ink.shadow ? 'On' : 'Off'}
                    </button>
                  </div>

                  <div className="flex items-center gap-2.5">
                    <span className="text-xs text-white/75 w-10">Size</span>
                    <input
                      type="range"
                      min={2}
                      max={20}
                      step={1}
                      value={ink.width}
                      onChange={(e) => {
                        const width = Number(e.target.value);
                        setInk((prev) => ({ ...prev, width }));
                        updateSettings({ annotationWidth: width });
                      }}
                      className="flex-1 accent-blue-400 cursor-pointer"
                    />
                    <span className="text-[11px] font-mono tabular-nums text-white/60 w-5 text-right">{ink.width}</span>
                  </div>

                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-white/75">Fade</span>
                    <div className="flex p-0.5 gap-0.5 rounded-lg bg-white/8">
                      {ANNOTATION_FADES.map((f) => (
                        <button
                          key={f.id}
                          type="button"
                          onClick={() => {
                            setInk((prev) => ({ ...prev, fade: f.id }));
                            updateSettings({ annotationFade: f.id });
                          }}
                          className={`px-1.5 py-0.5 rounded-md text-[11px] font-medium transition-colors ${
                            ink.fade === f.id ? 'bg-white/20 text-white' : 'text-white/55 hover:text-white'
                          }`}
                        >
                          {f.id === 'never' ? 'Stay' : f.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="border-t border-white/10 pt-2.5 space-y-2.5">
                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-300/90">
                      <IoShieldCheckmarkOutline size={12} /> Privacy Shield
                    </span>
                    {blur.count > 0 && (
                      <button
                        type="button"
                        onClick={blur.clear}
                        className="text-[11px] font-medium text-sky-300 hover:text-sky-200 hover:underline"
                      >
                        Unblur all ({blur.count})
                      </button>
                    )}
                  </div>

                  <div className="flex items-center gap-2.5">
                    <span className="text-xs text-white/75 w-14">Blur</span>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      step={5}
                      value={shieldCfg.strength}
                      onChange={(e) => {
                        const strength = Number(e.target.value);
                        setShieldCfg((prev) => ({ ...prev, strength }));
                        updateSettings({ annotationBlurStrength: strength });
                        void invoke('screen_blur_configure', { config: { strength } }).catch(() => {});
                      }}
                      className="flex-1 accent-sky-400 cursor-pointer"
                    />
                    <span className="text-[11px] font-mono tabular-nums text-white/60 w-6 text-right">{shieldCfg.strength}</span>
                  </div>

                  {(
                    [
                      ['WhatsApp', 'autoWhatsApp', 'annotationAutoBlurWhatsApp'] as const,
                      ['Sensitive text', 'autoText', 'annotationAutoBlurText'] as const,
                    ]
                  ).map(([label, localKey, settingKey]) => (
                    <div key={localKey} className="flex items-center justify-between gap-2">
                      <span className="text-xs text-white/75">{label}</span>
                      <div className="flex p-0.5 gap-0.5 rounded-lg bg-white/8">
                        {(
                          [
                            ['off', 'Off'],
                            ['recording', 'Rec'],
                            ['always', 'Always'],
                          ] as [AutoBlurMode, string][]
                        ).map(([mode, modeLabel]) => (
                          <button
                            key={mode}
                            type="button"
                            onClick={() => {
                              setShieldCfg((prev) => ({ ...prev, [localKey]: mode }));
                              updateSettings({ [settingKey]: mode });
                            }}
                            className={`px-1.5 py-0.5 rounded-md text-[11px] font-medium transition-colors ${
                              shieldCfg[localKey] === mode
                                ? mode === 'off'
                                  ? 'bg-white/20 text-white'
                                  : 'bg-emerald-500/30 text-emerald-200'
                                : 'text-white/55 hover:text-white'
                            }`}
                          >
                            {modeLabel}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}

                  <div className="flex items-center justify-between text-[11px] text-white/50 pt-0.5">
                    <span>Blur active window anywhere</span>
                    <kbd className="px-1.5 py-0.5 rounded bg-white/10 font-mono text-[10px] text-white/80">Ctrl+Alt+B</kbd>
                  </div>
                </div>

                <div className="border-t border-white/10 pt-2">
                  <button
                    type="button"
                    onClick={() => {
                      setMenu(null);
                      void emit('open-settings-request', { section: 'annotation' });
                    }}
                    className="w-full flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-white/8 hover:bg-white/15 text-xs font-medium text-white/85 hover:text-white transition-colors"
                  >
                    <IoSettingsOutline size={13} />
                    All Annotate &amp; Privacy Shield settings…
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="w-px h-5 bg-white/20 mx-1" />

          <button
            onClick={handleUndo}
            className="p-1.5 rounded-md text-white/70 hover:text-white hover:bg-white/10"
            data-tip="Undo last stroke"
            data-tip-kbd="Ctrl+Z"
            aria-label="Undo last stroke"
          >
            <IoArrowUndo size={15} />
          </button>

          <button
            onClick={handleClear}
            className="p-1.5 rounded-md text-white/70 hover:text-white hover:bg-white/10"
            data-tip="Clear all strokes"
            data-tip-kbd="Backspace"
            aria-label="Clear all strokes"
          >
            <IoTrashOutline size={15} />
          </button>

          <button
            onClick={handleRequestExit}
            className="p-1 rounded-md text-white/70 hover:text-white hover:bg-white/10"
            data-tip="Exit draw mode"
            data-tip-kbd="Esc"
            aria-label="Exit draw mode"
          >
            <IoClose size={16} />
          </button>
        </div>
      )}
    </div>
  );
};

export default AnnotationOverlayWindow;
