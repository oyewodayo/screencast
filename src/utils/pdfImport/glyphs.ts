// utils/pdfImport/glyphs.ts
//
// From pdf.js text items to individual glyphs with exact geometry. pdf.js reports text as runs
// ("Wouthuysen (FW) procedure", "μν") positioned by their first character; the importer needs
// every character's pen position and true ink box - to tell a subscript from a fraction
// denominator, a limit from an exponent, an accent from a letter - so each run is split using
// the embedded font's own advance widths and CFF outline boxes (otf.ts).
//
// Coordinates here are top-down page points: x to the right, y downward from the page top,
// matching how the page is rendered and cropped.
import type { OtfFont } from "./otf";

export type FontRole =
  | "text" // running text (LMRoman, Times, Helvetica, ...)
  | "roman" // CMR/upright math roman - text in pure-CM documents, operators and digits in math
  | "mathItalic" // CMMI, math italic letters and Greek
  | "boldMathItalic" // CMMIB
  | "symbol" // CMSY: operators, relations, calligraphic capitals
  | "extension" // CMEX: big operators, radicals, stretchy delimiters
  | "blackboard" // MSBM
  | "fraktur" // EUFM
  | "mono"
  | "sans"
  // An OpenType math font (STIX Two Math, Latin Modern Math, Cambria Math, ...): one font for all
  // of maths, italic and script letters as Unicode math alphanumerics (𝑥, 𝒜), plain letters upright.
  | "unicodeMath";

export interface FontMeta {
  id: string; // pdf.js loaded name
  ps: string; // PostScript name without subset prefix: "LMRoman10-Bold", "CMMI9"
  role: FontRole;
  bold: boolean;
  italic: boolean;
  // CSS fallback stack used when the embedded subset lacks a character the user types later.
  fallback: string;
  otf: OtfFont | null;
  // What each reported character was drawn with: text -> the font characters (code points in the
  // embedded font's own map) seen for it in the page's drawing operations. One text can have several
  // (the size variants of a TeX delimiter all report "("). Filled by collectFontChars.
  fontChars?: Map<string, number[]>;
}

export function classifyFont(id: string, ps: string, otf: OtfFont | null, pdfjsBold = false, pdfjsItalic = false): FontMeta {
  const n = ps.replace(/^[A-Z]{6}\+/, "");
  const u = n.toUpperCase();
  let role: FontRole = "text";
  // Families: Computer/Latin Modern (CM*, LMMath*), txfonts/pxfonts (txmi, txsys, txex, ...),
  // newtx/newpx (NewTXMI, ntxsy, ...), MathTime (RMTM*), MinionMath (MNMI), STIX, the AMS fonts,
  // and OpenType math fonts.
  const compact = u.replace(/[\s_]/g, "");
  if (/^CMMIB|^LMMATHITALIC\d*-BOLD|BOLDMATHITALIC|^(NEWTX|NEWPX|NTX|NPX)BMI|^(TX|PX)BMIA?/.test(u)) role = "boldMathItalic";
  else if (/^CMMI|^LMMATHITALIC|MATHITALIC|^RMTMI|^MNMI|^(NEWTX|NEWPX|NTX|NPX)MI|^(TX|PX)MIA?|^ZXXMI|^ZPXMI/.test(u)) role = "mathItalic";
  else if (/^(TX|PX|NTX|NPX|NEWTX|NEWPX)B?SYB|^MSBM(?!EX)|^BBOLD|DOUBLESTRUCK/.test(u)) role = "blackboard";
  else if (/^(STIXTWOMATH|STIXMATH|LATINMODERNMATH|LMMATH-REGULAR|XITSMATH|XITS-MATH|CAMBRIAMATH|CAMBRIA-MATH|ASANA-?MATH|FIRAMATH|LIBERTINUSMATH|TEXGYRE\w*MATH|DEJAVUMATH|GARAMOND-?MATH|NEWCMMATH|NEWCOMPUTERMODERNMATH)/.test(compact)) role = "unicodeMath";
  else if (/^CMSY|^CMBSY|^LMMATHSYMBOLS|MATHSYMBOL|^MSAM|^RMTMS|^LCMSS?Y|^STIXGENERAL|^(TX|PX|NTX|NPX|NEWTX|NEWPX)B?SY[SAC]?\d*$|^(NTX|NEWTX|NEWPX)SY|SYMBOL/.test(u) && !/SYMBOLIC/.test(u)) role = "symbol";
  else if (/^CMEX|^LMMATHEXTENSION|MATHEXTENSION|^STIXSIZE|^MSBM?EX|^(TX|PX|NTX|NPX|NEWTX|NEWPX)B?EX|^ZXXEX|^ZPXEX/.test(u)) role = "extension";
  else if (/^EUFM|^EUFB|FRAKTUR/.test(u)) role = "fraktur";
  else if (/^CMR\d|^CMBX\d|^CMB\d|^CMTI\d|^CMSL\d|^CMSS?\d/.test(u)) role = "roman";
  else if (/^CMTT|^LMMONO|COURIER|CONSOL|MONO/.test(u)) role = "mono";
  else if (/HELVETICA|ARIAL|^LMSANS|^CMSS|NIMBUSSAN|SANS/.test(u)) role = "sans";
  const bold = pdfjsBold || /BOLD|-BD|BLACK|HEAVY|SEMIBOLD|DEMI|MEDI(UM)?\b|^CMBX|^CMB\d|^CMMIB|^CMBSY|-B$/.test(u);
  const italic = pdfjsItalic || /ITALIC|OBLIQUE|-IT\b|-IT$|SLANT|^CMTI|^CMSL|^CMMI|^LMMATHITALIC|-I$/.test(u);
  const fallback =
    role === "mono"
      ? "'Cascadia Mono', Consolas, monospace"
      : role === "sans"
        ? "Arial, 'Segoe UI', sans-serif"
        : /TIMES|NIMBUSROM|TERMES|STIX|TINOS/.test(u)
          ? "'Times New Roman', Times, serif"
          : role === "mathItalic" || role === "boldMathItalic" || role === "unicodeMath"
            ? "KaTeX_Math, 'Latin Modern Math', serif"
            : // LaTeX's Computer Modern / Latin Modern and anything unknown: KaTeX ships the same design.
              "KaTeX_Main, 'Latin Modern Roman', 'CMU Serif', Georgia, serif";
  return { id, ps: n, role, bold, italic, fallback, otf };
}

