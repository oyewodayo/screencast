// components/pdf/AnnotationToolbar.tsx
import React, { useEffect, useState } from "react";
import {
  IoPencil,
  IoArrowUndo,
  IoArrowRedo,
  IoAdd,
  IoRemove,
  IoCheckmarkCircle,
  IoCloudUploadOutline,
  IoAlertCircleOutline,
  IoText,
  IoExpand,
  IoGridOutline,
  IoListOutline,
  IoImageOutline,
  IoDownloadOutline,
} from "react-icons/io5";
import { IoIosArrowBack, IoIosArrowForward } from "react-icons/io";
import { BsHighlighter, BsCursor } from "react-icons/bs";
import { FaEraser } from "react-icons/fa";
import { MdAutoStories } from "react-icons/md";
import { AnnotationTool } from "../../utils/pdfAnnotationTypes";
import { PdfSidebarView } from "./PdfSidebar";
import ColorSwatchPicker from "./ColorSwatchPicker";

interface AnnotationToolbarProps {
  sidebarView: PdfSidebarView | null;
  onSidebarViewChange: (view: PdfSidebarView) => void;
  tool: AnnotationTool | null;
  onToolChange: (tool: AnnotationTool) => void;
  onDeselectTool: () => void;
  onInsertImageClick: () => void;
  color: string;
  onColorChange: (color: string) => void;
  strokeWidth: number;
  onStrokeWidthChange: (width: number) => void;
  currentPageIndex: number;
  numPages: number;
  pageStep: number;
  onPageChange: (pageIndex: number) => void;
  zoom: number;
  onZoomChange: (zoom: number) => void;
  minZoom: number;
  maxZoom: number;
  twoPageMode: boolean;
  onToggleTwoPageMode: () => void;
  // No isFullscreen flag needed — this toolbar only ever renders while *not* fullscreen (see
  // PdfAnnotator, which swaps it out for a minimal exit button instead), so this button only
  // ever needs to say "enter".
  onToggleFullscreen: () => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  isSaving: boolean;
  saveError: string | null;
  isExporting: boolean;
  exportProgress: { completed: number; total: number } | null;
  onExport: () => void;
}

// Every tooltip in this toolbar goes through TooltipLayer (data-tip / data-tip-kbd) rather than a
// native `title`, so shortcuts show as keys instead of being buried in parentheses.
const TOOL_BUTTONS: { tool: AnnotationTool; label: string; shortcut: string; icon: React.ReactNode }[] = [
  { tool: "pen", label: "Pen", shortcut: "P", icon: <IoPencil size={16} /> },
  { tool: "highlighter", label: "Highlighter", shortcut: "H", icon: <BsHighlighter size={15} /> },
  { tool: "text", label: "Text note", shortcut: "T", icon: <IoText size={17} /> },
  { tool: "eraser", label: "Eraser", shortcut: "E", icon: <FaEraser size={14} /> },
];

// Thin vertical hairline used to separate control groups, mirroring macOS/iPadOS toolbar chrome.
const Divider: React.FC = () => <div className="w-px h-5 mx-0.5 bg-black/[0.08] dark:bg-white/[0.1] shrink-0" />;

// Rounded tray grouping related controls (panels, tools, page nav, zoom).
const Group: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className = "" }) => (
  <div className={`flex items-center gap-0.5 p-0.5 rounded-full bg-black/[0.045] dark:bg-white/[0.06] shrink-0 ${className}`}>{children}</div>
);

// Circular, icon-only button — the base unit every control in this toolbar is built from.
const IconButton: React.FC<{
  title: string;
  kbd?: string;
  onClick?: () => void;
  disabled?: boolean;
  active?: boolean;
  children: React.ReactNode;
}> = ({ title, kbd, onClick, disabled, active, children }) => (
  <button
    type="button"
    data-tip={title}
    data-tip-kbd={kbd}
    aria-label={title}
    aria-pressed={active}
    onClick={onClick}
    disabled={disabled}
    className={`shrink-0 flex items-center justify-center w-8 h-8 rounded-full transition-[background-color,color,box-shadow,transform] duration-150 active:scale-90 ${
      active
        ? "bg-white dark:bg-neutral-700 text-blue-600 dark:text-blue-400 shadow-sm"
        : "text-neutral-500 dark:text-neutral-400 hover:bg-black/[0.05] dark:hover:bg-white/[0.08] hover:text-neutral-800 dark:hover:text-neutral-100"
    } disabled:opacity-30 disabled:hover:bg-transparent disabled:pointer-events-none`}
  >
    {children}
  </button>
);

