// components/image/ImageEditorToolbar.tsx
//
// The image editor's tools panel - a collapsible right-side panel (mounted only while
// ImageEditor's isToolsPanelOpen is true; see ImageEditor.tsx and the sidebar's tools button in
// Dashboard.tsx that toggles it) holding every control that actually edits the image: the
// pen/shapes/blur tool set, crop/rotate/flip, insert image, color/width/font for whatever's armed
// or selected, brightness/contrast/saturation, and undo/redo/delete. Zoom and "Save a copy" live
// in ImageEditor's own persistent header instead - viewing and saving shouldn't depend on this
// panel being open.
import React, { useEffect, useRef, useState } from "react";
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
  IoCopyOutline,
  IoCheckmark,
  IoCloseOutline,
  IoImageOutline,
  IoClose,
} from "react-icons/io5";
import { AiOutlineSmallDash } from "react-icons/ai";
import { BsHighlighter, BsCursor, BsArrowUpRight } from "react-icons/bs";
import { TbArrowLeftRight, TbFlipHorizontal, TbFlipVertical, TbRotate, TbRotateClockwise } from "react-icons/tb";
import { MdBlurOn, MdFormatBold, MdFormatColorFill, MdLooksOne } from "react-icons/md";
import { ImageAdjustments, ImageEditTool, NEUTRAL_ADJUSTMENTS } from "../../utils/imageEditTypes";
import ColorSwatchPicker from "../pdf/ColorSwatchPicker";

export const IconButton: React.FC<{
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

export const SaveStatus: React.FC<{ isSaving: boolean; saveError: string | null }> = ({ isSaving, saveError }) => {
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

// The percentage readout doubles as a text field - click/tap it to type an exact value instead of
// nudging with +/-. Edits are staged in local text state (not committed straight to `zoom`) so
// mid-edit strings ("", "1", "15") aren't immediately clamped/reformatted out from under the
// user's cursor; the real zoom only updates on blur/Enter. isEditingRef (not React state) tracks
// whether an edit is in progress, so the sync-from-prop effect below can tell "zoom changed
// elsewhere, update the field" apart from "zoom changed because *this* field's own edit just
// committed" without the state update itself retriggering the effect.
const ZoomPercentInput: React.FC<{
  zoom: number;
  onZoomChange: (zoom: number) => void;
  minZoom: number;
  maxZoom: number;
}> = ({ zoom, onZoomChange, minZoom, maxZoom }) => {
  const [text, setText] = useState<string>(String(Math.round(zoom * 100)));
  const isEditingRef = useRef(false);

  useEffect(() => {
    if (!isEditingRef.current) setText(String(Math.round(zoom * 100)));
  }, [zoom]);

  const commit = (): void => {
    isEditingRef.current = false;
    const parsed = parseInt(text, 10);
    const clampedPercent = Number.isNaN(parsed) ? Math.round(zoom * 100) : Math.max(Math.round(minZoom * 100), Math.min(Math.round(maxZoom * 100), parsed));
    setText(String(clampedPercent));
    if (clampedPercent !== Math.round(zoom * 100)) onZoomChange(clampedPercent / 100);
  };

  return (
    <span className="flex items-center gap-px w-11 justify-center">
      <input
        type="text"
        inputMode="numeric"
        title="Zoom - type a value"
        value={text}
        onFocus={(e) => {
          isEditingRef.current = true;
          e.currentTarget.select();
        }}
        onChange={(e) => setText(e.target.value.replace(/[^0-9]/g, ""))}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.currentTarget.blur();
          } else if (e.key === "Escape") {
            isEditingRef.current = false;
            setText(String(Math.round(zoom * 100)));
            e.currentTarget.blur();
          }
        }}
        className="w-7 bg-transparent text-xs font-medium text-neutral-600 dark:text-neutral-300 tabular-nums text-right focus:outline-none"
      />
      <span className="text-xs font-medium text-neutral-600 dark:text-neutral-300">%</span>
    </span>
  );
};