export interface Glyph {
  ch: string;
  font: FontMeta;
  size: number; // font size in pt (vertical scale)
  base: number; // baseline y
  // Pen positions (advance box) - what word spacing and adjacency are measured on.
  x: number;
  adv: number;
  // True ink box from the glyph outline (falls back to an em-box estimate).
  x0: number;
  x1: number;
  top: number;
  bottom: number;
  space: boolean;
  item: number; // source pdf.js item index, for run grouping
}

// The macro letters that exist under two code points: a font often maps only one of them.
const ALTERNATES: Record<string, string[]> = {
  "μ": ["µ"],
  "µ": ["μ"],
  "ε": ["ϵ"],
  "ϵ": ["ε"],
  "φ": ["ϕ"],
  "ϕ": ["φ"],
  "θ": ["ϑ"],
  "−": ["-"],
  "′": ["'"],
};

// Every glyph the font could have drawn for a reported character: the ones the page's drawing
// operations used for it (exact), else the font's own character map.
export function glyphCandidates(font: FontMeta, ch: string): number[] {
  const otf = font.otf;
  if (!otf) return [];
  const drawn = font.fontChars?.get(ch);
  if (drawn?.length) {
    const gids = [...new Set(drawn.map((cp) => otf.glyphId(cp)).filter((g) => g > 0))];
    if (gids.length) return gids;
  }
  const g = glyphIdFor(otf, ch);
  return g ? [g] : [];
}

export function glyphIdFor(otf: OtfFont, ch: string): number {
  const cp = ch.codePointAt(0)!;
  const gid = otf.glyphId(cp);
  if (gid) return gid;
  for (const alt of ALTERNATES[ch] ?? []) {
    const g = otf.glyphId(alt.codePointAt(0)!);
    if (g) return g;
  }
  return 0;
}

// TeX's symbol and extension fonts put symbols at ASCII code points. When a PDF has no
// ToUnicode entry for a glyph (common for CMEX's delimiter pieces), pdf.js reports the raw code -
// "y" for the bottom of a big downward arrow. These tables restore the symbol.
const CMSY_CODES: Record<string, string> = {
  "0": "′", "1": "∞", "2": "∈", "3": "∋", "4": "△", "5": "▽", "8": "∀", "9": "∃",
  b: "⌊", c: "⌋", d: "⌈", e: "⌉", f: "{", g: "}", h: "⟨", i: "⟩", j: "|", k: "‖", l: "↕", m: "⇕", n: "\\", o: "≀",
  p: "√", q: "⨿", r: "∇", s: "∫", t: "⊔", u: "⊓", v: "⊑", w: "⊒", x: "§", y: "†", z: "‡",
};
const CMEX_CODES: Record<string, string> = {
  P: "∑", Q: "∏", R: "∫", S: "⋃", T: "⋂", V: "⋀", W: "⋁", X: "∑", Y: "∏", Z: "∫",
  p: "√", q: "√", r: "√", s: "√", t: "√", x: "↑", y: "↓", "?": "↕",
};

