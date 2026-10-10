// utils/docNumbering.ts
//
// How a document names and numbers what it numbers. The default is the Docs/Word convention
// ("Figure 3.", "Table 1", "Eq. (2)"); journals have their own house style - APS prints captions
// as "FIG. 3." and "TABLE IV." while the running text says "Fig. 3" and "Table IV" - so an imported
// paper keeps the style it was typeset in, and every caption and cross-reference added later
// follows it. Stored in the Y.Doc's docSettings map ("numbering"); docStructure.ts applies it.

export type NumeralStyle = "arabic" | "upper-roman" | "lower-roman" | "upper-alpha" | "lower-alpha";

export interface LabelStyle {
  caption: string; // name in front of the caption's number: "Figure", "FIG."
  ref: string; // name in a cross-reference: "Figure", "Fig."
  numerals: NumeralStyle;
}

export interface NumberingStyle {
  figure: LabelStyle;
  table: LabelStyle;
  equation: { ref: string }; // "Eq." -> "Eq. (2)"
  // Between a caption's label and its text: "." gives "FIG. 3. Text", ":" gives "Figure 3: Text".
  captionSeparator: string;
  // Docs/Word set the caption label in bold; most journals (APS, Elsevier) don't.
  boldCaptionLabel: boolean;
  // Numbering within chapters, as theses and books do ("Figure 4.6", "(2.1)"): the heading level
  // that starts a chapter. null numbers straight through the document.
  chapterLevel: number | null;
}

export const DEFAULT_NUMBERING: NumberingStyle = {
  figure: { caption: "Figure", ref: "Figure", numerals: "arabic" },
  table: { caption: "Table", ref: "Table", numerals: "arabic" },
  equation: { ref: "Eq." },
  captionSeparator: ".",
  boldCaptionLabel: true,
  chapterLevel: null,
};

const NUMERALS: NumeralStyle[] = ["arabic", "upper-roman", "lower-roman", "upper-alpha", "lower-alpha"];

function readLabel(v: unknown, fallback: LabelStyle): LabelStyle {
  if (!v || typeof v !== "object") return fallback;
  const o = v as Record<string, unknown>;
  return {
    caption: typeof o.caption === "string" ? o.caption : fallback.caption,
    ref: typeof o.ref === "string" ? o.ref : fallback.ref,
    numerals: NUMERALS.includes(o.numerals as NumeralStyle) ? (o.numerals as NumeralStyle) : fallback.numerals,
  };
}

export function readNumbering(value: unknown): NumberingStyle {
  if (!value || typeof value !== "object") return DEFAULT_NUMBERING;
  const o = value as Record<string, unknown>;
  const eq = o.equation && typeof o.equation === "object" ? (o.equation as Record<string, unknown>) : {};
  return {
    figure: readLabel(o.figure, DEFAULT_NUMBERING.figure),
    table: readLabel(o.table, DEFAULT_NUMBERING.table),
    equation: { ref: typeof eq.ref === "string" ? eq.ref : DEFAULT_NUMBERING.equation.ref },
    captionSeparator: typeof o.captionSeparator === "string" ? o.captionSeparator : DEFAULT_NUMBERING.captionSeparator,
    boldCaptionLabel: typeof o.boldCaptionLabel === "boolean" ? o.boldCaptionLabel : DEFAULT_NUMBERING.boldCaptionLabel,
    chapterLevel: typeof o.chapterLevel === "number" && o.chapterLevel >= 1 && o.chapterLevel <= 4 ? o.chapterLevel : null,
  };
}

export function toRoman(n: number): string {
  if (n <= 0 || n >= 4000) return String(n);
  const table: [number, string][] = [
    [1000, "M"], [900, "CM"], [500, "D"], [400, "CD"], [100, "C"], [90, "XC"],
    [50, "L"], [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"],
  ];
  let out = "";
  for (const [v, s] of table) {
    while (n >= v) {
      out += s;
      n -= v;
    }
  }
  return out;
}

function toAlpha(n: number): string {
  let out = "";
  while (n > 0) {
    n--;
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26);
  }
  return out;
}

export function formatNumeral(n: number, style: NumeralStyle): string {
  switch (style) {
    case "upper-roman":
      return toRoman(n);
    case "lower-roman":
      return toRoman(n).toLowerCase();
    case "upper-alpha":
      return toAlpha(n);
    case "lower-alpha":
      return toAlpha(n).toLowerCase();
    default:
      return String(n);
  }
}

// Parses a numeral as printed back to its number - the PDF importer reads "TABLE IV" this way.
export function parseNumeral(text: string): { n: number; style: NumeralStyle } | null {
  if (/^\d+$/.test(text)) return { n: parseInt(text, 10), style: "arabic" };
  if (/^[IVXLCDM]+$/.test(text)) {
    const values: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
    let total = 0;
    for (let i = 0; i < text.length; i++) {
      const v = values[text[i]];
      const next = values[text[i + 1]] ?? 0;
      total += v < next ? -v : v;
    }
    return toRoman(total) === text ? { n: total, style: "upper-roman" } : null;
  }
  if (/^[ivxlcdm]+$/.test(text)) {
    const r = parseNumeral(text.toUpperCase());
    return r ? { n: r.n, style: "lower-roman" } : null;
  }
  return null;
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
};

// The number a chapter heading gives itself: "CHAPTER 1", "Chapter Four", "Part II", "APPENDIX A",
// "3 Methods", "3. Methods". null for an unnumbered heading ("References", "Acknowledgements").
export function chapterLabel(text: string): string | null {
  const t = text.trim();
  let m = t.match(/^(?:chapter|part)\s+(\d+|[ivxlc]+|[a-z]+)(?![\w])/i);
  if (m) {
    const v = m[1];
    if (/^\d+$/.test(v)) return String(parseInt(v, 10));
    const word = NUMBER_WORDS[v.toLowerCase()];
    if (word) return String(word);
    const roman = parseNumeral(v.toUpperCase());
    if (roman) return String(roman.n);
  }
  m = t.match(/^appendix\s+([A-Z])(?![a-z])/i);
  if (m) return m[1].toUpperCase();
  m = t.match(/^(\d+)\.?\s+\S/);
  if (m) return m[1];
  return null;
}
