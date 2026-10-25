// components/pdf/PdfViewerControls.tsx
// The PDF viewer's always-visible floating chrome: save status (top-left), a vertical zoom column
// (top-right), and the Edit button with the page navigator beneath it (bottom-right). The markup tools themselves live in the vertical dock
// (AnnotationToolbar) that the Edit button reveals.
import React, { useEffect, useState } from "react";
import { IoAdd, IoRemove, IoPencil, IoClose, IoCheckmarkCircle, IoCloudUploadOutline, IoAlertCircleOutline, IoScanOutline, IoChatbubblesOutline } from "react-icons/io5";
import { IoIosArrowBack, IoIosArrowForward } from "react-icons/io";

const PillButton: React.FC<{
  title: string;
  kbd?: string;
  onClick?: () => void;
  disabled?: boolean;
  active?: boolean;
  compact?: boolean;
  tipSide?: "left";
  children: React.ReactNode;
}> = ({ title, kbd, onClick, disabled, active, compact, tipSide, children }) => (
  <button
    type="button"
    data-tip={title}
    data-tip-kbd={kbd}
    data-tip-side={tipSide}
    aria-label={title}
    aria-pressed={active}
    onClick={onClick}
    disabled={disabled}
    className={`shrink-0 flex items-center justify-center ${compact ? "w-6 h-6" : "w-8 h-8"} rounded-full transition-[background-color,color,transform] duration-150 active:scale-90 ${
      active
        ? "bg-blue-500/10 text-blue-600 dark:text-blue-400"
        : "text-neutral-500 dark:text-neutral-400 hover:bg-black/[0.05] dark:hover:bg-white/[0.08] hover:text-neutral-800 dark:hover:text-neutral-100"
    } disabled:opacity-30 disabled:hover:bg-transparent disabled:pointer-events-none`}
  >
    {children}
  </button>
);

// Free-typed while focused, committed on Enter/blur, and re-synced from `value` whenever it
// changes some other way (buttons, shortcuts, pinch-zoom, swipes).
const CommitInput: React.FC<{
  value: number;
  onCommit: (parsed: number | null) => void;
  tip: string;
  kbd?: string;
  label: string;
  widthCh: number;
  className?: string;
  tipSide?: "left";
}> = ({ value, onCommit, tip, kbd, label, widthCh, className = "text-xs", tipSide }) => {
  const [text, setText] = useState(String(value));

  useEffect(() => {
    setText(String(value));
  }, [value]);

  const commit = (): void => {
    const parsed = parseInt(text, 10);
    if (Number.isFinite(parsed)) onCommit(parsed);
    else setText(String(value));
  };

  return (
    <input
      type="text"
      inputMode="numeric"
      data-tip={tip}
      data-tip-kbd={kbd}
      data-tip-side={tipSide}
      aria-label={label}
      value={text}
      onChange={(e) => setText(e.target.value.replace(/[^0-9]/g, ""))}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          commit();
          e.currentTarget.blur();
        } else if (e.key === "Escape") {
          setText(String(value));
          e.currentTarget.blur();
        }
      }}
      onBlur={commit}
      onFocus={(e) => e.currentTarget.select()}
      style={{ width: `${widthCh}ch` }}
      className={`text-center ${className} font-semibold text-neutral-700 dark:text-neutral-200 bg-transparent rounded focus:outline-none focus:ring-1 focus:ring-blue-400 tabular-nums`}
    />
  );
};

