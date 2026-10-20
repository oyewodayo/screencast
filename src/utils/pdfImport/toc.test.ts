import { describe, expect, it } from "vitest";
import { classifyFont, type Glyph } from "./glyphs";
import { assemble, extractTocEntries, lineText } from "./assemble";
import type { FlowLine, PageElement, TocEntryElement } from "./model";
import type { PageAnalysis } from "./layout";

const font = classifyFont("f1", "TeXGyreTermesX-Regular", null);
const SIZE = 12;
const COL: [number, number] = [105, 524.4];

// A line from pieces placed at given x positions: [[x, "text"], ...]. Characters are 6pt wide,
// spaces 3pt (a word space), pieces separated by whatever gap their x leaves.
function line(page: number, base: number, pieces: [number, string][]): FlowLine {
  const glyphs: Glyph[] = [];
  let item = 0;
  for (const [x0, text] of pieces) {
    let x = x0;
    for (const ch of text) {
      const space = ch === " ";
      const adv = space ? 3 : ch === "." ? 3 : 6;
      glyphs.push({ ch, font, size: SIZE, base, x, adv, x0: x, x1: x + adv, top: base - 8, bottom: base + 2, space, item });
      x += adv;
    }
    item++;
  }
  const vis = glyphs.filter((g) => !g.space);
  return {
    page,
    span: "F",
    glyphs,
    x0: Math.min(...vis.map((g) => g.x)),
    x1: Math.max(...vis.map((g) => g.x + g.adv)),
    base,
    size: SIZE,
    top: base - 8,
    bottom: base + 2,
    colX0: COL[0],
    colX1: COL[1],
  };
}

// Leader dots as LaTeX sets them: ". " repeated up to just before the page number.
const dots = (from: number, to = 500) => " .".repeat(Math.max(0, Math.floor((to - from) / 6)));
const pageNum = (n: string): [number, string] => [COL[1] - n.length * 6, n];

function page(n: number, lines: FlowLine[]): PageAnalysis {
  return {
    page: n,
    width: 595,
    height: 842,
    columns: { twoColumn: false, gutter: 297, left: COL, right: COL, full: COL },
    elements: lines.map((l): PageElement => ({ kind: "line", line: l, y0: l.top, y1: l.bottom, span: "F", page: n })),
    bodySize: SIZE,
    marginal: [],
    rules: [],
  };
}

const entries = (pages: PageAnalysis[]) => pages.flatMap((p) => p.elements.filter((e): e is TocEntryElement => e.kind === "tocEntry"));
const describeEntry = (e: TocEntryElement) => `${e.label}|${e.lines.map(lineText).join(" / ")}|${e.pageRef}`;

