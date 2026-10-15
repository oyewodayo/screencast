// utils/docPageChrome.ts
//
// Running headers, footers and page numbers - the "page chrome" around every page's text. Kept in
// the Y.Doc's "docSettings" map (docLayout.ts) so it travels with the document, syncs and undoes
// like its content, and comes back with a restored version.
//
// Each band (header, footer) has a left, centre and right slot of text, which may contain fields:
//   {page}  this page's number (in the chosen numeral style, counting from the chosen start)
//   {pages} the total number of pages
//   {title} the document title
//   {date}  today's date
// The page number itself is its own setting (position, wording, numerals, start) rather than a
// field typed into a slot, so it can be switched on in one click; it's appended to whichever slot
// it sits in.
//
// Three renderers read this: the live page (PageChromeOverlay in DocsEditor.tsx, per drawn sheet),
// print/PDF (printChromeCss - CSS @page margin boxes, which Chromium draws natively on every
// printed page), and Word (docDocx.ts - real header/footer parts with PAGE/NUMPAGES fields).
import * as Y from "yjs";
import { docSettingsMap } from "./docLayout";

export type ChromeBand = "header" | "footer";
export type ChromeSlot = "left" | "center" | "right";
export type ChromeSlots = Record<ChromeSlot, string>;
export type PageNumberPosition = `${ChromeBand}-${ChromeSlot}`;
export type PageNumberStyle = "plain" | "page" | "pageOf" | "slash" | "dash";
export type PageNumberFormat = "decimal" | "lower-roman" | "upper-roman" | "lower-alpha" | "upper-alpha";

export interface PageNumberSettings {
  enabled: boolean;
  position: PageNumberPosition;
  style: PageNumberStyle;
  format: PageNumberFormat;
  start: number;
}

export interface DocPageChrome {
  header: ChromeSlots;
  footer: ChromeSlots;
  pageNumber: PageNumberSettings;
  // A title page: no header, footer or number on page 1 (it still counts as a page).
  differentFirstPage: boolean;
  fontSize: number; // pt
}

export const CHROME_SLOTS: ChromeSlot[] = ["left", "center", "right"];
export const CHROME_FIELDS = ["page", "pages", "title", "date"] as const;
export type ChromeField = (typeof CHROME_FIELDS)[number];

const EMPTY_SLOTS: ChromeSlots = { left: "", center: "", right: "" };

export const DEFAULT_PAGE_NUMBER: PageNumberSettings = { enabled: false, position: "footer-center", style: "plain", format: "decimal", start: 1 };

export const DEFAULT_PAGE_CHROME: DocPageChrome = {
  header: EMPTY_SLOTS,
  footer: EMPTY_SLOTS,
  pageNumber: DEFAULT_PAGE_NUMBER,
  differentFirstPage: false,
  fontSize: 9,
};

export const PAGE_NUMBER_STYLES: { id: PageNumberStyle; label: string }[] = [
  { id: "plain", label: "1" },
  { id: "page", label: "Page 1" },
  { id: "pageOf", label: "Page 1 of 9" },
  { id: "slash", label: "1 / 9" },
  { id: "dash", label: "– 1 –" },
];

export const PAGE_NUMBER_FORMATS: { id: PageNumberFormat; label: string }[] = [
  { id: "decimal", label: "1, 2, 3" },
  { id: "lower-roman", label: "i, ii, iii" },
  { id: "upper-roman", label: "I, II, III" },
  { id: "lower-alpha", label: "a, b, c" },
  { id: "upper-alpha", label: "A, B, C" },
];

const KEY = "pageChrome";

const str = (v: unknown, max = 300): string => (typeof v === "string" ? v.slice(0, max) : "");
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(v as T) ? (v as T) : fallback);

function readSlots(v: unknown): ChromeSlots {
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  return { left: str(o.left), center: str(o.center), right: str(o.right) };
}

const POSITIONS: PageNumberPosition[] = ["header-left", "header-center", "header-right", "footer-left", "footer-center", "footer-right"];

