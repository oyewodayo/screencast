// components/video/ClipCropOverlay.tsx
//
// On-canvas crop editing for the clip currently on screen - a draggable, freely resizable window
// rendered directly over the live video preview (mounted as a sibling to VideoOverlayLayer, see
// Dashboard's own `overlay` render-prop), NOT a modal: unlike ImageOverlayCropPanel (which needs
// its own separate view since the image overlay it crops is often tiny on screen), the video frame
// here IS the main preview, already plenty large to drag directly on. Armed/disarmed via
// VideoTimelineDocker's toolbar Crop button (isCroppingClip, lifted to Dashboard the same way
// isPlacingText/isPlacingImage/isPlacingBlur already are) - while armed, this tracks whichever clip
// is currently on screen (ActiveClipEffects.id) and commits straight to the store on every drag
// end, no separate Apply step.
//
// Free-form (independent x/y/width/height, NOT locked to the frame's own aspect ratio - see
// ClipCrop's own doc comment in videoEditTypes.ts) so a strip can be trimmed off just one edge
// (e.g. cropping browser-tab chrome off the top while keeping full width). Four corner handles
// resize both axes at once; four edge-midpoint handles resize just one axis, anchored on the
// opposite edge - same anchor-the-untouched-side idiom ImageOverlayCropPanel's own corner drag
// already uses, generalized to a subset-of-edges shape so corners and edges share one code path.
//
// Tracks the drag via WINDOW-level pointermove/pointerup listeners rather than per-element
// setPointerCapture (what ImageOverlayCropPanel/VideoOverlayLayer's own blur/image drags use) -
// setPointerCapture proved unreliable in this app's WebView2 runtime once the cursor outran a
// handle's own (not-yet-updated) hit box mid-drag. A window listener has no hit-testing to outrun
// at all: it fires for the whole document regardless of what's currently under the cursor.
import React, { useEffect, useRef, useState } from "react";
import { ClipCrop } from "../../utils/videoEditTypes";
import { FrameRect } from "../../utils/videoFrameRect";

// Which edges a given handle moves - a corner sets two, an edge midpoint sets just one. `left`/
// `right` are mutually exclusive on one handle (same for `top`/`bottom`), enforced by construction
// below (HANDLES), not by this type.
interface EdgeFlags {
  left?: boolean;
  right?: boolean;
  top?: boolean;
  bottom?: boolean;
}

type HandleId = "nw" | "ne" | "sw" | "se" | "n" | "s" | "e" | "w";

const HANDLES: { id: HandleId; edges: EdgeFlags; cursor: string }[] = [
  { id: "nw", edges: { left: true, top: true }, cursor: "cursor-nwse-resize" },
  { id: "ne", edges: { right: true, top: true }, cursor: "cursor-nesw-resize" },
  { id: "sw", edges: { left: true, bottom: true }, cursor: "cursor-nesw-resize" },
  { id: "se", edges: { right: true, bottom: true }, cursor: "cursor-nwse-resize" },
  { id: "n", edges: { top: true }, cursor: "cursor-ns-resize" },
  { id: "s", edges: { bottom: true }, cursor: "cursor-ns-resize" },
  { id: "e", edges: { right: true }, cursor: "cursor-ew-resize" },
  { id: "w", edges: { left: true }, cursor: "cursor-ew-resize" },
];

// Below this fraction of the frame on either axis, the window stops being a meaningfully
// draggable target and risks a near-zero-area export - matches crop_chain's own clamp
// (conversion.rs).
const MIN_FRACTION = 0.05;

interface ClipCropOverlayProps {
  frameRect: FrameRect;
  crop: ClipCrop | undefined;
  onChange: (crop: ClipCrop) => void;
  // Fires on every uncommitted change during a drag (and once more with null when the drag ends
  // and liveRect clears - see the effect below) - lets the caller drive the actual video pixels in
  // real time (VideoPlayer's previewCropLive) instead of only jumping to the new crop once
  // `onChange` round-trips through the store and back down as a fresh `crop` prop. Optional so this
  // stays usable without wiring live preview through.
  onLivePreview?: (crop: ClipCrop | null) => void;
}

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

type DragKind = { kind: "pan" } | { kind: "resize"; edges: EdgeFlags };

const FULL_FRAME: ClipCrop = { x: 0, y: 0, width: 1, height: 1 };

