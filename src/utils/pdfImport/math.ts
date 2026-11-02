// utils/pdfImport/math.ts
//
// Typeset math back to LaTeX. A PDF stores an equation as glyphs at positions and a few rules -
// a fraction is a numerator above a bar above a denominator, an exponent is a smaller glyph raised
// beside its base, a summation's limits are glyphs stacked over and under it. This module rebuilds
// the structure from that geometry, the way a reader does: rules become fractions or radicals,
// stacked glyphs become limits, raised and lowered ones become scripts, accents attach to what
// they sit on, oversized delimiters pair into \left…\right, and the fonts say what each glyph
// means (math italic, upright roman, calligraphic, blackboard, bold).
//
// Every glyph must find a place; any that doesn't lowers the confidence, and the importer then
// keeps an exact image of the equation instead of a wrong formula.
import type { Glyph } from "./glyphs";

export interface Bar {
  x0: number;
  x1: number;
  y: number;
  thickness: number;
}

export interface MathResult {
  latex: string;
  confidence: number; // 0..1
  unplaced: number;
}

// ---------------------------------------------------------------------------------------------
// Glyph -> LaTeX token

const GREEK: Record<string, string> = {
  α: "\\alpha", β: "\\beta", γ: "\\gamma", δ: "\\delta", ε: "\\varepsilon", ϵ: "\\epsilon", ζ: "\\zeta", η: "\\eta", θ: "\\theta", ϑ: "\\vartheta",
  ι: "\\iota", κ: "\\kappa", λ: "\\lambda", μ: "\\mu", µ: "\\mu", ν: "\\nu", ξ: "\\xi", π: "\\pi", ϖ: "\\varpi", ρ: "\\rho", ϱ: "\\varrho", σ: "\\sigma",
  ς: "\\varsigma", τ: "\\tau", υ: "\\upsilon", φ: "\\varphi", ϕ: "\\phi", χ: "\\chi", ψ: "\\psi", ω: "\\omega",
  Γ: "\\Gamma", Δ: "\\Delta", "∆": "\\Delta", Θ: "\\Theta", Λ: "\\Lambda", Ξ: "\\Xi", Π: "\\Pi", Σ: "\\Sigma", Υ: "\\Upsilon", Φ: "\\Phi", Ψ: "\\Psi", Ω: "\\Omega",
};

const SYMBOLS: Record<string, string> = {
  "★": "\star", "☆": "\star",
  "−": "-", "∓": "\\mp", "±": "\\pm", "×": "\\times", "÷": "\\div", "·": "\\cdot", "⋅": "\\cdot", "∗": "\\ast", "⋆": "\\star", "∘": "\\circ", "◦": "\\circ", "•": "\\bullet",
  "≤": "\\le", "≥": "\\ge", "≪": "\\ll", "≫": "\\gg", "≠": "\\ne", "≡": "\\equiv", "≃": "\\simeq", "≈": "\\approx", "∼": "\\sim", "≅": "\\cong", "∝": "\\propto", "≍": "\\asymp",
  "⪯": "\\preceq", "⪰": "\\succeq", "≺": "\\prec", "≻": "\\succ",
  "→": "\\to", "←": "\\leftarrow", "↔": "\\leftrightarrow", "⇒": "\\Rightarrow", "⇐": "\\Leftarrow", "⇔": "\\Leftrightarrow", "⟹": "\\Longrightarrow", "⟸": "\\Longleftarrow", "⟺": "\\Longleftrightarrow",
  "↑": "\\uparrow", "↓": "\\downarrow", "↕": "\\updownarrow", "⇑": "\\Uparrow", "⇓": "\\Downarrow", "↦": "\\mapsto", "⟶": "\\longrightarrow", "⟵": "\\longleftarrow",
  "∞": "\\infty", "∂": "\\partial", "∇": "\\nabla", "ℏ": "\\hbar", "ℓ": "\\ell", "℘": "\\wp", "ℜ": "\\Re", "ℑ": "\\Im", "ℵ": "\\aleph", "∅": "\\emptyset", "∀": "\\forall", "∃": "\\exists", "¬": "\\neg",
  "∈": "\\in", "∉": "\\notin", "∋": "\\ni", "⊂": "\\subset", "⊃": "\\supset", "⊆": "\\subseteq", "⊇": "\\supseteq", "∪": "\\cup", "∩": "\\cap", "∧": "\\wedge", "∨": "\\vee", "⊕": "\\oplus", "⊗": "\\otimes", "⊙": "\\odot", "⊥": "\\perp", "∥": "\\parallel",
  "⟨": "\\langle", "⟩": "\\rangle", "〈": "\\langle", "〉": "\\rangle", "⌊": "\\lfloor", "⌋": "\\rfloor", "⌈": "\\lceil", "⌉": "\\rceil", "‖": "\\|", "†": "\\dagger", "‡": "\\ddagger", "′": "'", "″": "''",
  "…": "\\ldots", "⋯": "\\cdots", "⋮": "\\vdots", "⋱": "\\ddots", "√": "\\sqrt", "∑": "\\sum", "∏": "\\prod", "∐": "\\coprod", "∫": "\\int", "∬": "\\iint", "∭": "\\iiint", "∮": "\\oint", "⋃": "\\bigcup", "⋂": "\\bigcap",
  "{": "\\{", "}": "\\}", "%": "\\%", "#": "\\#", "&": "\\&", "_": "\\_", "$": "\\$", "\\": "\\backslash", "|": "|", "§": "\\S",
};

