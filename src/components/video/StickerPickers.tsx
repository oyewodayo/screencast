// components/video/StickerPickers.tsx
//
// The icon and emoji pickers - searchable, grouped - shared by the Elements gallery's Icons and
// Emoji tabs and by a sticker's own settings, so both offer exactly the same set.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { IoSearch } from "react-icons/io5";
import { ICON_GROUPS, STICKER_ICONS, StickerIcon, drawStickerIcon, searchIcons } from "../../utils/stickerIcons";
import { EMOJI_CATEGORIES, searchEmoji } from "../../utils/stickerEmoji";

const keepFocus = (e: React.MouseEvent) => e.preventDefault();

// An icon as a small static glyph.
export const IconGlyph: React.FC<{ icon: StickerIcon; size?: number }> = ({ icon, size = 18 }) => {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = size * dpr;
    c.height = size * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawStickerIcon(ctx, icon, size / 2, size / 2, size * 0.9, "#ffffff");
  }, [icon, size]);
  return icon === "none" ? <span className="text-[10px]">None</span> : <canvas ref={ref} style={{ width: size, height: size }} />;
};

const SearchField: React.FC<{ value: string; onChange: (v: string) => void; placeholder: string }> = ({ value, onChange, placeholder }) => (
  <label className="flex items-center gap-1.5 h-7 px-2 rounded-md bg-black/40 ring-1 ring-white/10 focus-within:ring-blue-400 text-white/40">
    <IoSearch size={12} className="shrink-0" />
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Escape" && value) {
          e.stopPropagation();
          onChange("");
        }
      }}
      placeholder={placeholder}
      spellCheck={false}
      className="flex-1 min-w-0 bg-transparent text-[11px] text-white placeholder:text-white/35 outline-none"
    />
  </label>
);

const GroupTitle: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span className="col-span-full pt-1 text-[9.5px] font-medium uppercase tracking-wider text-white/35">{children}</span>
);

export const IconPicker: React.FC<{
  value?: StickerIcon;
  onPick: (icon: StickerIcon) => void;
  // Offer "None" (a sticker's slot can be empty; the gallery adds an icon).
  allowNone?: boolean;
  columns?: number;
  tile?: number;
  maxHeight?: number;
}> = ({ value, onPick, allowNone = true, columns = 6, tile = 32, maxHeight = 210 }) => {
  const [query, setQuery] = useState("");
  const found = useMemo(() => searchIcons(query).filter((i) => allowNone || i.value !== "none"), [query, allowNone]);
  const button = (i: (typeof STICKER_ICONS)[number]) => (
    <button
      key={i.value}
      type="button"
      title={i.label}
      onMouseDown={keepFocus}
      onClick={() => onPick(i.value)}
      style={{ height: tile }}
      className={`flex items-center justify-center rounded-md transition-colors ${
        value === i.value ? "bg-white/15 ring-1 ring-blue-400/70 text-white" : "bg-white/[0.04] hover:bg-white/[0.1] text-white/60"
      }`}
    >
      <IconGlyph icon={i.value} size={Math.round(tile * 0.55)} />
    </button>
  );
  return (
    <div className="flex flex-col gap-1.5">
      <SearchField value={query} onChange={setQuery} placeholder={`Search ${STICKER_ICONS.length - 1} icons`} />
      <div className="grid gap-1 overflow-y-auto pr-0.5" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, maxHeight }}>
        {query.trim() ? (
          found.length ? found.map(button) : <span className="col-span-full py-3 text-center text-[11px] text-white/40">No icon matches “{query.trim()}”</span>
        ) : (
          <>
            {allowNone && button(STICKER_ICONS[0])}
            {ICON_GROUPS.map((g) => (
              <React.Fragment key={g}>
                <GroupTitle>{g}</GroupTitle>
                {STICKER_ICONS.filter((i) => i.group === g).map(button)}
              </React.Fragment>
            ))}
          </>
        )}
      </div>
    </div>
  );
};

export const EmojiPicker: React.FC<{ value?: string; onPick: (emoji: string) => void; columns?: number; maxHeight?: number }> = ({
  value,
  onPick,
  columns = 8,
  maxHeight = 210,
}) => {
  const [query, setQuery] = useState("");
  const found = useMemo(() => (query.trim() ? searchEmoji(query) : null), [query]);
  const button = (char: string, words: string) => (
    <button
      key={char}
      type="button"
      title={words}
      onMouseDown={keepFocus}
      onClick={() => onPick(char)}
      className={`h-8 flex items-center justify-center rounded-md text-[19px] leading-none transition-[background-color,transform] hover:scale-110 ${
        value === char ? "bg-white/15 ring-1 ring-blue-400/70" : "hover:bg-white/[0.1]"
      }`}
      style={{ fontFamily: `"Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif` }}
    >
      {char}
    </button>
  );
  return (
    <div className="flex flex-col gap-1.5">
      <SearchField value={query} onChange={setQuery} placeholder="Search emoji - fire, party, money…" />
      <div className="grid gap-0.5 overflow-y-auto pr-0.5" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, maxHeight }}>
        {found ? (
          found.length ? (
            found.map((e) => button(e.char, e.words))
          ) : (
            <span className="col-span-full py-3 text-center text-[11px] text-white/40">No emoji matches “{query.trim()}”</span>
          )
        ) : (
          EMOJI_CATEGORIES.map((cat) => (
            <React.Fragment key={cat.label}>
              <GroupTitle>{cat.label}</GroupTitle>
              {cat.items.map((e) => button(e.char, e.words))}
            </React.Fragment>
          ))
        )}
      </div>
    </div>
  );
};
