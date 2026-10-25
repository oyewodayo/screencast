// components/pdf/AnnotationToolbar.tsx
import React, { useLayoutEffect, useRef, useState } from "react";
import { IoPencil, IoArrowUndo, IoArrowRedo, IoText, IoExpand, IoGridOutline, IoListOutline, IoImageOutline, IoDownloadOutline, IoChatbubblesOutline } from "react-icons/io5";
import { BsHighlighter, BsCursor } from "react-icons/bs";
import { FaEraser } from "react-icons/fa";
import { MdAutoStories } from "react-icons/md";
import { AnnotationTool } from "../../utils/pdfAnnotationTypes";
import { PdfSidebarView } from "./PdfSidebar";
import ColorSwatchPicker from "./ColorSwatchPicker";
import { CountBadge } from "./PdfViewerControls";

interface AnnotationToolbarProps {
  // The dock stays mounted while closed so it can animate both ways - `open` drives the reveal.
  open: boolean;
  sidebarView: PdfSidebarView | null;
  onSidebarViewChange: (view: PdfSidebarView) => void;
  commentCount: number;
  tool: AnnotationTool | null;
  onToolChange: (tool: AnnotationTool) => void;
  onDeselectTool: () => void;
  onInsertImageClick: () => void;
  color: string;
  onColorChange: (color: string) => void;
  strokeWidth: number;
  onStrokeWidthChange: (width: number) => void;
  twoPageMode: boolean;
  onToggleTwoPageMode: () => void;
  // Only ever rendered while *not* fullscreen (PdfAnnotator hides all of its chrome in
  // presentation mode), so this button only ever needs to say "enter".
  onToggleFullscreen: () => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  isExporting: boolean;
  onExport: () => void;
}

// Every tooltip in this dock goes through TooltipLayer (data-tip / data-tip-kbd) rather than a
// native `title`, so shortcuts show as keys instead of being buried in parentheses.
const TOOL_BUTTONS: { tool: AnnotationTool; label: string; shortcut: string; icon: React.ReactNode }[] = [
  { tool: "pen", label: "Pen", shortcut: "P", icon: <IoPencil size={14} /> },
  { tool: "highlighter", label: "Highlighter", shortcut: "H", icon: <BsHighlighter size={13} /> },
  { tool: "text", label: "Text note", shortcut: "T", icon: <IoText size={15} /> },
  { tool: "eraser", label: "Eraser", shortcut: "E", icon: <FaEraser size={12} /> },
];

type DockEntry =
  | { kind: "divider"; key: string }
  | {
      kind: "button";
      key: string;
      title: string;
      kbd?: string;
      active?: boolean;
      disabled?: boolean;
      onClick: () => void;
      icon: React.ReactNode;
      tool?: AnnotationTool;
      badge?: number;
    };

// Total stagger spread across the dock's buttons as it rises - small enough that the last button
// lands well inside the container's own reveal, large enough to read as "rising up".
const STAGGER_MS = 14;

