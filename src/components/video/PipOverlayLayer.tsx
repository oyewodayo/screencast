// components/video/PipOverlayLayer.tsx
//
// Real picture-in-picture video layer(s) composited over the main preview - e.g. a webcam
// recorded separately from the screen (see FormData.separate_webcam_capture, recording.rs) and
// repositioned/resized/reshaped here instead of being permanently baked into the recording.
// Unlike TextOverlay/ImageOverlay/BlurOverlay (all pre-rendered to a flat PNG for export, see
// videoOverlayRender.ts), a PipOverlay has genuine moving-picture content that can't be flattened
// ahead of time - this renders an actual <video> element instead of a styled <div>, mirrored on
// the export side by export_trimmed_video's own PipOverlay compositing (conversion.rs), which
// reuses the same circle/rounded masking technique recording.rs's build_camera_overlay_filter_complex
// already uses for the baked-in overlay this feature is the editable alternative to.
//
// Deliberately its own component, mounted as a sibling to VideoOverlayLayer (Dashboard.tsx's
// `overlay` render-prop) rather than folded into VideoOverlayLayer's much larger per-type
// machinery. Everything is edited on-canvas: drag the video to move it, drag the selected pip's
// handles to resize it (corners keep the aspect ratio unless Shift is held; edges stretch one
// side), and PipOverlayPopover's "Crop video…" opens PipCropEditor below to trim the source frame
// itself. PipOverlayPopover's sliders remain as a precise alternative.
//
// VideoPlayer wraps this whole layer in a `pointer-events: none` div (so empty frame area still
// reaches the player underneath) - every interactive element here must opt back in with
// `pointer-events: auto` explicitly, or clicks/drags pass straight through it. Drags are tracked
// with WINDOW-level listeners rather than setPointerCapture, for the same WebView2 reliability
// reason ClipCropOverlay.tsx documents.
import React, { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { ClipCrop, PipOverlay } from "../../utils/videoEditTypes";
import { overlaysActiveAt } from "../../handlers/videoEditHandlers";
import { FrameRect, computeLetterboxRect } from "../../utils/videoFrameRect";
import { FILE_CATEGORY_EXTENSIONS } from "../../utils/fileCategory";
import PipOverlayPopover, { PipOverlayPatch } from "./PipOverlayPopover";
import ClipCropOverlay from "./ClipCropOverlay";

const DEFAULT_PIP_WIDTH_FRACTION = 0.28;
const DEFAULT_PIP_MARGIN_FRACTION = 0.04;
// A freshly-placed PiP plays for its own full source length (up to this cap) rather than the
// generic 5s every other overlay kind defaults to - a webcam recording is usually meant to run
// alongside most of the screen recording, not just a brief 5-second window.
const MAX_INITIAL_PIP_DURATION_SEC = 120;

// Stacks the SELECTED pip (box, frame, handles) and PipCropEditor above VideoPlayer's own
// .video-controls-container (z-index 100) - VideoPlayer's overlay wrapper creates no stacking
// context of its own, so this competes with the controls directly. Without it, any handle that
// landed in the controls' band (the bottom of the frame) was unreachable: elementFromPoint there
// returned the play/pause row, not the handle. An unselected pip stays below the controls so they
// keep working normally.
const SELECTED_PIP_Z_INDEX = 101;

// PipOverlayPopover's own width (Tailwind w-64) plus the gap kept between it and the pip.
const POPOVER_WIDTH_PX = 256;
const POPOVER_GAP_PX = 8;

// How far down the frame (0..1) is still visible above BottomDocker - 1 when the docker doesn't
// overlap the frame at all (or its height hasn't been published).
function visibleFrameBottomFraction(origin: HTMLElement | null, frameRect: FrameRect): number {
  if (!origin || frameRect.height <= 0) return 1;
  const dockerHeight = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--docker-height")) || 0;
  const visibleBottom = window.innerHeight - dockerHeight - origin.getBoundingClientRect().top;
  return Math.max(0.25, Math.min(1, visibleBottom / frameRect.height));
}

interface PipOverlayLayerProps {
  frameRect: FrameRect;
  pipOverlays: PipOverlay[];
  currentOutputTime: number;
  totalOutputDuration: number;
  isPlaying: boolean;
  selectedPipOverlayId: string | null;
  onSelectPipOverlay: (id: string | null) => void;
  isPlacingPip: boolean;
  onPlacementPipConsumed: () => void;
  onAddPipOverlay: (sourcePath: string, sourceDuration: number, x: number, y: number, width: number, height: number, startTime: number, endTime: number) => string;
  onUpdatePipOverlayContent: (id: string, patch: PipOverlayPatch) => void;
  onDeletePipOverlay: (id: string) => void;
}

// Same click-vs-drag distinction every other drag surface in this app uses (VideoTimelineDocker's
// CLICK_DRAG_THRESHOLD_PX, VideoOverlayLayer's own image/blur box drags) - a plain click still
// selects/opens the popover; only a real drag past this many pixels commits a new position/size.
const CLICK_DRAG_THRESHOLD_PX = 4;
// Smallest pip box on either axis, as a fraction of the frame - same floor PipOverlayPopover's
// own Width/Height sliders already clamp to.
const MIN_PIP_FRACTION = 0.05;
const FULL_CROP: ClipCrop = { x: 0, y: 0, width: 1, height: 1 };

type Box = { x: number; y: number; width: number; height: number };
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

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

const validCrop = (crop: ClipCrop | undefined): ClipCrop =>
  crop && [crop.x, crop.y, crop.width, crop.height].every(Number.isFinite) && crop.width > 0 && crop.height > 0 ? crop : FULL_CROP;

// Moves the given edges of `start` by (dx, dy) frame fractions, anchored on the untouched side(s)
// and kept inside the frame. A corner drag with keepAspect scales uniformly instead, by whichever
// axis the pointer moved further along, still anchored on the opposite corner.
function resizePipBox(start: Box, edges: EdgeFlags, dx: number, dy: number, keepAspect: boolean): Box {
  const { left, right, top, bottom } = edges;
  let x0 = start.x;
  let x1 = start.x + start.width;
  let y0 = start.y;
  let y1 = start.y + start.height;
  if (left) x0 = clamp(x0 + dx, 0, x1 - MIN_PIP_FRACTION);
  else if (right) x1 = clamp(x1 + dx, x0 + MIN_PIP_FRACTION, 1);
  if (top) y0 = clamp(y0 + dy, 0, y1 - MIN_PIP_FRACTION);
  else if (bottom) y1 = clamp(y1 + dy, y0 + MIN_PIP_FRACTION, 1);

  const isCorner = (left || right) && (top || bottom);
  if (!keepAspect || !isCorner || start.width <= 0 || start.height <= 0) {
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  }

  const scaleW = (x1 - x0) / start.width;
  const scaleH = (y1 - y0) / start.height;
  const anchorX = left ? start.x + start.width : start.x;
  const anchorY = top ? start.y + start.height : start.y;
  const roomW = left ? anchorX : 1 - anchorX;
  const roomH = top ? anchorY : 1 - anchorY;
  const minScale = Math.max(MIN_PIP_FRACTION / start.width, MIN_PIP_FRACTION / start.height);
  const maxScale = Math.min(roomW / start.width, roomH / start.height);
  const scale = clamp(Math.abs(scaleW - 1) >= Math.abs(scaleH - 1) ? scaleW : scaleH, Math.min(minScale, maxScale), maxScale);
  const width = start.width * scale;
  const height = start.height * scale;
  return { x: left ? anchorX - width : anchorX, y: top ? anchorY - height : anchorY, width, height };
}

// Where to draw the full source <video> (in box-local pixels) so that just `crop`'s region of it
// "covers" a boxW x boxH box - the same centred cover-fit export's own crop -> scale(increase) ->
// crop(w:h) chain produces (pip_overlay_chain, conversion.rs), so preview and export frame
// identical pixels.
function coverLayout(boxW: number, boxH: number, srcW: number, srcH: number, crop: ClipCrop) {
  const cw = crop.width * srcW;
  const ch = crop.height * srcH;
  const scale = Math.max(boxW / cw, boxH / ch);
  return {
    scale,
    left: (boxW - cw * scale) / 2 - crop.x * srcW * scale,
    top: (boxH - ch * scale) / 2 - crop.y * srcH * scale,
    width: srcW * scale,
    height: srcH * scale,
  };
}

// Box for a pip after its crop changes to `crop`: keeps the source at the same on-screen scale and
// the kept content exactly where it already was, so cropping reads as "cut away the part not
// needed" rather than the remaining region zooming to refill the old box. Circles stay square
// (centred on the kept region). Clamped back inside the frame, shrinking only if it can't fit.
function fitBoxToCrop(o: PipOverlay, crop: ClipCrop, srcW: number, srcH: number, frameRect: FrameRect): Box {
  const fw = frameRect.width;
  const fh = frameRect.height;
  const boxW = o.width * fw;
  const boxH = o.height * fh;
  const layout = coverLayout(boxW, boxH, srcW, srcH, validCrop(o.crop));
  let left = o.x * fw + layout.left + crop.x * srcW * layout.scale;
  let top = o.y * fh + layout.top + crop.y * srcH * layout.scale;
  let width = crop.width * srcW * layout.scale;
  let height = crop.height * srcH * layout.scale;
  if (o.shape === "circle") {
    const side = Math.min(width, height);
    left += (width - side) / 2;
    top += (height - side) / 2;
    width = side;
    height = side;
  }
  const shrink = Math.min(1, fw / width, fh / height);
  if (shrink < 1) {
    left += (width - width * shrink) / 2;
    top += (height - height * shrink) / 2;
    width *= shrink;
    height *= shrink;
  }
  const w = Math.max(MIN_PIP_FRACTION, width / fw);
  const h = Math.max(MIN_PIP_FRACTION, height / fh);
  return { x: clamp(left / fw, 0, 1 - w), y: clamp(top / fh, 0, 1 - h), width: w, height: h };
}

// Keeps a pip's <video> in lockstep with the main player - hard-set only on a real discontinuity
// (a scrub/seek, or more than ~0.2s of drift), the same "let the browser's own playback clock carry
// it the rest of the way" reasoning VideoTimelineDocker's audio-overlay sync effect already uses,
// rather than fighting native playback with a write every tick. Shared by the on-canvas pip and
// PipCropEditor's own full-frame copy of it.
function usePipPlaybackSync(videoRef: React.RefObject<HTMLVideoElement | null>, overlay: PipOverlay, currentOutputTime: number, isPlaying: boolean) {
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const target = Math.max(0, overlay.trimStart + (currentOutputTime - overlay.startTime));
    if (Math.abs(video.currentTime - target) > 0.2) {
      video.currentTime = target;
    }
  }, [videoRef, currentOutputTime, overlay.trimStart, overlay.startTime]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (isPlaying) video.play().catch(() => {});
    else video.pause();
  }, [videoRef, isPlaying]);
}

