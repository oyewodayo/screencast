// utils/docFonts.ts
//
// The Docs font library. Three sources, one menu:
//
//   * Bundled faces (docFonts.css) - chosen for academic and professional writing: the LaTeX
//     default (Latin Modern), the faces journals print in (STIX Two for APS/AIP, Libertinus for
//     ACM, TeX Gyre Termes/Pagella for Times/Palatino house styles), refined text serifs, sans
//     faces for reports and slides, and code fonts. Self-hosted, so they look identical on every
//     machine and in every PDF, with no internet.
//   * Fonts in this document - a font file the user adds, or the fonts embedded in an imported
//     PDF. Stored as document assets and listed in the Y.Doc, so they travel with the document.
//   * System fonts - the classic names .docx files use, for Word round-trips.
//
// A font is applied as a CSS font-family stack (the TextStyle `fontFamily` mark), always ending in
// a sensible fallback, so a missing face degrades gracefully instead of to the browser default.
import * as Y from "yjs";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { readOtf } from "./pdfImport/otf";

export type FontCategory = "document" | "tex" | "serif" | "sans" | "mono" | "system";

export interface FontEntry {
  family: string;
  label: string;
  category: FontCategory;
  stack: string;
  // One line on why you'd pick it - shown under the name in the menu.
  note?: string;
}

const serif = (family: string) => `"${family}", Georgia, serif`;
const sans = (family: string) => `"${family}", Arial, sans-serif`;
const mono = (family: string) => `"${family}", Consolas, monospace`;

export const FONT_CATEGORIES: { id: FontCategory; title: string }[] = [
  { id: "document", title: "In this document" },
  { id: "tex", title: "LaTeX & journal" },
  { id: "serif", title: "Serif" },
  { id: "sans", title: "Sans serif" },
  { id: "mono", title: "Monospace" },
  { id: "system", title: "Installed with Windows" },
];

export const FONT_LIBRARY: FontEntry[] = [
  { family: "Latin Modern Roman", label: "Latin Modern Roman", category: "tex", stack: `"Latin Modern Roman", KaTeX_Main, Georgia, serif`, note: "The LaTeX default" },
  { family: "STIX Two Text", label: "STIX Two Text", category: "tex", stack: serif("STIX Two Text"), note: "APS, AIP and Elsevier journals" },
  { family: "Libertinus Serif", label: "Libertinus Serif", category: "tex", stack: serif("Libertinus Serif"), note: "ACM publications" },
  { family: "TeX Gyre Termes", label: "TeX Gyre Termes", category: "tex", stack: `"TeX Gyre Termes", "Times New Roman", serif`, note: "Times, as in IEEE and Nature" },
  { family: "TeX Gyre Pagella", label: "TeX Gyre Pagella", category: "tex", stack: `"TeX Gyre Pagella", "Palatino Linotype", serif`, note: "Palatino for books and theses" },
  { family: "Latin Modern Mono", label: "Latin Modern Mono", category: "tex", stack: `"Latin Modern Mono", Consolas, monospace`, note: "LaTeX typewriter" },

  { family: "Source Serif 4", label: "Source Serif 4", category: "serif", stack: serif("Source Serif 4"), note: "Crisp on screen, superb in print" },
  { family: "EB Garamond", label: "EB Garamond", category: "serif", stack: serif("EB Garamond"), note: "Classic book Garamond" },
  { family: "Crimson Pro", label: "Crimson Pro", category: "serif", stack: serif("Crimson Pro"), note: "Elegant long-form reading" },
  { family: "Literata", label: "Literata", category: "serif", stack: serif("Literata"), note: "Designed for long reading" },
  { family: "Charis SIL", label: "Charis SIL", category: "serif", stack: serif("Charis SIL"), note: "Every Latin accent, very legible" },
  { family: "IBM Plex Serif", label: "IBM Plex Serif", category: "serif", stack: serif("IBM Plex Serif"), note: "Technical reports" },
  { family: "Playfair Display", label: "Playfair Display", category: "serif", stack: serif("Playfair Display"), note: "Titles and covers" },

  { family: "Inter", label: "Inter", category: "sans", stack: sans("Inter"), note: "Clean interface sans" },
  { family: "IBM Plex Sans", label: "IBM Plex Sans", category: "sans", stack: sans("IBM Plex Sans"), note: "Engineering documents" },
  { family: "Source Sans 3", label: "Source Sans 3", category: "sans", stack: sans("Source Sans 3"), note: "Neutral and readable" },
  { family: "Fira Sans", label: "Fira Sans", category: "sans", stack: sans("Fira Sans"), note: "Popular in Beamer slides" },
  { family: "Atkinson Hyperlegible", label: "Atkinson Hyperlegible", category: "sans", stack: sans("Atkinson Hyperlegible"), note: "Designed for low vision" },
  { family: "Montserrat", label: "Montserrat", category: "sans", stack: sans("Montserrat") },
  { family: "Poppins", label: "Poppins", category: "sans", stack: sans("Poppins") },
  { family: "Space Grotesk", label: "Space Grotesk", category: "sans", stack: sans("Space Grotesk") },

  { family: "JetBrains Mono", label: "JetBrains Mono", category: "mono", stack: mono("JetBrains Mono"), note: "Code, with clear 0/O and 1/l" },
  { family: "Fira Code", label: "Fira Code", category: "mono", stack: mono("Fira Code"), note: "Code with ligatures" },
  { family: "IBM Plex Mono", label: "IBM Plex Mono", category: "mono", stack: mono("IBM Plex Mono") },
  { family: "Source Code Pro", label: "Source Code Pro", category: "mono", stack: mono("Source Code Pro") },

  { family: "Times New Roman", label: "Times New Roman", category: "system", stack: `"Times New Roman", serif` },
  { family: "Georgia", label: "Georgia", category: "system", stack: "Georgia, serif" },
  { family: "Cambria", label: "Cambria", category: "system", stack: "Cambria, serif" },
  { family: "Calibri", label: "Calibri", category: "system", stack: "Calibri, sans-serif" },
  { family: "Arial", label: "Arial", category: "system", stack: "Arial, sans-serif" },
  { family: "Helvetica", label: "Helvetica", category: "system", stack: "Helvetica, Arial, sans-serif" },
  { family: "Verdana", label: "Verdana", category: "system", stack: "Verdana, sans-serif" },
  { family: "Courier New", label: "Courier New", category: "system", stack: `"Courier New", monospace` },
];

