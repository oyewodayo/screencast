import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { xml2js } from "xml-js";
import type { JSONContent } from "@tiptap/core";
import { latexToOmml } from "./docMathOmml";
import { docJsonToMarkdown } from "./docMarkdown";
import { buildDocxBytes } from "./docDocx";

const omml = (latex: string, display = false) => latexToOmml(latex, display) ?? "";

describe("latexToOmml", () => {
  it("builds fractions, scripts and radicals", () => {
    const xml = omml(String.raw`\frac{a}{\sqrt[3]{b}} + x_i^2 - \sqrt{y}`);
    expect(xml).toMatch(/^<m:oMath>.*<\/m:oMath>$/);
    expect(xml).toContain("<m:f><m:num>");
    expect(xml).toContain("<m:rad><m:deg>");
    expect(xml).toContain('<m:degHide m:val="1"/>');
    expect(xml).toContain("<m:sSubSup>");
  });

  it("nests the summand inside an n-ary operator with stacked limits", () => {
    const xml = omml(String.raw`\sum_{i=1}^{N} S_i`, true);
    expect(xml).toContain('<m:chr m:val="∑"/><m:limLoc m:val="undOvr"/>');
    expect(xml).toMatch(/<m:nary>.*<m:sub>.*i.*<\/m:sub><m:sup>.*N.*<\/m:sup><m:e><m:sSub>.*S.*<\/m:sSub><\/m:e><\/m:nary>/);
  });

  it("keeps integral limits beside the sign and hides a missing limit", () => {
    const xml = omml(String.raw`\int_0 f`);
    expect(xml).toContain('<m:limLoc m:val="subSup"/>');
    expect(xml).toContain('<m:supHide m:val="1"/>');
  });

  it("maps accents, bars, fences and matrices", () => {
    expect(omml(String.raw`\hat{S}`)).toContain('<m:acc><m:accPr><m:chr m:val="\u0302"/>');
    expect(omml(String.raw`\overline{AB}`)).toContain('<m:bar><m:barPr><m:pos m:val="top"/>');
    expect(omml(String.raw`\left( x \right]`)).toContain('<m:d><m:dPr><m:begChr m:val="("/><m:endChr m:val="]"/>');
    const matrix = omml(String.raw`\begin{pmatrix}1&2\\3&4\end{pmatrix}`);
    expect(matrix.match(/<m:mr>/g)).toHaveLength(2);
    expect(matrix.match(/<m:e>/g)!.length).toBeGreaterThanOrEqual(4);
  });

  it("sets upright style for function names and normal text for \\text", () => {
    expect(omml(String.raw`\sin x`)).toContain('<m:rPr><m:sty m:val="p"/></m:rPr><m:t xml:space="preserve">sin</m:t>');
    expect(omml(String.raw`\text{if } x`)).toContain("<m:rPr><m:nor/></m:rPr>");
    expect(omml(String.raw`\sin x`)).not.toContain("\u2061");
  });

  it("uses Unicode math letters for blackboard bold and calligraphic", () => {
    expect(omml(String.raw`\mathbb{R} \mathbb{A} \mathcal{H}`)).toContain("ℝ");
    expect(omml(String.raw`\mathbb{A}`)).toContain("𝔸");
    expect(omml(String.raw`\mathcal{H}`)).toContain("ℋ");
  });

  it("escapes XML and always produces well-formed output", () => {
    const xml = omml(String.raw`a < b \& c > d`);
    expect(xml).toContain("&lt;");
    expect(() => xml2js(xml)).not.toThrow();
    for (const src of [String.raw`\begin{aligned} a &= b \\ c &= d \end{aligned}`, String.raw`\binom{n}{k}`, String.raw`\lim_{x\to 0} \frac{\sin x}{x}`, String.raw`\vec{v} \cdot \nabla`]) {
      expect(() => xml2js(omml(src, true)), src).not.toThrow();
    }
  });

  it("returns null for LaTeX KaTeX can't parse", () => {
    expect(latexToOmml(String.raw`\frac{a`, false)).toBeNull();
  });
});

const doc = (content: JSONContent[]): JSONContent => ({ type: "doc", content });
const p = (...content: JSONContent[]): JSONContent => ({ type: "paragraph", content });
const eq = (latex: string, numbered = true): JSONContent => ({ type: "mathBlock", attrs: { latex, numbered } });

describe("equations in Markdown", () => {
  it("writes $...$ inline and numbers display equations in document order", () => {
    const md = docJsonToMarkdown(
      doc([
        p({ type: "text", text: "Energy " }, { type: "mathInline", attrs: { latex: "E=mc^2" } }),
        eq("a^2+b^2=c^2"),
        eq("x", false),
        { type: "blockquote", content: [eq("y")] },
      ])
    );
    expect(md).toContain("Energy $E=mc^2$");
    expect(md).toContain("$$\na^2+b^2=c^2 \\tag{1}\n$$");
    expect(md).toContain("$$\nx\n$$");
    expect(md).toContain("> y \\tag{2}");
  });
});

describe("equations in .docx", () => {
  it("embeds well-formed Word equations with a right-aligned number", async () => {
    const bytes = await buildDocxBytes(
      doc([p({ type: "text", text: "Let " }, { type: "mathInline", attrs: { latex: "x_i" } }), eq(String.raw`\sum_i x_i = 1`), eq("y", false), eq(String.raw`\frac{a`)]),
      "Test"
    );
    const zip = await JSZip.loadAsync(bytes);
    const xml = await zip.file("word/document.xml")!.async("string");
    expect(() => xml2js(xml)).not.toThrow();
    expect(xml).toContain("xmlns:m=");
    expect(xml.match(/<m:oMath>/g)).toHaveLength(3);
    expect(xml).toContain("<m:oMathPara><m:oMath>");
    expect(xml).toContain("(1)");
    expect(xml).toContain('w:val="right"');
    // The unparseable one falls back to its source text instead of vanishing.
    expect(xml).toContain("$$\\frac{a$$");
  });
});
