// utils/whiteboardFonts.ts
//
// Curated catalog of 30+ self-hosted modern webfonts + classic fallbacks for Whiteboard text,
// shapes, mind maps, and exports. Every modern entry maps to a local @font-face bundled in
// components/whiteboard/whiteboardFonts.css (zero network dependency).

export type WhiteboardFontCategory =
  | "Modern Sans"
  | "Editorial Serif"
  | "Mono & Code"
  | "Display"
  | "Handwriting"
  | "Classic";

export interface WhiteboardFontOption {
  label: string;
  value: string;
  category: WhiteboardFontCategory;
  /** Primary @font-face family name to preload before Canvas2D PNG/PDF exports. */
  webFontFamily?: string;
}

export const WHITEBOARD_FONT_CATEGORIES: WhiteboardFontCategory[] = [
  "Modern Sans",
  "Editorial Serif",
  "Mono & Code",
  "Display",
  "Handwriting",
  "Classic",
];

export const WHITEBOARD_FONT_OPTIONS: WhiteboardFontOption[] = [
  // Modern Sans
  { label: "Inter", value: "'Inter', system-ui, sans-serif", category: "Modern Sans", webFontFamily: "Inter" },
  { label: "Poppins", value: "'Poppins', system-ui, sans-serif", category: "Modern Sans", webFontFamily: "Poppins" },
  { label: "Montserrat", value: "'Montserrat', system-ui, sans-serif", category: "Modern Sans", webFontFamily: "Montserrat" },
  { label: "Space Grotesk", value: "'Space Grotesk', system-ui, sans-serif", category: "Modern Sans", webFontFamily: "Space Grotesk" },
  { label: "IBM Plex Sans", value: "'IBM Plex Sans', system-ui, sans-serif", category: "Modern Sans", webFontFamily: "IBM Plex Sans" },
  { label: "Fira Sans", value: "'Fira Sans', system-ui, sans-serif", category: "Modern Sans", webFontFamily: "Fira Sans" },
  { label: "Source Sans 3", value: "'Source Sans 3', system-ui, sans-serif", category: "Modern Sans", webFontFamily: "Source Sans 3" },
  { label: "Atkinson Hyperlegible", value: "'Atkinson Hyperlegible', system-ui, sans-serif", category: "Modern Sans", webFontFamily: "Atkinson Hyperlegible" },

  // Editorial Serif
  { label: "Playfair Display", value: "'Playfair Display', Georgia, serif", category: "Editorial Serif", webFontFamily: "Playfair Display" },
  { label: "Instrument Serif", value: "'Instrument Serif', Georgia, serif", category: "Editorial Serif", webFontFamily: "Instrument Serif" },
  { label: "DM Serif Display", value: "'DM Serif Display', Georgia, serif", category: "Editorial Serif", webFontFamily: "DM Serif Display" },
  { label: "EB Garamond", value: "'EB Garamond', Georgia, serif", category: "Editorial Serif", webFontFamily: "EB Garamond" },
  { label: "Crimson Pro", value: "'Crimson Pro', Georgia, serif", category: "Editorial Serif", webFontFamily: "Crimson Pro" },
  { label: "Literata", value: "'Literata', Georgia, serif", category: "Editorial Serif", webFontFamily: "Literata" },
  { label: "Source Serif 4", value: "'Source Serif 4', Georgia, serif", category: "Editorial Serif", webFontFamily: "Source Serif 4" },
  { label: "Cinzel", value: "'Cinzel', Georgia, serif", category: "Editorial Serif", webFontFamily: "Cinzel" },

  // Mono & Code
  { label: "JetBrains Mono", value: "'JetBrains Mono', ui-monospace, monospace", category: "Mono & Code", webFontFamily: "JetBrains Mono" },
  { label: "Fira Code", value: "'Fira Code', ui-monospace, monospace", category: "Mono & Code", webFontFamily: "Fira Code" },
  { label: "IBM Plex Mono", value: "'IBM Plex Mono', ui-monospace, monospace", category: "Mono & Code", webFontFamily: "IBM Plex Mono" },

  // Display
  { label: "Bebas Neue", value: "'Bebas Neue', Impact, sans-serif", category: "Display", webFontFamily: "Bebas Neue" },
  { label: "Oswald", value: "'Oswald', Impact, sans-serif", category: "Display", webFontFamily: "Oswald" },
  { label: "Anton", value: "'Anton', Impact, sans-serif", category: "Display", webFontFamily: "Anton" },
  { label: "Abril Fatface", value: "'Abril Fatface', Georgia, serif", category: "Display", webFontFamily: "Abril Fatface" },
  { label: "Righteous", value: "'Righteous', system-ui, sans-serif", category: "Display", webFontFamily: "Righteous" },
  { label: "Orbitron", value: "'Orbitron', system-ui, sans-serif", category: "Display", webFontFamily: "Orbitron" },
  { label: "Special Elite", value: "'Special Elite', 'Courier New', monospace", category: "Display", webFontFamily: "Special Elite" },

  // Handwriting
  { label: "Caveat", value: "'Caveat', cursive", category: "Handwriting", webFontFamily: "Caveat" },
  { label: "Dancing Script", value: "'Dancing Script', cursive", category: "Handwriting", webFontFamily: "Dancing Script" },
  { label: "Pacifico", value: "'Pacifico', cursive", category: "Handwriting", webFontFamily: "Pacifico" },
  { label: "Permanent Marker", value: "'Permanent Marker', cursive", category: "Handwriting", webFontFamily: "Permanent Marker" },
  { label: "Great Vibes", value: "'Great Vibes', cursive", category: "Handwriting", webFontFamily: "Great Vibes" },

  // Classic OS
  { label: "System Sans", value: "system-ui, sans-serif", category: "Classic" },
  { label: "Georgia", value: "Georgia, 'Times New Roman', serif", category: "Classic" },
  { label: "Courier New", value: "'Courier New', monospace", category: "Classic" },
  { label: "Trebuchet MS", value: "'Trebuchet MS', sans-serif", category: "Classic" },
  { label: "Comic Sans", value: "'Comic Sans MS', cursive", category: "Classic" },
];

export function whiteboardFontLabel(value: string): string {
  const exact = WHITEBOARD_FONT_OPTIONS.find((f) => f.value === value);
  if (exact) return exact.label;
  // Clean fallback for any legacy/custom font-family string (e.g. "'Inter', sans-serif" -> "Inter")
  const primary = value.split(",")[0]?.trim().replace(/^['"]|['"]$/g, "");
  return primary || "System Sans";
}

/**
 * Ensures every bundled webfont used by `nodes` is loaded into `document.fonts` before a
 * Canvas2D PNG/PDF export draws text (otherwise ctx.fillText silently falls back to system-ui).
 */
export async function preloadWhiteboardFontsForNodes(nodes: { fontFamily?: string; fontWeight?: string }[]): Promise<void> {
  if (typeof document === "undefined" || !document.fonts) return;
  const families = new Set<string>();
  for (const n of nodes) {
    if (!n.fontFamily) continue;
    const match = WHITEBOARD_FONT_OPTIONS.find((f) => f.value === n.fontFamily);
    if (match?.webFontFamily) families.add(match.webFontFamily);
  }
  if (families.size === 0) return;
  const loads: Promise<unknown>[] = [];
  for (const fam of families) {
    loads.push(document.fonts.load(`400 16px "${fam}"`).catch(() => []));
    loads.push(document.fonts.load(`700 16px "${fam}"`).catch(() => []));
  }
  await Promise.all(loads);
}