const SaveStatus: React.FC<{ isSaving: boolean; saveError: string | null }> = ({ isSaving, saveError }) => {
  if (saveError) {
    return (
      <div className="flex items-center gap-1.5 text-red-500 text-xs font-medium whitespace-nowrap" data-tip={saveError}>
        <IoAlertCircleOutline size={15} />
        <span className="hidden sm:inline">Save failed</span>
      </div>
    );
  }
  if (isSaving) {
    return (
      <div className="flex items-center gap-1.5 text-neutral-400 dark:text-neutral-500 text-xs font-medium whitespace-nowrap">
        <IoCloudUploadOutline size={15} className="animate-pulse" />
        <span className="hidden sm:inline">Saving…</span>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-1.5 text-emerald-500/80 text-xs font-medium whitespace-nowrap" data-tip="Your markup is saved automatically">
      <IoCheckmarkCircle size={15} />
      <span className="hidden sm:inline">Saved</span>
    </div>
  );
};

// Editable page number: free-typed while focused, committed on Enter/blur, and re-synced from
// `currentPageIndex` whenever navigation happens some other way (arrow keys, prev/next buttons).
const PageJumpInput: React.FC<{ currentPageIndex: number; numPages: number; onPageChange: (pageIndex: number) => void }> = ({
  currentPageIndex,
  numPages,
  onPageChange,
}) => {
  const [value, setValue] = useState(String(currentPageIndex + 1));

  useEffect(() => {
    setValue(String(currentPageIndex + 1));
  }, [currentPageIndex]);

  const commit = (): void => {
    const parsed = parseInt(value, 10);
    if (Number.isFinite(parsed) && numPages > 0) {
      onPageChange(Math.min(Math.max(parsed - 1, 0), numPages - 1));
    } else {
      setValue(String(currentPageIndex + 1));
    }
  };

  return (
    <input
      type="text"
      inputMode="numeric"
      data-tip="Type a page number to jump to it"
      aria-label="Page number"
      value={value}
      onChange={(e) => setValue(e.target.value.replace(/[^0-9]/g, ""))}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          commit();
          e.currentTarget.blur();
        } else if (e.key === "Escape") {
          setValue(String(currentPageIndex + 1));
          e.currentTarget.blur();
        }
      }}
      onBlur={commit}
      onFocus={(e) => e.currentTarget.select()}
      style={{ width: `${Math.max(2, String(numPages).length) + 1}ch` }}
      className="text-center text-xs font-medium text-neutral-700 dark:text-neutral-200 bg-transparent rounded focus:outline-none focus:ring-1 focus:ring-blue-400 tabular-nums"
    />
  );
};

// Editable zoom level: free-typed while focused, committed on Enter/blur (clamped to
// [minZoom, maxZoom]), and re-synced from `zoom` whenever it changes some other way (the +/-
// buttons, trackpad pinch-zoom, etc).
const ZoomInput: React.FC<{ zoom: number; minZoom: number; maxZoom: number; onZoomChange: (zoom: number) => void }> = ({
  zoom,
  minZoom,
  maxZoom,
  onZoomChange,
}) => {
  const [value, setValue] = useState(String(Math.round(zoom * 100)));

  useEffect(() => {
    setValue(String(Math.round(zoom * 100)));
  }, [zoom]);

  const commit = (): void => {
    const parsed = parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      onZoomChange(Math.min(maxZoom, Math.max(minZoom, parsed / 100)));
    } else {
      setValue(String(Math.round(zoom * 100)));
    }
  };

  return (
    <input
      type="text"
      inputMode="numeric"
      data-tip={`Zoom level, ${Math.round(minZoom * 100)}-${Math.round(maxZoom * 100)}%`}
      data-tip-kbd="Ctrl+0"
      aria-label="Zoom level"
      value={value}
      onChange={(e) => setValue(e.target.value.replace(/[^0-9]/g, ""))}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          commit();
          e.currentTarget.blur();
        } else if (e.key === "Escape") {
          setValue(String(Math.round(zoom * 100)));
          e.currentTarget.blur();
        }
      }}
      onBlur={commit}
      onFocus={(e) => e.currentTarget.select()}
      className="w-[4ch] text-center text-xs font-medium text-neutral-700 dark:text-neutral-200 bg-transparent rounded focus:outline-none focus:ring-1 focus:ring-blue-400 tabular-nums"
    />
  );
};