// Validates whatever is stored (an older build, a hand-edited file, a collaborator) into a whole
// DocPageChrome - every field present and in range.
export function normalizePageChrome(v: unknown): DocPageChrome {
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  const pn = o.pageNumber && typeof o.pageNumber === "object" ? (o.pageNumber as Record<string, unknown>) : {};
  const start = typeof pn.start === "number" && Number.isFinite(pn.start) ? Math.round(pn.start) : 1;
  const size = typeof o.fontSize === "number" && Number.isFinite(o.fontSize) ? o.fontSize : DEFAULT_PAGE_CHROME.fontSize;
  return {
    header: readSlots(o.header),
    footer: readSlots(o.footer),
    pageNumber: {
      enabled: pn.enabled === true,
      position: oneOf(pn.position, POSITIONS, DEFAULT_PAGE_NUMBER.position),
      style: oneOf(pn.style, PAGE_NUMBER_STYLES.map((s) => s.id), "plain"),
      format: oneOf(pn.format, PAGE_NUMBER_FORMATS.map((f) => f.id), "decimal"),
      start: Math.min(9999, Math.max(1, start)),
    },
    differentFirstPage: o.differentFirstPage === true,
    fontSize: Math.min(14, Math.max(6, size)),
  };
}

// Documents from before this feature kept a single header and footer line in meta.json (page
// setup's headerText/footerText); they show as the left slots until the chrome is first edited,
// at which point it moves into the Y.Doc and the meta fields are cleared.
export function readPageChrome(ydoc: Y.Doc | null, legacyHeader?: string | null, legacyFooter?: string | null): DocPageChrome {
  const stored = ydoc ? docSettingsMap(ydoc).get(KEY) : undefined;
  if (stored) return normalizePageChrome(stored);
  if (!legacyHeader && !legacyFooter) return DEFAULT_PAGE_CHROME;
  return {
    ...DEFAULT_PAGE_CHROME,
    header: { ...EMPTY_SLOTS, left: legacyHeader ?? "" },
    footer: { ...EMPTY_SLOTS, left: legacyFooter ?? "" },
  };
}

export function writePageChrome(ydoc: Y.Doc, chrome: DocPageChrome): void {
  const m = docSettingsMap(ydoc);
  if (!hasPageChrome(chrome)) m.delete(KEY);
  else m.set(KEY, JSON.parse(JSON.stringify(chrome)));
}

export function hasPageChrome(chrome: DocPageChrome): boolean {
  return chrome.pageNumber.enabled || [chrome.header, chrome.footer].some((b) => CHROME_SLOTS.some((s) => b[s].trim() !== ""));
}

export function samePageChrome(a: DocPageChrome, b: DocPageChrome): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---------- Numbers ----------

