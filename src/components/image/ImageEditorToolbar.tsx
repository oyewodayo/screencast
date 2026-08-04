// components/image/ImageEditorToolbar.tsx
//
// Visually/structurally mirrors AnnotationToolbar.tsx (the PDF annotator's own floating toolbar)
// - same pill-shaped segmented tool groups, icon buttons, and undo/redo/save layout - adapted for
// the standalone image editor's own tool set (crop/rotate/flip + shapes/blur + adjustments instead
// of pen/highlighter/text/eraser only).
import React from "react";
import {
  IoArrowUndo,
  IoArrowRedo,
  IoCheckmarkCircle,
  IoCloudUploadOutline,
  IoAlertCircleOutline,
  IoAdd,
  IoRemove,
  IoPencil,
  IoText,
  IoSquareOutline,
  IoEllipseOutline,
  IoCropOutline,
  IoTrashOutline,
  IoDownloadOutline,
  IoCheckmark,
  IoCloseOutline,
  IoImageOutline,
} from "react-icons/io5";
import { BsHighlighter, BsCursor, BsArrowUpRight } from "react-icons/bs";
import { TbFlipHorizontal, TbFlipVertical, TbRotate, TbRotateClockwise } from "react-icons/tb";
import { MdBlurOn } from "react-icons/md";
import { ImageAdjustments, ImageEditTool, NEUTRAL_ADJUSTMENTS } from "../../utils/imageEditTypes";
import ColorSwatchPicker from "../pdf/ColorSwatchPicker";

const Divider: React.FC = () => <div className="w-px h-6 bg-black/[0.06] dark:bg-white/[0.1] shrink-0" />;

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

const ADJUSTMENT_FIELDS: { key: keyof ImageAdjustments; label: string }[] = [
  { key: "brightness", label: "Brightness" },
  { key: "contrast", label: "Contrast" },
  { key: "saturation", label: "Saturation" },
];

const TOOL_BUTTONS: { tool: ImageEditTool; label: string; shortcut: string; icon: React.ReactNode }[] = [
  { tool: "pen", label: "Pen", shortcut: "P", icon: <IoPencil size={16} /> },
  { tool: "highlighter", label: "Highlighter", shortcut: "H", icon: <BsHighlighter size={15} /> },
  { tool: "arrow", label: "Arrow", shortcut: "A", icon: <BsArrowUpRight size={15} /> },
  { tool: "rect", label: "Rectangle", shortcut: "R", icon: <IoSquareOutline size={16} /> },
  { tool: "ellipse", label: "Ellipse", shortcut: "O", icon: <IoEllipseOutline size={16} /> },
  { tool: "text", label: "Text", shortcut: "T", icon: <IoText size={17} /> },
  { tool: "blur", label: "Blur (privacy)", shortcut: "B", icon: <MdBlurOn size={17} /> },
];

interface ImageEditorToolbarProps {
  title?: string;
  // Hides Crop/Rotate/Flip, the pen/shapes/blur segmented tool control, and color/width/
  // adjustments - the collage docker (bottom panel) takes over image-management/arrange duties
  // instead. Insert image, Undo/Redo/Delete, zoom, and Save stay available in both modes.
  isCollageMode: boolean;
  tool: ImageEditTool;
  onToolChange: (tool: ImageEditTool) => void;
  color: string;
  onColorChange: (color: string) => void;
  showColor: boolean;
  strokeWidth: number;
  onStrokeWidthChange: (width: number) => void;
  showWidth: boolean;
  fontSize: number;
  onFontSizeChange: (size: number) => void;
  showFontSize: boolean;
  onRotateCCW: () => void;
  onRotateCW: () => void;
  onFlipH: () => void;
  onFlipV: () => void;
  onCropApply: () => void;
  onCropCancel: () => void;
  onInsertImageClick: () => void;
  adjustments: ImageAdjustments;
  onAdjustmentsChange: (adjustments: ImageAdjustments) => void;
  onAdjustmentsCommit: (adjustments: ImageAdjustments) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  hasSelection: boolean;
  onDeleteSelected: () => void;
  zoom: number;
  onZoomChange: (zoom: number) => void;
  minZoom: number;
  maxZoom: number;
  isSaving: boolean;
  saveError: string | null;
  onSaveCopy: () => void;
}

