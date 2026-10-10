// utils/docLayout.ts
//
// Document-wide layout and body style, kept in the Y.Doc's "docSettings" map next to the citation
// style (docBibliography.ts) so they travel with the document, sync like its content and undo
// with it:
//   columns      - 1 or 2 text columns per page (journal two-column layout)
//   columnGap    - the gutter between them, in inches
//   body         - the document's own "Normal" style: the font, size, leading and paragraph
//                  rhythm every block gets unless it says otherwise. An imported paper sets it to
//                  the paper's text face (10pt Latin Modern, 12pt leading, no space between
//                  paragraphs, 1em first-line indent), so text typed later looks like the paper.
// A document without these keys is the ordinary single-column Docs page.
import * as Y from "yjs";

export interface DocBodyStyle {
  fontFamily: string | null; // CSS font-family stack
  fontSize: number | null; // pt
  lineHeight: number | null; // multiplier of fontSize
  blockSpacing: number | null; // pt between consecutive blocks
  paragraphIndent: number | null; // pt first-line indent of a paragraph that follows a paragraph
  color: string | null;
  justify: boolean;
  hyphenate: boolean;
}

export interface DocLayout {
  columns: 1 | 2;
  columnGap: number; // inches
  body: DocBodyStyle | null;
}

export const DEFAULT_COLUMN_GAP_IN = 0.25;

export const DEFAULT_LAYOUT: DocLayout = { columns: 1, columnGap: DEFAULT_COLUMN_GAP_IN, body: null };

const SETTINGS_KEY = "docSettings";

export function docSettingsMap(ydoc: Y.Doc): Y.Map<unknown> {
  return ydoc.getMap<unknown>(SETTINGS_KEY);
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function readBody(v: unknown): DocBodyStyle | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  return {
    fontFamily: typeof o.fontFamily === "string" && o.fontFamily ? o.fontFamily : null,
    fontSize: num(o.fontSize),
    lineHeight: num(o.lineHeight),
    blockSpacing: num(o.blockSpacing),
    paragraphIndent: num(o.paragraphIndent),
    color: typeof o.color === "string" ? o.color : null,
    justify: o.justify === true,
    hyphenate: o.hyphenate === true,
  };
}

export function readLayout(ydoc: Y.Doc | null): DocLayout {
  if (!ydoc) return DEFAULT_LAYOUT;
  const m = docSettingsMap(ydoc);
  const columns = m.get("columns") === 2 ? 2 : 1;
  const gap = num(m.get("columnGap"));
  return { columns, columnGap: gap !== null && gap >= 0 && gap <= 2 ? gap : DEFAULT_COLUMN_GAP_IN, body: readBody(m.get("body")) };
}

export function writeLayout(ydoc: Y.Doc, patch: Partial<DocLayout>): void {
  const m = docSettingsMap(ydoc);
  ydoc.transact(() => {
    if (patch.columns !== undefined) m.set("columns", patch.columns);
    if (patch.columnGap !== undefined) m.set("columnGap", patch.columnGap);
    if (patch.body !== undefined) {
      if (patch.body) m.set("body", { ...patch.body });
      else m.delete("body");
    }
  });
}

export function sameLayout(a: DocLayout, b: DocLayout): boolean {
  return a.columns === b.columns && a.columnGap === b.columnGap && JSON.stringify(a.body) === JSON.stringify(b.body);
}

// The body style as CSS custom properties on the page card; docLayout.css turns them into rules.
// Values a document doesn't set stay unset, so the editor's own defaults apply.
export function bodyStyleVars(body: DocBodyStyle | null): Record<string, string> {
  if (!body) return {};
  const vars: Record<string, string> = {};
  if (body.fontFamily) vars["--doc-body-font"] = body.fontFamily;
  if (body.fontSize) vars["--doc-body-size"] = `${body.fontSize}pt`;
  if (body.lineHeight) vars["--doc-body-leading"] = String(body.lineHeight);
  if (body.blockSpacing !== null) vars["--doc-block-space"] = `${body.blockSpacing}pt`;
  if (body.paragraphIndent !== null) vars["--doc-par-indent"] = `${body.paragraphIndent}pt`;
  if (body.color) vars["--doc-body-color"] = body.color;
  return vars;
}
