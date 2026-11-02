import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import * as Y from "yjs";
import { firstPageTop, letterheadMargins, readLetterhead, stationeryPrintCss, writeLetterhead, type DocLetterhead } from "./docLetterhead";
import { DEFAULT_WATERMARK } from "./docWatermark";
import { flattenTextBoxes } from "./docxTextBoxes";

const svg = (label: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="816" height="1056"><text>${label}</text></svg>`;
const lh: DocLetterhead = {
  name: "Acme",
  first: svg("first"),
  rest: svg("rest"),
  widthPx: 816,
  heightPx: 1056,
  firstTopIn: 2.3,
  restTopIn: 1,
  bottomIn: 1.2,
  leftIn: 0.9,
  rightIn: 0.9,
  previousMargins: null,
  brandColor: "#1f3a5f",
};
const sheet = { widthIn: 8.5, heightIn: 11, top: 1, left: 0.9 };

describe("letterhead", () => {
  it("round-trips through the Y.Doc and rejects junk", () => {
    const ydoc = new Y.Doc();
    writeLetterhead(ydoc, lh);
    expect(readLetterhead(ydoc)).toEqual(lh);
    writeLetterhead(ydoc, null);
    expect(readLetterhead(ydoc)).toBeNull();
  });

  it("asks for its text-safe margins, with page 1's deeper top kept apart", () => {
    const m = letterheadMargins(lh, { top: 1, right: 1, bottom: 1, left: 1 });
    expect(m).toEqual({ top: 1, bottom: 1.2, left: 0.9, right: 0.9 });
    expect(firstPageTop(lh, m)).toBe(2.3);
    expect(firstPageTop({ ...lh, firstTopIn: 1 }, m)).toBeNull();
  });

  it("prints page 1 and later pages on their own sheets, placed over the whole sheet", () => {
    const css = stationeryPrintCss(DEFAULT_WATERMARK, "", lh, { first: "data:first", rest: "data:rest" }, 2.3, sheet);
    expect(css).toContain('@page { background-image: url("data:rest"); background-size: 8.5in 11in; background-position: -0.9in -1in;');
    expect(css).toContain('@page :first { background-image: url("data:first"); background-size: 8.5in 11in; background-position: -0.9in -2.3in;');
    expect(css).toContain("margin-top: 2.3in;");
  });
});

describe("text boxes in a .docx body", () => {
  it("lifts side-by-side text boxes into one borderless table row, left to right", async () => {
    const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"';
    const box = (x: number, text: string) =>
      `<w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wp:anchor><wp:positionH relativeFrom="column"><wp:posOffset>${x}</wp:posOffset></wp:positionH><wp:positionV relativeFrom="paragraph"><wp:posOffset>100</wp:posOffset></wp:positionV><wp:extent cx="2000000" cy="800000"/><wps:wsp><wps:txbx><w:txbxContent><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:txbxContent></wps:txbx></wps:wsp></wp:anchor></w:drawing></mc:Choice><mc:Fallback/></mc:AlternateContent></w:r>`;
    const zip = new JSZip();
    zip.file("word/document.xml", `<?xml version="1.0"?><w:document ${W}><w:body><w:p><w:r><w:t>Signed:</w:t></w:r>${box(3000000, "Secretary")}${box(0, "President")}</w:p><w:p><w:r><w:t>After</w:t></w:r></w:p></w:body></w:document>`);
    const out = await JSZip.loadAsync(await flattenTextBoxes(await zip.generateAsync({ type: "uint8array" })));
    const xml = await out.file("word/document.xml")!.async("string");
    expect(xml).not.toContain("txbxContent");
    const order = ["Signed:", "<w:tbl", "President", "Secretary", "After"].map((s) => xml.indexOf(s));
    expect(order.every((v, i) => v >= 0 && (i === 0 || v > order[i - 1]))).toBe(true);
    expect(xml).toContain('w:val="nil"');
  });
});
