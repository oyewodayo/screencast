// utils/titleStyles.ts
//
// Ready-made title looks - a face (titleFonts.ts) with its colour, gradient, outline, glow, shadow,
// tracking and box - picked in one click from the text panel's gallery, and what style templates
// (videoStyleTemplates.ts) dress their titles in. A look never touches the words, size, position
// or timing; picking another one replaces every look field, so nothing from the last one lingers.
import type { TextOverlay } from "./videoEditTypes";

export type TitleLook = Partial<
  Pick<TextOverlay, "fontFamily" | "color" | "fill" | "strokeColor" | "strokeWidth" | "glow" | "shadow" | "letterSpacing" | "backgroundColor" | "cornerStyle" | "padding">
>;

export interface TitleStyle {
  id: string;
  label: string;
  // What its gallery tile says - in the case the look is meant for.
  sample: string;
  look: TitleLook;
}

// Every look field but the colour (an overlay always has one), cleared - spread under a look so
// applying it resets whatever it doesn't set.
export const CLEAR_LOOK: { [K in Exclude<keyof TitleLook, "color">]-?: undefined } = {
  fontFamily: undefined,
  fill: undefined,
  strokeColor: undefined,
  strokeWidth: undefined,
  glow: undefined,
  shadow: undefined,
  letterSpacing: undefined,
  backgroundColor: undefined,
  cornerStyle: undefined,
  padding: undefined,
};

const soft = { color: "rgba(0,0,0,0.55)", x: 0, y: 0.04, blur: 0.12 };
const hard = (color: string, d = 0.06) => ({ color, x: d * 0.6, y: d, blur: 0 });

