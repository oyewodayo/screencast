// components/docker/ExportOptionsPopover.tsx
//
// The Save button's quality/destination options - same portal + useClampedPopoverPosition +
// outside-click-close shape as ClipEffectsPopover/AudioOverlayPopover, just for export_trimmed_
// video's own `quality`/`output_path` params (conversion.rs) rather than a clip/overlay's fields.
// Opened from the small chevron next to the Save button in VideoTimelineDocker; Save itself still
// works with no changes needed here (both params are optional server-side, defaulting to exactly
// what every export did before this popover existed).
import React, { useEffect } from "react";
import { createPortal } from "react-dom";
import { IoClose, IoFolderOpenOutline } from "react-icons/io5";
import { useClampedPopoverPosition } from "../../hooks/useClampedPopoverPosition";
import { ExportQuality } from "../../hooks/useVideoEditStore";

const QUALITY_OPTIONS: { value: ExportQuality; label: string; hint: string }[] = [
  { value: "small", label: "Smaller file", hint: "Faster export, more compression - good for a quick share" },
  { value: "standard", label: "Standard", hint: "Balanced quality and export time - the default" },
  { value: "high", label: "High quality", hint: "Slower export, less compression - best for archiving" },
];

interface ExportOptionsPopoverProps {
  anchor: { left: number; top: number };
  quality: ExportQuality;
  onQualityChange: (quality: ExportQuality) => void;
  // null means "use the default location next to the source file" - the same behavior every
  // export had before this popover existed.
  customOutputName: string | null;
  onChooseLocation: () => void;
  onResetLocation: () => void;
  format: ExportFormat;
  onFormatChange: (format: ExportFormat) => void;
  framing: ExportFraming;
  onFramingChange: (framing: ExportFraming) => void;
  loudness: number | null;
  onLoudnessChange: (lufs: number | null) => void;
  // Fill's crop position, 0..1 each way (0.5 = centred).
  fillAnchor: { x: number; y: number };
  onFillAnchorChange: (anchor: { x: number; y: number }) => void;
  // Fill following the subject (auto-reframe) instead of a fixed position, and how its analysis
  // is going (null = idle/ready).
  followSubject: boolean;
  onFollowSubjectChange: (follow: boolean) => void;
  reframeStatus: string | null;
  onClose: () => void;
}

export type ExportFormat = "original" | "16:9" | "9:16" | "1:1" | "4:5";
export type ExportFraming = "fit-blur" | "fit" | "fill";

// Pixel sizes for each platform format - 1080p-class, what each platform recommends uploading.
export const EXPORT_FORMATS: { value: ExportFormat; label: string; hint: string; size?: { width: number; height: number } }[] = [
  { value: "original", label: "Original", hint: "The timeline's own frame" },
  { value: "16:9", label: "16:9", hint: "YouTube, presentations", size: { width: 1920, height: 1080 } },
  { value: "9:16", label: "9:16", hint: "Shorts, Reels, TikTok", size: { width: 1080, height: 1920 } },
  { value: "1:1", label: "1:1", hint: "Square posts", size: { width: 1080, height: 1080 } },
  { value: "4:5", label: "4:5", hint: "Instagram & LinkedIn feed", size: { width: 1080, height: 1350 } },
];

const FRAMING_OPTIONS: { value: ExportFraming; label: string; hint: string }[] = [
  { value: "fit-blur", label: "Fit, blurred background", hint: "Whole picture, edges filled with a soft blur of itself" },
  { value: "fit", label: "Fit, black bars", hint: "Whole picture, bars where the shapes differ" },
  { value: "fill", label: "Fill", hint: "Cropped to fill the frame - following the subject, or at a position you set" },
];

const LOUDNESS_OPTIONS: { value: number | null; label: string; hint: string }[] = [
  { value: null, label: "As mixed", hint: "No change" },
  { value: -14, label: "-14 LUFS", hint: "YouTube, Spotify, most streaming" },
  { value: -16, label: "-16 LUFS", hint: "Podcasts, Apple" },
  { value: -23, label: "-23 LUFS", hint: "Broadcast (EBU R128)" },
];

