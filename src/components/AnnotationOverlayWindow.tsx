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
import { listen, emit } from '@tauri-apps/api/event';
import { IoClose, IoPencil, IoSparkles, IoFlash, IoArrowUndo, IoTrashOutline, IoHandLeft, IoEllipse, IoAdd, IoImage, IoVolumeHigh, IoVolumeMute, IoEyeOff } from 'react-icons/io5';
import { BsHighlighter } from 'react-icons/bs';
import { loadSettings } from '../utils/appSettings';
import AnnotationPointer, { AnnotationPointerHandle, resolvePointer } from './AnnotationPointer';
import ScreenBlurLayer from './ScreenBlurLayer';
import useScreenBlur from '../hooks/useScreenBlur';
import { playTapSound } from '../utils/annotationSound';
import {
  ANNOTATION_COLORS,
  ANNOTATION_POINTERS,
  ANNOTATION_STYLES,
  ANNOTATION_TAP_SOUNDS,
  AnnotationFade,
  AnnotationInk,
  AnnotationPointer as PointerKind,
  AnnotationStrokePoint,
  AnnotationStyle,
  AnnotationTapSound,
  bakeAnnotationInk,
  BakedInk,
  drawAnnotationInk,
  fadeTiming,
  fadeTotalMs,
  strokeOpacity,
} from '../utils/annotationStyles';

// Settings > Annotation's pointer/tap options, re-read each time draw mode turns on like the ink.
interface PointerConfig {
  kind: PointerKind;
  image: string;
  ripple: boolean;
  sound: AnnotationTapSound;
  volume: number;
}

