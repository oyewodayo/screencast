// utils/templates/templateHtml.ts
//
// Small builders for writing document templates as HTML in the editor's own vocabulary - the tags
// and data-attributes the schema's parseHTML rules accept (docSchemaExtensions.ts). Kept tiny and
// string-based on purpose: a template is read top to bottom like the document it produces.
//
// One rule worth knowing: styled text must be ONE <span> carrying every property (font, colour,
// size). Font family, colour and size are all attributes of the same `textStyle` mark, and when
// spans are nested ProseMirror keeps only the innermost mark of a type - so an outer font span
// around an inner colour span would silently lose the font.

export interface RunStyle {
  font?: string;
  color?: string;
  size?: number; // pt
}

const attr = (value: string) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

export function run(style: RunStyle, html: string): string {
  const css = [style.font && `font-family: ${style.font}`, style.color && `color: ${style.color}`, style.size && `font-size: ${style.size}pt`]
    .filter(Boolean)
    .join("; ");
  return css ? `<span style="${attr(css)}">${html}</span>` : html;
}

export type Align = "left" | "center" | "right" | "justify";

export interface BlockOptions {
  align?: Align;
  before?: number; // pt above
  after?: number; // pt below
  noIndent?: boolean;
  span?: boolean; // across both columns of a two-column page
}

function blockAttrs(o: BlockOptions = {}): string {
  const style: string[] = [];
  const attrs: string[] = [];
  if (o.align && o.align !== "left") style.push(`text-align: ${o.align}`);
  if (o.before !== undefined) attrs.push(`data-space-before="${o.before}"`);
  if (o.after !== undefined) attrs.push(`data-space-after="${o.after}"`);
  if (o.noIndent) attrs.push("data-no-indent");
  if (o.span) attrs.push(`data-span="all"`);
  if (style.length) attrs.push(`style="${style.join("; ")}"`);
  return attrs.length ? ` ${attrs.join(" ")}` : "";
}

export const p = (html: string, o?: BlockOptions) => `<p${blockAttrs(o)}>${html}</p>`;
export const h = (level: 1 | 2 | 3 | 4, html: string, o?: BlockOptions) => `<h${level}${blockAttrs(o)}>${html}</h${level}>`;
export const ul = (items: string[]) => `<ul>${items.map((i) => `<li><p>${i}</p></li>`).join("")}</ul>`;
export const ol = (items: string[]) => `<ol>${items.map((i) => `<li><p>${i}</p></li>`).join("")}</ol>`;
export const tasks = (items: [boolean, string][]) =>
  `<ul data-type="taskList">${items.map(([done, text]) => `<li data-type="taskItem" data-checked="${done}"><p>${text}</p></li>`).join("")}</ul>`;
export const quote = (html: string) => `<blockquote>${html.startsWith("<") ? html : `<p>${html}</p>`}</blockquote>`;
export const hr = () => "<hr>";
export const pageBreak = () => "<div data-page-break></div>";
export const toc = (maxLevel = 3) => `<div data-toc data-max-level="${maxLevel}"></div>`;
export const bibliography = () => "<div data-bibliography></div>";
export const math = (latex: string, o: { numbered?: boolean; id?: string } = {}) =>
  `<div data-math-block data-latex="${attr(latex)}" data-numbered="${o.numbered === false ? "false" : "true"}"${o.id ? ` data-id="${o.id}"` : ""}></div>`;
export const m = (latex: string) => `<span data-math-inline data-latex="${attr(latex)}"></span>`;
export const cite = (...ids: string[]) => `<span data-cite="${ids.join(",")}"></span>`;
export const caption = (kind: "table" | "figure", html: string, id?: string) =>
  `<p data-caption="${kind}"${id ? ` data-caption-id="${id}"` : ""}>${html}</p>`;
// A cross-reference to a caption or numbered equation ("Table 1", "Eq. (2)").
export const xref = (id: string) => `<span data-xref="${id}"></span>`;

export type TableRules = "booktabs" | "doubled" | "none";

export interface TableOptions {
  rules?: TableRules;
  fit?: boolean;
  span?: boolean;
  // First row is a header row (default true).
  header?: boolean;
  headerBg?: string;
  // Per-cell fill: return a hex colour for a cell to shade it.
  shade?: (row: number, col: number) => string | undefined;
  // Column widths in px (the page's text width is ~624px on Letter with 1in margins).
  widths?: number[];
}

// A cell is plain inline HTML (wrapped in a paragraph) unless it already starts with a block.
const cellContent = (c: string) => (/^\s*<(p|ul|ol|h[1-6]|div|blockquote|table)[\s>]/.test(c) ? c : `<p>${c}</p>`);

export function table(rows: string[][], o: TableOptions = {}): string {
  const header = o.header !== false;
  const tableAttrs = [o.rules ? `data-rules="${o.rules}"` : "", o.fit ? "data-fit" : "", o.span ? `data-span="all"` : ""].filter(Boolean).join(" ");
  const body = rows
    .map((row, r) => {
      const tag = header && r === 0 ? "th" : "td";
      const cells = row
        .map((c, col) => {
          const bg = (header && r === 0 ? o.headerBg : undefined) ?? o.shade?.(r, col);
          const width = r === 0 && o.widths?.[col] ? ` colwidth="${o.widths[col]}"` : "";
          return `<${tag}${bg ? ` data-background="${bg}"` : ""}${width}>${cellContent(c)}</${tag}>`;
        })
        .join("");
      return `<tr>${cells}</tr>`;
    })
    .join("");
  return `<table${tableAttrs ? ` ${tableAttrs}` : ""}><tbody>${body}</tbody></table>`;
}

// A tinted one-cell panel - a callout, key-findings box or abstract box.
export function callout(html: string, background = "#dbeafe"): string {
  return table([[html]], { rules: "none", header: false, shade: () => background });
}

// Font stacks matching docFonts.ts's bundled faces, with sensible fallbacks.
export const FONTS = {
  latinModern: `"Latin Modern Roman", KaTeX_Main, Georgia, serif`,
  stix: `"STIX Two Text", Georgia, serif`,
  pagella: `"TeX Gyre Pagella", "Palatino Linotype", serif`,
  termes: `"TeX Gyre Termes", "Times New Roman", serif`,
  sourceSerif: `"Source Serif 4", Georgia, serif`,
  garamond: `"EB Garamond", Garamond, Georgia, serif`,
  crimson: `"Crimson Pro", Georgia, serif`,
  literata: `"Literata", Georgia, serif`,
  plexSerif: `"IBM Plex Serif", Georgia, serif`,
  playfair: `"Playfair Display", Georgia, serif`,
  inter: `"Inter", "Segoe UI", Arial, sans-serif`,
  plexSans: `"IBM Plex Sans", "Segoe UI", Arial, sans-serif`,
  sourceSans: `"Source Sans 3", "Segoe UI", Arial, sans-serif`,
  fira: `"Fira Sans", "Segoe UI", Arial, sans-serif`,
  montserrat: `"Montserrat", "Segoe UI", Arial, sans-serif`,
  poppins: `"Poppins", "Segoe UI", Arial, sans-serif`,
  spaceGrotesk: `"Space Grotesk", "Segoe UI", Arial, sans-serif`,
  jetbrains: `"JetBrains Mono", Consolas, monospace`,
};
