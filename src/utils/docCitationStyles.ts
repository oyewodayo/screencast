// utils/docCitationStyles.ts
//
// In-text citations and reference-list entries for the four styles a Docs user is most likely
// submitting to: Nature (superscript numbers), APS / Physical Review ([1]), IEEE ([1]) and APA 7
// (author-date). Hand-written rather than a CSL processor: four styles don't justify citeproc's
// size, and owning the rules lets each style get its details right - Nature's "&" and five-author
// cut-off, APS's bold volume and first page only, IEEE's "[1]–[3]" ranges, APA's 2021a/2021b.
//
// Output is a list of styled text segments, not HTML, so the live editor, .docx, .html and
// Markdown exporters all render the same entry from one source.
import type { BibEntry, CitationStyleId, CslName } from "./docBibliography";
import { issuedYear } from "./docBibliography";

export interface Segment {
  text: string;
  italic?: boolean;
  bold?: boolean;
  link?: string;
}

export interface FormattedReference {
  id: string;
  // "1." (Nature), "[1]" (APS, IEEE), "" (APA - alphabetical, hanging indent).
  label: string;
  segments: Segment[];
}

export interface CitationStyleInfo {
  id: CitationStyleId;
  name: string;
  example: string;
  numeric: boolean;
  // In-text numbers are superscript (Nature) rather than bracketed.
  superscript: boolean;
}

export const CITATION_STYLES: CitationStyleInfo[] = [
  { id: "nature", name: "Nature", example: "Text¹ · 1. Scholl, P. et al. Nature 595, 233–238 (2021).", numeric: true, superscript: true },
  { id: "aps", name: "APS (Physical Review)", example: "Text [1] · [1] P. Scholl et al., Nature 595, 233 (2021).", numeric: true, superscript: false },
  { id: "ieee", name: "IEEE", example: "Text [1] · [1] P. Scholl et al., “Quantum…,” Nature, vol. 595…", numeric: true, superscript: false },
  { id: "apa", name: "APA 7th", example: "Text (Scholl et al., 2021) · Scholl, P., Schuler, M., … (2021).", numeric: false, superscript: false },
];

export function styleInfo(id: CitationStyleId): CitationStyleInfo {
  return CITATION_STYLES.find((s) => s.id === id) ?? CITATION_STYLES[0];
}

// ----------------------------------------------------------------------------------------------
// Names

function familyOf(n: CslName): string {
  if (n.literal) return n.literal;
  return [n["non-dropping-particle"], n.family].filter(Boolean).join(" ");
}

// "Hannah J." -> "H. J.", "Jean-Pierre" -> "J.-P.", "H.J." -> "H. J.". Particles in the given
// name ("Ludwig van") keep their capitalisation rule: only words get initials.
export function initials(given: string | undefined): string {
  if (!given) return "";
  return given
    .replace(/\./g, ". ")
    .split(/\s+/)
    .filter(Boolean)
    .map((word) =>
      word
        .split("-")
        .map((part) => {
          const letter = part.replace(/[.,]/g, "").charAt(0);
          return letter ? `${letter.toUpperCase()}.` : "";
        })
        .filter(Boolean)
        .join("-")
    )
    .join(" ");
}

const invertedName = (n: CslName) => (n.literal ? n.literal : [familyOf(n) + (initials(n.given) ? "," : ""), initials(n.given), n.suffix ? `, ${n.suffix}` : ""].filter(Boolean).join(" ").replace(" ,", ","));
const directName = (n: CslName) => (n.literal ? n.literal : [initials(n.given), familyOf(n), n.suffix ? `${n.suffix}` : ""].filter(Boolean).join(" "));

function joinNames(names: string[], conj: string, serialComma: boolean): string {
  if (names.length <= 1) return names.join("");
  if (names.length === 2) return `${names[0]}${serialComma ? "," : ""} ${conj} ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}${serialComma ? "," : ""} ${conj} ${names[names.length - 1]}`;
}