const AnnotationToolbar: React.FC<AnnotationToolbarProps> = ({
  sidebarView,
  onSidebarViewChange,
  tool,
  onToolChange,
  onDeselectTool,
  onInsertImageClick,
  color,
  onColorChange,
  strokeWidth,
  onStrokeWidthChange,
  currentPageIndex,
  numPages,
  pageStep,
  onPageChange,
  zoom,
  onZoomChange,
  minZoom,
  maxZoom,
  twoPageMode,
  onToggleTwoPageMode,
  onToggleFullscreen,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  isSaving,
  saveError,
  isExporting,
  exportProgress,
  onExport,
}) => {
  const pageLabel = twoPageMode && currentPageIndex + 1 < numPages ? `–${currentPageIndex + 2}` : "";

  return (
    <div className="shrink-0 px-4 pt-3 pb-2">
      {/* One row that scrolls sideways (scrollbar hidden) instead of wrapping when the window is
          narrow - a wrapped toolbar reshuffles every control's position. */}
      <div
        className="flex items-center gap-2 mx-auto max-w-fit overflow-x-auto px-2 py-1.5 rounded-2xl bg-white/75 dark:bg-neutral-900/80 backdrop-blur-xl shadow-[0_4px_24px_rgba(0,0,0,0.08)] ring-1 ring-black/[0.04] dark:ring-white/[0.08]"
        style={{ scrollbarWidth: "none" }}
      >
        {/* Sidebar panel toggles: page thumbnails and the PDF's table of contents. Each re-clicks
            itself off (handled by the parent, same toggle pattern as the tool buttons below) so
            there's always an unambiguous way back to "no panel open". */}
        <Group>
          <IconButton title="Page thumbnails" active={sidebarView === "thumbnails"} onClick={() => onSidebarViewChange("thumbnails")}>
            <IoGridOutline size={15} />
          </IconButton>
          <IconButton title="Table of contents" active={sidebarView === "outline"} onClick={() => onSidebarViewChange("outline")}>
            <IoListOutline size={16} />
          </IconButton>
        </Group>

        <Divider />

        {/* Tool segmented control. "Select" is a real, always-present option (not just a side
            effect of re-clicking an active tool) so deselecting has an unmistakable, always-
            highlightable target — clicking an active pen/highlighter/eraser again also toggles
            it off, but this is the explicit, discoverable way to get back to "nothing selected".
            Inserting an image is a one-shot action rather than a persistent tool, so it sits
            just after the tray instead of inside it. */}
        <Group>
          <IconButton title="Select" kbd="V" active={tool === null} onClick={onDeselectTool}>
            <BsCursor size={14} />
          </IconButton>
          {TOOL_BUTTONS.map(({ tool: t, label, shortcut, icon }) => (
            <IconButton key={t} title={label} kbd={shortcut} active={tool === t} onClick={() => onToolChange(t)}>
              {icon}
            </IconButton>
          ))}
        </Group>
        <IconButton title="Insert image" onClick={onInsertImageClick}>
          <IoImageOutline size={16} />
        </IconButton>

        {/* Options for the active tool only - nothing to set with Select. Size is stroke width for
            pen/highlighter, font size for text notes and radius for the eraser. */}
        {tool && (
          <div key={tool} className="flex items-center gap-2.5 pl-1 shrink-0 animate-[tipIn_150ms_ease-out]">
            {tool !== "eraser" && <ColorSwatchPicker color={color} onChange={onColorChange} />}
            <input
              type="range"
              min={1}
              max={20}
              step={1}
              value={strokeWidth}
              onChange={(e) => onStrokeWidthChange(Number(e.target.value))}
              data-tip={tool === "text" ? "Text size" : tool === "eraser" ? "Eraser size" : "Stroke width"}
              data-tip-kbd="[ / ]"
              aria-label="Size"
              className="w-20 accent-blue-500 cursor-pointer"
            />
          </div>
        )}

        <Divider />

        <div className="flex items-center gap-0.5 shrink-0">
          <IconButton title="Undo" kbd="Ctrl+Z" disabled={!canUndo} onClick={onUndo}>
            <IoArrowUndo size={16} />
          </IconButton>
          <IconButton title="Redo" kbd="Ctrl+Shift+Z" disabled={!canRedo} onClick={onRedo}>
            <IoArrowRedo size={16} />
          </IconButton>
        </div>

        <Divider />

        <div className="flex items-center gap-0.5 shrink-0">
          <IconButton title={twoPageMode ? "Single page view" : "Two-page view"} kbd="B" active={twoPageMode} onClick={onToggleTwoPageMode}>
            <MdAutoStories size={17} />
          </IconButton>
          <IconButton title="Fullscreen presentation" kbd="F" onClick={onToggleFullscreen}>
            <IoExpand size={16} />
          </IconButton>
        </div>

        <Divider />

        {/* Page navigator */}
        <Group className="pr-1">
          <IconButton title="Previous page" kbd="←" disabled={currentPageIndex <= 0} onClick={() => onPageChange(currentPageIndex - pageStep)}>
            <IoIosArrowBack size={15} />
          </IconButton>
          {numPages === 0 ? (
            <span className="text-xs font-medium text-neutral-400 dark:text-neutral-500 w-14 text-center">…</span>
          ) : (
            <span className="flex items-center gap-1 px-0.5 text-xs font-medium whitespace-nowrap tabular-nums">
              <PageJumpInput currentPageIndex={currentPageIndex} numPages={numPages} onPageChange={onPageChange} />
              <span className="text-neutral-400 dark:text-neutral-500">
                {pageLabel} of {numPages}
              </span>
            </span>
          )}
          <IconButton title="Next page" kbd="→" disabled={currentPageIndex >= numPages - 1} onClick={() => onPageChange(currentPageIndex + pageStep)}>
            <IoIosArrowForward size={15} />
          </IconButton>
        </Group>

        {/* Zoom */}
        <Group>
          <IconButton title="Zoom out" kbd="Ctrl+-" disabled={zoom <= minZoom} onClick={() => onZoomChange(Math.max(minZoom, Math.round((zoom - 0.25) * 100) / 100))}>
            <IoRemove size={16} />
          </IconButton>
          <span className="flex items-center text-xs font-medium text-neutral-400 dark:text-neutral-500 whitespace-nowrap tabular-nums">
            <ZoomInput zoom={zoom} minZoom={minZoom} maxZoom={maxZoom} onZoomChange={onZoomChange} />%
          </span>
          <IconButton title="Zoom in" kbd="Ctrl+=" disabled={zoom >= maxZoom} onClick={() => onZoomChange(Math.min(maxZoom, Math.round((zoom + 0.25) * 100) / 100))}>
            <IoAdd size={16} />
          </IconButton>
        </Group>

        <Divider />

        {/* Flattens annotations into a brand-new standalone PDF next to the source file — unlike
            the sidecar JSON SaveStatus reports on, this is what makes markup readable outside
            this app (a real PDF, not something that needs to be re-composited on load). Shows its
            page progress inline while running, rather than only in a tooltip. */}
        <div className="flex items-center gap-1 shrink-0">
          <IconButton
            title={isExporting ? "Exporting…" : "Export as a PDF with your markup"}
            disabled={isExporting}
            onClick={onExport}
          >
            <IoDownloadOutline size={16} className={isExporting ? "animate-pulse" : undefined} />
          </IconButton>
          {isExporting && exportProgress && (
            <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400 whitespace-nowrap tabular-nums">
              {exportProgress.completed}/{exportProgress.total}
            </span>
          )}
        </div>

        <div className="pr-1.5 shrink-0">
          <SaveStatus isSaving={isSaving} saveError={saveError} />
        </div>
      </div>
    </div>
  );
};

export default AnnotationToolbar;
