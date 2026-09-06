// components/docker/ToolModePopover.tsx
//
// The toolbar's "Select tool" button dropdown - switches VideoTimelineDocker's own toolMode
// between "select" (the pre-existing default: click a clip to select it, drag to reorder/trim)
// and "razor" (click anywhere on a clip to split it right there, staying armed across multiple
// cuts - the same modal-tool idea Premiere/Resolve's own razor tool uses). Same portal +
// useClampedPopoverPosition + outside-click-close shape as every other toolbar popover here
// (SpeedPopover, NoiseReductionPopover, ExtractAudioPopover).
import React, { useEffect } from "react";
import { createPortal } from "react-dom";
import { BsCursor } from "react-icons/bs";
import { IoCutOutline } from "react-icons/io5";
import { useClampedPopoverPosition } from "../../hooks/useClampedPopoverPosition";

export type TimelineToolMode = "select" | "razor";

const TOOLS: { id: TimelineToolMode; label: string; hint: string; icon: React.ReactNode }[] = [
  { id: "select", label: "Select", hint: "Click to select, drag to reorder/trim", icon: <BsCursor size={13} /> },
  { id: "razor", label: "Razor", hint: "Click anywhere on a clip to split it there", icon: <IoCutOutline size={14} /> },
];

interface ToolModePopoverProps {
  mode: TimelineToolMode;
  anchor: { left: number; top: number };
  onSelect: (mode: TimelineToolMode) => void;
  onClose: () => void;
}

const ToolModePopover: React.FC<ToolModePopoverProps> = ({ mode, anchor, onSelect, onClose }) => {
  const { ref: popoverRef, position } = useClampedPopoverPosition(anchor);

  useEffect(() => {
    const close = (e: PointerEvent) => {
      if (e.target instanceof Element && e.target.closest("[data-tool-mode-popover]")) return;
      onClose();
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [onClose]);

  return createPortal(
    <div
      ref={popoverRef}
      data-tool-mode-popover
      style={{ position: "fixed", left: position.left, top: position.top, zIndex: 9999 }}
      className="w-56 p-1.5 rounded-lg bg-neutral-900/95 backdrop-blur-md shadow-lg ring-1 ring-white/10 text-white/90 flex flex-col gap-0.5"
    >
      {TOOLS.map((tool) => (
        <button
          key={tool.id}
          type="button"
          onClick={() => {
            onSelect(tool.id);
            onClose();
          }}
          className={`flex items-start gap-2 px-2 py-1.5 rounded text-left transition-colors ${
            mode === tool.id ? "text-blue-400 bg-blue-500/10" : "text-white/70 hover:text-white hover:bg-white/10"
          }`}
        >
          <span className="mt-0.5 shrink-0">{tool.icon}</span>
          <span className="flex flex-col">
            <span className="text-xs font-medium">{tool.label}</span>
            <span className="text-[10px] text-white/40">{tool.hint}</span>
          </span>
        </button>
      ))}
    </div>,
    document.body
  );
};

export default ToolModePopover;