const BIG_OPS = new Set(["∑", "∏", "∐", "⋃", "⋂", "⋀", "⋁", "⨁", "⨂", "⨀"]);
const INTEGRALS = new Set(["∫", "∬", "∭", "∮"]);
const OPEN = new Set(["(", "[", "{", "⟨", "〈", "⌊", "⌈", "|", "‖"]);
const CLOSE = new Set([")", "]", "}", "⟩", "〉", "⌋", "⌉", "|", "‖"]);
const DELIM_PIECES: Record<string, string> = { "⎛": "(", "⎜": "(", "⎝": "(", "⎞": ")", "⎟": ")", "⎠": ")", "⎡": "[", "⎢": "[", "⎣": "[", "⎤": "]", "⎥": "]", "⎦": "]", "⎧": "{", "⎨": "{", "⎩": "{", "⎪": "{", "⎫": "}", "⎬": "}", "⎭": "}" };
const ACCENTS: Record<string, string> = {
  "¯": "\\bar", "ˉ": "\\bar", "‾": "\\overline", "ˆ": "\\hat", "^": "\\hat", "˜": "\\tilde", "~": "\\tilde", "˙": "\\dot", "¨": "\\ddot", "ˇ": "\\check", "´": "\\acute", "`": "\\grave", "˘": "\\breve", "⃗": "\\vec", "→": "\\vec", "^̂": "\\hat",
};
const FUNCTIONS = new Set(["ln", "log", "exp", "sin", "cos", "tan", "cot", "sec", "csc", "sinh", "cosh", "tanh", "arcsin", "arccos", "arctan", "max", "min", "sup", "inf", "lim", "det", "arg", "deg", "dim", "ker", "gcd", "Pr", "hom"]);
const LIMIT_FUNCTIONS = new Set(["max", "min", "sup", "inf", "lim", "det", "Pr", "liminf", "limsup"]);

const isLatinLetter = (c: string) => /^[A-Za-z]$/.test(c);