export const ZoomControl: React.FC<{
  zoom: number;
  onZoomChange: (zoom: number) => void;
  minZoom: number;
  maxZoom: number;
}> = ({ zoom, onZoomChange, minZoom, maxZoom }) => (
  <div className="flex items-center gap-1 rounded-full bg-black/[0.045] dark:bg-white/[0.06] pl-1 pr-2 py-0.5">
    <IconButton title="Zoom out (Ctrl+-)" disabled={zoom <= minZoom} onClick={() => onZoomChange(Math.max(minZoom, Math.round((zoom - 0.25) * 100) / 100))}>
      <IoRemove size={16} />
    </IconButton>
    <ZoomPercentInput zoom={zoom} onZoomChange={onZoomChange} minZoom={minZoom} maxZoom={maxZoom} />
    <IconButton title="Zoom in (Ctrl+=)" disabled={zoom >= maxZoom} onClick={() => onZoomChange(Math.min(maxZoom, Math.round((zoom + 0.25) * 100) / 100))}>
      <IoAdd size={16} />
    </IconButton>
  </div>
);

// A labeled group within the panel - just a consistent heading + spacing wrapper, not a visual
// box, so sections read as one continuous scroll rather than a stack of separate cards.
const Section: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="flex flex-col gap-1.5">
    <div className="px-0.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-400 dark:text-neutral-500">{label}</div>
    {children}
  </div>
);

const ADJUSTMENT_FIELDS: { key: keyof ImageAdjustments; label: string }[] = [
  { key: "brightness", label: "Brightness" },
  { key: "contrast", label: "Contrast" },
  { key: "saturation", label: "Saturation" },
];

const TOOL_BUTTONS: { tool: ImageEditTool; label: string; shortcut: string; icon: React.ReactNode }[] = [
  { tool: "select", label: "Select / move", shortcut: "V", icon: <BsCursor size={15} /> },
  { tool: "pen", label: "Pen", shortcut: "P", icon: <IoPencil size={16} /> },
  { tool: "highlighter", label: "Highlighter", shortcut: "H", icon: <BsHighlighter size={15} /> },
  { tool: "arrow", label: "Arrow", shortcut: "A", icon: <BsArrowUpRight size={15} /> },
  { tool: "rect", label: "Rectangle", shortcut: "R", icon: <IoSquareOutline size={16} /> },
  { tool: "ellipse", label: "Ellipse", shortcut: "O", icon: <IoEllipseOutline size={16} /> },
  { tool: "text", label: "Text", shortcut: "T", icon: <IoText size={17} /> },
  { tool: "blur", label: "Blur (privacy)", shortcut: "B", icon: <MdBlurOn size={17} /> },
  { tool: "step", label: "Numbered step", shortcut: "N", icon: <MdLooksOne size={17} /> },
];

// A full-width row (icon + label + shortcut) rather than an icon-only square - the panel has the
// horizontal room a floating pill toolbar didn't, and spelling out what each tool does makes the
// set discoverable without hovering every icon first.
const ToolRow: React.FC<{ active: boolean; onClick: () => void; icon: React.ReactNode; label: string; shortcut: string }> = ({
  active,
  onClick,
  icon,
  label,
  shortcut,
}) => (
  <button
    type="button"
    onClick={onClick}
    className={`flex items-center gap-2.5 w-full px-2 py-1.5 rounded-lg text-sm text-left transition-colors duration-150 ${
      active
        ? "bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400"
        : "text-neutral-600 dark:text-neutral-300 hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
    }`}
  >
    <span className="shrink-0 w-4 flex items-center justify-center">{icon}</span>
    <span className="flex-1 min-w-0 truncate">{label}</span>
    <span className="shrink-0 text-[10px] font-medium text-neutral-400 dark:text-neutral-500">{shortcut}</span>
  </button>
);