const ClipCropOverlay: React.FC<ClipCropOverlayProps> = ({ frameRect, crop, onChange, onLivePreview }) => {
  // Falls back to the full frame not just when `crop` is unset, but when it doesn't actually have
  // valid width/height - guards against a stale {x,y,size} value left over from an older shape
  // this type used earlier (in-memory state from before a shape change, or an already-saved
  // sidecar file written by that older version), which would otherwise silently produce NaN
  // geometry and render as a collapsed, invisible window instead of covering the frame.
  const committed: ClipCrop =
    crop && Number.isFinite(crop.width) && Number.isFinite(crop.height) && crop.width > 0 && crop.height > 0 ? crop : FULL_FRAME;

  // Non-null exactly while a pan/resize gesture is in progress - the live (uncommitted) window
  // shown instead of `committed` for that duration. Read/written only from the window-level
  // listeners below plus beginDrag, never derived from per-element pointer events.
  const [liveRect, setLiveRect] = useState<ClipCrop | null>(null);
  // What's actually on screen right now - liveRect while a drag (or its post-release settle
  // period, see endDrag below) is holding it, `committed` otherwise. Declared early, above
  // beginDrag, specifically so beginDrag can snapshot from THIS instead of `committed` directly -
  // see beginDrag's own comment for why that distinction matters.
  const rect = liveRect ?? committed;
  const dragRef = useRef<DragKind | null>(null);
  const dragStartRef = useRef<{ clientX: number; clientY: number; rect: ClipCrop } | null>(null);
  // Mutable mirrors of props, read from the window listeners below (registered once, for the
  // component's whole lifetime) so those listeners always see the current frame geometry/commit
  // callback without needing to be torn down and re-registered on every prop change.
  const frameRectRef = useRef(frameRect);
  frameRectRef.current = frameRect;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onLivePreviewRef = useRef(onLivePreview);
  onLivePreviewRef.current = onLivePreview;

  const beginDrag = (kind: DragKind) => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    dragRef.current = kind;
    // Snapshots from `rect` (what's actually on screen), NOT `committed` (the raw crop prop) -
    // starting a second drag before the first one's onChange has round-tripped back down as a
    // fresh `crop` prop would otherwise baseline off the STALE pre-edit value even though the
    // screen is already correctly showing the post-edit one (via liveRect, held there by endDrag
    // for exactly this settle window). Edges the new drag doesn't itself touch are carried over
    // unchanged from this snapshot, so basing it on the stale value silently discarded the first
    // edit on every edge but the one just dragged - drag one side, then immediately drag another,
    // and the first side would visibly jump back to its pre-drag position.
    dragStartRef.current = { clientX: e.clientX, clientY: e.clientY, rect };
    setLiveRect(rect);
  };

  useEffect(() => {
    const handleMove = (e: PointerEvent) => {
      const drag = dragRef.current;
      const start = dragStartRef.current;
      const fr = frameRectRef.current;
      if (!drag || !start || fr.width <= 0 || fr.height <= 0) return;
      const dxFrac = (e.clientX - start.clientX) / fr.width;
      const dyFrac = (e.clientY - start.clientY) / fr.height;

      if (drag.kind === "pan") {
        const { width, height } = start.rect;
        const x = clamp(start.rect.x + dxFrac, 0, 1 - width);
        const y = clamp(start.rect.y + dyFrac, 0, 1 - height);
        setLiveRect({ x, y, width, height });
        return;
      }

      const { left, right, top, bottom } = drag.edges;
      let { x, width } = start.rect;
      if (left) {
        const newX = clamp(start.rect.x + dxFrac, 0, start.rect.x + start.rect.width - MIN_FRACTION);
        width = start.rect.width + (start.rect.x - newX);
        x = newX;
      } else if (right) {
        const newRight = clamp(start.rect.x + start.rect.width + dxFrac, start.rect.x + MIN_FRACTION, 1);
        width = newRight - start.rect.x;
      }
      let { y, height } = start.rect;
      if (top) {
        const newY = clamp(start.rect.y + dyFrac, 0, start.rect.y + start.rect.height - MIN_FRACTION);
        height = start.rect.height + (start.rect.y - newY);
        y = newY;
      } else if (bottom) {
        const newBottom = clamp(start.rect.y + start.rect.height + dyFrac, start.rect.y + MIN_FRACTION, 1);
        height = newBottom - start.rect.y;
      }
      setLiveRect({ x, y, width, height });
    };

    const endDrag = () => {
      if (!dragRef.current) return;
      dragRef.current = null;
      dragStartRef.current = null;
      // Deliberately keeps showing `live` (does NOT reset to null here) - onChange round-trips
      // through Dashboard's store and back down as a new `crop` prop over several React commits
      // (setState -> VideoTimelineDocker's own effect -> onActiveClipChange -> Dashboard's
      // setActiveClipEffects -> re-render), which lands a paint or two after this handler returns.
      // Clearing liveRect immediately would let `committed` (still built from the OLD crop prop
      // for that gap) render first, i.e. a visible snap back to the pre-drag rect that then
      // corrects itself a moment later - exactly the "springs back on release" bug this avoids.
      // See the effect below for where liveRect actually gets cleared once `crop` catches up.
      setLiveRect((live) => {
        if (live) onChangeRef.current(live);
        return live;
      });
    };

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", endDrag);
    window.addEventListener("pointercancel", endDrag);
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", endDrag);
      window.removeEventListener("pointercancel", endDrag);
    };
  }, []);

  // Drops the liveRect override once `crop` actually reflects it - the counterpart to endDrag
  // above keeping `live` around instead of nulling it out immediately. Also runs (harmlessly,
  // liveRect is already null) for external crop changes made while not dragging, e.g. undo/redo.
  useEffect(() => {
    if (!dragRef.current) setLiveRect(null);
  }, [crop]);

  // Mirrors liveRect out to the caller (VideoPlayer's previewCropLive, wired via Dashboard) so the
  // actual video content tracks the drag/settles back to the committed crop in lockstep with the
  // on-canvas box below - same liveRect value drives both, they can never show two different
  // rects. Fires at whatever rate liveRect itself changes (already once per pointermove, same as
  // today - this adds no extra re-renders of its own, just one more cheap imperative call per
  // render this component was already doing).
  useEffect(() => {
    onLivePreviewRef.current?.(liveRect);
  }, [liveRect]);

  // Releases any live override left dangling if this whole overlay unmounts mid-drag (crop mode
  // toggled off, or the active clip/file changed out from under it) - otherwise the video would be
  // stuck showing a crop that no longer has a box to match it, forever, since nothing else would
  // ever call onLivePreview(null) again.
  useEffect(() => {
    return () => onLivePreviewRef.current?.(null);
  }, []);

  const xPx = rect.x * frameRect.width;
  const yPx = rect.y * frameRect.height;
  const wPx = rect.width * frameRect.width;
  const hPx = rect.height * frameRect.height;

  // Handle hit-boxes are deliberately much bigger than their visible dot (28px square vs an 8px
  // dot) - a small visible handle is fine, but a small CLICKABLE handle is what made the original
  // version of this tool hard to grab reliably.
  const HIT = 28;
  const DOT = 8;
  const handlePosition: Record<HandleId, { left: number; top: number }> = {
    nw: { left: xPx, top: yPx },
    ne: { left: xPx + wPx, top: yPx },
    sw: { left: xPx, top: yPx + hPx },
    se: { left: xPx + wPx, top: yPx + hPx },
    n: { left: xPx + wPx / 2, top: yPx },
    s: { left: xPx + wPx / 2, top: yPx + hPx },
    e: { left: xPx + wPx, top: yPx + hPx / 2 },
    w: { left: xPx, top: yPx + hPx / 2 },
  };

  return (
    // left/top are deliberately 0, NOT frameRect.left/top - VideoPlayer.tsx already wraps
    // `overlay(frameRect)` in a div positioned at frameRect.left/top, so this component's own
    // (0,0) already IS the frame's own top-left corner. VideoOverlayLayer's own overlays (blur/
    // image/text) rely on the exact same thing - their handles are positioned with plain
    // `o.x * frameRect.width`, no added frameRect.left - adding it again here would double-offset
    // every handle away from where it's actually drawn, exactly the "clicks land nowhere useful"
    // bug this fixes.
    <div className="absolute" style={{ left: 0, top: 0, width: frameRect.width, height: frameRect.height, pointerEvents: "none" }}>
      {/* Dims everything outside the crop window via four bands - simpler to keep in sync with a
          window that's being live-dragged every frame than a clip-path. */}
      <div className="absolute bg-black/60" style={{ left: 0, top: 0, right: 0, height: yPx }} />
      <div className="absolute bg-black/60" style={{ left: 0, top: yPx + hPx, right: 0, bottom: 0 }} />
      <div className="absolute bg-black/60" style={{ left: 0, top: yPx, width: xPx, height: hPx }} />
      <div className="absolute bg-black/60" style={{ left: xPx + wPx, top: yPx, right: 0, height: hPx }} />

      <div
        onPointerDown={beginDrag({ kind: "pan" })}
        title="Drag to move"
        className="absolute outline outline-2 outline-white cursor-move"
        style={{ left: xPx, top: yPx, width: wPx, height: hPx, pointerEvents: "auto" }}
      />

      {HANDLES.map(({ id, edges, cursor }) => {
        const pos = handlePosition[id];
        return (
          <div
            key={id}
            onPointerDown={beginDrag({ kind: "resize", edges })}
            title="Drag to resize"
            className={`absolute flex items-center justify-center ${cursor}`}
            // left/top pinned at 0 (never touched again) and all actual per-frame movement done via
            // `transform` instead - unlike the dim bands/pan box above, a handle's own size (HIT) is
            // genuinely constant across a drag, only its position changes, so this is a clean,
            // risk-free swap: translate3d is compositor-only (no layout/reflow), where writing
            // left/top forces one on every pointermove. Not worth the same trick for the dim bands
            // or pan box, whose WIDTH/HEIGHT also change every frame - doing that without visibly
            // distorting the outline would need a clip-path/path() hole, real complexity for a
            // handful of small elements during a short, user-initiated gesture.
            style={{
              left: 0,
              top: 0,
              width: HIT,
              height: HIT,
              transform: `translate3d(${pos.left - HIT / 2}px, ${pos.top - HIT / 2}px, 0)`,
              pointerEvents: "auto",
            }}
          >
            <div className="rounded-full bg-amber-400 ring-2 ring-white/80" style={{ width: DOT, height: DOT }} />
          </div>
        );
      })}
    </div>
  );
};

export default ClipCropOverlay;
