// components/docs/DocColorPicker.tsx
//
// A Word/Docs-style color picker - a swatch grid (grayscale row + hue/lightness matrix from
// docColor.ts's buildPaletteGrid) with a "Custom" row of recently-used custom colors and a "+"
// that opens a full HSV picker (draggable saturation/value square, hue slider, hex/RGB inputs).
// Replaces the plain `<input type="color">` DocsEditor.tsx used to use for text/highlight color,
// which only ever opened the OS's own native color dialog rather than anything in-app.
//
// Shared by both the text-color and highlight-color toolbar buttons - `storageKey` keeps their
// "recently used" lists separate (see docColor.ts).
import React, { useCallback, useEffect, useRef, useState } from "react";
import { IoArrowBack, IoCheckmark } from "react-icons/io5";
import {
  GRAYSCALE_SWATCHES,
  buildPaletteGrid,
  clamp,
  getRecentColors,
  addRecentColor,
  hexToRgb,
  hsvToRgb,
  rgbToHex,
  rgbToHsv,
} from "../../utils/docColor";

interface DocColorPickerProps {
  value: string | null;
  onChange: (color: string) => void;
  onClear: () => void;
  onClose: () => void;
  storageKey: string;
  clearLabel: string;
}

const PALETTE_GRID = buildPaletteGrid();

const Swatch: React.FC<{ color: string; selected: boolean; onClick: () => void; title?: string }> = ({ color, selected, onClick, title }) => (
  <button
    type="button"
    title={title ?? color}
    onClick={onClick}
    className={`w-5 h-5 rounded-sm border transition-transform hover:scale-110 ${
      selected ? "border-blue-500 ring-1 ring-blue-500" : "border-black/10 dark:border-white/10"
    }`}
    style={{ backgroundColor: color }}
  />
);

