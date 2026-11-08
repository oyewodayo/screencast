// components/video/ResizeHandles.tsx
//
// The eight resize handles (four corners, four edges) on a selected picture / shape / blur box.
// Rendered inside the box (so they turn with a rotated box); on an unrotated box that runs to or
// past the frame's edge - a full-frame shape, a backdrop - each handle is pulled inward to stay
// grabbable, clear of the player's controls along the bottom (boxResize.ts). Cursors follow the
// box's rotation so they always point along the drag.
import React from "react";
import { FrameRect } from "../../utils/videoFrameRect";
import { PxBox, RESIZE_HANDLES, ResizeHandle, isCornerHandle, reachableHandlePosition } from "../../utils/boxResize";

// Room kept clear at the bottom of the frame for VideoPlayer's control bar.
const CONTROLS_RESERVE_PX = 56;

const CURSORS = ["ew-resize", "nwse-resize", "ns-resize", "nesw-resize"];
// The resize cursor nearest the handle's direction once the box is rotated.
const cursorFor = (h: ResizeHandle, rotation: number): string => {
  const deg = (Math.atan2(h.sy, h.sx) * 180) / Math.PI + rotation;
  const step = Math.round((((deg % 180) + 180) % 180) / 45) % 4;
  return CURSORS[step];
};

const COLORS = {
  amber: "bg-amber-400 hover:bg-amber-300",
  sky: "bg-sky-400 hover:bg-sky-300",
};

interface ResizeHandlesProps {
  box: PxBox;
  rotation: number;
  frameRect: FrameRect;
  color: keyof typeof COLORS;
  title: string;
  onPointerDown: (handle: ResizeHandle) => (e: React.PointerEvent) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: () => void;
}

const ResizeHandles: React.FC<ResizeHandlesProps> = ({ box, rotation, frameRect, color, title, onPointerDown, onPointerMove, onPointerUp }) => {
  const rotated = Math.abs(rotation % 360) > 0.01;
  // Small boxes keep just their corners - edge handles would crowd them.
  const showEdges = box.width >= 48 && box.height >= 48;
  return (
    <>
      {RESIZE_HANDLES.filter((h) => showEdges || isCornerHandle(h)).map((h) => {
        const pos = rotated
          ? { left: ((h.sx + 1) / 2) * box.width, top: ((h.sy + 1) / 2) * box.height }
          : reachableHandlePosition(h, box, frameRect.width, frameRect.height, CONTROLS_RESERVE_PX);
        const corner = isCornerHandle(h);
        return (
          <div
            key={h.id}
            onPointerDown={onPointerDown(h)}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            title={title}
            className={`absolute ${COLORS[color]} ring-2 ring-white/80 shadow ${corner ? "w-3.5 h-3.5 rounded-full" : "rounded-full"}`}
            style={{
              left: pos.left,
              top: pos.top,
              transform: "translate(-50%, -50%)",
              cursor: cursorFor(h, rotation),
              // Edge handles are short bars along their edge.
              ...(corner ? {} : h.sx === 0 ? { width: 18, height: 7 } : { width: 7, height: 18 }),
              pointerEvents: "auto",
              touchAction: "none",
            }}
          />
        );
      })}
    </>
  );
};

export default ResizeHandles;
