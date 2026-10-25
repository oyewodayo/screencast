import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { xml2js } from "xml-js";
import type { JSONContent } from "@tiptap/core";
import { latexToUnicode, normalizeCsl, parseBibName, parseBibtex, parseReferenceInput, staticBibliography, toBibtex, type BibEntry, type CitationStyleId } from "./docBibliography";
import { buildCitationContext, citationSpaceBefore, formatCitation, formatReference, initials, segmentsToText } from "./docCitationStyles";
import { computeStructureFromJson, crossRefText } from "./docStructure";
import { formatNumeral, parseNumeral, readNumbering } from "./docNumbering";
import { docJsonToMarkdown } from "./docMarkdown";
import { buildDocxBytes } from "./docDocx";

const scholl: BibEntry = {
  id: "scholl",
  type: "article-journal",
  title: "Quantum simulation of 2D antiferromagnets with hundreds of Rydberg atoms",
  author: [
    { family: "Scholl", given: "Pascal" },
    { family: "Schuler", given: "Michael" },
    { family: "Williams", given: "Hannah J." },
    { family: "Eberharter", given: "Alexander A." },
    { family: "Barredo", given: "Daniel" },
    { family: "Schymik", given: "Kai-Niklas" },
    { family: "Lienhard", given: "Vincent" },
    { family: "Henry", given: "Louis-Paul" },
    { family: "Lang", given: "Thomas C." },
    { family: "Lahaye", given: "Thierry" },
    { family: "Läuchli", given: "Andreas M." },
    { family: "Browaeys", given: "Antoine" },
  ],
  issued: { "date-parts": [[2021, 7, 7]] },
  "container-title": "Nature",
  volume: "595",
  issue: "7866",
  page: "233–238",
  DOI: "10.1038/s41586-021-03585-1",
};

const leclerc: BibEntry = {
  id: "leclerc",
  type: "article",
  title: "Quantum twin of a frustrated magnet",
  author: [
    { family: "Leclerc", given: "Lucas" },
    { family: "Henry", given: "Louis-Paul" },
  ],
  issued: { "date-parts": [[2026]] },
  arxiv: "2603.20372",
  publisher: "arXiv",
};

const format = (entry: BibEntry, style: CitationStyleId, cited: BibEntry[] = [entry]) => {
  const ctx = buildCitationContext(cited.map((e) => e.id), (id) => cited.find((e) => e.id === id), style);
  return segmentsToText(formatReference(entry, ctx).segments);
};

describe("reference styles", () => {
  it("Nature: first author et al. beyond five, italic journal, bold volume, page range", () => {
    expect(format(scholl, "nature")).toBe("Scholl, P. et al. Quantum simulation of 2D antiferromagnets with hundreds of Rydberg atoms. Nature 595, 233–238 (2021).");
    expect(format(leclerc, "nature")).toBe("Leclerc, L. & Henry, L.-P. Quantum twin of a frustrated magnet. Preprint at https://arxiv.org/abs/2603.20372 (2026).");
  });

  it("APS: first page only, et al. beyond ten authors, arXiv identifier", () => {
    expect(format(scholl, "aps")).toBe("P. Scholl et al., Quantum simulation of 2D antiferromagnets with hundreds of Rydberg atoms, Nature 595, 233 (2021).");
    expect(format(leclerc, "aps")).toBe("L. Leclerc and L.-P. Henry, Quantum twin of a frustrated magnet, arXiv:2603.20372.");
  });

  it("IEEE: quoted title, vol./no./pp., abbreviated month, doi", () => {
    expect(format(scholl, "ieee")).toBe(
      "P. Scholl et al., “Quantum simulation of 2D antiferromagnets with hundreds of Rydberg atoms,” Nature, vol. 595, no. 7866, pp. 233–238, Jul. 2021, doi: 10.1038/s41586-021-03585-1."
    );
  });

  it("APA 7: every author up to 20, ampersand, italic volume, DOI link", () => {
    expect(format(scholl, "apa")).toBe(
      "Scholl, P., Schuler, M., Williams, H. J., Eberharter, A. A., Barredo, D., Schymik, K.-N., Lienhard, V., Henry, L.-P., Lang, T. C., Lahaye, T., Läuchli, A. M., & Browaeys, A. (2021). Quantum simulation of 2D antiferromagnets with hundreds of Rydberg atoms. Nature, 595(7866), 233–238. https://doi.org/10.1038/s41586-021-03585-1"
    );
  });

  it("marks the journal italic and the Nature volume bold", () => {
    const ctx = buildCitationContext(["scholl"], () => scholl, "nature");
    const segs = formatReference(scholl, ctx).segments;
    expect(segs.find((s) => s.text === "Nature")?.italic).toBe(true);
    expect(segs.find((s) => s.text === "595")?.bold).toBe(true);
  });

  it("never doubles punctuation after a title ending in a question mark", () => {
    const q: BibEntry = { id: "q", type: "article-journal", title: "Is it a spin liquid?", author: [{ family: "Doe", given: "J." }], issued: { "date-parts": [[2020]] }, "container-title": "Phys. Rev. B", volume: "1", page: "1" };
    expect(format(q, "nature")).toBe("Doe, J. Is it a spin liquid? Phys. Rev. B 1, 1 (2020).");
  });

  it("builds initials from hyphenated and dotted given names", () => {
    expect(initials("Jean-Pierre")).toBe("J.-P.");
    expect(initials("H.J.")).toBe("H. J.");
    expect(initials("Hannah Jane")).toBe("H. J.");
  });
});

