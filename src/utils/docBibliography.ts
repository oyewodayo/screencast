// utils/docBibliography.ts
//
// A document's reference library - every work it can cite - stored as CSL-JSON (the format
// Zotero, Mendeley, Crossref and citeproc all speak) inside the document's own Y.Doc, in a Y.Map
// beside the ProseMirror fragment. Living in the Y.Doc means references autosave, travel with the
// document, appear in version history and are restored with it, exactly like the text that cites
// them - no separate store to drift out of sync.
//
// Entries arrive three ways: a DOI or arXiv ID resolved over the network (Rust `lookup_doi`,
// content-negotiated CSL-JSON from doi.org), a pasted BibTeX snippet, or a .bib file. Everything
// is normalized to the same CSL shape on the way in, so the formatters in docCitationStyles.ts
// only ever see one format.
import * as Y from "yjs";

export interface CslName {
  family?: string;
  given?: string;
  literal?: string;
  "non-dropping-particle"?: string;
  suffix?: string;
}

export interface CslDate {
  "date-parts"?: (number | string)[][];
  literal?: string;
  raw?: string;
}

export interface BibEntry {
  // Stable internal id - what citation nodes point at. Never the BibTeX key, which a re-import
  // could legitimately change.
  id: string;
  // CSL type: article-journal, book, chapter, paper-conference, thesis, report, webpage,
  // manuscript, article (preprints), ...
  type: string;
  title?: string;
  author?: CslName[];
  editor?: CslName[];
  issued?: CslDate;
  "container-title"?: string;
  "container-title-short"?: string;
  "collection-title"?: string;
  volume?: string;
  issue?: string;
  page?: string;
  "article-number"?: string;
  DOI?: string;
  URL?: string;
  publisher?: string;
  "publisher-place"?: string;
  edition?: string;
  number?: string;
  genre?: string;
  note?: string;
  ISBN?: string;
  // arXiv identifier (e.g. "2603.20372") for preprints - from a DataCite DOI or a BibTeX eprint.
  arxiv?: string;
  // The BibTeX key it was imported with, kept for exporting back to BibTeX and for de-duplication.
  citationKey?: string;
  addedAt?: number;
}

export type CitationStyleId = "nature" | "aps" | "ieee" | "apa";

export const DEFAULT_CITATION_STYLE: CitationStyleId = "nature";

const LIBRARY_KEY = "bibliography";
const SETTINGS_KEY = "docSettings";

// What the structure plugin and the UI need from a library - satisfied by the live Y.Doc-backed
// store below and by a frozen snapshot for the version-history preview.
export interface BibliographySource {
  get(id: string): BibEntry | undefined;
  all(): BibEntry[];
  style(): CitationStyleId;
  subscribe(listener: () => void): () => void;
}

export class BibliographyStore implements BibliographySource {
  private library: Y.Map<BibEntry>;
  private settings: Y.Map<unknown>;
  private cache: BibEntry[] | null = null;

  constructor(private ydoc: Y.Doc) {
    this.library = ydoc.getMap<BibEntry>(LIBRARY_KEY);
    this.settings = ydoc.getMap<unknown>(SETTINGS_KEY);
    this.library.observe(() => {
      this.cache = null;
    });
  }

  get(id: string): BibEntry | undefined {
    return this.library.get(id);
  }

  all(): BibEntry[] {
    if (!this.cache) this.cache = Array.from(this.library.values()).sort((a, b) => (a.addedAt ?? 0) - (b.addedAt ?? 0));
    return this.cache;
  }

  style(): CitationStyleId {
    const value = this.settings.get("citationStyle");
    return isCitationStyle(value) ? value : DEFAULT_CITATION_STYLE;
  }

  setStyle(style: CitationStyleId): void {
    this.settings.set("citationStyle", style);
  }

  // Adds entries, skipping any already in the library (same DOI, arXiv ID, BibTeX key, or title
  // and year). Returns the ids now holding each input, existing or new, in input order - so
  // "add and cite" works even when the reference was already there.
  add(entries: Omit<BibEntry, "id">[]): { ids: string[]; added: number } {
    const ids: string[] = [];
    let added = 0;
    this.ydoc.transact(() => {
      for (const entry of entries) {
        const existing = this.findDuplicate(entry);
        if (existing) {
          ids.push(existing.id);
          continue;
        }
        const id = crypto.randomUUID();
        this.library.set(id, stripUndefined({ ...entry, id, addedAt: Date.now() + added }));
        ids.push(id);
        added++;
      }
    });
    return { ids, added };
  }

