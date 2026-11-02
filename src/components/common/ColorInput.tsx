// components/common/ColorInput.tsx
//
// Briefcast's colour picker, standing in for <input type="color"> everywhere. The browser's own
// colour dialog in WebView2 has an eyedropper that does nothing when clicked, and it can't be fixed
// from the page - so every colour field opens this instead: a saturation/brightness square, a hue
// strip, hex and RGB fields, the colours used recently, and an eyedropper that works - it picks any
// pixel on the screen through screen_color.rs (video/ScreenColorPicker.tsx's loupe).
//
// ColorInput takes the same props an <input type="color"> did (value, onChange with
// e.target.value, className, style, title, disabled, aria-*, a ref that .click()s it open), so
// swapping it in is a rename. Changes stream out live while dragging, as the native input's did.
import React, { forwardRef, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { addRecentColor, clamp, getRecentColors, hexToRgb, hsvToRgb, rgbToHex, rgbToHsv } from "../../utils/docColor";
import { pickScreenColor } from "../video/ScreenColorPicker";

const RECENT_KEY = "briefcast.colors.recent";

export const EyedropperIcon: React.FC<{ size?: number }> = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M14.5 6.5l3 3" />
    <path d="M16.2 3.8a2.1 2.1 0 0 1 3 0l1 1a2.1 2.1 0 0 1 0 3l-2 2-4-4 2-2z" />
    <path d="M13.5 8.5L5 17v2.5h2.5L16 11" />
  </svg>
);

// Picks a colour off the screen; resolves "#rrggbb" or null when cancelled.
export const pickColorFromScreen = () => pickScreenColor();

// ------------------------------------------------------------------------------------------------
// The editor: square + hue + fields + eyedropper + recents. Calls onChange live.

