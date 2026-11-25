// components/whiteboard/WhiteboardAlignToolbar.tsx
//
// Compact floating top-center action bar shown when 2+ nodes are selected.
// Provides 1-click Align (L/C/R, T/M/B), Distribute (H/V), Match Size (W/H), Grid Tidy Up,
// and Group/Ungroup — solid surface (no backdrop-blur) for crisp 60fps canvas responsiveness.

import React, { memo } from "react";
import {
  TbLayoutAlignLeft,
  TbLayoutAlignCenter,
  TbLayoutAlignRight,
  TbLayoutAlignTop,
  TbLayoutAlignMiddle,
  TbLayoutAlignBottom,
  TbLayoutDistributeHorizontal,
  TbLayoutDistributeVertical,
  TbArrowsHorizontal,
  TbArrowsVertical,
  TbLayoutGrid,
  TbLayersLinked,
} from "react-icons/tb";
import { AlignMode, DistributeAxis, MatchSizeDimension } from "../../handlers/whiteboardProHandlers";

interface WhiteboardAlignToolbarProps {
  selectedCount: number;
  hasGrouped: boolean;
  offsetRight?: boolean;
  onAlign: (mode: AlignMode) => void;
  onDistribute: (axis: DistributeAxis) => void;
  onMatchSize: (dim: MatchSizeDimension) => void;
  onTidyUp: () => void;
  onGroup: () => void;
  onUngroup: () => void;
}

const Btn: React.FC<{ title: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }> = ({
  title,
  onClick,
  disabled,
  children,
}) => (
  <button
    type="button"
    title={title}
    disabled={disabled}
    onClick={onClick}
    className="flex items-center justify-center w-7 h-7 rounded-md text-neutral-600 dark:text-neutral-300 hover:bg-gray-100 dark:hover:bg-neutral-700 disabled:opacity-35 disabled:pointer-events-none transition-colors"
  >
    {children}
  </button>
);

const Divider: React.FC = () => <div className="w-px h-4 bg-gray-200 dark:bg-neutral-700 mx-0.5" />;

const WhiteboardAlignToolbar: React.FC<WhiteboardAlignToolbarProps> = memo(
  ({ selectedCount, hasGrouped, offsetRight = false, onAlign, onDistribute, onMatchSize, onTidyUp, onGroup, onUngroup }) => {
    if (selectedCount < 2) return null;

    return (
      <div
        onPointerDown={(e) => e.stopPropagation()}
        style={{ left: offsetRight ? "calc(50% - 154px)" : "50%" }}
        className="absolute top-3 -translate-x-1/2 z-20 flex items-center gap-0.5 px-1.5 py-1 rounded-xl bg-white dark:bg-neutral-900 border border-gray-200/90 dark:border-neutral-700/90 shadow-lg"
      >
        <span className="px-1.5 text-[10px] font-semibold tabular-nums text-gray-400 dark:text-neutral-500 select-none">
          {selectedCount}
        </span>
        <Divider />
        <Btn title="Align left" onClick={() => onAlign("left")}>
          <TbLayoutAlignLeft size={15} />
        </Btn>
        <Btn title="Align horizontal center" onClick={() => onAlign("centerH")}>
          <TbLayoutAlignCenter size={15} />
        </Btn>
        <Btn title="Align right" onClick={() => onAlign("right")}>
          <TbLayoutAlignRight size={15} />
        </Btn>
        <Divider />
        <Btn title="Align top" onClick={() => onAlign("top")}>
          <TbLayoutAlignTop size={15} />
        </Btn>
        <Btn title="Align vertical middle" onClick={() => onAlign("middleV")}>
          <TbLayoutAlignMiddle size={15} />
        </Btn>
        <Btn title="Align bottom" onClick={() => onAlign("bottom")}>
          <TbLayoutAlignBottom size={15} />
        </Btn>
        <Divider />
        <Btn title="Distribute horizontally (3+ items)" disabled={selectedCount < 3} onClick={() => onDistribute("horizontal")}>
          <TbLayoutDistributeHorizontal size={15} />
        </Btn>
        <Btn title="Distribute vertically (3+ items)" disabled={selectedCount < 3} onClick={() => onDistribute("vertical")}>
          <TbLayoutDistributeVertical size={15} />
        </Btn>
        <Divider />
        <Btn title="Match width" onClick={() => onMatchSize("width")}>
          <TbArrowsHorizontal size={15} />
        </Btn>
        <Btn title="Match height" onClick={() => onMatchSize("height")}>
          <TbArrowsVertical size={15} />
        </Btn>
        <Btn title="Tidy up into neat grid" onClick={onTidyUp}>
          <TbLayoutGrid size={15} />
        </Btn>
        <Divider />
        <button
          type="button"
          onClick={hasGrouped ? onUngroup : onGroup}
          title={hasGrouped ? "Ungroup (Ctrl+Shift+G)" : "Group (Ctrl+G)"}
          className="flex items-center gap-1 h-7 px-2 rounded-md text-[11px] font-medium text-neutral-700 dark:text-neutral-200 hover:bg-gray-100 dark:hover:bg-neutral-700 transition-colors"
        >
          <TbLayersLinked size={14} />
          <span>{hasGrouped ? "Ungroup" : "Group"}</span>
        </button>
      </div>
    );
  }
);

WhiteboardAlignToolbar.displayName = "WhiteboardAlignToolbar";

export default WhiteboardAlignToolbar;
