// utils/boardTemplates.ts
//
// A handful of starting points for a new board - background + padding presets applied on top of
// createEmptyBoardDocument's blank default, shown as a small picker when creating a board (see
// BoardHome.tsx's handleCreate). Purely a starting configuration, not a locked-in choice - every
// field a template sets (backgroundMode/backgroundColor/backgroundGrid/padding) stays freely
// editable afterward through the same Background/Padding controls any other board already has.

import { BoardBackgroundMode, BoardDocument, BoardGradientBackground, BoardGridBackground } from "./boardTypes";

export interface BoardTemplate {
  id: string;
  name: string;
  backgroundMode: BoardBackgroundMode;
  // Used when backgroundMode is "color" - also kept as the fallback for "grid" / "gradient" mode.
  backgroundColor: string | null;
  backgroundGrid: BoardGridBackground | null; // used when backgroundMode is "grid"
  backgroundGradient?: BoardGradientBackground | null; // used when backgroundMode is "gradient"
  padding: number;
}

export const BOARD_TEMPLATES: BoardTemplate[] = [
  { id: "blank", name: "Blank", backgroundMode: "color", backgroundColor: "#f5f5f5", backgroundGrid: null, padding: 0 },
  {
    id: "sunset-glow",
    name: "Sunset Glow",
    backgroundMode: "gradient",
    backgroundColor: "#ff6b6b",
    backgroundGrid: null,
    backgroundGradient: { from: "#ff6b6b", to: "#feca57", angleDeg: 135 },
    padding: 24,
  },
  {
    id: "ocean-mist",
    name: "Ocean Mist",
    backgroundMode: "gradient",
    backgroundColor: "#2563eb",
    backgroundGrid: null,
    backgroundGradient: { from: "#2563eb", to: "#06b6d4", angleDeg: 135 },
    padding: 24,
  },
  {
    id: "midnight-indigo",
    name: "Midnight",
    backgroundMode: "gradient",
    backgroundColor: "#0f172a",
    backgroundGrid: null,
    backgroundGradient: { from: "#0f172a", to: "#312e81", angleDeg: 135 },
    padding: 24,
  },
  {
    id: "lavender-dusk",
    name: "Lavender",
    backgroundMode: "gradient",
    backgroundColor: "#8b5cf6",
    backgroundGrid: null,
    backgroundGradient: { from: "#8b5cf6", to: "#ec4899", angleDeg: 135 },
    padding: 24,
  },
  {
    id: "emerald-studio",
    name: "Emerald",
    backgroundMode: "gradient",
    backgroundColor: "#059669",
    backgroundGrid: null,
    backgroundGradient: { from: "#059669", to: "#10b981", angleDeg: 135 },
    padding: 24,
  },
  {
    id: "soft-grid",
    name: "Soft Grid",
    backgroundMode: "grid",
    backgroundColor: "#f5f5f5",
    backgroundGrid: { spacing: 40, lineColor: "#e5e5e5", baseColor: "#ffffff" },
    padding: 24,
  },
  { id: "dark-canvas", name: "Dark Studio", backgroundMode: "color", backgroundColor: "#111111", backgroundGrid: null, padding: 24 },
  { id: "warm-paper", name: "Warm Paper", backgroundMode: "color", backgroundColor: "#f5ead9", backgroundGrid: null, padding: 32 },
  {
    id: "bold-grid-dark",
    name: "Bold Grid",
    backgroundMode: "grid",
    backgroundColor: "#111111",
    backgroundGrid: { spacing: 32, lineColor: "#333333", baseColor: "#0a0a0a" },
    padding: 24,
  },
  {
    id: "blueprint",
    name: "Blueprint",
    backgroundMode: "grid",
    backgroundColor: "#0b2545",
    backgroundGrid: { spacing: 36, lineColor: "#4f83bf", baseColor: "#0b2545" },
    padding: 24,
  },
  { id: "kraft-paper", name: "Kraft Paper", backgroundMode: "color", backgroundColor: "#c9a876", backgroundGrid: null, padding: 36 },
];

export function applyBoardTemplate(doc: BoardDocument, template: BoardTemplate): BoardDocument {
  return {
    ...doc,
    backgroundMode: template.backgroundMode,
    backgroundColor: template.backgroundColor,
    backgroundGrid: template.backgroundGrid ?? undefined,
    backgroundGradient: template.backgroundGradient ?? undefined,
    padding: template.padding,
  };
}