// player.css styles every <video> in the app (max-height: 100%, object-fit: contain) for the main
// player - inline so it beats that element rule outright. Without it the pip's deliberately
// oversized source <video> (coverLayout) got clamped back to its box's height and letterboxed,
// showing a shrunken picture that no longer matched the pip's own box or the export.
const PIP_VIDEO_RESET_STYLE: React.CSSProperties = { maxWidth: "none", maxHeight: "none" };

type Gesture = { kind: "move" } | { kind: "resize"; edges: EdgeFlags };

// One PiP's own box + <video> - kept as a subcomponent (not inlined in the .map() below) so its
// currentTime/play-pause/drag state all follow the Rules of Hooks per-item, the same reason
// AudioChipWaveform (VideoTimelineDocker.tsx) is its own component rather than computed inline.
const PipVideoElement: React.FC<{
  overlay: PipOverlay;
  currentOutputTime: number;
  isPlaying: boolean;
  frameRect: FrameRect;
  isSelected: boolean;
  onSelect: () => void;
  onChangeBox: (box: Box) => void;
}> = ({ overlay, currentOutputTime, isPlaying, frameRect, isSelected, onSelect, onChangeBox }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [sourceSize, setSourceSize] = useState<{ width: number; height: number } | null>(null);

  usePipPlaybackSync(videoRef, overlay, currentOutputTime, isPlaying);

  // Volume is a plain property write (no attribute equivalent) - `muted` below is a real HTML
  // attribute instead, so both preview and export (pip_overlay_chain, conversion.rs) read the
  // exact same two fields. HTMLMediaElement.volume throws (not just clamps) on a non-finite value -
  // a real, reachable case here, not just defensive: a pip overlay saved by an older version of
  // this app (before `volume` existed on PipOverlay) loads back with volume:undefined, and
  // Math.min(1, undefined) is NaN. Falls back to the type's own documented default (1) exactly the
  // way every other "undefined means 1" field on this type already reads.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const volume = Number.isFinite(overlay.volume) ? overlay.volume : 1;
    video.volume = Math.max(0, Math.min(1, volume));
  }, [overlay.volume]);

  // Live (uncommitted) box while a move/resize gesture is in progress - only committed (one
  // onChangeBox -> one pushCommand) on release, so dragging never spams undo history with one
  // entry per pointer-move. liveRef mirrors it for the window listeners below.
  const [live, setLive] = useState<Box | null>(null);
  const liveRef = useRef<Box | null>(null);
  const gestureRef = useRef<{ gesture: Gesture; clientX: number; clientY: number; start: Box; moved: boolean } | null>(null);
  const propsRef = useRef({ frameRect, overlay, onChangeBox, onSelect });
  propsRef.current = { frameRect, overlay, onChangeBox, onSelect };

  const setLiveBox = (box: Box | null) => {
    liveRef.current = box;
    setLive(box);
  };

  const beginGesture = (gesture: Gesture) => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const start = { x: overlay.x, y: overlay.y, width: overlay.width, height: overlay.height };
    gestureRef.current = { gesture, clientX: e.clientX, clientY: e.clientY, start, moved: false };
  };

  useEffect(() => {
    const handleMove = (e: PointerEvent) => {
      const g = gestureRef.current;
      const { frameRect: fr, overlay: o } = propsRef.current;
      if (!g || fr.width <= 0 || fr.height <= 0) return;
      if (!g.moved && Math.abs(e.clientX - g.clientX) < CLICK_DRAG_THRESHOLD_PX && Math.abs(e.clientY - g.clientY) < CLICK_DRAG_THRESHOLD_PX) return;
      g.moved = true;
      const dx = (e.clientX - g.clientX) / fr.width;
      const dy = (e.clientY - g.clientY) / fr.height;
      if (g.gesture.kind === "move") {
        setLiveBox({ ...g.start, x: clamp(g.start.x + dx, 0, 1 - g.start.width), y: clamp(g.start.y + dy, 0, 1 - g.start.height) });
      } else {
        // A circle is always resized uniformly (it has no edge handles either) - stretching one
        // axis would turn it into an ellipse.
        const keepAspect = o.shape === "circle" || !e.shiftKey;
        setLiveBox(resizePipBox(g.start, g.gesture.edges, dx, dy, keepAspect));
      }
    };
    const handleUp = () => {
      const g = gestureRef.current;
      if (!g) return;
      gestureRef.current = null;
      const box = liveRef.current;
      if (g.moved && box) {
        // Committed and cleared in the same handler, so React batches both into one render - no
        // one-frame flash of the pre-drag box in between.
        propsRef.current.onChangeBox(box);
      } else if (!g.moved && g.gesture.kind === "move") {
        propsRef.current.onSelect();
      }
      setLiveBox(null);
    };
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    window.addEventListener("pointercancel", handleUp);
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      window.removeEventListener("pointercancel", handleUp);
    };
  }, []);

  const box = live ?? { x: overlay.x, y: overlay.y, width: overlay.width, height: overlay.height };
  const left = box.x * frameRect.width;
  const top = box.y * frameRect.height;
  const width = box.width * frameRect.width;
  const height = box.height * frameRect.height;
  // `ellipse(50% 50%)`, not `circle(50%)` - the latter's radius is measured against the box's
  // diagonal, so on any non-square box it spills past the sides and gets cut into an arch. Export
  // masks with the same inscribed ellipse (pip_overlay_chain).
  const clipPath = overlay.shape === "circle" ? "ellipse(50% 50% at 50% 50%)" : undefined;
  // Fraction of the pip box's OWN height - the same basis export's rounded mask uses.
  const borderRadius = overlay.shape === "rounded" ? (overlay.cornerRadius ?? 0.08) * height : 0;
  const layout = sourceSize ? coverLayout(width, height, sourceSize.width, sourceSize.height, validCrop(overlay.crop)) : null;

  const HIT = 20;
  const DOT = 9;
  const handles = overlay.shape === "circle" ? HANDLES.filter((h) => h.id.length === 2) : HANDLES;
  const handlePosition: Record<HandleId, { left: number; top: number }> = {
    nw: { left, top },
    ne: { left: left + width, top },
    sw: { left, top: top + height },
    se: { left: left + width, top: top + height },
    n: { left: left + width / 2, top },
    s: { left: left + width / 2, top: top + height },
    e: { left: left + width, top: top + height / 2 },
    w: { left, top: top + height / 2 },
  };

  return (
    <>
      <div
        data-pip-interactive
        onPointerDown={beginGesture({ kind: "move" })}
        title="Drag to move - click to edit size, shape and crop"
        className={`absolute overflow-hidden cursor-move ${isSelected ? "" : "hover:brightness-110"}`}
        style={{
          left,
          top,
          width,
          height,
          clipPath,
          WebkitClipPath: clipPath,
          borderRadius,
          pointerEvents: "auto",
          touchAction: "none",
          zIndex: isSelected ? SELECTED_PIP_Z_INDEX : undefined,
        }}
      >
        <video
          ref={videoRef}
          src={convertFileSrc(overlay.sourcePath)}
          muted={overlay.muted ?? true}
          playsInline
          loop
          draggable={false}
          onLoadedMetadata={(e) => {
            const size = { width: e.currentTarget.videoWidth, height: e.currentTarget.videoHeight };
            if (size.width > 0 && size.height > 0) setSourceSize(size);
          }}
          className={`absolute pointer-events-none ${layout ? "" : "inset-0"}`}
          style={
            layout
              ? { ...PIP_VIDEO_RESET_STYLE, objectFit: "fill", left: layout.left, top: layout.top, width: layout.width, height: layout.height }
              : { ...PIP_VIDEO_RESET_STYLE, objectFit: "cover", width: "100%", height: "100%" }
          }
        />
      </div>
      {isSelected && (
        <>
          {/* Selection frame drawn as its own element - an outline on the box itself would be cut
              away by the box's clip-path/border-radius. */}
          <div className="absolute outline outline-2 outline-dashed outline-white pointer-events-none" style={{ left, top, width, height, zIndex: SELECTED_PIP_Z_INDEX }} />
          {handles.map(({ id, edges, cursor }) => {
            const pos = handlePosition[id];
            return (
              <div
                key={id}
                data-pip-interactive
                onPointerDown={beginGesture({ kind: "resize", edges })}
                title={id.length === 2 && overlay.shape !== "circle" ? "Drag to resize (hold Shift to stretch)" : "Drag to resize"}
                className={`absolute flex items-center justify-center ${cursor}`}
                style={{ left: pos.left - HIT / 2, top: pos.top - HIT / 2, width: HIT, height: HIT, pointerEvents: "auto", touchAction: "none", zIndex: SELECTED_PIP_Z_INDEX }}
              >
                <div className="rounded-sm bg-white ring-1 ring-black/40" style={{ width: DOT, height: DOT }} />
              </div>
            );
          })}
        </>
      )}
    </>
  );
};