export const TITLE_STYLES: TitleStyle[] = [
  { id: "clean", label: "Clean", sample: "Aa", look: { color: "#ffffff", shadow: soft } },
  { id: "caption", label: "Caption", sample: "Caption", look: { fontFamily: "poppins-semi", color: "#ffffff", backgroundColor: "rgba(0,0,0,0.62)", cornerStyle: "rounded", padding: 0.012 } },
  { id: "outline", label: "Outline", sample: "OUTLINE", look: { fontFamily: "montserrat", color: "#ffffff", strokeColor: "#000000", strokeWidth: 9 } },
  {
    id: "headline-glow",
    label: "Headline glow",
    sample: "EVERY YEAR",
    look: { fontFamily: "anton", color: "#ffffff", fill: { from: "#ffffff", to: "#8be9ff" }, glow: { color: "#22d3ee", size: 0.35 }, letterSpacing: 0.02 },
  },
  { id: "gold-script", label: "Gold script", sample: "We Gather!", look: { fontFamily: "great-vibes", color: "#fde68a", fill: { from: "#fff3c4", to: "#e0a526" }, shadow: { color: "rgba(0,0,0,0.6)", x: 0, y: 0.03, blur: 0.08 } } },
  { id: "sticker", label: "Sticker", sample: "READY?", look: { fontFamily: "luckiest", color: "#111111", strokeColor: "#ffffff", strokeWidth: 22, shadow: hard("rgba(0,0,0,0.45)", 0.07), letterSpacing: 0.02 } },
  { id: "comic", label: "Comic pop", sample: "BOOM!", look: { fontFamily: "bangers", color: "#facc15", fill: { from: "#fff176", to: "#f97316" }, strokeColor: "#111111", strokeWidth: 14, shadow: hard("#111111", 0.08), letterSpacing: 0.04 } },
  { id: "luxe-serif", label: "Luxe serif", sample: "New Collection", look: { fontFamily: "playfair", color: "#ffffff", shadow: soft } },
  { id: "fashion-italic", label: "Editorial", sample: "Elegant", look: { fontFamily: "dm-serif-italic", color: "#ffffff", shadow: soft } },
  { id: "tracked-caps", label: "Tracked caps", sample: "CONFIDENT", look: { fontFamily: "cinzel", color: "#ffffff", letterSpacing: 0.28, shadow: { color: "rgba(0,0,0,0.45)", x: 0, y: 0.02, blur: 0.08 } } },
  { id: "fatface", label: "Fatface", sample: "Shop Now!", look: { fontFamily: "abril", color: "#ffffff", fill: { from: "#ffffff", to: "#f3e3c3" }, shadow: { color: "rgba(60,30,0,0.55)", x: 0, y: 0.04, blur: 0.06 } } },
  { id: "paper-marker", label: "Paper strip", sample: "Take a journey", look: { fontFamily: "marker", color: "#151515", backgroundColor: "#f4f2ea", padding: 0.016, cornerStyle: "square" } },
  { id: "typewriter", label: "Typewriter", sample: "Chapter one", look: { fontFamily: "typewriter", color: "#f5f5f4", backgroundColor: "rgba(10,10,10,0.78)", padding: 0.012 } },
  { id: "handwritten", label: "Handwritten", sample: "Summer days", look: { fontFamily: "caveat", color: "#ffffff", shadow: soft } },
  { id: "neon-pink", label: "Neon sign", sample: "OPEN", look: { fontFamily: "monoton", color: "#fff1f8", glow: { color: "#ff2d95", size: 0.45 }, letterSpacing: 0.04 } },
  { id: "neon-blue", label: "Neon tech", sample: "AFTER DARK", look: { fontFamily: "orbitron", color: "#e0f7ff", glow: { color: "#2f8bff", size: 0.4 }, letterSpacing: 0.08 } },
  { id: "fire", label: "Fire", sample: "HOT DROP", look: { fontFamily: "bebas", color: "#fde047", fill: { from: "#fff59d", to: "#ef4444" }, glow: { color: "#f97316", size: 0.3 }, letterSpacing: 0.04 } },
  { id: "chrome", label: "Chrome", sample: "PREMIUM", look: { fontFamily: "anton", color: "#e5e7eb", fill: { from: "#ffffff", to: "#6b7280" }, strokeColor: "#0f172a", strokeWidth: 5, shadow: { color: "rgba(0,0,0,0.6)", x: 0, y: 0.05, blur: 0.06 } } },
  { id: "retro", label: "Retro", sample: "Weekend", look: { fontFamily: "righteous", color: "#f472b6", fill: { from: "#fbcfe8", to: "#8b5cf6" }, shadow: hard("#1e1b4b", 0.07) } },
  { id: "bold-italic", label: "Sport", sample: "GAME DAY", look: { fontFamily: "montserrat-italic", color: "#ffffff", strokeColor: "#e11d48", strokeWidth: 6, shadow: hard("rgba(0,0,0,0.5)", 0.05) } },
  { id: "highlight", label: "Highlight", sample: "Key point", look: { fontFamily: "poppins", color: "#111111", backgroundColor: "#fde047", padding: 0.01, cornerStyle: "rounded" } },
  { id: "label-red", label: "Label", sample: "BREAKING", look: { fontFamily: "oswald", color: "#ffffff", backgroundColor: "#e11d48", padding: 0.012, letterSpacing: 0.08 } },
  { id: "pacifico", label: "Sweet", sample: "Hello!", look: { fontFamily: "pacifico", color: "#ffffff", strokeColor: "#ec4899", strokeWidth: 10, shadow: { color: "rgba(236,72,153,0.5)", x: 0, y: 0.04, blur: 0.1 } } },
  { id: "dancing", label: "Romance", sample: "Forever", look: { fontFamily: "dancing", color: "#fff7ed", glow: { color: "rgba(251,191,36,0.85)", size: 0.25 } } },
];

export const titleStyle = (id: string): TitleStyle | null => TITLE_STYLES.find((s) => s.id === id) ?? null;

// The look as a full patch - everything it doesn't set cleared.
export const lookPatch = (look: TitleLook): TitleLook => ({ ...CLEAR_LOOK, ...look });

// Whether an overlay is currently dressed in `style` (the gallery marks that tile).
export function wearsTitleStyle(o: Partial<TextOverlay>, style: TitleStyle): boolean {
  const full = lookPatch(style.look);
  if (style.look.color && style.look.color.toLowerCase() !== (o.color ?? "").toLowerCase()) return false;
  return (Object.keys(full) as (keyof TitleLook)[]).every((k) => k === "padding" || k === "color" || JSON.stringify(full[k] ?? null) === JSON.stringify(o[k] ?? null));
}