// Top-left: a quiet autosave/export readout, kept apart from the controls so it never reads as one.
export const SaveIndicator: React.FC<{ isSaving: boolean; saveError: string | null; exportProgress: { completed: number; total: number } | null }> = ({
  isSaving,
  saveError,
  exportProgress,
}) => {
  const chip = "flex items-center gap-1 h-7 px-2 rounded-full bg-white/70 dark:bg-neutral-900/70 backdrop-blur-xl ring-1 ring-black/[0.04] dark:ring-white/[0.06] text-[11px] font-medium whitespace-nowrap tabular-nums";
  if (exportProgress) {
    return (
      <span className={`${chip} text-neutral-500 dark:text-neutral-400`}>
        <IoCloudUploadOutline size={13} className="animate-pulse" />
        Exporting {exportProgress.completed}/{exportProgress.total}
      </span>
    );
  }
  if (saveError) {
    return (
      <span className={`${chip} text-red-500`} data-tip={saveError}>
        <IoAlertCircleOutline size={13} />
        Save failed
      </span>
    );
  }
  if (isSaving) {
    return (
      <span className="flex items-center justify-center w-7 h-7 text-neutral-400 dark:text-neutral-500" data-tip="Saving…">
        <IoCloudUploadOutline size={14} className="animate-pulse" />
      </span>
    );
  }
  return (
    <span className="flex items-center justify-center w-7 h-7 text-emerald-500/80" data-tip="Your markup is saved automatically">
      <IoCheckmarkCircle size={14} />
    </span>
  );
};

// Top-right, vertical: fit, then zoom in / level / zoom out stacked like a slider's ends.
export const ZoomControl: React.FC<{
  zoom: number;
  minZoom: number;
  maxZoom: number;
  fitMode: boolean;
  onZoomChange: (zoom: number) => void;
  onFit: () => void;
}> = ({ zoom, minZoom, maxZoom, fitMode, onZoomChange, onFit }) => (
  <div className="flex flex-col items-center gap-0.5 p-0.5 rounded-full bg-white/80 dark:bg-neutral-900/80 backdrop-blur-xl shadow-[0_4px_16px_rgba(0,0,0,0.08)] ring-1 ring-black/[0.05] dark:ring-white/[0.08]">
    <PillButton compact title="Fit to screen" kbd="Ctrl+0" tipSide="left" active={fitMode} onClick={onFit}>
      <IoScanOutline size={13} />
    </PillButton>
    <div className="w-3.5 h-px bg-black/[0.08] dark:bg-white/[0.1]" />
    <PillButton compact title="Zoom in" kbd="Ctrl+=" tipSide="left" disabled={zoom >= maxZoom} onClick={() => onZoomChange(Math.min(maxZoom, Math.round((zoom + 0.25) * 100) / 100))}>
      <IoAdd size={14} />
    </PillButton>
    <CommitInput
      value={Math.round(zoom * 100)}
      onCommit={(parsed) => parsed !== null && onZoomChange(Math.min(maxZoom, Math.max(minZoom, parsed / 100)))}
      tip={`Zoom level (%), ${Math.round(minZoom * 100)}-${Math.round(maxZoom * 100)}`}
      tipSide="left"
      label="Zoom level"
      widthCh={3.5}
      className="text-[10px]"
    />
    <PillButton compact title="Zoom out" kbd="Ctrl+-" tipSide="left" disabled={zoom <= minZoom} onClick={() => onZoomChange(Math.max(minZoom, Math.round((zoom - 0.25) * 100) / 100))}>
      <IoRemove size={14} />
    </PillButton>
  </div>
);

export const EditButton: React.FC<{ open: boolean; onToggle: () => void }> = ({ open, onToggle }) => (
  <button
    type="button"
    data-tip={open ? "Done editing" : "Edit - draw, highlight and annotate"}
    data-tip-side="left"
    aria-label={open ? "Close tools" : "Edit"}
    aria-expanded={open}
    onClick={onToggle}
    className={`relative flex items-center justify-center w-10 h-10 rounded-full transition-[transform,box-shadow,background-color,color] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] hover:scale-105 active:scale-95 ${
      open
        ? "bg-white text-neutral-800 ring-1 ring-black/[0.08] dark:bg-neutral-800 dark:text-neutral-100 dark:ring-white/[0.1] shadow-[0_4px_16px_rgba(0,0,0,0.12)]"
        : "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900 shadow-[0_6px_20px_rgba(0,0,0,0.28)]"
    }`}
  >
    <span className={`absolute transition-[transform,opacity] duration-300 ${open ? "opacity-0 rotate-90 scale-50" : "opacity-100 rotate-0 scale-100"}`}>
      <IoPencil size={16} />
    </span>
    <span className={`absolute transition-[transform,opacity] duration-300 ${open ? "opacity-100 rotate-0 scale-100" : "opacity-0 -rotate-90 scale-50"}`}>
      <IoClose size={19} />
    </span>
  </button>
);