// Full-frame crop editor for one pip - the pip's source shown uncropped (contain-fit) over a dimmed
// preview, with ClipCropOverlay's own drag/resize crop window on top of it. A modal-style panel
// rather than cropping inside the pip box itself, for the same reason ImageOverlayCropPanel exists:
// a pip is usually small on screen, too small to crop precisely in place. Every crop drag commits
// straight away (ClipCropOverlay's own contract) - Done/Escape just closes the panel.
const PIP_CROP_PADDING = 16;
const PIP_CROP_TOOLBAR_HEIGHT = 40;

const PipCropEditor: React.FC<{
  overlay: PipOverlay;
  frameRect: FrameRect;
  // How much of the frame (px from its top) is actually visible above BottomDocker - the editor
  // confines itself to that, so its crop window and Done button never end up behind the timeline.
  visibleHeight: number;
  currentOutputTime: number;
  isPlaying: boolean;
  onChangeCrop: (crop: ClipCrop | undefined, sourceSize: { width: number; height: number }) => void;
  onDone: () => void;
}> = ({ overlay, frameRect, visibleHeight, currentOutputTime, isPlaying, onChangeCrop, onDone }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [sourceSize, setSourceSize] = useState<{ width: number; height: number } | null>(null);
  usePipPlaybackSync(videoRef, overlay, currentOutputTime, isPlaying);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        onDone();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onDone]);

  const areaW = Math.max(0, frameRect.width - PIP_CROP_PADDING * 2);
  const areaH = Math.max(0, visibleHeight - PIP_CROP_PADDING * 2 - PIP_CROP_TOOLBAR_HEIGHT);
  const fit = sourceSize ? computeLetterboxRect(areaW, areaH, sourceSize.width, sourceSize.height) : { left: 0, top: 0, width: areaW, height: areaH };

  return (
    <div
      data-pip-interactive
      className="absolute bg-black/85"
      style={{ left: 0, top: 0, width: frameRect.width, height: visibleHeight, pointerEvents: "auto", zIndex: SELECTED_PIP_Z_INDEX }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="absolute" style={{ left: PIP_CROP_PADDING + fit.left, top: PIP_CROP_PADDING + fit.top, width: fit.width, height: fit.height }}>
        <video
          ref={videoRef}
          src={convertFileSrc(overlay.sourcePath)}
          muted
          playsInline
          loop
          draggable={false}
          onLoadedMetadata={(e) => {
            const size = { width: e.currentTarget.videoWidth, height: e.currentTarget.videoHeight };
            if (size.width > 0 && size.height > 0) setSourceSize(size);
          }}
          className="absolute inset-0 pointer-events-none"
          style={{ ...PIP_VIDEO_RESET_STYLE, objectFit: "fill", width: "100%", height: "100%" }}
        />
        {sourceSize && (
          <ClipCropOverlay
            frameRect={{ left: 0, top: 0, width: fit.width, height: fit.height }}
            crop={overlay.crop}
            onChange={(crop) => onChangeCrop(crop, sourceSize)}
          />
        )}
      </div>
      <div
        className="absolute flex items-center justify-between gap-2 px-3 text-white/90"
        style={{ left: 0, right: 0, bottom: PIP_CROP_PADDING / 2, height: PIP_CROP_TOOLBAR_HEIGHT }}
      >
        <span className="text-xs text-white/70">Drag the edges to cut away the parts of the picture-in-picture you don't need</span>
        <div className="flex items-center gap-2">
          {overlay.crop && sourceSize && (
            <button type="button" onClick={() => onChangeCrop(undefined, sourceSize)} className="px-3 py-1 rounded text-xs text-white/70 hover:text-white hover:bg-white/10">
              Reset
            </button>
          )}
          <button type="button" onClick={onDone} className="px-3 py-1 rounded text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white">
            Done
          </button>
        </div>
      </div>
    </div>
  );
};