describe("contents lists", () => {
  it("splits a list of figures into entries: label, wrapped text, page", () => {
    const pages = [
      page(5, [
        line(5, 196, [[122.8, "4.1 Sensitivity ratio on the overlapping range of each inde-"]]),
        line(5, 214, [[150.3, "pendent matched comparison of the sectors" + dots(400)], pageNum("29")]),
        line(5, 232, [[122.8, "4.2 Constraint atlas for V1." + dots(290)], pageNum("31")]),
        // A wide label pushes its text right: only a word space after "4.10".
        line(5, 250, [[122.8, "4.10"], [147.7, "Constraint atlas for V9." + dots(300)], pageNum("39")]),
      ]),
    ];
    extractTocEntries(pages);
    expect(entries(pages).map(describeEntry)).toEqual([
      "4.1|Sensitivity ratio on the overlapping range of each inde- / pendent matched comparison of the sectors|29",
      "4.2|Constraint atlas for V1.|31",
      "4.10|Constraint atlas for V9.|39",
    ]);
    expect(pages[0].elements.every((e) => e.kind === "tocEntry")).toBe(true);
  });

  it("keeps a full stop set against the text, drops the leader dots", () => {
    const pages = [page(1, [line(1, 100, [[122.8, "2.2 Structural classification of the potentials." + dots(420)], pageNum("9")])])];
    extractTocEntries(pages);
    expect(entries(pages)[0].lines.map(lineText).join("")).toBe("Structural classification of the potentials.");
  });

  it("accepts an entry with few or no dots when the page number stands apart at the margin", () => {
    const pages = [
      page(7, [
        line(7, 100, [[122.8, "4.5 Matter versus antimatter counts per sector pair. ."], pageNum("47")]),
        line(7, 118, [[122.8, "4.6 Matter versus antimatter counts per potential."], pageNum("48")]),
      ]),
    ];
    extractTocEntries(pages);
    expect(entries(pages).map((e) => `${e.label}:${e.pageRef}`)).toEqual(["4.5:47", "4.6:48"]);
  });

  it("reads appendix and roman labels, unlabelled entries and roman page numbers", () => {
    const pages = [
      page(2, [
        line(2, 100, [[105, "Abstract" + dots(160)], pageNum("ii")]),
        line(2, 118, [[105, "A.1 Dirac algebra notation." + dots(280)], pageNum("63")]),
        line(2, 136, [[105, "IV. Results" + dots(180)], pageNum("41")]),
      ]),
    ];
    extractTocEntries(pages);
    expect(entries(pages).map(describeEntry)).toEqual(["|Abstract|ii", "A.1|Dirac algebra notation.|63", "IV.|Results|41"]);
  });

  it("understands other leader characters", () => {
    const pages = [page(3, [line(3, 100, [[122.8, "3.1 Method " + "· ".repeat(40)], pageNum("12")])])];
    extractTocEntries(pages);
    expect(entries(pages).map(describeEntry)).toEqual(["3.1|Method|12"]);
  });

  it("keeps nested contents levels as indents", () => {
    const pages = [
      page(3, [
        line(3, 100, [[105, "1 Introduction"], pageNum("1")]),
        line(3, 118, [[120, "1.1 Motivation" + dots(220)], pageNum("2")]),
        line(3, 136, [[141, "1.1.1 History" + dots(240)], pageNum("3")]),
      ]),
    ];
    extractTocEntries(pages);
    const es = entries(pages);
    expect(es.map((e) => e.label)).toEqual(["1", "1.1", "1.1.1"]);
    expect(es.map((e) => Math.round(e.indent))).toEqual([0, 15, 36]);
  });

  it("follows an entry onto the next page", () => {
    const pages = [
      page(7, [line(7, 780, [[122.8, "A.2 SME fermion-sector coefficients used in this thesis. LV: Lorentz-"]])]),
      page(8, [line(8, 83, [[150.3, "violating; every coefficient listed." + dots(330)], pageNum("64")])]),
    ];
    extractTocEntries(pages);
    expect(entries(pages).map(describeEntry)).toEqual(["A.2|SME fermion-sector coefficients used in this thesis. LV: Lorentz- / violating; every coefficient listed.|64"]);
    expect(pages[0].elements.map((e) => e.kind)).toEqual(["tocEntry"]);
    expect(pages[1].elements).toHaveLength(0);
  });

  it("leaves running text alone, including lines that end in a number", () => {
    const body = [
      line(9, 100, [[105, "The bound was improved by four orders of magnitude between 2011 and 2026"]]),
      line(9, 118, [[105, "Section 4.3 shows the results, which agree within a factor of 2"]]),
      line(9, 136, [[105, "The first stage shows that such regions exist . . . in four of the 13"]]),
    ];
    const pages = [page(9, body)];
    extractTocEntries(pages);
    expect(entries(pages)).toHaveLength(0);
    expect(pages[0].elements).toHaveLength(3);
  });

  it("assembles consecutive entries into one contents block", () => {
    const pages = [
      page(5, [
        line(5, 100, [[122.8, "4.1 First figure." + dots(240)], pageNum("29")]),
        line(5, 118, [[122.8, "4.2 Second figure." + dots(250)], pageNum("31")]),
      ]),
    ];
    const { blocks } = assemble(pages);
    expect(blocks.map((b) => b.kind)).toEqual(["toc"]);
    expect(blocks[0].kind === "toc" && blocks[0].entries.length).toBe(2);
  });
});