// Amber count badge shared by the floating Comments chip and the dock's Comments entry.
export const CountBadge: React.FC<{ count: number; className?: string }> = ({ count, className = "" }) => (
  <span
    key={count}
    className={`pdfPopIn absolute pointer-events-none min-w-[16px] h-4 px-1 flex items-center justify-center rounded-full bg-amber-400 text-[9.5px] font-bold leading-none text-neutral-900 tabular-nums ring-2 ring-white dark:ring-neutral-900 ${className}`}
  >
    {count > 99 ? "99+" : count}
  </span>
);

// Shown above the Edit button while the tools dock is closed, whenever the document has comments.
export const CommentsChip: React.FC<{ count: number; active: boolean; onClick: () => void }> = ({ count, active, onClick }) => (
  <button
    type="button"
    data-tip={active ? "Hide comments" : `${count} comment${count === 1 ? "" : "s"} in this PDF`}
    data-tip-side="left"
    aria-label="Comments"
    aria-pressed={active}
    onClick={onClick}
    className={`pdfPopIn relative flex items-center justify-center w-10 h-10 rounded-full backdrop-blur-xl ring-1 transition-[transform,background-color,color] duration-200 hover:scale-105 active:scale-95 shadow-[0_4px_16px_rgba(0,0,0,0.10)] ${
      active
        ? "bg-amber-400 text-neutral-900 ring-amber-500/30"
        : "bg-white/85 dark:bg-neutral-900/85 text-amber-500 ring-black/[0.05] dark:ring-white/[0.08]"
    }`}
  >
    <IoChatbubblesOutline size={18} />
    {!active && <CountBadge count={count} className="-top-1 -right-1" />}
  </button>
);

export const PageNavigator: React.FC<{
  currentPageIndex: number;
  numPages: number;
  pageStep: number;
  twoPageMode: boolean;
  onPageChange: (pageIndex: number) => void;
}> = ({ currentPageIndex, numPages, pageStep, twoPageMode, onPageChange }) => {
  const spreadSuffix = twoPageMode && currentPageIndex + 1 < numPages ? `–${currentPageIndex + 2}` : "";
  // Deliberately smaller than the zoom pill: it sits under the Edit button as a quiet readout.
  return (
    <div className="flex items-center p-0.5 rounded-full bg-white/80 dark:bg-neutral-900/80 backdrop-blur-xl shadow-[0_4px_16px_rgba(0,0,0,0.08)] ring-1 ring-black/[0.05] dark:ring-white/[0.08]">
      <PillButton compact title="Previous page" kbd="←" disabled={currentPageIndex <= 0} onClick={() => onPageChange(currentPageIndex - pageStep)}>
        <IoIosArrowBack size={12} />
      </PillButton>
      {numPages === 0 ? (
        <span className="text-[11px] font-medium text-neutral-400 dark:text-neutral-500 w-10 text-center">…</span>
      ) : (
        <span className="flex items-center gap-0.5 text-[11px] font-medium whitespace-nowrap tabular-nums">
          <CommitInput
            value={currentPageIndex + 1}
            onCommit={(parsed) => parsed !== null && onPageChange(Math.min(Math.max(parsed - 1, 0), numPages - 1))}
            tip="Type a page number to jump to it"
            label="Page number"
            widthCh={Math.max(1, String(numPages).length) + 0.5}
            className="text-[11px]"
          />
          <span className="text-neutral-400 dark:text-neutral-500">
            {spreadSuffix} of {numPages}
          </span>
        </span>
      )}
      <PillButton compact title="Next page" kbd="→" disabled={currentPageIndex + pageStep > numPages - 1} onClick={() => onPageChange(currentPageIndex + pageStep)}>
        <IoIosArrowForward size={12} />
      </PillButton>
    </div>
  );
};
