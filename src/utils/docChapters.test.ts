import { describe, expect, it } from "vitest";
import type { JSONContent } from "@tiptap/core";
import { chapterLabel, readNumbering } from "./docNumbering";
import { computeStructureFromJson, crossRefText } from "./docStructure";
import { staticBibliography } from "./docBibliography";
import { docJsonToMarkdown } from "./docMarkdown";

const text = (t: string): JSONContent => ({ type: "text", text: t });
const heading = (level: number, ...parts: JSONContent[]): JSONContent => ({ type: "heading", attrs: { level }, content: parts });
const caption = (kind: "figure" | "table", id: string): JSONContent => ({ type: "caption", attrs: { kind, id }, content: [text("Caption.")] });
const equation = (id: string): JSONContent => ({ type: "mathBlock", attrs: { latex: "x=1", numbered: true, id } });

describe("chapter labels", () => {
  it("reads the number a chapter heading gives itself", () => {
    expect(chapterLabel("CHAPTER 2 LITERATURE REVIEW")).toBe("2");
    expect(chapterLabel("Chapter Four: Results")).toBe("4");
    expect(chapterLabel("Part II")).toBe("2");
    expect(chapterLabel("APPENDIX A NOTATION")).toBe("A");
    expect(chapterLabel("Appendix B")).toBe("B");
    expect(chapterLabel("3 Methods")).toBe("3");
    expect(chapterLabel("3. Methods")).toBe("3");
    expect(chapterLabel("REFERENCES")).toBeNull();
    expect(chapterLabel("Acknowledgements")).toBeNull();
    expect(chapterLabel("3.1 Data")).toBeNull();
  });
});

describe("numbering within chapters", () => {
  const thesis: JSONContent = {
    type: "doc",
    content: [
      heading(2, text("ABSTRACT")),
      // A heading set on two lines: "CHAPTER 1" / "INTRODUCTION".
      heading(2, text("CHAPTER 1"), { type: "hardBreak" }, text("INTRODUCTION")),
      equation("e11"),
      caption("figure", "f11"),
      heading(2, text("CHAPTER 2"), { type: "hardBreak" }, text("REVIEW")),
      equation("e21"),
      equation("e22"),
      caption("table", "t21"),
      caption("figure", "f21"),
      heading(2, text("REFERENCES")),
      heading(2, text("APPENDIX A"), { type: "hardBreak" }, text("NOTATION")),
      caption("table", "tA1"),
      equation("eA1"),
    ],
  };
  const bib = { ...staticBibliography([]), numbering: () => readNumbering({ chapterLevel: 2 }) };

  it("numbers captions and equations within each chapter, appendices by letter", () => {
    const s = computeStructureFromJson(thesis, bib);
    expect(s.equationLabels).toEqual(["1.1", "2.1", "2.2", "A.1"]);
    expect(s.captionLabels.figure).toEqual(["Figure 1.1", "Figure 2.1"]);
    expect(s.captionLabels.table).toEqual(["Table 2.1", "Table A.1"]);
    expect(s.targets.get("e22")?.label).toBe("Eq. (2.2)");
    expect(crossRefText(s.targets.get("e22")!, "bare")).toBe("2.2");
    expect(crossRefText(s.targets.get("t21")!, "number")).toBe("2.1");
  });

  it("counts chapters when no heading numbers itself", () => {
    const plain: JSONContent = { type: "doc", content: [heading(1, text("Introduction")), equation("a"), heading(1, text("Results")), equation("b"), equation("c")] };
    const s = computeStructureFromJson(plain, { ...staticBibliography([]), numbering: () => readNumbering({ chapterLevel: 1 }) });
    expect(s.equationLabels).toEqual(["1.1", "2.1", "2.2"]);
  });

  it("numbers straight through when chapter numbering is off", () => {
    const s = computeStructureFromJson(thesis, staticBibliography([]));
    expect(s.equationLabels).toEqual(["1", "2", "3", "4"]);
  });

  it("exports the same numbers to Markdown", () => {
    const s = computeStructureFromJson(thesis, bib);
    const md = docJsonToMarkdown(thesis, [], s);
    expect(md).toContain("\\tag{2.2}");
    expect(md).toContain("**Table A.1.**");
  });
});