// TeX's glyph names -> the symbol, whatever size variant ("summationdisplay", "parenleftBig",
// "summationtext.1"). Extension pieces (braceex, bracelefttp, ...) aren't symbols of their own.
const GLYPH_NAMES: [RegExp, string][] = [
  [/^summation/, "∑"], [/^product/, "∏"], [/^coproduct/, "∐"], [/^contintegral/, "∮"], [/^integral/, "∫"],
  [/^union/, "⋃"], [/^intersection/, "⋂"], [/^circleplus/, "⨁"], [/^circlemultiply/, "⨂"], [/^circledot/, "⨀"],
  [/^logicaland/, "⋀"], [/^logicalor/, "⋁"], [/^radical/, "√"],
  [/^parenleft/, "("], [/^parenright/, ")"], [/^bracketleft/, "["], [/^bracketright/, "]"], [/^braceleft/, "{"], [/^braceright/, "}"],
  [/^angleleft/, "⟨"], [/^angleright/, "⟩"], [/^floorleft/, "⌊"], [/^floorright/, "⌋"], [/^ceilingleft/, "⌈"], [/^ceilingright/, "⌉"],
  [/^slash/, "/"], [/^backslash/, "\\"], [/^bardbl/, "‖"], [/^bar/, "|"], [/^uparrow/, "↑"], [/^downarrow/, "↓"], [/^hat/, "ˆ"], [/^tilde/, "˜"],
];

export function symbolForGlyphName(name: string | null): string | null {
  if (!name || /(ex|tp|bt|mid)(\.\d+)?$/.test(name)) return null;
  for (const [re, ch] of GLYPH_NAMES) if (re.test(name)) return ch;
  return null;
}

// Pairs every reported character with the font character drawn for it, from a page's operator
// list (pdf.js's setFont / showText family; ops are its OPS constants).
export function collectFontChars(
  opList: { fnArray: number[]; argsArray: unknown[] },
  ops: { setFont: number; showText: number; showSpacedText: number; nextLineShowText: number; nextLineSetSpacingShowText: number }
): Map<string, Map<string, number[]>> {
  const out = new Map<string, Map<string, number[]>>();
  let font = "";
  opList.fnArray.forEach((fn, k) => {
    const args = opList.argsArray[k] as unknown[];
    if (fn === ops.setFont) font = String(args?.[0] ?? "");
    else if (fn === ops.showText || fn === ops.showSpacedText || fn === ops.nextLineShowText || fn === ops.nextLineSetSpacingShowText) {
      const glyphs = (fn === ops.nextLineSetSpacingShowText ? args[2] : args[0]) as unknown[];
      if (!Array.isArray(glyphs)) return;
      let map = out.get(font);
      if (!map) out.set(font, (map = new Map()));
      for (const g of glyphs) {
        const gl = g as { unicode?: string; fontChar?: string } | null;
        if (!gl || typeof gl !== "object" || !gl.unicode || !gl.fontChar) continue;
        const cp = gl.fontChar.codePointAt(0)!;
        const list = map.get(gl.unicode) ?? [];
        if (!list.includes(cp)) list.push(cp);
        map.set(gl.unicode, list);
      }
    }
  });
  return out;
}

function restoreSymbol(ch: string, role: FontRole): string {
  if (ch.length !== 1 || ch.charCodeAt(0) > 0x7e) return ch;
  if (role === "extension") return CMEX_CODES[ch] ?? ch;
  if (role === "symbol" && !/[A-Z]/.test(ch)) return CMSY_CODES[ch] ?? ch;
  return ch;
}

export interface RawTextItem {
  str: string;
  transform: number[];
  width: number;
  fontName: string;
}