function authorList(entry: BibEntry, style: CitationStyleId): string {
  const authors = entry.author ?? [];
  if (authors.length === 0) return "";
  switch (style) {
    case "nature":
      // Nature: up to five authors, otherwise first author et al.; "&" without a serial comma.
      return authors.length > 5 ? `${invertedName(authors[0])} et al.` : joinNames(authors.map(invertedName), "&", false);
    case "apa": {
      // APA 7: up to 20 authors; beyond that the first 19, an ellipsis, then the last.
      const list = authors.map(invertedName);
      if (list.length > 20) return `${list.slice(0, 19).join(", ")}, … ${list[list.length - 1]}`;
      return list.length === 1 ? list[0] : `${list.slice(0, -1).join(", ")}, & ${list[list.length - 1]}`;
    }
    case "ieee":
      return authors.length > 6 ? `${directName(authors[0])} et al.` : joinNames(authors.map(directName), "and", authors.length > 2);
    case "aps":
      return authors.length > 10 ? `${directName(authors[0])} et al.` : joinNames(authors.map(directName), "and", authors.length > 2);
  }
}

function editorList(entry: BibEntry): string {
  return joinNames((entry.editor ?? []).map(directName), "and", (entry.editor?.length ?? 0) > 2);
}

// The author part of an author-date citation: "Scholl", "Scholl & Schuler", "Scholl et al.".
export function authorDateKey(entry: BibEntry): string {
  const authors = entry.author ?? [];
  if (authors.length === 0) {
    const words = (entry.title ?? "Untitled").split(/\s+/).slice(0, 4).join(" ");
    return `“${words}${(entry.title ?? "").split(/\s+/).length > 4 ? "…" : ""}”`;
  }
  if (authors.length === 1) return familyOf(authors[0]);
  if (authors.length === 2) return `${familyOf(authors[0])} & ${familyOf(authors[1])}`;
  return `${familyOf(authors[0])} et al.`;
}

// ----------------------------------------------------------------------------------------------
// Building an entry

class Builder {
  segments: Segment[] = [];

  add(text: string | undefined | null, style: Omit<Segment, "text"> = {}): this {
    if (!text) return this;
    const last = this.segments[this.segments.length - 1];
    // Never ".." / ",." / "?." across segments: a title ending in "?" swallows the period after it.
    if (last && /[.?!]$/.test(last.text.trimEnd()) && /^[.,]/.test(text)) text = text.slice(1);
    if (!text) return this;
    if (last && !last.link && !style.link && !!last.italic === !!style.italic && !!last.bold === !!style.bold) last.text += text;
    else this.segments.push({ text, ...style });
    return this;
  }

  done(): Segment[] {
    for (const s of this.segments) s.text = s.text.replace(/\s{2,}/g, " ");
    if (this.segments[0]) this.segments[0].text = this.segments[0].text.trimStart();
    const last = this.segments[this.segments.length - 1];
    if (last) last.text = last.text.trimEnd();
    return this.segments.filter((s) => s.text);
  }
}