  update(id: string, entry: Omit<BibEntry, "id">): void {
    const current = this.library.get(id);
    if (!current) return;
    this.library.set(id, stripUndefined({ ...entry, id, addedAt: current.addedAt }));
  }

  remove(id: string): void {
    this.library.delete(id);
  }

  subscribe(listener: () => void): () => void {
    const onChange = () => listener();
    this.library.observe(onChange);
    this.settings.observe(onChange);
    return () => {
      this.library.unobserve(onChange);
      this.settings.unobserve(onChange);
    };
  }

  private findDuplicate(entry: Omit<BibEntry, "id">): BibEntry | undefined {
    const doi = entry.DOI?.toLowerCase();
    const titleKey = fingerprint(entry);
    return this.all().find(
      (e) =>
        (doi && e.DOI?.toLowerCase() === doi) ||
        (entry.arxiv && e.arxiv === entry.arxiv) ||
        (entry.citationKey && e.citationKey === entry.citationKey && fingerprint(e) === titleKey) ||
        (titleKey !== null && fingerprint(e) === titleKey)
    );
  }
}

// A frozen library (version-history preview) - read once from a scratch Y.Doc before it's freed.
export function snapshotBibliography(ydoc: Y.Doc): BibliographySource {
  const entries = new Map<string, BibEntry>(Object.entries(ydoc.getMap<BibEntry>(LIBRARY_KEY).toJSON() as Record<string, BibEntry>));
  const styleValue = ydoc.getMap(SETTINGS_KEY).get("citationStyle");
  const style = isCitationStyle(styleValue) ? styleValue : DEFAULT_CITATION_STYLE;
  return staticBibliography([...entries.values()], style);
}

export function staticBibliography(entries: BibEntry[], style: CitationStyleId = DEFAULT_CITATION_STYLE): BibliographySource {
  const byId = new Map(entries.map((e) => [e.id, e]));
  return { get: (id) => byId.get(id), all: () => entries, style: () => style, subscribe: () => () => {} };
}

export function isCitationStyle(value: unknown): value is CitationStyleId {
  return value === "nature" || value === "aps" || value === "ieee" || value === "apa";
}

function stripUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0))) as T;
}

function fingerprint(entry: Omit<BibEntry, "id">): string | null {
  if (!entry.title) return null;
  const title = entry.title.toLowerCase().replace(/[^a-z0-9]+/g, "");
  return title.length < 12 ? null : `${title}:${issuedYear(entry) ?? ""}`;
}

export function issuedYear(entry: Pick<BibEntry, "issued">): number | null {
  const part = entry.issued?.["date-parts"]?.[0]?.[0];
  const year = typeof part === "string" ? parseInt(part, 10) : part;
  if (typeof year === "number" && !Number.isNaN(year)) return year;
  const match = (entry.issued?.literal ?? entry.issued?.raw ?? "").match(/\b(1[5-9]\d\d|2\d\d\d)\b/);
  return match ? parseInt(match[1], 10) : null;
}

// ----------------------------------------------------------------------------------------------
// Identifiers

export type ReferenceInput = { kind: "doi"; doi: string } | { kind: "bibtex"; text: string } | { kind: "unknown" };

