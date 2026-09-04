// components/docker/SilenceDetectionPopover.tsx
//
// Review/confirm surface for the Trim Silence toolbar button - same portal + useClampedPopoverPosition
// + outside-click-close shape as ExportOptionsPopover/ClipEffectsPopover. Covers all four states a
// detect_silence scan (conversion.rs) can land in: still running, found nothing, failed, or found N
// gaps awaiting the user's confirmation before anything is actually cut (removeSilentRanges is only
// ever applied on an explicit "Remove" click here, never automatically).
import React, { useEffect } from "react";
import { createPortal } from "react-dom";
import { IoClose, IoVolumeMuteOutline } from "react-icons/io5";
import { useClampedPopoverPosition } from "../../hooks/useClampedPopoverPosition";

export type SilenceDetectionState =
  | { status: "loading" }
  | { status: "empty" }
  | { status: "error"; message: string }
  | { status: "results"; ranges: { start: number; end: number }[] };

interface SilenceDetectionPopoverProps {
  anchor: { left: number; top: number };
  state: SilenceDetectionState;
  onRemove: () => void;
  onClose: () => void;
}

const SilenceDetectionPopover: React.FC<SilenceDetectionPopoverProps> = ({ anchor, state, onRemove, onClose }) => {
  const { ref: popoverRef, position } = useClampedPopoverPosition(anchor);

  useEffect(() => {
    const close = (e: PointerEvent) => {
      if (e.target instanceof Element && e.target.closest("[data-silence-popover]")) return;
      onClose();
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [onClose]);

  const totalDuration = state.status === "results" ? state.ranges.reduce((sum, r) => sum + (r.end - r.start), 0) : 0;

  return createPortal(
    <div
      ref={popoverRef}
      data-silence-popover
      style={{ position: "fixed", left: position.left, top: position.top, zIndex: 9999 }}
      className="w-64 p-3 rounded-lg bg-neutral-900/95 backdrop-blur-md shadow-lg ring-1 ring-white/10 text-white/90 flex flex-col gap-2.5"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium flex items-center gap-1.5">
          <IoVolumeMuteOutline size={13} />
          Trim silence
        </span>
        <button type="button" title="Close" onClick={onClose} className="shrink-0 p-0.5 rounded hover:bg-white/10 text-white/60 hover:text-white">
          <IoClose size={14} />
        </button>
      </div>

      {state.status === "loading" && <span className="text-[11px] text-white/60">Scanning this clip's audio…</span>}

      {state.status === "empty" && <span className="text-[11px] text-white/60">No silent gaps found in this clip.</span>}

      {state.status === "error" && <span className="text-[11px] text-red-400">{state.message}</span>}

      {state.status === "results" && (
        <>
          <span className="text-[11px] text-white/70">
            Found {state.ranges.length} silent {state.ranges.length === 1 ? "gap" : "gaps"} totaling {totalDuration.toFixed(1)}s.
          </span>
          <button
            type="button"
            onClick={onRemove}
            className="self-start px-2.5 py-1 rounded text-[11px] font-medium bg-blue-600 text-white hover:bg-blue-500"
          >
            Remove {state.ranges.length === 1 ? "it" : "all"}
          </button>
        </>
      )}
    </div>,
    document.body
  );
};

export default SilenceDetectionPopover;