interface ImageEditorToolbarProps {
  tool: ImageEditTool;
  onToolChange: (tool: ImageEditTool) => void;
  color: string;
  onColorChange: (color: string) => void;
  showColor: boolean;
  strokeWidth: number;
  onStrokeWidthChange: (width: number) => void;
  showWidth: boolean;
  // The Width slider's own range - the caller (ImageEditor.tsx) swaps in a much wider one for the
  // highlighter than for pen/arrow/rect/ellipse, since a highlighter is a broad marker swipe, not
  // a fine annotation line. See its own HIGHLIGHT_MIN_WIDTH/HIGHLIGHT_MAX_WIDTH.
  widthMin: number;
  widthMax: number;
  fontSize: number;
  onFontSizeChange: (size: number) => void;
  showFontSize: boolean;
  textBold: boolean;
  onTextBoldChange: (bold: boolean) => void;
  textBackground: boolean;
  onTextBackgroundChange: (background: boolean) => void;
  textBackgroundColor: string;
  onTextBackgroundColorChange: (color: string) => void;
  shapeFilled: boolean;
  onShapeFilledChange: (filled: boolean) => void;
  showFill: boolean;
  arrowDashed: boolean;
  onArrowDashedChange: (dashed: boolean) => void;
  arrowDoubleHeaded: boolean;
  onArrowDoubleHeadedChange: (doubleHeaded: boolean) => void;
  showArrowStyle: boolean;
  blurMode: "blur" | "redact";
  onBlurModeChange: (mode: "blur" | "redact") => void;
  showBlurMode: boolean;
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
  onDuplicateSelected: () => void;
  onClose: () => void;
}

const PANEL_CLASSES =
  "shrink-0 w-64 h-full flex flex-col bg-white/75 dark:bg-neutral-900/80 backdrop-blur-xl border-l border-black/[0.06] dark:border-white/[0.1] overflow-y-auto";