const ImageEditorToolbar: React.FC<ImageEditorToolbarProps> = ({
  title,
  isCollageMode,
  tool,
  onToolChange,
  color,
  onColorChange,
  showColor,
  strokeWidth,
  onStrokeWidthChange,
  showWidth,
  fontSize,
  onFontSizeChange,
  showFontSize,
  onRotateCCW,
  onRotateCW,
  onFlipH,
  onFlipV,
  onCropApply,
  onCropCancel,
  onInsertImageClick,
  adjustments,
  onAdjustmentsChange,
  onAdjustmentsCommit,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  hasSelection,
  onDeleteSelected,
  zoom,
  onZoomChange,
  minZoom,
  maxZoom,
  isSaving,
  saveError,
  onSaveCopy,
}) => {
  if (tool === "crop") {
    // A focused, minimal bar while cropping - the full tool palette (shapes/adjustments/etc.)
    // isn't relevant mid-crop, and showing it alongside an Apply/Cancel decision just invites
    // clicking something else without realizing the crop is still pending.
    return (
      <div className="shrink-0 px-4 pt-3 pb-2">
        <div className="flex items-center gap-3 mx-auto max-w-fit px-3 py-2 rounded-2xl bg-white/75 dark:bg-neutral-900/80 backdrop-blur-xl shadow-[0_4px_24px_rgba(0,0,0,0.08)] ring-1 ring-black/[0.04] dark:ring-white/[0.08]">
          <span className="text-sm font-medium text-neutral-700 dark:text-neutral-200 pl-1">Drag to crop</span>
          <Divider />
          <button
            type="button"
            onClick={onCropCancel}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm text-neutral-600 dark:text-neutral-300 hover:bg-black/[0.05] dark:hover:bg-white/[0.08]"
          >
            <IoCloseOutline size={16} /> Cancel
          </button>
          <button
            type="button"
            onClick={onCropApply}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-700"
          >
            <IoCheckmark size={16} /> Apply crop
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="shrink-0 px-4 pt-3 pb-2">
      {/* max-w-full (not max-w-fit) is deliberate: this toolbar has far more controls than
          AnnotationToolbar.tsx's (the pattern this was modeled on), so on a narrower window it
          needs to actually wrap onto more rows rather than keep growing rightward past the
          window edge, invisible and unclickable - max-w-fit has no width ceiling to wrap against,
          so combined with flex-wrap it silently never wrapped at all. */}
      <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-2 mx-auto max-w-full px-3 py-2 rounded-2xl bg-white/75 dark:bg-neutral-900/80 backdrop-blur-xl shadow-[0_4px_24px_rgba(0,0,0,0.08)] ring-1 ring-black/[0.04] dark:ring-white/[0.08]">
        {title && (
          <>
            <span className="text-sm font-medium text-neutral-600 dark:text-neutral-300 truncate max-w-[160px] pl-1" title={title}>
              {title}
            </span>
            <Divider />
          </>
        )}

        {/* Tool segmented control - "Select" is always present (same reasoning as
            AnnotationToolbar's own Select button: an explicit, always-highlightable way back to
            "nothing active", not just a side effect of re-clicking an active tool). Hidden
            entirely in collage mode - the tool is forced to "select" there (see ImageEditor's own
            effect), so there'd be nothing else for this control to switch to anyway. */}
        {!isCollageMode && (
          <>
            <div className="flex items-center gap-0.5 p-0.5 rounded-full bg-black/[0.045] dark:bg-white/[0.06]">
              <IconButton title="Select / move (V)" active={tool === "select"} onClick={() => onToolChange("select")}>
                <BsCursor size={14} />
              </IconButton>
              {TOOL_BUTTONS.map(({ tool: t, label, shortcut, icon }) => (
                <IconButton key={t} title={`${label} (${shortcut})`} active={tool === t} onClick={() => onToolChange(t)}>
                  {icon}
                </IconButton>
              ))}
            </div>

            <Divider />

            {/* Geometry ops - each one flattens everything drawn so far into the new base bitmap
                (see imageEditTypes.ts's GeometrySnapshot doc comment), so these live outside the
                annotation-tool segmented control rather than alongside pen/arrow/etc. */}
            <div className="flex items-center gap-0.5">
              <IconButton title="Crop" onClick={() => onToolChange("crop")}>
                <IoCropOutline size={16} />
              </IconButton>
              <IconButton title="Rotate left 90°" onClick={onRotateCCW}>
                <TbRotate size={17} />
              </IconButton>
              <IconButton title="Rotate right 90°" onClick={onRotateCW}>
                <TbRotateClockwise size={17} />
              </IconButton>
              <IconButton title="Flip horizontal" onClick={onFlipH}>
                <TbFlipHorizontal size={17} />
              </IconButton>
              <IconButton title="Flip vertical" onClick={onFlipV}>
                <TbFlipVertical size={17} />
              </IconButton>
            </div>

            <Divider />
          </>
        )}

        {/* Inserting an image isn't a persistent tool the way pen/arrow/etc. are - it's a
            one-shot action (pick a file, it appears selected and ready to drag/resize/rotate) -
            same reasoning and placement as AnnotationToolbar.tsx's own "Insert image" button. The
            join/collage building block: insert another photo, then move/resize/rotate it into
            place (ImageAnnotationEditor, via ImageEditorCanvas). Available in both modes -
            arranging a collage still starts with adding images to it. */}
        <IconButton title="Insert image" onClick={onInsertImageClick}>
          <IoImageOutline size={16} />
        </IconButton>

        {/* Shown either while a color/width-bearing tool is armed (to set what gets drawn next)
            or while an existing color/width-bearing object is selected (to edit it directly) -
            showColor/showWidth are computed by the parent, which is the one that knows about
            both the active tool and the current selection. Suppressed in collage mode regardless
            (that mode has no drawing tools to arm, and editing an old shape's color isn't part of
            the focused collage workflow - switch back to normal mode for that). */}
        {showColor && !isCollageMode && (
          <>
            <Divider />
            <ColorSwatchPicker color={color} onChange={onColorChange} />
          </>
        )}
        {showWidth && !isCollageMode && (
          <input
            type="range"
            min={1}
            max={24}
            step={1}
            value={strokeWidth}
            onChange={(e) => onStrokeWidthChange(Number(e.target.value))}
            title="Stroke width"
            className="w-16 accent-blue-500"
          />
        )}

        {showFontSize && !isCollageMode && (
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-neutral-500 dark:text-neutral-400">Size</span>
            <input
              type="range"
              min={12}
              max={96}
              step={1}
              value={fontSize}
              onChange={(e) => onFontSizeChange(Number(e.target.value))}
              title="Font size"
              className="w-16 accent-blue-500"
            />
          </div>
        )}

        {!isCollageMode && (
          <>
            <Divider />

            {/* Live-adjusted while dragging (onAdjustmentsChange), one undo entry committed on
                release (onAdjustmentsCommit) - see useImageEditStore's commitAdjustments. */}
            <div className="flex items-center gap-2.5">
              {ADJUSTMENT_FIELDS.map(({ key, label }) => (
                <input
                  key={key}
                  type="range"
                  min={0.5}
                  max={1.5}
                  step={0.01}
                  value={adjustments[key]}
                  title={`${label} (${Math.round(adjustments[key] * 100)}%)`}
                  onChange={(e) => onAdjustmentsChange({ ...adjustments, [key]: Number(e.target.value) })}
                  onPointerUp={(e) => onAdjustmentsCommit({ ...adjustments, [key]: Number(e.currentTarget.value) })}
                  className="w-14 accent-blue-500"
                />
              ))}
              <button
                type="button"
                title="Reset adjustments"
                onClick={() => onAdjustmentsCommit({ ...NEUTRAL_ADJUSTMENTS })}
                className="text-xs text-neutral-400 dark:text-neutral-500 hover:text-neutral-600 dark:hover:text-neutral-300"
              >
                Reset
              </button>
            </div>
          </>
        )}

        <Divider />

        <div className="flex items-center gap-0.5">
          <IconButton title="Undo (Ctrl+Z)" disabled={!canUndo} onClick={onUndo}>
            <IoArrowUndo size={16} />
          </IconButton>
          <IconButton title="Redo (Ctrl+Shift+Z)" disabled={!canRedo} onClick={onRedo}>
            <IoArrowRedo size={16} />
          </IconButton>
          <IconButton title="Delete selected (Del)" disabled={!hasSelection} onClick={onDeleteSelected}>
            <IoTrashOutline size={16} />
          </IconButton>
        </div>

        <Divider />

        <div className="flex items-center gap-1 rounded-full bg-black/[0.045] dark:bg-white/[0.06] pl-1 pr-2 py-0.5">
          <IconButton title="Zoom out (Ctrl+-)" disabled={zoom <= minZoom} onClick={() => onZoomChange(Math.max(minZoom, Math.round((zoom - 0.25) * 100) / 100))}>
            <IoRemove size={16} />
          </IconButton>
          <span className="text-xs font-medium text-neutral-600 dark:text-neutral-300 tabular-nums w-10 text-center">{Math.round(zoom * 100)}%</span>
          <IconButton title="Zoom in (Ctrl+=)" disabled={zoom >= maxZoom} onClick={() => onZoomChange(Math.min(maxZoom, Math.round((zoom + 0.25) * 100) / 100))}>
            <IoAdd size={16} />
          </IconButton>
        </div>

        <Divider />

        <IconButton title="Save a copy" onClick={onSaveCopy}>
          <IoDownloadOutline size={16} />
        </IconButton>

        <div className="pr-1">
          <SaveStatus isSaving={isSaving} saveError={saveError} />
        </div>
      </div>
    </div>
  );
};

export default ImageEditorToolbar;
