// components/video/MaskEditor.tsx
//
// Edits a layer's mask (layerMask.ts) right on the picture: the mask's outline over the layer's box,
// drag inside it to move it, drag a handle to resize it - or, in draw mode, drag out a freehand
// outline that becomes the mask. Every change commits once, on release (one undo step), while the
// layer itself shows the mask live as it's dragged.
//
// Coordinates: `box` is the layer's box in the parent's pixels; the mask lives in fractions of it.
// Drags are tracked with window listeners (the same WebView2 reliability reason as ClipCropOverlay).
import React, { useEffect, useRef, useState } from "react";
import { pathBounds, placeMask, simplifyPath, type LayerMask, type MaskPoint } from "../../utils/layerMask";

interface MaskEditorProps {
  box: { left: number; top: number; width: number; height: number };
  // The layer's rotation in degrees (a picture's), about its box's centre.
  rotation?: number;
  mask: LayerMask;
  // Draw a new freehand outline on the next drag.
  drawing: boolean;
  zIndex?: number;
  onLive: (mask: LayerMask | null) => void;
  onCommit: (mask: LayerMask) => void;
  onDrawn: () => void;
}

type Handle = "nw" | "ne" | "sw" | "se" | "n" | "s" | "e" | "w";
const HANDLES: { id: Handle; fx: number; fy: number; cursor: string }[] = [
  { id: "nw", fx: 0, fy: 0, cursor: "nwse-resize" },
  { id: "ne", fx: 1, fy: 0, cursor: "nesw-resize" },
  { id: "sw", fx: 0, fy: 1, cursor: "nesw-resize" },
  { id: "se", fx: 1, fy: 1, cursor: "nwse-resize" },
  { id: "n", fx: 0.5, fy: 0, cursor: "ns-resize" },
  { id: "s", fx: 0.5, fy: 1, cursor: "ns-resize" },
  { id: "e", fx: 1, fy: 0.5, cursor: "ew-resize" },
  { id: "w", fx: 0, fy: 0.5, cursor: "ew-resize" },
];
const MIN_SIZE = 0.03;
const CLICK_DRAG_THRESHOLD_PX = 3;

type Gesture =
  | { kind: "move"; start: LayerMask; x: number; y: number }
  | { kind: "resize"; handle: Handle; start: LayerMask; x: number; y: number }
  | { kind: "draw"; points: MaskPoint[] };

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

