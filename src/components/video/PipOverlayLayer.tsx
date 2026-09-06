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
// Deliberately its own small component, mounted as a sibling to VideoOverlayLayer (Dashboard.tsx's
// `overlay` render-prop) rather than folded into VideoOverlayLayer's much larger per-type drag/
// resize/rotate/context-menu machinery: position is dragged directly on the video itself
// (PipVideoElement's own pointer handlers below), but size/shape are still edited through
// PipOverlayPopover's numeric sliders rather than an on-canvas resize handle, which is what keeps
// this file smaller than VideoOverlayLayer's. A future pass could add on-canvas resizing the way
// image/blur overlays have it, following the same pattern VideoOverlayLayer.tsx already establishes.
import React, { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { PipOverlay } from "../../utils/videoEditTypes";
import { overlaysActiveAt } from "../../handlers/videoEditHandlers";
import { FrameRect } from "../../utils/videoFrameRect";
import { FILE_CATEGORY_EXTENSIONS } from "../../utils/fileCategory";
import PipOverlayPopover, { PipOverlayPatch } from "./PipOverlayPopover";

const DEFAULT_PIP_WIDTH_FRACTION = 0.28;
const DEFAULT_PIP_MARGIN_FRACTION = 0.04;
// A freshly-placed PiP plays for its own full source length (up to this cap) rather than the
// generic 5s every other overlay kind defaults to - a webcam recording is usually meant to run
// alongside most of the screen recording, not just a brief 5-second window.
const MAX_INITIAL_PIP_DURATION_SEC = 120;

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
// selects/opens the popover; only a real drag past this many pixels commits a new position.
const CLICK_DRAG_THRESHOLD_PX = 4;

// One PiP's own <video> element - kept as a subcomponent (not inlined in the .map() below) so its
// currentTime/play-pause/drag state all follow the Rules of Hooks per-item, the same reason
// AudioChipWaveform (VideoTimelineDocker.tsx) is its own component rather than computed inline.
const PipVideoElement: React.FC<{
  overlay: PipOverlay;
  currentOutputTime: number;
  isPlaying: boolean;
  frameRect: FrameRect;
  isSelected: boolean;
  onSelect: (anchor: { left: number; top: number }) => void;
  onMove: (x: number, y: number) => void;
}> = ({ overlay, currentOutputTime, isPlaying, frameRect, isSelected, onSelect, onMove }) => {
  const videoRef = useRef<HTMLVideoElement>(null);

  // Keeps this PiP's own <video> in lockstep with the main player - hard-set only on a real
  // discontinuity (a scrub/seek, or more than ~0.2s of drift), the same "let the browser's own
  // playback clock carry it the rest of the way" reasoning VideoTimelineDocker's audio-overlay
  // sync effect already uses, rather than fighting native playback with a write every tick.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const target = Math.max(0, overlay.trimStart + (currentOutputTime - overlay.startTime));
    if (Math.abs(video.currentTime - target) > 0.2) {
      video.currentTime = target;
    }
  }, [currentOutputTime, overlay.trimStart, overlay.startTime]);

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

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (isPlaying) video.play().catch(() => {});
    else video.pause();
  }, [isPlaying]);

  // On-canvas drag-to-reposition - live-previewed locally (liveX/liveY) exactly like
  // VideoOverlayLayer's own image/blur box drags, and only committed (onMove, one pushCommand) on
  // release, so dragging never spams undo history with one entry per pointer-move.
  const [drag, setDrag] = useState<null | { startClientX: number; startClientY: number; startX: number; startY: number; liveX: number; liveY: number; isDragging: boolean }>(
    null
  );

  const handlePointerDown = (e: React.PointerEvent<HTMLVideoElement>) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ startClientX: e.clientX, startClientY: e.clientY, startX: overlay.x, startY: overlay.y, liveX: overlay.x, liveY: overlay.y, isDragging: false });
  };
  const handlePointerMove = (e: React.PointerEvent<HTMLVideoElement>) => {
    if (!drag || frameRect.width <= 0 || frameRect.height <= 0) return;
    e.stopPropagation();
    const moved = Math.abs(e.clientX - drag.startClientX) >= CLICK_DRAG_THRESHOLD_PX || Math.abs(e.clientY - drag.startClientY) >= CLICK_DRAG_THRESHOLD_PX;
    const dx = (e.clientX - drag.startClientX) / frameRect.width;
    const dy = (e.clientY - drag.startClientY) / frameRect.height;
    const liveX = Math.max(0, Math.min(1 - overlay.width, drag.startX + dx));
    const liveY = Math.max(0, Math.min(1 - overlay.height, drag.startY + dy));
    setDrag((prev) => (prev ? { ...prev, isDragging: prev.isDragging || moved, liveX, liveY } : prev));
  };
  const handlePointerUp = (e: React.PointerEvent<HTMLVideoElement>) => {
    if (!drag) return;
    const { isDragging, liveX, liveY } = drag;
    setDrag(null);
    if (isDragging) {
      onMove(liveX, liveY);
    } else {
      // A plain click (never exceeded the drag threshold) - select/open the popover instead of
      // committing a no-op position update.
      const rect = e.currentTarget.getBoundingClientRect();
      onSelect({ left: rect.right + 8, top: rect.top });
    }
  };

  const displayX = drag ? drag.liveX : overlay.x;
  const displayY = drag ? drag.liveY : overlay.y;
  const clipPath = overlay.shape === "circle" ? "circle(50% at 50% 50%)" : undefined;
  const borderRadius = overlay.shape === "rounded" ? (overlay.cornerRadius ?? 0.08) * frameRect.height : 0;

  return (
    <video
      ref={videoRef}
      src={convertFileSrc(overlay.sourcePath)}
      muted={overlay.muted ?? true}
      playsInline
      loop
      draggable={false}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      title="Drag to reposition - click to edit size and shape"
      className={`absolute object-cover cursor-move outline outline-2 transition-colors ${
        isSelected ? "outline-dashed outline-white" : "outline-transparent hover:outline-white/40"
      }`}
      style={{
        left: displayX * frameRect.width,
        top: displayY * frameRect.height,
        width: overlay.width * frameRect.width,
        height: overlay.height * frameRect.height,
        clipPath,
        WebkitClipPath: clipPath,
        borderRadius,
      }}
    />
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
  const [popoverAnchor, setPopoverAnchor] = useState<{ left: number; top: number } | null>(null);

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
        const y = Math.max(0, 1 - height - DEFAULT_PIP_MARGIN_FRACTION);
        const startTime = currentOutputTime;
        const duration = Math.min(metadata.duration, MAX_INITIAL_PIP_DURATION_SEC, Math.max(1, totalOutputDuration - startTime));
        const endTime = startTime + duration;

        const id = onAddPipOverlay(selected, metadata.duration, x, y, width, height, startTime, endTime);
        onSelectPipOverlay(id);
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

  return (
    <>
      {active.map((o) => (
        <PipVideoElement
          key={o.id}
          overlay={o}
          currentOutputTime={currentOutputTime}
          isPlaying={isPlaying}
          frameRect={frameRect}
          isSelected={selectedPipOverlayId === o.id}
          onSelect={(anchor) => {
            onSelectPipOverlay(selectedPipOverlayId === o.id ? null : o.id);
            setPopoverAnchor(anchor);
          }}
          onMove={(x, y) => onUpdatePipOverlayContent(o.id, { x, y })}
        />
      ))}
      {selected && popoverAnchor && (
        <PipOverlayPopover
          overlay={selected}
          anchor={popoverAnchor}
          onUpdate={(patch) => onUpdatePipOverlayContent(selected.id, patch)}
          onDelete={() => {
            onDeletePipOverlay(selected.id);
            onSelectPipOverlay(null);
            setPopoverAnchor(null);
          }}
          onClose={() => {
            onSelectPipOverlay(null);
            setPopoverAnchor(null);
          }}
        />
      )}
    </>
  );
};

export default PipOverlayLayer;