export const ColorEditor: React.FC<{ value: string; onChange: (hex: string) => void; onPicked?: () => void; recentKey?: string }> = ({ value, onChange, onPicked, recentKey = RECENT_KEY }) => {
  const start = hexToRgb(value) ?? [255, 0, 0];
  const [hsv, setHsv] = useState<[number, number, number]>(() => rgbToHsv(...start));
  const [hexText, setHexText] = useState(() => rgbToHex(...start));
  const [recent] = useState(() => getRecentColors(recentKey));
  const [h, s, v] = hsv;
  const rgb = hsvToRgb(h, s, v);
  const hex = rgbToHex(...rgb);

  // An outside change (another control, undo) moves the editor - unless it's our own echo.
  const lastSent = useRef(hex);
  useEffect(() => {
    if (!value || value.toLowerCase() === lastSent.current.toLowerCase()) return;
    const next = hexToRgb(value);
    if (!next) return;
    setHsv(rgbToHsv(...next));
    setHexText(rgbToHex(...next));
  }, [value]);

  const commit = useCallback(
    (next: [number, number, number]) => {
      setHsv(next);
      const out = rgbToHex(...hsvToRgb(...next));
      setHexText(out);
      lastSent.current = out;
      onChange(out);
    },
    [onChange]
  );
  const commitHex = (raw: string) => {
    const c = hexToRgb(raw.startsWith("#") ? raw : `#${raw}`);
    if (!c) return false;
    commit(rgbToHsv(...c));
    return true;
  };

  const drag = (fn: (x: number, y: number) => void) => ({
    onPointerDown: (e: React.PointerEvent) => {
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      const r = e.currentTarget.getBoundingClientRect();
      fn((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
      const r = e.currentTarget.getBoundingClientRect();
      fn((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
    },
  });

  const eyedrop = async () => {
    const picked = await pickColorFromScreen();
    if (picked) {
      commitHex(picked);
      onPicked?.();
    }
  };

  return (
    <div className="w-60 select-none">
      <div
        {...drag((x, y) => commit([h, clamp(x * 100, 0, 100), clamp(100 - y * 100, 0, 100)]))}
        className="relative w-full h-36 rounded-lg cursor-crosshair touch-none"
        style={{ backgroundColor: `hsl(${h}, 100%, 50%)`, backgroundImage: "linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, transparent)" }}
      >
        <div className="absolute w-3.5 h-3.5 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.25),0_1px_3px_rgba(0,0,0,0.4)] -translate-x-1/2 translate-y-1/2 pointer-events-none" style={{ left: `${s}%`, bottom: `${v}%`, backgroundColor: hex }} />
      </div>
      <div className="flex items-center gap-2 mt-2.5">
        <button
          type="button"
          onClick={() => void eyedrop()}
          className="shrink-0 w-8 h-8 rounded-lg flex items-center justify-center text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-700 ring-1 ring-neutral-200 dark:ring-neutral-700"
          data-tip="Pick a colour from anywhere on the screen"
          aria-label="Pick a colour from the screen"
        >
          <EyedropperIcon />
        </button>
        <span className="shrink-0 w-8 h-8 rounded-full ring-1 ring-black/10" style={{ backgroundColor: hex }} />
        <div
          {...drag((x) => commit([clamp(x * 360, 0, 359.9), s, v]))}
          className="relative flex-1 h-3 rounded-full cursor-pointer touch-none"
          style={{ background: "linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)" }}
        >
          <div className="absolute top-1/2 w-4 h-4 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.25)] -translate-x-1/2 -translate-y-1/2 pointer-events-none" style={{ left: `${(h / 360) * 100}%`, backgroundColor: `hsl(${h}, 100%, 50%)` }} />
        </div>
      </div>
      <div className="grid grid-cols-[1.6fr_1fr_1fr_1fr] gap-1.5 mt-2.5">
        <label className="flex flex-col items-center gap-0.5">
          <input
            value={hexText}
            onChange={(e) => {
              setHexText(e.target.value);
              commitHex(e.target.value);
            }}
            onBlur={() => setHexText(hex)}
            spellCheck={false}
            className="w-full h-7 px-1.5 rounded-md text-[12px] font-mono uppercase text-center bg-neutral-50 dark:bg-neutral-900 ring-1 ring-neutral-200 dark:ring-neutral-700 outline-none focus:ring-blue-500"
          />
          <span className="text-[10px] text-neutral-400">Hex</span>
        </label>
        {(["R", "G", "B"] as const).map((ch, i) => (
          <label key={ch} className="flex flex-col items-center gap-0.5">
            <input
              value={rgb[i]}
              inputMode="numeric"
              onChange={(e) => {
                const n = clamp(parseInt(e.target.value || "0", 10) || 0, 0, 255);
                const next = [...rgb] as [number, number, number];
                next[i] = n;
                commit(rgbToHsv(...next));
              }}
              onKeyDown={(e) => {
                if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
                e.preventDefault();
                const next = [...rgb] as [number, number, number];
                next[i] = clamp(next[i] + (e.key === "ArrowUp" ? 1 : -1) * (e.shiftKey ? 10 : 1), 0, 255);
                commit(rgbToHsv(...next));
              }}
              className="w-full h-7 px-1 rounded-md text-[12px] tabular-nums text-center bg-neutral-50 dark:bg-neutral-900 ring-1 ring-neutral-200 dark:ring-neutral-700 outline-none focus:ring-blue-500"
            />
            <span className="text-[10px] text-neutral-400">{ch}</span>
          </label>
        ))}
      </div>
      {recent.length > 0 && (
        <div className="mt-2.5 pt-2 border-t border-neutral-100 dark:border-neutral-700">
          <div className="text-[10px] uppercase tracking-wide text-neutral-400 mb-1">Recent</div>
          <div className="flex flex-wrap gap-1">
            {recent.slice(0, 10).map((c) => (
              <button key={c} type="button" onClick={() => commitHex(c)} className="w-5 h-5 rounded-[5px] ring-1 ring-black/10 hover:scale-110 transition-transform" style={{ backgroundColor: c }} aria-label={c} data-tip={c.toUpperCase()} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

// ------------------------------------------------------------------------------------------------
// The field itself.

type ColorEvent = { target: { value: string }; currentTarget: { value: string } };

export interface ColorInputProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onChange" | "value" | "type"> {
  value: string;
  onChange?: (e: ColorEvent) => void;
}

const ColorInput = forwardRef<HTMLButtonElement, ColorInputProps>(({ value, onChange, className, style, disabled, ...rest }, ref) => {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  const changed = useRef<string | null>(null);

  const setRefs = (el: HTMLButtonElement | null) => {
    btnRef.current = el;
    if (typeof ref === "function") ref(el);
    else if (ref) (ref as React.MutableRefObject<HTMLButtonElement | null>).current = el;
  };

  const close = useCallback(() => {
    setOpen(false);
    if (changed.current) addRecentColor(RECENT_KEY, changed.current);
    changed.current = null;
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const r = btnRef.current?.getBoundingClientRect();
      const pop = popRef.current;
      if (!r || !pop) return;
      const w = pop.offsetWidth;
      const hgt = pop.offsetHeight;
      let left = Math.min(Math.max(8, r.left), window.innerWidth - w - 8);
      let top = r.bottom + 6;
      if (top + hgt > window.innerHeight - 8) top = Math.max(8, r.top - hgt - 6);
      if (r.width === 0 && r.height === 0) left = Math.min(Math.max(8, r.left - w / 2), window.innerWidth - w - 8);
      setAt({ left, top });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (popRef.current?.contains(t) || btnRef.current?.contains(t)) return;
      // The eyedropper's own overlay takes clicks while picking.
      if ((t as HTMLElement).closest?.("[data-color-pick-overlay]")) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, close]);

  const emit = (hex: string) => {
    changed.current = hex;
    onChange?.({ target: { value: hex }, currentTarget: { value: hex } });
  };

  return (
    <>
      <button
        {...rest}
        ref={setRefs}
        type="button"
        disabled={disabled}
        onClick={(e) => {
          rest.onClick?.(e);
          if (!disabled) (open ? close() : setOpen(true));
        }}
        className={className}
        // The swatch shows its colour, as the native field did.
        style={{ backgroundColor: value, ...style }}
      />
      {open &&
        createPortal(
          <div
            ref={popRef}
            className="fixed z-[2147482000] p-3 rounded-xl bg-white dark:bg-neutral-800 shadow-[0_12px_32px_rgba(15,23,42,0.2),0_2px_6px_rgba(15,23,42,0.12)] ring-1 ring-black/5 dark:ring-white/10"
            style={at ?? { left: -9999, top: -9999 }}
            onMouseDown={(e) => {
              if (!(e.target as HTMLElement).closest("input")) e.preventDefault();
            }}
          >
            <ColorEditor value={value} onChange={emit} />
          </div>,
          document.body
        )}
    </>
  );
});
ColorInput.displayName = "ColorInput";

export default ColorInput;
