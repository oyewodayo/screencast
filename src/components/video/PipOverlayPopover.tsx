// components/video/PipOverlayPopover.tsx
//
// Position/size/shape/crop controls for a selected PipOverlay - same portal + useClampedPopoverPosition
// + outside-click-close shape as ClipEffectsPopover/AudioOverlayPopover. Position and size can also
// be edited directly on the video itself (PipOverlayLayer.tsx's drag + resize handles) - the sliders
// here are a precise/keyboard-friendly alternative, not the only way. Crop has no slider form: the
// Crop button hands off to PipOverlayLayer's own on-canvas crop editor (onStartCrop).
import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { IoClose, IoColorWandOutline, IoCropOutline, IoPersonOutline, IoTrashOutline } from "react-icons/io5";
import { BlendMode, PipOverlay, PipShape } from "../../utils/videoEditTypes";
import { BLEND_MODES } from "../../utils/blendModes";
import { useClampedPopoverPosition } from "../../hooks/useClampedPopoverPosition";
import { pipChannelKey, requestMixer } from "../../utils/mixerState";
import { pipTrack, videoTrackLabel } from "../../utils/videoTracks";
import { MAX_FEATHER, REVEAL_STYLES, type LayerMask, type MaskReveal } from "../../utils/layerMask";
import CutoutBackgroundPicker from "./CutoutBackgroundPicker";
import { BLUR_DEFAULT } from "../../utils/cutoutBackground";
import { backgroundRemovalStatus, cancelBackgroundRemoval, dismissBackgroundError, removeBackground, useBackgroundJob, type BackgroundRemovalStatus } from "../../utils/backgroundRemoval";

export type PipOverlayPatch = Partial<Pick<PipOverlay, "x" | "y" | "width" | "height" | "shape" | "cornerRadius" | "crop" | "volume" | "muted" | "blendMode" | "fx" | "opacity" | "fadeIn" | "fadeOut" | "chromaKey" | "mask" | "cutout">>;

const SHAPE_OPTIONS: { value: PipShape; label: string }[] = [
  { value: "circle", label: "Circle" },
  { value: "rounded", label: "Rounded" },
  { value: "rectangle", label: "Rectangle" },
];

interface PipOverlayPopoverProps {
  overlay: PipOverlay;
  anchor: { left: number; top: number };
  onUpdate: (patch: PipOverlayPatch) => void;
  onDelete: () => void;
  onClose: () => void;
  onStartCrop: () => void;
  // Green screen: turn keying on (guessing the screen's colour), and pick the colour on the video.
  onEnableKey: () => void;
  pickingKey: boolean;
  onTogglePickKey: () => void;
  // Mask: choose its shape ("path" draws one on the video; null removes it), edit it on the video.
  maskEditing: boolean;
  // The mask opening over the layer's start (and closing at its end) - layerMask.ts reveals.
  onSetReveal: (reveal: MaskReveal | null) => void;
  onSetMaskShape: (shape: LayerMask["shape"] | null) => void;
  onToggleMaskEdit: () => void;
}

