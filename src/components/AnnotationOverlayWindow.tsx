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
import { IoClose, IoPencil, IoSparkles, IoFlash } from 'react-icons/io5';
import { BsHighlighter } from 'react-icons/bs';
import { loadSettings } from '../utils/appSettings';
import {
  ANNOTATION_COLORS,
  ANNOTATION_STYLES,
  AnnotationFade,
  AnnotationInk,
  AnnotationStrokePoint,
  AnnotationStyle,
  drawAnnotationInk,
  fadeTotalMs,
  strokeOpacity,
} from '../utils/annotationStyles';

interface Stroke extends AnnotationInk {
  // Captured per stroke, so switching style/fade mid-presentation doesn't restyle what's already
  // on screen.
  fade: AnnotationFade;
  // performance.now() timestamp of pointerup, i.e. when the fade countdown starts - 0 while the
  // stroke is still being drawn.
  finishedAt: number;
}

const STYLE_ICONS: Record<AnnotationStyle, React.ReactNode> = {
  pen: <IoPencil size={14} />,
  marker: <BsHighlighter size={13} />,
  neon: <IoSparkles size={14} />,
  laser: <IoFlash size={14} />,
};

// Style shortcuts in the overlay (with 1-8 for the palette, Backspace to clear, Esc to exit) -
// the whole toolbar from the keyboard, for when it's hidden.
const KEY_STYLES: Record<string, AnnotationStyle> = { p: 'pen', m: 'marker', n: 'neon', l: 'laser' };

const AnnotationOverlayWindow = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const strokesRef = useRef<Stroke[]>([]);
  const currentStrokeRef = useRef<Stroke | null>(null);
  const rafRef = useRef<number | null>(null);

  const [drawModeActive, setDrawModeActive] = useState(false);
  // Seeded from Settings > Annotation every time draw mode turns on (see the listener below);
  // the toolbar can change colour/style for the rest of that session.
  const [ink, setInk] = useState(() => {
    const st = loadSettings();
    return { color: st.annotationColor, width: st.annotationWidth, style: st.annotationStyle, fade: st.annotationFade, shadow: st.annotationShadow };
  });
  const [showToolbar, setShowToolbar] = useState(() => loadSettings().annotationShowToolbar);
  const [toolbarPos, setToolbarPos] = useState({ x: 24, y: 24 });
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
      } else {
        // "Until I exit" strokes end with draw mode; fading ones get to finish.
        strokesRef.current = strokesRef.current.filter((st) => fadeTotalMs(st.style, st.fade) > 0);
        currentStrokeRef.current = null;
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
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === 'escape') {
        void emit('annotation-turn-off-request');
      } else if (key === 'backspace' || key === 'delete') {
        handleClear();
      } else if (/^[1-8]$/.test(key)) {
        const color = ANNOTATION_COLORS[Number(key) - 1];
        setInk((prev) => ({ ...prev, color }));
      } else {
        const style = KEY_STYLES[key];
        if (style) setInk((prev) => ({ ...prev, style }));
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [drawModeActive]);

  // Draws on demand rather than in a perpetual loop: a frame is requested by pointer input, Clear
  // and resizes, and the loop only keeps itself going while some stroke is still on its way out.
  // So an idle overlay - hidden, empty, or holding only "Until I exit" strokes - costs no CPU/GPU
  // at all, which matters while recording or presenting alongside heavier apps.
  const render = (): void => {
    rafRef.current = null;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    // clearRect in CSS pixels under the DPR transform (see the resize effect) - covers the canvas.
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const now = performance.now();
    strokesRef.current = strokesRef.current.filter((st) => strokeOpacity(now - st.finishedAt, st.style, st.fade) > 0);
    let fading = false;
    for (const stroke of strokesRef.current) {
      drawAnnotationInk(ctx, stroke, strokeOpacity(now - stroke.finishedAt, stroke.style, stroke.fade));
      if (fadeTotalMs(stroke.style, stroke.fade) > 0) fading = true;
    }
    if (currentStrokeRef.current) {
      drawAnnotationInk(ctx, currentStrokeRef.current, 1);
    }
    if (fading) requestRender();
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
    e.currentTarget.setPointerCapture(e.pointerId);
    currentStrokeRef.current = {
      points: [getPoint(e)],
      ...ink,
      finishedAt: 0,
    };
    requestRender();
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    if (!currentStrokeRef.current) return;
    // Coalesced events: a stylus reports far more often than the screen refreshes.
    const coalesced = e.nativeEvent.getCoalescedEvents?.() ?? [];
    for (const ev of coalesced.length > 0 ? coalesced : [e.nativeEvent]) {
      currentStrokeRef.current.points.push({
        x: ev.clientX,
        y: ev.clientY,
        pressure: ev.pressure > 0 ? ev.pressure : 0.5,
      });
    }
    requestRender();
  };

  const finishStroke = (): void => {
    if (!currentStrokeRef.current) return;
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

  const handleRequestExit = (): void => {
    void emit('annotation-turn-off-request');
  };

  // Manual drag, not `data-tauri-drag-region` - that drags the whole (screen-spanning) OS window,
  // not just this in-page toolbar.
  const handleToolbarDragStart = (e: React.MouseEvent): void => {
    dragStateRef.current = {
      dragging: true,
      startX: e.clientX,
      startY: e.clientY,
      originX: toolbarPos.x,
      originY: toolbarPos.y,
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
        style={{ cursor: drawModeActive ? 'crosshair' : 'default' }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishStroke}
        onPointerCancel={finishStroke}
      />

      {drawModeActive && showToolbar && (
        <div
          className="absolute flex items-center gap-2 px-2.5 py-2 rounded-xl bg-neutral-900/90 shadow-lg ring-1 ring-white/10"
          style={{ left: toolbarPos.x, top: toolbarPos.y }}
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
              onClick={() => setInk((prev) => ({ ...prev, style: st.id }))}
              data-tip={st.label}
              aria-label={st.label}
              aria-pressed={ink.style === st.id}
              className={`w-7 h-7 flex items-center justify-center rounded-md transition-colors ${
                ink.style === st.id ? 'bg-white/20 text-white' : 'text-white/60 hover:text-white hover:bg-white/10'
              }`}
            >
              {STYLE_ICONS[st.id]}
            </button>
          ))}

          <div className="w-px h-5 bg-white/20 mx-1" />

          {/* The palette, plus Settings' custom colour when it isn't one of them. */}
          {(ANNOTATION_COLORS.includes(ink.color.toLowerCase()) ? ANNOTATION_COLORS : [...ANNOTATION_COLORS, ink.color]).map((color) => (
            <button
              key={color}
              onClick={() => setInk((prev) => ({ ...prev, color }))}
              aria-label={`Color ${color}`}
              aria-pressed={ink.color.toLowerCase() === color.toLowerCase()}
              className="w-5 h-5 rounded-full ring-1 ring-white/25 transition-transform hover:scale-110"
              style={{
                backgroundColor: color,
                outline: ink.color.toLowerCase() === color.toLowerCase() ? '2px solid white' : 'none',
                outlineOffset: '2px',
              }}
            />
          ))}

          <div className="w-px h-5 bg-white/20 mx-1" />

          <button
            onClick={handleClear}
            className="px-2 py-1 text-xs font-medium text-white/80 hover:text-white rounded-md hover:bg-white/10"
            data-tip="Clear all strokes"
          >
            Clear
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
