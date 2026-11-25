// components/whiteboard/WhiteboardViewPill.tsx
//
// Compact floating bottom-left viewport pill (Zoom %, Fit, Grid style cycle, Snap, Minimap,
// Shortcuts) keeping navigation controls off the top header bar.

import React, { memo } from "react";
import {
  IoAdd,
  IoContractOutline,
  IoGridOutline,
  IoHelpCircleOutline,
  IoMagnetOutline,
  IoMapOutline,
  IoRemove,
} from "react-icons/io5";
import { WhiteboardGridStyle } from "../../utils/whiteboardTypes";

interface WhiteboardViewPillProps {
  zoom: number;
  gridStyle: WhiteboardGridStyle;
  snapToGrid: boolean;
  showMinimap: boolean;
  onZoomOut: () => void;
  onZoomIn: () => void;
  onResetZoom: () => void;
  onFitToContent: () => void;
  onCycleGridStyle: () => void;
  onToggleSnap: () => void;
  onToggleMinimap: () => void;
  onOpenShortcuts: () => void;
}

const PillBtn: React.FC<{
  title: string;
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}> = ({ title, active, onClick, children }) => (
  <button
    type="button"
    title={title}
    onClick={onClick}
    className={`w-7 h-7 rounded-md flex items-center justify-center transition-colors ${
      active
        ? "bg-blue-50 dark:bg-blue-500/20 text-blue-600 dark:text-blue-400"
        : "text-neutral-600 dark:text-neutral-300 hover:bg-gray-100 dark:hover:bg-neutral-800"
    }`}
  >
    {children}
  </button>
);

const WhiteboardViewPill: React.FC<WhiteboardViewPillProps> = memo(
  ({
    zoom,
    gridStyle,
    snapToGrid,
    showMinimap,
    onZoomOut,
    onZoomIn,
    onResetZoom,
    onFitToContent,
    onCycleGridStyle,
    onToggleSnap,
    onToggleMinimap,
    onOpenShortcuts,
  }) => (
    <div
      onPointerDown={(e) => e.stopPropagation()}
      className="absolute bottom-3 left-3 z-20 flex items-center gap-0.5 px-1.5 py-1 rounded-lg bg-white dark:bg-neutral-900 border border-gray-200/90 dark:border-neutral-700/90 shadow-lg select-none"
    >
      <PillBtn title="Zoom out" onClick={onZoomOut}>
        <IoRemove size={14} />
      </PillBtn>
      <button
        type="button"
        onClick={onResetZoom}
        title="Reset zoom to 100% (1)"
        className="h-7 px-1.5 rounded-md text-[11px] font-medium tabular-nums text-neutral-700 dark:text-neutral-200 hover:bg-gray-100 dark:hover:bg-neutral-800 min-w-[44px]"
      >
        {Math.round(zoom * 100)}%
      </button>
      <PillBtn title="Zoom in" onClick={onZoomIn}>
        <IoAdd size={14} />
      </PillBtn>
      <PillBtn title="Fit to content (0)" onClick={onFitToContent}>
        <IoContractOutline size={14} />
      </PillBtn>
      <div className="w-px h-4 bg-gray-200 dark:bg-neutral-700 mx-0.5" />
      <PillBtn
        title={`Grid: ${gridStyle === "dots" ? "Dots" : gridStyle === "lines" ? "Lines" : "Off"} (click to cycle)`}
        active={gridStyle !== "none"}
        onClick={onCycleGridStyle}
      >
        <IoGridOutline size={14} />
      </PillBtn>
      <PillBtn
        title={snapToGrid ? "Snap to grid on (hold Alt to move freely)" : "Snap to grid off (hold Alt to snap)"}
        active={snapToGrid}
        onClick={onToggleSnap}
      >
        <IoMagnetOutline size={14} />
      </PillBtn>
      <PillBtn title={showMinimap ? "Hide minimap" : "Show minimap"} active={showMinimap} onClick={onToggleMinimap}>
        <IoMapOutline size={14} />
      </PillBtn>
      <PillBtn title="Keyboard shortcuts (?)" onClick={onOpenShortcuts}>
        <IoHelpCircleOutline size={15} />
      </PillBtn>
    </div>
  )
);

WhiteboardViewPill.displayName = "WhiteboardViewPill";

export default WhiteboardViewPill;