const endsWithPunct = (t: string) => /[.?!]$/.test(t.trim());
const sentence = (t: string | undefined) => (t ? (endsWithPunct(t) ? t : `${t}.`) : "");
const yearOf = (e: BibEntry) => issuedYear(e);
const pagesOf = (e: BibEntry) => e.page?.replace(/-+/g, "–");
const firstPage = (e: BibEntry) => e.page?.split(/[–-]/)[0];
const journalShort = (e: BibEntry) => e["container-title-short"] ?? e["container-title"];
const doiUrl = (e: BibEntry) => (e.arxiv && /^10\.48550\//i.test(e.DOI ?? "") ? `https://doi.org/10.48550/arXiv.${e.arxiv}` : e.DOI ? `https://doi.org/${e.DOI}` : undefined);
const arxivUrl = (e: BibEntry) => (e.arxiv ? `https://arxiv.org/abs/${e.arxiv}` : undefined);
const isPreprint = (e: BibEntry) => !!e.arxiv && !e["container-title"];
const IEEE_MONTHS = ["Jan.", "Feb.", "Mar.", "Apr.", "May", "Jun.", "Jul.", "Aug.", "Sep.", "Oct.", "Nov.", "Dec."];

function nature(e: BibEntry): Segment[] {
  const b = new Builder();
  const authors = authorList(e, "nature");
  if (authors) b.add(`${sentence(authors)} `);
  const year = yearOf(e);
  switch (e.type) {
    case "book":
      b.add(e.title, { italic: true }).add(` (${[e.publisher, year].filter(Boolean).join(", ")}).`);
      break;
    case "chapter":
    case "paper-conference":
      b.add(`${sentence(e.title)} in `).add(e["container-title"], { italic: true });
      if (e.editor?.length) b.add(` (eds ${editorList(e)})`);
      if (pagesOf(e)) b.add(` ${pagesOf(e)}`);
      b.add(` (${[e.publisher, year].filter(Boolean).join(", ")}).`);
      break;
    case "thesis":
      b.add(`${sentence(e.title)} ${e.genre ?? "PhD thesis"}${e.publisher ? `, ${e.publisher}` : ""} (${year ?? "n.d."}).`);
      break;
    case "report":
      b.add(`${sentence(e.title)} `).add(e.number ? `Report No. ${e.number} ` : "").add(`(${[e.publisher, year].filter(Boolean).join(", ")}).`);
      break;
    default:
      if (isPreprint(e)) {
        b.add(`${sentence(e.title)} Preprint at `).add(arxivUrl(e), { link: arxivUrl(e) }).add(` (${year ?? "n.d."}).`);
      } else if (e["container-title"]) {
        b.add(`${sentence(e.title)} `).add(journalShort(e), { italic: true });
        if (e.volume) b.add(" ").add(e.volume, { bold: true });
        const loc = pagesOf(e) ?? e["article-number"];
        b.add(`${loc ? `, ${loc}` : ""} (${year ?? "n.d."}).`);
      } else {
        b.add(`${sentence(e.title)} `);
        if (e.URL) b.add(e.URL, { link: e.URL }).add(" ");
        b.add(`(${year ?? "n.d."}).`);
      }
  }
  return b.done();
}

function aps(e: BibEntry): Segment[] {
  const b = new Builder();
  const authors = authorList(e, "aps");
  if (authors) b.add(`${authors}, `);
  const year = yearOf(e);
  const where = [e.publisher, e["publisher-place"], year].filter(Boolean).join(", ");
  switch (e.type) {
    case "book":
      b.add(e.title, { italic: true }).add(` (${where}).`);
      break;
    case "chapter":
    case "paper-conference":
      b.add(`${e.title}, in `).add(e["container-title"], { italic: true });
      if (e.editor?.length) b.add(`, edited by ${editorList(e)}`);
      b.add(` (${where})`).add(pagesOf(e) ? `, pp. ${pagesOf(e)}` : "").add(".");
      break;
    case "thesis":
      b.add(`${e.title}, ${e.genre === "Master’s thesis" ? "Master’s thesis" : "Ph.D. thesis"}, ${[e.publisher, year].filter(Boolean).join(", ")}.`);
      break;
    default:
      if (isPreprint(e)) {
        b.add(`${e.title}, `).add(`arXiv:${e.arxiv}`, { link: arxivUrl(e) }).add(".");
      } else if (e["container-title"]) {
        b.add(`${e.title}, `).add(journalShort(e), { italic: true });
        if (e.volume) b.add(" ").add(e.volume, { bold: true });
        const loc = e["article-number"] ?? firstPage(e);
        b.add(`${loc ? `, ${loc}` : ""} (${year ?? "n.d."}).`);
      } else {
        b.add(`${e.title}`).add(e.URL ? `, ` : "").add(e.URL, { link: e.URL }).add(` (${year ?? "n.d."}).`);
      }
  }
  return b.done();
}

function ieee(e: BibEntry): Segment[] {
  const b = new Builder();
  const authors = authorList(e, "ieee");
  if (authors) b.add(`${authors}, `);
  const year = yearOf(e);
  const monthPart = e.issued?.["date-parts"]?.[0]?.[1];
  const month = typeof monthPart === "number" && monthPart >= 1 && monthPart <= 12 ? `${IEEE_MONTHS[monthPart - 1]} ` : "";
  const pages = pagesOf(e);
  const pp = pages ? (pages.includes("–") ? `pp. ${pages}` : `p. ${pages}`) : e["article-number"] ? `Art. no. ${e["article-number"]}` : "";
  const quoted = (t: string | undefined) => `“${(t ?? "").replace(/[.]$/, "")},” `;
  switch (e.type) {
    case "book":
      b.add(e.title, { italic: true }).add(e.edition ? `, ${e.edition} ed.` : "").add(". ");
      b.add(`${[e["publisher-place"] ? `${e["publisher-place"]}: ${e.publisher ?? ""}` : e.publisher, year].filter(Boolean).join(", ")}.`);
      break;
    case "chapter":
    case "paper-conference":
      b.add(quoted(e.title)).add("in ").add(e["container-title"], { italic: true });
      if (e.editor?.length) b.add(`, ${editorList(e)}, Ed${e.editor.length > 1 ? "s" : ""}.`);
      b.add(`, ${[e["publisher-place"], e.publisher].filter(Boolean).join(": ")}${e.publisher || e["publisher-place"] ? ", " : ""}${year ?? ""}${pp ? `, ${pp}` : ""}.`);
      break;
    case "thesis":
      b.add(quoted(e.title)).add(`${e.genre === "Master’s thesis" ? "M.S. thesis" : "Ph.D. dissertation"}, ${[e.publisher, e["publisher-place"], year].filter(Boolean).join(", ")}.`);
      break;
    case "report":
      b.add(quoted(e.title)).add(`${[e.publisher, e["publisher-place"], e.number ? `Rep. ${e.number}` : "", year].filter(Boolean).join(", ")}.`);
      break;
    default:
      if (isPreprint(e)) {
        b.add(quoted(e.title)).add(`${year ?? ""}, `).add(`arXiv:${e.arxiv}`, { link: arxivUrl(e) }).add(".");
      } else if (e["container-title"]) {
        b.add(quoted(e.title)).add(journalShort(e), { italic: true });
        b.add([e.volume ? `vol. ${e.volume}` : "", e.issue ? `no. ${e.issue}` : "", pp, `${month}${year ?? ""}`.trim()].filter(Boolean).map((p) => `, ${p}`).join(""));
        if (e.DOI) b.add(", doi: ").add(e.DOI, { link: doiUrl(e) });
        b.add(".");
      } else {
        b.add(quoted(e.title)).add(`${year ?? ""}. `);
        if (e.URL) b.add("[Online]. Available: ").add(e.URL, { link: e.URL });
      }
  }
  return b.done();
}

function apa(e: BibEntry, suffix: string): Segment[] {
  const b = new Builder();
  const authors = authorList(e, "apa");
  const year = `(${yearOf(e) ?? "n.d."}${suffix}).`;
  const doi = doiUrl(e) ?? (isPreprint(e) ? `https://doi.org/10.48550/arXiv.${e.arxiv}` : undefined) ?? e.URL;
  const italicTitle = e.type === "book" || e.type === "thesis" || e.type === "report" || e.type === "webpage" || isPreprint(e) || !e["container-title"];
  if (authors) b.add(`${authors} ${year} `);
  if (italicTitle) b.add(e.title, { italic: true });
  else b.add(sentence(e.title));
  if (!authors) b.add(` ${year}`);
  switch (e.type) {
    case "book":
      b.add(e.edition ? ` (${e.edition} ed.)` : "").add(". ").add(e.publisher ? sentence(e.publisher) : "");
      break;
    case "chapter":
    case "paper-conference":
      b.add(" In ").add(e.editor?.length ? `${editorList(e)} (Ed${e.editor.length > 1 ? "s" : ""}.), ` : "").add(e["container-title"], { italic: true });
      b.add(pagesOf(e) ? ` (pp. ${pagesOf(e)})` : "").add(". ").add(e.publisher ? sentence(e.publisher) : "");
      break;
    case "thesis":
      b.add(` [${e.genre === "Master’s thesis" ? "Master’s thesis" : "Doctoral dissertation"}${e.publisher ? `, ${e.publisher}` : ""}].`);
      break;
    case "report":
      b.add(e.number ? ` (Report No. ${e.number})` : "").add(". ").add(e.publisher ? sentence(e.publisher) : "");
      break;
    default:
      if (isPreprint(e)) b.add(". arXiv.");
      else if (e["container-title"]) {
        b.add(" ").add(e["container-title"], { italic: true });
        if (e.volume) b.add(", ").add(e.volume, { italic: true });
        if (e.issue) b.add(`(${e.issue})`);
        const loc = pagesOf(e) ?? (e["article-number"] ? `Article ${e["article-number"]}` : "");
        b.add(loc ? `, ${loc}.` : ".");
      } else b.add(".");
  }
  if (doi) b.add(" ").add(doi, { link: doi });
  return b.done();
}

// ----------------------------------------------------------------------------------------------
// Ordering, numbering and disambiguation

export interface CitationContext {
  style: CitationStyleId;
  // Numeric styles: reference id -> its number (order of first citation).
  numbers: Map<string, number>;
  // APA: reference id -> "a"/"b"/... when two works share author key and year.
  suffixes: Map<string, string>;
  // The reference list, in printed order (numeric: by number; APA: alphabetical).
  ordered: BibEntry[];
}

const sortKey = (e: BibEntry) =>
  `${(e.author ?? []).map((n) => familyOf(n).toLowerCase()).join(" ") || (e.title ?? "").toLowerCase()}\u0000${String(yearOf(e) ?? 9999).padStart(4, "0")}\u0000${(e.title ?? "").toLowerCase()}`;

// citedIds: every cited reference id in order of first appearance in the document.
export function buildCitationContext(citedIds: string[], lookup: (id: string) => BibEntry | undefined, style: CitationStyleId): CitationContext {
  const entries = citedIds.map(lookup).filter((e): e is BibEntry => !!e);
  const numbers = new Map<string, number>();
  const suffixes = new Map<string, string>();
  let ordered = entries;
  if (styleInfo(style).numeric) {
    entries.forEach((e, i) => numbers.set(e.id, i + 1));
  } else {
    ordered = [...entries].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
    const groups = new Map<string, BibEntry[]>();
    for (const e of ordered) {
      const key = `${authorDateKey(e)}|${yearOf(e) ?? "n.d."}`;
      groups.set(key, [...(groups.get(key) ?? []), e]);
    }
    for (const group of groups.values()) {
      if (group.length > 1) group.forEach((e, i) => suffixes.set(e.id, String.fromCharCode(97 + i)));
    }
  }
  return { style, numbers, suffixes, ordered };
}

export function formatReference(entry: BibEntry, ctx: CitationContext): FormattedReference {
  const n = ctx.numbers.get(entry.id);
  switch (ctx.style) {
    case "nature":
      return { id: entry.id, label: `${n}.`, segments: nature(entry) };
    case "aps":
      return { id: entry.id, label: `[${n}]`, segments: aps(entry) };
    case "ieee":
      return { id: entry.id, label: `[${n}]`, segments: ieee(entry) };
    case "apa":
      return { id: entry.id, label: "", segments: apa(entry, ctx.suffixes.get(entry.id) ?? "") };
  }
}

export function formatBibliography(ctx: CitationContext): FormattedReference[] {
  return ctx.ordered.map((e) => formatReference(e, ctx));
}

// Consecutive runs of three or more numbers collapse to a range: 1, 2, 3, 5 -> "1–3,5".
function compress(numbers: number[]): (number | [number, number])[] {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  const out: (number | [number, number])[] = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    if (j - i >= 2) out.push([sorted[i], sorted[j]]);
    else for (let k = i; k <= j; k++) out.push(sorted[k]);
    i = j + 1;
  }
  return out;
}

