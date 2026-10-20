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
import React, { useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { ClipCrop, PipOverlay } from "../../utils/videoEditTypes";
import { overlaysActiveAt } from "../../handlers/videoEditHandlers";
import { FrameRect, computeLetterboxRect } from "../../utils/videoFrameRect";
import { MEDIA_VIDEO_EXTENSIONS } from "../../utils/fileCategory";
import PipOverlayPopover, { PipOverlayPatch } from "./PipOverlayPopover";
import { cssBlendMode } from "../../utils/blendModes";
import ClipCropOverlay from "./ClipCropOverlay";
import { isNeutralFx } from "../../utils/audioFx";
import { syncElementFx } from "../../utils/mixerGraph";
import { pipChannelKey, silencedBySolo, useMixerSession } from "../../utils/mixerState";
import { isTrackHidden, layerOpacityAt, pipTrack, stackOrder } from "../../utils/videoTracks";
import { DEFAULT_CHROMA_KEY, guessKeyColor } from "../../utils/chromaKey";
import { blurMargin, blurSigma, coverRect } from "../../utils/cutoutBackground";
import { DEFAULT_MASK, layerMaskAlphaUrl, placeMask, revealMaskCss, revealMaskPicture, revealStartingMask, type LayerMask } from "../../utils/layerMask";
import ChromaKeyCanvas from "./ChromaKeyCanvas";
import MaskEditor from "./MaskEditor";

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
  // The player's exact output time, for fades smoother than currentOutputTime's few ticks a second.
  getOutputTime?: () => number | null;
  // Video tracks switched off (VideoEditState.hiddenVideoTracks).
  hiddenTracks?: number[];
  // Opens the selected pip's panel when it changes (a fresh object each time) - e.g. right after a
  // webcam bubble is lifted off the recording, to show its background being removed.
  panelRequest?: { id: string } | null;
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
function usePipPlaybackSync(videoRef: React.RefObject<HTMLMediaElement | null>, overlay: PipOverlay, currentOutputTime: number, isPlaying: boolean) {
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

// The current frame of `video`, as pixels (asset:// video is CORS-clean - crossOrigin set below).
function videoFramePixels(video: HTMLVideoElement): ImageData | null {
  if (video.readyState < 2 || video.videoWidth === 0) return null;
  const c = document.createElement("canvas");
  c.width = video.videoWidth;
  c.height = video.videoHeight;
  const g = c.getContext("2d", { willReadFrequently: true });
  if (!g) return null;
  g.drawImage(video, 0, 0);
  try {
    return g.getImageData(0, 0, c.width, c.height);
  } catch {
    return null;
  }
}

// The average colour of a 5x5 patch of the frame around source pixel (x, y).
function sampleFrameColor(frame: ImageData, x: number, y: number): string {
  const sum = [0, 0, 0];
  let n = 0;
  for (let j = -2; j <= 2; j++) {
    for (let i = -2; i <= 2; i++) {
      const px = clamp(Math.round(x) + i, 0, frame.width - 1);
      const py = clamp(Math.round(y) + j, 0, frame.height - 1);
      const k = (py * frame.width + px) * 4;
      sum[0] += frame.data[k];
      sum[1] += frame.data[k + 1];
      sum[2] += frame.data[k + 2];
      n++;
    }
  }
  return `#${sum.map((v) => Math.round(v / n).toString(16).padStart(2, "0")).join("")}`;
}

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
  getOutputTime?: () => number | null;
  // Registers its <video> (green-screen colour picking and guessing need its frames).
  onVideo: (video: HTMLVideoElement | null) => void;
  // A click on it picks the green screen's colour instead of selecting/moving it.
  pickingKey: boolean;
  onPickKey: (color: string) => void;
  // The mask while it's being dragged in the mask editor.
  maskLive: LayerMask | null;
}> = ({ overlay, currentOutputTime, isPlaying, frameRect, isSelected, onSelect, onChangeBox, getOutputTime, onVideo, pickingKey, onPickKey, maskLive }) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);
  // Background removed: the cut-out plays as the picture (silent), and the source's own sound - when
  // it's switched on - from a hidden <audio> kept in step the same way.
  // A cut-out that won't load (deleted with the derived media) falls back to the original.
  const [cutoutFailed, setCutoutFailed] = useState<string | null>(null);
  const cutout = overlay.cutout && overlay.cutout.sourcePath === overlay.sourcePath && cutoutFailed !== overlay.cutout.path ? overlay.cutout.path : null;
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const sounds = overlay.muted === false;
  const boxRef = useRef<HTMLDivElement>(null);
  // WebGL keying unavailable - the plain video shows (export still keys).
  const [keyFailed, setKeyFailed] = useState(false);

  // Opacity and fade in/out (videoTracks.ts) - fades follow the player's exact time every frame,
  // as export ramps the alpha linearly per frame.
  const fading = (overlay.fadeIn ?? 0) > 0 || (overlay.fadeOut ?? 0) > 0;
  const overlayRef = useRef(overlay);
  overlayRef.current = overlay;
  useEffect(() => {
    if (!fading) return;
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const now = getOutputTime?.();
      if (now === null || now === undefined || !boxRef.current) return;
      boxRef.current.style.opacity = String(layerOpacityAt(overlayRef.current, now));
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [fading, getOutputTime]);
  const [sourceSize, setSourceSize] = useState<{ width: number; height: number } | null>(null);

  usePipPlaybackSync(videoRef, overlay, currentOutputTime, isPlaying);
  usePipPlaybackSync(audioRef, overlay, currentOutputTime, isPlaying);
  // What shows behind the cut-out person (cutoutBackground.ts) - for "blur", the original video
  // again, blurred, kept in step like the rest.
  const cutoutRegion = cutout ? overlay.cutout?.region : undefined;
  const background = cutout ? overlay.cutout?.background : undefined;
  const bgVideoRef = useRef<HTMLVideoElement | null>(null);
  const [originalSize, setOriginalSize] = useState<{ width: number; height: number } | null>(null);
  usePipPlaybackSync(bgVideoRef, overlay, currentOutputTime, isPlaying);

  // Volume is a plain property write (no attribute equivalent) - `muted` below is a real HTML
  // attribute instead, so both preview and export (pip_overlay_chain, conversion.rs) read the
  // exact same two fields. HTMLMediaElement.volume throws (not just clamps) on a non-finite value -
  // a real, reachable case here, not just defensive: a pip overlay saved by an older version of
  // this app (before `volume` existed on PipOverlay) loads back with volume:undefined, and
  // Math.min(1, undefined) is NaN. Falls back to the type's own documented default (1) exactly the
  // way every other "undefined means 1" field on this type already reads.
  // Solo on another mixer channel silences it (preview only); its mixer effects route it through
  // the track-fx worklet (mixerGraph.ts) once it has any, or the mixer's meters want it.
  const mixer = useMixerSession();
  const soloOff = silencedBySolo(mixer, pipChannelKey(overlay.id));
  useEffect(() => {
    const sound = cutout ? audioRef.current : videoRef.current;
    if (!sound) return;
    const volume = Number.isFinite(overlay.volume) ? overlay.volume : 1;
    sound.volume = soloOff ? 0 : Math.max(0, Math.min(1, volume));
  }, [overlay.volume, soloOff, cutout, sounds]);
  useEffect(() => {
    const sound = cutout ? audioRef.current : videoRef.current;
    if (!sound || overlay.muted !== false) return;
    syncElementFx(sound, `pip:${overlay.id}`, overlay.fx, !isNeutralFx(overlay.fx) || mixer.open);
  }, [overlay.id, overlay.fx, overlay.muted, mixer.open, cutout]);

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
    if (pickingKey && gesture.kind === "move") {
      // The pixel under the pointer, in the source frame (through the box's cover layout).
      const video = videoRef.current;
      const rect = boxRef.current?.getBoundingClientRect();
      const frame = video ? videoFramePixels(video) : null;
      if (video && rect && frame && layout) {
        onPickKey(sampleFrameColor(frame, (e.clientX - rect.left - layout.left) / layout.scale, (e.clientY - rect.top - layout.top) / layout.scale));
      }
      return;
    }
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
  // A cut-out of just a region is already cropped to it.
  const layout = sourceSize ? coverLayout(width, height, sourceSize.width, sourceSize.height, validCrop(cutoutRegion ? undefined : overlay.crop)) : null;
  // A mask (with the shape folded in) shows through the same picture export multiplies in
  // (layerMask.ts), at the box's on-screen size.
  const mask = maskLive ?? overlay.mask;
  const maskKey = mask ? JSON.stringify(mask) : "";
  // A revealing mask (not while it's being edited - that shows it open) is its shape's picture
  // placed per frame, over the layer's own shape.
  const reveal = !maskLive && mask?.reveal ? mask : null;
  const maskUrl = useMemo(
    () => (mask && !reveal && width >= 1 && height >= 1 ? layerMaskAlphaUrl({ shape: overlay.shape, cornerRadius: overlay.cornerRadius, mask }, width, height) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [maskKey, !!reveal, overlay.shape, overlay.cornerRadius, Math.round(width), Math.round(height)]
  );
  const revealPic = useMemo(
    () => (reveal && width >= 1 && height >= 1 ? revealMaskPicture(reveal, width, height, false) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [maskKey, !!reveal, Math.round(width), Math.round(height)]
  );
  const shapeUrl = useMemo(
    () => (revealPic && overlay.shape && overlay.shape !== "rectangle" ? layerMaskAlphaUrl({ shape: overlay.shape, cornerRadius: overlay.cornerRadius }, width, height) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [!!revealPic, overlay.shape, overlay.cornerRadius, Math.round(width), Math.round(height)]
  );
  const span = overlay.endTime - overlay.startTime;
  const revealCss = (now: number) => (reveal && revealPic ? revealMaskCss(reveal, revealPic, shapeUrl, now - overlay.startTime, span, width, height) : null);
  const revealCssRef = useRef(revealCss);
  revealCssRef.current = revealCss;
  useEffect(() => {
    if (!revealPic) return;
    let raf = 0;
    let last = "";
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const now = getOutputTime?.();
      if (now === null || now === undefined || !boxRef.current) return;
      const css = revealCssRef.current(now);
      if (!css || css.maskPosition === last) return;
      last = css.maskPosition;
      const style = boxRef.current.style as unknown as Record<string, string>;
      style.maskPosition = style.webkitMaskPosition = css.maskPosition;
      style.maskSize = style.webkitMaskSize = css.maskSize;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [revealPic, getOutputTime]);
  const maskStyle: React.CSSProperties = maskUrl
    ? { maskImage: `url(${maskUrl})`, WebkitMaskImage: `url(${maskUrl})`, maskSize: "100% 100%", WebkitMaskSize: "100% 100%", maskRepeat: "no-repeat", WebkitMaskRepeat: "no-repeat" }
    : ((revealCss(currentOutputTime) ?? {}) as React.CSSProperties);
  const masked = !!maskUrl || !!revealPic;
  const keyed = !cutout && !!overlay.chromaKey && !keyFailed;
  // The blurred original: fitted to the box grown by the blur's reach on every side, so the edges
  // inside the box stay full - as export draws it (cutoutBackgroundForExport).
  const blurStyle: React.CSSProperties | null = (() => {
    if (background?.kind !== "blur" || !originalSize) return null;
    const sigma = blurSigma(background.amount, height);
    const m = blurMargin(sigma);
    const r = coverRect(width + 2 * m, height + 2 * m, originalSize.width, originalSize.height, cutoutRegion ?? validCrop(overlay.crop));
    return { ...PIP_VIDEO_RESET_STYLE, objectFit: "fill", left: r.left - m, top: r.top - m, width: r.width, height: r.height, filter: `blur(${sigma}px)` };
  })();
  const mediaStyle: React.CSSProperties = layout
    ? { ...PIP_VIDEO_RESET_STYLE, objectFit: "fill", left: layout.left, top: layout.top, width: layout.width, height: layout.height }
    : { ...PIP_VIDEO_RESET_STYLE, objectFit: "cover", width: "100%", height: "100%" };

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
        ref={boxRef}
        data-pip-interactive
        onPointerDown={beginGesture({ kind: "move" })}
        title={pickingKey ? "Click the green screen to key out that colour" : "Drag to move - click to edit size, shape and crop"}
        className={`absolute overflow-hidden ${pickingKey ? "cursor-crosshair" : "cursor-move"} ${isSelected ? "" : "hover:brightness-110"}`}
        style={{
          left,
          top,
          width,
          height,
          // The mask picture carries the shape too, when there is one.
          clipPath: masked ? undefined : clipPath,
          WebkitClipPath: masked ? undefined : clipPath,
          borderRadius: masked ? 0 : borderRadius,
          ...maskStyle,
          pointerEvents: "auto",
          touchAction: "none",
          zIndex: isSelected ? SELECTED_PIP_Z_INDEX : undefined,
          mixBlendMode: cssBlendMode(overlay.blendMode),
          opacity: layerOpacityAt(overlay, currentOutputTime),
        }}
      >
        {background?.kind === "color" && <div className="absolute inset-0 pointer-events-none" style={{ background: background.color }} />}
        {background?.kind === "image" && (
          <img src={convertFileSrc(background.path)} alt="" draggable={false} className="absolute inset-0 w-full h-full object-cover pointer-events-none" style={PIP_VIDEO_RESET_STYLE} />
        )}
        {background?.kind === "blur" && (
          <video
            ref={bgVideoRef}
            src={convertFileSrc(overlay.sourcePath)}
            muted
            playsInline
            loop
            draggable={false}
            onLoadedMetadata={(e) => {
              const size = { width: e.currentTarget.videoWidth, height: e.currentTarget.videoHeight };
              if (size.width > 0 && size.height > 0) setOriginalSize(size);
            }}
            className="absolute pointer-events-none"
            style={blurStyle ?? { opacity: 0 }}
          />
        )}
        <video
          ref={(el) => {
            videoRef.current = el;
            setVideoEl(el);
            onVideo(el);
          }}
          src={convertFileSrc(cutout ?? overlay.sourcePath)}
          // Lets Web Audio read its sound (the mixer) - asset:// answers CORS.
          crossOrigin="anonymous"
          muted={cutout ? true : overlay.muted ?? true}
          onError={() => cutout && setCutoutFailed(cutout)}
          playsInline
          loop
          draggable={false}
          onLoadedMetadata={(e) => {
            const size = { width: e.currentTarget.videoWidth, height: e.currentTarget.videoHeight };
            if (size.width > 0 && size.height > 0) setSourceSize(size);
          }}
          className={`absolute pointer-events-none ${layout ? "" : "inset-0"}`}
          style={mediaStyle}
        />
        {cutout && sounds && <audio ref={audioRef} src={convertFileSrc(overlay.sourcePath)} crossOrigin="anonymous" preload="auto" style={{ display: "none" }} />}
        {keyed && overlay.chromaKey && (
          <ChromaKeyCanvas
            video={videoEl}
            chromaKey={overlay.chromaKey}
            className={`absolute pointer-events-none ${layout ? "" : "inset-0"}`}
            style={mediaStyle}
            onUnavailable={() => setKeyFailed(true)}
          />
        )}
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
  getOutputTime,
  hiddenTracks,
  panelRequest,
}) => {
  const [popoverOpen, setPopoverOpen] = useState(false);
  useEffect(() => {
    if (panelRequest) setPopoverOpen(true);
  }, [panelRequest]);
  // Zero-size marker at the frame's own top-left (this layer's coordinate origin) - lets the
  // popover anchor and default placement below convert frame fractions to viewport pixels.
  const originRef = useRef<HTMLDivElement>(null);
  // The pip whose PipCropEditor is open, if any - opened from PipOverlayPopover's Crop button.
  const [croppingPipId, setCroppingPipId] = useState<string | null>(null);
  // Each active pip's <video>, for reading its frames (green-screen colour).
  const videoEls = useRef(new Map<string, HTMLVideoElement>());
  // Picking the green screen's colour on a pip (its next click samples the frame).
  const [pickingKeyFor, setPickingKeyFor] = useState<string | null>(null);
  // Editing a pip's mask on the canvas (MaskEditor), and whether the next drag draws a new outline.
  const [maskEdit, setMaskEdit] = useState<{ id: string; drawing: boolean } | null>(null);
  const [maskLive, setMaskLive] = useState<LayerMask | null>(null);
  // Escape leaves picking/mask editing.
  useEffect(() => {
    if (!pickingKeyFor && !maskEdit) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setPickingKeyFor(null);
      setMaskEdit(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [pickingKeyFor, maskEdit]);
  // Both end when the pip is no longer the selected one.
  useEffect(() => {
    if (pickingKeyFor && pickingKeyFor !== selectedPipOverlayId) setPickingKeyFor(null);
    if (maskEdit && maskEdit.id !== selectedPipOverlayId) setMaskEdit(null);
  }, [selectedPipOverlayId, pickingKeyFor, maskEdit]);

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
        const selected = await openFileDialog({ multiple: false, filters: [{ name: "Video", extensions: [...MEDIA_VIDEO_EXTENSIONS] }] });
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
        // Bottom-right of the part of the frame actually visible - VideoPlayer now reserves
        // --docker-height so this is normally the frame's own corner, but this stays as a guard
        // for any frame BottomDocker still overlaps, where a new pip hidden behind the timeline
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

  // Bottom track first, so later DOM draws over earlier - the export's compositing order.
  const active = stackOrder(overlaysActiveAt(pipOverlays, currentOutputTime).filter((o) => !isTrackHidden(hiddenTracks, pipTrack(o))));
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
          getOutputTime={getOutputTime}
          onVideo={(el) => {
            if (el) videoEls.current.set(o.id, el);
            else videoEls.current.delete(o.id);
          }}
          pickingKey={pickingKeyFor === o.id}
          onPickKey={(color) => {
            onUpdatePipOverlayContent(o.id, { chromaKey: { ...(o.chromaKey ?? DEFAULT_CHROMA_KEY), color } });
            setPickingKeyFor(null);
          }}
          maskLive={maskEdit?.id === o.id ? maskLive : null}
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
          onEnableKey={() => {
            // Start from the screen's own colour: the median of the frame's border.
            const video = videoEls.current.get(selected.id);
            const frame = video ? videoFramePixels(video) : null;
            const color = frame ? guessKeyColor(frame.data, frame.width, frame.height) : DEFAULT_CHROMA_KEY.color;
            onUpdatePipOverlayContent(selected.id, { chromaKey: { ...DEFAULT_CHROMA_KEY, color } });
          }}
          pickingKey={pickingKeyFor === selected.id}
          onTogglePickKey={() => setPickingKeyFor((id) => (id === selected.id ? null : selected.id))}
          maskEditing={maskEdit?.id === selected.id}
          onSetMaskShape={(shape) => {
            if (shape === null) {
              onUpdatePipOverlayContent(selected.id, { mask: undefined });
              setMaskEdit(null);
            } else if (shape === "path") {
              setMaskEdit({ id: selected.id, drawing: true });
            } else {
              const from = selected.mask ?? DEFAULT_MASK;
              onUpdatePipOverlayContent(selected.id, { mask: { ...from, shape, points: undefined } });
              setMaskEdit({ id: selected.id, drawing: false });
            }
          }}
          onToggleMaskEdit={() => setMaskEdit((m) => (m?.id === selected.id ? null : { id: selected.id, drawing: false }))}
          onSetReveal={(reveal) => {
            if (!reveal) {
              if (selected.mask) onUpdatePipOverlayContent(selected.id, { mask: { ...selected.mask, reveal: undefined } });
              return;
            }
            const from = selected.mask ?? revealStartingMask(reveal.style);
            onUpdatePipOverlayContent(selected.id, { mask: { ...from, reveal } });
          }}
        />
      )}
      {selected && maskEdit?.id === selected.id && overlaysActiveAt([selected], currentOutputTime).length > 0 && (selected.mask || maskEdit.drawing) && (
        <MaskEditor
          box={{ left: selected.x * frameRect.width, top: selected.y * frameRect.height, width: selected.width * frameRect.width, height: selected.height * frameRect.height }}
          mask={selected.mask ?? { ...DEFAULT_MASK, x: 0, y: 0, width: 1, height: 1 }}
          drawing={maskEdit.drawing}
          zIndex={SELECTED_PIP_Z_INDEX + 1}
          onLive={setMaskLive}
          onCommit={(mask) => onUpdatePipOverlayContent(selected.id, { mask: placeMask(mask, mask) })}
          onDrawn={() => setMaskEdit({ id: selected.id, drawing: false })}
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
