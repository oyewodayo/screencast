// utils/boardFonts.ts
//
// Curated font-family choices for BoardText - deliberately limited to fonts that render
// consistently without bundling/loading a webfont: generic CSS family keywords (sans-serif, serif,
// monospace, cursive) as the universal fallback tail, backed by the specific faces every major OS
// actually ships (Windows/macOS both carry Georgia, Times New Roman, Courier New, Trebuchet MS,
// Verdana, Impact - the classic "web-safe" set) - a name outside this set would silently fall back
// to the browser default on whichever OS doesn't have it, with no warning to the user. Each entry's
// `value` is the exact string handed to canvas's ctx.font (see boardHandlers.ts's renderBoardText),
// already including its own generic fallback.
export interface BoardFontOption {
  id: string;
  label: string;
  value: string;
}

export const BOARD_FONT_OPTIONS: BoardFontOption[] = [
  { id: "system", label: "System UI", value: "system-ui, sans-serif" },
  { id: "helvetica", label: "Helvetica", value: "'Helvetica Neue', Helvetica, Arial, sans-serif" },
  { id: "arial", label: "Arial", value: "Arial, Helvetica, sans-serif" },
  { id: "verdana", label: "Verdana", value: "Verdana, Geneva, sans-serif" },
  { id: "trebuchet", label: "Trebuchet MS", value: "'Trebuchet MS', sans-serif" },
  { id: "georgia", label: "Georgia", value: "Georgia, 'Times New Roman', serif" },
  { id: "times", label: "Times New Roman", value: "'Times New Roman', Times, serif" },
  { id: "palatino", label: "Palatino", value: "'Palatino Linotype', Palatino, serif" },
  { id: "courier", label: "Courier New", value: "'Courier New', Courier, monospace" },
  { id: "consolas", label: "Consolas", value: "Consolas, 'Courier New', monospace" },
  { id: "impact", label: "Impact", value: "Impact, 'Arial Narrow', sans-serif" },
  { id: "comic-sans", label: "Comic Sans", value: "'Comic Sans MS', 'Comic Sans', cursive" },
];

// A saved font-family string that doesn't match any option's `value` exactly (an older board, or a
// value hand-edited some other way) still needs a legible label in the picker - falls back to the
// raw stored value itself rather than silently mismatching against "System UI".
export function boardFontLabel(value: string): string {
  return BOARD_FONT_OPTIONS.find((option) => option.value === value)?.label ?? value;
}