const ExportOptionsPopover: React.FC<ExportOptionsPopoverProps> = ({
  anchor,
  quality,
  onQualityChange,
  customOutputName,
  onChooseLocation,
  onResetLocation,
  format,
  onFormatChange,
  framing,
  onFramingChange,
  loudness,
  onLoudnessChange,
  fillAnchor,
  followSubject,
  onFollowSubjectChange,
  reframeStatus,
  onFillAnchorChange,
  onClose,
}) => {
  const { ref: popoverRef, position } = useClampedPopoverPosition(anchor);

  useEffect(() => {
    const close = (e: PointerEvent) => {
      if (e.target instanceof Element && e.target.closest("[data-export-options-popover]")) return;
      onClose();
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [onClose]);

  return createPortal(
    <div
      ref={popoverRef}
      data-export-options-popover
      style={{ position: "fixed", left: position.left, top: position.top, zIndex: 9999 }}
      className="w-64 p-3 rounded-lg bg-neutral-900/95 backdrop-blur-md shadow-lg ring-1 ring-white/10 text-white/90 flex flex-col gap-3"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium">Export options</span>
        <button type="button" title="Close" onClick={onClose} className="shrink-0 p-0.5 rounded hover:bg-white/10 text-white/60 hover:text-white">
          <IoClose size={14} />
        </button>
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-[10px] uppercase tracking-wide text-white/40">Format</span>
        <div className="grid grid-cols-5 gap-1">
          {EXPORT_FORMATS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              title={opt.hint}
              onClick={() => onFormatChange(opt.value)}
              className={`px-1 py-1 rounded text-[10px] transition-colors ${
                format === opt.value ? "text-blue-400 bg-blue-500/10 ring-1 ring-blue-400/40" : "text-white/70 hover:text-white hover:bg-white/10"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <span className="text-[10px] text-white/40">{EXPORT_FORMATS.find((f) => f.value === format)?.hint}</span>
        {format !== "original" && (
          <div className="flex flex-col gap-0.5 pt-1">
            {FRAMING_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                title={opt.hint}
                onClick={() => onFramingChange(opt.value)}
                className={`text-left px-2 py-1 rounded text-[11px] transition-colors ${
                  framing === opt.value ? "text-blue-400 bg-blue-500/10 ring-1 ring-blue-400/40" : "text-white/70 hover:text-white hover:bg-white/10"
                }`}
              >
                {opt.label}
              </button>
            ))}
            {framing === "fill" && (
              <div className="flex flex-col gap-1 pt-1 text-[10px] text-white/60">
                <label className="flex items-center gap-2 cursor-pointer" title="The crop moves to keep the action in frame - holding still, easing to new spots, recentring at cuts. Uses recorded clicks too.">
                  <input type="checkbox" checked={followSubject} onChange={(e) => onFollowSubjectChange(e.target.checked)} className="accent-blue-400" />
                  <span className="text-white/80">Follow the subject</span>
                </label>
                {followSubject && <span className="text-white/40">{reframeStatus ?? "The highlighted window on the player is what's kept."}</span>}
              </div>
            )}
            {framing === "fill" && !followSubject && (
              <div className="flex flex-col gap-1 pt-1 text-[10px] text-white/60">
                <label className="flex items-center gap-2">
                  <span className="w-12 shrink-0">Left ↔ right</span>
                  <input type="range" min={0} max={1} step={0.01} value={fillAnchor.x} onChange={(e) => onFillAnchorChange({ ...fillAnchor, x: Number(e.target.value) })} className="flex-1 accent-blue-400" />
                </label>
                <label className="flex items-center gap-2">
                  <span className="w-12 shrink-0">Top ↔ bottom</span>
                  <input type="range" min={0} max={1} step={0.01} value={fillAnchor.y} onChange={(e) => onFillAnchorChange({ ...fillAnchor, y: Number(e.target.value) })} className="flex-1 accent-blue-400" />
                </label>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-[10px] uppercase tracking-wide text-white/40">Loudness</span>
        <div className="grid grid-cols-3 gap-1">
          {LOUDNESS_OPTIONS.map((opt) => (
            <button
              key={String(opt.value)}
              type="button"
              title={opt.hint}
              onClick={() => onLoudnessChange(opt.value)}
              className={`px-1 py-1 rounded text-[10px] transition-colors ${
                loudness === opt.value ? "text-blue-400 bg-blue-500/10 ring-1 ring-blue-400/40" : "text-white/70 hover:text-white hover:bg-white/10"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <span className="text-[10px] text-white/40">{LOUDNESS_OPTIONS.find((o) => o.value === loudness)?.hint}</span>
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-[10px] uppercase tracking-wide text-white/40">Quality</span>
        {QUALITY_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            onClick={() => onQualityChange(opt.value)}
            className={`text-left px-2 py-1 rounded text-[11px] transition-colors ${
              quality === opt.value ? "text-blue-400 bg-blue-500/10 ring-1 ring-blue-400/40" : "text-white/70 hover:text-white hover:bg-white/10"
            }`}
          >
            <div>{opt.label}</div>
            <div className="text-[10px] text-white/40">{opt.hint}</div>
          </button>
        ))}
      </div>

      <div className="flex flex-col gap-1.5 pt-1 border-t border-white/10">
        <span className="text-[10px] uppercase tracking-wide text-white/40">Destination</span>
        {customOutputName ? (
          <div className="flex items-center gap-1.5">
            <span className="flex-1 truncate text-[11px] text-white/70" title={customOutputName}>
              {customOutputName}
            </span>
            <button type="button" onClick={onResetLocation} className="shrink-0 text-[10px] text-white/50 hover:text-white underline">
              Reset
            </button>
          </div>
        ) : (
          <span className="text-[11px] text-white/50">Default: next to the source file</span>
        )}
        <button
          type="button"
          onClick={onChooseLocation}
          className="flex items-center gap-1.5 px-2 py-1 rounded text-[11px] text-white/70 hover:text-white hover:bg-white/10 self-start"
        >
          <IoFolderOpenOutline size={13} />
          Choose location…
        </button>
      </div>
    </div>,
    document.body
  );
};

export default ExportOptionsPopover;
