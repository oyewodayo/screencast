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

const backgroundAttribute = {
  background: {
    default: null as string | null,
    parseHTML: (el: HTMLElement) => toHex(el.getAttribute("data-background")) ?? toHex(el.style.backgroundColor),
    renderHTML: (attrs: Record<string, unknown>) => {
      const bg = attrs.background as string | null;
      if (!bg) return {};
      // data-shade="dark": docLayout.css switches the cell's text to white, so a navy or charcoal
      // fill is readable without the user recolouring every run inside it.
      return { "data-background": bg, ...(isDarkShade(bg) ? { "data-shade": "dark" } : {}), style: `--cell-bg: ${bg}; background-color: ${bg}` };
    },
  },
};

export const ShadedTableCell = TableCell.extend({
  addAttributes() {
    return { ...this.parent?.(), ...backgroundAttribute };
  },
});

export const ShadedTableHeader = TableHeader.extend({
  addAttributes() {
    return { ...this.parent?.(), ...backgroundAttribute };
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
