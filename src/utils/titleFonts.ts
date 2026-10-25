// utils/titleFonts.ts
//
// The typefaces a video title can use (TextOverlay.fontFamily) - display, serif, script, hand,
// fun and tech faces, bundled with the app (titleFonts.css). One place says how each one is
// named in CSS and at which weight/style, so the live preview, the text editor and export
// (videoOverlayRender.ts) all ask for exactly the same face.
import "./titleFonts.css";

export type TitleFontCategory = "Display" | "Clean" | "Serif" | "Script" | "Hand" | "Fun" | "Tech";

export interface TitleFont {
  id: string;
  label: string;
  family: string;
  weight: number;
  italic?: boolean;
  category: TitleFontCategory;
  // The face looks best in capitals (condensed display faces) - pickers show it that way.
  caps?: boolean;
}

export const SYSTEM_FONT_STACK = "system-ui, -apple-system, sans-serif";

export const TITLE_FONTS: TitleFont[] = [
  { id: "bebas", label: "Bebas Neue", family: "Bebas Neue", weight: 400, category: "Display", caps: true },
  { id: "anton", label: "Anton", family: "Anton", weight: 400, category: "Display", caps: true },
  { id: "oswald", label: "Oswald", family: "Oswald", weight: 700, category: "Display", caps: true },
  { id: "montserrat", label: "Montserrat", family: "Montserrat", weight: 900, category: "Clean" },
  { id: "montserrat-italic", label: "Montserrat Italic", family: "Montserrat", weight: 900, italic: true, category: "Clean" },
  { id: "montserrat-bold", label: "Montserrat Bold", family: "Montserrat", weight: 800, category: "Clean" },
  { id: "poppins", label: "Poppins", family: "Poppins", weight: 800, category: "Clean" },
  { id: "poppins-semi", label: "Poppins Semibold", family: "Poppins", weight: 600, category: "Clean" },
  { id: "abril", label: "Abril Fatface", family: "Abril Fatface", weight: 400, category: "Serif" },
  { id: "playfair", label: "Playfair", family: "Playfair Display", weight: 700, category: "Serif" },
  { id: "playfair-italic", label: "Playfair Italic", family: "Playfair Display", weight: 700, italic: true, category: "Serif" },
  { id: "dm-serif", label: "DM Serif", family: "DM Serif Display", weight: 400, category: "Serif" },
  { id: "dm-serif-italic", label: "DM Serif Italic", family: "DM Serif Display", weight: 400, italic: true, category: "Serif" },
  { id: "cinzel", label: "Cinzel", family: "Cinzel", weight: 700, category: "Serif", caps: true },
  { id: "great-vibes", label: "Great Vibes", family: "Great Vibes", weight: 400, category: "Script" },
  { id: "pacifico", label: "Pacifico", family: "Pacifico", weight: 400, category: "Script" },
  { id: "dancing", label: "Dancing Script", family: "Dancing Script", weight: 700, category: "Script" },
  { id: "marker", label: "Permanent Marker", family: "Permanent Marker", weight: 400, category: "Hand" },
  { id: "caveat", label: "Caveat", family: "Caveat", weight: 700, category: "Hand" },
  { id: "typewriter", label: "Special Elite", family: "Special Elite", weight: 400, category: "Hand" },
  { id: "luckiest", label: "Luckiest Guy", family: "Luckiest Guy", weight: 400, category: "Fun", caps: true },
  { id: "bangers", label: "Bangers", family: "Bangers", weight: 400, category: "Fun", caps: true },
  { id: "righteous", label: "Righteous", family: "Righteous", weight: 400, category: "Fun" },
  { id: "orbitron", label: "Orbitron", family: "Orbitron", weight: 800, category: "Tech", caps: true },
  { id: "monoton", label: "Monoton", family: "Monoton", weight: 400, category: "Tech", caps: true },
];

export const TITLE_FONT_CATEGORIES: TitleFontCategory[] = ["Display", "Clean", "Serif", "Script", "Hand", "Fun", "Tech"];

const byId = new Map(TITLE_FONTS.map((f) => [f.id, f]));
export const titleFont = (id: string | undefined): TitleFont | null => (id ? byId.get(id) ?? null : null);

// The CSS `font` shorthand for a title in `id`'s face at `sizePx` (the system stack without one).
// `bold`/`italic` are a run's own formatting on top of the face.
export function titleFontCss(id: string | undefined, sizePx: number, run: { bold?: boolean; italic?: boolean } = {}): string {
  const f = titleFont(id);
  if (!f) return `${run.italic ? "italic " : ""}${run.bold ? "bold " : ""}${sizePx}px ${SYSTEM_FONT_STACK}`;
  const italic = f.italic || run.italic;
  // A bold run on a face that's already heavy has nowhere to go - it stays the face's own weight.
  const weight = run.bold && f.weight < 700 ? 700 : f.weight;
  return `${italic ? "italic " : ""}${weight} ${sizePx}px "${f.family}", ${SYSTEM_FONT_STACK}`;
}

// The same face as separate CSS properties, for DOM text.
export function titleFontStyle(id: string | undefined): { fontFamily: string; fontWeight?: number; fontStyle?: "italic" } {
  const f = titleFont(id);
  if (!f) return { fontFamily: SYSTEM_FONT_STACK };
  return { fontFamily: `"${f.family}", ${SYSTEM_FONT_STACK}`, fontWeight: f.weight, ...(f.italic ? { fontStyle: "italic" as const } : {}) };
}

// Resolves once every face in `ids` is loaded (canvas drawing doesn't wait for a web font the way
// DOM text does - it silently uses the fallback). Faces that fail to load just resolve.
export function loadTitleFonts(ids: (string | undefined)[]): Promise<void> {
  const wanted = Array.from(new Set(ids.filter((id): id is string => !!titleFont(id))));
  if (!wanted.length || typeof document === "undefined" || !document.fonts) return Promise.resolve();
  return Promise.all(wanted.map((id) => document.fonts.load(titleFontCss(id, 32)).catch(() => undefined))).then(() => undefined);
}

export const titleFontLoaded = (id: string | undefined): boolean =>
  !titleFont(id) || typeof document === "undefined" || !document.fonts || document.fonts.check(titleFontCss(id, 32));