const ImageEditorToolbar: React.FC<ImageEditorToolbarProps> = ({
  tool,
  onToolChange,
  color,
  onColorChange,
  showColor,
  strokeWidth,
  onStrokeWidthChange,
  showWidth,
  widthMin,
  widthMax,
  fontSize,
  onFontSizeChange,
  showFontSize,
  textBold,
  onTextBoldChange,
  textBackground,
  onTextBackgroundChange,
  textBackgroundColor,
  onTextBackgroundColorChange,
  shapeFilled,
  onShapeFilledChange,
  showFill,
  arrowDashed,
  onArrowDashedChange,
  arrowDoubleHeaded,
  onArrowDoubleHeadedChange,
  showArrowStyle,
  blurMode,
  onBlurModeChange,
  showBlurMode,
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
  onDuplicateSelected,
  onClose,
}) => {
  if (tool === "crop") {
    // A focused, minimal panel while cropping - the full tool palette (shapes/adjustments/etc.)
    // isn't relevant mid-crop, and showing it alongside an Apply/Cancel decision just invites
    // clicking something else without realizing the crop is still pending.
    return (
      <div className={PANEL_CLASSES}>
        <div className="flex items-center justify-between px-3 py-2.5 border-b border-black/[0.06] dark:border-white/[0.1]">
          <span className="text-sm font-medium text-neutral-700 dark:text-neutral-200">Drag to crop</span>
          <IconButton title="Close panel" onClick={onClose}>
            <IoClose size={16} />
          </IconButton>
        </div>
        <div className="flex flex-col gap-2 p-3">
          <button
            type="button"
            onClick={onCropApply}
            className="flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-700"
          >
            <IoCheckmark size={16} /> Apply crop
          </button>
          <button
            type="button"
            onClick={onCropCancel}
            className="flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-sm text-neutral-600 dark:text-neutral-300 hover:bg-black/[0.05] dark:hover:bg-white/[0.08]"
          >
            <IoCloseOutline size={16} /> Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={PANEL_CLASSES}>
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-black/[0.06] dark:border-white/[0.1]">
        <span className="text-sm font-medium text-neutral-700 dark:text-neutral-200">Tools</span>
        <IconButton title="Close panel" onClick={onClose}>
          <IoClose size={16} />
        </IconButton>
      </div>

      <div className="flex flex-col gap-4 p-3">
        <Section label="Tools">
          <div className="flex flex-col gap-0.5">
            {TOOL_BUTTONS.map(({ tool: t, label, shortcut, icon }) => (
              <ToolRow key={t} active={tool === t} onClick={() => onToolChange(t)} icon={icon} label={label} shortcut={shortcut} />
            ))}
          </div>
        </Section>

        {/* Geometry ops - each one flattens everything drawn so far into the new base bitmap (see
            imageEditTypes.ts's GeometrySnapshot doc comment), so these live outside the
            annotation-tool list above rather than alongside pen/arrow/etc. */}
        <Section label="Transform">
          <div className="flex items-center gap-1">
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
        </Section>

        {/* Inserting an image isn't a persistent tool the way pen/arrow/etc. are - it's a one-shot
            action (pick a file, it appears selected and ready to drag/resize/rotate), same
            reasoning and placement as AnnotationToolbar.tsx's own "Insert image" button. */}
        <Section label="Insert">
          <ToolRow active={false} onClick={onInsertImageClick} icon={<IoImageOutline size={16} />} label="Insert image" shortcut="" />
        </Section>

        {/* Shown either while a color/width-bearing tool is armed (to set what gets drawn next)
            or while an existing color/width-bearing object is selected (to edit it directly) -
            showColor/showWidth are computed by the parent, which is the one that knows about both
            the active tool and the current selection. */}
        {(showColor || showWidth || showFontSize || showFill || showArrowStyle || showBlurMode) && (
          <Section label="Style">
            <div className="flex flex-col gap-2.5">
              {showColor && <ColorSwatchPicker color={color} onChange={onColorChange} />}
              {showFill && (
                <button
                  type="button"
                  title="Filled - solid fill instead of just an outline"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => onShapeFilledChange(!shapeFilled)}
                  className={`self-start flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs transition-colors duration-150 ${
                    shapeFilled
                      ? "bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400"
                      : "text-neutral-600 dark:text-neutral-300 hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
                  }`}
                >
                  <MdFormatColorFill size={15} /> Filled
                </button>
              )}
              {showArrowStyle && (
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    title="Dashed line"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => onArrowDashedChange(!arrowDashed)}
                    className={`flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs transition-colors duration-150 ${
                      arrowDashed
                        ? "bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400"
                        : "text-neutral-600 dark:text-neutral-300 hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
                    }`}
                  >
                    <AiOutlineSmallDash size={15} /> Dashed
                  </button>
                  <button
                    type="button"
                    title="Double-headed - an arrowhead at both ends"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => onArrowDoubleHeadedChange(!arrowDoubleHeaded)}
                    className={`flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs transition-colors duration-150 ${
                      arrowDoubleHeaded
                        ? "bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400"
                        : "text-neutral-600 dark:text-neutral-300 hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
                    }`}
                  >
                    <TbArrowLeftRight size={15} /> Both ends
                  </button>
                </div>
              )}
              {showBlurMode && (
                <div className="flex items-center gap-1 p-0.5 self-start rounded-lg bg-black/[0.04] dark:bg-white/[0.06]">
                  <button
                    type="button"
                    title="Blur - de-emphasizes the region, not guaranteed irreversible"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => onBlurModeChange("blur")}
                    className={`px-2.5 py-1 rounded-md text-xs transition-colors duration-150 ${
                      blurMode === "blur"
                        ? "bg-white dark:bg-neutral-700 text-blue-600 dark:text-blue-400 shadow-sm"
                        : "text-neutral-500 dark:text-neutral-400"
                    }`}
                  >
                    Blur
                  </button>
                  <button
                    type="button"
                    title="Redact - covers the region with an opaque box, guaranteed irreversible"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => onBlurModeChange("redact")}
                    className={`px-2.5 py-1 rounded-md text-xs transition-colors duration-150 ${
                      blurMode === "redact"
                        ? "bg-white dark:bg-neutral-700 text-blue-600 dark:text-blue-400 shadow-sm"
                        : "text-neutral-500 dark:text-neutral-400"
                    }`}
                  >
                    Redact
                  </button>
                </div>
              )}
              {showWidth && (
                <label className="flex items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
                  <span className="w-12 shrink-0">Width</span>
                  <input
                    type="range"
                    min={widthMin}
                    max={widthMax}
                    step={1}
                    value={strokeWidth}
                    onChange={(e) => onStrokeWidthChange(Number(e.target.value))}
                    title="Stroke width"
                    className="flex-1 accent-blue-500"
                  />
                  <span className="w-7 shrink-0 text-right tabular-nums">{strokeWidth}</span>
                </label>
              )}
              {showFontSize && (
                <label className="flex items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
                  <span className="w-12 shrink-0">Size</span>
                  <input
                    type="range"
                    min={12}
                    max={240}
                    step={2}
                    value={fontSize}
                    onChange={(e) => onFontSizeChange(Number(e.target.value))}
                    title="Font size"
                    className="flex-1 accent-blue-500"
                  />
                  <span className="w-8 shrink-0 text-right tabular-nums">{fontSize}</span>
                </label>
              )}
              {showFontSize && (
                <button
                  type="button"
                  title="Bold"
                  // A plain click's default action would shift focus onto this button - fine most
                  // of the time, but while the Text tool's inline editing input is open (a live
                  // text label being typed), that focus-shift blurs it, which commits/discards
                  // whatever's been typed so far and, if nothing had been typed yet, leaves the
                  // *next* keystrokes with nothing focused to receive them - they fall through to
                  // this editor's own global tool shortcuts instead (same class of bug
                  // ColorSwatchPicker.tsx already guards its own swatches against).
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => onTextBoldChange(!textBold)}
                  className={`self-start flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs transition-colors duration-150 ${
                    textBold
                      ? "bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400"
                      : "text-neutral-600 dark:text-neutral-300 hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
                  }`}
                >
                  <MdFormatBold size={15} /> Bold
                </button>
              )}
              {/* The color swatch is always shown (not just once Background is toggled on) - it
                  was hidden behind that toggle before, and "click Background to reveal the color
                  picker" turned out not to be discoverable at all. Picking a color here works
                  regardless of the toggle state; it just has no visible effect until Background
                  is actually on. */}
              {showFontSize && (
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    title="Background - adds a translucent backdrop behind the text for legibility over busy photos"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => onTextBackgroundChange(!textBackground)}
                    className={`flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs transition-colors duration-150 ${
                      textBackground
                        ? "bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400"
                        : "text-neutral-600 dark:text-neutral-300 hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
                    }`}
                  >
                    <MdFormatColorFill size={15} /> Background
                  </button>
                  <span className="text-xs text-neutral-400 dark:text-neutral-500">Color</span>
                  <ColorSwatchPicker color={textBackgroundColor} onChange={onTextBackgroundColorChange} size="sm" />
                </div>
              )}
            </div>
          </Section>
        )}

        {/* Live-adjusted while dragging (onAdjustmentsChange), one undo entry committed on release
            (onAdjustmentsCommit) - see useImageEditStore's commitAdjustments. */}
        <Section label="Adjustments">
          <div className="flex flex-col gap-2">
            {ADJUSTMENT_FIELDS.map(({ key, label }) => (
              <label key={key} className="flex items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
                <span className="w-16 shrink-0">{label}</span>
                <input
                  type="range"
                  min={0.5}
                  max={1.5}
                  step={0.01}
                  value={adjustments[key]}
                  title={`${label} (${Math.round(adjustments[key] * 100)}%)`}
                  onChange={(e) => onAdjustmentsChange({ ...adjustments, [key]: Number(e.target.value) })}
                  onPointerUp={(e) => onAdjustmentsCommit({ ...adjustments, [key]: Number(e.currentTarget.value) })}
                  className="flex-1 accent-blue-500"
                />
                <span className="w-8 shrink-0 text-right tabular-nums">{Math.round(adjustments[key] * 100)}%</span>
              </label>
            ))}
            <button
              type="button"
              title="Reset adjustments"
              onClick={() => onAdjustmentsCommit({ ...NEUTRAL_ADJUSTMENTS })}
              className="self-start text-xs text-neutral-400 dark:text-neutral-500 hover:text-neutral-600 dark:hover:text-neutral-300"
            >
              Reset
            </button>
          </div>
        </Section>

        <Section label="Edit">
          <div className="flex items-center gap-1">
            <IconButton title="Undo (Ctrl+Z)" disabled={!canUndo} onClick={onUndo}>
              <IoArrowUndo size={16} />
            </IconButton>
            <IconButton title="Redo (Ctrl+Shift+Z)" disabled={!canRedo} onClick={onRedo}>
              <IoArrowRedo size={16} />
            </IconButton>
            <IconButton title="Duplicate (Ctrl+D)" disabled={!hasSelection} onClick={onDuplicateSelected}>
              <IoCopyOutline size={16} />
            </IconButton>
            <IconButton title="Delete selected (Del)" disabled={!hasSelection} onClick={onDeleteSelected}>
              <IoTrashOutline size={16} />
            </IconButton>
          </div>
        </Section>
      </div>
    </div>
  );
};

export default ImageEditorToolbar;
