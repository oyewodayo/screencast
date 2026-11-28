// components/whiteboard/WhiteboardFontPicker.tsx
//
// Visual, searchable, categorized font picker shared by WhiteboardTextToolbar and
// WhiteboardStylePanel. Renders via a portal so it is never clipped by overflow-auto parents,
// displaying every font name in its own real typeface.

import React, { memo, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IoCheckmark, IoChevronDown, IoSearchOutline } from "react-icons/io5";
import {
  WHITEBOARD_FONT_CATEGORIES,
  WHITEBOARD_FONT_OPTIONS,
  whiteboardFontLabel,
} from "../../utils/whiteboardFonts";

interface WhiteboardFontPickerProps {
  value: string;
  onChange: (fontFamily: string) => void;
  compact?: boolean;
  className?: string;
}

const WhiteboardFontPicker: React.FC<WhiteboardFontPickerProps> = memo(
  ({ value, onChange, compact = false, className = "" }) => {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState("");
    const [pos, setPos] = useState<{ left: number; top: number; width: number }>({ left: 0, top: 0, width: 220 });
    const triggerRef = useRef<HTMLButtonElement>(null);
    const menuRef = useRef<HTMLDivElement>(null);
    const searchRef = useRef<HTMLInputElement>(null);

    const openMenu = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (rect) {
        const menuW = 240;
        const menuMaxH = 340;
        const left = Math.max(8, Math.min(rect.left, window.innerWidth - menuW - 8));
        const spaceBelow = window.innerHeight - rect.bottom - 12;
        const top = spaceBelow >= 200 ? rect.bottom + 4 : Math.max(8, rect.top - menuMaxH - 4);
        setPos({ left, top, width: menuW });
      }
      setQuery("");
      setOpen(true);
    };

    useEffect(() => {
      if (!open) return;
      requestAnimationFrame(() => searchRef.current?.focus());
      const onPointerDown = (e: PointerEvent) => {
        const target = e.target as Node | null;
        if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
        setOpen(false);
      };
      const onKeyDown = (e: KeyboardEvent) => {
        if (e.key === "Escape") setOpen(false);
      };
      window.addEventListener("pointerdown", onPointerDown, true);
      window.addEventListener("keydown", onKeyDown);
      return () => {
        window.removeEventListener("pointerdown", onPointerDown, true);
        window.removeEventListener("keydown", onKeyDown);
      };
    }, [open]);

    const grouped = useMemo(() => {
      const q = query.trim().toLowerCase();
      return WHITEBOARD_FONT_CATEGORIES.map((category) => ({
        category,
        options: WHITEBOARD_FONT_OPTIONS.filter(
          (f) =>
            f.category === category &&
            (!q || f.label.toLowerCase().includes(q) || f.category.toLowerCase().includes(q))
        ),
      })).filter((g) => g.options.length > 0);
    }, [query]);

    const label = whiteboardFontLabel(value);

    return (
      <>
        <button
          ref={triggerRef}
          type="button"
          onMouseDown={(e) => {
            if (compact) e.preventDefault();
          }}
          onClick={(e) => {
            e.stopPropagation();
            if (open) setOpen(false);
            else openMenu();
          }}
          title={`Font: ${label}`}
          className={`flex items-center justify-between gap-1.5 h-7 px-2 rounded text-left text-xs text-neutral-800 dark:text-neutral-100 transition-colors ${
            compact
              ? "hover:bg-gray-100 dark:hover:bg-neutral-700 max-w-[132px]"
              : "w-full bg-black/[0.04] dark:bg-white/[0.06] border border-transparent hover:border-black/[0.08] dark:hover:border-white/[0.1]"
          } ${className}`}
        >
          <span className="truncate" style={{ fontFamily: value }}>
            {label}
          </span>
          <IoChevronDown size={11} className="shrink-0 opacity-60" />
        </button>

        {open &&
          createPortal(
            <div
              ref={menuRef}
              onPointerDown={(e) => e.stopPropagation()}
              style={{ left: pos.left, top: pos.top, width: pos.width }}
              className="fixed z-50 rounded-xl bg-white dark:bg-neutral-900 border border-gray-200 dark:border-neutral-700 shadow-2xl overflow-hidden flex flex-col"
            >
              <div className="flex items-center gap-1.5 px-2.5 py-2 border-b border-gray-100 dark:border-neutral-800">
                <IoSearchOutline size={13} className="text-gray-400 shrink-0" />
                <input
                  ref={searchRef}
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search fonts…"
                  className="flex-1 min-w-0 bg-transparent text-xs text-neutral-800 dark:text-neutral-100 outline-none placeholder:text-gray-400"
                />
              </div>
              <div className="max-h-[290px] overflow-y-auto py-1 [scrollbar-width:thin]">
                {grouped.length === 0 ? (
                  <p className="px-3 py-4 text-center text-xs text-gray-400">No matching fonts</p>
                ) : (
                  grouped.map((g) => (
                    <div key={g.category} className="mb-1 last:mb-0">
                      <p className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-neutral-500">
                        {g.category}
                      </p>
                      {g.options.map((opt) => {
                        const active = opt.value === value;
                        return (
                          <button
                            key={opt.label}
                            type="button"
                            onClick={() => {
                              onChange(opt.value);
                              setOpen(false);
                            }}
                            className={`w-full flex items-center justify-between gap-2 px-3 py-1.5 text-left transition-colors ${
                              active
                                ? "bg-blue-50 dark:bg-blue-500/20 text-blue-600 dark:text-blue-400"
                                : "text-neutral-800 dark:text-neutral-200 hover:bg-gray-100 dark:hover:bg-neutral-800"
                            }`}
                          >
                            <span className="text-[14px] leading-tight truncate" style={{ fontFamily: opt.value }}>
                              {opt.label}
                            </span>
                            {active && <IoCheckmark size={14} className="shrink-0" />}
                          </button>
                        );
                      })}
                    </div>
                  ))
                )}
              </div>
            </div>,
            document.body
          )}
      </>
    );
  }
);

WhiteboardFontPicker.displayName = "WhiteboardFontPicker";

export default WhiteboardFontPicker;
