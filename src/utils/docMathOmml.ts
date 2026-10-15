// utils/docMathOmml.ts
//
// LaTeX -> OMML (Office Math Markup, the XML Word stores equations as) for docDocx.ts, so exported
// equations arrive in Word as real, editable Word equations rather than pictures of them. KaTeX
// already parses LaTeX into MathML (output: "mathml"); this walks that MathML tree and emits the
// matching OMML elements - fractions, scripts, n-ary operators with limits, radicals, accents,
// bars, fenced groups and matrices. Anything without an OMML counterpart falls back to its
// children's text, so nothing typed is ever dropped from the export.
//
// The MathML is parsed with xml-js (also what the `docx` library uses internally) rather than the
// webview's DOMParser, so this module runs - and is tested - outside a browser too.
import katex from "katex";
import { xml2js, type Element as XmlElement } from "xml-js";

const N_ARY_CHARS = new Set(["∑", "∏", "∐", "∫", "∬", "∭", "∮", "∯", "∰", "⋃", "⋂", "⋁", "⋀", "⨁", "⨂", "⨀"]);
// Integrals keep their limits beside the sign; sums, products and unions stack them above/below.
const SIDE_LIMIT_CHARS = new Set(["∫", "∬", "∭", "∮", "∯", "∰"]);

// MathML accent operator -> the combining character OMML's <m:acc> expects.
const ACCENT_CHARS: Record<string, string> = {
  "^": "̂",
  "ˆ": "̂",
  "~": "̃",
  "˜": "̃",
  "˙": "̇",
  "¨": "̈",
  "ˇ": "̌",
  "˘": "̆",
  "´": "́",
  "`": "̀",
  "→": "⃗",
  "⃗": "⃗",
  "¯": "̅",
  "ˉ": "̅",
};
const BAR_CHARS = new Set(["‾", "¯", "_", "―", "‐", "−", "ˉ"]);

// \mathbb, \mathcal, \mathfrak, \mathbf map to Unicode's mathematical alphanumerics - what Word
// itself uses for these styles. Each style's few letters that predate that block live elsewhere.
const ALPHANUMERIC_STYLES: Record<string, { upper: number; lower?: number; digit?: number; holes: Record<string, number> }> = {
  "double-struck": { upper: 0x1d538, lower: 0x1d552, digit: 0x1d7d8, holes: { C: 0x2102, H: 0x210d, N: 0x2115, P: 0x2119, Q: 0x211a, R: 0x211d, Z: 0x2124 } },
  script: { upper: 0x1d49c, lower: 0x1d4b6, holes: { B: 0x212c, E: 0x2130, F: 0x2131, H: 0x210b, I: 0x2110, L: 0x2112, M: 0x2133, R: 0x211b, e: 0x212f, g: 0x210a, o: 0x2134 } },
  fraktur: { upper: 0x1d504, lower: 0x1d51e, holes: { C: 0x212d, H: 0x210c, I: 0x2111, R: 0x211c, Z: 0x2128 } },
  bold: { upper: 0x1d400, lower: 0x1d41a, digit: 0x1d7ce, holes: {} },
};

function styleText(text: string, variant: string | undefined): string {
  const style = variant ? ALPHANUMERIC_STYLES[variant] : undefined;
  if (!style) return text;
  return Array.from(text)
    .map((ch) => {
      if (style.holes[ch]) return String.fromCodePoint(style.holes[ch]);
      if (ch >= "A" && ch <= "Z") return String.fromCodePoint(style.upper + ch.charCodeAt(0) - 65);
      if (ch >= "a" && ch <= "z" && style.lower) return String.fromCodePoint(style.lower + ch.charCodeAt(0) - 97);
      if (ch >= "0" && ch <= "9" && style.digit) return String.fromCodePoint(style.digit + ch.charCodeAt(0) - 48);
      return ch;
    })
    .join("");
}

function escapeXml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
}

// U+2061 (function application) and U+2062/2063 (invisible times/separator) are MathML-only
// hints with no glyph - Word would show them as boxes.
const INVISIBLE = /[⁡⁢⁣⁤]/g;

type RunStyle = "math" | "upright" | "text";

function run(text: string, style: RunStyle = "math"): string {
  const clean = text.replace(INVISIBLE, "");
  if (!clean) return "";
  const rPr = style === "upright" ? "<m:rPr><m:sty m:val=\"p\"/></m:rPr>" : style === "text" ? "<m:rPr><m:nor/></m:rPr>" : "";
  return `<m:r>${rPr}<m:t xml:space="preserve">${escapeXml(clean)}</m:t></m:r>`;
}