export interface InTextCitation {
  text: string;
  superscript: boolean;
  // A cited reference no longer in the library.
  missing: boolean;
}

export function formatCitation(refIds: string[], locator: string | null | undefined, lookup: (id: string) => BibEntry | undefined, ctx: CitationContext): InTextCitation {
  const info = styleInfo(ctx.style);
  const present = refIds.filter((id) => lookup(id));
  const missing = present.length < refIds.length || refIds.length === 0;
  const loc = locator?.trim();
  if (info.numeric) {
    const parts = compress(present.map((id) => ctx.numbers.get(id)).filter((n): n is number => typeof n === "number"));
    if (parts.length === 0) return { text: info.superscript ? "?" : "[?]", superscript: info.superscript, missing: true };
    if (ctx.style === "ieee") {
      const text = parts.map((p) => (Array.isArray(p) ? `[${p[0]}]–[${p[1]}]` : `[${p}]`)).join(", ");
      return { text: loc && parts.length === 1 && !Array.isArray(parts[0]) ? `[${parts[0]}, ${loc}]` : text, superscript: false, missing };
    }
    const body = parts.map((p) => (Array.isArray(p) ? `${p[0]}–${p[1]}` : String(p))).join(info.superscript ? "," : ", ");
    if (info.superscript) return { text: loc ? `${body} (${loc})` : body, superscript: true, missing };
    return { text: `[${body}${loc ? `, ${loc}` : ""}]`, superscript: false, missing };
  }
  // APA lists works inside one parenthetical alphabetically, the same order as the reference list.
  const items = present
    .map((id) => lookup(id)!)
    .sort((a, b) => sortKey(a).localeCompare(sortKey(b)))
    .map((e) => `${authorDateKey(e)}, ${yearOf(e) ?? "n.d."}${ctx.suffixes.get(e.id) ?? ""}`);
  if (items.length === 0) return { text: "(?)", superscript: false, missing: true };
  return { text: `(${items.join("; ")}${loc ? `, ${loc}` : ""})`, superscript: false, missing };
}

