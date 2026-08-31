// utils/boardFonts.ts
//
// Font-family choices for BoardText, in two groups:
//  - "Modern" - real webfonts this app bundles itself (public/fonts/*.woff2, self-hosted via
//    components/board/boardFonts.css's @font-face rules) so a "modern" choice like Poppins or
//    Playfair Display renders as that actual typeface on every machine this app runs on, not just
//    ones that happen to already have it installed. `custom: true` marks these - see
//    preloadBoardFonts below for why canvas text specifically needs them force-loaded up front.
//  - "Classic" - plain OS font names with no bundled face, limited to what every major OS actually
//    ships (Windows/macOS both carry Georgia, Times New Roman, Courier New, Trebuchet MS, Verdana,
//    Impact) so a name outside this set doesn't silently fall back to the browser default with no
//    warning. Each entry's `value` is the exact string handed to canvas's ctx.font (see
//    boardHandlers.ts's renderBoardText), already including its own generic-family fallback tail.
export interface BoardFontOption {
  id: string;
  label: string;
  value: string;
  group: "Modern" | "Classic";
  // This app bundles the actual font file for this entry (see boardFonts.css) rather than naming
  // an OS font and hoping - see preloadBoardFonts's own doc comment for what that requires beyond
  // just the @font-face rule existing.
  custom?: boolean;
}

export const BOARD_FONT_OPTIONS: BoardFontOption[] = [
  { id: "inter", label: "Inter", value: "'Inter', system-ui, sans-serif", group: "Modern", custom: true },
  { id: "poppins", label: "Poppins", value: "'Poppins', system-ui, sans-serif", group: "Modern", custom: true },
  { id: "montserrat", label: "Montserrat", value: "'Montserrat', system-ui, sans-serif", group: "Modern", custom: true },
  { id: "space-grotesk", label: "Space Grotesk", value: "'Space Grotesk', system-ui, sans-serif", group: "Modern", custom: true },
  { id: "playfair-display", label: "Playfair Display", value: "'Playfair Display', Georgia, serif", group: "Modern", custom: true },
  { id: "bebas-neue", label: "Bebas Neue", value: "'Bebas Neue', Impact, sans-serif", group: "Modern", custom: true },

  { id: "system", label: "System UI", value: "system-ui, sans-serif", group: "Classic" },
  { id: "helvetica", label: "Helvetica", value: "'Helvetica Neue', Helvetica, Arial, sans-serif", group: "Classic" },
  { id: "arial", label: "Arial", value: "Arial, Helvetica, sans-serif", group: "Classic" },
  { id: "verdana", label: "Verdana", value: "Verdana, Geneva, sans-serif", group: "Classic" },
  { id: "trebuchet", label: "Trebuchet MS", value: "'Trebuchet MS', sans-serif", group: "Classic" },
  { id: "georgia", label: "Georgia", value: "Georgia, 'Times New Roman', serif", group: "Classic" },
  { id: "times", label: "Times New Roman", value: "'Times New Roman', Times, serif", group: "Classic" },
  { id: "palatino", label: "Palatino", value: "'Palatino Linotype', Palatino, serif", group: "Classic" },
  { id: "courier", label: "Courier New", value: "'Courier New', Courier, monospace", group: "Classic" },
  { id: "consolas", label: "Consolas", value: "Consolas, 'Courier New', monospace", group: "Classic" },
  { id: "impact", label: "Impact", value: "Impact, 'Arial Narrow', sans-serif", group: "Classic" },
  { id: "comic-sans", label: "Comic Sans", value: "'Comic Sans MS', 'Comic Sans', cursive", group: "Classic" },
];

export const BOARD_FONT_GROUPS: BoardFontOption["group"][] = ["Modern", "Classic"];

// A saved font-family string that doesn't match any option's `value` exactly (an older board, or a
// value hand-edited some other way) still needs a legible label in the picker - falls back to the
// raw stored value itself rather than silently mismatching against "System UI".
export function boardFontLabel(value: string): string {
  return BOARD_FONT_OPTIONS.find((option) => option.value === value)?.label ?? value;
}

// Forces every bundled custom face to actually download, then resolves - see boardFonts.css's own
// doc comment for why this is required specifically for canvas text (ctx.fillText silently falls
// back for a font that isn't loaded YET, and never retries once it finishes loading on its own the
// way DOM text does). BoardCanvas.tsx calls this once on mount and redraws when it resolves, so the
// very first paint of a board that already uses one of these fonts still comes out looking right
// instead of briefly (or permanently, until the next edit) showing a fallback face.
//
// `document.fonts.load` resolves once a family/weight pairing is loaded OR immediately if nothing
// on the page matches it (Bebas Neue has no bold face - see boardFonts.css - so its own "700" load
// below either matches the single 400 face under normal CSS font-matching or settles some other
// way; either is fine, caught and ignored either way since this is a best-effort preload, not
// something any caller needs to react to failing).
const CUSTOM_FONT_FAMILIES = BOARD_FONT_OPTIONS.filter((option) => option.custom).map((option) => option.label);

export function preloadBoardFonts(): Promise<void> {
  if (typeof document === "undefined" || !document.fonts) return Promise.resolve();
  const loads = CUSTOM_FONT_FAMILIES.flatMap((family) => [
    document.fonts.load(`400 16px "${family}"`).catch(() => []),
    document.fonts.load(`700 16px "${family}"`).catch(() => []),
  ]);
  return Promise.all(loads).then(() => undefined);
}