// The first family of a font-family value, unquoted - how the menu knows which entry is active.
export function primaryFamily(value: string | null | undefined): string | null {
  if (!value) return null;
  const first = value.split(",")[0]?.trim() ?? "";
  return first.replace(/^["']|["']$/g, "") || null;
}

// Word can't use web/bundled fonts it doesn't have: the .docx gets the first family of the stack
// that isn't an app-internal face, so a document set in "STIX Two Text" asks Word for STIX Two Text
// (installable, and substituted sensibly if not) rather than for a private "pdf-…" family.
export function wordFontFor(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  for (const part of value.split(",")) {
    const name = part.trim().replace(/^["']|["']$/g, "");
    if (!name || /^(pdf-|doc-|KaTeX_)/i.test(name) || /^(serif|sans-serif|monospace|cursive|fantasy)$/i.test(name)) continue;
    return name;
  }
  return undefined;
}

// ----------------------------------------------------------------------------------------------
// Fonts stored with a document

export interface DocFontFace {
  // CSS family name the face is registered under (unique per document).
  family: string;
  // What the menu shows: the font's own name ("Latin Modern Roman 10 Bold", "Avenir Next").
  label: string;
  // Absolute asset path of the font file inside the document folder.
  asset: string;
  weight: number;
  style: "normal" | "italic";
  origin: "upload" | "pdf";
  // The stack to apply: the face first, then a fallback chosen from its kind.
  stack: string;
}

const DOC_FONTS_KEY = "docFonts";

export function docFontsMap(ydoc: Y.Doc): Y.Map<DocFontFace> {
  return ydoc.getMap<DocFontFace>(DOC_FONTS_KEY);
}

// Registered FontFaces by family+asset, shared by every editor and preview in the window.
const registered = new Map<string, Promise<void>>();

export function registerDocFont(face: DocFontFace): Promise<void> {
  const key = `${face.family}|${face.asset}`;
  let pending = registered.get(key);
  if (!pending) {
    // Loaded from bytes, not a URL: the app's CSP has no font-src for document assets, and bytes
    // also work for a face added moments ago.
    pending = invoke<ArrayBuffer>("read_file_bytes", { path: face.asset })
      .then(async (bytes) => {
        const ff = new FontFace(face.family, bytes, { weight: String(face.weight), style: face.style });
        await ff.load();
        document.fonts.add(ff);
      })
      .catch((err) => {
        registered.delete(key);
        console.error(`Failed to load document font ${face.label}:`, err);
      });
    registered.set(key, pending);
  }
  return pending;
}

export function assetUrl(path: string): string {
  return convertFileSrc(path);
}

const FONT_EXTENSIONS = ["ttf", "otf", "woff", "woff2"];

// Reads a font file's own name and style from its name table (TrueType/OpenType). WOFF/WOFF2 are
// compressed containers, so they're named from the file name instead.
function describeFont(bytes: Uint8Array, fileName: string): { label: string; weight: number; style: "normal" | "italic"; kind: "serif" | "sans" | "mono" } {
  const otf = readOtf(bytes);
  const label = otf?.familyName && !/^\s*$/.test(otf.familyName) ? otf.postscriptName.replace(/-/g, " ") || otf.familyName : fileName.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ");
  const id = `${label} ${otf?.postscriptName ?? ""}`.toLowerCase();
  const weight = /black|heavy/.test(id) ? 900 : /extrabold|ultrabold/.test(id) ? 800 : /semibold|demibold/.test(id) ? 600 : /bold/.test(id) ? 700 : /medium/.test(id) ? 500 : /light/.test(id) ? 300 : 400;
  const style = /italic|oblique/.test(id) ? "italic" : "normal";
  const kind = /mono|code|courier|typewriter/.test(id) ? "mono" : /sans|grotesk|helvet|arial|gothic/.test(id) ? "sans" : "serif";
  return { label, weight, style, kind };
}

export function fallbackFor(kind: "serif" | "sans" | "mono"): string {
  return kind === "mono" ? "Consolas, monospace" : kind === "sans" ? "Arial, sans-serif" : "Georgia, serif";
}

// Adds font files the user picks to the document. Returns the faces added, already registered.
export async function addFontFilesToDocument(docId: string, ydoc: Y.Doc): Promise<DocFontFace[]> {
  const selected = await openFileDialog({ multiple: true, filters: [{ name: "Font", extensions: FONT_EXTENSIONS }] });
  if (!selected) return [];
  const paths = Array.isArray(selected) ? selected : [selected];
  const added: DocFontFace[] = [];
  for (const path of paths) {
    const fileName = path.split(/[\\/]/).pop() ?? "font";
    const ext = (fileName.split(".").pop() ?? "").toLowerCase();
    if (!FONT_EXTENSIONS.includes(ext)) continue;
    const bytes = new Uint8Array(await invoke<ArrayBuffer>("read_file_bytes", { path }));
    const meta = describeFont(bytes, fileName);
    const asset = await invoke<string>("save_doc_image", { id: docId, assetId: crypto.randomUUID(), extension: ext, bytes: Array.from(bytes) });
    // Faces of one family share a CSS family name, so bold/italic pick the right file.
    const familyLabel = meta.label.replace(/\s+(regular|bold|italic|oblique|medium|light|semibold|black|heavy|bold italic)+$/i, "").trim() || meta.label;
    const face: DocFontFace = {
      family: `doc-${familyLabel.replace(/[^A-Za-z0-9]+/g, "-").toLowerCase()}`,
      label: familyLabel,
      asset,
      weight: meta.weight,
      style: meta.style,
      origin: "upload",
      stack: "",
    };
    face.stack = `"${face.family}", ${fallbackFor(meta.kind)}`;
    docFontsMap(ydoc).set(`${face.family}|${face.weight}|${face.style}`, face);
    await registerDocFont(face);
    added.push(face);
  }
  return added;
}

// The document's fonts grouped into menu entries (one per family).
export function documentFontEntries(faces: DocFontFace[]): FontEntry[] {
  const byFamily = new Map<string, FontEntry>();
  for (const f of faces) {
    if (!byFamily.has(f.family)) {
      byFamily.set(f.family, { family: f.family, label: f.label, category: "document", stack: f.stack, note: f.origin === "pdf" ? "From the imported PDF" : "Added to this document" });
    }
  }
  return [...byFamily.values()].sort((a, b) => a.label.localeCompare(b.label));
}

// ----------------------------------------------------------------------------------------------
// The face text is actually set in

const GENERIC = /^(serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-serif|ui-sans-serif|ui-monospace|math)$/i;
const availability = new Map<string, boolean>();

// Whether a family can draw text here: a web/document face that has loaded, or an installed system
// font (told apart from the fallback by measuring - document.fonts.check() answers true for any
// family it has never heard of, so it can't say whether "Cambria" is installed).
export function isFontAvailable(family: string): boolean {
  if (GENERIC.test(family)) return true;
  const faces = [...document.fonts].filter((f) => f.family.replace(/^["']|["']$/g, "") === family);
  if (faces.length) return faces.some((f) => f.status === "loaded");
  const known = availability.get(family);
  if (known !== undefined) return known;
  const ctx = document.createElement("canvas").getContext("2d");
  let found = false;
  if (ctx) {
    const sample = "mmmmmmmmmlli1WQ@#&gyÅ";
    for (const fallback of ["monospace", "serif", "sans-serif"]) {
      ctx.font = `48px ${fallback}`;
      const base = ctx.measureText(sample).width;
      ctx.font = `48px "${family}", ${fallback}`;
      if (Math.abs(ctx.measureText(sample).width - base) > 0.5) {
        found = true;
        break;
      }
    }
  }
  availability.set(family, found);
  return found;
}

// The first family of a computed font-family stack that is really available - the face the text
// is drawn in.
export function renderedFamily(stack: string): string | null {
  for (const part of stack.split(",")) {
    const name = part.trim().replace(/^["']|["']$/g, "");
    if (name && isFontAvailable(name)) return name;
  }
  return null;
}

// What the toolbar calls a family: its library or document-font name, "Math" for KaTeX's faces,
// otherwise the family's own name.
export function fontLabelFor(family: string, docFonts: DocFontFace[]): string {
  if (/^KaTeX_/.test(family)) return "Math (KaTeX)";
  const generic: Record<string, string> = { serif: "Serif", "sans-serif": "Sans-serif", monospace: "Monospace" };
  return documentFontEntries(docFonts).find((f) => f.family === family)?.label ?? FONT_LIBRARY.find((f) => f.family === family)?.label ?? generic[family.toLowerCase()] ?? family;
}
