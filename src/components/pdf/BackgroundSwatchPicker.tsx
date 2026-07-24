// components/pdf/BackgroundSwatchPicker.tsx
import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

interface BackgroundSwatchPickerProps {
  // undefined == no fill (fully transparent) — the pre-existing, background-less note.
  color: string | undefined;
  onChange: (color: string | undefined) => void;
  size?: "sm" | "md";
}

// Translucent (not opaque) presets: a note's fill is meant to lift its text off of whatever the
// page underneath happens to be — a photo, a dark slide, plain white — without fully blocking it
// out like a solid sticky-note would.
const PALETTE = ["rgba(255,255,255,0.85)", "rgba(26,26,26,0.78)", "rgba(255,224,102,0.85)", "rgba(163,217,255,0.85)", "rgba(178,235,181,0.85)"];

const TRIGGER_SIZE_CLASSES: Record<"sm" | "md", string> = {
  sm: "w-4 h-4 ring-1",
  md: "w-6 h-6 ring-2",
};

// A checkerboard swatch face (for both the trigger and the "no fill" option) so "transparent" is
// legible as its own distinct choice rather than reading as an unset/blank button.
const CHECKERBOARD_STYLE: React.CSSProperties = {
  backgroundImage:
    "linear-gradient(45deg, #999 25%, transparent 25%), linear-gradient(-45deg, #999 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #999 75%), linear-gradient(-45deg, transparent 75%, #999 75%)",
  backgroundSize: "6px 6px",
  backgroundPosition: "0 0, 0 3px, 3px -3px, -3px 0",
  backgroundColor: "#fff",
};

// Same portal-anchored popover approach as ColorSwatchPicker (see its comment) — kept as a
// separate component rather than a mode flag on that one since the "no fill" checkerboard swatch
// and undefined-as-a-value plumbing don't apply to the plain text-color picker at all.
const BackgroundSwatchPicker: React.FC<BackgroundSwatchPickerProps> = ({ color, onChange, size = "md" }) => {
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
        title="Background"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => (open ? setOpen(false) : openPicker())}
        className={`rounded-full ring-white shadow-sm transition-transform duration-150 hover:scale-110 overflow-hidden ${TRIGGER_SIZE_CLASSES[size]}`}
        style={color ? { backgroundColor: color } : CHECKERBOARD_STYLE}
      />
      {open &&
        coords &&
        createPortal(
          <div
            ref={popoverRef}
            style={{ position: "fixed", top: coords.top, left: coords.left, transform: "translateX(-50%)" }}
            className="flex items-center gap-2 px-2.5 py-2 rounded-2xl bg-white/90 dark:bg-neutral-800/95 backdrop-blur-xl shadow-[0_8px_32px_rgba(0,0,0,0.18)] ring-1 ring-black/[0.06] dark:ring-white/[0.1] z-[9999]"
          >
            <button
              type="button"
              title="No background"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onChange(undefined);
                setOpen(false);
              }}
              className={`w-6 h-6 rounded-full overflow-hidden transition-transform duration-150 hover:scale-110 ${
                !color ? "ring-2 ring-blue-500 ring-offset-2 ring-offset-white/90 dark:ring-offset-neutral-800" : "ring-1 ring-black/[0.06] dark:ring-white/20"
              }`}
              style={CHECKERBOARD_STYLE}
            />
            {PALETTE.map((swatch) => (
              <button
                key={swatch}
                type="button"
                title={swatch}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onChange(swatch);
                  setOpen(false);
                }}
                className={`w-6 h-6 rounded-full transition-transform duration-150 hover:scale-110 ${
                  swatch === color ? "ring-2 ring-blue-500 ring-offset-2 ring-offset-white/90 dark:ring-offset-neutral-800" : "ring-1 ring-black/[0.06] dark:ring-white/20"
                }`}
                style={{ backgroundColor: swatch }}
              />
            ))}
            <div className="w-px h-5 bg-black/[0.08] dark:bg-white/[0.12]" />
            <input
              type="color"
              title="Custom background"
              value={color && color.startsWith("#") ? color : "#ffffff"}
              onMouseDown={(e) => e.preventDefault()}
              onChange={(e) => onChange(e.target.value)}
              className="w-6 h-6 p-0 border-0 rounded-full cursor-pointer bg-transparent"
            />
          </div>,
          document.body
        )}
    </>
  );
};

export default BackgroundSwatchPicker;
