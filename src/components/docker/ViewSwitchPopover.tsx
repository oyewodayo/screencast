// components/docker/ViewSwitchPopover.tsx
//
// Review/confirm surface for the "Apply view switches" toolbar button - same portal +
// useClampedPopoverPosition + outside-click-close shape as AutoZoomPopover, which this otherwise
// mirrors closely (same four states: still loading, nothing to do, failed, or found N camera
// intervals awaiting the user's explicit confirmation before applyViewSwitchOverlays actually
// adds anything).
import React, { useEffect } from "react";
import { createPortal } from "react-dom";
import { IoClose, IoSwapHorizontal } from "react-icons/io5";
import { useClampedPopoverPosition } from "../../hooks/useClampedPopoverPosition";

export type ViewSwitchDetectState =
  | { status: "loading" }
  | { status: "empty"; reason: "no-webcam-file" | "no-sidecar" | "no-switches-in-range" }
  | { status: "error"; message: string }
  | { status: "results"; intervalCount: number };

interface ViewSwitchPopoverProps {
  anchor: { left: number; top: number };
  state: ViewSwitchDetectState;
  onApply: () => void;
  onClose: () => void;
}

const ViewSwitchPopover: React.FC<ViewSwitchPopoverProps> = ({ anchor, state, onApply, onClose }) => {
  const { ref: popoverRef, position } = useClampedPopoverPosition(anchor);

  useEffect(() => {
    const close = (e: PointerEvent) => {
      if (e.target instanceof Element && e.target.closest("[data-view-switch-popover]")) return;
      onClose();
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [onClose]);

  return createPortal(
    <div
      ref={popoverRef}
      data-view-switch-popover
      style={{ position: "fixed", left: position.left, top: position.top, zIndex: 9999 }}
      className="w-64 p-3 rounded-lg bg-neutral-900/95 backdrop-blur-md shadow-lg ring-1 ring-white/10 text-white/90 flex flex-col gap-2.5"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium flex items-center gap-1.5">
          <IoSwapHorizontal size={13} />
          Apply view switches
        </span>
        <button type="button" title="Close" onClick={onClose} className="shrink-0 p-0.5 rounded hover:bg-white/10 text-white/60 hover:text-white">
          <IoClose size={14} />
        </button>
      </div>

      {state.status === "loading" && <span className="text-[11px] text-white/60">Looking for a recorded view-switch timeline…</span>}

      {state.status === "empty" && state.reason === "no-webcam-file" && (
        <span className="text-[11px] text-white/60">
          This clip has no separately-recorded webcam file - turn on "Record webcam separately (PiP editing)" before your next recording to use this.
        </span>
      )}
      {state.status === "empty" && state.reason === "no-sidecar" && (
        <span className="text-[11px] text-white/60">This recording has no logged view switches - the live Screen/Camera toggle was never used.</span>
      )}
      {state.status === "empty" && state.reason === "no-switches-in-range" && (
        <span className="text-[11px] text-white/60">No recorded view switches fall within this clip's current trim.</span>
      )}

      {state.status === "error" && <span className="text-[11px] text-red-400">{state.message}</span>}

      {state.status === "results" && (
        <>
          <span className="text-[11px] text-white/70">
            Found {state.intervalCount} camera-view interval{state.intervalCount === 1 ? "" : "s"} in this clip. Cut to the camera during each?
          </span>
          <button
            type="button"
            onClick={onApply}
            className="self-start px-2.5 py-1 rounded text-[11px] font-medium bg-blue-600 text-white hover:bg-blue-500"
          >
            Apply cut{state.intervalCount === 1 ? "" : "s"}
          </button>
        </>
      )}
    </div>,
    document.body
  );
};

export default ViewSwitchPopover;