describe("in-text citations", () => {
  const refs = ["a", "b", "c", "d", "e"].map((id, i): BibEntry => ({ id, type: "article-journal", title: `Paper ${id}`, author: [{ family: `Author${id.toUpperCase()}` }], issued: { "date-parts": [[2020 + i]] } }));
  const lookup = (id: string) => refs.find((r) => r.id === id);

  it("compresses runs of three or more into ranges, per style", () => {
    const ids = ["a", "b", "c", "e"];
    expect(formatCitation(ids, null, lookup, buildCitationContext(["a", "b", "c", "d", "e"], lookup, "nature")).text).toBe("1–3,5");
    expect(formatCitation(ids, null, lookup, buildCitationContext(["a", "b", "c", "d", "e"], lookup, "aps")).text).toBe("[1–3, 5]");
    expect(formatCitation(ids, null, lookup, buildCitationContext(["a", "b", "c", "d", "e"], lookup, "ieee")).text).toBe("[1]–[3], [5]");
    expect(formatCitation(["a", "b"], null, lookup, buildCitationContext(["a", "b"], lookup, "aps")).text).toBe("[1, 2]");
  });

  it("puts a no-break space before bracketed and author-date citations, never before superscripts", () => {
    expect(citationSpaceBefore("s", false)).toBe("\u00a0");
    expect(citationSpaceBefore(" ", false)).toBe("");
    expect(citationSpaceBefore("(", false)).toBe("");
    expect(citationSpaceBefore("s", true)).toBe("");
    expect(citationSpaceBefore("", false)).toBe("");
    const aps = staticBibliography([scholl, leclerc], "aps");
    const md = docJsonToMarkdown(sample, [], computeStructureFromJson(sample, aps));
    expect(md).toContain("Rydberg arrays\u00a0[1] and [1, 2], see");
  });

  it("adds locators", () => {
    const ctx = buildCitationContext(["a"], lookup, "aps");
    expect(formatCitation(["a"], "p. 12", lookup, ctx).text).toBe("[1, p. 12]");
  });

  it("APA: author-date, alphabetical inside one citation, 2021a/2021b for the same author and year", () => {
    const x: BibEntry = { id: "x", type: "article-journal", title: "Beta result", author: [{ family: "Scholl", given: "P." }, { family: "Ahn", given: "B." }, { family: "Cole", given: "C." }], issued: { "date-parts": [[2021]] } };
    const y: BibEntry = { id: "y", type: "article-journal", title: "Alpha result", author: [{ family: "Scholl", given: "P." }, { family: "Zed", given: "Z." }, { family: "Cole", given: "C." }], issued: { "date-parts": [[2021]] } };
    const z: BibEntry = { id: "z", type: "book", title: "Book", author: [{ family: "Browaeys", given: "A." }], issued: { "date-parts": [[2019]] } };
    const all = [x, y, z];
    const look = (id: string) => all.find((e) => e.id === id);
    const ctx = buildCitationContext(["x", "y", "z"], look, "apa");
    expect(formatCitation(["x", "z"], null, look, ctx).text).toBe("(Browaeys, 2019; Scholl et al., 2021a)");
    expect(formatCitation(["y"], null, look, ctx).text).toBe("(Scholl et al., 2021b)");
    expect(ctx.ordered.map((e) => e.id)).toEqual(["z", "x", "y"]);
  });

  it("shows a missing reference as ?", () => {
    const ctx = buildCitationContext([], lookup, "aps");
    expect(formatCitation(["gone"], null, lookup, ctx)).toMatchObject({ text: "[?]", missing: true });
  });
});

