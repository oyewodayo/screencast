// components/video/TrackTargetPicker.tsx
//
// The "what should this follow?" step of motion tracking (motionTracking.ts): a box on the paused
// frame that the user drags and resizes over the moving thing, the rest of the picture dimmed so
// the choice reads at a glance. Confirming hands the box (frame fractions) to Dashboard, which runs
// the track; while it runs this shows its progress and a way to stop it.
import React, { useState } from "react";
import { IoNavigateOutline } from "react-icons/io5";
import { FrameRect } from "../../utils/videoFrameRect";
import type { Box } from "../../utils/motionTracking";

interface Props {
  frameRect: FrameRect;
  initial: Box;
  // Whether "follow its size" applies (a blur region keeps its size).
  canFollowScale: boolean;
  tracking: { progress: number } | null;
  error: string | null;
  onTrack: (target: Box, followScale: boolean) => void;
  onCancel: () => void;
}

const MIN = 0.02;
type Kind = "move" | "nw" | "ne" | "sw" | "se";

const TrackTargetPicker: React.FC<Props> = ({ frameRect, initial, canFollowScale, tracking, error, onTrack, onCancel }) => {
  const [box, setBox] = useState<Box>(initial);
  const [followScale, setFollowScale] = useState(true);
  const [drag, setDrag] = useState<{ kind: Kind; x: number; y: number; box: Box } | null>(null);
  const W = frameRect.width;
  const H = frameRect.height;

  const begin = (kind: Kind) => (e: React.PointerEvent) => {
    if (tracking) return;
    e.stopPropagation();
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ kind, x: e.clientX, y: e.clientY, box });
  };
  const move = (e: React.PointerEvent) => {
    if (!drag || W <= 0 || H <= 0) return;
    const dx = (e.clientX - drag.x) / W;
    const dy = (e.clientY - drag.y) / H;
    const b = drag.box;
    if (drag.kind === "move") {
      setBox({ ...b, x: Math.max(0, Math.min(1 - b.width, b.x + dx)), y: Math.max(0, Math.min(1 - b.height, b.y + dy)) });
      return;
    }
    const left = drag.kind === "nw" || drag.kind === "sw";
    const top = drag.kind === "nw" || drag.kind === "ne";
    const x0 = left ? Math.max(0, Math.min(b.x + b.width - MIN, b.x + dx)) : b.x;
    const x1 = left ? b.x + b.width : Math.min(1, Math.max(b.x + MIN, b.x + b.width + dx));
    const y0 = top ? Math.max(0, Math.min(b.y + b.height - MIN, b.y + dy)) : b.y;
    const y1 = top ? b.y + b.height : Math.min(1, Math.max(b.y + MIN, b.y + b.height + dy));
    setBox({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
  };
  const end = () => setDrag(null);

  const px = { left: box.x * W, top: box.y * H, width: box.width * W, height: box.height * H };
  const corner = (kind: Exclude<Kind, "move">, left: number, top: number) => (
    <div
      key={kind}
      onPointerDown={begin(kind)}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      className="absolute w-4 h-4 rounded-full bg-emerald-400 ring-2 ring-white shadow"
      style={{ left: left - 8, top: top - 8, cursor: kind === "nw" || kind === "se" ? "nwse-resize" : "nesw-resize", pointerEvents: "auto" }}
    />
  );

  return (
    <div className="absolute inset-0" style={{ pointerEvents: "auto", zIndex: 40 }} onPointerDown={(e) => e.stopPropagation()}>
      {/* The dimmed frame with the box cut out of it. */}
      <div
        onPointerDown={begin("move")}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
        title="Drag over what to follow"
        className={`absolute rounded-sm outline outline-2 ${tracking ? "outline-emerald-300 animate-pulse" : "outline-emerald-400 cursor-move"}`}
        style={{ ...px, boxShadow: "0 0 0 9999px rgba(0,0,0,0.45)" }}
      >
        <div className="absolute left-1/2 top-1/2 w-3 h-3 -ml-1.5 -mt-1.5 pointer-events-none">
          <div className="absolute left-1/2 top-0 bottom-0 w-px bg-emerald-300/80" />
          <div className="absolute top-1/2 left-0 right-0 h-px bg-emerald-300/80" />
        </div>
      </div>
      {!tracking && (
        <>
          {corner("nw", px.left, px.top)}
          {corner("ne", px.left + px.width, px.top)}
          {corner("sw", px.left, px.top + px.height)}
          {corner("se", px.left + px.width, px.top + px.height)}
        </>
      )}
      <div className="absolute left-1/2 top-3 -translate-x-1/2 flex items-center gap-2 px-3 py-2 rounded-lg bg-neutral-900/95 ring-1 ring-white/10 shadow-lg text-[12px] text-white/90 whitespace-nowrap">
        <IoNavigateOutline size={14} className="text-emerald-300" />
        {tracking ? (
          <>
            <span>Following it… {Math.round(tracking.progress * 100)}%</span>
            <span className="w-28 h-1 rounded-full bg-white/15 overflow-hidden">
              <span className="block h-full bg-emerald-400 transition-[width]" style={{ width: `${Math.round(tracking.progress * 100)}%` }} />
            </span>
            <button type="button" onClick={onCancel} className="px-2 py-0.5 rounded text-white/70 hover:text-white hover:bg-white/10">
              Stop
            </button>
          </>
        ) : (
          <>
            <span>Box what it should follow</span>
            {canFollowScale && (
              <label className="flex items-center gap-1.5 text-white/70" title="Grow and shrink with it as it comes closer or moves away">
                <input type="checkbox" checked={followScale} onChange={(e) => setFollowScale(e.target.checked)} />
                its size too
              </label>
            )}
            <button type="button" onClick={() => onTrack(box, canFollowScale && followScale)} className="px-2.5 py-1 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white font-medium">
              Track
            </button>
            <button type="button" onClick={onCancel} className="px-2 py-1 rounded-md text-white/70 hover:text-white hover:bg-white/10">
              Cancel
            </button>
          </>
        )}
      </div>
      {error && (
        <div className="absolute left-1/2 top-14 -translate-x-1/2 max-w-[80%] px-3 py-1.5 rounded-md bg-red-950/90 ring-1 ring-red-800 text-red-200 text-[11px]">{error}</div>
      )}
    </div>
  );
};

export default TrackTargetPicker;
