// components/pdf/AnnotationToolbar.tsx
import React, { useEffect, useState } from "react";
import { IoPencil, IoArrowUndo, IoArrowRedo, IoAdd, IoRemove, IoCheckmarkCircle, IoCloudUploadOutline, IoAlertCircleOutline, IoDocumentTextOutline, IoText, IoExpand } from "react-icons/io5";
import { IoIosArrowBack, IoIosArrowForward } from "react-icons/io";
import { BsHighlighter, BsCursor } from "react-icons/bs";
import { FaEraser } from "react-icons/fa";
import { MdAutoStories } from "react-icons/md";
import { AnnotationTool } from "../../utils/pdfAnnotationTypes";
import ColorSwatchPicker from "./ColorSwatchPicker";

interface AnnotationToolbarProps {
  title?: string;
  tool: AnnotationTool | null;
  onToolChange: (tool: AnnotationTool) => void;
  onDeselectTool: () => void;
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
}

const TOOL_BUTTONS: { tool: AnnotationTool; label: string; shortcut: string; icon: React.ReactNode }[] = [
  { tool: "pen", label: "Pen", shortcut: "P", icon: <IoPencil size={16} /> },
  { tool: "highlighter", label: "Highlighter", shortcut: "H", icon: <BsHighlighter size={15} /> },
  { tool: "text", label: "Text note", shortcut: "T", icon: <IoText size={17} /> },
  { tool: "eraser", label: "Eraser", shortcut: "E", icon: <FaEraser size={14} /> },
];

// Thin vertical hairline used to separate control groups, mirroring macOS/iPadOS toolbar chrome.
const Divider: React.FC = () => <div className="w-px h-6 bg-black/[0.06] dark:bg-white/[0.1] shrink-0" />;