function styledLetter(g: Glyph): { tex: string; kind: "letter" | "upright" | "symbol" | "text" } {
  const c = g.ch;
  const role = g.font.role;
  if (GREEK[c]) {
    const tex = GREEK[c];
    if (role === "boldMathItalic" || (g.font.bold && role !== "text")) return { tex: `\\boldsymbol{${tex}}`, kind: "letter" };
    return { tex, kind: "letter" };
  }
  if (isLatinLetter(c)) {
    if (role === "symbol" && /[A-Z]/.test(c)) return { tex: `\\mathcal{${c}}`, kind: "letter" };
    if (role === "blackboard") return { tex: `\\mathbb{${c}}`, kind: "letter" };
    if (role === "fraktur") return { tex: `\\mathfrak{${c}}`, kind: "letter" };
    if (role === "boldMathItalic") return { tex: `\\boldsymbol{${c}}`, kind: "letter" };
    if (role === "roman" && g.font.bold) return { tex: `\\mathbf{${c}}`, kind: "letter" };
    if (role === "mathItalic") return { tex: c, kind: "letter" };
    // A bold upright letter in a formula is a vector (v, r): \mathbf, not text.
    if ((role === "text" || role === "sans") && g.font.bold && !g.font.italic) return { tex: `\\mathbf{${c}}`, kind: "letter" };
    if (role === "text" || role === "sans" || role === "mono") return { tex: c, kind: g.font.italic ? "letter" : "text" };
    return { tex: c, kind: "upright" };
  }
  if (/^[0-9]$/.test(c)) return { tex: g.font.bold && role !== "text" ? `\\mathbf{${c}}` : c, kind: "symbol" };
  const mapped = SYMBOLS[c];
  if (mapped !== undefined) return { tex: mapped, kind: "symbol" };
  if (/^[+=<>!?,.;:'/()[\]*@-]$/.test(c)) return { tex: c, kind: "symbol" };
  // Mathematical alphanumerics (Word/Cambria Math PDFs): 𝑥, 𝒙, 𝔸 ...
  const cp = c.codePointAt(0)!;
  if (cp >= 0x1d400 && cp <= 0x1d7ff) {
    const base = c.normalize("NFKC");
    if (/^[A-Za-z0-9]$/.test(base)) {
      const offset = cp - 0x1d400;
      const style = Math.floor(offset / 52);
      if (style === 0) return { tex: `\\mathbf{${base}}`, kind: "letter" };
      if (style === 1) return { tex: base, kind: "letter" };
      if (style === 2) return { tex: `\\boldsymbol{${base}}`, kind: "letter" };
      if (style === 3 || style === 4) return { tex: `\\mathcal{${base}}`, kind: "letter" };
      if (style === 6) return { tex: `\\mathbb{${base}}`, kind: "letter" };
      return { tex: base, kind: "letter" };
    }
    if (GREEK[base]) {
      // Bold, bold italic and sans-serif bold Greek (𝝈, 𝛔, 𝞂) are bold symbols.
      const bold = (cp >= 0x1d6a8 && cp <= 0x1d6e1) || (cp >= 0x1d71c && cp <= 0x1d755) || cp >= 0x1d756;
      return { tex: bold || g.font.role === "boldMathItalic" ? `\\boldsymbol{${GREEK[base]}}` : GREEK[base], kind: "letter" };
    }
    // Styled symbols: the math-italic partial (𝜕), nabla (𝛁), ...
    if (SYMBOLS[base] !== undefined) return { tex: SYMBOLS[base], kind: "symbol" };
  }
  return { tex: `\\text{${c}}`, kind: "symbol" };
}

// ---------------------------------------------------------------------------------------------
// Atoms

interface Atom {
  x0: number;
  x1: number;
  top: number;
  bottom: number;
  base: number;
  size: number;
  latex: string;
  kind: "glyph" | "frac" | "sqrt" | "op" | "accent" | "delim" | "group";
  glyph?: Glyph;
  // For glyph atoms: classification used when joining tokens.
  token?: { tex: string; kind: "letter" | "upright" | "symbol" | "text" };
  big?: boolean; // oversized delimiter or operator
  limits?: boolean; // operator that takes stacked limits
}

const glyphAtom = (g: Glyph): Atom => ({
  x0: g.x,
  x1: g.x + g.adv,
  top: g.top,
  bottom: g.bottom,
  base: g.base,
  size: g.size,
  latex: "",
  kind: "glyph",
  glyph: g,
  token: styledLetter(g),
});

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

const cx = (a: { x0: number; x1: number }) => (a.x0 + a.x1) / 2;
const cy = (a: { top: number; bottom: number }) => (a.top + a.bottom) / 2;

class Parser {
  unplaced = 0;

  // The latex for a set of atoms that form one horizontal list (possibly with rows).
  parse(atoms: Atom[], bars: Bar[], depth = 0): string {
    if (atoms.length === 0) return "";
    if (depth > 12) {
      this.unplaced += atoms.length;
      return "";
    }
    let work = this.mergeDelimiterPieces(atoms);
    work = this.radicals(work, bars, depth);
    work = this.fractions(work, bars, depth);
    work = this.accents(work, depth);
    work = this.limits(work, depth);
    const rows = this.rows(work);
    if (rows.length > 1) {
      const rendered = rows.map((r) => this.line(r, depth));
      return `\\begin{gathered}${rendered.join(" \\\\ ")}\\end{gathered}`;
    }
    return this.line(work, depth);
  }

  // CMEX builds tall delimiters from pieces stacked at one x: join them into one atom.
  private mergeDelimiterPieces(atoms: Atom[]): Atom[] {
    const out: Atom[] = [];
    const pieces = atoms.filter((a) => a.glyph && DELIM_PIECES[a.glyph.ch]);
    const used = new Set<Atom>();
    for (const p of pieces) {
      if (used.has(p)) continue;
      const stack = pieces.filter((q) => !used.has(q) && Math.abs(q.x0 - p.x0) < 0.6 && DELIM_PIECES[q.glyph!.ch] === DELIM_PIECES[p.glyph!.ch]);
      stack.forEach((q) => used.add(q));
      const ch = DELIM_PIECES[p.glyph!.ch];
      out.push({
        x0: Math.min(...stack.map((q) => q.x0)),
        x1: Math.max(...stack.map((q) => q.x1)),
        top: Math.min(...stack.map((q) => q.top)),
        bottom: Math.max(...stack.map((q) => q.bottom)),
        base: median(stack.map((q) => q.base)),
        size: p.size,
        latex: ch,
        kind: "delim",
        big: true,
        glyph: { ...p.glyph!, ch },
      });
    }
    return [...atoms.filter((a) => !used.has(a)), ...out];
  }

  private radicals(atoms: Atom[], bars: Bar[], depth: number): Atom[] {
    let work = atoms;
    for (const rad of atoms.filter((a) => a.glyph?.ch === "√")) {
      if (!work.includes(rad)) continue;
      // Its overbar starts at the sign's top right.
      const bar = bars.find((b) => Math.abs(b.x0 - rad.x1) < 1.2 + 0.1 * rad.size && Math.abs(b.y - rad.top) < 0.25 * rad.size + 1);
      let content: Atom[];
      if (bar) {
        content = work.filter((a) => a !== rad && cx(a) > bar.x0 && cx(a) < bar.x1 && a.top >= bar.y - 0.5);
        bars.splice(bars.indexOf(bar), 1);
      } else {
        const next = work.filter((a) => a !== rad && a.x0 >= rad.x1 - 0.5).sort((a, b) => a.x0 - b.x0)[0];
        content = next ? [next] : [];
      }
      const index = work.filter((a) => a !== rad && !content.includes(a) && a.x1 <= rad.x0 + 0.45 * rad.size && a.x1 > rad.x0 - 0.6 * rad.size && a.bottom < (rad.top + rad.bottom) / 2 && a.size < rad.size * 0.85);
      const innerBars = bars.filter((b) => b.x0 >= (bar?.x0 ?? rad.x1) - 0.5 && b.x1 <= (bar?.x1 ?? rad.x1 + 100) + 0.5 && b.y > (bar?.y ?? rad.top));
      const body = this.parse(content, innerBars, depth + 1);
      const idx = index.length ? `[${this.parse(index, [], depth + 1)}]` : "";
      const x1 = bar ? bar.x1 : Math.max(rad.x1, ...content.map((a) => a.x1));
      const atom: Atom = {
        x0: Math.min(rad.x0, ...index.map((a) => a.x0)),
        x1,
        top: Math.min(rad.top, ...content.map((a) => a.top)),
        bottom: Math.max(rad.bottom, ...content.map((a) => a.bottom)),
        base: content.length ? median(content.map((a) => a.base)) : rad.base,
        size: Math.max(...content.map((a) => a.size), rad.size * 0.8),
        latex: `\\sqrt${idx}{${body}}`,
        kind: "sqrt",
      };
      work = [...work.filter((a) => a !== rad && !content.includes(a) && !index.includes(a)), atom];
    }
    return work;
  }

  private fractions(atoms: Atom[], bars: Bar[], depth: number): Atom[] {
    let work = atoms;
    // Widest first: an outer fraction's bar spans its inner ones.
    const sorted = [...bars].sort((a, b) => b.x1 - b.x0 - (a.x1 - a.x0));
    const done = new Set<Bar>();
    for (const bar of sorted) {
      if (done.has(bar)) continue;
      const inSpan = (a: Atom) => cx(a) > bar.x0 - 0.5 && cx(a) < bar.x1 + 0.5;
      const above = work.filter((a) => inSpan(a) && a.bottom <= bar.y + 0.6 && a.bottom > bar.y - 4 * a.size);
      const below = work.filter((a) => inSpan(a) && a.top >= bar.y - 0.6 && a.top < bar.y + 4 * a.size);
      // Keep only the parts connected to the bar (not a separate line further away).
      const connect = (list: Atom[], dir: 1 | -1) => {
        const sortedList = [...list].sort((a, b) => (dir === -1 ? b.bottom - a.bottom : a.top - b.top));
        const kept: Atom[] = [];
        let edge = bar.y;
        for (const a of sortedList) {
          const gap = dir === -1 ? edge - a.bottom : a.top - edge;
          const size = a.size;
          if (gap < 0.9 * size || kept.some((k) => Math.min(k.bottom, a.bottom) - Math.max(k.top, a.top) > -0.5 * size)) {
            kept.push(a);
            edge = dir === -1 ? Math.min(edge, a.top) : Math.max(edge, a.bottom);
          }
        }
        return kept;
      };
      const num = connect(above, -1);
      const den = connect(below, 1);
      done.add(bar);
      if (num.length === 0 && den.length === 0) continue;
      const innerBars = bars.filter((b) => b !== bar && !done.has(b) && b.x0 >= bar.x0 - 1 && b.x1 <= bar.x1 + 1);
      innerBars.forEach((b) => done.add(b));
      const numBars = innerBars.filter((b) => b.y < bar.y);
      const denBars = innerBars.filter((b) => b.y > bar.y);
      const size = Math.max(...[...num, ...den].map((a) => a.size));
      let latex: string;
      if (num.length && den.length) latex = `\\frac{${this.parse(num, numBars, depth + 1)}}{${this.parse(den, denBars, depth + 1)}}`;
      else if (den.length) latex = `\\overline{${this.parse(den, denBars, depth + 1)}}`;
      else latex = `\\underline{${this.parse(num, numBars, depth + 1)}}`;
      const atom: Atom = {
        x0: bar.x0,
        x1: bar.x1,
        top: Math.min(bar.y, ...num.map((a) => a.top)),
        bottom: Math.max(bar.y, ...den.map((a) => a.bottom)),
        // The math axis sits about 0.25 em above the baseline.
        base: num.length && den.length ? bar.y + 0.25 * size : (num.length ? median(num.map((a) => a.base)) : median(den.map((a) => a.base))),
        size,
        latex,
        kind: "frac",
      };
      work = [...work.filter((a) => !num.includes(a) && !den.includes(a)), atom];
    }
    return work;
  }

  private accents(atoms: Atom[], depth: number): Atom[] {
    let work = atoms;
    const ARROWS = ["←", "→", "↔", "⟵", "⟶", "⟷"];
    const candidates = atoms.filter((a) => a.glyph && (ACCENTS[a.glyph.ch] !== undefined || ARROWS.includes(a.glyph.ch)) && a.bottom - a.top < 0.45 * a.size + 1.5);
    for (const acc of candidates) {
      if (!work.includes(acc)) continue;
      const ch = acc.glyph!.ch;
      // What it sits on: atoms below it that overlap it horizontally.
      const under = work.filter((a) => a !== acc && !candidates.includes(a) && !(a.glyph && /^[−-]$/.test(a.glyph.ch) && Math.abs(cy(a) - cy(acc)) < 0.25 * acc.size + 1) && a.top >= acc.bottom - 0.35 * acc.size - 1 && a.top < acc.bottom + 0.8 * a.size && Math.min(a.x1, acc.x1 + 0.5) - Math.max(a.x0, acc.x0 - 0.5) > 0.25 * Math.min(a.x1 - a.x0, acc.x1 - acc.x0));
      if (under.length === 0) continue;
      // Arrow pieces "←" "→" over one base form a left-right arrow.
      // The halves overlap, so match on the joint rather than an exact abutment.
      const partner = ["←", "→"].includes(ch)
        ? candidates.find((o) => o !== acc && work.includes(o) && ["←", "→"].includes(o.glyph!.ch) && o.glyph!.ch !== ch && Math.abs(o.base - acc.base) < 1 && (ch === "←" ? o.x0 < acc.x1 + 2 && o.x1 > acc.x1 - 1 : acc.x0 < o.x1 + 2 && acc.x1 > o.x1 - 1))
        : null;
      // The base: full-size atoms under the accent's span (a superscript beside the accented
      // symbol stays its superscript).
      let spanX0 = Math.min(acc.x0, partner?.x0 ?? acc.x0);
      let spanX1 = Math.max(acc.x1, partner?.x1 ?? acc.x1);
      // A long arrow is an arrowhead plus extender rules ("←" "−") at the same height: one accent.
      const extenders: Atom[] = [];
      if (ARROWS.includes(ch)) {
        for (let grew = true; grew; ) {
          grew = false;
          for (const a of work) {
            if (extenders.includes(a) || a === acc || a === partner || !a.glyph || !/^[−-]$/.test(a.glyph.ch)) continue;
            if (Math.abs(cy(a) - cy(acc)) < 0.25 * acc.size + 1 && a.x0 < spanX1 + 2 && a.x1 > spanX0 - 2) {
              extenders.push(a);
              spanX0 = Math.min(spanX0, a.x0);
              spanX1 = Math.max(spanX1, a.x1);
              grew = true;
            }
          }
        }
      }
      const bigUnder = Math.max(...under.map((a) => a.size));
      const isPunct = (a: Atom) => a.kind === "glyph" && /^[,.;:]$/.test(a.glyph!.ch);
      const covered = under.filter((a) => !isPunct(a) && Math.min(a.x1, spanX1) - Math.max(a.x0, spanX0) > 0.4 * (a.x1 - a.x0) && a.size >= 0.85 * bigUnder);
      const target = covered.length ? covered : [under.sort((a, b) => Math.abs(cx(a) - cx(acc)) - Math.abs(cx(b) - cx(acc)))[0]];
      let command = ACCENTS[ch] ?? "\\vec";
      if (partner || ch === "↔" || ch === "⟷") command = "\\overleftrightarrow";
      else if (ch === "⟶" || (ch === "→" && (extenders.length > 0 || spanX1 - spanX0 > 1.3 * Math.max(...target.map((t) => t.x1 - t.x0))))) command = "\\overrightarrow";
      else if (ch === "←" || ch === "⟵") command = "\\overleftarrow";
      if (target.length > 1 && command === "\\bar") command = "\\overline";
      if (target.length > 1 && command === "\\hat") command = "\\widehat";
      if (target.length > 1 && command === "\\tilde") command = "\\widetilde";
      const inner = target.length === 1 && target[0].kind === "glyph" ? this.line(target, depth + 1) : this.parse(target, [], depth + 1);
      const atom: Atom = {
        x0: Math.min(...target.map((t) => t.x0)),
        x1: Math.max(...target.map((t) => t.x1)),
        top: Math.min(acc.top, ...target.map((t) => t.top)),
        bottom: Math.max(...target.map((t) => t.bottom)),
        base: median(target.map((t) => t.base)),
        size: Math.max(...target.map((t) => t.size)),
        latex: `${command}{${inner}}`,
        kind: "accent",
      };
      work = [...work.filter((a) => a !== acc && a !== partner && !target.includes(a) && !extenders.includes(a)), atom];
    }
    return work;
  }

  // Big operators (and max/min/lim) with limits stacked over/under them.
  private limits(atoms: Atom[], depth: number): Atom[] {
    let work = atoms;
    // Upright function words first: max, lim, ...
    const words = this.uprightWords(work);
    for (const w of words) {
      if (!LIMIT_FUNCTIONS.has(w.text)) continue;
      const below = work.filter((a) => !w.atoms.includes(a) && cx(a) > w.x0 - 2 && cx(a) < w.x1 + 2 && a.top > w.bottom - 0.5 && a.top < w.bottom + 1.2 * w.size && a.size < w.size * 0.9);
      if (below.length === 0) continue;
      const atom: Atom = {
        x0: Math.min(w.x0, ...below.map((a) => a.x0)),
        x1: Math.max(w.x1, ...below.map((a) => a.x1)),
        top: w.top,
        bottom: Math.max(...below.map((a) => a.bottom)),
        base: w.base,
        size: w.size,
        latex: `\\${w.text}_{${this.parse(below, [], depth + 1)}}`,
        kind: "op",
      };
      work = [...work.filter((a) => !w.atoms.includes(a) && !below.includes(a)), atom];
    }
    for (const op of work.filter((a) => a.glyph && BIG_OPS.has(a.glyph.ch))) {
      const span = (a: Atom) => cx(a) > op.x0 - 0.35 * op.size && cx(a) < op.x1 + 0.35 * op.size;
      const upper = work.filter((a) => a !== op && span(a) && a.bottom <= op.top + 0.15 * op.size && a.bottom > op.top - 1.6 * op.size && a.size < op.size * 1.01);
      const lower = work.filter((a) => a !== op && span(a) && a.top >= op.bottom - 0.15 * op.size && a.top < op.bottom + 1.6 * op.size && a.size < op.size * 1.01);
      const tex = SYMBOLS[op.glyph!.ch] ?? "\\sum";
      const sub = lower.length ? `_{${this.parse(lower, [], depth + 1)}}` : "";
      const sup = upper.length ? `^{${this.parse(upper, [], depth + 1)}}` : "";
      const atom: Atom = {
        x0: Math.min(op.x0, ...upper.map((a) => a.x0), ...lower.map((a) => a.x0)),
        x1: Math.max(op.x1, ...upper.map((a) => a.x1), ...lower.map((a) => a.x1)),
        top: Math.min(op.top, ...upper.map((a) => a.top)),
        bottom: Math.max(op.bottom, ...lower.map((a) => a.bottom)),
        // Big operators are centred on the math axis; report the surrounding baseline.
        base: (op.top + op.bottom) / 2 + 0.25 * op.size,
        size: op.size,
        latex: `${tex}${sub}${sup}`,
        kind: "op",
        big: true,
        limits: upper.length + lower.length > 0,
      };
      work = [...work.filter((a) => a !== op && !upper.includes(a) && !lower.includes(a)), atom];
    }
    return work;
  }

  private uprightWords(atoms: Atom[]) {
    const letters = atoms.filter((a) => a.kind === "glyph" && a.token && (a.token.kind === "upright" || a.token.kind === "text") && isLatinLetter(a.glyph!.ch)).sort((a, b) => a.x0 - b.x0);
    const words: { atoms: Atom[]; text: string; x0: number; x1: number; top: number; bottom: number; base: number; size: number }[] = [];
    for (const a of letters) {
      const w = words[words.length - 1];
      if (w && Math.abs(w.base - a.base) < 0.2 * a.size && a.x0 - w.x1 < 0.15 * a.size && Math.abs(w.size - a.size) < 0.1 * a.size) {
        w.atoms.push(a);
        w.text += a.glyph!.ch;
        w.x1 = a.x1;
        w.top = Math.min(w.top, a.top);
        w.bottom = Math.max(w.bottom, a.bottom);
      } else words.push({ atoms: [a], text: a.glyph!.ch, x0: a.x0, x1: a.x1, top: a.top, bottom: a.bottom, base: a.base, size: a.size });
    }
    return words;
  }

  // Full-size atoms on clearly different baselines are separate display rows.
  private rows(atoms: Atom[]): Atom[][] {
    const mainSize = Math.max(...atoms.filter((a) => !a.big).map((a) => a.size), 0) || Math.max(...atoms.map((a) => a.size));
    const full = atoms.filter((a) => a.size >= 0.88 * mainSize && !a.big);
    const bases: number[] = [];
    for (const a of [...full].sort((p, q) => p.base - q.base)) {
      if (!bases.some((b) => Math.abs(b - a.base) < 0.75 * mainSize)) bases.push(a.base);
    }
    if (bases.length <= 1) return [atoms];
    // Every atom goes to the row whose baseline its own box reaches (scripts stay with their row).
    const rows = bases.map(() => [] as Atom[]);
    for (const a of atoms) {
      let best = 0;
      let bestD = Infinity;
      bases.forEach((b, i) => {
        const d = a.base - b > 0.5 * mainSize ? Math.abs(a.top - b) : Math.abs(a.base - b);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      });
      if (a.big) {
        // A tall delimiter or operator belongs to the row its middle sits on.
        const mid = (a.top + a.bottom) / 2;
        best = bases.reduce((bi, b, i) => (Math.abs(b - 0.3 * mainSize - mid) < Math.abs(bases[bi] - 0.3 * mainSize - mid) ? i : bi), 0);
      }
      rows[best].push(a);
    }
    return rows.filter((r) => r.length > 0);
  }

  // One horizontal list: main-line atoms in order, scripts attached to the atom before them,
  // stretchy delimiters paired, spacing from the gaps.
  private line(atoms: Atom[], depth: number): string {
    if (atoms.length === 0) return "";
    const sizes = atoms.filter((a) => !a.big).map((a) => a.size);
    const mainSize = sizes.length ? Math.max(...sizes) : atoms[0].size;
    const mainAtoms = atoms.filter((a) => a.size >= 0.86 * mainSize && !(a.big && a.kind === "delim"));
    const mainBase = median(mainAtoms.filter((a) => a.kind === "glyph" || a.kind === "accent").map((a) => a.base).concat(mainAtoms.length ? [] : [atoms[0].base])) || median(mainAtoms.map((a) => a.base));
    const isMain = (a: Atom) => (a.big && (a.kind === "delim" || a.kind === "op")) || a.kind === "frac" || (a.size >= 0.86 * mainSize && Math.abs(a.base - mainBase) < 0.3 * mainSize) || (a.size >= 0.86 * mainSize && a.kind !== "glyph");
    const sorted = [...atoms].sort((a, b) => a.x0 - b.x0 || a.base - b.base);
    // TeX builds long arrows from overlapping pieces: "=" + "⇒" is \implies, "−" + "→" a long
    // arrow. Rejoin them.
    const ARROW_JOINS: Record<string, string> = { "=⇒": "\\Longrightarrow", "⇐=": "\\Longleftarrow", "⇐⇒": "\\Longleftrightarrow", "−→": "\\longrightarrow", "←−": "\\longleftarrow", "←→": "\\longleftrightarrow", "-→": "\\longrightarrow", "←-": "\\longleftarrow" };
    for (let i = 0; i + 1 < sorted.length; i++) {
      const a = sorted[i];
      const b = sorted[i + 1];
      if (a.kind !== "glyph" || b.kind !== "glyph") continue;
      const key = a.glyph!.ch + b.glyph!.ch;
      if (ARROW_JOINS[key] && b.x0 < a.x1 + 0.05 * a.size && Math.abs(a.base - b.base) < 0.2 * a.size) {
        const joined: Atom = { ...a, x1: b.x1, top: Math.min(a.top, b.top), bottom: Math.max(a.bottom, b.bottom), token: { tex: ARROW_JOINS[key], kind: "symbol" } };
        sorted.splice(i, 2, joined);
      }
    }
    const main = sorted.filter(isMain);
    const scripts = sorted.filter((a) => !isMain(a));
    if (main.length === 0) {
      // Everything is small (a script parsed on its own): treat as one line at its own size.
      const s = Math.max(...atoms.map((a) => a.size));
      return this.line(atoms.map((a) => ({ ...a, size: a.size >= 0.86 * s ? mainSize : a.size })), depth + 1);
    }
    // Attach scripts to the main atom they follow (or the first one, for prescripts).
    const supOf = new Map<Atom, Atom[]>();
    const subOf = new Map<Atom, Atom[]>();
    for (const sc of scripts) {
      const host = [...main].reverse().find((m) => m.x0 < sc.x0 + 0.3 * sc.size) ?? main[0];
      const hostBase = host.kind === "frac" || (host.big && host.kind !== "op") ? mainBase : host.base;
      const raised = sc.base < hostBase - 0.12 * host.size;
      (raised ? supOf : subOf).set(host, [...((raised ? supOf : subOf).get(host) ?? []), sc]);
    }
    // Pair stretchy delimiters.
    let out = "";
    let prev: Atom | null = null;
    const openStack: number[] = [];
    const pieces: string[] = [];
    const flushWord: { text: string; atoms: Atom[] } = { text: "", atoms: [] };
    const emitWord = () => {
      if (!flushWord.text) return;
      const w = flushWord.text;
      const fontRole = flushWord.atoms[0].glyph!.font.role;
      if (FUNCTIONS.has(w)) pieces.push(`\\${w}`);
      else if (fontRole === "text") {
        // Running text inside a display: consecutive words (and the spaces between them) become
        // one \text{...}.
        const last = pieces[pieces.length - 1];
        const beforeSpace = pieces[pieces.length - 2];
        if (last === "\\ " && beforeSpace && /\\text\{[^}]*\}$/.test(beforeSpace)) {
          pieces.pop();
          pieces[pieces.length - 1] = beforeSpace.replace(/\}$/, ` ${w}}`);
        } else if (last && /\\text\{[^}]*\}$/.test(last)) pieces[pieces.length - 1] = last.replace(/\}$/, `${w}}`);
        else pieces.push(`\\text{${w}}`);
      } else pieces.push(`\\mathrm{${w}}`);
      flushWord.text = "";
      flushWord.atoms = [];
    };
    for (const a of main) {
      // Spacing from the gap to the previous atom.
      if (prev) {
        // Measured from the previous atom's scripts, not its body ("A_U =" has no wide gap).
        const prevRight = Math.max(prev.x1, ...(supOf.get(prev) ?? []).map((x) => x.x1), ...(subOf.get(prev) ?? []).map((x) => x.x1));
        const gap = a.x0 - prevRight;
        const em = mainSize;
        if (gap > 1.6 * em) {
          emitWord();
          pieces.push("\\qquad ");
        } else if (gap > 0.75 * em) {
          emitWord();
          pieces.push("\\quad ");
        } else if (gap > 0.3 * em && a.token?.kind === "text" && prev.token?.kind === "text") {
          emitWord();
          pieces.push("\\ ");
        }
      }
      // Upright letters gather into words (\mathrm{CPT}, \ln, \text{and}).
      // In text-font words, hyphens, apostrophes and digits belong to the word ("one-body").
      const textPunct = a.kind === "glyph" && a.glyph!.font.role === "text" && /^[-'’‐–0-9]$/.test(a.glyph!.ch) && flushWord.atoms.length > 0 && a.x0 - flushWord.atoms[flushWord.atoms.length - 1].x1 < 0.15 * mainSize;
      const isWordLetter = (a.kind === "glyph" && a.token && (a.token.kind === "upright" || a.token.kind === "text") && isLatinLetter(a.glyph!.ch)) || textPunct;
      if (isWordLetter && !supOf.has(a) && !subOf.has(a)) {
        if (flushWord.atoms.length && (a.x0 - flushWord.atoms[flushWord.atoms.length - 1].x1 > 0.2 * mainSize || flushWord.atoms[0].glyph!.font.role !== a.glyph!.font.role)) emitWord();
        flushWord.text += a.glyph!.ch;
        flushWord.atoms.push(a);
        prev = a;
        continue;
      }
      if (isWordLetter) {
        // A script on the last letter of a word belongs to the whole word ("\mathrm{NR}^2").
        flushWord.text += a.glyph!.ch;
        flushWord.atoms.push(a);
        emitWord();
        const last = pieces.pop()!;
        pieces.push(this.withScripts(last, a, supOf, subOf, depth));
        prev = a;
        continue;
      }
      emitWord();
      let tex: string;
      if (a.kind === "glyph") {
        tex = a.token!.tex;
        if (a.big && OPEN.has(a.glyph!.ch)) tex = `\\left${delim(a.glyph!.ch)}`;
      } else if (a.kind === "delim") {
        const ch = a.glyph!.ch;
        const opener = OPEN.has(ch) && !(CLOSE.has(ch) && openStack.length > 0);
        if (opener) {
          openStack.push(pieces.length);
          tex = `\\left${delim(ch)}`;
        } else if (openStack.length) {
          openStack.pop();
          tex = `\\right${delim(ch)}`;
        } else {
          // A closing delimiter with no opener: open an invisible one at the start.
          pieces.unshift("\\left.");
          tex = `\\right${delim(ch)}`;
        }
      } else tex = a.latex;
      pieces.push(this.withScripts(tex, a, supOf, subOf, depth));
      prev = a;
    }
    emitWord();
    // Any \left without a \right gets an invisible closer.
    for (let k = 0; k < openStack.length; k++) pieces.push("\\right.");
    out = join(pieces);
    return tidy(out);
  }

  private withScripts(tex: string, host: Atom, supOf: Map<Atom, Atom[]>, subOf: Map<Atom, Atom[]>, depth: number): string {
    const sup = supOf.get(host);
    const sub = subOf.get(host);
    let out = tex;
    // A bare command followed by a script needs braces when it is a \left delimiter.
    if (sub?.length) out += `_{${this.parse(sub, [], depth + 1)}}`;
    if (sup?.length) {
      const s = this.parse(sup, [], depth + 1);
      out += s === "'" || s === "''" ? s : `^{${s}}`;
    }
    return out;
  }
}

