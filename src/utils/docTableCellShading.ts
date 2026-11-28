// utils/docTableCellShading.ts
//
// Cell shading for tables - a `background` attribute on table cells and header cells, the way
// Word/Google Docs let a cell be filled. Drives coloured header rows, total rows, résumé sidebars
// and one-cell callout boxes.
//
// Stored as a plain hex colour so it round-trips through HTML, .docx export (a cell shading fill)
// and Markdown (dropped). On screen the cell also gets `data-background` + a `--cell-bg` custom
// property: docLayout.css uses those to keep the fill on rule-styled tables (which otherwise force
// transparent cells) and to tone it down on the dark page, where a full-strength light tint would
// sit behind light text.
import TableCell from "@tiptap/extension-table-cell";
import TableHeader from "@tiptap/extension-table-header";

export const CELL_SHADES: { label: string; value: string }[] = [
  { label: "Grey", value: "#f1f5f9" },
  { label: "Blue", value: "#dbeafe" },
  { label: "Green", value: "#dcfce7" },
  { label: "Yellow", value: "#fef9c3" },
  { label: "Orange", value: "#ffedd5" },
  { label: "Red", value: "#fee2e2" },
  { label: "Purple", value: "#ede9fe" },
  { label: "Navy", value: "#1e3a5f" },
  { label: "Charcoal", value: "#262626" },
];

const HEX = /^#[0-9a-f]{6}$/i;

function toHex(value: string | null | undefined): string | null {
  if (!value) return null;
  const v = value.trim();
  if (HEX.test(v)) return v.toLowerCase();
  const rgb = v.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (rgb) return `#${rgb.slice(1, 4).map((n) => Number(n).toString(16).padStart(2, "0")).join("")}`;
  return null;
}

// Upgrades washed-out near-white borders (e.g. #e5e5e5) and missing inner edges on bordered grid
// cells so table grids always look crisp and complete on screen and in exports.
export function normalizeRenderedCellBorders(edges: string[]): string[] {
  const trimmed = edges.map((e) => e.trim());
  const visibleCount = trimmed.filter((e) => e && e !== "none").length;
  // Borderless layout cell (0 visible) or single-rule callout/underline cell (1 visible): keep as-is.
  if (visibleCount < 2) return trimmed;
  return trimmed.map((edge) => {
    if (!edge || edge === "none") return "0.75pt solid #94a3b8";
    return edge.replace(/#([0-9a-f]{6})\b/i, (full, hex: string) => {
      const n = parseInt(hex, 16);
      const r = (n >> 16) & 255;
      const g = (n >> 8) & 255;
      const b = n & 255;
      // If the border is a very faint near-white grey, deepen it to slate-400 so it's clearly visible.
      if (r >= 0xd0 && g >= 0xd0 && b >= 0xd0 && Math.max(r, g, b) - Math.min(r, g, b) <= 20) {
        return "#94a3b8";
      }
      return full;
    });
  });
}

// Imported from Word: the cell's vertical alignment, and its four edges as CSS ("t|r|b|l") when the
// document set its own borders (forms, letterheads) instead of the editor's grid.
const layoutAttributes = {
  verticalAlign: {
    default: null,
    parseHTML: (el: HTMLElement) => {
      const v = el.getAttribute("data-valign") ?? el.style.verticalAlign;
      return v === "middle" || v === "bottom" || v === "top" ? v : null;
    },
    renderHTML: (attrs: Record<string, unknown>) =>
      attrs.verticalAlign
        ? { "data-valign": String(attrs.verticalAlign), style: `vertical-align: ${attrs.verticalAlign}` }
        : {},
  },
  borders: {
    default: null,
    parseHTML: (el: HTMLElement) => el.getAttribute("data-borders") || null,
    renderHTML: (attrs: Record<string, unknown>) => {
      const raw = typeof attrs.borders === "string" ? attrs.borders.split("|") : null;
      if (!raw || raw.length !== 4) return {};
      const b = normalizeRenderedCellBorders(raw);
      return {
        "data-borders": attrs.borders as string,
        style: `border-top: ${b[0]}; border-right: ${b[1]}; border-bottom: ${b[2]}; border-left: ${b[3]}`,
      };
    },
  },
};

const backgroundAttribute = {
  background: {
    default: null as string | null,
    parseHTML: (el: HTMLElement) => toHex(el.getAttribute("data-background")) ?? toHex(el.style.backgroundColor),
    renderHTML: (attrs: Record<string, unknown>) => {
      const bg = attrs.background as string | null;
      if (!bg) return {};
      // data-shade="dark": docLayout.css switches the cell's text to white, so a navy or charcoal
      // fill is readable without the user recolouring every run inside it.
      return {
        "data-background": bg,
        ...(isDarkShade(bg) ? { "data-shade": "dark" } : {}),
        style: `--cell-bg: ${bg}; background-color: ${bg}`,
      };
    },
  },
};

export const ShadedTableCell = TableCell.extend({
  addAttributes() {
    return { ...this.parent?.(), ...backgroundAttribute, ...layoutAttributes };
  },
});

export const ShadedTableHeader = TableHeader.extend({
  addAttributes() {
    return { ...this.parent?.(), ...backgroundAttribute, ...layoutAttributes };
  },
});

// Perceived brightness, for picking readable text on a shaded cell in exports.
export function isDarkShade(hex: string): boolean {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b < 128;
}