// Bracketed and author-date citations need a space after the word they follow ("magnets [1]",
// "magnets (Scholl et al., 2021)"); superscripts sit flush ("magnets¹"). Decided when rendering,
// not stored, because the document's style can change at any time. The space is a no-break space
// so a citation never wraps onto a line of its own.
export function citationSpaceBefore(previousChar: string, superscript: boolean): string {
  if (superscript || !previousChar) return "";
  return /[\s\u00a0([{\u2014\u2013/-]/.test(previousChar) ? "" : "\u00a0";
}

// The last character of the inline content before a node (JSON siblings).
export function lastCharOf(node: { type?: string; text?: string } | undefined): string {
  if (!node) return "";
  if (node.type === "text") return (node.text ?? "").slice(-1);
  return node.type === "hardBreak" ? "\n" : "x";
}

export function segmentsToText(segments: Segment[]): string {
  return segments.map((s) => s.text).join("");
}

// One-line summary for pickers and the References panel: "Scholl et al. · 2021 · Nature".
export function referenceSummary(entry: BibEntry): { authors: string; year: string; venue: string; title: string } {
  const authors = entry.author ?? [];
  const names = authors.length === 0 ? "" : authors.length === 1 ? familyOf(authors[0]) : authors.length === 2 ? `${familyOf(authors[0])} & ${familyOf(authors[1])}` : `${familyOf(authors[0])} et al.`;
  return {
    authors: names,
    year: String(yearOf(entry) ?? "n.d."),
    venue: isPreprint(entry) ? `arXiv:${entry.arxiv}` : (journalShort(entry) ?? entry.publisher ?? ""),
    title: entry.title ?? "Untitled",
  };
}
