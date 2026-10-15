// utils/pdfImport/fonts.ts
//
// Which font an imported run is set in. A PDF embeds only the glyphs it used (a subset), so text
// typed later would fall back to another face; when the PDF's font is one Docs ships complete -
// Latin Modern (LaTeX's default), TeX Gyre Termes/Pagella, STIX Two, Libertinus - the bundled
// full font is used, in the same design. Anything else uses the PDF's own embedded face, stored
// with the document, with a fallback chosen from its kind.
import { FONT_LIBRARY } from "../docFonts";
import type { FontMeta } from "./glyphs";

const BUNDLED: { test: RegExp; family: string }[] = [
  { test: /^(LMROMAN|LMRoman|CMR\d|CMBX|CMTI|CMSL|CMCSC|SFRM|SFBX|SFTI|SFSL|SFCC|EC-?L?M?R|LMRomanCaps|LMRomanSlant|LMRomanDemi|LMRomanUnsl)/i, family: "Latin Modern Roman" },
  { test: /^(LMMONO|LMMono|CMTT|SFTT|LMMonoLt|LMMonoProp)/i, family: "Latin Modern Mono" },
  { test: /^(TEXGYRETERMES|TeXGyreTermes|NIMBUSROM|NimbusRomNo9L|NimbusRoman|Times|TimesNewRoman|Tinos|Termes|txr|ptmr|utmr)/i, family: "TeX Gyre Termes" },
  { test: /^(TEXGYREPAGELLA|TeXGyrePagella|Palatino|URWPalladio|Pagella|pplr|uplr|PalatinoLinotype)/i, family: "TeX Gyre Pagella" },
  { test: /^(STIXTwoText|STIXTWO|STIXGeneral|STIX-)/i, family: "STIX Two Text" },
  { test: /^(Libertinus|LinLibertine|LinuxLibertine)/i, family: "Libertinus Serif" },
  { test: /^(SourceSerif)/i, family: "Source Serif 4" },
  { test: /^(EBGaramond|Garamond)/i, family: "EB Garamond" },
  { test: /^(Charis|CharisSIL)/i, family: "Charis SIL" },
  { test: /^(IBMPlexSerif)/i, family: "IBM Plex Serif" },
  { test: /^(IBMPlexSans)/i, family: "IBM Plex Sans" },
  { test: /^(IBMPlexMono)/i, family: "IBM Plex Mono" },
  { test: /^(Inter-|Inter$)/i, family: "Inter" },
  { test: /^(FiraSans)/i, family: "Fira Sans" },
  { test: /^(SourceSans)/i, family: "Source Sans 3" },
  { test: /^(SourceCodePro)/i, family: "Source Code Pro" },
  { test: /^(Arial|Helvetica|NimbusSan|LiberationSans|Arimo)/i, family: "Arial" },
  { test: /^(Calibri|Carlito)/i, family: "Calibri" },
  { test: /^(Cambria|Caladea)/i, family: "Cambria" },
  { test: /^(Georgia)/i, family: "Georgia" },
  { test: /^(Courier|NimbusMono|LiberationMono|Cousine)/i, family: "Courier New" },
];

// The library font that is the PDF font's design, or null.
export function bundledFamily(ps: string): string | null {
  const name = ps.replace(/^[A-Z]{6}\+/, "");
  return BUNDLED.find((b) => b.test.test(name))?.family ?? null;
}

export function libraryStack(family: string): string | null {
  return FONT_LIBRARY.find((f) => f.family === family)?.stack ?? null;
}

// A PDF face's family name for registering it: style words dropped so bold and italic faces of one
// family share it ("MinionPro-BoldIt" -> "MinionPro").
export function embeddedFamilyName(ps: string): string {
  const name = ps.replace(/^[A-Z]{6}\+/, "");
  const base = name.split(/[-,]/)[0].replace(/(Bold|Italic|Oblique|Regular|Roman|Medium|Light|Semibold|Black|BoldItalic|It|Bd|BdIt)+$/i, "") || name;
  return `pdf-${base.replace(/[^A-Za-z0-9]+/g, "-").toLowerCase()}`;
}

export function embeddedLabel(ps: string): string {
  const name = ps.replace(/^[A-Z]{6}\+/, "").split(/[-,]/)[0];
  return name.replace(/([a-z])([A-Z])/g, "$1 $2");
}

export function isMathFont(font: FontMeta): boolean {
  return font.role !== "text" && font.role !== "roman" && font.role !== "mono" && font.role !== "sans";
}