const elementChildren = (el: XmlElement): XmlElement[] => (el.elements ?? []).filter((c) => c.type === "element");

function textOf(el: XmlElement): string {
  if (el.type === "text") return String(el.text ?? "");
  return (el.elements ?? []).map(textOf).join("");
}

const attr = (el: XmlElement, name: string): string | undefined => {
  const value = el.attributes?.[name];
  return value === undefined ? undefined : String(value);
};

// The operator a script/limit element is attached to, when it's an n-ary sign (∑ with limits).
function nAryChar(el: XmlElement): string | null {
  if (el.name === "mo") {
    const text = textOf(el).trim();
    return N_ARY_CHARS.has(text) ? text : null;
  }
  if (["msub", "msup", "msubsup", "munder", "mover", "munderover"].includes(el.name ?? "")) {
    const base = elementChildren(el)[0];
    return base ? nAryChar(base) : null;
  }
  return null;
}

function nary(el: XmlElement, chr: string, operand: string): string {
  const kids = elementChildren(el);
  let sub = "";
  let sup = "";
  if (el.name === "msub" || el.name === "munder") sub = convert(kids[1]);
  else if (el.name === "msup" || el.name === "mover") sup = convert(kids[1]);
  else if (el.name === "msubsup" || el.name === "munderover") {
    sub = convert(kids[1]);
    sup = convert(kids[2]);
  }
  const limLoc = SIDE_LIMIT_CHARS.has(chr) ? "subSup" : "undOvr";
  const pr =
    `<m:naryPr><m:chr m:val="${escapeXml(chr)}"/><m:limLoc m:val="${limLoc}"/>` +
    (sub ? "" : '<m:subHide m:val="1"/>') +
    (sup ? "" : '<m:supHide m:val="1"/>') +
    "</m:naryPr>";
  return `<m:nary>${pr}<m:sub>${sub}</m:sub><m:sup>${sup}</m:sup><m:e>${operand}</m:e></m:nary>`;
}

// A sequence of siblings - the one place an n-ary operator can take the element after it as its
// operand (OMML nests the summand inside <m:nary>; MathML just puts it next).
function convertSequence(children: XmlElement[]): string {
  let out = "";
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    const chr = nAryChar(child);
    if (chr) {
      const next = children[i + 1];
      const operand = next ? convert(next) : "";
      if (next) i++;
      out += nary(child, chr, operand);
      continue;
    }
    out += convert(child);
  }
  return out;
}

function fenced(children: XmlElement[]): string | null {
  if (children.length < 2) return null;
  const first = children[0];
  const last = children[children.length - 1];
  if (first.name !== "mo" || last.name !== "mo" || attr(first, "fence") !== "true" || attr(last, "fence") !== "true") return null;
  const beg = textOf(first).trim();
  const end = textOf(last).trim();
  return (
    `<m:d><m:dPr><m:begChr m:val="${escapeXml(beg)}"/><m:endChr m:val="${escapeXml(end)}"/></m:dPr>` +
    `<m:e>${convertSequence(children.slice(1, -1))}</m:e></m:d>`
  );
}

function accentOrLimit(el: XmlElement, over: boolean): string {
  const [baseEl, markEl] = elementChildren(el);
  const base = convert(baseEl);
  const mark = markEl ? textOf(markEl).trim() : "";
  const isAccent = attr(el, over ? "accent" : "accentunder") === "true";
  if (isAccent && BAR_CHARS.has(mark) && (attr(markEl, "stretchy") === "true" || !over)) {
    return `<m:bar><m:barPr><m:pos m:val="${over ? "top" : "bot"}"/></m:barPr><m:e>${base}</m:e></m:bar>`;
  }
  if (isAccent && over && ACCENT_CHARS[mark]) {
    return `<m:acc><m:accPr><m:chr m:val="${ACCENT_CHARS[mark]}"/></m:accPr><m:e>${base}</m:e></m:acc>`;
  }
  const limit = markEl ? convert(markEl) : "";
  return over ? `<m:limUpp><m:e>${base}</m:e><m:lim>${limit}</m:lim></m:limUpp>` : `<m:limLow><m:e>${base}</m:e><m:lim>${limit}</m:lim></m:limLow>`;
}