// Remove background (backgroundRemoval.ts): the person cut out of the video - no green screen
// needed. The job keeps running if this panel closes; the layer switches to the cut-out when done.
const BackgroundSection: React.FC<{ overlay: PipOverlay; onUpdate: (patch: PipOverlayPatch) => void }> = ({ overlay, onUpdate }) => {
  const job = useBackgroundJob(overlay.id);
  const [status, setStatus] = useState<BackgroundRemovalStatus | null>(null);
  useEffect(() => {
    let live = true;
    backgroundRemovalStatus()
      .then((s) => live && setStatus(s))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [job]);
  const hasCutout = !!overlay.cutout && overlay.cutout.sourcePath === overlay.sourcePath;
  if (status?.state === "unsupported" && !hasCutout) return null;
  // A bubble lifted off a screen recording is cut out of just its own part of the picture, and
  // starts with its own background blurred (there's nothing behind it to see through to).
  const bubble = !!overlay.bakedBubble;
  const start = () => {
    const { id, sourcePath, crop } = overlay;
    const region = bubble ? crop : undefined;
    void removeBackground(
      id,
      sourcePath,
      (path) => onUpdate({ cutout: { path, sourcePath, region, background: bubble ? { kind: "blur", amount: BLUR_DEFAULT } : undefined }, chromaKey: undefined }),
      region
    );
  };
  const bar = (p: number) => (
    <div className="h-1 rounded-full bg-white/10 overflow-hidden">
      <div className="h-full bg-emerald-400 transition-[width]" style={{ width: `${Math.round(p * 100)}%` }} />
    </div>
  );
  return (
    <div className="flex flex-col gap-1.5 pt-1 border-t border-white/10">
      <span className="text-[10px] uppercase tracking-wide text-white/40">Background</span>
      {job?.phase === "download" || job?.phase === "cutting" ? (
        <>
          <div className="flex items-center justify-between gap-2 text-[11px] text-white/75">
            <span>{job.phase === "download" ? "Getting the engine (once)…" : "Cutting out the person…"} {Math.round(job.progress * 100)}%</span>
            <button type="button" onClick={() => cancelBackgroundRemoval(overlay.id)} className="text-[10px] text-white/55 hover:text-white">
              Cancel
            </button>
          </div>
          {bar(job.progress)}
          <span className="text-[10px] leading-snug text-white/45">Keeps going if you close this - the layer updates when it's done.</span>
        </>
      ) : hasCutout && overlay.cutout ? (
        <>
          <div className="flex items-center justify-between gap-2 text-[11px]">
            <span className="text-emerald-300">Background removed - what's behind you:</span>
            <button type="button" onClick={() => onUpdate({ cutout: undefined })} className="shrink-0 text-[10px] text-white/55 hover:text-white" title="Show the original video again">
              Undo
            </button>
          </div>
          <CutoutBackgroundPicker value={overlay.cutout.background} allowNone={!bubble} onChange={(background) => onUpdate({ cutout: { ...overlay.cutout!, background } })} />
        </>
      ) : (
        <>
          <button
            type="button"
            onClick={start}
            title="Cut the person out of this video - no green screen needed. Works best on a webcam shot of one person."
            className="self-start flex items-center gap-1 px-2 py-1 rounded text-[11px] text-white/85 bg-white/5 hover:bg-white/10"
          >
            <IoPersonOutline size={12} />
            Remove background
          </button>
          {status?.state === "needs-download" && <span className="text-[10px] leading-snug text-white/45">The first time, this downloads the engine ({status.downloadMb} MB).</span>}
          {job?.phase === "error" && (
            <div className="flex items-start justify-between gap-2 text-[10px] leading-snug text-red-300">
              <span className="break-words">{job.message}</span>
              <button type="button" onClick={() => dismissBackgroundError(overlay.id)} className="shrink-0 text-white/55 hover:text-white">
                OK
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
};

const MASK_SHAPES: { value: LayerMask["shape"] | null; label: string; hint: string }[] = [
  { value: null, label: "None", hint: "The whole layer shows" },
  { value: "ellipse", label: "Ellipse", hint: "An oval - a spotlight or a vignette reveal" },
  { value: "rectangle", label: "Box", hint: "A rectangle, optionally rounded" },
  { value: "path", label: "Draw", hint: "Drag an outline around what should show" },
];

const Slider: React.FC<{ label: string; value: number; onChange: (v: number) => void; max?: number }> = ({ label, value, onChange, max = 1 }) => (
  <label className="flex items-center gap-2 text-[11px]">
    <span className="w-10 shrink-0 text-white/60">{label}</span>
    <input type="range" min={0} max={max} step={0.01} value={value} onChange={(e) => onChange(Number(e.target.value))} className="flex-1 accent-blue-400" />
    <span className="w-9 shrink-0 text-right tabular-nums text-white/60">{Math.round((value / max) * 100)}%</span>
  </label>
);

const PipOverlayPopover: React.FC<PipOverlayPopoverProps> = ({
  overlay,
  anchor,
  onUpdate,
  onDelete,
  onClose,
  onStartCrop,
  onEnableKey,
  pickingKey,
  onTogglePickKey,
  maskEditing,
  onSetReveal,
  onSetMaskShape,
  onToggleMaskEdit,
}) => {
  const { ref: popoverRef, position } = useClampedPopoverPosition(anchor);
  const key = overlay.chromaKey;
  const hasCutout = !!overlay.cutout && overlay.cutout.sourcePath === overlay.sourcePath;
  const isFullFrame = overlay.x <= 0.001 && overlay.y <= 0.001 && overlay.width >= 0.999 && overlay.height >= 0.999;

  useEffect(() => {
    const close = (e: PointerEvent) => {
      // [data-pip-interactive] is the pip box itself plus its resize handles (PipOverlayLayer.tsx) -
      // grabbing one of those to drag/resize must not close the popover and deselect the pip (which
      // would also unmount the very handle being dragged).
      if (e.target instanceof Element && e.target.closest("[data-pip-popover], [data-pip-interactive]")) return;
      onClose();
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [onClose]);

  return createPortal(
    <div
      ref={popoverRef}
      data-pip-popover
      style={{ position: "fixed", left: position.left, top: position.top, zIndex: 9999 }}
      className="w-64 max-h-[calc(100vh-16px)] overflow-y-auto p-3 rounded-lg bg-neutral-900/95 backdrop-blur-md shadow-lg ring-1 ring-white/10 text-white/90 flex flex-col gap-2.5"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium">
          {isFullFrame ? "B-roll" : "Picture-in-picture"} <span className="text-white/45 font-normal">· on {videoTrackLabel(pipTrack(overlay))}</span>
        </span>
        <div className="flex items-center gap-1">
          <button type="button" title="Delete" onClick={onDelete} className="shrink-0 p-0.5 rounded hover:bg-white/10 text-white/60 hover:text-red-400">
            <IoTrashOutline size={14} />
          </button>
          <button type="button" title="Close" onClick={onClose} className="shrink-0 p-0.5 rounded hover:bg-white/10 text-white/60 hover:text-white">
            <IoClose size={14} />
          </button>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-[10px] uppercase tracking-wide text-white/40">Position &amp; size</span>
        <Slider label="X" value={overlay.x} onChange={(x) => onUpdate({ x: Math.max(0, Math.min(1 - overlay.width, x)) })} />
        <Slider label="Y" value={overlay.y} onChange={(y) => onUpdate({ y: Math.max(0, Math.min(1 - overlay.height, y)) })} />
        <Slider label="Width" value={overlay.width} onChange={(width) => onUpdate({ width: Math.max(0.05, Math.min(1 - overlay.x, width)) })} />
        <Slider label="Height" value={overlay.height} onChange={(height) => onUpdate({ height: Math.max(0.05, Math.min(1 - overlay.y, height)) })} />
      </div>

      <div className="flex flex-col gap-1.5 pt-1 border-t border-white/10">
        <span className="text-[10px] uppercase tracking-wide text-white/40">Layer</span>
        {!isFullFrame && (
          <button
            type="button"
            onClick={() => onUpdate({ x: 0, y: 0, width: 1, height: 1, shape: "rectangle" })}
            title="Cover the whole frame - B-roll over the main video"
            className="self-start px-2 py-1 rounded text-[11px] text-white/80 bg-white/5 hover:bg-white/10"
          >
            Fill the frame
          </button>
        )}
        <Slider label="Opacity" value={overlay.opacity ?? 1} onChange={(opacity) => onUpdate({ opacity })} />
        <div className="flex items-center gap-2 text-[11px]">
          <span className="w-10 shrink-0 text-white/60">Fade</span>
          <label className="flex items-center gap-1" title="Dissolve in over this many seconds">
            <span className="text-white/45">in</span>
            <input
              type="number"
              min={0}
              max={5}
              step={0.1}
              value={overlay.fadeIn ?? 0}
              onChange={(e) => onUpdate({ fadeIn: Math.max(0, Number(e.target.value) || 0) })}
              className="w-12 px-1 py-0.5 rounded bg-white/10 text-white text-right outline-none focus:ring-1 focus:ring-blue-400"
            />
          </label>
          <label className="flex items-center gap-1" title="Dissolve out over this many seconds">
            <span className="text-white/45">out</span>
            <input
              type="number"
              min={0}
              max={5}
              step={0.1}
              value={overlay.fadeOut ?? 0}
              onChange={(e) => onUpdate({ fadeOut: Math.max(0, Number(e.target.value) || 0) })}
              className="w-12 px-1 py-0.5 rounded bg-white/10 text-white text-right outline-none focus:ring-1 focus:ring-blue-400"
            />
          </label>
          <span className="text-white/45">s</span>
        </div>
      </div>

      <div className="flex items-center gap-1.5 pt-1 border-t border-white/10">
        <button
          type="button"
          onClick={onStartCrop}
          className="flex items-center gap-1 px-2 py-1 rounded text-[11px] text-white/80 hover:text-white bg-white/5 hover:bg-white/10"
        >
          <IoCropOutline size={13} />
          Crop video…
        </button>
        {overlay.crop && (
          <button type="button" onClick={() => onUpdate({ crop: undefined })} className="px-2 py-1 rounded text-[11px] text-white/60 hover:text-white hover:bg-white/10">
            Reset crop
          </button>
        )}
      </div>

      <div className="flex flex-col gap-1.5 pt-1 border-t border-white/10">
        <span className="text-[10px] uppercase tracking-wide text-white/40">Shape</span>
        <div className="flex flex-wrap gap-1">
          {SHAPE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => onUpdate({ shape: opt.value })}
              className={`px-2 py-1 rounded text-[11px] transition-colors ${
                overlay.shape === opt.value ? "text-blue-400 bg-blue-500/10 ring-1 ring-blue-400/40" : "text-white/70 hover:text-white hover:bg-white/10"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
        {overlay.shape === "rounded" && (
          <Slider label="Radius" value={overlay.cornerRadius ?? 0.08} onChange={(cornerRadius) => onUpdate({ cornerRadius })} max={0.3} />
        )}
      </div>

      <BackgroundSection overlay={overlay} onUpdate={onUpdate} />

      {!hasCutout && (
      <div className="flex flex-col gap-1.5 pt-1 border-t border-white/10">
        <label className="flex items-center justify-between gap-2 text-[11px] cursor-pointer" title="Make a green (or blue) screen behind the subject transparent">
          <span className="text-[10px] uppercase tracking-wide text-white/40">Green screen</span>
          <input type="checkbox" checked={!!key} onChange={(e) => (e.target.checked ? onEnableKey() : onUpdate({ chromaKey: undefined }))} className="accent-emerald-400" />
        </label>
        {key && (
          <>
            <div className="flex items-center gap-1.5 text-[11px]">
              <span className="w-10 shrink-0 text-white/60">Colour</span>
              <input
                type="color"
                value={key.color}
                onChange={(e) => onUpdate({ chromaKey: { ...key, color: e.target.value } })}
                title="The screen's colour"
                className="w-7 h-5 rounded bg-transparent border border-white/20 cursor-pointer"
              />
              <button
                type="button"
                onClick={onTogglePickKey}
                title="Click the screen in the video to take its colour"
                className={`flex items-center gap-1 px-2 py-0.5 rounded text-[11px] ${pickingKey ? "bg-emerald-500/20 text-emerald-300 ring-1 ring-emerald-400/50" : "bg-white/5 text-white/80 hover:bg-white/10"}`}
              >
                <IoColorWandOutline size={12} />
                {pickingKey ? "Click the screen…" : "Pick"}
              </button>
            </div>
            <Slider label="Range" value={key.similarity} max={0.5} onChange={(similarity) => onUpdate({ chromaKey: { ...key, similarity: Math.max(0.01, similarity) } })} />
            <Slider label="Soft" value={key.blend} max={0.4} onChange={(blend) => onUpdate({ chromaKey: { ...key, blend } })} />
            <Slider label="Spill" value={key.spill} onChange={(spill) => onUpdate({ chromaKey: { ...key, spill } })} />
            <span className="text-[10px] leading-snug text-white/45">Range: how much of the screen goes. Soft: the edge. Spill: green cast on the subject.</span>
          </>
        )}
      </div>
      )}

      <div className="flex flex-col gap-1.5 pt-1 border-t border-white/10">
        <div className="flex items-center justify-between">
          <span className="text-[10px] uppercase tracking-wide text-white/40">Mask</span>
          {overlay.mask && (
            <button type="button" onClick={onToggleMaskEdit} className={`text-[10px] ${maskEditing ? "text-teal-300" : "text-white/55 hover:text-white"}`}>
              {maskEditing ? "Done" : "Edit on video"}
            </button>
          )}
        </div>
        <div className="flex flex-wrap gap-1">
          {MASK_SHAPES.map((opt) => {
            const active = opt.value === null ? !overlay.mask : overlay.mask?.shape === opt.value;
            return (
              <button
                key={opt.label}
                type="button"
                title={opt.hint}
                onClick={() => onSetMaskShape(opt.value)}
                className={`px-2 py-1 rounded text-[11px] transition-colors ${active ? "text-teal-300 bg-teal-500/10 ring-1 ring-teal-400/40" : "text-white/70 hover:text-white hover:bg-white/10"}`}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
        {overlay.mask && (
          <>
            <Slider label="Feather" value={overlay.mask.feather} max={MAX_FEATHER} onChange={(feather) => onUpdate({ mask: { ...overlay.mask!, feather } })} />
            {overlay.mask.shape === "rectangle" && (
              <Slider label="Corners" value={overlay.mask.cornerRadius ?? 0} max={0.5} onChange={(cornerRadius) => onUpdate({ mask: { ...overlay.mask!, cornerRadius } })} />
            )}
            <label className="flex items-center gap-2 text-[11px] cursor-pointer" title="Show everything except the masked area">
              <input type="checkbox" checked={overlay.mask.invert} onChange={(e) => onUpdate({ mask: { ...overlay.mask!, invert: e.target.checked } })} className="accent-teal-400" />
              <span className="text-white/70">Invert</span>
            </label>
          </>
        )}
        <span className="text-[10px] uppercase tracking-wide text-white/40 pt-1">Reveal</span>
        <div className="flex flex-wrap gap-1">
          {[{ value: null, label: "None", hint: "Shows straight away" }, ...REVEAL_STYLES].map((opt) => {
            const current = overlay.mask?.reveal;
            const active = opt.value === null ? !current : current?.style === opt.value;
            return (
              <button
                key={opt.label}
                type="button"
                title={opt.hint}
                onClick={() => onSetReveal(opt.value === null ? null : { style: opt.value, duration: current?.duration ?? 0.8, exit: current?.exit })}
                className={`px-2 py-1 rounded text-[11px] transition-colors ${active ? "text-teal-300 bg-teal-500/10 ring-1 ring-teal-400/40" : "text-white/70 hover:text-white hover:bg-white/10"}`}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
        {overlay.mask?.reveal && (
          <>
            <label className="flex items-center gap-2 text-[11px]">
              <span className="w-16 text-white/60">Duration</span>
              <input
                type="range"
                min={0.2}
                max={4}
                step={0.05}
                value={overlay.mask.reveal.duration}
                onChange={(e) => onSetReveal({ ...overlay.mask!.reveal!, duration: Number(e.target.value) })}
                className="flex-1 accent-teal-400"
              />
              <span className="w-8 text-right tabular-nums text-white/50">{overlay.mask.reveal.duration.toFixed(1)}s</span>
            </label>
            <label className="flex items-center gap-2 text-[11px] cursor-pointer" title="Close the same way over the layer's last moments">
              <input type="checkbox" checked={!!overlay.mask.reveal.exit} onChange={(e) => onSetReveal({ ...overlay.mask!.reveal!, exit: e.target.checked })} className="accent-teal-400" />
              <span className="text-white/70">Close at the end</span>
            </label>
          </>
        )}
      </div>

      <div className="flex flex-col gap-1.5 pt-1 border-t border-white/10">
        <span className="text-[10px] uppercase tracking-wide text-white/40">Blend</span>
        <select
          value={overlay.blendMode ?? "normal"}
          onChange={(e) => onUpdate({ blendMode: e.target.value === "normal" ? undefined : (e.target.value as BlendMode) })}
          title={BLEND_MODES.find((m) => m.value === (overlay.blendMode ?? "normal"))?.hint}
          className="w-full bg-white/10 rounded px-2 py-1 text-[11px] text-white outline-none"
        >
          {BLEND_MODES.map((m) => (
            <option key={m.value} value={m.value} className="bg-neutral-900">
              {m.label}
            </option>
          ))}
        </select>
        {(overlay.blendMode === "screen" || overlay.blendMode === "plus-lighter") && (
          <span className="text-[10px] leading-snug text-white/45">Black disappears - drop light leaks, flares or dust footage over the video.</span>
        )}
      </div>

      <div className="flex flex-col gap-1.5 pt-1 border-t border-white/10">
        <span className="text-[10px] uppercase tracking-wide text-white/40">Audio</span>
        <label className="flex items-center gap-2 text-[11px]">
          {/* overlay.muted === false (not just falsy) - a pip saved before this field existed
              loads back with muted:undefined, which the export path (useVideoEditStore.ts)
              already treats as muted; showing this checked for that same data would silently
              disagree with what actually plays. */}
          <input type="checkbox" checked={overlay.muted === false} onChange={(e) => onUpdate({ muted: !e.target.checked })} />
          <span className="text-white/70">Play this clip's own audio</span>
        </label>
        {overlay.muted === false && (
          <>
            <Slider label="Volume" value={Number.isFinite(overlay.volume) ? overlay.volume : 1} onChange={(volume) => onUpdate({ volume })} />
            <button
              type="button"
              onClick={() => requestMixer(pipChannelKey(overlay.id))}
              title="EQ, compressor and balance for this clip's sound"
              className="self-start px-2 py-1 rounded text-[11px] text-white/80 bg-white/5 hover:bg-white/10"
            >
              Mixer &amp; effects…{overlay.fx ? " (on)" : ""}
            </button>
          </>
        )}
      </div>
    </div>,
    document.body
  );
};

export default PipOverlayPopover;
