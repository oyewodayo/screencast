// utils/boardTemplates.ts
//
// A handful of starting points for a new board - background + padding presets applied on top of
// createEmptyBoardDocument's blank default, shown as a small picker when creating a board (see
// BoardHome.tsx's handleCreate). Purely a starting configuration, not a locked-in choice - every
// field a template sets (backgroundMode/backgroundColor/backgroundGrid/padding) stays freely
// editable afterward through the same Background/Padding controls any other board already has.

import { BoardBackgroundMode, BoardDocument, BoardGridBackground } from "./boardTypes";

export interface BoardTemplate {
  id: string;
  name: string;
  backgroundMode: BoardBackgroundMode;
  // Used when backgroundMode is "color" - also kept as the fallback for "grid" mode's mat/frame
  // border area isn't relevant here, but still set for a sane default if the user later switches
  // back to Color mode without having touched it themselves.
  backgroundColor: string | null;
  backgroundGrid: BoardGridBackground | null; // used when backgroundMode is "grid"
  padding: number;
}

export const BOARD_TEMPLATES: BoardTemplate[] = [
  { id: "blank", name: "Blank", backgroundMode: "color", backgroundColor: "#f5f5f5", backgroundGrid: null, padding: 0 },
  {
    id: "soft-grid",
    name: "Soft Grid",
    backgroundMode: "grid",
    backgroundColor: "#f5f5f5",
    backgroundGrid: { spacing: 40, lineColor: "#e5e5e5", baseColor: "#ffffff" },
    padding: 24,
  },
  { id: "dark-canvas", name: "Dark Canvas", backgroundMode: "color", backgroundColor: "#111111", backgroundGrid: null, padding: 24 },
  { id: "warm-paper", name: "Warm Paper", backgroundMode: "color", backgroundColor: "#f5ead9", backgroundGrid: null, padding: 32 },
  {
    id: "bold-grid-dark",
    name: "Bold Grid",
    backgroundMode: "grid",
    backgroundColor: "#111111",
    backgroundGrid: { spacing: 32, lineColor: "#333333", baseColor: "#0a0a0a" },
    padding: 24,
  },
];

export function applyBoardTemplate(doc: BoardDocument, template: BoardTemplate): BoardDocument {
  return {
    ...doc,
    backgroundMode: template.backgroundMode,
    backgroundColor: template.backgroundColor,
    backgroundGrid: template.backgroundGrid ?? undefined,
    padding: template.padding,
  };
}