const AnnotationToolbar: React.FC<AnnotationToolbarProps> = ({
  open,
  sidebarView,
  onSidebarViewChange,
  commentCount,
  tool,
  onToolChange,
  onDeselectTool,
  onInsertImageClick,
  color,
  onColorChange,
  strokeWidth,
  onStrokeWidthChange,
  twoPageMode,
  onToggleTwoPageMode,
  onToggleFullscreen,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  isExporting,
  onExport,
}) => {
  const dockRef = useRef<HTMLDivElement>(null);
  const toolButtonRefs = useRef<Partial<Record<AnnotationTool, HTMLButtonElement | null>>>({});
  // Vertical center of the active tool's button, relative to the dock - the options flyout (color
  // + size) hangs off the left of the dock at that height, so it reads as belonging to that tool.
  const [optionsTop, setOptionsTop] = useState<number | null>(null);

  // Re-measured on dock scroll too - in a short window the dock scrolls and the flyout follows.
  const measureOptionsTop = (): void => {
    const button = tool ? toolButtonRefs.current[tool] : null;
    const dock = dockRef.current;
    if (!button || !dock) {
      setOptionsTop(null);
      return;
    }
    const b = button.getBoundingClientRect();
    const d = dock.getBoundingClientRect();
    const center = b.top + b.height / 2 - d.top;
    // Hidden while its button is scrolled out of the dock - it would otherwise point at nothing.
    setOptionsTop(center >= 0 && center <= d.height ? center : null);
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(measureOptionsTop, [tool, open]);

  // Top-to-bottom. The view toggle sits at the very bottom - closest to the Edit button it rises
  // from - with the document-level actions above it and the markup tools in the middle.
  const entries: DockEntry[] = [
    { kind: "button", key: "undo", title: "Undo", kbd: "Ctrl+Z", disabled: !canUndo, onClick: onUndo, icon: <IoArrowUndo size={14} /> },
    { kind: "button", key: "redo", title: "Redo", kbd: "Ctrl+Shift+Z", disabled: !canRedo, onClick: onRedo, icon: <IoArrowRedo size={14} /> },
    { kind: "divider", key: "d1" },
    // "Select" is a real, always-present option (not just a side effect of re-clicking an active
    // tool) so deselecting has an unmistakable, always-highlightable target.
    { kind: "button", key: "select", title: "Select", kbd: "V", active: tool === null, onClick: onDeselectTool, icon: <BsCursor size={12} /> },
    ...TOOL_BUTTONS.map(
      ({ tool: t, label, shortcut, icon }): DockEntry => ({
        kind: "button",
        key: t,
        title: label,
        kbd: shortcut,
        active: tool === t,
        onClick: () => onToolChange(t),
        icon,
        tool: t,
      })
    ),
    // A one-shot action rather than a persistent tool, so it never shows as active.
    { kind: "button", key: "image", title: "Insert image", onClick: onInsertImageClick, icon: <IoImageOutline size={14} /> },
    { kind: "divider", key: "d2" },
    {
      kind: "button",
      key: "thumbnails",
      title: "Page thumbnails",
      active: sidebarView === "thumbnails",
      onClick: () => onSidebarViewChange("thumbnails"),
      icon: <IoGridOutline size={13} />,
    },
    {
      kind: "button",
      key: "outline",
      title: "Table of contents",
      active: sidebarView === "outline",
      onClick: () => onSidebarViewChange("outline"),
      icon: <IoListOutline size={14} />,
    },
    {
      kind: "button",
      key: "comments",
      title: commentCount > 0 ? `Comments (${commentCount})` : "Comments",
      active: sidebarView === "comments",
      onClick: () => onSidebarViewChange("comments"),
      icon: <IoChatbubblesOutline size={14} />,
      badge: commentCount,
    },
    // Flattens annotations into a brand-new standalone PDF next to the source file - unlike the
    // sidecar JSON the save indicator reports on, this is readable outside this app.
    {
      kind: "button",
      key: "export",
      title: isExporting ? "Exporting…" : "Export as a PDF with your markup",
      disabled: isExporting,
      onClick: onExport,
      icon: <IoDownloadOutline size={14} className={isExporting ? "animate-pulse" : undefined} />,
    },
    { kind: "divider", key: "d3" },
    { kind: "button", key: "fullscreen", title: "Fullscreen presentation", kbd: "F", onClick: onToggleFullscreen, icon: <IoExpand size={14} /> },
    {
      kind: "button",
      key: "view",
      title: twoPageMode ? "Single page view" : "Two-page view",
      kbd: "B",
      active: twoPageMode,
      onClick: onToggleTwoPageMode,
      icon: <MdAutoStories size={15} />,
    },
  ];

  const count = entries.length;

  return (
    <div className="relative min-h-0 flex flex-col">
      {/* Options for the active tool only - nothing to set with Select. Size is stroke width for
          pen/highlighter, font size for text notes and radius for the eraser. */}
      {open && tool && optionsTop !== null && (
        <div
          key={tool}
          style={{ top: optionsTop }}
          className="absolute right-full mr-2 -translate-y-1/2 pointer-events-auto flex flex-col items-center gap-2 px-1 py-2 rounded-full bg-white/85 dark:bg-neutral-900/85 backdrop-blur-xl shadow-[0_4px_16px_rgba(0,0,0,0.10)] ring-1 ring-black/[0.05] dark:ring-white/[0.08] animate-[dockOptionsIn_180ms_cubic-bezier(0.2,0.9,0.3,1.2)]"
        >
          {tool !== "eraser" && <ColorSwatchPicker size="sm" placement="left" color={color} onChange={onColorChange} />}
          {/* Vertical slider, larger values at the top (vertical-lr + rtl). */}
          <input
            type="range"
            min={1}
            max={20}
            step={1}
            value={strokeWidth}
            onChange={(e) => onStrokeWidthChange(Number(e.target.value))}
            data-tip={tool === "text" ? "Text size" : tool === "eraser" ? "Eraser size" : "Stroke width"}
            data-tip-kbd="[ / ]"
            data-tip-side="left"
            aria-label="Size"
            style={{ writingMode: "vertical-lr", direction: "rtl" }}
            className="w-3 h-16 accent-blue-500 cursor-pointer"
          />
          <span className="text-[10px] leading-none font-medium text-neutral-500 dark:text-neutral-400 tabular-nums">{strokeWidth}</span>
        </div>
      )}

      {/* The reveal: the dock's clip rises from its bottom edge (where the Edit button is) while
          the buttons themselves drift up in a bottom-first stagger. While closed it stays mounted
          but inert, so closing animates too. */}
      <div
        ref={dockRef}
        aria-hidden={!open}
        onScroll={measureOptionsTop}
        style={{
          clipPath: open ? "inset(0 0 0 0 round 16px)" : "inset(100% 0 0 0 round 16px)",
          transition: "clip-path 380ms cubic-bezier(0.22, 1, 0.36, 1), opacity 260ms ease, transform 380ms cubic-bezier(0.22, 1, 0.36, 1)",
          opacity: open ? 1 : 0,
          transform: open ? "translateY(0)" : "translateY(16px)",
          scrollbarWidth: "none",
        }}
        className={`min-h-0 flex flex-col items-center p-0.5 overflow-y-auto rounded-full bg-white/80 dark:bg-neutral-900/80 backdrop-blur-xl shadow-[0_4px_16px_rgba(0,0,0,0.10)] ring-1 ring-black/[0.05] dark:ring-white/[0.08] ${
          open ? "pointer-events-auto" : "pointer-events-none"
        }`}
      >
        {entries.map((entry, i) => {
          const fromBottom = count - 1 - i;
          const itemStyle: React.CSSProperties = {
            transition: "opacity 240ms ease, transform 320ms cubic-bezier(0.22, 1, 0.36, 1)",
            transitionDelay: open ? `${fromBottom * STAGGER_MS}ms` : "0ms",
            opacity: open ? 1 : 0,
            transform: open ? "translateY(0)" : "translateY(10px)",
          };
          if (entry.kind === "divider") {
            return <div key={entry.key} style={itemStyle} className="w-3.5 h-px my-0.5 bg-black/[0.08] dark:bg-white/[0.1] shrink-0" />;
          }
          return (
            <div key={entry.key} style={itemStyle} className="shrink-0 relative">
            <button
              ref={entry.tool ? (el) => void (toolButtonRefs.current[entry.tool!] = el) : undefined}
              type="button"
              tabIndex={open ? 0 : -1}
              data-tip={entry.title}
              data-tip-kbd={entry.kbd}
              data-tip-side="left"
              aria-label={entry.title}
              aria-pressed={entry.active}
              onClick={entry.onClick}
              disabled={entry.disabled}
              className={`flex items-center justify-center w-7 h-7 rounded-full transition-[background-color,color,box-shadow,transform] duration-150 active:scale-90 ${
                entry.active
                  ? "bg-blue-500 text-white shadow-[0_2px_8px_rgba(59,130,246,0.45)]"
                  : "text-neutral-500 dark:text-neutral-400 hover:bg-black/[0.05] dark:hover:bg-white/[0.08] hover:text-neutral-800 dark:hover:text-neutral-100"
              } disabled:opacity-30 disabled:hover:bg-transparent disabled:pointer-events-none`}
            >
              {entry.icon}
            </button>
            {!!entry.badge && !entry.active && <CountBadge count={entry.badge} className="-top-0.5 -right-0.5 scale-[0.85] origin-top-right" />}
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default AnnotationToolbar;