const readPointerConfig = (): PointerConfig => {
  const st = loadSettings();
  return {
    kind: st.annotationPointer,
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

// A predicted pointer position further than this from the real one is a bad guess (a flick, a
// sudden stop) and is ignored.
const MAX_PREDICTION_PX = 48;

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
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const strokesRef = useRef<Stroke[]>([]);
  const currentStrokeRef = useRef<Stroke | null>(null);
  // Where the pointer is about to be (PointerEvent.getPredictedEvents) - drawn as the live
  // stroke's last stretch, never stored in it, so the ink's tip keeps up with the hand.
  const predictedTailRef = useRef<AnnotationStrokePoint[]>([]);
  const rafRef = useRef<number | null>(null);
  const wakeTimerRef = useRef<number | null>(null);

  const [drawModeActive, setDrawModeActive] = useState(false);
  // Seeded from Settings > Annotation every time draw mode turns on (see the listener below);
  // the toolbar can change colour/style for the rest of that session.
  const [ink, setInk] = useState(() => {
    const st = loadSettings();
    return { color: st.annotationColor, width: st.annotationWidth, style: st.annotationStyle, fade: st.annotationFade, shadow: st.annotationShadow };
  });
  const [showToolbar, setShowToolbar] = useState(() => loadSettings().annotationShowToolbar);
  const [pointerCfg, setPointerCfg] = useState<PointerConfig>(readPointerConfig);
  // Null until the toolbar is dragged: it sits bottom-centre, where it's out of the way of the
  // slide's content but still close to hand.
  const [toolbarPos, setToolbarPos] = useState<{ x: number; y: number } | null>(null);
  // The toolbar gets out of the way (fades, stops catching the mouse) while a stroke is in progress.
  const [drawing, setDrawing] = useState(false);
  // Which toolbar popover (pointer / tap sound picker) is open.
  const [menu, setMenu] = useState<'pointer' | 'sound' | null>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const pointerRef = useRef<AnnotationPointerHandle>(null);
  const pressRef = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const pointerKind = resolvePointer(pointerCfg.kind, pointerCfg.image);
  // "blur" swaps drawing for placing privacy blur regions (B). Regions outlive draw mode - they're
  // native windows (services/screen_blur.rs) that stay up, click-through, until removed.
  const [tool, setTool] = useState<'ink' | 'blur'>('ink');
  const blur = useScreenBlur(drawModeActive);
  const dragStateRef = useRef({ dragging: false, startX: 0, startY: 0, originX: 0, originY: 0 });

  // Sizes the canvas's backing store to the window's real pixel dimensions (HiDPI-sharp) - the
  // window itself is only ever resized once, at creation, but this also covers first mount.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const resize = (): void => {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = window.innerWidth * dpr;
      canvas.height = window.innerHeight * dpr;
      canvas.style.width = `${window.innerWidth}px`;
      canvas.style.height = `${window.innerHeight}px`;
      const ctx = canvas.getContext('2d');
      if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      requestRender();
    };

    resize();
    window.addEventListener('resize', resize);
    // A context restored after a GPU reset comes back blank and without the DPR transform -
    // resize() puts both back.
    canvas.addEventListener('contextrestored', resize);
    return () => {
      window.removeEventListener('resize', resize);
      canvas.removeEventListener('contextrestored', resize);
    };
  }, []);

  // Draw-mode on/off comes from the main window (global hotkey) - Dashboard.tsx is the one that
  // actually flips this window's click-through state on the window handle; this listener just
  // drives the toolbar's visibility/cursor here.
  useEffect(() => {
    const unlistenPromise = listen<{ active: boolean }>('annotation-mode-changed', (event) => {
      if (event.payload.active) {
        const st = loadSettings();
        setInk({ color: st.annotationColor, width: st.annotationWidth, style: st.annotationStyle, fade: st.annotationFade, shadow: st.annotationShadow });
        setShowToolbar(st.annotationShowToolbar);
        setPointerCfg(readPointerConfig());
        setTool('ink');
      } else {
        // "Until I exit" strokes end with draw mode; fading ones get to finish.
        strokesRef.current = strokesRef.current.filter((st) => fadeTotalMs(st.style, st.fade) > 0);
        currentStrokeRef.current = null;
        pressRef.current = null;
        pointerRef.current?.hide();
        setDrawing(false);
        requestRender();
      }
      setDrawModeActive(event.payload.active);
    });
    return () => {
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

  // Draws on demand rather than in a perpetual loop: a frame is requested by pointer input, Clear
  // and resizes, and frames keep coming only while some stroke is actually fading out. A stroke
  // holding at full opacity looks the same every frame, so its hold is waited out on a timer
  // rather than redrawn ~60 times a second - those redraws used to compete with the stroke being
  // drawn right then. So an idle overlay - hidden, empty, or holding only "Until I exit" strokes -
  // costs no CPU/GPU at all, which matters while recording or presenting alongside heavier apps.
  //
  // Finished strokes are bitmaps (bakeAnnotationInk) - one drawImage each, whatever their glow -
  // and only the stroke under the pen is traced live.
  const render = (): void => {
    rafRef.current = null;
    if (wakeTimerRef.current !== null) {
      window.clearTimeout(wakeTimerRef.current);
      wakeTimerRef.current = null;
    }
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    // clearRect in CSS pixels under the DPR transform (see the resize effect) - covers the canvas.
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const now = performance.now();
    const dpr = window.devicePixelRatio || 1;
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
    const current = currentStrokeRef.current;
    if (current) {
      const tail = predictedTailRef.current;
      drawAnnotationInk(ctx, tail.length > 0 ? { ...current, points: current.points.concat(tail) } : current, 1);
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

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    // Guards against a stray event landing here during the brief async round-trip of the
    // click-through toggle - in the steady state, ignoreCursorEvents already stops these from
    // reaching the canvas at all while draw mode is off.
    if (!drawModeActive) return;
    setMenu(null);
    e.currentTarget.setPointerCapture(e.pointerId);
    currentStrokeRef.current = {
      points: [getPoint(e)],
      ...ink,
      finishedAt: 0,
    };
    pressRef.current = { x: e.clientX, y: e.clientY, moved: false };
    pointerRef.current?.move(e.clientX, e.clientY);
    pointerRef.current?.setPressed(true);
    playTapSound(pointerCfg.sound, pointerCfg.volume);
    setDrawing(true);
    requestRender();
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    // Hovering counts too: the hand follows the cursor whether or not a stroke is in progress -
    // drawn where the pointer is about to be rather than where it was, which is what makes it feel
    // stuck to the cursor instead of chasing it a frame or two behind.
    const predicted = (e.nativeEvent.getPredictedEvents?.() ?? []).filter(
      (ev) => Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) <= MAX_PREDICTION_PX
    );
    const lead = predicted.length > 0 ? predicted[predicted.length - 1] : e;
    pointerRef.current?.move(lead.clientX, lead.clientY);
    const stroke = currentStrokeRef.current;
    if (!stroke) return;
    predictedTailRef.current = e.shiftKey
      ? []
      : predicted.map((ev) => ({ x: ev.clientX, y: ev.clientY, pressure: ev.pressure > 0 ? ev.pressure : 0.5 }));
    const press = pressRef.current;
    if (press && !press.moved && Math.hypot(e.clientX - press.x, e.clientY - press.y) > TAP_SLOP_PX) press.moved = true;

    if (e.shiftKey) {
      // Holding Shift snaps the stroke to a straight line from where it began - evenly spaced
      // samples so perfect-freehand renders it as one clean, steady line.
      const a = stroke.points[0];
      const dist = Math.hypot(e.clientX - a.x, e.clientY - a.y);
      const n = Math.max(2, Math.ceil(dist / 6));
      const line: AnnotationStrokePoint[] = [];
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        line.push({ x: a.x + (e.clientX - a.x) * t, y: a.y + (e.clientY - a.y) * t, pressure: 0.5 });
      }
      stroke.points = line;
      requestRender();
      return;
    }

    // Coalesced events: a stylus reports far more often than the screen refreshes.
    const coalesced = e.nativeEvent.getCoalescedEvents?.() ?? [];
    for (const ev of coalesced.length > 0 ? coalesced : [e.nativeEvent]) {
      stroke.points.push({
        x: ev.clientX,
        y: ev.clientY,
        pressure: ev.pressure > 0 ? ev.pressure : 0.5,
      });
    }
    requestRender();
  };

  const finishStroke = (e?: React.PointerEvent<HTMLCanvasElement>): void => {
    pointerRef.current?.setPressed(false);
    const press = pressRef.current;
    pressRef.current = null;
    predictedTailRef.current = [];
    setDrawing(false);
    if (!currentStrokeRef.current) return;
    // A cancel (e.g. the OS taking the pointer) isn't a tap, so no ring.
    if (e?.type === 'pointerup' && press && !press.moved) pointerRef.current?.tap(press.x, press.y);
    currentStrokeRef.current.finishedAt = performance.now();
    strokesRef.current.push(currentStrokeRef.current);
    currentStrokeRef.current = null;
    requestRender();
  };

  const handleClear = (): void => {
    strokesRef.current = [];
    currentStrokeRef.current = null;
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
      <canvas
        ref={canvasRef}
        className="absolute inset-0"
        // The hand/dot/custom pointer replaces the cursor entirely; "crosshair" keeps the system one.
        style={{ cursor: !drawModeActive ? 'default' : pointerKind === 'system' ? 'crosshair' : 'none' }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
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
          onBegin={blur.begin}
          onTrack={blur.track}
          onEnd={blur.end}
          onRemove={blur.remove}
        />
      )}

      {/* Placing blur uses a plain crosshair - the hand would sit over the very thing being hidden. */}
      {drawModeActive && tool === 'ink' && (
        <AnnotationPointer ref={pointerRef} kind={pointerKind} color={ink.color} image={pointerCfg.image} ripple={pointerCfg.ripple} />
      )}

      {drawModeActive && showToolbar && (
        <div
          ref={toolbarRef}
          className="absolute flex items-center gap-2 px-3 py-2 rounded-2xl bg-neutral-900/90 backdrop-blur-md shadow-2xl ring-1 ring-white/10 transition-opacity duration-200"
          style={{
            ...(toolbarPos
              ? { left: toolbarPos.x, top: toolbarPos.y }
              : { left: '50%', bottom: 28, transform: 'translateX(-50%)' }),
            opacity: drawing ? 0.12 : 1,
            pointerEvents: drawing ? 'none' : 'auto',
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
            data-tip="Blur - drag over anything private. You can still type underneath."
            data-tip-kbd="B"
            aria-label="Blur"
            aria-pressed={tool === 'blur'}
            className={`relative w-7 h-7 flex items-center justify-center rounded-md transition-colors ${
              tool === 'blur' ? 'bg-white/20 text-white' : 'text-white/60 hover:text-white hover:bg-white/10'
            }`}
          >
            <IoEyeOff size={15} />
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
          {(ANNOTATION_COLORS.includes(ink.color.toLowerCase()) ? ANNOTATION_COLORS : [...ANNOTATION_COLORS, ink.color]).map((color) => (
            <button
              key={color}
              onClick={() => {
                setInk((prev) => ({ ...prev, color }));
                setTool('ink');
              }}
              aria-label={`Color ${color}`}
              aria-pressed={ink.color.toLowerCase() === color.toLowerCase()}
              className="relative h-8 w-4 flex items-end justify-center"
            >
              {/* A little pen, colour-coded: the chosen one is lifted out of the tray. */}
              <span
                className="block w-3 rounded-t-full rounded-b-[2px] ring-1 ring-black/40 shadow-md"
                style={{
                  height: 26,
                  backgroundColor: color,
                  backgroundImage: 'linear-gradient(90deg, rgba(255,255,255,0.35), rgba(255,255,255,0) 45%, rgba(0,0,0,0.25))',
                  transform: `translateY(${ink.color.toLowerCase() === color.toLowerCase() ? -7 : 4}px)`,
                  transition: 'transform 180ms cubic-bezier(0.3, 1.5, 0.5, 1)',
                }}
              />
            </button>
          ))}

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
                        data-tip={o.disabled ? 'Upload an image in Settings > Annotation' : undefined}
                        className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs text-left transition-colors disabled:opacity-35 ${
                          current === o.id ? 'bg-white/20 text-white' : 'text-white/75 hover:text-white hover:bg-white/10'
                        }`}
                      >
                        {kind === 'pointer' && <span className="w-4 flex justify-center">{POINTER_ICONS[o.id as PointerKind]}</span>}
                        {o.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}

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