function delim(ch: string): string {
  switch (ch) {
    case "{":
      return "\\{";
    case "}":
      return "\\}";
    case "⟨":
    case "〈":
      return "\\langle";
    case "⟩":
    case "〉":
      return "\\rangle";
    case "‖":
      return "\\|";
    case "⌊":
      return "\\lfloor";
    case "⌋":
      return "\\rfloor";
    case "⌈":
      return "\\lceil";
    case "⌉":
      return "\\rceil";
    default:
      return ch;
  }
}

// Joins LaTeX pieces: a control word followed by a letter needs a space between them.
function join(pieces: string[]): string {
  let out = "";
  for (const p of pieces) {
    if (!p) continue;
    if (/\\[a-zA-Z]+$/.test(out) && /^[A-Za-z]/.test(p)) out += " ";
    out += p;
  }
  return out;
}

// Readable LaTeX: single-character groups unbraced, dot leaders as \cdots / \ldots.
function tidy(latex: string): string {
  return latex
    .replace(/(\\cdot\s*){3}/g, "\\cdots ")
    .replace(/\.\s*\.\s*\./g, "\\ldots ")
    .replace(/_\{([A-Za-z0-9])\}/g, "_$1")
    .replace(/\^\{([A-Za-z0-9])\}/g, "^$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function glyphsToLatex(glyphs: Glyph[], bars: Bar[]): MathResult {
  // Control, format, private-use and lone combining characters draw nothing a formula can use.
  const visible = glyphs.filter((g) => !g.space && g.ch.trim() && !/^[\p{Cc}\p{Cf}\p{Co}\p{M}]+$/u.test(g.ch));
  if (visible.length === 0) return { latex: "", confidence: 0, unplaced: 0 };
  const atoms = visible.map(glyphAtom);
  // Oversized delimiters and operators (extension font, or scaled up).
  const mainSize = median(atoms.filter((a) => a.glyph!.font.role !== "extension").map((a) => a.size)) || atoms[0].size;
  for (const a of atoms) {
    const ch = a.glyph!.ch;
    const tall = a.bottom - a.top > 1.25 * mainSize;
    if ((a.glyph!.font.role === "extension" || tall) && (OPEN.has(ch) || CLOSE.has(ch))) {
      a.kind = "delim";
      a.big = true;
    }
    if (BIG_OPS.has(ch) || INTEGRALS.has(ch)) a.big = a.glyph!.font.role === "extension" || tall;
  }
  // Rules that can't be fraction bars or overlines: too short to span even one symbol, or lying
  // within a big bracket's own width (the serifs of a tall [ or ] drawn as a glyph plus rules).
  const delims = atoms.filter((a) => a.kind === "delim");
  const realBars = bars.filter(
    (b) => b.x1 - b.x0 >= 0.4 * mainSize && !delims.some((d) => b.x0 >= d.x0 - 1.5 && b.x1 <= d.x1 + 1.5 && b.y > d.top - 0.5 * mainSize && b.y < d.bottom + 0.6 * mainSize)
  );
  const parser = new Parser();
  const latex = parser.parse(atoms, realBars.map((b) => ({ ...b })));
  const confidence = parser.unplaced === 0 ? 1 : Math.max(0, 1 - parser.unplaced / visible.length);
  return { latex, confidence, unplaced: parser.unplaced };
}
