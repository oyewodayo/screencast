// AnnotationOverlayWindow.tsx
//
// The system-wide "stylus annotation" overlay - a transparent window spanning every monitor
// (see ensure_annotation_overlay in src-tauri/src/commands/annotation.rs, which computes and
// applies its position/size), toggled into "draw mode" by a global hotkey owned by Dashboard.tsx
// (this window has no OS focus/taskbar presence of its own to hang a hotkey off of). Strokes are
// freehand ink on a full-window <canvas> that fade out a few seconds after each one is finished,
// regardless of whether draw mode is still on - so a circle drawn just before exiting draw mode
// still gets to fade naturally instead of vanishing instantly.
import { useEffect, useRef, useState } from 'react';
import { listen, emit } from '@tauri-apps/api/event';
import { getStroke } from 'perfect-freehand';
import { IoClose } from 'react-icons/io5';

interface StrokePoint {
  x: number;
  y: number;
  pressure: number;
}

interface Stroke {
  points: StrokePoint[];
  color: string;
  width: number;
  // performance.now() timestamp of pointerup, i.e. when the fade countdown starts - 0 while the
  // stroke is still being drawn.
  finishedAt: number;
}

// Stays fully visible for FADE_HOLD_MS after being finished, then fades to transparent over the
// following FADE_OUT_MS - "a few seconds" total, split so a quick glance still catches it clearly
// before it starts disappearing.
const FADE_HOLD_MS = 1200;
const FADE_OUT_MS = 1400;
const BASE_STROKE_WIDTH = 6;
const COLORS = ['#ef4444', '#facc15', '#22c55e', '#3b82f6'];

const AnnotationOverlayWindow = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const strokesRef = useRef<Stroke[]>([]);
  const currentStrokeRef = useRef<Stroke | null>(null);
  const rafRef = useRef<number | null>(null);

  const [drawModeActive, setDrawModeActive] = useState(false);
  const [selectedColor, setSelectedColor] = useState(COLORS[0]);
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
    };

    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);

  // Draw-mode on/off comes from the main window (global hotkey) - Dashboard.tsx is the one that
  // actually flips this window's click-through state on the window handle; this listener just
  // drives the toolbar's visibility/cursor here.
  useEffect(() => {
    const unlistenPromise = listen<{ active: boolean }>('annotation-mode-changed', (event) => {
      setDrawModeActive(event.payload.active);
      if (!event.payload.active) currentStrokeRef.current = null;
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
      if (e.key === 'Escape') {
        void emit('annotation-turn-off-request');
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [drawModeActive]);

  // Same technique PdfAnnotator's pen tool uses (see strokeToOutline in pdfAnnotationHandlers.ts)
  // - perfect-freehand turns the raw point+pressure samples into a pressure-tapered outline
  // polygon, filled rather than stroked, which is what gives it a real marker/stylus feel instead
  // of a uniform-width polyline.
  const drawStroke = (ctx: CanvasRenderingContext2D, stroke: Stroke, opacity: number): void => {
    if (stroke.points.length === 0 || opacity <= 0) return;

    const outline = getStroke(
      stroke.points.map((p) => [p.x, p.y, p.pressure]),
      {
        size: stroke.width,
        thinning: 0.6,
        smoothing: 0.5,
        streamline: 0.5,
        simulatePressure: stroke.points.every((p) => p.pressure === 0.5),
      }
    );
    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.fillStyle = stroke.color;

    if (outline.length === 0) {
      // A plain tap/click - perfect-freehand needs at least two samples to form an outline, so
      // this still leaves a visible dot instead of drawing nothing.
      ctx.beginPath();
      ctx.arc(stroke.points[0].x, stroke.points[0].y, stroke.width / 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      return;
    }

    ctx.beginPath();
    ctx.moveTo(outline[0][0], outline[0][1]);
    for (let i = 1; i < outline.length; i++) {
      ctx.lineTo(outline[i][0], outline[i][1]);
    }
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  };

  // Runs continuously for as long as this window is mounted (i.e. the whole time the annotation
  // feature is enabled in Settings) - clearing+redrawing an empty stroke list is cheap enough
  // that starting/stopping the loop around whether anything's currently on screen isn't worth the
  // extra state.
  useEffect(() => {
    const render = (): void => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext('2d');
      if (canvas && ctx) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        const now = performance.now();
        strokesRef.current = strokesRef.current.filter(
          (s) => now - s.finishedAt < FADE_HOLD_MS + FADE_OUT_MS
        );
        for (const stroke of strokesRef.current) {
          const age = now - stroke.finishedAt;
          const opacity = age <= FADE_HOLD_MS ? 1 : Math.max(0, 1 - (age - FADE_HOLD_MS) / FADE_OUT_MS);
          drawStroke(ctx, stroke, opacity);
        }
        if (currentStrokeRef.current) {
          drawStroke(ctx, currentStrokeRef.current, 1);
        }
      }
      rafRef.current = requestAnimationFrame(render);
    };

    rafRef.current = requestAnimationFrame(render);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Real stylus pressure (0 for mouse/touch, normalized to 0.5 - perfect-freehand's own
  // simulatePressure kicks in server-side in drawStroke when every point reports that default)
  // is captured per-point so getStroke can taper the outline along the whole stroke, the same way
  // PdfAnnotator's pen tool does.
  const getPoint = (e: React.PointerEvent<HTMLCanvasElement>): StrokePoint => ({
    x: e.nativeEvent.offsetX,
    y: e.nativeEvent.offsetY,
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
      color: selectedColor,
      width: BASE_STROKE_WIDTH,
      finishedAt: 0,
    };
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    if (!currentStrokeRef.current) return;
    currentStrokeRef.current.points.push(getPoint(e));
  };

  const finishStroke = (): void => {
    if (!currentStrokeRef.current) return;
    currentStrokeRef.current.finishedAt = performance.now();
    strokesRef.current.push(currentStrokeRef.current);
    currentStrokeRef.current = null;
  };

  const handleClear = (): void => {
    strokesRef.current = [];
    currentStrokeRef.current = null;
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

      {drawModeActive && (
        <div
          className="absolute flex items-center gap-2 px-2.5 py-2 rounded-xl bg-neutral-900/90 shadow-lg ring-1 ring-white/10"
          style={{ left: toolbarPos.x, top: toolbarPos.y }}
        >
          <div
            onMouseDown={handleToolbarDragStart}
            className="w-3 h-6 flex flex-col justify-center gap-0.5 cursor-move mr-1"
            title="Drag"
          >
            <div className="w-full h-0.5 bg-white/40 rounded" />
            <div className="w-full h-0.5 bg-white/40 rounded" />
            <div className="w-full h-0.5 bg-white/40 rounded" />
          </div>

          {COLORS.map((color) => (
            <button
              key={color}
              onClick={() => setSelectedColor(color)}
              title={color}
              className="w-5 h-5 rounded-full"
              style={{
                backgroundColor: color,
                outline: selectedColor === color ? '2px solid white' : 'none',
                outlineOffset: '2px',
              }}
            />
          ))}

          <div className="w-px h-5 bg-white/20 mx-1" />

          <button
            onClick={handleClear}
            className="px-2 py-1 text-xs font-medium text-white/80 hover:text-white rounded-md hover:bg-white/10"
            title="Clear all strokes"
          >
            Clear
          </button>

          <button
            onClick={handleRequestExit}
            className="p-1 rounded-md text-white/70 hover:text-white hover:bg-white/10"
            title="Exit annotation mode (Esc)"
          >
            <IoClose size={16} />
          </button>
        </div>
      )}
    </div>
  );
};

export default AnnotationOverlayWindow;
