// utils/whiteboardThemes.ts
//
// Studio canvas themes (background mood + grid styling) and curated 1-click Node Style Presets
// for making diagrams, notes, and slides look designer-grade in a single click.

import { WhiteboardCanvasTheme, WhiteboardNode } from "./whiteboardTypes";

export interface CanvasThemeConfig {
  id: WhiteboardCanvasTheme;
  label: string;
  swatch: string;
  bg: string;
  dotColor: string;
  lineColor: string;
  isDark?: boolean;
}

export const WHITEBOARD_CANVAS_THEMES: CanvasThemeConfig[] = [
  {
    id: "light",
    label: "Crisp Light",
    swatch: "#f8fafc",
    bg: "#f8fafc",
    dotColor: "rgba(100, 116, 139, 0.32)",
    lineColor: "rgba(148, 163, 184, 0.22)",
  },
  {
    id: "paper",
    label: "Warm Paper",
    swatch: "#faf6ee",
    bg: "#faf6ee",
    dotColor: "rgba(146, 119, 84, 0.30)",
    lineColor: "rgba(180, 152, 116, 0.20)",
  },
  {
    id: "blueprint",
    label: "Blueprint",
    swatch: "#0f2942",
    bg: "#0f2942",
    dotColor: "rgba(147, 197, 253, 0.35)",
    lineColor: "rgba(96, 165, 250, 0.18)",
    isDark: true,
  },
  {
    id: "dark",
    label: "Dark Studio",
    swatch: "#14161a",
    bg: "#14161a",
    dotColor: "rgba(148, 163, 184, 0.24)",
    lineColor: "rgba(148, 163, 184, 0.13)",
    isDark: true,
  },
];

export function resolveCanvasTheme(theme?: WhiteboardCanvasTheme): CanvasThemeConfig {
  return WHITEBOARD_CANVAS_THEMES.find((t) => t.id === theme) ?? WHITEBOARD_CANVAS_THEMES[0];
}

export interface NodeStylePreset {
  id: string;
  label: string;
  previewBg: string;
  previewBorder: string;
  previewText: string;
  patch: Partial<WhiteboardNode>;
}

export const NODE_STYLE_PRESETS: NodeStylePreset[] = [
  {
    id: "soft-card",
    label: "Soft Card",
    previewBg: "#ffffff",
    previewBorder: "#cbd5e1",
    previewText: "#0f172a",
    patch: {
      fillType: "solid",
      fillColor: "#ffffff",
      fillOpacity: 1,
      strokeColor: "#cbd5e1",
      strokeWidth: 1.5,
      strokeStyle: "solid",
      cornerRadius: 12,
      fontColor: "#0f172a",
      shadowEnabled: true,
      shadowColor: "#0f172a",
      shadowOpacity: 0.08,
      shadowBlur: 14,
      shadowOffsetX: 0,
      shadowOffsetY: 4,
    },
  },
  {
    id: "ocean",
    label: "Ocean",
    previewBg: "#dbeafe",
    previewBorder: "#2563eb",
    previewText: "#1e3a8a",
    patch: {
      fillType: "solid",
      fillColor: "#dbeafe",
      fillOpacity: 1,
      strokeColor: "#2563eb",
      strokeWidth: 2,
      strokeStyle: "solid",
      cornerRadius: 10,
      fontColor: "#1e3a8a",
      shadowEnabled: false,
    },
  },
  {
    id: "emerald",
    label: "Emerald",
    previewBg: "#dcfce7",
    previewBorder: "#16a34a",
    previewText: "#14532d",
    patch: {
      fillType: "solid",
      fillColor: "#dcfce7",
      fillOpacity: 1,
      strokeColor: "#16a34a",
      strokeWidth: 2,
      strokeStyle: "solid",
      cornerRadius: 10,
      fontColor: "#14532d",
      shadowEnabled: false,
    },
  },
  {
    id: "amber",
    label: "Warm Sticky",
    previewBg: "#fef08a",
    previewBorder: "#eab308",
    previewText: "#422006",
    patch: {
      fillType: "solid",
      fillColor: "#fef08a",
      fillOpacity: 1,
      strokeColor: "#eab308",
      strokeWidth: 1.5,
      strokeStyle: "solid",
      cornerRadius: 8,
      fontColor: "#422006",
      shadowEnabled: true,
      shadowColor: "#854d0e",
      shadowOpacity: 0.14,
      shadowBlur: 10,
      shadowOffsetX: 0,
      shadowOffsetY: 3,
    },
  },
  {
    id: "violet",
    label: "Violet",
    previewBg: "#ede9fe",
    previewBorder: "#7c3aed",
    previewText: "#4c1d95",
    patch: {
      fillType: "solid",
      fillColor: "#ede9fe",
      fillOpacity: 1,
      strokeColor: "#7c3aed",
      strokeWidth: 2,
      strokeStyle: "solid",
      cornerRadius: 10,
      fontColor: "#4c1d95",
      shadowEnabled: false,
    },
  },
  {
    id: "dark-badge",
    label: "Dark Badge",
    previewBg: "#18181b",
    previewBorder: "#3f3f46",
    previewText: "#ffffff",
    patch: {
      fillType: "solid",
      fillColor: "#18181b",
      fillOpacity: 1,
      strokeColor: "#3f3f46",
      strokeWidth: 1.5,
      strokeStyle: "solid",
      cornerRadius: 10,
      fontColor: "#ffffff",
      shadowEnabled: true,
      shadowColor: "#000000",
      shadowOpacity: 0.22,
      shadowBlur: 16,
      shadowOffsetX: 0,
      shadowOffsetY: 6,
    },
  },
];