const PipOverlayLayer: React.FC<PipOverlayLayerProps> = ({
  frameRect,
  pipOverlays,
  currentOutputTime,
  totalOutputDuration,
  isPlaying,
  selectedPipOverlayId,
  onSelectPipOverlay,
  isPlacingPip,
  onPlacementPipConsumed,
  onAddPipOverlay,
  onUpdatePipOverlayContent,
  onDeletePipOverlay,
}) => {
  const [popoverOpen, setPopoverOpen] = useState(false);
  // Zero-size marker at the frame's own top-left (this layer's coordinate origin) - lets the
  // popover anchor and default placement below convert frame fractions to viewport pixels.
  const originRef = useRef<HTMLDivElement>(null);
  // The pip whose PipCropEditor is open, if any - opened from PipOverlayPopover's Crop button.
  const [croppingPipId, setCroppingPipId] = useState<string | null>(null);

  // Same "snapshot once, synchronously, right as placement is armed" reasoning as VideoOverlayLayer's
  // own image-placement effect - avoids re-running (and re-opening the file dialog) if unrelated
  // props change while the (possibly long) picker/metadata-probe await is still pending.
  const placeContextRef = useRef({ frameRect, currentOutputTime, totalOutputDuration, onAddPipOverlay, onSelectPipOverlay, onPlacementPipConsumed });
  useEffect(() => {
    placeContextRef.current = { frameRect, currentOutputTime, totalOutputDuration, onAddPipOverlay, onSelectPipOverlay, onPlacementPipConsumed };
  });

  useEffect(() => {
    if (!isPlacingPip) return;
    const { frameRect, currentOutputTime, totalOutputDuration, onAddPipOverlay, onSelectPipOverlay, onPlacementPipConsumed } = placeContextRef.current;
    let cancelled = false;
    (async () => {
      try {
        const selected = await openFileDialog({ multiple: false, filters: [{ name: "Video", extensions: FILE_CATEGORY_EXTENSIONS.video }] });
        if (cancelled || !selected || Array.isArray(selected)) return; // cancelled

        const src = convertFileSrc(selected);
        // A hidden <video>'s loadedmetadata gives both aspect ratio AND duration in one probe -
        // no ffprobe round-trip needed, unlike AudioOverlay's own duration lookup (get_conversion_info),
        // since this app already has WebView2's native video decoder available client-side.
        const metadata = await new Promise<{ width: number; height: number; duration: number } | null>((resolve) => {
          const video = document.createElement("video");
          video.preload = "metadata";
          video.onloadedmetadata = () => resolve({ width: video.videoWidth, height: video.videoHeight, duration: video.duration });
          video.onerror = () => resolve(null);
          video.src = src;
        });
        if (cancelled || !metadata || !(metadata.duration > 0)) return;

        const width = DEFAULT_PIP_WIDTH_FRACTION;
        const aspect = metadata.height > 0 ? metadata.width / metadata.height : 1;
        const height = frameRect.height > 0 ? (width * frameRect.width) / aspect / frameRect.height : width;
        const x = Math.max(0, 1 - width - DEFAULT_PIP_MARGIN_FRACTION);
        // Bottom-right of the part of the frame actually visible - VideoPlayer is full window height
        // and BottomDocker (publishing its height as --docker-height) is drawn over its lower edge,
        // so the frame's true bottom corner is often hidden behind the timeline, where the new pip
        // could be neither seen nor grabbed.
        const y = Math.max(0, visibleFrameBottomFraction(originRef.current, frameRect) - height - DEFAULT_PIP_MARGIN_FRACTION);
        const startTime = currentOutputTime;
        const duration = Math.min(metadata.duration, MAX_INITIAL_PIP_DURATION_SEC, Math.max(1, totalOutputDuration - startTime));
        const endTime = startTime + duration;

        const id = onAddPipOverlay(selected, metadata.duration, x, y, width, height, startTime, endTime);
        onSelectPipOverlay(id);
        setPopoverOpen(true);
      } catch (err) {
        console.error("Failed to add PiP overlay:", err);
      } finally {
        if (!cancelled) onPlacementPipConsumed();
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlacingPip]);

  const active = overlaysActiveAt(pipOverlays, currentOutputTime);
  const selected = selectedPipOverlayId ? pipOverlays.find((o) => o.id === selectedPipOverlayId) : undefined;
  const cropping = croppingPipId ? pipOverlays.find((o) => o.id === croppingPipId) : undefined;

  // Switching a pip to "circle" also squares its box (same on-screen centre, side = the box's
  // shorter side) - the mask is the ellipse inscribed in the box, so without this a wide box would
  // turn into an oval rather than the circle the user just picked.
  const patchWithSquareCircle = (o: PipOverlay, patch: PipOverlayPatch): PipOverlayPatch => {
    if (patch.shape !== "circle" || o.shape === "circle" || frameRect.width <= 0 || frameRect.height <= 0) return patch;
    const sidePx = Math.min(o.width * frameRect.width, o.height * frameRect.height);
    const width = sidePx / frameRect.width;
    const height = sidePx / frameRect.height;
    return {
      ...patch,
      width,
      height,
      x: clamp(o.x + (o.width - width) / 2, 0, 1 - width),
      y: clamp(o.y + (o.height - height) / 2, 0, 1 - height),
    };
  };

  // Beside the pip's CURRENT box (recomputed every render, so it follows a move/resize instead of
  // staying where it first opened and ending up on top of the handles), on the right when there's
  // room for it, otherwise on the left.
  const popoverAnchorFor = (o: PipOverlay) => {
    const origin = originRef.current?.getBoundingClientRect() ?? { left: frameRect.left, top: frameRect.top };
    const boxLeft = origin.left + o.x * frameRect.width;
    const boxRight = boxLeft + o.width * frameRect.width;
    const top = origin.top + o.y * frameRect.height;
    const fitsRight = boxRight + POPOVER_GAP_PX + POPOVER_WIDTH_PX <= window.innerWidth;
    return { left: fitsRight ? boxRight + POPOVER_GAP_PX : boxLeft - POPOVER_GAP_PX - POPOVER_WIDTH_PX, top };
  };

  return (
    <>
      <div ref={originRef} className="absolute left-0 top-0 w-0 h-0 pointer-events-none" />
      {active.map((o) => (
        <PipVideoElement
          key={o.id}
          overlay={o}
          currentOutputTime={currentOutputTime}
          isPlaying={isPlaying}
          frameRect={frameRect}
          isSelected={selectedPipOverlayId === o.id}
          onSelect={() => {
            // A click on the pip whose popover is already open closes it; otherwise (unselected, or
            // selected but with the popover dismissed - e.g. right after the crop editor closes)
            // opens it.
            if (selectedPipOverlayId === o.id && popoverOpen) {
              onSelectPipOverlay(null);
              setPopoverOpen(false);
            } else {
              onSelectPipOverlay(o.id);
              setPopoverOpen(true);
            }
          }}
          onChangeBox={(box) => onUpdatePipOverlayContent(o.id, box)}
        />
      ))}
      {selected && popoverOpen && !cropping && (
        <PipOverlayPopover
          overlay={selected}
          anchor={popoverAnchorFor(selected)}
          onUpdate={(patch) => onUpdatePipOverlayContent(selected.id, patchWithSquareCircle(selected, patch))}
          onDelete={() => {
            onDeletePipOverlay(selected.id);
            onSelectPipOverlay(null);
            setPopoverOpen(false);
          }}
          onClose={() => {
            onSelectPipOverlay(null);
            setPopoverOpen(false);
          }}
          onStartCrop={() => {
            setCroppingPipId(selected.id);
            setPopoverOpen(false);
          }}
        />
      )}
      {cropping && (
        <PipCropEditor
          key={cropping.id}
          overlay={cropping}
          frameRect={frameRect}
          visibleHeight={visibleFrameBottomFraction(originRef.current, frameRect) * frameRect.height}
          currentOutputTime={currentOutputTime}
          isPlaying={isPlaying}
          onChangeCrop={(crop, size) => {
            // Box follows the crop (fitBoxToCrop) in the same undo step, so trimming an edge off
            // the source visibly trims that edge off the pip too, instead of the remainder zooming in.
            const box = frameRect.width > 0 && frameRect.height > 0 ? fitBoxToCrop(cropping, crop ?? FULL_CROP, size.width, size.height, frameRect) : {};
            onUpdatePipOverlayContent(cropping.id, { ...box, crop });
          }}
          onDone={() => setCroppingPipId(null)}
        />
      )}
    </>
  );
};

export default PipOverlayLayer;