// Circular, icon-only button — the base unit every control in this toolbar is built from.
const IconButton: React.FC<{
  title: string;
  onClick?: () => void;
  disabled?: boolean;
  active?: boolean;
  children: React.ReactNode;
}> = ({ title, onClick, disabled, active, children }) => (
  <button
    type="button"
    title={title}
    onClick={onClick}
    disabled={disabled}
    className={`flex items-center justify-center w-8 h-8 rounded-full transition-colors duration-150 ${
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
      <div className="flex items-center gap-1.5 text-red-500 text-xs font-medium" title={saveError}>
        <IoAlertCircleOutline size={15} />
        <span className="hidden sm:inline">Save failed</span>
      </div>
    );
  }
  if (isSaving) {
    return (
      <div className="flex items-center gap-1.5 text-neutral-400 dark:text-neutral-500 text-xs font-medium">
        <IoCloudUploadOutline size={15} className="animate-pulse" />
        <span className="hidden sm:inline">Saving…</span>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-1.5 text-emerald-500/80 text-xs font-medium">
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
      title="Jump to page"
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
      className="w-7 text-center text-xs font-medium text-neutral-700 dark:text-neutral-200 bg-transparent rounded focus:outline-none focus:ring-1 focus:ring-blue-400 tabular-nums"
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
      title={`Zoom level (${Math.round(minZoom * 100)}-${Math.round(maxZoom * 100)}%) — Ctrl+0 to reset to 100%`}
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
      className="w-8 text-center text-xs font-medium text-neutral-600 dark:text-neutral-300 bg-transparent rounded focus:outline-none focus:ring-1 focus:ring-blue-400 tabular-nums"
    />
  );
};

const AnnotationToolbar: React.FC<AnnotationToolbarProps> = ({
  title,
  tool,
  onToolChange,
  onDeselectTool,
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
}) => {
  return (
    <div className="shrink-0 px-4 pt-3 pb-2">
      <div className="flex items-center gap-3 mx-auto max-w-fit px-3 py-2 rounded-2xl bg-white/75 dark:bg-neutral-900/80 backdrop-blur-xl shadow-[0_4px_24px_rgba(0,0,0,0.08)] ring-1 ring-black/[0.04] dark:ring-white/[0.08]">
        {title && (
          <>
            <div className="flex items-center gap-1.5 pl-1 pr-1 text-neutral-600 dark:text-neutral-300 max-w-[160px]" title={title}>
              <IoDocumentTextOutline size={15} className="shrink-0 text-neutral-400 dark:text-neutral-500" />
              <span className="text-sm font-medium truncate">{title}</span>
            </div>
            <Divider />
          </>
        )}

        {/* Tool segmented control. "Select" is a real, always-present option (not just a side
            effect of re-clicking an active tool) so deselecting has an unmistakable, always-
            highlightable target — clicking an active pen/highlighter/eraser again also toggles
            it off, but this is the explicit, discoverable way to get back to "nothing selected". */}
        <div className="flex items-center gap-0.5 p-0.5 rounded-full bg-black/[0.045] dark:bg-white/[0.06]">
          <IconButton title="Select / no tool (V)" active={tool === null} onClick={onDeselectTool}>
            <BsCursor size={14} />
          </IconButton>
          {TOOL_BUTTONS.map(({ tool: t, label, shortcut, icon }) => (
            <IconButton key={t} title={`${label} (${shortcut})`} active={tool === t} onClick={() => onToolChange(t)}>
              {icon}
            </IconButton>
          ))}
        </div>

        {tool && tool !== "eraser" && (
          <>
            <Divider />
            <ColorSwatchPicker color={color} onChange={onColorChange} />
          </>
        )}

        <div className="flex items-center gap-2 pl-1">
          <input
            type="range"
            min={1}
            max={20}
            step={1}
            value={strokeWidth}
            onChange={(e) => onStrokeWidthChange(Number(e.target.value))}
            title="Stroke width ([ / ])"
            className="w-16 accent-blue-500"
          />
        </div>

        <Divider />

        <div className="flex items-center gap-0.5">
          <IconButton title="Undo (Ctrl+Z)" disabled={!canUndo} onClick={onUndo}>
            <IoArrowUndo size={16} />
          </IconButton>
          <IconButton title="Redo (Ctrl+Shift+Z)" disabled={!canRedo} onClick={onRedo}>
            <IoArrowRedo size={16} />
          </IconButton>
        </div>

        <Divider />

        <IconButton title={twoPageMode ? "Single page view (B)" : "Two-page view (B)"} active={twoPageMode} onClick={onToggleTwoPageMode}>
          <MdAutoStories size={17} />
        </IconButton>

        <IconButton title="Enter fullscreen / presentation mode (F)" onClick={onToggleFullscreen}>
          <IoExpand size={16} />
        </IconButton>

        <Divider />

        {/* Page navigator pill */}
        <div className="flex items-center gap-1 rounded-full bg-black/[0.045] dark:bg-white/[0.06] pl-1 pr-2 py-0.5">
          <IconButton title="Previous page (←)" disabled={currentPageIndex <= 0} onClick={() => onPageChange(currentPageIndex - pageStep)}>
            <IoIosArrowBack size={15} />
          </IconButton>
          {numPages === 0 ? (
            <span className="text-xs font-medium text-neutral-600 dark:text-neutral-300 w-14 text-center">…</span>
          ) : (
            <span className="flex items-center gap-1 text-xs font-medium text-neutral-600 dark:text-neutral-300 tabular-nums">
              <PageJumpInput currentPageIndex={currentPageIndex} numPages={numPages} onPageChange={onPageChange} />
              <span className="text-neutral-400 dark:text-neutral-500">
                {twoPageMode && currentPageIndex + 1 < numPages ? `-${currentPageIndex + 2} ` : " "}
                / {numPages}
              </span>
            </span>
          )}
          <IconButton title="Next page (→)" disabled={currentPageIndex >= numPages - 1} onClick={() => onPageChange(currentPageIndex + pageStep)}>
            <IoIosArrowForward size={15} />
          </IconButton>
        </div>

        {/* Zoom pill */}
        <div className="flex items-center gap-1 rounded-full bg-black/[0.045] dark:bg-white/[0.06] pl-1 pr-2 py-0.5">
          <IconButton title="Zoom out (Ctrl+-)" disabled={zoom <= minZoom} onClick={() => onZoomChange(Math.max(minZoom, Math.round((zoom - 0.25) * 100) / 100))}>
            <IoRemove size={16} />
          </IconButton>
          <span className="flex items-center text-xs font-medium text-neutral-600 dark:text-neutral-300 tabular-nums">
            <ZoomInput zoom={zoom} minZoom={minZoom} maxZoom={maxZoom} onZoomChange={onZoomChange} />%
          </span>
          <IconButton title="Zoom in (Ctrl+=)" disabled={zoom >= maxZoom} onClick={() => onZoomChange(Math.min(maxZoom, Math.round((zoom + 0.25) * 100) / 100))}>
            <IoAdd size={16} />
          </IconButton>
        </div>

        <Divider />

        <div className="pr-1">
          <SaveStatus isSaving={isSaving} saveError={saveError} />
        </div>
      </div>
    </div>
  );
};

export default AnnotationToolbar;
