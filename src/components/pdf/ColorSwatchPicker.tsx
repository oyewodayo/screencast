// components/pdf/ColorSwatchPicker.tsx
import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

interface ColorSwatchPickerProps {
  color: string;
  onChange: (color: string) => void;
}

const PALETTE = ["#1a1a1a", "#e03131", "#f08c00", "#ffd43b", "#2f9e44", "#1971c2", "#9c36b5"];

// Positioned via a portal + `position: fixed` computed from the trigger button's own
// bounding rect, rather than `absolute` inside the toolbar. The toolbar is a translucent,
// backdrop-blurred flex row with several nested positioning contexts (segmented control,
// pill groups) — anchoring a popover to one of them risks it fighting for stacking order
// against the PDF canvas underneath. Rendering at the document root with a very high
// z-index sidesteps that entirely.
const ColorSwatchPicker: React.FC<ColorSwatchPickerProps> = ({ color, onChange }) => {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const openPicker = (): void => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) setCoords({ top: rect.bottom + 8, left: rect.left + rect.width / 2 });
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (e: PointerEvent): void => {
      const target = e.target as Node;
      if (buttonRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [open]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        title="Color"
        onClick={() => (open ? setOpen(false) : openPicker())}
        className="w-6 h-6 rounded-full ring-2 ring-white shadow-sm transition-transform duration-150 hover:scale-110"
        style={{ backgroundColor: color }}
      />
      {open &&
        coords &&
        createPortal(
          <div
            ref={popoverRef}
            style={{ position: "fixed", top: coords.top, left: coords.left, transform: "translateX(-50%)" }}
            className="flex items-center gap-2 px-2.5 py-2 rounded-2xl bg-white/90 backdrop-blur-xl shadow-[0_8px_32px_rgba(0,0,0,0.18)] ring-1 ring-black/[0.06] z-[9999]"
          >
            {PALETTE.map((swatch) => (
              <button
                key={swatch}
                type="button"
                title={swatch}
                onClick={() => {
                  onChange(swatch);
                  setOpen(false);
                }}
                className={`w-6 h-6 rounded-full transition-transform duration-150 hover:scale-110 ${
                  swatch.toLowerCase() === color.toLowerCase() ? "ring-2 ring-blue-500 ring-offset-2 ring-offset-white/90" : "ring-1 ring-black/[0.06]"
                }`}
                style={{ backgroundColor: swatch }}
              />
            ))}
            <div className="w-px h-5 bg-black/[0.08]" />
            <input
              type="color"
              title="Custom color"
              value={color}
              onChange={(e) => onChange(e.target.value)}
              className="w-6 h-6 p-0 border-0 rounded-full cursor-pointer bg-transparent"
            />
          </div>,
          document.body
        )}
    </>
  );
};

export default ColorSwatchPicker;
