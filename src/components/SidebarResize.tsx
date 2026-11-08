// components/SidebarResize.tsx
//
// The media sidebar's resize edge, its collapsed rail, and the file name that makes use of the room.
//
// Dragging writes the width straight onto the sidebar element every frame - no React render per
// pointer move - and hands the final width over once on release (saved by sidebarFolders.ts).
// Everything inside reflows by CSS alone as it goes: names truncate to whatever fits, grid tiles
// add columns, docked panels go two-up. Pulled well past its narrowest width it snaps to the rail
// (and back out again), live, while still dragging. Double-click resets it.
import React, { useRef } from "react";
import { IoChevronForward } from "react-icons/io5";
import { SIDEBAR_MAX_W, SIDEBAR_MIN_W, SIDEBAR_RAIL_W } from "../utils/sidebarFolders";

interface SidebarResizeHandleProps {
  sidebarRef: React.RefObject<HTMLDivElement | null>;
  width: number;
  collapsed: boolean;
  onResizingChange: (resizing: boolean) => void;
  // Live, as the drag crosses the snap point.
  onCollapsedChange: (collapsed: boolean) => void;
  // Released: the expanded width (unchanged when it ended collapsed).
  onCommit: (width: number, collapsed: boolean) => void;
}

// The player needs room too: the sidebar never takes the window past this much of what's left.
const MIN_MAIN_W = 560;
// How far under the narrowest width the edge must go before the sidebar folds into its rail.
const SNAP_PX = 90;

export const SidebarResizeHandle: React.FC<SidebarResizeHandleProps> = ({ sidebarRef, width, collapsed, onResizingChange, onCollapsedChange, onCommit }) => {
  const dragRef = useRef<{ startX: number; startW: number; w: number; collapsed: boolean; raf: number } | null>(null);

  const maxWidth = () => Math.max(SIDEBAR_MIN_W, Math.min(SIDEBAR_MAX_W, window.innerWidth - MIN_MAIN_W));
  const end = () => {
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    onResizingChange(false);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuenow={collapsed ? SIDEBAR_RAIL_W : width}
      title={collapsed ? "Drag to open the sidebar - Ctrl+\\ toggles it" : "Drag to resize, or all the way left to fold it away - double-click resets"}
      tabIndex={0}
      className="group absolute top-0 right-0 bottom-0 z-30 w-2 -mr-px cursor-col-resize touch-none outline-none"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        const startW = sidebarRef.current?.getBoundingClientRect().width ?? (collapsed ? SIDEBAR_RAIL_W : width);
        dragRef.current = { startX: e.clientX, startW, w: startW, collapsed, raf: 0 };
        onResizingChange(true);
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
      }}
      onPointerMove={(e) => {
        const drag = dragRef.current;
        if (!drag) return;
        const raw = drag.startW + e.clientX - drag.startX;
        const fold = raw < SIDEBAR_MIN_W - SNAP_PX;
        if (fold !== drag.collapsed) {
          drag.collapsed = fold;
          onCollapsedChange(fold);
        }
        drag.w = fold ? SIDEBAR_RAIL_W : Math.min(maxWidth(), Math.max(SIDEBAR_MIN_W, raw));
        if (drag.raf) return;
        drag.raf = requestAnimationFrame(() => {
          drag.raf = 0;
          if (sidebarRef.current) sidebarRef.current.style.width = `${drag.w}px`;
        });
      }}
      onPointerUp={(e) => {
        const drag = dragRef.current;
        if (!drag) return;
        dragRef.current = null;
        cancelAnimationFrame(drag.raf);
        e.currentTarget.releasePointerCapture(e.pointerId);
        end();
        onCommit(drag.collapsed ? width : drag.w, drag.collapsed);
      }}
      onPointerCancel={() => {
        const drag = dragRef.current;
        if (!drag) return;
        dragRef.current = null;
        cancelAnimationFrame(drag.raf);
        end();
        if (drag.collapsed !== collapsed) onCollapsedChange(collapsed);
        if (sidebarRef.current) sidebarRef.current.style.width = `${drag.startW}px`;
      }}
      onDoubleClick={() => onCommit(SIDEBAR_MIN_W, false)}
      onKeyDown={(e) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault();
        if (collapsed) {
          if (e.key === "ArrowRight") onCommit(width, false);
          return;
        }
        if (e.key === "ArrowLeft" && width <= SIDEBAR_MIN_W) onCommit(width, true);
        else onCommit(Math.min(maxWidth(), width + (e.key === "ArrowRight" ? 24 : -24)), false);
      }}
    >
      {/* A hairline that lights up on hover and while dragging, so the edge is findable. */}
      <span className="absolute inset-y-0 right-0 w-[3px] rounded-full bg-transparent transition-colors group-hover:bg-blue-400/70 group-focus-visible:bg-blue-500 group-active:bg-blue-500" />
    </div>
  );
};

export interface RailItem {
  key: string;
  label: string;
  icon: React.ReactNode;
  active: boolean;
  onSelect: () => void;
}

// The folded sidebar: a column of its tabs as icons. Picking one opens the sidebar on it. The
// docker is fixed over the window's bottom, and grows as the timeline is dragged taller, so the
// column stops at its top edge (--docker-height, as the Tools tab does) and scrolls the rest into
// view rather than leaving icons hidden behind it.
export const SidebarRail: React.FC<{ groups: RailItem[][]; onExpand: () => void }> = ({ groups, onExpand }) => (
  <div className="flex flex-col items-center h-full pt-2 pb-[calc(var(--docker-height,64px)+8px)] gap-1 overflow-y-auto overflow-x-hidden overscroll-contain [scrollbar-width:thin]">
    <button
      type="button"
      onClick={onExpand}
      title="Open the sidebar (Ctrl+\)"
      className="w-10 h-9 shrink-0 flex items-center justify-center rounded-md text-gray-500 dark:text-neutral-400 hover:text-blue-500 dark:hover:text-blue-400 hover:bg-gray-100 dark:hover:bg-neutral-800"
    >
      <IoChevronForward size={16} />
    </button>
    {groups.map((items, g) => (
      <React.Fragment key={g}>
        <span className="w-6 h-px my-1 shrink-0 bg-gray-200 dark:bg-neutral-700" />
        {items.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={item.onSelect}
            title={item.label}
            aria-label={item.label}
            className={`w-10 h-10 shrink-0 flex items-center justify-center rounded-md transition-colors ${
              item.active
                ? "text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-500/10"
                : "text-gray-500 dark:text-neutral-400 hover:text-blue-500 dark:hover:text-blue-400 hover:bg-gray-100 dark:hover:bg-neutral-800"
            }`}
          >
            {item.icon}
          </button>
        ))}
      </React.Fragment>
    ))}
  </div>
);

// A file name cut to fit its box, keeping the extension in view: "VID_20260822_14…mp4". The whole
// name is the text, so a wider sidebar shows more of it at once - no fixed character count.
export const FileNameText: React.FC<{ name: string; className?: string }> = ({ name, className = "" }) => {
  const dot = name.lastIndexOf(".");
  const hasExt = dot > 0 && name.length - dot <= 8;
  return (
    <span className={`flex min-w-0 ${className}`}>
      <span className="truncate">{hasExt ? name.slice(0, dot) : name}</span>
      {hasExt && <span className="shrink-0">{name.slice(dot)}</span>}
    </span>
  );
};
