// components/docker/AutoZoomPopover.tsx
//
// Review/confirm surface for the Auto Zoom toolbar button - same portal + useClampedPopoverPosition
// + outside-click-close shape as SilenceDetectionPopover, which this otherwise mirrors closely
// (same four states: still loading, nothing to do, failed, or found N clicks awaiting the user's
// explicit confirmation before applyAutoZoomAtClicks actually splices anything in).
import React, { useEffect } from "react";
import { createPortal } from "react-dom";
import { IoClose, IoLocateOutline } from "react-icons/io5";
import { useClampedPopoverPosition } from "../../hooks/useClampedPopoverPosition";
import { AutoZoomClick } from "../../handlers/videoEditHandlers";

export type AutoZoomState =
  | { status: "loading" }
  | { status: "empty"; reason: "no-sidecar" | "no-clicks-in-range" }
  | { status: "error"; message: string }
  | { status: "results"; clicks: AutoZoomClick[] };

interface AutoZoomPopoverProps {
  anchor: { left: number; top: number };
  state: AutoZoomState;
  onApply: () => void;
  onClose: () => void;
}

const AutoZoomPopover: React.FC<AutoZoomPopoverProps> = ({ anchor, state, onApply, onClose }) => {
  const { ref: popoverRef, position } = useClampedPopoverPosition(anchor);

  useEffect(() => {
    const close = (e: PointerEvent) => {
      if (e.target instanceof Element && e.target.closest("[data-auto-zoom-popover]")) return;
      onClose();
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [onClose]);

  return createPortal(
    <div
      ref={popoverRef}
      data-auto-zoom-popover
      style={{ position: "fixed", left: position.left, top: position.top, zIndex: 9999 }}
      className="w-64 p-3 rounded-lg bg-neutral-900/95 backdrop-blur-md shadow-lg ring-1 ring-white/10 text-white/90 flex flex-col gap-2.5"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium flex items-center gap-1.5">
          <IoLocateOutline size={13} />
          Auto zoom on click
        </span>
        <button type="button" title="Close" onClick={onClose} className="shrink-0 p-0.5 rounded hover:bg-white/10 text-white/60 hover:text-white">
          <IoClose size={14} />
        </button>
      </div>

      {state.status === "loading" && <span className="text-[11px] text-white/60">Looking for recorded clicks…</span>}

      {state.status === "empty" && state.reason === "no-sidecar" && (
        <span className="text-[11px] text-white/60">
          This clip has no recorded click data - turn on "Track clicks" in recording settings before your next recording to use this.
        </span>
      )}
      {state.status === "empty" && state.reason === "no-clicks-in-range" && (
        <span className="text-[11px] text-white/60">No recorded clicks fall within this clip's current trim.</span>
      )}

      {state.status === "error" && <span className="text-[11px] text-red-400">{state.message}</span>}

      {state.status === "results" && (
        <>
          <span className="text-[11px] text-white/70">
            Found {state.clicks.length} click{state.clicks.length === 1 ? "" : "s"} in this clip. Zoom in on each?
          </span>
          <button
            type="button"
            onClick={onApply}
            className="self-start px-2.5 py-1 rounded text-[11px] font-medium bg-blue-600 text-white hover:bg-blue-500"
          >
            Apply zoom{state.clicks.length === 1 ? "" : "s"}
          </button>
        </>
      )}
    </div>,
    document.body
  );
};

export default AutoZoomPopover;