function toRoman(n: number): string {
  if (n <= 0 || n >= 4000) return String(n);
  const table: [number, string][] = [
    [1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"],
    [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"],
  ];
  let out = "";
  for (const [value, numeral] of table) {
    while (n >= value) {
      out += numeral;
      n -= value;
    }
  }
  return out;
}

// CSS's lower-alpha: a…z, aa, ab… - the same sequence Chromium prints for counter(page, lower-alpha).
function toAlpha(n: number): string {
  if (n <= 0) return String(n);
  let out = "";
  while (n > 0) {
    n--;
    out = String.fromCharCode(97 + (n % 26)) + out;
    n = Math.floor(n / 26);
  }
  return out;
}

export function formatPageNumber(n: number, format: PageNumberFormat): string {
  switch (format) {
    case "lower-roman":
      return toRoman(n);
    case "upper-roman":
      return toRoman(n).toUpperCase();
    case "lower-alpha":
      return toAlpha(n);
    case "upper-alpha":
      return toAlpha(n).toUpperCase();
    default:
      return String(n);
  }
}

// ---------- Slot content ----------

export type ChromeSegment = { kind: "text"; text: string } | { kind: ChromeField };

export function parseChromeText(text: string): ChromeSegment[] {
  const out: ChromeSegment[] = [];
  const re = /\{(page|pages|title|date)\}/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push({ kind: "text", text: text.slice(last, m.index) });
    out.push({ kind: m[1] as ChromeField });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out;
}

function pageNumberSegments(style: PageNumberStyle): ChromeSegment[] {
  const t = (text: string): ChromeSegment => ({ kind: "text", text });
  switch (style) {
    case "page":
      return [t("Page "), { kind: "page" }];
    case "pageOf":
      return [t("Page "), { kind: "page" }, t(" of "), { kind: "pages" }];
    case "slash":
      return [{ kind: "page" }, t(" / "), { kind: "pages" }];
    case "dash":
      return [t("– "), { kind: "page" }, t(" –")];
    default:
      return [{ kind: "page" }];
  }
}

// What one slot shows: its own text, then the page number if it sits here.
export function slotSegments(chrome: DocPageChrome, band: ChromeBand, slot: ChromeSlot): ChromeSegment[] {
  const segs = parseChromeText(chrome[band][slot]);
  const pn = chrome.pageNumber;
  if (pn.enabled && pn.position === `${band}-${slot}`) {
    if (segs.length) segs.push({ kind: "text", text: "   " });
    segs.push(...pageNumberSegments(pn.style));
  }
  return segs;
}

export interface ChromeContext {
  title: string;
  date: string;
  pages: number;
}

export function todayLabel(): string {
  return new Date().toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

// The text of one slot on one page (1-based physical page index).
export function renderSlot(chrome: DocPageChrome, band: ChromeBand, slot: ChromeSlot, page: number, ctx: ChromeContext): string {
  return slotSegments(chrome, band, slot)
    .map((s) => {
      if (s.kind === "text") return s.text;
      if (s.kind === "page") return formatPageNumber(page + chrome.pageNumber.start - 1, chrome.pageNumber.format);
      if (s.kind === "pages") return String(ctx.pages);
      if (s.kind === "title") return ctx.title;
      return ctx.date;
    })
    .join("");
}

export function bandHasContent(chrome: DocPageChrome, band: ChromeBand): boolean {
  return CHROME_SLOTS.some((s) => slotSegments(chrome, band, s).length > 0);
}

// ---------- Print ----------

function cssString(text: string): string {
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\A ")}"`;
}

const MARGIN_BOX: Record<ChromeBand, Record<ChromeSlot, string>> = {
  header: { left: "@top-left", center: "@top-center", right: "@top-right" },
  footer: { left: "@bottom-left", center: "@bottom-center", right: "@bottom-right" },
};

export interface PrintChromeOptions extends Omit<ChromeContext, "pages"> {
  fontFamily: string;
  color: string;
  // Rough page count - only sizes the numbering table below, which must cover every printed page.
  pagesHint: number;
}

// CSS @page rules drawing the chrome in the page margins of every printed page - Chromium (and so
// WebView2's PrintToPdf) renders margin boxes natively. Page numbers come from counter(page) with a
// fixed @counter-style whose symbols are the formatted numbers themselves, which is how any start
// number and numeral style reach the printed page (counter-reset on @page can't offset it).
//
// Always emits the four empty corner boxes: a page that defines them gets none of Chromium's own
// date/title/URL/"1/3" stamps, whatever the print dialog's Headers and footers checkbox says.
export function printChromeCss(chrome: DocPageChrome, opts: PrintChromeOptions): string {
  const corners = "@top-left-corner { content: \"\" } @top-right-corner { content: \"\" } @bottom-left-corner { content: \"\" } @bottom-right-corner { content: \"\" }";
  const pn = chrome.pageNumber;
  const count = Math.max(200, Math.ceil(opts.pagesHint * 2) + 50);
  const symbols = Array.from({ length: count }, (_, i) => cssString(formatPageNumber(i + pn.start, pn.format))).join(" ");
  const boxes: string[] = [];
  const blanks: string[] = [];
  for (const band of ["header", "footer"] as ChromeBand[]) {
    for (const slot of CHROME_SLOTS) {
      const segs = slotSegments(chrome, band, slot);
      if (!segs.length) continue;
      const content = segs
        .map((s) => {
          if (s.kind === "text") return cssString(s.text);
          if (s.kind === "page") return "counter(page, doc-page-number)";
          if (s.kind === "pages") return "counter(pages)";
          return cssString(s.kind === "title" ? opts.title : opts.date);
        })
        .join(" ");
      const align = slot === "left" ? "left" : slot === "right" ? "right" : "center";
      boxes.push(
        `${MARGIN_BOX[band][slot]} { content: ${content}; white-space: pre; text-align: ${align}; vertical-align: middle; font-family: ${opts.fontFamily}; font-size: ${chrome.fontSize}pt; color: ${opts.color}; }`
      );
      blanks.push(`${MARGIN_BOX[band][slot]} { content: none; }`);
    }
  }
  return [
    `@counter-style doc-page-number { system: fixed 1; symbols: ${symbols}; fallback: decimal; }`,
    `@page { ${corners} ${boxes.join(" ")} }`,
    chrome.differentFirstPage && blanks.length ? `@page :first { ${blanks.join(" ")} }` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
