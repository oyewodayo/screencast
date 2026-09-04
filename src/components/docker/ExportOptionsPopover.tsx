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
  onClose: () => void;
}

const ExportOptionsPopover: React.FC<ExportOptionsPopoverProps> = ({
  anchor,
  quality,
  onQualityChange,
  customOutputName,
  onChooseLocation,
  onResetLocation,
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