const DocColorPicker: React.FC<DocColorPickerProps> = ({ value, onChange, onClear, onClose, storageKey, clearLabel }) => {
  const [mode, setMode] = useState<"palette" | "custom">("palette");
  const [recentColors, setRecentColors] = useState<string[]>(() => getRecentColors(storageKey));

  // Working HSV state for the custom picker - initialized from `value` when it's parseable as a
  // plain hex color (a palette pick is an hsl(...) string, not something a user resumes editing).
  const [hue, setHue] = useState(0);
  const [sat, setSat] = useState(100);
  const [val, setVal] = useState(100);
  const [hexInput, setHexInput] = useState("#ff0000");

  const svRef = useRef<HTMLDivElement>(null);
  const hueRef = useRef<HTMLDivElement>(null);

  const openCustom = useCallback(() => {
    // hexToRgb returns null (falling back to red) for a palette pick, which is an hsl(...) string,
    // not hex - the square/slider start fresh rather than resuming exactly on that swatch. Only
    // matters if someone picks a palette color, reopens the picker, and clicks "+" specifically to
    // fine-tune it; picking up a *custom* color (always stored as hex, via addRecentColor) works
    // as expected.
    const rgb = value ? hexToRgb(value) : null;
    const [h, s, v] = rgb ? rgbToHsv(...rgb) : [0, 100, 100];
    setHue(h);
    setSat(s);
    setVal(v);
    setHexInput(rgb ? rgbToHex(...rgb) : "#ff0000");
    setMode("custom");
  }, [value]);

  // Keeps the hex text field (and derived RGB) in sync while dragging the square/slider - not the
  // other way around, see the hex input's own onChange for why that direction is handled
  // separately.
  useEffect(() => {
    const [r, g, b] = hsvToRgb(hue, sat, val);
    setHexInput(rgbToHex(r, g, b));
  }, [hue, sat, val]);

  const updateFromSvPoint = (clientX: number, clientY: number) => {
    const rect = svRef.current?.getBoundingClientRect();
    if (!rect) return;
    setSat(clamp(((clientX - rect.left) / rect.width) * 100, 0, 100));
    setVal(clamp(100 - ((clientY - rect.top) / rect.height) * 100, 0, 100));
  };

  const updateFromHuePoint = (clientX: number) => {
    const rect = hueRef.current?.getBoundingClientRect();
    if (!rect) return;
    setHue(clamp(((clientX - rect.left) / rect.width) * 360, 0, 360));
  };

  // Hex input drives hue/sat/val (not the other way, for this direction) - only when it parses to
  // a full 6-digit color, so a still-mid-typing value (e.g. "#ff") doesn't fight the user's cursor
  // by snapping the square/slider around on every keystroke.
  const handleHexChange = (raw: string) => {
    setHexInput(raw);
    const rgb = hexToRgb(raw);
    if (!rgb) return;
    const [h, s, v] = rgbToHsv(...rgb);
    setHue(h);
    setSat(s);
    setVal(v);
  };

  const rgb = hsvToRgb(hue, sat, val);
  const currentHex = rgbToHex(...rgb);

  const applyCustom = () => {
    onChange(currentHex);
    setRecentColors(addRecentColor(storageKey, currentHex));
    onClose();
  };

  if (mode === "custom") {
    return (
      <div onClick={(e) => e.stopPropagation()} className="w-56 bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded-md shadow-lg p-2.5">
        <div className="flex items-center gap-1 mb-2">
          <button type="button" title="Back" onClick={() => setMode("palette")} className="p-1 -ml-1 rounded text-neutral-500 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-700">
            <IoArrowBack size={14} />
          </button>
          <span className="text-xs font-medium text-neutral-600 dark:text-neutral-300">Custom color</span>
        </div>

        {/* Saturation/value square: background is the pure hue at full saturation/value, with a
            white->transparent gradient (left->right = saturation) and a black->transparent
            gradient (top->bottom = value) layered over it - the standard CSS approach for an HSV
            picker without a canvas element. */}
        <div
          ref={svRef}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            updateFromSvPoint(e.clientX, e.clientY);
          }}
          onPointerMove={(e) => {
            if (e.buttons !== 1) return;
            updateFromSvPoint(e.clientX, e.clientY);
          }}
          className="relative w-full h-32 rounded cursor-crosshair touch-none"
          style={{
            backgroundColor: `hsl(${hue}, 100%, 50%)`,
            backgroundImage: "linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, transparent)",
          }}
        >
          <div
            className="absolute w-3 h-3 rounded-full border-2 border-white shadow -translate-x-1/2 translate-y-1/2 pointer-events-none"
            style={{ left: `${sat}%`, bottom: `${val}%`, backgroundColor: currentHex }}
          />
        </div>

        {/* Hue slider: a full-spectrum gradient bar, same drag mechanics as the square above but
            one-dimensional. */}
        <div
          ref={hueRef}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            updateFromHuePoint(e.clientX);
          }}
          onPointerMove={(e) => {
            if (e.buttons !== 1) return;
            updateFromHuePoint(e.clientX);
          }}
          className="relative w-full h-3 rounded mt-2 cursor-pointer touch-none"
          style={{ background: "linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)" }}
        >
          <div
            className="absolute top-1/2 w-3 h-3 rounded-full border-2 border-white shadow -translate-x-1/2 -translate-y-1/2 pointer-events-none"
            style={{ left: `${(hue / 360) * 100}%`, backgroundColor: `hsl(${hue}, 100%, 50%)` }}
          />
        </div>

        <div className="flex items-center gap-2 mt-2.5">
          <div className="w-7 h-7 rounded border border-neutral-300 dark:border-neutral-600 shrink-0" style={{ backgroundColor: currentHex }} />
          <input
            value={hexInput}
            onChange={(e) => handleHexChange(e.target.value)}
            className="w-full px-2 py-1 text-xs rounded border border-neutral-200 dark:border-neutral-700 bg-transparent outline-none text-neutral-800 dark:text-neutral-100 uppercase"
          />
        </div>

        <div className="flex justify-end gap-1.5 mt-2.5">
          <button type="button" onClick={() => setMode("palette")} className="px-2.5 py-1 text-xs rounded text-neutral-500 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-700">
            Cancel
          </button>
          <button type="button" onClick={applyCustom} className="px-2.5 py-1 text-xs rounded bg-blue-600 text-white hover:bg-blue-700">
            OK
          </button>
        </div>
      </div>
    );
  }

  // A palette/recent-swatch click both applies and closes, matching Word/Docs' own quick-pick
  // behavior - only the custom picker's own OK button applies-and-closes on a separate click,
  // since that flow needs the popover to stay open while dragging/typing.
  const pick = (color: string) => {
    onChange(color);
    onClose();
  };

  return (
    <div onClick={(e) => e.stopPropagation()} className="w-56 bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded-md shadow-lg p-2.5">
      <div className="grid grid-cols-10 gap-1 mb-1.5">
        {GRAYSCALE_SWATCHES.map((color) => (
          <Swatch key={color} color={color} selected={value === color} onClick={() => pick(color)} />
        ))}
      </div>
      <div className="flex flex-col gap-1 mb-2">
        {PALETTE_GRID.map((row, i) => (
          <div key={i} className="grid grid-cols-9 gap-1">
            {row.map((color, j) => (
              <Swatch key={j} color={color} selected={value === color} onClick={() => pick(color)} />
            ))}
          </div>
        ))}
      </div>

      <div className="border-t border-neutral-100 dark:border-neutral-700 pt-2">
        <p className="text-[10px] uppercase tracking-wide text-neutral-400 dark:text-neutral-500 mb-1">Custom</p>
        <div className="flex flex-wrap items-center gap-1">
          {recentColors.map((color) => (
            <Swatch key={color} color={color} selected={value === color} onClick={() => pick(color)} title={color} />
          ))}
          <button
            type="button"
            title="Custom color"
            onClick={openCustom}
            className="w-5 h-5 rounded-sm border border-dashed border-neutral-300 dark:border-neutral-600 flex items-center justify-center text-neutral-400 dark:text-neutral-500 hover:border-neutral-400 dark:hover:border-neutral-500"
          >
            +
          </button>
        </div>
      </div>

      <button
        type="button"
        onClick={onClear}
        className="w-full flex items-center justify-center gap-1 mt-2 pt-2 border-t border-neutral-100 dark:border-neutral-700 text-xs text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 hover:underline"
      >
        {value === null && <IoCheckmark size={12} />}
        {clearLabel}
      </button>
    </div>
  );
};

export default DocColorPicker;