describe("BibTeX", () => {
  it("parses entries, @string macros, months, braces, quotes and concatenation", () => {
    const { entries, errors } = parseBibtex(String.raw`
      @string{prl = "Phys. Rev. Lett."}
      % a comment line
      @article{Scholl2021,
        author = {Scholl, Pascal and Schuler, Michael and L{\"a}uchli, Andreas M. and Browaeys, Antoine},
        title = {Quantum simulation of {2D} antiferromagnets with hundreds of {R}ydberg atoms},
        journal = prl # " (test)",
        year = 2021, month = jul,
        volume = {595}, number = {7866}, pages = {233--238},
        doi = {https://doi.org/10.1038/s41586-021-03585-1},
      }
      @misc{Leclerc2026, author = "Lucas Leclerc and Louis-Paul Henry", title = "Quantum twin", eprint = {2603.20372v2}, archivePrefix = {arXiv}, year = {2026}}
    `);
    expect(errors).toEqual([]);
    expect(entries).toHaveLength(2);
    const [a, b] = entries;
    expect(a.type).toBe("article-journal");
    expect(a.title).toBe("Quantum simulation of 2D antiferromagnets with hundreds of Rydberg atoms");
    expect(a["container-title"]).toBe("Phys. Rev. Lett. (test)");
    expect(a.author?.[2]).toEqual({ family: "Läuchli", given: "Andreas M." });
    expect(a.issued).toEqual({ "date-parts": [[2021, 7]] });
    expect(a.page).toBe("233–238");
    expect(a.DOI).toBe("10.1038/s41586-021-03585-1");
    expect(a.citationKey).toBe("Scholl2021");
    expect(b.arxiv).toBe("2603.20372");
    expect(b.type).toBe("article");
    expect(b.author?.[1]).toEqual({ given: "Louis-Paul", family: "Henry" });
  });

  it("handles von particles, Jr and institutional authors", () => {
    expect(parseBibName("Ludwig van Beethoven")).toEqual({ given: "Ludwig", "non-dropping-particle": "van", family: "Beethoven" });
    expect(parseBibName("van der Waals, Johannes")).toEqual({ family: "Waals", "non-dropping-particle": "van der", given: "Johannes" });
    expect(parseBibName("King, Jr, Martin Luther")).toEqual({ family: "King", given: "Martin Luther", suffix: "Jr" });
    expect(parseBibName("{CMS Collaboration}")).toEqual({ literal: "CMS Collaboration" });
  });

  it("converts LaTeX to Unicode without mangling Greek or other commands", () => {
    expect(latexToUnicode(String.raw`Schr{\"o}dinger \'Etienne \c{c}a {\v S}koda {\ss} {\o} --- \emph{in situ} $\delta$-$\beta$ 50\% \& more`)).toBe("Schrödinger Étienne ça Škoda ß ø — in situ δ-β 50% & more");
    // A control word swallows the space after it, as in LaTeX itself.
    expect(latexToUnicode(String.raw`Gro\ss e`)).toBe("Große");
    expect(latexToUnicode(String.raw`TmMgGaO$_4$`)).toBe("TmMgGaO₄");
    expect(latexToUnicode(String.raw`Mn$^{2+}$ and $T_c$`)).toBe("Mn²⁺ and T_c");
  });

  it("reports malformed entries but keeps the good ones", () => {
    const { entries } = parseBibtex("@article{ok, title={Fine}, author={A, B}} @article{bad, title=}");
    expect(entries.map((e) => e.title)).toEqual(["Fine"]);
  });

  it("round-trips through toBibtex", () => {
    const text = toBibtex(scholl);
    expect(text).toMatch(/^@article\{Scholl2021quantum,/);
    const [back] = parseBibtex(text).entries;
    expect(back.title).toBe(scholl.title);
    expect(back.author).toHaveLength(12);
    expect(back.DOI).toBe(scholl.DOI);
  });
});

describe("reference input", () => {
  it("recognises DOIs, doi.org links, arXiv IDs and links, and BibTeX", () => {
    expect(parseReferenceInput("10.1038/s41586-021-03585-1")).toEqual({ kind: "doi", doi: "10.1038/s41586-021-03585-1" });
    expect(parseReferenceInput("https://doi.org/10.1103/PhysRevLett.120.180502.")).toEqual({ kind: "doi", doi: "10.1103/PhysRevLett.120.180502" });
    expect(parseReferenceInput("doi: 10.1126/science.abi8794")).toEqual({ kind: "doi", doi: "10.1126/science.abi8794" });
    expect(parseReferenceInput("arXiv:2603.20372v2")).toEqual({ kind: "doi", doi: "10.48550/arXiv.2603.20372" });
    expect(parseReferenceInput("https://arxiv.org/abs/2603.20372")).toEqual({ kind: "doi", doi: "10.48550/arXiv.2603.20372" });
    expect(parseReferenceInput("hep-th/9901001")).toEqual({ kind: "doi", doi: "10.48550/arXiv.hep-th/9901001" });
    expect(parseReferenceInput("@article{x, title={y}}").kind).toBe("bibtex");
    expect(parseReferenceInput("Scholl et al. Nature").kind).toBe("unknown");
  });

  it("normalizes Crossref and DataCite CSL-JSON", () => {
    const crossref = normalizeCsl({
      type: "journal-article",
      title: "Quantum <i>simulation</i> of 2D antiferromagnets",
      author: [{ family: "Scholl", given: "Pascal" }],
      issued: { "date-parts": [[2021, 6, 9]] },
      "container-title": ["Nature"],
      "short-container-title": ["Nature"],
      page: "233-238",
      DOI: "10.1038/S41586-021-03585-1",
    });
    expect(crossref).toMatchObject({ type: "article-journal", title: "Quantum simulation of 2D antiferromagnets", "container-title": "Nature", page: "233–238" });
    const datacite = normalizeCsl({ type: "article", title: "Quantum twin", author: [{ family: "Leclerc", given: "Lucas" }], issued: { "date-parts": [[2026]] }, DOI: "10.48550/ARXIV.2603.20372", publisher: "arXiv" });
    expect(datacite).toMatchObject({ type: "article", arxiv: "2603.20372", publisher: "arXiv", DOI: "10.48550/arXiv.2603.20372" });
  });
});

const doc = (content: JSONContent[]): JSONContent => ({ type: "doc", content });
const p = (...content: JSONContent[]): JSONContent => ({ type: "paragraph", content });
const text = (t: string): JSONContent => ({ type: "text", text: t });
const cite = (...refIds: string[]): JSONContent => ({ type: "citation", attrs: { refIds, locator: null } });
const xref = (targetId: string): JSONContent => ({ type: "crossRef", attrs: { targetId } });
const caption = (kind: "figure" | "table", id: string, t: string): JSONContent => ({ type: "caption", attrs: { kind, id }, content: [text(t)] });

const sample = doc([
  { type: "tableOfContents", attrs: { maxLevel: 2 } },
  { type: "heading", attrs: { level: 1 }, content: [text("Introduction")] },
  p(text("Rydberg arrays"), cite("leclerc"), text(" and "), cite("scholl", "leclerc"), text(", see "), xref("fig2"), text(" and "), xref("eq1"), text(".")),
  caption("figure", "fig1", "Setup."),
  caption("table", "tab1", "Parameters."),
  { type: "heading", attrs: { level: 2 }, content: [text("Model")] },
  { type: "mathBlock", attrs: { latex: "H = J", numbered: true, id: "eq1" } },
  caption("figure", "fig2", "Phase diagram."),
  p(xref("deleted")),
  { type: "heading", attrs: { level: 2 }, content: [text("References")] },
  { type: "bibliography" },
]);
const library = staticBibliography([scholl, leclerc], "nature");

describe("document structure", () => {
  it("numbers figures, tables and equations separately, in document order", () => {
    const s = computeStructureFromJson(sample, library);
    // A no-break space: a cross-reference never splits across lines.
    expect(s.targets.get("fig1")?.label).toBe("Figure 1");
    expect(s.targets.get("fig2")?.label).toBe("Figure 2");
    expect(s.targets.get("tab1")?.label).toBe("Table 1");
    expect(s.targets.get("eq1")?.label).toBe("Eq. (1)");
    expect(s.headings.map((h) => h.text)).toEqual(["Introduction", "Model", "References"]);
  });

  it("follows the document's numbering style: APS captions, roman tables, short references", () => {
    const aps = { ...library, numbering: () => readNumbering({
      figure: { caption: "FIG.", ref: "Fig.", numerals: "arabic" },
      table: { caption: "TABLE", ref: "Table", numerals: "upper-roman" },
      boldCaptionLabel: false,
    }) };
    const s = computeStructureFromJson(sample, aps);
    expect(s.targets.get("fig2")?.captionLabel).toBe("FIG. 2");
    expect(s.targets.get("fig2")?.label).toBe("Fig. 2");
    expect(s.targets.get("tab1")?.captionLabel).toBe("TABLE I");
    expect(s.targets.get("tab1")?.numberText).toBe("I");
    expect(crossRefText(s.targets.get("eq1")!, "number")).toBe("(1)");
    const md = docJsonToMarkdown(sample, [], s);
    expect(md).toContain("**TABLE I.** Parameters.");
  });

  it("reads numerals back from print", () => {
    expect(parseNumeral("IV")).toEqual({ n: 4, style: "upper-roman" });
    expect(parseNumeral("XII")).toEqual({ n: 12, style: "upper-roman" });
    expect(parseNumeral("IIII")).toBeNull();
    expect(parseNumeral("12")).toEqual({ n: 12, style: "arabic" });
    expect(formatNumeral(14, "upper-roman")).toBe("XIV");
    expect(formatNumeral(28, "upper-alpha")).toBe("AB");
  });

  it("numbers references by first citation and builds the reference list in that order", () => {
    const s = computeStructureFromJson(sample, library);
    expect(s.citedIds).toEqual(["leclerc", "scholl"]);
    expect(s.bibliography.map((r) => r.label)).toEqual(["1.", "2."]);
    expect(formatCitation(["scholl", "leclerc"], null, s.lookup, s.context).text).toBe("1,2");
  });
});

describe("structure in exports", () => {
  it("Markdown: labelled captions with anchors, linked cross-references, citations, reference list, contents", () => {
    const s = computeStructureFromJson(sample, library);
    const md = docJsonToMarkdown(sample, [], s);
    expect(md).toContain("Rydberg arrays<sup>1</sup> and <sup>1,2</sup>, see [Figure 2](#fig2) and [Eq. (1)](#eq1).");
    expect(md).toContain('<a id="fig2"></a>**Figure 2.** Phase diagram.');
    expect(md).toContain("**Table 1.** Parameters.");
    expect(md).toContain("??");
    expect(md).toContain("**Contents**\n\n- [Introduction](#introduction)\n  - [Model](#model)\n  - [References](#references)");
    expect(md).toContain("1. Leclerc, L. & Henry, L.-P. Quantum twin of a frustrated magnet. Preprint at <https://arxiv.org/abs/2603.20372> (2026).");
    expect(md).toContain("2. Scholl, P. et al. Quantum simulation");
  });

  it(".docx: bookmarked captions, internal links, superscript citations, reference list and a TOC field", async () => {
    const s = computeStructureFromJson(sample, library);
    const bytes = await buildDocxBytes(sample, "Test", { structure: s, headingPages: [1, 2, 3] });
    const xml = await (await JSZip.loadAsync(bytes)).file("word/document.xml")!.async("string");
    expect(() => xml2js(xml)).not.toThrow();
    expect(xml).toContain('w:name="ref_fig2"');
    expect(xml).toContain('w:anchor="ref_fig2"');
    expect(xml).toContain('w:anchor="ref_eq1"');
    expect(xml).toContain("Figure 2.");
    expect(xml).toContain("Table 1.");
    expect(xml).toContain('<w:vertAlign w:val="superscript"/>');
    expect(xml).toContain("Quantum simulation of 2D antiferromagnets with hundreds of Rydberg atoms. ");
    expect(xml).toContain("TOC \\h \\o &quot;1-2&quot;");
    expect(xml).not.toContain('w:dirty="true"');
    // Every bookmark id unique - duplicates make Word repair the file.
    const ids = [...xml.matchAll(/<w:bookmarkStart[^>]*w:id="(\d+)"/g)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(4);
    expect(new Set(ids).size).toBe(ids.length);
    expect(xml).toContain('w:name="_Toc_h1"');
    expect(xml).toContain(">Model<");
  });
});