const MaskEditor: React.FC<MaskEditorProps> = ({ box, rotation = 0, mask, drawing, zIndex, onLive, onCommit, onDrawn }) => {
  const [live, setLiveState] = useState<LayerMask | null>(null);
  const liveRef = useRef<LayerMask | null>(null);
  const setLive = (m: LayerMask | null) => {
    liveRef.current = m;
    setLiveState(m);
  };
  const [stroke, setStroke] = useState<MaskPoint[] | null>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const movedRef = useRef(false);
  const propsRef = useRef({ box, rotation, mask, onLive, onCommit, onDrawn });
  propsRef.current = { box, rotation, mask, onLive, onCommit, onDrawn };
  const shown = live ?? mask;

  // A pointer position in the box's own (unrotated) fractions - its on-screen bounds' centre is the
  // box's centre whatever the rotation.
  const toFrac = (clientX: number, clientY: number, el: Element) => {
    const r = el.getBoundingClientRect();
    const { box: b, rotation: deg } = propsRef.current;
    const a = (-deg * Math.PI) / 180;
    const dx = clientX - (r.left + r.width / 2);
    const dy = clientY - (r.top + r.height / 2);
    const lx = dx * Math.cos(a) - dy * Math.sin(a);
    const ly = dx * Math.sin(a) + dy * Math.cos(a);
    return { x: lx / Math.max(1, b.width) + 0.5, y: ly / Math.max(1, b.height) + 0.5 };
  };
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const move = (e: PointerEvent) => {
      const g = gestureRef.current;
      const root = rootRef.current;
      if (!g || !root) return;
      const p = toFrac(e.clientX, e.clientY, root);
      if (g.kind === "draw") {
        g.points.push({ x: clamp(p.x, 0, 1), y: clamp(p.y, 0, 1) });
        setStroke([...g.points]);
        return;
      }
      const { box: b } = propsRef.current;
      if (!movedRef.current && Math.abs(p.x - g.x) * b.width < CLICK_DRAG_THRESHOLD_PX && Math.abs(p.y - g.y) * b.height < CLICK_DRAG_THRESHOLD_PX) return;
      movedRef.current = true;
      const dx = p.x - g.x;
      const dy = p.y - g.y;
      const s = g.start;
      let next: LayerMask;
      if (g.kind === "move") {
        // Free to move partly off the layer (a reveal can start outside it).
        next = placeMask(s, { x: s.x + dx, y: s.y + dy, width: s.width, height: s.height });
      } else {
        let x0 = s.x;
        let y0 = s.y;
        let x1 = s.x + s.width;
        let y1 = s.y + s.height;
        if (g.handle.includes("w")) x0 = Math.min(x0 + dx, x1 - MIN_SIZE);
        if (g.handle.includes("e")) x1 = Math.max(x1 + dx, x0 + MIN_SIZE);
        if (g.handle.includes("n")) y0 = Math.min(y0 + dy, y1 - MIN_SIZE);
        if (g.handle.includes("s")) y1 = Math.max(y1 + dy, y0 + MIN_SIZE);
        next = placeMask(s, { x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
      }
      setLive(next);
      propsRef.current.onLive(next);
    };
    const up = () => {
      const g = gestureRef.current;
      if (!g) return;
      gestureRef.current = null;
      const { mask: m, onCommit: commit, onLive: liveCb, onDrawn: drawn } = propsRef.current;
      if (g.kind === "draw") {
        setStroke(null);
        const points = simplifyPath(g.points, 0.004);
        if (points.length >= 3) {
          const bounds = pathBounds(points);
          if (bounds.width > MIN_SIZE && bounds.height > MIN_SIZE) commit({ ...m, shape: "path", points, ...bounds });
        }
        liveCb(null);
        drawn();
        return;
      }
      if (movedRef.current && liveRef.current) commit(liveRef.current);
      setLive(null);
      liveCb(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, []);

  const begin = (kind: "move" | "draw" | Handle) => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const root = rootRef.current;
    if (!root) return;
    const p = toFrac(e.clientX, e.clientY, root);
    movedRef.current = false;
    if (kind === "draw") {
      gestureRef.current = { kind: "draw", points: [{ x: clamp(p.x, 0, 1), y: clamp(p.y, 0, 1) }] };
      setStroke(gestureRef.current.points);
    } else if (kind === "move") {
      gestureRef.current = { kind: "move", start: mask, x: p.x, y: p.y };
    } else {
      gestureRef.current = { kind: "resize", handle: kind, start: mask, x: p.x, y: p.y };
    }
  };

  // The outline, in the box's pixels.
  const W = box.width;
  const H = box.height;
  const sx = shown.x * W;
  const sy = shown.y * H;
  const sw = shown.width * W;
  const sh = shown.height * H;
  let outline: React.ReactNode;
  if (shown.shape === "ellipse") outline = <ellipse cx={sx + sw / 2} cy={sy + sh / 2} rx={Math.max(0, sw / 2)} ry={Math.max(0, sh / 2)} />;
  else if (shown.shape === "path" && shown.points && shown.points.length >= 3) outline = <polygon points={shown.points.map((p) => `${p.x * W},${p.y * H}`).join(" ")} />;
  else {
    const r = Math.max(0, Math.min(0.5, shown.cornerRadius ?? 0)) * Math.min(sw, sh);
    outline = <rect x={sx} y={sy} width={Math.max(0, sw)} height={Math.max(0, sh)} rx={r} ry={r} />;
  }

  return (
    <div
      ref={rootRef}
      data-pip-interactive
      className="absolute"
      style={{ left: box.left, top: box.top, width: W, height: H, transform: rotation ? `rotate(${rotation}deg)` : undefined, zIndex, pointerEvents: drawing ? "auto" : "none", cursor: drawing ? "crosshair" : undefined, touchAction: "none" }}
      onPointerDown={drawing ? begin("draw") : undefined}
    >
      <svg width={W} height={H} className="absolute inset-0 overflow-visible pointer-events-none">
        <g fill="none" stroke="black" strokeOpacity={0.6} strokeWidth={3}>
          {stroke ? <polyline points={stroke.map((p) => `${p.x * W},${p.y * H}`).join(" ")} /> : outline}
        </g>
        <g fill="none" stroke="#5eead4" strokeWidth={1.5} strokeDasharray="5 4">
          {stroke ? <polyline points={stroke.map((p) => `${p.x * W},${p.y * H}`).join(" ")} /> : outline}
        </g>
      </svg>
      {!drawing && !stroke && (
        <>
          <div
            data-pip-interactive
            title="Drag to move the mask"
            className="absolute cursor-move"
            style={{ left: sx, top: sy, width: Math.max(8, sw), height: Math.max(8, sh), pointerEvents: "auto", touchAction: "none" }}
            onPointerDown={begin("move")}
          />
          {HANDLES.map((h) => (
            <div
              key={h.id}
              data-pip-interactive
              title="Drag to resize the mask"
              className="absolute flex items-center justify-center"
              style={{ left: sx + h.fx * sw - 9, top: sy + h.fy * sh - 9, width: 18, height: 18, cursor: h.cursor, pointerEvents: "auto", touchAction: "none" }}
              onPointerDown={begin(h.id)}
            >
              <div className="w-2 h-2 rounded-full bg-teal-300 ring-1 ring-black/50" />
            </div>
          ))}
        </>
      )}
      {drawing && !stroke && (
        <div className="absolute left-1/2 top-1 -translate-x-1/2 px-2 py-0.5 rounded bg-teal-600/90 text-white text-[11px] pointer-events-none whitespace-nowrap">
          Drag around what should show
        </div>
      )}
    </div>
  );
};

export default MaskEditor;