// Splits text items into glyphs. Rotated runs (axis labels in figures, sideways tables) are kept
// as glyphs flagged by a zero-size advance so they still mask ink but never form text lines.
export function extractGlyphs(items: RawTextItem[], fonts: Map<string, FontMeta>, pageHeight: number): Glyph[] {
  const out: Glyph[] = [];
  items.forEach((item, index) => {
    if (!item.str) return;
    const [a, b, c, d, e, f] = item.transform;
    const font = fonts.get(item.fontName);
    if (!font) return;
    const size = Math.hypot(c, d);
    const hscale = Math.hypot(a, b);
    if (size < 0.5) return;
    const rotated = Math.abs(b) > 0.1 * Math.abs(a) || a < 0;
    const chars = Array.from(item.str);
    const otf = font.otf;
    const upm = otf?.unitsPerEm ?? 1000;
    const candidates = chars.map((ch) => glyphCandidates(font, ch));
    const gids = candidates.map((c) => c[0] ?? 0);
    // TeX's extension font has several sizes of each delimiter and radical, all mapped to the same
    // character; the character map names one of them (usually the biggest). When the run's width
    // says otherwise, the glyph actually drawn is the variant whose advance matches it.
    if (otf && chars.length === 1 && gids[0] && item.width > 0) {
      const target = (item.width / hscale) * upm;
      // The glyphs actually drawn for this text first: pick the one whose width fits.
      if (candidates[0].length > 1) gids[0] = candidates[0].reduce((best, g) => (Math.abs(otf.advance(g) - target) < Math.abs(otf.advance(best) - target) ? g : best), candidates[0][0]);
      const current = otf.advance(gids[0]);
      if (Math.abs(current - target) > 0.08 * target) {
        let best = gids[0];
        let bestDiff = Math.abs(current - target);
        for (const gid of otf.glyphIds()) {
          const d = Math.abs(otf.advance(gid) - target);
          if (d < bestDiff - 1e-6) {
            bestDiff = d;
            best = gid;
          }
        }
        if (bestDiff < 0.03 * target) gids[0] = best;
      }
    }
    const natural = chars.map((ch, k) => (otf && gids[k] ? (otf.advance(gids[k]) / upm) * hscale : ch === " " ? 0.3 * hscale : 0.5 * hscale));
    const naturalSum = natural.reduce((s, v) => s + v, 0);
    // Character and word spacing (Tc/Tw) make the run wider than its advances: spread the
    // difference over the spaces when there are any (word spacing), otherwise evenly (tracking).
    const extra = item.width - naturalSum;
    const spaces = chars.filter((ch) => ch === " ").length;
    let pen = e;
    const base = pageHeight - f;
    // Word spacing goes to the spaces - unless it would make a space narrower than a fifth of its
    // natural width (a negative kern in "DATA AVAILABILITY"), when it spreads over every glyph.
    const spaceNatural = chars.reduce((sum, ch, k) => sum + (ch === " " ? natural[k] : 0), 0);
    const toSpaces = spaces > 0 && spaceNatural + extra > 0.2 * spaceNatural;
    chars.forEach((ch, k) => {
      let adv = natural[k];
      if (Math.abs(extra) > 0.05) adv += toSpaces ? (ch === " " ? extra / spaces : 0) : (extra * natural[k]) / Math.max(naturalSum, 1e-6);
      const isSpace = /\s/.test(ch);
      const box = otf && gids[k] ? otf.box(gids[k]) : null;
      let x0 = pen;
      let x1 = pen + adv;
      let top = base - 0.7 * size;
      let bottom = base + 0.2 * size;
      if (box) {
        x0 = pen + (box.xMin / upm) * hscale;
        x1 = pen + (box.xMax / upm) * hscale;
        top = base - (box.yMax / upm) * size;
        bottom = base - (box.yMin / upm) * size;
      }
      if (rotated) {
        // Approximate an axis-aligned box for the rotated run's character.
        const len = adv;
        const cos = a / hscale;
        const sin = b / hscale;
        const px = pen - e;
        const gx = e + px * cos;
        const gy = base - px * sin;
        x0 = Math.min(gx, gx + len * cos) - 0.1 * size;
        x1 = Math.max(gx, gx + len * cos) + 0.8 * size * Math.abs(sin);
        top = Math.min(gy, gy - len * sin) - 0.8 * size;
        bottom = Math.max(gy, gy - len * sin) + 0.2 * size;
      }
      // In maths fonts the glyph's own name decides when it names a symbol: the text layer of TeX's
      // extension fonts often reports a stand-in character ("’" for a summation sign).
      const named = otf && gids[k] && font.role !== "text" && font.role !== "roman" ? symbolForGlyphName(otf.glyphName(gids[k])) : null;
      out.push({ ch: named ?? restoreSymbol(ch, font.role), font, size, base, x: rotated ? x0 : pen, adv: rotated ? 0 : adv, x0, x1, top, bottom, space: isSpace || rotated, item: index });
      pen += adv;
    });
  });
  return out;
}

// A glyph that is maths whatever font it comes in: Unicode's mathematical alphanumerics (𝑥, 𝛼, 𝒜,
// 𝔸) - what unicode-math (XeLaTeX/LuaLaTeX), newtx's text layer and Word's equations produce.
export function isMathAlphanumeric(ch: string): boolean {
  const cp = ch.codePointAt(0) ?? 0;
  return cp >= 0x1d400 && cp <= 0x1d7ff;
}