function convert(el: XmlElement | undefined): string {
  if (!el) return "";
  if (el.type === "text") return run(String(el.text ?? ""));
  if (el.type !== "element") return "";
  const kids = elementChildren(el);
  switch (el.name) {
    case "annotation":
    case "annotation-xml":
    case "mphantom":
      return "";
    case "mi": {
      const text = textOf(el);
      const variant = attr(el, "mathvariant");
      // Multi-letter identifiers (sin, lim, log) and \mathrm are upright; single letters italic.
      const upright = variant === "normal" || (text.length > 1 && !variant);
      return run(styleText(text, variant), upright ? "upright" : "math");
    }
    case "mn":
      return run(styleText(textOf(el), attr(el, "mathvariant")), "upright");
    case "mo":
      return run(textOf(el), "upright");
    case "mtext":
    case "ms":
      return run(textOf(el), "text");
    case "mspace": {
      const width = parseFloat(attr(el, "width") ?? "0");
      return width > 0.2 ? run(width >= 0.9 ? " " : " ", "text") : "";
    }
    case "mfrac": {
      const bar = attr(el, "linethickness") === "0px" ? '<m:fPr><m:type m:val="noBar"/></m:fPr>' : "";
      return `<m:f>${bar}<m:num>${convert(kids[0])}</m:num><m:den>${convert(kids[1])}</m:den></m:f>`;
    }
    case "msup":
      return `<m:sSup><m:e>${convert(kids[0])}</m:e><m:sup>${convert(kids[1])}</m:sup></m:sSup>`;
    case "msub":
      return `<m:sSub><m:e>${convert(kids[0])}</m:e><m:sub>${convert(kids[1])}</m:sub></m:sSub>`;
    case "msubsup":
      return `<m:sSubSup><m:e>${convert(kids[0])}</m:e><m:sub>${convert(kids[1])}</m:sub><m:sup>${convert(kids[2])}</m:sup></m:sSubSup>`;
    case "msqrt":
      return `<m:rad><m:radPr><m:degHide m:val="1"/></m:radPr><m:deg/><m:e>${convertSequence(kids)}</m:e></m:rad>`;
    case "mroot":
      return `<m:rad><m:deg>${convert(kids[1])}</m:deg><m:e>${convert(kids[0])}</m:e></m:rad>`;
    case "mover":
      return accentOrLimit(el, true);
    case "munder":
      return accentOrLimit(el, false);
    case "munderover": {
      const [base, under, over] = kids;
      return `<m:limUpp><m:e><m:limLow><m:e>${convert(base)}</m:e><m:lim>${convert(under)}</m:lim></m:limLow></m:e><m:lim>${convert(over)}</m:lim></m:limUpp>`;
    }
    case "mtable": {
      const rows = kids.filter((k) => k.name === "mtr" || k.name === "mlabeledtr");
      const body = rows
        .map((row) => `<m:mr>${elementChildren(row).filter((c) => c.name === "mtd").map((cell) => `<m:e>${convertSequence(elementChildren(cell))}</m:e>`).join("")}</m:mr>`)
        .join("");
      return `<m:m>${body}</m:m>`;
    }
    case "mrow":
      return fenced(kids) ?? convertSequence(kids);
    default:
      // math, semantics, mstyle, mpadded, menclose, merror, and anything newer: keep the content.
      return convertSequence(kids);
  }
}

function findMath(el: XmlElement): XmlElement | null {
  if (el.type === "element" && el.name === "math") return el;
  for (const child of el.elements ?? []) {
    const found = findMath(child);
    if (found) return found;
  }
  return null;
}

// The inner content of an <m:oMath> for one equation, or null if KaTeX can't parse the source -
// the caller then exports the LaTeX as plain text instead.
export function latexToOmmlContent(latex: string, displayMode: boolean): string | null {
  let mathml: string;
  try {
    mathml = katex.renderToString(latex, { output: "mathml", displayMode, throwOnError: true, strict: "ignore" });
  } catch {
    return null;
  }
  const root = xml2js(mathml, { compact: false }) as XmlElement;
  const math = findMath(root);
  return math ? convert(math) : null;
}

export function latexToOmml(latex: string, displayMode: boolean): string | null {
  const content = latexToOmmlContent(latex, displayMode);
  return content === null ? null : `<m:oMath>${content}</m:oMath>`;
}