const DOI_PATTERN = /\b(10\.\d{4,9}\/[^\s"<>]+)/i;
const ARXIV_NEW = /^(?:arxiv:\s*|https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\/)?(\d{4}\.\d{4,5})(?:v\d+)?(?:\.pdf)?$/i;
const ARXIV_OLD = /^(?:arxiv:\s*|https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\/)?([a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?$/i;

// What the user typed or pasted into "Add reference": a DOI (bare, doi:, or a doi.org link), an
// arXiv ID or link (resolved through arXiv's DataCite DOI, 10.48550/arXiv.<id>), or BibTeX.
export function parseReferenceInput(raw: string): ReferenceInput {
  const text = raw.trim();
  if (!text) return { kind: "unknown" };
  if (/^\s*@\w+\s*[{(]/.test(text)) return { kind: "bibtex", text };
  const arxiv = text.match(ARXIV_NEW) ?? text.match(ARXIV_OLD);
  if (arxiv) return { kind: "doi", doi: `10.48550/arXiv.${arxiv[1]}` };
  const doi = text.match(DOI_PATTERN);
  if (doi) return { kind: "doi", doi: doi[1].replace(/[.,;)\]]+$/, "") };
  return { kind: "unknown" };
}

// ----------------------------------------------------------------------------------------------
// CSL-JSON from doi.org (Crossref, DataCite)

function stripMarkup(text: string): string {
  return text
    .replace(/<mml:math[\s\S]*?<\/mml:math>/g, (m) => m.replace(/<[^>]+>/g, ""))
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

const first = (value: unknown): string | undefined => {
  const v = Array.isArray(value) ? value[0] : value;
  if (v === undefined || v === null || v === "") return undefined;
  return stripMarkup(String(v));
};

const CROSSREF_TYPES: Record<string, string> = {
  "journal-article": "article-journal",
  "proceedings-article": "paper-conference",
  "book-chapter": "chapter",
  "posted-content": "article",
  dissertation: "thesis",
  "report-component": "report",
  monograph: "book",
  "edited-book": "book",
  "reference-book": "book",
};

export function normalizeCsl(raw: Record<string, unknown>): Omit<BibEntry, "id"> {
  const names = (value: unknown): CslName[] | undefined =>
    Array.isArray(value)
      ? value
          .map((n: Record<string, unknown>) => ({
            family: first(n.family),
            given: first(n.given),
            literal: first(n.literal ?? n.name),
            "non-dropping-particle": first(n["non-dropping-particle"]),
            suffix: first(n.suffix),
          }))
          .map((n) => stripUndefined(n))
          .filter((n) => n.family || n.literal)
      : undefined;
  const publisher = first(raw.publisher);
  const arxivFromDoi = first(raw.DOI)?.match(/10\.48550\/arxiv\.(.+)$/i)?.[1];
  // DataCite reports arXiv DOIs upper-cased (10.48550/ARXIV.…); arXiv's own form is canonical.
  const doi = arxivFromDoi ? `10.48550/arXiv.${arxivFromDoi}` : first(raw.DOI)?.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "");
  const type = String(raw.type ?? "article-journal");
  const issued = (raw.issued ?? raw["published-print"] ?? raw["published-online"] ?? raw.published) as CslDate | undefined;
  const entry: Omit<BibEntry, "id"> = {
    type: arxivFromDoi ? "article" : (CROSSREF_TYPES[type] ?? type),
    title: first(raw.title),
    author: names(raw.author),
    editor: names(raw.editor),
    issued: issued && (issued["date-parts"]?.[0]?.[0] || issued.literal || issued.raw) ? issued : undefined,
    "container-title": first(raw["container-title"]),
    "container-title-short": first(raw["container-title-short"] ?? raw["short-container-title"] ?? raw["journalAbbreviation"]),
    "collection-title": first(raw["collection-title"]),
    volume: first(raw.volume),
    issue: first(raw.issue),
    page: first(raw.page)?.replace(/-+/g, "–"),
    "article-number": first(raw["article-number"] ?? raw.number),
    DOI: doi,
    URL: first(raw.URL),
    publisher: arxivFromDoi ? "arXiv" : publisher,
    "publisher-place": first(raw["publisher-place"]),
    edition: first(raw.edition),
    ISBN: first(raw.ISBN),
    arxiv: arxivFromDoi,
  };
  // An article number is only interesting when there are no pages (Phys. Rev. style "033038").
  if (entry.page) delete entry["article-number"];
  return stripUndefined(entry);
}

// ----------------------------------------------------------------------------------------------
// BibTeX

const LATEX_ACCENTS: Record<string, string> = {
  "`": "̀",
  "'": "́",
  "^": "̂",
  "~": "̃",
  "=": "̄",
  u: "̆",
  ".": "̇",
  '"': "̈",
  r: "̊",
  H: "̋",
  v: "̌",
  c: "̧",
  k: "̨",
  d: "̣",
  b: "̱",
};
const LATEX_SYMBOLS: Record<string, string> = {
  ss: "ß",
  o: "ø",
  O: "Ø",
  ae: "æ",
  AE: "Æ",
  oe: "œ",
  OE: "Œ",
  aa: "å",
  AA: "Å",
  l: "ł",
  L: "Ł",
  i: "ı",
  j: "ȷ",
  dh: "ð",
  DH: "Ð",
  th: "þ",
  TH: "Þ",
  textendash: "–",
  textemdash: "—",
  textquoteright: "’",
  textquoteleft: "‘",
  textquotedblleft: "“",
  textquotedblright: "”",
  ldots: "…",
  dots: "…",
  textregistered: "®",
  copyright: "©",
  S: "§",
  P: "¶",
  textdegree: "°",
  alpha: "α",
  beta: "β",
  gamma: "γ",
  delta: "δ",
  epsilon: "ε",
  mu: "μ",
  pi: "π",
  sigma: "σ",
  tau: "τ",
  phi: "φ",
  chi: "χ",
  psi: "ψ",
  omega: "ω",
  Gamma: "Γ",
  Delta: "Δ",
  Omega: "Ω",
};

const SUBSCRIPTS: Record<string, string> = { "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄", "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉", "+": "₊", "-": "₋", "=": "₌", "(": "₍", ")": "₎" };
const SUPERSCRIPTS: Record<string, string> = { "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹", "+": "⁺", "-": "⁻", "=": "⁼", "(": "⁽", ")": "⁾", n: "ⁿ" };

function mathScripts(math: string): string {
  const convert = (text: string, table: Record<string, string>, marker: string) =>
    text && [...text].every((ch) => table[ch]) ? [...text].map((ch) => table[ch]).join("") : `${marker}${text}`;
  return math
    .replace(/_\{([^{}]*)\}|_(.)/g, (_m, braced?: string, single?: string) => convert(braced ?? single ?? "", SUBSCRIPTS, "_"))
    .replace(/\^\{([^{}]*)\}|\^(.)/g, (_m, braced?: string, single?: string) => convert(braced ?? single ?? "", SUPERSCRIPTS, "^"));
}

// LaTeX markup as found in .bib files -> plain Unicode text: accents (\"{o}, \'e, {\v s}),
// special letters (\ss, \o), text commands (\emph{x}), escapes (\&), dashes and ties.
export function latexToUnicode(input: string): string {
  let s = input;
  // \emph{x}, \textit{x}, \textbf{x}, \mathrm{x}, ... -> x
  for (let i = 0; i < 4; i++) s = s.replace(/\\(?:emph|textit|textbf|textsc|textrm|textsf|texttt|mathrm|mathit|mathbf|mbox|text|url)\s*\{([^{}]*)\}/g, "$1");
  // Accents: symbol accents take their letter directly (\"o, \'{e}); letter accents (\c, \v, \u,
  // \d, ...) need a brace or a space first, or \delta and \beta would read as \d + "elta".
  const accent = (m: string, cmd: string, braced?: string, bare?: string) => {
    const mark = LATEX_ACCENTS[cmd];
    const letter = braced ?? bare;
    return mark && letter ? (letter + mark).normalize("NFC") : m;
  };
  s = s.replace(/\\([`'^~=".])\s*(?:\{\\?([a-zA-Z])\}|\\?([a-zA-Z]))/g, accent);
  s = s.replace(/\\([uvHcrkdb])(?:\s*\{\\?([a-zA-Z])\}|\s+\\?([a-zA-Z])(?![a-zA-Z]))/g, accent);
  s = s.replace(/\\([a-zA-Z]+)(?:\{\}|\s?)/g, (m, name: string) => LATEX_SYMBOLS[name] ?? m);
  s = s
    .replace(/\\([&%$#_{}])/g, "$1")
    .replace(/---/g, "—")
    .replace(/--/g, "–")
    .replace(/(?<!\\)~/g, "\u00a0")
    .replace(/``/g, "“")
    .replace(/''/g, "”")
    // Inline math: keep its text without the dollars ($\alpha$ was already mapped above), with
    // sub/superscripts as real Unicode where every character has one (TmMgGaO$_4$ -> TmMgGaO₄).
    .replace(/\$([^$]*)\$/g, (_m, math: string) => mathScripts(math))
    .replace(/\\,/g, " ")
    .replace(/[{}]/g, "")
    .replace(/\\(?=\s)/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return s;
}

interface RawBibEntry {
  type: string;
  key: string;
  fields: Record<string, string>;
}

const MONTHS: Record<string, string> = { jan: "1", feb: "2", mar: "3", apr: "4", may: "5", jun: "6", jul: "7", aug: "8", sep: "9", oct: "10", nov: "11", dec: "12" };

class BibTexReader {
  private i = 0;
  private strings: Record<string, string> = { ...MONTHS };
  constructor(private src: string) {}

  read(): { entries: RawBibEntry[]; errors: string[] } {
    const entries: RawBibEntry[] = [];
    const errors: string[] = [];
    while (true) {
      const at = this.src.indexOf("@", this.i);
      if (at < 0) break;
      this.i = at + 1;
      const type = this.readWhile(/[A-Za-z]/).toLowerCase();
      this.skipSpace();
      const open = this.src[this.i];
      if (!type || (open !== "{" && open !== "(")) continue;
      const close = open === "{" ? "}" : ")";
      this.i++;
      try {
        if (type === "comment" || type === "preamble") {
          this.skipBalanced(open, close);
          continue;
        }
        if (type === "string") {
          this.skipSpace();
          const name = this.readWhile(/[^\s=]/).toLowerCase();
          this.skipSpace();
          this.expect("=");
          this.strings[name] = this.readValue();
          this.skipSpace();
          if (this.src[this.i] === close) this.i++;
          continue;
        }
        this.skipSpace();
        const key = this.readWhile(/[^\s,}]/);
        this.skipSpace();
        const fields: Record<string, string> = {};
        while (this.src[this.i] === ",") {
          this.i++;
          this.skipSpace();
          if (this.src[this.i] === close) break;
          const name = this.readWhile(/[^\s=,}]/).toLowerCase();
          if (!name) break;
          this.skipSpace();
          this.expect("=");
          fields[name] = this.readValue();
          this.skipSpace();
        }
        if (this.src[this.i] === close) this.i++;
        entries.push({ type, key, fields });
      } catch (err) {
        errors.push(`@${type}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { entries, errors };
  }

  private readWhile(pattern: RegExp): string {
    const start = this.i;
    while (this.i < this.src.length && pattern.test(this.src[this.i])) this.i++;
    return this.src.slice(start, this.i);
  }

  private skipSpace(): void {
    while (this.i < this.src.length && /\s/.test(this.src[this.i])) this.i++;
  }

  private expect(ch: string): void {
    if (this.src[this.i] !== ch) throw new Error(`expected "${ch}" at character ${this.i}`);
    this.i++;
  }

  private skipBalanced(open: string, close: string): void {
    let depth = 1;
    while (this.i < this.src.length && depth > 0) {
      if (this.src[this.i] === open) depth++;
      else if (this.src[this.i] === close) depth--;
      this.i++;
    }
  }

  // value = part ("#" part)*, part = {braced} | "quoted" | number | @string name
  private readValue(): string {
    let out = "";
    while (true) {
      this.skipSpace();
      const ch = this.src[this.i];
      if (ch === "{") {
        this.i++;
        const start = this.i;
        this.skipBalanced("{", "}");
        out += this.src.slice(start, this.i - 1);
      } else if (ch === '"') {
        this.i++;
        const start = this.i;
        let depth = 0;
        while (this.i < this.src.length && !(this.src[this.i] === '"' && depth === 0)) {
          if (this.src[this.i] === "{") depth++;
          else if (this.src[this.i] === "}") depth--;
          this.i++;
        }
        out += this.src.slice(start, this.i);
        this.i++;
      } else {
        const word = this.readWhile(/[^\s,#}")]/);
        if (!word) throw new Error(`missing value at character ${this.i}`);
        out += /^\d+$/.test(word) ? word : (this.strings[word.toLowerCase()] ?? word);
      }
      this.skipSpace();
      if (this.src[this.i] !== "#") return out;
      this.i++;
    }
  }
}

// Splits "A and B and {C and D Inc.}" at top-level " and ".
function splitNames(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (depth === 0 && /\s/.test(ch) && value.slice(i).match(/^\s+and\s+/i)) {
      parts.push(value.slice(start, i));
      const skip = value.slice(i).match(/^\s+and\s+/i)![0].length;
      i += skip - 1;
      start = i + 1;
    }
  }
  parts.push(value.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

function splitTopLevel(value: string, separator: RegExp): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of value) {
    if (ch === "{") depth++;
    if (ch === "}") depth--;
    if (depth === 0 && separator.test(ch)) {
      parts.push(current);
      current = "";
    } else current += ch;
  }
  parts.push(current);
  return parts;
}

// BibTeX's three name forms: "First von Last", "von Last, First", "von Last, Jr, First"; a fully
// braced name ("{CMS Collaboration}") is an institution, kept literal.
export function parseBibName(raw: string): CslName {
  const name = raw.trim();
  if (/^\{[^{}]*\}$/.test(name) || /^\{.*\}$/.test(name) && !name.slice(1, -1).includes("}")) {
    return { literal: latexToUnicode(name) };
  }
  if (name.toLowerCase() === "others") return { literal: "others" };
  const commaParts = splitTopLevel(name, /,/).map((p) => p.trim());
  const clean = (s: string | undefined) => (s ? latexToUnicode(s) : undefined);
  const isLower = (word: string) => /^[a-z]/.test(word.replace(/^[{\\]+[a-zA-Z]*\s*/, ""));
  if (commaParts.length >= 2) {
    const [vonLast, ...rest] = commaParts;
    const given = rest.length === 2 ? rest[1] : rest[0];
    const suffix = rest.length === 2 ? rest[0] : undefined;
    const words = splitTopLevel(vonLast, /\s/).filter(Boolean);
    let split = 0;
    while (split < words.length - 1 && isLower(words[split])) split++;
    return stripUndefined({
      family: clean(words.slice(split).join(" ")),
      "non-dropping-particle": clean(words.slice(0, split).join(" ")) || undefined,
      given: clean(given) || undefined,
      suffix: clean(suffix) || undefined,
    });
  }
  const words = splitTopLevel(name, /\s/).filter(Boolean);
  if (words.length === 1) return { family: clean(words[0]) };
  // First von Last: the von part starts at the first lowercase word (not the last word).
  let vonStart = words.findIndex((w, i) => i < words.length - 1 && i > 0 && isLower(w));
  if (vonStart < 0) vonStart = words.length - 1;
  let vonEnd = vonStart;
  while (vonEnd < words.length - 1 && isLower(words[vonEnd])) vonEnd++;
  return stripUndefined({
    given: clean(words.slice(0, vonStart).join(" ")) || undefined,
    "non-dropping-particle": clean(words.slice(vonStart, vonEnd).join(" ")) || undefined,
    family: clean(words.slice(vonEnd).join(" ")),
  });
}

const BIBTEX_TYPES: Record<string, string> = {
  article: "article-journal",
  book: "book",
  booklet: "book",
  inbook: "chapter",
  incollection: "chapter",
  inproceedings: "paper-conference",
  conference: "paper-conference",
  phdthesis: "thesis",
  mastersthesis: "thesis",
  thesis: "thesis",
  techreport: "report",
  report: "report",
  manual: "report",
  online: "webpage",
  electronic: "webpage",
  www: "webpage",
  unpublished: "manuscript",
  misc: "article",
};

function bibToCsl(raw: RawBibEntry): Omit<BibEntry, "id"> {
  const f = raw.fields;
  const text = (name: string) => (f[name] ? latexToUnicode(f[name]) : undefined);
  const yearText = text("year") ?? text("date")?.slice(0, 4);
  const year = yearText ? parseInt(yearText.replace(/[^\d]/g, ""), 10) : NaN;
  const monthRaw = (f.month ?? "").trim().toLowerCase();
  const month = parseInt(MONTHS[monthRaw.slice(0, 3)] ?? monthRaw, 10);
  const datePart = (f.date ?? "").match(/^(\d{4})-(\d{1,2})/);
  const issued: CslDate | undefined = !Number.isNaN(year)
    ? { "date-parts": [[year, ...(!Number.isNaN(month) ? [month] : datePart ? [parseInt(datePart[2], 10)] : [])]] }
    : undefined;
  const archive = (f.archiveprefix ?? f.eprinttype ?? "").toLowerCase();
  const eprint = f.eprint?.trim();
  const arxiv = eprint && (archive === "arxiv" || /^\d{4}\.\d{4,5}/.test(eprint)) ? eprint.replace(/^arxiv:/i, "").replace(/v\d+$/, "") : undefined;
  const doi = f.doi?.trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").replace(/^doi:\s*/i, "");
  const journal = text("journal") ?? text("journaltitle");
  let type = BIBTEX_TYPES[raw.type] ?? "article";
  if (type === "article" && journal) type = "article-journal";
  const names = (field: string) => (f[field] ? splitNames(f[field]).map(parseBibName).filter((n) => n.literal !== "others") : undefined);
  const entry: Omit<BibEntry, "id"> = {
    type,
    citationKey: raw.key || undefined,
    title: text("title"),
    author: names("author"),
    editor: names("editor"),
    issued,
    "container-title": journal ?? text("booktitle"),
    "collection-title": text("series"),
    volume: text("volume"),
    issue: text("number") && type !== "report" ? text("number") : (text("issue") ?? undefined),
    number: type === "report" ? text("number") : undefined,
    page: f.pages ? latexToUnicode(f.pages.replace(/\s*-+\s*/g, "--")) : undefined,
    DOI: doi || undefined,
    URL: f.url?.trim(),
    publisher: text("publisher") ?? text("school") ?? text("institution") ?? text("organization") ?? (arxiv && !journal ? "arXiv" : undefined),
    "publisher-place": text("address") ?? text("location"),
    edition: text("edition"),
    genre: raw.type === "phdthesis" ? "PhD thesis" : raw.type === "mastersthesis" ? "Master’s thesis" : text("type"),
    note: text("note"),
    ISBN: f.isbn?.trim(),
    arxiv,
  };
  return stripUndefined(entry);
}

export function parseBibtex(source: string): { entries: Omit<BibEntry, "id">[]; errors: string[] } {
  const { entries, errors } = new BibTexReader(source).read();
  return { entries: entries.map(bibToCsl).filter((e) => e.title || e.author?.length), errors };
}

// ----------------------------------------------------------------------------------------------
// Back to BibTeX (the References panel's "Copy BibTeX" and a future .bib export)

const CSL_TO_BIBTEX: Record<string, string> = {
  "article-journal": "article",
  book: "book",
  chapter: "incollection",
  "paper-conference": "inproceedings",
  thesis: "phdthesis",
  report: "techreport",
  webpage: "online",
  manuscript: "unpublished",
  article: "misc",
};

export function bibKeyFor(entry: BibEntry): string {
  if (entry.citationKey) return entry.citationKey;
  const author = entry.author?.[0];
  const family = (author?.family ?? author?.literal ?? "ref").normalize("NFD").replace(/[^A-Za-z]/g, "");
  const word = (entry.title ?? "").normalize("NFD").replace(/[^A-Za-z\s]/g, "").split(/\s+/).find((w) => w.length > 3 && !/^(the|and|with|from|for|of|on)$/i.test(w)) ?? "";
  return `${family}${issuedYear(entry) ?? ""}${word.toLowerCase()}`;
}

export function toBibtex(entry: BibEntry): string {
  const name = (n: CslName) => n.literal ? `{${n.literal}}` : [n["non-dropping-particle"], n.family].filter(Boolean).join(" ") + (n.suffix ? `, ${n.suffix}` : "") + (n.given ? `, ${n.given}` : "");
  const fields: [string, string | undefined][] = [
    ["author", entry.author?.map(name).join(" and ")],
    ["editor", entry.editor?.map(name).join(" and ")],
    ["title", entry.title && `{${entry.title}}`],
    [entry.type === "article-journal" ? "journal" : "booktitle", entry["container-title"]],
    ["volume", entry.volume],
    ["number", entry.issue ?? entry.number],
    ["pages", entry.page?.replace(/–/g, "--")],
    ["year", issuedYear(entry)?.toString()],
    ["publisher", entry.publisher],
    ["address", entry["publisher-place"]],
    ["doi", entry.DOI],
    ["eprint", entry.arxiv],
    ["archivePrefix", entry.arxiv ? "arXiv" : undefined],
    ["url", entry.URL],
  ];
  const body = fields.filter(([, v]) => v).map(([k, v]) => `  ${k} = {${v}}`).join(",\n");
  return `@${CSL_TO_BIBTEX[entry.type] ?? "misc"}{${bibKeyFor(entry)},\n${body}\n}`;
}
